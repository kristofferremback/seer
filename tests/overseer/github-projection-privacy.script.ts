import "../app-env";

process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "github-projection-privacy";
process.env.GOOGLE_CLIENT_SECRET = "github-projection-privacy";
process.env.SESSION_SECRET = "github-projection-privacy-secret";
process.env.ALLOWED_EMAILS = "projection-owner@example.com";

const { setKeyring, generateKey } = await import("../../src/envelope");
setKeyring({ activeId: "privacy", keys: new Map([["privacy", Buffer.from(generateKey(), "base64")]]) });
const { migrate } = await import("../../src/migrate");
const { db, legacyWorkspaceId, mintApiKey } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { digestOf } = await import("../../src/overseer/revision-db");
const { createGithubUserCredential } = await import("../../src/overseer/user-credentials");
const { setPersonalGithubGraphqlClientFactory } = await import("../../src/overseer/github-graphql");
const { sessionCookie } = await import("../../src/auth");
const { startServer } = await import("../../src/server");

migrate();
const workspace = legacyWorkspaceId()!;
const owner = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE email=?").get("projection-owner@example.com")!.id;
const teammate = tinyId("usr"), stranger = tinyId("usr"), otherWorkspace = tinyId("ws");
db.run("INSERT INTO users VALUES (?,?,?)", [teammate, "projection-teammate@example.com", Date.now()]);
db.run("INSERT INTO users VALUES (?,?,?)", [stranger, "projection-stranger@example.com", Date.now()]);
db.run("INSERT INTO memberships VALUES (?,?,?)", [workspace, teammate, Date.now()]);
db.run("INSERT INTO workspaces VALUES (?,?,'private',?)", [otherWorkspace, "Other", Date.now()]);
db.run("INSERT INTO memberships VALUES (?,?,?)", [otherWorkspace, stranger, Date.now()]);
const key = mintApiKey(owner, workspace, "privacy-key").token;

const slug = "projection-private";
const lineageId = tinyId("rln"), revisionId = tinyId("rvr"), captureId = tinyId("stg"), fileId = tinyId("stf");
const head = "a".repeat(40), baseSha = "b".repeat(40);
db.run("INSERT INTO review_lineages VALUES (?,?,?,'Acme/Private',73,'feature','main',?,'Private projection',1,NULL,?,?,?,?)", [lineageId, workspace, slug, baseSha, owner, tinyId("key"), Date.now(), Date.now()]);
db.run("INSERT INTO stage_captures VALUES (?,?,?,'Acme/Private',73,'feature','main',?,?,?,NULL,'completed',?)", [captureId, workspace, slug, head, baseSha, baseSha, Date.now()]);
db.run("INSERT INTO stage_capture_files VALUES (?,?,?,'assets/logo.png',NULL,'mode_changed',?,?, '100644','100755','blob','blob',0,0,'retained','retained',NULL,NULL,NULL,NULL)", [fileId, workspace, captureId, "c".repeat(40), "c".repeat(40)]);
const document = { identity: { lineageId, slug, revision: 1, title: "Private projection", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Private", repoId: 73, branch: "feature", originalBaseRef: "main", originalBaseSha: baseSha, baseRef: "main", sourceHeadSha: head, baseTipSha: baseSha, mergeBaseSha: baseSha }, builder: null, projects: [] };
db.run("INSERT INTO review_revisions VALUES (?,?,?,?,1,?,1,?,?,?)", [revisionId, workspace, lineageId, slug, captureId, JSON.stringify(document), digestOf(document), Date.now()]);
db.run("INSERT INTO review_lineage_prs VALUES (?,?,?,73,'Acme/Private',17,'feature','main','user',NULL,?,?,?,NULL)", [lineageId, workspace, slug, owner, "guc_placeholder", Date.now()]);
db.run("INSERT INTO review_pr_observations VALUES (?,?,?,73,'Acme/Private',17,'Private projection','open',0,0,'main',?,'feature',?,?,?,?,'user',NULL,?,'guc_placeholder','privacy-observation')", [tinyId("pob"), workspace, lineageId, baseSha, head, baseSha, Date.now(), Date.now(), owner]);
const ownerToken = "github_pat_owner_secret_that_must_not_render";
const ownerCredential = createGithubUserCredential({ userId: owner, kind: "pat", label: "owner-work", secret: ownerToken, accountLogin: "owner-octocat", accountId: 1, scopes: [], expiresAt: Date.now() + 60_000 });
const teammateToken = "github_pat_teammate_secret_that_must_not_render";
const teammateCredential = createGithubUserCredential({ userId: teammate, kind: "pat", label: "teammate-work", secret: teammateToken, accountLogin: "teammate-octocat", accountId: 2, scopes: [], expiresAt: Date.now() + 60_000 });
db.run("UPDATE review_lineage_prs SET credential_id=? WHERE lineage_id=?", [ownerCredential, lineageId]);
db.run("UPDATE review_pr_observations SET credential_id=? WHERE lineage_id=?", [ownerCredential, lineageId]);

let githubCalls = 0;
setPersonalGithubGraphqlClientFactory(() => ({
  async pullRequest() { githubCalls++; throw new Error("render reached GitHub"); },
  async markFileAsViewed() { githubCalls++; }, async unmarkFileAsViewed() { githubCalls++; },
  async addReview() { githubCalls++; return { reviewId: "x", commentNodeIds: [] }; },
  async addThreadReply() { githubCalls++; return { commentNodeId: "x", databaseId: null }; },
  async resolveThread() { githubCalls++; }, async unresolveThread() { githubCalls++; },
  async findReviewThreadByComment() { githubCalls++; return null; }, async recoverReview() { githubCalls++; return { kind: "none" }; },
}));

const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (userId: string) => sessionCookie(userId).split(";", 1)[0]!;
const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const visible = (page: string) => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");

try {
  const ownerPage = await fetch(`${base}/${workspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(owner) } });
  const ownerHtml = visible(await ownerPage.text());
  assert(ownerPage.status === 200 && ownerHtml.includes("Sync Viewed") && ownerHtml.includes("Approve this commit"), "owner GitHub controls are absent");
  for (const secret of [ownerCredential, teammateCredential, ownerToken, teammateToken, owner, teammate]) assert(!ownerHtml.includes(secret), `owner HTML exposed ${secret}`);
  assert(ownerHtml.includes("owner-octocat") && !ownerHtml.includes("teammate-octocat"), "owner HTML crossed personal credentials");

  const teammatePage = await fetch(`${base}/${workspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(teammate) } });
  const teammateHtml = visible(await teammatePage.text());
  assert(teammatePage.status === 200 && teammateHtml.includes("teammate-octocat") && !teammateHtml.includes("owner-octocat"), "teammate HTML crossed personal credentials");
  for (const secret of [ownerCredential, teammateCredential, ownerToken, teammateToken, owner, teammate]) assert(!teammateHtml.includes(secret), `teammate HTML exposed ${secret}`);

  const ownerApi = await fetch(`${base}/api/review-lineages/${slug}/github-projection?workspace=${workspace}`, { headers: { cookie: cookie(owner) } });
  const ownerBody = await ownerApi.json() as any;
  assert(ownerApi.status === 200 && ownerBody.projection.credentials.length === 1 && ownerBody.projection.credentials[0].account === "owner-octocat", "owner API projection is wrong");
  const ownerBytes = JSON.stringify(ownerBody);
  for (const secret of [ownerCredential, teammateCredential, ownerToken, teammateToken, owner, teammate]) assert(!ownerBytes.includes(secret), `owner API exposed ${secret}`);
  const ownerChoice = ownerBody.projection.credentials[0].value as string;

  const forged = await fetch(`${base}/${workspace}/r/${slug}/github/viewed`, {
    method: "POST", headers: { cookie: cookie(teammate), accept: "application/json" },
    body: new URLSearchParams({ enabled: "true", credential: ownerChoice, return: `/${workspace}/r/${slug}/rev/1` }),
  });
  assert(forged.status === 422 && (await forged.json() as any).rule === "credential_refused", "another member used the owner's credential choice");
  assert(!db.query("SELECT 1 FROM review_github_projection_preferences WHERE lineage_id=? AND user_id=?").get(lineageId, teammate), "forged choice stored a preference");

  const keyApi = await fetch(`${base}/api/review-lineages/${slug}/github-projection`, { headers: { authorization: `Bearer ${key}` } });
  const keyBody = await keyApi.json() as any;
  assert(keyApi.status === 200 && keyBody.projection === null && !("viewed" in keyBody) && !("submissions" in keyBody), "API key received personal detail or aggregates");
  assert(!JSON.stringify(keyBody).includes("octocat") && !JSON.stringify(keyBody).includes("github_"), "API key learned a personal choice");

  const unknownPost = await fetch(`${base}/${workspace}/r/never-existed/github/viewed`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ enabled: "true" }) });
  const keyPost = await fetch(`${base}/${workspace}/r/${slug}/github/viewed`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new URLSearchParams({ enabled: "true", credential: ownerChoice }) });
  assert(keyPost.status === unknownPost.status && await keyPost.text() === await unknownPost.text(), "an API key page mutation disclosed the target");

  const origin = await fetch(`${base}/${workspace}/r/${slug}/github/viewed`, { method: "POST", headers: { cookie: cookie(owner), origin: "https://evil.example" }, body: new URLSearchParams({ enabled: "true", credential: ownerChoice }) });
  assert(origin.status === 403 && await origin.text() === "Bad origin", "GitHub mutation accepted a foreign origin");

  const strangerPage = await fetch(`${base}/${workspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(stranger) } });
  const unknownPage = await fetch(`${base}/${workspace}/r/no-such/rev/1`, { headers: { cookie: cookie(stranger) } });
  assert(strangerPage.status === unknownPage.status && await strangerPage.text() === await unknownPage.text(), "stranger page refusal disclosed the review");
  const cross = await fetch(`${base}/${otherWorkspace}/r/${slug}/rev/1`, { headers: { cookie: cookie(stranger) } });
  assert(cross.status === unknownPage.status, "cross-workspace review did not soft miss");

  const minted = await fetch(`${base}/api/shares`, { method: "POST", headers: { cookie: cookie(owner), "content-type": "application/json" }, body: JSON.stringify({ workspace, kind: "review_document", target: revisionId, label: "projection privacy" }) });
  assert(minted.status === 200, "capability mint failed");
  const share = await minted.json() as any;
  const capabilityHtml = visible(await (await fetch(`${base}/s/${share.token}`)).text());
  for (const absent of ["GitHub", "Sync Viewed", "Approve this commit", "Post to GitHub", ownerCredential, ownerToken, owner]) assert(!capabilityHtml.includes(absent), `capability exposed ${absent}`);
  assert(githubCalls === 0, `offline rendering made ${githubCalls} GitHub calls`);

  console.log("github projection privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
