import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { generateKey, setKeyring } from "../../src/envelope";
import { tinyId } from "../../src/ids";
import { migrate } from "../../src/migrate";
import { startServer } from "../../src/server";
import { createGithubUserCredential } from "../../src/overseer/user-credentials";
import { digestOf } from "../../src/overseer/revision-db";
import { setPersonalGithubGraphqlClientFactory, type PersonalGithubGraphqlClient } from "../../src/overseer/github-graphql";
import { getGithubProjectionPreference, queueCurrentViewedJobs, runNextGithubViewedJob, setGithubProjectionPreference } from "../../src/overseer/github-viewed";
import { createGithubReviewSubmission } from "../../src/overseer/github-submissions";
import { requiredAcknowledgements } from "../../src/overseer/revision-delta";
import { setRevisionAcknowledgement } from "../../src/overseer/acknowledgements-db";
import { getStageCaptureForWorkspaces } from "../../src/stage/db";
import { ChromePage } from "../chrome";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let owner = "";
let sequence = 0;
let reviewSequence = 0;
const stateByCredential = new Map<string, Map<string, "VIEWED" | "UNVIEWED" | "DISMISSED">>();

beforeAll(async () => {
  setKeyring({ activeId: "browser", keys: new Map([["browser", Buffer.from(generateKey(), "base64")]]) });
  migrate();
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  setPersonalGithubGraphqlClientFactory((_userId, credentialId) => {
    const states = stateByCredential.get(credentialId) ?? new Map();
    stateByCredential.set(credentialId, states);
    const client: PersonalGithubGraphqlClient = {
      async pullRequest() { return { id: `PR_${credentialId}`, headRefOid: currentHead(credentialId), files: [...states].map(([path, viewerViewedState]) => ({ path, viewerViewedState })), filesTruncated: false, rate: { limit: 5000, cost: 1, remaining: 4999, resetAt: Date.now() + 60_000, used: 1 } }; },
      async markFileAsViewed(_id, path) { states.set(path, "VIEWED"); },
      async unmarkFileAsViewed(_id, path) { states.set(path, "UNVIEWED"); },
      async addReview() { reviewSequence += 1; return { reviewId: `PRR_BROWSER_${reviewSequence}`, commentNodeIds: [] }; },
      async addThreadReply() { throw new Error("not used"); }, async resolveThread() {}, async unresolveThread() {},
      async findReviewThreadByComment() { return null; }, async recoverReview() { return { kind: "none" }; },
    };
    return client;
  });
  server = await startServer();
  base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

interface BrowserFixture {
  workspaceId: string;
  slug: string;
  lineageId: string;
  revisionId: string;
  credentialId: string;
  head: string;
  stackSlug: string;
}

const heads = new Map<string, string>();
function currentHead(credentialId: string): string { return heads.get(credentialId)!; }

function browserFixture(): BrowserFixture {
  sequence += 1;
  const workspaceId = createWorkspace(`Projection browser ${sequence}`, owner);
  const slug = `projection-browser-${sequence}`;
  const lineageId = tinyId("rln"), revisionId = tinyId("rvr"), captureId = tinyId("stg"), fileId = tinyId("stf");
  const head = sequence.toString(16).padStart(40, "a").slice(-40), baseSha = "b".repeat(40);
  const credentialId = createGithubUserCredential({ userId: owner, kind: "pat", label: `browser-${sequence}`, secret: `browser-secret-${sequence}`, accountLogin: `browser-octocat-${sequence}`, accountId: 10_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
  heads.set(credentialId, head);
  stateByCredential.set(credentialId, new Map([["assets/logo.png", "UNVIEWED"]]));
  db.run("INSERT INTO review_lineages VALUES (?,?,?,'Acme/Browser',101,'feature','main',?,'Projection browser',1,NULL,?,?,?,?)", [lineageId, workspaceId, slug, baseSha, owner, tinyId("key"), Date.now(), Date.now()]);
  db.run("INSERT INTO stage_captures VALUES (?,?,?,'Acme/Browser',101,'feature','main',?,?,?,NULL,'completed',?)", [captureId, workspaceId, slug, head, baseSha, baseSha, Date.now()]);
  db.run("INSERT INTO stage_capture_files VALUES (?,?,?,'assets/logo.png',NULL,'mode_changed',?,?, '100644','100755','blob','blob',0,0,'retained','retained',NULL,NULL,NULL,NULL)", [fileId, workspaceId, captureId, "c".repeat(40), "c".repeat(40)]);
  const revision = { identity: { lineageId, slug, revision: 1, title: "Projection browser", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Browser", repoId: 101, branch: "feature", originalBaseRef: "main", originalBaseSha: baseSha, baseRef: "main", sourceHeadSha: head, baseTipSha: baseSha, mergeBaseSha: baseSha }, builder: null, projects: [] };
  db.run("INSERT INTO review_revisions VALUES (?,?,?,?,1,?,1,?,?,?)", [revisionId, workspaceId, lineageId, slug, captureId, JSON.stringify(revision), digestOf(revision), Date.now()]);
  db.run("INSERT INTO review_lineage_prs VALUES (?,?,?,101,'Acme/Browser',41,'feature','main','user',NULL,?,?,?,NULL)", [lineageId, workspaceId, slug, owner, credentialId, Date.now()]);
  db.run("INSERT INTO review_pr_observations VALUES (?,?,?,101,'Acme/Browser',41,'Projection browser','open',0,0,'main',?,'feature',?,?,?,?,'user',NULL,?,?,?)", [tinyId("pob"), workspaceId, lineageId, baseSha, head, baseSha, Date.now(), Date.now(), owner, credentialId, `browser-observation-${sequence}`]);

  const stackId = tinyId("rsk"), manifestId = tinyId("rsm"), stackSlug = `projection-stack-${sequence}`;
  db.run("INSERT INTO review_stacks VALUES (?,?,?,'Projection stack','Acme/Browser',101,'main','inferred',NULL,NULL,'anonymous',NULL,NULL,NULL,1,?,?,?,?)", [stackId, workspaceId, stackSlug, owner, tinyId("key"), Date.now(), Date.now()]);
  const manifest = { identity: { stackId, slug: stackSlug, title: "Projection stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date().toISOString() }, repository: { repo: "Acme/Browser", repoId: 101, baseRef: "main" }, source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null }, members: [{ lineageId, lineageSlug: slug, prNumber: 41, title: "Projection browser", revisionId, revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: "feature", headSha: head, status: "live", removedReason: null }], projects: [] };
  db.run("INSERT INTO review_stack_manifests VALUES (?,?,?,?,1,0,'created',1,?,?,?)", [manifestId, stackId, workspaceId, stackSlug, JSON.stringify(manifest), digestOf(manifest), Date.now()]);
  return { workspaceId, slug, lineageId, revisionId, credentialId, head, stackSlug };
}

async function waitForSubmission(revisionId: string, kind: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = db.query<{ state: string }, [string, string]>("SELECT state FROM review_github_submissions WHERE revision_id=? AND kind=?").get(revisionId, kind);
    if (row?.state === "submitted" || row?.state === "submitted_stale") return row.state;
    await Bun.sleep(10);
  }
  return "timeout";
}

test("should expose explicit GitHub controls on desktop, phone, stack layer and no-JavaScript", async () => {
  const evidence = process.env.SEER_TASK11_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "seer-task11-browser-"));
  mkdirSync(evidence, { recursive: true });
  const profiles = mkdtempSync(join(tmpdir(), "seer-task11-chrome-"));

  const desktopFixture = browserFixture();
  const desktop = await ChromePage.launch({ width: 1440, height: 1000, profileRoot: profiles, name: "projection-desktop" });
  try {
    await desktop.navigate(`${base}/${desktopFixture.workspaceId}/r/${desktopFixture.slug}/rev/1`);
    expect(await desktop.evaluate<string>("document.querySelector('.source-rail .github-projection h2')?.textContent")).toBe("GitHub");
    expect(await desktop.evaluate<string[]>("[...document.querySelectorAll('.github-review-form button')].map(button=>button.textContent.trim())")).toEqual([`Approve this commit ${desktopFixture.head.slice(0, 12)}`, `Request changes on this commit ${desktopFixture.head.slice(0, 12)}`]);
    expect(await desktop.evaluate<boolean>("document.body.textContent.includes('browser-secret')")).toBe(false);
    await desktop.screenshot(join(evidence, "github-projection-desktop-1440-light.png"));
    await desktop.clickAndWaitForLoad('.github-viewed-control button');
    await desktop.waitFor("document.body.textContent.includes('Stop syncing Viewed')");
    await desktop.evaluate("document.querySelector('.github-review-form button[value=approve]').focus()");
    await desktop.key("Enter");
    await desktop.waitFor("document.readyState==='complete'");
    expect(await waitForSubmission(desktopFixture.revisionId, "approve")).toBe("submitted");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id=?").get(desktopFixture.revisionId)?.n).toBe(0);
    await desktop.navigate(`${base}/${desktopFixture.workspaceId}/r/${desktopFixture.slug}/rev/1`);
    expect(await desktop.evaluate<string>("document.querySelector('.github-action-state span')?.textContent")).toBe("Approved on GitHub");
  } finally { await desktop.close(); }

  const phoneFixture = browserFixture();
  const layerUrl = `${base}/${phoneFixture.workspaceId}/r-stacks/${phoneFixture.stackSlug}/v/1?layer=${phoneFixture.slug}`;
  const phone = await ChromePage.launch({ width: 390, height: 844, dark: true, touch: true, profileRoot: profiles, name: "projection-phone" });
  try {
    await phone.navigate(`${base}/${phoneFixture.workspaceId}/r-stacks/${phoneFixture.stackSlug}/v/1`);
    expect(await phone.evaluate<number>("document.querySelectorAll('.github-projection').length")).toBe(0);
    await phone.navigate(layerUrl);
    expect(await phone.evaluate<string[]>("[...document.querySelectorAll('.mobile-bar>*')].map(node=>node.textContent.trim())")).toEqual(["Review", "0 / 1 handled", "Details"]);
    await phone.touch('.mobile-bar [data-page-details-open]');
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='true'");
    expect(await phone.evaluate<string>("document.querySelector('[data-page-details] .github-projection h2')?.textContent")).toBe("GitHub");
    await phone.screenshot(join(evidence, "github-projection-phone-390-dark-details.png"));
    await phone.evaluate("history.back()");
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='false'");
    expect(await phone.evaluate<string>("new URL(location.href).searchParams.get('layer')")).toBe(phoneFixture.slug);
    await phone.navigate(layerUrl);
    await phone.touch('.mobile-bar [data-page-details-open]');
    await phone.key("Escape");
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='false'");
  } finally { await phone.close(); }

  const noJsFixture = browserFixture();
  const refusedReview = createGithubReviewSubmission({ workspaceId: noJsFixture.workspaceId, lineageId: noJsFixture.lineageId, revisionId: noJsFixture.revisionId, userId: owner, credentialId: noJsFixture.credentialId, kind: "approve", body: "Use another credential" }).row;
  db.run("UPDATE review_github_submissions SET state='refused',attempts=1,failure_code='permission_refused',failure='GitHub refused permission for this personal mutation.' WHERE id=?", [refusedReview.id]);
  const noJsInventory = getStageCaptureForWorkspaces(db.query<{ capture_id: string }, [string]>("SELECT capture_id FROM review_revisions WHERE id=?").get(noJsFixture.revisionId)!.capture_id, [noJsFixture.workspaceId])!;
  const noJsFileItem = requiredAcknowledgements(noJsInventory).find((item) => item.id === noJsInventory.files[0]!.id)!;
  setRevisionAcknowledgement({ workspaceId: noJsFixture.workspaceId, lineageId: noJsFixture.lineageId, revisionId: noJsFixture.revisionId, userId: owner, item: noJsFileItem, acknowledged: true });
  setGithubProjectionPreference({ workspaceId: noJsFixture.workspaceId, lineageId: noJsFixture.lineageId, userId: owner, credentialId: noJsFixture.credentialId, enabled: true });
  queueCurrentViewedJobs({ workspaceId: noJsFixture.workspaceId, lineageId: noJsFixture.lineageId, userId: owner, completeOnly: true });
  db.run("UPDATE github_user_credentials SET dead_at=? WHERE id=?", [Date.now(), noJsFixture.credentialId]);
  expect(await runNextGithubViewedJob(noJsFixture.credentialId)).toBe(true);
  expect(getGithubProjectionPreference(noJsFixture.workspaceId, noJsFixture.lineageId, owner)?.viewed_enabled).toBe(0);
  const replacement = createGithubUserCredential({ userId: owner, kind: "pat", label: "replacement", secret: `browser-replacement-${sequence}`, accountLogin: `replacement-octocat-${sequence}`, accountId: 20_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
  heads.set(replacement, noJsFixture.head);
  stateByCredential.set(replacement, new Map([["assets/logo.png", "UNVIEWED"]]));
  const noJsUrl = `${base}/${noJsFixture.workspaceId}/r-stacks/${noJsFixture.stackSlug}/v/1?layer=${noJsFixture.slug}`;
  const noJs = await ChromePage.launch({ width: 390, height: 1000, javascript: false, profileRoot: profiles, name: "projection-nojs" });
  try {
    await noJs.navigate(noJsUrl);
    expect(await noJs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
    expect(await noJs.evaluate<string>("document.querySelector('.github-projection h2')?.textContent")).toBe("GitHub");
    expect(await noJs.evaluate<string>("document.querySelector('.github-submission-retry')?.textContent")).toContain("replacement");
    await noJs.activateAndWaitForLoad('.github-submission-retry button');
    expect(await noJs.evaluate<string>("location.pathname+location.search")).toBe(`/${noJsFixture.workspaceId}/r-stacks/${noJsFixture.stackSlug}/v/1?layer=${noJsFixture.slug}`);
    expect(await waitForSubmission(noJsFixture.revisionId, "approve")).toBe("submitted");
    await noJs.evaluate("document.querySelector('.github-projection').scrollIntoView({block:'start'})");
    await noJs.screenshot(join(evidence, "github-projection-phone-390-nojs-before.png"));
    expect(await noJs.evaluate("(()=>{const form=document.querySelector('.github-viewed-control');return{action:new URL(form.action).pathname,enabled:new FormData(form).get('enabled'),credential:new FormData(form).get('credential'),text:form.textContent}})()" )).toMatchObject({ action: `/${noJsFixture.workspaceId}/r/${noJsFixture.slug}/github/viewed`, enabled: "true", text: expect.stringContaining("replacement") });
    expect(await noJs.evaluate<string>("document.querySelector('.github-projection')?.textContent")).toContain("no longer accepts");
    expect(await noJs.evaluate<boolean>("document.querySelector('.github-viewed-retry')===null")).toBe(true);
    await noJs.activateAndWaitForLoad('.github-viewed-control button');
    expect(await noJs.evaluate<string>("location.pathname+location.search")).toBe(`/${noJsFixture.workspaceId}/r-stacks/${noJsFixture.stackSlug}/v/1?layer=${noJsFixture.slug}`);
    expect(db.query<{ viewed_enabled: number; credential_id: string }, [string, string]>("SELECT viewed_enabled,credential_id FROM review_github_projection_preferences WHERE lineage_id=? AND user_id=?").get(noJsFixture.lineageId, owner)).toEqual({ viewed_enabled: 1, credential_id: replacement });
    expect(await noJs.evaluate<string>("document.querySelector('.github-projection')?.textContent")).toContain("Stop syncing Viewed");
    await noJs.activateAndWaitForLoad('.github-review-form button[value="request_changes"]');
    expect(await noJs.evaluate<string>("location.pathname+location.search")).toBe(`/${noJsFixture.workspaceId}/r-stacks/${noJsFixture.stackSlug}/v/1?layer=${noJsFixture.slug}`);
    expect(await waitForSubmission(noJsFixture.revisionId, "request_changes")).toBe("submitted");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id=?").get(noJsFixture.revisionId)?.n).toBe(0);
    await noJs.screenshot(join(evidence, "github-projection-phone-390-nojs-after.png"));
  } finally { await noJs.close(); }

  const wideFixture = browserFixture();
  const wide = await ChromePage.launch({ width: 1680, height: 1000, dark: true, profileRoot: profiles, name: "projection-wide" });
  try {
    await wide.navigate(`${base}/${wideFixture.workspaceId}/r/${wideFixture.slug}/rev/1`);
    expect(await wide.evaluate<string>("document.documentElement.dataset.theme")).toBe("dark");
    expect(await wide.evaluate<number>("document.querySelectorAll('.source-rail .github-projection').length")).toBe(1);
    await wide.screenshot(join(evidence, "github-projection-wide-1680-dark.png"));
  } finally { await wide.close(); }
}, 60_000);
