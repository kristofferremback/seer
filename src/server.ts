import type { Server, WebSocketHandler } from "bun";
import { join, normalize, resolve } from "node:path";
import { config } from "./config";
import {
  db,
  getApiKey,
  getBundle,
  getImage,
  getVersion,
  getUser,
  getWorkspace,
  isMember,
  listBundles,
  listImages,
  listMembers,
  listUserKeys,
  listUserWorkspaces,
  listVersions,
  createImage,
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
import { inspectZip, saveZip, ensureExtracted, openImage, imageLocation, saveImage, s3 } from "./store";
import { migrateBlobsToS3 } from "./migrate-blobs";
import { IMG_NAME_RE, processImage, sniffOk, type ProcessedImage } from "./images";
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
import { IMG_ID_RE, INV_ID_RE, WS_ID_RE } from "./ids";
import { handlePublishReview } from "./overseer/routes";
import { handleReadReview } from "./overseer/read";
import { handleOverseerSkill } from "./overseer/skill";
import { handleAnnotation } from "./overseer/annotations";
import {
  handleRefreshReview,
  reviewTopic,
  setFreshnessPublisher,
} from "./overseer/freshness";
import { handleReviewAttachment, handleReviewPage } from "./overseer/render";
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
// well-formed /<ws_id>/b/ that doesn't resolve becomes a soft-404. The ws id class
// is composed from WS_ID_RE (minus its ^…$ anchors) so the two never drift apart.
const WS_BUNDLE_RE = new RegExp(`^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/b/`);
// Workspace-scoped image path: /<ws_id>/i/<img_id>/<filename>.
const WS_IMG_RE = new RegExp(`^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/i/`);
// Workspace-scoped review path: /<ws_id>/r/<slug>[/v/N | /a/<att_id>]. This is the
// URL publish hands back; the bare /r/<slug> routes resolve the same review across
// every workspace the reader can reach.
const WS_REVIEW_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)(?:/(v|a)/([^/]+))?/?$`,
);

// The write a review page makes, under the workspace that page is served from: the
// slug alone is ambiguous across workspaces, so the form posts the workspace with it.
const WS_ANNOTATIONS_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)/annotations/?$`,
);

// A live socket is either a bundle's reload channel or a review's freshness channel.
// The two are gated differently, so which one this is travels with the socket rather
// than being re-derived at subscribe time.
type WSData = { ws: string; slug: string; kind: "bundle" | "review" };

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

// Membership, whatever the workspace's visibility says. A review holds private source
// and is never served by visibility alone, so its live channel is not either.
function workspaceMember(ws: Workspace, req: Request): boolean {
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

// ---- images ----

// GitHub fetches every image embedded in a PR, issue, or README through its camo
// asset proxy, which sends no credentials — only this User-Agent. The UA is
// spoofable, so treat this as an availability carve-out, not an auth boundary:
// the unguessable img id in the path is what actually protects a private image.
function isGithubCamo(req: Request): boolean {
  return (req.headers.get("user-agent") ?? "").toLowerCase().includes("github-camo");
}

async function handleImageUpload(req: Request, filename: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  const match = filename.match(IMG_NAME_RE);
  if (!match) {
    return json(
      {
        error:
          "Filename must match [a-z0-9][a-z0-9._-]* (max 64 chars) and end in " +
          ".png, .jpg, .jpeg, .gif, .webp, .avif, or .svg",
      },
      400,
    );
  }
  const ext = match[1]!;

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return json({ error: "Empty body; send the image bytes as the request body" }, 400);
  if (body.length > config.maxUploadBytes) {
    return json({ error: `Image exceeds max size of ${config.maxUploadBytes} bytes` }, 413);
  }
  if (!sniffOk(ext, body)) {
    return json({ error: `Body does not look like a .${ext} file (magic bytes mismatch)` }, 400);
  }

  let img: ProcessedImage;
  try {
    img = await processImage(ext, filename, body);
  } catch (err) {
    return json({ error: `Could not decode image: ${(err as Error).message}` }, 400);
  }

  // Same ordering as bundles: row first, then bytes. The key resolves the workspace.
  const ws = auth.workspaceId;
  const id = createImage(ws, img.filename, img.contentType, img.data.length);
  await saveImage(ws, id, img.data);

  const url = `${config.baseUrl}/${ws}/i/${id}/${img.filename}`;
  return json({
    id,
    filename: img.filename,
    workspace: ws,
    url,
    markdown: `![${img.filename.replace(/\.[^.]+$/, "")}](${url})`,
    bytes: img.data.length,
    originalBytes: body.length,
    contentType: img.contentType,
  });
}

// Workspace-scoped image serving: /<ws_id>/i/<img_id>/<filename>. Same soft-404
// posture as bundles — denial, unknown id, and filename mismatch are all
// indistinguishable — with one deliberate exception: GitHub's camo proxy is always
// served, so an image pasted into a PR renders even from a private workspace.
async function handleWorkspaceImage(req: Request, wsId: string): Promise<Response> {
  const url = new URL(req.url);
  const [id, filename, ...extra] = url.pathname.slice(`/${wsId}/i/`.length).split("/");

  const ws = getWorkspace(wsId);
  if (!ws || !id || !filename || extra.length > 0 || !IMG_ID_RE.test(id)) {
    return softNotFound(req);
  }
  const image = getImage(id);
  if (!image || image.workspace_id !== wsId || image.filename !== filename) {
    return softNotFound(req);
  }
  if (!workspaceViewable(ws, req) && !isGithubCamo(req)) return softNotFound(req);

  const body = await openImage(wsId, image.id);
  if (body === null) {
    // A db row without its blob is corruption (or a mispointed store) — say so.
    console.error(`[seer] image ${image.id} has a db row but no blob at ${imageLocation(wsId, image.id)}`);
    return softNotFound(req);
  }

  const headers: Record<string, string> = {
    "content-type": image.content_type,
    "content-length": String(image.bytes),
    // An img id is minted once and never rewritten, so the URL is immutable.
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  // SVG can carry script; as an <img> it never runs, but this URL opened as a
  // top-level document would execute it on this origin. Neuter that.
  if (image.content_type === "image/svg+xml") {
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return new Response(body, { headers });
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

export async function startServer() {
  // Bring the database to the current schema (v2; bootstrapping the root workspace
  // on first boot) before the server binds — no request may hit an unmigrated db.
  migrate();
  // Then move any local blobs into S3 (no-op when already done or disk-only).
  // Runs before the server binds so requests never race a half-moved store.
  await migrateBlobsToS3();

  const websocket: WebSocketHandler<WSData> = {
    open(ws) {
      ws.subscribe(
        ws.data.kind === "review"
          ? reviewTopic(ws.data.ws, ws.data.slug)
          : `bundle:${ws.data.ws}:${ws.data.slug}`,
      );
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

      // The witness skill doc. Public, no auth, same contract as /skill.md: an agent
      // reads this before it publishes a review.
      "/overseer/skill.md": () => handleOverseerSkill(),

      // Overseer: a review is authored in one shot, so publishing is one POST.
      "/api/reviews": {
        POST: (req) => handlePublishReview(req),
      },
      // Reading takes a bare slug, resolved across the caller's workspaces: the
      // renderer and the witness both hold a slug, not a workspace id.
      "/api/reviews/:slug": {
        GET: (req) => handleReadReview(req, req.params.slug, null),
      },
      // The one thing written to a review after publication. A member files, an API
      // key answers, and the route decides which by the body it was sent.
      "/api/reviews/:slug/annotations": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          return handleAnnotation(req, req.params.slug);
        },
      },
      "/api/reviews/:slug/refresh": {
        POST: (req) => handleRefreshReview(req, req.params.slug),
      },
      "/api/reviews/:slug/v/:n": {
        GET: (req) => handleReadReview(req, req.params.slug, req.params.n),
      },

      // The review itself, as a page. Same gate as the JSON, same soft-404.
      "/r/:slug": {
        GET: (req) => handleReviewPage(req, req.params.slug, null),
      },
      "/r/:slug/v/:n": {
        GET: (req) => handleReviewPage(req, req.params.slug, req.params.n),
      },
      "/r/:slug/a/:id": {
        GET: (req) => handleReviewAttachment(req, req.params.slug, req.params.id),
      },

      "/api/images": {
        GET: (req) => {
          const auth = requireApiKey(req);
          if (auth instanceof Response) return auth;
          const ws = auth.workspaceId;
          return json(
            listImages(ws).map((i) => ({
              id: i.id,
              filename: i.filename,
              workspace: ws,
              url: `${config.baseUrl}/${ws}/i/${i.id}/${i.filename}`,
              bytes: i.bytes,
              contentType: i.content_type,
              createdAt: new Date(i.created_at).toISOString(),
            })),
          );
        },
      },
      "/api/images/:filename": {
        PUT: (req) => handleImageUpload(req, req.params.filename),
        POST: (req) => handleImageUpload(req, req.params.filename),
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
        const kind = url.searchParams.get("kind") === "review" ? "review" : "bundle";
        if (!WS_ID_RE.test(wsId) || !SLUG_RE.test(slug)) {
          return new Response("Bad request", { status: 400 });
        }
        // Same access rule as serving: only upgrade when the viewer could view it. A
        // review channel is stricter than a bundle's: a public workspace serves its
        // bundles to anyone, but a review holds private source, so this one asks for
        // membership rather than viewability.
        const ws = getWorkspace(wsId);
        if (!ws) return new Response("Not found", { status: 404 });
        const allowed = kind === "review" ? workspaceMember(ws, req) : workspaceViewable(ws, req);
        if (!allowed) return new Response("Not found", { status: 404 });
        if (srv.upgrade(req, { data: { ws: wsId, slug, kind } }))
          return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const wsBundle = url.pathname.match(WS_BUNDLE_RE);
      if (wsBundle) return handleWorkspaceBundle(req, wsBundle[1]!);

      const wsImage = url.pathname.match(WS_IMG_RE);
      if (wsImage) return handleWorkspaceImage(req, wsImage[1]!);

      const wsAnnotations = url.pathname.match(WS_ANNOTATIONS_RE);
      if (wsAnnotations) {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (!originOk(req)) return new Response("Bad origin", { status: 403 });
        return handleAnnotation(req, wsAnnotations[2]!, wsAnnotations[1]!);
      }

      const wsReview = url.pathname.match(WS_REVIEW_RE);
      if (wsReview) {
        const [, wsId, slug, part, value] = wsReview;
        if (part === "a") return handleReviewAttachment(req, slug!, value!, wsId!);
        return handleReviewPage(req, slug!, part === "v" ? value! : null, wsId!);
      }

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

  // Freshness pushes go out over this server's sockets. Handed in rather than imported
  // so the freshness module never has to know a server exists to be tested.
  setFreshnessPublisher((topic, message) => {
    server.publish(topic, message);
  });

  console.log(`Seer listening on ${config.baseUrl} (port ${server.port})`);
  // Log the absolute data path so a Railway volume's mount path can be verified
  // against it — they must match, or writes land on ephemeral disk.
  console.log(`Data dir: ${resolve(config.dataDir)} (SQLite + extraction cache)`);
  console.log(
    s3
      ? `Blob store: s3://${config.s3!.bucket} (${config.s3!.region ?? config.s3!.endpoint})`
      : "Blob store: local disk (set S3_BUCKET to use S3)",
  );

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
