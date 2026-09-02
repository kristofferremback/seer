// Runs in its OWN process, with auth ENABLED.
//
// The suite sets AUTH_DISABLED=true, under which every request is the root user, so a
// refusal asserted there is not a refusal at all. Who may read a stack — its pages, its
// API, a member's read through it, a member's retained lines through its manifest — is
// therefore asked here, and every refusal is checked beside the success it withholds.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "stack-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "stack-privacy-test";
process.env.SESSION_SECRET = "stack-privacy-test-secret";

const workspace = process.env.STACK_WORKSPACE!;
const slug = process.env.STACK_SLUG!;
const owner = process.env.STACK_OWNER!;
const member = process.env.STACK_MEMBER!;
const stranger = process.env.STACK_STRANGER!;
const changeId = process.env.STACK_CHANGE!;
const fileId = process.env.STACK_FILE!;
const key = process.env.STACK_KEY!;
const otherKey = process.env.STACK_OTHER_KEY!;
if (![workspace, slug, owner, member, stranger, changeId, fileId, key, otherKey, process.env.DATA_DIR].every(Boolean)) {
  throw new Error("stack privacy env is incomplete");
}

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { config } = await import("../../src/config");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading a stack"); });
setReadRouter({
  async resolve() { throw new Error("GitHub must not be resolved while reading a stack"); },
  async open() { throw new Error("GitHub must not be opened while reading a stack"); },
});

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const page = (user: string | null, path: string) => fetch(`${base}${path}`, { headers: user ? { cookie: cookie(user) } : {} });
const origin = new URL(config.baseUrl).origin;
const readAction = `/${workspace}/r-stacks/${slug}/v/2/m/2/changes/${changeId}/read`;
const mark = (headers: Record<string, string>, read: boolean) =>
  fetch(`${base}${readAction}`, { method: "POST", headers: { ...headers, origin, accept: "application/json" }, body: new URLSearchParams({ read: String(read) }) });
const lines = (headers: Record<string, string>, id = fileId) =>
  fetch(`${base}/api/review-stacks/${slug}/manifests/2/members/2/files/${id}?side=new&start=1&end=1`, { headers });
const api = (headers: Record<string, string>, path = `/api/review-stacks/${slug}`) => fetch(`${base}${path}`, { headers });

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  // Successes first, so every refusal below withholds something that is really there.
  const successes = await Promise.all([
    page(owner, `/${workspace}/r-stacks/${slug}`),
    page(member, `/${workspace}/r-stacks/${slug}/v/2`),
    page(member, `/${workspace}/r-stacks/${slug}/v/2/account`),
    page(owner, `/${workspace}/r-stacks/${slug}/v/2/account?review=shared-line&change=${changeId}`),
    page(owner, `/${workspace}/r-stacks/${slug}/v/2/account?review=shared-line&layer=pr-12`),
  ]);
  assert(successes.every((response) => response.status === 200), `workspace members could not read the stack: ${successes.map((r) => r.status).join(",")}`);
  const focused = await successes[3]!.text();
  assert(focused.includes(`data-change="${changeId}"`), "the member's namespaced change was not drawn");
  assert((await api({ authorization: `Bearer ${key}` })).status === 200, "the workspace key could not read the stack API");
  assert((await api({ cookie: cookie(member) })).status === 200, "a member session could not read the stack API");
  assert((await api({ cookie: cookie(member) }, `/api/review-stacks/${slug}/manifests/2`)).status === 200, "a member session could not read the manifest");
  assert((await api({ cookie: cookie(member) }, `/api/review-stacks/${slug}/manifests/2/account`)).status === 200, "a member session could not read the account");
  assert((await lines({ authorization: `Bearer ${key}` })).status === 200, "the workspace key could not read retained lines through the manifest");
  assert((await lines({ cookie: cookie(member) })).status === 200, "a member could not read retained lines through the manifest");

  // Pages: stranger, signed-out, malformed, missing, cross-workspace are one answer.
  const miss = await page(stranger, `/${workspace}/r-stacks/not-a-stack`);
  const missBody = await miss.text();
  const refusedPages = await Promise.all([
    page(stranger, `/${workspace}/r-stacks/${slug}`),
    page(stranger, `/${workspace}/r-stacks/${slug}/v/2`),
    page(stranger, `/${workspace}/r-stacks/${slug}/v/2/account`),
    page(stranger, `/${workspace}/r-stacks/${slug}/v/2/account?review=shared-line`),
    page(null, `/${workspace}/r-stacks/${slug}`),
    page(null, `/${workspace}/r-stacks/${slug}/v/2/account?review=shared-line&change=${changeId}`),
    page(owner, `/${workspace}/r-stacks/${slug}/v/999`),
    page(owner, `/${workspace}/r-stacks/${slug}/v/2x`),
    page(owner, `/${workspace}/r-stacks/${slug}/v/1/account`),
    page(owner, `/ws_00000000zz/r-stacks/${slug}`),
    page(stranger, `/${workspace}/r-stacks/not-a-stack/v/2`),
  ]);
  const refusedBodies = await Promise.all(refusedPages.map((response) => response.text()));
  assert(miss.status === 404 && refusedPages.every((response) => response.status === 404), `a stack page answered someone it should not: ${refusedPages.map((r) => r.status).join(",")}`);
  assert(refusedPages.every((response) => response.headers.get("cache-control") === "no-store"), "a stack page refusal was cacheable");
  // Personalized only by the signed-in email, so bodies compare per viewer.
  const strangerBodies = refusedBodies.slice(0, 4).concat([refusedBodies[10]!]);
  assert(strangerBodies.every((body) => body === missBody), "a stranger can tell a stack from a missing one");
  assert(refusedBodies[4] === refusedBodies[5], "a signed-out visitor sees two different refusals");
  const ownerMiss = await (await page(owner, `/${workspace}/r-stacks/not-a-stack`)).text();
  assert(refusedBodies.slice(6, 10).every((body) => body === ownerMiss), "a member can tell a malformed, missing or cross-workspace stack from a missing one");

  // API: a foreign key, a stranger's session, a signed-out request and a bad id are one answer.
  const apiMiss = await api({ authorization: `Bearer ${key}` }, "/api/review-stacks/not-a-stack");
  const apiMissBody = await apiMiss.text();
  const refusedApi = await Promise.all([
    api({ authorization: `Bearer ${otherKey}` }),
    api({ cookie: cookie(stranger) }),
    api({}),
    api({ authorization: `Bearer ${otherKey}` }, `/api/review-stacks/${slug}/manifests/2`),
    api({ cookie: cookie(stranger) }, `/api/review-stacks/${slug}/manifests/2/account`),
    api({ authorization: `Bearer ${key}` }, `/api/review-stacks/${slug}/manifests/2x`),
    api({ authorization: `Bearer ${key}` }, "/api/review-stack-refresh-jobs/rsj_nope"),
  ]);
  const refusedApiBodies = await Promise.all(refusedApi.map((response) => response.text()));
  assert(apiMiss.status === 404 && refusedApi.every((response) => response.status === 404), `the stack API answered someone it should not: ${refusedApi.map((r) => r.status).join(",")}`);
  assert(refusedApiBodies.every((body) => body === apiMissBody), "the stack API's refusals differ");
  assert(refusedApi.every((response) => response.headers.get("cache-control") === "no-store"), "a stack API refusal was cacheable");

  // Reads: a member's mark is theirs, a stranger's and a signed-out one are misses, and a key cannot mark at all.
  const marked = await mark({ cookie: cookie(member) }, true);
  assert(marked.status === 200, `a member could not mark through the stack: ${marked.status}`);
  const memberView = await (await api({ cookie: cookie(member) }, `/api/review-stacks/${slug}/manifests/2`)).json() as any;
  assert(memberView.progress.read === 1, "the member's mark did not count in the manifest progress");
  const ownerView = await (await api({ cookie: cookie(owner) }, `/api/review-stacks/${slug}/manifests/2`)).json() as any;
  assert(ownerView.progress.read === 0, "one member's mark counted for another");
  const refusedMarks = await Promise.all([
    mark({ cookie: cookie(stranger) }, true),
    mark({}, true),
    mark({ authorization: `Bearer ${key}` }, true),
  ]);
  assert(refusedMarks.every((response) => response.status === 404), `a stack read mark answered someone it should not: ${refusedMarks.map((r) => r.status).join(",")}`);
  const unmarked = await mark({ cookie: cookie(member) }, false);
  assert(unmarked.status === 200 && (await unmarked.json() as any).read === false, "the member's mark did not reverse");
  assert(((await (await api({ cookie: cookie(member) }, `/api/review-stacks/${slug}/manifests/2`)).json()) as any).progress.read === 0, "the reversal did not count");

  // Lines: a foreign key, a stranger, a signed-out request, another member's file id, a malformed id are one answer.
  const lineMiss = await lines({ authorization: `Bearer ${key}` }, "stf_0000000000");
  const lineMissBody = await lineMiss.text();
  const refusedLines = await Promise.all([
    lines({ authorization: `Bearer ${otherKey}` }),
    lines({ cookie: cookie(stranger) }),
    lines({}),
    lines({ authorization: `Bearer ${key}` }, "not-a-file"),
    fetch(`${base}/api/review-stacks/${slug}/manifests/2/members/1/files/${fileId}?side=new&start=1&end=1`, { headers: { authorization: `Bearer ${key}` } }),
  ]);
  const refusedLineBodies = await Promise.all(refusedLines.map((response) => response.text()));
  assert(lineMiss.status === 404 && refusedLines.every((response) => response.status === 404), `retained lines answered someone they should not: ${refusedLines.map((r) => r.status).join(",")}`);
  assert(refusedLineBodies.every((body) => body === lineMissBody), "the retained-line refusals differ");

  console.log("stack privacy: all assertions passed");
  server.stop(true);
  process.exit(0);
} catch (err) {
  console.error(err);
  server.stop(true);
  process.exit(1);
}
