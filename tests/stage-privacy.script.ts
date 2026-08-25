// Spawned with authentication enabled. A valid API key proves the capture is there;
// the malformed, missing, and cross-workspace reads must then be byte-identical 404s.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "stage-test";
process.env.GOOGLE_CLIENT_SECRET = "stage-test";
process.env.SESSION_SECRET = "stage-test-secret";

const id = process.env.STAGE_CAPTURE_ID!;
const key = process.env.STAGE_CAPTURE_KEY!;
const dataDir = process.env.DATA_DIR!;
if (!id || !key || !dataDir) throw new Error("privacy script needs capture id, key, and data dir");

const { startServer } = await import("../src/server");
const { createWorkspace, mintApiKey, db } = await import("../src/db");
const { sessionCookie } = await import("../src/auth");
const server = await startServer();
const base = `http://localhost:${server.port}`;
const get = (captureId: string, token: string) => fetch(`${base}/api/stage-captures/${captureId}`, { headers: { authorization: `Bearer ${token}` } });
const success = await get(id, key);
if (success.status !== 200) throw new Error(`valid capture read returned ${success.status}`);
const successBody = await success.text();
const owner = db.query<{ id: string }, []>("SELECT id FROM users LIMIT 1").get()!.id;
const sessionCookieHeader = sessionCookie(owner).split(";")[0]!;
const sessionSuccess = await fetch(`${base}/api/stage-captures/${id}`, { headers: { cookie: sessionCookieHeader, authorization: "Bearer stale-token" } });
if (sessionSuccess.status !== 200 || await sessionSuccess.text() !== successBody) throw new Error("valid session was shadowed by a stale bearer");
const invalidBearer = await get("not-an-id", "stale-token");
if (invalidBearer.status !== 404) throw new Error(`invalid bearer became a key-validity oracle: ${invalidBearer.status}`);
const otherWs = createWorkspace("privacy-other", owner);
const otherKey = mintApiKey(owner, otherWs, "privacy").token;
const refusals = await Promise.all([
  get("not-an-id", key),
  get("stg_0000000000", key),
  get(id, otherKey),
]);
const allRefusals = [...refusals, invalidBearer];
const bodies = await Promise.all(allRefusals.map((response) => response.text()));
for (const [index, response] of allRefusals.entries()) {
  if (response.status !== 404 || response.headers.get("content-type") !== "application/json" || bodies[index] !== bodies[0]) {
    throw new Error(`refusal ${index} was not the common soft 404`);
  }
}
if (successBody === bodies[0]) throw new Error("a successful read matched the soft 404");
server.stop(true);
console.log("stage privacy: all assertions passed");
process.exit(0);
