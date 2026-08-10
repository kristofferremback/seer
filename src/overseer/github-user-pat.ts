import { EnvelopeError } from "../envelope";
import { GithubError } from "./github";
import { createGithubUserCredential } from "./user-credentials";

export interface GithubPatIdentity {
  login: string;
  id: number;
  /** When GitHub will stop accepting the token, epoch ms; null when it said nothing.
   *
   *  Worth storing rather than inferring, because `expires_at` is what tells an expiry
   *  apart from a revocation once GitHub starts answering 401 — and those have different
   *  remedies. Without it every dead credential reads as revoked (github-user.ts,
   *  `dead()`), and settings can never warn ahead of time (server.ts, `isExpired`).
   *
   *  Deliberately NOT scopes. A fine-grained token's permissions are not on this response
   *  and are not readable through any endpoint: `x-oauth-scopes` is a classic-token
   *  header, and this path refuses classic tokens outright. Reading it here yielded an
   *  empty array for every credential, which is indistinguishable from "no permissions"
   *  to anything that later trusts the column. */
  expiresAt: number | null;
}

/**
 * Parse GitHub's `github-authentication-token-expiration` into epoch ms.
 *
 * The header is not ISO 8601 and its exact form has varied — `2026-02-01 15:22:33 UTC`
 * and `2026-02-01 15:22:33 +0100` have both been sent. Normalising the two known shapes
 * is cheaper than trusting an engine's tolerance for a format no spec covers.
 *
 * Returns null on anything unrecognised, and never throws. A token Seer cannot date is
 * still a token that works, so failing to read this must not be what stops it connecting.
 */
export function parseTokenExpiry(raw: string | null): number | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  const normalized = text
    .replace(" ", "T")                              // date/time separator, first space only
    .replace(/\s*UTC$/i, "Z")                       // "… 15:22:33 UTC"
    .replace(/\s*([+-]\d{2})(\d{2})$/, "$1:$2");    // "… 15:22:33 +0100"
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
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
    expiresAt: parseTokenExpiry(response.headers.get("github-authentication-token-expiration")),
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
  // Two failures, two catches, deliberately. One try around both would let a local
  // failure -- an unconfigured keyring, a missing table -- be reported as GitHub
  // refusing the token, which sends the person to GitHub to reissue a credential that
  // was never the problem. That is not hypothetical: it is how the first fine-grained
  // token connected to this instance appeared to fail, with SEER_ENCRYPTION_KEYS unset
  // and GitHub having answered perfectly well.
  let identity: GithubPatIdentity;
  try {
    identity = await identify(token);
  } catch (error) {
    const status = error instanceof GithubError ? error.status : 502;
    return new Response(`GitHub would not authenticate this token (${status}). Nothing was connected.`, { status: status === 401 || status === 403 ? 400 : 502 });
  }

  try {
    createGithubUserCredential({
      userId,
      kind: "pat",
      label: label || identity.login,
      secret: token,
      accountLogin: identity.login,
      accountId: identity.id,
      // Empty because a fine-grained token's permissions are not knowable here, not
      // because it has none -- see GithubPatIdentity. The OAuth path fills this in; on
      // this path nothing should read it as an answer.
      scopes: [],
      expiresAt: identity.expiresAt,
    });
  } catch (error) {
    // Logged whatever it was, because past this line the token verified and the fault is
    // ours. The reader of this log is the person running the instance.
    console.error(`[seer] storing a verified GitHub credential for ${userId} failed: ${String(error)}`);
    // EnvelopeError's messages are written for exactly this reader and name the variable
    // to set, so they are passed through rather than flattened into "something failed".
    // They carry no secret: the worst they disclose is which key ids are configured.
    const detail = error instanceof EnvelopeError ? ` ${error.message}` : "";
    return new Response(
      `GitHub accepted this token, but Seer could not store it. Nothing was connected.${detail}`,
      { status: 500 },
    );
  }
  return new Response(null, { status: 303, headers: { location: returnTo } });
}
