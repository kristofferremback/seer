// How a chain of pull requests becomes one ordered member list, and what the provider
// later says about that membership.
//
// Two paths, one answer. The INFERRED path reads retained rows only: each member's newest
// retained observation gives its base and head, and the chain is proved by those refs. The
// NATIVE path asks GitHub which stack a seed pull request is in and takes GitHub's order —
// but every fact it pins still comes from Seer's own observation of each member, never from
// the stack listing, so the two paths normalize to identical member snapshots and differ
// only in provenance. The reader says which reading it is.

import { db } from "../db";
import { tinyId } from "../ids";
import type { GithubReadSession } from "./github-app";
import { GithubError, type GithubPullStack } from "./github";
import {
  getLineagePr,
  getLiveLineagePrByNumber,
  latestObservation,
  observationForRevision,
  type ReviewLineagePrRow,
  type ReviewPrObservationRow,
} from "./revision-pr";
import {
  getAccountById,
  getRevision,
  getRevisionById,
  latestAccountForRevision,
  type ReviewAccountRow,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import {
  getStackById,
  listLiveStackMembers,
  StackWriteError,
  type NormalizedStack,
  type ReviewStackRow,
  type StackManifestRow,
} from "./stack-db";
import { MAX_STACK_MEMBERS, MIN_STACK_MEMBERS, type StackMemberSnapshot, type StackRemovedReason } from "./stack-types";

// ---- one member's chain facts ----

export interface MemberChainFacts {
  lineage: ReviewLineageRow;
  relation: ReviewLineagePrRow;
  observation: ReviewPrObservationRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
}

export type StackRefusalRule =
  | "cross-repository" | "fork" | "no-lineage" | "no-pull-request" | "no-revision" | "duplicate"
  | "fan" | "cycle" | "broken-chain" | "ambiguous-native" | "too-many-members" | "too-few-members"
  | "unresolved-native-member" | "no-native-stack" | "no-account" | "already-stacked";

/** Every refusal names the member and the rule, so an agent can fix the chain rather than
 *  guess at it. */
export function refusal(rule: StackRefusalRule, member: string, detail: string): StackWriteError {
  return new StackWriteError(422, `"${member}": ${detail} [${rule}]`);
}

export function getLineageById(workspaceId: string, lineageId: string): ReviewLineageRow | null {
  return db.query<ReviewLineageRow, [string, string]>(
    "SELECT * FROM review_lineages WHERE workspace_id = ? AND id = ?",
  ).get(workspaceId, lineageId);
}

/** What one member contributes to the chain, from retained rows: its live relation, its
 *  newest observation, its newest completed revision, and that revision's account. */
export function memberChainFacts(workspaceId: string, lineage: ReviewLineageRow): MemberChainFacts {
  const relation = getLineagePr(workspaceId, lineage.id);
  if (!relation) throw refusal("no-pull-request", lineage.slug, "reviews no pull request");
  const observation = latestObservation(workspaceId, lineage.id);
  if (!observation) throw refusal("no-pull-request", lineage.slug, "has no observation of its pull request");
  if (lineage.latest_revision === null) throw refusal("no-revision", lineage.slug, "has no completed source revision yet");
  const revision = getRevision(workspaceId, lineage.slug, lineage.latest_revision);
  if (!revision) throw refusal("no-revision", lineage.slug, "has no completed source revision yet");
  return { lineage, relation, observation, revision, account: latestAccountForRevision(workspaceId, revision.id) };
}

function snapshotOf(facts: MemberChainFacts, status: "live" | "merged"): StackMemberSnapshot {
  return {
    lineageId: facts.lineage.id,
    lineageSlug: facts.lineage.slug,
    prNumber: facts.relation.pr_number,
    title: facts.lineage.title,
    revisionId: facts.revision.id,
    revision: facts.revision.revision,
    accountId: facts.account?.id ?? null,
    accountVersion: facts.account?.version ?? null,
    baseRef: facts.observation.base_ref,
    headRef: facts.observation.head_ref,
    headSha: facts.observation.head_sha,
    status,
    removedReason: null,
  };
}

/**
 * The chain rule. Member N's base must be member N‑1's head, except that a merged member
 * satisfies its successor with the stack base — GitHub retargets survivors to trunk after a
 * merge. Position 1 sits on the stack base. Anything else is named for what it is: a base
 * pointing at an earlier head is a fork, at a later head a cycle, at the stack base beside
 * an unmerged predecessor a fan, and at nothing in the chain a break.
 */
export function checkChain(members: StackMemberSnapshot[], baseRef: string): void {
  const heads = new Map<string, number>();
  members.forEach((member, index) => {
    if (member.headRef === baseRef) throw refusal("cycle", member.lineageSlug, `its head ${member.headRef} is the stack base`);
    const held = heads.get(member.headRef);
    if (held !== undefined) throw refusal("duplicate", member.lineageSlug, `shares head ${member.headRef} with "${members[held]!.lineageSlug}"`);
    heads.set(member.headRef, index);
  });
  members.forEach((member, index) => {
    if (index === 0) {
      if (member.baseRef !== baseRef) throw refusal("broken-chain", member.lineageSlug, `is based on ${member.baseRef}, not the stack base ${baseRef}`);
      return;
    }
    const below = members[index - 1]!;
    if (member.baseRef === below.headRef) return;
    if (below.status === "merged" && member.baseRef === baseRef) return;
    const target = heads.get(member.baseRef);
    if (target !== undefined && target < index - 1) {
      throw refusal("fork", member.lineageSlug, `is based on ${member.baseRef}, the head of "${members[target]!.lineageSlug}" rather than of "${below.lineageSlug}" directly below it`);
    }
    if (target !== undefined && target >= index) {
      throw refusal("cycle", member.lineageSlug, `is based on ${member.baseRef}, the head of "${members[target]!.lineageSlug}" above it`);
    }
    if (member.baseRef === baseRef) {
      throw refusal("fan", member.lineageSlug, `is based on the stack base ${baseRef} while "${below.lineageSlug}" below it is not merged`);
    }
    throw refusal("broken-chain", member.lineageSlug, `is based on ${member.baseRef}, which is no member's head`);
  });
}

function sameRepo(first: MemberChainFacts, facts: MemberChainFacts): void {
  if (facts.relation.repo_id !== first.relation.repo_id) {
    throw refusal("cross-repository", facts.lineage.slug, `reviews ${facts.relation.repo}, not ${first.relation.repo}`);
  }
}

/** Why a member that was live on the predecessor is no longer in the chain. */
function departureReason(workspaceId: string, previous: StackMemberSnapshot, wasInResponse: boolean): { snapshot: StackMemberSnapshot } {
  const lineage = getLineageById(workspaceId, previous.lineageId);
  const relation = lineage ? getLineagePr(workspaceId, lineage.id) : null;
  const observation = lineage ? latestObservation(workspaceId, lineage.id) : null;
  let reason: StackRemovedReason = "unstacked";
  if (!relation) reason = "detached";
  else if (observation?.merged) reason = "merged";
  else if (observation?.state === "closed") reason = "closed";
  else if (wasInResponse) reason = "unstacked";
  const base: StackMemberSnapshot = lineage && relation && observation && lineage.latest_revision !== null
    ? (() => {
        try { return snapshotOf(memberChainFacts(workspaceId, lineage), "live"); } catch { return previous; }
      })()
    : previous;
  return { snapshot: { ...base, status: "removed", removedReason: reason } };
}

/** Replace predecessor slots in place, then insert genuinely new provider members in
 * provider order. Existing removed slots are never collected and appended elsewhere. */
function orderedSuccessorMembers(
  workspaceId: string,
  refreshed: StackMemberSnapshot[],
  predecessor: StackManifestRow | null,
): StackMemberSnapshot[] {
  if (!predecessor) return refreshed;
  const refreshedById = new Map(refreshed.map((member) => [member.lineageId, member]));
  const predecessorIds = new Set(predecessor.doc.members.map((member) => member.lineageId));
  const ordered = predecessor.doc.members.map((previous) =>
    refreshedById.get(previous.lineageId)
      ?? (previous.status === "removed" ? previous : departureReason(workspaceId, previous, false).snapshot));

  refreshed.forEach((member, index) => {
    if (predecessorIds.has(member.lineageId)) return;
    const next = refreshed.slice(index + 1).find((candidate) => predecessorIds.has(candidate.lineageId));
    if (!next) {
      ordered.push(member);
      return;
    }
    const insertion = ordered.findIndex((candidate) => candidate.lineageId === next.lineageId);
    ordered.splice(insertion < 0 ? ordered.length : insertion, 0, member);
  });
  return ordered;
}

/** A departure may leave survivors retargeted into a valid active chain, or leave their
 * branch refs connected through the historical slot. Accept either retained-row proof. */
function checkSuccessorChain(active: StackMemberSnapshot[], ordered: StackMemberSnapshot[], baseRef: string): void {
  try {
    checkChain(active, baseRef);
  } catch (activeError) {
    try {
      checkChain(ordered, baseRef);
    } catch {
      throw activeError;
    }
  }
}

// ---- inferred ----

/**
 * A caller-ordered chain of lineage slugs, proved from retained rows. Never calls GitHub.
 * `predecessor` is the current manifest on a refresh, so a member whose pull request has
 * since been detached becomes a removed stub instead of a refusal of the whole stack.
 */
export function normalizeInferredChain(workspaceId: string, lineageSlugs: string[], predecessor: StackManifestRow | null = null): NormalizedStack {
  if (lineageSlugs.length < MIN_STACK_MEMBERS) throw refusal("too-few-members", lineageSlugs[0] ?? "", `a stack needs at least ${MIN_STACK_MEMBERS} members`);
  if (lineageSlugs.length > MAX_STACK_MEMBERS) throw refusal("too-many-members", lineageSlugs[MAX_STACK_MEMBERS]!, `a stack holds at most ${MAX_STACK_MEMBERS} members`);
  const seen = new Set<string>();
  const members: StackMemberSnapshot[] = [];
  let first: MemberChainFacts | null = null;
  for (const slug of lineageSlugs) {
    if (seen.has(slug)) throw refusal("duplicate", slug, "is named twice");
    seen.add(slug);
    const lineage = db.query<ReviewLineageRow, [string, string]>("SELECT * FROM review_lineages WHERE workspace_id = ? AND slug = ?").get(workspaceId, slug);
    if (!lineage) throw refusal("no-lineage", slug, "is not a promoted review in this workspace");
    let facts: MemberChainFacts;
    try {
      facts = memberChainFacts(workspaceId, lineage);
    } catch (err) {
      const previous = predecessor?.doc.members.find((member) => member.lineageId === lineage.id && member.status !== "removed");
      if (previous && err instanceof StackWriteError) continue;
      throw err;
    }
    if (first === null) first = facts;
    else sameRepo(first, facts);
    members.push(snapshotOf(facts, facts.observation.merged ? "merged" : "live"));
  }
  // A refresh may find members have left; the stack that remains is still the stack,
  // down to one live member. Only a creation needs two.
  if (!first || members.length < (predecessor ? 1 : MIN_STACK_MEMBERS)) {
    throw refusal("too-few-members", lineageSlugs[0] ?? "", `a stack needs at least ${MIN_STACK_MEMBERS} live members`);
  }
  const baseRef = predecessor?.doc.repository.baseRef ?? members[0]!.baseRef;
  const ordered = orderedSuccessorMembers(workspaceId, members, predecessor);
  checkSuccessorChain(members, ordered, baseRef);
  return {
    repo: first.relation.repo,
    repoId: first.relation.repo_id,
    baseRef,
    source: "inferred",
    provider: { stackId: null, stackNumber: null, observedAt: null },
    members: ordered,
  };
}

// ---- an exact persisted chain ----

export interface PinnedStackMember {
  lineageSlug: string;
  revisionId: string;
  accountId: string;
}

/**
 * Normalize exact revisions and accounts already persisted by a resumable workflow.
 *
 * The ordinary inferred path intentionally follows each lineage's latest revision. A
 * legacy succession cannot do that: it records one exact revision per member, waits for
 * that revision's account, then must pin those same ids even if another push lands before
 * the final witness. This function shares the same chain and repository checks while
 * reading each member through its revision's own immutable observation.
 */
export function normalizeInferredPinnedChain(
  workspaceId: string,
  pins: PinnedStackMember[],
): NormalizedStack {
  if (pins.length < MIN_STACK_MEMBERS) {
    throw refusal("too-few-members", pins[0]?.lineageSlug ?? "", `a stack needs at least ${MIN_STACK_MEMBERS} members`);
  }
  if (pins.length > MAX_STACK_MEMBERS) {
    throw refusal("too-many-members", pins[MAX_STACK_MEMBERS]!.lineageSlug, `a stack holds at most ${MAX_STACK_MEMBERS} members`);
  }
  const seen = new Set<string>();
  const snapshots: StackMemberSnapshot[] = [];
  let first: { relation: ReviewLineagePrRow; lineage: ReviewLineageRow } | null = null;
  for (const pin of pins) {
    if (seen.has(pin.lineageSlug)) throw refusal("duplicate", pin.lineageSlug, "is named twice");
    seen.add(pin.lineageSlug);
    const lineage = db.query<ReviewLineageRow, [string, string]>(
      "SELECT * FROM review_lineages WHERE workspace_id = ? AND slug = ?",
    ).get(workspaceId, pin.lineageSlug);
    if (!lineage) throw refusal("no-lineage", pin.lineageSlug, "is not a promoted review in this workspace");
    const relation = getLineagePr(workspaceId, lineage.id);
    if (!relation) throw refusal("no-pull-request", pin.lineageSlug, "reviews no pull request");
    const revision = getRevisionById(workspaceId, pin.revisionId);
    if (!revision || revision.lineage_id !== lineage.id) {
      throw refusal("no-revision", pin.lineageSlug, `does not own exact revision ${pin.revisionId}`);
    }
    const observation = observationForRevision(workspaceId, revision.id);
    if (!observation || observation.lineage_id !== lineage.id) {
      throw refusal("no-revision", pin.lineageSlug, `has no pull request observation for exact revision ${revision.revision}`);
    }
    const account = getAccountById(workspaceId, pin.accountId);
    if (!account || account.revision_id !== revision.id || account.lineage_id !== lineage.id) {
      throw refusal("no-account", pin.lineageSlug, `does not own exact account ${pin.accountId} on revision ${revision.revision}`);
    }
    if (first === null) first = { relation, lineage };
    else if (relation.repo_id !== first.relation.repo_id) {
      throw refusal("cross-repository", pin.lineageSlug, `reviews ${relation.repo}, not ${first.relation.repo}`);
    }
    snapshots.push({
      lineageId: lineage.id,
      lineageSlug: lineage.slug,
      prNumber: relation.pr_number,
      title: lineage.title,
      revisionId: revision.id,
      revision: revision.revision,
      accountId: account.id,
      accountVersion: account.version,
      baseRef: observation.base_ref,
      headRef: observation.head_ref,
      headSha: observation.head_sha,
      status: observation.merged ? "merged" : "live",
      removedReason: null,
    });
  }
  if (!first) throw refusal("too-few-members", "", `a stack needs at least ${MIN_STACK_MEMBERS} members`);
  const baseRef = snapshots[0]!.baseRef;
  checkChain(snapshots, baseRef);
  return {
    repo: first.relation.repo,
    repoId: first.relation.repo_id,
    baseRef,
    source: "inferred",
    provider: { stackId: null, stackNumber: null, observedAt: null },
    members: snapshots,
  };
}

// ---- native ----

/**
 * GitHub's own stack for a seed pull request, resolved member by member against this
 * workspace's live lineages. Order is GitHub's; every fact is Seer's.
 *
 * Both provider behaviours after a merge are handled: a merged pull request still listed is
 * a `merged` member, and one GitHub dropped is a removed stub whose reason Seer's newest
 * observation decides — `merged` when it says so, else `unstacked`.
 */
export async function normalizeNativeStack(
  workspaceId: string,
  seed: ReviewLineageRow,
  session: GithubReadSession,
  predecessor: StackManifestRow | null = null,
): Promise<NormalizedStack> {
  const seedFacts = memberChainFacts(workspaceId, seed);
  if (!session.client.getPullStack) throw new StackWriteError(502, "The routed GitHub client cannot read stacks.");
  let listed: GithubPullStack | null;
  try {
    listed = await session.client.getPullStack(seedFacts.relation.repo, seedFacts.relation.pr_number);
  } catch (err) {
    if (err instanceof GithubError && /two stacks/.test(err.message)) throw refusal("ambiguous-native", seed.slug, "GitHub returned two stacks for one pull request");
    throw err;
  }
  if (!listed) throw refusal("no-native-stack", seed.slug, `GitHub reports no stack for ${seedFacts.relation.repo}#${seedFacts.relation.pr_number}`);
  if (listed.pullRequests.length > MAX_STACK_MEMBERS) {
    throw refusal("too-many-members", seed.slug, `GitHub lists ${listed.pullRequests.length} pull requests; a stack holds at most ${MAX_STACK_MEMBERS}`);
  }
  if (!listed.pullRequests.some((entry) => entry.number === seedFacts.relation.pr_number)) {
    throw new StackWriteError(502, `GitHub answered a stack that does not contain ${seedFacts.relation.repo}#${seedFacts.relation.pr_number}.`);
  }
  const members: StackMemberSnapshot[] = [];
  for (const entry of listed.pullRequests) {
    const relation = getLiveLineagePrByNumber(workspaceId, seedFacts.relation.repo_id, entry.number);
    const lineage = relation ? getLineageById(workspaceId, relation.lineage_id) : null;
    if (!relation || !lineage) {
      throw refusal("unresolved-native-member", `${seedFacts.relation.repo}#${entry.number}`, "is in the native stack but no promoted review in this workspace reviews it");
    }
    const facts = memberChainFacts(workspaceId, lineage);
    sameRepo(seedFacts, facts);
    members.push(snapshotOf(facts, entry.mergedAt !== null || facts.observation.merged ? "merged" : "live"));
  }
  if (members.length < (predecessor ? 1 : MIN_STACK_MEMBERS)) throw refusal("too-few-members", seed.slug, `GitHub lists ${members.length} pull request; a stack needs at least ${MIN_STACK_MEMBERS}`);
  const ordered = orderedSuccessorMembers(workspaceId, members, predecessor);
  checkSuccessorChain(members, ordered, listed.baseRef);
  return {
    repo: seedFacts.relation.repo,
    repoId: seedFacts.relation.repo_id,
    baseRef: listed.baseRef,
    source: "native",
    provider: { stackId: listed.id, stackNumber: listed.number, observedAt: new Date().toISOString() },
    members: ordered,
  };
}

/** The member a native refresh asks GitHub about: a live one first, because GitHub answers
 *  no stack for a merged pull request it has already dropped from the listing. */
export function seedMemberOf(workspaceId: string, current: StackManifestRow): ReviewLineageRow | null {
  const snapshot = current.doc.members.find((member) => member.status === "live") ?? current.doc.members.find((member) => member.status === "merged");
  return snapshot ? getLineageById(workspaceId, snapshot.lineageId) : null;
}

/** The slugs a refresh re-normalizes: the stack's live members, in the current manifest's
 *  order, so an inferred stack is re-proved in the order it was declared. */
export function liveMemberSlugsInOrder(stack: ReviewStackRow, current: StackManifestRow): string[] {
  const live = new Set(listLiveStackMembers(stack.id).map((row) => row.lineage_slug));
  return current.doc.members.filter((member) => member.status !== "removed" && live.has(member.lineageSlug)).map((member) => member.lineageSlug);
}

// ---- provider membership observations ----

export interface ProviderStackFacts {
  stackId: number;
  stackNumber: number;
  position: number | null;
  size: number | null;
  baseRef: string | null;
  baseSha: string | null;
}

export interface StackPrObservationRow {
  id: string;
  workspace_id: string;
  receipt_id: string;
  pull_request_observation_id: string | null;
  repo_id: number;
  pr_number: number;
  provider_stack_id: number | null;
  provider_stack_number: number | null;
  position: number | null;
  size: number | null;
  stack_base_ref: string | null;
  stack_base_sha: string | null;
  observed_at: number;
}

/**
 * What the provider said about a pull request's stack membership. The accepted receipt is
 * this reading's identity. Its promoted pull request observation is only a nullable link,
 * because a deleted head repository can leave enough webhook facts to accept the delivery
 * and observe membership without enough facts to create a capturable source observation.
 * `stack: null` stores the provider's absent-stack signal.
 */
export function recordStackObservation(input: {
  workspaceId: string;
  receiptId: string;
  pullRequestObservationId: string | null;
  repoId: number;
  prNumber: number;
  stack: ProviderStackFacts | null;
  now?: number;
}): StackPrObservationRow {
  const id = tinyId("rso");
  db.run(
    "INSERT INTO review_stack_pr_observations (id, workspace_id, receipt_id, pull_request_observation_id, repo_id, pr_number, provider_stack_id, provider_stack_number, position, size, stack_base_ref, stack_base_sha, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.receiptId, input.pullRequestObservationId, input.repoId, input.prNumber,
      input.stack?.stackId ?? null, input.stack?.stackNumber ?? null, input.stack?.position ?? null, input.stack?.size ?? null,
      input.stack?.baseRef ?? null, input.stack?.baseSha ?? null, input.now ?? Date.now()],
  );
  return db.query<StackPrObservationRow, [string]>("SELECT * FROM review_stack_pr_observations WHERE id = ?").get(id)!;
}

export function latestStackObservation(workspaceId: string, repoId: number, prNumber: number): StackPrObservationRow | null {
  return db.query<StackPrObservationRow, [string, number, number]>(
    "SELECT * FROM review_stack_pr_observations WHERE workspace_id = ? AND repo_id = ? AND pr_number = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1",
  ).get(workspaceId, repoId, prNumber);
}

// ---- what has moved under a manifest ----

export interface StackDrift {
  /** The newest manifest, when this one is not it. */
  latestManifestVersion: number | null;
  /** A member with a newer completed revision than the one this manifest pins. */
  newerRevisions: { position: number; lineageSlug: string; revision: number }[];
  /** A member whose pinned revision gained an account after this manifest was published. */
  newerAccounts: { position: number; lineageSlug: string; accountVersion: number }[];
  /** A live member whose newest provider observation disagrees with the stored stack. */
  membershipChanged: { position: number; lineageSlug: string }[];
  /** Members this manifest already carries as removed. */
  removed: { position: number; lineageSlug: string; reason: StackRemovedReason }[];
  /** True when a later manifest is owed and nobody has asked for it. */
  refreshRequired: boolean;
}

/** Rows only; never GitHub. Read against the stack row as it is NOW, so a pinned manifest
 *  says what has happened since it. */
export function stackDrift(workspaceId: string, stack: ReviewStackRow, manifest: StackManifestRow): StackDrift {
  const current = getStackById(stack.id) ?? stack;
  const drift: StackDrift = {
    latestManifestVersion: current.latest_manifest_version > manifest.version ? current.latest_manifest_version : null,
    newerRevisions: [],
    newerAccounts: [],
    membershipChanged: [],
    removed: [],
    refreshRequired: false,
  };
  const activeMembers = manifest.doc.members.filter((member) => member.status !== "removed");
  const activePositions = new Map(activeMembers.map((member, index) => [member.lineageId, index + 1]));
  const baseMember = activeMembers.find((member) => member.baseRef === manifest.doc.repository.baseRef);
  const baseRevision = baseMember ? getRevision(workspaceId, baseMember.lineageSlug, baseMember.revision) : null;
  const baseSha = baseRevision && baseMember && baseRevision.id === baseMember.revisionId
    ? baseRevision.doc.source.baseTipSha
    : null;
  manifest.doc.members.forEach((member, index) => {
    const position = index + 1;
    if (member.status === "removed") {
      drift.removed.push({ position, lineageSlug: member.lineageSlug, reason: member.removedReason! });
      return;
    }
    const lineage = getLineageById(workspaceId, member.lineageId);
    if (lineage && lineage.latest_revision !== null && lineage.latest_revision > member.revision) {
      drift.newerRevisions.push({ position, lineageSlug: member.lineageSlug, revision: lineage.latest_revision });
    }
    if (member.accountId === null) {
      const account = latestAccountForRevision(workspaceId, member.revisionId);
      if (account) drift.newerAccounts.push({ position, lineageSlug: member.lineageSlug, accountVersion: account.version });
    }
    if (current.source === "native") {
      const observed = latestStackObservation(workspaceId, current.repo_id, member.prNumber);
      const membershipMoved = observed !== null && (
        observed.provider_stack_id !== current.provider_stack_id ||
        observed.provider_stack_number !== current.provider_stack_number ||
        (observed.position !== null && observed.position !== activePositions.get(member.lineageId)) ||
        (observed.size !== null && observed.size !== activeMembers.length) ||
        (observed.stack_base_ref !== null && observed.stack_base_ref !== manifest.doc.repository.baseRef) ||
        (observed.stack_base_sha !== null && baseSha !== null && observed.stack_base_sha !== baseSha)
      );
      if (membershipMoved) drift.membershipChanged.push({ position, lineageSlug: member.lineageSlug });
    }
  });
  drift.refreshRequired = drift.latestManifestVersion === null &&
    (drift.newerRevisions.length > 0 || drift.newerAccounts.length > 0 || drift.membershipChanged.length > 0);
  return drift;
}
