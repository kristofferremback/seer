import { requireApiKey, sessionUser } from "../auth";
import { db, isMember, listUserWorkspaces } from "../db";
import { json, originOk } from "../http";
import { RTH_ID_RE, SLUG_RE } from "../ids";
import { resolvePromoted } from "./revision-read";
import { getAccountById, getLineage, getRevisionById } from "./revision-db";
import { getStack, getStackAccount, getStackAccountById, getStackManifest } from "./stack-db";
import { validateThreadAnchor, type ThreadAnchorInput } from "./thread-anchors";
import { appendLocalReply, appendResolutionEvent, createLocalThread, getLocalThread, listLocalThreadsForStackAccount, projectLocalThread } from "./thread-db";
import { CONVERSATION_REFRESH_COOLDOWN_MS, ConversationError, THREAD_AGENT_MODEL_MAX, THREAD_AGENT_NAME_MAX, type ProjectedGithubReview, type ProjectedGithubThread, type ProjectedLocalThread } from "./conversation-types";
import { digestOf } from "./revision-db";
import { getLineagePr, latestObservation, readActorOf } from "./revision-pr";
import { getConversationImport, runConversationImport, startConversationImport } from "./conversation-import";
import { createConversationReadContext, listImportedReviews, listImportedThreads, readPinnedLineageConversation } from "./conversation-read";
import { softNotFound } from "./render";

function response(value: unknown, status = 200): Response {
  const result = json(value, status); result.headers.set("cache-control", "no-store"); return result;
}
function fail(error: unknown): Response {
  if (error instanceof ConversationError) return response({ error: error.message, rule: error.rule, ...(error.details ? { details: error.details } : {}) }, error.status);
  throw error;
}
function randomKey(): string { return crypto.randomUUID(); }
function importView(row: NonNullable<ReturnType<typeof getConversationImport>>) {
  return {
    id: row.id,
    state: row.state,
    complete: row.complete === 1,
    truncated: row.truncated === 1,
    threads: row.thread_count,
    comments: row.comment_count,
    reviews: row.review_count,
    failure: row.failure,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}
function idempotency(req: Request, body: Record<string, unknown>): string {
  const header = req.headers.get("idempotency-key");
  const field = body.idempotencyKey;
  if (header && typeof field === "string" && header !== field) throw new ConversationError(409, "idempotency_conflict", "Header and body idempotency keys differ.");
  const value = header ?? (typeof field === "string" ? field : null);
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConversationError(422, "idempotency_required", "A valid idempotency key is required.");
  return value;
}
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const value = await req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConversationError(400, "body_malformed", "Body must be an object.");
    return value as Record<string, unknown>;
  }
  const form = await req.formData().catch(() => null);
  if (!form) throw new ConversationError(400, "body_malformed", "Body must be form data.");
  return Object.fromEntries(form.entries());
}
function anchorOf(body: Record<string, unknown>): ThreadAnchorInput {
  const raw = body.anchor;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ThreadAnchorInput;
  const kind = body.anchorKind;
  if (kind === "review") return { kind };
  if (kind === "account") return { kind, accountId: String(body.accountId ?? "") };
  if (kind === "stack") return { kind, stackAccountId: String(body.stackAccountId ?? "") };
  if (kind === "member_group") return { kind, accountId: String(body.accountId ?? ""), groupId: String(body.groupId ?? "") };
  if (kind === "stack_group") return { kind, stackAccountId: String(body.stackAccountId ?? ""), groupId: String(body.groupId ?? "") };
  if (kind === "change") return { kind, changeId: String(body.changeId ?? "") };
  if (kind === "range") return { kind, fileId: String(body.fileId ?? ""), side: body.side === "old" ? "old" : "new", startLine: Number(body.startLine), endLine: Number(body.endLine) };
  throw new ConversationError(422, "anchor_kind", "Choose a valid discussion anchor.");
}
function member(req: Request, workspaceId: string) {
  if (!originOk(req)) throw new ConversationError(403, "origin", "Bad origin.");
  const user = sessionUser(req);
  if (!user || !isMember(workspaceId, user.id)) throw new ConversationError(404, "thread_unknown", "No such review.");
  return user;
}
function wantsJson(req: Request): boolean { return (req.headers.get("accept") ?? "").includes("application/json"); }
function isSessionForm(req: Request): boolean {
  return !req.headers.get("authorization") && sessionUser(req) !== null && !wantsJson(req) && !(req.headers.get("content-type") ?? "").includes("application/json");
}
function cleanConversationReturn(raw: unknown, workspaceId: string, slug: string): string {
  const fallback = `/${workspaceId}/r/${slug}`;
  const prefix = `${fallback}/`;
  return typeof raw === "string" && raw.startsWith(prefix) && !raw.includes("://") && !raw.includes("..") && !raw.includes("\\") && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : fallback;
}
function redirectBack(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}
function cleanReturn(raw: unknown, workspaceId: string, scope: { kind: "lineage"; slug: string } | { kind: "stack"; slug: string }, fallback: string, threadId: string): string {
  const prefix = scope.kind === "lineage" ? `/${workspaceId}/r/${scope.slug}/` : `/${workspaceId}/r-stacks/${scope.slug}/`;
  if (typeof raw === "string" && raw.startsWith(prefix) && !raw.includes("://") && !raw.includes("..") && !raw.includes("\\") && !/[\u0000-\u001f\u007f]/.test(raw)) return `${raw.split("#", 1)[0]}#${threadId}`;
  return `${fallback}#${threadId}`;
}

export async function handleCreateReviewThread(req: Request, workspaceId: string, slug: string, kind: "revision" | "account", rawPin: string): Promise<Response> {
  try {
    const user = member(req, workspaceId);
    const resolved = resolvePromoted(workspaceId, slug, { kind, raw: rawPin });
    if (!resolved || (kind === "account" && !resolved.account)) return softNotFound();
    const body = await bodyOf(req);
    const anchor = await validateThreadAnchor(anchorOf(body), { kind: "review", workspaceId, lineage: resolved.lineage, revision: resolved.revision, account: resolved.account, inventory: resolved.inventory });
    const result = createLocalThread({ workspaceId, scopeKind: "lineage", scopeId: resolved.lineage.id, anchor, body: body.body as string, author: { kind: "member", userId: user.id }, idempotencyKey: idempotency(req, body) });
    if (wantsJson(req)) return response(projectLocalThread(result, user.id));
    const path = resolved.account ? `/${workspaceId}/r/${slug}/v/${resolved.account.version}` : `/${workspaceId}/r/${slug}/rev/${resolved.revision.revision}`;
    return new Response(null, { status: 303, headers: { location: cleanReturn(body.return, workspaceId, { kind: "lineage", slug }, path, result.thread.id), "cache-control": "no-store" } });
  } catch (error) { return fail(error); }
}

export async function handleCreateStackThread(req: Request, workspaceId: string, slug: string, rawVersion: string): Promise<Response> {
  try {
    const user = member(req, workspaceId);
    const version = Number(rawVersion);
    const stack = getStack(workspaceId, slug); const manifest = getStackManifest(workspaceId, slug, version); const account = getStackAccount(workspaceId, slug, version);
    if (!stack || !manifest || !account || account.manifest_id !== manifest.id) return softNotFound();
    const body = await bodyOf(req);
    const anchor = await validateThreadAnchor(anchorOf(body), { kind: "stack", workspaceId, stack, manifest, account });
    const result = createLocalThread({ workspaceId, scopeKind: "stack", scopeId: stack.id, anchor, body: body.body as string, author: { kind: "member", userId: user.id }, idempotencyKey: idempotency(req, body) });
    if (wantsJson(req)) return response(projectLocalThread(result, user.id));
    const path = `/${workspaceId}/r-stacks/${slug}/v/${version}/account`;
    return new Response(null, { status: 303, headers: { location: cleanReturn(body.return, workspaceId, { kind: "stack", slug }, path, result.thread.id), "cache-control": "no-store" } });
  } catch (error) { return fail(error); }
}

export async function handleSessionThreadMutation(req: Request, workspaceId: string, threadId: string, operation: "reply" | "resolution"): Promise<Response> {
  try {
    const user = member(req, workspaceId);
    if (!RTH_ID_RE.test(threadId)) return softNotFound();
    const held = getLocalThread(workspaceId, threadId); if (!held) return softNotFound();
    const body = await bodyOf(req); const key = idempotency(req, body);
    const result = operation === "reply"
      ? appendLocalReply({ workspaceId, threadId, body: body.body as string, author: { kind: "member", userId: user.id }, idempotencyKey: key })
      : appendResolutionEvent({ workspaceId, threadId, state: body.state === "resolved" ? "resolved" : body.state === "open" ? "open" : (() => { throw new ConversationError(422, "state", "state must be resolved or open"); })(), author: { kind: "member", userId: user.id }, idempotencyKey: key });
    if (wantsJson(req)) return response(projectLocalThread(result, user.id));
    let fallback: string;
    let scope: { kind: "lineage"; slug: string } | { kind: "stack"; slug: string };
    if (held.anchor.stack_account_id) {
      const account = getStackAccountById(workspaceId, held.anchor.stack_account_id);
      if (!account) return softNotFound();
      fallback = `/${workspaceId}/r-stacks/${account.slug}/v/${account.version}/account`;
      scope = { kind: "stack", slug: account.slug };
    } else if (held.anchor.account_id) {
      const account = getAccountById(workspaceId, held.anchor.account_id);
      if (!account) return softNotFound();
      fallback = `/${workspaceId}/r/${account.slug}/v/${account.version}`;
      scope = { kind: "lineage", slug: account.slug };
    } else {
      const revision = held.anchor.revision_id ? getRevisionById(workspaceId, held.anchor.revision_id) : null;
      if (!revision) return softNotFound();
      fallback = `/${workspaceId}/r/${revision.slug}/rev/${revision.revision}`;
      scope = { kind: "lineage", slug: revision.slug };
    }
    return new Response(null, { status: 303, headers: { location: cleanReturn(body.return, workspaceId, scope, fallback, threadId), "cache-control": "no-store" } });
  } catch (error) { return fail(error); }
}

export async function handleAgentThreadReply(req: Request, threadId: string): Promise<Response> {
  try {
    if (req.headers.get("cookie") && sessionUser(req)) throw new ConversationError(403, "actor_forbidden", "A session cannot use the agent reply route.");
    const auth = requireApiKey(req); if (auth instanceof Response) return auth;
    if (!RTH_ID_RE.test(threadId) || !getLocalThread(auth.workspaceId, threadId)) return softNotFound();
    const body = await bodyOf(req);
    const name = body.agentName; const model = body.agentModel;
    if (typeof name !== "string" || !name.trim() || name.length > THREAD_AGENT_NAME_MAX || typeof model !== "string" || !model.trim() || model.length > THREAD_AGENT_MODEL_MAX) throw new ConversationError(422, "agent", "agentName and agentModel are required.");
    const result = appendLocalReply({ workspaceId: auth.workspaceId, threadId, body: body.body as string, author: { kind: "agent", userId: auth.userId, keyId: auth.keyId, name: name.trim(), model: model.trim() }, idempotencyKey: idempotency(req, body) });
    return response(projectLocalThread(result, null));
  } catch (error) { return fail(error); }
}

function apiWorkspace(req: Request, slug: string): { workspaceId: string; userId: string | null } | Response {
  const user = sessionUser(req);
  if (user) {
    const named = new URL(req.url).searchParams.get("workspace");
    if (named) return isMember(named, user.id) && getLineage(named, slug) ? { workspaceId: named, userId: user.id } : softNotFound();
    const workspaces = listUserWorkspaces(user.id).filter((row) => getLineage(row.id, slug));
    return workspaces.length === 1 ? { workspaceId: workspaces[0]!.id, userId: user.id } : softNotFound();
  }
  const auth = requireApiKey(req); if (auth instanceof Response) return auth;
  return getLineage(auth.workspaceId, slug) ? { workspaceId: auth.workspaceId, userId: null } : softNotFound();
}

export async function handleLineageConversations(req: Request, slug: string): Promise<Response> {
  const gate = apiWorkspace(req, slug); if (gate instanceof Response) return gate;
  const lineage = getLineage(gate.workspaceId, slug)!;
  const localRows = db.query<{ id: string }, [string, string]>("SELECT id FROM review_threads WHERE workspace_id = ? AND lineage_id = ? ORDER BY created_at, id").all(gate.workspaceId, lineage.id);
  const context = createConversationReadContext(gate.workspaceId);
  return response({ local: localRows.flatMap((row) => { const held = getLocalThread(gate.workspaceId, row.id); return held ? [projectLocalThread(held, gate.userId)] : []; }), imported: await listImportedThreads(gate.workspaceId, lineage, { context }), reviews: listImportedReviews(gate.workspaceId, lineage.id) });
}

export async function handleStackConversations(req: Request, slug: string, rawVersion: string): Promise<Response> {
  const user = sessionUser(req);
  let workspaceId: string; let viewerId: string | null;
  if (user) {
    const named = new URL(req.url).searchParams.get("workspace");
    const workspaces = named ? listUserWorkspaces(user.id).filter((row) => row.id === named && getStack(row.id, slug)) : listUserWorkspaces(user.id).filter((row) => getStack(row.id, slug));
    if (workspaces.length !== 1) return softNotFound();
    workspaceId = workspaces[0]!.id; viewerId = user.id;
  } else {
    const auth = requireApiKey(req); if (auth instanceof Response) return auth;
    if (!getStack(auth.workspaceId, slug)) return softNotFound();
    workspaceId = auth.workspaceId; viewerId = null;
  }
  const version = Number(rawVersion); const manifest = getStackManifest(workspaceId, slug, version);
  if (!manifest) return softNotFound();
  const local = new Map<string, ProjectedLocalThread>();
  const account = getStackAccount(workspaceId, slug, version);
  if (account) for (const thread of listLocalThreadsForStackAccount(workspaceId, account.id)) local.set(thread.thread.id, projectLocalThread(thread, viewerId));
  const imported: ProjectedGithubThread[] = [];
  const reviews: ProjectedGithubReview[] = [];
  const context = createConversationReadContext(workspaceId);
  for (const member of manifest.doc.members) {
    if (member.status === "removed") continue;
    const lineage = getLineage(workspaceId, member.lineageSlug);
    const revision = getRevisionById(workspaceId, member.revisionId);
    if (!lineage || !revision || revision.lineage_id !== lineage.id) continue;
    const pinned = await readPinnedLineageConversation(workspaceId, {
      lineage,
      revisionId: revision.id,
      accountId: member.accountId,
      headSha: revision.doc.source.sourceHeadSha,
    }, viewerId, context);
    for (const thread of pinned.local) local.set(thread.id, thread);
    imported.push(...pinned.imported);
    reviews.push(...pinned.reviews);
  }
  return response({ local: [...local.values()], imported, reviews });
}

export async function handleRefreshConversations(req: Request, slug: string): Promise<Response> {
  let browserReturn: string | null = null;
  try {
    const gate = apiWorkspace(req, slug); if (gate instanceof Response) return gate;
    const lineage = getLineage(gate.workspaceId, slug)!;
    const body: Record<string, unknown> = await bodyOf(req).catch(() => ({}));
    if (isSessionForm(req)) browserReturn = cleanConversationReturn(body.return, gate.workspaceId, slug);
    const relation = getLineagePr(gate.workspaceId, lineage.id); const observation = latestObservation(gate.workspaceId, lineage.id);
    if (!relation || !observation) return softNotFound();
    const actor = readActorOf(relation);
    const keyAuth = gate.userId === null ? requireApiKey(req) : null;
    const asker = gate.userId ?? (!(keyAuth instanceof Response) && keyAuth ? keyAuth.userId : null);
    if (actor.kind === "anonymous") throw new ConversationError(422, "conversation_auth_required", "Conversation import needs an authenticated GitHub reader.");
    if (actor.kind === "user" && actor.userId !== asker) throw new ConversationError(403, "conversation_owner", "Only the owning member or one of their keys can refresh this conversation.");
    const headerKey = req.headers.get("idempotency-key");
    const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    const key = headerKey || bodyKey ? idempotency(req, body) : randomKey();
    const hash = digestOf({ operation: "conversation_refresh", lineageId: lineage.id, observationId: observation.id, actor });
    const held = db.query<{ request_hash: string; import_id: string }, [string, string]>("SELECT request_hash, import_id FROM review_conversation_refresh_idempotency WHERE workspace_id = ? AND idempotency_key = ?").get(gate.workspaceId, key);
    if (held) {
      if (held.request_hash !== hash) throw new ConversationError(409, "idempotency_conflict", "This idempotency key was already used for another refresh.");
      const replayed = getConversationImport(gate.workspaceId, held.import_id);
      if (!replayed) throw new Error(`Conversation refresh idempotency points at missing import ${held.import_id}`);
      return browserReturn ? redirectBack(browserReturn) : response(importView(replayed));
    }
    const now = Date.now();
    const recent = db.query<{ started_at: number }, [string, string]>(
      "SELECT started_at FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ? AND completed_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get(gate.workspaceId, lineage.id);
    if (recent && now - recent.started_at < CONVERSATION_REFRESH_COOLDOWN_MS) {
      throw new ConversationError(409, "conversation_refresh_cooldown", "Conversation was refreshed less than a minute ago.");
    }
    const started = db.transaction(() => {
      const row = startConversationImport({ workspaceId: gate.workspaceId, lineageId: lineage.id, observationId: observation.id, actor });
      db.run("INSERT INTO review_conversation_refresh_idempotency VALUES (?, ?, ?, ?, ?, ?)", [gate.workspaceId, key, hash, lineage.id, row.id, Date.now()]);
      return row;
    })();
    const completed = await runConversationImport(gate.workspaceId, lineage, observation, started);
    return browserReturn ? redirectBack(browserReturn) : response(importView(completed));
  } catch (error) {
    return browserReturn && error instanceof ConversationError ? redirectBack(browserReturn) : fail(error);
  }
}
