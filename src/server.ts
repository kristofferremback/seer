import type { Server, WebSocketHandler } from "bun";
import { join, normalize, resolve } from "node:path";
import { config } from "./config";
import {
  db,
  getApiKey,
  getBundle,
  getVersion,
  getUser,
  getWorkspace,
  isMember,
  listBundles,
  listMembers,
  listUserKeys,
  listUserWorkspaces,
  listVersions,
  createInvite,
  createVersion,
  createWorkspace,
  mintApiKey,
  revokeApiKey,
  rollApiKey,
  setWorkspaceName,
  setWorkspaceVisibility,
  legacyWorkspaceId,
  type Workspace,
} from "./db";
import { migrate } from "./migrate";
import { inspectZip, saveZip, ensureExtracted } from "./store";
import {
  acceptInvite,
  loginRedirect,
  handleCallback,
  lookupValidInvite,
  requireApiKey,
  requireSession,
  sessionEmail,
  sessionUser,
  type SessionUser,
} from "./auth";
import { INV_ID_RE, WS_ID_RE } from "./ids";
import {
  landingPage,
  bundlesPage,
  invitePage,
  settingsPage,
  skillDoc,
  softNotFoundPage,
  injectBundleMeta,
  type BundleMeta,
  type LedgerGroup,
  type SettingsReveal,
} from "./pages";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Workspace-scoped bundle path: /<ws_id>/b/<slug>[/v/N][/rest]. Anything under a
// well-formed /<ws_id>/b/ that doesn't resolve becomes a soft-404.
const WS_BUNDLE_RE = /^\/(ws_[0-9abcdefghjkmnpqrstvwxyz]{10})\/b\//;

type WSData = { ws: string; slug: string };

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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

// See other: turn a mutation POST into a plain GET of the redirect target.
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// ---- mutation guards ----

// CSRF posture: SameSite=Lax session cookie + POST-only mutations, plus this
// origin check. When an Origin/Referer header is present its host must match
// BASE_URL's; a cross-site form post is refused. Absent headers pass (native
// tooling, same-origin navigations that omit them). Deliberately slop-tier.
function originOk(req: Request): boolean {
  const src = req.headers.get("origin") ?? req.headers.get("referer");
  if (!src) return true;
  try {
    return new URL(src).host === new URL(config.baseUrl).host;
  } catch {
    return false;
  }
}

// A mutation must come from a signed-in member of the target workspace. No session
// → 403; unknown ws or non-member → 404 (a non-member learns nothing about the ws).
function requireMember(req: Request, wsId: string): SessionUser | Response {
  const user = sessionUser(req);
  if (!user) return new Response("Sign in required", { status: 403 });
  if (!WS_ID_RE.test(wsId) || !isMember(wsId, user.id)) {
    return new Response("Not found", { status: 404 });
  }
  return user;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// Render the settings page for a member, optionally with a one-time reveal box.
function settingsResponse(wsId: string, user: SessionUser, reveal?: SettingsReveal): Response {
  const ws = getWorkspace(wsId)!;
  return html(
    settingsPage({
      wsId,
      name: ws.name,
      visibility: ws.visibility,
      email: user.email,
      members: listMembers(wsId).map((m) => ({
        email: m.email,
        id: m.id,
        joined: fmtDate(m.created_at),
        isYou: m.id === user.id,
      })),
      keys: listUserKeys(user.id, wsId).map((k) => ({
        id: k.id,
        name: k.name,
        hint: k.token_hint,
        created: fmtDate(k.created_at),
        lastUsed: k.last_used_at ? fmtDateTime(k.last_used_at) : "never",
        isLegacy: !!k.is_legacy,
      })),
      reveal,
    }),
  );
}

// ---- access ----

// A workspace is viewable by anyone when public; a private workspace only by its
// members. The same rule gates page serving and the live-reload socket.
function workspaceViewable(ws: Workspace, req: Request): boolean {
  if (ws.visibility === "public") return true;
  const user = sessionUser(req);
  return user ? isMember(ws.id, user.id) : false;
}

function softNotFound(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });
}

// ---- live reload ----

function liveReloadScript(wsId: string, slug: string): string {
  return `<script>(()=>{const c=()=>{const w=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws/livereload?ws=${wsId}&slug=${slug}");w.onmessage=e=>{if(e.data==="reload")location.reload()};w.onclose=()=>setTimeout(c,2000)};c()})();</script>`;
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
      const script = liveReloadScript(wsId, meta.slug);
      html = html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script;
    }
    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": cacheControl },
    });
  }
  return new Response(file, { headers: { "cache-control": cacheControl } });
}

// Workspace-scoped serving: /<ws_id>/b/<slug>[/v/N][/rest]. Public workspaces serve
// anyone; private ones only members. Every denial, unknown workspace, unknown bundle,
// or out-of-range version resolves to the same soft-404 — forbidden and missing are
// indistinguishable, so a private workspace leaks nothing to a non-member.
async function handleWorkspaceBundle(req: Request, wsId: string): Promise<Response> {
  const url = new URL(req.url);
  const tail = url.pathname.slice(`/${wsId}/b/`.length);
  const match = tail.match(/^([^/]+)(?:\/v\/(\d+))?(\/.*)?$/);

  const ws = getWorkspace(wsId);
  if (!ws || !workspaceViewable(ws, req) || !match) return softNotFound(req);
  const [, slug, versionStr, rest] = match;
  if (!SLUG_RE.test(slug!)) return softNotFound(req);

  const bundle = getBundle(wsId, slug!);
  if (!bundle) return softNotFound(req);

  const pinned = versionStr !== undefined;
  const version = pinned ? Number(versionStr) : bundle.latest_version;
  if (pinned && (version < 1 || version > bundle.latest_version)) return softNotFound(req);

  // Require a trailing slash on the bundle root so relative asset URLs resolve.
  if (rest === undefined) {
    return new Response(null, { status: 302, headers: { location: `${url.pathname}/${url.search}` } });
  }

  const meta: BundleMeta = {
    slug: slug!,
    version,
    updatedAt: getVersion(wsId, slug!, version)?.created_at ?? bundle.created_at,
    url: `${config.baseUrl}${url.pathname}`,
  };
  return serveBundleFile(wsId, meta, rest.slice(1), !pinned);
}

// ---- upload ----

async function handleUpload(req: Request, slug: string, server: Server<WSData>): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
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

  // The key resolves the workspace: the upload lands wherever the key belongs.
  const ws = auth.workspaceId;
  const version = createVersion(ws, slug, body.length, files.length);
  await saveZip(ws, slug, version, body);
  server.publish(`bundle:${ws}:${slug}`, "reload");

  return json({
    slug,
    version,
    workspace: ws,
    url: `${config.baseUrl}/${ws}/b/${slug}/`,
    versionUrl: `${config.baseUrl}/${ws}/b/${slug}/v/${version}/`,
    bytes: body.length,
    files: files.length,
    hasIndexHtml: files.includes("index.html"),
  });
}

// ---- bundle ledger (signed-in view data) ----

// The ledger, grouped by the session user's workspaces. Each group carries that
// workspace's own bundles; the page scopes every URL to the group's ws id.
function ledgerGroups(userId: string): LedgerGroup[] {
  return listUserWorkspaces(userId).map((ws) => ({
    wsId: ws.id,
    name: ws.name,
    visibility: ws.visibility,
    bundles: listBundles(ws.id).map((b) => {
      const versions = listVersions(ws.id, b.slug);
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
    }),
  }));
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

      // The signed-in ledger of held bundles, grouped by the user's workspaces.
      "/bundles": (req) => {
        const user = sessionUser(req);
        if (!user) return requireSession(req)!;
        return new Response(bundlesPage(user.email, ledgerGroups(user.id)), {
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
          const auth = requireApiKey(req);
          if (auth instanceof Response) return auth;
          const ws = auth.workspaceId;
          return json(
            listBundles(ws).map((b) => ({
              slug: b.slug,
              latestVersion: b.latest_version,
              workspace: ws,
              url: `${config.baseUrl}/${ws}/b/${b.slug}/`,
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

      // ---- workspace + settings mutations (session + membership; Origin guard) ----

      "/workspaces": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const user = sessionUser(req);
          if (!user) return new Response("Sign in required", { status: 403 });
          const name = String((await req.formData()).get("name") ?? "").trim();
          if (!name || name.length > 80) return new Response("Invalid workspace name", { status: 400 });
          const id = createWorkspace(name, user.id);
          return redirect(`/settings/${id}`);
        },
      },

      "/settings/:ws": {
        GET: (req) => {
          const wsId = req.params.ws;
          const user = sessionUser(req);
          if (!user) return requireSession(req)!;
          if (!WS_ID_RE.test(wsId) || !isMember(wsId, user.id)) return softNotFound(req);
          return settingsResponse(wsId, user);
        },
      },

      "/settings/:ws/name": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const name = String((await req.formData()).get("name") ?? "").trim();
          if (!name || name.length > 80) return new Response("Invalid name", { status: 400 });
          setWorkspaceName(req.params.ws, name);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      "/settings/:ws/visibility": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const v = String((await req.formData()).get("visibility") ?? "");
          if (v !== "public" && v !== "private") return new Response("Invalid visibility", { status: 400 });
          setWorkspaceVisibility(req.params.ws, v);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      "/settings/:ws/invites": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const { token, expiresAt } = createInvite(req.params.ws, gate.id);
          return settingsResponse(req.params.ws, gate, {
            kind: "invite",
            url: `${config.baseUrl}/invite/${token}`,
            expires: fmtDate(expiresAt),
          });
        },
      },

      "/settings/:ws/keys": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const name = String((await req.formData()).get("name") ?? "").trim() || "unnamed key";
          if (name.length > 80) return new Response("Invalid key name", { status: 400 });
          const { token } = mintApiKey(gate.id, req.params.ws, name);
          return settingsResponse(req.params.ws, gate, { kind: "key", token });
        },
      },

      "/settings/:ws/keys/:keyId/roll": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          // Ownership is enforced inside rollApiKey (key must be the caller's in this ws).
          const rolled = rollApiKey(req.params.keyId, gate.id, req.params.ws);
          if (!rolled) return new Response("Not found", { status: 404 });
          return settingsResponse(req.params.ws, gate, { kind: "key", token: rolled.token });
        },
      },

      "/settings/:ws/keys/:keyId/revoke": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const key = getApiKey(req.params.keyId);
          if (!key || key.user_id !== gate.id || key.workspace_id !== req.params.ws) {
            return new Response("Not found", { status: 404 });
          }
          revokeApiKey(req.params.keyId);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      // Public invite page. A valid, unaccepted, unexpired token renders the invite;
      // a signed-in viewer gets a one-click accept, a signed-out one a Google sign-in
      // that carries the invite as `next`. Anything invalid is a soft-404 (an oracle
      // for used/expired/unknown tokens would leak which workspaces exist).
      "/invite/:token": {
        GET: (req) => {
          const token = req.params.token;
          if (!INV_ID_RE.test(token)) return softNotFound(req);
          const inv = lookupValidInvite(token);
          if (!inv) return softNotFound(req);
          const ws = getWorkspace(inv.workspace_id);
          const inviter = getUser(inv.created_by);
          if (!ws) return softNotFound(req);
          return html(
            invitePage({
              token,
              workspaceName: ws.name,
              inviterEmail: inviter?.email ?? "a member",
              expires: fmtDate(inv.expires_at),
              signedIn: !!sessionUser(req),
            }),
          );
        },
      },

      // A signed-in user accepts an invite (new members join via the OIDC path).
      "/invite/:token/accept": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const token = req.params.token;
          if (!INV_ID_RE.test(token)) return softNotFound(req);
          const user = sessionUser(req);
          if (!user) return new Response("Sign in required", { status: 403 });
          // Invalid, expired, or used token is indistinguishable from missing.
          if (!acceptInvite(token, user.email)) return softNotFound(req);
          return redirect("/bundles");
        },
      },
    },

    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws/livereload") {
        const wsId = url.searchParams.get("ws") ?? "";
        const slug = url.searchParams.get("slug") ?? "";
        if (!WS_ID_RE.test(wsId) || !SLUG_RE.test(slug)) {
          return new Response("Bad request", { status: 400 });
        }
        // Same access rule as serving: only upgrade when the viewer could view it.
        const ws = getWorkspace(wsId);
        if (!ws || !workspaceViewable(ws, req)) return new Response("Not found", { status: 404 });
        if (srv.upgrade(req, { data: { ws: wsId, slug } }))
          return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const wsBundle = url.pathname.match(WS_BUNDLE_RE);
      if (wsBundle) return handleWorkspaceBundle(req, wsBundle[1]!);

      // Legacy /b/<slug>[...] → 301 to the bootstrap workspace, preserving the full
      // remainder and query. No legacy workspace recorded → a plain 404.
      if (url.pathname.startsWith("/b/")) {
        const ws = legacyWorkspaceId();
        if (!ws) return new Response("Not found", { status: 404 });
        const remainder = url.pathname.slice("/b/".length);
        return new Response(null, {
          status: 301,
          headers: { location: `/${ws}/b/${remainder}${url.search}` },
        });
      }

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
