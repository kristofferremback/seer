// Runs in its OWN process (spawned by migrate.test.ts). The db/config singletons
// bind to one DATA_DIR per process, so each migration scenario needs a fresh process.
// SCENARIO selects what to seed and assert. Exits 0 on success, 1 on the first
// failed assertion (message on stderr).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bun auto-loads the repo's .env in this child process, which can reintroduce a
// developer's real API_KEY and outrank the API_TOKEN a scenario sets. Scenarios own
// their auth env, so drop it before any app module reads config.
delete process.env.API_KEY;

const SCENARIO = process.env.SCENARIO!;
const dataDir = process.env.DATA_DIR!;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED [${SCENARIO}]: ${msg}`);
    process.exit(1);
  }
}

const V3_TABLES = [
  "reviews",
  "review_versions",
  "review_attachments",
  "review_annotations",
  "review_reads",
  "review_freshness",
  "ref_snippets",
];

// ---- seed a v0-with-data database + zip layout BEFORE importing app modules ----
function seedV0() {
  mkdirSync(dataDir, { recursive: true });
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE bundles (slug TEXT PRIMARY KEY, created_at INTEGER NOT NULL, latest_version INTEGER NOT NULL);
    CREATE TABLE versions (slug TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, PRIMARY KEY (slug, version));
  `);
  seed.run("INSERT INTO bundles (slug, created_at, latest_version) VALUES ('legacy-site', 1000, 2)");
  seed.run("INSERT INTO versions (slug, version, created_at, bytes, file_count) VALUES ('legacy-site', 1, 1000, 10, 1)");
  seed.run("INSERT INTO versions (slug, version, created_at, bytes, file_count) VALUES ('legacy-site', 2, 2000, 20, 1)");
  assert(seed.query("PRAGMA user_version").get() != null, "seed user_version readable");
  seed.close();

  // v0 zip layout: DATA_DIR/zips/<slug>/<version>.zip
  const slugZips = join(dataDir, "zips", "legacy-site");
  mkdirSync(slugZips, { recursive: true });
  writeFileSync(join(slugZips, "1.zip"), "zip-v1");
  writeFileSync(join(slugZips, "2.zip"), "zip-v2");
}

if (SCENARIO === "v0") {
  process.env.API_TOKEN = "legacy-env-token";
  process.env.ALLOWED_EMAILS = "Root@Example.com"; // mixed case -> lowercased
  // Auth enabled (AUTH_DISABLED unset): config requires OIDC vars; migration never
  // talks to Google, these just satisfy the config load.
  process.env.GOOGLE_CLIENT_ID = "x";
  process.env.GOOGLE_CLIENT_SECRET = "x";
  process.env.SESSION_SECRET = "x";
  seedV0();

  const { migrate } = await import("../src/migrate");
  const { db, getMeta } = await import("../src/db");
  const { hashKey } = await import("../src/ids");

  migrate();

  const wsId = getMeta("legacy_workspace_id")!;
  assert(/^ws_[0-9abcdefghjkmnpqrstvwxyz]{10}$/.test(wsId), `ws id shape: ${wsId}`);

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 3, `user_version should be 3, got ${uv}`);

  const user = db.query("SELECT * FROM users").get() as { id: string; email: string } | null;
  assert(!!user, "root user exists");
  assert(user!.email === "root@example.com", `email lowercased, got ${user!.email}`);

  const ws = db.query("SELECT * FROM workspaces WHERE id = ?").get(wsId) as
    | { name: string; visibility: string }
    | null;
  assert(!!ws, "root workspace exists");
  assert(ws!.name === "root", `ws name is email local part, got ${ws!.name}`);
  assert(ws!.visibility === "public", `ws visibility public, got ${ws!.visibility}`);

  const mem = db.query("SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?").get(wsId, user!.id);
  assert(!!mem, "membership exists");

  // env key imported as a legacy key; auth (step 2) will hash-match it.
  const key = db.query("SELECT * FROM api_keys WHERE token_hash = ?").get(hashKey("legacy-env-token")) as
    | { is_legacy: number; token_hint: string; workspace_id: string; user_id: string }
    | null;
  assert(!!key, "env key imported");
  assert(key!.is_legacy === 1, "imported key is legacy");
  assert(key!.token_hint === "(pre-workspace key)", `hint, got ${key!.token_hint}`);
  assert(key!.workspace_id === wsId && key!.user_id === user!.id, "key belongs to root user/ws");

  // bundle + versions adopted under the workspace.
  const b = db.query("SELECT * FROM bundles WHERE workspace_id = ? AND slug = 'legacy-site'").get(wsId) as
    | { latest_version: number; created_at: number }
    | null;
  assert(!!b, "bundle adopted");
  assert(b!.latest_version === 2, `latest_version preserved, got ${b!.latest_version}`);
  const vCount = (db.query("SELECT COUNT(*) c FROM versions WHERE workspace_id = ?").get(wsId) as { c: number }).c;
  assert(vCount === 2, `two versions adopted, got ${vCount}`);
  assert(!existsSync(join(dataDir, "zips", "legacy-site")), "old zip dir gone");
  assert(existsSync(join(dataDir, "zips", wsId, "legacy-site", "1.zip")), "zip v1 moved under ws");
  assert(existsSync(join(dataDir, "zips", wsId, "legacy-site", "2.zip")), "zip v2 moved under ws");

  // Idempotent: a second run is a no-op, no duplicate rows.
  migrate();
  const uCount = (db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  const kCount = (db.query("SELECT COUNT(*) c FROM api_keys").get() as { c: number }).c;
  assert(uCount === 1, `still one user after re-run, got ${uCount}`);
  assert(kCount === 1, `still one key after re-run, got ${kCount}`);
  assert(getMeta("legacy_workspace_id") === wsId, "ws id stable across re-run");

  console.log("migrate v0: all assertions passed");
  process.exit(0);
}

if (SCENARIO === "fresh") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  delete process.env.API_TOKEN;
  delete process.env.API_KEY;

  const { migrate } = await import("../src/migrate");
  const { db, getMeta } = await import("../src/db");

  migrate();

  const wsId = getMeta("legacy_workspace_id")!;
  assert(/^ws_[0-9abcdefghjkmnpqrstvwxyz]{10}$/.test(wsId), `ws id shape: ${wsId}`);
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 3, `user_version should be 3, got ${uv}`);
  const iCount = (db.query("SELECT COUNT(*) c FROM images").get() as { c: number }).c;
  assert(iCount === 0, `fresh db has an empty images table, got ${iCount}`);
  const user = db.query("SELECT * FROM users").get() as { email: string } | null;
  assert(!!user && user.email === "dev@localhost", `fresh root is dev@localhost, got ${user?.email}`);
  const ws = db.query("SELECT * FROM workspaces WHERE id = ?").get(wsId) as { name: string } | null;
  assert(!!ws && ws.name === "dev", `fresh ws name is 'dev', got ${ws?.name}`);
  // No env key -> no key rows.
  const kCount = (db.query("SELECT COUNT(*) c FROM api_keys").get() as { c: number }).c;
  assert(kCount === 0, `no keys imported on fresh boot, got ${kCount}`);
  // No bundles table leftovers from a v0 rebuild.
  const bCount = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount === 0, `fresh db has no bundles, got ${bCount}`);
  // v3: the overseer tables exist on a fresh boot too.
  for (const table of V3_TABLES) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} exists on a fresh db`);
  }

  console.log("migrate fresh: all assertions passed");
  process.exit(0);
}

// ---- seed a v2 database (v1 schema + images, user_version 2) ----
function seedV2() {
  mkdirSync(dataDir, { recursive: true });
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public', created_at INTEGER NOT NULL);
    CREATE TABLE memberships (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_hint TEXT NOT NULL,
      is_legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      last_used_at INTEGER, revoked_at INTEGER);
    CREATE TABLE invites (token TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      accepted_by TEXT, accepted_at INTEGER);
    CREATE TABLE bundles (workspace_id TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL,
      latest_version INTEGER NOT NULL, PRIMARY KEY (workspace_id, slug));
    CREATE TABLE versions (workspace_id TEXT NOT NULL, slug TEXT NOT NULL, version INTEGER NOT NULL,
      created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, slug, version));
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE images (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, filename TEXT NOT NULL,
      content_type TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
    PRAGMA user_version = 2;
  `);
  seed.run("INSERT INTO users (id, email, created_at) VALUES ('usr_seed', 'seed@example.com', 1000)");
  seed.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES ('ws_seed', 'seed', 'public', 1000)");
  seed.run("INSERT INTO bundles (workspace_id, slug, created_at, latest_version) VALUES ('ws_seed', 'site', 1000, 1)");
  seed.close();
}

if (SCENARIO === "v2") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  seedV2();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  migrate();

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 3, `user_version should be 3, got ${uv}`);

  for (const table of V3_TABLES) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} created by v3`);
  }

  // v1/v2 data survives untouched: v3 is purely additive.
  const uCount = (db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  assert(uCount === 1, `seeded user survives, got ${uCount}`);
  const bCount = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount === 1, `seeded bundle survives, got ${bCount}`);

  // A second run is a no-op: still v3, no duplicate rows, no throw.
  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 3, `user_version stays 3 after re-run, got ${uv2}`);
  const bCount2 = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount2 === 1, `no duplicate bundles after re-run, got ${bCount2}`);
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 0, `reviews table starts empty, got ${rCount}`);

  console.log("migrate v2: all assertions passed");
  process.exit(0);
}

if (SCENARIO === "noemail") {
  // Auth enabled, no ALLOWED_EMAILS: v0 data present but migration must fail loudly.
  delete process.env.AUTH_DISABLED;
  delete process.env.ALLOWED_EMAILS;
  process.env.GOOGLE_CLIENT_ID = "x";
  process.env.GOOGLE_CLIENT_SECRET = "x";
  process.env.SESSION_SECRET = "x";
  seedV0();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    assert(/ALLOWED_EMAILS/.test((err as Error).message), `actionable message, got: ${(err as Error).message}`);
  }
  assert(threw, "migration must throw when no root email can be resolved");
  // Loud failure must NOT half-migrate: still v0, old table intact.
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 0, `user_version stays 0 after failed migrate, got ${uv}`);

  console.log("migrate noemail: all assertions passed");
  process.exit(0);
}

console.error(`unknown SCENARIO: ${SCENARIO}`);
process.exit(1);
