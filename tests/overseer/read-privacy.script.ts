// Runs in its OWN process (spawned by read.test.ts) with AUTH_DISABLED unset, so
// sessionUser resolves real forged cookies instead of short-circuiting to the root
// user. That is the only way to ask the read path the two questions that matter most
// about a page holding private source: what a signed-out browser gets, and what a
// signed-in stranger gets.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import "../app-env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "root@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-read-privacy-"));

// This process does not get bunfig's test preload, so it installs the same offline
// GitHub client itself: rendering a review page kicks a freshness check, and no test
// anywhere reaches the real API.
const { setGithubClientFactory } = await import("../../src/overseer/github-app");
const { setGithubOAuth } = await import("../../src/overseer/github-oauth");
const { offlineGithubClientFactory, offlineGithubOAuth } = await import(
  "../offline-github"
);
// Both seams, not just the first: a per-workspace client is built by a factory, and
// the OAuth transport is not a GithubClient at all.
setGithubClientFactory(offlineGithubClientFactory());
setGithubOAuth(offlineGithubOAuth());

const { sessionCookie } = await import("../../src/auth");
const { db } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { storeGoldenReview } = await import("./fixtures/stored-review");

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

// One workspace, one member, one published review.
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

const unknown = await shape(await fetch(`${base}/api/reviews/no-such-review`));
assert(unknown.startsWith("404\n"), `unknown slug should 404, got ${unknown.split("\n")[0]}`);

// ---- the member reads ----
{
  const res = await fetch(`${base}/api/reviews/golden`, { headers: cookie(member) });
  assert(res.status === 200, `member read should 200, got ${res.status}`);
  const json = (await res.json()) as { workspace: string; version: number };
  assert(json.workspace === ws, `member read should resolve into ${ws}, got ${json.workspace}`);
  assert(json.version === 1, `member read should be version 1, got ${json.version}`);
}

// ---- signed out: a 404 shape, never a 401 or a redirect ----
{
  const res = await fetch(`${base}/api/reviews/golden`, { redirect: "manual" });
  assert(res.status === 404, `signed-out read should 404, got ${res.status}`);
  assert(!res.headers.get("location"), "signed-out read should not redirect to login");
  const body = await shape(res);
  assert(body === unknown, "signed-out read should be byte-identical to an unknown slug");
}

// ---- a signed-in non-member: the same bytes again ----
{
  const res = await fetch(`${base}/api/reviews/golden`, { headers: cookie(stranger) });
  const body = await shape(res);
  assert(body === unknown, "non-member read should be byte-identical to an unknown slug");
}
{
  const res = await fetch(`${base}/api/reviews/golden/v/1`, { headers: cookie(stranger) });
  const body = await shape(res);
  assert(body === unknown, "non-member version read should be byte-identical to an unknown slug");
}

// ---- the html page and the attachment bytes, same three questions ----
{
  const { createAttachment } = await import("../../src/overseer/db");
  const { saveAttachment } = await import("../../src/store");

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const att = createAttachment(ws, "golden", 1, "image/png", bytes.length, "A shot", "");
  await saveAttachment(ws, att, bytes);

  const missingPage = await shape(await fetch(`${base}/r/no-such-review`));
  assert(missingPage.startsWith("404\n"), `unknown review page should 404`);
  const missingAtt = await shape(await fetch(`${base}/r/golden/a/att_nothinghere`));
  assert(missingAtt.startsWith("404\n"), `unknown attachment should 404`);

  {
    const res = await fetch(`${base}/r/golden`, { headers: cookie(member) });
    assert(res.status === 200, `member page read should 200, got ${res.status}`);
    const res2 = await fetch(`${base}/r/golden/a/${att}`, { headers: cookie(member) });
    assert(res2.status === 200, `member attachment read should 200, got ${res2.status}`);
  }

  for (const [who, headers] of [
    ["signed out", {} as Record<string, string>],
    ["a stranger", cookie(stranger)],
  ] as const) {
    for (const path of ["/r/golden", "/r/golden/v/1"]) {
      const res = await fetch(`${base}${path}`, { headers, redirect: "manual" });
      assert(!res.headers.get("location"), `${who} on ${path} should not redirect to login`);
      const body = await shape(res);
      assert(body === missingPage, `${who} on ${path} should be byte-identical to a missing review`);
    }
    const res = await fetch(`${base}/r/golden/a/${att}`, { headers, redirect: "manual" });
    const body = await shape(res);
    assert(body === missingAtt, `${who} on an attachment should be byte-identical to a missing one`);
  }

  // Another workspace's attachment, quoted through a slug the reader can read.
  const other = tinyId("ws");
  db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)", [
    other,
    "Beta",
    now,
  ]);
  storeGoldenReview(other, "beta");
  const foreign = createAttachment(other, "beta", 1, "image/png", bytes.length, "A shot", "");
  await saveAttachment(other, foreign, bytes);
  const res = await fetch(`${base}/r/golden/a/${foreign}`, { headers: cookie(member) });
  assert(
    (await shape(res)) === missingAtt,
    "a foreign workspace's attachment should be byte-identical to a missing one",
  );
}

// ---- the refresh route: the same three questions ----
{
  const missingRefresh = await shape(
    await fetch(`${base}/api/reviews/no-such-review/refresh`, { method: "POST" }),
  );
  assert(missingRefresh.startsWith("404\n"), "refresh on an unknown slug should 404");

  for (const [who, headers] of [
    ["signed out", {} as Record<string, string>],
    ["a stranger", cookie(stranger)],
  ] as const) {
    const res = await fetch(`${base}/api/reviews/golden/refresh`, {
      method: "POST",
      headers,
      redirect: "manual",
    });
    assert(!res.headers.get("location"), `${who} refreshing should not redirect to login`);
    const body = await shape(res);
    assert(
      body === missingRefresh,
      `${who} refreshing should be byte-identical to an unknown review`,
    );
  }
}

// ---- the live channel: membership is what opens it ----
{
  async function upgrade(headers: Record<string, string>): Promise<string> {
    const url = `ws://localhost:${server.port}/ws/livereload?kind=review&ws=${ws}&slug=golden`;
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    const answer = await new Promise<string>((resolve) => {
      socket.onopen = () => resolve("open");
      socket.onerror = () => resolve("refused");
      socket.onclose = () => resolve("refused");
    });
    socket.close();
    return answer;
  }

  assert((await upgrade(cookie(member))) === "open", "a member should subscribe to the review");
  assert((await upgrade({})) === "refused", "a signed-out socket should be refused");
  assert((await upgrade(cookie(stranger))) === "refused", "a stranger's socket should be refused");
}

// ---- membership is what changes the answer ----
{
  db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
    ws,
    stranger,
    now,
  ]);
  const res = await fetch(`${base}/api/reviews/golden`, { headers: cookie(stranger) });
  assert(res.status === 200, `a new member should read, got ${res.status}`);
}

console.log("all assertions passed");
server.stop(true);
process.exit(0);
