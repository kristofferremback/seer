// Paging a stack's focus stream, from retained rows only.
//
// A unit is indivisible: one member account group as a stack group references it, or one
// evidence seam of one member. Units fill pages greedily under two row-derived bounds,
// canonical changes and old plus new hunk lines summed over `stage_capture_changes`.
// Neither needs a blob, so a page count is a query and `?page=3` never materializes pages
// 1 and 2.
//
// A unit larger than either bound is served alone and marked over budget. The 4 MiB HTML
// limit in stack-render remains the final byte boundary and links every item through the
// exact member group or evidence seam that owns it.

import { MAX_STACK_PAGE_CHANGES, MAX_STACK_PAGE_HUNK_LINES } from "./stack-types";

export interface StackUnit {
  /** Stable across requests: `l<pos>-<member group id>` or `l<pos>-<seam id>`. */
  key: string;
  position: number;
  memberGroupId: string;
  /** Namespaced change ids, in the member group's own order. */
  changeIds: string[];
  /** Σ (old_lines + new_lines) over those changes. */
  hunkLines: number;
}

export interface StackPageUnit {
  unit: StackUnit;
  changeIds: string[];
  /** Retained for the shared reader page shape. Stack units are never split. */
  part: null;
}

export interface StackPagePlan {
  pages: StackPageUnit[][];
  /** One-based pages whose single unit exceeds either row bound. */
  overBudget: Set<number>;
}

/** Greedy fill in unit order. An oversized unit closes the open page, occupies one page
 * by itself, and remains whole so its witness group never separates from its evidence. */
export function stackPages(units: StackUnit[]): StackPagePlan {
  const pages: StackPageUnit[][] = [];
  const overBudget = new Set<number>();
  let open: StackPageUnit[] = [];
  let openChanges = 0;
  let openLines = 0;
  const close = (): void => {
    if (open.length > 0) pages.push(open);
    open = [];
    openChanges = 0;
    openLines = 0;
  };
  for (const unit of units) {
    const oversized = unit.changeIds.length > MAX_STACK_PAGE_CHANGES || unit.hunkLines > MAX_STACK_PAGE_HUNK_LINES;
    if (oversized) {
      close();
      pages.push([{ unit, changeIds: unit.changeIds, part: null }]);
      overBudget.add(pages.length);
      continue;
    }
    if (open.length > 0 && (openChanges + unit.changeIds.length > MAX_STACK_PAGE_CHANGES || openLines + unit.hunkLines > MAX_STACK_PAGE_HUNK_LINES)) close();
    open.push({ unit, changeIds: unit.changeIds, part: null });
    openChanges += unit.changeIds.length;
    openLines += unit.hunkLines;
  }
  close();
  if (pages.length === 0) pages.push([]);
  return { pages, overBudget };
}
