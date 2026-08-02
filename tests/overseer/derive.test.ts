import { test, expect, describe, beforeAll } from "bun:test";
// Env is set by tests/setup.ts before these app modules import.
import { migrate } from "../../src/migrate";
import {
  coAuthorsOf,
  deriveOrigin,
  derivePrs,
  deriveReviewKind,
  hunksOf,
  kindsForPr,
  prKey,
  refResolver,
  RefResolveError,
  sweepSnippetCache,
  type PrPointer,
} from "../../src/overseer/derive";
import { getSnippet, putSnippet } from "../../src/overseer/db";
import { GithubError } from "../../src/overseer/github";
import type {
  GithubClient,
  GithubCommit,
  GithubFile,
  GithubPull,
  GithubReviewComment,
} from "../../src/overseer/github";

beforeAll(() => migrate());

// ---- a counting fake, so "no live network" is proven rather than asserted ----

interface FakePull {
  pull: GithubPull;
  commits: GithubCommit[];
  files: GithubFile[];
  comments: GithubReviewComment[];
}

interface CountingClient extends GithubClient {
  calls: Record<string, number>;
  total(): number;
}

function countingClient(
  pulls: Record<string, FakePull>,
  blobs: Record<string, string> = {},
): CountingClient {
  const calls: Record<string, number> = {
    getPull: 0,
    listCommits: 0,
    listFiles: 0,
    listReviewComments: 0,
    getFileAtSha: 0,
    getPullDiff: 0,
  };
  const need = (repo: string, number: number): FakePull => {
    const found = pulls[`${repo}#${number}`];
    if (!found) throw new Error(`counting fake has no ${repo}#${number}`);
    return found;
  };
  return {
    calls,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    async getPull(repo, number) {
      calls.getPull!++;
      return need(repo, number).pull;
    },
    async listCommits(repo, number) {
      calls.listCommits!++;
      return need(repo, number).commits;
    },
    async listFiles(repo, number) {
      calls.listFiles!++;
      return need(repo, number).files;
    },
    async listReviewComments(repo, number) {
      calls.listReviewComments!++;
      return need(repo, number).comments;
    },
    async getFileAtSha(_repo, path, sha) {
      calls.getFileAtSha!++;
      const found = blobs[`${sha}:${path}`];
      if (found === undefined) throw new Error(`counting fake has no blob ${sha}:${path}`);
      return found;
    },
    async getPullDiff() {
      calls.getPullDiff!++;
      throw new Error("the counting fake never falls back to a whole-pull-request diff");
    },
  };
}

const REPO = "acme/app";

/** A fixture sha shaped like a real one. The resolver refuses a ref whose sha is not 40
 *  hex characters, so a readable label is expanded into one rather than used raw. */
function sha(label: string): string {
  let hex = "";
  for (const ch of label) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return `${hex}${"f".repeat(40)}`.slice(0, 40);
}

function commit(sha: string, message: string): GithubCommit {
  return {
    sha,
    commit: { message, author: { name: "Ada", email: "ada@example.com" } },
    author: { login: "ada" },
  };
}

function file(path: string, patch: string, extra: Partial<GithubFile> = {}): GithubFile {
  return {
    filename: path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
    ...extra,
  };
}

const PATCH = "@@ -1,2 +1,3 @@\n one\n+two\n three\n";

function fakePull(
  number: number,
  headRef: string,
  baseRef: string,
  over: Partial<FakePull> = {},
): FakePull {
  return {
    pull: {
      number,
      title: `pull ${number}`,
      body: `body of ${number}`,
      state: "open",
      user: { login: "ada" },
      head: { sha: sha(`sha${number}`), ref: headRef },
      base: { sha: sha(`base${number}`), ref: baseRef },
    },
    commits: [commit(`c${number}`, `commit for ${number}`)],
    files: [file(`src/f${number}.ts`, PATCH)],
    comments: [],
    ...over,
  };
}

function chain(thirdBase = "feat/b"): Record<string, FakePull> {
  return {
    [`${REPO}#101`]: fakePull(101, "feat/a", "main"),
    [`${REPO}#102`]: fakePull(102, "feat/b", "feat/a"),
    [`${REPO}#103`]: fakePull(103, "feat/c", thirdBase),
  };
}

const POINTERS: PrPointer[] = [
  { repo: REPO, number: 101 },
  { repo: REPO, number: 102 },
  { repo: REPO, number: 103 },
];

describe("stack shape", () => {
  test("a three-pull-request chain derives kind stack with parents from base_ref", async () => {
    const client = countingClient(chain());
    const review = await derivePrs(client, POINTERS);
    expect(review.kind).toBe("stack");
    expect(review.prs.map((p) => p.parent)).toEqual([null, 101, 102]);
    expect(review.prs.map((p) => p.number)).toEqual([101, 102, 103]);
    expect(client.calls.getFileAtSha).toBe(0);
    expect(client.calls.getPullDiff).toBe(0);
  });

  test("the same pull requests with one rebased base derive kind set", async () => {
    const client = countingClient(chain("main"));
    const review = await derivePrs(client, POINTERS);
    expect(review.kind).toBe("set");
    expect(review.prs.map((p) => p.parent)).toEqual([null, 101, null]);
  });

  test("one pull request is single, whatever it is based on", async () => {
    const client = countingClient(chain());
    const review = await derivePrs(client, [{ repo: REPO, number: 101 }]);
    expect(review.kind).toBe("single");
    expect(review.prs[0]!.parent).toBe(null);
  });

  test("base_ref wins over an authored parent, and the authored one is the fallback", async () => {
    const client = countingClient(chain("main"));
    const review = await derivePrs(client, [
      { repo: REPO, number: 101 },
      { repo: REPO, number: 102, parent: 999 },
      { repo: REPO, number: 103, parent: 102 },
    ]);
    // 102 bases on feat/a, which is 101's head branch, so the authored 999 is ignored.
    expect(review.prs[1]!.parent).toBe(101);
    // 103 bases on main, which no pull request in the review heads, so 102 stands.
    expect(review.prs[2]!.parent).toBe(102);
    expect(review.kind).toBe("stack");
  });

  test("two pull requests on one parent is a fan, which is a set", () => {
    expect(
      deriveReviewKind([
        { repo: REPO, number: 1, parent: null },
        { repo: REPO, number: 2, parent: 1 },
        { repo: REPO, number: 3, parent: 1 },
      ]),
    ).toBe("set");
  });

  test("a review with no root is a set", () => {
    expect(
      deriveReviewKind([
        { repo: REPO, number: 1, parent: 2 },
        { repo: REPO, number: 2, parent: 1 },
      ]),
    ).toBe("set");
  });

  test("a parent outside the review does not root the chain twice", () => {
    expect(
      deriveReviewKind([
        { repo: REPO, number: 1, parent: 77 },
        { repo: REPO, number: 2, parent: 1 },
      ]),
    ).toBe("stack");
  });

  test("a branch name in another repository does not stack anything", async () => {
    const client = countingClient({
      [`${REPO}#101`]: fakePull(101, "feat/a", "main"),
      [`other/app#5`]: fakePull(5, "feat/x", "feat/a"),
    });
    const review = await derivePrs(client, [
      { repo: REPO, number: 101 },
      { repo: "other/app", number: 5 },
    ]);
    expect(review.prs[1]!.parent).toBe(null);
    expect(review.kind).toBe("set");
  });
});

describe("pull request facts", () => {
  test("title, shas, refs, author and body come off the pull request", async () => {
    const client = countingClient(chain());
    const review = await derivePrs(client, POINTERS);
    const pr = review.prs[1]!;
    expect(pr.title).toBe("pull 102");
    expect(pr.headSha).toBe(sha("sha102"));
    expect(pr.baseSha).toBe(sha("base102"));
    expect(pr.baseRef).toBe("feat/a");
    expect(pr.headRef).toBe("feat/b");
    expect(pr.author).toBe("ada");
    expect(pr.body).toBe("body of 102");
  });

  test("hunks come through the diff parser, with ids and line numbers", async () => {
    const client = countingClient(chain());
    const review = await derivePrs(client, POINTERS);
    const pr = review.prs[0]!;
    expect(pr.files.map((f) => f.path)).toEqual(["src/f101.ts"]);
    const hunks = hunksOf(pr);
    expect(hunks.length).toBe(1);
    // The flattened list is derived from files, so it cannot drift from them.
    expect(hunks).toEqual(pr.files.flatMap((f) => f.hunks));
    expect(hunks[0]!.id).toBe("pr101:src/f101.ts:@@1,2+1,3");
    expect(hunks[0]!.sha).toBe(sha("sha101"));
    expect(hunks[0]!.lines.map((l) => l.kind)).toEqual(["ctx", "add", "ctx"]);
  });

  test("review comments are collected into the skill context, in pointer order", async () => {
    const pulls = chain();
    pulls[`${REPO}#102`] = fakePull(102, "feat/b", "feat/a", {
      comments: [
        {
          id: 9,
          path: "src/f102.ts",
          body: "why here?",
          user: { login: "bob" },
          commit_id: sha("sha102"),
          line: 3,
          start_line: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const review = await derivePrs(countingClient(pulls), POINTERS);
    expect(review.skillContext.length).toBe(1);
    expect(review.skillContext[0]).toMatchObject({
      repo: REPO,
      prNumber: 102,
      id: 9,
      path: "src/f102.ts",
      body: "why here?",
      author: "bob",
      line: 3,
      inReplyTo: null,
    });
  });

  test("a review with no pull requests is a loud failure", async () => {
    await expect(derivePrs(countingClient({}), [])).rejects.toThrow(/at least one/);
  });

  test("the same pull request named twice is a loud failure, before any call", async () => {
    const client = countingClient(chain());
    await expect(
      derivePrs(client, [
        { repo: REPO, number: 101 },
        { repo: REPO, number: 101 },
      ]),
    ).rejects.toThrow(/acme\/app#101 more than once/);
    expect(client.total()).toBe(0);
  });

  test("a deleted account is a null author rather than a blank one", async () => {
    const pulls = chain();
    const gone = fakePull(101, "feat/a", "main");
    gone.pull = { ...gone.pull, user: null };
    pulls[`${REPO}#101`] = gone;
    const review = await derivePrs(countingClient(pulls), POINTERS);
    expect(review.prs[0]!.author).toBe(null);
  });
});

describe("co-authors", () => {
  test("trailers across commits are collected and deduplicated case-insensitively", () => {
    expect(
      coAuthorsOf([
        "first\n\nCo-Authored-By: Ada <A@Example.com>\n",
        "second\n\nco-authored-by: ada <a@example.com>\n",
        "third\n\nCO-AUTHORED-BY: Bob <bob@example.com>\n",
      ]),
    ).toEqual(["Ada <A@Example.com>", "Bob <bob@example.com>"]);
  });

  test("several trailers in one message all count", () => {
    expect(
      coAuthorsOf(["m\n\nCo-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>\n"]),
    ).toEqual(["A <a@x>", "B <b@x>"]);
  });

  test("a trailer without an email dedupes on its whole text", () => {
    expect(coAuthorsOf(["m\n\nCo-authored-by: Nameless\n", "n\n\nCo-authored-by: nameless\n"])).toEqual([
      "Nameless",
    ]);
  });

  test("the word inside prose is not a trailer", () => {
    expect(coAuthorsOf(["mentions co-authored-by: nobody in the middle of a line"])).toEqual([]);
  });

  test("a trailer quoted in an example in the body is not a co-author", () => {
    expect(
      coAuthorsOf(["see this example:\n\n```\n    Co-Authored-By: Fake <f@x>\n```\n"]),
    ).toEqual([]);
    // An indented line in the trailer paragraph is not a trailer either.
    expect(coAuthorsOf(["m\n\n    Co-Authored-By: Fake <f@x>\n"])).toEqual([]);
    // A trailer paragraph above prose is body text, not the trailer block.
    expect(
      coAuthorsOf(["Co-Authored-By: Fake <f@x>\n\nand then some prose about it\n"]),
    ).toEqual([]);
  });

  test("a pull request with no trailers derives an empty list", async () => {
    const review = await derivePrs(countingClient(chain()), POINTERS);
    expect(review.prs.map((p) => p.coAuthors)).toEqual([[], [], []]);
  });

  test("trailers on a pull request's commits land on that pull request", async () => {
    const pulls = chain();
    pulls[`${REPO}#101`] = fakePull(101, "feat/a", "main", {
      commits: [
        commit("c1", "one\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"),
        commit("c2", "two\n\nco-authored-by: CLAUDE <NOREPLY@anthropic.com>\n"),
      ],
    });
    const review = await derivePrs(countingClient(pulls), POINTERS);
    expect(review.prs[0]!.coAuthors).toEqual(["Claude <noreply@anthropic.com>"]);
    expect(review.prs[1]!.coAuthors).toEqual([]);
  });
});

describe("refs", () => {
  const FILE = "alpha\nbravo\ncharlie\ndelta\necho\n";

  async function fixture(blobs: Record<string, string>) {
    const client = countingClient(chain(), blobs);
    const review = await derivePrs(client, POINTERS);
    return { client, review, resolver: refResolver(client, review) };
  }

  test("a ref in range resolves exactly the lines it names", async () => {
    const { resolver } = await fixture({ [`${sha("sha101")}:src/f101.ts`]: FILE });
    const ref = await resolver.resolve({
      repo: REPO,
      sha: sha("sha101"),
      path: "src/f101.ts",
      startLine: 2,
      endLine: 4,
      highlight: [3],
    });
    expect(ref.snippet).toBe("bravo\ncharlie\ndelta");
    expect(ref.startLine).toBe(2);
    expect(ref.endLine).toBe(4);
    expect(ref.highlight).toEqual([3]);
  });

  test("a highlight outside the range is a loud failure, not a dropped line", async () => {
    const { client, resolver } = await fixture({ [`${sha("sha101")}:src/f101.ts`]: FILE });
    const err = await resolver
      .resolve({
        repo: REPO,
        sha: sha("sha101"),
        path: "src/f101.ts",
        startLine: 2,
        endLine: 4,
        highlight: [3, 99],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefResolveError);
    expect((err as RefResolveError).message).toContain("99");
    expect((err as RefResolveError).path).toBe("src/f101.ts");
    expect((err as RefResolveError).startLine).toBe(2);
    expect((err as RefResolveError).endLine).toBe(4);
    // Refused before anything is fetched, so a drifted ref costs no GitHub call.
    expect(client.calls.getFileAtSha).toBe(0);
  });

  test("a ref whose sha is not a sha is refused before it can poison the cache", async () => {
    const { client, resolver } = await fixture({ [`main:src/f101.ts`]: FILE });
    for (const bad of ["main", "v1.2.0", sha("sha101").slice(0, 7), `${sha("sha101")}x`]) {
      const err = await resolver
        .resolve({ repo: REPO, sha: bad, path: "src/f101.ts", startLine: 1, endLine: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefResolveError);
      expect((err as RefResolveError).sha).toBe(bad);
      expect((err as RefResolveError).path).toBe("src/f101.ts");
      expect((err as RefResolveError).message).toContain("src/f101.ts:1-1");
      // Nothing fetched, so nothing mutable can reach the shared table.
      expect(getSnippet(REPO, bad, "src/f101.ts")).toBeNull();
    }
    expect(client.calls.getFileAtSha).toBe(0);
  });

  test("a sha in capitals resolves as the same cache key, not a second row", async () => {
    const { client, resolver } = await fixture({ [`${sha("sha101")}:src/case.ts`]: FILE });
    const pointer = { repo: REPO, path: "src/case.ts", startLine: 1, endLine: 1 };
    expect((await resolver.resolve({ ...pointer, sha: sha("sha101") })).snippet).toBe("alpha");
    const upper = await resolver.resolve({ ...pointer, sha: sha("sha101").toUpperCase() });
    expect(upper.sha).toBe(sha("sha101"));
    expect(upper.origin).toBe("outside");
    expect(client.calls.getFileAtSha).toBe(1);
  });

  test("the last line resolves even without a trailing newline", async () => {
    const { resolver } = await fixture({ [`${sha("sha101")}:src/nonewline.ts`]: "a\nb\nc" });
    const ref = await resolver.resolve({
      repo: REPO,
      sha: sha("sha101"),
      path: "src/nonewline.ts",
      startLine: 3,
      endLine: 3,
    });
    expect(ref.snippet).toBe("c");
  });

  test("a second resolve of the same file costs zero client calls", async () => {
    const { client, resolver } = await fixture({ [`${sha("sha101")}:src/cached.ts`]: FILE });
    const pointer = {
      repo: REPO,
      sha: sha("sha101"),
      path: "src/cached.ts",
      startLine: 1,
      endLine: 2,
    };
    await resolver.resolve(pointer);
    expect(client.calls.getFileAtSha).toBe(1);
    const before = client.total();
    const again = await resolver.resolve({ ...pointer, startLine: 4, endLine: 5 });
    expect(client.total()).toBe(before);
    expect(client.calls.getFileAtSha).toBe(1);
    expect(again.snippet).toBe("delta\necho");

    // The cache is the shared (repo, sha, path) table, so a fresh resolver over a
    // fresh client pays nothing either.
    const fresh = countingClient(chain(), {});
    const review = await derivePrs(fresh, POINTERS);
    const cold = await refResolver(fresh, review).resolve(pointer);
    expect(cold.snippet).toBe("alpha\nbravo");
    expect(fresh.calls.getFileAtSha).toBe(0);
  });

  test("the cache is not read for a repository this review has not fetched", async () => {
    // Another workspace resolved this file already, so the shared table holds it.
    putSnippet("private/secrets", sha("shaX"), "src/keys.ts", FILE);
    const { client, resolver } = await fixture({});
    const pointer = {
      repo: "private/secrets",
      sha: sha("shaX"),
      path: "src/keys.ts",
      startLine: 1,
      endLine: 1,
    };
    // The pointer names a repository outside the review, so the cache stays shut and
    // the fetch under the caller's own token decides it, which here fails.
    const err = await resolver.resolve(pointer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefResolveError);
    expect(client.calls.getFileAtSha).toBe(1);
  });

  test("a repository the caller's token has read opens the cache for later refs", async () => {
    const { client, resolver } = await fixture({ [`${sha("shaY")}:src/other.ts`]: FILE });
    const pointer = {
      repo: "other/app",
      sha: sha("shaY"),
      path: "src/other.ts",
      startLine: 1,
      endLine: 1,
    };
    expect((await resolver.resolve(pointer)).snippet).toBe("alpha");
    expect(client.calls.getFileAtSha).toBe(1);
    // Proved once under the token, so the second resolve is free.
    expect((await resolver.resolve({ ...pointer, startLine: 2, endLine: 2 })).snippet).toBe(
      "bravo",
    );
    expect(client.calls.getFileAtSha).toBe(1);
  });

  test("a file above the cache bound resolves but is never stored", async () => {
    const big = `${"x".repeat(600 * 1024)}\nsecond line\n`;
    const { client, resolver } = await fixture({ [`${sha("sha101")}:src/huge.ts`]: big });
    const pointer = {
      repo: REPO,
      sha: sha("sha101"),
      path: "src/huge.ts",
      startLine: 2,
      endLine: 2,
    };
    expect((await resolver.resolve(pointer)).snippet).toBe("second line");
    expect(getSnippet(REPO, sha("sha101"), "src/huge.ts")).toBeNull();
    expect(client.calls.getFileAtSha).toBe(1);
    // No row, so the second resolve fetches again rather than serving from nowhere.
    await resolver.resolve(pointer);
    expect(client.calls.getFileAtSha).toBe(2);
  });

  test("stale cached files are swept by age, and fresh ones are left alone", async () => {
    const TTL = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // One row fetched long ago and one fetched just now, so the sweep has to choose
    // between them rather than emptying the shared table.
    putSnippet(REPO, sha("shaOld"), "src/old.ts", FILE, now - TTL - 60_000);
    putSnippet(REPO, sha("shaNew"), "src/new.ts", FILE, now);
    expect(getSnippet(REPO, sha("shaOld"), "src/old.ts")).toBe(FILE);
    expect(sweepSnippetCache(now)).toBeGreaterThanOrEqual(1);
    expect(getSnippet(REPO, sha("shaOld"), "src/old.ts")).toBeNull();
    expect(getSnippet(REPO, sha("shaNew"), "src/new.ts")).toBe(FILE);
  });

  test("a transport failure keeps its cause and status instead of reading as a bad ref", async () => {
    const client = countingClient(chain(), {});
    const review = await derivePrs(client, POINTERS);
    const failing: GithubClient = {
      ...client,
      async getFileAtSha() {
        throw new GithubError("GET /contents failed with 401", 401, "https://api.github.com/x");
      },
    };
    const err = await refResolver(failing, review)
      .resolve({ repo: REPO, sha: sha("sha101"), path: "src/token.ts", startLine: 1, endLine: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefResolveError);
    expect((err as RefResolveError).status).toBe(401);
    expect((err as RefResolveError).cause).toBeInstanceOf(GithubError);
    // A ref that genuinely does not resolve carries no misleading status.
    const { resolver } = await fixture({});
    const plain = await resolver
      .resolve({ repo: REPO, sha: sha("sha101"), path: "src/gone.ts", startLine: 1, endLine: 1 })
      .catch((e: unknown) => e);
    expect((plain as RefResolveError).status).toBe(null);
  });

  test("a range past the end is a structured error naming the path and the range", async () => {
    const { resolver } = await fixture({ [`${sha("sha101")}:src/f101.ts`]: FILE });
    const pointer = {
      repo: REPO,
      sha: sha("sha101"),
      path: "src/f101.ts",
      startLine: 4,
      endLine: 9,
    };
    const err = await resolver.resolve(pointer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefResolveError);
    const structured = err as RefResolveError;
    expect(structured.code).toBe("ref_unresolved");
    expect(structured.path).toBe("src/f101.ts");
    expect(structured.startLine).toBe(4);
    expect(structured.endLine).toBe(9);
    expect(structured.repo).toBe(REPO);
    expect(structured.sha).toBe(sha("sha101"));
    expect(structured.message).toContain("src/f101.ts:4-9");
  });

  test("an inverted or zero range is a structured error before any fetch", async () => {
    const { client, resolver } = await fixture({});
    const before = client.total();
    for (const range of [
      { startLine: 5, endLine: 2 },
      { startLine: 0, endLine: 2 },
    ]) {
      const err = await resolver
        .resolve({ repo: REPO, sha: sha("sha101"), path: "src/f101.ts", ...range })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefResolveError);
    }
    expect(client.total()).toBe(before);
  });

  test("a file that does not resolve at its sha names the path and the range too", async () => {
    const { resolver } = await fixture({});
    const err = await resolver
      .resolve({ repo: REPO, sha: sha("sha101"), path: "src/gone.ts", startLine: 1, endLine: 2 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefResolveError);
    expect((err as RefResolveError).message).toContain("src/gone.ts:1-2");
  });

  test("a changed file at a head sha is in_stack, an untouched file is outside", async () => {
    const { resolver } = await fixture({
      [`${sha("sha101")}:src/f101.ts`]: FILE,
      [`${sha("sha101")}:src/auth.ts`]: FILE,
      [`${sha("base101")}:src/f101.ts`]: FILE,
    });
    const at = async (path: string, atSha: string) =>
      (await resolver.resolve({ repo: REPO, sha: atSha, path, startLine: 1, endLine: 1 })).origin;
    expect(await at("src/f101.ts", sha("sha101"))).toBe("in_stack");
    // The same file before the change is still inside the change.
    expect(await at("src/f101.ts", sha("base101"))).toBe("in_stack");
    // Untouched by any pull request in the review.
    expect(await at("src/auth.ts", sha("sha101"))).toBe("outside");
  });

  test("origin is derived per review, not per file name", async () => {
    const { review } = await fixture({});
    expect(
      deriveOrigin(review.prs, {
        repo: REPO,
        sha: sha("sha103"),
        path: "src/f103.ts",
        startLine: 1,
        endLine: 1,
      }),
    ).toBe("in_stack");
    // The right path at a sha this review does not carry is outside it.
    expect(
      deriveOrigin(review.prs, {
        repo: REPO,
        sha: sha("unrelated"),
        path: "src/f103.ts",
        startLine: 1,
        endLine: 1,
      }),
    ).toBe("outside");
    // The right sha in the wrong repository is outside too.
    expect(
      deriveOrigin(review.prs, {
        repo: "other/app",
        sha: sha("sha103"),
        path: "src/f103.ts",
        startLine: 1,
        endLine: 1,
      }),
    ).toBe("outside");
  });

  test("both names of a renamed file are inside the change", async () => {
    const pulls = chain();
    pulls[`${REPO}#101`] = fakePull(101, "feat/a", "main", {
      files: [
        file("src/new.ts", PATCH, {
          status: "renamed",
          previous_filename: "src/old.ts",
        }),
      ],
    });
    const client = countingClient(pulls, {});
    const review = await derivePrs(client, POINTERS);
    const pointer = { repo: REPO, sha: sha("sha101"), startLine: 1, endLine: 1 };
    expect(deriveOrigin(review.prs, { ...pointer, path: "src/new.ts" })).toBe("in_stack");
    expect(deriveOrigin(review.prs, { ...pointer, path: "src/old.ts" })).toBe("in_stack");
  });
});

describe("derived kinds on a pull request card", () => {
  const statements = [
    { kind: "add" as const, prs: [prKey(REPO, 101), prKey(REPO, 102)] },
    { kind: "remove" as const, prs: [prKey(REPO, 101)] },
    { kind: "add" as const, prs: [prKey(REPO, 101)] },
    { kind: "change" as const, prs: [prKey(REPO, 103)] },
  ];

  test("kinds are the distinct kinds of the statements attributed to the pull request", () => {
    expect(kindsForPr(statements, prKey(REPO, 101))).toEqual(["add", "remove"]);
    expect(kindsForPr(statements, prKey(REPO, 102))).toEqual(["add"]);
    expect(kindsForPr(statements, prKey(REPO, 103))).toEqual(["change"]);
  });

  test("a pull request no statement names derives no kinds", () => {
    expect(kindsForPr(statements, prKey(REPO, 404))).toEqual([]);
    expect(kindsForPr([], prKey(REPO, 101))).toEqual([]);
  });

  test("the order is add, change, remove whatever order the statements come in", () => {
    expect(
      kindsForPr(
        [
          { kind: "remove", prs: ["a#1"] },
          { kind: "change", prs: ["a#1"] },
          { kind: "add", prs: ["a#1"] },
        ],
        "a#1",
      ),
    ).toEqual(["add", "change", "remove"]);
  });

  test("prKey spells the documented key", () => {
    expect(prKey("acme/app", 12)).toBe("acme/app#12");
  });
});
