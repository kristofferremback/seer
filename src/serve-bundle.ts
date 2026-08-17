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

/**
 * What the member's corner button needs to know about the page it stands on. Present
 * only when the viewer is a signed-in member of the bundle's workspace: an anonymous
 * reader of a public bundle, and every share holder, gets the bundle untouched.
 */
export interface OverlayInfo {
  wsId: string;
  slug: string;
  version: number;
  latestVersion: number;
  /** True when the URL pinned a version rather than following the latest. */
  pinned: boolean;
}

/** How this page was reached, which is the whole of what the two routes disagree about.
 *
 *  `shared` is not a synonym for "private": it says the reader holds a revocable token
 *  rather than a membership, and that is what decides caching. A pinned version's bytes
 *  never change, so on the workspace path they are immutable and cached forever — a
 *  statement about the content. Through a share, what revocation withdraws is not the
 *  content but the permission, and a year-long `public` cache entry is a copy of the
 *  bytes in an intermediary that no revocation can reach. So a shared page is `private`
 *  (no shared cache may keep it) and `no-cache` (the reader's own browser must ask
 *  again), pinned or not. */
export interface ServeContext {
  live: LiveChannel | null;
  shared: boolean;
  /** The member overlay, or absent for every viewer who is not a member. */
  overlay?: OverlayInfo;
}

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
 * The member's way back into Seer from inside a bundle: one small corner button,
 * drawn in a shadow root so the bundle's CSS cannot touch it and its CSS cannot
 * touch the bundle. A bundle that wants its own chrome keeps it — the button is a
 * quiet chip in the corner, and "Hide for this visit" takes even that away.
 *
 * It is injected only for a signed-in member (see OverlayInfo), which is also why
 * the share mint inside it works: /api/shares accepts the session the member
 * already carries.
 */
export function overlayScript(o: OverlayInfo): string {
  const cfg = JSON.stringify({
    ws: o.wsId,
    slug: o.slug,
    version: o.version,
    latest: o.latestVersion,
    pinned: o.pinned,
    base: `/${o.wsId}/b/${o.slug}/`,
  });
  // The script is served inside the bundle's own HTML, so it must not contain the
  // byte sequence that ends a script element; nothing below writes "</script".
  return `<script>(()=>{
if(window.__seerLens)return;window.__seerLens=1;
let off=false;try{off=sessionStorage.getItem("seer:lens:off")==="1"}catch(e){}
if(off)return;
const C=${cfg};
const host=document.createElement("div");
const root=host.attachShadow({mode:"closed"});
const mark='<svg viewBox="0 0 48 58" width="15" height="17" fill="none" aria-hidden="true"><circle cx="24" cy="21" r="15" stroke="currentColor" stroke-width="2.4"/><path d="M11 31 Q24 43 37 31" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M13.5 33 L18 50 M34.5 33 L30 50 M16 51 L32 51" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
root.innerHTML=\`<style>
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
[hidden]{display:none!important}
.lens{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.chip{width:32px;height:32px;border:0;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;background:rgba(23,17,18,.62);color:#efe9e7;opacity:.55;transition:opacity 140ms ease}
.chip:hover,.chip:focus-visible,.chip[aria-expanded="true"]{opacity:1}
.panel{display:none;width:236px;background:#1c1516;color:#e8e1df;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:6px;box-shadow:0 14px 34px rgba(0,0,0,.35);font-size:13px}
.panel.open{display:block}
.hd{padding:6px 8px 7px;font-family:ui-monospace,monospace;font-size:11px;color:#a99f9c;overflow-wrap:anywhere}
.it{display:block;width:100%;text-align:left;background:none;border:0;border-radius:7px;padding:7px 8px;color:#e8e1df;font-size:13px;cursor:pointer;text-decoration:none}
.it:hover,.it:focus-visible{background:rgba(255,255,255,.08)}
.sep{height:1px;background:rgba(255,255,255,.12);margin:5px 4px}
.vrow{display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px 6px}
.vrow a{font-family:ui-monospace,monospace;font-size:11px;color:#c9bfbc;text-decoration:none;border:1px solid rgba(255,255,255,.16);border-radius:5px;padding:1px 6px}
.vrow a:hover{color:#fff;border-color:rgba(255,255,255,.4)}
.share{padding:2px 8px 6px;display:none}
.share.open{display:block}
.share input{width:100%;font-family:ui-monospace,monospace;font-size:11px;padding:5px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:#e8e1df}
.share .note{font-size:11px;color:#a99f9c;margin:5px 0 0}
</style>
<div class="lens">
<div class="panel" role="menu" aria-label="Seer">
<p class="hd"></p>
<div class="sep"></div>
<a class="it" data-latest hidden>Open the latest</a>
<button class="it" type="button" data-copy>Copy link</button>
<button class="it" type="button" data-share>Create a share link</button>
<div class="share"><input type="text" readonly aria-label="The new share link"><p class="note">Shown once — only its hash is kept.</p></div>
<div class="sep"></div>
<div class="vrow" data-versions></div>
<a class="it" data-ws>Workspace bundles</a>
<div class="sep"></div>
<button class="it" type="button" data-hide>Hide for this visit</button>
</div>
<button class="chip" type="button" aria-expanded="false" aria-label="Seer, about this bundle">\${mark}</button>
</div>\`;
const q=(s)=>root.querySelector(s);
const panel=q(".panel"),chip=q(".chip");
q(".hd").textContent=C.slug+" \\u00b7 v"+C.version+(C.pinned?" of "+C.latest:"");
if(C.pinned){const l=q("[data-latest]");l.hidden=false;l.href=C.base;}
q("[data-ws]").href="/"+C.ws+"/bundles";
const vrow=q("[data-versions]");
for(let v=C.latest;v>Math.max(0,C.latest-5)&&v>=1;v--){
  const a=document.createElement("a");a.href=C.base+"v/"+v+"/";a.textContent="v"+v;vrow.append(a);
}
if(C.latest>5){const a=document.createElement("a");a.href="/"+C.ws+"/bundles";a.textContent="all";vrow.append(a);}
chip.addEventListener("click",()=>{const open=!panel.classList.contains("open");panel.classList.toggle("open",open);chip.setAttribute("aria-expanded",String(open));});
document.addEventListener("click",(e)=>{if(e.composedPath().indexOf(host)===-1){panel.classList.remove("open");chip.setAttribute("aria-expanded","false");}});
document.addEventListener("keydown",(e)=>{if(e.key==="Escape"){panel.classList.remove("open");chip.setAttribute("aria-expanded","false");}});
q("[data-copy]").addEventListener("click",async(ev)=>{
  const b=ev.currentTarget;
  try{await navigator.clipboard.writeText(location.origin+(C.pinned?C.base+"v/"+C.version+"/":C.base));b.textContent="Copied";}
  catch(e){b.textContent="Press \\u2318C on the URL";}
  setTimeout(()=>{b.textContent="Copy link";},1600);
});
q("[data-share]").addEventListener("click",async(ev)=>{
  const b=ev.currentTarget,box=q(".share"),input=box.querySelector("input");
  b.disabled=true;
  try{
    const res=await fetch("/api/shares",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspace:C.ws,kind:"bundle",target:C.slug,label:C.slug})});
    input.value=res.ok?(await res.json()).url:"Could not create a link ("+res.status+")";
  }catch(e){input.value="Could not create a link";}
  box.classList.add("open");input.focus();input.select();
  b.disabled=false;
});
q("[data-hide]").addEventListener("click",()=>{try{sessionStorage.setItem("seer:lens:off","1")}catch(e){};host.remove();});
document.body?document.body.append(host):document.documentElement.append(host);
})();</`+`script>`;
}

/**
 * One file out of an extracted bundle, or a 404 when the remainder names nothing.
 *
 * `ctx.live` is the channel the page listens on, and null for a pinned version. Latest
 * (unpinned) content changes underneath viewers on every upload, and the live-reload
 * push means a stale-asset window breaks reloads (new HTML, old CSS/JS) — so it is
 * never cached. Pinned /v/N/ content is immutable by construction: the injected social
 * tags derive only from that version's own fixed data. `ctx.shared` overrules both;
 * see ServeContext.
 */
export async function serveBundleFile(
  wsId: string,
  meta: BundleMeta,
  filePath: string,
  ctx: ServeContext,
): Promise<Response> {
  const { live } = ctx;
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

  const cacheControl = ctx.shared
    ? "private, no-cache"
    : live
      ? "no-cache"
      : "public, max-age=31536000, immutable";

  if (file.type.startsWith("text/html")) {
    let html = injectBundleMeta(await file.text(), meta);
    const scripts =
      (live ? liveReloadScript(live) : "") + (ctx.overlay ? overlayScript(ctx.overlay) : "");
    if (scripts) {
      html = html.includes("</body>")
        ? html.replace("</body>", `${scripts}</body>`)
        : html + scripts;
    }
    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": cacheControl },
    });
  }
  return new Response(file, { headers: { "cache-control": cacheControl } });
}
