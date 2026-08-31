// Runs in its OWN process (spawned by context.test.ts) with AUTH_DISABLED unset, so
// sessionUser resolves real forged cookies instead of short-circuiting to the root
// user. That is the only way to ask the context route the questions that matter about
// a route that serves whole files of private source: what a signed-out browser gets,
// and what a signed-in stranger gets.
//
// The refusals are checked beside the read they withhold. A route that answered 404 to
// everybody would pass every assertion below about privacy and be worth nothing, so the
// member's own read is asserted in the same script, with the file's bytes in it.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import "../app-env";
import { createTestDataDir } from "../test-data-dir";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "root@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = createTestDataDir("seer-tests-context-privacy-");

// This process does not get bunfig's test preload, so it installs its own seams. The
// GitHub client here is not the offline one: this route's whole job is to serve a
// file, and a script that could not serve one could not show that it withholds one.
const { setGithubClientFactory } = await import("../../src/overseer/github-app");
const { setGithubOAuth } = await import("../../src/overseer/github-oauth");
const { offlineGithubClient, offlineGithubOAuth } = await import("../offline-github");
const { GithubError } = await import("../../src/overseer/github");
const { GOLDEN_HEAD_SHA_12 } = await import("./fixtures/golden-review");

const { GOLDEN_REF_LINES, GOLDEN_REF_START } = await import("./fixtures/stored-review");

const SECRET_LINE = "  const apiKey = process.env.SEER_SECRET;";
const FILE = (() => {
  const lines: string[] = [];
  for (let n = 1; n <= 120; n++) lines.push(SECRET_LINE);
  GOLDEN_REF_LINES.forEach((line, i) => { lines[GOLDEN_REF_START - 1 + i] = line; });
  return lines.join("\n") + "\n";
})();

setGithubClientFactory(() => ({
  ...offlineGithubClient(),
  async getFileAtSha(_repo: string, path: string, sha: string) {
    if (path === "src/auth.ts" && sha === GOLDEN_HEAD_SHA_12) return FILE;
    throw new GithubError("Not Found", 404, "https://api.github.com/x");
  },
}));
setGithubOAuth(offlineGithubOAuth());

const { sessionCookie } = await import("../../src/auth");
const { db } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { storeGoldenReview } = await import("./fixtures/stored-review");
const { createShare } = await import("../../src/shares");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

const server = await startServer();
const base = `http://localhost:${server.port}`;
const now = Date.now();

function seedUser(email: string): string {
  const id = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [id, email, now]);
  return id;
}

const ws = tinyId("ws");
db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)", [
  ws,
  "Alpha",
  now,
]);
const member = seedUser("member@example.com");
const stranger = seedUser("stranger@example.com");
db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
  ws,
  member,
  now,
]);
storeGoldenReview(ws, "golden");

function cookie(userId: string): Record<string, string> {
  return { cookie: sessionCookie(userId).split(";")[0]! };
}

/** Status, content type and body, so "the same 404" means the same response and not
 *  merely the same status line. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

const AUTH = "path=src%2Fauth.ts&sha=" + GOLDEN_HEAD_SHA_12 + "&from=1&to=20";
const url = (slug: string) => `${base}/${ws}/r/${slug}/c?${AUTH}`;

const missing = await shape(await fetch(url("no-such-review")));
assert(missing.startsWith("404\n"), `unknown slug should 404, got ${missing.split("\n")[0]}`);

// ---- the member reads, and what they read is the file ----
{
  const res = await fetch(url("golden"), { headers: cookie(member) });
  assert(res.status === 200, `member read should 200, got ${res.status}`);
  const body = (await res.json()) as { total: number; lines: string[] };
  assert(body.total === 120, `member read should see the whole file's length, got ${body.total}`);
  assert(body.lines.length === 20, `member read should get 20 lines, got ${body.lines.length}`);
  assert(
    body.lines[0]!.includes("SEER_SECRET"),
    "member read should carry the file's own text, or this script withholds nothing",
  );
}

// ---- signed out, and a signed-in stranger: the same bytes as a review that is not there ----
for (const [who, headers] of [
  ["signed out", {} as Record<string, string>],
  ["a stranger", cookie(stranger)],
] as const) {
  const res = await fetch(url("golden"), { headers, redirect: "manual" });
  assert(!res.headers.get("location"), `${who} should not be redirected to a login`);
  const body = await shape(res);
  assert(body === missing, `${who} should be byte-identical to a review that is not there`);
  assert(!body.includes("SEER_SECRET"), `${who} should not be handed a line of the file`);
}

// ---- a share token opens the review and not the files behind it ----
{
  const { token } = createShare({
    wsId: ws,
    kind: "review",
    target: "golden",
    label: "outside",
    userId: member,
    expiresAt: null,
  });
  const page = await fetch(`${base}/s/${token}`);
  assert(page.status === 200, `the share should open the review, got ${page.status}`);
  const drawn = await page.text();
  assert(drawn.includes("data-new-from"), "the shared page should still draw its hunks");
  assert(
    drawn.includes("const CONTEXT = false"),
    "the shared page should not offer the loader in the first place",
  );

  const res = await fetch(`${base}/s/${token}/c?${AUTH}`, { redirect: "manual" });
  assert(res.status === 404, `a share token should not open a file, got ${res.status}`);
  assert(!(await res.text()).includes("SEER_SECRET"), "a share token should be handed no line of it");
}

// ---- a member, asking for a file this review never touched ----
{
  const outside = `${base}/${ws}/r/golden/c?path=src%2Fsession.ts&sha=${GOLDEN_HEAD_SHA_12}&from=1&to=20`;
  const body = await shape(await fetch(outside, { headers: cookie(member) }));
  assert(
    body === missing,
    "a path the document does not name should be the same answer as a review that is not there",
  );
}

console.log("all assertions passed");
server.stop();
process.exit(0);
