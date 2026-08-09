// Step 1's done-condition, asserted rather than described.
//
// Nothing here opens a socket: every request goes through a fake transport that records
// what was asked and with which Authorization header, which is also the only way to show
// that the minted token is the credential the client actually used — the question the
// "no token in SQLite" assertion is vacuous without.

import { beforeEach, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { db } from "../../src/db";
import { migrate } from "../../src/migrate";
import { GithubError, type GithubPull } from "../../src/overseer/github";
import {
  appJwt,
  createAppApi,
  createWorkspaceGithubClient,
  GithubAppRefusal,
  githubClientFor,
  GithubRateLimitError,
  GithubRoutingError,
  GithubSuspendedError,
  JWT_BACKDATE_SECONDS,
  resetAnonymousReachability,
  ROUTING_CACHE_MAX,
  setGithubClientFactory,
  setWorkspaceHoldings,
  TOKEN_REMINT_EARLY_MS,
  type AppApi,
  type WorkspaceHoldings,
} from "../../src/overseer/github-app";
import { githubOAuth } from "../../src/overseer/github-oauth";
import { dbWorkspaceHoldings } from "../../src/overseer/installations";
import { githubUserOAuth } from "../../src/overseer/github-user-oauth";
import { identify } from "../../src/overseer/github-user-pat";
import { offlineGithubClientFactory } from "../offline-github";

migrate();

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CREDENTIALS = { appId: "424242", privateKeyPem: PRIVATE_KEY };

const API = "https://api.github.test";
const REPO = "threahq/threa";
const REPO_ID = 1301620029;
const INSTALLATION = 77;

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

interface Transport {
  fetchImpl: typeof fetch;
  seen: Seen[];
  /** Tokens handed out in order, so a test can watch a re-mint happen. */
  minted: string[];
  installationFor: (repo: string) => number | null;
  /** Seconds from now that the next minted token expires. */
  tokenLifetimeMs: number;
  /** Whether the repository is one GitHub serves to a request carrying no credential. */
  publicRepo: boolean;
}

function pullPayload(): GithubPull {
  return {
    number: 1723,
    title: "A pull request",
    body: null,
    state: "open",
    user: { login: "ada" },
    head: { sha: "a".repeat(40), ref: "topic" },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: REPO_ID, full_name: REPO } },
    updated_at: "2026-08-04T10:00:00Z",
  };
}

function transport(): Transport {
  const t: Transport = {
    seen: [],
    minted: [],
    installationFor: () => INSTALLATION,
    tokenLifetimeMs: 60 * 60 * 1000,
    publicRepo: false,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      t.seen.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      const routing = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (routing) {
        const id = t.installationFor(routing[1]!);
        if (id === null) return new Response("{}", { status: 404 });
        return Response.json({ id });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        const token = `ghs_minted_${t.minted.length + 1}_${"x".repeat(20)}`;
        t.minted.push(token);
        return Response.json({
          token,
          expires_at: new Date(Date.now() + t.tokenLifetimeMs).toISOString(),
        });
      }
      // A repository read with no credential is answered only when the repository is
      // public; a private one is GitHub's 404, which is what the anonymous fallback has
      // to run into for its refusal to be reached.
      if (url.includes("/repos/") && !headers.has("Authorization") && !t.publicRepo) {
        return new Response("Not Found", { status: 404 });
      }
      if (/\/pulls\/\d+$/.test(url)) return Response.json(pullPayload());
      if (url.includes("/contents/")) return new Response("a line\n");
      if (/\/pulls\/\d+\/files/.test(url)) return Response.json([]);
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch,
  };
  return t;
}

function holdings(map: Record<string, number[]>): WorkspaceHoldings {
  return { installationIds: (workspaceId) => map[workspaceId] ?? [] };
}

function clientFor(t: Transport, workspaceId: string, held: Record<string, number[]>, app?: AppApi) {
  const api =
    app ?? createAppApi({ credentials: CREDENTIALS, apiBase: API, fetchImpl: t.fetchImpl });
  return {
    api,
    client: createWorkspaceGithubClient({
      workspaceId,
      holdings: holdings(held),
      app: api,
      apiBase: API,
      fetchImpl: t.fetchImpl,
    }),
  };
}

// The anonymous-unreachable memory is process-wide and most tests here name the same
// repository, so one test's deliberate 404 must not fail-fast the next test's read.
beforeEach(() => resetAnonymousReachability());

// No beforeEach installing the offline factory here, deliberately. There used to be one,
// and it made the "cannot reach the network through either seam" test below verify the
// factory it had just installed itself rather than the one tests/setup.ts installs — so
// neutering the preload left the whole suite green. The seam is the preload's to close,
// and this file's job is to notice when it stops.

// ---- the JWT ----

test("the app JWT is RS256 over {iat, exp, iss}, verifiable with the public key", () => {
  const now = Date.now();
  const jwt = appJwt(CREDENTIALS, now);
  const [header, payload, signature] = jwt.split(".");
  expect(signature).toBeTruthy();

  const decode = (part: string) => JSON.parse(Buffer.from(part!, "base64url").toString());
  expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });

  const claims = decode(payload!);
  expect(claims.iss).toBe("424242");
  expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "iss"]);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  expect(
    verifier.verify(createPublicKey(PRIVATE_KEY), Buffer.from(signature!, "base64url")),
  ).toBe(true);
});

test("iat is backdated and the lifetime stays inside GitHub's ten-minute ceiling", () => {
  const now = Date.now();
  const claims = JSON.parse(
    Buffer.from(appJwt(CREDENTIALS, now).split(".")[1]!, "base64url").toString(),
  );
  const seconds = Math.floor(now / 1000);

  // The whole point: a JWT stamped with the local clock's "now" is rejected by GitHub
  // the moment the host runs a second fast.
  expect(claims.iat).toBeLessThan(seconds);
  expect(seconds - claims.iat).toBe(JWT_BACKDATE_SECONDS);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  expect(claims.exp).toBeGreaterThan(seconds);
});

test("a forged signature does not verify against the app's public key", () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt(
    { appId: "424242", privateKeyPem: other.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    Date.now(),
  );
  const [header, payload, signature] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  expect(
    verifier.verify(createPublicKey(PRIVATE_KEY), Buffer.from(signature!, "base64url")),
  ).toBe(false);
});

// ---- the minted token, and where it does not go ----

test("routing uses the app JWT and the pull request call uses the minted token", async () => {
  const t = transport();
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  const pull = await client.getPull(REPO, 1723);
  expect(pull.number).toBe(1723);

  const routing = t.seen.find((s) => s.url.endsWith("/installation"))!;
  expect(routing.url).toBe(`${API}/repos/${REPO}/installation`);
  const jwtHeader = JSON.parse(
    Buffer.from(routing.authorization!.replace("Bearer ", "").split(".")[0]!, "base64url").toString(),
  );
  expect(jwtHeader.alg).toBe("RS256");

  const mint = t.seen.find((s) => s.url.includes("/access_tokens"))!;
  expect(mint.method).toBe("POST");
  expect(mint.url).toBe(`${API}/app/installations/${INSTALLATION}/access_tokens`);

  const call = t.seen.find((s) => s.url.includes("/pulls/"))!;
  expect(t.minted).toHaveLength(1);
  expect(call.authorization).toBe(`Bearer ${t.minted[0]}`);
});

test("the minted token appears in no SQLite row afterwards", async () => {
  const t = transport();
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  await client.getPull(REPO, 1723);

  const token = t.minted[0]!;
  // Demonstrated above, and again here, so this is not the vacuous version of the
  // assertion: the token exists and is the credential the transport carried.
  expect(token).toMatch(/^ghs_minted_/);
  expect(t.seen.some((s) => s.authorization === `Bearer ${token}`)).toBe(true);

  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  expect(tables.length).toBeGreaterThan(0);

  const hits: string[] = [];
  let scanned = 0;
  for (const { name } of tables) {
    for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all()) {
      scanned++;
      for (const [column, value] of Object.entries(row)) {
        const text =
          typeof value === "string"
            ? value
            : value instanceof Uint8Array
              ? Buffer.from(value).toString("utf8")
              : "";
        if (text.includes(token)) hits.push(`${name}.${column}`);
      }
    }
  }
  // A scan of nothing proves nothing, so the scan itself has to have found rows.
  expect(scanned).toBeGreaterThan(0);
  expect(hits).toEqual([]);
});

test("a cached token is reused, and re-minted five minutes before it expires", async () => {
  const t = transport();
  const { client, api } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  // The repository id is known up front here, so both calls mint at the same scope and
  // the only thing under test is the cache. (The name-then-id progression is its own
  // test below, and it does mint twice, on purpose: the two scopes are two tokens.)
  api.noteRepositoryId(REPO, REPO_ID);

  await client.getPull(REPO, 1723);
  await client.getPull(REPO, 1723);
  expect(t.minted).toHaveLength(1);

  // A token whose remaining life is inside the re-mint window is not reused, even
  // though GitHub would still accept it.
  const near = transport();
  near.tokenLifetimeMs = TOKEN_REMINT_EARLY_MS - 1000;
  const fresh = clientFor(near, "ws_a", { ws_a: [INSTALLATION] });
  fresh.api.noteRepositoryId(REPO, REPO_ID);
  await fresh.client.getPull(REPO, 1723);
  await fresh.client.getPull(REPO, 1723);
  expect(near.minted).toHaveLength(2);
});

test("the mint is narrow: by name first, by repository_ids once the id has been seen", async () => {
  const t = transport();
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  await client.getPull(REPO, 1723);
  const first = t.seen.find((s) => s.url.includes("/access_tokens"))!.body as Record<string, unknown>;
  expect(first).toEqual({ repositories: ["threa"] });

  // getPull carried base.repo.id, so the next mint can name the repository by the one
  // identity a rename does not change.
  t.tokenLifetimeMs = 0; // force a re-mint rather than a cache hit
  await client.getPull(REPO, 1723);
  const mints = t.seen.filter((s) => s.url.includes("/access_tokens"));
  expect(mints).toHaveLength(2);
  expect(mints[1]!.body).toEqual({ repository_ids: [REPO_ID] });
});

test("the routing answer is cached, so the shared app-JWT budget is spent once", async () => {
  const t = transport();
  const { client, api } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  await client.getPull(REPO, 1723);
  await client.getPull(REPO, 1723);
  expect(t.seen.filter((s) => s.url.endsWith("/installation"))).toHaveLength(1);

  api.invalidateRouting(REPO);
  await client.getPull(REPO, 1723);
  expect(t.seen.filter((s) => s.url.endsWith("/installation"))).toHaveLength(2);
});

// ---- the refusal, and the success beside it ----

test("the client refuses a repository the workspace does not hold, and serves one it does", async () => {
  const t = transport();
  const app = createAppApi({ credentials: CREDENTIALS, apiBase: API, fetchImpl: t.fetchImpl });
  const held = { ws_a: [INSTALLATION], ws_b: [999] };

  // The thing being withheld is demonstrably there to withhold: same repository, same
  // installation, same transport — only the workspace's holdings differ.
  const a = createWorkspaceGithubClient({
    workspaceId: "ws_a",
    holdings: holdings(held),
    app,
    apiBase: API,
    fetchImpl: t.fetchImpl,
  });
  expect((await a.getPull(REPO, 1723)).number).toBe(1723);

  const b = createWorkspaceGithubClient({
    workspaceId: "ws_b",
    holdings: holdings(held),
    app,
    apiBase: API,
    fetchImpl: t.fetchImpl,
  });
  const before = t.minted.length;
  const holds = /no GitHub App installation this workspace holds covers it/;
  await expect(b.getPull(REPO, 1723)).rejects.toThrow(GithubRoutingError);
  await expect(b.listFiles(REPO, 1723)).rejects.toThrow(holds);
  await expect(b.getFileAtSha(REPO, "src/index.ts", "c".repeat(40))).rejects.toThrow(holds);
  // The refusal is at the transport: no credential was minted for the refused call, and
  // the anonymous attempt behind it carried none either.
  expect(t.minted.length).toBe(before);
  expect(t.seen.filter((s) => s.url.includes("/pulls/") && s.authorization !== null)).toHaveLength(1);
});

test("a private repository no installation covers is refused, naming the repository", async () => {
  const t = transport();
  t.installationFor = () => null;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  await expect(client.getPull(REPO, 1723)).rejects.toThrow(
    new RegExp(`${REPO} is not reachable anonymously`),
  );
  expect(t.minted).toHaveLength(0);
});

// ---- the public repository, which was reviewable before the App and stays so ----

test("a public repository no installation covers is read anonymously, with no credential", async () => {
  const t = transport();
  t.installationFor = () => null;
  t.publicRepo = true;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  expect((await client.getPull(REPO, 1723)).number).toBe(1723);
  const call = t.seen.find((s) => s.url.includes("/pulls/"))!;
  expect(call.authorization).toBeNull();
  expect(t.minted).toHaveLength(0);
});

test("a public repository the workspace does not hold is read anonymously too", async () => {
  const t = transport();
  t.publicRepo = true;
  const { client } = clientFor(t, "ws_b", { ws_b: [999] });

  expect((await client.getPull(REPO, 1723)).number).toBe(1723);
  expect(t.seen.find((s) => s.url.includes("/pulls/"))!.authorization).toBeNull();
  expect(t.minted).toHaveLength(0);
});

test("when the anonymous read fails, the refusal names both the failure and the remedy", async () => {
  const t = transport();
  t.installationFor = () => null;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  const err = await client.getPull(REPO, 1723).then(
    () => null,
    (e: unknown) => e as GithubAppRefusal,
  );
  expect(err).toBeInstanceOf(GithubAppRefusal);
  expect(err!.message).toContain(`${REPO} is not reachable anonymously`);
  expect(err!.message).toContain("install the app on the threahq account");
  // GitHub's own answer survives, or an operator has nothing to look at.
  expect(err!.message).toMatch(/GitHub answered: .*404/);
});

// ---- the two rows of the failure table that are not about holdings ----

test("a suspended installation is a 422 naming the account, not a 502 with GitHub's string", async () => {
  const t = transport();
  const inner = t.fetchImpl;
  t.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (/access_tokens$/.test(String(input))) {
      return new Response(JSON.stringify({ message: "This installation has been suspended" }), {
        status: 403,
      });
    }
    return inner(input as string, init);
  }) as unknown as typeof fetch;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  const err = await client.getPull(REPO, 1723).then(
    () => null,
    (e: unknown) => e as GithubSuspendedError,
  );
  expect(err).toBeInstanceOf(GithubSuspendedError);
  // 422 and not 502: this is not a fault to retry, and only a human on that account can
  // clear it — so the account is named.
  expect(err!.status).toBe(422);
  expect(err!.message).toContain("suspended");
  expect(err!.message).toContain(REPO.split("/")[0]!);
  expect(err!.installationId).toBe(INSTALLATION);
});

test("the app's exhausted rate limit is a 422 naming the limit, not the repository", async () => {
  const t = transport();
  t.fetchImpl = (async (input: string | URL | Request) => {
    // Routing is the first app-JWT call any publish makes, so it is where a spent
    // budget shows up.
    expect(String(input)).toContain("/installation");
    return new Response(JSON.stringify({ message: "API rate limit exceeded for installation" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
  }) as unknown as typeof fetch;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  const err = await client.getPull(REPO, 1723).then(
    () => null,
    (e: unknown) => e as GithubRateLimitError,
  );
  expect(err).toBeInstanceOf(GithubRateLimitError);
  expect(err!.status).toBe(422);
  expect(err!.message).toMatch(/rate limit/i);
  // The repository is not the problem, and naming it would send the skill to fix the
  // wrong thing: the limit is shared by every workspace on this instance.
  expect(err!.message).not.toContain(REPO);
  expect(t.minted).toHaveLength(0);
});

test("a repository no installation covers names the account that needs the app", async () => {
  const t = transport();
  t.installationFor = () => null;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  await expect(client.getPull(REPO, 1723)).rejects.toThrow(/install the app on the threahq account/);
  // And the held-by-somebody-else refusal names it too.
  const t2 = transport();
  const { client: other } = clientFor(t2, "ws_b", { ws_b: [999] });
  await expect(other.getPull(REPO, 1723)).rejects.toThrow(/install the app on the threahq account/);
});

test("assertRepo runs before routing, so a malformed name never reaches the transport", async () => {
  const t = transport();
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  await expect(client.getPull("threahq/threa#x", 1723)).rejects.toThrow(GithubError);
  expect(t.seen).toHaveLength(0);
});

// ---- what the caches do not do, which is grow forever ----

test("the routing cache is bounded, and the oldest entry is the one that goes", async () => {
  const t = transport();
  const api = createAppApi({ credentials: CREDENTIALS, apiBase: API, fetchImpl: t.fetchImpl });
  const first = "threahq/r0";

  for (let i = 0; i <= ROUTING_CACHE_MAX; i++) await api.installationForRepo(`threahq/r${i}`);
  const lookups = () => t.seen.filter((s) => s.url.endsWith("/installation")).length;
  expect(lookups()).toBe(ROUTING_CACHE_MAX + 1);

  // The newest is still cached; the oldest was evicted to make room for it.
  await api.installationForRepo(`threahq/r${ROUTING_CACHE_MAX}`);
  expect(lookups()).toBe(ROUTING_CACHE_MAX + 1);
  await api.installationForRepo(first);
  expect(lookups()).toBe(ROUTING_CACHE_MAX + 2);
}, 30_000);

test("a hot positive routing answer survives a flood of negatives", async () => {
  const t = transport();
  t.installationFor = (repo) => (repo === REPO ? INSTALLATION : null);
  const api = createAppApi({ credentials: CREDENTIALS, apiBase: API, fetchImpl: t.fetchImpl });

  await api.installationForRepo(REPO);
  const repoLookups = () =>
    t.seen.filter((s) => s.url.includes(`/repos/${REPO}/installation`)).length;
  expect(repoLookups()).toBe(1);

  // Sixty-second negatives must consume themselves, not the six-hour positive every
  // real workspace depends on — which insertion-order eviction would throw out first,
  // it being the oldest entry in the map.
  for (let i = 0; i <= ROUTING_CACHE_MAX; i++) await api.installationForRepo(`junk/r${i}`);
  await api.installationForRepo(REPO);
  expect(repoLookups()).toBe(1);
}, 30_000);

test("an anonymous refusal is remembered, and the retry does not spend the budget", async () => {
  const t = transport();
  t.installationFor = () => null;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });
  const reads = () => t.seen.filter((s) => s.url.includes("/pulls/")).length;

  await expect(client.getPull(REPO, 1723)).rejects.toThrow(GithubRoutingError);
  expect(reads()).toBe(1);
  // The refusal it replaced cost zero requests; without this memory a retry loop
  // naming one private repository drains the host's whole anonymous budget.
  await expect(client.getPull(REPO, 1723)).rejects.toThrow(GithubRoutingError);
  expect(reads()).toBe(1);
});

test("an exhausted anonymous budget is a rate limit, not a verdict on the repository", async () => {
  const t = transport();
  t.installationFor = () => null;
  const inner = t.fetchImpl;
  let limited = 0;
  t.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/pulls/") && !new Headers(init?.headers).has("Authorization")) {
      limited++;
      return new Response("API rate limit exceeded for 203.0.113.9", { status: 403 });
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
  const { client } = clientFor(t, "ws_a", { ws_a: [INSTALLATION] });

  await expect(client.getPull(REPO, 1723)).rejects.toThrow(GithubRateLimitError);
  // Not remembered as unreachable: the limit says nothing about the repository, and an
  // hour later the same read may work. A second attempt is allowed to try.
  await expect(client.getPull(REPO, 1723)).rejects.toThrow(GithubRateLimitError);
  expect(limited).toBe(2);
});

test("a token minted by repository id is not served to the repository named that number", async () => {
  const t = transport();
  const api = createAppApi({ credentials: CREDENTIALS, apiBase: API, fetchImpl: t.fetchImpl });

  const byId = await api.installationToken(INSTALLATION, { repositoryIds: [42] });
  const byName = await api.installationToken(INSTALLATION, { repositories: ["42"] });
  expect(byName).not.toBe(byId);
  expect(t.minted).toHaveLength(2);
});

// ---- the test seam successor ----

// Four seams now. The PAT identifier joined them last: it is a bare function rather than
// a client, it fell through to a real fetch, and the request it would have made carries
// the fine-grained token someone pasted into the form. The user OAuth transport arrived without an offline default,
// so githubUserOAuth() fell through to a real fetch client — and nothing noticed, because
// no test in the suite touches the callback route yet. The leak was latent rather than
// live, which is the worst kind to rely on noticing: the first test to exercise that route
// would have opened a socket to github.com with the configured client secret, silently.
// The count in this test's name has been wrong once already, so it is spelled out.
test("the suite cannot reach the network through any of the four seams", async () => {
  expect(() => githubClientFor("ws_a").getPull(REPO, 1723)).toThrow(/GitHub is offline/);
  expect(() => githubOAuth().exchangeCode("code")).toThrow(/GitHub is offline/);
  expect(() => githubOAuth().listUserInstallations("tok")).toThrow(/GitHub is offline/);
  expect(() => githubUserOAuth().exchangeAndIdentify("code")).toThrow(/GitHub is offline/);
  await expect(identify("github_pat_whatever")).rejects.toThrow(/GitHub is offline/);
});

test("with no factory installed, no client is built without a holdings source", () => {
  setGithubClientFactory(null);
  // startServer() installs the database-backed holdings, and other files in this suite
  // start a server, so the "no source at all" state has to be asked for explicitly
  // rather than assumed to be the default.
  setWorkspaceHoldings(null);
  try {
    expect(() => githubClientFor("ws_a")).toThrow(/holdings source/);
  } finally {
    setGithubClientFactory(offlineGithubClientFactory());
    setWorkspaceHoldings(dbWorkspaceHoldings());
  }
});
