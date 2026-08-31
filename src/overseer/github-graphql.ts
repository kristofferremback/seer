import { assertRepo, GithubError } from "./github";
import {
  GRAPHQL_IMPORT_DEADLINE_MS,
  GRAPHQL_READ_TIMEOUT_MS,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_COMMENTS_PER_THREAD,
  MAX_IMPORT_PAGES,
  MAX_IMPORT_REVIEWS,
  MAX_IMPORT_THREADS,
} from "./conversation-types";

export interface GithubReviewCommentObservation {
  databaseId: string;
  nodeId: string;
  authorLogin: string | null;
  body: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  commitSha: string | null;
  originalCommitSha: string | null;
}

export interface GithubReviewThread {
  nodeId: string;
  resolved: boolean;
  outdated: boolean;
  path: string | null;
  side: "old" | "new" | null;
  startLine: number | null;
  endLine: number | null;
  originalStartLine: number | null;
  originalEndLine: number | null;
  commitSha: string | null;
  originalCommitSha: string | null;
  url: string | null;
  comments: GithubReviewCommentObservation[];
}

export interface GithubReviewObservation {
  databaseId: string;
  nodeId: string;
  authorLogin: string | null;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body: string;
  url: string | null;
  commitSha: string | null;
  submittedAt: number | null;
  dismissed: boolean;
}

export interface GithubConversationSnapshot {
  threads: GithubReviewThread[];
  reviews: GithubReviewObservation[];
  complete: boolean;
  truncated: boolean;
  logicalBodyBytes: number;
}

export interface GithubGraphqlReader {
  listReviewThreads(repo: string, number: number): Promise<GithubConversationSnapshot>;
}

export interface GithubGraphqlOptions {
  token?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

const THREAD_QUERY = `query ReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved isOutdated path diffSide line startLine originalLine originalStartLine originalCommit{oid} comments(first:100){nodes{fullDatabaseId id author{login} body url createdAt updatedAt commit{oid} originalCommit{oid}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}`;
const REVIEW_QUERY = `query Reviews($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:100,after:$after){nodes{fullDatabaseId id author{login} state body url commit{oid} submittedAt dismissedAt} pageInfo{hasNextPage endCursor}}}}}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function integer(value: unknown): number | null { return Number.isInteger(value) ? value as number : null; }
function instant(value: unknown): number | null {
  if (value === null) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function databaseId(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
function oid(value: unknown): string | null {
  if (!record(value)) return null;
  const result = text(value.oid);
  return result && /^[0-9a-f]{40}$/i.test(result) ? result : null;
}
function state(value: unknown): GithubReviewObservation["state"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized === "approved" || normalized === "changes_requested" || normalized === "commented" || normalized === "dismissed" || normalized === "pending") return normalized;
  return null;
}

class ImportDeadlineReached extends Error {}

export function createGithubGraphqlReader(options: GithubGraphqlOptions = {}): GithubGraphqlReader {
  const base = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? GRAPHQL_READ_TIMEOUT_MS;
  const totalTimeout = options.totalTimeoutMs ?? GRAPHQL_IMPORT_DEADLINE_MS;

  async function rateLimited(message: string): Promise<never> {
    const { GithubRateLimitError } = await import("./github-app");
    throw new GithubRateLimitError(message);
  }

  async function request(query: string, variables: Record<string, unknown>, deadlineAt: number): Promise<Record<string, unknown>> {
    const url = `${base}/graphql`;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ImportDeadlineReached();
    const totalDeadlineOwnsTimeout = remaining <= timeout;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(timeout, remaining)));
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "overseer",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal,
      });
    } catch (error) {
      if (totalDeadlineOwnsTimeout && signal.aborted) throw new ImportDeadlineReached();
      throw new GithubError(`GitHub GraphQL request failed: ${String(error)}`, 0, url);
    }
    const raw = await response.text();
    if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit|secondary rate/i.test(raw)))) {
      return rateLimited(`GitHub GraphQL rate limit: ${raw.slice(0, 400)}`);
    }
    if (!response.ok) throw new GithubError(`GitHub GraphQL ${response.status}: ${raw.slice(0, 400)}`, response.status, url);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new GithubError("GitHub GraphQL returned malformed JSON.", 502, url); }
    if (!record(parsed)) throw new GithubError("GitHub GraphQL returned an invalid response.", 502, url);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const message = parsed.errors.map((error) => record(error) ? text(error.message) : null).filter(Boolean).join("; ").slice(0, 400);
      if (/rate limit|secondary rate/i.test(message)) return rateLimited(`GitHub GraphQL rate limit: ${message}`);
      throw new GithubError(`GitHub GraphQL refused the read: ${message || "unknown error"}`, 422, url);
    }
    if (!record(parsed.data)) throw new GithubError("GitHub GraphQL returned no data.", 502, url);
    return parsed.data;
  }

  return {
    async listReviewThreads(repo, number) {
      assertRepo(repo);
      if (!Number.isInteger(number) || number < 1) throw new GithubError("Malformed pull request number.", 0, "");
      const [owner, name] = repo.split("/") as [string, string];
      const threads: GithubReviewThread[] = [];
      const reviews: GithubReviewObservation[] = [];
      let logicalBodyBytes = 0;
      let truncated = false;
      let complete = true;
      let after: string | null = null;
      const deadlineAt = Date.now() + totalTimeout;
      const boundedRequest = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
        try {
          return await request(query, variables, deadlineAt);
        } catch (error) {
          if (!(error instanceof ImportDeadlineReached)) throw error;
          truncated = true;
          complete = false;
          return null;
        }
      };
      const deadlinePassed = (): boolean => {
        if (Date.now() < deadlineAt) return false;
        truncated = true;
        complete = false;
        return true;
      };

      for (let page = 0; page < MAX_IMPORT_PAGES; page++) {
        const data = await boundedRequest(THREAD_QUERY, { owner, name, number, after });
        if (!data) break;
        const repository = record(data.repository) ? data.repository : null;
        const pullRequest = repository && record(repository.pullRequest) ? repository.pullRequest : null;
        const connection = pullRequest?.reviewThreads;
        if (!record(connection) || !Array.isArray(connection.nodes) || !record(connection.pageInfo)) throw new GithubError("GitHub GraphQL returned malformed review threads.", 502, `${base}/graphql`);
        for (const rawThread of connection.nodes) {
          if (deadlinePassed() || !record(rawThread) || threads.length >= MAX_IMPORT_THREADS) { truncated = true; complete = false; break; }
          const comments = rawThread.comments;
          if (!record(comments) || !Array.isArray(comments.nodes) || !record(comments.pageInfo)) throw new GithubError("GitHub GraphQL returned malformed review comments.", 502, `${base}/graphql`);
          const parsedComments: GithubReviewCommentObservation[] = [];
          for (const rawComment of comments.nodes.slice(0, MAX_IMPORT_COMMENTS_PER_THREAD)) {
            if (deadlinePassed()) break;
            if (!record(rawComment)) throw new GithubError("GitHub GraphQL returned a malformed review comment.", 502, `${base}/graphql`);
            const dbId = databaseId(rawComment.fullDatabaseId);
            const nodeId = text(rawComment.id);
            const body = text(rawComment.body);
            const url = text(rawComment.url);
            const createdAt = instant(rawComment.createdAt);
            const updatedAt = instant(rawComment.updatedAt);
            if (!dbId || !nodeId || body === null || !url || createdAt === null || updatedAt === null) throw new GithubError("GitHub GraphQL returned an incomplete review comment.", 502, `${base}/graphql`);
            const bytes = Buffer.byteLength(body);
            if (logicalBodyBytes + bytes > MAX_IMPORT_BODY_BYTES) { truncated = true; complete = false; break; }
            logicalBodyBytes += bytes;
            parsedComments.push({ databaseId: dbId, nodeId, authorLogin: record(rawComment.author) ? text(rawComment.author.login) : null, body, url, createdAt, updatedAt, commitSha: oid(rawComment.commit), originalCommitSha: oid(rawComment.originalCommit) });
          }
          if (comments.pageInfo.hasNextPage === true || comments.nodes.length > MAX_IMPORT_COMMENTS_PER_THREAD) { truncated = true; complete = false; }
          const nodeId = text(rawThread.id);
          if (!nodeId || typeof rawThread.isResolved !== "boolean" || typeof rawThread.isOutdated !== "boolean") throw new GithubError("GitHub GraphQL returned an incomplete review thread.", 502, `${base}/graphql`);
          const side = rawThread.diffSide === "LEFT" ? "old" : rawThread.diffSide === "RIGHT" ? "new" : null;
          const current = integer(rawThread.line);
          const currentStart = integer(rawThread.startLine) ?? current;
          const original = integer(rawThread.originalLine);
          const originalStart = integer(rawThread.originalStartLine) ?? original;
          threads.push({ nodeId, resolved: rawThread.isResolved, outdated: rawThread.isOutdated, path: text(rawThread.path), side, startLine: currentStart, endLine: current, originalStartLine: originalStart, originalEndLine: original, commitSha: parsedComments.at(-1)?.commitSha ?? null, originalCommitSha: oid(rawThread.originalCommit) ?? parsedComments.at(-1)?.originalCommitSha ?? null, url: parsedComments[0]?.url ?? null, comments: parsedComments });
          if (truncated && logicalBodyBytes >= MAX_IMPORT_BODY_BYTES) break;
        }
        const more = connection.pageInfo.hasNextPage === true;
        after = text(connection.pageInfo.endCursor);
        if (!more) break;
        if (!after || page === MAX_IMPORT_PAGES - 1) { truncated = true; complete = false; break; }
      }

      after = null;
      for (let page = 0; page < MAX_IMPORT_PAGES && !deadlinePassed(); page++) {
        const data = await boundedRequest(REVIEW_QUERY, { owner, name, number, after });
        if (!data) break;
        const repository = record(data.repository) ? data.repository : null;
        const pullRequest = repository && record(repository.pullRequest) ? repository.pullRequest : null;
        const connection = pullRequest?.reviews;
        if (!record(connection) || !Array.isArray(connection.nodes) || !record(connection.pageInfo)) throw new GithubError("GitHub GraphQL returned malformed reviews.", 502, `${base}/graphql`);
        for (const rawReview of connection.nodes) {
          if (deadlinePassed() || !record(rawReview) || reviews.length >= MAX_IMPORT_REVIEWS) { truncated = true; complete = false; break; }
          const dbId = databaseId(rawReview.fullDatabaseId);
          const nodeId = text(rawReview.id);
          const body = text(rawReview.body) ?? "";
          const reviewState = state(rawReview.state);
          if (!dbId || !nodeId || !reviewState) throw new GithubError("GitHub GraphQL returned an incomplete review.", 502, `${base}/graphql`);
          const bytes = Buffer.byteLength(body);
          if (logicalBodyBytes + bytes > MAX_IMPORT_BODY_BYTES) { truncated = true; complete = false; break; }
          logicalBodyBytes += bytes;
          reviews.push({ databaseId: dbId, nodeId, authorLogin: record(rawReview.author) ? text(rawReview.author.login) : null, state: reviewState, body, url: text(rawReview.url), commitSha: oid(rawReview.commit), submittedAt: instant(rawReview.submittedAt), dismissed: rawReview.dismissedAt !== null });
        }
        const more = connection.pageInfo.hasNextPage === true;
        after = text(connection.pageInfo.endCursor);
        if (!more) break;
        if (!after || page === MAX_IMPORT_PAGES - 1) { truncated = true; complete = false; break; }
      }
      return { threads, reviews, complete: complete && !truncated, truncated, logicalBodyBytes };
    },
  };
}
