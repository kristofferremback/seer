// Leased, resumable execution of permanent legacy successors.
//
// A lease protects one succession. GitHub reads happen outside SQLite transactions;
// every durable child identity is written after the read and before the next member.
// Waiting for a capture or a fresh witness releases the lease back to pending, and only a
// completion signal or the periodic recovery sweep schedules it again.

import { config } from "../config";
import { db } from "../db";
import { tinyId } from "../ids";
import { getProject } from "../projects/db";
import { GithubError } from "./github";
import { GithubAppRefusal, resolveReadSession } from "./github-app";
import {
  LegacySuccessionError,
  getLegacySuccession,
  legacySuccessionProjects,
  listLegacySuccessionMembers,
  type LegacySuccessionMemberRow,
  type LegacySuccessionRow,
} from "./legacy-successor";
import {
  getCaptureJob,
  scheduleActorQueue,
  type ReviewCaptureJobRow,
} from "./revision-jobs";
import {
  getAccountById,
  getLineage,
  getRevisionById,
  getWitnessRequestForRevision,
  isWitnessRequestSuperseded,
  latestAccountForRevision,
  type ReviewLineageRow,
} from "./revision-db";
import {
  getLineagePr,
  getLiveLineagePrByNumber,
  getPrIdempotency,
  importObservedConversation,
  ingestPullRequest,
  observePullRequestThrough,
  prRequestHash,
  replayPrOperation,
  PrIngestError,
  type PrIngestOutcome,
} from "./revision-pr";
import { createStack, getStackById, stackRequestHash, StackWriteError } from "./stack-db";
import { normalizeInferredPinnedChain } from "./stack-pr";

export const LEGACY_SUCCESSION_LEASE_MS = 120_000;
export const LEGACY_SUCCESSION_SWEEP_MS = LEGACY_SUCCESSION_LEASE_MS;
const HEARTBEAT_MS = LEGACY_SUCCESSION_LEASE_MS / 3;
const MAX_FAILURE = 600;

type Claim =
  | { kind: "claimed"; row: LegacySuccessionRow }
  | { kind: "busy" | "missing" | "finished" };

const claimLegacySuccession = db.transaction((id: string, now: number): Claim => {
  db.run(
    "UPDATE review_legacy_successions SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_expires_at <= ?",
    [now, id, now],
  );
  const current = db.query<LegacySuccessionRow, [string]>(
    "SELECT * FROM review_legacy_successions WHERE id = ?",
  ).get(id);
  if (!current) return { kind: "missing" };
  if (current.state === "completed" || current.state === "failed") return { kind: "finished" };
  if (current.state === "running") return { kind: "busy" };
  const token = tinyId("lse");
  const changed = db.run(
    "UPDATE review_legacy_successions SET state = 'running', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ? " +
      "WHERE id = ? AND state = 'pending'",
    [token, now + LEGACY_SUCCESSION_LEASE_MS, now, id],
  ).changes;
  if (changed === 0) return { kind: "busy" };
  return {
    kind: "claimed",
    row: db.query<LegacySuccessionRow, [string]>(
      "SELECT * FROM review_legacy_successions WHERE id = ?",
    ).get(id)!,
  };
}) as (id: string, now: number) => Claim;

function heartbeat(id: string, token: string, now: number = Date.now()): boolean {
  return db.run(
    "UPDATE review_legacy_successions SET lease_expires_at = ?, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [now + LEGACY_SUCCESSION_LEASE_MS, now, id, token],
  ).changes === 1;
}

function assertLease(id: string, token: string): LegacySuccessionRow {
  const row = db.query<LegacySuccessionRow, [string, string]>(
    "SELECT * FROM review_legacy_successions WHERE id = ? AND state = 'running' AND lease_token = ?",
  ).get(id, token);
  if (!row) throw new Error(`Legacy succession ${id} no longer holds its lease`);
  return row;
}

function updateMember(
  successionId: string,
  token: string,
  position: number,
  values: {
    lineageId?: string | null;
    captureJobId?: string | null;
    revisionId?: string | null;
    accountId?: string | null;
  },
): LegacySuccessionMemberRow {
  return db.transaction(() => {
    assertLease(successionId, token);
    const current = listLegacySuccessionMembers(successionId).find((row) => row.position === position);
    if (!current) throw new Error(`Legacy succession ${successionId} has no member ${position}`);
    const now = Date.now();
    db.run(
      "UPDATE review_legacy_succession_members SET lineage_id = ?, capture_job_id = ?, revision_id = ?, account_id = ?, updated_at = ? " +
        "WHERE succession_id = ? AND position = ?",
      [values.lineageId === undefined ? current.lineage_id : values.lineageId,
        values.captureJobId === undefined ? current.capture_job_id : values.captureJobId,
        values.revisionId === undefined ? current.revision_id : values.revisionId,
        values.accountId === undefined ? current.account_id : values.accountId,
        now, successionId, position],
    );
    heartbeat(successionId, token, now);
    return listLegacySuccessionMembers(successionId).find((row) => row.position === position)!;
  })();
}

function attachProjects(row: LegacySuccessionRow, lineage: ReviewLineageRow): void {
  const now = Date.now();
  for (const slug of legacySuccessionProjects(row)) {
    const project = getProject(row.workspace_id, slug);
    if (!project) throw new LegacySuccessionError(422, "unknown_project", `No project "${slug}" in this workspace.`);
    db.run(
      "INSERT OR IGNORE INTO project_review_lineages (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)",
      [project.id, row.workspace_id, lineage.slug, now],
    );
  }
}

function persistIngest(
  succession: LegacySuccessionRow,
  token: string,
  member: LegacySuccessionMemberRow,
  outcome: PrIngestOutcome,
): LegacySuccessionMemberRow {
  let captureJobId: string | null = null;
  let revisionId: string | null = null;
  if (outcome.kind === "reused") revisionId = outcome.revisionId;
  else {
    captureJobId = outcome.job.id;
    if (outcome.job.state === "completed") revisionId = outcome.job.revision_id;
  }
  const updated = updateMember(succession.id, token, member.position, {
    lineageId: outcome.lineage.id,
    captureJobId,
    revisionId,
    accountId: null,
  });
  attachProjects(succession, outcome.lineage);
  if (outcome.kind === "job" && outcome.job.state === "pending") {
    scheduleActorQueue(outcome.job.actor_key);
  }
  return updated;
}

async function ingestMember(
  succession: LegacySuccessionRow,
  token: string,
  member: LegacySuccessionMemberRow,
): Promise<LegacySuccessionMemberRow> {
  const session = await resolveReadSession(
    succession.workspace_id,
    member.repo,
    succession.created_by_user_id,
  );
  const observed = await observePullRequestThrough(session, member.repo, member.pr_number);
  assertLease(succession.id, token);

  const idempotencyKey = `legacy-successor:${succession.id}:${member.position}`;
  const replay = getPrIdempotency(succession.workspace_id, idempotencyKey);
  if (replay) {
    const outcome = replayPrOperation(succession.workspace_id, replay);
    if (outcome.lineage.slug !== member.lineage_slug ||
        outcome.observation.repo_id !== observed.facts.repoId ||
        outcome.observation.pr_number !== observed.facts.number) {
      throw new Error(`Legacy succession ${succession.id} child replay does not match member ${member.position}`);
    }
    const persisted = persistIngest(succession, token, member, outcome);
    await importObservedConversation(
      succession.workspace_id,
      outcome.lineage,
      outcome.observation,
      observed.actor,
    );
    assertLease(succession.id, token);
    return persisted;
  }

  const owner = getLiveLineagePrByNumber(
    succession.workspace_id,
    observed.facts.repoId,
    observed.facts.number,
  );
  let operation: "create" | "attach" = "create";
  if (owner) {
    if (owner.slug !== member.lineage_slug) {
      throw new LegacySuccessionError(
        409,
        "pull_request_owned",
        `${observed.facts.repo}#${observed.facts.number} is already reviewed at ` +
          `${config.baseUrl}/${succession.workspace_id}/r/${owner.slug}.`,
      );
    }
    operation = "attach";
  } else {
    const named = getLineage(succession.workspace_id, member.lineage_slug);
    if (named) {
      const relation = getLineagePr(succession.workspace_id, named.id);
      const detail = relation
        ? `${relation.repo}#${relation.pr_number}`
        : "a branch-first review with no pull request";
      throw new LegacySuccessionError(
        409,
        "review_slug_taken",
        `Review slug "${member.lineage_slug}" already names ${detail} at ` +
          `${config.baseUrl}/${succession.workspace_id}/r/${member.lineage_slug}.`,
      );
    }
  }

  const body = {
    repo: observed.facts.repo.toLowerCase(),
    number: observed.facts.number,
    slug: member.lineage_slug,
    title: observed.facts.title,
    projects: legacySuccessionProjects(succession),
  };
  const outcome = ingestPullRequest({
    workspaceId: succession.workspace_id,
    userId: succession.created_by_user_id,
    keyId: succession.created_by_key_id,
    operation,
    idempotencyKey,
    requestHash: prRequestHash(operation, operation === "attach" ? member.lineage_slug : null,
      operation === "attach"
        ? { repo: observed.facts.repo.toLowerCase(), number: observed.facts.number }
        : body),
    slug: member.lineage_slug,
    title: observed.facts.title.trim().slice(0, 80) || member.lineage_slug,
    projects: operation === "create" ? legacySuccessionProjects(succession) : [],
    actor: observed.actor,
    facts: observed.facts,
    legacyOwnsSlug: (slug) => getReviewExists(succession.workspace_id, slug),
  });
  const persisted = persistIngest(succession, token, member, outcome);
  await importObservedConversation(
    succession.workspace_id,
    outcome.lineage,
    outcome.observation,
    observed.actor,
  );
  assertLease(succession.id, token);
  return persisted;
}

function getReviewExists(workspaceId: string, slug: string): boolean {
  return db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM reviews WHERE workspace_id = ? AND slug = ?",
  ).get(workspaceId, slug) !== null;
}

function completedRevision(job: ReviewCaptureJobRow | null): string | null {
  return job?.state === "completed" ? job.revision_id : null;
}

function releaseWaiting(id: string, token: string, progressed: boolean): void {
  db.run(
    "UPDATE review_legacy_successions SET state = 'pending', " +
      "attempts = CASE WHEN ? = 0 AND attempts > 0 THEN attempts - 1 ELSE attempts END, " +
      "lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [progressed ? 1 : 0, Date.now(), id, token],
  );
}

function completeSingle(id: string, token: string, lineageId: string): void {
  const changed = db.run(
    "UPDATE review_legacy_successions SET state = 'completed', result_lineage_id = ?, failure = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [lineageId, Date.now(), id, token],
  ).changes;
  if (changed !== 1) throw new Error(`Legacy succession ${id} lost its lease before completion`);
}

function completeStack(id: string, token: string, stackId: string): void {
  const changed = db.run(
    "UPDATE review_legacy_successions SET state = 'completed', result_stack_id = ?, failure = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [stackId, Date.now(), id, token],
  ).changes;
  if (changed !== 1) throw new Error(`Legacy succession ${id} lost its lease before completion`);
}

function fail(id: string, token: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  db.run(
    "UPDATE review_legacy_successions SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [message.slice(0, MAX_FAILURE), Date.now(), id, token],
  );
}

/** Run one claimed succession until it completes or reaches external work. */
export async function runLegacySuccession(id: string): Promise<void> {
  const claim = claimLegacySuccession(id, Date.now());
  if (claim.kind !== "claimed") return;
  const token = claim.row.lease_token;
  if (!token) throw new Error(`Legacy succession ${id} was claimed without a token`);
  let lost = false;
  const beat = setInterval(() => {
    try {
      if (!heartbeat(id, token)) lost = true;
    } catch (error) {
      console.error(`[seer] legacy succession ${id} heartbeat failed:`, error);
    }
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  try {
    let succession = claim.row;
    let members = listLegacySuccessionMembers(id);
    let waiting = false;
    let progressed = false;

    for (let index = 0; index < members.length; index++) {
      let member = members[index]!;
      if (!member.lineage_id) {
        member = await ingestMember(succession, token, member);
        progressed = true;
        if (lost) throw new Error(`Legacy succession ${id} lost its lease while observing a pull request`);
      }
      if (!member.lineage_id) throw new Error(`Legacy succession ${id} member ${member.position} has no lineage after ingestion`);
      const memberLineage = getLineage(succession.workspace_id, member.lineage_slug);
      if (!memberLineage || memberLineage.id !== member.lineage_id) {
        throw new Error(`Legacy succession ${id} member ${member.position} lost its lineage`);
      }
      // Idempotent on every resume. If the process died after persisting the lineage but
      // before its Project joins, the next pass closes that gap.
      attachProjects(succession, memberLineage);

      if (succession.kind === "single") {
        completeSingle(id, token, member.lineage_id);
        return;
      }

      if (!member.revision_id) {
        const job = member.capture_job_id
          ? getCaptureJob(succession.workspace_id, member.capture_job_id)
          : null;
        if (job?.state === "failed") {
          throw new LegacySuccessionError(
            409,
            "capture_failed",
            job.failure ?? `The capture for "${member.lineage_slug}" failed.`,
          );
        }
        const revisionId = completedRevision(job);
        if (revisionId) {
          member = updateMember(id, token, member.position, { revisionId, accountId: null });
          progressed = true;
        } else {
          waiting = true;
          continue;
        }
      }

      let revision = member.revision_id
        ? getRevisionById(succession.workspace_id, member.revision_id)
        : null;
      if (!revision || revision.lineage_id !== member.lineage_id) {
        throw new Error(`Legacy succession ${id} member ${member.position} names a missing exact revision`);
      }
      let account = latestAccountForRevision(succession.workspace_id, revision.id);
      if (!account) {
        const request = getWitnessRequestForRevision(succession.workspace_id, revision.id);
        if (request && isWitnessRequestSuperseded(request.id)) {
          const lineage = getLineage(succession.workspace_id, member.lineage_slug);
          const newer = lineage?.latest_revision && lineage.latest_revision > revision.revision
            ? db.query<{ id: string }, [string, number]>(
                "SELECT id FROM review_revisions WHERE lineage_id = ? AND revision = ?",
              ).get(lineage.id, lineage.latest_revision)
            : null;
          if (!newer) {
            throw new LegacySuccessionError(
              409,
              "witness_superseded",
              `The exact witness request for "${member.lineage_slug}" was superseded before it published an account.`,
            );
          }
          member = updateMember(id, token, member.position, {
            captureJobId: null,
            revisionId: newer.id,
            accountId: null,
          });
          progressed = true;
          revision = getRevisionById(succession.workspace_id, newer.id);
          account = revision ? latestAccountForRevision(succession.workspace_id, revision.id) : null;
        }
      }
      if (!account) {
        waiting = true;
        continue;
      }
      if (member.account_id !== account.id) {
        member = updateMember(id, token, member.position, { accountId: account.id });
        progressed = true;
      }
      members[index] = member;
    }

    if (waiting) {
      // A sweep that merely rechecks unfinished external work is not another attempt.
      // Keep one count only when this run retained new workflow progress.
      releaseWaiting(id, token, progressed);
      return;
    }

    succession = assertLease(id, token);
    members = listLegacySuccessionMembers(id);
    const normalized = normalizeInferredPinnedChain(
      succession.workspace_id,
      members.map((member) => {
        if (!member.revision_id || !member.account_id) {
          throw new Error(`Legacy succession ${id} reached stack creation before member ${member.position} was exact`);
        }
        return {
          lineageSlug: member.lineage_slug,
          revisionId: member.revision_id,
          accountId: member.account_id,
        };
      }),
    );
    const firstLineage = getLineage(succession.workspace_id, members[0]!.lineage_slug);
    if (!firstLineage) throw new Error(`Legacy succession ${id} lost its first lineage`);
    const projects = legacySuccessionProjects(succession);
    const requestBody = {
      slug: succession.target_slug,
      title: firstLineage.title,
      projects,
      members: members.map((member) => member.lineage_slug),
      source: normalized.source,
    };
    const created = createStack({
      workspaceId: succession.workspace_id,
      userId: succession.created_by_user_id,
      keyId: succession.created_by_key_id,
      idempotencyKey: `legacy-successor:${succession.id}:stack`,
      requestHash: stackRequestHash("create", null, requestBody),
      slug: succession.target_slug,
      title: firstLineage.title,
      projects,
      actor: { kind: "anonymous" },
      normalized,
      legacyOwnsSlug: (slug) => getReviewExists(succession.workspace_id, slug),
    });
    completeStack(id, token, created.stack.id);
  } catch (error) {
    fail(id, token, error);
    const expected = error instanceof LegacySuccessionError || error instanceof PrIngestError ||
      error instanceof StackWriteError || error instanceof GithubError || error instanceof GithubAppRefusal;
    if (!expected) console.error(`[seer] legacy succession ${id} failed:`, error);
  } finally {
    clearInterval(beat);
  }
}

const lanes = new Map<string, Promise<void>>();

/** Schedule one exact workflow. It is never a generic claim-any endpoint. */
export function scheduleLegacySuccession(id: string): void {
  if (lanes.has(id)) return;
  const run = runLegacySuccession(id)
    .catch((error) => console.error(`[seer] legacy succession ${id} lane failed:`, error))
    .finally(() => lanes.delete(id));
  lanes.set(id, run);
}

/** Test seam: wait only for work this process started. */
export async function settleLegacySuccessions(): Promise<void> {
  while (lanes.size > 0) await Promise.all([...lanes.values()]);
}

/** Wake every pending stack succession that names this lineage. */
export function wakeLegacySuccessions(lineageId: string): number {
  const ids = db.query<{ id: string }, [string]>(
    "SELECT DISTINCT s.id FROM review_legacy_successions s " +
      "JOIN review_legacy_succession_members m ON m.succession_id = s.id " +
      "WHERE m.lineage_id = ? AND s.state = 'pending'",
  ).all(lineageId);
  for (const row of ids) scheduleLegacySuccession(row.id);
  return ids.length;
}

/** Release expired leases and schedule every pending workflow. */
export function recoverLegacySuccessions(now: number = Date.now()): number {
  const released = db.run(
    "UPDATE review_legacy_successions SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE state = 'running' AND lease_expires_at <= ?",
    [now, now],
  ).changes;
  for (const row of db.query<{ id: string }, []>(
    "SELECT id FROM review_legacy_successions WHERE state = 'pending' ORDER BY updated_at ASC, id ASC",
  ).all()) {
    scheduleLegacySuccession(row.id);
  }
  return released;
}

let sweep: ReturnType<typeof setInterval> | null = null;

export function startLegacySuccessionSweep(intervalMs: number = LEGACY_SUCCESSION_SWEEP_MS): void {
  if (sweep) return;
  sweep = setInterval(() => {
    try {
      recoverLegacySuccessions();
    } catch (error) {
      console.error("[seer] legacy succession sweep failed:", error);
    }
  }, intervalMs);
  (sweep as unknown as { unref?: () => void }).unref?.();
}

export function stopLegacySuccessionSweep(): void {
  if (!sweep) return;
  clearInterval(sweep);
  sweep = null;
}
