// A moving pull request appends one revision and carries only what it can prove.
//
// The fixture is built so that two consecutive captures share ONE hunk exactly and differ
// in the other. `src/a.ts` changes the same line the same way in every capture, at a
// different position each time — so its fingerprints match while its canonical id does not,
// which is precisely the case a rebase produces and precisely the case a read must survive.
// `src/b.ts` changes to a different value, so its read must not survive.
//
// Nothing here opens a socket: the read router seam records which actor was opened, and the
// GitHub client is a fixture. That recording is load-bearing more than once — "a webhook
// never spends a personal credential" and "the worker never asks what the pull request
// looks like now" are both claims about calls that were NOT made.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { sessionCookie } from "../../src/auth";
import { tinyId } from "../../src/ids";
import { openApiSpec } from "../../src/agent-discovery";
import { setGithubClientFactory, setReadRouter, type ReadActor } from "../../src/overseer/github-app";
import type { GithubClient, GithubPull, GithubTreeEntry } from "../../src/overseer/github";
import { offlineGithubClientFactory, offlineReadRouter } from "../offline-github";
import {
  captureJobView,
  completeCaptureJob,
  getCaptureJob,
  settleCaptureJobs,
  stopCaptureSweep,
} from "../../src/overseer/revision-jobs";
import {
  carryRevisionReads,
  countRevisionReadCarries,
  getLineage,
  getRevision,
  getWitnessRequestForRevision,
  getWitnessSupersession,
  listRevisionReadCarries,
  listRevisionReadChangeIds,
  setRevisionChangeRead,
  workflowWord,
  type ReviewRevisionRow,
} from "../../src/overseer/revision-db";
import { getObservation, latestObservation } from "../../src/overseer/revision-pr";
import { revisionCodeDelta } from "../../src/overseer/revision-delta";
import { WEBHOOK_PATH, webhookSignature } from "../../src/overseer/webhook";
import { getStageCapture, type StageCaptureInventory } from "../../src/stage/db";

// ---- the repository this suite moves ----

const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE = sha(0x100), BASE2 = sha(0x101);
const MERGE = sha(0x110);
const HEAD1 = sha(0x120), HEAD2 = sha(0x121), HEAD3 = sha(0x122), HEAD_LATER = sha(0x123);
const A_OLD = sha(0x200), A_NEW = sha(0x201);
const B_OLD = sha(0x210), B_NEW = sha(0x211), B_NEW2 = sha(0x212);

const enc = (value: string) => new TextEncoder().encode(value);
const blobs = new Map<string, Uint8Array>([
  [A_OLD, enc("export const a = 1;\n")],
  [A_NEW, enc("export const a = 2;\n")],
  [B_OLD, enc("export const b = 1;\n")],
  [B_NEW, enc("export const b = 2;\n")],
  [B_NEW2, enc("export const b = 3;\n")],
]);

const REPO = "Acme/Mover";
const REPO_ID = 550;

function entry(path: string, object: string): GithubTreeEntry {
  return { path, mode: "100644", type: "blob", sha: object, size: blobs.get(object)!.byteLength };
}

const TREES: Record<string, GithubTreeEntry[]> = {
  [MERGE]: [entry("src/a.ts", A_OLD), entry("src/b.ts", B_OLD)],
  [HEAD1]: [entry("src/a.ts", A_NEW), entry("src/b.ts", B_NEW)],
  [HEAD2]: [entry("src/a.ts", A_NEW), entry("src/b.ts", B_NEW2)],
  [HEAD3]: [entry("src/a.ts", A_NEW), entry("src/b.ts", B_NEW2)],
  [HEAD_LATER]: [entry("src/a.ts", A_NEW), entry("src/b.ts", B_NEW2)],
};

/** The same one-line change to `src/a.ts`, at whatever position the rebase left it. */
function aPatch(oldStart: number, newStart: number): string {
  return `@@ -${oldStart},1 +${newStart},1 @@\n-export const a = 1;\n+export const a = 2;\n`;
}
function bPatch(value: string): string {
  return `@@ -1,1 +1,1 @@\n-export const b = 1;\n+export const b = ${value};\n`;
}
function patches(head: string): { a: string; b: string } {
  return head === HEAD1
    ? { a: aPatch(1, 1), b: bPatch("2") }
    : { a: aPatch(40, 41), b: bPatch("3") };
}

function comparison(head: string) {
  const patch = patches(head);
  return {
    merge_base_commit: { sha: MERGE },
    files: [
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: patch.a },
      { filename: "src/b.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: patch.b },
    ],
  };
}

function diffFor(head: string): string {
  const patch = patches(head);
  return [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", patch.a.trimEnd(),
    "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", patch.b.trimEnd(), "",
  ].join("\n");
}

interface RepoRef { id: number; full_name: string }
interface PullShape {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  updated_at: string;
  base: { ref: string; sha: string; repo: RepoRef | null };
  head: { ref: string; sha: string; repo: RepoRef | null };
}

function pull(overrides: Partial<PullShape> = {}): PullShape {
  return {
    number: 10,
    title: "Move the values",
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-04-01T10:00:00Z",
    base: { ref: "main", sha: BASE, repo: { id: REPO_ID, full_name: REPO } },
    head: { ref: "feature/mover", sha: HEAD1, repo: { id: REPO_ID, full_name: REPO } },
    ...overrides,
  };
}

function githubFixture(pullPayload: unknown = pull()): GithubClient {
  return {
    async getPull() { return pullPayload as unknown as GithubPull; },
    async listCommits() { return []; },
    async listFiles() { return []; },
    async listReviewComments() { return []; },
    async getFileAtSha() { throw new Error("unused"); },
    async getPullDiff() { return ""; },
    async getRepository() { return { id: REPO_ID, full_name: REPO, default_branch: "main" }; },
    async getRef(_repo, ref) { return { ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD1, type: "commit" as const }; },
    async getTree(_repo, commit) { return { sha: commit, truncated: false, tree: TREES[commit] ?? [] }; },
    async getBlobBytes(_repo, object) { return blobs.get(object)!; },
    async compare(_repo, _base, head) { return comparison(head); },
    async compareDiff(_repo, _base, head) { return diffFor(head); },
  };
}

// ---- the read router seam ----

let opened: ReadActor[] = [];
let resolvedActor: ReadActor = { kind: "installation", installationId: 5100 };
let currentClient: GithubClient = githubFixture();
let holdOpen: { ordinal: number; wait: Promise<void>; release: () => void } | null = null;
let openCount = 0;

/** Hold the Nth open of this test and hand back its release. The webhook endpoint opens
 *  nothing itself, so the first open after a delivery is always the worker's. */
function holdOpenAt(ordinal: number): { release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  holdOpen = { ordinal, wait, release };
  return { release };
}

function installRouter(): void {
  setReadRouter({
    async resolve() { return resolvedActor; },
    async open(_workspaceId, actor) {
      opened.push(actor);
      const client = currentClient;
      openCount += 1;
      if (holdOpen && openCount === holdOpen.ordinal) await holdOpen.wait;
      return client;
    },
  });
}

// ---- fixtures ----

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let second = "";
let key = "";
let secondKey = "";
let cookie = "";
let secondCookie = "";

const INSTALLATION = 5100;

const jsonHeaders = (token = key, idempotency?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...(idempotency === undefined ? {} : { "idempotency-key": idempotency }),
});

function validateResponse(operationId: string, body: unknown, status = "200"): void {
  const operation = Object.values((openApiSpec() as any).paths)
    .flatMap((path: any) => Object.values(path))
    .find((candidate: any) => candidate.operationId === operationId) as any;
  if (!operation) throw new Error(`no operation ${operationId} in the served document`);
  const schema = operation.responses[status]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`no ${status} schema for ${operationId}`);
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(body)) throw new Error(`${operationId}: ${ajv.errorsText(validate.errors)}`);
}

function visible(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
}

function inventoryOf(revision: ReviewRevisionRow): StageCaptureInventory {
  return getStageCapture(revision.capture_id, workspace)!;
}

/** The one canonical change of one path in one revision. */
function changeIdFor(revision: ReviewRevisionRow, path: string): string {
  const inventory = inventoryOf(revision);
  const file = inventory.files.find((candidate) => candidate.path === path)!;
  return inventory.changes.find((candidate) => candidate.file_id === file.id)!.id;
}

function partitionOf(captureId: string): unknown[] {
  const changes = db.query<{ id: string; file_id: string }, [string]>(
    "SELECT id, file_id FROM stage_capture_changes WHERE capture_id = ?",
  ).all(captureId);
  const material = db.query<{ id: string; path: string | null }, [string]>(
    "SELECT id, path FROM stage_capture_incomplete WHERE capture_id = ?",
  ).all(captureId);
  const files = db.query<{ id: string; path: string }, [string]>(
    "SELECT id, path FROM stage_capture_files WHERE capture_id = ?",
  ).all(captureId);
  return [
    ...changes.map((row) => ({ type: "change", id: row.id, description: "Read it" })),
    ...material.map((row) => ({ type: "material", id: row.id, description: "Account for it" })),
    ...files
      .filter((file) => !changes.some((change) => change.file_id === file.id) &&
        !material.some((item) => item.path === file.path))
      .map((file) => ({ type: "file", id: file.id, description: "Structural change" })),
  ];
}

function count(sql: string, ...params: (string | number)[]): number {
  return db.query<{ n: number }, (string | number)[]>(sql).get(...params)!.n;
}

async function ingest(body: unknown, idempotency: string, token = key): Promise<Response> {
  return fetch(`${base}/api/pull-request-review-lineages`, {
    method: "POST", headers: jsonHeaders(token, idempotency), body: JSON.stringify(body),
  });
}

async function refresh(slug: string, idempotency: string, token = key): Promise<Response> {
  return fetch(`${base}/api/review-lineages/${slug}/refresh`, {
    method: "POST", headers: jsonHeaders(token, idempotency),
  });
}

function deliver(payload: unknown, deliveryId: string): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${base}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": webhookSignature(config.githubApp.webhookSecret, body),
    },
    body,
  });
}

function deliveryPayload(number: number, head: string, updatedAt: string, baseSha = BASE): unknown {
  return {
    action: "synchronize",
    installation: { id: INSTALLATION },
    repository: { id: REPO_ID, full_name: REPO },
    pull_request: {
      number, title: "Move the values", state: "open", merged: false, draft: false,
      updated_at: updatedAt,
      base: { ref: "main", sha: baseSha, repo: { id: REPO_ID, full_name: REPO } },
      head: { ref: "feature/mover", sha: head, repo: { id: REPO_ID, full_name: REPO } },
    },
  };
}

async function markRead(slug: string, revision: number, changeId: string, read: boolean, who = cookie): Promise<Response> {
  return fetch(`${base}/${workspace}/r/${slug}/rev/${revision}/changes/${changeId}/read`, {
    method: "POST",
    headers: { cookie: who, origin: new URL(config.baseUrl).origin, accept: "application/json" },
    body: new URLSearchParams({ read: String(read) }),
  });
}

beforeAll(async () => {
  server = await startServer();
  stopCaptureSweep();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Moving pull requests", owner);
  key = mintApiKey(owner, workspace, "mover").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  second = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, ?, ?)", [second, "mover-second@example.com", Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, second, Date.now()]);
  secondKey = mintApiKey(second, workspace, "mover-second").token;
  secondCookie = sessionCookie(second).split(";")[0]!;
  db.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at, created_at) " +
      "VALUES (?, ?, ?, 'Acme', 1, 'Organization', 'all', ?, ?, ?)",
    [tinyId("ghi"), workspace, INSTALLATION, owner, Date.now(), Date.now()],
  );
  installRouter();
});

afterEach(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  currentClient = githubFixture();
  resolvedActor = { kind: "installation", installationId: INSTALLATION };
  opened = [];
  holdOpen?.release();
  holdOpen = null;
  openCount = 0;
  stopCaptureSweep();
  installRouter();
});

afterAll(async () => {
  stopCaptureSweep();
  await settleCaptureJobs();
  setReadRouter(offlineReadRouter());
  server.stop(true);
});

// ---- one lineage, moved three ways ----

describe("a moving pull request appends one revision at a time", () => {
  test("the first capture publishes revision 1, and its witness has no prior account", async () => {
    const created = await ingest({ repo: REPO, number: 10, slug: "mover" }, "mover-1");
    expect(created.status).toBe(202);
    await settleCaptureJobs();

    const revision = getRevision(workspace, "mover", 1)!;
    expect(revision.doc.source.sourceHeadSha).toBe(HEAD1);
    expect(revision.doc.source.baseTipSha).toBe(BASE);
    expect(revision.doc.source.mergeBaseSha).toBe(MERGE);
    expect(inventoryOf(revision).changes).toHaveLength(2);

    // The first revision of a lineage changed nothing about anything.
    const view = await (await fetch(`${base}/api/review-lineages/mover/revisions/1`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("readReviewRevision", view);
    expect(view.delta).toBeNull();
    expect(view.drift).toEqual({ newerRevision: null, newerRevisionUrl: null, sourceRevision: null, sourceRevisionUrl: null, moved: false, capture: null, refreshRequired: false });

    const request = getWitnessRequestForRevision(workspace, revision.id)!;
    const claim = await (await fetch(`${base}/api/review-witness-requests/${request.id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("claimWitnessRequest", claim);
    // Nothing was published before revision 1, so there is nothing to hand a fresh witness.
    expect(claim.priorAccount).toBeNull();
  });

  test("an account is published over revision 1, and both members read one hunk each", async () => {
    const revision = getRevision(workspace, "mover", 1)!;
    const published = await fetch(`${base}/api/review-lineages/mover/revisions/1/accounts`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({
        witness: { name: "Witness", model: "review-model" },
        summary: "Two values moved.",
        groups: [{
          id: "all", title: "All", category: "Code", importance: "low", complexity: "low",
          explanation: "Everything.", examples: [], members: partitionOf(revision.capture_id),
        }],
      }),
    });
    expect(published.status).toBe(200);
    validateResponse("publishReviewAccount", await published.json());

    const a = changeIdFor(revision, "src/a.ts");
    const b = changeIdFor(revision, "src/b.ts");
    expect((await markRead("mover", 1, a, true)).status).toBe(200);
    expect((await markRead("mover", 1, b, true)).status).toBe(200);
    // AUTH_DISABLED makes every in-process session the root user, so another member's
    // row is seeded through the same production write boundary rather than a fake cookie.
    setRevisionChangeRead(workspace, revision.id, second, b, true);
    expect(listRevisionReadChangeIds(workspace, revision.id, owner)).toEqual(new Set([a, b]));
    expect(listRevisionReadChangeIds(workspace, revision.id, second)).toEqual(new Set([b]));
  });

  test("an explicit refresh appends revision 2 and carries exactly the unchanged hunk", async () => {
    const first = getRevision(workspace, "mover", 1)!;
    const firstA = changeIdFor(first, "src/a.ts");
    const firstB = changeIdFor(first, "src/b.ts");

    currentClient = githubFixture(pull({ head: { ref: "feature/mover", sha: HEAD2, repo: { id: REPO_ID, full_name: REPO } }, updated_at: "2026-04-02T10:00:00Z" }));
    const response = await refresh("mover", "mover-refresh-1");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    validateResponse("refreshReviewLineagePullRequest", body);
    expect(body.behind).toBe(true);
    expect(body.sourceRevision).toBeNull();
    expect(body.captureJob).not.toBeNull();
    await settleCaptureJobs();

    const second2 = getRevision(workspace, "mover", 2)!;
    expect(second2.doc.source.sourceHeadSha).toBe(HEAD2);
    expect(getLineage(workspace, "mover")!.latest_revision).toBe(2);

    const secondA = changeIdFor(second2, "src/a.ts");
    const secondB = changeIdFor(second2, "src/b.ts");
    // The rebase moved the hunk, so its canonical id is a different id — which is exactly
    // why an id may not decide a carry.
    expect(secondA).not.toBe(firstA);

    // The owner read both hunks; only the one whose bytes are unchanged carried.
    expect(listRevisionReadChangeIds(workspace, second2.id, owner)).toEqual(new Set([secondA]));
    // The other member read only the changed hunk, so nothing of theirs carried.
    expect(listRevisionReadChangeIds(workspace, second2.id, second)).toEqual(new Set());

    const provenance = listRevisionReadCarries(workspace, second2.id, owner);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.source_revision_id).toBe(first.id);
    expect(provenance[0]!.source_change_id).toBe(firstA);
    expect(provenance[0]!.target_change_id).toBe(secondA);
    expect(provenance[0]!.key_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(secondB).toBeTruthy();

    // Nothing else was created: no acknowledgement, no judgment, no approval.
    for (const table of ["review_acknowledgements", "review_judgments", "review_approvals"]) {
      expect(db.query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)).toBeNull();
    }
  });

  test("the revision API states what moved and what is newer, from retained rows only", async () => {
    const revision = await (await fetch(`${base}/api/review-lineages/mover/revisions/2`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("readReviewRevision", revision);
    expect(revision.delta.previousRevision).toBe(1);
    expect(revision.delta.code).toEqual({ unchanged: 1, revised: 1, new: 0, removed: 0 });
    // Revision 1 carries the only account, and there is no second one to compare it with.
    expect(revision.delta.account).toBeNull();

    const delta = await (await fetch(`${base}/api/review-lineages/mover/revisions/2/delta`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("readReviewRevisionDelta", delta);
    expect(delta.previous.revision).toBe(1);
    expect(delta.code.counts).toEqual({ unchanged: 1, revised: 1, new: 0, removed: 0 });
    expect(delta.code.items).toHaveLength(2);
    expect(delta.account.prior.version).toBe(1);
    expect(delta.account.current).toBeNull();
    // Object identity is how a match is proved and is never a fact about this review.
    const serialized = JSON.stringify(delta);
    for (const secret of [A_OLD, A_NEW, B_OLD, B_NEW, B_NEW2]) expect(serialized).not.toContain(secret);

    // The lineage history says where each member's reads came from, and says nothing at
    // all to a key.
    const byKey = await (await fetch(`${base}/api/review-lineages/mover`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("readReviewLineage", byKey);
    expect(byKey.revisions.map((row: any) => row.carriedReads)).toEqual([null, null]);
    const bySession = await (await fetch(`${base}/api/review-lineages/mover`, { headers: { cookie } })).json() as any;
    validateResponse("readReviewLineage", bySession);
    expect(bySession.revisions.find((row: any) => row.revision === 2).carriedReads).toBe(1);
    expect(bySession.revisions.find((row: any) => row.revision === 1).witness).toBe("published");
  });

  test("a fresh witness claim on revision 2 is handed revision 1's exact account", async () => {
    const revision = getRevision(workspace, "mover", 2)!;
    const request = getWitnessRequestForRevision(workspace, revision.id)!;
    const claim = await (await fetch(`${base}/api/review-witness-requests/${request.id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("claimWitnessRequest", claim);
    expect(claim.priorAccount.version).toBe(1);
    expect(claim.priorAccount.revision).toBe(1);
    expect(claim.priorAccount.document.witness.summary).toBe("Two values moved.");
    const stored = db.query<{ doc: string }, [string]>("SELECT doc FROM review_accounts WHERE id = ?").get(claim.priorAccount.id)!;
    expect(JSON.parse(stored.doc)).toEqual(claim.priorAccount.document);
  });

  test("a delivery pins its own SHAs, is enriched by compare alone, and appends revision 3", async () => {
    const gate = holdOpenAt(1);
    const response = await deliver(deliveryPayload(10, HEAD3, "2026-04-03T10:00:00Z"), "mover-delivery-1");
    expect([200, 202]).toContain(response.status);

    const lineage = getLineage(workspace, "mover")!;
    const observed = latestObservation(workspace, lineage.id)!;
    expect(observed.head_sha).toBe(HEAD3);
    expect(observed.merge_base_sha).toBeNull();
    // Attributed to the delivery's installation, and queued through the relation's own.
    expect(observed.installation_id).toBe(INSTALLATION);
    const job = db.query<{ id: string; actor_kind: string; installation_id: number | null; state: string }, [string, string]>(
      "SELECT id, actor_kind, installation_id, state FROM review_capture_jobs WHERE lineage_id = ? AND observation_id = ?",
    ).get(lineage.id, observed.id)!;
    expect(job.actor_kind).toBe("installation");
    expect(job.installation_id).toBe(INSTALLATION);

    // Another push lands while the worker waits. The worker must not notice: it never asks
    // what the pull request looks like now.
    currentClient = githubFixture(pull({ head: { ref: "feature/mover", sha: HEAD_LATER, repo: { id: REPO_ID, full_name: REPO } }, updated_at: "2026-04-04T10:00:00Z" }));
    gate.release();
    await settleCaptureJobs();

    const third = getRevision(workspace, "mover", 3)!;
    expect(third.doc.source.sourceHeadSha).toBe(HEAD3);
    expect(third.doc.source.mergeBaseSha).toBe(MERGE);
    expect(getRevision(workspace, "mover", 4)).toBeNull();
    // The enrichment is a complete observation of the SAME pinned SHAs.
    const enriched = getObservation(workspace, getCaptureJob(workspace, job.id)!.observation_id)!;
    expect(enriched.head_sha).toBe(HEAD3);
    expect(enriched.merge_base_sha).toBe(MERGE);
  });

  test("appending revision 3 supersedes revision 2's open request, and every path refuses it", async () => {
    const second2 = getRevision(workspace, "mover", 2)!;
    const request = getWitnessRequestForRevision(workspace, second2.id)!;
    const supersession = getWitnessSupersession(request.id)!;
    expect(supersession.superseded_revision_id).toBe(second2.id);
    expect(supersession.successor_revision_id).toBe(getRevision(workspace, "mover", 3)!.id);
    expect(workflowWord(getWitnessRequestForRevision(workspace, second2.id))).toBe("superseded");

    const claim = await fetch(`${base}/api/review-witness-requests/${request.id}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(claim.status).toBe(409);
    expect((await claim.json() as any).error).toContain("superseded");

    const failed = await fetch(`${base}/api/review-witness-requests/${request.id}/fail`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ error: "no" }),
    });
    expect(failed.status).toBe(409);
    const retried = await fetch(`${base}/api/review-witness-requests/${request.id}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(retried.status).toBe(409);
    const account = await fetch(`${base}/api/review-lineages/mover/revisions/2/accounts`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({
        witness: { name: "Witness", model: "review-model" },
        summary: "Too late.",
        groups: [{
          id: "all", title: "All", category: "Code", importance: "low", complexity: "low",
          explanation: "Everything.", examples: [], members: partitionOf(second2.capture_id),
        }],
      }),
    });
    expect(account.status).toBe(409);

    // Revision 3 appending did not preserve a second successor over the first.
    expect(getWitnessSupersession(request.id)!.successor_revision_id).toBe(supersession.successor_revision_id);
  });

  test("the superseded revision still reads, and says superseded rather than pending forever", async () => {
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover/rev/2`, { headers: { cookie } })).text());
    expect(page).toContain("Witness superseded");
    expect(page).not.toContain("Witness pending");
    // Its evidence is still there, and its own source facts are untouched.
    expect(page).toContain(HEAD2);
    expect(page).not.toContain(HEAD3);
    // And a newer revision is one short link rather than a banner.
    expect(page).toContain("Revision 3 available");
    expect(page).toContain(`/${workspace}/r/mover/rev/3`);
    // One short underlined link below the source facts, and nothing louder than that.
    expect(page).toMatch(/<p class="stage-drift"><a href="[^"]*\/rev\/3">Revision 3 available<\/a><\/p>/);
    expect(page).not.toContain("New source");
  });

  test("revision 3 says what it changed, and revision 1 is untouched by any of it", async () => {
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover/rev/3`, { headers: { cookie } })).text());
    expect(page).toContain("Since rev 2");
    // Nothing moved between revisions 2 and 3, so the line says so in counts.
    expect(page).toContain("2 unchanged");

    const first = getRevision(workspace, "mover", 1)!;
    expect(first.doc.source.sourceHeadSha).toBe(HEAD1);
    expect(first.digest).toBe(db.query<{ digest: string }, [string]>(
      "SELECT digest FROM review_revisions WHERE id = ?",
    ).get(first.id)!.digest);
    // The account published over it is still the account published over it.
    expect(count("SELECT COUNT(*) AS n FROM review_accounts WHERE workspace_id = ? AND slug = ?", workspace, "mover")).toBe(1);
  });

  test("a read marked after the next revision exists still carries forward, once", async () => {
    // Webhooks land while people read. Revision 3 was appended while revision 2 was still
    // being read, and a member who marks a hunk on 2 now must not start 3 from nothing:
    // the completion-time carry only saw the reads that existed at that instant.
    const second2 = getRevision(workspace, "mover", 2)!;
    const third = getRevision(workspace, "mover", 3)!;
    const b2 = changeIdFor(second2, "src/b.ts");
    const b3 = changeIdFor(third, "src/b.ts");
    expect(listRevisionReadChangeIds(workspace, third.id, owner).has(b3)).toBe(false);

    expect((await markRead("mover", 2, b2, true)).status).toBe(200);
    expect(listRevisionReadChangeIds(workspace, third.id, owner).has(b3)).toBe(true);
    const provenance = listRevisionReadCarries(workspace, third.id, owner).find((row) => row.target_change_id === b3)!;
    expect(provenance.source_revision_id).toBe(second2.id);
    expect(provenance.source_change_id).toBe(b2);

    // The member unmarks it on revision 3, then marks and unmarks and marks it again on
    // revision 2. Their explicit unmark on 3 stands: a hop carries at most once.
    expect((await markRead("mover", 3, b3, false)).status).toBe(200);
    expect((await markRead("mover", 2, b2, false)).status).toBe(200);
    expect((await markRead("mover", 2, b2, true)).status).toBe(200);
    expect(listRevisionReadChangeIds(workspace, third.id, owner).has(b3)).toBe(false);
    expect(listRevisionReadCarries(workspace, third.id, owner).filter((row) => row.target_change_id === b3)).toHaveLength(1);
    expect((await markRead("mover", 2, b2, false)).status).toBe(200);
  });

  test("an explicit target unmark is not overwritten by a later source read", async () => {
    const second2 = getRevision(workspace, "mover", 2)!;
    const third = getRevision(workspace, "mover", 3)!;
    const a2 = changeIdFor(second2, "src/a.ts");
    const a3 = changeIdFor(third, "src/a.ts");

    // This member handled revision 3 directly, then deliberately reversed it. No carry
    // provenance exists because the read did not arrive from revision 2.
    setRevisionChangeRead(workspace, third.id, second, a3, true);
    setRevisionChangeRead(workspace, third.id, second, a3, false);
    expect(listRevisionReadCarries(workspace, third.id, second)).toEqual([]);

    // Reading the equivalent source later cannot revive the explicit target state.
    setRevisionChangeRead(workspace, second2.id, second, a2, true);
    expect(listRevisionReadChangeIds(workspace, second2.id, second).has(a2)).toBe(true);
    expect(listRevisionReadChangeIds(workspace, third.id, second).has(a3)).toBe(false);
    expect(listRevisionReadCarries(workspace, third.id, second)).toEqual([]);
    setRevisionChangeRead(workspace, second2.id, second, a2, false);
  });

  test("unmarking a carried read removes the active read and leaves the provenance", async () => {
    const revision = getRevision(workspace, "mover", 2)!;
    const carried = changeIdFor(revision, "src/a.ts");
    expect(listRevisionReadChangeIds(workspace, revision.id, owner).has(carried)).toBe(true);

    const removed = await markRead("mover", 2, carried, false);
    expect(removed.status).toBe(200);
    expect(listRevisionReadChangeIds(workspace, revision.id, owner).has(carried)).toBe(false);
    // The history still says why it once arrived.
    expect(countRevisionReadCarries(workspace, revision.id, owner)).toBe(1);
    expect(listRevisionReadCarries(workspace, revision.id, owner)[0]!.target_change_id).toBe(carried);
  });

  test("the source rail is chronological across revisions and accounts", async () => {
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover/rev/3`, { headers: { cookie } })).text());
    const rail = /<aside class="source-rail"><h2>Source<\/h2><p>(.*?)<\/p>/.exec(page)![1]!;
    const order = [...rail.matchAll(/>(rev \d+|v\d+)</g)].map((match) => match[1]!);
    // The account over revision 1 was published before revision 2 existed, so it belongs
    // between them rather than after everything.
    expect(order).toEqual(["rev 1", "v1", "rev 2", "rev 3"]);
    // Every link works without JavaScript.
    for (const label of order) {
      const href = label.startsWith("rev ")
        ? `/${workspace}/r/mover/rev/${label.slice(4)}`
        : `/${workspace}/r/mover/v/${label.slice(1)}`;
      expect((await fetch(`${base}${href}`, { headers: { cookie } })).status).toBe(200);
    }
  });

  test("the witness summary is read in full, and the header says each fact once", async () => {
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover/v/1`, { headers: { cookie } })).text());
    expect(page).toContain(`<div class="account-body markdown"><p>Two values moved.</p></div>`);
    expect(page).not.toContain("Full account");
    expect(page).not.toContain("<details class=\"account\"");
    // The pin is said in the header and nowhere else; the footer carries the file count,
    // pluralized; the account delta stays an API fact.
    expect(page).toContain("Version 1 · revision 1");
    expect(page.split("Version 1 · revision 1")).toHaveLength(2);
    expect(page).toContain("<p>2 files</p>");
    expect(page).not.toContain("account 1 revised");
    // An evidence seam is navigation, not a title: it names its directory and count and
    // the card says so, so the type can be sized as a label rather than a heading.
    const evidence = visible(await (await fetch(`${base}/${workspace}/r/mover/rev/3`, { headers: { cookie } })).text());
    expect(evidence).toContain("<h2>src/ · 2 files</h2>");
    expect(evidence).toContain("data-seam");
    expect(page).not.toContain("data-seam");
    const focused = visible(await (await fetch(`${base}/${workspace}/r/mover/rev/3?review=seam-1`, { headers: { cookie } })).text());
    expect(focused).toContain("Mark read");
    expect(focused).not.toContain("Mark as read");
  });

  test("every promoted page renders with a GitHub factory and router that throw", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    setReadRouter({
      async resolve(): Promise<never> { throw new Error("GitHub must not be routed while rendering"); },
      async open(): Promise<never> { throw new Error("GitHub must not be opened while rendering"); },
    });
    for (const path of [
      `/${workspace}/r/mover`,
      `/${workspace}/r/mover/rev/1`,
      `/${workspace}/r/mover/rev/2`,
      `/${workspace}/r/mover/rev/3`,
      `/${workspace}/r/mover/v/1`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    for (const path of [
      `/api/review-lineages/mover/revisions/3/delta`,
      `/api/review-lineages/mover/revisions/2`,
      `/api/review-lineages/mover`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    installRouter();
  });
});

// ---- one capture per source, however many observations there are ----

describe("explicit and unasked-for readings converge on one capture", () => {
  test("a refresh reuses the job a delivery queued, and one revision is appended", async () => {
    currentClient = githubFixture(pull({ number: 11 }));
    const created = await ingest({ repo: REPO, number: 11, slug: "mover-race" }, "mover-race-1");
    expect(created.status).toBe(202);
    await settleCaptureJobs();
    expect(getLineage(workspace, "mover-race")!.latest_revision).toBe(1);
    const lineage = getLineage(workspace, "mover-race")!;
    const capturesBefore = count("SELECT COUNT(*) AS n FROM stage_captures WHERE workspace_id = ?", workspace);

    // The delivery queues a capture; its worker is held before it can spend anything.
    const gate = holdOpenAt(openCount + 1);
    await deliver(deliveryPayload(11, HEAD2, "2026-04-05T10:00:00Z"), "mover-race-delivery");
    const queued = db.query<{ id: string }, [string]>(
      "SELECT id FROM review_capture_jobs WHERE lineage_id = ? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
    ).get(lineage.id)!;

    // The same movement, asked for explicitly. It must not queue a second capture of the
    // same base and head.
    currentClient = githubFixture(pull({ number: 11, head: { ref: "feature/mover", sha: HEAD2, repo: { id: REPO_ID, full_name: REPO } }, updated_at: "2026-04-05T10:00:00Z" }));
    const refreshed = await refresh("mover-race", "mover-race-refresh");
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as any;
    expect(body.captureJob.id).toBe(queued.id);
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ? AND state IN ('pending','running')", lineage.id)).toBe(1);

    gate.release();
    await settleCaptureJobs();
    expect(getLineage(workspace, "mover-race")!.latest_revision).toBe(2);
    expect(getRevision(workspace, "mover-race", 3)).toBeNull();
    // One capture for one source, not two.
    expect(count("SELECT COUNT(*) AS n FROM stage_captures WHERE workspace_id = ?", workspace)).toBe(capturesBefore + 1);
  });

  test("a duplicate delivery and a title-only edit add observations and no captures", async () => {
    const lineage = getLineage(workspace, "mover-race")!;
    const jobs = count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id);
    const revisions = getLineage(workspace, "mover-race")!.latest_revision;

    // The same delivery again, under a fresh delivery id: the observation is already
    // stored, and the source is already published.
    await deliver(deliveryPayload(11, HEAD2, "2026-04-05T10:00:00Z"), "mover-race-delivery-again");
    // A title edit at the same source is not code movement.
    await deliver({
      action: "edited",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: {
        number: 11, title: "Move the values, renamed", state: "open", merged: false, draft: false,
        updated_at: "2026-04-06T10:00:00Z",
        base: { ref: "main", sha: BASE, repo: { id: REPO_ID, full_name: REPO } },
        head: { ref: "feature/mover", sha: HEAD2, repo: { id: REPO_ID, full_name: REPO } },
      },
    }, "mover-race-title");
    await settleCaptureJobs();

    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id)).toBe(jobs);
    expect(getLineage(workspace, "mover-race")!.latest_revision).toBe(revisions);
    expect(latestObservation(workspace, lineage.id)!.title).toBe("Move the values, renamed");

    // And the pinned page does not claim code moved, because base and head did not.
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover-race/rev/2`, { headers: { cookie } })).text());
    expect(page).not.toContain("New source");
  });

  test("a force-push back to retained source links that revision instead of asking forever", async () => {
    const lineage = getLineage(workspace, "mover-race")!;
    currentClient = githubFixture(pull({
      number: 11,
      head: { ref: "feature/mover", sha: HEAD1, repo: { id: REPO_ID, full_name: REPO } },
      updated_at: "2026-04-08T10:00:00Z",
    }));
    const response = await refresh("mover-race", "mover-race-return");
    expect(response.status).toBe(200);
    const refreshed = await response.json() as any;
    expect(refreshed.sourceRevision).toBe(1);
    expect(refreshed.captureJob).toBeNull();
    expect(lineage.latest_revision).toBe(2);

    const view = await (await fetch(`${base}/api/review-lineages/mover-race/revisions/2`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    expect(view.drift.sourceRevision).toBe(1);
    expect(view.drift.refreshRequired).toBe(false);
    const page = visible(await (await fetch(`${base}/${workspace}/r/mover-race/rev/2`, { headers: { cookie } })).text());
    // Named by its subject, so it cannot be read as the movement line beneath it.
    expect(page).toContain("Pull request source matches rev 1");
    expect(page).not.toContain("refresh required");
  });
});

// ---- base-only movement, which GitHub does not timestamp ----

describe("a member can recover from a capture that failed, from the page", () => {
  test("the failed shell offers the retry, the capturing shell reloads, and the retry runs", async () => {
    const broken = githubFixture(pull({ number: 19 }));
    currentClient = { ...broken, async getTree() { throw new Error("tree unavailable"); } };
    const created = await ingest({ repo: REPO, number: 19, slug: "mover-recover" }, "mover-recover-1");
    expect(created.status).toBe(202);
    const job = await created.json() as any;
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, job.id)!.state).toBe("failed");

    // The failed page: the failure, the source at the completed page's width, and a plain
    // form — no JavaScript, no OpenAPI document — for the member who may spend it.
    const failed = visible(await (await fetch(`${base}/${workspace}/r/mover-recover`, { headers: { cookie } })).text());
    expect(failed).toContain("Capture failed");
    expect(failed).toContain("tree unavailable");
    expect(failed).toContain(`main → feature/mover ${HEAD1.slice(0, 12)}`);
    expect(failed).not.toContain(HEAD1.slice(0, 13));
    expect(failed).toContain("via the GitHub App installation");
    expect(failed).not.toContain("Read as");
    expect(failed).toContain(`action="/${workspace}/r/mover-recover/capture-jobs/${job.id}/retry"`);
    expect(failed).toContain("Retry capture");
    expect(failed).not.toContain("http-equiv");

    // The form from a foreign origin is refused before anything moves.
    const forged = await fetch(`${base}/${workspace}/r/mover-recover/capture-jobs/${job.id}/retry`, {
      method: "POST", headers: { cookie, origin: "https://elsewhere.example" }, redirect: "manual",
    });
    expect(forged.status).toBe(403);
    expect(getCaptureJob(workspace, job.id)!.state).toBe("failed");

    // Retried from the page, with the fixture repaired but its worker held: the shell now
    // says capturing, refreshes itself, and says how to reload.
    currentClient = githubFixture(pull({ number: 19 }));
    const gate = holdOpenAt(openCount + 1);
    const retried = await fetch(`${base}/${workspace}/r/mover-recover/capture-jobs/${job.id}/retry`, {
      method: "POST", headers: { cookie, origin: new URL(config.baseUrl).origin }, redirect: "manual",
    });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe(`/${workspace}/r/mover-recover`);
    const capturing = visible(await (await fetch(`${base}/${workspace}/r/mover-recover`, { headers: { cookie } })).text());
    expect(capturing).toContain("Capturing");
    expect(capturing).toContain(`<meta http-equiv="refresh" content="30">`);
    expect(capturing).toContain(`<a href="/${workspace}/r/mover-recover">Reload to check</a>`);
    expect(capturing).not.toContain("Retry capture");
    gate.release();
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, job.id)!.state).toBe("completed");
    expect(getLineage(workspace, "mover-recover")!.latest_revision).toBe(1);
  });

  test("the retry is one guarded statement: queued and completed jobs are left alone", async () => {
    const lineage = getLineage(workspace, "mover-recover")!;
    const completed = db.query<{ id: string }, [string]>(
      "SELECT id FROM review_capture_jobs WHERE lineage_id = ? AND state = 'completed'",
    ).get(lineage.id)!;
    const refused = await fetch(`${base}/api/review-capture-jobs/${completed.id}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(refused.status).toBe(409);
    expect(getCaptureJob(workspace, completed.id)!.state).toBe("completed");

    // A queued job with attempts behind it: retrying it would reset the count that
    // bounds a capture that kills its worker every time. Off the real lane, so nothing
    // in this process drains it.
    const observationId = tinyId("pob");
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
        "VALUES (?, ?, ?, ?, ?, 19, 'Move the values', 'open', 0, 0, 'main', ?, 'feature/mover', ?, NULL, ?, ?, 'installation', ?, NULL, NULL, ?)",
      [observationId, workspace, lineage.id, REPO_ID, REPO, BASE, HEAD2, Date.now(), Date.now(), INSTALLATION, `queued-${observationId}`],
    );
    const queued = tinyId("rcj");
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mover-recover', ?, 'pending', 'installation', ?, NULL, NULL, ?, 3, NULL, NULL, NULL, NULL, NULL, ?, ?)",
      [queued, workspace, lineage.id, observationId, INSTALLATION, `${workspace}/installation/999999`, Date.now(), Date.now()],
    );
    const pending = await fetch(`${base}/api/review-capture-jobs/${queued}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(pending.status).toBe(409);
    expect((await pending.json() as any).error).toBe("This capture is queued.");
    expect(getCaptureJob(workspace, queued)!.attempts).toBe(3);
    expect(getCaptureJob(workspace, queued)!.state).toBe("pending");
    db.run("DELETE FROM review_capture_jobs WHERE id = ?", [queued]);
    db.run("DELETE FROM review_pr_observations WHERE id = ?", [observationId]);
  });
});

describe("a base that moved is a different source", () => {
  test("an unchanged GitHub timestamp still appends, ordered by arrival", async () => {
    currentClient = githubFixture(pull({ number: 12 }));
    const created = await ingest({ repo: REPO, number: 12, slug: "mover-base" }, "mover-base-1");
    expect(created.status).toBe(202);
    await settleCaptureJobs();
    const first = getRevision(workspace, "mover-base", 1)!;

    // Same head, same GitHub timestamp, different base tip. Nothing in GitHub's own facts
    // separates these two readings; Seer's arrival order does.
    currentClient = githubFixture(pull({
      number: 12,
      base: { ref: "main", sha: BASE2, repo: { id: REPO_ID, full_name: REPO } },
    }));
    const response = await refresh("mover-base", "mover-base-refresh");
    expect(response.status).toBe(200);
    expect((await response.json() as any).behind).toBe(true);
    await settleCaptureJobs();

    const second2 = getRevision(workspace, "mover-base", 2)!;
    expect(second2.doc.source.baseTipSha).toBe(BASE2);
    expect(second2.doc.source.sourceHeadSha).toBe(first.doc.source.sourceHeadSha);
    const observations = db.query<{ github_updated_at: number }, [string]>(
      "SELECT github_updated_at FROM review_pr_observations WHERE lineage_id = ?",
    ).all(getLineage(workspace, "mover-base")!.id);
    expect(new Set(observations.map((row) => row.github_updated_at)).size).toBe(1);
    // Both hunks are byte-identical across the two captures, so both carry.
    expect(revisionCodeDelta(inventoryOf(first), inventoryOf(second2)).counts)
      .toEqual({ unchanged: 2, revised: 0, new: 0, removed: 0 });
  });
});

// ---- a personal credential is not the workspace's to spend ----

describe("an unasked-for delivery never spends a member's credential", () => {
  test("a PAT-owned relation records the drift and queues nothing", async () => {
    resolvedActor = { kind: "user", userId: second, credentialId: "guc_movercred" };
    currentClient = githubFixture(pull({ number: 13 }));
    const created = await ingest({ repo: REPO, number: 13, slug: "mover-pat" }, "mover-pat-1", secondKey);
    expect(created.status).toBe(202);
    await settleCaptureJobs();
    const lineage = getLineage(workspace, "mover-pat")!;
    expect(getRevision(workspace, "mover-pat", 1)).not.toBeNull();

    const jobs = count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id);
    opened = [];
    await deliver(deliveryPayload(13, HEAD2, "2026-04-07T10:00:00Z"), "mover-pat-delivery");
    await settleCaptureJobs();

    // The observation is stored; the credential is not spent and no capture is queued.
    expect(latestObservation(workspace, lineage.id)!.head_sha).toBe(HEAD2);
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id)).toBe(jobs);
    expect(opened).toEqual([]);
    expect(getRevision(workspace, "mover-pat", 2)).toBeNull();
  });

  test("a teammate is offered no refresh they cannot take", async () => {
    // AUTH_DISABLED makes both cookies the root user in this process. The owning-member
    // wording is exercised in the spawned auth-enabled privacy script below.
    const theirs = visible(await (await fetch(`${base}/${workspace}/r/mover-pat/rev/1`, { headers: { cookie } })).text());
    expect(theirs).toContain("New source");
    expect(theirs).not.toContain("refresh required");

    // An older completed job may point at a revision that overtook it. That pointer is
    // not proof the job's source pair was published, and must not hide the PAT refresh.
    const lineage = getLineage(workspace, "mover-pat")!;
    const observation = latestObservation(workspace, lineage.id)!;
    const first = getRevision(workspace, "mover-pat", 1)!;
    const overtakenJob = tinyId("rcj");
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mover-pat', ?, 'completed', 'user', NULL, ?, 'guc_movercred', ?, 1, NULL, NULL, NULL, ?, ?, ?, ?)",
      [overtakenJob, workspace, lineage.id, observation.id, second,
        `${workspace}/user/${second}/guc_movercred`, first.capture_id, first.id, Date.now(), Date.now()],
    );

    // The API states the fact and leaves who may act on it to the surface that has a
    // reader. A status-only difference never claims code moved.
    const view = await (await fetch(`${base}/api/review-lineages/mover-pat/revisions/1`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    validateResponse("readReviewRevision", view);
    expect(view.drift.moved).toBe(true);
    expect(view.drift.capture).toBeNull();
    expect(view.drift.sourceRevision).toBeNull();
    expect(view.drift.refreshRequired).toBe(true);
    expect(view.drift.newerRevision).toBeNull();
    db.run("DELETE FROM review_capture_jobs WHERE id = ?", [overtakenJob]);
  });
});

// ---- a result that arrives behind newer source ----

describe("an out-of-order capture completes without appending behind newer source", () => {
  test("a stale job points at the revision that overtook it and carries nothing", () => {
    const lineage = getLineage(workspace, "mover")!;
    const latest = getRevision(workspace, "mover", 3)!;
    const stale = getRevision(workspace, "mover", 1)!;
    const capturedObservation = db.query<{ observation_id: string }, [string]>(
      "SELECT observation_id FROM review_revision_sources WHERE revision_id = ?",
    ).get(stale.id)!.observation_id;
    const original = getObservation(workspace, capturedObservation)!;
    const staleObservation = tinyId("pob");
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'Older duplicate reading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [staleObservation, workspace, lineage.id, original.repo_id, original.repo, original.pr_number,
        original.state, original.merged, original.draft, original.base_ref, original.base_sha,
        original.head_ref, original.head_sha, original.merge_base_sha, original.github_updated_at,
        original.observed_at, original.actor_kind, original.installation_id, original.user_id,
        original.credential_id, `duplicate-${staleObservation}`],
    );

    // A second job over revision 1's source, claimed and running: the shape a
    // retried or duplicated sibling has when it finishes after the lineage moved on. The
    // source tuple it names is already published, so it converges rather than appending —
    // and a job whose OLDER complete tuple points at a newer revision reads as superseded.
    const jobId = tinyId("rcj");
    const lease = tinyId("lse");
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mover', ?, 'running', 'installation', ?, NULL, NULL, ?, 1, NULL, ?, ?, NULL, NULL, ?, ?)",
      [jobId, workspace, lineage.id, staleObservation, INSTALLATION, `${workspace}/installation/${INSTALLATION}`,
        lease, Date.now() + 60_000, Date.now(), Date.now()],
    );
    const carriesBefore = countRevisionReadCarries(workspace, latest.id, owner);
    const result = completeCaptureJob({ jobId, leaseToken: lease, captureId: latest.capture_id });
    expect(result.appended).toBe(false);
    expect(result.carried).toBe(0);
    expect(getLineage(workspace, "mover")!.latest_revision).toBe(3);
    expect(countRevisionReadCarries(workspace, latest.id, owner)).toBe(carriesBefore);

    // Converging on the revision published from the same tuple is not supersession.
    const converged = getCaptureJob(workspace, jobId)!;
    expect(converged.state).toBe("completed");
    expect(converged.revision_id).toBe(stale.id);
    expect((captureJobView(converged, getObservation(workspace, staleObservation)) as any).superseded).toBe(false);

    // A job whose complete observation names an older source than the revision it landed
    // on is superseded, and the view derives that from the stored tuples.
    db.run("UPDATE review_capture_jobs SET revision_id = ? WHERE id = ?", [latest.id, jobId]);
    const overtaken = getCaptureJob(workspace, jobId)!;
    expect((captureJobView(overtaken, getObservation(workspace, staleObservation)) as any).superseded).toBe(true);
    db.run("DELETE FROM review_capture_jobs WHERE id = ?", [jobId]);
    db.run("DELETE FROM review_pr_observations WHERE id = ?", [staleObservation]);
  });

  test("retrying an overtaken failed job converges without a GitHub read", async () => {
    // Revision 1; a push whose capture failed during an outage; a later push published
    // revision 3. The failed job is still listed with its retry URL. Retrying it must not
    // spend a capture to be told it was superseded: the order is known before the first
    // GitHub request is made.
    const lineage = getLineage(workspace, "mover")!;
    const latest = getRevision(workspace, "mover", 3)!;
    const observationId = tinyId("pob");
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
        "VALUES (?, ?, ?, ?, ?, 10, 'Move the values', 'open', 0, 0, 'main', ?, 'feature/mover', ?, NULL, ?, ?, 'installation', ?, NULL, NULL, ?)",
      [observationId, workspace, lineage.id, REPO_ID, REPO, BASE, HEAD_LATER,
        Date.parse("2026-04-01T09:30:00Z"), Date.parse("2026-04-01T09:30:00Z"), INSTALLATION, `outage-${observationId}`],
    );
    const jobId = tinyId("rcj");
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mover', ?, 'failed', 'installation', ?, NULL, NULL, ?, 1, 'GitHub was unavailable.', NULL, NULL, NULL, NULL, ?, ?)",
      [jobId, workspace, lineage.id, observationId, INSTALLATION, `${workspace}/installation/${INSTALLATION}`, Date.now(), Date.now()],
    );
    const capturesBefore = count("SELECT COUNT(*) AS n FROM stage_captures WHERE workspace_id = ?", workspace);
    opened = [];

    const retried = await fetch(`${base}/api/review-capture-jobs/${jobId}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(retried.status).toBe(202);
    await settleCaptureJobs();

    const finished = getCaptureJob(workspace, jobId)!;
    expect(finished.state).toBe("completed");
    expect(finished.revision_id).toBe(latest.id);
    expect((captureJobView(finished, getObservation(workspace, observationId)) as any).superseded).toBe(true);
    // No session was opened, no capture was retained, nothing was appended.
    expect(opened).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM stage_captures WHERE workspace_id = ?", workspace)).toBe(capturesBefore);
    expect(getLineage(workspace, "mover")!.latest_revision).toBe(3);
    db.run("DELETE FROM review_capture_jobs WHERE id = ?", [jobId]);
    db.run("DELETE FROM review_pr_observations WHERE id = ?", [observationId]);
  });

  test("an unpublished older source completes as superseded and appends nothing", () => {
    const lineage = getLineage(workspace, "mover")!;
    const latest = getRevision(workspace, "mover", 3)!;
    // A complete reading of source nobody captured, carrying a GitHub timestamp older than
    // the one the newest revision was published from. Its capture really did finish; what
    // it must not do is land behind the revision that overtook it.
    const observationId = tinyId("pob");
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
        "VALUES (?, ?, ?, ?, ?, 10, 'Move the values', 'open', 0, 0, 'main', ?, 'feature/mover', ?, ?, ?, ?, 'installation', ?, NULL, NULL, ?)",
      [observationId, workspace, lineage.id, REPO_ID, REPO, BASE, HEAD_LATER, MERGE,
        Date.parse("2026-04-01T09:00:00Z"), Date.parse("2026-04-01T09:00:00Z"), INSTALLATION, `stale-${observationId}`],
    );
    const jobId = tinyId("rcj");
    const lease = tinyId("lse");
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mover', ?, 'running', 'installation', ?, NULL, NULL, ?, 1, NULL, ?, ?, NULL, NULL, ?, ?)",
      [jobId, workspace, lineage.id, observationId, INSTALLATION, `${workspace}/installation/${INSTALLATION}`,
        lease, Date.now() + 60_000, Date.now(), Date.now()],
    );

    const result = completeCaptureJob({ jobId, leaseToken: lease, captureId: latest.capture_id });
    expect(result.superseded).toBe(true);
    expect(result.appended).toBe(false);
    expect(result.carried).toBe(0);
    expect(result.revision).toBe(3);
    expect(getRevision(workspace, "mover", 4)).toBeNull();
    // It points at the newer revision, and the view says why it is not that revision's own.
    const finished = getCaptureJob(workspace, jobId)!;
    expect(finished.state).toBe("completed");
    expect(finished.revision_id).toBe(latest.id);
    expect((captureJobView(finished, getObservation(workspace, observationId)) as any).superseded).toBe(true);

    db.run("DELETE FROM review_capture_jobs WHERE id = ?", [jobId]);
    db.run("DELETE FROM review_pr_observations WHERE id = ?", [observationId]);
  });
});

// ---- who may read what moved ----

describe("a promoted review is reachable from the Reviews page", () => {
  test("pending, failed and completed lineages list beside legacy reviews, with the Project's words", async () => {
    // A shell whose capture never returned, and one whose capture failed, beside the
    // lineages the suite published. All of them exist from the moment somebody promoted
    // them, and this page is the only way back to one without its URL.
    const pendingId = tinyId("rln");
    const failedId = tinyId("rln");
    for (const [id, slug, title] of [[pendingId, "mover-waiting", "Still capturing"], [failedId, "mover-broken", "Never captured"]] as const) {
      db.run(
        "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, 'feature/mover', 'main', ?, ?, NULL, NULL, ?, 'key_ledger', ?, ?)",
        [id, workspace, slug, REPO, REPO_ID, MERGE, title, owner, Date.now(), Date.now()],
      );
      db.run(
        "INSERT INTO review_lineage_prs (lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, actor_kind, installation_id, user_id, credential_id, attached_at, detached_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'feature/mover', 'main', 'installation', ?, NULL, NULL, ?, NULL)",
        [id, workspace, slug, REPO_ID, REPO, slug === "mover-waiting" ? 901 : 902, INSTALLATION, Date.now()],
      );
      const observationId = tinyId("pob");
      db.run(
        "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, 0, 'main', ?, 'feature/mover', ?, ?, ?, ?, 'installation', ?, NULL, NULL, ?)",
        [observationId, workspace, id, REPO_ID, REPO, slug === "mover-waiting" ? 901 : 902, title, BASE, HEAD1, MERGE, Date.now(), Date.now(), INSTALLATION, `ledger-${observationId}`],
      );
      db.run(
        "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'installation', ?, NULL, NULL, ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?)",
        [tinyId("rcj"), workspace, id, slug, observationId, slug === "mover-waiting" ? "pending" : "failed", INSTALLATION,
          `${workspace}/installation/999998`, slug === "mover-waiting" ? null : "GitHub was unavailable.", Date.now(), Date.now()],
      );
    }

    const page = await (await fetch(`${base}/${workspace}/reviews`, { headers: { cookie } })).text();
    expect(page).not.toContain("No reviews here yet.");
    const row = (slug: string): string => {
      const start = page.indexOf(`/${workspace}/r/${slug}/`);
      expect(start).toBeGreaterThan(-1);
      return page.slice(start, page.indexOf("</tr>", start)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    };
    // The same words the Project page uses for the same review.
    expect(row("mover")).toContain("Move the values");
    expect(row("mover")).toContain(" v1 ");
    expect(row("mover")).toContain("Mover#10");
    expect(row("mover")).toContain("1 open");
    expect(row("mover-race")).toContain(" rev 2 ");
    expect(row("mover-waiting")).toContain("Still capturing");
    expect(row("mover-waiting")).toContain("capture pending");
    expect(row("mover-broken")).toContain("capture failed");
    expect(row("mover-broken")).toContain("Mover#902");
    // And the page linked from the row is the review's own.
    const opened2 = await fetch(`${base}/${workspace}/r/mover-broken/`, { headers: { cookie } });
    expect(opened2.status).toBe(200);
    expect(await opened2.text()).toContain("Capture failed");

    db.run("DELETE FROM review_capture_jobs WHERE lineage_id IN (?, ?)", [pendingId, failedId]);
    db.run("DELETE FROM review_pr_observations WHERE lineage_id IN (?, ?)", [pendingId, failedId]);
    db.run("DELETE FROM review_lineage_prs WHERE lineage_id IN (?, ?)", [pendingId, failedId]);
    db.run("DELETE FROM review_lineages WHERE id IN (?, ?)", [pendingId, failedId]);
  });
});

describe("what moved is as private as the code it describes", () => {
  test("delta, drift and carried counts answer members, keys and strangers correctly", async () => {
    // Nothing is left queued for the child's startup recovery to pick up and run against a
    // router that refuses everything.
    db.run(
      "UPDATE review_capture_jobs SET state = 'failed', failure = 'released before the privacy child started', lease_token = NULL, lease_expires_at = NULL WHERE workspace_id = ? AND state IN ('pending','running')",
      [workspace],
    );
    const stranger = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [stranger, "mover-stranger@example.com", Date.now()]);
    const elsewhere = createWorkspace("Elsewhere", owner);
    const otherKey = mintApiKey(owner, elsewhere, "mover-elsewhere").token;

    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "pr-movement-privacy.script.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AUTH_DISABLED: undefined as unknown as string,
        DATA_DIR: config.dataDir,
        MOVE_WORKSPACE: workspace,
        MOVE_SLUG: "mover",
        MOVE_REVISION: "2",
        MOVE_OWNER: owner,
        MOVE_MEMBER: second,
        MOVE_STRANGER: stranger,
        MOVE_KEY: key,
        MOVE_OTHER_KEY: otherKey,
        MOVE_PAT_SLUG: "mover-pat",
      },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error(error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  }, 20_000);
});

// ---- what the completion transaction costs ----

describe("the completion transaction is measured rather than assumed", () => {
  test("one thousand changes and one thousand member reads carry inside one transaction", () => {
    const captureOf = (id: string, shift: number): void => {
      db.run(
        "INSERT INTO stage_captures (id, workspace_id, slug, repo, repo_id, branch, base_ref, source_head_sha, base_tip_sha, merge_base_sha, patch_sha256, state, created_at) " +
          "VALUES (?, ?, 'scale', ?, ?, 'feature', 'main', ?, ?, ?, NULL, 'completed', ?)",
        [id, workspace, REPO, REPO_ID, HEAD1, BASE, MERGE, Date.now()],
      );
      const insertFile = db.prepare(
        "INSERT INTO stage_capture_files (id, workspace_id, capture_id, path, old_path, status, old_object_id, new_object_id, old_mode, new_mode, old_kind, new_kind, additions, deletions, old_availability, new_availability, old_blob_sha, new_blob_sha, old_reason, new_reason) " +
          "VALUES (?, ?, ?, ?, NULL, 'modified', NULL, NULL, NULL, NULL, NULL, NULL, 1, 1, 'retained', 'retained', NULL, NULL, NULL, NULL)",
      );
      const insertChange = db.prepare(
        "INSERT INTO stage_capture_changes (id, workspace_id, capture_id, file_id, old_start, old_lines, new_start, new_lines, old_fingerprint, new_fingerprint, context_fingerprint, source) " +
          "VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, 'patch')",
      );
      db.transaction(() => {
        for (let index = 0; index < 1000; index++) {
          const fileId = `stf_${id.slice(-3)}${String(index).padStart(5, "0")}`;
          insertFile.run(fileId, workspace, id, `src/scale/${index}.ts`);
          insertChange.run(
            `chg_${id}${String(index).padStart(6, "0")}`.padEnd(68, "0"), workspace, id, fileId,
            index + shift, index + shift,
            `old-${index}`, `new-${index}`, `ctx-${index}`,
          );
        }
      })();
    };
    const before = "stg_scaleold0";
    const after = "stg_scalenew0";
    captureOf(before, 0);
    captureOf(after, 4000);

    const beforeInventory = getStageCapture(before, workspace)!;
    const afterInventory = getStageCapture(after, workspace)!;
    const sourceRevision = "rvr_scaleold0";
    const targetRevision = "rvr_scalenew0";
    const insertRead = db.prepare(
      "INSERT INTO review_revision_change_reads (workspace_id, revision_id, user_id, change_id, read_at) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (const change of beforeInventory.changes) insertRead.run(workspace, sourceRevision, owner, change.id, Date.now());
    })();

    const started = performance.now();
    const carried = db.transaction(() => carryRevisionReads({
      workspaceId: workspace,
      lineageId: "rln_scale00000",
      sourceRevisionId: sourceRevision,
      targetRevisionId: targetRevision,
      equivalences: revisionCodeDelta(beforeInventory, afterInventory).equivalences,
      now: Date.now(),
    }))();
    const elapsed = performance.now() - started;
    console.log(`[measure] delta and carry over 1,000 changes with 1,000 member reads: ${elapsed.toFixed(1)}ms`);

    // Line positions moved by 4,000 on every change and every read still carried.
    expect(carried).toBe(1000);
    expect(countRevisionReadCarries(workspace, targetRevision, owner)).toBe(1000);
    expect(listRevisionReadChangeIds(workspace, targetRevision, owner).size).toBe(1000);
    // A budget rather than a benchmark: this runs inside the transaction that publishes a
    // revision, so it has to be milliseconds rather than seconds.
    expect(elapsed).toBeLessThan(5_000);

    db.run("DELETE FROM review_revision_change_reads WHERE revision_id IN (?, ?)", [sourceRevision, targetRevision]);
    db.run("DELETE FROM review_revision_read_carries WHERE target_revision_id = ?", [targetRevision]);
    for (const id of [before, after]) {
      db.run("DELETE FROM stage_capture_changes WHERE capture_id = ?", [id]);
      db.run("DELETE FROM stage_capture_files WHERE capture_id = ?", [id]);
      db.run("DELETE FROM stage_captures WHERE id = ?", [id]);
    }
  });
});
