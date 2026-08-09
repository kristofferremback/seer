import { sessionUser } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { hashKey, tinyId } from "../ids";
import { GithubError } from "./github";
import { githubUserOAuth } from "./github-user-oauth";
import { createGithubUserCredential } from "./user-credentials";

const TTL = 10 * 60 * 1000;
export const USER_OAUTH_CALLBACK_PATH = "/github/account/callback";

function secret(): string { return `seer_gua_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`; }

/** Both legs answer this when the pair is absent, rather than minting a claim that could
 *  never be exchanged, or sending a person to an authorize URL with no client_id. */
function notConfigured(): Response {
  return Response.json(
    {
      error: "github_user_oauth_not_configured",
      message:
        "Connecting a GitHub account with OAuth needs GITHUB_OAUTH_CLIENT_ID and " +
        "GITHUB_OAUTH_CLIENT_SECRET. Paste a fine-grained token instead.",
    },
    { status: 422, headers: { "cache-control": "no-store" } },
  );
}

export function handleConnectGithubAccount(userId: string): Response {
  const oauth = config.githubUserOAuth;
  if (!oauth) return notConfigured();
  const state = secret();
  const now = Date.now();
  db.run("DELETE FROM github_user_oauth_claims WHERE expires_at < ?", [now - TTL]);
  db.run("INSERT INTO github_user_oauth_claims (id,user_id,nonce_hash,created_at,expires_at) VALUES (?,?,?,?,?)", [tinyId("guo"), userId, hashKey(state), now, now + TTL]);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("scope", "repo");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${config.baseUrl}${USER_OAUTH_CALLBACK_PATH}`);
  return new Response(null, { status: 303, headers: { location: url.toString() } });
}

function answer(message: string, status: number): Response { return new Response(message, { status, headers: { "cache-control": "no-store" } }); }

export async function handleGithubAccountCallback(req: Request): Promise<Response> {
  if (!config.githubUserOAuth) return notConfigured();
  const user = sessionUser(req);
  if (!user) return answer("Sign in and start again from settings.", 403);
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const row = state ? db.query<{id:string;user_id:string;expires_at:number;consumed_at:number|null},[string]>("SELECT id,user_id,expires_at,consumed_at FROM github_user_oauth_claims WHERE nonce_hash = ?").get(hashKey(state)) : null;
  if (!row || row.consumed_at !== null || row.expires_at <= Date.now() || row.user_id !== user.id) return answer("This GitHub connection is not usable. Start again from settings.", 403);
  if (!code) return answer("GitHub sent no authorization code. Nothing was connected.", 400);
  try {
    const identity = await githubUserOAuth().exchangeAndIdentify(code);
    const stored = db.transaction(() => {
      const burned = db.run("UPDATE github_user_oauth_claims SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [Date.now(), row.id]).changes;
      if (!burned) return false;
      createGithubUserCredential({ userId: user.id, kind: "oauth", label: identity.login, secret: identity.token, accountLogin: identity.login, accountId: identity.id, scopes: identity.scopes, expiresAt: identity.expiresAt });
      return true;
    })();
    if (!stored) return answer("This GitHub connection is not usable. Start again from settings.", 403);
  } catch (err) {
    const status = err instanceof GithubError ? err.status : 502;
    return answer(`GitHub would not complete the connection (${status}). Nothing was connected.`, 502);
  }
  return new Response(null, { status: 303, headers: { location: "/bundles" } });
}
