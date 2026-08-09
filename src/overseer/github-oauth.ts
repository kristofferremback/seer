// The user-authorization leg, which is a different kind of conversation with GitHub
// and therefore a different seam.
//
// A GithubClient acts as an installation and answers questions about pull requests.
// This acts as *a person*, exactly once, at claim time, to answer the only question
// that binds a Seer user to an installation: which installations can you actually
// reach? Nothing here fits GithubClient's shape, so forcing it through that interface
// would buy one seam and lose the meaning of both.
//
// The token this produces is used to ask that question and then dropped. It is never
// written anywhere — see "Secrets, and what is stored" in docs/overseer/github-app.md.

import { config } from "../config";
import { GithubError, nextLink } from "./github";

export interface GithubAccount {
  id: number;
  login: string;
  type: string;
}

export interface UserInstallation {
  id: number;
  account: GithubAccount | null;
  repository_selection?: string;
}

export interface GithubOAuth {
  /** Exchanges the callback's `code` for a user access token. */
  exchangeCode(code: string): Promise<string>;
  /** `GET /user/installations` as that person. The proof, and the only one there is. */
  listUserInstallations(userToken: string): Promise<UserInstallation[]>;
}

export interface FetchGithubOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests and for GitHub Enterprise. No trailing slash. */
  apiBase?: string;
  loginBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const API = "https://api.github.com";
const LOGIN = "https://github.com";
const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
/** A person on more installations than this is not a case the claim flow can serve. */
const MAX_PAGES = 20;

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

export function createFetchGithubOAuth(options: FetchGithubOAuthOptions): GithubOAuth {
  const apiBase = (options.apiBase ?? API).replace(/\/$/, "");
  const loginBase = (options.loginBase ?? LOGIN).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  return {
    async exchangeCode(code) {
      const url = `${loginBase}/login/oauth/access_token`;
      const res = await doFetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new GithubError(`GitHub ${res.status} exchanging the OAuth code.`, res.status, url);
      }
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!body.access_token) {
        // GitHub answers 200 with an error body here, so a bad code is a failure only
        // if the absent token is treated as one.
        throw new GithubError(
          `GitHub returned no access token for the OAuth code (${body.error ?? "no reason given"}).`,
          400,
          url,
        );
      }
      return body.access_token;
    },

    async listUserInstallations(userToken) {
      // Paged, because this list is the whole proof: an installation past the first page
      // would be one the claim flow tells the person they do not have.
      const out: UserInstallation[] = [];
      let next: string | null = `${apiBase}/user/installations?per_page=${PER_PAGE}`;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const url: string = next;
        const res: Response = await doFetch(url, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "overseer",
            Authorization: `Bearer ${userToken}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          throw new GithubError(`GitHub ${res.status} for ${url}.`, res.status, url);
        }
        const body = (await res.json()) as { installations?: UserInstallation[] };
        out.push(...(body.installations ?? []));
        next = nextLink(res.headers.get("Link"));
        // The link comes out of a response body's headers, so it is checked against the
        // configured API before the person's token is sent to it.
        if (next) assertSameOrigin(next, apiBase);
      }
      if (next) {
        throw new GithubError(
          `More than ${MAX_PAGES} pages of installations (${PER_PAGE} per page).`,
          0,
          next,
        );
      }
      return out;
    },
  };
}

// ---- the second injection seam ----

let injected: GithubOAuth | null = null;
let lazyDefault: GithubOAuth | null = null;

export function githubOAuth(): GithubOAuth {
  if (injected) return injected;
  // config.ts requires the App variables at boot (see appCredentials): there is no
  // unconfigured server to guard against here.
  const app = config.githubApp;
  lazyDefault ??= createFetchGithubOAuth({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  });
  return lazyDefault;
}

export function setGithubOAuth(oauth: GithubOAuth | null): void {
  injected = oauth;
}
