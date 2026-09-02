// Stack persistence: the stack, its immutable manifests, the one account per manifest, the
// witness workflow beside it, live membership, and Project joins. Every query carries
// workspace scope; every write that has to be all-or-nothing is one transaction.
//
// Two rules run through everything below. A manifest is never edited: movement is a
// successor, and `UNIQUE (stack_id, predecessor_version)` is what makes "one successor per
// predecessor" hold whichever writer commits first. And a stack owns none of what a member
// owns: no read table, no copied revision, no copied account — only references, pinned
// exactly.

import { db } from "../db";
import { RLN_ID_RE, RSK_ID_RE, RSM_ID_RE, SLUG_RE, hashKey, tinyId } from "../ids";
import { getProject } from "../projects/db";
import { lineageOwnsSlug, stackOwnsSlug } from "./db";
export { stackOwnsSlug } from "./db";
import {
  digestOf,
  latestAccountForRevision,
  WITNESS_LEASE_MS,
  type ReviewAccountRow,
  type WitnessClaimRow,
} from "./revision-db";
import type { WitnessRequestState, WitnessWorkflowWord } from "./revision-types";
import {
  MAX_STACK_GROUPS,
  MAX_STACK_MEMBERS,
  MAX_STACK_MEMBER_POSITIONS,
  STACK_SCHEMA_VERSION,
  type StackAccountDoc,
  type StackGroup,
  type StackManifestDoc,
  type StackManifestReason,
  type StackMemberSnapshot,
  type StackSource,
} from "./stack-types";

// ---- rows ----

export interface ReviewStackRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  repo: string;
  repo_id: number;
  base_ref: string;
  source: StackSource;
  provider_stack_id: number | null;
  provider_stack_number: number | null;
  actor_kind: "installation" | "user" | "anonymous";
  installation_id: number | null;
  user_id: string | null;
  credential_id: string | null;
  latest_manifest_version: number;
  created_by_user_id: string;
  created_by_key_id: string;
  created_at: number;
  updated_at: number;
}

export interface StackMemberRow {
  stack_id: string;
  lineage_id: string;
  workspace_id: string;
  lineage_slug: string;
  repo_id: number;
  pr_number: number;
  added_manifest_id: string;
  removed_at: number | null;
  removed_reason: "unstacked" | "merged" | "closed" | "detached" | null;
  removed_manifest_id: string | null;
}

export interface StackManifestRow {
  id: string;
  stack_id: string;
  workspace_id: string;
  slug: string;
  version: number;
  predecessor_version: number;
  reason: StackManifestReason;
  schema_version: number;
  doc: StackManifestDoc;
  digest: string;
  created_at: number;
}

export interface StackAccountRow {
  id: string;
  stack_id: string;
  manifest_id: string;
  workspace_id: string;
  slug: string;
  version: number;
  schema_version: number;
  doc: StackAccountDoc;
  digest: string;
  witness_user_id: string;
  witness_key_id: string;
  created_at: number;
}

export interface StackWitnessRequestRow {
  id: string;
  workspace_id: string;
  stack_id: string;
  manifest_id: string;
  version: number;
  state: WitnessRequestState;
  retry_count: number;
  failure: string | null;
  account_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface StackIdempotencyRow {
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  operation: "create" | "refresh";
  stack_id: string;
  manifest_id: string;
  created_at: number;
}

type Raw<T> = Omit<T, "doc"> & { doc: string };

// ---- stored-document shape checks ----

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function isSnapshot(value: unknown): value is StackMemberSnapshot {
  if (!record(value) || !exactKeys(value, ["lineageId", "lineageSlug", "prNumber", "title", "revisionId", "revision", "accountId", "accountVersion", "baseRef", "headRef", "headSha", "status", "removedReason"])) return false;
  return RLN_ID_RE.test(String(value.lineageId)) && SLUG_RE.test(String(value.lineageSlug)) &&
    Number.isInteger(value.prNumber) && (value.prNumber as number) >= 1 &&
    typeof value.title === "string" && typeof value.revisionId === "string" &&
    Number.isInteger(value.revision) && (value.revision as number) >= 1 &&
    (value.accountId === null || typeof value.accountId === "string") &&
    (value.accountVersion === null || (Number.isInteger(value.accountVersion) && (value.accountVersion as number) >= 1)) &&
    (value.accountId === null) === (value.accountVersion === null) &&
    typeof value.baseRef === "string" && typeof value.headRef === "string" && typeof value.headSha === "string" &&
    ["live", "merged", "removed"].includes(value.status as string) &&
    (value.removedReason === null || ["unstacked", "merged", "closed", "detached"].includes(value.removedReason as string)) &&
    ((value.status === "removed") === (value.removedReason !== null));
}

function isManifestDoc(value: unknown): value is StackManifestDoc {
  if (!record(value) || !exactKeys(value, ["identity", "repository", "source", "members", "projects"])) return false;
  const { identity, repository, source } = value;
  if (!record(identity) || !exactKeys(identity, ["stackId", "slug", "title", "version", "predecessorVersion", "reason", "createdAt"]) ||
      !RSK_ID_RE.test(String(identity.stackId)) || !SLUG_RE.test(String(identity.slug)) ||
      typeof identity.title !== "string" || !Number.isInteger(identity.version) || (identity.version as number) < 1 ||
      !Number.isInteger(identity.predecessorVersion) || (identity.predecessorVersion as number) < 0 ||
      !["created", "refresh", "account-ready"].includes(identity.reason as string) ||
      typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) return false;
  if (!record(repository) || !exactKeys(repository, ["repo", "repoId", "baseRef"]) ||
      typeof repository.repo !== "string" || !Number.isInteger(repository.repoId) || typeof repository.baseRef !== "string") return false;
  if (!record(source) || !exactKeys(source, ["kind", "providerStackId", "providerStackNumber", "observedAt"]) ||
      !["native", "inferred"].includes(source.kind as string) ||
      (source.providerStackId !== null && !Number.isInteger(source.providerStackId)) ||
      (source.providerStackNumber !== null && !Number.isInteger(source.providerStackNumber)) ||
      (source.observedAt !== null && typeof source.observedAt !== "string")) return false;
  return Array.isArray(value.members) && value.members.length >= 1 && value.members.length <= MAX_STACK_MEMBER_POSITIONS && value.members.every(isSnapshot) &&
    value.members.filter((member) => (member as StackMemberSnapshot).status !== "removed").length <= MAX_STACK_MEMBERS &&
    Array.isArray(value.projects) && value.projects.length <= 16 && value.projects.every((project) => typeof project === "string" && SLUG_RE.test(project));
}

function isStackGroup(value: unknown): value is StackGroup {
  if (!record(value)) return false;
  const allowed = ["id", "title", "body", "attention", "examples", "members"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !["id", "title", "body", "examples", "members"].every((key) => key in value)) return false;
  if (typeof value.id !== "string" || !SLUG_RE.test(value.id) || typeof value.title !== "string" || value.title.length < 1 ||
      typeof value.body !== "string" || value.body.length < 1 || !Array.isArray(value.examples) || !Array.isArray(value.members)) return false;
  if ("attention" in value && typeof value.attention !== "string") return false;
  return value.examples.every((example) => record(example) && exactKeys(example, ["code", "text"]) && typeof example.code === "string" && typeof example.text === "string") &&
    value.members.every((member) => record(member) && exactKeys(member, ["lineageId", "revision", "accountVersion", "groupId"]) &&
      RLN_ID_RE.test(String(member.lineageId)) && Number.isInteger(member.revision) && Number.isInteger(member.accountVersion) &&
      typeof member.groupId === "string" && SLUG_RE.test(member.groupId));
}

function isAccountDoc(value: unknown): value is StackAccountDoc {
  if (!record(value) || !exactKeys(value, ["identity", "witness", "groups"])) return false;
  const { identity, witness } = value;
  if (!record(identity) || !exactKeys(identity, ["stackId", "slug", "manifestId", "version", "createdAt"]) ||
      !RSK_ID_RE.test(String(identity.stackId)) || !SLUG_RE.test(String(identity.slug)) || !RSM_ID_RE.test(String(identity.manifestId)) ||
      !Number.isInteger(identity.version) || (identity.version as number) < 1 ||
      typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) return false;
  if (!record(witness) || !exactKeys(witness, ["summary", "agent", "userId", "keyId"]) || typeof witness.summary !== "string" ||
      !record(witness.agent) || typeof witness.agent.name !== "string" || typeof witness.agent.model !== "string" ||
      typeof witness.userId !== "string" || typeof witness.keyId !== "string") return false;
  return Array.isArray(value.groups) && value.groups.length >= 1 && value.groups.length <= MAX_STACK_GROUPS && value.groups.every(isStackGroup);
}

function parseManifest(row: Raw<StackManifestRow>): StackManifestRow | null {
  if (row.schema_version !== STACK_SCHEMA_VERSION) {
    console.error(`[seer] stack manifest ${row.id}: unsupported schema version ${row.schema_version}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc) as unknown;
  } catch {
    console.error(`[seer] stack manifest ${row.id}: stored document is not valid JSON`);
    return null;
  }
  if (!isManifestDoc(doc)) {
    console.error(`[seer] stack manifest ${row.id}: stored document has an invalid manifest shape`);
    return null;
  }
  if (doc.identity.stackId !== row.stack_id || doc.identity.slug !== row.slug || doc.identity.version !== row.version ||
      doc.identity.predecessorVersion !== row.predecessor_version || doc.identity.reason !== row.reason) {
    console.error(`[seer] stack manifest ${row.id}: stored document identity does not match its row`);
    return null;
  }
  return { ...row, doc };
}

function parseAccount(row: Raw<StackAccountRow>): StackAccountRow | null {
  if (row.schema_version !== STACK_SCHEMA_VERSION) {
    console.error(`[seer] stack account ${row.id}: unsupported schema version ${row.schema_version}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc) as unknown;
  } catch {
    console.error(`[seer] stack account ${row.id}: stored document is not valid JSON`);
    return null;
  }
  if (!isAccountDoc(doc)) {
    console.error(`[seer] stack account ${row.id}: stored document has an invalid account shape`);
    return null;
  }
  if (doc.identity.stackId !== row.stack_id || doc.identity.slug !== row.slug || doc.identity.manifestId !== row.manifest_id || doc.identity.version !== row.version) {
    console.error(`[seer] stack account ${row.id}: stored document identity does not match its row`);
    return null;
  }
  return { ...row, doc };
}

// ---- reads ----

export function getStack(workspaceId: string, slug: string): ReviewStackRow | null {
  return db.query<ReviewStackRow, [string, string]>(
    "SELECT * FROM review_stacks WHERE workspace_id = ? AND slug = ?",
  ).get(workspaceId, slug);
}

export function getStackById(id: string): ReviewStackRow | null {
  return db.query<ReviewStackRow, [string]>("SELECT * FROM review_stacks WHERE id = ?").get(id);
}

export function getStackByIdInWorkspace(workspaceId: string, id: string): ReviewStackRow | null {
  return db.query<ReviewStackRow, [string, string]>(
    "SELECT * FROM review_stacks WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

export function getStackManifest(workspaceId: string, slug: string, version: number): StackManifestRow | null {
  const row = db.query<Raw<StackManifestRow>, [string, string, number]>(
    "SELECT * FROM review_stack_manifests WHERE workspace_id = ? AND slug = ? AND version = ?",
  ).get(workspaceId, slug, version);
  return row ? parseManifest(row) : null;
}

export function getStackManifestById(workspaceId: string, id: string): StackManifestRow | null {
  const row = db.query<Raw<StackManifestRow>, [string, string]>(
    "SELECT * FROM review_stack_manifests WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
  return row ? parseManifest(row) : null;
}

/** The manifest the stack row points at. Re-read rather than remembered, because the
 *  writers below race on exactly this. */
export function currentStackManifest(stack: ReviewStackRow): StackManifestRow | null {
  const current = getStackById(stack.id) ?? stack;
  return getStackManifest(current.workspace_id, current.slug, current.latest_manifest_version);
}

export function getStackAccount(workspaceId: string, slug: string, version: number): StackAccountRow | null {
  const row = db.query<Raw<StackAccountRow>, [string, string, number]>(
    "SELECT * FROM review_stack_accounts WHERE workspace_id = ? AND slug = ? AND version = ?",
  ).get(workspaceId, slug, version);
  return row ? parseAccount(row) : null;
}

export function getStackAccountById(workspaceId: string, accountId: string): StackAccountRow | null {
  const row = db.query<Raw<StackAccountRow>, [string, string]>(
    "SELECT * FROM review_stack_accounts WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, accountId);
  return row ? parseAccount(row) : null;
}

export function getStackAccountForManifest(workspaceId: string, manifestId: string): StackAccountRow | null {
  const row = db.query<Raw<StackAccountRow>, [string, string]>(
    "SELECT * FROM review_stack_accounts WHERE workspace_id = ? AND manifest_id = ?",
  ).get(workspaceId, manifestId);
  return row ? parseAccount(row) : null;
}

export function listStackManifestTimes(workspaceId: string, slug: string): { id: string; version: number; reason: StackManifestReason; created_at: number }[] {
  return db.query<{ id: string; version: number; reason: StackManifestReason; created_at: number }, [string, string]>(
    "SELECT id, version, reason, created_at FROM review_stack_manifests WHERE workspace_id = ? AND slug = ? ORDER BY version ASC",
  ).all(workspaceId, slug);
}

export function listStackAccountTimes(workspaceId: string, slug: string): { version: number; created_at: number }[] {
  return db.query<{ version: number; created_at: number }, [string, string]>(
    "SELECT version, created_at FROM review_stack_accounts WHERE workspace_id = ? AND slug = ? ORDER BY version ASC",
  ).all(workspaceId, slug);
}

export function listStackMembers(stackId: string): StackMemberRow[] {
  return db.query<StackMemberRow, [string]>(
    "SELECT * FROM review_stack_members WHERE stack_id = ? ORDER BY lineage_slug ASC",
  ).all(stackId);
}

export function listLiveStackMembers(stackId: string): StackMemberRow[] {
  return db.query<StackMemberRow, [string]>(
    "SELECT * FROM review_stack_members WHERE stack_id = ? AND removed_at IS NULL ORDER BY lineage_slug ASC",
  ).all(stackId);
}

/** The stacks a lineage is a live member of. A lineage may be in at most one live stack,
 *  held by the partial unique index; the list shape is what every join wants. */
export function liveStacksForLineage(lineageId: string): ReviewStackRow[] {
  return db.query<ReviewStackRow, [string]>(
    "SELECT s.* FROM review_stack_members m JOIN review_stacks s ON s.id = m.stack_id WHERE m.lineage_id = ? AND m.removed_at IS NULL",
  ).all(lineageId);
}

/** Live stack memberships of one pull request, by numeric repository id. What a delivery
 *  and the reconciliation sweep join. */
export function matchStackMembers(repoId: number, prNumber: number): StackMemberRow[] {
  return db.query<StackMemberRow, [number, number]>(
    "SELECT * FROM review_stack_members WHERE repo_id = ? AND pr_number = ? AND removed_at IS NULL",
  ).all(repoId, prNumber);
}

export function listProjectSlugsForStack(workspaceId: string, slug: string): string[] {
  return db.query<{ slug: string }, [string, string]>(
    "SELECT p.slug AS slug FROM project_review_stacks j JOIN projects p ON p.id = j.project_id WHERE j.workspace_id = ? AND j.slug = ? ORDER BY j.created_at ASC",
  ).all(workspaceId, slug).map((row) => row.slug);
}

export function getStackWitnessRequest(workspaceId: string, id: string): StackWitnessRequestRow | null {
  return db.query<StackWitnessRequestRow, [string, string]>(
    "SELECT * FROM review_stack_witness_requests WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

export function getStackWitnessRequestForManifest(workspaceId: string, manifestId: string): StackWitnessRequestRow | null {
  return db.query<StackWitnessRequestRow, [string, string]>(
    "SELECT * FROM review_stack_witness_requests WHERE workspace_id = ? AND manifest_id = ?",
  ).get(workspaceId, manifestId);
}

export function isStackWitnessRequestSuperseded(requestId: string): boolean {
  return db.query<{ found: number }, [string]>(
    "SELECT 1 AS found FROM review_stack_witness_supersessions WHERE request_id = ?",
  ).get(requestId) !== null;
}

/** The same four words a member request has, derived the same way. `superseded` is a
 *  later manifest having been published while this request was still open. */
export function stackWorkflowWord(request: StackWitnessRequestRow | null): WitnessWorkflowWord | null {
  if (!request) return null;
  if (request.state === "published") return "published";
  if (isStackWitnessRequestSuperseded(request.id)) return "superseded";
  if (request.state === "failed") return "failed";
  return request.retry_count > 0 ? "retrying" : "pending";
}

export function getStackIdempotency(workspaceId: string, key: string): StackIdempotencyRow | null {
  return db.query<StackIdempotencyRow, [string, string]>(
    "SELECT * FROM review_stack_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, key);
}

export function stackRequestHash(operation: "create" | "refresh", slug: string | null, body: unknown): string {
  return hashKey(JSON.stringify({ operation, slug, body }));
}

// ---- errors ----

export class StackWriteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 502,
    message: string,
    readonly rule?: string,
  ) {
    super(message);
    this.name = "StackWriteError";
  }
}

/** One sentence for every path that refuses superseded work. */
export const STACK_SUPERSEDED_MESSAGE =
  "A later manifest was published while this stack witness request was open, so it has been superseded.";

// ---- what normalization hands the writers ----

export interface NormalizedStack {
  repo: string;
  repoId: number;
  baseRef: string;
  source: StackSource;
  provider: { stackId: number | null; stackNumber: number | null; observedAt: string | null };
  members: StackMemberSnapshot[];
}

/** Whether two readings pin the same members. Provenance is excluded on purpose: a native
 *  and an inferred reading of one chain must agree here, and a refresh that changed nothing
 *  but the observation time publishes nothing. */
export function sameMembers(left: StackMemberSnapshot[], right: StackMemberSnapshot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Members a stack account partitions: everything the manifest still counts as in the
 *  stack. A removed stub is history and pins nothing a witness has to cover. */
export function pinnedMembers(doc: StackManifestDoc): StackMemberSnapshot[] {
  return doc.members.filter((member) => member.status !== "removed");
}

function accountReady(members: StackMemberSnapshot[]): boolean {
  return pinnedMembers({ members } as StackManifestDoc).every((member) => member.accountId !== null);
}

function manifestDoc(
  stack: Pick<ReviewStackRow, "id" | "slug" | "title" | "repo" | "repo_id">,
  normalized: NormalizedStack,
  version: number,
  predecessorVersion: number,
  reason: StackManifestReason,
  projects: string[],
  now: number,
): StackManifestDoc {
  return {
    identity: { stackId: stack.id, slug: stack.slug, title: stack.title, version, predecessorVersion, reason, createdAt: new Date(now).toISOString() },
    repository: { repo: stack.repo, repoId: stack.repo_id, baseRef: normalized.baseRef },
    source: { kind: normalized.source, providerStackId: normalized.provider.stackId, providerStackNumber: normalized.provider.stackNumber, observedAt: normalized.provider.observedAt },
    members: normalized.members,
    projects,
  };
}

function insertManifest(stack: ReviewStackRow, doc: StackManifestDoc, now: number): string {
  const id = tinyId("rsm");
  db.run(
    "INSERT INTO review_stack_manifests (id, stack_id, workspace_id, slug, version, predecessor_version, reason, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, stack.id, stack.workspace_id, stack.slug, doc.identity.version, doc.identity.predecessorVersion, doc.identity.reason, STACK_SCHEMA_VERSION, JSON.stringify(doc), digestOf(doc), now],
  );
  return id;
}

function insertRequest(stack: ReviewStackRow, manifestId: string, version: number, now: number): StackWitnessRequestRow {
  const id = tinyId("rsw");
  db.run(
    "INSERT INTO review_stack_witness_requests (id, workspace_id, stack_id, manifest_id, version, state, retry_count, failure, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)",
    [id, stack.workspace_id, stack.id, manifestId, version, now, now],
  );
  return getStackWitnessRequest(stack.workspace_id, id)!;
}

/** Live membership follows the manifest: a new member gains a row, a departed one is
 * stamped rather than deleted, and a member returning to this stack clears that stamp.
 * A plain insert lets the live-lineage constraint expose ownership races. */
function syncMembers(stack: ReviewStackRow, manifestId: string, members: StackMemberSnapshot[], now: number): void {
  for (const member of members) {
    if (member.status === "removed") {
      db.run(
        "UPDATE review_stack_members SET removed_at = ?, removed_reason = ?, removed_manifest_id = ? WHERE stack_id = ? AND lineage_id = ? AND removed_at IS NULL",
        [now, member.removedReason, manifestId, stack.id, member.lineageId],
      );
      continue;
    }
    const existing = db.query<{ found: number }, [string, string]>(
      "SELECT 1 AS found FROM review_stack_members WHERE stack_id = ? AND lineage_id = ?",
    ).get(stack.id, member.lineageId);
    if (existing) {
      db.run(
        "UPDATE review_stack_members SET workspace_id = ?, lineage_slug = ?, repo_id = ?, pr_number = ?, removed_at = NULL, removed_reason = NULL, removed_manifest_id = NULL WHERE stack_id = ? AND lineage_id = ?",
        [stack.workspace_id, member.lineageSlug, stack.repo_id, member.prNumber, stack.id, member.lineageId],
      );
      continue;
    }
    db.run(
      "INSERT INTO review_stack_members (stack_id, lineage_id, workspace_id, lineage_slug, repo_id, pr_number, added_manifest_id, removed_at, removed_reason, removed_manifest_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
      [stack.id, member.lineageId, stack.workspace_id, member.lineageSlug, stack.repo_id, member.prNumber, manifestId],
    );
  }
}

// ---- create ----

export interface CreateStackInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  idempotencyKey: string;
  requestHash: string;
  slug: string;
  title: string;
  projects: string[];
  actor: { kind: "installation"; installationId: number } | { kind: "user"; userId: string; credentialId: string } | { kind: "anonymous" };
  normalized: NormalizedStack;
  legacyOwnsSlug: (slug: string) => boolean;
}

export interface CreatedStack {
  stack: ReviewStackRow;
  manifest: StackManifestRow;
  request: StackWitnessRequestRow | null;
  created: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * The whole of a create, in one transaction: replay, slug ownership across all three
 * review models, the stack, live members, manifest v1, the witness request when every
 * member already carries an account, the Project joins, and the idempotency row.
 */
export const createStack = db.transaction((input: CreateStackInput): CreatedStack => {
  const { workspaceId, slug, normalized } = input;
  const now = Date.now();
  const replay = getStackIdempotency(workspaceId, input.idempotencyKey);
  if (replay) {
    if (replay.request_hash !== input.requestHash) {
      throw new StackWriteError(409, "This Idempotency-Key was already used for a different stack request.");
    }
    const stack = getStackById(replay.stack_id);
    const manifest = stack ? getStackManifestById(workspaceId, replay.manifest_id) : null;
    if (!stack || !manifest) throw new Error(`Idempotency row ${replay.idempotency_key} points at rows that are gone`);
    return { stack, manifest, request: getStackWitnessRequestForManifest(workspaceId, manifest.id), created: false };
  }
  if (getStack(workspaceId, slug)) throw new StackWriteError(409, `Stack slug "${slug}" already names another stack`, "review_slug_taken");
  if (lineageOwnsSlug(workspaceId, slug)) throw new StackWriteError(409, `Stack slug "${slug}" already names a promoted review`, "review_slug_taken");
  if (input.legacyOwnsSlug(slug)) throw new StackWriteError(409, `Stack slug "${slug}" already names a review in this workspace`, "review_slug_taken");
  for (const project of input.projects) {
    if (!getProject(workspaceId, project)) throw new StackWriteError(422, `No project "${project}" in this workspace`);
  }
  for (const member of normalized.members) {
    const held = liveStacksForLineage(member.lineageId)[0];
    if (held) throw new StackWriteError(422, `"${member.lineageSlug}" is already a member of stack "${held.slug}"`);
  }

  const id = tinyId("rsk");
  const actor = input.actor;
  db.run(
    "INSERT INTO review_stacks (id, workspace_id, slug, title, repo, repo_id, base_ref, source, provider_stack_id, provider_stack_number, actor_kind, installation_id, user_id, credential_id, latest_manifest_version, created_by_user_id, created_by_key_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    [id, workspaceId, slug, input.title, normalized.repo, normalized.repoId, normalized.baseRef, normalized.source,
      normalized.provider.stackId, normalized.provider.stackNumber,
      actor.kind, actor.kind === "installation" ? actor.installationId : null,
      actor.kind === "user" ? actor.userId : null, actor.kind === "user" ? actor.credentialId : null,
      input.userId, input.keyId, now, now],
  );
  const stack = getStackById(id)!;
  const doc = manifestDoc(stack, normalized, 1, 0, "created", input.projects, now);
  const manifestId = insertManifest(stack, doc, now);
  syncMembers(stack, manifestId, normalized.members, now);
  const request = accountReady(normalized.members) ? insertRequest(stack, manifestId, 1, now) : null;
  for (const project of input.projects) {
    const row = getProject(workspaceId, project)!;
    db.run("INSERT OR IGNORE INTO project_review_stacks (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)", [row.id, workspaceId, slug, now]);
  }
  db.run(
    "INSERT INTO review_stack_idempotency (workspace_id, idempotency_key, request_hash, operation, stack_id, manifest_id, created_at) VALUES (?, ?, ?, 'create', ?, ?, ?)",
    [workspaceId, input.idempotencyKey, input.requestHash, id, manifestId, now],
  );
  const manifest = getStackManifestById(workspaceId, manifestId);
  if (!manifest) throw new Error("Stack creation did not write every row");
  return { stack, manifest, request, created: true };
}) as (input: CreateStackInput) => CreatedStack;

// ---- successors ----

export interface SuccessorInput {
  stack: ReviewStackRow;
  predecessor: StackManifestRow;
  reason: "refresh" | "account-ready";
  normalized: NormalizedStack;
  now?: number;
}

export type SuccessorOutcome = { raced: false; manifest: StackManifestRow; request: StackWitnessRequestRow | null } | { raced: true };

/**
 * Publish the successor of one exact predecessor. Nestable: the account-ready hook runs it
 * inside the member account's own transaction, and the refresh routes wrap it themselves.
 *
 * `UNIQUE (stack_id, predecessor_version)` is the arbiter. A second writer that read the
 * same predecessor loses the insert and is told `raced`, and it is the caller's job to
 * re-read the current manifest and decide once more.
 */
export function publishSuccessorManifest(input: SuccessorInput): SuccessorOutcome {
  const { stack, predecessor, normalized } = input;
  const now = input.now ?? Date.now();
  for (const member of normalized.members) {
    if (member.status === "removed") continue;
    const held = liveStacksForLineage(member.lineageId).find((owner) => owner.id !== stack.id);
    if (held) throw new StackWriteError(422, `"${member.lineageSlug}" is already a member of stack "${held.slug}"`);
  }
  const version = predecessor.version + 1;
  const doc = manifestDoc(stack, normalized, version, predecessor.version, input.reason, predecessor.doc.projects, now);
  let manifestId: string;
  try {
    manifestId = insertManifest(stack, doc, now);
  } catch (err) {
    if (isUniqueViolation(err)) return { raced: true };
    throw err;
  }
  db.run(
    "UPDATE review_stacks SET latest_manifest_version = ?, base_ref = ?, provider_stack_id = ?, provider_stack_number = ?, updated_at = ? WHERE id = ?",
    [version, normalized.baseRef, normalized.provider.stackId, normalized.provider.stackNumber, now, stack.id],
  );
  syncMembers(stack, manifestId, normalized.members, now);
  supersedeOpenStackWitnessRequest(stack.id, predecessor.id, manifestId, now);
  const request = accountReady(normalized.members) ? insertRequest(stack, manifestId, version, now) : null;
  const manifest = getStackManifestById(stack.workspace_id, manifestId);
  if (!manifest) throw new Error("Stack manifest publication did not write every row");
  return { raced: false, manifest, request };
}

/** Record that a successor left the predecessor's unpublished request behind. INSERT OR
 *  IGNORE, so the FIRST successor is what the history says. */
export function supersedeOpenStackWitnessRequest(stackId: string, predecessorManifestId: string, successorManifestId: string, now: number): number {
  const open = db.query<StackWitnessRequestRow, [string, string]>(
    "SELECT * FROM review_stack_witness_requests WHERE stack_id = ? AND manifest_id = ? AND state != 'published'",
  ).get(stackId, predecessorManifestId);
  if (!open) return 0;
  return db.run(
    "INSERT OR IGNORE INTO review_stack_witness_supersessions (request_id, workspace_id, stack_id, superseded_manifest_id, successor_manifest_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [open.id, open.workspace_id, stackId, predecessorManifestId, successorManifestId, now],
  ).changes;
}

/** A manifest's members with every pinned revision's newest account filled in. Rows only. */
function withAccounts(workspaceId: string, members: StackMemberSnapshot[]): StackMemberSnapshot[] {
  return members.map((member) => {
    if (member.accountId !== null) return member;
    const account = latestAccountForRevision(workspaceId, member.revisionId);
    return account ? { ...member, accountId: account.id, accountVersion: account.version } : member;
  });
}

function normalizedOf(doc: StackManifestDoc, members: StackMemberSnapshot[]): NormalizedStack {
  return {
    repo: doc.repository.repo,
    repoId: doc.repository.repoId,
    baseRef: doc.repository.baseRef,
    source: doc.source.kind,
    provider: { stackId: doc.source.providerStackId, stackNumber: doc.source.providerStackNumber, observedAt: doc.source.observedAt },
    members,
  };
}

/**
 * Called INSIDE `publishAccount`, after the member account's row is written.
 *
 * For each live stack of the lineage: if the current manifest pins this exact revision
 * without an account, and every pinned member's revision now has one, publish the
 * account-ready successor with those account ids. Two final member accounts racing
 * serialize on SQLite's writer lock, so the second reads a manifest that already carries
 * every account and does nothing. A lost successor race is re-evaluated once against the
 * new current manifest; a second loss is the 500 the race test shows never fires.
 */
export function onMemberAccountPublished(workspaceId: string, lineageId: string, revisionId: string): StackManifestRow[] {
  const published: StackManifestRow[] = [];
  for (const stack of liveStacksForLineage(lineageId)) {
    if (stack.workspace_id !== workspaceId) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = currentStackManifest(stack);
      if (!current) break;
      const mine = current.doc.members.find((member) => member.lineageId === lineageId);
      if (!mine || mine.status === "removed" || mine.revisionId !== revisionId || mine.accountId !== null) break;
      const members = withAccounts(workspaceId, current.doc.members);
      if (!accountReady(members)) break;
      const outcome = publishSuccessorManifest({ stack, predecessor: current, reason: "account-ready", normalized: normalizedOf(current.doc, members) });
      if (!outcome.raced) { published.push(outcome.manifest); break; }
      if (attempt === 1) throw new StackWriteError(500, "manifest publication raced twice");
    }
  }
  return published;
}

/**
 * A refresh: the newest completed revision and account of every member, compared with
 * the current manifest. Equal snapshots publish nothing and return the current manifest.
 * Not a transaction of its own: the route and the job each wrap it.
 */
export function refreshStackManifest(stack: ReviewStackRow, normalized: NormalizedStack): { manifest: StackManifestRow; created: boolean } {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = currentStackManifest(stack);
    if (!current) throw new Error(`Stack ${stack.id} has no current manifest`);
    const members = withAccounts(stack.workspace_id, normalized.members);
    if (sameMembers(members, current.doc.members) && current.doc.repository.baseRef === normalized.baseRef &&
        current.doc.source.providerStackNumber === normalized.provider.stackNumber) {
      return { manifest: current, created: false };
    }
    const outcome = publishSuccessorManifest({ stack, predecessor: current, reason: "refresh", normalized: { ...normalized, members } });
    if (!outcome.raced) return { manifest: outcome.manifest, created: true };
  }
  throw new StackWriteError(500, "manifest publication raced twice");
}

// ---- the account ----

export interface PublishStackAccountInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  stack: ReviewStackRow;
  manifest: StackManifestRow;
  witness: { summary: string; agent: { name: string; model: string } };
  groups: StackGroup[];
}

export interface PublishedStackAccount {
  account: StackAccountRow;
  request: StackWitnessRequestRow;
  created: boolean;
}

/** One account over one manifest, and the request moving to `published`, in one
 *  transaction. Exact replay returns the existing account; a different one conflicts. */
export const publishStackAccount = db.transaction((input: PublishStackAccountInput): PublishedStackAccount => {
  const { workspaceId, manifest } = input;
  const stack = getStackById(input.stack.id);
  if (!stack || stack.workspace_id !== workspaceId) throw new StackWriteError(404, "No such stack in this workspace");
  const request = getStackWitnessRequestForManifest(workspaceId, manifest.id);
  if (!request) throw new StackWriteError(409, "This manifest is not account-ready: a member has no account on its pinned revision yet");
  const now = Date.now();
  const authored = digestOf({ manifestId: manifest.id, witness: input.witness, groups: input.groups });
  const existing = getStackAccountForManifest(workspaceId, manifest.id);
  if (existing) {
    const prior = digestOf({ manifestId: manifest.id, witness: { summary: existing.doc.witness.summary, agent: existing.doc.witness.agent }, groups: existing.doc.groups });
    if (prior !== authored) throw new StackWriteError(409, `Manifest ${manifest.version} of "${stack.slug}" already carries a different account`);
    return { account: existing, request, created: false };
  }
  if (request.state !== "pending") {
    throw new StackWriteError(409, request.state === "failed"
      ? "Retry the failed stack witness request before publishing an account"
      : "This stack witness request already published an account");
  }
  if (isStackWitnessRequestSuperseded(request.id)) throw new StackWriteError(409, STACK_SUPERSEDED_MESSAGE);
  takeStackClaim(workspaceId, request, input.userId, input.keyId, now);

  const id = tinyId("rsa");
  const doc: StackAccountDoc = {
    identity: { stackId: stack.id, slug: stack.slug, manifestId: manifest.id, version: manifest.version, createdAt: new Date(now).toISOString() },
    witness: { summary: input.witness.summary, agent: input.witness.agent, userId: input.userId, keyId: input.keyId },
    groups: input.groups,
  };
  db.run(
    "INSERT INTO review_stack_accounts (id, stack_id, manifest_id, workspace_id, slug, version, schema_version, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, stack.id, manifest.id, workspaceId, stack.slug, manifest.version, STACK_SCHEMA_VERSION, JSON.stringify(doc), digestOf(doc), input.userId, input.keyId, now],
  );
  db.run("UPDATE review_stacks SET updated_at = ? WHERE id = ?", [now, stack.id]);
  db.run(
    "UPDATE review_stack_witness_requests SET state = 'published', failure = NULL, account_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [id, now, workspaceId, request.id],
  );
  const account = getStackAccountForManifest(workspaceId, manifest.id);
  const publishedRequest = getStackWitnessRequest(workspaceId, request.id);
  if (!account || !publishedRequest) throw new Error("Stack account publication did not write every row");
  return { account, request: publishedRequest, created: true };
}) as (input: PublishStackAccountInput) => PublishedStackAccount;

/** The pinned member accounts a validator checks references against, keyed by lineage id.
 *  A revision carries at most one account, so the newest is the pinned one; the id is still
 *  compared, so a manifest can never be validated against an account it did not pin. */
export function pinnedAccountsOf(workspaceId: string, manifest: StackManifestRow): Map<string, ReviewAccountRow> {
  const out = new Map<string, ReviewAccountRow>();
  for (const member of pinnedMembers(manifest.doc)) {
    if (member.accountId === null) continue;
    const account = latestAccountForRevision(workspaceId, member.revisionId);
    if (account && account.id === member.accountId) out.set(member.lineageId, account);
  }
  return out;
}

// ---- witness claims ----
//
// The same grammar a member request has: one attempt is `(request, retry count)`, a
// same-key claim renews, an expired lease may be recovered, and a healthy foreign lease
// refuses. Its own table, because a stack request is its own row.

export function getStackWitnessClaim(requestId: string, retryCount: number): WitnessClaimRow | null {
  return db.query<WitnessClaimRow, [string, number]>(
    "SELECT * FROM review_stack_witness_claims WHERE request_id = ? AND retry_count = ?",
  ).get(requestId, retryCount);
}

function takeStackClaim(workspaceId: string, request: StackWitnessRequestRow, userId: string, keyId: string, now: number): WitnessClaimRow {
  const held = getStackWitnessClaim(request.id, request.retry_count);
  if (held && held.key_id !== keyId && held.lease_expires_at > now) {
    throw new StackWriteError(409, "Another agent holds this stack witness request; its claim has not expired.");
  }
  db.run(
    "INSERT INTO review_stack_witness_claims (request_id, retry_count, workspace_id, user_id, key_id, lease_token, lease_expires_at, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(request_id, retry_count) DO UPDATE SET workspace_id = excluded.workspace_id, user_id = excluded.user_id, key_id = excluded.key_id, lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at, claimed_at = excluded.claimed_at",
    [request.id, request.retry_count, workspaceId, userId, keyId, tinyId("wcl"), now + WITNESS_LEASE_MS, now],
  );
  return getStackWitnessClaim(request.id, request.retry_count)!;
}

export interface StackWitnessClaimResult {
  request: StackWitnessRequestRow;
  claim: WitnessClaimRow;
  created: boolean;
}

export const claimStackWitnessRequest = db.transaction((input: { workspaceId: string; requestId: string; userId: string; keyId: string; now?: number }): StackWitnessClaimResult => {
  const now = input.now ?? Date.now();
  const request = getStackWitnessRequest(input.workspaceId, input.requestId);
  if (!request) throw new StackWriteError(404, "No such stack witness request in this workspace");
  if (request.state === "published") throw new StackWriteError(409, "This stack witness request already published an account");
  if (request.state === "failed") throw new StackWriteError(409, "Retry the failed stack witness request before claiming it");
  if (isStackWitnessRequestSuperseded(request.id)) throw new StackWriteError(409, STACK_SUPERSEDED_MESSAGE);
  const held = getStackWitnessClaim(request.id, request.retry_count);
  const created = !held || held.key_id !== input.keyId;
  const claim = takeStackClaim(input.workspaceId, request, input.userId, input.keyId, now);
  return { request, claim, created };
}) as (input: { workspaceId: string; requestId: string; userId: string; keyId: string; now?: number }) => StackWitnessClaimResult;

export const failStackWitnessRequest = db.transaction((workspaceId: string, request: StackWitnessRequestRow, failure: string, claimant: { userId: string; keyId: string }): StackWitnessRequestRow => {
  const current = getStackWitnessRequest(workspaceId, request.id);
  if (!current) throw new StackWriteError(404, "No such stack witness request in this workspace");
  if (current.state === "published") throw new StackWriteError(409, "This stack witness request already published an account");
  if (isStackWitnessRequestSuperseded(current.id)) throw new StackWriteError(409, STACK_SUPERSEDED_MESSAGE);
  const now = Date.now();
  takeStackClaim(workspaceId, current, claimant.userId, claimant.keyId, now);
  db.run(
    "UPDATE review_stack_witness_requests SET state = 'failed', failure = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [failure.slice(0, 600), now, workspaceId, current.id],
  );
  return getStackWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: StackWitnessRequestRow, failure: string, claimant: { userId: string; keyId: string }) => StackWitnessRequestRow;

export const retryStackWitnessRequest = db.transaction((workspaceId: string, request: StackWitnessRequestRow): StackWitnessRequestRow => {
  const current = getStackWitnessRequest(workspaceId, request.id);
  if (!current) throw new StackWriteError(404, "No such stack witness request in this workspace");
  if (current.state === "published") throw new StackWriteError(409, "This stack witness request already published an account");
  if (isStackWitnessRequestSuperseded(current.id)) throw new StackWriteError(409, STACK_SUPERSEDED_MESSAGE);
  if (current.state === "failed") {
    db.run(
      "UPDATE review_stack_witness_requests SET state = 'pending', failure = NULL, retry_count = retry_count + 1, updated_at = ? WHERE workspace_id = ? AND id = ?",
      [Date.now(), workspaceId, current.id],
    );
  }
  return getStackWitnessRequest(workspaceId, current.id)!;
}) as (workspaceId: string, request: StackWitnessRequestRow) => StackWitnessRequestRow;
