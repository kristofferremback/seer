import { config } from "./config";

// Where the source lives; kept as a named const so it is trivial to re-point.
export const GITHUB_URL = "https://github.com/kristofferremback/seer";
export const CONTACT_EMAIL = "kristoffer.remback@gmail.com";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---- the scrying glass: one hand-drawn mark, the whole identity ----
// A crystal ball in its cradle. Drawn in one ink that it inherits from wherever
// it sits: strokes for the glass and the cradle, and one filled glint inside,
// which is the only solid shape in the mark and reads as the highlight without
// needing a colour of its own. It animates only where the mark is the subject
// (the figure), never where it is furniture (masthead, footer).
function markSvg(cls = "mark"): string {
  return `<svg class="${cls}" viewBox="0 0 48 58" role="img" aria-label="A crystal ball on a small stand" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="21" r="15" stroke="currentColor" stroke-width="1.5"/>
  <path d="M14 17 Q16 11 23 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>
  <path d="M11 31 Q24 43 37 31" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M13.5 33 L18 50" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M34.5 33 L30 50" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M16 51 L32 51" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="glint" d="M30 21.6 L30.95 24.05 L33.4 25 L30.95 25.95 L30 28.4 L29.05 25.95 L26.6 25 L29.05 24.05 Z" fill="currentColor"/>
</svg>`;
}

// ---- shared substrate + type ----
// Design language, shared with Witness: the substrate is an oxblood-black, Seer's
// red taken down to near-black, and it is designed dark first. The light theme is
// derived from it rather than inverted into it, and holds the same cast at the
// other end of the scale.
//
// Colour law: hue is reserved for meaning, and the only families allowed to carry
// it are change semantics (add / change / remove / keep), review-note kinds, and
// syntax classes on a code surface. Seer has none of those, so Seer is monochrome.
// The accent is hueless: a warm near-white in dark, a near-black in light, in both
// cases a value step past body ink rather than a colour. Every token is held under
// 8% chroma so the whole palette reads as one cast rather than as tints, which is
// the same bar the enforcement pass applies to the rendered pages.
//
// Life comes from value, rule and spacing instead: a two-step surface (paper /
// paper-sunk), hairline rules at every boundary, a three-step ink ramp
// (ink / ink-soft / muted), and the mark. Interactivity is structural: links carry
// a permanent underline and step toward the extreme of the value ramp, ambient
// navigation stays muted with its underline drawn in the rule colour, and the
// focus ring is the accent at full strength.
//
// Type is Cabinet Grotesk (display), Switzer (body), Commit Mono (real data only:
// slugs, versions, timestamps, curl). Tokens are HSL triplets so hsl(var(--x)/0.3)
// gives alpha variants. Both themes fully defined; the theme resolves pre-paint.
function styles(): string {
  return `
  @font-face {
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

  /* The light theme: a faint blush stone carrying the substrate's cast, verified
     on its own terms rather than assumed to work because dark does. The accent
     here is DARKER than body ink, not lighter: in a hueless system a link has to
     be at least as strong as the text around it, so it steps past the ink toward
     black and carries an underline. */
  :root {
    color-scheme: light;
    --paper: 8 30% 96.5%;
    --paper-sunk: 6 21% 90.5%;
    --ink: 8 20% 10%;
    --ink-soft: 8 15% 23%;
    --line: 6 20% 81%;
    --muted: 8 12% 31%;
    --accent: 10 20% 6%;

    --font-display: "Cabinet Grotesk", "Switzer", system-ui, -apple-system, sans-serif;
    --font-body: "Switzer", system-ui, -apple-system, sans-serif;
    --font-mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

    --pad-x: 56px;
  }
  /* The primary theme. The accent is a warm near-white: it sits above the prose
     ink it is set in, and below the display ink, so a link is a lift rather than
     a colour. */
  :root[data-theme="dark"] {
    color-scheme: dark;
    --paper: 356 28% 10%;
    --paper-sunk: 356 34% 6.5%;
    --ink: 18 22% 92%;
    --ink-soft: 14 15% 78%;
    --line: 356 16% 24%;
    --muted: 14 11% 67%;
    --accent: 28 20% 87%;
  }
  @media (max-width: 880px) {
    :root { --pad-x: 28px; }
  }
  /* The inline script in <head> resolves the theme before first paint. This is
     the no-JS floor: a system-dark visitor still lands on the primary surface. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --paper: 356 28% 10%;
      --paper-sunk: 356 34% 6.5%;
      --ink: 18 22% 92%;
      --ink-soft: 14 15% 78%;
      --line: 356 16% 24%;
      --muted: 14 11% 67%;
      --accent: 28 20% 87%;
    }
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: hsl(var(--paper));
    color: hsl(var(--ink));
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    touch-action: manipulation;
  }
  ::selection { background: hsl(var(--accent) / 0.2); }

  /* ---- surfaces ----
     Two steps and a rule. The old three-band tonal stack separated bands by tone
     alone, which needs a paper white to work; on a near-black substrate the steps
     collapse, so the boundary is drawn as a hairline and the tone step only says
     which side is the workbench. */
  .frame { width: 100%; background: hsl(var(--paper)); position: relative; z-index: 1; }
  /* The LAST band takes up any leftover viewport height, so on a short page the
     footer sits immediately under the content and the slack falls below it, on
     the same sunk surface the footer already stands on. Growing the content band
     instead (which is what this used to do) opened a tall empty field between the
     last thing on the page and the footer, which read as a hole rather than as an
     ending. */
  .frame.grow { flex: 1 0 auto; }
  .frame.sunk { background: hsl(var(--paper-sunk)); border-top: 1px solid hsl(var(--line)); }

  .shell {
    max-width: 52rem;
    margin: 0 auto;
    padding:
      clamp(2.4rem, 6vw, 4.5rem)
      max(var(--pad-x), env(safe-area-inset-right))
      clamp(2.4rem, 6vw, 4.5rem)
      max(var(--pad-x), env(safe-area-inset-left));
    padding-bottom: max(clamp(2.4rem, 6vw, 4.5rem), env(safe-area-inset-bottom));
    position: relative;
  }

  /* ---- thread spine ----
     A hairline down the content's left margin that says where the band starts and
     how far it runs. It used to carry a rotated diamond bead, which was ornament.
     Now the line is a rule like every other rule, and only its first 28px step up
     to the accent, as a tick marking the top of the band. On a monochrome page
     that value jump is doing the work a colour would have done. Hidden on narrow,
     where there is no margin to hang it in. */
  .spine::before {
    content: "";
    position: absolute;
    left: calc(var(--pad-x) / 2);
    top: 0; bottom: 0;
    width: 1px;
    background: hsl(var(--line));
    pointer-events: none;
  }
  .spine::after {
    content: "";
    position: absolute;
    left: calc(var(--pad-x) / 2);
    top: 0;
    width: 1px; height: 28px;
    background: hsl(var(--accent));
    pointer-events: none;
  }
  @media (max-width: 880px) {
    .spine::before, .spine::after { display: none; }
  }

  /* ---- masthead / nav row ----
     A rule under the row closes the identity band, so the mark, the wordmark and
     the title below read as one object instead of three stray lines floating on
     a dark field. */
  .nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 44px;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid hsl(var(--line));
    margin-bottom: clamp(2rem, 5vw, 3rem);
  }
  .brand { display: flex; align-items: center; gap: 0.65rem; text-decoration: none; color: inherit; }
  .brand .mark { width: 22px; height: 27px; flex: none; }
  .wordmark {
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 12.5px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: hsl(var(--ink));
  }
  .nav-actions { display: flex; align-items: center; gap: 1.1rem; }
  .nav-action {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    text-decoration-color: hsl(var(--line));
  }

  /* The theme control is the surface state itself, drawn as Lucide's contrast
     mark: half the disc inked, and which half flips with the theme. Same control
     as Witness carries. Bare icon, no pill, 44px target. It sits in the masthead
     register at muted, one step under the wordmark beside it, and resolves to
     full ink on hover. */
  .theme-toggle {
    background: none; border: 0; margin: 0 -10px 0 0; padding: 10px;
    min-width: 44px; min-height: 44px;
    color: hsl(var(--muted));
    cursor: pointer; line-height: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px;
    flex: none;
  }
  .theme-toggle .tt-mark {
    display: block; width: 17px; height: 17px;
    transform: rotate(0deg);
    transform-origin: 50% 50%;
  }
  :root[data-theme="dark"] .theme-toggle .tt-mark { transform: rotate(180deg); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-toggle .tt-mark { transform: rotate(180deg); }
  }
  .theme-toggle:active { background: hsl(var(--ink) / 0.07); }
  @media (hover: hover) and (pointer: fine) {
    .theme-toggle .tt-mark { transition: transform 220ms cubic-bezier(0.2, 0.9, 0.25, 1); }
    .theme-toggle:hover { color: hsl(var(--ink)); }
  }
  @media (prefers-reduced-motion: reduce) { .theme-toggle .tt-mark { transition: none; } }

  /* ---- display + body type ---- */
  .h-display {
    font-family: var(--font-display);
    font-weight: 300;
    font-size: clamp(34px, 6.2vw, 52px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0;
    max-width: 15ch;
  }
  /* Emphasis in the display line is weight, not colour. A single word tinted a
     different colour inside a headline is the two-tone move, and with a hueless
     accent it would only read as the word going dimmer. */
  .h-display em { font-style: normal; font-weight: 600; }
  .h-section {
    font-family: var(--font-display);
    font-weight: 300;
    font-size: clamp(28px, 4.4vw, 40px);
    line-height: 1.08;
    letter-spacing: -0.018em;
    margin: 0;
  }
  .subtitle {
    font-family: var(--font-body);
    font-size: clamp(1.02rem, 2.4vw, 1.16rem);
    line-height: 1.5;
    color: hsl(var(--ink-soft));
    margin: 1.15rem 0 0;
    max-width: 34ch;
  }
  .eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    margin: 0 0 0.9rem;
  }
  .email-tag { font-family: var(--font-mono); font-size: 0.78rem; letter-spacing: 0.02em; color: hsl(var(--muted)); }

  p { margin: 0 0 0.85rem; max-width: 42ch; min-width: 0; }
  .lede { font-size: 1.02rem; line-height: 1.6; max-width: 46ch; margin-top: 1.6rem; }
  .prose { color: hsl(var(--ink-soft)); }
  .prose p { max-width: 48ch; }
  .aside { color: hsl(var(--muted)); font-size: 0.95rem; }

  /* One interactivity rule, shared with Witness, and it carries no hue: a link is
     a value step plus a rule under it. In prose the accent steps past the ink it
     sits in (up in dark, down in light) and the underline is always drawn, so the
     affordance survives even where a link is the only word in a line. Press
     thickens the rule instead of moving anything. Ambient navigation (masthead,
     footer, version history) stays muted with its underline drawn in the line
     colour, so a row of links is a quiet ruled row and not a fence, and it
     resolves to full ink on hover. */
  a {
    color: hsl(var(--accent));
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    text-decoration-color: hsl(var(--accent) / 0.5);
  }
  a:active { text-decoration-color: currentColor; text-decoration-thickness: 2px; }
  @media (hover: hover) and (pointer: fine) {
    a { transition: color 150ms ease; }
    a:hover { text-decoration-color: currentColor; }
    .nav-action:hover, .brand:hover, .footer a:hover, .history a:hover { color: hsl(var(--ink)); }
  }
  :focus-visible { outline: 2px solid hsl(var(--accent)); outline-offset: 2px; border-radius: 3px; }

  code { font-family: var(--font-mono); font-size: 0.85em; }

  /* thin restrained scrollbars on overflow blocks */
  .scroll-x { overflow-x: auto; scrollbar-width: thin; scrollbar-color: hsl(var(--line)) transparent; }
  .scroll-x::-webkit-scrollbar { height: 6px; }
  .scroll-x::-webkit-scrollbar-thumb { background: hsl(var(--line)); border-radius: 999px; }
  .scroll-x::-webkit-scrollbar-track { background: transparent; }

  /* ---- specimen band: figure beside the copy-paste command ---- */
  .specimen-grid { display: grid; grid-template-columns: 1fr; gap: clamp(1.6rem, 4vw, 2.6rem); align-items: center; }
  .specimen-grid > * { min-width: 0; }
  @media (min-width: 720px) { .specimen-grid { grid-template-columns: minmax(0, 1fr) 200px; } }
  .fig { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 0.7rem; text-align: center; }
  .fig .mark-fig { width: 66px; height: 80px; }
  .fig figcaption { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: hsl(var(--muted)); }

  /* Cards are raised off the sunk band by one step of paper and a hairline.
     The corner radius came down from 14px: a soft product card sat oddly against
     a page whose other edges are all 1px rules. */
  .specimen {
    background: hsl(var(--paper));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    padding: 1.1rem 1.2rem 1.2rem;
  }
  pre.cmd {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    line-height: 1.7;
    margin: 0.7rem 0 0;
    padding: 0.85rem 0.95rem;
    background: hsl(var(--ink) / 0.045);
    border: 1px solid hsl(var(--line));
    border-radius: 6px;
    white-space: pre;
    color: hsl(var(--ink));
  }
  pre.cmd .flag { color: hsl(var(--muted)); }
  /* On a phone the command ran off the right edge and was cut mid-glyph inside a
     nested scroller. It already carries its own line continuations, so let it
     wrap there instead: the whole thing is readable without a sideways drag. */
  /* The upload URL is one unbroken token, so pre-wrap alone still ran it under
     the card's right padding and left the last glyph sitting on the border.
     Let it break anywhere on a narrow screen: the whole command stays inside
     the box with its gutter intact. */
  @media (max-width: 560px) {
    pre.cmd { white-space: pre-wrap; overflow-wrap: anywhere; }
  }
  .specimen-note { font-size: 0.9rem; color: hsl(var(--ink-soft)); max-width: none; margin: 0.85rem 0 0; }

  /* ---- ledger table ---- */
  .ledger {
    background: hsl(var(--paper));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    overflow: hidden;
    margin-top: 0.6rem;
  }
  table { width: 100%; border-collapse: collapse; }
  /* Cells never wrap. A slug broken across three lines and a timestamp broken
     across three more is not a table; the .ledger-wide wrapper scrolls sideways
     instead, for the rare slug long enough to need it. */
  th, td { padding: 0.7rem 1rem; vertical-align: baseline; text-align: left; white-space: nowrap; }
  th {
    font-family: var(--font-mono);
    font-weight: 500;
    font-size: 10.5px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    border-bottom: 1px solid hsl(var(--line));
  }
  td { border-bottom: 1px solid hsl(var(--line) / 0.6); }
  tr:last-child td { border-bottom: 0; }
  @media (max-width: 560px) { th, td { padding: 0.65rem 0.7rem; } }
  .mono { font-family: var(--font-mono); font-size: 0.82rem; color: hsl(var(--ink-soft)); }
  /* The slug is the one thing in this row you go to, so it is the strongest ink
     on the row and the only underline drawn at full strength. The version history
     beside it is a secondary route: same underline, drawn in the rule colour. */
  .slug a { font-weight: 500; }
  .history a { margin-right: 0.6rem; color: hsl(var(--muted)); text-decoration-color: hsl(var(--line)); }
  .empty { color: hsl(var(--muted)); margin-bottom: 1.4rem; }

  /* ---- ledger, stacked ----
     Four columns need about 480px of run before the last one starts leaving the
     card, so on a phone the table stops being a table. Each bundle becomes a
     block: the slug on its own line as the thing you go to, then the version and
     the timestamp under it in mono, then the version history. Nothing is clipped
     and nothing has to be dragged sideways to be read. The real table survives
     at desktop widths, where it is correct and dense. */
  .ledger-stack { display: none; list-style: none; margin: 0; padding: 0; }
  .ledger-stack > li { padding: 0.8rem 0.9rem; border-bottom: 1px solid hsl(var(--line) / 0.6); }
  .ledger-stack > li:last-child { border-bottom: 0; }
  .stack-slug { font-weight: 500; overflow-wrap: anywhere; }
  .stack-meta { max-width: none; margin: 0.3rem 0 0; }
  .stack-history { max-width: none; margin: 0.35rem 0 0; }
  @media (max-width: 700px) {
    .ledger-wide { display: none; }
    .ledger-stack { display: block; }
  }

  /* ---- footer ---- */
  /* It used to sit on a full-bleed night band, which was a slab of near-black on
     a page that is already near-black in the primary theme, and a hard black bar
     under a blush page in the other. Now it is the sunk surface with a rule over
     it, like every other boundary here. */
  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.9rem 1.6rem;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--muted));
  }
  .footer .brand, .footer .brand .wordmark { color: hsl(var(--ink)); }
  .footer .brand .mark { width: 18px; height: 22px; }
  .footer-links { display: flex; flex-wrap: wrap; gap: 0.7rem 1.4rem; }
  .footer a { color: hsl(var(--muted)); text-decoration-color: hsl(var(--line)); }
  .footer code { font-size: 0.95em; text-transform: none; letter-spacing: 0; }

  /* The glint animates only where the mark is the subject of the page, which is
     the figure. In the masthead and the footer the mark is furniture, and a
     sparkle that pulses forever in the corner of every page is decoration. */
  .glint { transform-box: fill-box; transform-origin: center; }
  @media (prefers-reduced-motion: no-preference) {
    .mark-fig .glint { animation: glint 5.5s ease-in-out infinite; }
  }
  @keyframes glint {
    0%, 100% { opacity: 0.55; transform: scale(0.86) rotate(0deg); }
    50% { opacity: 1; transform: scale(1.08) rotate(45deg); }
  }
`;
}


function head(title: string, og: Record<string, string>, extra = ""): string {
  const tags = Object.entries(og)
    .map(([k, v]) => {
      const attr = k.startsWith("og:") ? "property" : "name";
      return `<meta ${attr}="${k}" content="${escapeHtml(v)}">`;
    })
    .join("\n");
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#211213">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f9f4f3">
<script>${themeBootstrap()}</script>
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${tags}
<link rel="preload" href="/fonts/switzer.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/cabinet-grotesk.woff2" as="font" type="font/woff2" crossorigin>${extra ? `\n${extra}` : ""}
<style>${styles()}</style>
</head>`;
}

// Pre-paint theme resolution: a stored choice wins, else the system preference.
// Runs inline in <head> so data-theme is set before the first paint (no flash).
function themeBootstrap(): string {
  return `(()=>{let t=null;try{t=localStorage.getItem("seer:theme")}catch(e){}const d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"})();`;
}

// The toggle writes the explicit choice and flips data-theme on <html>. One
// delegated listener covers every toggle on the page.
function themeToggleScript(): string {
  return `<script>(()=>{if(window.__seerTT)return;window.__seerTT=1;document.addEventListener("click",e=>{const b=e.target.closest("[data-theme-toggle]");if(!b)return;const n=document.documentElement.dataset.theme==="dark"?"light":"dark";document.documentElement.dataset.theme=n;try{localStorage.setItem("seer:theme",n)}catch(x){}})})();</script>`;
}

function themeToggle(): string {
  // Lucide's contrast mark: half the disc inked, and which half flips with the
  // theme. The control shows the surface state rather than naming the next one.
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle light and dark mode">
    <svg class="tt-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>
  </button>`;
}

// Masthead nav row: the mark + SEER wordmark on the left, a quiet mono action
// link + the theme toggle on the right.
function navRow(action: { href: string; label: string } | null): string {
  return `<nav class="nav-row">
    <a class="brand" href="/">
      ${markSvg("mark")}
      <span class="wordmark">Seer</span>
    </a>
    <div class="nav-actions">
      ${action ? `<a class="nav-action" href="${action.href}">${action.label}</a>` : ""}
      ${themeToggle()}
    </div>
  </nav>`;
}

// Footer, in the reference register: mark + wordmark left, mono links right.
function footer(links: string[]): string {
  return `<footer class="footer">
    <a class="brand" href="/">${markSvg("mark")}<span class="wordmark">Seer</span></a>
    <div class="footer-links">${links.join("")}</div>
  </footer>`;
}

// ---- agent-facing skill doc (/skill.md, /llms.txt) ----
//
// Written FOR an AI agent that holds a SEER_URL and SEER_API_TOKEN and wants to
// publish an HTML bundle. config.baseUrl is interpolated so every curl example is
// copy-pasteable against this exact deployment. Served as text/markdown, no-cache.

export function skillDoc(): string {
  const base = config.baseUrl;
  return `# Seer: publishing HTML bundles as an agent

Seer is a personal preview host for self-contained HTML bundles. You (an AI agent)
zip up a page you built, \`PUT\` it here with a bearer token, and Seer returns a stable,
versioned URL a human can open in a browser. Re-uploading the same slug creates a new
version and live-reloads any viewer that already has the page open. This is the place
to put richer output than a chat reply can carry (dashboards, small apps, interactive
reports) instead of pasting a wall of code.

You need two things, which the human has given you (typically as environment
variables): the base URL of this Seer instance (\`${base}\`) and an API token
(referred to below as \`$API_TOKEN\`). Keep the token secret; it is the only write
credential.

## 1. Build the zip

- The zip must contain a root \`index.html\` (at the top level of the archive, not
  inside a subdirectory). That is what loads at the bundle URL.
- Use **relative** asset paths (\`./style.css\`, \`assets/app.js\`, \`img/logo.png\`).
  Absolute paths like \`/style.css\` will not resolve, because the bundle is served
  under \`/b/<slug>/\`.
- Nested directories are fine. Directory requests fall back to their \`index.html\`.
- Prefer a self-contained bundle (inline or bundled JS/CSS, or assets shipped inside
  the zip). External network requests are the human's browser's problem, not Seer's.
- Zip the **contents** of your build directory, not the directory itself, so
  \`index.html\` lands at the root of the archive:

\`\`\`sh
# from inside the build directory:
zip -r ../bundle.zip .
\`\`\`

Default size limit is 50 MB. Unsafe zip entries (absolute paths, \`..\`, null bytes)
are rejected.

## 2. Upload it

Pick a slug matching \`[a-z0-9][a-z0-9-]{0,63}\` (lowercase letters, digits, hyphens;
must start with a letter or digit; up to 64 characters). Send the zip as the raw
request body with \`--data-binary\` (not multipart):

\`\`\`sh
curl -X PUT --data-binary @bundle.zip \\
  -H "Authorization: Bearer $API_TOKEN" \\
  ${base}/api/bundles/<slug>
\`\`\`

\`PUT\` and \`POST\` behave identically. Each successful call creates the next version
for that slug.

## 3. Read the response

A successful upload returns \`200\` with JSON:

\`\`\`json
{
  "slug": "<slug>",
  "version": 1,
  "url": "${base}/b/<slug>/",
  "versionUrl": "${base}/b/<slug>/v/1/",
  "bytes": 2048,
  "files": 3,
  "hasIndexHtml": true
}
\`\`\`

- \`url\` is the **latest** URL: it always shows the newest version and live-reloads.
  Hand this one to the human in most cases.
- \`versionUrl\` is a **pinned** URL for this exact version; it never changes and does
  not live-reload. Use it when you want to reference a specific build permanently.
- Check \`hasIndexHtml\`: if it is \`false\`, you forgot the root \`index.html\` and the
  bundle URL will 404. Re-zip and re-upload.

Error responses are JSON with an \`error\` field. Notable statuses: \`400\` (invalid
slug, empty body, or bad zip), \`401\` (invalid or missing token), \`413\` (zip exceeds
the size limit).

## 4. Iterating

Upload the same slug again to publish a new version. Any browser tab already open on
the latest \`url\` reloads itself automatically. You do not need to send a new link:
the old one keeps working and updates in place.

## 5. Listing what is published

\`\`\`sh
curl -H "Authorization: Bearer $API_TOKEN" ${base}/api/bundles
\`\`\`

Returns every bundle with its full version history (slugs, versions, sizes,
timestamps).

## Sharing and viewing

Bundle URLs (\`/b/<slug>/\`) are **public**: anyone with the link can open it in a
browser, no sign-in required. Hand the \`url\` to whoever should see it, or open it
yourself. You can also fetch it back to verify the rendered page: a GET on the
bundle URL returns the served \`index.html\` (the latest URL has the live-reload
script injected before \`</body>\`).

Only the write side and the inventory are private: uploading needs the API token,
and the list of every bundle (\`GET /api/bundles\`) needs the token too. Individual
bundle links do not.
`;
}

// ---- public landing ----

export function landingPage(signedIn: boolean): string {
  const curl = `curl -X PUT --data-binary @bundle.zip \\
  <span class="flag">-H "Authorization: Bearer $API_TOKEN"</span> \\
  ${escapeHtml(config.baseUrl)}/api/bundles/your-slug`;

  const og = {
    "og:title": "Seer",
    "og:description":
      "A personal host for previewing HTML bundles from AI agent sessions: push a zip, get a versioned URL that reloads itself.",
    "og:type": "website",
    "og:url": config.baseUrl,
    "og:site_name": "Seer",
    "og:image": `${config.baseUrl}/og.png`,
    "og:image:width": "1200",
    "og:image:height": "630",
    "og:image:alt": "Seer, a private instrument for previewing HTML bundles",
    "twitter:card": "summary_large_image",
    "twitter:title": "Seer",
    "twitter:description": "Push a zip, get a versioned, self-reloading preview URL. A private little instrument.",
    "twitter:image": `${config.baseUrl}/og.png`,
  };

  const action = signedIn
    ? { href: "/bundles", label: "your bundles" }
    : { href: "/login", label: "Sign in" };

  return `<!doctype html>
<html lang="en">
${head("Seer", og, `<link rel="alternate" type="text/markdown" href="/skill.md">`)}
<body>
<div class="frame">
  <div class="shell spine">
    ${navRow(action)}
    <h1 class="h-display">Preview what your <em>agents</em> build.</h1>
    <p class="subtitle">A private instrument for previewing HTML&nbsp;bundles.</p>
    <div class="prose">
      <p class="lede">An agent builds a page, zips it, and pushes it here. Seer keeps every
      version and hands back a URL that reloads itself the moment a new build lands.</p>
      <p>One person's tool. Pushing a bundle needs the API key and the list of what's
      here stays private, but the bundle links themselves are public: hand one to
      anyone and they can open it, no sign-in. No accounts, no dashboard, no product.
      Just a place for half-finished pages to be looked at.</p>
      <p class="aside">It is a slop site, for sure. It also works.</p>
    </div>
  </div>
</div>
<div class="frame sunk">
  <div class="shell spine">
    <div class="specimen-grid">
      <div class="specimen">
        <p class="eyebrow">To push a bundle</p>
        <pre class="cmd scroll-x">${curl}</pre>
        <p class="specimen-note">Back comes <code>/b/your-slug/</code>, versioned and live.</p>
      </div>
      <figure class="fig">
        ${markSvg("mark mark-fig")}
        <figcaption>Fig. 1 &middot; the scrying glass</figcaption>
      </figure>
    </div>
  </div>
</div>
<div class="frame sunk grow">
  <div class="shell">
    ${footer([
      `<a href="${GITHUB_URL}">github</a>`,
      `<a href="mailto:${CONTACT_EMAIL}">email</a>`,
      `<a href="/skill.md"><code>skill.md</code></a>`,
      signedIn ? `<a href="/bundles">bundles</a>` : `<a href="/login">Sign in</a>`,
    ])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

// ---- signed-in bundle ledger ----

export interface LedgerBundle {
  slug: string;
  latestVersion: number;
  updated: string; // preformatted timestamp
  versions: number[];
}

export function bundlesPage(email: string, bundles: LedgerBundle[]): string {
  const og = { "og:title": "Bundles · Seer", "og:type": "website", "robots": "noindex" };

  const history = (b: LedgerBundle) =>
    b.versions.map((v) => `<a href="/b/${encodeURIComponent(b.slug)}/v/${v}/">v${v}</a>`).join("");

  const rows = bundles
    .map(
      (b) => `<tr>
        <td class="slug"><a href="/b/${encodeURIComponent(b.slug)}/">${escapeHtml(b.slug)}</a></td>
        <td class="mono">v${b.latestVersion}</td>
        <td class="mono">${escapeHtml(b.updated)}</td>
        <td class="history mono">${history(b)}</td>
      </tr>`,
    )
    .join("\n");

  // The same ledger as blocks, for widths where four columns do not fit. Only one
  // of the two is ever rendered (the other is display:none, so it is out of the
  // accessibility tree too), which keeps a real table at desktop and a real list
  // on a phone rather than a table pretending to be either.
  const blocks = bundles
    .map(
      (b) => `<li>
        <a class="stack-slug" href="/b/${encodeURIComponent(b.slug)}/">${escapeHtml(b.slug)}</a>
        <p class="stack-meta mono">v${b.latestVersion} &middot; ${escapeHtml(b.updated)}</p>
        <p class="stack-history history mono">${history(b)}</p>
      </li>`,
    )
    .join("\n");

  const body =
    bundles.length === 0
      ? `<p class="empty">No bundles yet.</p>
         <div class="specimen">
           <p class="eyebrow">Push your first one</p>
           <pre class="cmd scroll-x">curl -X PUT --data-binary @bundle.zip \\
  <span class="flag">-H "Authorization: Bearer $API_TOKEN"</span> \\
  ${escapeHtml(config.baseUrl)}/api/bundles/your-slug</pre>
         </div>`
      : `<div class="ledger">
          <div class="ledger-wide scroll-x">
            <table>
              <tr><th>Bundle</th><th>Latest</th><th>Updated</th><th>History</th></tr>
              ${rows}
            </table>
          </div>
          <ul class="ledger-stack">
            ${blocks}
          </ul>
        </div>`;

  return `<!doctype html>
<html lang="en">
${head("Bundles · Seer", og)}
<body>
<div class="frame">
  <div class="shell spine">
    ${navRow(null)}
    <p class="eyebrow"><span class="email-tag">${escapeHtml(email)}</span></p>
    <h1 class="h-section">Bundles</h1>
    <p class="subtitle">Everything Seer is holding.</p>
  </div>
</div>
<div class="frame sunk">
  <div class="shell spine">
    ${body}
  </div>
</div>
<div class="frame sunk grow">
  <div class="shell">
    ${footer([`<a href="/">back to the front</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

