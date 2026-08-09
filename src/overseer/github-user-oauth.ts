import { config } from "../config";
import { GithubError } from "./github";

export interface GithubOAuthIdentity {
  token: string;
  login: string;
  id: number;
  scopes: string[];
  expiresAt: number | null;
}

export interface GithubUserOAuth {
  exchangeAndIdentify(code: string): Promise<GithubOAuthIdentity>;
}

export function createFetchGithubUserOAuth(options: {
  clientId: string;
  clientSecret: string;
  apiBase?: string;
  loginBase?: string;
  fetchImpl?: typeof fetch;
}): GithubUserOAuth {
  const TIMEOUT_MS = 20_000;
  const api = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const login = (options.loginBase ?? "https://github.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async exchangeAndIdentify(code) {
      // Both legs carry the timeout the sibling transport already had. A hung GitHub
      // connection would otherwise hold a Seer request open with no bound at all, and
      // this one runs inside a person's browser navigation rather than a detached task.
      const tokenResponse = await doFetch(`${login}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret, code }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const tokenBody = await tokenResponse.json() as { access_token?: string; expires_in?: number; scope?: string; error?: string };
      if (!tokenResponse.ok || !tokenBody.access_token) throw new GithubError(`GitHub would not exchange the OAuth code (${tokenBody.error ?? tokenResponse.status}).`, tokenResponse.status || 400, tokenResponse.url);
      const userResponse = await doFetch(`${api}/user`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "overseer" } });
      if (!userResponse.ok) throw new GithubError(`GitHub ${userResponse.status} reading the OAuth account.`, userResponse.status, userResponse.url);
      const user = await userResponse.json() as { login?: string; id?: number };
      if (!user.login || !Number.isInteger(user.id)) throw new GithubError("GitHub returned an invalid OAuth account.", 502, userResponse.url);
      const scopeText = userResponse.headers.get("x-oauth-scopes") ?? tokenBody.scope ?? "";
      return { token: tokenBody.access_token, login: user.login, id: user.id!, scopes: scopeText.split(",").map(s => s.trim()).filter(Boolean), expiresAt: tokenBody.expires_in ? Date.now() + tokenBody.expires_in * 1000 : null };
    },
  };
}

let injected: GithubUserOAuth | null = null;
let defaultTransport: GithubUserOAuth | null = null;
export function githubUserOAuth(): GithubUserOAuth {
  if (injected) return injected;
  defaultTransport ??= createFetchGithubUserOAuth(config.githubOAuth);
  return defaultTransport;
}
export function setGithubUserOAuth(value: GithubUserOAuth | null): void { injected = value; }
