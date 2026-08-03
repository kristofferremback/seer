import { test, expect, describe, afterEach } from "bun:test";
import {
  createFetchGithubClient,
  githubClient,
  setGithubClient,
  nextLink,
  GithubError,
} from "../../src/overseer/github";
import { fakeGithubClient, loadPull, loadFiles, loadCommits, loadComments } from "./github-fixtures";
import { offlineGithubClient } from "../offline-github";

// Every request in this file goes through a stub fetch. No socket is opened, and the
// grep the acceptance criteria asks for finds api.github.com only in the assertions
// about URL construction below.
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers });

// Back to the suite-wide offline default, not to the fetch-backed one: this file
// shares a process with every other test file.
afterEach(() => setGithubClient(offlineGithubClient()));

describe("the fetch client", () => {
  test("a request that stalls is abandoned rather than waited on forever", async () => {
    // The signal the client passes is what ends this: nothing else would.
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError")),
        );
      })) as unknown as typeof fetch;
    const client = createFetchGithubClient({ fetchImpl: impl, timeoutMs: 20 });
    await expect(client.getPull("a/b", 1)).rejects.toThrow(/did not answer .* within 20ms/);
  });

  test("getPull hits the pull endpoint and returns the payload", async () => {
    const { impl, calls } = stubFetch(() => ok(loadPull(2)));
    const client = createFetchGithubClient({ token: "t", fetchImpl: impl });
    const pull = await client.getPull("kristofferremback/seer", 2);
    expect(pull.number).toBe(2);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/kristofferremback/seer/pulls/2");
    expect(calls[0]!.headers.Authorization).toBe("Bearer t");
    expect(calls[0]!.headers.Accept).toBe("application/vnd.github+json");
  });

  test("no token means no Authorization header", async () => {
    const { impl, calls } = stubFetch(() => ok(loadPull(2)));
    await createFetchGithubClient({ fetchImpl: impl }).getPull("a/b", 1);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  test("list endpoints follow the Link header until it stops", async () => {
    const pages = [loadCommits(2).slice(0, 2), loadCommits(2).slice(2)];
    let n = 0;
    const { impl, calls } = stubFetch(() => {
      const page = pages[n++]!;
      const link: Record<string, string> =
        n < pages.length ? { Link: '<https://api.github.com/next-page>; rel="next", <x>; rel="last"' } : {};
      return ok(page, link);
    });
    const client = createFetchGithubClient({ fetchImpl: impl });
    const commits = await client.listCommits("kristofferremback/seer", 2);
    expect(commits.map((c) => c.sha)).toEqual(loadCommits(2).map((c) => c.sha));
    expect(commits.length).toBeGreaterThan(2);
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toContain("per_page=100");
    expect(calls[1]!.url).toBe("https://api.github.com/next-page");
  });

  test("listFiles returns the recorded file entries", async () => {
    const { impl } = stubFetch(() => ok(loadFiles(3)));
    const files = await createFetchGithubClient({ fetchImpl: impl }).listFiles("a/b", 3);
    expect(files.map((f) => f.filename)).toContain("src/images.ts");
  });

  test("getPullDiff asks for the diff media type and returns text", async () => {
    const { impl, calls } = stubFetch(() => ok("diff --git a/x b/x\n"));
    const diff = await createFetchGithubClient({ fetchImpl: impl }).getPullDiff("a/b", 9);
    expect(diff).toBe("diff --git a/x b/x\n");
    expect(calls[0]!.headers.Accept).toBe("application/vnd.github.diff");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/a/b/pulls/9");
  });

  test("getFileAtSha pins the ref and asks for raw content", async () => {
    const { impl, calls } = stubFetch(() => ok("export const a = 1;\n"));
    const text = await createFetchGithubClient({ fetchImpl: impl }).getFileAtSha("a/b", "src/dir/x.ts", "abc123");
    expect(text).toBe("export const a = 1;\n");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/a/b/contents/src/dir/x.ts?ref=abc123");
    expect(calls[0]!.headers.Accept).toBe("application/vnd.github.raw");
  });

  test("a list that never stops paging fails instead of returning a partial answer", async () => {
    const { impl, calls } = stubFetch(() =>
      ok([], { Link: '<https://api.github.com/next-page>; rel="next"' }),
    );
    const client = createFetchGithubClient({ fetchImpl: impl });
    let error: unknown;
    await client.listFiles("a/b", 1).catch((e) => {
      error = e;
    });
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).message).toContain("/repos/a/b/pulls/1/files");
    expect(calls.length).toBe(20);
  });

  test("a paging link on another host is refused before the token travels", async () => {
    const { impl, calls } = stubFetch(() => ok([], { Link: '<https://evil.example/steal>; rel="next"' }));
    const client = createFetchGithubClient({ token: "t", fetchImpl: impl });
    await expect(client.listCommits("a/b", 1)).rejects.toThrow(/evil\.example/);
    expect(calls.length).toBe(1);
  });

  test("a path that climbs out of the repository is refused before any request", async () => {
    const { impl, calls } = stubFetch(() => ok("secret"));
    const client = createFetchGithubClient({ token: "t", fetchImpl: impl });
    for (const path of ["../../../user/repos", "src/../../x", "/etc/passwd", "a//b", "."]) {
      await expect(client.getFileAtSha("a/b", path, "abc")).rejects.toThrow(GithubError);
    }
    expect(calls.length).toBe(0);
  });

  test("a non-2xx response is a GithubError naming the status and the url", async () => {
    const { impl } = stubFetch(() => new Response("Not Found", { status: 404 }));
    const client = createFetchGithubClient({ fetchImpl: impl });
    let error: unknown;
    await client.getPull("a/b", 1).catch((e) => {
      error = e;
    });
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).status).toBe(404);
    expect((error as GithubError).message).toContain("/repos/a/b/pulls/1");
  });

  test("a malformed repo fails before any request is made", async () => {
    const { impl, calls } = stubFetch(() => ok({}));
    const client = createFetchGithubClient({ fetchImpl: impl });
    await expect(client.getPull("not-a-repo", 1)).rejects.toThrow(GithubError);
    expect(calls.length).toBe(0);
  });

  test("a repo carrying url punctuation is refused before it can redirect the request", async () => {
    // "a/b#x" and "a/b?x=1" both resolve to /repos/a/b, which answers 200 with a
    // repository object that would then be read as a pull request.
    const { impl, calls } = stubFetch(() => ok(loadPull(2)));
    const client = createFetchGithubClient({ token: "t", fetchImpl: impl });
    for (const repo of ["a/b?x=1", "a/b#x", "a/b y", "a/b/c", "a/..", "../a", "a/b\\c", "a/b@c"]) {
      await expect(client.getPull(repo, 1)).rejects.toThrow(GithubError);
      await expect(client.listFiles(repo, 1)).rejects.toThrow(GithubError);
      await expect(client.getPullDiff(repo, 1)).rejects.toThrow(GithubError);
      await expect(client.getFileAtSha(repo, "src/x.ts", "abc")).rejects.toThrow(GithubError);
    }
    expect(calls.length).toBe(0);
  });

  test("a pull request number that is not a positive integer is refused too", async () => {
    const { impl, calls } = stubFetch(() => ok(loadPull(2)));
    const client = createFetchGithubClient({ fetchImpl: impl });
    for (const n of [0, -1, 1.5, Number.NaN]) {
      await expect(client.getPull("a/b", n)).rejects.toThrow(GithubError);
      await expect(client.listCommits("a/b", n)).rejects.toThrow(GithubError);
    }
    expect(calls.length).toBe(0);
  });

  test("listReviewComments hits the comments endpoint and returns the payload", async () => {
    const recorded = loadComments(2);
    const comments = [
      ...recorded,
      {
        id: 11,
        path: "src/server.ts",
        body: "This reads as dead code.",
        user: { login: "kristofferremback" },
        commit_id: "c1ac138",
        line: 12,
        start_line: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const { impl, calls } = stubFetch(() => ok(comments));
    const client = createFetchGithubClient({ token: "t", fetchImpl: impl });
    const got = await client.listReviewComments("kristofferremback/seer", 2);
    expect(got.map((c) => c.id)).toEqual(comments.map((c) => c.id));
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/kristofferremback/seer/pulls/2/comments?per_page=100",
    );
    expect(calls[0]!.headers.Accept).toBe("application/vnd.github+json");
  });

  test("apiBase is overridable, so nothing is hard-wired to github.com", async () => {
    const { impl, calls } = stubFetch(() => ok(loadPull(2)));
    const client = createFetchGithubClient({ fetchImpl: impl, apiBase: "https://ghe.example/api/v3/" });
    await client.getPull("a/b", 2);
    expect(calls[0]!.url).toBe("https://ghe.example/api/v3/repos/a/b/pulls/2");
  });
});

describe("Link parsing", () => {
  test("the next url is picked out of a multi-rel header", () => {
    expect(nextLink('<https://x/2>; rel="next", <https://x/9>; rel="last"')).toBe("https://x/2");
  });

  test("a header with no next ends the walk", () => {
    expect(nextLink('<https://x/1>; rel="prev", <https://x/1>; rel="first"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});

describe("the injection seam", () => {
  test("an injected client is what the rest of Overseer gets", async () => {
    const fake = fakeGithubClient({ pull: loadPull(3) });
    setGithubClient(fake);
    expect(githubClient()).toBe(fake);
    expect((await githubClient().getPull("a/b", 3)).number).toBe(3);
  });

  test("clearing the seam restores the default without a network call", () => {
    setGithubClient(fakeGithubClient());
    setGithubClient(null);
    const client = githubClient();
    expect(typeof client.getPull).toBe("function");
  });

  test("the fake refuses to invent what it was not given", async () => {
    const fake = fakeGithubClient({});
    await expect(fake.listFiles("a/b", 1)).rejects.toThrow(/no files/);
  });
});
