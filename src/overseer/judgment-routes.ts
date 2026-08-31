// Member-only acknowledgement and judgment forms, plus read-only judgment APIs.
//
// Page mutations require a session and same-origin request. API keys may read safe verdict
// history, but never a member's active handling and never a write route. Every scope is
// resolved back through its immutable revision or manifest before a row is touched.

import { sessionUser } from "../auth";
import { db, isMember } from "../db";
import { json, originOk } from "../http";
import { SLUG_RE, STF_ID_RE, STI_ID_RE } from "../ids";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import {
  JudgmentWriteError,
  judgeRevision,
  judgeStackManifest,
  listRevisionJudgments,
  listStackJudgments,
  revisionAcknowledgementState,
} from "./judgments-db";
import { readableWorkspaces, softNotFound as softJsonNotFound } from "./read";
import {
  handlePromotedReviewPage,
  resolvePromoted,
} from "./revision-read";
import {
  getAccount,
  getLineage,
  getRevision,
  getRevisionById,
  getRevisionMovement,
  nextRevision,
  previousRevision,
  storeRevisionMovement,
} from "./revision-db";
import { requiredAcknowledgements, revisionCodeDelta } from "./revision-delta";
import { writeRevisionAcknowledgementHandling } from "./review-handling";
import { softNotFound as softPageNotFound } from "./render";
import {
  getStack,
  getStackManifest,
} from "./stack-db";
import { handleStackPage } from "./stack-render";
import { MAX_STACK_MEMBER_POSITIONS } from "./stack-types";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;
const POSITION_RE = /^[1-9][0-9]?$/;

function response(value: unknown, status = 200): Response {
  const out = json(value, status);
  out.headers.set("cache-control", "no-store");
  return out;
}

function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

function member(req: Request, workspaceId: string) {
  if (!originOk(req)) return new Response("Bad origin", { status: 403, headers: { "cache-control": "no-store" } });
  const user = sessionUser(req);
  return user && isMember(workspaceId, user.id) ? user : null;
}

async function formOf(req: Request): Promise<Awaited<ReturnType<Request["formData"]>> | Response> {
  const form = await req.formData().catch(() => null);
  return form ?? response({ error: "Body must be form data." }, 400);
}

function safeRawReturn(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") ||
      raw.includes("://") || raw.includes("..") || raw.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

function cleanRevisionReturn(
  raw: unknown,
  workspaceId: string,
  slug: string,
  revision: number,
): string {
  const fallback = `/${workspaceId}/r/${slug}/rev/${revision}`;
  const value = safeRawReturn(raw);
  if (!value) return fallback;
  const parsed = new URL(value, "http://seer.local");
  const match = new RegExp(`^/${workspaceId}/r/${slug}/(rev|v)/([1-9][0-9]{0,8})/?$`).exec(parsed.pathname);
  if (!match) return fallback;
  if (match[1] === "rev") return Number(match[2]) === revision ? parsed.pathname + parsed.search : fallback;
  const account = getAccount(workspaceId, slug, Number(match[2]));
  return account?.revision === revision ? parsed.pathname + parsed.search : fallback;
}

function cleanStackReturn(
  raw: unknown,
  workspaceId: string,
  slug: string,
  version: number,
): string {
  const fallback = `/${workspaceId}/r-stacks/${slug}/v/${version}`;
  const value = safeRawReturn(raw);
  if (!value) return fallback;
  const parsed = new URL(value, "http://seer.local");
  const match = new RegExp(`^/${workspaceId}/r-stacks/${slug}/v/([1-9][0-9]{0,8})(?:/(account))?/?$`).exec(parsed.pathname);
  return match && Number(match[1]) === version ? parsed.pathname + parsed.search : fallback;
}

function redirectBack(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

/** Older revisions can have movement rows that predate v22. Fill every already-published
 * hop before a late acknowledgement tries to follow its stored equivalences. */
function ensureSuccessorEquivalences(workspaceId: string, slug: string, revision: number): void {
  const lineage = getLineage(workspaceId, slug);
  if (!lineage) return;
  let current = revision;
  for (let hops = 0; hops < 10_000; hops++) {
    const successor = nextRevision(workspaceId, lineage.id, current);
    if (!successor) return;
    const stored = getRevisionMovement(workspaceId, successor.id);
    if (stored && stored.items_computed_at !== null) {
      current = successor.revision;
      continue;
    }
    const previous = previousRevision(workspaceId, lineage.id, successor.revision);
    const before = previous ? getStageCaptureForWorkspaces(previous.capture_id, [workspaceId]) : null;
    const after = getStageCaptureForWorkspaces(successor.capture_id, [workspaceId]);
    if (previous && before && after) {
      const delta = revisionCodeDelta(before, after);
      db.transaction(() => storeRevisionMovement({
        workspaceId,
        lineageId: lineage.id,
        previousRevisionId: previous.id,
        revisionId: successor.id,
        counts: delta.counts,
        readEquivalences: delta.readEquivalences,
        ackEquivalences: delta.ackEquivalences,
        now: Date.now(),
      }))();
    }
    current = successor.revision;
  }
}

function itemResponse(
  revision: ReturnType<typeof getRevision>,
  userId: string,
  itemId: string,
  acknowledged: boolean,
  inventory: StageCaptureInventory,
) {
  if (!revision) return null;
  const state = revisionAcknowledgementState(revision, userId, inventory);
  return {
    itemId,
    acknowledged,
    acknowledgement: state.acknowledgements.get(itemId) ?? null,
    required: state.requiredCount,
    acknowledgedCount: state.acknowledgedCount,
  };
}

export async function handleRevisionAcknowledgement(
  req: Request,
  workspaceId: string,
  slug: string,
  rawRevision: string,
  itemId: string,
): Promise<Response> {
  const gate = member(req, workspaceId);
  if (gate instanceof Response) return gate;
  const user = gate;
  if (!user || !SLUG_RE.test(slug) || !NUMBER_RE.test(rawRevision) ||
      (!STI_ID_RE.test(itemId) && !STF_ID_RE.test(itemId))) return softPageNotFound();
  const resolved = resolvePromoted(workspaceId, slug, { kind: "revision", raw: rawRevision });
  const item = resolved ? requiredAcknowledgements(resolved.inventory).find((candidate) => candidate.id === itemId) : null;
  if (!resolved || !item) return softPageNotFound();
  const form = await formOf(req);
  if (form instanceof Response) return form;
  const value = form.get("acknowledged");
  if (value !== "true" && value !== "false") return response({ error: "acknowledged must be true or false." }, 422);
  ensureSuccessorEquivalences(workspaceId, slug, resolved.revision.revision);
  writeRevisionAcknowledgementHandling({
    workspaceId,
    lineageId: resolved.lineage.id,
    revisionId: resolved.revision.id,
    userId: user.id,
    item,
    acknowledged: value === "true",
  });
  if (wantsJson(req)) return response(itemResponse(resolved.revision, user.id, item.id, value === "true", resolved.inventory));
  return redirectBack(cleanRevisionReturn(form.get("return"), workspaceId, slug, resolved.revision.revision));
}

function resolveStackMember(
  workspaceId: string,
  slug: string,
  rawVersion: string,
  rawPosition: string,
) {
  if (!SLUG_RE.test(slug) || !NUMBER_RE.test(rawVersion) || !POSITION_RE.test(rawPosition) || Number(rawPosition) > MAX_STACK_MEMBER_POSITIONS) return null;
  const stack = getStack(workspaceId, slug);
  const manifest = stack ? getStackManifest(workspaceId, slug, Number(rawVersion)) : null;
  const snapshot = manifest?.doc.members[Number(rawPosition) - 1];
  const revision = snapshot ? getRevisionById(workspaceId, snapshot.revisionId) : null;
  const inventory = revision ? getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]) : null;
  if (!stack || !manifest || !snapshot || !revision || !inventory ||
      revision.lineage_id !== snapshot.lineageId || revision.slug !== snapshot.lineageSlug || revision.revision !== snapshot.revision) return null;
  return { stack, manifest, snapshot, revision, inventory, position: Number(rawPosition) };
}

export async function handleStackAcknowledgement(
  req: Request,
  workspaceId: string,
  slug: string,
  rawVersion: string,
  rawPosition: string,
  itemId: string,
): Promise<Response> {
  const gate = member(req, workspaceId);
  if (gate instanceof Response) return gate;
  const user = gate;
  if (!user || (!STI_ID_RE.test(itemId) && !STF_ID_RE.test(itemId))) return softPageNotFound();
  const resolved = resolveStackMember(workspaceId, slug, rawVersion, rawPosition);
  const item = resolved ? requiredAcknowledgements(resolved.inventory).find((candidate) => candidate.id === itemId) : null;
  if (!resolved || !item) return softPageNotFound();
  const form = await formOf(req);
  if (form instanceof Response) return form;
  const value = form.get("acknowledged");
  if (value !== "true" && value !== "false") return response({ error: "acknowledged must be true or false." }, 422);
  ensureSuccessorEquivalences(workspaceId, resolved.revision.slug, resolved.revision.revision);
  writeRevisionAcknowledgementHandling({
    workspaceId,
    lineageId: resolved.revision.lineage_id,
    revisionId: resolved.revision.id,
    userId: user.id,
    item,
    acknowledged: value === "true",
  });
  if (wantsJson(req)) {
    return response({
      position: resolved.position,
      ...itemResponse(resolved.revision, user.id, item.id, value === "true", resolved.inventory),
    });
  }
  return redirectBack(cleanStackReturn(form.get("return"), workspaceId, slug, resolved.manifest.version));
}

function errorResponse(error: JudgmentWriteError): Response {
  return response({
    error: error.message,
    rule: error.rule,
    ...(error.blockers.length ? { blockers: error.blockers.map((blocker) => ({
      revision: blocker.revision,
      itemId: blocker.itemId,
      itemType: blocker.itemType,
    })) } : {}),
  }, error.status);
}

async function withStatus(page: Promise<Response>, status: number): Promise<Response> {
  const rendered = await page;
  const headers = new Headers(rendered.headers);
  headers.set("cache-control", "no-store");
  return new Response(await rendered.arrayBuffer(), { status, headers });
}

async function renderRevisionRefusal(
  req: Request,
  workspaceId: string,
  slug: string,
  revision: number,
  back: string,
  status: number,
  message: string,
): Promise<Response> {
  const parsed = new URL(back, req.url);
  const accountMatch = new RegExp(`^/${workspaceId}/r/${slug}/v/([1-9][0-9]{0,8})/?$`).exec(parsed.pathname);
  const pin = accountMatch ? { kind: "account" as const, raw: accountMatch[1]! } : { kind: "revision" as const, raw: String(revision) };
  const pageReq = new Request(new URL(parsed.pathname + parsed.search, req.url).toString(), { headers: req.headers });
  return withStatus(handlePromotedReviewPage(pageReq, workspaceId, slug, pin, message), status);
}

async function renderStackRefusal(
  req: Request,
  workspaceId: string,
  slug: string,
  version: number,
  back: string,
  status: number,
  message: string,
): Promise<Response> {
  const parsed = new URL(back, req.url);
  const account = parsed.pathname.endsWith("/account");
  const pageReq = new Request(new URL(parsed.pathname + parsed.search, req.url).toString(), { headers: req.headers });
  return withStatus(handleStackPage(pageReq, workspaceId, slug, { version: String(version), account }, message), status);
}

export async function handleRevisionJudgment(
  req: Request,
  workspaceId: string,
  slug: string,
  rawRevision: string,
): Promise<Response> {
  const gate = member(req, workspaceId);
  if (gate instanceof Response) return gate;
  const user = gate;
  if (!user || !SLUG_RE.test(slug) || !NUMBER_RE.test(rawRevision)) return softPageNotFound();
  const resolved = resolvePromoted(workspaceId, slug, { kind: "revision", raw: rawRevision });
  if (!resolved) return softPageNotFound();
  const form = await formOf(req);
  if (form instanceof Response) return form;
  const back = cleanRevisionReturn(form.get("return"), workspaceId, slug, resolved.revision.revision);
  const verdict = form.get("verdict");
  try {
    const result = judgeRevision({
      workspaceId,
      lineageId: resolved.lineage.id,
      revisionId: resolved.revision.id,
      userId: user.id,
      verdict: verdict === "approved" ? "approved" : verdict === "changes_requested" ? "changes_requested" : verdict as never,
      comment: form.get("comment") ?? "",
    });
    if (wantsJson(req)) return response(result, result.created ? 201 : 200);
    return redirectBack(back);
  } catch (error) {
    if (!(error instanceof JudgmentWriteError)) throw error;
    if (wantsJson(req)) return errorResponse(error);
    return renderRevisionRefusal(req, workspaceId, slug, resolved.revision.revision, back, error.status, error.message);
  }
}

export async function handleStackJudgment(
  req: Request,
  workspaceId: string,
  slug: string,
  rawVersion: string,
): Promise<Response> {
  const gate = member(req, workspaceId);
  if (gate instanceof Response) return gate;
  const user = gate;
  if (!user || !SLUG_RE.test(slug) || !NUMBER_RE.test(rawVersion)) return softPageNotFound();
  const stack = getStack(workspaceId, slug);
  const manifest = stack ? getStackManifest(workspaceId, slug, Number(rawVersion)) : null;
  if (!stack || !manifest) return softPageNotFound();
  const form = await formOf(req);
  if (form instanceof Response) return form;
  const back = cleanStackReturn(form.get("return"), workspaceId, slug, manifest.version);
  const verdict = form.get("verdict");
  try {
    const result = judgeStackManifest({
      workspaceId,
      stackId: stack.id,
      manifestId: manifest.id,
      userId: user.id,
      verdict: verdict === "approved" ? "approved" : verdict === "changes_requested" ? "changes_requested" : verdict as never,
      comment: form.get("comment") ?? "",
    });
    if (wantsJson(req)) return response(result, result.created ? 201 : 200);
    return redirectBack(back);
  } catch (error) {
    if (!(error instanceof JudgmentWriteError)) throw error;
    if (wantsJson(req)) return errorResponse(error);
    return renderStackRefusal(req, workspaceId, slug, manifest.version, back, error.status, error.message);
  }
}

function resolveReadableRevision(req: Request, slug: string, rawRevision: string) {
  if (!SLUG_RE.test(slug) || !NUMBER_RE.test(rawRevision)) return null;
  for (const workspaceId of readableWorkspaces(req)) {
    const lineage = getLineage(workspaceId, slug);
    const revision = lineage ? getRevision(workspaceId, slug, Number(rawRevision)) : null;
    if (lineage && revision) return { workspaceId, lineage, revision };
  }
  return null;
}

export function handleRevisionJudgments(req: Request, slug: string, rawRevision: string): Response {
  const resolved = resolveReadableRevision(req, slug, rawRevision);
  if (!resolved) return softJsonNotFound();
  const session = req.headers.get("authorization") ? null : sessionUser(req);
  const viewer = session && isMember(resolved.workspaceId, session.id) ? session : null;
  const handling = viewer
    ? (() => {
        const state = revisionAcknowledgementState(resolved.revision, viewer.id);
        return {
          required: state.requiredCount,
          acknowledged: state.acknowledgedCount,
          acknowledgements: [...state.acknowledgements.values()],
          blockers: state.blockers.map((blocker) => ({ itemId: blocker.itemId, itemType: blocker.itemType })),
        };
      })()
    : null;
  return response({
    workspace: resolved.workspaceId,
    slug,
    revision: resolved.revision.revision,
    judgments: listRevisionJudgments(resolved.workspaceId, resolved.revision.id, { viewerId: viewer?.id ?? null }),
    handling,
  });
}

export function handleStackJudgments(req: Request, slug: string, rawVersion: string): Response {
  if (!SLUG_RE.test(slug) || !NUMBER_RE.test(rawVersion)) return softJsonNotFound();
  for (const workspaceId of readableWorkspaces(req)) {
    const stack = getStack(workspaceId, slug);
    const manifest = stack ? getStackManifest(workspaceId, slug, Number(rawVersion)) : null;
    if (!stack || !manifest) continue;
    const session = req.headers.get("authorization") ? null : sessionUser(req);
    const viewerId = session && isMember(workspaceId, session.id) ? session.id : null;
    return response({
      workspace: workspaceId,
      slug,
      manifest: manifest.version,
      judgments: listStackJudgments(workspaceId, manifest.id, { viewerId }),
    });
  }
  return softJsonNotFound();
}
