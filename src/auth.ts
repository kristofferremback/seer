import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";

function hmac(data: string): string {
  return createHmac("sha256", config.sessionSecret).update(data).digest("base64url");
}

function sigEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- session cookie ----

const SESSION_COOKIE = "seer_session";
const STATE_COOKIE = "seer_oauth";

export function sessionCookie(email: string): string {
  const exp = Date.now() + config.sessionTtlMs;
  const payload = `${Buffer.from(email).toString("base64url")}.${exp}`;
  const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${payload}.${hmac(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Returns the signed-in email, or null if there is no valid session. */
export function sessionEmail(req: Request): string | null {
  if (config.authDisabled) return "dev@localhost";
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const [emailB64, expStr, sig] = raw.split(".");
  if (!emailB64 || !expStr || !sig) return null;
  const payload = `${emailB64}.${expStr}`;
  if (!sigEqual(sig, hmac(payload))) return null;
  if (Number(expStr) < Date.now()) return null;
  return Buffer.from(emailB64, "base64url").toString();
}

// ---- Google OIDC ----

export function loginRedirect(next: string): Response {
  const state = randomBytes(16).toString("hex");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
  });
  const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "set-cookie": `${STATE_COOKIE}=${state}:${encodeURIComponent(safeNext)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
    },
  });
}

export async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readCookie(req, STATE_COOKIE);
  if (!code || !state || !stateCookie) return new Response("Bad OAuth callback", { status: 400 });

  const [expectedState, encodedNext] = stateCookie.split(":");
  if (state !== expectedState) return new Response("OAuth state mismatch", { status: 400 });
  const next = decodeURIComponent(encodedNext ?? "/");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.baseUrl}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return new Response(`Token exchange failed: ${await tokenRes.text()}`, { status: 502 });
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return new Response("No id_token in response", { status: 502 });

  // The id_token came directly from Google's token endpoint over TLS, so we can
  // read its claims without signature verification.
  const claims = JSON.parse(
    Buffer.from(id_token.split(".")[1]!, "base64url").toString(),
  ) as { email?: string; email_verified?: boolean };

  const email = claims.email?.toLowerCase();
  if (!email || !claims.email_verified || !config.allowedEmails.includes(email)) {
    return new Response("This account is not allowed to view Seer.", { status: 403 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: next,
      "set-cookie": sessionCookie(email),
    },
  });
}

/** Redirect browser requests to login; used for all viewer-facing routes. */
export function requireSession(req: Request): Response | null {
  if (sessionEmail(req)) return null;
  const url = new URL(req.url);
  return new Response(null, {
    status: 302,
    headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
  });
}
