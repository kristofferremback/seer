import { config } from "./config";

// Where the source lives; kept as a named const so it is trivial to re-point.
export const GITHUB_URL = "https://github.com/kristofferremback/seer";
export const CONTACT_EMAIL = "kristoffer.remback@gmail.com";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

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
  url: string; // canonical absolute URL of the page being served
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
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
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

  :root {
    color-scheme: light;
    --paper: 40 22% 98%;
    --paper-warm: 38 16% 94%;
    --paper-sunk: 40 14% 93%;
    --ink: 30 10% 12%;
    --ink-soft: 30 9% 26%;
    --line: 35 15% 88%;
    --muted: 30 8% 45%;
    --night: 26 16% 10%;
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
    --paper: 26 12% 13%;
    --paper-warm: 26 14% 11%;
    --paper-sunk: 26 15% 9%;
    --ink: 38 16% 90%;
    --ink-soft: 35 11% 74%;
    --line: 26 8% 24%;
    --muted: 32 7% 57%;
    --night: 26 16% 7%;
    /* Lifted so oxblood reads on espresso. */
    --accent: 356 45% 62%;
    --accent-soft: 356 38% 52%;
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
  .frame.night { background: hsl(var(--night)); color: hsl(38 14% 80%); }

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

  /* quiet theme toggle — a bare icon, no pill. Shows the icon for the mode a
     click switches TO (moon in light, sun in dark). */
  .theme-toggle {
    background: none; border: 0; padding: 4px; margin: 0;
    color: hsl(var(--muted));
    cursor: pointer; line-height: 0;
    display: inline-flex; align-items: center;
    border-radius: 4px;
  }
  .theme-toggle .tt-sun { display: none; }
  .theme-toggle .tt-moon { display: block; }
  :root[data-theme="dark"] .theme-toggle .tt-sun { display: block; }
  :root[data-theme="dark"] .theme-toggle .tt-moon { display: none; }

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
    color: hsl(var(--muted));
    margin: 0 0 0.9rem;
  }
  .email-tag { font-family: var(--font-mono); font-size: 0.78rem; letter-spacing: 0.02em; color: hsl(var(--muted)); }

  p { margin: 0 0 0.85rem; max-width: 42ch; min-width: 0; }
  .lede { font-size: 1.02rem; line-height: 1.6; max-width: 46ch; margin-top: 1.6rem; }
  .prose { color: hsl(var(--ink-soft)); }
  .prose p { max-width: 48ch; }
  .aside { color: hsl(var(--muted)); font-size: 0.95rem; }

  a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; text-decoration-color: hsl(var(--line)); }
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
  }
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
  .frame.night .footer { color: hsl(38 12% 62%); }
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
  .btn.primary { color: hsl(var(--accent)); border-color: hsl(var(--accent) / 0.45); }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover { color: hsl(var(--accent)); border-color: hsl(var(--accent) / 0.6); }
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

  /* inputs */
  .input {
    font-family: var(--font-body);
    font-size: 0.95rem;
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
  }
  .frame.warm .panel { background: hsl(var(--paper)); }
  .panel .eyebrow { margin-bottom: 0.7rem; }
  .panel-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem; }
  .panel-note { font-size: 0.9rem; color: hsl(var(--ink-soft)); max-width: 52ch; margin: 0.8rem 0 0; }
  .panel-note.dim { color: hsl(var(--muted)); }

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
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle light and dark mode">
    <svg class="tt-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    <svg class="tt-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
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
with it lands in that workspace — you never name the workspace yourself. Keep the
key secret; it is the only write credential.

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

## 5. Listing what is published

\`\`\`sh
curl -H "Authorization: Bearer $API_TOKEN" ${base}/api/bundles
\`\`\`

Returns every bundle in your key's workspace with its full version history (slugs,
versions, sizes, timestamps), each tagged with its \`workspace\` id.

## Sharing and viewing

Whether a bundle link is openable without signing in depends on its workspace's
visibility. A **public** workspace (the default) serves bundle URLs
(\`/<workspace>/b/<slug>/\`) to anyone with the link — no sign-in. A **private**
workspace serves them only to signed-in members; everyone else gets a generic
Seer 404 that reveals nothing, so a private bundle's title never leaks. The human
sets visibility per workspace on its settings page.

Hand the \`url\` to whoever should see it, or open it yourself. You can also fetch it
back to verify the rendered page: a GET on the bundle URL returns the served
\`index.html\` (the latest URL has the live-reload script injected before \`</body>\`).

When a bundle link is shared in chat, Seer injects OpenGraph tags into the served
HTML so the link unfurls with your page's \`<title>\`, a description, and a Seer
card image. If you want full control of the preview, ship your own \`og:\` meta
tags in \`index.html\` — Seer leaves pages that declare any \`og:\` or \`twitter:\`
meta untouched.

The write side and the inventory are always private: uploading needs your API key,
and the list of bundles (\`GET /api/bundles\`, scoped to your key's workspace) needs
it too. Public bundle links are the only thing viewable without a credential.
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
${head("Seer", og, `<link rel="alternate" type="text/markdown" href="/skill.md">`)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${navRow(action)}
    <h1 class="h-display">Preview what your <span class="accent">agents</span> build.</h1>
    <p class="subtitle">A private instrument for previewing HTML&nbsp;bundles.</p>
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

// The ledger is grouped by the session user's workspaces: one group head per
// workspace (name, ws_ id, visibility pill, settings link) over that workspace's
// own bundle table. Bundle URLs are workspace-scoped.
export interface LedgerGroup {
  wsId: string;
  name: string;
  visibility: "public" | "private";
  bundles: LedgerBundle[];
}

export function bundlesPage(email: string, groups: LedgerGroup[]): string {
  const og = { "og:title": "Bundles · Seer", "og:type": "website", robots: "noindex" };

  const bundleUrl = (wsId: string, slug: string) => `/${wsId}/b/${encodeURIComponent(slug)}/`;

  const groupBlock = (g: LedgerGroup) => {
    const pill = `<span class="pill${g.visibility === "public" ? " public" : ""}"><span class="bead"></span>${g.visibility}</span>`;
    const head = `<div class="ws-head">
      <h2>${escapeHtml(g.name)}</h2>
      <span class="mono-id">${escapeHtml(g.wsId)}</span>
      ${pill}
      <span class="spacer"></span>
      <a class="nav-action" href="/settings/${g.wsId}">settings</a>
    </div>`;

    if (g.bundles.length === 0) {
      return `${head}
      <p class="empty">No bundles here yet.</p>`;
    }

    const rows = g.bundles
      .map((b) => {
        const history = b.versions
          .map((v) => `<a href="${bundleUrl(g.wsId, b.slug)}v/${v}/">v${v}</a>`)
          .join("");
        return `<tr>
          <td class="slug"><a href="${bundleUrl(g.wsId, b.slug)}">${escapeHtml(b.slug)}</a></td>
          <td class="mono">v${b.latestVersion}</td>
          <td class="mono">${escapeHtml(b.updated)}</td>
          <td class="history mono">${history}</td>
        </tr>`;
      })
      .join("\n");

    return `${head}
    <div class="ledger scroll-x">
      <table>
        <tr><th>Bundle</th><th>Latest</th><th>Updated</th><th>History</th></tr>
        ${rows}
      </table>
    </div>`;
  };

  const body =
    groups.length === 0
      ? `<p class="empty">No workspaces yet.</p>`
      : groups.map(groupBlock).join("\n");

  // A member can always spin up another estate. Public by default; visibility is
  // its own settings toggle.
  const newWorkspace = `<form class="panel-row stack-gap" method="post" action="/workspaces">
      <input class="input" type="text" name="name" placeholder="new workspace name" maxlength="80" aria-label="New workspace name">
      <button class="btn primary" type="submit">New workspace</button>
    </form>`;

  return `<!doctype html>
<html lang="en">
${head("Bundles · Seer", og)}
<body>
<div class="frame warm">
  <div class="shell spine">
    ${navRow(null)}
    <p class="eyebrow"><span class="email-tag">${escapeHtml(email)}</span></p>
    <h1 class="h-section">Bundles</h1>
    <p class="subtitle">Everything Seer is holding, workspace by workspace.</p>
  </div>
</div>
<div class="frame grow">
  <div class="shell spine">
    ${body}
    ${newWorkspace}
    <p class="aside stack-gap">You appear here for every workspace you're a member of. Each group is
    its own little estate — its visibility rides on its sleeve, its settings one click away.</p>
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
export type SettingsReveal =
  | { kind: "key"; token: string }
  | { kind: "invite"; url: string; expires: string };

export interface SettingsData {
  wsId: string;
  name: string;
  visibility: "public" | "private";
  email: string;
  members: SettingsMember[];
  keys: SettingsKey[];
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
    ${navRow({ href: "/bundles", label: "bundles" })}
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

  </div>
</div>
<div class="frame night">
  <div class="shell">
    ${footer([`<a href="/bundles">bundles</a>`, `<a href="/skill.md"><code>skill.md</code></a>`])}
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

