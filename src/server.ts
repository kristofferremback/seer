import type { Server, WebSocketHandler } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";
import { join, normalize, resolve } from "node:path";
import { config } from "./config";
import {
  db,
  getBundle,
  getVersion,
  listBundles,
  listVersions,
  createVersion,
  legacyWorkspaceId,
} from "./db";
import { migrate } from "./migrate";
import { inspectZip, saveZip, ensureExtracted } from "./store";
import { loginRedirect, handleCallback, requireSession, sessionEmail } from "./auth";
import {
  landingPage,
  bundlesPage,
  skillDoc,
  injectBundleMeta,
  type BundleMeta,
  type LedgerBundle,
} from "./pages";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

type WSData = { ws: string; slug: string };

// Until full workspace routing lands (step 3), every legacy `/b/` and `/api` path
// resolves to the bootstrap workspace the migration created.
function legacyWs(): string {
  const ws = legacyWorkspaceId();
  if (!ws) throw new Error("No legacy workspace; migration did not run before serving");
  return ws;
}

function markdownDoc(): Response {
  return new Response(skillDoc(), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function favicon(name: string, contentType: string): Response {
  const file = Bun.file(join(import.meta.dir, "..", "assets", name));
  return new Response(file, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=604800" },
  });
}

function requireApiToken(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  // Compare SHA-256 digests so the check is constant-time regardless of input length.
  const expected = createHash("sha256").update(`Bearer ${config.apiToken}`).digest();
  const actual = createHash("sha256").update(auth).digest();
  if (timingSafeEqual(actual, expected)) return null;
  return json({ error: "Invalid or missing API token" }, 401);
}

// ---- live reload ----

function liveReloadScript(slug: string): string {
  return `<script>(()=>{const c=()=>{const w=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws/livereload?slug=${slug}");w.onmessage=e=>{if(e.data==="reload")location.reload()};w.onclose=()=>setTimeout(c,2000)};c()})();</script>`;
}

// ---- bundle serving ----

async function serveBundleFile(
  wsId: string,
  meta: BundleMeta,
  filePath: string,
  injectReload: boolean,
): Promise<Response> {
  const dir = await ensureExtracted(wsId, meta.slug, meta.version);
  const clean = normalize(filePath || "index.html");
  if (clean.startsWith("..") || clean.startsWith("/")) {
    return new Response("Not found", { status: 404 });
  }
  let file = Bun.file(join(dir, clean));
  if (!(await file.exists())) {
    // directory request → try its index.html
    const withIndex = Bun.file(join(dir, clean, "index.html"));
    if (!(await withIndex.exists())) return new Response("Not found", { status: 404 });
    file = withIndex;
  }

  // Latest (unpinned) content changes underneath viewers on every upload, and the
  // live-reload push means a stale-asset window breaks reloads (new HTML, old CSS/JS)
  // — so everything is no-cache. Pinned /v/N/ content is immutable by construction:
  // the injected social tags derive only from that version's own fixed data.
  const cacheControl = injectReload ? "no-cache" : "public, max-age=31536000, immutable";

  if (file.type.startsWith("text/html")) {
    let html = injectBundleMeta(await file.text(), meta);
    if (injectReload) {
      const script = liveReloadScript(meta.slug);
      html = html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script;
    }
    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": cacheControl },
    });
  }
  return new Response(file, { headers: { "cache-control": cacheControl } });
}

// Bundles are public: anyone with the link can view them, no session required.
async function handleBundleRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // /b/:slug[/v/:version]/rest...
  const match = url.pathname.match(/^\/b\/([^/]+)(?:\/v\/(\d+))?(\/.*)?$/);
  if (!match) return new Response("Not found", { status: 404 });
  const [, slug, versionStr, rest] = match;

  if (!SLUG_RE.test(slug!)) return new Response("Not found", { status: 404 });
  const ws = legacyWs();
  const bundle = getBundle(ws, slug!);
  if (!bundle) return new Response("Not found", { status: 404 });

  const pinned = versionStr !== undefined;
  const version = pinned ? Number(versionStr) : bundle.latest_version;
  if (pinned && (version < 1 || version > bundle.latest_version)) {
    return new Response("Not found", { status: 404 });
  }

  // Require a trailing slash on the bundle root so relative asset URLs resolve.
  if (rest === undefined) {
    return Response.redirect(`${url.pathname}/${url.search}`, 302);
  }

  const meta: BundleMeta = {
    slug: slug!,
    version,
    updatedAt: getVersion(ws, slug!, version)?.created_at ?? bundle.created_at,
    url: `${config.baseUrl}${url.pathname}`,
  };
  return serveBundleFile(ws, meta, rest.slice(1), !pinned);
}

// ---- upload ----

async function handleUpload(req: Request, slug: string, server: Server<WSData>): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;
  if (!SLUG_RE.test(slug)) {
    return json({ error: "Slug must match [a-z0-9][a-z0-9-]{0,63}" }, 400);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return json({ error: "Empty body; send the zip as the request body" }, 400);
  if (body.length > config.maxUploadBytes) {
    return json({ error: `Zip exceeds max size of ${config.maxUploadBytes} bytes` }, 413);
  }

  let files: string[];
  try {
    files = inspectZip(body);
  } catch (err) {
    return json({ error: `Invalid zip: ${(err as Error).message}` }, 400);
  }

  const ws = legacyWs();
  const version = createVersion(ws, slug, body.length, files.length);
  await saveZip(ws, slug, version, body);
  server.publish(`bundle:${ws}:${slug}`, "reload");

  return json({
    slug,
    version,
    url: `${config.baseUrl}/b/${slug}/`,
    versionUrl: `${config.baseUrl}/b/${slug}/v/${version}/`,
    bytes: body.length,
    files: files.length,
    hasIndexHtml: files.includes("index.html"),
  });
}

// ---- bundle ledger (signed-in view data) ----

function ledgerBundles(): LedgerBundle[] {
  const ws = legacyWs();
  return listBundles(ws).map((b) => {
    const versions = listVersions(ws, b.slug);
    const updated = new Date(versions[0]?.created_at ?? b.created_at)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    return {
      slug: b.slug,
      latestVersion: b.latest_version,
      updated,
      versions: versions.map((v) => v.version),
    };
  });
}

// ---- server ----

export function startServer() {
  // Bring the database to schema v1 (and bootstrap the root workspace on first boot)
  // before the server binds — no request may hit an unmigrated db.
  migrate();

  const websocket: WebSocketHandler<WSData> = {
    open(ws) {
      ws.subscribe(`bundle:${ws.data.ws}:${ws.data.slug}`);
    },
    message() {},
  };

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 120,
    maxRequestBodySize: config.maxUploadBytes + 1024,

    routes: {
      "/healthz": () => new Response("ok"),

      "/login": (req) => {
        const next = new URL(req.url).searchParams.get("next") ?? "/bundles";
        return loginRedirect(next);
      },
      "/auth/callback": (req) => handleCallback(req),

      // Public pamphlet. No auth; shows a quiet link onward when signed in.
      "/": (req) =>
        new Response(landingPage(!!sessionEmail(req)), {
          headers: { "content-type": "text/html;charset=utf-8" },
        }),

      // Agent-facing usage doc. Public, no auth — agents (and llms.txt probers)
      // fetch this to learn how to publish. Both paths serve identical markdown.
      "/skill.md": () => markdownDoc(),
      "/llms.txt": () => markdownDoc(),

      // The signed-in ledger of held bundles.
      "/bundles": (req) => {
        const denied = requireSession(req);
        if (denied) return denied;
        return new Response(bundlesPage(sessionEmail(req)!, ledgerBundles()), {
          headers: { "content-type": "text/html;charset=utf-8" },
        });
      },

      // Self-hosted type. A closed whitelist — only these five faces are ever
      // served, so a slug like "../secret" can never traverse out of assets/fonts.
      "/fonts/:file": (req) => {
        const allowed = new Set([
          "switzer.woff2",
          "cabinet-grotesk.woff2",
          "commit-mono-400.woff2",
          "commit-mono-500.woff2",
          "commit-mono-700.woff2",
        ]);
        const name = req.params.file;
        if (!allowed.has(name)) return new Response("Not found", { status: 404 });
        const file = Bun.file(join(import.meta.dir, "..", "assets", "fonts", name));
        return new Response(file, {
          headers: {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },

      // Committed OG card asset. Long cache; it only changes when the art does.
      "/og.png": () => {
        const file = Bun.file(join(import.meta.dir, "..", "assets", "og.png"));
        return new Response(file, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=604800, immutable",
          },
        });
      },

      // The scrying-glass mark as the site icon. SVG for modern browsers,
      // PNG fallbacks for older ones and iOS home-screen.
      "/favicon.svg": () => favicon("favicon.svg", "image/svg+xml"),
      "/favicon.ico": () => favicon("favicon.png", "image/png"),
      "/favicon.png": () => favicon("favicon.png", "image/png"),
      "/apple-touch-icon.png": () => favicon("apple-touch-icon.png", "image/png"),

      "/api/bundles": {
        GET: (req) => {
          const denied = requireApiToken(req);
          if (denied) return denied;
          const ws = legacyWs();
          return json(
            listBundles(ws).map((b) => ({
              slug: b.slug,
              latestVersion: b.latest_version,
              url: `${config.baseUrl}/b/${b.slug}/`,
              versions: listVersions(ws, b.slug).map((v) => ({
                version: v.version,
                createdAt: new Date(v.created_at).toISOString(),
                bytes: v.bytes,
                files: v.file_count,
              })),
            })),
          );
        },
      },
      "/api/bundles/:slug": {
        PUT: (req, srv) => handleUpload(req, req.params.slug, srv),
        POST: (req, srv) => handleUpload(req, req.params.slug, srv),
      },
    },

    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws/livereload") {
        // Public: bundles are viewable by anyone, so their live-reload socket is too.
        const slug = url.searchParams.get("slug") ?? "";
        if (!SLUG_RE.test(slug)) return new Response("Bad slug", { status: 400 });
        if (srv.upgrade(req, { data: { ws: legacyWs(), slug } }))
          return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/b/")) return handleBundleRoute(req);

      return new Response("Not found", { status: 404 });
    },

    websocket,
  });

  console.log(`Seer listening on ${config.baseUrl} (port ${server.port})`);
  // Log the absolute data path so a Railway volume's mount path can be verified
  // against it — they must match, or writes land on ephemeral disk.
  console.log(`Data dir: ${resolve(config.dataDir)} (mount your persistent volume here)`);

  // Graceful shutdown. Railway (and most platforms) send SIGTERM to the old
  // container on every redeploy. Without a handler the process is terminated
  // with a non-zero code (143), which the platform reports as a crash. Stop
  // the server, flush SQLite (WAL checkpoint on close), and exit 0 so a redeploy
  // is a clean handoff, not a "crash".
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[seer] ${signal} received — shutting down gracefully`);
    server.stop();
    try {
      db.close();
    } catch (err) {
      console.error("[seer] error closing database on shutdown:", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}
