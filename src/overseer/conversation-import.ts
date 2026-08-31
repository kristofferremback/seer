import { randomBytes } from "node:crypto";
import { db } from "../db";
import { tinyId } from "../ids";
import { IMPORT_FAILURE_MAX, IMPORT_LEASE_MS, ConversationError } from "./conversation-types";
import { openGraphqlReadSession, type ReadActor } from "./github-app";
import type { GithubConversationSnapshot, GithubReviewObservation, GithubReviewThread } from "./github-graphql";
import { digestOf, type ReviewLineageRow } from "./revision-db";
import { readActorOf, type ReviewPrObservationRow } from "./revision-pr";
import {
  attachImportedGithubThread,
  confirmImportedGithubResolution,
  linkImportedGithubComment,
} from "./github-thread-sync";

export interface ConversationImportRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  observation_id: string;
  state: "running" | "completed" | "failed";
  complete: number;
  truncated: number;
  thread_count: number;
  comment_count: number;
  review_count: number;
  logical_body_bytes: number;
  failure: string | null;
  actor_kind: ReadActor["kind"];
  installation_id: number | null;
  user_id: string | null;
  credential_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  started_at: number;
  completed_at: number | null;
}

export interface GithubThreadObservationRow {
  id: string; workspace_id: string; thread_id: string; source_kind: "graphql" | "webhook"; source_id: string;
  source_observed_at: number; path: string | null; side: "old" | "new" | null; start_line: number | null; end_line: number | null;
  original_start_line: number | null; original_end_line: number | null; commit_sha: string | null; original_commit_sha: string | null;
  resolved: number; outdated: number; deleted: number; github_url: string | null; digest: string; observed_at: number;
}
export interface GithubCommentObservationRow {
  id: string; workspace_id: string; comment_id: string; source_kind: "graphql" | "webhook"; source_id: string;
  source_observed_at: number; author_login: string | null; body: string | null; github_url: string | null;
  github_updated_at: number; deleted: number; digest: string; observed_at: number;
}
export interface GithubReviewObservationRow {
  id: string; workspace_id: string; review_id: string; source_kind: "graphql" | "webhook"; source_id: string;
  source_observed_at: number; author_login: string | null; state: GithubReviewObservation["state"];
  commit_sha: string | null; body: string | null; github_url: string | null; submitted_at: number | null;
  dismissed: number; deleted: number; digest: string; observed_at: number;
}

function actorColumns(actor: ReadActor): [number | null, string | null, string | null] {
  return actor.kind === "installation" ? [actor.installationId, null, null]
    : actor.kind === "user" ? [null, actor.userId, actor.credentialId] : [null, null, null];
}

export function getConversationImport(workspaceId: string, id: string): ConversationImportRow | null {
  return db.query<ConversationImportRow, [string, string]>("SELECT * FROM review_conversation_imports WHERE workspace_id = ? AND id = ?").get(workspaceId, id);
}

export function latestImportedConversation(workspaceId: string, lineageId: string): ConversationImportRow | null {
  return db.query<ConversationImportRow, [string, string]>(
    "SELECT * FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(workspaceId, lineageId);
}

export function conversationImportRunning(workspaceId: string, lineageId: string, now = Date.now()): boolean {
  return !!db.query<{ id: string }, [string, string, number]>(
    "SELECT id FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ? AND state = 'running' AND lease_expires_at > ? LIMIT 1",
  ).get(workspaceId, lineageId, now);
}

export const startConversationImport = db.transaction((input: {
  workspaceId: string; lineageId: string; observationId: string; actor: ReadActor; now?: number;
}): ConversationImportRow => {
  const now = input.now ?? Date.now();
  db.run(
    "UPDATE review_conversation_imports SET state = 'failed', failure = 'Conversation refresh lease expired.', lease_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE workspace_id = ? AND lineage_id = ? AND state = 'running' AND lease_expires_at <= ?",
    [now, input.workspaceId, input.lineageId, now],
  );
  if (conversationImportRunning(input.workspaceId, input.lineageId, now)) throw new ConversationError(409, "conversation_refresh_in_progress", "Conversation refresh is already running.");
  const id = tinyId("rci");
  const lease = randomBytes(24).toString("base64url");
  const [installation, user, credential] = actorColumns(input.actor);
  db.run(
    "INSERT INTO review_conversation_imports (id, workspace_id, lineage_id, observation_id, state, actor_kind, installation_id, user_id, credential_id, lease_token, lease_expires_at, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.lineageId, input.observationId, input.actor.kind, installation, user, credential, lease, now + IMPORT_LEASE_MS, now],
  );
  return getConversationImport(input.workspaceId, id)!;
}) as (input: { workspaceId: string; lineageId: string; observationId: string; actor: ReadActor; now?: number }) => ConversationImportRow;

function threadIdentity(workspaceId: string, lineageId: string, repoId: number, prNumber: number, thread: GithubReviewThread, observedAt: number): string {
  const firstId = thread.comments[0]?.databaseId ?? null;
  let row = db.query<{ id: string; github_node_id: string | null }, [string, string, string]>(
    "SELECT id, github_node_id FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? AND github_node_id = ?",
  ).get(workspaceId, lineageId, thread.nodeId);
  if (!row && firstId) row = db.query<{ id: string; github_node_id: string | null }, [string, string, string]>(
    "SELECT id, github_node_id FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? AND first_comment_database_id = ?",
  ).get(workspaceId, lineageId, firstId);
  if (row) {
    if (row.github_node_id === null) db.run("UPDATE review_github_threads SET github_node_id = ? WHERE id = ? AND github_node_id IS NULL", [thread.nodeId, row.id]);
    attachImportedGithubThread(workspaceId, lineageId, thread.nodeId, row.id);
    return row.id;
  }
  const id = tinyId("rgt");
  db.run("INSERT INTO review_github_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, workspaceId, lineageId, repoId, prNumber, thread.nodeId, firstId, observedAt]);
  attachImportedGithubThread(workspaceId, lineageId, thread.nodeId, id);
  return id;
}

function insertThreadObservation(workspaceId: string, threadId: string, sourceKind: "graphql" | "webhook", sourceId: string, sourceAt: number, value: Omit<GithubThreadObservationRow, "id" | "workspace_id" | "thread_id" | "source_kind" | "source_id" | "source_observed_at" | "digest" | "observed_at">): string {
  const normalized = { ...value, resolved: value.resolved ? 1 : 0, outdated: value.outdated ? 1 : 0, deleted: value.deleted ? 1 : 0 };
  const digest = digestOf(normalized);
  // Deduplicate only the current state. A resolved, reopened, resolved sequence needs
  // two exact resolved events; collapsing the last one into the first replays stale state.
  const existing = latestThreadObservation(workspaceId, threadId);
  if (existing?.digest === digest) {
    const github = db.query<{ github_node_id: string | null }, [string, string]>(
      "SELECT github_node_id FROM review_github_threads WHERE workspace_id=? AND id=?",
    ).get(workspaceId, threadId);
    if (github?.github_node_id) confirmImportedGithubResolution(workspaceId, github.github_node_id, normalized.resolved === 1, sourceAt);
    return existing.id;
  }
  const id = tinyId("rgo");
  db.run(
    "INSERT INTO review_github_thread_observations (id, workspace_id, thread_id, source_kind, source_id, source_observed_at, path, side, start_line, end_line, original_start_line, original_end_line, commit_sha, original_commit_sha, resolved, outdated, deleted, github_url, digest, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, workspaceId, threadId, sourceKind, sourceId, sourceAt, normalized.path, normalized.side, normalized.start_line, normalized.end_line, normalized.original_start_line, normalized.original_end_line, normalized.commit_sha, normalized.original_commit_sha, normalized.resolved, normalized.outdated, normalized.deleted, normalized.github_url, digest, Date.now()],
  );
  const github = db.query<{ github_node_id: string | null }, [string, string]>(
    "SELECT github_node_id FROM review_github_threads WHERE workspace_id=? AND id=?",
  ).get(workspaceId, threadId);
  if (github?.github_node_id) confirmImportedGithubResolution(workspaceId, github.github_node_id, normalized.resolved === 1, sourceAt);
  return id;
}

function commentIdentity(workspaceId: string, threadId: string, comment: GithubReviewThread["comments"][number], observedAt: number): string {
  const held = db.query<{ id: string }, [string, string, string, string]>(
    "SELECT id FROM review_github_comments WHERE workspace_id = ? AND thread_id = ? AND (github_node_id = ? OR github_database_id = ?) LIMIT 1",
  ).get(workspaceId, threadId, comment.nodeId, comment.databaseId);
  const id = held?.id ?? tinyId("rgc");
  if (!held) db.run("INSERT INTO review_github_comments VALUES (?, ?, ?, ?, ?, ?, ?)", [id, workspaceId, threadId, comment.databaseId, comment.nodeId, comment.createdAt, observedAt]);
  linkImportedGithubComment({ workspaceId, importedThreadId: threadId, importedCommentId: id, githubCommentId: comment.nodeId, githubDatabaseId: comment.databaseId, authorLogin: comment.authorLogin, body: comment.body, now: observedAt });
  return id;
}

function insertCommentObservation(input: { workspaceId: string; commentId: string; sourceKind: "graphql" | "webhook"; sourceId: string; sourceAt: number; author: string | null; body: string | null; url: string | null; updatedAt: number; deleted: boolean }): string {
  const digest = digestOf({ author: input.author, body: input.body, url: input.url, updatedAt: input.updatedAt, deleted: input.deleted });
  const existing = db.query<{ id: string }, [string, string, number]>("SELECT id FROM review_github_comment_observations WHERE comment_id = ? AND digest = ? AND deleted = ?").get(input.commentId, digest, input.deleted ? 1 : 0);
  if (existing) return existing.id;
  const id = tinyId("rgo");
  db.run(
    "INSERT INTO review_github_comment_observations (id, workspace_id, comment_id, source_kind, source_id, source_observed_at, author_login, body, github_url, github_updated_at, deleted, digest, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.commentId, input.sourceKind, input.sourceId, input.sourceAt, input.author, input.deleted ? null : input.body, input.url, input.updatedAt, input.deleted ? 1 : 0, digest, Date.now()],
  );
  return id;
}

function reviewIdentity(workspaceId: string, lineageId: string, review: GithubReviewObservation, observedAt: number): string {
  const held = db.query<{ id: string }, [string, string, string, string]>("SELECT id FROM review_github_reviews WHERE workspace_id = ? AND lineage_id = ? AND (github_node_id = ? OR github_database_id = ?) LIMIT 1").get(workspaceId, lineageId, review.nodeId, review.databaseId);
  if (held) return held.id;
  const id = tinyId("rgr");
  db.run("INSERT INTO review_github_reviews VALUES (?, ?, ?, ?, ?, ?)", [id, workspaceId, lineageId, review.databaseId, review.nodeId, observedAt]);
  return id;
}

function insertReviewObservation(input: { workspaceId: string; reviewId: string; sourceKind: "graphql" | "webhook"; sourceId: string; sourceAt: number; review: GithubReviewObservation; deleted?: boolean }): string {
  const normalized = { ...input.review, deleted: input.deleted === true };
  const digest = digestOf(normalized);
  const held = db.query<{ id: string }, [string, string]>("SELECT id FROM review_github_review_observations WHERE review_id = ? AND digest = ?").get(input.reviewId, digest);
  if (held) return held.id;
  const id = tinyId("rgo");
  db.run(
    "INSERT INTO review_github_review_observations (id, workspace_id, review_id, source_kind, source_id, source_observed_at, author_login, state, commit_sha, body, github_url, submitted_at, dismissed, deleted, digest, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.reviewId, input.sourceKind, input.sourceId, input.sourceAt, normalized.authorLogin, normalized.state, normalized.commitSha, normalized.deleted ? null : normalized.body, normalized.url, normalized.submittedAt, normalized.dismissed ? 1 : 0, normalized.deleted ? 1 : 0, digest, Date.now()],
  );
  return id;
}

export const applyConversationSnapshot = db.transaction((input: {
  importRow: ConversationImportRow; lineage: ReviewLineageRow; observation: ReviewPrObservationRow; snapshot: GithubConversationSnapshot;
}): void => {
  const current = getConversationImport(input.importRow.workspace_id, input.importRow.id);
  if (!current || current.state !== "running" || current.lease_token !== input.importRow.lease_token || (current.lease_expires_at ?? 0) <= Date.now()) {
    throw new ConversationError(409, "conversation_refresh_lease_lost", "Conversation refresh lost its lease.");
  }
  const seenThreads = new Set<string>();
  const seenComments = new Set<string>();
  const seenReviews = new Set<string>();
  for (const thread of input.snapshot.threads) {
    const threadId = threadIdentity(current.workspace_id, current.lineage_id, input.observation.repo_id, input.observation.pr_number, thread, current.started_at);
    seenThreads.add(threadId);
    insertThreadObservation(current.workspace_id, threadId, "graphql", current.id, current.started_at, {
      path: thread.path, side: thread.side, start_line: thread.startLine, end_line: thread.endLine,
      original_start_line: thread.originalStartLine, original_end_line: thread.originalEndLine,
      commit_sha: thread.commitSha, original_commit_sha: thread.originalCommitSha,
      resolved: thread.resolved ? 1 : 0, outdated: thread.outdated ? 1 : 0, deleted: 0, github_url: thread.url,
    });
    for (const comment of thread.comments) {
      const commentId = commentIdentity(current.workspace_id, threadId, comment, current.started_at);
      seenComments.add(commentId);
      insertCommentObservation({ workspaceId: current.workspace_id, commentId, sourceKind: "graphql", sourceId: current.id, sourceAt: current.started_at, author: comment.authorLogin, body: comment.body, url: comment.url, updatedAt: comment.updatedAt, deleted: false });
    }
  }
  for (const review of input.snapshot.reviews) {
    const reviewId = reviewIdentity(current.workspace_id, current.lineage_id, review, current.started_at);
    seenReviews.add(reviewId);
    insertReviewObservation({ workspaceId: current.workspace_id, reviewId, sourceKind: "graphql", sourceId: current.id, sourceAt: current.started_at, review });
  }
  if (input.snapshot.complete && !input.snapshot.truncated) tombstoneAbsent(current, seenThreads, seenComments, seenReviews);
  const changed = db.run(
    "UPDATE review_conversation_imports SET state = 'completed', complete = ?, truncated = ?, thread_count = ?, comment_count = ?, review_count = ?, logical_body_bytes = ?, failure = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ? AND lease_token = ? AND state = 'running'",
    [input.snapshot.complete ? 1 : 0, input.snapshot.truncated ? 1 : 0, input.snapshot.threads.length, [...seenComments].length, input.snapshot.reviews.length, input.snapshot.logicalBodyBytes, Date.now(), current.id, current.lease_token],
  ).changes;
  if (changed !== 1) throw new ConversationError(409, "conversation_refresh_lease_lost", "Conversation refresh lost its lease.");
}) as (input: { importRow: ConversationImportRow; lineage: ReviewLineageRow; observation: ReviewPrObservationRow; snapshot: GithubConversationSnapshot }) => void;

function tombstoneAbsent(current: ConversationImportRow, seenThreads: Set<string>, seenComments: Set<string>, seenReviews: Set<string>): void {
  const threads = db.query<{ id: string }, [string, string, number]>("SELECT id FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? AND first_observed_at <= ?").all(current.workspace_id, current.lineage_id, current.started_at);
  for (const row of threads) if (!seenThreads.has(row.id)) {
    const latest = latestThreadObservation(current.workspace_id, row.id);
    const newerComment = db.query<{ one: number }, [string, number]>(
      "SELECT 1 AS one FROM review_github_comments c JOIN review_github_comment_observations o ON o.comment_id = c.id WHERE c.thread_id = ? AND o.source_observed_at > ? LIMIT 1",
    ).get(row.id, current.started_at);
    if (!newerComment && latest && latest.deleted !== 1 && latest.source_observed_at <= current.started_at) insertThreadObservation(current.workspace_id, row.id, "graphql", current.id, current.started_at, {
      path: latest.path, side: latest.side, start_line: latest.start_line, end_line: latest.end_line,
      original_start_line: latest.original_start_line, original_end_line: latest.original_end_line,
      commit_sha: latest.commit_sha, original_commit_sha: latest.original_commit_sha,
      resolved: latest.resolved, outdated: latest.outdated, deleted: 1, github_url: latest.github_url,
    });
  }
  const comments = db.query<{ id: string }, [string, string, number]>("SELECT c.id FROM review_github_comments c JOIN review_github_threads t ON t.id = c.thread_id WHERE c.workspace_id = ? AND t.lineage_id = ? AND c.first_observed_at <= ?").all(current.workspace_id, current.lineage_id, current.started_at);
  for (const row of comments) if (!seenComments.has(row.id)) {
    const latest = latestCommentObservation(current.workspace_id, row.id);
    if (latest && latest.deleted !== 1 && latest.source_observed_at <= current.started_at) insertCommentObservation({ workspaceId: current.workspace_id, commentId: row.id, sourceKind: "graphql", sourceId: current.id, sourceAt: current.started_at, author: latest.author_login, body: null, url: latest.github_url, updatedAt: Math.max(latest.github_updated_at, current.started_at), deleted: true });
  }
  const reviews = db.query<{ id: string }, [string, string, number]>("SELECT id FROM review_github_reviews WHERE workspace_id = ? AND lineage_id = ? AND first_observed_at <= ?").all(current.workspace_id, current.lineage_id, current.started_at);
  for (const row of reviews) if (!seenReviews.has(row.id)) {
    const latest = latestReviewObservation(current.workspace_id, row.id);
    if (latest && latest.deleted !== 1 && latest.source_observed_at <= current.started_at) insertReviewObservation({ workspaceId: current.workspace_id, reviewId: row.id, sourceKind: "graphql", sourceId: current.id, sourceAt: current.started_at, review: { databaseId: "0", nodeId: "deleted", authorLogin: latest.author_login, state: latest.state, body: "", url: latest.github_url, commitSha: latest.commit_sha, submittedAt: latest.submitted_at, dismissed: latest.dismissed === 1 }, deleted: true });
  }
}

export async function runConversationImport(workspaceId: string, lineage: ReviewLineageRow, observation: ReviewPrObservationRow, row: ConversationImportRow): Promise<ConversationImportRow> {
  const actor = readActorOf(row);
  try {
    const session = await openGraphqlReadSession(workspaceId, actor, observation.repo, observation.repo_id);
    const snapshot = await session.reader.listReviewThreads(observation.repo, observation.pr_number);
    applyConversationSnapshot({ importRow: row, lineage, observation, snapshot });
  } catch (error) {
    const failure = (error instanceof Error ? error.message : String(error)).slice(0, IMPORT_FAILURE_MAX);
    db.run("UPDATE review_conversation_imports SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ? AND lease_token = ? AND state = 'running'", [failure, Date.now(), row.id, row.lease_token]);
  }
  return getConversationImport(workspaceId, row.id)!;
}

export function latestThreadObservation(workspaceId: string, threadId: string): GithubThreadObservationRow | null {
  return db.query<GithubThreadObservationRow, [string, string]>("SELECT * FROM review_github_thread_observations WHERE workspace_id = ? AND thread_id = ? ORDER BY source_observed_at DESC, observed_at DESC, rowid DESC LIMIT 1").get(workspaceId, threadId);
}
export function latestCommentObservation(workspaceId: string, commentId: string): GithubCommentObservationRow | null {
  const terminal = db.query<GithubCommentObservationRow, [string, string]>("SELECT * FROM review_github_comment_observations WHERE workspace_id = ? AND comment_id = ? AND deleted = 1 ORDER BY github_updated_at DESC, source_observed_at DESC, observed_at DESC, rowid DESC LIMIT 1").get(workspaceId, commentId);
  return terminal ?? db.query<GithubCommentObservationRow, [string, string]>("SELECT * FROM review_github_comment_observations WHERE workspace_id = ? AND comment_id = ? ORDER BY github_updated_at DESC, source_observed_at DESC, observed_at DESC, rowid DESC LIMIT 1").get(workspaceId, commentId);
}
export function latestReviewObservation(workspaceId: string, reviewId: string): GithubReviewObservationRow | null {
  return db.query<GithubReviewObservationRow, [string, string]>("SELECT * FROM review_github_review_observations WHERE workspace_id = ? AND review_id = ? ORDER BY source_observed_at DESC, observed_at DESC, rowid DESC LIMIT 1").get(workspaceId, reviewId);
}

// Webhook helpers accept normalized facts. Callers have already verified receipt ownership.
export function recordGithubThreadWebhook(input: { workspaceId: string; lineageId: string; repoId: number; prNumber: number; sourceId: string; sourceAt: number; nodeId: string | null; firstCommentDatabaseId: string | null; resolved: boolean; deleted?: boolean; path?: string | null; side?: "old" | "new" | null; startLine?: number | null; endLine?: number | null; commitSha?: string | null; originalCommitSha?: string | null; githubUrl?: string | null }): string {
  let held = input.nodeId ? db.query<{ id: string }, [string, string, string]>("SELECT id FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? AND github_node_id = ?").get(input.workspaceId, input.lineageId, input.nodeId) : null;
  if (!held && input.firstCommentDatabaseId) held = db.query<{ id: string }, [string, string, string]>("SELECT id FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? AND first_comment_database_id = ?").get(input.workspaceId, input.lineageId, input.firstCommentDatabaseId);
  const id = held?.id ?? tinyId("rgt");
  if (!held) db.run("INSERT INTO review_github_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, input.workspaceId, input.lineageId, input.repoId, input.prNumber, input.nodeId, input.firstCommentDatabaseId, input.sourceAt]);
  else if (input.nodeId) db.run("UPDATE review_github_threads SET github_node_id = ? WHERE id = ? AND github_node_id IS NULL", [input.nodeId, id]);
  if (input.nodeId) attachImportedGithubThread(input.workspaceId, input.lineageId, input.nodeId, id);
  // A comment webhook can establish an unknown identity but carries no thread state. It
  // must not reopen a thread merely because a newer comment arrived.
  if (held && input.nodeId === null) return id;
  const prior = latestThreadObservation(input.workspaceId, id);
  insertThreadObservation(input.workspaceId, id, "webhook", input.sourceId, input.sourceAt, { path: input.path ?? prior?.path ?? null, side: input.side ?? prior?.side ?? null, start_line: input.startLine ?? prior?.start_line ?? null, end_line: input.endLine ?? prior?.end_line ?? null, original_start_line: prior?.original_start_line ?? null, original_end_line: prior?.original_end_line ?? null, commit_sha: input.commitSha ?? prior?.commit_sha ?? null, original_commit_sha: input.originalCommitSha ?? prior?.original_commit_sha ?? null, resolved: input.resolved ? 1 : 0, outdated: prior?.outdated ?? 0, deleted: input.deleted ? 1 : 0, github_url: input.githubUrl ?? prior?.github_url ?? null });
  return id;
}

export function recordGithubCommentWebhook(input: { workspaceId: string; threadId: string; sourceId: string; sourceAt: number; databaseId: string; nodeId: string; createdAt: number; updatedAt: number; authorLogin: string | null; body: string | null; githubUrl: string | null; deleted: boolean }): string {
  const fake = { databaseId: input.databaseId, nodeId: input.nodeId, createdAt: input.createdAt, authorLogin: input.authorLogin, body: input.body } as GithubReviewThread["comments"][number];
  const id = commentIdentity(input.workspaceId, input.threadId, fake, input.sourceAt);
  insertCommentObservation({ workspaceId: input.workspaceId, commentId: id, sourceKind: "webhook", sourceId: input.sourceId, sourceAt: input.sourceAt, author: input.authorLogin, body: input.body, url: input.githubUrl, updatedAt: input.updatedAt, deleted: input.deleted });
  return id;
}

export function recordGithubReviewWebhook(input: { workspaceId: string; lineageId: string; sourceId: string; sourceAt: number; review: GithubReviewObservation; deleted?: boolean }): string {
  const id = reviewIdentity(input.workspaceId, input.lineageId, input.review, input.sourceAt);
  insertReviewObservation({ workspaceId: input.workspaceId, reviewId: id, sourceKind: "webhook", sourceId: input.sourceId, sourceAt: input.sourceAt, review: input.review, deleted: input.deleted });
  return id;
}
