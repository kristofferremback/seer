// Promoted review persistence: the lineage, its immutable revisions and accounts, the
// witness request beside them, and per-revision read state. Every query carries
// workspace scope, and every write that has to be all-or-nothing is one transaction.
//
// Stored documents are validated on the way out, exactly as a StageDoc is: this module
// wrote them, so a shape that does not parse is corruption rather than an old format,
// and a reader that trusted it would render somebody else's facts under this slug.

import { createHash } from "node:crypto";
import { db } from "../db";
import { RLN_ID_RE, SLUG_RE, STG_ID_RE, tinyId } from "../ids";
import { getProject } from "../projects/db";
import { lineageOwnsSlug, stackOwnsSlug } from "./db";
import { onMemberAccountPublished } from "./stack-db";
import type { StageGroup } from "../stage/types";
import type {
  AccountDoc,
  EvidenceRef,
  FocusAnchor,
  FocusItem,
  RevisionBuilder,
  RevisionDoc,
  WitnessRequestState,
  WitnessWorkflowWord,
} from "./revision-types";

// ---- stable digests ----

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

// ---- rows ----

export interface ReviewLineageRow {
  id: string;
  workspace_id: string;
  slug: string;
  repo: string;
  repo_id: number;
  branch: string;
  original_base_ref: string;
  original_base_sha: string;
  title: string;
  latest_revision: number | null;
  latest_account_version: number | null;
  created_by_user_id: string;
  created_by_key_id: string;
  created_at: number;
  updated_at: number;
}

export interface ReviewRevisionRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  slug: string;
  revision: number;
  capture_id: string;
  schema_version: number;
  doc: RevisionDoc;
  digest: string;
  created_at: number;
}

export interface ReviewAccountRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  revision: number;
  slug: string;
  version: number;
  schema_version: number;
  doc: AccountDoc;
  digest: string;
  witness_user_id: string;
  witness_key_id: string;
  created_at: number;
}

export interface WitnessRequestRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  revision: number;
  state: WitnessRequestState;
  retry_count: number;
  failure: string | null;
  account_id: string | null;
  created_at: number;
  updated_at: number;
}

type Raw<T> = Omit<T, "doc"> & { doc: string };

// ---- stored-document shape checks ----

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function agent(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "model"]) &&
    typeof value.name === "string" && value.name.length >= 1 && value.name.length <= 80 &&
    typeof value.model === "string" && value.model.length >= 1 && value.model.length <= 80;
}

function builderFacts(value: unknown): value is RevisionBuilder {
  return record(value) && exactKeys(value, ["intent", "context", "agent", "userId", "keyId"]) &&
    typeof value.intent === "string" && typeof value.context === "string" && agent(value.agent) &&
    (value.userId === null || typeof value.userId === "string") &&
    (value.keyId === null || typeof value.keyId === "string");
}

function isRevisionDoc(value: unknown): value is RevisionDoc {
  if (!record(value) || !exactKeys(value, ["identity", "source", "builder", "projects"])) return false;
  const { identity, source } = value;
  if (!record(identity) || !exactKeys(identity, ["lineageId", "slug", "revision", "title", "createdAt"]) ||
      !RLN_ID_RE.test(String(identity.lineageId)) || !SLUG_RE.test(String(identity.slug)) ||
      !Number.isInteger(identity.revision) || (identity.revision as number) < 1 ||
      typeof identity.title !== "string" || identity.title.length < 1 || identity.title.length > 80 ||
      typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) return false;
  if (!record(source) || !exactKeys(source, ["captureId", "repo", "repoId", "branch", "originalBaseRef", "originalBaseSha", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha"]) ||
      typeof source.captureId !== "string" || !STG_ID_RE.test(source.captureId) ||
      typeof source.repo !== "string" || !Number.isInteger(source.repoId) ||
      !["branch", "originalBaseRef", "originalBaseSha", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha"].every((key) => typeof source[key] === "string")) return false;
  if (value.builder !== null && !builderFacts(value.builder)) return false;
  return Array.isArray(value.projects) && value.projects.length <= 16 &&
    value.projects.every((project) => typeof project === "string" && SLUG_RE.test(project));
}

function focusAnchor(value: unknown): value is FocusAnchor {
  return record(value) && exactKeys(value, ["type", "id"]) &&
    ["change", "material", "file"].includes(value.type as string) &&
    typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 80;
}

function focusItem(value: unknown): value is FocusItem {
  return record(value) && exactKeys(value, ["id", "kind", "title", "body", "anchors"]) &&
    typeof value.id === "string" && SLUG_RE.test(value.id) &&
    ["decision", "risk"].includes(value.kind as string) &&
    typeof value.title === "string" && value.title.length >= 1 && value.title.length <= 80 &&
    typeof value.body === "string" && value.body.length >= 1 && value.body.length <= 1200 &&
    Array.isArray(value.anchors) && value.anchors.length >= 1 && value.anchors.length <= 16 && value.anchors.every(focusAnchor);
}

function evidenceRef(value: unknown): value is EvidenceRef {
  if (!record(value)) return false;
  if (value.kind === "attachment") {
    return exactKeys(value, ["kind", "id", "reviewSlug", "mediaType", "bytes", "alt", "caption"]) &&
      typeof value.id === "string" && typeof value.reviewSlug === "string" && SLUG_RE.test(value.reviewSlug) &&
      typeof value.mediaType === "string" && Number.isInteger(value.bytes) && (value.bytes as number) >= 0 &&
      typeof value.alt === "string" && typeof value.caption === "string";
  }
  if (value.kind === "bundle") {
    return exactKeys(value, ["kind", "slug", "version"]) && typeof value.slug === "string" &&
      SLUG_RE.test(value.slug) && Number.isInteger(value.version) && (value.version as number) >= 1;
  }
  return false;
}

/** The account's groups are StageGroup values, deliberately: the semantic partition a
 *  witness authors over a revision is the same object the stage walkthrough uses, and
 *  the reader renders both through one path. */
function storedGroup(value: unknown): value is StageGroup {
  if (!record(value)) return false;
  const allowed = ["id", "title", "category", "importance", "complexity", "explanation", "attention", "examples", "members"];
  const required = allowed.filter((key) => key !== "attention");
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !required.every((key) => key in value)) return false;
  if (typeof value.id !== "string" || !SLUG_RE.test(value.id) ||
      typeof value.title !== "string" || value.title.length < 1 || value.title.length > 60 ||
      !["Contract", "Code", "Tests", "Test fixtures", "Docs", "Generated"].includes(value.category as string) ||
      !["low", "medium", "high"].includes(value.importance as string) ||
      !["low", "medium", "high"].includes(value.complexity as string) ||
      typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > 1600 ||
      !Array.isArray(value.examples) || value.examples.length > 5 ||
      !Array.isArray(value.members) || value.members.length > 10000) return false;
  if ("attention" in value && (typeof value.attention !== "string" || value.attention.length > 300)) return false;
  return value.examples.every((example) => record(example) && exactKeys(example, ["code", "text"]) &&
      typeof example.code === "string" && typeof example.text === "string") &&
    value.members.every((member) => record(member) && exactKeys(member, ["type", "id", "description"]) &&
      ["change", "material", "file"].includes(member.type as string) &&
      typeof member.id === "string" && member.id.length >= 1 && member.id.length <= 80 &&
      typeof member.description === "string" && member.description.length >= 1 && member.description.length <= 400);
}

function isAccountDoc(value: unknown): value is AccountDoc {
  if (!record(value) || !exactKeys(value, ["identity", "witness", "groups", "focus", "evidence"])) return false;
  const { identity, witness } = value;
  if (!record(identity) || !exactKeys(identity, ["lineageId", "slug", "revision", "version", "createdAt"]) ||
      !RLN_ID_RE.test(String(identity.lineageId)) || !SLUG_RE.test(String(identity.slug)) ||
      !Number.isInteger(identity.revision) || (identity.revision as number) < 1 ||
      !Number.isInteger(identity.version) || (identity.version as number) < 1 ||
      typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) return false;
  if (!record(witness) || !exactKeys(witness, ["summary", "agent", "userId", "keyId"]) ||
      typeof witness.summary !== "string" || witness.summary.length < 1 || witness.summary.length > 1200 ||
      !agent(witness.agent) || typeof witness.userId !== "string" || typeof witness.keyId !== "string") return false;
  return Array.isArray(value.groups) && value.groups.length >= 1 && value.groups.length <= 16 && value.groups.every(storedGroup) &&
    Array.isArray(value.focus) && value.focus.length <= 24 && value.focus.every(focusItem) &&
    Array.isArray(value.evidence) && value.evidence.length <= 16 && value.evidence.every(evidenceRef);
}

function parseRevision(row: Raw<ReviewRevisionRow>): ReviewRevisionRow | null {
  if (row.schema_version !== 1) {
    console.error(`[seer] review revision ${row.id}: unsupported schema version ${row.schema_version}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc) as unknown;
  } catch {
    console.error(`[seer] review revision ${row.id}: stored document is not valid JSON`);
    return null;
  }
  if (!isRevisionDoc(doc)) {
    console.error(`[seer] review revision ${row.id}: stored document has an invalid revision shape`);
    return null;
  }
  if (doc.identity.lineageId !== row.lineage_id || doc.identity.slug !== row.slug ||
      doc.identity.revision !== row.revision || doc.source.captureId !== row.capture_id) {
    console.error(`[seer] review revision ${row.id}: stored document identity does not match its row`);
    return null;
  }
  return { ...row, doc };
}

function parseAccount(row: Raw<ReviewAccountRow>): ReviewAccountRow | null {
  if (row.schema_version !== 1) {
    console.error(`[seer] review account ${row.id}: unsupported schema version ${row.schema_version}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc) as unknown;
  } catch {
    console.error(`[seer] review account ${row.id}: stored document is not valid JSON`);
    return null;
  }
  if (!isAccountDoc(doc)) {
    console.error(`[seer] review account ${row.id}: stored document has an invalid account shape`);
    return null;
  }
  if (doc.identity.lineageId !== row.lineage_id || doc.identity.slug !== row.slug ||
      doc.identity.revision !== row.revision || doc.identity.version !== row.version) {
    console.error(`[seer] review account ${row.id}: stored document identity does not match its row`);
    return null;
  }
  return { ...row, doc };
}

// ---- reads ----

export function getLineage(workspaceId: string, slug: string): ReviewLineageRow | null {
  return db.query<ReviewLineageRow, [string, string]>(
    "SELECT * FROM review_lineages WHERE workspace_id = ? AND slug = ?",
  ).get(workspaceId, slug);
}

export function listLineages(workspaceId: string): ReviewLineageRow[] {
  return db.query<ReviewLineageRow, [string]>(
    "SELECT * FROM review_lineages WHERE workspace_id = ? ORDER BY updated_at DESC",
  ).all(workspaceId);
}

export function getRevision(workspaceId: string, slug: string, revision: number): ReviewRevisionRow | null {
  const row = db.query<Raw<ReviewRevisionRow>, [string, string, number]>(
    "SELECT * FROM review_revisions WHERE workspace_id = ? AND slug = ? AND revision = ?",
  ).get(workspaceId, slug, revision);
  return row ? parseRevision(row) : null;
}

export function getRevisionById(workspaceId: string, revisionId: string): ReviewRevisionRow | null {
  const row = db.query<Raw<ReviewRevisionRow>, [string, string]>(
    "SELECT * FROM review_revisions WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, revisionId);
  return row ? parseRevision(row) : null;
}

export function getRevisionByCapture(workspaceId: string, captureId: string): ReviewRevisionRow | null {
  const row = db.query<Raw<ReviewRevisionRow>, [string, string]>(
    "SELECT * FROM review_revisions WHERE workspace_id = ? AND capture_id = ?",
  ).get(workspaceId, captureId);
  return row ? parseRevision(row) : null;
}

export function getAccount(workspaceId: string, slug: string, version: number): ReviewAccountRow | null {
  const row = db.query<Raw<ReviewAccountRow>, [string, string, number]>(
    "SELECT * FROM review_accounts WHERE workspace_id = ? AND slug = ? AND version = ?",
  ).get(workspaceId, slug, version);
  return row ? parseAccount(row) : null;
}

export function getAccountById(workspaceId: string, accountId: string): ReviewAccountRow | null {
  const row = db.query<Raw<ReviewAccountRow>, [string, string]>(
    "SELECT * FROM review_accounts WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, accountId);
  return row ? parseAccount(row) : null;
}

/** The newest account published over one revision, or null while none has been. */
export function latestAccountForRevision(workspaceId: string, revisionId: string): ReviewAccountRow | null {
  const row = db.query<Raw<ReviewAccountRow>, [string, string]>(
    "SELECT * FROM review_accounts WHERE workspace_id = ? AND revision_id = ? ORDER BY version DESC LIMIT 1",
  ).get(workspaceId, revisionId);
  return row ? parseAccount(row) : null;
}

/** The revision immediately after this one in the same lineage, or null on the latest.
 *  Where a read marked on this revision may still carry to. */
export function nextRevision(
  workspaceId: string,
  lineageId: string,
  revision: number,
): ReviewRevisionRow | null {
  const row = db.query<Raw<ReviewRevisionRow>, [string, string, number]>(
    "SELECT * FROM review_revisions WHERE workspace_id = ? AND lineage_id = ? AND revision > ? ORDER BY revision ASC LIMIT 1",
  ).get(workspaceId, lineageId, revision);
  return row ? parseRevision(row) : null;
}

/** The revision immediately before this one in the same lineage, or null on the first.
 *  What the retained code delta is measured against. */
export function previousRevision(
  workspaceId: string,
  lineageId: string,
  revision: number,
): ReviewRevisionRow | null {
  const row = db.query<Raw<ReviewRevisionRow>, [string, string, number]>(
    "SELECT * FROM review_revisions WHERE workspace_id = ? AND lineage_id = ? AND revision < ? ORDER BY revision DESC LIMIT 1",
  ).get(workspaceId, lineageId, revision);
  return row ? parseRevision(row) : null;
}

/**
 * The exact latest account published over a revision LOWER than this one, or null.
 *
 * Never an account from the target revision itself and never a later one: a fresh witness
 * asking what the last walkthrough said must be handed the last walkthrough, not the one
 * somebody else is writing beside them.
 */
export function latestAccountBeforeRevision(
  workspaceId: string,
  lineageId: string,
  revision: number,
): ReviewAccountRow | null {
  const row = db.query<Raw<ReviewAccountRow>, [string, string, number]>(
    "SELECT * FROM review_accounts WHERE workspace_id = ? AND lineage_id = ? AND revision < ? " +
      "ORDER BY revision DESC, version DESC LIMIT 1",
  ).get(workspaceId, lineageId, revision);
  return row ? parseAccount(row) : null;
}

export function listAccountVersions(workspaceId: string, slug: string): { version: number; revision: number; created_at: number }[] {
  return db.query<{ version: number; revision: number; created_at: number }, [string, string]>(
    "SELECT version, revision, created_at FROM review_accounts WHERE workspace_id = ? AND slug = ? ORDER BY version ASC",
  ).all(workspaceId, slug);
}

export function getWitnessRequest(workspaceId: string, id: string): WitnessRequestRow | null {
  return db.query<WitnessRequestRow, [string, string]>(
    "SELECT * FROM review_witness_requests WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

export function getWitnessRequestForRevision(workspaceId: string, revisionId: string): WitnessRequestRow | null {
  return db.query<WitnessRequestRow, [string, string]>(
    "SELECT * FROM review_witness_requests WHERE workspace_id = ? AND revision_id = ?",
  ).get(workspaceId, revisionId);
}

/**
 * The word a reader is shown.
 *
 * `retrying` is pending after at least one failure, which is a different thing to say than
 * "we have not heard yet". `superseded` is a later revision having been appended while this
 * request was still open, which is a third thing again: nobody is coming, and saying
 * "pending" forever would be a promise the workflow has already broken. Published wins over
 * both, because an account that exists is not waiting for anything.
 */
export function workflowWord(request: WitnessRequestRow | null): WitnessWorkflowWord | null {
  if (!request) return null;
  if (request.state === "published") return "published";
  if (isWitnessRequestSuperseded(request.id)) return "superseded";
  if (request.state === "failed") return "failed";
  return request.retry_count > 0 ? "retrying" : "pending";
}

// ---- supersession ----

export interface WitnessSupersessionRow {
  request_id: string;
  workspace_id: string;
  lineage_id: string;
  superseded_revision_id: string;
  successor_revision_id: string;
  created_at: number;
}

export function getWitnessSupersession(requestId: string): WitnessSupersessionRow | null {
  return db.query<WitnessSupersessionRow, [string]>(
    "SELECT * FROM review_witness_supersessions WHERE request_id = ?",
  ).get(requestId);
}

export function isWitnessRequestSuperseded(requestId: string): boolean {
  return getWitnessSupersession(requestId) !== null;
}

/**
 * Record that appending one revision left every earlier unpublished request behind.
 *
 * INSERT OR IGNORE, so the FIRST successor is preserved: revision 3 arriving does not
 * rewrite revision 1's request to say it was superseded by 3 when it was in fact 2 that
 * overtook it. Published requests are skipped, because an account that exists was not
 * overtaken — it finished.
 *
 * Not a transaction of its own: the only caller is the completion transaction, which has
 * to commit this with the revision that caused it or with none of it.
 */
export function supersedeOpenWitnessRequests(
  workspaceId: string,
  lineageId: string,
  successorRevisionId: string,
  successorRevision: number,
  now: number,
): number {
  const open = db.query<WitnessRequestRow, [string, string, number]>(
    "SELECT * FROM review_witness_requests WHERE workspace_id = ? AND lineage_id = ? AND revision < ? AND state != 'published'",
  ).all(workspaceId, lineageId, successorRevision);
  let written = 0;
  for (const request of open) {
    written += db.run(
      "INSERT OR IGNORE INTO review_witness_supersessions (request_id, workspace_id, lineage_id, superseded_revision_id, successor_revision_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [request.id, workspaceId, lineageId, request.revision_id, successorRevisionId, now],
    ).changes;
  }
  return written;
}

// ---- carried reads ----

/** Why a read arrived on a revision nobody had opened yet. Immutable: unmarking the
 *  active read removes that row and leaves this one, because the carry still happened. */
export interface RevisionReadCarryRow {
  target_revision_id: string;
  user_id: string;
  target_change_id: string;
  workspace_id: string;
  lineage_id: string;
  source_revision_id: string;
  source_change_id: string;
  key_digest: string;
  carried_at: number;
}

export function listRevisionReadCarries(
  workspaceId: string,
  revisionId: string,
  userId: string,
): RevisionReadCarryRow[] {
  return db.query<RevisionReadCarryRow, [string, string, string]>(
    "SELECT * FROM review_revision_read_carries WHERE workspace_id = ? AND target_revision_id = ? AND user_id = ? " +
      "ORDER BY target_change_id ASC",
  ).all(workspaceId, revisionId, userId);
}

export function countRevisionReadCarries(
  workspaceId: string,
  revisionId: string,
  userId: string,
): number {
  return db.query<{ n: number }, [string, string, string]>(
    "SELECT COUNT(*) AS n FROM review_revision_read_carries WHERE workspace_id = ? AND target_revision_id = ? AND user_id = ?",
  ).get(workspaceId, revisionId, userId)!.n;
}

/**
 * Carry every member's read from one revision onto the next, where — and only where — a
 * unique exact equivalence proves the change is the same change.
 *
 * The active read and its provenance are written together, one statement apart, inside the
 * caller's transaction: a read whose reason did not commit would be a mark nobody can
 * account for, and a reason whose read did not commit would be a claim about a state that
 * does not exist.
 *
 * `equivalences` is keyed by the SOURCE change id, which is what a stored read names. The
 * shape is structural rather than imported, so persistence does not depend on the delta
 * engine that computes it.
 *
 * Not a transaction of its own, for the same reason as the supersession above.
 */
export function carryRevisionReads(input: {
  workspaceId: string;
  lineageId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  equivalences: ReadonlyMap<string, { targetChangeId: string; digest: string }>;
  now: number;
}): number {
  if (input.equivalences.size === 0) return 0;
  const reads = db.query<{ user_id: string; change_id: string }, [string, string]>(
    "SELECT user_id, change_id FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ? " +
      "ORDER BY user_id ASC, change_id ASC",
  ).all(input.workspaceId, input.sourceRevisionId);
  let carried = 0;
  for (const read of reads) {
    const match = input.equivalences.get(read.change_id);
    if (!match) continue;
    db.run(
      "INSERT INTO review_revision_change_reads (workspace_id, revision_id, user_id, change_id, read_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, change_id) DO NOTHING",
      [input.workspaceId, input.targetRevisionId, read.user_id, match.targetChangeId, input.now],
    );
    db.run(
      "INSERT INTO review_revision_read_carries (target_revision_id, user_id, target_change_id, workspace_id, lineage_id, source_revision_id, source_change_id, key_digest, carried_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_revision_id, user_id, target_change_id) DO NOTHING",
      [input.targetRevisionId, read.user_id, match.targetChangeId, input.workspaceId, input.lineageId,
        input.sourceRevisionId, read.change_id, match.digest, input.now],
    );
    carried += 1;
  }
  return carried;
}

// ---- stored movement ----

/** What one revision changed about the one before it, written once. Both captures are
 *  immutable and the engine is deterministic over them, so this is a fact rather than a
 *  cache: asked again it would say the same thing at the cost of two inventories. */
export interface RevisionMovementRow {
  revision_id: string;
  workspace_id: string;
  lineage_id: string;
  previous_revision_id: string;
  unchanged: number;
  revised: number;
  new: number;
  removed: number;
  computed_at: number;
  /** Null on movement rows written before v22 until material/file equivalences are stored. */
  items_computed_at: number | null;
}

export function getRevisionMovement(workspaceId: string, revisionId: string): RevisionMovementRow | null {
  return db.query<RevisionMovementRow, [string, string]>(
    "SELECT * FROM review_revision_movements WHERE workspace_id = ? AND revision_id = ?",
  ).get(workspaceId, revisionId);
}

/**
 * Store the counts and every exact text and acknowledgement equivalence between one
 * revision and the one before it. INSERT OR IGNORE throughout: two writers computing the
 * same immutable answer land one row, and the first is as right as the second. The v22
 * item marker is written last so a partial attempt remains retryable.
 *
 * Not a transaction of its own. The completion transaction writes this beside the revision
 * it describes; a page filling it in for a revision published before it was stored wraps
 * its own.
 */
export function storeRevisionMovement(input: {
  workspaceId: string;
  lineageId: string;
  previousRevisionId: string;
  revisionId: string;
  counts: { unchanged: number; revised: number; new: number; removed: number };
  readEquivalences: ReadonlyMap<string, { targetChangeId: string; digest: string }>;
  ackEquivalences: ReadonlyMap<string, {
    type: "material" | "file";
    sourceId: string;
    targetId: string;
    sourceDigest: string;
    targetDigest: string;
    equivalenceDigest: string;
  }>;
  now: number;
}): void {
  db.run(
    "INSERT OR IGNORE INTO review_revision_movements (revision_id, workspace_id, lineage_id, previous_revision_id, unchanged, revised, new, removed, computed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [input.revisionId, input.workspaceId, input.lineageId, input.previousRevisionId,
      input.counts.unchanged, input.counts.revised, input.counts.new, input.counts.removed, input.now],
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO review_revision_equivalences (target_revision_id, target_change_id, workspace_id, lineage_id, source_revision_id, source_change_id, key_digest) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [sourceChangeId, match] of input.readEquivalences) {
    insert.run(input.revisionId, match.targetChangeId, input.workspaceId, input.lineageId, input.previousRevisionId, sourceChangeId, match.digest);
  }
  const insertItem = db.prepare(
    "INSERT OR IGNORE INTO review_revision_item_equivalences (target_revision_id, target_item_id, workspace_id, lineage_id, source_revision_id, source_item_id, item_type, source_identity_digest, target_identity_digest, equivalence_digest) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const match of input.ackEquivalences.values()) {
    insertItem.run(input.revisionId, match.targetId, input.workspaceId, input.lineageId,
      input.previousRevisionId, match.sourceId, match.type, match.sourceDigest,
      match.targetDigest, match.equivalenceDigest);
  }
  db.run(
    "UPDATE review_revision_movements SET items_computed_at = COALESCE(items_computed_at, ?) WHERE workspace_id = ? AND revision_id = ?",
    [input.now, input.workspaceId, input.revisionId],
  );
}

interface StoredEquivalenceRow {
  target_revision_id: string;
  target_change_id: string;
  workspace_id: string;
  lineage_id: string;
  source_revision_id: string;
  source_change_id: string;
  key_digest: string;
}

/**
 * Carry one read forward through every stored equivalence it has, as far as it goes.
 *
 * The completion-time carry only sees reads that existed when the next revision was
 * published; a member who keeps reading revision N after N+1 arrived — the ordinary timing,
 * since webhooks land while people read — would otherwise start N+1 from nothing. Each hop
 * is carried at most once per member and change. A carry provenance row protects a
 * carried-then-unmarked target; `review_revision_read_boundaries` protects a target the
 * member marked directly and later unmarked. Either way, a mark on N cannot overwrite an
 * explicit state on N+1.
 *
 * Not a transaction of its own: it runs inside the read write it belongs to.
 */
function carryReadForward(workspaceId: string, revisionId: string, userId: string, changeId: string, now: number): void {
  let source = { revisionId, changeId };
  for (let hops = 0; hops < 10_000; hops++) {
    const match = db.query<StoredEquivalenceRow, [string, string, string]>(
      "SELECT * FROM review_revision_equivalences WHERE workspace_id = ? AND source_revision_id = ? AND source_change_id = ? " +
        "ORDER BY target_revision_id ASC LIMIT 1",
    ).get(workspaceId, source.revisionId, source.changeId);
    if (!match) return;
    const boundary = db.query<{ found: number }, [string, string, string, string]>(
      "SELECT 1 AS found FROM review_revision_read_boundaries WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND change_id = ?",
    ).get(workspaceId, match.target_revision_id, userId, match.target_change_id);
    // A member already marked or unmarked this exact target. Their explicit state wins
    // over anything an older revision might carry into it later.
    if (boundary) return;
    const carried = db.run(
      "INSERT INTO review_revision_read_carries (target_revision_id, user_id, target_change_id, workspace_id, lineage_id, source_revision_id, source_change_id, key_digest, carried_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_revision_id, user_id, target_change_id) DO NOTHING",
      [match.target_revision_id, userId, match.target_change_id, workspaceId, match.lineage_id,
        match.source_revision_id, match.source_change_id, match.key_digest, now],
    ).changes;
    if (carried === 0) return;
    db.run(
      "INSERT INTO review_revision_change_reads (workspace_id, revision_id, user_id, change_id, read_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, change_id) DO NOTHING",
      [workspaceId, match.target_revision_id, userId, match.target_change_id, now],
    );
    source = { revisionId: match.target_revision_id, changeId: match.target_change_id };
  }
}

// ---- read state ----

export function listRevisionReadChangeIds(workspaceId: string, revisionId: string, userId: string): Set<string> {
  return new Set(db.query<{ change_id: string }, [string, string, string]>(
    "SELECT change_id FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ? AND user_id = ?",
  ).all(workspaceId, revisionId, userId).map((row) => row.change_id));
}

/** The route verifies that the revision's capture owns the change before this write. A
 *  read marked on a revision that already has a successor carries forward in the same
 *  transaction, through the stored equivalences the successor's completion wrote. Every
 *  explicit mark or unmark also records a boundary so an older revision cannot later
 *  overwrite this member's state here. */
export function setRevisionChangeReadInTransaction(
  workspaceId: string,
  revisionId: string,
  userId: string,
  changeId: string,
  read: boolean,
  now = Date.now(),
): void {
  db.run(
    "INSERT OR IGNORE INTO review_revision_read_boundaries (revision_id, user_id, change_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [revisionId, userId, changeId, workspaceId, now],
  );
  if (read) {
    db.run(
      "INSERT INTO review_revision_change_reads (workspace_id, revision_id, user_id, change_id, read_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, change_id) DO UPDATE SET read_at = excluded.read_at",
      [workspaceId, revisionId, userId, changeId, now],
    );
    carryReadForward(workspaceId, revisionId, userId, changeId, now);
    return;
  }
  db.run(
    "DELETE FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND change_id = ?",
    [workspaceId, revisionId, userId, changeId],
  );
}

export const setRevisionChangeRead = db.transaction((
  workspaceId: string,
  revisionId: string,
  userId: string,
  changeId: string,
  read: boolean,
): void => setRevisionChangeReadInTransaction(workspaceId, revisionId, userId, changeId, read));

// ---- writes ----

/** One sentence for every path that refuses superseded work, so a witness reading a 409
 *  from claim, publish, fail or retry is told the same thing each time. */
export const SUPERSEDED_MESSAGE =
  "A later source revision was published while this witness request was open, so it has been superseded.";

export class RevisionWriteError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
    readonly rule?: string,
  ) {
    super(message);
    this.name = "RevisionWriteError";
  }
}

export interface PublishRevisionInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  slug: string;
  title: string;
  projects: string[];
  capture: {
    id: string;
    repo: string;
    repoId: number;
    branch: string;
    baseRef: string;
    sourceHeadSha: string;
    baseTipSha: string;
    mergeBaseSha: string;
  };
  builder: RevisionBuilder | null;
  /** Whether a legacy review already owns this slug. Read outside so the transaction
   *  does not have to import the legacy module and make a cycle of it. */
  legacyOwnsSlug: (slug: string) => boolean;
}

export interface PublishedRevision {
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  request: WitnessRequestRow;
  created: boolean;
}

/**
 * The first source revision of a lineage: the lineage row, the immutable evidence
 * document, the pending witness request, and the Project joins, in one transaction.
 *
 * Replay is answered from inside the transaction rather than in front of it. SQLite has
 * one writer, so re-reading the capture's revision here is what makes two identical
 * requests land one row: the second sees the first's, compares the normalized digest,
 * and hands it back. A request naming the same capture with different fields is a
 * conflict, because the alternative is one of two callers silently losing its title.
 */
export const publishFirstRevision = db.transaction((input: PublishRevisionInput): PublishedRevision => {
  const { workspaceId, slug } = input;
  const now = Date.now();
  const identity = {
    captureId: input.capture.id,
    slug,
    title: input.title,
    projects: input.projects,
    builder: input.builder,
  };
  const replayDigest = digestOf(identity);

  const existing = getRevisionByCapture(workspaceId, input.capture.id);
  if (existing) {
    const lineage = db.query<ReviewLineageRow, [string]>("SELECT * FROM review_lineages WHERE id = ?").get(existing.lineage_id);
    if (!lineage) throw new Error(`Review revision ${existing.id} has no lineage`);
    const priorDigest = digestOf({
      captureId: existing.doc.source.captureId,
      slug: existing.doc.identity.slug,
      title: existing.doc.identity.title,
      projects: existing.doc.projects,
      builder: existing.doc.builder,
    });
    if (priorDigest !== replayDigest) {
      throw new RevisionWriteError(409, `Capture ${input.capture.id} already published a different source revision`);
    }
    const request = getWitnessRequestForRevision(workspaceId, existing.id);
    if (!request) throw new Error(`Review revision ${existing.id} has no witness request`);
    return { lineage, revision: existing, request, created: false };
  }

  if (lineageOwnsSlug(workspaceId, slug)) {
    throw new RevisionWriteError(409, `Review slug "${slug}" already names another promoted review`, "review_slug_taken");
  }
  if (stackOwnsSlug(workspaceId, slug)) {
    throw new RevisionWriteError(409, `Review slug "${slug}" already names a review stack`, "review_slug_taken");
  }
  if (input.legacyOwnsSlug(slug)) {
    throw new RevisionWriteError(409, `Review slug "${slug}" already names a review in this workspace`, "review_slug_taken");
  }
  for (const project of input.projects) {
    if (!getProject(workspaceId, project)) throw new RevisionWriteError(422, `No project "${project}" in this workspace`);
  }

  const lineageId = tinyId("rln");
  db.run(
    "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)",
    [lineageId, workspaceId, slug, input.capture.repo, input.capture.repoId, input.capture.branch,
      input.capture.baseRef, input.capture.mergeBaseSha, input.title, input.userId, input.keyId, now, now],
  );
  const doc: RevisionDoc = {
    identity: { lineageId, slug, revision: 1, title: input.title, createdAt: new Date(now).toISOString() },
    source: {
      captureId: input.capture.id,
      repo: input.capture.repo,
      repoId: input.capture.repoId,
      branch: input.capture.branch,
      originalBaseRef: input.capture.baseRef,
      originalBaseSha: input.capture.mergeBaseSha,
      baseRef: input.capture.baseRef,
      sourceHeadSha: input.capture.sourceHeadSha,
      baseTipSha: input.capture.baseTipSha,
      mergeBaseSha: input.capture.mergeBaseSha,
    },
    builder: input.builder,
    projects: input.projects,
  };
  const revisionId = tinyId("rvr");
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
    [revisionId, workspaceId, lineageId, slug, input.capture.id, JSON.stringify(doc), digestOf(doc), now],
  );
  const requestId = tinyId("wtr");
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 1, 'pending', 0, NULL, NULL, ?, ?)",
    [requestId, workspaceId, lineageId, revisionId, now, now],
  );
  for (const project of input.projects) {
    const row = getProject(workspaceId, project)!;
    db.run(
      "INSERT OR IGNORE INTO project_review_lineages (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)",
      [row.id, workspaceId, slug, now],
    );
  }
  const lineage = getLineage(workspaceId, slug)!;
  const revision = getRevision(workspaceId, slug, 1);
  const request = getWitnessRequestForRevision(workspaceId, revisionId);
  if (!revision || !request) throw new Error("Review revision publication did not write every row");
  return { lineage, revision, request, created: true };
}) as (input: PublishRevisionInput) => PublishedRevision;

export interface AppendSourceRevisionInput {
  workspaceId: string;
  lineage: ReviewLineageRow;
  capture: {
    id: string;
    repo: string;
    repoId: number;
    branch: string;
    baseRef: string;
    sourceHeadSha: string;
    baseTipSha: string;
    mergeBaseSha: string;
  };
  builder: RevisionBuilder | null;
}

export interface AppendedRevision {
  revision: ReviewRevisionRow;
  request: WitnessRequestRow;
}

/**
 * Append the next source revision of an existing lineage, with its pending witness
 * request and the lineage's own pointer.
 *
 * NOT a transaction of its own, and that is the point: the caller is the pull request
 * capture completion, which has to commit this together with the source association and
 * the job's completed state, or a reader could see a revision whose provenance had not
 * landed yet. It writes the exact task-4 V1 document — same fields, same schema version,
 * same digest rule — because a pull request revision is evidence in precisely the way a
 * branch revision is, and a second document format would soft-404 every old reader during
 * a mixed-image deploy for no gain.
 *
 * `originalBaseRef` and `originalBaseSha` come from the LINEAGE rather than from this
 * capture: they are the lineage's first base, which is what lets a later revision say
 * what moved.
 */
export function appendSourceRevision(input: AppendSourceRevisionInput): AppendedRevision {
  const { workspaceId, lineage, capture } = input;
  const now = Date.now();
  const number = (lineage.latest_revision ?? 0) + 1;
  const doc: RevisionDoc = {
    identity: { lineageId: lineage.id, slug: lineage.slug, revision: number, title: lineage.title, createdAt: new Date(now).toISOString() },
    source: {
      captureId: capture.id,
      repo: capture.repo,
      repoId: capture.repoId,
      branch: capture.branch,
      originalBaseRef: lineage.original_base_ref,
      originalBaseSha: lineage.original_base_sha,
      baseRef: capture.baseRef,
      sourceHeadSha: capture.sourceHeadSha,
      baseTipSha: capture.baseTipSha,
      mergeBaseSha: capture.mergeBaseSha,
    },
    builder: input.builder,
    projects: db.query<{ slug: string }, [string, string]>(
      "SELECT p.slug AS slug FROM project_review_lineages j JOIN projects p ON p.id = j.project_id WHERE j.workspace_id = ? AND j.slug = ? ORDER BY j.created_at ASC",
    ).all(workspaceId, lineage.slug).map((row) => row.slug),
  };
  const revisionId = tinyId("rvr");
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    [revisionId, workspaceId, lineage.id, lineage.slug, number, capture.id, JSON.stringify(doc), digestOf(doc), now],
  );
  const requestId = tinyId("wtr");
  db.run(
    "INSERT INTO review_witness_requests (id, workspace_id, lineage_id, revision_id, revision, state, retry_count, failure, account_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)",
    [requestId, workspaceId, lineage.id, revisionId, number, now, now],
  );
  db.run("UPDATE review_lineages SET latest_revision = ?, updated_at = ? WHERE id = ?", [number, now, lineage.id]);
  const revision = getRevision(workspaceId, lineage.slug, number);
  const request = getWitnessRequestForRevision(workspaceId, revisionId);
  if (!revision || !request) throw new Error("Source revision publication did not write every row");
  return { revision, request };
}

export interface PublishAccountInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  witness: { summary: string; agent: { name: string; model: string } };
  groups: StageGroup[];
  focus: FocusItem[];
  evidence: EvidenceRef[];
}

export interface PublishedAccount {
  account: ReviewAccountRow;
  request: WitnessRequestRow;
  created: boolean;
}

/**
 * One account over one revision: the immutable account row, the lineage's account
 * pointer, and the witness request moving to `published`, in one transaction.
 *
 * Exact replay returns the existing account; anything else conflicts. The comparison is
 * a digest of the authored fields, not of the row, so a second identical call from a
 * retrying witness is idempotent while a second, different one cannot overwrite the
 * first witness's account.
 */
export const publishAccount = db.transaction((input: PublishAccountInput): PublishedAccount => {
  const { workspaceId, revision } = input;
  const lineage = getLineage(workspaceId, input.lineage.slug);
  if (!lineage || lineage.id !== input.lineage.id) throw new RevisionWriteError(404, "No such review in this workspace");
  const request = getWitnessRequestForRevision(workspaceId, revision.id);
  if (!request) throw new Error(`Review revision ${revision.id} has no witness request`);
  const now = Date.now();
  const authored = digestOf({
    revisionId: revision.id,
    witness: input.witness,
    groups: input.groups,
    focus: input.focus,
    evidence: input.evidence,
  });

  const existing = latestAccountForRevision(workspaceId, revision.id);
  if (existing) {
    const priorAuthored = digestOf({
      revisionId: revision.id,
      witness: { summary: existing.doc.witness.summary, agent: existing.doc.witness.agent },
      groups: existing.doc.groups,
      focus: existing.doc.focus,
      evidence: existing.doc.evidence,
    });
    if (priorAuthored !== authored) {
      throw new RevisionWriteError(409, `Revision ${revision.revision} of "${lineage.slug}" already carries a different account`);
    }
    return { account: existing, request, created: false };
  }
  if (request.state !== "pending") {
    throw new RevisionWriteError(409, request.state === "failed"
      ? "Retry the failed witness request before publishing an account"
      : "This witness request already published an account");
  }
  if (isWitnessRequestSuperseded(request.id)) {
    throw new RevisionWriteError(409, SUPERSEDED_MESSAGE);
  }
  // Atomically claim and consume the attempt. A key that already holds the claim simply
  // renews it, so task 4's single-agent path is unchanged; a key that does not, while
  // somebody else's lease is still healthy, is refused rather than allowed to publish an
  // account over work another agent is in the middle of.
  takeClaim(workspaceId, request, input.userId, input.keyId, now);

  const version = (lineage.latest_account_version ?? 0) + 1;
  const accountId = tinyId("rac");
  const doc: AccountDoc = {
    identity: {
      lineageId: lineage.id,
      slug: lineage.slug,
      revision: revision.revision,
      version,
      createdAt: new Date(now).toISOString(),
    },
    witness: { summary: input.witness.summary, agent: input.witness.agent, userId: input.userId, keyId: input.keyId },
    groups: input.groups,
    focus: input.focus,
    evidence: input.evidence,
  };
  db.run(
    "INSERT INTO review_accounts (id, workspace_id, lineage_id, revision_id, revision, slug, version, schema_version, doc, digest, witness_user_id, witness_key_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
    [accountId, workspaceId, lineage.id, revision.id, revision.revision, lineage.slug, version,
      JSON.stringify(doc), digestOf(doc), input.userId, input.keyId, now],
  );
  db.run(
    "UPDATE review_lineages SET latest_account_version = ?, updated_at = ? WHERE id = ?",
    [version, now, lineage.id],
  );
  db.run(
    "UPDATE review_witness_requests SET state = 'published', failure = NULL, account_id = ?, updated_at = ? WHERE workspace_id = ? AND revision_id = ?",
    [accountId, now, workspaceId, revision.id],
  );
  const account = getAccount(workspaceId, lineage.slug, version);
  const publishedRequest = getWitnessRequestForRevision(workspaceId, revision.id);
  if (!account || !publishedRequest) throw new Error("Account publication did not write every row");
  // Inside this transaction, not after it: a stack whose last member just gained its account
  // publishes its account-ready manifest with the account that made it ready, or with none
  // of it. Serialized by SQLite's writer lock, so two final members cannot both be last.
  onMemberAccountPublished(workspaceId, lineage.id, revision.id);
  return { account, request: publishedRequest, created: true };
}) as (input: PublishAccountInput) => PublishedAccount;

// ---- witness claims ----
//
// A witness request is work, and work needs one owner at a time. The claim is keyed by
// `(request, retry count)` rather than by the request alone, because the retry count is
// exactly what makes a second attempt a DIFFERENT piece of work: the agent that failed
// attempt zero has no standing over attempt one, and an agent picking up attempt one must
// not have to wait for a lease held by a process that has already given up.
//
// The lease is renewable and recoverable in the same breath. A same-key claim renews it,
// so a working agent stays the owner; an expired lease may be taken over by anyone,
// because a claim nobody is renewing is a claim nobody is working.

export interface WitnessClaimRow {
  request_id: string;
  retry_count: number;
  workspace_id: string;
  user_id: string;
  key_id: string;
  lease_token: string;
  lease_expires_at: number;
  claimed_at: number;
}

/** Long enough that an agent reading a large capture keeps its claim without thinking
 *  about it; short enough that a process killed mid-answer frees the work the same
 *  afternoon rather than the next deploy. */
export const WITNESS_LEASE_MS = 10 * 60 * 1000;

export function getWitnessClaim(requestId: string, retryCount: number): WitnessClaimRow | null {
  return db.query<WitnessClaimRow, [string, number]>(
    "SELECT * FROM review_witness_claims WHERE request_id = ? AND retry_count = ?",
  ).get(requestId, retryCount);
}

function writeClaim(
  workspaceId: string,
  request: WitnessRequestRow,
  userId: string,
  keyId: string,
  now: number,
): WitnessClaimRow {
  const token = tinyId("wcl");
  db.run(
    "INSERT INTO review_witness_claims (request_id, retry_count, workspace_id, user_id, key_id, lease_token, lease_expires_at, claimed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(request_id, retry_count) DO UPDATE SET workspace_id = excluded.workspace_id, user_id = excluded.user_id, " +
      "key_id = excluded.key_id, lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at, claimed_at = excluded.claimed_at",
    [request.id, request.retry_count, workspaceId, userId, keyId, token, now + WITNESS_LEASE_MS, now],
  );
  return getWitnessClaim(request.id, request.retry_count)!;
}

/**
 * The claim arbiter, shared by the claim route and by publication and failure.
 *
 * `null` means "no healthy claim stands in your way, and the attempt is now yours". A
 * healthy claim held by a different key throws, which is what stops two agents writing
 * two accounts over one revision and calling one of them a replay.
 */
function takeClaim(
  workspaceId: string,
  request: WitnessRequestRow,
  userId: string,
  keyId: string,
  now: number,
): WitnessClaimRow {
  const held = getWitnessClaim(request.id, request.retry_count);
  if (held && held.key_id !== keyId && held.lease_expires_at > now) {
    throw new RevisionWriteError(409, "Another agent holds this witness request; its claim has not expired.");
  }
  return writeClaim(workspaceId, request, userId, keyId, now);
}

export interface WitnessClaimResult {
  request: WitnessRequestRow;
  claim: WitnessClaimRow;
  /** False when this key already held the claim and the lease was renewed rather than
   *  taken. What tells a replaying agent it is still the same attempt. */
  created: boolean;
}

/**
 * Claim one attempt of a witness request, renew a claim this key already holds, or
 * recover one whose lease has expired.
 *
 * A published request has nothing left to claim, and a failed one has to be retried
 * first — that is the transition that increments the count and makes the next attempt a
 * different piece of work.
 */
export const claimWitnessRequest = db.transaction((input: {
  workspaceId: string;
  requestId: string;
  userId: string;
  keyId: string;
  now?: number;
}): WitnessClaimResult => {
  const now = input.now ?? Date.now();
  const request = getWitnessRequest(input.workspaceId, input.requestId);
  if (!request) throw new RevisionWriteError(404, "No such witness request in this workspace");
  if (request.state === "published") {
    throw new RevisionWriteError(409, "This witness request already published an account");
  }
  if (request.state === "failed") {
    throw new RevisionWriteError(409, "Retry the failed witness request before claiming it");
  }
  if (isWitnessRequestSuperseded(request.id)) {
    throw new RevisionWriteError(409, SUPERSEDED_MESSAGE);
  }
  const held = getWitnessClaim(request.id, request.retry_count);
  const created = !held || held.key_id !== input.keyId;
  const claim = takeClaim(input.workspaceId, request, input.userId, input.keyId, now);
  return { request, claim, created };
}) as (input: {
  workspaceId: string;
  requestId: string;
  userId: string;
  keyId: string;
  now?: number;
}) => WitnessClaimResult;

export const MAX_FAILURE_TEXT = 600;

/**
 * Pending to failed, recording bounded text. A request that already published is a
 * conflict: the account exists and nothing about it failed.
 *
 * `claimant` is optional so the direct in-process call task 4 ships keeps working
 * unchanged — an internal writer with nobody to be is not competing for the attempt. The
 * ROUTE always passes one, which is what makes a foreign key's failure a 409 against an
 * agent whose lease is still healthy.
 */
export const failWitnessRequest = db.transaction((
  workspaceId: string,
  request: WitnessRequestRow,
  failure: string,
  claimant?: { userId: string; keyId: string },
): WitnessRequestRow => {
  const current = getWitnessRequest(workspaceId, request.id);
  if (!current) throw new RevisionWriteError(404, "No such witness request in this workspace");
  if (current.state === "published") {
    throw new RevisionWriteError(409, "This witness request already published an account");
  }
  if (isWitnessRequestSuperseded(current.id)) {
    throw new RevisionWriteError(409, SUPERSEDED_MESSAGE);
  }
  const now = Date.now();
  if (claimant) takeClaim(workspaceId, current, claimant.userId, claimant.keyId, now);
  db.run(
    "UPDATE review_witness_requests SET state = 'failed', failure = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [failure.slice(0, MAX_FAILURE_TEXT), now, workspaceId, current.id],
  );
  return getWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: WitnessRequestRow, failure: string, claimant?: { userId: string; keyId: string }) => WitnessRequestRow;

/** Failed back to pending, one retry counted. Pending is idempotent — a second retry
 *  of a request nobody has failed would inflate the count and make the reader say
 *  "retrying" about a first attempt that is still running. */
export const retryWitnessRequest = db.transaction((
  workspaceId: string,
  request: WitnessRequestRow,
): WitnessRequestRow => {
  const current = getWitnessRequest(workspaceId, request.id);
  if (!current) throw new RevisionWriteError(404, "No such witness request in this workspace");
  if (current.state === "published") {
    throw new RevisionWriteError(409, "This witness request already published an account");
  }
  if (isWitnessRequestSuperseded(current.id)) {
    throw new RevisionWriteError(409, SUPERSEDED_MESSAGE);
  }
  if (current.state === "failed") {
    db.run(
      "UPDATE review_witness_requests SET state = 'pending', failure = NULL, retry_count = retry_count + 1, updated_at = ? WHERE workspace_id = ? AND id = ?",
      [Date.now(), workspaceId, current.id],
    );
  }
  return getWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: WitnessRequestRow) => WitnessRequestRow;
