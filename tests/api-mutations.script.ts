// Runs in its OWN process (spawned by api-mutations.test.ts) with AUTH_DISABLED
// unset, so sessionUser resolves real forged cookies rather than short-circuiting
// to root. It exercises the cross-user authorization that AUTH_DISABLED can't:
// non-member 404/403, key ownership, and the invite accept flow over HTTP.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import "./app-env";
import { createTestDataDir } from "./test-data-dir";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "root@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = createTestDataDir("seer-tests-mutations-");

const { sessionCookie } = await import("../src/auth");
const { db } = await import("../src/db");
const { tinyId } = await import("../src/ids");
const { startServer } = await import("../src/server");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

const server = await startServer();
const base = `http://localhost:${server.port}`;
const now = Date.now();

// A workspace with exactly one member, userA.
const wsA = tinyId("ws");
db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)", [
  wsA,
  "Alpha",
  now,
]);
function seedUser(email: string): string {
  const id = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [id, email, now]);
  return id;
}
const userA = seedUser("a@example.com");
const userB = seedUser("b@example.com"); // non-member of wsA (for now)
const userC = seedUser("c@example.com"); // invite acceptor
db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
  wsA,
  userA,
  now,
]);

function cookie(userId: string): Record<string, string> {
  return { cookie: sessionCookie(userId).split(";")[0]! };
}

function form(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  };
}

const TOKEN_RE = /seer_sk_[A-Za-z0-9_-]{32}/;

// ---- no session → 403; non-member → 404 ----
{
  const anon = await fetch(`${base}/settings/${wsA}/name`, form({ name: "x" }));
  assert(anon.status === 403, `no-session mutation should 403, got ${anon.status}`);

  const nonMember = await fetch(`${base}/settings/${wsA}/name`, form({ name: "x" }, cookie(userB)));
  assert(nonMember.status === 404, `non-member mutation should 404, got ${nonMember.status}`);

  const getPage = await fetch(`${base}/settings/${wsA}`, { headers: cookie(userB), redirect: "manual" });
  assert(getPage.status === 404, `non-member settings GET should soft-404, got ${getPage.status}`);
}

// ---- member can mutate ----
{
  const r = await fetch(`${base}/settings/${wsA}/name`, form({ name: "Alpha Prime" }, cookie(userA)));
  assert(r.status === 303, `member rename should 303, got ${r.status}`);
  const name = db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE id = ?").get(wsA)!.name;
  assert(name === "Alpha Prime", `rename should persist, got ${name}`);
}

// ---- key ownership: even a co-member cannot touch another member's key ----
{
  const minted = await fetch(`${base}/settings/${wsA}/keys`, form({ name: "a-key" }, cookie(userA)));
  assert(minted.status === 200, `member mint should 200, got ${minted.status}`);
  const token = (await minted.text()).match(TOKEN_RE)?.[0];
  assert(!!token, "mint reveals a token");

  const keyId = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM api_keys WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .get(wsA, userA)!.id;

  // Make userB a co-member so the membership check passes and ONLY ownership gates.
  db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
    wsA,
    userB,
    now,
  ]);

  const rollByB = await fetch(`${base}/settings/${wsA}/keys/${keyId}/roll`, form({}, cookie(userB)));
  assert(rollByB.status === 404, `co-member rolling another's key should 404, got ${rollByB.status}`);
  const revokeByB = await fetch(`${base}/settings/${wsA}/keys/${keyId}/revoke`, form({}, cookie(userB)));
  assert(revokeByB.status === 404, `co-member revoking another's key should 404, got ${revokeByB.status}`);

  // The owner still can, and the key is still live before that.
  const stillLive = db
    .query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM api_keys WHERE id = ?")
    .get(keyId)!;
  assert(stillLive.revoked_at === null, "the key survived the unauthorized attempts");
  const revokeByA = await fetch(`${base}/settings/${wsA}/keys/${keyId}/revoke`, form({}, cookie(userA)));
  assert(revokeByA.status === 303, `owner revoke should 303, got ${revokeByA.status}`);
}

// ---- invite accept flow over HTTP ----
{
  const minted = await fetch(`${base}/settings/${wsA}/invites`, form({}, cookie(userA)));
  assert(minted.status === 200, `invite mint should 200, got ${minted.status}`);
  const token = (await minted.text()).match(/inv_[0-9abcdefghjkmnpqrstvwxyz]{10}/)?.[0];
  assert(!!token, "invite mint reveals an inv_ token");

  // A signed-in user who is not yet a member accepts and joins.
  const accept = await fetch(`${base}/invite/${token}/accept`, form({}, cookie(userC)));
  assert(accept.status === 303, `accept should 303, got ${accept.status}`);
  assert(accept.headers.get("location") === "/bundles", "accept redirects to /bundles");
  const joined = db.query("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?").get(wsA, userC);
  assert(!!joined, "acceptor is now a member");

  // Single-use: the same token is dead everywhere afterwards → soft-404.
  const reused = await fetch(`${base}/invite/${token}/accept`, form({}, cookie(userC)));
  assert(reused.status === 404, `reused invite should soft-404, got ${reused.status}`);

  // An unknown/garbage invite token is a soft-404, not a 500.
  const unknown = await fetch(`${base}/invite/inv_0000000000/accept`, form({}, cookie(userC)));
  assert(unknown.status === 404, `unknown invite should soft-404, got ${unknown.status}`);
}

server.stop(true);
console.log("api-mutations: all assertions passed");
process.exit(0);
