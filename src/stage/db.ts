// Stage capture persistence. Captures are completed workflow records, separate from
// stages and versions that later slices will add. Every query carries workspace scope.
import { db } from "../db";
import { SLUG_RE, STA_ID_RE, STG_ID_RE, tinyId } from "../ids";
import type { StageDoc } from "./types";

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

export interface StageCaptureBuilderRow {
  workspace_id: string;
  capture_id: string;
  intent: string;
  context: string;
  agent_name: string;
  agent_model: string;
  user_id: string | null;
  key_id: string | null;
  created_at: number;
}

export interface StageCaptureInventory {
  capture: StageCaptureRow;
  builder: StageCaptureBuilderRow | null;
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
    builder: db.query<StageCaptureBuilderRow, [string, string]>(
      "SELECT * FROM stage_capture_builders WHERE workspace_id = ? AND capture_id = ?",
    ).get(capture.workspace_id, capture.id) ?? null,
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
  builder?: Omit<StageCaptureBuilderRow, "workspace_id" | "capture_id" | "created_at">;
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
  if (input.builder) {
    db.run(
      "INSERT INTO stage_capture_builders (workspace_id, capture_id, intent, context, agent_name, agent_model, user_id, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [input.capture.workspace_id, input.capture.id, input.builder.intent, input.builder.context, input.builder.agent_name, input.builder.agent_model, input.builder.user_id, input.builder.key_id, now],
    );
  }
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

export interface StageRow {
  id: string;
  workspace_id: string;
  slug: string;
  repo: string;
  repo_id: number;
  branch: string;
  lineage_base_ref: string;
  lineage_base_sha: string;
  latest_version: number;
  created_by_user_id: string;
  created_by_key_id: string;
  created_at: number;
  updated_at: number;
}

export interface StageVersionRow {
  id: string;
  workspace_id: string;
  stage_id: string;
  slug: string;
  version: number;
  capture_id: string;
  doc: StageDoc;
  digest: string;
  witness_user_id: string;
  witness_key_id: string;
  created_at: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function stageAgent(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "model"]) && typeof value.name === "string" && value.name.length >= 1 && value.name.length <= 80 && typeof value.model === "string" && value.model.length >= 1 && value.model.length <= 80;
}

function stageGroup(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => !["id", "title", "category", "importance", "complexity", "explanation", "attention", "examples", "members"].includes(key)) ||
      !["id", "title", "category", "importance", "complexity", "explanation", "examples", "members"].every((key) => key in value)) return false;
  if (typeof value.id !== "string" || !SLUG_RE.test(value.id) || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 60 ||
      !["Contract", "Code", "Tests", "Test fixtures", "Docs", "Generated"].includes(value.category as string) ||
      !["low", "medium", "high"].includes(value.importance as string) ||
      !["low", "medium", "high"].includes(value.complexity as string) || typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > 1600 ||
      !Array.isArray(value.examples) || value.examples.length > 5 || !Array.isArray(value.members) || value.members.length > 10000) return false;
  if ("attention" in value && (typeof value.attention !== "string" || value.attention.length > 300)) return false;
  return value.examples.every((example) => record(example) && exactKeys(example, ["code", "text"]) && typeof example.code === "string" && example.code.length >= 1 && example.code.length <= 500 && typeof example.text === "string" && example.text.length >= 1 && example.text.length <= 300) &&
    value.members.every((member) => record(member) && exactKeys(member, ["type", "id", "description"]) &&
      ["change", "material", "file"].includes(member.type as string) && typeof member.id === "string" && member.id.length >= 1 && member.id.length <= 80 && typeof member.description === "string" && member.description.length >= 1 && member.description.length <= 400);
}

function isStageDoc(value: unknown): value is StageDoc {
  if (!record(value) || !exactKeys(value, ["identity", "source", "builder", "witness", "projects"])) return false;
  const identity = value.identity;
  const source = value.source;
  const builder = value.builder;
  const witness = value.witness;
  if (!record(identity) || !exactKeys(identity, ["id", "slug", "version", "title", "createdAt"]) ||
      !STA_ID_RE.test(String(identity.id)) || !SLUG_RE.test(String(identity.slug)) || !Number.isInteger(identity.version) || (identity.version as number) < 1 ||
      typeof identity.title !== "string" || identity.title.length < 1 || identity.title.length > 80 || typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) return false;
  if (!record(source) || !exactKeys(source, ["captureId", "repo", "repoId", "branch", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha"]) ||
      typeof source.captureId !== "string" || !STG_ID_RE.test(source.captureId) || typeof source.repo !== "string" || !Number.isInteger(source.repoId) ||
      typeof source.branch !== "string" || typeof source.baseRef !== "string" || typeof source.sourceHeadSha !== "string" || typeof source.baseTipSha !== "string" || typeof source.mergeBaseSha !== "string") return false;
  if (!record(builder) || !exactKeys(builder, ["intent", "context", "agent", "userId", "keyId"]) || typeof builder.intent !== "string" || builder.intent.length < 1 || builder.intent.length > 1200 || typeof builder.context !== "string" || builder.context.length > 4000 || !stageAgent(builder.agent) || typeof builder.userId !== "string" || typeof builder.keyId !== "string") return false;
  if (!record(witness) || !exactKeys(witness, ["summary", "groups", "agent", "userId", "keyId"]) || typeof witness.summary !== "string" || witness.summary.length < 1 || witness.summary.length > 1200 || !Array.isArray(witness.groups) || witness.groups.length < 1 || witness.groups.length > 16 || !stageAgent(witness.agent) || typeof witness.userId !== "string" || typeof witness.keyId !== "string" || !witness.groups.every(stageGroup)) return false;
  return Array.isArray(value.projects) && value.projects.length <= 16 && value.projects.every((project) => typeof project === "string" && SLUG_RE.test(project));
}

function parseStageVersion(row: Omit<StageVersionRow, "doc"> & { doc: string }): StageVersionRow | null {
  try {
    const doc = JSON.parse(row.doc) as unknown;
    if (!isStageDoc(doc)) {
      console.error(`[seer] stage version ${row.id}: stored document has an invalid StageDoc shape`);
      return null;
    }
    if (doc.identity.id !== row.stage_id || doc.identity.slug !== row.slug || doc.identity.version !== row.version || doc.source.captureId !== row.capture_id) {
      console.error(`[seer] stage version ${row.id}: stored document identity does not match its row`);
      return null;
    }
    return { ...row, doc };
  } catch {
    console.error(`[seer] stage version ${row.id}: stored document is not valid JSON`);
    return null;
  }
}

export function getStage(workspaceId: string, slug: string): StageRow | null {
  return db.query<StageRow, [string, string]>("SELECT * FROM stages WHERE workspace_id = ? AND slug = ?").get(workspaceId, slug);
}

export function getStageVersion(workspaceId: string, slug: string, version: number): StageVersionRow | null {
  const row = db.query<Omit<StageVersionRow, "doc"> & { doc: string }, [string, string, number]>(
    "SELECT sv.* FROM stage_versions sv JOIN stages s ON s.id = sv.stage_id AND s.workspace_id = sv.workspace_id AND s.slug = sv.slug WHERE sv.workspace_id = ? AND sv.slug = ? AND sv.version = ?",
  ).get(workspaceId, slug, version);
  return row ? parseStageVersion(row) : null;
}

export function getStageVersionByCapture(workspaceId: string, captureId: string): StageVersionRow | null {
  const row = db.query<Omit<StageVersionRow, "doc"> & { doc: string }, [string, string]>(
    "SELECT sv.* FROM stage_versions sv JOIN stages s ON s.id = sv.stage_id AND s.workspace_id = sv.workspace_id AND s.slug = sv.slug WHERE sv.workspace_id = ? AND sv.capture_id = ?",
  ).get(workspaceId, captureId);
  return row ? parseStageVersion(row) : null;
}

export function listProjectStageSlugs(workspaceId: string, projectId: string): string[] {
  return db.query<{ slug: string }, [string, string]>(
    "SELECT slug FROM project_stages WHERE workspace_id = ? AND project_id = ? ORDER BY created_at ASC",
  ).all(workspaceId, projectId).map((row) => row.slug);
}
