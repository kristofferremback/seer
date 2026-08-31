import { db } from "../db";
import type {
  ProjectedGithubThread,
  ProjectedLocalThread,
  ProjectedThreadEntry,
} from "./conversation-types";

export interface LocalGithubThreadRow {
  local_thread_id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  submission_id: string;
  github_review_id: string;
  github_thread_id: string;
  github_first_comment_id: string;
  imported_thread_id: string | null;
  commit_sha: string;
  mapped_at: number;
}

interface MessageLinkRow {
  github_comment_id: string;
  workspace_id: string;
  local_thread_id: string;
  direction: "out" | "in";
  local_message_id: string | null;
  imported_comment_id: string | null;
  submission_id: string | null;
  github_database_id: string | null;
  linked_at: number;
}

export function getLocalGithubThread(workspaceId: string, localThreadId: string): LocalGithubThreadRow | null {
  return db.query<LocalGithubThreadRow, [string, string]>(
    "SELECT * FROM review_local_github_threads WHERE workspace_id=? AND local_thread_id=?",
  ).get(workspaceId, localThreadId);
}

export interface GithubThreadProjectionState {
  state: "open" | "resolved";
  /** The exact imported observation or submitted transition this reading came from. */
  basis: string;
}

/** The stored GitHub state of one mapped local thread. A submitted transition is
 * causally later when both sources have the same millisecond timestamp, and wins until
 * an imported observation has a strictly later source timestamp. */
export function githubThreadProjectionState(
  workspaceId: string,
  localThreadId: string,
): GithubThreadProjectionState | null {
  const mapping = getLocalGithubThread(workspaceId, localThreadId);
  if (!mapping) return null;
  const imported = mapping.imported_thread_id ? db.query<{ id: string; resolved: number; source_observed_at: number }, [string, string]>(
    "SELECT id,resolved,source_observed_at FROM review_github_thread_observations WHERE workspace_id=? AND thread_id=? ORDER BY source_observed_at DESC,observed_at DESC,rowid DESC LIMIT 1",
  ).get(workspaceId, mapping.imported_thread_id) : null;
  const submitted = db.query<{ id: string; kind: "resolve" | "unresolve"; updated_at: number }, [string, string]>(
    "SELECT id,kind,updated_at FROM review_github_submissions WHERE workspace_id=? AND local_thread_id=? AND kind IN ('resolve','unresolve') AND state IN ('submitted','submitted_stale') ORDER BY updated_at DESC,id DESC LIMIT 1",
  ).get(workspaceId, localThreadId);
  if (submitted && (!imported || submitted.updated_at >= imported.source_observed_at)) {
    return { state: submitted.kind === "resolve" ? "resolved" : "open", basis: `submission:${submitted.id}` };
  }
  if (imported) return { state: imported.resolved === 1 ? "resolved" : "open", basis: `observation:${imported.id}` };
  return { state: "open", basis: `mapping:${mapping.github_thread_id}` };
}

export function mapSubmittedGithubThread(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  localThreadId: string;
  localMessageId: string;
  submissionId: string;
  githubReviewId: string;
  githubThreadId: string;
  githubCommentId: string;
  commitSha: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const imported = db.query<{ id: string }, [string, string, string]>(
    "SELECT id FROM review_github_threads WHERE workspace_id=? AND lineage_id=? AND github_node_id=?",
  ).get(input.workspaceId, input.lineageId, input.githubThreadId);
  db.run(
    "INSERT INTO review_local_github_threads (local_thread_id,workspace_id,lineage_id,revision_id,submission_id,github_review_id,github_thread_id,github_first_comment_id,imported_thread_id,commit_sha,mapped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_thread_id) DO NOTHING",
    [input.localThreadId, input.workspaceId, input.lineageId, input.revisionId, input.submissionId, input.githubReviewId, input.githubThreadId, input.githubCommentId, imported?.id ?? null, input.commitSha, now],
  );
  db.run(
    "INSERT INTO review_local_github_message_links (github_comment_id,workspace_id,local_thread_id,direction,local_message_id,submission_id,linked_at) VALUES (?,?,?,'out',?,?,?) ON CONFLICT(github_comment_id) DO UPDATE SET local_message_id=COALESCE(review_local_github_message_links.local_message_id,excluded.local_message_id),submission_id=COALESCE(review_local_github_message_links.submission_id,excluded.submission_id)",
    [input.githubCommentId, input.workspaceId, input.localThreadId, input.localMessageId, input.submissionId, now],
  );
}

export function linkSubmittedGithubReply(input: {
  workspaceId: string;
  localThreadId: string;
  localMessageId: string;
  submissionId: string;
  githubCommentId: string;
  githubDatabaseId: string | null;
  now?: number;
}): void {
  db.run(
    "INSERT INTO review_local_github_message_links (github_comment_id,workspace_id,local_thread_id,direction,local_message_id,submission_id,github_database_id,linked_at) VALUES (?,?,?,'out',?,?,?,?) ON CONFLICT(github_comment_id) DO UPDATE SET local_message_id=COALESCE(review_local_github_message_links.local_message_id,excluded.local_message_id),submission_id=COALESCE(review_local_github_message_links.submission_id,excluded.submission_id),github_database_id=COALESCE(review_local_github_message_links.github_database_id,excluded.github_database_id)",
    [input.githubCommentId, input.workspaceId, input.localThreadId, input.localMessageId, input.submissionId, input.githubDatabaseId, input.now ?? Date.now()],
  );
}

export function linkSubmittedGithubResolution(input: {
  workspaceId: string;
  localThreadId: string;
  localEntryId: string | null;
  submissionId: string;
  githubThreadId: string;
  resolved: boolean;
  now?: number;
}): void {
  db.run(
    "INSERT INTO review_local_github_resolution_links (submission_id,workspace_id,local_thread_id,local_entry_id,github_thread_id,resolved,linked_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(submission_id) DO NOTHING",
    [input.submissionId, input.workspaceId, input.localThreadId, input.localEntryId, input.githubThreadId, input.resolved ? 1 : 0, input.now ?? Date.now()],
  );
}

export function attachImportedGithubThread(
  workspaceId: string,
  lineageId: string,
  githubThreadId: string,
  importedThreadId: string,
): void {
  db.run(
    "UPDATE review_local_github_threads SET imported_thread_id=? WHERE workspace_id=? AND lineage_id=? AND github_thread_id=? AND (imported_thread_id IS NULL OR imported_thread_id=?)",
    [importedThreadId, workspaceId, lineageId, githubThreadId, importedThreadId],
  );
}

function normalizedGithubBody(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function linkImportedGithubComment(input: {
  workspaceId: string;
  importedThreadId: string;
  importedCommentId: string;
  githubCommentId: string;
  githubDatabaseId: string;
  authorLogin: string | null;
  body: string | null;
  now?: number;
}): void {
  let mapping = db.query<LocalGithubThreadRow, [string, string]>(
    "SELECT * FROM review_local_github_threads WHERE workspace_id=? AND imported_thread_id=?",
  ).get(input.workspaceId, input.importedThreadId);
  if (!mapping) {
    mapping = db.query<LocalGithubThreadRow, [string, string]>(
      "SELECT * FROM review_local_github_threads WHERE workspace_id=? AND github_first_comment_id=?",
    ).get(input.workspaceId, input.githubCommentId);
    if (mapping && mapping.imported_thread_id === null) {
      db.run("UPDATE review_local_github_threads SET imported_thread_id=? WHERE local_thread_id=? AND workspace_id=? AND imported_thread_id IS NULL", [input.importedThreadId, mapping.local_thread_id, input.workspaceId]);
      mapping = { ...mapping, imported_thread_id: input.importedThreadId };
    }
  }
  if (!mapping) return;
  const held = db.query<MessageLinkRow, [string]>(
    "SELECT * FROM review_local_github_message_links WHERE github_comment_id=?",
  ).get(input.githubCommentId);
  if (held) {
    if (held.workspace_id === input.workspaceId && held.local_thread_id === mapping.local_thread_id) {
      db.run(
        "UPDATE review_local_github_message_links SET imported_comment_id=COALESCE(imported_comment_id,?),github_database_id=COALESCE(github_database_id,?) WHERE github_comment_id=?",
        [input.importedCommentId, input.githubDatabaseId, input.githubCommentId],
      );
    }
    return;
  }

  const outbound = input.authorLogin && input.body !== null ? db.query<{
    id: string;
    local_entry_id: string;
    account_login: string;
    body: string;
  }, [string, string]>(
    "SELECT s.id,s.local_entry_id,c.account_login,s.body FROM review_github_submissions s JOIN github_user_credentials c ON c.id=s.credential_id AND c.user_id=s.user_id JOIN review_thread_entries e ON e.id=s.local_entry_id AND e.thread_id=s.local_thread_id AND e.author_kind='member' AND e.user_id=s.user_id WHERE s.workspace_id=? AND s.local_thread_id=? AND s.kind='reply' AND s.state='unknown' AND s.github_comment_id IS NULL ORDER BY s.created_at,s.id",
  ).all(input.workspaceId, mapping.local_thread_id).filter((candidate) =>
    candidate.account_login.toLowerCase() === input.authorLogin!.toLowerCase() &&
    normalizedGithubBody(candidate.body) === normalizedGithubBody(input.body!)) : [];

  if (outbound.length === 1) {
    const match = outbound[0]!;
    db.transaction(() => {
      db.run(
        "INSERT INTO review_local_github_message_links (github_comment_id,workspace_id,local_thread_id,direction,local_message_id,imported_comment_id,submission_id,github_database_id,linked_at) VALUES (?,?,?,'out',?,?,?,?,?)",
        [input.githubCommentId, input.workspaceId, mapping!.local_thread_id, match.local_entry_id, input.importedCommentId, match.id, input.githubDatabaseId, input.now ?? Date.now()],
      );
      db.run(
        "UPDATE review_github_submissions SET github_comment_id=?,state='submitted',failure_code=NULL,failure=NULL,retry_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='unknown' AND github_comment_id IS NULL",
        [input.githubCommentId, input.now ?? Date.now(), match.id],
      );
    })();
    return;
  }

  db.run(
    "INSERT INTO review_local_github_message_links (github_comment_id,workspace_id,local_thread_id,direction,imported_comment_id,github_database_id,linked_at) VALUES (?,?,?,'in',?,?,?)",
    [input.githubCommentId, input.workspaceId, mapping.local_thread_id, input.importedCommentId, input.githubDatabaseId, input.now ?? Date.now()],
  );
}

/** A webhook or import confirming an uncertain outbound resolution can adopt that exact
 * event. A running holder owns its lease until it finishes, even when GitHub reports the
 * side effect before the mutation response returns. */
export function confirmImportedGithubResolution(
  workspaceId: string,
  githubThreadId: string,
  resolved: boolean,
  sourceObservedAt: number,
): void {
  const row = db.query<{ submission_id: string }, [string, string, number, number]>(
    "SELECT l.submission_id FROM review_local_github_resolution_links l JOIN review_github_submissions s ON s.id=l.submission_id WHERE l.workspace_id=? AND l.github_thread_id=? AND l.resolved=? AND s.state='unknown' AND s.mutation_started_at IS NOT NULL AND s.mutation_started_at<=? ORDER BY s.created_at DESC LIMIT 1",
  ).get(workspaceId, githubThreadId, resolved ? 1 : 0, sourceObservedAt);
  if (!row) return;
  db.run(
    "UPDATE review_github_submissions SET state='submitted',failure_code=NULL,failure=NULL,retry_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='unknown'",
    [Date.now(), row.submission_id],
  );
}

export function mergeMappedGithubConversation(
  workspaceId: string,
  lineageId: string,
  local: ProjectedLocalThread[],
  imported: ProjectedGithubThread[],
): { local: ProjectedLocalThread[]; imported: ProjectedGithubThread[] } {
  const mappings = db.query<LocalGithubThreadRow, [string, string]>(
    "SELECT * FROM review_local_github_threads WHERE workspace_id=? AND lineage_id=? ORDER BY mapped_at",
  ).all(workspaceId, lineageId);
  if (mappings.length === 0) return { local, imported };
  const importedById = new Map(imported.map((thread) => [thread.id, thread]));
  const mappedImported = new Set<string>();
  const projectedLocal = local.map((thread) => {
    const mapping = mappings.find((candidate) => candidate.local_thread_id === thread.id);
    if (!mapping || !mapping.imported_thread_id) return thread;
    const github = importedById.get(mapping.imported_thread_id);
    if (!github) return thread;
    mappedImported.add(github.id);
    const links = db.query<MessageLinkRow, [string, string]>(
      "SELECT * FROM review_local_github_message_links WHERE workspace_id=? AND local_thread_id=? ORDER BY linked_at",
    ).all(workspaceId, thread.id);
    const inboundByComment = new Map(links.filter((link) => link.direction === "in" && link.imported_comment_id).map((link) => [link.imported_comment_id!, link]));
    const maxSeq = thread.entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0);
    const inbound: ProjectedThreadEntry[] = github.comments.flatMap((comment, index) => inboundByComment.has(comment.id) ? [{
      id: comment.id,
      seq: maxSeq + index + 1,
      kind: "message" as const,
      author: comment.author,
      body: comment.deleted ? null : comment.body,
      createdAt: comment.createdAt,
      github: true as const,
      ...(comment.deleted ? { deletedOnGithub: true } : {}),
    }] : []);
    const entries = [...thread.entries, ...inbound].sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.seq - right.seq || left.id.localeCompare(right.id));
    return { ...thread, githubState: github.resolved ? "resolved" as const : "open" as const, entries };
  });
  return { local: projectedLocal, imported: imported.filter((thread) => !mappedImported.has(thread.id)) };
}
