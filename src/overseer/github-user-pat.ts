import { GithubError } from "./github";
import { createGithubUserCredential } from "./user-credentials";

export interface GithubPatIdentity {
  login: string;
  id: number;
  scopes: string[];
}

let identifyImpl: ((token: string) => Promise<GithubPatIdentity>) | null = null;

/** Exported so the seam can be exercised directly, including by the test that proves it
 *  is closed. Every other caller is inside this file. */
export async function identify(token: string): Promise<GithubPatIdentity> {
  if (identifyImpl) return identifyImpl(token);
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "User-Agent": "overseer",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new GithubError(`GitHub ${response.status} reading the token account.`, response.status, response.url);
  const body = await response.json() as { login?: string; id?: number };
  if (!body.login || !Number.isInteger(body.id)) throw new GithubError("GitHub returned an invalid token account.", 502, response.url);
  return {
    login: body.login,
    id: body.id!,
    scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean),
  };
}

/** Test seam: verification remains a real /user request unless explicitly replaced. The
 *  suite replaces it at preload, because the request would carry a pasted token. */
export function setGithubPatIdentifier(value: ((token: string) => Promise<GithubPatIdentity>) | null): void {
  identifyImpl = value;
}

export async function handlePasteGithubToken(req: Request, userId: string, returnTo: string): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  if (token.startsWith("ghp_")) return new Response("Classic GitHub tokens are not accepted. Use a fine-grained token.", { status: 400 });
  if (!token.startsWith("github_pat_")) return new Response("Enter a fine-grained GitHub token (github_pat_…).", { status: 400 });
  if (label.length > 80) return new Response("Invalid credential label", { status: 400 });
  try {
    const identity = await identify(token);
    createGithubUserCredential({
      userId,
      kind: "pat",
      label: label || identity.login,
      secret: token,
      accountLogin: identity.login,
      accountId: identity.id,
      scopes: identity.scopes,
    });
  } catch (error) {
    const status = error instanceof GithubError ? error.status : 502;
    return new Response(`GitHub would not authenticate this token (${status}). Nothing was connected.`, { status: status === 401 || status === 403 ? 400 : 502 });
  }
  return new Response(null, { status: 303, headers: { location: returnTo } });
}
