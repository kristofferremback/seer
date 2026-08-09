import {
  assertRepo,
  createFetchGithubClient,
  GithubError,
  type GithubClient,
} from "./github";
import {
  getGithubUserCredential,
  listGithubUserCredentials,
  markGithubUserCredentialDead,
  openGithubUserCredential,
  touchGithubUserCredential,
} from "./user-credentials";
import {
  GithubCredentialDeadError,
  GithubRoutingError,
  NEGATIVE_ROUTING_TTL_MS,
  ROUTING_TTL_MS,
} from "./github-app";

/** Lives with the other refusals in github-app.ts, which this module and that one both
 *  need; re-exported here because this is where it is thrown. */
export { GithubCredentialDeadError } from "./github-app";

const API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface UserGithubClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * A client bound to one person. Authorization deliberately lives inside every method:
 * no caller can obtain a token-bearing client and then use it for a different repository.
 */
export function createUserGithubClient(
  userId: string,
  options: UserGithubClientOptions = {},
): GithubClient {
  const base = (options.apiBase ?? API).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const routing = new Map<string, { credentialId: string | null; until: number }>();

  /** Records the death, drops every route pointing at it, and says which credential and
   *  which fix. Expiry and revocation are told apart by the stored `expires_at` because
   *  the remedies differ: one is reconnected here, the other is granted again at GitHub. */
  function dead(credentialId: string): GithubCredentialDeadError {
    markGithubUserCredentialDead(credentialId, userId, now());
    for (const [key, entry] of routing) {
      if (entry.credentialId === credentialId) routing.delete(key);
    }
    const row = getGithubUserCredential(credentialId, userId);
    const who = row ? `${row.account_login} ("${row.label}")` : credentialId;
    const expired = row?.expires_at != null && row.expires_at <= now();
    return new GithubCredentialDeadError(
      credentialId,
      expired
        ? `Your GitHub credential for ${who} has expired, so GitHub refused it. Connect a new ` +
          "one in settings."
        : `Your GitHub credential for ${who} was revoked at GitHub, so GitHub refused it. ` +
          "Reconnect the account in settings.",
    );
  }

  async function probe(repo: string, credentialId: string, token: string): Promise<boolean> {
    const url = `${base}/repos/${repo}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "overseer",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GithubError(`GitHub request to ${url} failed: ${String(error)}`, 0, url);
    }
    if (response.status === 404) return false;
    if (response.ok) return true;
    if (response.status === 401) throw dead(credentialId);
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new GithubError(
      `GitHub ${response.status} while checking credential ${credentialId} for ${repo}: ${body}`,
      response.status,
      url,
    );
  }

  /** The probe is not the only place a credential can be refused: it can be revoked
   *  between the probe and the read. Only calls made with a user credential's token pass
   *  through here, so an anonymous or installation 401 -- neither of which has a
   *  credential to blame -- can never mark anything dead. */
  function guarded(credentialId: string, token: string): GithubClient {
    const client = createFetchGithubClient({ token, apiBase: base, fetchImpl: doFetch, timeoutMs });
    const guard = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (err instanceof GithubError && err.status === 401) throw dead(credentialId);
        throw err;
      }
    };
    return {
      getPull: (r, n) => guard(() => client.getPull(r, n)),
      listCommits: (r, n) => guard(() => client.listCommits(r, n)),
      listFiles: (r, n) => guard(() => client.listFiles(r, n)),
      listReviewComments: (r, n) => guard(() => client.listReviewComments(r, n)),
      getFileAtSha: (r, p, sha) => guard(() => client.getFileAtSha(r, p, sha)),
      getPullDiff: (r, n) => guard(() => client.getPullDiff(r, n)),
    };
  }

  async function authorize(repo: string): Promise<GithubClient | null> {
    assertRepo(repo);
    const key = repo.toLowerCase();
    const hit = routing.get(key);
    if (hit && hit.until > now()) {
      if (hit.credentialId === null) return null;
      const token = openGithubUserCredential(hit.credentialId, userId);
      if (token) {
        touchGithubUserCredential(hit.credentialId, userId, now());
        return guarded(hit.credentialId, token);
      }
      routing.delete(key);
    }

    for (const credential of listGithubUserCredentials(userId)) {
      const token = openGithubUserCredential(credential.id, userId);
      if (!token) continue;
      if (await probe(repo, credential.id, token)) {
        routing.set(key, { credentialId: credential.id, until: now() + ROUTING_TTL_MS });
        touchGithubUserCredential(credential.id, userId, now());
        return guarded(credential.id, token);
      }
    }
    routing.set(key, { credentialId: null, until: now() + NEGATIVE_ROUTING_TTL_MS });
    return null;
  }

  async function required(repo: string): Promise<GithubClient> {
    const client = await authorize(repo);
    if (!client) {
      throw new GithubRoutingError(
        `No GitHub App installation held by this workspace or connected GitHub account can read ${repo}. ` +
          "Install and connect the App, or connect an account that can read it.",
      );
    }
    return client;
  }

  return {
    async getPull(repo, number) { return (await required(repo)).getPull(repo, number); },
    async listCommits(repo, number) { return (await required(repo)).listCommits(repo, number); },
    async listFiles(repo, number) { return (await required(repo)).listFiles(repo, number); },
    async listReviewComments(repo, number) { return (await required(repo)).listReviewComments(repo, number); },
    async getFileAtSha(repo, path, sha) { return (await required(repo)).getFileAtSha(repo, path, sha); },
    async getPullDiff(repo, number) { return (await required(repo)).getPullDiff(repo, number); },
  };
}
