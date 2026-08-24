// Spawned with authentication enabled. A valid API key proves the capture is there;
// the malformed, missing, and cross-workspace reads must then be byte-identical 404s.
process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "stage-test";
process.env.GOOGLE_CLIENT_SECRET = "stage-test";
process.env.SESSION_SECRET = "stage-test-secret";

const id = process.env.STAGE_CAPTURE_ID!;
const key = process.env.STAGE_CAPTURE_KEY!;
const stageSlug = process.env.STAGE_SLUG ?? "";
const dataDir = process.env.DATA_DIR!;
if (!id || !key || !dataDir) throw new Error("privacy script needs capture id, key, and data dir");

const { startServer } = await import("../src/server");
const { createWorkspace, mintApiKey, db } = await import("../src/db");
const { hashKey } = await import("../src/ids");
const { sessionCookie } = await import("../src/auth");
const server = await startServer();
const base = `http://localhost:${server.port}`;
const get = (captureId: string, token: string) => fetch(`${base}/api/stage-captures/${captureId}`, { headers: { authorization: `Bearer ${token}` } });
const getObject = (captureId: string, sha256: string, token: string) => fetch(`${base}/api/stage-captures/${captureId}/objects/${sha256}`, { headers: { authorization: `Bearer ${token}` } });
const success = await get(id, key);
if (success.status !== 200) throw new Error(`valid capture read returned ${success.status}`);
const successBody = await success.text();
const capture = JSON.parse(successBody) as any;
const objectSha = capture.patch?.sha256 ?? capture.files.flatMap((file: any) => [file.old.blobSha256, file.new.blobSha256]).find(Boolean);
if (!objectSha) throw new Error("valid capture has no retained object for privacy proof");
const objectSuccess = await getObject(id, objectSha, key);
if (objectSuccess.status !== 200 || objectSuccess.headers.get("content-type") !== "application/octet-stream" || (await objectSuccess.arrayBuffer()).byteLength === 0) throw new Error("valid object read failed");
const validKey = db.query<{ user_id: string; workspace_id: string }, [string]>(
  "SELECT user_id, workspace_id FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL",
).get(hashKey(key));
if (!validKey || validKey.workspace_id !== capture.workspace) throw new Error("valid capture key relation is missing");
const owner = validKey.user_id;
const sessionCookieHeader = sessionCookie(owner).split(";")[0]!;
const sessionSuccess = await fetch(`${base}/api/stage-captures/${id}`, { headers: { cookie: sessionCookieHeader, authorization: "Bearer stale-token" } });
if (sessionSuccess.status !== 200 || await sessionSuccess.text() !== successBody) throw new Error("valid session was shadowed by a stale bearer");
const sessionObject = await fetch(`${base}/api/stage-captures/${id}/objects/${objectSha}`, { headers: { cookie: sessionCookieHeader, authorization: "Bearer stale-token" } });
if (sessionObject.status !== 200 || (await sessionObject.arrayBuffer()).byteLength === 0) throw new Error("valid session object read failed");
const invalidBearer = await get("not-an-id", "stale-token");
const invalidObject = await getObject(id, "0".repeat(64), key);
const otherCaptureId = process.env.STAGE_OTHER_CAPTURE_ID;
const otherCaptureObject = process.env.STAGE_OTHER_OBJECT_SHA;
const crossCaptureObject = otherCaptureId && otherCaptureObject
  ? await getObject(id, otherCaptureObject, key)
  : null;
if ((otherCaptureId && !otherCaptureObject) || (!otherCaptureId && otherCaptureObject)) throw new Error("other capture privacy inputs are incomplete");
if (otherCaptureId && otherCaptureObject) {
  const otherSuccess = await get(otherCaptureId, key);
  if (otherSuccess.status !== 200) throw new Error(`valid second capture read returned ${otherSuccess.status}`);
  const otherBody = JSON.parse(await otherSuccess.text()) as any;
  const otherDigest = otherBody.patch?.sha256 ?? otherBody.files.flatMap((file: any) => [file.old.blobSha256, file.new.blobSha256]).find(Boolean);
  if (otherDigest !== otherCaptureObject || otherDigest === objectSha) throw new Error("second capture did not provide a distinct retained digest");
  const otherObject = await getObject(otherCaptureId, otherCaptureObject, key);
  if (otherObject.status !== 200) throw new Error(`valid second capture object read returned ${otherObject.status}`);
}
if (invalidBearer.status !== 404) throw new Error(`invalid bearer became a key-validity oracle: ${invalidBearer.status}`);
const otherWs = createWorkspace("privacy-other", owner);
const otherKey = mintApiKey(owner, otherWs, "privacy").token;
const refusals = await Promise.all([
  get("not-an-id", key),
  get("stg_0000000000", key),
  get(id, otherKey),
  getObject(id, objectSha, otherKey),
  invalidObject,
  ...(crossCaptureObject ? [crossCaptureObject] : []),
]);
const allRefusals = [...refusals, invalidBearer];
const bodies = await Promise.all(allRefusals.map((response) => response.text()));
for (const [index, response] of allRefusals.entries()) {
  if (response.status !== 404 || response.headers.get("content-type") !== "application/json" || bodies[index] !== bodies[0]) {
    throw new Error(`refusal ${index} was not the common soft 404`);
  }
}
if (successBody === bodies[0]) throw new Error("a successful read matched the soft 404");
if (stageSlug) {
  const readStage = (path: string, token: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const stageSuccess = await readStage(`/api/stages/${stageSlug}`, key);
  if (stageSuccess.status !== 200) throw new Error(`valid stage read returned ${stageSuccess.status}`);
  const stageBody = await stageSuccess.text();
  const stageSessionSuccess = await fetch(`${base}/api/stages/${stageSlug}`, { headers: { cookie: sessionCookieHeader, authorization: "Bearer stale-token" } });
  if (stageSessionSuccess.status !== 200 || await stageSessionSuccess.text() !== stageBody) throw new Error("valid stage session was shadowed by a stale bearer");
  const stageOther = await readStage(`/api/stages/${stageSlug}`, otherKey);
  const stageRefusals = await Promise.all([
    readStage("/api/stages/not-a-stage", key),
    readStage(`/api/stages/${stageSlug}/v/2`, key),
    stageOther,
    readStage(`/api/stages/${stageSlug}`, "stale-token"),
  ]);
  const stageBodies = await Promise.all(stageRefusals.map((response) => response.text()));
  for (const [index, response] of stageRefusals.entries()) {
    if (response.status !== 404 || response.headers.get("content-type") !== "application/json" || response.headers.get("cache-control") !== "no-store" || stageBodies[index] !== stageBodies[0]) {
      throw new Error(`stage refusal ${index} was not the common soft 404`);
    }
  }
  if (stageBody === stageBodies[0]) throw new Error("a successful stage read matched the soft 404");
}
server.stop(true);
console.log("stage privacy: all assertions passed");
process.exit(0);
