import { beforeAll, describe, expect, test } from "bun:test";
import {
  createGithubGraphqlReader,
  personalGithubGraphqlClient,
  setPersonalGithubGraphqlClientFactory,
  GithubGraphqlPermissionError,
  GithubGraphqlTargetError,
  GithubGraphqlTransportError,
} from "../../src/overseer/github-graphql";
import { GithubError } from "../../src/overseer/github";
import { db } from "../../src/db";
import { generateKey, setKeyring } from "../../src/envelope";
import { migrate } from "../../src/migrate";
import { createGithubUserCredential } from "../../src/overseer/user-credentials";
import { projectionFailure } from "../../src/overseer/github-projection-errors";

beforeAll(() => {
  setKeyring({ activeId: "graphql", keys: new Map([["graphql", Buffer.from(generateKey(), "base64")]]) });
  migrate();
  setPersonalGithubGraphqlClientFactory(null);
});

const comment = (id: string, body = "body") => ({ fullDatabaseId: id, id: `NODE_${id}`, author: { login: "octocat" }, body, url: `https://github.test/comment/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", commit: { oid: "a".repeat(40) }, originalCommit: { oid: "b".repeat(40) } });
const thread = (id: string) => ({ id: `THREAD_${id}`, isResolved: false, isOutdated: false, path: "src/a.ts", diffSide: "RIGHT", line: 2, startLine: 2, originalLine: 2, originalStartLine: 2, comments: { nodes: [comment(id)], pageInfo: { hasNextPage: false } } });

describe("read-only GitHub GraphQL", () => {
  test("should page threads and reviews while preserving decimal ids as text", async () => {
    const queries: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); queries.push(request.query);
      if (request.query.includes("ReviewThreads")) {
        const first = request.variables.after === null;
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread(first ? "9007199254740993123" : "2")], pageInfo: { hasNextPage: first, endCursor: first ? "next" : null } } } } } });
      }
      return Response.json({ data: { repository: { pullRequest: { reviews: { nodes: [{ fullDatabaseId: "9007199254740993999", id: "REVIEW_1", author: null, state: "APPROVED", body: "Looks good", url: "https://github.test/review/1", commit: { oid: "a".repeat(40) }, submittedAt: "2026-01-01T00:00:00Z", dismissedAt: null }], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }) as unknown as typeof fetch;
    const snapshot = await createGithubGraphqlReader({ token: "secret", apiBase: "https://github.test", fetchImpl }).listReviewThreads("Acme/Repo", 7);
    expect(snapshot.threads.map((item) => item.comments[0]!.databaseId)).toEqual(["9007199254740993123", "2"]);
    expect(snapshot.reviews[0]!.databaseId).toBe("9007199254740993999");
    expect(snapshot.complete).toBe(true);
    expect(queries.every((query) => !/\bmutation\b/i.test(query))).toBe(true);
  });

  test("should mark nested comment pagination and body limits truncated", async () => {
    const huge = "x".repeat(1024 * 1024);
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("ReviewThreads")) {
        const value = thread("1"); value.comments.nodes = [comment("1", huge), comment("2", "overflow")]; value.comments.pageInfo.hasNextPage = true;
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [value], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      }
      return Response.json({ data: { repository: { pullRequest: { reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }) as unknown as typeof fetch;
    const snapshot = await createGithubGraphqlReader({ fetchImpl }).listReviewThreads("Acme/Repo", 1);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.complete).toBe(false);
  });

  test("should retain a partial snapshot when one total deadline expires", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const query = JSON.parse(String(init?.body)).query as string;
      if (calls === 1 && query.includes("ReviewThreads")) {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread("99")], pageInfo: { hasNextPage: true, endCursor: "next" } } } } } });
      }
      await new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const started = Date.now();
    const snapshot = await createGithubGraphqlReader({ fetchImpl, timeoutMs: 1_000, totalTimeoutMs: 25 }).listReviewThreads("Acme/Repo", 1);
    expect(snapshot).toMatchObject({ complete: false, truncated: true });
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.reviews).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("should preserve the per-call timeout below the total deadline", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    await expect(createGithubGraphqlReader({ fetchImpl, timeoutMs: 10, totalTimeoutMs: 1_000 }).listReviewThreads("Acme/Repo", 1)).rejects.toBeInstanceOf(GithubError);
  });

  test("should return transport, GraphQL and malformed data as typed errors", async () => {
    for (const fetchImpl of [
      (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch,
      (async () => Response.json({ errors: [{ message: "rate limit exceeded" }] })) as unknown as typeof fetch,
      (async () => Response.json({ data: { repository: null } })) as unknown as typeof fetch,
    ]) {
      try {
        await createGithubGraphqlReader({ fetchImpl }).listReviewThreads("Acme/Repo", 1);
        throw new Error("expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(GithubError);
      }
    }
  });
});

describe("personal GitHub GraphQL", () => {
  test("should send the live mutation input names without asking the mutation root for rateLimit", async () => {
    const userId = "usr_graphql_personal";
    const credentialId = createGithubUserCredential({
      userId,
      kind: "pat",
      label: "work",
      secret: "personal-secret",
      accountLogin: "octocat",
      accountId: 23,
      scopes: [],
      expiresAt: Date.now() + 60_000,
    });
    const requests: { query: string; variables: Record<string, any>; authorization: string | null }[] = [];
    const rate = { limit: 5000, cost: 1, remaining: 4999, resetAt: "2026-01-01T01:00:00Z", used: 1 };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push({ query: request.query, variables: request.variables, authorization: new Headers(init?.headers).get("authorization") });
      const headers = { "x-ratelimit-limit": "5000", "x-ratelimit-used": "2", "x-ratelimit-remaining": "4998", "x-ratelimit-reset": "1767229200" };
      if (request.query.includes("PersonalPullRequest")) return Response.json({ data: { repository: { pullRequest: { id: "PR_23", headRefOid: "a".repeat(40), files: { nodes: [{ path: "src/a.ts", viewerViewedState: "UNVIEWED" }], pageInfo: { hasNextPage: false, endCursor: null } } } }, rateLimit: rate } });
      if (request.query.includes("MarkFileAsViewed")) return Response.json({ data: { markFileAsViewed: { clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      if (request.query.includes("UnmarkFileAsViewed")) return Response.json({ data: { unmarkFileAsViewed: { clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      if (request.query.includes("AddPullRequestReviewThreadReply")) return Response.json({ data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_REPLY", fullDatabaseId: "9007199254740999" }, clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      if (request.query.includes("AddPullRequestReview")) return Response.json({ data: { addPullRequestReview: { pullRequestReview: { id: "PRR_23", comments: { nodes: [{ id: "PRRC_23" }] } }, clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      if (request.query.includes("ResolveReviewThread")) return Response.json({ data: { resolveReviewThread: { clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      if (request.query.includes("UnresolveReviewThread")) return Response.json({ data: { unresolveReviewThread: { clientMutationId: request.variables.input.clientMutationId } } }, { headers });
      throw new Error(`unexpected query ${request.query}`);
    }) as unknown as typeof fetch;
    const client = personalGithubGraphqlClient(userId, credentialId, { apiBase: "https://github.test", fetchImpl });
    await client.pullRequest("Acme/Repo", 23);
    await client.markFileAsViewed("PR_23", "src/a.ts", "mark-23");
    await client.unmarkFileAsViewed("PR_23", "src/a.ts", "unmark-23");
    await client.addReview({ pullRequestId: "PR_23", commitOID: "a".repeat(40), event: "COMMENT", body: "", threads: [{ path: "src/a.ts", line: 2, side: "RIGHT", startLine: 1, startSide: "RIGHT", body: "Look here" }], clientMutationId: "review-23" });
    await client.addThreadReply("PRRT_23", "Reply", "reply-23");
    await client.resolveThread("PRRT_23", "resolve-23");
    await client.unresolveThread("PRRT_23", "unresolve-23");

    expect(requests.every((request) => request.authorization === "Bearer personal-secret")).toBe(true);
    const mutations = requests.filter((request) => /^mutation\b/.test(request.query));
    expect(mutations.every((request) => !/\brateLimit\b/.test(request.query))).toBe(true);
    expect(mutations.map((request) => request.variables.input)).toEqual([
      { pullRequestId: "PR_23", path: "src/a.ts", clientMutationId: "mark-23" },
      { pullRequestId: "PR_23", path: "src/a.ts", clientMutationId: "unmark-23" },
      { pullRequestId: "PR_23", commitOID: "a".repeat(40), event: "COMMENT", body: "", threads: [{ path: "src/a.ts", line: 2, side: "RIGHT", startLine: 1, startSide: "RIGHT", body: "Look here" }], clientMutationId: "review-23" },
      { pullRequestReviewThreadId: "PRRT_23", body: "Reply", clientMutationId: "reply-23" },
      { threadId: "PRRT_23", clientMutationId: "resolve-23" },
      { threadId: "PRRT_23", clientMutationId: "unresolve-23" },
    ]);
    expect(db.query<{ credential_id: string; remaining_value: number }, [string]>("SELECT credential_id,remaining_value FROM github_graphql_rate_limits WHERE credential_id=?").get(credentialId)).toEqual({ credential_id: credentialId, remaining_value: 4998 });
  });

  test("should distinguish parsed mutation refusals from uncertain transport", async () => {
    const userId = "usr_graphql_outcomes";
    const credentialId = createGithubUserCredential({ userId, kind: "pat", label: "outcomes", secret: "outcome-secret", accountLogin: "outcomes", accountId: 27, scopes: [], expiresAt: null });

    const parsed = personalGithubGraphqlClient(userId, credentialId, {
      fetchImpl: (async () => Response.json({ errors: [{ message: "line is outside the diff", type: "UNPROCESSABLE" }] })) as unknown as typeof fetch,
    });
    const parsedError = await parsed.markFileAsViewed("PR_27", "src/a.ts", "parsed").then(() => null, (error) => error);
    expect(parsedError).toBeInstanceOf(GithubGraphqlTransportError);
    expect((parsedError as GithubGraphqlTransportError).mayHaveLeftProcess).toBe(false);
    expect(projectionFailure(parsedError, 1)).toMatchObject({ state: "failed", code: "transport_failed" });

    const refused = personalGithubGraphqlClient(userId, credentialId, {
      fetchImpl: (async () => Response.json({ errors: [{ message: "Resource not accessible by personal access token", type: "FORBIDDEN" }] })) as unknown as typeof fetch,
    });
    const refusedError = await refused.markFileAsViewed("PR_27", "src/a.ts", "refused").then(() => null, (error) => error);
    expect(refusedError).toBeInstanceOf(GithubGraphqlPermissionError);
    expect(projectionFailure(refusedError, 1)).toMatchObject({ state: "refused", code: "permission_refused" });

    for (const [name, fetchImpl] of [
      ["fetch", (async () => { throw new Error("socket closed"); }) as unknown as typeof fetch],
      ["status", (async () => new Response("gateway lost the response", { status: 502 })) as unknown as typeof fetch],
    ] as const) {
      const uncertain = personalGithubGraphqlClient(userId, credentialId, { fetchImpl });
      const error = await uncertain.markFileAsViewed("PR_27", "src/a.ts", name).then(() => null, (caught) => caught);
      expect(error).toBeInstanceOf(GithubGraphqlTransportError);
      expect((error as GithubGraphqlTransportError).mayHaveLeftProcess).toBe(true);
      expect(projectionFailure(error, 1).state).toBe("unknown");
    }
  });

  test("should type a deleted repository or pull request as a stale target", async () => {
    const userId = "usr_graphql_deleted";
    const credentialId = createGithubUserCredential({ userId, kind: "pat", label: "deleted", secret: "deleted-secret", accountLogin: "deleted", accountId: 26, scopes: [], expiresAt: null });
    const rate = { limit: 5000, cost: 1, remaining: 4999, resetAt: "2026-01-01T01:00:00Z", used: 1 };
    const fetchImpl = (async () => Response.json({ data: { repository: null, rateLimit: rate } })) as unknown as typeof fetch;
    await expect(personalGithubGraphqlClient(userId, credentialId, { fetchImpl }).pullRequest("Acme/Deleted", 1)).rejects.toBeInstanceOf(GithubGraphqlTargetError);
  });

  test("should refuse another owner, revoked, dead, and expired rows before transport", () => {
    const userId = "usr_graphql_owner";
    const credentialId = createGithubUserCredential({ userId, kind: "pat", label: "owner", secret: "owner-secret", accountLogin: "owner", accountId: 25, scopes: [], expiresAt: Date.now() + 60_000 });
    let calls = 0;
    const fetchImpl = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    expect(() => personalGithubGraphqlClient("usr_graphql_other", credentialId, { fetchImpl })).toThrow("owned by another member");
    db.run("UPDATE github_user_credentials SET revoked_at=? WHERE id=?", [Date.now(), credentialId]);
    expect(() => personalGithubGraphqlClient(userId, credentialId, { fetchImpl })).toThrow("revoked");
    db.run("UPDATE github_user_credentials SET revoked_at=NULL,dead_at=? WHERE id=?", [Date.now(), credentialId]);
    expect(() => personalGithubGraphqlClient(userId, credentialId, { fetchImpl })).toThrow("dead");
    db.run("UPDATE github_user_credentials SET dead_at=NULL,expires_at=? WHERE id=?", [Date.now() - 1, credentialId]);
    expect(() => personalGithubGraphqlClient(userId, credentialId, { fetchImpl })).toThrow("expired");
    expect(calls).toBe(0);
  });

  test("should persist Retry-After and expose the exact earliest retry time", async () => {
    const userId = "usr_graphql_rate";
    const credentialId = createGithubUserCredential({ userId, kind: "pat", label: "rate", secret: "rate-secret", accountLogin: "rate-user", accountId: 24, scopes: [], expiresAt: null });
    const now = 1_800_000_000_000;
    const fetchImpl = (async () => new Response("secondary rate limit", { status: 429, headers: { "retry-after": "120", "x-ratelimit-limit": "5000", "x-ratelimit-used": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor((now + 300_000) / 1_000)) } })) as unknown as typeof fetch;
    const client = personalGithubGraphqlClient(userId, credentialId, { fetchImpl, now: () => now });
    try {
      await client.markFileAsViewed("PR_24", "src/rate.ts", "rate-24");
      throw new Error("expected rate refusal");
    } catch (error) {
      expect((error as { name: string; retryAt: number }).name).toBe("GithubRateLimitError");
      expect((error as { retryAt: number }).retryAt).toBe(now + 120_000);
    }
    expect(db.query<{ retry_after: number }, [string]>("SELECT retry_after FROM github_graphql_rate_limits WHERE credential_id=?").get(credentialId)?.retry_after).toBe(now + 120_000);
  });
});
