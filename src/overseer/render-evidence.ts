// Evidence, drawn. The blocks a statement or a note carries under its prose, plus
// the small pieces the rest of the renderer shares with them: the icon call, the two
// markdown entry points wrapped so a stored document can never crash a page, and the
// snippet panel every quoted ref is drawn in.
//
// Five of the six evidence kinds live here, the ones that are not a diff: ref, payload,
// example, attachment and bundle. The sixth is the figure, whose layout lives in
// figure.ts because it is a drawing rather than a block of markup; this file holds the
// one line that puts it on the page.
//
// Snippet lines are emitted as escaped plain text. The token block transcribed from the
// prototype carries the syntax classes (kw, st, cm, ty) and the elision marker (el), but
// nothing here assigns them yet: classing a snippet reads the same source the diff work
// reads, so it arrives with that.
//
// Everything that reaches HTML from a stored document goes through escapeHtml or
// through the constrained markdown renderer, which escapes every text node itself.
// Nothing here interpolates a raw authored string into markup.

import { escapeHtml } from "../escape";
import { lineDiff } from "./diff";
import { figureSvg } from "./figure";
import { render as renderMarkdown, renderInline } from "./markdown";
import { codeHtml, langOfName, langOfPath } from "./render-diff";
import type { Evidence, Figure, Payload, Ref } from "./types";

/** One sprite mark. `label` makes it an image with a name; without one it is decoration. */
export function icon(id: string, cls = "ic", label?: string): string {
  const naming = label === undefined ? `aria-hidden="true"` : `role="img" aria-label="${escapeHtml(label)}"`;
  return `<svg class="${escapeHtml(cls)}" ${naming}><use href="#i-${escapeHtml(id)}"/></svg>`;
}

/** Block markdown from a stored document. A published document passed the validator,
 *  so a rejection here means the document predates a rule or the parser moved under it.
 *  Neither is worth a blank page: the source is shown as the characters it is. */
export function safeBlock(source: string | null | undefined): string {
  if (source == null || source.trim() === "") return "";
  try {
    return renderMarkdown(source);
  } catch (err) {
    console.error("overseer: block markdown threw on a stored document", {
      source: source.slice(0, 80),
      error: err,
    });
    return `<p>${escapeHtml(source)}</p>`;
  }
}

/** Inline markdown (plain text and inline code) for one-line fields. Same fallback.
 *  Nullish in, empty out: a stored document may predate a field becoming required,
 *  and an absent optional field must never cost the page. */
export function safeInline(source: string | null | undefined): string {
  if (source == null) return "";
  try {
    return renderInline(source);
  } catch (err) {
    console.error("overseer: inline markdown threw on a stored document", {
      source: source.slice(0, 80),
      error: err,
    });
    return escapeHtml(source);
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The id a ref's snippet panel is addressable at. A ref resolves once per pointer and
 *  is shared by every site that cites it, so the owner is part of the id: two statements
 *  quoting the same lines each get their own panel rather than one duplicated id. */
export function foldId(ownerId: string, ref: Ref, suffix = ""): string {
  return `${ownerId}-${suffix}${ref.id}`;
}

/** A chip in a row's head, pointing at the panel below it. Without scripting this is a
 *  fragment jump and the panel's `:target` rules open it; with scripting the panel is
 *  opened in place. Either way the anchor is the whole mechanism. */
export function refChip(ownerId: string, ref: Ref, suffix = ""): string {
  const label = `${baseName(ref.path)}:${ref.startLine}`;
  return (
    `<a class="ref" href="#${escapeHtml(foldId(ownerId, ref, suffix))}">` +
    `${icon("chev", "rtick")}${escapeHtml(label)}</a>`
  );
}

/** Every citation a row carries, with the file said once. Three refs into one file
 *  used to spend the file name three times beside the text, which is the widest
 *  thing on the row and the least informative repetition on the page. The name
 *  becomes a label and each line keeps its own link, so nothing is lost but the
 *  repetition. */
export function refChips(ownerId: string, refs: Ref[], suffix = ""): string {
  const byPath = new Map<string, Ref[]>();
  for (const r of refs) {
    const at = byPath.get(r.path);
    if (at) at.push(r);
    else byPath.set(r.path, [r]);
  }
  return [...byPath.entries()]
    .map(([path, group]) => {
      if (group.length === 1) return refChip(ownerId, group[0]!, suffix);
      const lines = group
        .map(
          (r) =>
            `<a class="refline" href="#${escapeHtml(foldId(ownerId, r, suffix))}">` +
            `${escapeHtml(String(r.startLine))}</a>`,
        )
        .join("");
      return (
        `<span class="ref refset">${icon("chev", "rtick")}` +
        `<span class="reffile">${escapeHtml(baseName(path))}</span>${lines}</span>`
      );
    })
    .join("");
}

function githubBlobUrl(ref: Ref): string {
  return (
    `https://github.com/${ref.repo}/blob/${ref.sha}/${ref.path}` +
    `#L${ref.startLine}-L${ref.endLine}`
  );
}

/** The quoted lines, numbered from the pointer's own start. Highlighted lines are the
 *  ones the pointer named, counted in the file's numbering rather than the panel's. */
function snippetLines(ref: Ref): string {
  // Quoted code is code. It was plain escaped text while the walkthrough's hunks
  // carried syntax classes, so a citation and a diff of the same file did not look
  // like the same language, and a page where everything reads with equal weight is
  // a page that has stopped ranking anything.
  const lang = langOfPath(ref.path);
  const highlight = new Set(ref.highlight);
  const lines = ref.snippet.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines
    .map((line, i) => {
      const no = ref.startLine + i;
      const cls = highlight.has(no) ? "l hl" : "l";
      return `<span class="${cls}"><span class="n">${no}</span>${codeHtml(line, lang)}</span>`;
    })
    .join("");
}

/** A ref, folded. The head names the file, the commit it is quoted at, the line range
 *  and whether those lines belong to a pull request in this review. */
export function refFold(ownerId: string, ref: Ref, suffix = ""): string {
  const origin = ref.origin === "in_stack" ? "in this stack" : "outside this stack";
  return (
    `<details class="fold" id="${escapeHtml(foldId(ownerId, ref, suffix))}">` +
    `<summary>${icon("chev", "tick")}<span class="fh">` +
    `<span class="nb"><b>${escapeHtml(ref.path)}</b> ·</span> ` +
    `<span class="nb">${escapeHtml(origin)} ·</span> ` +
    `<span class="nb">${escapeHtml(shortSha(ref.sha))} ·</span> ` +
    `<span class="nb">L${ref.startLine}-${ref.endLine}</span>` +
    `</span>${icon("cue", "cue")}</summary>` +
    `<div class="fold-body">` +
    `<pre class="snip scroll-x"><code>${snippetLines(ref)}</code></pre>` +
    `<p class="fold-out"><a href="${escapeHtml(githubBlobUrl(ref))}">` +
    `${escapeHtml(`${ref.repo} at ${shortSha(ref.sha)}`)}</a></p>` +
    `</div></details>`
  );
}

// ---- payload ----

/** A payload as one diff, in the walkthrough's grammar. Two columns asked the reader
 *  to find the change themselves, which is the one thing this page exists not to do,
 *  so before and after are aligned here and only what moved is marked.
 *
 *  No line numbers: a payload is a value, not a file, so there is nothing to count
 *  into and the gutter carries the glyph alone. An authored `highlight[]` marks a
 *  line the computed diff left as context; where the two disagree the diff wins,
 *  because it is derived and the highlight is authored. */
function payloadBlock(payload: Payload): string {
  const lang = payload.lang === "json" ? "json" : null;
  const rows = lineDiff(payload.before, payload.after);
  const numbers = new Set(payload.highlight.filter((h): h is number => typeof h === "number"));
  const keys = payload.highlight.filter((h): h is string => typeof h === "string");

  let after = 0;
  const body = rows
    .map((row) => {
      if (row.kind !== "del") after++;
      const flagged =
        row.kind === "ctx" &&
        (numbers.has(after) || keys.some((k) => k !== "" && row.content.includes(k)));
      const cls = row.kind === "ctx" ? (flagged ? "l hl" : "l") : `l ${row.kind}`;
      return (
        `<span class="${cls}"><span class="gut">` +
        `<span class="n"></span>` +
        `<span class="g">${escapeHtml(GLYPH[row.kind])}</span></span>` +
        codeHtml(row.content, lang, row.wordRanges) +
        `</span>`
      );
    })
    .join("");
  return `<div class="snipbox"><pre class="snip scroll-x"><code>${body}</code></pre></div>`;
}

const GLYPH: Record<"ctx" | "add" | "del", string> = { ctx: " ", add: "+", del: "-" };

// ---- example ----

/** An authored illustration. It is the one evidence kind that is invented rather than
 *  quoted, so it carries no line numbers and no path: nothing in it may look like a
 *  citation. Its caption says what it is, and the caption is required. */
/** The lines of an example, as the page draws them. Exported because the delta
 *  compares the markup a field is shown as, and this is that markup. */
export function exampleBodyHtml(text: string, lang?: string | null): string {
  const cls = langOfName(lang);
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `<span class="l">${codeHtml(line, cls)}</span>`).join("");
}

function exampleBlock(
  lang: string,
  text: string,
  caption: string,
  p: string,
  marks: EvidenceMarks | null,
): string {
  const body = mark(marks, `${p}-text`, exampleBodyHtml(text, lang));
  return (
    `<figure class="ev ev-example" data-lang="${escapeHtml(lang)}">` +
    `<div class="snipbox"><pre class="snip scroll-x"><code>${body}</code></pre></div>` +
    `<figcaption>${mark(marks, `${p}-caption`, safeInline(caption))}</figcaption></figure>`
  );
}

// ---- attachment, bundle, figure ----

function attachmentBlock(
  basePath: string,
  id: string,
  alt: string,
  caption: string,
  p: string,
  marks: EvidenceMarks | null,
): string {
  const src = `${basePath}/a/${encodeURIComponent(id)}`;
  const cap = mark(marks, `${p}-caption`, caption === "" ? "" : safeInline(caption));
  const figcaption = cap === "" ? "" : `<figcaption>${cap}</figcaption>`;
  return (
    `<figure class="ev ev-attachment">` +
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` +
    // Alt text is written for a reader who cannot see the image, so it has no place
    // on the page until it moves. When it moves it comes out where it can be read,
    // with the words it replaced one tap behind it.
    whenMoved(marks, `${p}-alt`, safeInline(alt)) +
    `${figcaption}</figure>`
  );
}

/** A bundle in the same workspace, resolved to the link it is served at rather than to
 *  a URL the author wrote. `version` null is the bundle as it stands. */
function bundleBlock(
  wsId: string,
  slug: string,
  version: number | null,
  caption: string,
  p: string,
  marks: EvidenceMarks | null,
): string {
  const href = version === null ? `/${wsId}/b/${slug}/` : `/${wsId}/b/${slug}/v/${version}/`;
  const label = version === null ? slug : `${slug} v${version}`;
  return (
    `<p class="ev ev-bundle">${icon("eye")}` +
    `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` +
    `<span class="ev-cap">${mark(marks, `${p}-caption`, safeInline(caption))}</span></p>`
  );
}

/** The figure, drawn. The graph is laid out server-side into one static SVG, and the
 *  whole drawing is a single image with its nodes and edges composed into the label.
 *  A label that moved comes out under the drawing rather than inside it: the SVG is
 *  laid out to the pixel and has nowhere to put a mark. */
function figureBlock(figure: Figure, p: string, marks: EvidenceMarks | null): string {
  const moved =
    figure.nodes.map((n) => whenMoved(marks, `${p}-node-${n.id}`, safeInline(n.label))).join("") +
    figure.edges
      .map((e, j) => whenMoved(marks, `${p}-edge-${j}`, safeInline(e.label)))
      .join("");
  return `<div class="ev ev-figure">${figureSvg(figure)}${moved}</div>`;
}

/** How this row's delta reaches the evidence it hangs off. Handed in rather than
 *  imported, so the marking module and the drawing module do not import each other. */
export interface EvidenceMarks {
  /** The field's markup, marked when the delta touched it and plain when it did not. */
  mark(field: string, html: string): string;
  /** Whether the delta touched the field at all. */
  touched(field: string): boolean;
  /** Fields the base version carried that this one does not, given the names it does. */
  dropped(current: string[]): string[];
}

const mark = (marks: EvidenceMarks | null, field: string, html: string): string =>
  marks ? marks.mark(field, html) : html;

/** A field that is only on the page when it moved. */
const whenMoved = (marks: EvidenceMarks | null, field: string, html: string): string =>
  marks && marks.touched(field) ? `<p class="ev-was">${marks.mark(field, html)}</p>` : "";

/** Every evidence block a statement or a note carries, in the order it was authored.
 *  `ownerId` is the statement or note the evidence hangs off, so its ref panels are
 *  addressable without colliding with the same ref quoted elsewhere. */
export function renderEvidence(
  evidence: Evidence[],
  ownerId: string,
  ctx: { wsId: string; basePath: string },
  marks: EvidenceMarks | null = null,
  names: string[] = [],
): string {
  const blocks = evidence
    .map((e, i) => {
      const p = `ev-${i}`;
      switch (e.type) {
        case "ref":
          return refFold(ownerId, e.ref, `ev${i}-`);
        case "payload":
          return payloadBlock(e.payload);
        case "example":
          return exampleBlock(e.example.lang, e.example.text, e.example.caption, p, marks);
        case "attachment":
          return attachmentBlock(
            ctx.basePath,
            e.attachment.id,
            e.attachment.alt,
            e.attachment.caption,
            p,
            marks,
          );
        case "bundle":
          return bundleBlock(ctx.wsId, e.bundle.slug, e.bundle.version, e.bundle.caption, p, marks);
        case "figure":
          return figureBlock(e.figure, p, marks);
      }
    })
    .join("");
  // Evidence the base version carried and this one does not. It keeps its place at
  // the end of the list rather than vanishing, holding only the prior words behind
  // their own disclosure, the way a dropped check does.
  const gone = marks
    ? marks
        .dropped(names)
        .map((f) => `<p class="ev-was">${marks.mark(f, "")}</p>`)
        .join("")
    : "";
  return blocks + gone;
}
