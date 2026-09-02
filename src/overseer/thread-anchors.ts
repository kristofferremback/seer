import { getStageCaptureForWorkspaces, type StageCaptureInventory, type StageCaptureFileRow } from "../stage/db";
import { loadStageBytes, retainedLineWindow } from "../stage/read";
import type { ReviewAccountRow, ReviewLineageRow, ReviewRevisionRow } from "./revision-db";
import type { ReviewStackRow, StackAccountRow, StackManifestRow } from "./stack-db";
import { ConversationError, MAX_ANCHOR_LINES, type ThreadAnchorRow } from "./conversation-types";

export type ThreadAnchorInput =
  | { kind: "review" }
  | { kind: "account"; accountId: string }
  | { kind: "stack"; stackAccountId: string }
  | { kind: "member_group"; accountId: string; groupId: string }
  | { kind: "stack_group"; stackAccountId: string; groupId: string }
  | { kind: "change"; changeId: string }
  | { kind: "range"; fileId: string; side: "old" | "new"; startLine: number; endLine: number };

export interface ReviewThreadContext {
  kind: "review";
  workspaceId: string;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
  inventory: StageCaptureInventory;
}

export interface StackThreadContext {
  kind: "stack";
  workspaceId: string;
  stack: ReviewStackRow;
  manifest: StackManifestRow;
  account: StackAccountRow;
}

export type ValidatedThreadAnchor = Omit<ThreadAnchorRow, "thread_id">;

const empty = (workspaceId: string): Omit<ValidatedThreadAnchor, "workspace_id" | "anchor_kind"> => ({
  lineage_id: null, revision_id: null, account_id: null, stack_id: null,
  stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null,
  file_id: null, side: null, start_line: null, end_line: null, range_kind: null,
  old_object_digest: null, new_object_digest: null, object_digest: null,
});

function reviewOnly(context: ReviewThreadContext | StackThreadContext): ReviewThreadContext {
  if (context.kind !== "review") throw new ConversationError(422, "anchor_scope", "This anchor belongs to a review layer.");
  return context;
}

function stackOnly(context: ReviewThreadContext | StackThreadContext): StackThreadContext {
  if (context.kind !== "stack") throw new ConversationError(422, "anchor_scope", "This anchor belongs to a stack account.");
  return context;
}

function sideFacts(file: StageCaptureFileRow, side: "old" | "new") {
  return side === "old"
    ? { availability: file.old_availability, kind: file.old_kind, digest: file.old_blob_sha }
    : { availability: file.new_availability, kind: file.new_kind, digest: file.new_blob_sha };
}

function rangeSegments(start: number, end: number, changed: Set<number>): { kind: "changed" | "unchanged"; startLine: number; endLine: number }[] {
  const result: { kind: "changed" | "unchanged"; startLine: number; endLine: number }[] = [];
  let segmentStart = start;
  let kind: "changed" | "unchanged" = changed.has(start) ? "changed" : "unchanged";
  for (let line = start + 1; line <= end; line++) {
    const next = changed.has(line) ? "changed" : "unchanged";
    if (next === kind) continue;
    result.push({ kind, startLine: segmentStart, endLine: line - 1 });
    segmentStart = line;
    kind = next;
  }
  result.push({ kind, startLine: segmentStart, endLine: end });
  return result;
}

export async function validateThreadAnchor(
  input: ThreadAnchorInput,
  context: ReviewThreadContext | StackThreadContext,
): Promise<ValidatedThreadAnchor> {
  const base = empty(context.workspaceId);
  if (context.kind === "review" && (context.lineage.workspace_id !== context.workspaceId || context.revision.workspace_id !== context.workspaceId || context.revision.lineage_id !== context.lineage.id || context.inventory.capture.workspace_id !== context.workspaceId || context.inventory.capture.id !== context.revision.capture_id || (context.account !== null && (context.account.workspace_id !== context.workspaceId || context.account.revision_id !== context.revision.id)))) {
    throw new ConversationError(422, "anchor_scope", "The review context does not belong to this workspace and revision.");
  }
  if (context.kind === "stack" && (context.stack.workspace_id !== context.workspaceId || context.manifest.workspace_id !== context.workspaceId || context.manifest.stack_id !== context.stack.id || context.account.workspace_id !== context.workspaceId || context.account.manifest_id !== context.manifest.id)) {
    throw new ConversationError(422, "anchor_scope", "The stack context does not belong to this workspace and manifest.");
  }
  if (input.kind === "stack") {
    const held = stackOnly(context);
    if (input.stackAccountId !== held.account.id) throw new ConversationError(422, "anchor_account", "The stack account is not this exact page.");
    return { workspace_id: held.workspaceId, anchor_kind: "stack", ...base, stack_id: held.stack.id, stack_manifest_id: held.manifest.id, stack_account_id: held.account.id };
  }
  if (input.kind === "stack_group") {
    const held = stackOnly(context);
    if (input.stackAccountId !== held.account.id || !held.account.doc.groups.some((group) => group.id === input.groupId)) {
      throw new ConversationError(422, "anchor_group", "The group is absent from this exact stack account.");
    }
    return { workspace_id: held.workspaceId, anchor_kind: "stack_group", ...base, stack_id: held.stack.id, stack_manifest_id: held.manifest.id, stack_account_id: held.account.id, group_id: input.groupId };
  }

  const held = reviewOnly(context);
  if (input.kind === "review") {
    return { workspace_id: held.workspaceId, anchor_kind: "review", ...base, lineage_id: held.lineage.id, revision_id: held.revision.id };
  }
  if (input.kind === "account") {
    if (!held.account || input.accountId !== held.account.id) throw new ConversationError(422, "anchor_account", "The account is not this exact page.");
    return { workspace_id: held.workspaceId, anchor_kind: "account", ...base, lineage_id: held.lineage.id, revision_id: held.revision.id, account_id: held.account.id };
  }
  if (input.kind === "member_group") {
    if (!held.account || input.accountId !== held.account.id || !held.account.doc.groups.some((group) => group.id === input.groupId)) {
      throw new ConversationError(422, "anchor_group", "The group is absent from this exact account.");
    }
    return { workspace_id: held.workspaceId, anchor_kind: "member_group", ...base, lineage_id: held.lineage.id, revision_id: held.revision.id, account_id: held.account.id, group_id: input.groupId };
  }
  if (input.kind === "change") {
    const change = held.inventory.changes.find((row) => row.id === input.changeId);
    const file = change ? held.inventory.files.find((row) => row.id === change.file_id) : null;
    if (!change || !file) throw new ConversationError(422, "anchor_unknown", "The change is absent from this exact revision.");
    const oldDigest = file.old_availability === "retained" ? file.old_blob_sha : null;
    const newDigest = file.new_availability === "retained" ? file.new_blob_sha : null;
    if (!oldDigest && !newDigest) throw new ConversationError(422, "anchor_unretained", "This change has no retained side.");
    return { workspace_id: held.workspaceId, anchor_kind: "change", ...base, lineage_id: held.lineage.id, revision_id: held.revision.id, change_id: change.id, file_id: file.id, old_object_digest: oldDigest, new_object_digest: newDigest };
  }

  if (!Number.isInteger(input.startLine) || !Number.isInteger(input.endLine) || input.startLine < 1 || input.endLine < input.startLine || input.endLine - input.startLine + 1 > MAX_ANCHOR_LINES) {
    throw new ConversationError(422, "anchor_range", `A range must contain at most ${MAX_ANCHOR_LINES} positive lines.`);
  }
  const file = held.inventory.files.find((row) => row.id === input.fileId);
  if (!file) throw new ConversationError(422, "anchor_unknown", "The file is absent from this exact revision.");
  const side = sideFacts(file, input.side);
  if (side.availability !== "retained" || side.kind !== "blob" || !side.digest) {
    throw new ConversationError(422, "anchor_unretained", "That exact file side is not retained text.");
  }
  const window = retainedLineWindow(await loadStageBytes(held.workspaceId, side.digest), input.startLine, input.endLine);
  if (!window) throw new ConversationError(422, "anchor_binary", "That exact file side is not text.");
  if (window.tooLarge || input.startLine > window.totalLines || input.endLine > window.totalLines) throw new ConversationError(422, "anchor_lines", "The selected lines are not retained.");

  const changed = new Set<number>();
  for (const change of held.inventory.changes.filter((row) => row.file_id === file.id)) {
    const start = input.side === "old" ? change.old_start : change.new_start;
    const count = input.side === "old" ? change.old_lines : change.new_lines;
    for (let line = start; line < start + count; line++) changed.add(line);
  }
  const segments = rangeSegments(input.startLine, input.endLine, changed);
  const kinds = new Set(segments.map((segment) => segment.kind));
  if (kinds.size !== 1) throw new ConversationError(422, "anchor_mixed", "The selection mixes changed and unchanged lines.", { ranges: segments });
  return {
    workspace_id: held.workspaceId,
    anchor_kind: "range",
    ...base,
    lineage_id: held.lineage.id,
    revision_id: held.revision.id,
    file_id: file.id,
    side: input.side,
    start_line: input.startLine,
    end_line: input.endLine,
    range_kind: segments[0]!.kind,
    object_digest: side.digest,
  };
}

export function reviewThreadContext(
  workspaceId: string,
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  account: ReviewAccountRow | null,
): ReviewThreadContext | null {
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
  return inventory ? { kind: "review", workspaceId, lineage, revision, account, inventory } : null;
}
