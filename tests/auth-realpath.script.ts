// Runs in its OWN process (spawned by auth.test.ts) with AUTH_DISABLED unset,
// so it exercises the real signed-cookie/OAuth path in src/auth.ts and the
// auth-enabled server behavior. Config requires Google OIDC vars when auth is
// enabled, so we provide dummies. Only pre-network OAuth branches are hit —
// nothing here talks to Google.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "allowed@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
// Small cap so the oversize-upload test stays cheap. Bun's maxRequestBodySize is
// set to this + 1024, so a ~1.5 KB body reaches the handler and gets a 413.
process.env.MAX_UPLOAD_BYTES = "1024";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-auth-"));

const { sessionCookie, sessionEmail, sessionUser } = await import("../src/auth");
const { config } = await import("../src/config");
const { startServer } = await import("../src/server");
const { db, legacyWorkspaceId } = await import("../src/db");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

function reqWithCookie(value: string): Request {
  return new Request("http://localhost:3000/", { headers: { cookie: `seer_session=${value}` } });
}

// Pull the raw "seer_session" value out of a Set-Cookie header.
function cookieValue(setCookie: string): string {
  const first = setCookie.split(";")[0]!; // seer_session=<payload>.<sig>
  return first.slice("seer_session=".length);
}

function hmac(data: string): string {
  return createHmac("sha256", config.sessionSecret).update(data).digest("base64url");
}

// startServer() runs the migration, bootstrapping the root user (email
// allowed@example.com from ALLOWED_EMAILS). The session cookie now carries the
// user id, so the round-trip tests need that real user row in the db.
const server = startServer();
const base = `http://localhost:${server.port}`;
const wsId = legacyWorkspaceId()!;
// Workspace-scoped bundle URL for the (public) bootstrap workspace.
const wb = (p: string) => `${base}/${wsId}/b/${p}`;

const rootUser = db
  .query<{ id: string; email: string }, []>("SELECT id, email FROM users LIMIT 1")
  .get()!;
assert(!!rootUser && rootUser.email === "allowed@example.com", `root user seeded, got ${rootUser?.email}`);

// ---- session cookie unit tests (user-id payload) ----

// 1. round-trip: cookie carries usr_ id, sessionUser resolves the row.
{
  const value = cookieValue(sessionCookie(rootUser.id));
  const su = sessionUser(reqWithCookie(value));
  assert(su?.id === rootUser.id, `round-trip id expected ${rootUser.id}, got ${su?.id}`);
  assert(su?.email === rootUser.email, `round-trip email expected ${rootUser.email}, got ${su?.email}`);
  assert(sessionEmail(reqWithCookie(value)) === rootUser.email, "sessionEmail wraps sessionUser");
}

// 2. tampered signature rejected
{
  const value = cookieValue(sessionCookie(rootUser.id));
  const parts = value.split(".");
  parts[2] = (parts[2] ?? "") + "x"; // corrupt sig
  const got = sessionUser(reqWithCookie(parts.join(".")));
  assert(got === null, `tampered sig should be rejected, got ${JSON.stringify(got)}`);
}

// 3. tampered payload (id swapped, old sig) rejected
{
  const value = cookieValue(sessionCookie(rootUser.id));
  const [, exp, sig] = value.split(".");
  const evil = Buffer.from("usr_zzzzzzzzzz").toString("base64url");
  const got = sessionUser(reqWithCookie(`${evil}.${exp}.${sig}`));
  assert(got === null, `tampered payload should be rejected, got ${JSON.stringify(got)}`);
}

// 4. expired session rejected (correctly-signed but past-exp cookie)
{
  const idB64 = Buffer.from(rootUser.id).toString("base64url");
  const exp = Date.now() - 1000; // already expired
  const payload = `${idB64}.${exp}`;
  const value = `${payload}.${hmac(payload)}`;
  const got = sessionUser(reqWithCookie(value));
  assert(got === null, `expired session should be rejected, got ${JSON.stringify(got)}`);
}

// 5. no cookie -> null
{
  const got = sessionUser(new Request("http://localhost:3000/"));
  assert(got === null, `no cookie should be null, got ${JSON.stringify(got)}`);
}

// 6. malformed cookie -> null
{
  const got = sessionUser(reqWithCookie("garbage"));
  assert(got === null, `malformed cookie should be null, got ${JSON.stringify(got)}`);
}

// 6b. old email-payload cookie: correctly signed, but decodes to an id that is not
// a real user row -> db miss -> re-login (null).
{
  const emailB64 = Buffer.from("allowed@example.com").toString("base64url");
  const exp = Date.now() + 60_000;
  const payload = `${emailB64}.${exp}`;
  const value = `${payload}.${hmac(payload)}`;
  const got = sessionUser(reqWithCookie(value));
  assert(got === null, `legacy email-payload cookie should re-login, got ${JSON.stringify(got)}`);
}

// ---- auth-enabled server: OAuth pre-network branches, WS auth, oversize upload ----

// 7. loginRedirect open-redirect guard: next="//evil.com" must be replaced by "/".
{
  const r = await fetch(`${base}/login?next=${encodeURIComponent("//evil.com")}`, {
    redirect: "manual",
  });
  assert(r.status === 302, `/login should 302, got ${r.status}`);
  const loc = r.headers.get("location") ?? "";
  assert(loc.startsWith("https://accounts.google.com/"), `login redirects to Google, got ${loc}`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  // State cookie format: seer_oauth=<state>:<encodeURIComponent(next)>; the guarded
  // next must be "/" (%2F), never the protocol-relative //evil.com.
  assert(setCookie.includes(":%2F;"), `state cookie should carry next="/", got ${setCookie}`);
  assert(!setCookie.includes("evil.com"), `state cookie must not carry //evil.com: ${setCookie}`);
  assert(!loc.includes("evil.com"), `Google redirect must not carry //evil.com: ${loc}`);
}

// 8. safe relative next is preserved.
{
  const r = await fetch(`${base}/login?next=${encodeURIComponent("/b/foo/")}`, {
    redirect: "manual",
  });
  const setCookie = r.headers.get("set-cookie") ?? "";
  assert(
    setCookie.includes(`:${encodeURIComponent("/b/foo/")};`),
    `state cookie should carry /b/foo/, got ${setCookie}`,
  );
}

// 9. handleCallback: missing code/state -> 400 (before any network call).
{
  const r = await fetch(`${base}/auth/callback`, { redirect: "manual" });
  assert(r.status === 400, `callback without code/state should 400, got ${r.status}`);
}
{
  const r = await fetch(`${base}/auth/callback?code=abc`, {
    redirect: "manual",
    headers: { cookie: "seer_oauth=xyz:%2F" },
  });
  assert(r.status === 400, `callback without state should 400, got ${r.status}`);
}

// 10. handleCallback: state mismatch -> 400 (before any network call).
{
  const r = await fetch(`${base}/auth/callback?code=abc&state=WRONG`, {
    redirect: "manual",
    headers: { cookie: "seer_oauth=expected-state:%2F" },
  });
  assert(r.status === 400, `state mismatch should 400, got ${r.status}`);
  const body = await r.text();
  assert(body.includes("state mismatch"), `body should mention state mismatch, got ${body}`);
}

// 11. The public landing page is served without a session (200, not a redirect).
{
  const r = await fetch(`${base}/`, { redirect: "manual" });
  assert(r.status === 200, `/ (public landing) should 200, got ${r.status}`);
  const html = await r.text();
  assert(html.includes('property="og:title"'), "landing carries og:title");
  assert(html.includes("Sign in"), "landing offers a sign-in link when logged out");
}

// 11a. The agent skill doc is public (no session): both paths serve markdown.
{
  const skill = await fetch(`${base}/skill.md`, { redirect: "manual" });
  assert(skill.status === 200, `/skill.md should 200 without auth, got ${skill.status}`);
  assert(
    (skill.headers.get("content-type") ?? "").startsWith("text/markdown"),
    "/skill.md is text/markdown",
  );
  const llms = await fetch(`${base}/llms.txt`, { redirect: "manual" });
  assert(llms.status === 200, `/llms.txt should 200 without auth, got ${llms.status}`);
  assert((await llms.text()) === (await skill.text()), "/llms.txt matches /skill.md body");
}

// 11b. The signed-in ledger (/bundles) redirects to /login without a session.
{
  const r = await fetch(`${base}/bundles`, { redirect: "manual" });
  assert(r.status === 302, `/bundles without session should 302, got ${r.status}`);
  assert(
    (r.headers.get("location") ?? "").startsWith("/login?next="),
    "/bundles redirects to /login",
  );
}

// 11c. Public workspaces are viewable by anyone: unauthenticated
// /<ws>/b/:slug/ serves the real bundle index.html (200), content and all, with
// the workspace-scoped live-reload script injected. A legacy /b/:slug/ 301s here.
{
  const zip = zipSync({
    "index.html": strToU8("<!doctype html><body>PUBLIC-BUNDLE-BODY</body>"),
    "style.css": strToU8("body { color: teal; }"),
  });
  const up = await fetch(`${base}/api/bundles/public-preview`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.apiToken}` },
    body: zip,
  });
  assert(up.status === 200, `seeding bundle should 200, got ${up.status}`);

  // Legacy path 301s to the workspace-scoped URL, preserving the remainder.
  const legacy = await fetch(`${base}/b/public-preview/`, { redirect: "manual" });
  assert(legacy.status === 301, `legacy /b/:slug/ should 301, got ${legacy.status}`);
  assert(
    (legacy.headers.get("location") ?? "") === `/${wsId}/b/public-preview/`,
    `legacy redirect target should be workspace-scoped, got ${legacy.headers.get("location")}`,
  );

  const r = await fetch(wb("public-preview/"), { redirect: "manual" });
  assert(r.status === 200, `unauth /<ws>/b/:slug/ should serve the bundle (200), got ${r.status}`);
  const html = await r.text();
  assert(html.includes("PUBLIC-BUNDLE-BODY"), "public bundle serves its real index.html content");
  assert(
    html.includes(`/ws/livereload?ws=${wsId}&slug=public-preview`),
    "latest bundle carries the workspace-scoped live-reload script",
  );
  assert(!html.includes("/login?next="), "public bundle must NOT redirect to sign-in");
}

// 11d. Unauthenticated sub-asset requests are served directly (200, not a login
// redirect), with a sensible content-type.
{
  const r = await fetch(wb("public-preview/style.css"), { redirect: "manual" });
  assert(r.status === 200, `unauth /<ws>/b asset should 200, got ${r.status}`);
  assert(
    (r.headers.get("content-type") ?? "").includes("text/css"),
    `asset should carry text/css content-type, got ${r.headers.get("content-type")}`,
  );
  assert((await r.text()).includes("color: teal"), "asset serves its real content");
}

// 11e. Unknown slug -> soft-404 (HTTP 404, the void page, no-cache).
{
  const r = await fetch(wb("no-such-bundle/"), { redirect: "manual" });
  assert(r.status === 404, `unknown slug should soft-404, got ${r.status}`);
  assert((r.headers.get("cache-control") ?? "") === "no-cache", "soft-404 is no-cache");
}

// 12. WS live reload without a session cookie against a PUBLIC workspace: it
// upgrades and receives "reload" when a new version is uploaded.
{
  const slug = "ws-public";
  const seed = await fetch(`${base}/api/bundles/${slug}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.apiToken}` },
    body: zipSync({ "index.html": strToU8("<!doctype html><body>initial</body>") }),
  });
  assert(seed.status === 200, `seeding ws bundle should 200, got ${seed.status}`);

  // No cookie header -> unauthenticated.
  const ws = new WebSocket(`ws://localhost:${server.port}/ws/livereload?ws=${wsId}&slug=${slug}`);
  const opened = await new Promise<string>((res) => {
    ws.onopen = () => res("open");
    ws.onerror = () => res("error");
    ws.onclose = () => res("close");
    setTimeout(() => res("timeout"), 2000);
  });
  assert(opened === "open", `public WS should connect without a session, got ${opened}`);

  const gotReload = new Promise<string>((res) => {
    ws.onmessage = (e) => res(String(e.data));
  });
  await fetch(`${base}/api/bundles/${slug}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.apiToken}` },
    body: zipSync({ "index.html": strToU8("<!doctype html><body>updated</body>") }),
  });
  const msg = await Promise.race([
    gotReload,
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
  ]);
  assert(msg === "reload", `public WS should receive reload on new upload, got ${msg}`);
  ws.close();
}

// 14. Oversize upload: body > MAX_UPLOAD_BYTES (1024) -> 413. The API uses the
// bearer token, not sessions, so this works with auth enabled.
{
  const big = new Uint8Array(1500); // > 1024, < maxRequestBodySize (1024+1024)
  const r = await fetch(`${base}/api/bundles/too-big`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.apiToken}` },
    body: big,
  });
  assert(r.status === 413, `oversize upload should 413, got ${r.status}`);
}

server.stop(true);
console.log("auth-realpath: all assertions passed");
process.exit(0);
