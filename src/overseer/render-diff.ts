// The walkthrough: the diff, in the order the review says it should be read.
//
// The groups partition every hunk of every pull request, so this section is the whole
// diff and not a selection from it. It is drawn straight off the stored document:
// the group order is `significance` ascending with the id as the tiebreak, the file
// rows are the group's own hunks gathered by path, and every line number on the page
// is the number the parser wrote into the hunk. Nothing here re-derives a fact; a
// number that is wrong on the page is wrong in the document, which is a claim a test
// can make and a reader can trust.
//
// Every disclosure is a `details`. Strip every script from the response and the
// walkthrough still opens, still numbers its lines and still marks its words.
//
// The syntax classes are the prototype's four: a comment, a keyword, a literal and a
// declared name. The tokenizer below is deliberately small and single-line, because a
// hunk is a window into a file and never carries enough of it to parse. It knows two
// languages and says nothing at all about a third, which is the mono fallback: an
// unrecognized file reads as code without an opinion about it.

import { escapeHtml } from "../escape";
import type { ReviewDoc } from "./db";
import {
  chip,
  groupFilesHtml,
  marked,
  safeId,
  touched,
  type DeltaIndex,
  type EntityDelta,
} from "./delta";
import { icon, safeBlock, safeInline, shortSha } from "./render-evidence";
import type { Group, Hunk, HunkLine, StatementKind } from "./types";

/** The anchor a target grows once something has been asked about it, supplied by the
 *  page rather than built here: the questions themselves live in one place. */
export type QuestionsHere = (type: string, id: string) => string;

/** An entity's kind, on the page only when it moved. The kind draws the row's icon
 *  and nothing else, and a risk quietly restated as a note is exactly what a reader
 *  came back for, so when it moves it comes out as the word it is. Every entity the
 *  delta compares a kind on draws this, or its chip would stand over an unmarked row. */
export function kindMark(d: EntityDelta | null, owner: string, kind: string): string {
  if (!touched(d, "kind")) return "";
  return `<p class="ev-was">${marked(safeInline(kind), d, "kind", owner, true)}</p>`;
}

/** What a kind mark is called out loud. Shared with the chain and the statement rows,
 *  so one mark never has two names on one page. */
export const KIND_LABEL: Record<StatementKind, string> = {
  add: "adds",
  change: "changes",
  remove: "removes",
};

// ---- syntax ----

/** The language a path is read as, or null for the mono fallback. */
export function langOfPath(path: string): "ts" | "json" | null {
  const cut = path.lastIndexOf(".");
  if (cut === -1) return null;
  const ext = path.slice(cut + 1).toLowerCase();
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (ext === "json" || ext === "jsonc") return "json";
  return null;
}

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for",
  "from", "function", "if", "implements", "import", "in", "instanceof", "interface",
  "let", "new", "of", "private", "protected", "public", "readonly", "return",
  "satisfies", "static", "switch", "this", "throw", "try", "type", "typeof", "var",
  "void", "while", "yield",
  // the literals and the primitive type names read as keywords too: they are the
  // vocabulary of the language rather than a value the author chose.
  "any", "boolean", "false", "never", "null", "number", "string", "true", "undefined",
  "unknown",
]);

/** A word after one of these is a name being declared, whatever case it is written in. */
const DECLARES = new Set(["class", "enum", "function", "interface", "type"]);

interface Tok {
  start: number;
  end: number;
  cls: "cm" | "kw" | "st" | "ty";
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/** One line of TypeScript or JavaScript, as spans. Single-line by construction: an
 *  unterminated block comment or string runs to the end of the line and stops there. */
function tokensTs(s: string): Tok[] {
  const out: Tok[] = [];
  let prevWord = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "/" && s[i + 1] === "/") {
      out.push({ start: i, end: s.length, cls: "cm" });
      break;
    }
    if (c === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      const end = close === -1 ? s.length : close + 2;
      out.push({ start: i, end, cls: "cm" });
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, s.length);
      out.push({ start: i, end, cls: "st" });
      i = end;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i;
      while (j < s.length && /[0-9a-fA-FxXoObBeE._]/.test(s[j]!)) j++;
      out.push({ start: i, end: j, cls: "st" });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < s.length && IDENT_PART.test(s[j]!)) j++;
      const word = s.slice(i, j);
      if (KEYWORDS.has(word)) out.push({ start: i, end: j, cls: "kw" });
      else if (DECLARES.has(prevWord) || /^[A-Z]/.test(word)) out.push({ start: i, end: j, cls: "ty" });
      prevWord = word;
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** One line of JSON. A string followed by a colon is a key, which is the one name a
 *  JSON document declares. */
function tokensJson(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, s.length);
      let k = end;
      while (k < s.length && (s[k] === " " || s[k] === "\t")) k++;
      out.push({ start: i, end, cls: s[k] === ":" ? "ty" : "st" });
      i = end;
      continue;
    }
    if (DIGIT.test(c) || (c === "-" && DIGIT.test(s[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+-]/.test(s[j]!)) j++;
      out.push({ start: i, end: j, cls: "st" });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < s.length && IDENT_PART.test(s[j]!)) j++;
      const word = s.slice(i, j);
      if (word === "true" || word === "false" || word === "null") {
        out.push({ start: i, end: j, cls: "kw" });
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function tokensFor(text: string, lang: "ts" | "json" | null): Tok[] {
  if (lang === "ts") return tokensTs(text);
  if (lang === "json") return tokensJson(text);
  return [];
}

/** Ranges clamped to the text, dropped when inverted, sorted and merged. A word range
 *  is a refinement of a line that is already marked, so an unusable one is discarded
 *  rather than allowed to shift the characters around it. */
function normalizeRanges(ranges: [number, number][], len: number): [number, number][] {
  const clean: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // Rejected before clamping: a range that lies wholly off the line names nothing on
    // it, and clamping would turn it into a seam mark at a column it never meant.
    if (Math.trunc(b) < Math.trunc(a)) continue;
    if (Math.trunc(b) < 0 || Math.trunc(a) > len) continue;
    const start = Math.max(0, Math.min(len, Math.trunc(a)));
    const end = Math.max(0, Math.min(len, Math.trunc(b)));
    if (end < start) continue;
    clean.push([start, end]);
  }
  clean.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const r of clean) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** A run of text as spans, one per stretch of characters sharing a syntax class. */
function classed(text: string, from: number, to: number, cls: (Tok["cls"] | null)[]): string {
  let out = "";
  let i = from;
  while (i < to) {
    const c = cls[i] ?? null;
    let j = i + 1;
    while (j < to && (cls[j] ?? null) === c) j++;
    const body = escapeHtml(text.slice(i, j));
    out += c === null ? body : `<span class="${c}">${body}</span>`;
    i = j;
  }
  return out;
}

/**
 * One line of code as HTML: syntax classes underneath, word marks on top. The marks
 * are the outer spans, so a changed run reads as one field even when the language
 * colours three different things inside it. A range of zero width is the seam a
 * rewrite left behind, and it is drawn as an empty mark rather than dropped.
 */
export function codeHtml(
  text: string,
  lang: "ts" | "json" | null,
  wordRanges: [number, number][] = [],
): string {
  const cls: (Tok["cls"] | null)[] = new Array(text.length).fill(null);
  for (const t of tokensFor(text, lang)) {
    for (let i = t.start; i < t.end && i < text.length; i++) cls[i] = t.cls;
  }
  const marks = normalizeRanges(wordRanges, text.length);
  if (marks.length === 0) return classed(text, 0, text.length, cls);

  let out = "";
  let at = 0;
  for (const [start, end] of marks) {
    if (start > at) out += classed(text, at, start, cls);
    out += `<span class="w">${classed(text, start, end, cls)}</span>`;
    at = end;
  }
  if (at < text.length) out += classed(text, at, text.length, cls);
  return out;
}

// ---- hunks ----

/** The number a line carries in the gutter: a deletion counts against the old file,
 *  everything else against the new one. Both come off the parsed hunk. */
function gutterNumber(line: HunkLine): string {
  const no = line.kind === "del" ? line.oldNo : line.newNo;
  return no === null ? "" : String(no);
}

const GLYPH: Record<HunkLine["kind"], string> = { ctx: " ", add: "+", del: "-" };

function hunkLine(line: HunkLine, lang: "ts" | "json" | null): string {
  const cls = line.kind === "ctx" ? "l" : `l ${line.kind}`;
  return (
    `<span class="${cls}"><span class="gut">` +
    `<span class="n">${escapeHtml(gutterNumber(line))}</span>` +
    `<span class="g">${escapeHtml(GLYPH[line.kind])}</span></span>` +
    codeHtml(line.content, lang, line.wordRanges) +
    `</span>`
  );
}

/** `@@ -a,b +c,d @@`, exactly as the header the parser read it from. */
export function hunkRange(hunk: Hunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Which pull request and which commit this hunk counts against. Two adjacent hunks
 *  with different sources are two different files underneath, and the walkthrough
 *  marks the seam between them. */
function sourceOf(hunk: Hunk): string {
  return `#${hunk.prNumber} ${shortSha(hunk.sha)}`;
}

/** The id a hunk's element carries, so a question filed against a hunk has somewhere
 *  to point. The hunk's own id holds characters a fragment reads badly, so the anchor
 *  is the escaped form both sides derive the same way. */
export function hunkAnchorId(hunkId: string): string {
  return `h-${safeId(hunkId)}`;
}

function hunkBlock(
  hunk: Hunk,
  previous: Hunk | undefined,
  lang: "ts" | "json" | null,
  here: QuestionsHere,
): string {
  const broke = previous !== undefined && sourceOf(previous) !== sourceOf(hunk);
  const lines = hunk.lines.map((l) => hunkLine(l, lang)).join("");
  return (
    // The hunk's own id travels with it. It is a handle rather than an anchor, so it
    // is an attribute the page can be checked against: the groups partition the
    // document's hunks, and a partition drawn on the page is one every id reaches
    // exactly once.
    `<div class="hunk" id="${escapeHtml(hunkAnchorId(hunk.id))}" data-hunk="${escapeHtml(hunk.id)}"${broke ? " data-src-break" : ""}>` +
    `<div class="hh"><span class="hh-at">${escapeHtml(hunkRange(hunk))}</span>` +
    `<span class="hh-src">${escapeHtml(sourceOf(hunk))}</span></div>` +
    `<pre class="snip scroll-x"><code>${lines}</code></pre>` +
    here("hunk", hunk.id) +
    `</div>`
  );
}

// ---- files and groups ----

/** Added and deleted line counts, summed from the hunk lines rather than from a field
 *  beside them: the lines on the page are the ones being counted. */
/** The lines a set of hunks adds and removes. Exported so the chain can count a
 *  pull request's share from the same hunks the walkthrough partitions: two places
 *  reading one source can disagree about presentation but never about the number. */
export function stats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++;
      if (line.kind === "del") removed++;
    }
  }
  return { added, removed };
}

/** The mark a file row wears: the same reading routes.ts derives a group's mark with,
 *  applied to one file's share of the group. Both add and delete is a change. */
function kindOf(hunks: Hunk[]): StatementKind {
  const { added, removed } = stats(hunks);
  if (added > 0 && removed === 0) return "add";
  if (removed > 0 && added === 0) return "remove";
  return "change";
}

/** The hunks of one group, gathered by path, in the document's own hunk order. Order
 *  comes from `doc.hunks` rather than from the authored id list, so two groups can
 *  never disagree about which of two files comes first. */
function filesOf(group: Group, byId: Map<string, Hunk>, order: Map<string, number>): {
  path: string;
  hunks: Hunk[];
}[] {
  const wanted = group.hunks
    .map((id) => byId.get(id))
    .filter((h): h is Hunk => h !== undefined)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const files: { path: string; hunks: Hunk[] }[] = [];
  const at = new Map<string, { path: string; hunks: Hunk[] }>();
  for (const hunk of wanted) {
    const entry = at.get(hunk.path);
    if (entry) entry.hunks.push(hunk);
    else {
      const made = { path: hunk.path, hunks: [hunk] };
      at.set(hunk.path, made);
      files.push(made);
    }
  }
  return files;
}

function fileRow(
  file: { path: string; hunks: Hunk[] },
  note: string | undefined,
  domId: string,
  here: QuestionsHere,
): string {
  const { added, removed } = stats(file.hunks);
  const kind = kindOf(file.hunks);
  const lang = langOfPath(file.path);
  const lines = file.hunks
    .map((hunk, i) => hunkBlock(hunk, file.hunks[i - 1], lang, here))
    .join("");
  return (
    `<details class="frow">` +
    `<summary>${icon("chev", "tick")}<span class="fhead">` +
    `${icon(kind, `ic k-${kind}`, KIND_LABEL[kind])}` +
    `<span class="fpath">${escapeHtml(file.path)}</span>` +
    // U+2212, the minus sign: the count is a quantity, not a diff glyph.
    `<span class="fstat">+${added} −${removed}</span>` +
    `${icon("cue", "cue")}</span>` +
    (note === undefined ? "" : `<span class="fnote">${safeInline(note)}</span>`) +
    `</summary>` +
    `<div class="frow-body">` +
    here("file", file.path) +
    `<div class="filediff" id="${escapeHtml(domId)}">${lines}</div>` +
    `</div></details>`
  );
}

/** Ascending significance, the id as the tiebreak. Two renders of one document put the
 *  groups in the same order because the tiebreak is total. */
export function groupsInOrder(groups: Group[]): Group[] {
  return [...groups].sort(
    (a, b) => a.significance - b.significance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function groupBlock(
  group: Group,
  byId: Map<string, Hunk>,
  order: Map<string, number>,
  d: EntityDelta | null,
  here: QuestionsHere,
): string {
  const files = filesOf(group, byId, order);
  // The badge counts hunks, not files: a group is a set of hunks, and the number beside
  // its title is how much of the diff it holds.
  const count = files.reduce((n, f) => n + f.hunks.length, 0);
  // One note per path, and every note's path is a path the group's own hunks touch:
  // both are validator rules (file_note_duplicate, file_note_orphan), so nothing
  // authored is dropped here.
  const notes = new Map<string, string>();
  for (const n of group.fileNotes) if (!notes.has(n.path)) notes.set(n.path, n.text);
  const rows = files
    .map((f, i) => fileRow(f, notes.get(f.path), `fd-${group.id}-${i}`, here))
    .join("");
  // Marked first, then tested for emptiness: a paragraph cleared between versions
  // still owes the reader its prior words, and its chip owes them a mark.
  const gsum = marked(safeBlock(group.paragraph), d, "paragraph", group.id);
  // The file list is the partition of the diff this group claims. It is already on
  // the page as rows, but a row that left it leaves no trace there, so when the
  // membership moves the paths come out as the words they are.
  const gfiles = touched(d, "files")
    ? `<p class="gfiles">${marked(groupFilesHtml(files.map((f) => f.path)), d, "files", group.id)}</p>`
    : "";
  return (
    `<details class="grp" id="${escapeHtml(group.id)}" data-kind="${escapeHtml(group.kind)}">` +
    `<summary>${icon("chev", "tick")}` +
    `${icon(group.kind, `ic ic-lg k-${group.kind}`, KIND_LABEL[group.kind])}` +
    `<span class="gname">${marked(safeInline(group.title), d, "title", group.id)}</span>` +
    `${chip(d)}` +
    `<span class="gcount">${count}</span>` +
    `</summary>` +
    `<div class="grp-body">` +
    // Block markdown, the way the data model defines it: a group paragraph may carry
    // emphasis, a link, a list or a fenced block.
    (gsum === "" ? "" : `<div class="gsum">${gsum}</div>`) +
    gfiles +
    kindMark(d, group.id, group.kind) +
    here("group", group.id) +
    `<div class="frows">${rows}</div>` +
    `</div></details>`
  );
}

/** The whole section. Every hunk the document carries reaches the page exactly once,
 *  because the groups partition them and each group draws the ones it names. */
export function walkthroughSection(
  doc: ReviewDoc,
  delta: DeltaIndex | null = null,
  here: QuestionsHere = () => "",
): string {
  const byId = new Map(doc.hunks.map((h) => [h.id, h] as const));
  const order = new Map(doc.hunks.map((h, i) => [h.id, i] as const));
  const groups = groupsInOrder(doc.groups)
    .map((g) => groupBlock(g, byId, order, delta ? delta.get("group", g.id) : null, here))
    .join("");
  // A group the base version had and this one does not is a stub, like any other
  // removed entity: the walkthrough is a partition of the diff, and a partition
  // that quietly lost a part is a partition a reader cannot check.
  const removed = delta
    ? delta
        .removed("group")
        .map(
          (e) =>
            `<details class="grp dgoneunit" id="dgone-${safeId(e.id)}">` +
            // A removed group keeps the kind it was removed with, in its icon, the
            // way every other removed row does.
            `<summary>${icon("chev", "tick")}${
              e.formerKind === null
                ? ""
                : icon(e.formerKind, `ic k-${escapeHtml(e.formerKind)}`, e.formerKind)
            }` +
            `<span class="gname"><span class="dp dpstub">${e.former ? e.former.head : ""}</span></span>` +
            chip(e) +
            `</summary>` +
            `<div class="grp-body">${(e.former ? e.former.body : [])
              .map((h) => `<div class="dp dpb">${h}</div>`)
              .join("")}</div></details>`,
        )
        .join("")
    : "";
  return `<section id="walkthrough"><h2>Walkthrough</h2><div class="walk">${groups}${removed}</div></section>`;
}
