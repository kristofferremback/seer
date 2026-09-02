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
import "../app-env";
import { generateKeyPairSync } from "node:crypto";
import { createTestDataDir } from "../test-data-dir";
// Type-only, so it is erased: nothing here may import an app module before the env
// above is set.
import type { AppApi } from "../../src/overseer/github-app";

process.env.API_TOKEN = "test-token";
delete process.env.AUTH_DISABLED;
delete process.env.GITHUB_TOKEN;
process.env.GOOGLE_CLIENT_ID = "dummy-client-id";
process.env.GOOGLE_CLIENT_SECRET = "dummy-client-secret";
process.env.SESSION_SECRET = "super-secret-for-tests";
process.env.SEER_ENCRYPTION_KEYS = `test:${Buffer.alloc(32, 7).toString("base64")}`;
process.env.SEER_ENCRYPTION_ACTIVE_KEY = "test";
process.env.ALLOWED_EMAILS = "a@example.com";
process.env.BASE_URL = "http://localhost:3000";
process.env.PORT = "0";
process.env.DATA_DIR = createTestDataDir("seer-tests-ghi-privacy-");

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
process.env.GITHUB_OAUTH_CLIENT_ID = "Ov23.testclientid";
process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-oauth-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

// This process does not get bunfig's test preload, so it closes both seams itself.
const { setGithubClientFactory } = await import("../../src/overseer/github-app");
const { setGithubOAuth } = await import("../../src/overseer/github-oauth");
const { setGithubUserOAuth } = await import("../../src/overseer/github-user-oauth");
const { offlineGithubClientFactory } = await import("../offline-github");
setGithubClientFactory(offlineGithubClientFactory());

// Close the account-OAuth seam too. Each code stands for both the token exchange and
// GET /user; no request made by this process can reach GitHub.
const accountOAuthCalls: string[] = [];
const rawAccountTokens: string[] = [];
setGithubUserOAuth({
  async exchangeAndIdentify(code: string) {
    accountOAuthCalls.push(code);
    const token = `raw-account-oauth-token-${code}`;
    rawAccountTokens.push(token);
    return {
      token,
      login: `github-get-user-${code}`,
      id: 70_000 + accountOAuthCalls.length,
      scopes: ["repo"],
      expiresAt: null,
    };
  },
});

const { sessionCookie } = await import("../../src/auth");
const { config } = await import("../../src/config");
const { db } = await import("../../src/db");
const { tinyId } = await import("../../src/ids");
const { startServer } = await import("../../src/server");
const { createWorkspaceGithubClient, GithubRoutingError } = await import(
  "../../src/overseer/github-app"
);
const { refResolver, RefResolveError } = await import("../../src/overseer/derive");
type DerivedReview = import("../../src/overseer/derive").DerivedReview;
const { putSnippet } = await import("../../src/overseer/db");
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
// Deliberately long and unlike anything else the page generates: the whole-body
// assertion below is only worth making if a match means the id and not a run of digits
// that happened to appear inside a generated id.
const A_INSTALLATION = 987000111222; // claimed by workspace A during this script
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

// ================= account OAuth connection privacy ================================
const credentialCount = () =>
  db.query<{ c: number }, []>("SELECT COUNT(*) c FROM github_user_credentials").get()!.c;
async function accountState(cookie: Record<string, string>): Promise<string> {
  const res = await post("/github/account/connect", cookie);
  assert(res.status === 303, `account connect redirects, got ${res.status}`);
  return new URL(res.headers.get("location")!).searchParams.get("state")!;
}
async function accountCallback(query: string, cookie: Record<string, string>) {
  return fetch(`${base}/github/account/callback?${query}`, { headers: cookie, redirect: "manual" });
}

// No state stores nothing; the same callback shape with a minted state stores one.
{
  const before = credentialCount();
  const refused = await accountCallback("code=no-state&account_login=request-forgery", cookieA);
  assert(refused.status === 403, `an account callback without state is refused, got ${refused.status}`);
  assert(credentialCount() === before, "an account callback without state stores nothing");
  const state = await accountState(cookieA);
  const ok = await accountCallback(`code=valid-after-none&state=${state}&account_login=request-forgery`, cookieA);
  assert(ok.status === 303, `a valid account callback succeeds, got ${ok.status}`);
  assert(credentialCount() === before + 1, "a valid account callback stores one credential");
}

// A forged state stores nothing, beside a freshly minted state that does work.
{
  const before = credentialCount();
  const refused = await accountCallback("code=forged&state=seer_gua_forged", cookieA);
  assert(refused.status === 403 && credentialCount() === before, "a forged account state stores nothing");
  const state = await accountState(cookieA);
  const ok = await accountCallback(`code=valid-after-forged&state=${state}`, cookieA);
  assert(ok.status === 303 && credentialCount() === before + 1, "a genuine account state stores a credential");
}

// The first presentation is the success; replaying the same nonce cannot add a second row.
{
  const before = credentialCount();
  const state = await accountState(cookieA);
  const first = await accountCallback(`code=replay-first&state=${state}`, cookieA);
  const replay = await accountCallback(`code=replay-second&state=${state}`, cookieA);
  assert(first.status === 303, "the first presentation of an account state succeeds");
  assert(replay.status === 403, `a replayed account state is refused, got ${replay.status}`);
  assert(credentialCount() === before + 1, "a replayed account state stores exactly one credential, not two");
}

// B cannot spend A's state, and that refusal does not burn A's successful use.
{
  const before = credentialCount();
  const state = await accountState(cookieA);
  const stolen = await accountCallback(`code=stolen-by-b&state=${state}`, cookieB);
  assert(stolen.status === 403 && credentialCount() === before, "B presenting A's account state stores nothing");
  const rightful = await accountCallback(`code=rightful-a&state=${state}`, cookieA);
  assert(rightful.status === 303 && credentialCount() === before + 1, "A presenting A's account state works");
}

// Identity comes only from the fake GET /user result, never attacker-controlled query data.
{
  const state = await accountState(cookieA);
  const code = "identity-source";
  const requestLogin = "request-supplied-login";
  const ok = await accountCallback(`code=${code}&state=${state}&account_login=${requestLogin}&login=${requestLogin}`, cookieA);
  assert(ok.status === 303, "the identity-source account callback succeeds");
  const row = db.query<{ id: string; account_login: string }, []>(
    "SELECT id,account_login FROM github_user_credentials ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get()!;
  assert(row.account_login === `github-get-user-${code}`, `account_login came from GET /user, got ${row.account_login}`);
  assert(row.account_login !== requestLogin, "request-carried login was ignored");

  // Prove a raw token was issued and is usable before asserting that plaintext is absent.
  const { openGithubUserCredential } = await import("../../src/overseer/user-credentials");
  const issued = rawAccountTokens.at(-1)!;
  assert(accountOAuthCalls.at(-1) === code && !!issued, "the fake OAuth exchange issued a token");
  assert(openGithubUserCredential(row.id, userA) === issued, "the issued OAuth token was used for the stored credential");
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const { name } of tables) {
    for (const stored of db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[]) {
      for (const value of Object.values(stored)) {
        // Substring rather than equality, and the difference is not pedantry: with a
        // strict !== check, storing the token INSIDE another column — appended to the
        // scopes JSON, say — slipped past while the assertion still read as "the token
        // is nowhere". The sibling App-token scan below already does it this way.
        assert(
          !String(value ?? "").includes(issued),
          `raw account OAuth token is not plaintext in ${name}`,
        );
      }
    }
  }
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
  // The page carries a one-time attach handle, which makes it a secret-bearing
  // response like every other one in this codebase, and they are all no-store.
  assert(
    (res.headers.get("cache-control") ?? "").includes("no-store"),
    `the page carrying the attach handle is no-store, got ${res.headers.get("cache-control")}`,
  );
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
  // The login is renameable and the id is not, which is the whole reason the column
  // exists — so a claim has to record GitHub's numeric account id, not a placeholder.
  assert(row!.account_id === 1, `the numeric account id came off the proof, got ${row?.account_id}`);
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
  // The panel has no "no app configured" state to fall into — config.ts requires the
  // App variables at boot — so both doors are always there. Asserted end to end, on the
  // real server, because the render-level version of this claim could pass with the
  // feature deleted from the route.
  assert(bodyA.includes(`/settings/${wsA}/github/connect`), "A's settings offers the connect form");
  assert(
    bodyA.includes("/installations/new"),
    "and the install-first link a fresh account needs",
  );

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
  // acme/seer is private, so only a credentialed read is answered — which is what makes
  // B's refusal a refusal rather than a public read the App was never withholding.
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    new Headers(init?.headers).has("Authorization")
      ? new Response(JSON.stringify(pull), { headers: { "content-type": "application/json" } })
      : new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
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
  assert(!body.includes(`name="installation_id" value="${A_SECOND}"`), "the picker never offers an installation B cannot reach");
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
  // Two assertions, because they fail for different reasons. The picker's form values are
  // what B could submit; the whole body is where the id could still leak through some
  // other rendering. The bare `!body.includes("111")` that once covered the second flaked
  // roughly one run in twenty — the page is full of generated ids drawn from an alphabet
  // with digits in it — so the fixture id is now long enough that a substring match is the
  // id itself, and the whole-body watch is back.
  const offered = [...body.matchAll(/name="installation_id"[^>]*value="(\d+)"/g)].map((m) => m[1]);
  assert(
    !offered.includes(String(A_INSTALLATION)),
    `an installation another workspace holds is not offered; picker offered ${offered.join(", ") || "none"}`,
  );
  assert(
    !body.includes(String(A_INSTALLATION)),
    "and it appears nowhere else in the page workspace B is shown either",
  );
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

// ========== 8. the snippet gate holds with the validator's single_repo rule off =====
//
// `validate.ts` enforces `single_repo`, so today a published ref can only name the
// review's own repository. The design's claim is that the ref_snippets gate does NOT
// depend on that: it is per-workspace by construction, at the transport. So this runs
// the resolver the publish path builds with no validator anywhere in front of it — the
// rule is not merely disabled, it is absent — and points a ref at a repository the
// workspace holds no installation for.
{
  const HELD = "acme/seer"; // routed through A_INSTALLATION, which wsA holds
  const FOREIGN = "acme-labs/private"; // routed through A_SECOND, which nobody holds
  const SHA = "c".repeat(40);
  const SECRET_BYTES = "the private source nobody outside acme-labs may read\n";

  // Somebody else's resolution already put the foreign file in the shared table: this
  // is the cache that has no workspace column, and the thing the gate withholds.
  putSnippet(FOREIGN, SHA, "src/keys.ts", SECRET_BYTES);
  putSnippet(HELD, SHA, "src/held.ts", "a held line\n");

  const app: AppApi = {
    async installationForRepo(repo: string) {
      if (repo === HELD) return A_INSTALLATION;
      if (repo === FOREIGN) return A_SECOND;
      return null;
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
  let fetched = 0;
  // FOREIGN is private, so GitHub answers an unauthenticated read with a 404 — which is
  // what the anonymous fallback for an unheld repository will get, and the only reason
  // that fallback is safe: no credential, no bytes.
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const credentialed = new Headers(init?.headers).has("Authorization");
    if (credentialed) fetched++;
    if (!credentialed) return new Response("Not Found", { status: 404 });
    return new Response(url.includes("acme-labs") ? SECRET_BYTES : "a held line\n", {
      headers: { "content-type": "application/vnd.github.raw" },
    });
  }) as unknown as typeof fetch;
  const clientFor = (wsId: string) =>
    createWorkspaceGithubClient({ workspaceId: wsId, holdings: dbWorkspaceHoldings(), app, fetchImpl });
  // prs: [] is the honest shape here — the resolver uses them only to label an origin,
  // and a review whose refs leave its own repositories is precisely the case.
  const emptyReview = { kind: "stack", prs: [], observations: [], skillContext: [] } as unknown as DerivedReview;

  const foreignPointer = { repo: FOREIGN, sha: SHA, path: "src/keys.ts", startLine: 1, endLine: 1 };
  const err = await refResolver(clientFor(wsA), emptyReview)
    .resolve(foreignPointer)
    .catch((e: unknown) => e);
  assert(err instanceof RefResolveError, `a ref into an unheld repository is refused, got ${err}`);
  const cause = (err as InstanceType<typeof RefResolveError>).cause;
  assert(
    cause instanceof GithubRoutingError,
    `refused at the transport by routing, not by anything upstream: ${cause}`,
  );
  assert(fetched === 0, `and no request carrying a credential was made for it, got ${fetched}`);
  assert(
    !String((err as Error).message).includes("private source"),
    "the refusal does not carry the cached bytes",
  );

  // The success beside it, or the refusal above proves only that the resolver is
  // broken: the same resolver, the same shape of pointer, a repository wsA holds.
  const ok = await refResolver(clientFor(wsA), emptyReview).resolve({
    repo: HELD,
    sha: SHA,
    path: "src/held.ts",
    startLine: 1,
    endLine: 1,
  });
  assert(ok.snippet.includes("a held line"), "a ref into a held repository resolves");
  assert(fetched === 1, `and it paid a real fetch rather than reading the cache, got ${fetched}`);
}

// ---- one person's credential is not another's to revoke ----
//
// The store is owner-scoped and step 1 proves that directly. This asks the question a
// route away, because the route is where the mistake actually gets made: a handler that
// passes the credential id through without the session user attached looks identical in
// review and is wrong in exactly one way.
{
  const { createGithubUserCredential, listGithubUserCredentials } = await import(
    "../../src/overseer/user-credentials"
  );
  const mine = createGithubUserCredential({
    userId: userA,
    kind: "pat",
    label: "a-only",
    secret: "github_pat_belongs-to-a-alone",
    accountLogin: "octocat",
    accountId: 1,
    scopes: ["repo"],
    expiresAt: null,
  });

  const revoke = (cookie: Record<string, string>) =>
    fetch(`${base}/settings/${wsA}/github/credentials/${mine}/revoke`, {
      method: "POST",
      // config.baseUrl, not `base`: the test server binds port 0 while the configured
      // origin keeps its fixed string, and originOk compares against the configured host.
      headers: { ...cookie, origin: config.baseUrl },
      redirect: "manual",
    });

  // B is made a member of A's workspace FIRST, and this is the whole point of the test.
  // Without it, requireMember refuses B before ownership is ever consulted, and the
  // assertion below passes against a route that ignores ownership entirely -- verified:
  // an unscoped revoke that takes any credential id still leaves that version green.
  // Membership is the wrong gate here. A credential belongs to a person, and sharing a
  // workspace with them is not a claim on it.
  db.run("INSERT OR IGNORE INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
    wsA,
    userB,
    Date.now(),
  ]);

  const byB = await revoke(cookieB);
  assert(byB.status !== 303, `B revoking A's credential is refused, got ${byB.status}`);
  assert(
    listGithubUserCredentials(userA).some((row) => row.id === mine),
    "and A's credential is still live afterwards",
  );

  // The success beside the refusal: A revoking their own works, which is what makes the
  // refusal above mean something rather than being a route that is broken for everyone.
  const byA = await revoke(cookieA);
  assert(byA.status === 303, `A revoking their own credential works, got ${byA.status}`);
  assert(
    !listGithubUserCredentials(userA).some((row) => row.id === mine),
    "and it is gone from the live list",
  );
}
// ---- the threading, end to end: a key spends its own owner's credential ----
//
// Everything above tests the pieces. This asks the question the whole feature turns on,
// through the real publish route: two people in ONE workspace, one of whom has connected
// a GitHub account. The other must not be able to reach that account's repositories, even
// though they share the workspace and can read every review in it.
//
// This is the test that fails if githubClientFor is ever called without an asking user.
// The client, the routing and the store were all correct before the threading landed, and
// none of them would have noticed: a workspace-only lookup finds no credential at all and
// refuses everybody, which reads as safe right up until somebody "fixes" it by resolving
// credentials from the workspace.
{
  const { createGithubUserCredential } = await import("../../src/overseer/user-credentials");
  const { mintApiKey } = await import("../../src/db");
  const { setGithubClientFactory } = await import("../../src/overseer/github-app");
  const { createUserGithubClient } = await import("../../src/overseer/github-user");

  // Both people are members of the same workspace. Only A connects an account.
  db.run("INSERT OR IGNORE INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
    wsA,
    userB,
    Date.now(),
  ]);
  const A_TOKEN = "github_pat_a_private_work";
  createGithubUserCredential({
    userId: userA,
    kind: "pat",
    label: "work",
    secret: A_TOKEN,
    accountLogin: "acme-work",
    accountId: 99,
    scopes: ["contents:read"],
  });

  const keyOfA = mintApiKey(userA, wsA, "a's key").token;
  const keyOfB = mintApiKey(userB, wsA, "b's key").token;

  // A transport where acme/work-private opens for A's token and nothing else.
  const reached: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    reached.push(`${auth} ${url}`);
    if (/\/repos\/acme\/work-private$/.test(url)) {
      return auth === `Bearer ${A_TOKEN}`
        ? Response.json({ id: 4242 })
        : new Response("nf", { status: 404 });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;

  // The real factory shape: workspace holdings find nothing (no installation), so the
  // only route left is the asking user's credential.
  setGithubClientFactory((_workspaceId: string, asking?: string) =>
    asking
      ? createUserGithubClient(asking, { apiBase: "https://github.test", fetchImpl })
      : ({
          async getPull(): Promise<never> {
            throw new Error("no asking user, so no credential to spend");
          },
        } as never),
  );

  const publish = (key: string) =>
    fetch(`${base}/api/reviews`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        slug: "cred-route",
        title: "t",
        summary: "s",
        prs: [{ repo: "acme/work-private", number: 1 }],
        statements: [],
        notes: [],
        groups: [],
      }),
    });

  const asB = await publish(keyOfB);
  assert(asB.status !== 200, `B publishing against A's private repo is refused, got ${asB.status}`);
  assert(
    !reached.some((entry) => entry.startsWith(`Bearer ${A_TOKEN}`)),
    "and A's token was never sent on B's behalf",
  );

  // The success beside the refusal, and the thing that proves the refusal is about WHO
  // asked rather than the repository being unreachable for everyone: A gets past routing
  // with the same body. (It fails later, on validation, which is fine -- the assertion is
  // that A's token reached GitHub and B's request never produced it.)
  const beforeA = reached.length;
  await publish(keyOfA);
  assert(
    reached.slice(beforeA).some((entry) => entry.startsWith(`Bearer ${A_TOKEN}`)),
    "A's own key does spend A's credential",
  );

  setGithubClientFactory(null);
}

console.log("github install privacy: all assertions passed");
process.exit(0);
