// Runs in its OWN process (spawned by migrate.test.ts). The db/config singletons
// bind to one DATA_DIR per process, so each migration scenario needs a fresh process.
// SCENARIO selects what to seed and assert. Exits 0 on success, 1 on the first
// failed assertion (message on stderr).
import "./app-env";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // Still created, and still standing in this release: the drop is v6, a release later.
  "review_freshness",
  "review_versions",
  "review_attachments",
  "review_annotations",
  "review_reads",
  "ref_snippets",
];

const V4_TABLES = ["shares"];

const V5_TABLES = [
  "github_installations",
  "github_pr_status",
  "review_prs",
  "github_deliveries",
  "github_app_claims",
];

const V6_TABLES = ["github_user_credentials"];
const V12_TABLES = ["stage_blobs", "stage_captures", "stage_capture_files", "stage_capture_changes", "stage_capture_incomplete", "stage_capture_idempotency"];
const V13_TABLES = ["stage_capture_builders", "stages", "stage_versions", "project_stages"];
const V14_TABLES = ["stage_change_reads"];
const V15_TABLES = ["review_lineages", "review_revisions", "review_accounts", "review_witness_requests", "review_revision_change_reads", "project_review_lineages"];
const V16_TABLES = ["review_lineage_prs", "review_pr_observations", "review_revision_sources", "review_capture_jobs", "review_pr_idempotency", "review_witness_claims"];
const V17_TABLES = ["review_revision_read_carries", "review_witness_supersessions"];
const V18_TABLES = ["review_revision_movements", "review_revision_equivalences", "review_revision_read_boundaries"];
const V19_TABLES = ["review_stacks", "review_stack_members", "review_stack_manifests", "review_stack_accounts", "review_stack_witness_requests", "review_stack_witness_claims", "review_stack_witness_supersessions", "review_stack_pr_observations", "review_stack_refresh_jobs", "review_stack_idempotency", "project_review_stacks"];
const V20_TABLES = ["share_document_capabilities", "share_capability_files", "share_capability_items", "share_capability_attachments"];

/** The credential table has two properties the design argues for at length and the
 *  table-exists loops cannot see. A credential belongs to a PERSON: a workspace_id column
 *  would be the confused deputy rebuilt, so its absence is asserted rather than assumed.
 *  And the live-credential index is what every read goes through. */
function assertCredentialShape(database: Database): void {
  const cols = database
    .query<{ name: string }, []>("PRAGMA table_info(github_user_credentials)")
    .all()
    .map((c) => c.name);
  assert(cols.includes("user_id"), "credentials are keyed on a user");
  assert(
    !cols.includes("workspace_id"),
    `a credential must not carry a workspace_id; got columns ${cols.join(", ")}`,
  );
  const idx = database
    .query<{ name: string }, []>("PRAGMA index_list(github_user_credentials)")
    .all()
    .map((i) => i.name);
  assert(
    idx.some((n) => n.includes("github_user_credentials")),
    `the live-credential index is missing; got ${idx.join(", ") || "none"}`,
  );
}

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
  assert(uv === 20, `user_version should be 20, got ${uv}`);

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

  // Every adopted pre-v9 bundle reads kind 'bundle', which is true of every bundle
  // that existed before plans did.
  const kinds = db.query("SELECT DISTINCT kind FROM bundles").all() as { kind: string }[];
  assert(
    kinds.length === 1 && kinds[0]!.kind === "bundle",
    `adopted bundles all read kind 'bundle', got ${JSON.stringify(kinds)}`,
  );

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

if (SCENARIO === "v11") {
  process.env.AUTH_DISABLED = "true";
  mkdirSync(dataDir, { recursive: true });
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE project_notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
      task_id TEXT, body TEXT NOT NULL, author_user_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE shares (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('review','bundle')), target TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
    CREATE INDEX idx_shares_workspace ON shares (workspace_id);
    INSERT INTO project_notes VALUES ('note_seed', 'ws_seed', 'prj_seed', NULL, 'still here', NULL, 1000);
    PRAGMA user_version = 11;
  `);
  seed.close();
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `v11 database reaches 20, got ${uv}`);
  assert(!!db.query("SELECT 1 FROM project_notes WHERE id = 'note_seed'").get(), "populated v11 data survives");
  for (const table of V12_TABLES) assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after v11 migration`);
  for (const table of V13_TABLES) assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after v13 migration`);
  for (const table of V14_TABLES) assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after v14 migration`);
  for (const table of V15_TABLES) assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after v15 migration`);
  for (const table of [...V16_TABLES, ...V17_TABLES, ...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the v16 through v19 migrations`);
  console.log("migrate v11: all assertions passed");
  process.exit(0);
}

if (SCENARIO === "v12") {
  process.env.AUTH_DISABLED = "true";
  mkdirSync(dataDir, { recursive: true });
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE stage_blobs (workspace_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, sha256));
    CREATE TABLE stage_captures (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slug TEXT NOT NULL, repo TEXT NOT NULL, repo_id INTEGER NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL, source_head_sha TEXT NOT NULL, base_tip_sha TEXT NOT NULL, merge_base_sha TEXT NOT NULL, patch_sha256 TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE stage_capture_files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, capture_id TEXT NOT NULL, path TEXT NOT NULL, old_path TEXT, status TEXT NOT NULL, old_object_id TEXT, new_object_id TEXT, old_mode TEXT, new_mode TEXT, old_kind TEXT, new_kind TEXT, additions INTEGER, deletions INTEGER, old_availability TEXT NOT NULL, new_availability TEXT NOT NULL, old_blob_sha TEXT, new_blob_sha TEXT, old_reason TEXT, new_reason TEXT);
    CREATE TABLE stage_capture_changes (id TEXT NOT NULL, workspace_id TEXT NOT NULL, capture_id TEXT NOT NULL, file_id TEXT NOT NULL, old_start INTEGER NOT NULL, old_lines INTEGER NOT NULL, new_start INTEGER NOT NULL, new_lines INTEGER NOT NULL, old_fingerprint TEXT NOT NULL, new_fingerprint TEXT NOT NULL, context_fingerprint TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (capture_id, id));
    CREATE TABLE stage_capture_incomplete (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, capture_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, side TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE stage_capture_idempotency (workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, capture_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, idempotency_key));
    CREATE TABLE shares (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('review','bundle')), target TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
    CREATE INDEX idx_shares_workspace ON shares (workspace_id);
    PRAGMA user_version = 12;
  `);
  seed.run("INSERT INTO stage_captures VALUES ('stg_capture01', 'ws_seed', 'legacy-stage', 'Acme/Repo', 7, 'feature/blue', 'main', 'head', 'base', 'merge', NULL, 'completed', 1000)");
  seed.close();
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `v12 database reaches 20, got ${uv}`);
  assert(!!db.query("SELECT 1 FROM stage_captures WHERE id = 'stg_capture01' AND slug = 'legacy-stage'").get(), "populated v12 capture survives");
  assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_capture_builders'").get(), "builder table is additive");
  assert(db.query("SELECT 1 FROM stage_capture_builders WHERE capture_id = 'stg_capture01'").get() === null, "legacy capture has no invented builder packet");
  console.log("migrate v12: all assertions passed");
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
  assert(uv === 20, `user_version should be 20, got ${uv}`);
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
  // v3/v4: the overseer tables and the shares table exist on a fresh boot too.
  assertCredentialShape(db as unknown as Database);
  for (const table of [...V3_TABLES, ...V4_TABLES, ...V5_TABLES, ...V6_TABLES, ...V12_TABLES, ...V13_TABLES, ...V14_TABLES, ...V15_TABLES, ...V16_TABLES, ...V17_TABLES, ...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} exists on a fresh db`);
  }
  const shCount = (db.query("SELECT COUNT(*) c FROM shares").get() as { c: number }).c;
  assert(shCount === 0, `fresh db has an empty shares table, got ${shCount}`);

  // Delivery health needs somewhere to remember the last delivery per installation.
  // `github_deliveries` cannot answer it — that table is a replay guard swept on a
  // week's retention, so a fortnight of silence would read there as no silence at all.
  const cols = () =>
    (db.query("PRAGMA table_info(github_installations)").all() as { name: string }[]).map(
      (c) => c.name,
    );
  assert(cols().includes("last_delivery_at"), "github_installations has last_delivery_at");

  // Additive columns are applied outside the version ladder, so migrating an already
  // migrated database must be a no-op rather than a duplicate-column error.
  migrate();
  assert(
    cols().filter((c) => c === "last_delivery_at").length === 1,
    "re-migrating adds the column once, not twice",
  );

  // The path a database migrated before this column existed actually takes: the column
  // is missing and the next boot adds it, without a version bump and without touching
  // the rows already there.
  db.run("ALTER TABLE github_installations DROP COLUMN last_delivery_at");
  assert(!cols().includes("last_delivery_at"), "column removed for the upgrade test");
  migrate();
  assert(cols().includes("last_delivery_at"), "an older schema gains last_delivery_at on boot");

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
  assert(uv === 20, `user_version should be 20, got ${uv}`);

  assertCredentialShape(db as unknown as Database);
  for (const table of [...V3_TABLES, ...V4_TABLES, ...V5_TABLES, ...V6_TABLES]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} created on the walk up from v2`);
  }

  // v1/v2 data survives untouched: v3 and v4 are purely additive.
  const uCount = (db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  assert(uCount === 1, `seeded user survives, got ${uCount}`);
  const bCount = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount === 1, `seeded bundle survives, got ${bCount}`);

  // A second run is a no-op: still v4, no duplicate rows, no throw.
  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 20, `user_version stays 20 after re-run, got ${uv2}`);
  const bCount2 = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount2 === 1, `no duplicate bundles after re-run, got ${bCount2}`);
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 0, `reviews table starts empty, got ${rCount}`);

  // A database from a newer binary is refused rather than half-read. One above the
  // ladder's top, which moves with it: stamping the CURRENT maximum would prove nothing,
  // because this release accepts it.
  db.run("PRAGMA user_version = 21");
  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    assert(/user_version 21/.test((err as Error).message), `actionable message, got: ${(err as Error).message}`);
  }
  assert(threw, "migrate must throw on a user_version newer than it knows");
  db.run("PRAGMA user_version = 12");

  console.log("migrate v2: all assertions passed");
  process.exit(0);
}

// ---- seed a v3 database (v1 + images + the reviews tables, user_version 3) ----
//
// Only the v3 tables this scenario reads back are seeded: v4 creates one table and
// touches nothing else, so what the assertions have to show is that a database
// already at 3 gains `shares` and keeps everything it had.
function seedV3() {
  seedV2();
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE reviews (workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
      latest_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, slug));
    CREATE TABLE review_versions (workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
      version INTEGER NOT NULL, doc TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, slug, version));
    PRAGMA user_version = 3;
  `);
  seed.run("INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES ('ws_seed', 'golden', 1, 1000)");
  // A version row behind the head pointer, because v5 backfills from it. A review whose
  // latest_version has no document is corruption, and the migration says so rather than
  // quietly indexing nothing.
  seed.run(
    "INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES ('ws_seed', 'golden', 1, ?, 1000)",
    [JSON.stringify({ prs: [{ repo: "ThreaHQ/Threa", number: 1723 }] })],
  );
  seed.close();
}

if (SCENARIO === "v3") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  seedV3();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  const before = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(before === 3, `seeded db starts at 3, got ${before}`);

  migrate();

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `user_version should be 20, got ${uv}`);
  assertCredentialShape(db as unknown as Database);
  for (const table of [...V4_TABLES, ...V5_TABLES, ...V6_TABLES]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} created by v4`);
  }

  // The shares table has the columns the design names, and the kind list is closed.
  const cols = (db.query("PRAGMA table_info(shares)").all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    "id",
    "workspace_id",
    "kind",
    "target",
    "label",
    "token_hash",
    "created_by",
    "created_at",
    "expires_at",
    "revoked_at",
  ]) {
    assert(cols.includes(col), `shares.${col} exists, got columns ${cols.join(",")}`);
  }
  let kindRefused = false;
  try {
    db.run(
      "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) " +
        "VALUES ('shr_x', 'ws_seed', 'wallpaper', 'golden', '', 'hash-x', 'usr_seed', 1000)",
    );
  } catch {
    kindRefused = true;
  }
  assert(kindRefused, "shares.kind is a closed list and refuses an unknown kind");

  // v1/v2/v3 data survives untouched: v4 is purely additive.
  const uCount = (db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  assert(uCount === 1, `seeded user survives, got ${uCount}`);
  const bCount = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount === 1, `seeded bundle survives, got ${bCount}`);
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 1, `seeded review survives, got ${rCount}`);

  // A second run is a no-op.
  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 20, `user_version stays 20 after re-run, got ${uv2}`);
  const rCount2 = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount2 === 1, `no duplicate reviews after re-run, got ${rCount2}`);
  const sCount = (db.query("SELECT COUNT(*) c FROM shares").get() as { c: number }).c;
  assert(sCount === 0, `shares table starts empty, got ${sCount}`);

  console.log("migrate v3: all assertions passed");
  process.exit(0);
}

// ---- v4, with reviews to backfill: the one migration that reads a document ----
//
// v5 is the first migration in this repo that parses an application-level JSON format,
// so it gets its own two scenarios: one where the documents are sound and the rows it
// writes are shown to be joinable, and one where a document is malformed and the whole
// thing has to abort naming the exact row.
function seedV4(docs: { ws: string; slug: string; version: number; doc: unknown }[]) {
  seedV3();
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  seed.exec(`
    CREATE TABLE shares (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      target TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER);
    PRAGMA user_version = 4;
  `);
  for (const d of docs) {
    seed.run(
      "INSERT OR REPLACE INTO reviews (workspace_id, slug, latest_version, created_at) VALUES (?, ?, ?, 1000)",
      [d.ws, d.slug, d.version],
    );
    seed.run(
      "INSERT OR REPLACE INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES (?, ?, ?, ?, 1000)",
      [d.ws, d.slug, d.version, JSON.stringify(d.doc)],
    );
  }
  seed.close();
}

if (SCENARIO === "v4backfill") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  // Two versions of one review: v1 names #4, v2 (the head) names #9. Only the head is
  // backfilled, or a delivery would push to a review that no longer names the pull
  // request.
  seedV4([
    { ws: "ws_seed", slug: "stack", version: 1, doc: { prs: [{ repo: "threahq/threa", number: 4 }] } },
    {
      ws: "ws_seed",
      slug: "stack",
      version: 2,
      doc: { prs: [{ repo: "ThreaHQ/Threa", number: 9 }, { repo: "threahq/other", number: 11 }] },
    },
  ]);

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  migrate();

  const rows = db
    .query("SELECT * FROM review_prs ORDER BY slug, pr_number")
    .all() as { workspace_id: string; slug: string; repo_id: number | null; pr_number: number; repo: string }[];
  const forStack = rows.filter((r) => r.slug === "stack");
  assert(forStack.length === 2, `head version's two prs backfilled, got ${forStack.length}`);
  assert(
    forStack.every((r) => r.repo_id === null),
    "backfilled rows carry no repo_id: the v4 document has no numeric repository id anywhere",
  );
  assert(
    !forStack.some((r) => r.pr_number === 4),
    "a pull request only an older version named is NOT backfilled",
  );
  // The golden review seeded by seedV3 is backfilled too, so the walk covers every review
  // rather than the ones this scenario happened to write.
  assert(rows.some((r) => r.slug === "golden" && r.pr_number === 1723), "every review is backfilled");

  // The rows are joinable the way a delivery joins them: case-insensitively on the name
  // while repo_id is null. Without this the backfill would look successful and match
  // nothing forever.
  const { matchReviewPrs } = await import("../src/overseer/installations");
  const matched = matchReviewPrs(55501, "threahq/threa", 9);
  assert(matched.length === 1 && matched[0]!.slug === "stack", `a delivery joins a backfilled row, got ${matched.length}`);
  const wrongNumber = matchReviewPrs(55501, "threahq/threa", 4);
  assert(wrongNumber.length === 0, "and does not join a pull request no review names");

  // The whole point of the backfill: an observation delivered for a backfilled review
  // has to land. A sentinel repo_id would have passed every assertion above and matched
  // nothing here, forever, while delivery health looked perfectly fine.
  const { observePullRequest, getPrStatus, listReviewPrs } = await import(
    "../src/overseer/installations"
  );
  db.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, " +
      "account_type, repository_selection, connected_by, connected_at, created_at) " +
      "VALUES ('ghi_seed0000', 'ws_seed', 77, 'threahq', 7, 'Organization', 'all', 'usr_seed', 1000, 1000)",
  );
  const applied = observePullRequest(77, {
    repoId: 55501,
    repo: "threahq/threa",
    prNumber: 9,
    state: "closed",
    merged: true,
    draft: false,
    headSha: "a".repeat(40),
    updatedAt: 2000,
  });
  assert(applied === 1, `the observation lands on the backfilled review, got ${applied}`);
  const status = getPrStatus("ws_seed", 55501, 9);
  assert(!!status && status.merged === 1, "and github_pr_status now holds the fact");
  const healed = listReviewPrs("ws_seed", "stack").find((r) => r.pr_number === 9)!;
  assert(healed.repo_id === 55501, `the transitional row heals to the numeric id, got ${healed.repo_id}`);

  // An installation nobody claimed writes nothing, whatever it delivers.
  db.run("UPDATE github_installations SET workspace_id = NULL WHERE installation_id = 77");
  const orphan = observePullRequest(77, {
    repoId: 55501,
    repo: "threahq/threa",
    prNumber: 11,
    state: "open",
    merged: false,
    draft: false,
    headSha: "b".repeat(40),
    updatedAt: 3000,
  });
  assert(orphan === 0, "an unclaimed installation belongs to no workspace, so it writes none");

  console.log("migrate v4backfill: all assertions passed");
  process.exit(0);
}

if (SCENARIO === "v4malformed") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  seedV4([{ ws: "ws_seed", slug: "broken", version: 3, doc: { title: "no prs here" } }]);

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    for (const part of ["ws_seed", "broken", "3"]) {
      assert(message.includes(part), `message names the exact row (${part}), got: ${message}`);
    }
  }
  assert(threw, "a malformed document aborts the migration rather than skipping it");

  // Aborted loudly means aborted wholly: still v4, and no half-written index.
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 4, `user_version stays 4 after the abort, got ${uv}`);
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_prs'")
    .get();
  assert(!table, "the transaction rolled back, so review_prs does not exist");

  console.log("migrate v4malformed: all assertions passed");
  process.exit(0);
}

// ---- a v5 database, freshness table and all: the drop is v6 ----
//
// v5 stopped writing `review_freshness` but left it standing, so a rollback to a v4
// image still found the table it reads. This is the release after: the table goes, and
// a database sitting at 5 has to walk up without losing anything else. The seed writes
// freshness rows precisely so the drop has something to drop — a scenario that seeds an
// absent table would pass against a migration that does nothing.
function seedV5() {
  seedV4([
    { ws: "ws_seed", slug: "stack", version: 1, doc: { prs: [{ repo: "threahq/threa", number: 9 }] } },
  ]);
  const seed = new Database(join(dataDir, "seer.db"), { create: true });
  // The v3 shape of the freshness table, verbatim, because that is what is on disk in
  // production. github_installations is seeded WITHOUT last_delivery_at: that column
  // arrives outside the version ladder, and a v5 database written before it exists is
  // the case ensureAdditiveColumns is for.
  seed.exec(`
    CREATE TABLE review_freshness (workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
      repo TEXT NOT NULL, pr_number INTEGER NOT NULL, observed_head_sha TEXT NOT NULL,
      checked_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, slug, repo, pr_number));
    CREATE TABLE github_installations (id TEXT PRIMARY KEY, workspace_id TEXT,
      installation_id INTEGER NOT NULL, account_login TEXT NOT NULL, account_id INTEGER NOT NULL,
      account_type TEXT NOT NULL, repository_selection TEXT NOT NULL, connected_by TEXT,
      connected_at INTEGER, created_at INTEGER NOT NULL, suspended_at INTEGER, removed_at INTEGER);
    CREATE TABLE github_pr_status (workspace_id TEXT NOT NULL, repo_id INTEGER,
      pr_number INTEGER NOT NULL, installation_id INTEGER NOT NULL, repo TEXT NOT NULL,
      state TEXT NOT NULL, merged INTEGER NOT NULL DEFAULT 0, draft INTEGER NOT NULL DEFAULT 0,
      head_sha TEXT NOT NULL, updated_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, repo_id, pr_number));
    CREATE TABLE review_prs (workspace_id TEXT NOT NULL, slug TEXT NOT NULL, repo_id INTEGER,
      pr_number INTEGER NOT NULL, repo TEXT NOT NULL,
      PRIMARY KEY (workspace_id, slug, repo_id, pr_number));
    CREATE TABLE github_deliveries (delivery_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE TABLE github_app_claims (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL, nonce_hash TEXT NOT NULL UNIQUE, attach_hash TEXT UNIQUE,
      proven_ids TEXT, github_login TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, attached_at INTEGER);
    PRAGMA user_version = 5;
  `);
  seed.run(
    "INSERT INTO review_freshness (workspace_id, slug, repo, pr_number, observed_head_sha, checked_at) " +
      "VALUES ('ws_seed', 'stack', 'threahq/threa', 9, ?, 1000)",
    ["c".repeat(40)],
  );
  seed.run(
    "INSERT INTO review_prs (workspace_id, slug, repo_id, pr_number, repo) " +
      "VALUES ('ws_seed', 'stack', NULL, 9, 'threahq/threa')",
  );
  seed.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, " +
      "account_type, repository_selection, connected_by, connected_at, created_at) " +
      "VALUES ('ghi_seed0000', 'ws_seed', 77, 'threahq', 7, 'Organization', 'all', 'usr_seed', 1000, 1000)",
  );
  seed.close();
}

// ---- the default boot of THIS release stops at v5 ----
//
// The drop is its own release (docs/overseer/github-app.md, "Why the drop is its own
// release"). An ordinary boot of this image must therefore leave `review_freshness`
// standing: the previous image calls listFreshness() on every review render and is
// still serving during the graceful-shutdown overlap, and a rollback to it must find a
// user_version it recognises.
if (SCENARIO === "v5stops") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  delete process.env.SEER_DROP_FRESHNESS;
  seedV5();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  migrate();

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `ordinary boot reaches 20, got ${uv}`);
  const still = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_freshness'")
    .get();
  assert(!!still, "review_freshness is still standing after an ordinary boot");
  const rows = db.query("SELECT * FROM review_freshness").all() as unknown[];
  assert(rows.length === 1, `and still readable, with its row: got ${rows.length}`);

  // A v4 database walks the same ladder and stops in the same place, with the table v3
  // creates present rather than created-and-dropped in one run.
  console.log("migrate v5stops: all assertions passed");
  process.exit(0);
}

// ---- the sequence a real operator produces: boot first, opt in afterwards ----
//
// This is the case that was missing, and its absence hid a real defect. The drop used
// to be a gated step inside the version ladder, so an ordinary boot walked past it to
// the next number and left its condition testing a version already exceeded. From then
// on nothing could drop the table: not the environment variable, not deleting the gate.
//
// Neither existing scenario could see it. One boots without the variable and stops;
// the other seeds a database that has never run this release and opts in immediately.
// Only booting twice, the way a person actually would, reaches it.
if (SCENARIO === "v5dropafterboot") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  delete process.env.SEER_DROP_FRESHNESS;
  seedV5();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  // Boot one: ordinary, no opt-in. The table stands, as the release intends.
  migrate();
  const first = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(first === 20, `ordinary boot reaches 20, got ${first}`);
  assert(
    !!db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_freshness'")
      .get(),
    "the table is still standing after an ordinary boot",
  );

  // Boot two: the operator opts in, exactly as the header promises they may.
  process.env.SEER_DROP_FRESHNESS = "1";
  migrate();

  assert(
    !db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_freshness'")
      .get(),
    "opting in AFTER an ordinary boot still drops the table",
  );
  // And it is recorded outside the version, which is what makes it reachable at all.
  const stamped = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get("freshness_dropped") as { value: string } | null;
  assert(!!stamped, "the drop is recorded in meta rather than in user_version");
  const after = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(after === 20, `and the version is untouched by it, got ${after}`);

  // Idempotent: a third boot with the variable still set does nothing and says nothing.
  migrate();
  console.log("migrate v5dropafterboot: all assertions passed");
  process.exit(0);
}
if (SCENARIO === "v5drop") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  // v6 is opt-in for one release. The scenario that asserts the drop has to ask for it.
  process.env.SEER_DROP_FRESHNESS = "1";
  seedV5();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  const before = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(before === 5, `seeded db starts at 5, got ${before}`);
  const seeded = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_freshness'")
    .get();
  assert(!!seeded, "the seeded v5 database really does carry the table v6 has to drop");

  migrate();

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `user_version should be 20, got ${uv}`);
  const dropped = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_freshness'")
    .get();
  assert(!dropped, "v6 dropped review_freshness");
  let queryFailed = false;
  try {
    db.query("SELECT * FROM review_freshness").all();
  } catch {
    queryFailed = true;
  }
  assert(queryFailed, "and nothing can read it any more");

  // The drop takes the freshness table and nothing else. The surviving recording of the
  // same fact is `review_prs` joined to `github_pr_status`, so the assertions that the
  // walk was clean are assertions that the survivor still answers.
  // Only the tables this seed actually wrote: v6 creates nothing, so a table the v5
  // seed never made would be missing for a reason that has nothing to do with the drop.
  for (const table of ["reviews", "review_versions", ...V4_TABLES, ...V5_TABLES, ...V6_TABLES]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} survives the v6 drop`);
  }
  const prCount = (db.query("SELECT COUNT(*) c FROM review_prs").get() as { c: number }).c;
  assert(prCount === 1, `the seeded review_prs row survives, got ${prCount}`);
  // Two: the golden review seedV3 writes, and the stack this scenario adds.
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 2, `the seeded reviews survive, got ${rCount}`);
  const uCount = (db.query("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  assert(uCount === 1, `the seeded user survives, got ${uCount}`);
  const cols = (db.query("PRAGMA table_info(github_installations)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert(cols.includes("last_delivery_at"), "the additive column still lands on a v5 database");

  // What the dropped table used to answer, answered by the pair that replaced it: an
  // observation lands on the review and the head sha is readable again.
  const { observePullRequest, getPrStatus } = await import("../src/overseer/installations");
  const applied = observePullRequest(77, {
    repoId: 55501,
    repo: "threahq/threa",
    prNumber: 9,
    state: "open",
    merged: false,
    draft: false,
    headSha: "d".repeat(40),
    updatedAt: 2000,
  });
  assert(applied === 1, `an observation still lands after the drop, got ${applied}`);
  const status = getPrStatus("ws_seed", 55501, 9);
  assert(!!status && status.head_sha === "d".repeat(40), "and the head sha is readable without the dropped table");

  // A second run is a no-op: still 6, nothing to re-drop.
  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 20, `user_version stays 20 after re-run, got ${uv2}`);

  console.log("migrate v5drop: all assertions passed");
  process.exit(0);
}

// ---- the ambiguous user_version 6, and the repair that heals it ----
//
// The previous image stamped 6 for two different shapes: one that created
// github_user_credentials, and one whose gated freshness drop reached 6 without it. A
// database stamped by the second is at a number the ladder will never revisit, so the
// table it lacks can only come back from a repair that runs outside the ladder. The seed
// emulates exactly that: walk a real database up, then take the user-credential tables
// away and put the stamp back to 6.
if (SCENARIO === "v6ambiguous") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  delete process.env.SEER_DROP_FRESHNESS;
  seedV5();

  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");

  migrate();
  db.exec(`
    DROP TABLE IF EXISTS github_user_credentials;
    DROP TABLE IF EXISTS github_user_oauth_claims;
    DROP TABLE IF EXISTS review_freshness;
    ${V20_TABLES.map((table) => `DROP TABLE ${table};`).join("\n")}
    PRAGMA user_version = 6;
  `);
  const stamped = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(stamped === 6, `the emulated database starts at 6, got ${stamped}`);
  const missing = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_user_credentials'")
    .get();
  assert(!missing, "and really is missing the table its stamp claims it has");

  migrate();

  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `user_version should be 20, got ${uv}`);
  for (const table of ["github_user_credentials", "github_user_oauth_claims"]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `${table} exists after the repair`);
  }

  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 20, `user_version stays 20 after re-run, got ${uv2}`);
  for (const table of ["github_user_credentials", "github_user_oauth_claims"]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `${table} survives the second run`);
  }

  console.log("migrate v6ambiguous: all assertions passed");
  process.exit(0);
}

if (SCENARIO === "v13") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  migrate();
  db.exec([...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " DROP TABLE stage_change_reads; PRAGMA user_version = 13;");
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ["sta_0000000000", "ws_0000000000", "migration-stage", "acme/repo", 1, "feature", "main", "a".repeat(40), "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ["stv_0000000000", "ws_0000000000", "sta_0000000000", "migration-stage", "stg_0000000000", "{}", "digest", "usr_0000000000", "key_0000000000", 1],
  );
  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `user_version should be 20, got ${uv}`);
  assert(!!db.query("SELECT 1 FROM stages WHERE slug = 'migration-stage'").get(), "the populated v13 stage survives");
  assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_change_reads'").get(), "the v14 read table exists");
  db.run("INSERT INTO stage_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "stv_0000000000", "usr_0000000000", "chg_" + "b".repeat(64), 2]);
  migrate();
  assert(!!db.query("SELECT 1 FROM stage_change_reads WHERE stage_version_id = 'stv_0000000000'").get(), "read state survives a no-op migration");
  console.log("migrate v13: all assertions passed");
  process.exit(0);
}

// The release this slice ships, and the rollback that goes with it.
//
// A populated v14 database carries everything the previous two slices could produce: a
// StageDoc V1 version over a capture, a legacy ReviewDoc with an attachment, a member's
// read marks, and Project joins to both. v15 is additive, so all of it has to come out
// the far side byte-for-byte while the six new tables start empty.
//
// The rollback half is the part that is easy to get wrong, and the ladder's own comment
// says so: the previous image refuses any user_version it does not know, so going back a
// release means restoring the database, never reversing DDL. This scenario does exactly
// that — a SQLite backup taken before the migration, the migration, then the backup put
// back and reopened by a reader that only understands v14.
if (SCENARIO === "v14") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");

  migrate();
  // Back down to the shape the previous image left behind, then populate it.
  db.exec([...V15_TABLES, ...V16_TABLES, ...V17_TABLES, ...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " PRAGMA user_version = 14;");

  const STAGE_DOC = JSON.stringify({
    identity: { id: "sta_0000000000", slug: "carried-stage", version: 1, title: "Carried stage", createdAt: "2026-01-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000000", repo: "acme/repo", repoId: 7, branch: "feature", baseRef: "main", sourceHeadSha: "a".repeat(40), baseTipSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) },
    builder: { intent: "Carry this forward.", context: "", agent: { name: "Builder", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    witness: { summary: "It reads.", groups: [], agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    projects: ["carried-project"],
  });
  const REVIEW_DOC = JSON.stringify({ id: "rev_0000000000", slug: "carried-review", version: 1, title: "Carried review", prs: [], attachments: [{ id: "att_0000000000", authoredId: "att_shot", mediaType: "image/png", bytes: 3, alt: "a", caption: "c" }] });

  db.run("INSERT INTO projects (id, workspace_id, slug, parent_id, title, description, status, created_at, updated_at) VALUES ('prj_0000000000', 'ws_0000000000', 'carried-project', NULL, 'Carried', '', 'open', 1, 1)");
  db.run("INSERT INTO stage_captures VALUES ('stg_0000000000', 'ws_0000000000', 'carried-stage', 'acme/repo', 7, 'feature', 'main', ?, ?, ?, NULL, 'completed', 1)", ["a".repeat(40), "b".repeat(40), "c".repeat(40)]);
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ["sta_0000000000", "ws_0000000000", "carried-stage", "acme/repo", 7, "feature", "main", "c".repeat(40), "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ["stv_0000000000", "ws_0000000000", "sta_0000000000", "carried-stage", "stg_0000000000", STAGE_DOC, "digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run("INSERT INTO stage_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "stv_0000000000", "usr_0000000000", "chg_" + "d".repeat(64), 2]);
  db.run("INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES ('ws_0000000000', 'carried-review', 1, 1)");
  db.run("INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES ('ws_0000000000', 'carried-review', 1, ?, 1)", [REVIEW_DOC]);
  db.run("INSERT INTO review_attachments VALUES ('att_0000000000', 'ws_0000000000', 'carried-review', 1, 'image/png', 3, 'a', 'c', 1)");
  db.run("INSERT INTO project_stages VALUES ('prj_0000000000', 'ws_0000000000', 'carried-stage', 1)");
  db.run("INSERT INTO project_reviews VALUES ('prj_0000000000', 'ws_0000000000', 'carried-review', 1)");

  // The backup, taken from the live connection before a single new statement runs. This
  // is the whole rollback plan; there is no reverse DDL anywhere in this repo.
  const backup = db.serialize();

  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `a populated v14 database reaches 20, got ${uv}`);

  const stageDoc = (db.query("SELECT doc FROM stage_versions WHERE id = 'stv_0000000000'").get() as { doc: string } | null)?.doc;
  assert(stageDoc === STAGE_DOC, "the StageDoc V1 JSON survives byte for byte");
  const reviewDoc = (db.query("SELECT doc FROM review_versions WHERE workspace_id = 'ws_0000000000' AND slug = 'carried-review' AND version = 1").get() as { doc: string } | null)?.doc;
  assert(reviewDoc === REVIEW_DOC, "the legacy ReviewDoc JSON survives byte for byte");
  assert(!!db.query("SELECT 1 FROM stage_change_reads WHERE stage_version_id = 'stv_0000000000'").get(), "the member's read marks survive");
  assert(!!db.query("SELECT 1 FROM review_attachments WHERE id = 'att_0000000000'").get(), "the review attachment survives");
  assert(!!db.query("SELECT 1 FROM project_stages WHERE project_id = 'prj_0000000000' AND slug = 'carried-stage'").get(), "the Project stage join survives");
  assert(!!db.query("SELECT 1 FROM project_reviews WHERE project_id = 'prj_0000000000' AND slug = 'carried-review'").get(), "the Project review join survives");
  for (const table of [...V15_TABLES, ...V16_TABLES, ...V17_TABLES]) {
    assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the migration`);
    const rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert(rows === 0, `${table} starts empty, got ${rows}`);
  }

  // What a rollback WITHOUT a restore would meet. A replica of the previous release's
  // guard rather than the previous release itself, which is not importable here; the
  // real guard's own shape is proved by the "newer" scenario, which stamps 20 and runs
  // this image's migrate() against it.
  const previousMaximumRefuses = (version: number) => version > 14;
  assert(previousMaximumRefuses(17), "the previous release's maximum refuses a v17 database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  const restoredVersion = (restored.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(restoredVersion === 14, `the restored backup is a v14 database, got ${restoredVersion}`);
  assert((restored.query("SELECT doc FROM stage_versions WHERE id = 'stv_0000000000'").get() as { doc: string }).doc === STAGE_DOC, "a v14 reader reopens the exact StageDoc");
  assert((restored.query("SELECT doc FROM review_versions WHERE slug = 'carried-review' AND version = 1").get() as { doc: string }).doc === REVIEW_DOC, "a v14 reader reopens the exact ReviewDoc");
  assert(!!restored.query("SELECT 1 FROM stage_change_reads WHERE stage_version_id = 'stv_0000000000'").get(), "a v14 reader reopens the read marks");
  for (const table of [...V15_TABLES, ...V16_TABLES, ...V17_TABLES]) {
    assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is gone after the restore`);
  }
  restored.close();

  console.log("migrate v14: all assertions passed");
  process.exit(0);
}

// The release THIS slice ships, and the rollback that goes with it.
//
// A populated v15 database carries everything the promoted-review slice could produce: a
// lineage with a V1 evidence revision over a real capture, an account published over it, a
// witness request that has already failed once and been retried, a member's per-revision
// read marks, a StageDoc V1 version, a legacy ReviewDoc, and Project joins to all three.
// v16 is additive, so every byte of that has to come out the far side unchanged while the
// six new tables start empty.
//
// The rollback half is the same one the ladder's own comment insists on: the previous
// image refuses any user_version it does not know, so going back a release is a database
// restore and never reverse DDL.
if (SCENARIO === "v15") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");

  migrate();
  db.exec([...V16_TABLES, ...V17_TABLES, ...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " PRAGMA user_version = 15;");

  const HEAD = "a".repeat(40), BASE_TIP = "b".repeat(40), MERGE = "c".repeat(40);
  const REVISION_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000000", slug: "carried-lineage", revision: 1, title: "Carried lineage", createdAt: "2026-02-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000000", repo: "acme/repo", repoId: 7, branch: "feature", originalBaseRef: "main", originalBaseSha: MERGE, baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: null,
    projects: ["carried-project"],
  });
  const ACCOUNT_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000000", slug: "carried-lineage", revision: 1, version: 1, createdAt: "2026-02-01T01:00:00.000Z" },
    witness: { summary: "It reads.", agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    groups: [], focus: [], evidence: [],
  });
  const STAGE_DOC = JSON.stringify({
    identity: { id: "sta_0000000000", slug: "carried-stage", version: 1, title: "Carried stage", createdAt: "2026-01-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000000", repo: "acme/repo", repoId: 7, branch: "feature", baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: { intent: "Carry this forward.", context: "", agent: { name: "Builder", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    witness: { summary: "It reads.", groups: [], agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    projects: ["carried-project"],
  });
  const REVIEW_DOC = JSON.stringify({ id: "rev_0000000000", slug: "carried-review", version: 1, title: "Carried review", prs: [], attachments: [] });

  db.run("INSERT INTO projects (id, workspace_id, slug, parent_id, title, description, status, created_at, updated_at) VALUES ('prj_0000000000', 'ws_0000000000', 'carried-project', NULL, 'Carried', '', 'open', 1, 1)");
  db.run("INSERT INTO stage_captures VALUES ('stg_0000000000', 'ws_0000000000', 'carried-stage', 'acme/repo', 7, 'feature', 'main', ?, ?, ?, NULL, 'completed', 1)", [HEAD, BASE_TIP, MERGE]);
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ["sta_0000000000", "ws_0000000000", "carried-stage", "acme/repo", 7, "feature", "main", MERGE, "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ["stv_0000000000", "ws_0000000000", "sta_0000000000", "carried-stage", "stg_0000000000", STAGE_DOC, "stage-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run("INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES ('ws_0000000000', 'carried-review', 1, 1)");
  db.run("INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES ('ws_0000000000', 'carried-review', 1, ?, 1)", [REVIEW_DOC]);
  db.run(
    "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
    ["rln_0000000000", "ws_0000000000", "carried-lineage", "acme/repo", 7, "feature", "main", MERGE, "Carried lineage", "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
    ["rvr_0000000000", "ws_0000000000", "rln_0000000000", "carried-lineage", "stg_0000000000", REVISION_DOC, "revision-digest", 1],
  );
  db.run(
    "INSERT INTO review_accounts (id, workspace_id, lineage_id, revision_id, revision, slug, version, schema_version, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?)",
    ["rac_0000000000", "ws_0000000000", "rln_0000000000", "rvr_0000000000", "carried-lineage", ACCOUNT_DOC, "account-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'published', 1, NULL, ?, ?, ?)",
    ["wtr_0000000000", "ws_0000000000", "rln_0000000000", "rvr_0000000000", "rac_0000000000", 1, 1],
  );
  db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "rvr_0000000000", "usr_0000000000", "chg_" + "d".repeat(64), 2]);
  db.run("INSERT INTO project_review_lineages VALUES ('prj_0000000000', 'ws_0000000000', 'carried-lineage', 1)");
  db.run("INSERT INTO project_stages VALUES ('prj_0000000000', 'ws_0000000000', 'carried-stage', 1)");
  db.run("INSERT INTO project_reviews VALUES ('prj_0000000000', 'ws_0000000000', 'carried-review', 1)");

  // The backup, taken before a single new statement runs. This is the whole rollback plan.
  const backup = db.serialize();

  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `a populated v15 database reaches 20, got ${uv}`);

  assert((db.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "the V1 evidence document survives byte for byte");
  assert((db.query("SELECT doc FROM review_accounts WHERE id = 'rac_0000000000'").get() as { doc: string }).doc === ACCOUNT_DOC, "the V1 account document survives byte for byte");
  assert((db.query("SELECT doc FROM stage_versions WHERE id = 'stv_0000000000'").get() as { doc: string }).doc === STAGE_DOC, "the StageDoc V1 JSON survives byte for byte");
  assert((db.query("SELECT doc FROM review_versions WHERE slug = 'carried-review' AND version = 1").get() as { doc: string }).doc === REVIEW_DOC, "the legacy ReviewDoc JSON survives byte for byte");
  const request = db.query("SELECT state, retry_count, account_id FROM review_witness_requests WHERE id = 'wtr_0000000000'").get() as { state: string; retry_count: number; account_id: string };
  assert(request.state === "published" && request.retry_count === 1 && request.account_id === "rac_0000000000", "the witness workflow row survives exactly");
  assert(!!db.query("SELECT 1 FROM review_revision_change_reads WHERE revision_id = 'rvr_0000000000'").get(), "the member's per-revision read marks survive");
  assert(!!db.query("SELECT 1 FROM project_review_lineages WHERE slug = 'carried-lineage'").get(), "the Project lineage join survives");
  assert(!!db.query("SELECT 1 FROM project_stages WHERE slug = 'carried-stage'").get(), "the Project stage join survives");
  assert(!!db.query("SELECT 1 FROM project_reviews WHERE slug = 'carried-review'").get(), "the Project review join survives");
  for (const table of [...V16_TABLES, ...V17_TABLES]) {
    assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the v16 and v17 migrations`);
    const rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert(rows === 0, `${table} starts empty, got ${rows}`);
  }
  // Re-running is a no-op: nothing is created twice and nothing populated is disturbed.
  migrate();
  assert((db.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "a second migrate() leaves the evidence document alone");

  const previousMaximumRefuses = (version: number) => version > 15;
  assert(previousMaximumRefuses(17), "the previous release's maximum refuses a v17 database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  const restoredVersion = (restored.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(restoredVersion === 15, `the restored backup is a v15 database, got ${restoredVersion}`);
  assert((restored.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "a v15 reader reopens the exact evidence document");
  assert((restored.query("SELECT doc FROM review_accounts WHERE id = 'rac_0000000000'").get() as { doc: string }).doc === ACCOUNT_DOC, "a v15 reader reopens the exact account document");
  assert(!!restored.query("SELECT 1 FROM review_revision_change_reads WHERE revision_id = 'rvr_0000000000'").get(), "a v15 reader reopens the read marks");
  for (const table of [...V16_TABLES, ...V17_TABLES]) {
    assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is gone after the restore`);
  }
  restored.close();

  console.log("migrate v15: all assertions passed");
  process.exit(0);
}

// The release THIS slice ships, and the rollback that goes with it.
//
// A populated v16 database carries everything the pull request slice could produce on top
// of the promoted review: a lineage with its relation, two immutable observations, a V1
// evidence revision over a real capture, an account published over it, an unpublished
// witness request, a member's per-revision reads, a capture job with its client
// idempotency row and its witness claim, a StageDoc V1, a legacy ReviewDoc, and Project
// joins to all three. v17 is additive, so every byte of that has to come out the far side
// unchanged while the two new tables start EMPTY — a carry is something the completion
// transaction writes, and a migration inventing one would be inventing a member's reading
// history.
if (SCENARIO === "v16") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");

  migrate();
  db.exec([...V17_TABLES, ...V18_TABLES, ...V19_TABLES, ...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " PRAGMA user_version = 16;");

  const HEAD = "a".repeat(40), BASE_TIP = "b".repeat(40), MERGE = "c".repeat(40), MOVED = "d".repeat(40);
  const REVISION_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000000", slug: "moved-lineage", revision: 1, title: "Moved lineage", createdAt: "2026-03-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000000", repo: "acme/repo", repoId: 7, branch: "feature", originalBaseRef: "main", originalBaseSha: MERGE, baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: null,
    projects: ["moved-project"],
  });
  const ACCOUNT_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000000", slug: "moved-lineage", revision: 1, version: 1, createdAt: "2026-03-01T01:00:00.000Z" },
    witness: { summary: "It reads.", agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    groups: [], focus: [], evidence: [],
  });
  const STAGE_DOC = JSON.stringify({
    identity: { id: "sta_0000000000", slug: "moved-stage", version: 1, title: "Moved stage", createdAt: "2026-01-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000000", repo: "acme/repo", repoId: 7, branch: "feature", baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: { intent: "Carry this forward.", context: "", agent: { name: "Builder", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    witness: { summary: "It reads.", groups: [], agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    projects: ["moved-project"],
  });
  const REVIEW_DOC = JSON.stringify({ id: "rev_0000000000", slug: "moved-review", version: 1, title: "Moved review", prs: [], attachments: [] });

  db.run("INSERT INTO projects (id, workspace_id, slug, parent_id, title, description, status, created_at, updated_at) VALUES ('prj_0000000000', 'ws_0000000000', 'moved-project', NULL, 'Moved', '', 'open', 1, 1)");
  db.run("INSERT INTO stage_captures VALUES ('stg_0000000000', 'ws_0000000000', 'moved-stage', 'acme/repo', 7, 'feature', 'main', ?, ?, ?, NULL, 'completed', 1)", [HEAD, BASE_TIP, MERGE]);
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ["sta_0000000000", "ws_0000000000", "moved-stage", "acme/repo", 7, "feature", "main", MERGE, "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ["stv_0000000000", "ws_0000000000", "sta_0000000000", "moved-stage", "stg_0000000000", STAGE_DOC, "stage-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run("INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES ('ws_0000000000', 'moved-review', 1, 1)");
  db.run("INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES ('ws_0000000000', 'moved-review', 1, ?, 1)", [REVIEW_DOC]);
  db.run(
    "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
    ["rln_0000000000", "ws_0000000000", "moved-lineage", "acme/repo", 7, "feature", "main", MERGE, "Moved lineage", "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
    ["rvr_0000000000", "ws_0000000000", "rln_0000000000", "moved-lineage", "stg_0000000000", REVISION_DOC, "revision-digest", 1],
  );
  db.run(
    "INSERT INTO review_accounts (id, workspace_id, lineage_id, revision_id, revision, slug, version, schema_version, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?)",
    ["rac_0000000000", "ws_0000000000", "rln_0000000000", "rvr_0000000000", "moved-lineage", ACCOUNT_DOC, "account-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending', 1, NULL, NULL, ?, ?)",
    ["wtr_0000000000", "ws_0000000000", "rln_0000000000", "rvr_0000000000", 1, 1],
  );
  db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "rvr_0000000000", "usr_0000000000", "chg_" + "d".repeat(64), 2]);
  db.run("INSERT INTO project_review_lineages VALUES ('prj_0000000000', 'ws_0000000000', 'moved-lineage', 1)");
  db.run("INSERT INTO project_stages VALUES ('prj_0000000000', 'ws_0000000000', 'moved-stage', 1)");
  db.run("INSERT INTO project_reviews VALUES ('prj_0000000000', 'ws_0000000000', 'moved-review', 1)");
  db.run(
    "INSERT INTO review_lineage_prs (lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, actor_kind, installation_id, user_id, credential_id, attached_at, detached_at) " +
      "VALUES ('rln_0000000000', 'ws_0000000000', 'moved-lineage', 7, 'acme/repo', 41, 'feature', 'main', 'installation', 900, NULL, NULL, 1, NULL)",
  );
  for (const [id, head, digest] of [["pob_0000000000", HEAD, "digest-one"], ["pob_0000000001", MOVED, "digest-two"]] as const) {
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
        "VALUES (?, 'ws_0000000000', 'rln_0000000000', 7, 'acme/repo', 41, 'Moved lineage', 'open', 0, 0, 'main', ?, 'feature', ?, ?, 1, 1, 'installation', 900, NULL, NULL, ?)",
      [id, BASE_TIP, head, head === HEAD ? MERGE : null, digest],
    );
  }
  db.run(
    "INSERT INTO review_revision_sources (revision_id, workspace_id, lineage_id, observation_id, base_tip_sha, source_head_sha, merge_base_sha, attached_at) " +
      "VALUES ('rvr_0000000000', 'ws_0000000000', 'rln_0000000000', 'pob_0000000000', ?, ?, ?, 1)",
    [BASE_TIP, HEAD, MERGE],
  );
  db.run(
    "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
      "VALUES ('rcj_0000000000', 'ws_0000000000', 'rln_0000000000', 'moved-lineage', 'pob_0000000000', 'completed', 'installation', 900, NULL, NULL, 'ws_0000000000/installation/900', 1, NULL, NULL, NULL, 'stg_0000000000', 'rvr_0000000000', 1, 1)",
  );
  db.run(
    "INSERT INTO review_pr_idempotency (workspace_id, idempotency_key, request_hash, operation, lineage_id, observation_id, capture_job_id, revision_id, created_at) " +
      "VALUES ('ws_0000000000', 'carried-key', 'carried-hash', 'create', 'rln_0000000000', 'pob_0000000000', 'rcj_0000000000', NULL, 1)",
  );
  db.run(
    "INSERT INTO review_witness_claims (request_id, retry_count, workspace_id, user_id, key_id, lease_token, lease_expires_at, claimed_at) " +
      "VALUES ('wtr_0000000000', 1, 'ws_0000000000', 'usr_0000000000', 'key_0000000000', 'wcl_0000000000', 9, 1)",
  );

  // The backup, taken before a single new statement runs. This is the whole rollback plan.
  const backup = db.serialize();

  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `a populated v16 database reaches 20, got ${uv}`);

  assert((db.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "the V1 evidence document survives byte for byte");
  assert((db.query("SELECT doc FROM review_accounts WHERE id = 'rac_0000000000'").get() as { doc: string }).doc === ACCOUNT_DOC, "the V1 account document survives byte for byte");
  assert((db.query("SELECT doc FROM stage_versions WHERE id = 'stv_0000000000'").get() as { doc: string }).doc === STAGE_DOC, "the StageDoc V1 JSON survives byte for byte");
  assert((db.query("SELECT doc FROM review_versions WHERE slug = 'moved-review' AND version = 1").get() as { doc: string }).doc === REVIEW_DOC, "the legacy ReviewDoc JSON survives byte for byte");
  const request = db.query("SELECT state, retry_count, account_id FROM review_witness_requests WHERE id = 'wtr_0000000000'").get() as { state: string; retry_count: number; account_id: string | null };
  assert(request.state === "pending" && request.retry_count === 1 && request.account_id === null, "the witness workflow row survives exactly");
  assert(!!db.query("SELECT 1 FROM review_revision_change_reads WHERE revision_id = 'rvr_0000000000'").get(), "the member's per-revision read marks survive");
  const observations = (db.query("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = 'rln_0000000000'").get() as { n: number }).n;
  assert(observations === 2, `both immutable observations survive, got ${observations}`);
  assert(!!db.query("SELECT 1 FROM review_capture_jobs WHERE id = 'rcj_0000000000' AND state = 'completed'").get(), "the completed capture job survives");
  assert(!!db.query("SELECT 1 FROM review_pr_idempotency WHERE idempotency_key = 'carried-key'").get(), "the client idempotency row survives");
  assert(!!db.query("SELECT 1 FROM review_witness_claims WHERE request_id = 'wtr_0000000000' AND retry_count = 1").get(), "the witness claim survives");
  assert(!!db.query("SELECT 1 FROM review_lineage_prs WHERE lineage_id = 'rln_0000000000' AND detached_at IS NULL").get(), "the pull request relation survives");
  assert(!!db.query("SELECT 1 FROM review_revision_sources WHERE revision_id = 'rvr_0000000000'").get(), "the source association survives");
  assert(!!db.query("SELECT 1 FROM project_review_lineages WHERE slug = 'moved-lineage'").get(), "the Project lineage join survives");

  // The v16 witness-request CHECK is deliberately NOT rebuilt: `superseded` is a join, and
  // a stored fourth state would be a word a previous image refuses the whole review over.
  const requestSchema = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_witness_requests'").get() as { sql: string }).sql;
  assert(/state IN \('pending','failed','published'\)/.test(requestSchema), `the witness-request CHECK was rewritten: ${requestSchema}`);

  for (const table of [...V17_TABLES, ...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) {
    assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the v17 through v19 migrations`);
    const rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert(rows === 0, `${table} starts empty, got ${rows}`);
  }
  // Re-running is a no-op: nothing is created twice and nothing populated is disturbed.
  migrate();
  assert((db.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "a second migrate() leaves the evidence document alone");

  const previousMaximumRefuses = (version: number) => version > 16;
  assert(previousMaximumRefuses(17), "the previous release's maximum refuses a v17 database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  const restoredVersion = (restored.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(restoredVersion === 16, `the restored backup is a v16 database, got ${restoredVersion}`);
  assert((restored.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000000'").get() as { doc: string }).doc === REVISION_DOC, "a v16 reader reopens the exact evidence document");
  assert((restored.query("SELECT doc FROM review_accounts WHERE id = 'rac_0000000000'").get() as { doc: string }).doc === ACCOUNT_DOC, "a v16 reader reopens the exact account document");
  assert(!!restored.query("SELECT 1 FROM review_pr_observations WHERE id = 'pob_0000000001'").get(), "a v16 reader reopens the webhook observation");
  for (const table of [...V17_TABLES, ...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) {
    assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is gone after the restore`);
  }
  restored.close();

  console.log("migrate v16: all assertions passed");
  process.exit(0);
}

// The release this follow-up ships: stored movement beside a populated v17 lineage, and
// a v17 image reopening the restored backup with nothing it does not recognise.
if (SCENARIO === "v17") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");

  migrate();
  db.exec([...V18_TABLES, ...V19_TABLES, ...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " PRAGMA user_version = 17;");
  db.run(
    "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, NULL, ?, ?, ?, ?)",
    ["rln_0000000017", "ws_0000000000", "carried-lineage", "acme/repo", 7, "feature", "main", "c".repeat(40), "Carried lineage", "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "rvr_0000000017", "usr_0000000000", "chg_" + "e".repeat(64), 2]);
  db.run(
    "INSERT INTO review_revision_read_carries (target_revision_id, user_id, target_change_id, workspace_id, lineage_id, source_revision_id, source_change_id, key_digest, carried_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["rvr_0000000018", "usr_0000000000", "chg_" + "f".repeat(64), "ws_0000000000", "rln_0000000017", "rvr_0000000017", "chg_" + "e".repeat(64), "d".repeat(64), 3],
  );
  const backup = db.serialize();

  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `a populated v17 database reaches 20, got ${uv}`);
  assert(!!db.query("SELECT 1 FROM review_lineages WHERE id = 'rln_0000000017' AND latest_revision = 2").get(), "the lineage survives");
  assert(!!db.query("SELECT 1 FROM review_revision_change_reads WHERE revision_id = 'rvr_0000000017'").get(), "the member's read survives");
  assert(!!db.query("SELECT 1 FROM review_revision_read_carries WHERE target_revision_id = 'rvr_0000000018'").get(), "the carry provenance survives");
  for (const table of [...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) {
    assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the v18 and v19 migrations`);
    const rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert(rows === 0, `${table} starts empty, got ${rows}`);
  }
  migrate();
  assert(!!db.query("SELECT 1 FROM review_revision_read_carries WHERE target_revision_id = 'rvr_0000000018'").get(), "a second migrate() leaves the carry alone");

  const previousMaximumRefuses = (version: number) => version > 17;
  assert(previousMaximumRefuses(18), "the previous release's maximum refuses a v18 database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  const restoredVersion = (restored.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(restoredVersion === 17, `the restored backup is a v17 database, got ${restoredVersion}`);
  assert(!!restored.query("SELECT 1 FROM review_revision_read_carries WHERE target_revision_id = 'rvr_0000000018'").get(), "a v17 reader reopens the carry provenance");
  for (const table of [...V18_TABLES, ...V19_TABLES, ...V20_TABLES]) {
    assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is gone after the restore`);
  }
  restored.close();

  console.log("migrate v17: all assertions passed");
  process.exit(0);
}

// The release this slice ships: the stack tables beside a populated v18 database — a legacy
// ReviewDoc, a StageDoc V1, a promoted lineage with revisions, accounts, reads, carries and
// supersessions, a pull request job, a Project — every prior row and document byte
// identical after the walk, every v19 table empty, and a v18 image reopening the restore.
if (SCENARIO === "v18") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");

  migrate();
  db.exec([...V19_TABLES, ...V20_TABLES].map((table) => `DROP TABLE ${table};`).join(" ") + " PRAGMA user_version = 18;");

  const HEAD = "a".repeat(40), BASE_TIP = "b".repeat(40), MERGE = "c".repeat(40), HEAD2 = "d".repeat(40);
  const REVISION_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000018", slug: "stacked-lineage", revision: 1, title: "Stacked lineage", createdAt: "2026-05-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000018", repo: "acme/repo", repoId: 7, branch: "feature", originalBaseRef: "main", originalBaseSha: MERGE, baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: null,
    projects: ["stacked-project"],
  });
  const REVISION_DOC_2 = REVISION_DOC.replace('"revision":1', '"revision":2').replace(HEAD, HEAD2).replace("stg_0000000018", "stg_0000000019");
  const ACCOUNT_DOC = JSON.stringify({
    identity: { lineageId: "rln_0000000018", slug: "stacked-lineage", revision: 1, version: 1, createdAt: "2026-05-01T01:00:00.000Z" },
    witness: { summary: "It reads.", agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    groups: [], focus: [], evidence: [],
  });
  const STAGE_DOC = JSON.stringify({
    identity: { id: "sta_0000000018", slug: "stacked-stage", version: 1, title: "Stacked stage", createdAt: "2026-01-01T00:00:00.000Z" },
    source: { captureId: "stg_0000000018", repo: "acme/repo", repoId: 7, branch: "feature", baseRef: "main", sourceHeadSha: HEAD, baseTipSha: BASE_TIP, mergeBaseSha: MERGE },
    builder: { intent: "Stack it.", context: "", agent: { name: "Builder", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    witness: { summary: "It reads.", groups: [], agent: { name: "Witness", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    projects: ["stacked-project"],
  });
  const REVIEW_DOC = JSON.stringify({ id: "rev_0000000018", slug: "stacked-review", version: 1, title: "Stacked review", prs: [], attachments: [] });

  db.run("INSERT INTO projects (id, workspace_id, slug, parent_id, title, description, status, created_at, updated_at) VALUES ('prj_0000000018', 'ws_0000000000', 'stacked-project', NULL, 'Stacked', '', 'open', 1, 1)");
  for (const [id, head] of [["stg_0000000018", HEAD], ["stg_0000000019", HEAD2]] as const) {
    db.run("INSERT INTO stage_captures VALUES (?, 'ws_0000000000', 'stacked-stage', 'acme/repo', 7, 'feature', 'main', ?, ?, ?, NULL, 'completed', 1)", [id, head, BASE_TIP, MERGE]);
  }
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ["sta_0000000018", "ws_0000000000", "stacked-stage", "acme/repo", 7, "feature", "main", MERGE, "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ["stv_0000000018", "ws_0000000000", "sta_0000000018", "stacked-stage", "stg_0000000018", STAGE_DOC, "stage-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run("INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES ('ws_0000000000', 'stacked-review', 1, 1)");
  db.run("INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES ('ws_0000000000', 'stacked-review', 1, ?, 1)", [REVIEW_DOC]);
  db.run(
    "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?, ?, ?, ?)",
    ["rln_0000000018", "ws_0000000000", "stacked-lineage", "acme/repo", 7, "feature", "main", MERGE, "Stacked lineage", "usr_0000000000", "key_0000000000", 1, 1],
  );
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
    ["rvr_0000000018", "ws_0000000000", "rln_0000000018", "stacked-lineage", "stg_0000000018", REVISION_DOC, "revision-digest", 1],
  );
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, 2, ?, 1, ?, ?, ?)",
    ["rvr_0000000019", "ws_0000000000", "rln_0000000018", "stacked-lineage", "stg_0000000019", REVISION_DOC_2, "revision-digest-2", 2],
  );
  db.run(
    "INSERT INTO review_accounts (id, workspace_id, lineage_id, revision_id, revision, slug, version, schema_version, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?)",
    ["rac_0000000018", "ws_0000000000", "rln_0000000018", "rvr_0000000018", "stacked-lineage", ACCOUNT_DOC, "account-digest", "usr_0000000000", "key_0000000000", 1],
  );
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'published', 0, NULL, 'rac_0000000018', ?, ?)",
    ["wtr_0000000018", "ws_0000000000", "rln_0000000018", "rvr_0000000018", 1, 1],
  );
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 'pending', 0, NULL, NULL, ?, ?)",
    ["wtr_0000000019", "ws_0000000000", "rln_0000000018", "rvr_0000000019", 2, 2],
  );
  db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "rvr_0000000018", "usr_0000000000", "chg_" + "e".repeat(64), 2]);
  db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", ["ws_0000000000", "rvr_0000000019", "usr_0000000000", "chg_" + "f".repeat(64), 3]);
  db.run(
    "INSERT INTO review_revision_read_carries (target_revision_id, user_id, target_change_id, workspace_id, lineage_id, source_revision_id, source_change_id, key_digest, carried_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["rvr_0000000019", "usr_0000000000", "chg_" + "f".repeat(64), "ws_0000000000", "rln_0000000018", "rvr_0000000018", "chg_" + "e".repeat(64), "d".repeat(64), 3],
  );
  db.run("INSERT INTO review_revision_movements VALUES (?, ?, ?, ?, 1, 0, 0, 0, 3)", ["rvr_0000000019", "ws_0000000000", "rln_0000000018", "rvr_0000000018"]);
  db.run("INSERT INTO review_revision_equivalences VALUES (?, ?, ?, ?, ?, ?, ?)", ["rvr_0000000019", "chg_" + "f".repeat(64), "ws_0000000000", "rln_0000000018", "rvr_0000000018", "chg_" + "e".repeat(64), "d".repeat(64)]);
  db.run("INSERT INTO review_revision_read_boundaries VALUES (?, ?, ?, ?, 3)", ["rvr_0000000019", "usr_0000000000", "chg_" + "f".repeat(64), "ws_0000000000"]);
  db.run("INSERT INTO project_review_lineages VALUES ('prj_0000000018', 'ws_0000000000', 'stacked-lineage', 1)");
  db.run("INSERT INTO project_stages VALUES ('prj_0000000018', 'ws_0000000000', 'stacked-stage', 1)");
  db.run("INSERT INTO project_reviews VALUES ('prj_0000000018', 'ws_0000000000', 'stacked-review', 1)");
  db.run(
    "INSERT INTO review_lineage_prs (lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, actor_kind, installation_id, user_id, credential_id, attached_at, detached_at) " +
      "VALUES ('rln_0000000018', 'ws_0000000000', 'stacked-lineage', 7, 'acme/repo', 51, 'feature', 'main', 'installation', 900, NULL, NULL, 1, NULL)",
  );
  db.run(
    "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
      "VALUES ('pob_0000000018', 'ws_0000000000', 'rln_0000000018', 7, 'acme/repo', 51, 'Stacked lineage', 'open', 0, 0, 'main', ?, 'feature', ?, ?, 1, 1, 'installation', 900, NULL, NULL, 'digest-stacked')",
    [BASE_TIP, HEAD, MERGE],
  );
  db.run(
    "INSERT INTO review_revision_sources (revision_id, workspace_id, lineage_id, observation_id, base_tip_sha, source_head_sha, merge_base_sha, attached_at) VALUES ('rvr_0000000018', 'ws_0000000000', 'rln_0000000018', 'pob_0000000018', ?, ?, ?, 1)",
    [BASE_TIP, HEAD, MERGE],
  );
  db.run(
    "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
      "VALUES ('rcj_0000000018', 'ws_0000000000', 'rln_0000000018', 'stacked-lineage', 'pob_0000000018', 'completed', 'installation', 900, NULL, NULL, 'ws_0000000000/installation/900', 1, NULL, NULL, NULL, 'stg_0000000018', 'rvr_0000000018', 1, 1)",
  );
  db.run(
    "INSERT INTO review_witness_supersessions (request_id, workspace_id, lineage_id, superseded_revision_id, successor_revision_id, created_at) VALUES ('wtr_0000000019', 'ws_0000000000', 'rln_0000000018', 'rvr_0000000019', 'rvr_0000000019', 4)",
  );

  const before = new Map<string, unknown[]>();
  const populated = ["reviews", "review_versions", "stages", "stage_versions", "stage_captures", "review_lineages", "review_revisions", "review_accounts", "review_witness_requests", "review_revision_change_reads", "review_revision_read_carries", "review_revision_movements", "review_revision_equivalences", "review_revision_read_boundaries", "project_review_lineages", "project_stages", "project_reviews", "review_lineage_prs", "review_pr_observations", "review_revision_sources", "review_capture_jobs", "review_witness_supersessions", "projects"];
  for (const table of populated) before.set(table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const backup = db.serialize();

  migrate();
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 20, `a populated v18 database reaches 20, got ${uv}`);
  for (const table of populated) {
    const after = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
    assert(JSON.stringify(after) === JSON.stringify(before.get(table)), `every ${table} row survives byte for byte`);
  }
  assert((db.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000018'").get() as { doc: string }).doc === REVISION_DOC, "the V1 evidence document survives byte for byte");
  assert((db.query("SELECT doc FROM review_accounts WHERE id = 'rac_0000000018'").get() as { doc: string }).doc === ACCOUNT_DOC, "the V1 account document survives byte for byte");
  assert((db.query("SELECT doc FROM stage_versions WHERE id = 'stv_0000000018'").get() as { doc: string }).doc === STAGE_DOC, "the StageDoc V1 JSON survives byte for byte");
  assert((db.query("SELECT doc FROM review_versions WHERE slug = 'stacked-review' AND version = 1").get() as { doc: string }).doc === REVIEW_DOC, "the legacy ReviewDoc JSON survives byte for byte");
  for (const table of V19_TABLES) {
    assert(!!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists after the v19 migration`);
    const rows = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert(rows === 0, `${table} starts empty, got ${rows}`);
  }
  const observationIndex = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_stack_pr_observations_pr'",
  ).get();
  assert(observationIndex?.sql.includes("workspace_id, repo_id, pr_number, observed_at") === true, "stack observation lookup index starts with workspace identity");
  const stackObservationColumns = (db.query("PRAGMA table_info(review_stack_pr_observations)").all() as { name: string }[]).map((row) => row.name);
  assert(stackObservationColumns.includes("id"), "stack observations have their own identity");
  assert(stackObservationColumns.includes("receipt_id"), "stack observations retain the accepted receipt identity");
  assert(stackObservationColumns.includes("pull_request_observation_id"), "stack observations link to a complete promoted observation when one exists");
  assert(!stackObservationColumns.includes("observation_id"), "a promoted observation is no longer the stack observation primary key");
  const stackJobColumns = (db.query("PRAGMA table_info(review_stack_refresh_jobs)").all() as { name: string }[]).map((row) => row.name);
  assert(stackJobColumns.includes("stack_observation_id") && stackJobColumns.includes("pull_request_observation_id"), "stack jobs name their webhook and sweep triggers separately");
  migrate();
  for (const table of populated) {
    const after = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
    assert(JSON.stringify(after) === JSON.stringify(before.get(table)), `a second migrate() leaves ${table} alone`);
  }

  const previousMaximumRefuses = (version: number) => version > 18;
  assert(previousMaximumRefuses(19), "the previous release's maximum refuses a v19 database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  const restoredVersion = (restored.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(restoredVersion === 18, `the restored backup is a v18 database, got ${restoredVersion}`);
  assert((restored.query("SELECT doc FROM review_revisions WHERE id = 'rvr_0000000019'").get() as { doc: string }).doc === REVISION_DOC_2, "a v18 reader reopens the exact second revision");
  assert(!!restored.query("SELECT 1 FROM review_revision_movements WHERE revision_id = 'rvr_0000000019'").get(), "a v18 reader reopens the stored movement");
  for (const table of V19_TABLES) {
    assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is gone after the restore`);
  }
  restored.close();

  console.log("migrate v18: all assertions passed");
  process.exit(0);
}

// The v20 shares rebuild: legacy link identity is copied byte for byte, the new copied
// authority starts empty, old queries keep working during image overlap, and rollback is
// the serialized v19 database rather than an old image over the new shape.
if (SCENARIO === "v19") {
  const { Database: Sqlite } = await import("bun:sqlite");
  const { rmSync, writeFileSync: writeBackup } = await import("node:fs");
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { assertDatabaseVersionSupported, migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  const { createHash } = await import("node:crypto");
  const { strToU8, unzipSync, zipSync } = await import("fflate");
  migrate();
  db.exec(`
    DROP TABLE share_capability_attachments;
    DROP TABLE share_capability_items;
    DROP TABLE share_capability_files;
    DROP TABLE share_document_capabilities;
    ALTER TABLE shares RENAME TO shares_v20;
    CREATE TABLE shares (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('review','bundle')),
      target TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER, revoked_at INTEGER
    );
    INSERT INTO shares SELECT * FROM shares_v20;
    DROP TABLE shares_v20;
    CREATE INDEX idx_shares_workspace ON shares (workspace_id);
    PRAGMA user_version = 19;
  `);
  const token = (suffix: string) => `seer_sh_${suffix.padEnd(32, "a")}`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const now = Date.now();
  const seeded = [
    ["shr_0000000101", "review", "legacy-review", "live review", token("live-review"), null, null],
    ["shr_0000000102", "review", "revoked-review", "revoked review", token("revoked"), null, now - 10],
    ["shr_0000000103", "review", "expired-review", "expired review", token("expired"), now - 10, null],
    ["shr_0000000104", "bundle", "private-bundle", "live bundle", token("bundle"), null, null],
  ] as const;
  for (const [id, kind, target, label, raw, expires, revoked] of seeded) {
    db.run(
      "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at, expires_at, revoked_at) VALUES (?, 'ws_0000000000', ?, ?, ?, ?, 'usr_0000000000', 1234, ?, ?)",
      [id, kind, target, label, hash(raw), expires, revoked],
    );
  }
  const bundleBytes = zipSync({ "index.html": strToU8("<!doctype html><body>restored v19 bundle</body>") });
  const bundleObject = join(dataDir, "zips", "ws_0000000000", "private-bundle", "1.zip");
  mkdirSync(join(dataDir, "zips", "ws_0000000000", "private-bundle"), { recursive: true });
  writeFileSync(bundleObject, bundleBytes);
  db.run("INSERT INTO bundles (workspace_id, slug, created_at, latest_version, kind) VALUES ('ws_0000000000', 'private-bundle', 1234, 1, 'bundle')");
  db.run("INSERT INTO versions (workspace_id, slug, version, created_at, bytes, file_count) VALUES ('ws_0000000000', 'private-bundle', 1, 1234, ?, 1)", [bundleBytes.length]);
  const docs = {
    legacy: '{"schema":"legacy-review-v1","bytes":"unchanged"}',
    stage: '{"schema":"stage-v1","bytes":"unchanged"}',
    revision: '{"schema":"revision-v1","bytes":"unchanged"}',
    account: '{"schema":"account-v1","bytes":"unchanged"}',
    manifest: '{"schema":"stack-manifest-v1","bytes":"unchanged"}',
    stackAccount: '{"schema":"stack-account-v1","bytes":"unchanged"}',
  };
  db.run("INSERT INTO review_versions VALUES ('ws_0000000000', 'legacy-v19', 1, ?, 1)", [docs.legacy]);
  db.run("INSERT INTO stage_versions VALUES ('stv_0000000200', 'ws_0000000000', 'sta_0000000200', 'stage-v19', 1, 'stg_0000000200', ?, 'stage-digest', 'usr_0000000000', 'key_0000000000', 1)", [docs.stage]);
  db.run("INSERT INTO review_revisions VALUES ('rvr_0000000200', 'ws_0000000000', 'rln_0000000200', 'review-v19', 1, 'stg_0000000201', 1, ?, 'revision-digest', 1)", [docs.revision]);
  db.run("INSERT INTO review_accounts VALUES ('rac_0000000200', 'ws_0000000000', 'rln_0000000200', 'rvr_0000000200', 1, 'review-v19', 1, 1, ?, 'account-digest', 'usr_0000000000', 'key_0000000000', 1)", [docs.account]);
  db.run("INSERT INTO review_stack_manifests VALUES ('rsm_0000000200', 'rsk_0000000200', 'ws_0000000000', 'stack-v19', 1, 0, 'created', 1, ?, 'manifest-digest', 1)", [docs.manifest]);
  db.run("INSERT INTO review_stack_accounts VALUES ('rsa_0000000200', 'rsk_0000000200', 'rsm_0000000200', 'ws_0000000000', 'stack-v19', 1, 1, ?, 'stack-account-digest', 'usr_0000000000', 'key_0000000000', 1)", [docs.stackAccount]);
  db.run("INSERT INTO review_revision_change_reads VALUES ('ws_0000000000', 'rvr_0000000200', 'usr_0000000000', ?, 1)", [`chg_${"a".repeat(64)}`]);
  db.run("INSERT INTO review_stack_members VALUES ('rsk_0000000200', 'rln_0000000200', 'ws_0000000000', 'review-v19', 7, 20, 'rsm_0000000200', NULL, NULL, NULL)");
  const documentBefore = new Map([
    ["review_versions", db.query("SELECT doc FROM review_versions WHERE slug = 'legacy-v19'").get()],
    ["stage_versions", db.query("SELECT doc, digest FROM stage_versions WHERE id = 'stv_0000000200'").get()],
    ["review_revisions", db.query("SELECT doc, digest FROM review_revisions WHERE id = 'rvr_0000000200'").get()],
    ["review_accounts", db.query("SELECT doc, digest FROM review_accounts WHERE id = 'rac_0000000200'").get()],
    ["review_stack_manifests", db.query("SELECT doc, digest FROM review_stack_manifests WHERE id = 'rsm_0000000200'").get()],
    ["review_stack_accounts", db.query("SELECT doc, digest FROM review_stack_accounts WHERE id = 'rsa_0000000200'").get()],
  ]);
  const before = db.query("SELECT * FROM shares ORDER BY id").all();
  const backup = db.serialize();
  const bundleBackup = new Uint8Array(readFileSync(bundleObject));

  migrate();
  assert((db.query("PRAGMA user_version").get() as { user_version: number }).user_version === 20, "v19 reaches v20");
  assert(JSON.stringify(db.query("SELECT * FROM shares ORDER BY id").all()) === JSON.stringify(before), "every legacy share column survives exactly");
  for (const [id, , , , raw] of seeded) {
    const row = db.query<{ token_hash: string }, [string]>("SELECT token_hash FROM shares WHERE id = ?").get(id)!;
    assert(row.token_hash === hash(raw), `${id} keeps the exact token hash`);
  }
  const { lookupShare, resolveShare } = await import("../src/shares");
  assert(resolveShare(seeded[0]![4])?.id === seeded[0]![0], "the live review token still resolves");
  assert(resolveShare(seeded[3]![4])?.id === seeded[3]![0], "the live bundle token still resolves");
  const liveEntry = unzipSync(new Uint8Array(readFileSync(bundleObject)))["index.html"];
  assert(!!liveEntry && new TextDecoder().decode(liveEntry).includes("restored v19 bundle"), "the live bundle's referenced byte store survives migration");
  assert(resolveShare(seeded[1]![4]) === null && lookupShare(seeded[1]![4])?.id === seeded[1]![0], "the revoked token remains dead but auditable");
  assert(resolveShare(seeded[2]![4]) === null && lookupShare(seeded[2]![4])?.id === seeded[2]![0], "the expired token remains dead but auditable");
  for (const [table, row] of documentBefore) {
    const id = table === "review_versions" ? "slug = 'legacy-v19'" : table === "stage_versions" ? "id = 'stv_0000000200'" : table === "review_revisions" ? "id = 'rvr_0000000200'" : table === "review_accounts" ? "id = 'rac_0000000200'" : table === "review_stack_manifests" ? "id = 'rsm_0000000200'" : "id = 'rsa_0000000200'";
    assert(JSON.stringify(db.query(`SELECT doc${table === "review_versions" ? "" : ", digest"} FROM ${table} WHERE ${id}`).get()) === JSON.stringify(row), `${table} document bytes and digest survive`);
  }
  assert(!!db.query("SELECT 1 FROM review_revision_change_reads WHERE revision_id = 'rvr_0000000200'").get(), "revision read state survives");
  assert(!!db.query("SELECT 1 FROM review_stack_members WHERE stack_id = 'rsk_0000000200'").get(), "stack state survives");
  for (const table of V20_TABLES) {
    assert((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === 0, `${table} starts empty`);
  }
  for (const kind of ["review", "bundle", "review_document", "stack_document"]) {
    db.run("INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) VALUES (?, 'ws_0000000000', ?, 'target', '', ?, 'usr_0000000000', 1)", [`shr_${kind.padEnd(10, "0").slice(0, 10)}`, kind, hash(`kind-${kind}`)]);
  }
  let fifthRefused = false;
  try {
    db.run("INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) VALUES ('shr_0000000999', 'ws_0000000000', 'other', 'x', '', 'other-hash', 'usr_0000000000', 1)");
  } catch { fifthRefused = true; }
  assert(fifthRefused, "the rebuilt CHECK refuses a fifth share kind");
  // The exact v19 query and insert column list still run against v20.
  assert((db.query("SELECT id, workspace_id, kind, target, label, created_by, created_at, expires_at, revoked_at FROM shares WHERE workspace_id = ?").all("ws_0000000000") as unknown[]).length >= seeded.length, "the v19 SELECT still runs");
  db.run("INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) VALUES ('shr_0000000998', 'ws_0000000000', 'review', 'overlap', '', 'overlap-hash', 'usr_0000000000', 1)");
  let v19Refused = false;
  try {
    assertDatabaseVersionSupported(19);
  } catch (err) {
    v19Refused = true;
    const message = (err as Error).message;
    assert(/user_version 20/.test(message) && /0 through 19/.test(message), `the v19 refusal names the version and range, got: ${message}`);
  }
  assert(v19Refused, "a binary capped at v19 refuses the migrated database");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `seer.db${suffix}`), { force: true });
  rmSync(bundleObject, { force: true });
  writeBackup(join(dataDir, "seer.db"), backup);
  mkdirSync(join(dataDir, "zips", "ws_0000000000", "private-bundle"), { recursive: true });
  writeBackup(bundleObject, bundleBackup);
  const restored = new Sqlite(join(dataDir, "seer.db"), { readonly: true });
  assert((restored.query("PRAGMA user_version").get() as { user_version: number }).user_version === 19, "the restored database reopens at v19");
  assert(JSON.stringify(restored.query("SELECT * FROM shares ORDER BY id").all()) === JSON.stringify(before), "restore recovers every old link row");
  assert(!!restored.query("SELECT 1 FROM bundles WHERE workspace_id = 'ws_0000000000' AND slug = 'private-bundle' AND latest_version = 1").get(), "restore recovers the bundle row named by the old link");
  assert(!!restored.query("SELECT 1 FROM versions WHERE workspace_id = 'ws_0000000000' AND slug = 'private-bundle' AND version = 1").get(), "restore recovers the bundle version row");
  const restoredEntry = unzipSync(new Uint8Array(readFileSync(bundleObject)))["index.html"];
  assert(!!restoredEntry && new TextDecoder().decode(restoredEntry).includes("restored v19 bundle"), "restore recovers the referenced bundle bytes beside SQLite");
  for (const table of V20_TABLES) assert(restored.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null, `${table} is absent after restore`);
  restored.close();
  console.log("migrate v19: all assertions passed");
  process.exit(0);
}

// A database from a FUTURE release. The old image must refuse rather than walk it, and
// the refusal has to name the range it understands: an image that quietly served a
// schema it does not know is the failure this guard exists to prevent.
if (SCENARIO === "newer") {
  process.env.AUTH_DISABLED = "true";
  delete process.env.ALLOWED_EMAILS;
  const { migrate } = await import("../src/migrate");
  const { db } = await import("../src/db");
  migrate();
  db.exec("PRAGMA user_version = 21;");
  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    assert(/user_version 21/.test(message) && /0 through 20/.test(message), `the refusal names the version and the range, got: ${message}`);
  }
  assert(threw, "a user_version above the ladder's top must be refused");
  const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv === 21, `the refused database is left untouched, got ${uv}`);
  console.log("migrate newer: all assertions passed");
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
