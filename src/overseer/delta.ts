// The delta engine: what moved between two published versions of one review.
//
// Until now the page could only say "version 4" and leave a reader to find the
// change themselves. This module computes it instead, at word level, over the
// two stored documents. Nothing here is authored: the skill may not write a
// "revised" chip, and no other code path may emit one, because a chip that is
// typed rather than derived is a claim the page cannot check.
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
// Entities match by id alone. Ids are the data model's handles and they are
// stable across publishes, so a positional fallback would only ever pair two
// things that are not the same thing. An id present in both sides is compared
// field by field; an id only on the current side is new; an id only on the base
// side is removed, and its former content is carried out whole so an absence
// stays reviewable.
//
// TOKENS AND THE THRESHOLD
//
// A field is diffed as the HTML the page will actually show, scanned into tags,
// whitespace runs and words, with only words compared, so a tag boundary never
// shifts an alignment. Changed density is retained as a measurement for tests and
// diagnostics, but it never changes the visual grammar: prose always gets one labelled
// Edited control, and its word-level redline appears only when opened.
//
// Only words are compared, which is also the limit of what this can see: an edit
// that moves markup without moving a word, a phrase that became code or emphasis,
// or a link retargeted under unchanged link text, produces no field, no mark and no
// chip. Nothing false is claimed, but nothing is claimed at all, and a reader who
// came back for what moved will not learn it here.
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

/** One authored field that moved. `words` is a one-line field inside an existing
 *  disclosure. `whole` is prose with one field-level Edited control. Both modes
 *  mark the same word regions; the distinction is control placement, not diff semantics. */
export interface FieldDelta {
  /** Field name, unique within its entity. */
  field: string;
  /** True for a one-line field drawn inside a summary, which carries no control
   *  of its own because the row's own chevron is already the one tap. */
  inline: boolean;
  mode: "words" | "whole";
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

  // Too long to align. The field is republished whole: one region covering
  // everything, which is what the whole-mode marker draws anyway.
  if (pw.length > MAX_DIFF_WORDS || cw.length > MAX_DIFF_WORDS) {
    return {
      field,
      inline,
      mode: "whole",
      regions: [{ d0: 0, d1: pw.length, c0: 0, c1: cw.length }],
      priorWords: pw,
      density: 1,
    };
  }

  const regs = regions(lcsOps(pw, cw));
  const moved = regs.reduce((a, r) => a + (r.d1 - r.d0) + (r.c1 - r.c0), 0);
  const density = moved / Math.max(1, Math.max(pw.length, cw.length));
  // Prose gets one labelled field-level disclosure whether one word or the whole
  // paragraph moved. One-line fields already sit in a disclosure row and keep their
  // old words beside the exact replacement when that row opens.
  const mode: FieldDelta["mode"] = inline ? "words" : "whole";
  return { field, inline, mode, regions: regs, priorWords: pw, density };
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

/** The head field of an entity: the line a stub or a new-entity mark hangs off. */
function headField(specs: FieldSpec[]): FieldSpec {
  return specs[0]!;
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
      mode: "whole",
      regions: [{ d0: 0, d1: words.length, c0: 0, c1: 0 }],
      priorWords: words,
      density: 1,
    });
  }
  if (fields.length === 0 && !codeMoved) return null;
  return { kind, id, status: "revised", fields, former: null, formerKind: null, codeMoved };
}

function born(kind: DeltaEntityKind, id: string, specs: FieldSpec[]): EntityDelta {
  // A new entity marks its own head line rather than every word it holds: the
  // chip says the whole thing is new, and the line under it is what the reader
  // reads first. Marking the body too would leave the row solid ink.
  const head = headField(specs);
  const d = diffField(head.field, head.inline, "", head.html);
  return {
    kind,
    id,
    status: "new",
    fields: d ? [d] : [],
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

function walk<T extends { id: string; kind?: string }>(
  kind: DeltaEntityKind,
  prior: T[],
  current: T[],
  fieldsOf: (x: T) => FieldSpec[],
  out: EntityDelta[],
): void {
  const was = new Map(prior.map((x) => [x.id, x]));
  for (const x of current) {
    const p = was.get(x.id);
    if (!p) {
      out.push(born(kind, x.id, fieldsOf(x)));
      continue;
    }
    const d = compare(kind, x.id, fieldsOf(p), fieldsOf(x), false);
    if (d) out.push(d);
  }
  const now = new Set(current.map((x) => x.id));
  for (const x of prior) if (!now.has(x.id)) out.push(gone(kind, x.id, fieldsOf(x), x.kind ?? null));
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
  const was = new Map(prior.map((g) => [g.id, g]));
  for (const g of current) {
    const p = was.get(g.id);
    if (!p) {
      out.push(born("group", g.id, groupFieldsWith(g, curHunks)));
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
  const now = new Set(current.map((g) => g.id));
  for (const g of prior) {
    if (!now.has(g.id)) out.push(gone("group", g.id, groupFieldsWith(g, priorHunks), g.kind));
  }
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
      entities.push(born("pr", key, prFields(pr)));
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
    // The title and the summary carry marks rather than a chip, because neither
    // sits in a row that could hold one. They are still movement, and a menu that
    // said nothing moved about a version whose summary the same page marks would
    // be a denial the page contradicts, so they are named rather than counted.
    const restated: string[] = [];
    for (const e of this.delta.entities) {
      const chips =
        e.kind !== "review" && e.kind !== "intent" && e.kind !== "summary" && e.kind !== "design";
      if (!chips && e.status === "revised" && e.fields.length > 0) {
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
        if (e.fields.length > 0 && chips) revised++;
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

const CHEV = `<svg class="dtick" aria-hidden="true"><use href="#i-chev"/></svg>`;

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
 * The field's markup with the delta marked in it. Prose stays clean until its Edited
 * control swaps an inline redline into the same place. One-line fields inside an
 * existing disclosure borrow that row's chevron. Nothing here needs JavaScript.
 */
export function markField(
  html: string,
  d: FieldDelta,
  owner: string,
  control = false,
): string {
  const ix = wordIndex(html);
  const w = ix.words;
  const edits: Edit[] = [];
  const cut = (at: number, del: number, ins: string) => edits.push({ at, del, ins });
  const prior = d.priorWords;
  // A one-line field inside a summary carries no control of its own, because one
  // would fight the row's own chevron. A one-line field standing on its own, like
  // the review title, has no row to borrow and so grows one.
  const own = !d.inline || control;
  let k = 0;
  const box = () => boxId(owner, d.field, ++k);

  /** Every word of a run, wrapped where it stands. A run that straddles a tag is
   *  wrapped piece by piece rather than dropped: the mark has to be there, because
   *  the chip above it says it is. */
  const insRuns = (c0: number, c1: number) => {
    let a = c0;
    while (a < c1) {
      let b = a + 1;
      while (b < c1 && contiguous(ix, a, b + 1)) b++;
      cut(
        w[a]!.s,
        w[b - 1]!.e - w[a]!.s,
        `<ins class="dw dnew">${html.slice(w[a]!.s, w[b - 1]!.e)}</ins>`,
      );
      a = b;
    }
  };

  /** The prior words on their own, next to where they used to stand. */
  const priorOnly = (at: number, was: string, cutOnly = false) => {
    if (!own) {
      if (!cutOnly) {
        cut(at, 0, `<span class="dp">${was} </span>`);
        return;
      }
      // A pure deletion inside a summary has no inserted word to carry the mark,
      // and the prior words are hidden while the row is shut. Without a mark of
      // its own the row's chip would stand over nothing, so the cut itself is
      // drawn: a caret where the words used to be.
      cut(at, 0, `<span class="dw dcut" aria-hidden="true"></span><span class="dp">${was} </span>`);
      return;
    }
    const id = box();
    cut(
      at,
      0,
      `<input type="checkbox" class="dtog" id="${id}" aria-label="prior text">` +
        `<label class="dw dxo" for="${id}">${CHEV}</label>` +
        `<span class="dp">${was} </span>`,
    );
  };

  if (d.mode === "whole" || control) {
    if (prior.length === 0) return inlineDiffHtml(html, d);
    const id = box();
    const diff = inlineDiffHtml(html, d);
    if (d.inline) {
      return (
        `<span class="dchange dchange-inline"><span class="dcurrent">${html}</span>` +
        `<input type="checkbox" class="dtog" id="${id}" aria-label="show edits">` +
        `<label class="dedited" for="${id}">${CHEV}<span>(Edited)</span></label>` +
        `<span class="dinline">${diff}</span></span>`
      );
    }
    return (
      `<div class="dchange"><input type="checkbox" class="dtog" id="${id}" aria-label="show edits">` +
      `<label class="dedited" for="${id}">${CHEV}<span>(Edited)</span></label>` +
      `<div class="dcurrent">${html}</div><div class="dinline">${diff}</div></div>`
    );
  } else {
    for (const r of d.regions) {
      const was = prior.slice(r.d0, r.d1).join(" ");
      const hasIns = r.c1 > r.c0;
      const inOne = hasIns && contiguous(ix, r.c0, r.c1);
      const at = r.c0 < w.length ? w[r.c0]!.s : html.length;
      if (inOne) {
        const slice = html.slice(w[r.c0]!.s, w[r.c1 - 1]!.e);
        const span = w[r.c1 - 1]!.e - w[r.c0]!.s;
        if (was === "") {
          cut(w[r.c0]!.s, span, `<ins class="dw dnew">${slice}</ins>`);
        } else if (!own) {
          cut(w[r.c0]!.s, span, `<ins class="dw">${slice}</ins><span class="dp"> ${was}</span>`);
        } else {
          const id = box();
          cut(
            w[r.c0]!.s,
            span,
            `<input type="checkbox" class="dtog" id="${id}" aria-label="prior text">` +
              `<label class="dw" for="${id}"><ins>${slice}</ins>${CHEV}</label>` +
              `<span class="dp"> ${was}</span>`,
          );
        }
      } else if (hasIns) {
        // The inserted run crosses a tag, so it cannot be one mark. It becomes one
        // mark per piece, and the prior words hang off their own control beside it.
        insRuns(r.c0, r.c1);
        if (was !== "") priorOnly(at, was);
      } else if (was !== "") {
        priorOnly(at, was, true);
      }
    }
  }

  edits.sort((a, b) => b.at - a.at || b.del - a.del);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  return out;
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

/** Whether the delta touched one field of one entity. The renderer asks before it
 *  draws a field that is only on the page when it moved. */
export function touched(entity: EntityDelta | null, field: string): boolean {
  return entity !== null && entity.fields.some((f) => f.field === field);
}

/** The code-moved chip. Minted here rather than at each site that shows one, so a
 *  chip on a card and the same chip in the revision menu cannot drift apart. */
export function movedChip(): string {
  return `<span class="rev rev-moved">code moved</span>`;
}

/** The chip an entity carries, or nothing. Chips are minted here and in `movedChip`
 *  and nowhere else, and both take what they say from a delta, so every chip on the
 *  page is derived rather than authored. */
export function chip(entity: EntityDelta | null): string {
  if (!entity) return "";
  const word = entity.status === "new" ? "new" : entity.status === "removed" ? "removed" : "revised";
  const moved = entity.codeMoved ? movedChip() : "";
  if (entity.status === "revised" && entity.fields.length === 0) return moved;
  return `<span class="rev">${word}</span>${moved}`;
}
