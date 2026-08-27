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
import { lineageOwnsSlug } from "./db";
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

/** The newest account published over one revision, or null while none has been. */
export function latestAccountForRevision(workspaceId: string, revisionId: string): ReviewAccountRow | null {
  const row = db.query<Raw<ReviewAccountRow>, [string, string]>(
    "SELECT * FROM review_accounts WHERE workspace_id = ? AND revision_id = ? ORDER BY version DESC LIMIT 1",
  ).get(workspaceId, revisionId);
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

/** The word a reader is shown. `retrying` is pending after at least one failure, which
 *  is a different thing to say than "we have not heard yet". */
export function workflowWord(request: WitnessRequestRow | null): WitnessWorkflowWord | null {
  if (!request) return null;
  if (request.state !== "pending") return request.state;
  return request.retry_count > 0 ? "retrying" : "pending";
}

// ---- read state ----

export function listRevisionReadChangeIds(workspaceId: string, revisionId: string, userId: string): Set<string> {
  return new Set(db.query<{ change_id: string }, [string, string, string]>(
    "SELECT change_id FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ? AND user_id = ?",
  ).all(workspaceId, revisionId, userId).map((row) => row.change_id));
}

/** The route verifies that the revision's capture owns the change before this write. */
export const setRevisionChangeRead = db.transaction((
  workspaceId: string,
  revisionId: string,
  userId: string,
  changeId: string,
  read: boolean,
): void => {
  if (read) {
    db.run(
      "INSERT INTO review_revision_change_reads (workspace_id, revision_id, user_id, change_id, read_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(workspace_id, revision_id, user_id, change_id) DO UPDATE SET read_at = excluded.read_at",
      [workspaceId, revisionId, userId, changeId, Date.now()],
    );
    return;
  }
  db.run(
    "DELETE FROM review_revision_change_reads WHERE workspace_id = ? AND revision_id = ? AND user_id = ? AND change_id = ?",
    [workspaceId, revisionId, userId, changeId],
  );
});

// ---- writes ----

export class RevisionWriteError extends Error {
  constructor(readonly status: 404 | 409 | 422, message: string) {
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
    throw new RevisionWriteError(409, `Review slug "${slug}" already names another promoted review`);
  }
  if (input.legacyOwnsSlug(slug)) {
    throw new RevisionWriteError(409, `Review slug "${slug}" already names a review in this workspace`);
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
  return { account, request: publishedRequest, created: true };
}) as (input: PublishAccountInput) => PublishedAccount;

export const MAX_FAILURE_TEXT = 600;

/** Pending to failed, recording bounded text. A request that already published is a
 *  conflict: the account exists and nothing about it failed. */
export const failWitnessRequest = db.transaction((
  workspaceId: string,
  request: WitnessRequestRow,
  failure: string,
): WitnessRequestRow => {
  const current = getWitnessRequest(workspaceId, request.id);
  if (!current) throw new RevisionWriteError(404, "No such witness request in this workspace");
  if (current.state === "published") {
    throw new RevisionWriteError(409, "This witness request already published an account");
  }
  db.run(
    "UPDATE review_witness_requests SET state = 'failed', failure = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [failure.slice(0, MAX_FAILURE_TEXT), Date.now(), workspaceId, current.id],
  );
  return getWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: WitnessRequestRow, failure: string) => WitnessRequestRow;

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
  if (current.state === "failed") {
    db.run(
      "UPDATE review_witness_requests SET state = 'pending', failure = NULL, retry_count = retry_count + 1, updated_at = ? WHERE workspace_id = ? AND id = ?",
      [Date.now(), workspaceId, current.id],
    );
  }
  return getWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: WitnessRequestRow) => WitnessRequestRow;
