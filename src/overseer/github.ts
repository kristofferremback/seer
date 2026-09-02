// The GitHub side of the dividing line. Everything Overseer derives about a pull
// request comes through this client and nothing else, so the rest of Overseer never
// holds a token, never builds a URL, and never needs a network to be tested: the
// client is an interface with one fetch-backed implementation, built per workspace.
//
// Shapes below are the subset of the GitHub REST payloads Overseer actually reads.
// They are deliberately partial: recording a whole payload into a type buys nothing
// and rots on the next API change.

export interface GithubUser {
  login: string;
}

/** The repository a pull request sits on. `id` is the only stable identity it has:
 *  GitHub compares "owner/name" case-insensitively and a rename changes it outright. */
export interface GithubRepoRef {
  id: number;
  full_name: string;
}

export interface GithubPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  user: GithubUser | null;
  /** `repo` is absent on a head whose repository has been deleted, and names a
   *  DIFFERENT repository on a fork. Both are facts a same-repository review has to be
   *  able to see, which is why the typed shape carries it rather than dropping it. */
  head: { sha: string; ref: string; repo?: GithubRepoRef | null };
  /** `repo` is absent only on a pull request whose base repository is gone. */
  base: { sha: string; ref: string; repo?: GithubRepoRef | null };
  /** GitHub's own timestamp. Two observations of one pull request are ordered by this
   *  and by nothing else, since neither delivery order nor our clock is trustworthy. */
  updated_at: string;
}

export interface GithubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string | null; email: string | null } | null;
  };
  author: GithubUser | null;
}

/** A per-file entry from `GET /pulls/{n}/files`. `patch` is absent for binary or oversized files. */
export interface GithubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha?: string;
  previous_filename?: string;
  patch?: string;
}

export interface GithubRepository {
  id: number;
  full_name: string;
  default_branch: string;
}

export interface GithubRef {
  ref: string;
  sha: string;
  type: "commit";
}

export interface GithubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GithubTree {
  sha: string;
  truncated: boolean;
  tree: GithubTreeEntry[];
}

export interface GithubCompare {
  merge_base_commit: { sha: string };
  files: GithubFile[];
  total_commits?: number;
}

/**
 * One native GitHub stack, as `GET /repos/{owner}/{repo}/stacks?pull_request=N` answers it
 * under the `2026-03-10` API version. Entries are bottom-to-top as GitHub returned them.
 * The per-entry base ref is deliberately NOT here: it comes from Seer's own observation of
 * each pull request, never from the stack listing.
 */
export interface GithubPullStack {
  id: number;
  number: number;
  baseRef: string;
  open: boolean;
  pullRequests: {
    number: number;
    state: "open" | "closed";
    draft: boolean;
    mergedAt: string | null;
    headRef: string;
    headSha: string;
  }[];
}

export interface GithubReviewComment {
  id: number;
  path: string;
  body: string;
  user: GithubUser | null;
  commit_id: string;
  line: number | null;
  start_line: number | null;
  in_reply_to_id?: number;
  created_at: string;
}

/** `repo` is always "owner/name" throughout Overseer, as the data model states. */
export interface GithubClient {
  getPull(repo: string, number: number): Promise<GithubPull>;
  listCommits(repo: string, number: number): Promise<GithubCommit[]>;
  listFiles(repo: string, number: number): Promise<GithubFile[]>;
  listReviewComments(repo: string, number: number): Promise<GithubReviewComment[]>;
  /** The file's text at a pinned sha. Used to resolve ref snippets. */
  getFileAtSha(repo: string, path: string, sha: string): Promise<string>;
  /** The whole pull request as one unified diff. The fallback when `files[].patch` is absent. */
  getPullDiff(repo: string, number: number): Promise<string>;
  /** Stage capture capabilities. Optional keeps existing Overseer fakes source-compatible. */
  getRepository?(repo: string): Promise<GithubRepository>;
  getRef?(repo: string, ref: string): Promise<GithubRef>;
  getTree?(repo: string, sha: string, recursive?: boolean): Promise<GithubTree>;
  getBlobBytes?(repo: string, sha: string): Promise<Uint8Array>;
  compare?(repo: string, base: string, head: string): Promise<GithubCompare>;
  compareDiff?(repo: string, base: string, head: string): Promise<string>;
  /**
   * Which installation this client would route `repo` through, or null when none does
   * and the call would be refused.
   *
   * Optional because a client built from a bare token has no installation to name. It
   * exists because an observation of a pull request has to be attributed to the
   * installation it came through — `installation.deleted` finds its rows by that column
   * and by nothing else — and the routing answer lives inside the client, which is the
   * only place that knows it.
   */
  installationFor?(repo: string): Promise<number | null>;
  /** The native stack one pull request belongs to, or null when it is in none. Optional
   *  keeps existing fakes source-compatible; the stack path refuses a client without it. */
  getPullStack?(repo: string, pullRequest: number): Promise<GithubPullStack | null>;
}

/** Every failure out of this module is one of these, with the call site in the message. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

const API = "https://api.github.com";
const PER_PAGE = 100;
/** A pull request with more pages than this is a mistake, not a review. */
const MAX_PAGES = 20;

/**
 * An "owner/name" pair, in GitHub's own charset and nothing wider. `repo` is authored
 * outside this module, and a "?" or a "#" in it would end the path of the URL early:
 * `/repos/a/b#x/pulls/42` resolves to `/repos/a/b`, which answers 200 with a
 * repository object that nothing downstream would recognise as the wrong payload.
 */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function assertRepo(repo: string): void {
  const parts = repo.split("/");
  const bad =
    parts.length !== 2 ||
    parts.some((seg) => !REPO_SEGMENT.test(seg) || seg === "." || seg === "..");
  if (bad) {
    throw new GithubError(
      `Malformed repo ${JSON.stringify(repo)}: expected "owner/name" in [A-Za-z0-9._-].`,
      0,
      "",
    );
  }
}

function assertObjectId(sha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new GithubError(`Malformed Git object id ${JSON.stringify(sha)}.`, 0, "");
  }
}

export function assertRef(ref: string): void {
  if (
    ref.length === 0 || ref.length > 255 || ref.startsWith("/") || ref.endsWith("/") || ref.startsWith("-") || ref === "@" ||
    ref.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith(".") || part.endsWith(".lock")) ||
    ref.includes("..") || ref.includes("@{") || ref.endsWith(".") || ref.endsWith(".lock") ||
    /[\u0000-\u0020~^:?*\[\]\\]/.test(ref)
  ) throw new GithubError(`Malformed Git ref ${JSON.stringify(ref)}.`, 0, "");
}

/** A pull request number is interpolated raw into the URL, so it is a number or nothing. */
function assertNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new GithubError(
      `Malformed pull request number ${JSON.stringify(number)}: expected a positive integer.`,
      0,
      "",
    );
  }
}

/**
 * A file path inside a repository, and nothing else. Both `new URL()` and `new
 * Request()` collapse `..` away, so a path carrying one would fetch a different API
 * endpoint with the token attached. Paths are authored outside this module, so they
 * are checked here rather than trusted.
 */
export function assertPath(path: string): void {
  const bad =
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) {
    throw new GithubError(
      `Malformed path ${JSON.stringify(path)}: expected a repository-relative path with no empty, "." or ".." segments.`,
      0,
      "",
    );
  }
}

/**
 * A paging link comes back inside a response body's headers, so it is checked against
 * the configured API before the token is sent to it.
 */
function assertSameOrigin(url: string, base: string): void {
  let origin: string;
  let expected: string;
  try {
    origin = new URL(url).origin;
    expected = new URL(base).origin;
  } catch {
    throw new GithubError(`Unusable pagination link ${JSON.stringify(url)}.`, 0, url);
  }
  if (origin !== expected) {
    throw new GithubError(
      `Pagination link ${url} points at ${origin}, not ${expected}. Refusing to send the token.`,
      0,
      url,
    );
  }
}

export interface FetchGithubClientOptions {
  /** An installation token, minted for the call this client is about to make. */
  token?: string | undefined;
  /** Overridable for tests and for GitHub Enterprise. No trailing slash. */
  apiBase?: string;
  /** Overridable so a test can drive the transport without a socket. */
  fetchImpl?: typeof fetch;
  /** How long one request may take before it is abandoned. A stalled connection is a
   *  failed call here rather than a task that waits forever: callers on the read path
   *  are detached, so nothing would ever time them out from outside. */
  timeoutMs?: number;
}

/** Long enough for a slow paged response, short enough that a dead socket is noticed. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** The one implementation that talks to GitHub. */
export function createFetchGithubClient(options: FetchGithubClientOptions = {}): GithubClient {
  const base = (options.apiBase ?? API).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request(path: string, accept: string, apiVersion = "2022-11-28"): Promise<Response> {
    const url = path.startsWith("http") ? path : `${base}${path}`;
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": apiVersion,
      "User-Agent": "overseer",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      throw new GithubError(
        timedOut
          ? `GitHub did not answer ${url} within ${timeoutMs}ms.`
          : `GitHub request to ${url} failed: ${String(err)}`,
        0,
        url,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 400);
      throw new GithubError(`GitHub ${res.status} for ${url}: ${body}`, res.status, url);
    }
    return res;
  }

  async function json<T>(path: string, apiVersion?: string): Promise<T> {
    const res = await request(path, "application/vnd.github+json", apiVersion);
    return (await res.json()) as T;
  }

  function validObjectId(value: unknown, label: string, path: string): string {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
      throw new GithubError(`GitHub returned an invalid ${label} for ${base}${path}.`, 0, `${base}${path}`);
    }
    return value;
  }

  function validString(value: unknown, label: string, path: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new GithubError(`GitHub returned an invalid ${label} for ${base}${path}.`, 0, `${base}${path}`);
    }
    return value;
  }

  async function paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}?per_page=${PER_PAGE}`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res: Response = await request(next, "application/vnd.github+json");
      out.push(...((await res.json()) as T[]));
      next = nextLink(res.headers.get("Link"));
      if (next) assertSameOrigin(next, base);
    }
    // A truncated list is a lie about the pull request, so it is a failure instead.
    if (next) {
      throw new GithubError(
        `More than ${MAX_PAGES} pages of ${path} (${PER_PAGE} per page). Overseer will not review a partial list.`,
        0,
        next,
      );
    }
    return out;
  }

  return {
    async getPull(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      return json<GithubPull>(`/repos/${repo}/pulls/${number}`);
    },
    async getRepository(repo) {
      assertRepo(repo);
      const path = `/repos/${repo}`;
      const body = (await json<unknown>(path)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || !Number.isInteger(body.id) || (body.id as number) <= 0 || typeof body.full_name !== "string") {
        throw new GithubError(`GitHub returned an invalid repository for ${base}${path}.`, 0, `${base}${path}`);
      }
      const fullName = validString(body.full_name, "canonical repository name", path);
      try { assertRepo(fullName); } catch { throw new GithubError(`GitHub returned an invalid canonical repository name for ${base}${path}.`, 0, `${base}${path}`); }
      const defaultBranch = validString(body.default_branch, "default branch", path);
      assertRef(defaultBranch);
      return { id: body.id as number, full_name: fullName, default_branch: defaultBranch };
    },
    async getRef(repo, ref) {
      assertRepo(repo);
      assertRef(ref);
      const path = `/repos/${repo}/git/ref/heads/${encodeURIComponent(ref)}`;
      const body = (await json<unknown>(path)) as Record<string, unknown>;
      const object = body?.object as Record<string, unknown> | undefined;
      const sha = validObjectId(object?.sha, "ref object id", path);
      const returnedRef = validString(body?.ref, "ref name", path);
      if (returnedRef !== `refs/heads/${ref}` || (body?.object as Record<string, unknown> | undefined)?.type !== "commit") {
        throw new GithubError(`GitHub returned ${returnedRef} instead of refs/heads/${ref}.`, 0, `${base}${path}`);
      }
      return { ref: returnedRef, sha, type: "commit" };
    },
    async getTree(repo, sha, recursive = true) {
      assertRepo(repo);
      assertObjectId(sha);
      const path = `/repos/${repo}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`;
      const body = (await json<unknown>(path)) as Record<string, unknown>;
      if (!Array.isArray(body?.tree) || typeof body?.truncated !== "boolean") {
        throw new GithubError(`GitHub returned an invalid tree for ${base}${path}.`, 0, `${base}${path}`);
      }
      const tree: GithubTreeEntry[] = [];
      for (const raw of body.tree) {
        const entry = raw as Record<string, unknown>;
        if (
          typeof entry.path !== "string" || entry.path.length === 0 ||
          (() => { try { assertPath(entry.path as string); return false; } catch { return true; } })() ||
          typeof entry.mode !== "string" || !["blob", "tree", "commit"].includes(String(entry.type)) ||
          (entry.type === "blob" && (!["100644", "100755", "120000"].includes(entry.mode as string) || !Number.isInteger(entry.size) || (entry.size as number) < 0)) ||
          (entry.type === "tree" && entry.mode !== "040000") ||
          (entry.type === "commit" && entry.mode !== "160000") ||
          typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/i.test(entry.sha) ||
          (entry.size !== undefined && (!Number.isInteger(entry.size) || (entry.size as number) < 0))
        ) throw new GithubError(`GitHub returned an invalid tree entry for ${base}${path}.`, 0, `${base}${path}`);
        tree.push({ path: entry.path, mode: entry.mode, type: entry.type as GithubTreeEntry["type"], sha: entry.sha,
          ...(entry.size === undefined ? {} : { size: entry.size as number }) });
      }
      return { sha: validObjectId(body.sha ?? sha, "tree id", path), truncated: body.truncated as boolean, tree };
    },
    async getBlobBytes(repo, sha) {
      assertRepo(repo);
      assertObjectId(sha);
      const path = `/repos/${repo}/git/blobs/${sha}`;
      const body = (await json<unknown>(path)) as Record<string, unknown>;
      if (body?.encoding !== "base64" || typeof body.content !== "string" ||
          typeof body.sha !== "string" || !/^[0-9a-f]{40}$/i.test(body.sha) || body.sha.toLowerCase() !== sha.toLowerCase() ||
          !Number.isInteger(body.size) || (body.size as number) < 0 || (body.size as number) > 100 * 1024 * 1024) {
        throw new GithubError(`GitHub returned an invalid blob for ${base}${path}.`, 0, `${base}${path}`);
      }
      const compact = body.content.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
        throw new GithubError(`GitHub returned invalid base64 for ${base}${path}.`, 0, `${base}${path}`);
      }
      const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
      if (bytes.byteLength !== body.size) {
        throw new GithubError(`GitHub returned blob size ${bytes.byteLength}, expected ${body.size}, for ${base}${path}.`, 0, `${base}${path}`);
      }
      return bytes;
    },
    async compareDiff(repo, baseRef, headRef) {
      assertRepo(repo);
      assertObjectId(baseRef);
      assertObjectId(headRef);
      const path = `/repos/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`;
      const res = await request(path, "application/vnd.github.diff");
      return res.text();
    },
    async compare(repo, baseRef, headRef) {
      assertRepo(repo);
      assertRef(baseRef);
      assertRef(headRef);
      const path = `/repos/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`;
      const body = (await json<unknown>(path)) as Record<string, unknown>;
      const merge = body?.merge_base_commit as Record<string, unknown> | undefined;
      if (!merge || !Array.isArray(body?.files)) {
        throw new GithubError(`GitHub returned an invalid comparison for ${base}${path}.`, 0, `${base}${path}`);
      }
      const files: GithubFile[] = [];
      for (const raw of body.files) {
        const file = raw as Record<string, unknown>;
        if (typeof file.filename !== "string" || typeof file.status !== "string" ||
            !Number.isInteger(file.additions) || !Number.isInteger(file.deletions) || !Number.isInteger(file.changes)) {
          throw new GithubError(`GitHub returned an invalid comparison file for ${base}${path}.`, 0, `${base}${path}`);
        }
        try {
          assertPath(file.filename as string);
          if (file.previous_filename !== undefined) assertPath(file.previous_filename as string);
        } catch {
          throw new GithubError(`GitHub returned an invalid comparison path for ${base}${path}.`, 0, `${base}${path}`);
        }
        if (file.sha !== undefined) validObjectId(file.sha, "comparison file object id", path);
        if (file.patch !== undefined && typeof file.patch !== "string") {
          throw new GithubError(`GitHub returned an invalid patch for ${base}${path}.`, 0, `${base}${path}`);
        }
        files.push({ filename: file.filename, status: file.status, additions: file.additions as number,
          deletions: file.deletions as number, changes: file.changes as number,
          ...(file.sha === undefined ? {} : { sha: file.sha as string }),
          ...(file.previous_filename === undefined ? {} : { previous_filename: file.previous_filename as string }),
          ...(file.patch === undefined ? {} : { patch: file.patch as string }) });
      }
      return { merge_base_commit: { sha: validObjectId(merge.sha, "merge base object id", path) }, files,
        ...(Number.isInteger(body.total_commits) ? { total_commits: body.total_commits as number } : {}) };
    },
    async listCommits(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      return paged<GithubCommit>(`/repos/${repo}/pulls/${number}/commits`);
    },
    async listFiles(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      return paged<GithubFile>(`/repos/${repo}/pulls/${number}/files`);
    },
    async listReviewComments(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      return paged<GithubReviewComment>(`/repos/${repo}/pulls/${number}/comments`);
    },
    async getFileAtSha(repo, path, sha) {
      assertRepo(repo);
      assertPath(path);
      const res = await request(
        `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`,
        "application/vnd.github.raw",
      );
      return res.text();
    },
    async getPullDiff(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      const res = await request(`/repos/${repo}/pulls/${number}`, "application/vnd.github.diff");
      return res.text();
    },
    async getPullStack(repo, number) {
      assertRepo(repo);
      assertNumber(number);
      const path = `/repos/${repo}/stacks?pull_request=${number}&per_page=2`;
      const url = `${base}${path}`;
      const body = await json<unknown>(path, STACKS_API_VERSION);
      if (!Array.isArray(body)) throw new GithubError(`GitHub returned an invalid stack list for ${url}.`, 0, url);
      if (body.length === 0) return null;
      if (body.length > 1) throw new GithubError(`GitHub returned two stacks for one pull request at ${url}.`, 0, url);
      return parseGithubStack(body[0], url);
    },
  };
}

/** The API version the stack endpoints answer under. Every other call keeps 2022-11-28. */
export const STACKS_API_VERSION = "2026-03-10";
/** GitHub's own ceiling for one stack; a longer list is a malformed answer, not a stack. */
const MAX_STACK_ENTRIES = 100;

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Validate one stack payload field by field. Every stored fact here — ids, numbers, refs,
 *  SHAs — is written into an immutable manifest, so a string where a number belongs is a
 *  named refusal before anything is written. */
function parseGithubStack(raw: unknown, url: string): GithubPullStack {
  const invalid = (what: string): GithubError => new GithubError(`GitHub returned an invalid stack ${what} for ${url}.`, 0, url);
  const stack = raw as Record<string, unknown> | null;
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) throw invalid("payload");
  if (!positiveInteger(stack.id)) throw invalid("id");
  if (!positiveInteger(stack.number)) throw invalid("number");
  const base = stack.base as Record<string, unknown> | null | undefined;
  const baseRef = typeof stack.base_ref === "string" ? stack.base_ref : base?.ref;
  if (typeof baseRef !== "string") throw invalid("base ref");
  try { assertRef(baseRef); } catch { throw invalid("base ref"); }
  const state = stack.state;
  const open = state === undefined ? true : state === "open";
  if (state !== undefined && state !== "open" && state !== "closed") throw invalid("state");
  if (!Array.isArray(stack.pull_requests) || stack.pull_requests.length < 1 || stack.pull_requests.length > MAX_STACK_ENTRIES) {
    throw invalid("pull request list");
  }
  const numbers = new Set<number>();
  const pullRequests = stack.pull_requests.map((entry) => {
    const pull = entry as Record<string, unknown> | null;
    if (!pull || typeof pull !== "object") throw invalid("pull request entry");
    if (!positiveInteger(pull.number)) throw invalid("pull request number");
    if (numbers.has(pull.number)) throw invalid("pull request list: a number repeats");
    numbers.add(pull.number);
    if (pull.state !== "open" && pull.state !== "closed") throw invalid("pull request state");
    const mergedAt = pull.merged_at ?? null;
    if (mergedAt !== null && (typeof mergedAt !== "string" || !Number.isFinite(Date.parse(mergedAt)))) throw invalid("pull request merge time");
    const head = pull.head as Record<string, unknown> | null | undefined;
    const headRef = typeof pull.head_ref === "string" ? pull.head_ref : head?.ref;
    const headSha = typeof pull.head_sha === "string" ? pull.head_sha : head?.sha;
    if (typeof headRef !== "string") throw invalid("pull request head ref");
    try { assertRef(headRef); } catch { throw invalid("pull request head ref"); }
    if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) throw invalid("pull request head commit id");
    return { number: pull.number, state: pull.state as "open" | "closed", draft: pull.draft === true, mergedAt: mergedAt as string | null, headRef, headSha };
  });
  return { id: stack.id, number: stack.number, baseRef, open, pullRequests };
}

// ---- a pull request, checked rather than trusted ----

/**
 * One pull request with every field this codebase turns into a stored fact validated.
 *
 * `GithubPull` is a partial view of a payload, and reading it is fine for the legacy
 * derivation path, which re-derives everything from a diff. A promoted review is the
 * opposite: it writes the numeric repository ids, the refs and the SHAs into an immutable
 * row and then routes a capture through them, so a missing `head.repo` or a string where
 * a number belongs must be a named refusal before anything is written — not `undefined`
 * flowing into a URL.
 */
export interface ValidatedPull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** GitHub's own timestamp in milliseconds. */
  updatedAt: number;
  base: { ref: string; sha: string; repo: GithubRepoRef };
  head: { ref: string; sha: string; repo: GithubRepoRef };
}

/** A pull request title is stored and rendered, so it is bounded here rather than
 *  wherever it lands. GitHub's own limit is 256. */
export const PULL_TITLE_MAX = 256;

/**
 * A pull request payload this codebase cannot turn into stored facts.
 *
 * Its own class because it is the CALLER's problem and not the host's: a fork head, a
 * deleted head repository, an unknown state and an unparseable timestamp are all things
 * the person asking can see and act on, so they answer 422. A bare `GithubError` from the
 * same call path — a malformed compare response, a transport fault — is a genuine 502,
 * and blanket-mapping the two together would have an automated client either retry a call
 * that can never succeed or give up on one that would.
 */
export class GithubPullPayloadError extends GithubError {
  constructor(message: string) {
    super(message, 0, "");
    this.name = "GithubPullPayloadError";
  }
}

function pullRepoRef(value: unknown, label: string, where: string): GithubRepoRef {
  const repo = value as Record<string, unknown> | null | undefined;
  if (!repo || typeof repo !== "object" || !Number.isInteger(repo.id) || (repo.id as number) <= 0 ||
      typeof repo.full_name !== "string") {
    throw new GithubPullPayloadError(`GitHub returned no usable ${label} repository for ${where}.`);
  }
  try {
    assertRepo(repo.full_name);
  } catch {
    throw new GithubPullPayloadError(`GitHub returned an invalid ${label} repository name for ${where}.`);
  }
  return { id: repo.id as number, full_name: repo.full_name };
}

function pullSide(value: unknown, label: string, where: string): { ref: string; sha: string; repo: GithubRepoRef } {
  const side = value as Record<string, unknown> | null | undefined;
  if (!side || typeof side !== "object") {
    throw new GithubPullPayloadError(`GitHub returned no ${label} for ${where}.`);
  }
  if (typeof side.sha !== "string" || !/^[0-9a-f]{40}$/i.test(side.sha)) {
    throw new GithubPullPayloadError(`GitHub returned an invalid ${label} commit id for ${where}.`);
  }
  if (typeof side.ref !== "string") {
    throw new GithubPullPayloadError(`GitHub returned an invalid ${label} ref for ${where}.`);
  }
  try {
    assertRef(side.ref);
  } catch {
    throw new GithubPullPayloadError(`GitHub returned an invalid ${label} ref for ${where}.`);
  }
  return { ref: side.ref, sha: side.sha, repo: pullRepoRef(side.repo, label, where) };
}

export function parseGithubPull(raw: unknown, where: string): ValidatedPull {
  const pull = raw as Record<string, unknown> | null | undefined;
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) {
    throw new GithubPullPayloadError(`GitHub returned no pull request for ${where}.`);
  }
  if (!Number.isInteger(pull.number) || (pull.number as number) <= 0) {
    throw new GithubPullPayloadError(`GitHub returned an invalid pull request number for ${where}.`);
  }
  if (typeof pull.title !== "string" || pull.title.length === 0 || pull.title.length > PULL_TITLE_MAX) {
    throw new GithubPullPayloadError(`GitHub returned an invalid pull request title for ${where}.`);
  }
  if (pull.state !== "open" && pull.state !== "closed") {
    throw new GithubPullPayloadError(`GitHub returned an unknown pull request state for ${where}.`);
  }
  const updatedAt = typeof pull.updated_at === "string" ? Date.parse(pull.updated_at) : NaN;
  if (!Number.isFinite(updatedAt)) {
    throw new GithubPullPayloadError(`GitHub returned an invalid pull request update time for ${where}.`);
  }
  return {
    number: pull.number as number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged === true,
    draft: pull.draft === true,
    updatedAt,
    base: pullSide(pull.base, "base", where),
    head: pullSide(pull.head, "head", where),
  };
}

/** The `rel="next"` URL out of a Link header, or null when this was the last page. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

// The process-global client, and the lazy default that built one from GITHUB_TOKEN,
// used to live here. Both are gone: a client is built for a workspace, out of the
// installation that workspace holds, so `githubClientFor()` in `github-app.ts` is the
// only way to get one and the seam tests install is a factory rather than an instance.
// A default client here would be exactly the confused deputy the App exists to remove.
