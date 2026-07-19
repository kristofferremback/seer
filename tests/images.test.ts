import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import sharp, { type Sharp } from "sharp";

// Env is set by tests/setup.ts (AUTH_DISABLED=true → sessionUser resolves to the
// root user). Everything here runs as the root user against root-owned
// workspaces; no extra users are inserted, because the db is shared with the
// other in-process test files. The cross-user visibility matrix (non-member
// soft-404, the github-camo carve-out) needs real forged sessions and lives in
// serving-matrix.script.ts.
import { startServer } from "../src/server";
import { config } from "../src/config";
import { db, legacyWorkspaceId, createWorkspace, mintApiKey } from "../src/db";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let rootWs: string;
let rootUser: string;
let png: Uint8Array; // 400x400 blobby PNG — smooth interpolated noise, WebP wins by ~30x

const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);

function noise(width: number, height: number, seed = 0): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = ((i + seed) * 2654435761) % 256;
  return raw;
}

// Low-frequency noise upscaled smooth: expensive for lossless PNG, trivial for
// lossy WebP — so "the WebP re-encode wins" is deterministic, not luck.
function blob(width: number, height: number, seed = 0): Sharp {
  const sw = Math.max(2, Math.round(width / 16));
  const sh = Math.max(2, Math.round(height / 16));
  return sharp(noise(sw, sh, seed), { raw: { width: sw, height: sh, channels: 3 } }).resize(
    width,
    height,
    { fit: "fill" },
  );
}

async function blobPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await blob(width, height).png().toBuffer());
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  rootWs = legacyWorkspaceId()!;
  rootUser = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(config.authDisabled ? "dev@localhost" : config.allowedEmails[0]!)!.id;
  png = await blobPng(400, 400);
});

afterAll(() => {
  server.stop(true);
});

const LEGACY = config.apiToken!; // imported env key → root workspace

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function put(filename: string, token: string, body: Uint8Array) {
  return fetch(`${base}/api/images/${filename}`, { method: "PUT", headers: bearer(token), body });
}

// config.baseUrl is a fixed port-0 string under tests; rebase returned URLs onto
// the live server before fetching them.
function local(url: string): string {
  return `${base}${new URL(url).pathname}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

// ---- upload + compress + serve round trip ----

describe("image upload", () => {
  test("png is compressed to webp: response shape, served bytes, immutable caching", async () => {
    const r = await put("shot.png", LEGACY, png);
    expect(r.status).toBe(200);
    const j = await readJson(r);
    expect(j.id).toMatch(/^img_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    expect(j.filename).toBe("shot.webp"); // re-encode won, extension follows
    expect(j.workspace).toBe(rootWs);
    expect(j.contentType).toBe("image/webp");
    expect(j.originalBytes).toBe(png.length);
    expect(j.bytes).toBeLessThan(png.length);
    expect(j.url).toBe(`${config.baseUrl}/${rootWs}/i/${j.id}/shot.webp`);
    expect(j.markdown).toBe(`![shot](${j.url})`);

    const served = await fetch(local(j.url));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(bytes.length).toBe(j.bytes);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(400);
  });

  test("oversized images are capped to a 2000px longest edge", async () => {
    const wide = await blobPng(2500, 40);
    const j = await readJson(await put("wide.png", LEGACY, wide));
    expect(j.contentType).toBe("image/webp");
    const served = new Uint8Array(await (await fetch(local(j.url))).arrayBuffer());
    const meta = await sharp(served).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(32); // aspect preserved
  });

  test("re-uploading a filename mints a new id; both URLs keep serving", async () => {
    const a = await readJson(await put("twice.png", LEGACY, png));
    const b = await readJson(await put("twice.png", LEGACY, png));
    expect(a.id).not.toBe(b.id);
    expect((await fetch(local(a.url))).status).toBe(200);
    expect((await fetch(local(b.url))).status).toBe(200);
  });

  test("animated gif stays animated through the webp re-encode", async () => {
    // Frames must differ (seed varies) or the gif encoder collapses them.
    const frames: Buffer[] = [];
    for (let i = 0; i < 6; i++) frames.push(await blob(200, 200, i * 7).png().toBuffer());
    const gif = new Uint8Array(
      await sharp(frames, { join: { animated: true } }).gif().toBuffer(),
    );
    const j = await readJson(await put("anim.gif", LEGACY, gif));
    expect(j.contentType).toBe("image/webp"); // big noisy gif → webp wins
    const served = new Uint8Array(await (await fetch(local(j.url))).arrayBuffer());
    const meta = await sharp(served, { animated: true }).metadata();
    expect(meta.pages).toBe(6);
  });

  test("avif keeps its own format when the webp re-encode loses", async () => {
    // AVIF out-compresses WebP q82 on smooth content, so the same-format
    // fallback wins deterministically — and it too is re-encoded, never raw.
    const avif = new Uint8Array(await blob(400, 400).avif({ quality: 50 }).toBuffer());
    const j = await readJson(await put("tight.avif", LEGACY, avif));
    expect(j.contentType).toBe("image/avif");
    expect(j.filename).toBe("tight.avif");
    const served = await fetch(local(j.url));
    expect(served.headers.get("content-type")).toBe("image/avif");
    const meta = await sharp(new Uint8Array(await served.arrayBuffer())).metadata();
    expect(meta.format).toBe("heif"); // sharp reports avif as heif
    expect(meta.width).toBe(400);
  });

  test("exif orientation is baked in and metadata stripped", async () => {
    // Orientation 6 = rotate 90° CW on display: a 320x240 sensor image shows as
    // 240x320. The served image must be physically rotated with the tag gone.
    const jpg = new Uint8Array(
      await blob(320, 240).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    );
    const j = await readJson(await put("rotated.jpg", LEGACY, jpg));
    const served = new Uint8Array(await (await fetch(local(j.url))).arrayBuffer());
    const meta = await sharp(served).metadata();
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(320);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  test("svg passes through untouched, served with a script-neutering CSP", async () => {
    const j = await readJson(await put("mark.svg", LEGACY, SVG));
    expect(j.contentType).toBe("image/svg+xml");
    expect(j.filename).toBe("mark.svg");
    expect(j.bytes).toBe(SVG.length);
    const served = await fetch(local(j.url));
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(SVG);
  });

  test("rejections: bad name, bad extension, magic mismatch, undecodable, empty, bad key", async () => {
    expect((await put("Shot.png", LEGACY, png)).status).toBe(400); // uppercase
    expect((await put("shot.bmp", LEGACY, png)).status).toBe(400); // unsupported ext
    // Wrong file entirely: fails the magic sniff before sharp sees it.
    expect((await put("shot.png", LEGACY, new TextEncoder().encode("<html>nope</html>"))).status).toBe(400);
    // Right magic, garbage body: sharp fails to decode → actionable 400.
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const undecodable = await put("shot.png", LEGACY, fakePng);
    expect(undecodable.status).toBe(400);
    expect((await readJson(undecodable)).error).toContain("decode");
    expect((await put("shot.png", LEGACY, new Uint8Array(0))).status).toBe(400);
    expect((await put("shot.png", "seer_sk_" + "a".repeat(32), png)).status).toBe(401);
  });
});

// ---- listing + workspace scoping ----

describe("image listing", () => {
  test("GET /api/images is scoped to the key's workspace", async () => {
    const ws2 = createWorkspace("img-space", rootUser);
    const { token: key2 } = mintApiKey(rootUser, ws2, "ws2 img key");

    const j = await readJson(await put("scoped.png", key2, png));
    expect(j.workspace).toBe(ws2);

    const ws2List = await readJson(await fetch(`${base}/api/images`, { headers: bearer(key2) }));
    expect(ws2List.map((i: { filename: string }) => i.filename)).toEqual(["scoped.webp"]);
    expect(ws2List[0].workspace).toBe(ws2);
    expect(ws2List[0].url).toBe(`${config.baseUrl}/${ws2}/i/${ws2List[0].id}/scoped.webp`);

    const rootList = await readJson(await fetch(`${base}/api/images`, { headers: bearer(LEGACY) }));
    expect(rootList.every((i: { workspace: string }) => i.workspace === rootWs)).toBe(true);
    expect(rootList.some((i: { filename: string }) => i.filename === "scoped.webp")).toBe(false);

    expect((await fetch(`${base}/api/images`)).status).toBe(401);
  });
});

// ---- serving strictness (member view; cross-user matrix is in serving-matrix) ----

describe("image serving", () => {
  test("a member sees their own private workspace's images", async () => {
    const ownPriv = createWorkspace("my-private", rootUser);
    db.run("UPDATE workspaces SET visibility = 'private' WHERE id = ?", [ownPriv]);
    const { token: ownKey } = mintApiKey(rootUser, ownPriv, "own key");
    const own = await readJson(await put("mine.png", ownKey, png));
    expect((await fetch(local(own.url))).status).toBe(200);
  });

  test("soft-404s: unknown id, filename mismatch, extra path segment, foreign ws", async () => {
    const j = await readJson(await put("strict.png", LEGACY, png));
    expect((await fetch(`${base}/${rootWs}/i/img_0123456789/strict.webp`)).status).toBe(404);
    expect((await fetch(`${base}/${rootWs}/i/${j.id}/other.webp`)).status).toBe(404);
    expect((await fetch(`${base}/${rootWs}/i/${j.id}/strict.webp/extra`)).status).toBe(404);
    // The right id under the wrong workspace id must not resolve.
    const ws2 = createWorkspace("decoy", rootUser);
    expect((await fetch(`${base}/${ws2}/i/${j.id}/strict.webp`)).status).toBe(404);
  });
});
