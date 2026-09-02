// The App's identity, and the credentials derived from it.
//
// `github.ts` knows how to talk to GitHub; this module knows *as whom*. Nothing here
// is ever written to SQLite: the app JWT is derived from the private key on demand and
// the installation token is minted on demand and held in memory, so a copy of the
// database is not a set of working GitHub credentials.
//
// The other thing this module owns is the answer to "may this workspace read that
// repository at all". That question is answered per call, inside the client, rather
// than by callers remembering to ask it first — a caller that forgets is the confused
// deputy the App exists to remove.

import { createSign } from "node:crypto";
import { config } from "../config";
import {
  assertRepo,
  createFetchGithubClient,
  GithubError,
  type GithubClient,
  type GithubPull,
} from "./github";
import {
  createUserGithubClient,
  exactUserGithubClient,
  exactUserGithubGraphqlReader,
  findUserCredentialFor,
} from "./github-user";
import { createGithubGraphqlReader, type GithubGraphqlReader } from "./github-graphql";

// ---- the app JWT ----

/**
 * `iat` is backdated a minute. GitHub rejects a JWT whose `iat` is in the future and a
 * second or two of clock skew is normal on a shared host, so a JWT stamped with the
 * local clock's "now" works on a developer's laptop and fails in production. The pair
 * below sits a minute inside GitHub's ten-minute ceiling at both ends.
 */
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 540;

export interface AppCredentials {
  appId: string;
  /** The PEM itself, already decoded from the base64 the environment carries. */
  privateKeyPem: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RS256 over `{iat, exp, iss}`, signed with node:crypto. No library. */
export function appJwt(credentials: AppCredentials, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iat: now - JWT_BACKDATE_SECONDS,
      exp: now + JWT_LIFETIME_SECONDS,
      iss: credentials.appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(credentials.privateKeyPem))}`;
}

// ---- the installation token ----

/**
 * Re-minted five minutes before GitHub's hour is up: a token that expires mid-request
 * is a failure nothing retries, and five minutes is longer than any call here takes.
 */
export const TOKEN_REMINT_EARLY_MS = 5 * 60 * 1000;

/**
 * How long a repository's routing answer is trusted. This lookup authenticates as the
 * *app*, whose rate limit is shared by every workspace on the instance, and it sits on
 * the hottest path there is — so the TTL is long deliberately. Correctness comes from
 * invalidation (`installation_repositories`, `setup_action=update`), not from expiry.
 */
export const ROUTING_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a *negative* answer is trusted — "no installation covers this repository".
 *
 * Deliberately not ROUTING_TTL_MS. The long TTL above is an argument about a positive
 * answer, which only stops being true when GitHub tells us so, and which is the hot
 * path. A negative is the opposite on both counts: the ordinary first run *is* a
 * negative (publish, be told to install the App, install it, connect it, publish again),
 * and the event that makes it false — somebody installing the App on an account Seer has
 * never seen — is not an event any invalidation here can be sure of seeing first. A
 * negative that outlives the user's next attempt turns the failure table's one
 * actionable message into a lie, so it lives about as long as it takes to read that
 * message, and no longer.
 *
 * With more than one process alive — which the design guarantees, since containers
 * overlap on deploy — invalidation reaches only the process that handled the request.
 * The TTL is therefore what the *other* processes get: an upper bound on how long a
 * container that missed the event keeps answering the stale thing. That is why the
 * bound that matters is this one. A stale positive costs a 404 from a mint the caller
 * already handles; a stale negative costs a refusal the user cannot clear.
 */
export const NEGATIVE_ROUTING_TTL_MS = 60 * 1000;

/**
 * How many entries each in-memory cache may hold. A process lives for as long as the
 * container does and can be asked about an unbounded number of distinct repository
 * names — including names that pass `assertRepo` and exist nowhere — so every map here
 * is swept of expired entries once it grows past its bound, and trimmed from whatever
 * expires soonest if the sweep was not enough.
 */
export const ROUTING_CACHE_MAX = 4096;
export const TOKEN_CACHE_MAX = 1024;
export const REPO_ID_CACHE_MAX = 16384;

/**
 * Drop what has expired, then whatever expires soonest, until the map is inside its
 * bound. Eviction is by time-to-live rather than by insertion order, and that is the
 * point of the sort: a flood of short-lived entries (a caller naming thousands of
 * repositories that exist nowhere buys sixty-second negatives) must consume itself, not
 * the six-hour positive answers every real workspace depends on — which insertion-order
 * eviction would throw out first, since the oldest entries are the longest-lived ones.
 */
export function bound<V>(map: Map<string, V>, max: number, until: (value: V) => number, cutoff: number): void {
  if (map.size <= max) return;
  for (const [key, value] of map) if (until(value) <= cutoff) map.delete(key);
  if (map.size <= max) return;
  const byExpiry = [...map.entries()].sort((a, b) => until(a[1]) - until(b[1]));
  for (const [key] of byExpiry) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

interface CachedToken {
  token: string;
  /** Milliseconds, already pulled forward by TOKEN_REMINT_EARLY_MS. */
  usableUntil: number;
}

/** What a mint may reach. Narrower than the installation wherever we can be. */
export interface MintScope {
  repositoryIds?: number[];
  /** Names, for a repository whose numeric id we have not seen yet. */
  repositories?: string[];
}

export interface AppApi {
  /** The installation covering `repo`, or null when no installation does. */
  installationForRepo(repo: string): Promise<number | null>;
  /** A token for that installation, minted as narrowly as the scope allows. */
  installationToken(installationId: number, scope: MintScope): Promise<string>;
  /** Learned from a payload that carries it, so later mints can name `repository_ids`. */
  noteRepositoryId(repo: string, id: number): void;
  repositoryId(repo: string): number | undefined;
  /** Dropped when GitHub tells us the installation's repositories changed. */
  invalidateRouting(repo?: string): void;
}

export interface AppApiOptions {
  credentials: AppCredentials;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

const API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20_000;

interface MintResponse {
  token: string;
  expires_at: string;
}

interface InstallationResponse {
  id: number;
}

export function createAppApi(options: AppApiOptions): AppApi {
  const base = (options.apiBase ?? API).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const routing = new Map<string, { installationId: number | null; until: number }>();
  const tokens = new Map<string, CachedToken>();
  const repoIds = new Map<string, number>();

  async function appRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "overseer",
      Authorization: `Bearer ${appJwt(options.credentials, now())}`,
    };
    if (init.body) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new GithubError(`GitHub request to ${url} failed: ${String(err)}`, 0, url);
    }
    return res;
  }

  async function failed(res: Response, url: string): Promise<never> {
    const body = (await res.text().catch(() => "")).slice(0, 400);
    // Two of GitHub's refusals are not faults to retry, and the failure table says so:
    // the app-JWT rate limit is shared across every workspace and every installation, so
    // hammering it is the worst possible response; and a suspended installation stays
    // suspended until a human on that account unsuspends it. Both are read off GitHub
    // refusing rather than off a column that a lost webhook could leave stale forever.
    if (isRateLimited(res, body)) {
      throw new GithubRateLimitError(
        `GitHub's rate limit for this Seer instance's App is exhausted (GitHub answered ${res.status}). ` +
          "It is shared by every workspace here and resets on GitHub's own schedule. Nothing was read, " +
          "and no repository is at fault.",
      );
    }
    if (res.status === 403 && /suspend/i.test(body)) {
      throw new GithubSuspendedError(
        installationIdIn(url),
        "The GitHub App installation is suspended, so GitHub refused to mint a token for it. " +
          "Unsuspend it on GitHub, then try again.",
      );
    }
    throw new GithubError(`GitHub ${res.status} for ${url}: ${body}`, res.status, url);
  }

  return {
    async installationForRepo(repo) {
      // Before the name is interpolated, not after: `/repos/a/b#x/installation`
      // resolves to a different endpoint that answers 200.
      assertRepo(repo);
      const key = repo.toLowerCase();
      const hit = routing.get(key);
      if (hit && hit.until > now()) return hit.installationId;
      const path = `/repos/${repo}/installation`;
      const res = await appRequest(path);
      if (res.status === 404) {
        // Cached, but only for NEGATIVE_ROUTING_TTL_MS. This write happens before any
        // caller has asked whose installation it is — it has to, because this layer does
        // not know about workspaces — so whoever names a repository first decides what
        // every workspace on this process is told about it. Keeping the entry is still
        // right (a repository nobody has installed is the thing a retry loop asks about
        // hardest), but at a minute it cannot outlive the asker's own next attempt, so
        // naming somebody else's repository buys nothing worth having.
        routing.set(key, { installationId: null, until: now() + NEGATIVE_ROUTING_TTL_MS });
        bound(routing, ROUTING_CACHE_MAX, (entry) => entry.until, now());
        return null;
      }
      if (!res.ok) await failed(res, `${base}${path}`);
      const body = (await res.json()) as InstallationResponse;
      routing.set(key, { installationId: body.id, until: now() + ROUTING_TTL_MS });
      bound(routing, ROUTING_CACHE_MAX, (entry) => entry.until, now());
      return body.id;
    },

    async installationToken(installationId, scope) {
      // The cache is keyed by installation *and* scope: a token minted for one
      // repository is not usable for another, so sharing one entry would hand a
      // caller a credential that 404s on everything it asks for.
      // The two forms are prefixed because they share one keyspace otherwise, and a
      // repository may be named after a number: a mint scoped to repository id 902441057
      // must not be served to a caller asking for the repository called "902441057".
      const scopeKey = scope.repositoryIds?.length
        ? `id:${scope.repositoryIds.join(",")}`
        : scope.repositories?.length
          ? `name:${scope.repositories.join(",").toLowerCase()}`
          : "*";
      const key = `${installationId}:${scopeKey}`;
      const hit = tokens.get(key);
      if (hit && hit.usableUntil > now()) return hit.token;

      const path = `/app/installations/${installationId}/access_tokens`;
      const body: Record<string, unknown> = {};
      if (scope.repositoryIds?.length) body.repository_ids = scope.repositoryIds;
      else if (scope.repositories?.length) body.repositories = scope.repositories;
      const res = await appRequest(path, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) await failed(res, `${base}${path}`);
      const minted = (await res.json()) as MintResponse;
      const expiresAt = Date.parse(minted.expires_at);
      tokens.set(key, {
        token: minted.token,
        usableUntil:
          (Number.isFinite(expiresAt) ? expiresAt : now() + 60 * 60 * 1000) - TOKEN_REMINT_EARLY_MS,
      });
      bound(tokens, TOKEN_CACHE_MAX, (entry) => entry.usableUntil, now());
      return minted.token;
    },

    noteRepositoryId(repo, id) {
      if (!Number.isInteger(id) || id <= 0) return;
      repoIds.set(repo.toLowerCase(), id);
      // Nothing here expires — these come from payloads GitHub sent, so they are true
      // until a rename — which is why the bound is large and the eviction is by age.
      bound(repoIds, REPO_ID_CACHE_MAX, () => Infinity, now());
    },

    repositoryId(repo) {
      return repoIds.get(repo.toLowerCase());
    },

    invalidateRouting(repo) {
      if (repo === undefined) routing.clear();
      else routing.delete(repo.toLowerCase());
    },
  };
}

// ---- routing a repository to one of the workspace's installations ----

/**
 * A refusal the caller must not retry as though GitHub had faltered.
 *
 * These are the rows of the failure table that answer 422 rather than 502: an access
 * problem, a suspended installation, an exhausted app-JWT rate limit. Telling the skill
 * to retry any of them is worse than useless — the rate limit is shared by the whole
 * instance — so they are one type the routes can match, and every one of them carries a
 * message a human can act on.
 */
export class GithubAppRefusal extends GithubError {
  constructor(message: string) {
    super(message, 422, "");
    this.name = "GithubAppRefusal";
  }
}

/** A refusal that is about who may read what, rather than about GitHub being unhappy. */
export class GithubRoutingError extends GithubAppRefusal {
  constructor(message: string) {
    super(message);
    this.name = "GithubRoutingError";
  }
}

/** GitHub refused to mint for a suspended installation. The refusal is the fact: the
 *  `suspended_at` column is a display hint a lost `unsuspend` could leave stale. */
export class GithubSuspendedError extends GithubAppRefusal {
  readonly installationId: number | null;
  constructor(installationId: number | null, message: string) {
    super(message);
    this.name = "GithubSuspendedError";
    this.installationId = installationId;
  }
}

/**
 * GitHub refused a credential that was presented, so it is gone at the far end.
 *
 * Deliberately not a GithubRoutingError: the workspace client falls through to the
 * anonymous reader on routing errors, and papering a dead credential over with a public
 * read hides the one fact only the person asking can act on. A routing error means "none
 * of yours covers this"; this means "one of yours is broken", and it must reach them.
 */
export class GithubCredentialDeadError extends GithubAppRefusal {
  readonly credentialId: string;
  constructor(credentialId: string, message: string) {
    super(message);
    this.name = "GithubCredentialDeadError";
    this.credentialId = credentialId;
  }
}

/** The app JWT's rate limit, which is shared across every workspace on this instance. */
export class GithubRateLimitError extends GithubAppRefusal {
  constructor(
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

/** GitHub says rate limit two ways: a 429, or a 403 whose body says so with the
 *  remaining budget at zero. Both are read, because the App endpoints use the 403. */
function isRateLimited(res: Response, body: string): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit|abuse detection|secondary rate/i.test(body);
}

function installationIdIn(url: string): number | null {
  const m = /\/app\/installations\/(\d+)\//.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Which installations a workspace holds. Step 2 backs this with `github_installations`;
 * until then the factory is handed one, which is also how a test asks the routing
 * question without a schema.
 */
export interface WorkspaceHoldings {
  installationIds(workspaceId: string): Promise<number[]> | number[];
}

export interface WorkspaceClientOptions {
  workspaceId: string;
  holdings: WorkspaceHoldings;
  app: AppApi;
  /** The person making this request. Omitted for webhook and other non-human paths. */
  askingUserId?: string;
  /** Injection seam for tests; production builds this from askingUserId. */
  userClient?: GithubClient;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A GithubClient bound to one workspace. Every method routes its own `repo` and mints
 * its own token, so the authorization is at the transport rather than in front of it:
 * whatever the validator allows later, a call for a repository this workspace does not
 * hold never acquires a credential to make it with — it falls back to an anonymous
 * client, which by construction can read only what is already public.
 */
/** The account half of `owner/name`: the thing a person has to install the App on. */
function accountOf(repo: string): string {
  return repo.split("/")[0] ?? repo;
}

/**
 * Repositories the anonymous fallback has recently learned it cannot read, each with
 * the moment the lesson expires. Process-wide on purpose: whether GitHub serves a
 * repository to the world is not a per-workspace fact.
 *
 * This is what keeps the fallback from spending the budget it runs on. The refusal it
 * replaced cost zero requests, so without this memory a retry loop naming one private
 * repository would drain the host's ~60 unauthenticated requests an hour and take every
 * public-repository review on the instance down with it. A rate-limited answer is
 * deliberately NOT recorded here: it says nothing about the repository, and an hour
 * later the read may work.
 */
const anonymousUnreachable = new Map<string, number>();
export const ANONYMOUS_NEGATIVE_TTL_MS = 15 * 60 * 1000;

/** Test seam: the unreachable memory is process-wide and must not leak between tests. */
export function resetAnonymousReachability(): void {
  anonymousUnreachable.clear();
}

/** Transport-only options, shared by every client this module builds. */
export interface GithubTransportOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The client for a repository no installation of this workspace's covers: no token at
 * all, which is what makes the fallback safe rather than a hole. An unauthenticated
 * request can only ever be answered with bytes GitHub already serves to the world, so
 * no workspace reaches anything it could not have read from a browser — while a public
 * repository stays reviewable, which it was before the App existed.
 *
 * The cost is the budget: GitHub allows roughly sixty unauthenticated requests an hour
 * per IP, shared by everything on this host. A repository an installation does cover
 * must therefore always be reached through that installation, never through here.
 *
 * At module scope rather than inside the workspace client because the promoted review's
 * `anonymous` read actor is the same thing: a stored decision to read this repository
 * with no credential at all, reopened later by a worker that has no workspace client.
 */
export function anonymousGithubClient(repo: string, options: GithubTransportOptions = {}): GithubClient {
  const client = createFetchGithubClient(options);
  const refusal = () =>
    new GithubRoutingError(
      `${repo} is not reachable anonymously, and no GitHub App installation this workspace ` +
        `holds covers it. If the repository is private, install the app on the ` +
        `${accountOf(repo)} account and connect it in workspace settings — or connect a ` +
        `GitHub account that can read ${repo}.`,
    );
  // When the anonymous read fails the way a private repository fails, the refusal the
  // routing check would have thrown is still the actionable half of the answer, so it
  // is said here — with GitHub's own words kept as the cause. GitHub also answers 403
  // when the unauthenticated budget itself is spent, and that is a different sentence
  // with a different remedy: the repository is not at fault and must not be remembered
  // as unreadable.
  async function guard<T>(call: () => Promise<T>): Promise<T> {
    const barred = anonymousUnreachable.get(repo.toLowerCase());
    if (barred !== undefined && barred > Date.now()) throw refusal();
    try {
      return await call();
    } catch (err) {
      if (err instanceof GithubError && err.status === 403 && /rate limit/i.test(err.message)) {
        throw new GithubRateLimitError(
          "GitHub's anonymous request budget for this host is exhausted. It is shared by " +
            "everything here that reads public repositories without an installation, and it " +
            "resets on GitHub's own schedule. Nothing was read, and no repository is at fault.",
        );
      }
      if (err instanceof GithubError && (err.status === 404 || err.status === 403)) {
        anonymousUnreachable.set(repo.toLowerCase(), Date.now() + ANONYMOUS_NEGATIVE_TTL_MS);
        bound(anonymousUnreachable, ROUTING_CACHE_MAX, (until) => until, Date.now());
        throw new GithubRoutingError(`${refusal().message} GitHub answered: ${err.message}`);
      }
      throw err;
    }
  }
  return {
    getPull: (r, n) => guard(() => client.getPull(r, n)),
    listCommits: (r, n) => guard(() => client.listCommits(r, n)),
    listFiles: (r, n) => guard(() => client.listFiles(r, n)),
    listReviewComments: (r, n) => guard(() => client.listReviewComments(r, n)),
    getFileAtSha: (r, p, sha) => guard(() => client.getFileAtSha(r, p, sha)),
    getPullDiff: (r, n) => guard(() => client.getPullDiff(r, n)),
    getRepository: (r) => guard(() => client.getRepository!(r)),
    getRef: (r, ref) => guard(() => client.getRef!(r, ref)),
    getTree: (r, sha, recursive) => guard(() => client.getTree!(r, sha, recursive)),
    getBlobBytes: (r, sha) => guard(() => client.getBlobBytes!(r, sha)),
    compare: (r, base, head) => guard(() => client.compare!(r, base, head)),
    compareDiff: (r, base, head) => guard(() => client.compareDiff!(r, base, head)),
  };
}

export function createWorkspaceGithubClient(options: WorkspaceClientOptions): GithubClient {
  const { workspaceId, holdings, app } = options;

  const anonymous = (repo: string): GithubClient =>
    anonymousGithubClient(repo, {
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

  const userClient =
    options.userClient ??
    (options.askingUserId
      ? createUserGithubClient(options.askingUserId, {
          apiBase: options.apiBase,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
        })
      : null);

  /**
   * The asking user's credential first, the anonymous fallback beneath it.
   *
   * The order is not taste: the credential can read the private repositories anonymity
   * never will, and it spends the person's own hourly budget rather than the host's
   * shared sixty. The user client refuses with a routing error exactly when no
   * credential of theirs can read the repository — which is the one case anonymity may
   * still answer, a public repository reached by someone with nothing connected. Any
   * other failure is the user path's own and passes through.
   */
  function userThenAnonymous(repo: string, user: GithubClient): GithubClient {
    const anon = anonymous(repo);
    const fall = async <T>(viaUser: () => Promise<T>, viaAnon: () => Promise<T>): Promise<T> => {
      try {
        return await viaUser();
      } catch (err) {
        if (err instanceof GithubRoutingError) return viaAnon();
        throw err;
      }
    };
    return {
      getPull: (r, n) => fall(() => user.getPull(r, n), () => anon.getPull(r, n)),
      listCommits: (r, n) => fall(() => user.listCommits(r, n), () => anon.listCommits(r, n)),
      listFiles: (r, n) => fall(() => user.listFiles(r, n), () => anon.listFiles(r, n)),
      listReviewComments: (r, n) =>
        fall(() => user.listReviewComments(r, n), () => anon.listReviewComments(r, n)),
      getFileAtSha: (r, p, sha) =>
        fall(() => user.getFileAtSha(r, p, sha), () => anon.getFileAtSha(r, p, sha)),
      getPullDiff: (r, n) => fall(() => user.getPullDiff(r, n), () => anon.getPullDiff(r, n)),
      getRepository: (r) => fall(() => user.getRepository!(r), () => anon.getRepository!(r)),
      getRef: (r, ref) => fall(() => user.getRef!(r, ref), () => anon.getRef!(r, ref)),
      getTree: (r, sha, recursive) => fall(() => user.getTree!(r, sha, recursive), () => anon.getTree!(r, sha, recursive)),
      getBlobBytes: (r, sha) => fall(() => user.getBlobBytes!(r, sha), () => anon.getBlobBytes!(r, sha)),
      compare: (r, base, head) => fall(() => user.compare!(r, base, head), () => anon.compare!(r, base, head)),
      compareDiff: (r, base, head) => fall(() => user.compareDiff!(r, base, head), () => anon.compareDiff!(r, base, head)),
    };
  }

  async function authorize(repo: string): Promise<GithubClient> {
    assertRepo(repo);
    const installationId = await app.installationForRepo(repo);
    const held = installationId === null ? [] : await holdings.installationIds(workspaceId);
    if (installationId === null || !held.includes(installationId)) {
      return userClient ? userThenAnonymous(repo, userClient) : anonymous(repo);
    }
    const id = app.repositoryId(repo);
    let token: string;
    try {
      token = await app.installationToken(
        installationId,
        id === undefined ? { repositories: [repo.split("/")[1]!] } : { repositoryIds: [id] },
      );
    } catch (err) {
      // The mint layer knows an installation id; only here is there a repository, and
      // therefore an account, to name — which is what the failure table promises.
      if (err instanceof GithubSuspendedError) {
        throw new GithubSuspendedError(
          err.installationId,
          `The GitHub App installation for the ${accountOf(repo)} account is suspended, so GitHub ` +
            `refused to mint a token for ${repo}. Unsuspend it on GitHub, then try again.`,
        );
      }
      throw err;
    }
    return createFetchGithubClient({
      token,
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  return {
    async installationFor(repo) {
      // The routing question without the mint, and without the refusal: a caller
      // asking whose installation this would be is asking so it can attribute an
      // observation, and "nobody's" is an answer rather than an error.
      assertRepo(repo);
      const installationId = await app.installationForRepo(repo);
      if (installationId === null) return null;
      const held = await holdings.installationIds(workspaceId);
      return held.includes(installationId) ? installationId : null;
    },
    async getPull(repo, number) {
      const pull: GithubPull = await (await authorize(repo)).getPull(repo, number);
      // The one payload that carries the repository's numeric id, which is what lets
      // the next mint for this repository be narrow by id rather than by name.
      if (pull.base?.repo?.id) app.noteRepositoryId(repo, pull.base.repo.id);
      return pull;
    },
    async listCommits(repo, number) {
      return (await authorize(repo)).listCommits(repo, number);
    },
    async listFiles(repo, number) {
      return (await authorize(repo)).listFiles(repo, number);
    },
    async listReviewComments(repo, number) {
      return (await authorize(repo)).listReviewComments(repo, number);
    },
    async getFileAtSha(repo, path, sha) {
      return (await authorize(repo)).getFileAtSha(repo, path, sha);
    },
    async getPullDiff(repo, number) {
      return (await authorize(repo)).getPullDiff(repo, number);
    },
    async getRepository(repo) {
      return (await authorize(repo)).getRepository!(repo);
    },
    async getRef(repo, ref) {
      return (await authorize(repo)).getRef!(repo, ref);
    },
    async getTree(repo, sha, recursive) {
      return (await authorize(repo)).getTree!(repo, sha, recursive);
    },
    async getBlobBytes(repo, sha) {
      return (await authorize(repo)).getBlobBytes!(repo, sha);
    },
    async compare(repo, base, head) {
      return (await authorize(repo)).compare!(repo, base, head);
    },
    async compareDiff(repo, base, head) {
      return (await authorize(repo)).compareDiff!(repo, base, head);
    },
  };
}

// ---- the injection seam, which is a factory rather than a singleton ----
//
// "A client built for the workspace" cannot be a process-global instance, so the seam
// tests install is a factory. tests/setup.ts installs one that cannot reach a network,
// which is the successor to setGithubClient()'s offline default: without it a routing
// lookup would make a real request with real app credentials, silently, because a 404
// from routing is indistinguishable from "not installed".

export type GithubClientFactory = (workspaceId: string, askingUserId?: string) => GithubClient;

let injectedFactory: GithubClientFactory | null = null;
let holdingsSource: WorkspaceHoldings | null = null;
let defaultApp: AppApi | null = null;

/** Step 2 installs the database-backed implementation here at boot. */
export function setWorkspaceHoldings(holdings: WorkspaceHoldings | null): void {
  holdingsSource = holdings;
  defaultApp = null;
}

export function appCredentials(): AppCredentials {
  // No "not configured" branch: config.ts requires all six App variables at boot and
  // names the missing ones there, so a running server always has credentials. A guard
  // here could only ever be dead code pretending the failure is handled later.
  const app = config.githubApp;
  return { appId: app.appId, privateKeyPem: app.privateKeyPem };
}

/**
 * The client a request should use, for a workspace and for the person behind the request.
 *
 * `askingUserId` is what makes a personal credential reachable, and leaving it off is
 * how the confused deputy gets rebuilt: a workspace is a group, so a credential resolved
 * from the workspace alone is one member's access handed to every other member. It is
 * therefore OPTIONAL rather than defaulted, and every caller that has a person passes one.
 *
 * Exactly one caller legitimately has none. A webhook is delivered by GitHub, not
 * requested by anybody, so there is no person whose credential it could be entitled to
 * spend -- and it must reach installations only. That call site passes nothing, on
 * purpose, and a test asserts it stays that way.
 */
export function githubClientFor(workspaceId: string, askingUserId?: string): GithubClient {
  if (injectedFactory) return injectedFactory(workspaceId, askingUserId);
  if (!holdingsSource) {
    throw new Error(
      "No workspace holdings source is installed, so no workspace can be routed to an installation.",
    );
  }
  defaultApp ??= createAppApi({ credentials: appCredentials() });
  return createWorkspaceGithubClient({
    workspaceId,
    holdings: holdingsSource,
    app: defaultApp,
    askingUserId,
  });
}

/**
 * Drop what routing believes about a repository (or about everything).
 *
 * The routing TTL is long on purpose — `GET /repos/{o}/{r}/installation` authenticates
 * as the App, and that rate limit is the one budget shared across every workspace — so
 * the correctness of a long TTL rests entirely on the events that invalidate it:
 * `installation_repositories`, `installation.created/deleted` and `setup_action=update`.
 * A no-op when no default app has been built yet, which is every test with an injected
 * factory: there is no cache to drop.
 */
export function invalidateAppRouting(repo?: string): void {
  defaultApp?.invalidateRouting(repo);
}

/**
 * Install the AppApi that `githubClientFor` routes through and `invalidateAppRouting`
 * drops from. The only seam through which a test can watch an invalidation happen:
 * the client factory tests inject is a *client* factory, and it has no cache in it.
 */
export function setAppApi(app: AppApi | null): void {
  defaultApp = app;
}

export function setGithubClientFactory(factory: GithubClientFactory | null): void {
  injectedFactory = factory;
}

// ---- the routed read session: a client, and the name of who it is ----
//
// `githubClientFor` answers "give me something that can read this workspace's
// repositories" and decides per call, silently falling from installation to credential to
// anonymity. That is right for a read that happens once and is rendered immediately.
//
// It is wrong for work that outlives the request. A promoted review observes a pull
// request now, queues a capture, and completes it in another process minutes later — and
// the two must be the same reader. So this seam answers a different question: WHO is
// reading, as a value that can be stored, and later, open exactly that one and nothing
// else. There is no fallback in `open` on purpose: falling back would mean the stored
// attribution and the credential actually spent had come apart.

/** A stored read identity. Narrow by construction: an installation this workspace holds,
 *  one credential of one person, or no credential at all. */
export type ReadActor =
  | { kind: "installation"; installationId: number }
  | { kind: "user"; userId: string; credentialId: string }
  | { kind: "anonymous" };

export interface GithubReadSession {
  actor: ReadActor;
  client: GithubClient;
}

export interface ReadRouter {
  /** Who this workspace should read `repo` as, for the person asking. */
  resolve(workspaceId: string, repo: string, askingUserId: string | null): Promise<ReadActor>;
  /** A client for exactly that actor, or a visible refusal. Never a different actor.
   *  A stored repository id keeps installation scoping valid after a rename. */
  open(workspaceId: string, actor: ReadActor, repo: string, repoId?: number): Promise<GithubClient>;
  /** Read-only review conversation transport for the same exact stored actor. */
  openGraphql(workspaceId: string, actor: ReadActor, repo: string, repoId?: number): Promise<GithubGraphqlReader>;
}

/** The lane a capture job queues on. Two jobs for one actor serialize; jobs for
 *  different actors may overlap. Workspace-scoped because an installation and a
 *  credential are both claimed by exactly one workspace, and anonymity is only ever
 *  spending the host's shared budget on this workspace's behalf. */
export function actorQueueKey(workspaceId: string, actor: ReadActor): string {
  if (actor.kind === "installation") {
    return [workspaceId, "installation", String(actor.installationId)].join("/");
  }
  if (actor.kind === "user") return [workspaceId, "user", actor.userId, actor.credentialId].join("/");
  return [workspaceId, "anonymous"].join("/");
}

/** How a reader names the actor. Never a credential id: settings owns that, and a
 *  review page is read by every member of the workspace. */
export function actorWords(actor: ReadActor): string {
  if (actor.kind === "installation") return "the GitHub App installation";
  if (actor.kind === "user") return "the owning member's GitHub connection";
  return "public GitHub";
}

function defaultReadRouter(): ReadRouter {
  return {
    async resolve(workspaceId, repo, askingUserId) {
      assertRepo(repo);
      if (!holdingsSource) {
        throw new Error(
          "No workspace holdings source is installed, so no workspace can be routed to an installation.",
        );
      }
      defaultApp ??= createAppApi({ credentials: appCredentials() });
      const installationId = await defaultApp.installationForRepo(repo);
      if (installationId !== null) {
        const held = await holdingsSource.installationIds(workspaceId);
        if (held.includes(installationId)) return { kind: "installation", installationId };
      }
      if (askingUserId) {
        const credentialId = await findUserCredentialFor(askingUserId, repo);
        if (credentialId) return { kind: "user", userId: askingUserId, credentialId };
      }
      return { kind: "anonymous" };
    },

    async open(workspaceId, actor, repo, repoId) {
      assertRepo(repo);
      if (actor.kind === "anonymous") return anonymousGithubClient(repo);
      if (actor.kind === "user") return exactUserGithubClient(actor.userId, actor.credentialId);
      const token = await exactInstallationToken(workspaceId, actor.installationId, repo, repoId);
      return createFetchGithubClient({ token });
    },

    async openGraphql(workspaceId, actor, repo, repoId) {
      assertRepo(repo);
      if (actor.kind === "anonymous") throw new GithubRoutingError("GitHub conversation import needs an authenticated reader.");
      if (actor.kind === "user") return exactUserGithubGraphqlReader(actor.userId, actor.credentialId);
      return createGithubGraphqlReader({ token: await exactInstallationToken(workspaceId, actor.installationId, repo, repoId) });
    },
  };
}

async function exactInstallationToken(workspaceId: string, installationId: number, repo: string, repoId?: number): Promise<string> {
  if (!holdingsSource) throw new Error("No workspace holdings source is installed, so no workspace can be routed to an installation.");
  const held = await holdingsSource.installationIds(workspaceId);
  if (!held.includes(installationId)) {
    throw new GithubRoutingError(
      `This review reads ${repo} through GitHub App installation ${installationId}, which this workspace no longer holds. ` +
      "Reconnect that installation in workspace settings, or attach the pull request again through a reader that can reach it.",
    );
  }
  defaultApp ??= createAppApi({ credentials: appCredentials() });
  const id = repoId ?? defaultApp.repositoryId(repo);
  return defaultApp.installationToken(installationId, id === undefined ? { repositories: [repo.split("/")[1]!] } : { repositoryIds: [id] });
}

let injectedReadRouter: ReadRouter | null = null;
type CompatibleReadRouter = Omit<ReadRouter, "openGraphql"> & Partial<Pick<ReadRouter, "openGraphql">>;

/** Test seam. Older task-8 fakes may omit GraphQL; normalize that omission to a loud
 * refusal rather than weakening the production ReadRouter contract or reaching GitHub. */
export function setReadRouter(router: CompatibleReadRouter | null): void {
  injectedReadRouter = router === null ? null : {
    ...router,
    openGraphql: router.openGraphql ?? (async () => { throw new GithubRoutingError("The selected GitHub reader does not provide read-only conversation import."); }),
  };
}

function readRouter(): ReadRouter {
  return injectedReadRouter ?? defaultReadRouter();
}

/** Resolve one actor and bind it in the same breath, so the caller holds a session it
 *  can both store and read through. */
export async function resolveReadSession(
  workspaceId: string,
  repo: string,
  askingUserId: string | null,
): Promise<GithubReadSession> {
  const router = readRouter();
  const actor = await router.resolve(workspaceId, repo, askingUserId);
  return { actor, client: await router.open(workspaceId, actor, repo) };
}

/** Reopen an exact stored actor. A worker never reroutes. */
export async function openReadSession(
  workspaceId: string,
  actor: ReadActor,
  repo: string,
  repoId?: number,
): Promise<GithubReadSession> {
  return { actor, client: await readRouter().open(workspaceId, actor, repo, repoId) };
}

export async function openGraphqlReadSession(
  workspaceId: string,
  actor: ReadActor,
  repo: string,
  repoId?: number,
): Promise<{ actor: ReadActor; reader: GithubGraphqlReader }> {
  return { actor, reader: await readRouter().openGraphql(workspaceId, actor, repo, repoId) };
}
