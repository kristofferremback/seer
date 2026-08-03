// Runs in its OWN process (spawned by shares.test.ts) with AUTH_DISABLED unset, so a
// request carrying no cookie is genuinely nobody rather than the root user.
//
// shares.test.ts covers the same refusals, but every request there arrives as a
// signed-in stranger, because AUTH_DISABLED short-circuits sessionUser to the root user.
// The reader a share is actually aimed at has no session at all, and the branch that
// serves a member a dead link is keyed on exactly that. So the questions asked here are
// the ones no other test can ask: what a signed-out browser gets from a live token, from
// a revoked one, from an expired one, and whether a token can write.
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
process.env.ALLOWED_EMAILS = "member@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-share-privacy-"));

// This process does not get bunfig's test preload, so it installs the same offline
// GitHub client itself: rendering a review page kicks a freshness check.
const { setGithubClient } = await import("../src/overseer/github");
const { offlineGithubClient } = await import("./offline-github");
setGithubClient(offlineGithubClient());

const { sessionCookie } = await import("../src/auth");
const { db } = await import("../src/db");
const { tinyId } = await import("../src/ids");
const { startServer } = await import("../src/server");
const { createShare, revokeShare } = await import("../src/shares");
const { storeGoldenReview } = await import("./overseer/fixtures/stored-review");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

const server = await startServer();
const base = `http://localhost:${server.port}`;
const now = Date.now();

const ws = tinyId("ws");
db.run(
  "INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'private', ?)",
  [ws, "Alpha", now],
);
// ALLOWED_EMAILS bootstraps member@example.com and its own workspace already.
const member = db
  .query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?")
  .get("member@example.com")!.id;
db.run(
  "INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)",
  [ws, member, now],
);
storeGoldenReview(ws, "golden");
// Seeded so "a shared page carries no annotations" is a real question rather than a
// vacuous one: the private page below proves the markup exists to be withheld.
const { createAnnotation } = await import("../src/overseer/db");
const ANNOTATION = "Is the gate reachable?";
createAnnotation(
  ws,
  "golden",
  { type: "summary", id: "summary" },
  ANNOTATION,
  1,
);

function mint(label: string, expiresAt: number | null = null) {
  return createShare({
    wsId: ws,
    kind: "review",
    target: "golden",
    label,
    userId: member,
    expiresAt,
  });
}

const live = mint("live");
const revoked = mint("revoked");
revokeShare(revoked.id);
const expired = mint("expired", now - 1000);

/** Status, content type and body, so "the same 404" means the same response and not
 *  merely the same status line. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join(
    "\n",
  );
}

const memberCookie = { cookie: sessionCookie(member).split(";")[0]! };

// The control the refusals below are measured against. The member's own page is what a
// shared page is subtracted from, so anything the private page does not show cannot be
// claimed as withheld on the shared one.
let annotationsRender = false;
{
  const res = await fetch(`${base}/${ws}/r/golden`, { headers: memberCookie });
  assert(
    res.status === 200,
    `the member's own page should 200, got ${res.status}`,
  );
  annotationsRender = (await res.text()).includes(ANNOTATION);
  if (!annotationsRender) {
    // QUESTIONS_ON_PAGE is off, so no page renders annotations and the shared-page
    // assertion below is vacuous. Said out loud rather than left to look like a pass:
    // it starts testing something real the day the questions UI comes back.
    console.log(
      "NOTE: annotations render nowhere; the hidden-annotation check is vacuous today",
    );
  }
  const wrote = await fetch(`${base}/api/reviews/golden/annotations`, {
    method: "POST",
    headers: { ...memberCookie, "content-type": "application/json" },
    body: JSON.stringify({
      target: { type: "summary", id: "summary" },
      body: "a second one",
    }),
  });
  assert(
    wrote.status === 200,
    `a member should be able to annotate, got ${wrote.status}`,
  );
}

const bogus = "seer_sh_" + "b".repeat(32);
const missing = await shape(
  await fetch(`${base}/s/${bogus}`, { redirect: "manual" }),
);
assert(
  missing.startsWith("404\n"),
  `an unknown token should 404, got ${missing.split("\n")[0]}`,
);

// ---- the live token opens the page, for nobody in particular ----
{
  const res = await fetch(`${base}/s/${live.token}`, { redirect: "manual" });
  assert(
    res.status === 200,
    `a live token should 200 signed out, got ${res.status}`,
  );
  assert(
    res.headers.get("referrer-policy") === "no-referrer",
    "a shared page must not leak its token in a referrer",
  );
  const html = await res.text();
  assert(
    html.includes("golden"),
    "the live share should render the review it names",
  );
  // The workspace talking to itself does not travel with the link. Vacuous while
  // annotationsRender is false; the note above says so when it is.
  assert(
    !html.includes(ANNOTATION),
    "a shared page should not carry the workspace's own annotations",
  );
  assert(
    !html.includes("/annotations"),
    "a shared page should offer no way to ask a question",
  );
  // Nor should it hand out the private URL the token stands in for.
  assert(
    !html.includes(`/${ws}/r/golden`),
    "a shared page should not print the private url",
  );
}

// ---- dead tokens are one refusal, byte for byte ----
for (const [what, token] of [
  ["a revoked token", revoked.token],
  ["an expired token", expired.token],
] as const) {
  for (const path of ["", "/v/1"]) {
    const res = await fetch(`${base}/s/${token}${path}`, {
      redirect: "manual",
    });
    assert(
      !res.headers.get("location"),
      `${what} should not redirect a signed-out reader`,
    );
    const body = await shape(res);
    assert(
      body === missing,
      `${what} on /s/<token>${path} should be byte-identical to one that never existed`,
    );
  }
}

// ---- the documented exception needs a session to fire ----
{
  const res = await fetch(`${base}/s/${revoked.token}`, {
    headers: memberCookie,
    redirect: "manual",
  });
  assert(
    res.status === 302,
    `a member following a dead link should be redirected, got ${res.status}`,
  );
  assert(
    res.headers.get("location") === `/${ws}/r/golden`,
    `a member should land on the asset itself, got ${res.headers.get("location")}`,
  );
  // And an unknown token stays unknown even for them: there is no asset to send them to.
  const res2 = await fetch(`${base}/s/${bogus}`, {
    headers: memberCookie,
    redirect: "manual",
  });
  assert(
    (await shape(res2)) === missing,
    "an unknown token should 404 a member too",
  );
}

// ---- a token is never a write ----
{
  const posts: Array<[string, string, unknown]> = [
    [
      "an annotation",
      `${base}/api/reviews/golden/annotations`,
      { kind: "question", body: "can a share write?" },
    ],
    ["a refresh", `${base}/api/reviews/golden/refresh`, null],
    [
      "a publish",
      `${base}/api/reviews`,
      { workspace: ws, slug: "golden", repo: "o/r", prs: [], document: {} },
    ],
    [
      "a mint",
      `${base}/api/shares`,
      { workspace: ws, kind: "review", target: "golden" },
    ],
  ];
  for (const [what, url, payload] of posts) {
    for (const [how, headers] of [
      ["as a bearer token", { authorization: `Bearer ${live.token}` }],
      ["as a cookie", { cookie: `session=${live.token}` }],
    ] as const) {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: payload === null ? undefined : JSON.stringify(payload),
        redirect: "manual",
      });
      assert(
        res.status === 401 || res.status === 403 || res.status === 404,
        `${what} ${how} should be refused, got ${res.status}`,
      );
    }
  }
}

// ---- the token opens one asset and no other ----
{
  storeGoldenReview(ws, "sibling");
  const res = await fetch(`${base}/${ws}/r/sibling`, {
    headers: { authorization: `Bearer ${live.token}` },
    redirect: "manual",
  });
  assert(
    res.status === 404,
    `a token must not reach the workspace's other reviews, got ${res.status}`,
  );
}

console.log("all assertions passed");
server.stop(true);
process.exit(0);
