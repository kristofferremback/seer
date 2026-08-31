import { beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKey, setKeyring } from "../../src/envelope";
import { db } from "../../src/db";
import { migrate } from "../../src/migrate";
import { createUserGithubClient, exactUserGithubClient, resetUserRouting } from "../../src/overseer/github-user";
import {
  createGithubUserCredential,
  getGithubUserCredential,
} from "../../src/overseer/user-credentials";
import {
  createWorkspaceGithubClient,
  GithubCredentialDeadError,
  GithubRoutingError,
} from "../../src/overseer/github-app";

beforeEach(() => {
  resetUserRouting();
});

beforeAll(() => {
  setKeyring({ activeId: "user-client", keys: new Map([["user-client", Buffer.from(generateKey(), "base64")]]) });
  migrate();
});

test("user B cannot fetch through user A's credential while A can", async () => {
  const token = "github_pat_user_a_only";
  createGithubUserCredential({
    userId: "usr_route_a",
    kind: "pat",
    label: "work",
    secret: token,
    accountLogin: "alice",
    accountId: 1,
    scopes: ["contents:read", "pull_requests:read"],
  });

  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    seen.push(`${authorization ?? "none"} ${url}`);
    if (url.endsWith("/repos/acme/private")) {
      return authorization === `Bearer ${token}` ? Response.json({ id: 7 }) : new Response("not found", { status: 404 });
    }
    if (url.endsWith("/repos/acme/private/pulls/3")) {
      return Response.json({
        number: 3, title: "private", body: null, state: "open", user: { login: "alice" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/private" } },
        updated_at: "2025-01-01T00:00:00Z",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const a = createUserGithubClient("usr_route_a", { apiBase: "https://github.test", fetchImpl });
  const b = createUserGithubClient("usr_route_b", { apiBase: "https://github.test", fetchImpl });

  expect((await a.getPull("acme/private", 3)).number).toBe(3);
  const before = seen.length;
  await expect(b.getPull("acme/private", 3)).rejects.toBeInstanceOf(GithubRoutingError);
  expect(seen.length).toBe(before); // B had no credential, so A's token never reached transport.
  expect(seen.filter((entry) => entry.includes(`Bearer ${token}`))).toHaveLength(2);
});

test("the exact personal REST transport never probes or falls through to another credential", async () => {
  const userId = "usr_exact_rest";
  const first = credentialFor(userId, "github_pat_exact_first");
  const second = credentialFor(userId, "github_pat_exact_second");
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    seen.push(`${auth} ${url}`);
    if (auth === "Bearer github_pat_exact_first") return new Response("Bad credentials", { status: 401 });
    return Response.json({
      number: 3, title: "exact", body: null, state: "open", user: { login: "octocat" },
      head: { sha: "a".repeat(40), ref: "topic" },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/private" } },
      updated_at: "2025-01-01T00:00:00Z",
    });
  }) as typeof fetch;
  const client = exactUserGithubClient(userId, first, { apiBase: "https://github.test", fetchImpl });
  await expect(client.getPull("acme/private", 3)).rejects.toBeInstanceOf(GithubCredentialDeadError);
  expect(seen).toEqual(["Bearer github_pat_exact_first https://github.test/repos/acme/private/pulls/3"]);
  expect(getGithubUserCredential(first, userId)?.dead_at).toBeNumber();
  expect(getGithubUserCredential(second, userId)?.dead_at).toBeNull();
});

// ---- the tests above prove less than they look like they prove ----
//
// "B cannot fetch through A's credential" passed while B held NO credential at all, so B
// was refused by having nothing to try rather than by the authorization check. Three
// mutations confirmed the blindness: making the probe treat 404 as "yes", giving the
// negative cache the positive TTL, and letting getFileAtSha skip authorization entirely
// all left it green. The same shape as an earlier test on this branch that gated on
// workspace membership and called it ownership.
//
// The fix in every case is to make the subject reach the gate under test.

/** A transport where each repo is readable by exactly one named token. */
function repoFixture(readable: Record<string, string>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    seen.push(`${auth} ${url}`);
    const probe = url.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (probe) {
      const owner = readable[probe[1]!];
      return owner && auth === `Bearer ${owner}`
        ? Response.json({ id: 7 })
        : new Response("not found", { status: 404 });
    }
    const pull = url.match(/\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (pull) {
      return Response.json({
        number: Number(pull[2]), title: "t", body: null, state: "open", user: { login: "x" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: pull[1] } },
        updated_at: "2025-01-01T00:00:00Z",
      });
    }
    if (url.includes("/contents/")) return new Response("file bytes");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function credentialFor(userId: string, token: string): string {
  return createGithubUserCredential({
    userId, kind: "pat", label: "t", secret: token,
    accountLogin: "x", accountId: 1, scopes: ["contents:read"],
  });
}

test("a personal credential routes every stage method and a later 401 marks it dead", async () => {
  const token = "github_pat_stage_private";
  const user = "usr_stage_private";
  const credentialId = credentialFor(user, token);
  const sha = "a".repeat(40);
  let failBlob = false;
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/repos/acme/private")) return auth === `Bearer ${token}`
      ? Response.json({ id: 7, full_name: "acme/private", default_branch: "main" })
      : new Response("no", { status: 404 });
    if (failBlob && url.includes("/git/blobs/")) return new Response("dead", { status: 401 });
    if (url.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/main", object: { sha, type: "commit" } });
    if (url.includes("/git/trees/")) return Response.json({ sha, truncated: false, tree: [] });
    if (url.includes("/git/blobs/")) return Response.json({ sha, size: 2, encoding: "base64", content: "aGk=" });
    if (url.includes("/compare/") && new Headers(init?.headers).get("accept") === "application/vnd.github.diff") return new Response("");
    if (url.includes("/compare/")) return Response.json({ merge_base_commit: { sha }, files: [] });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const client = createUserGithubClient(user, { apiBase: "https://github.test", fetchImpl });
  expect((await client.getRepository!("acme/private")).id).toBe(7);
  expect((await client.getRef!("acme/private", "main")).sha).toBe(sha);
  expect((await client.getTree!("acme/private", sha)).tree).toEqual([]);
  expect(await client.getBlobBytes!("acme/private", sha)).toEqual(new TextEncoder().encode("hi"));
  expect((await client.compare!("acme/private", sha, sha)).files).toEqual([]);
  expect(await client.compareDiff!("acme/private", sha, sha)).toBe("");
  expect(urls.every((url) => url.includes("github.test"))).toBe(true);

  failBlob = true;
  await expect(client.getBlobBytes!("acme/private", sha)).rejects.toBeInstanceOf(GithubCredentialDeadError);
  expect(getGithubUserCredential(credentialId, user)?.dead_at).toBeTypeOf("number");
});

test("a user with their OWN credential still cannot reach a repository it cannot read", async () => {
  // This is the case the first test skipped. B is not credential-less: B has a working
  // credential that simply does not open A's repository, so B travels the whole
  // authorization path and is refused by the probe rather than by having nothing to try.
  credentialFor("usr_own_a", "github_pat_a");
  credentialFor("usr_own_b", "github_pat_b");
  const { seen, fetchImpl } = repoFixture({
    "acme/a-only": "github_pat_a",
    "acme/b-only": "github_pat_b",
  });
  const opts = { apiBase: "https://github.test", fetchImpl };

  const a = createUserGithubClient("usr_own_a", opts);
  const b = createUserGithubClient("usr_own_b", opts);

  // Each reads their own.
  expect((await a.getPull("acme/a-only", 3)).number).toBe(3);
  expect((await b.getPull("acme/b-only", 4)).number).toBe(4);

  // Neither reads the other's, and B's refusal is the probe's, not an absence of
  // credentials: B did reach GitHub with B's own token and was told 404.
  await expect(b.getPull("acme/a-only", 3)).rejects.toBeInstanceOf(GithubRoutingError);
  expect(seen.some((e) => e === `Bearer github_pat_b https://github.test/repos/acme/a-only`)).toBe(true);

  // And A's token was never sent anywhere on B's behalf.
  expect(seen.filter((e) => e.startsWith("Bearer github_pat_a") && e.includes("b-only"))).toHaveLength(0);
});

test("every method authorizes, not just the one with a test", async () => {
  // getFileAtSha is the one that matters most -- it is what fills the shared ref_snippets
  // cache -- and it had no coverage at all, so a version of it that skipped authorization
  // passed the suite. Asserting the whole surface rather than a sample, because the next
  // method added is the one nobody thinks about.
  credentialFor("usr_all_a", "github_pat_all");
  const { fetchImpl } = repoFixture({ "acme/mine": "github_pat_all" });
  const client = createUserGithubClient("usr_all_a", { apiBase: "https://github.test", fetchImpl });

  const forbidden = "acme/not-mine";
  const calls: [string, () => Promise<unknown>][] = [
    ["getPull", () => client.getPull(forbidden, 1)],
    ["listCommits", () => client.listCommits(forbidden, 1)],
    ["listFiles", () => client.listFiles(forbidden, 1)],
    ["listReviewComments", () => client.listReviewComments(forbidden, 1)],
    ["getFileAtSha", () => client.getFileAtSha(forbidden, "src/x.ts", "c".repeat(40))],
    ["getPullDiff", () => client.getPullDiff(forbidden, 1)],
  ];
  for (const [name, call] of calls) {
    await expect(call(), `${name} must authorize`).rejects.toBeInstanceOf(GithubRoutingError);
  }

  // The success beside the refusals: the same client reads the repository it may.
  expect((await client.getPull("acme/mine", 9)).number).toBe(9);
});

test("a refusal is cached briefly and a grant is cached long", async () => {
  // The split exists because a negative that outlives the person fixing it is how the App
  // work produced a six-hour dead end after somebody did exactly what the error told them.
  // Equal TTLs would rebuild that, and nothing noticed.
  credentialFor("usr_ttl", "github_pat_ttl");
  let readable: Record<string, string> = {};
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const probe = url.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (probe) {
      return readable[probe[1]!] ? Response.json({ id: 7 }) : new Response("nf", { status: 404 });
    }
    return Response.json({
      number: 1, title: "t", body: null, state: "open", user: { login: "x" },
      head: { sha: "a".repeat(40), ref: "topic" },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/later" } },
      updated_at: "2025-01-01T00:00:00Z",
    });
  }) as typeof fetch;

  let clock = 1_000_000;
  const client = createUserGithubClient("usr_ttl", {
    apiBase: "https://github.test", fetchImpl, now: () => clock,
  });

  // Refused, and the refusal is remembered.
  await expect(client.getPull("acme/later", 1)).rejects.toBeInstanceOf(GithubRoutingError);
  const afterFirst = seen.length;
  await expect(client.getPull("acme/later", 1)).rejects.toBeInstanceOf(GithubRoutingError);
  expect(seen.length).toBe(afterFirst); // cached, not re-probed

  // The person then grants access. Within a minute the negative expires and the next
  // attempt asks again rather than repeating a stale no.
  readable = { "acme/later": "github_pat_ttl" };
  clock += 61_000;
  expect((await client.getPull("acme/later", 1)).number).toBe(1);
  const afterGrant = seen.length;

  // And the grant is NOT re-probed a minute later, which is the other half of the split.
  clock += 61_000;
  expect((await client.getPull("acme/later", 1)).number).toBe(1);
  expect(seen.filter((u) => u.endsWith("/repos/acme/later")).length).toBe(
    seen.slice(0, afterGrant).filter((u) => u.endsWith("/repos/acme/later")).length,
  );
});

// ---- a credential GitHub has stopped accepting ----
//
// The generic version of this said "GitHub 401 while checking credential guc_…" and left
// the row untouched, so the same dead credential was probed again on every request and
// nothing on the page ever said which one had died.

function deadFixture(token: string) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "none";
    seen.push(`${auth} ${url}`);
    if (auth === `Bearer ${token}`) return new Response("Bad credentials", { status: 401 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test("a 401 on the probe kills the credential, names it, and is not tried again", async () => {
  const token = "github_pat_dead";
  const id = createGithubUserCredential({
    userId: "usr_dead", kind: "pat", label: "old laptop", secret: token,
    accountLogin: "alice", accountId: 1, scopes: ["contents:read"],
  });
  const { seen, fetchImpl } = deadFixture(token);
  const client = createUserGithubClient("usr_dead", { apiBase: "https://github.test", fetchImpl });

  const err = await client.getPull("acme/private", 1).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GithubCredentialDeadError);
  expect((err as Error).message).toContain("alice");
  expect(getGithubUserCredential(id, "usr_dead")!.dead_at).not.toBeNull();

  // The second attempt does not reach GitHub with the dead token: the row is out of the
  // live listing and the routing entry that pointed at it is gone.
  const after = seen.length;
  await expect(client.getPull("acme/private", 1)).rejects.toBeInstanceOf(GithubRoutingError);
  expect(seen.slice(after).filter((e) => e.startsWith(`Bearer ${token}`))).toHaveLength(0);
});

test("expiry and revocation are told apart, because the fix differs", async () => {
  const expiredToken = "github_pat_expired";
  createGithubUserCredential({
    userId: "usr_expired", kind: "pat", label: "temporary", secret: expiredToken,
    accountLogin: "bob", accountId: 2, scopes: ["contents:read"],
    expiresAt: Date.now() - 60_000,
  });
  const expired = createUserGithubClient("usr_expired", {
    apiBase: "https://github.test", ...deadFixture(expiredToken),
  });
  await expect(expired.getPull("acme/private", 1)).rejects.toThrow(/expired/i);

  const revokedToken = "github_pat_revoked";
  createGithubUserCredential({
    userId: "usr_revoked", kind: "pat", label: "work", secret: revokedToken,
    accountLogin: "carol", accountId: 3, scopes: ["contents:read"],
  });
  const revoked = createUserGithubClient("usr_revoked", {
    apiBase: "https://github.test", ...deadFixture(revokedToken),
  });
  await expect(revoked.getPull("acme/private", 1)).rejects.toThrow(/revoked at GitHub/i);
});

test("a dead credential is not papered over by the anonymous reader", async () => {
  // The workspace client falls through to anonymity on a routing error, and a public
  // repository would then answer -- quietly, with the broken credential still broken and
  // nobody told. That is the whole reason the dead error is not a routing error.
  const token = "github_pat_fallthrough";
  createGithubUserCredential({
    userId: "usr_fall", kind: "pat", label: "work", secret: token,
    accountLogin: "dave", accountId: 4, scopes: ["contents:read"],
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === `Bearer ${token}`) return new Response("Bad credentials", { status: 401 });
    if (/\/installation$/.test(url)) return new Response("{}", { status: 404 });
    if (/\/pulls\/\d+$/.test(url)) {
      return Response.json({
        number: 1, title: "t", body: null, state: "open", user: { login: "x" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/public" } },
        updated_at: "2025-01-01T00:00:00Z",
      });
    }
    return Response.json({ id: 7 });
  }) as typeof fetch;

  const client = createWorkspaceGithubClient({
    workspaceId: "ws_fall",
    holdings: { installationIds: () => [] },
    app: {
      installationForRepo: async () => null,
      installationToken: async () => { throw new Error("must not mint"); },
      noteRepositoryId: () => {},
      repositoryId: () => undefined,
      invalidateRouting: () => {},
    },
    askingUserId: "usr_fall",
    apiBase: "https://github.test",
    fetchImpl,
  });

  await expect(client.getPull("acme/public", 1)).rejects.toBeInstanceOf(GithubCredentialDeadError);
});

// ---- the walk past a casualty ----
//
// A person's credentials are listed most-recent first, and the loop threw on the first
// 401. Somebody who reconnected an account and left the old token in place was refused
// for a credential they were not using, while the one that reads the repository sat
// untried in the same list.

test("a dead credential does not end the walk, and the next one answers", async () => {
  const deadToken = "github_pat_walk_dead";
  const liveToken = "github_pat_walk_live";
  createGithubUserCredential({
    userId: "usr_walk", kind: "pat", label: "work", secret: liveToken,
    accountLogin: "alice", accountId: 1, scopes: ["contents:read"],
  });
  const deadId = createGithubUserCredential({
    userId: "usr_walk", kind: "pat", label: "old laptop", secret: deadToken,
    accountLogin: "alice", accountId: 1, scopes: ["contents:read"],
  });
  // The list is most-recent first, and both rows were written in the same millisecond.
  // The dead one has to be in front or the walk never reaches the casualty under test.
  db.run("UPDATE github_user_credentials SET created_at = ? WHERE id = ?", [Date.now() + 1000, deadId]);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === `Bearer ${deadToken}`) return new Response("Bad credentials", { status: 401 });
    if (auth !== `Bearer ${liveToken}`) return new Response("not found", { status: 404 });
    if (/\/pulls\/\d+$/.test(url)) {
      return Response.json({
        number: 4, title: "t", body: null, state: "open", user: { login: "x" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/walk" } },
        updated_at: "2025-01-01T00:00:00Z",
      });
    }
    return Response.json({ id: 7 });
  }) as typeof fetch;

  const client = createUserGithubClient("usr_walk", { apiBase: "https://github.test", fetchImpl });
  expect((await client.getPull("acme/walk", 4)).number).toBe(4);
  // The death still happened and is still recorded; it simply did not take the read down.
  expect(getGithubUserCredential(deadId, "usr_walk")!.dead_at).not.toBeNull();
});

test("when nothing else answers, the death is what is thrown", async () => {
  // Not the routing refusal: that sentence talks about installations and connected
  // accounts and would never mention the credential the person has to reconnect.
  const deadToken = "github_pat_walk_all_dead";
  createGithubUserCredential({
    userId: "usr_walk_dead", kind: "pat", label: "old", secret: deadToken,
    accountLogin: "erin", accountId: 5, scopes: ["contents:read"],
  });
  createGithubUserCredential({
    userId: "usr_walk_dead", kind: "pat", label: "other", secret: "github_pat_walk_useless",
    accountLogin: "erin", accountId: 5, scopes: ["contents:read"],
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === `Bearer ${deadToken}`) return new Response("Bad credentials", { status: 401 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = createUserGithubClient("usr_walk_dead", { apiBase: "https://github.test", fetchImpl });
  await expect(client.getPull("acme/nope", 1)).rejects.toBeInstanceOf(GithubCredentialDeadError);
});

test("a probe refused for a third reason leaves the anonymous fallback reachable", async () => {
  // 403 is a personal rate limit or an organisation's SAML page: it says nothing about
  // the credential and nothing about the repository. Throwing it here made a PUBLIC
  // repository unreadable for that person, because only a routing error falls through.
  createGithubUserCredential({
    userId: "usr_403", kind: "pat", label: "work", secret: "github_pat_403",
    accountLogin: "frank", accountId: 6, scopes: ["contents:read"],
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === "Bearer github_pat_403") {
      return new Response("API rate limit exceeded for user", { status: 403 });
    }
    if (/\/installation$/.test(url)) return new Response("{}", { status: 404 });
    if (/\/pulls\/\d+$/.test(url)) {
      return Response.json({
        number: 2, title: "t", body: null, state: "open", user: { login: "x" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "b".repeat(40), ref: "main", repo: { id: 7, full_name: "acme/public" } },
        updated_at: "2025-01-01T00:00:00Z",
      });
    }
    return Response.json({ id: 7 });
  }) as typeof fetch;

  const client = createWorkspaceGithubClient({
    workspaceId: "ws_403",
    holdings: { installationIds: () => [] },
    app: {
      installationForRepo: async () => null,
      installationToken: async () => { throw new Error("must not mint"); },
      noteRepositoryId: () => {},
      repositoryId: () => undefined,
      invalidateRouting: () => {},
    },
    askingUserId: "usr_403",
    apiBase: "https://github.test",
    fetchImpl,
  });

  expect((await client.getPull("acme/public", 2)).number).toBe(2);
});

test("the routing a request learns is still there for the next one", async () => {
  // The cache used to live on the client, and the client is built per request, so the
  // six-hour positive meant "until this response is written" and every request re-probed
  // every credential.
  credentialFor("usr_cache", "github_pat_cache");
  const { seen, fetchImpl } = repoFixture({ "acme/cached": "github_pat_cache" });
  const opts = { apiBase: "https://github.test", fetchImpl };
  const probes = () => seen.filter((e) => e.endsWith("/repos/acme/cached")).length;

  expect((await createUserGithubClient("usr_cache", opts).getPull("acme/cached", 1)).number).toBe(1);
  expect(probes()).toBe(1);

  expect((await createUserGithubClient("usr_cache", opts).getPull("acme/cached", 2)).number).toBe(2);
  expect(probes()).toBe(1);
});
