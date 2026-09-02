import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { tinyId } from "../../src/ids";
import { startServer, WS_PAGE_RE, WS_PROJECT_RE, WS_REVIEW_RE, WS_STACK_RE } from "../../src/server";
import { createAttachment, createReviewVersion } from "../../src/overseer/db";
import { digestOf } from "../../src/overseer/revision-db";
import { saveAttachment } from "../../src/store";
import { goldenStoredDoc } from "./fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let key = "";

interface PromotedFixture {
  slug: string;
  lineageId: string;
  revisionId: string;
  accountId: string;
  captureId: string;
  groupId: string;
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Canonical routing", owner);
  key = mintApiKey(owner, workspace, "canonical routing").token;
});

afterAll(() => server.stop(true));

function capture(slug: string): { captureId: string; fileId: string; head: string; merge: string } {
  const captureId = tinyId("stg"), fileId = tinyId("stf");
  const head = "2".repeat(40), merge = "1".repeat(40);
  db.run(
    "INSERT INTO stage_captures VALUES (?, ?, ?, 'Acme/Routing', 700, ?, 'main', ?, ?, ?, NULL, 'completed', ?)",
    [captureId, workspace, slug, `feature-${slug}`, head, merge, merge, Date.now()],
  );
  db.run(
    "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/flag.txt', NULL, 'mode_changed', ?, ?, '100644', '100755', 'blob', 'blob', 0, 0, 'retained', 'retained', NULL, NULL, NULL, NULL)",
    [fileId, workspace, captureId, "a".repeat(40), "a".repeat(40)],
  );
  return { captureId, fileId, head, merge };
}

function promoted(slug: string): PromotedFixture {
  const source = capture(slug);
  const lineageId = tinyId("rln"), revisionId = tinyId("rvr"), accountId = tinyId("rac"), requestId = tinyId("wtr");
  const groupId = "routing-group";
  const now = Date.now();
  db.run(
    "INSERT INTO review_lineages VALUES (?, ?, ?, 'Acme/Routing', 700, ?, 'main', ?, ?, 1, 1, ?, ?, ?, ?)",
    [lineageId, workspace, slug, `feature-${slug}`, source.merge, `Review ${slug}`, owner, tinyId("key"), now, now],
  );
  const revision = {
    identity: { lineageId, slug, revision: 1, title: `Review ${slug}`, createdAt: new Date(now).toISOString() },
    source: { captureId: source.captureId, repo: "Acme/Routing", repoId: 700, branch: `feature-${slug}`, originalBaseRef: "main", originalBaseSha: source.merge, baseRef: "main", sourceHeadSha: source.head, baseTipSha: source.merge, mergeBaseSha: source.merge },
    builder: null,
    projects: [],
  };
  const group = { id: groupId, title: "Routing file", category: "Code", importance: "low", complexity: "low", explanation: "The retained file proves direct routing.", examples: [], members: [{ type: "file", id: source.fileId, description: "The mode-only file stays visible." }] };
  const account = {
    identity: { lineageId, slug, revision: 1, version: 1, createdAt: new Date(now).toISOString() },
    witness: { summary: "The canonical account is immutable.", agent: { name: "Witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    groups: [group],
    focus: [],
    evidence: [],
  };
  db.run("INSERT INTO review_revisions VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)", [revisionId, workspace, lineageId, slug, source.captureId, JSON.stringify(revision), digestOf(revision), now]);
  db.run("INSERT INTO review_accounts VALUES (?, ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?)", [accountId, workspace, lineageId, revisionId, slug, JSON.stringify(account), digestOf(account), owner, account.witness.keyId, now]);
  db.run("INSERT INTO review_witness_requests VALUES (?, ?, ?, ?, 1, 'published', 0, NULL, ?, ?, ?)", [requestId, workspace, lineageId, revisionId, accountId, now, now]);
  return { slug, lineageId, revisionId, accountId, captureId: source.captureId, groupId };
}

function stage(slug: string): void {
  const source = capture(slug);
  const stageId = tinyId("sta"), versionId = tinyId("stv");
  const now = Date.now();
  db.run(
    "INSERT INTO stages VALUES (?, ?, ?, 'Acme/Routing', 700, ?, 'main', ?, 1, ?, ?, ?, ?)",
    [stageId, workspace, slug, `feature-${slug}`, source.merge, owner, tinyId("key"), now, now],
  );
  const group = { id: "stage-routing", title: "Stage routing", category: "Code", importance: "low", complexity: "low", explanation: "Stage V1 remains separate.", examples: [], members: [{ type: "file", id: source.fileId, description: "The Stage file stays on /st/." }] };
  const doc = {
    identity: { id: stageId, slug, version: 1, title: "Stage routing", createdAt: new Date(now).toISOString() },
    source: { captureId: source.captureId, repo: "Acme/Routing", repoId: 700, branch: `feature-${slug}`, baseRef: "main", sourceHeadSha: source.head, baseTipSha: source.merge, mergeBaseSha: source.merge },
    builder: { intent: "Keep Stage V1", context: "", agent: { name: "Builder", model: "test" }, userId: owner, keyId: tinyId("key") },
    witness: { summary: "Stage V1 still publishes.", groups: [group], agent: { name: "Witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    projects: [],
  };
  db.run("INSERT INTO stage_versions VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)", [versionId, workspace, stageId, slug, source.captureId, JSON.stringify(doc), digestOf(doc), owner, doc.witness.keyId, now]);
}

function stack(slug: string, member: PromotedFixture): void {
  const stackId = tinyId("rsk"), manifestId = tinyId("rsm"), stackAccountId = tinyId("rsa"), requestId = tinyId("rsw");
  const now = Date.now();
  db.run("INSERT INTO review_stacks VALUES (?, ?, ?, 'Canonical stack', 'Acme/Routing', 700, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)", [stackId, workspace, slug, owner, tinyId("key"), now, now]);
  const manifest = {
    identity: { stackId, slug, title: "Canonical stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date(now).toISOString() },
    repository: { repo: "Acme/Routing", repoId: 700, baseRef: "main" },
    source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null },
    members: [{ lineageId: member.lineageId, lineageSlug: member.slug, prNumber: 1, title: `Review ${member.slug}`, revisionId: member.revisionId, revision: 1, accountId: member.accountId, accountVersion: 1, baseRef: "main", headRef: `feature-${member.slug}`, headSha: "2".repeat(40), status: "live", removedReason: null }],
    projects: [],
  };
  const account = {
    identity: { stackId, slug, manifestId, version: 1, createdAt: new Date(now).toISOString() },
    witness: { summary: "The exact stack account.", agent: { name: "Stack witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    groups: [{ id: "whole-stack", title: "Whole stack", body: "One exact member account.", examples: [], members: [{ lineageId: member.lineageId, revision: 1, accountVersion: 1, groupId: member.groupId }] }],
  };
  db.run("INSERT INTO review_stack_manifests VALUES (?, ?, ?, ?, 1, 0, 'created', 1, ?, ?, ?)", [manifestId, stackId, workspace, slug, JSON.stringify(manifest), digestOf(manifest), now]);
  db.run("INSERT INTO review_stack_members VALUES (?, ?, ?, ?, 700, 1, ?, NULL, NULL, NULL)", [stackId, member.lineageId, workspace, member.slug, manifestId]);
  db.run("INSERT INTO review_stack_accounts VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)", [stackAccountId, stackId, manifestId, workspace, slug, JSON.stringify(account), digestOf(account), owner, account.witness.keyId, now]);
  db.run("INSERT INTO review_stack_witness_requests VALUES (?, ?, ?, ?, 1, 'published', 0, NULL, ?, ?, ?)", [requestId, workspace, stackId, manifestId, stackAccountId, now, now]);
}

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual" });
}

describe("canonical routing", () => {
  test("should reserve r-stacks before every generic workspace regex", () => {
    const path = `/${workspace}/r-stacks/exact-stack/v/1/account`;
    expect(WS_STACK_RE.test(path)).toBe(true);
    expect(WS_REVIEW_RE.test(path)).toBe(false);
    expect(WS_PAGE_RE.test(path)).toBe(false);
    expect(WS_PROJECT_RE.test(path)).toBe(false);
  });

  test("should resolve each canonical route directly without relying on a forbidden review-stack slug collision", async () => {
    const review = promoted("canonical-review");
    stack("canonical-stack", review);
    stage("canonical-review");

    const cases = [
      `/${workspace}/r/canonical-review`,
      `/${workspace}/r/canonical-review/rev/1`,
      `/${workspace}/r/canonical-review/v/1`,
      `/${workspace}/r-stacks/canonical-stack`,
      `/${workspace}/r-stacks/canonical-stack/v/1`,
      `/${workspace}/r-stacks/canonical-stack/v/1/account`,
      `/${workspace}/st/canonical-review`,
      `/${workspace}/st/canonical-review/v/1`,
    ];
    for (const path of cases) {
      const response = await get(path);
      expect({ path, status: response.status, type: response.headers.get("content-type") }).toEqual({ path, status: 200, type: "text/html;charset=utf-8" });
    }
    expect((await (await get(`/${workspace}/r-stacks/canonical-stack`)).text())).toContain("Canonical stack");
    expect((await (await get(`/${workspace}/st/canonical-review`)).text())).toContain("Stage routing");
    expect((await get(`/r/canonical-review`)).status).toBe(404);
  });

  test("should dispatch an existing collision legacy first while /rev never falls back", async () => {
    createReviewVersion(workspace, "route-collision", { ...goldenStoredDoc(), title: "Legacy owns this route" });
    promoted("route-collision");
    expect(await (await get(`/${workspace}/r/route-collision`)).text()).toContain("Legacy owns this route");
    expect(await (await get(`/${workspace}/r/route-collision/v/1`)).text()).toContain("Legacy owns this route");
    expect(await (await get(`/${workspace}/r/route-collision/rev/1`)).text()).toContain("Review route-collision");
    expect(await (await get(`/r/route-collision`)).text()).toContain("Legacy owns this route");

    createReviewVersion(workspace, "legacy-no-revision", { ...goldenStoredDoc(), title: "No promoted fallback" });
    const miss = await get(`/${workspace}/r/legacy-no-revision/rev/1`);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain("No such review");
  });

  test("should preserve legacy version, attachment, annotation, share, and cache behavior", async () => {
    createReviewVersion(workspace, "legacy-routes", { ...goldenStoredDoc(), title: "Legacy routes" });
    const attachmentId = createAttachment(workspace, "legacy-routes", 1, "image/png", 4, "Four bytes", "", tinyId("att"));
    await saveAttachment(workspace, attachmentId, new Uint8Array([1, 2, 3, 4]));

    const page = await get(`/${workspace}/r/legacy-routes/v/1`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const attachment = await get(`/${workspace}/r/legacy-routes/a/${attachmentId}`);
    expect(attachment.status).toBe(200);
    expect(await attachment.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);

    const annotation = await fetch(`${base}/${workspace}/r/legacy-routes/annotations`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ target_type: "summary", target_id: "summary", body: "Legacy question" }),
      redirect: "manual",
    });
    expect(annotation.status).toBe(303);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_annotations WHERE workspace_id = ? AND slug = 'legacy-routes'").get(workspace)!.n).toBe(1);

    const minted = await fetch(`${base}/api/shares`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace, kind: "review", target: "legacy-routes" }),
    });
    expect(minted.status).toBe(200);
    const share = await minted.json() as any;
    const shared = await get(new URL(share.url).pathname);
    expect(shared.status).toBe(200);
    expect(shared.headers.get("cache-control")).toBe("no-store");
    expect(await shared.text()).not.toContain("Legacy question");
  });
});
