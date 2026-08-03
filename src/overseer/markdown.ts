// Constrained markdown: the only markup an authored field may carry.
//
// The subset is fixed by the data model: emphasis, inline code, links, ordered and
// unordered lists, fenced code. Everything else is refused by name rather than
// stripped, because a silently swallowed heading is a payload the skill believes it
// published and the reader never sees. One-line fields (`text`, `gist`, `title`,
// captions, checks) go through the inline entry point instead: plain text and inline
// code, nothing more.
//
// The parser is deliberately its own thing rather than a library. Every text node
// leaves through `escapeHtml`, every tag this file emits is written literally here,
// and the set of them is closed: p, em, strong, code, a, ul, ol, li, pre. A reader
// auditing the output for injection has one file to read.
//
// The line between refusing and passing through is this: markdown that another dialect
// would style is left as literal escaped text, so the reader sees exactly what was
// written; only constructs that would otherwise disappear from the page are refused by
// name. That is why `_emph_`, `__strong__`, `- [ ] task` and `<https://autolink>` render
// as the characters they are, while a heading, a table or a raw tag is named and refused.
//
// A rejection quotes the offending source verbatim, so `message` and `text` are safe in
// a JSON body but must go through `escapeHtml` before reaching any HTML template.

import { escapeHtml } from "../escape";

/**
 * Where a rejected construct sits in the source. `line` and `column` are 1-based.
 *
 * `offset` indexes the *normalized* source, not the string the caller passed: parsing
 * first drops carriage returns and expands leading tabs to four spaces, so an offset
 * into a CRLF or tab-indented original would land a character or two short. Report it,
 * do not use it to slice the caller's text.
 */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

/** A construct outside the subset. `construct` is the name; `text` is what was written. */
/**
 * Longest offending snippet echoed back to the author. A rejected line can be the whole
 * body of a document, and neither the message nor a 422 body should carry it verbatim.
 */
export const MAX_REJECTION_TEXT = 120;

function clampText(text: string): string {
  return text.length <= MAX_REJECTION_TEXT ? text : `${text.slice(0, MAX_REJECTION_TEXT)}...`;
}

export class MarkdownRejection extends Error {
  readonly text: string;

  constructor(
    readonly construct: string,
    readonly position: Position,
    text: string,
  ) {
    const clamped = clampText(text);
    super(
      `${construct} is not allowed here (line ${position.line}, column ${position.column})` +
        (clamped ? `: ${clamped}` : ""),
    );
    this.text = clamped;
    this.name = "MarkdownRejection";
  }
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; construct: string; position: Position; text: string; message: string };

function reject(construct: string, position: Position, text = ""): never {
  throw new MarkdownRejection(construct, position, text);
}

function fail(err: MarkdownRejection): ValidationResult {
  return {
    ok: false,
    construct: err.construct,
    position: err.position,
    text: err.text,
    message: err.message,
  };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Line starts, so an offset can be reported as a line and column. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

function positionOf(starts: number[], offset: number): Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1, offset };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface SourceLine {
  text: string;
  /** Offset of the first character of the line in the source. */
  offset: number;
}

type Block =
  | { kind: "paragraph"; lines: SourceLine[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: SourceLine[][] };

const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
// The info string is the whole rest of the line, so a multi-word one (```js foo) is
// still recognised as a fence and gets named by the LANGUAGE guard instead of falling
// through to paragraph handling, where it would shift fence pairing and silently
// swallow whatever follows. CommonMark would treat a backtick fence whose info string
// contains a backtick as paragraph text; this module rejects it by name instead,
// because a fence-shaped line that half-parses is exactly the ambiguity it refuses.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;
const UNORDERED = /^ {0,3}([-*+])(?:[ \t]+|$)/;
const ORDERED = /^ {0,3}(\d{1,9})[.)](?:[ \t]+|$)/;
// GFM's delimiter cell is `:?-+:?`, so a single hyphen is enough. Matching only two or
// more left `a|b` over `-|-` rendering as a real table everywhere else while this module
// reflowed it into a paragraph of literal pipes.
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?$/;
// The closing `>` is required. Without it `i<n and then exits` reads as a tag the author
// never wrote, and CommonMark treats an unterminated `<name ...` as literal text anyway.
// Nothing is lost by the tightening: an unmatched `<` still leaves as `&lt;`.
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^<>]*>/;
const ATTRIBUTE_LESS_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*>/;

/**
 * Constructs that are refused wherever they appear at the head of a line. Checked
 * before anything decides what the line is, so a heading inside a paragraph is as
 * loud as one on its own.
 */
function rejectForbiddenLine(line: SourceLine, starts: number[], previousWasText: boolean): void {
  const at = (column: number) => positionOf(starts, line.offset + column);
  const text = line.text;

  const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(text);
  if (heading) reject("heading", at(heading.index), heading[1]!);
  if (/^ {0,3}#{7,}/.test(text)) reject("heading", at(0), text.trim());

  if (/^ {0,3}>/.test(text)) reject("blockquote", at(text.indexOf(">")), ">");

  // A setext underline only underlines something, so it needs a paragraph above it.
  if (previousWasText && /^ {0,3}(=+|-+)[ \t]*$/.test(text)) {
    reject("heading", at(0), text.trim());
  }
  if (THEMATIC_BREAK.test(text)) reject("thematic break", at(0), text.trim());

  // A delimiter row on its own is only a table if it has a pipe: a bare `-` is an empty
  // list item, and `---` is a thematic break, already named above.
  if (text.trimStart().startsWith("|") || (text.includes("|") && TABLE_DELIMITER.test(text))) {
    reject("table", at(text.length - text.trimStart().length), text.trim());
  }

  const definition = /^ {0,3}\[[^\]]*\]:/.exec(text);
  if (definition) reject("link reference definition", at(0), definition[0]!);
}

/**
 * True when a `>` turns up on a later line of the same block before the next `<` does,
 * which is what makes an unterminated `<name ...` an actual tag rather than prose.
 */
function closesOnALaterLine(lines: SourceLine[], from: number): boolean {
  for (let j = from; j < lines.length; j++) {
    const text = lines[j]!.text;
    if (isBlank(text)) return false;
    const gt = text.indexOf(">");
    const lt = text.indexOf("<");
    if (gt !== -1 && (lt === -1 || gt < lt)) return true;
    if (lt !== -1) return false;
  }
  return false;
}

/**
 * A tag opened at the end of a line closes on the next one. The next line is checked
 * for forbidden constructs first, so without this the tag would be reported under
 * whatever name that line happens to match. It has to actually close, though: `a<b`
 * followed by `c<d` is arithmetic, not markup.
 */
function rejectDanglingTag(line: SourceLine, lines: SourceLine[], next: number, starts: number[]): void {
  const open = /<\/?[A-Za-z][A-Za-z0-9-]*[^<>]*$/.exec(line.text);
  if (!open) return;
  if (!closesOnALaterLine(lines, next)) return;
  const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(open[0]!)![1]!;
  reject(
    "raw HTML tag",
    positionOf(starts, line.offset + open.index),
    `<${open[0]!.startsWith("</") ? "/" : ""}${name}>`,
  );
}

/** Table rows without a leading pipe still need catching: they name the row after them. */
function rejectTableRow(line: SourceLine, next: SourceLine | undefined, starts: number[]): void {
  if (!next || !line.text.includes("|")) return;
  if (TABLE_DELIMITER.test(next.text) && next.text.includes("|")) {
    reject("table", positionOf(starts, line.offset + line.text.indexOf("|")), line.text.trim());
  }
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** True when the line at `index` opens another item of the same list, unindented. */
function continuesList(lines: SourceLine[], index: number, ordered: boolean): boolean {
  const next = lines[index];
  if (!next || isBlank(next.text)) return false;
  if (next.text.length !== next.text.trimStart().length) return false;
  return ordered ? ORDERED.test(next.text) : UNORDERED.test(next.text);
}

/** Splits the source into the blocks the subset knows, rejecting everything else. */
function parseBlocks(source: string, starts: number[]): Block[] {
  const lines: SourceLine[] = [];
  {
    let offset = 0;
    for (const text of source.split("\n")) {
      lines.push({ text, offset });
      offset += text.length + 1;
    }
  }

  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line.text)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line.text);
    if (fence) {
      const marker = fence[1]![0]!;
      const width = fence[1]!.length;
      const lang = fence[2]!;
      // An info string outside the language subset is named rather than dropped: the
      // author wrote it, and a silently discarded one is the same swallowed payload the
      // rest of this file exists to refuse.
      if (lang !== "" && !LANGUAGE.test(lang)) {
        reject("fenced code info string", positionOf(starts, line.offset), lang);
      }
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const candidate = lines[j]!.text;
        const close = FENCE.exec(candidate);
        if (close && close[1]![0] === marker && close[1]!.length >= width && close[2] === "") {
          closed = true;
          break;
        }
        body.push(candidate);
      }
      if (!closed) {
        reject("unclosed fenced code", positionOf(starts, line.offset), fence[1]!);
      }
      blocks.push({ kind: "code", lang, lines: body });
      i = j + 1;
      continue;
    }

    const previousWasText =
      blocks.length > 0 && blocks[blocks.length - 1]!.kind === "paragraph" && i > 0 && !isBlank(lines[i - 1]!.text);
    rejectForbiddenLine(line, starts, previousWasText);
    rejectTableRow(line, lines[i + 1], starts);

    const unordered = UNORDERED.exec(line.text);
    const ordered = ORDERED.exec(line.text);
    if (unordered || ordered) {
      const isOrdered = !unordered;
      const start = isOrdered ? Number(ordered![1]!) : 1;
      const items: SourceLine[][] = [];
      const listStart = i;
      // The indent the author gave the list as a whole. Items at this indent are siblings;
      // only a deeper one is nested.
      const baseIndent = line.text.length - line.text.trimStart().length;
      for (; i < lines.length; i++) {
        const item = lines[i]!;
        if (i > listStart && !isBlank(lines[i - 1]!.text)) {
          // Same reason as in the paragraph loop: name a split tag as a tag, before the
          // line it spills onto gets named as whatever it resembles.
          rejectDanglingTag(lines[i - 1]!, lines, i, starts);
        }
        if (isBlank(item.text)) {
          // Blank lines between items are a normal authoring style, so the list carries
          // on across them rather than splitting into a second list that restarts at 1.
          if (continuesList(lines, i + 1, isOrdered)) continue;
          break;
        }
        rejectForbiddenLine(item, starts, false);
        rejectTableRow(item, lines[i + 1], starts);
        if (FENCE.test(item.text)) {
          reject("fenced code inside a list", positionOf(starts, item.offset), item.text.trim());
        }
        const u = UNORDERED.exec(item.text);
        const o = ORDERED.exec(item.text);
        const marker = u ?? o;
        if (marker) {
          if (!!u === isOrdered) break; // the other kind of list starts a new block
          const indent = item.text.length - item.text.trimStart().length;
          if (indent > baseIndent && items.length > 0) {
            reject("nested list", positionOf(starts, item.offset), item.text.trim());
          }
          const content: SourceLine = {
            text: item.text.slice(marker[0]!.length),
            offset: item.offset + marker[0]!.length,
          };
          // The marker hid the head of the line from the anchored patterns above.
          rejectForbiddenLine(content, starts, false);
          items.push([content]);
          continue;
        }
        if (items.length === 0) break;
        if (/^ {4,}\S/.test(item.text)) {
          reject("indented code block", positionOf(starts, item.offset), item.text.trim());
        }
        items[items.length - 1]!.push(item);
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    if (/^ {4,}\S/.test(line.text)) {
      reject("indented code block", positionOf(starts, line.offset), line.text.trim());
    }

    const paragraph: SourceLine[] = [];
    for (; i < lines.length; i++) {
      const p = lines[i]!;
      if (isBlank(p.text)) break;
      if (paragraph.length > 0) {
        rejectDanglingTag(paragraph[paragraph.length - 1]!, lines, i, starts);
        rejectForbiddenLine(p, starts, true);
        rejectTableRow(p, lines[i + 1], starts);
        if (FENCE.test(p.text) || UNORDERED.test(p.text) || ORDERED.test(p.text)) break;
      }
      paragraph.push(p);
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

interface InlineOptions {
  /** Links and emphasis are off inside link text, and off entirely for one-line fields. */
  links: boolean;
  emphasis: boolean;
}

/**
 * How deep emphasis and link labels may nest before the text is rejected by name. A
 * stated contract beats letting the JS stack decide: the same input has to reject on
 * every engine, not wherever that engine happens to run out of frames.
 */
const MAX_INLINE_DEPTH = 64;

const FULL_INLINE: InlineOptions = { links: true, emphasis: true };
const CODE_ONLY: InlineOptions = { links: false, emphasis: false };

/** http(s) absolute, or a same-origin path or fragment. Everything else is named. */
function renderUrl(raw: string, position: Position): string {
  const url = raw.trim();
  if (url === "") reject("empty link url", position, raw);
  // Control bytes included: a destination carrying them is neither http(s) nor a clean
  // same-origin path, and browsers rewrite them rather than refusing.
  if (/[\s<>"'`\\\u0000-\u001f\u007f]/.test(url)) reject("link url", position, url);
  if (url.startsWith("/") && !url.startsWith("//")) return escapeHtml(url);
  if (url.startsWith("#") || url.startsWith("?")) return escapeHtml(url);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (!scheme) {
    // A bare relative path is still same-origin, but only if it cannot be read as a
    // scheme-less protocol-relative url.
    if (url.startsWith("//")) reject("protocol-relative link url", position, url);
    return escapeHtml(url);
  }
  const name = scheme[1]!.toLowerCase();
  if (name !== "http" && name !== "https") {
    reject(`${name}: link url`, position, url);
  }
  return escapeHtml(url);
}

/** Rejects a raw HTML tag or comment starting at `index`, if that is what this is. */
function rejectHtml(text: string, index: number, position: Position): void {
  const rest = text.slice(index);
  if (rest.startsWith("<!--")) reject("raw HTML comment", position, "<!--");
  if (rest.startsWith("<!") || rest.startsWith("<?")) {
    reject("raw HTML declaration", position, rest.slice(0, 2));
  }
  const tag = HTML_TAG.exec(rest);
  const plain = ATTRIBUTE_LESS_TAG.exec(rest);
  const match = (tag && tag.index === 0 ? tag[0] : null) ?? (plain && plain.index === 0 ? plain[0] : null);
  if (match) {
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(match)![1]!;
    reject("raw HTML tag", position, `<${match.startsWith("</") ? "/" : ""}${name}>`);
  }
}

/**
 * Text handed to the inline renderer along with, per character, the offset it came
 * from in the source. Block parsing trims lines before joining them, so the two
 * cannot be related by a single base offset without misreporting positions.
 */
interface InlineSpan {
  text: string;
  offsets: number[];
}

/** Trims each line, joins with newlines, and keeps every character's source offset. */
function spanOfLines(lines: SourceLine[]): InlineSpan {
  let text = "";
  const offsets: number[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      text += "\n";
      offsets.push(line.offset > 0 ? line.offset - 1 : line.offset);
    }
    const lead = line.text.length - line.text.trimStart().length;
    const trimmed = line.text.trim();
    text += trimmed;
    for (let k = 0; k < trimmed.length; k++) offsets.push(line.offset + lead + k);
  });
  return { text, offsets };
}

function spanOfText(text: string, base: number): InlineSpan {
  const offsets: number[] = [];
  for (let k = 0; k < text.length; k++) offsets.push(base + k);
  return { text, offsets };
}

function subSpan(span: InlineSpan, start: number, end: number): InlineSpan {
  return { text: span.text.slice(start, end), offsets: span.offsets.slice(start, end) };
}

function renderInlineInto(
  span: InlineSpan,
  starts: number[],
  options: InlineOptions,
  depth = 0,
): string {
  const text = span.text;
  let out = "";
  let plain = "";
  const at = (i: number) =>
    positionOf(starts, span.offsets[i] ?? (span.offsets[span.offsets.length - 1] ?? 0) + 1);
  if (depth > MAX_INLINE_DEPTH) reject("nesting too deep", at(0), text.slice(0, 8));
  const flush = () => {
    out += escapeHtml(plain);
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;

    if (c === "\\" && i + 1 < text.length && /[\\`*_[\]()#+\-.!<>|~]/.test(text[i + 1]!)) {
      plain += text[i + 1]!;
      i += 2;
      continue;
    }

    if (c === "<") {
      rejectHtml(text, i, at(i));
      plain += c;
      i++;
      continue;
    }

    if (c === "`") {
      let width = 0;
      while (text[i + width] === "`") width++;
      const closer = text.indexOf("`".repeat(width), i + width);
      const valid =
        closer !== -1 && text[closer + width] !== "`" && !text.slice(i + width, closer).includes("\n");
      if (valid) {
        let body = text.slice(i + width, closer);
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "") {
          body = body.slice(1, -1);
        }
        flush();
        out += `<code>${escapeHtml(body)}</code>`;
        i = closer + width;
        continue;
      }
      plain += "`".repeat(width);
      i += width;
      continue;
    }

    if (c === "!" && text[i + 1] === "[") {
      const image = /^!\[[^\]]*\]\([^)]*\)/.exec(text.slice(i));
      reject("inline image", at(i), image ? image[0]! : "![");
    }

    if (c === "[") {
      if (text[i + 1] === "^") reject("footnote reference", at(i), "[^");
      // A bracket that never forms `[label](url)` is ordinary text, in every mode.
      const parsed = parseLink(text, i);
      if (parsed) {
        if (!options.links) reject("link", at(i), text.slice(i, parsed.end));
        flush();
        const href = renderUrl(parsed.url, at(i + parsed.urlAt));
        const label = renderInlineInto(
          subSpan(span, i + 1, i + 1 + parsed.label.length),
          starts,
          { links: false, emphasis: options.emphasis },
          depth + 1,
        );
        out += `<a href="${href}">${label}</a>`;
        i = parsed.end;
        continue;
      }
      plain += c;
      i++;
      continue;
    }

    if (c === "~" && text[i + 1] === "~") reject("strikethrough", at(i), "~~");

    if (c === "*") {
      // Longest delimiter first, falling back so `***x**` still reads as strong.
      const candidates = ["***", "**", "*"].filter((m) => text.startsWith(m, i));
      let marker = "";
      let body: number | null = null;
      for (const candidate of candidates) {
        const found = closingEmphasis(text, i, candidate);
        if (found !== null) {
          marker = candidate;
          body = found;
          break;
        }
      }
      if (body !== null) {
        // An asterisk that never closes is ordinary text, in every mode.
        if (!options.emphasis) reject("emphasis", at(i), marker);
        flush();
        const inner = renderInlineInto(
          subSpan(span, i + marker.length, body),
          starts,
          options,
          depth + 1,
        );
        out +=
          marker === "***"
            ? `<strong><em>${inner}</em></strong>`
            : marker === "**"
              ? `<strong>${inner}</strong>`
              : `<em>${inner}</em>`;
        i = body + marker.length;
        continue;
      }
      const literal = candidates[0]!;
      plain += literal;
      i += literal.length;
      continue;
    }

    plain += c;
    i++;
  }

  flush();
  return out;
}

/** The index of the closing delimiter for emphasis opened at `start`, or null. */
function closingEmphasis(text: string, start: number, marker: string): number | null {
  if (/[\s]/.test(text[start + marker.length] ?? " ")) return null;
  let i = start + marker.length;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      let width = 0;
      while (text[i + width] === "`") width++;
      const closer = text.indexOf("`".repeat(width), i + width);
      if (closer !== -1 && text[closer + width] !== "`") {
        i = closer + width;
        continue;
      }
      i += width;
      continue;
    }
    if (text.startsWith(marker, i)) {
      if (marker === "*" && text[i + 1] === "*") {
        i += 2;
        continue;
      }
      if (i === start + marker.length) return null;
      if (/\s/.test(text[i - 1] ?? " ")) {
        i += marker.length;
        continue;
      }
      return i;
    }
    i++;
  }
  return null;
}

interface ParsedLink {
  label: string;
  url: string;
  /** Offset of the url within the whole link, for position reporting. */
  urlAt: number;
  end: number;
}

/** `[label](url)` with balanced brackets in the label and balanced parens in the url. */
function parseLink(text: string, start: number): ParsedLink | null {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;
  // A url may carry parentheses of its own, as Wikipedia and MSDN links do, so the
  // destination ends at the paren that balances the opening one rather than at the
  // first one seen. An unbalanced url is not a link at all, and falls through to text.
  let close = -1;
  let parens = 1;
  for (let j = i + 2; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") {
      parens--;
      if (parens === 0) {
        close = j;
        break;
      }
    }
  }
  if (close === -1) return null;
  return {
    label: text.slice(start + 1, i),
    url: text.slice(i + 2, close),
    urlAt: i + 2 - start,
    end: close + 1,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,24}$/;

function renderBlocks(blocks: Block[], starts: number[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      const cls = LANGUAGE.test(block.lang) ? ` class="language-${escapeHtml(block.lang)}"` : "";
      const body = block.lines.length === 0 ? "" : `${escapeHtml(block.lines.join("\n"))}\n`;
      out.push(`<pre><code${cls}>${body}</code></pre>`);
      continue;
    }
    if (block.kind === "list") {
      const tag = block.ordered ? "ol" : "ul";
      // The author's first number is the list's number: renumbering from 1 would show
      // the reader a sequence nobody wrote.
      const attr = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map(
        (item) => `<li>${renderInlineInto(spanOfLines(item), starts, FULL_INLINE)}</li>`,
      );
      out.push(`<${tag}${attr}>${items.join("")}</${tag}>`);
      continue;
    }
    out.push(`<p>${renderInlineInto(spanOfLines(block.lines), starts, FULL_INLINE)}</p>`);
  }
  return out.join("\n");
}

function normalize(source: string): string {
  // Leading tabs become four spaces so the block guards, which are anchored on spaces,
  // see the indentation an author wrote with a tab. Without this a tab is a hole in the
  // reject-by-name contract: `\t# h` would come out as a paragraph.
  return source.replace(/\r\n?/g, "\n").replace(/^[ \t]+/gm, (run) => run.replace(/\t/g, "    "));
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Nesting is capped explicitly at `MAX_INLINE_DEPTH`, so pathological input is refused
 * by name at a stated limit. This RangeError catch is the belt to that braces: if some
 * other recursion ever exhausts the stack, the author gets a 422 rather than a 500.
 * Callers must still cap the length of a field before validating. Bun.serve is single
 * threaded, and this module is the floor, not the plan.
 */
const TOO_DEEP: Position = { line: 1, column: 1, offset: 0 };

function fromThrown(err: unknown): ValidationResult {
  if (err instanceof MarkdownRejection) return fail(err);
  if (err instanceof RangeError) return fail(new MarkdownRejection("nesting too deep", TOO_DEEP, ""));
  throw err;
}

/** Checks a multi-line authored field against the subset. Never throws. */
export function validate(source: string): ValidationResult {
  try {
    const text = normalize(source);
    const starts = lineStarts(text);
    renderBlocks(parseBlocks(text, starts), starts);
    return { ok: true };
  } catch (err) {
    return fromThrown(err);
  }
}

/** Renders a multi-line authored field. Throws `MarkdownRejection` on anything outside the subset. */
export function render(source: string): string {
  const text = normalize(source);
  const starts = lineStarts(text);
  return renderBlocks(parseBlocks(text, starts), starts);
}

/** Checks a one-line field: plain text and inline code, nothing else. Never throws. */
export function validateInline(source: string): ValidationResult {
  try {
    renderInline(source);
    return { ok: true };
  } catch (err) {
    return fromThrown(err);
  }
}

/** Renders a one-line field. Throws `MarkdownRejection` on any markup beyond inline code. */
export function renderInline(source: string): string {
  const whole = normalize(source);
  const starts = lineStarts(whole);
  if (whole.includes("\n")) {
    reject("line break", positionOf(starts, whole.indexOf("\n")), "\\n");
  }
  // A one-line field has no indentation semantics, so leading whitespace is dropped
  // before the guards run. Otherwise `\t# h` would slip past the `^ {0,3}#` anchor that
  // catches `# h` and `  # h`, which is a hole in the reject-by-name contract.
  const lead = whole.length - whole.trimStart().length;
  const text = whole.slice(lead);
  rejectForbiddenLine({ text, offset: lead }, starts, false);
  const list = UNORDERED.exec(text) ?? ORDERED.exec(text);
  if (list) reject("list", positionOf(starts, lead), list[0]!.trim());
  return renderInlineInto(spanOfText(text, lead), starts, CODE_ONLY);
}
