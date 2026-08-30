// The promoted review's API. Seven routes: publish the first source revision from a
// completed capture, read the lineage, read one exact evidence revision, publish an
// account over it, fail or retry the witness request, and read a bounded retained-line
// window. Every one of them is declared with OpenAPI in src/api.ts.
//
// Every refusal on this path is the review soft miss — same body, same headers — so a
// slug is never an oracle for what a workspace is working on, whether the thing behind
// it is a legacy review, a promoted lineage, or nothing at all.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { json } from "../http";
import { SLUG_RE, WTR_ID_RE } from "../ids";
import { getStageCaptureForWorkspaces } from "../stage/db";
import { getReview } from "./db";
import { readableWorkspaces, softNotFound } from "./read";
import {
  MAX_FAILURE_TEXT,
  RevisionWriteError,
  claimWitnessRequest,
  failWitnessRequest,
  getLineage,
  getRevision,
  getWitnessRequest,
  getWitnessRequestForRevision,
  listAccountVersions,
  publishAccount,
  publishFirstRevision,
  retryWitnessRequest,
  workflowWord,
  type ReviewAccountRow,
  type ReviewLineageRow,
  type ReviewRevisionRow,
  type WitnessRequestRow,
} from "./revision-db";
import { lineageCaptureJobViews } from "./revision-jobs";
import { lineagePullRequestView, revisionPullRequestView } from "./revision-pr";
import type { RevisionBuilder } from "./revision-types";
import { validateAccountPublish, validateLineageCreate } from "./revision-validate";
import { db } from "../db";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;

function reviewJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function witnessView(request: WitnessRequestRow, slug: string): unknown {
  return {
    id: request.id,
    workspace: request.workspace_id,
    slug,
    revision: request.revision,
    state: workflowWord(request),
    retryCount: request.retry_count,
    failure: request.failure,
    accountId: request.account_id,
    updatedAt: new Date(request.updated_at).toISOString(),
  };
}

function revisionView(
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  request: WitnessRequestRow,
): unknown {
  return {
    id: revision.id,
    lineage: lineage.id,
    slug: lineage.slug,
    workspace: lineage.workspace_id,
    revision: revision.revision,
    schemaVersion: revision.schema_version,
    digest: revision.digest,
    url: `${config.baseUrl}/${lineage.workspace_id}/r/${lineage.slug}/rev/${revision.revision}`,
    apiUrl: `${config.baseUrl}/api/review-lineages/${lineage.slug}/revisions/${revision.revision}`,
    createdAt: new Date(revision.created_at).toISOString(),
    document: revision.doc,
    // Beside the V1 document rather than inside it. The document's digest covers the
    // immutable bytes it was published with; the pull request identity it was captured
    // from has one stored home of its own, and a V2 document duplicating it would soft-404
    // every old reader during a mixed-image deploy for nothing.
    pullRequest: revisionPullRequestView(lineage.workspace_id, revision.id),
    witness: witnessView(request, lineage.slug),
  };
}

function accountView(
  lineage: ReviewLineageRow,
  account: ReviewAccountRow,
  request: WitnessRequestRow,
): unknown {
  return {
    id: account.id,
    lineage: lineage.id,
    slug: lineage.slug,
    workspace: lineage.workspace_id,
    revision: account.revision,
    version: account.version,
    schemaVersion: account.schema_version,
    digest: account.digest,
    url: `${config.baseUrl}/${lineage.workspace_id}/r/${lineage.slug}/v/${account.version}`,
    revisionUrl: `${config.baseUrl}/${lineage.workspace_id}/r/${lineage.slug}/rev/${account.revision}`,
    createdAt: new Date(account.created_at).toISOString(),
    document: account.doc,
    witness: witnessView(request, lineage.slug),
  };
}

function lineageView(lineage: ReviewLineageRow): unknown {
  const workspaceId = lineage.workspace_id;
  const revisions = db.query<{ revision: number; capture_id: string; created_at: number }, [string, string]>(
    "SELECT revision, capture_id, created_at FROM review_revisions WHERE workspace_id = ? AND slug = ? ORDER BY revision ASC",
  ).all(workspaceId, lineage.slug);
  const projects = db.query<{ slug: string }, [string, string]>(
    "SELECT p.slug AS slug FROM project_review_lineages j JOIN projects p ON p.id = j.project_id WHERE j.workspace_id = ? AND j.slug = ? ORDER BY j.created_at ASC",
  ).all(workspaceId, lineage.slug).map((row) => row.slug);
  return {
    id: lineage.id,
    slug: lineage.slug,
    workspace: workspaceId,
    title: lineage.title,
    repo: lineage.repo,
    repoId: lineage.repo_id,
    branch: lineage.branch,
    originalBaseRef: lineage.original_base_ref,
    originalBaseSha: lineage.original_base_sha,
    latestRevision: lineage.latest_revision,
    latestAccountVersion: lineage.latest_account_version,
    url: `${config.baseUrl}/${workspaceId}/r/${lineage.slug}`,
    apiUrl: `${config.baseUrl}/api/review-lineages/${lineage.slug}`,
    projects,
    pullRequest: lineagePullRequestView(workspaceId, lineage.id),
    captureJobs: lineageCaptureJobViews(workspaceId, lineage.id),
    revisions: revisions.map((row) => ({
      revision: row.revision,
      captureId: row.capture_id,
      createdAt: new Date(row.created_at).toISOString(),
      url: `${config.baseUrl}/${workspaceId}/r/${lineage.slug}/rev/${row.revision}`,
      apiUrl: `${config.baseUrl}/api/review-lineages/${lineage.slug}/revisions/${row.revision}`,
    })),
    accounts: listAccountVersions(workspaceId, lineage.slug).map((row) => ({
      version: row.version,
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      url: `${config.baseUrl}/${workspaceId}/r/${lineage.slug}/v/${row.version}`,
    })),
  };
}

async function readBody(req: Request): Promise<unknown | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reviewJson({ error: "Body must be a JSON object." }, 400);
    }
    return body;
  } catch {
    return reviewJson({ error: "Body is not valid JSON." }, 400);
  }
}

// ---- POST /api/review-lineages ----

/**
 * Promote one completed capture to the first source revision of a new lineage.
 *
 * The requested slug may differ from the capture's, deliberately: a capture that already
 * backs a Stage, or whose natural slug a legacy review has taken, is promoted under a
 * name the caller chooses rather than refused. What it may not do is take a name either
 * table already owns, because `/r/<slug>` has to mean one thing.
 */
export async function handleCreateReviewLineage(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  const body = await readBody(req);
  if (body instanceof Response) return body;

  const checked = validateLineageCreate(body);
  if (!checked.value) return reviewJson({ errors: checked.errors }, 422);

  const inventory = getStageCaptureForWorkspaces(checked.value.captureId, [auth.workspaceId]);
  if (!inventory) return reviewJson({ error: "No completed capture in this workspace" }, 404);

  const row = inventory.builder;
  const builder: RevisionBuilder | null = row
    ? {
        intent: row.intent,
        context: row.context,
        agent: { name: row.agent_name, model: row.agent_model },
        userId: row.user_id,
        keyId: row.key_id,
      }
    : null;

  try {
    const result = publishFirstRevision({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      slug: checked.value.slug,
      title: checked.value.title,
      projects: checked.value.projects,
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
      builder,
      legacyOwnsSlug: (slug) => getReview(auth.workspaceId, slug) !== null,
    });
    return reviewJson(revisionView(result.lineage, result.revision, result.request));
  } catch (err) {
    if (err instanceof RevisionWriteError) return reviewJson({ error: err.message }, err.status);
    if (err && typeof err === "object" && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return reviewJson({ error: "Review publication conflicted with an existing review or capture." }, 409);
    }
    console.error("[seer] review lineage publication failed:", err);
    return reviewJson({ error: "Review publication failed." }, 502);
  }
}

// ---- GET /api/review-lineages/:slug ----

function resolveReadable(req: Request, slug: string): ReviewLineageRow | null {
  if (!SLUG_RE.test(slug)) return null;
  for (const workspaceId of readableWorkspaces(req)) {
    const lineage = getLineage(workspaceId, slug);
    if (lineage) return lineage;
  }
  return null;
}

export function handleReadReviewLineage(req: Request, slug: string): Response {
  const lineage = resolveReadable(req, slug);
  if (!lineage) return softNotFound();
  return reviewJson(lineageView(lineage));
}

// ---- GET /api/review-lineages/:slug/revisions/:revision ----

export function handleReadReviewRevision(req: Request, slug: string, rawRevision: string): Response {
  if (!NUMBER_RE.test(rawRevision)) return softNotFound();
  const lineage = resolveReadable(req, slug);
  if (!lineage) return softNotFound();
  const revision = getRevision(lineage.workspace_id, slug, Number(rawRevision));
  if (!revision) return softNotFound();
  const request = getWitnessRequestForRevision(lineage.workspace_id, revision.id);
  if (!request) return softNotFound();
  return reviewJson(revisionView(lineage, revision, request));
}

// ---- POST /api/review-lineages/:slug/revisions/:revision/accounts ----

export async function handlePublishReviewAccount(
  req: Request,
  slug: string,
  rawRevision: string,
): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!SLUG_RE.test(slug) || !NUMBER_RE.test(rawRevision)) return softNotFound();
  const lineage = getLineage(auth.workspaceId, slug);
  if (!lineage) return softNotFound();
  const revision = getRevision(auth.workspaceId, slug, Number(rawRevision));
  if (!revision) return softNotFound();
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [auth.workspaceId]);
  if (!inventory) return softNotFound();

  const body = await readBody(req);
  if (body instanceof Response) return body;
  const checked = validateAccountPublish(body, inventory, auth.workspaceId);
  if (!checked.value) return reviewJson({ errors: checked.errors }, 422);

  try {
    const result = publishAccount({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      lineage,
      revision,
      witness: { summary: checked.value.summary, agent: checked.value.witness },
      groups: checked.value.groups,
      focus: checked.value.focus,
      evidence: checked.value.evidence,
    });
    return reviewJson(accountView(getLineage(auth.workspaceId, slug)!, result.account, result.request));
  } catch (err) {
    if (err instanceof RevisionWriteError) return reviewJson({ error: err.message }, err.status);
    if (err && typeof err === "object" && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return reviewJson({ error: "Account publication conflicted with an existing account." }, 409);
    }
    console.error("[seer] review account publication failed:", err);
    return reviewJson({ error: "Account publication failed." }, 502);
  }
}

// ---- POST /api/review-witness-requests/:id/{fail,retry} ----

/** The key's workspace and the request id are both in the query, so a request id from
 *  another workspace misses rather than resolving. */
function resolveRequest(
  req: Request,
  id: string,
): { request: WitnessRequestRow; slug: string; userId: string; keyId: string } | Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  if (!WTR_ID_RE.test(id)) return softNotFound();
  const request = getWitnessRequest(auth.workspaceId, id);
  if (!request) return softNotFound();
  const revision = db.query<{ slug: string }, [string, string]>(
    "SELECT slug FROM review_revisions WHERE workspace_id = ? AND id = ?",
  ).get(auth.workspaceId, request.revision_id);
  if (!revision) return softNotFound();
  return { request, slug: revision.slug, userId: auth.userId, keyId: auth.keyId };
}

// ---- POST /api/review-witness-requests/:id/claim ----

/**
 * Take, renew, or recover the claim on one attempt of a witness request.
 *
 * The attempt is `(request, retry count)`, so an agent that failed attempt zero holds
 * nothing over attempt one. A same-key call renews the lease, which is how a working
 * agent keeps its claim without a second concept; an expired lease may be recovered by
 * anyone without touching the retry count, because the count records failures rather than
 * handovers.
 */
export function handleClaimWitnessRequest(req: Request, id: string): Response {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  try {
    const result = claimWitnessRequest({
      workspaceId: resolved.request.workspace_id,
      requestId: resolved.request.id,
      userId: resolved.userId,
      keyId: resolved.keyId,
    });
    return reviewJson({
      ...(witnessView(result.request, resolved.slug) as Record<string, unknown>),
      claim: {
        retryCount: result.claim.retry_count,
        claimed: result.created,
        leaseExpiresAt: new Date(result.claim.lease_expires_at).toISOString(),
        claimedAt: new Date(result.claim.claimed_at).toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof RevisionWriteError) return reviewJson({ error: err.message }, err.status);
    throw err;
  }
}

export async function handleFailWitnessRequest(req: Request, id: string): Promise<Response> {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const raw = (body as Record<string, unknown>).error;
  const extra = Object.keys(body as Record<string, unknown>).find((key) => key !== "error");
  if (extra) return reviewJson({ error: `${JSON.stringify(extra)} is not a supported field.` }, 422);
  if (typeof raw !== "string" || raw.trim() === "") {
    return reviewJson({ error: "error is required and must say what went wrong." }, 422);
  }
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(raw)) {
    return reviewJson({ error: "error must be one line with no control characters." }, 422);
  }
  if (raw.length > MAX_FAILURE_TEXT) {
    return reviewJson({ error: `error is over budget: ${raw.length} of at most ${MAX_FAILURE_TEXT} characters` }, 422);
  }
  try {
    const updated = failWitnessRequest(resolved.request.workspace_id, resolved.request, raw.trim(),
      { userId: resolved.userId, keyId: resolved.keyId });
    return reviewJson(witnessView(updated, resolved.slug));
  } catch (err) {
    if (err instanceof RevisionWriteError) return reviewJson({ error: err.message }, err.status);
    throw err;
  }
}

export function handleRetryWitnessRequest(req: Request, id: string): Response {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  try {
    const updated = retryWitnessRequest(resolved.request.workspace_id, resolved.request);
    return reviewJson(witnessView(updated, resolved.slug));
  } catch (err) {
    if (err instanceof RevisionWriteError) return reviewJson({ error: err.message }, err.status);
    throw err;
  }
}
