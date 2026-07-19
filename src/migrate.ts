import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { db, getMeta, setMeta } from "./db";
import { hashKey, tinyId } from "./ids";

// Schema versioning is driven by `PRAGMA user_version`. Target is 2.
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

export function migrate(): void {
  const uv = userVersion();
  if (uv > 2) throw new Error(`Unexpected database user_version ${uv}; expected 0, 1, or 2`);
  if (uv === 0) migrateToV1();
  if (userVersion() < 2) migrateToV2();
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
