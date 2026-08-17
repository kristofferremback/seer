// The one drawing on the page. A figure is a constrained graph the skill authored as
// nodes and edges, and it is laid out here, on the server, into a static SVG. There is
// no diagramming library in the response and no measurement in the browser: the same
// figure produces the same bytes on every render, which is what lets a review be
// compared against itself across versions.
//
// The layout is layered top-down: rank a node one past the deepest node that points at
// it, lay each rank out as a centred row, and order every row below the first by the
// mean centre of its placed parents, so parents and child meet instead of crossing. A
// cycle cannot make the ranking loop forever, because it relaxes a fixed number of
// times and stops.
//
// Edges are drawn the way flow diagrams are read, not the way segments are cheapest:
// each one leaves the bottom of its source, runs orthogonally — down, across the gap,
// down again — through rounded corners, and enters the top of its target under an
// arrowhead. A node with several edges on one side spreads their attachment points
// along that side, so two arrows into one box stay two arrows instead of a bird's
// foot. A label sits on its own horizontal run when the run can hold it, over a patch
// of the figure's own surface so the line visibly passes beneath the words; a label
// whose run is too short sits beside its entry drop, on the outside of the slope. In
// either spot it takes the first position that covers neither a node, a placed label,
// nor another edge's line.
//
// The drawing carries no text of its own that a screen reader could use, so the whole
// figure is one image with a composed label: its nodes, which of them are muted, and
// every edge with the words on it.

import { escapeHtml } from "../escape";
import type { Figure } from "./types";

/** Geometry, in the same units the viewBox is drawn in. */
const PAD = 2;
const NODE_H = 26;
const NODE_GAP = 22;
const RANK_GAP = 40;
/** The gap between ranks when any edge carries words: room for a run to hold its
 *  label, and for a second lane when two runs would otherwise share a line. */
const RANK_GAP_LABELLED = 56;
/** Commit Mono at 11.5px, measured off the prototype: wide enough that a 40 character
 *  label (the budget) never runs out of its box. */
const CHAR_W = 6.9;
/** The cap size edge labels are set at (11px), for the collision boxes below. */
const LABEL_CHAR_W = 6.6;
const LABEL_H = 12;
const NODE_MIN_W = 76;
/** Corner radius of an elbow, and the size of the arrowhead under it. */
const BEND = 6;
const TIP = 3.5;

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

/** Whether any of the polyline's segments passes through the box: sampled, not
 *  solved, because forty points per segment at layout scale cannot miss a 12px-tall
 *  label box. */
function polylineCrosses(box: Box, points: [number, number][]): boolean {
  for (let s = 0; s + 1 < points.length; s++) {
    const [x1, y1] = points[s]!;
    const [x2, y2] = points[s + 1]!;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return true;
    }
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

/** One edge, routed: where it leaves, where it lands, the height of its horizontal
 *  run, and the corner points a crossing test walks. */
interface Routed {
  e: Figure["edges"][number];
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  runY: number;
  muted: boolean;
  points: [number, number][];
}

/** The figure, drawn. One `svg`, no ids inside it, nothing that needs a script. */
export function figureSvg(figure: Figure): string {
  const labelled = figure.edges.some((e) => e.label != null && e.label !== "");
  const rankGap = labelled ? RANK_GAP_LABELLED : RANK_GAP;
  const { nodes, width, height } = place(figure, rankGap);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges = figure.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

  // Attachment points, spread: a node's outgoing edges leave its bottom at evenly
  // spaced points ordered by where they are going, and its incoming edges land on
  // its top the same way. Two arrows into one box stay two arrows.
  const exitX = new Map<Figure["edges"][number], number>();
  const entryX = new Map<Figure["edges"][number], number>();
  for (const n of nodes) {
    const centre = (id: string) => {
      const at = byId.get(id)!;
      return at.x + at.w / 2;
    };
    const out = edges
      .filter((e) => e.from === n.id)
      .sort((a, b) => centre(a.to) - centre(b.to));
    out.forEach((e, i) => exitX.set(e, n.x + (n.w * (i + 1)) / (out.length + 1)));
    const into = edges
      .filter((e) => e.to === n.id)
      .sort((a, b) => centre(a.from) - centre(b.from));
    into.forEach((e, i) => entryX.set(e, n.x + (n.w * (i + 1)) / (into.length + 1)));
  }

  // Routes, with the horizontal runs laned: runs that share a gap and overlap
  // sideways take different heights within it, so no two lines ever lie in each
  // other. Lanes hand out from the middle of the gap.
  const LANES = [0.5, 0.72, 0.28, 0.86, 0.14];
  const routed: Routed[] = [];
  const gaps = new Map<number, { span: [number, number]; lane: number }[]>();
  for (const e of edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const sx = exitX.get(e)!;
    const sy = a.y + NODE_H;
    const tx = entryX.get(e)!;
    const ty = b.y;
    const gapTop = ty - rankGap;
    const span: [number, number] = [Math.min(sx, tx) - 6, Math.max(sx, tx) + 6];
    const inGap = gaps.get(gapTop) ?? [];
    let lane = 0;
    while (
      lane < LANES.length - 1 &&
      inGap.some((have) => have.lane === lane && have.span[0] < span[1] && span[0] < have.span[1])
    )
      lane++;
    inGap.push({ span, lane });
    gaps.set(gapTop, inGap);
    const runY = gapTop + rankGap * LANES[lane]!;
    routed.push({
      e,
      sx,
      sy,
      tx,
      ty,
      runY,
      muted: a.muted || b.muted,
      points: [
        [sx, sy],
        [sx, runY],
        [tx, runY],
        [tx, ty],
      ],
    });
  }

  const lines = routed
    .map((r) => {
      const cls = r.muted ? "fig-edge fig-dim" : "fig-edge";
      const dx = r.tx - r.sx;
      const path =
        Math.abs(dx) < 2
          ? `M${round(r.sx)} ${round(r.sy)}L${round(r.tx)} ${round(r.ty)}`
          : (() => {
              const dir = dx > 0 ? 1 : -1;
              const bend = Math.min(BEND, Math.abs(dx) / 2);
              return (
                `M${round(r.sx)} ${round(r.sy)}` +
                `L${round(r.sx)} ${round(r.runY - bend)}` +
                `Q${round(r.sx)} ${round(r.runY)} ${round(r.sx + dir * bend)} ${round(r.runY)}` +
                `L${round(r.tx - dir * bend)} ${round(r.runY)}` +
                `Q${round(r.tx)} ${round(r.runY)} ${round(r.tx)} ${round(r.runY + bend)}` +
                `L${round(r.tx)} ${round(r.ty)}`
              );
            })();
      // The arrowhead is the entry, said in the line's own stroke: a chevron over
      // the target's top edge, dimmed with its edge when the edge is dimmed.
      const tip =
        `<path class="${r.muted ? "fig-tip fig-dim" : "fig-tip"}" ` +
        `d="M${round(r.tx - TIP)} ${round(r.ty - TIP - 1)}L${round(r.tx)} ${round(r.ty - 0.5)}` +
        `L${round(r.tx + TIP)} ${round(r.ty - TIP - 1)}"/>`;
      return `<path class="${cls}" d="${path}"/>` + tip;
    })
    .join("");

  // Labels. On the run when the run can hold the words; beside the entry drop, on
  // the outside of the slope, when it cannot. Every candidate is tested against the
  // nodes, the labels already placed, and every other edge's line, with air around
  // it, and the first clear spot wins.
  const taken: Box[] = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NODE_H }));
  let widthOut = width;
  const labels = routed
    .filter((r) => r.e.label != null && r.e.label !== "")
    .map((r) => {
      const text = r.e.label!;
      const w = text.length * LABEL_CHAR_W;
      const clear = (box: Box): boolean => {
        if (box.x < 0) return false;
        const roomy: Box = { x: box.x - 4, y: box.y - 3, w: box.w + 8, h: box.h + 6 };
        if (taken.some((have) => boxesOverlap(roomy, have))) return false;
        return !routed.some((other) => other !== r && polylineCrosses(roomy, other.points));
      };
      const runLength = Math.abs(r.tx - r.sx) - 2 * BEND;
      const outside = r.tx >= r.sx;

      type Spot = { x: number; y: number; anchor: "middle" | "start" | "end"; box: Box; onRun: boolean };
      const candidates: Spot[] = [];
      if (runLength >= w + 10) {
        const cx = (r.sx + r.tx) / 2;
        candidates.push({
          x: cx,
          y: r.runY,
          anchor: "middle",
          box: { x: cx - w / 2, y: r.runY - LABEL_H / 2, w, h: LABEL_H },
          onRun: true,
        });
      }
      const beside = (x: number, y: number, right: boolean): Spot => ({
        x: right ? x + 7 : x - 7,
        y,
        anchor: right ? "start" : "end",
        box: { x: right ? x + 7 : x - 7 - w, y: y - LABEL_H / 2, w, h: LABEL_H },
        onRun: false,
      });
      const entryY = (r.runY + r.ty) / 2;
      const exitY = (r.sy + r.runY) / 2;
      candidates.push(
        beside(r.tx, entryY, outside),
        beside(r.tx, entryY, !outside),
        beside(r.sx, exitY, outside),
        beside(r.sx, exitY, !outside),
      );
      const spot = candidates.find((c) => clear(c.box)) ?? candidates[candidates.length > 1 ? 1 : 0]!;

      taken.push(spot.box);
      widthOut = Math.max(widthOut, spot.box.x + spot.box.w + PAD);
      // On the run, the words take a patch of the figure's own surface, so the line
      // is seen to pass beneath them rather than through them.
      const backing = spot.onRun
        ? `<rect class="fig-mat" x="${round(spot.box.x - 4)}" y="${round(spot.box.y - 2)}" ` +
          `width="${round(spot.box.w + 8)}" height="${round(spot.box.h + 4)}"/>`
        : "";
      return (
        backing +
        `<text class="cap" x="${round(spot.x)}" y="${round(spot.y)}" dy="0.35em"` +
        (spot.anchor === "start" ? "" : ` text-anchor="${spot.anchor}"`) +
        `>${escapeHtml(text)}</text>`
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
    // one, printing its 11.5px labels at poster scale. The floor is the same idea
    // from the other side: shrinking scales the labels with the drawing, and past
    // 78% of drawn size the 11.5px type drops under 9px and stops being text. A
    // column narrower than that pans the figure instead of shrinking it further.
    `<svg class="fig" style="max-width:${round(widthOut)}px;min-width:${round(widthOut * 0.78)}px" ` +
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
