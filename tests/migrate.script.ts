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

const V4_TABLES = ["shares"];

const V5_TABLES = [
  "github_installations",
  "github_pr_status",
  "review_prs",
  "github_deliveries",
  "github_app_claims",
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
  assert(uv === 5, `user_version should be 5, got ${uv}`);

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
  assert(uv === 5, `user_version should be 5, got ${uv}`);
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
  for (const table of [...V3_TABLES, ...V4_TABLES, ...V5_TABLES]) {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert(!!row, `table ${table} exists on a fresh db`);
  }
  const shCount = (db.query("SELECT COUNT(*) c FROM shares").get() as { c: number }).c;
  assert(shCount === 0, `fresh db has an empty shares table, got ${shCount}`);

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
  assert(uv === 5, `user_version should be 5, got ${uv}`);

  for (const table of [...V3_TABLES, ...V4_TABLES, ...V5_TABLES]) {
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
  assert(uv2 === 5, `user_version stays 5 after re-run, got ${uv2}`);
  const bCount2 = (db.query("SELECT COUNT(*) c FROM bundles").get() as { c: number }).c;
  assert(bCount2 === 1, `no duplicate bundles after re-run, got ${bCount2}`);
  const rCount = (db.query("SELECT COUNT(*) c FROM reviews").get() as { c: number }).c;
  assert(rCount === 0, `reviews table starts empty, got ${rCount}`);

  // A database from a newer binary is refused rather than half-read.
  db.run("PRAGMA user_version = 6");
  let threw = false;
  try {
    migrate();
  } catch (err) {
    threw = true;
    assert(/user_version 6/.test((err as Error).message), `actionable message, got: ${(err as Error).message}`);
  }
  assert(threw, "migrate must throw on a user_version newer than it knows");
  db.run("PRAGMA user_version = 5");

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
  assert(uv === 5, `user_version should be 5, got ${uv}`);
  for (const table of [...V4_TABLES, ...V5_TABLES]) {
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
  assert(uv2 === 5, `user_version stays 5 after re-run, got ${uv2}`);
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
