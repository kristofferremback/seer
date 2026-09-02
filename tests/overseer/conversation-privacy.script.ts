import "../app-env";
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "conversation-privacy";
process.env.GOOGLE_CLIENT_SECRET = "conversation-privacy";
process.env.SESSION_SECRET = "conversation-privacy-secret";

const need = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value; };
const workspace = need("CONV_WORKSPACE");
const slug = need("CONV_SLUG");
const stackSlug = need("CONV_STACK_SLUG");
const owner = need("CONV_OWNER");
const member = need("CONV_MEMBER");
const stranger = need("CONV_STRANGER");
const key = need("CONV_KEY");
const memberKey = need("CONV_MEMBER_KEY");
const foreignKey = need("CONV_FOREIGN_KEY");
const threadId = need("CONV_THREAD");
const ownerCredential = need("CONV_OWNER_CREDENTIAL");
const observedCredential = need("CONV_OBSERVED_CREDENTIAL");

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const { startServer } = await import("../../src/server");
const { sessionCookie } = await import("../../src/auth");
const { db } = await import("../../src/db");
const { setGithubClientFactory, setReadRouter } = await import("../../src/overseer/github-app");
let graphqlCalls = 0;
setGithubClientFactory(() => { throw new Error("conversation privacy reads must stay offline"); });
setReadRouter({
  async resolve() { throw new Error("conversation refresh must not reroute its actor"); },
  async open() { throw new Error("conversation privacy render opened GitHub"); },
  async openGraphql(openedWorkspace, actor) {
    graphqlCalls++;
    assert(openedWorkspace === workspace, "refresh opened another workspace");
    assert(JSON.stringify(actor) === JSON.stringify({ kind: "user", userId: owner, credentialId: ownerCredential }), "refresh did not open the relation actor recorded on its import row");
    return { async listReviewThreads() { return { threads: [], reviews: [], complete: true, truncated: false, logicalBodyBytes: 0 }; } };
  },
});
const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (id: string) => sessionCookie(id).split(";")[0]!;
const shape = async (response: Response) => ({ status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), body: await response.text() });
const list = (headers: Record<string, string>) => fetch(`${base}/api/review-lineages/${slug}/conversations`, { headers });
const reply = (headers: Record<string, string>, body: string, keyName: string) => fetch(`${base}/${workspace}/review-threads/${threadId}/replies`, { method: "POST", headers: { accept: "application/json", ...headers }, body: new URLSearchParams({ body, idempotencyKey: keyName }) });

try {
  const ownerRead = await list({ cookie: cookie(owner) });
  const memberRead = await list({ cookie: cookie(member) });
  const keyRead = await list({ authorization: `Bearer ${key}` });
  assert(ownerRead.status === 200 && memberRead.status === 200 && keyRead.status === 200, "authorized conversation reads failed");
  const ownerText = await ownerRead.text(); const memberText = await memberRead.text(); const keyText = await keyRead.text();
  assert(ownerText.includes('"label": "You"'), "the current member was not projected as You");
  assert(memberText.includes('"label": "Member"') && !memberText.includes('"label": "You"'), "another member received personal identity");
  for (const text of [ownerText, memberText, keyText]) for (const secret of [owner, member, stranger, "key_", "credential", "installation_id"]) assert(!text.includes(secret), `conversation projection exposed ${secret}`);

  const strangerRead = await shape(await list({ cookie: cookie(stranger) }));
  const foreignRead = await shape(await list({ authorization: `Bearer ${foreignKey}` }));
  assert(JSON.stringify(strangerRead) === JSON.stringify(foreignRead), "foreign member and foreign key misses differ");
  const signedOut = await list({});
  assert(signedOut.status === 401, "signed-out API inventory did not require credentials");

  const stackRead = await fetch(`${base}/api/review-stacks/${stackSlug}/manifests/1/conversations`, { headers: { authorization: `Bearer ${key}` } });
  assert(stackRead.status === 200 && (await stackRead.text()).includes("First message"), "exact stack conversation read failed");
  const foreignStack = await fetch(`${base}/api/review-stacks/${stackSlug}/manifests/1/conversations`, { headers: { authorization: `Bearer ${foreignKey}` } });
  assert(foreignStack.status === 404, "foreign workspace key read a stack conversation");
  assert((await fetch(`${base}/api/review-stacks/${stackSlug}/manifests/99/conversations`, { headers: { authorization: `Bearer ${key}` } })).status === 404, "unknown stack pin did not soft miss");

  assert((await reply({ cookie: cookie(owner) }, "Owner reply", "privacy-owner-reply")).status === 200, "owner session reply failed");
  assert((await reply({ cookie: cookie(member) }, "Member reply", "privacy-member-reply")).status === 200, "workspace member reply failed");
  const strangerWrite = await shape(await reply({ cookie: cookie(stranger) }, "No", "privacy-stranger-reply"));
  const foreignWrite = await shape(await reply({ authorization: `Bearer ${foreignKey}` }, "No", "privacy-foreign-reply"));
  assert(strangerWrite.status === 404 && foreignWrite.status === 404, "foreign local writes did not soft miss");

  const agent = await fetch(`${base}/api/review-threads/${threadId}/replies`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "privacy-agent-reply" }, body: JSON.stringify({ body: "Agent reply", agentName: "Privacy agent", agentModel: "test" }) });
  assert(agent.status === 200, "owned API key could not append its agent reply");
  const sessionAgent = await fetch(`${base}/api/review-threads/${threadId}/replies`, { method: "POST", headers: { cookie: cookie(owner), "content-type": "application/json" }, body: JSON.stringify({ body: "No", agentName: "Member", agentModel: "none", idempotencyKey: "privacy-session-agent" }) });
  assert(sessionAgent.status === 403, "a session used the agent route");

  const refresh = (token: string, idempotencyKey: string, bodyKey = idempotencyKey) => fetch(`${base}/api/review-lineages/${slug}/conversations/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ idempotencyKey: bodyKey }),
  });
  const returnPath = `/${workspace}/r/${slug}/rev/1?review=exact`;
  const sessionRefresh = (userId: string, idempotencyKey: string, bodyKey = idempotencyKey, returnTo = returnPath) => fetch(`${base}/api/review-lineages/${slug}/conversations/refresh?workspace=${workspace}`, {
    method: "POST",
    headers: { cookie: cookie(userId), origin: base, "idempotency-key": idempotencyKey },
    body: new URLSearchParams({ idempotencyKey: bodyKey, return: returnTo }),
    redirect: "manual",
  });
  assert((await refresh(memberKey, "privacy-member-refresh")).status === 403, "another member's key spent the PAT owner actor");
  const memberJson = await fetch(`${base}/api/review-lineages/${slug}/conversations/refresh`, { method: "POST", headers: { cookie: cookie(member), origin: base, "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "privacy-member-session-refresh" }) });
  assert(memberJson.status === 403 && memberJson.headers.get("content-type")?.includes("application/json"), "another member session did not receive the JSON owner refusal");
  assert((await refresh(foreignKey, "privacy-foreign-refresh")).status === 404, "a foreign workspace key reached conversation refresh");
  assert((await refresh(key, "privacy-mismatch-header", "privacy-mismatch-body")).status === 409, "mismatched idempotency keys were accepted");

  const sessionKey = "privacy-owner-session-refresh";
  const sessionSuccess = await sessionRefresh(owner, sessionKey);
  assert(sessionSuccess.status === 303 && sessionSuccess.headers.get("location") === returnPath, "session form success did not return to the review");
  assert(graphqlCalls === 1, "owner refresh did not make exactly one GraphQL import");
  const sessionReplay = await sessionRefresh(owner, sessionKey);
  assert(sessionReplay.status === 303 && sessionReplay.headers.get("location") === returnPath && graphqlCalls === 1, "session form replay did not return without calling GitHub");
  const sessionCooldown = await sessionRefresh(owner, "privacy-owner-session-cooldown");
  assert(sessionCooldown.status === 303 && sessionCooldown.headers.get("location") === returnPath, "session form cooldown did not return to the review");
  const sessionConflict = await sessionRefresh(owner, "privacy-session-conflict-header", "privacy-session-conflict-body", "https://evil.example/not-the-review");
  assert(sessionConflict.status === 303 && sessionConflict.headers.get("location") === `/${workspace}/r/${slug}`, "session form idempotency refusal did not use the safe review fallback");
  const sessionOwnerRefusal = await sessionRefresh(member, "privacy-member-form-refresh");
  assert(sessionOwnerRefusal.status === 303 && sessionOwnerRefusal.headers.get("location") === returnPath, "session form owner refusal did not return to the review");

  const refreshed = await refresh(key, sessionKey);
  assert(refreshed.status === 200 && refreshed.headers.get("content-type")?.includes("application/json"), "PAT owner key did not receive the JSON replay");
  const refreshedText = await refreshed.text();
  for (const secret of [owner, ownerCredential, observedCredential, "credential_id", "user_id", "installation_id", "lease_token"]) assert(!refreshedText.includes(secret), `refresh response exposed ${secret}`);
  const audit = db.query<{ actor_kind: string; user_id: string | null; credential_id: string | null }, [string, string]>("SELECT actor_kind, user_id, credential_id FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(workspace, db.query<{ id: string }, [string, string]>("SELECT id FROM review_lineages WHERE workspace_id = ? AND slug = ?").get(workspace, slug)!.id)!;
  assert(JSON.stringify(audit) === JSON.stringify({ actor_kind: "user", user_id: owner, credential_id: ownerCredential }), "import audit did not record the actor actually opened");
  assert((await refresh(key, sessionKey)).status === 200 && graphqlCalls === 1, "JSON idempotent refresh replay called GitHub again");
  const cooldown = await refresh(key, "privacy-owner-refresh-fresh");
  assert(cooldown.status === 409 && (await cooldown.text()).includes("conversation_refresh_cooldown"), "JSON fresh key bypassed the refresh cooldown");
  console.log("conversation privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
