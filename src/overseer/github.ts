// The GitHub side of the dividing line. Everything Overseer derives about a pull
// request comes through this client and nothing else, so the rest of Overseer never
// holds a token, never builds a URL, and never needs a network to be tested: the
// client is an interface with one fetch-backed implementation and an injection seam.
//
// Shapes below are the subset of the GitHub REST payloads Overseer actually reads.
// They are deliberately partial: recording a whole payload into a type buys nothing
// and rots on the next API change.

import { config } from "../config";

export interface GithubUser {
  login: string;
}

export interface GithubPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  user: GithubUser | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
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

function assertRepo(repo: string): void {
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
function assertPath(path: string): void {
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
  /** A personal access token. Absent, only public repositories resolve. */
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

  async function request(path: string, accept: string): Promise<Response> {
    const url = path.startsWith("http") ? path : `${base}${path}`;
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
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

  async function json<T>(path: string): Promise<T> {
    const res = await request(path, "application/vnd.github+json");
    return (await res.json()) as T;
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

// ---- the injection seam ----
//
// Overseer code calls githubClient(); tests call setGithubClient() with a fake. The
// default is built lazily so that importing this module never requires a token.

let injected: GithubClient | null = null;
let lazyDefault: GithubClient | null = null;

export function githubClient(): GithubClient {
  if (injected) return injected;
  lazyDefault ??= createFetchGithubClient({ token: config.githubToken });
  return lazyDefault;
}

export function setGithubClient(client: GithubClient | null): void {
  injected = client;
}
