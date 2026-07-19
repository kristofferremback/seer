// Runs in its OWN process (spawned by serving.test.ts) with AUTH_DISABLED unset, so
// sessionUser resolves real forged cookies rather than short-circuiting to root. It
// exercises the workspace-visibility matrix over HTTP and the soft-404 variants.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "root@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-serving-"));

const { sessionCookie } = await import("../src/auth");
const { db, legacyWorkspaceId, createVersion, createImage } = await import("../src/db");
const { saveZip, saveImage } = await import("../src/store");
const { tinyId } = await import("../src/ids");
const { startServer } = await import("../src/server");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

const server = startServer();
const base = `http://localhost:${server.port}`;
const now = Date.now();

// The migration made a public root workspace. Use it as the public case.
const pubWs = legacyWorkspaceId()!;

// A private workspace with exactly one member.
const privWs = tinyId("ws");
db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'private', ?)", [
  privWs,
  "private-space",
  now,
]);

const memberUser = tinyId("usr");
db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
  memberUser,
  "member@example.com",
  now,
]);
db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
  privWs,
  memberUser,
  now,
]);

// A real user who belongs to no workspace here (a signed-in non-member).
const strangerUser = tinyId("usr");
db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
  strangerUser,
  "stranger@example.com",
  now,
]);

// Seed a bundle into each workspace.
async function seed(wsId: string, slug: string, body: string) {
  const zip = zipSync({ "index.html": strToU8(`<!doctype html><body>${body}</body>`) });
  const v = createVersion(wsId, slug, zip.length, 1);
  await saveZip(wsId, slug, v, zip);
}
await seed(pubWs, "pub-bundle", "PUBLIC-BODY");
await seed(privWs, "priv-bundle", "PRIVATE-BODY");

// Turn a userId into a Cookie header value.
function cookieHeader(userId: string): Record<string, string> {
  const value = sessionCookie(userId).split(";")[0]!; // seer_session=<payload>.<sig>
  return { cookie: value };
}

const anon: Record<string, string> = {};
const asMember = cookieHeader(memberUser);
const asStranger = cookieHeader(strangerUser);

async function get(path: string, headers: Record<string, string>) {
  return fetch(`${base}${path}`, { headers, redirect: "manual" });
}

// ---- visibility matrix ----
// public ws × {anon, member, non-member} -> 200 (public is viewable by anyone).
for (const [who, headers] of [
  ["anon", anon],
  ["member", asMember],
  ["stranger", asStranger],
] as const) {
  const r = await get(`/${pubWs}/b/pub-bundle/`, headers);
  assert(r.status === 200, `public ws as ${who} should 200, got ${r.status}`);
  assert((await r.text()).includes("PUBLIC-BODY"), `public ws as ${who} serves content`);
}

// private ws: member -> 200; anon & non-member -> soft-404.
{
  const r = await get(`/${privWs}/b/priv-bundle/`, asMember);
  assert(r.status === 200, `private ws as member should 200, got ${r.status}`);
  assert((await r.text()).includes("PRIVATE-BODY"), "private ws member sees content");
}
for (const [who, headers] of [
  ["anon", anon],
  ["stranger", asStranger],
] as const) {
  const r = await get(`/${privWs}/b/priv-bundle/`, headers);
  assert(r.status === 404, `private ws as ${who} should soft-404, got ${r.status}`);
  assert((r.headers.get("cache-control") ?? "") === "no-cache", `private ${who} 404 is no-cache`);
}

// ---- image visibility matrix + the github-camo carve-out ----
// Serving never decodes, so seeded bytes can be arbitrary.
const IMG_BYTES = new Uint8Array([1, 2, 3, 4]);
async function seedImage(wsId: string): Promise<string> {
  const id = createImage(wsId, "pic.webp", "image/webp", IMG_BYTES.length);
  await saveImage(wsId, id, IMG_BYTES);
  return `/${wsId}/i/${id}/pic.webp`;
}
const pubImg = await seedImage(pubWs);
const privImg = await seedImage(privWs);
const camo = { "user-agent": "github-camo (asset-proxy)" };

// public ws image: anyone.
for (const [who, headers] of [
  ["anon", anon],
  ["member", asMember],
  ["stranger", asStranger],
] as const) {
  const r = await get(pubImg, headers);
  assert(r.status === 200, `public image as ${who} should 200, got ${r.status}`);
}
// private ws image: member yes; anon & non-member soft-404 — but the github-camo
// UA is always served, so images render inside GitHub PRs regardless.
{
  const r = await get(privImg, asMember);
  assert(r.status === 200, `private image as member should 200, got ${r.status}`);
  assert(
    r.headers.get("cache-control") === "public, max-age=31536000, immutable",
    "served image is immutable-cached",
  );
}
for (const [who, headers] of [
  ["anon", anon],
  ["stranger", asStranger],
] as const) {
  const r = await get(privImg, headers);
  assert(r.status === 404, `private image as ${who} should soft-404, got ${r.status}`);
  const c = await get(privImg, { ...headers, ...camo });
  assert(c.status === 200, `private image as ${who} via github-camo should 200, got ${c.status}`);
}

// ---- soft-404 affordance branch ----
// Anon denial carries a sign-in affordance pointing back at the requested URL.
{
  const r = await get(`/${privWs}/b/priv-bundle/`, anon);
  const html = await r.text();
  assert(
    html.includes(`/login?next=${encodeURIComponent(`/${privWs}/b/priv-bundle/`)}`),
    "anon soft-404 carries a sign-in affordance with the current url as next",
  );
  assert(html.includes("Sign in"), "anon soft-404 offers Sign in");
}
// Signed-in non-member denial shows the session email and NO sign-in affordance.
{
  const r = await get(`/${privWs}/b/priv-bundle/`, asStranger);
  const html = await r.text();
  assert(html.includes("stranger@example.com"), "signed-in soft-404 shows the session email");
  assert(!html.includes("/login?next="), "signed-in soft-404 has no sign-in affordance");
}

// ---- forbidden is indistinguishable from missing ----
// The same signed-in non-member gets byte-identical bodies for an existing-but-
// forbidden bundle and a nonexistent one.
{
  const forbidden = await (await get(`/${privWs}/b/priv-bundle/`, asStranger)).text();
  const missing = await (await get(`/${privWs}/b/does-not-exist/`, asStranger)).text();
  assert(forbidden === missing, "forbidden and missing soft-404 bodies are identical");
}
// An unknown-but-well-formed workspace id soft-404s exactly like a missing bundle.
{
  const unknownWs = tinyId("ws");
  const r = await get(`/${unknownWs}/b/whatever/`, anon);
  assert(r.status === 404, `unknown ws should soft-404, got ${r.status}`);
}

// ---- live-reload socket honors the same access rule ----
// A private workspace's socket rejects an anon upgrade (404), accepts a member's.
{
  const denied = await fetch(`${base}/ws/livereload?ws=${privWs}&slug=priv-bundle`, {
    headers: anon,
  });
  assert(denied.status === 404, `anon WS upgrade to private ws should 404, got ${denied.status}`);

  const ws = new WebSocket(`ws://localhost:${server.port}/ws/livereload?ws=${privWs}&slug=priv-bundle`, {
    headers: asMember,
  });
  const opened = await new Promise<string>((res) => {
    ws.onopen = () => res("open");
    ws.onerror = () => res("error");
    setTimeout(() => res("timeout"), 2000);
  });
  assert(opened === "open", `member WS upgrade to private ws should connect, got ${opened}`);
  ws.close();
}

server.stop(true);
console.log("serving-matrix: all assertions passed");
process.exit(0);
