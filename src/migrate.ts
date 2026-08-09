import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, getMeta, setMeta } from "./db";
import { hashKey, tinyId } from "./ids";

// Schema versioning is driven by `PRAGMA user_version`. Target is 5 in this release.
//
// v1 (the multi-user migration) handles two entry states:
//   - v0-with-data: the pre-multi-user prod shape (bundles(slug PK), versions(slug,
//     version), zips at DATA_DIR/zips/<slug>/<version>.zip).
//   - fresh/empty db: new deployments create the v1 schema and bootstrap a root user.
//
// The v1 migration is idempotent across a crash mid-run: the bootstrap workspace id
// is persisted first (so a partial re-run reuses it), zip dirs move before the
// version bump, and all db mutations commit in one transaction that ends with the
// bump — a crash before that leaves user_version at 0 and re-runs cleanly.
//
// v2 adds the images table (single-file image uploads). Purely additive.
//
// v3 adds the Overseer review tables (reviews, versions, attachments, annotations,
// read state, freshness, and the ref snippet cache). Purely additive: no existing
// table is touched, so a v1 or v2 database walks straight up to it.
//
// v4 adds the shares table: one revocable read-only link to one asset. Purely
// additive too, on the same terms.
//
// v5 adds the GitHub App tables and backfills `review_prs` from every review's
// latest version. Purely additive as DDL, and the one migration in this repo that
// reads an application-level document rather than doing pure DDL — see backfillReviewPrs.
//
// v6 drops the freshness table — and it does NOT run in this release. This is the
// release where v5 lands and the write stops; the drop is the release after. Splitting
// them is what keeps the graceful-shutdown redeploy overlap from serving
// `no such table: review_freshness` out of the old container, which calls
// listFreshness() on every review render.
//
// READ THIS BEFORE DEPLOYING: the split does NOT make this release rollback-safe, and an
// earlier version of this comment claimed it did. The previous image's migrate() throws on
// any user_version above 4, so once a database has been walked to 5 the old image refuses
// to start on it. Going back means restoring the database, not redeploying the image.
// Splitting v6 out fixes the overlap window and buys nothing for rollback; saying
// otherwise in the one file you open when a release has gone wrong is the worst possible
// place to be wrong.
//
// SEER_DROP_FRESHNESS=1 opts a database in early, so the drop can be exercised and so the
// next release is a one-line change (delete the gate) rather than a new migration. A
// database already at 6 is accepted either way: having opted in is not a reason to be
// refused at the next boot.

const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    is_legacy INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_by TEXT,
    accepted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS bundles (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    latest_version INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug)
  );
  CREATE TABLE IF NOT EXISTS versions (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug, version)
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_workspace ON invites (workspace_id);
`;

function userVersion(): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

function tableExists(name: string): boolean {
  return !!db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
}

function hasColumn(table: string, column: string): boolean {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

/** Root email: first ALLOWED_EMAILS entry; dev fallback; else fail loudly. */
function resolveRootEmail(): string {
  const first = config.allowedEmails[0];
  if (first) return first.toLowerCase();
  if (config.authDisabled) return "dev@localhost";
  throw new Error(
    "Cannot bootstrap Seer: set ALLOWED_EMAILS to at least one address (the root " +
      "workspace owner), or run with AUTH_DISABLED=true for local dev.",
  );
}

/** Move DATA_DIR/zips/<slug>/ -> DATA_DIR/zips/<ws>/<slug>/. Idempotent per dir. */
function moveLegacyZips(wsId: string): void {
  const zipsDir = join(config.dataDir, "zips");
  if (!existsSync(zipsDir)) return;
  const targetRoot = join(zipsDir, wsId);
  for (const name of readdirSync(zipsDir)) {
    if (name === wsId) continue; // already-migrated tree from a partial prior run
    const source = join(zipsDir, name);
    if (!statSync(source).isDirectory()) continue;
    const target = join(targetRoot, name);
    if (existsSync(target)) continue; // already moved; leave it be
    mkdirSync(targetRoot, { recursive: true });
    renameSync(source, target);
  }
}

const V2_IMAGES = `
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_images_workspace ON images (workspace_id);
`;

// Overseer reviews. A review is workspace-scoped and versioned exactly like a
// bundle: `reviews` holds the head pointer, `review_versions` holds one immutable
// published document per version, stored as the resolved JSON the renderer reads.
// Annotations belong to the review rather than to a version and record the version
// they were filed against, so a question asked on pass one is still open on pass
// three. `ref_snippets` is a pure cache keyed by (repo, sha, path): SHA-pinned, so
// an entry is never stale and never needs invalidating. `review_freshness` keys on
// (repo, pr_number) rather than the number alone: today's write path allows one repo
// per review, but two pull requests numbered alike in different repos must never
// collide if that constraint is ever lifted. Nothing writes it as of v5 and v6 drops it,
// but it is still created here — a fresh database in this release must have the shape
// the previous image reads, because that image is still serving during a redeploy.
const V3_REVIEWS = `
  CREATE TABLE IF NOT EXISTS reviews (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug)
  );
  CREATE TABLE IF NOT EXISTS review_versions (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    doc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug, version)
  );
  CREATE TABLE IF NOT EXISTS review_attachments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    alt TEXT NOT NULL,
    caption TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_annotations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('statement','note','group','file','hunk','summary')),
    target_id TEXT NOT NULL,
    quote TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
    answer TEXT,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_reads (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug, user_id)
  );
  CREATE TABLE IF NOT EXISTS review_freshness (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    observed_head_sha TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, slug, repo, pr_number)
  );
  -- Process-global cache of SHA-pinned source files. The key is deliberately
  -- (repo, sha, path) with no workspace column: the same key always names the same
  -- bytes. That makes it a shared cache of private source, so the resolver may only
  -- read a key whose repository that same derivation has already fetched from, using
  -- the server's GitHub token: a request naming any other repository pays a real
  -- fetch first, and a request naming one it may read still supplies its own sha and
  -- path. The gate is per-derivation, not per-caller: there is one token for the
  -- process. The sha must be a full sha, or the key would name mutable bytes and the
  -- entry really could go stale. There is no size bound
  -- or eviction here either; both belong with the resolver that fills it.
  CREATE TABLE IF NOT EXISTS ref_snippets (
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (repo, sha, path)
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_workspace ON reviews (workspace_id);
  CREATE INDEX IF NOT EXISTS idx_review_attachments_review ON review_attachments (workspace_id, slug);
  CREATE INDEX IF NOT EXISTS idx_review_annotations_review ON review_annotations (workspace_id, slug);
`;

// One share is one revocable read-only link to one asset. The token is the row's
// identity and its secret at once, exactly as an API key is: it is shown once at mint
// and only its SHA-256 is stored, so a database copy is not a set of working links.
// That is also why the lookup runs on token_hash — UNIQUE builds the index this path
// reads by, so there is no second index on the same column.
//
// `kind` is a closed list rather than free text, because a share resolver has to
// dispatch on it: a row naming a kind no route serves is a link that cannot open.
// `target` is the asset's slug inside `workspace_id`; the two together name the asset,
// which is what keeps a token minted in one workspace from reaching into another.
// Revocation sets `revoked_at` rather than deleting the row, so a link that was handed
// out and taken back stays auditable.
const V4_SHARES = `
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review','bundle')),
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_shares_workspace ON shares (workspace_id);
`;

// The GitHub App. An installation is GitHub's, a workspace is Seer's, and this table is
// the only place the two are bound together.
//
// `workspace_id` is NULLABLE because a row can exist before anybody claims it:
// `installation.created` records an installation the moment GitHub says it exists, and
// nobody owns it until a person proves they can reach it. Three consequences run
// through the rest of the code: every workspace-keyed query filters
// `workspace_id IS NOT NULL`, routing refuses an unclaimed installation rather than
// treating it as a match, and the unique index below still reserves the id — which is
// what stops a claim race from producing two rows for one installation.
//
// That index is PARTIAL, on purpose. A column-level UNIQUE plus a soft `removed_at`
// would strand an installation id forever: disconnecting it would mean nobody could
// ever reconnect it, and no user action recovers that because only reinstalling on
// GitHub mints a new id. The claim and the audit trail are different things, so the
// audit row survives a disconnect and the id is released with it.
//
// `github_pr_status` carries facts and no words: "merged | closed | draft | open" and
// "current | behind | unknown" are both derived from this row at render. It keys on
// GitHub's numeric repository id rather than "owner/name", because GitHub compares
// those case-insensitively and a rename changes them outright. `repo_id` is nullable
// only for the transitional rows a backfill wrote, which have no numeric id anywhere
// to be found; they are healed on first observation. `installation_id` is here so
// `installation.deleted` can find its own rows after the installation is already gone.
//
// `review_prs` is the filter the webhook upsert runs through: an installation covering
// a busy org delivers an event for every pull request anyone opens anywhere, and
// writing a row for each would grow `github_pr_status` without bound for pull requests
// no page renders.
//
// `github_deliveries` is the replay guard: the delivery id and every effect of that
// delivery commit in one transaction, so a failed apply is retried rather than
// classified as a duplicate.
//
// The claim row is the proof crossing a request boundary. The callback proves which
// installations a person can actually reach and records their ids here; the attach POST
// consumes that record. It is in SQLite rather than in memory because old and new
// containers overlap by design during a redeploy, so the two requests can land on
// different processes. Both bearer handles are hashed exactly as an API key or a share
// token is — `hashKey` and nothing else — and the row burns twice: `consumed_at` when
// the callback spends the nonce, `attached_at` when the POST spends the attach handle.
const V5_GITHUB_APP = `
  CREATE TABLE IF NOT EXISTS github_installations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    installation_id INTEGER NOT NULL,
    account_login TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    account_type TEXT NOT NULL,
    repository_selection TEXT NOT NULL,
    connected_by TEXT,
    connected_at INTEGER,
    created_at INTEGER NOT NULL,
    suspended_at INTEGER,
    last_delivery_at INTEGER,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_live
    ON github_installations (installation_id) WHERE removed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_github_installations_workspace
    ON github_installations (workspace_id);

  CREATE TABLE IF NOT EXISTS github_pr_status (
    workspace_id TEXT NOT NULL,
    repo_id INTEGER,
    pr_number INTEGER NOT NULL,
    installation_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    state TEXT NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    head_sha TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, repo_id, pr_number)
  );
  -- SQLite lets a PRIMARY KEY column hold NULL, and NULLs never compare equal, so the
  -- primary key above does not constrain a row whose repo_id is still null. These two
  -- indexes are what actually keep the transitional rows unique, per table.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_github_pr_status_unresolved
    ON github_pr_status (workspace_id, lower(repo), pr_number) WHERE repo_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_github_pr_status_installation
    ON github_pr_status (installation_id);

  CREATE TABLE IF NOT EXISTS review_prs (
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo_id INTEGER,
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    PRIMARY KEY (workspace_id, slug, repo_id, pr_number)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_prs_unresolved
    ON review_prs (workspace_id, slug, lower(repo), pr_number) WHERE repo_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_review_prs_lookup
    ON review_prs (workspace_id, pr_number);

  CREATE TABLE IF NOT EXISTS github_deliveries (
    delivery_id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS github_app_claims (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nonce_hash TEXT NOT NULL UNIQUE,
    attach_hash TEXT UNIQUE,
    proven_ids TEXT,
    github_login TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    attached_at INTEGER
  );
`;

/** One pull request as a v4 document names it. Deliberately not `Pr` from
 *  overseer/types: this parser reads the shape that is *stored*, and keeps reading it
 *  forever. Importing the live type would make a migration over old rows change
 *  meaning the day someone edits the document model. */
interface StoredPrPointer {
  repo: unknown;
  number: unknown;
}

/**
 * Backfill `review_prs` from each review's `latest_version` only.
 *
 * Only the latest version, because backfilling every stored version would index pull
 * requests that later versions dropped: webhooks would then push to reviews that no
 * longer name them. The consequence is stated rather than hidden — a reader on an old
 * pinned version may see a pull request as unchecked, which is honest.
 *
 * There is no `repo_id` to write. The v4 document has no numeric repository id
 * anywhere, and a migration cannot invent one: reaching the network from a migration is
 * unprecedented here and impossible for a repository no installation covers any more,
 * while a sentinel would make every backfilled row unjoinable forever *and* look
 * healthy. So the rows go in with a null id and the join falls back to the name until
 * an observation heals them.
 *
 * A malformed document aborts the whole transaction naming the exact row. Skipping
 * would leave an incomplete security index that nothing ever reports, which is worse
 * than a boot failure that says which document to look at.
 */
function backfillReviewPrs(): number {
  const reviews = db
    .query<{ workspace_id: string; slug: string; latest_version: number }, []>(
      "SELECT workspace_id, slug, latest_version FROM reviews",
    )
    .all();

  let written = 0;
  for (const review of reviews) {
    const where = `(${review.workspace_id}, ${review.slug}, ${review.latest_version})`;
    const row = db
      .query<{ doc: string }, [string, string, number]>(
        "SELECT doc FROM review_versions WHERE workspace_id = ? AND slug = ? AND version = ?",
      )
      .get(review.workspace_id, review.slug, review.latest_version);
    if (!row) {
      throw new Error(
        `Cannot backfill review_prs: review ${where} has no version row behind its latest_version.`,
      );
    }
    let doc: { prs?: unknown };
    try {
      doc = JSON.parse(row.doc) as { prs?: unknown };
    } catch (err) {
      throw new Error(`Cannot backfill review_prs: document ${where} is not JSON (${String(err)}).`);
    }
    if (!Array.isArray(doc.prs)) {
      throw new Error(`Cannot backfill review_prs: document ${where} has no iterable prs array.`);
    }
    for (const pr of doc.prs as StoredPrPointer[]) {
      const repo = pr?.repo;
      const number = pr?.number;
      if (typeof repo !== "string" || repo === "" || !Number.isInteger(number)) {
        throw new Error(
          `Cannot backfill review_prs: document ${where} names a pull request with no readable ` +
            `repo/number pair (repo=${JSON.stringify(repo)}, number=${JSON.stringify(number)}).`,
        );
      }
      db.run(
        "INSERT OR IGNORE INTO review_prs (workspace_id, slug, repo_id, pr_number, repo) " +
          "VALUES (?, ?, NULL, ?, ?)",
        [review.workspace_id, review.slug, number as number, repo],
      );
      written++;
    }
  }
  return written;
}

export function migrate(): void {
  const uv = userVersion();
  if (uv > 6) {
    throw new Error(`Unexpected database user_version ${uv}; expected 0, 1, 2, 3, 4, 5, or 6`);
  }
  if (uv === 0) migrateToV1();
  if (userVersion() < 2) migrateToV2();
  if (userVersion() < 3) migrateToV3();
  if (userVersion() < 4) migrateToV4();
  if (userVersion() < 5) migrateToV5();
  if (userVersion() < 6 && process.env.SEER_DROP_FRESHNESS === "1") migrateToV6();
  ensureAdditiveColumns();
}

/**
 * Columns added to an existing schema version, applied idempotently.
 *
 * `last_delivery_at` is the delivery-health column: with polling deleted, an
 * installation that has gone quiet is the failure mode this design chose, and settings
 * cannot report it from `github_deliveries` — that table is a replay guard swept on a
 * week's retention, so a fortnight of silence would read there as no silence at all.
 *
 * It does not get a version bump: the column earns none on its own terms. it is nullable, nothing reads it
 * that is not new, and an old container writing rows during a redeploy overlap simply
 * leaves it null — which reads as "no delivery recorded yet", which is true.
 */
function ensureAdditiveColumns(): void {
  if (tableExists("github_installations") && !hasColumn("github_installations", "last_delivery_at")) {
    db.run("ALTER TABLE github_installations ADD COLUMN last_delivery_at INTEGER");
  }
}

// The one destructive migration in the repo, and it only removes a second recording of
// a fact `review_prs` already holds. Nothing has read or written the table since v5, so
// there is nothing to carry forward; IF EXISTS in case a future release stops creating
// it in V3_REVIEWS. Gated on SEER_DROP_FRESHNESS in this release — see the header.
function migrateToV6(): void {
  db.transaction(() => {
    db.run("DROP TABLE IF EXISTS review_freshness");
    db.run("PRAGMA user_version = 6");
  })();
  console.log("[seer] migrated to schema v6 (dropped the freshness table).");
}

function migrateToV5(): void {
  let written = 0;
  db.transaction(() => {
    db.exec(V5_GITHUB_APP);
    written = backfillReviewPrs();
    db.run("PRAGMA user_version = 5");
  })();
  console.log(`[seer] migrated to schema v5 (github app); backfilled ${written} review_prs rows.`);
}

function migrateToV4(): void {
  db.transaction(() => {
    db.exec(V4_SHARES);
    db.run("PRAGMA user_version = 4");
  })();
  console.log("[seer] migrated to schema v4 (shares).");
}

function migrateToV3(): void {
  db.transaction(() => {
    db.exec(V3_REVIEWS);
    db.run("PRAGMA user_version = 3");
  })();
  console.log("[seer] migrated to schema v3 (overseer reviews).");
}

function migrateToV2(): void {
  db.transaction(() => {
    db.exec(V2_IMAGES);
    db.run("PRAGMA user_version = 2");
  })();
  console.log("[seer] migrated to schema v2 (images).");
}

function migrateToV1(): void {

  const email = resolveRootEmail();
  const localPart = email.split("@")[0] || email;
  const now = Date.now();

  // Detect the v0-with-data shape before we touch anything.
  const legacyBundles = tableExists("bundles") && !hasColumn("bundles", "workspace_id");

  // Persist the bootstrap workspace id first so a crash-then-rerun reuses it (and so
  // moveLegacyZips and the db inserts agree on the target).
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  let wsId = getMeta("legacy_workspace_id");
  if (!wsId) {
    wsId = tinyId("ws");
    setMeta("legacy_workspace_id", wsId);
  }

  // File moves happen before the version bump. Any failure aborts loudly here.
  moveLegacyZips(wsId);

  const envKey = config.apiToken; // API_KEY / API_TOKEN, optional

  const run = db.transaction(() => {
    // Rename the v0 tables out of the way before creating the v1 shape.
    if (legacyBundles) {
      db.run("ALTER TABLE bundles RENAME TO bundles_v0");
      if (tableExists("versions") && !hasColumn("versions", "workspace_id")) {
        db.run("ALTER TABLE versions RENAME TO versions_v0");
      }
    }

    db.exec(V1_SCHEMA);

    if (legacyBundles) {
      db.run(
        "INSERT INTO bundles (workspace_id, slug, created_at, latest_version) " +
          "SELECT ?, slug, created_at, latest_version FROM bundles_v0",
        [wsId!],
      );
      if (tableExists("versions_v0")) {
        db.run(
          "INSERT INTO versions (workspace_id, slug, version, created_at, bytes, file_count) " +
            "SELECT ?, slug, version, created_at, bytes, file_count FROM versions_v0",
          [wsId!],
        );
        db.run("DROP TABLE versions_v0");
      }
      db.run("DROP TABLE bundles_v0");
    }

    // Root user, workspace, membership. INSERT OR IGNORE keeps a partial re-run safe.
    const userId = tinyId("usr");
    db.run("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)", [
      userId,
      email,
      now,
    ]);
    const rootUserId = db
      .query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?")
      .get(email)!.id;

    db.run(
      "INSERT OR IGNORE INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)",
      [wsId!, localPart, now],
    );
    db.run(
      "INSERT OR IGNORE INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)",
      [wsId!, rootUserId, now],
    );

    // Import the env API key as a legacy key row — once, and never again (this runs
    // only at user_version 0). A rolled/revoked legacy key must stay dead.
    if (envKey) {
      db.run(
        "INSERT OR IGNORE INTO api_keys " +
          "(id, user_id, workspace_id, name, token_hash, token_hint, is_legacy, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        [tinyId("key"), rootUserId, wsId!, "imported from env", hashKey(envKey), "(pre-workspace key)", now],
      );
    } else {
      console.warn(
        "[seer] no API_KEY/API_TOKEN in env to import — uploads will need a key minted at /settings.",
      );
    }

    setMeta("legacy_workspace_id", wsId!);
    db.run("PRAGMA user_version = 1");
  });
  run();

  console.log(`[seer] migrated to schema v1; root workspace ${wsId} (${email}).`);
}
