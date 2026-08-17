// The one drawing on the page. A figure is a constrained graph the skill authored as
// nodes and edges, and it is laid out here, on the server, into a static SVG. There is
// no diagramming library in the response and no measurement in the browser: the same
// figure produces the same bytes on every render, which is what lets a review be
// compared against itself across versions.
//
// The layout is layered top-down, the way the prototype's flow reads: rank a node one
// past the deepest node that points at it, lay each rank out as a row, and draw every
// edge as a line from the bottom of its source to the top of its target. A cycle
// cannot make this loop forever, because the ranking relaxes a fixed number of times
// and stops.
//
// Three placement rules keep a real graph legible rather than merely drawn, and all
// three are deterministic. Rows are centred on the widest row, so a lone child sits
// under its parents instead of flushing left. Within a row below the first, nodes
// order by the mean centre of the placed nodes pointing at them, so two parents and
// their child form a V rather than a crossing. And an edge label takes the first spot
// along its own edge where it covers neither a node nor a label already placed, so two
// labels sharing a gap never print over each other.
//
// The drawing carries no text of its own that a screen reader could use, so the whole
// figure is one image with a composed label: its nodes, which of them are muted, and
// every edge with the words on it.

import { escapeHtml } from "../escape";
import type { Figure } from "./types";

/** Geometry, in the same units the viewBox is drawn in. */
const PAD = 2;
const NODE_H = 26;
const NODE_GAP = 18;
const RANK_GAP = 34;
/** The gap between ranks when any edge carries words: room for a label to sit beside
 *  its line, and for a second label to take a different spot along its own edge. */
const RANK_GAP_LABELLED = 46;
/** Commit Mono at 11.5px, measured off the prototype: wide enough that a 40 character
 *  label (the budget) never runs out of its box. */
const CHAR_W = 6.9;
/** The cap size edge labels are set at (11px), for the collision boxes below. */
const LABEL_CHAR_W = 6.6;
const LABEL_H = 12;
const NODE_MIN_W = 76;

interface Placed {
  id: string;
  label: string;
  muted: boolean;
  x: number;
  y: number;
  w: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function nodeWidth(label: string): number {
  return Math.max(NODE_MIN_W, Math.round(label.length * CHAR_W) + 20);
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether the segment from (x1,y1) to (x2,y2) passes through the box: sampled, not
 *  solved, because forty points at layout scale cannot miss a 12px-tall label box. */
function segmentCrosses(box: Box, x1: number, y1: number, x2: number, y2: number): boolean {
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return true;
  }
  return false;
}

/**
 * A node sits one rank below the deepest node with an edge into it. Relaxing every
 * edge once per node is enough to settle a directed acyclic graph, and it is also the
 * stopping rule: a cycle simply stops climbing rather than running away.
 */
function ranks(figure: Figure): Map<string, number> {
  const rank = new Map<string, number>();
  for (const n of figure.nodes) rank.set(n.id, 0);
  const edges = figure.edges.filter((e) => rank.has(e.from) && rank.has(e.to));
  for (let pass = 0; pass < figure.nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const want = rank.get(e.from)! + 1;
      if (want > rank.get(e.to)!) {
        rank.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rank;
}

/** Every node placed: rows centred on the widest row, each row below the first
 *  ordered by the mean centre of its placed parents so edges converge instead of
 *  crossing, ties broken by authored order so the layout is stable. */
function place(figure: Figure, rankGap: number): {
  nodes: Placed[];
  width: number;
  height: number;
} {
  const rank = ranks(figure);
  const rows = new Map<number, { node: Figure["nodes"][number]; authored: number }[]>();
  figure.nodes.forEach((node, authored) => {
    const r = rank.get(node.id) ?? 0;
    const row = rows.get(r);
    if (row) row.push({ node, authored });
    else rows.set(r, [{ node, authored }]);
  });
  const order = [...rows.keys()].sort((a, b) => a - b);

  const rowWidth = (row: { node: Figure["nodes"][number] }[]) =>
    row.reduce((w, { node }) => w + nodeWidth(node.label), 0) +
    NODE_GAP * Math.max(0, row.length - 1);
  const widest = Math.max(...order.map((r) => rowWidth(rows.get(r)!)), 0);

  const placed = new Map<string, Placed>();
  const nodes: Placed[] = [];
  order.forEach((r, i) => {
    const row = rows.get(r)!;
    // Below the first row, a node is pulled under the placed nodes that point at it.
    const pull = (id: string): number | null => {
      const parents = figure.edges
        .filter((e) => e.to === id && placed.has(e.from))
        .map((e) => placed.get(e.from)!)
        .map((p) => p.x + p.w / 2);
      if (parents.length === 0) return null;
      return parents.reduce((a, b) => a + b, 0) / parents.length;
    };
    const ordered =
      i === 0
        ? row
        : [...row].sort((a, b) => {
            const pa = pull(a.node.id);
            const pb = pull(b.node.id);
            if (pa !== null && pb !== null && pa !== pb) return pa - pb;
            if (pa === null && pb !== null) return 1;
            if (pa !== null && pb === null) return -1;
            return a.authored - b.authored;
          });
    const y = PAD + i * (NODE_H + rankGap);
    let x = PAD + (widest - rowWidth(row)) / 2;
    for (const { node } of ordered) {
      const w = nodeWidth(node.label);
      const at = { id: node.id, label: node.label, muted: node.state === "muted", x, y, w };
      nodes.push(at);
      placed.set(node.id, at);
      x += w + NODE_GAP;
    }
  });
  const height = PAD * 2 + order.length * NODE_H + Math.max(0, order.length - 1) * rankGap;
  return { nodes, width: PAD * 2 + widest, height };
}

/** The sentence a screen reader is handed instead of the drawing. */
export function figureLabel(figure: Figure): string {
  const byId = new Map(figure.nodes.map((n) => [n.id, n.label] as const));
  const nodes = figure.nodes
    .map((n) => (n.state === "muted" ? `${n.label} (muted)` : n.label))
    .join(", ");
  // The same edges the drawing keeps: the label never announces an arrow the sighted
  // reader cannot see.
  const edges = figure.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      return e.label == null || e.label === "" ? `${from} to ${to}` : `${from} to ${to}, ${e.label}`;
    })
    .join(". ");
  const head = nodes === "" ? "A flow figure with no nodes." : `A flow figure: ${nodes}.`;
  return edges === "" ? head : `${head} ${edges}.`;
}

/** The figure, drawn. One `svg`, no ids inside it, nothing that needs a script. */
export function figureSvg(figure: Figure): string {
  const labelled = figure.edges.some((e) => e.label != null && e.label !== "");
  const rankGap = labelled ? RANK_GAP_LABELLED : RANK_GAP;
  const { nodes, width, height } = place(figure, rankGap);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  const edges = figure.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const lines = edges
    .map((e) => {
      const a = byId.get(e.from)!;
      const b = byId.get(e.to)!;
      const x1 = a.x + a.w / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const cls = a.muted || b.muted ? "fig-edge fig-dim" : "fig-edge";
      return `<path class="${cls}" d="M${x1} ${y1}L${x2} ${y2}"/>`;
    })
    .join("");

  // A label sits beside its own edge, at the first spot along it where it covers
  // neither a node nor a label already placed. Candidates walk out from the middle;
  // each is tried to the right of the line, then to the left. When every spot is
  // taken the middle-right stands, which is the old behaviour and cannot regress.
  const taken: Box[] = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NODE_H }));
  const segments = edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    return { e, x1: a.x + a.w / 2, y1: a.y + NODE_H, x2: b.x + b.w / 2, y2: b.y };
  });
  let widthOut = width;
  const labels = edges
    .filter((e) => e.label != null && e.label !== "")
    .map((e) => {
      const a = byId.get(e.from)!;
      const b = byId.get(e.to)!;
      const x1 = a.x + a.w / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const w = e.label!.length * LABEL_CHAR_W;
      // A label leans to the outside of its own slope — left of a line going down-left,
      // right of one going down-right — so two edges leaving one node in a V carry
      // their words away from each other instead of into the middle they share.
      const sides = x2 < x1 ? [true, false] : [false, true];
      let spot: { box: Box; x: number; y: number; end: boolean } | null = null;
      for (const t of [0.5, 0.34, 0.66, 0.22, 0.78]) {
        const px = x1 + (x2 - x1) * t;
        const py = y1 + (y2 - y1) * t;
        for (const end of sides) {
          const box: Box = {
            x: end ? px - 6 - w : px + 6,
            y: py - LABEL_H / 2,
            w,
            h: LABEL_H,
          };
          if (box.x < 0) continue;
          // Tested with air around it: a label that only just misses its neighbour
          // still reads as printed over it at this size.
          const roomy: Box = { x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 };
          if (taken.some((have) => boxesOverlap(roomy, have))) continue;
          // Nor across another edge's line: words on a line are words that cannot be
          // told apart from it. The label's own line is exempt — the 6px offset
          // already holds the text beside it.
          if (
            segments.some(
              (s) => s.e !== e && segmentCrosses(roomy, s.x1, s.y1, s.x2, s.y2),
            )
          )
            continue;
          spot = { box, x: end ? px - 6 : px + 6, y: py, end };
          break;
        }
        if (spot) break;
      }
      if (!spot) {
        // Every spot is taken: the middle on the slope's own side stands, which is
        // no worse than the layout that had no collision rule at all.
        const px = x1 + (x2 - x1) / 2;
        const py = y1 + (y2 - y1) / 2;
        const end = x2 < x1 && px - 6 - w >= 0;
        spot = {
          box: { x: end ? px - 6 - w : px + 6, y: py - LABEL_H / 2, w, h: LABEL_H },
          x: end ? px - 6 : px + 6,
          y: py,
          end,
        };
      }
      taken.push(spot.box);
      widthOut = Math.max(widthOut, spot.box.x + spot.box.w + PAD);
      return (
        `<text class="cap" x="${round(spot.x)}" y="${round(spot.y)}" dy="0.35em"` +
        `${spot.end ? ' text-anchor="end"' : ""}>${escapeHtml(e.label!)}</text>`
      );
    })
    .join("");

  const boxes = nodes
    .map((n) => {
      const cls = n.muted ? "fig-box fig-dim" : "fig-box";
      return (
        `<rect class="${cls}" x="${round(n.x)}" y="${round(n.y)}" width="${round(n.w)}" ` +
        `height="${NODE_H}" rx="4"/>` +
        `<text${n.muted ? ' class="dim"' : ""} x="${round(n.x + n.w / 2)}" ` +
        `y="${round(n.y + NODE_H / 2)}" dy="0.35em" text-anchor="middle">${escapeHtml(n.label)}</text>`
      );
    })
    .join("");

  return (
    // Capped at its own drawn size: the stylesheet lets a figure shrink to a narrow
    // column, and without this cap it also stretched a small drawing to fill a wide
    // one, printing its 11.5px labels at poster scale.
    `<svg class="fig" style="max-width:${round(widthOut)}px" ` +
    `viewBox="0 0 ${round(widthOut)} ${round(height)}" ` +
    `role="img" aria-label="${escapeHtml(figureLabel(figure))}">` +
    lines +
    boxes +
    labels +
    `</svg>`
  );
}

/** Coordinates are bytes in a cached page, so they are rounded rather than left to
 *  whatever a float prints as. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
