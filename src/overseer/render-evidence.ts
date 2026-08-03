// Evidence, drawn. The blocks a statement or a note carries under its prose, plus
// the small pieces the rest of the renderer shares with them: the icon call, the two
// markdown entry points wrapped so a stored document can never crash a page, and the
// snippet panel every quoted ref is drawn in.
//
// Five of the six evidence kinds live here, the ones that are not a diff: ref, payload,
// example, attachment and bundle. A figure is a drawing and belongs with the diff work;
// it renders as its nodes and edges in the meantime rather than vanishing, because a
// silently dropped block is evidence the author believes is on the page.
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
import { render as renderMarkdown, renderInline } from "./markdown";
import type { Evidence, Figure, Payload, Ref } from "./types";

/** One sprite mark. `label` makes it an image with a name; without one it is decoration. */
export function icon(id: string, cls = "ic", label?: string): string {
  const naming = label === undefined ? `aria-hidden="true"` : `role="img" aria-label="${escapeHtml(label)}"`;
  return `<svg class="${escapeHtml(cls)}" ${naming}><use href="#i-${escapeHtml(id)}"/></svg>`;
}

/** Block markdown from a stored document. A published document passed the validator,
 *  so a rejection here means the document predates a rule or the parser moved under it.
 *  Neither is worth a blank page: the source is shown as the characters it is. */
export function safeBlock(source: string): string {
  if (source.trim() === "") return "";
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

/** Inline markdown (plain text and inline code) for one-line fields. Same fallback. */
export function safeInline(source: string): string {
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

function githubBlobUrl(ref: Ref): string {
  return (
    `https://github.com/${ref.repo}/blob/${ref.sha}/${ref.path}` +
    `#L${ref.startLine}-L${ref.endLine}`
  );
}

/** The quoted lines, numbered from the pointer's own start. Highlighted lines are the
 *  ones the pointer named, counted in the file's numbering rather than the panel's. */
function snippetLines(ref: Ref): string {
  const highlight = new Set(ref.highlight);
  const lines = ref.snippet.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines
    .map((line, i) => {
      const no = ref.startLine + i;
      const cls = highlight.has(no) ? "l hl" : "l";
      return `<span class="${cls}"><span class="n">${no}</span>${escapeHtml(line)}</span>`;
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

/** One side of a before/after pair. No line numbers: a payload is a value, not a file,
 *  so there is nothing to count into. A highlight is a line number within this side or
 *  a key that appears on the line. */
function payloadSide(text: string, highlight: (string | number)[]): string {
  const numbers = new Set(highlight.filter((h): h is number => typeof h === "number"));
  const keys = highlight.filter((h): h is string => typeof h === "string");
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const body = lines
    .map((line, i) => {
      const marked = numbers.has(i + 1) || keys.some((k) => k !== "" && line.includes(k));
      return `<span class="${marked ? "l hl" : "l"}">${escapeHtml(line)}</span>`;
    })
    .join("");
  return `<div class="snipbox"><pre class="snip scroll-x"><code>${body}</code></pre></div>`;
}

function payloadBlock(payload: Payload): string {
  return (
    `<div class="ba">` +
    `<span class="ba-label l1">before</span>` +
    `<span class="ba-label l2">after</span>` +
    `<div class="c1">${payloadSide(payload.before, payload.highlight)}</div>` +
    `<div class="c2">${payloadSide(payload.after, payload.highlight)}</div>` +
    `</div>`
  );
}

// ---- example ----

/** An authored illustration. It is the one evidence kind that is invented rather than
 *  quoted, so it carries no line numbers and no path: nothing in it may look like a
 *  citation. Its caption says what it is, and the caption is required. */
function exampleBlock(lang: string, text: string, caption: string): string {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((line) => `<span class="l">${escapeHtml(line)}</span>`).join("");
  return (
    `<figure class="ev ev-example" data-lang="${escapeHtml(lang)}">` +
    `<div class="snipbox"><pre class="snip scroll-x"><code>${body}</code></pre></div>` +
    `<figcaption>${safeInline(caption)}</figcaption></figure>`
  );
}

// ---- attachment, bundle, figure ----

function attachmentBlock(basePath: string, id: string, alt: string, caption: string): string {
  const src = `${basePath}/a/${encodeURIComponent(id)}`;
  const figcaption = caption === "" ? "" : `<figcaption>${safeInline(caption)}</figcaption>`;
  return (
    `<figure class="ev ev-attachment">` +
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` +
    `${figcaption}</figure>`
  );
}

/** A bundle in the same workspace, resolved to the link it is served at rather than to
 *  a URL the author wrote. `version` null is the bundle as it stands. */
function bundleBlock(wsId: string, slug: string, version: number | null, caption: string): string {
  const href = version === null ? `/${wsId}/b/${slug}/` : `/${wsId}/b/${slug}/v/${version}/`;
  const label = version === null ? slug : `${slug} v${version}`;
  return (
    `<p class="ev ev-bundle">${icon("eye")}` +
    `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` +
    `<span class="ev-cap">${safeInline(caption)}</span></p>`
  );
}

/** The figure, until it is drawn. Its nodes and edges are the whole content of the
 *  block, so they are listed rather than dropped. */
function figureBlock(figure: Figure): string {
  const labels = new Map(figure.nodes.map((n) => [n.id, n.label] as const));
  const rows = figure.edges.map((e) => {
    const from = labels.get(e.from) ?? e.from;
    const to = labels.get(e.to) ?? e.to;
    const label = e.label === "" ? "" : ` <span class="fg-edge">${escapeHtml(e.label)}</span>`;
    return `<li>${escapeHtml(from)} ${icon("cue", "fg-arrow")} ${escapeHtml(to)}${label}</li>`;
  });
  const nodes = figure.nodes
    .map((n) => `<li class="fg-${escapeHtml(n.state)}">${escapeHtml(n.label)}</li>`)
    .join("");
  return (
    `<div class="ev ev-figure">` +
    `<ul class="fg-nodes">${nodes}</ul>` +
    (rows.length === 0 ? "" : `<ul class="fg-edges">${rows.join("")}</ul>`) +
    `</div>`
  );
}

/** Every evidence block a statement or a note carries, in the order it was authored.
 *  `ownerId` is the statement or note the evidence hangs off, so its ref panels are
 *  addressable without colliding with the same ref quoted elsewhere. */
export function renderEvidence(
  evidence: Evidence[],
  ownerId: string,
  ctx: { wsId: string; basePath: string },
): string {
  return evidence
    .map((e, i) => {
      switch (e.type) {
        case "ref":
          return refFold(ownerId, e.ref, `ev${i}-`);
        case "payload":
          return payloadBlock(e.payload);
        case "example":
          return exampleBlock(e.example.lang, e.example.text, e.example.caption);
        case "attachment":
          return attachmentBlock(ctx.basePath, e.attachment.id, e.attachment.alt, e.attachment.caption);
        case "bundle":
          return bundleBlock(ctx.wsId, e.bundle.slug, e.bundle.version, e.bundle.caption);
        case "figure":
          return figureBlock(e.figure);
      }
    })
    .join("");
}
