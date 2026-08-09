// Runs in its OWN process (spawned by migrate.test.ts). The db/config singletons
// bind to one DATA_DIR per process, so each migration scenario needs a fresh process.
// SCENARIO selects what to seed and assert. Exits 0 on success, 1 on the first
// failed assertion (message on stderr).
import "./app-env";
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
  assert(uv === 7, `user_version should be 7, got ${uv}`);

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
  assert(uv === 7, `user_version should be 7, got ${uv}`);
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
  for (const table of [...V3_TABLES, ...V4_TABLES, ...V5_TABLES, ...V6_TABLES]) {
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
  assert(uv === 7, `user_version should be 7, got ${uv}`);

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
  assert(uv2 === 7, `user_version stays 7 after re-run, got ${uv2}`);
  const bCount2 = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount2 === 1, `no duplicate bundles after re-run, got ${bCount2}`);
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 0, `reviews table starts empty, got ${rCount}`);

  // A database from a newer binary is refused rather than half-read.
  db.run("PRAGMA user_version = 8");
  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    assert(/user_version 8/.test((err as Error).message), `actionable message, got: ${(err as Error).message}`);
  }
  assert(threw, "migrate must throw on a user_version newer than it knows");
  db.run("PRAGMA user_version = 6");

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
  assert(uv === 7, `user_version should be 7, got ${uv}`);
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
  assert(uv2 === 7, `user_version stays 7 after re-run, got ${uv2}`);
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
  assert(uv === 7, `ordinary boot reaches 7, got ${uv}`);
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
  assert(first === 7, `ordinary boot reaches 7, got ${first}`);
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
  assert(after === 7, `and the version is untouched by it, got ${after}`);

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
  assert(uv === 7, `user_version should be 7, got ${uv}`);
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
  assert(uv2 === 7, `user_version stays 7 after re-run, got ${uv2}`);

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
  assert(uv === 7, `user_version should be 7, got ${uv}`);
  for (const table of ["github_user_credentials", "github_user_oauth_claims"]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `${table} exists after the repair`);
  }

  migrate();
  const uv2 = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert(uv2 === 7, `user_version stays 7 after re-run, got ${uv2}`);
  for (const table of ["github_user_credentials", "github_user_oauth_claims"]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `${table} survives the second run`);
  }

  console.log("migrate v6ambiguous: all assertions passed");
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
