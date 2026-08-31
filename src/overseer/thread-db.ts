import { db } from "../db";
import { tinyId } from "../ids";
import { projectAgent, projectMember } from "./actor-projection";
import {
  ConversationError,
  MAX_LOCAL_BODY_BYTES_PER_SCOPE,
  MAX_LOCAL_THREADS_PER_SCOPE,
  MAX_THREAD_ENTRIES,
  validateThreadBody,
  type ProjectedLocalThread,
  type ReviewThreadRow,
  type ThreadAnchorRow,
  type ThreadEntryKind,
  type ThreadEntryRow,
} from "./conversation-types";
import { digestOf } from "./revision-db";
import type { ValidatedThreadAnchor } from "./thread-anchors";

export type ThreadAuthor =
  | { kind: "member"; userId: string }
  | { kind: "agent"; userId: string; keyId: string; name: string; model: string };

interface ThreadIdempotencyRow {
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  operation: "create" | "reply" | "resolve" | "reopen";
  thread_id: string;
  entry_id: string;
  created_at: number;
}

export interface LocalThreadRecord {
  thread: ReviewThreadRow;
  anchor: ThreadAnchorRow;
  entries: ThreadEntryRow[];
}

function authorHash(author: ThreadAuthor) {
  return author.kind === "member"
    ? { kind: author.kind, userId: author.userId }
    : { kind: author.kind, userId: author.userId, keyId: author.keyId, name: author.name, model: author.model };
}

function budgetDocumentId(scopeKind: ReviewThreadRow["scope_kind"], anchor: ThreadAnchorRow | ValidatedThreadAnchor): string {
  const id = scopeKind === "lineage" ? anchor.account_id ?? anchor.revision_id : anchor.stack_account_id;
  if (!id) throw new Error(`A ${scopeKind} thread anchor has no immutable budget document`);
  return id;
}

function replay(workspaceId: string, key: string, hash: string, operation: ThreadIdempotencyRow["operation"]): LocalThreadRecord | null {
  const held = db.query<ThreadIdempotencyRow, [string, string]>(
    "SELECT * FROM review_thread_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, key);
  if (!held) return null;
  if (held.request_hash !== hash || held.operation !== operation) {
    throw new ConversationError(409, "idempotency_conflict", "This idempotency key was already used for another thread write.");
  }
  const result = getLocalThread(workspaceId, held.thread_id);
  if (!result) throw new Error(`Thread idempotency ${workspaceId}/${key} points at a missing thread`);
  return result;
}

function insertEntry(threadId: string, workspaceId: string, seq: number, kind: ThreadEntryKind, author: ThreadAuthor, body: string | null, now: number): ThreadEntryRow {
  const id = tinyId("rte");
  db.run(
    "INSERT INTO review_thread_entries (id, thread_id, workspace_id, seq, kind, author_kind, user_id, key_id, agent_name, agent_model, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, threadId, workspaceId, seq, kind, author.kind, author.userId, author.kind === "agent" ? author.keyId : null, author.kind === "agent" ? author.name : null, author.kind === "agent" ? author.model : null, body, now],
  );
  return db.query<ThreadEntryRow, [string]>("SELECT * FROM review_thread_entries WHERE id = ?").get(id)!;
}

function insertIdempotency(workspaceId: string, key: string, hash: string, operation: ThreadIdempotencyRow["operation"], threadId: string, entryId: string, now: number): void {
  db.run(
    "INSERT INTO review_thread_idempotency (workspace_id, idempotency_key, request_hash, operation, thread_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [workspaceId, key, hash, operation, threadId, entryId, now],
  );
}

export const createLocalThread = db.transaction((input: {
  workspaceId: string;
  scopeKind: "lineage" | "stack";
  scopeId: string;
  anchor: ValidatedThreadAnchor;
  body: string;
  author: Extract<ThreadAuthor, { kind: "member" }>;
  idempotencyKey: string;
}): LocalThreadRecord => {
  const body = validateThreadBody(input.body);
  const hash = digestOf({ operation: "create", scopeKind: input.scopeKind, scopeId: input.scopeId, anchor: input.anchor, body, author: authorHash(input.author) });
  const held = replay(input.workspaceId, input.idempotencyKey, hash, "create");
  if (held) return held;
  const bytes = Buffer.byteLength(body);
  const documentId = budgetDocumentId(input.scopeKind, input.anchor);
  db.run("INSERT OR IGNORE INTO review_thread_scopes (workspace_id, scope_kind, document_id) VALUES (?, ?, ?)", [input.workspaceId, input.scopeKind, documentId]);
  const changed = db.run(
    "UPDATE review_thread_scopes SET local_thread_count = local_thread_count + 1, local_body_bytes = local_body_bytes + ? WHERE workspace_id = ? AND scope_kind = ? AND document_id = ? AND local_thread_count < ? AND local_body_bytes + ? <= ?",
    [bytes, input.workspaceId, input.scopeKind, documentId, MAX_LOCAL_THREADS_PER_SCOPE, bytes, MAX_LOCAL_BODY_BYTES_PER_SCOPE],
  ).changes;
  if (changed !== 1) throw new ConversationError(422, "thread_scope_limit", "This document has reached its local discussion limit.");
  const id = tinyId("rth");
  const now = Date.now();
  db.run(
    "INSERT INTO review_threads (id, workspace_id, scope_kind, lineage_id, stack_id, created_by_user_id, append_version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
    [id, input.workspaceId, input.scopeKind, input.scopeKind === "lineage" ? input.scopeId : null, input.scopeKind === "stack" ? input.scopeId : null, input.author.userId, now],
  );
  const anchor = { thread_id: id, ...input.anchor };
  db.run(
    "INSERT INTO review_thread_anchors (thread_id, workspace_id, anchor_kind, lineage_id, revision_id, account_id, stack_id, stack_manifest_id, stack_account_id, group_id, change_id, file_id, side, start_line, end_line, range_kind, old_object_digest, new_object_digest, object_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [anchor.thread_id, anchor.workspace_id, anchor.anchor_kind, anchor.lineage_id, anchor.revision_id, anchor.account_id, anchor.stack_id, anchor.stack_manifest_id, anchor.stack_account_id, anchor.group_id, anchor.change_id, anchor.file_id, anchor.side, anchor.start_line, anchor.end_line, anchor.range_kind, anchor.old_object_digest, anchor.new_object_digest, anchor.object_digest],
  );
  const entry = insertEntry(id, input.workspaceId, 1, "message", input.author, body, now);
  insertIdempotency(input.workspaceId, input.idempotencyKey, hash, "create", id, entry.id, now);
  return getLocalThread(input.workspaceId, id)!;
}) as (input: {
  workspaceId: string; scopeKind: "lineage" | "stack"; scopeId: string; anchor: ValidatedThreadAnchor;
  body: string; author: Extract<ThreadAuthor, { kind: "member" }>; idempotencyKey: string;
}) => LocalThreadRecord;

function stateOf(entries: ThreadEntryRow[]): "open" | "resolved" {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.kind === "resolved") return "resolved";
    if (entries[index]!.kind === "reopened") return "open";
  }
  return "open";
}

const append = db.transaction((input: {
  workspaceId: string;
  threadId: string;
  operation: "reply" | "resolve" | "reopen";
  body: string | null;
  author: ThreadAuthor;
  idempotencyKey: string;
}): LocalThreadRecord => {
  const body = input.operation === "reply" ? validateThreadBody(input.body) : null;
  if (input.operation !== "reply" && input.author.kind !== "member") throw new ConversationError(403, "actor_forbidden", "Only a session member can change thread resolution.");
  const hash = digestOf({ operation: input.operation, threadId: input.threadId, body, author: authorHash(input.author) });
  const replayed = replay(input.workspaceId, input.idempotencyKey, hash, input.operation);
  if (replayed) return replayed;
  const locked = db.query<{ append_version: number }, [string, string]>(
    "UPDATE review_threads SET append_version = append_version + 1 WHERE id = ? AND workspace_id = ? RETURNING append_version",
  ).get(input.threadId, input.workspaceId);
  if (!locked) throw new ConversationError(404, "thread_unknown", "No such thread.");
  const current = getLocalThread(input.workspaceId, input.threadId)!;
  const state = stateOf(current.entries);
  if (input.operation === "reply" && state === "resolved") throw new ConversationError(409, "thread_resolved", "Reopen this thread before replying.");
  if ((input.operation === "resolve" && state === "resolved") || (input.operation === "reopen" && state === "open")) {
    db.run("UPDATE review_threads SET append_version = append_version - 1 WHERE id = ? AND workspace_id = ?", [input.threadId, input.workspaceId]);
    const existing = [...current.entries].reverse().find((entry) => entry.kind === (input.operation === "resolve" ? "resolved" : "reopened")) ?? current.entries[0]!;
    insertIdempotency(input.workspaceId, input.idempotencyKey, hash, input.operation, input.threadId, existing.id, Date.now());
    return getLocalThread(input.workspaceId, input.threadId)!;
  }
  if (locked.append_version > MAX_THREAD_ENTRIES) throw new ConversationError(422, "thread_entry_limit", "This thread has reached its entry limit.");
  if (body !== null) {
    const bytes = Buffer.byteLength(body);
    const documentId = budgetDocumentId(current.thread.scope_kind, current.anchor);
    const changed = db.run(
      "UPDATE review_thread_scopes SET local_body_bytes = local_body_bytes + ? WHERE workspace_id = ? AND scope_kind = ? AND document_id = ? AND local_body_bytes + ? <= ?",
      [bytes, input.workspaceId, current.thread.scope_kind, documentId, bytes, MAX_LOCAL_BODY_BYTES_PER_SCOPE],
    ).changes;
    if (changed !== 1) throw new ConversationError(422, "thread_scope_limit", "This document has reached its local discussion limit.");
  }
  const kind: ThreadEntryKind = input.operation === "reply" ? "message" : input.operation === "resolve" ? "resolved" : "reopened";
  const now = Date.now();
  const entry = insertEntry(input.threadId, input.workspaceId, locked.append_version, kind, input.author, body, now);
  insertIdempotency(input.workspaceId, input.idempotencyKey, hash, input.operation, input.threadId, entry.id, now);
  return getLocalThread(input.workspaceId, input.threadId)!;
}) as (input: {
  workspaceId: string; threadId: string; operation: "reply" | "resolve" | "reopen";
  body: string | null; author: ThreadAuthor; idempotencyKey: string;
}) => LocalThreadRecord;

export function appendLocalReply(input: { workspaceId: string; threadId: string; body: string; author: ThreadAuthor; idempotencyKey: string }): LocalThreadRecord {
  return append({ ...input, operation: "reply" });
}

export function appendResolutionEvent(input: { workspaceId: string; threadId: string; state: "resolved" | "open"; author: Extract<ThreadAuthor, { kind: "member" }>; idempotencyKey: string }): LocalThreadRecord {
  return append({ workspaceId: input.workspaceId, threadId: input.threadId, operation: input.state === "resolved" ? "resolve" : "reopen", body: null, author: input.author, idempotencyKey: input.idempotencyKey });
}

export function getLocalThread(workspaceId: string, id: string): LocalThreadRecord | null {
  const thread = db.query<ReviewThreadRow, [string, string]>("SELECT * FROM review_threads WHERE workspace_id = ? AND id = ?").get(workspaceId, id);
  if (!thread) return null;
  const anchor = db.query<ThreadAnchorRow, [string, string]>("SELECT * FROM review_thread_anchors WHERE workspace_id = ? AND thread_id = ?").get(workspaceId, id);
  if (!anchor) return null;
  const entries = db.query<ThreadEntryRow, [string, string]>("SELECT * FROM review_thread_entries WHERE workspace_id = ? AND thread_id = ? ORDER BY seq").all(workspaceId, id);
  return { thread, anchor, entries };
}

function records(sql: string, workspaceId: string, targetId: string): LocalThreadRecord[] {
  const ids = db.query<{ id: string }, [string, string]>(sql).all(workspaceId, targetId);
  return ids.map((row) => getLocalThread(workspaceId, row.id)).filter((row): row is LocalThreadRecord => row !== null);
}

export function listLocalThreadsForRevision(workspaceId: string, revisionId: string): LocalThreadRecord[] {
  return records("SELECT DISTINCT t.id FROM review_threads t JOIN review_thread_anchors a ON a.thread_id = t.id WHERE t.workspace_id = ? AND a.revision_id = ? ORDER BY t.created_at, t.id", workspaceId, revisionId);
}

export function listLocalThreadsForAccount(workspaceId: string, accountId: string): LocalThreadRecord[] {
  return records("SELECT DISTINCT t.id FROM review_threads t JOIN review_thread_anchors a ON a.thread_id = t.id WHERE t.workspace_id = ? AND a.account_id = ? ORDER BY t.created_at, t.id", workspaceId, accountId);
}

export function listLocalThreadsForStackAccount(workspaceId: string, accountId: string): LocalThreadRecord[] {
  return records("SELECT DISTINCT t.id FROM review_threads t JOIN review_thread_anchors a ON a.thread_id = t.id WHERE t.workspace_id = ? AND a.stack_account_id = ? ORDER BY t.created_at, t.id", workspaceId, accountId);
}

export function listLocalThreadsForLineage(workspaceId: string, lineageId: string): LocalThreadRecord[] {
  return records("SELECT id FROM review_threads WHERE workspace_id = ? AND lineage_id = ? ORDER BY created_at, id", workspaceId, lineageId);
}

export function localThreadState(record: LocalThreadRecord): "open" | "resolved" {
  return stateOf(record.entries);
}

export function workspaceMemberLabels(workspaceId: string): ReadonlyMap<string, string> {
  const rows = db.query<{ id: string; email: string }, [string]>(
    "SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at, u.id",
  ).all(workspaceId);
  return new Map(rows.map((row) => [row.id, row.email.split("@", 1)[0] || row.email]));
}

export function projectLocalThread(
  record: LocalThreadRecord,
  viewerId: string | null,
  throughSeq = record.thread.append_version,
  memberLabels?: ReadonlyMap<string, string>,
): ProjectedLocalThread {
  const { workspace_id: _workspaceId, ...anchor } = record.anchor;
  return {
    id: record.thread.id,
    anchor,
    state: stateOf(record.entries.filter((entry) => entry.seq <= throughSeq)),
    entries: record.entries.filter((entry) => entry.seq <= throughSeq).map((entry) => ({
      id: entry.id,
      seq: entry.seq,
      kind: entry.kind,
      author: entry.author_kind === "agent"
        ? projectAgent(entry.agent_name!, entry.agent_model!)
        : viewerId !== null && entry.user_id === viewerId
          ? projectMember(true)
          : memberLabels?.has(entry.user_id)
            ? { kind: "member" as const, label: memberLabels.get(entry.user_id)! }
            : projectMember(false),
      body: entry.body,
      createdAt: new Date(entry.created_at).toISOString(),
    })),
    createdAt: new Date(record.thread.created_at).toISOString(),
  };
}
