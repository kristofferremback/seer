import { db } from "../db";
import { RAC_ID_RE, RSA_ID_RE, RSM_ID_RE, RVR_ID_RE, hashKey, newShareToken, tinyId } from "../ids";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import type { ShareRow } from "../shares";
import { getAttachment } from "./db";
import {
  getAccountById,
  getLineage,
  getRevisionById,
  type ReviewAccountRow,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import {
  getStackAccountById,
  getStackByIdInWorkspace,
  getStackManifestById,
  type ReviewStackRow,
  type StackAccountRow,
  type StackManifestRow,
} from "./stack-db";
import type { StackMemberSnapshot } from "./stack-types";
import { conversationImportRunning } from "./conversation-import";
import {
  buildCapabilityImportedSnapshot,
  capabilityConversationFingerprint,
  type CapabilityImportedSnapshotPlan,
  type ExactConversationPin,
} from "./conversation-read";
import { ConversationError } from "./conversation-types";
import type {
  CapabilityAttachmentRow,
  CapabilityDocumentKind,
  CapabilityDocumentProjection,
  CapabilityFileRow,
  CapabilityItemRow,
  CapabilityMember,
  CapabilityScopeRow,
  ResolvedCapability,
} from "./capability-types";

export class CapabilityTargetError extends Error {
  constructor(readonly rule: "target_malformed" | "target_unknown", message: string) {
    super(message);
    this.name = "CapabilityTargetError";
  }
}

interface ExactMember {
  position: number;
  snapshot: StackMemberSnapshot | null;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
  inventory: StageCaptureInventory;
}

type ExactDocument =
  | {
      kind: "review";
      documentKind: "review_revision" | "review_account";
      documentId: string;
      lineage: ReviewLineageRow;
      revision: ReviewRevisionRow;
      account: ReviewAccountRow | null;
      members: [ExactMember];
    }
  | {
      kind: "stack";
      documentKind: "stack_manifest" | "stack_account";
      documentId: string;
      stack: ReviewStackRow;
      manifest: StackManifestRow;
      account: StackAccountRow | null;
      members: ExactMember[];
    };

function revisionChainAgrees(
  workspaceId: string,
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  inventory: StageCaptureInventory,
): boolean {
  const source = revision.doc.source;
  const capture = inventory.capture;
  return lineage.workspace_id === workspaceId && revision.workspace_id === workspaceId &&
    revision.lineage_id === lineage.id && revision.slug === lineage.slug &&
    revision.doc.identity.lineageId === lineage.id && revision.doc.identity.slug === lineage.slug &&
    revision.doc.identity.revision === revision.revision && source.captureId === revision.capture_id &&
    lineage.repo === source.repo && lineage.repo_id === source.repoId && lineage.branch === source.branch &&
    lineage.original_base_ref === source.originalBaseRef && lineage.original_base_sha === source.originalBaseSha &&
    capture.workspace_id === workspaceId && capture.id === revision.capture_id && capture.slug === revision.slug &&
    capture.repo === source.repo && capture.repo_id === source.repoId && capture.branch === source.branch &&
    capture.base_ref === source.baseRef && capture.source_head_sha === source.sourceHeadSha &&
    capture.base_tip_sha === source.baseTipSha && capture.merge_base_sha === source.mergeBaseSha;
}

function accountChainAgrees(
  workspaceId: string,
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  account: ReviewAccountRow,
): boolean {
  return account.workspace_id === workspaceId && account.lineage_id === lineage.id &&
    account.revision_id === revision.id && account.revision === revision.revision &&
    account.slug === lineage.slug && account.doc.identity.lineageId === lineage.id &&
    account.doc.identity.slug === lineage.slug && account.doc.identity.revision === revision.revision &&
    account.doc.identity.version === account.version;
}

function reviewSemanticsAgree(account: ReviewAccountRow | null, inventory: StageCaptureInventory): boolean {
  if (!account) return true;
  const granted = new Set<string>();
  for (const change of inventory.changes) granted.add(`change:${change.id}`);
  for (const material of inventory.incomplete) granted.add(`material:${material.id}`);
  for (const file of inventory.files) {
    const hasChange = inventory.changes.some((change) => change.file_id === file.id);
    const hasMaterial = inventory.incomplete.some((item) => item.path === file.path);
    if (!hasChange && !hasMaterial) granted.add(`file:${file.id}`);
  }
  const members = account.doc.groups.flatMap((group) => group.members.map((member) => `${member.type}:${member.id}`));
  if (members.length !== granted.size || new Set(members).size !== members.length || members.some((key) => !granted.has(key))) return false;
  return account.doc.focus.every((item) => item.anchors.every((anchor) => {
    if (anchor.type === "file") return inventory.files.some((file) => file.id === anchor.id);
    return granted.has(`${anchor.type}:${anchor.id}`);
  }));
}

function exactMember(
  workspaceId: string,
  position: number,
  snapshot: StackMemberSnapshot | null,
  revisionId: string,
  accountId: string | null,
): ExactMember | null {
  const revision = getRevisionById(workspaceId, revisionId);
  const lineageSlug = snapshot?.lineageSlug ?? revision?.slug;
  const lineage = lineageSlug ? getLineage(workspaceId, lineageSlug) : null;
  const inventory = revision ? getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]) : null;
  const account = accountId === null ? null : getAccountById(workspaceId, accountId);
  if (!lineage || !revision || !inventory || !revisionChainAgrees(workspaceId, lineage, revision, inventory)) return null;
  if (accountId !== null && (!account || !accountChainAgrees(workspaceId, lineage, revision, account))) return null;
  if (!reviewSemanticsAgree(account, inventory)) return null;
  if (snapshot && (snapshot.lineageId !== lineage.id || snapshot.lineageSlug !== lineage.slug ||
      snapshot.revisionId !== revision.id || snapshot.revision !== revision.revision ||
      snapshot.accountId !== (account?.id ?? null) || snapshot.accountVersion !== (account?.version ?? null) ||
      snapshot.baseRef !== revision.doc.source.baseRef || snapshot.headRef !== revision.doc.source.branch ||
      snapshot.headSha !== revision.doc.source.sourceHeadSha)) return null;
  return { position, snapshot, lineage, revision, account, inventory };
}

function stackChainAgrees(
  workspaceId: string,
  stack: ReviewStackRow,
  manifest: StackManifestRow,
  account: StackAccountRow | null,
): boolean {
  const identity = manifest.doc.identity;
  if (stack.workspace_id !== workspaceId || manifest.workspace_id !== workspaceId ||
      manifest.stack_id !== stack.id || manifest.slug !== stack.slug ||
      identity.stackId !== stack.id || identity.slug !== stack.slug ||
      identity.version !== manifest.version || identity.predecessorVersion !== manifest.predecessor_version ||
      identity.reason !== manifest.reason) return false;
  return account === null || (
    account.workspace_id === workspaceId && account.stack_id === stack.id && account.manifest_id === manifest.id &&
    account.slug === stack.slug && account.version === manifest.version &&
    account.doc.identity.stackId === stack.id && account.doc.identity.slug === stack.slug &&
    account.doc.identity.manifestId === manifest.id && account.doc.identity.version === manifest.version
  );
}

function stackSemanticsAgree(account: StackAccountRow | null, members: ExactMember[]): boolean {
  if (!account) return true;
  const expected = new Set<string>();
  for (const member of members) {
    if (!member.account) return false;
    for (const group of member.account.doc.groups) {
      expected.add(`${member.lineage.id}:${member.revision.revision}:${member.account.version}:${group.id}`);
    }
  }
  const refs = account.doc.groups.flatMap((group) => group.members.map((ref) =>
    `${ref.lineageId}:${ref.revision}:${ref.accountVersion}:${ref.groupId}`));
  return refs.length === expected.size && new Set(refs).size === refs.length && refs.every((ref) => expected.has(ref));
}

/**
 * Resolve one immutable document without consulting any latest pointer. Mint and read both
 * cross this boundary, so every workspace, family, row, stored document, capture, account,
 * manifest, and member relation is checked by the same code.
 */
function resolveExactDocument(
  workspaceId: string,
  shareKind: "review_document" | "stack_document",
  documentKind: CapabilityDocumentKind,
  documentId: string,
): ExactDocument | null {
  if (shareKind === "review_document") {
    if (documentKind !== "review_revision" && documentKind !== "review_account") return null;
    const account = documentKind === "review_account" ? getAccountById(workspaceId, documentId) : null;
    if (documentKind === "review_account" && !account) return null;
    const revisionId = account?.revision_id ?? documentId;
    const member = exactMember(workspaceId, 1, null, revisionId, account?.id ?? null);
    if (!member || (documentKind === "review_revision" ? member.revision.id !== documentId : member.account?.id !== documentId)) return null;
    return {
      kind: "review", documentKind, documentId,
      lineage: member.lineage, revision: member.revision, account: member.account, members: [member],
    };
  }
  if (documentKind !== "stack_manifest" && documentKind !== "stack_account") return null;
  const account = documentKind === "stack_account" ? getStackAccountById(workspaceId, documentId) : null;
  if (documentKind === "stack_account" && !account) return null;
  const manifestId = account?.manifest_id ?? documentId;
  const manifest = getStackManifestById(workspaceId, manifestId);
  const stack = manifest ? getStackByIdInWorkspace(workspaceId, manifest.stack_id) : null;
  if (!manifest || !stack || !stackChainAgrees(workspaceId, stack, manifest, account)) return null;
  if (documentKind === "stack_manifest" ? manifest.id !== documentId : account?.id !== documentId) return null;
  const members: ExactMember[] = [];
  for (const [index, snapshot] of manifest.doc.members.entries()) {
    if (snapshot.status === "removed") continue;
    const member = exactMember(workspaceId, index + 1, snapshot, snapshot.revisionId, snapshot.accountId);
    if (!member) return null;
    members.push(member);
  }
  if (members.length === 0 || !stackSemanticsAgree(account, members)) return null;
  return { kind: "stack", documentKind, documentId, stack, manifest, account, members };
}

function targetKind(shareKind: "review_document" | "stack_document", target: string): CapabilityDocumentKind | null {
  if (shareKind === "review_document") {
    if (RVR_ID_RE.test(target)) return "review_revision";
    if (RAC_ID_RE.test(target)) return "review_account";
    return null;
  }
  if (RSM_ID_RE.test(target)) return "stack_manifest";
  if (RSA_ID_RE.test(target)) return "stack_account";
  return null;
}

export function resolveCapabilityTargetForMint(
  workspaceId: string,
  shareKind: "review_document" | "stack_document",
  target: string,
): ExactDocument {
  const documentKind = targetKind(shareKind, target);
  if (!documentKind) {
    throw new CapabilityTargetError("target_malformed", shareKind === "review_document"
      ? "target must be an rvr_ revision or rac_ account id"
      : "target must be an rsm_ manifest or rsa_ account id");
  }
  const resolved = resolveExactDocument(workspaceId, shareKind, documentKind, target);
  if (!resolved) throw new CapabilityTargetError("target_unknown", `No such ${resolvedFamily(shareKind)} document in this workspace`);
  return resolved;
}

function resolvedFamily(kind: "review_document" | "stack_document"): string {
  return kind === "review_document" ? "review" : "stack";
}

function itemRows(shareId: string, workspaceId: string, members: ExactMember[]): CapabilityItemRow[] {
  const rows: CapabilityItemRow[] = [];
  let ordinal = 1;
  for (const member of members) {
    const claimedMaterial = new Set<string>();
    for (const material of member.inventory.incomplete.filter((item) => item.path === null)) {
      rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, item_kind: "material", item_id: material.id, ordinal: ordinal++ });
      claimedMaterial.add(material.id);
    }
    for (const file of member.inventory.files) {
      const changes = member.inventory.changes.filter((change) => change.file_id === file.id);
      for (const change of changes) rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, item_kind: "change", item_id: change.id, ordinal: ordinal++ });
      const material = member.inventory.incomplete.filter((item) => item.path === file.path && !claimedMaterial.has(item.id));
      for (const item of material) {
        rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, item_kind: "material", item_id: item.id, ordinal: ordinal++ });
        claimedMaterial.add(item.id);
      }
      if (changes.length === 0 && material.length === 0) rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, item_kind: "file", item_id: file.id, ordinal: ordinal++ });
    }
    for (const material of member.inventory.incomplete) {
      if (claimedMaterial.has(material.id)) continue;
      rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, item_kind: "material", item_id: material.id, ordinal: ordinal++ });
    }
  }
  return rows;
}

function fileRows(shareId: string, workspaceId: string, members: ExactMember[]): CapabilityFileRow[] {
  const rows: CapabilityFileRow[] = [];
  for (const member of members) {
    for (const file of member.inventory.files) {
      rows.push({ share_id: shareId, workspace_id: workspaceId, member_position: member.position, revision_id: member.revision.id, capture_id: member.revision.capture_id, file_id: file.id, ordinal: rows.length + 1 });
    }
  }
  return rows;
}

function attachmentRows(shareId: string, workspaceId: string, members: ExactMember[]): CapabilityAttachmentRow[] {
  const rows: CapabilityAttachmentRow[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const evidence of member.account?.doc.evidence ?? []) {
      if (evidence.kind !== "attachment" || seen.has(evidence.id)) continue;
      const attachment = getAttachment(workspaceId, evidence.reviewSlug, evidence.id);
      if (!attachment || attachment.media_type !== evidence.mediaType || attachment.bytes !== evidence.bytes ||
          attachment.alt !== evidence.alt || attachment.caption !== evidence.caption) {
        throw new CapabilityTargetError("target_unknown", "The review account has unreadable attachment evidence");
      }
      seen.add(evidence.id);
      rows.push({ share_id: shareId, workspace_id: workspaceId, attachment_id: evidence.id, review_slug: evidence.reviewSlug, ordinal: rows.length + 1 });
    }
  }
  return rows;
}

function conversationPins(target: ExactDocument): ExactConversationPin[] {
  return target.members.map((member) => ({
    lineage: member.lineage,
    revisionId: member.revision.id,
    accountId: member.account?.id ?? null,
    headSha: member.revision.doc.source.sourceHeadSha,
  }));
}

/** Copy conversation authority while the exact document and share write are under the
 * same SQLite transaction. Blob-backed placement was prepared before this short write;
 * its complete identity fingerprint is rechecked under the lock before any row lands. */
function snapshotConversation(shareId: string, workspaceId: string, target: ExactDocument, importedPlan: CapabilityImportedSnapshotPlan): void {
  const lineageIds = target.members.map((member) => member.lineage.id);
  if (lineageIds.some((id) => conversationImportRunning(workspaceId, id))) {
    throw new ConversationError(409, "conversation_refresh_in_progress", "Conversation refresh is in progress.");
  }
  const revisionIds = new Set(target.members.map((member) => member.revision.id));
  const accountIds = new Set(target.members.flatMap((member) => member.account ? [member.account.id] : []));
  const stackAccountId = target.kind === "stack" ? target.account?.id ?? null : null;
  const localCandidates = db.query<{ id: string; append_version: number; anchor_kind: string; revision_id: string | null; account_id: string | null; stack_account_id: string | null }, string[]>(
    `SELECT DISTINCT t.id, t.append_version, a.anchor_kind, a.revision_id, a.account_id, a.stack_account_id
     FROM review_threads t JOIN review_thread_anchors a ON a.thread_id = t.id
     WHERE t.workspace_id = ? AND (
       a.revision_id IN (${[...revisionIds].map(() => "?").join(",") || "NULL"})
       OR a.account_id IN (${[...accountIds].map(() => "?").join(",") || "NULL"})
       ${stackAccountId ? "OR a.stack_account_id = ?" : ""}
     ) ORDER BY t.created_at, t.id`,
  ).all(workspaceId, ...revisionIds, ...accountIds, ...(stackAccountId ? [stackAccountId] : []));
  const local = localCandidates.filter((row) =>
    (row.revision_id !== null && revisionIds.has(row.revision_id) && ["review", "change", "range"].includes(row.anchor_kind)) ||
    (row.account_id !== null && accountIds.has(row.account_id) && ["account", "member_group"].includes(row.anchor_kind)) ||
    (stackAccountId !== null && row.stack_account_id === stackAccountId && ["stack", "stack_group"].includes(row.anchor_kind))
  );
  const insertLocal = db.prepare("INSERT INTO share_capability_local_threads VALUES (?, ?, ?, ?, ?)");
  local.forEach((row, index) => insertLocal.run(shareId, workspaceId, row.id, row.append_version, index + 1));

  if (capabilityConversationFingerprint(workspaceId, conversationPins(target)) !== importedPlan.fingerprint) {
    throw new ConversationError(409, "conversation_changed", "Conversation changed while the link was being created. Try again.");
  }
  let threadOrdinal = 1;
  let commentOrdinal = 1;
  let reviewOrdinal = 1;
  const insertThread = db.prepare("INSERT INTO share_capability_github_threads VALUES (?, ?, ?, ?, ?)");
  const insertComment = db.prepare("INSERT INTO share_capability_github_comments VALUES (?, ?, ?, ?, ?, ?)");
  const insertReview = db.prepare("INSERT INTO share_capability_github_reviews VALUES (?, ?, ?, ?, ?)");
  for (const thread of importedPlan.threads) {
    insertThread.run(shareId, workspaceId, thread.threadId, thread.observationId, threadOrdinal++);
    for (const comment of thread.comments) {
      insertComment.run(shareId, workspaceId, thread.threadId, comment.commentId, comment.observationId, commentOrdinal++);
    }
  }
  for (const review of importedPlan.reviews) insertReview.run(shareId, workspaceId, review.reviewId, review.observationId, reviewOrdinal++);
}

export interface CreatedDocumentCapability {
  id: string;
  token: string;
  projection: CapabilityDocumentProjection;
}

interface CreateDocumentCapabilityInput {
  wsId: string;
  kind: "review_document" | "stack_document";
  target: string;
  label: string;
  userId: string;
  expiresAt: number | null;
  conversation?: boolean;
}

const insertDocumentCapability = db.transaction((input: CreateDocumentCapabilityInput, importedPlan: CapabilityImportedSnapshotPlan | null): CreatedDocumentCapability => {
  const target = resolveCapabilityTargetForMint(input.wsId, input.kind, input.target);
  const id = tinyId("shr");
  const token = newShareToken();
  const now = Date.now();
  db.run(
    "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.wsId, input.kind, target.documentId, input.label, hashKey(token), input.userId, now, input.expiresAt],
  );
  db.run(
    "INSERT INTO share_document_capabilities (share_id, workspace_id, document_kind, document_id, created_at, conversation_scope) VALUES (?, ?, ?, ?, ?, ?)",
    [id, input.wsId, target.documentKind, target.documentId, now, input.conversation ? "snapshot" : "none"],
  );
  const insertFile = db.prepare(
    "INSERT INTO share_capability_files (share_id, workspace_id, member_position, revision_id, capture_id, file_id, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of fileRows(id, input.wsId, target.members)) insertFile.run(row.share_id, row.workspace_id, row.member_position, row.revision_id, row.capture_id, row.file_id, row.ordinal);
  const insertItem = db.prepare(
    "INSERT INTO share_capability_items (share_id, workspace_id, member_position, revision_id, item_kind, item_id, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of itemRows(id, input.wsId, target.members)) insertItem.run(row.share_id, row.workspace_id, row.member_position, row.revision_id, row.item_kind, row.item_id, row.ordinal);
  const insertAttachment = db.prepare(
    "INSERT INTO share_capability_attachments (share_id, workspace_id, attachment_id, review_slug, ordinal) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of attachmentRows(id, input.wsId, target.members)) insertAttachment.run(row.share_id, row.workspace_id, row.attachment_id, row.review_slug, row.ordinal);
  if (input.conversation) {
    if (!importedPlan) throw new Error("Conversation capability has no prepared imported snapshot");
    snapshotConversation(id, input.wsId, target, importedPlan);
  }
  return { id, token, projection: projectionOf(target) };
}) as (input: CreateDocumentCapabilityInput, importedPlan: CapabilityImportedSnapshotPlan | null) => CreatedDocumentCapability;

export async function createDocumentCapability(input: CreateDocumentCapabilityInput): Promise<CreatedDocumentCapability> {
  const target = resolveCapabilityTargetForMint(input.wsId, input.kind, input.target);
  const importedPlan = input.conversation
    ? await buildCapabilityImportedSnapshot(input.wsId, conversationPins(target))
    : null;
  return insertDocumentCapability(input, importedPlan);
}

function projectionOf(target: ExactDocument): CapabilityDocumentProjection {
  if (target.kind === "review") {
    return {
      kind: target.documentKind,
      slug: target.revision.slug,
      pin: target.account ? `v${target.account.version}` : `rev ${target.revision.revision}`,
      title: target.revision.doc.identity.title,
    };
  }
  return {
    kind: target.documentKind,
    slug: target.manifest.slug,
    pin: target.account ? `v${target.manifest.version} account` : `v${target.manifest.version}`,
    title: target.manifest.doc.identity.title,
  };
}

export function getCapabilityScope(shareId: string): CapabilityScopeRow | null {
  return db.query<CapabilityScopeRow, [string]>(
    "SELECT * FROM share_document_capabilities WHERE share_id = ?",
  ).get(shareId);
}

function capabilityRows(shareId: string): {
  files: CapabilityFileRow[];
  items: CapabilityItemRow[];
  attachments: CapabilityAttachmentRow[];
} {
  return {
    files: db.query<CapabilityFileRow, [string]>("SELECT * FROM share_capability_files WHERE share_id = ? ORDER BY ordinal").all(shareId),
    items: db.query<CapabilityItemRow, [string]>("SELECT * FROM share_capability_items WHERE share_id = ? ORDER BY ordinal").all(shareId),
    attachments: db.query<CapabilityAttachmentRow, [string]>("SELECT * FROM share_capability_attachments WHERE share_id = ? ORDER BY ordinal").all(shareId),
  };
}

function corrupted(share: ShareRow, message: string): null {
  console.error(`[seer] document capability ${share.id}: ${message}`);
  return null;
}

function fileRowsAgree(actual: CapabilityFileRow[], expected: CapabilityFileRow[]): boolean {
  return actual.length === expected.length && actual.every((row, index) => {
    const wanted = expected[index];
    return !!wanted && row.share_id === wanted.share_id && row.workspace_id === wanted.workspace_id &&
      row.member_position === wanted.member_position && row.revision_id === wanted.revision_id &&
      row.capture_id === wanted.capture_id && row.file_id === wanted.file_id && row.ordinal === wanted.ordinal;
  });
}

function itemRowsAgree(actual: CapabilityItemRow[], expected: CapabilityItemRow[]): boolean {
  return actual.length === expected.length && actual.every((row, index) => {
    const wanted = expected[index];
    return !!wanted && row.share_id === wanted.share_id && row.workspace_id === wanted.workspace_id &&
      row.member_position === wanted.member_position && row.revision_id === wanted.revision_id &&
      row.item_kind === wanted.item_kind && row.item_id === wanted.item_id && row.ordinal === wanted.ordinal;
  });
}

function attachmentRowsAgree(actual: CapabilityAttachmentRow[], expected: CapabilityAttachmentRow[]): boolean {
  return actual.length === expected.length && actual.every((row, index) => {
    const wanted = expected[index];
    return !!wanted && row.share_id === wanted.share_id && row.workspace_id === wanted.workspace_id &&
      row.attachment_id === wanted.attachment_id && row.review_slug === wanted.review_slug && row.ordinal === wanted.ordinal;
  });
}

function grantedMember(member: ExactMember, rows: ReturnType<typeof capabilityRows>): CapabilityMember {
  const fileIds = new Set(rows.files.filter((row) => row.member_position === member.position).map((row) => row.file_id));
  const itemKeys = new Set(rows.items.filter((row) => row.member_position === member.position).map((row) => `${row.item_kind}:${row.item_id}`));
  return {
    position: member.position,
    snapshot: member.snapshot,
    lineage: member.lineage,
    revision: member.revision,
    account: member.account,
    inventory: {
      ...member.inventory,
      files: member.inventory.files.filter((file) => fileIds.has(file.id)),
      changes: member.inventory.changes.filter((change) => fileIds.has(change.file_id) && itemKeys.has(`change:${change.id}`)),
      incomplete: member.inventory.incomplete.filter((item) => itemKeys.has(`material:${item.id}`)),
    },
  };
}

export function resolveDocumentCapability(share: ShareRow): ResolvedCapability | null {
  if (share.kind !== "review_document" && share.kind !== "stack_document") return null;
  const scope = getCapabilityScope(share.id);
  if (!scope || scope.workspace_id !== share.workspace_id || scope.document_id !== share.target) return corrupted(share, "scope and share disagree");
  const exact = resolveExactDocument(share.workspace_id, share.kind, scope.document_kind, scope.document_id);
  if (!exact) return corrupted(share, "exact document relationship is inconsistent");
  const rows = capabilityRows(share.id);
  let expectedAttachments: CapabilityAttachmentRow[];
  try {
    expectedAttachments = attachmentRows(share.id, share.workspace_id, exact.members);
  } catch {
    return corrupted(share, "attachment relationship is inconsistent");
  }
  if (!fileRowsAgree(rows.files, fileRows(share.id, share.workspace_id, exact.members)) ||
      !itemRowsAgree(rows.items, itemRows(share.id, share.workspace_id, exact.members)) ||
      !attachmentRowsAgree(rows.attachments, expectedAttachments)) return corrupted(share, "copied inventory is inconsistent");
  const members = exact.members.map((member) => grantedMember(member, rows));
  if (exact.kind === "review") {
    const member = members[0]!;
    return { kind: "review", share, scope, lineage: exact.lineage, revision: exact.revision, account: exact.account, inventory: member.inventory, ...rows };
  }
  return { kind: "stack", share, scope, stack: exact.stack, manifest: exact.manifest, account: exact.account, members, ...rows };
}

interface ShareDocumentProjection {
  document: CapabilityDocumentProjection;
  assetPath: string;
}

/** A listing label and owning-member redirect need only the capability's immutable
 * document rows. They deliberately do not resolve inventory or consult a latest pointer. */
function projectedDocumentRow(share: ShareRow): ShareDocumentProjection | null {
  if (share.kind !== "review_document" && share.kind !== "stack_document") return null;
  const scope = getCapabilityScope(share.id);
  if (!scope || scope.workspace_id !== share.workspace_id || scope.document_id !== share.target ||
      targetKind(share.kind, share.target) !== scope.document_kind) return null;

  if (scope.document_kind === "review_revision") {
    const row = getRevisionById(share.workspace_id, scope.document_id);
    return row ? {
      document: { kind: scope.document_kind, slug: row.slug, pin: `rev ${row.revision}`, title: row.doc.identity.title },
      assetPath: `/${share.workspace_id}/r/${row.slug}/rev/${row.revision}`,
    } : null;
  }
  if (scope.document_kind === "review_account") {
    const row = getAccountById(share.workspace_id, scope.document_id);
    const revision = row ? getRevisionById(share.workspace_id, row.revision_id) : null;
    return row && revision && revision.slug === row.slug && revision.lineage_id === row.lineage_id && revision.revision === row.revision ? {
      document: { kind: scope.document_kind, slug: row.slug, pin: `v${row.version}`, title: revision.doc.identity.title },
      assetPath: `/${share.workspace_id}/r/${row.slug}/v/${row.version}`,
    } : null;
  }
  if (scope.document_kind === "stack_manifest") {
    const row = getStackManifestById(share.workspace_id, scope.document_id);
    return row ? {
      document: { kind: scope.document_kind, slug: row.slug, pin: `v${row.version}`, title: row.doc.identity.title },
      assetPath: `/${share.workspace_id}/r-stacks/${row.slug}/v/${row.version}`,
    } : null;
  }
  const row = getStackAccountById(share.workspace_id, scope.document_id);
  const manifest = row ? getStackManifestById(share.workspace_id, row.manifest_id) : null;
  return row && manifest && manifest.slug === row.slug && manifest.stack_id === row.stack_id && manifest.version === row.version ? {
    document: { kind: scope.document_kind, slug: row.slug, pin: `v${row.version} account`, title: manifest.doc.identity.title },
    assetPath: `/${share.workspace_id}/r-stacks/${row.slug}/v/${row.version}/account`,
  } : null;
}

export function documentProjectionForShare(share: ShareRow): CapabilityDocumentProjection | null {
  return projectedDocumentRow(share)?.document ?? null;
}

export function capabilityAssetPath(share: ShareRow): string | null {
  return projectedDocumentRow(share)?.assetPath ?? null;
}
