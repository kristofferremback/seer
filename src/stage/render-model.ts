import type { Hunk, HunkLine } from "../overseer/types";
import type { StageCaptureFileRow, StageCaptureInventory } from "./db";

export interface StageTreeNode {
  name: string;
  path: string;
  folders: StageTreeNode[];
  files: StageCaptureFileRow[];
}

export interface StageTreeStats {
  files: number;
  changes: number;
  unread: number;
}

function codePointOrder(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

interface MutableTree {
  name: string;
  path: string;
  folders: Map<string, MutableTree>;
  files: StageCaptureFileRow[];
}

export function stageTree(files: StageCaptureFileRow[]): StageTreeNode {
  const root: MutableTree = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const name of parts.slice(0, -1)) {
      let child = node.folders.get(name);
      if (!child) {
        const path = node.path ? `${node.path}/${name}` : name;
        child = { name, path, folders: new Map(), files: [] };
        node.folders.set(name, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const freeze = (node: MutableTree): StageTreeNode => ({
    name: node.name,
    path: node.path,
    folders: [...node.folders.values()].sort((a, b) => codePointOrder(a.name, b.name)).map(freeze),
    files: [...node.files].sort((a, b) => codePointOrder(a.path, b.path)),
  });
  return freeze(root);
}

export function changesByFile(inventory: StageCaptureInventory): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const change of inventory.changes) {
    result.set(change.file_id, [...(result.get(change.file_id) ?? []), change.id]);
  }
  return result;
}

export function stageTreeStats(
  node: StageTreeNode,
  fileChanges: Map<string, string[]>,
  readIds: Set<string>,
): StageTreeStats {
  const result = { files: node.files.length, changes: 0, unread: 0 };
  for (const file of node.files) {
    const ids = fileChanges.get(file.id) ?? [];
    result.changes += ids.length;
    result.unread += ids.filter((id) => !readIds.has(id)).length;
  }
  for (const folder of node.folders) {
    const child = stageTreeStats(folder, fileChanges, readIds);
    result.files += child.files;
    result.changes += child.changes;
    result.unread += child.unread;
  }
  return result;
}

export interface SplitDiffRow {
  old: HunkLine | null;
  newer: HunkLine | null;
}

/** Pair each non-context run without inventing line alignment. */
export function splitDiffRows(hunk: Hunk): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  for (let index = 0; index < hunk.lines.length;) {
    const line = hunk.lines[index]!;
    if (line.kind === "ctx") {
      rows.push({ old: line, newer: line });
      index++;
      continue;
    }
    const removed: HunkLine[] = [];
    const added: HunkLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index]!.kind !== "ctx") {
      const changed = hunk.lines[index++]!;
      (changed.kind === "del" ? removed : added).push(changed);
    }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
      rows.push({ old: removed[pair] ?? null, newer: added[pair] ?? null });
    }
  }
  return rows;
}
