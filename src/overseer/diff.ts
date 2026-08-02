// The diff side of the dividing line. GitHub hands back a per-file `patch` in
// unified format; this turns it into the hunk entity the data model describes, with
// every line number derived here rather than authored anywhere. A hunk id is a
// deterministic function of the pull request, the path and the `@@` range, so the
// same diff parsed twice produces the same ids and a group can point at a hunk
// without a database round trip.
//
// Word ranges are computed here too, because the renderer should not have to think.
// Within a hunk, a run of deletions immediately followed by a run of additions is a
// rewrite, and its lines pair positionally: the first deleted line against the first
// added line, and so on. Each pair is diffed by an LCS over its words, and the runs
// of words that differ become character ranges into `content`. Lines with no partner
// keep no ranges: the whole line is already marked added or deleted, and painting it
// a second time says nothing.

import type { GithubClient, GithubFile } from "./github";
import type { Hunk, HunkLine, HunkLineKind } from "./types";

/** Everything a hunk needs that the patch text does not carry. */
export interface HunkContext {
  repo: string;
  prNumber: number;
  path: string;
  /** The head sha of the pull request: the sha the new side of every hunk lives at. */
  sha: string;
}

/** A malformed patch is a loud failure, never a partial parse. */
export class DiffParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "DiffParseError";
  }
}

/**
 * A file GitHub described but did not give us a diff for: binary, too large, or
 * absent from the unified diff as well. Never dropped, always reported.
 */
export interface MissingPatch {
  code: "missing_patch";
  path: string;
  status: string;
  reason: string;
}

export interface FileDiff {
  path: string;
  /** The old path when this file was renamed, null otherwise. */
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** Set when the file carries no diff at all. `hunks` is then empty. */
  missing: MissingPatch | null;
}

export interface PullDiff {
  files: FileDiff[];
  /** The same MissingPatch objects the affected files carry, gathered for reporting. */
  missing: MissingPatch[];
}

/** `pr<number>:<path>:@@<old_start>,<old_lines>+<new_start>,<new_lines>` */
export function hunkId(
  prNumber: number,
  path: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  return `pr${prNumber}:${path}:@@${oldStart},${oldLines}+${newStart},${newLines}`;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one file's unified patch text into hunks. */
export function parsePatch(patch: string, ctx: HunkContext): Hunk[] {
  const hunks: Hunk[] = [];
  // A trailing newline in the patch is a terminator, not an empty final line.
  const raw = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  const lines = raw.length === 0 ? [] : raw.split("\n");

  let current: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      if (current) finish(current, ctx.path);
      const oldStart = Number(header[1]);
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      current = {
        id: hunkId(ctx.prNumber, ctx.path, oldStart, oldLines, newStart, newLines),
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        path: ctx.path,
        sha: ctx.sha,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }

    if (!current) {
      // Everything before the first @@ is the file header (--- / +++ / index / mode).
      continue;
    }

    // "\ No newline at end of file" annotates the line above it. It is not a line of
    // either side, so it is consumed and counted nowhere.
    if (line.startsWith("\\")) continue;

    const marker = line.length === 0 ? " " : line[0]!;
    const content = line.length === 0 ? "" : line.slice(1);
    if (marker === "+") {
      current.lines.push(mkLine("add", null, newNo++, content));
    } else if (marker === "-") {
      current.lines.push(mkLine("del", oldNo++, null, content));
    } else if (marker === " ") {
      current.lines.push(mkLine("ctx", oldNo++, newNo++, content));
    } else {
      throw new DiffParseError(
        `Unrecognized diff line in ${ctx.path}: ${JSON.stringify(line.slice(0, 60))}`,
        ctx.path,
      );
    }
  }
  if (current) finish(current, ctx.path);
  return hunks;
}

function mkLine(kind: HunkLineKind, oldNo: number | null, newNo: number | null, content: string): HunkLine {
  return { kind, oldNo, newNo, content, wordRanges: [] };
}

/** Check the hunk against its own header, then paint the word ranges. */
function finish(hunk: Hunk, path: string): void {
  let oldCount = 0;
  let newCount = 0;
  for (const line of hunk.lines) {
    if (line.kind !== "add") oldCount++;
    if (line.kind !== "del") newCount++;
  }
  if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) {
    throw new DiffParseError(
      `Hunk ${hunk.id} claims -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} ` +
        `but carries ${oldCount} old and ${newCount} new lines.`,
      path,
    );
  }
  paintWordRanges(hunk);
}

// ---- word ranges ----

type Token = { text: string; start: number; end: number };

/** Words are runs of non-whitespace; whitespace is a separator and never a token. */
export function words(s: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

type Op = { t: "=" | "-" | "+"; i: number; j: number };

/** Longest common subsequence over two token strings, as a flat op list. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j]
          ? dp[at(i + 1, j + 1)]! + 1
          : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "=", i, j });
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) {
      ops.push({ t: "-", i, j });
      i++;
    } else {
      ops.push({ t: "+", i, j });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", i: i++, j });
  while (j < m) ops.push({ t: "+", i, j: j++ });
  return ops;
}

/**
 * The changed character ranges of one deleted line against one added line, as
 * [oldRanges, newRanges]. A run of words present on one side only still yields a
 * collapsed range on the other, so the renderer can mark where the text went in.
 */
export function wordRangesFor(oldText: string, newText: string): [[number, number][], [number, number][]] {
  const a = words(oldText);
  const b = words(newText);
  const ops = lcsOps(
    a.map((t) => t.text),
    b.map((t) => t.text),
  );
  const oldRanges: [number, number][] = [];
  const newRanges: [number, number][] = [];

  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === "=") {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && ops[k]!.t !== "=") k++;
    const run = ops.slice(start, k);
    const dels = run.filter((o) => o.t === "-");
    const adds = run.filter((o) => o.t === "+");
    pushRange(oldRanges, a, dels.map((o) => o.i), run[0]!.i, oldText.length);
    pushRange(newRanges, b, adds.map((o) => o.j), run[0]!.j, newText.length);
  }
  return [oldRanges, newRanges];
}

function pushRange(
  out: [number, number][],
  toks: Token[],
  idx: number[],
  anchor: number,
  eol: number,
): void {
  if (idx.length === 0) {
    // Nothing changed on this side: mark the seam, at the word the run sits before.
    const at = toks[anchor]?.start ?? eol;
    out.push([at, at]);
    return;
  }
  const first = toks[idx[0]!]!;
  const last = toks[idx[idx.length - 1]!]!;
  out.push([first.start, last.end]);
}

/** Pair each del run with the add run that follows it, line for line, and paint. */
function paintWordRanges(hunk: Hunk): void {
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d]!.kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a]!.kind === "add") a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const del = dels[p]!;
      const add = adds[p]!;
      const [oldRanges, newRanges] = wordRangesFor(del.content, add.content);
      del.wordRanges = oldRanges;
      add.wordRanges = newRanges;
    }
    i = a > d ? a : d;
  }
}

// ---- whole pull requests ----

/**
 * Split a whole-pull-request unified diff into per-file patch text, keyed by the new
 * path (the old path for a deletion, which is the only name such a file has).
 */
export function splitUnifiedDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = diff.split("\n");
  let path: string | null = null;
  let oldPath: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const name = path ?? oldPath;
    if (name && body.length) out.set(name, body.join("\n"));
    path = null;
    oldPath = null;
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      continue;
    }
    // Only before the first @@ are `---` and `+++` headers. After it they are diff
    // content: a deleted line reading "-- still here" starts with "--- " too.
    if (body.length === 0 && line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      continue;
    }
    if (body.length === 0 && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@") || body.length) body.push(line);
  }
  flush();
  return out;
}

/**
 * Every file of a pull request, as hunks. Files GitHub sent without a `patch` are
 * retried against the whole-pull-request diff, and anything still without one comes
 * back as a named MissingPatch on the file and in `missing`. Nothing is dropped.
 */
export async function collectPullDiff(
  client: GithubClient,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<PullDiff> {
  const files = await client.listFiles(repo, prNumber);
  let fallback: Map<string, string> | null = null;

  const out: FileDiff[] = [];
  const missing: MissingPatch[] = [];

  for (const file of files) {
    let patch = file.patch;
    if (patch === undefined) {
      fallback ??= splitUnifiedDiff(await client.getPullDiff(repo, prNumber));
      patch = fallback.get(file.filename);
    }
    const entry: FileDiff = {
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      hunks: [],
      missing: null,
    };
    if (patch === undefined && file.status === "renamed" && file.additions === 0 && file.deletions === 0) {
      // A pure rename: no patch because no content changed. Nothing is missing, so
      // nothing is reported. A binary file is also 0/0, which is why the status is
      // part of the test: `modified` with no patch is always an error.
    } else if (patch === undefined) {
      entry.missing = {
        code: "missing_patch",
        path: file.filename,
        status: file.status,
        reason:
          "GitHub returned no patch for this file and it is absent from the pull request diff " +
          "(binary content, or a diff too large to serve).",
      };
      missing.push(entry.missing);
    } else {
      entry.hunks = parsePatch(patch, { repo, prNumber, path: file.filename, sha: headSha });
    }
    out.push(entry);
  }
  return { files: out, missing };
}

/** The hunks of a single GitHub file entry, for callers that already have one. */
export function hunksOfFile(file: GithubFile, ctx: Omit<HunkContext, "path">): Hunk[] {
  if (file.patch === undefined) return [];
  return parsePatch(file.patch, { ...ctx, path: file.filename });
}
