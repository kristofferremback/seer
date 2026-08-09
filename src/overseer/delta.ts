// The delta engine: what moved between two published versions of one review.
//
// Until now the page could only say "version 4" and leave a reader to find the
// change themselves. This module computes it instead, at word level, over the
// two stored documents. Nothing here is authored: the skill may not write an
// `edited` status label, and no other code path may emit one, because a status
// label typed rather than derived is a claim the page cannot check.
//
// WHAT IS DIFFED
//
// Every authored field, plus the one derived prose field the page shows whole:
// the review title, attributed author intent and summary, code-design placement,
// module and coverage prose, a statement's line and body, a note's line, body and
// checks, a group's title and paragraph, a pull request's gist and detail, and the
// pull request description GitHub holds. Authorship also reaches
// into evidence, and it is diffed there too: an example's code and caption, an
// attachment's alt text and caption, a bundle's caption, and a figure's node and
// edge labels. Snippets, hunks, payload sides and every other quoted thing are
// citations rather than authorship, and they move whenever the source moves, so
// nothing is ever marked inside one.
//
// Two fields are neither prose nor a citation and are compared anyway, because a
// reader who came back for what moved would otherwise miss them: an entity's kind,
// which draws the row's icon, and a group's file list, which is the partition of
// the diff that group claims. Both are compared as the words they are, so both
// carry a mark like anything else.
//
// A pull request also carries a head sha. That is not prose and gets no word
// marks; when it moves between versions the pull request is marked `code moved`,
// which is the only honest thing the document knows about a diff it no longer holds.
//
// MATCHING
//
// Stable ids match first. Witnesses can still rename an id while refining the same
// section, so unmatched entities get a conservative second pass over their heading,
// authored body, and code names. Exact or strong rough matches are compared
// field by field; weak matches remain honestly new and removed. Reordering never
// breaks an identity, and a true removal remembers the next surviving section so its
// quiet stub stays near the place it left.
//
// TOKENS AND THE THRESHOLD
//
// A field is diffed as the HTML the page will actually show, scanned into tags,
// whitespace runs and words, with only words compared, so a tag boundary never
// shifts an alignment. Changed density is retained as a measurement for tests and
// diagnostics, but it never changes the visual grammar: every redline appears only
// after its explicit edited control is checked.
//
// Only words are compared, which is also the limit of what this can see: an edit
// that moves markup without moving a word, a phrase that became code or emphasis,
// or a link retargeted under unchanged link text, produces no field, no mark and no
// status label. Nothing false is claimed, but nothing is claimed at all, and a reader
// who came back for what moved will not learn it here.
//
// The word-level machinery is ported from the prototype's `_delta.ts`. What is
// not ported is its scanner: that one recovered structure by reading HTML back,
// and here the structure is the document.

import { escapeHtml } from "../escape";
import type { ReviewDoc } from "./db";
import { exampleBodyHtml, safeBlock, safeInline } from "./render-evidence";
import { prKey, type Annotation, type Evidence } from "./types";

/** Past this many words on either side a field is not aligned at all. The
 *  alignment is quadratic in both time and memory, and the one field with no
 *  authored budget behind it is the pull request description GitHub holds, which
 *  runs to tens of thousands of characters. Past the ceiling the field is
 *  republished whole, which is what a reader of a rewritten essay wants anyway. */
export const MAX_DIFF_WORDS = 2000;

export type DeltaEntityKind =
  | "review"
  | "intent"
  | "summary"
  | "design"
  | "module"
  | "coverage"
  | "statement"
  | "note"
  | "group"
  | "pr";
export type DeltaStatus = "new" | "revised" | "removed";

/** A run of base words replaced by a run of current words. Indices are word
 *  offsets into each side's token stream, half-open on the right. */
export interface Region {
  d0: number;
  d1: number;
  c0: number;
  c1: number;
}

/** One authored field that moved, as aligned word regions on both sides. */
export interface FieldDelta {
  /** Field name, unique within its entity. */
  field: string;
  /** True when the rendered field must remain inline. */
  inline: boolean;
  regions: Region[];
  /** The base side's words, in order. */
  priorWords: string[];
  /** Share of words moved, 0..1. */
  density: number;
}

export interface EntityDelta {
  kind: DeltaEntityKind;
  id: string;
  status: DeltaStatus;
  /** Empty for a removed entity: what changed is that it is gone. */
  fields: FieldDelta[];
  /** Set on a removed entity: its former content, as the markup the base version
   *  showed, so the stub holds everything that version said in the shape it said
   *  it. The markup is what `safeInline` and `safeBlock` already sanitised. */
  former: { head: string; body: string[] } | null;
  /** Set on a removed entity that had a kind: the icon its stub still deserves. */
  formerKind: string | null;
  /** Set on a pull request whose head sha moved between the two versions. */
  codeMoved: boolean;
  /** Current entity that followed this one in the base ordering. Removed entities
   *  use it to keep their collapsed stub near the place it left. */
  insertBefore?: string | null;
}

export interface Delta {
  /** Every entity that moved, in document order. */
  entities: EntityDelta[];
  /** Annotation ids that were open at the base and are answered now. */
  answered: string[];
}

/** One side of a comparison: a stored version plus the annotations as they stood
 *  when that version was the one being read. */
export interface DeltaSide {
  doc: ReviewDoc;
  annotations: Annotation[];
}

// ---- tokens ----

type Tok = { t: "tag" | "ws" | "w"; raw: string; s: number; e: number };

export function tokens(h: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < h.length) {
    if (h[i] === "<") {
      const j = h.indexOf(">", i);
      const e = j < 0 ? h.length : j + 1;
      out.push({ t: "tag", raw: h.slice(i, e), s: i, e });
      i = e;
    } else if (/\s/.test(h[i]!)) {
      let j = i;
      while (j < h.length && /\s/.test(h[j]!)) j++;
      out.push({ t: "ws", raw: h.slice(i, j), s: i, e: j });
      i = j;
    } else {
      let j = i;
      while (j < h.length && !/\s/.test(h[j]!) && h[j] !== "<") j++;
      out.push({ t: "w", raw: h.slice(i, j), s: i, e: j });
      i = j;
    }
  }
  return out;
}

const wordToks = (h: string) => tokens(h).filter((t) => t.t === "w");

/** The words of a fragment of markup, as plain text. */
export function textOf(h: string): string {
  return wordToks(h)
    .map((t) => t.raw)
    .join(" ");
}

// ---- diffs ----

type Op = { t: "=" | "-" | "+"; i: number; j: number };

/** A longest-common-subsequence alignment of two word lists. */
export function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[at(i, j)] =
        a[i] === b[j]
          ? dp[at(i + 1, j + 1)]! + 1
          : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "=", i, j });
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) {
      ops.push({ t: "-", i, j });
      i++;
    } else {
      ops.push({ t: "+", i, j });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", i: i++, j });
  while (j < m) ops.push({ t: "+", i, j: j++ });
  return ops;
}

/** The alignment collapsed into runs: each region is one contiguous stretch of
 *  base words replaced by one contiguous stretch of current words. */
export function regions(ops: Op[]): Region[] {
  const out: Region[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === "=") {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && ops[k]!.t !== "=") k++;
    const run = ops.slice(start, k);
    const dels = run.filter((o) => o.t === "-");
    const inss = run.filter((o) => o.t === "+");
    out.push({
      d0: dels.length ? dels[0]!.i : run[0]!.i,
      d1: dels.length ? dels[dels.length - 1]!.i + 1 : run[0]!.i,
      c0: inss.length ? inss[0]!.j : run[0]!.j,
      c1: inss.length ? inss[inss.length - 1]!.j + 1 : run[0]!.j,
    });
  }
  return out.filter((r) => r.d1 > r.d0 || r.c1 > r.c0);
}

/** The words of a fragment, plus how many tags stand before each of them. Two
 *  words with the same count have no tag between them, which is the only question
 *  the marker asks, so it is answered in constant time rather than by scanning. */
interface WordIndex {
  words: Tok[];
  tagsBefore: Int32Array;
}

function wordIndex(html: string): WordIndex {
  const words: Tok[] = [];
  const before: number[] = [];
  let tags = 0;
  for (const t of tokens(html)) {
    if (t.t === "tag") tags++;
    else if (t.t === "w") {
      words.push(t);
      before.push(tags);
    }
  }
  return { words, tagsBefore: Int32Array.from(before) };
}

/** A run of current words is only wrappable in place when no tag sits inside it. */
function contiguous(ix: WordIndex, c0: number, c1: number): boolean {
  return ix.tagsBefore[c1 - 1] === ix.tagsBefore[c0];
}

/**
 * Diff one field, as the markup the page shows it as. Returns null when nothing
 * moved. A base side of `""` means the field is new, and then every word is an
 * insertion with no prior text behind it.
 */
export function diffField(
  field: string,
  inline: boolean,
  priorHtml: string,
  currentHtml: string,
): FieldDelta | null {
  const pw = wordToks(priorHtml).map((t) => t.raw);
  const ix = wordIndex(currentHtml);
  const cw = ix.words.map((t) => t.raw);
  if (pw.join(" ") === cw.join(" ")) return null;

  // Too long to align. The field is republished whole as one region.
  if (pw.length > MAX_DIFF_WORDS || cw.length > MAX_DIFF_WORDS) {
    return {
      field,
      inline,
      regions: [{ d0: 0, d1: pw.length, c0: 0, c1: cw.length }],
      priorWords: pw,
      density: 1,
    };
  }

  const regs = regions(lcsOps(pw, cw));
  const moved = regs.reduce((a, r) => a + (r.d1 - r.d0) + (r.c1 - r.c0), 0);
  const density = moved / Math.max(1, Math.max(pw.length, cw.length));
  return { field, inline, regions: regs, priorWords: pw, density };
}

// ---- entities ----

/** One comparable field. `stub` is whether a removed entity carries it out in its
 *  former body: the prose it held belongs there, an icon's name does not. */
type FieldSpec = { field: string; inline: boolean; html: string; stub: boolean };

const spec = (field: string, inline: boolean, html: string, stub = true): FieldSpec => ({
  field,
  inline,
  html,
  stub,
});

/** The authored fields inside evidence, in the order the blocks are drawn. A ref,
 *  a payload and a hunk are quotations and carry none. The index is part of the
 *  name because evidence is an ordered list with no ids of its own, which is the
 *  same handle a note's checks are compared by. */
function evidenceFields(evidence: Evidence[]): FieldSpec[] {
  const out: FieldSpec[] = [];
  evidence.forEach((e, i) => {
    const p = `ev-${i}`;
    // A field a stored document does not carry gets no spec at all: an absent
    // optional (or pre-rule) field is not a revision target and must not crash
    // the walk. String(x ?? "") never reaches here for those.
    const push = (name: string, inline: boolean, value: string | null | undefined, html?: string) => {
      if (value == null) return;
      out.push(spec(name, inline, html ?? safeInline(value)));
    };
    switch (e.type) {
      case "example":
        // Same lang the renderer draws it with, or the delta would compare markup
        // against markup the page never shows.
        push(`${p}-text`, false, e.example.text, exampleBodyHtml(e.example.text, e.example.lang));
        push(`${p}-caption`, true, e.example.caption);
        break;
      case "attachment":
        push(`${p}-alt`, true, e.attachment.alt);
        push(`${p}-caption`, true, e.attachment.caption);
        break;
      case "bundle":
        push(`${p}-caption`, true, e.bundle.caption);
        break;
      case "figure":
        for (const n of e.figure.nodes) push(`${p}-node-${n.id}`, true, n.label);
        e.figure.edges.forEach((edge, j) => {
          push(`${p}-edge-${j}`, true, edge.label);
        });
        break;
      case "ref":
      case "payload":
        break;
    }
  });
  return out;
}

/** The field names evidence carries at this version. The renderer asks for them so
 *  it can tell a field the base version had and this one does not from one it is
 *  already drawing, without knowing how a name is built. */
export function evidenceFieldNames(evidence: Evidence[]): string[] {
  return evidenceFields(evidence).map((f) => f.field);
}

/** A group's file list, as the words the walkthrough partitions the diff into. */
export function groupFilesHtml(paths: string[]): string {
  return paths.map((p) => `<span class="gfile">${escapeHtml(p)}</span>`).join(" ");
}

function statementFields(s: ReviewDoc["statements"][number]): FieldSpec[] {
  return [
    spec("text", true, safeInline(s.text)),
    spec("body", false, safeBlock(s.body)),
    ...evidenceFields(s.evidence),
    spec("kind", true, safeInline(s.kind), false),
  ];
}

export function designPathsHtml(paths: string[]): string {
  return paths.map((p) => `<span class="dpath">${escapeHtml(p)}</span>`).join(" ");
}

function moduleFields(m: NonNullable<ReviewDoc["codeDesign"]>["modules"][number]): FieldSpec[] {
  return [
    spec("title", true, safeInline(m.title)),
    spec("body", false, safeBlock(m.body)),
    spec("paths", false, designPathsHtml(m.paths)),
  ];
}

function coverageFields(c: NonNullable<ReviewDoc["codeDesign"]>["coverage"][number]): FieldSpec[] {
  return [spec("title", true, safeInline(c.title)), spec("body", false, safeBlock(c.body))];
}

function noteFields(n: ReviewDoc["notes"][number]): FieldSpec[] {
  return [
    spec("text", true, safeInline(n.text)),
    spec("body", false, safeBlock(n.body)),
    ...n.checks.map((c, i) => spec(`check-${i}`, false, safeInline(c))),
    ...evidenceFields(n.evidence),
    spec("kind", true, safeInline(n.kind), false),
  ];
}

/** The paths a group's hunks touch, in the order the walkthrough draws them:
 *  document hunk order, each path once. Kept in step with `filesOf` there, so the
 *  words compared are the words shown. */
function groupPaths(
  g: ReviewDoc["groups"][number],
  hunks: Map<string, { path: string; at: number }>,
): string[] {
  const wanted = g.hunks
    .map((id) => hunks.get(id))
    .filter((h): h is { path: string; at: number } => h !== undefined)
    .sort((a, b) => a.at - b.at);
  const seen: string[] = [];
  for (const h of wanted) if (!seen.includes(h.path)) seen.push(h.path);
  return seen;
}

function groupFieldsWith(
  g: ReviewDoc["groups"][number],
  hunks: Map<string, { path: string; at: number }>,
): FieldSpec[] {
  const seen = groupPaths(g, hunks);
  return [
    spec("title", true, safeInline(g.title)),
    spec("paragraph", false, safeBlock(g.paragraph)),
    spec("files", false, groupFilesHtml(seen)),
    spec("kind", true, safeInline(g.kind), false),
  ];
}

/** The pull request description, as the renderer draws it: escaped paragraphs,
 *  never parsed as markup. Derived prose, diffed like any other prose. */
export function prBodyHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p class="prbody">${escapeHtml(p)}</p>`)
    .join("");
}

function prFields(pr: ReviewDoc["prs"][number]): FieldSpec[] {
  return [
    spec("gist", true, safeInline(pr.gist)),
    spec("detail", false, safeBlock(pr.detail)),
    spec("body", false, prBodyHtml(pr.body)),
  ];
}

function compare(
  kind: DeltaEntityKind,
  id: string,
  prior: FieldSpec[],
  current: FieldSpec[],
  codeMoved: boolean,
): EntityDelta | null {
  const priorByName = new Map(prior.map((f) => [f.field, f]));
  const nowByName = new Set(current.map((f) => f.field));
  const fields: FieldDelta[] = [];
  for (const spec of current) {
    const was = priorByName.get(spec.field);
    const d = diffField(spec.field, spec.inline, was ? was.html : "", spec.html);
    if (d) fields.push(d);
  }
  // A field the base side had and this side does not is a deletion, and a deletion
  // the page does not draw is exactly the absence the data model forbids. The whole
  // prior text goes behind one disclosure: there is nothing left to mark in place.
  for (const spec of prior) {
    if (nowByName.has(spec.field)) continue;
    const words = wordToks(spec.html).map((t) => t.raw);
    if (words.length === 0) continue;
    fields.push({
      field: spec.field,
      inline: false,
      regions: [{ d0: 0, d1: words.length, c0: 0, c1: 0 }],
      priorWords: words,
      density: 1,
    });
  }
  if (fields.length === 0 && !codeMoved) return null;
  return { kind, id, status: "revised", fields, former: null, formerKind: null, codeMoved };
}

function born(kind: DeltaEntityKind, id: string): EntityDelta {
  // `new!` identifies the whole entity. It needs no word-level insertion beneath it:
  // painting every word green would restate the status as noise.
  return {
    kind,
    id,
    status: "new",
    fields: [],
    former: null,
    formerKind: null,
    codeMoved: false,
  };
}

/** A removed entity, carried out as the prose it held: its head line and every
 *  authored body under it. Evidence, hunks and refs are citations rather than
 *  authorship, and they belong to a source the removed entity no longer points at,
 *  so the stub deliberately holds the words and not the quotations. */
function gone(
  kind: DeltaEntityKind,
  id: string,
  specs: FieldSpec[],
  formerKind: string | null = null,
): EntityDelta {
  const [head, ...rest] = specs;
  return {
    kind,
    id,
    status: "removed",
    fields: [],
    former: {
      head: head!.html,
      body: rest.filter((f) => f.stub).map((f) => f.html).filter((h) => h !== ""),
    },
    formerKind,
    codeMoved: false,
  };
}

const MATCH_STOP = new Set([
  "and", "are", "for", "from", "has", "have", "into", "one", "that", "the",
  "their", "them", "they", "this", "under", "was", "were", "while", "with",
]);

/** Rough morphology is enough here: this is a conservative identity fallback, not a
 *  prose search engine. The small concept folds catch the vocabulary review headings
 *  naturally use while leaving ordinary technical nouns distinct. */
function matchWord(raw: string): string {
  let word = raw.toLowerCase().replace(/^&+|;+$/g, "");
  if (/^(reader|reading|reads?)$/.test(word)) return "read";
  if (/^(intent|provenance|purpose)$/.test(word)) return "purpose";
  if (/^(decision|decisions|judgment|judgements|tradeoff|tradeoffs)$/.test(word)) return "decision";
  if (word.includes("publish") || word.startsWith("publicat")) return "publish";
  if (/^(revision|revisions|revised|version|versions|delta|deltas|redline|redlines)$/.test(word)) return "change";
  if (word.length > 6 && word.endsWith("ing")) word = word.slice(0, -3);
  else if (word.length > 5 && word.endsWith("ed")) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith("es")) word = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s")) word = word.slice(0, -1);
  return word;
}

function matchWords(specs: FieldSpec[], headOnly: boolean): Set<string> {
  const chosen = headOnly ? specs.slice(0, 1) : specs;
  return new Set(
    chosen
      .flatMap((f) => wordToks(f.html).map((t) => matchWord(t.raw)))
      .filter((w) => w.length > 2 && !MATCH_STOP.has(w)),
  );
}

function matchCodes(specs: FieldSpec[]): Set<string> {
  const out = new Set<string>();
  for (const f of specs) {
    for (const code of f.html.matchAll(/<code>(.*?)<\/code>/g)) {
      for (const name of code[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(name[0].toLowerCase());
    }
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / Math.max(1, a.size + b.size);
}

function matchStrength(prior: FieldSpec[], current: FieldSpec[]): { score: number; eligible: boolean } {
  const pt = matchWords(prior, true);
  const ct = matchWords(current, true);
  const exact = [...pt].join(" ") === [...ct].join(" ") && pt.size > 0;
  if (exact) return { score: 2, eligible: true };
  const title = dice(pt, ct);
  const body = dice(matchWords(prior, false), matchWords(current, false));
  const code = dice(matchCodes(prior), matchCodes(current));
  const score = title * 0.65 + body * 0.25 + code * 0.1;
  return {
    score,
    eligible:
      title >= 0.6 ||
      score >= 0.26 ||
      (title >= 0.1 && (body >= 0.18 || score >= 0.12)) ||
      (code >= 0.5 && body >= 0.18),
  };
}

/** Exact ids, then an order-preserving alignment of eligible authored resemblance.
 *  Exact handles may move freely; rough matches act as heading anchors, so a removed
 *  middle section remains a gap instead of making every later section look replaced. */
function entityMatches<T extends { id: string }>(
  prior: T[],
  current: T[],
  priorFields: (x: T) => FieldSpec[],
  currentFields: (x: T) => FieldSpec[],
): Map<string, T> {
  const matches = new Map<string, T>();
  const used = new Set<string>();
  const byId = new Map(prior.map((x) => [x.id, x]));
  for (const x of current) {
    const exact = byId.get(x.id);
    if (exact) {
      matches.set(x.id, exact);
      used.add(exact.id);
    }
  }
  const loosePrior = prior.filter((x) => !used.has(x.id));
  const looseCurrent = current.filter((x) => !matches.has(x.id));
  const rows = looseCurrent.length + 1;
  const cols = loosePrior.length + 1;
  const score = Array.from({ length: rows }, () => new Float64Array(cols));
  const step = Array.from(
    { length: rows },
    () => new Array<"current" | "prior" | "match" | null>(cols).fill(null),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      let best = score[i - 1]![j]!;
      let move: "current" | "prior" | "match" = "current";
      if (score[i]![j - 1]! > best) {
        best = score[i]![j - 1]!;
        move = "prior";
      }
      const strength = matchStrength(
        priorFields(loosePrior[j - 1]!),
        currentFields(looseCurrent[i - 1]!),
      );
      // The small bonus prefers two credible anchors to one only marginally stronger
      // pair, which is what preserves a three-to-two section edit as one removal.
      const paired = score[i - 1]![j - 1]! + strength.score + 0.02;
      if (strength.eligible && paired > best) {
        best = paired;
        move = "match";
      }
      score[i]![j] = best;
      step[i]![j] = move;
    }
  }
  let i = looseCurrent.length;
  let j = loosePrior.length;
  while (i > 0 && j > 0) {
    const move = step[i]![j];
    if (move === "match") {
      matches.set(looseCurrent[i - 1]!.id, loosePrior[j - 1]!);
      i--;
      j--;
    } else if (move === "prior") j--;
    else i--;
  }
  return matches;
}

function nextSurvivor<T extends { id: string }>(
  prior: T[],
  at: number,
  priorToCurrent: Map<string, string>,
): string | null {
  for (let i = at + 1; i < prior.length; i++) {
    const id = priorToCurrent.get(prior[i]!.id);
    if (id) return id;
  }
  return null;
}

function walk<T extends { id: string; kind?: string }>(
  kind: DeltaEntityKind,
  prior: T[],
  current: T[],
  fieldsOf: (x: T) => FieldSpec[],
  out: EntityDelta[],
): void {
  const matches = entityMatches(prior, current, fieldsOf, fieldsOf);
  const priorToCurrent = new Map([...matches].map(([id, was]) => [was.id, id]));
  for (const x of current) {
    const p = matches.get(x.id);
    if (!p) {
      out.push(born(kind, x.id));
      continue;
    }
    const d = compare(kind, x.id, fieldsOf(p), fieldsOf(x), false);
    if (d) out.push(d);
  }
  prior.forEach((x, i) => {
    if (priorToCurrent.has(x.id)) return;
    const d = gone(kind, x.id, fieldsOf(x), x.kind ?? null);
    d.insertBefore = nextSurvivor(prior, i, priorToCurrent);
    out.push(d);
  });
}

/** Groups walk like anything else, except that each side resolves its own hunks:
 *  a hunk id is a handle into the version it was published with. */
function walkGroups(
  prior: ReviewDoc["groups"],
  current: ReviewDoc["groups"],
  priorHunks: Map<string, { path: string; at: number }>,
  curHunks: Map<string, { path: string; at: number }>,
  out: EntityDelta[],
): void {
  const matches = entityMatches(
    prior,
    current,
    (g) => groupFieldsWith(g, priorHunks),
    (g) => groupFieldsWith(g, curHunks),
  );
  const priorToCurrent = new Map([...matches].map(([id, was]) => [was.id, id]));
  for (const g of current) {
    const p = matches.get(g.id);
    if (!p) {
      out.push(born("group", g.id));
      continue;
    }
    const d = compare(
      "group",
      g.id,
      groupFieldsWith(p, priorHunks),
      groupFieldsWith(g, curHunks),
      false,
    );
    if (d) out.push(d);
  }
  prior.forEach((g, i) => {
    if (priorToCurrent.has(g.id)) return;
    const d = gone("group", g.id, groupFieldsWith(g, priorHunks), g.kind);
    d.insertBefore = nextSurvivor(prior, i, priorToCurrent);
    out.push(d);
  });
}

/**
 * What moved between two published versions. Pure: the same pair always produces
 * the same delta, and nothing here reads a clock, a request or the database.
 */
export function computeDelta(prev: DeltaSide, cur: DeltaSide): Delta {
  const entities: EntityDelta[] = [];

  const title = compare(
    "review",
    "review",
    [spec("title", true, safeInline(prev.doc.title))],
    [spec("title", true, safeInline(cur.doc.title))],
    false,
  );
  if (title) entities.push(title);

  const intent = compare(
    "intent",
    "intent",
    [spec("authorIntent", false, safeBlock(prev.doc.authorIntent ?? ""))],
    [spec("authorIntent", false, safeBlock(cur.doc.authorIntent ?? ""))],
    false,
  );
  if (intent) entities.push(intent);

  // The summary is a body like any other body, and it is diffed like one.
  const summary = compare(
    "summary",
    "summary",
    [spec("summary", false, safeBlock(prev.doc.summary))],
    [spec("summary", false, safeBlock(cur.doc.summary))],
    false,
  );
  if (summary) entities.push(summary);

  // Pull requests are keyed by repo and number rather than by an id field: that
  // pair is the pointer the skill wrote, and it is what survives a republish.
  const priorPrs = new Map(prev.doc.prs.map((p) => [prKey(p.repo, p.number), p]));
  for (const pr of cur.doc.prs) {
    const key = prKey(pr.repo, pr.number);
    const was = priorPrs.get(key);
    if (!was) {
      entities.push(born("pr", key));
      continue;
    }
    const d = compare("pr", key, prFields(was), prFields(pr), was.headSha !== pr.headSha);
    if (d) entities.push(d);
  }
  const nowPrs = new Set(cur.doc.prs.map((p) => prKey(p.repo, p.number)));
  for (const [key, pr] of priorPrs) if (!nowPrs.has(key)) entities.push(gone("pr", key, prFields(pr)));

  walk("statement", prev.doc.statements, cur.doc.statements, statementFields, entities);
  const priorDesign = prev.doc.codeDesign ?? { placement: "", modules: [], coverage: [] };
  const currentDesign = cur.doc.codeDesign ?? { placement: "", modules: [], coverage: [] };
  const placement = compare(
    "design",
    "design",
    [spec("placement", false, safeBlock(priorDesign.placement))],
    [spec("placement", false, safeBlock(currentDesign.placement))],
    false,
  );
  if (placement) entities.push(placement);
  walk("module", priorDesign.modules, currentDesign.modules, moduleFields, entities);
  walk("coverage", priorDesign.coverage, currentDesign.coverage, coverageFields, entities);
  walk("note", prev.doc.notes, cur.doc.notes, noteFields, entities);
  const hunksOf = (doc: ReviewDoc) =>
    new Map(doc.hunks.map((h, i) => [h.id, { path: h.path, at: i }] as const));
  const priorHunks = hunksOf(prev.doc);
  const curHunks = hunksOf(cur.doc);
  walkGroups(prev.doc.groups, cur.doc.groups, priorHunks, curHunks, entities);

  const wasOpen = new Map(prev.annotations.map((a) => [a.id, a.status]));
  const answered = cur.annotations
    .filter((a) => a.status === "answered" && wasOpen.get(a.id) === "open")
    .map((a) => a.id)
    .sort();

  return { entities, answered };
}

// ---- the index the renderer reads ----

/** The delta, keyed the way a renderer walks a page. Built once per render. */
export class DeltaIndex {
  private byKey = new Map<string, EntityDelta>();
  /** Annotations that were open in the base version and are answered in this one.
   *  Nothing on the page reads this yet: annotations are not rendered, and the
   *  review page hands both sides an empty list because `review_annotations` records
   *  the version an annotation was filed at and not the version it was answered at,
   *  so the base side cannot be reconstructed. The step that renders annotations has
   *  to fill both halves; it may not assume this one already arrives populated. */
  readonly answered: Set<string>;
  readonly delta: Delta;

  constructor(delta: Delta) {
    this.delta = delta;
    for (const e of delta.entities) this.byKey.set(`${e.kind}:${e.id}`, e);
    this.answered = new Set(delta.answered);
  }

  get(kind: DeltaEntityKind, id: string): EntityDelta | null {
    return this.byKey.get(`${kind}:${id}`) ?? null;
  }

  /** Entities of one kind that the base version had and this one does not. */
  removed(kind: DeltaEntityKind): EntityDelta[] {
    return this.delta.entities.filter((e) => e.kind === kind && e.status === "removed");
  }

  /** Removed sections that occupied the slot before one surviving section. `null`
   *  is the tail after the last survivor. */
  removedBefore(kind: DeltaEntityKind, currentId: string | null): EntityDelta[] {
    return this.removed(kind).filter((e) => (e.insertBefore ?? null) === currentId);
  }

  counts(): {
    revised: number;
    added: number;
    removed: number;
    codeMoved: number;
    restated: string[];
  } {
    let revised = 0;
    let added = 0;
    let removed = 0;
    let codeMoved = 0;
    // The title and the summary carry marks rather than a status label, because neither
    // sits in a row that could hold one. They are still movement, and a menu that
    // said nothing moved about a version whose summary the same page marks would
    // be a denial the page contradicts, so they are named rather than counted.
    const restated: string[] = [];
    for (const e of this.delta.entities) {
      const hasStatus =
        e.kind !== "review" && e.kind !== "intent" && e.kind !== "summary" && e.kind !== "design";
      if (!hasStatus && e.status === "revised" && e.fields.length > 0) {
        restated.push(
          e.kind === "review"
            ? "title"
            : e.kind === "intent"
              ? "author intent"
              : e.kind === "summary"
                ? "summary"
                : "code design",
        );
      }
      // A pull request whose only movement is its head sha is code moved, not
      // revised: nothing it says on the page changed.
      if (e.status === "revised") {
        if (e.fields.length > 0 && hasStatus) revised++;
      }
      else if (e.status === "new") added++;
      else removed++;
      if (e.codeMoved) codeMoved++;
    }
    // Title, author intent, summary, code design, always.
    const order = ["title", "author intent", "summary", "code design"];
    restated.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { revised, added, removed, codeMoved, restated };
  }
}

// ---- marking ----

const EDIT_ICON = `<svg class="dediticon" aria-hidden="true"><use href="#i-edit"/></svg>`;

/** An id fragment safe for an attribute, and injective: every character outside the
 *  safe set becomes its own escape, so two keys that differ anywhere still differ
 *  here. Collapsing them would pair one checkbox with another entity's label, and
 *  the whole disclosure grammar is that pairing. */
export function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/** A disclosure id that depends only on where it sits, so two renders of one pair
 *  produce the same bytes. */
function boxId(owner: string, field: string, k: number): string {
  return `dp-${safeId(owner)}-${safeId(field)}-${k}`;
}

type Edit = { at: number; del: number; ins: string };

/** One in-place redline: prior words before their current replacements, additions in
 *  the current structure. It is built beside the clean current copy and shown only
 *  when the reader opens Edited. */
function inlineDiffHtml(html: string, d: FieldDelta): string {
  const ix = wordIndex(html);
  const edits: Edit[] = [];
  const add = (at: number, del: number, ins: string) => edits.push({ at, del, ins });
  const markCurrent = (c0: number, c1: number) => {
    let a = c0;
    while (a < c1) {
      let b = a + 1;
      while (b < c1 && contiguous(ix, a, b + 1)) b++;
      const first = ix.words[a]!;
      const last = ix.words[b - 1]!;
      add(first.s, last.e - first.s, `<ins class="dw">${html.slice(first.s, last.e)}</ins>`);
      a = b;
    }
  };
  for (const r of d.regions) {
    const was = d.priorWords.slice(r.d0, r.d1).join(" ");
    const at =
      r.c0 < ix.words.length
        ? ix.words[r.c0]!.s
        : ix.words.length > 0
          ? ix.words[ix.words.length - 1]!.e
          : 0;
    if (r.c1 > r.c0) markCurrent(r.c0, r.c1);
    if (was !== "") add(at, 0, `<del class="dold">${was}</del> `);
  }
  edits.sort((a, b) => b.at - a.at || b.del - a.del);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  return out;
}

/**
 * The field's clean current markup and its hidden redline. Standalone prose carries
 * its own edited control; fields inside an entity borrow that entity's explicit
 * control. Opening the entity itself never reveals a diff. Nothing needs JavaScript.
 */
export function markField(
  html: string,
  d: FieldDelta,
  owner: string,
  control = false,
): string {
  const diff = inlineDiffHtml(html, d);
  const tag = d.inline ? "span" : "div";
  const inlineClass = d.inline ? " dchange-inline" : "";
  if (!control) {
    return (
      `<${tag} class="dborrow${inlineClass}"><${tag} class="dcurrent">${html}</${tag}>` +
      `<${tag} class="dinline">${diff}</${tag}></${tag}>`
    );
  }
  const id = boxId(owner, d.field, 1);
  const input = `<input type="checkbox" class="dtog" id="${id}" aria-label="show edits">`;
  const label = `<label class="dedited" for="${id}">${EDIT_ICON}<span>edited</span></label>`;
  const content =
    `<${tag} class="dcurrent">${html}</${tag}><${tag} class="dinline">${diff}</${tag}>`;
  // An inline field is a line of running text — a title — so its control trails the
  // words it belongs to. A block field leads with the control, above the prose it
  // opens. The checked-state rules select by class, not by order, so both read the
  // same to CSS.
  return d.inline
    ? `<${tag} class="dchange${inlineClass}">${input}${content}${label}</${tag}>`
    : `<${tag} class="dchange${inlineClass}">${input}${label}${content}</${tag}>`;
}

/** The markup for one field, marked when the delta touched it and plain when it
 *  did not. The one entry point the renderer uses, so a field cannot be marked by
 *  accident and cannot be left unmarked by forgetting. */
export function marked(
  html: string,
  entity: EntityDelta | null,
  field: string,
  owner: string,
  /** True for a one-line field that stands on its own rather than inside a
   *  summary, so its prior text needs a control of its own to open. */
  control = false,
): string {
  if (!entity) return html;
  const d = entity.fields.find((f) => f.field === field);
  return d ? markField(html, d, owner, control) : html;
}

/** One explicit diff control shared by every changed field inside an entity. The
 *  input is placed directly after its summary; the label sits at the start of the
 *  expanded body. CSS ties both to every borrowed field in that details element. */
export function entityEditControl(
  entity: EntityDelta | null,
  owner: string,
): { input: string; label: string } {
  if (!entity || entity.status !== "revised" || entity.fields.length === 0) {
    return { input: "", label: "" };
  }
  const id = `de-${safeId(owner)}`;
  return {
    input: `<input type="checkbox" class="dtog etog" id="${id}" aria-label="show edits">`,
    label: `<label class="dedited eedited" for="${id}">${EDIT_ICON}<span>edited</span></label>`,
  };
}

/** Whether the delta touched one field of one entity. The renderer asks before it
 *  draws a field that is only on the page when it moved. */
export function touched(entity: EntityDelta | null, field: string): boolean {
  return entity !== null && entity.fields.some((f) => f.field === field);
}

/** The code-moved status. Minted here rather than at each site that shows one, so
 *  its wording cannot drift between surfaces. */
export function movedStatus(): string {
  return `<span class="rev rev-moved">code moved</span>`;
}

/** The small inline status an entity carries, or nothing. It is always derived from
 *  the delta; witnesses cannot author their own change labels. */
export function statusMark(entity: EntityDelta | null): string {
  if (!entity) return "";
  const status =
    entity.status === "new"
      ? { cls: "rev-new", word: "new!" }
      : entity.status === "removed"
        ? { cls: "rev-removed", word: "removed" }
        : { cls: "rev-edited", word: "edited" };
  const moved = entity.codeMoved ? movedStatus() : "";
  if (entity.status === "revised" && entity.fields.length === 0) return moved;
  return `<span class="rev ${status.cls}">${status.word}</span>${moved}`;
}
