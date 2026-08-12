// The code around a hunk: GET /<ws>/r/<slug>/c, over a real server.
//
// Two things are under test. The first is that the route serves the file the panel
// needs and nothing else: a path and a sha it was given, sliced to a range, rendered
// as the same lines the page draws. The second is the allow-list, which is the whole
// reason this route can exist at all — the pair asked for has to be one a hunk of the
// stored document carries, and everything else is the same refusal a slug in another
// workspace gets. A reader who is not allowed and a file that was never in the review
// are one answer, byte for byte.
//
// Signed-out and non-member reads need forged cookies, which AUTH_DISABLED makes
// impossible in this process; those live in context-privacy.script.ts beside the same
// pattern read-privacy.script.ts uses.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { join } from "node:path";

import { startServer } from "../../src/server";
import { createShare } from "../../src/shares";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { GithubError, type GithubClient } from "../../src/overseer/github";
import { offlineGithubClient, offlineGithubClientFactory } from "../offline-github";
import { sweepSnippets } from "../../src/overseer/db";
import { tinyId } from "../../src/ids";
import {
  GOLDEN_HEAD_SHA_12,
  GOLDEN_HEAD_SHA_13,
  GOLDEN_HUNKS,
  GOLDEN_OUTSIDE_PATH,
  GOLDEN_REPO,
} from "./fixtures/golden-review";
import {
  GOLDEN_REF_LINES,
  GOLDEN_REF_START,
  goldenRef,
  goldenStoredDoc,
  storeGoldenReview,
} from "./fixtures/stored-review";
import { createReviewVersion } from "../../src/overseer/db";
import { fileLines, hunksAgree } from "../../src/overseer/context";
import { newSpan } from "../../src/overseer/render-diff";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let ws = "";
let other = "";

/** A file that agrees with everything the golden document says about it: lines 40 to 48
 *  are the lines its refs quote, and the first three of those are the golden hunk's own
 *  new-side lines. Everything else is filler that is recognisably neither. */
const AUTH_FILE = (() => {
  const lines: string[] = [];
  for (let n = 1; n <= 120; n++) lines.push("const filler" + n + " = " + n + ";");
  GOLDEN_REF_LINES.forEach((line, i) => { lines[GOLDEN_REF_START - 1 + i] = line; });
  return lines.join("\n") + "\n";
})();

/** Counts what the route actually asked GitHub for, so the cache can be shown to be
 *  doing its job rather than assumed to be.
 *
 *  `routed` is whether this workspace still holds an installation covering the
 *  repository. It is what decides whether the shared snippet cache may be read at all,
 *  so a fake that always said yes could not show the case that matters. */
function serving(
  files: Record<string, string>,
  routed = true,
): { client: GithubClient; reads: string[] } {
  const reads: string[] = [];
  const client: GithubClient = {
    ...offlineGithubClient(),
    async installationFor() {
      return routed ? 4242 : null;
    },
    async getFileAtSha(repo, path, sha) {
      reads.push(`${repo}:${sha}:${path}`);
      const got = files[`${sha}:${path}`];
      if (got === undefined) throw new GithubError("Not Found", 404, "https://api.github.com/x");
      return got;
    },
  };
  return { client, reads };
}

function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

/** What the route answers with: a range of the file, or a refusal the panel can say
 *  out loud. Both shapes in one type, because the panel branches on exactly this. */
interface ContextBody {
  total?: number;
  from?: number;
  to?: number;
  lines?: string[];
  context?: null;
  why?: string;
}

async function read(res: Response): Promise<ContextBody> {
  return (await res.json()) as ContextBody;
}

/** Status, content type and body together: two refusals being indistinguishable is a
 *  claim about the whole response, not about its status line. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

function ask(wsId: string, slug: string, q: Record<string, string>): Promise<Response> {
  const search = new URLSearchParams(q).toString();
  return get(`/${wsId}/r/${slug}/c?${search}`);
}

/** The one refusal, taken from a miss nobody disputes: an unknown slug. */
async function refusal(): Promise<string> {
  return shape(await ask(ws, "no-such-review", { path: "a.ts", sha: "0".repeat(40), from: "1", to: "2" }));
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Context", owner);

  const stranger = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
    stranger,
    "context-stranger@example.com",
    Date.now(),
  ]);
  other = createWorkspace("Context elsewhere", stranger);

  storeGoldenReview(ws, "golden");
  storeGoldenReview(other, "theirs");

  // The same review with one note quoting a file no pull request touches. The
  // walkthrough can say nothing about that file; the note is the only reason it is on
  // the page at all, and therefore the only thing that may open it.
  const quoted = goldenStoredDoc();
  createReviewVersion(ws, "quoted", {
    ...quoted,
    notes: quoted.notes.map((n, i) =>
      i === 0 ? { ...n, refs: [goldenRef("ref_outside", GOLDEN_OUTSIDE_PATH, GOLDEN_HEAD_SHA_12)] } : n,
    ),
  });
});

afterAll(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  server.stop();
});

describe("the file around a hunk", () => {
  test("serves the range, the lines and how long the file is", async () => {
    const { client, reads } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    sweepSnippets(Date.now() + 1);

    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_12,
      from: "20",
      to: "30",
    });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.total).toBe(120);
    expect(body.from).toBe(20);
    expect(body.to).toBe(30);
    expect(body.lines!.length).toBe(11);
    // The same line markup the walkthrough draws, with the new-side number in the
    // gutter and the file's own text beside it.
    expect(body.lines![0]).toContain('<span class="n">20</span>');
    expect(body.lines![0]).toContain("filler20");
    // Syntax classes come from the path, so the panel's code reads like the page's.
    expect(body.lines![0]).toContain('<span class="kw">const</span>');
    expect(reads.length).toBe(1);
  });

  test("a second range of the same file costs no second fetch", async () => {
    const { client, reads } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const q = { path: GOLDEN_HUNKS.auth.path, sha: GOLDEN_HEAD_SHA_12 };
    await ask(ws, "golden", { ...q, from: "1", to: "10" });
    await ask(ws, "golden", { ...q, from: "60", to: "70" });
    // The first request may or may not have paid for it, depending on what the test
    // before left in the cache. What matters is that the second did not.
    expect(reads.length).toBeLessThanOrEqual(1);
  });

  test("a workspace that no longer holds the repository gets no cached bytes", async () => {
    // Warm the cache as a workspace that does hold it. `ref_snippets` has no workspace
    // column, so from here on those bytes are sitting in a table anyone could read out
    // of if the route let them.
    const warm = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => warm.client);
    sweepSnippets(Date.now() + 1);
    expect((await ask(ws, "golden", { path: "src/auth.ts", sha: GOLDEN_HEAD_SHA_12, from: "1", to: "5" })).status).toBe(200);
    expect(warm.reads.length).toBe(1);

    // The same review, the same document naming the same file, and an installation that
    // has since gone away. The document is evidence of what this workspace could read
    // once; it is not evidence about now, so the cache stays shut.
    const gone = serving({}, false);
    setGithubClientFactory(() => gone.client);
    const res = await ask(ws, "golden", {
      path: "src/auth.ts",
      sha: GOLDEN_HEAD_SHA_12,
      from: "1",
      to: "5",
    });
    // GitHub was asked, rather than the cache answering on its own...
    expect(gone.reads.length).toBe(1);
    // ...and since it declined, nothing of the file comes back.
    const body = await read(res);
    expect(body.context).toBe(null);
    expect(JSON.stringify(body)).not.toContain("filler");
  });

  test("asked past the end, it answers with the file and its length", async () => {
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_12,
      from: "115",
      to: "160",
    });
    const body = await read(res);
    // The panel asks for a window around a hunk before it knows how long the file is,
    // so running off the end is a normal request rather than a bad one.
    expect(body.from).toBe(115);
    expect(body.to).toBe(120);
    expect(body.lines!.length).toBe(6);
    expect(body.total).toBe(120);
  });

  test("a file GitHub will not serve is a refusal the panel can say out loud", async () => {
    const { client } = serving({});
    setGithubClientFactory(() => client);
    sweepSnippets(Date.now() + 1);
    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.routes.path,
      sha: GOLDEN_HEAD_SHA_13,
      from: "1",
      to: "10",
    });
    // Not a 404: nothing about the request was wrong, and the reader is owed the
    // difference between "you may not" and "it is not there".
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.context).toBe(null);
    expect(typeof body.why).toBe("string");
    expect(body.lines).toBeUndefined();
  });

  test("a file that no longer matches its hunks is refused rather than stitched", async () => {
    // Line 41 is the golden hunk's added line. A file whose line 41 is something else
    // is not the file this hunk was cut from, whatever the sha says.
    const drifted = AUTH_FILE.split("\n");
    drifted[40] = "  return somethingElseEntirely();";
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: drifted.join("\n") });
    setGithubClientFactory(() => client);
    sweepSnippets(Date.now() + 1);

    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_12,
      from: "20",
      to: "30",
    });
    const body = await read(res);
    expect(body.context).toBe(null);
    expect(body.why).toContain("no longer matches");
  });
});

describe("what the document does not name", () => {
  test("a path the review never touched is the same answer as an unknown slug", async () => {
    // A real file, in a repository this workspace has an installation for, at a sha
    // the review does name. Everything about it is plausible except that nothing in
    // this review carries it, which is the whole of the allow-list.
    const { client, reads } = serving({
      [`${GOLDEN_HEAD_SHA_12}:src/nowhere.ts`]: "const secret = 1;\n",
    });
    setGithubClientFactory(() => client);

    const res = await ask(ws, "golden", {
      path: "src/nowhere.ts",
      sha: GOLDEN_HEAD_SHA_12,
      from: "1",
      to: "10",
    });
    expect(await shape(res)).toBe(await refusal());
    // And GitHub was never asked, so the refusal is not a leak of what is there.
    expect(reads).toEqual([]);
  });

  test("a file only a quoted ref names is opened, because a ref is on the page too", async () => {
    // A hunk is not the only code a review shows. A statement, a note, the code design
    // and an answer each quote lines, each wears the same full-screen control, and each
    // has the same claim on the file around it.
    const outside: string[] = [];
    for (let n = 1; n <= 90; n++) outside.push("const elsewhere" + n + " = " + n + ";");
    GOLDEN_REF_LINES.forEach((line, i) => { outside[GOLDEN_REF_START - 1 + i] = line; });
    const { client } = serving({
      [`${GOLDEN_HEAD_SHA_12}:${GOLDEN_OUTSIDE_PATH}`]: outside.join("\n") + "\n",
    });
    setGithubClientFactory(() => client);
    sweepSnippets(Date.now() + 1);

    const body = await read(
      await ask(ws, "quoted", {
        path: GOLDEN_OUTSIDE_PATH,
        sha: GOLDEN_HEAD_SHA_12,
        from: "20",
        to: "30",
      }),
    );
    expect(body.total).toBe(90);
    expect(body.lines!.length).toBe(11);
    expect(body.lines![0]).toContain("elsewhere20");

    // The same file on the review that does not quote it stays shut.
    expect(
      await shape(
        await ask(ws, "golden", {
          path: GOLDEN_OUTSIDE_PATH,
          sha: GOLDEN_HEAD_SHA_12,
          from: "20",
          to: "30",
        }),
      ),
    ).toBe(await refusal());
  });

  test("a file that no longer says what a ref quoted is refused rather than marked", async () => {
    // Line 44 is inside the range the note quotes. A file that says something else
    // there is not the file that snippet came from, and laying the panel out around it
    // would put the reader's mark on lines nobody quoted.
    const outside: string[] = [];
    for (let n = 1; n <= 90; n++) outside.push("const elsewhere" + n + " = " + n + ";");
    GOLDEN_REF_LINES.forEach((line, i) => { outside[GOLDEN_REF_START - 1 + i] = line; });
    outside[GOLDEN_REF_START + 3] = "  // something else entirely";
    const { client } = serving({
      [`${GOLDEN_HEAD_SHA_12}:${GOLDEN_OUTSIDE_PATH}`]: outside.join("\n") + "\n",
    });
    setGithubClientFactory(() => client);
    sweepSnippets(Date.now() + 1);

    const body = await read(
      await ask(ws, "quoted", {
        path: GOLDEN_OUTSIDE_PATH,
        sha: GOLDEN_HEAD_SHA_12,
        from: "20",
        to: "30",
      }),
    );
    expect(body.context).toBe(null);
    expect(body.why).toContain("no longer matches");
  });

  test("the right path at the wrong commit is refused too", async () => {
    // src/auth.ts is in the review; it is in it at the pull request 12 head, and this
    // is the pull request 13 head. A sha the document does not pair with this path is
    // a different file.
    const { client, reads } = serving({
      [`${GOLDEN_HEAD_SHA_13}:src/auth.ts`]: AUTH_FILE,
    });
    setGithubClientFactory(() => client);
    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_13,
      from: "1",
      to: "10",
    });
    expect(await shape(res)).toBe(await refusal());
    expect(reads).toEqual([]);
  });

  test("another workspace's review is not readable by naming its slug", async () => {
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const res = await ask(other, "theirs", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_12,
      from: "1",
      to: "10",
    });
    expect(await shape(res)).toBe(await refusal());
  });

  test("a range that is not a range is the same answer as everything else", async () => {
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const q = { path: GOLDEN_HUNKS.auth.path, sha: GOLDEN_HEAD_SHA_12 };
    const one = await refusal();
    expect(await shape(await ask(ws, "golden", { ...q, from: "30", to: "20" }))).toBe(one);
    expect(await shape(await ask(ws, "golden", { ...q, from: "0", to: "5" }))).toBe(one);
    expect(await shape(await ask(ws, "golden", { ...q, from: "1", to: "9000" }))).toBe(one);
    expect(await shape(await ask(ws, "golden", { ...q, from: "x", to: "5" }))).toBe(one);
    // A short sha is not a sha: a ref is pinned to forty characters everywhere else
    // in Overseer and this is no different.
    expect(
      await shape(await ask(ws, "golden", { path: q.path, sha: "2222222", from: "1", to: "5" })),
    ).toBe(one);
  });

  test("a version that does not exist reads nothing", async () => {
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const res = await ask(ws, "golden", {
      path: GOLDEN_HUNKS.auth.path,
      sha: GOLDEN_HEAD_SHA_12,
      from: "1",
      to: "10",
      v: "7",
    });
    expect(await shape(res)).toBe(await refusal());
  });
});

describe("the share path", () => {
  test("a token that opens the review does not open the files behind it", async () => {
    const { client } = serving({ [`${GOLDEN_HEAD_SHA_12}:src/auth.ts`]: AUTH_FILE });
    setGithubClientFactory(() => client);
    const { token } = createShare({
      wsId: ws,
      kind: "review",
      target: "golden",
      label: "for a reader outside",
      userId: listMembers(legacyWorkspaceId()!)[0]!.id,
      expiresAt: null,
    });

    // The review itself is readable on the token: that is what it was minted for.
    const page = await get(`/s/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(GOLDEN_REPO);

    // Its files are not. A share hands over the review and the hunks the walkthrough
    // drew; the whole of every file they touch is a larger thing than the person who
    // minted the link agreed to.
    const res = await get(
      `/s/${token}/c?path=${encodeURIComponent(GOLDEN_HUNKS.auth.path)}` +
        `&sha=${GOLDEN_HEAD_SHA_12}&from=1&to=10`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("filler");
  });
});

// ---- signed out and non-member (own process) ----

describe("cross-user reads", () => {
  test("context-privacy.script.ts passes with AUTH_DISABLED unset", async () => {
    const script = join(import.meta.dir, "context-privacy.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      console.error("subprocess stdout:", stdout);
      console.error("subprocess stderr:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("all assertions passed");
  }, 30_000);
});

// ---- the two readings a stitched file rests on ----

describe("reading a file back against its hunks", () => {
  test("a trailing newline terminates the last line rather than starting one", () => {
    // The same rule the diff parser mints line numbers under. Off by one here and every
    // line the panel draws below a hunk is off by one too.
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\nb")).toEqual(["a", "b"]);
    expect(fileLines("")).toEqual([]);
    // A file that is one newline reads as no lines, which is arguable on its own and
    // not arguable here: this is the reading the ref resolver already uses, and the
    // numbers a hunk carries were minted under it. Two readings of one file is the
    // failure worth avoiding.
    expect(fileLines("\n")).toEqual([]);
  });

  test("a hunk agrees with the file only where the file has its lines", () => {
    const hunk = GOLDEN_HUNKS.auth;
    const lines = AUTH_FILE.split("\n");
    expect(hunksAgree([hunk], lines)).toBe(true);
    // The added line, moved: the file is no longer the one this hunk was cut from.
    const moved = lines.slice();
    moved[40] = "  return false;";
    expect(hunksAgree([hunk], moved)).toBe(false);
    // A file that stops before the hunk cannot be the file either, and a slice of it
    // that happens to miss the disagreement must not pass for one.
    expect(hunksAgree([hunk], lines.slice(0, 20))).toBe(false);
  });

  test("a hunk that only deletes is positioned rather than sized", () => {
    // `@@ -a,b +c,0 @@` puts the deletion after line c. The span says so by ending one
    // short of where it starts, which is what the panel lays it out by.
    const span = newSpan({
      ...GOLDEN_HUNKS.auth,
      newStart: 40,
      newLines: 0,
      lines: [{ kind: "del", oldNo: 41, newNo: null, content: "  gone();", wordRanges: [] }],
    });
    expect(span).toEqual({ from: 41, to: 40 });
    // And it agrees with any file, because it claims no line of one.
    expect(hunksAgree([{ ...GOLDEN_HUNKS.auth, lines: [] }], [])).toBe(true);
  });
});
