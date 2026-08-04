// The derived half of the review document. The skill hands Overseer pointers, a repo
// and a number per pull request, and everything else on the fact side of the dividing
// line is computed here: titles, shas, refs, the shape of the stack, the code behind
// every ref, and whether that code is inside the change or outside it.
//
// Nothing in this module talks to GitHub directly. It takes a GithubClient, so a test
// drives it with a fake and the whole derivation runs without a socket. File contents
// go through the (repo, sha, path) snippet cache from step 3, which can never go stale
// because refs are SHA-pinned, so resolving the same file twice costs one fetch. That
// pinning is enforced here rather than assumed: a ref whose sha is not a full sha is
// refused before anything is fetched or cached under it.

import { getSnippet, putSnippet, sweepSnippets } from "./db";
import { collectPullDiff, type FileDiff } from "./diff";
import { GithubError, type GithubClient } from "./github";
import {
  prKey,
  type Hunk,
  type Ref,
  type RefOrigin,
  type RefPointer,
  type ReviewComment,
  type ReviewKind,
  type StatementKind,
} from "./types";

// Both live in types.ts: the skill's ref pointer and the pull-request key are read by
// the pure validator too, which cannot import this module.
export { prKey, type RefPointer };

/** What the skill authors about a pull request before anything is derived. */
export interface PrPointer {
  /** "owner/name". */
  repo: string;
  number: number;
  /** Used only when `base_ref` does not name another pull request in the review. */
  parent?: number | null;
}

/** One review comment, kept for the skill and never rendered. See the data model's
 *  "Rendering comment threads" entry: discussion informs the briefing, and if a
 *  comment matters the skill says so in a statement or a note. Defined in types.ts,
 *  because it is a field of the stored document, and re-exported under its name here. */
export type SkillContextComment = ReviewComment;

/** Everything Overseer derives about one pull request. The authored fields (`gist`,
 *  `detail`, `detail_ref`) are merged in by the publish path, not here. */
export interface DerivedPr {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  /** The pull request's own head branch. Kept because it is what another pull
   *  request's `base_ref` names when the two are stacked. */
  headRef: string;
  parent: number | null;
  /** Null when the account is gone, which is a visible absence rather than a blank name. */
  author: string | null;
  coAuthors: string[];
  body: string;
  files: FileDiff[];
}

/** Every hunk of a pull request, in file order. Derived from `files` rather than stored
 *  beside it, so a publish path that filters files cannot leave the two disagreeing. */
export function hunksOf(pr: { files: FileDiff[] }): Hunk[] {
  return pr.files.flatMap((f) => f.hunks);
}

export interface DerivedReview {
  kind: ReviewKind;
  prs: DerivedPr[];
  /** Review comments across every pull request, in pointer order. Never rendered.
   *  Destination: `Review.skillContext` on the stored document, so it travels inside
   *  `review_versions.doc` and no column is added for it. The skill reads it back on
   *  the next pass through the published document, which is why it is derived once at
   *  publish rather than re-derived on every read. */
  skillContext: SkillContextComment[];
}

// ---- co-authors ----

// Trailers are matched on their own line, case-insensitively, which is how git itself
// treats trailer tokens. The value is kept verbatim as GitHub holds it, so a name
// keeps its capitalisation, while deduplication is by lowercased email: the same
// person committing as "Ada <A@Example.com>" and "ada <a@example.com>" is one
// co-author, and the first spelling seen is the one that survives.
//
// The scan is narrowed the way git narrows it: only the message's last paragraph, and
// only lines that start with the token, with no indent. co_authors[] is what tells a
// reader an agent was in the commit, so a trailer sitting in an indented block in the
// body does not become a fact on the page. That is the whole rule: a trailer written
// flush left in the last paragraph counts, wherever it came from, which matches git's
// own heuristic and means a fenced example in the last paragraph would still count.
const COAUTHOR = /^co-authored-by:[ \t]*(.+?)[ \t]*$/gim;

function trailerBlock(message: string): string {
  // Line endings are normalised first: a CRLF message would otherwise be one long
  // paragraph, losing the last-paragraph narrowing, and every trailer would carry a
  // trailing carriage return into the co-author string.
  const body = message.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const paragraphs = body.split(/\n[ \t]*\n/);
  return paragraphs[paragraphs.length - 1] ?? "";
}

function coAuthorKey(trailer: string): string {
  const email = /<([^>]*)>/.exec(trailer)?.[1];
  return (email ?? trailer).trim().toLowerCase();
}

/** Co-Authored-By trailers across a pull request's commit messages, deduplicated. */
export function coAuthorsOf(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    for (const match of trailerBlock(message).matchAll(COAUTHOR)) {
      const trailer = match[1]!.trim();
      if (!trailer) continue;
      const key = coAuthorKey(trailer);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trailer);
    }
  }
  return out;
}

// ---- stack shape ----

/**
 * `parent` per the data model: derived from `base_ref` when it names another pull
 * request in the review, else the authored value. Only pull requests in the same
 * repository can be stacked, because a branch name means nothing across repositories.
 */
function deriveParents(
  prs: { repo: string; number: number; baseRef: string; headRef: string; authored: number | null }[],
): (number | null)[] {
  const byBranch = new Map<string, number>();
  for (const pr of prs) byBranch.set(`${pr.repo}:${pr.headRef}`, pr.number);
  return prs.map((pr) => {
    const found = byBranch.get(`${pr.repo}:${pr.baseRef}`);
    if (found !== undefined && found !== pr.number) return found;
    return pr.authored;
  });
}

/**
 * `kind` per the data model: one pull request is `single`, several where each is the
 * base of the next is `stack`, anything else is `set`.
 *
 * A stack is a single chain: exactly one root, every other pull request parented on a
 * distinct pull request in the review, and no cycle. Two pull requests sharing a
 * parent is a fan, not a chain, so it is a `set`; so is a rebase that moves one of
 * them off the chain, which is exactly what the shape is meant to catch.
 */
export function deriveReviewKind(
  prs: { repo: string; number: number; parent: number | null }[],
): ReviewKind {
  if (prs.length <= 1) return "single";
  const present = new Set(prs.map((p) => prKey(p.repo, p.number)));
  const roots = prs.filter(
    (p) => p.parent === null || !present.has(prKey(p.repo, p.parent)),
  );
  if (roots.length !== 1) return "set";
  const children = new Map<string, string>();
  for (const p of prs) {
    if (p.parent === null) continue;
    const key = prKey(p.repo, p.parent);
    if (!present.has(key)) continue;
    children.set(key, prKey(p.repo, p.number));
  }
  // Walk the chain from the root: a stack visits every pull request exactly once. A fan
  // needs no separate check, because one of its branches is dropped from `children` and
  // the walk then falls short of every pull request. The repeat-visit guard below is
  // belt and braces: a cycle has no root and leaves by the `roots.length !== 1` return
  // before the walk begins.
  let cursor = prKey(roots[0]!.repo, roots[0]!.number);
  const walked = new Set<string>([cursor]);
  for (;;) {
    const next = children.get(cursor);
    if (next === undefined) break;
    if (walked.has(next)) return "set";
    walked.add(next);
    cursor = next;
  }
  return walked.size === prs.length ? "stack" : "set";
}

// ---- derivation ----

/** The authored pointers themselves are wrong: none of them, or the same pull request
 *  twice. These are the only failures of derivePrs() that belong to the caller, and
 *  they are thrown before any request goes out. Everything else out of this function
 *  came off the network and is Overseer's problem, never the skill's. */
export class PrPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrPointerError";
  }
}

/**
 * Derive the fact half of a review from its authored pointers. One pass per pull
 * request: the pull request itself, its commits, its diff, and its review comments.
 */
export async function derivePrs(
  client: GithubClient,
  pointers: PrPointer[],
): Promise<DerivedReview> {
  if (pointers.length === 0) {
    throw new PrPointerError("A review needs at least one pull request.");
  }
  // The same pull request twice would duplicate its hunk ids, which the publish path
  // needs unique, and would look like two roots to the shape derivation.
  const pointed = new Set<string>();
  for (const pointer of pointers) {
    const key = prKey(pointer.repo, pointer.number);
    if (pointed.has(key)) {
      throw new PrPointerError(`A review names ${key} more than once.`);
    }
    pointed.add(key);
  }
  const partial: (Omit<DerivedPr, "parent"> & { authored: number | null })[] = [];
  const skillContext: SkillContextComment[] = [];

  for (const pointer of pointers) {
    const pull = await client.getPull(pointer.repo, pointer.number);
    const commits = await client.listCommits(pointer.repo, pointer.number);
    const diff = await collectPullDiff(
      client,
      pointer.repo,
      pointer.number,
      pull.head.sha,
      pull.base.sha,
    );
    const comments = await client.listReviewComments(pointer.repo, pointer.number);
    for (const comment of comments) {
      skillContext.push({
        repo: pointer.repo,
        prNumber: pointer.number,
        id: comment.id,
        path: comment.path,
        line: comment.line,
        startLine: comment.start_line,
        body: comment.body,
        author: comment.user?.login ?? null,
        commitId: comment.commit_id,
        inReplyTo: comment.in_reply_to_id ?? null,
        createdAt: comment.created_at,
      });
    }
    partial.push({
      repo: pointer.repo,
      number: pointer.number,
      title: pull.title,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
      authored: pointer.parent ?? null,
      author: pull.user?.login ?? null,
      coAuthors: coAuthorsOf(commits.map((c) => c.commit.message)),
      body: pull.body ?? "",
      files: diff.files,
    });
  }

  const parents = deriveParents(partial);
  const prs: DerivedPr[] = partial.map(({ authored: _authored, ...pr }, i) => ({
    ...pr,
    parent: parents[i]!,
  }));
  return { kind: deriveReviewKind(prs), prs, skillContext };
}

// ---- refs ----

/** A ref that does not resolve is a 422 naming the path and the range, per the data
 *  model's write-path rules. The fields are on the error so the route never has to
 *  parse a message back apart. */
export class RefResolveError extends Error {
  readonly code = "ref_unresolved";
  /** The GitHub status behind this failure, when there was one. A 404 is a ref that
   *  genuinely does not resolve; a 401, a 403 or a 5xx is Overseer's own problem, and
   *  telling the skill its ref is bad would make it rewrite a correct ref. A 0 is a
   *  pointer the client refused before any request went out, a malformed repo, path or
   *  number, and null is a pointer this module refused the same way, a sha that is not
   *  a full sha or a range that is not a range. Both are the skill's fault and a 422,
   *  the same as a 404, so only a non-zero status other than 404 is Overseer's. The
   *  route reads this rather than answering 422 for everything. */
  readonly status: number | null;
  constructor(
    message: string,
    readonly repo: string,
    readonly sha: string,
    readonly path: string,
    readonly startLine: number,
    readonly endLine: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RefResolveError";
    this.status = cause instanceof GithubError ? cause.status : null;
  }
}

/** A full commit sha and nothing else. The snippet cache keys on (repo, sha, path) with
 *  no expiry short enough to matter, which is only sound while the sha names one
 *  immutable tree: a branch name, a tag or an abbreviated sha would freeze whatever the
 *  first fetch happened to see and serve it to every later reader. So a ref that is not
 *  SHA-pinned is refused rather than cached. Case is folded, because GitHub answers to
 *  either and two spellings of one sha must not become two rows. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

function refRange(pointer: RefPointer): string {
  return `${pointer.path}:${pointer.startLine}-${pointer.endLine}`;
}

/** The paths a review touches, per repo and sha, for `origin`. A rename counts under
 *  both of its names: the ref may point at either side of it. */
function touchedIndex(prs: DerivedPr[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (repo: string, sha: string, path: string) => {
    // Lowercased on the way in, because lookups lowercase the pointer's sha: GitHub
    // answers to either spelling and the two sides must not be able to disagree.
    const key = `${repo}@${sha.toLowerCase()}`;
    let set = index.get(key);
    if (!set) index.set(key, (set = new Set<string>()));
    set.add(path);
  };
  for (const pr of prs) {
    for (const file of pr.files) {
      // Both shas of the pull request: a ref at the head sha shows the changed file,
      // one at the base sha shows what it looked like before, and both are inside the
      // change. Any other sha is a pointer at code this review does not carry.
      add(pr.repo, pr.headSha, file.path);
      add(pr.repo, pr.baseSha, file.path);
      if (file.previousPath) {
        add(pr.repo, pr.headSha, file.previousPath);
        add(pr.repo, pr.baseSha, file.previousPath);
      }
    }
  }
  return index;
}

/** `origin` per the data model: `in_stack` iff that path at that sha is touched by
 *  some pull request in the review. Derived, never authored: getting it wrong is a lie
 *  about the shape of the change. */
export function deriveOrigin(prs: DerivedPr[], pointer: RefPointer): RefOrigin {
  return originIn(touchedIndex(prs), pointer);
}

function originIn(touched: Map<string, Set<string>>, pointer: RefPointer): RefOrigin {
  return touched.get(`${pointer.repo}@${pointer.sha.toLowerCase()}`)?.has(pointer.path)
    ? "in_stack"
    : "outside";
}

/** Resolves refs against one review: shared touched-path index, shared file cache. */
export interface RefResolver {
  resolve(pointer: RefPointer): Promise<Ref>;
}

/** Files above this are never cached: they are fetched for the resolve that needs them
 *  and dropped, so a second resolve of one pays a second fetch. A lockfile or a
 *  generated bundle would otherwise sit in the shared table forever, and no useful ref
 *  points at thousands of lines of it. */
const MAX_CACHED_BYTES = 512 * 1024;
/** Cached bytes are SHA-pinned, so they never go stale; they only go unwanted. A row
 *  nothing has re-fetched in this long is from a review no one is reading. */
const SNIPPET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Evict cached files older than the time to live, and answer how many rows went.
 *  Called explicitly, by the publish path or a timer: building a resolver must not
 *  quietly delete rows out of a table shared with every other reader. */
export function sweepSnippetCache(now = Date.now()): number {
  return sweepSnippets(now - SNIPPET_TTL_MS);
}

export function refResolver(client: GithubClient, review: DerivedReview): RefResolver {
  const touched = touchedIndex(review.prs);

  // ref_snippets has no workspace column: the same (repo, sha, path) is the same bytes
  // for everyone, which makes it a shared cache of private source. The gate below is
  // per-derivation, against the server's single GitHub token: the cache opens for a
  // repository only once this derivation has actually fetched from it, so a publish
  // body naming an unrelated (repo, sha, path) pays a real fetch rather than being
  // served cached bytes with no GitHub call at all. It is not a per-caller check and
  // proves nothing about who is publishing; there is one process-global token today,
  // and if per-workspace tokens ever arrive this gate has to be rebuilt around them.
  //
  // The set starts EMPTY, and the only thing that puts a repository in it is a
  // successful fetch below. It used to be seeded from `review.prs`, which made the
  // sentence above false: a review's own repositories opened the cache having fetched
  // nothing, because deriving a pull request reads pulls, files and commits and never
  // reads file contents at all. That mattered most where the review is not a live
  // derivation but a stored document — `annotations.ts` rebuilds a resolver from a
  // published doc to answer a question, so `proven` was seeded from what the document
  // claimed rather than from anything this caller had been allowed to read, and a ref
  // into one of those repositories was served private bytes with no GitHub call to
  // check it. The cost of the fix is one fetch per repository per resolver; the first
  // ref pays it and every later ref is still free.
  const proven = new Set<string>();

  async function fileAt(pointer: RefPointer): Promise<string> {
    if (proven.has(pointer.repo)) {
      const cached = getSnippet(pointer.repo, pointer.sha, pointer.path);
      if (cached !== null) return cached;
    }
    let content: string;
    try {
      content = await client.getFileAtSha(pointer.repo, pointer.path, pointer.sha);
    } catch (err) {
      throw new RefResolveError(
        `Ref ${refRange(pointer)} at ${pointer.sha} does not resolve in ${pointer.repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        pointer.repo,
        pointer.sha,
        pointer.path,
        pointer.startLine,
        pointer.endLine,
        err,
      );
    }
    proven.add(pointer.repo);
    if (Buffer.byteLength(content, "utf8") <= MAX_CACHED_BYTES) {
      putSnippet(pointer.repo, pointer.sha, pointer.path, content);
    }
    return content;
  }

  return {
    async resolve(authored) {
      const { startLine, endLine } = authored;
      if (!FULL_SHA.test(authored.sha)) {
        throw new RefResolveError(
          `Ref ${refRange(authored)} names ${authored.sha}, which is not a commit sha: a ref is pinned to a full 40 character sha.`,
          authored.repo,
          authored.sha,
          authored.path,
          startLine,
          endLine,
        );
      }
      const pointer: RefPointer = { ...authored, sha: authored.sha.toLowerCase() };
      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
      ) {
        throw new RefResolveError(
          `Ref ${refRange(pointer)} is not a line range: expected 1 <= start_line <= end_line.`,
          pointer.repo,
          pointer.sha,
          pointer.path,
          startLine,
          endLine,
        );
      }
      // A highlight the snippet cannot show is line-number drift, which is the one
      // thing the write path exists to catch. Dropping it quietly would leave the ref
      // looking right and pointing at nothing.
      const highlight = pointer.highlight ?? [];
      const stray = highlight.find((n) => n < startLine || n > endLine);
      if (stray !== undefined) {
        throw new RefResolveError(
          `Ref ${refRange(pointer)} highlights line ${stray}, which is outside its range.`,
          pointer.repo,
          pointer.sha,
          pointer.path,
          startLine,
          endLine,
        );
      }
      const content = await fileAt(pointer);
      // A trailing newline terminates the last line rather than starting an empty one,
      // which is the same rule the diff parser uses.
      const body = content.endsWith("\n") ? content.slice(0, -1) : content;
      const lines = body.length === 0 ? [] : body.split("\n");
      if (endLine > lines.length) {
        throw new RefResolveError(
          `Ref ${refRange(pointer)} runs past the end of ${pointer.path} at ${pointer.sha}, which has ${lines.length} lines.`,
          pointer.repo,
          pointer.sha,
          pointer.path,
          startLine,
          endLine,
        );
      }
      return {
        id: pointer.id ?? `${pointer.repo}@${pointer.sha}:${refRange(pointer)}`,
        repo: pointer.repo,
        sha: pointer.sha,
        path: pointer.path,
        startLine,
        endLine,
        highlight,
        origin: originIn(touched, pointer),
        snippet: lines.slice(startLine - 1, endLine).join("\n"),
      };
    },
  };
}

// ---- derived kinds on a pull request card ----

const KIND_ORDER: StatementKind[] = ["add", "change", "remove"];

/**
 * `pr.kinds[]` per the data model: the distinct kinds of the statements attributed to
 * this pull request, so the marks on a card are provably tied to real claims. A pure
 * function of the document, reused verbatim at publish.
 */
export function kindsForPr(
  statements: { kind: StatementKind; prs: string[] }[],
  key: string,
): StatementKind[] {
  const found = new Set<StatementKind>();
  for (const s of statements) if (s.prs.includes(key)) found.add(s.kind);
  return KIND_ORDER.filter((k) => found.has(k));
}
