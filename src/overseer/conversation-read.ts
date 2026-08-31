import { db } from "../db";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../stage/db";
import { loadStageBytes, retainedLineWindow } from "../stage/read";
import { projectGithub } from "./actor-projection";
import type { CapabilityMember, ResolvedCapability } from "./capability-types";
import {
  latestCommentObservation,
  latestImportedConversation,
  latestReviewObservation,
  latestThreadObservation,
  type GithubCommentObservationRow,
  type GithubReviewObservationRow,
  type GithubThreadObservationRow,
} from "./conversation-import";
import {
  type GithubPlacementResult,
  type ProjectedGithubReview,
  type ProjectedGithubThread,
  type ProjectedLocalThread,
  type WitnessConversationContext,
} from "./conversation-types";
import {
  getLocalThread,
  listLocalThreadsForLineage,
  listLocalThreadsForRevision,
  listLocalThreadsForStackAccount,
  localThreadState,
  projectLocalThread,
  type LocalThreadRecord,
} from "./thread-db";
import { digestOf, getLineage, getRevision, getRevisionById, type ReviewLineageRow, type ReviewRevisionRow } from "./revision-db";
import { getStackAccount, type StackManifestRow } from "./stack-db";
import { mergeMappedGithubConversation } from "./github-thread-sync";

interface GithubThreadRow { id: string; workspace_id: string; lineage_id: string; repo_id: number; pr_number: number; github_node_id: string | null; first_comment_database_id: string | null; first_observed_at: number }
interface GithubCommentRow { id: string; workspace_id: string; thread_id: string; github_database_id: string; github_node_id: string; github_created_at: number; first_observed_at: number }
interface GithubReviewRow { id: string; workspace_id: string; lineage_id: string; github_database_id: string; github_node_id: string; first_observed_at: number }

interface LineagePlacementContext {
  revisions: ReviewRevisionRow[];
  byHead: Map<string, ReviewRevisionRow>;
}
interface RetainedObjectFacts { totalLines: number }

/** One request, page render, witness claim, capability read, or mint gets one of these.
 * Revisions, capture inventories, and retained-object line counts are loaded once per
 * distinct immutable value and shared by every imported thread projected in that call. */
export interface ConversationReadContext {
  workspaceId: string;
  lineages: Map<string, LineagePlacementContext>;
  inventories: Map<string, StageCaptureInventory | null>;
  retainedObjects: Map<string, Promise<RetainedObjectFacts | null>>;
}

export function createConversationReadContext(workspaceId: string): ConversationReadContext {
  return { workspaceId, lineages: new Map(), inventories: new Map(), retainedObjects: new Map() };
}

function lineagePlacement(context: ConversationReadContext, lineage: ReviewLineageRow): LineagePlacementContext {
  if (context.workspaceId !== lineage.workspace_id) throw new Error("Conversation placement context crossed workspaces");
  const cached = context.lineages.get(lineage.id);
  if (cached) return cached;
  const revisions = db.query<{ revision: number }, [string, string]>(
    "SELECT revision FROM review_revisions WHERE workspace_id = ? AND lineage_id = ? ORDER BY revision",
  ).all(context.workspaceId, lineage.id)
    .map((row) => getRevision(context.workspaceId, lineage.slug, row.revision))
    .filter((row): row is ReviewRevisionRow => row !== null);
  const value = { revisions, byHead: new Map(revisions.map((row) => [row.doc.source.sourceHeadSha, row])) };
  context.lineages.set(lineage.id, value);
  return value;
}

function inventoryOf(context: ConversationReadContext, revision: ReviewRevisionRow): StageCaptureInventory | null {
  if (context.inventories.has(revision.capture_id)) return context.inventories.get(revision.capture_id)!;
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [context.workspaceId]);
  context.inventories.set(revision.capture_id, inventory);
  return inventory;
}

function retainedObjectFacts(context: ConversationReadContext, digest: string): Promise<RetainedObjectFacts | null> {
  const cached = context.retainedObjects.get(digest);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const window = retainedLineWindow(await loadStageBytes(context.workspaceId, digest), 1, 1);
      return window === null ? null : { totalLines: window.totalLines };
    } catch {
      return null;
    }
  })();
  context.retainedObjects.set(digest, pending);
  return pending;
}

function terminalThreadDeletion(workspaceId: string, threadId: string): GithubThreadObservationRow | null {
  return db.query<GithubThreadObservationRow, [string, string]>(
    "SELECT * FROM review_github_thread_observations WHERE workspace_id = ? AND thread_id = ? AND deleted = 1 ORDER BY source_observed_at DESC, observed_at DESC, rowid DESC LIMIT 1",
  ).get(workspaceId, threadId);
}

function selectedThreadObservation(workspaceId: string, threadId: string, exactObservationId?: string): GithubThreadObservationRow | null {
  const terminal = terminalThreadDeletion(workspaceId, threadId);
  if (terminal) return terminal;
  return exactObservationId
    ? db.query<GithubThreadObservationRow, [string, string, string]>(
      "SELECT * FROM review_github_thread_observations WHERE workspace_id = ? AND thread_id = ? AND id = ?",
    ).get(workspaceId, threadId, exactObservationId)
    : latestThreadObservation(workspaceId, threadId);
}

export async function placeImportedThread(
  workspaceId: string,
  lineage: ReviewLineageRow,
  observation: GithubThreadObservationRow,
  context = createConversationReadContext(workspaceId),
): Promise<GithubPlacementResult> {
  if (context.workspaceId !== workspaceId) throw new Error("Conversation placement context crossed workspaces");
  if (observation.deleted) return { kind: "conversation", reason: "deleted" };
  const commit = !observation.outdated ? observation.commit_sha : observation.original_commit_sha ?? observation.commit_sha;
  const start = !observation.outdated ? observation.start_line : observation.original_start_line ?? observation.start_line;
  const end = !observation.outdated ? observation.end_line : observation.original_end_line ?? observation.end_line;
  if (!commit) return { kind: "conversation", reason: observation.outdated ? "outdated" : "commit_not_retained" };
  const revision = lineagePlacement(context, lineage).byHead.get(commit);
  if (!revision) return { kind: "conversation", reason: "commit_not_retained" };
  const inventory = inventoryOf(context, revision);
  const file = inventory?.files.find((row) => row.path === observation.path || row.old_path === observation.path);
  if (!inventory || !file) return { kind: "conversation", reason: "path_not_retained" };
  if (!observation.side) return { kind: "conversation", reason: "side_not_retained" };
  const side = observation.side === "old"
    ? { availability: file.old_availability, kind: file.old_kind, digest: file.old_blob_sha }
    : { availability: file.new_availability, kind: file.new_kind, digest: file.new_blob_sha };
  if (side.availability !== "retained" || side.kind !== "blob" || !side.digest) return { kind: "conversation", reason: "side_not_retained" };
  if (!start || !end || end < start) return { kind: "conversation", reason: "line_not_retained" };
  const object = await retainedObjectFacts(context, side.digest);
  if (!object || start > object.totalLines || end > object.totalLines) return { kind: "conversation", reason: "line_not_retained" };
  return { kind: "code", revisionId: revision.id, revision: revision.revision, fileId: file.id, path: observation.path ?? file.path, side: observation.side, startLine: start, endLine: end, objectDigest: side.digest };
}

async function projectGithubThread(
  workspaceId: string,
  lineage: ReviewLineageRow,
  thread: GithubThreadRow,
  context: ConversationReadContext,
  exactObservationId?: string,
  exactCommentIds?: Map<string, string>,
  restrictComments = false,
): Promise<ProjectedGithubThread | null> {
  const observation = selectedThreadObservation(workspaceId, thread.id, exactObservationId);
  if (!observation) return null;
  const comments = db.query<GithubCommentRow, [string, string]>(
    "SELECT * FROM review_github_comments WHERE workspace_id = ? AND thread_id = ? ORDER BY github_created_at, rowid",
  ).all(workspaceId, thread.id);
  const projected = comments.flatMap((comment) => {
    if (restrictComments && !exactCommentIds?.has(comment.id)) return [];
    const current = latestCommentObservation(workspaceId, comment.id);
    const exact = exactCommentIds?.get(comment.id);
    const selected = current?.deleted === 1 ? current : exact
      ? db.query<GithubCommentObservationRow, [string, string, string]>(
        "SELECT * FROM review_github_comment_observations WHERE workspace_id = ? AND comment_id = ? AND id = ?",
      ).get(workspaceId, comment.id, exact)
      : current;
    if (!selected) return [];
    return [{ id: comment.id, author: projectGithub(selected.author_login), body: observation.deleted || selected.deleted ? null : selected.body, deleted: observation.deleted === 1 || selected.deleted === 1, url: selected.github_url, createdAt: new Date(comment.github_created_at).toISOString(), updatedAt: new Date(selected.github_updated_at).toISOString() }];
  });
  return {
    id: thread.id,
    resolved: observation.resolved === 1,
    deleted: observation.deleted === 1,
    outdated: observation.outdated === 1,
    url: observation.github_url,
    placement: await placeImportedThread(workspaceId, lineage, observation, context),
    comments: projected,
  };
}

function projectReview(workspaceId: string, review: GithubReviewRow, exactObservationId?: string): ProjectedGithubReview | null {
  const observation = exactObservationId
    ? db.query<GithubReviewObservationRow, [string, string, string]>(
      "SELECT * FROM review_github_review_observations WHERE workspace_id = ? AND review_id = ? AND id = ?",
    ).get(workspaceId, review.id, exactObservationId)
    : latestReviewObservation(workspaceId, review.id);
  if (!observation) return null;
  return { id: review.id, author: projectGithub(observation.author_login), state: observation.state, body: observation.deleted ? null : observation.body, url: observation.github_url, commitSha: observation.commit_sha, submittedAt: observation.submitted_at === null ? null : new Date(observation.submitted_at).toISOString(), dismissed: observation.dismissed === 1, deleted: observation.deleted === 1 };
}

export async function listImportedThreads(
  workspaceId: string,
  lineage: ReviewLineageRow,
  options: { context?: ConversationReadContext; revisionIds?: ReadonlySet<string> } = {},
): Promise<ProjectedGithubThread[]> {
  const context = options.context ?? createConversationReadContext(workspaceId);
  const rows = db.query<GithubThreadRow, [string, string]>(
    "SELECT * FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? ORDER BY first_observed_at, rowid",
  ).all(workspaceId, lineage.id);
  const projected = (await Promise.all(rows.map((row) => projectGithubThread(workspaceId, lineage, row, context))))
    .filter((row): row is ProjectedGithubThread => row !== null);
  return options.revisionIds
    ? projected.filter((row) => row.placement.kind === "code" && options.revisionIds!.has(row.placement.revisionId))
    : projected;
}

export function listImportedReviews(
  workspaceId: string,
  lineageId: string,
  options: { commitShas?: ReadonlySet<string> } = {},
): ProjectedGithubReview[] {
  const wrappers = new Set(db.query<{ github_review_id: string }, [string, string]>(
    "SELECT github_review_id FROM review_local_github_threads WHERE workspace_id=? AND lineage_id=?",
  ).all(workspaceId, lineageId).map((row) => row.github_review_id));
  const projected = db.query<GithubReviewRow, [string, string]>(
    "SELECT * FROM review_github_reviews WHERE workspace_id = ? AND lineage_id = ? ORDER BY first_observed_at, rowid",
  ).all(workspaceId, lineageId).flatMap((stored) => {
    const review = projectReview(workspaceId, stored);
    if (!review) return [];
    // Posting one thread through addPullRequestReview creates an otherwise empty
    // COMMENTED review. Hide only that wrapper. A body or verdict remains conversation.
    if (wrappers.has(stored.github_node_id) && review.state === "commented" && (review.body ?? "").trim() === "") return [];
    return [review];
  });
  return options.commitShas ? projected.filter((row) => row.commitSha !== null && options.commitShas!.has(row.commitSha)) : projected;
}

export interface ExactConversationPin {
  lineage: ReviewLineageRow;
  revisionId: string;
  accountId: string | null;
  headSha: string;
}

export function localThreadBelongsToPin(record: LocalThreadRecord, pin: ExactConversationPin): boolean {
  if (record.thread.workspace_id !== pin.lineage.workspace_id || record.thread.scope_kind !== "lineage" || record.thread.lineage_id !== pin.lineage.id) return false;
  const anchor = record.anchor;
  if (anchor.workspace_id !== pin.lineage.workspace_id || anchor.lineage_id !== pin.lineage.id || anchor.revision_id !== pin.revisionId) return false;
  if (anchor.anchor_kind === "review" || anchor.anchor_kind === "change" || anchor.anchor_kind === "range") return true;
  return (anchor.anchor_kind === "account" || anchor.anchor_kind === "member_group") && pin.accountId !== null && anchor.account_id === pin.accountId;
}

function pinnedLocalThreads(workspaceId: string, pin: ExactConversationPin): LocalThreadRecord[] {
  return listLocalThreadsForRevision(workspaceId, pin.revisionId).filter((thread) => localThreadBelongsToPin(thread, pin));
}

export async function readPinnedLineageConversation(
  workspaceId: string,
  pin: ExactConversationPin,
  viewerId: string | null,
  context = createConversationReadContext(workspaceId),
  memberLabels?: ReadonlyMap<string, string>,
): Promise<{ local: ProjectedLocalThread[]; imported: ProjectedGithubThread[]; reviews: ProjectedGithubReview[] }> {
  return {
    local: pinnedLocalThreads(workspaceId, pin).map((thread) => projectLocalThread(thread, viewerId, thread.thread.append_version, memberLabels)),
    imported: await listImportedThreads(workspaceId, pin.lineage, { context, revisionIds: new Set([pin.revisionId]) }),
    reviews: listImportedReviews(workspaceId, pin.lineage.id, { commitShas: new Set([pin.headSha]) }),
  };
}

export async function witnessConversationContext(
  workspaceId: string,
  lineage: ReviewLineageRow,
  pin?: ExactConversationPin,
  context = createConversationReadContext(workspaceId),
): Promise<WitnessConversationContext> {
  const imported = (await listImportedThreads(workspaceId, lineage, { context, ...(pin ? { revisionIds: new Set([pin.revisionId]) } : {}) }))
    .filter((thread) => !thread.deleted && !thread.resolved);
  const records = pin ? pinnedLocalThreads(workspaceId, pin) : listLocalThreadsForLineage(workspaceId, lineage.id);
  const local = records.filter((thread) => localThreadState(thread) === "open").map((thread) => projectLocalThread(thread, null));
  const projected = mergeMappedGithubConversation(workspaceId, lineage.id, local, imported);
  const latest = latestImportedConversation(workspaceId, lineage.id);
  return {
    local: projected.local,
    imported: projected.imported,
    reviews: listImportedReviews(workspaceId, lineage.id, pin ? { commitShas: new Set([pin.headSha]) } : {}).filter((review) => !review.deleted),
    import: latest === null ? { state: "never", complete: false, truncated: false, observedAt: null } : {
      state: latest.state === "running" ? "failed" : latest.state,
      complete: latest.complete === 1,
      truncated: latest.truncated === 1,
      observedAt: latest.completed_at === null ? null : new Date(latest.completed_at).toISOString(),
    },
  };
}

export async function stackWitnessConversationContext(workspaceId: string, manifest: StackManifestRow): Promise<WitnessConversationContext> {
  const context = createConversationReadContext(workspaceId);
  const contexts: WitnessConversationContext[] = [];
  for (const member of manifest.doc.members) {
    if (member.status === "removed") continue;
    const lineage = getLineage(workspaceId, member.lineageSlug);
    const revision = getRevisionById(workspaceId, member.revisionId);
    if (!lineage || !revision || revision.lineage_id !== lineage.id) continue;
    contexts.push(await witnessConversationContext(workspaceId, lineage, {
      lineage,
      revisionId: revision.id,
      accountId: member.accountId,
      headSha: revision.doc.source.sourceHeadSha,
    }, context));
  }
  const stackAccount = getStackAccount(workspaceId, manifest.slug, manifest.version);
  const direct = stackAccount
    ? listLocalThreadsForStackAccount(workspaceId, stackAccount.id)
      .filter((thread) => localThreadState(thread) === "open")
      .map((thread) => projectLocalThread(thread, null))
    : [];
  const imports = contexts.map((value) => value.import);
  return {
    local: [...direct, ...contexts.flatMap((value) => value.local)],
    imported: contexts.flatMap((value) => value.imported),
    reviews: contexts.flatMap((value) => value.reviews),
    import: imports.some((value) => value.state === "failed")
      ? { state: "failed", complete: imports.length > 0 && imports.every((value) => value.complete), truncated: imports.some((value) => value.truncated), observedAt: null }
      : { state: imports.length ? "completed" : "never", complete: imports.length > 0 && imports.every((value) => value.complete), truncated: imports.some((value) => value.truncated), observedAt: null },
  };
}

export interface CapabilityConversationSnapshot {
  local: ProjectedLocalThread[];
  imported: ProjectedGithubThread[];
  reviews: ProjectedGithubReview[];
}

function capabilityPins(capability: ResolvedCapability): ExactConversationPin[] {
  const members: CapabilityMember[] = capability.kind === "review" ? [{
    position: 1,
    snapshot: null,
    lineage: capability.lineage,
    revision: capability.revision,
    account: capability.account,
    inventory: capability.inventory,
  }] : capability.members;
  return members.map((member) => ({
    lineage: member.lineage,
    revisionId: member.revision.id,
    accountId: member.account?.id ?? null,
    headSha: member.revision.doc.source.sourceHeadSha,
  }));
}

function localThreadContained(record: LocalThreadRecord, capability: ResolvedCapability, pins: ExactConversationPin[]): boolean {
  const pin = pins.find((candidate) => candidate.lineage.id === record.anchor.lineage_id);
  if (pin && localThreadBelongsToPin(record, pin)) return true;
  if (capability.kind !== "stack" || capability.account === null) return false;
  return record.thread.scope_kind === "stack" && record.thread.stack_id === capability.stack.id &&
    record.anchor.workspace_id === capability.share.workspace_id &&
    (record.anchor.anchor_kind === "stack" || record.anchor.anchor_kind === "stack_group") &&
    record.anchor.stack_id === capability.stack.id && record.anchor.stack_manifest_id === capability.manifest.id &&
    record.anchor.stack_account_id === capability.account.id;
}

interface CapabilityLocalRow { workspace_id: string; thread_id: string; through_seq: number }
interface CapabilityThreadRow { workspace_id: string; thread_id: string; thread_observation_id: string }
interface CapabilityCommentRow { workspace_id: string; thread_id: string; comment_id: string; comment_observation_id: string }
interface CapabilityReviewRow { workspace_id: string; review_id: string; review_observation_id: string }

/** Resolve copied conversation ids only after rechecking their workspace, identity
 * relationship, exact document pin, and copied observation ownership. Any inconsistent
 * row invalidates the capability instead of being skipped or widened. */
export async function readCapabilityConversation(capability: ResolvedCapability): Promise<CapabilityConversationSnapshot | null> {
  const workspaceId = capability.share.workspace_id;
  const shareId = capability.share.id;
  const pins = capabilityPins(capability);
  const pinByLineage = new Map(pins.map((pin) => [pin.lineage.id, pin]));
  const context = createConversationReadContext(workspaceId);

  const local: ProjectedLocalThread[] = [];
  const localRows = db.query<CapabilityLocalRow, [string]>(
    "SELECT workspace_id, thread_id, through_seq FROM share_capability_local_threads WHERE share_id = ? ORDER BY ordinal",
  ).all(shareId);
  for (const row of localRows) {
    if (row.workspace_id !== workspaceId) return null;
    const record = getLocalThread(workspaceId, row.thread_id);
    if (!record || row.through_seq > record.thread.append_version || !localThreadContained(record, capability, pins)) return null;
    local.push(projectLocalThread(record, null, row.through_seq));
  }

  const threadRows = db.query<CapabilityThreadRow, [string]>(
    "SELECT workspace_id, thread_id, thread_observation_id FROM share_capability_github_threads WHERE share_id = ? ORDER BY ordinal",
  ).all(shareId);
  const commentRows = db.query<CapabilityCommentRow, [string]>(
    "SELECT workspace_id, thread_id, comment_id, comment_observation_id FROM share_capability_github_comments WHERE share_id = ? ORDER BY ordinal",
  ).all(shareId);
  const commentsByThread = new Map<string, Map<string, string>>();
  for (const row of commentRows) {
    if (row.workspace_id !== workspaceId || !threadRows.some((thread) => thread.thread_id === row.thread_id)) return null;
    const comment = db.query<GithubCommentRow, [string, string, string]>(
      "SELECT * FROM review_github_comments WHERE workspace_id = ? AND thread_id = ? AND id = ?",
    ).get(workspaceId, row.thread_id, row.comment_id);
    const observation = db.query<GithubCommentObservationRow, [string, string, string]>(
      "SELECT * FROM review_github_comment_observations WHERE workspace_id = ? AND comment_id = ? AND id = ?",
    ).get(workspaceId, row.comment_id, row.comment_observation_id);
    if (!comment || !observation) return null;
    const map = commentsByThread.get(row.thread_id) ?? new Map<string, string>();
    map.set(row.comment_id, row.comment_observation_id);
    commentsByThread.set(row.thread_id, map);
  }

  const imported: ProjectedGithubThread[] = [];
  for (const row of threadRows) {
    if (row.workspace_id !== workspaceId) return null;
    const thread = db.query<GithubThreadRow, [string, string]>(
      "SELECT * FROM review_github_threads WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, row.thread_id);
    const pin = thread ? pinByLineage.get(thread.lineage_id) : null;
    const exact = thread ? db.query<GithubThreadObservationRow, [string, string, string]>(
      "SELECT * FROM review_github_thread_observations WHERE workspace_id = ? AND thread_id = ? AND id = ?",
    ).get(workspaceId, thread.id, row.thread_observation_id) : null;
    if (!thread || !pin || !exact) return null;
    const placement = await placeImportedThread(workspaceId, pin.lineage, exact, context);
    if (placement.kind !== "code" || placement.revisionId !== pin.revisionId) return null;
    const projected = await projectGithubThread(workspaceId, pin.lineage, thread, context, row.thread_observation_id, commentsByThread.get(row.thread_id), true);
    if (!projected) return null;
    imported.push(projected);
  }

  const reviews: ProjectedGithubReview[] = [];
  for (const row of db.query<CapabilityReviewRow, [string]>(
    "SELECT workspace_id, review_id, review_observation_id FROM share_capability_github_reviews WHERE share_id = ? ORDER BY ordinal",
  ).all(shareId)) {
    if (row.workspace_id !== workspaceId) return null;
    const review = db.query<GithubReviewRow, [string, string]>(
      "SELECT * FROM review_github_reviews WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, row.review_id);
    const pin = review ? pinByLineage.get(review.lineage_id) : null;
    const observation = review ? db.query<GithubReviewObservationRow, [string, string, string]>(
      "SELECT * FROM review_github_review_observations WHERE workspace_id = ? AND review_id = ? AND id = ?",
    ).get(workspaceId, review.id, row.review_observation_id) : null;
    if (!review || !pin || !observation || observation.commit_sha !== pin.headSha) return null;
    const projected = projectReview(workspaceId, review, row.review_observation_id);
    if (!projected) return null;
    reviews.push(projected);
  }
  return { local, imported, reviews };
}

export interface CapabilityImportedSnapshotPlan {
  fingerprint: string;
  threads: { threadId: string; observationId: string; comments: { commentId: string; observationId: string }[] }[];
  reviews: { reviewId: string; observationId: string }[];
}

function capabilityConversationSource(workspaceId: string, pins: ExactConversationPin[]) {
  return pins.map((pin) => {
    const threads = db.query<GithubThreadRow, [string, string]>(
      "SELECT * FROM review_github_threads WHERE workspace_id = ? AND lineage_id = ? ORDER BY first_observed_at, rowid",
    ).all(workspaceId, pin.lineage.id).map((thread) => ({
      thread,
      observation: selectedThreadObservation(workspaceId, thread.id),
      comments: db.query<GithubCommentRow, [string, string]>(
        "SELECT * FROM review_github_comments WHERE workspace_id = ? AND thread_id = ? ORDER BY github_created_at, rowid",
      ).all(workspaceId, thread.id).map((comment) => ({ comment, observation: latestCommentObservation(workspaceId, comment.id) })),
    }));
    const reviews = db.query<GithubReviewRow, [string, string]>(
      "SELECT * FROM review_github_reviews WHERE workspace_id = ? AND lineage_id = ? ORDER BY first_observed_at, rowid",
    ).all(workspaceId, pin.lineage.id).map((review) => ({ review, observation: latestReviewObservation(workspaceId, review.id) }));
    return { pin, threads, reviews };
  });
}

function capabilitySourceFingerprint(source: ReturnType<typeof capabilityConversationSource>): string {
  return digestOf(source.map((lineage) => ({
    lineageId: lineage.pin.lineage.id,
    revisionId: lineage.pin.revisionId,
    threads: lineage.threads.map((row) => ({ id: row.thread.id, observationId: row.observation?.id ?? null, comments: row.comments.map((comment) => ({ id: comment.comment.id, observationId: comment.observation?.id ?? null })) })),
    reviews: lineage.reviews.map((row) => ({ id: row.review.id, observationId: row.observation?.id ?? null })),
  })));
}

export function capabilityConversationFingerprint(workspaceId: string, pins: ExactConversationPin[]): string {
  return capabilitySourceFingerprint(capabilityConversationSource(workspaceId, pins));
}

export async function buildCapabilityImportedSnapshot(
  workspaceId: string,
  pins: ExactConversationPin[],
): Promise<CapabilityImportedSnapshotPlan> {
  const source = capabilityConversationSource(workspaceId, pins);
  const context = createConversationReadContext(workspaceId);
  const threads: CapabilityImportedSnapshotPlan["threads"] = [];
  const reviews: CapabilityImportedSnapshotPlan["reviews"] = [];
  for (const lineage of source) {
    for (const row of lineage.threads) {
      if (!row.observation) continue;
      const placement = await placeImportedThread(workspaceId, lineage.pin.lineage, row.observation, context);
      if (placement.kind !== "code" || placement.revisionId !== lineage.pin.revisionId) continue;
      threads.push({
        threadId: row.thread.id,
        observationId: row.observation.id,
        comments: row.comments.flatMap((comment) => comment.observation ? [{ commentId: comment.comment.id, observationId: comment.observation.id }] : []),
      });
    }
    for (const row of lineage.reviews) {
      if (row.observation?.commit_sha === lineage.pin.headSha) reviews.push({ reviewId: row.review.id, observationId: row.observation.id });
    }
  }
  return { fingerprint: capabilitySourceFingerprint(source), threads, reviews };
}
