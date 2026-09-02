// A completed capture becomes a readable review revision, and a witness publishes an
// account over it later.
//
// The two halves are deliberately kept apart here as they are in the product: everything
// before "the witness publishes" has to work with no witness at all, and everything after
// it has to leave the evidence exactly where it was.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { sessionCookie } from "../../src/auth";
import { tinyId } from "../../src/ids";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { offlineGithubClientFactory } from "../offline-github";
import type { GithubClient, GithubTreeEntry } from "../../src/overseer/github";
import { openApiSpec } from "../../src/agent-discovery";
import {
  RevisionWriteError,
  failWitnessRequest,
  getLineage,
  getRevision,
  getWitnessRequestForRevision,
  listRevisionReadChangeIds,
} from "../../src/overseer/revision-db";
import { evidenceSeams } from "../../src/overseer/revision-read";
import { createDocumentCapability } from "../../src/overseer/capability-db";
import { getStageCapture } from "../../src/stage/db";
import { MAX_EVIDENCE_PAGE_CHANGES } from "../../src/overseer/revision-types";
import { storeGoldenReview } from "./fixtures/stored-review";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE = sha(1), HEAD = sha(2), MERGE = sha(3);
const OLD = sha(10), NEW = sha(11), DOC = sha(12), BIN1 = sha(13), BIN2 = sha(14), SCRIPT = sha(15);
const blobs = new Map<string, Uint8Array>([
  [OLD, new TextEncoder().encode("export const value = 1;\n")],
  [NEW, new TextEncoder().encode("export const value = 2;\n")],
  [DOC, new TextEncoder().encode("# Reader\n\nPinned source.\n")],
  [BIN1, Uint8Array.from([0, 1, 2])],
  [BIN2, Uint8Array.from([0, 1, 3])],
  [SCRIPT, new TextEncoder().encode("#!/bin/sh\n")],
]);

function githubFixture(): GithubClient {
  return {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => ({ id: 440, full_name: "Acme/Reader", default_branch: "main" }),
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, commit) => {
      const tree = commit === HEAD ? [
        { path: "src/value.ts", mode: "100644", type: "blob" as const, sha: NEW },
        { path: "docs/readme.md", mode: "100644", type: "blob" as const, sha: DOC },
        { path: "tests/data.bin", mode: "100644", type: "blob" as const, sha: BIN2 },
        { path: "scripts/run.sh", mode: "100755", type: "blob" as const, sha: SCRIPT },
      ] : [
        { path: "src/value.ts", mode: "100644", type: "blob" as const, sha: OLD },
        { path: "tests/data.bin", mode: "100644", type: "blob" as const, sha: BIN1 },
        { path: "scripts/run.sh", mode: "100644", type: "blob" as const, sha: SCRIPT },
      ];
      return { sha: commit, truncated: false, tree: tree.map((entry) => ({ ...entry, size: blobs.get(entry.sha)!.byteLength })) };
    },
    getBlobBytes: async (_repo, object) => blobs.get(object)!,
    compare: async () => ({ merge_base_commit: { sha: MERGE }, files: [
      { filename: "src/value.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n" },
      { filename: "docs/readme.md", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Reader\n+\n+Pinned source.\n" },
      { filename: "tests/data.bin", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "scripts/run.sh", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ] }),
    compareDiff: async () => [
      "diff --git a/src/value.ts b/src/value.ts", "--- a/src/value.ts", "+++ b/src/value.ts", "@@ -1,1 +1,1 @@", "-export const value = 1;", "+export const value = 2;", "",
      "diff --git a/docs/readme.md b/docs/readme.md", "new file mode 100644", "--- /dev/null", "+++ b/docs/readme.md", "@@ -0,0 +1,3 @@", "+# Reader", "+", "+Pinned source.", "",
    ].join("\n"),
  };
}

/** A capture wide enough that its evidence cannot fit on one navigation page. */
function wideFixture(count: number): GithubClient {
  const wide = new Map<string, Uint8Array>();
  const paths = Array.from({ length: count }, (_, index) => `wide/f-${index.toString().padStart(4, "0")}.ts`);
  const entries = (side: "old" | "new"): GithubTreeEntry[] =>
    paths.map((path, index) => {
      const object = `${side === "old" ? "3" : "4"}${index.toString(16).padStart(7, "0")}${"0".repeat(32)}`;
      const bytes = new TextEncoder().encode(`export const n = ${side === "old" ? index : index + 1};\n`);
      wide.set(object, bytes);
      return { path, mode: "100644", type: "blob" as const, sha: object, size: bytes.byteLength };
    });
  const oldEntries = entries("old");
  const newEntries = entries("new");
  return {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => ({ id: 441, full_name: "Acme/Wide", default_branch: "main" }),
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, commit) => ({ sha: commit, truncated: false, tree: commit === HEAD ? newEntries : oldEntries }),
    getBlobBytes: async (_repo, object) => wide.get(object)!,
    compare: async () => ({ merge_base_commit: { sha: MERGE }, files: [] }),
    compareDiff: async () => "",
  };
}

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let workspace: string;
let otherWorkspace: string;
let owner: string;
let second: string;
let key: string;
let otherKey: string;
let cookie: string;
let capture: any;
let stagedCapture: any;
let wideCapture: any;
let bundleSlug = "revision-evidence-bundle";

const apiHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
const sessionHeaders = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
const jsonHeaders = (token = key) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

// Bun types Response.json() as unknown. Every body read below is either checked against
// the served OpenAPI document by validateResponse or asserted field by field, so the
// reads are deliberately loose rather than re-declaring the API's shapes here.

/** The rendered page with its inlined stylesheet and client script removed. Both carry
 *  every class name the reader can ever draw, so a negative assertion against the raw
 *  HTML would be asserting against the CSS. */
function visible(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
}

function validateResponse(operationId: string, body: unknown): void {
  const operation = Object.values((openApiSpec() as any).paths)
    .flatMap((path: any) => Object.values(path))
    .find((candidate: any) => candidate.operationId === operationId) as any;
  if (!operation) throw new Error(`no operation ${operationId} in the served document`);
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(operation.responses["200"].content["application/json"].schema);
  if (!validate(body)) throw new Error(`${operationId}: ${ajv.errorsText(validate.errors)}`);
}

/** One complete partition of a capture, exactly as a witness must author it. */
function partition(captured: any): any[] {
  return [
    ...captured.incomplete.filter((item: any) => item.path === null).map((item: any) => ({ type: "material", id: item.id, description: "Capture material" })),
    ...captured.files.flatMap((file: any) => {
      const material = captured.incomplete.filter((item: any) => item.path === file.path);
      return [
        ...file.changes.map((change: any) => ({ type: "change", id: change.id, description: `Read ${file.path}` })),
        ...material.map((item: any) => ({ type: "material", id: item.id, description: `Account for ${file.path}` })),
        ...(file.changes.length === 0 && material.length === 0 ? [{ type: "file", id: file.id, description: `Structural change in ${file.path}` }] : []),
      ];
    }),
  ];
}

async function createCapture(slug: string, idempotency: string, token = key, client = githubFixture()): Promise<any> {
  setGithubClientFactory(() => client);
  const response = await fetch(`${base}/api/stage-captures`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idempotency },
    body: JSON.stringify({
      slug, repo: client === githubFixture() ? "Acme/Reader" : "Acme/Reader", branch: "feature/reader",
      builder: { intent: "Capture the branch.", context: "The evidence reads before the witness answers.", agent: { name: "Builder", model: "build-model" } },
    }),
  });
  if (response.status !== 200) throw new Error(await response.text());
  return response.json() as any;
}

async function createLineage(body: unknown, token = key): Promise<Response> {
  return fetch(`${base}/api/review-lineages`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
}

async function publishAccountFor(slug: string, revision: number, body: unknown, token = key): Promise<Response> {
  return fetch(`${base}/api/review-lineages/${slug}/revisions/${revision}/accounts`, {
    method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Promoted review", owner);
  otherWorkspace = createWorkspace("Other promoted review", owner);
  key = mintApiKey(owner, workspace, "revision").token;
  otherKey = mintApiKey(owner, otherWorkspace, "other-revision").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  second = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, ?, ?)", [second, "second-revision@example.com", Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, second, Date.now()]);

  capture = await createCapture("promoted-source", "promoted-source-capture");
  stagedCapture = await createCapture("already-staged", "already-staged-capture");
  const wide = wideFixture(150);
  setGithubClientFactory(() => wide);
  const wideResponse = await fetch(`${base}/api/stage-captures`, {
    method: "POST",
    headers: jsonHeaders() as Record<string, string> & { "idempotency-key"?: string },
    body: JSON.stringify({ slug: "wide-source", repo: "Acme/Wide", branch: "feature/wide", builder: { intent: "Wide.", context: "", agent: { name: "Builder", model: "build-model" } } }),
  });
  // The header has to be on the request, not in the JSON headers helper.
  if (wideResponse.status !== 200) {
    const retry = await fetch(`${base}/api/stage-captures`, {
      method: "POST",
      headers: { ...jsonHeaders(), "idempotency-key": "wide-source-capture" },
      body: JSON.stringify({ slug: "wide-source", repo: "Acme/Wide", branch: "feature/wide", builder: { intent: "Wide.", context: "", agent: { name: "Builder", model: "build-model" } } }),
    });
    if (retry.status !== 200) throw new Error(await retry.text());
    wideCapture = await retry.json() as any;
  } else {
    wideCapture = await wideResponse.json() as any;
  }

  // A bundle and a legacy review's attachment, so an account has real material to cite.
  await fetch(`${base}/api/bundles/${bundleSlug}`, {
    method: "PUT", headers: apiHeaders(),
    body: (await import("fflate")).zipSync({ "index.html": new TextEncoder().encode("<html></html>") }),
  });
  storeGoldenReview(workspace, "legacy-evidence");
  db.run(
    "INSERT INTO review_attachments (id, workspace_id, slug, version, media_type, bytes, alt, caption, created_at) VALUES ('att_evidence00', ?, 'legacy-evidence', 1, 'image/png', 3, 'a shot', 'the gate', ?)",
    [workspace, Date.now()],
  );
});

afterEach(() => setGithubClientFactory(offlineGithubClientFactory()));
afterAll(() => server.stop(true));

describe("publishing a source revision", () => {
  test("one capture publishes one revision and one pending witness request, under concurrent replay", async () => {
    const body = { captureId: capture.id, slug: "promoted-source", title: "A readable review revision", projects: [] };
    const responses = await Promise.all(Array.from({ length: 5 }, () => createLineage(body)));
    const bodies = await Promise.all(responses.map((response) => response.json() as any));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    validateResponse("createReviewLineage", bodies[0]);
    expect(new Set(bodies.map((entry: any) => entry.id)).size).toBe(1);
    expect(new Set(bodies.map((entry: any) => entry.witness.id)).size).toBe(1);

    const revisions = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ?").get(workspace)!;
    expect(revisions.n).toBe(1);
    const requests = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_witness_requests WHERE workspace_id = ?").get(workspace)!;
    expect(requests.n).toBe(1);

    const first: any = bodies[0];
    expect(first.revision).toBe(1);
    expect(first.witness.state).toBe("pending");
    expect(first.witness.retryCount).toBe(0);
    expect(first.document.source.captureId).toBe(capture.id);
    expect(first.document.builder!.agent).toEqual({ name: "Builder", model: "build-model" });
    // The evidence document carries no witness object at all. That is the point of it.
    expect(Object.keys(first.document).sort()).toEqual(["builder", "identity", "projects", "source"]);
  });

  test("a different replay of the same capture is a conflict, not a second revision", async () => {
    const response = await createLineage({ captureId: capture.id, slug: "promoted-source", title: "A different title" });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("already published a different source revision");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ?").get(workspace)!.n).toBe(1);
  });

  test("a capture that already backs a StageDoc V1 can also back a revision, under its own slug", async () => {
    const members = partition(stagedCapture);
    const staged = await fetch(`${base}/api/stages`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({
        captureId: stagedCapture.id, expectedPreviousVersion: 0, slug: "already-staged",
        title: "Already staged", summary: "The stage still reads.", witness: { name: "Witness", model: "review-model" },
        groups: [{ id: "all", title: "All", category: "Code", importance: "low", complexity: "low", explanation: "Everything.", examples: [], members }],
      }),
    });
    expect(staged.status).toBe(200);

    // The natural slug is taken by the stage, so the promotion names a new one.
    const promoted = await createLineage({ captureId: stagedCapture.id, slug: "already-staged-review", title: "Promoted from a stage" });
    expect(promoted.status).toBe(200);
    const view = await promoted.json() as any;
    expect(view.document.source.captureId).toBe(stagedCapture.id);
    // Neither consumed the other.
    expect(db.query("SELECT 1 FROM stage_versions WHERE capture_id = ?").get(stagedCapture.id)).not.toBeNull();
    expect(db.query("SELECT 1 FROM review_revisions WHERE capture_id = ?").get(stagedCapture.id)).not.toBeNull();
  });

  test("a capture with no builder publishes a revision that says so, rather than inventing one", async () => {
    // The shape task 5 ingests: a capture nobody initiated through Seer. It cannot be
    // made through the capture route, which requires a packet, so the capture path is
    // driven directly — which is exactly the seam a pull-request ingestion would use.
    const { captureSource } = await import("../../src/stage/source");
    const result = await captureSource(workspace, { slug: "no-builder", repo: "Acme/Reader", branch: "feature/reader" }, {
      client: githubFixture(), idempotencyKey: "no-builder-capture",
    });
    expect(getStageCapture(result.captureId, workspace)!.builder).toBeNull();

    const created = await createLineage({ captureId: result.captureId, slug: "no-builder-review", title: "Ingested without a builder" });
    expect(created.status).toBe(200);
    const view = await created.json() as any;
    validateResponse("createReviewLineage", view);
    expect(view.document.builder).toBeNull();

    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering evidence"); });
    const page = visible(await (await fetch(`${base}/${workspace}/r/no-builder-review/rev/1`, { headers: sessionHeaders() })).text());
    expect(page).toContain("Ingested without a builder");
    expect(page).not.toContain("Builder<span>");
    expect(page).toContain("Witness pending");
  });

  test("a slug conflict is refused in both directions, and an existing legacy review still appends", async () => {
    // Promoted cannot take a slug a legacy review owns.
    const ontoLegacy = await createLineage({ captureId: wideCapture.id, slug: "legacy-evidence", title: "Onto a legacy review" });
    expect(ontoLegacy.status).toBe(409);
    expect((await ontoLegacy.json() as any).error).toContain("already names a review in this workspace");
    expect(getLineage(workspace, "legacy-evidence")).toBeNull();

    // And a FIRST legacy publish cannot take a slug a lineage owns. The transaction is
    // what refuses it, so this drives the transaction directly rather than the whole
    // GitHub-backed publish route.
    const { createReviewVersion, ReviewSlugTaken, getReviewVersion } = await import("../../src/overseer/db");
    const golden = getReviewVersion(workspace, "legacy-evidence", 1)!.doc;
    expect(() => createReviewVersion(workspace, "promoted-source", golden)).toThrow(ReviewSlugTaken);
    expect(db.query("SELECT 1 FROM reviews WHERE workspace_id = ? AND slug = 'promoted-source'").get(workspace)).toBeNull();

    // An existing legacy review is untouched by the rule: it owned its slug first.
    const before = db.query<{ latest_version: number }, [string]>("SELECT latest_version FROM reviews WHERE workspace_id = ? AND slug = 'legacy-evidence'").get(workspace)!;
    expect(createReviewVersion(workspace, "legacy-evidence", golden)).toBe(before.latest_version + 1);
  });

  test("a fault mid-publication leaves no lineage and no revision behind", async () => {
    const slug = "fault-injected";
    db.exec("ALTER TABLE review_witness_requests RENAME TO review_witness_requests_hidden");
    let response: Response;
    try {
      response = await createLineage({ captureId: wideCapture.id, slug, title: "Fault injected" });
    } finally {
      db.exec("ALTER TABLE review_witness_requests_hidden RENAME TO review_witness_requests");
    }
    expect(response!.status).toBe(502);
    expect(getLineage(workspace, slug)).toBeNull();
    expect(db.query("SELECT 1 FROM review_revisions WHERE workspace_id = ? AND slug = ?").get(workspace, slug)).toBeNull();
    expect(db.query("SELECT 1 FROM project_review_lineages WHERE workspace_id = ? AND slug = ?").get(workspace, slug)).toBeNull();

    // And the same capture publishes cleanly once the fault is gone: nothing was left
    // half-written for it to trip over.
    const again = await createLineage({ captureId: wideCapture.id, slug: "wide-review", title: "A wide revision" });
    expect(again.status).toBe(200);
  });

  test("creation owns its Project joins, and an unknown project refuses the whole publish", async () => {
    await fetch(`${base}/api/projects`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ slug: "revision-project", title: "Revision project" }) });
    const unpromoted = await createCapture("unknown-project-source", "unknown-project-capture");
    const unknown = await createLineage({ captureId: unpromoted.id, slug: "no-such-project-review", title: "No such project", projects: ["not-a-project"] });
    expect(unknown.status).toBe(422);
    expect(getLineage(workspace, "no-such-project-review")).toBeNull();

    const withProject = await createCapture("project-source", "project-source-capture");
    const created = await createLineage({ captureId: withProject.id, slug: "project-review", title: "In a project", projects: ["revision-project", "revision-project"] });
    expect(created.status).toBe(200);
    expect((await created.json() as any).document.projects).toEqual(["revision-project"]);

    const state = await (await fetch(`${base}/api/projects/revision-project`, { headers: apiHeaders() })).json() as any;
    expect(state.reviewLineages.map((entry: any) => entry.slug)).toEqual(["project-review"]);
    expect(state.reviewLineages[0].latestAccountVersion).toBeNull();
    expect(state.reviews).toEqual([]);

    const page = await (await fetch(`${base}/${workspace}/p/revision-project`, { headers: sessionHeaders() })).text();
    expect(page).toContain("Reviews");
    expect(page).toContain("In a project");
    expect(page).toContain("rev 1");
  });
});

describe("reading evidence before a witness has answered", () => {
  test("the evidence page and its retained context render with no GitHub client at all", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering evidence"); });
    const pinned = await fetch(`${base}/${workspace}/r/promoted-source/rev/1`, { headers: sessionHeaders() });
    expect(pinned.status).toBe(200);
    const body = visible(await pinned.text());
    expect(body).toContain("A readable review revision");
    expect(body).toContain("Revision 1");
    expect(body).toContain("Witness pending");
    expect(body).toContain("Builder<span> · build-model");
    // No witness prose, no category marks, no signal scales: the revision has no
    // standing to say any of it.
    expect(body).not.toContain("Witness<span>");
    expect(body).not.toContain("category-summary");
    expect(body).not.toContain("signal-scale");
    expect(body).not.toContain("github.com");
    expect(body).toContain("src/value.ts");

    // The bare workspace URL resolves to the evidence while no account exists.
    const bare = await fetch(`${base}/${workspace}/r/promoted-source`, { headers: sessionHeaders() });
    expect(bare.status).toBe(200);
    expect(visible(await bare.text())).toContain("Witness pending");

    // Retained lines, through a file id this revision's capture owns.
    const file = capture.files.find((entry: any) => entry.path === "src/value.ts");
    const lines = await fetch(`${base}/api/review-lineages/promoted-source/revisions/1/files/${file.id}?side=new&start=1&end=1`, { headers: apiHeaders() });
    expect(lines.status).toBe(200);
    const linesBody = await lines.json() as any;
    validateResponse("readReviewRevisionFileLines", linesBody);
    expect(linesBody.lines).toEqual([{ number: 1, text: "export const value = 2;" }]);
  });

  test("an exact revision capability keeps the real changed-file context control under its token", async () => {
    const revision = getRevision(workspace, "promoted-source", 1)!;
    const inventory = getStageCapture(revision.capture_id, workspace)!;
    const seam = evidenceSeams(inventory).find((group) => group.members.some((member) => member.type === "change"))!;
    const change = seam.members.find((member) => member.type === "change")!;
    const capability = createDocumentCapability({ wsId: workspace, kind: "review_document", target: revision.id, label: "retained context", userId: owner, expiresAt: null });
    const page = visible(await (await fetch(`${base}/s/${capability.token}?review=${seam.id}&change=${change.id}`)).text());
    expect(page).toContain("Load file context");
    expect(page).toContain(`/s/${capability.token}/files/`);
    expect(page).not.toContain(`/api/review-lineages/`);
    expect(page).not.toContain("read-form");
  });

  test("the workflow line says pending, failed and retrying as the request moves", async () => {
    const revisionView = await (await fetch(`${base}/api/review-lineages/promoted-source/revisions/1`, { headers: apiHeaders() })).json() as any;
    validateResponse("readReviewRevision", revisionView);
    const requestId = revisionView.witness.id;

    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering evidence"); });
    const failed = await fetch(`${base}/api/review-witness-requests/${requestId}/fail`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ error: "The witness ran out of context." }),
    });
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as any;
    validateResponse("failWitnessRequest", failedBody);
    expect(failedBody.state).toBe("failed");
    let page = visible(await (await fetch(`${base}/${workspace}/r/promoted-source/rev/1`, { headers: sessionHeaders() })).text());
    expect(page).toContain("Witness failed");
    expect(page).toContain("The witness ran out of context.");

    const retried = await fetch(`${base}/api/review-witness-requests/${requestId}/retry`, { method: "POST", headers: apiHeaders() });
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json() as any;
    validateResponse("retryWitnessRequest", retriedBody);
    expect(retriedBody.state).toBe("retrying");
    expect(retriedBody.retryCount).toBe(1);
    expect(retriedBody.failure).toBeNull();
    page = visible(await (await fetch(`${base}/${workspace}/r/promoted-source/rev/1`, { headers: sessionHeaders() })).text());
    expect(page).toContain("Witness retrying");

    // Retrying a pending request is idempotent: it must not inflate the count and make
    // the reader say "retrying" about an attempt nobody has failed.
    const again = await fetch(`${base}/api/review-witness-requests/${requestId}/retry`, { method: "POST", headers: apiHeaders() });
    expect((await again.json() as any).retryCount).toBe(1);

    // A bounded failure body, and nothing else in it.
    const tooLong = await fetch(`${base}/api/review-witness-requests/${requestId}/fail`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ error: "x".repeat(601) }),
    });
    expect(tooLong.status).toBe(422);
    const unsupported = await fetch(`${base}/api/review-witness-requests/${requestId}/fail`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ error: "fine", note: "extra" }),
    });
    expect(unsupported.status).toBe(422);
  });

  test("evidence is paged along file seams, at most 100 canonical changes to a page", async () => {
    const inventory = getStageCapture(wideCapture.id, workspace)!;
    expect(inventory.changes.length).toBe(150);
    const seams = evidenceSeams(inventory);
    expect(seams.length).toBe(2);
    for (const seam of seams) {
      const changes = seam.members.filter((member) => member.type === "change").length;
      expect(changes).toBeLessThanOrEqual(MAX_EVIDENCE_PAGE_CHANGES);
      // Navigation, not judgment.
      expect(seam.category).toBeNull();
      expect(seam.importance).toBeNull();
      expect(seam.complexity).toBeNull();
      expect(seam.explanation).toBeNull();
      expect(seam.members.every((member) => member.description === null)).toBe(true);
    }
    expect(seams[0]!.members.filter((member) => member.type === "change")).toHaveLength(100);
    expect(seams[1]!.members.filter((member) => member.type === "change")).toHaveLength(50);
    // Every canonical change appears exactly once across the pages.
    const paged = seams.flatMap((seam) => seam.members.filter((member) => member.type === "change").map((member) => member.id));
    expect(new Set(paged).size).toBe(150);
    expect(new Set(paged)).toEqual(new Set(inventory.changes.map((change) => change.id)));

    // A file larger than one page owns every numbered part; the next file cannot join
    // its tail and make "part 2" mean two different files.
    const firstFile = inventory.files[0]!, secondFile = inventory.files[1]!;
    const sample = inventory.changes[0]!;
    const madeChanges = (count: number, fileId: string, offset: number) => Array.from({ length: count }, (_, index) => ({
      ...sample,
      id: `chg_${(offset + index).toString(16).padStart(64, "0")}`,
      file_id: fileId,
      old_start: offset + index + 1,
      new_start: offset + index + 1,
    }));
    const oversized = evidenceSeams({
      ...inventory,
      files: [firstFile, secondFile],
      changes: [...madeChanges(150, firstFile.id, 1), ...madeChanges(10, secondFile.id, 1000)],
      incomplete: [],
    });
    expect(oversized).toHaveLength(3);
    expect(oversized[0]!.title).toContain("part 1 of 2");
    expect(oversized[1]!.title).toContain("part 2 of 2");
    expect(oversized[2]!.title).not.toContain("part");
    expect(oversized[1]!.members).toHaveLength(50);
    expect(oversized[2]!.members).toHaveLength(10);

    // Missing and leafless items are bounded too. A thousand mode-only files must not
    // sneak through a change-only limit as one enormous focus response.
    const pureFiles = Array.from({ length: 250 }, (_, index) => ({
      ...firstFile,
      id: `stf_${index.toString(32).padStart(10, "0")}`,
      path: `pure/${index.toString().padStart(4, "0")}.txt`,
    }));
    const pure = evidenceSeams({ ...inventory, files: pureFiles, changes: [], incomplete: [] });
    expect(pure).toHaveLength(3);
    expect(pure.map((group) => group.members.length)).toEqual([100, 100, 50]);

    const captureMaterial = {
      id: tinyId("sti"), workspace_id: workspace, capture_id: inventory.capture.id,
      kind: "metadata_incomplete" as const, path: null, side: "snapshot" as const,
      reason: "Compare metadata reached its ceiling.",
    };
    const withCaptureMaterial = evidenceSeams({ ...inventory, incomplete: [captureMaterial] });
    expect(withCaptureMaterial[0]!.title).toBe("Capture material");
    expect(withCaptureMaterial[0]!.members).toEqual([{ type: "material", id: captureMaterial.id, description: null }]);
    expect(withCaptureMaterial[1]!.title).not.toBe("Capture material");

    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering evidence"); });
    const overview = await (await fetch(`${base}/${workspace}/r/wide-review/rev/1`, { headers: sessionHeaders() })).text();
    expect(overview.match(/class="review-group-card"/g)).toHaveLength(2);
    const focus = await fetch(`${base}/${workspace}/r/wide-review/rev/1?review=${seams[0]!.id}`, { headers: sessionHeaders() });
    expect(focus.status).toBe(200);
    const focusBody = await focus.text();
    expect(focusBody.match(/class="hunk-review/g)).toHaveLength(100);
  });
});

describe("publishing an account", () => {
  const witness = { name: "Witness", model: "review-model" };

  function accountBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const members = partition(capture);
    return {
      witness,
      summary: "The witness read every retained leaf.",
      groups: [{ id: "walkthrough", title: "Walkthrough", category: "Code", importance: "high", complexity: "medium", explanation: "Read the implementation first.", examples: [], members }],
      ...extra,
    };
  }

  test("validation refuses an incomplete partition, a foreign anchor, duplicate ids, and unowned evidence", async () => {
    const members = partition(capture);
    const cases: { name: string; body: Record<string, unknown>; expect: string }[] = [
      {
        name: "an incomplete partition",
        body: accountBody({ groups: [{ id: "walkthrough", title: "Walkthrough", category: "Code", importance: "high", complexity: "medium", explanation: "Partial.", examples: [], members: members.slice(1) }] }),
        expect: "omits",
      },
      {
        name: "a focus anchor the capture does not hold",
        body: accountBody({ focus: [{ id: "risk-one", kind: "risk", title: "Somewhere else", body: "Not here.", anchors: [{ type: "change", id: "chg_" + "f".repeat(64) }] }] }),
        expect: "is not a change in capture",
      },
      {
        name: "two focus items sharing an id",
        body: accountBody({ focus: [
          { id: "same", kind: "risk", title: "One", body: "First.", anchors: [{ type: "change", id: members.find((m) => m.type === "change")!.id }] },
          { id: "same", kind: "decision", title: "Two", body: "Second.", anchors: [{ type: "change", id: members.find((m) => m.type === "change")!.id }] },
        ] }),
        expect: "duplicates focus id same",
      },
      {
        name: "an attachment from no workspace",
        body: accountBody({ evidence: [{ kind: "attachment", id: "att_nothinghere" }] }),
        expect: "no attachment att_nothinghere in this workspace",
      },
      {
        name: "a bundle version that does not exist",
        body: accountBody({ evidence: [{ kind: "bundle", slug: bundleSlug, version: 99 }] }),
        expect: `no bundle "${bundleSlug}" at version 99`,
      },
      {
        name: "a witness with no model",
        body: accountBody({ witness: { name: "Witness" } }),
        expect: "witness.model",
      },
    ];
    for (const entry of cases) {
      const response = await publishAccountFor("promoted-source", 1, entry.body);
      const body = await response.json() as any;
      const said = JSON.stringify(body).replaceAll('\\"', '"');
      expect({ case: entry.name, status: response.status, said: said.includes(entry.expect) })
        .toEqual({ case: entry.name, status: 422, said: true });
    }
    // Nothing was written by any of them.
    expect(db.query("SELECT 1 FROM review_accounts WHERE workspace_id = ? AND slug = 'promoted-source'").get(workspace)).toBeNull();
  });

  test("an account adds the witness account, the partition, focus items and cited evidence", async () => {
    const members = partition(capture);
    const changeId = members.find((member) => member.type === "change")!.id;
    const materialId = members.find((member) => member.type === "material")!.id;
    const changedFileId = capture.files.find((file: any) => file.path === "src/value.ts")!.id;
    const body = accountBody({
      focus: [
        { id: "chose-reconstruction", kind: "decision", title: "Reconstructed the binary side", body: "The bytes are retained; the lines are not.", anchors: [{ type: "change", id: changeId }, { type: "material", id: materialId }, { type: "file", id: changedFileId }] },
        { id: "binary-blind-spot", kind: "risk", title: "A binary change reads as a fact", body: "Nobody can review these bytes by eye.", anchors: [{ type: "material", id: materialId }] },
      ],
      evidence: [
        { kind: "attachment", id: "att_evidence00" },
        { kind: "bundle", slug: bundleSlug, version: 1 },
      ],
    });
    const revision = getRevision(workspace, "promoted-source", 1)!;
    const pending = getWitnessRequestForRevision(workspace, revision.id)!;
    const failed = await fetch(`${base}/api/review-witness-requests/${pending.id}/fail`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ error: "Transient witness failure." }),
    });
    expect(failed.status).toBe(200);
    const beforeRetry = await publishAccountFor("promoted-source", 1, body);
    expect(beforeRetry.status).toBe(409);
    expect((await beforeRetry.json() as any).error).toContain("Retry the failed witness request");
    expect((await fetch(`${base}/api/review-witness-requests/${pending.id}/retry`, { method: "POST", headers: apiHeaders() })).status).toBe(200);

    const response = await publishAccountFor("promoted-source", 1, body);
    expect(response.status).toBe(200);
    const view = await response.json() as any;
    validateResponse("publishReviewAccount", view);
    expect(view.version).toBe(1);
    expect(view.revision).toBe(1);
    expect(view.witness.state).toBe("published");
    expect(view.witness.accountId).toBe(view.id);
    expect(view.document.witness.agent).toEqual(witness);
    expect(view.document.focus.map((item: any) => item.id)).toEqual(["chose-reconstruction", "binary-blind-spot"]);
    // Two focus items anchored to the same material: anchors overlap and own nothing.
    expect(view.document.focus[0].anchors).toHaveLength(3);
    expect(view.document.evidence[0]).toEqual({
      kind: "attachment",
      id: "att_evidence00",
      reviewSlug: "legacy-evidence",
      mediaType: "image/png",
      bytes: 3,
      alt: "a shot",
      caption: "the gate",
    });

    // A stale failure writer cannot move the already-published workflow row backwards.
    expect(() => failWitnessRequest(workspace, pending, "late failure")).toThrow(RevisionWriteError);
    expect(getWitnessRequestForRevision(workspace, revision.id)!.state).toBe("published");

    // Exact replay returns the same account; a different one conflicts.
    const replay = await publishAccountFor("promoted-source", 1, body);
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).id).toBe(view.id);
    const conflicting = await publishAccountFor("promoted-source", 1, accountBody({ summary: "A different account." }));
    expect(conflicting.status).toBe(409);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_accounts WHERE workspace_id = ?").get(workspace)!.n).toBe(1);

    const lineage = await (await fetch(`${base}/api/review-lineages/promoted-source`, { headers: apiHeaders() })).json() as any;
    validateResponse("readReviewLineage", lineage);
    expect(lineage.latestAccountVersion).toBe(1);
    expect(lineage.accounts).toEqual([{ version: 1, revision: 1, createdAt: expect.any(String), url: `${config.baseUrl}/${workspace}/r/promoted-source/v/1` }]);
  });

  test("the account reads at /v/1 while the pinned evidence URL stays evidence", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    const account = await fetch(`${base}/${workspace}/r/promoted-source/v/1`, { headers: sessionHeaders() });
    expect(account.status).toBe(200);
    const accountBodyText = visible(await account.text());
    expect(accountBodyText).toContain("Witness<span> · review-model");
    expect(accountBodyText).toContain("The witness read every retained leaf.");
    expect(accountBodyText).toContain("Reconstructed the binary side");
    expect(accountBodyText).toContain("A binary change reads as a fact");
    expect(accountBodyText).toContain("the gate");
    expect(accountBodyText).toContain(`${bundleSlug} v1`);
    expect(accountBodyText).toContain(`/${workspace}/r/legacy-evidence/a/att_evidence00`);
    expect(accountBodyText).toContain(`?review=walkthrough#focus-`);
    expect(accountBodyText).toContain(`#review-file-walkthrough-`);
    expect(accountBodyText).not.toContain(`<code>${capture.files.find((file: any) => file.path === "src/value.ts")!.id}</code>`);
    expect(accountBodyText).toContain("category-summary");
    expect(accountBodyText).toContain("signal-scale");
    expect(accountBodyText).not.toContain("Witness pending");

    // The pinned evidence URL did not move, did not redirect, and did not gain an account.
    const evidence = await fetch(`${base}/${workspace}/r/promoted-source/rev/1`, { headers: sessionHeaders(), redirect: "manual" });
    expect(evidence.status).toBe(200);
    const evidenceText = visible(await evidence.text());
    expect(evidenceText).toContain("Revision 1");
    expect(evidenceText).not.toContain("The witness read every retained leaf.");
    expect(evidenceText).not.toContain("signal-scale");
    // Same code stream underneath: both name the same canonical changes.
    const ids = (page: string) => page.match(/data-stage-change-ids="([^"]*)"/)![1];
    expect(ids(evidenceText)).toBe(ids(accountBodyText));

    // And the bare URL now resolves to the account.
    const bare = await fetch(`${base}/${workspace}/r/promoted-source`, { headers: sessionHeaders() });
    expect(visible(await bare.text())).toContain("The witness read every retained leaf.");
  });
});

describe("reads, dispatch and refusals", () => {
  test("a read mark is personal and belongs to the revision, so evidence and account share it", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    const revision = getRevision(workspace, "promoted-source", 1)!;
    const inventory = getStageCapture(capture.id, workspace)!;
    const changeId = inventory.changes[0]!.id;
    const seam = evidenceSeams(inventory)[0]!;
    const action = `${base}/${workspace}/r/promoted-source/rev/1/changes/${changeId}/read`;

    const saved = await fetch(action, {
      method: "POST",
      headers: sessionHeaders({ origin: new URL(config.baseUrl).origin, accept: "application/json" }),
      body: new URLSearchParams({ read: "true" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json() as any).toEqual({ changeId, read: true });

    const evidence = await (await fetch(`${base}/${workspace}/r/promoted-source/rev/1?review=${seam.id}&change=${changeId}`, { headers: sessionHeaders() })).text();
    expect(evidence).toContain(`data-change="${changeId}" data-read="true"`);
    const account = await (await fetch(`${base}/${workspace}/r/promoted-source/v/1?review=walkthrough&change=${changeId}`, { headers: sessionHeaders() })).text();
    expect(account).toContain(`data-change="${changeId}" data-read="true"`);
    // Another member is unaffected.
    expect(listRevisionReadChangeIds(workspace, revision.id, second)).toEqual(new Set());

    // The no-JavaScript path returns to the page the form was on, and only ever to a
    // path inside this review.
    const returned = await fetch(action, {
      method: "POST", redirect: "manual",
      headers: sessionHeaders({ origin: new URL(config.baseUrl).origin }),
      body: new URLSearchParams({ read: "false", return: `/${workspace}/r/promoted-source/v/1?review=walkthrough` }),
    });
    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe(`/${workspace}/r/promoted-source/v/1?review=walkthrough`);
    const foreignReturn = await fetch(action, {
      method: "POST", redirect: "manual",
      headers: sessionHeaders({ origin: new URL(config.baseUrl).origin }),
      body: new URLSearchParams({ read: "true", return: "https://elsewhere.example/steal" }),
    });
    expect(foreignReturn.headers.get("location")).toBe(`/${workspace}/r/promoted-source/rev/1`);
    const foreignOrigin = await fetch(action, {
      method: "POST",
      headers: sessionHeaders({ origin: "https://elsewhere.example" }),
      body: new URLSearchParams({ read: "true" }),
    });
    expect(foreignOrigin.status).toBe(403);
  });

  test("workspace dispatch checks the legacy review first, and old bare links never change", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    // A legacy review keeps its own page at the workspace path.
    const legacy = await fetch(`${base}/${workspace}/r/legacy-evidence`, { headers: sessionHeaders() });
    expect(legacy.status).toBe(200);
    expect(visible(await legacy.text())).not.toContain("data-stage-change-ids");

    // Bare /r/ is legacy-only in both shapes: a promoted slug is a miss there, with the
    // legacy soft-miss body, so an old link can never start resolving to a new thing.
    const barePromoted = await fetch(`${base}/r/promoted-source`, { headers: sessionHeaders() });
    const barePromotedVersion = await fetch(`${base}/r/promoted-source/v/1`, { headers: sessionHeaders() });
    const bareMissing = await fetch(`${base}/r/nothing-at-all`, { headers: sessionHeaders() });
    expect([barePromoted.status, barePromotedVersion.status, bareMissing.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([barePromoted.text(), barePromotedVersion.text(), bareMissing.text()]);
    expect(new Set(bodies).size).toBe(1);
    const bareLegacy = await fetch(`${base}/r/legacy-evidence`, { headers: sessionHeaders() });
    expect(bareLegacy.status).toBe(200);
  });

  test("page and API misses each preserve their shipped review refusal", async () => {
    const pages = await Promise.all([
      fetch(`${base}/${workspace}/r/promoted-source/rev/2`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/r/promoted-source/rev/01`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/r/promoted-source/v/9`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/r/legacy-evidence/rev/1`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/r/never-published`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/r/never-published/rev/1`, { headers: sessionHeaders() }),
    ]);
    const pageBodies = await Promise.all(pages.map((response) => response.text()));
    expect(pages.map((response) => response.status)).toEqual(Array(pages.length).fill(404));
    expect(new Set(pages.map((response) => response.headers.get("cache-control")))).toEqual(new Set(["no-store"]));
    expect(new Set(pages.map((response) => response.headers.get("content-type")))).toEqual(new Set(["text/html;charset=utf-8"]));
    expect(new Set(pageBodies).size).toBe(1);
    expect(pageBodies[0]).toContain("No such review");

    const api = await Promise.all([
      fetch(`${base}/api/review-lineages/promoted-source/revisions/2`, { headers: apiHeaders() }),
      fetch(`${base}/api/review-lineages/NOT-A-SLUG`, { headers: apiHeaders() }),
      fetch(`${base}/api/review-lineages/never-published`, { headers: apiHeaders() }),
      fetch(`${base}/api/review-lineages/promoted-source/revisions/1/files/not-an-id?side=new`, { headers: apiHeaders() }),
      fetch(`${base}/api/review-witness-requests/wtr_0000000000/retry`, { method: "POST", headers: apiHeaders() }),
      fetch(`${base}/api/review-witness-requests/not-an-id/retry`, { method: "POST", headers: apiHeaders() }),
    ]);
    const apiBodies = await Promise.all(api.map((response) => response.text()));
    expect(api.map((response) => response.status)).toEqual(Array(api.length).fill(404));
    expect(new Set(api.map((response) => response.headers.get("content-type")))).toEqual(new Set(["application/json"]));
    expect(new Set(apiBodies)).toEqual(new Set([JSON.stringify({ error: "No such review" }, null, 2)]));
  });

  test("a stale focus on a resolved promoted page lands on that page, not on a miss", async () => {
    // Membership and the lineage already resolved, so a group id an older account used, or
    // a change from another seam, hides nothing: the reader is sent to the page the link
    // was pinned to. A bookmark made before a new account changed the group ids still
    // opens the review. The bare latest URL keeps its own address.
    const stale = await Promise.all([
      fetch(`${base}/${workspace}/r/promoted-source/rev/1?review=not-a-seam`, { headers: sessionHeaders(), redirect: "manual" }),
      fetch(`${base}/${workspace}/r/promoted-source/rev/1?review=seam-1&change=chg_${"0".repeat(64)}`, { headers: sessionHeaders(), redirect: "manual" }),
      fetch(`${base}/${workspace}/r/promoted-source?review=nope`, { headers: sessionHeaders(), redirect: "manual" }),
    ]);
    expect(stale.map((response) => response.status)).toEqual([303, 303, 303]);
    expect(stale.map((response) => response.headers.get("location"))).toEqual([
      `/${workspace}/r/promoted-source/rev/1`,
      `/${workspace}/r/promoted-source/rev/1`,
      `/${workspace}/r/promoted-source`,
    ]);
    expect(new Set(stale.map((response) => response.headers.get("cache-control")))).toEqual(new Set(["no-store"]));
    const landed = await fetch(`${base}/${workspace}/r/promoted-source/rev/1?review=not-a-seam`, { headers: sessionHeaders() });
    expect(landed.status).toBe(200);
    expect(await landed.text()).not.toContain("No such review");
    // A stranger's stale focus is still the soft miss, because nothing resolved for them;
    // AUTH_DISABLED makes every session here the root user, so that half is asserted in
    // revision-privacy.script.ts beside the other read refusals.
  });

  test("the same slug in two workspaces is two reviews, and a key writes only in its own", async () => {
    const otherCapture = await createCapture("cross-source", "cross-source-capture", otherKey);
    const created = await createLineage({ captureId: otherCapture.id, slug: "promoted-source", title: "Elsewhere" }, otherKey);
    expect(created.status).toBe(200);
    expect((await created.json() as any).workspace).toBe(otherWorkspace);
    // Two rows, two workspaces, one slug — and neither one moved.
    expect(getLineage(workspace, "promoted-source")!.title).toBe("A readable review revision");
    expect(getLineage(otherWorkspace, "promoted-source")!.title).toBe("Elsewhere");

    // Writing is the key's workspace and nothing else: `wide-review` exists only here,
    // so the foreign key finds nothing to publish over. (Reading turns on the SESSION
    // too, and AUTH_DISABLED makes every request in this process the root user's, so
    // the read side of this is asserted in revision-privacy.script.ts instead.)
    const foreignAccount = await publishAccountFor("wide-review", 1, { witness: { name: "W", model: "m" }, summary: "x", groups: [] }, otherKey);
    expect(foreignAccount.status).toBe(404);
  });

  test("member pages, reads and lines stay private with auth enabled", async () => {
    const stranger = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [stranger, "revision-stranger@example.com", Date.now()]);
    const file = capture.files.find((entry: any) => entry.path === "src/value.ts");
    const inventory = getStageCapture(capture.id, workspace)!;
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "revision-privacy.script.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AUTH_DISABLED: undefined as unknown as string,
        DATA_DIR: config.dataDir,
        REVISION_WORKSPACE: workspace,
        REVISION_SLUG: "promoted-source",
        REVISION_OWNER: owner,
        REVISION_MEMBER: second,
        REVISION_STRANGER: stranger,
        REVISION_CHANGE: inventory.changes[0]!.id,
        REVISION_SEAM: evidenceSeams(inventory)[0]!.id,
        REVISION_FILE: file.id,
        REVISION_KEY: key,
        REVISION_OTHER_KEY: otherKey,
        REVISION_LOCAL_ONLY_SLUG: "wide-review",
      },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error(error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  });
});
