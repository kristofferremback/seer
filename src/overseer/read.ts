// The Overseer read path: the JSON a renderer and the witness read a review with.
//
// Two routes, one body: GET /api/reviews/:slug is the current version and
// GET /api/reviews/:slug/v/:n is a prior one. Both answer with the stored document
// put back together, meaning the published version plus the two things that live
// outside it and move on their own, the annotations and the derived freshness.
//
// The privacy gate is the other half of this module. A review holds private source,
// so every way of not being allowed to read one answers identically: a missing slug,
// a slug in someone else's workspace, a signed-out browser and a version that does
// not exist all get the same 404 with the same bytes. Anything that distinguishes
// them turns the slug into an oracle for what a workspace is working on.

import { config } from "../config";
import { listUserWorkspaces } from "../db";
import { requireApiKey, sessionUser } from "../auth";
import {
  getReviewVersion,
  legacyObservedHead,
  listAnnotations,
  resolveReview,
  type ReviewDoc,
} from "./db";
import { lookupPrStatus, statusOf, type PrStatusWord } from "./installations";
import { prKey, type Freshness, type Review } from "./types";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every soft-404 on this path is this exact response. It is built fresh per call and
 *  from no request-derived value, so two of them are byte-identical by construction. */
function softNotFound(): Response {
  return new Response(JSON.stringify({ error: "No such review" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The workspaces this request may read, whoever is asking. A member session reaches
 *  every workspace it belongs to; an API key reaches the one it was minted in, which
 *  is how the witness reads back the prior version on its second pass. Both may be
 *  present, and then both count. A key that does not authenticate contributes
 *  nothing rather than failing the request: on this path being unauthenticated and
 *  being unauthorized are the same answer. */
export function readableWorkspaces(req: Request): string[] {
  const ids: string[] = [];
  const user = sessionUser(req);
  if (user) ids.push(...listUserWorkspaces(user.id).map((w) => w.id));
  if (req.headers.get("authorization")) {
    const auth = requireApiKey(req);
    if (!(auth instanceof Response) && !ids.includes(auth.workspaceId)) ids.push(auth.workspaceId);
  }
  return ids;
}

/**
 * Who is asking, when that matters as well as which workspaces they may read.
 *
 * A personal credential belongs to a person, so a path that may spend one has to name
 * them. Sessions and api keys both identify a person; a request carrying neither is
 * nobody, and nobody has no credentials to spend, which is the correct answer rather
 * than an obstacle.
 */
export function askingUserId(req: Request): string | undefined {
  const user = sessionUser(req);
  if (user) return user.id;
  if (req.headers.get("authorization")) {
    const auth = requireApiKey(req);
    if (!(auth instanceof Response)) return auth.userId;
  }
  return undefined;
}

/**
 * Freshness per pull request of the version being read, from the one observation.
 *
 * Absence is `unknown`, not `current`. Reading it as `current` was the old default and
 * it lies in exactly the case that matters: a review whose installation went away and
 * took its rows with it would assert "up to date" on the chip while the glyph beside
 * it — reading the same missing row — showed nothing. The stored document is the last
 * thing known true about the *code*; it is no evidence at all about where the branch
 * points now.
 *
 * With no observation there is one older place to ask: the pre-App `review_freshness`
 * row for this review, which recorded a head and nothing else. It answers the chip's
 * question exactly, so a page that read "behind" before the upgrade still does. It
 * cannot answer the glyph's, and `statusesOf` below stays silent accordingly.
 */
export function freshnessOf(
  wsId: string,
  // The slug is not part of the observation's key: an observation is of a pull request,
  // not of a review, and one pull request may be named by two reviews in the same
  // workspace. It is here for the one reading that is review-scoped, the pre-App
  // `review_freshness` row, which a review published before the App is the only
  // evidence left of and which the v5 migration could not honestly carry across.
  slug: string,
  doc: ReviewDoc,
): Record<string, Freshness> {
  const out: Record<string, Freshness> = {};
  for (const pr of doc.prs) {
    const row = lookupPrStatus(wsId, pr.repo, pr.number);
    if (row) {
      out[prKey(pr.repo, pr.number)] = row.head_sha === pr.headSha ? "current" : "behind";
      continue;
    }
    const legacy = legacyObservedHead(wsId, slug, pr.repo, pr.number);
    out[prKey(pr.repo, pr.number)] = legacy
      ? legacy.observedHeadSha === pr.headSha
        ? "current"
        : "behind"
      : "unknown";
  }
  return out;
}

/** The other reading of the same row: the word a card's glyph draws. A pull request
 *  with no observation has no entry, and the card draws no glyph rather than a fourth
 *  state that would be Seer's own invention. */
export function statusesOf(wsId: string, doc: ReviewDoc): Record<string, PrStatusWord> {
  const out: Record<string, PrStatusWord> = {};
  for (const pr of doc.prs) {
    const row = lookupPrStatus(wsId, pr.repo, pr.number);
    if (row) out[prKey(pr.repo, pr.number)] = statusOf(row);
  }
  return out;
}

/**
 * When the readings on this page were last confirmed, or null when nothing has been.
 *
 * The *oldest* observation, not the newest: a page is only as fresh as its stalest row,
 * and taking the newest would let one busy pull request vouch for four nobody has heard
 * about since last week. Pull requests with no row at all contribute nothing here —
 * they are already saying `unknown`, and an absence has no age.
 *
 * A pull request answered by the pre-App fallback contributes its `checked_at` for the
 * same reason `freshnessOf` consults it at all: the chip is about to state a reading
 * taken then, and a reading that old shown undated would be trusted as though somebody
 * had just confirmed it. The dateline is the hedge.
 */
export function observedAtOf(wsId: string, slug: string, doc: ReviewDoc): number | null {
  let oldest: number | null = null;
  for (const pr of doc.prs) {
    const row = lookupPrStatus(wsId, pr.repo, pr.number);
    const at = row?.observed_at ?? legacyObservedHead(wsId, slug, pr.repo, pr.number)?.checkedAt;
    if (at === undefined) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

/** A version number as it may appear in a URL. Anything else is out of range, and out
 *  of range is a soft-404 like every other miss. */
function versionNumber(raw: string): number | null {
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * GET /api/reviews/:slug and GET /api/reviews/:slug/v/:n.
 *
 * `version` is null for the current version. The response carries the resolved
 * document with its annotations and freshness reattached, so the renderer reads one
 * object, plus where the version sits in the review's history.
 */
export function handleReadReview(req: Request, slug: string, version: string | null): Response {
  if (!SLUG_RE.test(slug)) return softNotFound();
  const review = resolveReview(readableWorkspaces(req), slug);
  if (!review) return softNotFound();
  const ws = review.workspace_id;

  const asked = version === null ? review.latest_version : versionNumber(version);
  if (asked === null || asked > review.latest_version) return softNotFound();
  const row = getReviewVersion(ws, slug, asked);
  // A head pointer with no row behind it is corruption, not a miss, and the publish
  // path writes both in one transaction so it cannot happen by racing.
  if (!row) throw new Error(`Review ${ws}/${slug} has no version row for version ${asked}`);

  const document: ReviewDoc & Pick<Review, "annotations" | "freshness"> = {
    ...row.doc,
    annotations: listAnnotations(ws, slug),
    freshness: freshnessOf(ws, slug, row.doc),
  };
  return json({
    slug,
    workspace: ws,
    version: asked,
    latestVersion: review.latest_version,
    isLatest: asked === review.latest_version,
    url: `${config.baseUrl}/${ws}/r/${slug}`,
    versionUrl: `${config.baseUrl}/${ws}/r/${slug}/v/${asked}`,
    document,
  });
}
