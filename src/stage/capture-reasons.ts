// Human capture reasons stay in StageDoc and SQLite exactly as written. This module also
// gives the acknowledgement engine a typed identity for the production forms whose
// variable counts or error messages must not decide carry.

export type TreeSide = "old" | "new";
export type TreeSnapshotSide = "old" | "new" | "merge-base" | "source";

export type CaptureReasonClass =
  | "tree_snapshot_old"
  | "tree_snapshot_new"
  | "tree_path_old"
  | "tree_path_new"
  | "retained_text_insufficient"
  | "compare_lines_unrepresented"
  | "compare_lines_alignment_limit"
  | "pinned_diff_over_budget"
  | "pinned_diff_fetch_failure"
  | "compare_file_ceiling";

const COMPARE_REPORTS = "GitHub compare reports ";
const ADDITIONS_AND = " additions and ";
const UNREPRESENTED_LINE_CHANGES = " deletions, but the canonical patch and retained textual sides could not represent those line changes.";
const ALIGNMENT_LIMIT = " Text reconstruction exceeds the ";
const ALIGNMENT_LIMIT_END = "-line alignment limit.";
const PINNED_DIFF_FETCH_FAILURE = "GitHub did not provide the pinned unified compare diff: ";
const PINNED_DIFF_SIZE = "The pinned unified compare diff is ";
const PINNED_DIFF_BUDGET = " logical bytes, over the ";
const PINNED_DIFF_BUDGET_END = "-byte capture budget.";

export const RETAINED_TEXTUAL_SIDES_INSUFFICIENT = "Retained textual sides were not sufficient to reconstruct line changes.";
export const GITHUB_COMPARE_FILE_CEILING = "GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist.";

export function treeSnapshotTruncatedReason(side: TreeSnapshotSide): string {
  return `GitHub truncated the ${side} commit tree; the path inventory is incomplete.`;
}

export function treePathTruncatedReason(side: TreeSide): string {
  return `The ${side} tree was truncated before this path could be established.`;
}

export function compareLineChangesReason(additions: number, deletions: number, alignmentLimit?: number): string {
  const reason = `${COMPARE_REPORTS}${additions}${ADDITIONS_AND}${deletions}${UNREPRESENTED_LINE_CHANGES}`;
  return alignmentLimit === undefined ? reason : `${reason}${ALIGNMENT_LIMIT}${alignmentLimit}${ALIGNMENT_LIMIT_END}`;
}

export function pinnedDiffFetchFailureReason(message: string): string {
  return `${PINNED_DIFF_FETCH_FAILURE}${message}`;
}

export function pinnedDiffOverBudgetReason(bytes: number, limit: number): string {
  return `${PINNED_DIFF_SIZE}${bytes}${PINNED_DIFF_BUDGET}${limit}${PINNED_DIFF_BUDGET_END}`;
}

function numeric(value: string): boolean {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) && String(parsed) === value;
}

function compareReasonClass(reason: string): CaptureReasonClass | null {
  if (!reason.startsWith(COMPARE_REPORTS)) return null;
  const additionsEnd = reason.indexOf(ADDITIONS_AND, COMPARE_REPORTS.length);
  if (additionsEnd < 0 || !numeric(reason.slice(COMPARE_REPORTS.length, additionsEnd))) return null;
  const deletionsEnd = reason.indexOf(UNREPRESENTED_LINE_CHANGES, additionsEnd + ADDITIONS_AND.length);
  if (deletionsEnd < 0 || !numeric(reason.slice(additionsEnd + ADDITIONS_AND.length, deletionsEnd))) return null;
  const suffix = reason.slice(deletionsEnd + UNREPRESENTED_LINE_CHANGES.length);
  if (suffix === "") return "compare_lines_unrepresented";
  if (!suffix.startsWith(ALIGNMENT_LIMIT) || !suffix.endsWith(ALIGNMENT_LIMIT_END)) return null;
  const limit = suffix.slice(ALIGNMENT_LIMIT.length, -ALIGNMENT_LIMIT_END.length);
  return numeric(limit) ? "compare_lines_alignment_limit" : null;
}

function singleReasonClass(reason: string): CaptureReasonClass | null {
  if (reason === RETAINED_TEXTUAL_SIDES_INSUFFICIENT) return "retained_text_insufficient";
  if (reason === GITHUB_COMPARE_FILE_CEILING) return "compare_file_ceiling";
  if (reason.startsWith(PINNED_DIFF_FETCH_FAILURE)) return "pinned_diff_fetch_failure";
  if (reason.startsWith(PINNED_DIFF_SIZE) && reason.endsWith(PINNED_DIFF_BUDGET_END)) {
    const budgetAt = reason.indexOf(PINNED_DIFF_BUDGET, PINNED_DIFF_SIZE.length);
    if (budgetAt > 0 && numeric(reason.slice(PINNED_DIFF_SIZE.length, budgetAt)) &&
        numeric(reason.slice(budgetAt + PINNED_DIFF_BUDGET.length, -PINNED_DIFF_BUDGET_END.length))) {
      return "pinned_diff_over_budget";
    }
  }
  const compared = compareReasonClass(reason);
  if (compared) return compared;

  // Existing captures have used old/new labels for these snapshot facts. The writer's
  // merge-base/source labels mean the same two sides and retain their original prose.
  if (reason === treeSnapshotTruncatedReason("old") || reason === treeSnapshotTruncatedReason("merge-base")) return "tree_snapshot_old";
  if (reason === treeSnapshotTruncatedReason("new") || reason === treeSnapshotTruncatedReason("source")) return "tree_snapshot_new";
  return null;
}

/** Classify only prose emitted by the production capture writer. A path-truncation reason
 * may be followed by a compare failure, so both failure classes remain in the identity. */
export function captureReasonClasses(reason: string): readonly CaptureReasonClass[] | null {
  for (const side of ["old", "new"] as const) {
    const pathReason = treePathTruncatedReason(side);
    if (reason === pathReason) return [side === "old" ? "tree_path_old" : "tree_path_new"];
    if (reason.startsWith(`${pathReason} `)) {
      const rest = singleReasonClass(reason.slice(pathReason.length + 1));
      return rest ? [side === "old" ? "tree_path_old" : "tree_path_new", rest] : null;
    }
  }
  const single = singleReasonClass(reason);
  return single ? [single] : null;
}

export function captureReasonIdentity(reason: string): string {
  const classes = captureReasonClasses(reason);
  return classes ? `[capture:${classes.join("+")}]` : "";
}
