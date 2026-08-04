// Freshness: whether the branches a review is about still point where the review says.
//
// Looking at a review is what checks it. A render answers from the stored document
// immediately and, at most once a minute per review, kicks a detached comparison of
// the stored head SHAs against GitHub. Nothing on the read path waits for GitHub: a
// slow or broken client costs the reader nothing, and a head that moved lands in
// `review_freshness`, which the next render reads and, for a reader with a script,
// arrives over the live channel as a push.
//
// The rate limit is process-local on purpose. It is a courtesy to the GitHub API, not
// a correctness rule: two processes checking the same review a second apart write the
// same rows and reach the same answer.

import {
  getReviewVersion,
  listFreshness,
  resolveReview,
  setFreshness,
  type ReviewDoc,
} from "./db";
import type { GithubClient } from "./github";
import { githubClientFor } from "./github-app";
import { freshnessOf, readableWorkspaces } from "./read";
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
  const observed = new Map(
    listFreshness(wsId, slug).map((f) => [prKey(f.repo, f.pr_number), f.observed_head_sha]),
  );
  const prs: PrFreshness[] = [];
  let changed = false;
  for (const pr of doc.prs) {
    const key = prKey(pr.repo, pr.number);
    const before = observed.get(key) ?? pr.headSha;
    let head = before;
    try {
      const pull = await client.getPull(pr.repo, pr.number);
      head = pull.head.sha;
      setFreshness(wsId, slug, pr.repo, pr.number, head);
    } catch (err) {
      // A review is not wrong because GitHub was unreachable. The last observation
      // stands, and the failure is said out loud rather than swallowed.
      console.error(`[seer] freshness check failed for ${key} in ${wsId}/${slug}: ${String(err)}`);
    }
    const freshness: Freshness = head !== pr.headSha ? "behind" : "current";
    const was: Freshness = before !== pr.headSha ? "behind" : "current";
    if (freshness !== was) changed = true;
    prs.push({ pr: key, repo: pr.repo, number: pr.number, freshness });
  }
  return { prs, changed };
}

/** What a page pushes when a head has moved under it. One shape, so the script on the
 *  page reads a message rather than guessing at one. */
export function freshnessMessage(result: CheckResult): string {
  const behind = result.prs.filter((p) => p.freshness === "behind").length;
  return JSON.stringify({ type: "freshness", behind, total: result.prs.length });
}

/**
 * The refresh a render triggers. Returns immediately, always.
 *
 * The check runs detached: the caller has already answered, so there is nothing to
 * await it for and every failure inside it is logged rather than thrown. When a head
 * has moved, the pages open on this review hear about it on the live channel; the ones
 * without a script see it on their next load, out of the rows this wrote.
 */
export function refreshOnView(wsId: string, slug: string, doc: ReviewDoc): void {
  if (!claimCheck(wsId, slug)) return;
  // Deliberately not awaited. The `void` is the point of this function.
  void (async () => {
    try {
      const result = await checkReview(wsId, slug, doc);
      if (result.changed) publisher?.(reviewTopic(wsId, slug), freshnessMessage(result));
    } catch (err) {
      console.error(`[seer] freshness refresh failed for ${wsId}/${slug}: ${String(err)}`);
    }
  })();
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
        return { pr: key, freshness: known[key] ?? "current" };
      }),
    );
  }

  const result = await checkReview(ws, slug, row.doc);
  if (result.changed) publisher?.(reviewTopic(ws, slug), freshnessMessage(result));
  return answer(
    true,
    result.prs.map((p) => ({ pr: p.pr, freshness: p.freshness })),
  );
}
