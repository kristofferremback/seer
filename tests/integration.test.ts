import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

// Env is set by tests/setup.ts (preload) before these app modules import.
import { startServer } from "../src/server";
import { sweepCache } from "../src/store";
import { config } from "../src/config";
import { legacyWorkspaceId } from "../src/db";

const AUTH = { authorization: `Bearer ${config.apiToken}` };

let server: ReturnType<typeof startServer>;
let base: string;
let wsId: string;
// Workspace-scoped bundle URL for the bootstrap workspace uploads land in.
const wb = (p: string) => `${base}/${wsId}/b/${p}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

beforeAll(() => {
  server = startServer();
  base = `http://localhost:${server.port}`;
  wsId = legacyWorkspaceId()!;
});

afterAll(() => {
  server.stop(true);
});

// ---- zip helpers ----

function htmlZip(body: string, extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "index.html": strToU8(`<!doctype html><html><body>${body}</body></html>`),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

function put(slug: string, data: Uint8Array | string, headers: Record<string, string> = AUTH) {
  return fetch(`${base}/api/bundles/${slug}`, { method: "PUT", headers, body: data });
}

// ---- 1. upload flow ----

describe("upload flow", () => {
  test("PUT zip -> version 1, re-upload -> version 2, JSON shape", async () => {
    const slug = "upload-flow";

    const r1 = await put(slug, htmlZip("v1", { "app.js": "console.log(1)" }));
    expect(r1.status).toBe(200);
    const j1 = await readJson(r1);
    expect(j1.version).toBe(1);
    expect(j1.slug).toBe(slug);
    expect(j1.hasIndexHtml).toBe(true);
    expect(j1.url).toContain(`/b/${slug}/`);
    expect(j1.versionUrl).toContain(`/b/${slug}/v/1/`);
    expect(j1.files).toBe(2);

    const r2 = await put(slug, htmlZip("v2"));
    expect(r2.status).toBe(200);
    const j2 = await readJson(r2);
    expect(j2.version).toBe(2);
    expect(j2.versionUrl).toContain(`/b/${slug}/v/2/`);
  });

  test("zip without index.html -> hasIndexHtml false", async () => {
    const zip = zipSync({ "readme.txt": strToU8("hi") });
    const r = await put("no-index", zip);
    const j = await readJson(r);
    expect(j.hasIndexHtml).toBe(false);
  });

  test("POST works like PUT (creates a version)", async () => {
    const r = await fetch(`${base}/api/bundles/post-upload`, {
      method: "POST",
      headers: AUTH,
      body: htmlZip("posted"),
    });
    expect(r.status).toBe(200);
    const j = await readJson(r);
    expect(j.version).toBe(1);
    expect(j.slug).toBe("post-upload");
    const served = await fetch(`${base}/b/post-upload/`);
    expect(await served.text()).toContain("posted");
  });
});

// ---- landing + ledger ----

describe("landing page", () => {
  test("GET / -> 200 public landing with og:title, no auth required", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Seer");
    expect(html).toContain('property="og:title"');
    expect(html).toContain('content="website"'); // og:type
    // It is the pamphlet, not the bundle ledger.
    expect(html).toContain("github.com/kristofferremback/seer");
    expect(html).toContain("mailto:kristoffer.remback@gmail.com");
  });

  test("GET /og.png -> 200 image/png", async () => {
    const r = await fetch(`${base}/og.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("agent skill doc", () => {
  test("GET /skill.md -> 200 text/markdown with configured base URL and bearer header, no auth", async () => {
    const r = await fetch(`${base}/skill.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const md = await r.text();
    // The copy-pasteable upload curl carries the configured base URL and bearer header.
    expect(md).toContain(`${config.baseUrl}/api/bundles/`);
    expect(md).toContain(`-H "Authorization: Bearer $API_TOKEN"`);
    expect(md).toContain("--data-binary @bundle.zip");
  });

  test("GET /llms.txt -> identical body to /skill.md", async () => {
    const skill = await (await fetch(`${base}/skill.md`)).text();
    const r = await fetch(`${base}/llms.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await r.text()).toBe(skill);
  });

  test("landing HTML advertises the doc (alternate link + colophon anchor)", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/skill.md">');
    expect(html).toContain('href="/skill.md"');
  });
});

describe("bundle ledger", () => {
  test("GET /bundles (auth disabled) -> 200 listing an uploaded bundle", async () => {
    await put("ledger-listed", htmlZip("hello"));
    const r = await fetch(`${base}/bundles`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("ledger-listed");
    expect(html).toContain("Bundles");
  });
});

// ---- 2. API auth ----

describe("API auth", () => {
  test("missing bearer token -> 401", async () => {
    const r = await put("auth-missing", htmlZip("x"), {});
    expect(r.status).toBe(401);
  });

  test("wrong bearer token -> 401", async () => {
    const r = await put("auth-wrong", htmlZip("x"), { authorization: "Bearer nope" });
    expect(r.status).toBe(401);
  });

  test("GET /api/bundles requires token", async () => {
    expect((await fetch(`${base}/api/bundles`)).status).toBe(401);
    const ok = await fetch(`${base}/api/bundles`, { headers: AUTH });
    expect(ok.status).toBe(200);
  });
});

// ---- 3. slug validation ----

describe("slug validation", () => {
  // These reach handleUpload as a single slug segment and fail SLUG_RE -> 400.
  for (const bad of ["UPPER", "has.dot", "-leading", "with space", "under_score"]) {
    test(`bad slug ${JSON.stringify(bad)} -> 400`, async () => {
      const r = await put(bad, htmlZip("x"));
      expect(r.status).toBe(400);
    });
  }

  test("slug with a path separator never matches the route -> 404", async () => {
    // /api/bundles/has/slash has an extra path segment, so routing 404s before validation.
    const r = await put("has/slash", htmlZip("x"));
    expect(r.status).toBe(404);
  });

  test("valid slug accepted", async () => {
    const r = await put("good-slug-123", htmlZip("x"));
    expect(r.status).toBe(200);
  });
});

// ---- 4. zip validation ----

describe("zip validation", () => {
  test("garbage body -> 400", async () => {
    const r = await put("garbage", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.status).toBe(400);
  });

  test("empty body -> 400", async () => {
    const r = await put("empty", new Uint8Array(0));
    expect(r.status).toBe(400);
  });

  test("zip-slip path ../evil.txt -> 400", async () => {
    const zip = zipSync({ "../evil.txt": strToU8("pwned"), "index.html": strToU8("<html></html>") });
    const r = await put("zipslip", zip);
    expect(r.status).toBe(400);
    const j = await readJson(r);
    expect(j.error).toContain("Unsafe path");
  });

  test("zip with only directory entries -> 400 (no files)", async () => {
    const zip = zipSync({ "dir/": strToU8("") });
    const r = await put("emptyzip", zip);
    expect(r.status).toBe(400);
  });
});

// ---- 5 & 6. serving + pinning ----

describe("serving", () => {
  const slug = "serve-me";

  beforeAll(async () => {
    // v1: distinct old content + a css asset
    await put(
      slug,
      htmlZip("OLD-V1-CONTENT", {
        "style.css": "body { color: red; }",
        "sub/index.html": "<!doctype html><html><body>SUB</body></html>",
      }),
    );
    // v2 becomes latest (with an asset so latest-asset caching is testable)
    await put(slug, htmlZip("NEW-V2-CONTENT", { "style.css": "body { color: blue; }" }));
  });

  test("GET /<ws>/b/:slug/ serves latest index.html with scoped live-reload script", async () => {
    const r = await fetch(wb(`${slug}/`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("NEW-V2-CONTENT");
    expect(html).toContain(`/ws/livereload?ws=${wsId}&slug=${slug}`);
    expect(html).toContain("WebSocket");
  });

  test("pinned /<ws>/b/:slug/v/1/ serves OLD content WITHOUT script", async () => {
    const r = await fetch(wb(`${slug}/v/1/`));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("OLD-V1-CONTENT");
    expect(html).not.toContain("/ws/livereload");
  });

  test("nested css asset served with sensible content-type", async () => {
    const r = await fetch(wb(`${slug}/v/1/style.css`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    expect(await r.text()).toContain("color: red");
  });

  test("latest (unpinned) files are all no-cache, assets included", async () => {
    // Live reload pushes fresh HTML on upload; assets cached with max-age would give
    // the reloaded page stale CSS/JS, so latest serves everything with no-cache.
    const html = await fetch(wb(`${slug}/`));
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const css = await fetch(wb(`${slug}/style.css`));
    expect(css.status).toBe(200);
    expect(css.headers.get("cache-control")).toBe("no-cache");
    expect(await css.text()).toContain("color: blue");
  });

  test("pinned /v/N/ files are immutable, HTML included", async () => {
    const immutable = "public, max-age=31536000, immutable";
    const html = await fetch(wb(`${slug}/v/1/`));
    expect(html.headers.get("cache-control")).toBe(immutable);
    const css = await fetch(wb(`${slug}/v/1/style.css`));
    expect(css.headers.get("cache-control")).toBe(immutable);
  });

  test("directory request falls back to index.html", async () => {
    const r = await fetch(wb(`${slug}/v/1/sub/`));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("SUB");
  });

  test("missing file -> 404", async () => {
    const r = await fetch(wb(`${slug}/v/1/nope.html`));
    expect(r.status).toBe(404);
  });

  test("no trailing slash -> 302 to trailing slash", async () => {
    const r = await fetch(wb(slug), { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain(`/${wsId}/b/${slug}/`);
  });

  test("path traversal attempt -> 404", async () => {
    // Note: fetch/URL normalizes literal "../" segments client-side, so a literal
    // /b/slug/../../ never reaches the server as written. The percent-encoded form
    // below arrives intact; the server does not percent-decode paths, so it 404s as
    // a nonexistent file rather than via serveBundleFile's startsWith("..") guard —
    // the guard itself is belt-and-suspenders behind URL normalization.
    const r = await fetch(wb(`${slug}/v/1/%2e%2e%2f%2e%2e%2fsecret`), { redirect: "manual" });
    expect(r.status).toBe(404);
  });

  test("unknown slug -> soft-404", async () => {
    const r = await fetch(wb("does-not-exist/"));
    expect(r.status).toBe(404);
  });

  test("version pinning /<ws>/b/:slug/v/999/ -> soft-404", async () => {
    const r = await fetch(wb(`${slug}/v/999/`));
    expect(r.status).toBe(404);
  });
});

// ---- legacy /b/ 301 redirects ----

describe("legacy /b/ redirects", () => {
  test("301 to the legacy workspace, preserving version, path, and query", async () => {
    const r = await fetch(`${base}/b/serve-me/v/2/style.css?x=1&y=two`, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`/${wsId}/b/serve-me/v/2/style.css?x=1&y=two`);
  });

  test("301 for the bare bundle root, preserving the trailing slash", async () => {
    const r = await fetch(`${base}/b/serve-me/`, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`/${wsId}/b/serve-me/`);
  });

  test("301 even for an unknown slug (the workspace, not the bundle, is resolved)", async () => {
    const r = await fetch(`${base}/b/no-such-bundle/`, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`/${wsId}/b/no-such-bundle/`);
  });

  test("following the redirect lands on the served bundle", async () => {
    const r = await fetch(`${base}/b/serve-me/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("NEW-V2-CONTENT");
  });
});

// ---- social tags on served bundles ----

describe("bundle social tags", () => {
  test("bundle without og tags gets Seer og tags; title decoded from <title>", async () => {
    const slug = "og-inject";
    const page = `<!doctype html><html><head><title>Voice &amp; Video Calls &mdash; Plan</title></head><body>hi</body></html>`;
    await put(slug, zipSync({ "index.html": strToU8(page) }));

    const html = await (await fetch(wb(`${slug}/`))).text();
    // Entities decoded once, then escaped once for the attribute: &amp; -> & -> &amp;,
    // &mdash; -> a literal em dash.
    expect(html).toContain('<meta property="og:title" content="Voice &amp; Video Calls — Plan">');
    expect(html).toContain('<meta property="og:site_name" content="Seer">');
    expect(html).toContain('<meta property="og:image" content="');
    expect(html).toContain("/og.png");
    expect(html).toMatch(/og:description" content="An HTML bundle previewed on Seer — v1, updated \d{4}-\d{2}-\d{2}\."/);
    expect(html).toContain(`<meta property="og:url" content="${config.baseUrl}/${wsId}/b/${slug}/">`);
    // Injected into the real head.
    expect(html.indexOf("og:title")).toBeLessThan(html.indexOf("</head>"));
  });

  test("head-less page still gets tags; empty title falls back to slug", async () => {
    const slug = "og-headless";
    await put(slug, htmlZip("no head here"));
    const html = await (await fetch(wb(`${slug}/`))).text();
    expect(html).toContain(`<meta property="og:title" content="${slug}">`);
    expect(html).toContain('<meta property="og:site_name" content="Seer">');
  });

  test("bundle with its own og tags is left alone", async () => {
    const slug = "og-own";
    const page = `<!doctype html><html><head><title>Mine</title><meta property="og:title" content="My Own Title"></head><body>x</body></html>`;
    await put(slug, zipSync({ "index.html": strToU8(page) }));
    const html = await (await fetch(wb(`${slug}/`))).text();
    expect(html).toContain('content="My Own Title"');
    expect(html).not.toContain('og:site_name');
    expect(html.match(/og:title/g)?.length).toBe(1);
  });

  test("pinned URL gets pinned og:url and version in description", async () => {
    const slug = "og-pinned";
    const page = (v: string) =>
      `<!doctype html><html><head><title>Pinned ${v}</title></head><body>${v}</body></html>`;
    await put(slug, zipSync({ "index.html": strToU8(page("one")) }));
    await put(slug, zipSync({ "index.html": strToU8(page("two")) }));

    const pinned = await (await fetch(wb(`${slug}/v/1/`))).text();
    expect(pinned).toContain(`<meta property="og:url" content="${config.baseUrl}/${wsId}/b/${slug}/v/1/">`);
    expect(pinned).toContain("— v1, updated");

    const latest = await (await fetch(wb(`${slug}/`))).text();
    expect(latest).toContain(`<meta property="og:url" content="${config.baseUrl}/${wsId}/b/${slug}/">`);
    expect(latest).toContain("— v2, updated");
  });
});

// ---- 8. websocket live reload ----

describe("websocket live reload", () => {
  test("client receives 'reload' when a new version is uploaded", async () => {
    const slug = "ws-reload";
    await put(slug, htmlZip("initial"));

    const wsUrl = `ws://localhost:${server.port}/ws/livereload?ws=${wsId}&slug=${slug}`;
    const ws = new WebSocket(wsUrl);

    const opened = new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
    });
    const gotReload = new Promise<string>((res) => {
      ws.onmessage = (e) => res(String(e.data));
    });

    await opened;
    await put(slug, htmlZip("updated"));

    const msg = await Promise.race([
      gotReload,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    expect(msg).toBe("reload");
    ws.close();
  });

  test("websocket with bad slug -> 400", async () => {
    const r = await fetch(`${base}/ws/livereload?slug=BAD.SLUG`);
    expect(r.status).toBe(400);
  });
});

// ---- 9. cache sweep ----

describe("cache sweep", () => {
  test("sweepCache() evicts extracted dir, next GET re-extracts", async () => {
    const slug = "sweep-me";
    await put(slug, htmlZip("cached"));

    // Trigger extraction.
    const r1 = await fetch(`${base}/b/${slug}/v/1/`);
    expect(r1.status).toBe(200);

    const extractedPath = join(config.dataDir, "cache", legacyWorkspaceId()!, slug, "1");
    expect(existsSync(extractedPath)).toBe(true);

    // CACHE_TTL_MS=0 in setup, so this entry is stale; give lastAccess time to be < now.
    await new Promise((r) => setTimeout(r, 5));
    sweepCache();
    expect(existsSync(extractedPath)).toBe(false);

    // Re-extraction on demand still works.
    const r2 = await fetch(`${base}/b/${slug}/v/1/`);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain("cached");
    expect(existsSync(extractedPath)).toBe(true);
  });
});
