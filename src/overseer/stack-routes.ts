// The stack's API: create, read, refresh, publish the one account, drive the witness
// workflow, and read a member's retained lines through the manifest. Every route is
// declared with OpenAPI in src/api.ts, and every refusal on the read side is the review
// soft miss, so a slug is never an oracle for what a workspace is working on.

import { requireApiKey, sessionUser } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { RSW_ID_RE, SLUG_RE, STF_ID_RE } from "../ids";
import { getProject } from "../projects/db";
import { getStageCaptureForWorkspaces } from "../stage/db";
import { retainedLinesResponse } from "../stage/read";
import { getReview, lineageOwnsSlug } from "./db";
import { actorWords, GithubAppRefusal, openReadSession, resolveReadSession, type ReadActor } from "./github-app";
import { GithubError } from "./github";
import { readableWorkspaces, softNotFound } from "./read";
import { getLineage, getRevision, getWitnessRequestForRevision, listRevisionReadChangeIds, workflowWord } from "./revision-db";
import { readActorOf } from "./revision-pr";
import {
  claimStackWitnessRequest,
  createStack,
  currentStackManifest,
  failStackWitnessRequest,
  getStack,
  getStackAccountForManifest,
  getStackIdempotency,
  getStackManifest,
  getStackWitnessRequest,
  getStackWitnessRequestForManifest,
  listStackAccountTimes,
  listStackManifestTimes,
  listProjectSlugsForStack,
  listStackMembers,
  pinnedAccountsOf,
  pinnedMembers,
  publishStackAccount,
  refreshStackManifest,
  retryStackWitnessRequest,
  stackOwnsSlug,
  stackRequestHash,
  StackWriteError,
  stackWorkflowWord,
  type ReviewStackRow,
  type StackAccountRow,
  type StackManifestRow,
  type StackWitnessRequestRow,
} from "./stack-db";
import { listStackRefreshJobs, stackRefreshJobView } from "./stack-jobs";
import { getLineageById, liveMemberSlugsInOrder, normalizeInferredChain, normalizeNativeStack, seedMemberOf, stackDrift } from "./stack-pr";
import { MAX_STACK_MEMBERS, STACK_TITLE_MAX } from "./stack-types";
import { validateStackAccountBody } from "./stack-validate";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;
const POSITION_RE = /^[1-9][0-9]?$/;
const MAX_KEY_LENGTH = 200;

function stackJson(data: unknown, status = 200): Response {
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

function hasLineBreak(value: string): boolean {
  if (hasControlCharacter(value)) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x85 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (key === "" || key.length > MAX_KEY_LENGTH || hasControlCharacter(key)) {
    throw new StackWriteError(400, "Idempotency-Key header is required and must be a short printable value.");
  }
  return key;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new StackWriteError(400, "Body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StackWriteError(400, "Body must be a JSON object.");
  return body as Record<string, unknown>;
}

function projectsField(body: Record<string, unknown>): string[] {
  if (body.projects === undefined) return [];
  if (!Array.isArray(body.projects) || body.projects.length > 16 || body.projects.some((value) => typeof value !== "string" || !SLUG_RE.test(value))) {
    throw new StackWriteError(422, "projects must be a list of at most 16 project slugs.");
  }
  return [...new Set(body.projects as string[])].sort();
}

function failure(err: unknown): Response {
  if (err instanceof StackWriteError) return stackJson({ error: err.message }, err.status);
  if (err instanceof GithubAppRefusal) return stackJson({ error: err.message }, 422);
  if (err instanceof GithubError) return stackJson({ error: err.message }, err.status === 404 ? 422 : 502);
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
    return stackJson({ error: "Stack publication conflicted with an existing stack or membership." }, 409);
  }
  console.error("[seer] stack operation failed:", err);
  return stackJson({ error: "Stack operation failed." }, 502);
}

// ---- views ----

function stackUrl(stack: ReviewStackRow): string {
  return `${config.baseUrl}/${stack.workspace_id}/r-stacks/${stack.slug}`;
}

function manifestUrl(stack: ReviewStackRow, version: number): string {
  return `${stackUrl(stack)}/v/${version}`;
}

function witnessView(request: StackWitnessRequestRow, slug: string): unknown {
  return {
    id: request.id,
    workspace: request.workspace_id,
    slug,
    version: request.version,
    state: stackWorkflowWord(request),
    retryCount: request.retry_count,
    failure: request.failure,
    accountId: request.account_id,
    updatedAt: new Date(request.updated_at).toISOString(),
  };
}

function driftView(stack: ReviewStackRow, manifest: StackManifestRow): unknown {
  const drift = stackDrift(stack.workspace_id, stack, manifest);
  return {
    latestManifestVersion: drift.latestManifestVersion,
    latestManifestUrl: drift.latestManifestVersion === null ? null : manifestUrl(stack, drift.latestManifestVersion),
    newerRevisions: drift.newerRevisions.map((entry) => ({ ...entry, url: `${config.baseUrl}/${stack.workspace_id}/r/${entry.lineageSlug}/rev/${entry.revision}` })),
    newerAccounts: drift.newerAccounts,
    membershipChanged: drift.membershipChanged,
    removed: drift.removed,
    refreshRequired: drift.refreshRequired,
  };
}

/** The signed-in member, and never a key's owner: a key is an agent's credential rather
 *  than a person reading, and personal progress is not its business. */
function sessionMemberId(req: Request): string | null {
  if (req.headers.get("authorization")) return null;
  return sessionUser(req)?.id ?? null;
}

/** Per-member workflow word and the asking member's progress, from rows only. */
function memberViews(req: Request, stack: ReviewStackRow, manifest: StackManifestRow): unknown[] {
  const workspaceId = stack.workspace_id;
  const member = sessionMemberId(req);
  return manifest.doc.members.map((snapshot, index) => {
    const lineage = getLineageById(workspaceId, snapshot.lineageId);
    const revision = lineage ? getRevision(workspaceId, lineage.slug, snapshot.revision) : null;
    const inventory = revision ? getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]) : null;
    const total = inventory?.changes.length ?? 0;
    const read = member && revision ? listRevisionReadChangeIds(workspaceId, revision.id, member).size : null;
    return {
      position: index + 1,
      ...snapshot,
      witness: revision ? workflowWord(getWitnessRequestForRevision(workspaceId, revision.id)) : null,
      changes: total,
      progress: member === null ? null : { read: read ?? 0, total },
      url: `${config.baseUrl}/${workspaceId}/r/${snapshot.lineageSlug}/rev/${snapshot.revision}`,
      accountUrl: snapshot.accountVersion === null ? null : `${config.baseUrl}/${workspaceId}/r/${snapshot.lineageSlug}/v/${snapshot.accountVersion}`,
      apiUrl: `${config.baseUrl}/api/review-lineages/${snapshot.lineageSlug}`,
    };
  });
}

function manifestView(req: Request, stack: ReviewStackRow, manifest: StackManifestRow): unknown {
  const request = getStackWitnessRequestForManifest(stack.workspace_id, manifest.id);
  const account = getStackAccountForManifest(stack.workspace_id, manifest.id);
  const member = sessionMemberId(req);
  const members = memberViews(req, stack, manifest) as { changes: number; progress: { read: number; total: number } | null; status: string }[];
  const pinned = members.filter((entry) => entry.status !== "removed");
  return {
    id: manifest.id,
    stack: stack.id,
    slug: stack.slug,
    workspace: stack.workspace_id,
    version: manifest.version,
    predecessorVersion: manifest.predecessor_version,
    reason: manifest.reason,
    schemaVersion: manifest.schema_version,
    digest: manifest.digest,
    url: manifestUrl(stack, manifest.version),
    accountUrl: account ? `${manifestUrl(stack, manifest.version)}/account` : null,
    apiUrl: `${config.baseUrl}/api/review-stacks/${stack.slug}/manifests/${manifest.version}`,
    createdAt: new Date(manifest.created_at).toISOString(),
    document: manifest.doc,
    members,
    progress: member === null ? null : {
      read: pinned.reduce((sum, entry) => sum + (entry.progress?.read ?? 0), 0),
      total: pinned.reduce((sum, entry) => sum + entry.changes, 0),
    },
    witness: request ? witnessView(request, stack.slug) : null,
    account: account ? { id: account.id, version: account.version, url: `${manifestUrl(stack, manifest.version)}/account` } : null,
    drift: driftView(stack, manifest),
  };
}

function accountView(stack: ReviewStackRow, account: StackAccountRow, request: StackWitnessRequestRow): unknown {
  return {
    id: account.id,
    stack: stack.id,
    manifest: account.manifest_id,
    slug: stack.slug,
    workspace: stack.workspace_id,
    version: account.version,
    schemaVersion: account.schema_version,
    digest: account.digest,
    url: `${manifestUrl(stack, account.version)}/account`,
    manifestUrl: manifestUrl(stack, account.version),
    createdAt: new Date(account.created_at).toISOString(),
    document: account.doc,
    witness: witnessView(request, stack.slug),
  };
}

function stackView(req: Request, stack: ReviewStackRow): unknown {
  const workspaceId = stack.workspace_id;
  const manifest = currentStackManifest(stack);
  if (!manifest) throw new Error(`Stack ${stack.id} has no current manifest`);
  const account = getStackAccountForManifest(workspaceId, manifest.id);
  const request = getStackWitnessRequestForManifest(workspaceId, manifest.id);
  const accounts = new Map(listStackAccountTimes(workspaceId, stack.slug).map((row) => [row.version, row.created_at]));
  return {
    id: stack.id,
    slug: stack.slug,
    workspace: workspaceId,
    title: stack.title,
    repo: stack.repo,
    repoId: stack.repo_id,
    baseRef: stack.base_ref,
    source: stack.source,
    providerStackNumber: stack.provider_stack_number,
    actor: stack.actor_kind,
    actorLabel: actorWords(readActorOf(stack)),
    latestManifestVersion: stack.latest_manifest_version,
    latestAccountVersion: account ? account.version : ([...accounts.keys()].at(-1) ?? null),
    url: stackUrl(stack),
    apiUrl: `${config.baseUrl}/api/review-stacks/${stack.slug}`,
    projects: listProjectSlugsForStack(workspaceId, stack.slug),
    members: listStackMembers(stack.id).map((row) => ({
      lineageId: row.lineage_id,
      lineageSlug: row.lineage_slug,
      prNumber: row.pr_number,
      live: row.removed_at === null,
      removedReason: row.removed_reason,
      addedManifestId: row.added_manifest_id,
      removedManifestId: row.removed_manifest_id,
    })),
    manifests: listStackManifestTimes(workspaceId, stack.slug).map((row) => ({
      version: row.version,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
      witness: stackWorkflowWord(getStackWitnessRequestForManifest(workspaceId, row.id)),
      account: accounts.has(row.version),
      url: manifestUrl(stack, row.version),
      apiUrl: `${config.baseUrl}/api/review-stacks/${stack.slug}/manifests/${row.version}`,
    })),
    manifest: manifestView(req, stack, manifest),
    account: account && request ? accountView(stack, account, request) : null,
    refreshJobs: listStackRefreshJobs(workspaceId, stack.id).map(stackRefreshJobView),
  };
}

// ---- POST /api/review-stacks ----

function titleField(body: Record<string, unknown>, fallback: string): string {
  if (body.title === undefined) return fallback.trim().slice(0, STACK_TITLE_MAX);
  if (typeof body.title !== "string" || body.title.trim() === "" || body.title.length > STACK_TITLE_MAX || hasLineBreak(body.title)) {
    throw new StackWriteError(422, `title must be one line of at most ${STACK_TITLE_MAX} characters.`);
  }
  return body.title.trim();
}

export async function handleCreateStack(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) { auth.headers.set("cache-control", "no-store"); return auth; }
  try {
    const key = idempotencyKeyOf(req);
    const body = await readBody(req);
    const extra = Object.keys(body).find((name) => !["slug", "title", "projects", "members", "native"].includes(name));
    if (extra) throw new StackWriteError(422, `${JSON.stringify(extra)} is not a supported field.`);
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) throw new StackWriteError(422, "slug must match [a-z0-9][a-z0-9-]{0,63}.");
    const slug = body.slug;
    const projects = projectsField(body);
    const hasMembers = body.members !== undefined;
    const hasNative = body.native !== undefined;
    if (hasMembers === hasNative) throw new StackWriteError(422, "Exactly one of members and native is required.");
    let members: string[] = [];
    let seed: string | null = null;
    if (hasMembers) {
      if (!Array.isArray(body.members) || body.members.length < 2 || body.members.length > MAX_STACK_MEMBERS ||
          body.members.some((value) => typeof value !== "string" || !SLUG_RE.test(value))) {
        throw new StackWriteError(422, `members must be 2 to ${MAX_STACK_MEMBERS} promoted review slugs, bottom to top.`);
      }
      members = body.members as string[];
    } else {
      const native = body.native;
      if (!native || typeof native !== "object" || Array.isArray(native) || typeof (native as Record<string, unknown>).seed !== "string" ||
          !SLUG_RE.test((native as Record<string, unknown>).seed as string) || Object.keys(native).some((name) => name !== "seed")) {
        throw new StackWriteError(422, "native must be { seed: <promoted review slug> }.");
      }
      seed = (native as Record<string, unknown>).seed as string;
    }
    const requestHash = stackRequestHash("create", null, { slug, title: body.title ?? null, projects, members, seed });

    const held = getStackIdempotency(auth.workspaceId, key);
    if (held) {
      if (held.request_hash !== requestHash) return stackJson({ error: "This Idempotency-Key was already used for a different stack request." }, 409);
      const stack = getStack(auth.workspaceId, slug);
      if (stack) return stackJson(stackView(req, stack), 200);
    }
    if (stackOwnsSlug(auth.workspaceId, slug)) return stackJson({ error: `Stack slug "${slug}" already names another stack` }, 409);
    if (lineageOwnsSlug(auth.workspaceId, slug)) return stackJson({ error: `Stack slug "${slug}" already names a promoted review` }, 409);
    if (getReview(auth.workspaceId, slug)) return stackJson({ error: `Stack slug "${slug}" already names a review in this workspace` }, 409);
    for (const project of projects) {
      if (!getProject(auth.workspaceId, project)) return stackJson({ error: `No project "${project}" in this workspace` }, 422);
    }

    let normalized;
    let actor: ReadActor = { kind: "anonymous" };
    if (seed === null) {
      normalized = normalizeInferredChain(auth.workspaceId, members);
    } else {
      const lineage = getLineage(auth.workspaceId, seed);
      if (!lineage) throw new StackWriteError(422, `"${seed}": is not a promoted review in this workspace [no-lineage]`);
      const session = await resolveReadSession(auth.workspaceId, lineage.repo, auth.userId);
      actor = session.actor;
      normalized = await normalizeNativeStack(auth.workspaceId, lineage, session);
    }
    const title = titleField(body, normalized.members.find((member) => member.status !== "removed")?.title ?? slug);
    const result = createStack({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      idempotencyKey: key,
      requestHash,
      slug,
      title,
      projects,
      actor,
      normalized,
      legacyOwnsSlug: (candidate) => getReview(auth.workspaceId, candidate) !== null,
    });
    return stackJson(stackView(req, result.stack), result.created ? 201 : 200);
  } catch (err) {
    return failure(err);
  }
}

// ---- reads ----

function resolveReadable(req: Request, slug: string): ReviewStackRow | null {
  if (!SLUG_RE.test(slug)) return null;
  for (const workspaceId of readableWorkspaces(req)) {
    const stack = getStack(workspaceId, slug);
    if (stack) return stack;
  }
  return null;
}

export function handleReadStack(req: Request, slug: string): Response {
  const stack = resolveReadable(req, slug);
  if (!stack) return softNotFound();
  return stackJson(stackView(req, stack));
}

function resolveManifest(req: Request, slug: string, rawVersion: string): { stack: ReviewStackRow; manifest: StackManifestRow } | null {
  if (!NUMBER_RE.test(rawVersion)) return null;
  const stack = resolveReadable(req, slug);
  if (!stack) return null;
  const manifest = getStackManifest(stack.workspace_id, slug, Number(rawVersion));
  return manifest ? { stack, manifest } : null;
}

export function handleReadStackManifest(req: Request, slug: string, rawVersion: string): Response {
  const resolved = resolveManifest(req, slug, rawVersion);
  if (!resolved) return softNotFound();
  return stackJson(manifestView(req, resolved.stack, resolved.manifest));
}

export function handleReadStackAccount(req: Request, slug: string, rawVersion: string): Response {
  const resolved = resolveManifest(req, slug, rawVersion);
  if (!resolved) return softNotFound();
  const account = getStackAccountForManifest(resolved.stack.workspace_id, resolved.manifest.id);
  const request = account ? getStackWitnessRequestForManifest(resolved.stack.workspace_id, resolved.manifest.id) : null;
  if (!account || !request) return softNotFound();
  return stackJson(accountView(resolved.stack, account, request));
}

// ---- POST /api/review-stacks/:slug/manifests/:version/account ----

export async function handlePublishStackAccount(req: Request, slug: string, rawVersion: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) { auth.headers.set("cache-control", "no-store"); return auth; }
  if (!SLUG_RE.test(slug) || !NUMBER_RE.test(rawVersion)) return softNotFound();
  const stack = getStack(auth.workspaceId, slug);
  if (!stack) return softNotFound();
  const manifest = getStackManifest(auth.workspaceId, slug, Number(rawVersion));
  if (!manifest) return softNotFound();
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    return failure(err);
  }
  const pinned = pinnedAccountsOf(auth.workspaceId, manifest);
  if (pinned.size !== pinnedMembers(manifest.doc).length) {
    const missing = pinnedMembers(manifest.doc).filter((member) => !pinned.has(member.lineageId)).map((member) => member.lineageSlug);
    return stackJson({ error: `Manifest ${manifest.version} is not account-ready: no account on the pinned revision of ${missing.map((entry) => `"${entry}"`).join(", ")}` }, 409);
  }
  const checked = validateStackAccountBody(body, manifest, pinned);
  if (!checked.value) return stackJson({ errors: checked.errors }, 422);
  try {
    const result = publishStackAccount({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      keyId: auth.keyId,
      stack,
      manifest,
      witness: { summary: checked.value.summary, agent: checked.value.witness },
      groups: checked.value.groups,
    });
    return stackJson(accountView(stack, result.account, result.request));
  } catch (err) {
    return failure(err);
  }
}

// ---- POST /api/review-stacks/:slug/refresh ----

export async function handleRefreshStack(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) { auth.headers.set("cache-control", "no-store"); return auth; }
  if (!SLUG_RE.test(slug)) return softNotFound();
  const stack = getStack(auth.workspaceId, slug);
  if (!stack) return softNotFound();
  try {
    const key = idempotencyKeyOf(req);
    const requestHash = stackRequestHash("refresh", slug, {});
    const actor = readActorOf(stack);
    if (stack.source === "native" && actor.kind === "user" && actor.userId !== auth.userId) {
      throw new StackWriteError(403, "This stack reads through another member's account");
    }
    const held = getStackIdempotency(auth.workspaceId, key);
    if (held) {
      if (held.request_hash !== requestHash) return stackJson({ error: "This Idempotency-Key was already used for a different stack request." }, 409);
      return stackJson({ created: false, replayed: true, ...(stackView(req, stack) as Record<string, unknown>) });
    }
    const current = currentStackManifest(stack);
    if (!current) throw new Error(`Stack ${stack.id} has no current manifest`);
    let normalized;
    if (stack.source === "native") {
      const seed = seedMemberOf(auth.workspaceId, current);
      if (!seed) throw new StackWriteError(422, "This stack has no live member to read the native stack from.");
      const session = await openReadSession(auth.workspaceId, actor, stack.repo, stack.repo_id);
      normalized = await normalizeNativeStack(auth.workspaceId, seed, session, current);
    } else {
      normalized = normalizeInferredChain(auth.workspaceId, liveMemberSlugsInOrder(stack, current), current);
    }
    const outcome = db.transaction(() => {
      const result = refreshStackManifest(stack, normalized);
      db.run(
        "INSERT INTO review_stack_idempotency (workspace_id, idempotency_key, request_hash, operation, stack_id, manifest_id, created_at) VALUES (?, ?, ?, 'refresh', ?, ?, ?)",
        [auth.workspaceId, key, requestHash, stack.id, result.manifest.id, Date.now()],
      );
      return result;
    })();
    return stackJson({ created: outcome.created, replayed: false, ...(stackView(req, getStack(auth.workspaceId, slug) ?? stack) as Record<string, unknown>) });
  } catch (err) {
    return failure(err);
  }
}

// ---- witness requests ----

function resolveRequest(req: Request, id: string): { request: StackWitnessRequestRow; slug: string; userId: string; keyId: string } | Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) { auth.headers.set("cache-control", "no-store"); return auth; }
  if (!RSW_ID_RE.test(id)) return softNotFound();
  const request = getStackWitnessRequest(auth.workspaceId, id);
  if (!request) return softNotFound();
  const stack = db.query<{ slug: string }, [string]>("SELECT slug FROM review_stacks WHERE id = ?").get(request.stack_id);
  if (!stack) return softNotFound();
  return { request, slug: stack.slug, userId: auth.userId, keyId: auth.keyId };
}

export function handleClaimStackWitnessRequest(req: Request, id: string): Response {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  try {
    const result = claimStackWitnessRequest({ workspaceId: resolved.request.workspace_id, requestId: resolved.request.id, userId: resolved.userId, keyId: resolved.keyId });
    const manifest = db.query<{ id: string }, [string]>("SELECT id FROM review_stack_manifests WHERE id = ?").get(resolved.request.manifest_id);
    return stackJson({
      ...(witnessView(result.request, resolved.slug) as Record<string, unknown>),
      manifestId: manifest?.id ?? resolved.request.manifest_id,
      manifestUrl: `${config.baseUrl}/api/review-stacks/${resolved.slug}/manifests/${resolved.request.version}`,
      claim: {
        retryCount: result.claim.retry_count,
        claimed: result.created,
        leaseExpiresAt: new Date(result.claim.lease_expires_at).toISOString(),
        claimedAt: new Date(result.claim.claimed_at).toISOString(),
      },
    });
  } catch (err) {
    return failure(err);
  }
}

export async function handleFailStackWitnessRequest(req: Request, id: string): Promise<Response> {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    return failure(err);
  }
  const raw = body.error;
  const extra = Object.keys(body).find((key) => key !== "error");
  if (extra) return stackJson({ error: `${JSON.stringify(extra)} is not a supported field.` }, 422);
  if (typeof raw !== "string" || raw.trim() === "") return stackJson({ error: "error is required and must say what went wrong." }, 422);
  if (hasLineBreak(raw)) return stackJson({ error: "error must be one line with no control characters." }, 422);
  if (raw.length > 600) return stackJson({ error: `error is over budget: ${raw.length} of at most 600 characters` }, 422);
  try {
    const updated = failStackWitnessRequest(resolved.request.workspace_id, resolved.request, raw.trim(), { userId: resolved.userId, keyId: resolved.keyId });
    return stackJson(witnessView(updated, resolved.slug));
  } catch (err) {
    return failure(err);
  }
}

export function handleRetryStackWitnessRequest(req: Request, id: string): Response {
  const resolved = resolveRequest(req, id);
  if (resolved instanceof Response) return resolved;
  try {
    return stackJson(witnessView(retryStackWitnessRequest(resolved.request.workspace_id, resolved.request), resolved.slug));
  } catch (err) {
    return failure(err);
  }
}

// ---- retained lines through the manifest ----

/** `/members/:position/files/:fileId`: manifest → member → its pinned revision → the real
 *  `stf_` id that revision's capture owns. A foreign file id is the same soft miss. */
export async function handleStackMemberLines(req: Request, slug: string, rawVersion: string, rawPosition: string, fileId: string): Promise<Response> {
  if (!POSITION_RE.test(rawPosition) || !STF_ID_RE.test(fileId)) return softNotFound();
  const resolved = resolveManifest(req, slug, rawVersion);
  if (!resolved) return softNotFound();
  const member = resolved.manifest.doc.members[Number(rawPosition) - 1];
  if (!member) return softNotFound();
  const workspaceId = resolved.stack.workspace_id;
  const revision = getRevision(workspaceId, member.lineageSlug, member.revision);
  if (!revision || revision.id !== member.revisionId) return softNotFound();
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
  const file = inventory?.files.find((candidate) => candidate.id === fileId);
  if (!inventory || !file) return softNotFound();
  return retainedLinesResponse(workspaceId, file, new URL(req.url), `${workspaceId}/r-stacks/${slug}/v/${rawVersion}/m/${rawPosition}`);
}
