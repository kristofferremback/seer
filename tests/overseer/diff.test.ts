import { test, expect, describe } from "bun:test";
import {
  parsePatch,
  hunkId,
  wordRangesFor,
  splitUnifiedDiff,
  collectPullDiff,
  DiffParseError,
} from "../../src/overseer/diff";
import type { GithubFile } from "../../src/overseer/github";
import type { Hunk } from "../../src/overseer/types";
import { fakeGithubClient, loadFiles, loadDegenerateFiles, degenerateDiff } from "./github-fixtures";

const CTX = { repo: "kristofferremback/seer", prNumber: 7, sha: "deadbeef" };

function byPath(files: GithubFile[], path: string): GithubFile {
  const f = files.find((x) => x.filename === path);
  if (!f) throw new Error(`fixture has no ${path}`);
  return f;
}

describe("hunk ids", () => {
  test("the id is exactly the documented format", () => {
    expect(hunkId(12, "src/server.ts", 40, 6, 41, 9)).toBe("pr12:src/server.ts:@@40,6+41,9");
  });

  test("a parsed hunk carries that id, built from its own header", () => {
    const [hunk] = parsePatch("@@ -40,2 +41,3 @@\n a\n+b\n c\n", { ...CTX, path: "src/server.ts" });
    expect(hunk!.id).toBe("pr7:src/server.ts:@@40,2+41,3");
  });

  test("ids are deterministic across two parses of the same patch", () => {
    const files = loadDegenerateFiles();
    const patch = byPath(files, "src/multi.ts").patch!;
    const first = parsePatch(patch, { ...CTX, path: "src/multi.ts" }).map((h) => h.id);
    const second = parsePatch(patch, { ...CTX, path: "src/multi.ts" }).map((h) => h.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  test("a one-line range still spells its counts out", () => {
    const [hunk] = parsePatch("@@ -3 +3 @@\n-a\n+b\n", { ...CTX, path: "x.ts" });
    expect(hunk!.id).toBe("pr7:x.ts:@@3,1+3,1");
  });
});

describe("parsing shapes", () => {
  test("a multi-hunk file yields one hunk per header, in order", () => {
    const files = loadDegenerateFiles();
    const hunks = parsePatch(byPath(files, "src/multi.ts").patch!, { ...CTX, path: "src/multi.ts" });
    expect(hunks.length).toBe(2);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[1]!.oldStart).toBe(20);
    expect(hunks[1]!.newStart).toBe(21);
  });

  test("a rename parses under its new path and keeps the old one on the file entry", () => {
    const files = loadDegenerateFiles();
    const entry = byPath(files, "src/renamed-new.ts");
    expect(entry.previous_filename).toBe("src/renamed-old.ts");
    const hunks = parsePatch(entry.patch!, { ...CTX, path: entry.filename });
    expect(hunks[0]!.path).toBe("src/renamed-new.ts");
    expect(hunks[0]!.id.startsWith("pr7:src/renamed-new.ts:")).toBe(true);
  });

  test("a deleted file is all deletions and has no new side", () => {
    const files = loadDegenerateFiles();
    const [hunk] = parsePatch(byPath(files, "src/gone.ts").patch!, { ...CTX, path: "src/gone.ts" });
    expect(hunk!.newLines).toBe(0);
    expect(hunk!.newStart).toBe(0);
    expect(hunk!.lines.every((l) => l.kind === "del")).toBe(true);
    expect(hunk!.lines.every((l) => l.newNo === null)).toBe(true);
  });

  test("a new file is all additions and has no old side", () => {
    const files = loadDegenerateFiles();
    const [hunk] = parsePatch(byPath(files, "src/brand-new.ts").patch!, { ...CTX, path: "src/brand-new.ts" });
    expect(hunk!.oldLines).toBe(0);
    expect(hunk!.lines.every((l) => l.kind === "add")).toBe(true);
    expect(hunk!.lines.map((l) => l.newNo)).toEqual([1, 2, 3]);
  });

  test("no-newline markers are consumed and counted on neither side", () => {
    const files = loadDegenerateFiles();
    const [hunk] = parsePatch(byPath(files, "src/eof.ts").patch!, { ...CTX, path: "src/eof.ts" });
    expect(hunk!.lines.length).toBe(4);
    expect(hunk!.lines.some((l) => l.content.startsWith("\\"))).toBe(false);
    expect(hunk!.lines.map((l) => l.kind)).toEqual(["ctx", "ctx", "del", "add"]);
  });

  test("an empty patch line is a context line, not a parse failure", () => {
    const [hunk] = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n", { ...CTX, path: "x.ts" });
    expect(hunk!.lines[1]!.kind).toBe("ctx");
    expect(hunk!.lines[1]!.content).toBe("");
  });

  test("a hunk whose body contradicts its header fails loudly", () => {
    expect(() => parsePatch("@@ -1,5 +1,5 @@\n a\n b\n", { ...CTX, path: "x.ts" })).toThrow(DiffParseError);
  });

  test("an unrecognized line marker fails loudly", () => {
    expect(() => parsePatch("@@ -1,1 +1,1 @@\n?wat\n", { ...CTX, path: "x.ts" })).toThrow(DiffParseError);
  });
});

describe("word ranges", () => {
  test("a one-word edit yields exactly one range per side, over that word", () => {
    const [oldR, newR] = wordRangesFor("two three four", "two THREE four");
    expect(oldR).toEqual([[4, 9]]);
    expect(newR).toEqual([[4, 9]]);
  });

  test("a fully rewritten line yields one range per side, spanning the line", () => {
    const [oldR, newR] = wordRangesFor("alpha beta gamma", "delta epsilon zeta");
    expect(oldR).toEqual([[0, 16]]);
    expect(newR).toEqual([[0, 18]]);
  });

  test("a pure insertion marks the seam on the old side", () => {
    const [oldR, newR] = wordRangesFor("a c", "a b c");
    expect(newR).toEqual([[2, 3]]);
    expect(oldR.length).toBe(1);
    expect(oldR[0]![0]).toBe(oldR[0]![1]);
  });

  test("paired del and add runs are painted, unpaired lines are not", () => {
    const files = loadDegenerateFiles();
    const hunks = parsePatch(byPath(files, "src/multi.ts").patch!, { ...CTX, path: "src/multi.ts" });
    const second = hunks[1]!;
    const dels = second.lines.filter((l) => l.kind === "del");
    const adds = second.lines.filter((l) => l.kind === "add");
    expect(dels.length).toBe(2);
    expect(adds.length).toBe(3);
    expect(dels.every((l) => l.wordRanges.length > 0)).toBe(true);
    expect(adds[0]!.wordRanges.length).toBeGreaterThan(0);
    expect(adds[1]!.wordRanges.length).toBeGreaterThan(0);
    // Pairing is positional: "let x = 0;" against "let x = 1;" and "let y = 0;"
    // against "let y = 2;", so each pair differs in its last word alone. Pairing them
    // the other way round would also mark the variable name.
    expect(dels[0]!.content).toBe("let x = 0;");
    expect(adds[0]!.content).toBe("let x = 1;");
    expect(dels[0]!.wordRanges).toEqual([[8, 10]]);
    expect(adds[0]!.wordRanges).toEqual([[8, 10]]);
    expect(dels[1]!.content).toBe("let y = 0;");
    expect(adds[1]!.content).toBe("let y = 2;");
    expect(dels[1]!.wordRanges).toEqual([[8, 10]]);
    expect(adds[1]!.wordRanges).toEqual([[8, 10]]);
    // The third addition has no partner, so the whole line is the mark.
    expect(adds[2]!.wordRanges).toEqual([]);
  });

  test("a line pair too large to diff by word is left to its whole-line mark", () => {
    const old = Array.from({ length: 3000 }, (_, i) => `t${i}`).join(" ");
    const next = Array.from({ length: 3000 }, (_, i) => `t${i + 1}`).join(" ");
    const started = Date.now();
    const [oldR, newR] = wordRangesFor(old, next);
    expect(oldR).toEqual([]);
    expect(newR).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("context lines are never painted", () => {
    const files = loadDegenerateFiles();
    for (const file of files) {
      if (!file.patch) continue;
      for (const hunk of parsePatch(file.patch, { ...CTX, path: file.filename })) {
        for (const line of hunk.lines) {
          if (line.kind === "ctx") expect(line.wordRanges).toEqual([]);
        }
      }
    }
  });

  test("ranges stay inside their line", () => {
    const files = loadDegenerateFiles();
    for (const file of files) {
      if (!file.patch) continue;
      for (const hunk of parsePatch(file.patch, { ...CTX, path: file.filename })) {
        for (const line of hunk.lines) {
          for (const [a, b] of line.wordRanges) {
            expect(a).toBeGreaterThanOrEqual(0);
            expect(b).toBeGreaterThanOrEqual(a);
            expect(b).toBeLessThanOrEqual(line.content.length);
          }
        }
      }
    }
  });
});

describe("whole pull requests", () => {
  test("a unified diff splits into per-file patches, keyed by path", () => {
    const map = splitUnifiedDiff(degenerateDiff());
    expect([...map.keys()]).toEqual(["src/too-large.ts", "src/gone.ts"]);
    expect(map.get("src/too-large.ts")!.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
  });

  test("a deleted line that looks like a diff header stays in the body", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,1 +1,1 @@",
      "--- old rule",
      "+++ new rule",
      "",
    ].join("\n");
    const patch = splitUnifiedDiff(diff).get("x.md")!;
    const [hunk] = parsePatch(patch, { ...CTX, path: "x.md" });
    expect(hunk!.lines.map((l) => l.content)).toEqual(["-- old rule", "++ new rule"]);
  });

  test("a file with no patch falls back to the pull request diff", async () => {
    const client = fakeGithubClient({ files: loadDegenerateFiles(), diff: degenerateDiff() });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    const large = result.files.find((f) => f.path === "src/too-large.ts")!;
    expect(large.missing).toBeNull();
    expect(large.hunks.length).toBe(1);
    expect(large.hunks[0]!.id).toBe("pr7:src/too-large.ts:@@1,3+1,4");
  });

  test("a file with no patch anywhere is a named error, never a silent drop", async () => {
    const client = fakeGithubClient({ files: loadDegenerateFiles(), diff: degenerateDiff() });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    expect(result.files.map((f) => f.path)).toContain("assets/logo.png");
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]!.code).toBe("missing_patch");
    expect(result.missing[0]!.path).toBe("assets/logo.png");
    expect(result.missing[0]!.reason.length).toBeGreaterThan(0);
    const entry = result.files.find((f) => f.path === "assets/logo.png")!;
    expect(entry.missing).toBe(result.missing[0]!);
    expect(entry.hunks).toEqual([]);
  });

  test("a pure rename carries no hunks and is not an error", async () => {
    const client = fakeGithubClient({ files: loadDegenerateFiles(), diff: degenerateDiff() });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    const moved = result.files.find((f) => f.path === "src/moved.ts")!;
    expect(moved.previousPath).toBe("src/moved-old.ts");
    expect(moved.hunks).toEqual([]);
    expect(moved.missing).toBeNull();
  });

  test("a renamed binary file is a named error, not a pure rename", async () => {
    // GitHub reports 0 additions and 0 deletions for binary content whether or not
    // the bytes changed, so only the diff can tell a move apart from a rewrite.
    const files: GithubFile[] = [
      {
        filename: "assets/mark.png",
        previous_filename: "assets/logo.png",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ];
    const diff = [
      "diff --git a/assets/logo.png b/assets/mark.png",
      "similarity index 68%",
      "rename from assets/logo.png",
      "rename to assets/mark.png",
      "index 3333333..4444444 100644",
      "Binary files a/assets/logo.png and b/assets/mark.png differ",
      "",
    ].join("\n");
    const result = await collectPullDiff(fakeGithubClient({ files, diff }), CTX.repo, CTX.prNumber, CTX.sha);
    expect(result.missing.map((m) => m.path)).toEqual(["assets/mark.png"]);
    expect(result.files[0]!.missing!.status).toBe("renamed");
    expect(result.files[0]!.hunks).toEqual([]);
  });

  test("a renamed text file with no content change stays a pure rename", async () => {
    const files: GithubFile[] = [
      {
        filename: "src/moved.ts",
        previous_filename: "src/moved-old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ];
    const diff = [
      "diff --git a/src/moved-old.ts b/src/moved.ts",
      "similarity index 100%",
      "rename from src/moved-old.ts",
      "rename to src/moved.ts",
      "",
    ].join("\n");
    const result = await collectPullDiff(fakeGithubClient({ files, diff }), CTX.repo, CTX.prNumber, CTX.sha);
    expect(result.missing).toEqual([]);
    expect(result.files[0]!.missing).toBeNull();
  });

  test("the pull request diff is fetched at most once", async () => {
    let diffCalls = 0;
    const client = fakeGithubClient({
      files: loadDegenerateFiles(),
      diff: degenerateDiff(),
      onDiff: () => {
        diffCalls++;
      },
    });
    await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    expect(diffCalls).toBe(1);
  });

  test("no diff is fetched when every file carries a patch", async () => {
    let diffCalls = 0;
    const files = loadDegenerateFiles().filter((f) => f.patch !== undefined);
    const client = fakeGithubClient({
      files,
      diff: degenerateDiff(),
      onDiff: () => {
        diffCalls++;
      },
    });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    expect(diffCalls).toBe(0);
    expect(result.missing).toEqual([]);
  });
});

// The invariant that makes every line number on the page trustworthy, checked over
// every recorded pull request and every hand-crafted degenerate case.
describe("invariants over every fixture", () => {
  const cases: { name: string; files: GithubFile[] }[] = [
    { name: "pr 2", files: loadFiles(2) },
    { name: "pr 3", files: loadFiles(3) },
    { name: "pr 4", files: loadFiles(4) },
    { name: "degenerate", files: loadDegenerateFiles() },
  ];

  function check(hunk: Hunk): void {
    // The facts Overseer owns rather than reads off the patch text. hunk.sha is the pin
    // every ref resolves against, so a blank one has to be a failure here.
    expect(hunk.repo).toBe(CTX.repo);
    expect(hunk.prNumber).toBe(CTX.prNumber);
    expect(hunk.sha).toBe(CTX.sha);
    expect(hunk.id.startsWith(`pr${CTX.prNumber}:${hunk.path}:@@`)).toBe(true);

    const ctx = hunk.lines.filter((l) => l.kind === "ctx").length;
    const del = hunk.lines.filter((l) => l.kind === "del").length;
    const add = hunk.lines.filter((l) => l.kind === "add").length;
    expect(hunk.oldLines).toBe(ctx + del);
    expect(hunk.newLines).toBe(ctx + add);

    let expectedOld = hunk.oldStart;
    let expectedNew = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        expect(line.oldNo).toBeNull();
        expect(line.newNo).toBe(expectedNew++);
      } else if (line.kind === "del") {
        expect(line.newNo).toBeNull();
        expect(line.oldNo).toBe(expectedOld++);
      } else {
        expect(line.oldNo).toBe(expectedOld++);
        expect(line.newNo).toBe(expectedNew++);
      }
    }
    expect(expectedOld).toBe(hunk.oldStart + hunk.oldLines);
    expect(expectedNew).toBe(hunk.newStart + hunk.newLines);
  }

  for (const { name, files } of cases) {
    test(`${name}: counts match the header and line numbers run contiguously`, () => {
      let seen = 0;
      for (const file of files) {
        if (!file.patch) continue;
        const hunks = parsePatch(file.patch, { ...CTX, path: file.filename });
        for (const hunk of hunks) {
          check(hunk);
          seen++;
        }
      }
      expect(seen).toBeGreaterThan(0);
    });

    test(`${name}: hunk ids are unique and stable`, () => {
      const ids: string[] = [];
      for (const file of files) {
        if (!file.patch) continue;
        for (const hunk of parsePatch(file.patch, { ...CTX, path: file.filename })) ids.push(hunk.id);
      }
      const again: string[] = [];
      for (const file of files) {
        if (!file.patch) continue;
        for (const hunk of parsePatch(file.patch, { ...CTX, path: file.filename })) again.push(hunk.id);
      }
      expect(again).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  test("hunks parsed through the fallback hold the same invariants", async () => {
    const client = fakeGithubClient({ files: loadDegenerateFiles(), diff: degenerateDiff() });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    let seen = 0;
    for (const file of result.files) {
      for (const hunk of file.hunks) {
        expect(hunk.path).toBe(file.path);
        check(hunk);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
    const large = result.files.find((f) => f.path === "src/too-large.ts")!;
    expect(large.hunks.length).toBe(1);
  });

  test("a file entry carries the counts GitHub reported", async () => {
    const files = loadDegenerateFiles();
    const client = fakeGithubClient({ files, diff: degenerateDiff() });
    const result = await collectPullDiff(client, CTX.repo, CTX.prNumber, CTX.sha);
    for (const file of files) {
      const entry = result.files.find((f) => f.path === file.filename)!;
      expect(entry.additions).toBe(file.additions);
      expect(entry.deletions).toBe(file.deletions);
      expect(entry.status).toBe(file.status);
    }
  });
});

describe("patches with nothing to parse", () => {
  test("patch text with no @@ header is a named failure, never zero hunks", () => {
    const combined = "@@@ -1,2 -1,2 +1,3 @@@\n  a\n++b\n";
    let error: unknown;
    try {
      parsePatch(combined, { ...CTX, path: "src/merged.ts" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DiffParseError);
    expect((error as DiffParseError).path).toBe("src/merged.ts");
    expect(parsePatch("", { ...CTX, path: "src/empty.ts" })).toEqual([]);
  });

  test("a mode-only change is reported as a mode change, not as binary content", async () => {
    const files: GithubFile[] = [
      { filename: "scripts/run.sh", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ];
    const diff = [
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const result = await collectPullDiff(fakeGithubClient({ files, diff }), CTX.repo, CTX.prNumber, CTX.sha);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]!.reason).toBe(
      "Only this file's mode changed, so the pull request diff carries no lines for it.",
    );
    expect(result.files[0]!.hunks).toEqual([]);
  });
});

describe("the pull request diff cannot be read", () => {
  test("a patchless file is reported, and the other files still derive", async () => {
    // GitHub refuses a whole-pull-request diff past twenty thousand lines, and it
    // omits per-file patches on exactly those large pull requests: the two conditions
    // arrive together. That refusal must cost the review only the files it could not
    // serve, never the sixty it could.
    const client = {
      listFiles: async () => [
        { filename: "src/small.ts", status: "modified", additions: 1, deletions: 1,
          patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
        { filename: "src/huge.ts", status: "added", additions: 9000, deletions: 0 },
      ],
      getPullDiff: async () => {
        throw new Error("GitHub 406 for .../pulls/5: the diff exceeded the maximum number of lines (20000)");
      },
    } as never;
    const out = await collectPullDiff(client, "a/b", 5, "f".repeat(40));
    expect(out.files).toHaveLength(2);
    expect(out.files[0]!.hunks).toHaveLength(1);
    expect(out.files[1]!.hunks).toHaveLength(0);
    expect(out.missing).toHaveLength(1);
    expect(out.missing[0]!.path).toBe("src/huge.ts");
    // The reason names the upstream failure rather than claiming the file was absent.
    expect(out.missing[0]!.reason).toContain("20000");
  });

  test("the failing diff is fetched once, however many files need it", async () => {
    let calls = 0;
    const client = {
      listFiles: async () => [
        { filename: "a.ts", status: "added", additions: 1, deletions: 0 },
        { filename: "b.ts", status: "added", additions: 1, deletions: 0 },
        { filename: "c.ts", status: "added", additions: 1, deletions: 0 },
      ],
      getPullDiff: async () => {
        calls++;
        throw new Error("too large");
      },
    } as never;
    const out = await collectPullDiff(client, "a/b", 5, "f".repeat(40));
    expect(calls).toBe(1);
    expect(out.missing).toHaveLength(3);
  });
});

describe("rebuilding a diff GitHub will not serve", () => {
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  function client(files: unknown[], blobs: Record<string, string>) {
    return {
      listFiles: async () => files,
      getPullDiff: async () => {
        throw new Error("simulated 406: the diff exceeded the maximum number of lines");
      },
      getFileAtSha: async (_repo: string, path: string, sha: string) => {
        const key = `${sha}:${path}`;
        if (!(key in blobs)) throw new GithubError("not found", 404, key);
        return blobs[key]!;
      },
    } as never;
  }

  test("an added file is rebuilt whole, with the id the patch path would have produced", async () => {
    const c = client(
      [{ filename: "src/new.ts", status: "added", additions: 3, deletions: 0 }],
      { [`${HEAD}:src/new.ts`]: "one\ntwo\nthree\n" },
    );
    const out = await collectPullDiff(c, "a/b", 5, HEAD, BASE);
    expect(out.missing).toHaveLength(0);
    const h = out.files[0]!.hunks[0]!;
    // An added file has no old side at all: `@@ -0,0 +1,3 @@`, not -1,1.
    expect(h.id).toBe("pr5:src/new.ts:@@0,0+1,3");
    expect(h.lines.map((l) => l.kind)).toEqual(["add", "add", "add"]);
    expect(h.lines.map((l) => l.content)).toEqual(["one", "two", "three"]);
    expect(h.lines.every((l) => l.oldNo === null)).toBe(true);
  });

  test("a modified file is rebuilt as a real diff, not two blobs", async () => {
    const c = client(
      [{ filename: "src/mod.ts", status: "modified", additions: 1, deletions: 1 }],
      {
        [`${BASE}:src/mod.ts`]: "keep\nold\ntail\n",
        [`${HEAD}:src/mod.ts`]: "keep\nnew\ntail\n",
      },
    );
    const out = await collectPullDiff(c, "a/b", 5, HEAD, BASE);
    const h = out.files[0]!.hunks[0]!;
    expect(h.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    // Word ranges are painted across the pair, as they are for any other hunk.
    expect(h.lines[1]!.wordRanges.length).toBeGreaterThan(0);
    // Both sides count, and the numbers are contiguous per side.
    expect(h.oldLines).toBe(3);
    expect(h.newLines).toBe(3);
  });

  test("a deleted file is rebuilt from its base side", async () => {
    const c = client(
      [{ filename: "src/gone.ts", status: "removed", additions: 0, deletions: 2 }],
      { [`${BASE}:src/gone.ts`]: "a\nb\n" },
    );
    const out = await collectPullDiff(c, "a/b", 5, HEAD, BASE);
    const h = out.files[0]!.hunks[0]!;
    expect(h.id).toBe("pr5:src/gone.ts:@@1,2+0,0");
    expect(h.lines.every((l) => l.kind === "del")).toBe(true);
  });

  test("a file too long to rebuild is reported rather than pulled into memory", async () => {
    const huge = Array.from({ length: 13_000 }, (_, i) => `line ${i}`).join("\n");
    const c = client(
      [{ filename: "pnpm-lock.yaml", status: "added", additions: 13_000, deletions: 0 }],
      { [`${HEAD}:pnpm-lock.yaml`]: huge },
    );
    const out = await collectPullDiff(c, "a/b", 5, HEAD, BASE);
    expect(out.files[0]!.hunks).toHaveLength(0);
    expect(out.missing).toHaveLength(1);
    expect(out.missing[0]!.reason).toContain("too long to rebuild");
  });

  test("a binary file is named as binary rather than rebuilt as text", async () => {
    const c = client(
      [{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }],
      { [`${HEAD}:logo.png`]: "PNG\u0000\u0000binary" },
    );
    const out = await collectPullDiff(c, "a/b", 5, HEAD, BASE);
    expect(out.files[0]!.hunks).toHaveLength(0);
    expect(out.missing[0]!.reason).toContain("binary");
  });

  test("without a base sha there is nothing to rebuild against, and it is reported", async () => {
    const c = client([{ filename: "src/new.ts", status: "added", additions: 1, deletions: 0 }], {});
    const out = await collectPullDiff(c, "a/b", 5, HEAD);
    expect(out.missing).toHaveLength(1);
    expect(out.files[0]!.hunks).toHaveLength(0);
  });
});
