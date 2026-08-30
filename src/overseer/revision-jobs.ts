// The capture a pull request queues, and the one lane it runs in.
//
// A source revision is evidence and must be immutable; getting one is a job that calls
// GitHub, writes blobs, and can fail. Those are different things, so they are different
// rows. A pending or failed job is visible and retryable and is NOT a revision — nothing
// reads it as one, and a lineage whose only job failed has no revision at all rather than
// an empty one.
//
// Two guarantees run through everything below.
//
// The job never reroutes. It stores the exact actor it was queued with and reopens that
// one, so a capture queued through a member's connected account cannot quietly complete
// through an installation, or through anonymity, and a capture queued for one repository
// and ref cannot complete against another.
//
// One actor runs one capture at a time. The lane is the stored `actor_key`; the lease is
// what makes that true across processes rather than only inside one, and what lets a
// second process pick up work a killed one abandoned — without stealing work a healthy
// process is still doing.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { hashKey, RCJ_ID_RE, tinyId } from "../ids";
import { getStageCapture } from "../stage/db";
import { captureSource, StageCaptureError } from "../stage/source";
import { GithubError } from "./github";
import { openReadSession, type ReadActor } from "./github-app";
import { readableWorkspaces, softNotFound } from "./read";
import {
  appendSourceRevision,
  carryRevisionReads,
  getRevision,
  previousRevision,
  storeRevisionMovement,
  supersedeOpenWitnessRequests,
  type ReviewLineageRow,
} from "./revision-db";
import { revisionCodeDelta } from "./revision-delta";
import { recoverStackRefreshJobs } from "./stack-jobs";
import {
  enrichWebhookObservation,
  getLineagePr,
  getObservation,
  getSourceByTuple,
  latestCapturedObservation,
  observationIsAfter,
  observationView,
  readActorOf,
  type ReviewPrObservationRow,
  type StoredActor,
} from "./revision-pr";

// ---- rows ----

export interface ReviewCaptureJobRow extends StoredActor {
  id: string;
  workspace_id: string;
  lineage_id: string;
  slug: string;
  observation_id: string;
  state: "pending" | "running" | "failed" | "completed";
  actor_key: string;
  attempts: number;
  failure: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  capture_id: string | null;
  revision_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * How long a claim stands without a heartbeat.
 *
 * A capture of a large branch can spend minutes on blob requests, and each of those has
 * its own twenty-second timeout, so the lease is renewed on a timer rather than sized to
 * the whole job: a lease long enough to cover the worst capture would also be long enough
 * to strand a killed process's work for that long.
 */
export const CAPTURE_LEASE_MS = 60_000;
export const CAPTURE_HEARTBEAT_MS = 20_000;

/** Bounded automatic recovery. A lease that expires is picked up again, but not
 *  forever: a job that has burned this many attempts is failed with what it said, so a
 *  capture that kills its worker every time cannot spend a credential in a loop. An
 *  explicit retry starts the count again. */
export const MAX_CAPTURE_ATTEMPTS = 5;

/** The same ceiling the witness failure text carries, for the same reason: a stored
 *  failure is rendered to a reader and must not be a stack trace. */
export const MAX_JOB_FAILURE_TEXT = 600;

// ---- reads ----

export function getCaptureJob(workspaceId: string, id: string): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string, string]>(
    "SELECT * FROM review_capture_jobs WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

function getCaptureJobById(id: string): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string]>(
    "SELECT * FROM review_capture_jobs WHERE id = ?",
  ).get(id);
}

export function getCaptureJobForObservation(
  workspaceId: string,
  lineageId: string,
  observationId: string,
): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string, string, string]>(
    "SELECT * FROM review_capture_jobs WHERE workspace_id = ? AND lineage_id = ? AND observation_id = ?",
  ).get(workspaceId, lineageId, observationId);
}

/**
 * A job already queued or running for this exact base/head pair, whatever observation
 * triggered it.
 *
 * The pair and not the observation, because one moving pull request produces several
 * observations of the same bytes: a webhook's null-merge-base reading, the complete reading
 * a refresh takes through the relation's actor, the enriched reading a worker publishes,
 * and any of those again with a new title or draft flag. Each is a different row and only
 * one of them is worth a capture.
 */
export function openCaptureJobForPair(
  workspaceId: string,
  lineageId: string,
  baseSha: string,
  headSha: string,
): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string, string, string, string]>(
    "SELECT j.* FROM review_capture_jobs j JOIN review_pr_observations o ON o.id = j.observation_id " +
      "WHERE j.workspace_id = ? AND j.lineage_id = ? AND j.state IN ('pending','running') " +
      "AND o.base_sha = ? AND o.head_sha = ? ORDER BY j.created_at ASC, j.id ASC LIMIT 1",
  ).get(workspaceId, lineageId, baseSha, headSha);
}

/** The newest job for this pair whatever became of it, which is what a drift notice
 *  reports: a failed capture is the answer to "why is the newer source not readable". */
export function latestCaptureJobForPair(
  workspaceId: string,
  lineageId: string,
  baseSha: string,
  headSha: string,
): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string, string, string, string]>(
    "SELECT j.* FROM review_capture_jobs j JOIN review_pr_observations o ON o.id = j.observation_id " +
      "WHERE j.workspace_id = ? AND j.lineage_id = ? AND o.base_sha = ? AND o.head_sha = ? " +
      "ORDER BY j.created_at DESC, j.id DESC LIMIT 1",
  ).get(workspaceId, lineageId, baseSha, headSha);
}

/**
 * Point a job at a better reading of the same source.
 *
 * Two callers, and the difference between them is the guard. A refresh adopts a PENDING
 * job — one nobody is capturing — so the complete observation it just took replaces the
 * webhook trigger that carried no merge base. A worker adopts its OWN RUNNING job, under
 * its lease, so the observation it enriched is the one its capture is recorded against;
 * without the lease in the WHERE clause a refresh could rewrite a running job's source
 * underneath the worker producing it.
 */
export function adoptCaptureJobObservation(input: {
  jobId: string;
  observationId: string;
  now: number;
  leaseToken: string | null;
}): boolean {
  if (input.leaseToken === null) {
    return db.run(
      "UPDATE review_capture_jobs SET observation_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
      [input.observationId, input.now, input.jobId],
    ).changes > 0;
  }
  return db.run(
    "UPDATE review_capture_jobs SET observation_id = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?",
    [input.observationId, input.now, input.jobId, input.leaseToken],
  ).changes > 0;
}

export function listCaptureJobs(workspaceId: string, lineageId: string): ReviewCaptureJobRow[] {
  return db.query<ReviewCaptureJobRow, [string, string]>(
    "SELECT * FROM review_capture_jobs WHERE workspace_id = ? AND lineage_id = ? ORDER BY created_at ASC, id ASC",
  ).all(workspaceId, lineageId);
}

// ---- writes ----

export interface CreateCaptureJobInput {
  workspaceId: string;
  lineageId: string;
  slug: string;
  observationId: string;
  actor: ReadActor;
  actorKey: string;
  now: number;
}

/** Not a transaction: the only caller is the ingestion transaction, which has to commit
 *  this with the relation, the observation and the idempotency row or with none of them. */
export function createCaptureJob(input: CreateCaptureJobInput): ReviewCaptureJobRow {
  const id = tinyId("rcj");
  const actor = input.actor;
  db.run(
    "INSERT INTO review_capture_jobs (id, workspace_id, lineage_id, slug, observation_id, state, actor_kind, installation_id, user_id, credential_id, actor_key, attempts, failure, lease_token, lease_expires_at, capture_id, revision_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)",
    [id, input.workspaceId, input.lineageId, input.slug, input.observationId,
      actor.kind,
      actor.kind === "installation" ? actor.installationId : null,
      actor.kind === "user" ? actor.userId : null,
      actor.kind === "user" ? actor.credentialId : null,
      input.actorKey, input.now, input.now],
  );
  return getCaptureJobById(id)!;
}

/**
 * What one attempt to claim this lane found.
 *
 * Three answers rather than one null, because the three mean different things to whoever
 * asked. `busy` says another process is working this actor and the lane should be looked
 * at again later; `exhausted` says the head of the lane was failed and the jobs BEHIND it
 * are still waiting; `empty` is the only one that means there is nothing to do. Collapsing
 * them into null is how pending work gets stranded with a 202 already returned to its
 * caller and nothing left that would ever look at it again.
 */
export type CaptureClaim =
  | { kind: "claimed"; job: ReviewCaptureJobRow }
  | { kind: "busy" }
  | { kind: "exhausted"; jobId: string }
  | { kind: "empty" };

/**
 * Claim the next job for one actor, or say why not.
 *
 * Three steps in one transaction, and the order matters. Expired leases are released
 * first, so an abandoned job is claimable rather than blocking its own lane forever. Then
 * a HEALTHY running job for this actor stops the claim — that is the one-capture-per-actor
 * rule, and it holds across processes because both are asking the same database. Only then
 * is the oldest pending job taken.
 */
export const claimNextCaptureJob = db.transaction((actorKey: string, now: number): CaptureClaim => {
  db.run(
    "UPDATE review_capture_jobs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE actor_key = ? AND state = 'running' AND lease_expires_at <= ?",
    [now, actorKey, now],
  );
  const healthy = db.query<{ id: string }, [string, number]>(
    "SELECT id FROM review_capture_jobs WHERE actor_key = ? AND state = 'running' AND lease_expires_at > ? LIMIT 1",
  ).get(actorKey, now);
  if (healthy) return { kind: "busy" };

  const next = db.query<ReviewCaptureJobRow, [string]>(
    "SELECT * FROM review_capture_jobs WHERE actor_key = ? AND state = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
  ).get(actorKey);
  if (!next) return { kind: "empty" };
  if (next.attempts >= MAX_CAPTURE_ATTEMPTS) {
    db.run(
      "UPDATE review_capture_jobs SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      [`The pinned capture was attempted ${next.attempts} times without completing. Retry it once the cause is fixed.`, now, next.id],
    );
    return { kind: "exhausted", jobId: next.id };
  }
  db.run(
    "UPDATE review_capture_jobs SET state = 'running', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'",
    [tinyId("lse"), now + CAPTURE_LEASE_MS, now, next.id],
  );
  return { kind: "claimed", job: getCaptureJobById(next.id)! };
}) as (actorKey: string, now: number) => CaptureClaim;

/** Renew a lease this worker still holds. False means it lost it — the job has been
 *  taken over, retried, or completed by somebody else, and this worker must stop. */
export function heartbeatCaptureJob(jobId: string, leaseToken: string, now: number = Date.now()): boolean {
  return db.run(
    "UPDATE review_capture_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?",
    [now + CAPTURE_LEASE_MS, now, jobId, leaseToken],
  ).changes > 0;
}

export class CaptureJobError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CaptureJobError";
  }
}

/** Release the lane and record what a reader is shown. Only the lease holder may. */
export function failCaptureJob(jobId: string, leaseToken: string, failure: string, now: number = Date.now()): void {
  db.run(
    "UPDATE review_capture_jobs SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [failure.slice(0, MAX_JOB_FAILURE_TEXT), now, jobId, leaseToken],
  );
}

export interface CompletedCapture {
  job: ReviewCaptureJobRow;
  revisionId: string;
  revision: number;
  /** False when this exact source tuple had already published a revision, so the job
   *  completed by pointing at it rather than by appending a second one. */
  appended: boolean;
  /** True when this result was of source the lineage has already moved past, so it
   *  completed by pointing at the newer revision without appending behind it. */
  superseded: boolean;
  /** How many members' reads the append carried forward on exact equivalence. */
  carried: number;
}

/**
 * One transaction: the source revision, its pending witness request, the immutable source
 * association, and the job's completed state.
 *
 * Everything it depends on is rechecked here rather than trusted from before the capture,
 * because the capture took minutes: the lease must still be this worker's, the relation
 * must still name this pull request, and the source tuple must still be unpublished. The
 * retained objects were written before this ran, exactly as stage capture does it, so a
 * revision is only ever visible after the bytes it names are.
 */
export const completeCaptureJob = db.transaction((input: {
  jobId: string;
  leaseToken: string;
  captureId: string;
}): CompletedCapture => {
  const job = getCaptureJobById(input.jobId);
  if (!job) throw new Error(`Capture job ${input.jobId} disappeared before completion`);
  if (job.state === "completed" && job.revision_id) {
    const revision = db.query<{ revision: number }, [string]>("SELECT revision FROM review_revisions WHERE id = ?").get(job.revision_id);
    return { job, revisionId: job.revision_id, revision: revision?.revision ?? 0, appended: false, superseded: false, carried: 0 };
  }
  if (job.state !== "running" || job.lease_token !== input.leaseToken) {
    throw new CaptureJobError(409, "This capture job is no longer held by this worker.");
  }
  const observation = getObservation(job.workspace_id, job.observation_id);
  if (!observation) throw new Error(`Capture job ${job.id} names a missing observation`);
  // Only an observation somebody compared can be a source, and only such an observation
  // can have queued a job — so this is corruption rather than a state to handle.
  const mergeBaseSha = observation.merge_base_sha;
  if (mergeBaseSha === null) {
    throw new Error(`Capture job ${job.id} names an observation with no merge base`);
  }
  const relation = getLineagePr(job.workspace_id, job.lineage_id);
  if (!relation || relation.repo_id !== observation.repo_id || relation.pr_number !== observation.pr_number) {
    throw new CaptureJobError(409, "This review no longer names the pull request this capture was queued for.");
  }
  const lineage = db.query<ReviewLineageRow, [string]>(
    "SELECT * FROM review_lineages WHERE id = ?",
  ).get(job.lineage_id);
  if (!lineage) throw new Error(`Capture job ${job.id} names a missing lineage`);

  const now = Date.now();
  const held = getSourceByTuple(job.lineage_id, observation.base_sha, observation.head_sha, mergeBaseSha);
  if (held) {
    // Another job already published these exact bytes. Completing by pointing at that
    // revision is the whole of the source-tuple guarantee: two capture results, one
    // source revision.
    db.run(
      "UPDATE review_capture_jobs SET state = 'completed', failure = NULL, lease_token = NULL, lease_expires_at = NULL, capture_id = ?, revision_id = ?, updated_at = ? WHERE id = ?",
      [input.captureId, held.revision_id, now, job.id],
    );
    const revision = db.query<{ revision: number }, [string]>("SELECT revision FROM review_revisions WHERE id = ?").get(held.revision_id);
    return { job: getCaptureJobById(job.id)!, revisionId: held.revision_id, revision: revision?.revision ?? 0, appended: false, superseded: false, carried: 0 };
  }

  // Order, against the observation the newest revision was captured from and under the
  // same three keys every other decision uses. A capture of source the lineage has already
  // moved past is a fact about an older reading, and appending it would put revision 3
  // behind revision 2 in the one place a reader trusts to be chronological. It completes,
  // because the work really did finish, and it points at the revision that overtook it.
  const incumbent = latestCapturedObservation(job.workspace_id, job.lineage_id);
  if (incumbent && !observationIsAfter(observation, incumbent)) {
    const newest = lineage.latest_revision === null
      ? null
      : getRevision(job.workspace_id, lineage.slug, lineage.latest_revision);
    if (!newest) throw new Error(`Capture job ${job.id} was overtaken by a revision that is not readable`);
    db.run(
      "UPDATE review_capture_jobs SET state = 'completed', failure = NULL, lease_token = NULL, lease_expires_at = NULL, capture_id = ?, revision_id = ?, updated_at = ? WHERE id = ?",
      [input.captureId, newest.id, now, job.id],
    );
    return {
      job: getCaptureJobById(job.id)!,
      revisionId: newest.id,
      revision: newest.revision,
      appended: false,
      superseded: true,
      carried: 0,
    };
  }

  const inventory = getStageCapture(input.captureId, job.workspace_id);
  if (!inventory) throw new Error(`Capture job ${job.id} completed with no retained capture ${input.captureId}`);
  const appended = appendSourceRevision({
    workspaceId: job.workspace_id,
    lineage,
    capture: {
      id: inventory.capture.id,
      repo: inventory.capture.repo,
      repoId: inventory.capture.repo_id,
      branch: inventory.capture.branch,
      baseRef: inventory.capture.base_ref,
      sourceHeadSha: inventory.capture.source_head_sha,
      baseTipSha: inventory.capture.base_tip_sha,
      mergeBaseSha: inventory.capture.merge_base_sha,
    },
    // A pull request nobody's builder initiated has no intent to state, and inventing an
    // empty one would make "the builder said nothing" indistinguishable from "there was
    // no builder". A capture that does carry a packet keeps it.
    builder: inventory.builder
      ? {
          intent: inventory.builder.intent,
          context: inventory.builder.context,
          agent: { name: inventory.builder.agent_name, model: inventory.builder.agent_model },
          userId: inventory.builder.user_id,
          keyId: inventory.builder.key_id,
        }
      : null,
  });
  db.run(
    "INSERT INTO review_revision_sources (revision_id, workspace_id, lineage_id, observation_id, base_tip_sha, source_head_sha, merge_base_sha, attached_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [appended.revision.id, job.workspace_id, job.lineage_id, observation.id,
      observation.base_sha, observation.head_sha, mergeBaseSha, now],
  );

  // Personal handling, carried only where the retained bytes prove the change is the same
  // change. Both captures are already stored, so this is two SQLite reads and arithmetic:
  // no blob is fetched and GitHub is not called, which is what lets it live inside the
  // transaction the revision is published in.
  let carried = 0;
  const previous = previousRevision(job.workspace_id, job.lineage_id, appended.revision.revision);
  const previousInventory = previous ? getStageCapture(previous.capture_id, job.workspace_id) : null;
  if (previous && previousInventory) {
    const delta = revisionCodeDelta(previousInventory, inventory);
    // Written once, here, beside the revision it describes: the movement line and every
    // later read that carries forward read these rows rather than the two inventories.
    storeRevisionMovement({
      workspaceId: job.workspace_id,
      lineageId: job.lineage_id,
      previousRevisionId: previous.id,
      revisionId: appended.revision.id,
      counts: delta.counts,
      equivalences: delta.equivalences,
      now,
    });
    carried = carryRevisionReads({
      workspaceId: job.workspace_id,
      lineageId: job.lineage_id,
      sourceRevisionId: previous.id,
      targetRevisionId: appended.revision.id,
      equivalences: delta.equivalences,
      now,
    });
  }
  supersedeOpenWitnessRequests(job.workspace_id, job.lineage_id, appended.revision.id, appended.revision.revision, now);

  db.run(
    "UPDATE review_capture_jobs SET state = 'completed', failure = NULL, lease_token = NULL, lease_expires_at = NULL, capture_id = ?, revision_id = ?, updated_at = ? WHERE id = ?",
    [input.captureId, appended.revision.id, now, job.id],
  );
  return {
    job: getCaptureJobById(job.id)!,
    revisionId: appended.revision.id,
    revision: appended.revision.revision,
    appended: true,
    superseded: false,
    carried,
  };
}) as (input: { jobId: string; leaseToken: string; captureId: string }) => CompletedCapture;

/**
 * A claimed job whose source is already published, finished without spending anything.
 *
 * The guard runs before the first GitHub request rather than after the capture, which is
 * the whole point: a retried job, or a sibling queued from a second observation of the same
 * bytes, would otherwise pay for a full capture and then discover at completion that the
 * lane job ahead of it had already published exactly this revision.
 */
export const convergeCaptureJob = db.transaction((input: {
  jobId: string;
  leaseToken: string;
  revisionId: string;
  captureId: string | null;
}): void => {
  db.run(
    "UPDATE review_capture_jobs SET state = 'completed', failure = NULL, lease_token = NULL, lease_expires_at = NULL, capture_id = ?, revision_id = ?, updated_at = ? " +
      "WHERE id = ? AND state = 'running' AND lease_token = ?",
    [input.captureId, input.revisionId, Date.now(), input.jobId, input.leaseToken],
  );
}) as (input: { jobId: string; leaseToken: string; revisionId: string; captureId: string | null }) => void;

// ---- running one job ----

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the exact stored actor, capture the pinned source, and commit the result.
 *
 * The stage capture API is untouched: this hands it an internal resolved source, so it
 * confirms the repository and then spends its metadata calls on the compare, the two
 * pinned trees and the pinned diff instead of resolving two branch names that may have
 * moved since the observation.
 */
export async function runCaptureJob(job: ReviewCaptureJobRow): Promise<void> {
  const leaseToken = job.lease_token;
  if (!leaseToken) throw new Error(`Capture job ${job.id} was run without a lease`);
  // The heartbeat's answer is acted on rather than discarded. False means another process
  // recovered this job's expired lease and is capturing the same pinned source through the
  // same actor; carrying on regardless is what turns "one capture per actor" into two
  // workers spending one credential against one rate budget.
  let lost = false;
  const beat = setInterval(() => {
    try {
      if (!heartbeatCaptureJob(job.id, leaseToken)) lost = true;
    } catch (err) {
      console.error(`[seer] capture job ${job.id} heartbeat failed:`, err);
    }
  }, CAPTURE_HEARTBEAT_MS);
  // Never keeps the process alive on its own: a heartbeat is only meaningful while the
  // capture it accompanies is running.
  (beat as unknown as { unref?: () => void }).unref?.();
  try {
    let observation = getObservation(job.workspace_id, job.observation_id);
    if (!observation) throw new Error(`Capture job ${job.id} names a missing observation`);
    const actor = readActorOf(job);

    /**
     * Finish without capturing when these exact bytes are already a revision.
     *
     * Asked before the first GitHub request rather than after the capture, which is the
     * whole point: a retry, or a sibling job queued from a second observation of the same
     * source, would otherwise pay for a full capture and only then discover that the lane
     * job ahead of it had already published exactly this revision.
     */
    const convergeIfPublished = (): boolean => {
      const mergeBase = observation!.merge_base_sha;
      if (mergeBase === null) return false;
      const published = getSourceByTuple(job.lineage_id, observation!.base_sha, observation!.head_sha, mergeBase);
      if (!published) return false;
      const revision = db.query<{ capture_id: string }, [string]>(
        "SELECT capture_id FROM review_revisions WHERE id = ?",
      ).get(published.revision_id);
      convergeCaptureJob({ jobId: job.id, leaseToken, revisionId: published.revision_id, captureId: revision?.capture_id ?? null });
      return true;
    };
    /**
     * Finish without capturing when the lineage has already moved past this source.
     *
     * The same three-key order completion uses, asked BEFORE the first GitHub request:
     * a failed job retried after a later push already published, or a sibling that
     * lost the race, would otherwise spend a whole capture — up to the blob budget — to
     * be told at completion that it was superseded. It points at the revision that
     * overtook it, exactly as completion would have.
     */
    const convergeIfOvertaken = (): boolean => {
      const incumbent = latestCapturedObservation(job.workspace_id, job.lineage_id);
      if (!incumbent || observationIsAfter(observation!, incumbent)) return false;
      const lineage = db.query<ReviewLineageRow, [string]>(
        "SELECT * FROM review_lineages WHERE id = ?",
      ).get(job.lineage_id);
      const newest = lineage && lineage.latest_revision !== null
        ? getRevision(job.workspace_id, lineage.slug, lineage.latest_revision)
        : null;
      if (!newest) return false;
      convergeCaptureJob({ jobId: job.id, leaseToken, revisionId: newest.id, captureId: newest.capture_id });
      return true;
    };
    if (convergeIfPublished() || convergeIfOvertaken()) return;

    const session = await openReadSession(
      job.workspace_id,
      actor,
      observation.repo,
      observation.repo_id,
    );

    // A webhook trigger carries no merge base, so the third leg of the source tuple is
    // established here — by comparing the delivery's OWN pinned base and head through the
    // relation's stored actor. Deliberately not `getPull`: asking GitHub what the pull
    // request looks like now would let a push that landed while this job waited replace the
    // source the delivery was about, and the revision would be evidence for bytes no
    // observation ever recorded.
    if (observation.merge_base_sha === null) {
      if (!session.client.compare) {
        throw new CaptureJobError(409, "The routed GitHub client cannot compare commits, so this delivery's merge base cannot be established.");
      }
      const comparison = await session.client.compare(observation.repo, observation.base_sha, observation.head_sha);
      const enriched = enrichWebhookObservation({
        workspaceId: job.workspace_id,
        lineageId: job.lineage_id,
        jobId: job.id,
        leaseToken,
        actor,
        facts: {
          repoId: observation.repo_id,
          repo: observation.repo,
          number: observation.pr_number,
          title: observation.title,
          state: observation.state,
          merged: observation.merged === 1,
          draft: observation.draft === 1,
          baseRef: observation.base_ref,
          baseSha: observation.base_sha,
          headRef: observation.head_ref,
          headSha: observation.head_sha,
          mergeBaseSha: comparison.merge_base_commit.sha,
          githubUpdatedAt: observation.github_updated_at,
        },
      });
      if (!enriched.adopted) {
        throw new CaptureJobError(409, "This capture job's lease was taken over while its merge base was established, so its result was discarded.");
      }
      observation = enriched.observation;
    }
    const mergeBaseSha = observation.merge_base_sha;
    if (mergeBaseSha === null) throw new Error(`Capture job ${job.id} names an observation with no merge base`);
    // Asked again, because the enrichment above is the moment a webhook trigger first HAS
    // a source tuple to compare, and a refresh may have published exactly it in the
    // meantime.
    if (convergeIfPublished() || convergeIfOvertaken()) return;

    // Asked between the metadata phase and the blob pool, and once per object inside it.
    // Every heartbeat answer is acted on, and this one asks the database rather than
    // waiting for the timer: a lease taken over while the trees were being read stops
    // this worker before its first blob request, not after its thousandth.
    const checkpoint = (): void => {
      if (lost || !heartbeatCaptureJob(job.id, leaseToken)) {
        lost = true;
        throw new CaptureJobError(409, "This capture job's lease was taken over while it ran, so its capture was stopped.");
      }
    };

    const result = await captureSource(
      job.workspace_id,
      {
        slug: job.slug,
        repo: observation.repo,
        branch: observation.head_ref,
        baseRef: observation.base_ref,
      },
      {
        client: session.client,
        checkpoint,
        // Derived from the job id, so one job is one capture however many times a lease
        // changes hands: a recovered worker re-running the same job replays the stage
        // capture rather than retaining a second copy of the same bytes.
        idempotencyKey: `review-capture-job:${job.id}`,
        requestHash: hashKey(JSON.stringify({
          job: job.id,
          repo: observation.repo,
          repoId: observation.repo_id,
          baseTipSha: observation.base_sha,
          sourceHeadSha: observation.head_sha,
          mergeBaseSha,
        })),
        resolved: {
          repoId: observation.repo_id,
          repo: observation.repo,
          baseRef: observation.base_ref,
          baseTipSha: observation.base_sha,
          sourceHeadSha: observation.head_sha,
          mergeBaseSha,
        },
      },
    );
    // Checked here, at the one boundary where acting on it matters: everything past this
    // line writes. The final beat is the same question asked once more, so a lease lost
    // between the last tick and now is caught too — and when it still holds, asking
    // renews it across the completion transaction.
    if (lost || !heartbeatCaptureJob(job.id, leaseToken)) {
      throw new CaptureJobError(409, "This capture job's lease was taken over while it ran, so its result was discarded.");
    }
    completeCaptureJob({ jobId: job.id, leaseToken, captureId: result.captureId });
  } catch (err) {
    // Bounded, actionable, and the lane is released either way. A capture that failed is
    // a fact about this attempt; the lineage's completed revisions are untouched.
    const text = err instanceof StageCaptureError || err instanceof GithubError || err instanceof CaptureJobError
      ? message(err)
      : `The pinned capture failed: ${message(err)}`;
    try {
      failCaptureJob(job.id, leaseToken, text);
    } catch (failure) {
      console.error(`[seer] capture job ${job.id} could not record its failure:`, failure);
    }
    console.error(`[seer] capture job ${job.id} failed: ${text}`);
  } finally {
    clearInterval(beat);
  }
}

// ---- the actor lane ----

const lanes = new Map<string, Promise<void>>();

async function drainLane(actorKey: string): Promise<void> {
  for (;;) {
    const claim = claimNextCaptureJob(actorKey, Date.now());
    // A failed head of the lane is not the end of the lane. The jobs behind it were
    // queued by their own callers, each holding a 202 and a job URL, and exiting here
    // would leave them pending with nothing scheduled to look at them again.
    if (claim.kind === "exhausted") continue;
    if (claim.kind === "claimed") {
      await runCaptureJob(claim.job);
      continue;
    }
    // `busy` and `empty` both end this pass. Busy means another process holds this
    // actor's lease, and spinning here would burn a core waiting for a clock: the sweep
    // below is what comes back once that lease expires.
    return;
  }
}

/**
 * Run this actor's lane, once, after the transaction that queued the work committed.
 *
 * One promise per lane in this process, which is the in-process half of the
 * one-capture-per-actor rule; the lease in the database is the half that holds across
 * processes. Deliberately not awaited by the request: the caller already has its 202 and
 * its job URL, and a capture of a large branch is minutes of work.
 */
export function scheduleActorQueue(actorKey: string): void {
  if (lanes.has(actorKey)) return;
  const run = drainLane(actorKey)
    .catch((err) => {
      console.error(`[seer] capture lane ${actorKey} failed:`, err);
    })
    .finally(() => {
      lanes.delete(actorKey);
    });
  lanes.set(actorKey, run);
}

/** Test seam. Detached work is exactly the thing a test cannot observe, so the suite
 *  waits for every lane this process started — including lanes a completing lane
 *  started — rather than sleeping and hoping. */
export async function settleCaptureJobs(): Promise<void> {
  while (lanes.size > 0) await Promise.all([...lanes.values()]);
}

/**
 * Recover abandoned leases and re-drive every lane with pending work.
 *
 * A lease that nobody is renewing is released and re-queued; a HEALTHY lease is left
 * alone, because another container may be halfway through it and two workers spending one
 * credential on one capture is precisely what the lease exists to prevent.
 *
 * Run at startup AND on a timer. Startup alone was not enough: a lane this process left
 * because another held the lease, or because a caller queued work while the lane was
 * busy, has nothing else that would ever look at it again, so the pending job would wait
 * for the next ingest for that same actor or for a restart.
 */
export function recoverCaptureJobs(now: number = Date.now()): number {
  // The stack refresh jobs share this sweep: one timer, both tables.
  recoverStackRefreshJobs(now);
  const released = db.run(
    "UPDATE review_capture_jobs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE state = 'running' AND lease_expires_at <= ?",
    [now, now],
  ).changes;
  for (const row of db.query<{ actor_key: string }, []>(
    "SELECT DISTINCT actor_key FROM review_capture_jobs WHERE state = 'pending'",
  ).all()) {
    scheduleActorQueue(row.actor_key);
  }
  return released;
}

/** How often the sweep looks. One lease period: a claim cannot be abandoned for longer
 *  than that without the next sweep seeing it, and the sweep is two cheap queries. */
export const CAPTURE_SWEEP_MS = CAPTURE_LEASE_MS;

let sweep: ReturnType<typeof setInterval> | null = null;

/** Start the periodic recovery. Idempotent, so a second call does not double the rate. */
export function startCaptureSweep(intervalMs: number = CAPTURE_SWEEP_MS): void {
  if (sweep) return;
  sweep = setInterval(() => {
    try {
      recoverCaptureJobs();
    } catch (err) {
      console.error("[seer] capture job sweep failed:", err);
    }
  }, intervalMs);
  // A sweep is only meaningful while something else is keeping the process alive.
  (sweep as unknown as { unref?: () => void }).unref?.();
}

export function stopCaptureSweep(): void {
  if (!sweep) return;
  clearInterval(sweep);
  sweep = null;
}

// ---- views and routes ----

/**
 * Whether this job's result was of source the lineage had already moved past.
 *
 * Asked of the STORED rows rather than remembered from the run, so a job read back
 * a week later answers the same way. A job that has not finished points at no revision and
 * is not superseded — it is simply not finished. Convergence onto a revision published from
 * the same tuple is not supersession either: those are the same bytes, which is the point
 * of the source tuple. A webhook trigger overtaken before it was ever enriched carries no
 * merge base, so it is compared on the base and head it pinned.
 */
function jobSuperseded(job: ReviewCaptureJobRow, observation: ReviewPrObservationRow | null): boolean {
  if (!job.revision_id || !observation) return false;
  const source = db.query<{ base_tip_sha: string; source_head_sha: string; merge_base_sha: string }, [string]>(
    "SELECT base_tip_sha, source_head_sha, merge_base_sha FROM review_revision_sources WHERE revision_id = ?",
  ).get(job.revision_id);
  if (!source) return false;
  return source.base_tip_sha !== observation.base_sha ||
    source.source_head_sha !== observation.head_sha ||
    (observation.merge_base_sha !== null && source.merge_base_sha !== observation.merge_base_sha);
}

export function captureJobView(job: ReviewCaptureJobRow, observation: ReviewPrObservationRow | null): unknown {
  const revision = job.revision_id
    ? db.query<{ revision: number }, [string]>("SELECT revision FROM review_revisions WHERE id = ?").get(job.revision_id)
    : null;
  return {
    id: job.id,
    superseded: jobSuperseded(job, observation),
    workspace: job.workspace_id,
    lineage: job.lineage_id,
    slug: job.slug,
    state: job.state,
    attempts: job.attempts,
    failure: job.failure,
    actor: job.actor_kind,
    captureId: job.capture_id,
    revision: revision?.revision ?? null,
    revisionUrl: revision ? `${config.baseUrl}/${job.workspace_id}/r/${job.slug}/rev/${revision.revision}` : null,
    url: `${config.baseUrl}/api/review-capture-jobs/${job.id}`,
    retryUrl: `${config.baseUrl}/api/review-capture-jobs/${job.id}/retry`,
    reviewUrl: `${config.baseUrl}/${job.workspace_id}/r/${job.slug}`,
    pullRequest: observation ? observationView(observation) : null,
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
  };
}

function jobJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

/** GET /api/review-capture-jobs/:id — a member session or a workspace key. Every miss is
 *  the review soft 404, so a job id is not an oracle for what a workspace is reviewing. */
export function handleReadCaptureJob(req: Request, id: string): Response {
  if (!RCJ_ID_RE.test(id)) return softNotFound();
  for (const workspaceId of readableWorkspaces(req)) {
    const job = getCaptureJob(workspaceId, id);
    if (job) return jobJson(captureJobView(job, getObservation(workspaceId, job.observation_id)));
  }
  return softNotFound();
}

export type CaptureRetry =
  | { kind: "missing" }
  | { kind: "refused"; status: 403 | 409; error: string }
  | { kind: "retried"; job: ReviewCaptureJobRow };

/**
 * A failed attempt goes back in the queue — and only a failed one.
 *
 * One guarded statement inside one transaction. The state is part of the WHERE clause
 * rather than checked in JavaScript first, so a lane that claims the job between a read and
 * a write cannot have its fresh lease stripped, a completion that lands in between cannot
 * be flipped back to pending with its revision still attached, and a job that is merely
 * queued cannot have its attempt count reset to zero by anybody who asks — which is what
 * `MAX_CAPTURE_ATTEMPTS` exists to bound. A running job whose lease has expired is a
 * failed attempt nobody has recorded yet, and may be retried the same way.
 *
 * A job that reads through a member's connected account may only be retried by that
 * member: retrying is asking for their credential to be spent again, and a workspace is a
 * group. Nothing about any completed document changes; this creates a new attempt. The
 * caller schedules the lane after this commits.
 */
export const retryCaptureJob = db.transaction((
  workspaceId: string,
  jobId: string,
  userId: string,
  now: number = Date.now(),
): CaptureRetry => {
  const job = getCaptureJob(workspaceId, jobId);
  if (!job) return { kind: "missing" };
  if (job.actor_kind === "user" && job.user_id !== userId) {
    return { kind: "refused", status: 403, error: "This capture reads through another member's GitHub connection, which only they can spend." };
  }
  const changed = db.run(
    "UPDATE review_capture_jobs SET state = 'pending', failure = NULL, attempts = 0, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND (state = 'failed' OR (state = 'running' AND lease_expires_at <= ?))",
    [now, job.id, now],
  ).changes;
  if (changed === 0) {
    const held = getCaptureJob(workspaceId, jobId)!;
    return {
      kind: "refused",
      status: 409,
      error: held.state === "completed"
        ? "This capture already published a source revision."
        : held.state === "running"
          ? "This capture is running."
          : "This capture is queued.",
    };
  }
  return { kind: "retried", job: getCaptureJob(workspaceId, jobId)! };
}) as (workspaceId: string, jobId: string, userId: string, now?: number) => CaptureRetry;

/** POST /api/review-capture-jobs/:id/retry. Every miss is the review soft 404. */
export function handleRetryCaptureJob(req: Request, id: string): Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!RCJ_ID_RE.test(id)) return softNotFound();
  const retry = retryCaptureJob(auth.workspaceId, id, auth.userId);
  if (retry.kind === "missing") return softNotFound();
  if (retry.kind === "refused") return jobJson({ error: retry.error }, retry.status);
  scheduleActorQueue(retry.job.actor_key);
  return jobJson(captureJobView(retry.job, getObservation(auth.workspaceId, retry.job.observation_id)), 202);
}

/** What the lineage view lists. Reads only rows; never GitHub. */
export function lineageCaptureJobViews(workspaceId: string, lineageId: string): unknown[] {
  return listCaptureJobs(workspaceId, lineageId).map((job) =>
    captureJobView(job, getObservation(workspaceId, job.observation_id)));
}

/** The newest job of a lineage, which is what the retained-only shell reports. */
export function latestCaptureJob(workspaceId: string, lineageId: string): ReviewCaptureJobRow | null {
  return db.query<ReviewCaptureJobRow, [string, string]>(
    "SELECT * FROM review_capture_jobs WHERE workspace_id = ? AND lineage_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(workspaceId, lineageId);
}
