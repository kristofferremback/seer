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
import { agoWords } from "../relative-time";
import { getWorkspace, listUserWorkspaces } from "../db";
import { sessionUser, type SessionUser } from "../auth";
import { openAttachment, attachmentLocation } from "../store";
import {
  getAttachment,
  getReview,
  getReviewRead,
  getReviewVersion,
  listAnnotations,
  listReviewVersions,
  resolveReview,
  setReviewRead,
  type ReviewDoc,
} from "./db";
import {
  statusMark,
  computeDelta,
  DeltaIndex,
  designPathsHtml,
  entityEditControl,
  evidenceFieldNames,
  marked,
  movedStatus,
  prBodyHtml,
  safeId,
  touched,
  type EntityDelta,
} from "./delta";
import type { PrStatusWord } from "./installations";
import { freshnessOf, observedAtOf, resolveFor, statusesOf } from "./read";
import {
  KIND_LABEL,
  hunkAnchorId,
  kindMark,
  statHtml,
  stats,
  walkthroughSection,
} from "./render-diff";
import {
  icon,
  indexHunks,
  refLink,
  refLinks,
  refFold,
  renderEvidence,
  safeBlock,
  safeInline,
  shortSha,
  type EvidenceMarks,
  type HunkIndex,
} from "./render-evidence";
import {
  OBSERVATION_STALE_MS,
  prKey,
  type Annotation,
  type DesignCoverage,
  type DesignModule,
  type Evidence,
  type Freshness,
  type Hunk,
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
       neutral, because its job is to be skipped.

       The code itself was moved up to full ink at the same time as the values
       below were measured. It used to be set in the body's softened ink, which
       made the one thing this page exists to show the quietest text on it.

       These were far quieter until it was measured against a real page, twice.
       The rule had been that syntax stays under 70% of the *quietest* semantic
       mark, and at that ceiling a keyword cleared the body text by dE 23 with a
       lightness gap under 6: distinct to a colorimeter, flat to a person,
       because at that darkness the whole difference is hue and hue is the
       first thing to go at 12px. Legible syntax was unreachable under the rule.

       Two corrections. The ceiling is the *loudest* semantic mark rather than
       70% of the quietest, because what stops a keyword reading as a change
       marker is hue distance and nothing else: violet and blue sit 63 to 90
       degrees from add, remove and change, and no chroma moves that. And the
       comparison is made in OKLCh, which is the space the colour law names;
       CIELAB exaggerates violet against red badly enough to have rejected
       every readable keyword for the wrong reason.

       Measured a third time, on a phone, where it failed. Against the sunk
       panel a diff is drawn on, the comment stood at 3.4:1, under the floor
       for body text at any size and certainly at 12px in daylight, and the
       two hues at 5.8 and 5.1 were carrying a page whose subject is code.

       So the band is spent rather than saved. Both hues sit just under the
       ceiling in chroma and are pushed down the lightness ramp until they
       clear the panel properly, and the comment is lifted until it is legible
       while staying the weakest thing on the surface. Measured in OKLCh
       against the removal red at C 0.157, contrast against the sunk panel:
       keyword C 0.155 at 7.8:1, literal C 0.145 at 7.4:1, comment C 0.050 at
       4.9:1. Every one still under the loudest semantic mark; the hues sit at
       312 and 258, which is 76 and 106 degrees off the nearest of add 152,
       change 66 and remove 28. */
    --syn-cm: 12 22% 40%;
    --syn-kw: 280 56% 33%;
    --syn-st: 214 93% 30%;

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

    /* Same band at the other end, with the ceiling read the way the rule
       states it rather than by habit: the loudest semantic mark in dark is
       the change amber at C 0.127, not the remove red at 0.112. Keyword
       C 0.123 at 9.7:1 on the sunk panel, literal C 0.111 at 10.2:1, comment
       C 0.030 at 6.9:1. Hues 318 and 239, which is 64 and 86 degrees off the
       nearest of add 153, change 79 and remove 22. */
    --syn-cm: 14 16% 62%;
    --syn-kw: 286 72% 79%;
    --syn-st: 204 95% 72%;

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

      --syn-cm: 16 12% 54%;
      --syn-kw: 283 58% 76%;
      --syn-st: 206 70% 71%;

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
  /* clip, not hidden: hidden makes the viewport a scroll container, and a phone
     will still pan it sideways to whatever pokes past the edge. clip forbids the
     axis outright, so a long token that escapes every rule below costs its own
     tail and never drags the page with it. */
  html { -webkit-text-size-adjust: 100%; overflow-x: clip; }
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
    overflow-x: clip;
    /* every string on this page that GitHub authored can be one unbroken token:
       a migration filename, a branch, a URL in a description. Inherited by all
       prose, so a word wider than the column breaks instead of widening it. */
    overflow-wrap: break-word;
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

  /* ---- the lede: the account and the stack it belongs to ----
     One tube on a phone. Everywhere else the stack is an aside in the right
     gutter, on the same row as the account rather than above it: both carry an
     explicit row, because the chain comes first in the markup and auto placement
     would otherwise put the account on the row beneath it.

     The account keeps the middle column. The left gutter is the one that
     collapses first, so a narrow window left-aligns the account rather than
     squeezing the aside, and a wide one centres it with the aside capped beside
     it rather than sprawling across a large monitor. The lede repeats the
     document's own column template so the summary lines up with every section
     under it. */
  .lede > .chain { margin-top: 20px; }
  @media (min-width: 880px) {
    .doc {
      max-width: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 760px) minmax(260px, 1fr);
      column-gap: 40px;
    }
    .doc > * { grid-column: 2; }
    .lede {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 760px) minmax(260px, 1fr);
      column-gap: 40px;
      align-items: start;
    }
    .lede > #summary { grid-column: 2; grid-row: 1; margin-top: 0; min-width: 0; }
    .lede > .chain {
      grid-column: 3; grid-row: 1;
      width: 100%; max-width: 420px; min-width: 0;
      margin-top: 4px;
    }
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
     circle, no decoration behind any of them; each takes its colour from
     currentColor. */
  .sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
  .ic { flex: none; display: block; width: 14px; height: 14px; stroke-width: 1.8; }
  .ic-lg { width: 15px; height: 15px; stroke-width: 1.7; }
  .k-add { color: hsl(var(--add)); }
  .k-change { color: hsl(var(--change)); }
  .k-remove { color: hsl(var(--remove)); }
  .k-keep { color: hsl(var(--muted)); }
  .k-decision { color: hsl(var(--change)); }
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
    font-weight: 550;
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
  /* "as of <time>" only appears when the observation behind the chip is old, so it is
     not decoration to be quieted: it is the page admitting the chip beside it is a
     memory. It sits at the weight of the row rather than below it. */
  .meta .asof { color: hsl(var(--muted)); font-variant-numeric: tabular-nums; }
  /* the repair, beside the thing it repairs. With the automatic check deleted this is
     the only control on the page that reaches GitHub, and it does so because a human
     asked it to. */
  .refresh {
    font: inherit;
    color: hsl(var(--muted));
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: hsl(var(--muted) / 0.4);
  }
  .refresh:hover { color: hsl(var(--ink)); }
  .refresh[disabled] { cursor: default; opacity: 0.55; text-decoration: none; }

  /* ---- sections ---- */
  section { margin-top: 30px; scroll-margin-top: 20px; }
  h2 {
    font-family: var(--font-body);
    font-weight: 550;
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
     A chevron and an underlined file location point to the code block below. There is
     no badge around it: link ink says it is interactive, the chevron says it opens,
     and a generated 44px hit area keeps the unboxed text usable on touch screens. */
  .ref {
    position: relative;
    display: inline-flex;
    align-items: flex-start;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1.45;
    color: hsl(var(--accent));
    cursor: pointer;
    text-decoration: none;
  }
  /* a migration filename is longer than a phone is wide. The label wraps rather
     than carrying the page off the right edge, and the chevron holds the first
     line instead of centring on however many the name takes. */
  .reftext { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; min-width: 0; overflow-wrap: anywhere; }
  .ref:hover, .ref:active { text-decoration: none; background: none; }
  .ref:active .reftext { text-decoration-thickness: 2px; }
  .rtick {
    display: inline-block;
    flex: none;
    width: 10px; height: 10px;
    margin-top: 3px;
    stroke-width: 2.5;
    transform: rotate(0deg);
    transition: transform 150ms cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .ref::after { content: ""; position: absolute; left: -6px; right: -6px; top: 50%; height: 44px; transform: translateY(-50%); }
  .ref.is-open { color: hsl(var(--accent)); }
  .ref.is-open .rtick { transform: rotate(90deg); }
  @media (hover: hover) and (pointer: fine) {
    .ref:hover .reftext { text-decoration-thickness: 2px; }
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
  .dmodule > summary:active,
  .coverage-row > summary:active,
  .grp > summary:active,
  .frow > summary:active,
  .fold > summary:active { background-color: hsl(var(--ink) / 0.06); }
  @media (hover: hover) and (pointer: fine) {
    .note > summary, .row > summary, .dmodule > summary, .coverage-row > summary,
    .grp > summary, .frow > summary, .fold > summary { transition: background-color 150ms ease; }
    .note > summary:hover,
    .row > summary:hover,
    .dmodule > summary:hover,
    .coverage-row > summary:hover,
    .grp > summary:hover,
    .frow > summary:hover,
    .fold > summary:hover { background-color: hsl(var(--ink) / 0.035); }
  }

  /* the panel is simply there if the animation never runs: no fill-mode */
  @media (prefers-reduced-motion: no-preference) {
    details[open] > .fold-body,
    details[open] > .note-body,
    details[open] > .row-body,
    details[open] > .dmodule-body,
    details[open] > .coverage-body,
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
  .fold > summary .fh .fhpath { overflow-wrap: anywhere; }
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
    /* full ink, not the body's softened ink: an identifier is the thing being
       read on a code surface, and everything that is not one (punctuation,
       gutter, comment) steps back from it rather than it stepping down. */
    color: hsl(var(--ink));
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
  /* a file cited at several lines: the name once, then each line as its own link */
  .refset { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; font-family: var(--font-mono); font-size: 11.5px; }
  .reffile { color: hsl(var(--muted)); min-width: 0; overflow-wrap: anywhere; }
  .refline { gap: 3px; }
  .row-body { padding: 4px 2px 18px calc(4px + 12px + 14px + var(--sgap) * 2); }
  .row-body > *:first-child { margin-top: 0; }
  .row-body p { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin-bottom: 13px; }
  .row-body .fold { margin: 10px 0; }
  .row-body .fold + .fold { margin-top: 8px; }
  @media (min-width: 680px) {
    .row { --sgap: 12px; }
    /* the citations stay under the claim at every width. Beside it they took the
       widest column on the row and pushed the sentence into a narrower one, which
       is backwards: the claim is what is being read. */
    .rrefs { margin-top: 1px; }
  }

  /* ---- the two accounts and code design ---- */
  .account { margin-top: 17px; }
  .account-title {
    display: flex; align-items: center; gap: 7px; margin: 0 0 7px;
    font-family: var(--font-body); font-size: 13px; font-weight: 500;
    line-height: 1.35; color: hsl(var(--muted));
  }
  .account-icon { display: block; flex: none; width: 14px; height: 14px; stroke-width: 1.7; }
  .author-intent { border-left: 2px solid hsl(var(--line)); padding-left: 12px; color: hsl(var(--ink-soft)); }
  .witness-account { color: hsl(var(--ink)); }
  #design { margin-top: 38px; }
  #design > h2 { margin-bottom: 7px; }
  .placement { max-width: 760px; color: hsl(var(--ink-soft)); margin-bottom: 18px; }
  .design-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .dmodule, .coverage-row { border: 1px solid hsl(var(--line)); background: hsl(var(--paper)); }
  .dmodule > summary, .coverage-row > summary {
    list-style: none; cursor: pointer; display: grid; align-items: start;
    grid-template-columns: 14px minmax(0, 1fr); column-gap: 9px; padding: 13px 14px;
  }
  .dmodule > summary::-webkit-details-marker, .coverage-row > summary::-webkit-details-marker { display: none; }
  .dmodule > summary .tick, .coverage-row > summary .tick { margin-top: 3px; }
  .dmodule-head { min-width: 0; }
  .dmodule-title, .coverage-title { display: block; font-size: 14px; font-weight: 500; color: hsl(var(--ink)); }
  .dmodule > summary .rrefs, .coverage-row > summary .rrefs { grid-column: 2; margin-top: 6px; }
  .dmodule-body, .coverage-body { padding: 0 14px 15px 37px; color: hsl(var(--ink-soft)); }
  .dmodule-body > p:first-child, .coverage-body > p:first-child { margin-top: 0; }
  .dpaths { display: flex; flex-wrap: wrap; gap: 3px 8px; margin: 10px 0; }
  .dpath { display: inline-block; font: 400 10.5px/1.35 var(--font-mono); color: hsl(var(--muted)); overflow-wrap: anywhere; }
  .dpath + .dpath::before { content: "·"; margin-right: 8px; color: hsl(var(--line)); }
  .design-refs { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0; }
  .coverage-list { border-top: 1px solid hsl(var(--line)); }
  .coverage-row { border-width: 0 0 1px; }
  .design-heading {
    display: flex; align-items: center; gap: 7px; margin: 25px 0 7px;
    font: 500 14px/1.35 var(--font-body); color: hsl(var(--ink-soft));
  }
  .design-heading .ic { color: hsl(var(--muted)); }
  @media (max-width: 720px) { .design-grid { grid-template-columns: 1fr; } }

  /* ---- review focus ---- */
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
  /* the branch is named by whoever pushed it; a long one wraps in place. The
     sha beside it is seven characters and stays whole. */
  .base > span { min-width: 0; overflow-wrap: anywhere; }
  .base .sha { flex: none; }
  .base .sha { color: hsl(var(--muted) / 0.85); }
  .arw { display: block; flex: none; width: 14px; height: 14px; stroke-width: 1.8; color: hsl(var(--muted) / 0.55); margin: 4px 0 4px var(--spine); }

  .card {
    position: relative;
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    min-width: 0;
  }
  /* the card stacks: the title takes the width it needs and the identity line
     sits under it, so nothing on a card competes for one row and nothing wraps
     mid-token in a 296px column */
  .card > summary {
    display: block;
    padding: 11px var(--spine) 12px;
  }
  .c-head { display: flex; align-items: flex-start; gap: 10px; }
  .c-title {
    flex: 1 1 auto; min-width: 0;
    font-size: 14.5px; font-weight: 500; line-height: 1.35; color: hsl(var(--ink));
  }
  .card > summary .tick { flex: none; margin-top: 3px; }
  .c-id {
    display: flex; align-items: baseline; gap: 10px;
    margin-top: 5px;
    flex-wrap: wrap;
  }
  /* the ref is the one thing on the card that leaves the page, so it carries
     its own hit area and sits above the summary's. */
  .c-ref {
    position: relative; z-index: 1;
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--font-mono); font-size: 12px; font-weight: 500;
    min-width: 0;
  }
  .c-ref::after { content: ""; position: absolute; left: -6px; right: -6px; top: 50%; height: 34px; transform: translateY(-50%); }
  /* the rule belongs under the text, not under the mark that labels it */
  .c-ref, .c-ref:active { text-decoration: none; background-color: transparent; }
  .c-reftext { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; min-width: 0; overflow-wrap: anywhere; }
  .c-ref:active .c-reftext { text-decoration-thickness: 2px; }
  @media (hover: hover) and (pointer: fine) {
    .c-ref:hover .c-reftext { text-decoration-thickness: 2px; }
  }
  /* ---- the one place GitHub's palette is allowed on this page ----
     Green, purple and red are none of Seer's mark families, and they are admitted on
     one ground: these colours are quoted, not authored. They express GitHub's encoding
     rather than Seer's judgment, and a reader who has seen ten thousand of them reads
     the card without being taught anything.

     The exception is bounded and the bound is the rule: this glyph only. Never a wash,
     a border, text or a chip; one glyph per card, at the size of the marks beside it;
     colour is never the only channel (four shapes, and the word in the accessible
     name); and dark theme uses GitHub's own dark variants rather than lightened light
     ones. If it spreads past the glyph the rule has been broken, and the exception
     does not widen. */
  .c-status { flex: none; align-self: center; }
  .c-status.s-open { color: #1a7f37; }
  .c-status.s-merged { color: #8250df; }
  .c-status.s-closed { color: #cf222e; }
  .c-status.s-draft { color: #6e7781; }
  :root[data-theme="dark"] .c-status.s-open { color: #3fb950; }
  :root[data-theme="dark"] .c-status.s-merged { color: #a371f7; }
  :root[data-theme="dark"] .c-status.s-closed { color: #f85149; }
  :root[data-theme="dark"] .c-status.s-draft { color: #8b949e; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .c-status.s-open { color: #3fb950; }
    :root:not([data-theme="light"]) .c-status.s-merged { color: #a371f7; }
    :root:not([data-theme="light"]) .c-status.s-closed { color: #f85149; }
    :root:not([data-theme="light"]) .c-status.s-draft { color: #8b949e; }
  }
  .c-stat { font-family: var(--font-mono); font-size: 11.5px; white-space: nowrap; }
  .stat { white-space: nowrap; }
  /* A count is not a change. The added and deleted lines carry the change hues where
     they are, in the diff; the tallies read as the secondary text they are. */
  .stat .s-add, .stat .s-del { color: hsl(var(--muted)); }
  /* what a tap adds: the marks and the gist, then the author's own account
     behind one more fold */
  .c-open { padding: 2px var(--spine) 12px; }
  /* the marks are the first thing a tap reveals, so they get room to land in
     rather than butting against the line they opened from */
  .c-kinds { display: flex; align-items: center; gap: 9px; margin: 4px 0 7px; }
  .c-more > summary {
    display: flex; align-items: center; gap: 7px;
    margin-top: 10px; padding: 0;
    font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted));
  }
  .c-more > summary .tick { flex: none; }
  .c-more[open] > summary { margin-bottom: 8px; }
  .c-morelabel { min-width: 0; overflow-wrap: anywhere; }
  .c-line { font-size: 13px; line-height: 1.5; color: hsl(var(--ink-soft)); display: block; }
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
     is where it and the count meet, so both tighten a step. */
  @media (max-width: 479.98px) {
    .card > summary { padding-right: 12px; }
    .c-id { gap: 8px; }
    .c-ref { font-size: 11.5px; gap: 6px; }
    .c-kinds { gap: 8px; }
  }
  @media (min-width: 700px) {
    .chain { --spine: 16px; margin-top: 24px; }
    .arw { margin-top: 6px; margin-bottom: 6px; }
    .card > summary { padding: 13px var(--spine) 14px; }
    .c-open { padding: 2px var(--spine) 14px; }
    .card-body { padding: 0; }
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
  /* a removed stub carries no kind icon, so its title is pinned to the title
     column and the icon column is simply left empty. */
  .grp.dgoneunit > summary > .gname { grid-column: 3; }
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
  .gsum > * { font-size: inherit; line-height: inherit; color: inherit; }
  .gsum > *:first-child { margin-top: 0; }
  .gsum > *:last-child { margin-bottom: 0; }

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
  /* what the partition could not claim. It sits above the groups because it is a
     qualification on all of them, and it wears the risk mark because an account
     with a hole in it is exactly what a reader needs told. */
  .unaccounted {
    margin: 0 0 18px; padding: 12px 14px;
    border: 1px solid hsl(var(--risk) / 0.35);
    border-radius: 6px;
    background: hsl(var(--risk) / 0.05);
  }
  .unhead {
    display: flex; align-items: flex-start; gap: 9px;
    margin: 0; font-size: 14px; line-height: 1.55; color: hsl(var(--ink));
  }
  .unhead .ic { flex: none; margin-top: 3px; }
  .unlist { list-style: none; margin: 9px 0 0; padding: 0 0 0 25px; display: grid; gap: 6px; }
  .unlist li { display: grid; gap: 1px; }
  .unpath { font-family: var(--font-mono); font-size: 12px; color: hsl(var(--ink)); overflow-wrap: anywhere; }
  .unwhy { font-size: 12.5px; line-height: 1.5; color: hsl(var(--muted)); overflow-wrap: anywhere; }
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
     Code below 700px used to soft-wrap. It was the wrong trade: a wrapped line
     is not the line the author wrote, indentation stops carrying structure,
     and one long call turns three lines of a hunk into eight rows of prose.
     Nobody reads code that way. So the phone scrolls sideways like everything
     else does, the gutter stays sticky at the left edge so the numbers and the
     +/- never leave, and the type stays at 11.5px, which is the size at which
     80 columns of Commit Mono still resolve in a hand.

     Two things make the gesture work rather than merely exist. The scroll is
     contained, so swiping to the end of a line cannot hand the gesture to the
     browser's back navigation. And the clipped edge fades, which is the only
     thing on the page saying there is more line to the right. */
  @media (max-width: 699.98px) {
    .snip { font-size: 11.5px; }
    .snip.scroll-x { overscroll-behavior-x: contain; }
    /* the touch scrollbar is a resting hint as much as a control: 6px of it on
       a phone is a hair, so it thickens where the pointer is coarse. */
    .snip.scroll-x::-webkit-scrollbar { height: 8px; }
  }

  /* on the narrowest screens the summary grid tightens, and the body indent
     follows it down by construction rather than by a second guess. */
  @media (max-width: 479.98px) {
    .row, .note { --sgap: 8px; }
    .grp { --ggap: 9px; }
  }

  /* ---- questions ---- */

  /* the one line the queue owes the reader: where the text goes. Mono and
     muted, so it reads as a machine fact rather than a sentence to obey. */
  /* the fill is the accent, so the button is the strongest ink on the page with
     the surface colour cut out of it: 17.98:1 in light, 16.24:1 in dark. Hover
     and press step back down the same ramp rather than sideways into a hue. */
  @media (hover: hover) and (pointer: fine) {
  }
  @media (hover: hover) and (pointer: fine) {
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
    .card > summary { transition: none; }
  }
`;
// Lucide, ISC licensed, at its published 24x24 geometry, copied from the prototype.
// One exception, drawn here: `i-change` is a wave, because the pencil it used to be is
// the edited control's glyph (`i-edit`) and a glyph may mean one thing on a page.
const SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false">
  <symbol id="i-add" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/><path d="M12 5v14"/>
  </symbol>
  <symbol id="i-change" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 15c2.7-5 5.8-5 8 0s5.3 5 8 0"/>
  </symbol>
  <symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
    <path d="m15 5 4 4"/>
  </symbol>
  <symbol id="i-remove" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/>
  </symbol>
  <symbol id="i-keep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <line x1="5" x2="19" y1="9" y2="9"/><line x1="5" x2="19" y1="15" y2="15"/>
  </symbol>
  <symbol id="i-decision" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="m12 3 9 9-9 9-9-9z"/><path d="M9.7 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.5 2-2.5 3.5"/><path d="M12 17h.01"/>
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
  <!-- the four status glyphs, from GitHub's own vocabulary. Four distinct shapes, so
       the reading survives colour being removed: an open pull request, a merge, a
       cross, and the open shape drawn broken for a draft. -->
  <symbol id="i-pr-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
    <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>
  </symbol>
  <symbol id="i-pr-merged" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
    <path d="M6 21V9a9 9 0 0 0 9 9"/>
  </symbol>
  <symbol id="i-pr-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="6" r="3"/><line x1="6" x2="6" y1="9" y2="21"/>
    <path d="m21 3-6 6"/><path d="m15 3 6 6"/>
  </symbol>
  <symbol id="i-pr-draft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
    <path d="M18 6v1"/><path d="M18 11v1"/><line x1="6" x2="6" y1="9" y2="21"/>
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
  <!-- the two marks the full-screen panel is worked by: four corners pushed out,
       and the cross that puts them back. -->
  <symbol id="i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 3h6v6"/><path d="m14 10 7-7"/>
    <path d="M9 21H3v-6"/><path d="m10 14-7 7"/>
  </symbol>
  <symbol id="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
  </symbol>
  <symbol id="i-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </symbol>
</svg>`;

/** The pieces of the page the prototype had tokens for but no markup: the link out of
 *  a snippet panel, and the four evidence blocks that are not code in a fold. Kept
 *  apart from the transcribed block above so the prototype stays diffable against it. */
const EVIDENCE_STYLE = `
  .fold-out { margin: 0; padding: 8px 12px 10px; font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); border-top: 1px solid hsl(var(--line)); }
  /* a ref into changed code is drawn as the diff it cites, in the walkthrough's own
     grammar. The line washes and gutter glyphs come with the .snip rules; the word
     marks are scoped to .filediff there, so the fold carries its own copy. */
  .fold .snip .l.add .w { background: var(--word-add); border-radius: 2px; }
  .fold .snip .l.del .w { background: var(--word-rem); border-radius: 2px; }
  .fold .snip .l .w:empty { display: inline-block; width: 3px; }
  .ev { margin: 12px 0 14px; }
  .ev-example .snipbox { margin: 0; }
  .ev figcaption { margin-top: 7px; font-size: 13px; line-height: 1.5; color: hsl(var(--muted)); }
  .ev-example .snip { padding: 9px 0 10px; }
  .ev-example .snip .l { padding: 0 12px; }
  .ev-attachment img { display: block; max-width: 100%; height: auto; border: 1px solid hsl(var(--line)); border-radius: 6px; background: hsl(var(--paper-sunk)); }
  .ev-bundle { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; font-size: 13.5px; color: hsl(var(--ink-soft)); }
  .ev-bundle .ic { align-self: center; color: hsl(var(--muted)); }
  .ev-bundle .ev-cap { color: hsl(var(--muted)); min-width: 0; }
  .ev-was { margin: 6px 0 0; color: hsl(var(--muted)); font-size: 12px; }
  .gfiles { margin: 6px 0 0; color: hsl(var(--muted)); font-size: 12px; }
  .gfile { font-family: var(--font-mono); }
  /* a stub carries its former file list without the .gfiles wrapper, so the paths
     take that wrapper's size and ink here. */
  .dpb .gfile { font-size: 12px; color: hsl(var(--muted)); margin-right: 8px; }
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

/** The reading arc and the section clarifiers.
 *
 *  The overview's two accounts used to be labelled by provenance alone — "Author
 *  intent", "Witness account" — which told a reader who was speaking and never which
 *  question was being answered. The page's own arc is the reader's three questions in
 *  order: what problem, what solution, how implemented. So each label leads with the
 *  question and keeps the provenance as its quiet suffix, because the two accounts
 *  disagreeing is a finding and the reader must still see whose words are whose.
 *
 *  The clarifier under a section heading is one muted line saying what the section
 *  holds. "Coverage" and "Review focus" are this product's own vocabulary, and a
 *  heading a first-time reader cannot decode is ambiguity, not economy. */
const STRUCTURE_STYLE = `
  .account-title { color: hsl(var(--ink-soft)); }
  .account-prov { color: hsl(var(--muted)); font-weight: 400; }
  .rows-title {
    display: flex; align-items: center; gap: 7px; margin: 20px 0 0;
    font: 500 13px/1.35 var(--font-body); color: hsl(var(--ink-soft));
  }
  .rows-title + .rows { margin-top: 8px; }
  .secnote { margin: -4px 0 14px; font-size: 13px; line-height: 1.55; color: hsl(var(--muted)); }
  #notes .secnote, #walkthrough .secnote { margin: 7px 0 6px; }
  .design-heading + .secnote { margin: -2px 0 8px; }
`;

/** Code, taken out of the column.
 *
 *  A review column is 760px wide and a phone is 390px, and there is no width at which
 *  a diff of real code is comfortable inside a paragraph of prose. So every code
 *  surface carries one control that lifts it onto the whole screen: the walkthrough's
 *  file diffs, the quoted refs, the payloads and the examples, the same mark in the
 *  same corner of each.
 *
 *  On a phone the panel is the screen — a title, a cross, and code — because the phone
 *  has no width to spend on anything else. On a desk it is a panel the size of the
 *  application rather than the size of the monitor, and a reader with a large monitor
 *  can drag it larger from its corner and have that remembered. The cap is deliberate:
 *  a 5000px line of code is not more readable than a 1600px one.
 *
 *  Inside the panel the whole file scrolls as one surface rather than each hunk
 *  scrolling on its own, so a column of code is followed down the file with one
 *  gesture and the gutter stays pinned to the panel's left edge the whole way. */
const ZOOM_STYLE = `
  .filediff, .snipbox, .fold { position: relative; }
  .zoom {
    position: absolute; top: 5px; right: 6px; z-index: 2;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 34px; min-height: 34px; padding: 8px;
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    background: hsl(var(--paper));
    color: hsl(var(--muted));
    cursor: pointer; line-height: 0;
  }
  .zoom .mark { display: block; width: 15px; height: 15px; stroke-width: 1.7; }
  .zoom:active { background: hsl(var(--paper-sunk)); color: hsl(var(--ink)); }
  @media (hover: hover) and (pointer: fine) {
    .zoom:hover { color: hsl(var(--ink)); border-color: hsl(var(--ink) / 0.3); }
  }
  /* the thumb is the unit here, not the cursor */
  @media (pointer: coarse) { .zoom { min-width: 42px; min-height: 42px; } }
  /* the control sits in the block's own top rail, so the rail gives it room
     rather than the code running under it */
  .filediff > .hunk:first-of-type .hh { padding-right: 48px; }
  /* only while the control is there. A closed fold's summary is the primary
     label (a path, a sha, a line range), and reserving 48px beside a control
     that is not drawn wraps that label onto a second row of every closed fold
     on a phone. */
  .fold[open] > summary { padding-right: 48px; }
  /* a closed fold is a line of text, not a code surface: nothing to enlarge yet */
  .fold:not([open]) > .zoom { display: none; }
  /* a payload or an example has no rail of its own, so it is given one: without
     it the opaque control sits on the first line of the code and, because it
     rides the box rather than the scroller, scrolling never brings out what is
     underneath it. */
  .snipbox > .zoom + .snip { padding-top: 34px; }

  html.code-open { overflow: hidden; }
  .zoomdlg {
    display: none;
    padding: 0; margin: 0; border: 0;
    width: 100dvw; max-width: 100dvw;
    height: 100dvh; max-height: 100dvh;
    background: hsl(var(--paper));
    color: hsl(var(--ink));
    overflow: hidden;
  }
  .zoomdlg[open] { display: flex; flex-direction: column; }
  /* a scrim darkens in both themes: the ink is a near-white in dark, and a veil
     of it would light the page up rather than put it behind glass */
  .zoomdlg::backdrop { background: hsl(0 0% 0% / 0.5); }
  .zoom-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    padding-top: max(5px, env(safe-area-inset-top));
    padding-right: 5px;
    padding-bottom: 5px;
    padding-left: max(13px, env(safe-area-inset-left));
    border-bottom: 1px solid hsl(var(--line));
  }
  /* the path is the only word the panel spends, and it is the one word a reader
     who is now looking at code with no page around it actually needs */
  .zoom-title {
    font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted));
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .zoom-x {
    margin-left: auto; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px; padding: 10px;
    border: 0; border-radius: 6px; background: none;
    color: hsl(var(--accent)); cursor: pointer; line-height: 0;
  }
  .zoom-x .mark { display: block; width: 18px; height: 18px; stroke-width: 1.6; }
  .zoom-x:active { background: hsl(var(--ink) / 0.07); }
  /* the UA ring is drawn for a control the size of a thumb and reads as a slab at
     this scale. Same job, the page's own ink, and only for the keyboard. */
  .zoomdlg :focus-visible {
    outline: 2px solid hsl(var(--accent));
    outline-offset: 2px;
    border-radius: 6px;
  }
  .zoom-body:focus, .zoom-body:focus-visible { outline: none; }
  .zoom-body {
    flex: 1 1 auto; min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background: hsl(var(--paper-sunk));
    padding-bottom: env(safe-area-inset-bottom);
  }
  /* shrink-wrapped to the widest line, so the panel scrolls the file as one
     surface and a short line's wash still runs the full width of it */
  .zoom-inner { display: inline-block; min-width: 100%; vertical-align: top; }
  .zoom-body .snip.scroll-x { overflow: visible; -webkit-mask-image: none; mask-image: none; }
  .zoom-body .filediff, .zoom-body .snipbox {
    border: 0; border-radius: 0; background: none; overflow: visible;
  }
  .zoom-body .snip { font-size: 12.5px; padding-bottom: 16px; }
  /* which hunk is being read stays said while it is being read: the range rides
     the top of the panel until the next hunk pushes it off. Opaque, because the
     code now scrolls underneath it rather than beside it. */
  .zoom-body .hh {
    position: sticky; top: 0; z-index: 1;
    background-color: hsl(var(--paper-sunk));
    background-image: linear-gradient(hsl(var(--ink) / 0.04), hsl(var(--ink) / 0.04));
    border-bottom: 1px solid hsl(var(--line));
  }
  /* Once the file is around them the numbers run unbroken down the panel, so the
     range header says nothing the gutter has not already said, and every hunk
     wearing one turns a file into a stack of cards again. It stays in the column,
     where the numbers do jump. */
  .filefull .hh { display: none; }
  .filefull .snip { padding-top: 0; padding-bottom: 0; }
  .filefull { padding: 6px 0 16px; }
  /* the hunk the reader pressed to get here, marked at the far edge of the gutter:
     the page's own ink rather than a change hue, because the washes already say
     which way a line went and this says the other thing, that you are here. */
  .filefull .hunk.focus .gut, .filefull .l.focus .gut {
    box-shadow: inset 2px 0 0 hsl(var(--accent));
  }
  /* a quoted ref keeps the wash its own lines wear on the page, so the lines the
     statement singled out are the same lines here */
  .filefull .l.hl { background: hsl(var(--ink) / 0.055); }
  .filefull .l.hl .gut { background-image: linear-gradient(hsl(var(--ink) / 0.055), hsl(var(--ink) / 0.055)); }
  /* the file between two stretches that are loaded, and how much of it is left.
     It reads as the rail a hunk header used to be, because it is the same kind of
     thing: a line about the code rather than a line of it. */
  .gapfill {
    display: block; width: 100%;
    margin: 0; padding: 6px 0;
    border: 0;
    border-top: 1px solid hsl(var(--line));
    border-bottom: 1px solid hsl(var(--line));
    background: hsl(var(--ink) / 0.04);
    font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
    color: hsl(var(--muted));
    text-align: left; cursor: pointer;
  }
  /* pinned to the panel's left edge like the gutter it lines up with, so scrolling
     a long line sideways never leaves the count behind */
  .gapfill .gfi { position: sticky; left: 0; display: inline-block; padding-left: 8px; }
  .gapfill .gfg { display: inline-block; width: 3.4em; letter-spacing: 0.14em; }
  .gapfill .gfn { text-underline-offset: 3px; }
  .gapfill[data-failed] { cursor: default; }
  @media (hover: hover) and (pointer: fine) {
    .gapfill:not([data-failed]):hover { color: hsl(var(--ink)); }
    .gapfill:not([data-failed]):hover .gfn { text-decoration: underline; }
  }
  /* lines on their way in: their numbers are known, their code is not */
  .filefull .l.sk .skb {
    display: inline-block; height: 0.7em; border-radius: 2px;
    background: hsl(var(--ink) / 0.09); vertical-align: middle;
  }
  @media (prefers-reduced-motion: no-preference) {
    .filefull .l.sk .skb { animation: skpulse 1.15s ease-in-out infinite; }
  }
  @keyframes skpulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
  /* the one sentence the panel says when the file will not come. It sits above the
     hunks, which are still exactly what they were. */
  .nocontext {
    padding: 9px 14px 9px 12px;
    border-bottom: 1px solid hsl(var(--line));
    background: hsl(var(--ink) / 0.04);
    font-family: var(--font-body); font-size: 12.5px; line-height: 1.45;
    color: hsl(var(--muted));
  }
  @media (min-width: 700px) {
    .zoomdlg {
      width: min(94vw, 980px);
      height: min(86dvh, 840px);
      max-width: min(94vw, 1680px);
      max-height: 90dvh;
      margin: auto;
      border: 1px solid hsl(var(--line));
      border-radius: 10px;
      box-shadow: 0 24px 64px hsl(var(--ink) / 0.28);
      resize: both;
    }
  }
`;

/** Resolved before first paint so the surface never flashes, and stored so an explicit
 *  choice survives a reload. Without it the CSS floor still lands on the right surface. */
const THEME_SCRIPT =
  `(()=>{let t=null;try{t=localStorage.getItem("overseer:theme")}catch(e){}` +
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

  const snips = Array.from(document.querySelectorAll(".snip.scroll-x"));
  const measureOne = (el) => {
    const over = el.scrollWidth - el.clientWidth;
    const unit = el.closest("details.fold, .filediff");
    if (unit) unit.classList.toggle("clipped", over > 1);
    if (over > 1 && el.scrollLeft < over - 1) el.dataset.clip = "right";
    else delete el.dataset.clip;
  };
  const measure = () => snips.forEach(measureOne);
  // A scroll asks about the block being scrolled and nothing else. Sweeping the page
  // was affordable while phones could not scroll code sideways at all; now that they
  // can, it is a forced layout for every hunk on the page on every frame of the one
  // gesture this change exists to make good.
  snips.forEach((el) =>
    el.addEventListener("scroll", () => measureOne(el), { passive: true }),
  );
  document.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", measure));
  addEventListener("resize", measure, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
})();
`;

/** The panel, worked. Like every other script on this page it is an enhancement: the
 *  controls ship `hidden` and only this removes them, so a page with no scripting never
 *  shows a button that would do nothing, and the code is still on it either way.
 *
 *  Opening pushes a history entry, so the phone's back gesture — the way a reader
 *  actually closes a full-screen thing — closes the panel and lands back on the review
 *  rather than on whatever preceded it. Closing any other way pops that entry itself, so
 *  the panel never leaves a step in the history a reader has to walk back through. */
function zoomScript(basePath: string, version: number, context: boolean): string {
  return `
(() => {
  const buttons = Array.from(document.querySelectorAll("button.zoom"));
  if (buttons.length === 0) return;
  if (typeof HTMLDialogElement !== "function" || !HTMLDialogElement.prototype.showModal) return;

  // Where the file around a hunk is asked for, and whether it may be asked for at all.
  // A shared page passes false: what the link handed out is the review and the hunks
  // the walkthrough drew, and the whole of every file they touch is a larger thing
  // than the person who minted the link agreed to.
  const CONTEXT = ${context ? "true" : "false"};
  const BASE = ${JSON.stringify(basePath)};
  const VERSION = ${JSON.stringify(version)};
  const PAD = 20;    // lines each side of a hunk when the panel opens
  const CHUNK = 40;  // lines per scroll-driven step
  const FILL = 40;   // a gap shorter than this is closed rather than offered

  const SIZE_KEY = "overseer:code-panel";
  const wide = matchMedia("(min-width: 700px)");
  let dlg = null;
  // A history entry this panel pushed and has not given back. It is cleared at the
  // moment the entry stops existing rather than around the close: \`close()\` only
  // queues the close event, so a flag set and cleared around the call is already
  // false by the time the handler reads it, and the panel would walk back a second
  // entry the reader never gave it. That is the whole page, gone under a back gesture.
  let owes = false;
  // A traversal this panel asked for and has not yet been told about. \`history.back()\`
  // lands asynchronously too, so the popstate it produces has to be recognised as ours
  // rather than read as the reader's back gesture.
  let consuming = false;
  let dragging = false; // a drag on the panel's own resize corner is under way

  const build = () => {
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.className = "zoomdlg";
    dlg.innerHTML =
      '<div class="zoom-bar"><span class="zoom-title"></span>' +
      '<button type="button" class="zoom-x" aria-label="Close full screen">' +
      '<svg class="mark" aria-hidden="true"><use href="#i-close"/></svg></button></div>' +
      // The code takes the focus, not the cross. A modal focuses its first focusable
      // child, and a reader who just asked to read something should not have to tab
      // past the way out of it: arrow keys scroll the code straight away, and the
      // cross still takes a ring when it is tabbed to.
      '<div class="zoom-body" tabindex="-1" autofocus><div class="zoom-inner"></div></div>';
    document.body.appendChild(dlg);
    dlg.querySelector(".zoom-x").addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => {
      document.documentElement.classList.remove("code-open");
      dlg.querySelector(".zoom-inner").textContent = "";
      // Whatever the file view was still waiting for, it is waiting for a panel that
      // is not there. The token it was started under is dropped with it, so an answer
      // still in the air lands on nothing.
      stop();
      if (!owes) return;
      owes = false;
      consuming = true;
      history.back();
    });
    // A gap is a control as well as a measure: scrolling into it takes the next stretch,
    // and pressing it takes the rest, which is what a keyboard and a reader in a hurry
    // both reach for.
    dlg.addEventListener("click", (e) => {
      if (!view || !e.target || !e.target.closest) return;
      const gap = e.target.closest(".gapfill");
      if (!gap || gap.hasAttribute("data-failed")) return;
      grow(Number(attr(gap, "data-from")), Number(attr(gap, "data-to")), true);
    });
    // Which way the reader is going, so a gap grows from the side they are coming from.
    dlg.querySelector(".zoom-body").addEventListener("scroll", (e) => {
      if (!view) return;
      const at = e.target.scrollTop;
      if (Math.abs(at - view.lastTop) > 2) view.down = at > view.lastTop;
      view.lastTop = at;
    }, { passive: true });
    // A size is remembered only when the reader made it: a drag that starts in the
    // resize corner and ends somewhere else. Watching the box instead cannot tell a
    // drag from the window moving under it, and guessing wrong pins every later panel
    // to the size of one window that happened to be resized once.
    dlg.addEventListener("pointerdown", (e) => {
      if (!wide.matches) return;
      const box = dlg.getBoundingClientRect();
      dragging = box.right - e.clientX < 22 && box.bottom - e.clientY < 22;
    });
    addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      const box = dlg.getBoundingClientRect();
      const w = Math.round(box.width), h = Math.round(box.height);
      if (w < 480 || h < 320) return;
      try { localStorage.setItem(SIZE_KEY, w + "x" + h); } catch (e) {}
    });
    return dlg;
  };

  // ---- the file the hunks were cut from ----
  //
  // The panel opens on the hunks the page already carries, which is what it has always
  // shown and what it goes on showing if nothing else ever arrives. Then it asks for
  // the file at the commit those hunks count against and lays them back into it. The
  // swap keeps the reader's place by scrolling to the same hunk afterwards, so the code
  // under their eye does not move: the file appears around it.
  //
  // Every number here is the hunk's own, read off the attributes the renderer wrote:
  // where in the new file it starts and how many lines of it it occupies. Nothing is
  // re-derived, so a line that lands in the wrong place in the panel is a line that is
  // wrong in the document.
  let view = null;
  let token = 0;

  const clean = (node) => {
    // The clone is a second copy of markup the page already addresses by id, and two
    // elements answering to one id is a page whose citations stop landing.
    node.removeAttribute("id");
    node.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    node.querySelectorAll("button.zoom, .cue").forEach((el) => el.remove());
    // Nothing is clipped in here: it is the panel's whole job not to be.
    node.removeAttribute("data-clip");
    node.querySelectorAll("[data-clip]").forEach((el) => el.removeAttribute("data-clip"));
    return node;
  };

  const attr = (el, name) => el.getAttribute(name);
  const int = (el, name) => {
    const n = Number(attr(el, name));
    return Number.isInteger(n) ? n : null;
  };

  /**
   * The one file this code surface is a view of, or null when it is not one file.
   *
   * Two shapes reach here. A file diff is a run of hunks, and the panel lays the file
   * out around elements the page already drew. A quoted ref is a range of the file and
   * nothing else, so the panel draws the whole thing from the route and marks the lines
   * the ref singled out. Everything after this point treats them the same: a payload or
   * an example is neither, and keeps the panel it has always had.
   */
  const fileOf = (box) => {
    if (!CONTEXT) return null;
    if (!box.classList.contains("filediff")) return refOf(box);
    const own = Array.from(box.querySelectorAll(".hunk[data-path][data-sha]"));
    if (own.length === 0) return null;
    const path = attr(own[0], "data-path");
    const sha = attr(own[0], "data-sha");
    // A file view is a view of one file at one commit. Two shas under one row is a
    // stack's seam, and there is no single file to lay both sides out in, so that row
    // keeps the panel it has always had.
    for (const h of own) {
      if (attr(h, "data-path") !== path || attr(h, "data-sha") !== sha) return null;
    }
    const mine = new Set(own.map((h) => attr(h, "data-hunk")));
    const hunks = [];
    // Every hunk of this file on the page, not only this row's. A file whose hunks two
    // groups claim is still one file, and a view of it with holes where the other
    // group's changes went would be a claim about the file rather than a shorter view
    // of it.
    document.querySelectorAll(".hunk[data-path][data-sha]").forEach((el) => {
      // The panel is in the document too, and by now it is holding a copy of this very
      // row. A copy is not a second hunk of the file, and counting it as one draws
      // every hunk twice.
      if (dlg && dlg.contains(el)) return;
      if (attr(el, "data-path") !== path || attr(el, "data-sha") !== sha) return;
      const from = int(el, "data-new-from"), to = int(el, "data-new-to");
      if (from === null || to === null || from < 1 || to < from - 1) return;
      hunks.push({ el: el, from: from, to: to, focus: mine.has(attr(el, "data-hunk")) });
    });
    if (hunks.length === 0) return null;
    hunks.sort((a, b) => a.from - b.from || a.to - b.to);
    return { path: path, sha: sha, hunks: hunks, mark: null, hl: [] };
  };

  /** A quoted range of a file: its path, its commit, the lines it quotes and the ones
   *  it singles out inside them. */
  const refOf = (box) => {
    const pre = box.querySelector("pre.snip[data-path][data-sha][data-ref-from]");
    if (!pre) return null;
    const from = int(pre, "data-ref-from"), to = int(pre, "data-ref-to");
    if (from === null || to === null || from < 1 || to < from) return null;
    const hl = (attr(pre, "data-ref-hl") || "")
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= from && n <= to);
    return {
      path: attr(pre, "data-path"),
      sha: attr(pre, "data-sha"),
      hunks: [],
      mark: { from: from, to: to },
      hl: hl,
    };
  };

  const merged = (list) => {
    const sorted = list.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out;
  };

  /** What the panel lays out, once the holes too small to be worth a control are not
   *  offered as one: a five-line gap with a count in it is worse than the five lines. */
  const settle = () => {
    let list = merged(view.shown);
    if (view.total !== null) {
      list = list
        .map((s) => [Math.min(s[0], view.total), Math.min(s[1], view.total)])
        .filter((s) => s[0] <= s[1]);
    }
    const out = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (last && s[0] - last[1] - 1 <= FILL) last[1] = Math.max(last[1], s[1]);
      else out.push([s[0], s[1]]);
    }
    if (out.length > 0 && out[0][0] - 1 <= FILL) out[0][0] = 1;
    const end = out[out.length - 1];
    if (end && view.total !== null && view.total - end[1] <= FILL) end[1] = view.total;
    // Last, and after the small holes have been closed: a stretch that failed to load
    // is cut back out. Closing over it would put the skeleton rows back and the next
    // pass would ask for it again, which is a loop rather than a retry.
    let shown = out;
    for (const f of view.failed) shown = without(shown, f.from, f.to);
    view.shown = shown;
  };

  /** A list of spans with one range taken out of it. */
  const without = (list, a, b) => {
    const out = [];
    for (const s of list) {
      if (b < s[0] || a > s[1]) { out.push(s); continue; }
      if (s[0] < a) out.push([s[0], a - 1]);
      if (s[1] > b) out.push([b + 1, s[1]]);
    }
    return out;
  };

  /** Why the file between these two lines is not here, when it was asked for and did
   *  not come. Any overlap counts: the gap a failed range reappears inside is rarely
   *  the range itself, because the reader asked for forty lines of a gap of two hundred. */
  const failedIn = (from, to) => {
    for (const f of view.failed) {
      if (f.from <= to && f.to >= from) return f.why;
    }
    return "";
  };

  const inHunk = (n) => {
    for (const h of view.hunks) {
      if (n >= h.from && n <= h.to) return true;
    }
    return false;
  };

  /** Ask for every line the panel is showing that it does not have. A hunk's own lines
   *  are already on the page, so they are never fetched: what is asked for is the file
   *  between and around them. */
  const fill = () => {
    for (const s of view.shown) {
      let n = s[0];
      while (n <= s[1]) {
        if (view.lines.has(n) || view.asking.has(n) || inHunk(n)) { n++; continue; }
        const a = n;
        while (n <= s[1] && !view.lines.has(n) && !view.asking.has(n) && !inHunk(n)) n++;
        ask(a, n - 1);
      }
    }
  };

  const ask = (a, b) => {
    // The route bounds one request, so a long stretch is taken in pieces. One piece
    // now, and the rest on the way back: every answer runs the fill pass again, which
    // finds what is still missing and asks for the next.
    //
    // Firing them all at once was the obvious shape and the wrong one. Pressing a gap
    // in a long file asks for thousands of lines, which is a dozen requests leaving
    // together, and they are a dozen requests for the SAME file: none of them has
    // returned yet, so none of them has filled the cache the others would have hit,
    // and the route fetches one file from GitHub a dozen times over. One at a time
    // costs a round trip per piece and fills the file down the page as it goes, which
    // is also the better thing to watch.
    if (b - a + 1 > 300) {
      ask(a, a + 299);
      return;
    }
    for (let n = a; n <= b; n++) view.asking.add(n);
    const mine = view.token;
    const forget = () => {
      for (let n = a; n <= b; n++) view.asking.delete(n);
    };
    const url =
      BASE + "/c?path=" + encodeURIComponent(view.path) +
      "&sha=" + encodeURIComponent(view.sha) +
      "&from=" + a + "&to=" + b + "&v=" + encodeURIComponent(String(VERSION));
    fetch(url, { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!view || view.token !== mine) return;
        forget();
        if (!body || !body.lines) { refuse(a, b, body && body.why); return; }
        for (let i = 0; i < body.lines.length; i++) view.lines.set(body.from + i, body.lines[i]);
        if (typeof body.total === "number") view.total = body.total;
        landed();
      })
      .catch(() => {
        if (!view || view.token !== mine) return;
        forget();
        refuse(a, b, null);
      });
  };

  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const gapHtml = (from, to) => {
    const why = failedIn(from, to);
    const n = to - from + 1;
    const said = why ? esc(why) : n + " lines";
    return (
      '<button type="button" class="gapfill" data-from="' + from + '" data-to="' + to + '"' +
      (why ? ' data-failed aria-disabled="true"' : "") +
      ' aria-label="' + (why ? esc(why) : "Show the " + n + " lines hidden here") + '">' +
      '<span class="gfi">' +
      (why ? "" : '<span class="gfg">\\u00b7\\u00b7\\u00b7</span>') +
      '<span class="gfn">' + said + "</span></span></button>"
    );
  };

  /** A line the panel is laying out but does not have yet. Its number is already known,
   *  so the file grows into the space it will occupy rather than jumping when it lands. */
  const skeleton = (n) => {
    const w = 12 + ((n * 37) % 48);
    return (
      '<span class="l sk"><span class="gut"><span class="n">' + n +
      '</span><span class="g"> </span></span>' +
      '<span class="skb" style="width:' + w + 'ch"></span></span>'
    );
  };

  const hunkNode = (h) => {
    const node = clean(h.el.cloneNode(true));
    if (h.focus) node.classList.add("focus");
    return node;
  };

  const emit = (parts, done, from, to) => {
    let run = "";
    let n = from;
    const flush = () => {
      if (run === "") return;
      parts.push('<pre class="snip scroll-x"><code>' + run + "</code></pre>");
      run = "";
    };
    while (n <= to) {
      const here = view.at.get(n);
      if (here) {
        let jumped = false;
        for (const h of here) {
          if (done.has(h)) continue;
          flush();
          done.add(h);
          parts.push(hunkNode(h));
          // A hunk that only deletes draws no line of the new file, so the walk stays
          // where it is and the line it was about to draw follows the deletion.
          if (h.to >= h.from) { n = h.to + 1; jumped = true; }
        }
        if (jumped) continue;
      }
      const got = view.lines.get(n);
      run += got === undefined ? skeleton(n) : got;
      n++;
    }
    flush();
  };

  /** The key an element is found again by after a repaint. A context line is keyed by
   *  the number in its own gutter, which is the new-side number by construction: only a
   *  deletion carries an old one, and deletions live inside hunks. */
  const keyOf = (el) => {
    if (el.classList.contains("hunk")) return "h" + attr(el, "data-new-from");
    if (el.classList.contains("gapfill")) return "g" + attr(el, "data-from");
    const n = el.querySelector(".n");
    return n ? "n" + n.textContent.trim() : null;
  };
  const ROWS = ".filefull .hunk, .filefull .gapfill, .filefull > pre.snip > code > .l";

  const anchorOf = (body, inner) => {
    const top = body.getBoundingClientRect().top;
    const list = inner.querySelectorAll(ROWS);
    for (const el of list) {
      const box = el.getBoundingClientRect();
      if (box.bottom <= top + 1) continue;
      const key = keyOf(el);
      if (key) return { key: key, off: box.top - top };
    }
    return null;
  };

  const restore = (body, inner, a) => {
    if (!a) return;
    const list = inner.querySelectorAll(ROWS);
    for (const el of list) {
      if (keyOf(el) !== a.key) continue;
      const top = body.getBoundingClientRect().top;
      body.scrollTop += el.getBoundingClientRect().top - top - a.off;
      return;
    }
  };

  const paint = (keep) => {
    const body = dlg.querySelector(".zoom-body");
    const inner = dlg.querySelector(".zoom-inner");
    const a = keep ? anchorOf(body, inner) : null;
    // A gap pressed from the keyboard is a gap that is about to stop existing, and the
    // element holding the focus going away hands it back to the document. Inside a
    // modal that means the next tab starts from the top of it.
    const held = inner.contains(document.activeElement);

    const parts = [];
    const done = new Set();
    let at = 1;
    for (const s of view.shown) {
      if (s[0] > at) parts.push(gapHtml(at, s[0] - 1));
      emit(parts, done, s[0], s[1]);
      at = Math.max(at, s[1] + 1);
    }
    // The end of the file is not known until the first answer comes back, and a gap
    // whose size is unknown is not one the panel can honestly draw.
    if (view.total !== null && at <= view.total) parts.push(gapHtml(at, view.total));
    // A hunk the walk never reached is still the reader's. Nothing should reach this,
    // since every hunk's own lines are in the shown spans from the start, but a walkthrough that
    // quietly loses a hunk is a partition nobody can check, so it lands at the end
    // rather than nowhere.
    for (const h of view.hunks) if (!done.has(h)) parts.push(hunkNode(h));

    const wrap = document.createElement("div");
    wrap.className = "filediff filefull";
    let buffer = "";
    const drain = () => {
      if (buffer === "") return;
      const holder = document.createElement("div");
      holder.innerHTML = buffer;
      while (holder.firstChild) wrap.appendChild(holder.firstChild);
      buffer = "";
    };
    for (const p of parts) {
      if (typeof p === "string") buffer += p;
      else { drain(); wrap.appendChild(p); }
    }
    drain();

    // What the reader came for, when it is a range rather than an element: the quoted
    // lines take the same "you are here" mark a pressed hunk takes, and the lines the
    // ref singled out keep the wash they wear on the page.
    if (view.mark) {
      for (const el of wrap.querySelectorAll("pre.snip > code > .l")) {
        const n = Number(el.querySelector(".n").textContent);
        if (n >= view.mark.from && n <= view.mark.to) el.classList.add("focus");
        if (view.hl.indexOf(n) !== -1) el.classList.add("hl");
      }
    }

    inner.textContent = "";
    inner.appendChild(wrap);
    if (held) body.focus();
    restore(body, inner, a);
    watch();
  };

  const toFocus = () => {
    const body = dlg.querySelector(".zoom-body");
    const el = dlg.querySelector(".filefull .focus");
    if (!el) return;
    body.scrollTop +=
      el.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
  };

  const landed = () => {
    view.busy = false;
    settle();
    fill();
    if (view.painted) { paint(true); return; }
    view.painted = true;
    paint(false);
    toFocus();
  };

  const refuse = (a, b, why) => {
    view.busy = false;
    const said = why || "The code around this change could not be loaded.";
    if (!view.painted) {
      // Nothing was ever swapped in, so the panel is still the hunks it opened on: the
      // reader loses the surrounding file and keeps everything they had before it was
      // offered. One line above them says which nothing this is.
      const inner = dlg.querySelector(".zoom-inner");
      if (!inner.querySelector(".nocontext")) {
        const p = document.createElement("p");
        p.className = "nocontext";
        p.textContent = said;
        inner.insertBefore(p, inner.firstChild);
      }
      stop();
      return;
    }
    // The file was already on screen, so the reader keeps it and loses only what did
    // not come. That is more than the one range: pressing a gap lays out the whole of
    // it and takes it a piece at a time, so a piece that fails leaves the rest of it
    // standing as skeleton rows nothing is on its way to fill. The panel goes back to
    // what it is actually holding, and everything it was showing on the strength of
    // this request goes back to being a gap, which now says why instead of how many
    // and stops offering itself: the same scroll that asked would otherwise ask again,
    // and again, for as long as the reader sat there.
    view.failed.push({ from: a, to: b, why: said });
    view.shown = merged(held());
    settle();
    paint(true);
    // A hole small enough that settle closed it again is one worth asking for, and it
    // is not the range that just failed, because settle cuts those back out.
    fill();
  };

  /** What the panel is actually holding: the lines it has, the hunks it draws itself,
   *  and the pieces still on their way. Everything else it was showing was a promise. */
  const held = () => {
    const runs = [];
    const real = (n) => view.lines.has(n) || view.asking.has(n) || inHunk(n);
    for (const s of view.shown) {
      let n = s[0];
      while (n <= s[1]) {
        if (!real(n)) { n++; continue; }
        const a = n;
        while (n <= s[1] && real(n)) n++;
        runs.push([a, n - 1]);
      }
    }
    return runs;
  };

  const grow = (from, to, all) => {
    if (!view || !view.painted || view.busy) return;
    const size = all ? to - from + 1 : CHUNK;
    let a, b;
    // From the side the reader is coming from, so the lines land between them and the
    // gap and the gap moves away rather than staying under their eye.
    if (view.down) { a = from; b = Math.min(to, from + size - 1); }
    else { b = to; a = Math.max(from, to - size + 1); }
    if (to - from + 1 - (b - a + 1) <= FILL) { a = from; b = to; }
    view.shown = merged(view.shown.concat([[a, b]]));
    settle();
    paint(true);
    fill();
    // Only busy if something is actually on its way. A step that turned out to need no
    // fetch would otherwise hold the gate shut and the gaps would stop growing.
    view.busy = view.asking.size > 0;
  };

  const watch = () => {
    if (view.io) view.io.disconnect();
    view.io = null;
    if (typeof IntersectionObserver !== "function") return;
    const body = dlg.querySelector(".zoom-body");
    const io = new IntersectionObserver((entries) => {
      if (!view || view.io !== io) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target.hasAttribute("data-failed")) continue;
        grow(Number(attr(e.target, "data-from")), Number(attr(e.target, "data-to")), false);
        return;
      }
    }, { root: body, rootMargin: "60px 0px" });
    view.io = io;
    dlg.querySelectorAll(".gapfill").forEach((g) => io.observe(g));
  };

  const stop = () => {
    if (view && view.io) view.io.disconnect();
    view = null;
  };

  const start = (file) => {
    stop();
    const at = new Map();
    for (const h of file.hunks) {
      // Where the hunk is drawn: before the first line of the new file it draws. A
      // hunk that only deletes draws none, and its span is already positioned so that
      // the same number puts it between the line before it and the line after.
      const key = h.from;
      const list = at.get(key);
      if (list) list.push(h);
      else at.set(key, [h]);
    }
    token = token + 1;
    view = {
      token: token,
      path: file.path,
      sha: file.sha,
      hunks: file.hunks,
      mark: file.mark,
      hl: file.hl,
      at: at,
      lines: new Map(),
      asking: new Set(),
      failed: [],
      shown: [],
      total: null,
      painted: false,
      busy: false,
      down: true,
      lastTop: 0,
      io: null,
    };
    const anchors = file.mark
      ? [[file.mark.from, file.mark.to]]
      : file.hunks.map((h) => [h.from, Math.max(h.to, h.from)]);
    view.shown = merged(anchors.map((r) => [Math.max(1, r[0] - PAD), r[1] + PAD]));
    settle();
    fill();
  };

  const open = (btn) => {
    const box = btn.closest(".filediff, .fold, .snipbox");
    if (!box) return;
    const source = box.classList.contains("filediff") ? box : box.querySelector("pre.snip");
    if (!source) return;
    const d = build();
    stop();
    const clone = clean(source.cloneNode(true));
    const inner = d.querySelector(".zoom-inner");
    inner.textContent = "";
    inner.appendChild(clone);
    const title = btn.dataset.zoom || "";
    d.querySelector(".zoom-title").textContent = title;
    d.setAttribute("aria-label", title === "" ? "Code, full screen" : title);
    d.style.width = "";
    d.style.height = "";
    if (wide.matches) {
      try {
        const saved = (localStorage.getItem(SIZE_KEY) || "").split("x");
        const w = Number(saved[0]), h = Number(saved[1]);
        if (w > 480 && h > 320) { d.style.width = w + "px"; d.style.height = h + "px"; }
      } catch (e) {}
    }
    document.documentElement.classList.add("code-open");
    d.showModal();
    const body = d.querySelector(".zoom-body");
    body.scrollTop = 0;
    body.scrollLeft = 0;
    // One entry per panel, however fast they are opened: a panel that opens while the
    // last one's traversal is still in the air inherits the entry rather than stacking
    // a second one the reader would have to press back through twice.
    if (!owes) {
      try { history.pushState({ overseerCode: 1 }, ""); owes = true; } catch (e) { owes = false; }
    }
    // Last, and only once the panel is up: what is on screen already stands on its own,
    // and the file around it arrives when it arrives.
    const file = typeof fetch === "function" ? fileOf(box) : null;
    if (file) start(file);
  };

  addEventListener("popstate", () => {
    // Ours, arriving late. The entry is already gone, so there is nothing to close and
    // nothing left to give back.
    if (consuming) { consuming = false; return; }
    if (!dlg || !dlg.open) return;
    owes = false;
    dlg.close();
  });

  buttons.forEach((b) => {
    b.removeAttribute("hidden");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      open(b);
    });
  });
})();
`;
}

/** The delta's own ink. Every field starts as clean current prose. Standalone fields
 *  and expanded entities each have an explicit edited checkbox; opening a row alone
 *  cannot reveal additions or deletions. */
const DELTA_STYLE = `
  .dtog { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .dw { border-radius: 3px; background: var(--word-add); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .dw ins, ins.dw { text-decoration: none; }
  .dedited {
    display: flex; align-items: center; gap: 5px; width: max-content; min-height: 40px;
    color: hsl(var(--change)); cursor: pointer; font: italic 400 12.5px/1.35 var(--font-body);
  }
  .dedited span { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .dedited:active span { text-decoration-thickness: 2px; }
  .dediticon { width: 12px; height: 12px; color: currentColor; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dtog:checked + .dedited .dediticon { color: hsl(var(--change)); }
  @media (hover: hover) and (pointer: fine) { .dedited:hover span { text-decoration-thickness: 2px; } }
  .dinline { display: none; }
  .dchange:has(> .dtog:checked) > .dcurrent { display: none; }
  .dchange:has(> .dtog:checked) > .dinline { display: block; }
  .dchange-inline .dedited { display: inline-flex; min-height: 0; margin-left: 7px; font-size: 0.6em; vertical-align: middle; }
  .dchange-inline:has(> .dtog:checked) > .dinline { display: inline; }
  details:has(> .etog:checked) .dborrow > .dcurrent { display: none; }
  details:has(> .etog:checked) .dborrow > .dinline { display: block; }
  details:has(> .etog:checked) .dborrow.dchange-inline > .dinline { display: inline; }
  .dold { color: hsl(var(--remove) / 0.95); background: var(--word-rem); border-radius: 3px; text-decoration: line-through; text-decoration-thickness: 1px; }
  .dp { display: none; color: hsl(var(--ink-soft)); background: none; text-decoration: none; }
  .dp.dpb { margin-top: 6px; padding: 6px 8px; }
  .dgoneunit { opacity: 0.78; }
  .dgoneunit .dgone-body { padding: 4px 0 8px; }
  /* Group and card bodies already own the horizontal column under their titles.
     Keep it when the entity is removed; zeroing all four sides put the group's
     icon rail through its former prose. */
  .dgoneunit .grp-body, .dgoneunit .card-body { padding-top: 4px; padding-bottom: 8px; }
  .dgoneunit > summary .dp { display: inline; color: hsl(var(--muted)); }
  .dgoneunit:not([open]) > summary .ic { color: hsl(var(--muted)); }
  .dgoneunit .dgone-body .dp, .dgoneunit .grp-body .dp, .dgoneunit .card-body .dp { display: block; }
  .rev { display: inline; margin-right: 7px; font: italic 400 11.5px/1.35 var(--font-body); letter-spacing: 0.01em; vertical-align: baseline; }
  .rev-new { color: hsl(var(--add)); }
  .rev-edited, .rev-moved { color: hsl(var(--change)); }
  .rev-removed { color: hsl(var(--remove)); }
  .dbase { color: hsl(var(--muted)); }
  .revs { margin: 10px 0 2px; }
  .revs > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font-size: 12.5px; color: hsl(var(--muted)); }
  .revs > summary::-webkit-details-marker { display: none; }
  .revs[open] > summary .tick { transform: rotate(90deg); }
  .revlist { margin: 8px 0 0; padding: 0; list-style: none; border-top: 1px solid hsl(var(--line)); }
  /* One line per revision: the version and its date at the start, the from link at
     the end, and the counts taking whatever is left. Only the counts wrap, inside
     themselves, so nothing else is pushed onto a ragged second line. */
  .rv { display: flex; align-items: baseline; gap: 4px 10px; padding: 5px 0; border-bottom: 1px solid hsl(var(--line)); font-size: 12.5px; color: hsl(var(--muted)); }
  .rv-n { flex: none; font-family: var(--font-mono); color: hsl(var(--ink-soft)); }
  .rv-on { flex: none; white-space: nowrap; }
  .rv-counts { flex: 1 1 auto; min-width: 0; }
  .rv.is-here .rv-n { font-weight: 500; color: hsl(var(--ink)); }
  .rv.is-base { background: hsl(var(--paper-sunk)); }
  .rv-from { flex: none; margin-left: auto; white-space: nowrap; }
`;

// The prototype's Q/A grammar. A question is one line marked Q, its answer one line
// marked A, and the refs an answer cites hang under it as the same folds every other
// citation on the page uses. The state and the version it was filed against sit in a
// mono line beneath, because both are machine facts about the question rather than
// part of what was asked.
const QUESTION_STYLE = `
  .qmeta { font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); margin: 10px 0 0; letter-spacing: 0.01em; display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .qmeta .is-open { color: hsl(var(--change)); }
  @media (hover: hover) and (pointer: fine) {
  }
`;

/* The share panel. It sits under the masthead rather than floating, because it is a
   thing you do to the review rather than a menu over it, and because a phone has
   nowhere to float it to. Drawn only for a member reading the review's own url: a
   shared page carries none of this markup and none of its script. */
const SHARE_STYLE = `
  .sharebox {
    margin: -6px 0 18px; padding: 12px 14px 14px;
    border: 1px solid hsl(var(--line)); border-radius: 8px;
    background: hsl(var(--paper-sunk));
  }
  .sharebox[hidden] { display: none; }
  .sharebox .share-title {
    font-family: var(--font-body); font-size: 13.5px; font-weight: 500;
    color: hsl(var(--ink-soft)); margin: 0 0 8px;
  }
  .sharebox p { margin: 0; font-size: 13.5px; color: hsl(var(--muted)); }
  .share-list { list-style: none; margin: 0 0 10px; padding: 0; }
  .share-list li {
    display: flex; align-items: baseline; gap: 8px;
    padding: 6px 0; border-top: 1px solid hsl(var(--line));
    font-size: 13.5px;
  }
  .share-list li:first-child { border-top: 0; }
  .share-when { font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted)); }
  .share-label { color: hsl(var(--ink)); }
  .share-dead { color: hsl(var(--remove)); }
  .share-list button { margin-left: auto; }
  .sharebox button {
    font: inherit; font-size: 13px;
    background: none; border: 1px solid hsl(var(--line)); border-radius: 6px;
    padding: 5px 10px; min-height: 32px;
    color: hsl(var(--accent)); cursor: pointer;
  }
  .sharebox button:active { background: hsl(var(--ink) / 0.07); }
  /* The minted link, shown once. The row is the token, so it gets the mono face and
     room to be selected by hand when the copy button is not available. */
  .share-fresh { margin-top: 10px; }
  .share-fresh[hidden] { display: none; }
  .share-url {
    display: flex; gap: 8px; align-items: stretch;
  }
  .share-url input {
    flex: 1 1 auto; min-width: 0;
    font-family: var(--font-mono); font-size: 12px;
    padding: 6px 8px; border: 1px solid hsl(var(--line)); border-radius: 6px;
    background: hsl(var(--paper)); color: hsl(var(--ink));
  }
  .share-once { margin-top: 6px !important; font-size: 12.5px !important; }
  .share-toggle {
    background: none; border: 0; margin: 0; padding: 10px;
    min-width: 44px; min-height: 44px;
    color: hsl(var(--accent)); cursor: pointer; line-height: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; flex: none;
  }
  .share-toggle .mark { display: block; width: 17px; height: 17px; stroke-width: 1.5; }
  .share-toggle:active { background: hsl(var(--ink) / 0.07); }
  @media (max-width: 479.98px) { .share-toggle { order: 2; } }
`;

/** The panel's behaviour. Minting is the only thing here that cannot be undone by
 *  reloading, and it is the only thing that shows a token: the store keeps a hash, so
 *  a link this panel does not show now can never be shown again. That is why the list
 *  and the fresh link are separate rows and why the list never pretends to hold one. */
function shareScript(wsId: string, slug: string): string {
  const ws = JSON.stringify(wsId);
  const target = JSON.stringify(slug);
  return `
(() => {
  const box = document.querySelector('[data-sharebox]');
  const open = document.querySelector('[data-share-open]');
  if (!box || !open) return;
  const list = box.querySelector('[data-share-list]');
  const empty = box.querySelector('[data-share-empty]');
  const fresh = box.querySelector('[data-share-fresh]');
  const field = box.querySelector('[data-share-url]');
  const ws = ${ws}, target = ${target};

  const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  async function load() {
    list.textContent = '';
    let shares = [];
    try {
      const res = await fetch('/api/shares?workspace=' + encodeURIComponent(ws), { headers: { accept: 'application/json' } });
      if (res.ok) shares = (await res.json()).shares.filter((s) => s.kind === 'review' && s.target === target);
    } catch (e) { /* an offline panel shows no links rather than a wrong count */ }
    empty.hidden = shares.length > 0;
    for (const s of shares) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'share-label';
      label.textContent = s.label || 'unlabelled link';
      const made = document.createElement('span');
      made.className = 'share-when';
      // An expired link is still listed, because it is still revocable and still a
      // thing that was handed out; it is said to be dead rather than drawn as live.
      const dead = s.expiresAt !== null && new Date(s.expiresAt).getTime() <= Date.now();
      made.textContent = when(s.createdAt)
        + (s.expiresAt ? (dead ? ' · expired ' : ' · until ') + when(s.expiresAt) : '');
      if (dead) made.classList.add('share-dead');
      const kill = document.createElement('button');
      kill.type = 'button';
      kill.textContent = 'revoke';
      kill.addEventListener('click', async () => {
        kill.disabled = true;
        await fetch('/api/shares/' + encodeURIComponent(s.id), { method: 'DELETE' });
        await load();
      });
      li.append(label, made, kill);
      list.append(li);
    }
  }

  open.addEventListener('click', () => {
    const showing = !box.hidden;
    box.hidden = showing;
    open.setAttribute('aria-expanded', String(!showing));
    if (!showing) load();
  });

  box.querySelector('[data-share-new]').addEventListener('click', async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: ws, kind: 'review', target: target }),
      });
      if (!res.ok) { field.value = 'Could not create a link (' + res.status + ')'; fresh.hidden = false; return; }
      const made = await res.json();
      field.value = made.url;
      fresh.hidden = false;
      field.focus();
      field.select();
      await load();
    } finally { button.disabled = false; }
  });

  box.querySelector('[data-share-copy]').addEventListener('click', async (ev) => {
    field.select();
    try { await navigator.clipboard.writeText(field.value); ev.currentTarget.textContent = 'copied'; }
    catch (e) { ev.currentTarget.textContent = 'press copy'; }
    setTimeout(() => { ev.currentTarget.textContent = 'copy'; }, 1600);
  });
})();
`;
}

/** The panel's markup. Empty string when the reader may not share, so the page a
 *  stranger or a share holder gets has no share affordance to find. */
function sharePanel(canShare: boolean): string {
  if (!canShare) return "";
  return (
    `<div class="sharebox" data-sharebox hidden>` +
    `<p class="share-title">Share this review</p>` +
    `<ul class="share-list" data-share-list></ul>` +
    `<p data-share-empty>No link opens this review yet.</p>` +
    `<div class="share-fresh" data-share-fresh hidden>` +
    `<div class="share-url">` +
    `<input type="text" readonly data-share-url aria-label="The share link">` +
    `<button type="button" data-share-copy>copy</button>` +
    `</div>` +
    `<p class="share-once">Copy it now. Links are stored hashed, so this one cannot be shown again.</p>` +
    `</div>` +
    `<p style="margin-top:10px"><button type="button" data-share-new>Create link</button></p>` +
    `</div>`
  );
}

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
function prBody(ownerId: string, body: string, d: EntityDelta | null): string {
  // Marked first, then tested for emptiness: a description cleared between versions
  // renders as nothing at all, and dropping the fold there would leave the card's
  // revised status label pointing at no mark.
  const inner = marked(prBodyHtml(body), d, "body", `${ownerId}-body`);
  if (inner === "") return "";
  return (
    `<details class="fold" id="${escapeHtml(ownerId)}-body">` +
    `<summary>${icon("chev", "tick")}<span class="fh"><b>author description</b></span></summary>` +
    `<div class="fold-body prbody-body">${inner}</div></details>`
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
  for (const m of doc.codeDesign?.modules ?? []) take(m.refs, []);
  for (const c of doc.codeDesign?.coverage ?? []) take(c.refs, []);
  return byId;
}

/** What one pull request changed, counted off the hunks the document carries for it
 *  rather than off anything authored or fetched a second time. The chain and the
 *  walkthrough therefore cannot disagree: they add up the same lines. A pull request
 *  with no hunks (nothing but a merge, or a diff GitHub would not serve) shows no
 *  count instead of a confident zero. */
function prStat(pr: Pr, hunks: Hunk[]): string {
  const mine = hunks.filter(
    (h) => h.prNumber === pr.number && h.repo === pr.repo,
  );
  if (mine.length === 0) return "";
  const { added, removed } = stats(mine);
  // U+2212, the minus sign: the count is a quantity, not a diff glyph.
  return `<span class="c-stat">${statHtml(added, removed)}</span>`;
}

/**
 * What GitHub says this pull request is, in GitHub's own vocabulary.
 *
 * No observation draws nothing. A fourth glyph meaning "we have not looked" would be
 * Seer inventing a state GitHub does not have; the chip above the chain is where
 * absence is said, once, rather than on every card.
 *
 * Colour is never the only channel: four distinct shapes, and the word itself in the
 * accessible name, so the four are told apart with colour removed.
 */
function statusGlyph(status: PrStatusWord | undefined): string {
  if (status === undefined) return "";
  return icon(`pr-${status}`, `ic c-status s-${status}`, status);
}

function card(
  pr: Pr,
  refs: Map<string, Ref>,
  hunks: Hunk[],
  ctx: RenderCtx,
): string {
  const kinds = pr.kinds
    .map((k) => icon(k, `ic k-${k}`, KIND_LABEL[k] ?? k))
    .join("");
  const owner = `pr-${pr.number}`;
  const detailRef = refs.get(pr.detailRef);
  const detailFold = detailRef ? refFold(owner, detailRef, "", ctx.hunks) : "";
  const d = ctx.delta ? ctx.delta.get("pr", prKey(pr.repo, pr.number)) : null;
  const edit = entityEditControl(d, owner);
  const hasMore =
    pr.detail.trim() !== "" || detailFold !== "" || pr.body.trim() !== "";
  // Three readings, each earned by a tap. Closed is the title and what it cost,
  // which is what a stack is scanned for. Open adds the clean one-line gist and an
  // explicit edit control when needed. The nested fold holds the author's own account, which is the longest
  // thing on the card and the least often wanted.
  const more = hasMore
    ? `<details class="c-more"><summary>${icon("chev", "tick")}` +
      `<span class="c-morelabel">${escapeHtml(prLabel(pr))} on GitHub</span></summary>` +
      `<div class="card-body">` +
      marked(safeBlock(pr.detail), d, "detail", owner) +
      detailFold +
      prBody(owner, pr.body, d) +
      `</div></details>`
    : "";
  return (
    `<details class="card" id="${escapeHtml(owner)}">` +
    `<summary>` +
    `<span class="c-head">` +
    `<span class="c-title">${escapeHtml(pr.title)}</span>` +
    `${icon("chev", "tick")}` +
    `</span>` +
    // Named with the same key the live message uses, so a push can find this card's
    // glyph without the script holding any per-pull-request state of its own.
    `<span class="c-id" data-pr="${escapeHtml(prKey(pr.repo, pr.number))}">` +
    statusGlyph(ctx.status[prKey(pr.repo, pr.number)]) +
    `<a class="c-ref" href="https://github.com/${escapeHtml(pr.repo)}/pull/${pr.number}">` +
    `${icon("pr")}<span class="c-reftext">${escapeHtml(prLabel(pr))}</span></a>` +
    prStat(pr, hunks) +
    `</span>` +
    `</summary>${edit.input}` +
    `<div class="c-open">` +
    `<span class="c-kinds">${kinds}${statusMark(d)}</span>` +
    edit.label +
    `<span class="c-line">${marked(safeInline(pr.gist), d, "gist", owner)}</span>` +
    more +
    `</div></details>`
  );
}

/** What a card calls its pull request. The owner is dropped: every pull request in
 *  one review names the same repository, so the owner is the same word on every
 *  card and the number is the part that differs. `threahq/threa#1723` becomes
 *  `threa#1723`, which fits the sidebar without wrapping. */
function prLabel(pr: Pr): string {
  const cut = pr.repo.lastIndexOf("/");
  const name = cut === -1 ? pr.repo : pr.repo.slice(cut + 1);
  return `${name}#${pr.number}`;
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
function chain(doc: ReviewDoc, ctx: RenderCtx): string {
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
  const cards = prs
    .map((pr) => card(pr, refs, doc.hunks, ctx))
    .join(stack ? arrow : "");
  // A pull request the base version carried and this one does not stays in the
  // chain as a stub. A link that quietly leaves the stack is the one change a
  // reader of a stack most needs to see.
  const gone = ctx.delta
    ? ctx.delta
        .removed("pr")
        .map((e) => removedStub(e, "card", "c-line"))
        .join("")
    : "";
  return `<div class="chain">${base}${prs.length > 0 && stack ? arrow : ""}${cards}${gone}</div>`;
}

/** Refs resolve once per pointer, so a row listing the same pointer twice holds the same
 *  ref twice. Its panel is addressed by that ref's id, and two panels under one row would
 *  share an id, so a row cites each ref once. */
function uniqueRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** How a row's delta reaches its evidence. Null when the page has no base, which
 *  is what leaves a first-ever open with no marks anywhere in it. */
function evidenceMarks(
  d: EntityDelta | null,
  owner: string,
): EvidenceMarks | null {
  if (!d) return null;
  return {
    // Evidence is drawn in a body rather than a summary, so a one-line field there
    // grows a control of its own: the row's chevron cannot reveal it.
    mark: (field, html) => marked(html, d, field, owner),
    touched: (field) => touched(d, field),
    dropped: (current) => {
      const has = new Set(current);
      return d.fields
        .map((f) => f.field)
        .filter((f) => f.startsWith("ev-") && !has.has(f));
    },
  };
}

function statementRow(s: Statement, ctx: RenderCtx): string {
  const refs = uniqueRefs(s.refs);
  const links = refLinks(s.id, refs);
  const folds = refs.map((r) => refFold(s.id, r, "", ctx.hunks)).join("");
  const d = ctx.delta ? ctx.delta.get("statement", s.id) : null;
  const edit = entityEditControl(d, s.id);
  return (
    `<details class="row" id="${escapeHtml(s.id)}">` +
    `<summary>${icon("chev", "tick")}${icon(s.kind, `ic k-${s.kind}`, KIND_LABEL[s.kind] ?? s.kind)}` +
    `<span class="rwhat">${marked(safeInline(s.text), d, "text", s.id)}</span>` +
    `<span class="rrefs">${statusMark(d)}${links}</span>` +
    `</summary>${edit.input}` +
    `<div class="row-body">${edit.label}${marked(safeBlock(s.body), d, "body", s.id)}${folds}` +
    questionsHere(ctx, "statement", s.id) +
    kindMark(d, s.id, s.kind) +
    renderEvidence(
      s.evidence,
      s.id,
      ctx,
      evidenceMarks(d, s.id),
      evidenceFieldNames(s.evidence),
    ) +
    `</div></details>`
  );
}

/** An entity the base version had and this one does not, drawn as a stub that
 *  opens to everything it used to say. An absence a reader cannot open is a
 *  claim they have to take on trust, so the former content comes with it. The head
 *  takes the class its container places and sizes, so a stub sits where the unit it
 *  replaces sat. */
function removedStub(e: EntityDelta, cls: string, headCls: string): string {
  const former = e.former ?? { head: "", body: [] };
  const id = `dgone-${safeId(e.id)}`;
  const body = former.body
    .map((h) => `<div class="dp dpb">${h}</div>`)
    .join("");
  // A removed row keeps the kind it was removed with in its class, but wears no kind
  // icon: the add, change and remove glyphs say what a living row is, and an absence
  // is not any of them. The italic status is the only change mark a stub needs.
  return (
    `<details class="${cls} dgoneunit" id="${escapeHtml(id)}">` +
    `<summary>${icon("chev", "tick")}` +
    `<span class="${headCls}"><span class="dp dpstub">${former.head}</span></span>` +
    `<span class="rrefs">${statusMark(e)}</span>` +
    `</summary>` +
    `<div class="dgone-body">${body === "" ? `<div class="dp dpb"></div>` : body}</div>` +
    `</details>`
  );
}

function removedStubsBefore(
  ctx: RenderCtx,
  kind: "statement" | "note" | "module" | "coverage",
  currentId: string | null,
  cls: string,
  headCls: string,
): string {
  return (ctx.delta?.removedBefore(kind, currentId) ?? [])
    .map((e) => removedStub(e, cls, headCls))
    .join("");
}

function designModuleBlock(m: DesignModule, ctx: RenderCtx): string {
  const refs = uniqueRefs(m.refs);
  const links = refLinks(m.id, refs);
  const folds = refs.map((r) => refFold(m.id, r, "", ctx.hunks)).join("");
  const d = ctx.delta ? ctx.delta.get("module", m.id) : null;
  const edit = entityEditControl(d, m.id);
  return (
    `<details class="dmodule" id="${escapeHtml(m.id)}">` +
    `<summary>${icon("chev", "tick")}<span class="dmodule-head">` +
    `<span class="dmodule-title">${marked(safeInline(m.title), d, "title", m.id)}</span>` +
    `</span><span class="rrefs">${statusMark(d)}</span></summary>${edit.input}` +
    `<div class="dmodule-body">${edit.label}${marked(safeBlock(m.body), d, "body", m.id)}` +
    `<div class="dpaths">${marked(designPathsHtml(m.paths), d, "paths", m.id)}</div>` +
    (links === "" ? "" : `<div class="design-refs">${links}</div>`) +
    folds + `</div></details>`
  );
}

function designCoverageBlock(c: DesignCoverage, ctx: RenderCtx): string {
  const refs = uniqueRefs(c.refs);
  const links = refLinks(c.id, refs);
  const folds = refs.map((r) => refFold(c.id, r, "", ctx.hunks)).join("");
  const d = ctx.delta ? ctx.delta.get("coverage", c.id) : null;
  const edit = entityEditControl(d, c.id);
  return (
    `<details class="coverage-row" id="${escapeHtml(c.id)}">` +
    `<summary>${icon("chev", "tick")}<span class="coverage-title">` +
    marked(safeInline(c.title), d, "title", c.id) +
    `</span><span class="rrefs">${statusMark(d)}</span></summary>${edit.input}` +
    `<div class="coverage-body">${edit.label}${marked(safeBlock(c.body), d, "body", c.id)}` +
    (links === "" ? "" : `<div class="design-refs">${links}</div>`) +
    folds + `</div></details>`
  );
}

function codeDesignSection(doc: ReviewDoc, ctx: RenderCtx): string {
  const design = doc.codeDesign ?? { placement: "", modules: [], coverage: [] };
  const d = ctx.delta ? ctx.delta.get("design", "design") : null;
  const removedModules = ctx.delta?.removed("module") ?? [];
  const removedCoverage = ctx.delta?.removed("coverage") ?? [];
  const hasContent =
    design.placement.trim() !== "" ||
    design.modules.length > 0 ||
    design.coverage.length > 0 ||
    removedModules.length > 0 ||
    removedCoverage.length > 0 ||
    d !== null;
  if (!hasContent) return "";
  const modules =
    design.modules
      .map((m) =>
        removedStubsBefore(ctx, "module", m.id, "dmodule", "dmodule-title") +
        designModuleBlock(m, ctx),
      )
      .join("") +
    removedStubsBefore(ctx, "module", null, "dmodule", "dmodule-title");
  const coverage =
    design.coverage
      .map((c) =>
        removedStubsBefore(ctx, "coverage", c.id, "coverage-row", "coverage-title") +
        designCoverageBlock(c, ctx),
      )
      .join("") +
    removedStubsBefore(ctx, "coverage", null, "coverage-row", "coverage-title");
  const placement = marked(safeBlock(design.placement), d, "placement", "design", true);
  return (
    `<section id="design"><h2>Code design</h2>` +
    `<p class="secnote">Where the change lives in the code, and why there.</p>` +
    (placement === "" ? "" : `<div class="placement">${placement}</div>`) +
    (modules === "" ? "" : `<div class="design-grid">${modules}</div>`) +
    (coverage === ""
      ? ""
      : `<h3 class="design-heading">${icon("branch")}<span>Coverage</span></h3>` +
        `<p class="secnote">Every path that must reach the change, each proven in code.</p>` +
        `<div class="coverage-list">${coverage}</div>`) +
    `</section>\n`
  );
}

function noteRow(n: Note, ctx: RenderCtx): string {
  const refs = uniqueRefs(n.refs);
  const links = refLinks(n.id, refs);
  const folds = refs.map((r) => refFold(n.id, r, "", ctx.hunks)).join("");
  const d = ctx.delta ? ctx.delta.get("note", n.id) : null;
  const edit = entityEditControl(d, n.id);
  // A check the base version carried and this one dropped keeps its place in the
  // list, as an item holding only the prior words behind their disclosure. A list
  // that simply got shorter would be an absence a reader cannot see.
  const dropped = (d ? d.fields : [])
    .filter(
      (f) =>
        f.field.startsWith("check-") &&
        Number(f.field.slice(6)) >= n.checks.length,
    )
    .sort((a, b) => Number(a.field.slice(6)) - Number(b.field.slice(6)));
  const items = [
    ...n.checks.map((c, i) => marked(safeInline(c), d, `check-${i}`, n.id)),
    ...dropped.map((f) => marked("", d, f.field, n.id)),
  ];
  const checks =
    items.length === 0
      ? ""
      : `<ul class="checks">${items.map((h) => `<li>${h}</li>`).join("")}</ul>`;
  return (
    `<details class="note is-${escapeHtml(n.kind)}" id="${escapeHtml(n.id)}">` +
    `<summary>${icon("chev", "tick")}${icon(n.kind, `ic k-${n.kind}`, n.kind)}` +
    `<span class="none">${marked(safeInline(n.text), d, "text", n.id)}</span>` +
    `${statusMark(d) === "" ? "" : `<span class="rrefs">${statusMark(d)}</span>`}` +
    `</summary>${edit.input}` +
    `<div class="note-body">${edit.label}${marked(safeBlock(n.body), d, "body", n.id)}${checks}${links === "" ? "" : `<p class="rrefs">${links}</p>`}${folds}` +
    questionsHere(ctx, "note", n.id) +
    kindMark(d, n.id, n.kind) +
    renderEvidence(
      n.evidence,
      n.id,
      ctx,
      evidenceMarks(d, n.id),
      evidenceFieldNames(n.evidence),
    ) +
    `</div></details>`
  );
}

// ---- questions ----

function targetKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/** The element on this page a target names, or null when the target is not something
 *  the page gives an id to. A file target names a path, which no element is keyed by:
 *  one path is drawn once per group that claims it, so no single element is it. A hunk
 *  is keyed by the escaped form of its id, which is what its element carries. */
function targetAnchor(a: Annotation): string | null {
  switch (a.target.type) {
    case "statement":
    case "note":
    case "group":
      return a.target.id;
    case "hunk":
      return hunkAnchorId(a.target.id);
    case "summary":
      return "summary";
    case "file":
      return null;
  }
}

/** What a question says about itself: whether it is answered, and which version of the
 *  review it was asked about. A question filed against v1 keeps saying v1 on v3,
 *  because that is the text its quote resolves against. */
function questionMeta(a: Annotation, version: number, at: string): string {
  const state =
    a.status === "open"
      ? `<span class="is-open">open</span>`
      : `<span class="is-answered">answered</span>`;
  const filed = `filed against v${a.version}`;
  // A question asked about an older version is worth saying twice: the reader is
  // looking at different words than the asker was.
  const stale =
    a.version === version
      ? ""
      : `<span>${escapeHtml(`reading v${version}`)}</span>`;
  return `<p class="qmeta">${state}<span>${escapeHtml(filed)}</span>${stale}<span>on ${at}</span></p>`;
}

/** One question, with its answer when it has one. Bodies are typed by people, so
 *  nothing here is parsed as markup: they are escaped text with their line breaks
 *  kept. The answer's refs are links to the same folds a statement's refs use. */
function questionBlock(a: Annotation, version: number): string {
  const quote =
    a.quote === null || a.quote === ""
      ? ""
      : `<p class="qquote">${plainText(a.quote)}</p>`;
  const anchor = targetAnchor(a);
  const where = `${a.target.type} ${a.target.id}`;
  const at =
    anchor === null
      ? `<span>${escapeHtml(where)}</span>`
      : `<a href="#${escapeHtml(anchor)}">${escapeHtml(where)}</a>`;
  const refs = a.answer ? uniqueRefs(a.answer.refs) : [];
  const links = refs.map((r) => ` ${refLink(a.id, r)}`).join("");
  const folds = refs.map((r) => refFold(a.id, r)).join("");
  const answer = a.answer
    ? `<p class="aline"><span class="mk">A:</span><span>${plainText(a.answer.body)}${links}</span></p>` +
      folds
    : "";
  return (
    `<div class="qa" id="${escapeHtml(a.id)}">` +
    `<p class="qline"><span class="mk">Q:</span><span>${plainText(a.body)}</span></p>` +
    quote +
    answer +
    questionMeta(a, version, at) +
    `</div>`
  );
}

/** Text a person typed, escaped and with its line breaks kept. Never markdown: an
 *  annotation is the one string on the page no validator ever saw. */
function plainText(source: string): string {
  return escapeHtml(source).split("\n").join("<br>");
}

/** The link a target row grows once something has been asked about it. The question
 *  itself lives once, in the questions section, so this is an anchor rather than a
 *  second copy that could say something different. */
function questionsHere(ctx: RenderCtx, type: string, id: string): string {
  // Deferred. The annotation write path, its storage and its roles are built and
  // tested; what is not built is a reading grammar for questions worth putting on
  // this page. Until there is one, a review renders no question marks and no ask
  // form: an unresolved design is better absent than shipped as a raw form.
  if (!QUESTIONS_ON_PAGE) return "";
  const asked = ctx.annotations.get(targetKey(type, id));
  if (!asked || asked.length === 0) return "";
  const links = asked
    .map(
      (a) =>
        `<a href="#${escapeHtml(a.id)}">${escapeHtml(a.status === "open" ? "open question" : "answered question")}</a>`,
    )
    .join(" · ");
  return `<p class="qhere">${links}</p>`;
}

/** Whether questions are drawn on the page at all. See questionsHere: the endpoint
 *  stands, the rendering waits for a design. */
const QUESTIONS_ON_PAGE = false;

/** One target's options in the ask form, so a reader without scripting can still say
 *  what they are asking about. */
function targetOptions(doc: ReviewDoc): string {
  const option = (type: string, id: string, label: string) =>
    `<option value="${escapeHtml(`${type}:${id}`)}">${escapeHtml(label)}</option>`;
  return (
    option("summary", "summary", "the summary") +
    doc.statements.map((s) => option("statement", s.id, s.text)).join("") +
    doc.notes.map((n) => option("note", n.id, n.text)).join("") +
    doc.groups.map((g) => option("group", g.id, g.title)).join("")
  );
}

/** The questions section. Nothing here needs scripting: the form is a plain POST to
 *  the annotations route, which answers a form with the page it came from. */
function questionsSection(
  input: RenderInput,
  annotations: Annotation[],
  basePath: string,
): string {
  if (!QUESTIONS_ON_PAGE) return "";
  const blocks =
    annotations.length === 0
      ? `<p class="qnone">Nothing has been asked about this review.</p>`
      : annotations.map((a) => questionBlock(a, input.version)).join("");
  const form = !input.canFile
    ? ""
    : `<div class="ask"><form class="ask-form" method="post" ` +
      `action="${escapeHtml(basePath)}/annotations">` +
      `<div class="ask-where"><label for="ask-target">About</label>` +
      `<select id="ask-target" name="target" required>${targetOptions(input.doc)}</select></div>` +
      `<div class="ask-what"><label for="ask-body">Question</label>` +
      `<textarea id="ask-body" name="body" rows="2" required></textarea></div>` +
      `<button type="submit">Ask</button></form></div>`;
  return `<section id="questions"><h2>Questions</h2>${blocks}${form}</section>\n`;
}

/** Decisions first, then risks, then observations. The page exists to put a human
 *  in a position to judge, so an explicit decision is the first review focus. */
function notesInOrder(notes: Note[]): Note[] {
  return [
    ...notes.filter((n) => n.kind === "decision"),
    ...notes.filter((n) => n.kind === "risk"),
    ...notes.filter((n) => n.kind === "note"),
  ];
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
  /** Every hunk of the document by (sha, path), so a ref into changed code is drawn
   *  as the diff it cites. */
  hunks: HunkIndex;
  /** What moved since the base version, or null when this page has no base. */
  delta: DeltaIndex | null;
  /** Every annotation on the review, by `${targetType}:${targetId}`. Annotations
   *  belong to the review rather than to a version, so this is the same map whichever
   *  version is being read. */
  annotations: Map<string, Annotation[]>;
  /** The status word per pull request, for the glyph on its card. Empty for a review
   *  nothing has observed. */
  status: Record<string, PrStatusWord>;
}

/** One row of the revision menu. Counts are derived from the delta between a
 *  version and the one before it, so the timeline says the same thing the page
 *  says, computed the same way. */
export interface TimelineEntry {
  version: number;
  createdAt: number;
  revised: number;
  added: number;
  removed: number;
  /** Fields without a row status that moved, such as title, author intent or summary.
   *  They carry marks, and the menu says so rather than saying nothing. */
  restated: string[];
  codeMoved: boolean;
}

export interface RenderInput {
  wsId: string;
  slug: string;
  /** The path this page is served under. Defaults to the review's own workspace-scoped
   *  path; a share passes `/s/<token>`, so every link the page draws is one the holder
   *  can actually follow. */
  basePath?: string;
  /** Whether the page opens the review's freshness channel. False for a page served to
   *  someone who is not a member: that channel asks for membership, so the script could
   *  only fail, and it would print the workspace id into a page served on a secret. */
  live?: boolean;
  /** Whether the full-screen panel may ask for the file around a hunk. False for a
   *  shared page: the link handed out the review and the hunks the walkthrough drew,
   *  and the whole of every file they touch is a larger thing than the person who
   *  minted it agreed to. The route refuses a share token as well, so this is the
   *  panel not offering what it would not be given rather than the gate itself. */
  context?: boolean;
  doc: ReviewDoc;
  version: number;
  latestVersion: number;
  /** True when the URL pinned a version rather than asking for the current one. */
  pinned: boolean;
  freshness: Record<string, Freshness>;
  /** What GitHub last said each pull request was, keyed by `${repo}#${number}`. A key
   *  with no entry has no observation, and its card draws no glyph. */
  status?: Record<string, PrStatusWord>;
  /** When the oldest observation behind those readings was made, or null when nothing
   *  has been observed. Past `OBSERVATION_STALE_MS` the page says so; below it the
   *  readings stand on their own, because a status confirmed minutes ago does not need
   *  a disclaimer. */
  observedAt?: number | null;
  /** Whether to draw the refresh control. The route it posts to answers only a reader
   *  who may read the review, so a page with no such reader gets no button rather than
   *  one that could only 404. */
  canRefresh?: boolean;
  /** Now, for the staleness comparison. A parameter so a test can age an observation
   *  without sleeping through the threshold. */
  now?: number;
  /** The version the marks are measured against, or null for a page with none. */
  baseVersion?: number | null;
  /** The delta from that base. Null and baseVersion null move together. */
  delta?: DeltaIndex | null;
  /** Newest first. Empty leaves the revision menu off the page. */
  timeline?: TimelineEntry[];
  /** Every annotation on the review, oldest first. */
  annotations?: Annotation[];
  /** Whether this reader may file one. False draws the questions that exist without
   *  the form: a page served to a key holder is not a page anyone can ask from. */
  canFile?: boolean;
  /** Whether this reader may hand the review out. Minting is a member's act on the
   *  review's own url, so a share holder and a stranger get a page with no share
   *  control and no script that could reach the mint route. */
  canShare?: boolean;
}

/** The revision menu: every published version, what moved in it, and the two
 *  ways to reach it. `/v/:n` reads that version; `?from=n` keeps this version on
 *  screen and moves the base the marks are measured against. */
function revisionMenu(input: RenderInput, basePath: string): string {
  const entries = input.timeline ?? [];
  if (entries.length === 0) return "";
  const rows = entries
    .map((e) => {
      const moved: string[] = [];
      if (e.added > 0) moved.push(`${e.added} new`);
      if (e.revised > 0) moved.push(`${e.revised} revised`);
      if (e.removed > 0) moved.push(`${e.removed} removed`);
      if (e.restated.length > 0)
        moved.push(`${e.restated.join(", ")} restated`);
      // A row may not deny movement it is marking in the same breath: when the
      // only thing that moved is a head SHA, the code-moved status label beside this is
      // the whole count.
      const counts =
        moved.length === 0
          ? e.codeMoved
            ? ""
            : "nothing moved"
          : moved.join(" · ");
      const at = new Date(e.createdAt);
      const on = Number.isNaN(at.getTime())
        ? ""
        : at.toISOString().slice(0, 10);
      const here = e.version === input.version;
      const isBase = e.version === (input.baseVersion ?? null);
      return (
        `<li class="rv${here ? " is-here" : ""}${isBase ? " is-base" : ""}">` +
        `<a class="rv-n" href="${escapeHtml(basePath)}/v/${e.version}">v${e.version}</a>` +
        `<span class="rv-on">${escapeHtml(on)}</span>` +
        // The moved label sits inside the counts, so it wraps with them rather than
        // breaking onto a line of its own beside the from link. The space is part of
        // the text, and only there when there is text to separate it from: a row whose
        // only movement is the code starts where every other row's counts start.
        `<span class="rv-counts">${counts === "" ? "" : `${escapeHtml(counts)} `}${
          e.codeMoved ? movedStatus() : ""
        }</span>` +
        // A base is a version below the one on screen. An entry at or above it has
        // no `from` link, because the page could not honour one: an inert control
        // that looks live is worse than no control.
        (here
          ? `<span class="rv-from">reading</span>`
          : e.version < input.version
            ? `<a class="rv-from" href="${escapeHtml(basePath)}${
                input.pinned ? `/v/${input.version}` : ""
              }?from=${e.version}">from v${e.version}</a>`
            : `<span class="rv-from"></span>`) +
        `</li>`
      );
    })
    .join("");
  return (
    `<details class="revs" id="revisions"><summary>${icon("chev", "tick")}` +
    `<span class="revs-h">revisions</span>` +
    `<span class="revs-n">${entries.length}</span></summary>` +
    `<ol class="revlist">${rows}</ol></details>`
  );
}

/** The heads text, as the page draws it and as the live push rewrites it. One
 *  function so the two cannot drift into two different sentences. */
function headsText(behind: number, unknown: number, total: number): string {
  // Three counts, not one. A `behind === 0` test collapsed every unobserved review to
  // "up to date", which is the chip asserting a freshness the glyphs beside it
  // cannot show: absence has to be sayable here or the chip lies where the glyph is
  // honest. A pull request that moved is the more urgent of the two, so it wins.
  if (behind > 0) return `${behind} of ${total} behind`;
  if (unknown > 0) return unknown === total ? "heads unchecked" : `${unknown} of ${total} unchecked`;
  return "up to date";
}

/**
 * "as of <time>", or nothing at all.
 *
 * Exported for the test that pins the threshold: an observation a minute old renders
 * bare and one three hours old renders dated, and both halves matter — a page that
 * always says "as of" is a page whose reader learns nothing from it saying so.
 */
export function asOfMark(observedAt: number | null, now: number): string {
  if (observedAt === null) return "";
  const age = now - observedAt;
  if (age < OBSERVATION_STALE_MS) return "";
  return `<span class="asof" id="asof">${escapeHtml(`as of ${agoWords(age)}`)}</span>`;
}

/**
 * The refresh control: the only thing left on this page that reaches GitHub, and it
 * does so because a human pressed it.
 *
 * It reloads on success rather than waiting for the live channel. The channel carries
 * an observation and publishes only when a reading *changed*, so a refresh that
 * confirms everything would leave the page silent — and silent is exactly wrong here,
 * because the thing the reader asked for was a newer `observed_at`, which no message
 * carries. A reload renders the answer they actually wanted: the same readings, newly
 * dated, with the "as of" gone.
 *
 * It reloads on an observation, though, and not on any 200: a refusal inside the
 * window is answered with the recorded reading, and the button says so rather than
 * reloading the page it was pressed on.
 */
function refreshScript(slug: string): string {
  return (
    `(()=>{const b=document.getElementById("refresh");if(!b)return;` +
    `b.addEventListener("click",()=>{b.disabled=true;b.textContent="checking\\u2026";` +
    `fetch("/api/reviews/"+encodeURIComponent(${JSON.stringify(slug)})+"/refresh",` +
    `{method:"POST",headers:{"accept":"application/json"}})` +
    `.then((r)=>{if(!r.ok)throw new Error(String(r.status));return r.json()})` +
    // The route answers 200 with `checked:false` when the window refused a fresh
    // fetch, and reloading on that would hand the reader the same stale page dressed
    // as a new observation — which is the one thing this button must not do.
    `.then((d)=>{if(d&&d.checked===false){b.disabled=false;` +
    `b.textContent="checked moments ago \\u2014 try again shortly";return}location.reload()})` +
    // A failed repair says so and stays pressable. Swallowing it would leave a page
    // that looks refreshed and is not, which is the failure this control exists for.
    `.catch(()=>{b.disabled=false;b.textContent="refresh failed \\u2014 try again"})})})();`
  );
}

/** The freshness enhancement: it subscribes to the review's channel and rewrites the
 *  heads text when a push says a head moved. Nothing depends on it. Without a script
 *  the text is as fresh as the render, which is what the stored rows say. */
function freshnessScript(wsId: string, slug: string): string {
  const current = JSON.stringify(headsText(0, 0, 0));
  const allUnchecked = JSON.stringify(headsText(0, 1, 1));
  return (
    `(()=>{const h=document.getElementById("heads");if(!h)return;` +
    `const c=()=>{const w=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+` +
    `"/ws/livereload?kind=review&ws="+encodeURIComponent(${JSON.stringify(wsId)})+` +
    `"&slug="+encodeURIComponent(${JSON.stringify(slug)}));` +
    `w.onmessage=(e)=>{let m=null;try{m=JSON.parse(e.data)}catch(x){return}` +
    // One message, carrying the whole observation: the glyphs and the chip are two
    // readings of one row, so they are rewritten from one message or they can disagree
    // on screen — which is the failure the single row exists to prevent.
    `if(!m||m.type!=="review")return;` +
    `const N="http://www.w3.org/2000/svg";` +
    `(m.prs||[]).forEach((p)=>{` +
    `const el=document.querySelector('[data-pr="'+(window.CSS&&CSS.escape?CSS.escape(p.pr):p.pr)+'"]');` +
    `if(!el)return;let g=el.querySelector(".c-status");` +
    // No status is no glyph, not a fourth shape: an observation that went away has to
    // be able to take its glyph with it.
    `if(!p.status){if(g)g.remove();return}` +
    `if(!g){g=document.createElementNS(N,"svg");g.appendChild(document.createElementNS(N,"use"));` +
    `el.insertBefore(g,el.firstChild)}` +
    `g.setAttribute("class","ic c-status s-"+p.status);g.setAttribute("role","img");` +
    `g.setAttribute("aria-label",p.status);` +
    `g.querySelector("use").setAttribute("href","#i-pr-"+p.status)});` +
    // The same three-count sentence headsText draws, because the two must not drift
    // into two different readings of one message.
    `const u=m.unknown||0;` +
    `h.textContent=m.behind>0?m.behind+" of "+m.total+" behind":` +
    `u>0?(u===m.total?${allUnchecked}:u+" of "+m.total+" unchecked"):${current}};` +
    `w.onclose=()=>setTimeout(c,2000)};c()})();`
  );
}

export function renderReviewPage(input: RenderInput): string {
  const { doc, slug, wsId } = input;
  const delta = input.delta ?? null;
  const annotations = input.annotations ?? [];
  const byTarget = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const key = targetKey(a.target.type, a.target.id);
    const list = byTarget.get(key);
    if (list) list.push(a);
    else byTarget.set(key, [a]);
  }
  const ctx: RenderCtx = {
    wsId,
    basePath: input.basePath ?? `/${wsId}/r/${slug}`,
    hunks: indexHunks(doc.hunks),
    delta,
    annotations: byTarget,
    status: input.status ?? {},
  };
  const review = delta ? delta.get("review", "review") : null;
  const intentDelta = delta ? delta.get("intent", "intent") : null;
  const summaryDelta = delta ? delta.get("summary", "summary") : null;

  const behind = doc.prs.filter(
    (pr) => input.freshness[prKey(pr.repo, pr.number)] === "behind",
  );
  // Absent counts as unchecked, not as checked: a document read with no freshness map
  // at all knows nothing about its heads and says so.
  const unchecked = doc.prs.filter(
    (pr) => (input.freshness[prKey(pr.repo, pr.number)] ?? "unknown") === "unknown",
  );
  const heads = headsText(behind.length, unchecked.length, doc.prs.length);
  // The chip states what was observed; this states when, and only once "when" is old
  // enough to change how the chip should be read. Below the threshold the reading
  // stands bare, which is the whole distinction: a disclaimer on every page would be
  // read by nobody and would say nothing about the page that has actually gone quiet.
  const asOf = asOfMark(input.observedAt ?? null, input.now ?? Date.now());
  const count =
    doc.prs.length === 1 ? "1 pull request" : `${doc.prs.length} pull requests`;
  const marking = input.pinned
    ? `version ${input.version} of ${input.latestVersion}`
    : `version ${input.version}`;

  const rows =
    doc.statements
      .map((s) => removedStubsBefore(ctx, "statement", s.id, "row", "rwhat") + statementRow(s, ctx))
      .join("") +
    removedStubsBefore(ctx, "statement", null, "row", "rwhat");
  const removedNotesBefore = (id: string | null) =>
    (delta?.removedBefore("note", id) ?? [])
      .map((e) =>
        removedStub(e, `note is-${escapeHtml(e.formerKind ?? "note")}`, "none"),
      )
      .join("");
  const notes =
    notesInOrder(doc.notes)
      .map((n) => removedNotesBefore(n.id) + noteRow(n, ctx))
      .join("") +
    removedNotesBefore(null);
  // The page says what it is measuring against, once, next to what it is.
  const hasCodeDesign = (() => {
    const d = doc.codeDesign;
    const current =
      !!d && (d.placement.trim() !== "" || d.modules.length > 0 || d.coverage.length > 0);
    const historical =
      !!delta &&
      (delta.get("design", "design") !== null ||
        delta.removed("module").length > 0 ||
        delta.removed("coverage").length > 0);
    return current || historical;
  })();
  const designLink = hasCodeDesign
    ? `<span class="nb"><a href="#design">code design</a> ·</span> `
    : "";

  const baseMark =
    input.baseVersion == null
      ? ""
      : `<span class="dbase">${escapeHtml(`compared with v${input.baseVersion}`)}</span>`;

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
    `<style>\n${STYLE}\n${EVIDENCE_STYLE}${STRUCTURE_STYLE}${ZOOM_STYLE}${DELTA_STYLE}${QUESTION_STYLE}` +
    `${input.canShare ? SHARE_STYLE : ""}</style>\n` +
    `</head>\n<body>\n` +
    SPRITE +
    `\n<main class="doc">\n` +
    `<header class="head">` +
    `<div class="head-row">` +
    `<span class="brand">${icon("eye", "eye", "Overseer")}<span class="wordmark">overseer</span></span>` +
    `<span class="head-tag">${escapeHtml(`${slug} · ${marking}`)}</span>` +
    (input.canShare
      ? `<button type="button" class="share-toggle" data-share-open aria-expanded="false" ` +
        `aria-label="Share this review outside the workspace">${icon("link", "mark")}</button>`
      : "") +
    `<button type="button" class="theme-toggle" data-theme-toggle hidden ` +
    `aria-label="Switch between the light and dark reading surface">` +
    `${icon("contrast", "mark")}</button>` +
    `</div>` +
    `<h1 class="title">${marked(safeInline(doc.title), review, "title", "review", true)}</h1>` +
    // A single-pull-request review is the ordinary case, and naming it says nothing
    // the count beside it does not. Every other kind still announces itself.
    `<p class="meta">${doc.kind === "single" ? "" : `<span>${escapeHtml(doc.kind)}</span>`}<span>${escapeHtml(count)}</span>` +
    `<span class="heads" id="heads">${escapeHtml(heads)}</span>${asOf}` +
    // Beside the chip, because the chip is the thing it repairs.
    (input.canRefresh
      ? // Wrapped in a span so the row's separator rule treats it like every other
        // fact in the line: the "·" between items comes from `.meta > span`.
        `<span><button type="button" class="refresh" id="refresh" ` +
        `aria-label="Ask GitHub for the current state of these pull requests">refresh</button></span>`
      : "") +
    `${baseMark}</p>` +
    revisionMenu(input, ctx.basePath) +
    `</header>\n` +
    sharePanel(input.canShare === true) +
    // The chain and the summary share one row on a wide screen: the stack is a
    // fixed, narrow column and the account takes the rest. In the markup the chain
    // still comes first, so a phone and a reader with no styles both meet the pull
    // request links before the prose, which is the order they are wanted in.
    `<div class="lede">` +
    chain(doc, ctx) +
    `<section id="summary"><h2>Overview</h2>` +
    (doc.authorIntent == null || doc.authorIntent.trim() === ""
      ? ""
      : `<div class="account"><p class="account-title">${icon("pr", "account-icon")}` +
        `<span>The problem</span> <span class="account-prov">· as the authors state it</span></p>` +
        `<div class="author-intent">${marked(safeBlock(doc.authorIntent), intentDelta, "authorIntent", "intent", true)}</div>` +
        `</div>`) +
    `<div class="account"><p class="account-title">${icon("eye", "account-icon")}` +
    `<span>The solution</span> <span class="account-prov">· as the witness verified it</span></p>` +
    `<div class="witness-account">${marked(safeBlock(doc.summary), summaryDelta, "summary", "summary", true)}</div>` +
    `</div>` +
    questionsHere(ctx, "summary", "summary") +
    `<p class="rows-title">What changes</p>` +
    `<div class="rows">${rows}</div>` +
    `<p class="contents"><span class="nb"><a href="#summary">overview</a> ·</span> ` +
    designLink +
    `<span class="nb"><a href="#notes">review focus</a> ·</span> ` +
    `<span class="nb"><a href="#walkthrough">implementation walkthrough</a></span></p>` +
    `</section></div>\n` +
    codeDesignSection(doc, ctx) +
    `<section id="notes"><h2>Review focus</h2>` +
    `<p class="secnote">Decisions to make, risks to verify, and things easy to miss.</p>` +
    `<div class="notes">${notes}</div></section>\n` +
    walkthroughSection(doc, delta, (type, id) => questionsHere(ctx, type, id)) +
    `\n` +
    questionsSection(input, annotations, ctx.basePath) +
    `<p class="colophon">${escapeHtml(
      `${slug} · ${marking}${publishedOn(doc.updatedAt)}`,
    )} · <a href="/overseer/agent.md">agent instructions</a></p>\n` +
    `</main>\n<script>${PAGE_SCRIPT}</script>\n` +
    `<script>${zoomScript(ctx.basePath, input.version, input.context !== false)}</script>\n` +
    (input.canShare ? `<script>${shareScript(wsId, slug)}</script>\n` : "") +
    // A pinned version is a record of what was published, so it gets no live channel:
    // only the page reading the current version can go behind while it is open. A page
    // whose reader could not subscribe to that channel gets none either.
    (input.pinned || input.live === false
      ? ""
      : `<script>${freshnessScript(wsId, slug)}</script>\n`) +
    (input.canRefresh ? `<script>${refreshScript(slug)}</script>\n` : "") +
    `</body>\n</html>\n`
  );
}

// ---- the routes ----

/** The one refusal this path has. Built from nothing the request carried, so a review
 *  in another workspace, a signed-out browser and a slug nobody ever published are one
 *  answer with one set of bytes. Exported as `reviewSoftNotFound` for the share route,
 *  which owes a dead token the same page a private review gives a stranger. */
export function softNotFound(): Response {
  return new Response(
    `<!doctype html>\n<html lang="en">\n<head>\n` +
      `<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
      `<meta name="robots" content="noindex, nofollow">\n` +
      `<script>${THEME_SCRIPT}</script>\n` +
      `<title>No such review · Overseer</title>\n` +
      `<link rel="icon" type="image/svg+xml" href="${FAVICON}">\n` +
      `<link rel="preload" href="/fonts/switzer.woff2" as="font" type="font/woff2" crossorigin>\n` +
      `<style>\n${STYLE}\n${GONE_STYLE}</style>\n` +
      `</head>\n<body>\n${SPRITE}\n<main class="doc gone">\n` +
      `<p class="gone-mark">${icon("eye", "gone-eye")}</p>\n` +
      `<h1 class="gone-title">No such review</h1>\n` +
      `<p class="gone-line">Either it does not exist, or it is not yours to read. ` +
      `This page cannot tell you which, and that is deliberate: a review that exists ` +
      `somewhere you cannot see it must look exactly like one that was never ` +
      `published, or the difference between the two answers is itself a leak.</p>\n` +
      `</main>\n</body>\n</html>\n`,
    {
      status: 404,
      headers: {
        "content-type": "text/html;charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/** The refusal page's own few rules. It shares the document's tokens and type, so a
 *  reader who lands here is plainly still inside the same thing, and it carries
 *  nothing built from the request: every refusal is these exact bytes. */
const GONE_STYLE = `
  .gone { max-width: 560px; padding-top: 18vh; }
  .gone-mark { margin: 0 0 22px; }
  .gone-eye { width: 30px; height: 30px; color: hsl(var(--ink)); }
  .gone-title {
    font-family: var(--font-display); font-size: 27px; font-weight: 500;
    letter-spacing: -0.015em; line-height: 1.2; color: hsl(var(--ink));
    margin: 0 0 14px;
  }
  .gone-line { font-size: 14.5px; line-height: 1.62; color: hsl(var(--ink-soft)); margin: 0; }
  @media (min-width: 700px) { .gone-title { font-size: 30px; } }
`;

/**
 * The version the marks are measured against.
 *
 * `?from=n` wins outright, because a reader who names a base has said what they
 * want to see. Otherwise it is the version this reader last opened, clamped below
 * the one being read: reopening v3 after reading v3 shows what moved into it, not
 * nothing. A reader who has never opened this review gets the previous version, so
 * a first visit still says what the last publish did. Version 1 has no base at all
 * and renders no marks.
 */
export function baseVersion(
  from: string | null,
  asked: number,
  lastOpened: number | null,
): number | null {
  if (from !== null) {
    const n = versionNumber(from);
    if (n !== null && n < asked) return n;
    // A `from` that names this version or one that does not exist is not a base.
    // The page falls back rather than refusing: the reader asked for a page.
  }
  const want =
    lastOpened === null ? asked - 1 : Math.min(lastOpened, asked - 1);
  return want >= 1 ? want : null;
}

type Counts = {
  revised: number;
  added: number;
  removed: number;
  codeMoved: number;
  restated: string[];
};

/** What moved in one version, against the one before it. A published version never
 *  changes, so this answer never changes either, and the timeline asks for it on
 *  every request of a page anyone may read. It is computed once per version and
 *  kept, rather than diffing the whole history again for each reader. Annotations
 *  do not enter a count, so none are passed. */
const COUNT_MEMO = new Map<string, Counts>();
const COUNT_MEMO_MAX = 2000;

function timelineCounts(
  ws: string,
  slug: string,
  version: number,
  docAt: (n: number) => ReviewDoc | null,
): Counts {
  const key = `${ws}:${slug}:${version}`;
  const have = COUNT_MEMO.get(key);
  if (have) return have;
  const cur = docAt(version);
  const before = version > 1 ? docAt(version - 1) : null;
  const counts =
    cur && before
      ? new DeltaIndex(
          computeDelta(
            { doc: before, annotations: [] },
            { doc: cur, annotations: [] },
          ),
        ).counts()
      : { revised: 0, added: 0, removed: 0, codeMoved: 0, restated: [] };
  // Oldest entry out, rather than the whole table: clearing it would make every
  // reader on a busy process pay for the next one's first request.
  if (COUNT_MEMO.size >= COUNT_MEMO_MAX) {
    const oldest = COUNT_MEMO.keys().next();
    if (!oldest.done) COUNT_MEMO.delete(oldest.value);
  }
  COUNT_MEMO.set(key, counts);
  return counts;
}

function versionNumber(raw: string): number | null {
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
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
  return reviewPage({
    review,
    slug,
    version,
    from: new URL(req.url).searchParams.get("from"),
    reader: sessionUser(req),
    sharePath: null,
  });
}

/**
 * The same page, reached with a share token instead of a session.
 *
 * The gate is the caller's: a share resolves to exactly one workspace and one slug, so
 * this looks the review up there and nowhere else, and a token for one review cannot
 * name another. What changes about the page is passed in rather than inferred: it hangs
 * off the share path, it renders no annotations, and it offers no write. The request is
 * not read at all, which is what makes that true by construction — there is no session
 * here to widen the page, and no reader whose read state an outsider could move.
 */
export function handleSharedReviewPage(
  wsId: string,
  slug: string,
  version: string | null,
  basePath: string,
  from: string | null = null,
): Response {
  if (!SLUG_RE.test(slug)) return softNotFound();
  const review = getReview(wsId, slug);
  if (!review) return softNotFound();
  return reviewPage({
    review,
    slug,
    version,
    from,
    reader: null,
    sharePath: basePath,
  });
}

/** The page itself, once the review has been resolved by whichever gate.
 *
 *  It takes a reader rather than a request, so a share cannot acquire one: the share
 *  route has no identity to hand in and there is no header here to read one out of.
 *  `sharePath` set and `reader` null move together, and between them they are the whole
 *  difference a share makes to the page: it hangs off the token path, it records no
 *  read, it draws no annotations, it offers no write, and it opens no live channel. */
function reviewPage(args: {
  review: { workspace_id: string; latest_version: number };
  slug: string;
  version: string | null;
  from: string | null;
  reader: SessionUser | null;
  sharePath: string | null;
}): Response {
  const { review, slug, version, sharePath } = args;
  const shared = sharePath !== null;
  const ws = review.workspace_id;

  const asked =
    version === null ? review.latest_version : versionNumber(version);
  if (asked === null || asked > review.latest_version) return softNotFound();
  const row = getReviewVersion(ws, slug, asked);
  // A head pointer with no row behind it is corruption, not a miss: the publish path
  // writes the row and the pointer in one transaction.
  if (!row)
    throw new Error(
      `Review ${ws}/${slug} has no version row for version ${asked}`,
    );

  const reader = args.reader;
  const read = reader ? getReviewRead(ws, slug, reader.id) : null;
  const base = baseVersion(args.from, asked, read ? read.version : null);
  // Read before render, written after the base is fixed: a reader who opens v3
  // sees it against what they last read, and the next open moves on.
  if (reader && (!read || read.version < asked))
    setReviewRead(ws, slug, reader.id, asked);

  const docs = new Map<number, ReviewDoc>([[asked, row.doc]]);
  const docAt = (n: number): ReviewDoc | null => {
    const have = docs.get(n);
    if (have) return have;
    const got = getReviewVersion(ws, slug, n);
    if (got) docs.set(n, got.doc);
    return got ? got.doc : null;
  };

  const baseDoc = base === null ? null : docAt(base);
  const delta =
    base === null || !baseDoc
      ? null
      : new DeltaIndex(
          // Both sides carry no annotations: an annotation row records the version it
          // was written at but not the version it was answered at, so the base side
          // cannot be reconstructed. Rather than approximate it and over-report every
          // answer, the route asks the delta nothing about annotations until the
          // storage can answer honestly. Annotations do render now, in the questions
          // section below, but each says its own state rather than claiming one
          // changed between two versions. Marking answers in the delta needs an
          // answered-at column and both sides wired here; until it exists,
          // `DeltaIndex.answered` is empty in production by construction.
          computeDelta(
            { doc: baseDoc, annotations: [] },
            { doc: row.doc, annotations: [] },
          ),
        );

  const timeline: TimelineEntry[] = [];
  for (const v of listReviewVersions(ws, slug)) {
    const counts = timelineCounts(ws, slug, v.version, docAt);
    timeline.push({
      version: v.version,
      createdAt: v.created_at,
      revised: counts.revised,
      added: counts.added,
      removed: counts.removed,
      restated: counts.restated,
      codeMoved: counts.codeMoved > 0,
    });
  }

  const html = renderReviewPage({
    wsId: ws,
    slug,
    basePath: sharePath ?? undefined,
    live: !shared,
    context: !shared,
    doc: row.doc,
    version: asked,
    latestVersion: review.latest_version,
    pinned: version !== null,
    freshness: freshnessOf(ws, slug, row.doc),
    // Both readings come off the same rows, so the chip and the glyphs cannot disagree
    // about a pull request nothing has observed.
    status: statusesOf(ws, row.doc),
    // Off the same rows again: the age the page reports is the age of the readings it
    // is showing, not of some other query.
    observedAt: observedAtOf(ws, slug, row.doc),
    // The refresh route answers a reader who may read the review, and it refreshes the
    // review's *current* version — so the button is drawn for a member on the page that
    // asked for the current version, and for nobody else. A share holder pressing it
    // would get a 404; a pinned page is a record of what was published, and repairing
    // it would mean repairing something other than what it shows, even when the pinned
    // number happens to be the latest one.
    canRefresh:
      !shared &&
      version === null &&
      reader !== null &&
      listUserWorkspaces(reader.id).some((w) => w.id === ws),
    baseVersion: delta ? base : null,
    delta,
    timeline,
    // Annotations belong to the review, not to the version being read, so a question
    // asked on v1 is still on the page at v3, saying v1. A shared page carries none of
    // them: the questions and answers are the workspace talking to itself about a
    // change, and a link handed to an outsider carries the account rather than the
    // discussion.
    annotations: shared ? [] : listAnnotations(ws, slug),
    // Filing is a member's act, so the form is drawn for a session that belongs to
    // this workspace and for nobody else. A page reached with an API key alone can be
    // read; it cannot be asked from.
    // A question is stamped with the current version, so it is asked from the page
    // that shows it: on a pinned older version the form would record a version the
    // reader is not looking at.
    canFile:
      asked === review.latest_version &&
      reader !== null &&
      listUserWorkspaces(reader.id).some((w) => w.id === ws),
    // Handing the review out is a member's act, and the same gate the mint route
    // applies. Unlike asking, it does not turn on which version is open: a share
    // names the review, and the link it makes renders whatever is current.
    canShare:
      !shared &&
      reader !== null &&
      listUserWorkspaces(reader.id).some((w) => w.id === ws),
  });
  // Nothing here reaches GitHub. Looking at a review used to check it; that automatic
  // check is deleted, not merely unused, so there is no path from a render to the
  // network to forget about later. Publish seeded these rows, deliveries maintain them,
  // and the refresh control repairs them when a delivery never came.

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
    },
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
  return attachmentBytes(review.workspace_id, slug, id);
}

/** The same bytes behind a share token. The share names the workspace and the slug, and
 *  the id is scoped to that review, so a token cannot be pointed at another review's
 *  attachment any more than a session can. */
export async function handleSharedReviewAttachment(
  wsId: string,
  slug: string,
  id: string,
): Promise<Response> {
  if (!ATT_ID_RE.test(id) || !SLUG_RE.test(slug)) return softNotFound();
  if (!getReview(wsId, slug)) return softNotFound();
  return attachmentBytes(wsId, slug, id);
}

async function attachmentBytes(
  ws: string,
  slug: string,
  id: string,
): Promise<Response> {
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
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
