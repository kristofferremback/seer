import { beforeAll, expect, test } from "bun:test";
import { generateKey, setKeyring } from "../../src/envelope";
import { migrate } from "../../src/migrate";
import { createUserGithubClient } from "../../src/overseer/github-user";
import {
  createGithubUserCredential,
  getGithubUserCredential,
} from "../../src/overseer/user-credentials";
import {
  createWorkspaceGithubClient,
  GithubCredentialDeadError,
  GithubRoutingError,
} from "../../src/overseer/github-app";

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

function credentialFor(userId: string, token: string): void {
  createGithubUserCredential({
    userId, kind: "pat", label: "t", secret: token,
    accountLogin: "x", accountId: 1, scopes: ["contents:read"],
  });
}

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
