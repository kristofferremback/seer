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

import { escapeHtml } from "../pages";

/** Where a rejected construct sits in the source. All 1-based except `offset`. */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

/** A construct outside the subset. `construct` is the name; `text` is what was written. */
export class MarkdownRejection extends Error {
  constructor(
    readonly construct: string,
    readonly position: Position,
    readonly text: string,
  ) {
    super(
      `${construct} is not allowed here (line ${position.line}, column ${position.column})` +
        (text ? `: ${text}` : ""),
    );
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
  | { kind: "list"; ordered: boolean; items: SourceLine[][] };

const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;
const UNORDERED = /^ {0,3}([-*+])(?:[ \t]+|$)/;
const ORDERED = /^ {0,3}(\d{1,9})[.)](?:[ \t]+|$)/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?$/;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^<>]*>?/;
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

  if (text.trimStart().startsWith("|") || TABLE_DELIMITER.test(text)) {
    reject("table", at(text.length - text.trimStart().length), text.trim());
  }

  const definition = /^ {0,3}\[[^\]]*\]:/.exec(text);
  if (definition) reject("link reference definition", at(0), definition[0]!);
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
      if (lang.includes("`")) {
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
      const items: SourceLine[][] = [];
      for (; i < lines.length; i++) {
        const item = lines[i]!;
        if (isBlank(item.text)) break;
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
          if (indent > 0 && items.length > 0) {
            reject("nested list", positionOf(starts, item.offset), item.text.trim());
          }
          items.push([{ text: item.text.slice(marker[0]!.length), offset: item.offset + marker[0]!.length }]);
          continue;
        }
        if (items.length === 0) break;
        if (/^ {4,}\S/.test(item.text)) {
          reject("indented code block", positionOf(starts, item.offset), item.text.trim());
        }
        items[items.length - 1]!.push(item);
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
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

const FULL_INLINE: InlineOptions = { links: true, emphasis: true };
const CODE_ONLY: InlineOptions = { links: false, emphasis: false };

/** http(s) absolute, or a same-origin path or fragment. Everything else is named. */
function renderUrl(raw: string, position: Position): string {
  const url = raw.trim();
  if (url === "") reject("empty link url", position, raw);
  if (/[\s<>"'`\\]/.test(url)) reject("link url", position, url);
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

function renderInlineInto(
  text: string,
  offset: number,
  starts: number[],
  options: InlineOptions,
): string {
  let out = "";
  let plain = "";
  const at = (i: number) => positionOf(starts, offset + i);
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
      if (!options.links) reject("link", at(i), "[");
      const parsed = parseLink(text, i);
      if (parsed) {
        flush();
        const href = renderUrl(parsed.url, at(i + parsed.urlAt));
        const label = renderInlineInto(parsed.label, offset + i + 1, starts, {
          links: false,
          emphasis: options.emphasis,
        });
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
      if (!options.emphasis) reject("emphasis", at(i), "*");
      const strong = text.startsWith("**", i);
      const marker = strong ? "**" : "*";
      const body = closingEmphasis(text, i, marker);
      if (body !== null) {
        flush();
        const inner = renderInlineInto(text.slice(i + marker.length, body), offset + i + marker.length, starts, options);
        out += strong ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
        i = body + marker.length;
        continue;
      }
      plain += marker;
      i += marker.length;
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

/** `[label](url)` with balanced brackets in the label and no nesting in the url. */
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
  const close = text.indexOf(")", i + 2);
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
      const items = block.items.map((item) => {
        const text = item.map((l) => l.text.trim()).join("\n");
        return `<li>${renderInlineInto(text, item[0]!.offset, starts, FULL_INLINE)}</li>`;
      });
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const text = block.lines.map((l) => l.text.trim()).join("\n");
    out.push(`<p>${renderInlineInto(text, block.lines[0]!.offset, starts, FULL_INLINE)}</p>`);
  }
  return out.join("\n");
}

function normalize(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Checks a multi-line authored field against the subset. Never throws. */
export function validate(source: string): ValidationResult {
  try {
    const text = normalize(source);
    const starts = lineStarts(text);
    renderBlocks(parseBlocks(text, starts), starts);
    return { ok: true };
  } catch (err) {
    if (err instanceof MarkdownRejection) return fail(err);
    throw err;
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
    if (err instanceof MarkdownRejection) return fail(err);
    throw err;
  }
}

/** Renders a one-line field. Throws `MarkdownRejection` on any markup beyond inline code. */
export function renderInline(source: string): string {
  const text = normalize(source);
  const starts = lineStarts(text);
  if (text.includes("\n")) {
    reject("line break", positionOf(starts, text.indexOf("\n")), "\\n");
  }
  rejectForbiddenLine({ text, offset: 0 }, starts, false);
  const list = UNORDERED.exec(text) ?? ORDERED.exec(text);
  if (list) reject("list", positionOf(starts, 0), list[0]!.trim());
  return renderInlineInto(text, 0, starts, CODE_ONLY);
}
