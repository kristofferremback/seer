// The code around a hunk: a range of the file the hunk came out of, at the commit the
// hunk counts against.
//
// A hunk is a window with three lines of sill. Read in a column that is fine, because
// the walkthrough's job is to say what changed and in what order; read full screen it
// is not, because the reader who went full screen went there to see the change sitting
// inside something. This route is what the panel fills that in from.
//
// Three things make it safe to serve at all.
//
// The gate is the review's, not a new one. `resolveFor` is the same function the page
// and the attachment bytes go through, and every refusal is `softNotFound()` from the
// read path — the same status, the same content type, the same bytes — so a slug in
// another workspace, a signed-out browser, a version that does not exist and a file
// this review never touched are one answer rather than four.
//
// The document is the allow-list. A request names a path and a sha, and the pair has
// to be one a hunk of the version being read actually carries. Without that check the
// route reads any file in any repository the workspace holds an installation for,
// which is a far larger thing than a review. With it, the only files reachable are the
// ones this review already put on the page — and a hunk in a stored document is proof
// the derivation fetched that pull request through this workspace's own installation,
// which is what makes reading the rest of the file at that sha an expansion of what
// the reader was already shown rather than a new entitlement.
//
// The file has to agree with the hunk. A hunk's unchanged and added lines are lines of
// the new file at known numbers; if the fetched file does not have those exact lines
// there, something drifted, and stitching them together anyway would show a reader a
// file that never existed. That is worse than showing no context at all, so the route
// refuses instead.
//
// What comes back is rendered HTML, one string per line, through the same `codeHtml`
// the hunks go through. One tokenizer, on the server, and the markup the panel inserts
// is the markup the page already carries.

import { getSnippet, getReviewVersion, listAnnotations, putSnippet, type ReviewDoc } from "./db";
import { GithubError } from "./github";
import { GithubAppRefusal, GithubCredentialDeadError, githubClientFor } from "./github-app";
import { askingUserId, resolveFor, softNotFound, versionNumber } from "./read";
import { contextLines, langOfPath } from "./render-diff";
import type { Evidence, Hunk, Ref } from "./types";

/** The bytes of one file, and how much of it may be asked for at a time. The cache
 *  cap is the ref resolver's, named again rather than shared: the two paths write the
 *  same table and a file too big for one is too big for the other. */
const MAX_CACHED_BYTES = 512 * 1024;
/** A file past this is not read at all. Nothing on the far side of it is a file a
 *  person is reading around a hunk, and holding it to slice forty lines out of it is
 *  a cost every request would pay again. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The most lines one request may ask for. The panel asks for tens; this is the bound
 *  that stops a hand-written URL asking for a hundred thousand. */
const MAX_RANGE_LINES = 600;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Why there is no context, for the one line the panel prints in place of it. The
 *  reader is told which kind of nothing this is, because "the sha is gone" and "this
 *  file is too long" are different facts about their review. */
type Refusal = "unreachable" | "too-long" | "drifted";

const WHY: Record<Refusal, string> = {
  unreachable: "GitHub would not serve this file at this commit.",
  "too-long": "This file is too long to read around the change.",
  drifted: "This file no longer matches the hunks recorded for it.",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** A refusal the panel can say something about, as opposed to the soft-404, which it
 *  cannot. 200 rather than an error status: nothing went wrong with the request, and
 *  the answer is a fact about the file. */
function noContext(why: Refusal): Response {
  return json({ context: null, why: WHY[why] });
}

/** A trailing newline terminates the last line rather than starting an empty one,
 *  which is the rule the diff parser uses and therefore the rule the hunks' line
 *  numbers were minted under. */
export function fileLines(content: string): string[] {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.length === 0 ? [] : body.split("\n");
}

/**
 * Whether the file the fetch returned is the file the hunks were cut from.
 *
 * Only the new side can be checked, because only the new side is what was fetched: a
 * hunk's unchanged and added lines are lines of the file at the numbers the parser
 * wrote down. A deletion has no new-side line and is skipped, and a hunk that adds a
 * file has nothing before it to disagree with.
 */
export function hunksAgree(hunks: Hunk[], lines: string[]): boolean {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newNo === null) continue;
      if (line.newNo < 1 || line.newNo > lines.length) return false;
      if (lines[line.newNo - 1] !== line.content) return false;
    }
  }
  return true;
}

/** A positive integer in a query string, or null for anything else. */
function count(raw: string | null): number | null {
  if (raw === null || !/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * GET {basePath}/c?path=&sha=&from=&to=[&v=]
 *
 * `v` names the version whose document is the allow-list, because that is the version
 * whose hunks are on the page asking. Absent, it is the current one.
 */
export async function handleReviewContext(
  req: Request,
  slug: string,
  wsId: string | null = null,
): Promise<Response> {
  const review = resolveFor(req, slug, wsId);
  if (!review) return softNotFound();
  return contextRange(
    review.workspace_id,
    slug,
    review.latest_version,
    new URL(req.url),
    askingUserId(req),
  );
}

// There is no share route here, and the omission is the decision.
//
// A share hands a review to somebody outside the workspace, and what it hands over is
// the review: the prose, and the hunks the walkthrough drew. The whole of every file
// those hunks touch is a larger thing, and not one the person who minted the link
// agreed to — links already in the wild would have widened under a change made quietly
// here. So `/s/<token>/c` matches nothing on the share path and gets the soft-404 every
// other unknown tail gets, and the shared page does not draw the loader at all: the
// panel there is the panel that shipped, hunks and no gaps, rather than one that
// reaches for something and is told no.

async function contextRange(
  ws: string,
  slug: string,
  latest: number,
  url: URL,
  asker: string | undefined,
): Promise<Response> {
  const rawVersion = url.searchParams.get("v");
  const version = rawVersion === null ? latest : versionNumber(rawVersion);
  if (version === null || version > latest) return softNotFound();
  const row = getReviewVersion(ws, slug, version);
  if (!row) return softNotFound();

  const path = url.searchParams.get("path");
  const sha = (url.searchParams.get("sha") ?? "").toLowerCase();
  const from = count(url.searchParams.get("from"));
  const to = count(url.searchParams.get("to"));
  if (path === null || path === "" || !FULL_SHA.test(sha)) return softNotFound();
  if (from === null || to === null || to < from) return softNotFound();
  if (to - from + 1 > MAX_RANGE_LINES) return softNotFound();

  // The allow-list: this exact file, at this exact commit, as some hunk or some ref of
  // this version records it. A pair the document does not name is not a smaller mistake
  // than a slug in another workspace, and it does not get a smaller answer.
  const hunks = hunksOf(row.doc, path, sha);
  const refs = refsAt(refsOf(row.doc, listAnnotations(ws, slug)), path, sha);
  if (hunks.length === 0 && refs.length === 0) return softNotFound();
  const repo = hunks[0]?.repo ?? refs[0]!.repo;

  const client = githubClientFor(ws, asker);

  // Whether the cache may be read at all.
  //
  // `ref_snippets` has no workspace column, because the same (repo, sha, path) is the
  // same bytes for everyone. That makes it a shared cache of private source, and the
  // ref resolver refuses exactly this shortcut on purpose: its `proven` set starts
  // empty and opens only after a fetch this caller was actually allowed to make,
  // because it too is rebuilt from a stored document and a document is evidence of
  // what a workspace could read once rather than of what it can read now.
  //
  // This route is the same shape, so it asks the same question in the cheapest form
  // there is: does this workspace still hold an installation covering the repository?
  // That is a routing lookup and a membership read, both already cached, against
  // current state rather than against the document. When the answer is no, the cache
  // stays shut and the read pays a real fetch, which will refuse on its own if the
  // workspace has no other way in. Nothing is served that GitHub was not asked about.
  let allowed = false;
  if (client.installationFor) {
    try {
      allowed = (await client.installationFor(repo)) !== null;
    } catch {
      allowed = false;
    }
  }

  let content = allowed ? getSnippet(repo, sha, path) : null;
  if (content === null) {
    try {
      content = await client.getFileAtSha(repo, path, sha);
    } catch (err) {
      // Every way GitHub can decline is the same fact to the reader: the file is not
      // there to read. A refusal by the App router and a dead credential are named
      // here so they are not mistaken for a bug and rethrown.
      if (
        err instanceof GithubError ||
        err instanceof GithubAppRefusal ||
        err instanceof GithubCredentialDeadError
      ) {
        return noContext("unreachable");
      }
      throw err;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) return noContext("too-long");
    // Between the two caps a file is served and never kept, which is the ref
    // resolver's trade as well: one table, one size it is willing to hold.
    if (bytes <= MAX_CACHED_BYTES) putSnippet(repo, sha, path, content);
  } else if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return noContext("too-long");
  }

  const lines = fileLines(content);
  if (!hunksAgree(hunks, lines) || !refsAgree(refs, lines)) return noContext("drifted");

  // Asked past the end is not an error: the panel asks for a window around a hunk
  // before it knows how long the file is, and the answer to "give me twenty lines
  // after the last one" is the ones that exist and the total.
  const start = Math.min(from, lines.length + 1);
  const end = Math.min(to, lines.length);
  const slice = end < start ? [] : lines.slice(start - 1, end);
  return json({
    path,
    sha,
    total: lines.length,
    from: start,
    to: start + slice.length - 1,
    lines: contextLines(start, slice, langOfPath(path)),
  });
}

/** The document's hunks for one file at one commit. */
function hunksOf(doc: ReviewDoc, path: string, sha: string): Hunk[] {
  return doc.hunks.filter((h) => h.path === path && h.sha.toLowerCase() === sha);
}

/**
 * Every ref the page draws, wherever on it they are drawn.
 *
 * A hunk is not the only code a review puts on screen. A statement quotes lines, a note
 * quotes lines, the code design quotes lines for each module and each coverage path,
 * and an answer to a question quotes lines. Each of those is a code surface wearing the
 * same full-screen control as a file diff, so each has the same claim on the file
 * around it: one control, one thing it does.
 *
 * A ref also carries its own resolution — the workspace fetched those exact lines at
 * that exact sha when the review was published — so a ref in a stored document is the
 * same kind of evidence a hunk is, and it opens the same door and no wider.
 */
export function refsOf(doc: ReviewDoc, annotations: { answer: { refs: Ref[] } | null }[]): Ref[] {
  const out: Ref[] = [];
  const evidence = (list: Evidence[]) => {
    for (const e of list) if (e.type === "ref") out.push(e.ref);
  };
  for (const s of doc.statements) {
    out.push(...s.refs);
    evidence(s.evidence);
  }
  for (const n of doc.notes) {
    out.push(...n.refs);
    evidence(n.evidence);
  }
  if (doc.codeDesign) {
    for (const m of doc.codeDesign.modules) out.push(...m.refs);
    for (const c of doc.codeDesign.coverage) out.push(...c.refs);
  }
  // An answer's refs are on the page beside the question, and they are not in the
  // document: an annotation belongs to the review rather than to a version.
  for (const a of annotations) if (a.answer) out.push(...a.answer.refs);
  return out;
}

function refsAt(refs: Ref[], path: string, sha: string): Ref[] {
  return refs.filter((r) => r.path === path && r.sha.toLowerCase() === sha);
}

/**
 * Whether the file the fetch returned still says what the refs quoted from it.
 *
 * A ref's snippet is the copy the page is already showing, so it is exactly the
 * evidence that the file being laid out around it is the same file. If it is not, the
 * panel would put a reader's mark on lines the statement never quoted, which is the
 * quiet kind of wrong this refuses rather than ships.
 */
export function refsAgree(refs: Ref[], lines: string[]): boolean {
  for (const ref of refs) {
    if (ref.startLine < 1 || ref.endLine > lines.length) return false;
    if (lines.slice(ref.startLine - 1, ref.endLine).join("\n") !== ref.snippet) return false;
  }
  return true;
}
