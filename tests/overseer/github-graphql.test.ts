import { describe, expect, test } from "bun:test";
import { createGithubGraphqlReader } from "../../src/overseer/github-graphql";
import { GithubError } from "../../src/overseer/github";

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
