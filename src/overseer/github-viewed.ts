import { randomBytes } from "node:crypto";
import { db } from "../db";
import { tinyId } from "../ids";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import { listRevisionAcknowledgements } from "./acknowledgements-db";
import { personalGithubGraphqlClient, type FileViewedState } from "./github-graphql";
import { projectionFailure } from "./github-projection-errors";
import { getGithubUserCredential } from "./user-credentials";
import {
  getLineage,
  getRevision,
  listRevisionReadChangeIds,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import { requiredAcknowledgements } from "./revision-delta";
import { getLineagePr, latestObservation } from "./revision-pr";

export const PROJECTION_LEASE_MS = 120_000;
export const PROJECTION_ATTEMPTS_MAX = 5;

export type GithubViewedJobState =
  | "pending" | "running" | "synced" | "foreign" | "failed" | "refused" | "unknown" | "stale";

export interface GithubProjectionPreferenceRow {
  workspace_id: string;
  lineage_id: string;
  user_id: string;
  credential_id: string;
  viewed_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface GithubViewedJobRow {
  id: string;
  workspace_id: string;
  lineage_id: string;
  revision_id: string;
  user_id: string;
  credential_id: string;
  path: string;
  head_sha: string;
  desired: "viewed" | "unviewed";
  generation: number;
  state: GithubViewedJobState;
  attempts: number;
  failure_code: string | null;
  failure: string | null;
  retry_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GithubViewedOwnershipRow {
  workspace_id: string;
  lineage_id: string;
  user_id: string;
  credential_id: string;
  revision_id: string;
  head_sha: string;
  path: string;
  pre_state: "UNVIEWED" | "DISMISSED";
  mark_job_id: string;
  marked_at: number;
  unmarked_at: number | null;
  lost_at: number | null;
}

interface GithubViewedCredentialSubstitutionRow {
  job_id: string;
  generation: number;
  workspace_id: string;
  user_id: string;
  ownership_credential_id: string;
  credential_id: string;
  account_login: string;
  account_id: number;
  substituted_at: number;
}

export interface FileHandlingState {
  complete: boolean;
  changes: { total: number; read: number };
  gaps: { total: number; acknowledged: number };
}

export interface GithubViewedStatusView {
  path: string;
  desired: "viewed" | "unviewed";
  state: GithubViewedJobState;
  failure: string | null;
  retryAt: string | null;
  retryable: boolean;
}

function lineageById(workspaceId: string, lineageId: string): ReviewLineageRow | null {
  const row = db.query<{ slug: string }, [string, string]>(
    "SELECT slug FROM review_lineages WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, lineageId);
  return row ? getLineage(workspaceId, row.slug) : null;
}

function revisionInventory(workspaceId: string, revision: ReviewRevisionRow): StageCaptureInventory | null {
  return getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
}

export function getGithubProjectionPreference(
  workspaceId: string,
  lineageId: string,
  userId: string,
): GithubProjectionPreferenceRow | null {
  return db.query<GithubProjectionPreferenceRow, [string, string, string]>(
    "SELECT * FROM review_github_projection_preferences WHERE workspace_id = ? AND lineage_id = ? AND user_id = ?",
  ).get(workspaceId, lineageId, userId);
}

export function setGithubProjectionPreference(input: {
  workspaceId: string;
  lineageId: string;
  userId: string;
  credentialId: string;
  enabled: boolean;
  now?: number;
}): GithubProjectionPreferenceRow {
  const now = input.now ?? Date.now();
  db.run(
    "INSERT INTO review_github_projection_preferences (workspace_id,lineage_id,user_id,credential_id,viewed_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(lineage_id,user_id) DO UPDATE SET workspace_id=excluded.workspace_id,credential_id=excluded.credential_id,viewed_enabled=excluded.viewed_enabled,updated_at=excluded.updated_at",
    [input.workspaceId, input.lineageId, input.userId, input.credentialId, input.enabled ? 1 : 0, now, now],
  );
  return getGithubProjectionPreference(input.workspaceId, input.lineageId, input.userId)!;
}

function pathFile(inventory: StageCaptureInventory, path: string) {
  return inventory.files.find((file) => file.path === path) ?? null;
}

export function fileHandlingState(
  workspaceId: string,
  lineageId: string,
  revisionId: string,
  userId: string,
  path: string,
): FileHandlingState {
  const revision = db.query<{ slug: string; revision: number }, [string, string, string]>(
    "SELECT slug, revision FROM review_revisions WHERE workspace_id = ? AND lineage_id = ? AND id = ?",
  ).get(workspaceId, lineageId, revisionId);
  const parsed = revision ? getRevision(workspaceId, revision.slug, revision.revision) : null;
  const inventory = parsed ? revisionInventory(workspaceId, parsed) : null;
  if (!inventory) return { complete: false, changes: { total: 0, read: 0 }, gaps: { total: 0, acknowledged: 0 } };
  return fileHandlingStateFromInventory(workspaceId, revisionId, userId, path, inventory);
}

function fileHandlingStates(
  workspaceId: string,
  revisionId: string,
  userId: string,
  inventory: StageCaptureInventory,
): Map<string, FileHandlingState> {
  const reads = listRevisionReadChangeIds(workspaceId, revisionId, userId);
  const acknowledgements = listRevisionAcknowledgements(workspaceId, revisionId, userId);
  const filesById = new Map(inventory.files.map((file) => [file.id, file]));
  const states = new Map(inventory.files.map((file) => [file.path, {
    complete: false,
    changes: { total: 0, read: 0 },
    gaps: { total: 0, acknowledged: 0 },
  }]));
  for (const change of inventory.changes) {
    const file = filesById.get(change.file_id);
    const state = file ? states.get(file.path) : null;
    if (!state) continue;
    state.changes.total += 1;
    if (reads.has(change.id)) state.changes.read += 1;
  }
  for (const item of requiredAcknowledgements(inventory)) {
    // Capture-wide material has no file id and deliberately contributes to no path.
    const file = item.fileId ? filesById.get(item.fileId) : null;
    const state = file ? states.get(file.path) : null;
    if (!state) continue;
    state.gaps.total += 1;
    if (acknowledgements.has(item.id)) state.gaps.acknowledged += 1;
  }
  for (const state of states.values()) {
    state.complete = state.changes.read === state.changes.total &&
      state.gaps.acknowledged === state.gaps.total;
  }
  return states;
}

export function fileHandlingStateFromInventory(
  workspaceId: string,
  revisionId: string,
  userId: string,
  path: string,
  inventory: StageCaptureInventory,
): FileHandlingState {
  return fileHandlingStates(workspaceId, revisionId, userId, inventory).get(path) ??
    { complete: false, changes: { total: 0, read: 0 }, gaps: { total: 0, acknowledged: 0 } };
}

function activeOwnership(lineageId: string, userId: string, path: string): GithubViewedOwnershipRow | null {
  return db.query<GithubViewedOwnershipRow, [string, string, string]>(
    "SELECT * FROM review_github_viewed_ownership WHERE lineage_id = ? AND user_id = ? AND path = ? AND unmarked_at IS NULL AND lost_at IS NULL",
  ).get(lineageId, userId, path);
}

function queueJob(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  credentialId: string;
  path: string;
  headSha: string;
  desired: "viewed" | "unviewed";
  now: number;
  force?: boolean;
}): GithubViewedJobRow | null {
  const held = db.query<GithubViewedJobRow, [string, string, string]>(
    "SELECT * FROM review_github_viewed_jobs WHERE lineage_id = ? AND user_id = ? AND path = ?",
  ).get(input.lineageId, input.userId, input.path);
  const owned = activeOwnership(input.lineageId, input.userId, input.path);
  if (!held && input.desired === "unviewed" && !owned) return null;
  if (!held) {
    const id = tinyId("gvp");
    db.run(
      "INSERT INTO review_github_viewed_jobs (id,workspace_id,lineage_id,revision_id,user_id,credential_id,path,head_sha,desired,generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'pending',?,?)",
      [id, input.workspaceId, input.lineageId, input.revisionId, input.userId, input.credentialId, input.path, input.headSha, input.desired, input.now, input.now],
    );
    return getGithubViewedJob(id);
  }
  const changed = held.revision_id !== input.revisionId || held.credential_id !== input.credentialId ||
    held.head_sha !== input.headSha || held.desired !== input.desired;
  if (!changed && !input.force) return held;
  const leased = held.state === "running" && (held.lease_expires_at ?? 0) > input.now;
  if (leased) {
    // Keep the exact lane and lease the holder claimed. Its generation check will stop
    // before another mutation, then release or expiry lets the replacement reconcile.
    db.run(
      "UPDATE review_github_viewed_jobs SET revision_id=?,head_sha=?,desired=?,generation=generation+1,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?",
      [input.revisionId, input.headSha, input.desired, input.now, held.id, held.lease_token, input.now],
    );
  } else {
    db.run(
      "UPDATE review_github_viewed_jobs SET workspace_id=?,revision_id=?,credential_id=?,head_sha=?,desired=?,generation=generation+1,state='pending',attempts=0,failure_code=NULL,failure=NULL,retry_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
      [input.workspaceId, input.revisionId, input.credentialId, input.headSha, input.desired, input.now, held.id],
    );
  }
  return getGithubViewedJob(held.id);
}

export function getGithubViewedJob(id: string): GithubViewedJobRow | null {
  return db.query<GithubViewedJobRow, [string]>("SELECT * FROM review_github_viewed_jobs WHERE id = ?").get(id);
}

/** Recompute every current file after one local handling write. This is intentionally
 * broad: a late read or acknowledgement can carry through several already-published
 * revisions, and scanning the current retained inventory is the bounded way to avoid
 * missing the final path that changed. */
export function queueCurrentViewedJobs(input: {
  workspaceId: string;
  lineageId: string;
  userId: string;
  completeOnly?: boolean;
  forcePaths?: ReadonlySet<string>;
  now?: number;
}): string | null {
  const now = input.now ?? Date.now();
  const preference = getGithubProjectionPreference(input.workspaceId, input.lineageId, input.userId);
  if (!preference || preference.viewed_enabled !== 1) return null;
  const lineage = lineageById(input.workspaceId, input.lineageId);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(input.workspaceId, lineage.slug, lineage.latest_revision);
  const observation = lineage ? latestObservation(input.workspaceId, lineage.id) : null;
  const inventory = revision ? revisionInventory(input.workspaceId, revision) : null;
  // A push observation lands before its retained revision. Local handling remains
  // authoritative during that gap, while existing ownership and work wait untouched.
  if (!lineage || !revision || !observation || !inventory || observation.head_sha !== revision.doc.source.sourceHeadSha) return null;
  const currentPaths = new Set(inventory.files.map((file) => file.path));
  // Path is part of GitHub's file identity. Once an exact retained revision proves the
  // path absent, that old ownership cannot be addressed at the current pull request.
  db.run(
    `UPDATE review_github_viewed_ownership SET lost_at=? WHERE workspace_id=? AND lineage_id=? AND user_id=? AND path NOT IN (${inventory.files.length ? inventory.files.map(() => "?").join(",") : "''"}) AND unmarked_at IS NULL AND lost_at IS NULL`,
    [now, input.workspaceId, input.lineageId, input.userId, ...currentPaths],
  );
  const handlingByPath = fileHandlingStates(input.workspaceId, revision.id, input.userId, inventory);
  db.run(
    `UPDATE review_github_viewed_jobs SET generation=generation+1,updated_at=? WHERE workspace_id=? AND lineage_id=? AND user_id=? AND path NOT IN (${inventory.files.length ? inventory.files.map(() => "?").join(",") : "''"}) AND state='running' AND lease_expires_at>?`,
    [now, input.workspaceId, input.lineageId, input.userId, ...currentPaths, now],
  );
  db.run(
    `UPDATE review_github_viewed_jobs SET state='stale',failure_code='path_absent',failure='The file is no longer in the current pull request.',retry_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND lineage_id=? AND user_id=? AND path NOT IN (${inventory.files.length ? inventory.files.map(() => "?").join(",") : "''"}) AND state IN ('pending','failed','running') AND (state<>'running' OR lease_expires_at<=?)`,
    [now, input.workspaceId, input.lineageId, input.userId, ...currentPaths, now],
  );
  for (const file of inventory.files) {
    const handling = handlingByPath.get(file.path)!;
    const existing = db.query<GithubViewedJobRow, [string, string, string]>(
      "SELECT * FROM review_github_viewed_jobs WHERE lineage_id=? AND user_id=? AND path=?",
    ).get(lineage.id, input.userId, file.path);
    const ownership = activeOwnership(lineage.id, input.userId, file.path);
    if (!handling.complete && input.completeOnly && !existing && !ownership) continue;
    if (!handling.complete && !existing && !ownership) continue;
    queueJob({
      workspaceId: input.workspaceId,
      lineageId: lineage.id,
      revisionId: revision.id,
      userId: input.userId,
      credentialId: !handling.complete && ownership ? ownership.credential_id : preference.credential_id,
      path: file.path,
      headSha: revision.doc.source.sourceHeadSha,
      desired: handling.complete ? "viewed" : "unviewed",
      now,
      force: input.forcePaths?.has(file.path),
    });
  }
  return preference.credential_id;
}

function usableViewedCredential(userId: string, credentialId: string, now: number) {
  const credential = getGithubUserCredential(credentialId, userId);
  return credential && credential.revoked_at === null && credential.dead_at === null &&
    (credential.expires_at === null || credential.expires_at > now) ? credential : null;
}

function removalCredential(
  ownership: GithubViewedOwnershipRow,
  preference: GithubProjectionPreferenceRow | null,
  now: number,
): { credentialId: string; substitution: null | { accountLogin: string; accountId: number } } {
  if (usableViewedCredential(ownership.user_id, ownership.credential_id, now)) {
    return { credentialId: ownership.credential_id, substitution: null };
  }
  const original = getGithubUserCredential(ownership.credential_id, ownership.user_id);
  const replacement = preference ? usableViewedCredential(ownership.user_id, preference.credential_id, now) : null;
  if (!original || !replacement) {
    throw new Error("Remove Seer marks needs a live current GitHub preference for the same account as the expired ownership credential.");
  }
  if (original.account_id !== replacement.account_id || original.account_login.toLowerCase() !== replacement.account_login.toLowerCase()) {
    throw new Error("Remove Seer marks refused the current GitHub preference because it belongs to a different GitHub account.");
  }
  return { credentialId: replacement.id, substitution: { accountLogin: original.account_login, accountId: original.account_id } };
}

function recordViewedCredentialSubstitution(
  job: GithubViewedJobRow,
  ownership: GithubViewedOwnershipRow,
  credentialId: string,
  account: { accountLogin: string; accountId: number },
  now: number,
): void {
  db.run(
    "INSERT INTO review_github_viewed_credential_substitutions (job_id,generation,workspace_id,user_id,ownership_credential_id,credential_id,account_login,account_id,substituted_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,generation) DO NOTHING",
    [job.id, job.generation, job.workspace_id, job.user_id, ownership.credential_id, credentialId, account.accountLogin, account.accountId, now],
  );
}

export function queueOwnedMarksForRemoval(input: {
  workspaceId: string;
  lineageId: string;
  userId: string;
  now?: number;
}): string[] {
  const now = input.now ?? Date.now();
  const lineage = lineageById(input.workspaceId, input.lineageId);
  if (!lineage) return [];
  const currentRevision = lineage.latest_revision === null ? null : getRevision(input.workspaceId, lineage.slug, lineage.latest_revision);
  const observation = latestObservation(input.workspaceId, input.lineageId);
  if (!currentRevision || !observation || observation.head_sha !== currentRevision.doc.source.sourceHeadSha) return [];
  const inventory = revisionInventory(input.workspaceId, currentRevision);
  if (!inventory) return [];
  const currentPaths = new Set(inventory.files.map((file) => file.path));
  const rows = db.query<GithubViewedOwnershipRow, [string, string, string]>(
    "SELECT * FROM review_github_viewed_ownership WHERE workspace_id=? AND lineage_id=? AND user_id=? AND unmarked_at IS NULL AND lost_at IS NULL ORDER BY path",
  ).all(input.workspaceId, input.lineageId, input.userId).filter((row) => currentPaths.has(row.path));
  const preference = getGithubProjectionPreference(input.workspaceId, input.lineageId, input.userId);
  // Resolve every actor before changing a job. One mismatched account refuses the whole
  // removal request rather than spending a credential for a different GitHub viewer.
  const planned = rows.map((ownership) => ({ ownership, ...removalCredential(ownership, preference, now) }));
  const credentials = new Set<string>();
  for (const item of planned) {
    const job = queueJob({ workspaceId: input.workspaceId, lineageId: input.lineageId, revisionId: currentRevision.id, userId: input.userId, credentialId: item.credentialId, path: item.ownership.path, headSha: currentRevision.doc.source.sourceHeadSha, desired: "unviewed", now, force: true });
    if (!job) continue;
    if (item.substitution) recordViewedCredentialSubstitution(job, item.ownership, item.credentialId, item.substitution, now);
    credentials.add(item.credentialId);
  }
  return [...credentials];
}

/** Queue the exact just-published revision after read and acknowledgement carry. The
 * caller owns the publication transaction; this performs no network work or scheduling. */
export function queueViewedJobsForPublishedRevision(input: {
  workspaceId: string;
  lineageId: string;
  now?: number;
}): string[] {
  const preferences = db.query<{ user_id: string; credential_id: string }, [string, string]>(
    "SELECT user_id,credential_id FROM review_github_projection_preferences WHERE workspace_id=? AND lineage_id=? AND viewed_enabled=1 ORDER BY user_id",
  ).all(input.workspaceId, input.lineageId);
  const credentials = new Set<string>();
  for (const preference of preferences) {
    queueCurrentViewedJobs({ workspaceId: input.workspaceId, lineageId: input.lineageId, userId: preference.user_id, completeOnly: true, now: input.now });
    credentials.add(preference.credential_id);
    for (const queued of queuedGithubViewedCredentials(input.workspaceId, input.lineageId, preference.user_id)) credentials.add(queued);
  }
  return [...credentials];
}

export function retryGithubViewed(input: {
  workspaceId: string;
  lineageId: string;
  userId: string;
  path?: string | null;
  now?: number;
}): string | null {
  const paths = input.path ? new Set([input.path]) : new Set(db.query<{ path: string }, [string, string, string]>(
    "SELECT path FROM review_github_viewed_jobs WHERE workspace_id=? AND lineage_id=? AND user_id=? AND state IN ('failed','refused','unknown','stale')",
  ).all(input.workspaceId, input.lineageId, input.userId).map((row) => row.path));
  return queueCurrentViewedJobs({ ...input, forcePaths: paths, now: input.now });
}

export function listGithubViewedStatus(
  workspaceId: string,
  lineageId: string,
  userId: string,
): GithubViewedStatusView[] {
  return db.query<GithubViewedJobRow, [string, string, string]>(
    "SELECT * FROM review_github_viewed_jobs WHERE workspace_id=? AND lineage_id=? AND user_id=? ORDER BY path",
  ).all(workspaceId, lineageId, userId).map((row) => ({
    path: row.path,
    desired: row.desired,
    state: row.state,
    failure: row.failure,
    retryAt: row.retry_at === null ? null : new Date(row.retry_at).toISOString(),
    retryable: ["failed", "refused", "unknown", "stale"].includes(row.state) && row.failure_code !== "credential_dead",
  }));
}

export function countActiveGithubViewedOwnership(workspaceId: string, lineageId: string, userId: string): number {
  return db.query<{ count: number }, [string, string, string]>(
    "SELECT COUNT(*) AS count FROM review_github_viewed_ownership WHERE workspace_id=? AND lineage_id=? AND user_id=? AND unmarked_at IS NULL AND lost_at IS NULL",
  ).get(workspaceId, lineageId, userId)?.count ?? 0;
}

function claimViewedJob(credentialId: string, now = Date.now()): GithubViewedJobRow | null {
  return db.transaction(() => {
    const rate = db.query<{ retry_after: number | null }, [string]>(
      "SELECT retry_after FROM github_graphql_rate_limits WHERE credential_id=?",
    ).get(credentialId);
    if ((rate?.retry_after ?? 0) > now) {
      db.run("UPDATE review_github_viewed_jobs SET state='failed',failure_code='rate_limited',failure='GitHub rate-limited this personal credential.',retry_at=?,updated_at=? WHERE credential_id=? AND state='pending'", [rate!.retry_after, now, credentialId]);
      return null;
    }
    const occupied = db.query<{ one: number }, [string, number, string, number]>(
      "SELECT 1 AS one FROM review_github_viewed_jobs WHERE credential_id=? AND state='running' AND lease_expires_at>? UNION ALL SELECT 1 AS one FROM review_github_submissions WHERE credential_id=? AND state='running' AND lease_expires_at>? LIMIT 1",
    ).get(credentialId, now, credentialId, now);
    if (occupied) return null;
    const candidate = db.query<{ id: string }, [string, number, number, number]>(
      "SELECT id FROM review_github_viewed_jobs WHERE credential_id=? AND (state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?)) ORDER BY updated_at,id LIMIT 1",
    ).get(credentialId, PROJECTION_ATTEMPTS_MAX, now, now);
    if (!candidate) return null;
    const lease = randomBytes(24).toString("base64url");
    db.run(
      "UPDATE review_github_viewed_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,failure_code=NULL,failure=NULL,retry_at=NULL,updated_at=? WHERE id=? AND credential_id=? AND (state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?))",
      [lease, now + PROJECTION_LEASE_MS, now, candidate.id, credentialId, PROJECTION_ATTEMPTS_MAX, now, now],
    );
    const row = getGithubViewedJob(candidate.id);
    return row?.lease_token === lease ? row : null;
  })();
}

function stillOwns(job: GithubViewedJobRow): boolean {
  const current = getGithubViewedJob(job.id);
  return current?.state === "running" && current.generation === job.generation &&
    current.lease_token === job.lease_token && (current.lease_expires_at ?? 0) > Date.now();
}

function finish(job: GithubViewedJobRow, state: GithubViewedJobState, code: string | null, failure: string | null, retryAt: number | null): void {
  const finished = db.run(
    "UPDATE review_github_viewed_jobs SET state=?,failure_code=?,failure=?,retry_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND generation=? AND state='running' AND lease_token=?",
    [state, code, failure, retryAt, Date.now(), job.id, job.generation, job.lease_token],
  ).changes === 1;
  if (!finished) releaseSupersededViewedLease(job);
}

function validateStoredTarget(job: GithubViewedJobRow): {
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  repo: string;
  number: number;
  ownership: GithubViewedOwnershipRow | null;
} | null {
  const preference = getGithubProjectionPreference(job.workspace_id, job.lineage_id, job.user_id);
  const lineage = lineageById(job.workspace_id, job.lineage_id);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(job.workspace_id, lineage.slug, lineage.latest_revision);
  const relation = lineage ? getLineagePr(job.workspace_id, lineage.id) : null;
  const observation = lineage ? latestObservation(job.workspace_id, lineage.id) : null;
  if (!lineage || !revision || !relation || !observation || revision.id !== job.revision_id ||
      revision.doc.source.sourceHeadSha !== job.head_sha || observation.head_sha !== job.head_sha) return null;
  const handling = fileHandlingState(job.workspace_id, job.lineage_id, job.revision_id, job.user_id, job.path);
  const ownership = activeOwnership(job.lineage_id, job.user_id, job.path);
  if (job.desired === "viewed") {
    if (!preference || preference.viewed_enabled !== 1 || preference.credential_id !== job.credential_id || !handling.complete) return null;
  } else if (ownership && ownership.credential_id !== job.credential_id) {
    const substitution = db.query<GithubViewedCredentialSubstitutionRow, [string, number, string, string]>(
      "SELECT * FROM review_github_viewed_credential_substitutions WHERE job_id=? AND generation=? AND ownership_credential_id=? AND credential_id=?",
    ).get(job.id, job.generation, ownership.credential_id, job.credential_id);
    if (!substitution) return null;
  }
  return { lineage, revision, repo: observation.repo, number: observation.pr_number, ownership };
}

function viewedCredentialFailure(job: GithubViewedJobRow): string | null {
  const credential = getGithubUserCredential(job.credential_id, job.user_id);
  if (!credential) return "The GitHub credential used for Viewed sync is no longer available. Choose another credential to resume sync.";
  if (credential.revoked_at !== null) return "The GitHub credential used for Viewed sync was revoked. Choose another credential to resume sync.";
  if (credential.dead_at !== null) return "GitHub no longer accepts the credential used for Viewed sync. Reconnect it or choose another credential.";
  if (credential.expires_at !== null && credential.expires_at <= Date.now()) return "The GitHub credential used for Viewed sync expired. Choose another credential to resume sync.";
  return null;
}

function disableDeadViewedPreference(job: GithubViewedJobRow): void {
  db.run(
    "UPDATE review_github_projection_preferences SET viewed_enabled=0,updated_at=? WHERE workspace_id=? AND lineage_id=? AND user_id=? AND credential_id=? AND viewed_enabled=1",
    [Date.now(), job.workspace_id, job.lineage_id, job.user_id, job.credential_id],
  );
}

function fileState(files: { path: string; viewerViewedState: FileViewedState }[], path: string): FileViewedState | null {
  return files.find((file) => file.path === path)?.viewerViewedState ?? null;
}

function releaseSupersededViewedLease(job: GithubViewedJobRow): boolean {
  const current = getGithubViewedJob(job.id);
  if (!current || current.state !== "running" || current.lease_token !== job.lease_token || current.generation === job.generation) return false;
  const lineage = lineageById(current.workspace_id, current.lineage_id);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(current.workspace_id, lineage.slug, lineage.latest_revision);
  const observation = lineage ? latestObservation(current.workspace_id, lineage.id) : null;
  const inventory = revision ? revisionInventory(current.workspace_id, revision) : null;
  const exact = !!revision && !!observation && !!inventory && revision.id === current.revision_id &&
    revision.doc.source.sourceHeadSha === current.head_sha && observation.head_sha === current.head_sha &&
    inventory.files.some((file) => file.path === current.path);
  const ownership = activeOwnership(current.lineage_id, current.user_id, current.path);
  const preference = getGithubProjectionPreference(current.workspace_id, current.lineage_id, current.user_id);
  const substitution = current.desired === "unviewed" && ownership ? db.query<GithubViewedCredentialSubstitutionRow, [string, number, string]>(
    "SELECT * FROM review_github_viewed_credential_substitutions WHERE job_id=? AND generation=? AND ownership_credential_id=?",
  ).get(current.id, current.generation, ownership.credential_id) : null;
  const credentialId = substitution?.credential_id ?? (current.desired === "unviewed" && ownership ? ownership.credential_id
    : current.desired === "viewed" && preference ? preference.credential_id : current.credential_id);
  const released = db.run(
    "UPDATE review_github_viewed_jobs SET credential_id=?,state=?,attempts=0,failure_code=?,failure=?,retry_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND generation=?",
    [credentialId, exact ? "pending" : "stale", exact ? null : "path_absent", exact ? null : "The file is no longer in the current pull request.", Date.now(), current.id, job.lease_token, current.generation],
  ).changes === 1;
  if (released && exact) {
    queueMicrotask(() => void import("./github-projection-worker")
      .then(({ scheduleGithubProjectionCredential }) => scheduleGithubProjectionCredential(credentialId))
      .catch((error) => console.error("[seer] could not schedule superseding Viewed projection:", error)));
  }
  return released;
}

function storedHeadStillCurrent(job: GithubViewedJobRow): boolean {
  const lineage = lineageById(job.workspace_id, job.lineage_id);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(job.workspace_id, lineage.slug, lineage.latest_revision);
  const relation = lineage ? getLineagePr(job.workspace_id, lineage.id) : null;
  const observation = lineage ? latestObservation(job.workspace_id, lineage.id) : null;
  return !!revision && !!relation && !!observation && revision.id === job.revision_id &&
    revision.doc.source.sourceHeadSha === job.head_sha && observation.head_sha === job.head_sha;
}

async function runViewedJob(job: GithubViewedJobRow): Promise<void> {
  try {
    if (!stillOwns(job)) {
      releaseSupersededViewedLease(job);
      return;
    }
    const credentialFailure = viewedCredentialFailure(job);
    if (credentialFailure) {
      disableDeadViewedPreference(job);
      finish(job, "refused", "credential_dead", credentialFailure, null);
      return;
    }
    const target = validateStoredTarget(job);
    if (!target) { finish(job, "stale", "target_moved", "The exact pull request revision, file, or handling state moved before projection.", null); return; }
    if (job.desired === "unviewed" && !target.ownership) {
      finish(job, "synced", null, null, null);
      return;
    }
    const client = personalGithubGraphqlClient(job.user_id, job.credential_id);
    const before = await client.pullRequest(target.repo, target.number);
    if (before.rate.remaining === 0) {
      finish(job, "failed", "rate_limited", "GitHub's GraphQL budget is exhausted for this credential.", before.rate.resetAt);
      return;
    }
    if (before.filesTruncated) { finish(job, "refused", "files_unbounded", "GitHub returned more than 2,000 changed files, so Viewed projection was refused.", null); return; }
    if (before.headRefOid !== job.head_sha) { finish(job, "stale", "head_moved_before", "The pull request head moved before projection.", null); return; }
    const beforeState = fileState(before.files, job.path);
    if (!beforeState) { finish(job, "stale", "path_absent", "The file is no longer in the pull request.", null); return; }
    if (job.desired === "viewed" && beforeState === "VIEWED") {
      finish(job, target.ownership ? "synced" : "foreign", null, null, null);
      return;
    }
    if (job.desired === "unviewed" && beforeState !== "VIEWED") {
      db.run("UPDATE review_github_viewed_ownership SET lost_at=? WHERE lineage_id=? AND user_id=? AND path=? AND unmarked_at IS NULL AND lost_at IS NULL", [Date.now(), job.lineage_id, job.user_id, job.path]);
      finish(job, "synced", null, null, null);
      return;
    }
    if (!stillOwns(job)) {
      releaseSupersededViewedLease(job);
      return;
    }
    if (job.desired === "viewed") {
      await client.markFileAsViewed(before.id, job.path, `${job.id}:${job.generation}:mark`);
    } else {
      await client.unmarkFileAsViewed(before.id, job.path, `${job.id}:${job.generation}:unmark`);
    }
    const after = await client.pullRequest(target.repo, target.number);
    const afterState = fileState(after.files, job.path);
    const now = Date.now();
    db.transaction(() => {
      const moved = after.headRefOid !== job.head_sha;
      const storedCurrent = storedHeadStillCurrent(job);
      const confirmed = job.desired === "viewed" ? afterState === "VIEWED" : afterState !== "VIEWED";
      if (job.desired === "viewed" && confirmed) {
        db.run(
          "INSERT INTO review_github_viewed_ownership (workspace_id,lineage_id,user_id,credential_id,revision_id,head_sha,path,pre_state,mark_job_id,marked_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lineage_id,user_id,path) DO UPDATE SET workspace_id=excluded.workspace_id,credential_id=excluded.credential_id,revision_id=excluded.revision_id,head_sha=excluded.head_sha,pre_state=excluded.pre_state,mark_job_id=excluded.mark_job_id,marked_at=excluded.marked_at,unmarked_at=NULL,lost_at=NULL",
          [job.workspace_id, job.lineage_id, job.user_id, job.credential_id, job.revision_id, job.head_sha, job.path, beforeState, job.id, now],
        );
      } else if (job.desired === "unviewed" && confirmed) {
        db.run("UPDATE review_github_viewed_ownership SET unmarked_at=? WHERE lineage_id=? AND user_id=? AND path=? AND unmarked_at IS NULL AND lost_at IS NULL", [now, job.lineage_id, job.user_id, job.path]);
      }
      if (releaseSupersededViewedLease(job)) return;
      const headStale = moved || !storedCurrent;
      finish(job, headStale ? "failed" : confirmed ? "synced" : "failed", headStale ? "head_moved_during" : confirmed ? null : "state_unconfirmed", headStale ? "The pull request head moved during projection." : confirmed ? null : "GitHub did not confirm the requested Viewed state.", null);
    })();
  } catch (error) {
    const failure = projectionFailure(error, job.attempts);
    if (failure.state === "unknown" && job.desired === "unviewed") {
      try {
        const target = validateStoredTarget(job);
        if (target) {
          const current = await personalGithubGraphqlClient(job.user_id, job.credential_id).pullRequest(target.repo, target.number);
          if (current.headRefOid === job.head_sha && fileState(current.files, job.path) !== "VIEWED") {
            db.run("UPDATE review_github_viewed_ownership SET lost_at=? WHERE lineage_id=? AND user_id=? AND path=? AND unmarked_at IS NULL AND lost_at IS NULL", [Date.now(), job.lineage_id, job.user_id, job.path]);
            finish(job, "synced", null, null, null);
            return;
          }
        }
      } catch {}
    }
    if (failure.code === "credential_dead") disableDeadViewedPreference(job);
    finish(job, failure.state, failure.code, failure.message, failure.retryAt);
  }
}

/** Run one durable Viewed unit for a credential. The shared projection scheduler calls
 * this and submission work serially, so one personal credential has one mutation in
 * flight in this process. */
export async function runNextGithubViewedJob(credentialId: string): Promise<boolean> {
  const job = claimViewedJob(credentialId);
  if (!job) return false;
  await runViewedJob(job);
  return true;
}

export function queuedGithubViewedCredentials(
  workspaceId: string,
  lineageId: string,
  userId: string,
): string[] {
  return db.query<{ credential_id: string }, [string, string, string]>(
    "SELECT DISTINCT credential_id FROM review_github_viewed_jobs WHERE workspace_id=? AND lineage_id=? AND user_id=? AND state='pending'",
  ).all(workspaceId, lineageId, userId).map((row) => row.credential_id);
}

export function pendingGithubViewedCredentials(now = Date.now()): string[] {
  return db.query<{ credential_id: string }, [number, number, number]>(
    "SELECT DISTINCT credential_id FROM review_github_viewed_jobs WHERE state='pending' OR (state='failed' AND attempts<? AND retry_at IS NOT NULL AND retry_at<=?) OR (state='running' AND lease_expires_at<=?)",
  ).all(PROJECTION_ATTEMPTS_MAX, now, now).map((row) => row.credential_id);
}
