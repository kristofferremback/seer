// The refresh a native membership delivery queues, and the lane it runs in.
//
// A delivery says a pull request's stack membership changed. What that means for a stack is
// a provider read, so it is a JOB — persistent, installation-owned, leased, retryable — and
// never an inline call from the webhook transaction. Only an installation-owned stack gets
// one: a stack that reads through a member's connected account records the observation and
// shows drift, because nobody's credential is spent unasked. The row is keyed on the pull
// request observation it came from, so a redelivery finds its job rather than making one.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { RSJ_ID_RE, tinyId } from "../ids";
import { GithubError } from "./github";
import { actorQueueKey, openReadSession } from "./github-app";
import { readableWorkspaces, softNotFound } from "./read";
import { CAPTURE_LEASE_MS, MAX_CAPTURE_ATTEMPTS, MAX_JOB_FAILURE_TEXT } from "./revision-jobs";
import { liveMemberSlugsInOrder, normalizeInferredChain, normalizeNativeStack, seedMemberOf } from "./stack-pr";
import {
  currentStackManifest,
  getStackById,
  refreshStackManifest,
  StackWriteError,
  type ReviewStackRow,
} from "./stack-db";

export interface StackRefreshJobRow {
  id: string;
  workspace_id: string;
  stack_id: string;
  stack_observation_id: string | null;
  pull_request_observation_id: string | null;
  state: "pending" | "running" | "failed" | "completed";
  installation_id: number;
  actor_key: string;
  attempts: number;
  failure: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  result_manifest_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getStackRefreshJob(workspaceId: string, id: string): StackRefreshJobRow | null {
  return db.query<StackRefreshJobRow, [string, string]>(
    "SELECT * FROM review_stack_refresh_jobs WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, id);
}

function getJobById(id: string): StackRefreshJobRow | null {
  return db.query<StackRefreshJobRow, [string]>("SELECT * FROM review_stack_refresh_jobs WHERE id = ?").get(id);
}

export function listStackRefreshJobs(workspaceId: string, stackId: string): StackRefreshJobRow[] {
  return db.query<StackRefreshJobRow, [string, string]>(
    "SELECT * FROM review_stack_refresh_jobs WHERE workspace_id = ? AND stack_id = ? ORDER BY created_at ASC, id ASC",
  ).all(workspaceId, stackId);
}

/** The lane a stack's installation refreshes run in. Its own namespace, so a stack refresh
 *  never waits behind that installation's captures and never blocks one. */
export function stackLaneKey(workspaceId: string, installationId: number): string {
  return `stack/${actorQueueKey(workspaceId, { kind: "installation", installationId })}`;
}

export type StackRefreshTrigger =
  | { kind: "stack"; observationId: string }
  | { kind: "pull-request"; observationId: string };

/**
 * Insert-or-ignore one refresh job keyed on its exact trigger. Webhook work uses the stack
 * observation's receipt identity. A reconciliation sweep has no stack facts, so it uses
 * the complete pull request observation the sweep recorded instead of inventing membership.
 */
export function openStackRefreshJob(stack: ReviewStackRow, trigger: StackRefreshTrigger, now: number): { job: StackRefreshJobRow; created: boolean } {
  if (stack.actor_kind !== "installation" || stack.installation_id === null) {
    throw new Error(`Stack ${stack.id} is not installation-owned, so no refresh job may be queued for it`);
  }
  const id = tinyId("rsj");
  const stackObservationId = trigger.kind === "stack" ? trigger.observationId : null;
  const pullRequestObservationId = trigger.kind === "pull-request" ? trigger.observationId : null;
  const created = db.run(
    "INSERT OR IGNORE INTO review_stack_refresh_jobs (id, workspace_id, stack_id, stack_observation_id, pull_request_observation_id, state, installation_id, actor_key, attempts, failure, lease_token, lease_expires_at, result_manifest_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)",
    [id, stack.workspace_id, stack.id, stackObservationId, pullRequestObservationId, stack.installation_id, stackLaneKey(stack.workspace_id, stack.installation_id), now, now],
  ).changes > 0;
  const job = db.query<StackRefreshJobRow, [string, string | null, string | null, string | null, string | null]>(
    "SELECT * FROM review_stack_refresh_jobs WHERE stack_id = ? AND ((stack_observation_id = ? AND ? IS NULL) OR (pull_request_observation_id = ? AND ? IS NULL))",
  ).get(stack.id, stackObservationId, pullRequestObservationId, pullRequestObservationId, stackObservationId)!;
  return { job, created };
}

type Claim = { kind: "claimed"; job: StackRefreshJobRow } | { kind: "busy" } | { kind: "exhausted" } | { kind: "empty" };

const claimNext = db.transaction((actorKey: string, now: number): Claim => {
  db.run(
    "UPDATE review_stack_refresh_jobs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE actor_key = ? AND state = 'running' AND lease_expires_at <= ?",
    [now, actorKey, now],
  );
  if (db.query<{ id: string }, [string, number]>("SELECT id FROM review_stack_refresh_jobs WHERE actor_key = ? AND state = 'running' AND lease_expires_at > ? LIMIT 1").get(actorKey, now)) {
    return { kind: "busy" };
  }
  const next = db.query<StackRefreshJobRow, [string]>(
    "SELECT * FROM review_stack_refresh_jobs WHERE actor_key = ? AND state = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
  ).get(actorKey);
  if (!next) return { kind: "empty" };
  if (next.attempts >= MAX_CAPTURE_ATTEMPTS) {
    db.run(
      "UPDATE review_stack_refresh_jobs SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      [`The stack refresh was attempted ${next.attempts} times without completing. Retry it once the cause is fixed.`, now, next.id],
    );
    return { kind: "exhausted" };
  }
  db.run(
    "UPDATE review_stack_refresh_jobs SET state = 'running', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'",
    [tinyId("lse"), now + CAPTURE_LEASE_MS, now, next.id],
  );
  return { kind: "claimed", job: getJobById(next.id)! };
}) as (actorKey: string, now: number) => Claim;

function finish(job: StackRefreshJobRow, leaseToken: string, result: { manifestId: string } | { failure: string }): void {
  const now = Date.now();
  if ("failure" in result) {
    db.run(
      "UPDATE review_stack_refresh_jobs SET state = 'failed', failure = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?",
      [result.failure.slice(0, MAX_JOB_FAILURE_TEXT), now, job.id, leaseToken],
    );
    return;
  }
  db.run(
    "UPDATE review_stack_refresh_jobs SET state = 'completed', failure = NULL, lease_token = NULL, lease_expires_at = NULL, result_manifest_id = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?",
    [result.manifestId, now, job.id, leaseToken],
  );
}

/** Re-normalize one stack through its stored installation and publish a successor when the
 *  members moved. Rows only for an inferred stack; one provider read for a native one. */
export async function runStackRefreshJob(job: StackRefreshJobRow): Promise<void> {
  const leaseToken = job.lease_token;
  if (!leaseToken) throw new Error(`Stack refresh job ${job.id} was run without a lease`);
  try {
    const stack = getStackById(job.stack_id);
    if (!stack) throw new StackWriteError(404, "This stack no longer exists.");
    const current = currentStackManifest(stack);
    if (!current) throw new Error(`Stack ${stack.id} has no current manifest`);
    let normalized;
    if (stack.source === "native") {
      const seed = seedMemberOf(stack.workspace_id, current);
      if (!seed) throw new StackWriteError(422, "This stack has no live member to read the native stack from.");
      const session = await openReadSession(stack.workspace_id, { kind: "installation", installationId: job.installation_id }, stack.repo, stack.repo_id);
      normalized = await normalizeNativeStack(stack.workspace_id, seed, session, current);
    } else {
      normalized = normalizeInferredChain(stack.workspace_id, liveMemberSlugsInOrder(stack, current), current);
    }
    const outcome = db.transaction(() => refreshStackManifest(stack, normalized))();
    finish(job, leaseToken, { manifestId: outcome.manifest.id });
  } catch (err) {
    const text = err instanceof StackWriteError || err instanceof GithubError ? err.message : `The stack refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    finish(job, leaseToken, { failure: text });
    console.error(`[seer] stack refresh job ${job.id} failed: ${text}`);
  }
}

// ---- the lane ----

const lanes = new Map<string, Promise<void>>();

async function drain(actorKey: string): Promise<void> {
  for (;;) {
    const claim = claimNext(actorKey, Date.now());
    if (claim.kind === "exhausted") continue;
    if (claim.kind === "claimed") { await runStackRefreshJob(claim.job); continue; }
    return;
  }
}

/** Run this lane once, after the transaction that queued the work committed. */
export function scheduleStackLane(actorKey: string): void {
  if (lanes.has(actorKey)) return;
  const run = drain(actorKey)
    .catch((err) => { console.error(`[seer] stack refresh lane ${actorKey} failed:`, err); })
    .finally(() => { lanes.delete(actorKey); });
  lanes.set(actorKey, run);
}

/** Test seam: wait for every lane this process started. */
export async function settleStackRefreshJobs(): Promise<void> {
  while (lanes.size > 0) await Promise.all([...lanes.values()]);
}

/** Release abandoned leases and re-drive every lane with pending work. Called by the
 *  capture sweep, so one timer recovers both kinds of job. */
export function recoverStackRefreshJobs(now: number = Date.now()): number {
  const released = db.run(
    "UPDATE review_stack_refresh_jobs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'running' AND lease_expires_at <= ?",
    [now, now],
  ).changes;
  for (const row of db.query<{ actor_key: string }, []>("SELECT DISTINCT actor_key FROM review_stack_refresh_jobs WHERE state = 'pending'").all()) {
    scheduleStackLane(row.actor_key);
  }
  return released;
}

// ---- views and routes ----

export function stackRefreshJobView(job: StackRefreshJobRow): unknown {
  const stack = getStackById(job.stack_id);
  const result = job.result_manifest_id
    ? db.query<{ version: number }, [string]>("SELECT version FROM review_stack_manifests WHERE id = ?").get(job.result_manifest_id)
    : null;
  return {
    id: job.id,
    workspace: job.workspace_id,
    stack: job.stack_id,
    slug: stack?.slug ?? null,
    state: job.state,
    attempts: job.attempts,
    failure: job.failure,
    actor: "installation",
    stackObservationId: job.stack_observation_id,
    pullRequestObservationId: job.pull_request_observation_id,
    resultManifest: result?.version ?? null,
    resultManifestUrl: result && stack ? `${config.baseUrl}/${job.workspace_id}/r-stacks/${stack.slug}/v/${result.version}` : null,
    retryUrl: `${config.baseUrl}/api/review-stack-refresh-jobs/${job.id}/retry`,
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
  };
}

function jobJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export const retryStackRefreshJob = db.transaction((workspaceId: string, jobId: string, now: number = Date.now()):
  { kind: "missing" } | { kind: "refused"; error: string } | { kind: "retried"; job: StackRefreshJobRow } => {
  const job = getStackRefreshJob(workspaceId, jobId);
  if (!job) return { kind: "missing" };
  const changed = db.run(
    "UPDATE review_stack_refresh_jobs SET state = 'pending', failure = NULL, attempts = 0, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE id = ? AND (state = 'failed' OR (state = 'running' AND lease_expires_at <= ?))",
    [now, job.id, now],
  ).changes;
  if (changed === 0) {
    const held = getStackRefreshJob(workspaceId, jobId)!;
    return { kind: "refused", error: held.state === "completed" ? "This stack refresh already completed." : held.state === "running" ? "This stack refresh is running." : "This stack refresh is queued." };
  }
  return { kind: "retried", job: getStackRefreshJob(workspaceId, jobId)! };
}) as (workspaceId: string, jobId: string, now?: number) => { kind: "missing" } | { kind: "refused"; error: string } | { kind: "retried"; job: StackRefreshJobRow };

/** POST /api/review-stack-refresh-jobs/:id/retry. Every miss is the review soft 404. */
export function handleRetryStackRefreshJob(req: Request, id: string): Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) { auth.headers.set("cache-control", "no-store"); return auth; }
  if (!RSJ_ID_RE.test(id)) return softNotFound();
  const retry = retryStackRefreshJob(auth.workspaceId, id);
  if (retry.kind === "missing") return softNotFound();
  if (retry.kind === "refused") return jobJson({ error: retry.error }, 409);
  scheduleStackLane(retry.job.actor_key);
  return jobJson(stackRefreshJobView(retry.job), 202);
}

/** GET /api/review-stack-refresh-jobs/:id. */
export function handleReadStackRefreshJob(req: Request, id: string): Response {
  if (!RSJ_ID_RE.test(id)) return softNotFound();
  for (const workspaceId of readableWorkspaces(req)) {
    const job = getStackRefreshJob(workspaceId, id);
    if (job) return jobJson(stackRefreshJobView(job));
  }
  return softNotFound();
}
