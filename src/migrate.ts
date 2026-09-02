import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, getMeta, setMeta } from "./db";
import { hashKey, tinyId } from "./ids";

// Schema versioning is driven by `PRAGMA user_version`. Target is 20 in this release.
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
// v6 adds github_user_credentials: a GitHub credential belonging to a person rather than
// to a workspace, and the first table here whose secret is encrypted rather than hashed,
// because it is the first one Seer has to read back. Purely additive.
//
// v8 adds the projects tables (projects, the bundle/review membership joins, and the
// status-transition events). Purely additive. See docs/projects/data-model.md.
//
// v9 adds `kind` to bundles: 'bundle' | 'plan', set at first upload and immutable
// after. ADD COLUMN with a constant default, so every pre-v9 row reads 'bundle',
// which is true of every bundle that existed before plans did.
//
// v10 adds the task tables (project_tasks and project_task_prs). Purely additive.
//
// v11 adds project_notes: the append-only record of what the agent was thinking while
// it worked. Nothing in src updates or deletes a row here, on purpose — a journal you
// can edit afterwards is testimony you can revise. Purely additive.
//
// v12 adds completed staged source captures. The workflow row, immutable file inventory,
// canonical changes, explicit incomplete items, workspace-scoped retained objects, and
// idempotency records are additive. Pending stage versions do not exist in that slice.
//
// v13 adds builder packets, immutable stage identity and version rows, and Project stage
// membership. Existing captures stay readable; captures without a packet cannot publish.
//
// v14 adds per-member read state for canonical changes in an immutable stage version.
// It never changes the capture or StageDoc.
//
// v15 adds the promoted review: a lineage, its immutable source revisions, the immutable
// accounts a witness publishes over a revision, the witness request that is waiting to
// become one, per-revision read state, and Project membership. Purely additive — a
// StageDoc V1 row, a legacy ReviewDoc row, and every read and join beside them are
// untouched, and a capture that already backs a stage version may back a revision too.
//
// v16 adds the pull request a lineage reviews: the one normalized relation, the immutable
// observations of that pull request, the source tuple a revision was captured from, the
// capture job workflow, client idempotency, and witness claim leases. Purely additive —
// every v15 table, constraint and stored document is untouched, and a lineage that never
// names a pull request keeps working with all six tables empty.
//
// v17 adds what a MOVING pull request needs: the provenance beside a carried read, and the
// record that appending a revision superseded an earlier revision's unpublished witness
// request. Purely additive — no v16 table, constraint, job row, observation or stored
// document is touched, and the existing witness-request CHECK is deliberately not rebuilt,
// because `superseded` is derived from a join rather than stored as a fourth state.
//
// v19 adds the stack of promoted reviews: the stack, its immutable ordered manifests, one
// account per manifest, the witness workflow beside it, the provider membership
// observations a delivery records, the installation-owned refresh job, client idempotency,
// and Project membership. Purely additive — no lineage, revision, account, read or
// observation row is touched, and a workspace with no stacks keeps every table empty.
//
// v20 rebuilds the closed shares.kind check to admit exact promoted-review and stack
// document capabilities, then adds their immutable copied file, item, and attachment
// inventories. Every old share column is copied unchanged in the same transaction.
//
// The freshness table's drop is NOT a version. It used to be a gated v6, and v6 is now
// this table, which is not a renumbering for tidiness: a conditional step inside a
// monotonic ladder is unreachable the moment anything is added after it. An ordinary
// boot skipped the gate, landed on the next number, and left the drop permanently
// impossible — its condition testing a version already passed. It lives in `meta` now.
// See dropFreshnessIfOptedIn, which explains why time and shape are different facts.
//
// READ THIS BEFORE DEPLOYING: none of this makes a release rollback-safe, and an earlier
// version of this comment claimed the split did. The previous image's migrate() refuses
// any user_version it does not know, so once a database has been walked forward the old
// image will not start on it. Going back means restoring the database, not redeploying
// the image. Saying otherwise in the one file you open when a release has gone wrong is
// the worst available place to be wrong.

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
const V6_GITHUB_USER_CREDENTIALS = `
  CREATE TABLE IF NOT EXISTS github_user_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('oauth','pat')),
    label TEXT NOT NULL,
    secret TEXT NOT NULL,
    account_login TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_github_user_credentials_live
    ON github_user_credentials (user_id) WHERE revoked_at IS NULL;
`;

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

export function assertDatabaseVersionSupported(maxVersion: number): void {
  const uv = userVersion();
  if (uv > maxVersion) {
    throw new Error(`Unexpected database user_version ${uv}; expected a version from 0 through ${maxVersion}`);
  }
}

export function migrate(): void {
  assertDatabaseVersionSupported(20);
  const uv = userVersion();
  if (uv === 0) migrateToV1();
  if (userVersion() < 2) migrateToV2();
  if (userVersion() < 3) migrateToV3();
  if (userVersion() < 4) migrateToV4();
  if (userVersion() < 5) migrateToV5();
  if (userVersion() < 6) migrateToV6();
  if (userVersion() < 7) migrateToV7();
  if (userVersion() < 8) migrateToV8();
  if (userVersion() < 9) migrateToV9();
  if (userVersion() < 10) migrateToV10();
  if (userVersion() < 11) migrateToV11();
  if (userVersion() < 12) migrateToV12();
  if (userVersion() < 13) migrateToV13();
  if (userVersion() < 14) migrateToV14();
  if (userVersion() < 15) migrateToV15();
  if (userVersion() < 16) migrateToV16();
  if (userVersion() < 17) migrateToV17();
  if (userVersion() < 18) migrateToV18();
  if (userVersion() < 19) migrateToV19();
  if (userVersion() < 20) migrateToV20();
  // THE LADDER IS CONTIGUOUS AND UNGATED, AND MUST STAY THAT WAY. A conditional step in
  // the middle of it is a trap, and this file fell into it once: the freshness drop was
  // a gated v6, the very next migration added below it was an ungated v7, and an
  // ordinary boot walked a v5 database straight past the gate to 7. After that the
  // drop could never run again, because its own condition tested a version already
  // exceeded, and no amount of setting the variable or deleting the gate would bring it
  // back. A version says what shape a database has reached; an opt-in says what its
  // operator has chosen. Those are different facts and only the first one belongs here.
  dropFreshnessIfOptedIn();
  ensureUserCredentialTables();
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
 *
 * `dead_at` is the same kind of column for a user credential: GitHub answered 401 through
 * it, so it is revoked or expired at the far end and retrying it is retrying a corpse. It
 * is distinct from `revoked_at`, which records the person deciding, and settings needs
 * both — one is the reason it is gone, the other is what to do about it.
 *
 * It earns no version bump on the same terms: nullable, read only by code that is new,
 * and left null by an old container during a redeploy overlap — which reads as "GitHub
 * has not refused this yet", which is true.
 */
function ensureAdditiveColumns(): void {
  if (tableExists("github_installations") && !hasColumn("github_installations", "last_delivery_at")) {
    db.run("ALTER TABLE github_installations ADD COLUMN last_delivery_at INTEGER");
  }
  if (tableExists("github_user_credentials") && !hasColumn("github_user_credentials", "dead_at")) {
    db.run("ALTER TABLE github_user_credentials ADD COLUMN dead_at INTEGER");
  }
}

const V7_GITHUB_USER_OAUTH_CLAIMS = `
  CREATE TABLE IF NOT EXISTS github_user_oauth_claims (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nonce_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
`;

function migrateToV7(): void {
  db.transaction(() => {
    db.exec(V7_GITHUB_USER_OAUTH_CLAIMS);
    db.run("PRAGMA user_version = 7");
  })();
  console.log("[seer] migrated to schema v7 (GitHub user OAuth claims).");
}

// Projects. A project is workspace-scoped and slugged exactly like a bundle or a
// review, and groups both: the membership joins carry which bundles and reviews a
// project holds, many-to-many, keyed by the same (workspace_id, slug) pair those
// tables key themselves by. `parent_id` nests projects one level deep — the depth is
// enforced on write, not here, so lifting it is an application change.
//
// `project_events` is the derived transition trail: a status change writes a row in
// the same transaction as the change, so "when did this move" is answerable without
// anyone journaling it. `task_id` is nullable and unused until the tasks slice lands;
// it is in the shape now so task transitions join the same trail rather than growing
// a second table that has to be read in step with this one.
const V8_PROJECTS = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_ws_slug ON projects (workspace_id, slug);
  CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects (parent_id);

  CREATE TABLE IF NOT EXISTS project_bundles (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_project_bundles_bundle ON project_bundles (workspace_id, slug);

  CREATE TABLE IF NOT EXISTS project_reviews (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_project_reviews_review ON project_reviews (workspace_id, slug);

  CREATE TABLE IF NOT EXISTS project_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('status')),
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    actor_user_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events (project_id);
`;

function migrateToV8(): void {
  db.transaction(() => {
    db.exec(V8_PROJECTS);
    db.run("PRAGMA user_version = 8");
  })();
  console.log("[seer] migrated to schema v8 (projects).");
}

function migrateToV9(): void {
  db.transaction(() => {
    // SQLite accepts a CHECK on ADD COLUMN; existing rows satisfy it through the
    // default. The enum is also enforced in code, but the row should refuse a bad
    // kind even from a path that forgot to. Guarded on the column because ADD COLUMN
    // has no IF NOT EXISTS and the repair paths re-enter this ladder on databases
    // whose stamp lags their shape.
    if (!hasColumn("bundles", "kind")) {
      db.run(
        "ALTER TABLE bundles ADD COLUMN kind TEXT NOT NULL DEFAULT 'bundle' " +
          "CHECK (kind IN ('bundle','plan'))",
      );
    }
    db.run("PRAGMA user_version = 9");
  })();
  console.log("[seer] migrated to schema v9 (bundle kind).");
}

// Tasks. A task belongs to one project; its gates and its authored PR pointers live
// as JSON on the row, because both are small bounded lists read whole and written
// whole. `project_task_prs` is the queryable copy of the pointers and mirrors
// `review_prs` deliberately, including the null repo_id transitional shape: the agent
// writes only "owner/name" and a number, so every row starts unresolved and the first
// webhook observation heals the numeric id, exactly as a backfilled review row is
// healed. The delivery filter and the orphan sweep read both tables, so a pull
// request only a task names is kept and one nothing names is dropped.
const V10_TASKS = `
  CREATE TABLE IF NOT EXISTS project_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','closed')),
    gates TEXT NOT NULL DEFAULT '[]',
    prs TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id);

  CREATE TABLE IF NOT EXISTS project_task_prs (
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    repo_id INTEGER,
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    PRIMARY KEY (workspace_id, task_id, repo_id, pr_number)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_prs_unresolved
    ON project_task_prs (workspace_id, task_id, lower(repo), pr_number) WHERE repo_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_project_task_prs_lookup
    ON project_task_prs (workspace_id, pr_number);
`;

function migrateToV10(): void {
  db.transaction(() => {
    db.exec(V10_TASKS);
    db.run("PRAGMA user_version = 10");
  })();
  console.log("[seer] migrated to schema v10 (tasks).");
}

// The append-only record. No UPDATE and no DELETE anywhere in src for this table:
// notes are what the agent was thinking at the time, and correcting one means
// writing another.
const V11_NOTES = `
  CREATE TABLE IF NOT EXISTS project_notes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT,
    body TEXT NOT NULL,
    author_user_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_notes_project ON project_notes (project_id);
`;

function migrateToV11(): void {
  db.transaction(() => {
    db.exec(V11_NOTES);
    db.run("PRAGMA user_version = 11");
  })();
  console.log("[seer] migrated to schema v11 (notes).");
}

const V12_STAGE_CAPTURES = `
  CREATE TABLE IF NOT EXISTS stage_blobs (
    workspace_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, sha256)
  );
  CREATE TABLE IF NOT EXISTS stage_captures (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    source_head_sha TEXT NOT NULL,
    base_tip_sha TEXT NOT NULL,
    merge_base_sha TEXT NOT NULL,
    patch_sha256 TEXT,
    state TEXT NOT NULL CHECK (state IN ('completed')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stage_captures_workspace ON stage_captures (workspace_id, slug);
  CREATE TABLE IF NOT EXISTS stage_capture_files (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    path TEXT NOT NULL,
    old_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('added','removed','modified','renamed','mode_changed','unknown')),
    old_object_id TEXT,
    new_object_id TEXT,
    old_mode TEXT,
    new_mode TEXT,
    old_kind TEXT,
    new_kind TEXT,
    additions INTEGER,
    deletions INTEGER,
    old_availability TEXT NOT NULL CHECK (old_availability IN ('retained','unavailable','not_applicable')),
    new_availability TEXT NOT NULL CHECK (new_availability IN ('retained','unavailable','not_applicable')),
    old_blob_sha TEXT,
    new_blob_sha TEXT,
    old_reason TEXT,
    new_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stage_capture_files_capture ON stage_capture_files (workspace_id, capture_id, path);
  CREATE TABLE IF NOT EXISTS stage_capture_changes (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    old_start INTEGER NOT NULL,
    old_lines INTEGER NOT NULL,
    new_start INTEGER NOT NULL,
    new_lines INTEGER NOT NULL,
    old_fingerprint TEXT NOT NULL,
    new_fingerprint TEXT NOT NULL,
    context_fingerprint TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('patch','reconstructed')),
    PRIMARY KEY (capture_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_stage_capture_changes_file ON stage_capture_changes (workspace_id, capture_id, file_id);
  CREATE TABLE IF NOT EXISTS stage_capture_incomplete (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('snapshot_incomplete','bytes_unavailable','lines_unavailable','patch_unavailable','metadata_incomplete')),
    path TEXT,
    side TEXT NOT NULL CHECK (side IN ('old','new','snapshot')),
    reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stage_capture_incomplete_capture ON stage_capture_incomplete (workspace_id, capture_id);
  CREATE TABLE IF NOT EXISTS stage_capture_idempotency (
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, idempotency_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_capture_idempotency_capture ON stage_capture_idempotency (capture_id);
`;

function migrateToV12(): void {
  db.transaction(() => {
    db.exec(V12_STAGE_CAPTURES);
    db.run("PRAGMA user_version = 12");
  })();
  console.log("[seer] migrated to schema v12 (stage captures).");
}

const V13_STAGES = `
  CREATE TABLE IF NOT EXISTS stage_capture_builders (
    workspace_id TEXT NOT NULL,
    capture_id TEXT NOT NULL UNIQUE,
    intent TEXT NOT NULL,
    context TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_model TEXT NOT NULL,
    user_id TEXT,
    key_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, capture_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stage_capture_builders_workspace ON stage_capture_builders (workspace_id, capture_id);
  CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    lineage_base_ref TEXT NOT NULL,
    lineage_base_sha TEXT NOT NULL,
    latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
    created_by_user_id TEXT NOT NULL,
    created_by_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_stages_workspace ON stages (workspace_id, slug);
  CREATE TABLE IF NOT EXISTS stage_versions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    capture_id TEXT NOT NULL UNIQUE,
    doc TEXT NOT NULL,
    digest TEXT NOT NULL,
    witness_user_id TEXT NOT NULL,
    witness_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug, version)
  );
  CREATE INDEX IF NOT EXISTS idx_stage_versions_workspace ON stage_versions (workspace_id, slug, version);
  CREATE TABLE IF NOT EXISTS project_stages (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_project_stages_stage ON project_stages (workspace_id, slug);
`;

function migrateToV13(): void {
  db.transaction(() => {
    db.exec(V13_STAGES);
    db.run("PRAGMA user_version = 13");
  })();
  console.log("[seer] migrated to schema v13 (stage publication).");
}

const V14_STAGE_READS = `
  CREATE TABLE IF NOT EXISTS stage_change_reads (
    workspace_id TEXT NOT NULL,
    stage_version_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, stage_version_id, user_id, change_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stage_change_reads_member
    ON stage_change_reads (workspace_id, stage_version_id, user_id);
`;

function migrateToV14(): void {
  db.transaction(() => {
    db.exec(V14_STAGE_READS);
    db.run("PRAGMA user_version = 14");
  })();
  console.log("[seer] migrated to schema v14 (stage read state).");
}

// The promoted review. A lineage is workspace-scoped and slugged exactly as a legacy
// review and a stage are, and the slug is unique across `reviews` and `review_lineages`
// together — enforced in both write paths rather than by a constraint, because SQLite
// cannot spell "unique across two tables" and a promoted lineage must never be able to
// take a slug an old bare `/r/<slug>` link already resolves.
//
// A revision is one immutable evidence document over one completed capture.
// `capture_id UNIQUE` here is the revision's own rule and says nothing about
// `stage_versions.capture_id`: one capture may back a StageDoc V1 and a revision at
// once, and neither consumes the other.
//
// An account is what a witness publishes over a revision. Its `version` is lineage-wide
// rather than per revision, so `/v/<n>` names one publication for the whole promoted
// review the way a legacy review's version does, while `revision_id` records which code
// stream it accounts for.
//
// `review_witness_requests` is workflow state, kept out of both documents: an evidence
// document that carried "pending" would stop being immutable the moment the witness
// answered. `revision_id UNIQUE` is the one-initial-request-per-revision rule of this
// slice; lifting it means dropping the index, not rewriting rows.
//
// Read state keys on the REVISION rather than on an account: the code a member marks
// read belongs to the source revision, so every account published over that revision
// reads with the same handling state instead of resetting it.
const V15_REVIEW_LINEAGES = `
  CREATE TABLE IF NOT EXISTS review_lineages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    original_base_ref TEXT NOT NULL,
    original_base_sha TEXT NOT NULL,
    title TEXT NOT NULL,
    latest_revision INTEGER,
    latest_account_version INTEGER,
    created_by_user_id TEXT NOT NULL,
    created_by_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_review_lineages_workspace ON review_lineages (workspace_id, slug);

  CREATE TABLE IF NOT EXISTS review_revisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    capture_id TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    doc TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revisions_lineage ON review_revisions (workspace_id, lineage_id, revision);

  CREATE TABLE IF NOT EXISTS review_accounts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    doc TEXT NOT NULL,
    digest TEXT NOT NULL,
    witness_user_id TEXT NOT NULL,
    witness_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug, version)
  );
  CREATE INDEX IF NOT EXISTS idx_review_accounts_revision ON review_accounts (workspace_id, revision_id, version);

  CREATE TABLE IF NOT EXISTS review_witness_requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    revision_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending','failed','published')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    failure TEXT,
    account_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_witness_requests_lineage
    ON review_witness_requests (workspace_id, lineage_id);

  CREATE TABLE IF NOT EXISTS review_revision_change_reads (
    workspace_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, revision_id, user_id, change_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revision_change_reads_member
    ON review_revision_change_reads (workspace_id, revision_id, user_id);

  CREATE TABLE IF NOT EXISTS project_review_lineages (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_project_review_lineages_lineage
    ON project_review_lineages (workspace_id, slug);
`;

function migrateToV15(): void {
  db.transaction(() => {
    db.exec(V15_REVIEW_LINEAGES);
    db.run("PRAGMA user_version = 15");
  })();
  console.log("[seer] migrated to schema v15 (promoted review revisions).");
}

// The pull request a lineage reviews, and the workflow that gets one there.
//
// `review_lineage_prs` is the ONE normalized relationship. Route resolution, webhook
// filtering, reconciliation and orphan retention all join it, so a second table naming
// the same fact would be a second place for the join to drift. The primary key is the
// lineage, which is what makes "at most one current pull request" a constraint rather
// than a convention; the partial unique index is the other half — one live pull request
// cannot be owned by two lineages in a workspace, and a later explicit detach releases it
// by stamping `detached_at` rather than by deleting the history.
//
// `review_pr_observations` is immutable, and the digest is what makes re-reading cheap
// without making it dishonest: it covers the normalized GitHub facts AND the exact actor,
// but not Seer's own `observed_at`. Reading unchanged facts through the same actor reuses
// the row; reading them through a different one records a separately attributed
// observation, because who was allowed to see it is part of what was seen.
//
// `review_revision_sources` is the source-tuple arbiter and the reason task 5 needs no V2
// revision document. A revision points at the observation it was captured from, so PR
// identity has one stored home; the unique tuple is what stops a second capture result
// publishing a duplicate revision of bytes already published.
//
// `review_capture_jobs` is workflow state, deliberately outside both documents: a pending
// or failed job is visible and retryable and is not a source revision. `actor_key` is the
// queue lane — one actor runs one capture at a time — and the lease is what lets another
// process recover an abandoned claim without two healthy workers spending one credential.
//
// `review_pr_idempotency` replays the client's operation; the source tuple replays the
// capture. Two identities on purpose: the same user request must return the same answer,
// and two different requests that observe the same bytes must not publish twice.
//
// `review_witness_claims` is keyed by `(request, retry count)` because the retry count is
// what makes a second attempt a different piece of work. A same-key claim renews its
// lease; an expired one may be taken over without touching the count.
const V16_REVIEW_LINEAGE_PRS = `
  CREATE TABLE IF NOT EXISTS review_lineage_prs (
    lineage_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number >= 1),
    head_ref TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('installation','user','anonymous')),
    installation_id INTEGER,
    user_id TEXT,
    credential_id TEXT,
    attached_at INTEGER NOT NULL,
    detached_at INTEGER,
    CHECK (
      (actor_kind = 'installation' AND installation_id IS NOT NULL AND user_id IS NULL AND credential_id IS NULL) OR
      (actor_kind = 'user' AND installation_id IS NULL AND user_id IS NOT NULL AND credential_id IS NOT NULL) OR
      (actor_kind = 'anonymous' AND installation_id IS NULL AND user_id IS NULL AND credential_id IS NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_lineage_prs_live
    ON review_lineage_prs (workspace_id, repo_id, pr_number) WHERE detached_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_review_lineage_prs_join
    ON review_lineage_prs (pr_number, repo_id);
  CREATE INDEX IF NOT EXISTS idx_review_lineage_prs_workspace
    ON review_lineage_prs (workspace_id, slug);

  CREATE TABLE IF NOT EXISTS review_pr_observations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number >= 1),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','closed')),
    merged INTEGER NOT NULL CHECK (merged IN (0,1)),
    draft INTEGER NOT NULL CHECK (draft IN (0,1)),
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    -- Nullable, and only ever null on a webhook observation. A delivery does not carry a
    -- merge base and Seer must not invent one: a fabricated merge base would let a
    -- delivery be mistaken for a capturable source tuple, which is the one thing an
    -- unasked-for observation must never be.
    merge_base_sha TEXT,
    github_updated_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('installation','user','anonymous')),
    installation_id INTEGER,
    user_id TEXT,
    credential_id TEXT,
    digest TEXT NOT NULL,
    UNIQUE (lineage_id, digest)
  );
  CREATE INDEX IF NOT EXISTS idx_review_pr_observations_lineage
    ON review_pr_observations (workspace_id, lineage_id, observed_at);

  CREATE TABLE IF NOT EXISTS review_revision_sources (
    revision_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    observation_id TEXT NOT NULL UNIQUE,
    base_tip_sha TEXT NOT NULL,
    source_head_sha TEXT NOT NULL,
    merge_base_sha TEXT NOT NULL,
    attached_at INTEGER NOT NULL,
    UNIQUE (lineage_id, base_tip_sha, source_head_sha, merge_base_sha)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revision_sources_lineage
    ON review_revision_sources (workspace_id, lineage_id);

  CREATE TABLE IF NOT EXISTS review_capture_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','running','failed','completed')),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('installation','user','anonymous')),
    installation_id INTEGER,
    user_id TEXT,
    credential_id TEXT,
    actor_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    failure TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    capture_id TEXT,
    revision_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (lineage_id, observation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_capture_jobs_lane
    ON review_capture_jobs (actor_key, state, created_at);
  CREATE INDEX IF NOT EXISTS idx_review_capture_jobs_lineage
    ON review_capture_jobs (workspace_id, lineage_id, created_at);

  CREATE TABLE IF NOT EXISTS review_pr_idempotency (
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create','attach','refresh')),
    lineage_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    capture_job_id TEXT,
    revision_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS review_witness_claims (
    request_id TEXT NOT NULL,
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, retry_count)
  );
  CREATE INDEX IF NOT EXISTS idx_review_witness_claims_workspace
    ON review_witness_claims (workspace_id, request_id);
`;

function migrateToV16(): void {
  db.transaction(() => {
    db.exec(V16_REVIEW_LINEAGE_PRS);
    db.run("PRAGMA user_version = 16");
  })();
  console.log("[seer] migrated to schema v16 (pull request review lineage).");
}

// What a MOVING pull request leaves behind.
//
// `review_revision_read_carries` is provenance and only provenance. The ACTIVE read is
// still one `review_revision_change_reads` row, written in the same transaction as the row
// here, so there is exactly one place that answers "has this member handled this change".
// This table answers a different question — why did that read arrive without anybody
// clicking — and it is immutable: unmarking a carried read removes the active row and
// leaves this one standing, because the history still happened. The key digest is the
// exact equivalence key the carry was proved on, so a later reader can say what was
// matched rather than trusting that something was.
//
// Its primary key omits the workspace deliberately. A revision id is globally unique, so
// `(target revision, member, target change)` already names one carry; adding the workspace
// would let the same carry exist twice if a revision id were ever reused across
// workspaces, which is the opposite of what a uniqueness constraint is for. The column is
// still carried, because every read on this path is workspace-scoped.
//
// `review_witness_supersessions` is the other half. Appending revision N leaves any
// unpublished witness request for an earlier revision working on code that is no longer
// the newest; `superseded` is that fact, and it is a JOIN rather than a fourth state in
// the v16 CHECK. Rebuilding that CHECK would mean rewriting every stored request row to
// add a word the requests themselves never take, and a v16 image reading a request whose
// state it did not recognise would refuse the whole promoted review. The request id is the
// primary key, so the FIRST successor is preserved: a second append inserts-or-ignores and
// cannot rewrite which revision superseded it.
const V17_REVIEW_MOVEMENT = `
  CREATE TABLE IF NOT EXISTS review_revision_read_carries (
    target_revision_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    target_change_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    source_change_id TEXT NOT NULL,
    key_digest TEXT NOT NULL,
    carried_at INTEGER NOT NULL,
    PRIMARY KEY (target_revision_id, user_id, target_change_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revision_read_carries_source
    ON review_revision_read_carries (source_revision_id, user_id);

  CREATE TABLE IF NOT EXISTS review_witness_supersessions (
    request_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    superseded_revision_id TEXT NOT NULL,
    successor_revision_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_witness_supersessions_lineage
    ON review_witness_supersessions (workspace_id, lineage_id);
`;

function migrateToV17(): void {
  db.transaction(() => {
    db.exec(V17_REVIEW_MOVEMENT);
    db.run("PRAGMA user_version = 17");
  })();
  console.log("[seer] migrated to schema v17 (moving pull request handling).");
}

// v18: what one revision changed about the one before it, stored once.
//
// Both captures are immutable, and the delta engine is deterministic over them, so the
// answer is a fact the completion transaction can write rather than something every page
// and every API read recomputes from two inventories. The counts are what the movement
// line says; the equivalences are what a read marked AFTER the next revision existed needs
// in order to carry forward, which the completion-time carry alone could never do. The
// boundary table records an explicit later choice so an older read can never overwrite it.
// All three are additive: v17 reads none of them, and a revision published before this
// release has its movement rows written the first time anything asks.
const V18_REVISION_MOVEMENT = `
  CREATE TABLE IF NOT EXISTS review_revision_movements (
    revision_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    previous_revision_id TEXT NOT NULL,
    unchanged INTEGER NOT NULL,
    revised INTEGER NOT NULL,
    new INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_revision_equivalences (
    target_revision_id TEXT NOT NULL,
    target_change_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    source_change_id TEXT NOT NULL,
    key_digest TEXT NOT NULL,
    PRIMARY KEY (target_revision_id, target_change_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revision_equivalences_source
    ON review_revision_equivalences (source_revision_id, source_change_id);

  -- An explicit mark or unmark on a target revision is a member's boundary: an older
  -- revision may never carry through it later. Active state remains in
  -- review_revision_change_reads; this row records only that the member acted here.
  CREATE TABLE IF NOT EXISTS review_revision_read_boundaries (
    revision_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (revision_id, user_id, change_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_revision_read_boundaries_workspace
    ON review_revision_read_boundaries (workspace_id, revision_id, user_id);
`;

function migrateToV18(): void {
  db.transaction(() => {
    db.exec(V18_REVISION_MOVEMENT);
    db.run("PRAGMA user_version = 18");
  })();
  console.log("[seer] migrated to schema v18 (stored revision movement).");
}

// v19: a stack groups review lineages, and owns none of what they own.
//
// A lineage stays the only owner of its source revisions, accounts, reads and witness
// workflow. What a stack adds is ORDER and a WHOLE: an immutable manifest pins each member
// at an exact revision (and, once it exists, an exact account), and one account over that
// manifest explains the completed result by partitioning every member account group exactly
// once. No stack read table exists: progress is the sum of member reads.
//
// `review_stack_members` is the live membership webhooks and reconciliation join. It carries
// no position on purpose — order is the manifest's, and a row that said otherwise would be a
// second place for the order to drift. `UNIQUE (stack_id, predecessor_version)` on the
// manifests is what makes "one successor per predecessor" a constraint rather than a
// convention, whichever of refresh and account-ready commits first.
//
// `review_stack_pr_observations` gives each accepted membership receipt its own identity.
// It links to the complete promoted pull request observation when the payload supported one;
// that link is null for accepted partial payloads. `provider_stack_number` NULL is the only
// unstack signal GitHub sends, so absence is stored rather than inferred.
const V19_REVIEW_STACKS = `
  CREATE TABLE IF NOT EXISTS review_stacks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    repo TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    base_ref TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('native','inferred')),
    provider_stack_id INTEGER,
    provider_stack_number INTEGER,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('installation','user','anonymous')),
    installation_id INTEGER,
    user_id TEXT,
    credential_id TEXT,
    latest_manifest_version INTEGER NOT NULL CHECK (latest_manifest_version >= 1),
    created_by_user_id TEXT NOT NULL,
    created_by_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug),
    CHECK ((source = 'native') = (provider_stack_number IS NOT NULL)),
    CHECK (
      (actor_kind = 'installation' AND installation_id IS NOT NULL AND user_id IS NULL AND credential_id IS NULL) OR
      (actor_kind = 'user' AND installation_id IS NULL AND user_id IS NOT NULL AND credential_id IS NOT NULL) OR
      (actor_kind = 'anonymous' AND installation_id IS NULL AND user_id IS NULL AND credential_id IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_review_stacks_workspace ON review_stacks (workspace_id, updated_at);

  CREATE TABLE IF NOT EXISTS review_stack_members (
    stack_id TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    lineage_slug TEXT NOT NULL,
    repo_id INTEGER NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number >= 1),
    added_manifest_id TEXT NOT NULL,
    removed_at INTEGER,
    removed_reason TEXT CHECK (removed_reason IN ('unstacked','merged','closed','detached')),
    removed_manifest_id TEXT,
    PRIMARY KEY (stack_id, lineage_id),
    CHECK ((removed_at IS NULL) = (removed_reason IS NULL) AND (removed_at IS NULL) = (removed_manifest_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_stack_members_live_lineage
    ON review_stack_members (lineage_id) WHERE removed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_review_stack_members_pr
    ON review_stack_members (repo_id, pr_number) WHERE removed_at IS NULL;

  CREATE TABLE IF NOT EXISTS review_stack_manifests (
    id TEXT PRIMARY KEY,
    stack_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    predecessor_version INTEGER NOT NULL CHECK (predecessor_version >= 0),
    reason TEXT NOT NULL CHECK (reason IN ('created','refresh','account-ready')),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    doc TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug, version),
    UNIQUE (stack_id, predecessor_version)
  );

  CREATE TABLE IF NOT EXISTS review_stack_accounts (
    id TEXT PRIMARY KEY,
    stack_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    doc TEXT NOT NULL,
    digest TEXT NOT NULL,
    witness_user_id TEXT NOT NULL,
    witness_key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, slug, version)
  );

  CREATE TABLE IF NOT EXISTS review_stack_witness_requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stack_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL CHECK (version >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending','failed','published')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    failure TEXT,
    account_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_stack_witness_requests_stack
    ON review_stack_witness_requests (workspace_id, stack_id);

  CREATE TABLE IF NOT EXISTS review_stack_witness_claims (
    request_id TEXT NOT NULL,
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, retry_count)
  );

  CREATE TABLE IF NOT EXISTS review_stack_witness_supersessions (
    request_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stack_id TEXT NOT NULL,
    superseded_manifest_id TEXT NOT NULL,
    successor_manifest_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS review_stack_pr_observations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    pull_request_observation_id TEXT,
    repo_id INTEGER NOT NULL,
    pr_number INTEGER NOT NULL,
    provider_stack_id INTEGER,
    provider_stack_number INTEGER,
    position INTEGER,
    size INTEGER,
    stack_base_ref TEXT,
    stack_base_sha TEXT,
    observed_at INTEGER NOT NULL,
    UNIQUE (workspace_id, receipt_id),
    CHECK ((provider_stack_number IS NULL) = (provider_stack_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_review_stack_pr_observations_pr
    ON review_stack_pr_observations (workspace_id, repo_id, pr_number, observed_at);

  CREATE TABLE IF NOT EXISTS review_stack_refresh_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stack_id TEXT NOT NULL,
    stack_observation_id TEXT,
    pull_request_observation_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','running','failed','completed')),
    installation_id INTEGER NOT NULL,
    actor_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    failure TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    result_manifest_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (stack_id, stack_observation_id),
    UNIQUE (stack_id, pull_request_observation_id),
    CHECK ((stack_observation_id IS NULL) != (pull_request_observation_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_review_stack_refresh_jobs_lane
    ON review_stack_refresh_jobs (actor_key, state, created_at);

  CREATE TABLE IF NOT EXISTS review_stack_idempotency (
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create','refresh')),
    stack_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS project_review_stacks (
    project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_project_review_stacks_stack ON project_review_stacks (workspace_id, slug);
`;

function migrateToV19(): void {
  db.transaction(() => {
    db.exec(V19_REVIEW_STACKS);
    db.run("PRAGMA user_version = 19");
  })();
  console.log("[seer] migrated to schema v19 (review stacks).");
}

const V20_REVIEW_DOCUMENT_SHARES = `
  ALTER TABLE shares RENAME TO shares_v4;

  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review','bundle','review_document','stack_document')),
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
  );

  INSERT INTO shares (
    id, workspace_id, kind, target, label, token_hash,
    created_by, created_at, expires_at, revoked_at
  )
  SELECT
    id, workspace_id, kind, target, label, token_hash,
    created_by, created_at, expires_at, revoked_at
  FROM shares_v4;

  DROP TABLE shares_v4;

  CREATE INDEX idx_shares_workspace ON shares (workspace_id);
  CREATE INDEX idx_shares_target ON shares (workspace_id, kind, target, created_at);

  CREATE TABLE share_document_capabilities (
    share_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('review_revision','review_account','stack_manifest','stack_account')),
    document_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (share_id, workspace_id, document_kind, document_id)
  );
  CREATE INDEX idx_share_document_capabilities_document
    ON share_document_capabilities (workspace_id, document_kind, document_id);

  CREATE TABLE share_capability_files (
    share_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_position INTEGER NOT NULL CHECK (member_position >= 1 AND member_position <= 64),
    revision_id TEXT NOT NULL,
    capture_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    PRIMARY KEY (share_id, member_position, file_id),
    UNIQUE (share_id, ordinal)
  );
  CREATE INDEX idx_share_capability_files_lookup
    ON share_capability_files (share_id, member_position, file_id);

  CREATE TABLE share_capability_items (
    share_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    member_position INTEGER NOT NULL CHECK (member_position >= 1 AND member_position <= 64),
    revision_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('change','material','file')),
    item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    PRIMARY KEY (share_id, member_position, item_kind, item_id),
    UNIQUE (share_id, ordinal)
  );
  CREATE INDEX idx_share_capability_items_lookup
    ON share_capability_items (share_id, member_position, item_kind, item_id);

  CREATE TABLE share_capability_attachments (
    share_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    review_slug TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    PRIMARY KEY (share_id, attachment_id),
    UNIQUE (share_id, ordinal)
  );
`;

function migrateToV20(): void {
  db.transaction(() => {
    db.exec(V20_REVIEW_DOCUMENT_SHARES);
    db.run("PRAGMA user_version = 20");
  })();
  console.log("[seer] migrated to schema v20 (exact review document capabilities).");
}

/**
 * The number 6 is ambiguous, and this is the repair for it.
 *
 * The App release that shipped before this one still carried the freshness drop as a
 * GATED v6: a database whose operator set SEER_DROP_FRESHNESS under that image sits at
 * user_version 6 today with no github_user_credentials table. This release reads 6 as
 * "the credentials table exists", so the ladder walks straight past the only step that
 * creates it and stamps 7 over the gap — permanently, since no later step will ever
 * revisit it. A version says what shape a database has reached, but a number two images
 * used for two different facts says nothing; the shape is asserted directly instead.
 * Both blocks are IF NOT EXISTS, so a database that took the ordinary walk pays a
 * table lookup and nothing else.
 */
function ensureUserCredentialTables(): void {
  if (userVersion() >= 6 && !tableExists("github_user_credentials")) {
    db.exec(V6_GITHUB_USER_CREDENTIALS);
    console.log("[seer] repaired schema: github_user_credentials was missing at user_version >= 6.");
  }
  if (userVersion() >= 7 && !tableExists("github_user_oauth_claims")) {
    db.exec(V7_GITHUB_USER_OAUTH_CLAIMS);
    console.log("[seer] repaired schema: github_user_oauth_claims was missing at user_version >= 7.");
  }
}

function migrateToV6(): void {
  db.transaction(() => {
    db.exec(V6_GITHUB_USER_CREDENTIALS);
    db.run("PRAGMA user_version = 6");
  })();
  console.log("[seer] migrated to schema v6 (GitHub user credentials).");
}

/**
 * The one destructive change in the repo, and deliberately not a schema version.
 *
 * It removes a second recording of a fact `review_prs` already holds, and nothing has
 * read or written the table since v5, so there is nothing to carry forward. What it is
 * waiting for is a release rather than a shape: the graceful-shutdown overlap means an
 * old container is still calling listFreshness() while the new one migrates, so the
 * table has to outlive one deploy before it can go.
 *
 * "Wait a release" is a fact about time, and the ladder above records shape. Numbering
 * this put a conditional step in the middle of a monotonic sequence, and the next
 * migration added after it walked ordinary databases straight over the gate, leaving the
 * drop permanently unreachable. So the opt-in lives in `meta` instead, where nothing can
 * leapfrog it and where having passed it is not confused with having risen above it.
 *
 * Deleting the gate next release means deleting the env check and nothing else: a
 * database that already opted in is left alone by the key, and one that has not gets the
 * drop on its next boot.
 */
const FRESHNESS_DROPPED = "freshness_dropped";

function dropFreshnessIfOptedIn(): void {
  if (process.env.SEER_DROP_FRESHNESS !== "1") return;
  if (getMeta(FRESHNESS_DROPPED)) return;
  db.transaction(() => {
    // IF EXISTS in case a future release stops creating it in V3_REVIEWS.
    db.run("DROP TABLE IF EXISTS review_freshness");
    setMeta(FRESHNESS_DROPPED, new Date().toISOString());
  })();
  console.log("[seer] dropped the freshness table (SEER_DROP_FRESHNESS=1).");
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
