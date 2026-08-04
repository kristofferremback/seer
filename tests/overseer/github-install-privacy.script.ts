// Runs in its OWN process (spawned by github-install.test.ts) with AUTH_DISABLED unset,
// so a request carrying no cookie is genuinely nobody and a request carrying B's cookie
// is genuinely B. Under the suite's AUTH_DISABLED every request is the root user, which
// would make every question below answer "yes" for the wrong reason.
//
// What is asked here is the whole of the claim flow's security argument:
//
//   - workspace B cannot see, list, or derive through workspace A's installation
//   - a callback with no state, a forged state, a replayed state, or a state belonging
//     to a different user attaches nothing
//   - THE UNHELD CASE: a signed-in member of B, valid session, valid Origin, naming an
//     unclaimed installation id belonging to A's account, is refused. This is the case
//     the first draft of the design missed, and the reason there is an OAuth leg at all
//   - an installation absent from GET /user/installations is refused even when
//     everything else is valid
//   - an installation another workspace holds is refused WITHOUT naming that workspace
//
// Every refusal runs beside the success it withholds, or the refusal proves nothing.
//
// Exits 0 on success, 1 on the first failed assertion (message on stderr).
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so it is erased: nothing here may import an app module before the env
// above is set.
import type { AppApi } from "../../src/overseer/github-app";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
delete process.env.GITHUB_TOKEN;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.ALLOWED_EMAILS = "a@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "seer-tests-ghi-privacy-"));

// A GitHub App this process owns, with a keypair generated here: nothing in this script
// is signed with a credential that exists anywhere else, and config.ts reads these at
// import time so they cannot be set later.
const keypair = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GITHUB_APP_ID = "424242";
process.env.GITHUB_APP_SLUG = "seer-overseer-test";
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(
  keypair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
).toString("base64");
process.env.GITHUB_APP_CLIENT_ID = "Iv1.testclientid";
process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

// This process does not get bunfig's test preload, so it closes both seams itself.
const { setGithubClient } = await import("../../src/overseer/github");
const { setGithubClientFactory } = await import("../../src/overseer/github-app");
const { setGithubOAuth } = await import("../../src/overseer/github-oauth");
const { offlineGithubClient, offlineGithubClientFactory } = await import("../offline-github");
setGithubClient(offlineGithubClient());
setGithubClientFactory(offlineGithubClientFactory());

const { sessionCookie } = await import("../../src/auth");
const { db } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { createWorkspaceGithubClient, GithubRoutingError } = await import(
  "../../src/overseer/github-app"
);
const { dbWorkspaceHoldings, getLiveInstallation, listWorkspaceInstallations } = await import(
  "../../src/overseer/installations"
);

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

// ---- the fake GitHub, which is the only GitHub in this process ----
//
// A code is exchanged for a token and a token lists installations. Both maps are this
// script's, so "what GitHub says this person can reach" is something the test states
// rather than something the implementation gets to decide.
const A_INSTALLATION = 111; // claimed by workspace A during this script
const A_SECOND = 222; // A's account, installed on GitHub, claimed by nobody
const B_INSTALLATION = 333; // B's own
const NOBODYS = 999; // exists nowhere; nothing may ever attach it

interface FakeInstallation {
  id: number;
  account: { id: number; login: string; type: string };
  repository_selection: string;
}

const REACHABLE: Record<string, FakeInstallation[]> = {
  "code-a": [
    { id: A_INSTALLATION, account: { id: 1, login: "acme", type: "Organization" }, repository_selection: "all" },
    { id: A_SECOND, account: { id: 2, login: "acme-labs", type: "Organization" }, repository_selection: "selected" },
  ],
  "code-b": [
    { id: B_INSTALLATION, account: { id: 3, login: "bravo", type: "User" }, repository_selection: "selected" },
  ],
  // B is a member of A's org on GitHub too, which is exactly the case the
  // already-claimed refusal has to handle without naming A.
  "code-b-in-acme": [
    { id: B_INSTALLATION, account: { id: 3, login: "bravo", type: "User" }, repository_selection: "selected" },
    { id: A_INSTALLATION, account: { id: 1, login: "acme", type: "Organization" }, repository_selection: "all" },
  ],
};

let tokensIssued = 0;
setGithubOAuth({
  async exchangeCode(code: string) {
    if (!(code in REACHABLE)) throw new Error(`fake GitHub: unknown code ${code}`);
    tokensIssued++;
    return `user-token-for-${code}`;
  },
  async listUserInstallations(userToken: string) {
    const code = userToken.replace("user-token-for-", "");
    return REACHABLE[code] ?? [];
  },
});

// ---- the world ----

const server = await startServer();
const base = `http://localhost:${server.port}`;
const now = Date.now();

const userA = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?").get("a@example.com")!.id;
const userB = tinyId("usr");
db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [userB, "b@example.com", now]);

const wsA = tinyId("ws");
const wsB = tinyId("ws");
db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, 'Alpha', 'private', ?)", [wsA, now]);
db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, 'Bravo', 'private', ?)", [wsB, now]);
db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [wsA, userA, now]);
db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [wsB, userB, now]);

// A's second installation exists on GitHub and nobody has claimed it — the state every
// installation passes through between "installed" and "connected", and the state the
// unheld case attacks.
db.run(
  "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, " +
    "account_type, repository_selection, created_at) VALUES (?, NULL, ?, 'acme-labs', 2, 'Organization', 'selected', ?)",
  [tinyId("ghi"), A_SECOND, now],
);

const cookieA = { cookie: sessionCookie(userA).split(";")[0]! };
const cookieB = { cookie: sessionCookie(userB).split(";")[0]! };
const ORIGIN = "http://localhost:3000";

function post(path: string, cookie: Record<string, string>, body?: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...cookie,
      origin: ORIGIN,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
}

/** Mint a claim the way the settings page does, and hand back the OAuth `state`. */
async function connect(wsId: string, cookie: Record<string, string>): Promise<string | null> {
  const res = await post(`/settings/${wsId}/github/connect`, cookie);
  if (res.status !== 303) return null;
  const location = res.headers.get("location")!;
  return new URL(location).searchParams.get("state");
}

async function callback(query: string, cookie: Record<string, string>) {
  return fetch(`${base}/github/setup?${query}`, { headers: cookie, redirect: "manual" });
}

/** The one-time attach handle the callback page carries, or null when it carried none —
 *  which is what every refusal must do. */
function attachTokenOf(body: string): string | null {
  return body.match(/name="claim" value="([^"]+)"/)?.[1] ?? null;
}

function installationRow(id: number) {
  return getLiveInstallation(id);
}

// ================= 1. the success everything else is measured against ==============

let attachTokenA: string;
{
  const state = await connect(wsA, cookieA);
  assert(!!state, "a member's connect POST redirects to GitHub with a state");
  assert(
    (await connect(wsA, cookieB)) === null,
    "a non-member's connect POST for A's workspace does not mint a claim",
  );

  const res = await callback(`code=code-a&state=${state}&setup_action=install`, cookieA);
  const body = await res.text();
  assert(res.status === 200, `A's callback renders the picker, got ${res.status}`);
  assert(body.includes(String(A_INSTALLATION)), "the picker offers the installation A can reach");
  assert(
    installationRow(A_INSTALLATION) === null,
    "the callback RENDERS and does not attach: a top-level GET has no usable Origin guard",
  );
  attachTokenA = attachTokenOf(body)!;
  assert(!!attachTokenA, "the picker carries a one-time attach handle");

  const claimed = await post("/github/claim", cookieA, {
    claim: attachTokenA,
    installation_id: String(A_INSTALLATION),
  });
  assert(claimed.status === 303, `the attach POST writes and redirects, got ${claimed.status}`);
  const row = installationRow(A_INSTALLATION);
  assert(!!row && row.workspace_id === wsA, "installation 111 is now workspace A's");
  assert(row!.account_login === "acme", `account facts came off the proof, got ${row?.account_login}`);
  assert(tokensIssued === 1, `exactly one user token was ever minted, got ${tokensIssued}`);
}

// The user access token is used and dropped. Not stored encrypted: not stored.
{
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => t.name);
  for (const table of tables) {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const value of Object.values(row)) {
        assert(
          typeof value !== "string" || !value.includes("user-token-for-"),
          `the user access token must reach no row; found one in ${table}`,
        );
      }
    }
  }
}

// ================= 2. B cannot see or derive through A's installation =============
{
  const holdings = dbWorkspaceHoldings();
  assert(
    JSON.stringify(holdings.installationIds(wsA)) === JSON.stringify([A_INSTALLATION]),
    "A's holdings are exactly what A claimed",
  );
  assert(
    JSON.stringify(holdings.installationIds(wsB)) === "[]",
    "B holds nothing, and an unclaimed installation is nobody's",
  );
  assert(
    listWorkspaceInstallations(wsA).length === 1 && listWorkspaceInstallations(wsB).length === 0,
    "the settings listing is per workspace",
  );

  const settingsA = await fetch(`${base}/settings/${wsA}`, { headers: cookieA });
  const bodyA = await settingsA.text();
  assert(settingsA.status === 200 && bodyA.includes("acme"), "A's own settings names A's account");
  const settingsAasB = await fetch(`${base}/settings/${wsA}`, { headers: cookieB });
  assert(settingsAasB.status === 404, `B asking for A's settings gets a 404, got ${settingsAasB.status}`);
  const settingsB = await fetch(`${base}/settings/${wsB}`, { headers: cookieB });
  const bodyB = await settingsB.text();
  assert(settingsB.status === 200, "B's own settings renders");
  assert(!bodyB.includes("acme"), "B's settings does not name A's account");

  // And the same answer at the transport, which is where it has to be true: routing is
  // per call inside the client, not a check the callers remember to run first.
  const app: AppApi = {
    async installationForRepo() {
      return A_INSTALLATION;
    },
    async installationToken() {
      return "ghs_minted";
    },
    noteRepositoryId() {},
    repositoryId() {
      return undefined;
    },
    invalidateRouting() {},
  };
  const pull = {
    number: 1723,
    title: "t",
    body: null,
    state: "open",
    user: null,
    head: { sha: "a".repeat(40), ref: "h" },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: 55501, full_name: "acme/seer" } },
    updated_at: "2026-08-04T00:00:00Z",
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(pull), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const clientFor = (wsId: string) =>
    createWorkspaceGithubClient({ workspaceId: wsId, holdings: dbWorkspaceHoldings(), app, fetchImpl });

  const derivedForA = await clientFor(wsA).getPull("acme/seer", 1723);
  assert(derivedForA.number === 1723, "A derives through the installation A holds");
  let refused = false;
  try {
    await clientFor(wsB).getPull("acme/seer", 1723);
  } catch (err) {
    refused = err instanceof GithubRoutingError;
  }
  assert(refused, "B cannot derive through A's installation, and is refused at the transport");
}

// ================= 3. the callback attaches nothing without a good state ==========
{
  const before = installationRow(A_SECOND);
  assert(before !== null && before.workspace_id === null, "A_SECOND starts unclaimed");

  // No state at all — the case GitHub's own install button produces when state is lost.
  const none = await callback("code=code-b&setup_action=install", cookieB);
  assert(none.status === 400, `a callback with no state is an error, got ${none.status}`);
  assert(attachTokenOf(await none.text()) === null, "and carries no attach handle");

  // A forged one.
  const forged = await callback("code=code-b&state=seer_ghs_forged&setup_action=install", cookieB);
  assert(forged.status === 403, `a forged state is refused, got ${forged.status}`);
  assert(attachTokenOf(await forged.text()) === null, "and carries no attach handle");

  // A replayed one: A's state was spent by the success above.
  const stateA2 = await connect(wsA, cookieA);
  const first = await callback(`code=code-a&state=${stateA2}&setup_action=install`, cookieA);
  assert(first.status === 200, "the first use of a state works");
  const replay = await callback(`code=code-a&state=${stateA2}&setup_action=install`, cookieA);
  assert(replay.status === 403, `a replayed state is refused, got ${replay.status}`);
  assert(attachTokenOf(await replay.text()) === null, "and carries no attach handle");

  // A state belonging to a different user. B holds it, B is signed in, B is a member of
  // their own workspace — and it is still A's claim.
  const stateA3 = await connect(wsA, cookieA);
  const stolen = await callback(`code=code-b&state=${stateA3}&setup_action=install`, cookieB);
  assert(stolen.status === 403, `a state belonging to another user is refused, got ${stolen.status}`);
  assert(attachTokenOf(await stolen.text()) === null, "and carries no attach handle");
  // ...and it is still usable by the person it was minted for, so the refusal above is
  // about who is asking rather than about the state having been consumed.
  const rightful = await callback(`code=code-a&state=${stateA3}&setup_action=install`, cookieA);
  assert(rightful.status === 200, `the rightful owner's state still works, got ${rightful.status}`);

  assert(installationRow(A_SECOND)!.workspace_id === null, "none of the above attached anything");
}

// ================= 4. the attach handle is single-use ============================
{
  const replayed = await post("/github/claim", cookieA, {
    claim: attachTokenA,
    installation_id: String(A_INSTALLATION),
  });
  assert(replayed.status === 403, `a spent attach handle is refused, got ${replayed.status}`);

  // A cross-site POST carrying a live handle is refused before anything is read.
  const state = await connect(wsA, cookieA);
  const page = await callback(`code=code-a&state=${state}&setup_action=install`, cookieA);
  const token = attachTokenOf(await page.text())!;
  const crossSite = await fetch(`${base}/github/claim`, {
    method: "POST",
    redirect: "manual",
    headers: { ...cookieA, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ claim: token, installation_id: String(A_SECOND) }).toString(),
  });
  assert(crossSite.status === 403, `a cross-site attach POST is refused, got ${crossSite.status}`);
  assert(installationRow(A_SECOND)!.workspace_id === null, "and attached nothing");
}

// ================= 5. THE UNHELD CASE ============================================
//
// A signed-in member of B, with a valid session, a valid Origin, and a claim they minted
// legitimately, naming an installation id belonging to A's account that nobody has
// claimed. Membership passes. The claim row passes. Only the proof refuses.
{
  const state = await connect(wsB, cookieB);
  const page = await callback(`code=code-b&state=${state}&setup_action=install`, cookieB);
  const body = await page.text();
  assert(page.status === 200, "B's own callback renders");
  assert(!body.includes(String(A_SECOND)), "the picker never offers an installation B cannot reach");
  const token = attachTokenOf(body)!;

  const unheld = await post("/github/claim", cookieB, {
    claim: token,
    installation_id: String(A_SECOND),
  });
  assert(unheld.status === 403, `naming an unclaimed installation of another account is refused, got ${unheld.status}`);
  assert(
    installationRow(A_SECOND)!.workspace_id === null,
    "and A_SECOND is still nobody's — this is the finding the whole OAuth leg exists for",
  );

  // An id that exists nowhere at all, on the same handle: also refused, and still not
  // because it was unknown to Seer but because the proof does not name it.
  const invented = await post("/github/claim", cookieB, {
    claim: token,
    installation_id: String(NOBODYS),
  });
  assert(invented.status === 403, `an installation absent from GET /user/installations is refused, got ${invented.status}`);
  assert(installationRow(NOBODYS) === null, "and nothing was created for it");

  // The success beside them: the same handle, the same session, the same Origin — the
  // one installation B actually proved.
  const held = await post("/github/claim", cookieB, {
    claim: token,
    installation_id: String(B_INSTALLATION),
  });
  assert(held.status === 303, `B attaches the installation B proved, got ${held.status}`);
  assert(installationRow(B_INSTALLATION)!.workspace_id === wsB, "installation 333 is now workspace B's");
}

// ================= 6. already claimed, and the refusal names nobody ==============
{
  // B really can reach A's installation on GitHub — an org member with access to one
  // repository is enough for GET /user/installations. The proof passes; the claim does
  // not, because A already holds it.
  const state = await connect(wsB, cookieB);
  const page = await callback(`code=code-b-in-acme&state=${state}&setup_action=install`, cookieB);
  const body = await page.text();
  assert(page.status === 200, "the callback renders");
  assert(!body.includes(String(A_INSTALLATION)), "an installation another workspace holds is not offered");
  const token = attachTokenOf(body)!;

  const refused = await post("/github/claim", cookieB, {
    claim: token,
    installation_id: String(A_INSTALLATION),
  });
  const refusalBody = await refused.text();
  assert(refused.status === 409, `an already-claimed installation is refused, got ${refused.status}`);
  assert(!refusalBody.includes(wsA), "the refusal does not name the workspace that holds it");
  assert(!refusalBody.includes("Alpha"), "not by name either");
  assert(installationRow(A_INSTALLATION)!.workspace_id === wsA, "and A still holds it");
}

// ================= 7. disconnect releases rather than strands ====================
{
  const rowB = installationRow(B_INSTALLATION)!;
  const notMine = await post(`/settings/${wsA}/github/${rowB.id}/disconnect`, cookieA);
  assert(notMine.status === 404, `A cannot disconnect B's installation, got ${notMine.status}`);
  assert(installationRow(B_INSTALLATION)!.workspace_id === wsB, "and B still holds it");

  const mine = await post(`/settings/${wsB}/github/${rowB.id}/disconnect`, cookieB);
  assert(mine.status === 303, `B disconnects B's own, got ${mine.status}`);
  assert(installationRow(B_INSTALLATION) === null, "no live row survives the disconnect");
  assert(
    dbWorkspaceHoldings().installationIds(wsB).length === 0,
    "and B derives through nothing",
  );

  // The audit row survives, and the id is free again: a soft delete under a column-level
  // UNIQUE would have stranded it forever.
  const audit = db
    .query<{ c: number }, [number]>("SELECT COUNT(*) c FROM github_installations WHERE installation_id = ?")
    .get(B_INSTALLATION)!.c;
  assert(audit === 1, `the disconnected row is kept for the audit trail, got ${audit}`);

  const state = await connect(wsB, cookieB);
  const page = await callback(`code=code-b&state=${state}&setup_action=install`, cookieB);
  const token = attachTokenOf(await page.text())!;
  const again = await post("/github/claim", cookieB, {
    claim: token,
    installation_id: String(B_INSTALLATION),
  });
  assert(again.status === 303, `a disconnected installation can be connected again, got ${again.status}`);
  assert(installationRow(B_INSTALLATION)!.workspace_id === wsB, "and it is B's again");
}

console.log("github install privacy: all assertions passed");
process.exit(0);
