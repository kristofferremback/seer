import { sessionUser, requireApiKey } from "../auth";
import { db, isMember, listUserWorkspaces } from "../db";
import { escapeHtml } from "../escape";
import { GHS_ID_RE, RTH_ID_RE, SLUG_RE } from "../ids";
import { json, originOk } from "../http";
import { getMyRevisionJudgment } from "./judgments-db";
import {
  resolveGithubCredentialChoice,
} from "./github-projection-credentials";
import { githubProjectionForReader } from "./github-projection-read";
import { scheduleGithubProjectionCredential } from "./github-projection-worker";
import {
  GithubSubmissionError,
  appendGithubResolution,
  appendGithubThreadReply,
  createGithubReviewSubmission,
  createGithubThreadSubmission,
  retryGithubSubmission,
  submissionView,
} from "./github-submissions";
import {
  queueOwnedMarksForRemoval,
  getGithubProjectionPreference,
  listGithubViewedStatus,
  queueCurrentViewedJobs,
  queuedGithubViewedCredentials,
  retryGithubViewed,
  setGithubProjectionPreference,
} from "./github-viewed";
import { getLocalThread } from "./thread-db";
import { getLineage, getRevision } from "./revision-db";
import { getLineagePr } from "./revision-pr";
import { softNotFound } from "./render";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;

function response(value: unknown, status = 200): Response {
  const result = json(value, status);
  result.headers.set("cache-control", "no-store");
  return result;
}

function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json") ||
    (req.headers.get("content-type") ?? "").includes("application/json");
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GithubSubmissionError(422, "body", "Body must be an object.");
    return body as Record<string, unknown>;
  }
  const form = await req.formData().catch(() => null);
  if (!form) throw new GithubSubmissionError(422, "body", "Body must be form data.");
  return Object.fromEntries(form.entries());
}

function cleanReturn(raw: unknown, workspaceId: string, fallback: string): string {
  if (typeof raw !== "string" || !raw.startsWith(`/${workspaceId}/`) || raw.startsWith("//") ||
      raw.includes("://") || raw.includes("..") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  const parsed = new URL(raw, "http://seer.local");
  return /^\/ws_[^/]+\/(?:r|r-stacks)\//.test(parsed.pathname) ? parsed.pathname + parsed.search + parsed.hash : fallback;
}

function redirectBack(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function failure(req: Request, error: unknown, back: string): Response {
  const status = error instanceof GithubSubmissionError ? error.status : 422;
  const rule = error instanceof GithubSubmissionError ? error.rule : "github_projection_refused";
  const message = error instanceof Error ? error.message : String(error);
  if (wantsJson(req)) return response({ error: message, rule }, status);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>GitHub action refused · Seer</title></head><body><main><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(back)}">Return to review</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } },
  );
}

function member(req: Request, workspaceId: string) {
  if (!originOk(req)) return new Response("Bad origin", { status: 403, headers: { "cache-control": "no-store" } });
  if (req.headers.get("authorization")) return null;
  const user = sessionUser(req);
  return user && isMember(workspaceId, user.id) ? user : null;
}

function schedule(credentialId: string | null): void {
  if (credentialId) scheduleGithubProjectionCredential(credentialId);
}

function lineageTarget(workspaceId: string, slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  const lineage = getLineage(workspaceId, slug);
  const revision = lineage?.latest_revision === null || !lineage ? null : getRevision(workspaceId, slug, lineage.latest_revision);
  return lineage && revision && getLineagePr(workspaceId, lineage.id) ? { lineage, revision } : null;
}

export async function handleGithubViewedPreference(req: Request, workspaceId: string, slug: string): Promise<Response> {
  const fallback = `/${workspaceId}/r/${slug}`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user) return softNotFound();
    const target = lineageTarget(workspaceId, slug);
    if (!target) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const action = body.action;
    let credentialIds: string[] = [];
    if (action === "remove") {
      const preference = getGithubProjectionPreference(workspaceId, target.lineage.id, user.id);
      if (!preference) throw new GithubSubmissionError(422, "viewed_not_enabled", "Viewed sync has not been enabled for this review.");
      credentialIds = db.transaction(() => queueOwnedMarksForRemoval({ workspaceId, lineageId: target.lineage.id, userId: user.id }))();
    } else if (body.enabled === "true" || body.enabled === true) {
      const credential = resolveGithubCredentialChoice(user.id, body.credential);
      if (!credential) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
      const queued = db.transaction(() => {
        setGithubProjectionPreference({ workspaceId, lineageId: target.lineage.id, userId: user.id, credentialId: credential.id, enabled: true });
        return queueCurrentViewedJobs({ workspaceId, lineageId: target.lineage.id, userId: user.id, completeOnly: true });
      })();
      if (queued) credentialIds.push(queued);
      credentialIds.push(...queuedGithubViewedCredentials(workspaceId, target.lineage.id, user.id));
    } else if (body.enabled === "false" || body.enabled === false) {
      const preference = getGithubProjectionPreference(workspaceId, target.lineage.id, user.id);
      if (!preference) throw new GithubSubmissionError(422, "viewed_not_enabled", "Viewed sync has not been enabled for this review.");
      setGithubProjectionPreference({ workspaceId, lineageId: target.lineage.id, userId: user.id, credentialId: preference.credential_id, enabled: false });
    } else {
      throw new GithubSubmissionError(422, "viewed_action", "Choose whether to enable, disable, or remove Seer-owned Viewed marks.");
    }
    for (const credentialId of credentialIds) schedule(credentialId);
    if (wantsJson(req)) return response({ viewed: githubProjectionForReader({ workspaceId, lineage: target.lineage, revision: target.revision, userId: user.id })?.viewed ?? null }, 202);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

export async function handleGithubViewedRetry(req: Request, workspaceId: string, slug: string): Promise<Response> {
  const fallback = `/${workspaceId}/r/${slug}`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user) return softNotFound();
    const target = lineageTarget(workspaceId, slug);
    if (!target) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const path = body.path;
    if (path !== undefined && (typeof path !== "string" || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path))) throw new GithubSubmissionError(422, "path", "Choose a valid current file path.");
    retryGithubViewed({ workspaceId, lineageId: target.lineage.id, userId: user.id, path: typeof path === "string" && path ? path : null });
    for (const credentialId of queuedGithubViewedCredentials(workspaceId, target.lineage.id, user.id)) schedule(credentialId);
    if (wantsJson(req)) return response({ statuses: listGithubViewedStatus(workspaceId, target.lineage.id, user.id) }, 202);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

export async function handleGithubThreadPublish(req: Request, workspaceId: string, slug: string, threadId: string): Promise<Response> {
  const fallback = `/${workspaceId}/r/${slug}`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user || !RTH_ID_RE.test(threadId)) return softNotFound();
    const target = lineageTarget(workspaceId, slug);
    const thread = getLocalThread(workspaceId, threadId);
    if (!target || !thread || thread.thread.lineage_id !== target.lineage.id) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const credential = resolveGithubCredentialChoice(user.id, body.credential);
    if (!credential) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
    const result = createGithubThreadSubmission({ workspaceId, lineageId: target.lineage.id, revisionId: target.revision.id, userId: user.id, credentialId: credential.id, localThreadId: threadId });
    schedule(result.row.credential_id);
    if (wantsJson(req)) return response({ submission: submissionView(result.row), created: result.created }, result.created ? 202 : 200);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

function idempotency(body: Record<string, unknown>): string {
  const key = body.idempotencyKey;
  if (typeof key !== "string" || key.length < 1 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) throw new GithubSubmissionError(422, "idempotency_required", "A valid idempotency key is required.");
  return key;
}

export async function handleGithubThreadReply(req: Request, workspaceId: string, threadId: string): Promise<Response> {
  const fallback = `/${workspaceId}/reviews`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user || !RTH_ID_RE.test(threadId) || !getLocalThread(workspaceId, threadId)) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const credential = resolveGithubCredentialChoice(user.id, body.credential);
    if (!credential) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
    const result = appendGithubThreadReply({ workspaceId, userId: user.id, credentialId: credential.id, localThreadId: threadId, body: body.body as string, idempotencyKey: idempotency(body), author: { kind: "member", userId: user.id } });
    schedule(result.row.credential_id);
    if (wantsJson(req)) return response({ submission: submissionView(result.row), created: result.created }, result.created ? 202 : 200);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

export async function handleGithubThreadEvent(req: Request, workspaceId: string, threadId: string): Promise<Response> {
  const fallback = `/${workspaceId}/reviews`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user || !RTH_ID_RE.test(threadId) || !getLocalThread(workspaceId, threadId)) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const credential = resolveGithubCredentialChoice(user.id, body.credential);
    if (!credential) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
    const state = body.state === "resolved" ? "resolved" : body.state === "open" ? "open" : null;
    if (!state) throw new GithubSubmissionError(422, "state", "state must be resolved or open.");
    const result = appendGithubResolution({ workspaceId, userId: user.id, credentialId: credential.id, localThreadId: threadId, state, idempotencyKey: idempotency(body) });
    if (result.row) schedule(result.row.credential_id);
    if (wantsJson(req)) return response({ submission: result.row ? submissionView(result.row) : null, created: result.created }, result.created ? 202 : 200);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

export async function handleGithubReview(req: Request, workspaceId: string, slug: string, rawRevision: string): Promise<Response> {
  const fallback = `/${workspaceId}/r/${slug}/rev/${rawRevision}`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user || !SLUG_RE.test(slug) || !NUMBER_RE.test(rawRevision)) return softNotFound();
    const lineage = getLineage(workspaceId, slug);
    const revision = lineage ? getRevision(workspaceId, slug, Number(rawRevision)) : null;
    if (!lineage || !revision) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const credential = resolveGithubCredentialChoice(user.id, body.credential);
    if (!credential) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
    const kind = body.verdict === "approve" ? "approve" : body.verdict === "request_changes" ? "request_changes" : null;
    if (!kind) throw new GithubSubmissionError(422, "verdict", "Choose Approve on GitHub or Request changes on GitHub.");
    let reviewBody = typeof body.body === "string" ? body.body : "";
    if (body.includeLocalComment === "true" || body.includeLocalComment === true) {
      const local = getMyRevisionJudgment(workspaceId, revision.id, user.id)?.comment ?? "";
      if (local) reviewBody = reviewBody.trim() ? `${reviewBody.trim()}\n\n${local}` : local;
    }
    const result = createGithubReviewSubmission({ workspaceId, lineageId: lineage.id, revisionId: revision.id, userId: user.id, credentialId: credential.id, kind, body: reviewBody });
    schedule(result.row.credential_id);
    if (wantsJson(req)) return response({ submission: submissionView(result.row), created: result.created }, result.created ? 202 : 200);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

export async function handleGithubSubmissionRetry(req: Request, workspaceId: string, slug: string, submissionId: string): Promise<Response> {
  const fallback = `/${workspaceId}/r/${slug}`;
  let back = fallback;
  try {
    const user = member(req, workspaceId);
    if (user instanceof Response) return user;
    if (!user || !GHS_ID_RE.test(submissionId)) return softNotFound();
    const lineage = getLineage(workspaceId, slug);
    if (!lineage) return softNotFound();
    const body = await bodyOf(req);
    back = cleanReturn(body.return, workspaceId, fallback);
    const selected = body.credential === undefined ? null : resolveGithubCredentialChoice(user.id, body.credential);
    if (body.credential !== undefined && !selected) throw new GithubSubmissionError(422, "credential_refused", "Choose one of your live GitHub credentials.");
    const row = retryGithubSubmission({ workspaceId, lineageId: lineage.id, userId: user.id, submissionId, ...(selected ? { credentialId: selected.id } : {}) });
    schedule(row.credential_id);
    if (wantsJson(req)) return response({ submission: submissionView(row) }, 202);
    return redirectBack(back);
  } catch (error) { return failure(req, error, back); }
}

function apiLineage(req: Request, slug: string): { workspaceId: string; userId: string | null } | Response {
  const session = req.headers.get("authorization") ? null : sessionUser(req);
  if (session) {
    const named = new URL(req.url).searchParams.get("workspace");
    if (named) return isMember(named, session.id) && getLineage(named, slug) ? { workspaceId: named, userId: session.id } : softNotFound();
    const matches = listUserWorkspaces(session.id).filter((workspace) => getLineage(workspace.id, slug));
    return matches.length === 1 ? { workspaceId: matches[0]!.id, userId: session.id } : softNotFound();
  }
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  return getLineage(auth.workspaceId, slug) ? { workspaceId: auth.workspaceId, userId: null } : softNotFound();
}

export function handleGithubProjection(req: Request, slug: string): Response {
  if (!SLUG_RE.test(slug)) return softNotFound();
  const gate = apiLineage(req, slug);
  if (gate instanceof Response) return gate;
  const lineage = getLineage(gate.workspaceId, slug)!;
  if (gate.userId === null) return response({ workspace: gate.workspaceId, slug, projection: null });
  const revision = lineage.latest_revision === null ? null : getRevision(gate.workspaceId, slug, lineage.latest_revision);
  if (!revision) return softNotFound();
  return response({ workspace: gate.workspaceId, slug, projection: githubProjectionForReader({ workspaceId: gate.workspaceId, lineage, revision, userId: gate.userId }) });
}
