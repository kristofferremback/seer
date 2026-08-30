// Runs in its OWN process, with auth ENABLED.
//
// The suite sets AUTH_DISABLED=true, under which sessionUser returns the root user for
// every request — so a fetch with no cookie is not a signed-out visitor, and "a key gets
// no carried counts" cannot be asked there at all, because in-process every request looks
// signed in. Everything about who may read what one revision changed, and whose reading
// history is reported to whom, therefore has to be asked here.
//
// Every refusal is checked against the success it withholds, in this same process: a
// guarantee is only tested when the thing it withholds is demonstrably there.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "pr-movement-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "pr-movement-privacy-test";
process.env.SESSION_SECRET = "pr-movement-privacy-test-secret";

const workspace = process.env.MOVE_WORKSPACE!;
const slug = process.env.MOVE_SLUG!;
const revision = process.env.MOVE_REVISION!;
const owner = process.env.MOVE_OWNER!;
const member = process.env.MOVE_MEMBER!;
const stranger = process.env.MOVE_STRANGER!;
const key = process.env.MOVE_KEY!;
const otherKey = process.env.MOVE_OTHER_KEY!;
const patSlug = process.env.MOVE_PAT_SLUG!;
if (![workspace, slug, revision, owner, member, stranger, key, otherKey, patSlug, process.env.DATA_DIR].every(Boolean)) {
  throw new Error("pull request movement privacy env is incomplete");
}

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading a delta"); });
setReadRouter({
  async resolve(): Promise<never> { throw new Error("GitHub must not be routed while reading a delta"); },
  async open(): Promise<never> { throw new Error("GitHub must not be opened while reading a delta"); },
});

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const deltaPath = (target = slug, number = revision) => `/api/review-lineages/${target}/revisions/${number}/delta`;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  // The successes first, so every refusal below withholds something that is really there.
  const byMember = await get(deltaPath(), { cookie: cookie(owner) });
  const byKey = await get(deltaPath(), { authorization: `Bearer ${key}` });
  assert(byMember.status === 200 && byKey.status === 200, "a member or a workspace key could not read a delta");
  const delta = await byKey.json() as any;
  assert(delta.code.counts.unchanged + delta.code.counts.revised > 0, "the delta reports nothing at all");
  assert(byMember.headers.get("cache-control") === "no-store", "a delta is cacheable");

  // Everyone else gets one answer, down to the body: a slug is never an oracle for what a
  // workspace is reviewing, and neither is a revision number.
  const refusals = [
    await get(deltaPath(), { cookie: cookie(stranger) }),
    await get(deltaPath()),
    await get(deltaPath(), { authorization: `Bearer ${otherKey}` }),
    await get(deltaPath("NOT-A-SLUG"), { authorization: `Bearer ${key}` }),
    await get(deltaPath(slug, "0"), { authorization: `Bearer ${key}` }),
    await get(deltaPath(slug, "999"), { authorization: `Bearer ${key}` }),
    await get(deltaPath("no-such-review"), { authorization: `Bearer ${key}` }),
  ];
  const bodies = await Promise.all(refusals.map((response) => response.text()));
  assert(refusals.every((response) => response.status === 404), "a delta refusal used a status of its own");
  assert(refusals.every((response) => response.headers.get("cache-control") === "no-store"), "a delta refusal was cacheable");
  assert(refusals.every((response) => response.headers.get("content-type") === "application/json"), "a delta refusal changed content type");
  assert(new Set(bodies).size === 1, "a delta refusal disclosed existence");
  assert(bodies[0] === JSON.stringify({ error: "No such review" }, null, 2), "a delta refusal is not the shipped review body");

  // Personal handling state is the asking member's and nobody else's. A workspace key has
  // an owning user, and is still told nothing: a key is an agent's credential rather than
  // that person reading.
  const lineage = (headers: Record<string, string>) =>
    get(`/api/review-lineages/${slug}`, headers).then((response) => response.json() as Promise<any>);
  const ownerView = await lineage({ cookie: cookie(owner) });
  const memberView = await lineage({ cookie: cookie(member) });
  const keyView = await lineage({ authorization: `Bearer ${key}` });
  const target = (view: any) => view.revisions.find((row: any) => row.revision === Number(revision));
  assert(target(ownerView).carriedReads > 0, "the member whose reads carried was told nothing");
  assert(target(memberView).carriedReads === 0, "another member was told somebody else's carried reads");
  assert(target(keyView).carriedReads === null, "a workspace key was told a member's carried reads");
  // The same key, with the same owning user, still gets null even when it is that user's.
  assert(keyView.revisions.every((row: any) => row.carriedReads === null), "a key was told a carried-read count somewhere");

  // Drift and the delta itself are workspace facts rather than personal ones, so they read
  // the same for both members — what differs is only what each of them has handled.
  const revisionView = (headers: Record<string, string>) =>
    get(`/api/review-lineages/${slug}/revisions/${revision}`, headers).then((response) => response.json() as Promise<any>);
  const ownerRevision = await revisionView({ cookie: cookie(owner) });
  const memberRevision = await revisionView({ cookie: cookie(member) });
  assert(JSON.stringify(ownerRevision.drift) === JSON.stringify(memberRevision.drift), "drift differed between two members");
  assert(JSON.stringify(ownerRevision.delta) === JSON.stringify(memberRevision.delta), "the retained delta differed between two members");

  // Only the member whose personal credential owns PAT refresh sees the action. A
  // teammate sees the source movement, not an instruction the API would refuse.
  const patOwner = await (await get(`/${workspace}/r/${patSlug}/rev/1`, { cookie: cookie(member) })).text();
  const patTeammate = await (await get(`/${workspace}/r/${patSlug}/rev/1`, { cookie: cookie(owner) })).text();
  assert(patOwner.includes("New source · refresh required"), "the PAT owner was not offered their refresh");
  assert(patTeammate.includes("New source"), "a teammate was not told the PAT source moved");
  assert(!patTeammate.includes("refresh required"), "a teammate was offered somebody else's PAT refresh");

  // The reader page is a member page, and a stranger's is the review soft miss.
  const readerPages = [
    await get(`/${workspace}/r/${slug}/rev/${revision}`, { cookie: cookie(stranger) }),
    await get(`/${workspace}/r/${slug}/rev/${revision}`),
  ];
  const readerBodies = await Promise.all(readerPages.map((response) => response.text()));
  assert(readerPages.every((response) => response.status === 404), "a stranger read a promoted revision");
  assert(new Set(readerBodies).size === 1, "a reader refusal disclosed existence");

  console.log("pr movement privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
