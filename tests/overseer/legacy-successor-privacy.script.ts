// Auth-enabled process proof for legacy succession and successor-link privacy.
import "../app-env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_TOKEN = "legacy-successor-privacy-root";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy";
process.env.GOOGLE_CLIENT_SECRET = "dummy";
process.env.SESSION_SECRET = "legacy-successor-privacy-session-secret";
process.env.ALLOWED_EMAILS = "root@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-legacy-successor-privacy-"));

const { sessionCookie } = await import("../../src/auth");
const { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey, setWorkspaceVisibility } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { createReviewVersion } = await import("../../src/overseer/db");
const { createLegacySuccession } = await import("../../src/overseer/legacy-successor");
const { goldenStoredDoc } = await import("./fixtures/stored-review");

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    console.error(`ASSERT FAILED: ${message}`);
    process.exit(1);
  }
}

const server = await startServer();
const base = `http://localhost:${server.port}`;
const root = listMembers(legacyWorkspaceId()!)[0]!.id;
const workspace = createWorkspace("Private successor", root);
setWorkspaceVisibility(workspace, "private");
const ownerKey = mintApiKey(root, workspace, "owner");

const member = tinyId("usr");
db.run("INSERT INTO users VALUES (?, 'member@example.com', ?)", [member, Date.now()]);
db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, member, Date.now()]);
const memberKey = mintApiKey(member, workspace, "member");

const stranger = tinyId("usr");
db.run("INSERT INTO users VALUES (?, 'stranger@example.com', ?)", [stranger, Date.now()]);
const foreignWorkspace = createWorkspace("Foreign successor", stranger);
const foreignKey = mintApiKey(stranger, foreignWorkspace, "foreign");

const legacy = goldenStoredDoc();
legacy.kind = "single";
legacy.prs = [legacy.prs[0]!];
legacy.prs[0] = { ...legacy.prs[0]!, repo: "Acme/Private", number: 7 };
createReviewVersion(workspace, "private-legacy", legacy);
const created = createLegacySuccession({
  workspaceId: workspace,
  userId: root,
  keyId: ownerKey.id,
  idempotencyKey: "privacy-successor",
  legacySlug: "private-legacy",
  body: { kind: "single", lineageSlug: "private-successor" },
}).row;

db.run("UPDATE review_legacy_successions SET state='failed',failure='Private fork is deferred.' WHERE id=?", [created.id]);

const cookie = (userId: string) => sessionCookie(userId).split(";")[0]!;
const keyHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

const ownerRead = await fetch(`${base}/api/review-legacy-successions/${created.id}`, { headers: keyHeaders(ownerKey.token) });
assert(ownerRead.status === 200, `owner key reads workflow, got ${ownerRead.status}`);
assert(ownerRead.headers.get("cache-control") === "no-store", "owner workflow response is no-store");

const sessionRead = await fetch(`${base}/api/review-legacy-successions/${created.id}`, { headers: { cookie: cookie(root) } });
assert(sessionRead.status === 200, `creator session reads workflow, got ${sessionRead.status}`);
assert(sessionRead.headers.get("cache-control") === "no-store", "session read is no-store");
const memberRead = await fetch(`${base}/api/review-legacy-successions/${created.id}`, { headers: { cookie: cookie(member) } });
assert(memberRead.status === 200, `workspace member session reads workflow, got ${memberRead.status}`);
const signedOutRead = await fetch(`${base}/api/review-legacy-successions/${created.id}`);
assert(signedOutRead.status === 404, `signed-out workflow read is a soft miss, got ${signedOutRead.status}`);

const foreignRead = await fetch(`${base}/api/review-legacy-successions/${created.id}`, { headers: keyHeaders(foreignKey.token) });
assert(foreignRead.status === 404, `cross-workspace id is a miss, got ${foreignRead.status}`);
assert((await foreignRead.text()) === JSON.stringify({ error: "not_found" }, null, 2), "cross-workspace miss has generic bytes");

const malformed = await fetch(`${base}/api/review-legacy-successions/lsc_bad`, { headers: keyHeaders(ownerKey.token) });
assert(malformed.status === 404, `malformed id is a miss, got ${malformed.status}`);
assert((await malformed.text()) === JSON.stringify({ error: "not_found" }, null, 2), "malformed and cross-workspace misses match");

const memberRetry = await fetch(`${base}/api/review-legacy-successions/${created.id}/retry`, { method: "POST", headers: keyHeaders(memberKey.token) });
assert(memberRetry.status === 403, `another workspace member cannot spend creator GitHub access, got ${memberRetry.status}`);
assert((await memberRetry.json() as { rule?: string }).rule === "creator_required", "retry refusal carries its stable rule");
const secondOwnerKey = mintApiKey(root, workspace, "second owner key");
const otherOwnerKeyRetry = await fetch(`${base}/api/review-legacy-successions/${created.id}/retry`, { method: "POST", headers: keyHeaders(secondOwnerKey.token) });
assert(otherOwnerKeyRetry.status === 403, `another key from the creator cannot retry, got ${otherOwnerKeyRetry.status}`);

const noKeyCreate = await fetch(`${base}/api/reviews/private-legacy/successor`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "single", lineageSlug: "other" }),
});
assert(noKeyCreate.status === 401, `successor creation needs a key, got ${noKeyCreate.status}`);

const crossCreate = await fetch(`${base}/api/reviews/private-legacy/successor`, {
  method: "POST",
  headers: { ...keyHeaders(foreignKey.token), "content-type": "application/json", "idempotency-key": "cross-workspace" },
  body: JSON.stringify({ kind: "single", lineageSlug: "other" }),
});
assert(crossCreate.status === 404, `foreign key cannot resolve legacy source, got ${crossCreate.status}`);

const ownerPage = await fetch(`${base}/${workspace}/r/private-legacy`, { headers: { cookie: cookie(root) } });
assert(ownerPage.status === 200, `owner page resolves, got ${ownerPage.status}`);
const ownerHtml = await ownerPage.text();
assert(ownerHtml.includes("Immutable successor"), "member page shows permanent successor state");
assert(ownerHtml.includes("Private fork is deferred."), "failed successor renders its failure");
const successorHtml = ownerHtml.match(/<p class="meta successor">[\s\S]*?<\/p>/)?.[0] ?? "";
assert(successorHtml.includes("failed") && !successorHtml.includes("<a "), "failed successor is inline state without a dead link");
const strangerPage = await fetch(`${base}/${workspace}/r/private-legacy`, { headers: { cookie: cookie(stranger) } });
const missingPage = await fetch(`${base}/${workspace}/r/missing-legacy`, { headers: { cookie: cookie(stranger) } });
assert(strangerPage.status === 404 && missingPage.status === 404, "stranger and missing pages are both soft misses");
assert((await strangerPage.text()) === (await missingPage.text()), "private legacy denial matches missing bytes");

const minted = await fetch(`${base}/api/shares`, {
  method: "POST",
  headers: { ...keyHeaders(ownerKey.token), "content-type": "application/json" },
  body: JSON.stringify({ kind: "review", target: "private-legacy", label: "legacy capability" }),
});
assert(minted.status === 200, `legacy capability mints, got ${minted.status}`);
const share = await minted.json() as { url: string; token: string };
const shared = await fetch(`${base}${new URL(share.url).pathname}`);
assert(shared.status === 200, `legacy capability reads, got ${shared.status}`);
assert(!(await shared.text()).includes("Immutable successor"), "legacy capability does not widen to successor");
const asCredential = await fetch(`${base}/api/review-legacy-successions/${created.id}`, { headers: keyHeaders(share.token) });
assert(asCredential.status === 404, "a capability token is not an API key and gets the workflow soft miss");

server.stop(true);
console.log("legacy-successor-privacy: all assertions passed");
process.exit(0);
