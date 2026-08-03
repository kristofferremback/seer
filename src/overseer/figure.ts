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
/** Commit Mono at 11.5px, measured off the prototype: wide enough that a 40 character
 *  label (the budget) never runs out of its box. */
const CHAR_W = 6.9;
const NODE_MIN_W = 76;

interface Placed {
  id: string;
  label: string;
  muted: boolean;
  x: number;
  y: number;
  w: number;
}

function nodeWidth(label: string): number {
  return Math.max(NODE_MIN_W, Math.round(label.length * CHAR_W) + 20);
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

/** Every node placed, in the order it was authored within its rank. */
function place(figure: Figure): { nodes: Placed[]; width: number; height: number } {
  const rank = ranks(figure);
  const rows = new Map<number, typeof figure.nodes>();
  for (const n of figure.nodes) {
    const r = rank.get(n.id) ?? 0;
    const row = rows.get(r);
    if (row) row.push(n);
    else rows.set(r, [n]);
  }
  const order = [...rows.keys()].sort((a, b) => a - b);
  const nodes: Placed[] = [];
  let width = 0;
  order.forEach((r, i) => {
    const y = PAD + i * (NODE_H + RANK_GAP);
    let x = PAD;
    for (const n of rows.get(r)!) {
      const w = nodeWidth(n.label);
      nodes.push({ id: n.id, label: n.label, muted: n.state === "muted", x, y, w });
      x += w + NODE_GAP;
    }
    width = Math.max(width, x - NODE_GAP);
  });
  const height = PAD * 2 + order.length * NODE_H + Math.max(0, order.length - 1) * RANK_GAP;
  return { nodes, width: width + PAD, height };
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
  const { nodes, width, height } = place(figure);
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
  const labels = edges
    .filter((e) => e.label != null && e.label !== "")
    .map((e) => {
      const a = byId.get(e.from)!;
      const b = byId.get(e.to)!;
      const x = (a.x + a.w / 2 + b.x + b.w / 2) / 2 + 6;
      const y = (a.y + NODE_H + b.y) / 2;
      return `<text class="cap" x="${round(x)}" y="${round(y)}" dy="0.35em">${escapeHtml(e.label)}</text>`;
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
    `<svg class="fig" viewBox="0 0 ${round(width)} ${round(height)}" ` +
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
