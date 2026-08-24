import { sessionEmail, sessionUser } from "../auth";
import { getWorkspace, isMember, listUserWorkspaces } from "../db";
import { escapeHtml } from "../escape";
import { SLUG_RE } from "../ids";
import { render as renderMarkdown } from "../overseer/markdown";
import { codeHtml, langOfPath, stats } from "../overseer/render-diff";
import type { Hunk, HunkLine } from "../overseer/types";
import { appBar, softNotFoundPage, type NavContext } from "../pages";
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
  changesByFile,
  splitDiffRows,
  stageTree,
  stageTreeStats,
  type StageTreeNode,
} from "./render-model";
import {
  materializeCanonicalChanges,
  StageMaterializationError,
  type MaterializedStageChange,
} from "./source";
import type { StageGroup, StageMember } from "./types";

const VERSION_RE = /^[1-9][0-9]{0,8}$/;

function esc(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function markdown(value: string): string {
  return renderMarkdown(value);
}

function softNotFound(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function accountHeading(role: "Builder" | "Witness", name: string, model: string): string {
  const identity = name.trim().toLowerCase() === role.toLowerCase() ? model : `${name} · ${model}`;
  return `<h2>${role}<span> · ${esc(identity)}</span></h2>`;
}

function summaryHeader(title: string, metadata: string, action = ""): string {
  return `<summary class="item-summary hoverable"><span class="item-arrow" aria-hidden="true">›</span><span class="item-title">${esc(title)}</span><span class="item-meta">${esc(metadata)}</span>${action}</summary>`;
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
  return `<div class="diff-frame" data-diff-frame data-layout="unified"><div class="diff"><div class="hunk-head">${esc(range)}</div><div class="unified">${unified}</div><div class="split"><div class="split-head"><span>Old</span><span>New</span></div>${split}</div></div></div>`;
}

function readForm(workspaceId: string, slug: string, version: number, changeId: string, read: boolean): string {
  return `<form class="read-form" method="post" action="/${workspaceId}/st/${slug}/v/${version}/changes/${changeId}/read"><input data-read-input type="hidden" name="read" value="${read ? "false" : "true"}"><span data-read-failure role="status" aria-live="polite"></span><button data-read-button type="submit">${read ? "Mark unread" : "Mark as read"}</button></form>`;
}

function contextControl(slug: string, version: number, item: MaterializedStageChange, file: StageCaptureFileRow): string {
  const useNew = file.new_availability === "retained" && file.new_kind === "blob" && item.hunk.newLines > 0;
  const side = useNew ? "new" : "old";
  const available = useNew
    ? file.new_availability === "retained" && file.new_kind === "blob"
    : file.old_availability === "retained" && file.old_kind === "blob";
  if (!available) return "";
  const first = Math.max(1, (useNew ? item.hunk.newStart : item.hunk.oldStart) - 80);
  const length = useNew ? item.hunk.newLines : item.hunk.oldLines;
  const last = first + Math.min(399, Math.max(160, length + 160)) - 1;
  const url = `/api/stages/${slug}/v/${version}/files/${file.id}?side=${side}&start=${first}&end=${last}`;
  return `<div class="file-context" data-context><button class="context-trigger" type="button" data-context-trigger data-context-url="${esc(url)}">Load file context</button><div class="context-lines" data-context-lines aria-live="polite"></div></div>`;
}

function localSignals(group: StageGroup, readState: string): string {
  return `<div class="local-signals"><span>${esc(group.category)}</span><span class="importance">importance ${esc(group.importance)}</span><span class="complexity">complexity ${esc(group.complexity)}</span><span data-read-state>${esc(readState)}</span></div>`;
}

function changeItem(
  workspaceId: string,
  slug: string,
  version: number,
  group: StageGroup,
  member: Extract<StageMember, { type: "change" }>,
  item: MaterializedStageChange,
  file: StageCaptureFileRow,
  readIds: Set<string>,
  focused: boolean,
): string {
  const read = readIds.has(item.change.id);
  const count = stats([item.hunk]);
  const path = file.old_path ? `${file.old_path} → ${file.path}` : file.path;
  const metadata = `${read ? "read" : "unread"} · +${count.added} −${count.removed}`;
  const action = `<a class="review-action" data-focus-link data-focus="${item.change.id}" href="/${workspaceId}/st/${slug}/v/${version}?focus=${item.change.id}#${item.change.id}">Review</a>`;
  return `<details class="review-item change-item" id="${item.change.id}"${focused ? " open" : ""} data-change="${item.change.id}" data-file="${file.id}" data-read="${read}" data-path="${esc(file.path)}" data-description="${esc(member.description)}" data-group-title="${esc(group.title)}" data-signals="${esc(`${group.category} · importance ${group.importance} · complexity ${group.complexity}`)}">${summaryHeader(path, metadata, action)}<div class="item-body"><p class="mobile-meta">${esc(metadata)}</p>${localSignals(group, read ? "read" : "unread")}<div data-review-core><p class="description">${esc(member.description)}</p><p class="range">old ${item.hunk.oldStart},${item.hunk.oldLines} · new ${item.hunk.newStart},${item.hunk.newLines}</p>${diffHtml(item.hunk)}${contextControl(slug, version, item, file)}${readForm(workspaceId, slug, version, item.change.id, read)}</div></div></details>`;
}

function facts(file: StageCaptureFileRow): string {
  const values: [string, string][] = [
    ["status", file.status],
    ["old mode", file.old_mode ?? "not applicable"],
    ["new mode", file.new_mode ?? "not applicable"],
    ["old bytes", file.old_availability],
    ["new bytes", file.new_availability],
  ];
  return `<dl class="fact-list">${values.map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
}

function materialItem(group: StageGroup, member: Extract<StageMember, { type: "material" }>, material: StageIncompleteRow): string {
  const title = material.path ?? material.kind.replaceAll("_", " ");
  const metadata = `${material.side} · ${material.kind.replaceAll("_", " ")}`;
  return `<details class="review-item material-item" id="${member.id}">${summaryHeader(title, metadata, `<span class="item-state">${esc(material.side)}</span>`)}<div class="item-body"><p class="mobile-meta">${esc(metadata)}</p>${localSignals(group, "material")}<p class="description">${esc(member.description)}</p><p class="material-reason">${esc(material.reason)}</p></div></details>`;
}

function fileItem(group: StageGroup, member: Extract<StageMember, { type: "file" }>, file: StageCaptureFileRow): string {
  const path = file.old_path ? `${file.old_path} → ${file.path}` : file.path;
  return `<details class="review-item file-item" id="${member.id}">${summaryHeader(path, file.status)}<div class="item-body"><p class="mobile-meta">${esc(file.status)}</p>${localSignals(group, "file")}<p class="description">${esc(member.description)}</p>${facts(file)}</div></details>`;
}

function treeChangeIds(node: StageTreeNode, fileChanges: Map<string, string[]>): string[] {
  return [
    ...node.files.flatMap((file) => fileChanges.get(file.id) ?? []),
    ...node.folders.flatMap((folder) => treeChangeIds(folder, fileChanges)),
  ];
}

function narrativeAnchors(groups: StageGroup[], inventory: StageCaptureInventory): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const member of groups.flatMap((group) => group.members)) {
    let fileId: string | null = null;
    if (member.type === "change") fileId = inventory.changes.find((change) => change.id === member.id)?.file_id ?? null;
    else if (member.type === "material") {
      const path = inventory.incomplete.find((item) => item.id === member.id)?.path;
      fileId = path ? inventory.files.find((file) => file.path === path)?.id ?? null : null;
    } else fileId = member.id;
    if (fileId && !anchors.has(fileId)) anchors.set(fileId, member.id);
  }
  return anchors;
}

function treeHtml(
  node: StageTreeNode,
  fileChanges: Map<string, string[]>,
  readIds: Set<string>,
  anchors: Map<string, string>,
  focusMode = false,
): string {
  const folders = node.folders.map((folder) => {
    const ids = treeChangeIds(folder, fileChanges);
    const counts = stageTreeStats(folder, fileChanges, readIds);
    return `<details class="tree-folder" data-tree-node data-files="${counts.files}" data-change-ids="${ids.join(",")}"><summary><span class="tree-arrow" aria-hidden="true">›</span><span>${esc(folder.name)}</span><span class="tree-summary" data-tree-summary>${counts.files} files · ${counts.changes} changes · ${counts.unread} unread</span></summary><div class="tree-children">${treeHtml(folder, fileChanges, readIds, anchors, focusMode)}</div></details>`;
  }).join("");
  const files = node.files.map((file) => {
    const ids = fileChanges.get(file.id) ?? [];
    const unread = ids.some((id) => !readIds.has(id));
    const target = anchors.get(file.id) ?? ids[0] ?? file.id;
    const focus = focusMode && ids[0] ? ` data-tree-focus="${ids[0]}"` : "";
    const meta = ids.length > 0 ? `${ids.length} change${ids.length === 1 ? "" : "s"}` : file.status;
    const content = `<span class="tree-file-name">${esc(file.path.split("/").at(-1) ?? file.path)}</span><span class="tree-file-meta">${esc(meta)}</span>`;
    if (focusMode && ids.length === 0) return `<span class="tree-file" data-change-ids="" data-unread="false">${content}</span>`;
    return `<a class="tree-file hoverable" data-tree-file data-change-ids="${ids.join(",")}" data-unread="${unread}"${focus} href="#${target}">${content}</a>`;
  }).join("");
  return folders + files;
}

function groupHtml(
  workspaceId: string,
  slug: string,
  version: number,
  group: StageGroup,
  materialized: Map<string, MaterializedStageChange>,
  inventory: StageCaptureInventory,
  readIds: Set<string>,
  focusId: string | null,
): string {
  const changeIds = group.members.filter((member): member is Extract<StageMember, { type: "change" }> => member.type === "change").map((member) => member.id);
  const read = changeIds.filter((id) => readIds.has(id)).length;
  const members = group.members.map((member) => {
    if (member.type === "change") {
      const item = materialized.get(member.id);
      const file = item && inventory.files.find((candidate) => candidate.id === item.change.file_id);
      if (!item || !file) throw new StageMaterializationError(`Narrative change ${member.id} has no retained material.`);
      return changeItem(workspaceId, slug, version, group, member, item, file, readIds, focusId === member.id);
    }
    if (member.type === "material") {
      const material = inventory.incomplete.find((candidate) => candidate.id === member.id);
      if (!material) throw new StageMaterializationError(`Narrative material ${member.id} is missing.`);
      return materialItem(group, member, material);
    }
    const file = inventory.files.find((candidate) => candidate.id === member.id);
    if (!file) throw new StageMaterializationError(`Narrative file ${member.id} is missing.`);
    return fileItem(group, member, file);
  }).join("");
  return `<section class="group" id="group-${group.id}" data-group="${group.id}" data-change-ids="${changeIds.join(",")}"><header class="group-header"><h2>${esc(group.title)}</h2><div class="group-signals"><span>${esc(group.category)}</span><span class="signal-importance">importance ${esc(group.importance)}</span><span class="signal-complexity">complexity ${esc(group.complexity)}</span><span data-group-progress>${read} / ${changeIds.length} read</span></div></header><div class="group-copy">${markdown(group.explanation)}${group.attention ? `<p class="attention">${esc(group.attention)}</p>` : ""}</div>${group.examples.map((example) => `<figure class="example"><pre><code>${esc(example.code)}</code></pre><figcaption>${esc(example.text)}</figcaption></figure>`).join("")}<div>${members}</div></section>`;
}

function focusDialog(tree: string): string {
  const closeIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
  return `<dialog class="focus-dialog" data-focus-dialog aria-label="Change review"><div class="focus-shell"><header class="focus-header"><button type="button" data-focus-toggle="tree" aria-label="Toggle repository"><span aria-hidden="true">☰</span></button><span class="focus-title" data-focus-title></span><span class="focus-spacer"></span><button type="button" data-focus-toggle="detail" aria-label="Toggle review details"><span aria-hidden="true">◫</span></button><button type="button" data-focus-close aria-label="Close change review">${closeIcon}</button></header><div class="focus-layout" data-focus-layout data-left="open" data-right="open"><aside class="focus-tree" aria-label="Repository">${tree}</aside><main class="focus-center" data-focus-center></main><aside class="focus-detail" aria-label="Review details"><div data-focus-detail-content></div></aside></div><nav class="focus-mobile-bar" aria-label="Focus panels"><button type="button" data-focus-toggle="tree">Repository</button><button type="button" data-focus-toggle="detail">Details</button></nav></div></dialog>`;
}

function storageFailurePage(nav: NavContext, title: string, status: number): Response {
  const message = status === 502 ? "Retained source is temporarily unavailable. Try again." : "Retained source is corrupt. This version cannot be rendered.";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${STAGE_THEME_BOOTSTRAP}</script><style>${STAGE_CSS}</style><title>${esc(title)} · Seer</title></head><body><div class="stage-shell">${appBar(nav)}<main class="stage-header"><h1>${esc(title)}</h1><p>${message}</p></main></div></body></html>`, status);
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
  let changes: MaterializedStageChange[];
  try {
    changes = await materializeCanonicalChanges(inventory, (digest) => loadStageBytes(workspaceId, digest));
  } catch (err) {
    console.error(`[seer] stage ${workspaceId}/${slug}/v/${versionNumber} could not materialize:`, err);
    return storageFailurePage(nav, version.doc.identity.title, err instanceof StageStoreUnavailable ? 502 : 500);
  }

  const readIds = listStageReadChangeIds(workspaceId, version.id, user.id);
  const materialized = new Map(changes.map((item) => [item.change.id, item]));
  const fileChanges = changesByFile(inventory);
  const tree = stageTree(inventory.files);
  const totals = stageTreeStats(tree, fileChanges, readIds);
  const requestedFocus = new URL(req.url).searchParams.get("focus");
  const focusId = requestedFocus && materialized.has(requestedFocus) ? requestedFocus : null;
  let groups: string;
  try {
    groups = version.doc.witness.groups.map((group) => groupHtml(workspaceId, slug, versionNumber, group, materialized, inventory, readIds, focusId)).join("");
  } catch (err) {
    console.error(`[seer] stage ${workspaceId}/${slug}/v/${versionNumber} narrative is inconsistent:`, err);
    return storageFailurePage(nav, version.doc.identity.title, 500);
  }
  const anchors = narrativeAnchors(version.doc.witness.groups, inventory);
  const repository = treeHtml(tree, fileChanges, readIds, anchors);
  const focusRepository = treeHtml(tree, fileChanges, readIds, anchors, true);
  const readCount = changes.filter((item) => readIds.has(item.change.id)).length;
  const versionLinks = Array.from({ length: stage.latest_version }, (_, index) => index + 1).map((number) => `<a href="/${workspaceId}/st/${slug}/v/${number}"${number === versionNumber ? ` aria-current="page"` : ""}>v${number}</a>`).join(" · ");
  const builderContext = version.doc.builder.context.trim() ? `<details><summary>Context</summary>${markdown(version.doc.builder.context)}</details>` : "";
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><script>${STAGE_THEME_BOOTSTRAP}</script><title>${esc(version.doc.identity.title)} · Seer</title><style>${STAGE_CSS}</style></head><body><div class="stage-shell">${appBar(nav)}</div><div class="stage-grid"><header class="stage-header"><p class="stage-context">${esc(version.doc.source.repo)} · ${esc(version.doc.source.branch)}</p><h1>${esc(version.doc.identity.title)}</h1><div class="stage-source"><span>${esc(`${shortSha(version.doc.source.mergeBaseSha)} → ${shortSha(version.doc.source.sourceHeadSha)}`)}</span><span>Version ${versionNumber}${versionNumber === stage.latest_version ? " · latest" : ""}</span></div></header><section class="accounts" aria-label="Accounts"><article class="account">${accountHeading("Builder", version.doc.builder.agent.name, version.doc.builder.agent.model)}<div class="markdown">${markdown(version.doc.builder.intent)}</div>${builderContext}</article><article class="account">${accountHeading("Witness", version.doc.witness.agent.name, version.doc.witness.agent.model)}<div class="markdown">${markdown(version.doc.witness.summary)}</div></article></section></div><div class="stage-grid stage-body"><aside class="repo-rail" data-repo-rail data-open="false"><div class="rail-head"><h2>Repository</h2><button class="icon-button drawer-close" type="button" data-repo-close aria-label="Close repository">Close</button></div><nav aria-label="Changed files">${repository}</nav><p class="progress"><strong data-progress>${readCount} / ${changes.length} read</strong><br>${totals.files} files · ${totals.changes} changes</p></aside><main class="walkthrough">${groups}</main><aside class="version-rail"><h2>Review</h2><p><strong data-progress>${readCount} / ${changes.length} read</strong></p><section><p>${versionLinks}</p></section><section><p>${esc(version.doc.source.repo)}</p><p>${esc(version.doc.source.branch)}</p></section></aside><footer class="terminal"><h2 data-unread-summary>${readCount === changes.length ? "Read" : `${changes.length - readCount} unread`}</h2><p class="terminal-meta">Version ${versionNumber} · ${totals.files} files</p></footer></div><nav class="mobile-bar" aria-label="Stage navigation"><button type="button" data-repo-open>Repository</button><span data-progress>${readCount} / ${changes.length} read</span><span>v${versionNumber}</span></nav><button class="scrim" type="button" data-scrim hidden aria-label="Close repository"></button>${focusDialog(focusRepository)}<script>${STAGE_CLIENT}</script></body></html>`;
  return html(page);
}
