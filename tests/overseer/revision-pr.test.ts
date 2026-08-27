// One pull request joins one review lineage.
//
// The two orders are deliberately tested side by side, because the whole slice is the
// claim that they meet at the same boundary: a review made from a pull request and a
// branch-first review that a pull request is later attached to must end up with one
// stored relationship, one immutable observation, and — when the bytes are the same —
// one source revision rather than two.
//
// Everything GitHub-shaped goes through the read router seam, so nothing here opens a
// socket, and the router records exactly which actor was opened. That recording is the
// point of several of these tests: "the worker never reroutes" is only a claim until
// somebody checks which credential the second call asked for.

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
import {
  GithubCredentialDeadError,
  GithubRoutingError,
  setGithubClientFactory,
  setReadRouter,
  type ReadActor,
} from "../../src/overseer/github-app";
import { GithubError } from "../../src/overseer/github";
import type { GithubClient, GithubPull, GithubTreeEntry } from "../../src/overseer/github";
import { offlineGithubClientFactory, offlineReadRouter } from "../offline-github";
import {
  CAPTURE_LEASE_MS,
  MAX_CAPTURE_ATTEMPTS,
  claimNextCaptureJob,
  getCaptureJob,
  scheduleActorQueue,
  settleCaptureJobs,
  startCaptureSweep,
  stopCaptureSweep,
} from "../../src/overseer/revision-jobs";
import {
  getLineagePr,
  latestObservation,
  observationForRevision,
  recordWebhookObservation,
} from "../../src/overseer/revision-pr";
import { getLineage, getRevision, getWitnessRequestForRevision } from "../../src/overseer/revision-db";
import { STAGE_CSS } from "../../src/stage/render-css";
import { sweepOrphanPrStatus } from "../../src/overseer/installations";
import { WEBHOOK_PATH, webhookSignature } from "../../src/overseer/webhook";

// ---- the repository this suite reviews ----

const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE_TIP = sha(1), HEAD = sha(2), MERGE = sha(3);
const HEAD2 = sha(4), MERGE2 = sha(5);
const OLD = sha(10), NEW = sha(11), NEWER = sha(12), DOC = sha(13);
/** A head nothing captures. It exists so one webhook payload can be made to fail its
 *  observation write without touching any other delivery. */
const FAULT = sha(6);

const blobs = new Map<string, Uint8Array>([
  [OLD, new TextEncoder().encode("export const value = 1;\n")],
  [NEW, new TextEncoder().encode("export const value = 2;\n")],
  [NEWER, new TextEncoder().encode("export const value = 3;\n")],
  [DOC, new TextEncoder().encode("# Reader\n\nPinned source.\n")],
]);

const REPO = "Acme/Reader";
const REPO_ID = 440;

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
    number: 41,
    title: "Make the value two",
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-03-01T10:00:00Z",
    base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: REPO } },
    head: { ref: "feature/reader", sha: HEAD, repo: { id: REPO_ID, full_name: REPO } },
    ...overrides,
  };
}

function movedHead(number: number): PullShape {
  return pull({ number, head: { ref: "feature/reader", sha: HEAD2, repo: { id: REPO_ID, full_name: REPO } } });
}

function entry(path: string, object: string): GithubTreeEntry {
  return { path, mode: "100644", type: "blob", sha: object, size: blobs.get(object)!.byteLength };
}

/** Trees for each commit this suite pins. Everything else in the fixture is derived. */
const TREES: Record<string, GithubTreeEntry[]> = {
  [MERGE]: [entry("src/value.ts", OLD)],
  [MERGE2]: [entry("src/value.ts", OLD)],
  [HEAD]: [entry("src/value.ts", NEW), entry("docs/readme.md", DOC)],
  [HEAD2]: [entry("src/value.ts", NEWER), entry("docs/readme.md", DOC)],
};

/** What the compare between one pinned pair says. Keyed by head, because that is what
 *  moves in this suite. */
function comparison(head: string) {
  const value = head === HEAD2 ? "3" : "2";
  return {
    merge_base_commit: { sha: head === HEAD2 ? MERGE2 : MERGE },
    files: [
      { filename: "src/value.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
        patch: `@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = ${value};\n` },
      { filename: "docs/readme.md", status: "added", additions: 3, deletions: 0, changes: 3,
        patch: "@@ -0,0 +1,3 @@\n+# Reader\n+\n+Pinned source.\n" },
    ],
  };
}

function diffFor(head: string): string {
  const value = head === HEAD2 ? "3" : "2";
  return [
    "diff --git a/src/value.ts b/src/value.ts", "--- a/src/value.ts", "+++ b/src/value.ts",
    "@@ -1,1 +1,1 @@", "-export const value = 1;", `+export const value = ${value};`, "",
    "diff --git a/docs/readme.md b/docs/readme.md", "new file mode 100644", "--- /dev/null",
    "+++ b/docs/readme.md", "@@ -0,0 +1,3 @@", "+# Reader", "+", "+Pinned source.", "",
  ].join("\n");
}

interface FixtureOptions {
  /** The raw payload `getPull` answers with, deliberately loose: what is under test is
   *  that the parser refuses a payload rather than that the fixture is well formed. */
  pullPayload?: unknown;
  /** The repository lookup may carry a newer canonical name than the observation. */
  repository?: { id: number; full_name: string };
  /** Thrown from every call, for the refusal cases. */
  refuse?: () => Error;
}

function githubFixture(options: FixtureOptions = {}): GithubClient {
  const check = (): void => { if (options.refuse) throw options.refuse(); };
  return {
    async getPull() {
      check();
      return (options.pullPayload ?? pull()) as unknown as GithubPull;
    },
    async listCommits() { return []; },
    async listFiles() { return []; },
    async listReviewComments() { return []; },
    async getFileAtSha() { throw new Error("unused"); },
    async getPullDiff() { return ""; },
    async getRepository() {
      check();
      return { id: options.repository?.id ?? REPO_ID, full_name: options.repository?.full_name ?? REPO, default_branch: "main" };
    },
    async getRef(_repo, ref) {
      check();
      return { ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE_TIP : HEAD, type: "commit" as const };
    },
    async getTree(_repo, commit) {
      check();
      return { sha: commit, truncated: false, tree: TREES[commit] ?? [] };
    },
    async getBlobBytes(_repo, object) {
      check();
      return blobs.get(object)!;
    },
    async compare(_repo, _base, head) {
      check();
      return comparison(head);
    },
    async compareDiff(_repo, _base, head) {
      check();
      return diffFor(head);
    },
  };
}

// ---- the read router seam ----

/** Every actor the router was asked to open, in order. What proves a worker reopened the
 *  exact stored actor and never quietly routed to a different one. */
let opened: ReadActor[] = [];
let resolvedActor: ReadActor = { kind: "installation", installationId: 4242 };
let currentClient: GithubClient = githubFixture();
/** Actors the router refuses to open, with the refusal to throw. */
let deadActors = new Map<string, () => Error>();

/** A promise the test resolves when it chooses. */
function deferred(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

/**
 * Hold the Nth open until the test lets it go.
 *
 * The lane starts inside the request handler and, with an in-process fixture, the whole
 * capture finishes during the test's `await response.json()`. Everything about a review
 * that has not captured yet — the retained-only shell, a second job waiting on the same
 * actor, a credential that dies BETWEEN the observation and the capture — lives in a
 * window that therefore does not exist. Counting opens is what separates the two reads: a
 * request observes through the same actor its worker later reopens, so nothing about the
 * actor itself can tell them apart, but the ordinal can. Direct ingestion and attachment
 * both open once for the observation and once for the capture, so the worker is open 2.
 */
let holdOpen: { ordinal: number; wait: Promise<void>; release: () => void } | null = null;
let openCount = 0;

/** Hold the Nth open and hand back its release. `afterEach` releases whatever is still
 *  held, so a failing assertion is a failing assertion rather than a hung suite. */
function holdOpenAt(ordinal: number): { release: () => void } {
  const gate = deferred();
  holdOpen = { ordinal, wait: gate.wait, release: gate.release };
  return { release: gate.release };
}

function actorKey(actor: ReadActor): string {
  if (actor.kind === "installation") return `installation:${actor.installationId}`;
  if (actor.kind === "user") return `user:${actor.userId}:${actor.credentialId}`;
  return "anonymous";
}

function installRouter(): void {
  setReadRouter({
    async resolve() {
      return resolvedActor;
    },
    async open(_workspaceId, actor) {
      opened.push(actor);
      // Read before the wait: a test that swaps the fixture while the gate is held is
      // changing what the NEXT reader gets, not what this one asked for.
      const client = currentClient;
      openCount += 1;
      if (holdOpen && openCount === holdOpen.ordinal) await holdOpen.wait;
      // After the wait, so a credential revoked while the worker was held still refuses.
      const refusal = deadActors.get(actorKey(actor));
      if (refusal) throw refusal();
      return client;
    },
  });
}

// ---- fixtures ----

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let secondUser = "";
let key = "";
let secondKey = "";
let cookie = "";

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

/** The page with its inlined stylesheet and client script removed: both carry every class
 *  name the reader can draw, so a negative assertion against raw HTML asserts the CSS. */
function visible(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
}

/** One complete partition of a capture, read straight out of the inventory rows: every
 *  canonical change, every incomplete material, and every otherwise-silent file. */
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

function accountBody(captureId: string, summary = "The value became two."): unknown {
  return {
    witness: { name: "Witness", model: "review-model" },
    summary,
    groups: [{
      id: "all", title: "All", category: "Code", importance: "low", complexity: "low",
      explanation: "Everything.", examples: [], members: partitionOf(captureId),
    }],
  };
}

async function ingest(body: unknown, idempotency: string, token = key): Promise<Response> {
  return fetch(`${base}/api/pull-request-review-lineages`, {
    method: "POST", headers: jsonHeaders(token, idempotency), body: JSON.stringify(body),
  });
}

async function attach(slug: string, body: unknown, idempotency: string, token = key): Promise<Response> {
  return fetch(`${base}/api/review-lineages/${slug}/pull-request`, {
    method: "POST", headers: jsonHeaders(token, idempotency), body: JSON.stringify(body),
  });
}

/** A branch-first capture through the ordinary Stage route, so the branch-first half of
 *  this slice starts exactly where task 4 left it. */
async function createBranchCapture(slug: string, idempotency: string): Promise<{ id: string }> {
  setGithubClientFactory(() => githubFixture());
  const response = await fetch(`${base}/api/stage-captures`, {
    method: "POST", headers: jsonHeaders(key, idempotency),
    body: JSON.stringify({
      slug, repo: REPO, branch: "feature/reader",
      builder: { intent: "Capture the branch.", context: "", agent: { name: "Builder", model: "build-model" } },
    }),
  });
  if (response.status !== 200) throw new Error(await response.text());
  return response.json() as Promise<{ id: string }>;
}

function captureIdOf(slug: string, revision: number): string {
  return db.query<{ capture_id: string }, [string, string, number]>(
    "SELECT capture_id FROM review_revisions WHERE workspace_id = ? AND slug = ? AND revision = ?",
  ).get(workspace, slug, revision)!.capture_id;
}

function count(sql: string, ...params: (string | number)[]): number {
  return db.query<{ n: number }, (string | number)[]>(sql).get(...params)!.n;
}

beforeAll(async () => {
  server = await startServer();
  // The server starts the periodic lease sweep. This file seeds synthetic lane rows whose
  // observations deliberately do not exist, and a sweep firing between two of its
  // assertions would run them; the one test that needs the sweep starts its own.
  stopCaptureSweep();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Pull request lineage", owner);
  key = mintApiKey(owner, workspace, "pr-lineage").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  secondUser = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, ?, ?)", [secondUser, "second-pr@example.com", Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, secondUser, Date.now()]);
  secondKey = mintApiKey(secondUser, workspace, "pr-lineage-second").token;
  installRouter();
});

afterEach(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  currentClient = githubFixture();
  resolvedActor = { kind: "installation", installationId: 4242 };
  deadActors = new Map();
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

// ---- direct ingestion ----

describe("a pull request becomes a review", () => {
  test("no revision exists before the capture completes, and the shell says so", async () => {
    // The worker is held at its own open, which is the only window in which a review that
    // has not captured yet exists to look at.
    const gate = holdOpenAt(2);
    const response = await ingest({ repo: REPO, number: 41, slug: "pr-direct" }, "pr-direct-1");
    expect(response.status).toBe(202);
    const job = await response.json() as any;
    validateResponse("createPullRequestReviewLineage", job, "202");
    expect(job.state).toBe("pending");
    expect(job.revision).toBeNull();
    expect(job.pullRequest.number).toBe(41);
    expect(job.pullRequest.actor).toBe("installation");
    // A credential is settings' business, never a review's.
    expect(JSON.stringify(job)).not.toContain("credential");

    const lineage = getLineage(workspace, "pr-direct")!;
    expect(lineage.latest_revision).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE lineage_id = ?", lineage.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM review_witness_requests WHERE lineage_id = ?", lineage.id)).toBe(0);

    // The retained-only shell, at the latest URL. It is not a reader document: no group
    // list, no source rail, no read state, and no pinned revision URL to link to yet.
    const shell = visible(await (await fetch(`${base}/${workspace}/r/pr-direct`, { headers: { cookie } })).text());
    expect(shell).toContain("Make the value two");
    expect(shell).toContain("#41");
    expect(shell).toContain("https://github.com/Acme/Reader/pull/41");
    // The claim is held, so the true word is the running one. The queued word is proved
    // beside it, on a review whose job is genuinely waiting for this actor.
    expect(shell).toContain("Capturing");
    expect(shell).toContain("the GitHub App installation");
    expect(shell).not.toContain("/r/pr-direct/rev/");
    expect(shell).not.toContain("Witness pending");
    // A pinned URL names a document, and there is none.
    expect((await fetch(`${base}/${workspace}/r/pr-direct/rev/1`, { headers: { cookie } })).status).toBe(404);

    gate.release();
    await settleCaptureJobs();

    const completed = getCaptureJob(workspace, job.id)!;
    expect(completed.state).toBe("completed");
    expect(completed.revision_id).not.toBeNull();
    const revision = getRevision(workspace, "pr-direct", 1)!;
    expect(revision.doc.source.sourceHeadSha).toBe(HEAD);
    expect(revision.doc.source.baseTipSha).toBe(BASE_TIP);
    expect(revision.doc.source.mergeBaseSha).toBe(MERGE);
    // A pull request nobody's builder initiated has no intent to state.
    expect(revision.doc.builder).toBeNull();
    expect(revision.schema_version).toBe(1);
    const request = getWitnessRequestForRevision(workspace, revision.id)!;
    expect(request.state).toBe("pending");
    expect(request.retry_count).toBe(0);

    // One immutable association, pointing at the observation the capture was pinned to.
    expect(count("SELECT COUNT(*) AS n FROM review_revision_sources WHERE lineage_id = ?", revision.lineage_id)).toBe(1);
    expect(observationForRevision(workspace, revision.id)!.head_sha).toBe(HEAD);

    // The worker reopened the exact stored actor and nothing else.
    expect(opened.every((actor) => actor.kind === "installation" && actor.installationId === 4242)).toBe(true);
  });

  test("a shell stays pinned to its capture when a newer webhook observation arrives", async () => {
    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: pull({ number: 59 }) });
    const response = await ingest({ repo: REPO, number: 59, slug: "pr-shell-pinned" }, "pr-shell-pinned-1");
    expect(response.status).toBe(202);
    const lineage = getLineage(workspace, "pr-shell-pinned")!;

    const moved = "abcdef1234567890abcdef1234567890abcdef12";
    recordWebhookObservation({
      workspaceId: workspace,
      lineageId: lineage.id,
      installationId: 4242,
      facts: {
        repoId: REPO_ID,
        repo: "Acme/Renamed",
        number: 59,
        title: "Make the value two",
        state: "open",
        merged: false,
        draft: false,
        baseRef: "main",
        baseSha: BASE_TIP,
        headRef: "feature/reader",
        headSha: moved,
        mergeBaseSha: null,
        githubUpdatedAt: Date.parse("2026-03-02T10:00:00Z"),
      },
    });
    expect(latestObservation(workspace, lineage.id)!.head_sha).toBe(moved);

    const shell = visible(await (await fetch(`${base}/${workspace}/r/pr-shell-pinned`, { headers: { cookie } })).text());
    expect(shell).not.toContain(moved.slice(0, 7));
    expect(shell).toContain("https://github.com/Acme/Renamed/pull/59");
    expect(shell).toContain("Capturing");

    gate.release();
    await settleCaptureJobs();
    expect(observationForRevision(workspace, getRevision(workspace, "pr-shell-pinned", 1)!.id)!.head_sha).toBe(HEAD);
  });

  test("a pinned capture follows a repository rename only when its id is unchanged", async () => {
    currentClient = githubFixture({
      pullPayload: pull({ number: 63 }),
      repository: { id: REPO_ID, full_name: "Acme/Renamed" },
    });
    const response = await ingest({ repo: REPO, number: 63, slug: "pr-renamed-capture" }, "pr-renamed-capture-1");
    expect(response.status).toBe(202);
    await settleCaptureJobs();

    const lineage = getLineage(workspace, "pr-renamed-capture")!;
    expect(lineage.latest_revision).toBe(1);
    const captureRepo = db.query<{ repo: string; repo_id: number }, [string]>(
      "SELECT c.repo, c.repo_id FROM review_revisions r JOIN stage_captures c ON c.id = r.capture_id WHERE r.lineage_id = ?",
    ).get(lineage.id)!;
    expect(captureRepo).toEqual({ repo: "Acme/Renamed", repo_id: REPO_ID });
  });

  test("a pinned capture refuses a repository substitution behind the observed name", async () => {
    currentClient = githubFixture({
      pullPayload: pull({ number: 64 }),
      repository: { id: 777, full_name: REPO },
    });
    const response = await ingest({ repo: REPO, number: 64, slug: "pr-replaced-capture" }, "pr-replaced-capture-1");
    expect(response.status).toBe(202);
    const view = await response.json() as any;
    await settleCaptureJobs();

    const job = getCaptureJob(workspace, view.id)!;
    expect(job.state).toBe("failed");
    expect(job.failure).toContain("not the observed");
    expect(getLineage(workspace, "pr-replaced-capture")!.latest_revision).toBeNull();
  });

  test("a second capture for the same actor waits, and its shell says the queued word", async () => {
    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: pull({ number: 45 }) });
    const first = await ingest({ repo: REPO, number: 45, slug: "pr-lane-first" }, "pr-lane-first-1");
    expect(first.status).toBe(202);
    const firstJob = await first.json() as any;

    // The same installation, so the same lane. Nothing can claim this one while the first
    // holds the actor, so it is genuinely pending rather than posed as pending.
    currentClient = githubFixture({ pullPayload: pull({ number: 46 }) });
    const second = await ingest({ repo: REPO, number: 46, slug: "pr-lane-second" }, "pr-lane-second-1");
    expect(second.status).toBe(202);
    const secondJob = await second.json() as any;
    expect(getCaptureJob(workspace, secondJob.id)!.state).toBe("pending");
    expect(getCaptureJob(workspace, firstJob.id)!.state).toBe("running");

    const waiting = visible(await (await fetch(`${base}/${workspace}/r/pr-lane-second`, { headers: { cookie } })).text());
    expect(waiting).toContain("Capture pending");
    expect(waiting).toContain("#46");
    expect(waiting).not.toContain("/r/pr-lane-second/rev/");

    // Releasing the first does not just finish it: the lane goes on to the job behind it.
    gate.release();
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, firstJob.id)!.state).toBe("completed");
    expect(getCaptureJob(workspace, secondJob.id)!.state).toBe("completed");
    expect(getLineage(workspace, "pr-lane-second")!.latest_revision).toBe(1);
  });

  test("the completed revision renders the pull request without a panel or a pill", async () => {
    const page = visible(await (await fetch(`${base}/${workspace}/r/pr-direct/rev/1`, { headers: { cookie } })).text());
    expect(page).toContain("#41");
    expect(page).toContain("https://github.com/Acme/Reader/pull/41");
    expect(page).toContain("Acme/Reader#41: Make the value two");
    expect(page).toMatch(/open, observed/);
    expect(page.match(/class="source-pr"/g)).toHaveLength(1);
    expect(page).toContain(`class="source-observation"`);
    // The exact pinned head is exposed, not only its short form.
    expect(page).toContain(HEAD);
  });

  test("the pull request reads the same on the overview, the focus view and without JavaScript", async () => {
    const overview = visible(await (await fetch(`${base}/${workspace}/r/pr-direct/rev/1`, { headers: { cookie } })).text());
    // The primary label is protected: only the short link sits beside the repository and
    // branch, and the secondary facts are in the source section below the title.
    const context = /<p class="stage-context">([\s\S]*?)<\/p>/.exec(overview)?.[1] ?? "";
    expect(context).toContain("#41");
    expect(context).not.toContain("observed");
    const title = /<h1>([\s\S]*?)<\/h1>/.exec(overview)?.[1] ?? "";
    expect(title).toBe("Make the value two");
    const source = /<div class="stage-source">([\s\S]*?)<\/div>/.exec(overview)?.[1] ?? "";
    expect(source).toMatch(/open, observed/);

    // The focus view carries the same link, in the same grammar, and nothing more.
    const focus = visible(await (await fetch(`${base}/${workspace}/r/pr-direct/rev/1?review=seam-1`, { headers: { cookie } })).text());
    expect(focus).toContain(`class="source-pr"`);
    expect(focus).toContain(`class="focus-pr-source"`);
    expect(focus).toContain("#41");

    // No JavaScript is required for any of it: the link is an ordinary anchor with no
    // behaviour attached, and it follows the reader's theme rather than carrying a colour
    // of its own — which is what makes light and dark one rule instead of two.
    const anchor = /<a class="source-pr"[^>]*>/.exec(overview)?.[0] ?? "";
    expect(anchor).toContain("href=");
    expect(anchor).toContain("aria-label=");
    expect(anchor).not.toContain("data-");
    expect(anchor).not.toContain("onclick");
    expect(STAGE_CSS).toContain(".source-pr{color:inherit");
    expect(STAGE_CSS).toContain(".stage-context .source-pr{display:inline-flex;align-items:center;min-height:44px");
    expect(STAGE_CSS).toContain(".focus-head-title>span{display:none}");
    expect(STAGE_CSS).toContain(".js .focus-head-actions>.source-pr{display:none}");
    expect(STAGE_CSS).toContain(".focus-pr-source .source-pr{display:inline-flex;align-items:center;min-height:44px");
    // Not a pill: no background, no border, no radius of its own.
    expect(/\.source-pr\{[^}]*\}/.exec(STAGE_CSS)?.[0] ?? "").not.toMatch(/background|border|radius/);
  });

  test("the API views carry the stored pull request beside the V1 document", async () => {
    const revision = await (await fetch(`${base}/api/review-lineages/pr-direct/revisions/1`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("readReviewRevision", revision);
    expect(revision.pullRequest.number).toBe(41);
    // The document itself is unchanged V1: four keys, no pull request inside it.
    expect(Object.keys(revision.document).sort()).toEqual(["builder", "identity", "projects", "source"]);

    const lineage = await (await fetch(`${base}/api/review-lineages/pr-direct`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("readReviewLineage", lineage);
    expect(lineage.pullRequest.number).toBe(41);
    expect(lineage.captureJobs).toHaveLength(1);
    expect(lineage.captureJobs[0].state).toBe("completed");
  });

  test("a capture job reads back, and its refusals share the review soft miss", async () => {
    const lineage = getLineage(workspace, "pr-direct")!;
    const job = db.query<{ id: string }, [string]>("SELECT id FROM review_capture_jobs WHERE lineage_id = ?").get(lineage.id)!;
    const read = await fetch(`${base}/api/review-capture-jobs/${job.id}`, { headers: { authorization: `Bearer ${key}` } });
    expect(read.status).toBe(200);
    validateResponse("readReviewCaptureJob", await read.json());

    const missing = await fetch(`${base}/api/review-capture-jobs/rcj_0000000000`, { headers: { authorization: `Bearer ${key}` } });
    const malformed = await fetch(`${base}/api/review-capture-jobs/nope`, { headers: { authorization: `Bearer ${key}` } });
    expect([missing.status, malformed.status]).toEqual([404, 404]);
    expect(await missing.text()).toBe(await malformed.text());
  });

  test("the same key and body replays; a different body with that key is a conflict", async () => {
    const again = await ingest({ repo: REPO, number: 41, slug: "pr-direct" }, "pr-direct-1");
    // 200 rather than 202: the capture this key queued has finished, so there is a
    // revision to read. The replay cost no GitHub call at all.
    expect(again.status).toBe(200);
    const replayed = await again.json() as any;
    validateResponse("createPullRequestReviewLineage", replayed);
    expect(replayed.revision).toBe(1);
    expect(replayed.state).toBe("completed");
    expect(opened).toEqual([]);
    // No second observation, no second job, no second revision.
    const lineage = getLineage(workspace, "pr-direct")!;
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE lineage_id = ?", lineage.id)).toBe(1);

    const different = await ingest({ repo: REPO, number: 41, slug: "pr-direct-other" }, "pr-direct-1");
    expect(different.status).toBe(409);
    expect((await different.json() as any).error).toContain("Idempotency-Key");
  });

  test("a second lineage cannot take a pull request one already reviews", async () => {
    const response = await ingest({ repo: REPO, number: 41, slug: "pr-direct-rival" }, "pr-direct-rival-1");
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    // The other 409: a conflict with no job behind it carries `error` alone, and the
    // document says so.
    validateResponse("createPullRequestReviewLineage", body, "409");
    expect(body.error).toContain("already reviewed by");
    expect(body.job).toBeUndefined();
    expect(getLineage(workspace, "pr-direct-rival")).toBeNull();
  });

  test("concurrent identical requests land one lineage, one job and one revision", async () => {
    currentClient = githubFixture({ pullPayload: pull({ number: 44 }) });
    const body = { repo: REPO, number: 44, slug: "pr-concurrent" };
    const responses = await Promise.all(Array.from({ length: 4 }, () => ingest(body, "pr-concurrent-1")));
    const bodies = await Promise.all(responses.map((response) => response.json() as any));
    expect(responses.every((response) => response.status === 202 || response.status === 200)).toBe(true);
    expect(new Set(bodies.map((entry: any) => entry.id)).size).toBe(1);

    const lineage = getLineage(workspace, "pr-concurrent")!;
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(1);
    expect(count(
      "SELECT COUNT(*) AS n FROM review_lineage_prs WHERE workspace_id = ? AND pr_number = ? AND detached_at IS NULL",
      workspace, 44,
    )).toBe(1);

    await settleCaptureJobs();
    // One completed capture result, and one source revision from it.
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE lineage_id = ?", lineage.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_revision_sources WHERE lineage_id = ?", lineage.id)).toBe(1);
    expect(getLineage(workspace, "pr-concurrent")!.latest_revision).toBe(1);
  });

  test("concurrent different keys for one pull request land one relationship", async () => {
    const responses = await Promise.all([
      ingest({ repo: REPO, number: 41, slug: "pr-race-a" }, "pr-race-a"),
      ingest({ repo: REPO, number: 41, slug: "pr-race-b" }, "pr-race-b"),
    ]);
    expect(responses.every((response) => response.status === 409)).toBe(true);
    expect(count(
      "SELECT COUNT(*) AS n FROM review_lineage_prs WHERE workspace_id = ? AND pr_number = ? AND detached_at IS NULL",
      workspace, 41,
    )).toBe(1);
  });

  test("an Idempotency-Key is required", async () => {
    const response = await fetch(`${base}/api/pull-request-review-lineages`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: REPO, number: 99, slug: "pr-no-key" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toContain("Idempotency-Key");
  });
});

// ---- the branch-first half ----

describe("a branch-first review gains its pull request", () => {
  test("an exact source tuple reuses the revision and captures nothing", async () => {
    const capture = await createBranchCapture("branch-first", "branch-first-capture");
    const published = await fetch(`${base}/api/review-lineages`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ captureId: capture.id, slug: "branch-first", title: "Branch first" }),
    });
    expect(published.status).toBe(200);
    const revision = getRevision(workspace, "branch-first", 1)!;
    const request = getWitnessRequestForRevision(workspace, revision.id)!;

    // A member has already handled a change. Attaching a pull request must not disturb it.
    const changeId = db.query<{ id: string }, [string]>(
      "SELECT id FROM stage_capture_changes WHERE capture_id = ? ORDER BY id LIMIT 1",
    ).get(capture.id)!.id;
    db.run("INSERT INTO review_revision_change_reads VALUES (?, ?, ?, ?, ?)", [workspace, revision.id, owner, changeId, Date.now()]);

    currentClient = githubFixture({ pullPayload: pull({ number: 42 }) });
    const attached = await attach("branch-first", { repo: REPO, number: 42 }, "branch-first-attach");
    expect(attached.status).toBe(200);
    const body = await attached.json() as any;
    validateResponse("attachPullRequestToReviewLineage", body);
    expect(body.reused).toBe(true);
    expect(body.revision).toBe(1);

    // Exactly one revision, the same witness request, the same read mark, no capture job.
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE lineage_id = ?", revision.lineage_id)).toBe(1);
    expect(getWitnessRequestForRevision(workspace, revision.id)!.id).toBe(request.id);
    expect(count("SELECT COUNT(*) AS n FROM review_witness_requests WHERE lineage_id = ?", revision.lineage_id)).toBe(1);
    expect(count(
      "SELECT COUNT(*) AS n FROM review_revision_change_reads WHERE revision_id = ? AND user_id = ?",
      revision.id, owner,
    )).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", revision.lineage_id)).toBe(0);
    // The revision document is untouched: the association is a row beside it.
    expect(getRevision(workspace, "branch-first", 1)!.digest).toBe(revision.digest);
    expect(observationForRevision(workspace, revision.id)!.pr_number).toBe(42);
  });

  test("a moved head queues a pinned capture and appends only on completion", async () => {
    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: movedHead(42) });
    const moved = await attach("branch-first", { repo: REPO, number: 42 }, "branch-first-moved");
    expect(moved.status).toBe(202);
    validateResponse("attachPullRequestToReviewLineage", await moved.json(), "202");

    // The previous revision stays current until the capture completes. Held at the
    // worker's open, so this is the state a reader would really see meanwhile.
    expect(getLineage(workspace, "branch-first")!.latest_revision).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ? AND slug = ?", workspace, "branch-first")).toBe(1);

    gate.release();
    await settleCaptureJobs();
    expect(getLineage(workspace, "branch-first")!.latest_revision).toBe(2);
    const appended = getRevision(workspace, "branch-first", 2)!;
    expect(appended.doc.source.sourceHeadSha).toBe(HEAD2);
    expect(appended.doc.source.mergeBaseSha).toBe(MERGE2);
    // The lineage's first base is carried forward rather than restated from this capture.
    expect(appended.doc.source.originalBaseRef).toBe("main");
    expect(getWitnessRequestForRevision(workspace, appended.id)!.state).toBe("pending");
    // Revision 1 is untouched.
    expect(getRevision(workspace, "branch-first", 1)!.doc.source.sourceHeadSha).toBe(HEAD);
  });

  test("attaching the same moved head again reuses the published revision", async () => {
    currentClient = githubFixture({ pullPayload: movedHead(42) });
    const again = await attach("branch-first", { repo: REPO, number: 42 }, "branch-first-moved-again");
    expect(again.status).toBe(200);
    expect((await again.json() as any).revision).toBe(2);
    expect(getLineage(workspace, "branch-first")!.latest_revision).toBe(2);
  });

  test("a lineage that already reviews one pull request refuses another", async () => {
    currentClient = githubFixture({ pullPayload: pull({ number: 43 }) });
    const response = await attach("branch-first", { repo: REPO, number: 43 }, "branch-first-second-pr");
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("already reviews");
  });
});

// ---- what this slice refuses, by name ----

describe("every refusal is its own sentence", () => {
  const cases: { name: string; number: number; payload: unknown; says: string }[] = [
    {
      name: "a fork head",
      number: 50,
      payload: pull({ number: 50, head: { ref: "feature/reader", sha: HEAD, repo: { id: 999, full_name: "Fork/Reader" } } }),
      says: "opened from a fork",
    },
    {
      name: "a deleted head repository",
      number: 51,
      payload: pull({ number: 51, head: { ref: "feature/reader", sha: HEAD, repo: null } }),
      says: "no usable head repository",
    },
    {
      name: "a missing base repository",
      number: 52,
      payload: pull({ number: 52, base: { ref: "main", sha: BASE_TIP, repo: null } }),
      says: "no usable base repository",
    },
    {
      name: "an unparseable update time",
      number: 53,
      payload: pull({ number: 53, updated_at: "not a time" }),
      says: "invalid pull request update time",
    },
    {
      name: "an unknown state",
      number: 54,
      payload: pull({ number: 54, state: "sideways" }),
      says: "unknown pull request state",
    },
    {
      name: "an answer about a different pull request",
      number: 55,
      payload: pull({ number: 56 }),
      says: "with pull request 56",
    },
  ];

  for (const [index, refusal] of cases.entries()) {
    test(`${refusal.name} is a 422 that says so`, async () => {
      currentClient = githubFixture({ pullPayload: refusal.payload });
      const slug = `pr-refuse-${index}`;
      const response = await ingest({ repo: REPO, number: refusal.number, slug }, slug);
      expect(response.status).toBe(422);
      expect((await response.json() as any).error).toContain(refusal.says);
      expect(getLineage(workspace, slug)).toBeNull();
    });
  }

  test("a payload Seer cannot use is 422; a GitHub the host cannot reach is still 502", async () => {
    // The two travel the same call path and are both GithubError, so the split has to be
    // by class rather than by status. A caller can fix the first and can only retry the
    // second, and answering either as the other sends them the wrong way.
    currentClient = githubFixture({ pullPayload: pull({ number: 57, title: "" }) });
    const payload = await ingest({ repo: REPO, number: 57, slug: "pr-refuse-title" }, "pr-refuse-title");
    expect(payload.status).toBe(422);
    expect((await payload.json() as any).error).toContain("invalid pull request title");

    currentClient = githubFixture({ refuse: () => new GithubError("GitHub is unavailable.", 500, "") });
    const transport = await ingest({ repo: REPO, number: 58, slug: "pr-refuse-transport" }, "pr-refuse-transport");
    expect(transport.status).toBe(502);
    expect((await transport.json() as any).error).toContain("GitHub is unavailable.");
    expect(getLineage(workspace, "pr-refuse-transport")).toBeNull();
  });

  test("a wrong branch, a wrong base and a wrong repository each name what did not match", async () => {
    const capture = await createBranchCapture("branch-mismatch", "branch-mismatch-capture");
    const published = await fetch(`${base}/api/review-lineages`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ captureId: capture.id, slug: "branch-mismatch", title: "Branch mismatch" }),
    });
    expect(published.status).toBe(200);

    currentClient = githubFixture({ pullPayload: pull({ number: 60, head: { ref: "feature/other", sha: HEAD, repo: { id: REPO_ID, full_name: REPO } } }) });
    const branch = await attach("branch-mismatch", { repo: REPO, number: 60 }, "mismatch-branch");
    expect(branch.status).toBe(422);
    expect((await branch.json() as any).error).toContain("opened from feature/other");

    currentClient = githubFixture({ pullPayload: pull({ number: 61, base: { ref: "release", sha: BASE_TIP, repo: { id: REPO_ID, full_name: REPO } } }) });
    const baseRef = await attach("branch-mismatch", { repo: REPO, number: 61 }, "mismatch-base");
    expect(baseRef.status).toBe(422);
    expect((await baseRef.json() as any).error).toContain("targets release");

    currentClient = githubFixture({
      pullPayload: pull({
        number: 62,
        base: { ref: "main", sha: BASE_TIP, repo: { id: 777, full_name: REPO } },
        head: { ref: "feature/reader", sha: HEAD, repo: { id: 777, full_name: REPO } },
      }),
    });
    const repoId = await attach("branch-mismatch", { repo: REPO, number: 62 }, "mismatch-repo");
    expect(repoId.status).toBe(422);
    expect((await repoId.json() as any).error).toContain("repository 777");

    expect(getLineagePr(workspace, getLineage(workspace, "branch-mismatch")!.id)).toBeNull();
  });

  test("a private repository read anonymously refuses without another credential", async () => {
    resolvedActor = { kind: "anonymous" };
    currentClient = githubFixture({ refuse: () => new GithubRoutingError("Acme/Reader is not reachable anonymously") });
    const response = await ingest({ repo: REPO, number: 70, slug: "pr-anonymous" }, "pr-anonymous-1");
    expect(response.status).toBe(422);
    expect((await response.json() as any).error).toContain("not reachable anonymously");
    // Exactly one actor was opened: no second credential was tried behind the refusal.
    expect(opened).toEqual([{ kind: "anonymous" }]);
  });
});

// ---- exact actor ownership ----

describe("a stored personal credential is not the workspace's to spend", () => {
  test("a PAT-owned review refreshes for its owner and refuses another member", async () => {
    resolvedActor = { kind: "user", userId: secondUser, credentialId: "guc_secondcred" };
    currentClient = githubFixture({ pullPayload: pull({ number: 80 }) });
    const created = await ingest({ repo: REPO, number: 80, slug: "pr-pat" }, "pr-pat-1", secondKey);
    expect(created.status).toBe(202);
    await settleCaptureJobs();

    const relation = getLineagePr(workspace, getLineage(workspace, "pr-pat")!.id)!;
    expect(relation.actor_kind).toBe("user");
    expect(relation.user_id).toBe(secondUser);
    expect(relation.credential_id).toBe("guc_secondcred");

    // The owner may refresh. The router is asked for exactly their credential.
    opened = [];
    const mine = await fetch(`${base}/api/review-lineages/pr-pat/refresh`, {
      method: "POST", headers: jsonHeaders(secondKey, "pr-pat-refresh-1"),
    });
    expect(mine.status).toBe(200);
    validateResponse("refreshReviewLineagePullRequest", await mine.json());
    expect(opened).toEqual([{ kind: "user", userId: secondUser, credentialId: "guc_secondcred" }]);

    // Another member of the same workspace may not.
    opened = [];
    const theirs = await fetch(`${base}/api/review-lineages/pr-pat/refresh`, {
      method: "POST", headers: jsonHeaders(key, "pr-pat-refresh-2"),
    });
    expect(theirs.status).toBe(403);
    expect((await theirs.json() as any).error).toContain("only they can spend");
    expect(opened).toEqual([]);

    // And may not retry the capture that spends it either.
    const job = db.query<{ id: string }, [string]>(
      "SELECT id FROM review_capture_jobs WHERE lineage_id = ?",
    ).get(getLineage(workspace, "pr-pat")!.id)!;
    const retry = await fetch(`${base}/api/review-capture-jobs/${job.id}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(retry.status).toBe(403);
  });

  test("a PAT-owned review refreshes across a repository rename by numeric id", async () => {
    resolvedActor = { kind: "user", userId: secondUser, credentialId: "guc_secondcred" };
    const renamed = "Acme/Renamed";
    currentClient = githubFixture({
      pullPayload: pull({
        number: 80,
        base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: renamed } },
        head: { ref: "feature/reader", sha: HEAD, repo: { id: REPO_ID, full_name: renamed } },
      }),
    });
    const response = await fetch(`${base}/api/review-lineages/pr-pat/refresh`, {
      method: "POST", headers: jsonHeaders(secondKey, "pr-pat-refresh-renamed"),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.pullRequest.repo).toBe(renamed);
    expect(body.pullRequest.repoId).toBe(REPO_ID);
    expect(getLineagePr(workspace, getLineage(workspace, "pr-pat")!.id)!.repo).toBe(REPO);
    const lineageView = await (await fetch(`${base}/api/review-lineages/pr-pat`, {
      headers: { authorization: `Bearer ${secondKey}` },
    })).json() as any;
    expect(lineageView.pullRequest.repo).toBe(renamed);
    expect(lineageView.pullRequest.url).toBe("https://github.com/Acme/Renamed/pull/80");

    currentClient = githubFixture({
      pullPayload: pull({
        number: 80,
        base: { ref: "main", sha: BASE_TIP, repo: { id: 777, full_name: REPO } },
        head: { ref: "feature/reader", sha: HEAD, repo: { id: 777, full_name: REPO } },
      }),
    });
    const replaced = await fetch(`${base}/api/review-lineages/pr-pat/refresh`, {
      method: "POST", headers: jsonHeaders(secondKey, "pr-pat-refresh-replaced"),
    });
    expect(replaced.status).toBe(422);
    expect((await replaced.json() as any).error).toContain("repository 777");
  });

  test("a revoked credential fails the job visibly and never falls through", async () => {
    // Held at the worker's own open, which is what makes "between the observation and the
    // capture" a real moment rather than a hope about scheduling.
    const gate = holdOpenAt(2);
    resolvedActor = { kind: "user", userId: secondUser, credentialId: "guc_deadcred" };
    currentClient = githubFixture({ pullPayload: pull({ number: 81 }) });
    const created = await ingest({ repo: REPO, number: 81, slug: "pr-dead" }, "pr-dead-1", secondKey);
    expect(created.status).toBe(202);
    const job = await created.json() as any;
    expect(getCaptureJob(workspace, job.id)!.state).toBe("running");

    // The credential dies between the observation and the capture.
    deadActors.set(`user:${secondUser}:guc_deadcred`, () =>
      new GithubCredentialDeadError("guc_deadcred", "Your GitHub credential was revoked at GitHub."));
    gate.release();
    await settleCaptureJobs();

    const failed = getCaptureJob(workspace, job.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.failure).toContain("revoked at GitHub");
    expect(getLineage(workspace, "pr-dead")!.latest_revision).toBeNull();
    // Only the stored actor was ever opened.
    expect(opened.every((actor) => actor.kind === "user" && actor.credentialId === "guc_deadcred")).toBe(true);

    // The failed job is visible, retryable, and its retry re-runs the same pinned source.
    const read = await fetch(`${base}/api/review-capture-jobs/${job.id}`, { headers: { authorization: `Bearer ${secondKey}` } });
    expect((await read.json() as any).state).toBe("failed");
    deadActors = new Map();
    const retried = await fetch(`${base}/api/review-capture-jobs/${job.id}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(retried.status).toBe(202);
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, job.id)!.state).toBe("completed");
    expect(getLineage(workspace, "pr-dead")!.latest_revision).toBe(1);
  });

  test("re-reading unchanged facts through the same actor adds no observation", async () => {
    const lineage = getLineage(workspace, "pr-pat")!;
    const before = count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id);
    resolvedActor = { kind: "user", userId: secondUser, credentialId: "guc_secondcred" };
    currentClient = githubFixture({ pullPayload: pull({ number: 80 }) });
    const again = await fetch(`${base}/api/review-lineages/pr-pat/refresh`, {
      method: "POST", headers: jsonHeaders(secondKey, "pr-pat-refresh-3"),
    });
    expect(again.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(before);
  });
});

// ---- the actor lane ----

describe("one actor runs one capture at a time", () => {
  const lane = "ws_lane/installation/1";
  const other = "ws_lane/installation/2";
  const exhausted = "ws_lane/installation/3";

  function seedJob(
    id: string,
    laneKey: string,
    state: string,
    leaseExpiry: number | null,
    attempts = 0,
  ): void {
    db.run(
      "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
        "VALUES (?, 'ws_lane00000', 'rln_lane00000', 'lane', ?, ?, 'installation', 1, NULL, NULL, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)",
      [id, `pob_${id}`, state, laneKey, attempts, leaseExpiry === null ? null : "lse_held", leaseExpiry, Date.now(), Date.now()],
    );
  }

  function jobRow(id: string): { state: string; attempts: number; failure: string | null } {
    return db.query<{ state: string; attempts: number; failure: string | null }, [string]>(
      "SELECT state, attempts, failure FROM review_capture_jobs WHERE id = ?",
    ).get(id)!;
  }

  function stateOf(id: string): string {
    return jobRow(id).state;
  }

  test("a healthy running job blocks its own lane and no other", () => {
    const now = Date.now();
    seedJob("rcj_lane000001", lane, "running", now + CAPTURE_LEASE_MS);
    seedJob("rcj_lane000002", lane, "pending", null);
    seedJob("rcj_lane000003", other, "pending", null);

    // "Busy", not "nothing to do": the difference is what tells a caller to come back.
    expect(claimNextCaptureJob(lane, now)).toEqual({ kind: "busy" });
    const overlapping = claimNextCaptureJob(other, now);
    expect(overlapping.kind).toBe("claimed");
    expect(overlapping.kind === "claimed" && overlapping.job.id).toBe("rcj_lane000003");
    expect(overlapping.kind === "claimed" && overlapping.job.attempts).toBe(1);
    expect(stateOf("rcj_lane000002")).toBe("pending");
  });

  test("an expired lease is recovered without stealing a healthy one", () => {
    const later = Date.now() + CAPTURE_LEASE_MS + 1;
    const recovered = claimNextCaptureJob(lane, later);
    // The abandoned job goes back in the queue and is claimed in creation order.
    expect(recovered.kind).toBe("claimed");
    expect(recovered.kind === "claimed" && recovered.job.id).toBe("rcj_lane000001");
    expect(recovered.kind === "claimed" && recovered.job.state).toBe("running");
    expect(recovered.kind === "claimed" && recovered.job.attempts).toBe(1);
    expect(stateOf("rcj_lane000002")).toBe("pending");
    // And the healthy claim on the OTHER lane was not disturbed.
    expect(stateOf("rcj_lane000003")).toBe("running");
  });

  test("a job that runs out of attempts fails without stranding the jobs behind it", async () => {
    seedJob("rcj_lane000010", exhausted, "pending", null, MAX_CAPTURE_ATTEMPTS);
    seedJob("rcj_lane000011", exhausted, "pending", null);

    // The claim itself distinguishes "I failed the head of this lane" from "there is
    // nothing here", which is what lets the lane keep going.
    const first = claimNextCaptureJob(exhausted, Date.now());
    expect(first).toEqual({ kind: "exhausted", jobId: "rcj_lane000010" });
    expect(jobRow("rcj_lane000010").state).toBe("failed");
    expect(jobRow("rcj_lane000010").failure).toContain("attempted");
    const second = claimNextCaptureJob(exhausted, Date.now());
    expect(second.kind === "claimed" && second.job.id).toBe("rcj_lane000011");
    expect(claimNextCaptureJob(exhausted, Date.now())).toEqual({ kind: "busy" });

    // And the lane, driven end to end, does not exit on the failed head either. The
    // sibling's observation is deliberately absent, so it fails too — the point is that
    // it was claimed and answered rather than left pending with nobody scheduled.
    db.run("UPDATE review_capture_jobs SET state = 'pending', attempts = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ?",
      [MAX_CAPTURE_ATTEMPTS, "rcj_lane000010"]);
    db.run("UPDATE review_capture_jobs SET state = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL WHERE id = ?",
      ["rcj_lane000011"]);
    scheduleActorQueue(exhausted);
    await settleCaptureJobs();
    expect(jobRow("rcj_lane000010").state).toBe("failed");
    expect(jobRow("rcj_lane000011").state).toBe("failed");
    expect(jobRow("rcj_lane000011").attempts).toBe(1);
  });

  test("a lease abandoned by another process is recovered on a timer, with no restart", async () => {
    // A job this process really queued, so its lineage, observation and actor are real.
    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: pull({ number: 47 }) });
    const created = await ingest({ repo: REPO, number: 47, slug: "pr-sweep" }, "pr-sweep-1");
    expect(created.status).toBe(202);
    const job = await created.json() as any;

    // Another container recovers this job and holds a HEALTHY lease on it. This process's
    // worker discards its own result, and its lane then finds the actor busy and exits —
    // which is the whole point: nothing in this process is scheduled to look again.
    db.run(
      "UPDATE review_capture_jobs SET lease_token = 'lse_elsewhere', lease_expires_at = ? WHERE id = ?",
      [Date.now() + CAPTURE_LEASE_MS, job.id],
    );
    gate.release();
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, job.id)!.state).toBe("running");
    expect(getLineage(workspace, "pr-sweep")!.latest_revision).toBeNull();

    // Then that container dies, and its lease runs out. Before the sweep existed this is
    // where the job stayed until the next ingest for this actor or the next restart.
    db.run("UPDATE review_capture_jobs SET lease_expires_at = ? WHERE id = ?", [Date.now() - 1, job.id]);

    // Nothing is restarted and recoverCaptureJobs is never called by hand: the periodic
    // sweep a live process runs is the only thing that can pick this up.
    startCaptureSweep(20);
    const deadline = Date.now() + 5_000;
    while (getCaptureJob(workspace, job.id)!.state !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settleCaptureJobs();
    }
    stopCaptureSweep();
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, job.id)!.state).toBe("completed");
    expect(getLineage(workspace, "pr-sweep")!.latest_revision).toBe(1);
  });

  test("a worker that lost its lease publishes nothing", async () => {
    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: pull({ number: 48 }) });
    const created = await ingest({ repo: REPO, number: 48, slug: "pr-lost-lease" }, "pr-lost-lease-1");
    expect(created.status).toBe(202);
    const job = await created.json() as any;
    expect(getCaptureJob(workspace, job.id)!.state).toBe("running");

    // Another process recovers the lease while this worker is mid-capture. Its heartbeat
    // now answers false, which is the signal the worker has to act on.
    db.run(
      "UPDATE review_capture_jobs SET lease_token = 'lse_takeover', lease_expires_at = ? WHERE id = ?",
      [Date.now() + CAPTURE_LEASE_MS, job.id],
    );
    gate.release();
    await settleCaptureJobs();

    const after = getCaptureJob(workspace, job.id)!;
    // The takeover's claim is untouched, and nothing was published under it.
    expect(after.lease_token).toBe("lse_takeover");
    expect(after.state).toBe("running");
    expect(after.revision_id).toBeNull();
    expect(getLineage(workspace, "pr-lost-lease")!.latest_revision).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM review_revisions WHERE lineage_id = ?", after.lineage_id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM review_revision_sources WHERE lineage_id = ?", after.lineage_id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM review_witness_requests WHERE lineage_id = ?", after.lineage_id)).toBe(0);

    // Left as the takeover holder's work, and claimable by it alone until that lease runs
    // out — the stale worker did not fail it out from under them either.
    expect(claimNextCaptureJob(after.actor_key, Date.now())).toEqual({ kind: "busy" });
    db.run("UPDATE review_capture_jobs SET state = 'failed', failure = 'abandoned by the test', lease_token = NULL, lease_expires_at = NULL WHERE id = ?", [job.id]);
  });
});

// ---- witness claims ----

describe("one healthy claimant per attempt", () => {
  let requestId = "";

  test("a claim is taken, renewed by its own key, and refused to another", async () => {
    const revision = getRevision(workspace, "pr-direct", 1)!;
    requestId = getWitnessRequestForRevision(workspace, revision.id)!.id;

    const claimed = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(claimed.status).toBe(200);
    const body = await claimed.json() as any;
    validateResponse("claimWitnessRequest", body);
    expect(body.claim.claimed).toBe(true);
    expect(body.claim.retryCount).toBe(0);

    const renewed = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect((await renewed.json() as any).claim.claimed).toBe(false);

    const foreign = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(foreign.status).toBe(409);
    expect((await foreign.json() as any).error).toContain("has not expired");
  });

  test("publication and failure by a foreign key are refused while the lease is healthy", async () => {
    const failed = await fetch(`${base}/api/review-witness-requests/${requestId}/fail`, {
      method: "POST", headers: jsonHeaders(secondKey), body: JSON.stringify({ error: "not mine to fail" }),
    });
    expect(failed.status).toBe(409);

    const account = await fetch(`${base}/api/review-lineages/pr-direct/revisions/1/accounts`, {
      method: "POST", headers: jsonHeaders(secondKey),
      body: JSON.stringify(accountBody(captureIdOf("pr-direct", 1), "Not mine to publish.")),
    });
    expect(account.status).toBe(409);
    expect(count("SELECT COUNT(*) AS n FROM review_accounts WHERE workspace_id = ? AND slug = ?", workspace, "pr-direct")).toBe(0);
  });

  test("an expired lease is recovered, and a retry opens a fresh attempt", async () => {
    // Expire the lease in place rather than waiting ten minutes for it.
    db.run("UPDATE review_witness_claims SET lease_expires_at = ? WHERE request_id = ?", [Date.now() - 1, requestId]);
    const recovered = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${secondKey}` },
    });
    expect(recovered.status).toBe(200);
    const body = await recovered.json() as any;
    expect(body.claim.claimed).toBe(true);
    // Recovery is a handover, not a failure: the retry count is untouched.
    expect(body.claim.retryCount).toBe(0);
    expect(body.retryCount).toBe(0);

    // The recovered holder fails it; retry counts one and opens attempt 1, which the
    // first key may now claim because attempt 0's claim says nothing about attempt 1.
    const failed = await fetch(`${base}/api/review-witness-requests/${requestId}/fail`, {
      method: "POST", headers: jsonHeaders(secondKey), body: JSON.stringify({ error: "ran out of context" }),
    });
    expect(failed.status).toBe(200);
    const retried = await fetch(`${base}/api/review-witness-requests/${requestId}/retry`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect((await retried.json() as any).retryCount).toBe(1);

    const fresh = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(fresh.status).toBe(200);
    expect((await fresh.json() as any).claim.retryCount).toBe(1);
  });

  test("the holder of the current attempt publishes, and the request moves with it", async () => {
    const published = await fetch(`${base}/api/review-lineages/pr-direct/revisions/1/accounts`, {
      method: "POST", headers: jsonHeaders(key),
      body: JSON.stringify(accountBody(captureIdOf("pr-direct", 1))),
    });
    expect(published.status).toBe(200);
    expect(getWitnessRequestForRevision(workspace, getRevision(workspace, "pr-direct", 1)!.id)!.state).toBe("published");
    // A claim on a published request has nothing left to take.
    const late = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, {
      method: "POST", headers: { authorization: `Bearer ${key}` },
    });
    expect(late.status).toBe(409);
  });
});

// ---- webhooks, reconciliation, orphan sweeping ----

describe("a delivery joins the same relationship", () => {
  const INSTALLATION = 9100;

  function deliver(event: string, payload: unknown, deliveryId: string): Promise<Response> {
    const body = JSON.stringify(payload);
    return fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": webhookSignature(config.githubApp.webhookSecret, body),
      },
      body,
    });
  }

  beforeAll(() => {
    db.run(
      "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at, created_at) " +
        "VALUES (?, ?, ?, 'Acme', 1, 'Organization', 'all', ?, ?, ?)",
      [tinyId("ghi"), workspace, INSTALLATION, owner, Date.now(), Date.now()],
    );
  });

  test("a pull request only a promoted review names is observed, then captured", async () => {
    // The worker is held at its own open, which is the only window in which a delivery's
    // observation exists without the merge base its capture will establish.
    const gate = holdOpenAt(1);
    const response = await deliver("pull_request", {
      action: "synchronize",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: {
        number: 41, title: "Make the value two", state: "open", merged: false, draft: false,
        updated_at: "2026-03-02T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: REPO } },
        head: { ref: "feature/reader", sha: HEAD2, repo: { id: REPO_ID, full_name: REPO } },
      },
    }, "delivery-promoted-1");
    expect([200, 202]).toContain(response.status);

    const lineage = getLineage(workspace, "pr-direct")!;
    const observed = latestObservation(workspace, lineage.id)!;
    expect(observed.head_sha).toBe(HEAD2);
    expect(observed.actor_kind).toBe("installation");
    expect(observed.installation_id).toBe(INSTALLATION);
    // A delivery carries no merge base, and Seer does not invent one.
    expect(observed.merge_base_sha).toBeNull();
    // The legacy status row was written too.
    expect(count("SELECT COUNT(*) AS n FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?", workspace, 41)).toBe(1);

    // The capture is queued through the RELATION's stored installation actor rather than
    // the delivery's, and it establishes the merge base by comparing the delivery's own
    // pinned SHAs.
    const queued = db.query<{ installation_id: number | null }, [string, string]>(
      "SELECT installation_id FROM review_capture_jobs WHERE lineage_id = ? AND observation_id = ?",
    ).get(lineage.id, observed.id)!;
    expect(queued.installation_id).toBe(4242);

    gate.release();
    await settleCaptureJobs();
    const appended = getRevision(workspace, "pr-direct", 2)!;
    expect(appended.doc.source.sourceHeadSha).toBe(HEAD2);
    expect(appended.doc.source.mergeBaseSha).toBe(MERGE2);
  });

  test("the pinned revision keeps its own observation after the pull request moves", async () => {
    const revision = getRevision(workspace, "pr-direct", 1)!;
    expect(observationForRevision(workspace, revision.id)!.head_sha).toBe(HEAD);
    const page = visible(await (await fetch(`${base}/${workspace}/r/pr-direct/rev/1`, { headers: { cookie } })).text());
    expect(page).toContain(HEAD);
    expect(page).not.toContain(HEAD2);
  });

  test("a payload without complete repository identity records no promoted observation", async () => {
    const lineage = getLineage(workspace, "pr-direct")!;
    const before = count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id);
    await deliver("pull_request", {
      action: "closed",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: {
        number: 41, title: "Make the value two", state: "closed", merged: true, draft: false,
        updated_at: "2026-03-03T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP },
        head: { ref: "feature/reader", sha: HEAD2 },
      },
    }, "delivery-promoted-incomplete");
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(before);
    // The legacy status row still moved, which is what it is for.
    expect(db.query<{ merged: number }, [string, number]>(
      "SELECT merged FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?",
    ).get(workspace, 41)!.merged).toBe(1);
  });

  test("traffic for a pull request nothing names is dropped", async () => {
    const response = await deliver("pull_request", {
      action: "opened",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: {
        number: 4242, title: "Unrelated", state: "open", merged: false, draft: false,
        updated_at: "2026-03-04T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: REPO } },
        head: { ref: "feature/other", sha: HEAD, repo: { id: REPO_ID, full_name: REPO } },
      },
    }, "delivery-unrelated");
    expect(response.status).toBe(202);
    expect(count("SELECT COUNT(*) AS n FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?", workspace, 4242)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE workspace_id = ? AND pr_number = ?", workspace, 4242)).toBe(0);
  });

  test("a renamed repository still joins by numeric id", async () => {
    await deliver("pull_request", {
      action: "reopened",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: "Acme/Renamed" },
      pull_request: {
        number: 41, title: "Make the value two", state: "open", merged: false, draft: false,
        updated_at: "2026-03-05T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: "Acme/Renamed" } },
        head: { ref: "feature/reader", sha: HEAD2, repo: { id: REPO_ID, full_name: "Acme/Renamed" } },
      },
    }, "delivery-renamed");
    const lineage = getLineage(workspace, "pr-direct")!;
    expect(latestObservation(workspace, lineage.id)!.repo).toBe("Acme/Renamed");
    // The relation's stored name is a historical display fact and is not rewritten.
    expect(getLineagePr(workspace, lineage.id)!.repo).toBe(REPO);
    const pinned = visible(await (await fetch(`${base}/${workspace}/r/pr-direct/rev/1`, { headers: { cookie } })).text());
    expect(pinned).toContain("https://github.com/Acme/Renamed/pull/41");
    expect(pinned).not.toContain("https://github.com/Acme/Reader/pull/41");

    const revisionApi = await (await fetch(`${base}/api/review-lineages/pr-direct/revisions/1`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    expect(revisionApi.pullRequest.repo).toBe(REPO);
    expect(revisionApi.pullRequest.url).toBe("https://github.com/Acme/Renamed/pull/41");
    const jobId = db.query<{ id: string }, [string]>(
      "SELECT id FROM review_capture_jobs WHERE lineage_id = ? ORDER BY created_at LIMIT 1",
    ).get(lineage.id)!.id;
    const jobApi = await (await fetch(`${base}/api/review-capture-jobs/${jobId}`, {
      headers: { authorization: `Bearer ${key}` },
    })).json() as any;
    expect(jobApi.pullRequest.url).toBe("https://github.com/Acme/Renamed/pull/41");
  });

  test("a repository created at a freed name is not this review's, however it is spelled", async () => {
    const lineage = getLineage(workspace, "pr-direct")!;
    const before = count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id);
    // The rename above freed "Acme/Reader", and the relation still stores that name
    // beside repository 440. A different repository now holds the name — and #41 on it is
    // somebody else's pull request.
    expect(getLineagePr(workspace, lineage.id)!.repo).toBe(REPO);
    const response = await deliver("pull_request", {
      action: "synchronize",
      installation: { id: INSTALLATION },
      repository: { id: 991, full_name: REPO },
      pull_request: {
        number: 41, title: "Somebody else's pull request", state: "open", merged: false, draft: false,
        updated_at: "2026-03-06T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP, repo: { id: 991, full_name: REPO } },
        head: { ref: "feature/theirs", sha: HEAD, repo: { id: 991, full_name: REPO } },
      },
    }, "delivery-name-reuse");
    expect(response.status).toBe(202);

    // No observation on this lineage, no observation carrying the other repository, and
    // no status row for a repository this workspace reviews nothing in.
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE workspace_id = ? AND repo_id = ?", workspace, 991)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM github_pr_status WHERE workspace_id = ? AND repo_id = ?", workspace, 991)).toBe(0);
    expect(latestObservation(workspace, lineage.id)!.repo_id).toBe(REPO_ID);
  });

  test("an observation that cannot be written takes the delivery id down with it", async () => {
    const lineage = getLineage(workspace, "pr-direct")!;
    const statusOf = () => db.query<{ head_sha: string; updated_at: number }, [string, number]>(
      "SELECT head_sha, updated_at FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?",
    ).get(workspace, 41)!;
    const before = statusOf();
    const observations = count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id);

    // A write fault in the one nested write of the delivery transaction. A trigger is the
    // honest way to produce it: the code path is the real one, and only this payload
    // trips it.
    const payload = {
      action: "synchronize",
      installation: { id: INSTALLATION },
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: {
        number: 41, title: "Make the value two", state: "open", merged: false, draft: false,
        updated_at: "2026-03-07T10:00:00Z",
        base: { ref: "main", sha: BASE_TIP, repo: { id: REPO_ID, full_name: REPO } },
        head: { ref: "feature/reader", sha: FAULT, repo: { id: REPO_ID, full_name: REPO } },
      },
    };
    // The capture this delivery queues is held at its own open, so the counts below are
    // the delivery's own effects rather than its worker's enrichment as well.
    const gate = holdOpenAt(1);
    db.exec(
      "CREATE TRIGGER pr_observation_fault BEFORE INSERT ON review_pr_observations " +
        `WHEN NEW.head_sha = '${FAULT}' BEGIN SELECT RAISE(ABORT, 'observation write failed'); END;`,
    );
    try {
      const failed = await deliver("pull_request", payload, "delivery-observation-fault");
      expect(failed.status).toBe(500);

      // The whole transaction rolled back: no observation, no moved status row, and — the
      // point — no delivery id, so GitHub's retry is not answered as a duplicate.
      expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(observations);
      expect(statusOf()).toEqual(before);
      expect(count(
        "SELECT COUNT(*) AS n FROM github_deliveries WHERE delivery_id = ?", "delivery-observation-fault",
      )).toBe(0);
    } finally {
      db.exec("DROP TRIGGER pr_observation_fault;");
    }

    // And the retry, under the same delivery id, applies.
    const retried = await deliver("pull_request", payload, "delivery-observation-fault");
    expect([200, 202]).toContain(retried.status);
    expect((await retried.json() as any).duplicate).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(observations + 1);
    expect(latestObservation(workspace, lineage.id)!.head_sha).toBe(FAULT);
    expect(statusOf().head_sha).toBe(FAULT);

    // Let its capture run to whatever it becomes, so nothing is left in flight across the
    // rest of this file.
    gate.release();
    await settleCaptureJobs();
  });

  test("the orphan sweep keeps a status row a promoted review names, then lets it go", () => {
    expect(sweepOrphanPrStatus(workspace)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?", workspace, 41)).toBe(1);

    // A detach is the only thing that releases it, and detaching is what a later slice
    // adds; the sweep's rule is what is under test, so the row is stamped directly.
    const lineage = getLineage(workspace, "pr-direct")!;
    db.run("UPDATE review_lineage_prs SET detached_at = ? WHERE lineage_id = ?", [Date.now(), lineage.id]);
    expect(sweepOrphanPrStatus(workspace)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM github_pr_status WHERE workspace_id = ? AND pr_number = ?", workspace, 41)).toBe(0);
    db.run("UPDATE review_lineage_prs SET detached_at = NULL WHERE lineage_id = ?", [lineage.id]);
  });
});

// ---- who may read a review that has not captured yet ----

describe("a pending review is as private as a published one", () => {
  test("shells, capture jobs and every write stay private with auth enabled", async () => {
    // A lineage whose capture failed and was never retried: latest_revision is still
    // null, so its latest URL is the shell, and nothing reschedules it in the child. The
    // credential has to survive the observation and die before the capture — killing it
    // first would refuse the request itself with a 422 and never create the shell.
    const gate = holdOpenAt(2);
    resolvedActor = { kind: "user", userId: secondUser, credentialId: "guc_shellcred" };
    currentClient = githubFixture({ pullPayload: pull({ number: 90 }) });
    const created = await ingest({ repo: REPO, number: 90, slug: "pr-shell" }, "pr-shell-1", secondKey);
    expect(created.status).toBe(202);
    const shellJob = await created.json() as any;
    deadActors.set(`user:${secondUser}:guc_shellcred`, () =>
      new GithubCredentialDeadError("guc_shellcred", "The credential this review reads through is gone."));
    gate.release();
    await settleCaptureJobs();
    expect(getCaptureJob(workspace, shellJob.id)!.state).toBe("failed");
    expect(getLineage(workspace, "pr-shell")!.latest_revision).toBeNull();

    // The synthetic lane rows are not real work; leaving them behind would have the
    // child's startup recovery try to run them.
    db.run("DELETE FROM review_capture_jobs WHERE workspace_id = 'ws_lane00000'");

    const stranger = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [stranger, "pr-stranger@example.com", Date.now()]);
    const otherWorkspace = createWorkspace("Elsewhere", owner);
    const otherKey = mintApiKey(owner, otherWorkspace, "pr-lineage-elsewhere").token;

    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "pr-lineage-privacy.script.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AUTH_DISABLED: undefined as unknown as string,
        DATA_DIR: config.dataDir,
        PR_WORKSPACE: workspace,
        PR_SHELL_SLUG: "pr-shell",
        PR_SHELL_NUMBER: "90",
        PR_READY_SLUG: "pr-direct",
        PR_OWNER: owner,
        PR_MEMBER: secondUser,
        PR_STRANGER: stranger,
        PR_KEY: key,
        PR_OTHER_KEY: otherKey,
        PR_JOB: shellJob.id,
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

// ---- a failed capture is a decision, not a dead end ----

describe("a failed capture answers with the job", () => {
  test("the 409 carries the retry URL the document declares", async () => {
    // The same key and body as the shell above, whose capture failed: a replay is
    // answered from the stored operation, so no GitHub call is made to learn this.
    const conflict = await ingest({ repo: REPO, number: 90, slug: "pr-shell" }, "pr-shell-1", secondKey);
    expect(conflict.status).toBe(409);
    const body = await conflict.json() as any;
    validateResponse("createPullRequestReviewLineage", body, "409");
    expect(body.error).toContain("credential this review reads through is gone");
    expect(body.job.state).toBe("failed");
    expect(body.job.retryUrl).toBe(`${config.baseUrl}/api/review-capture-jobs/${body.job.id}/retry`);
    // The failure text names the credential as a thing, never as an id.
    expect(JSON.stringify(body)).not.toContain("guc_");
    expect(opened).toEqual([]);
  });
});

// ---- a project holds the review it was told to hold ----

describe("a project lists a review whose capture has not finished", () => {
  const projectUrl = () => `${base}/api/projects/pr-project`;

  test("the pending lineage is listed with its capture state, then with its revision", async () => {
    await fetch(`${base}/api/projects`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ slug: "pr-project", title: "Pull request project" }),
    });

    const gate = holdOpenAt(2);
    currentClient = githubFixture({ pullPayload: pull({ number: 49 }) });
    const created = await ingest(
      { repo: REPO, number: 49, slug: "pr-in-project", title: "In a project", projects: ["pr-project"] },
      "pr-in-project-1",
    );
    expect(created.status).toBe(202);

    // Direct ingestion attaches the shell to its projects at creation, so the project
    // holds it now — counting it and then dropping it for having no revision was the bug.
    const pending = await (await fetch(projectUrl(), { headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("readProject", pending);
    expect(pending.reviewLineages.map((entry: any) => entry.slug)).toEqual(["pr-in-project"]);
    const entry = pending.reviewLineages[0];
    expect(entry.latestRevision).toBeNull();
    expect(entry.revisionUrl).toBeNull();
    expect(entry.latestAccountVersion).toBeNull();
    expect(entry.captureState).toBe("running");
    expect(entry.url).toBe(`${config.baseUrl}/${workspace}/r/pr-in-project`);

    const page = visible(await (await fetch(`${base}/${workspace}/p/pr-project`, { headers: { cookie } })).text());
    expect(page).toContain("In a project");
    expect(page).toContain("capturing");
    expect(page).not.toContain("rev 1");

    gate.release();
    await settleCaptureJobs();

    // And once the capture lands, the entry is exactly the task-4 shape again.
    const done = await (await fetch(projectUrl(), { headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("readProject", done);
    const settled = done.reviewLineages[0];
    expect(settled.latestRevision).toBe(1);
    expect(settled.captureState).toBeNull();
    expect(settled.revisionUrl).toBe(`${config.baseUrl}/${workspace}/r/pr-in-project/rev/1`);

    const after = visible(await (await fetch(`${base}/${workspace}/p/pr-project`, { headers: { cookie } })).text());
    expect(after).toContain("rev 1");
    expect(after).not.toContain("capturing");
  });
});

// ---- rendering never reaches GitHub ----

describe("reading is retained bytes only", () => {
  test("every promoted page renders with a GitHub factory and router that throw", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    setReadRouter({
      async resolve(): Promise<never> { throw new Error("GitHub must not be routed while rendering"); },
      async open(): Promise<never> { throw new Error("GitHub must not be opened while rendering"); },
    });
    for (const path of [
      `/${workspace}/r/pr-direct`,
      `/${workspace}/r/pr-direct/rev/1`,
      `/${workspace}/r/pr-direct/rev/1?review=seam-1`,
      `/${workspace}/r/branch-first/rev/2`,
      `/${workspace}/r/pr-dead`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    installRouter();
  });
});
