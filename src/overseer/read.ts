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
  listAnnotations,
  listFreshness,
  resolveReview,
  type ReviewDoc,
} from "./db";
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

/** Freshness as of the last check, per pull request of the version being read. A
 *  head that has moved since publication is `behind`; a head nobody has checked
 *  since is `current`, because the stored document is the last thing known true. */
export function freshnessOf(wsId: string, slug: string, doc: ReviewDoc): Record<string, Freshness> {
  const observed = new Map(
    listFreshness(wsId, slug).map((f) => [prKey(f.repo, f.pr_number), f.observed_head_sha]),
  );
  const out: Record<string, Freshness> = {};
  for (const pr of doc.prs) {
    const key = prKey(pr.repo, pr.number);
    const seen = observed.get(key);
    out[key] = seen && seen !== pr.headSha ? "behind" : "current";
  }
  return out;
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
