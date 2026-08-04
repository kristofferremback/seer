// Serving a bundle's file tree. Two routes do this now — the workspace path
// `/<ws>/b/<slug>/…` and the share path `/s/<token>/…` — so the part that turns a
// remainder into bytes lives here rather than in either of them.
//
// What differs between the two is only where the page hangs and who may hear about a
// new upload; both travel as arguments rather than as a branch this file makes for
// itself. What is the same is everything that matters: the same extraction cache, the
// same index.html fallback, the same social tags, the same cache policy.

import { join, normalize } from "node:path";
import { ensureExtracted } from "./store";
import { injectBundleMeta, type BundleMeta } from "./pages";

export type { BundleMeta };

/**
 * The live-reload channel a moving page opens, or null for a pinned one.
 *
 * A workspace page names its workspace and slug and is authorised by the same rule
 * that served it. A shared page names only its token: the socket resolves the
 * workspace and slug from the share itself, so a holder cannot widen the channel by
 * editing the query, and a token that stops resolving stops reloading.
 */
export type LiveChannel =
  | { via: "workspace"; wsId: string; slug: string }
  | { via: "share"; token: string };

function liveReloadQuery(live: LiveChannel): string {
  return live.via === "share"
    ? `share=${encodeURIComponent(live.token)}`
    : `ws=${live.wsId}&slug=${live.slug}`;
}

export function liveReloadScript(live: LiveChannel): string {
  const query = liveReloadQuery(live);
  return `<script>(()=>{const c=()=>{const w=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws/livereload?${query}");w.onmessage=e=>{if(e.data==="reload")location.reload()};w.onclose=()=>setTimeout(c,2000)};c()})();</script>`;
}

/**
 * One file out of an extracted bundle, or a 404 when the remainder names nothing.
 *
 * `live` is the channel the page listens on, and null for a pinned version — which is
 * also what decides caching. Latest (unpinned) content changes underneath viewers on
 * every upload, and the live-reload push means a stale-asset window breaks reloads
 * (new HTML, old CSS/JS) — so everything is no-cache. Pinned /v/N/ content is
 * immutable by construction: the injected social tags derive only from that version's
 * own fixed data.
 */
export async function serveBundleFile(
  wsId: string,
  meta: BundleMeta,
  filePath: string,
  live: LiveChannel | null,
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

  const cacheControl = live ? "no-cache" : "public, max-age=31536000, immutable";

  if (file.type.startsWith("text/html")) {
    let html = injectBundleMeta(await file.text(), meta);
    if (live) {
      const script = liveReloadScript(live);
      html = html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script;
    }
    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": cacheControl },
    });
  }
  return new Response(file, { headers: { "cache-control": cacheControl } });
}
