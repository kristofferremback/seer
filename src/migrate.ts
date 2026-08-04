import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, getMeta, setMeta } from "./db";
import { hashKey, tinyId } from "./ids";

// Schema versioning is driven by `PRAGMA user_version`. Target is 4.
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
// collide if that constraint is ever lifted.
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

export function migrate(): void {
  const uv = userVersion();
  if (uv > 4) throw new Error(`Unexpected database user_version ${uv}; expected 0, 1, 2, 3, or 4`);
  if (uv === 0) migrateToV1();
  if (userVersion() < 2) migrateToV2();
  if (userVersion() < 3) migrateToV3();
  if (userVersion() < 4) migrateToV4();
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
