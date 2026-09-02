import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { tinyId } from "../../src/ids";
import { startServer } from "../../src/server";
import { createReviewVersion, getReviewVersion } from "../../src/overseer/db";
import { setReadRouter, type ReadActor } from "../../src/overseer/github-app";
import type { GithubClient, GithubPull } from "../../src/overseer/github";
import { settleCaptureJobs } from "../../src/overseer/revision-jobs";
import {
  recoverLegacySuccessions,
  settleLegacySuccessions,
} from "../../src/overseer/legacy-successor-jobs";
import { getLegacySuccessionForReview } from "../../src/overseer/legacy-successor";
import { getLineage, getRevisionById } from "../../src/overseer/revision-db";
import { getLineagePr } from "../../src/overseer/revision-pr";
import { getStack, getStackManifest } from "../../src/overseer/stack-db";
import { goldenStoredDoc } from "./fixtures/stored-review";

const REPO = "Acme/Successor";
const REPO_ID = 8124;
const BASE = "1".repeat(40);

interface PullFacts {
  number: number;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let owner = "";
let workspace = "";
let key = "";
let sequence = 0;
const pulls = new Map<number, PullFacts>();
const forks = new Set<number>();
let opens: ReadActor[] = [];

function github(): GithubClient {
  return {
    async getPull(_repo, number) {
      const facts = pulls.get(number);
      if (!facts) throw new Error(`no pull fixture ${number}`);
      const baseRepo = { id: REPO_ID, full_name: REPO };
      const headRepo = forks.has(number) ? { id: REPO_ID + 1, full_name: "Fork/Successor" } : baseRepo;
      return {
        number,
        title: `Pull ${number}`,
        body: `Exact pull ${number}.`,
        state: "open",
        merged: false,
        draft: false,
        user: { login: "octocat" },
        head: { ref: facts.headRef, sha: facts.headSha, repo: headRepo },
        base: { ref: facts.baseRef, sha: facts.baseSha, repo: baseRepo },
        updated_at: "2026-08-31T00:00:00Z",
      } as GithubPull;
    },
    async listCommits() { return []; },
    async listFiles() { return []; },
    async listReviewComments() { return []; },
    async getFileAtSha() { throw new Error("not used"); },
    async getPullDiff() { return ""; },
    async getRepository() { return { id: REPO_ID, full_name: REPO, default_branch: "main" }; },
    async getRef(_repo, ref) { return { ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : "2".repeat(40), type: "commit" as const }; },
    async getTree(_repo, sha) { return { sha, truncated: false, tree: [] }; },
    async getBlobBytes() { throw new Error("empty trees have no blobs"); },
    async compare(_repo, baseSha) { return { merge_base_commit: { sha: baseSha }, files: [] }; },
    async compareDiff() { return ""; },
  };
}

beforeAll(async () => {
  setReadRouter({
    async resolve() { return { kind: "anonymous" }; },
    async open(_workspaceId, actor) { opens.push(actor); return github(); },
  });
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
});

beforeEach(() => {
  sequence += 1;
  workspace = createWorkspace(`Legacy successor ${sequence}`, owner);
  key = mintApiKey(owner, workspace, `legacy-successor-${sequence}`).token;
  pulls.clear();
  forks.clear();
  opens = [];
});

afterAll(() => server.stop(true));

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra };
}

function registerPull(number: number, baseRef = "main", baseSha = BASE): PullFacts {
  const facts = {
    number,
    baseRef,
    baseSha,
    headRef: `feature-${sequence}-${number}`,
    headSha: number.toString(16).padStart(40, String((sequence % 8) + 2)).slice(-40),
  };
  pulls.set(number, facts);
  return facts;
}

function legacy(slug: string, kind: "single" | "stack" | "set", numbers: number[]): void {
  const template = goldenStoredDoc();
  const prs = numbers.map((number, index) => {
    const facts = pulls.get(number)!;
    const original = template.prs[index % template.prs.length]!;
    return {
      ...original,
      repo: REPO,
      number,
      title: `Pull ${number}`,
      headSha: facts.headSha,
      baseSha: facts.baseSha,
      baseRef: facts.baseRef,
      parent: index === 0 ? null : numbers[index - 1]!,
    };
  });
  createReviewVersion(workspace, slug, { ...template, kind, prs, title: `Legacy ${slug}` });
}

async function createSuccessor(slug: string, body: unknown, idempotency = `successor-${sequence}-${slug}`): Promise<Response> {
  return fetch(`${base}/api/reviews/${slug}/successor`, {
    method: "POST",
    headers: auth({ "idempotency-key": idempotency }),
    body: JSON.stringify(body),
  });
}

async function state(slug: string): Promise<any> {
  const row = getLegacySuccessionForReview(workspace, slug)!;
  return (await (await fetch(`${base}/api/review-legacy-successions/${row.id}`, { headers: auth() })).json()) as any;
}

async function settleAll(): Promise<void> {
  await settleLegacySuccessions();
  await settleCaptureJobs();
  await settleLegacySuccessions();
}

const accountBody = {
  witness: { name: "Fresh witness", model: "test-model" },
  summary: "The exact retained revision contains no changed files.",
  groups: [{
    id: "empty-source",
    title: "No changed files",
    category: "Code",
    importance: "low",
    complexity: "low",
    explanation: "The pinned pull request compares to an empty retained tree.",
    examples: [],
    members: [],
  }],
  focus: [],
  evidence: [],
};

async function publishPendingMemberAccounts(): Promise<void> {
  const inventory = await (await fetch(`${base}/api/witness-requests`, { headers: auth() })).json() as any;
  for (const request of inventory.member) {
    const claim = await fetch(`${base}${new URL(request.claimUrl).pathname}`, { method: "POST", headers: auth() });
    expect(claim.status).toBe(200);
    const published = await fetch(
      `${base}/api/review-lineages/${request.slug}/revisions/${request.revision}/accounts`,
      { method: "POST", headers: auth(), body: JSON.stringify(accountBody) },
    );
    expect(published.status).toBe(200);
  }
  await settleLegacySuccessions();
}

describe("legacy review succession", () => {
  test("should create one exact lineage, keep legacy state, and replay without duplicate GitHub work", async () => {
    registerPull(101);
    legacy("legacy-single", "single", [101]);
    const annotation = tinyId("ann");
    db.run("INSERT INTO review_annotations VALUES (?, ?, 'legacy-single', 'summary', 'summary', NULL, 'Keep this question', 'open', NULL, 1, ?)", [annotation, workspace, Date.now()]);
    db.run("INSERT INTO review_reads VALUES (?, 'legacy-single', ?, 1, ?)", [workspace, owner, Date.now()]);
    db.run("INSERT INTO shares (id,workspace_id,kind,target,label,token_hash,created_by,created_at) VALUES (?,?,'review','legacy-single','legacy link',?,?,?)", [tinyId("shr"), workspace, `legacy-share-${sequence}`, owner, Date.now()]);

    const body = { kind: "single", lineageSlug: "single-successor" };
    const created = await createSuccessor("legacy-single", body);
    expect([200, 202]).toContain(created.status);
    await settleAll();
    const completed = await state("legacy-single");
    expect(completed).toMatchObject({ state: "completed", kind: "single", targetSlug: "single-successor", failure: null });
    expect(completed.result.url).toContain(`/${workspace}/r/single-successor`);
    const lineage = getLineage(workspace, "single-successor")!;
    expect(getLineagePr(workspace, lineage.id)).toMatchObject({ pr_number: 101, repo_id: REPO_ID });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_annotations WHERE workspace_id = ? AND slug = 'legacy-single'").get(workspace)!.n).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_reads WHERE workspace_id = ? AND slug = 'legacy-single'").get(workspace)!.n).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM shares WHERE workspace_id = ? AND target = 'legacy-single'").get(workspace)!.n).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM share_document_capabilities WHERE workspace_id = ?").get(workspace)!.n).toBe(0);
    expect(db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM review_threads WHERE workspace_id = ? AND lineage_id = ?").get(workspace, lineage.id)!.n).toBe(0);
    expect(getReviewVersion(workspace, "legacy-single", 1)!.doc.title).toBe("Legacy legacy-single");

    const counts = () => ({
      observations: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_pr_observations WHERE workspace_id = ?").get(workspace)!.n,
      jobs: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE workspace_id = ?").get(workspace)!.n,
      revisions: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ?").get(workspace)!.n,
      relations: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_lineage_prs WHERE workspace_id = ?").get(workspace)!.n,
    });
    const before = counts();
    const replay = await createSuccessor("legacy-single", body, "single-replay-new-key");
    expect(replay.status).toBe(200);
    await settleAll();
    expect(counts()).toEqual(before);
    expect((await replay.json() as any).id).toBe(completed.id);

    const legacyApi = await (await fetch(`${base}/api/reviews/legacy-single`, { headers: auth() })).json() as any;
    expect(new URL(legacyApi.successor.url).pathname).toBe(`/${workspace}/r/single-successor`);
    expect(new URL(legacyApi.successor.statusUrl).pathname).toBe(`/api/review-legacy-successions/${completed.id}`);
    const page = await fetch(`${base}/${workspace}/r/legacy-single`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Immutable successor");
    expect(html).toContain(`aria-label="Open immutable successor">open</a>`);
  });

  test("should build a valid exact stack only after fresh member witnesses publish", async () => {
    const bottom = registerPull(201);
    registerPull(202, bottom.headRef, bottom.headSha);
    legacy("legacy-stack", "stack", [201, 202]);
    const project = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ slug: "successor-project", title: "Successor project" }),
    });
    expect(project.status).toBe(200);
    const body = {
      kind: "stack",
      stackSlug: "immutable-stack",
      projects: ["successor-project"],
      members: [
        { pr: 201, lineageSlug: "stack-member-bottom" },
        { pr: 202, lineageSlug: "stack-member-top" },
      ],
    };
    expect((await createSuccessor("legacy-stack", body)).status).toBe(202);
    await settleAll();
    let pending = await state("legacy-stack");
    expect(pending.state).toBe("pending");
    expect(pending.result).toMatchObject({ url: null, pinnedUrl: null, stackId: null });
    expect(pending.members.map((member: any) => member.witness)).toEqual(["pending", "pending"]);
    expect(getStack(workspace, "immutable-stack")).toBeNull();
    const attemptsBeforeWaitingSweep = pending.attempts;
    recoverLegacySuccessions();
    await settleLegacySuccessions();
    pending = await state("legacy-stack");
    expect(pending.attempts).toBe(attemptsBeforeWaitingSweep);
    const pendingPage = await (await fetch(`${base}/${workspace}/r/legacy-stack`)).text();
    const pendingSuccessor = pendingPage.match(/<p class="meta successor">[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(pendingSuccessor).toContain("pending");
    expect(pendingSuccessor).not.toContain("<a ");

    await publishPendingMemberAccounts();
    await settleAll();
    const completed = await state("legacy-stack");
    expect(completed.state).toBe("completed");
    expect(completed.result.pinnedUrl).toContain(`/${workspace}/r-stacks/immutable-stack/v/1`);
    const stack = getStack(workspace, "immutable-stack")!;
    const manifest = getStackManifest(workspace, "immutable-stack", 1)!;
    expect(stack.source).toBe("inferred");
    expect(manifest.doc.members.map((member) => ({ pr: member.prNumber, slug: member.lineageSlug }))).toEqual([
      { pr: 201, slug: "stack-member-bottom" },
      { pr: 202, slug: "stack-member-top" },
    ]);
    expect(manifest.doc.members.every((member) => member.accountId !== null)).toBe(true);
    expect(manifest.doc.projects).toEqual(["successor-project"]);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM project_review_lineages WHERE workspace_id=? AND slug IN ('stack-member-bottom','stack-member-top')").get(workspace)!.n).toBe(2);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM project_review_stacks WHERE workspace_id=? AND slug='immutable-stack'").get(workspace)!.n).toBe(1);
    expect(completed.members.map((member: any) => member.state)).toEqual(["ready", "ready"]);
  });

  test("should amend only an unresolved stack target after a slug race and complete the same permanent workflow", async () => {
    const bottom = registerPull(211);
    registerPull(212, bottom.headRef, bottom.headSha);
    legacy("legacy-stack-race", "stack", [211, 212]);
    const members = [
      { pr: 211, lineageSlug: "race-bottom" },
      { pr: 212, lineageSlug: "race-top" },
    ];
    const originalBody = { kind: "stack", stackSlug: "raced-target", members };
    expect((await createSuccessor("legacy-stack-race", originalBody, "race-original-request")).status).toBe(202);
    await settleAll();
    const original = getLegacySuccessionForReview(workspace, "legacy-stack-race")!;

    const now = Date.now();
    db.run(
      "INSERT INTO review_stacks VALUES (?, ?, 'raced-target', 'Raced target', ?, ?, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)",
      [tinyId("rsk"), workspace, REPO, REPO_ID, owner, tinyId("key"), now, now],
    );
    await publishPendingMemberAccounts();
    await settleAll();
    const failed = await state("legacy-stack-race");
    expect(failed).toMatchObject({ state: "failed", result: { url: null, stackId: null } });
    expect(failed.failure).toContain("already names another stack");
    const failedReplay = await createSuccessor("legacy-stack-race", originalBody, "race-original-request");
    expect(failedReplay.status).toBe(409);
    expect(await failedReplay.json()).toMatchObject({ id: original.id, state: "failed" });

    const amendedBody = { kind: "stack", stackSlug: "recovered-target", members };
    const secondCreatorKey = mintApiKey(owner, workspace, "same creator, different key").token;
    const foreignAmendment = await fetch(`${base}/api/reviews/legacy-stack-race/successor`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondCreatorKey}`,
        "content-type": "application/json",
        "idempotency-key": "foreign-race-amendment",
      },
      body: JSON.stringify(amendedBody),
    });
    expect(foreignAmendment.status).toBe(403);
    expect(await foreignAmendment.json()).toMatchObject({ rule: "creator_required" });

    const amendment = await createSuccessor("legacy-stack-race", amendedBody, "owner-race-amendment");
    expect([200, 202]).toContain(amendment.status);
    const amendmentView = await amendment.json() as any;
    expect(amendmentView).toMatchObject({ id: original.id, targetSlug: "recovered-target" });
    expect(amendment.status === 200).toBe(amendmentView.state === "completed");
    await settleAll();
    expect(await state("legacy-stack-race")).toMatchObject({
      id: original.id,
      state: "completed",
      targetSlug: "recovered-target",
      result: { stackId: expect.stringMatching(/^rsk_/), url: expect.stringContaining("/r-stacks/recovered-target") },
    });
  });

  test("should verify a requested lineage slug owns the exact retained pull request before writing succession", async () => {
    registerPull(221);
    legacy("legacy-named-owner", "single", [221]);
    await createSuccessor("legacy-named-owner", { kind: "single", lineageSlug: "named-owner" });
    await settleAll();

    registerPull(222);
    legacy("legacy-named-conflict", "single", [222]);
    const conflict = await createSuccessor("legacy-named-conflict", { kind: "single", lineageSlug: "named-owner" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: expect.stringContaining(`${REPO}#221`),
      rule: "review_slug_taken",
    });
    expect(getLegacySuccessionForReview(workspace, "legacy-named-conflict")).toBeNull();
  });

  test("should refuse successor target and member slugs already owned by another review model", async () => {
    const bottom = registerPull(231);
    registerPull(232, bottom.headRef, bottom.headSha);
    legacy("legacy-successor-collisions", "stack", [231, 232]);
    createReviewVersion(workspace, "legacy-target-owner", goldenStoredDoc());

    const targetConflict = await createSuccessor("legacy-successor-collisions", {
      kind: "stack",
      stackSlug: "legacy-target-owner",
      members: [
        { pr: 231, lineageSlug: "collision-bottom" },
        { pr: 232, lineageSlug: "collision-top" },
      ],
    }, "successor-target-conflict");
    expect(targetConflict.status).toBe(409);
    expect(await targetConflict.json()).toMatchObject({ rule: "stack_slug_taken" });
    expect(getLegacySuccessionForReview(workspace, "legacy-successor-collisions")).toBeNull();

    const now = Date.now();
    db.run(
      "INSERT INTO review_stacks VALUES (?, ?, 'stack-member-owner', 'Member owner', ?, ?, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)",
      [tinyId("rsk"), workspace, REPO, REPO_ID, owner, tinyId("key"), now, now],
    );
    const memberConflict = await createSuccessor("legacy-successor-collisions", {
      kind: "stack",
      stackSlug: "free-successor-target",
      members: [
        { pr: 231, lineageSlug: "stack-member-owner" },
        { pr: 232, lineageSlug: "free-collision-top" },
      ],
    }, "successor-member-conflict");
    expect(memberConflict.status).toBe(409);
    expect(await memberConflict.json()).toMatchObject({ rule: "review_slug_taken" });
    expect(getLegacySuccessionForReview(workspace, "legacy-successor-collisions")).toBeNull();
  });

  test("should recover persisted member progress after an expired lease without duplication", async () => {
    const bottom = registerPull(301);
    registerPull(302, bottom.headRef, bottom.headSha);
    legacy("legacy-crash", "stack", [301, 302]);
    await createSuccessor("legacy-crash", {
      kind: "stack",
      stackSlug: "crash-stack",
      members: [
        { pr: 301, lineageSlug: "crash-bottom" },
        { pr: 302, lineageSlug: "crash-top" },
      ],
    });
    await settleAll();
    const succession = getLegacySuccessionForReview(workspace, "legacy-crash")!;
    const before = {
      relations: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_lineage_prs WHERE workspace_id = ?").get(workspace)!.n,
      jobs: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE workspace_id = ?").get(workspace)!.n,
      revisions: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ?").get(workspace)!.n,
    };
    const second = db.query<{ lineage_id: string; capture_job_id: string; revision_id: string }, [string]>(
      "SELECT lineage_id, capture_job_id, revision_id FROM review_legacy_succession_members WHERE succession_id = ? AND position = 2",
    ).get(succession.id)!;
    db.run("UPDATE review_legacy_succession_members SET lineage_id=NULL,capture_job_id=NULL,revision_id=NULL,account_id=NULL WHERE succession_id=? AND position=2", [succession.id]);
    db.run("UPDATE review_legacy_successions SET state='running',lease_token='lse_abandoned',lease_expires_at=?,updated_at=? WHERE id=?", [Date.now() - 1, Date.now() - 1, succession.id]);

    expect(recoverLegacySuccessions()).toBe(1);
    await settleAll();
    const restored = db.query<{ lineage_id: string; capture_job_id: string; revision_id: string }, [string]>(
      "SELECT lineage_id, capture_job_id, revision_id FROM review_legacy_succession_members WHERE succession_id = ? AND position = 2",
    ).get(succession.id)!;
    expect(restored).toEqual(second);
    expect({
      relations: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_lineage_prs WHERE workspace_id = ?").get(workspace)!.n,
      jobs: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE workspace_id = ?").get(workspace)!.n,
      revisions: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revisions WHERE workspace_id = ?").get(workspace)!.n,
    }).toEqual(before);
  });

  test("should adopt only the requested owning lineage and fail visibly for another owner", async () => {
    registerPull(401);
    legacy("legacy-owner-first", "single", [401]);
    await createSuccessor("legacy-owner-first", { kind: "single", lineageSlug: "owned-lineage" });
    await settleAll();
    const ownerLineage = getLineage(workspace, "owned-lineage")!;

    legacy("legacy-owner-adopt", "single", [401]);
    await createSuccessor("legacy-owner-adopt", { kind: "single", lineageSlug: "owned-lineage" });
    await settleAll();
    expect((await state("legacy-owner-adopt"))).toMatchObject({ state: "completed", result: { lineageId: ownerLineage.id } });

    legacy("legacy-owner-conflict", "single", [401]);
    const conflict = await createSuccessor("legacy-owner-conflict", { kind: "single", lineageSlug: "different-lineage" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: expect.stringContaining("already reviewed"),
      rule: "pull_request_owned",
    });
    expect(getLegacySuccessionForReview(workspace, "legacy-owner-conflict")).toBeNull();
    expect(getLineage(workspace, "different-lineage")).toBeNull();
  });

  test("should defer a private fork, bind retries to the creator, and resume after the cause is fixed", async () => {
    registerPull(501);
    forks.add(501);
    legacy("legacy-fork", "single", [501]);
    await createSuccessor("legacy-fork", { kind: "single", lineageSlug: "fork-successor" });
    await settleLegacySuccessions();
    let failed = await state("legacy-fork");
    expect(failed.state).toBe("failed");
    expect(failed.failure).toContain("opened from a fork");
    expect(failed.result).toMatchObject({ url: null, pinnedUrl: null, lineageId: null });
    expect(getLineage(workspace, "fork-successor")).toBeNull();

    const other = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [other, `fork-${sequence}@example.com`, Date.now()]);
    db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, other, Date.now()]);
    const otherKey = mintApiKey(other, workspace, "foreign retry").token;
    const row = getLegacySuccessionForReview(workspace, "legacy-fork")!;
    const foreign = await fetch(`${base}/api/review-legacy-successions/${row.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${otherKey}` } });
    expect(foreign.status).toBe(403);

    forks.delete(501);
    const retried = await fetch(`${base}/api/review-legacy-successions/${row.id}/retry`, { method: "POST", headers: auth() });
    expect(retried.status).toBe(202);
    await settleAll();
    failed = await state("legacy-fork");
    expect(failed.state).toBe("completed");
  });

  test("should normalize a shuffled legacy pointer list from its stored parent chain", async () => {
    const bottom = registerPull(605);
    registerPull(606, bottom.headRef, bottom.headSha);
    legacy("legacy-shuffled", "stack", [605, 606]);
    const stored = getReviewVersion(workspace, "legacy-shuffled", 1)!;
    stored.doc.prs = [stored.doc.prs[1]!, stored.doc.prs[0]!];
    db.run("UPDATE review_versions SET doc=? WHERE workspace_id=? AND slug='legacy-shuffled' AND version=1", [JSON.stringify(stored.doc), workspace]);

    const created = await createSuccessor("legacy-shuffled", {
      kind: "stack",
      stackSlug: "shuffled-stack",
      members: [
        { pr: 605, lineageSlug: "shuffled-bottom" },
        { pr: 606, lineageSlug: "shuffled-top" },
      ],
    });
    expect(created.status).toBe(202);
    await settleAll();
    const pending = await state("legacy-shuffled");
    expect(pending.state).toBe("pending");
    expect(pending.members.map((member: any) => member.pullRequest)).toEqual([605, 606]);
  });

  test("should reject unrelated sets and mismatched stack order without writing workflow state", async () => {
    registerPull(601);
    registerPull(602);
    legacy("legacy-set", "set", [601, 602]);
    const set = await createSuccessor("legacy-set", { kind: "set" });
    expect(set.status).toBe(422);
    expect(await set.json()).toMatchObject({
      error: expect.stringContaining("unrelated legacy review set"),
      rule: "unsupported_source",
    });
    expect(getLegacySuccessionForReview(workspace, "legacy-set")).toBeNull();

    const bottom = registerPull(603);
    registerPull(604, bottom.headRef, bottom.headSha);
    legacy("legacy-order", "stack", [603, 604]);
    const mismatch = await createSuccessor("legacy-order", {
      kind: "stack",
      stackSlug: "wrong-order",
      members: [
        { pr: 604, lineageSlug: "wrong-top" },
        { pr: 603, lineageSlug: "wrong-bottom" },
      ],
    });
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({
      error: expect.stringContaining("stored at that position"),
      rule: "source_members_mismatch",
    });
    expect(getLegacySuccessionForReview(workspace, "legacy-order")).toBeNull();
  });
});
