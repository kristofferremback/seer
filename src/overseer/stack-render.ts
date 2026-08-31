// Reading a stack: the whole and every layer, through the one reader.
//
// A stack page is a composite of its members' retained captures. Each member's inventory is
// loaded from rows and its ids are namespaced by position — `chg_…` becomes `l2-chg_…`,
// `stf_…` becomes `l2-stf_…` — because canonical ids are content-derived and two layers can
// hold identical hunks. The prefix is what keeps them distinct all the way into the DOM, the
// read forms and the URLs. Nothing here calls GitHub: rendering, progress, paging and drift
// read retained rows and retained objects only.

import { sessionEmail, sessionUser } from "../auth";
import { getWorkspace, isMember, listUserWorkspaces } from "../db";
import { escapeHtml } from "../escape";
import { json, originOk } from "../http";
import { SLUG_RE, STACK_CHANGE_ID_RE } from "../ids";
import { softNotFoundPage, type NavContext } from "../pages";
import {
  getStageCaptureForWorkspaces,
  type StageCaptureChangeRow,
  type StageCaptureFileRow,
  type StageCaptureInventory,
  type StageIncompleteRow,
} from "../stage/db";
import { loadStageBytes } from "../stage/read";
import {
  filesInTreeOrder,
  renderReaderPage,
  type ReaderDoc,
  type ReaderEvidence,
  type ReaderGroup,
  type ReaderHandling,
  type ReaderJudgmentBlocker,
  type ReaderMember,
  type ReaderPageState,
  type ReaderRoutes,
  type ReaderScope,
  type ReaderSeam,
} from "../stage/render";
import { stageTree } from "../stage/render-model";
import { materializeCanonicalChanges, type MaterializedStageChange } from "../stage/source";
import { softNotFound as softReviewPage } from "./render";
import { evidenceSeams } from "./revision-read";
import {
  getLineage,
  getRevision,
  getWitnessRequestForRevision,
  listRevisionReadChangeIds,
  nextRevision,
  setRevisionChangeRead,
  workflowWord,
  type ReviewAccountRow,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import { revisionMovement } from "./revision-pr";
import {
  currentStackManifest,
  getStack,
  getStackAccountForManifest,
  getStackManifest,
  getStackWitnessRequestForManifest,
  listStackAccountTimes,
  listStackManifestTimes,
  pinnedAccountsOf,
  stackWorkflowWord,
  type ReviewStackRow,
  type StackAccountRow,
  type StackManifestRow,
} from "./stack-db";
import { getLineageById, stackDrift } from "./stack-pr";
import { stackPages, type StackPageUnit, type StackUnit } from "./stack-read";
import { MAX_STACK_MEMBER_POSITIONS, STACK_PAGE_HTML_MAX_BYTES, type StackMemberSnapshot } from "./stack-types";
import type { StackCapability } from "./capability-types";
import { latestImportedConversation } from "./conversation-import";
import { createConversationReadContext, readCapabilityConversation, readPinnedLineageConversation } from "./conversation-read";
import { listLocalThreadsForStackAccount, projectLocalThread, workspaceMemberLabels } from "./thread-db";
import { projectAgent } from "./actor-projection";
import {
  getMyStackJudgment,
  listStackJudgments,
  stackAcknowledgementState,
} from "./judgments-db";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;
const POSITION_RE = /^[1-9][0-9]?$/;
const validPosition = (value: string): boolean => POSITION_RE.test(value) && Number(value) <= MAX_STACK_MEMBER_POSITIONS;

function esc(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

// ---- namespacing ----

export function prefixId(position: number, id: string): string {
  return `l${position}-${id}`;
}

/** `l<pos>-<bare>` → its parts, or null for anything else. */
export function splitStackId(id: string): { position: number; bare: string } | null {
  const match = /^l([1-9][0-9]?)-(.+)$/.exec(id);
  return match && validPosition(match[1]!) ? { position: Number(match[1]), bare: match[2]! } : null;
}

// ---- resolution ----

interface CompositeMember {
  position: number;
  snapshot: StackMemberSnapshot;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  inventory: StageCaptureInventory;
  account: ReviewAccountRow | null;
}

export interface ResolvedStackRead {
  workspaceId: string;
  stack: ReviewStackRow;
  manifest: StackManifestRow;
  account: StackAccountRow | null;
  /** Pinned members with a readable retained revision, bottom-to-top. Removed stubs are
   *  listed on the overview and read nothing here. */
  members: CompositeMember[];
}

/** What `/<ws>/r-stacks/<slug>[/v/<n>[/account]]` resolves to, or null for the soft miss. */
export function resolveStackRead(workspaceId: string, slug: string, pin: { version: string; account: boolean } | null): ResolvedStackRead | null {
  if (!SLUG_RE.test(slug)) return null;
  const stack = getStack(workspaceId, slug);
  if (!stack) return null;
  let manifest: StackManifestRow | null;
  if (pin) {
    if (!NUMBER_RE.test(pin.version)) return null;
    manifest = getStackManifest(workspaceId, slug, Number(pin.version));
  } else {
    manifest = currentStackManifest(stack);
  }
  if (!manifest) return null;
  const account = getStackAccountForManifest(workspaceId, manifest.id);
  if (pin?.account && !account) return null;
  const members: CompositeMember[] = [];
  const pinnedAccounts = pinnedAccountsOf(workspaceId, manifest);
  manifest.doc.members.forEach((snapshot, index) => {
    if (snapshot.status === "removed") return;
    const lineage = getLineageById(workspaceId, snapshot.lineageId);
    const revision = lineage ? getRevision(workspaceId, lineage.slug, snapshot.revision) : null;
    const inventory = revision && revision.id === snapshot.revisionId ? getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]) : null;
    if (!lineage || !revision || !inventory) return;
    members.push({ position: index + 1, snapshot, lineage, revision, inventory, account: pinnedAccounts.get(snapshot.lineageId) ?? null });
  });
  if (members.length === 0) return null;
  return { workspaceId, stack, manifest, account: pin && !pin.account ? null : account, members };
}

// ---- the composite ----

interface Composite {
  inventory: StageCaptureInventory;
  seamOf: (id: string) => ReaderSeam | null;
  materialize: (only?: ReadonlySet<string>) => Promise<MaterializedStageChange[]>;
  readIds: Set<string>;
}

function memberUrl(workspaceId: string, member: CompositeMember): string {
  return `/${workspaceId}/r/${member.lineage.slug}/rev/${member.revision.revision}`;
}

function composite(
  resolved: ResolvedStackRead,
  members: CompositeMember[],
  userId: string | null,
  memberHref: (member: CompositeMember) => string,
): Composite {
  const { workspaceId } = resolved;
  const files: StageCaptureFileRow[] = [];
  const changes: StageCaptureChangeRow[] = [];
  const incomplete: StageIncompleteRow[] = [];
  const readIds = new Set<string>();
  const byPosition = new Map<number, CompositeMember>();
  for (const member of members) {
    byPosition.set(member.position, member);
    for (const file of member.inventory.files) files.push({ ...file, id: prefixId(member.position, file.id) });
    for (const change of member.inventory.changes) changes.push({ ...change, id: prefixId(member.position, change.id), file_id: prefixId(member.position, change.file_id) });
    for (const item of member.inventory.incomplete) incomplete.push({ ...item, id: prefixId(member.position, item.id) });
    if (userId !== null) {
      for (const id of listRevisionReadChangeIds(workspaceId, member.revision.id, userId)) readIds.add(prefixId(member.position, id));
    }
  }
  const seams = new Map<number, ReaderSeam>(members.map((member) => [member.position, {
    id: `l${member.position}`,
    position: member.position,
    label: `PR #${member.snapshot.prNumber}`,
    detail: member.snapshot.title,
    href: memberHref(member),
  }]));
  return {
    inventory: { capture: members[0]!.inventory.capture, builder: null, files, changes, incomplete },
    seamOf: (id) => {
      const parts = splitStackId(id);
      return parts ? seams.get(parts.position) ?? null : null;
    },
    materialize: async (only) => {
      const out: MaterializedStageChange[] = [];
      for (const member of members) {
        const wanted = only ? new Set([...only].map(splitStackId).filter((parts): parts is { position: number; bare: string } => parts !== null && parts.position === member.position).map((parts) => parts.bare)) : undefined;
        if (wanted && wanted.size === 0) continue;
        const made = await materializeCanonicalChanges(member.inventory, (digest) => loadStageBytes(workspaceId, digest), wanted);
        for (const item of made) out.push({ change: { ...item.change, id: prefixId(member.position, item.change.id), file_id: prefixId(member.position, item.change.file_id) }, hunk: item.hunk });
      }
      return out;
    },
    readIds,
  };
}

// ---- groups ----

function remapMember(position: number, member: ReaderMember): ReaderMember {
  return { ...member, id: prefixId(position, member.id) };
}

/** A member's account group, namespaced: what one stack group reference resolves to. */
function memberGroupMembers(member: CompositeMember, groupId: string, streamRank?: number): ReaderMember[] {
  const group = member.account?.doc.groups.find((candidate) => candidate.id === groupId);
  return group ? group.members.map((entry) => remapMember(member.position, {
    type: entry.type,
    id: entry.id,
    description: entry.description,
    ...(streamRank === undefined ? {} : { streamRank }),
  })) : [];
}

/** The change order inside one member group, as the reader will draw it: file tree order,
 *  then canonical order. Computed from rows so a page plan never needs a blob. */
function orderedChangeIds(member: CompositeMember, members: ReaderMember[]): { ids: string[]; lines: number[] } {
  const wanted = new Set(members.filter((entry) => entry.type === "change").map((entry) => entry.id));
  const changes = member.inventory.changes.filter((change) => wanted.has(prefixId(member.position, change.id)));
  const files = member.inventory.files.filter((file) => changes.some((change) => change.file_id === file.id));
  const fileOrder = new Map(filesInTreeOrder(stageTree(files)).map((file, index) => [file.id, index]));
  const canonical = new Map(member.inventory.changes.map((change, index) => [change.id, index]));
  changes.sort((left, right) => (fileOrder.get(left.file_id) ?? 0) - (fileOrder.get(right.file_id) ?? 0) || (canonical.get(left.id) ?? 0) - (canonical.get(right.id) ?? 0));
  return { ids: changes.map((change) => prefixId(member.position, change.id)), lines: changes.map((change) => change.old_lines + change.new_lines) };
}

interface StackReaderGroup {
  group: ReaderGroup;
  units: (StackUnit & { members: ReaderMember[] })[];
}

function readerGroups(resolved: ResolvedStackRead, members: CompositeMember[]): StackReaderGroup[] {
  const byLineage = new Map(members.map((member) => [member.snapshot.lineageId, member]));
  if (resolved.account) {
    return resolved.account.doc.groups.map((group) => {
      const units = group.members.flatMap((ref, streamRank) => {
        const member = byLineage.get(ref.lineageId);
        if (!member) return [];
        const readerMembers = memberGroupMembers(member, ref.groupId, streamRank);
        const ordered = orderedChangeIds(member, readerMembers);
        return [{ key: prefixId(member.position, ref.groupId), position: member.position, memberGroupId: ref.groupId, changeIds: ordered.ids, hunkLines: ordered.lines.reduce((sum, value) => sum + value, 0), members: readerMembers }];
      });
      return {
        group: {
          id: group.id,
          title: group.title,
          category: null,
          importance: null,
          complexity: null,
          explanation: group.body,
          ...(group.attention === undefined ? {} : { attention: group.attention }),
          examples: group.examples,
          members: units.flatMap((unit) => unit.members),
        },
        units,
      };
    });
  }
  // Evidence only: every member's own file seams, bottom-to-top, each its own group.
  return members.flatMap((member) => evidenceSeams(member.inventory).map((seam) => {
    const readerMembers = seam.members.map((entry) => remapMember(member.position, entry));
    const ordered = orderedChangeIds(member, readerMembers);
    return {
      group: { ...seam, id: prefixId(member.position, seam.id), title: `PR #${member.snapshot.prNumber} · ${seam.title}`, members: readerMembers },
      units: [{ key: prefixId(member.position, seam.id), position: member.position, memberGroupId: seam.id, changeIds: ordered.ids, hunkLines: ordered.lines.reduce((sum, value) => sum + value, 0), members: readerMembers }],
    };
  }));
}

/** Every member of each indivisible page unit, narrowed only by layer scope. */
function pageMembers(page: StackPageUnit[], groups: StackReaderGroup, filter: (id: string) => boolean): ReaderMember[] {
  const out: ReaderMember[] = [];
  for (const entry of page) {
    const unit = groups.units.find((candidate) => candidate.key === entry.unit.key);
    if (!unit) continue;
    const wanted = new Set(entry.changeIds);
    for (const member of unit.members) {
      if (!filter(member.id)) continue;
      if (member.type === "change" ? wanted.has(member.id) : true) out.push(member);
    }
  }
  return out;
}

// ---- routes and history ----

function stackPath(workspaceId: string, slug: string, version: number): string {
  return `/${workspaceId}/r-stacks/${slug}/v/${version}`;
}

function focusUrl(pinned: string, groupId: string, layer: string | null, page: number | null, changeId?: string): string {
  const params = new URLSearchParams({ review: groupId });
  if (layer) params.set("layer", layer);
  if (page !== null && page > 1) params.set("page", String(page));
  if (changeId) params.set("change", changeId);
  return `${pinned}?${params.toString()}#${changeId ?? `review-${groupId}`}`;
}

function routesFor(resolved: ResolvedStackRead, pinned: string, layer: string | null): ReaderRoutes {
  const { workspaceId, stack, manifest } = resolved;
  const manifests = listStackManifestTimes(workspaceId, stack.slug);
  const accounts = new Set(listStackAccountTimes(workspaceId, stack.slug).map((row) => row.version));
  const current = resolved.account ? { kind: "account" as const, version: manifest.version } : { kind: "manifest" as const, version: manifest.version };
  return {
    group: (groupId, changeId) => focusUrl(pinned, groupId, layer, null, changeId),
    close: () => pinned,
    read: (changeId) => {
      const parts = splitStackId(changeId);
      return `${stackPath(workspaceId, stack.slug, manifest.version)}/m/${parts?.position ?? 0}/changes/${changeId}/read`;
    },
    returnTo: (groupId, changeId) => focusUrl(pinned, groupId, layer, null, changeId),
    lines: (fileId, side, start, end) => {
      const parts = splitStackId(fileId);
      return `/api/review-stacks/${stack.slug}/manifests/${manifest.version}/members/${parts?.position ?? 0}/files/${parts?.bare ?? fileId}?side=${side}&start=${start}&end=${end}`;
    },
    history: () => manifests.flatMap((row) => {
      const base = stackPath(workspaceId, stack.slug, row.version);
      const entries = [{ label: `v${row.version}`, href: base, current: current.kind === "manifest" && current.version === row.version }];
      if (accounts.has(row.version)) entries.push({ label: `v${row.version} account`, href: `${base}/account`, current: current.kind === "account" && current.version === row.version });
      return entries;
    }),
  };
}

// ---- the overview aside: member cards and drift ----

const REMOVED_WORDS = { unstacked: "removed (unstacked)", merged: "removed (merged)", closed: "removed (closed)", detached: "removed (detached)" } as const;

function memberCards(resolved: ResolvedStackRead, members: CompositeMember[], readIds: Set<string>): string {
  const { workspaceId, manifest } = resolved;
  const cards = manifest.doc.members.map((snapshot, index) => {
    const position = index + 1;
    const member = members.find((candidate) => candidate.position === position);
    const href = `/${workspaceId}/r/${snapshot.lineageSlug}/rev/${snapshot.revision}`;
    if (!member) {
      const word = snapshot.status === "removed" ? REMOVED_WORDS[snapshot.removedReason!] : "unreadable";
      return `<a class="stack-member" data-status="${esc(snapshot.status)}" href="${esc(href)}"><span>${position}</span><span><strong>#${snapshot.prNumber} ${esc(snapshot.title)}</strong><small>rev ${snapshot.revision} · ${esc(word)}</small></span></a>`;
    }
    const total = member.inventory.changes.length;
    const read = member.inventory.changes.filter((change) => readIds.has(prefixId(position, change.id))).length;
    const witness = workflowWord(getWitnessRequestForRevision(workspaceId, member.revision.id));
    const facts = [
      `rev ${snapshot.revision}`,
      snapshot.accountVersion === null ? (witness === null || witness === "published" ? "no account" : `witness ${witness}`) : `v${snapshot.accountVersion}`,
      `${member.inventory.files.length} file${member.inventory.files.length === 1 ? "" : "s"}`,
      `${total} change${total === 1 ? "" : "s"}`,
      ...(member.inventory.incomplete.length > 0 ? [`${member.inventory.incomplete.length} missing`] : []),
      `${read}/${total} read`,
    ];
    const progress = total === 0 ? 100 : Math.round(read / total * 100);
    return `<a class="stack-member" data-status="${esc(snapshot.status)}" href="${esc(href)}"><span>${position}</span><span><strong>#${snapshot.prNumber} ${esc(snapshot.title)}</strong><small>${esc(facts.join(" · "))}</small></span><span class="meter" aria-hidden="true"><i style="width:${progress}%"></i></span></a>`;
  });
  return `<section class="stack-members" aria-label="Members">${cards.join("")}</section>`;
}

function driftLines(resolved: ResolvedStackRead): string {
  const { workspaceId, stack, manifest } = resolved;
  const drift = stackDrift(workspaceId, stack, manifest);
  const lines: string[] = [];
  if (drift.latestManifestVersion !== null) {
    lines.push(`<p class="stage-drift"><a href="${esc(stackPath(workspaceId, stack.slug, drift.latestManifestVersion))}">Manifest ${drift.latestManifestVersion} available</a></p>`);
  }
  for (const entry of drift.newerRevisions) {
    lines.push(`<p class="stage-drift"><a href="${esc(`/${workspaceId}/r/${entry.lineageSlug}/rev/${entry.revision}`)}">#${manifest.doc.members[entry.position - 1]!.prNumber} revision ${entry.revision} available</a></p>`);
  }
  for (const entry of drift.newerAccounts) {
    lines.push(`<p class="stage-drift" data-drift="account">${esc(`#${manifest.doc.members[entry.position - 1]!.prNumber} account v${entry.accountVersion} published`)}</p>`);
  }
  for (const entry of drift.membershipChanged) {
    lines.push(`<p class="stage-drift" data-drift="membership">${esc(`#${manifest.doc.members[entry.position - 1]!.prNumber} stack membership changed on GitHub`)}</p>`);
  }
  if (drift.refreshRequired) lines.push(`<p class="stage-drift" data-drift="refresh">New source · refresh required</p>`);
  return lines.length === 0 ? "" : `<div class="stack-lines">${lines.join("")}</div>`;
}

// ---- the document ----

function readerDoc(resolved: ResolvedStackRead, groups: ReaderGroup[]): ReaderDoc {
  const { stack, manifest, account, members } = resolved;
  const bottom = members[0]!;
  const top = members[members.length - 1]!;
  const request = getStackWitnessRequestForManifest(resolved.workspaceId, manifest.id);
  const word = account ? null : stackWorkflowWord(request);
  const missing = manifest.doc.members.filter((member) => member.status !== "removed" && member.accountId === null).map((member) => `#${member.prNumber}`);
  const workflow = account
    ? null
    : word !== null && word !== "published"
      ? { word, detail: request?.failure ?? null }
      : missing.length > 0
        ? { word: "pending" as const, detail: `awaiting member accounts ${missing.join(", ")}` }
        : null;
  return {
    title: stack.title,
    source: {
      repo: stack.repo,
      branch: `${manifest.doc.repository.baseRef} → ${top.snapshot.headRef}`,
      sourceHeadSha: top.snapshot.headSha,
      mergeBaseSha: bottom.revision.doc.source.mergeBaseSha,
    },
    pullRequest: null,
    builder: null,
    witness: account ? { agent: account.doc.witness.agent, body: account.doc.witness.summary } : null,
    groups,
    focus: [],
    evidence: [],
    authored: account !== null,
    workflow,
    drift: null,
    movement: null,
    standing: account ? `Manifest ${manifest.version} · account` : `Manifest ${manifest.version}`,
    pin: account ? `v${manifest.version} account` : `v${manifest.version}`,
    latest: manifest.version === (getStack(resolved.workspaceId, stack.slug)?.latest_manifest_version ?? manifest.version),
  };
}

// ---- pages ----

function navFor(req: Request, workspaceId: string): NavContext | null {
  const user = sessionUser(req);
  const workspace = getWorkspace(workspaceId);
  if (!user || !workspace || !isMember(workspaceId, user.id)) return null;
  return {
    email: user.email,
    workspaces: listUserWorkspaces(user.id).map((item) => ({ id: item.id, name: item.name })),
    current: { id: workspace.id, name: workspace.name },
    section: "reviews",
  };
}

interface FallbackItem {
  full: string;
  compact: string;
}

function fallbackHref(url: URL, page: number): string {
  const params = new URLSearchParams();
  for (const key of ["review", "layer", "page", "change"]) {
    const value = url.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }
  if (page > 1) params.set("fallback-page", String(page));
  const query = params.toString();
  return `${url.pathname}${query === "" ? "" : `?${query}`}`;
}

function fallbackBody(resolved: ResolvedStackRead, url: URL, items: string[], page: number, count: number, totalItems: number, sourceBytes: number, pinnedOverride?: string): string {
  const controls = `<nav aria-label="Fallback pages">${page > 1 ? `<a rel="prev" href="${esc(fallbackHref(url, page - 1))}">Previous</a> · ` : ""}<span>Page ${page} of ${count}</span>${page < count ? ` · <a rel="next" href="${esc(fallbackHref(url, page + 1))}">Next</a>` : ""}</nav>`;
  const pinned = pinnedOverride ?? `${stackPath(resolved.workspaceId, resolved.stack.slug, resolved.manifest.version)}${resolved.account ? "/account" : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(resolved.stack.title)} · Seer</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:auto;padding:1rem}a{color:inherit}nav{margin:1rem 0}li{overflow-wrap:anywhere;margin:.35rem 0}</style></head><body><main><a href="${esc(pinned)}">${esc(resolved.stack.title)}</a><h1>Page too large</h1><p>${Math.round(sourceBytes / 1024)} KiB exceeds the ${Math.round(STACK_PAGE_HTML_MAX_BYTES / 1024 / 1024)} MiB response limit. All ${totalItems} items remain available through their member pages.</p>${controls}<ol>${items.join("")}</ol>${controls}</main></body></html>`;
}

/** The hard-limit answer retains each page unit so every item links through the exact
 * member account group or evidence seam that owns it. The emergency list is paged by its
 * encoded HTML bytes too. A path too large to fit by itself gets an explicit id label;
 * its item and destination are retained. */
function overLimitPage(
  resolved: ResolvedStackRead,
  url: URL,
  entries: StackPageUnit[],
  group: StackReaderGroup,
  filter: (id: string) => boolean,
  composite: Composite,
  sourceBytes: number,
  capabilityBase?: string,
): Response {
  const files = new Map(composite.inventory.files.map((file) => [file.id, file]));
  const changes = new Map(composite.inventory.changes.map((change) => [change.id, change]));
  const materials = new Map(composite.inventory.incomplete.map((material) => [material.id, material]));
  const items: FallbackItem[] = [];
  for (const entry of entries) {
    const unit = group.units.find((candidate) => candidate.key === entry.unit.key);
    if (!unit) continue;
    const wanted = new Set(entry.changeIds);
    for (const member of unit.members) {
      if (!filter(member.id) || (member.type === "change" && !wanted.has(member.id))) continue;
      const parts = splitStackId(member.id);
      const owner = resolved.members.find((candidate) => candidate.position === parts?.position);
      if (!owner || !parts) continue;
      const pinned = resolved.account && owner.snapshot.accountVersion !== null
        ? `/${resolved.workspaceId}/r/${owner.lineage.slug}/v/${owner.snapshot.accountVersion}`
        : memberUrl(resolved.workspaceId, owner);
      const params = new URLSearchParams({ review: capabilityBase ? group.group.id : entry.unit.memberGroupId });
      if (member.type === "change") params.set("change", capabilityBase ? member.id : parts.bare);
      if (capabilityBase && member.type !== "change" && url.searchParams.get("page")) params.set("page", url.searchParams.get("page")!);
      const anchor = member.type === "change" ? (capabilityBase ? member.id : parts.bare) : `focus-${capabilityBase ? member.id : parts.bare}`;
      const href = `${capabilityBase ?? pinned}?${params.toString()}#${encodeURIComponent(anchor)}`;
      const change = member.type === "change" ? changes.get(member.id) : null;
      const file = change ? files.get(change.file_id) : member.type === "file" ? files.get(member.id) : null;
      const material = member.type === "material" ? materials.get(member.id) : null;
      const line = change ? (change.new_lines > 0 ? change.new_start : change.old_start) : null;
      const label = change ? `${file?.path ?? member.id}:L${line}`
        : file ? file.path
        : material ? material.path ?? material.kind.replaceAll("_", " ")
        : member.id;
      const open = `<li data-item="${esc(member.id)}" data-kind="${member.type}"><a href="${esc(href)}">`;
      const tail = `</a>${change ? ` · ${change.old_lines + change.new_lines} lines` : ""}</li>`;
      items.push({
        full: `${open}${esc(label)}${tail}`,
        compact: `${open}${esc(`${member.type} ${member.id}`)}</a> · label omitted because it alone exceeds the response limit</li>`,
      });
    }
  }

  // Use a 15-digit page/count while packing. Every realizable array has fewer pages, so
  // the actual navigation can only be shorter than the body measured here.
  const sentinel = 999_999_999_999_999;
  const shellBytes = Buffer.byteLength(fallbackBody(resolved, url, [], sentinel, sentinel, items.length, sourceBytes, capabilityBase));
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = shellBytes;
  for (const item of items) {
    let html = item.full;
    let itemBytes = Buffer.byteLength(html);
    if (shellBytes + itemBytes > STACK_PAGE_HTML_MAX_BYTES) {
      html = item.compact;
      itemBytes = Buffer.byteLength(html);
    }
    if (chunk.length > 0 && chunkBytes + itemBytes > STACK_PAGE_HTML_MAX_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = shellBytes;
    }
    chunk.push(html);
    chunkBytes += itemBytes;
  }
  chunks.push(chunk);
  const rawPage = url.searchParams.get("fallback-page");
  if (rawPage !== null && !NUMBER_RE.test(rawPage)) return softMiss(new Request(url.toString()), url);
  const page = rawPage === null ? 1 : Number(rawPage);
  if (page > chunks.length) return softMiss(new Request(url.toString()), url);
  const body = fallbackBody(resolved, url, chunks[page - 1]!, page, chunks.length, items.length, sourceBytes, capabilityBase);
  const fallbackBytes = Buffer.byteLength(body);
  if (fallbackBytes > STACK_PAGE_HTML_MAX_BYTES) throw new Error(`Fallback page exceeded its hard limit: ${fallbackBytes}`);
  return new Response(body, { status: 200, headers: {
    "content-type": "text/html;charset=utf-8",
    "cache-control": "no-store",
    "x-seer-page-fallback": "over-limit",
    "x-seer-page-bytes": String(sourceBytes),
    "x-seer-fallback-bytes": String(fallbackBytes),
    "x-seer-fallback-page": String(page),
    "x-seer-fallback-pages": String(chunks.length),
  } });
}

function softHtml(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * `/<ws>/r-stacks/<slug>`, `/v/<n>` and `/v/<n>/account`. Membership only, and every refusal
 * is the review soft miss. Query: `review` a stack group (or evidence seam), `layer` a
 * member slug, `page` a bounded page, `change` a namespaced change anchor.
 */
export async function handleStackPage(req: Request, workspaceId: string, slug: string, pin: { version: string; account: boolean } | null, judgmentError: string | null = null): Promise<Response> {
  const nav = navFor(req, workspaceId);
  const user = sessionUser(req);
  if (!nav || !user) return softReviewPage();
  const resolved = resolveStackRead(workspaceId, slug, pin);
  if (!resolved) return softReviewPage();
  const url = new URL(req.url);
  const memberLabels = workspaceMemberLabels(workspaceId);
  const conversationContext = createConversationReadContext(workspaceId);
  const layer = url.searchParams.get("layer");
  const layerMember = layer === null ? null : resolved.members.find((member) => member.lineage.slug === layer) ?? null;
  if (layer !== null && !layerMember) return softReviewPage();
  const memberHref = (member: CompositeMember) => memberUrl(workspaceId, member);
  const whole = composite(resolved, resolved.members, user.id, memberHref);
  const built = layerMember ? composite(resolved, [layerMember], user.id, memberHref) : whole;
  const filter = (id: string): boolean => layerMember === null || splitStackId(id)?.position === layerMember.position;
  // Under a layer, a stack group keeps its identity with fewer members; an evidence seam
  // of another member is nobody's group here and is dropped rather than drawn empty.
  const groups = readerGroups(resolved, resolved.members)
    .map((entry) => ({ ...entry, group: { ...entry.group, members: entry.group.members.filter((member) => filter(member.id)) }, units: entry.units.filter((unit) => filter(unit.key)) }))
    .filter((entry) => resolved.account !== null || entry.group.members.length > 0);
  const doc = readerDoc(resolved, groups.map((entry) => entry.group));
  const pinned = resolved.account ? `${stackPath(workspaceId, slug, resolved.manifest.version)}/account` : stackPath(workspaceId, slug, resolved.manifest.version);
  if (layerMember) {
    const importedState = latestImportedConversation(workspaceId, layerMember.lineage.id);
    const pinnedConversation = await readPinnedLineageConversation(workspaceId, {
      lineage: layerMember.lineage,
      revisionId: layerMember.revision.id,
      accountId: layerMember.account?.id ?? null,
      headSha: layerMember.revision.doc.source.sourceHeadSha,
    }, user.id, conversationContext, memberLabels);
    doc.conversation = {
      local: pinnedConversation.local,
      imported: pinnedConversation.imported,
      reviews: pinnedConversation.reviews,
      importState: importedState?.state ?? "never", complete: importedState?.complete === 1, truncated: importedState?.truncated === 1,
      exactRevisionId: layerMember.revision.id, exactAccountId: null,
      createAction: `/${workspaceId}/r/${layerMember.lineage.slug}/rev/${layerMember.revision.revision}/threads`,
      replyAction: (threadId) => `/${workspaceId}/review-threads/${threadId}/replies`,
      resolutionAction: (threadId) => `/${workspaceId}/review-threads/${threadId}/resolution`,
      refreshAction: null, returnTo: url.pathname + url.search,
      overviewAnchor: { anchorKind: "review" },
      changeIdOf: (id) => splitStackId(id)?.bare ?? id,
      fileIdOf: (id) => splitStackId(id)?.bare ?? id,
    };
  } else if (resolved.account) {
    doc.conversation = {
      local: listLocalThreadsForStackAccount(workspaceId, resolved.account.id).map((thread) => projectLocalThread(thread, user.id, thread.thread.append_version, memberLabels)),
      imported: [], reviews: [], importState: "never", complete: true, truncated: false,
      exactRevisionId: "", exactAccountId: null,
      createAction: `${pinned}/threads`,
      replyAction: (threadId) => `/${workspaceId}/review-threads/${threadId}/replies`,
      resolutionAction: (threadId) => `/${workspaceId}/review-threads/${threadId}/resolution`,
      refreshAction: null, returnTo: url.pathname + url.search,
      overviewAnchor: { anchorKind: "stack", stackAccountId: resolved.account.id },
    };
  }
  const routes = routesFor(resolved, pinned, layer);
  const scope: ReaderScope = {
    current: layer,
    subtitle: layerMember ? `Layer ${layerMember.position}/${resolved.members.length} · PR #${layerMember.snapshot.prNumber}` : `Whole stack · ${resolved.members.length} layers`,
    options: resolved.members.map((member) => ({ value: member.lineage.slug, label: `PR #${member.snapshot.prNumber} · ${member.snapshot.title}` })),
    action: pinned,
    hidden: url.searchParams.has("review") ? { review: url.searchParams.get("review")! } : {},
  };

  let page: ReaderPageState | undefined;
  let pageEntries: StackPageUnit[] = [];
  let pageGroup: StackReaderGroup | null = null;
  const reviewId = url.searchParams.get("review");
  const rawPage = url.searchParams.get("page");
  if (reviewId !== null) {
    const selected = groups.find((entry) => entry.group.id === reviewId);
    if (!selected) return softMiss(req, url);
    if (rawPage !== null && !NUMBER_RE.test(rawPage)) return softMiss(req, url);
    const plan = stackPages(selected.units);
    const change = url.searchParams.get("change");
    let number = rawPage === null ? 1 : Number(rawPage);
    if (rawPage === null && change !== null) {
      const index = plan.pages.findIndex((entries) => entries.some((entry) => entry.changeIds.includes(change)));
      if (index >= 0) number = index + 1;
    }
    if (number > plan.pages.length) return softMiss(req, url);
    const entries = plan.pages[number - 1]!;
    pageEntries = entries;
    pageGroup = selected;
    page = {
      number,
      count: plan.pages.length,
      overBudget: plan.overBudget.has(number),
      part: entries.length === 1 ? entries[0]!.part : null,
      members: pageMembers(entries, selected, filter),
      href: (target) => focusUrl(pinned, reviewId, layer, target),
    };
  }

  const acknowledgementState = stackAcknowledgementState(workspaceId, resolved.manifest, user.id, resolved.members);
  const acknowledgements: ReaderHandling["acknowledgements"] = new Map();
  for (const member of acknowledgementState.members) {
    for (const view of member.state.acknowledgements.values()) {
      acknowledgements.set(prefixId(member.position, view.itemId), { ...view, itemId: prefixId(member.position, view.itemId) });
    }
  }
  const blockedItems = new Set(acknowledgementState.blockers.map((blocker) => `${blocker.revisionId}:${blocker.itemId}`));
  const judgmentItems: ReaderJudgmentBlocker[] = acknowledgementState.members.flatMap((member) =>
    member.state.requiredItems.map((item) => {
      const id = prefixId(member.position, item.id);
      const group = groups.find((candidate) => candidate.group.members.some((entry) => entry.id === id));
      const material = member.inventory.incomplete.find((candidate) => candidate.id === item.id);
      const label = item.path ?? material?.kind.replaceAll("_", " ") ?? item.type;
      const blocked = blockedItems.has(`${member.revision.id}:${item.id}`);
      if (group) {
        return { itemId: id, itemType: item.type as "material" | "file", label, href: `${routes.group(group.group.id).split("#", 1)[0]}#focus-${id}`, blocked };
      }
      const seam = evidenceSeams(member.inventory).find((candidate) => candidate.members.some((entry) => entry.id === item.id));
      const memberPath = `/${workspaceId}/r/${member.revision.slug}/rev/${member.revision.revision}`;
      const href = seam ? `${memberPath}?${new URLSearchParams({ review: seam.id })}#focus-${item.id}` : memberPath;
      return { itemId: id, itemType: item.type as "material" | "file", label, href, blocked };
    }),
  );
  const mine = getMyStackJudgment(workspaceId, resolved.manifest.id, user.id);
  const judgments = listStackJudgments(workspaceId, resolved.manifest.id, { viewerId: user.id, memberLabels });
  const allChanges = acknowledgementState.members.reduce((sum, member) => sum + member.inventory.changes.length, 0);
  const allReads = acknowledgementState.members.reduce((sum, member) => {
    const read = listRevisionReadChangeIds(workspaceId, member.revision.id, user.id);
    return sum + member.inventory.changes.filter((change) => read.has(change.id)).length;
  }, 0);
  const openThreadIds = new Set<string>();
  for (const thread of doc.conversation?.local ?? []) if (thread.state === "open") openThreadIds.add(`local:${thread.id}`);
  for (const thread of doc.conversation?.imported ?? []) if (!thread.resolved && !thread.deleted) openThreadIds.add(`github:${thread.id}`);
  if (!layerMember) {
    for (const member of acknowledgementState.members) {
      const lineage = getLineage(workspaceId, member.revision.slug);
      const snapshot = resolved.manifest.doc.members[member.position - 1];
      if (!lineage || !snapshot) continue;
      const pinnedConversation = await readPinnedLineageConversation(workspaceId, {
        lineage,
        revisionId: member.revision.id,
        accountId: snapshot.accountId,
        headSha: member.revision.doc.source.sourceHeadSha,
      }, user.id, conversationContext, memberLabels);
      for (const thread of pinnedConversation.local) if (thread.state === "open") openThreadIds.add(`local:${thread.id}`);
      for (const thread of pinnedConversation.imported) if (!thread.resolved && !thread.deleted) openThreadIds.add(`github:${thread.id}`);
    }
  }
  const handling: ReaderHandling = {
    readIds: built.readIds,
    requiredAcknowledgementIds: new Set(acknowledgementState.members.flatMap((member) => member.state.requiredItems.map((item) => prefixId(member.position, item.id)))),
    acknowledgements,
    acknowledgementAction: (item) => {
      const parts = splitStackId(item.id);
      return `${stackPath(workspaceId, slug, resolved.manifest.version)}/members/${parts?.position ?? 0}/items/${parts?.bare ?? item.id}/acknowledge`;
    },
    returnTo: url.pathname + url.search,
    judgment: {
      mine,
      others: judgments.filter((judgment) => judgment.id !== mine?.id),
      items: judgmentItems,
      action: mine ? null : `${stackPath(workspaceId, slug, resolved.manifest.version)}/judgment`,
      error: judgmentError,
      facts: { unread: allChanges - allReads, openThreads: openThreadIds.size },
    },
  };
  const aside = `${driftLines(resolved)}${memberCards(resolved, resolved.members, whole.readIds)}`;
  const response = await renderReaderPage(req, {
    kind: "member",
    nav,
    handling,
    share: { workspace: workspaceId, kind: "stack_document", target: resolved.account?.id ?? resolved.manifest.id },
  }, workspaceId, doc, routes, built.inventory, `stack ${pinned}`, {
    seamOf: built.seamOf,
    materialize: built.materialize,
    scope,
    ...(page ? { page } : {}),
    aside,
  });
  if (response.status === 404) return softMiss(req, url);
  if (response.status !== 200 || !page) return response;
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (bytes > STACK_PAGE_HTML_MAX_BYTES && pageGroup) return overLimitPage(resolved, url, pageEntries, pageGroup, filter, built, bytes);
  if (url.searchParams.has("fallback-page")) {
    const back = new URL(url);
    back.searchParams.delete("fallback-page");
    return new Response(null, { status: 303, headers: { location: back.pathname + back.search, "cache-control": "no-store" } });
  }
  const headers = new Headers(response.headers);
  headers.set("x-seer-page-bytes", String(bytes));
  headers.set("x-seer-page-count", String(page.count));
  return new Response(text, { status: 200, headers });
}

/** A stale `?review=`, `?change=` or `?page=` on a resolved stack lands on the page the link
 *  was pinned to rather than on a miss: membership already resolved, so nothing is hidden. */
function softMiss(req: Request, url: URL): Response {
  if (url.searchParams.has("review") || url.searchParams.has("change") || url.searchParams.has("page")) {
    const back = new URL(url);
    for (const key of ["review", "change", "page", "fallback-page"]) back.searchParams.delete(key);
    return new Response(null, { status: 303, headers: { location: back.pathname + (back.search || ""), "cache-control": "no-store" } });
  }
  return softHtml(req);
}

function capabilityStackRoutes(resolved: ResolvedStackRead, basePath: string, layer: string | null): ReaderRoutes {
  return {
    group: (groupId, changeId) => focusUrl(basePath, groupId, layer, null, changeId),
    close: () => basePath,
    lines: (fileId, side, start, end) => {
      const parts = splitStackId(fileId);
      return `${basePath}/m/${parts?.position ?? 0}/files/${parts?.bare ?? fileId}?side=${side}&start=${start}&end=${end}`;
    },
    history: () => [{
      label: resolved.account ? `v${resolved.manifest.version} account` : `v${resolved.manifest.version}`,
      href: basePath,
      current: true,
    }],
    contextLinks: true,
  };
}

function capabilityMemberCards(resolved: ResolvedStackRead, basePath: string): string {
  const cards = resolved.manifest.doc.members.map((snapshot, index) => {
    const position = index + 1;
    const member = resolved.members.find((candidate) => candidate.position === position);
    if (!member) {
      const word = snapshot.status === "removed" ? REMOVED_WORDS[snapshot.removedReason!] : "unavailable";
      return `<div class="stack-member" data-status="${esc(snapshot.status)}"><span>${position}</span><span><strong>#${snapshot.prNumber} ${esc(snapshot.title)}</strong><small>rev ${snapshot.revision} · ${esc(word)}</small></span></div>`;
    }
    const params = new URLSearchParams({ layer: member.lineage.slug });
    const facts = [`rev ${snapshot.revision}`, ...(snapshot.accountVersion === null ? [] : [`v${snapshot.accountVersion}`]), `${member.inventory.files.length} file${member.inventory.files.length === 1 ? "" : "s"}`];
    return `<a class="stack-member" data-status="${esc(snapshot.status)}" href="${esc(`${basePath}?${params}`)}"><span>${position}</span><span><strong>#${snapshot.prNumber} ${esc(snapshot.title)}</strong><small>${esc(facts.join(" · "))}</small></span></a>`;
  });
  return `<section class="stack-members" aria-label="Members">${cards.join("")}</section>`;
}

/** Render one exact stack capability from copied authority. No current stack state or
 * personal handling is consulted, and every generated URL remains under the token. */
export async function renderStackCapability(req: Request, capability: StackCapability, basePath: string): Promise<Response> {
  const members: CompositeMember[] = capability.members.map((member) => ({
    position: member.position,
    snapshot: member.snapshot!,
    lineage: member.lineage,
    revision: member.revision,
    inventory: member.inventory,
    account: member.account,
  }));
  const resolved: ResolvedStackRead = {
    workspaceId: capability.share.workspace_id,
    stack: capability.stack,
    manifest: capability.manifest,
    account: capability.account,
    members,
  };
  const url = new URL(req.url);
  const layer = url.searchParams.get("layer");
  const layerMember = layer === null ? null : members.find((member) => member.lineage.slug === layer) ?? null;
  if (layer !== null && !layerMember) return softHtml(req);
  const memberHref = (member: CompositeMember) => `${basePath}?${new URLSearchParams({ layer: member.lineage.slug })}`;
  const whole = composite(resolved, members, null, memberHref);
  const built = layerMember ? composite(resolved, [layerMember], null, memberHref) : whole;
  const filter = (id: string): boolean => layerMember === null || splitStackId(id)?.position === layerMember.position;
  const groups = readerGroups(resolved, members)
    .map((entry) => ({ ...entry, group: { ...entry.group, members: entry.group.members.filter((member) => filter(member.id)) }, units: entry.units.filter((unit) => filter(unit.key)) }))
    .filter((entry) => resolved.account !== null || entry.group.members.length > 0);
  const witness = capability.account?.doc.witness;
  const projected = witness ? projectAgent(witness.agent.name, witness.agent.model) : null;
  const top = members[members.length - 1]!;
  const bottom = members[0]!;
  const seenEvidence = new Set<string>();
  const evidence: ReaderEvidence[] = [];
  for (const member of members) {
    for (const item of member.account?.doc.evidence ?? []) {
      const key = item.kind === "bundle" ? `bundle:${item.slug}:${item.version}` : `attachment:${item.id}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(item.kind === "bundle"
        ? { label: `${item.slug} v${item.version}`, href: null, detail: "bundle" }
        : { label: item.caption || item.alt, href: `${basePath}/a/${item.id}`, detail: item.mediaType });
    }
  }
  const doc: ReaderDoc = {
    title: capability.manifest.doc.identity.title,
    source: {
      repo: capability.manifest.doc.repository.repo,
      branch: `${capability.manifest.doc.repository.baseRef} → ${top.snapshot.headRef}`,
      sourceHeadSha: top.snapshot.headSha,
      mergeBaseSha: bottom.revision.doc.source.mergeBaseSha,
    },
    pullRequest: null,
    builder: null,
    witness: projected?.kind === "agent" && witness ? { agent: { name: projected.label, model: projected.model }, body: witness.summary } : null,
    groups: groups.map((entry) => entry.group),
    focus: [],
    evidence,
    authored: capability.account !== null,
    workflow: null,
    drift: null,
    movement: null,
    standing: capability.account ? `Manifest ${capability.manifest.version} · account` : `Manifest ${capability.manifest.version}`,
    pin: capability.account ? `v${capability.manifest.version} account` : `v${capability.manifest.version}`,
    latest: false,
  };
  if (capability.scope.conversation_scope === "snapshot") {
    const conversation = await readCapabilityConversation(capability);
    if (!conversation) return softHtml(req);
    doc.conversation = { ...conversation, importState: "never", complete: true, truncated: false, exactRevisionId: layerMember?.revision.id ?? top.revision.id, exactAccountId: layerMember?.account?.id ?? null, createAction: null, replyAction: null, resolutionAction: null, refreshAction: null, returnTo: basePath };
  }
  const routes = capabilityStackRoutes(resolved, basePath, layer);
  const scope: ReaderScope = {
    current: layer,
    subtitle: layerMember ? `Layer ${layerMember.position}/${members.length} · PR #${layerMember.snapshot.prNumber}` : `Whole stack · ${members.length} layers`,
    options: members.map((member) => ({ value: member.lineage.slug, label: `PR #${member.snapshot.prNumber} · ${member.snapshot.title}` })),
    action: basePath,
    hidden: url.searchParams.has("review") ? { review: url.searchParams.get("review")! } : {},
  };

  let page: ReaderPageState | undefined;
  let pageEntries: StackPageUnit[] = [];
  let pageGroup: StackReaderGroup | null = null;
  const reviewId = url.searchParams.get("review");
  const rawPage = url.searchParams.get("page");
  if (reviewId !== null) {
    const selected = groups.find((entry) => entry.group.id === reviewId);
    if (!selected || (rawPage !== null && !NUMBER_RE.test(rawPage))) return softHtml(req);
    const plan = stackPages(selected.units);
    const change = url.searchParams.get("change");
    let number = rawPage === null ? 1 : Number(rawPage);
    if (rawPage === null && change !== null) {
      const index = plan.pages.findIndex((entries) => entries.some((entry) => entry.changeIds.includes(change)));
      if (index >= 0) number = index + 1;
    }
    if (number > plan.pages.length) return softHtml(req);
    const entries = plan.pages[number - 1]!;
    pageEntries = entries;
    pageGroup = selected;
    page = {
      number,
      count: plan.pages.length,
      overBudget: plan.overBudget.has(number),
      part: entries.length === 1 ? entries[0]!.part : null,
      members: pageMembers(entries, selected, filter),
      href: (target) => focusUrl(basePath, reviewId, layer, target),
    };
  } else if (rawPage !== null || url.searchParams.has("change")) {
    return softHtml(req);
  }

  const response = await renderReaderPage(
    req,
    { kind: "capability", nav: null, handling: null, basePath },
    capability.share.workspace_id,
    doc,
    routes,
    built.inventory,
    `stack capability ${capability.share.id}`,
    {
      seamOf: built.seamOf,
      materialize: built.materialize,
      scope,
      ...(page ? { page } : {}),
      aside: capabilityMemberCards(resolved, basePath),
      brandPath: basePath,
    },
  );
  if (response.status !== 200 || !page) return response;
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (bytes > STACK_PAGE_HTML_MAX_BYTES && pageGroup) {
    return overLimitPage(resolved, url, pageEntries, pageGroup, filter, built, bytes, basePath);
  }
  const headers = new Headers(response.headers);
  headers.set("x-seer-page-bytes", String(bytes));
  headers.set("x-seer-page-count", String(page.count));
  return new Response(text, { status: 200, headers });
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function readJson(value: unknown, status = 200): Response {
  const response = json(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * POST `/<ws>/r-stacks/<slug>/v/<n>/m/<position>/changes/<l<pos>-chg_…>/read`: a personal
 * read on the MEMBER revision the manifest pins at that position. No stack row is written;
 * the answer carries the namespaced id so the client's DOM matches, and the bare one so the
 * caller can see what was written.
 */
export async function handleStackReadMutation(req: Request, workspaceId: string, slug: string, rawVersion: string, rawPosition: string, changeId: string): Promise<Response> {
  if (!originOk(req)) return new Response("Bad origin", { status: 403 });
  const user = sessionUser(req);
  if (!user || !isMember(workspaceId, user.id) || !STACK_CHANGE_ID_RE.test(changeId) || !validPosition(rawPosition)) return softHtml(req);
  const parts = splitStackId(changeId);
  if (!parts || parts.position !== Number(rawPosition)) return softHtml(req);
  const resolved = resolveStackRead(workspaceId, slug, { version: rawVersion, account: false });
  const member = resolved?.members.find((candidate) => candidate.position === parts.position);
  if (!resolved || !member || !member.inventory.changes.some((change) => change.id === parts.bare)) return softHtml(req);
  const form = await req.formData().catch(() => null);
  if (form === null) return readJson({ error: "Body must be form data." }, 400);
  const rawRead = form.get("read");
  if (rawRead !== "true" && rawRead !== "false") return readJson({ error: "read must be true or false" }, 422);
  const successor = nextRevision(workspaceId, member.lineage.id, member.revision.revision);
  if (successor) revisionMovement(workspaceId, member.lineage, successor);
  setRevisionChangeRead(workspaceId, member.revision.id, user.id, parts.bare, rawRead === "true");
  if ((req.headers.get("accept") ?? "").includes("application/json")) {
    return readJson({ changeId, memberChangeId: parts.bare, read: rawRead === "true" });
  }
  const raw = form.get("return");
  const prefix = `/${workspaceId}/r-stacks/${slug}/`;
  const back = typeof raw === "string" && raw.startsWith(prefix) && !raw.startsWith(`${prefix}/`)
    && !raw.includes("://") && !raw.includes("..") && !raw.includes("\\")
    && !hasControlCharacter(raw)
    ? raw
    : stackPath(workspaceId, slug, resolved.manifest.version);
  return new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } });
}
