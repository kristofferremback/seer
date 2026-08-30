// One pull request joins one review lineage.
//
// Everything here turns on a single idea: a promoted review's relationship to a pull
// request is a ROW, not a derivation. Route resolution, webhook filtering, reconciliation
// and orphan retention all ask the same table, so there is one answer to "which lineage
// reviews this pull request" and one place for it to be wrong.
//
// Three identities are deliberately separate, and collapsing any pair of them breaks
// something the others cannot fix:
//
//   * The RELATION says which pull request this lineage reviews. One per lineage, one
//     live owner per pull request.
//   * The OBSERVATION says what GitHub said, when, and TO WHOM. Its digest covers the
//     normalized facts and the exact read actor but not Seer's clock, so re-reading
//     unchanged facts through the same actor is free while a different actor stays
//     honestly attributed as a different reading.
//   * The SOURCE TUPLE says which bytes a revision was captured from. It is what stops a
//     second capture of the same base tip, head and merge base publishing a duplicate
//     revision — and it is why a branch-first review that a pull request is later
//     attached to gains a relationship rather than a second copy of its own code.
//
// A fourth identity, the client's `Idempotency-Key`, replays the USER OPERATION. It is
// not the same question as the source tuple and must not be merged with it: two different
// requests may legitimately observe the same bytes, and one request replayed must return
// one answer.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { hashKey, SLUG_RE, tinyId } from "../ids";
import { getProject } from "../projects/db";
import { getReview, lineageOwnsSlug } from "./db";
import {
  actorQueueKey,
  actorWords,
  GithubAppRefusal,
  openReadSession,
  resolveReadSession,
  type ReadActor,
} from "./github-app";
import {
  assertRepo,
  GithubError,
  GithubPullPayloadError,
  parseGithubPull,
  type GithubClient,
  type ValidatedPull,
} from "./github";
import { softNotFound } from "./read";
import { getStageCapture, type StageCaptureInventory } from "../stage/db";
import {
  digestOf,
  getLineage,
  getRevision,
  getRevisionMovement,
  latestAccountBeforeRevision,
  latestAccountForRevision,
  previousRevision,
  storeRevisionMovement,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import {
  accountDelta,
  revisionCodeDelta,
  type AccountSummaryDelta,
  type DeltaCounts,
} from "./revision-delta";
import {
  adoptCaptureJobObservation,
  captureJobView,
  createCaptureJob,
  getCaptureJob,
  getCaptureJobForObservation,
  latestCaptureJobForPair,
  openCaptureJobForPair,
  scheduleActorQueue,
  type ReviewCaptureJobRow,
} from "./revision-jobs";

// ---- rows ----

export type ActorKind = ReadActor["kind"];

/** The actor columns every table that stores one carries, in one shape. */
export interface StoredActor {
  actor_kind: ActorKind;
  installation_id: number | null;
  user_id: string | null;
  credential_id: string | null;
}

export interface ReviewLineagePrRow extends StoredActor {
  lineage_id: string;
  workspace_id: string;
  slug: string;
  repo_id: number;
  repo: string;
  pr_number: number;
  head_ref: string;
  base_ref: string;
  attached_at: number;
  detached_at: number | null;
}

export interface ReviewPrObservationRow extends StoredActor {
  /**
   * SQLite's insertion order for this row, read as `rowid`.
   *
   * The third and last ordering key, and the only one that cannot tie. GitHub's
   * `updated_at` has one-second resolution and does not move at all when only the base
   * branch advanced, so two genuinely different sources can arrive carrying the same
   * timestamp; Seer's own `observed_at` separates them to the millisecond, and this
   * separates the ones that also share that. It is an arrival order and is not claimed to
   * be GitHub's — what it buys is that two workers deciding "is this newer" always decide
   * the same way, rather than falling back on a random id.
   */
  seq: number;
  id: string;
  workspace_id: string;
  lineage_id: string;
  repo_id: number;
  repo: string;
  pr_number: number;
  title: string;
  state: "open" | "closed";
  merged: number;
  draft: number;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  head_sha: string;
  /** Null only on a webhook observation: a delivery carries no merge base, and inventing
   *  one would let an unasked-for reading pose as a capturable source. */
  merge_base_sha: string | null;
  github_updated_at: number;
  observed_at: number;
  digest: string;
}

export interface ReviewRevisionSourceRow {
  revision_id: string;
  workspace_id: string;
  lineage_id: string;
  observation_id: string;
  base_tip_sha: string;
  source_head_sha: string;
  merge_base_sha: string;
  attached_at: number;
}

/** What one read of a pull request established, before it is attributed to anybody. */
export interface ObservationFacts {
  repoId: number;
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** Null when nobody compared. See ReviewPrObservationRow. */
  mergeBaseSha: string | null;
  githubUpdatedAt: number;
}

/** An observation that CAN be a capture source: somebody compared, so the third leg of
 *  the source tuple is a fact rather than an assumption. */
export interface CapturableFacts extends ObservationFacts {
  mergeBaseSha: string;
}

export function storedActorOf(actor: ReadActor): StoredActor {
  return {
    actor_kind: actor.kind,
    installation_id: actor.kind === "installation" ? actor.installationId : null,
    user_id: actor.kind === "user" ? actor.userId : null,
    credential_id: actor.kind === "user" ? actor.credentialId : null,
  };
}

/** The stored columns back as the value a worker reopens. Corruption throws rather than
 *  degrading to a weaker actor: reading someone's private repository anonymously because
 *  a column was null is exactly the substitution this path exists to prevent. */
export function readActorOf(row: StoredActor): ReadActor {
  if (row.actor_kind === "installation" && row.installation_id !== null) {
    return { kind: "installation", installationId: row.installation_id };
  }
  if (row.actor_kind === "user" && row.user_id !== null && row.credential_id !== null) {
    return { kind: "user", userId: row.user_id, credentialId: row.credential_id };
  }
  if (row.actor_kind === "anonymous") return { kind: "anonymous" };
  throw new Error(`Stored read actor "${row.actor_kind}" has no matching identity`);
}

/**
 * The observation's identity: the normalized GitHub facts and the exact reader.
 *
 * `observed_at` is deliberately absent. Including it would make every read a new row, so
 * a page refreshed hourly would accumulate a row an hour saying the same thing; excluding
 * the ACTOR would do the opposite and let a public anonymous read stand as though the
 * installation had confirmed it.
 */
export function observationDigest(facts: ObservationFacts, actor: ReadActor): string {
  return digestOf({ facts, actor });
}

// ---- reads ----

const PR_COLUMNS =
  "lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, " +
  "actor_kind, installation_id, user_id, credential_id, attached_at, detached_at";

/** The live relation of one lineage, or null. A detached row is history and is never
 *  returned here: the lineage no longer reviews that pull request. */
export function getLineagePr(workspaceId: string, lineageId: string): ReviewLineagePrRow | null {
  return db.query<ReviewLineagePrRow, [string, string]>(
    `SELECT ${PR_COLUMNS} FROM review_lineage_prs WHERE workspace_id = ? AND lineage_id = ? AND detached_at IS NULL`,
  ).get(workspaceId, lineageId);
}

/** Which live lineage owns this pull request in this workspace, by numeric id. */
export function getLiveLineagePrByNumber(
  workspaceId: string,
  repoId: number,
  prNumber: number,
): ReviewLineagePrRow | null {
  return db.query<ReviewLineagePrRow, [string, number, number]>(
    `SELECT ${PR_COLUMNS} FROM review_lineage_prs WHERE workspace_id = ? AND repo_id = ? AND pr_number = ? AND detached_at IS NULL`,
  ).get(workspaceId, repoId, prNumber);
}

// The webhook and reconciliation join — `matchLineagePrs` — lives in `installations.ts`
// beside `matchReviewPrs` and `matchTaskPrs`, because it is the third reading of one
// question and the sweep that retires a status row has to ask all three in one place.

/** Every read of an observation carries its insertion order, because every decision that
 *  compares two observations needs the third key and none of them may invent it. */
const OBSERVATION_COLUMNS = "rowid AS seq, *";

export function getObservation(workspaceId: string, id: string): ReviewPrObservationRow | null {
  return db.query<ReviewPrObservationRow, [string, string]>(
    `SELECT ${OBSERVATION_COLUMNS} FROM review_pr_observations WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, id);
}

export function getObservationByDigest(lineageId: string, digest: string): ReviewPrObservationRow | null {
  return db.query<ReviewPrObservationRow, [string, string]>(
    `SELECT ${OBSERVATION_COLUMNS} FROM review_pr_observations WHERE lineage_id = ? AND digest = ?`,
  ).get(lineageId, digest);
}

/**
 * One total order over observations, used by every decision that has to say which of two
 * readings is later: GitHub's own timestamp, then Seer's immutable arrival time, then
 * SQLite's insertion order.
 *
 * The last two are Seer's and are not dressed up as GitHub's. They exist because base-only
 * movement leaves `updated_at` untouched — a pull request whose base branch advanced is a
 * different source with the same GitHub timestamp — and because a redelivery of the same
 * second must not be able to reorder history differently in two processes. What is
 * guaranteed is determinism, not that GitHub resolves sub-second ordering.
 */
export function observationIsAfter(
  candidate: Pick<ReviewPrObservationRow, "github_updated_at" | "observed_at" | "seq">,
  incumbent: Pick<ReviewPrObservationRow, "github_updated_at" | "observed_at" | "seq">,
): boolean {
  if (candidate.github_updated_at !== incumbent.github_updated_at) {
    return candidate.github_updated_at > incumbent.github_updated_at;
  }
  if (candidate.observed_at !== incumbent.observed_at) return candidate.observed_at > incumbent.observed_at;
  return candidate.seq > incumbent.seq;
}

/** The newest thing anybody has seen about this lineage's pull request, under the same
 *  three-key order every drift and queue decision uses. A pinned revision reads its OWN
 *  observation instead. */
export function latestObservation(workspaceId: string, lineageId: string): ReviewPrObservationRow | null {
  return db.query<ReviewPrObservationRow, [string, string]>(
    `SELECT ${OBSERVATION_COLUMNS} FROM review_pr_observations WHERE workspace_id = ? AND lineage_id = ? ` +
      "ORDER BY github_updated_at DESC, observed_at DESC, rowid DESC LIMIT 1",
  ).get(workspaceId, lineageId);
}

/** The newest COMPLETE observation: one somebody compared, so it could be a capture
 *  source. What drift compares a webhook's pinned SHAs against. */
export function latestCompleteObservation(workspaceId: string, lineageId: string): ReviewPrObservationRow | null {
  return db.query<ReviewPrObservationRow, [string, string]>(
    `SELECT ${OBSERVATION_COLUMNS} FROM review_pr_observations WHERE workspace_id = ? AND lineage_id = ? ` +
      "AND merge_base_sha IS NOT NULL ORDER BY github_updated_at DESC, observed_at DESC, rowid DESC LIMIT 1",
  ).get(workspaceId, lineageId);
}

/** The observation the lineage's newest source revision was captured from. The incumbent
 *  every completion orders itself against, so an out-of-order arrival cannot append
 *  history behind a newer source. */
export function latestCapturedObservation(workspaceId: string, lineageId: string): ReviewPrObservationRow | null {
  return db.query<ReviewPrObservationRow, [string, string]>(
    `SELECT o.rowid AS seq, o.* FROM review_pr_observations o ` +
      "JOIN review_revision_sources s ON s.observation_id = o.id " +
      "JOIN review_revisions r ON r.id = s.revision_id " +
      "WHERE o.workspace_id = ? AND o.lineage_id = ? ORDER BY r.revision DESC LIMIT 1",
  ).get(workspaceId, lineageId);
}

export function getRevisionSource(workspaceId: string, revisionId: string): ReviewRevisionSourceRow | null {
  return db.query<ReviewRevisionSourceRow, [string, string]>(
    "SELECT * FROM review_revision_sources WHERE workspace_id = ? AND revision_id = ?",
  ).get(workspaceId, revisionId);
}

export function getSourceByTuple(
  lineageId: string,
  baseTipSha: string,
  sourceHeadSha: string,
  mergeBaseSha: string,
): ReviewRevisionSourceRow | null {
  return db.query<ReviewRevisionSourceRow, [string, string, string, string]>(
    "SELECT * FROM review_revision_sources WHERE lineage_id = ? AND base_tip_sha = ? AND source_head_sha = ? AND merge_base_sha = ?",
  ).get(lineageId, baseTipSha, sourceHeadSha, mergeBaseSha);
}

/** The observation a REVISION was captured from, which is the one a pinned page reads.
 *  Never the relation's latest: a merge that happened after this revision was published
 *  is not a fact about the code this page shows. */
export function observationForRevision(workspaceId: string, revisionId: string): ReviewPrObservationRow | null {
  const source = getRevisionSource(workspaceId, revisionId);
  return source ? getObservation(workspaceId, source.observation_id) : null;
}

// ---- idempotency ----

export interface PrIdempotencyRow {
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  operation: "create" | "attach" | "refresh";
  lineage_id: string;
  observation_id: string;
  capture_job_id: string | null;
  revision_id: string | null;
  created_at: number;
}

export function getPrIdempotency(workspaceId: string, key: string): PrIdempotencyRow | null {
  return db.query<PrIdempotencyRow, [string, string]>(
    "SELECT * FROM review_pr_idempotency WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, key);
}

/** The client key's hash. It covers the operation and the target slug as well as the
 *  body, so one key cannot be reused to mean "attach to a different review". */
export function prRequestHash(
  operation: "create" | "attach" | "refresh",
  slug: string | null,
  body: unknown,
): string {
  return hashKey(JSON.stringify({ operation, slug, body }));
}

// ---- errors ----

export class PrIngestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 502,
    message: string,
  ) {
    super(message);
    this.name = "PrIngestError";
  }
}

// ---- the one write ----

export interface PrIngestInput {
  workspaceId: string;
  userId: string;
  keyId: string;
  operation: "create" | "attach";
  idempotencyKey: string;
  requestHash: string;
  slug: string;
  /** Only read when the operation creates the shell. */
  title: string;
  projects: string[];
  actor: ReadActor;
  facts: CapturableFacts;
  legacyOwnsSlug: (slug: string) => boolean;
}

export type PrIngestOutcome =
  | { kind: "reused"; lineage: ReviewLineageRow; observation: ReviewPrObservationRow; revisionId: string }
  | { kind: "job"; lineage: ReviewLineageRow; observation: ReviewPrObservationRow; job: ReviewCaptureJobRow };

function insertObservation(
  workspaceId: string,
  lineageId: string,
  facts: ObservationFacts,
  actor: ReadActor,
  now: number,
): ReviewPrObservationRow {
  const digest = observationDigest(facts, actor);
  const existing = getObservationByDigest(lineageId, digest);
  if (existing) return existing;
  const stored = storedActorOf(actor);
  const id = tinyId("pob");
  db.run(
    "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, " +
      "base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, " +
      "actor_kind, installation_id, user_id, credential_id, digest) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, workspaceId, lineageId, facts.repoId, facts.repo, facts.number, facts.title, facts.state,
      facts.merged ? 1 : 0, facts.draft ? 1 : 0, facts.baseRef, facts.baseSha, facts.headRef, facts.headSha,
      facts.mergeBaseSha, facts.githubUpdatedAt, now,
      stored.actor_kind, stored.installation_id, stored.user_id, stored.credential_id, digest],
  );
  return getObservationByDigest(lineageId, digest)!;
}

/** Attach the relation, or prove the one already there is the same pull request. The
 *  partial unique index is what refuses a second lineage; it is checked first so the
 *  caller gets the product's sentence rather than SQLite's. */
function attachRelation(
  workspaceId: string,
  lineage: ReviewLineageRow,
  facts: ObservationFacts,
  actor: ReadActor,
  now: number,
): void {
  const existing = getLineagePr(workspaceId, lineage.id);
  if (existing) {
    if (existing.repo_id !== facts.repoId || existing.pr_number !== facts.number) {
      throw new PrIngestError(409, `"${lineage.slug}" already reviews ${existing.repo}#${existing.pr_number}.`);
    }
    return;
  }
  const owner = getLiveLineagePrByNumber(workspaceId, facts.repoId, facts.number);
  if (owner) {
    throw new PrIngestError(409, `${facts.repo}#${facts.number} is already reviewed by "${owner.slug}".`);
  }
  const stored = storedActorOf(actor);
  db.run(
    "INSERT INTO review_lineage_prs (lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, " +
      "actor_kind, installation_id, user_id, credential_id, attached_at, detached_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    [lineage.id, workspaceId, lineage.slug, facts.repoId, facts.repo, facts.number, facts.headRef, facts.baseRef,
      stored.actor_kind, stored.installation_id, stored.user_id, stored.credential_id, now],
  );
}

function outcomeOf(
  workspaceId: string,
  lineage: ReviewLineageRow,
  observation: ReviewPrObservationRow,
  revisionId: string | null,
  jobId: string | null,
): PrIngestOutcome {
  if (revisionId) return { kind: "reused", lineage, observation, revisionId };
  const job = jobId ? getCaptureJob(workspaceId, jobId) : null;
  if (!job) throw new Error(`Pull request ingestion result for ${lineage.slug} names no job or revision`);
  return { kind: "job", lineage, observation, job };
}

/**
 * A stored client operation, answered without GitHub.
 *
 * The point of a replay is that it costs nothing: a caller retrying a request that timed
 * out must not spend a second installation token, a second personal-credential read, or a
 * second slice of the host's anonymous budget to be told what it was told before. The
 * state it reports is CURRENT — the job is re-read — so a replay after the capture
 * finished says so rather than repeating the pending answer.
 */
export function replayPrOperation(workspaceId: string, row: PrIdempotencyRow): PrIngestOutcome {
  const lineage = db.query<ReviewLineageRow, [string]>("SELECT * FROM review_lineages WHERE id = ?").get(row.lineage_id);
  const observation = getObservation(workspaceId, row.observation_id);
  if (!lineage || !observation) throw new Error(`Idempotency row ${row.idempotency_key} points at rows that are gone`);
  return outcomeOf(workspaceId, lineage, observation, row.revision_id, row.capture_job_id);
}

/**
 * The whole of a create or attach, in one transaction.
 *
 * Replay is answered from inside it rather than in front of it, exactly as revision
 * publication is: SQLite has one writer, so re-reading the key here is what makes two
 * concurrent identical requests land one row — the second sees the first's and hands back
 * the winner's stored result instead of leaking a unique-constraint failure.
 *
 * Slug ownership is rechecked here too, against BOTH tables, because the check the route
 * made before it called GitHub is now seconds old.
 */
export const ingestPullRequest = db.transaction((input: PrIngestInput): PrIngestOutcome => {
  const { workspaceId, facts, actor } = input;
  const now = Date.now();

  const replay = getPrIdempotency(workspaceId, input.idempotencyKey);
  if (replay) {
    if (replay.request_hash !== input.requestHash) {
      throw new PrIngestError(409, "This Idempotency-Key was already used for a different pull request request.");
    }
    const lineage = db.query<ReviewLineageRow, [string]>("SELECT * FROM review_lineages WHERE id = ?").get(replay.lineage_id);
    const observation = getObservation(workspaceId, replay.observation_id);
    if (!lineage || !observation) throw new Error(`Idempotency row ${replay.idempotency_key} points at rows that are gone`);
    return outcomeOf(workspaceId, lineage, observation, replay.revision_id, replay.capture_job_id);
  }

  let lineage: ReviewLineageRow | null;
  if (input.operation === "create") {
    if (lineageOwnsSlug(workspaceId, input.slug)) {
      throw new PrIngestError(409, `Review slug "${input.slug}" already names another promoted review`);
    }
    if (input.legacyOwnsSlug(input.slug)) {
      throw new PrIngestError(409, `Review slug "${input.slug}" already names a review in this workspace`);
    }
    for (const project of input.projects) {
      if (!getProject(workspaceId, project)) throw new PrIngestError(422, `No project "${project}" in this workspace`);
    }
    const lineageId = tinyId("rln");
    // A SHELL: latest_revision is null, because no source revision exists until the
    // capture completes. The lineage is real from this moment — it owns its slug and its
    // pull request — and its page says so rather than pretending to be a review.
    db.run(
      "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
      [lineageId, workspaceId, input.slug, facts.repo, facts.repoId, facts.headRef,
        facts.baseRef, facts.mergeBaseSha, input.title, input.userId, input.keyId, now, now],
    );
    for (const project of input.projects) {
      const row = getProject(workspaceId, project)!;
      db.run(
        "INSERT OR IGNORE INTO project_review_lineages (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)",
        [row.id, workspaceId, input.slug, now],
      );
    }
    lineage = getLineage(workspaceId, input.slug);
  } else {
    lineage = getLineage(workspaceId, input.slug);
  }
  if (!lineage) throw new PrIngestError(404, "No such review in this workspace");

  attachRelation(workspaceId, lineage, facts, actor, now);
  const observation = insertObservation(workspaceId, lineage.id, facts, actor, now);

  let revisionId: string | null = null;
  let jobId: string | null = null;

  const byTuple = getSourceByTuple(lineage.id, facts.baseSha, facts.headSha, facts.mergeBaseSha);
  if (byTuple) {
    // These exact bytes already published a revision of this lineage. The attachment is
    // still history; source revision numbering is not touched, because nothing about the
    // source evidence changed.
    revisionId = byTuple.revision_id;
  } else {
    const latest = lineage.latest_revision === null ? null : getRevision(workspaceId, lineage.slug, lineage.latest_revision);
    if (latest !== null &&
        latest.doc.source.baseTipSha === facts.baseSha &&
        latest.doc.source.sourceHeadSha === facts.headSha &&
        latest.doc.source.mergeBaseSha === facts.mergeBaseSha) {
      // The branch-first case. One immutable association, and nothing else: no capture,
      // no duplicate revision, no witness request, no read reset, no account rewrite.
      db.run(
        "INSERT INTO review_revision_sources (revision_id, workspace_id, lineage_id, observation_id, base_tip_sha, source_head_sha, merge_base_sha, attached_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [latest.id, workspaceId, lineage.id, observation.id, facts.baseSha, facts.headSha, facts.mergeBaseSha, now],
      );
      revisionId = latest.id;
    } else {
      const held = getCaptureJobForObservation(workspaceId, lineage.id, observation.id);
      jobId = (held ?? createCaptureJob({
        workspaceId,
        lineageId: lineage.id,
        slug: lineage.slug,
        observationId: observation.id,
        actor,
        actorKey: actorQueueKey(workspaceId, actor),
        now,
      })).id;
    }
  }

  db.run(
    "INSERT INTO review_pr_idempotency (workspace_id, idempotency_key, request_hash, operation, lineage_id, observation_id, capture_job_id, revision_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [workspaceId, input.idempotencyKey, input.requestHash, input.operation, lineage.id, observation.id, jobId, revisionId, now],
  );
  return outcomeOf(workspaceId, lineage, observation, revisionId, jobId);
}) as (input: PrIngestInput) => PrIngestOutcome;

export interface RefreshObservationInput {
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  lineage: ReviewLineageRow;
  actor: ReadActor;
  facts: CapturableFacts;
}

export interface RefreshOutcome {
  observation: ReviewPrObservationRow;
  /** The capture that will publish this source, or null when nothing needs capturing. */
  job: ReviewCaptureJobRow | null;
  /** The revision these exact bytes already published, or null. */
  sourceRevisionId: string | null;
}

/**
 * One explicit refresh: the reading, and whatever it costs to turn that reading into a
 * revision — which is nothing at all when the bytes are already published.
 *
 * Four outcomes, in the order a cheap answer beats an expensive one. These exact bytes
 * already published a revision, so there is nothing to do. This observation already queued
 * a job, so that job is the answer. A job is already queued or running for the same
 * base/head pair — a webhook's, usually — so it is reused, and if it is still PENDING it
 * adopts this complete reading, which is what saves its worker a compare. Otherwise one job
 * is created through the relation's stored actor.
 *
 * A running job is never rewritten. Its observation is what its capture is being recorded
 * against and its actor is whose credential is being spent; changing either underneath it
 * would make the finished capture provenance for something nobody asked for.
 */
export const refreshLineageObservation = db.transaction((input: RefreshObservationInput): RefreshOutcome => {
  const { workspaceId, lineage, facts } = input;
  const replay = getPrIdempotency(workspaceId, input.idempotencyKey);
  if (replay) {
    if (replay.request_hash !== input.requestHash) {
      throw new PrIngestError(409, "This Idempotency-Key was already used for a different pull request request.");
    }
    const observation = getObservation(workspaceId, replay.observation_id);
    if (!observation) throw new Error(`Idempotency row ${replay.idempotency_key} points at rows that are gone`);
    return {
      observation,
      job: replay.capture_job_id ? getCaptureJob(workspaceId, replay.capture_job_id) : null,
      sourceRevisionId: replay.revision_id,
    };
  }
  const now = Date.now();
  const observation = insertObservation(workspaceId, lineage.id, facts, input.actor, now);

  let sourceRevisionId: string | null = null;
  let job: ReviewCaptureJobRow | null = null;
  const byTuple = getSourceByTuple(lineage.id, facts.baseSha, facts.headSha, facts.mergeBaseSha);
  if (byTuple) {
    sourceRevisionId = byTuple.revision_id;
  } else {
    const held = getCaptureJobForObservation(workspaceId, lineage.id, observation.id);
    const open = held ?? openCaptureJobForPair(workspaceId, lineage.id, facts.baseSha, facts.headSha);
    if (open) {
      if (open.state === "pending" && open.observation_id !== observation.id) {
        adoptCaptureJobObservation({ jobId: open.id, observationId: observation.id, now, leaseToken: null });
      }
      job = getCaptureJob(workspaceId, open.id);
    } else {
      job = createCaptureJob({
        workspaceId,
        lineageId: lineage.id,
        slug: lineage.slug,
        observationId: observation.id,
        actor: input.actor,
        actorKey: actorQueueKey(workspaceId, input.actor),
        now,
      });
    }
  }

  db.run(
    "INSERT INTO review_pr_idempotency (workspace_id, idempotency_key, request_hash, operation, lineage_id, observation_id, capture_job_id, revision_id, created_at) " +
      "VALUES (?, ?, ?, 'refresh', ?, ?, ?, ?, ?)",
    [workspaceId, input.idempotencyKey, input.requestHash, lineage.id, observation.id, job?.id ?? null, sourceRevisionId, now],
  );
  return { observation, job, sourceRevisionId };
}) as (input: RefreshObservationInput) => RefreshOutcome;

export interface WebhookObservationInput {
  workspaceId: string;
  lineageId: string;
  installationId: number;
  facts: ObservationFacts;
}

/**
 * A webhook's promoted observation.
 *
 * Attributed to the installation in the signed payload and to nothing else: a delivery is
 * GitHub telling us something happened, so there is no person whose personal credential it
 * could be entitled to spend. A payload that does not carry complete base and head
 * repository identity records nothing here — the legacy status row still updates, but an
 * observation invented from half a payload would be indistinguishable from one read.
 */
export const recordWebhookObservation = db.transaction((input: WebhookObservationInput): ReviewPrObservationRow =>
  insertObservation(input.workspaceId, input.lineageId, input.facts,
    { kind: "installation", installationId: input.installationId }, Date.now()),
) as (input: WebhookObservationInput) => ReviewPrObservationRow;

export interface EnrichObservationInput {
  workspaceId: string;
  lineageId: string;
  jobId: string;
  leaseToken: string;
  actor: ReadActor;
  facts: CapturableFacts;
}

/**
 * The complete observation a worker publishes from a webhook's pinned SHAs, adopted onto
 * the running job in the same breath.
 *
 * One transaction, because a complete observation nobody's job points at would be a
 * capturable source tuple that arrived from nowhere, and a job pointing at an observation
 * that was not written would name nothing at all. `adopted` false means the lease moved
 * while the compare was in flight — another process is capturing this, and this worker must
 * stop rather than write a second capture of the same bytes.
 */
export const enrichWebhookObservation = db.transaction((input: EnrichObservationInput): {
  observation: ReviewPrObservationRow;
  adopted: boolean;
} => {
  const now = Date.now();
  const observation = insertObservation(input.workspaceId, input.lineageId, input.facts, input.actor, now);
  const adopted = adoptCaptureJobObservation({
    jobId: input.jobId,
    observationId: observation.id,
    now,
    leaseToken: input.leaseToken,
  });
  return { observation, adopted };
}) as (input: EnrichObservationInput) => { observation: ReviewPrObservationRow; adopted: boolean };

export interface UnaskedObservationInput {
  workspaceId: string;
  lineage: ReviewLineageRow;
  relation: ReviewLineagePrRow;
  installationId: number;
  facts: ObservationFacts;
}

export interface UnaskedObservation {
  observation: ReviewPrObservationRow;
  /** The lane to schedule after the delivery transaction commits, or null when nothing
   *  was queued — because nothing moved, or because the credential is not ours to spend. */
  actorKey: string | null;
}

/**
 * What an unasked-for reading — a webhook delivery, or a reconciliation sweep — records.
 *
 * The observation always. The capture job only when the source actually moved AND the
 * relation reads through an installation. A relation attached through a member's connected
 * account records the drift and stops there: capturing would spend that person's credential
 * because GitHub sent us a message, which nobody asked for and nobody consented to. Their
 * page says so and offers them the refresh.
 *
 * The queue decision uses the same three-key order every other decision uses, so a
 * redelivery of an older push is recorded as history and does not queue a capture of source
 * the lineage has already moved past.
 *
 * Not a transaction of its own: the caller is the signed delivery transaction, which has to
 * commit the delivery id with every effect of that delivery or with none of them.
 */
export function recordUnaskedObservation(input: UnaskedObservationInput): UnaskedObservation {
  const { workspaceId, lineage, relation, facts } = input;
  const now = Date.now();
  const observation = insertObservation(workspaceId, lineage.id, facts,
    { kind: "installation", installationId: input.installationId }, now);

  const actor = readActorOf(relation);
  if (actor.kind !== "installation") return { observation, actorKey: null };

  const captured = lineage.latest_revision === null
    ? null
    : getRevision(workspaceId, lineage.slug, lineage.latest_revision);
  const moved = captured === null ||
    captured.doc.source.baseTipSha !== facts.baseSha ||
    captured.doc.source.sourceHeadSha !== facts.headSha;
  if (!moved) return { observation, actorKey: null };
  const incumbent = latestCapturedObservation(workspaceId, lineage.id);
  if (incumbent && !observationIsAfter(observation, incumbent)) return { observation, actorKey: null };

  const held = getCaptureJobForObservation(workspaceId, lineage.id, observation.id);
  const open = held ?? openCaptureJobForPair(workspaceId, lineage.id, facts.baseSha, facts.headSha);
  const job = open ?? createCaptureJob({
    workspaceId,
    lineageId: lineage.id,
    slug: lineage.slug,
    observationId: observation.id,
    actor,
    actorKey: actorQueueKey(workspaceId, actor),
    now,
  });
  return { observation, actorKey: job.actor_key };
}

/** The same write, wrapped, for the reconciliation sweep — which is a loop of network
 *  calls rather than one transaction, so each pull request's observation and job commit
 *  together on their own. */
export const recordSweptObservation = db.transaction(recordUnaskedObservation) as
  (input: UnaskedObservationInput) => UnaskedObservation;

// ---- reading a pull request through the routed actor ----

export interface ObservedPull {
  actor: ReadActor;
  pull: ValidatedPull;
  facts: CapturableFacts;
}

/**
 * Read the pull request and its exact merge base through one bound session, then refuse
 * everything this slice does not support by name.
 *
 * Same-repository only, and every failure below is its own sentence. No credential, base
 * or repository fallback hides any of them: a fork is not "a branch we could not find",
 * and answering it as one would send somebody hunting for a typo.
 */
export async function observePullRequestThrough(
  session: { actor: ReadActor; client: GithubClient },
  repo: string,
  number: number,
  expectedRepoId?: number,
): Promise<ObservedPull> {
  const where = `${repo}#${number}`;
  const raw = await session.client.getPull(repo, number);
  const pull = parseGithubPull(raw, where);
  if (pull.number !== number) {
    throw new PrIngestError(422, `GitHub answered ${where} with pull request ${pull.number}.`);
  }
  if (pull.base.repo.id !== pull.head.repo.id) {
    throw new PrIngestError(422, `${where} is opened from a fork (${pull.head.repo.full_name} into ${pull.base.repo.full_name}). Seer reviews same-repository pull requests.`);
  }
  if (pull.base.repo.full_name.toLowerCase() !== repo.toLowerCase() && pull.base.repo.id !== expectedRepoId) {
    throw new PrIngestError(422, `GitHub resolved ${repo} to a different repository, ${pull.base.repo.full_name}.`);
  }
  if (!session.client.compare) {
    throw new PrIngestError(502, "The routed GitHub client cannot compare commits.");
  }
  const comparison = await session.client.compare(pull.base.repo.full_name, pull.base.sha, pull.head.sha);
  return {
    actor: session.actor,
    pull,
    facts: {
      repoId: pull.base.repo.id,
      repo: pull.base.repo.full_name,
      number: pull.number,
      title: pull.title,
      state: pull.state,
      merged: pull.merged,
      draft: pull.draft,
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      mergeBaseSha: comparison.merge_base_commit.sha,
      githubUpdatedAt: pull.updatedAt,
    },
  };
}

// ---- what has moved since a revision was published ----

/**
 * Everything a page needs to say about source that arrived after the revision it is
 * reading, computed from stored rows alone.
 *
 * Nothing here is personal, deliberately. `refreshRequired` says a refresh is what would
 * move this forward; WHO may take it is a question about the reader, and the surfaces that
 * have a reader answer it themselves rather than being handed a personalized fact by a
 * function an API key also calls.
 */
export interface LineageDrift {
  /** A completed revision newer than the one being read, or null. */
  newerRevision: number | null;
  /** A previously published revision whose tuple matches the newest observation. */
  sourceRevision: number | null;
  /** The newest observation's base or head differs from the newest revision's source. */
  moved: boolean;
  /** What is being done about it, when anything is. */
  capture: "pending" | "running" | "failed" | null;
  /** Movement is stored and nothing is queued, so somebody has to ask. */
  refreshRequired: boolean;
  /** The member whose personal credential this lineage reads through, or null when it
   *  reads through an installation or anonymously and any member may refresh. */
  ownerUserId: string | null;
}

export function lineageDrift(
  workspaceId: string,
  lineage: ReviewLineageRow,
  pinnedRevision: number,
): LineageDrift {
  const relation = getLineagePr(workspaceId, lineage.id);
  const ownerUserId = relation && relation.actor_kind === "user" ? relation.user_id : null;
  const newerRevision = lineage.latest_revision !== null && lineage.latest_revision > pinnedRevision
    ? lineage.latest_revision
    : null;
  const newest = lineage.latest_revision === null
    ? null
    : getRevision(workspaceId, lineage.slug, lineage.latest_revision);
  const observation = latestObservation(workspaceId, lineage.id);
  // BASE and HEAD only. A merge base a delivery did not carry is not evidence that
  // anything moved, and a title or draft edit is not a change to the code — treating
  // either as movement would put a permanent "new source" on a page nothing happened to.
  const moved = !!newest && !!observation &&
    (observation.base_sha !== newest.doc.source.baseTipSha ||
      observation.head_sha !== newest.doc.source.sourceHeadSha);
  const job = moved && observation
    ? latestCaptureJobForPair(workspaceId, lineage.id, observation.base_sha, observation.head_sha)
    : null;
  const capture = job && job.state !== "completed" ? job.state : null;
  let sourceRevision: number | null = null;
  if (moved && observation) {
    const source = observation.merge_base_sha
      ? getSourceByTuple(lineage.id, observation.base_sha, observation.head_sha, observation.merge_base_sha)
      : null;
    const jobSource = job?.state === "completed" && job.revision_id
      ? getRevisionSource(workspaceId, job.revision_id)
      : null;
    const jobMatches = !!jobSource &&
      jobSource.base_tip_sha === observation.base_sha &&
      jobSource.source_head_sha === observation.head_sha &&
      (observation.merge_base_sha === null || jobSource.merge_base_sha === observation.merge_base_sha);
    const revisionId = source?.revision_id ?? (jobMatches ? job?.revision_id ?? null : null);
    sourceRevision = revisionId
      ? db.query<{ revision: number }, [string]>("SELECT revision FROM review_revisions WHERE id = ?").get(revisionId)?.revision ?? null
      : null;
  }
  return {
    newerRevision,
    sourceRevision,
    moved,
    capture,
    refreshRequired: moved && capture === null && sourceRevision === null,
    ownerUserId,
  };
}

export interface RevisionMovement {
  previousRevision: number;
  code: DeltaCounts;
  /** Null until an account exists on both this revision and an earlier one: there is
   *  nothing to compare a walkthrough against until two of them exist. */
  account: { summary: AccountSummaryDelta; counts: DeltaCounts } | null;
}

/**
 * What one revision changed about the one before it. Reads rows; never GitHub.
 *
 * The code counts are the stored movement the completion transaction wrote. A revision
 * published before that row existed has it written the first time anything asks — the two
 * captures are immutable and the engine deterministic, so computing it late says exactly
 * what completion would have said — and every read after that is one row rather than two
 * inventories and a delta over them.
 */
export function revisionMovement(
  workspaceId: string,
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  currentInventory?: StageCaptureInventory,
): RevisionMovement | null {
  const previous = previousRevision(workspaceId, lineage.id, revision.revision);
  if (!previous) return null;
  let stored = getRevisionMovement(workspaceId, revision.id);
  if (!stored) {
    const before = getStageCapture(previous.capture_id, workspaceId);
    const after = currentInventory ?? getStageCapture(revision.capture_id, workspaceId);
    if (!before || !after) return null;
    const delta = revisionCodeDelta(before, after);
    db.transaction(() => storeRevisionMovement({
      workspaceId,
      lineageId: lineage.id,
      previousRevisionId: previous.id,
      revisionId: revision.id,
      counts: delta.counts,
      equivalences: delta.equivalences,
      now: Date.now(),
    }))();
    stored = getRevisionMovement(workspaceId, revision.id);
    if (!stored) throw new Error(`Revision ${revision.id} movement was not stored`);
  }
  const current = latestAccountForRevision(workspaceId, revision.id);
  const prior = latestAccountBeforeRevision(workspaceId, lineage.id, revision.revision);
  const account = current && prior ? accountDelta(prior.doc, current.doc) : null;
  return {
    previousRevision: previous.revision,
    code: { unchanged: stored.unchanged, revised: stored.revised, new: stored.new, removed: stored.removed },
    account: account ? { summary: account.summary, counts: account.counts } : null,
  };
}

// ---- views ----

export type PrStateWord = "merged" | "closed" | "draft" | "open";

export function observationStateWord(row: Pick<ReviewPrObservationRow, "state" | "merged" | "draft">): PrStateWord {
  if (row.merged) return "merged";
  if (row.state === "closed") return "closed";
  if (row.draft) return "draft";
  return "open";
}

export function pullRequestUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

/** What every API view says about one observation. Credential ids never appear: the
 *  actor is named by what kind of reader it is, which is what a member needs to know. */
export function observationView(row: ReviewPrObservationRow): unknown {
  const current = latestObservation(row.workspace_id, row.lineage_id);
  const currentRepo = current && current.repo_id === row.repo_id ? current.repo : row.repo;
  return {
    id: row.id,
    repo: row.repo,
    repoId: row.repo_id,
    number: row.pr_number,
    title: row.title,
    state: observationStateWord(row),
    merged: row.merged === 1,
    draft: row.draft === 1,
    url: pullRequestUrl(currentRepo, row.pr_number),
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headRef: row.head_ref,
    headSha: row.head_sha,
    mergeBaseSha: row.merge_base_sha,
    actor: row.actor_kind,
    updatedAt: new Date(row.github_updated_at).toISOString(),
    observedAt: new Date(row.observed_at).toISOString(),
  };
}

/** The `pullRequest` field on a lineage view: the relation, plus the newest thing
 *  anybody has observed about it. */
export function lineagePullRequestView(workspaceId: string, lineageId: string): unknown | null {
  const relation = getLineagePr(workspaceId, lineageId);
  if (!relation) return null;
  const observation = latestObservation(workspaceId, lineageId);
  const currentRepo = observation?.repo_id === relation.repo_id ? observation.repo : relation.repo;
  return {
    repo: currentRepo,
    repoId: relation.repo_id,
    number: relation.pr_number,
    headRef: relation.head_ref,
    baseRef: relation.base_ref,
    url: pullRequestUrl(currentRepo, relation.pr_number),
    actor: relation.actor_kind,
    attachedAt: new Date(relation.attached_at).toISOString(),
    observation: observation ? observationView(observation) : null,
  };
}

/** The `pullRequest` field on a REVISION view. Its own observation, never the
 *  relation's latest: a pinned revision states what was true when it was captured. */
export function revisionPullRequestView(workspaceId: string, revisionId: string): unknown | null {
  const observation = observationForRevision(workspaceId, revisionId);
  return observation ? observationView(observation) : null;
}

// ---- routes ----

function prJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

const MAX_KEY_LENGTH = 200;

/** Written as code point arithmetic rather than as a character class, because the
 *  characters this rejects are exactly the ones that must never appear in a source file
 *  either — a literal C0 byte in a regex is invisible in every diff that carries it. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The same, plus the three separators a "one line" promise has to exclude. */
function hasLineBreak(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (key === "" || key.length > MAX_KEY_LENGTH || hasControlCharacter(key)) {
    throw new PrIngestError(400, "Idempotency-Key header is required and must be a short printable value.");
  }
  return key;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new PrIngestError(400, "Body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PrIngestError(400, "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).find((name) => !allowed.includes(name));
  if (extra) throw new PrIngestError(422, `${JSON.stringify(extra)} is not a supported field.`);
}

function repoField(body: Record<string, unknown>): string {
  if (typeof body.repo !== "string") throw new PrIngestError(422, "repo is required and must be owner/name.");
  try {
    assertRepo(body.repo);
  } catch (err) {
    throw new PrIngestError(422, err instanceof Error ? err.message : String(err));
  }
  return body.repo;
}

function numberField(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.number) || (body.number as number) <= 0 || (body.number as number) > 1_000_000_000) {
    throw new PrIngestError(422, "number must be a positive pull request number.");
  }
  return body.number as number;
}

/** Sorted and unique, so two callers naming the same projects in different orders replay
 *  each other rather than conflicting on the request hash. */
function projectsField(body: Record<string, unknown>): string[] {
  if (body.projects === undefined) return [];
  if (!Array.isArray(body.projects) || body.projects.length > 16) {
    throw new PrIngestError(422, "projects must be a list of at most 16 project slugs.");
  }
  const slugs = new Set<string>();
  for (const value of body.projects) {
    if (typeof value !== "string" || !SLUG_RE.test(value)) {
      throw new PrIngestError(422, "projects must be a list of at most 16 project slugs.");
    }
    slugs.add(value);
  }
  return [...slugs].sort();
}

/** The review's own title, which defaults to the pull request's. Bounded to the 80
 *  characters a revision document allows, because that is where it lands. */
function titleField(body: Record<string, unknown>, fallback: string): string {
  if (body.title === undefined) return fallback.trim().slice(0, 80);
  if (typeof body.title !== "string" || body.title.trim() === "" || body.title.length > 80 ||
      hasLineBreak(body.title)) {
    throw new PrIngestError(422, "title must be one line of at most 80 characters.");
  }
  return body.title.trim();
}

function ingestFailure(err: unknown): Response {
  if (err instanceof PrIngestError) return prJson({ error: err.message }, err.status);
  if (err instanceof GithubAppRefusal) return prJson({ error: err.message }, 422);
  // Before the general arm, and deliberately not a `status === 0` rule: the same call
  // path throws a bare GithubError for a malformed compare response, which is the host's
  // fault and stays a 502. A named payload refusal is the caller's, and an automated
  // client must not retry it.
  if (err instanceof GithubPullPayloadError) return prJson({ error: err.message }, 422);
  if (err instanceof GithubError) return prJson({ error: err.message }, err.status === 404 ? 422 : 502);
  if (err && typeof err === "object" && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return prJson({ error: "This pull request is already reviewed in this workspace." }, 409);
  }
  console.error("[seer] pull request ingestion failed:", err);
  return prJson({ error: "Pull request ingestion failed." }, 502);
}

function reusedView(lineage: ReviewLineageRow, observation: ReviewPrObservationRow, revisionId: string): unknown {
  const revision = db.query<{ revision: number }, [string]>(
    "SELECT revision FROM review_revisions WHERE id = ?",
  ).get(revisionId);
  return {
    slug: lineage.slug,
    lineage: lineage.id,
    workspace: lineage.workspace_id,
    reused: true,
    revision: revision?.revision ?? null,
    url: revision ? `${config.baseUrl}/${lineage.workspace_id}/r/${lineage.slug}/rev/${revision.revision}` : null,
    apiUrl: `${config.baseUrl}/api/review-lineages/${lineage.slug}`,
    pullRequest: observationView(observation),
  };
}

/**
 * One outcome, three answers, and the status is the difference between them.
 *
 * 200 means there is a source revision to read: either these exact bytes were already
 * published, or the capture this key queued has since finished. 202 means work is
 * outstanding. 409 means the work failed and needs a decision — so the failure text and
 * the retry URL travel with it rather than being something to go and look up.
 */
function outcomeResponse(outcome: PrIngestOutcome): Response {
  if (outcome.kind === "reused") {
    return prJson(reusedView(outcome.lineage, outcome.observation, outcome.revisionId), 200);
  }
  const view = captureJobView(outcome.job, outcome.observation);
  if (outcome.job.state === "failed") {
    return prJson({ error: outcome.job.failure ?? "The pinned capture for this pull request failed.", job: view }, 409);
  }
  return prJson(view, outcome.job.state === "completed" ? 200 : 202);
}

/**
 * POST /api/pull-request-review-lineages — the first ingestion of a pull request.
 *
 * Everything cheap is checked before GitHub is called, and everything that can race is
 * checked again inside the transaction. Nothing publishes a source revision here: the
 * shell, the relation, the observation and one pinned capture job are what a caller gets,
 * and the revision arrives when the job completes.
 */
export async function handleCreatePullRequestLineage(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  try {
    const key = idempotencyKeyOf(req);
    const body = await readBody(req);
    onlyFields(body, ["repo", "number", "slug", "title", "projects"]);
    const repo = repoField(body);
    const number = numberField(body);
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
      throw new PrIngestError(422, "slug must match [a-z0-9][a-z0-9-]{0,63}.");
    }
    const slug = body.slug;
    const projects = projectsField(body);
    const requestHash = prRequestHash("create", null, {
      repo: repo.toLowerCase(), number, slug, title: body.title ?? null, projects,
    });

    const held = getPrIdempotency(auth.workspaceId, key);
    if (held) {
      if (held.request_hash !== requestHash) {
        return prJson({ error: "This Idempotency-Key was already used for a different pull request request." }, 409);
      }
      // Replayed before any GitHub call, which is the whole value of a replay.
      return outcomeResponse(replayPrOperation(auth.workspaceId, held));
    } else {
      // Said before a token is minted, because a slug collision is not GitHub's business
      // and the caller can fix it without one. Rechecked inside the transaction, because
      // this answer is already stale by the time GitHub replies.
      if (lineageOwnsSlug(auth.workspaceId, slug)) {
        return prJson({ error: `Review slug "${slug}" already names another promoted review` }, 409);
      }
      if (getReview(auth.workspaceId, slug)) {
        return prJson({ error: `Review slug "${slug}" already names a review in this workspace` }, 409);
      }
      for (const project of projects) {
        if (!getProject(auth.workspaceId, project)) {
          return prJson({ error: `No project "${project}" in this workspace` }, 422);
        }
      }
    }

    const session = await resolveReadSession(auth.workspaceId, repo, auth.userId);
    const observed = await observePullRequestThrough(session, repo, number);
    const outcome = ingestPullRequest({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      operation: "create",
      idempotencyKey: key,
      requestHash,
      slug,
      title: titleField(body, observed.facts.title),
      projects,
      actor: observed.actor,
      facts: observed.facts,
      legacyOwnsSlug: (candidate) => getReview(auth.workspaceId, candidate) !== null,
    });
    if (outcome.kind === "job" && outcome.job.state === "pending") scheduleActorQueue(outcome.job.actor_key);
    return outcomeResponse(outcome);
  } catch (err) {
    return ingestFailure(err);
  }
}

/**
 * POST /api/review-lineages/:slug/pull-request — a branch-first review gains its pull
 * request.
 *
 * The verification is the point. A lineage reviews a repository, a branch and a base; a
 * pull request that does not match all three is not this review's pull request, and
 * attaching it would silently change what the slug means.
 */
export async function handleAttachPullRequest(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!SLUG_RE.test(slug)) return softNotFound();
  const lineage = getLineage(auth.workspaceId, slug);
  if (!lineage) return softNotFound();
  try {
    const key = idempotencyKeyOf(req);
    const body = await readBody(req);
    onlyFields(body, ["repo", "number"]);
    const repo = repoField(body);
    const number = numberField(body);
    const requestHash = prRequestHash("attach", slug, { repo: repo.toLowerCase(), number });

    const held = getPrIdempotency(auth.workspaceId, key);
    if (held) {
      if (held.request_hash !== requestHash) {
        return prJson({ error: "This Idempotency-Key was already used for a different pull request request." }, 409);
      }
      return outcomeResponse(replayPrOperation(auth.workspaceId, held));
    }

    const session = await resolveReadSession(auth.workspaceId, repo, auth.userId);
    const observed = await observePullRequestThrough(session, repo, number, lineage.repo_id);
    const facts = observed.facts;
    if (facts.repoId !== lineage.repo_id) {
      throw new PrIngestError(422, `"${slug}" reviews repository ${lineage.repo_id} (${lineage.repo}), but ${repo}#${number} is on repository ${facts.repoId} (${facts.repo}).`);
    }
    if (facts.headRef !== lineage.branch) {
      throw new PrIngestError(422, `"${slug}" reviews branch ${lineage.branch}, but ${repo}#${number} is opened from ${facts.headRef}.`);
    }
    if (facts.baseRef !== lineage.original_base_ref) {
      throw new PrIngestError(422, `"${slug}" is based on ${lineage.original_base_ref}, but ${repo}#${number} targets ${facts.baseRef}.`);
    }

    const outcome = ingestPullRequest({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      operation: "attach",
      idempotencyKey: key,
      requestHash,
      slug,
      title: lineage.title,
      projects: [],
      actor: observed.actor,
      facts,
      legacyOwnsSlug: (candidate) => getReview(auth.workspaceId, candidate) !== null,
    });
    if (outcome.kind === "job" && outcome.job.state === "pending") scheduleActorQueue(outcome.job.actor_key);
    return outcomeResponse(outcome);
  } catch (err) {
    return ingestFailure(err);
  }
}

/**
 * POST /api/review-lineages/:slug/refresh — observe again, through the stored actor.
 *
 * The stored actor and not a freshly resolved one: a review attached through a member's
 * connected account must keep being read as that member, and re-resolving would let a
 * second member's request quietly move the attribution — or, worse, spend the first
 * member's credential on their behalf, which the ownership check below refuses outright.
 *
 * Task 5 records what moved. Publishing a later revision from it is task 6.
 */
export async function handleRefreshLineagePullRequest(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!SLUG_RE.test(slug)) return softNotFound();
  const lineage = getLineage(auth.workspaceId, slug);
  if (!lineage) return softNotFound();
  const relation = getLineagePr(auth.workspaceId, lineage.id);
  if (!relation) return softNotFound();
  try {
    const key = idempotencyKeyOf(req);
    const requestHash = prRequestHash("refresh", slug, {});
    // Ownership before replay, and before GitHub: who may ask is not a question a stored
    // answer gets to skip.
    const actor = readActorOf(relation);
    if (actor.kind === "user" && actor.userId !== auth.userId) {
      throw new PrIngestError(403, `"${slug}" is refreshed through another member's GitHub connection, which only they can spend.`);
    }
    const replayed = getPrIdempotency(auth.workspaceId, key);
    if (replayed) {
      if (replayed.request_hash !== requestHash) {
        return prJson({ error: "This Idempotency-Key was already used for a different pull request request." }, 409);
      }
      const stored = getObservation(auth.workspaceId, replayed.observation_id);
      // Replayed before a token is minted, which is the whole value of a replay. The
      // capture state is re-read rather than remembered, so a replay after the work
      // finished says so instead of repeating the pending answer.
      if (stored) {
        return prJson(refreshView(lineage, actor, {
          observation: stored,
          job: replayed.capture_job_id ? getCaptureJob(auth.workspaceId, replayed.capture_job_id) : null,
          sourceRevisionId: replayed.revision_id,
        }));
      }
    }
    const session = await openReadSession(auth.workspaceId, actor, relation.repo, relation.repo_id);
    const observed = await observePullRequestThrough(session, relation.repo, relation.pr_number, relation.repo_id);
    if (observed.facts.repoId !== relation.repo_id) {
      throw new PrIngestError(422, `${relation.repo}#${relation.pr_number} now resolves to repository ${observed.facts.repoId}, not the attached ${relation.repo_id}.`);
    }
    const outcome = refreshLineageObservation({
      workspaceId: auth.workspaceId,
      idempotencyKey: key,
      requestHash,
      lineage,
      actor,
      facts: observed.facts,
    });
    // After the transaction committed, exactly as ingestion does it: a lane driven from
    // inside would be capturing against rows that might still roll back.
    if (outcome.job && outcome.job.state === "pending") scheduleActorQueue(outcome.job.actor_key);
    return prJson(refreshView(getLineage(auth.workspaceId, slug) ?? lineage, actor, outcome));
  } catch (err) {
    return ingestFailure(err);
  }
}

/**
 * What a refresh answers with: the reading, who took it, whether the latest source revision
 * is behind it, and what is being done about that.
 *
 * Always 200, and the capture state travels in the body rather than in the status. The
 * refresh itself completed — the observation is stored and will not be taken back — and a
 * caller that reads a 202 as "nothing was recorded" would refresh again for nothing.
 * `captureJob` is the work; `sourceRevision` is the revision these exact bytes already
 * published, which is the case where there is no work at all.
 */
function refreshView(
  lineage: ReviewLineageRow,
  actor: ReadActor,
  outcome: RefreshOutcome,
): unknown {
  const observation = outcome.observation;
  const latest = lineage.latest_revision === null
    ? null
    : getRevision(lineage.workspace_id, lineage.slug, lineage.latest_revision);
  const behind = latest === null || latest.doc.source.sourceHeadSha !== observation.head_sha ||
    latest.doc.source.baseTipSha !== observation.base_sha ||
    latest.doc.source.mergeBaseSha !== observation.merge_base_sha;
  const source = outcome.sourceRevisionId
    ? db.query<{ revision: number }, [string]>("SELECT revision FROM review_revisions WHERE id = ?").get(outcome.sourceRevisionId)
    : null;
  return {
    slug: lineage.slug,
    lineage: lineage.id,
    workspace: lineage.workspace_id,
    revision: latest?.revision ?? null,
    sourceRevision: source?.revision ?? null,
    captureJob: outcome.job ? captureJobView(outcome.job, getObservation(lineage.workspace_id, outcome.job.observation_id)) : null,
    behind,
    actor: actor.kind,
    actorLabel: actorWords(actor),
    pullRequest: observationView(observation),
  };
}
