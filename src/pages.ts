import { config } from "./config";
import type { TaskView } from "./projects/api";
import { escapeHtml } from "./escape";

export { escapeHtml };

// Where the source lives; kept as a named const so it is trivial to re-point.
export const GITHUB_URL = "https://github.com/kristofferremback/seer";
export const CONTACT_EMAIL = "kristoffer.remback@gmail.com";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

// Single pass so already-escaped sequences like &amp;lt; decode to &lt;, not <.
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED_ENTITIES[name] ?? m;
  });
}

// ---- social tags for served bundles ----
//
// Bundles are served verbatim, and agent-built pages almost never carry their own
// OpenGraph tags — so a shared bundle link unfurls as a bare <title>: no
// description, no image, and the raw hostname where the site name should be.
// Inject a Seer-branded set into every HTML page served from a bundle. The page's
// own <title> becomes og:title, entity-decoded then re-escaped once, so unfurlers
// that read the attribute value get clean text. A bundle that declares any og: or
// twitter: meta of its own knows what it wants — leave it entirely alone.

export interface BundleMeta {
  slug: string;
  version: number;
  updatedAt: number; // epoch ms of the served version's upload
  /** Canonical absolute URL of the page being served, or null when it must not be
   *  published. A page reached through a share is served at `/s/<token>`, and that path
   *  IS the secret: writing it into og:url would put the token in the page's own body,
   *  where every unfurler copies it onward and every crawler treats it as the address to
   *  index. The route already refuses to leak it through a Referer; this is the same
   *  refusal on the other way out. */
  url: string | null;
}

export function injectBundleMeta(html: string, meta: BundleMeta): string {
  if (/<meta[^>]+(?:property|name)=["']?(?:og:|twitter:)/i.test(html)) return html;

  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim() || meta.slug;
  const updated = new Date(meta.updatedAt).toISOString().slice(0, 10);
  const description = `An HTML bundle previewed on Seer — v${meta.version}, updated ${updated}.`;

  const tags = [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    ...(meta.url === null ? [] : [`<meta property="og:url" content="${escapeHtml(meta.url)}">`]),
    `<meta property="og:site_name" content="Seer">`,
    `<meta property="og:image" content="${escapeHtml(`${config.baseUrl}/og.png`)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Seer — a private instrument for previewing HTML bundles">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");

  // Prefer the real <head>; a head-less page still gets tags where unfurlers'
  // HTML parsers (which match <meta> anywhere) will find them.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tags}\n</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}\n${tags}`);
  return `${tags}\n${html}`;
}

// ---- the scrying glass: one hand-drawn mark, the whole identity ----
// A crystal ball in its cradle. The ink strokes are the instrument; the single
// oxblood glint inside is the only accent, and it is the one thing that moves.
function markSvg(cls = "mark"): string {
  return `<svg class="${cls}" viewBox="0 0 48 58" role="img" aria-label="A crystal ball on a small stand" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="21" r="15" stroke="currentColor" stroke-width="1.5"/>
  <path d="M14 17 Q16 11 23 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>
  <path d="M11 31 Q24 43 37 31" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M13.5 33 L18 50" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M34.5 33 L30 50" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M16 51 L32 51" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="glint" d="M30 21.6 L30.95 24.05 L33.4 25 L30.95 25.95 L30 28.4 L29.05 25.95 L26.6 25 L29.05 24.05 Z" fill="hsl(var(--accent))"/>
</svg>`;
}

// ---- shared paper substrate + type ----
// Design language: a warm-paper world shared with the Threa marketing site, but
// carrying Seer's own oxblood accent instead of gold. The page is a stack of
// full-bleed tonal bands (paper / paper-warm / night) that touch with no borders
// — separation by tone alone. Type is Cabinet Grotesk (display, light weight),
// Switzer (body), Commit Mono (real data only: slugs, versions, timestamps,
// curl). Oxblood carries interactive meaning: link hover, focus rings, the mark's
// glint, one thread spine. Tokens are HSL triplets so hsl(var(--x)/0.3) gives
// alpha variants. Light and dark both fully defined; theme resolved pre-paint.
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

  /* KEEP IN STEP with planCss(): the plan stylesheet carries a standalone copy of
     these tokens, and a value changed here without changing there forks the look. */
  :root {
    color-scheme: light;
    --paper: 40 22% 98%;
    --paper-warm: 38 16% 94%;
    /* A step deeper than it was: sunk surfaces and rules earn their name, so a card
       sits ON the page instead of dissolving into it. */
    --paper-sunk: 40 14% 90%;
    --ink: 30 10% 12%;
    --ink-soft: 30 9% 26%;
    --line: 35 14% 84%;
    --muted: 30 8% 45%;
    --night: 356 26% 9%;
    /* Oxblood — Seer's accent, in place of Threa's gold. */
    --accent: 356 55% 27%;
    --accent-soft: 356 40% 42%;

    --font-display: "Cabinet Grotesk", "Switzer", system-ui, -apple-system, sans-serif;
    --font-body: "Switzer", system-ui, -apple-system, sans-serif;
    --font-mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

    --pad-x: 56px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    /* The substrate is oxblood-black, not espresso: the paper itself carries a trace
       of the accent's hue, which is the surface the review pages already sit on. One
       dark, shared, instead of two that almost match. */
    --paper: 356 24% 11%;
    --paper-warm: 356 28% 8.5%;
    --paper-sunk: 356 32% 6.5%;
    --ink: 20 20% 91%;
    --ink-soft: 16 14% 77%;
    --line: 356 14% 23%;
    --muted: 8 9% 62%;
    --night: 356 30% 5%;
    /* Lifted so oxblood reads on its own black. */
    --accent: 356 48% 64%;
    --accent-soft: 356 38% 54%;
  }
  @media (max-width: 880px) {
    :root { --pad-x: 28px; }
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: hsl(var(--paper-warm));
    color: hsl(var(--ink));
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    touch-action: manipulation;
  }
  /* Paper grain — a fixed film of fractal noise behind the content. Multiply on
     light so it reads as paper tooth; screen on dark so it lifts rather than
     muddies the espresso. pointer-events none, low opacity: felt, not seen. */
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    mix-blend-mode: multiply;
    opacity: 0.05;
  }
  :root[data-theme="dark"] body::after {
    mix-blend-mode: screen;
    opacity: 0.04;
  }
  ::selection { background: hsl(var(--accent) / 0.22); }

  /* ---- tonal bands ---- */
  .frame { width: 100%; background: hsl(var(--paper)); position: relative; z-index: 1; }
  /* The content band grows to fill any leftover viewport height so the night
     footer always pins to the bottom, even on a short page. */
  .frame.grow { flex: 1 0 auto; }
  .frame.warm { background: hsl(var(--paper-warm)); }
  .frame.night { background: hsl(var(--night)); color: hsl(18 16% 82%); }

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

  /* ---- thread spine: a 1px oxblood line down the content's left margin, with a
     small rotated diamond bead where the section begins. Hidden on narrow. ---- */
  .spine::before {
    content: "";
    position: absolute;
    left: calc(var(--pad-x) / 2);
    top: 0; bottom: 0;
    width: 1px;
    background: hsl(var(--accent) / 0.22);
    pointer-events: none;
  }
  .spine::after {
    content: "";
    position: absolute;
    left: calc(var(--pad-x) / 2);
    top: clamp(2.4rem, 6vw, 4.5rem);
    width: 7px; height: 7px;
    transform: translate(-3.5px, 6px) rotate(45deg);
    background: hsl(var(--paper));
    border: 1px solid hsl(var(--accent));
    pointer-events: none;
  }
  .frame.warm .spine::after { background: hsl(var(--paper-warm)); }
  .frame.night .spine::after { background: hsl(var(--night)); }
  @media (max-width: 880px) {
    .spine::before, .spine::after { display: none; }
  }

  /* ---- app bar: the signed-in masthead ----
     One row that is the same on every signed-in page: brand, the two sections,
     the workspace switcher, who you are, the theme toggle. The switcher is a
     <details>, so it opens and closes with no script at all; the script only adds
     close-on-outside-click. */
  .appbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem 1.1rem;
    margin-bottom: clamp(2.2rem, 6vw, 3.2rem);
  }
  .appnav { display: flex; align-items: center; gap: 1.05rem; }
  .appnav a {
    font-family: var(--font-body);
    font-size: 0.95rem;
    color: hsl(var(--ink-soft));
    text-decoration: none;
    padding: 3px 1px;
  }
  .appnav a[aria-current="page"] {
    color: hsl(var(--ink));
    box-shadow: inset 0 -2px 0 hsl(var(--accent));
  }
  .appbar .bar-spacer { flex: 1; }
  @media (max-width: 640px) { .appbar .email-tag { display: none; } }

  .wsmenu { position: relative; }
  .wsmenu > summary {
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.92rem;
    color: hsl(var(--ink-soft));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    padding: 0.35rem 0.7rem;
    max-width: min(16rem, 60vw);
  }
  .wsmenu > summary::-webkit-details-marker { display: none; }
  .wsmenu > summary::marker { content: ""; }
  .wsmenu .ws-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wsmenu .ws-chevron { flex: none; width: 9px; height: 9px; color: hsl(var(--muted)); transition: transform 140ms ease; }
  .wsmenu[open] > summary { color: hsl(var(--ink)); border-color: hsl(var(--accent) / 0.45); }
  .wsmenu[open] .ws-chevron { transform: rotate(90deg); }
  .wsmenu-panel {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 40;
    min-width: 15rem;
    max-width: calc(100vw - 24px);
    background: hsl(var(--paper));
    border: 1px solid hsl(var(--line));
    border-radius: 12px;
    padding: 0.4rem;
    box-shadow: 0 14px 34px hsl(var(--night) / 0.16), 0 2px 6px hsl(var(--night) / 0.08);
  }
  .wsmenu-panel a {
    display: block;
    padding: 0.45rem 0.55rem;
    border-radius: 7px;
    font-size: 0.92rem;
    color: hsl(var(--ink-soft));
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .wsmenu-panel a[aria-current="true"] { color: hsl(var(--ink)); background: hsl(var(--paper-sunk)); }
  .wsmenu-panel a .mono-id { font-family: var(--font-mono); font-size: 0.72rem; color: hsl(var(--muted)); margin-left: 0.5rem; }
  .wsmenu-sep { height: 1px; background: hsl(var(--line)); margin: 0.35rem 0.3rem; }
  @media (hover: hover) and (pointer: fine) {
    .appnav a:hover { color: hsl(var(--accent)); }
    .wsmenu > summary:hover { color: hsl(var(--accent)); border-color: hsl(var(--accent) / 0.5); }
    .wsmenu-panel a:hover { background: hsl(var(--paper-sunk)); }
  }
  @media (pointer: coarse) {
    .wsmenu-panel a { padding: 0.65rem 0.6rem; }
  }

  /* the scoped page's context line — workspace, id, visibility, settings — above the
     section title, so the page says where you are and then what you are looking at */
  .scope-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.85rem;
    margin: 0 0 0.7rem;
  }
  .scope-row .scope-ws { font-size: 0.95rem; color: hsl(var(--ink)); }
  .scope-row .mono-id { font-family: var(--font-mono); font-size: 0.78rem; color: hsl(var(--muted)); }

  /* the ledger filter — one input, matched against each row's own haystack */
  .filter-row { margin: 1.4rem 0 0; }
  .filter-row .input { max-width: 21rem; }
  tr[hidden] { display: none; }

  /* ---- masthead / nav row ---- */
  .nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: clamp(2.2rem, 6vw, 3.6rem);
  }
  .brand { display: flex; align-items: center; gap: 0.65rem; text-decoration: none; color: inherit; }
  .brand .mark { width: 22px; height: 27px; flex: none; }
  .wordmark {
    font-family: var(--font-display);
    font-weight: 300;
    font-size: 12px;
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
    text-decoration: none;
  }

  /* quiet theme toggle — a bare icon, no pill. Shows the mode in force: sun for
     light, moon for dark, a monitor when the page follows the system. A click
     cycles light → dark → system. */
  .theme-toggle {
    background: none; border: 0; padding: 4px; margin: 0;
    color: hsl(var(--muted));
    cursor: pointer; line-height: 0;
    display: inline-flex; align-items: center;
    border-radius: 4px;
  }
  .theme-toggle svg { display: none; }
  :root[data-theme-mode="light"] .theme-toggle .tt-sun { display: block; }
  :root[data-theme-mode="dark"] .theme-toggle .tt-moon { display: block; }
  :root[data-theme-mode="system"] .theme-toggle .tt-sys,
  :root:not([data-theme-mode]) .theme-toggle .tt-sys { display: block; }

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
  .h-display .accent { color: hsl(var(--accent)); font-weight: 500; }
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
    /* Eyebrows are where the page's structure lives, so they carry the accent: it is
       the cheapest place to spend it, read before anything else and never body text. */
    color: hsl(var(--accent-soft));
    margin: 0 0 0.9rem;
  }
  .email-tag { font-family: var(--font-mono); font-size: 0.78rem; letter-spacing: 0.02em; color: hsl(var(--muted)); }

  p { margin: 0 0 0.85rem; max-width: 42ch; min-width: 0; }
  .lede { font-size: 1.02rem; line-height: 1.6; max-width: 46ch; margin-top: 1.6rem; }
  .prose { color: hsl(var(--ink-soft)); }
  .prose p { max-width: 48ch; }
  .aside { color: hsl(var(--muted)); font-size: 0.95rem; }

  /* The underline is the accent's first job: ink text, oxblood line. A link that only
     reveals itself on hover is a link nobody without a mouse ever finds. */
  a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; text-decoration-color: hsl(var(--accent) / 0.45); }
  @media (hover: hover) and (pointer: fine) {
    a { transition: color 150ms ease, text-decoration-color 150ms ease; }
    a:hover { color: hsl(var(--accent)); text-decoration-color: hsl(var(--accent)); }
    .nav-action:hover, .brand:hover { color: hsl(var(--accent)); }
    .theme-toggle:hover { color: hsl(var(--accent)); }
    .frame.night a:hover, .frame.night .nav-action:hover { color: hsl(var(--accent)); }
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

  .specimen {
    background: hsl(var(--paper-warm));
    border: 1px solid hsl(var(--line));
    border-radius: 14px;
    padding: 1.1rem 1.2rem 1.2rem;
    box-shadow: 0 1px 2px hsl(var(--night) / 0.05), 0 6px 20px hsl(var(--night) / 0.04);
  }
  .frame.warm .specimen { background: hsl(var(--paper)); }
  pre.cmd {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    line-height: 1.7;
    margin: 0.7rem 0 0;
    padding: 0.85rem 0.95rem;
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    white-space: pre;
    color: hsl(var(--ink));
  }
  pre.cmd .flag { color: hsl(var(--muted)); }
  .specimen-note { font-size: 0.9rem; color: hsl(var(--ink-soft)); max-width: none; margin: 0.85rem 0 0; }

  /* ---- ledger table ---- */
  .ledger {
    background: hsl(var(--paper-warm));
    border: 1px solid hsl(var(--line));
    border-radius: 14px;
    overflow: hidden;
    margin-top: 0.6rem;
    box-shadow: 0 1px 2px hsl(var(--night) / 0.05), 0 6px 20px hsl(var(--night) / 0.04);
  }
  /* On the dark substrate the border does the separating; a shadow only muddies. */
  :root[data-theme="dark"] .ledger, :root[data-theme="dark"] .panel, :root[data-theme="dark"] .specimen { box-shadow: none; }
  .frame.warm .ledger { background: hsl(var(--paper)); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.7rem 1rem; vertical-align: baseline; text-align: left; }
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
  .mono { font-family: var(--font-mono); font-size: 0.82rem; color: hsl(var(--ink-soft)); }
  .slug a { text-decoration: none; font-weight: 500; color: hsl(var(--ink)); }
  @media (hover: hover) and (pointer: fine) { .slug a:hover { color: hsl(var(--accent)); } }
  .history a { margin-right: 0.6rem; color: hsl(var(--muted)); text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .history a:hover { color: hsl(var(--accent)); } }
  .empty { color: hsl(var(--muted)); margin-bottom: 1.4rem; }

  /* ---- footer ---- */
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
    color: hsl(38 12% 62%);
  }
  .frame.night .footer { color: hsl(12 10% 66%); }
  .footer .brand { color: hsl(38 14% 80%); }
  .footer .brand .wordmark { color: hsl(38 14% 80%); }
  .footer .brand .mark { width: 18px; height: 22px; }
  .footer-links { display: flex; flex-wrap: wrap; gap: 0.7rem 1.4rem; }
  .footer a { color: inherit; text-decoration: none; }
  .footer code { font-size: 0.95em; text-transform: none; letter-spacing: 0; }

  .glint { transform-box: fill-box; transform-origin: center; }
  @media (prefers-reduced-motion: no-preference) {
    .glint { animation: glint 5.5s ease-in-out infinite; }
  }
  @keyframes glint {
    0%, 100% { opacity: 0.35; transform: scale(0.82) rotate(0deg); }
    50% { opacity: 1; transform: scale(1.08) rotate(45deg); }
  }

  /* ---- components folded from the mock — the settings/invite/ledger register.
     Buttons, pills, the segmented visibility switch, inputs, panels, the one-time
     reveal box, workspace group heads, table action links, and the void mark.
     Mock-only scaffolding (.mock-tag, anatomy tokens, the screens directory, the
     viewer toggle) is deliberately left behind. ---- */

  /* buttons — quiet mono, bordered; primary borrows the accent */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--ink-soft));
    background: transparent;
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    padding: 0.5rem 0.9rem;
    cursor: pointer;
    text-decoration: none;
  }
  /* The one filled control on any page. Primary means the action the page exists for,
     and it wears the accent as a surface rather than borrowing it as a tint. */
  .btn.primary {
    color: hsl(var(--paper));
    background: hsl(var(--accent));
    border-color: hsl(var(--accent));
  }
  :root[data-theme="dark"] .btn.primary { color: hsl(var(--night)); }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover { color: hsl(var(--accent)); border-color: hsl(var(--accent) / 0.6); }
    .btn.primary:hover { color: hsl(var(--paper)); background: hsl(var(--accent-soft)); border-color: hsl(var(--accent-soft)); }
    :root[data-theme="dark"] .btn.primary:hover { color: hsl(var(--night)); }
  }

  /* pills — state markers in the reference register; .public lights the accent */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    border: 1px solid hsl(var(--line));
    border-radius: 999px;
    padding: 2px 9px;
    vertical-align: middle;
  }
  .pill .bead {
    width: 5px; height: 5px;
    transform: rotate(45deg);
    background: hsl(var(--muted) / 0.5);
  }
  .pill.public .bead { background: hsl(var(--accent)); }
  .pill.public { color: hsl(var(--accent-soft)); border-color: hsl(var(--accent) / 0.3); }

  /* segmented control — the visibility switch */
  .seg { display: inline-flex; border: 1px solid hsl(var(--line)); border-radius: 8px; overflow: hidden; }
  .seg button {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    background: transparent;
    border: 0;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }
  .seg button + button { border-left: 1px solid hsl(var(--line)); }
  .seg button.on {
    color: hsl(var(--ink));
    background: hsl(var(--paper-sunk));
    box-shadow: inset 0 -2px 0 hsl(var(--accent));
  }

  /* inputs — 16px minimum so iOS doesn't zoom the page on focus */
  .input {
    font-family: var(--font-body);
    font-size: 1rem;
    color: hsl(var(--ink));
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    padding: 0.55rem 0.8rem;
    width: 100%;
    max-width: 24rem;
  }

  /* settings panels — same substrate as .specimen */
  .panel {
    background: hsl(var(--paper-warm));
    border: 1px solid hsl(var(--line));
    border-radius: 14px;
    padding: 1.15rem 1.25rem 1.3rem;
    margin-top: 1.1rem;
    box-shadow: 0 1px 2px hsl(var(--night) / 0.05), 0 6px 20px hsl(var(--night) / 0.04);
  }
  .frame.warm .panel { background: hsl(var(--paper)); }
  .panel .eyebrow { margin-bottom: 0.7rem; }
  .panel-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem; }
  .panel-note { font-size: 0.9rem; color: hsl(var(--ink-soft)); max-width: 52ch; margin: 0.8rem 0 0; }
  .panel-note.dim { color: hsl(var(--muted)); }
  .ledger td.state { color: hsl(var(--muted)); }

  /* one-time reveal — freshly minted key / invite link. Shown once, never again. */
  .reveal {
    border: 1px solid hsl(var(--accent) / 0.35);
    background: hsl(var(--accent) / 0.05);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    margin-top: 0.95rem;
  }
  .reveal pre {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    line-height: 1.6;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    color: hsl(var(--ink));
  }
  .reveal .reveal-note {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: hsl(var(--accent-soft));
    margin: 0.55rem 0 0;
  }

  /* workspace group heads on the grouped ledger */
  .ws-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem 0.85rem;
    margin: 2.4rem 0 0.2rem;
  }
  .ws-head:first-child { margin-top: 0; }
  .ws-head h2 {
    font-family: var(--font-display);
    font-weight: 300;
    font-size: clamp(22px, 3.4vw, 28px);
    letter-spacing: -0.015em;
    margin: 0;
  }
  .ws-head .mono-id { font-family: var(--font-mono); font-size: 0.78rem; color: hsl(var(--muted)); }
  .ws-head .spacer { flex: 1; }
  /* The name is the way into the workspace's own view; it reads as a heading and
     declares itself a link on hover rather than wearing an underline at rest. */
  .ws-head h2 a { text-decoration: none; color: inherit; }
  @media (hover: hover) and (pointer: fine) { .ws-head h2 a:hover { color: hsl(var(--accent)); } }

  /* table action links (roll / revoke) */
  .act { font-family: var(--font-mono); font-size: 0.78rem; white-space: nowrap; }
  .act form { display: inline; }
  .act button {
    background: none; border: 0; padding: 0; margin-right: 0.7rem;
    font: inherit; color: hsl(var(--muted)); cursor: pointer;
  }
  @media (hover: hover) and (pointer: fine) { .act button:hover { color: hsl(var(--accent)); } }

  .stack-gap { margin-top: 1.6rem; }

  /* the void — soft-404 */
  .void-mark { width: 74px; height: 90px; margin-bottom: 1.6rem; opacity: 0.85; }
  .void-mark .glint { animation-duration: 9s; }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ---- ledger sections: when a thing landed, and how many landed with it ----
     A ruled mono head over each run of rows, in the same register as .eyebrow, with
     the tally as a small bordered bead of a number. Every section is a <details>, so
     folding is the browser's job and works with no script at all; Older ships closed
     because it is the one that grows without bound. */
  .ledger-section { margin-top: 1.15rem; }
  .ledger-section[hidden] { display: none; }
  .ledger-section > summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    padding: 0.3rem 0 0.55rem;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    list-style: none;
  }
  .ledger-section > summary::-webkit-details-marker { display: none; }
  .ledger-section > summary::marker { content: ""; }
  .section-chevron {
    flex: none; width: 9px; height: 9px;
    transition: transform 140ms ease;
    color: hsl(var(--muted) / 0.8);
  }
  .ledger-section[open] > summary .section-chevron { transform: rotate(90deg); }
  .section-count {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: hsl(var(--muted));
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 999px;
    padding: 1px 7px;
  }
  .section-rule { flex: 1; height: 1px; min-width: 1rem; background: hsl(var(--line)); }

  /* ---- the reviews index's tally ----
     Counts in the site's own register. The GitHub palette is admitted on the review
     page for the status glyph alone, and the bound on that exception is that it does
     not spread — so here the count is a mono numeral and the plain word. */
  .row-sub { display: block; font-size: 11px; color: hsl(var(--muted)); }
  td.status-cell { white-space: nowrap; }
  /* The pull requests a review names, each a way out to GitHub. The tally reads
     underneath: first which, then in what state. */
  .pr-refs { display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; margin-bottom: 0.2rem; }
  .pr-refs a { font-family: var(--font-mono); font-size: 0.78rem; color: hsl(var(--ink-soft)); text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .pr-refs a:hover { color: hsl(var(--accent)); } }
  .tally { display: inline-flex; flex-wrap: wrap; gap: 0.55rem; align-items: baseline; }
  .tally-part { display: inline-flex; gap: 0.3rem; align-items: baseline; }
  .tally-n { font-family: var(--font-mono); font-size: 12px; }
  .tally-w {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase; color: hsl(var(--muted));
  }
  .tally-none { color: hsl(var(--muted)); font-size: 12px; }

  /* ---- the projects ledger and page ----
     Status is a plain word, never a pill: open in ink, done and closed muted, because
     the open work is what the reader came to find. A child row indents its title,
     which is the whole of how nesting is drawn. */
  .status-word { font-size: 12.5px; }
  .status-word.quiet { color: hsl(var(--muted)); }
  tr.row-child td.slug { padding-left: 1.5rem; }
  /* The description is the project's own prose, so it gets a reading measure wider
     than the interface default. */
  .proj-desc { max-width: 65ch; margin: 1.2rem 0 0.4rem; }
  /* The record: authored notes carry a rule and a body; derived events are one muted
     line, unbordered, so the split is visible before a word is read. */
  .trail { max-width: 65ch; }
  .trail-note {
    border-left: 2px solid hsl(var(--line));
    padding: 2px 0 2px 14px;
    margin: 14px 0;
  }
  .trail-meta { margin: 0 0 4px; color: hsl(var(--muted)); font-size: 12.5px; }
  .trail-meta a { color: hsl(var(--accent-soft)); }
  .trail-body > p { margin: 0 0 8px; }
  .trail-body > :last-child { margin-bottom: 0; }
  .trail-event {
    margin: 10px 0;
    color: hsl(var(--muted));
    font-size: 13.5px;
  }
  .trail-event a { color: hsl(var(--muted)); }

  /* ---- tasks on the project page ---- */
  .task-list { display: grid; gap: 6px; margin: 0 0 8px; }
  details.task {
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    background: hsl(var(--paper));
  }
  details.task > summary {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding: 10px 14px; cursor: pointer; list-style: none;
  }
  details.task > summary::-webkit-details-marker { display: none; }
  .task-title { font-weight: 500; }
  .task-body { padding: 0 14px 12px; border-top: 1px solid hsl(var(--line) / 0.6); }
  .task-body > :first-child { margin-top: 10px; }
  .gates { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .gates li { display: flex; gap: 8px; align-items: baseline; }
  .gate-mark { font-family: var(--font-mono); color: hsl(var(--muted)); }
  .gate-mark.met { color: hsl(var(--accent-soft)); }
  .pr-state {
    font-family: var(--font-mono); font-size: 11.5px; color: hsl(var(--muted));
    margin: 0 8px 0 3px;
  }
  .drift {
    margin: 8px 0 0; color: hsl(var(--muted)); font-size: 13.5px; font-style: italic;
  }
  .proj-desc p { max-width: 65ch; }
  .proj-desc ul, .proj-desc ol { margin: 0 0 0.85rem; padding-left: 1.3rem; }
  .proj-desc pre {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .proj-desc code {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: hsl(var(--paper-sunk));
    border: 1px solid hsl(var(--line));
    border-radius: 4px;
    padding: 0 4px;
  }
  .proj-desc pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  .part-of { font-size: 0.9rem; color: hsl(var(--muted)); margin: 0 0 0.35rem; }
  @media (hover: hover) and (pointer: fine) {
    .ledger-section > summary:hover { color: hsl(var(--accent)); }
    .ledger-section > summary:hover .section-chevron { color: hsl(var(--accent)); }
  }

  /* ---- the row's own menu ----
     One button per row; one popover for the page, moved to whichever row asked for it.
     It is positioned fixed rather than absolutely, because .ledger clips its overflow
     to keep its rounded corners and an absolute menu would be cut off by them. */
  th.col-menu, td.row-actions { width: 1%; white-space: nowrap; text-align: right; padding-left: 0; }
  .menu-btn {
    background: none; border: 0; margin: -8px 0; padding: 8px;
    color: hsl(var(--muted)); cursor: pointer; line-height: 0;
    border-radius: 6px;
  }
  .menu-btn[aria-expanded="true"] { color: hsl(var(--accent)); background: hsl(var(--paper-sunk)); }
  @media (hover: hover) and (pointer: fine) { .menu-btn:hover { color: hsl(var(--accent)); } }

  .rowmenu {
    position: fixed;
    z-index: 50;
    width: min(21rem, calc(100vw - 16px));
    /* Never taller than the screen it opens on. The panel scrolls rather than running
       off the bottom, which on a phone is the difference between "Create a share link"
       being reachable and not existing. */
    max-height: min(30rem, calc(100dvh - 24px));
    overflow-y: auto;
    overscroll-behavior: contain;
    background: hsl(var(--paper));
    border: 1px solid hsl(var(--line));
    border-radius: 12px;
    padding: 0.5rem;
    box-shadow: 0 14px 34px hsl(var(--night) / 0.16), 0 2px 6px hsl(var(--night) / 0.08);
  }
  .rowmenu[hidden] { display: none; }
  .rowmenu-title {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: hsl(var(--ink));
    margin: 0.15rem 0.45rem 0.4rem;
    max-width: none;
    overflow-wrap: anywhere;
  }
  .rowmenu-item {
    display: block; width: 100%; text-align: left;
    background: none; border: 0; border-radius: 7px;
    padding: 0.45rem 0.45rem;
    font-family: var(--font-mono); font-size: 0.78rem;
    color: hsl(var(--ink-soft)); text-decoration: none; cursor: pointer;
  }
  .rowmenu-item.accent { color: hsl(var(--accent)); }
  .rowmenu-item:hover, .rowmenu-item:focus-visible { background: hsl(var(--paper-sunk)); }
  .rowmenu-sep { height: 1px; background: hsl(var(--line)); margin: 0.45rem 0.2rem; }
  [data-versions-block][hidden] { display: none; }

  /* the tail of the history, where the History column stops printing it */
  .more-versions {
    background: none; border: 0; padding: 0; margin: 0;
    font: inherit; color: hsl(var(--muted)); cursor: pointer;
  }
  @media (hover: hover) and (pointer: fine) { .more-versions:hover { color: hsl(var(--accent)); } }

  .rowmenu-versions {
    display: flex; flex-wrap: wrap; gap: 0.3rem;
    margin: 0 0.45rem 0.35rem;
    max-height: 7.2rem;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: hsl(var(--line)) transparent;
  }
  .rowmenu-versions::-webkit-scrollbar { width: 6px; }
  .rowmenu-versions::-webkit-scrollbar-thumb { background: hsl(var(--line)); border-radius: 999px; }
  .rowmenu-version {
    font-family: var(--font-mono); font-size: 0.72rem;
    color: hsl(var(--muted)); text-decoration: none;
    border: 1px solid hsl(var(--line)); border-radius: 6px;
    padding: 1px 6px;
  }
  .rowmenu-version.latest { color: hsl(var(--accent-soft)); border-color: hsl(var(--accent) / 0.35); }
  @media (hover: hover) and (pointer: fine) {
    .rowmenu-version:hover { color: hsl(var(--accent)); border-color: hsl(var(--accent) / 0.6); }
  }
  .rowmenu-eyebrow {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.13em;
    text-transform: uppercase; color: hsl(var(--muted));
    margin: 0.15rem 0.45rem 0.35rem; max-width: none;
  }
  .rowmenu-note {
    font-size: 0.76rem; color: hsl(var(--muted));
    margin: 0.15rem 0.45rem 0.4rem; max-width: none;
  }
  .rowmenu-shares { list-style: none; margin: 0 0 0.3rem; padding: 0; }
  .rowmenu-shares li {
    display: flex; align-items: baseline; gap: 0.5rem;
    padding: 0.3rem 0.45rem;
    font-size: 0.78rem;
  }
  .rowmenu-shares .share-label { flex: 1; min-width: 0; overflow-wrap: anywhere; color: hsl(var(--ink-soft)); }
  .rowmenu-shares .share-when { font-family: var(--font-mono); font-size: 0.68rem; color: hsl(var(--muted)); white-space: nowrap; }
  .rowmenu-shares .share-when.share-dead { color: hsl(var(--accent-soft)); }
  .rowmenu-shares button {
    background: none; border: 0; padding: 0; margin: 0;
    font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.06em;
    color: hsl(var(--muted)); cursor: pointer;
  }
  @media (hover: hover) and (pointer: fine) { .rowmenu-shares button:hover { color: hsl(var(--accent)); } }
  .rowmenu .share-fresh { margin: 0.3rem 0.45rem 0.5rem; }
  .rowmenu .share-fresh[hidden] { display: none; }
  .rowmenu .share-url { display: flex; gap: 6px; align-items: stretch; }
  .rowmenu .share-url input {
    flex: 1 1 auto; min-width: 0;
    font-family: var(--font-mono); font-size: 12px;
    padding: 5px 7px; border: 1px solid hsl(var(--line)); border-radius: 6px;
    background: hsl(var(--paper-sunk)); color: hsl(var(--ink));
  }
  .rowmenu .share-url button {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em;
    background: none; border: 1px solid hsl(var(--line)); border-radius: 6px;
    padding: 4px 9px; color: hsl(var(--accent)); cursor: pointer;
  }

  /* ---- the ledger on a phone ----
     The row is five columns wide and the last of them holds the only way to share a
     bundle, so on a narrow screen the table must fit rather than scroll sideways: an
     action you have to swipe to reach is an action nobody finds. History is the column
     that goes, because every version it lists is in the menu the ⋯ opens anyway, and
     the slug is allowed to wrap instead of forcing the row wide. */
  @media (max-width: 640px) {
    th, td { padding: 0.6rem 0.5rem; }
    th.col-history, td.history { display: none; }
    .slug { overflow-wrap: anywhere; }
    .ledger { border-radius: 12px; }

    /* The switcher's panel anchors to the bar rather than its own button: the bar
       wraps at this width and the button can land at the left edge, where a panel
       right-aligned to it hangs off the screen. The bar spans the frame, so its
       right edge is one the panel can actually keep. */
    .appbar { position: relative; }
    .wsmenu { position: static; }

    /* A table this narrow stops being a table: each row becomes a short stack —
       the title on its own line, everything else on one quiet line under it. The
       header row goes with the columns; v2 and a date introduce themselves. */
    table.stack, table.stack tbody { display: block; }
    table.stack thead { display: none; }
    table.stack tr {
      display: grid;
      grid-template-columns: max-content max-content minmax(0, 1fr) max-content;
      column-gap: 0.85rem;
      row-gap: 0.3rem;
      align-items: baseline;
      padding: 0.65rem 0.85rem 0.75rem;
      border-bottom: 1px solid hsl(var(--line) / 0.6);
    }
    table.stack tr:last-child { border-bottom: 0; }
    table.stack tr[hidden] { display: none; }
    table.stack td { display: block; border: 0; padding: 0; min-width: 0; }
    table.stack td.history { display: none; }
    table.stack td.slug { grid-row: 1; grid-column: 1 / -1; }
    /* the bundles row keeps its ⋯ beside the title; the title yields it the corner */
    table.stack tr:has(td.row-actions) td.slug { grid-column: 1 / 4; }
    table.stack td.row-actions { grid-row: 1; grid-column: 4; align-self: start; }
    table.stack td.status-cell { white-space: normal; }
    /* refs and tally share the one meta line instead of stacking */
    table.stack .pr-refs { display: inline-flex; margin: 0 0.6rem 0 0; vertical-align: baseline; }
    table.stack .tally { vertical-align: baseline; }
    /* the padding reset above would flatten the child indent, and the indent is the
       whole of how nesting is drawn, so it is restated at stack width */
    table.stack tr.row-child td.slug { padding-left: 1.1rem; }

    /* The popover becomes a sheet at the bottom of the screen — a thumb reaches it,
       it needs no flipping, and it cannot be pinned into a corner by a row near the
       edge. place() clears its inline left/top on this width so these rules own the
       geometry; see bundlesScript(). */
    .rowmenu {
      left: 8px;
      right: 8px;
      bottom: max(8px, env(safe-area-inset-bottom));
      top: auto;
      width: auto;
      max-height: 82dvh;
      border-radius: 14px;
      padding: 0.6rem 0.5rem;
    }
    /* One scroller, not two: the sheet scrolls, the version list rides along. */
    .rowmenu-versions { max-height: none; overflow: visible; }
  }

  /* ---- what a finger can hit ----
     Keyed on the pointer rather than the width, because a touch screen is a touch
     screen at any size. Everything in the menu is a target here, and the share field
     goes to 16px: below that, iOS zooms the whole page on focus and the reader is left
     somewhere else entirely. */
  @media (pointer: coarse) {
    .menu-btn { padding: 14px 12px; margin: -14px -4px -14px 0; }
    .more-versions { padding: 6px 4px; margin: -6px -2px; }
    .rowmenu-item { padding: 0.7rem 0.55rem; }
    .rowmenu-version { padding: 6px 10px; font-size: 0.78rem; }
    .rowmenu-shares li { padding: 0.55rem 0.5rem; }
    .rowmenu-shares button { padding: 6px 4px; margin: -6px -2px; }
    .rowmenu .share-url input { font-size: 16px; }
    .rowmenu .share-url button { font-size: 13px; padding: 8px 12px; }
    .ledger-section > summary { padding: 0.55rem 0 0.7rem; }
  }
`;
}


// ---- the plan reading surface ----
//
// A plan is a bundle whose kind says "document to read", and these two files are how
// it reads like Seer without giving up the bundle's freedom: the author writes
// semantic HTML and links them; Seer owns the tokens, the type and the theme. They
// are fetched live rather than vendored, so a redesign here restyles every plan ever
// published. Served with a five-minute cache: live is the point, five minutes bounds
// how long a redesign takes to reach an open reader's next load.

/** A standalone stylesheet for a semantic-HTML document in the house style. Both
 *  themes fully defined; system dark works with no script via the media fallback,
 *  and /theme.js upgrades it to follow the app's stored choice. */
// KEEP IN STEP with the token sets in styles(): these are the same paper, ink and
// oxblood values, copied rather than shared because a plan stylesheet must stand
// alone. Drift here silently unstyles every published plan.
export function planCss(): string {
  return `@font-face {
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

:root {
  color-scheme: light;
  --paper: 40 22% 98%;
  --paper-warm: 38 16% 94%;
  --paper-sunk: 40 14% 90%;
  --ink: 30 10% 12%;
  --ink-soft: 30 9% 26%;
  --line: 35 14% 84%;
  --muted: 30 8% 45%;
  --accent: 356 55% 27%;
  --accent-soft: 356 40% 42%;
  --font-display: "Cabinet Grotesk", "Switzer", system-ui, -apple-system, sans-serif;
  --font-body: "Switzer", system-ui, -apple-system, sans-serif;
  --font-mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: 356 24% 11%;
  --paper-warm: 356 28% 8.5%;
  --paper-sunk: 356 32% 6.5%;
  --ink: 20 20% 91%;
  --ink-soft: 16 14% 77%;
  --line: 356 14% 23%;
  --muted: 8 9% 62%;
  --accent: 356 48% 64%;
  --accent-soft: 356 38% 54%;
}
/* No data-theme means no script ran: follow the system. theme.js sets the attribute
   pre-paint, after which the block above and its light default carry the choice. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --paper: 356 24% 11%;
    --paper-warm: 356 28% 8.5%;
    --paper-sunk: 356 32% 6.5%;
    --ink: 20 20% 91%;
    --ink-soft: 16 14% 77%;
    --line: 356 14% 23%;
    --muted: 8 9% 62%;
    --accent: 356 48% 64%;
    --accent-soft: 356 38% 54%;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 48px 24px 96px;
  background: hsl(var(--paper-warm));
  color: hsl(var(--ink));
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
::selection { background: hsl(var(--accent) / 0.22); }
h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 300;
  line-height: 1.15;
  margin: 2.2em 0 0.5em;
}
h1 { font-size: clamp(28px, 6vw, 40px); margin-top: 0; letter-spacing: -0.01em; }
h2 { font-size: 24px; font-weight: 400; }
h3 { font-size: 18px; font-weight: 500; font-family: var(--font-body); }
p, li { color: hsl(var(--ink)); }
p { margin: 0 0 1em; }
ul, ol { margin: 0 0 1em; padding-left: 1.3em; }
li { margin: 0 0 0.35em; }
a { color: hsl(var(--accent-soft)); text-decoration-color: hsl(var(--accent) / 0.4); }
a:hover { color: hsl(var(--accent)); }
code {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: hsl(var(--paper-sunk));
  border: 1px solid hsl(var(--line));
  border-radius: 4px;
  padding: 1px 5px;
}
pre {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.55;
  background: hsl(var(--paper-sunk));
  border: 1px solid hsl(var(--line));
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0 0 1.1em;
}
pre code { background: none; border: 0; padding: 0; font-size: inherit; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1.1em; }
th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid hsl(var(--line)); }
th { font-weight: 500; color: hsl(var(--ink-soft)); }
blockquote {
  margin: 0 0 1em;
  padding: 2px 0 2px 14px;
  border-left: 2px solid hsl(var(--accent) / 0.55);
  color: hsl(var(--ink-soft));
}
hr { border: none; border-top: 1px solid hsl(var(--line)); margin: 2.2em 0; }
img { max-width: 100%; height: auto; }
`;
}

/** The app's three-state theme resolution, for a plan page: the stored choice wins,
 *  its absence follows the system live, and a toggle flipped in the app re-themes an
 *  open plan tab through the storage event. Bundles serve on the app's origin, which
 *  is what makes the shared localStorage key work. */
export function planThemeJs(): string {
  return `(() => {
  const KEY = "seer:theme";
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const resolve = () => {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) {}
    const choice = stored === "dark" || stored === "light" ? stored : null;
    document.documentElement.dataset.theme = choice ?? (mq.matches ? "dark" : "light");
  };
  mq.addEventListener("change", resolve);
  addEventListener("storage", (e) => { if (e.key === KEY || e.key === null) resolve(); });
  resolve();
})();
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

// Pre-paint theme resolution. The stored value is the *choice* — "light" or
// "dark"; no key means "follow the system". data-theme-mode carries the choice
// (it picks the toggle's icon), data-theme the resolved surface every style
// rule keys off. Runs inline in <head> so both land before the first paint.
function themeBootstrap(): string {
  return `(()=>{let t=null;try{t=localStorage.getItem("seer:theme")}catch(e){}const m=t==="dark"||t==="light"?t:"system";const r=document.documentElement;r.dataset.themeMode=m;r.dataset.theme=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m})();`;
}

// A click cycles light → dark → system. "System" is stored as the absence of a
// choice, so the pre-paint resolution above and any page saved before the third
// state existed agree on what it means; while it is in force, an OS preference
// change re-resolves the surface live. One delegated listener covers every
// toggle on the page.
function themeToggleScript(): string {
  return `<script>(()=>{if(window.__seerTT)return;window.__seerTT=1;const r=document.documentElement,mq=matchMedia("(prefers-color-scheme: dark)"),names={light:"Light mode",dark:"Dark mode",system:"System"};const apply=()=>{const m=r.dataset.themeMode||"system";r.dataset.theme=m==="system"?(mq.matches?"dark":"light"):m;document.querySelectorAll("[data-theme-toggle]").forEach(b=>{b.title=names[m];b.setAttribute("aria-label","Theme: "+names[m])})};mq.addEventListener("change",()=>{if((r.dataset.themeMode||"system")==="system")apply()});document.addEventListener("click",e=>{const b=e.target.closest("[data-theme-toggle]");if(!b)return;const o=["light","dark","system"],m=o[(o.indexOf(r.dataset.themeMode)+1)%3];r.dataset.themeMode=m;try{m==="system"?localStorage.removeItem("seer:theme"):localStorage.setItem("seer:theme",m)}catch(x){}apply()});apply()})();</script>`;
}

function themeToggle(): string {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch color theme">
    <svg class="tt-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    <svg class="tt-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
    <svg class="tt-sys" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
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

// ---- the app bar ----
//
// The signed-in masthead, the same on every page behind the session: brand, the two
// sections, the workspace switcher, who you are, the theme toggle. Navigation is
// chrome, so it is one component used everywhere rather than a corner link each page
// improvises for itself.

export interface NavWorkspace {
  id: string;
  name: string;
}

export type NavSection = "bundles" | "reviews" | "projects" | "settings";

export interface NavContext {
  email: string;
  workspaces: NavWorkspace[];
  /** The workspace the page is scoped to, or null for the all-workspaces view. */
  current: NavWorkspace | null;
  section: NavSection;
}

/** Where a section lives, scoped or not. Settings has no all-workspaces page, so its
 *  unscoped answer is the bundles ledger, where every workspace's settings link is. */
function sectionHref(section: NavSection, wsId: string | null): string {
  if (wsId === null) {
    if (section === "reviews") return "/reviews";
    if (section === "projects") return "/projects";
    return "/bundles";
  }
  if (section === "settings") return `/settings/${wsId}`;
  return `/${wsId}/${section}`;
}

export function appBar(nav: NavContext): string {
  const chevron = `<svg class="ws-chevron" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M2.5 1 L6 4 L2.5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const scope = nav.current?.id ?? null;

  const link = (section: NavSection, label: string) =>
    `<a href="${sectionHref(section, scope)}"${nav.section === section ? ` aria-current="page"` : ""}>${label}</a>`;

  // Every row goes to this section's page in that workspace; the switcher moves the
  // scope, never the subject. "All workspaces" is a scope like any other.
  const rows = [
    `<a href="${sectionHref(nav.section, null)}"${scope === null ? ` aria-current="true"` : ""}>All workspaces</a>`,
    `<div class="wsmenu-sep"></div>`,
    ...nav.workspaces.map(
      (w) =>
        `<a href="${sectionHref(nav.section, w.id)}"${w.id === scope ? ` aria-current="true"` : ""}>${escapeHtml(w.name)}<span class="mono-id">${escapeHtml(w.id)}</span></a>`,
    ),
  ];

  return `<nav class="appbar" aria-label="Seer">
    <a class="brand" href="/">
      ${markSvg("mark")}
      <span class="wordmark">Seer</span>
    </a>
    <div class="appnav">
      ${link("bundles", "Bundles")}
      ${link("reviews", "Reviews")}
      ${link("projects", "Projects")}
    </div>
    <span class="bar-spacer"></span>
    <details class="wsmenu">
      <summary aria-label="Switch workspace"><span class="ws-current">${escapeHtml(nav.current?.name ?? "All workspaces")}</span>${chevron}</summary>
      <div class="wsmenu-panel">${rows.join("\n")}</div>
    </details>
    <span class="email-tag">${escapeHtml(nav.email)}</span>
    ${themeToggle()}
  </nav>`;
}

/** The app bar's and the filter's few behaviours, shared by every page that draws
 *  either. Both read correctly without it: the switcher is a <details>, and a page
 *  with no filter box is simply the whole list. */
function appScript(): string {
  return `<script>(()=>{
document.addEventListener("click",(e)=>{
  for(const d of document.querySelectorAll("details.wsmenu[open]")){
    if(!d.contains(e.target))d.open=false;
  }
});
const input=document.querySelector("[data-filter-input]");
if(!input)return;
const apply=()=>{
  const q=input.value.trim().toLowerCase();
  for(const tr of document.querySelectorAll("tr[data-filter]")){
    tr.hidden=!!q&&!tr.dataset.filter.includes(q);
  }
  for(const scope of document.querySelectorAll("[data-filter-hide]")){
    // First touch records how the page loaded, so clearing the filter restores it
    // (the ledger's own script may have hidden an empty section already).
    if(scope.__fh===undefined){scope.__fh=scope.hidden;scope.__fo=scope.open;}
    const hit=!!scope.querySelector("tr[data-filter]:not([hidden])");
    scope.hidden=q?!hit:scope.__fh;
    // A match inside a folded section is invisible, so filtering unfolds; clearing
    // folds back to how the reader had it.
    if("open" in scope)scope.open=q?hit:scope.__fo;
  }
};
input.addEventListener("input",apply);
})();</script>`;
}

/** The one input every ledger filter is: type, rows that do not match disappear. */
function filterRow(placeholder: string): string {
  return `<div class="filter-row"><input class="input" type="search" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" data-filter-input></div>`;
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

/**
 * The front door for an agent. One page that says what this deployment can do and
 * where each capability's own instructions live, because the alternative is a person
 * remembering three URLs and telling their agent the right one.
 *
 * It is also the file a person installs: with the frontmatter it is a skill that takes
 * one argument and fetches the right document. That only works once installed. A
 * document fetched over HTTP is text an agent reads, never a command it runs, so the
 * routing lives in what the installed skill does with the argument rather than in the
 * fetch itself.
 */
export function skillRouter(): string {
  const base = config.baseUrl;
  return `---
name: seer
description: "Publish to Seer: HTML bundles, staged walkthroughs, and Overseer reviews of GitHub pull requests. Takes one argument naming what you want to do."
---

# Seer

Seer holds things a human is meant to look at: HTML bundles, staged walkthroughs, and
Overseer reviews of pull requests. Each capability has its own instructions; this page says which
one you want and where it lives.

You need an API key, \`$SEER_API_KEY\`, which belongs to one workspace and is the same key
for everything below. A human mints it at \`${base}/settings/<workspace>\`.

## Pick one

| you were asked to | fetch |
|---|---|
| publish a page, dashboard, report or small app | \`${base}/bundles/skill.md\` |
| review a pull request, or a stack of them | \`${base}/overseer/agent.md\` |
| publish a pinned staged walkthrough | \`${base}/stage/agent.md\` |
| group work into a project, keep it, or resume one | \`${base}/projects/skill.md\` |

Fetch the one that matches and follow it. Do not guess at an API from this page: each
document carries the exact calls, and they are the current ones.

\`\`\`bash
# whichever fits the request
curl -s ${base}/bundles/skill.md
curl -s ${base}/overseer/agent.md
curl -s ${base}/stage/agent.md
curl -s ${base}/projects/skill.md
\`\`\`

## One thing worth knowing before you route

A pull request review is written by a **fresh sub-agent**, never by you. If you wrote the
change, or watched it get built, you will describe what it was meant to do rather than
what the diff says. \`${base}/overseer/agent.md\` is the document that tells you how to
dispatch one correctly; \`${base}/overseer/skill.md\` is what that sub-agent reads, and
you do not need it yourself.
`;
}

/**
 * The projects instructions, at /projects/skill.md: what a project is, the calls that
 * keep one, and the one-URL resume. Same contract as the bundle document: written for
 * an agent holding this deployment's base URL and a key.
 */
export function projectsSkillDoc(): string {
  const base = config.baseUrl;
  return `# Seer — grouping work into projects as an agent

A project groups the work around one thing being built: the bundles you publish, the
reviews you dispatch, the tasks you work through, and the notes you keep. It lives in Seer, outside any
repo, and persists across sessions — create one when you and the human plan a piece of
work, attach what you produce as you go, and the next session resumes by reading one
URL. Every part is optional except the grouping itself.

You need the same two things as for bundles: this deployment's base URL (\`${base}\`)
and an API key (\`$SEER_API_TOKEN\` below, a \`seer_sk_…\` token). The key belongs to one
workspace and every project it touches lives there.

## The calls

\`\`\`
POST   /api/projects                              create: {slug, title, description?, parent?}
GET    /api/projects                              every project in the key's workspace
GET    /api/projects/<slug>                       everything one project holds, one call
PATCH  /api/projects/<slug>                       any of: title, description, status, parent
PUT    /api/projects/<slug>/bundles/<bundle>      attach a bundle    (DELETE detaches)
PUT    /api/projects/<slug>/reviews/<review>      attach a review    (DELETE detaches)
POST   /api/stages                               publish a staged walkthrough, with optional projects
PUT    /api/bundles/<bundle>?project=<slug>       publish a bundle straight into a project
POST   /api/projects/<slug>/tasks                 create: {title, body?, gates?, prs?}
PATCH  /api/projects/<slug>/tasks/<tsk_id>        any of: title, body, status, gates, prs
POST   /api/projects/<slug>/notes                 append: {body, task?}
GET    /api/projects/<slug>/notes                 the whole record: notes + status events
\`\`\`

\`\`\`bash
# create a project, then publish a bundle into it
curl -s -X POST -H "Authorization: Bearer $SEER_API_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"slug": "calling", "title": "Calling functionality"}' \\
  ${base}/api/projects

curl -s -X PUT --data-binary @bundle.zip \\
  -H "Authorization: Bearer $SEER_API_TOKEN" \\
  "${base}/api/bundles/call-prototype?project=calling"
\`\`\`

## Tasks

A task is a line of work inside a project: a one-line title, an optional
constrained-markdown body, gates, and pull request pointers.

- **Gates** are the conditions the task must pass: \`[{"text": "...", "met": false}]\`,
  at most 8. Author them unmet and flip \`met\` as work proves them. A task cannot be
  set \`done\` while a gate is unmet; the 422 names the gate. Setting \`closed\`
  (stopped without finishing) needs no proof.
- **PR pointers** are \`[{"repo": "owner/name", "number": 123}]\`, at most 16. You write
  the pointer; Seer derives the title and state and keeps them fresh, and a task whose
  pull requests are all merged while it still says open carries a derived drift line.
- **Status** is \`open | done | closed\`. Transitions are recorded by Seer; never
  journal them yourself.
- Gates and prs replace whole on PATCH: send the full array as you want it stored.

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $SEER_API_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"title": "Video pipeline", "gates": [{"text": "loopback works", "met": false}],
       "prs": [{"repo": "threahq/threa", "number": 1730}]}' \\
  ${base}/api/projects/calling/tasks
\`\`\`

## Notes

A note is what you were thinking while you worked, written as you work: a decision, a
dead end, a thing the next session needs to know. Notes are append-only — there is no
edit and no delete, ever; correcting a note means writing another. \`task\` ties a
note to one of the project's tasks (its \`tsk_…\` id); without it the note belongs to
the project itself. The body is constrained markdown, at most 2000 characters.

In the markdown projection, derived status lines (the \`—\` grammar) are meaningful
only inside the Notes section; matching that shape elsewhere in authored text carries
no authority.

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $SEER_API_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"body": "Chose the worker route: the main thread stutters past 2 tracks."}' \\
  ${base}/api/projects/calling/notes
\`\`\`

The project state carries the most recent 20 notes; \`GET
${base}/api/projects/<slug>/notes\` is the full record, every note merged with every
status transition Seer recorded, oldest first. Reading it front to back is reading
the project's history.

A review can also name projects as it publishes: a \`projects\`: \`["calling"]\` field
in the review document attaches the review on landing. A staged walkthrough can name the
same field when it publishes; the project state carries its title and version, but this
slice does not make a stage page link. See ${base}/overseer/skill.md and
${base}/stage/agent.md.

## The fields

- \`slug\`: \`[a-z0-9][a-z0-9-]{0,63}\`, unique per workspace, permanent.
- \`title\`: at most 80 characters.
- \`description\`: constrained markdown — emphasis, inline code, links, lists, fenced
  code. Headings, tables, raw HTML and inline images are refused with a 422 naming the
  construct. Write the short account of what is being pursued and why; the human reads
  it at the top of the project page.
- \`status\`: \`open\`, \`done\` (finished), or \`closed\` (stopped without finishing).
  Transitions are recorded by Seer with their timestamps; you never journal them.
- \`parent\`: another project's slug nests this one under it, one level deep — a parent
  of a parent is refused. \`parent: null\` detaches. Use a sub-project for a strand of
  work with assets of its own; the parent's page rolls its children up.

## Plans

A plan is a bundle of kind \`plan\`: same upload, same versioning (republish to revise,
open readers live-reload), but the pages seat it as a document to read rather than a
thing being hosted. Publish one with \`?kind=plan\` on the FIRST upload — the kind is
immutable after, a later upload naming a different kind is a 409:

\`\`\`bash
curl -s -X PUT --data-binary @plan.zip \\
  -H "Authorization: Bearer $SEER_API_TOKEN" \\
  "${base}/api/bundles/calling-plan?kind=plan&project=calling"
\`\`\`

Write the plan as semantic HTML and link the hosted reading surface, so it follows the
reader's theme (light, dark, system) and the house style without you writing any CSS:

\`\`\`html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The plan's title</title>
  <link rel="stylesheet" href="/plan.css">
  <script src="/theme.js"></script>
</head>
<body>
  <h1>The plan's title</h1>
  <p>Sections, lists, tables, code blocks — plain semantic HTML.</p>
</body>
</html>
\`\`\`

A plan that links neither file is accepted with a warning naming what is missing;
full custom HTML stays legitimate when the plan needs it (figures, interactivity,
its own layout). Anything beyond the skeleton — embedded prototypes, diagrams — is
yours to add; it is still a bundle.

## Resuming

\`GET ${base}/api/projects/<slug>\` returns the whole state in one response: the
description, plans, sub-projects, every attached bundle and review with their URLs. Read it
before continuing work you did not just do. The \`url\` field in every response is the
human page, and it answers this same state as markdown to \`Accept: text/markdown\`, so
you and the human are reading one address.

Attach late rather than never: if you published something before creating the project,
\`PUT /api/projects/<slug>/bundles/<bundle>\` picks it up afterwards. Attachment is
many-to-many — a bundle can belong to several projects — and idempotent, so repeating
an attach is safe and says \`"attached": false\`.
`;
}

export function skillDoc(): string {
  const base = config.baseUrl;
  return `# Seer — publishing HTML bundles as an agent

Seer is a personal preview host for self-contained HTML bundles. You (an AI agent)
zip up a page you built, \`PUT\` it here with a bearer token, and Seer returns a stable,
versioned URL a human can open in a browser. Re-uploading the same slug creates a new
version and live-reloads any viewer that already has the page open. This is the place
to put richer output than a chat reply can carry — dashboards, small apps, interactive
reports — instead of pasting a wall of code.

You need two things, which the human has given you (typically as environment
variables): the base URL of this Seer instance (\`${base}\`) and an API key
(referred to below as \`$API_TOKEN\`). Seer keys look like \`seer_sk_…\`; a human mints
one from a workspace's settings page (\`${base}/settings/<workspace>\`), where it is
shown exactly once. The key belongs to one workspace, so every bundle you upload
with it lands in that workspace — you never name the workspace yourself. A person
who belongs to several workspaces therefore holds one key per workspace: which key
you send is which workspace you publish to. Keep the key secret; it is the only
write credential.

## 1. Build the zip

- The zip must contain a root \`index.html\` (at the top level of the archive, not
  inside a subdirectory). That is what loads at the bundle URL.
- Use **relative** asset paths (\`./style.css\`, \`assets/app.js\`, \`img/logo.png\`).
  Absolute paths like \`/style.css\` will not resolve, because the bundle is served
  under \`/<workspace>/b/<slug>/\`.
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
  "workspace": "ws_…",
  "url": "${base}/ws_…/b/<slug>/",
  "versionUrl": "${base}/ws_…/b/<slug>/v/1/",
  "bytes": 2048,
  "files": 3,
  "hasIndexHtml": true
}
\`\`\`

- \`workspace\` is the \`ws_…\` id your key belongs to; every URL in the response is
  scoped under it. You do not choose it — the key does.
- \`url\` is the **latest** URL: it always shows the newest version and live-reloads.
  Hand this one to the human in most cases.
- \`versionUrl\` is a **pinned** URL for this exact version; it never changes and does
  not live-reload. Use it when you want to reference a specific build permanently.
- Check \`hasIndexHtml\`: if it is \`false\`, you forgot the root \`index.html\` and the
  bundle URL will 404. Re-zip and re-upload.

Error responses are JSON with an \`error\` field. Notable statuses: \`400\` (invalid
slug, empty body, or bad zip), \`401\` (invalid, revoked, or missing key), \`413\` (zip
exceeds the size limit).

## 4. Iterating

Upload the same slug again to publish a new version. Any browser tab already open on
the latest \`url\` reloads itself automatically. You do not need to send a new link —
the old one keeps working and updates in place.

A bundle that is a plan — a document to read rather than a thing to host — is
published with \`?kind=plan\` on its first upload; \`${base}/projects/skill.md\` covers
plans, the hosted reading surface they link, and the projects that group them.

## 5. Listing what is published

\`\`\`sh
curl -H "Authorization: Bearer $API_TOKEN" ${base}/api/bundles
\`\`\`

Returns every bundle in your key's workspace with its full version history (slugs,
versions, sizes, timestamps), each tagged with its \`workspace\` id.

## 6. Images (screenshots in GitHub PRs, and anywhere else)

Besides zipped bundles, Seer hosts single **image files** — the main use is giving a
screenshot a URL you can embed in a GitHub PR, issue, or README, which is otherwise
hard to do programmatically. Upload the raw image bytes (no zip, no multipart) to
\`/api/images/<filename>\`:

\`\`\`sh
curl -X PUT --data-binary @screenshot.png \\
  -H "Authorization: Bearer $API_TOKEN" \\
  ${base}/api/images/screenshot.png
\`\`\`

The filename must match \`[a-z0-9][a-z0-9._-]*\` (max 64 chars) and end in \`.png\`,
\`.jpg\`, \`.jpeg\`, \`.gif\`, \`.webp\`, \`.avif\`, or \`.svg\` — the extension names the
format, and the body is sanity-checked against it.

Seer compresses on upload: orientation is baked in, the longest edge is capped at
2000px, metadata (EXIF, GPS) is stripped, and the image is re-encoded as WebP
(animated GIFs stay animated). When the WebP is no smaller than your original —
tiny icons, already-tight AVIF — the image is re-encoded in its own format
instead, with the same cap and metadata strip. SVGs are the one passthrough,
stored as-is. The response tells you what was stored — note the filename (and
URL) may end \`.webp\` even though you uploaded a \`.png\`:

\`\`\`json
{
  "id": "img_…",
  "filename": "screenshot.webp",
  "workspace": "ws_…",
  "url": "${base}/ws_…/i/img_…/screenshot.webp",
  "markdown": "![screenshot](${base}/ws_…/i/img_…/screenshot.webp)",
  "bytes": 48213,
  "originalBytes": 231970,
  "contentType": "image/webp"
}
\`\`\`

Paste \`markdown\` straight into a PR body. Every upload mints a fresh random
\`img_…\` id, so images are immutable — re-uploading the same filename gives a new
URL, and old URLs keep serving their bytes forever (with long-lived caching).
\`GET /api/images\` lists your key's workspace's images.

Image visibility follows the workspace, like bundles — with one exception:
**GitHub's image proxy (camo) is always served**, so an image embedded in a PR
renders for everyone who can see the PR even when its workspace is private. The
image URL itself contains an unguessable random id, so treat it like a capability
link: private means "only people who have the URL", not "only members".

## Sharing and viewing

Whether a bundle link is openable without signing in depends on its workspace's
visibility. A **public** workspace (the default) serves bundle URLs
(\`/<workspace>/b/<slug>/\`) to anyone with the link — no sign-in. A **private**
workspace serves them only to signed-in members; everyone else gets a generic
Seer 404 that reveals nothing, so a private bundle's title never leaks. The human
sets visibility per workspace on its settings page.

### Share links, which you can mint yourself

There is a third option: a **share link**, one revocable URL that opens one bundle for
someone with no account at all. It is how a bundle in a private workspace reaches an
outsider — a reviewer on a pull request, a client, anyone you cannot add to the
workspace. Your API key mints one, so you do not have to ask a human to do it:

\`\`\`sh
curl -X PUT --data-binary @bundle.zip \\
  -H "Authorization: Bearer $API_TOKEN" \\
  ${base}/api/bundles/<slug>

curl -X POST ${base}/api/shares \\
  -H "Authorization: Bearer $API_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"kind":"bundle","target":"<slug>","label":"why this link exists"}'
\`\`\`

\`\`\`json
{ "id": "shr_…", "kind": "bundle", "target": "<slug>",
  "token": "seer_sh_…", "url": "${base}/s/seer_sh_…", "expiresAt": null }
\`\`\`

- Give the human (or paste into the pull request) the **\`url\`**. That is the thing that
  opens; the bare token is not a URL anyone can use.
- You do not name a workspace — your key already belongs to one, and naming a different
  one is refused.
- \`label\` is free text saying why the link exists ("for the PR", "for Anna"). It is what
  a member sees in the workspace's list of live links, and how they decide what to
  revoke. Write a useful one.
- \`expiresAt\` is optional (epoch ms or ISO 8601). Default is no expiry, because a
  revocable link that surprises its holder by dying is worse than one somebody forgets.
- **The \`url\` is shown exactly once.** Only its hash is stored, so it cannot be looked
  up later. If you lose it, mint another.
- \`GET ${base}/api/shares\` lists your workspace's live links (never their tokens);
  \`DELETE ${base}/api/shares/<id>\` revokes one.

Do not mint a share link when the plain \`url\` would do. A public workspace's bundle URL
already opens for anyone, and a share is a second secret to keep track of. Mint one when
the workspace is private, or when you want a link that can be taken back.

Treat the \`url\` like a password you are allowed to hand over: it is the whole of the
authorisation, so it belongs in the place the recipient will read it and nowhere public.
Seer keeps it out of \`Referer\` headers and out of search engines, but it cannot help
you if you paste it into a public issue.

Hand the \`url\` to whoever should see it, or open it yourself. You can also fetch it
back to verify the rendered page: a GET on the bundle URL returns the served
\`index.html\` (the latest URL has the live-reload script injected before \`</body>\`).

When a bundle link is shared in chat, Seer injects OpenGraph tags into the served
HTML so the link unfurls with your page's \`<title>\`, a description, and a Seer
card image. If you want full control of the preview, ship your own \`og:\` meta
tags in \`index.html\` — Seer leaves pages that declare any \`og:\` or \`twitter:\`
meta untouched.

The write side and the inventory are always private: uploading needs your API key,
and the lists (\`GET /api/bundles\`, \`GET /api/images\`, scoped to your key's
workspace) need it too. Public bundle and image links are the only thing viewable
without a credential.
`;
}

// ---- public landing ----

/**
 * The front page for something that reads rather than looks — served at `/` when the
 * request's Accept header wants markdown more than it wants HTML.
 *
 * It is the same page said plainly, not a redirect to `/skill.md`: an agent that asked
 * what this site is should get an answer to that question, with the pointer to the
 * operating instructions as the last line rather than the whole reply.
 */
export function landingMarkdown(): string {
  const base = config.baseUrl;
  return `# Seer

A private instrument for previewing HTML bundles, and for reading pull requests.

An agent builds a page, zips it, and pushes it here. Seer keeps every version and hands
back a URL that reloads itself the moment a new build lands. Bundles live inside a
workspace, and a workspace can have more than one pair of hands. Pushing a bundle needs a
key and the ledger stays members-only, but public bundle links are public: hand one to
anyone and they can open it, no sign-in.

\`\`\`sh
curl -X PUT --data-binary @bundle.zip \\
  -H "Authorization: Bearer $SEER_API_KEY" \\
  ${base}/api/bundles/your-slug
\`\`\`

Back comes \`/<workspace>/b/your-slug/\`, versioned and live.

## Overseer

The same deployment reads pull requests. Point it at one, or at a stack of them, and it
publishes a page you read instead of the diff: what changed, what it costs, what to look
at closely, every claim one tap from the lines it stands on.

It derives the facts itself, so the file list, the hunks, every line number and every
commit come from GitHub rather than from an agent's memory. The judgment comes from a
sub-agent that did not write the change, because one that did describes what it meant to
do rather than what the diff says. Reviews are private to their workspace.

## Where to go next

| you want | fetch |
|---|---|
| what this deployment does, and which document you need | \`${base}/skill.md\` |
| to publish a page, dashboard, report or small app | \`${base}/bundles/skill.md\` |
| to review a pull request, or a stack of them | \`${base}/overseer/agent.md\` |
| a credential | \`${base}/auth.md\` |
| the API, described | \`${base}/openapi.json\` |
| every skill this site publishes | \`${base}/.well-known/agent-skills/index.json\` |

Source: ${GITHUB_URL}
`;
}

/**
 * WebMCP (webmachinelearning.github.io/webmcp): the two things an agent driving a browser
 * on this page might actually want, offered as tools so it does not have to guess the
 * URLs. Both are plain reads of documents already public at their own addresses, so the
 * tools add reach for an agent inside a page and no reach at all for anyone else.
 *
 * Two spellings of the same API are in the wild — `registerTool` per the current draft and
 * `provideContext` per the earlier one — and which a browser ships is not this page's
 * business, so it offers to both and does nothing at all where neither exists.
 */
function webMcpScript(): string {
  const tools = `[
  {
    name: "seer_get_instructions",
    description: "Fetch Seer's own instructions for agents: what this deployment does and which document to read to publish an HTML bundle or a pull request review.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const r = await fetch("/skill.md", { headers: { accept: "text/markdown" } });
      return { content: [{ type: "text", text: await r.text() }] };
    }
  },
  {
    name: "seer_list_skills",
    description: "List every agent skill this Seer deployment publishes, with the URL and SHA-256 digest of each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const r = await fetch("/.well-known/agent-skills/index.json");
      return { content: [{ type: "text", text: await r.text() }] };
    }
  }
]`;
  return `<script>(()=>{const mc=navigator.modelContext;if(!mc)return;const tools=${tools};
if(typeof mc.registerTool==="function"){for(const t of tools)mc.registerTool(t);}
else if(typeof mc.provideContext==="function"){mc.provideContext({tools});}})();</script>`;
}

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
    "og:image:alt": "Seer — a private instrument for previewing HTML bundles",
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
${head(
  "Seer",
  og,
  // The Link header on this response says the same thing; both are here because a
  // crawler that only parsed the body and an agent that only read the headers should
  // each find the way in.
  `<link rel="alternate" type="text/markdown" href="/skill.md">
<link rel="service-desc" type="application/json" href="/openapi.json">
<link rel="service-doc" type="text/markdown" href="/skill.md">
<link rel="api-catalog" href="/.well-known/api-catalog">`,
)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${navRow(action)}
    <h1 class="h-display">Preview what your <span class="accent">agents</span> build.</h1>
    <p class="subtitle">A private instrument for previewing HTML&nbsp;bundles, and for reading pull&nbsp;requests.</p>
    <div class="prose">
      <p class="lede">An agent builds a page, zips it, and pushes it here. Seer keeps every
      version and hands back a URL that reloads itself the moment a new build lands.</p>
      <p>Bundles live inside a workspace now, and a workspace can have more than one
      pair of hands — invite someone and they mint their own keys. Pushing a bundle
      needs a key and the ledger stays members-only, but public bundle links are still
      public: hand one to anyone and they can open it, no sign-in. No dashboard, no
      product. Just a place for half-finished pages to be looked at.</p>
      <p class="aside">Still a slop site. Now a slop site with guests.</p>
    </div>
  </div>
</div>
<div class="frame grow">
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
<div class="frame warm">
  <div class="shell spine">
    <h2 class="h-section">Overseer</h2>
    <div class="prose">
      <p class="lede">The same deployment reads pull requests. Point it at one, or at a
      stack of them, and it publishes a page you read instead of the diff: what changed,
      what it costs, what to look at closely, every claim one tap from the lines it
      stands on.</p>
      <p>It derives the facts itself, so the file list, the hunks, every line number and
      every commit come from GitHub rather than from an agent's memory. The judgment
      comes from a sub-agent that did not write the change, because one that did
      describes what it meant to do rather than what the diff says. Reviews are private
      to their workspace, and a review of the same pull requests published twice keeps
      its link and shows you what moved between the passes.</p>
    </div>
    <div class="specimen-grid">
      <div class="specimen">
        <p class="eyebrow">To give an agent the ability</p>
        <pre class="cmd scroll-x">curl -s ${escapeHtml(config.baseUrl)}/skill.md</pre>
        <p class="specimen-note">One file, saved as a skill. Then ask it to review a
        pull request. Full instructions at
        <a href="/overseer/agent.md"><code>overseer/agent.md</code></a>.</p>
      </div>
    </div>
  </div>
</div>
<div class="frame night">
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
${webMcpScript()}
</body>
</html>`;
}

// ---- signed-in bundle ledger ----

export interface LedgerBundle {
  slug: string;
  kind: "bundle" | "plan";
  latestVersion: number;
  updatedAt: number; // epoch ms of the newest version's upload
  versions: number[];
}

// ---- when a thing landed ----
//
// The ledger is read by recency far more often than by name, so it is cut into runs of
// recency with a count on each. Five buckets, in one order, always drawn in that order
// whether or not they hold anything: the page is the same shape every time it loads,
// and the browser has somewhere to put a row it re-dates.

export type LedgerBucket = "today" | "yesterday" | "this-week" | "last-week" | "older";

export const LEDGER_BUCKETS: readonly { key: LedgerBucket; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "older", label: "Older" },
];

const DAY_MS = 86_400_000;

/** Whole days since the epoch, in UTC. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * The bucket a day falls in, relative to today — pure day arithmetic, so the caller
 * decides which timezone the two day numbers were counted in.
 *
 * A day in the future (a clock askew, or a machine ahead of this one) reads as today
 * rather than as its own category: it is a rounding error, not a fact about the bundle.
 *
 * KEEP IN STEP with the five lines of the same rule in `bundlesScript()`. The server
 * sections the page in UTC so a scriptless reader still gets a sectioned ledger, and
 * the browser re-sections it in the reader's own timezone on load. They must agree, or
 * a row would visibly jump for a reader whose clock already agreed with the server's.
 */
export function bucketFor(day: number, today: number): LedgerBucket {
  if (day >= today) return "today";
  if (day === today - 1) return "yesterday";
  // Weeks start Monday. Epoch day 0 was a Thursday, so (day + 3) % 7 is 0 on Mondays.
  const weekStart = today - ((today + 3) % 7);
  if (day >= weekStart) return "this-week";
  if (day >= weekStart - 7) return "last-week";
  return "older";
}

// The ledger is grouped by the session user's workspaces: one group head per
// workspace (name, ws_ id, visibility pill, settings link) over that workspace's
// own bundle table. Bundle URLs are workspace-scoped.
export interface LedgerGroup {
  wsId: string;
  name: string;
  visibility: "public" | "private";
  bundles: LedgerBundle[];
}

/** How many versions the History column prints inline before the rest go behind the
 *  row's menu. Five is about where the column stops being a glance and starts being a
 *  paragraph. */
export const HISTORY_SHOWN = 5;

/** `YYYY-MM-DD HH:MM` in UTC — what a scriptless reader sees, and what the browser
 *  rewrites into the reader's own timezone on load. */
function fmtInstant(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** `now` is a parameter rather than a call so the sectioning is testable and so every
 *  group on one render is cut against the same instant. Scoped or not is read off
 *  `nav.current`: the caller passes the one group a scoped page holds. */
export function bundlesPage(nav: NavContext, groups: LedgerGroup[], now = Date.now()): string {
  const scoped = nav.current !== null;
  const title = scoped ? `Bundles · ${nav.current!.name} · Seer` : "Bundles · Seer";
  const og = { "og:title": title, "og:type": "website", robots: "noindex" };

  const today = utcDay(now);
  const bundleUrl = (wsId: string, slug: string) => `/${wsId}/b/${encodeURIComponent(slug)}/`;

  const chevron = `<svg class="section-chevron" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M2.5 1 L6 4 L2.5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const dots = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="8" cy="13" r="1.35"/></svg>`;

  const row = (g: LedgerGroup, b: LedgerBundle) => {
    const url = bundleUrl(g.wsId, b.slug);
    // The recent few inline, the rest behind the row's menu. A bundle pushed forty
    // times used to print forty links and make its row the widest thing on the page;
    // the tail is worth keeping, not worth reading at a glance. The overflow travels
    // as a list of numbers rather than as more markup, which is smaller than the links
    // it replaces even before the menu builds them back.
    const shown = b.versions.slice(0, HISTORY_SHOWN);
    const rest = b.versions.length - shown.length;
    const history =
      shown.map((v) => `<a href="${url}v/${v}/">v${v}</a>`).join("") +
      (rest > 0
        ? `<button type="button" class="more-versions" data-menu-more` +
          ` aria-label="All ${b.versions.length} versions of ${escapeHtml(b.slug)}">+${rest}</button>`
        : "");
    return `<tr data-at="${b.updatedAt}" data-filter="${escapeHtml(`${b.slug} ${b.kind === "plan" ? "plan" : ""}`.trim().toLowerCase())}">
          <td class="slug"><a href="${url}">${escapeHtml(b.slug)}</a></td>
          <td class="mono">v${b.latestVersion}</td>
          <td class="mono"><time datetime="${new Date(b.updatedAt).toISOString()}">${fmtInstant(b.updatedAt)}</time></td>
          <td class="history mono">${history}</td>
          <td class="row-actions"><button type="button" class="menu-btn" data-menu-open
            aria-haspopup="true" aria-expanded="false"
            aria-label="Actions for ${escapeHtml(b.slug)}"
            data-ws="${escapeHtml(g.wsId)}" data-slug="${escapeHtml(b.slug)}" data-url="${url}"
            data-versions="${b.versions.join(",")}">${dots}</button></td>
        </tr>`;
  };

  // Every bucket is drawn, empty ones hidden rather than omitted: the browser re-dates
  // rows in local time on load and needs somewhere to move them to. Only plain
  // bundles ride the buckets: plans are few and are documents, so they sit in one
  // flat section above, outside the re-dating group.
  const section = (g: LedgerGroup, bucket: (typeof LEDGER_BUCKETS)[number], held0: LedgerBundle[]) => {
    const held = held0.filter((b) => bucketFor(utcDay(b.updatedAt), today) === bucket.key);
    const open = bucket.key === "older" ? "" : " open";
    const hidden = held.length === 0 ? " hidden" : "";
    return `<details class="ledger-section" data-section="${bucket.key}" data-filter-hide${open}${hidden}>
      <summary>${chevron}<span>${bucket.label}</span><span class="section-count" data-section-count>${held.length}</span><span class="section-rule"></span></summary>
      <div class="ledger scroll-x">
        <table class="stack">
          <thead><tr><th>Bundle</th><th>Latest</th><th>Updated</th><th class="col-history">History</th><th class="col-menu"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody data-section-rows>
          ${held.map((b) => row(g, b)).join("\n")}
          </tbody>
        </table>
      </div>
    </details>`;
  };

  const groupBlock = (g: LedgerGroup, withHead: boolean) => {
    // The scoped page carries the workspace in its own masthead, so the group head
    // would say the same thing twice; the all view keeps it, with the name as the way
    // into the workspace's own view.
    const pill = `<span class="pill${g.visibility === "public" ? " public" : ""}"><span class="bead"></span>${g.visibility}</span>`;
    const head = withHead
      ? `<div class="ws-head">
      <h2><a href="/${g.wsId}/bundles">${escapeHtml(g.name)}</a></h2>
      <span class="mono-id">${escapeHtml(g.wsId)}</span>
      ${pill}
      <span class="spacer"></span>
      <a class="nav-action" href="/settings/${g.wsId}">settings</a>
    </div>`
      : "";

    if (g.bundles.length === 0) {
      return `<div data-filter-hide>${head}
      <p class="empty">No bundles here yet.</p></div>`;
    }

    // Plans first, one flat section: a workspace holds few, and they are documents
    // to read rather than uploads to date. They stay outside the re-dating group so
    // the browser's local-time pass never moves them.
    const plans = g.bundles.filter((b) => b.kind === "plan");
    const rest = g.bundles.filter((b) => b.kind !== "plan");
    const plansBlock =
      plans.length === 0
        ? ""
        : `<details class="ledger-section" data-plans data-filter-hide open>
      <summary>${chevron}<span>Plans</span><span class="section-count">${plans.length}</span><span class="section-rule"></span></summary>
      <div class="ledger scroll-x">
        <table class="stack">
          <thead><tr><th>Plan</th><th>Latest</th><th>Updated</th><th class="col-history">History</th><th class="col-menu"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
          ${plans.map((b) => row(g, b)).join("\n")}
          </tbody>
        </table>
      </div>
    </details>`;

    const bucketed =
      rest.length === 0
        ? ""
        : `<div data-ledger-group>
      ${LEDGER_BUCKETS.map((bucket) => section(g, bucket, rest)).join("\n")}
    </div>`;

    return `<div data-filter-hide>${head}
    ${plansBlock}
    ${bucketed}</div>`;
  };

  const body =
    groups.length === 0
      ? `<p class="empty">No workspaces yet.</p>`
      : groups.map((g) => groupBlock(g, !scoped)).join("\n");

  // A member can always spin up another estate. Public by default; visibility is
  // its own settings toggle. Only the all-workspaces view offers it: a scoped page is
  // one estate's, and creating another is not something done from inside one.
  const newWorkspace = scoped
    ? ""
    : `<form class="panel-row stack-gap" id="new-workspace" method="post" action="/workspaces">
      <input class="input" type="text" name="name" placeholder="new workspace name" maxlength="80" aria-label="New workspace name">
      <button class="btn primary" type="submit">New workspace</button>
    </form>`;

  // One popover for the page rather than one per row: it is moved to whichever row
  // asked for it, so a ledger of five hundred bundles carries one menu's worth of DOM.
  const rowMenu = `<div class="rowmenu" data-rowmenu hidden role="menu" aria-label="Bundle actions">
    <p class="rowmenu-title" data-menu-title></p>
    <a class="rowmenu-item" role="menuitem" data-menu-open-link href="/">Open the latest</a>
    <button class="rowmenu-item" type="button" role="menuitem" data-menu-copy>Copy its link</button>
    <div data-versions-block>
      <div class="rowmenu-sep"></div>
      <p class="rowmenu-eyebrow">Every version <span class="section-count" data-versions-count></span></p>
      <div class="rowmenu-versions" data-versions-list></div>
    </div>
    <div class="rowmenu-sep"></div>
    <p class="rowmenu-eyebrow">Share links</p>
    <ul class="rowmenu-shares" data-share-list></ul>
    <p class="rowmenu-note" data-share-empty>No link opens this one yet.</p>
    <div class="share-fresh" data-share-fresh hidden>
      <div class="share-url">
        <input type="text" readonly data-share-url aria-label="The new share link">
        <button type="button" data-share-copy>copy</button>
      </div>
      <p class="rowmenu-note">Copy it now. Links are stored hashed, so this one cannot be shown again.</p>
    </div>
    <button class="rowmenu-item accent" type="button" role="menuitem" data-share-new>Create a share link</button>
  </div>`;

  // Scoped, the page says where you are and then what you are looking at: the
  // workspace as the context line, the section as the title. Without both, the
  // scoped bundles and reviews pages are the same masthead with different tables.
  const masthead = scoped
    ? `<div class="scope-row">
      <span class="scope-ws">${escapeHtml(nav.current!.name)}</span>
      <span class="mono-id">${escapeHtml(nav.current!.id)}</span>
      <span class="pill${groups[0]?.visibility === "public" ? " public" : ""}"><span class="bead"></span>${groups[0]?.visibility ?? "private"}</span>
      <a class="nav-action" href="/settings/${escapeHtml(nav.current!.id)}">settings</a>
    </div>
    <h1 class="h-section">Bundles</h1>`
    : `<h1 class="h-section">Bundles</h1>
    <p class="subtitle">Everything Seer is holding, workspace by workspace.</p>`;

  return `<!doctype html>
<html lang="en">
${head(title, og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${appBar(nav)}
    ${masthead}
    ${filterRow("Filter bundles")}
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">
    ${body}
    ${newWorkspace}
    ${
      scoped
        ? ""
        : `<p class="aside stack-gap">You appear here for every workspace you're a member of. Each group is
    its own little estate — its visibility rides on its sleeve, its settings one click away.
    A share link opens one bundle for someone who is in none of them, and it can be taken back.</p>`
    }
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/">back to the front</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${rowMenu}
${themeToggleScript()}
${appScript()}
<script>${bundlesScript()}</script>
</body>
</html>`;
}

// ---- the reviews index ----
//
// The ledger beside the bundles ledger, in the same visual language: one group per
// workspace, one table of rows, the same mono stamps. It is the only way a published
// review is reachable without already holding its URL.

/** One review as the index lists it. Counts, not words: the page decides how a tally
 *  reads, and the caller has already asked the database what the rows say. */
export interface LedgerReview {
  slug: string;
  title: string;
  latestVersion: number;
  publishedAt: number;
  /** The pull requests the review names, from `review_prs` — what a reader searching
   *  "where was repo#123 reviewed" is actually searching by. */
  prs: { repo: string; number: number }[];
  tally: { merged: number; closed: number; draft: number; open: number; unknown: number; total: number };
}

export interface ReviewLedgerGroup {
  wsId: string;
  name: string;
  visibility: "public" | "private";
  reviews: LedgerReview[];
}

/**
 * The tally, in words rather than in GitHub's colours.
 *
 * The status glyph's palette is admitted on the review page on one ground — that those
 * colours are quoted from GitHub rather than authored by Seer — and the bound on that
 * exception is that it appears only in the glyph. So the index counts in the site's own
 * register: mono numerals and the plain word.
 *
 * A review with pull requests but no observation of any of them says "not checked yet"
 * rather than counting five unknowns, because that is the sentence a reader wants, and
 * a review naming no pull requests at all says nothing.
 */
function tallyCell(t: LedgerReview["tally"]): string {
  if (t.total === 0) return `<span class="tally-none">&mdash;</span>`;
  if (t.unknown === t.total) return `<span class="tally-none">not checked yet</span>`;
  const parts: string[] = [];
  for (const word of ["merged", "open", "draft", "closed", "unknown"] as const) {
    const n = t[word];
    if (n === 0) continue;
    parts.push(
      `<span class="tally-part"><span class="tally-n">${n}</span>` +
        `<span class="tally-w">${word === "unknown" ? "unchecked" : word}</span></span>`,
    );
  }
  return `<span class="tally">${parts.join("")}</span>`;
}

export function reviewsPage(nav: NavContext, groups: ReviewLedgerGroup[]): string {
  const scoped = nav.current !== null;
  const title = scoped ? `Reviews · ${nav.current!.name} · Seer` : "Reviews · Seer";
  const og = { "og:title": title, "og:type": "website", robots: "noindex" };

  const row = (g: ReviewLedgerGroup, r: LedgerReview) => {
    const url = `/${g.wsId}/r/${encodeURIComponent(r.slug)}/`;
    // `owner/repo#12` and `repo#12` are both in the haystack, so the filter answers the
    // question however the reader spells it.
    const haystack = [
      r.title,
      r.slug,
      ...r.prs.flatMap((p) => [`${p.repo}#${p.number}`, `${p.repo.split("/")[1] ?? p.repo}#${p.number}`]),
    ]
      .join(" ")
      .toLowerCase();
    const refs =
      r.prs.length === 0
        ? ""
        : `<span class="pr-refs">${r.prs
            .map(
              (p) =>
                `<a href="https://github.com/${escapeHtml(p.repo)}/pull/${p.number}" title="${escapeHtml(p.repo)}#${p.number}">${escapeHtml(p.repo.split("/")[1] ?? p.repo)}#${p.number}</a>`,
            )
            .join("")}</span>`;
    return `<tr data-filter="${escapeHtml(haystack)}">
          <td class="slug"><a href="${url}">${escapeHtml(r.title)}</a>
            <span class="row-sub mono">${escapeHtml(r.slug)}</span></td>
          <td class="mono">v${r.latestVersion}</td>
          <td class="mono"><time datetime="${new Date(r.publishedAt).toISOString()}">${fmtInstant(r.publishedAt)}</time></td>
          <td class="status-cell">${refs}${tallyCell(r.tally)}</td>
        </tr>`;
  };

  const groupBlock = (g: ReviewLedgerGroup, withHead: boolean) => {
    const pill = `<span class="pill${g.visibility === "public" ? " public" : ""}"><span class="bead"></span>${g.visibility}</span>`;
    const head = withHead
      ? `<div class="ws-head">
      <h2><a href="/${g.wsId}/reviews">${escapeHtml(g.name)}</a></h2>
      <span class="mono-id">${escapeHtml(g.wsId)}</span>
      ${pill}
      <span class="spacer"></span>
      <a class="nav-action" href="/settings/${g.wsId}">settings</a>
    </div>`
      : "";

    if (g.reviews.length === 0) {
      return `<div data-filter-hide>${head}
      <p class="empty">No reviews here yet.</p></div>`;
    }

    return `<div data-filter-hide>${head}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>Review</th><th>Latest</th><th>Published</th><th>Pull requests</th></tr></thead>
        <tbody>
        ${g.reviews.map((r) => row(g, r)).join("\n")}
        </tbody>
      </table>
    </div></div>`;
  };

  const body =
    groups.length === 0
      ? `<p class="empty">No workspaces yet.</p>`
      : groups.map((g) => groupBlock(g, !scoped)).join("\n");

  // Same grammar as the bundles page: where you are, then what you are looking at.
  const masthead = scoped
    ? `<div class="scope-row">
      <span class="scope-ws">${escapeHtml(nav.current!.name)}</span>
      <span class="mono-id">${escapeHtml(nav.current!.id)}</span>
      <span class="pill${groups[0]?.visibility === "public" ? " public" : ""}"><span class="bead"></span>${groups[0]?.visibility ?? "private"}</span>
      <a class="nav-action" href="/settings/${escapeHtml(nav.current!.id)}">settings</a>
    </div>
    <h1 class="h-section">Reviews</h1>`
    : `<h1 class="h-section">Reviews</h1>
    <p class="subtitle">Every review published here, newest first, workspace by workspace.</p>`;

  return `<!doctype html>
<html lang="en">
${head(title, og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${appBar(nav)}
    ${masthead}
    ${filterRow("Filter by title or repo#123")}
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">
    ${body}
    <p class="aside stack-gap">The pull request counts are what Seer was last told, by the
    publish that seeded them and the webhooks that have arrived since. Nothing on this page
    asks GitHub anything — a review whose count reads <em>not checked yet</em> is one no
    observation has landed for, which is a different thing from one with nothing to say.</p>
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/bundles">bundles</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
${appScript()}
</body>
</html>`;
}

// ---- the projects ledger and page ----
//
// A project groups the work: bundles, reviews, sub-projects. The ledger reads like the
// reviews index; the project page is the human end of the same state the API returns
// in one call, and the markdown projection below it IS that page for an agent.

export type ProjectStatusWord = "open" | "done" | "closed";

export interface ProjectLedgerRow {
  slug: string;
  title: string;
  status: ProjectStatusWord;
  updatedAt: number;
  bundles: number;
  reviews: number;
  tasks: number;
  /** One level deep; a child's own children is always empty. */
  children: ProjectLedgerRow[];
}

export interface ProjectLedgerGroup {
  wsId: string;
  name: string;
  visibility: "public" | "private";
  projects: ProjectLedgerRow[];
}

/** Open in ink, done and closed muted: the open work is what the reader came for. */
function statusWord(status: ProjectStatusWord): string {
  return `<span class="status-word${status === "open" ? "" : " quiet"}">${status}</span>`;
}

/** What a project holds, in the tally grammar. Zero parts are skipped; nothing at all
 *  is a quiet dash rather than three zeros. */
function holdsCell(bundles: number, reviews: number, children: number, tasks = 0): string {
  const parts: string[] = [];
  const part = (n: number, one: string, many: string) => {
    if (n === 0) return;
    parts.push(
      `<span class="tally-part"><span class="tally-n">${n}</span>` +
        `<span class="tally-w">${n === 1 ? one : many}</span></span>`,
    );
  };
  part(tasks, "task", "tasks");
  part(bundles, "bundle", "bundles");
  part(reviews, "review", "reviews");
  part(children, "sub-project", "sub-projects");
  if (parts.length === 0) return `<span class="tally-none">&mdash;</span>`;
  return `<span class="tally">${parts.join("")}</span>`;
}

export function projectsPage(nav: NavContext, groups: ProjectLedgerGroup[]): string {
  const scoped = nav.current !== null;
  const title = scoped ? `Projects · ${nav.current!.name} · Seer` : "Projects · Seer";
  const og = { "og:title": title, "og:type": "website", robots: "noindex" };

  const row = (g: ProjectLedgerGroup, p: ProjectLedgerRow, parent: ProjectLedgerRow | null) => {
    const url = `/${g.wsId}/p/${encodeURIComponent(p.slug)}`;
    // A child's haystack carries its parent's slug, so filtering by the parent keeps
    // the family together on screen.
    const haystack = [p.title, p.slug, ...(parent ? [parent.slug] : []), ...p.children.map((c) => c.slug)]
      .join(" ")
      .toLowerCase();
    return `<tr${parent ? ` class="row-child"` : ""} data-filter="${escapeHtml(haystack)}">
          <td class="slug"><a href="${url}">${escapeHtml(p.title)}</a>
            <span class="row-sub mono">${escapeHtml(p.slug)}</span></td>
          <td>${statusWord(p.status)}</td>
          <td class="mono"><time datetime="${new Date(p.updatedAt).toISOString()}">${fmtInstant(p.updatedAt)}</time></td>
          <td class="status-cell">${holdsCell(p.bundles, p.reviews, p.children.length, p.tasks)}</td>
        </tr>`;
  };

  const groupBlock = (g: ProjectLedgerGroup, withHead: boolean) => {
    const pill = `<span class="pill${g.visibility === "public" ? " public" : ""}"><span class="bead"></span>${g.visibility}</span>`;
    const head = withHead
      ? `<div class="ws-head">
      <h2><a href="/${g.wsId}/projects">${escapeHtml(g.name)}</a></h2>
      <span class="mono-id">${escapeHtml(g.wsId)}</span>
      ${pill}
      <span class="spacer"></span>
      <a class="nav-action" href="/settings/${g.wsId}">settings</a>
    </div>`
      : "";

    if (g.projects.length === 0) {
      return `<div data-filter-hide>${head}
      <p class="empty">No projects here yet.</p></div>`;
    }

    return `<div data-filter-hide>${head}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>Project</th><th>Status</th><th>Updated</th><th>Holds</th></tr></thead>
        <tbody>
        ${g.projects.flatMap((p) => [row(g, p, null), ...p.children.map((c) => row(g, c, p))]).join("\n")}
        </tbody>
      </table>
    </div></div>`;
  };

  const body =
    groups.length === 0
      ? `<p class="empty">No workspaces yet.</p>`
      : groups.map((g) => groupBlock(g, !scoped)).join("\n");

  const masthead = scoped
    ? `<div class="scope-row">
      <span class="scope-ws">${escapeHtml(nav.current!.name)}</span>
      <span class="mono-id">${escapeHtml(nav.current!.id)}</span>
      <span class="pill${groups[0]?.visibility === "public" ? " public" : ""}"><span class="bead"></span>${groups[0]?.visibility ?? "private"}</span>
      <a class="nav-action" href="/settings/${escapeHtml(nav.current!.id)}">settings</a>
    </div>
    <h1 class="h-section">Projects</h1>`
    : `<h1 class="h-section">Projects</h1>
    <p class="subtitle">The work being pursued, workspace by workspace.</p>`;

  return `<!doctype html>
<html lang="en">
${head(title, og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${appBar(nav)}
    ${masthead}
    ${filterRow("Filter projects")}
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">
    ${body}
    <p class="aside stack-gap">A project is created and kept by an agent through the API;
    this page is the reading end. Sub-projects sit under their parent, and the counts say
    what each holds.</p>
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/bundles">bundles</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
${appScript()}
</body>
</html>`;
}

export interface ProjectPageData {
  nav: NavContext;
  wsId: string;
  slug: string;
  title: string;
  status: ProjectStatusWord;
  updatedAt: number;
  parent: { slug: string; title: string } | null;
  /** The authored markdown, verbatim — the markdown projection serves it back. */
  description: string;
  /** The same field rendered to HTML by the server; "" renders nothing. */
  descriptionHtml: string;
  children: { slug: string; title: string; status: ProjectStatusWord; bundles: number; reviews: number; tasks: number }[];
  /** Derived views plus the body rendered by the server; reading order is the list order. */
  tasks: (TaskView & { bodyHtml: string })[];
  plans: { slug: string; latestVersion: number; updatedAt: number; url: string }[];
  bundles: { slug: string; latestVersion: number; updatedAt: number; url: string }[];
  reviews: { slug: string; title: string; latestVersion: number; publishedAt: number; url: string }[];
  /** Stages are carried for the API and markdown projection. The human row waits for task 3's page URL. */
  stages?: { slug: string; title: string; latestVersion: number; updatedAt: number; apiUrl: string }[];
  /** The bounded tail of the record: authored notes (body rendered by the server)
   *  interleaved with derived status events, oldest first. */
  trail: (
    | {
        kind: "note";
        id: string;
        task: string | null;
        taskTitle: string | null;
        body: string;
        bodyHtml: string;
        author: string | null;
        createdAt: number;
      }
    | {
        kind: "event";
        task: string | null;
        taskTitle: string | null;
        from: string;
        to: string;
        createdAt: number;
      }
  )[];
  /** Every note the project holds; the trail carries at most the tail of them. */
  noteCount: number;
  /** Authors matter only when there is more than one member to tell apart. */
  showAuthors: boolean;
}

export function projectPage(d: ProjectPageData): string {
  const title = `${d.title} · ${d.nav.current?.name ?? "Seer"} · Seer`;
  const og = { "og:title": title, "og:type": "website", robots: "noindex" };

  const sectionHead = (label: string) => `<div class="ws-head"><h2>${escapeHtml(label)}</h2></div>`;

  const childrenSection =
    d.children.length === 0
      ? ""
      : `${sectionHead("Sub-projects")}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>Project</th><th>Status</th><th>Holds</th></tr></thead>
        <tbody>
        ${d.children
          .map(
            (c) => `<tr data-filter="${escapeHtml(`${c.title} ${c.slug}`.toLowerCase())}">
          <td class="slug"><a href="/${d.wsId}/p/${encodeURIComponent(c.slug)}">${escapeHtml(c.title)}</a>
            <span class="row-sub mono">${escapeHtml(c.slug)}</span></td>
          <td>${statusWord(c.status)}</td>
          <td class="status-cell">${holdsCell(c.bundles, c.reviews, 0, c.tasks)}</td>
        </tr>`,
          )
          .join("\n")}
        </tbody>
      </table>
    </div>`;

  const planRows = (rows: ProjectPageData["plans"], label: string) => `${sectionHead(label)}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>${escapeHtml(label === "Plans" ? "Plan" : label)}</th><th>Latest</th><th>Updated</th></tr></thead>
        <tbody>
        ${rows
          .map(
            (b) => `<tr data-filter="${escapeHtml(`${b.slug} plan`.toLowerCase())}">
          <td class="slug"><a href="${b.url}">${escapeHtml(b.slug)}</a></td>
          <td class="mono">v${b.latestVersion}</td>
          <td class="mono"><time datetime="${new Date(b.updatedAt).toISOString()}">${fmtInstant(b.updatedAt)}</time></td>
        </tr>`,
          )
          .join("\n")}
        </tbody>
      </table>
    </div>`;

  const plansSection = d.plans.length === 0 ? "" : planRows(d.plans, "Plans");

  // One task, one disclosure row: the summary is the glance (status, title, gate
  // tally, PR refs with their derived state words), the body is the opt-in (the
  // authored markdown, the gate list, the drift line when the facts disagree with
  // the status).
  const gateMark = (met: boolean) =>
    `<span class="gate-mark${met ? " met" : ""}" aria-hidden="true">${met ? "\u2713" : "\u25cb"}</span>`;
  const taskRow = (t: ProjectPageData["tasks"][number]) => {
    const met = t.gates.filter((g) => g.met).length;
    const gatesTally =
      t.gates.length === 0
        ? ""
        : `<span class="tally-part"><span class="tally-n">${met}/${t.gates.length}</span><span class="tally-w">gates</span></span>`;
    const refs =
      t.prs.length === 0
        ? ""
        : `<span class="pr-refs">${t.prs
            .map(
              (pr) =>
                `<a href="${pr.url}" title="${escapeHtml(pr.title ?? `${pr.repo}#${pr.number}`)}">` +
                `${escapeHtml(pr.repo.split("/")[1] ?? pr.repo)}#${pr.number}</a>` +
                `<span class="pr-state">${pr.state}</span>`,
            )
            .join("")}</span>`;
    const gateList =
      t.gates.length === 0
        ? ""
        : `<ul class="gates">${t.gates
            .map((g) => `<li>${gateMark(g.met)}${escapeHtml(g.text)}</li>`)
            .join("")}</ul>`;
    const drift = t.drift ? `<p class="drift">${escapeHtml(t.drift)}</p>` : "";
    const body = t.bodyHtml || gateList || drift;
    return `<details class="task" id="${t.id}" data-filter="${escapeHtml(`${t.title} ${t.prs.map((pr) => `${pr.repo}#${pr.number}`).join(" ")}`.toLowerCase())}">
      <summary>${statusWord(t.status)}<span class="task-title">${escapeHtml(t.title)}</span>${gatesTally}${refs}</summary>
      ${body ? `<div class="task-body">${t.bodyHtml}${gateList}${drift}</div>` : ""}
    </details>`;
  };
  const tasksSection =
    d.tasks.length === 0
      ? ""
      : `${sectionHead("Tasks")}
    <div class="task-list">
    ${d.tasks.map(taskRow).join("\n")}
    </div>`;

  const bundlesSection =
    d.bundles.length === 0
      ? ""
      : `${sectionHead("Bundles")}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>Bundle</th><th>Latest</th><th>Updated</th></tr></thead>
        <tbody>
        ${d.bundles
          .map(
            (b) => `<tr data-filter="${escapeHtml(b.slug.toLowerCase())}">
          <td class="slug"><a href="${b.url}">${escapeHtml(b.slug)}</a></td>
          <td class="mono">v${b.latestVersion}</td>
          <td class="mono"><time datetime="${new Date(b.updatedAt).toISOString()}">${fmtInstant(b.updatedAt)}</time></td>
        </tr>`,
          )
          .join("\n")}
        </tbody>
      </table>
    </div>`;

  const reviewsSection =
    d.reviews.length === 0
      ? ""
      : `${sectionHead("Reviews")}
    <div class="ledger scroll-x">
      <table class="stack">
        <thead><tr><th>Review</th><th>Latest</th><th>Published</th></tr></thead>
        <tbody>
        ${d.reviews
          .map(
            (r) => `<tr data-filter="${escapeHtml(`${r.title} ${r.slug}`.toLowerCase())}">
          <td class="slug"><a href="${r.url}">${escapeHtml(r.title)}</a>
            <span class="row-sub mono">${escapeHtml(r.slug)}</span></td>
          <td class="mono">v${r.latestVersion}</td>
          <td class="mono"><time datetime="${new Date(r.publishedAt).toISOString()}">${fmtInstant(r.publishedAt)}</time></td>
        </tr>`,
          )
          .join("\n")}
        </tbody>
      </table>
    </div>`;

  // The record, drawn as the split it is: notes are authored and carry a body;
  // events are derived, muted, and read as one line nobody wrote.
  const trailEntry = (e: ProjectPageData["trail"][number]) => {
    const when = `<time class="mono-id" datetime="${new Date(e.createdAt).toISOString()}">${fmtInstant(e.createdAt)}</time>`;
    if (e.kind === "event") {
      const subject = e.taskTitle
        ? `<a href="#${escapeHtml(e.task ?? "")}">${escapeHtml(e.taskTitle)}</a>`
        : "";
      return `<p class="trail-event">${when} ${subject}${subject ? " " : ""}${escapeHtml(e.from)} &rarr; ${escapeHtml(e.to)}</p>`;
    }
    const taskRef = e.taskTitle
      ? ` &middot; <a href="#${escapeHtml(e.task ?? "")}">${escapeHtml(e.taskTitle)}</a>`
      : "";
    const author = d.showAuthors && e.author ? ` &middot; ${escapeHtml(e.author)}` : "";
    return `<div class="trail-note">
      <p class="trail-meta">${when}${taskRef}${author}</p>
      <div class="trail-body">${e.bodyHtml}</div>
    </div>`;
  };
  const withheld = d.noteCount - d.trail.filter((e) => e.kind === "note").length;
  const notesSection =
    d.trail.length === 0
      ? ""
      : `${sectionHead("Notes")}
    <div class="trail">
    ${d.trail.map(trailEntry).join("\n")}
    ${withheld > 0 ? `<p class="trail-event">${withheld} earlier ${withheld === 1 ? "note" : "notes"} not shown</p>` : ""}
    </div>`;

  const empty =
    d.children.length === 0 &&
    d.tasks.length === 0 &&
    d.plans.length === 0 &&
    d.bundles.length === 0 &&
    d.reviews.length === 0 &&
    d.trail.length === 0
      ? `<p class="empty">Nothing here yet. Attach bundles and reviews, create tasks, or create sub-projects.</p>`
      : "";

  const partOf = d.parent
    ? `<p class="part-of">Part of <a href="/${d.wsId}/p/${encodeURIComponent(d.parent.slug)}">${escapeHtml(d.parent.title)}</a></p>`
    : "";

  return `<!doctype html>
<html lang="en">
${head(title, og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${appBar(d.nav)}
    <div class="scope-row">
      <span class="scope-ws">${escapeHtml(d.nav.current?.name ?? "")}</span>
      <span class="mono-id">${escapeHtml(d.wsId)}</span>
      <span class="spacer"></span>
      <a class="nav-action" href="/${d.wsId}/projects">All projects</a>
    </div>
    ${partOf}
    <h1 class="h-section">${escapeHtml(d.title)}</h1>
    <p class="part-of"><span class="mono-id">${escapeHtml(d.slug)}</span> · ${statusWord(d.status)} ·
      <time class="mono-id" datetime="${new Date(d.updatedAt).toISOString()}">${fmtInstant(d.updatedAt)}</time></p>
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">
    ${d.descriptionHtml ? `<div class="proj-desc">${d.descriptionHtml}</div>` : ""}
    ${plansSection}
    ${childrenSection}
    ${tasksSection}
    ${bundlesSection}
    ${reviewsSection}
    ${notesSection}
    ${empty}
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/projects">projects</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
${appScript()}
<script>(()=>{
// A note's task link lands on a <details> row; scrolling to a closed row shows a
// summary line and nothing else, so the anchor opens what it points at.
const open=()=>{const el=location.hash&&document.getElementById(location.hash.slice(1));if(el&&el.tagName==="DETAILS")el.open=true};
addEventListener("hashchange",open);open();
})();</script>
</body>
</html>`;
}

/**
 * The same page, for a caller that would rather have markdown: the agent's re-entry
 * point at the human URL. The description is authored markdown and passes through
 * verbatim; everything else is a projection of the same state the HTML drew.
 */
export function projectMarkdown(d: ProjectPageData): string {
  const base = config.baseUrl;
  const lines: string[] = [
    `# ${d.title}`,
    ``,
    `- status: ${d.status}`,
    `- slug: ${d.slug}, workspace: ${d.wsId}`,
    ...(d.parent ? [`- parent: ${d.parent.slug}`] : []),
    `- updated: ${new Date(d.updatedAt).toISOString()}`,
  ];
  if (d.description.trim() !== "") lines.push("", d.description.trim());
  if (d.plans.length > 0) {
    lines.push("", "## Plans", "");
    for (const b of d.plans) lines.push(`- ${b.slug} v${b.latestVersion}: ${b.url}`);
  }
  if (d.tasks.length > 0) {
    lines.push("", "## Tasks", "");
    for (const t of d.tasks) {
      const refs = t.prs
        .map((pr) => `${pr.repo}#${pr.number} (${pr.state})`)
        .join(", ");
      lines.push(`- ${t.title} (${t.id}), ${t.status}${refs ? `; ${refs}` : ""}${t.drift ? `; drift: ${t.drift}` : ""}`);
      for (const g of t.gates) lines.push(`  - [${g.met ? "x" : " "}] ${g.text}`);
    }
  }
  if (d.children.length > 0) {
    lines.push("", "## Sub-projects", "");
    for (const c of d.children) lines.push(`- ${c.title} (${c.slug}), ${c.status}`);
  }
  if (d.bundles.length > 0) {
    lines.push("", "## Bundles", "");
    for (const b of d.bundles) lines.push(`- ${b.slug} v${b.latestVersion}: ${b.url}`);
  }
  if (d.reviews.length > 0) {
    lines.push("", "## Reviews", "");
    for (const r of d.reviews) lines.push(`- ${r.title} (${r.slug}) v${r.latestVersion}: ${r.url}`);
  }
  if ((d.stages ?? []).length > 0) {
    lines.push("", "## Stages", "");
    for (const s of d.stages ?? []) lines.push(`- ${s.title} (${s.slug}) v${s.latestVersion}`);
  }
  if (d.trail.length > 0) {
    lines.push("", "## Notes", "");
    for (const e of d.trail) {
      const iso = new Date(e.createdAt).toISOString();
      if (e.kind === "event") {
        lines.push(`\u2014 ${e.taskTitle ?? "project"}: ${e.from} \u2192 ${e.to} (${iso})`);
        continue;
      }
      const taskBit = e.taskTitle ? ` (${e.taskTitle})` : "";
      const [first, ...rest] = e.body.split("\n");
      lines.push(`- ${iso}${taskBit}: ${first ?? ""}`);
      for (const line of rest) lines.push(`  ${line}`);
    }
    const withheldNotes = d.noteCount - d.trail.filter((e) => e.kind === "note").length;
    if (withheldNotes > 0) {
      lines.push(
        "",
        `The full record (${d.noteCount} notes and every status event): ` +
          `\`GET ${base}/api/projects/${d.slug}/notes\``,
      );
    }
  }
  lines.push(
    "",
    `Read or write this project via the API: \`GET ${base}/api/projects/${d.slug}\` with a`,
    `bearer key returns this state as JSON; \`${base}/skill.md\` routes to the full API.`,
    "",
  );
  return lines.join("\n");
}

/**
 * The ledger's two pieces of behaviour, both of which the page reads correctly without.
 *
 * First: re-dating. The server sectioned the page in UTC, which is the same timezone it
 * prints every other timestamp in, and is wrong about "today" for anyone who works past
 * their own midnight. So on load the browser recounts the days in its own timezone,
 * moves rows to the section they actually belong in, redraws the counts, and rewrites
 * each stamp as local time. Rows are re-appended in one descending pass, so each body
 * ends up ordered however many of them moved and whichever way the offset ran.
 *
 * Second: the row menu, which is where a bundle is shared. Minting is the only thing
 * here that cannot be undone by reloading, and the only thing that ever shows a token:
 * the store keeps a hash, so a link this menu does not show now can never be shown
 * again. That is why the fresh link is its own row and why the list never pretends to
 * hold one.
 */
function bundlesScript(): string {
  return `
(() => {
  const DAY = 86400000;
  // The same rule as bucketFor() in src/pages.ts — keep the two in step.
  const bucket = (day, today) => {
    if (day >= today) return 'today';
    if (day === today - 1) return 'yesterday';
    const week = today - ((today + 3) % 7);
    if (day >= week) return 'this-week';
    if (day >= week - 7) return 'last-week';
    return 'older';
  };
  const localDay = (ms) => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / DAY);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  // Plan rows sit outside the re-dating groups on purpose (they never move between
  // buckets), but their stamps still owe the reader local time: one column, one clock.
  for (const row of document.querySelectorAll('[data-plans] tr[data-at]')) {
    const time = row.querySelector('time');
    if (time) time.textContent = stamp(Number(row.dataset.at));
  }

  const today = localDay(Date.now());
  for (const group of document.querySelectorAll('[data-ledger-group]')) {
    const rows = [...group.querySelectorAll('tr[data-at]')]
      .sort((a, b) => Number(b.dataset.at) - Number(a.dataset.at));
    for (const row of rows) {
      const at = Number(row.dataset.at);
      const time = row.querySelector('time');
      if (time) time.textContent = stamp(at);
      const body = group.querySelector('[data-section="' + bucket(localDay(at), today) + '"] [data-section-rows]');
      // Always append, never skip: appending in one descending pass is what keeps every
      // body sorted, whichever direction the timezone moved rows in.
      if (body) body.append(row);
    }
    for (const section of group.querySelectorAll('[data-section]')) {
      const held = section.querySelectorAll('tr[data-at]').length;
      section.hidden = held === 0;
      section.querySelector('[data-section-count]').textContent = String(held);
    }
  }
})();

(() => {
  const menu = document.querySelector('[data-rowmenu]');
  if (!menu) return;
  const title = menu.querySelector('[data-menu-title]');
  const openLink = menu.querySelector('[data-menu-open-link]');
  const list = menu.querySelector('[data-share-list]');
  const empty = menu.querySelector('[data-share-empty]');
  const fresh = menu.querySelector('[data-share-fresh]');
  const field = menu.querySelector('[data-share-url]');
  const versionsBlock = menu.querySelector('[data-versions-block]');
  const versionsList = menu.querySelector('[data-versions-list]');
  const versionsCount = menu.querySelector('[data-versions-count]');
  // anchor is the row's own button, which is what the menu is filled from and
  // positioned against; opener is whatever was actually clicked, which is where focus
  // goes back to on Escape. They differ when the menu was opened from a "+N".
  let anchor = null;
  let opener = null;

  const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // On a narrow screen the menu is a sheet pinned to the bottom by CSS, so the only
  // thing to do is get out of the way: inline left/top would outrank the media query.
  const asSheet = () => window.matchMedia('(max-width: 640px)').matches;

  function place() {
    if (!anchor) return;
    if (asSheet()) {
      menu.style.left = '';
      menu.style.top = '';
      return;
    }
    const at = anchor.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.right - box.width, window.innerWidth - box.width - 8));
    const below = at.bottom + 6;
    const top = below + box.height > window.innerHeight - 8
      ? Math.max(8, at.top - box.height - 6)
      : below;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function close(refocus) {
    if (!anchor) return;
    const was = anchor, from = opener || anchor;
    anchor = null;
    opener = null;
    menu.hidden = true;
    was.setAttribute('aria-expanded', 'false');
    if (refocus) from.focus();
  }

  // The whole history, which the row prints only the head of. Built here rather than
  // shipped as markup on every row: the numbers are what travel, and one bundle's worth
  // of links exists at a time.
  function fillVersions() {
    const held = (anchor.dataset.versions || '').split(',').filter(Boolean);
    versionsBlock.hidden = held.length === 0;
    versionsCount.textContent = String(held.length);
    versionsList.textContent = '';
    for (const v of held) {
      const link = document.createElement('a');
      link.className = 'rowmenu-version';
      link.href = anchor.dataset.url + 'v/' + v + '/';
      link.textContent = 'v' + v;
      if (v === held[0]) {
        link.classList.add('latest');
        link.title = 'the newest version';
      }
      versionsList.append(link);
    }
  }

  async function load() {
    if (!anchor) return;
    const ws = anchor.dataset.ws, slug = anchor.dataset.slug;
    let shares = [];
    try {
      const res = await fetch('/api/shares?workspace=' + encodeURIComponent(ws), { headers: { accept: 'application/json' } });
      if (res.ok) shares = (await res.json()).shares.filter((s) => s.kind === 'bundle' && s.target === slug);
    } catch (e) { /* an offline menu shows no links rather than a wrong count */ }
    // The menu may have moved on while that was in flight.
    if (!anchor || anchor.dataset.ws !== ws || anchor.dataset.slug !== slug) return;
    list.textContent = '';
    empty.hidden = shares.length > 0;
    for (const s of shares) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'share-label';
      label.textContent = s.label || 'unlabelled link';
      const made = document.createElement('span');
      made.className = 'share-when';
      // An expired link is still listed, because it is still revocable and still a thing
      // that was handed out; it is said to be dead rather than drawn as live.
      const dead = s.expiresAt !== null && new Date(s.expiresAt).getTime() <= Date.now();
      made.textContent = when(s.createdAt) + (s.expiresAt ? (dead ? ' · expired ' : ' · until ') + when(s.expiresAt) : '');
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
    place();
  }

  async function copyInto(button, text, done) {
    try { await navigator.clipboard.writeText(text); button.textContent = done; }
    catch (e) { button.textContent = 'press ⌘C'; }
    setTimeout(() => { button.textContent = button.dataset.label; }, 1600);
  }
  for (const b of menu.querySelectorAll('[data-menu-copy],[data-share-copy]')) b.dataset.label = b.textContent;

  // Two ways into the same menu: the row's own button, and the "+N" standing in for the
  // versions the History column did not print. The second opens the first's menu, so
  // there is one panel and one place that knows how to fill it.
  function triggerFor(target) {
    const own = target.closest('[data-menu-open]');
    if (own) return own;
    const more = target.closest('[data-menu-more]');
    return more ? more.closest('tr').querySelector('[data-menu-open]') : null;
  }

  document.addEventListener('click', (ev) => {
    const button = triggerFor(ev.target);
    if (button) {
      const again = anchor === button;
      close(false);
      if (again) return;
      anchor = button;
      opener = ev.target.closest('[data-menu-open],[data-menu-more]');
      button.setAttribute('aria-expanded', 'true');
      title.textContent = button.dataset.slug;
      openLink.href = button.dataset.url;
      fresh.hidden = true;
      field.value = '';
      list.textContent = '';
      empty.hidden = false;
      fillVersions();
      menu.hidden = false;
      place();
      load();
      return;
    }
    if (!menu.hidden && !ev.target.closest('[data-rowmenu]')) close(false);
  });

  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(true); });
  // Rather than chase the anchor: a menu positioned against a row that has scrolled
  // away is worse than no menu. Scrolling INSIDE the menu is the exception and has to
  // be one — this listener captures, so without it the first swipe down a long version
  // list would close the thing being read.
  window.addEventListener('scroll', (ev) => {
    const within = ev.target instanceof Element && ev.target.closest('[data-rowmenu]');
    if (!within) close(false);
  }, true);
  window.addEventListener('resize', () => close(false));

  menu.querySelector('[data-menu-copy]').addEventListener('click', (ev) => {
    if (!anchor) return;
    copyInto(ev.currentTarget, location.origin + anchor.dataset.url, 'Copied');
  });

  menu.querySelector('[data-share-copy]').addEventListener('click', (ev) => {
    field.select();
    copyInto(ev.currentTarget, field.value, 'copied');
  });

  menu.querySelector('[data-share-new]').addEventListener('click', async (ev) => {
    if (!anchor) return;
    const button = ev.currentTarget;
    const ws = anchor.dataset.ws, slug = anchor.dataset.slug;
    button.disabled = true;
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: ws, kind: 'bundle', target: slug, label: slug }),
      });
      if (!res.ok) { field.value = 'Could not create a link (' + res.status + ')'; fresh.hidden = false; place(); return; }
      field.value = (await res.json()).url;
      fresh.hidden = false;
      place();
      field.focus();
      field.select();
      await load();
    } finally { button.disabled = false; }
  });
})();
`;
}

// ---- workspace settings ----
//
// Members-only. Rename, visibility, members + invite mint, and the session user's
// own keys (mint/roll/revoke). A reveal box — the invite URL or a freshly minted
// key token — is rendered ONLY on the response to the minting POST, never on a
// later load: only the token's hash survives in the db. Step 5 folds the mock's
// component CSS (.panel/.input/.seg/.reveal/.pill/.act) into styles().

export interface SettingsMember {
  email: string;
  id: string;
  joined: string;
  isYou: boolean;
}
export interface SettingsKey {
  id: string;
  name: string;
  hint: string;
  created: string;
  lastUsed: string;
  isLegacy: boolean;
}
/** One share as the settings page shows it. There is no token here and there is no
 *  field that could carry one: only the hash survived the mint. */
export interface SettingsShare {
  id: string;
  label: string;
  kind: string;
  target: string;
  created: string;
  expires: string;
  isExpired: boolean;
}
export type SettingsReveal =
  | { kind: "key"; token: string }
  | { kind: "invite"; url: string; expires: string };

/** One GitHub App installation this workspace holds. Nothing here is a secret: an
 *  installation id is a small public integer, and no token was ever stored to leak. */
export interface SettingsCredential {
  id: string;
  label: string;
  account: string;
  kind: "oauth" | "pat";
  lastUsed: string;
  /** GitHub refused this credential. What the person does about it depends on why, so
   *  the two are separate facts rather than one word: an expired credential is replaced,
   *  a revoked one is granted again at GitHub. */
  isDead: boolean;
  isExpired: boolean;
}

export interface SettingsInstallation {
  id: string;
  installationId: number;
  account: string;
  accountType: string;
  repositorySelection: string;
  connected: string;
  isSuspended: boolean;
  /** When a delivery from this installation last arrived, in words — "never" when none
   *  ever has. Delivery health is the whole reason this panel is worth reading: with
   *  polling deleted, an installation that stopped talking is a page frozen at its last
   *  observation, and nothing else anywhere would say so. */
  lastDelivery: string;
  /** True when that is long enough ago to be worth a word rather than a date. */
  isQuiet: boolean;
}

export interface SettingsData {
  nav: NavContext;
  wsId: string;
  name: string;
  visibility: "public" | "private";
  email: string;
  members: SettingsMember[];
  keys: SettingsKey[];
  shares: SettingsShare[];
  credentials: SettingsCredential[];
  installations: SettingsInstallation[];
  /** Where to install the app on a fresh account. Never absent: config.ts requires the
   *  App variables at boot, so there is no deployment without an app to install. */
  githubInstallUrl: string;
  /** Whether the user OAuth application is configured. False on a deployment that never
   *  registered one, where pasting a token is the only way to add a credential. */
  githubUserOAuthEnabled: boolean;
  reveal?: SettingsReveal;
}

export function settingsPage(d: SettingsData): string {
  const og = { "og:title": `Settings · ${d.name} · Seer`, "og:type": "website", robots: "noindex" };
  const s = (base: string) => `/settings/${d.wsId}${base}`;

  const memberRows = d.members
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.email)}${m.isYou ? ` <span class="pill">you</span>` : ""}</td>
        <td class="mono">${escapeHtml(m.id)}</td>
        <td class="mono">${escapeHtml(m.joined)}</td>
      </tr>`,
    )
    .join("\n");

  const keyRows =
    d.keys.length === 0
      ? `<tr><td colspan="5" class="empty">No keys yet — mint one to upload.</td></tr>`
      : d.keys
          .map(
            (k) => `<tr>
        <td>${escapeHtml(k.name)}${k.isLegacy ? ` <span class="pill">legacy</span>` : ""}</td>
        <td class="mono">${escapeHtml(k.hint)}</td>
        <td class="mono">${escapeHtml(k.created)}</td>
        <td class="mono">${escapeHtml(k.lastUsed)}</td>
        <td class="act">
          <form method="post" action="${s(`/keys/${k.id}/roll`)}"><button type="submit">roll</button></form>
          <form method="post" action="${s(`/keys/${k.id}/revoke`)}"><button type="submit">revoke</button></form>
        </td>
      </tr>`,
          )
          .join("\n");

  const shareRows =
    d.shares.length === 0
      ? `<tr><td colspan="6" class="empty">Nothing shared yet.</td></tr>`
      : d.shares
          .map(
            (sh) => `<tr>
        <td>${escapeHtml(sh.label)}</td>
        <td class="mono">${escapeHtml(sh.kind)}</td>
        <td class="mono">${escapeHtml(sh.target)}</td>
        <td class="mono">${escapeHtml(sh.created)}</td>
        <td class="mono">${escapeHtml(sh.expires)}${sh.isExpired ? ` <span class="pill">expired</span>` : ""}</td>
        <td class="act">
          <form method="post" action="${s(`/shares/${sh.id}/revoke`)}"><button type="submit">revoke</button></form>
        </td>
      </tr>`,
          )
          .join("\n");

  const credentialRows =
    d.credentials.length === 0
      ? `<tr><td colspan="6" class="empty">No personal GitHub credentials yet.</td></tr>`
      : d.credentials
          .map(
            (credential) => `<tr>
        <td>${escapeHtml(credential.label)}</td>
        <td>${escapeHtml(credential.account)}</td>
        <td class="mono">${escapeHtml(credential.kind)}</td>
        <td class="mono">${escapeHtml(credential.lastUsed)}</td>
        <td class="state">${
          credential.isExpired ? "expired" : credential.isDead ? "revoked at GitHub — reconnect" : ""
        }</td>
        <td class="act"><form method="post" action="${s(`/github/credentials/${credential.id}/revoke`)}"><button type="submit">revoke</button></form></td>
      </tr>`,
          )
          .join("\n");

  const installRows =
    d.installations.length === 0
      ? `<tr><td colspan="6" class="empty">No GitHub account connected yet.</td></tr>`
      : d.installations
          .map(
            (g) => `<tr>
        <td>${escapeHtml(g.account)}${g.isSuspended ? ` <span class="pill">suspended</span>` : ""}</td>
        <td class="mono">${escapeHtml(g.accountType)}</td>
        <td class="mono">${escapeHtml(g.repositorySelection)}</td>
        <td class="mono">${escapeHtml(g.connected)}</td>
        <td class="mono">${escapeHtml(g.lastDelivery)}${
          g.isQuiet ? ` <span class="pill">no recent deliveries</span>` : ""
        }</td>
        <td class="act">
          <form method="post" action="${s(`/github/${g.id}/disconnect`)}"><button type="submit">disconnect</button></form>
        </td>
      </tr>`,
          )
          .join("\n");

  const inviteReveal =
    d.reveal?.kind === "invite"
      ? `<div class="reveal">
          <pre>${escapeHtml(d.reveal.url)}</pre>
          <p class="reveal-note">single use · expires ${escapeHtml(d.reveal.expires)} · send it however you like</p>
        </div>`
      : "";

  const keyReveal =
    d.reveal?.kind === "key"
      ? `<div class="reveal">
          <pre>${escapeHtml(d.reveal.token)}</pre>
          <p class="reveal-note">shown once — copy it now; only its hash survives</p>
        </div>`
      : "";

  const seg = (v: "public" | "private", label: string) =>
    `<button type="submit" name="visibility" value="${v}"${d.visibility === v ? ` class="on"` : ""}>${label}</button>`;

  return `<!doctype html>
<html lang="en">
${head(`Settings · ${d.name} · Seer`, og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${appBar(d.nav)}
    <p class="eyebrow"><span class="email-tag">${escapeHtml(d.wsId)} · workspace</span></p>
    <h1 class="h-section">${escapeHtml(d.name)}</h1>
    <p class="subtitle">Settings, members, and your keys.</p>
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">

    <div class="panel">
      <p class="eyebrow">Name</p>
      <form class="panel-row" method="post" action="${s("/name")}">
        <input class="input" type="text" name="name" value="${escapeHtml(d.name)}" maxlength="80" aria-label="Workspace name">
        <button class="btn" type="submit">Save</button>
      </form>
      <p class="panel-note dim">Shown on invites and the ledger. The <code>ws_</code> id never changes.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">Visibility</p>
      <form class="panel-row" method="post" action="${s("/visibility")}">
        <div class="seg" role="group" aria-label="Workspace visibility">
          ${seg("public", "Public")}
          ${seg("private", "Private")}
        </div>
        <span class="pill${d.visibility === "public" ? " public" : ""}"><span class="bead"></span>${d.visibility}</span>
      </form>
      <p class="panel-note">Private: bundle links only resolve for signed-in members. Everyone else
      gets the polite 404, and shared links unfurl as a plain Seer card — titles never leak.</p>
      <p class="panel-note dim">Public: anyone with a link can open it. The ledger stays members-only either way.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">Members</p>
      <div class="ledger scroll-x">
        <table>
          <tr><th>Member</th><th>User</th><th>Joined</th></tr>
          ${memberRows}
        </table>
      </div>
      <form class="panel-row stack-gap" method="post" action="${s("/invites")}">
        <button class="btn primary" type="submit">Invite someone</button>
      </form>
      ${inviteReveal}
      <p class="panel-note dim">Every member is equal — anyone can invite, anyone can change settings.
      Levels and permissions are a later problem.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">Your keys</p>
      <div class="ledger scroll-x">
        <table>
          <tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr>
          ${keyRows}
        </table>
      </div>
      <form class="panel-row stack-gap" method="post" action="${s("/keys")}">
        <input class="input" type="text" name="name" placeholder="key name" maxlength="80" aria-label="New key name">
        <button class="btn primary" type="submit">Mint a new key</button>
      </form>
      ${keyReveal}
      <p class="panel-note dim">Keys are yours alone: each member mints and rolls their own.
      <em>Roll</em> mints a replacement and revokes this one in the same breath. Uploads made with a
      key land in this workspace and are attributed to you.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">GitHub</p>
      <div class="ledger scroll-x">
        <table>
          <tr><th>Account</th><th>Kind</th><th>Repositories</th><th>Connected</th><th>Last delivery</th><th></th></tr>
          ${installRows}
        </table>
      </div>
      <form class="panel-row stack-gap" method="post" action="${s("/github/connect")}">
        <button class="btn primary" type="submit">Connect a GitHub account</button>
      </form>
      <p class="panel-note">Connecting sends you to GitHub and back. Seer asks GitHub which
      installations <em>you</em> can reach, and only those can be connected here — naming an
      installation id is not enough, and never was.</p>
      <p class="panel-note dim">Not installed on that account yet? <a href="${escapeHtml(d.githubInstallUrl)}" rel="noreferrer">Install the app first</a>, then come back and connect it.</p>
      <p class="panel-note dim">Nothing polls GitHub any more: a review's status is as true as
      the last delivery that touched it. <em>Last delivery</em> is how you can see the net is
      still there — an installation that has been quiet for a week, or is suspended, is one whose
      reviews have quietly stopped moving.</p>
      <p class="panel-note dim">Disconnecting keeps the record and releases the installation,
      so the same account can be connected again later — here or anywhere.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">Your GitHub credentials</p>
      <div class="ledger scroll-x">
        <table>
          <tr><th>Label</th><th>Account</th><th>Kind</th><th>Last used</th><th></th><th></th></tr>
          ${credentialRows}
        </table>
      </div>
      ${
        d.githubUserOAuthEnabled
          ? `<form class="panel-row" method="post" action="/github/account/connect">
        <button class="btn" type="submit">Connect GitHub account</button>
      </form>`
          : ""
      }
      <form class="panel-row stack-gap" method="post" action="${s("/github/credentials")}">
        <input class="input" type="text" name="label" placeholder="label (for example, work)" maxlength="80" aria-label="Credential label">
        <input class="input" type="password" name="token" placeholder="github_pat_…" required aria-label="Fine-grained GitHub token" autocomplete="off">
        <button class="btn primary" type="submit">Add fine-grained token</button>
      </form>
      <p class="panel-note dim">Personal credentials are yours alone. Classic <code>ghp_</code> tokens are refused; choose repository access and read-only permissions when creating a fine-grained token.</p>
    </div>

    <div class="panel">
      <p class="eyebrow">Shares</p>
      <div class="ledger scroll-x">
        <table>
          <tr><th>Label</th><th>Kind</th><th>Target</th><th>Created</th><th>Expires</th><th></th></tr>
          ${shareRows}
        </table>
      </div>
    </div>

  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/bundles">bundles</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
${appScript()}
</body>
</html>`;
}

// ---- the GitHub claim page ----
//
// What the setup callback renders. It has one job the settings page cannot do: present
// the installations a person just proved they can reach, and carry the one-time handle
// that lets the following POST attach one of them. Every refusal renders through the
// same function with no choices and no handle, so a refused page cannot accidentally
// grow a form.

export interface GithubClaimChoice {
  installationId: number;
  account: string;
  accountType: string;
  repositorySelection: string;
  /** Already this workspace's. Offered anyway — reconnecting is a no-op, and hiding it
   *  would read as "GitHub does not know about this one". */
  held: boolean;
}

export interface GithubClaimData {
  /** Null when the claim could not be identified at all, in which case there is no
   *  workspace to send anyone back to. */
  wsId: string | null;
  headline: string;
  note: string;
  login: string | null;
  /** The one-time attach handle. Null on every refusal, which is what makes a refusal
   *  incapable of writing. */
  claimToken: string | null;
  choices: GithubClaimChoice[];
}

export function githubClaimPage(d: GithubClaimData): string {
  const og = { "og:title": "Connect GitHub · Seer", "og:type": "website", robots: "noindex" };

  const options = d.choices
    .map(
      (c, i) => `<label class="panel-row">
        <input type="radio" name="installation_id" value="${c.installationId}"${i === 0 ? " checked" : ""}>
        <span>${escapeHtml(c.account)} <span class="mono">${escapeHtml(c.accountType)}</span>
        <span class="mono">${escapeHtml(c.repositorySelection)}</span>${c.held ? ` <span class="pill">connected</span>` : ""}</span>
      </label>`,
    )
    .join("\n");

  const form =
    d.claimToken && d.choices.length > 0
      ? `<form method="post" action="/github/claim">
          <input type="hidden" name="claim" value="${escapeHtml(d.claimToken)}">
          ${options}
          <div class="panel-row stack-gap"><button class="btn primary" type="submit">Connect it</button></div>
        </form>`
      : "";

  const back = d.wsId
    ? `<p class="panel-note dim"><a href="/settings/${escapeHtml(d.wsId)}">Back to workspace settings</a></p>`
    : `<p class="panel-note dim"><a href="/bundles">Back to Seer</a></p>`;

  return `<!doctype html>
<html lang="en">
${head("Connect GitHub · Seer", og)}
<body>
<div class="frame warm grow">
  <div class="shell spine">
    ${navRow(null)}
    <p class="eyebrow">GitHub${d.login ? ` · <span class="email-tag">${escapeHtml(d.login)}</span>` : ""}</p>
    <h1 class="h-section">${escapeHtml(d.headline)}</h1>
    <p class="subtitle">${escapeHtml(d.note)}</p>
    <div class="panel">
      ${form}
      ${back}
    </div>
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/bundles">bundles</a>`])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

// ---- invite acceptance ----
//
// Public GET for a valid, unaccepted, unexpired invite. A signed-in viewer gets a
// one-click accept (POST); a signed-out viewer is sent through Google, carrying the
// invite as `next` so acceptance completes on the OIDC callback. Invalid, expired,
// or used tokens never reach here — the route hands them a soft-404 instead.

export interface InviteData {
  token: string;
  workspaceName: string;
  inviterEmail: string;
  expires: string;
  signedIn: boolean;
}

export function invitePage(d: InviteData): string {
  const og = { "og:title": "Invitation · Seer", "og:type": "website", robots: "noindex" };

  // The token is always a validated inv_ id by the time this renders (the route
  // gates on INV_ID_RE), but escape it anyway — defense in depth, consistent with
  // every other interpolated string on the page.
  const token = escapeHtml(d.token);
  const action = d.signedIn
    ? `<form class="panel-row stack-gap" method="post" action="/invite/${token}/accept">
         <button class="btn primary" type="submit">Take your seat →</button>
       </form>`
    : `<div class="panel-row stack-gap">
         <a class="btn primary" href="/login?next=/invite/${token}">Sign in with Google →</a>
       </div>`;

  const seatNote = d.signedIn
    ? `This link works once and expires ${escapeHtml(d.expires)}. Accepting joins you to the workspace; declining is simply closing this tab.`
    : `This link works once and expires ${escapeHtml(d.expires)}. No account exists until you sign in; declining is simply closing this tab.`;

  return `<!doctype html>
<html lang="en">
${head("Invitation · Seer", og)}
<body>
<div class="frame warm grow">
  <div class="shell spine">
    ${navRow(null)}
    <p class="eyebrow">Invitation · <span class="email-tag">${escapeHtml(d.token)}</span></p>
    <h1 class="h-display">You've been <span class="accent">asked in</span>.</h1>
    <p class="subtitle"><span class="email-tag">${escapeHtml(d.inviterEmail)}</span> invites you to ${escapeHtml(d.workspaceName)}.</p>

    <div class="prose">
      <p class="lede">${escapeHtml(d.workspaceName)} is a workspace on Seer — a small, private instrument for
      previewing what AI agents build. ${d.signedIn ? "Take your seat to join it." : "Sign in with Google to take your seat; your email becomes your account, nothing more is asked of you."}</p>
    </div>

    ${action}

    <p class="aside stack-gap">${seatNote}</p>
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/">back to the front</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

// ---- soft-404 (the void) ----
//
// Served for every denied, missing, unknown, or out-of-range bundle under a
// workspace path — forbidden and missing are deliberately indistinguishable, so a
// private workspace leaks nothing to a non-member. HTTP 404, no-cache, a generic
// Seer OG card. The only branch: signed-out viewers get a sign-in affordance (the
// link they were sent might resolve once they authenticate); signed-in viewers get
// no affordance and see their own session email instead.

export function softNotFoundPage(signedInEmail: string | null, currentUrl: string): string {
  const og = {
    "og:title": "Seer",
    "og:description": "A private instrument for previewing HTML bundles.",
    "og:type": "website",
    "og:site_name": "Seer",
    "og:image": `${config.baseUrl}/og.png`,
    robots: "noindex",
  };

  const loginNext = `/login?next=${encodeURIComponent(currentUrl)}`;

  const variant = signedInEmail
    ? `<p class="subtitle">Signed in, and still nothing. The glass is&nbsp;dark.</p>
       <p class="aside stack-gap">You're <span class="email-tag">${escapeHtml(signedInEmail)}</span>. Whatever
       lived at this address is not yours to see, or not anywhere at all — Seer honestly can't tell you which.
       If someone sent you this link, ask them to check their workspace.</p>`
    : `<p class="subtitle">Try signing in — there might be, who&nbsp;knows?</p>
       <div class="panel-row stack-gap">
         <a class="btn primary" href="${escapeHtml(loginNext)}">Sign in</a>
       </div>
       <p class="aside stack-gap">Someone sent you this link on purpose, probably. If a sign-in doesn't
       reveal it, ask them to check their workspace.</p>`;

  return `<!doctype html>
<html lang="en">
${head("Seer", og)}
<body>
<div class="frame warm grow">
  <div class="shell spine">
    ${navRow(signedInEmail ? null : { href: loginNext, label: "Sign in" })}
    ${markSvg("void-mark")}
    <p class="eyebrow">404</p>
    <h1 class="h-display">Nothing here for <span class="accent">you</span> to see.</h1>
    ${variant}
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/">back to the front</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

// ---- no seat (403 on OIDC sign-in) ----
//
// Google verified the email, but it belongs to no user and carried no valid invite
// — so there is nothing to sign in to. A 403 in the site's voice rather than a bare
// string. The exact line "This account has no seat at Seer." is preserved so the
// message reads the same whether rendered or scraped. No sign-in affordance: the
// viewer just authenticated; a seat needs an invite, not another round-trip.

export function noSeatPage(email: string | null): string {
  const og = {
    "og:title": "Seer",
    "og:description": "A private instrument for previewing HTML bundles.",
    "og:type": "website",
    "og:site_name": "Seer",
    "og:image": `${config.baseUrl}/og.png`,
    robots: "noindex",
  };

  const who = email
    ? `<p class="aside stack-gap">You signed in as <span class="email-tag">${escapeHtml(email)}</span>, but
       that address hasn't been asked in yet. Ask a member for an invite link — it seats you the moment you open it.</p>`
    : `<p class="aside stack-gap">Ask a member for an invite link — it seats you the moment you open it.</p>`;

  return `<!doctype html>
<html lang="en">
${head("Seer", og)}
<body>
<div class="frame warm grow">
  <div class="shell spine">
    ${navRow(null)}
    ${markSvg("void-mark")}
    <p class="eyebrow"><span class="accent">403</span></p>
    <h1 class="h-display">This account has no seat at Seer.</h1>
    <p class="subtitle">The glass is closed to this one.</p>
    ${who}
  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/">back to the front</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
  </div>
</div>
${themeToggleScript()}
</body>
</html>`;
}

