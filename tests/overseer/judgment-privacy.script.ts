import "../app-env";

process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "judgment-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "judgment-privacy-test";
process.env.SESSION_SECRET = "judgment-privacy-test-secret";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const workspace = required("JUDGMENT_WORKSPACE");
const otherWorkspace = required("JUDGMENT_OTHER_WORKSPACE");
const owner = required("JUDGMENT_OWNER");
const stranger = required("JUDGMENT_STRANGER");
const key = required("JUDGMENT_KEY");
const slug = required("JUDGMENT_SLUG");
const revisionId = required("JUDGMENT_REVISION");
const accountId = required("JUDGMENT_ACCOUNT");
const itemId = required("JUDGMENT_ITEM");
const stackSlug = required("JUDGMENT_STACK_SLUG");
const stackManifestId = required("JUDGMENT_STACK_MANIFEST");
const stackAccountId = required("JUDGMENT_STACK_ACCOUNT");
const stackItemId = required("JUDGMENT_STACK_ITEM");

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading judgment state"); });
setReadRouter({
  async resolve() { throw new Error("GitHub must not be resolved while reading judgment state"); },
  async open() { throw new Error("GitHub must not be opened while reading judgment state"); },
  async openGraphql() { throw new Error("GitHub GraphQL must not be opened while reading judgment state"); },
});

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const visible = (page: string): string => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
const shape = async (response: Response) => ({
  status: response.status,
  type: response.headers.get("content-type"),
  cache: response.headers.get("cache-control"),
  body: await response.text(),
});

try {
  const pagePath = `/${workspace}/r/${slug}/v/1?review=all-material`;
  const memberPage = await fetch(`${base}${pagePath}`, { headers: { cookie: cookie(owner) } });
  assert(memberPage.status === 200, "the member account page did not render");
  const memberHtml = visible(await memberPage.text());
  assert(memberHtml.includes("acknowledgement-form") && memberHtml.includes("judgment-form"), "member handling controls are absent");
  assert(memberHtml.includes("judgment-teammate") && !memberHtml.includes("judgment-teammate@example.com"), "private judgment history did not use its stable local member label");

  const unknownPage = await shape(await fetch(`${base}/${workspace}/r/never-existed/rev/1`));
  const pageMisses = await Promise.all([
    fetch(`${base}/${workspace}/r/${slug}/rev/1`),
    fetch(`${base}/${workspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(stranger) } }),
    fetch(`${base}/${workspace}/r/${slug}/rev/nope`, { headers: { cookie: cookie(owner) } }),
    fetch(`${base}/${otherWorkspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(owner) } }),
    fetch(`${base}/${workspace}/r/${slug}/rev/1/items/sti_0000000000/acknowledge`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ acknowledged: "true" }) }),
    fetch(`${base}/${workspace}/r/${slug}/rev/1/judgment`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ verdict: "approved", comment: "" }) }),
    fetch(`${base}/${workspace}/r/${slug}/rev/1/items/stf_0000000000/acknowledge`, { method: "POST", headers: { cookie: cookie(owner) }, body: new URLSearchParams({ acknowledged: "true" }) }),
    fetch(`${base}/${workspace}/r/${slug}/rev/1/items/not-an-id/acknowledge`, { method: "POST", headers: { cookie: cookie(owner) }, body: new URLSearchParams({ acknowledged: "true" }) }),
  ].map(async (pending) => shape(await pending)));
  for (const miss of pageMisses) assert(JSON.stringify(miss) === JSON.stringify(unknownPage), "a page refusal is distinguishable");
  assert(unknownPage.cache === "no-store", "a private page refusal is cacheable");

  const unknownStackPage = await shape(await fetch(`${base}/${workspace}/r-stacks/never-existed/v/1`));
  const stackMisses = await Promise.all([
    fetch(`${base}/${workspace}/r-stacks/${stackSlug}/v/1`, { headers: { cookie: cookie(stranger) } }),
    fetch(`${base}/${otherWorkspace}/r-stacks/${stackSlug}/v/1`, { headers: { cookie: cookie(owner) } }),
    fetch(`${base}/${workspace}/r-stacks/${stackSlug}/v/1/members/1/items/${stackItemId}/acknowledge`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ acknowledged: "true" }) }),
    fetch(`${base}/${workspace}/r-stacks/${stackSlug}/v/1/members/1/items/not-an-id/acknowledge`, { method: "POST", headers: { cookie: cookie(owner) }, body: new URLSearchParams({ acknowledged: "true" }) }),
    fetch(`${base}/${workspace}/r-stacks/${stackSlug}/v/1/judgment`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ verdict: "approved", comment: "" }) }),
  ].map(async (pending) => shape(await pending)));
  for (const miss of stackMisses) assert(JSON.stringify(miss) === JSON.stringify(unknownStackPage), "a stack page refusal is distinguishable");

  const badOrigin = await fetch(`${base}/${workspace}/r/${slug}/rev/1/items/${itemId}/acknowledge`, {
    method: "POST", headers: { cookie: cookie(owner), origin: "https://evil.example" },
    body: new URLSearchParams({ acknowledged: "true" }),
  });
  assert(badOrigin.status === 403 && await badOrigin.text() === "Bad origin", "the member mutation accepted a foreign origin");

  const sessionApi = await fetch(`${base}/api/review-lineages/${slug}/revisions/1/judgments`, { headers: { cookie: cookie(owner) } });
  assert(sessionApi.status === 200, "the member judgment API did not answer");
  const sessionBody = await sessionApi.json() as any;
  assert(sessionBody.handling?.required === 3 && sessionBody.handling?.acknowledged === 0, "the session did not receive only its active handling summary");
  assert(sessionBody.judgments.length === 1 && sessionBody.judgments[0].by?.kind === "member" && sessionBody.judgments[0].by?.label === "Member", "the session API did not use its safe member projection");
  const keyApi = await fetch(`${base}/api/review-lineages/${slug}/revisions/1/judgments`, { headers: { authorization: `Bearer ${key}` } });
  const keyBody = await keyApi.json() as any;
  assert(keyApi.status === 200 && keyBody.handling === null, "an API key received personal handling");
  assert(keyBody.judgments.length === 1 && keyBody.judgments[0].by?.kind === "member" && keyBody.judgments[0].by?.label === "Member", "the API key did not receive a safe member actor");
  assert(!JSON.stringify(keyBody).includes("@") && !JSON.stringify(keyBody).includes("judgment-teammate@example.com"), "an API key learned a judgment author's email");

  const stackKeyApi = await fetch(`${base}/api/review-stacks/${stackSlug}/manifests/1/judgments`, { headers: { authorization: `Bearer ${key}` } });
  assert(stackKeyApi.status === 200 && (await stackKeyApi.json() as any).judgments.length === 0, "the key could not read safe stack judgment history");
  const unknownStackApi = await shape(await fetch(`${base}/api/review-stacks/never-existed/manifests/1/judgments`, { headers: { authorization: `Bearer ${key}` } }));
  const stackApiMiss = await shape(await fetch(`${base}/api/review-stacks/${stackSlug}/manifests/1/judgments`, { headers: { cookie: cookie(stranger) } }));
  assert(JSON.stringify(stackApiMiss) === JSON.stringify(unknownStackApi), "a stack API refusal is distinguishable");

  const unknownApi = await shape(await fetch(`${base}/api/review-lineages/never-existed/revisions/1/judgments`, { headers: { authorization: `Bearer ${key}` } }));
  const apiMisses = await Promise.all([
    fetch(`${base}/api/review-lineages/${slug}/revisions/1/judgments`),
    fetch(`${base}/api/review-lineages/${slug}/revisions/1/judgments`, { headers: { cookie: cookie(stranger) } }),
    fetch(`${base}/api/review-lineages/${slug}/revisions/nope/judgments`, { headers: { cookie: cookie(owner) } }),
  ].map(async (pending) => shape(await pending)));
  for (const miss of apiMisses) assert(JSON.stringify(miss) === JSON.stringify(unknownApi), "an API refusal is distinguishable");

  const minted = await fetch(`${base}/api/shares`, {
    method: "POST", headers: { cookie: cookie(owner), "content-type": "application/json" },
    body: JSON.stringify({ workspace, kind: "review_document", target: accountId, label: "judgment privacy" }),
  });
  assert(minted.status === 200, "the exact account capability was not minted");
  const share = await minted.json() as any;
  const capability = await fetch(`${base}/s/${share.token}?review=all-material`);
  assert(capability.status === 200, "the account capability did not render");
  const capabilityHtml = visible(await capability.text());
  for (const absent of ["acknowledgement-form", "judgment-form", "Judgment", "Approve this version", "Request changes", "dev@localhost", "judgment-teammate@example.com", owner, revisionId]) {
    assert(!capabilityHtml.includes(absent), `the capability exposed ${absent}`);
  }
  const stackMint = await fetch(`${base}/api/shares`, {
    method: "POST", headers: { cookie: cookie(owner), "content-type": "application/json" },
    body: JSON.stringify({ workspace, kind: "stack_document", target: stackAccountId, label: "stack judgment privacy" }),
  });
  assert(stackMint.status === 200, `the exact stack account capability was not minted: ${stackMint.status} ${await stackMint.clone().text()}`);
  const stackShare = await stackMint.json() as any;
  const stackCapabilityHtml = visible(await (await fetch(`${base}/s/${stackShare.token}?review=whole`)).text());
  for (const absent of ["acknowledgement-form", "judgment-form", "Judgment", "Approve this version", owner, stackManifestId]) {
    assert(!stackCapabilityHtml.includes(absent), `the stack capability exposed ${absent}`);
  }

  const capabilityWrite = await fetch(`${base}/s/${share.token}`, { method: "POST", body: "x" });
  assert(capabilityWrite.status === 405, "the capability accepted a mutation");

  console.log("judgment privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
