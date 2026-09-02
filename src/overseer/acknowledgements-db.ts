// Personal handling for non-text review items.
//
// Active acknowledgement state, immutable carry provenance, and immutable judgment
// snapshots are deliberately separate tables. This module owns only the first two. A
// member may reverse active state; no reversal rewrites why a carry once happened.

import { db } from "../db";
import type { ReviewItemIdentity } from "./revision-delta";

export type AcknowledgementItemType = "material" | "file";
export type AcknowledgementProvenance = "explicit" | "carried";

export interface AcknowledgementRow {
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  user_id: string;
  item_id: string;
  item_type: AcknowledgementItemType;
  identity_digest: string;
  provenance_kind: AcknowledgementProvenance;
  source_revision_id: string | null;
  source_item_id: string | null;
  equivalence_digest: string | null;
  acknowledged_at: number;
}

export interface AcknowledgementCarryRow {
  target_revision_id: string;
  user_id: string;
  target_item_id: string;
  workspace_id: string;
  lineage_id: string;
  source_revision_id: string;
  source_item_id: string;
  source_identity_digest: string;
  target_identity_digest: string;
  equivalence_digest: string;
  carried_at: number;
}

interface StoredItemEquivalenceRow {
  target_revision_id: string;
  target_item_id: string;
  workspace_id: string;
  lineage_id: string;
  source_revision_id: string;
  source_item_id: string;
  item_type: AcknowledgementItemType;
  source_identity_digest: string;
  target_identity_digest: string;
  equivalence_digest: string;
}

function acknowledgeable(item: ReviewItemIdentity): item is ReviewItemIdentity & { type: AcknowledgementItemType } {
  return item.type === "material" || item.type === "file";
}

function hasAcknowledgementBoundary(
  workspaceId: string,
  revisionId: string,
  userId: string,
  itemId: string,
): boolean {
  return !!db.query<{ found: number }, [string, string, string, string]>(
    "SELECT 1 AS found FROM review_revision_acknowledgement_boundaries WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
  ).get(workspaceId, revisionId, userId, itemId);
}

export function listRevisionAcknowledgements(
  workspaceId: string,
  revisionId: string,
  userId: string,
): Map<string, AcknowledgementRow> {
  const rows = db.query<AcknowledgementRow, [string, string, string]>(
    "SELECT * FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? ORDER BY item_id ASC",
  ).all(workspaceId, revisionId, userId);
  return new Map(rows.map((row) => [row.item_id, row]));
}

export function listRevisionAcknowledgementCarries(
  workspaceId: string,
  revisionId: string,
  userId: string,
): AcknowledgementCarryRow[] {
  return db.query<AcknowledgementCarryRow, [string, string, string]>(
    "SELECT * FROM review_revision_acknowledgement_carries WHERE workspace_id = ? AND target_revision_id = ? AND user_id = ? ORDER BY target_item_id ASC",
  ).all(workspaceId, revisionId, userId);
}

/** Completion-time carry. The caller owns the revision-publication transaction. */
export function carryRevisionAcknowledgements(input: {
  workspaceId: string;
  lineageId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  equivalences: ReadonlyMap<string, {
    type: AcknowledgementItemType;
    sourceId: string;
    targetId: string;
    sourceDigest: string;
    targetDigest: string;
    equivalenceDigest: string;
  }>;
  now: number;
}): number {
  if (input.equivalences.size === 0) return 0;
  const active = db.query<AcknowledgementRow, [string, string]>(
    "SELECT * FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? ORDER BY user_id, item_id",
  ).all(input.workspaceId, input.sourceRevisionId);
  let carried = 0;
  for (const source of active) {
    const match = input.equivalences.get(source.item_id);
    if (!match || source.item_type !== match.type || source.identity_digest !== match.sourceDigest) continue;
    // Publication may arrive after the member handled this exact target directly. Their
    // explicit acknowledgement or reversal is a hard boundary for this hop.
    if (hasAcknowledgementBoundary(input.workspaceId, input.targetRevisionId, source.user_id, match.targetId)) continue;
    const targetActive = db.query<{ found: number }, [string, string, string, string]>(
      "SELECT 1 AS found FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
    ).get(input.workspaceId, input.targetRevisionId, source.user_id, match.targetId);
    if (targetActive) continue;
    const provenance = db.run(
      "INSERT INTO review_revision_acknowledgement_carries (target_revision_id, user_id, target_item_id, workspace_id, lineage_id, source_revision_id, source_item_id, source_identity_digest, target_identity_digest, equivalence_digest, carried_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_revision_id, user_id, target_item_id) DO NOTHING",
      [input.targetRevisionId, source.user_id, match.targetId, input.workspaceId, input.lineageId,
        input.sourceRevisionId, source.item_id, match.sourceDigest, match.targetDigest,
        match.equivalenceDigest, input.now],
    ).changes;
    // A provenance row left by an earlier carry protects a later reversal too. Only the
    // writer that inserted the reason is allowed to introduce active carried state.
    if (provenance === 0) continue;
    const inserted = db.run(
      "INSERT INTO review_revision_acknowledgements (workspace_id, lineage_id, revision_id, user_id, item_id, item_type, identity_digest, provenance_kind, source_revision_id, source_item_id, equivalence_digest, acknowledged_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'carried', ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, item_id) DO NOTHING",
      [input.workspaceId, input.lineageId, input.targetRevisionId, source.user_id, match.targetId,
        match.type, match.targetDigest, input.sourceRevisionId, source.item_id,
        match.equivalenceDigest, input.now],
    ).changes;
    if (inserted === 1) carried += 1;
  }
  return carried;
}

/** Carry one late acknowledgement through already-published successors, one stored exact
 * equivalence at a time. It runs inside the acknowledgement mutation transaction. */
export function carryAcknowledgementForward(
  workspaceId: string,
  revisionId: string,
  userId: string,
  itemId: string,
  now: number,
): void {
  let source = { revisionId, itemId };
  for (let hops = 0; hops < 10_000; hops++) {
    const active = db.query<AcknowledgementRow, [string, string, string, string]>(
      "SELECT * FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
    ).get(workspaceId, source.revisionId, userId, source.itemId);
    if (!active) return;
    const match = db.query<StoredItemEquivalenceRow, [string, string, string]>(
      "SELECT * FROM review_revision_item_equivalences WHERE workspace_id = ? AND source_revision_id = ? AND source_item_id = ? ORDER BY target_revision_id ASC LIMIT 1",
    ).get(workspaceId, source.revisionId, source.itemId);
    if (!match || active.item_type !== match.item_type || active.identity_digest !== match.source_identity_digest) return;
    // Check the target on every hop. An explicit decision at any successor stops this
    // older acknowledgement there and prevents it from reaching later successors.
    if (hasAcknowledgementBoundary(workspaceId, match.target_revision_id, userId, match.target_item_id)) return;
    const targetActive = db.query<{ found: number }, [string, string, string, string]>(
      "SELECT 1 AS found FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
    ).get(workspaceId, match.target_revision_id, userId, match.target_item_id);
    if (targetActive) return;
    const provenance = db.run(
      "INSERT INTO review_revision_acknowledgement_carries (target_revision_id, user_id, target_item_id, workspace_id, lineage_id, source_revision_id, source_item_id, source_identity_digest, target_identity_digest, equivalence_digest, carried_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_revision_id, user_id, target_item_id) DO NOTHING",
      [match.target_revision_id, userId, match.target_item_id, workspaceId, match.lineage_id,
        match.source_revision_id, match.source_item_id, match.source_identity_digest,
        match.target_identity_digest, match.equivalence_digest, now],
    ).changes;
    if (provenance === 0) return;
    const inserted = db.run(
      "INSERT INTO review_revision_acknowledgements (workspace_id, lineage_id, revision_id, user_id, item_id, item_type, identity_digest, provenance_kind, source_revision_id, source_item_id, equivalence_digest, acknowledged_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'carried', ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, item_id) DO NOTHING",
      [workspaceId, match.lineage_id, match.target_revision_id, userId, match.target_item_id,
        match.item_type, match.target_identity_digest, match.source_revision_id,
        match.source_item_id, match.equivalence_digest, now],
    ).changes;
    if (inserted === 0) return;
    source = { revisionId: match.target_revision_id, itemId: match.target_item_id };
  }
}

/** Set or reverse one active acknowledgement. The exact identity comes from the caller's
 * already-authorized immutable inventory. */
export function setRevisionAcknowledgementInTransaction(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  item: ReviewItemIdentity;
  acknowledged: boolean;
  now?: number;
}): AcknowledgementRow | null {
  if (!acknowledgeable(input.item)) throw new Error(`Review item ${input.item.id} is not acknowledgeable`);
  const revision = db.query<{ found: number }, [string, string, string]>(
    "SELECT 1 AS found FROM review_revisions WHERE workspace_id = ? AND lineage_id = ? AND id = ?",
  ).get(input.workspaceId, input.lineageId, input.revisionId);
  if (!revision) throw new Error(`Review revision ${input.revisionId} is outside the acknowledgement scope`);
  const now = input.now ?? Date.now();
  // Both directions are explicit handling. Record the boundary before changing active
  // state so an older acknowledgement can never overwrite this choice later.
  db.run(
    "INSERT OR IGNORE INTO review_revision_acknowledgement_boundaries (revision_id, user_id, item_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [input.revisionId, input.userId, input.item.id, input.workspaceId, now],
  );
  if (!input.acknowledged) {
    db.run(
      "DELETE FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
      [input.workspaceId, input.revisionId, input.userId, input.item.id],
    );
    return null;
  }
  db.run(
    "INSERT INTO review_revision_acknowledgements (workspace_id, lineage_id, revision_id, user_id, item_id, item_type, identity_digest, provenance_kind, source_revision_id, source_item_id, equivalence_digest, acknowledged_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'explicit', NULL, NULL, NULL, ?) " +
      "ON CONFLICT(workspace_id, revision_id, user_id, item_id) DO UPDATE SET " +
      "lineage_id = excluded.lineage_id, item_type = excluded.item_type, identity_digest = excluded.identity_digest, " +
      "provenance_kind = 'explicit', source_revision_id = NULL, source_item_id = NULL, equivalence_digest = NULL, " +
      "acknowledged_at = CASE WHEN review_revision_acknowledgements.provenance_kind = 'explicit' " +
      "AND review_revision_acknowledgements.item_type = excluded.item_type " +
      "AND review_revision_acknowledgements.identity_digest = excluded.identity_digest " +
      "THEN review_revision_acknowledgements.acknowledged_at ELSE excluded.acknowledged_at END",
    [input.workspaceId, input.lineageId, input.revisionId, input.userId, input.item.id,
      input.item.type, input.item.digest, now],
  );
  carryAcknowledgementForward(input.workspaceId, input.revisionId, input.userId, input.item.id, now);
  return db.query<AcknowledgementRow, [string, string, string, string]>(
    "SELECT * FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND item_id = ?",
  ).get(input.workspaceId, input.revisionId, input.userId, input.item.id);
}

export const setRevisionAcknowledgement = db.transaction(setRevisionAcknowledgementInTransaction) as
  typeof setRevisionAcknowledgementInTransaction;
