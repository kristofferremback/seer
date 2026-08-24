process.env.AUTH_DISABLED = "";
process.env.GOOGLE_CLIENT_ID = "stage-reader-test";
process.env.GOOGLE_CLIENT_SECRET = "stage-reader-test";
process.env.SESSION_SECRET = "stage-reader-test-secret";

const workspace = process.env.STAGE_READER_WORKSPACE!;
const slug = process.env.STAGE_READER_SLUG!;
const owner = process.env.STAGE_READER_OWNER!;
const member = process.env.STAGE_READER_MEMBER!;
const stranger = process.env.STAGE_READER_STRANGER!;
const changeId = process.env.STAGE_READER_CHANGE!;
const fileId = process.env.STAGE_READER_FILE!;
const otherFileId = process.env.STAGE_READER_OTHER_FILE!;
const key = process.env.STAGE_READER_KEY!;
const otherKey = process.env.STAGE_READER_OTHER_KEY!;
if (![workspace, slug, owner, member, stranger, changeId, fileId, otherFileId, key, otherKey, process.env.DATA_DIR].every(Boolean)) throw new Error("stage reader privacy env is incomplete");

const { startServer } = await import("../src/server");
const { sessionCookie } = await import("../src/auth");
const { config } = await import("../src/config");
const { db } = await import("../src/db");
const server = await startServer();
const base = `http://localhost:${server.port}`;
const cookie = (user: string) => sessionCookie(user).split(";")[0]!;
const page = (user: string, path = `/${workspace}/st/${slug}/v/1`) => fetch(`${base}${path}`, { headers: { cookie: cookie(user) } });
const lines = (headers: Record<string, string>, id = fileId) => fetch(`${base}/api/stages/${slug}/v/1/files/${id}?side=new&start=1&end=1`, { headers });

try {
  const stageVersion = db.query<{ id: string }, [string, string]>("SELECT id FROM stage_versions WHERE workspace_id = ? AND slug = ? AND version = 1").get(workspace, slug);
  if (!stageVersion) throw new Error("stage version row is missing");
  db.run("DELETE FROM stage_change_reads WHERE workspace_id = ? AND stage_version_id = ?", [workspace, stageVersion.id]);
  const ownerPage = await page(owner);
  const memberPage = await page(member);
  if (ownerPage.status !== 200 || memberPage.status !== 200) throw new Error("workspace members could not read the stage");
  const memberBefore = await memberPage.text();
  if (!memberBefore.includes(`data-change="${changeId}"`) || !memberBefore.includes('data-read="false"')) throw new Error("member did not begin unread");

  const nonmember = await page(stranger);
  const nonmemberMissing = await page(stranger, `/${workspace}/st/not-a-stage`);
  if (nonmember.status !== 404 || nonmemberMissing.status !== 404 || await nonmember.text() !== await nonmemberMissing.text()) throw new Error("nonmember stage refusal disclosed existence");

  const origin = new URL(config.baseUrl).origin;
  const marked = await fetch(`${base}/${workspace}/st/${slug}/v/1/changes/${changeId}/read`, {
    method: "POST",
    headers: { cookie: cookie(owner), origin, accept: "application/json" },
    body: new URLSearchParams({ read: "true" }),
  });
  if (marked.status !== 200) throw new Error(`owner read write returned ${marked.status}`);
  const ownerAfter = await (await page(owner)).text();
  const memberAfter = await (await page(member)).text();
  const around = (body: string) => body.slice(body.indexOf(`data-change="${changeId}"`), body.indexOf(`data-change="${changeId}"`) + 260);
  if (!around(ownerAfter).includes('data-read="true"')) throw new Error("owner read state was not rendered");
  if (!around(memberAfter).includes('data-read="false"')) throw new Error("owner read state leaked to another member");

  const keyRead = await lines({ authorization: `Bearer ${key}` });
  const sessionPastStale = await lines({ cookie: cookie(owner), authorization: "Bearer stale-token" });
  if (keyRead.status !== 200 || sessionPastStale.status !== 200) throw new Error("valid line readers were refused");
  const crossCapture = await lines({ authorization: `Bearer ${key}` }, otherFileId);
  const malformed = await lines({ authorization: `Bearer ${key}` }, "not-an-id");
  const invalidBearer = await lines({ authorization: "Bearer stale-token" });
  const crossWorkspace = await lines({ authorization: `Bearer ${otherKey}` });
  const refusals = [crossCapture, malformed, invalidBearer, crossWorkspace];
  const refusalBodies = await Promise.all(refusals.map((response) => response.text()));
  if (refusals.some((response) => response.status !== 404) || new Set(refusalBodies).size !== 1) throw new Error("line refusal disclosed file or key existence");

  console.log("stage reader privacy: all assertions passed");
} finally {
  server.stop(true);
}
process.exit(0);
