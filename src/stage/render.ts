// The reader: one overview-to-focus walkthrough, drawn from one internal document.
//
// Three surfaces read the same code through it. A StageDoc V1 stage supplies authored
// groups with category and signal marks. A promoted review's source revision supplies no
// authored groups at all — it is evidence, published before any witness has finished, so
// it is paged along neutral file seams and says nothing about importance, category, or
// what the change means. An account published over that revision supplies the witness's
// own semantic partition, summary, and anchored decisions and risks.
//
// What varies between them is a document and a set of URLs; everything below that — the
// materializer, the tree, the diff renderer, the CSS, the client, the mobile panels, the
// no-JavaScript links — is shared, and a route helper is the only thing allowed to know
// what a URL looks like. No helper recomputes a durable id.

import { sessionEmail, sessionUser } from "../auth";
import { getWorkspace, isMember, listUserWorkspaces } from "../db";
import { escapeHtml } from "../escape";
import { SLUG_RE } from "../ids";
import { render as renderMarkdown } from "../overseer/markdown";
import { codeHtml, langOfPath, stats } from "../overseer/render-diff";
import type { Hunk, HunkLine } from "../overseer/types";
import { appBar, softNotFoundPage, type NavContext } from "../pages";
import { agoWords } from "../relative-time";
import {
  getStage,
  getStageCaptureForWorkspaces,
  getStageVersion,
  listStageReadChangeIds,
  type StageCaptureFileRow,
  type StageCaptureInventory,
  type StageIncompleteRow,
} from "./db";
import { loadStageBytes, StageStoreUnavailable } from "./read";
import { STAGE_CLIENT, STAGE_THEME_BOOTSTRAP } from "./render-client";
import { STAGE_CSS } from "./render-css";
import {
  splitDiffRows,
  stageTree,
  stageTreeStats,
  type StageChangeStats,
  type StageTreeNode,
} from "./render-model";
import {
  materializeCanonicalChanges,
  StageMaterializationError,
  type MaterializedStageChange,
} from "./source";
import type { StageCategory, StageExample, StageGroup, StageSignal } from "./types";

const VERSION_RE = /^[1-9][0-9]{0,8}$/;

// ---- the reader document ----

/** A member of a reader group. `description` is nullable because an evidence seam has
 *  none: a sentence about what a change means is exactly the witness prose a revision
 *  published before its witness must not invent. */
export interface ReaderMember {
  type: "change" | "material" | "file";
  id: string;
  description: string | null;
  /** Stack-only stream order. Ordinary stages and single reviews leave this absent. */
  streamRank?: number;
}

/** A page of the walkthrough. An authored group fills in category and both signals; a
 *  file seam leaves all of them null and the reader draws no marks it cannot stand on. */
export interface ReaderGroup {
  id: string;
  title: string;
  category: StageCategory | null;
  importance: StageSignal | null;
  complexity: StageSignal | null;
  explanation: string | null;
  attention?: string;
  examples: StageExample[];
  members: ReaderMember[];
}

export interface ReaderAccount {
  agent: { name: string; model: string };
  body: string;
  /** The builder's second field. Empty renders nothing. */
  context?: string;
}

export interface ReaderFocusItem {
  id: string;
  kind: "decision" | "risk";
  title: string;
  body: string;
  anchors: { type: "change" | "material" | "file"; id: string }[];
}

export interface ReaderEvidence {
  label: string;
  href: string;
  detail: string;
}

/** What a reader says about a witness that has not answered yet. Never stored in a
 *  document: it stops being true the moment the workflow moves. */
export interface ReaderWorkflow {
  word: "pending" | "failed" | "retrying" | "superseded";
  detail: string | null;
}

/**
 * Source newer than the page, in the fewest words it can be said in.
 *
 * Four states, and the difference between them is what the reader can do about it. A newer
 * revision is a link, because it exists and can be opened. A capture in flight is a state,
 * because waiting is the only move. `refresh` is an action this reader may take; `source`
 * is the same fact for somebody who may not, and it deliberately offers nothing — naming an
 * action a member is forbidden to take is worse than saying less.
 *
 * Only a promoted review has one. A stage adapts it as null and renders byte-identically.
 */
export type ReaderDrift =
  | { kind: "revision"; label: string; href: string }
  | { kind: "capture"; state: "pending" | "running" | "failed" }
  | { kind: "refresh" }
  | { kind: "source" };

/** What this revision changed about the one before it. Retained counts, so the line is
 *  the same on a phone, on a desktop and with JavaScript off. The account delta stays an
 *  API fact: "account 1 revised" is not a sentence a reader has. */
export interface ReaderMovement {
  previousRevision: number;
  code: { unchanged: number; revised: number; new: number; removed: number };
}

/**
 * The pull request a promoted review's source came from, as the reader states it.
 *
 * Stored facts only. This is the observation the REVISION was captured from, not the
 * relation's newest one, so a pinned page keeps saying what was true when it was
 * published — a merge that lands afterwards does not rewrite it. Task 6 owns the separate
 * notice that a newer observation exists.
 */
export interface ReaderPullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  /** When Seer read it, in milliseconds. Rendered as an age, because the point is that
   *  this is a reading rather than live state. */
  observedAt: number;
  headSha: string;
}

export interface ReaderDoc {
  title: string;
  source: { repo: string; branch: string; sourceHeadSha: string; mergeBaseSha: string };
  /** Absent for a stage, and for a promoted review no pull request is attached to. */
  pullRequest?: ReaderPullRequest | null;
  builder: ReaderAccount | null;
  witness: ReaderAccount | null;
  groups: ReaderGroup[];
  focus: ReaderFocusItem[];
  evidence: ReaderEvidence[];
  /** True when the groups are a witness's semantics. False for evidence seams, which
   *  suppresses the category summary, the signal scales, and the attention bar. */
  authored: boolean;
  workflow: ReaderWorkflow | null;
  /** Absent for a stage, and null for a promoted review nothing has moved under. */
  drift?: ReaderDrift | null;
  /** Absent for a stage, and null on the first revision of a lineage. */
  movement?: ReaderMovement | null;
  /** "Version 3" or "Revision 1", as the nav head and the terminal say it. */
  standing: string;
  /** The same thing short enough for the focus header: "v3", "rev 1". */
  pin: string;
  latest: boolean;
}

/** Every URL the reader draws. The only thing in this module that knows what a promoted
 *  review's paths look like, or a stage's. */
export interface ReaderRoutes {
  /** One group's page, optionally focused on one change. */
  group(groupId: string, changeId?: string): string;
  /** Where the focus dialog closes back to. */
  close(): string;
  /** POST target for one change's read mark. */
  read(changeId: string): string;
  /** The page a no-JavaScript read mark should land back on, or null to let the
   *  handler work it out. The stage path works it out; the promoted path says it,
   *  because its evidence pages are derived rather than stored. */
  returnTo(groupId: string, changeId: string): string | null;
  /** A bounded retained-line window. */
  lines(fileId: string, side: "old" | "new", start: number, end: number): string;
  /** What the source rail lists. */
  history(): { label: string; href: string; current: boolean }[];
}

/** A member boundary inside a stack's focus stream: which layer the material below belongs
 *  to. Absent for stage and member documents, which have one layer and no seam. */
export interface ReaderSeam {
  id: string;
  position: number;
  label: string;
  detail: string;
  href: string;
}

/** One bounded page of a stack focus stream, decided from retained rows before rendering. */
export interface ReaderPageState {
  number: number;
  count: number;
  overBudget: boolean;
  part: { number: number; count: number } | null;
  /** The selected group's members on this page and nothing else. */
  members: ReaderMember[];
  href: (page: number) => string;
}

/** The layer scope a stack focus offers: whole stack or one member. */
export interface ReaderScope {
  current: string | null;
  subtitle: string | null;
  options: { value: string; label: string }[];
  action: string;
  hidden: Record<string, string>;
}

export interface RenderReaderOptions {
  seamOf?: (id: string) => ReaderSeam | null;
  page?: ReaderPageState;
  scope?: ReaderScope;
  /** The durable-storage seam for a composite of several captures. */
  materialize?: (only?: ReadonlySet<string>) => Promise<MaterializedStageChange[]>;
  /** Extra overview HTML between the header and the walkthrough. */
  aside?: string;
}

type ChangeMember = ReaderMember & { type: "change" };
type MaterialMember = ReaderMember & { type: "material" };
type FileMember = ReaderMember & { type: "file" };

interface ChangeView {
  member: ChangeMember;
  item: MaterializedStageChange;
  file: StageCaptureFileRow;
  diff: StageChangeStats;
  ordinal: number;
}

/** What the focus dialog's group rail needs of every OTHER group: its place, its change
 *  ids and how many are read. Nothing that needs its bytes materialized. */
interface GroupSummary {
  group: ReaderGroup;
  index: number;
  changeIds: string[];
  read: number;
}

interface GroupView {
  group: ReaderGroup;
  index: number;
  changes: ChangeView[];
  files: StageCaptureFileRow[];
  /** What the trees draw: one row per path. In a stack, files of several layers sharing a
   *  path collapse onto the first, and `layersOf` says how many. */
  treeFiles: StageCaptureFileRow[];
  layersOf: Map<string, number>;
  fileChanges: Map<string, string[]>;
  changeStats: Map<string, StageChangeStats>;
  materials: { member: MaterialMember; material: StageIncompleteRow }[];
  leafFiles: { member: FileMember; file: StageCaptureFileRow }[];
  added: number;
  removed: number;
  read: number;
}

function esc(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function markdown(value: string): string {
  return renderMarkdown(value);
}

function exactExcerpt(value: string, limit = 220): { text: string; shortened: boolean } {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return { text, shortened: false };
  const sentence = text.slice(0, limit + 1).match(/^(.+?[.!?])(?:\s|$)/)?.[1];
  const cut = sentence && sentence.length >= 80 ? sentence : text.slice(0, limit).replace(/\s+\S*$/, "");
  return { text: `${cut}…`, shortened: true };
}

function accountCopy(value: string, className: string, limit = 220): string {
  const excerpt = exactExcerpt(value, limit);
  if (!excerpt.shortened) return `<div class="${className}">${markdown(value)}</div>`;
  return `<div class="${className}"><p>${esc(excerpt.text)}</p><details><summary>Full account</summary><div class="markdown">${markdown(value)}</div></details></div>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });
}

function softNotFound(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function accountHeading(role: "Builder" | "Witness", name: string, model: string): string {
  const identity = name.trim().toLowerCase() === role.toLowerCase() ? model : `${name} · ${model}`;
  return `<h2>${role}<span> · ${esc(identity)}</span></h2>`;
}

/** The account in full. The summary is the one sentence its author wrote for the reader,
 *  so nothing cuts it; only the builder's context, which is background, is disclosed. */
function accountCard(role: "Builder" | "Witness", account: ReaderAccount): string {
  const context = (account.context ?? "").trim();
  return `<section class="account">${accountHeading(role, account.agent.name, account.agent.model)}<div class="account-body markdown">${markdown(account.body)}</div>${context ? `<details class="account-context"><summary>Context</summary><div class="markdown">${markdown(context)}</div></details>` : ""}</section>`;
}

function lineHtml(line: HunkLine, side: "unified" | "old" | "new", path: string): string {
  const language = langOfPath(path);
  const oldNumber = line.kind === "add" ? "" : String(line.oldNo ?? "");
  const newNumber = line.kind === "del" ? "" : String(line.newNo ?? "");
  const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const old = side === "new" ? "" : oldNumber;
  const newer = side === "old" ? "" : newNumber;
  return `<div class="diff-line ${line.kind}"><span class="line-old">${old}</span><span class="line-new">${newer}</span><span class="line-mark">${mark}</span><span class="line-code">${codeHtml(line.content, language, line.wordRanges)}</span></div>`;
}

function diffHtml(hunk: Hunk): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const unified = hunk.lines.map((line) => lineHtml(line, "unified", hunk.path)).join("");
  const split = splitDiffRows(hunk).map((row) => `<div class="split-row"><div class="split-cell">${row.old ? lineHtml(row.old, "old", hunk.path) : ""}</div><div class="split-cell new">${row.newer ? lineHtml(row.newer, "new", hunk.path) : ""}</div></div>`).join("");
  return `<div class="diff-frame" data-diff-frame data-layout="unified"><div class="diff"><div class="hunk-range">${esc(range)}</div><div class="unified">${unified}</div><div class="split"><div class="split-head"><span>Old</span><span>New</span></div>${split}</div></div></div>`;
}

function diffStat(added: number, removed: number): string {
  return `<span class="diff-stat"><span class="diff-add">+${added}</span><span class="diff-del">−${removed}</span></span>`;
}

function scale(signal: StageSignal, label: string): string {
  const level = signal === "low" ? 1 : signal === "medium" ? 2 : 3;
  return `<span class="dimension"><span class="signal-scale" aria-hidden="true">${[1, 2, 3].map((value) => `<i${value <= level ? ` class="active"` : ""}></i>`).join("")}</span><span>${esc(`${signal} ${label}`)}</span></span>`;
}

/** Signal marks only when a witness set them. A file seam that drew two empty scales
 *  would be asserting "low importance" about code nobody has judged yet. */
function dimensions(group: ReaderGroup, readLabel?: string, place = ""): string {
  const signals = group.importance && group.complexity
    ? `${scale(group.importance, "importance")}${scale(group.complexity, "complexity")}`
    : "";
  const read = readLabel === undefined
    ? ""
    : `<span class="dimension read-dimension" data-read-state><span class="read-mark" aria-hidden="true">✓</span><span>${esc(readLabel)}</span></span>`;
  if (!signals && !read) return "";
  return `<span class="dimensions ${place}">${signals}${read}</span>`;
}

function readForm(routes: ReaderRoutes, groupId: string, changeId: string, read: boolean, placement = ""): string {
  const back = routes.returnTo(groupId, changeId);
  return `<form class="read-form ${placement}" method="post" action="${esc(routes.read(changeId))}"><input data-read-input type="hidden" name="read" value="${read ? "false" : "true"}">${back === null ? "" : `<input type="hidden" name="return" value="${esc(back)}">`}<span data-read-failure role="status" aria-live="polite"></span><button data-read-button type="submit">${read ? "Mark unread" : "Mark read"}</button></form>`;
}

function contextControl(routes: ReaderRoutes, view: ChangeView): string {
  const { file, item } = view;
  const useNew = file.new_availability === "retained" && file.new_kind === "blob" && item.hunk.newLines > 0;
  const side = useNew ? "new" : "old";
  const available = useNew
    ? file.new_availability === "retained" && file.new_kind === "blob"
    : file.old_availability === "retained" && file.old_kind === "blob";
  if (!available) return "";
  const first = Math.max(1, (useNew ? item.hunk.newStart : item.hunk.oldStart) - 80);
  const length = useNew ? item.hunk.newLines : item.hunk.oldLines;
  const last = first + Math.min(399, Math.max(160, length + 160)) - 1;
  const url = routes.lines(file.id, side, first, last);
  return `<div class="file-context" data-context><button class="context-trigger" type="button" data-context-trigger data-context-url="${esc(url)}">Load file context</button><div class="context-lines" data-context-lines aria-live="polite"></div></div>`;
}

function gapControl(routes: ReaderRoutes, before: ChangeView, after: ChangeView): string {
  if (before.file.id !== after.file.id) return "";
  const useNew = before.file.new_availability === "retained" && before.file.new_kind === "blob";
  const useOld = before.file.old_availability === "retained" && before.file.old_kind === "blob";
  if (!useNew && !useOld) return "";
  const side = useNew ? "new" : "old";
  const start = useNew
    ? before.item.hunk.newStart + before.item.hunk.newLines
    : before.item.hunk.oldStart + before.item.hunk.oldLines;
  const finish = (useNew ? after.item.hunk.newStart : after.item.hunk.oldStart) - 1;
  if (finish < start) return "";
  const lines = finish - start + 1;
  const end = Math.min(finish, start + 399);
  const shown = end - start + 1;
  const label = shown === lines ? `${lines} unchanged line${lines === 1 ? "" : "s"}` : `${shown} of ${lines} unchanged lines`;
  const url = routes.lines(before.file.id, side, start, end);
  return `<div class="hunk-gap" data-context><button type="button" data-context-trigger data-context-url="${esc(url)}"><span aria-hidden="true">···</span>${esc(label)}<span aria-hidden="true">···</span></button><div class="context-lines" data-context-lines aria-live="polite"></div></div>`;
}

function fileFacts(file: StageCaptureFileRow): string {
  const values: [string, string][] = [
    ["status", file.status],
    ["old mode", file.old_mode ?? "not applicable"],
    ["new mode", file.new_mode ?? "not applicable"],
    ["old bytes", file.old_availability],
    ["new bytes", file.new_availability],
  ];
  return `<dl class="fact-list">${values.map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
}

/** Every group's place, change ids and read count, from the document and the inventory
 *  alone. What a focus page draws for the groups it did not materialize. */
function summarizeGroups(groups: ReaderGroup[], readIds: Set<string>): GroupSummary[] {
  return groups.map((group, index) => {
    const changeIds = group.members.filter((member) => member.type === "change").map((member) => member.id);
    return { group, index, changeIds, read: changeIds.filter((id) => readIds.has(id)).length };
  });
}

function summaryOf(view: GroupView): GroupSummary {
  return { group: view.group, index: view.index, changeIds: view.changes.map((change) => change.item.change.id), read: view.read };
}

function buildGroupViews(
  groups: ReaderGroup[],
  materialized: Map<string, MaterializedStageChange>,
  inventory: StageCaptureInventory,
  readIds: Set<string>,
  firstIndex = 0,
  seamOf?: (id: string) => ReaderSeam | null,
): GroupView[] {
  const fileById = new Map(inventory.files.map((file) => [file.id, file]));
  const materialById = new Map(inventory.incomplete.map((material) => [material.id, material]));
  const canonicalOrder = new Map(inventory.changes.map((change, index) => [change.id, index]));
  return groups.map((group, offset) => {
    const index = firstIndex + offset;
    const changes: ChangeView[] = [];
    const materials: GroupView["materials"] = [];
    const leafFiles: GroupView["leafFiles"] = [];
    const fileIds = new Set<string>();
    for (const member of group.members) {
      if (member.type === "change") {
        const item = materialized.get(member.id);
        const file = item && fileById.get(item.change.file_id);
        if (!item || !file) throw new StageMaterializationError(`Narrative change ${member.id} has no retained material.`);
        const measured = stats([item.hunk]);
        changes.push({ member: member as ChangeMember, item, file, diff: measured, ordinal: 0 });
        fileIds.add(file.id);
      } else if (member.type === "material") {
        const material = materialById.get(member.id);
        if (!material) throw new StageMaterializationError(`Narrative material ${member.id} is missing.`);
        materials.push({ member: member as MaterialMember, material });
        const file = material.path ? inventory.files.find((candidate) => candidate.path === material.path) : null;
        if (file) fileIds.add(file.id);
      } else {
        const file = fileById.get(member.id);
        if (!file) throw new StageMaterializationError(`Narrative file ${member.id} is missing.`);
        leafFiles.push({ member: member as FileMember, file });
        fileIds.add(file.id);
      }
    }
    const files = inventory.files.filter((file) => fileIds.has(file.id));
    const fileOrder = new Map(filesInTreeOrder(stageTree(files)).map((file, order) => [file.id, order]));
    // A stack account's validated reference order comes first. Inside one referenced
    // member group, retain the existing layer, file-tree and canonical ordering. Ordinary
    // stages and single reviews have no streamRank, so their order is unchanged.
    const seamRank = (id: string): number => seamOf?.(id)?.position ?? 0;
    changes.sort((left, right) =>
      (left.member.streamRank ?? 0) - (right.member.streamRank ?? 0)
      || seamRank(left.file.id) - seamRank(right.file.id)
      || (fileOrder.get(left.file.id) ?? 0) - (fileOrder.get(right.file.id) ?? 0)
      || (canonicalOrder.get(left.item.change.id) ?? 0) - (canonicalOrder.get(right.item.change.id) ?? 0),
    );
    changes.forEach((change, order) => { change.ordinal = order + 1; });
    const representative = new Map<string, StageCaptureFileRow>();
    const layersOf = new Map<string, number>();
    const treeFiles: StageCaptureFileRow[] = [];
    for (const file of [...files].sort((left, right) => seamRank(left.id) - seamRank(right.id))) {
      const key = seamOf ? file.path : file.id;
      const held = representative.get(key);
      if (held) { layersOf.set(held.id, (layersOf.get(held.id) ?? 1) + 1); continue; }
      representative.set(key, file);
      layersOf.set(file.id, 1);
      treeFiles.push(file);
    }
    const fileChanges = new Map<string, string[]>();
    const changeStats = new Map<string, StageChangeStats>();
    for (const change of changes) {
      const owner = representative.get(seamOf ? change.file.path : change.file.id)!.id;
      fileChanges.set(owner, [...(fileChanges.get(owner) ?? []), change.item.change.id]);
      changeStats.set(change.item.change.id, change.diff);
    }
    return {
      group,
      index,
      changes,
      files,
      treeFiles,
      layersOf,
      fileChanges,
      changeStats,
      materials,
      leafFiles,
      added: changes.reduce((sum, change) => sum + change.diff.added, 0),
      removed: changes.reduce((sum, change) => sum + change.diff.removed, 0),
      read: changes.filter((change) => readIds.has(change.item.change.id)).length,
    };
  });
}

function treeChangeIds(node: StageTreeNode, fileChanges: Map<string, string[]>): string[] {
  return [
    ...node.files.flatMap((file) => fileChanges.get(file.id) ?? []),
    ...node.folders.flatMap((folder) => treeChangeIds(folder, fileChanges)),
  ];
}

function treeSummary(ids: string[], files: number, added: number, removed: number, readIds: Set<string>): string {
  const read = ids.filter((id) => readIds.has(id)).length;
  return `<span class="tree-summary" data-tree-summary><span>${files} file${files === 1 ? "" : "s"}</span>${diffStat(added, removed)}<span class="tree-read${read === ids.length && ids.length > 0 ? " is-read" : ""}"><i aria-hidden="true"></i>${read}/${ids.length}</span></span>`;
}

/** `3 layers` beside a path several members touched. Nothing at all on one layer. */
function layersHtml(view: GroupView, file: StageCaptureFileRow): string {
  const layers = view.layersOf.get(file.id) ?? 1;
  return layers > 1 ? `<small class="tree-layers cross">${layers} layers</small>` : "";
}

function overviewTreeHtml(
  node: StageTreeNode,
  view: GroupView,
  readIds: Set<string>,
  routes: ReaderRoutes,
): string {
  const folders = node.folders.map((folder) => {
    const ids = treeChangeIds(folder, view.fileChanges);
    const counts = stageTreeStats(folder, view.fileChanges, readIds, view.changeStats);
    return `<details class="tree-folder"${view.files.length <= 8 ? " open" : ""} data-tree-node data-files="${counts.files}" data-added="${counts.added}" data-removed="${counts.removed}" data-change-ids="${ids.join(",")}"><summary><span class="tree-arrow" aria-hidden="true">›</span><span class="tree-label">${esc(folder.name)}</span>${treeSummary(ids, counts.files, counts.added, counts.removed, readIds)}</summary><div class="tree-children">${overviewTreeHtml(folder, view, readIds, routes)}</div></details>`;
  }).join("");
  const files = node.files.map((file) => {
    const ids = view.fileChanges.get(file.id) ?? [];
    const added = ids.reduce((sum, id) => sum + (view.changeStats.get(id)?.added ?? 0), 0);
    const removed = ids.reduce((sum, id) => sum + (view.changeStats.get(id)?.removed ?? 0), 0);
    const read = ids.filter((id) => readIds.has(id)).length;
    const first = ids[0];
    const content = `<span class="tree-file-name">${esc(file.path.split("/").at(-1) ?? file.path)}</span>${layersHtml(view, file)}${diffStat(added, removed)}<span class="tree-read${read === ids.length && ids.length > 0 ? " is-read" : ""}"><i aria-hidden="true"></i>${read}/${ids.length}</span>`;
    if (!first) return `<span class="tree-file" data-change-ids="">${content}</span>`;
    return `<a class="tree-file hoverable" data-focus-link data-review="${esc(view.group.id)}" data-change="${first}" data-change-ids="${ids.join(",")}" href="${routes.group(view.group.id, first)}">${content}</a>`;
  }).join("");
  return folders + files;
}

function focusTreeHtml(
  node: StageTreeNode,
  view: GroupView,
  readIds: Set<string>,
  routes: ReaderRoutes,
): string {
  const folders = node.folders.map((folder) => {
    const ids = treeChangeIds(folder, view.fileChanges);
    const counts = stageTreeStats(folder, view.fileChanges, readIds, view.changeStats);
    return `<details class="tree-folder" open data-tree-node data-files="${counts.files}" data-added="${counts.added}" data-removed="${counts.removed}" data-change-ids="${ids.join(",")}"><summary><span class="tree-arrow" aria-hidden="true">›</span><span class="tree-label">${esc(folder.name)}</span>${treeSummary(ids, counts.files, counts.added, counts.removed, readIds)}</summary><div class="tree-children">${focusTreeHtml(folder, view, readIds, routes)}</div></details>`;
  }).join("");
  const byId = new Map(view.changes.map((change) => [change.item.change.id, change]));
  const files = node.files.map((file) => {
    const changes = (view.fileChanges.get(file.id) ?? []).map((id) => byId.get(id)!);
    const added = changes.reduce((sum, change) => sum + change.diff.added, 0);
    const removed = changes.reduce((sum, change) => sum + change.diff.removed, 0);
    const read = changes.filter((change) => readIds.has(change.item.change.id)).length;
    const codeAnchor = `review-file-${view.group.id}-${changes[0]?.file.id ?? file.id}`;
    const factMember = view.leafFiles.find((entry) => entry.file.id === file.id)?.member
      ?? view.materials.find((entry) => entry.material.path === file.path)?.member;
    const fileAnchor = changes.length > 0 ? codeAnchor : factMember ? `focus-${factMember.id}` : codeAnchor;
    return `<div class="focus-tree-file" data-change-ids="${changes.map((change) => change.item.change.id).join(",")}"><a class="tree-file hoverable" data-scroll-file="${esc(fileAnchor)}" href="#${esc(fileAnchor)}"><span class="tree-file-name">${esc(file.path.split("/").at(-1) ?? file.path)}</span>${layersHtml(view, file)}${diffStat(added, removed)}<span class="tree-read${read === changes.length && changes.length > 0 ? " is-read" : ""}"><i aria-hidden="true"></i>${read}/${changes.length}</span></a>${changes.length === 0 ? "" : `<div class="tree-hunks">${changes.map((change) => {
      const id = change.item.change.id;
      const line = change.item.hunk.newLines > 0 ? change.item.hunk.newStart : change.item.hunk.oldStart;
      return `<a href="${routes.group(view.group.id, id)}" data-activate-change="${id}" data-read="${readIds.has(id)}"><i aria-hidden="true"></i>L${line}</a>`;
    }).join("")}</div>`}</div>`;
  }).join("");
  return folders + files;
}

function extraMaterialHtml(view: GroupView, focus = false): string {
  const materials = view.materials.map(({ member, material }) => `<details class="material-fact"${focus ? " open" : ""} id="${esc(focus ? `focus-${member.id}` : member.id)}"><summary><span>${esc(material.path ?? material.kind.replaceAll("_", " "))}</span><span>${esc(`${material.side} · ${material.kind.replaceAll("_", " ")}`)}</span></summary><div>${member.description === null ? "" : `<p>${esc(member.description)}</p>`}<p>${esc(material.reason)}</p></div></details>`).join("");
  const files = view.leafFiles.map(({ member, file }) => `<details class="material-fact"${focus ? " open" : ""} id="${esc(focus ? `focus-${member.id}` : member.id)}"><summary><span>${esc(file.old_path ? `${file.old_path} → ${file.path}` : file.path)}</span><span>${esc(file.status)}</span></summary><div>${member.description === null ? "" : `<p>${esc(member.description)}</p>`}${fileFacts(file)}</div></details>`).join("");
  if (!materials && !files) return "";
  return `<div class="group-materials">${materials}${files}</div>`;
}

/** The line above the sequence number. An authored group names its category there; a
 *  file seam has only its place in the reading order. */
function groupSequence(view: { group: ReaderGroup; index: number }): string {
  const sequence = String(view.index + 1).padStart(2, "0");
  return view.group.category === null ? sequence : `${sequence} · ${view.group.category}`;
}

function categoryAttr(group: ReaderGroup): string {
  return group.category === null ? "" : ` data-category="${esc(group.category)}"`;
}

/** An evidence seam: no category, no explanation, nothing a witness said. Its label is
 *  drawn as navigation rather than as a title. */
function seamAttr(group: ReaderGroup): string {
  return group.category === null && group.explanation === null ? " data-seam" : "";
}

function groupCard(view: GroupView, readIds: Set<string>, routes: ReaderRoutes): string {
  const tree = stageTree(view.treeFiles);
  const total = view.changes.length;
  const reviewLabel = total === 0 ? "Review material" : `Review ${total} change${total === 1 ? "" : "s"}`;
  const points = view.changes.slice(0, 3);
  return `<section class="review-group-card" id="group-${esc(view.group.id)}" data-group="${esc(view.group.id)}"${categoryAttr(view.group)}${seamAttr(view.group)} data-change-ids="${view.changes.map((change) => change.item.change.id).join(",")}"><header class="group-head"><div class="group-sequence"><i aria-hidden="true"></i><span>${esc(groupSequence(view))}</span></div><h2>${esc(view.group.title)}</h2>${dimensions(view.group, undefined, "in-group")}</header>${view.group.explanation === null ? "" : accountCopy(view.group.explanation, "group-copy")}${view.group.attention ? `<p class="group-attention">${esc(view.group.attention)}</p>` : ""}${points.length === 0 ? "" : `<ol class="group-points">${points.map((change) => {
    const line = change.item.hunk.newLines > 0 ? change.item.hunk.newStart : change.item.hunk.oldStart;
    return `<li><span>${String(change.ordinal).padStart(2, "0")}</span><code>${esc(change.file.path)}:L${line}</code>${change.member.description === null ? "" : `<p>${esc(exactExcerpt(change.member.description, 160).text)}</p>`}</li>`;
  }).join("")}${view.changes.length > points.length ? `<li class="remaining"><span>+</span><code></code><p>${view.changes.length - points.length} more in review</p></li>` : ""}</ol>`}${view.group.examples.length === 0 ? "" : `<ul class="group-examples">${view.group.examples.map((example) => `<li><code>${esc(example.code)}</code><span>${esc(example.text)}</span></li>`).join("")}</ul>`}<div class="group-preview"><div class="group-preview-files">${overviewTreeHtml(tree, view, readIds, routes)}</div>${extraMaterialHtml(view)}<footer><span data-group-progress>${view.read} / ${total} read</span><a class="review-group-action" data-focus-link data-review="${esc(view.group.id)}" href="${routes.group(view.group.id)}">${reviewLabel}<span aria-hidden="true">→</span></a></footer></div></section>`;
}

function categorySummary(views: GroupView[]): string {
  const order: StageCategory[] = ["Contract", "Code", "Tests", "Test fixtures", "Docs", "Generated"];
  return `<div class="category-summary" aria-label="Changed lines by category">${order.map((category) => {
    const matching = views.filter((view) => view.group.category === category);
    if (matching.length === 0) return "";
    const added = matching.reduce((sum, view) => sum + view.added, 0);
    const removed = matching.reduce((sum, view) => sum + view.removed, 0);
    return `<div data-category="${esc(category)}"><span>${esc(category)}</span>${diffStat(added, removed)}</div>`;
  }).join("")}</div>`;
}

function attentionBar(views: GroupView[]): string {
  const attention = views.filter((view) => view.group.attention);
  if (attention.length === 0) return "";
  const link = (view: GroupView) => `<a href="#group-${esc(view.group.id)}">${esc(view.group.title)}</a>`;
  const shown = attention.slice(0, 3).map(link).join("");
  const remaining = attention.slice(3);
  return `<div class="attention-bar"><span>Needs attention</span>${shown}${remaining.length === 0 ? "" : `<details><summary>${remaining.length} more</summary><div>${remaining.map(link).join("")}</div></details>`}</div>`;
}

/** What the reader says while nobody has answered yet. One short line, in the header,
 *  beside the source facts it belongs to — never a banner and never a document field. */
const WITNESS_WORDS: Record<ReaderWorkflow["word"], string> = {
  pending: "Witness pending",
  retrying: "Witness retrying",
  failed: "Witness failed",
  // A later revision was published while this one was still waiting. Saying "pending"
  // here would be a promise the workflow has already broken.
  superseded: "Witness superseded",
};

function workflowLine(workflow: ReaderWorkflow | null): string {
  if (!workflow) return "";
  return `<p class="stage-workflow" data-witness-state="${esc(workflow.word)}">${esc(WITNESS_WORDS[workflow.word])}${workflow.detail ? ` · ${esc(exactExcerpt(workflow.detail, 200).text)}` : ""}</p>`;
}

/** The one line about newer source: a link when there is somewhere to go, a state when
 *  there is not, and nothing at all when nothing moved. No banner, no pill, no modal. */
function driftLine(drift: ReaderDrift | null | undefined): string {
  if (!drift) return "";
  if (drift.kind === "revision") {
    return `<p class="stage-drift"><a href="${esc(drift.href)}">${esc(drift.label)}</a></p>`;
  }
  const detail = drift.kind === "capture" ? ` · capture ${drift.state}` : drift.kind === "refresh" ? " · refresh required" : "";
  return `<p class="stage-drift" data-drift="${esc(drift.kind)}">${esc(`New source${detail}`)}</p>`;
}

/** `Since rev 2 · 9 unchanged · 2 revised · 1 new`. Zero labels are omitted, because a
 *  count of nothing is not news. */
function movementLine(movement: ReaderMovement | null | undefined): string {
  if (!movement) return "";
  const parts: string[] = [];
  const add = (count: number, word: string): void => { if (count > 0) parts.push(`${count} ${word}`); };
  add(movement.code.unchanged, "unchanged");
  add(movement.code.revised, "revised");
  add(movement.code.new, "new");
  add(movement.code.removed, "removed");
  const tail = parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
  return `<p class="stage-movement">${esc(`Since rev ${movement.previousRevision}${tail}`)}</p>`;
}

/**
 * The pull request, in as few words as it can be said in.
 *
 * A short native link — `#41` — beside the repository and branch, because that is how
 * everybody already writes it, and the accessible name carries the whole of what the
 * abbreviation stands for. No panel, no banner, no pill.
 */
function pullRequestLink(pr: ReaderPullRequest): string {
  return `<a class="source-pr" href="${esc(pr.url)}" rel="noreferrer noopener" ` +
    `aria-label="${esc(`${pr.repo}#${pr.number}: ${pr.title}`)}">#${esc(pr.number)}</a>`;
}

/** Status and age together, because either alone would be read as live state. */
function pullRequestStanding(pr: ReaderPullRequest, now: number = Date.now()): string {
  return `${pr.state}, observed ${agoWords(now - pr.observedAt)}`;
}

/** On phone the PR citation moves out of the compact focus header and into Details. */
function focusPullRequest(pr: ReaderPullRequest | null | undefined): string {
  if (!pr) return "";
  return `<p class="focus-pr-source">${pullRequestLink(pr)} · ${esc(pullRequestStanding(pr))}</p>`;
}

/** Decisions and risks, each one a link into the code it stands on. Anchors overlap and
 *  own nothing, so this is a second way into the same changes rather than a partition. */
function focusSection(doc: ReaderDoc, views: GroupView[], routes: ReaderRoutes): string {
  if (doc.focus.length === 0) return "";
  const home = new Map<string, { groupId: string; changeId: string | null; anchor: string }>();
  for (const view of views) {
    for (const change of view.changes) {
      const id = change.item.change.id;
      if (!home.has(id)) home.set(id, { groupId: view.group.id, changeId: id, anchor: id });
    }
    for (const { member } of view.materials) {
      if (!home.has(member.id)) home.set(member.id, { groupId: view.group.id, changeId: null, anchor: `focus-${member.id}` });
    }
    for (const file of view.files) {
      if (home.has(file.id)) continue;
      const changed = view.changes.some((candidate) => candidate.file.id === file.id);
      const leaf = view.leafFiles.find((entry) => entry.file.id === file.id);
      const material = view.materials.find((entry) => entry.material.path === file.path);
      const anchor = changed
        ? `review-file-${view.group.id}-${file.id}`
        : `focus-${leaf?.member.id ?? material?.member.id ?? file.id}`;
      home.set(file.id, { groupId: view.group.id, changeId: null, anchor });
    }
  }
  const label = (anchorId: string): string => {
    for (const view of views) {
      const change = view.changes.find((candidate) => candidate.item.change.id === anchorId);
      if (change) {
        const line = change.item.hunk.newLines > 0 ? change.item.hunk.newStart : change.item.hunk.oldStart;
        return `${change.file.path}:L${line}`;
      }
      const material = view.materials.find((entry) => entry.member.id === anchorId);
      if (material) return material.material.path ?? material.material.kind.replaceAll("_", " ");
      const file = view.files.find((entry) => entry.id === anchorId);
      if (file) return file.path;
    }
    return anchorId;
  };
  const items = doc.focus.map((item) => {
    const anchors = item.anchors.map((anchor) => {
      const place = home.get(anchor.id);
      const text = esc(label(anchor.id));
      if (!place) return `<code>${text}</code>`;
      if (place.changeId) return `<a href="${routes.group(place.groupId, place.changeId)}"><code>${text}</code></a>`;
      const groupUrl = routes.group(place.groupId).split("#", 1)[0]!;
      return `<a href="${groupUrl}#${esc(place.anchor)}"><code>${text}</code></a>`;
    }).join("");
    return `<details class="focus-item" id="focus-item-${esc(item.id)}"><summary><h3>${esc(item.title)}</h3><span>${item.kind === "risk" ? "risk" : "decision"}</span></summary><div class="focus-item-body"><div class="markdown">${markdown(item.body)}</div><p class="focus-anchors">${anchors}</p></div></details>`;
  }).join("");
  return `<section class="focus-items" aria-label="Decisions and risks">${items}</section>`;
}

function evidenceSection(doc: ReaderDoc): string {
  if (doc.evidence.length === 0) return "";
  return `<section class="account-evidence" aria-label="Evidence"><h2>Evidence</h2><ul>${doc.evidence.map((item) => `<li><a href="${esc(item.href)}">${esc(item.label)}</a><span>${esc(item.detail)}</span></li>`).join("")}</ul></section>`;
}

/** The pin is said once, in the header; the rail carries only the progress. */
function groupNavigation(views: GroupView[], totalRead: number, total: number): string {
  const progress = total === 0 ? 100 : Math.round(totalRead / total * 100);
  return `<div class="review-nav-head"><strong data-progress>${totalRead} / ${total} read</strong><span class="progress-track"><i data-progress-fill style="width:${progress}%"></i></span></div><nav class="group-links" aria-label="Walkthrough groups">${views.map((view) => `<a href="#group-${esc(view.group.id)}"${categoryAttr(view.group)}><i aria-hidden="true"></i><span><small>${esc(groupSequence(view))}</small><strong>${esc(view.group.title)}</strong></span><em data-group-nav-progress data-change-ids="${view.changes.map((change) => change.item.change.id).join(",")}">${view.read}/${view.changes.length}</em></a>`).join("")}</nav>`;
}

function hunkReview(view: GroupView, change: ChangeView, readIds: Set<string>, routes: ReaderRoutes): string {
  const id = change.item.change.id;
  const read = readIds.has(id);
  const line = change.item.hunk.newLines > 0 ? change.item.hunk.newStart : change.item.hunk.oldStart;
  const path = change.file.old_path ? `${change.file.old_path} → ${change.file.path}` : change.file.path;
  return `<article class="hunk-review${read ? " is-read" : ""}" id="${id}" data-change="${id}" data-read="${read}" data-collapsed="false"><header class="hunk-header"><button class="disclosure-button" type="button" data-toggle-change="${id}" aria-expanded="true" aria-label="Collapse ${esc(path)}"><span aria-hidden="true">⌄</span></button><span class="hunk-index">${String(change.ordinal).padStart(2, "0")}</span><code>${esc(path)}:L${line}</code>${diffStat(change.diff.added, change.diff.removed)}${dimensions(view.group, read ? "Read" : "Unread", "in-header")}${readForm(routes, view.group.id, id, read, "header-read")}</header><div class="hunk-body" data-hunk-body>${change.member.description === null ? "" : `<p class="hunk-description">${esc(change.member.description)}</p>`}<p class="hunk-range">old ${change.item.hunk.oldStart},${change.item.hunk.oldLines} · new ${change.item.hunk.newStart},${change.item.hunk.newLines}</p>${diffHtml(change.item.hunk)}${contextControl(routes, change)}</div></article>`;
}

function fileReview(
  view: GroupView,
  file: StageCaptureFileRow,
  changes: ChangeView[],
  readIds: Set<string>,
  routes: ReaderRoutes,
): string {
  const added = changes.reduce((sum, change) => sum + change.diff.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.diff.removed, 0);
  const read = changes.filter((change) => readIds.has(change.item.change.id)).length;
  const anchor = `review-file-${view.group.id}-${file.id}`;
  return `<details class="file-review" id="${esc(anchor)}" open><summary class="file-review-head"><span class="file-disclosure" aria-hidden="true">⌄</span><span class="file-review-title"><strong>${esc(file.old_path ? `${file.old_path} → ${file.path}` : file.path)}</strong><small><span data-file-progress>${read} / ${changes.length} read</span></small></span>${diffStat(added, removed)}</summary><div class="file-review-body">${changes.map((change, index) => `${index === 0 ? "" : gapControl(routes, changes[index - 1]!, change)}${hunkReview(view, change, readIds, routes)}`).join("")}</div></details>`;
}

function focusLedger(view: GroupView, readIds: Set<string>, routes: ReaderRoutes): string {
  if (view.changes.length === 0) return `<p class="empty-ledger">No code changes in this group.</p>`;
  return view.changes.map((change) => {
    const id = change.item.change.id;
    const read = readIds.has(id);
    const line = change.item.hunk.newLines > 0 ? change.item.hunk.newStart : change.item.hunk.oldStart;
    return `<article class="ledger-card${read ? " is-read" : ""}" data-ledger-change="${id}" data-change="${id}" data-read="${read}"><button type="button" data-activate-change="${id}"><span>${String(change.ordinal).padStart(2, "0")}</span><code>${esc(change.file.path)}:L${line}</code>${diffStat(change.diff.added, change.diff.removed)}</button><div class="ledger-body">${dimensions(view.group, read ? "Read" : "Unread", "in-ledger")}${change.member.description === null ? "" : `<p>${esc(change.member.description)}</p>`}${readForm(routes, view.group.id, id, read, "ledger-read")}</div></article>`;
  }).join("");
}

export function filesInTreeOrder(node: StageTreeNode): StageCaptureFileRow[] {
  return [...node.folders.flatMap(filesInTreeOrder), ...node.files];
}

/** The stream's file order: tree order, or in a stack every file of layer 1 in tree order,
 *  then layer 2, and so on, so the seam bands read bottom-to-top. */
function streamFiles(view: GroupView, seamOf?: (id: string) => ReaderSeam | null): { file: StageCaptureFileRow; changes: ChangeView[] }[] {
  if (view.changes.some((change) => change.member.streamRank !== undefined)) {
    const files: StageCaptureFileRow[] = [];
    const seen = new Set<string>();
    for (const change of view.changes) {
      if (seen.has(change.file.id)) continue;
      seen.add(change.file.id);
      files.push(change.file);
    }
    return files.map((file) => ({ file, changes: view.changes.filter((change) => change.file.id === file.id) }));
  }
  const byLayer = new Map<number, StageCaptureFileRow[]>();
  for (const file of view.files) {
    const position = seamOf?.(file.id)?.position ?? 0;
    byLayer.set(position, [...(byLayer.get(position) ?? []), file]);
  }
  return [...byLayer.keys()].sort((left, right) => left - right)
    .flatMap((position) => filesInTreeOrder(stageTree(byLayer.get(position)!)))
    .map((file) => ({ file, changes: view.changes.filter((change) => change.file.id === file.id) }))
    .filter((entry) => entry.changes.length > 0);
}

function seamBand(seam: ReaderSeam): string {
  return `<div class="stack-seam" data-seam="${esc(seam.id)}" data-seam-position="${seam.position}"><b>${esc(seam.label)}</b><span>${esc(seam.detail)}</span><a href="${esc(seam.href)}">open</a></div>`;
}

function pageControls(page: ReaderPageState | undefined, placement: "header" | "ledger"): string {
  if (!page) return "";
  const part = page.part ? ` · part ${page.part.number} of ${page.part.count}` : "";
  const text = `page ${page.number} of ${page.count}${part}`;
  if (placement === "ledger") return `<p class="ledger-page">${esc(text)}${page.overBudget ? " · over budget" : ""}</p>`;
  const link = (number: number, label: string, enabled: boolean) =>
    `<a data-page-link href="${esc(page.href(number))}" aria-label="${esc(label)}"${enabled ? "" : ` aria-disabled="true" tabindex="-1"`}>${label === "Previous page" ? "‹" : "›"}</a>`;
  return `<span class="focus-page">${link(page.number - 1, "Previous page", page.number > 1)}${esc(text)}${link(page.number + 1, "Next page", page.number < page.count)}</span>`;
}

function scopeControl(scope: ReaderScope | undefined): string {
  if (!scope) return "";
  const hidden = Object.entries(scope.hidden).map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join("");
  const options = [`<option value=""${scope.current === null ? " selected" : ""}>Whole stack</option>`,
    ...scope.options.map((option) => `<option value="${esc(option.value)}"${option.value === scope.current ? " selected" : ""}>${esc(option.label)}</option>`)].join("");
  return `<form class="scope-row" method="get" action="${esc(scope.action)}">${hidden}<label>Scope <select class="scope-select" name="layer" data-scope aria-label="Review scope">${options}</select></label><button class="scope-go" type="submit">Go</button></form>`;
}

function focusDialog(
  selected: GroupView | null,
  views: GroupSummary[],
  readIds: Set<string>,
  routes: ReaderRoutes,
  doc: ReaderDoc,
  activeChange: string | null,
  options: RenderReaderOptions = {},
): string {
  const scopeAttrs = ` data-layer="${esc(options.scope?.current ?? "")}" data-page="${options.page ? options.page.number : ""}"`;
  if (!selected) return `<dialog class="focus-dialog" data-focus-dialog${scopeAttrs} aria-label="Group review"></dialog>`;
  const selectedTree = stageTree(selected.treeFiles);
  const tree = focusTreeHtml(selectedTree, selected, readIds, routes);
  // Seam bands only on the whole stack: one layer is one seam, and a band saying so on
  // every file would be a label for nothing.
  const seams = options.seamOf && !options.scope?.current ? options.seamOf : null;
  // Each layer is its own section, and that is what makes the seams REPLACE each other: a
  // sticky band is contained by its section, so the end of layer 1 pushes seam 1 out as
  // seam 2 arrives, instead of every past seam piling up pinned at the top.
  const layered = (entries: { id: string; html: string }[]): string => {
    if (!seams) return entries.map((entry) => entry.html).join("");
    const sections: string[] = [];
    let open: string[] = [];
    let openSeam: string | null = null;
    const close = (): void => {
      if (open.length > 0) sections.push(`<section class="stack-layer">${open.join("")}</section>`);
      open = [];
    };
    for (const entry of entries) {
      const seam = seams(entry.id);
      if (seam && seam.id !== openSeam) {
        close();
        openSeam = seam.id;
        open.push(seamBand(seam));
      }
      open.push(entry.html);
    }
    close();
    return sections.join("");
  };
  const groupLinks = views.map((view) => `<a class="focus-group-link${view.group.id === selected.group.id ? " is-active" : ""}" data-focus-group-link data-review="${esc(view.group.id)}"${categoryAttr(view.group)} href="${routes.group(view.group.id)}"><i aria-hidden="true"></i><span><small>${esc(groupSequence(view))}</small><strong>${esc(view.group.title)}</strong></span><em data-group-nav-progress data-change-ids="${view.changeIds.join(",")}">${view.read}/${view.changeIds.length}</em></a>`).join("");
  const headTitle = selected.group.category === null
    ? `${doc.title} · ${String(selected.index + 1).padStart(2, "0")}`
    : `${doc.title} · ${groupSequence(selected)}`;
  const subtitle = options.scope?.subtitle ? `<span class="focus-subtitle">${esc(options.scope.subtitle)}</span>` : "";
  const ledgerHead = `${options.scope?.subtitle ? `<p class="ledger-page">${esc(options.scope.subtitle)}</p>` : ""}${pageControls(options.page, "ledger")}`;
  const rankOf = (member: ReaderMember): number => member.streamRank ?? 0;
  const ranks = [...new Set([
    ...selected.changes.map((entry) => rankOf(entry.member)),
    ...selected.materials.map((entry) => rankOf(entry.member)),
    ...selected.leafFiles.map((entry) => rankOf(entry.member)),
  ])].sort((left, right) => left - right);
  const streamEntries = ranks.flatMap((rank) => {
    const changes = selected.changes.filter((entry) => rankOf(entry.member) === rank);
    const materials = selected.materials.filter((entry) => rankOf(entry.member) === rank);
    const leafFiles = selected.leafFiles.filter((entry) => rankOf(entry.member) === rank);
    const fileEntries = streamFiles({ ...selected, changes }, options.seamOf)
      .map(({ file, changes: fileChanges }) => ({ id: file.id, html: fileReview(selected, file, fileChanges, readIds, routes) }));
    const materialHtml = extraMaterialHtml({ ...selected, changes, materials, leafFiles }, true);
    return materialHtml === ""
      ? fileEntries
      : [...fileEntries, { id: materials[0]?.member.id ?? leafFiles[0]!.member.id, html: materialHtml }];
  });
  return `<dialog class="focus-dialog" data-focus-dialog data-review="${esc(selected.group.id)}"${scopeAttrs} data-active-change="${esc(activeChange ?? selected.changes[0]?.item.change.id ?? "")}" aria-label="${esc(selected.group.title)} review" open><div class="focus-shell"><header class="focus-header"><div class="focus-head-left"><a class="focus-brand" href="/bundles">Seer</a><button type="button" data-focus-toggle="tree" aria-label="Toggle review navigation"><span aria-hidden="true">☰</span></button></div><div class="focus-head-title"><span>${esc(headTitle)}</span><strong>${esc(selected.group.title)}</strong>${subtitle}</div><div class="focus-head-actions"><span${doc.pullRequest ? ` title="${esc(doc.source.sourceHeadSha)}"` : ""}>${esc(doc.pin)} · ${esc(shortSha(doc.source.sourceHeadSha))}</span>${doc.pullRequest ? pullRequestLink(doc.pullRequest) : ""}${pageControls(options.page, "header")}<button type="button" data-change-step="previous" aria-label="Previous change">↑</button><button type="button" data-change-step="next" aria-label="Next change">↓</button><button type="button" data-focus-toggle="detail" aria-label="Toggle review details"><span aria-hidden="true">◫</span></button><a data-focus-close href="${routes.close()}" aria-label="Close group review"><span aria-hidden="true">×</span></a></div></header><div class="focus-layout" data-focus-layout data-left="open" data-right="open"><aside class="focus-left" aria-label="Review navigation"><header><button type="button" data-focus-toggle="tree" aria-label="Collapse review navigation">‹</button></header><nav><div class="focus-group-links">${groupLinks}</div><div class="focus-file-tree">${tree}</div></nav></aside><main class="focus-stream" data-focus-stream${seams ? " data-seams" : ""}><header class="focus-stream-head"${categoryAttr(selected.group)}><div><span>${esc(groupSequence(selected))}</span><h2>${esc(selected.group.title)}</h2>${selected.group.explanation === null ? "" : accountCopy(selected.group.explanation, "focus-account", 160)}${scopeControl(options.scope)}</div>${diffStat(selected.added, selected.removed)}</header>${layered(streamEntries)}</main><aside class="focus-right" aria-label="Review details"><header><button type="button" data-filter-unread aria-pressed="false">Unread</button><button type="button" data-focus-toggle="detail" aria-label="Collapse review details">›</button></header><div class="focus-ledger">${ledgerHead}${focusPullRequest(doc.pullRequest)}${focusLedger(selected, readIds, routes)}</div></aside><button class="focus-scrim" type="button" data-focus-panel-close hidden aria-label="Close panel"></button></div><nav class="focus-mobile-bar" aria-label="Review panels"><button type="button" data-focus-toggle="tree">Review</button><span data-focus-change-position></span><button type="button" data-focus-toggle="detail">Details</button></nav></div></dialog>`;
}

function storageFailurePage(nav: NavContext, title: string, status: number): Response {
  const message = status === 502 ? "Retained source is temporarily unavailable. Try again." : "Retained source is corrupt. This version cannot be rendered.";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${STAGE_THEME_BOOTSTRAP}</script><style>${STAGE_CSS}</style><title>${esc(title)} · Seer</title></head><body><div class="stage-shell">${appBar(nav)}<main class="stage-header"><h1>${esc(title)}</h1><p>${message}</p></main></div></body></html>`, status);
}

// ---- the one renderer ----

/**
 * Draw one reader document. Shared by the stage walkthrough, a promoted review's
 * evidence revision, and every account published over it.
 *
 * The materializer is the durable-storage seam and the only place bytes come from:
 * nothing on this path can reach GitHub, on any of the three surfaces. A focus page
 * materializes the one group it draws; the overview materializes the capture. Every seam
 * a reader opens on a thousand-file capture used to cost the whole capture, which is the
 * wrong shape for the sizes the budgets allow.
 */
export async function renderReaderPage(
  req: Request,
  nav: NavContext,
  workspaceId: string,
  doc: ReaderDoc,
  routes: ReaderRoutes,
  inventory: StageCaptureInventory,
  readIds: Set<string>,
  label: string,
  options: RenderReaderOptions = {},
): Promise<Response> {
  const url = new URL(req.url);
  const reviewId = url.searchParams.get("review");
  const requestedChange = url.searchParams.get("change");
  const selectedIndex = reviewId === null ? -1 : doc.groups.findIndex((group) => group.id === reviewId);
  if (reviewId !== null && selectedIndex < 0) return softNotFound(req);
  // On a paged stream the group drawn is the page's slice of it; the rail still counts the
  // whole group, because progress is a fact about the group and not about this page.
  const selectedGroup = selectedIndex < 0 ? null : options.page ? { ...doc.groups[selectedIndex]!, members: options.page.members } : doc.groups[selectedIndex]!;
  const selectedChangeIds = selectedGroup
    ? new Set(selectedGroup.members.filter((member) => member.type === "change").map((member) => member.id))
    : null;
  if (requestedChange !== null && (!selectedChangeIds || !selectedChangeIds.has(requestedChange))) return softNotFound(req);

  const materialize = options.materialize ?? ((only?: ReadonlySet<string>) => materializeCanonicalChanges(inventory, (digest) => loadStageBytes(workspaceId, digest), only));
  let changes: MaterializedStageChange[];
  try {
    changes = await materialize(selectedChangeIds ?? undefined);
  } catch (err) {
    console.error(`[seer] ${label} could not materialize:`, err);
    return storageFailurePage(nav, doc.title, err instanceof StageStoreUnavailable ? 502 : 500);
  }
  const materialized = new Map(changes.map((item) => [item.change.id, item]));
  const allChangeIds = inventory.changes.map((change) => change.id);
  const readCount = allChangeIds.filter((id) => readIds.has(id)).length;

  if (selectedGroup) {
    let selected: GroupView;
    try {
      selected = buildGroupViews([selectedGroup], materialized, inventory, readIds, selectedIndex, options.seamOf)[0]!;
    } catch (err) {
      console.error(`[seer] ${label} walkthrough is inconsistent:`, err);
      return storageFailurePage(nav, doc.title, 500);
    }
    const rail = summarizeGroups(doc.groups, readIds).map((summary) => summary.index === selectedIndex ? summaryOf(selected) : summary);
    const focusPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><script>${STAGE_THEME_BOOTSTRAP}</script><title>${esc(selected.group.title)} · ${esc(doc.title)} · Seer</title><style>${STAGE_CSS}</style></head><body data-stage-change-ids="${allChangeIds.join(",")}" data-stage-read-ids="${[...readIds].join(",")}">${focusDialog(selected, rail, readIds, routes, doc, requestedChange, options)}<script>${STAGE_CLIENT}</script></body></html>`;
    return html(focusPage);
  }

  let views: GroupView[];
  try {
    views = buildGroupViews(doc.groups, materialized, inventory, readIds, 0, options.seamOf);
  } catch (err) {
    console.error(`[seer] ${label} walkthrough is inconsistent:`, err);
    return storageFailurePage(nav, doc.title, 500);
  }
  const groupCards = views.map((view) => groupCard(view, readIds, routes)).join("");
  const historyLinks = routes.history()
    .map((entry) => `<a href="${entry.href}"${entry.current ? ` aria-current="page"` : ""}>${esc(entry.label)}</a>`)
    .join(" · ");
  const progress = allChangeIds.length === 0 ? 100 : Math.round(readCount / allChangeIds.length * 100);
  const accounts = `${doc.builder ? accountCard("Builder", doc.builder) : ""}${doc.witness ? accountCard("Witness", doc.witness) : ""}`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><script>${STAGE_THEME_BOOTSTRAP}</script><title>${esc(doc.title)} · Seer</title><style>${STAGE_CSS}</style></head><body data-stage-change-ids="${allChangeIds.join(",")}" data-stage-read-ids="${[...readIds].join(",")}"><div data-stage-background><div class="stage-shell">${appBar(nav)}</div><div class="stage-grid stage-overview"><header class="stage-header"><p class="stage-context">${esc(doc.source.repo)} · ${esc(doc.source.branch)}${doc.pullRequest ? ` · ${pullRequestLink(doc.pullRequest)}` : ""}</p><h1>${esc(doc.title)}</h1><div class="stage-source"><span>${esc(`${shortSha(doc.source.mergeBaseSha)} → ${shortSha(doc.source.sourceHeadSha)}`)}</span><span>${esc(doc.standing)}${doc.latest ? " · latest" : ""}</span>${doc.pullRequest ? `<span class="source-observation">${esc(pullRequestStanding(doc.pullRequest))}</span>` : ""}</div>${workflowLine(doc.workflow)}${driftLine(doc.drift)}${movementLine(doc.movement)}${doc.authored ? categorySummary(views) : ""}${doc.authored ? attentionBar(views) : ""}</header>${accounts === "" ? "" : `<section class="accounts" aria-label="Accounts">${accounts}</section>`}${options.aside ?? ""}${focusSection(doc, views, routes)}${evidenceSection(doc)}</div><div class="stage-grid stage-body"><aside class="review-nav" data-review-nav data-open="false"><div class="mobile-nav-head"><button type="button" data-review-nav-close aria-label="Close review navigation">Close</button></div>${groupNavigation(views, readCount, allChangeIds.length)}</aside><main class="walkthrough">${groupCards}<footer class="terminal"><div><h2 data-unread-summary>${readCount === allChangeIds.length ? "Read" : `${allChangeIds.length - readCount} unread`}</h2><span class="progress-track"><i data-progress-fill style="width:${progress}%"></i></span></div><p>${inventory.files.length} file${inventory.files.length === 1 ? "" : "s"}</p></footer></main><aside class="source-rail"><h2>Source</h2><p>${historyLinks}</p><section><p>${esc(doc.source.repo)}</p><p>${esc(doc.source.branch)}</p><code${doc.pullRequest ? ` title="${esc(doc.source.sourceHeadSha)}"` : ""}>${esc(shortSha(doc.source.sourceHeadSha))}</code></section></aside></div><nav class="mobile-bar" aria-label="Stage navigation"><button type="button" data-review-nav-open>${esc(doc.pin)}</button><span data-progress>${readCount} / ${allChangeIds.length} read</span></nav><button class="page-scrim" type="button" data-page-scrim hidden aria-label="Close review navigation"></button></div>${focusDialog(null, [], readIds, routes, doc, null, options)}<script>${STAGE_CLIENT}</script></body></html>`;
  return html(page);
}

// ---- the StageDoc V1 adapter ----

/** An authored group as the reader reads it. Every field is present, so the reader
 *  draws category, both signals, and the witness's own descriptions. */
export function readerGroupOf(group: StageGroup): ReaderGroup {
  return {
    id: group.id,
    title: group.title,
    category: group.category,
    importance: group.importance,
    complexity: group.complexity,
    explanation: group.explanation,
    ...(group.attention === undefined ? {} : { attention: group.attention }),
    examples: group.examples,
    members: group.members.map((member) => ({ type: member.type, id: member.id, description: member.description })),
  };
}

function stageRoutes(workspaceId: string, slug: string, version: number, latestVersion: number): ReaderRoutes {
  const pinned = `/${workspaceId}/st/${slug}/v/${version}`;
  return {
    group(groupId, changeId) {
      const params = new URLSearchParams({ review: groupId });
      if (changeId) params.set("change", changeId);
      return `${pinned}?${esc(params.toString())}#${esc(changeId ?? `review-${groupId}`)}`;
    },
    close: () => pinned,
    read: (changeId) => `${pinned}/changes/${changeId}/read`,
    // The stage read route derives the group from the stored StageDoc, as it has since
    // it shipped. Saying it here would change a URL that is already correct.
    returnTo: () => null,
    lines: (fileId, side, start, end) => `/api/stages/${slug}/v/${version}/files/${fileId}?side=${side}&start=${start}&end=${end}`,
    history: () => Array.from({ length: latestVersion }, (_, index) => index + 1).map((number) => ({
      label: `v${number}`,
      href: `/${workspaceId}/st/${slug}/v/${number}`,
      current: number === version,
    })),
  };
}

export async function handleStagePage(
  req: Request,
  workspaceId: string,
  slug: string,
  rawVersion: string | null,
): Promise<Response> {
  const user = sessionUser(req);
  const workspace = getWorkspace(workspaceId);
  if (!user || !workspace || !isMember(workspaceId, user.id) || !SLUG_RE.test(slug)) return softNotFound(req);
  const stage = getStage(workspaceId, slug);
  if (!stage) return softNotFound(req);
  const versionNumber = rawVersion === null ? stage.latest_version : VERSION_RE.test(rawVersion) ? Number(rawVersion) : 0;
  if (versionNumber < 1 || versionNumber > stage.latest_version) return softNotFound(req);
  const version = getStageVersion(workspaceId, slug, versionNumber);
  if (!version) return softNotFound(req);
  const inventory = getStageCaptureForWorkspaces(version.capture_id, [workspaceId]);
  if (!inventory) return softNotFound(req);

  const nav: NavContext = {
    email: user.email,
    workspaces: listUserWorkspaces(user.id).map((item) => ({ id: item.id, name: item.name })),
    current: { id: workspace.id, name: workspace.name },
    section: "projects",
  };

  const doc: ReaderDoc = {
    title: version.doc.identity.title,
    source: {
      repo: version.doc.source.repo,
      branch: version.doc.source.branch,
      sourceHeadSha: version.doc.source.sourceHeadSha,
      mergeBaseSha: version.doc.source.mergeBaseSha,
    },
    builder: {
      agent: version.doc.builder.agent,
      body: version.doc.builder.intent,
      context: version.doc.builder.context,
    },
    witness: { agent: version.doc.witness.agent, body: version.doc.witness.summary },
    groups: version.doc.witness.groups.map(readerGroupOf),
    focus: [],
    evidence: [],
    authored: true,
    workflow: null,
    // A stage has no pull request under it, so nothing can move beneath it and there is
    // no earlier revision of it to have changed. Said rather than left absent, so the
    // adapter states the answer instead of relying on a missing field to mean it.
    drift: null,
    movement: null,
    standing: `Version ${versionNumber}`,
    pin: `v${versionNumber}`,
    latest: versionNumber === stage.latest_version,
  };

  return renderReaderPage(
    req,
    nav,
    workspaceId,
    doc,
    stageRoutes(workspaceId, slug, versionNumber, stage.latest_version),
    inventory,
    listStageReadChangeIds(workspaceId, version.id, user.id),
    `stage ${workspaceId}/${slug}/v/${versionNumber}`,
  );
}
