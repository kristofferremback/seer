// Runs in its OWN process, with auth ENABLED.
//
// The suite sets AUTH_DISABLED=true, under which sessionUser returns the root user for
// every request — so a fetch with no cookie is not a signed-out visitor and a refusal
// asserted there is not a refusal at all. Everything about who may read a promoted
// review therefore has to be asked here.
//
// Every refusal is checked against the success it withholds, in this same process: a
// guarantee is only tested when the thing it withholds is demonstrably there.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "revision-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "revision-privacy-test";
process.env.SESSION_SECRET = "revision-privacy-test-secret";

const workspace = process.env.REVISION_WORKSPACE!;
const slug = process.env.REVISION_SLUG!;
const owner = process.env.REVISION_OWNER!;
const member = process.env.REVISION_MEMBER!;
const stranger = process.env.REVISION_STRANGER!;
const changeId = process.env.REVISION_CHANGE!;
const seamId = process.env.REVISION_SEAM!;
const fileId = process.env.REVISION_FILE!;
const key = process.env.REVISION_KEY!;
const otherKey = process.env.REVISION_OTHER_KEY!;
/** A slug only this workspace holds, so a foreign key's miss is about the workspace
 *  rather than about the slug being free everywhere. */
const localOnlySlug = process.env.REVISION_LOCAL_ONLY_SLUG!;
if (![workspace, slug, owner, member, stranger, changeId, seamId, fileId, key, otherKey, localOnlySlug, process.env.DATA_DIR].every(Boolean)) {
  throw new Error("revision privacy env is incomplete");
}

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { config } = await import("../../src/config");
const { db } = await import("../../src/db");
const { setGithubClientFactory } = await import("../../src/overseer/github-app");
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading a promoted review"); });

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const page = (user: string, path: string) => fetch(`${base}${path}`, { headers: { cookie: cookie(user) } });
const evidence = (user: string) => page(user, `/${workspace}/r/${slug}/rev/1`);
const account = (user: string) => page(user, `/${workspace}/r/${slug}/v/1`);
const focused = (user: string) => page(user, `/${workspace}/r/${slug}/rev/1?review=${encodeURIComponent(seamId)}&change=${encodeURIComponent(changeId)}`);
const lines = (headers: Record<string, string>, id = fileId) =>
  fetch(`${base}/api/review-lineages/${slug}/revisions/1/files/${id}?side=new&start=1&end=1`, { headers });

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  const revision = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM review_revisions WHERE workspace_id = ? AND slug = ? AND revision = 1",
  ).get(workspace, slug);
  if (!revision) throw new Error("the source revision row is missing");
  db.run("DELETE FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ?", [workspace, revision.id]);

  // The successes first, so every refusal below withholds something that is really there.
  const ownerEvidence = await evidence(owner);
  const memberEvidence = await evidence(member);
  const ownerAccount = await account(owner);
  const memberAccount = await account(member);
  assert([ownerEvidence, memberEvidence, ownerAccount, memberAccount].every((r) => r.status === 200), "workspace members could not read the promoted review");
  const memberBefore = await (await focused(member)).text();
  assert(memberBefore.includes(`data-change="${changeId}"`) && memberBefore.includes('data-read="false"'), "the member did not begin unread");

  // A stranger cannot tell a review that is not theirs from one that does not exist, and
  // neither can a signed-out browser.
  const strangerEvidence = await evidence(stranger);
  const strangerAccount = await account(stranger);
  const strangerBare = await page(stranger, `/${workspace}/r/${slug}`);
  const strangerMissing = await page(stranger, `/${workspace}/r/not-a-review`);
  const strangerMissingRevision = await page(stranger, `/${workspace}/r/not-a-review/rev/1`);
  const signedOut = await fetch(`${base}/${workspace}/r/${slug}/rev/1`);
  const refusedPages = [strangerEvidence, strangerAccount, strangerBare, strangerMissing, strangerMissingRevision, signedOut];
  const refusedBodies = await Promise.all(refusedPages.map((r) => r.text()));
  assert(refusedPages.every((r) => r.status === 404), "a promoted review answered a non-member");
  assert(refusedPages.every((r) => r.headers.get("cache-control") === "no-store"), "a refusal was cacheable");
  assert(refusedPages.every((r) => r.headers.get("content-type") === "text/html;charset=utf-8"), "a page refusal changed content type");
  assert(new Set(refusedBodies).size === 1, "a promoted refusal disclosed existence");
  assert(refusedBodies[0]!.includes("No such review"), "the refusal is not the shipped review page");

  // A read mark is one member's, on one revision, and it is not an API key's to write.
  const origin = new URL(config.baseUrl).origin;
  const action = `${base}/${workspace}/r/${slug}/rev/1/changes/${changeId}/read`;
  const marked = await fetch(action, {
    method: "POST",
    headers: { cookie: cookie(owner), origin, accept: "application/json" },
    body: new URLSearchParams({ read: "true" }),
  });
  assert(marked.status === 200, `the owner's read write returned ${marked.status}`);
  const byKey = await fetch(action, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, origin, accept: "application/json" },
    body: new URLSearchParams({ read: "true" }),
  });
  assert(byKey.status === 404, `an API key wrote somebody's reading history (${byKey.status})`);
  const byStranger = await fetch(action, {
    method: "POST",
    headers: { cookie: cookie(stranger), origin, accept: "application/json" },
    body: new URLSearchParams({ read: "true" }),
  });
  assert(byStranger.status === 404, `a non-member wrote a read mark (${byStranger.status})`);

  const around = (body: string) => {
    const at = body.indexOf(`id="${changeId}" data-change="${changeId}"`);
    return body.slice(at, at + 300);
  };
  const ownerAfter = await (await focused(owner)).text();
  const memberAfter = await (await focused(member)).text();
  assert(around(ownerAfter).includes('data-read="true"'), "the owner's read state was not rendered");
  assert(around(memberAfter).includes('data-read="false"'), "the owner's read state leaked to another member");

  // The same mark, on the account published over the same revision: one handling state,
  // two addresses.
  const ownerAccountAfter = await (await page(owner, `/${workspace}/r/${slug}/v/1?review=walkthrough&change=${encodeURIComponent(changeId)}`)).text();
  assert(around(ownerAccountAfter).includes('data-read="true"'), "the account did not share the revision's read state");

  // Retained lines: a valid member session and a valid workspace key read them; a stale
  // bearer, a foreign workspace's key, and a malformed id are one indistinguishable miss.
  const keyRead = await lines({ authorization: `Bearer ${key}` });
  const sessionRead = await lines({ cookie: cookie(owner), authorization: "Bearer stale-token" });
  assert(keyRead.status === 200 && sessionRead.status === 200, "valid line readers were refused");
  const refusals = [
    await lines({ authorization: "Bearer stale-token" }),
    await lines({ authorization: `Bearer ${otherKey}` }),
    await lines({ authorization: `Bearer ${key}` }, "stf_0000000000"),
    await lines({ authorization: `Bearer ${key}` }, "not-an-id"),
    await lines({ cookie: cookie(stranger) }),
    await lines({}),
  ];
  const refusalBodies = await Promise.all(refusals.map((r) => r.text()));
  assert(refusals.every((r) => r.status === 404), "a line refusal used a status of its own");
  assert(new Set(refusalBodies).size === 1, "a line refusal disclosed file or key existence");
  assert(refusalBodies[0] === JSON.stringify({ error: "No such review" }, null, 2), "a line refusal is not the shipped review body");

  // A foreign key cannot read this workspace's lineage at all, now that the session is
  // real: the slug resolves only inside the workspaces the caller can actually reach.
  const foreignLineage = await fetch(`${base}/api/review-lineages/${localOnlySlug}`, { headers: { authorization: `Bearer ${otherKey}` } });
  const ownLineage = await fetch(`${base}/api/review-lineages/${localOnlySlug}`, { headers: { authorization: `Bearer ${key}` } });
  assert(ownLineage.status === 200, `the owning key could not read its own lineage (${ownLineage.status})`);
  assert(foreignLineage.status === 404, `a foreign key read this workspace's lineage (${foreignLineage.status})`);
  assert(await foreignLineage.text() === refusalBodies[0], "a cross-workspace refusal has a body of its own");

  // Publishing is a key's act, and only in the key's own workspace.
  const foreignPublish = await fetch(`${base}/api/review-lineages/${localOnlySlug}/revisions/1/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" },
    body: JSON.stringify({ witness: { name: "W", model: "m" }, summary: "x", groups: [] }),
  });
  const sessionPublish = await fetch(`${base}/api/review-lineages/${slug}/revisions/1/accounts`, {
    method: "POST",
    headers: { cookie: cookie(owner), "content-type": "application/json", origin },
    body: JSON.stringify({ witness: { name: "W", model: "m" }, summary: "x", groups: [] }),
  });
  assert(foreignPublish.status === 404, `a foreign key reached this revision (${foreignPublish.status})`);
  assert(sessionPublish.status === 401, `a session published an account (${sessionPublish.status})`);

  console.log("revision privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
