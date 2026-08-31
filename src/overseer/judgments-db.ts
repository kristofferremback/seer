// Immutable local judgment over exact retained evidence.
//
// Reads, active acknowledgements, and judgments answer different questions and live in
// different tables. A judgment transaction re-derives the exact required item set from
// retained SQLite rows, validates the member's active acknowledgements, copies their
// provenance, and inserts the first verdict for that member and scope. Nothing here calls
// GitHub, and no function updates or deletes a judgment or its item snapshot.

import { db } from "../db";
import { tinyId } from "../ids";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import { normalize, validate as validateMarkdown } from "./markdown";
import {
  listRevisionAcknowledgements,
  type AcknowledgementItemType,
  type AcknowledgementRow,
} from "./acknowledgements-db";
import { digestOf, getRevisionById, type ReviewRevisionRow } from "./revision-db";
import { projectMember, type ProjectedActor } from "./actor-projection";
import { requiredAcknowledgements, type ReviewItemIdentity } from "./revision-delta";
import {
  getStackByIdInWorkspace,
  getStackManifestById,
  type ReviewStackRow,
  type StackManifestRow,
} from "./stack-db";

export const JUDGMENT_COMMENT_MAX = 1_200;
export type JudgmentVerdict = "approved" | "changes_requested";

export interface AcknowledgementView {
  itemId: string;
  itemType: AcknowledgementItemType;
  provenance: { kind: "explicit" } | {
    kind: "carried";
    sourceRevision: number;
    sourceItemId: string;
  };
  acknowledgedAt: string;
}

export interface JudgmentView {
  id: string;
  scope: { kind: "revision"; revision: number } | { kind: "stack"; manifest: number };
  verdict: JudgmentVerdict;
  comment: string;
  by: ProjectedActor;
  judgedAt: string;
}

export interface JudgmentProjection {
  viewerId: string | null;
  /** Private member HTML may use the stable local labels already used by local threads. */
  memberLabels?: ReadonlyMap<string, string>;
}

export interface JudgmentBlocker {
  revisionId: string;
  revision: number;
  lineageSlug: string;
  itemId: string;
  itemType: AcknowledgementItemType;
  path: string | null;
  reason: "missing" | "type" | "identity";
}

export interface RevisionAcknowledgementState {
  requiredCount: number;
  requiredItems: ReviewItemIdentity[];
  /** Rows validated against the exact retained item identity and carry provenance. */
  validRows: ReadonlyMap<string, AcknowledgementRow>;
  acknowledgedCount: number;
  acknowledgements: Map<string, AcknowledgementView>;
  blockers: JudgmentBlocker[];
}

export interface StackAcknowledgementMemberState {
  position: number;
  revision: ReviewRevisionRow;
  inventory: StageCaptureInventory;
  state: RevisionAcknowledgementState;
}

export interface StackAcknowledgementState {
  requiredCount: number;
  acknowledgedCount: number;
  members: StackAcknowledgementMemberState[];
  blockers: JudgmentBlocker[];
}

export interface ResolvedStackAcknowledgementMember {
  position: number;
  revision: ReviewRevisionRow;
  inventory: StageCaptureInventory;
}

interface RevisionJudgmentRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  user_id: string;
  verdict: JudgmentVerdict;
  comment: string;
  acknowledgement_digest: string;
  required_count: number;
  judged_at: number;
}

interface StackJudgmentRow {
  id: string;
  workspace_id: string;
  stack_id: string;
  manifest_id: string;
  user_id: string;
  verdict: JudgmentVerdict;
  comment: string;
  acknowledgement_digest: string;
  required_count: number;
  judged_at: number;
}

interface SnapshotItem {
  itemId: string;
  itemType: AcknowledgementItemType;
  identityDigest: string;
  provenanceKind: "explicit" | "carried";
  sourceRevisionId: string | null;
  sourceItemId: string | null;
  equivalenceDigest: string | null;
  acknowledgedAt: number;
}

interface StackSnapshotItem extends SnapshotItem {
  revisionId: string;
}

export class JudgmentWriteError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly rule: string,
    message: string,
    readonly blockers: JudgmentBlocker[] = [],
  ) {
    super(message);
    this.name = "JudgmentWriteError";
  }
}

export function normalizeJudgmentComment(value: unknown): string {
  if (typeof value !== "string") {
    throw new JudgmentWriteError(422, "comment", "comment must be constrained markdown.");
  }
  const normalized = normalize(value);
  const comment = normalized.trim() === "" ? "" : normalized;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(comment)) {
    throw new JudgmentWriteError(422, "comment", "comment carries control characters.");
  }
  if (comment.length > JUDGMENT_COMMENT_MAX) {
    throw new JudgmentWriteError(422, "comment", `comment is over budget: ${comment.length} of at most ${JUDGMENT_COMMENT_MAX} characters.`);
  }
  if (comment !== "") {
    const checked = validateMarkdown(comment);
    if (!checked.ok) throw new JudgmentWriteError(422, "comment", checked.message);
  }
  return comment;
}

function exactRows(
  revision: ReviewRevisionRow,
  inventory: StageCaptureInventory,
  userId: string,
): {
  required: ReviewItemIdentity[];
  valid: Map<string, AcknowledgementRow>;
  blockers: JudgmentBlocker[];
} {
  const required = requiredAcknowledgements(inventory)
    .slice()
    .sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  const active = listRevisionAcknowledgements(revision.workspace_id, revision.id, userId);
  const carries = new Map(db.query<{
    target_item_id: string;
    workspace_id: string;
    lineage_id: string;
    source_revision_id: string;
    source_item_id: string;
    target_identity_digest: string;
    equivalence_digest: string;
  }, [string, string, string]>(
    "SELECT target_item_id, workspace_id, lineage_id, source_revision_id, source_item_id, target_identity_digest, equivalence_digest FROM review_revision_acknowledgement_carries WHERE workspace_id = ? AND target_revision_id = ? AND user_id = ?",
  ).all(revision.workspace_id, revision.id, userId).map((row) => [row.target_item_id, row]));
  const valid = new Map<string, AcknowledgementRow>();
  const blockers: JudgmentBlocker[] = [];
  for (const item of required) {
    const row = active.get(item.id);
    const base = {
      revisionId: revision.id,
      revision: revision.revision,
      lineageSlug: revision.slug,
      itemId: item.id,
      itemType: item.type as AcknowledgementItemType,
      path: item.path,
    };
    if (!row) {
      blockers.push({ ...base, reason: "missing" });
    } else if (row.item_type !== item.type) {
      blockers.push({ ...base, reason: "type" });
    } else if (row.lineage_id !== revision.lineage_id || row.identity_digest !== item.digest) {
      blockers.push({ ...base, reason: "identity" });
    } else if (row.provenance_kind === "carried") {
      const carry = carries.get(item.id);
      if (!carry || carry.workspace_id !== revision.workspace_id || carry.lineage_id !== revision.lineage_id ||
          carry.source_revision_id !== row.source_revision_id || carry.source_item_id !== row.source_item_id ||
          carry.target_identity_digest !== row.identity_digest || carry.equivalence_digest !== row.equivalence_digest) {
        blockers.push({ ...base, reason: "identity" });
      } else {
        valid.set(item.id, row);
      }
    } else {
      valid.set(item.id, row);
    }
  }
  return { required, valid, blockers };
}

function acknowledgementView(workspaceId: string, row: AcknowledgementRow): AcknowledgementView | null {
  if (row.provenance_kind === "explicit") {
    return {
      itemId: row.item_id,
      itemType: row.item_type,
      provenance: { kind: "explicit" },
      acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
    };
  }
  if (!row.source_revision_id || !row.source_item_id) return null;
  const source = getRevisionById(workspaceId, row.source_revision_id);
  if (!source) return null;
  return {
    itemId: row.item_id,
    itemType: row.item_type,
    provenance: { kind: "carried", sourceRevision: source.revision, sourceItemId: row.source_item_id },
    acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
  };
}

export function revisionAcknowledgementState(
  revision: ReviewRevisionRow,
  userId: string,
  inventory?: StageCaptureInventory,
): RevisionAcknowledgementState {
  const retained = inventory ?? getStageCaptureForWorkspaces(revision.capture_id, [revision.workspace_id]);
  if (!retained) throw new JudgmentWriteError(404, "review_unknown", "No such review.");
  const checked = exactRows(revision, retained, userId);
  const acknowledgements = new Map<string, AcknowledgementView>();
  for (const [id, row] of checked.valid) {
    const view = acknowledgementView(revision.workspace_id, row);
    if (view) acknowledgements.set(id, view);
  }
  return {
    requiredCount: checked.required.length,
    requiredItems: checked.required,
    validRows: checked.valid,
    acknowledgedCount: acknowledgements.size,
    acknowledgements,
    blockers: checked.blockers,
  };
}

function exactManifestMembers(
  workspaceId: string,
  manifest: StackManifestRow,
  userId: string,
  resolvedMembers: readonly ResolvedStackAcknowledgementMember[],
): StackAcknowledgementMemberState[] {
  const supplied = new Map(resolvedMembers.map((member) => [member.position, member]));
  const out: StackAcknowledgementMemberState[] = [];
  manifest.doc.members.forEach((snapshot, index) => {
    const retained = supplied.get(index + 1);
    const revision = retained?.revision ?? getRevisionById(workspaceId, snapshot.revisionId);
    if (!revision || revision.workspace_id !== workspaceId || revision.lineage_id !== snapshot.lineageId || revision.slug !== snapshot.lineageSlug || revision.revision !== snapshot.revision || revision.id !== snapshot.revisionId) {
      throw new JudgmentWriteError(404, "review_unknown", "No such review.");
    }
    const inventory = retained?.inventory ?? getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
    if (!inventory || inventory.capture.workspace_id !== workspaceId || inventory.capture.id !== revision.capture_id) throw new JudgmentWriteError(404, "review_unknown", "No such review.");
    out.push({ position: index + 1, revision, inventory, state: revisionAcknowledgementState(revision, userId, inventory) });
  });
  return out;
}

export function stackAcknowledgementState(
  workspaceId: string,
  manifest: StackManifestRow,
  userId: string,
  resolvedMembers: readonly ResolvedStackAcknowledgementMember[] = [],
): StackAcknowledgementState {
  const members = exactManifestMembers(workspaceId, manifest, userId, resolvedMembers);
  return {
    requiredCount: members.reduce((sum, member) => sum + member.state.requiredCount, 0),
    acknowledgedCount: members.reduce((sum, member) => sum + member.state.acknowledgedCount, 0),
    members,
    blockers: members.flatMap((member) => member.state.blockers),
  };
}

function snapshot(row: AcknowledgementRow): SnapshotItem {
  return {
    itemId: row.item_id,
    itemType: row.item_type,
    identityDigest: row.identity_digest,
    provenanceKind: row.provenance_kind,
    sourceRevisionId: row.source_revision_id,
    sourceItemId: row.source_item_id,
    equivalenceDigest: row.equivalence_digest,
    acknowledgedAt: row.acknowledged_at,
  };
}

function requireWorkspaceMember(workspaceId: string, userId: string): void {
  const member = db.query<{ found: number }, [string, string]>(
    "SELECT 1 AS found FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?",
  ).get(workspaceId, userId);
  if (!member) throw new JudgmentWriteError(404, "review_unknown", "No such review.");
}

function revisionWinner(workspaceId: string, revisionId: string, userId: string): RevisionJudgmentRow | null {
  return db.query<RevisionJudgmentRow, [string, string, string]>(
    "SELECT * FROM review_revision_judgments WHERE workspace_id = ? AND revision_id = ? AND user_id = ?",
  ).get(workspaceId, revisionId, userId);
}

function stackWinner(workspaceId: string, manifestId: string, userId: string): StackJudgmentRow | null {
  return db.query<StackJudgmentRow, [string, string, string]>(
    "SELECT * FROM review_stack_judgments WHERE workspace_id = ? AND manifest_id = ? AND user_id = ?",
  ).get(workspaceId, manifestId, userId);
}

const judgeRevisionTransaction = db.transaction((input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: string;
}): { row: RevisionJudgmentRow; created: boolean } => {
  requireWorkspaceMember(input.workspaceId, input.userId);
  const revision = getRevisionById(input.workspaceId, input.revisionId);
  const lineage = db.query<{ slug: string }, [string, string]>(
    "SELECT slug FROM review_lineages WHERE workspace_id = ? AND id = ?",
  ).get(input.workspaceId, input.lineageId);
  if (!revision || !lineage || revision.lineage_id !== input.lineageId || revision.slug !== lineage.slug) {
    throw new JudgmentWriteError(404, "review_unknown", "No such review.");
  }
  const existing = revisionWinner(input.workspaceId, revision.id, input.userId);
  if (existing) {
    if (existing.verdict !== input.verdict || existing.comment !== input.comment) {
      throw new JudgmentWriteError(409, "judgment_immutable", "Your first judgment of this exact revision is immutable.");
    }
    return { row: existing, created: false };
  }
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [input.workspaceId]);
  if (!inventory) throw new JudgmentWriteError(404, "review_unknown", "No such review.");
  const checked = exactRows(revision, inventory, input.userId);
  if (checked.blockers.length > 0) {
    throw new JudgmentWriteError(422, "acknowledgements_required", "Acknowledge every unavailable review item before judging this revision.", checked.blockers);
  }
  const items = checked.required.map((item) => snapshot(checked.valid.get(item.id)!));
  const acknowledgementDigest = digestOf(items);
  const now = Date.now();
  const id = tinyId("rjd");
  const created = db.run(
    "INSERT OR IGNORE INTO review_revision_judgments (id, workspace_id, lineage_id, revision_id, user_id, verdict, comment, acknowledgement_digest, required_count, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.lineageId, revision.id, input.userId, input.verdict,
      input.comment, acknowledgementDigest, items.length, now],
  ).changes === 1;
  if (created) {
    const insert = db.prepare(
      "INSERT INTO review_revision_judgment_items (judgment_id, item_id, item_type, identity_digest, provenance_kind, source_revision_id, source_item_id, equivalence_digest, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      insert.run(id, item.itemId, item.itemType, item.identityDigest, item.provenanceKind,
        item.sourceRevisionId, item.sourceItemId, item.equivalenceDigest, item.acknowledgedAt);
    }
  }
  const winner = revisionWinner(input.workspaceId, revision.id, input.userId);
  if (!winner) throw new Error(`Revision judgment winner disappeared for ${revision.id}`);
  if (winner.verdict !== input.verdict || winner.comment !== input.comment) {
    throw new JudgmentWriteError(409, "judgment_immutable", "Your first judgment of this exact revision is immutable.");
  }
  return { row: winner, created };
}) as (input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: string;
}) => { row: RevisionJudgmentRow; created: boolean };

const judgeStackTransaction = db.transaction((input: {
  workspaceId: string;
  stackId: string;
  manifestId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: string;
}): { row: StackJudgmentRow; created: boolean } => {
  requireWorkspaceMember(input.workspaceId, input.userId);
  const stack = getStackByIdInWorkspace(input.workspaceId, input.stackId);
  const manifest = getStackManifestById(input.workspaceId, input.manifestId);
  if (!stack || !manifest || manifest.stack_id !== stack.id) {
    throw new JudgmentWriteError(404, "review_unknown", "No such review.");
  }
  const existing = stackWinner(input.workspaceId, manifest.id, input.userId);
  if (existing) {
    if (existing.verdict !== input.verdict || existing.comment !== input.comment) {
      throw new JudgmentWriteError(409, "judgment_immutable", "Your first judgment of this exact manifest is immutable.");
    }
    return { row: existing, created: false };
  }
  const state = stackAcknowledgementState(input.workspaceId, manifest, input.userId);
  if (state.blockers.length > 0) {
    throw new JudgmentWriteError(422, "acknowledgements_required", "Acknowledge every unavailable review item before judging this manifest.", state.blockers);
  }
  const items: StackSnapshotItem[] = state.members.flatMap((member) =>
    member.state.requiredItems.map((item) => ({
      revisionId: member.revision.id,
      ...snapshot(member.state.validRows.get(item.id)!),
    })),
  ).sort((left, right) => left.revisionId.localeCompare(right.revisionId) || left.itemType.localeCompare(right.itemType) || left.itemId.localeCompare(right.itemId));
  const acknowledgementDigest = digestOf(items);
  const now = Date.now();
  const id = tinyId("sjd");
  const created = db.run(
    "INSERT OR IGNORE INTO review_stack_judgments (id, workspace_id, stack_id, manifest_id, user_id, verdict, comment, acknowledgement_digest, required_count, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, stack.id, manifest.id, input.userId, input.verdict,
      input.comment, acknowledgementDigest, items.length, now],
  ).changes === 1;
  if (created) {
    const insert = db.prepare(
      "INSERT INTO review_stack_judgment_items (judgment_id, revision_id, item_id, item_type, identity_digest, provenance_kind, source_revision_id, source_item_id, equivalence_digest, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      insert.run(id, item.revisionId, item.itemId, item.itemType, item.identityDigest,
        item.provenanceKind, item.sourceRevisionId, item.sourceItemId,
        item.equivalenceDigest, item.acknowledgedAt);
    }
  }
  const winner = stackWinner(input.workspaceId, manifest.id, input.userId);
  if (!winner) throw new Error(`Stack judgment winner disappeared for ${manifest.id}`);
  if (winner.verdict !== input.verdict || winner.comment !== input.comment) {
    throw new JudgmentWriteError(409, "judgment_immutable", "Your first judgment of this exact manifest is immutable.");
  }
  return { row: winner, created };
}) as (input: {
  workspaceId: string;
  stackId: string;
  manifestId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: string;
}) => { row: StackJudgmentRow; created: boolean };

function judgmentActor(userId: string, projection: JudgmentProjection): ProjectedActor {
  if (projection.viewerId === userId) return projectMember(true);
  const label = projection.memberLabels?.get(userId);
  return label === undefined ? projectMember(false) : { kind: "member", label };
}

function revisionView(row: RevisionJudgmentRow, projection: JudgmentProjection): JudgmentView {
  const revision = getRevisionById(row.workspace_id, row.revision_id);
  if (!revision) throw new Error(`Judgment ${row.id} names missing revision ${row.revision_id}`);
  return {
    id: row.id,
    scope: { kind: "revision", revision: revision.revision },
    verdict: row.verdict,
    comment: row.comment,
    by: judgmentActor(row.user_id, projection),
    judgedAt: new Date(row.judged_at).toISOString(),
  };
}

function stackView(row: StackJudgmentRow, projection: JudgmentProjection): JudgmentView {
  const manifest = getStackManifestById(row.workspace_id, row.manifest_id);
  if (!manifest) throw new Error(`Judgment ${row.id} names missing manifest ${row.manifest_id}`);
  return {
    id: row.id,
    scope: { kind: "stack", manifest: manifest.version },
    verdict: row.verdict,
    comment: row.comment,
    by: judgmentActor(row.user_id, projection),
    judgedAt: new Date(row.judged_at).toISOString(),
  };
}

export function judgeRevision(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: unknown;
}): { judgment: JudgmentView; created: boolean } {
  if (input.verdict !== "approved" && input.verdict !== "changes_requested") {
    throw new JudgmentWriteError(422, "verdict", "verdict must be approved or changes_requested.");
  }
  const result = judgeRevisionTransaction({ ...input, comment: normalizeJudgmentComment(input.comment) });
  return { judgment: revisionView(result.row, { viewerId: input.userId }), created: result.created };
}

export function judgeStackManifest(input: {
  workspaceId: string;
  stackId: string;
  manifestId: string;
  userId: string;
  verdict: JudgmentVerdict;
  comment: unknown;
}): { judgment: JudgmentView; created: boolean } {
  if (input.verdict !== "approved" && input.verdict !== "changes_requested") {
    throw new JudgmentWriteError(422, "verdict", "verdict must be approved or changes_requested.");
  }
  const result = judgeStackTransaction({ ...input, comment: normalizeJudgmentComment(input.comment) });
  return { judgment: stackView(result.row, { viewerId: input.userId }), created: result.created };
}

export function getMyRevisionJudgment(workspaceId: string, revisionId: string, userId: string): JudgmentView | null {
  const row = revisionWinner(workspaceId, revisionId, userId);
  return row ? revisionView(row, { viewerId: userId }) : null;
}

export function listRevisionJudgments(
  workspaceId: string,
  revisionId: string,
  projection: JudgmentProjection = { viewerId: null },
): JudgmentView[] {
  return db.query<RevisionJudgmentRow, [string, string]>(
    "SELECT * FROM review_revision_judgments WHERE workspace_id = ? AND revision_id = ? ORDER BY judged_at, id",
  ).all(workspaceId, revisionId).map((row) => revisionView(row, projection));
}

export function getMyStackJudgment(workspaceId: string, manifestId: string, userId: string): JudgmentView | null {
  const row = stackWinner(workspaceId, manifestId, userId);
  return row ? stackView(row, { viewerId: userId }) : null;
}

export function listStackJudgments(
  workspaceId: string,
  manifestId: string,
  projection: JudgmentProjection = { viewerId: null },
): JudgmentView[] {
  return db.query<StackJudgmentRow, [string, string]>(
    "SELECT * FROM review_stack_judgments WHERE workspace_id = ? AND manifest_id = ? ORDER BY judged_at, id",
  ).all(workspaceId, manifestId).map((row) => stackView(row, projection));
}
