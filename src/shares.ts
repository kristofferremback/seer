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
import { requireApiKey, sessionUser } from "./auth";
import { db, getBundle, getVersion, isMember } from "./db";
import { RAC_ID_RE, RSA_ID_RE, RSM_ID_RE, RVR_ID_RE, hashKey, newShareToken, tinyId, SHARE_TOKEN_RE, SHR_ID_RE, WS_ID_RE } from "./ids";
import { serveBundleFile, type BundleMeta } from "./serve-bundle";
import { getReview } from "./overseer/db";
import {
  CapabilityTargetError,
  capabilityAssetPath,
  createDocumentCapability,
  documentProjectionForShare,
  resolveCapabilityTargetForMint,
} from "./overseer/capability-db";
import { handleDocumentCapabilityRequest } from "./overseer/capability-read";
import {
  handleSharedReviewAttachment,
  handleSharedReviewPage,
  softNotFound as reviewSoftNotFound,
} from "./overseer/render";

// ---- the shape ----

export type LegacyShareKind = "review" | "bundle";
export type ShareKind = LegacyShareKind | "review_document" | "stack_document";

/** The kinds a share may name. Closed, and the same list the table's CHECK holds:
 *  a resolver dispatches on this, so a row naming anything else is a link that cannot
 *  open. */
export const SHARE_KINDS = ["review", "bundle", "review_document", "stack_document"] as const;

/** The kinds the read route actually serves. A kind in SHARE_KINDS but not here is one
 *  the resolver understands and no route opens, so minting it is refused rather than
 *  handing over a link that dead-ends: see handleCreateShare(). Both kinds are served
 *  today, so the guard is a standing check on the next kind rather than a live refusal,
 *  and it is deliberately kept — the mint and the read route must not drift. */
export const SERVED_SHARE_KINDS = SHARE_KINDS;

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
  kind: LegacyShareKind;
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

/** What a revocation has to reach besides the row: a live-reload socket opened by a
 *  holder of that share, which was authorised once at upgrade and would otherwise keep
 *  reporting that new versions exist. Handed in by the server rather than imported, so
 *  this module never has to know a server exists to be tested — the same shape
 *  setFreshnessPublisher() uses. */
type ShareRevokedHook = (shareId: string) => void;
let onShareRevoked: ShareRevokedHook | null = null;
export function setShareRevokedHook(fn: ShareRevokedHook): void {
  onShareRevoked = fn;
}

/** Revocation stamps the row rather than deleting it, so a link that was handed out and
 *  taken back stays auditable. Guarded on revoked_at IS NULL, so a double submit cannot
 *  rewrite the moment it happened.
 *
 *  Then it shuts whatever the token still holds open. A socket is authorised once, when
 *  it is upgraded, so without this a revoked holder keeps a live channel: the reload it
 *  is told to perform lands on the soft-404, but being told at all says a new version
 *  exists, and "a token that stops resolving stops reloading" would be true only of
 *  reconnections. */
export function revokeShare(id: string): void {
  db.run("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [Date.now(), id]);
  onShareRevoked?.(id);
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
  return withNoStoreShareHeaders(reviewSoftNotFound());
}

/** The two headers every answer on this route carries, refusal included — set here
 *  rather than in the renderers so they cannot be true of the page and false of the
 *  404.
 *
 *  `Referrer-Policy: no-referrer`, because a shared page is read by someone holding a
 *  secret in their address bar and following any link out of it must not hand that
 *  secret to a third party.
 *
 *  `X-Robots-Tag: noindex, nofollow`, because the other way a URL escapes is a crawler.
 *  A share link is meant to be pasted somewhere, and some of those somewheres are
 *  fetched by things that index what they find; a token in a search result is a
 *  revocation nobody performed. */
function withShareHeaders(res: Response): Response {
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}

function withNoStoreShareHeaders(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  return withShareHeaders(res);
}

/** A review's remainder: nothing, a version pin, or one attachment. Trailing slash
 *  optional; anything else under the token is not part of the review. */
const REVIEW_TAIL_RE = /^(?:(v|a)\/([^/]+))?\/?$/;

/** A bundle's remainder, when it opens with a version pin: `v/<n>` and then whatever
 *  the tree is asked for. `undefined` for the third group means the pin arrived without
 *  the trailing slash its relative URLs need. */
const BUNDLE_PIN_RE = /^v\/(\d+)(?:\/(.*))?$/;

/**
 * GET anything under `/s/`.
 *
 * The whole path is parsed here rather than by the router, because what the remainder
 * after the token means is not knowable until the token is resolved: `v/2/app.css` is a
 * pinned asset inside a bundle and a nonsense URL on a review. Resolve first, then read
 * the rest of the path as the kind it turned out to be.
 *
 * Either way the asset renders exactly as its private route renders it, with three
 * differences the renderer is told about rather than asked to infer: the page hangs off
 * `/s/<token>` so every link on it is one the holder can follow, it carries none of the
 * workspace's own conversation, and it offers no write.
 */
export async function handleShareRequest(req: Request): Promise<Response> {
  // Reading is the whole of what a share grants, so this route has no other verb. The
  // refusal is a plain 405 rather than the soft-404: it says nothing about the token,
  // which is not even looked at.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return withNoStoreShareHeaders(new Response("Method not allowed", { status: 405 }));
  }

  const url = new URL(req.url);
  const tail = url.pathname.slice("/s/".length);
  const cut = tail.indexOf("/");
  // `rest` is null when the URL ended at the token and "" when it ended at the token's
  // trailing slash. A bundle needs to tell those apart; a review does not care.
  const token = cut === -1 ? tail : tail.slice(0, cut);
  const rest = cut === -1 ? null : tail.slice(cut + 1);

  const share = resolveShare(token);
  if (!share) return deadShare(req, token);
  if (share.kind === "review") return sharedReview(req, share, token, rest);
  if (share.kind === "bundle") return sharedBundle(url, share, token, rest);
  if (share.kind === "review_document" || share.kind === "stack_document") {
    return withNoStoreShareHeaders(await handleDocumentCapabilityRequest(req, share, token, rest));
  }
  // A kind the resolver knows and no branch here serves. Unreachable while
  // SERVED_SHARE_KINDS and this switch agree, which is what the mint guard enforces.
  return softNotFound();
}

async function sharedReview(
  req: Request,
  share: ShareRow,
  token: string,
  rest: string | null,
): Promise<Response> {
  const parts = (rest ?? "").match(REVIEW_TAIL_RE);
  if (!parts) return softNotFound();
  const [, part, value] = parts;

  if (part === "a") {
    return withShareHeaders(
      await handleSharedReviewAttachment(share.workspace_id, share.target, value!),
    );
  }
  // `?from=` is the only thing this route reads off the request, and it moves the
  // version the page's marks are measured against and nothing else. Without it the
  // revision menu on a shared page would draw controls that do nothing.
  const from = new URL(req.url).searchParams.get("from");
  return withShareHeaders(
    handleSharedReviewPage(
      share.workspace_id,
      share.target,
      part === "v" ? value! : null,
      `/s/${token}`,
      from,
    ),
  );
}

/**
 * A shared bundle: the same tree the workspace path serves, rooted at the token.
 *
 * Everything the workspace route does with the path, this does with the token in front
 * of it — the trailing slash a bundle's relative URLs resolve against, the asset
 * remainder, the `/v/<n>` pin. The one thing it does differently is the live-reload
 * channel: the injected socket carries the token instead of the workspace, because the
 * holder is not a member and the membership gate would refuse them.
 */
async function sharedBundle(
  url: URL,
  share: ShareRow,
  token: string,
  rest: string | null,
): Promise<Response> {
  const bundle = getBundle(share.workspace_id, share.target);
  // A share outliving the bundle it names is the soft-404, same as a dead token: what
  // the workspace no longer holds is not this route's to describe.
  if (!bundle) return softNotFound();

  // Require the trailing slash on the bundle root, exactly as /<ws>/b/<slug> does, or
  // every relative URL in the page resolves one level too high.
  if (rest === null) {
    return withShareHeaders(
      new Response(null, { status: 302, headers: { location: `${url.pathname}/${url.search}` } }),
    );
  }

  const pin = rest.match(BUNDLE_PIN_RE);
  const pinned = pin !== null;
  const version = pinned ? Number(pin[1]) : bundle.latest_version;
  if (pinned && (version < 1 || version > bundle.latest_version)) return softNotFound();
  if (pinned && pin[2] === undefined) {
    return withShareHeaders(
      new Response(null, { status: 302, headers: { location: `${url.pathname}/${url.search}` } }),
    );
  }
  const file = pinned ? pin[2]! : rest;

  const meta: BundleMeta = {
    slug: share.target,
    version,
    updatedAt: getVersion(share.workspace_id, share.target, version)?.created_at ?? bundle.created_at,
    // No canonical URL: the only URL this page has is the token. See BundleMeta.url.
    url: null,
  };
  return withShareHeaders(
    await serveBundleFile(share.workspace_id, meta, file, {
      live: pinned ? null : { via: "share", token },
      shared: true,
    }),
  );
}

/** Where a member landing on a dead link is sent instead of the refusal: the asset's
 *  own URL, per kind. */
function assetPath(row: ShareRow): string | null {
  if (row.kind === "review") return `/${row.workspace_id}/r/${row.target}`;
  if (row.kind === "bundle") return `/${row.workspace_id}/b/${row.target}/`;
  return capabilityAssetPath(row);
}

/** A token that is unknown, revoked or expired. The one exception in the design: a
 *  reader who plainly has a session for the owning workspace is sent to the asset
 *  itself, because for them it does exist and telling them otherwise is a lie a member
 *  can disprove by opening the ledger. Everyone else, and every unknown token, gets the
 *  one refusal. */
function deadShare(req: Request, token: string): Response {
  const row = lookupShare(token);
  if (row) {
    const user = sessionUser(req);
    if (user && isMember(row.workspace_id, user.id)) {
      const path = assetPath(row);
      if (!path) return softNotFound();
      const response = new Response(null, { status: 302, headers: { location: path } });
      return row.kind === "review_document" || row.kind === "stack_document"
        ? withNoStoreShareHeaders(response)
        : withShareHeaders(response);
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

/**
 * The workspace a request names, once the caller is checked. Two credentials reach
 * here, and they name their workspace differently.
 *
 * A **session** reaches several workspaces, so it has to say which one, and a workspace
 * it is not a member of is a 404 — the same answer an id that never existed gets.
 *
 * An **API key** belongs to exactly one workspace, so it names one by existing; this is
 * the credential an agent holds, and it is the one that lets the agent that built a
 * bundle also hand out the link to it. `workspace` is optional for a key and must match
 * when given, so a key can never be pointed at a workspace it does not belong to. A
 * share token is not a credential here and never becomes one: it is not an API key, so
 * it fails this lookup like any other string.
 *
 * A key mints shares, and that is a real widening of what a leaked key can do — it can
 * already upload, but it could not read a private bundle's bytes, and a share it minted
 * can. That is the trade the capability is: an agent that publishes a preview can also
 * hand it to a reviewer, and the workspace can revoke either at any time.
 */
function callerWorkspace(req: Request, wsId: unknown): { ws: string; userId: string } | Response {
  const user = sessionUser(req);
  if (user) {
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

  // No session. An Authorization header is a claim to be an API key; anything else,
  // including no header at all, is asked to sign in.
  if (!req.headers.get("authorization")) return json({ error: "Sign in required" }, 403);
  const key = requireApiKey(req);
  if (key instanceof Response) return key;
  const named = wsId === undefined || wsId === null || wsId === "" ? key.workspaceId : wsId;
  if (named !== key.workspaceId) return json({ error: "No such workspace" }, 404);
  return { ws: key.workspaceId, userId: key.userId };
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
function targetExists(wsId: string, kind: LegacyShareKind, target: string): boolean {
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

  const gate = callerWorkspace(req, body.workspace);
  if (gate instanceof Response) return gate;

  const errors: ApiError[] = [];
  const kind = body.kind;
  const documentKind = kind === "review_document" || kind === "stack_document";
  if (documentKind) {
    const extra = Object.keys(body).find((field) => !["workspace", "kind", "target", "label", "expiresAt"].includes(field));
    if (extra) errors.push({ field: extra, rule: "field_unknown", message: `${extra} is not a supported share field` });
  }
  const kindOk = typeof kind === "string" && (SHARE_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    errors.push({
      field: "kind",
      rule: "kind_unknown",
      message: `kind must be one of ${SHARE_KINDS.join(", ")}`,
    });
  } else if (!(SERVED_SHARE_KINDS as readonly string[]).includes(kind as string)) {
    // See SERVED_SHARE_KINDS: a kind no route opens would mint a link that dead-ends,
    // and that is worse than a refusal which says why.
    errors.push({
      field: "kind",
      rule: "kind_not_served",
      message: `kind ${kind} cannot be shared yet; no read route serves it`,
    });
  }

  const target = body.target;
  if (typeof target !== "string") {
    errors.push({ field: "target", rule: "target_malformed", message: "target is required" });
  } else if (kindOk && (kind === "review_document" || kind === "stack_document")) {
    const familyOk = kind === "review_document"
      ? RVR_ID_RE.test(target) || RAC_ID_RE.test(target)
      : RSM_ID_RE.test(target) || RSA_ID_RE.test(target);
    if (!familyOk) {
      errors.push({ field: "target", rule: "target_malformed", message: kind === "review_document" ? "target must be an rvr_ revision or rac_ account id" : "target must be an rsm_ manifest or rsa_ account id" });
    } else {
      try {
        resolveCapabilityTargetForMint(gate.ws, kind, target);
      } catch (err) {
        const rule = err instanceof CapabilityTargetError ? err.rule : "target_unknown";
        errors.push({ field: "target", rule, message: err instanceof Error ? err.message : "No such document in this workspace" });
      }
    }
  } else if (!SLUG_RE.test(target)) {
    errors.push({ field: "target", rule: "target_malformed", message: "target is required and must match [a-z0-9][a-z0-9-]{0,63}" });
  } else if (kindOk && !targetExists(gate.ws, kind as LegacyShareKind, target)) {
    errors.push({ field: "target", rule: "target_unknown", message: `${gate.ws} has no ${String(kind)} called ${target}` });
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

  const expiresAt = (expiry as { at: number | null }).at;
  const created = kind === "review_document" || kind === "stack_document"
    ? createDocumentCapability({ wsId: gate.ws, kind, target: target as string, label: label as string, userId: gate.userId, expiresAt })
    : createShare({ wsId: gate.ws, kind: kind as LegacyShareKind, target: target as string, label: label as string, userId: gate.userId, expiresAt });
  return json({
    id: created.id,
    workspace: gate.ws,
    kind,
    target,
    label,
    expiresAt,
    token: created.token,
    url: `${config.baseUrl}/s/${created.token}`,
    ...("projection" in created ? { document: created.projection } : {}),
  });
}

/** GET /api/shares?workspace=ws_…: what this workspace has shared. No tokens: only
 *  their hashes survived the mint, and a list that could hand one back would undo the
 *  whole point of hashing them. */
export function handleListShares(req: Request): Response {
  const wsId = new URL(req.url).searchParams.get("workspace");
  const gate = callerWorkspace(req, wsId);
  if (gate instanceof Response) return gate;
  return json({
    workspace: gate.ws,
    shares: listShares(gate.ws).map((s) => {
      const document = documentProjectionForShare(s);
      return {
        id: s.id,
        kind: s.kind,
        target: s.target,
        label: s.label,
        createdBy: s.created_by,
        createdAt: new Date(s.created_at).toISOString(),
        expiresAt: s.expires_at === null ? null : new Date(s.expires_at).toISOString(),
        ...(document ? { document } : {}),
      };
    }),
  });
}

/** DELETE /api/shares/:id. A share in a workspace the caller is not in is a 404, the
 *  same answer an id that never existed gets. */
export function handleRevokeShare(req: Request, id: string): Response {
  const share = SHR_ID_RE.test(id) ? getShare(id) : null;
  // An id that does not exist and one belonging to a workspace the caller has no claim
  // on are the same 404 throughout, so this route cannot be used to ask which share ids
  // are real. The two credentials are spelled out rather than folded together: the
  // session's failure is a 404 and the key's is a 401, and neither should be quietly
  // rewritten into the other.
  const user = sessionUser(req);
  if (user) {
    if (!share || !isMember(share.workspace_id, user.id)) return json({ error: "No such share" }, 404);
  } else {
    // An agent takes back what it handed out, with the key it handed it out with.
    if (!req.headers.get("authorization")) return json({ error: "Sign in required" }, 403);
    const key = requireApiKey(req);
    if (key instanceof Response) return key;
    if (!share || share.workspace_id !== key.workspaceId) return json({ error: "No such share" }, 404);
  }
  revokeShare(id);
  return json({ id, revoked: true });
}
