import {
  assertRepo,
  createFetchGithubClient,
  GithubError,
  type GithubClient,
} from "./github";
import {
  listGithubUserCredentials,
  openGithubUserCredential,
  touchGithubUserCredential,
} from "./user-credentials";
import {
  GithubRoutingError,
  NEGATIVE_ROUTING_TTL_MS,
  ROUTING_TTL_MS,
} from "./github-app";

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
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new GithubError(
      `GitHub ${response.status} while checking credential ${credentialId} for ${repo}: ${body}`,
      response.status,
      url,
    );
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
        return createFetchGithubClient({ token, apiBase: base, fetchImpl: doFetch, timeoutMs });
      }
      routing.delete(key);
    }

    for (const credential of listGithubUserCredentials(userId)) {
      const token = openGithubUserCredential(credential.id, userId);
      if (!token) continue;
      if (await probe(repo, credential.id, token)) {
        routing.set(key, { credentialId: credential.id, until: now() + ROUTING_TTL_MS });
        touchGithubUserCredential(credential.id, userId, now());
        return createFetchGithubClient({ token, apiBase: base, fetchImpl: doFetch, timeoutMs });
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
