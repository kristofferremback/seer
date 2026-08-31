import { db } from "../db";
import { assertRepo, GithubError } from "./github";
import {
  getGithubUserCredential,
  markGithubUserCredentialDead,
  openGithubUserCredential,
  touchGithubUserCredential,
} from "./user-credentials";
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

// ---- explicit personal mutations ----

export interface GraphqlRate {
  limit: number;
  cost: number;
  remaining: number;
  resetAt: number;
  used: number;
}

export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export interface DraftReviewThread {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

export interface RecoveryMatch {
  repo: string;
  number: number;
  commitOID: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  createdAt: number;
  thread?: DraftReviewThread;
}

export type RecoveryResult =
  | { kind: "none" }
  | { kind: "ambiguous"; matches: number }
  | { kind: "match"; reviewId: string; commentNodeId: string | null; threadId: string | null };

export interface PersonalGithubGraphqlClient {
  pullRequest(repo: string, number: number): Promise<{
    id: string;
    headRefOid: string;
    files: { path: string; viewerViewedState: FileViewedState }[];
    filesTruncated: boolean;
    rate: GraphqlRate;
  }>;
  markFileAsViewed(pullRequestId: string, path: string, clientMutationId: string): Promise<void>;
  unmarkFileAsViewed(pullRequestId: string, path: string, clientMutationId: string): Promise<void>;
  addReview(input: {
    pullRequestId: string;
    commitOID: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string;
    threads: DraftReviewThread[];
    clientMutationId: string;
  }): Promise<{ reviewId: string; commentNodeIds: string[] }>;
  addThreadReply(threadId: string, body: string, clientMutationId: string): Promise<{
    commentNodeId: string;
    databaseId: string | null;
  }>;
  resolveThread(threadId: string, clientMutationId: string): Promise<void>;
  unresolveThread(threadId: string, clientMutationId: string): Promise<void>;
  findReviewThreadByComment(repo: string, number: number, commentNodeId: string): Promise<string | null>;
  recoverReview(input: RecoveryMatch): Promise<RecoveryResult>;
}

export class GithubGraphqlPermissionError extends Error {
  readonly code = "permission_refused";
  constructor(message = "GitHub refused this personal mutation.") {
    super(message);
    this.name = "GithubGraphqlPermissionError";
  }
}

export class GithubGraphqlTransportError extends Error {
  readonly code = "transport_failed";
  constructor(message: string, readonly mayHaveLeftProcess: boolean) {
    super(message);
    this.name = "GithubGraphqlTransportError";
  }
}

export class GithubGraphqlShapeError extends Error {
  readonly code = "response_invalid";
  constructor(message: string) {
    super(message);
    this.name = "GithubGraphqlShapeError";
  }
}

export class GithubGraphqlTargetError extends Error {
  readonly code = "target_missing";
  constructor(message: string) {
    super(message);
    this.name = "GithubGraphqlTargetError";
  }
}

export interface GraphqlTransportOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface GraphqlResponse {
  data: Record<string, unknown>;
  headers: Headers;
}

const PERSONAL_PULL_REQUEST_QUERY = `query PersonalPullRequest($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid files(first:100,after:$after){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}} rateLimit{limit cost remaining resetAt used}}`;
const REVIEW_THREAD_QUERY = `query PersonalReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id comments(first:100){nodes{id}}} pageInfo{hasNextPage endCursor}}}} rateLimit{limit cost remaining resetAt used}}`;
const RECOVER_REVIEW_QUERY = `query RecoverPersonalReview($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(last:100){nodes{id state body submittedAt author{login} commit{oid} comments(first:100){nodes{id body path line startLine diffSide pullRequestReviewThread{id}}}}}}} rateLimit{limit cost remaining resetAt used}}`;
const MARK_FILE_MUTATION = `mutation MarkFileAsViewed($input:MarkFileAsViewedInput!){markFileAsViewed(input:$input){clientMutationId}}`;
const UNMARK_FILE_MUTATION = `mutation UnmarkFileAsViewed($input:UnmarkFileAsViewedInput!){unmarkFileAsViewed(input:$input){clientMutationId}}`;
const ADD_REVIEW_MUTATION = `mutation AddPullRequestReview($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id comments(first:100){nodes{id}}} clientMutationId}}`;
const ADD_REPLY_MUTATION = `mutation AddPullRequestReviewThreadReply($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id fullDatabaseId} clientMutationId}}`;
const RESOLVE_THREAD_MUTATION = `mutation ResolveReviewThread($input:ResolveReviewThreadInput!){resolveReviewThread(input:$input){clientMutationId}}`;
const UNRESOLVE_THREAD_MUTATION = `mutation UnresolveReviewThread($input:UnresolveReviewThreadInput!){unresolveReviewThread(input:$input){clientMutationId}}`;

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!record(value)) throw new GithubGraphqlShapeError(message);
  return value;
}

function requiredText(value: unknown, message: string): string {
  const result = text(value);
  if (!result) throw new GithubGraphqlShapeError(message);
  return result;
}

function retryAtFrom(headers: Headers, now: number): number | null {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
    const instant = Date.parse(retry);
    if (Number.isFinite(instant)) return instant;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? reset * 1_000 : null;
}

function safeGraphqlMessage(errors: unknown): string {
  if (!Array.isArray(errors)) return "unknown error";
  return errors.map((error) => record(error) ? text(error.message) : null).filter(Boolean).join("; ").slice(0, 500) || "unknown error";
}

function errorKinds(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error) => {
    if (!record(error)) return [];
    const type = text(error.type) ?? (record(error.extensions) ? text(error.extensions.type) ?? text(error.extensions.code) : null);
    return type ? [type.toUpperCase()] : [];
  });
}

function parseRate(value: unknown): GraphqlRate {
  const row = requiredRecord(value, "GitHub GraphQL returned no rate limit reading.");
  const limit = integer(row.limit), cost = integer(row.cost), remaining = integer(row.remaining), used = integer(row.used);
  const resetAt = instant(row.resetAt);
  if (limit === null || cost === null || remaining === null || used === null || resetAt === null) {
    throw new GithubGraphqlShapeError("GitHub GraphQL returned an invalid rate limit reading.");
  }
  return { limit, cost, remaining, resetAt, used };
}

function headerInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function recordQueryRate(userId: string, credentialId: string, rate: GraphqlRate, now: number): void {
  db.run(
    "INSERT INTO github_graphql_rate_limits (credential_id, user_id, limit_value, used_value, remaining_value, last_cost, reset_at, retry_after, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(credential_id) DO UPDATE SET user_id=excluded.user_id, limit_value=excluded.limit_value, used_value=excluded.used_value, remaining_value=excluded.remaining_value, last_cost=excluded.last_cost, reset_at=excluded.reset_at, retry_after=excluded.retry_after, observed_at=excluded.observed_at",
    [credentialId, userId, rate.limit, rate.used, rate.remaining, rate.cost, rate.resetAt, rate.remaining === 0 ? rate.resetAt : null, now],
  );
}

function recordMutationRate(userId: string, credentialId: string, headers: Headers, now: number): void {
  const limit = headerInteger(headers, "x-ratelimit-limit");
  const used = headerInteger(headers, "x-ratelimit-used");
  const remaining = headerInteger(headers, "x-ratelimit-remaining");
  const resetSeconds = headerInteger(headers, "x-ratelimit-reset");
  const reset = resetSeconds === null ? null : resetSeconds * 1_000;
  const retry = retryAtFrom(headers, now);
  db.run(
    "INSERT INTO github_graphql_rate_limits (credential_id, user_id, limit_value, used_value, remaining_value, last_cost, reset_at, retry_after, observed_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) " +
      "ON CONFLICT(credential_id) DO UPDATE SET user_id=excluded.user_id, limit_value=COALESCE(excluded.limit_value,github_graphql_rate_limits.limit_value), used_value=COALESCE(excluded.used_value,github_graphql_rate_limits.used_value), remaining_value=COALESCE(excluded.remaining_value,github_graphql_rate_limits.remaining_value), reset_at=COALESCE(excluded.reset_at,github_graphql_rate_limits.reset_at), retry_after=excluded.retry_after, observed_at=excluded.observed_at",
    [credentialId, userId, limit, used, remaining, reset, retry, now],
  );
}

function personalClient(
  userId: string,
  credentialId: string,
  token: string,
  options: GraphqlTransportOptions,
): PersonalGithubGraphqlClient {
  const base = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? GRAPHQL_READ_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  async function request(query: string, variables: Record<string, unknown>, mutation: boolean): Promise<GraphqlResponse> {
    const url = `${base}/graphql`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "overseer",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new GithubGraphqlTransportError(`GitHub GraphQL request failed: ${String(error)}`.slice(0, 600), mutation);
    }
    if (mutation) recordMutationRate(userId, credentialId, response.headers, now());
    const raw = await response.text();
    if (response.status === 401) {
      const { GithubCredentialDeadError } = await import("./github-app");
      markGithubUserCredentialDead(credentialId, userId, now());
      throw new GithubCredentialDeadError(credentialId, "GitHub refused this credential. Reconnect it in settings before retrying.");
    }
    const retryAt = retryAtFrom(response.headers, now());
    if (response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0" || /rate limit|secondary rate|abuse detection/i.test(raw)))) {
      const { GithubRateLimitError } = await import("./github-app");
      throw new GithubRateLimitError("GitHub rate-limited this personal mutation.", retryAt);
    }
    if (response.status === 403) throw new GithubGraphqlPermissionError("GitHub refused permission for this personal mutation.");
    if (!response.ok) throw new GithubGraphqlTransportError(`GitHub GraphQL ${response.status}: ${raw.slice(0, 500)}`, mutation);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new GithubGraphqlShapeError("GitHub GraphQL returned malformed JSON."); }
    if (!record(parsed)) throw new GithubGraphqlShapeError("GitHub GraphQL returned an invalid response.");
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const message = safeGraphqlMessage(parsed.errors);
      const kinds = errorKinds(parsed.errors);
      if (kinds.some((kind) => kind.includes("RATE_LIMIT")) || /rate limit|secondary rate/i.test(message)) {
        const { GithubRateLimitError } = await import("./github-app");
        throw new GithubRateLimitError(`GitHub rate-limited this personal mutation: ${message}`, retryAt);
      }
      if (kinds.some((kind) => kind === "NOT_FOUND")) {
        throw new GithubGraphqlTargetError(`GitHub no longer exposes the exact target: ${message}`);
      }
      if (kinds.some((kind) => kind === "FORBIDDEN" || kind === "UNAUTHORIZED") || /permission|not authorized|forbidden/i.test(message)) {
        throw new GithubGraphqlPermissionError(`GitHub refused permission for this personal mutation: ${message}`);
      }
      // A parsed HTTP-200 GraphQL error is GitHub's definite refusal of this field.
      // Only a fetch failure or non-ok HTTP response leaves a mutation's fate unknown.
      throw new GithubGraphqlTransportError(`GitHub GraphQL refused the ${mutation ? "mutation" : "query"}: ${message}`, false);
    }
    if (!record(parsed.data)) throw new GithubGraphqlShapeError("GitHub GraphQL returned no data.");
    return { data: parsed.data, headers: response.headers };
  }

  async function query(queryText: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await request(queryText, variables, false);
    const rate = parseRate(result.data.rateLimit);
    recordQueryRate(userId, credentialId, rate, now());
    return result.data;
  }

  async function mutate(queryText: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await request(queryText, { input }, true)).data;
  }

  function repoParts(repo: string, number: number): [string, string] {
    assertRepo(repo);
    if (!Number.isInteger(number) || number < 1) throw new GithubGraphqlTargetError("Malformed pull request number.");
    return repo.split("/") as [string, string];
  }

  return {
    async pullRequest(repo, number) {
      const [owner, name] = repoParts(repo, number);
      const files: { path: string; viewerViewedState: FileViewedState }[] = [];
      let after: string | null = null;
      let id: string | null = null;
      let headRefOid: string | null = null;
      let rate: GraphqlRate | null = null;
      let filesTruncated = false;
      for (let page = 0; page < 20; page++) {
        const data = await query(PERSONAL_PULL_REQUEST_QUERY, { owner, name, number, after });
        rate = parseRate(data.rateLimit);
        if (data.repository === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this repository.");
        const repository = requiredRecord(data.repository, "GitHub returned an invalid repository.");
        if (repository.pullRequest === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this pull request.");
        const pull = requiredRecord(repository.pullRequest, "GitHub returned an invalid pull request.");
        id ??= requiredText(pull.id, "GitHub returned no pull request id.");
        headRefOid ??= requiredText(pull.headRefOid, "GitHub returned no pull request head.");
        const connection = requiredRecord(pull.files, "GitHub returned no pull request files.");
        if (!Array.isArray(connection.nodes)) throw new GithubGraphqlShapeError("GitHub returned invalid pull request files.");
        for (const rawFile of connection.nodes) {
          const file = requiredRecord(rawFile, "GitHub returned an invalid pull request file.");
          const path = requiredText(file.path, "GitHub returned a file without a path.");
          const viewed = text(file.viewerViewedState);
          if (viewed !== "VIEWED" && viewed !== "UNVIEWED" && viewed !== "DISMISSED") throw new GithubGraphqlShapeError("GitHub returned an invalid Viewed state.");
          files.push({ path, viewerViewedState: viewed });
        }
        const pageInfo = requiredRecord(connection.pageInfo, "GitHub returned no file page information.");
        if (pageInfo.hasNextPage !== true) break;
        after = text(pageInfo.endCursor);
        if (!after || page === 19) { filesTruncated = true; break; }
      }
      if (!id || !headRefOid || !rate) throw new GithubGraphqlShapeError("GitHub returned an incomplete pull request.");
      return { id, headRefOid, files, filesTruncated, rate };
    },
    async markFileAsViewed(pullRequestId, path, clientMutationId) {
      await mutate(MARK_FILE_MUTATION, { pullRequestId, path, clientMutationId });
    },
    async unmarkFileAsViewed(pullRequestId, path, clientMutationId) {
      await mutate(UNMARK_FILE_MUTATION, { pullRequestId, path, clientMutationId });
    },
    async addReview(input) {
      const data = await mutate(ADD_REVIEW_MUTATION, input);
      const payload = requiredRecord(data.addPullRequestReview, "GitHub returned no review mutation payload.");
      const review = requiredRecord(payload.pullRequestReview, "GitHub returned no submitted review.");
      const comments = requiredRecord(review.comments, "GitHub returned no review comments.");
      if (!Array.isArray(comments.nodes)) throw new GithubGraphqlShapeError("GitHub returned invalid review comments.");
      return {
        reviewId: requiredText(review.id, "GitHub returned no review id."),
        commentNodeIds: comments.nodes.map((value) => requiredText(requiredRecord(value, "GitHub returned an invalid review comment.").id, "GitHub returned no review comment id.")),
      };
    },
    async addThreadReply(threadId, body, clientMutationId) {
      const data = await mutate(ADD_REPLY_MUTATION, { pullRequestReviewThreadId: threadId, body, clientMutationId });
      const payload = requiredRecord(data.addPullRequestReviewThreadReply, "GitHub returned no reply payload.");
      const comment = requiredRecord(payload.comment, "GitHub returned no reply comment.");
      return { commentNodeId: requiredText(comment.id, "GitHub returned no reply id."), databaseId: databaseId(comment.fullDatabaseId) };
    },
    async resolveThread(threadId, clientMutationId) {
      await mutate(RESOLVE_THREAD_MUTATION, { threadId, clientMutationId });
    },
    async unresolveThread(threadId, clientMutationId) {
      await mutate(UNRESOLVE_THREAD_MUTATION, { threadId, clientMutationId });
    },
    async findReviewThreadByComment(repo, number, commentNodeId) {
      const [owner, name] = repoParts(repo, number);
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data = await query(REVIEW_THREAD_QUERY, { owner, name, number, after });
        if (data.repository === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this repository.");
        const repository = requiredRecord(data.repository, "GitHub returned an invalid repository.");
        if (repository.pullRequest === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this pull request.");
        const pull = requiredRecord(repository.pullRequest, "GitHub returned an invalid pull request.");
        const connection = requiredRecord(pull.reviewThreads, "GitHub returned no review threads.");
        if (!Array.isArray(connection.nodes)) throw new GithubGraphqlShapeError("GitHub returned invalid review threads.");
        for (const rawThread of connection.nodes) {
          const thread = requiredRecord(rawThread, "GitHub returned an invalid review thread.");
          const comments = requiredRecord(thread.comments, "GitHub returned invalid thread comments.");
          if (Array.isArray(comments.nodes) && comments.nodes.some((rawComment) => record(rawComment) && rawComment.id === commentNodeId)) return requiredText(thread.id, "GitHub returned no thread id.");
        }
        const pageInfo = requiredRecord(connection.pageInfo, "GitHub returned no thread page information.");
        if (pageInfo.hasNextPage !== true) return null;
        after = text(pageInfo.endCursor);
        if (!after) return null;
      }
      return null;
    },
    async recoverReview(input) {
      const [owner, name] = repoParts(input.repo, input.number);
      const data = await query(RECOVER_REVIEW_QUERY, { owner, name, number: input.number });
      const viewer = requiredRecord(data.viewer, "GitHub returned no viewer.");
      const login = requiredText(viewer.login, "GitHub returned no viewer login.");
      if (data.repository === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this repository.");
      const repository = requiredRecord(data.repository, "GitHub returned an invalid repository.");
      if (repository.pullRequest === null) throw new GithubGraphqlTargetError("GitHub no longer exposes this pull request.");
      const pull = requiredRecord(repository.pullRequest, "GitHub returned an invalid pull request.");
      const reviewsConnection = requiredRecord(pull.reviews, "GitHub returned no recent reviews.");
      if (!Array.isArray(reviewsConnection.nodes)) throw new GithubGraphqlShapeError("GitHub returned invalid recent reviews.");
      const expectedState = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
      const matches: { reviewId: string; commentNodeId: string | null; threadId: string | null }[] = [];
      for (const rawReview of reviewsConnection.nodes) {
        const review = requiredRecord(rawReview, "GitHub returned an invalid recent review.");
        const author = record(review.author) ? text(review.author.login) : null;
        const submittedAt = instant(review.submittedAt);
        if (author !== login || review.state !== expectedState || (text(review.body) ?? "") !== input.body || oid(review.commit) !== input.commitOID || submittedAt === null || submittedAt < input.createdAt) continue;
        const comments = requiredRecord(review.comments, "GitHub returned invalid recovery comments.");
        if (!Array.isArray(comments.nodes)) throw new GithubGraphqlShapeError("GitHub returned invalid recovery comments.");
        let commentNodeId: string | null = null;
        let threadId: string | null = null;
        if (input.thread) {
          const exact = comments.nodes.filter((rawComment) => {
            if (!record(rawComment)) return false;
            return rawComment.body === input.thread!.body && rawComment.path === input.thread!.path && rawComment.diffSide === input.thread!.side && integer(rawComment.line) === input.thread!.line && (input.thread!.startLine === undefined || integer(rawComment.startLine) === input.thread!.startLine);
          });
          if (exact.length !== 1) continue;
          const comment = requiredRecord(exact[0], "GitHub returned an invalid recovery comment.");
          commentNodeId = requiredText(comment.id, "GitHub returned no recovery comment id.");
          threadId = record(comment.pullRequestReviewThread) ? text(comment.pullRequestReviewThread.id) : null;
          if (!threadId) continue;
        }
        matches.push({ reviewId: requiredText(review.id, "GitHub returned no recovery review id."), commentNodeId, threadId });
      }
      return matches.length === 0 ? { kind: "none" } : matches.length === 1 ? { kind: "match", ...matches[0]! } : { kind: "ambiguous", matches: matches.length };
    },
  };
}

export type PersonalGithubGraphqlClientFactory = (
  userId: string,
  credentialId: string,
  options?: GraphqlTransportOptions,
) => PersonalGithubGraphqlClient;

let personalFactory: PersonalGithubGraphqlClientFactory | null = null;

/** Test seam. Production leaves this null and opens the exact encrypted row below. */
export function setPersonalGithubGraphqlClientFactory(factory: PersonalGithubGraphqlClientFactory | null): void {
  personalFactory = factory;
}

export function personalGithubGraphqlClient(
  userId: string,
  credentialId: string,
  options: GraphqlTransportOptions = {},
): PersonalGithubGraphqlClient {
  if (personalFactory) return personalFactory(userId, credentialId, options);
  const credential = getGithubUserCredential(credentialId, userId);
  const current = (options.now ?? Date.now)();
  if (!credential || credential.revoked_at !== null || credential.dead_at !== null || (credential.expires_at !== null && credential.expires_at <= current)) {
    if (credential && credential.dead_at === null && credential.expires_at !== null && credential.expires_at <= current) markGithubUserCredentialDead(credentialId, userId, current);
    throw new GithubGraphqlPermissionError("This GitHub credential is revoked, expired, dead, or owned by another member.");
  }
  const token = openGithubUserCredential(credentialId, userId);
  if (!token) throw new GithubGraphqlPermissionError("This GitHub credential is unavailable.");
  touchGithubUserCredential(credentialId, userId, current);
  return personalClient(userId, credentialId, token, options);
}
