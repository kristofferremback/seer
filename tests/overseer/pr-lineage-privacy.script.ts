// Runs in its OWN process, with auth ENABLED.
//
// The suite sets AUTH_DISABLED=true, under which sessionUser returns the root user for
// every request — so a fetch with no cookie is not a signed-out visitor and a refusal
// asserted there is not a refusal at all. Everything about who may read a lineage that
// has not captured yet, or a capture job, therefore has to be asked here.
//
// Every refusal is checked against the success it withholds, in this same process: a
// guarantee is only tested when the thing it withholds is demonstrably there.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "pr-lineage-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "pr-lineage-privacy-test";
process.env.SESSION_SECRET = "pr-lineage-privacy-test-secret";

const workspace = process.env.PR_WORKSPACE!;
/** A lineage whose first capture has not completed: the retained-only shell. */
const shellSlug = process.env.PR_SHELL_SLUG!;
/** A lineage that HAS a completed revision, so the shell's refusal is about who is
 *  asking rather than about there being nothing behind either slug. */
const readySlug = process.env.PR_READY_SLUG!;
const owner = process.env.PR_OWNER!;
const member = process.env.PR_MEMBER!;
const stranger = process.env.PR_STRANGER!;
const key = process.env.PR_KEY!;
const otherKey = process.env.PR_OTHER_KEY!;
const jobId = process.env.PR_JOB!;
const shellNumber = process.env.PR_SHELL_NUMBER!;
if (![workspace, shellSlug, readySlug, owner, member, stranger, key, otherKey, jobId, shellNumber, process.env.DATA_DIR].every(Boolean)) {
  throw new Error("pull request lineage privacy env is incomplete");
}

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading a promoted review"); });
setReadRouter({
  async resolve(): Promise<never> { throw new Error("GitHub must not be routed while reading a promoted review"); },
  async open(): Promise<never> { throw new Error("GitHub must not be opened while reading a promoted review"); },
});

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const page = (user: string, path: string) => fetch(`${base}${path}`, { headers: { cookie: cookie(user) } });
const job = (headers: Record<string, string>, id = jobId) =>
  fetch(`${base}/api/review-capture-jobs/${id}`, { headers });

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  // The successes first, so every refusal below withholds something that is really there.
  const ownerShell = await page(owner, `/${workspace}/r/${shellSlug}`);
  const memberShell = await page(member, `/${workspace}/r/${shellSlug}`);
  assert(ownerShell.status === 200 && memberShell.status === 200, "workspace members could not read the pending shell");
  const shellBody = await ownerShell.text();
  assert(shellBody.includes("Capture"), "the shell does not report its capture state");
  assert(shellBody.includes(`#${shellNumber}`), "the shell does not name its pull request");
  assert(!shellBody.includes("guc_"), "the shell exposed a credential id");
  assert(ownerShell.headers.get("cache-control") === "no-store", "the shell is cacheable");

  // A stranger cannot tell a pending review that is not theirs from one that does not
  // exist, and neither can a signed-out browser. The same bytes, in every case.
  const strangerShell = await page(stranger, `/${workspace}/r/${shellSlug}`);
  const strangerReady = await page(stranger, `/${workspace}/r/${readySlug}`);
  const strangerMissing = await page(stranger, `/${workspace}/r/not-a-review`);
  const signedOutShell = await fetch(`${base}/${workspace}/r/${shellSlug}`);
  const refusedPages = [strangerShell, strangerReady, strangerMissing, signedOutShell];
  const refusedBodies = await Promise.all(refusedPages.map((response) => response.text()));
  assert(refusedPages.every((response) => response.status === 404), "a pending review answered a non-member");
  assert(refusedPages.every((response) => response.headers.get("cache-control") === "no-store"), "a refusal was cacheable");
  assert(refusedPages.every((response) => response.headers.get("content-type") === "text/html;charset=utf-8"), "a page refusal changed content type");
  assert(new Set(refusedBodies).size === 1, "a pending refusal disclosed existence");
  assert(refusedBodies[0]!.includes("No such review"), "the refusal is not the shipped review page");

  // A pinned revision URL on a lineage that has none is the same miss as any other: it
  // names a document, and there is no document.
  const ownerPinned = await page(owner, `/${workspace}/r/${shellSlug}/rev/1`);
  assert(ownerPinned.status === 404, `a member reached a revision that does not exist (${ownerPinned.status})`);
  assert(await ownerPinned.text() === refusedBodies[0], "a missing revision has a refusal of its own");

  // A capture job reads for the workspace's own members and keys, and misses for
  // everyone else — with one body, so a job id is not an oracle either.
  const keyJob = await job({ authorization: `Bearer ${key}` });
  const sessionJob = await job({ cookie: cookie(member) });
  assert(keyJob.status === 200 && sessionJob.status === 200, "a workspace member or key could not read its own capture job");
  const jobBody = await keyJob.text();
  assert(!jobBody.includes("guc_"), "a capture job view exposed a credential id");

  const jobRefusals = [
    await job({ authorization: `Bearer ${otherKey}` }),
    await job({ cookie: cookie(stranger) }),
    await job({}),
    await job({ authorization: `Bearer ${key}` }, "rcj_0000000000"),
    await job({ authorization: `Bearer ${key}` }, "not-an-id"),
  ];
  const jobBodies = await Promise.all(jobRefusals.map((response) => response.text()));
  assert(jobRefusals.every((response) => response.status === 404), "a capture job refusal used a status of its own");
  assert(new Set(jobBodies).size === 1, "a capture job refusal disclosed job or key existence");
  assert(jobBodies[0] === JSON.stringify({ error: "No such review" }, null, 2), "a job refusal is not the shipped review body");

  // Ingestion, attachment, refresh and retry are a key's acts. A session is not a key,
  // and a foreign workspace's key reaches nothing here.
  const origin = new URL(base).origin;
  const sessionIngest = await fetch(`${base}/api/pull-request-review-lineages`, {
    method: "POST",
    headers: { cookie: cookie(owner), "content-type": "application/json", "idempotency-key": "privacy-session", origin },
    body: JSON.stringify({ repo: "Acme/Reader", number: 4242, slug: "privacy-session" }),
  });
  assert(sessionIngest.status === 401, `a session ingested a pull request (${sessionIngest.status})`);

  const foreignAttach = await fetch(`${base}/api/review-lineages/${readySlug}/pull-request`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json", "idempotency-key": "privacy-foreign" },
    body: JSON.stringify({ repo: "Acme/Reader", number: 4242 }),
  });
  assert(foreignAttach.status === 404, `a foreign key attached to this workspace's lineage (${foreignAttach.status})`);
  assert(await foreignAttach.text() === jobBodies[0], "a cross-workspace attach refusal has a body of its own");

  const foreignRefresh = await fetch(`${base}/api/review-lineages/${readySlug}/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherKey}`, "idempotency-key": "privacy-foreign-refresh" },
  });
  assert(foreignRefresh.status === 404, `a foreign key refreshed this workspace's lineage (${foreignRefresh.status})`);

  const foreignRetry = await fetch(`${base}/api/review-capture-jobs/${jobId}/retry`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherKey}` },
  });
  assert(foreignRetry.status === 404, `a foreign key retried this workspace's capture (${foreignRetry.status})`);

  console.log("pull request lineage privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
