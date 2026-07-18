import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { hashKey, tinyId } from "./ids";

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

export interface SessionUser {
  id: string;
  email: string;
}

/** The signed cookie now carries the user id (usr_…); same HMAC scheme as before. */
export function sessionCookie(userId: string): string {
  const exp = Date.now() + config.sessionTtlMs;
  const payload = `${Buffer.from(userId).toString("base64url")}.${exp}`;
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

/** Root email: first ALLOWED_EMAILS entry, else the dev fallback — matches migrate. */
function rootEmail(): string {
  return (config.allowedEmails[0] ?? "dev@localhost").toLowerCase();
}

function userById(id: string): SessionUser | null {
  return db
    .query<SessionUser, [string]>("SELECT id, email FROM users WHERE id = ?")
    .get(id);
}

function userByEmail(email: string): SessionUser | null {
  return db
    .query<SessionUser, [string]>("SELECT id, email FROM users WHERE email = ?")
    .get(email.toLowerCase());
}

/**
 * The signed-in user, or null. AUTH_DISABLED (local dev) resolves to the root user.
 * Old email-payload cookies decode to a non-existent id → db miss → re-login.
 */
export function sessionUser(req: Request): SessionUser | null {
  if (config.authDisabled) return userByEmail(rootEmail());
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const [idB64, expStr, sig] = raw.split(".");
  if (!idB64 || !expStr || !sig) return null;
  const payload = `${idB64}.${expStr}`;
  if (!sigEqual(sig, hmac(payload))) return null;
  if (Number(expStr) < Date.now()) return null;
  const id = Buffer.from(idB64, "base64url").toString();
  return userById(id);
}

/** Convenience: the signed-in email, or null. Wraps sessionUser. */
export function sessionEmail(req: Request): string | null {
  return sessionUser(req)?.email ?? null;
}

// ---- API keys ----

export interface ApiKeyAuth {
  keyId: string;
  userId: string;
  workspaceId: string;
}

const KEY_LAST_USED_THROTTLE_MS = 60_000;

/**
 * Authenticate a Bearer api key. Hash-indexed lookup: we SHA-256 the raw token and
 * match on the indexed token_hash, so there is no secret-dependent branching on the
 * raw input. Revoked keys are excluded. On a hit, last_used_at is bumped only if it
 * is null or older than 60s (avoids a write on every request). Miss → 401 JSON.
 */
export function requireApiKey(req: Request): ApiKeyAuth | Response {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (match) {
    const row = db
      .query<
        { id: string; user_id: string; workspace_id: string; last_used_at: number | null },
        [string]
      >(
        "SELECT id, user_id, workspace_id, last_used_at FROM api_keys " +
          "WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .get(hashKey(match[1]!));
    if (row) {
      const now = Date.now();
      if (row.last_used_at == null || now - row.last_used_at > KEY_LAST_USED_THROTTLE_MS) {
        db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, row.id]);
      }
      return { keyId: row.id, userId: row.user_id, workspaceId: row.workspace_id };
    }
  }
  return new Response(JSON.stringify({ error: "Invalid or missing API key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

// ---- invite acceptance ----

export interface AcceptedInvite {
  userId: string;
  workspaceId: string;
  created: boolean; // true when a new user row was minted
}

interface InviteRow {
  token: string;
  workspace_id: string;
  created_by: string;
  expires_at: number;
  accepted_at: number | null;
}

/** A valid invite: exists, not accepted, not expired. Null otherwise. */
export function lookupValidInvite(token: string): InviteRow | null {
  const inv = db
    .query<InviteRow, [string]>(
      "SELECT token, workspace_id, created_by, expires_at, accepted_at FROM invites WHERE token = ?",
    )
    .get(token);
  if (!inv) return null;
  if (inv.accepted_at != null) return null; // single-use
  if (inv.expires_at < Date.now()) return null;
  return inv;
}

/**
 * The one shared, Google-free invite-acceptance path. Validates the invite, creates
 * the user if needed, inserts the membership (INSERT OR IGNORE), and stamps the
 * invite accepted — all in one transaction. Single-use: a used or expired token is
 * invalid everywhere. Returns null when the token is not a valid invite.
 */
export const acceptInvite = db.transaction(
  (token: string, email: string): AcceptedInvite | null => {
    const inv = lookupValidInvite(token);
    if (!inv) return null;

    const e = email.toLowerCase();
    const now = Date.now();

    let user = userByEmail(e);
    let created = false;
    if (!user) {
      const id = tinyId("usr");
      db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [id, e, now]);
      user = { id, email: e };
      created = true;
    }

    db.run(
      "INSERT OR IGNORE INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)",
      [inv.workspace_id, user.id, now],
    );
    // Guard on accepted_at IS NULL so a concurrent accept can't double-stamp.
    db.run(
      "UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE token = ? AND accepted_at IS NULL",
      [user.id, now, token],
    );

    return { userId: user.id, workspaceId: inv.workspace_id, created };
  },
) as (token: string, email: string) => AcceptedInvite | null;

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

/** The token in a `/invite/<token>` next path, or null. */
function inviteTokenFromNext(next: string): string | null {
  const m = next.match(/^\/invite\/(inv_[0-9abcdefghjkmnpqrstvwxyz]{10})(?:\/accept)?\/?$/);
  return m ? m[1]! : null;
}

function sessionRedirect(userId: string, location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": sessionCookie(userId) },
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
  if (!email || !claims.email_verified) {
    return new Response("Google did not return a verified email.", { status: 403 });
  }

  // An invite in `next` lets a new or existing user join its workspace on sign-in.
  const inviteToken = inviteTokenFromNext(next);
  if (inviteToken) {
    const accepted = acceptInvite(inviteToken, email);
    if (accepted) return sessionRedirect(accepted.userId, "/bundles");
    // Invalid/expired/used invite: fall through to the plain login rules below.
  }

  const existing = userByEmail(email);
  if (existing) return sessionRedirect(existing.id, next);

  // No seat: not a known user, and no valid invite to earn one.
  return new Response("This account has no seat at Seer.", { status: 403 });
}

/** Redirect browser requests to login; used for all viewer-facing routes. */
export function requireSession(req: Request): Response | null {
  if (sessionUser(req)) return null;
  const url = new URL(req.url);
  return new Response(null, {
    status: 302,
    headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
  });
}
