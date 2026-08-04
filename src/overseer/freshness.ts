// Freshness: whether the branches a review is about still point where the review says.
//
// Nothing here runs by itself any more. Looking at a review used to check it; that
// automatic check is deleted, and no timer replaced it. Publish seeds `github_pr_status`
// from the `getPull` the derivation already makes, deliveries maintain it, and a human
// pressing refresh repairs it — one automatic write path after creation rather than two
// sources of one fact. A render reaches GitHub on no path at all, which is now a
// property of the architecture rather than a rule each page has to remember.
//
// What that costs is a change nobody could tell us about: a delivery GitHub gave up on,
// a rotated secret, the minutes of a redeploy. Those used to heal silently on the next
// render and now persist until someone repairs them, which is why the repair is visible
// (`observed_at` on every row, delivery health in settings) rather than automatic.
//
// The freshness table this module used to write is still on disk, and nothing here
// writes it any more. It held a second recording of one fact beside the status row, and
// two writers of one fact is the drift this design exists to remove — so this release
// stops the write and leaves the table standing. The drop is v6, a release later
// (src/migrate.ts), so an old container still reading it during a redeploy finds it
// there and a rollback still recognises the database.
//
// The rate limit is process-local on purpose. It is a courtesy to the GitHub API, not
// a correctness rule: two processes checking the same review a second apart write the
// same rows and reach the same answer.

import { getReviewVersion, resolveReview, type ReviewDoc } from "./db";
import { parseUpdatedAt } from "./derive";
import type { GithubClient } from "./github";
import { githubClientFor } from "./github-app";
import { lookupPrStatus, statusOf, upsertPrStatus } from "./installations";
import { freshnessOf, readableWorkspaces, statusesOf } from "./read";
import { prKey, type Freshness } from "./types";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One check per review per minute, however many people are reading it. */
export const CHECK_INTERVAL_MS = 60_000;

/** The last time this process compared a review against GitHub, by workspace and slug.
 *  Bounded so a long-lived process reading many reviews cannot grow it without end;
 *  evicting an entry costs one extra GitHub call, which is the cheapest failure here. */
const LAST_CHECK = new Map<string, number>();
const LAST_CHECK_MAX = 5_000;

function checkKey(wsId: string, slug: string): string {
  return `${wsId}:${slug}`;
}

/**
 * Claim the next check for this review, or refuse when one was made inside the window.
 *
 * The claim is written before the check runs rather than after it finishes: two
 * renders arriving in the same tick would otherwise both see an old timestamp and both
 * call GitHub, which is exactly what the window exists to stop.
 */
export function claimCheck(wsId: string, slug: string, now: number = Date.now()): boolean {
  const key = checkKey(wsId, slug);
  const last = LAST_CHECK.get(key);
  if (last !== undefined && now - last < CHECK_INTERVAL_MS) return false;
  if (LAST_CHECK.size >= LAST_CHECK_MAX) {
    const oldest = LAST_CHECK.keys().next();
    if (!oldest.done) LAST_CHECK.delete(oldest.value);
  }
  LAST_CHECK.set(key, now);
  return true;
}

/** Forget every claim. Tests only: a fresh window without waiting a minute. */
export function resetChecks(): void {
  LAST_CHECK.clear();
}

// ---- the live channel ----

/** How a review's freshness reaches the pages currently open on it. Membership of the
 *  workspace is checked at the upgrade, so a topic is only ever subscribed by someone
 *  who may read the review it names. */
export function reviewTopic(wsId: string, slug: string): string {
  return `review:${wsId}:${slug}`;
}

type Publisher = (topic: string, message: string) => void;

let publisher: Publisher | null = null;

/** The server hands its publish in once it exists. Absent (in a test, or before the
 *  server binds) freshness still records what it found; nobody is listening. */
export function setFreshnessPublisher(fn: Publisher | null): void {
  publisher = fn;
}

// ---- the check ----

export interface PrFreshness {
  /** "owner/name#12", the way a pull request is named everywhere else. */
  pr: string;
  repo: string;
  number: number;
  freshness: Freshness;
}

export interface CheckResult {
  prs: PrFreshness[];
  /** True when this check changed a pull request's answer: current became behind, or
   *  behind became current again. A push is worth sending exactly when something moved,
   *  in either direction, so a page that was told "behind" hears when it stops being
   *  true and a page that already knows is not told again every minute. */
  changed: boolean;
}

/**
 * Compare every pull request of a document against GitHub and record what was seen.
 *
 * One `getPull` per pull request, and the observed head is written whether or not it
 * moved: a recorded head equal to the stored one is what makes `current` a statement
 * about now rather than about publication time. A pull request GitHub will not answer
 * for keeps whatever was last observed, because a transport failure is not evidence
 * that a branch moved.
 */
export async function checkReview(
  wsId: string,
  slug: string,
  doc: ReviewDoc,
  // The observation is made as the workspace whose review it is, through an
  // installation that workspace holds. A repository it no longer holds fails the same
  // way an unreachable GitHub does: the last observation stands.
  client: GithubClient = githubClientFor(wsId),
): Promise<CheckResult> {
  const prs: PrFreshness[] = [];
  let changed = false;
  for (const pr of doc.prs) {
    const key = prKey(pr.repo, pr.number);
    const known = lookupPrStatus(wsId, pr.repo, pr.number);
    const was: Freshness = known ? (known.head_sha === pr.headSha ? "current" : "behind") : "unknown";
    // One observation, two derivations — so a check has changed something when *either*
    // derivation moved. A pull request merged with its head unmoved changes status and
    // not freshness, and the message this decides whether to send carries both.
    const wasStatus = known ? statusOf(known) : null;
    let freshness = was;
    try {
      const pull = await client.getPull(pr.repo, pr.number);
      const installationId = (await client.installationFor?.(pr.repo)) ?? null;
      const repoId = pull.base?.repo?.id ?? known?.repo_id ?? null;
      // One row, one writer, one precondition: a refresh goes through the same upsert a
      // publish and a delivery do, so a slow refresh cannot roll back a newer fact.
      if (installationId !== null && repoId !== null) {
        upsertPrStatus(wsId, installationId, {
          repoId,
          // GitHub's answer names the repository as it is called now; the document
          // names it as it was called at publication. The row's name is display only
          // and must be the current one.
          repo: pull.base?.repo?.full_name ?? known?.repo ?? pr.repo,
          prNumber: pr.number,
          state: pull.state,
          merged: pull.merged === true,
          draft: pull.draft === true,
          headSha: pull.head.sha,
          updatedAt: parseUpdatedAt(pull.updated_at),
        });
      }
      freshness = pull.head.sha === pr.headSha ? "current" : "behind";
    } catch (err) {
      // A review is not wrong because GitHub was unreachable. The last observation
      // stands, and the failure is said out loud rather than swallowed.
      console.error(`[seer] freshness check failed for ${key} in ${wsId}/${slug}: ${String(err)}`);
    }
    if (freshness !== was) changed = true;
    const nowRow = lookupPrStatus(wsId, pr.repo, pr.number);
    if ((nowRow ? statusOf(nowRow) : null) !== wasStatus) changed = true;
    prs.push({ pr: key, repo: pr.repo, number: pr.number, freshness });
  }
  return { prs, changed };
}

/**
 * The whole observation, in one message.
 *
 * One message and not two. A `{"type":"pr"}` beside a `{"type":"freshness"}` would be
 * two descriptions of one observation on the wire: they can arrive out of order and
 * leave the chip disagreeing with the glyphs on the same screen, which is the failure
 * the one-row design exists to prevent, reintroduced at the transport. It also could
 * not have worked — given one pull request's head the script cannot recompute `behind`,
 * because the page emits no per-pull-request head SHA and the script holds no state.
 *
 * So the counts and the per-pull-request readings are computed here, from the rows,
 * and whatever caused the observation — a delivery or a human pressing refresh — the
 * wire shape is identical.
 */
export function reviewMessage(wsId: string, slug: string, doc: ReviewDoc): string {
  const fresh = freshnessOf(wsId, slug, doc);
  const status = statusesOf(wsId, doc);
  const prs = doc.prs.map((pr) => {
    const key = prKey(pr.repo, pr.number);
    return {
      pr: key,
      // Null rather than absent: a page that had a glyph and should not have one any
      // more has to be told, and a missing field is indistinguishable from "unchanged".
      status: status[key] ?? null,
      freshness: fresh[key] ?? "unknown",
    };
  });
  return JSON.stringify({
    type: "review",
    prs,
    behind: prs.filter((p) => p.freshness === "behind").length,
    unknown: prs.filter((p) => p.freshness === "unknown").length,
    total: prs.length,
  });
}

/**
 * Push the current observation of a review to the pages open on it.
 *
 * Read from the rows rather than handed the result of whatever wrote them, so a
 * delivery and a refresh cannot describe the same review two different ways. A review
 * that no longer resolves is silence: the page will find out on its next load.
 */
export function publishReview(wsId: string, slug: string): void {
  if (!publisher) return;
  const review = resolveReview([wsId], slug);
  if (!review) return;
  const row = getReviewVersion(wsId, slug, review.latest_version);
  if (!row) return;
  publisher(reviewTopic(wsId, slug), reviewMessage(wsId, slug, row.doc));
}

// ---- the route ----

/** The same soft-404 the rest of the review paths answer with: an unauthenticated
 *  caller, a review in another workspace and a slug nobody published are one answer. */
function softNotFound(): Response {
  return new Response(JSON.stringify({ error: "No such review" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * POST /api/reviews/:slug/refresh.
 *
 * The explicit version of what viewing does, and the only one that waits: a caller
 * asking for a refresh wants the answer, so this checks synchronously and returns the
 * per-pull-request result.
 *
 * It honours the window rather than merely claiming it. This used to call claimCheck
 * and throw the answer away, which made the one-check-per-minute bound a property of
 * rendering and of nothing else: a caller posting this route in a loop spent one call
 * to GitHub per pull request per request, without limit, and the rate limit the whole
 * module is built around was a comment. A refused claim is not an error, because the
 * caller wants an answer and there is one — the last observation, which is what a
 * render inside the same window would have shown them too. `checked` says which they
 * got, so a caller that really needs a fetch can tell it did not happen.
 */
export async function handleRefreshReview(req: Request, slug: string): Promise<Response> {
  if (!SLUG_RE.test(slug)) return softNotFound();
  const review = resolveReview(readableWorkspaces(req), slug);
  if (!review) return softNotFound();
  const ws = review.workspace_id;
  const row = getReviewVersion(ws, slug, review.latest_version);
  if (!row) throw new Error(`Review ${ws}/${slug} has no version row for version ${review.latest_version}`);

  const answer = (checked: boolean, prs: { pr: string; freshness: Freshness }[]) =>
    new Response(
      JSON.stringify({ slug, workspace: ws, version: review.latest_version, checked, prs }, null, 2),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );

  if (!claimCheck(ws, slug)) {
    // Inside the window. Answer from what is already recorded, touching nothing.
    const known = freshnessOf(ws, slug, row.doc);
    return answer(
      false,
      row.doc.prs.map((pr) => {
        const key = prKey(pr.repo, pr.number);
        // No default. This route is the repair path — the one thing a reader reaches
        // for when they already suspect something is stale — so it is the last place
        // that may answer "current" about a pull request nothing has observed.
        return { pr: key, freshness: known[key] ?? "unknown" };
      }),
    );
  }

  const result = await checkReview(ws, slug, row.doc);
  if (result.changed) publishReview(ws, slug);
  return answer(
    true,
    result.prs.map((p) => ({ pr: p.pr, freshness: p.freshness })),
  );
}
