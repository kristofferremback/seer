// The review, as a page. Server-side HTML for GET /r/:slug and its /v/:n sibling.
//
// The whole page is one document with no client-side rendering in it. Every
// disclosure is a `details`, every citation is a fragment link to the panel it opens,
// and the theme resolves from the system preference in CSS. The script at the end is
// an enhancement and nothing more: strip every `<script>` from the response and the
// page still opens its folds, still lands on a cited snippet, and still reads in the
// dark. There are no event attributes anywhere in the output.
//
// The visual language, the tokens and the icon sprite are the v9 prototype's,
// transcribed rather than reinvented. The style block below is that prototype's,
// with the font URLs pointed at Seer's own /fonts route.
//
// The privacy gate is step 8's, reached through the same helper: a review holds
// private source, so a slug in someone else's workspace, a signed-out browser and a
// review that does not exist all answer with the same bytes.

import { escapeHtml } from "../escape";
import { getWorkspace } from "../db";
import { openAttachment, attachmentLocation } from "../store";
import { getAttachment, getReviewVersion, resolveReview, type ReviewDoc } from "./db";
import { freshnessOf, readableWorkspaces } from "./read";
import { KIND_LABEL, walkthroughSection } from "./render-diff";
import {
  icon,
  refChip,
  refFold,
  renderEvidence,
  safeBlock,
  safeInline,
  shortSha,
} from "./render-evidence";
import {
  prKey,
  type Evidence,
  type Freshness,
  type Note,
  type Pr,
  type Ref,
  type Statement,
} from "./types";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ATT_ID_RE = /^att_[a-z0-9]+$/;

// Transcribed from the v9 prototype. Font URLs point at Seer /fonts. Two layout rules
// were added inside the block, next to the rules they qualify: `.chain > .card + .card`
// (a set draws no arrows, so its cards need their own gap) and `.card-body .fold + .fold`
// (a card body now holds both the detail ref and the description fold). Nothing else moved.
const STYLE = `  @font-face {
    font-family: "Switzer";
    src: url("/fonts/switzer.woff2") format("woff2");
    font-weight: 100 900; font-display: swap; font-style: normal;
  }
  @font-face {
    font-family: "Cabinet Grotesk";
    src: url("/fonts/cabinet-grotesk.woff2") format("woff2");
    font-weight: 100 900; font-display: swap; font-style: normal;
  }
  @font-face {
    font-family: "Commit Mono";
    src: url("/fonts/commit-mono-400.woff2") format("woff2");
    font-weight: 400; font-display: swap; font-style: normal;
  }
  @font-face {
    font-family: "Commit Mono";
    src: url("/fonts/commit-mono-500.woff2") format("woff2");
    font-weight: 500; font-display: swap; font-style: normal;
  }
  @font-face {
    font-family: "Commit Mono";
    src: url("/fonts/commit-mono-700.woff2") format("woff2");
    font-weight: 700; font-display: swap; font-style: normal;
  }

  /* Designed dark first. The dark substrate is an oxblood-black, Seer's red
     taken all the way down to near-black, so the base is a chosen tone rather
     than the stock blue-charcoal. The light theme is derived from it, not
     inverted from a light design: a faint blush stone that carries the same
     cast at the other end of the scale, and it is verified on its own terms. */
  :root {
    color-scheme: light;
    --paper: 8 30% 96.5%;
    --paper-sunk: 6 21% 90.5%;
    --ink: 8 20% 10%;
    --ink-soft: 8 15% 23%;
    --line: 6 20% 81%;
    --muted: 8 13% 31%;
    /* The accent is hueless: the far end of the same ink ramp the body is set
       in, not a colour. It is darker than the body ink rather than lighter, so
       a link is stronger than the text around it and never reads as faded.
       Measured: accent 17.98:1 on paper against body ink's 16.33:1, and an
       OKLCh chroma of 0.0095, below the ink's own 0.0147. */
    --accent: 8 24% 5%;

    /* Change semantics. Hue lives here and in nothing else that is not a diff:
       the kind icons, the diff line washes, the gutter rails and the +/- glyph.
       Nothing interactive borrows any of it. */
    --add: 142 54% 22%;
    --change: 34 82% 27%;
    --remove: 2 68% 36%;
    --risk: 2 68% 36%;
    --note: 8 13% 31%;

    /* Code. Syntax carries hue again, under a corrected subordination rule.
       A diff wash is a background field; a syntax token is foreground text.
       They do not compete the way two foreground colours do, which is why a
       tinted keyword on a green row does not stop the row reading as added.
       What syntax must not do is out-shout the coloured FOREGROUND marks in
       the same surface: the gutter +/- glyphs and the kind icons.

       So the palette is bounded twice. Above: the lowest semantic foreground
       chroma, which here is the add green at OKLCh 0.0891. Below: the law's
       own hue line at 0.06, so a token that claims to carry hue measurably
       does. Both syntax hues land in that band, at 70% of the ceiling.

       The hues sit in the half of the wheel the semantics never touch. Add is
       OKLCh 152, change 66, remove and risk 28; a keyword at 315 and a literal
       at 250 cannot be misread as any of them. Violet and slate rather than a
       terminal cyan: both are plum-adjacent, which is what this oxblood
       substrate is made of.

       Two of the four classes carry hue and two do not. The declared name
       stays full ink with weight, because it is the anchor of a hunk and ink
       is stronger than any hue at this size, and a comment stays a recessive
       neutral, because its job is to be skipped. */
    --syn-cm: 8 12% 36%;
    --syn-kw: 282 22% 30%;
    --syn-st: 210 41% 28%;

    /* Diff washes. A shade stronger in dark than the other candidates, because
       the oxblood substrate absorbs a wash more than a neutral charcoal does,
       and a step stronger in both now that the diff is the only place on the
       page where colour is spent. The rails carry more of the load in light,
       where a green wash on a warm paper is nearly a neutral band. */
    --wash-add: hsl(var(--add) / 0.13);
    --wash-rem: hsl(var(--remove) / 0.11);
    --rail-add: hsl(var(--add) / 0.8);
    --rail-rem: hsl(var(--remove) / 0.8);
    --word-add: hsl(var(--add) / 0.14);
    --word-rem: hsl(var(--remove) / 0.14);

    --font-display: "Cabinet Grotesk", "Switzer", system-ui, -apple-system, sans-serif;
    --font-body: "Switzer", system-ui, -apple-system, sans-serif;
    --font-mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --paper: 356 28% 10%;
    --paper-sunk: 356 34% 6.5%;
    --ink: 18 22% 92%;
    --ink-soft: 14 15% 78%;
    --line: 356 22% 24%;
    --muted: 14 13% 67%;
    /* the same move at the other end: a warm near-white, brighter than the body
       ink rather than dimmer. 16.24:1 on paper against the ink's 15.02:1, at an
       OKLCh chroma of 0.0076. */
    --accent: 28 35% 95%;

    --add: 140 42% 57%;
    --change: 38 78% 63%;
    --remove: 2 66% 72%;
    --risk: 2 66% 72%;
    --note: 14 13% 67%;

    /* same band at the other end: ceiling 0.1118 (the remove red), line 0.06,
       both hues at 57% of the ceiling. Same OKLCh hues as light, 318 and 249. */
    --syn-cm: 16 11% 62%;
    --syn-kw: 285 34% 77%;
    --syn-st: 210 58% 77%;

    --wash-add: hsl(var(--add) / 0.19);
    --wash-rem: hsl(var(--remove) / 0.165);
    --rail-add: hsl(var(--add) / 0.7);
    --rail-rem: hsl(var(--remove) / 0.7);
    --word-add: hsl(var(--add) / 0.14);
    --word-rem: hsl(var(--remove) / 0.14);
  }
  /* The inline script in <head> resolves the theme before first paint. This
     block is the no-JS floor: system dark still lands on the dark surface,
     and an explicit light choice still wins. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --paper: 356 28% 10%;
      --paper-sunk: 356 34% 6.5%;
      --ink: 18 22% 92%;
      --ink-soft: 14 15% 78%;
      --line: 356 22% 24%;
      --muted: 14 13% 67%;
      --accent: 28 35% 95%;

      --add: 140 42% 57%;
      --change: 38 78% 63%;
      --remove: 2 66% 72%;
      --risk: 2 66% 72%;
      --note: 14 13% 67%;

      --syn-cm: 16 11% 62%;
      --syn-kw: 285 34% 77%;
      --syn-st: 210 58% 77%;

      --wash-add: hsl(var(--add) / 0.19);
      --wash-rem: hsl(var(--remove) / 0.165);
      --rail-add: hsl(var(--add) / 0.7);
      --rail-rem: hsl(var(--remove) / 0.7);
      --word-add: hsl(var(--add) / 0.14);
      --word-rem: hsl(var(--remove) / 0.14);
    }
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  @media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
  body {
    margin: 0;
    background: hsl(var(--paper));
    color: hsl(var(--ink));
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    touch-action: manipulation;
    overflow-x: hidden;
  }
  ::selection { background: hsl(var(--accent) / 0.2); }

  /* ---- the column ---- */
  .doc {
    max-width: 760px;
    margin: 0 auto;
    padding:
      22px
      max(20px, env(safe-area-inset-right))
      64px
      max(20px, env(safe-area-inset-left));
  }
  @media (max-width: 380px) {
    .doc { padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); }
  }

  /* ---- type ---- */
  h1, h2 { margin: 0; }
  p { margin: 0 0 10px; }
  p:last-child { margin-bottom: 0; }
  code { font-family: var(--font-mono); font-size: 0.88em; }
  .nb { white-space: nowrap; }

  /* Nothing interactive carries hue, so the underline is not decoration here:
     it is the whole statement that a run of text is a link. It is always on,
     thickens under the pointer, and takes a tonal wash on press. The colour is
     the accent, which is the strongest ink on the page rather than a hue, so a
     link is heavier than the sentence it sits in instead of lighter. */
  a {
    color: hsl(var(--accent));
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }
  a:active { text-decoration-thickness: 2px; background-color: hsl(var(--ink) / 0.08); }
  @media (hover: hover) and (pointer: fine) {
    a:hover { text-decoration-thickness: 2px; }
  }
  /* the ring is the hueless accent against the surface it lands on: near-black
     on paper, near-white on the dark substrate, 2px and offset so it clears
     both a hairline border and a filled button. */
  :focus-visible { outline: 2px solid hsl(var(--accent)); outline-offset: 2px; border-radius: 3px; }

  /* ---- the icon set: Lucide, inlined ----
     Stroke-width is the only thing tuned. Lucide ships 2 units on a 24 box,
     which at 14px would draw 1.17px and sit heavier than this page's hairlines
     and mono. Each size below carries the width that resolves to ~1.05px, so
     the marks read as one weight with the rules and the type. No tile, no
     circle, no chip behind any of them; each takes its colour from
     currentColor. */
  .sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
  .ic { flex: none; display: block; width: 14px; height: 14px; stroke-width: 1.8; }
  .ic-lg { width: 15px; height: 15px; stroke-width: 1.7; }
  .k-add { color: hsl(var(--add)); }
  .k-change { color: hsl(var(--change)); }
  .k-remove { color: hsl(var(--remove)); }
  .k-keep { color: hsl(var(--muted)); }
  .k-risk { color: hsl(var(--risk)); }
  .k-note { color: hsl(var(--note)); }

  /* ---- header block ----
     Masthead, then the review's own title block. The masthead carries a rule
     under it so the identity band closes and the title, its meta line and the
     stack below read as one object rather than three stray rows. */
  .head { margin-bottom: 18px; }
  .head-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding-bottom: 7px;
    border-bottom: 1px solid hsl(var(--line));
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; }
  /* the wordmark's optical centre sits a shade above the line box's, so the
     eye is nudged to meet it rather than the box. */
  .brand .eye { display: block; flex: none; width: 17px; height: 17px; stroke-width: 1.55; color: hsl(var(--ink)); transform: translateY(0.5px); }
  .wordmark {
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 15px;
    letter-spacing: 0.02em;
    color: hsl(var(--ink));
    line-height: 1;
  }
  .head-tag {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: hsl(var(--muted));
    letter-spacing: 0.01em;
  }
  /* the control is the surface state itself, drawn as Lucide's contrast mark:
     half the disc inked, and which half flips with the theme. The 44px box is
     the target; the mark inside it is optically centred on the wordmark's
     baseline rather than on the row. */
  .theme-toggle {
    background: none; border: 0; margin: 0 -10px 0 0; padding: 10px;
    min-width: 44px; min-height: 44px;
    color: hsl(var(--accent));
    cursor: pointer; line-height: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px;
    flex: none;
  }
  .theme-toggle .mark {
    display: block; width: 18px; height: 18px;
    stroke-width: 1.45;
    transform: translateY(0.5px) rotate(0deg);
    transform-origin: 50% 50%;
  }
  :root[data-theme="dark"] .theme-toggle .mark { transform: translateY(0.5px) rotate(180deg); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-toggle .mark { transform: translateY(0.5px) rotate(180deg); }
  }
  .theme-toggle:active { background: hsl(var(--ink) / 0.07); }
  @media (hover: hover) and (pointer: fine) {
    .theme-toggle .mark { transition: transform 220ms cubic-bezier(0.2, 0.9, 0.25, 1); }
  }
  @media (prefers-reduced-motion: reduce) { .theme-toggle .mark { transition: none; } }
  @media (max-width: 479.98px) {
    .head-row { flex-wrap: wrap; row-gap: 0; padding-bottom: 5px; }
    .brand { flex: 1 1 auto; }
    .theme-toggle { order: 2; }
    .head-tag { order: 3; flex: 1 0 100%; margin: -2px 0 4px; }
  }

  .title {
    margin-top: 15px;
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 21px;
    line-height: 1.28;
    letter-spacing: -0.012em;
    color: hsl(var(--ink));
    max-width: 22em;
  }
  /* the review's facts, set as a mono row that wraps on whole tokens: at 320px
     it breaks between them instead of mid-phrase, and no separator is ever
     left hanging at the end of a line. */
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 9px; row-gap: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    color: hsl(var(--muted));
    margin: 7px 0 0;
    letter-spacing: 0.01em;
  }
  .meta > span { display: inline-flex; align-items: baseline; gap: 9px; }
  .meta > span:not(:last-child)::after { content: "·"; color: hsl(var(--muted) / 0.7); }
  @media (min-width: 560px) {
    .title { font-size: 23px; }
  }
  /* the three facts hold one line at 320 at this size, which is the whole
     point of setting them as a row */
  @media (max-width: 380px) {
    .meta { font-size: 11.5px; column-gap: 8px; }
    .meta > span { gap: 8px; }
  }

  /* ---- sections ---- */
  section { margin-top: 30px; scroll-margin-top: 20px; }
  h2 {
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 15px;
    line-height: 1.4;
    color: hsl(var(--ink));
    padding-bottom: 6px;
    border-bottom: 1px solid hsl(var(--line));
    margin-bottom: 12px;
  }

  /* ---- contents ---- */
  .contents {
    font-family: var(--font-mono);
    font-size: 12px;
    color: hsl(var(--muted));
    margin: 16px 0 0;
    line-height: 22px;
  }
  .contents a { display: inline-block; padding: 11px 0; }

  /* ---- inline resolved reference ----
     A compact mono token carrying the same chevron as every other disclosure:
     right means the snippet is folded, down means it is open.
     Same object in a row, in a note and in an answer. 44px touch target.
     It is a link, and it declines the underline because it already says three
     other things: the chevron, the box, and a value step to full accent ink
     against the softer ink of the sentence it sits in. */
  .ref {
    --ref-wash: hsl(var(--ink) / 0);
    position: relative;
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1.45;
    color: hsl(var(--accent));
    white-space: nowrap;
    padding: 2px 7px 2px 6px;
    border: 1px solid hsl(var(--line));
    border-radius: 5px;
    background-color: hsl(var(--paper));
    background-image: linear-gradient(var(--ref-wash), var(--ref-wash));
    cursor: pointer;
    text-decoration: none;
  }
  .ref:hover, .ref:active { text-decoration: none; background-color: hsl(var(--paper)); }
  .rtick {
    display: inline-block;
    width: 10px; height: 10px;
    margin: 0 3px 1px 0;
    stroke-width: 2.5;
    transform: rotate(0deg);
    vertical-align: middle;
    transition: transform 150ms cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .ref::after { content: ""; position: absolute; left: -2px; right: -2px; top: 50%; height: 44px; transform: translateY(-50%); }
  .ref:active { --ref-wash: hsl(var(--ink) / 0.1); }
  .ref.is-open { --ref-wash: hsl(var(--accent) / 0.12); border-color: hsl(var(--accent) / 0.4); }
  .ref.is-open .rtick { transform: rotate(90deg); }
  @media (hover: hover) and (pointer: fine) {
    .ref { transition: background-color 150ms ease, border-color 150ms ease; }
    .ref:hover { --ref-wash: hsl(var(--ink) / 0.05); border-color: hsl(var(--accent) / 0.4); }
    .ref.is-open:hover { --ref-wash: hsl(var(--accent) / 0.18); }
  }

  /* ---- disclosure, one grammar for the whole page ---- */
  details { min-width: 0; }
  summary { list-style: none; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  /* the marker is Lucide's chevron in the accent: right while the panel is
     folded, down while it is open. Nothing else on the page has to say that a
     row opens. */
  .tick {
    flex: none;
    display: block;
    width: 12px; height: 12px;
    stroke-width: 2.1;
    color: hsl(var(--accent));
    transform: rotate(0deg);
    transition: transform 180ms cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  details[open] > summary .tick { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .tick { transition: none; } }

  /* press feedback: tonal only, no lift */
  .note > summary:active,
  .row > summary:active,
  .grp > summary:active,
  .frow > summary:active,
  .fold > summary:active { background-color: hsl(var(--ink) / 0.06); }
  @media (hover: hover) and (pointer: fine) {
    .note > summary, .row > summary, .grp > summary, .frow > summary, .fold > summary { transition: background-color 150ms ease; }
    .note > summary:hover,
    .row > summary:hover,
    .grp > summary:hover,
    .frow > summary:hover,
    .fold > summary:hover { background-color: hsl(var(--ink) / 0.035); }
  }

  /* the panel is simply there if the animation never runs: no fill-mode */
  @media (prefers-reduced-motion: no-preference) {
    details[open] > .fold-body,
    details[open] > .note-body,
    details[open] > .row-body,
    details[open] > .grp-body,
    details[open] > .frow-body { animation: unfold 200ms cubic-bezier(0.2, 0.9, 0.25, 1); }
  }
  @keyframes unfold { from { opacity: 0; } }

  /* ---- code fold ---- */
  .fold {
    max-width: 100%;
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    background: hsl(var(--ink) / 0.03);
    overflow: hidden;
  }
  .fold > summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 12px;
    min-height: 44px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: hsl(var(--muted));
  }
  .fold > summary .fh { min-width: 0; }
  .fold > summary .fh b { font-weight: 500; color: hsl(var(--ink)); }
  .fold[open] > summary { border-bottom: 1px solid hsl(var(--line)); }
  /* the code runs wider than the box: say so in the header, with the sideways
     twin of the arrow the chain is drawn with rather than a second arrow
     language */
  .cue {
    display: none;
    flex: none;
    width: 14px; height: 14px;
    stroke-width: 1.8;
    margin-left: auto;
    color: hsl(var(--muted));
  }
  .fold.clipped > summary > .cue { display: block; }
  .fold-body { padding: 0; background: hsl(var(--ink) / 0.03); }

  /* without JS a citation is a fragment jump, so the landing fold has to say it
     was hit: it opens where the engine allows, and wears the same open state as
     every other disclosure, chevron included. With JS the script opens the fold
     instead, so [open] stays the single source of truth. */
  @media (scripting: none) {
    .fold:target > summary { background: hsl(var(--ink) / 0.05); border-bottom: 1px solid hsl(var(--line)); }
    .fold:target > summary .tick { transform: rotate(90deg); }
    .fold:target:not([open]) > .fold-body { display: block; }
    .fold:target::details-content { content-visibility: visible; block-size: auto; }
  }

  /* ---- code ---- */
  .snip {
    margin: 0;
    padding: 9px 0 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.62;
    color: hsl(var(--ink-soft));
  }
  .snipbox {
    background: hsl(var(--ink) / 0.03);
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    overflow: hidden;
    min-width: 0;
  }
  .scroll-x { overflow-x: auto; scrollbar-width: thin; scrollbar-color: hsl(var(--line)) transparent; }
  .scroll-x::-webkit-scrollbar { height: 6px; }
  .scroll-x::-webkit-scrollbar-thumb { background: hsl(var(--line)); border-radius: 999px; }
  .scroll-x::-webkit-scrollbar-track { background: transparent; }
  /* the honest right edge: while there is code past the rim, it fades out
     instead of being guillotined mid-glyph. */
  .snip[data-clip="right"] {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent 100%);
  }
  /* with no script there is nothing to measure the overflow with, so the fade
     is simply always on: a cut is never left silent. */
  @media (scripting: none) {
    .snip.scroll-x {
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent 100%);
      mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent 100%);
    }
  }
  /* the code block is as wide as its widest line, so a short added line still
     carries its wash all the way across when the diff is scrolled right. */
  .snip code { display: block; width: max-content; min-width: 100%; white-space: normal; font-size: inherit; }
  .snip .l {
    display: block;
    white-space: pre;
    width: auto;
    min-width: 100%;
    padding: 0 14px 0 8px;
    border-left: 2px solid transparent;
  }
  .snip .l.hl { background: hsl(var(--ink) / 0.055); border-left-color: hsl(var(--ink-soft)); }
  /* diff colouring: the wash says which way the line went, the gutter glyph
     says it again in a character, so neither one is carrying it alone. */
  .snip .l.add { background: var(--wash-add); }
  .snip .l.del { background: var(--wash-rem); }
  .snip .l.add .g { color: hsl(var(--add)); font-weight: 500; }
  .snip .l.del .g { color: hsl(var(--remove)); font-weight: 500; }
  .snip .n { display: inline-block; width: 2.4em; margin-right: 0.9em; text-align: right; color: hsl(var(--muted)); user-select: none; }
  .snip .g { display: inline-block; width: 1.2em; color: hsl(var(--muted)); user-select: none; }
  /* four classes, two of them hued: a comment is a recessive neutral, a keyword
     is violet, a literal is slate, and a declared name is full ink with weight.
     The ink stays the strongest thing in the surface, so the name being defined
     still leads, and the two hues are bounded above by the +/- glyph and the
     kind icons that sit in the same code. */
  .snip .cm { color: hsl(var(--syn-cm)); }
  .snip .kw { color: hsl(var(--syn-kw)); }
  .snip .st { color: hsl(var(--syn-st)); }
  .snip .ty { color: hsl(var(--ink)); font-weight: 500; }
  /* an elision inside a real line, marked so the crop is never silent */
  .snip .el { color: hsl(var(--muted)); border-bottom: 1px dotted hsl(var(--muted)); cursor: help; }

  /* ---- the overview rows ---- */
  .rows { border-top: 1px solid hsl(var(--line)); margin-top: 16px; }
  /* one gap variable for the summary grid and the body indent, so the
     drill-down can never drift off the statement it belongs to. */
  .row, .note { --sgap: 11px; }
  .row { border-bottom: 1px solid hsl(var(--line)); }
  .row > summary {
    display: grid;
    grid-template-columns: 12px 14px minmax(0, 1fr);
    align-items: start;
    column-gap: var(--sgap); row-gap: 7px;
    padding: 11px 4px;
    min-height: 44px;
  }
  .row > summary .tick { grid-column: 1; grid-row: 1; margin-top: 5px; }
  .row > summary .ic { grid-column: 2; grid-row: 1; margin-top: 4px; }
  .rwhat { grid-column: 3; grid-row: 1; font-size: 14.5px; line-height: 1.5; color: hsl(var(--ink)); min-width: 0; }
  .rrefs { grid-column: 3; grid-row: 2; display: flex; flex-wrap: wrap; gap: 7px; }
  .rrefs:empty { display: none; }
  .row-body { padding: 4px 2px 18px calc(4px + 12px + 14px + var(--sgap) * 2); }
  .row-body > *:first-child { margin-top: 0; }
  .row-body p { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin-bottom: 13px; }
  .row-body .fold { margin: 10px 0; }
  .row-body .fold + .fold { margin-top: 8px; }
  @media (min-width: 680px) {
    .row { --sgap: 12px; }
    .row > summary { grid-template-columns: 12px 14px minmax(0, 1fr) auto; row-gap: 0; }
    .rrefs { grid-column: 4; grid-row: 1; flex-wrap: nowrap; align-self: start; margin-top: 1px; }
  }

  /* ---- review notes ---- */
  /* the h2's own rule is this list's top edge; a second one would stutter */
  #notes h2, #walkthrough h2 { margin-bottom: 2px; }
  .notes { border-top: 0; }
  .note { border-bottom: 1px solid hsl(var(--line)); }
  .note > summary {
    display: grid;
    grid-template-columns: 12px 14px minmax(0, 1fr);
    column-gap: var(--sgap);
    padding: 12px 4px;
    min-height: 44px;
    align-items: start;
  }
  .note > summary .tick { grid-column: 1; margin-top: 5px; }
  .note > summary .ic { grid-column: 2; margin-top: 4px; }
  /* every statement is ink. The icon says which kind it is, and a risk gets
     its extra weight from the hairline down its open body, not from red
     type: five rows of the same colour read as five statements. */
  .note .none { grid-column: 3; font-size: 14.5px; line-height: 1.5; min-width: 0; color: hsl(var(--ink)); }
  .note-body { position: relative; padding: 2px 2px 18px calc(4px + 12px + 14px + var(--sgap) * 2); }
  /* the rail down an open body is a connector, not a statement of kind: the
     icon above it already says which kind this is, so it carries no hue. A
     risk gets its extra weight from a thicker, darker rule instead. */
  .note.is-risk .note-body::before {
    content: "";
    position: absolute;
    left: calc(4px + 12px + var(--sgap) + 6.5px); top: 2px; bottom: 22px;
    width: 2px;
    background: hsl(var(--ink) / 0.3);
  }
  .note-body > *:first-child { margin-top: 0; }
  .note-body p { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin-bottom: 13px; }
  .note-body .fold { margin: 10px 0; }
  .note-body .fold + .fold { margin-top: 8px; }

  /* the three checks are counted, not chevroned: a chevron leading a row means
     "this opens", and these rows do not open. */
  .checks { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; counter-reset: chk; }
  .checks li { position: relative; padding-left: 21px; font-size: 14.5px; line-height: 1.55; color: hsl(var(--ink-soft)); }
  .checks li::before {
    counter-increment: chk;
    content: counter(chk) ".";
    position: absolute; left: 0; top: 0;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 2;
    color: hsl(var(--muted));
  }

  /* before / after, on one grid so the rows line up in both columns */
  .ba {
    display: grid;
    gap: 5px 14px;
    grid-template-columns: 1fr;
    grid-template-areas: "l1" "c1" "l2" "c2";
    margin: 10px 0 14px;
  }
  .ba .l1 { grid-area: l1; } .ba .c1 { grid-area: c1; }
  .ba .l2 { grid-area: l2; } .ba .c2 { grid-area: c2; }
  .ba .l2 { margin-top: 8px; }
  .ba-label { font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); }
  .ba .snip .l { padding-right: 8px; }
  @media (min-width: 640px) {
    .ba { grid-template-columns: 1fr 1fr; grid-template-areas: "l1 l2" "c1 c2"; }
    .ba .l2 { margin-top: 0; }
  }
  /* the spacer line only buys alignment while the two columns sit side by side */
  .snip .void { color: transparent; }
  @media (max-width: 639.98px) { .ba .snip .void { display: none; } }

  /* ---- the flow figure: a documentation figure, not an illustration ---- */
  .flow { display: block; width: 100%; max-width: 210px; height: auto; margin: 10px 0 14px; }
  .flow text { font-family: var(--font-mono); font-size: 11.5px; fill: hsl(var(--ink-soft)); }
  .flow text.dim { fill: hsl(var(--muted)); }
  .flow .cap { font-size: 11px; fill: hsl(var(--muted)); }

  /* ---- the stack: one chain, opened in place ----
     Vertical at every width. A row of cards could not grow downward without
     shoving the other two sideways, and the whole point of this object is that
     reading one step never moves the other two. Desktop gets width and air
     instead of a second axis.

     The base mark, every arrow and every card's pull-request mark share one
     vertical spine at the left, so the chain is a chain before a word is
     read. */
  .chain { display: flex; flex-direction: column; align-items: stretch; margin: 20px 0 0; --spine: 12px; }
  /* A set gets no arrows, so its cards need the air the arrows would have given them. */
  .chain > .card + .card { margin-top: 8px; }
  .base {
    display: flex; align-items: center; gap: 9px;
    margin: 0; padding-left: var(--spine);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: hsl(var(--muted));
  }
  .base .ic { color: hsl(var(--muted)); }
  .base .sha { color: hsl(var(--muted) / 0.85); }
  .arw { display: block; flex: none; width: 14px; height: 14px; stroke-width: 1.8; color: hsl(var(--muted) / 0.55); margin: 4px 0 4px var(--spine); }

  .card {
    position: relative;
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    min-width: 0;
  }
  .card > summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 10px; row-gap: 3px;
    padding: 11px var(--spine) 12px;
  }
  /* the ref is the one thing on the card that leaves the page, so it carries
     its own hit area and sits above the summary's. The two do not overlap:
     the ref's box is the top line of the left column, the card's is everything
     under and beside it. */
  .c-ref {
    position: relative; z-index: 1;
    grid-column: 1; grid-row: 1;
    display: inline-flex; align-items: center; gap: 7px;
    justify-self: start;
    font-family: var(--font-mono); font-size: 12px; font-weight: 500;
    min-height: 22px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .c-ref::after { content: ""; position: absolute; left: -6px; right: -6px; top: 50%; height: 44px; transform: translateY(-50%); }
  /* the rule belongs under the text, not under the mark that labels it, so the
     underline lives on an inner span rather than across the whole flex box */
  .c-ref, .c-ref:active { text-decoration: none; background-color: transparent; }
  .c-reftext { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .c-ref:active .c-reftext { text-decoration-thickness: 2px; }
  @media (hover: hover) and (pointer: fine) {
    .c-ref:hover .c-reftext { text-decoration-thickness: 2px; }
  }
  .c-kinds { grid-column: 2; grid-row: 1; display: flex; align-items: center; gap: 9px; flex: none; }
  /* the marks say what the step does and the chevron says the card opens: two
     different statements, so they do not sit in one cluster. */
  .card > summary .tick { grid-column: 3; grid-row: 1; margin-left: 5px; }
  .c-title { grid-column: 1 / -1; grid-row: 2; font-size: 14.5px; font-weight: 500; line-height: 1.35; color: hsl(var(--ink)); margin-top: 3px; }
  .c-line { grid-column: 1 / -1; grid-row: 3; font-size: 13px; line-height: 1.5; color: hsl(var(--ink-soft)); }
  /* open state is the walkthrough group's, on a card: the head keeps its rule
     and the border firms up, so the open one is the open one at a glance. */
  .card[open] { border-color: hsl(var(--ink) / 0.26); }
  .card[open] > summary { border-bottom: 1px solid hsl(var(--line)); }
  .card-body { padding: 12px var(--spine) 14px; }
  .card-body p { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin: 0 0 11px; }
  /* the card is already the sunk surface, so the code panel inside it steps
     back up to paper. Every fold on the page then lands on the same base, and
     a diff wash means the same thing here as it does anywhere else. */
  .card-body .fold, .card-body .fold > .fold-body { margin: 0; background: hsl(var(--paper)); }
  .card-body .fold + .fold { margin-top: 8px; }
  .card > summary:active { background-color: hsl(var(--ink) / 0.05); }
  @media (hover: hover) and (pointer: fine) {
    .card > summary { transition: background-color 150ms ease; }
    .card > summary:hover { background-color: hsl(var(--ink) / 0.03); }
  }
  /* the ref is the longest fixed string on the card and the narrowest screen
     is where it and the kind cluster meet. Both tighten a step rather than
     letting the ref break across two lines. */
  @media (max-width: 479.98px) {
    .card > summary { column-gap: 8px; padding-right: 10px; }
    .c-ref { font-size: 11.5px; gap: 6px; }
    .c-kinds { gap: 8px; }
  }
  @media (min-width: 700px) {
    .chain { --spine: 16px; margin-top: 24px; }
    .arw { margin-top: 6px; margin-bottom: 6px; }
    .card > summary { padding: 13px var(--spine) 14px; }
    .card-body { padding: 14px var(--spine) 16px; }
    .c-title { font-size: 15px; }
    .c-line { font-size: 13.5px; }
  }

  /* ---- walkthrough ---- */
  .walk { border-top: 0; }
  .grp { border-bottom: 1px solid hsl(var(--line)); --ggap: 12px; }
  /* the open group used to be marked by a rail in its own kind colour. The
     kind is the icon's job, so the rail went neutral and the open state is
     said with weight instead. */
  .grp[open] > summary .gname { font-weight: 500; }
  .grp > summary {
    display: grid;
    grid-template-columns: 12px 15px minmax(0, 1fr) auto;
    align-items: center;
    padding: 13px 4px;
    min-height: 44px;
  }
  .gname { font-size: 14.5px; line-height: 1.4; color: hsl(var(--ink)); min-width: 0; }
  .gcount { font-family: var(--font-mono); font-size: 12px; color: hsl(var(--muted)); }
  /* the open group grows a hairline dropped from under the icon: it is what
     tells you the files below belong to the row above. */
  /* the body lands on the group title's own text column: 4px of summary
     padding, the chevron, the icon and the two gaps that separate them. */
  .grp > summary { column-gap: var(--ggap); }
  .grp-body { position: relative; padding: 0 2px 16px calc(4px + 12px + 15px + var(--ggap) * 2); }
  .grp-body::before {
    content: "";
    position: absolute;
    left: calc(4px + 12px + var(--ggap) + 7.5px); top: 2px; bottom: 20px;
    width: 1px;
    background: hsl(var(--ink) / 0.22);
  }
  .gsum { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin: 0 0 12px; }

  .frow { border-top: 1px solid hsl(var(--line)); }
  .frow > summary {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    align-items: start;
    column-gap: 11px; row-gap: 3px;
    padding: 10px 2px;
    min-height: 44px;
  }
  .frow > summary .tick { grid-column: 1; grid-row: 1; margin-top: 4px; }
  /* path, count and kind travel together as one head. A file whose only mark
     is a single tilde then reads as that file's mark rather than as a glyph
     stranded at the far edge of a 1280px row. */
  .fhead { grid-column: 2; grid-row: 1; display: flex; align-items: center; flex-wrap: wrap; column-gap: 10px; row-gap: 2px; min-width: 0; }
  .fpath { font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; color: hsl(var(--ink)); overflow-wrap: anywhere; min-width: 0; }
  .fstat { font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); white-space: nowrap; }
  .fnote { grid-column: 2; grid-row: 2; font-size: 13.5px; line-height: 1.5; color: hsl(var(--ink-soft)); }
  .frow:has(.filediff.clipped) > summary .cue { display: block; }
  .frow-body { padding: 3px 0 13px; }

  /* ---- a file diff: one self-contained unit, addressable by id ---- */
  .filediff {
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    background: hsl(var(--paper-sunk));
    overflow: hidden;
    min-width: 0;
  }
  .hunk + .hunk { border-top: 1px solid hsl(var(--line)); }
  /* a hunk that counts against a different commit than the one above it is a
     different file underneath: the seam says so without a word. */
  .hunk + .hunk[data-src-break] { border-top-width: 3px; border-top-style: double; }
  .hh {
    display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px;
    padding: 7px 11px;
    font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
    color: hsl(var(--muted));
    background: hsl(var(--ink) / 0.04);
  }
  .hh-at { min-width: 0; overflow-wrap: anywhere; }
  /* the range and the commit it counts against are one fact, so they sit
     together instead of at opposite ends of a 900px bar. */
  .hh-src { flex: none; }
  .hh-src::before { content: "·"; margin-right: 8px; }
  .filediff .snip { padding: 6px 0 7px; }
  .filediff .snip .l { padding: 0 14px 0 0; border-left: 0; }
  /* the gutter rides along: numbers and the +/- stay put while the code
     scrolls under them, which is the difference between a readable diff and a
     wall of characters on a 390px screen. It carries its line's own wash, so a
     run of added lines is one field with one edge down its right side rather
     than two slabs with a seam between them. */
  .filediff .snip .gut {
    position: sticky; left: 0;
    display: inline-block;
    padding: 0 9px 0 8px;
    user-select: none;
    border-right: 2px solid var(--rail, transparent);
    background-color: hsl(var(--paper-sunk));
    background-image: linear-gradient(var(--gutwash, transparent), var(--gutwash, transparent));
  }
  .filediff .snip .l.add { --rail: var(--rail-add); --gutwash: var(--wash-add); }
  .filediff .snip .l.del { --rail: var(--rail-rem); --gutwash: var(--wash-rem); }
  /* a removed line carries its number from the old file, the way a unified
     diff prints it: without it the reader has no anchor into what was there. */
  .filediff .snip .n { display: inline-block; width: 2.6em; margin: 0; }
  .filediff .snip .g { width: 1.1em; text-align: center; }
  .filediff .snip .l.add .w { background: var(--word-add); border-radius: 2px; }
  .filediff .snip .l.del .w { background: var(--word-rem); border-radius: 2px; }
  /* a rewrite whose changed words are all on the other side still leaves a seam, and
     the seam is a mark of zero width. Given a sliver it says where the text went in. */
  .filediff .snip .l .w:empty { display: inline-block; width: 3px; }
  .filediff .snip .l.void-line { color: hsl(var(--muted)); }

  /* ---- code on a phone ----
     Horizontal scroll inside a diff is the right answer on a desk and the
     wrong one in a hand: at 390px it hid half of every line behind a gesture
     nobody makes. Below 700px the code soft-wraps instead, hanging past the
     gutter so the wrapped part of a line still reads as that line, and the
     type drops to 11px to buy back some of the width. It costs height, and
     height is the cheap axis here. Above 700px nothing about the diff
     changes: it scrolls, and it is the best thing on the page. */
  @media (max-width: 699.98px) {
    .snip { font-size: 11px; }
    .snip code { width: auto; }
    .snip .l { white-space: pre-wrap; overflow-wrap: anywhere; }
    .snip .l:has(> .n) { padding-left: calc(8px + 3.3em); text-indent: -3.3em; }
    .ba .snip .l { padding-left: 2em; text-indent: -2em; }
    .filediff .snip .l { padding-left: 58px; text-indent: -58px; }
    /* the hanging indent is the line's, not the gutter's: these are inline
       blocks, so they would otherwise inherit the pull and step off the edge */
    .snip .n, .snip .g, .filediff .snip .gut { text-indent: 0; }
    .filediff .snip .gut {
      position: static;
      width: 58px;
      padding: 0 8px 0 6px;
      /* nothing scrolls under it here, so it stops being a lid and lets the
         line's own wash and rail run straight through */
      background: none;
      border-right-color: transparent;
    }
    /* a wrapped line is three rows tall and the gutter only sits on the first,
       so the rail is drawn on the line itself and runs the whole way down */
    .filediff .snip .l.add,
    .filediff .snip .l.del {
      background-image: linear-gradient(to right, transparent 56px, var(--rail) 56px, var(--rail) 58px, transparent 58px);
    }
    /* nothing is clipped once it wraps, so nothing may claim it is */
    .snip.scroll-x { overflow-x: hidden; }
    .snip.scroll-x,
    .snip[data-clip="right"] { -webkit-mask-image: none; mask-image: none; }
    .fold.clipped > summary > .cue,
    .frow:has(.filediff.clipped) > summary .cue { display: none; }
  }

  /* on the narrowest screens the summary grid tightens, and the body indent
     follows it down by construction rather than by a second guess. */
  @media (max-width: 479.98px) {
    .row, .note { --sgap: 8px; }
    .grp { --ggap: 9px; }
  }

  /* ---- questions ---- */
  .qa .qline, .qa .aline { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 0 4px; font-size: 14.5px; }
  .qa .qline { color: hsl(var(--ink)); margin-bottom: 8px; }
  .qa .aline { color: hsl(var(--ink-soft)); }
  .qa .mk { font-family: var(--font-mono); font-size: 12px; color: hsl(var(--muted)); line-height: 1.6; }
  .qa .fold { margin-top: 10px; }

  .ask { margin-top: 24px; }
  /* the one line the queue owes the reader: where the text goes. Mono and
     muted, so it reads as a machine fact rather than a sentence to obey. */
  .ask-note {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: hsl(var(--muted));
    margin: 9px 0 0;
    letter-spacing: 0.01em;
  }
  .ask-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
  .ask-form textarea {
    flex: 1 1 240px;
    min-width: 0;
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.5;
    color: hsl(var(--ink));
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    padding: 10px 12px;
    resize: none;
    min-height: 72px;
  }
  .ask-form textarea::placeholder { color: hsl(var(--muted)); }
  .ask-form button {
    font-family: var(--font-body);
    font-size: 14.5px;
    font-weight: 500;
    color: hsl(var(--paper));
    background: hsl(var(--accent));
    border: 0;
    border-radius: 6px;
    padding: 0 18px;
    min-height: 44px;
    cursor: pointer;
  }
  /* the fill is the accent, so the button is the strongest ink on the page with
     the surface colour cut out of it: 17.98:1 in light, 16.24:1 in dark. Hover
     and press step back down the same ramp rather than sideways into a hue. */
  .ask-form button:active { background: hsl(var(--ink-soft)); }
  @media (hover: hover) and (pointer: fine) {
    .ask-form button { transition: background-color 160ms ease; }
    .ask-form button:hover { background: hsl(var(--ink)); }
  }
  .queue { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 14px; }
  .queue:empty { display: none; margin: 0; }
  .queue li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 0 14px; }
  .queue .qx { grid-column: 1 / -1; grid-row: 1; font-size: 14.5px; line-height: 1.5; color: hsl(var(--ink)); min-width: 0; overflow-wrap: anywhere; }
  .queue .qt { grid-column: 1; grid-row: 2; align-self: center; font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); }
  .queue .qd {
    grid-column: 2; grid-row: 2;
    display: inline-flex; align-items: center;
    background: none; border: 0; cursor: pointer;
    font-family: var(--font-body); font-size: 13px; color: hsl(var(--accent));
    padding: 0 8px; margin: 0 -8px; min-height: 44px;
    text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px;
  }
  .queue .qd:active { text-decoration-thickness: 2px; background-color: hsl(var(--ink) / 0.08); }
  @media (hover: hover) and (pointer: fine) {
    .queue .qd:hover { text-decoration-thickness: 2px; }
  }

  /* ---- colophon ---- */
  .colophon {
    margin-top: 34px;
    padding-top: 12px;
    border-top: 1px solid hsl(var(--line));
    font-size: 12.5px;
    color: hsl(var(--muted));
  }
  .colophon code { font-size: 0.9em; }

  /* every authored transition answers the same preference, and this sits last
     so the hover blocks above cannot re-enable one. */
  @media (prefers-reduced-motion: reduce) {
    .tick, .ref, .rtick,
    .note > summary, .row > summary, .grp > summary, .frow > summary, .fold > summary,
    .card > summary, .ask-form button { transition: none; }
  }
`;
// Lucide, ISC licensed, at its published 24x24 geometry, copied from the prototype.
const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false">
  <symbol id="i-add" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/><path d="M12 5v14"/>
  </symbol>
  <symbol id="i-change" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
    <path d="m15 5 4 4"/>
  </symbol>
  <symbol id="i-remove" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/>
  </symbol>
  <symbol id="i-keep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <line x1="5" x2="19" y1="9" y2="9"/><line x1="5" x2="19" y1="15" y2="15"/>
  </symbol>
  <symbol id="i-risk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
    <path d="M12 9v4"/><path d="M12 17h.01"/>
  </symbol>
  <symbol id="i-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
  </symbol>
  <symbol id="i-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="m9 18 6-6-6-6"/>
  </symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
  </symbol>
  <symbol id="i-cue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
  </symbol>
  <symbol id="i-pr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
    <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>
  </symbol>
  <symbol id="i-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
  </symbol>
  <symbol id="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
    <circle cx="12" cy="12" r="3"/>
  </symbol>
  <symbol id="i-contrast" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>
  </symbol>
</svg>`;

/** The pieces of the page the prototype had tokens for but no markup: the link out of
 *  a snippet panel, and the four evidence blocks that are not code in a fold. Kept
 *  apart from the transcribed block above so the prototype stays diffable against it. */
const EVIDENCE_STYLE = `
  .fold-out { margin: 0; padding: 8px 12px 10px; font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); border-top: 1px solid hsl(var(--line)); }
  .ev { margin: 12px 0 14px; }
  .ev-example .snipbox { margin: 0; }
  .ev figcaption { margin-top: 7px; font-size: 13px; line-height: 1.5; color: hsl(var(--muted)); }
  .ev-example .snip { padding: 9px 0 10px; }
  .ev-example .snip .l { padding: 0 12px; }
  .ev-attachment img { display: block; max-width: 100%; height: auto; border: 1px solid hsl(var(--line)); border-radius: 6px; background: hsl(var(--paper-sunk)); }
  .ev-bundle { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; font-size: 13.5px; color: hsl(var(--ink-soft)); }
  .ev-bundle .ic { align-self: center; color: hsl(var(--muted)); }
  .ev-bundle .ev-cap { color: hsl(var(--muted)); min-width: 0; }
  .ev-figure { border: 1px solid hsl(var(--line)); border-radius: 6px; padding: 11px 13px; background: hsl(var(--paper-sunk)); }
  /* the drawing is laid out server-side, so the only thing left to say here is what
     its ink is: one weight of line, one type size, and a muted state that steps back
     without changing hue. It scales with its box rather than fixing a pixel size. */
  .fig { display: block; width: 100%; max-width: 460px; height: auto; }
  .fig text { font-family: var(--font-mono); font-size: 11.5px; fill: hsl(var(--ink-soft)); }
  .fig text.dim, .fig text.cap { fill: hsl(var(--muted)); }
  .fig text.cap { font-size: 11px; }
  .fig .fig-box { fill: hsl(var(--paper)); stroke: hsl(var(--ink-soft)); stroke-width: 1.3; }
  .fig .fig-edge { fill: none; stroke: hsl(var(--ink-soft) / 0.45); stroke-width: 1.4; stroke-linecap: round; }
  .fig .fig-box.fig-dim { stroke: hsl(var(--muted)); }
  .fig .fig-edge.fig-dim { stroke: hsl(var(--muted) / 0.55); stroke-dasharray: 3 5; }
  .prbody-body { padding: 10px 12px 1px; }
  .prbody { margin: 0 0 10px; font-size: 13.5px; line-height: 1.6; color: hsl(var(--ink-soft)); white-space: pre-wrap; }
`;

/** Resolved before first paint so the surface never flashes, and stored so an explicit
 *  choice survives a reload. Without it the CSS floor still lands on the right surface. */
const THEME_SCRIPT = `(()=>{let t=null;try{t=localStorage.getItem("overseer:theme")}catch(e){}` +
  `const d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);` +
  `document.documentElement.dataset.theme=d?"dark":"light"})();`;

/** The enhancement, in full. Nothing here is load-bearing: the toggle appears only
 *  once it can work, a citation without it is a fragment jump the `:target` rules
 *  answer, and the clipping cue is a measurement no static page can make. */
const PAGE_SCRIPT = `
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.removeAttribute("hidden"));

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-toggle]");
    if (!b) return;
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("overseer:theme", next); } catch (x) {}
  });

  const openAncestors = (el) => {
    let d = el.parentElement && el.parentElement.closest("details");
    while (d) { d.open = true; d = d.parentElement && d.parentElement.closest("details"); }
  };

  const refsFor = new Map();
  document.querySelectorAll("a.ref[href^='#']").forEach((a) => {
    const id = a.getAttribute("href").slice(1);
    const target = document.getElementById(id);
    if (!target || target.tagName !== "DETAILS") return;
    if (!refsFor.has(id)) refsFor.set(id, []);
    refsFor.get(id).push(a);
    a.setAttribute("aria-controls", id);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const opening = !target.open;
      if (opening) openAncestors(target);
      target.open = opening;
      if (opening) target.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
    });
  });
  refsFor.forEach((links, id) => {
    const target = document.getElementById(id);
    const sync = () => links.forEach((a) => {
      a.classList.toggle("is-open", target.open);
      a.setAttribute("aria-expanded", target.open ? "true" : "false");
    });
    target.addEventListener("toggle", sync);
    sync();
  });

  const openFromHash = () => {
    const id = location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === "DETAILS") { openAncestors(el); el.open = true; }
    else openAncestors(el);
  };
  addEventListener("hashchange", openFromHash);
  openFromHash();

  const wraps = matchMedia("(max-width: 699.98px)");
  const snips = Array.from(document.querySelectorAll(".snip.scroll-x"));
  const measure = () => {
    const wrapped = wraps.matches;
    snips.forEach((el) => {
      const over = wrapped ? 0 : el.scrollWidth - el.clientWidth;
      const unit = el.closest("details.fold, .filediff");
      if (unit) unit.classList.toggle("clipped", over > 1);
      if (over > 1 && el.scrollLeft < over - 1) el.dataset.clip = "right";
      else delete el.dataset.clip;
    });
  };
  wraps.addEventListener("change", measure);
  snips.forEach((el) => el.addEventListener("scroll", measure, { passive: true }));
  document.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", measure));
  addEventListener("resize", measure, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
})();
`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
  "stroke='%231f1614' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath " +
  "d='M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'/%3E" +
  "%3Ccircle cx='12' cy='12' r='3'/%3E%3C/svg%3E";

// ---- the parts ----

/** The pull request description, as the characters GitHub holds. It is the one string
 *  on the page Overseer did not validate as constrained markdown, so it is not parsed
 *  as any markup at all: paragraphs, escaped. It is also unbounded and derived, so it
 *  gets its own fold rather than sitting between the authored detail and the ref. */
function prBody(ownerId: string, body: string): string {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (paras.length === 0) return "";
  return (
    `<details class="fold" id="${escapeHtml(ownerId)}-body">` +
    `<summary>${icon("chev", "tick")}<span class="fh"><b>description</b></span></summary>` +
    `<div class="fold-body prbody-body">` +
    paras.map((p) => `<p class="prbody">${escapeHtml(p)}</p>`).join("") +
    `</div></details>`
  );
}

/** Every ref the document carries, by id. `detail_ref` is stored as an id alone, so the
 *  snippet it names is found here; a version whose only mention of that ref was on a
 *  statement that has since been rewritten simply grows no fold. */
function refsById(doc: ReviewDoc): Map<string, Ref> {
  const byId = new Map<string, Ref>();
  const take = (refs: Ref[], evidence: Evidence[]) => {
    for (const r of refs) byId.set(r.id, r);
    for (const e of evidence) if (e.type === "ref") byId.set(e.ref.id, e.ref);
  };
  for (const s of doc.statements) take(s.refs, s.evidence);
  for (const n of doc.notes) take(n.refs, n.evidence);
  return byId;
}

function card(pr: Pr, refs: Map<string, Ref>): string {
  const kinds = pr.kinds
    .map((k) => icon(k, `ic k-${k}`, KIND_LABEL[k] ?? k))
    .join("");
  const owner = `pr-${pr.number}`;
  const detailRef = refs.get(pr.detailRef);
  const detailFold = detailRef ? refFold(owner, detailRef) : "";
  return (
    `<details class="card" id="${escapeHtml(owner)}">` +
    `<summary>` +
    `<a class="c-ref" href="https://github.com/${escapeHtml(pr.repo)}/pull/${pr.number}">` +
    `${icon("pr")}<span class="c-reftext">${escapeHtml(prKey(pr.repo, pr.number))}</span></a>` +
    `<span class="c-kinds">${kinds}</span>` +
    `${icon("chev", "tick")}` +
    `<span class="c-title">${escapeHtml(pr.title)}</span>` +
    `<span class="c-line">${safeInline(pr.gist)}</span>` +
    `</summary>` +
    `<div class="card-body">` +
    safeBlock(pr.detail) +
    detailFold +
    prBody(owner, pr.body) +
    `</div></details>`
  );
}

/** Stack order comes from the derived `parent` links, never from the array: nothing in
 *  the data model promises the pointers were listed bottom-up, so reading the array as
 *  the chain draws some stacks backwards and names the wrong base. */
function stackOrder(prs: Pr[]): Pr[] {
  const inReview = new Map(prs.map((pr) => [pr.number, pr]));
  const child = new Map<number, Pr>();
  for (const pr of prs) {
    if (pr.parent !== null && inReview.has(pr.parent)) child.set(pr.parent, pr);
  }
  const root = prs.find((pr) => pr.parent === null || !inReview.has(pr.parent));
  if (!root) return prs;
  const ordered: Pr[] = [];
  const walked = new Set<number>();
  let cur: Pr | undefined = root;
  while (cur && !walked.has(cur.number)) {
    walked.add(cur.number);
    ordered.push(cur);
    cur = child.get(cur.number);
  }
  // A second root, or a cycle off to the side: nothing is dropped from the page.
  for (const pr of prs) if (!walked.has(pr.number)) ordered.push(pr);
  return ordered;
}

/** The chain. Arrows are the claim that one pull request sits on the one above it, so
 *  they are drawn only for a stack; a set of unrelated pull requests gets cards alone,
 *  and no base line, because a set has no one base to name. */
function chain(doc: ReviewDoc): string {
  const stack = doc.kind === "stack";
  const prs = stack ? stackOrder(doc.prs) : doc.prs;
  const root = prs[0];
  const base =
    stack && root
      ? `<p class="base">${icon("branch")}<span>${escapeHtml(root.baseRef)}</span>` +
        `<span class="sha">${escapeHtml(shortSha(root.baseSha))}</span></p>`
      : "";
  const arrow = `${icon("arrow", "arw")}`;
  const refs = refsById(doc);
  const cards = prs.map((pr) => card(pr, refs)).join(stack ? arrow : "");
  return `<div class="chain">${base}${prs.length > 0 && stack ? arrow : ""}${cards}</div>`;
}

/** Refs resolve once per pointer, so a row listing the same pointer twice holds the same
 *  ref twice. Its panel is addressed by that ref's id, and two panels under one row would
 *  share an id, so a row cites each ref once. */
function uniqueRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

function statementRow(s: Statement, ctx: RenderCtx): string {
  const refs = uniqueRefs(s.refs);
  const chips = refs.map((r) => refChip(s.id, r)).join(" ");
  const folds = refs.map((r) => refFold(s.id, r)).join("");
  return (
    `<details class="row" id="${escapeHtml(s.id)}">` +
    `<summary>${icon("chev", "tick")}${icon(s.kind, `ic k-${s.kind}`, KIND_LABEL[s.kind] ?? s.kind)}` +
    `<span class="rwhat">${safeInline(s.text)}</span>` +
    `<span class="rrefs">${chips}</span>` +
    `</summary>` +
    `<div class="row-body">${safeBlock(s.body)}${folds}` +
    renderEvidence(s.evidence, s.id, ctx) +
    `</div></details>`
  );
}

function noteRow(n: Note, ctx: RenderCtx): string {
  const refs = uniqueRefs(n.refs);
  const chips = refs.map((r) => refChip(n.id, r)).join(" ");
  const folds = refs.map((r) => refFold(n.id, r)).join("");
  const checks =
    n.checks.length === 0
      ? ""
      : `<ul class="checks">${n.checks.map((c) => `<li>${safeInline(c)}</li>`).join("")}</ul>`;
  return (
    `<details class="note is-${escapeHtml(n.kind)}" id="${escapeHtml(n.id)}">` +
    `<summary>${icon("chev", "tick")}${icon(n.kind, `ic k-${n.kind}`, n.kind)}` +
    `<span class="none">${safeInline(n.text)}</span>` +
    `</summary>` +
    `<div class="note-body">${safeBlock(n.body)}${checks}${chips === "" ? "" : `<p class="rrefs">${chips}</p>`}${folds}` +
    renderEvidence(n.evidence, n.id, ctx) +
    `</div></details>`
  );
}

/** Risks first, then notes, each keeping the order it was authored in. A risk is the
 *  thing a reader would miss, so it does not wait behind an observation. */
function notesInOrder(notes: Note[]): Note[] {
  return [...notes.filter((n) => n.kind === "risk"), ...notes.filter((n) => n.kind !== "risk")];
}

/** A date the colophon can hold, or nothing. A stored timestamp out of the range Date
 *  can name is cosmetic, and a readable page beats a 500 over the line under it. */
function publishedOn(updatedAt: number): string {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return "";
  return ` · published ${at.toISOString().slice(0, 10)}`;
}

interface RenderCtx {
  wsId: string;
  /** The path this page is served under, which is what an attachment hangs off. */
  basePath: string;
}

export interface RenderInput {
  wsId: string;
  slug: string;
  doc: ReviewDoc;
  version: number;
  latestVersion: number;
  /** True when the URL pinned a version rather than asking for the current one. */
  pinned: boolean;
  freshness: Record<string, Freshness>;
}

export function renderReviewPage(input: RenderInput): string {
  const { doc, slug, wsId } = input;
  const ctx: RenderCtx = { wsId, basePath: `/${wsId}/r/${slug}` };

  const behind = doc.prs.filter((pr) => input.freshness[prKey(pr.repo, pr.number)] === "behind");
  const heads = behind.length === 0 ? "heads current" : `${behind.length} of ${doc.prs.length} behind`;
  const count = doc.prs.length === 1 ? "1 pull request" : `${doc.prs.length} pull requests`;
  const marking = input.pinned
    ? `version ${input.version} of ${input.latestVersion}`
    : `version ${input.version}`;

  const rows = doc.statements.map((s) => statementRow(s, ctx)).join("");
  const notes = notesInOrder(doc.notes)
    .map((n) => noteRow(n, ctx))
    .join("");

  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
    `<meta name="robots" content="noindex, nofollow">\n` +
    `<script>${THEME_SCRIPT}</script>\n` +
    `<title>${escapeHtml(doc.title)} · Overseer</title>\n` +
    `<link rel="icon" type="image/svg+xml" href="${FAVICON}">\n` +
    `<link rel="preload" href="/fonts/switzer.woff2" as="font" type="font/woff2" crossorigin>\n` +
    `<link rel="preload" href="/fonts/commit-mono-400.woff2" as="font" type="font/woff2" crossorigin>\n` +
    `<style>\n${STYLE}\n${EVIDENCE_STYLE}</style>\n` +
    `</head>\n<body>\n` +
    SPRITE +
    `\n<main class="doc">\n` +
    `<header class="head">` +
    `<div class="head-row">` +
    `<span class="brand">${icon("eye", "eye", "Overseer")}<span class="wordmark">overseer</span></span>` +
    `<span class="head-tag">${escapeHtml(`${slug} · ${marking}`)}</span>` +
    `<button type="button" class="theme-toggle" data-theme-toggle hidden ` +
    `aria-label="Switch between the light and dark reading surface">` +
    `${icon("contrast", "mark")}</button>` +
    `</div>` +
    `<h1 class="title">${safeInline(doc.title)}</h1>` +
    `<p class="meta"><span>${escapeHtml(doc.kind)}</span><span>${escapeHtml(count)}</span>` +
    `<span>${escapeHtml(heads)}</span></p>` +
    chain(doc) +
    `</header>\n` +
    `<section id="summary"><h2>Summary</h2>${safeBlock(doc.summary)}` +
    `<div class="rows">${rows}</div>` +
    `<p class="contents"><span class="nb"><a href="#summary">summary</a> ·</span> ` +
    `<span class="nb"><a href="#notes">review notes</a> ·</span> ` +
    `<span class="nb"><a href="#walkthrough">walkthrough</a></span></p>` +
    `</section>\n` +
    `<section id="notes"><h2>Review notes</h2><div class="notes">${notes}</div></section>\n` +
    walkthroughSection(doc) +
    `\n` +
    `<p class="colophon">${escapeHtml(
      `${slug} · ${marking}${publishedOn(doc.updatedAt)}`,
    )}</p>\n` +
    `</main>\n<script>${PAGE_SCRIPT}</script>\n</body>\n</html>\n`
  );
}

// ---- the routes ----

/** The one refusal this path has. Built from nothing the request carried, so a review
 *  in another workspace, a signed-out browser and a slug nobody ever published are one
 *  answer with one set of bytes. */
function softNotFound(): Response {
  return new Response(
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<meta name="robots" content="noindex, nofollow">\n<title>No such review</title>\n` +
      `</head>\n<body>\n<p>No such review</p>\n</body>\n</html>\n`,
    {
      status: 404,
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function versionNumber(raw: string): number | null {
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The review this request may read, or null for the one soft-404. `wsId` pins the
 *  workspace when the URL named one, which is the shape publish hands back; a bare
 *  slug resolves across every workspace the reader can reach, as the JSON path does. */
function resolveFor(req: Request, slug: string, wsId: string | null) {
  if (!SLUG_RE.test(slug)) return null;
  if (wsId !== null && !getWorkspace(wsId)) return null;
  const readable = readableWorkspaces(req);
  const ids = wsId === null ? readable : readable.filter((id) => id === wsId);
  if (ids.length === 0) return null;
  return resolveReview(ids, slug);
}

/**
 * GET /r/:slug and GET /r/:slug/v/:n, workspace-scoped or bare.
 *
 * `version` is null for the current version.
 */
export function handleReviewPage(
  req: Request,
  slug: string,
  version: string | null,
  wsId: string | null = null,
): Response {
  const review = resolveFor(req, slug, wsId);
  if (!review) return softNotFound();
  const ws = review.workspace_id;

  const asked = version === null ? review.latest_version : versionNumber(version);
  if (asked === null || asked > review.latest_version) return softNotFound();
  const row = getReviewVersion(ws, slug, asked);
  // A head pointer with no row behind it is corruption, not a miss: the publish path
  // writes the row and the pointer in one transaction.
  if (!row) throw new Error(`Review ${ws}/${slug} has no version row for version ${asked}`);

  const html = renderReviewPage({
    wsId: ws,
    slug,
    doc: row.doc,
    version: asked,
    latestVersion: review.latest_version,
    pinned: version !== null,
    freshness: freshnessOf(ws, slug, row.doc),
  });
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * GET /r/:slug/a/:id: an attachment's bytes, behind the same gate as its page.
 *
 * The id is scoped to the review, so an attachment cannot be pulled out of one review
 * by quoting its id at another slug.
 */
export async function handleReviewAttachment(
  req: Request,
  slug: string,
  id: string,
  wsId: string | null = null,
): Promise<Response> {
  if (!ATT_ID_RE.test(id)) return softNotFound();
  const review = resolveFor(req, slug, wsId);
  if (!review) return softNotFound();
  const ws = review.workspace_id;

  const row = getAttachment(ws, slug, id);
  if (!row) return softNotFound();
  const bytes = await openAttachment(ws, id);
  if (bytes === null) {
    // A row without its blob is corruption or a mispointed store. Say so in the log;
    // the reader still gets the same refusal as everything else on this path.
    console.error(
      `[seer] attachment ${id} has a db row but no blob at ${attachmentLocation(ws, id)}`,
    );
    return softNotFound();
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      // No content-length by hand: the row's byte count is a record of what was
      // stored, not a measure of what is being sent, and a disagreement between the
      // two truncates the reader instead of failing. Bun derives it from the body.
      "content-type": row.media_type,
      // The id is minted once and the bytes behind it never change, but the review it
      // belongs to is private, so this is a private cache only.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      // Same shape as /i/: bytes served from this origin get no privileges of their own.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
