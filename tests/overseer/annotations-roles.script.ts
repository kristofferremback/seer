// Runs in its OWN process (spawned by annotations.test.ts) with AUTH_DISABLED unset,
// so there is no ambient session and forged cookies resolve to real users. That is the
// only way to ask the annotation route the three questions that decide who may write
// to a review: what a signed-out browser gets, what a stranger gets, and what an API
// key gets when it tries to file as a reader.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-annotations-roles-"));

// This process does not get bunfig's test preload, so it installs the same offline
// GitHub client itself: rendering a review page kicks a freshness check, and no test
// anywhere reaches the real API. Nothing below answers with refs, so nothing needs a
// GitHub that responds.
const { setGithubClient } = await import("../../src/overseer/github");
const { offlineGithubClient } = await import("../offline-github");
setGithubClient(offlineGithubClient());

const { sessionCookie } = await import("../../src/auth");
const { db, mintApiKey } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { listAnnotations } = await import("../../src/overseer/db");
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
const key = mintApiKey(member, ws, "skill").token;

function cookie(userId: string): Record<string, string> {
  return { cookie: sessionCookie(userId).split(";")[0]! };
}

async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

function post(headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`${base}/api/reviews/golden/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

const filing = { target: { type: "statement", id: "st_gate" }, body: "Who may write here?" };

// ---- the member files ----
{
  const res = await post(cookie(member), filing);
  assert(res.status === 200, `member filing should 200, got ${res.status}`);
  assert(listAnnotations(ws, "golden").length === 1, "the member's annotation should be stored");
}

// ---- signed out and a stranger: the read path's 404, byte for byte ----
{
  const unknown = await shape(
    await post({}, { target: { type: "summary", id: "summary" }, body: "?" }),
  );
  assert(unknown.startsWith("404\n"), `signed-out filing should 404, got ${unknown.split("\n")[0]}`);

  const missing = await shape(
    await fetch(`${base}/api/reviews/no-such-review/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(filing),
    }),
  );
  assert(
    unknown === missing,
    "a signed-out filing should be byte-identical to filing on an unknown slug",
  );

  const strangerRes = await post(cookie(stranger), filing);
  assert(
    (await shape(strangerRes)) === missing,
    "a stranger's filing should be byte-identical to an unknown slug",
  );
  assert(!strangerRes.headers.get("location"), "a stranger's filing should not redirect to login");
}

// ---- an API key may not file as a reader ----
{
  const res = await post({ authorization: `Bearer ${key}` }, filing);
  assert(res.status === 403, `an API key filing should 403, got ${res.status}`);
  const json = (await res.json()) as { error: string };
  assert(json.error.includes("signed-in member"), `403 should say what the right is: ${json.error}`);
  assert(listAnnotations(ws, "golden").length === 1, "an API key filing should write nothing");
}

// ---- the key answers, which is the half it does have ----
{
  const filed = listAnnotations(ws, "golden")[0]!;
  const res = await post(
    { authorization: `Bearer ${key}` },
    { id: filed.id, answer: { body: "The member does." } },
  );
  assert(res.status === 200, `an API key answering should 200, got ${res.status}`);
  assert(listAnnotations(ws, "golden")[0]!.status === "answered", "the annotation should be answered");
}

// ---- and the member may not answer it ----
{
  const filed = listAnnotations(ws, "golden")[0]!;
  const res = await post(cookie(member), { id: filed.id, answer: { body: "Me again." } });
  assert(res.status === 403, `a member answering should 403, got ${res.status}`);
}

// ---- the form is drawn for the member and for nobody else ----
{
  const memberPage = await (await fetch(`${base}/r/golden`, { headers: cookie(member) })).text();
  assert(memberPage.includes(`<form class="ask-form"`), "a member's page should carry the ask form");
  const keyPage = await fetch(`${base}/r/golden`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert(keyPage.status === 200, `a key holder should read the page, got ${keyPage.status}`);
  assert(
    !(await keyPage.text()).includes(`<form class="ask-form"`),
    "a page reached with an API key alone should carry no ask form",
  );
}

console.log("all assertions passed");
server.stop(true);
process.exit(0);
