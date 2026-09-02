// Permanent succession from one legacy ReviewDoc to immutable review lineages.
//
// The legacy artifact is never converted in place. This module records one explicit,
// resumable choice of successor and exposes its state. The worker lives in
// legacy-successor-jobs.ts; request transactions here make no GitHub call.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { hashKey, LSC_ID_RE, SLUG_RE, tinyId } from "../ids";
import { getProject } from "../projects/db";
import { getReview, getReviewVersion, type ReviewDoc } from "./db";
import { getCaptureJob, retryCaptureJob, scheduleActorQueue } from "./revision-jobs";
import {
  getAccountById,
  getLineage,
  getRevisionById,
  getWitnessRequestForRevision,
  latestAccountForRevision,
  workflowWord,
} from "./revision-db";
import { getObservation } from "./revision-pr";
import { currentStackManifest, getStack, getStackById } from "./stack-db";

export type LegacySuccessionKind = "single" | "stack";
export type LegacySuccessionState = "pending" | "running" | "failed" | "completed";

export interface LegacySuccessionRow {
  id: string;
  workspace_id: string;
  legacy_slug: string;
  kind: LegacySuccessionKind;
  target_slug: string;
  projects_json: string;
  state: LegacySuccessionState;
  created_by_user_id: string;
  created_by_key_id: string;
  attempts: number;
  failure: string | null;
  result_lineage_id: string | null;
  result_stack_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LegacySuccessionMemberRow {
  succession_id: string;
  position: number;
  workspace_id: string;
  repo: string;
  pr_number: number;
  lineage_slug: string;
  lineage_id: string | null;
  capture_job_id: string | null;
  revision_id: string | null;
  account_id: string | null;
  updated_at: number;
}

interface LegacySuccessionIdempotencyRow {
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  succession_id: string;
  created_at: number;
}

export class LegacySuccessionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LegacySuccessionError";
  }
}

export function getLegacySuccession(workspaceId: string, id: string): LegacySuccessionRow | null {
  return db.query<LegacySuccessionRow, [string, string]>(
    "SELECT * FROM review_legacy_successions WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

export function getLegacySuccessionForReview(
  workspaceId: string,
  legacySlug: string,
): LegacySuccessionRow | null {
  return db.query<LegacySuccessionRow, [string, string]>(
    "SELECT * FROM review_legacy_successions WHERE workspace_id = ? AND legacy_slug = ?",
  ).get(workspaceId, legacySlug);
}

export function listLegacySuccessionMembers(id: string): LegacySuccessionMemberRow[] {
  return db.query<LegacySuccessionMemberRow, [string]>(
    "SELECT * FROM review_legacy_succession_members WHERE succession_id = ? ORDER BY position ASC",
  ).all(id);
}

export function legacySuccessionProjects(row: LegacySuccessionRow): string[] {
  const value = JSON.parse(row.projects_json) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !SLUG_RE.test(entry))) {
    throw new Error(`Legacy succession ${row.id} has invalid stored Project input`);
  }
  return value as string[];
}

function successionJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (key === "" || key.length > 200 || hasControlCharacter(key)) {
    throw new LegacySuccessionError(
      400,
      "idempotency_key_required",
      "Idempotency-Key header is required and must be a short printable value.",
    );
  }
  return key;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new LegacySuccessionError(400, "invalid_body", "Body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LegacySuccessionError(400, "invalid_body", "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) {
    throw new LegacySuccessionError(422, "invalid_request", `${JSON.stringify(extra)} is not a supported field.`);
  }
}

function slugField(value: unknown, name: string): string {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new LegacySuccessionError(422, "invalid_request", `${name} must match [a-z0-9][a-z0-9-]{0,63}.`);
  }
  return value;
}

function projectsField(body: Record<string, unknown>, workspaceId: string): string[] {
  if (body.projects === undefined) return [];
  if (!Array.isArray(body.projects) || body.projects.length > 16) {
    throw new LegacySuccessionError(422, "invalid_request", "projects must be a list of at most 16 project slugs.");
  }
  const projects = new Set<string>();
  for (const value of body.projects) {
    const slug = slugField(value, "projects[]");
    if (!getProject(workspaceId, slug)) {
      throw new LegacySuccessionError(422, "unknown_project", `No project "${slug}" in this workspace.`);
    }
    projects.add(slug);
  }
  return [...projects].sort();
}

interface NormalizedLegacySuccession {
  kind: LegacySuccessionKind;
  targetSlug: string;
  projects: string[];
  members: { position: number; repo: string; pr: number; lineageSlug: string }[];
}

type LegacyPr = ReviewDoc["prs"][number];

/** A legacy stack's authored pointer array is not chain order. Follow its stored parent
 * links so the immutable manifest is always bottom to top. */
function orderedLegacyStackPrs(prs: LegacyPr[]): LegacyPr[] {
  const byNumber = new Map<number, LegacyPr>();
  for (const pr of prs) {
    if (byNumber.has(pr.number)) {
      throw new LegacySuccessionError(422, "unsupported_source", `Legacy stack repeats pull request #${pr.number}.`);
    }
    byNumber.set(pr.number, pr);
  }
  const roots = prs.filter((pr) => pr.parent === null || !byNumber.has(pr.parent));
  if (roots.length !== 1) {
    throw new LegacySuccessionError(422, "unsupported_source", "Legacy stack has no unique bottom pull request.");
  }
  const children = new Map<number, LegacyPr[]>();
  for (const pr of prs) {
    if (pr.parent === null || !byNumber.has(pr.parent)) continue;
    const held = children.get(pr.parent) ?? [];
    held.push(pr);
    children.set(pr.parent, held);
  }
  const ordered: LegacyPr[] = [];
  const seen = new Set<number>();
  let current: LegacyPr | undefined = roots[0];
  while (current) {
    if (seen.has(current.number)) {
      throw new LegacySuccessionError(422, "unsupported_source", `Legacy stack cycles at pull request #${current.number}.`);
    }
    seen.add(current.number);
    ordered.push(current);
    const next = children.get(current.number) ?? [];
    if (next.length > 1) {
      throw new LegacySuccessionError(422, "unsupported_source", `Legacy stack branches above pull request #${current.number}.`);
    }
    current = next[0];
  }
  if (ordered.length !== prs.length) {
    throw new LegacySuccessionError(422, "unsupported_source", "Legacy stack parent links do not form one complete chain.");
  }
  return ordered;
}

function normalizeRequest(
  workspaceId: string,
  legacySlug: string,
  body: Record<string, unknown>,
): NormalizedLegacySuccession {
  const review = getReview(workspaceId, legacySlug);
  if (!review) {
    throw new LegacySuccessionError(404, "not_found", "No such legacy review in this workspace.");
  }
  const version = getReviewVersion(workspaceId, legacySlug, review.latest_version);
  if (!version) throw new Error(`Legacy review ${workspaceId}/${legacySlug} has no latest version row`);
  const sourceKind = version.doc.kind;
  if (body.kind !== sourceKind) {
    throw new LegacySuccessionError(
      422,
      "source_kind_mismatch",
      `The stored legacy review is ${sourceKind}; the requested kind was ${String(body.kind)}.`,
    );
  }
  if (sourceKind === "set") {
    onlyFields(body, ["kind"]);
    throw new LegacySuccessionError(
      422,
      "unsupported_source",
      "An unrelated legacy review set has no immutable stack successor. It remains on the legacy reader.",
    );
  }
  const projects = projectsField(body, workspaceId);
  if (sourceKind === "single") {
    onlyFields(body, ["kind", "lineageSlug", "projects"]);
    if (version.doc.prs.length !== 1) throw new Error(`Legacy single ${legacySlug} does not carry exactly one pull request`);
    const lineageSlug = slugField(body.lineageSlug, "lineageSlug");
    const pr = version.doc.prs[0]!;
    return {
      kind: "single",
      targetSlug: lineageSlug,
      projects,
      members: [{ position: 1, repo: pr.repo, pr: pr.number, lineageSlug }],
    };
  }

  onlyFields(body, ["kind", "stackSlug", "members", "projects"]);
  const stackSlug = slugField(body.stackSlug, "stackSlug");
  const sourcePrs = orderedLegacyStackPrs(version.doc.prs);
  if (!Array.isArray(body.members) || body.members.length !== sourcePrs.length) {
    throw new LegacySuccessionError(
      422,
      "source_members_mismatch",
      `members must name all ${sourcePrs.length} stored pull requests in bottom-to-top chain order.`,
    );
  }
  const members: NormalizedLegacySuccession["members"] = [];
  const lineageSlugs = new Set<string>();
  for (const [index, raw] of body.members.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LegacySuccessionError(422, "source_members_mismatch", `members[${index}] must be { pr, lineageSlug }.`);
    }
    const member = raw as Record<string, unknown>;
    onlyFields(member, ["pr", "lineageSlug"]);
    const expected = sourcePrs[index]!;
    if (!Number.isInteger(member.pr) || member.pr !== expected.number) {
      throw new LegacySuccessionError(
        422,
        "source_members_mismatch",
        `members[${index}].pr must be ${expected.number}, the pull request stored at that position.`,
      );
    }
    const lineageSlug = slugField(member.lineageSlug, `members[${index}].lineageSlug`);
    if (lineageSlugs.has(lineageSlug)) {
      throw new LegacySuccessionError(422, "source_members_mismatch", `Lineage slug "${lineageSlug}" is named twice.`);
    }
    lineageSlugs.add(lineageSlug);
    members.push({ position: index + 1, repo: expected.repo, pr: expected.number, lineageSlug });
  }
  return { kind: "stack", targetSlug: stackSlug, projects, members };
}

function normalizedHash(legacySlug: string, normalized: NormalizedLegacySuccession): string {
  return hashKey(JSON.stringify({
    legacySlug,
    kind: normalized.kind,
    targetSlug: normalized.targetSlug,
    projects: normalized.projects,
    members: normalized.members.map((member) => ({
      position: member.position,
      repo: member.repo.toLowerCase(),
      pr: member.pr,
      lineageSlug: member.lineageSlug,
    })),
  }));
}

/** Refuse every known PR and slug conflict before choosing a permanent workflow row.
 * Existing lineages may be adopted only when their retained relation owns the exact PR. */
function assertRetainedOwners(
  workspaceId: string,
  legacySlug: string,
  normalized: NormalizedLegacySuccession,
): void {
  for (const member of normalized.members) {
    const source = db.query<{ repo_id: number | null }, [string, string, number, string]>(
      "SELECT repo_id FROM review_prs WHERE workspace_id = ? AND slug = ? AND pr_number = ? AND lower(repo) = lower(?) LIMIT 1",
    ).get(workspaceId, legacySlug, member.pr, member.repo);
    const owner = source?.repo_id !== null && source?.repo_id !== undefined
      ? db.query<{ slug: string }, [string, number, number]>(
          "SELECT slug FROM review_lineage_prs WHERE workspace_id = ? AND repo_id = ? AND pr_number = ? AND detached_at IS NULL",
        ).get(workspaceId, source.repo_id, member.pr)
      : db.query<{ slug: string }, [string, string, number]>(
          "SELECT slug FROM review_lineage_prs WHERE workspace_id = ? AND lower(repo) = lower(?) AND pr_number = ? AND detached_at IS NULL",
        ).get(workspaceId, member.repo, member.pr);
    if (owner && owner.slug !== member.lineageSlug) {
      throw new LegacySuccessionError(
        409,
        "pull_request_owned",
        `${member.repo}#${member.pr} is already reviewed at ` +
          `${config.baseUrl}/${workspaceId}/r/${owner.slug}. Request lineage slug "${owner.slug}".`,
      );
    }

    if (getReview(workspaceId, member.lineageSlug)) {
      throw new LegacySuccessionError(
        409,
        "review_slug_taken",
        `Review slug "${member.lineageSlug}" is owned by a legacy review. Choose a different lineage slug.`,
      );
    }
    if (getStack(workspaceId, member.lineageSlug)) {
      throw new LegacySuccessionError(
        409,
        "review_slug_taken",
        `Review slug "${member.lineageSlug}" already names a review stack. Choose a different lineage slug.`,
      );
    }

    const named = getLineage(workspaceId, member.lineageSlug);
    if (named) {
      const relation = db.query<{ repo_id: number; repo: string; pr_number: number }, [string, string]>(
        "SELECT repo_id, repo, pr_number FROM review_lineage_prs WHERE workspace_id = ? AND lineage_id = ? AND detached_at IS NULL",
      ).get(workspaceId, named.id);
      const sameRepository = relation && (source?.repo_id !== null && source?.repo_id !== undefined
        ? relation.repo_id === source.repo_id
        : relation.repo.toLowerCase() === member.repo.toLowerCase());
      if (!relation || !sameRepository || relation.pr_number !== member.pr) {
        const detail = relation ? `${relation.repo}#${relation.pr_number}` : "a branch-first review with no pull request";
        throw new LegacySuccessionError(
          409,
          "review_slug_taken",
          `Review slug "${member.lineageSlug}" already names ${detail}.`,
        );
      }
    }
  }

  if (normalized.kind === "stack") {
    if (normalized.members.some((member) => member.lineageSlug === normalized.targetSlug)) {
      throw new LegacySuccessionError(
        409,
        "stack_slug_taken",
        `Stack slug "${normalized.targetSlug}" also names a requested member lineage. Choose a different stack slug.`,
      );
    }
    if (getReview(workspaceId, normalized.targetSlug)) {
      throw new LegacySuccessionError(409, "stack_slug_taken", `Stack slug "${normalized.targetSlug}" already names a legacy review.`);
    }
    if (getLineage(workspaceId, normalized.targetSlug)) {
      throw new LegacySuccessionError(409, "stack_slug_taken", `Stack slug "${normalized.targetSlug}" already names a promoted review.`);
    }
    if (getStack(workspaceId, normalized.targetSlug)) {
      throw new LegacySuccessionError(409, "stack_slug_taken", `Stack slug "${normalized.targetSlug}" already names a stack.`);
    }
  }
}

export interface CreateLegacySuccessionInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  idempotencyKey: string;
  legacySlug: string;
  body: Record<string, unknown>;
}

export interface CreatedLegacySuccession {
  row: LegacySuccessionRow;
  created: boolean;
}

/** Amend only names that never resolved after a failed attempt. Source PRs, Projects,
 * resolved member lineages, creator key, and workflow identity stay fixed. */
function amendFailedSuccession(
  input: CreateLegacySuccessionInput,
  existing: LegacySuccessionRow,
  normalized: NormalizedLegacySuccession,
  requestHash: string,
): CreatedLegacySuccession {
  if (existing.state !== "failed" || existing.result_lineage_id !== null || existing.result_stack_id !== null) {
    throw new LegacySuccessionError(
      409,
      "successor_already_chosen",
      `Legacy review "${input.legacySlug}" already has a different permanent successor.`,
    );
  }
  if (existing.created_by_user_id !== input.userId || existing.created_by_key_id !== input.keyId) {
    throw new LegacySuccessionError(
      403,
      "creator_required",
      "Only the API key that created this successor may amend its unresolved slugs.",
    );
  }
  if (existing.kind !== normalized.kind || JSON.stringify(legacySuccessionProjects(existing)) !== JSON.stringify(normalized.projects)) {
    throw new LegacySuccessionError(
      409,
      "successor_amendment_refused",
      "A failed successor amendment may change only unresolved target and member slugs.",
    );
  }

  const stored = listLegacySuccessionMembers(existing.id);
  if (stored.length !== normalized.members.length) {
    throw new LegacySuccessionError(409, "successor_amendment_refused", "The retained successor members no longer match this request.");
  }
  for (const [index, member] of normalized.members.entries()) {
    const held = stored[index];
    if (!held || held.position !== member.position || held.pr_number !== member.pr || held.repo.toLowerCase() !== member.repo.toLowerCase()) {
      throw new LegacySuccessionError(
        409,
        "successor_amendment_refused",
        "A failed successor amendment may not change its retained pull requests or their order.",
      );
    }
    if (held.lineage_id !== null && held.lineage_slug !== member.lineageSlug) {
      throw new LegacySuccessionError(
        409,
        "successor_amendment_refused",
        `Resolved lineage slug "${held.lineage_slug}" is permanent and may not be amended.`,
      );
    }
    const retainedChild = db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM review_pr_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
    ).get(input.workspaceId, `legacy-successor:${existing.id}:${held.position}`);
    if (held.lineage_id === null && held.lineage_slug !== member.lineageSlug && retainedChild) {
      throw new LegacySuccessionError(
        409,
        "successor_amendment_refused",
        `Member ${held.position} already has a retained ingestion result. Retry it instead of renaming it.`,
      );
    }
    if (held.lineage_id === null && (held.capture_job_id !== null || held.revision_id !== null || held.account_id !== null)) {
      throw new LegacySuccessionError(
        409,
        "successor_amendment_refused",
        `Member ${held.position} has partial retained progress and cannot be renamed safely.`,
      );
    }
  }
  if (existing.kind === "single" && stored[0]?.lineage_id !== null && existing.target_slug !== normalized.targetSlug) {
    throw new LegacySuccessionError(
      409,
      "successor_amendment_refused",
      `Resolved lineage slug "${existing.target_slug}" is permanent and may not be amended.`,
    );
  }
  if (existing.target_slug !== normalized.targetSlug) {
    const retainedStack = db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM review_stack_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
    ).get(input.workspaceId, `legacy-successor:${existing.id}:stack`);
    if (retainedStack) {
      throw new LegacySuccessionError(
        409,
        "successor_amendment_refused",
        "The stack target already has a retained creation result. Retry the workflow instead of renaming it.",
      );
    }
  }

  assertRetainedOwners(input.workspaceId, input.legacySlug, normalized);

  const changed = normalized.members.filter((member, index) => {
    const held = stored[index]!;
    return held.lineage_id === null && held.lineage_slug !== member.lineageSlug;
  });
  for (const member of changed) {
    db.run(
      "UPDATE review_legacy_succession_members SET lineage_slug = ?, updated_at = ? WHERE succession_id = ? AND position = ? AND lineage_id IS NULL",
      [`amending-${existing.id}-${member.position}`, Date.now(), existing.id, member.position],
    );
  }
  const now = Date.now();
  for (const member of changed) {
    db.run(
      "UPDATE review_legacy_succession_members SET lineage_slug = ?, updated_at = ? WHERE succession_id = ? AND position = ? AND lineage_id IS NULL",
      [member.lineageSlug, now, existing.id, member.position],
    );
  }
  const updated = db.run(
    "UPDATE review_legacy_successions SET target_slug = ?, state = 'pending', failure = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'failed' AND result_lineage_id IS NULL AND result_stack_id IS NULL AND created_by_key_id = ?",
    [normalized.targetSlug, now, existing.id, input.keyId],
  ).changes;
  if (updated !== 1) throw new Error(`Legacy succession ${existing.id} could not retain its amendment`);
  db.run(
    "INSERT INTO review_legacy_succession_idempotency (workspace_id, idempotency_key, request_hash, succession_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [input.workspaceId, input.idempotencyKey, requestHash, existing.id, now],
  );
  return { row: getLegacySuccession(input.workspaceId, existing.id)!, created: false };
}

/** Re-read source, validate, choose one permanent successor, and write no partial row. */
export const createLegacySuccession = db.transaction((
  input: CreateLegacySuccessionInput,
): CreatedLegacySuccession => {
  const normalized = normalizeRequest(input.workspaceId, input.legacySlug, input.body);
  const requestHash = normalizedHash(input.legacySlug, normalized);
  const held = db.query<LegacySuccessionIdempotencyRow, [string, string]>(
    "SELECT * FROM review_legacy_succession_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(input.workspaceId, input.idempotencyKey);
  if (held) {
    if (held.request_hash !== requestHash) {
      throw new LegacySuccessionError(409, "idempotency_conflict", "This Idempotency-Key was already used for a different legacy successor request.");
    }
    const row = getLegacySuccession(input.workspaceId, held.succession_id);
    if (!row) throw new Error(`Legacy succession idempotency ${held.idempotency_key} points at a missing row`);
    return { row, created: false };
  }

  const existing = getLegacySuccessionForReview(input.workspaceId, input.legacySlug);
  if (existing) {
    const first = db.query<LegacySuccessionIdempotencyRow, [string]>(
      "SELECT * FROM review_legacy_succession_idempotency WHERE succession_id = ? ORDER BY created_at ASC LIMIT 1",
    ).get(existing.id);
    if (!first) throw new Error(`Legacy succession ${existing.id} has no idempotency owner`);
    if (first.request_hash === requestHash) {
      db.run(
        "INSERT INTO review_legacy_succession_idempotency (workspace_id, idempotency_key, request_hash, succession_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [input.workspaceId, input.idempotencyKey, requestHash, existing.id, Date.now()],
      );
      return { row: existing, created: false };
    }
    return amendFailedSuccession(input, existing, normalized, requestHash);
  }

  assertRetainedOwners(input.workspaceId, input.legacySlug, normalized);

  const now = Date.now();
  const id = tinyId("lsc");
  db.run(
    "INSERT INTO review_legacy_successions (id, workspace_id, legacy_slug, kind, target_slug, projects_json, state, created_by_user_id, created_by_key_id, attempts, failure, result_lineage_id, result_stack_id, lease_token, lease_expires_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)",
    [id, input.workspaceId, input.legacySlug, normalized.kind, normalized.targetSlug,
      JSON.stringify(normalized.projects), input.userId, input.keyId, now, now],
  );
  for (const member of normalized.members) {
    db.run(
      "INSERT INTO review_legacy_succession_members (succession_id, position, workspace_id, repo, pr_number, lineage_slug, lineage_id, capture_job_id, revision_id, account_id, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)",
      [id, member.position, input.workspaceId, member.repo, member.pr, member.lineageSlug, now],
    );
  }
  db.run(
    "INSERT INTO review_legacy_succession_idempotency (workspace_id, idempotency_key, request_hash, succession_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [input.workspaceId, input.idempotencyKey, requestHash, id, now],
  );
  const row = getLegacySuccession(input.workspaceId, id);
  if (!row) throw new Error("Legacy succession creation did not write its row");
  return { row, created: true };
}) as (input: CreateLegacySuccessionInput) => CreatedLegacySuccession;

function exactResultLineage(
  row: LegacySuccessionRow,
  members: LegacySuccessionMemberRow[] = listLegacySuccessionMembers(row.id),
): { id: string; slug: string } | null {
  const id = row.result_lineage_id ?? (row.kind === "single" ? members[0]?.lineage_id ?? null : null);
  if (!id) return null;
  const lineage = db.query<{ id: string; slug: string }, [string, string]>(
    "SELECT id, slug FROM review_lineages WHERE workspace_id = ? AND id = ?",
  ).get(row.workspace_id, id);
  return lineage?.slug === row.target_slug ? lineage : null;
}

function exactResultStack(row: LegacySuccessionRow): ReturnType<typeof getStackById> {
  let id = row.result_stack_id;
  if (!id && row.kind === "stack") {
    id = db.query<{ stack_id: string }, [string, string]>(
      "SELECT stack_id FROM review_stack_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
    ).get(row.workspace_id, `legacy-successor:${row.id}:stack`)?.stack_id ?? null;
  }
  if (!id) return null;
  const stack = getStackById(id);
  return stack?.workspace_id === row.workspace_id && stack.slug === row.target_slug ? stack : null;
}

function memberProgress(row: LegacySuccessionMemberRow): unknown {
  const lineage = row.lineage_id
    ? db.query<{ slug: string }, [string, string]>(
        "SELECT slug FROM review_lineages WHERE workspace_id = ? AND id = ?",
      ).get(row.workspace_id, row.lineage_id)
    : null;
  const job = row.capture_job_id ? getCaptureJob(row.workspace_id, row.capture_job_id) : null;
  const revision = row.revision_id ? getRevisionById(row.workspace_id, row.revision_id) : null;
  const account = row.account_id
    ? getAccountById(row.workspace_id, row.account_id)
    : revision
      ? latestAccountForRevision(row.workspace_id, revision.id)
      : null;
  const request = revision ? getWitnessRequestForRevision(row.workspace_id, revision.id) : null;
  let state = "lineage_pending";
  if (lineage) state = "capture_pending";
  if (job?.state === "running") state = "capturing";
  if (job?.state === "failed") state = "capture_failed";
  if (revision) state = workflowWord(request) === "failed" ? "witness_failed" : workflowWord(request) === "retrying" ? "witness_retrying" : "witness_pending";
  if (account) state = "ready";
  return {
    position: row.position,
    repo: row.repo,
    pullRequest: row.pr_number,
    lineageSlug: row.lineage_slug,
    state,
    lineageUrl: lineage ? `${config.baseUrl}/${row.workspace_id}/r/${row.lineage_slug}` : null,
    captureJobUrl: job ? `${config.baseUrl}/api/review-capture-jobs/${job.id}` : null,
    captureFailure: job?.failure ?? null,
    revisionUrl: revision ? `${config.baseUrl}/${row.workspace_id}/r/${row.lineage_slug}/rev/${revision.revision}` : null,
    witness: workflowWord(request),
    accountUrl: account ? `${config.baseUrl}/${row.workspace_id}/r/${row.lineage_slug}/v/${account.version}` : null,
  };
}

export function legacySuccessionView(row: LegacySuccessionRow): unknown {
  const members = listLegacySuccessionMembers(row.id);
  const resultLineage = exactResultLineage(row, members);
  const resultStack = exactResultStack(row);
  const manifest = resultStack ? currentStackManifest(resultStack) : null;
  const singleMember = row.kind === "single" ? members[0] ?? null : null;
  const singleRevision = resultLineage && singleMember?.revision_id
    ? getRevisionById(row.workspace_id, singleMember.revision_id)
    : null;
  const latestUrl = resultLineage
    ? `${config.baseUrl}/${row.workspace_id}/r/${resultLineage.slug}`
    : resultStack
      ? `${config.baseUrl}/${row.workspace_id}/r-stacks/${resultStack.slug}`
      : null;
  const pinnedUrl = resultLineage && singleRevision
    ? `${latestUrl}/rev/${singleRevision.revision}`
    : resultStack && manifest
      ? `${latestUrl}/v/${manifest.version}`
      : null;
  return {
    id: row.id,
    workspace: row.workspace_id,
    legacySlug: row.legacy_slug,
    kind: row.kind,
    targetSlug: row.target_slug,
    state: row.state,
    attempts: row.attempts,
    failure: row.failure,
    legacyUrl: `${config.baseUrl}/${row.workspace_id}/r/${row.legacy_slug}`,
    statusUrl: `${config.baseUrl}/api/review-legacy-successions/${row.id}`,
    retryUrl: row.state === "failed" ? `${config.baseUrl}/api/review-legacy-successions/${row.id}/retry` : null,
    result: {
      url: latestUrl,
      pinnedUrl,
      lineageId: resultLineage?.id ?? null,
      stackId: resultStack?.id ?? null,
    },
    projects: legacySuccessionProjects(row),
    members: members.map(memberProgress),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function legacySuccessorLink(
  workspaceId: string,
  legacySlug: string,
  absolute: boolean = true,
): { state: LegacySuccessionState; url: string | null; statusUrl: string; failure: string | null } | null {
  const row = getLegacySuccessionForReview(workspaceId, legacySlug);
  if (!row) return null;
  const lineage = exactResultLineage(row);
  const stack = exactResultStack(row);
  const origin = absolute ? config.baseUrl : "";
  return {
    state: row.state,
    url: lineage
      ? `${origin}/${workspaceId}/r/${lineage.slug}`
      : stack
        ? `${origin}/${workspaceId}/r-stacks/${stack.slug}`
        : null,
    statusUrl: `${origin}/api/review-legacy-successions/${row.id}`,
    failure: row.failure,
  };
}

async function schedule(id: string): Promise<void> {
  const jobs = await import("./legacy-successor-jobs");
  jobs.scheduleLegacySuccession(id);
}

export async function handleCreateLegacySuccessor(req: Request, legacySlug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!SLUG_RE.test(legacySlug)) return successionJson({ error: "not_found" }, 404);
  try {
    const idempotencyKey = idempotencyKeyOf(req);
    const body = await readBody(req);
    const result = createLegacySuccession({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      idempotencyKey,
      legacySlug,
      body,
    });
    if (result.row.state === "pending") await schedule(result.row.id);
    const current = getLegacySuccession(auth.workspaceId, result.row.id) ?? result.row;
    const status = current.state === "completed" ? 200 : current.state === "failed" ? 409 : 202;
    return successionJson(legacySuccessionView(current), status);
  } catch (error) {
    if (error instanceof LegacySuccessionError) {
      return successionJson({ error: error.message, rule: error.code }, error.status);
    }
    console.error("[seer] legacy successor request failed:", error);
    return successionJson({ error: "Legacy successor creation failed.", rule: "legacy_successor_failed" }, 502);
  }
}

export async function handleReadLegacySuccession(req: Request, id: string): Promise<Response> {
  if (!LSC_ID_RE.test(id)) return successionJson({ error: "not_found" }, 404);
  // Loaded lazily to keep the legacy read renderer's successor-link import acyclic.
  const { readableWorkspaces } = await import("./read");
  for (const workspaceId of readableWorkspaces(req)) {
    const row = getLegacySuccession(workspaceId, id);
    if (row) return successionJson(legacySuccessionView(row));
  }
  return successionJson({ error: "not_found" }, 404);
}

export const retryLegacySuccession = db.transaction((
  workspaceId: string,
  id: string,
  userId: string,
  keyId: string,
  now: number = Date.now(),
): LegacySuccessionRow => {
  const row = getLegacySuccession(workspaceId, id);
  if (!row) throw new LegacySuccessionError(404, "not_found", "No such legacy succession in this workspace.");
  if (row.created_by_user_id !== userId || row.created_by_key_id !== keyId) {
    throw new LegacySuccessionError(403, "creator_required", "Only the API key that created this successor may retry its GitHub work.");
  }
  if (row.state === "completed") {
    throw new LegacySuccessionError(409, "already_completed", "This legacy successor already completed.");
  }
  if (row.state === "running" && (row.lease_expires_at ?? 0) > now) {
    throw new LegacySuccessionError(409, "already_running", "This legacy successor is running.");
  }
  db.run(
    "UPDATE review_legacy_successions SET state = 'pending', failure = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [now, workspaceId, id],
  );
  return getLegacySuccession(workspaceId, id)!;
}) as (workspaceId: string, id: string, userId: string, keyId: string, now?: number) => LegacySuccessionRow;

export async function handleRetryLegacySuccession(req: Request, id: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!LSC_ID_RE.test(id)) return successionJson({ error: "not_found" }, 404);
  try {
    const row = retryLegacySuccession(auth.workspaceId, id, auth.userId, auth.keyId);
    // A succession retry is also an explicit retry of any failed child capture. It never
    // retries a pending, running, or completed child, and it still uses the creator's
    // identity for the personal-credential ownership check.
    for (const member of listLegacySuccessionMembers(row.id)) {
      if (!member.capture_job_id) continue;
      const job = getCaptureJob(row.workspace_id, member.capture_job_id);
      if (job?.state !== "failed") continue;
      const retried = retryCaptureJob(row.workspace_id, job.id, row.created_by_user_id);
      if (retried.kind === "retried") scheduleActorQueue(retried.job.actor_key);
    }
    await schedule(row.id);
    return successionJson(legacySuccessionView(getLegacySuccession(row.workspace_id, row.id) ?? row), 202);
  } catch (error) {
    if (error instanceof LegacySuccessionError) {
      return successionJson({ error: error.message, rule: error.code }, error.status);
    }
    console.error("[seer] legacy successor retry failed:", error);
    return successionJson({ error: "Legacy successor retry failed.", rule: "legacy_successor_failed" }, 502);
  }
}
