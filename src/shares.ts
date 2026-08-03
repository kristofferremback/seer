// Shares: one revocable, read-only link to one asset in a workspace, for someone who
// is not in that workspace. docs/shares.md is the design; this is the whole of it that
// is code, in three parts — the storage, the API a member mints and revokes with, and
// the read route a holder opens.
//
// The token is the row's identity and its secret at once, exactly as an API key is. It
// is minted with the same generator, hashed with the same function, stored only as that
// hash, and returned once. Everything the resolver needs hangs off the hash lookup, so
// a database copy is a list of what was shared rather than a set of working links.
//
// Three rules run through the rest of it. A share is never a write: it resolves to a
// workspace and an asset and to no identity at all, so every write path keeps asking
// for the session or the key it already asks for and there is no branch here to forget.
// A share is never a login: following one creates no session and joins no workspace. And
// every way of not being a live share answers identically — unknown, revoked and expired
// are one response with one set of bytes, or revocation becomes a way to confirm that
// something was there.

import { config } from "./config";
import { sessionUser } from "./auth";
import { db, getBundle, isMember } from "./db";
import { hashKey, newShareToken, tinyId, SHARE_TOKEN_RE, SHR_ID_RE, WS_ID_RE } from "./ids";
import { getReview } from "./overseer/db";
import {
  handleSharedReviewAttachment,
  handleSharedReviewPage,
  softNotFound as reviewSoftNotFound,
} from "./overseer/render";

// ---- the shape ----

export type ShareKind = "review" | "bundle";

/** The kinds a share may name. Closed, and the same list the table's CHECK holds:
 *  a resolver dispatches on this, so a row naming anything else is a link that cannot
 *  open. */
export const SHARE_KINDS: readonly ShareKind[] = ["review", "bundle"];

/** The kinds the read route actually serves today.
 *
 *  THE BUNDLE GAP. Reviews are here; bundles are not, and minting one is refused rather
 *  than half-built. A bundle is a tree of files served under a path whose every relative
 *  URL resolves against it, so serving one through `/s/<token>` means the trailing-slash
 *  redirect, the asset remainder, the version pin and the live-reload channel all
 *  rewritten onto the token path. That is a route, not a resolver call, and it buys
 *  nothing yet: a bundle is public by link today, so no bundle needs a share to be
 *  sendable. When private bundles exist, this is the line that changes and
 *  handleShare() below is where the second branch goes. */
export const SERVED_SHARE_KINDS: readonly ShareKind[] = ["review"];

export interface ShareRow {
  id: string;
  workspace_id: string;
  kind: ShareKind;
  target: string;
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

// Every column but the secret. No query in this module selects token_hash: a share row
// leaves storage without its token by construction rather than by each caller
// remembering to drop it.
const SHARE_COLS =
  "id, workspace_id, kind, target, label, created_by, created_at, expires_at, revoked_at";

// ---- storage ----

/** Mint a share. Only the token's hash is stored; the raw token is returned once and is
 *  not recoverable after. */
export function createShare(args: {
  wsId: string;
  kind: ShareKind;
  target: string;
  label: string;
  userId: string;
  expiresAt: number | null;
}): { id: string; token: string } {
  const token = newShareToken();
  const id = tinyId("shr");
  db.run(
    "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at, expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, args.wsId, args.kind, args.target, args.label, hashKey(token), args.userId, Date.now(), args.expiresAt],
  );
  return { id, token };
}

/** A workspace's shares, newest first, revoked ones left out. Never carries a token. */
export function listShares(wsId: string): ShareRow[] {
  return db
    .query<ShareRow, [string]>(
      `SELECT ${SHARE_COLS} FROM shares WHERE workspace_id = ? AND revoked_at IS NULL ` +
        "ORDER BY created_at DESC",
    )
    .all(wsId);
}

export function getShare(id: string): ShareRow | null {
  return db.query<ShareRow, [string]>(`SELECT ${SHARE_COLS} FROM shares WHERE id = ?`).get(id);
}

/** Revocation stamps the row rather than deleting it, so a link that was handed out and
 *  taken back stays auditable. Guarded on revoked_at IS NULL, so a double submit cannot
 *  rewrite the moment it happened. */
export function revokeShare(id: string): void {
  db.run("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [Date.now(), id]);
}

/** The row behind a token whatever state it is in, or null when no such token was ever
 *  minted. Only the one documented exception reads this: a member of the owning
 *  workspace following a dead link is sent to the asset, because for them it exists.
 *  Every other caller wants resolveShare(). */
export function lookupShare(token: string): ShareRow | null {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  return db
    .query<ShareRow, [string]>(`SELECT ${SHARE_COLS} FROM shares WHERE token_hash = ?`)
    .get(hashKey(token));
}

/** The live share a token names, or null. Unknown, revoked and expired are all null:
 *  nothing downstream may tell them apart, so nothing downstream is told. */
export function resolveShare(token: string): ShareRow | null {
  const row = lookupShare(token);
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
  return row;
}

// ---- the read route ----

/** Every refusal on `/s/` is the review soft-404, which is the page a private review
 *  already gives a stranger. One response for the whole path, whatever kind the token
 *  named: an unknown token names no kind at all, so a per-kind refusal would say which
 *  tokens exist. */
function softNotFound(): Response {
  return withShareHeaders(reviewSoftNotFound());
}

/** `Referrer-Policy: no-referrer` on everything this route answers. A shared page is
 *  read by someone holding a secret in their address bar; following any link out of it
 *  must not hand that secret to a third party. Set here rather than in the renderer so
 *  it cannot be true of the page and false of the refusal. */
function withShareHeaders(res: Response): Response {
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}

/**
 * GET /s/:token, GET /s/:token/v/:n and GET /s/:token/a/:id.
 *
 * The asset renders exactly as its private route renders it, with three differences the
 * renderer is told about rather than asked to infer: the page hangs off `/s/<token>` so
 * every link on it is one the holder can follow, it carries no annotations, and it
 * offers no write.
 */
export async function handleShare(
  req: Request,
  token: string,
  version: string | null,
  attachment: string | null,
): Promise<Response> {
  const share = resolveShare(token);
  if (!share) return deadShare(req, token);
  if (!SERVED_SHARE_KINDS.includes(share.kind)) return softNotFound();

  if (attachment !== null) {
    return withShareHeaders(
      await handleSharedReviewAttachment(share.workspace_id, share.target, attachment),
    );
  }
  // `?from=` is the only thing this route reads off the request, and it moves the
  // version the page's marks are measured against and nothing else. Without it the
  // revision menu on a shared page would draw controls that do nothing.
  const from = new URL(req.url).searchParams.get("from");
  return withShareHeaders(
    handleSharedReviewPage(share.workspace_id, share.target, version, `/s/${token}`, from),
  );
}

/** A token that is unknown, revoked or expired. The one exception in the design: a
 *  reader who plainly has a session for the owning workspace is sent to the asset
 *  itself, because for them it does exist and telling them otherwise is a lie a member
 *  can disprove by opening the ledger. Everyone else, and every unknown token, gets the
 *  one refusal. */
function deadShare(req: Request, token: string): Response {
  const row = lookupShare(token);
  if (row && row.kind === "review") {
    const user = sessionUser(req);
    if (user && isMember(row.workspace_id, user.id)) {
      return withShareHeaders(
        new Response(null, {
          status: 302,
          headers: { location: `/${row.workspace_id}/r/${row.target}` },
        }),
      );
    }
  }
  return softNotFound();
}

// ---- the API ----

interface ApiError {
  field: string;
  rule: string;
  message: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unprocessable(errors: ApiError[]): Response {
  return json({ error: "The share was not created", errors }, 422);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL_MAX = 80;

/** The workspace a request names, once membership is checked. A member reaches their
 *  own workspaces and no others; a non-member and a workspace that does not exist are
 *  one answer, as everywhere else. */
function memberWorkspace(req: Request, wsId: unknown): { ws: string; userId: string } | Response {
  const user = sessionUser(req);
  if (!user) return new Response(JSON.stringify({ error: "Sign in required" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  if (typeof wsId !== "string" || !WS_ID_RE.test(wsId)) {
    return unprocessable([
      { field: "workspace", rule: "workspace_missing", message: "workspace is required and must be a ws_ id" },
    ]);
  }
  if (!isMember(wsId, user.id)) {
    return json({ error: "No such workspace" }, 404);
  }
  return { ws: wsId, userId: user.id };
}

/** An `expiresAt` as a body may write it: an epoch in milliseconds or an ISO 8601
 *  string. Null means no expiry, which is the default the design takes. */
function readExpiry(raw: unknown): { at: number | null } | ApiError {
  if (raw === undefined || raw === null || raw === "") return { at: null };
  const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) {
    return {
      field: "expiresAt",
      rule: "expires_unreadable",
      message: "expiresAt must be an epoch in milliseconds or an ISO 8601 timestamp",
    };
  }
  if (at <= Date.now()) {
    return {
      field: "expiresAt",
      rule: "expires_past",
      message: "expiresAt is in the past, so the link would be dead on arrival",
    };
  }
  return { at };
}

/** Whether an asset a share would name is actually there. A target that does not exist
 *  in that workspace is a 422 rather than a link that opens onto the soft-404. */
function targetExists(wsId: string, kind: ShareKind, target: string): boolean {
  return kind === "review" ? !!getReview(wsId, target) : !!getBundle(wsId, target);
}

/** POST /api/shares: mint one, and hand back the URL rather than the bare token,
 *  because the URL is the thing a person actually wants. */
export async function handleCreateShare(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Body must be a JSON object: { workspace, kind, target, label?, expiresAt? }" }, 400);
  }

  const gate = memberWorkspace(req, body.workspace);
  if (gate instanceof Response) return gate;

  const errors: ApiError[] = [];
  const kind = body.kind;
  const kindOk = typeof kind === "string" && (SHARE_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    errors.push({
      field: "kind",
      rule: "kind_unknown",
      message: `kind must be one of ${SHARE_KINDS.join(", ")}`,
    });
  } else if (!(SERVED_SHARE_KINDS as readonly string[]).includes(kind as string)) {
    // See SERVED_SHARE_KINDS: a bundle share would mint a link no route opens, and a
    // link that cannot be followed is worse than a refusal that says why.
    errors.push({
      field: "kind",
      rule: "kind_not_served",
      message: `kind ${kind} cannot be shared yet; a bundle is public by link, so it needs no share`,
    });
  }

  const target = body.target;
  if (typeof target !== "string" || !SLUG_RE.test(target)) {
    errors.push({
      field: "target",
      rule: "target_malformed",
      message: "target is required and must match [a-z0-9][a-z0-9-]{0,63}",
    });
  } else if (kindOk && !targetExists(gate.ws, kind as ShareKind, target)) {
    // A target in another workspace lands here too, and says the same thing: this
    // workspace has no such asset. What another workspace holds is not this reply's
    // to disclose.
    errors.push({
      field: "target",
      rule: "target_unknown",
      message: `${gate.ws} has no ${String(kind)} called ${target}`,
    });
  }

  const label = body.label === undefined || body.label === null ? "" : body.label;
  if (typeof label !== "string" || label.length > LABEL_MAX) {
    errors.push({
      field: "label",
      rule: "label_length",
      message: `label must be a string of at most ${LABEL_MAX} characters`,
    });
  }

  const expiry = readExpiry(body.expiresAt);
  if ("field" in expiry) errors.push(expiry);

  if (errors.length > 0) return unprocessable(errors);

  const { id, token } = createShare({
    wsId: gate.ws,
    kind: kind as ShareKind,
    target: target as string,
    label: label as string,
    userId: gate.userId,
    expiresAt: (expiry as { at: number | null }).at,
  });
  return json({
    id,
    workspace: gate.ws,
    kind,
    target,
    label,
    expiresAt: (expiry as { at: number | null }).at,
    token,
    url: `${config.baseUrl}/s/${token}`,
  });
}

/** GET /api/shares?workspace=ws_…: what this workspace has shared. No tokens: only
 *  their hashes survived the mint, and a list that could hand one back would undo the
 *  whole point of hashing them. */
export function handleListShares(req: Request): Response {
  const wsId = new URL(req.url).searchParams.get("workspace");
  const gate = memberWorkspace(req, wsId);
  if (gate instanceof Response) return gate;
  return json({
    workspace: gate.ws,
    shares: listShares(gate.ws).map((s) => ({
      id: s.id,
      kind: s.kind,
      target: s.target,
      label: s.label,
      createdBy: s.created_by,
      createdAt: new Date(s.created_at).toISOString(),
      expiresAt: s.expires_at === null ? null : new Date(s.expires_at).toISOString(),
    })),
  });
}

/** DELETE /api/shares/:id. A share in a workspace the caller is not in is a 404, the
 *  same answer an id that never existed gets. */
export function handleRevokeShare(req: Request, id: string): Response {
  const user = sessionUser(req);
  if (!user) {
    return json({ error: "Sign in required" }, 403);
  }
  const share = SHR_ID_RE.test(id) ? getShare(id) : null;
  if (!share || !isMember(share.workspace_id, user.id)) return json({ error: "No such share" }, 404);
  revokeShare(id);
  return json({ id, revoked: true });
}
