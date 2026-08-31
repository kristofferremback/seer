import type { ProjectedActor } from "./actor-projection";

export const THREAD_BODY_MAX = 4_000;
export const THREAD_AGENT_NAME_MAX = 80;
export const THREAD_AGENT_MODEL_MAX = 80;
export const MAX_THREAD_ENTRIES = 200;
export const MAX_LOCAL_THREADS_PER_SCOPE = 500;
export const MAX_LOCAL_BODY_BYTES_PER_SCOPE = 512 * 1024;
export const MAX_ANCHOR_LINES = 200;
export const MAX_IMPORT_THREADS = 1_000;
export const MAX_IMPORT_COMMENTS_PER_THREAD = 100;
export const MAX_IMPORT_REVIEWS = 1_000;
export const MAX_IMPORT_PAGES = 10;
export const MAX_IMPORT_BODY_BYTES = 1024 * 1024;
export const GRAPHQL_READ_TIMEOUT_MS = 20_000;
export const GRAPHQL_IMPORT_DEADLINE_MS = 60_000;
export const CONVERSATION_REFRESH_COOLDOWN_MS = 60_000;
export const IMPORT_FAILURE_MAX = 600;
// The lease outlives the total import deadline and leaves room to commit its snapshot.
export const IMPORT_LEASE_MS = 10 * 60_000;

export type ThreadAnchorKind = "review" | "account" | "stack" | "member_group" | "stack_group" | "change" | "range";
export type ThreadEntryKind = "message" | "resolved" | "reopened";

export interface ReviewThreadRow {
  id: string;
  workspace_id: string;
  scope_kind: "lineage" | "stack";
  lineage_id: string | null;
  stack_id: string | null;
  created_by_user_id: string;
  append_version: number;
  created_at: number;
}

export interface ThreadAnchorRow {
  thread_id: string;
  workspace_id: string;
  anchor_kind: ThreadAnchorKind;
  lineage_id: string | null;
  revision_id: string | null;
  account_id: string | null;
  stack_id: string | null;
  stack_manifest_id: string | null;
  stack_account_id: string | null;
  group_id: string | null;
  change_id: string | null;
  file_id: string | null;
  side: "old" | "new" | null;
  start_line: number | null;
  end_line: number | null;
  range_kind: "changed" | "unchanged" | null;
  old_object_digest: string | null;
  new_object_digest: string | null;
  object_digest: string | null;
}

export interface ThreadEntryRow {
  id: string;
  thread_id: string;
  workspace_id: string;
  seq: number;
  kind: ThreadEntryKind;
  author_kind: "member" | "agent";
  user_id: string;
  key_id: string | null;
  agent_name: string | null;
  agent_model: string | null;
  body: string | null;
  created_at: number;
}

export interface ProjectedThreadEntry {
  id: string;
  seq: number;
  kind: ThreadEntryKind;
  author: ProjectedActor;
  body: string | null;
  createdAt: string;
  /** Present only for an inbound GitHub reply merged into a mapped local thread. */
  github?: true;
  deletedOnGithub?: boolean;
}

export interface ProjectedLocalThread {
  id: string;
  anchor: Omit<ThreadAnchorRow, "workspace_id">;
  state: "open" | "resolved";
  /** Stored GitHub state for a mapped thread. It never rewrites local resolution. */
  githubState?: "open" | "resolved";
  entries: ProjectedThreadEntry[];
  createdAt: string;
}

export interface GithubCommentProjection {
  id: string;
  author: ProjectedActor;
  body: string | null;
  deleted: boolean;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GithubPlacement {
  kind: "code";
  revisionId: string;
  revision: number;
  fileId: string;
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  objectDigest: string;
}

export type GithubPlacementResult = GithubPlacement | {
  kind: "conversation";
  reason: "outdated" | "commit_not_retained" | "path_not_retained" | "side_not_retained" | "line_not_retained" | "deleted";
};

export interface ProjectedGithubThread {
  id: string;
  resolved: boolean;
  deleted: boolean;
  outdated: boolean;
  url: string | null;
  placement: GithubPlacementResult;
  comments: GithubCommentProjection[];
}

export interface ProjectedGithubReview {
  id: string;
  author: ProjectedActor;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string | null;
  url: string | null;
  commitSha: string | null;
  submittedAt: string | null;
  dismissed: boolean;
  deleted: boolean;
}

export interface WitnessConversationContext {
  local: ProjectedLocalThread[];
  imported: ProjectedGithubThread[];
  reviews: ProjectedGithubReview[];
  import: {
    state: "never" | "completed" | "failed";
    complete: boolean;
    truncated: boolean;
    observedAt: string | null;
  };
}

export class ConversationError extends Error {
  constructor(readonly status: number, readonly rule: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ConversationError";
  }
}

export function validateThreadBody(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConversationError(422, "body_empty", "Message is required.");
  if (value.length > THREAD_BODY_MAX) throw new ConversationError(422, "body_length", `Message is over ${THREAD_BODY_MAX} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) throw new ConversationError(422, "body_control", "Message contains unsupported control characters.");
  return value.trim();
}
