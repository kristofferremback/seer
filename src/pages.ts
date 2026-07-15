import { config } from "./config";

// Where the source lives; kept as a named const so it is trivial to re-point.
export const GITHUB_URL = "https://github.com/kristofferremback/seer";
export const CONTACT_EMAIL = "kristoffer.remback@gmail.com";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---- the scrying glass: one hand-drawn mark, the whole identity ----
// A crystal ball in its cradle. The ink strokes are the instrument; the single
// oxblood glint inside is the only accent, and it is the one thing that moves.
function markSvg(cls = "mark"): string {
  return `<svg class="${cls}" viewBox="0 0 48 58" role="img" aria-label="A crystal ball on a small stand" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="21" r="15" stroke="var(--ink)" stroke-width="1.5"/>
  <path d="M14 17 Q16 11 23 10" stroke="var(--ink)" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>
  <path d="M11 31 Q24 43 37 31" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M13.5 33 L18 50" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M34.5 33 L30 50" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M16 51 L32 51" stroke="var(--ink)" stroke-width="1.6" stroke-linecap="round"/>
  <path class="glint" d="M30 21.6 L30.95 24.05 L33.4 25 L30.95 25.95 L30 28.4 L29.05 25.95 L26.6 25 L29.05 24.05 Z" fill="var(--accent)"/>
</svg>`;
}

// ---- shared paper substrate + type ----
function styles(): string {
  return `
  :root {
    color-scheme: light;
    --paper: #f4efe3;
    --paper-deep: #ece4d3;
    --ink: #211d18;
    --ink-soft: #6b6154;
    --accent: #6d1f22;
    --rule: rgba(33, 29, 24, 0.85);
    --hair: rgba(33, 29, 24, 0.2);
    --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    background-color: var(--paper);
    color: var(--ink);
    font-family: var(--serif);
    font-size: 18px;
    line-height: 1.62;
    /* A warm rake of light from the top, resolving into the paper. One source. */
    background-image: radial-gradient(120% 80% at 50% -18%, rgba(255, 250, 238, 0.9), rgba(255, 250, 238, 0) 60%);
  }
  /* Fine printed grain on the substrate, behind everything. Felt, not seen. */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E");
    mix-blend-mode: multiply;
    opacity: 0.05;
  }
  .sheet {
    max-width: 44rem;
    margin: 0 auto;
    padding: clamp(2.4rem, 7vw, 4.5rem) clamp(1.4rem, 5vw, 2.2rem) 2.6rem;
  }
  a { color: var(--ink); text-decoration: underline; text-underline-offset: 2.5px; text-decoration-thickness: 1px; transition: color 0.12s ease; }
  a:hover { color: var(--accent); }

  /* masthead */
  .masthead { display: flex; align-items: flex-end; gap: 1.1rem; }
  .mark { width: 46px; height: 56px; flex: none; }
  .mark-fig { width: 68px; height: 82px; }
  h1 { font-size: clamp(2.9rem, 8vw, 4.1rem); line-height: 0.94; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .subtitle { font-style: italic; color: var(--ink-soft); font-size: clamp(1rem, 3.4vw, 1.16rem); margin: 0.5rem 0 0; }
  .email-tag { font-family: var(--mono); font-size: 0.82rem; color: var(--ink-soft); }

  /* the scotch rule: the broadsheet nameplate device */
  .scotch { margin: 1.5rem 0 1.7rem; }
  .scotch span { display: block; background: var(--rule); }
  .scotch .thick { height: 3px; }
  .scotch .thin { height: 1px; margin-top: 3px; }

  p { margin: 0 0 1rem; max-width: 34em; }
  .lede { font-size: 1.12rem; }
  .aside { color: var(--ink-soft); font-style: italic; }

  .columns { display: grid; grid-template-columns: 1fr; gap: 1.8rem 2.4rem; align-items: start; }
  @media (min-width: 40rem) { .columns { grid-template-columns: 1.15fr 1fr; } }

  .fig { display: flex; align-items: center; gap: 0.85rem; margin: 0.3rem 0 1.3rem; }
  .fig figcaption { font-style: italic; color: var(--ink-soft); font-size: 0.9rem; }

  .specimen-label { font-style: italic; font-size: 0.95rem; color: var(--ink-soft); margin: 0 0 0.5rem; }
  pre.cmd {
    font-family: var(--mono);
    font-size: 0.78rem;
    line-height: 1.65;
    margin: 0 0 0.7rem;
    padding: 0.85rem 0.95rem;
    background: var(--paper-deep);
    border: 1px solid var(--hair);
    border-radius: 3px;
    overflow-x: auto;
    white-space: pre;
    color: var(--ink);
  }
  pre.cmd .flag { color: var(--ink-soft); }
  .specimen-note { font-size: 0.95rem; color: var(--ink-soft); max-width: none; }
  code { font-family: var(--mono); font-size: 0.85em; }

  /* colophon */
  .colophon {
    margin-top: 2.6rem;
    padding-top: 1rem;
    border-top: 1px solid var(--hair);
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    font-size: 0.92rem;
    color: var(--ink-soft);
  }
  .colophon .mid { color: var(--hair); }

  /* ledger (signed-in bundle list) */
  table { width: 100%; border-collapse: collapse; margin-top: 0.4rem; }
  th { text-align: left; font-style: italic; font-weight: 400; color: var(--ink-soft); font-size: 0.9rem; padding: 0 0.9rem 0.5rem 0; border-bottom: 1px solid var(--hair); }
  td { padding: 0.62rem 0.9rem 0.62rem 0; border-bottom: 1px solid var(--hair); vertical-align: baseline; }
  td:last-child, th:last-child { padding-right: 0; }
  .mono { font-family: var(--mono); font-size: 0.85rem; }
  .slug a { text-decoration: none; font-weight: 600; }
  .slug a:hover { text-decoration: underline; }
  .history a { margin-right: 0.55rem; color: var(--ink-soft); }
  .empty { color: var(--ink-soft); font-style: italic; }

  /* shell (private preview gate) */
  .gate { font-size: 1.08rem; }
  .gate-meta { font-family: var(--mono); font-size: 0.82rem; color: var(--ink-soft); margin-top: 0.4rem; }
  .gate-action { margin-top: 1.5rem; font-size: 1.05rem; }

  .glint { transform-box: fill-box; transform-origin: center; }
  @media (prefers-reduced-motion: no-preference) {
    .glint { animation: glint 5.5s ease-in-out infinite; }
  }
  @keyframes glint {
    0%, 100% { opacity: 0.35; transform: scale(0.82) rotate(0deg); }
    50% { opacity: 1; transform: scale(1.08) rotate(45deg); }
  }
`;
}

function head(title: string, og: Record<string, string>): string {
  const tags = Object.entries(og)
    .map(([k, v]) => {
      const attr = k.startsWith("og:") ? "property" : "name";
      return `<meta ${attr}="${k}" content="${escapeHtml(v)}">`;
    })
    .join("\n");
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${tags}
<style>${styles()}</style>
</head>`;
}

function scotch(): string {
  return `<div class="scotch" aria-hidden="true"><span class="thick"></span><span class="thin"></span></div>`;
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
    "og:image": `${config.baseUrl}/og.png`,
    "twitter:card": "summary",
    "twitter:title": "Seer",
    "twitter:description": "Push a zip, get a versioned, self-reloading preview URL. A private little instrument.",
    "twitter:image": `${config.baseUrl}/og.png`,
  };

  return `<!doctype html>
<html lang="en">
${head("Seer", og)}
<body>
<main class="sheet">
  <header class="masthead">
    ${markSvg("mark")}
    <div>
      <h1>Seer</h1>
      <p class="subtitle">A private instrument for previewing HTML&nbsp;bundles.</p>
    </div>
  </header>
  ${scotch()}
  <div class="columns">
    <div>
      <p class="lede">An agent builds a page, zips it, and pushes it here. Seer keeps every
      version and hands back a URL that reloads itself the moment a new build lands.</p>
      <p>One person's tool, kept behind a Google sign-in. No accounts, no dashboard, no
      product. Just a place for half-finished pages to be looked at.</p>
      <p class="aside">It is a slop site, for sure. It also works.</p>
    </div>
    <aside>
      <figure class="fig">
        ${markSvg("mark mark-fig")}
        <figcaption>Fig. 1. The scrying glass.</figcaption>
      </figure>
      <p class="specimen-label">To push a bundle</p>
      <pre class="cmd">${curl}</pre>
      <p class="specimen-note">Back comes <code>/b/your-slug/</code>, versioned and live.</p>
    </aside>
  </div>
  <footer class="colophon">
    <span>Open source at <a href="${GITHUB_URL}">github.com/kristofferremback/seer</a></span>
    <span class="mid" aria-hidden="true">&middot;</span>
    <span>Curious? <a href="mailto:${CONTACT_EMAIL}">drop a line</a></span>
    <span class="mid" aria-hidden="true">&middot;</span>
    <span>${signedIn ? `<a href="/bundles">Your bundles</a>` : `<a href="/login">Sign in</a>`}</span>
  </footer>
</main>
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

  const rows = bundles
    .map((b) => {
      const history = b.versions
        .map((v) => `<a href="/b/${encodeURIComponent(b.slug)}/v/${v}/">v${v}</a>`)
        .join("");
      return `<tr>
        <td class="slug"><a href="/b/${encodeURIComponent(b.slug)}/">${escapeHtml(b.slug)}</a></td>
        <td class="mono">v${b.latestVersion}</td>
        <td class="mono">${escapeHtml(b.updated)}</td>
        <td class="history mono">${history}</td>
      </tr>`;
    })
    .join("\n");

  const body =
    bundles.length === 0
      ? `<p class="empty">No bundles yet.</p>
         <p class="specimen-label">Push your first one</p>
         <pre class="cmd">curl -X PUT --data-binary @bundle.zip \\
  <span class="flag">-H "Authorization: Bearer $API_TOKEN"</span> \\
  ${escapeHtml(config.baseUrl)}/api/bundles/your-slug</pre>`
      : `<table>
          <tr><th>Bundle</th><th>Latest</th><th>Updated</th><th>History</th></tr>
          ${rows}
        </table>`;

  return `<!doctype html>
<html lang="en">
${head("Bundles · Seer", og)}
<body>
<main class="sheet">
  <header class="masthead">
    ${markSvg("mark")}
    <div>
      <h1>Bundles</h1>
      <p class="subtitle">Everything Seer is holding &middot; <span class="email-tag">${escapeHtml(email)}</span></p>
    </div>
  </header>
  ${scotch()}
  ${body}
  <footer class="colophon">
    <span><a href="/">Back to the front</a></span>
  </footer>
</main>
</body>
</html>`;
}

// ---- private preview gate (unauthenticated /b/:slug/) ----

export interface ShellMeta {
  versions: number;
  updated: string;
}

export function shellPage(slug: string, path: string, meta: ShellMeta | null): string {
  const loginHref = `/login?next=${encodeURIComponent(path)}`;
  const title = `${slug} · Seer`;
  const desc = meta
    ? `${meta.versions} version${meta.versions === 1 ? "" : "s"}, last updated ${meta.updated}. Sign in with Google to view.`
    : "A private preview on Seer. Sign in with Google to view.";
  const og = {
    "og:title": title,
    "og:description": desc,
    "og:type": "website",
    "og:url": `${config.baseUrl}${path}`,
    "twitter:card": "summary",
    "twitter:title": title,
    "twitter:description": desc,
  };

  return `<!doctype html>
<html lang="en">
${head(title, og)}
<body>
<main class="sheet">
  <header class="masthead">
    ${markSvg("mark")}
    <div>
      <h1>Seer</h1>
      <p class="subtitle">A private preview.</p>
    </div>
  </header>
  ${scotch()}
  <p class="gate">You are looking at <code>${escapeHtml(slug)}</code>, a private bundle on Seer.${
    meta ? `<span class="gate-meta">${meta.versions} version${meta.versions === 1 ? "" : "s"} &middot; updated ${escapeHtml(meta.updated)}</span>` : ""
  }</p>
  <p class="gate-action"><a href="${escapeHtml(loginHref)}">Sign in with Google to view</a></p>
  <footer class="colophon">
    <span>Open source at <a href="${GITHUB_URL}">github.com/kristofferremback/seer</a></span>
  </footer>
</main>
</body>
</html>`;
}
