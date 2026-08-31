import { randomBytes } from "node:crypto";
import { db } from "../db";
import { tinyId } from "../ids";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import { appendLocalReply, appendResolutionEvent, getLocalThread, localThreadState } from "./thread-db";
import {
  personalGithubGraphqlClient,
  GithubGraphqlTargetError,
  GithubGraphqlTransportError,
  type DraftReviewThread,
  type PersonalGithubGraphqlClient,
} from "./github-graphql";
import { projectionFailure } from "./github-projection-errors";
import {
  getLocalGithubThread,
  githubThreadProjectionState,
  linkSubmittedGithubReply,
  linkSubmittedGithubResolution,
  mapSubmittedGithubThread,
} from "./github-thread-sync";
import { getGithubUserCredential } from "./user-credentials";
import { digestOf, getLineage, getRevision, getRevisionById, type ReviewLineageRow, type ReviewRevisionRow } from "./revision-db";
import { getLineagePr, latestObservation, observationForRevision } from "./revision-pr";
import type { ThreadAuthor } from "./thread-db";

export const GITHUB_SUBMISSION_BODY_MAX = 4_000;
export const GITHUB_SUBMISSION_LEASE_MS = 120_000;
export const GITHUB_SUBMISSION_ATTEMPTS_MAX = 5;
const RECOVERY_CONSISTENCY_MS = 30_000;

export type GithubSubmissionKind = "thread" | "reply" | "resolve" | "unresolve" | "approve" | "request_changes";
export type GithubSubmissionState = "pending" | "running" | "submitted" | "submitted_stale" | "failed" | "refused" | "unknown";

export interface GithubSubmissionRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  user_id: string;
  credential_id: string;
  kind: GithubSubmissionKind;
  local_thread_id: string | null;
  local_entry_id: string | null;
  projection_key: string | null;
  commit_sha: string;
  body: string;
  request_digest: string;
  actor_generation: number;
  state: GithubSubmissionState;
  github_review_id: string | null;
  github_thread_id: string | null;
  github_comment_id: string | null;
  head_before: string | null;
  head_after: string | null;
  mutation_started_at: number | null;
  attempts: number;
  failure_code: string | null;
  failure: string | null;
  retry_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GithubSubmissionView {
  id: string;
  kind: GithubSubmissionKind;
  state: GithubSubmissionState;
  failure: string | null;
  retryAt: string | null;
  rebindable: boolean;
  createdAt: string;
}

export class GithubSubmissionError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly rule: string, message: string) {
    super(message);
    this.name = "GithubSubmissionError";
  }
}

function validateBody(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string") throw new GithubSubmissionError(422, "body", "GitHub review body must be text.");
  const body = value.trim();
  if (!allowEmpty && body === "") throw new GithubSubmissionError(422, "body", "Message is required.");
  if (body.length > GITHUB_SUBMISSION_BODY_MAX) throw new GithubSubmissionError(422, "body", `GitHub review body is over ${GITHUB_SUBMISSION_BODY_MAX} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(body)) throw new GithubSubmissionError(422, "body", "GitHub review body contains unsupported control characters.");
  return body;
}

function lineageById(workspaceId: string, lineageId: string): ReviewLineageRow | null {
  const row = db.query<{ slug: string }, [string, string]>(
    "SELECT slug FROM review_lineages WHERE workspace_id=? AND id=?",
  ).get(workspaceId, lineageId);
  return row ? getLineage(workspaceId, row.slug) : null;
}

function credentialUsable(userId: string, credentialId: string, now = Date.now()): boolean {
  const row = getGithubUserCredential(credentialId, userId);
  return !!row && row.revoked_at === null && row.dead_at === null &&
    (row.expires_at === null || row.expires_at > now);
}

function currentRevisionTarget(
  workspaceId: string,
  lineageId: string,
  revisionId: string,
): { lineage: ReviewLineageRow; revision: ReviewRevisionRow; repo: string; number: number } | null {
  const lineage = lineageById(workspaceId, lineageId);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(workspaceId, lineage.slug, lineage.latest_revision);
  const relation = lineage ? getLineagePr(workspaceId, lineage.id) : null;
  const observation = lineage ? latestObservation(workspaceId, lineage.id) : null;
  if (!lineage || !revision || !relation || !observation || revision.id !== revisionId ||
      relation.repo_id !== observation.repo_id || relation.pr_number !== observation.pr_number ||
      revision.doc.source.sourceHeadSha !== observation.head_sha) return null;
  return { lineage, revision, repo: observation.repo, number: observation.pr_number };
}

export type GithubThreadDraftResult =
  | { ok: true; draft: DraftReviewThread; localEntryId: string }
  | { ok: false; rule: "thread_unmappable" | "github_anchor_out_of_diff"; message: string };

function overlaps(start: number, end: number, changeStart: number, changeLines: number): boolean {
  return changeLines > 0 && start <= changeStart + changeLines - 1 && end >= changeStart;
}

const OUT_OF_DIFF = "GitHub only accepts comments on lines in the current diff. The local thread is unchanged.";

/** Resolve a local anchor against the exact current capture GitHub will receive. */
export function githubThreadDraft(
  workspaceId: string,
  revision: ReviewRevisionRow,
  localThreadId: string,
  inventory: StageCaptureInventory | null = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]),
): GithubThreadDraftResult {
  const held = getLocalThread(workspaceId, localThreadId);
  if (!held || held.thread.scope_kind !== "lineage" || held.thread.lineage_id !== revision.lineage_id ||
      held.anchor.revision_id !== revision.id || (held.anchor.anchor_kind !== "change" && held.anchor.anchor_kind !== "range")) {
    return { ok: false, rule: "thread_unmappable", message: "Only an exact current code thread can be posted to GitHub." };
  }
  const exactInventory = inventory?.capture.id === revision.capture_id && inventory.capture.workspace_id === workspaceId ? inventory : null;
  const file = exactInventory && held.anchor.file_id ? exactInventory.files.find((candidate) => candidate.id === held.anchor.file_id) : null;
  const first = held.entries.find((entry) => entry.kind === "message");
  if (!exactInventory || !file || !first?.body) {
    return { ok: false, rule: "thread_unmappable", message: "Only an exact current code thread can be posted to GitHub." };
  }
  if (held.anchor.anchor_kind === "range") {
    if (held.anchor.range_kind !== "changed" || !held.anchor.side || !held.anchor.start_line || !held.anchor.end_line) {
      return { ok: false, rule: "github_anchor_out_of_diff", message: OUT_OF_DIFF };
    }
    const digest = held.anchor.side === "old" ? file.old_blob_sha : file.new_blob_sha;
    const kind = held.anchor.side === "old" ? file.old_kind : file.new_kind;
    const availability = held.anchor.side === "old" ? file.old_availability : file.new_availability;
    const inHunk = exactInventory.changes.some((change) => change.file_id === file.id && overlaps(
      held.anchor.start_line!,
      held.anchor.end_line!,
      held.anchor.side === "old" ? change.old_start : change.new_start,
      held.anchor.side === "old" ? change.old_lines : change.new_lines,
    ));
    if (availability !== "retained" || kind !== "blob" || !digest || digest !== held.anchor.object_digest || !inHunk) {
      return { ok: false, rule: "github_anchor_out_of_diff", message: OUT_OF_DIFF };
    }
    const side = held.anchor.side === "old" ? "LEFT" : "RIGHT";
    return { ok: true, localEntryId: first.id, draft: {
      path: file.path,
      line: held.anchor.end_line,
      side,
      ...(held.anchor.start_line === held.anchor.end_line ? {} : { startLine: held.anchor.start_line, startSide: side }),
      body: first.body,
    } };
  }
  const change = held.anchor.change_id ? exactInventory.changes.find((candidate) => candidate.id === held.anchor.change_id && candidate.file_id === file.id) : null;
  if (!change) return { ok: false, rule: "github_anchor_out_of_diff", message: OUT_OF_DIFF };
  const right = change.new_lines > 0;
  const start = right ? change.new_start : change.old_start;
  const lines = right ? change.new_lines : change.old_lines;
  if (lines < 1 || start < 1) return { ok: false, rule: "github_anchor_out_of_diff", message: OUT_OF_DIFF };
  const side = right ? "RIGHT" as const : "LEFT" as const;
  return { ok: true, localEntryId: first.id, draft: {
    // GitHub always addresses the file by its current pull-request path. LEFT selects old text.
    path: file.path,
    line: start + lines - 1,
    side,
    ...(lines > 1 ? { startLine: start, startSide: side } : {}),
    body: first.body,
  } };
}

function getByUnique(
  kind: GithubSubmissionKind,
  localThreadId: string | null,
  localEntryId: string | null,
  projectionKey: string | null,
  revisionId: string,
  userId: string,
): GithubSubmissionRow | null {
  if (kind === "thread") return db.query<GithubSubmissionRow, [string]>("SELECT * FROM review_github_submissions WHERE kind='thread' AND local_thread_id=?").get(localThreadId!);
  if (kind === "reply") return db.query<GithubSubmissionRow, [string]>("SELECT * FROM review_github_submissions WHERE kind='reply' AND local_entry_id=?").get(localEntryId!);
  if (kind === "resolve" || kind === "unresolve") return db.query<GithubSubmissionRow, [string]>("SELECT * FROM review_github_submissions WHERE kind IN ('resolve','unresolve') AND projection_key=?").get(projectionKey!);
  return db.query<GithubSubmissionRow, [string, string, string]>("SELECT * FROM review_github_submissions WHERE revision_id=? AND user_id=? AND kind=?").get(revisionId, userId, kind);
}

function insertSubmission(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  credentialId: string;
  kind: GithubSubmissionKind;
  localThreadId?: string | null;
  localEntryId?: string | null;
  projectionKey?: string | null;
  commitSha: string;
  body: string;
  request: unknown;
  now?: number;
}): { row: GithubSubmissionRow; created: boolean } {
  const now = input.now ?? Date.now();
  const requestDigest = digestOf(input.request);
  const localThreadId = input.localThreadId ?? null;
  const localEntryId = input.localEntryId ?? null;
  const projectionKey = input.projectionKey ?? null;
  const held = getByUnique(input.kind, localThreadId, localEntryId, projectionKey, input.revisionId, input.userId);
  if (held) {
    if (held.request_digest !== requestDigest) throw new GithubSubmissionError(409, "submission_conflict", "This exact GitHub action was already submitted with different content.");
    if (held.credential_id !== input.credentialId) throw new GithubSubmissionError(409, "actor_immutable", "This GitHub action is already bound to another personal credential.");
    return { row: held, created: false };
  }
  const id = tinyId("ghs");
  try {
    db.run(
      "INSERT INTO review_github_submissions (id,workspace_id,lineage_id,revision_id,user_id,credential_id,kind,local_thread_id,local_entry_id,projection_key,commit_sha,body,request_digest,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
      [id, input.workspaceId, input.lineageId, input.revisionId, input.userId, input.credentialId, input.kind, localThreadId, localEntryId, projectionKey, input.commitSha, input.body, requestDigest, now, now],
    );
  } catch (error) {
    if (!/UNIQUE constraint failed/.test(error instanceof Error ? error.message : String(error))) throw error;
    const winner = getByUnique(input.kind, localThreadId, localEntryId, projectionKey, input.revisionId, input.userId);
    if (!winner || winner.request_digest !== requestDigest) throw new GithubSubmissionError(409, "submission_conflict", "This exact GitHub action was already submitted with different content.");
    if (winner.credential_id !== input.credentialId) throw new GithubSubmissionError(409, "actor_immutable", "This GitHub action is already bound to another personal credential.");
    return { row: winner, created: false };
  }
  return { row: getGithubSubmission(id)!, created: true };
}

export function getGithubSubmission(id: string): GithubSubmissionRow | null {
  return db.query<GithubSubmissionRow, [string]>("SELECT * FROM review_github_submissions WHERE id=?").get(id);
}

export function createGithubThreadSubmission(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  credentialId: string;
  localThreadId: string;
  now?: number;
}): { row: GithubSubmissionRow; created: boolean } {
  const target = currentRevisionTarget(input.workspaceId, input.lineageId, input.revisionId);
  if (!target || !credentialUsable(input.userId, input.credentialId)) throw new GithubSubmissionError(422, "github_target_stale", "The exact pull request revision or selected credential is no longer writable.");
  if (getLocalGithubThread(input.workspaceId, input.localThreadId)) throw new GithubSubmissionError(409, "thread_mapped", "This local thread is already mapped to GitHub.");
  const resolved = githubThreadDraft(input.workspaceId, target.revision, input.localThreadId);
  if (!resolved.ok) throw new GithubSubmissionError(422, resolved.rule, resolved.message);
  return insertSubmission({
    ...input,
    kind: "thread",
    localThreadId: input.localThreadId,
    localEntryId: resolved.localEntryId,
    commitSha: target.revision.doc.source.sourceHeadSha,
    body: resolved.draft.body,
    request: { kind: "thread", revisionId: input.revisionId, localThreadId: input.localThreadId, draft: resolved.draft },
  });
}

export function appendGithubThreadReply(input: {
  workspaceId: string;
  userId: string;
  credentialId: string;
  localThreadId: string;
  body: string;
  idempotencyKey: string;
  author: ThreadAuthor;
  now?: number;
}): { row: GithubSubmissionRow; created: boolean } {
  if (!credentialUsable(input.userId, input.credentialId)) throw new GithubSubmissionError(422, "credential_refused", "The selected GitHub credential is no longer writable.");
  return db.transaction(() => {
    const mapping = getLocalGithubThread(input.workspaceId, input.localThreadId);
    if (!mapping) throw new GithubSubmissionError(422, "thread_unmapped", "Post this thread to GitHub before replying there.");
    const record = appendLocalReply({ workspaceId: input.workspaceId, threadId: input.localThreadId, body: input.body, author: input.author, idempotencyKey: input.idempotencyKey });
    const operation = db.query<{ entry_id: string }, [string, string]>(
      "SELECT entry_id FROM review_thread_idempotency WHERE workspace_id=? AND idempotency_key=?",
    ).get(input.workspaceId, input.idempotencyKey);
    const entry = operation ? record.entries.find((candidate) => candidate.id === operation.entry_id) : null;
    if (!entry?.body) throw new Error("GitHub reply idempotency did not resolve its local message");
    return insertSubmission({
      workspaceId: input.workspaceId,
      lineageId: mapping.lineage_id,
      revisionId: mapping.revision_id,
      userId: input.userId,
      credentialId: input.credentialId,
      kind: "reply",
      localThreadId: input.localThreadId,
      localEntryId: entry.id,
      commitSha: mapping.commit_sha,
      body: entry.body,
      request: { kind: "reply", localThreadId: input.localThreadId, localEntryId: entry.id, body: entry.body },
      now: input.now,
    });
  })();
}

export function appendGithubResolution(input: {
  workspaceId: string;
  userId: string;
  credentialId: string;
  localThreadId: string;
  state: "resolved" | "open";
  idempotencyKey: string;
  now?: number;
}): { row: GithubSubmissionRow | null; created: boolean } {
  if (!credentialUsable(input.userId, input.credentialId)) throw new GithubSubmissionError(422, "credential_refused", "The selected GitHub credential is no longer writable.");
  const mapping = getLocalGithubThread(input.workspaceId, input.localThreadId);
  if (!mapping) throw new GithubSubmissionError(422, "thread_unmapped", "Post this thread to GitHub before changing its GitHub resolution.");
  const before = getLocalThread(input.workspaceId, input.localThreadId);
  if (!before) throw new GithubSubmissionError(404, "thread_unmapped", "No such local thread.");
  const priorLocalState = localThreadState(before);

  // This transaction belongs to thread-db and commits before projection bookkeeping.
  // A projection conflict must not unwind the member's local resolution event.
  const record = appendResolutionEvent({ workspaceId: input.workspaceId, threadId: input.localThreadId, state: input.state, author: { kind: "member", userId: input.userId }, idempotencyKey: input.idempotencyKey });
  const operation = db.query<{ entry_id: string }, [string, string]>(
    "SELECT entry_id FROM review_thread_idempotency WHERE workspace_id=? AND idempotency_key=?",
  ).get(input.workspaceId, input.idempotencyKey);
  const entry = operation ? record.entries.find((candidate) => candidate.id === operation.entry_id) : null;
  if (!entry || localThreadState(record) !== input.state) throw new Error("GitHub resolution idempotency did not resolve its local state");
  const exactLocalEntry = priorLocalState === input.state ? null : entry;
  const expectedKind = input.state === "resolved" ? "resolved" : "reopened";
  if (exactLocalEntry && exactLocalEntry.kind !== expectedKind) throw new Error("GitHub resolution did not append the requested local state event");

  return db.transaction(() => {
    const requestDigest = digestOf({ operation: "github_resolution", localThreadId: input.localThreadId, state: input.state, userId: input.userId, credentialId: input.credentialId });
    const replay = db.query<{ request_digest: string; submission_id: string | null }, [string, string]>(
      "SELECT request_digest,submission_id FROM review_github_resolution_requests WHERE workspace_id=? AND idempotency_key=?",
    ).get(input.workspaceId, input.idempotencyKey);
    if (replay) {
      if (replay.request_digest !== requestDigest) throw new GithubSubmissionError(409, "submission_conflict", "This idempotency key was already used for another GitHub resolution action.");
      return { row: replay.submission_id ? getGithubSubmission(replay.submission_id) : null, created: false };
    }

    const remote = githubThreadProjectionState(input.workspaceId, input.localThreadId);
    if (!remote) throw new GithubSubmissionError(422, "thread_unmapped", "Post this thread to GitHub before changing its GitHub resolution.");
    const now = input.now ?? Date.now();
    if (remote.state === input.state) {
      db.run(
        "INSERT INTO review_github_resolution_requests (workspace_id,idempotency_key,request_digest,local_thread_id,target_state,submission_id,created_at) VALUES (?,?,?,?,?,NULL,?)",
        [input.workspaceId, input.idempotencyKey, requestDigest, input.localThreadId, input.state, now],
      );
      return { row: null, created: false };
    }

    const kind = input.state === "resolved" ? "resolve" as const : "unresolve" as const;
    const projectionKey = digestOf({ localThreadId: input.localThreadId, githubThreadId: mapping.github_thread_id, target: input.state, basis: remote.basis });
    const submission = insertSubmission({
      workspaceId: input.workspaceId,
      lineageId: mapping.lineage_id,
      revisionId: mapping.revision_id,
      userId: input.userId,
      credentialId: input.credentialId,
      kind,
      localThreadId: input.localThreadId,
      localEntryId: exactLocalEntry?.id ?? null,
      projectionKey,
      commitSha: mapping.commit_sha,
      body: "",
      request: { kind, localThreadId: input.localThreadId, target: input.state, basis: remote.basis },
      now,
    });
    db.run(
      "INSERT INTO review_github_resolution_requests (workspace_id,idempotency_key,request_digest,local_thread_id,target_state,submission_id,created_at) VALUES (?,?,?,?,?,?,?)",
      [input.workspaceId, input.idempotencyKey, requestDigest, input.localThreadId, input.state, submission.row.id, now],
    );
    linkSubmittedGithubResolution({ workspaceId: input.workspaceId, localThreadId: input.localThreadId, localEntryId: exactLocalEntry?.id ?? null, submissionId: submission.row.id, githubThreadId: mapping.github_thread_id, resolved: kind === "resolve", now });
    return submission;
  })();
}

export function createGithubReviewSubmission(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  credentialId: string;
  kind: "approve" | "request_changes";
  body: unknown;
  now?: number;
}): { row: GithubSubmissionRow; created: boolean } {
  const target = currentRevisionTarget(input.workspaceId, input.lineageId, input.revisionId);
  if (!target || !credentialUsable(input.userId, input.credentialId)) throw new GithubSubmissionError(422, "github_target_stale", "The exact pull request revision or selected credential is no longer writable.");
  const body = validateBody(input.body);
  return insertSubmission({
    ...input,
    commitSha: target.revision.doc.source.sourceHeadSha,
    body,
    request: { kind: input.kind, revisionId: input.revisionId, body },
  });
}

export function listGithubSubmissions(
  workspaceId: string,
  lineageId: string,
  userId: string,
): GithubSubmissionView[] {
  return db.query<GithubSubmissionRow, [string, string, string]>(
    "SELECT * FROM review_github_submissions WHERE workspace_id=? AND lineage_id=? AND user_id=? ORDER BY created_at,id",
  ).all(workspaceId, lineageId, userId).map(submissionView);
}

export function submissionView(row: GithubSubmissionRow): GithubSubmissionView {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    failure: row.failure,
    retryAt: row.retry_at === null ? null : new Date(row.retry_at).toISOString(),
    rebindable: row.state === "refused" && row.github_review_id === null && row.github_thread_id === null && row.github_comment_id === null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function retryGithubSubmission(input: {
  workspaceId: string;
  lineageId: string;
  userId: string;
  submissionId: string;
  credentialId?: string;
  now?: number;
}): GithubSubmissionRow {
  const row = getGithubSubmission(input.submissionId);
  if (!row || row.workspace_id !== input.workspaceId || row.lineage_id !== input.lineageId || row.user_id !== input.userId ||
      !["failed", "refused", "unknown"].includes(row.state)) throw new GithubSubmissionError(404, "submission_unknown", "No retryable GitHub submission.");
  const credentialId = input.credentialId ?? row.credential_id;
  if (!credentialUsable(input.userId, credentialId)) throw new GithubSubmissionError(422, "credential_refused", "The selected GitHub credential is no longer writable.");
  const now = input.now ?? Date.now();
  return db.transaction(() => {
    if (credentialId !== row.credential_id) {
      const hasSideEffectId = row.github_review_id !== null || row.github_thread_id !== null || row.github_comment_id !== null;
      if (row.state !== "refused" || hasSideEffectId) {
        throw new GithubSubmissionError(409, "actor_immutable", "Unknown, submitted, and GitHub-linked actions must keep their original personal credential.");
      }
      db.run(
        "INSERT INTO review_github_submission_rebinds (submission_id,actor_generation,workspace_id,user_id,from_credential_id,to_credential_id,prior_attempts,prior_failure_code,prior_failure,prior_head_before,prior_head_after,prior_mutation_started_at,rebound_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [row.id, row.actor_generation, row.workspace_id, row.user_id, row.credential_id, credentialId, row.attempts, row.failure_code, row.failure, row.head_before, row.head_after, row.mutation_started_at, now],
      );
      const rebound = db.run(
        "UPDATE review_github_submissions SET credential_id=?,actor_generation=actor_generation+1,state='pending',attempts=0,failure_code=NULL,failure=NULL,retry_at=NULL,mutation_started_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND workspace_id=? AND lineage_id=? AND user_id=? AND state='refused' AND credential_id=? AND github_review_id IS NULL AND github_thread_id IS NULL AND github_comment_id IS NULL",
        [credentialId, now, row.id, input.workspaceId, input.lineageId, input.userId, row.credential_id],
      ).changes;
      if (rebound !== 1) throw new GithubSubmissionError(409, "actor_immutable", "This GitHub action changed before its credential could be replaced.");
      return getGithubSubmission(row.id)!;
    }
    db.run(
      "UPDATE review_github_submissions SET state='pending',attempts=CASE WHEN state='unknown' THEN attempts ELSE 0 END,failure_code=CASE WHEN state='unknown' THEN failure_code ELSE NULL END,failure=CASE WHEN state='unknown' THEN failure ELSE NULL END,retry_at=NULL,mutation_started_at=CASE WHEN state='unknown' THEN mutation_started_at ELSE NULL END,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND workspace_id=? AND lineage_id=? AND user_id=? AND state IN ('failed','refused','unknown')",
      [now, row.id, input.workspaceId, input.lineageId, input.userId],
    );
    return getGithubSubmission(row.id)!;
  })();
}

function claimSubmission(credentialId: string, now = Date.now()): GithubSubmissionRow | null {
  return db.transaction(() => {
    const rate = db.query<{ retry_after: number | null }, [string]>(
      "SELECT retry_after FROM github_graphql_rate_limits WHERE credential_id=?",
    ).get(credentialId);
    if ((rate?.retry_after ?? 0) > now) {
      db.run("UPDATE review_github_submissions SET state='failed',failure_code='rate_limited',failure='GitHub rate-limited this personal credential.',retry_at=?,updated_at=? WHERE credential_id=? AND state='pending'", [rate!.retry_after, now, credentialId]);
      return null;
    }
    const occupied = db.query<{ one: number }, [string, number, string, number]>(
      "SELECT 1 AS one FROM review_github_viewed_jobs WHERE credential_id=? AND state='running' AND lease_expires_at>? UNION ALL SELECT 1 AS one FROM review_github_submissions WHERE credential_id=? AND state='running' AND lease_expires_at>? LIMIT 1",
    ).get(credentialId, now, credentialId, now);
    if (occupied) return null;
    const candidate = db.query<{ id: string }, [string, number, number, number]>(
      "SELECT id FROM review_github_submissions WHERE credential_id=? AND (state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?)) ORDER BY updated_at,id LIMIT 1",
    ).get(credentialId, GITHUB_SUBMISSION_ATTEMPTS_MAX, now, now);
    if (!candidate) return null;
    const lease = randomBytes(24).toString("base64url");
    db.run(
      "UPDATE review_github_submissions SET state='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,retry_at=NULL,updated_at=? WHERE id=? AND credential_id=? AND (state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?))",
      [lease, now + GITHUB_SUBMISSION_LEASE_MS, now, candidate.id, credentialId, GITHUB_SUBMISSION_ATTEMPTS_MAX, now, now],
    );
    const row = getGithubSubmission(candidate.id);
    return row?.lease_token === lease ? row : null;
  })();
}

function stillOwns(row: GithubSubmissionRow): boolean {
  const current = getGithubSubmission(row.id);
  return current?.state === "running" && current.lease_token === row.lease_token &&
    (current.lease_expires_at ?? 0) > Date.now();
}

function finish(row: GithubSubmissionRow, state: GithubSubmissionState, code: string | null, failure: string | null, retryAt: number | null, headAfter?: string | null): void {
  db.run(
    "UPDATE review_github_submissions SET state=?,failure_code=?,failure=?,retry_at=?,head_after=COALESCE(?,head_after),lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?",
    [state, code, failure, retryAt, headAfter ?? null, Date.now(), row.id, row.lease_token],
  );
}

function mappedTarget(row: GithubSubmissionRow) {
  const mapping = row.local_thread_id ? getLocalGithubThread(row.workspace_id, row.local_thread_id) : null;
  const lineage = lineageById(row.workspace_id, row.lineage_id);
  const relation = lineage ? getLineagePr(row.workspace_id, lineage.id) : null;
  const observation = lineage ? latestObservation(row.workspace_id, lineage.id) : null;
  const revision = getRevisionById(row.workspace_id, row.revision_id);
  const pinned = revision ? observationForRevision(row.workspace_id, revision.id) : null;
  if (!mapping || !lineage || !relation || !observation || !revision || !pinned ||
      mapping.lineage_id !== lineage.id || mapping.revision_id !== revision.id ||
      relation.repo_id !== pinned.repo_id || relation.pr_number !== pinned.pr_number ||
      observation.repo_id !== pinned.repo_id || observation.pr_number !== pinned.pr_number) return null;
  return { mapping, lineage, revision, repo: observation.repo, number: observation.pr_number };
}

function storedTarget(row: GithubSubmissionRow) {
  if (row.kind === "thread" || row.kind === "approve" || row.kind === "request_changes") {
    return currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id);
  }
  return mappedTarget(row);
}

async function requireMutationBudget(remaining: number, resetAt: number): Promise<void> {
  if (remaining > 0) return;
  const { GithubRateLimitError } = await import("./github-app");
  throw new GithubRateLimitError("GitHub's GraphQL budget is exhausted for this credential.", resetAt);
}

async function postHead(client: PersonalGithubGraphqlClient, repo: string, number: number): Promise<string> {
  return (await client.pullRequest(repo, number)).headRefOid;
}

async function adoptThread(row: GithubSubmissionRow, client: PersonalGithubGraphqlClient, target: NonNullable<ReturnType<typeof currentRevisionTarget>>, reviewId: string, commentId: string, knownThreadId?: string | null): Promise<boolean> {
  const threadId = knownThreadId ?? await client.findReviewThreadByComment(target.repo, target.number, commentId);
  if (!threadId) return false;
  const held = getLocalThread(row.workspace_id, row.local_thread_id!);
  const first = held?.entries.find((entry) => entry.kind === "message");
  if (!first) throw new GithubGraphqlTargetError("The local thread was deleted before its GitHub mapping could be recorded.");
  const after = await postHead(client, target.repo, target.number);
  db.transaction(() => {
    db.run("UPDATE review_github_submissions SET github_review_id=?,github_thread_id=?,github_comment_id=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?", [reviewId, threadId, commentId, Date.now(), row.id, row.lease_token]);
    mapSubmittedGithubThread({
      workspaceId: row.workspace_id,
      lineageId: row.lineage_id,
      revisionId: row.revision_id,
      localThreadId: row.local_thread_id!,
      localMessageId: first.id,
      submissionId: row.id,
      githubReviewId: reviewId,
      githubThreadId: threadId,
      githubCommentId: commentId,
      commitSha: row.commit_sha,
    });
    finish(row, after === row.commit_sha && currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id) ? "submitted" : "submitted_stale", null, null, null, after);
  })();
  return true;
}

async function recoverThread(row: GithubSubmissionRow, client: PersonalGithubGraphqlClient, target: NonNullable<ReturnType<typeof currentRevisionTarget>>, draft: DraftReviewThread): Promise<"adopted" | "retry" | "unknown"> {
  if (row.github_review_id && row.github_comment_id) {
    return await adoptThread(row, client, target, row.github_review_id, row.github_comment_id, row.github_thread_id) ? "adopted" : "unknown";
  }
  const recovered = await client.recoverReview({ repo: target.repo, number: target.number, commitOID: row.commit_sha, event: "COMMENT", body: "", thread: draft, createdAt: row.created_at });
  if (recovered.kind === "match" && recovered.commentNodeId && recovered.threadId) {
    await adoptThread(row, client, target, recovered.reviewId, recovered.commentNodeId, recovered.threadId);
    return "adopted";
  }
  if (recovered.kind === "ambiguous" || Date.now() - row.created_at < RECOVERY_CONSISTENCY_MS) return "unknown";
  return "retry";
}

async function runThread(row: GithubSubmissionRow, client: PersonalGithubGraphqlClient, target: NonNullable<ReturnType<typeof currentRevisionTarget>>, markMutationStarted: () => void): Promise<void> {
  if (getLocalGithubThread(row.workspace_id, row.local_thread_id!)) {
    const after = await postHead(client, target.repo, target.number);
    finish(row, after === row.commit_sha && currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id) ? "submitted" : "submitted_stale", null, null, null, after);
    return;
  }
  const resolved = githubThreadDraft(row.workspace_id, target.revision, row.local_thread_id!);
  if (!resolved.ok || resolved.draft.body !== row.body || resolved.localEntryId !== row.local_entry_id) throw new GithubGraphqlTargetError("The exact local code thread no longer matches this submission.");
  const draft = resolved.draft;
  if (row.attempts > 1 || row.github_review_id || row.github_comment_id) {
    const recovered = await recoverThread(row, client, target, draft);
    if (recovered === "adopted") return;
    if (recovered === "unknown") { finish(row, "unknown", "recovery_ambiguous", "GitHub may already hold this review thread. Seer will not post a duplicate.", null); return; }
  }
  const before = await client.pullRequest(target.repo, target.number);
  await requireMutationBudget(before.rate.remaining, before.rate.resetAt);
  if (before.headRefOid !== row.commit_sha) throw new GithubGraphqlTargetError("The pull request head moved before the thread could be posted.");
  db.run("UPDATE review_github_submissions SET head_before=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?", [before.headRefOid, Date.now(), row.id, row.lease_token]);
  if (!stillOwns(row)) return;
  markMutationStarted();
  const result = await client.addReview({ pullRequestId: before.id, commitOID: row.commit_sha, event: "COMMENT", body: "", threads: [draft], clientMutationId: row.id });
  if (result.commentNodeIds.length !== 1) {
    throw new GithubGraphqlTransportError("GitHub accepted the review but returned an ambiguous comment list.", true);
  }
  db.run("UPDATE review_github_submissions SET github_review_id=COALESCE(github_review_id,?),github_comment_id=COALESCE(github_comment_id,?),updated_at=? WHERE id=?", [result.reviewId, result.commentNodeIds[0]!, Date.now(), row.id]);
  if (!await adoptThread(row, client, target, result.reviewId, result.commentNodeIds[0]!)) {
    finish(row, "unknown", "thread_mapping_pending", "GitHub accepted the review, but its thread is not queryable yet. Retry will reconcile it without posting again.", null);
  }
}

async function runVerdict(row: GithubSubmissionRow, client: PersonalGithubGraphqlClient, target: NonNullable<ReturnType<typeof currentRevisionTarget>>, markMutationStarted: () => void): Promise<void> {
  if (row.github_review_id) {
    const after = await postHead(client, target.repo, target.number);
    finish(row, after === row.commit_sha && currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id) ? "submitted" : "submitted_stale", null, null, null, after);
    return;
  }
  if (row.attempts > 1) {
    const recovered = await client.recoverReview({ repo: target.repo, number: target.number, commitOID: row.commit_sha, event: row.kind === "approve" ? "APPROVE" : "REQUEST_CHANGES", body: row.body, createdAt: row.created_at });
    if (recovered.kind === "match") {
      db.run("UPDATE review_github_submissions SET github_review_id=? WHERE id=? AND state='running' AND lease_token=?", [recovered.reviewId, row.id, row.lease_token]);
      const after = await postHead(client, target.repo, target.number);
      finish(row, after === row.commit_sha && currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id) ? "submitted" : "submitted_stale", null, null, null, after);
      return;
    }
    if (recovered.kind === "ambiguous" || Date.now() - row.created_at < RECOVERY_CONSISTENCY_MS) {
      finish(row, "unknown", "recovery_ambiguous", "GitHub may already hold this review. Seer will not submit a duplicate.", null);
      return;
    }
  }
  const before = await client.pullRequest(target.repo, target.number);
  await requireMutationBudget(before.rate.remaining, before.rate.resetAt);
  if (before.headRefOid !== row.commit_sha) throw new GithubGraphqlTargetError("The pull request head moved before the review could be submitted.");
  db.run("UPDATE review_github_submissions SET head_before=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?", [before.headRefOid, Date.now(), row.id, row.lease_token]);
  if (!stillOwns(row)) return;
  markMutationStarted();
  const result = await client.addReview({ pullRequestId: before.id, commitOID: row.commit_sha, event: row.kind === "approve" ? "APPROVE" : "REQUEST_CHANGES", body: row.body, threads: [], clientMutationId: row.id });
  db.run("UPDATE review_github_submissions SET github_review_id=COALESCE(github_review_id,?),updated_at=? WHERE id=?", [result.reviewId, Date.now(), row.id]);
  const after = await postHead(client, target.repo, target.number);
  finish(row, after === row.commit_sha && currentRevisionTarget(row.workspace_id, row.lineage_id, row.revision_id) ? "submitted" : "submitted_stale", null, null, null, after);
}

async function runMapped(row: GithubSubmissionRow, client: PersonalGithubGraphqlClient, target: NonNullable<ReturnType<typeof mappedTarget>>, markMutationStarted: () => void): Promise<void> {
  const before = await client.pullRequest(target.repo, target.number);
  await requireMutationBudget(before.rate.remaining, before.rate.resetAt);
  db.run("UPDATE review_github_submissions SET head_before=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?", [before.headRefOid, Date.now(), row.id, row.lease_token]);
  if (!stillOwns(row)) return;
  if (row.kind === "reply") {
    const linked = row.local_entry_id ? db.query<{ github_comment_id: string; github_database_id: string | null }, [string, string]>(
      "SELECT github_comment_id,github_database_id FROM review_local_github_message_links WHERE workspace_id=? AND local_message_id=?",
    ).get(row.workspace_id, row.local_entry_id) : null;
    if (linked && !row.github_comment_id) {
      db.run("UPDATE review_github_submissions SET github_comment_id=?,updated_at=? WHERE id=?", [linked.github_comment_id, Date.now(), row.id]);
      row = { ...row, github_comment_id: linked.github_comment_id };
    }
    if (row.attempts > 1 && row.failure_code === "mutation_unknown" && !row.github_comment_id) {
      finish(row, "unknown", "reply_recovery_unavailable", "GitHub may already hold this reply. Seer will not post it twice.", null);
      return;
    }
    if (row.github_comment_id) {
      linkSubmittedGithubReply({ workspaceId: row.workspace_id, localThreadId: row.local_thread_id!, localMessageId: row.local_entry_id!, submissionId: row.id, githubCommentId: row.github_comment_id, githubDatabaseId: null });
    } else {
      const local = getLocalThread(row.workspace_id, row.local_thread_id!);
      const message = local?.entries.find((entry) => entry.id === row.local_entry_id);
      if (!message?.body || message.body !== row.body) throw new GithubGraphqlTargetError("The exact local reply no longer matches this submission.");
      markMutationStarted();
      const result = await client.addThreadReply(target.mapping.github_thread_id, row.body, row.id);
      db.run("UPDATE review_github_submissions SET github_comment_id=COALESCE(github_comment_id,?),updated_at=? WHERE id=?", [result.commentNodeId, Date.now(), row.id]);
      linkSubmittedGithubReply({ workspaceId: row.workspace_id, localThreadId: row.local_thread_id!, localMessageId: row.local_entry_id!, submissionId: row.id, githubCommentId: result.commentNodeId, githubDatabaseId: result.databaseId });
    }
  } else {
    const local = getLocalThread(row.workspace_id, row.local_thread_id!);
    const event = row.local_entry_id ? local?.entries.find((entry) => entry.id === row.local_entry_id) : null;
    const resolved = row.kind === "resolve";
    const expectedEntryKind = resolved ? "resolved" : "reopened";
    if (!local || (row.local_entry_id !== null && event?.kind !== expectedEntryKind) || localThreadState(local) !== (resolved ? "resolved" : "open")) throw new GithubGraphqlTargetError("The exact local resolution state no longer matches this submission.");
    if (row.attempts > 1 && row.failure_code === "mutation_unknown") {
      // Resolution mutations return no durable object id. A matching import or webhook
      // marks the submission submitted before it can be claimed again. Still running here
      // means GitHub has not confirmed it, so another mutation would be a guess.
      finish(row, "unknown", "resolution_recovery_pending", "GitHub may already hold this resolution change. Refresh its thread before retrying.", null);
      return;
    }
    if (row.github_thread_id) {
      const after = await postHead(client, target.repo, target.number);
      finish(row, mappedTarget(row) ? "submitted" : "submitted_stale", null, null, null, after);
      return;
    }
    markMutationStarted();
    if (resolved) await client.resolveThread(target.mapping.github_thread_id, row.id);
    else await client.unresolveThread(target.mapping.github_thread_id, row.id);
    db.run("UPDATE review_github_submissions SET github_thread_id=COALESCE(github_thread_id,?),updated_at=? WHERE id=?", [target.mapping.github_thread_id, Date.now(), row.id]);
    linkSubmittedGithubResolution({ workspaceId: row.workspace_id, localThreadId: row.local_thread_id!, localEntryId: row.local_entry_id, submissionId: row.id, githubThreadId: target.mapping.github_thread_id, resolved });
  }
  const after = await postHead(client, target.repo, target.number);
  finish(row, mappedTarget(row) ? "submitted" : "submitted_stale", null, null, null, after);
}

function credentialDeadMessage(row: GithubSubmissionRow): string | null {
  const credential = getGithubUserCredential(row.credential_id, row.user_id);
  if (!credential) return "The selected GitHub credential is no longer available. Choose another credential and retry.";
  if (credential.revoked_at !== null) return "The selected GitHub credential was revoked. Choose another credential and retry.";
  if (credential.dead_at !== null) return "GitHub no longer accepts the selected credential. Reconnect it or choose another credential.";
  if (credential.expires_at !== null && credential.expires_at <= Date.now()) return "The selected GitHub credential expired. Choose another credential and retry.";
  return null;
}

async function runSubmission(row: GithubSubmissionRow): Promise<void> {
  let mutationMayHaveStarted = false;
  const markMutationStarted = (): void => {
    const startedAt = Date.now();
    const recorded = db.run(
      "UPDATE review_github_submissions SET mutation_started_at=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?",
      [startedAt, startedAt, row.id, row.lease_token],
    ).changes;
    if (recorded !== 1) throw new GithubGraphqlTargetError("The submission lease changed before its GitHub mutation.");
    mutationMayHaveStarted = true;
  };
  try {
    const credentialFailure = credentialDeadMessage(row);
    if (credentialFailure) {
      finish(row, "refused", "credential_dead", credentialFailure, null);
      return;
    }
    const target = storedTarget(row);
    if (!target) throw new GithubGraphqlTargetError("The pull request or exact local target moved or was deleted before submission.");
    const client = personalGithubGraphqlClient(row.user_id, row.credential_id);
    if (row.kind === "thread") await runThread(row, client, target as NonNullable<ReturnType<typeof currentRevisionTarget>>, markMutationStarted);
    else if (row.kind === "approve" || row.kind === "request_changes") await runVerdict(row, client, target as NonNullable<ReturnType<typeof currentRevisionTarget>>, markMutationStarted);
    else await runMapped(row, client, target as NonNullable<ReturnType<typeof mappedTarget>>, markMutationStarted);
  } catch (error) {
    let failure = projectionFailure(error, row.attempts);
    // A fake or adapter may overstate a read transport error. Only a failure after this
    // worker reached a mutating call can have an unknown side effect.
    if (failure.state === "unknown" && !mutationMayHaveStarted) {
      failure = { state: "failed", code: error instanceof GithubGraphqlTransportError ? error.code : "projection_failed", message: error instanceof Error ? error.message.slice(0, 600) : "GitHub projection failed.", retryAt: null };
    }
    finish(row, failure.state === "stale" ? "refused" : failure.state, failure.code, failure.message, failure.retryAt);
  }
}

export async function runNextGithubSubmission(credentialId: string): Promise<boolean> {
  const row = claimSubmission(credentialId);
  if (!row) return false;
  await runSubmission(row);
  return true;
}

export function pendingGithubSubmissionCredentials(now = Date.now()): string[] {
  return db.query<{ credential_id: string }, [number, number, number]>(
    "SELECT DISTINCT credential_id FROM review_github_submissions WHERE state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?)",
  ).all(GITHUB_SUBMISSION_ATTEMPTS_MAX, now, now).map((row) => row.credential_id);
}
