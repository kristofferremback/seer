import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db";
import { generateKey, setKeyring } from "../../src/envelope";
import { migrate } from "../../src/migrate";
import { tinyId } from "../../src/ids";
import { createGithubUserCredential } from "../../src/overseer/user-credentials";
import {
  GithubGraphqlPermissionError,
  GithubGraphqlShapeError,
  GithubGraphqlTransportError,
  setPersonalGithubGraphqlClientFactory,
  type PersonalGithubGraphqlClient,
  type RecoveryResult,
} from "../../src/overseer/github-graphql";
import {
  appendGithubResolution,
  appendGithubThreadReply,
  createGithubReviewSubmission,
  createGithubThreadSubmission,
  getGithubSubmission,
  retryGithubSubmission,
  runNextGithubSubmission,
  GithubSubmissionError,
} from "../../src/overseer/github-submissions";
import { appendResolutionEvent, createLocalThread, getLocalThread, localThreadState, projectLocalThread } from "../../src/overseer/thread-db";
import { getLocalGithubThread, githubThreadProjectionState, mergeMappedGithubConversation } from "../../src/overseer/github-thread-sync";
import { recordGithubCommentWebhook, recordGithubReviewWebhook, recordGithubThreadWebhook } from "../../src/overseer/conversation-import";
import { createConversationReadContext, listImportedReviews, listImportedThreads } from "../../src/overseer/conversation-read";
import { getLineage, getRevision } from "../../src/overseer/revision-db";
import { githubThreadActionsForReader } from "../../src/overseer/github-projection-read";
import { getStageCaptureForWorkspaces } from "../../src/stage/db";

let sequence = 0;
const clients = new Map<string, PersonalGithubGraphqlClient>();
const opened: { userId: string; credentialId: string }[] = [];
const fixed = (value: string) => value.repeat(40).slice(0, 40);

beforeAll(() => {
  setKeyring({ activeId: "submissions", keys: new Map([["submissions", Buffer.from(generateKey(), "base64")]]) });
  migrate();
  setPersonalGithubGraphqlClientFactory((userId, credentialId) => {
    opened.push({ userId, credentialId });
    const client = clients.get(credentialId);
    if (!client) throw new Error(`No fake personal client for ${credentialId}`);
    return client;
  });
});

interface Fixture {
  workspaceId: string;
  userId: string;
  credentialId: string;
  lineageId: string;
  revisionId: string;
  threadId: string;
  fileId: string;
  changeId: string;
  head: string;
  slug: string;
}

function fixture(): Fixture {
  sequence += 1;
  const workspaceId = tinyId("ws"), userId = tinyId("usr"), lineageId = tinyId("rln");
  const revisionId = tinyId("rvr"), captureId = tinyId("stg"), fileId = tinyId("stf");
  const slug = `github-submission-${sequence}`;
  const changeId = `chg_${sequence.toString(16).padStart(64, "0")}`;
  const head = sequence.toString(16).padStart(40, "a").slice(-40), base = fixed("b");
  const credentialId = createGithubUserCredential({ userId, kind: "pat", label: "work", secret: `submission-token-${sequence}`, accountLogin: `octocat-${sequence}`, accountId: sequence, scopes: [], expiresAt: Date.now() + 60_000 });
  db.run("INSERT INTO workspaces VALUES (?,?,'private',?)", [workspaceId, `Submissions ${sequence}`, Date.now()]);
  db.run("INSERT INTO users VALUES (?,?,?)", [userId, `submissions-${sequence}@example.com`, Date.now()]);
  db.run("INSERT INTO memberships VALUES (?,?,?)", [workspaceId, userId, Date.now()]);
  db.run("INSERT INTO review_lineages VALUES (?,?,?,'Acme/Submissions',91,'feature','main',?,'GitHub submissions',1,NULL,?,?,?,?)", [lineageId, workspaceId, slug, base, userId, tinyId("key"), Date.now(), Date.now()]);
  db.run("INSERT INTO stage_captures VALUES (?,?,?,'Acme/Submissions',91,'feature','main',?,?,?,NULL,'completed',?)", [captureId, workspaceId, slug, head, base, base, Date.now()]);
  db.run("INSERT INTO stage_capture_files VALUES (?,?,?,'src/value.ts',NULL,'modified',?,?, '100644','100644','blob','blob',1,1,'retained','retained',NULL,NULL,NULL,NULL)", [fileId, workspaceId, captureId, fixed("c"), fixed("d")]);
  db.run("INSERT INTO stage_capture_changes VALUES (?,?,?,?,4,2,4,2,?,?,?,'patch')", [changeId, workspaceId, captureId, fileId, "e".repeat(64), "f".repeat(64), "1".repeat(64)]);
  const doc = { identity: { lineageId, slug, revision: 1, title: "GitHub submissions", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Submissions", repoId: 91, branch: "feature", originalBaseRef: "main", originalBaseSha: base, baseRef: "main", sourceHeadSha: head, baseTipSha: base, mergeBaseSha: base }, builder: null, projects: [] };
  db.run("INSERT INTO review_revisions VALUES (?,?,?,?,1,?,1,?,?,?)", [revisionId, workspaceId, lineageId, slug, captureId, JSON.stringify(doc), `digest-${sequence}`, Date.now()]);
  db.run("INSERT INTO review_lineage_prs VALUES (?,?,?,91,'Acme/Submissions',31,'feature','main','user',NULL,?,?,?,NULL)", [lineageId, workspaceId, slug, userId, credentialId, Date.now()]);
  const observationId = tinyId("pob");
  db.run("INSERT INTO review_pr_observations VALUES (?,?,?,91,'Acme/Submissions',31,'GitHub submissions','open',0,0,'main',?,'feature',?,?,?,?,'user',NULL,?,?,?)", [observationId, workspaceId, lineageId, base, head, base, Date.now(), Date.now(), userId, credentialId, `observation-${sequence}`]);
  db.run("INSERT INTO review_revision_sources VALUES (?,?,?,?,?,?,?,?)", [revisionId, workspaceId, lineageId, observationId, base, head, base, Date.now()]);
  const thread = createLocalThread({
    workspaceId,
    scopeKind: "lineage",
    scopeId: lineageId,
    anchor: { workspace_id: workspaceId, anchor_kind: "change", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: changeId, file_id: fileId, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: "f".repeat(64), object_digest: null },
    body: "Please inspect this exact change.",
    author: { kind: "member", userId },
    idempotencyKey: `create-${sequence}`,
  });
  return { workspaceId, userId, credentialId, lineageId, revisionId, threadId: thread.thread.id, fileId, changeId, head, slug };
}

interface FakeOptions {
  head: () => string;
  afterMutation?: () => void;
  addReview?: () => Promise<{ reviewId: string; commentNodeIds: string[] }>;
  recover?: () => Promise<RecoveryResult>;
  calls?: { kind: string; input?: unknown }[];
}

function fake(input: FakeOptions): PersonalGithubGraphqlClient {
  const calls = input.calls ?? [];
  const suffix = String(sequence);
  return {
    async pullRequest() { return { id: "PR_31", headRefOid: input.head(), files: [], filesTruncated: false, rate: { limit: 5000, cost: 1, remaining: 4999, resetAt: Date.now() + 60_000, used: 1 } }; },
    async markFileAsViewed() { throw new Error("not used"); },
    async unmarkFileAsViewed() { throw new Error("not used"); },
    async addReview(value) { calls.push({ kind: "review", input: value }); const result = input.addReview ? await input.addReview() : { reviewId: `PRR_${suffix}`, commentNodeIds: value.event === "COMMENT" ? [`PRRC_${suffix}`] : [] }; input.afterMutation?.(); return result; },
    async addThreadReply(threadId, body, clientMutationId) { calls.push({ kind: "reply", input: { threadId, body, clientMutationId } }); input.afterMutation?.(); return { commentNodeId: `PRRC_REPLY_${suffix}`, databaseId: `900719925474${suffix.padStart(4, "0")}` }; },
    async resolveThread(threadId, clientMutationId) { calls.push({ kind: "resolve", input: { threadId, clientMutationId } }); input.afterMutation?.(); },
    async unresolveThread(threadId, clientMutationId) { calls.push({ kind: "unresolve", input: { threadId, clientMutationId } }); input.afterMutation?.(); },
    async findReviewThreadByComment() { return `PRRT_${suffix}`; },
    async recoverReview() { return input.recover ? input.recover() : { kind: "none" }; },
  };
}

async function run(credentialId: string): Promise<void> {
  while (await runNextGithubSubmission(credentialId)) {}
}

describe("explicit GitHub submissions", () => {
  test("should publish one commit-pinned local thread exactly once across replay", async () => {
    const f = fixture();
    const calls: { kind: string; input?: any }[] = [];
    clients.set(f.credentialId, fake({ head: () => f.head, calls }));
    const first = createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    const replay = createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    expect({ first: first.created, replay: replay.created, id: replay.row.id }).toEqual({ first: true, replay: false, id: first.row.id });
    await run(f.credentialId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ commitOID: f.head, event: "COMMENT", threads: [{ path: "src/value.ts", line: 5, side: "RIGHT", startLine: 4, startSide: "RIGHT", body: "Please inspect this exact change." }] });
    expect(getGithubSubmission(first.row.id)?.state).toBe("submitted");
    expect(getLocalGithubThread(f.workspaceId, f.threadId)).toMatchObject({ github_review_id: "PRR_1", github_thread_id: "PRRT_1", github_first_comment_id: "PRRC_1", commit_sha: f.head });
    expect(opened.at(-1)).toEqual({ userId: f.userId, credentialId: f.credentialId });
  });

  test("should use the current path for a left-side renamed-file thread", async () => {
    const f = fixture();
    db.run("UPDATE stage_capture_files SET path='src/new-value.ts',old_path='src/old-value.ts',status='renamed' WHERE id=?", [f.fileId]);
    db.run("UPDATE stage_capture_changes SET old_start=8,old_lines=2,new_start=8,new_lines=0 WHERE capture_id=(SELECT capture_id FROM review_revisions WHERE id=?) AND id=?", [f.revisionId, f.changeId]);
    const calls: { kind: string; input?: any }[] = [];
    clients.set(f.credentialId, fake({ head: () => f.head, calls }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    expect(calls[0]!.input.threads).toEqual([{ path: "src/new-value.ts", line: 9, side: "LEFT", startLine: 8, startSide: "LEFT", body: "Please inspect this exact change." }]);
  });

  test("should refuse and hide unchanged or non-hunk anchors without changing the local thread", () => {
    const f = fixture();
    const digest = "d".repeat(64);
    db.run("UPDATE stage_capture_files SET new_blob_sha=? WHERE id=?", [digest, f.fileId]);
    const makeRange = (rangeKind: "changed" | "unchanged", line: number, key: string) => createLocalThread({
      workspaceId: f.workspaceId,
      scopeKind: "lineage",
      scopeId: f.lineageId,
      anchor: { workspace_id: f.workspaceId, anchor_kind: "range", lineage_id: f.lineageId, revision_id: f.revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: f.fileId, side: "new", start_line: line, end_line: line, range_kind: rangeKind, old_object_digest: null, new_object_digest: null, object_digest: digest },
      body: "Keep this local",
      author: { kind: "member", userId: f.userId },
      idempotencyKey: key,
    });
    const unchanged = makeRange("unchanged", 4, `unchanged-${sequence}`);
    const outside = makeRange("changed", 100, `outside-${sequence}`);
    for (const thread of [unchanged, outside]) {
      const before = thread.entries;
      try {
        createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: thread.thread.id });
        throw new Error("expected out-of-diff refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(GithubSubmissionError);
        expect((error as GithubSubmissionError).rule).toBe("github_anchor_out_of_diff");
        expect((error as Error).message).toContain("current diff");
      }
      expect(getLocalThread(f.workspaceId, thread.thread.id)!.entries).toEqual(before);
    }
    const lineage = getLineage(f.workspaceId, f.slug)!;
    const revision = getRevision(f.workspaceId, f.slug, 1)!;
    const projected = [unchanged, outside].map((thread) => projectLocalThread(thread, f.userId));
    const inventory = getStageCaptureForWorkspaces(revision.capture_id, [f.workspaceId])!;
    const actions = githubThreadActionsForReader({ workspaceId: f.workspaceId, lineage, revision, inventory, userId: f.userId, threads: projected });
    expect([...actions.values()].map((action) => action.publishAction)).toEqual([null, null]);
  });

  test("should load one capture inventory for many reader thread draft checks", () => {
    const f = fixture();
    const threads = Array.from({ length: 24 }, (_, index) => createLocalThread({
      workspaceId: f.workspaceId,
      scopeKind: "lineage",
      scopeId: f.lineageId,
      anchor: { workspace_id: f.workspaceId, anchor_kind: "change", lineage_id: f.lineageId, revision_id: f.revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: f.changeId, file_id: f.fileId, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: "f".repeat(64), object_digest: null },
      body: `Reader draft ${index}`,
      author: { kind: "member", userId: f.userId },
      idempotencyKey: `reader-draft-${sequence}-${index}`,
    }));
    const lineage = getLineage(f.workspaceId, f.slug)!;
    const revision = getRevision(f.workspaceId, f.slug, 1)!;
    const query = spyOn(db, "query");
    try {
      const inventory = getStageCaptureForWorkspaces(revision.capture_id, [f.workspaceId])!;
      const actions = githubThreadActionsForReader({ workspaceId: f.workspaceId, lineage, revision, inventory, userId: f.userId, threads: threads.map((thread) => projectLocalThread(thread, f.userId)) });
      expect([...actions.values()].every((action) => action.publishAction !== null)).toBe(true);
      const captureQueries = query.mock.calls.filter(([sql]) => typeof sql === "string" && /\bstage_capture(?:s|_builders|_files|_changes|_incomplete)\b/.test(sql));
      expect(captureQueries).toHaveLength(5);
    } finally {
      query.mockRestore();
    }
  });

  test("should recover one exact uncertain thread and refuse an ambiguous duplicate", async () => {
    const adopted = fixture();
    let fail = true;
    clients.set(adopted.credentialId, fake({ head: () => adopted.head, addReview: async () => {
      if (fail) throw new GithubGraphqlTransportError("socket closed", true);
      return { reviewId: "unexpected", commentNodeIds: ["unexpected"] };
    }, recover: async () => ({ kind: "match", reviewId: "PRR_RECOVERED", commentNodeId: "PRRC_RECOVERED", threadId: "PRRT_RECOVERED" }) }));
    const submission = createGithubThreadSubmission({ workspaceId: adopted.workspaceId, lineageId: adopted.lineageId, revisionId: adopted.revisionId, userId: adopted.userId, credentialId: adopted.credentialId, localThreadId: adopted.threadId }).row;
    await run(adopted.credentialId);
    expect(getGithubSubmission(submission.id)?.state).toBe("unknown");
    fail = false;
    retryGithubSubmission({ workspaceId: adopted.workspaceId, lineageId: adopted.lineageId, userId: adopted.userId, submissionId: submission.id });
    await run(adopted.credentialId);
    expect(getGithubSubmission(submission.id)?.state).toBe("submitted");
    expect(getLocalGithubThread(adopted.workspaceId, adopted.threadId)?.github_thread_id).toBe("PRRT_RECOVERED");

    const ambiguous = fixture();
    clients.set(ambiguous.credentialId, fake({ head: () => ambiguous.head, addReview: async () => { throw new GithubGraphqlTransportError("timeout", true); }, recover: async () => ({ kind: "ambiguous", matches: 2 }) }));
    const row = createGithubThreadSubmission({ workspaceId: ambiguous.workspaceId, lineageId: ambiguous.lineageId, revisionId: ambiguous.revisionId, userId: ambiguous.userId, credentialId: ambiguous.credentialId, localThreadId: ambiguous.threadId }).row;
    await run(ambiguous.credentialId);
    retryGithubSubmission({ workspaceId: ambiguous.workspaceId, lineageId: ambiguous.lineageId, userId: ambiguous.userId, submissionId: row.id });
    await run(ambiguous.credentialId);
    expect(getGithubSubmission(row.id)).toMatchObject({ state: "unknown", failure_code: "recovery_ambiguous" });
    expect(getLocalGithubThread(ambiguous.workspaceId, ambiguous.threadId)).toBeNull();
  });

  test("should append local reply and resolution with durable GitHub work while local-only writes stay local", async () => {
    const f = fixture();
    const calls: { kind: string; input?: unknown }[] = [];
    let liveHead = f.head;
    clients.set(f.credentialId, fake({ head: () => liveHead, calls }));
    const initial = createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId }).row;
    await run(f.credentialId);
    expect({ state: getGithubSubmission(initial.id)?.state, mapping: getLocalGithubThread(f.workspaceId, f.threadId)?.github_thread_id ?? null, failure: getGithubSubmission(initial.id)?.failure }).toEqual({ state: "submitted", mapping: `PRRT_${sequence}`, failure: null });
    const before = getLocalThread(f.workspaceId, f.threadId)!.entries.length;
    // An ordinary local reply has no submission side effect.
    const { appendLocalReply } = await import("../../src/overseer/thread-db");
    appendLocalReply({ workspaceId: f.workspaceId, threadId: f.threadId, body: "Here only", author: { kind: "member", userId: f.userId }, idempotencyKey: `local-${sequence}` });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_submissions WHERE local_thread_id=?").get(f.threadId)?.n).toBe(1);
    liveHead = fixed("7");
    const reply = appendGithubThreadReply({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, body: "Here and GitHub", idempotencyKey: `github-reply-${sequence}`, author: { kind: "member", userId: f.userId } });
    expect(getLocalThread(f.workspaceId, f.threadId)!.entries.length).toBe(before + 2);
    expect(reply.row.state).toBe("pending");
    await run(f.credentialId);
    const resolution = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "resolved", idempotencyKey: `github-resolve-${sequence}` });
    const resolutionRow = resolution.row!;
    expect(getLocalThread(f.workspaceId, f.threadId)!.entries.at(-1)?.kind).toBe("resolved");
    await run(f.credentialId);
    expect(getGithubSubmission(reply.row.id)?.state).toBe("submitted");
    expect(getGithubSubmission(resolutionRow.id)?.state).toBe("submitted");
    expect(calls.map((call) => call.kind)).toEqual(["review", "reply", "resolve"]);
    expect(db.query("SELECT 1 AS one FROM review_local_github_message_links WHERE local_message_id=?").get(reply.row.local_entry_id!)).toEqual({ one: 1 });
    expect(db.query("SELECT 1 AS one FROM review_local_github_resolution_links WHERE submission_id=?").get(resolutionRow.id)).toEqual({ one: 1 });
    expect(getGithubSubmission(initial.id)?.state).toBe("submitted");
  });

  test("should keep an explicit local reply authoritative when GitHub refuses projection", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const denied = fake({ head: () => f.head });
    clients.set(f.credentialId, { ...denied, async addThreadReply() { throw new GithubGraphqlPermissionError("reply permission refused"); } });
    const reply = appendGithubThreadReply({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, body: "Local reply survives", idempotencyKey: `denied-reply-${sequence}`, author: { kind: "member", userId: f.userId } });
    await run(f.credentialId);
    expect(getGithubSubmission(reply.row.id)).toMatchObject({ state: "refused", failure_code: "permission_refused" });
    expect(getLocalThread(f.workspaceId, f.threadId)!.entries.at(-1)?.body).toBe("Local reply survives");
  });

  test("should keep one local resolution event when projection is bound to another actor", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `actor-resolution-open-${sequence}`, sourceAt: Date.now(), nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9501", resolved: false });
    const first = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "resolved", idempotencyKey: `actor-resolution-first-${sequence}` }).row!;
    appendResolutionEvent({ workspaceId: f.workspaceId, threadId: f.threadId, state: "open", author: { kind: "member", userId: f.userId }, idempotencyKey: `actor-resolution-local-reopen-${sequence}` });

    const otherUserId = tinyId("usr");
    db.run("INSERT INTO users VALUES (?,?,?)", [otherUserId, `other-resolution-${sequence}@example.com`, Date.now()]);
    db.run("INSERT INTO memberships VALUES (?,?,?)", [f.workspaceId, otherUserId, Date.now()]);
    const otherCredentialId = createGithubUserCredential({ userId: otherUserId, kind: "pat", label: "other actor", secret: `other-actor-${sequence}`, accountLogin: `other-${sequence}`, accountId: 300_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    const key = `actor-resolution-conflict-${sequence}`;
    const attempt = () => appendGithubResolution({ workspaceId: f.workspaceId, userId: otherUserId, credentialId: otherCredentialId, localThreadId: f.threadId, state: "resolved", idempotencyKey: key });
    for (let replay = 0; replay < 2; replay++) {
      try {
        attempt();
        throw new Error("expected actor conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(GithubSubmissionError);
        expect(error).toMatchObject({ rule: "actor_immutable", status: 409 });
      }
    }
    const local = getLocalThread(f.workspaceId, f.threadId)!;
    expect(localThreadState(local)).toBe("resolved");
    expect(local.entries.map((entry) => entry.kind)).toEqual(["message", "resolved", "reopened", "resolved"]);
    expect(local.entries.at(-1)).toMatchObject({ author_kind: "member", user_id: otherUserId });
    expect(db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM review_thread_idempotency WHERE workspace_id=? AND idempotency_key=?").get(f.workspaceId, key)?.n).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_submissions WHERE local_thread_id=? AND kind='resolve'").get(f.threadId)?.n).toBe(1);
    expect(getGithubSubmission(first.id)?.credential_id).toBe(f.credentialId);
  });

  test("should adopt exactly one matching imported reply and leave ambiguity unknown", async () => {
    const adopted = fixture();
    clients.set(adopted.credentialId, fake({ head: () => adopted.head }));
    createGithubThreadSubmission({ workspaceId: adopted.workspaceId, lineageId: adopted.lineageId, revisionId: adopted.revisionId, userId: adopted.userId, credentialId: adopted.credentialId, localThreadId: adopted.threadId });
    await run(adopted.credentialId);
    const adoptedMapping = getLocalGithubThread(adopted.workspaceId, adopted.threadId)!;
    clients.set(adopted.credentialId, { ...fake({ head: () => adopted.head }), async addThreadReply() { throw new GithubGraphqlTransportError("reply response lost", true); } });
    const reply = appendGithubThreadReply({ workspaceId: adopted.workspaceId, userId: adopted.userId, credentialId: adopted.credentialId, localThreadId: adopted.threadId, body: "Uncertain\nreply", idempotencyKey: `unknown-reply-${sequence}`, author: { kind: "member", userId: adopted.userId } });
    await run(adopted.credentialId);
    expect(getGithubSubmission(reply.row.id)?.state).toBe("unknown");
    const importedThread = recordGithubThreadWebhook({ workspaceId: adopted.workspaceId, lineageId: adopted.lineageId, repoId: 91, prNumber: 31, sourceId: `unknown-thread-${sequence}`, sourceAt: Date.now(), nodeId: adoptedMapping.github_thread_id, firstCommentDatabaseId: "7001", resolved: false });
    recordGithubCommentWebhook({ workspaceId: adopted.workspaceId, threadId: importedThread, sourceId: `unknown-comment-${sequence}`, sourceAt: Date.now(), databaseId: "7001", nodeId: `PRRC_ADOPT_${sequence}`, createdAt: Date.now(), updatedAt: Date.now(), authorLogin: `OCTOCAT-${sequence}`, body: "  Uncertain\r\nreply  ", githubUrl: null, deleted: false });
    expect(getGithubSubmission(reply.row.id)).toMatchObject({ state: "submitted", github_comment_id: `PRRC_ADOPT_${sequence}` });
    expect(db.query<{ direction: string; local_message_id: string; imported_comment_id: string }, [string]>("SELECT direction,local_message_id,imported_comment_id FROM review_local_github_message_links WHERE github_comment_id=?").get(`PRRC_ADOPT_${sequence}`)).toMatchObject({ direction: "out", local_message_id: reply.row.local_entry_id });
    const adoptedImported = await listImportedThreads(adopted.workspaceId, getLineage(adopted.workspaceId, adopted.slug)!);
    const adoptedProjected = mergeMappedGithubConversation(adopted.workspaceId, adopted.lineageId, [projectLocalThread(getLocalThread(adopted.workspaceId, adopted.threadId)!, adopted.userId)], adoptedImported);
    expect(adoptedProjected.local[0]!.entries.map((entry) => entry.body)).toEqual(["Please inspect this exact change.", "Uncertain\nreply"]);

    const ambiguous = fixture();
    clients.set(ambiguous.credentialId, fake({ head: () => ambiguous.head }));
    createGithubThreadSubmission({ workspaceId: ambiguous.workspaceId, lineageId: ambiguous.lineageId, revisionId: ambiguous.revisionId, userId: ambiguous.userId, credentialId: ambiguous.credentialId, localThreadId: ambiguous.threadId });
    await run(ambiguous.credentialId);
    const ambiguousMapping = getLocalGithubThread(ambiguous.workspaceId, ambiguous.threadId)!;
    clients.set(ambiguous.credentialId, { ...fake({ head: () => ambiguous.head }), async addThreadReply() { throw new GithubGraphqlTransportError("reply response lost", true); } });
    const unknowns = [1, 2].map((index) => appendGithubThreadReply({ workspaceId: ambiguous.workspaceId, userId: ambiguous.userId, credentialId: ambiguous.credentialId, localThreadId: ambiguous.threadId, body: "Same reply", idempotencyKey: `ambiguous-reply-${sequence}-${index}`, author: { kind: "member", userId: ambiguous.userId } }));
    await run(ambiguous.credentialId);
    const ambiguousThread = recordGithubThreadWebhook({ workspaceId: ambiguous.workspaceId, lineageId: ambiguous.lineageId, repoId: 91, prNumber: 31, sourceId: `ambiguous-thread-${sequence}`, sourceAt: Date.now(), nodeId: ambiguousMapping.github_thread_id, firstCommentDatabaseId: "8001", resolved: false });
    recordGithubCommentWebhook({ workspaceId: ambiguous.workspaceId, threadId: ambiguousThread, sourceId: `ambiguous-comment-${sequence}`, sourceAt: Date.now(), databaseId: "8001", nodeId: `PRRC_AMBIGUOUS_${sequence}`, createdAt: Date.now(), updatedAt: Date.now(), authorLogin: `octocat-${sequence}`, body: "Same reply", githubUrl: null, deleted: false });
    expect(unknowns.map((item) => getGithubSubmission(item.row.id)?.state)).toEqual(["unknown", "unknown"]);
    expect(db.query<{ direction: string }, [string]>("SELECT direction FROM review_local_github_message_links WHERE github_comment_id=?").get(`PRRC_AMBIGUOUS_${sequence}`)?.direction).toBe("in");
  });

  test("should render mapped outbound and inbound comments once in one local conversation", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    const importedThread = recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: "thread-webhook", sourceAt: Date.now(), nodeId: mapping.github_thread_id, firstCommentDatabaseId: "1001", resolved: false, path: "src/value.ts", side: "new", startLine: 4, endLine: 5, commitSha: f.head });
    recordGithubCommentWebhook({ workspaceId: f.workspaceId, threadId: importedThread, sourceId: "outbound-webhook", sourceAt: Date.now(), databaseId: "1001", nodeId: mapping.github_first_comment_id, createdAt: Date.now(), updatedAt: Date.now(), authorLogin: "octocat", body: "Please inspect this exact change.", githubUrl: "https://github.test/out", deleted: false });
    recordGithubCommentWebhook({ workspaceId: f.workspaceId, threadId: importedThread, sourceId: "inbound-webhook", sourceAt: Date.now() + 1, databaseId: "1002", nodeId: `PRRC_IN_${sequence}`, createdAt: Date.now() + 1, updatedAt: Date.now() + 1, authorLogin: "reviewer", body: "One inbound reply", githubUrl: "https://github.test/in", deleted: false });
    const lineage = getLineage(f.workspaceId, f.slug)!;
    const imported = await listImportedThreads(f.workspaceId, lineage, { context: createConversationReadContext(f.workspaceId) });
    const projected = mergeMappedGithubConversation(f.workspaceId, f.lineageId, [projectLocalThread(getLocalThread(f.workspaceId, f.threadId)!, f.userId)], imported);
    expect(projected.imported).toEqual([]);
    expect(projected.local).toHaveLength(1);
    expect(projected.local[0]!.entries.map((entry) => entry.body)).toEqual(["Please inspect this exact change.", "One inbound reply"]);
    expect(projected.local[0]!.entries.filter((entry) => entry.github)).toHaveLength(1);
    expect(projected.local[0]!.githubState).toBe("open");
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: "resolution-webhook", sourceAt: Date.now() + 2, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "1001", resolved: true });
    const resolvedImport = await listImportedThreads(f.workspaceId, lineage, { context: createConversationReadContext(f.workspaceId) });
    const resolved = mergeMappedGithubConversation(f.workspaceId, f.lineageId, [projectLocalThread(getLocalThread(f.workspaceId, f.threadId)!, f.userId)], resolvedImport);
    expect(resolved.local[0]).toMatchObject({ state: "open", githubState: "resolved" });
    expect(resolved.imported).toEqual([]);
    const reopened = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `github-reopen-inbound-${sequence}` });
    await run(f.credentialId);
    expect(getGithubSubmission(reopened.row!.id)).toMatchObject({ kind: "unresolve", state: "submitted" });
    expect(getLocalThread(f.workspaceId, f.threadId)!.entries).toHaveLength(1);
    recordGithubCommentWebhook({ workspaceId: f.workspaceId, threadId: importedThread, sourceId: "inbound-edit", sourceAt: Date.now() + 3, databaseId: "1002", nodeId: `PRRC_IN_${sequence}`, createdAt: Date.now() + 1, updatedAt: Date.now() + 3, authorLogin: "reviewer", body: "Edited inbound reply", githubUrl: "https://github.test/in", deleted: false });
    let editedImport = await listImportedThreads(f.workspaceId, lineage, { context: createConversationReadContext(f.workspaceId) });
    let edited = mergeMappedGithubConversation(f.workspaceId, f.lineageId, [projectLocalThread(getLocalThread(f.workspaceId, f.threadId)!, f.userId)], editedImport);
    expect(edited.local[0]!.entries.map((entry) => entry.body)).toEqual(["Please inspect this exact change.", "Edited inbound reply"]);
    recordGithubCommentWebhook({ workspaceId: f.workspaceId, threadId: importedThread, sourceId: "inbound-delete", sourceAt: Date.now() + 4, databaseId: "1002", nodeId: `PRRC_IN_${sequence}`, createdAt: Date.now() + 1, updatedAt: Date.now() + 4, authorLogin: "reviewer", body: null, githubUrl: "https://github.test/in", deleted: true });
    editedImport = await listImportedThreads(f.workspaceId, lineage, { context: createConversationReadContext(f.workspaceId) });
    edited = mergeMappedGithubConversation(f.workspaceId, f.lineageId, [projectLocalThread(getLocalThread(f.workspaceId, f.threadId)!, f.userId)], editedImport);
    expect(edited.local[0]!.entries.map((entry) => ({ body: entry.body, deleted: entry.deletedOnGithub ?? false }))).toEqual([{ body: "Please inspect this exact change.", deleted: false }, { body: null, deleted: true }]);
  });

  test("should order submitted resolutions against imported observations deterministically", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    const importedThread = recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `resolution-order-${sequence}`, sourceAt: Date.now(), nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9001", resolved: true });
    const importedObservationId = db.query<{ id: string }, [string]>("SELECT id FROM review_github_thread_observations WHERE thread_id=?").get(importedThread)!.id;
    const resolution = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-order-${sequence}` });
    await run(f.credentialId);
    const submittedAt = 1_700_000_000_000;
    db.run("UPDATE review_github_submissions SET updated_at=? WHERE id=?", [submittedAt, resolution.row!.id]);

    db.run("UPDATE review_github_thread_observations SET source_observed_at=? WHERE thread_id=?", [submittedAt - 1, importedThread]);
    expect(githubThreadProjectionState(f.workspaceId, f.threadId)).toEqual({ state: "open", basis: `submission:${resolution.row!.id}` });

    db.run("UPDATE review_github_thread_observations SET source_observed_at=? WHERE thread_id=?", [submittedAt, importedThread]);
    expect(githubThreadProjectionState(f.workspaceId, f.threadId)).toEqual({ state: "open", basis: `submission:${resolution.row!.id}` });

    db.run("UPDATE review_github_thread_observations SET source_observed_at=? WHERE thread_id=?", [submittedAt + 1, importedThread]);
    expect(githubThreadProjectionState(f.workspaceId, f.threadId)).toEqual({ state: "resolved", basis: `observation:${importedObservationId}` });
  });

  test("should emit each requested remote resolution transition once across local no-ops", async () => {
    const f = fixture();
    const calls: { kind: string; input?: unknown }[] = [];
    clients.set(f.credentialId, fake({ head: () => f.head, calls }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    const importedThread = recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `resolution-initial-${sequence}`, sourceAt: Date.now(), nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9101", resolved: true });
    const first = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-noop-first-${sequence}` });
    expect(first.row).toMatchObject({ kind: "unresolve", local_entry_id: null });
    expect(appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-noop-first-${sequence}` }).row?.id).toBe(first.row!.id);
    await run(f.credentialId);
    expect(calls.map((call) => call.kind)).toEqual(["review", "unresolve"]);

    await Bun.sleep(5);
    const afterFirst = Date.now();
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `resolution-open-${sequence}`, sourceAt: afterFirst, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9101", resolved: false });
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `resolution-remote-repeat-${sequence}`, sourceAt: afterFirst, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9101", resolved: true });
    const replayAfterRemoteMove = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-noop-first-${sequence}` });
    expect(replayAfterRemoteMove.row?.id).toBe(first.row!.id);
    const second = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-noop-second-${sequence}` });
    expect(second.row?.id).not.toBe(first.row!.id);
    await run(f.credentialId);
    expect({ calls: calls.map((call) => call.kind), submission: getGithubSubmission(second.row!.id) }).toMatchObject({ calls: ["review", "unresolve", "unresolve"], submission: { state: "submitted" } });
    const alreadyOpen = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "open", idempotencyKey: `resolution-already-open-${sequence}` });
    expect(alreadyOpen).toEqual({ row: null, created: false });
    expect(getLocalThread(f.workspaceId, f.threadId)!.entries).toHaveLength(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_submissions WHERE local_thread_id=? AND kind='unresolve'").get(f.threadId)?.n).toBe(2);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_resolution_requests WHERE local_thread_id=?").get(f.threadId)?.n).toBe(3);
    expect(importedThread).toBeTruthy();
  });

  test("should not confirm an uncertain resolution from state observed before its mutation", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    const initialAt = Date.now();
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `uncertain-resolution-open-${sequence}`, sourceAt: initialAt, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9301", resolved: false });
    await Bun.sleep(5);
    const baseClient = fake({ head: () => f.head });
    clients.set(f.credentialId, { ...baseClient, async resolveThread() { throw new GithubGraphqlTransportError("resolution response lost", true); } });
    const resolution = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "resolved", idempotencyKey: `uncertain-resolution-${sequence}` });
    await run(f.credentialId);
    const unknown = getGithubSubmission(resolution.row!.id)!;
    expect(unknown).toMatchObject({ state: "unknown", failure_code: "mutation_unknown" });
    expect(unknown.mutation_started_at).toBeNumber();
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `stale-resolution-${sequence}`, sourceAt: unknown.mutation_started_at! - 1, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9301", resolved: true });
    expect(getGithubSubmission(unknown.id)?.state).toBe("unknown");
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `fresh-resolution-${sequence}`, sourceAt: unknown.mutation_started_at! + 1, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9301", resolved: true });
    expect(getGithubSubmission(unknown.id)?.state).toBe("submitted");
  });

  test("should keep a resolution lease while its confirming webhook arrives", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const mapping = getLocalGithubThread(f.workspaceId, f.threadId)!;
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `running-resolution-open-${sequence}`, sourceAt: Date.now(), nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9401", resolved: false });

    let mutationBegan!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { mutationBegan = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: { kind: string; input?: unknown }[] = [];
    const base = fake({ head: () => f.head, calls });
    clients.set(f.credentialId, { ...base, async resolveThread(threadId, clientMutationId) {
      calls.push({ kind: "resolve", input: { threadId, clientMutationId } });
      mutationBegan();
      await blocked;
    } });
    const resolutionNow = Date.now();
    const resolution = appendGithubResolution({ workspaceId: f.workspaceId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId, state: "resolved", idempotencyKey: `running-resolution-${sequence}`, now: resolutionNow }).row!;
    const verdict = createGithubReviewSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, kind: "approve", body: "After resolution", now: resolutionNow + 1 }).row;
    const holder = runNextGithubSubmission(f.credentialId);
    await started;
    const running = getGithubSubmission(resolution.id)!;
    expect(running).toMatchObject({ state: "running", mutation_started_at: expect.any(Number), lease_token: expect.any(String), lease_expires_at: expect.any(Number) });
    recordGithubThreadWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, repoId: 91, prNumber: 31, sourceId: `running-resolution-confirm-${sequence}`, sourceAt: running.mutation_started_at! + 1, nodeId: mapping.github_thread_id, firstCommentDatabaseId: "9401", resolved: true });
    expect(getGithubSubmission(resolution.id)).toMatchObject({ state: "running", lease_token: running.lease_token, lease_expires_at: running.lease_expires_at });
    expect(await runNextGithubSubmission(f.credentialId)).toBe(false);
    expect(getGithubSubmission(verdict.id)?.state).toBe("pending");
    release();
    await holder;
    await run(f.credentialId);
    expect(getGithubSubmission(resolution.id)?.state).toBe("submitted");
    expect(getGithubSubmission(verdict.id)?.state).toBe("submitted");
    expect(calls.map((call) => call.kind)).toEqual(["resolve", "review"]);
  });

  test("should allow only one in-flight mutation for one exact credential", async () => {
    const f = fixture();
    let active = 0, maximum = 0, release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    clients.set(f.credentialId, fake({ head: () => f.head, addReview: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await blocked;
      active -= 1;
      return { reviewId: `PRR_SERIAL_${sequence}_${active}`, commentNodeIds: active === 0 ? [`PRRC_SERIAL_${sequence}`] : [] };
    } }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    createGithubReviewSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, kind: "approve", body: "Serial" });
    const first = runNextGithubSubmission(f.credentialId);
    const second = runNextGithubSubmission(f.credentialId);
    await Bun.sleep(10);
    expect(maximum).toBe(1);
    release();
    await Promise.all([first, second]);
    await run(f.credentialId);
    expect(maximum).toBe(1);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_submissions WHERE credential_id=? AND state='submitted'").get(f.credentialId)?.n).toBe(2);
  });

  test("should submit exact commit verdicts, report a racing head, and leave Seer judgment untouched", async () => {
    const f = fixture();
    let head = f.head;
    const calls: { kind: string; input?: any }[] = [];
    clients.set(f.credentialId, fake({ head: () => head, calls, afterMutation: () => { head = fixed("9"); } }));
    const approved = createGithubReviewSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, kind: "approve", body: "Ship it" });
    await run(f.credentialId);
    expect(calls[0]!.input).toMatchObject({ commitOID: f.head, event: "APPROVE", body: "Ship it", threads: [] });
    expect(getGithubSubmission(approved.row.id)?.state).toBe("submitted_stale");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id=?").get(f.revisionId)?.n).toBe(0);

    const requested = fixture();
    const requestCalls: { kind: string; input?: any }[] = [];
    clients.set(requested.credentialId, fake({ head: () => requested.head, calls: requestCalls }));
    const changes = createGithubReviewSubmission({ workspaceId: requested.workspaceId, lineageId: requested.lineageId, revisionId: requested.revisionId, userId: requested.userId, credentialId: requested.credentialId, kind: "request_changes", body: "Please revise" });
    expect(createGithubReviewSubmission({ workspaceId: requested.workspaceId, lineageId: requested.lineageId, revisionId: requested.revisionId, userId: requested.userId, credentialId: requested.credentialId, kind: "request_changes", body: "Please revise" }).created).toBe(false);
    expect(() => createGithubReviewSubmission({ workspaceId: requested.workspaceId, lineageId: requested.lineageId, revisionId: requested.revisionId, userId: requested.userId, credentialId: requested.credentialId, kind: "request_changes", body: "Different" })).toThrow(GithubSubmissionError);
    await run(requested.credentialId);
    expect(requestCalls[0]!.input).toMatchObject({ commitOID: requested.head, event: "REQUEST_CHANGES", body: "Please revise", threads: [] });
    expect(getGithubSubmission(changes.row.id)?.state).toBe("submitted");
  });

  test("should rebind only definite refused submissions and preserve actor-attempt history", async () => {
    const f = fixture();
    clients.set(f.credentialId, { ...fake({ head: () => f.head }), async addReview() { throw new GithubGraphqlPermissionError("write permission refused"); } });
    const refused = createGithubReviewSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, kind: "approve", body: "Try another actor" }).row;
    await run(f.credentialId);
    expect(getGithubSubmission(refused.id)).toMatchObject({ state: "refused", attempts: 1, actor_generation: 1, failure_code: "permission_refused" });
    const foreign = createGithubUserCredential({ userId: tinyId("usr"), kind: "pat", label: "foreign", secret: `foreign-${sequence}`, accountLogin: "foreign", accountId: 99_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    expect(() => retryGithubSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, submissionId: refused.id, credentialId: foreign })).toThrow(/selected GitHub credential/i);
    const replacement = createGithubUserCredential({ userId: f.userId, kind: "pat", label: "replacement", secret: `replacement-${sequence}`, accountLogin: `octocat-${sequence}`, accountId: 100_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    clients.set(replacement, fake({ head: () => f.head }));
    const rebound = retryGithubSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, submissionId: refused.id, credentialId: replacement });
    expect(rebound).toMatchObject({ credential_id: replacement, actor_generation: 2, state: "pending", attempts: 0, failure_code: null });
    expect(db.query<{ from_credential_id: string; to_credential_id: string; prior_attempts: number; prior_failure_code: string; prior_head_before: string; prior_mutation_started_at: number }, [string]>("SELECT from_credential_id,to_credential_id,prior_attempts,prior_failure_code,prior_head_before,prior_mutation_started_at FROM review_github_submission_rebinds WHERE submission_id=?").get(refused.id)).toEqual({ from_credential_id: f.credentialId, to_credential_id: replacement, prior_attempts: 1, prior_failure_code: "permission_refused", prior_head_before: f.head, prior_mutation_started_at: expect.any(Number) });
    await run(replacement);
    expect(getGithubSubmission(refused.id)).toMatchObject({ state: "submitted", attempts: 1, credential_id: replacement, actor_generation: 2 });

    const unknown = fixture();
    clients.set(unknown.credentialId, fake({ head: () => unknown.head, addReview: async () => { throw new GithubGraphqlTransportError("response lost", true); } }));
    const uncertain = createGithubReviewSubmission({ workspaceId: unknown.workspaceId, lineageId: unknown.lineageId, revisionId: unknown.revisionId, userId: unknown.userId, credentialId: unknown.credentialId, kind: "approve", body: "Unknown actor" }).row;
    await run(unknown.credentialId);
    const unknownReplacement = createGithubUserCredential({ userId: unknown.userId, kind: "pat", label: "other", secret: `other-${sequence}`, accountLogin: "other", accountId: 200_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    expect(() => retryGithubSubmission({ workspaceId: unknown.workspaceId, lineageId: unknown.lineageId, userId: unknown.userId, submissionId: uncertain.id, credentialId: unknownReplacement })).toThrow(/original personal credential/i);
    expect(getGithubSubmission(uncertain.id)).toMatchObject({ state: "unknown", credential_id: unknown.credentialId, actor_generation: 1 });
  });

  test("should classify dead credentials and preflight or parsed shape failures without mutation uncertainty", async () => {
    const dead = fixture();
    const deadRow = createGithubReviewSubmission({ workspaceId: dead.workspaceId, lineageId: dead.lineageId, revisionId: dead.revisionId, userId: dead.userId, credentialId: dead.credentialId, kind: "approve", body: "Dead" }).row;
    db.run("UPDATE github_user_credentials SET dead_at=? WHERE id=?", [Date.now(), dead.credentialId]);
    const openedBefore = opened.length;
    await run(dead.credentialId);
    expect(getGithubSubmission(deadRow.id)).toMatchObject({ state: "refused", failure_code: "credential_dead" });
    expect(opened).toHaveLength(openedBefore);

    const preflight = fixture();
    clients.set(preflight.credentialId, { ...fake({ head: () => preflight.head }), async pullRequest() { throw new GithubGraphqlShapeError("missing rateLimit"); } });
    const preflightRow = createGithubReviewSubmission({ workspaceId: preflight.workspaceId, lineageId: preflight.lineageId, revisionId: preflight.revisionId, userId: preflight.userId, credentialId: preflight.credentialId, kind: "approve", body: "Shape" }).row;
    await run(preflight.credentialId);
    expect(getGithubSubmission(preflightRow.id)).toMatchObject({ state: "failed", failure_code: "response_invalid" });

    const overstatedRead = fixture();
    clients.set(overstatedRead.credentialId, { ...fake({ head: () => overstatedRead.head }), async pullRequest() { throw new GithubGraphqlTransportError("query socket closed", true); } });
    const readRow = createGithubReviewSubmission({ workspaceId: overstatedRead.workspaceId, lineageId: overstatedRead.lineageId, revisionId: overstatedRead.revisionId, userId: overstatedRead.userId, credentialId: overstatedRead.credentialId, kind: "approve", body: "Read" }).row;
    await run(overstatedRead.credentialId);
    expect(getGithubSubmission(readRow.id)).toMatchObject({ state: "failed", failure_code: "transport_failed" });

    const parsedMutation = fixture();
    clients.set(parsedMutation.credentialId, { ...fake({ head: () => parsedMutation.head }), async addReview() { throw new GithubGraphqlTransportError("parsed GraphQL refusal", false); } });
    const parsedRow = createGithubReviewSubmission({ workspaceId: parsedMutation.workspaceId, lineageId: parsedMutation.lineageId, revisionId: parsedMutation.revisionId, userId: parsedMutation.userId, credentialId: parsedMutation.credentialId, kind: "approve", body: "Parsed" }).row;
    await run(parsedMutation.credentialId);
    expect(getGithubSubmission(parsedRow.id)).toMatchObject({ state: "failed", failure_code: "transport_failed" });
  });

  test("should suppress only empty imported wrapper reviews", async () => {
    const f = fixture();
    clients.set(f.credentialId, fake({ head: () => f.head }));
    createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId });
    await run(f.credentialId);
    const wrapper = getLocalGithubThread(f.workspaceId, f.threadId)!.github_review_id;
    const at = Date.now();
    recordGithubReviewWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, sourceId: `wrapper-empty-${sequence}`, sourceAt: at, review: { databaseId: "9201", nodeId: wrapper, authorLogin: `octocat-${sequence}`, state: "commented", body: "", url: null, commitSha: f.head, submittedAt: at, dismissed: false } });
    expect(listImportedReviews(f.workspaceId, f.lineageId)).toEqual([]);
    recordGithubReviewWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, sourceId: `wrapper-body-${sequence}`, sourceAt: at + 1, review: { databaseId: "9201", nodeId: wrapper, authorLogin: `octocat-${sequence}`, state: "commented", body: "Member-authored context", url: null, commitSha: f.head, submittedAt: at, dismissed: false } });
    recordGithubReviewWebhook({ workspaceId: f.workspaceId, lineageId: f.lineageId, sourceId: `verdict-empty-${sequence}`, sourceAt: at + 2, review: { databaseId: "9202", nodeId: `PRR_VERDICT_${sequence}`, authorLogin: `octocat-${sequence}`, state: "approved", body: "", url: null, commitSha: f.head, submittedAt: at + 2, dismissed: false } });
    expect(listImportedReviews(f.workspaceId, f.lineageId).map((review) => ({ state: review.state, body: review.body }))).toEqual([{ state: "commented", body: "Member-authored context" }, { state: "approved", body: "" }]);
  });

  test("should mark a thread submitted stale when the head races its mutation", async () => {
    const f = fixture();
    let head = f.head;
    clients.set(f.credentialId, fake({ head: () => head, afterMutation: () => { head = fixed("6"); } }));
    const row = createGithubThreadSubmission({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, credentialId: f.credentialId, localThreadId: f.threadId }).row;
    await run(f.credentialId);
    expect(getGithubSubmission(row.id)?.state).toBe("submitted_stale");
    expect(getLocalGithubThread(f.workspaceId, f.threadId)).not.toBeNull();
  });

  test("should refuse old, moved, deleted and unauthorized targets before a mutation", async () => {
    const moved = fixture();
    const calls: { kind: string }[] = [];
    clients.set(moved.credentialId, fake({ head: () => fixed("8"), calls }));
    const row = createGithubReviewSubmission({ workspaceId: moved.workspaceId, lineageId: moved.lineageId, revisionId: moved.revisionId, userId: moved.userId, credentialId: moved.credentialId, kind: "request_changes", body: "Move" }).row;
    const thread = createGithubThreadSubmission({ workspaceId: moved.workspaceId, lineageId: moved.lineageId, revisionId: moved.revisionId, userId: moved.userId, credentialId: moved.credentialId, localThreadId: moved.threadId }).row;
    await run(moved.credentialId);
    expect(getGithubSubmission(row.id)).toMatchObject({ state: "refused", failure_code: "target_missing" });
    expect(getGithubSubmission(thread.id)).toMatchObject({ state: "refused", failure_code: "target_missing" });
    expect(calls).toEqual([]);

    const unauthorized = fixture();
    const another = createGithubUserCredential({ userId: tinyId("usr"), kind: "pat", label: "other", secret: "other-token", accountLogin: "other", accountId: 999, scopes: [], expiresAt: Date.now() + 60_000 });
    expect(() => createGithubThreadSubmission({ workspaceId: unauthorized.workspaceId, lineageId: unauthorized.lineageId, revisionId: unauthorized.revisionId, userId: unauthorized.userId, credentialId: another, localThreadId: unauthorized.threadId })).toThrow(GithubSubmissionError);
    db.run("UPDATE review_lineage_prs SET detached_at=? WHERE lineage_id=?", [Date.now(), unauthorized.lineageId]);
    expect(() => createGithubReviewSubmission({ workspaceId: unauthorized.workspaceId, lineageId: unauthorized.lineageId, revisionId: unauthorized.revisionId, userId: unauthorized.userId, credentialId: unauthorized.credentialId, kind: "approve", body: "" })).toThrow(GithubSubmissionError);
  });
});
