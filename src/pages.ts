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
// Design language: keep Seer's identity (paper tone, serif masthead, oxblood
// accent, hand-drawn mark, mono only for data) but adopt a calmer, border-first
// restraint. Depth comes from hairline warm borders and surfaces a hair off the
// paper, not from heavy broadsheet rules or shadows. Oxblood carries interactive
// meaning only: links, focus rings, the mark's glint.
function styles(): string {
  return `
  :root {
    color-scheme: light;
    --paper: #f4efe3;
    --surface: #f8f4ea;      /* card: a hair lighter than the paper */
    --surface-sunk: #ece4d3; /* code specimen: sunk a hair below */
    --ink: #24201a;
    --ink-soft: #6b6154;
    --accent: #6d1f22;
    --accent-soft: rgba(109, 31, 34, 0.14);
    --hair: #dcd2bd;         /* warm hairline border */
    --hair-soft: #e5dcca;
    --r-card: 12px;
    --r-item: 8px;
    --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --gutter: clamp(1.25rem, 5vw, 2rem);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100vh;
    background-color: var(--paper);
    color: var(--ink);
    font-family: var(--serif);
    font-size: 17px;
    line-height: 1.6;
    touch-action: manipulation;
    /* A quiet warm rake of light from the top, resolving into the paper. */
    background-image: radial-gradient(115% 70% at 50% -20%, rgba(255, 250, 238, 0.7), rgba(255, 250, 238, 0) 58%);
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
    opacity: 0.04;
  }
  .sheet {
    max-width: 44rem;
    margin: 0 auto;
    /* safe-area aware gutters so nothing kisses a notch or the screen rim */
    padding:
      clamp(2rem, 6vw, 3.4rem)
      max(var(--gutter), env(safe-area-inset-right))
      max(2.2rem, env(safe-area-inset-bottom))
      max(var(--gutter), env(safe-area-inset-left));
  }
  a {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2.5px;
    text-decoration-thickness: 1px;
    text-decoration-color: var(--hair);
  }
  /* Hover is a fine-pointer affordance only, so touch never sticks a colour. */
  @media (hover: hover) and (pointer: fine) {
    a { transition: color 150ms ease, text-decoration-color 150ms ease; }
    a:hover { color: var(--accent); text-decoration-color: var(--accent); }
  }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

  /* thin, restrained scrollbars on the overflow blocks */
  .scroll-x { overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--hair) transparent; }
  .scroll-x::-webkit-scrollbar { height: 6px; }
  .scroll-x::-webkit-scrollbar-thumb { background: var(--hair); border-radius: 999px; }
  .scroll-x::-webkit-scrollbar-track { background: transparent; }

  /* masthead */
  .masthead { display: flex; align-items: center; gap: 1rem; }
  .mark { width: 42px; height: 51px; flex: none; }
  .mark-fig { width: 60px; height: 73px; }
  h1 { font-size: clamp(2.3rem, 6vw, 3.1rem); line-height: 1; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
  .subtitle { font-style: italic; color: var(--ink-soft); font-size: clamp(0.98rem, 3vw, 1.08rem); margin: 0.35rem 0 0; }
  .email-tag { font-family: var(--mono); font-style: normal; font-size: 0.8rem; color: var(--ink-soft); }

  /* the nameplate rule, slimmed to a single quiet hairline */
  .scotch { height: 1px; background: var(--hair); border: 0; margin: 1.4rem 0 1.8rem; }

  p { margin: 0 0 0.9rem; max-width: 36em; min-width: 0; }
  .lede { font-size: 1.1rem; }
  .aside { color: var(--ink-soft); font-style: italic; }

  .columns { display: grid; grid-template-columns: 1fr; gap: 1.8rem 2.4rem; align-items: start; }
  /* min-width:0 lets a wide code line scroll inside its own box instead of
     forcing the grid track (and the page) wider than the viewport. */
  .columns > * { min-width: 0; }
  @media (min-width: 40rem) { .columns { grid-template-columns: 1.15fr 1fr; } }

  .fig { display: flex; align-items: center; gap: 0.8rem; margin: 0 0 1.2rem; }
  .fig figcaption { font-style: italic; color: var(--ink-soft); font-size: 0.9rem; }

  /* specimen: a quiet bordered card holding the copy-paste command */
  .specimen {
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    padding: 1rem 1.1rem;
  }
  .specimen-label { font-style: italic; font-size: 0.92rem; color: var(--ink-soft); margin: 0 0 0.6rem; }
  pre.cmd {
    font-family: var(--mono);
    font-size: 0.76rem;
    line-height: 1.65;
    margin: 0;
    padding: 0.8rem 0.9rem;
    background: var(--surface-sunk);
    border: 1px solid var(--hair-soft);
    border-radius: var(--r-item);
    white-space: pre;
    color: var(--ink);
  }
  pre.cmd .flag { color: var(--ink-soft); }
  .specimen-note { font-size: 0.92rem; color: var(--ink-soft); max-width: none; margin: 0.7rem 0 0; }
  code { font-family: var(--mono); font-size: 0.85em; }

  /* colophon */
  .colophon {
    margin-top: 2.6rem;
    padding-top: 1rem;
    border-top: 1px solid var(--hair);
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    font-size: 0.9rem;
    color: var(--ink-soft);
  }
  .colophon .mid { color: var(--hair); }

  /* ledger (signed-in bundle list): a clean data table in a quiet card */
  .ledger {
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    margin-top: 0.4rem;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.6rem 0.9rem; vertical-align: baseline; text-align: left; }
  th {
    font-style: italic; font-weight: 400; color: var(--ink-soft); font-size: 0.88rem;
    border-bottom: 1px solid var(--hair);
  }
  td { border-bottom: 1px solid var(--hair-soft); }
  tr:last-child td { border-bottom: 0; }
  .mono { font-family: var(--mono); font-size: 0.83rem; }
  .slug a { text-decoration: none; font-weight: 600; }
  @media (hover: hover) and (pointer: fine) { .slug a:hover { text-decoration: underline; } }
  .history a { margin-right: 0.55rem; color: var(--ink-soft); }
  .empty { color: var(--ink-soft); font-style: italic; }

  /* shell (private preview gate): the same quiet card treatment */
  .card {
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: var(--r-card);
    padding: 1.2rem 1.3rem;
  }
  .gate { font-size: 1.05rem; margin: 0; }
  .gate-meta { display: block; font-family: var(--mono); font-size: 0.8rem; color: var(--ink-soft); margin-top: 0.5rem; }
  .gate-action { margin: 1.1rem 0 0; font-size: 1.02rem; }

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
<title>${escapeHtml(title)}</title>
${tags}${extra ? `\n${extra}` : ""}
<style>${styles()}</style>
</head>`;
}

function scotch(): string {
  return `<hr class="scotch" aria-hidden="true">`;
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
the latest \`url\` reloads itself automatically. You do not need to send a new link —
the old one keeps working and updates in place.

## 5. Listing what is published

\`\`\`sh
curl -H "Authorization: Bearer $API_TOKEN" ${base}/api/bundles
\`\`\`

Returns every bundle with its full version history (slugs, versions, sizes,
timestamps).

## Important: viewing requires a human

Bundle URLs (\`/b/<slug>/\`) are gated behind Google sign-in. **You cannot fetch and
verify the rendered page yourself** — an unauthenticated fetch gets a sign-in shell,
not the bundle. Give the \`url\` to the human and let them open it in their browser.
Trust the upload response (\`200\` + \`hasIndexHtml: true\`) as your confirmation that
the bundle was stored, rather than trying to GET it back.
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
    "og:image": `${config.baseUrl}/og.png`,
    "twitter:card": "summary",
    "twitter:title": "Seer",
    "twitter:description": "Push a zip, get a versioned, self-reloading preview URL. A private little instrument.",
    "twitter:image": `${config.baseUrl}/og.png`,
  };

  return `<!doctype html>
<html lang="en">
${head("Seer", og, `<link rel="alternate" type="text/markdown" href="/skill.md">`)}
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
      <div class="specimen">
        <p class="specimen-label">To push a bundle</p>
        <pre class="cmd scroll-x">${curl}</pre>
        <p class="specimen-note">Back comes <code>/b/your-slug/</code>, versioned and live.</p>
      </div>
    </aside>
  </div>
  <footer class="colophon">
    <span>Open source at <a href="${GITHUB_URL}">github.com/kristofferremback/seer</a></span>
    <span class="mid" aria-hidden="true">&middot;</span>
    <span>Curious? <a href="mailto:${CONTACT_EMAIL}">drop a line</a></span>
    <span class="mid" aria-hidden="true">&middot;</span>
    <span><a href="/skill.md"><code>skill.md</code></a> for agents</span>
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
         <div class="specimen">
           <p class="specimen-label">Push your first one</p>
           <pre class="cmd scroll-x">curl -X PUT --data-binary @bundle.zip \\
  <span class="flag">-H "Authorization: Bearer $API_TOKEN"</span> \\
  ${escapeHtml(config.baseUrl)}/api/bundles/your-slug</pre>
         </div>`
      : `<div class="ledger scroll-x">
          <table>
            <tr><th>Bundle</th><th>Latest</th><th>Updated</th><th>History</th></tr>
            ${rows}
          </table>
        </div>`;

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
  <div class="card">
    <p class="gate">You are looking at <code>${escapeHtml(slug)}</code>, a private bundle on Seer.${
    meta ? `<span class="gate-meta">${meta.versions} version${meta.versions === 1 ? "" : "s"} &middot; updated ${escapeHtml(meta.updated)}</span>` : ""
  }</p>
    <p class="gate-action"><a href="${escapeHtml(loginHref)}">Sign in with Google to view</a></p>
  </div>
  <footer class="colophon">
    <span>Open source at <a href="${GITHUB_URL}">github.com/kristofferremback/seer</a></span>
  </footer>
</main>
</body>
</html>`;
}
