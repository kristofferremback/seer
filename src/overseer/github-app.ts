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
        routing.set(key, { installationId: null, until: now() + ROUTING_TTL_MS });
        return null;
      }
      if (!res.ok) await failed(res, `${base}${path}`);
      const body = (await res.json()) as InstallationResponse;
      routing.set(key, { installationId: body.id, until: now() + ROUTING_TTL_MS });
      return body.id;
    },

    async installationToken(installationId, scope) {
      // The cache is keyed by installation *and* scope: a token minted for one
      // repository is not usable for another, so sharing one entry would hand a
      // caller a credential that 404s on everything it asks for.
      const scopeKey =
        scope.repositoryIds?.join(",") ?? scope.repositories?.join(",").toLowerCase() ?? "*";
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
      return minted.token;
    },

    noteRepositoryId(repo, id) {
      if (Number.isInteger(id) && id > 0) repoIds.set(repo.toLowerCase(), id);
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

/** A refusal that is about who may read what, rather than about GitHub being unhappy. */
export class GithubRoutingError extends GithubError {
  constructor(message: string) {
    super(message, 422, "");
    this.name = "GithubRoutingError";
  }
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
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A GithubClient bound to one workspace. Every method routes its own `repo` and mints
 * its own token, so the refusal is at the transport rather than in front of it: whatever
 * the validator allows later, a call for a repository this workspace does not hold never
 * acquires a credential to make it with.
 */
export function createWorkspaceGithubClient(options: WorkspaceClientOptions): GithubClient {
  const { workspaceId, holdings, app } = options;

  async function authorize(repo: string): Promise<GithubClient> {
    assertRepo(repo);
    const installationId = await app.installationForRepo(repo);
    if (installationId === null) {
      throw new GithubRoutingError(
        `No GitHub App installation covers ${repo}. Install the app on that account, then connect it to this workspace.`,
      );
    }
    const held = await holdings.installationIds(workspaceId);
    if (!held.includes(installationId)) {
      throw new GithubRoutingError(
        `This workspace does not hold the GitHub App installation that covers ${repo}. Connect that account in workspace settings.`,
      );
    }
    const id = app.repositoryId(repo);
    const token = await app.installationToken(
      installationId,
      id === undefined ? { repositories: [repo.split("/")[1]!] } : { repositoryIds: [id] },
    );
    return createFetchGithubClient({
      token,
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  return {
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
  };
}

// ---- the injection seam, which is a factory rather than a singleton ----
//
// "A client built for the workspace" cannot be a process-global instance, so the seam
// tests install is a factory. tests/setup.ts installs one that cannot reach a network,
// which is the successor to setGithubClient()'s offline default: without it a routing
// lookup would make a real request with real app credentials, silently, because a 404
// from routing is indistinguishable from "not installed".

export type GithubClientFactory = (workspaceId: string) => GithubClient;

let injectedFactory: GithubClientFactory | null = null;
let holdingsSource: WorkspaceHoldings | null = null;
let defaultApp: AppApi | null = null;

/** Step 2 installs the database-backed implementation here at boot. */
export function setWorkspaceHoldings(holdings: WorkspaceHoldings | null): void {
  holdingsSource = holdings;
  defaultApp = null;
}

export function appCredentials(): AppCredentials {
  const app = config.githubApp;
  if (!app) {
    throw new Error(
      "GitHub App is not configured: set GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_WEBHOOK_SECRET.",
    );
  }
  return { appId: app.appId, privateKeyPem: app.privateKeyPem };
}

export function githubClientFor(workspaceId: string): GithubClient {
  if (injectedFactory) return injectedFactory(workspaceId);
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
  });
}

export function setGithubClientFactory(factory: GithubClientFactory | null): void {
  injectedFactory = factory;
}
