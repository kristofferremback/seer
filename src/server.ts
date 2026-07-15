import type { Server, WebSocketHandler } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";
import { join, normalize } from "node:path";
import { config } from "./config";
import { getBundle, listBundles, listVersions, createVersion } from "./db";
import { inspectZip, saveZip, ensureExtracted } from "./store";
import { loginRedirect, handleCallback, requireSession, sessionEmail } from "./auth";
import { landingPage, bundlesPage, shellPage, skillDoc, type LedgerBundle, type ShellMeta } from "./pages";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

type WSData = { slug: string };

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
  slug: string,
  version: number,
  filePath: string,
  injectReload: boolean,
): Promise<Response> {
  const dir = await ensureExtracted(slug, version);
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

  const isHtml = file.type.startsWith("text/html");
  if (isHtml && injectReload) {
    const html = await file.text();
    const script = liveReloadScript(slug);
    const body = html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script;
    return new Response(body, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
    });
  }
  // Latest (unpinned) content changes underneath viewers on every upload, and the
  // live-reload push means a stale-asset window breaks reloads (new HTML, old CSS/JS)
  // — so everything is no-cache. Pinned /v/N/ content is immutable by construction.
  const cacheControl = injectReload ? "no-cache" : "public, max-age=31536000, immutable";
  return new Response(file, { headers: { "cache-control": cacheControl } });
}

/**
 * Is this /b/ request asking for an HTML document (a page a human navigates to)
 * rather than a sub-asset (css/js/image the page fetches)? Root, directories and
 * .html targets are documents; anything with another extension is an asset.
 */
function isHtmlDocRequest(rest: string | undefined): boolean {
  if (!rest || rest === "/" || rest.endsWith("/")) return true;
  const base = rest.slice(rest.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1) return true; // extensionless → treat as a document/directory
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === "html" || ext === "htm";
}

/**
 * Unauthenticated shell for /b/:slug/. Returns a 200 preview-gate page with
 * per-bundle OG tags. Policy: the same 200 status is returned whether or not the
 * slug exists, so status never leaks which slugs are real. Only the OG metadata
 * (version count, last-updated) is enriched for bundles that actually exist; the
 * slug itself is already known to the requester (it is in the URL they used), so
 * echoing it back leaks nothing. No file content is ever read here.
 */
function bundleShellResponse(slug: string, path: string): Response {
  const bundle = SLUG_RE.test(slug) ? getBundle(slug) : null;
  let meta: ShellMeta | null = null;
  if (bundle) {
    const versions = listVersions(slug);
    const updated = new Date(versions[0]?.created_at ?? bundle.created_at)
      .toISOString()
      .slice(0, 10);
    meta = { versions: bundle.latest_version, updated };
  }
  return new Response(shellPage(slug, path, meta), {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleBundleRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // /b/:slug[/v/:version]/rest...
  const match = url.pathname.match(/^\/b\/([^/]+)(?:\/v\/(\d+))?(\/.*)?$/);
  if (!match) return new Response("Not found", { status: 404 });
  const [, slug, versionStr, rest] = match;

  // No session: document requests get the OG shell + sign-in link; sub-asset
  // requests get the normal login redirect (they are re-fetched after auth).
  if (!sessionEmail(req)) {
    if (isHtmlDocRequest(rest)) return bundleShellResponse(slug!, url.pathname);
    return requireSession(req)!;
  }

  if (!SLUG_RE.test(slug!)) return new Response("Not found", { status: 404 });
  const bundle = getBundle(slug!);
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

  return serveBundleFile(slug!, version, rest.slice(1), !pinned);
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

  const version = createVersion(slug, body.length, files.length);
  await saveZip(slug, version, body);
  server.publish(`bundle:${slug}`, "reload");

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
  return listBundles().map((b) => {
    const versions = listVersions(b.slug);
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
  const websocket: WebSocketHandler<WSData> = {
    open(ws) {
      ws.subscribe(`bundle:${ws.data.slug}`);
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

      "/api/bundles": {
        GET: (req) => {
          const denied = requireApiToken(req);
          if (denied) return denied;
          return json(
            listBundles().map((b) => ({
              slug: b.slug,
              latestVersion: b.latest_version,
              url: `${config.baseUrl}/b/${b.slug}/`,
              versions: listVersions(b.slug).map((v) => ({
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
        // Viewers arrive here from an authed page, but the cookie rides along — check it.
        if (!sessionEmail(req)) return new Response("Unauthorized", { status: 401 });
        const slug = url.searchParams.get("slug") ?? "";
        if (!SLUG_RE.test(slug)) return new Response("Bad slug", { status: 400 });
        if (srv.upgrade(req, { data: { slug } })) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/b/")) return handleBundleRoute(req);

      return new Response("Not found", { status: 404 });
    },

    websocket,
  });

  console.log(`Seer listening on ${config.baseUrl} (port ${server.port})`);
  return server;
}
