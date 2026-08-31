import "../app-env";

process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "capability-privacy-test";
process.env.GOOGLE_CLIENT_SECRET = "capability-privacy-test";
process.env.SESSION_SECRET = "capability-privacy-test-secret";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const workspace = required("CAP_WORKSPACE");
const owner = required("CAP_OWNER");
const stranger = required("CAP_STRANGER");
const key = required("CAP_KEY");
const revisionId = required("CAP_REVISION");
const accountId = required("CAP_ACCOUNT");
const manifestId = required("CAP_MANIFEST");
const stackAccountId = required("CAP_STACK_ACCOUNT");
const fileId = required("CAP_FILE");
const laterFileId = required("CAP_LATER_FILE");
const attachmentId = required("CAP_ATTACHMENT");

const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
const { newShareToken } = await import("../../src/ids");
const { db, getUser } = await import("../../src/db");
const ownerEmail = getUser(owner)?.email ?? "missing-owner-email";
setGithubClientFactory(() => { throw new Error("GitHub must not be reachable while reading a capability"); });
setReadRouter({
  async resolve() { throw new Error("GitHub must not be resolved while reading a capability"); },
  async open() { throw new Error("GitHub must not be opened while reading a capability"); },
});

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const visible = (page: string): string => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
const attributeUrls = (page: string): string[] => [...page.matchAll(/\s(?:href|action|data-[a-z0-9-]+)="([^"]*)"/gi)]
  .map((match) => match[1]!)
  .filter((value) => value.startsWith("/") || /^https?:\/\//.test(value));
const mint = (kind: string, target: string, headers: Record<string, string>) => fetch(`${base}/api/shares`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ workspace, kind, target, label: `${kind}-${target}` }),
});
const shape = async (response: Response) => ({
  status: response.status,
  type: response.headers.get("content-type"),
  cache: response.headers.get("cache-control"),
  referrer: response.headers.get("referrer-policy"),
  robots: response.headers.get("x-robots-tag"),
  body: await response.text(),
});

try {
  const sessionMint = await mint("review_document", revisionId, { cookie: cookie(owner) });
  const keyMint = await mint("review_document", accountId, { authorization: `Bearer ${key}` });
  const manifestMint = await mint("stack_document", manifestId, { authorization: `Bearer ${key}` });
  const stackMint = await mint("stack_document", stackAccountId, { cookie: cookie(owner) });
  assert([sessionMint, keyMint, manifestMint, stackMint].every((response) => response.status === 200), "session and key did not mint all four document kinds");
  const [revision, account, manifest, stack] = await Promise.all([sessionMint, keyMint, manifestMint, stackMint].map((response) => response.json() as Promise<any>));

  for (const minted of [revision, account, manifest, stack]) {
    const response = await fetch(`${base}/s/${minted.token}`);
    assert(response.status === 200, `${minted.document.kind} did not render signed out`);
    assert(response.headers.get("cache-control") === "no-store", "a capability success was cacheable");
    assert(response.headers.get("referrer-policy") === "no-referrer", "a capability success can send its token as a referrer");
    assert(response.headers.get("x-robots-tag") === "noindex, nofollow", "a capability success is indexable");
    const rawHtml = await response.text();
    const html = visible(rawHtml);
    for (const secret of [ownerEmail, "capability-stranger@example.com", owner, "usr_", "key_", "credential", "installation", "secret-project", `/${workspace}/`, "/settings", "/projects", "/refresh", "/annotations", "Mark read", "Mark unread", "Approve", "Acknowledge"]) {
      assert(!html.includes(secret), `${minted.document.kind} exposed ${secret}`);
    }
    assert(rawHtml.includes('name="robots" content="noindex,nofollow"'), "the robots meta tag is absent");
  }
  const revisionHtml = await (await fetch(`${base}/s/${revision.token}`)).text();
  const accountHtml = await (await fetch(`${base}/s/${account.token}`)).text();
  const manifestHtml = await (await fetch(`${base}/s/${manifest.token}`)).text();
  assert(!revisionHtml.includes("Witness account 1"), "a revision capability gained an account");
  assert(accountHtml.includes("Witness account 1") && !accountHtml.includes("Witness account 2"), "an account capability moved");
  assert(!manifestHtml.includes("One exact member"), "a manifest capability gained a stack account");

  const stackFocus = await fetch(`${base}/s/${stack.token}?review=whole&page=1`);
  assert(stackFocus.status === 200, "the signed-out whole-stack focus did not render");
  const stackFocusHtml = visible(await stackFocus.text());
  assert(stackFocusHtml.includes(`href="/s/${stack.token}?layer=exact-review"`), "the stack seam did not use its capability-relative layer URL");
  const stackFocusUrls = attributeUrls(stackFocusHtml);
  assert(!stackFocusUrls.some((value) => value.includes(`/${workspace}/`)), "a href, action, or data URL exposed the private workspace path");
  assert(stackFocusUrls.filter((value) => value.startsWith("/")).every((value) => value.startsWith(`/s/${stack.token}`)), "a local stack capability URL left the token path");

  const retained = await fetch(`${base}/s/${revision.token}/files/${fileId}?side=new&start=1&end=1`);
  assert(retained.status === 200 && retained.headers.get("cache-control") === "no-store", "owned retained lines did not succeed privately");
  const image = await fetch(`${base}/s/${account.token}/a/${attachmentId}`);
  assert(image.status === 200 && image.headers.get("cache-control") === "no-store", "copied attachment did not succeed privately");

  const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));
  const misses = await Promise.all([
    fetch(`${base}/s/not-a-token`),
    fetch(`${base}/s/${revision.token}/files/${laterFileId}?side=new&start=1&end=1`),
    fetch(`${base}/s/${revision.token}/files/not-a-file?side=new&start=1&end=1`),
    fetch(`${base}/s/${stack.token}/m/2/files/${fileId}?side=new&start=1&end=1`),
    fetch(`${base}/s/${account.token}/a/att_0000000000`),
    fetch(`${base}/s/${account.token}/threads`),
    fetch(`${base}/s/${stack.token}?review=not-a-group`),
  ].map(async (pending) => shape(await pending)));
  for (const miss of misses) assert(JSON.stringify(miss) === JSON.stringify(unknown), "a capability soft miss is distinguishable");

  const strangerList = await fetch(`${base}/api/shares?workspace=${workspace}`, { headers: { cookie: cookie(stranger) } });
  assert(strangerList.status === 404, "a non-member listed capability rows");
  const post = await fetch(`${base}/s/${revision.token}`, { method: "POST", body: "x" });
  assert(post.status === 405, "a capability accepted a mutation verb");
  assert(post.headers.get("cache-control") === "no-store" && post.headers.get("referrer-policy") === "no-referrer", "a mutation refusal missed share privacy headers");

  const redirectCases = [
    ["review_document", revisionId, `/${workspace}/r/exact-review/rev/1`],
    ["review_document", accountId, `/${workspace}/r/exact-review/v/1`],
    ["stack_document", manifestId, `/${workspace}/r-stacks/exact-stack/v/1`],
    ["stack_document", stackAccountId, `/${workspace}/r-stacks/exact-stack/v/1/account`],
  ] as const;
  for (const [kind, target, location] of redirectCases) {
    const revoked = await mint(kind, target, { authorization: `Bearer ${key}` });
    const revokedBody = await revoked.json() as any;
    const revoke = await fetch(`${base}/api/shares/${revokedBody.id}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    assert(revoke.status === 200, "the owning key could not revoke its capability");
    assert(JSON.stringify(await shape(await fetch(`${base}/s/${revokedBody.token}`))) === JSON.stringify(unknown), "a revoked capability differs from unknown");
    if (target === revisionId) {
      const stored = db.query<{ doc: string }, [string]>("SELECT doc FROM review_revisions WHERE id = ?").get(revisionId)!;
      const logged: unknown[][] = [];
      const originalError = console.error;
      db.run("UPDATE review_revisions SET doc = '{' WHERE id = ?", [revisionId]);
      console.error = (...args: unknown[]) => { logged.push(args); };
      try {
        assert(JSON.stringify(await shape(await fetch(`${base}/s/${revokedBody.token}`))) === JSON.stringify(unknown), "a signed-out dead capability with a corrupt target differs from unknown");
      } finally {
        console.error = originalError;
        db.run("UPDATE review_revisions SET doc = ? WHERE id = ?", [stored.doc, revisionId]);
      }
      assert(logged.length === 0, "a signed-out dead capability parsed its target before the owning-member check");
    }
    const member = await fetch(`${base}/s/${revokedBody.token}`, { headers: { cookie: cookie(owner) }, redirect: "manual" });
    assert(member.status === 302 && member.headers.get("location") === location, `${kind} dead-link redirect lost its exact private document`);
  }

  console.log("capability privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
