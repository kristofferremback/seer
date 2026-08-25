// Stage capture persistence. Captures are completed workflow records, separate from
// stages and versions that later slices will add. Every query carries workspace scope.
import { db } from "../db";
import { tinyId } from "../ids";

export type Availability = "retained" | "unavailable" | "not_applicable";
export type MaterialKind = "snapshot_incomplete" | "bytes_unavailable" | "lines_unavailable" | "patch_unavailable" | "metadata_incomplete";

export interface StageCaptureRow {
  id: string;
  workspace_id: string;
  slug: string;
  repo: string;
  repo_id: number;
  branch: string;
  base_ref: string;
  source_head_sha: string;
  base_tip_sha: string;
  merge_base_sha: string;
  patch_sha256: string | null;
  state: "completed";
  created_at: number;
}

export interface StageCaptureFileRow {
  id: string;
  workspace_id: string;
  capture_id: string;
  path: string;
  old_path: string | null;
  status: string;
  old_object_id: string | null;
  new_object_id: string | null;
  old_mode: string | null;
  new_mode: string | null;
  old_kind: string | null;
  new_kind: string | null;
  additions: number | null;
  deletions: number | null;
  old_availability: Availability;
  new_availability: Availability;
  old_blob_sha: string | null;
  new_blob_sha: string | null;
  old_reason: string | null;
  new_reason: string | null;
}

export interface StageCaptureChangeRow {
  id: string;
  workspace_id: string;
  capture_id: string;
  file_id: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  old_fingerprint: string;
  new_fingerprint: string;
  context_fingerprint: string;
  source: "patch" | "reconstructed";
}

export interface StageIncompleteRow {
  id: string;
  workspace_id: string;
  capture_id: string;
  kind: MaterialKind;
  path: string | null;
  side: "old" | "new" | "snapshot";
  reason: string;
}

export interface StageCaptureInventory {
  capture: StageCaptureRow;
  files: StageCaptureFileRow[];
  changes: StageCaptureChangeRow[];
  incomplete: StageIncompleteRow[];
}

export function getStageCapture(id: string, workspaceId: string): StageCaptureInventory | null {
  const capture = db.query<StageCaptureRow, [string, string]>(
    "SELECT * FROM stage_captures WHERE id = ? AND workspace_id = ? AND state = 'completed'",
  ).get(id, workspaceId);
  if (!capture) return null;
  return inventory(capture);
}

export function getStageCaptureForWorkspaces(id: string, workspaceIds: string[]): StageCaptureInventory | null {
  if (workspaceIds.length === 0) return null;
  const marks = workspaceIds.map(() => "?").join(",");
  const capture = db.query<StageCaptureRow, string[]>(
    `SELECT * FROM stage_captures WHERE id = ? AND workspace_id IN (${marks}) AND state = 'completed'`,
  ).get(id, ...workspaceIds);
  return capture ? inventory(capture) : null;
}

function inventory(capture: StageCaptureRow): StageCaptureInventory {
  return {
    capture,
    files: db.query<StageCaptureFileRow, [string, string]>(
      "SELECT * FROM stage_capture_files WHERE workspace_id = ? AND capture_id = ? ORDER BY path, id",
    ).all(capture.workspace_id, capture.id),
    changes: db.query<StageCaptureChangeRow, [string, string]>(
      "SELECT c.* FROM stage_capture_changes c JOIN stage_capture_files f ON f.workspace_id = c.workspace_id AND f.capture_id = c.capture_id AND f.id = c.file_id WHERE c.workspace_id = ? AND c.capture_id = ? ORDER BY f.path, c.old_start, c.new_start, c.id",
    ).all(capture.workspace_id, capture.id),
    incomplete: db.query<StageIncompleteRow, [string, string]>(
      "SELECT * FROM stage_capture_incomplete WHERE workspace_id = ? AND capture_id = ? ORDER BY side, path, id",
    ).all(capture.workspace_id, capture.id),
  };
}

export function getStageIdempotency(workspaceId: string, key: string): { request_hash: string; capture_id: string } | null {
  return db.query<{ request_hash: string; capture_id: string }, [string, string]>(
    "SELECT request_hash, capture_id FROM stage_capture_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, key);
}

export class StageIdempotencyConflict extends Error {
  constructor() {
    super("This Idempotency-Key was already used for a different capture request.");
    this.name = "StageIdempotencyConflict";
  }
}

export interface CaptureInsert {
  capture: Omit<StageCaptureRow, "created_at" | "state">;
  requestHash: string;
  idempotencyKey: string;
  files: Omit<StageCaptureFileRow, "workspace_id" | "capture_id">[];
  changes: StageCaptureChangeRow[];
  incomplete: StageIncompleteRow[];
  blobs: { sha256: string; bytes: number }[];
}

/** One short transaction makes the capture visible only after all objects are written. */
export const insertStageCapture = db.transaction((input: CaptureInsert): { captureId: string; created: boolean } => {
  const old = getStageIdempotency(input.capture.workspace_id, input.idempotencyKey);
  if (old) {
    if (old.request_hash !== input.requestHash) throw new StageIdempotencyConflict();
    return { captureId: old.capture_id, created: false };
  }
  const now = Date.now();
  db.run(
    "INSERT INTO stage_captures (id, workspace_id, slug, repo, repo_id, branch, base_ref, source_head_sha, base_tip_sha, merge_base_sha, patch_sha256, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)",
    [input.capture.id, input.capture.workspace_id, input.capture.slug, input.capture.repo, input.capture.repo_id,
      input.capture.branch, input.capture.base_ref, input.capture.source_head_sha, input.capture.base_tip_sha,
      input.capture.merge_base_sha, input.capture.patch_sha256, now],
  );
  db.run(
    "INSERT INTO stage_capture_idempotency (workspace_id, idempotency_key, request_hash, capture_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [input.capture.workspace_id, input.idempotencyKey, input.requestHash, input.capture.id, now],
  );
  for (const blob of input.blobs) {
    db.run(
      "INSERT OR IGNORE INTO stage_blobs (workspace_id, sha256, bytes, created_at) VALUES (?, ?, ?, ?)",
      [input.capture.workspace_id, blob.sha256, blob.bytes, now],
    );
  }
  for (const file of input.files) {
    db.run(
      "INSERT INTO stage_capture_files (id, workspace_id, capture_id, path, old_path, status, old_object_id, new_object_id, old_mode, new_mode, old_kind, new_kind, additions, deletions, old_availability, new_availability, old_blob_sha, new_blob_sha, old_reason, new_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [file.id, input.capture.workspace_id, input.capture.id, file.path, file.old_path, file.status, file.old_object_id,
        file.new_object_id, file.old_mode, file.new_mode, file.old_kind, file.new_kind, file.additions, file.deletions,
        file.old_availability, file.new_availability, file.old_blob_sha, file.new_blob_sha, file.old_reason, file.new_reason],
    );
  }
  for (const change of input.changes) {
    db.run(
      "INSERT INTO stage_capture_changes (id, workspace_id, capture_id, file_id, old_start, old_lines, new_start, new_lines, old_fingerprint, new_fingerprint, context_fingerprint, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [change.id, input.capture.workspace_id, input.capture.id, change.file_id, change.old_start, change.old_lines, change.new_start, change.new_lines,
        change.old_fingerprint, change.new_fingerprint, change.context_fingerprint, change.source],
    );
  }
  for (const item of input.incomplete) {
    db.run(
      "INSERT INTO stage_capture_incomplete (id, workspace_id, capture_id, kind, path, side, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [item.id, input.capture.workspace_id, input.capture.id, item.kind, item.path, item.side, item.reason],
    );
  }
  return { captureId: input.capture.id, created: true };
}) as (input: CaptureInsert) => { captureId: string; created: boolean };

export function freshFileId(): string { return tinyId("stf"); }
export function freshIncompleteId(): string { return tinyId("sti"); }
