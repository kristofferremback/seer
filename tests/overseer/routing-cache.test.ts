// What the routing cache is allowed to remember, and what has to make it forget.
//
// The cache answers "which installation covers this repository", authenticating as the
// App, whose rate limit is shared by every workspace on the instance — so a positive
// answer is cached for hours on purpose. A negative is a different claim about the
// world: it is what the ordinary first run produces, before the user has installed
// anything, and the sequence that follows it (install, connect, publish again) is the
// sequence the whole feature begins with. Nothing here may leave a user refused for
// something they have already done.
//
// Nothing opens a socket: every request goes through a fake transport that counts what
// was asked, which is also how "the answer was cached" is told apart from "the answer
// was looked up again and happened to agree".

import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { migrate } from "../../src/migrate";
import {
  createAppApi,
  NEGATIVE_ROUTING_TTL_MS,
  ROUTING_TTL_MS,
  setAppApi,
  type AppApi,
} from "../../src/overseer/github-app";
import { handleClaimInstallation, handleGithubSetupCallback } from "../../src/overseer/github-claim";
import { setGithubOAuth } from "../../src/overseer/github-oauth";
import { createClaim, getLiveInstallation } from "../../src/overseer/installations";
import { offlineGithubOAuth } from "../offline-github";

migrate();

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CREDENTIALS = {
  appId: "424242",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const API = "https://api.github.test";
const REPO = "acme/seer";
const INSTALLATION = 4242;

interface Fake {
  /** What GitHub currently says about REPO. Flipped by the test, not by the code. */
  installed: boolean;
  lookups: number;
  api: AppApi;
  clock: number;
}

function fakeApp(): Fake {
  const f: Fake = {
    installed: false,
    lookups: 0,
    clock: Date.now(),
    api: null as unknown as AppApi,
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/installation$/.test(url)) {
      f.lookups++;
      return f.installed ? Response.json({ id: INSTALLATION }) : new Response("{}", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  f.api = createAppApi({
    credentials: CREDENTIALS,
    apiBase: API,
    fetchImpl,
    now: () => f.clock,
  });
  return f;
}

afterEach(() => {
  setAppApi(null);
  setGithubOAuth(offlineGithubOAuth());
});

test("a negative routing answer expires in a minute; a positive one is the answer cached for hours", async () => {
  const f = fakeApp();

  expect(await f.api.installationForRepo(REPO)).toBe(null);
  expect(f.lookups).toBe(1);
  // Immediately after, it is cached: the negative is cached, it is simply not cached long.
  expect(await f.api.installationForRepo(REPO)).toBe(null);
  expect(f.lookups).toBe(1);

  // The user goes and installs the App. Nothing tells this process about it.
  f.installed = true;
  f.clock += NEGATIVE_ROUTING_TTL_MS + 1;
  expect(await f.api.installationForRepo(REPO)).toBe(INSTALLATION);
  expect(f.lookups).toBe(2);

  // And the answer that survives is the positive one — still cached long after a
  // negative would have expired, which is what the shared App rate limit is protected by.
  const positiveLookups = f.lookups;
  f.clock += NEGATIVE_ROUTING_TTL_MS * 10;
  expect(await f.api.installationForRepo(REPO)).toBe(INSTALLATION);
  expect(f.lookups).toBe(positiveLookups);
  expect(NEGATIVE_ROUTING_TTL_MS).toBeLessThan(ROUTING_TTL_MS);
});

test("a negative is not cached for a repository whose 404 the asker was never entitled to ask about", async () => {
  // The cross-workspace shape: whatever one workspace's publish body makes this process
  // look up, another workspace's publish a moment later must not inherit as a refusal
  // that outlives their own attempt. The bound is the same short TTL, asserted here as
  // elapsed time rather than as a constant, because that is the property that matters.
  const f = fakeApp();
  expect(await f.api.installationForRepo("victim/app")).toBe(null);
  f.installed = true;
  f.clock += 5 * 60 * 1000; // five minutes later, the victim connects and publishes
  expect(await f.api.installationForRepo("victim/app")).toBe(INSTALLATION);
});

// ---- the two events that are synchronous with a click ----

const rootUser = () => listMembers(legacyWorkspaceId()!)[0]!.id;

/** Drive the OAuth callback with a GitHub that says exactly this, and hand back the
 *  one-time attach handle the picker carries. */
async function pickerFor(
  wsId: string,
  userId: string,
  installations: Array<{ id: number; account: { id: number; login: string; type: string } }>,
  setupAction = "install",
): Promise<Response> {
  const { nonce } = createClaim(wsId, userId);
  setGithubOAuth({
    async exchangeCode() {
      return "user-token";
    },
    async listUserInstallations() {
      return installations.map((i) => ({ ...i, repository_selection: "all" }));
    },
  });
  return handleGithubSetupCallback(
    new Request(`http://localhost/github/setup?code=c&state=${nonce}&setup_action=${setupAction}`),
  );
}

test("connecting an installation makes the repository routable now, not in six hours", async () => {
  const user = rootUser();
  const ws = createWorkspace("Routing connect", user);
  const f = fakeApp();
  setAppApi(f.api);

  // The first run: publish is refused because nothing covers the repository, and that
  // refusal is remembered.
  expect(await f.api.installationForRepo(REPO)).toBe(null);

  // The user does exactly what the refusal told them to: installs the App, and connects it.
  f.installed = true;
  const picker = await pickerFor(ws, user, [
    { id: INSTALLATION, account: { id: 7, login: "acme", type: "Organization" } },
  ]);
  const claimToken = (await picker.text()).match(/name="claim" value="([^"]+)"/)?.[1];
  expect(claimToken).toBeTruthy();

  const attached = await handleClaimInstallation(
    new Request("http://localhost/github/claim", {
      method: "POST",
      body: new URLSearchParams({ claim: claimToken!, installation_id: String(INSTALLATION) }),
    }),
  );
  expect(attached.status).toBe(303);
  expect(getLiveInstallation(INSTALLATION)?.workspace_id).toBe(ws);

  // The clock has not moved. Their next publish resolves.
  expect(await f.api.installationForRepo(REPO)).toBe(INSTALLATION);
});

test("setup_action=update makes a newly added repository routable immediately", async () => {
  const user = rootUser();
  const ws = createWorkspace("Routing update", user);
  const INST = 5150;
  db.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, " +
      "account_type, repository_selection, created_at) VALUES (?, ?, ?, 'acme', 7, 'Organization', 'selected', ?)",
    [`ghi_upd_${INST}`, ws, INST, Date.now()],
  );

  const f = fakeApp();
  setAppApi(f.api);
  expect(await f.api.installationForRepo("acme/newly-added")).toBe(null);

  // The user clicks Configure on GitHub and ticks another repository. This is the one
  // event that is synchronous with the click, which is why the design names it.
  f.installed = true;
  const res = await pickerFor(
    ws,
    user,
    [{ id: INST, account: { id: 7, login: "acme", type: "Organization" } }],
    "update",
  );
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("refreshed");

  expect(await f.api.installationForRepo("acme/newly-added")).toBe(INSTALLATION);
});
