// Inbound deliveries: the only thing that keeps a published review's status true.
//
// With polling deleted, this endpoint is what stands between "a page says what GitHub
// said at publication" and "a page says what GitHub says". It is authenticated by
// signature alone, which is the correct amount: GitHub cannot hold a Seer credential,
// and the shared secret over the raw bytes proves the delivery came from the App.
//
// Three properties are load-bearing and each is easy to lose:
//
//   * The signature is checked over the RAW body, before it is parsed. A payload that
//     failed verification must never have been JSON.parsed, let alone acted on.
//   * The delivery id and every database effect commit in ONE transaction. Inserting
//     the id first and then doing the work means a failed apply is classified as a
//     duplicate when GitHub (or a human) retries it, and the event is lost for good.
//   * Attribution is `installation.id` and nothing else. Not `repository.full_name`,
//     which is a name GitHub treats case-insensitively and lets people change; the
//     numeric `repository.id` is the join key and the installation decides whose rows
//     are written.
//
// An unknown installation is a 202 that writes nothing, because an installation removed
// a second ago still has deliveries in flight.

import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../config";
import { db } from "../db";
import { publishReview } from "./freshness";
import { invalidateAppRouting } from "./github-app";
import {
  deletePrStatusForInstallation,
  deletePrStatusForRepo,
  getLiveInstallation,
  listWorkspacePrs,
  markInstallationRemoved,
  observePullRequest,
  recordInstallationDelivery,
  recordUnclaimedInstallation,
  reviewsNaming,
  setInstallationSuspended,
  type PrObservation,
} from "./installations";
import { githubClientFor } from "./github-app";
import { parseUpdatedAt } from "./derive";

export const WEBHOOK_PATH = "/api/github/webhook";

/** The `pull_request` actions worth an observation. Every one of them can change the
 *  head, the draft flag or the state; the rest (labels, assignees, review requests)
 *  cannot, and acknowledging them costs nothing. */
const PR_ACTIONS = new Set([
  "opened",
  "closed",
  "reopened",
  "edited",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
]);

// ---- the signature ----

/**
 * `sha256=` plus HMAC-SHA256 of the raw body under GITHUB_WEBHOOK_SECRET.
 *
 * The length guard is the same one `auth.ts` carries and it is not a micro-optimisation:
 * `timingSafeEqual` **throws** on buffers of unequal length, so a truncated header
 * without it is a 500 rather than the 401 this endpoint promises.
 */
export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const given = Buffer.from(header);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The header a delivery is signed with, so a test signs what production verifies. */
export function webhookSignature(secret: string, body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
}

// ---- the payload, read defensively ----

interface WebhookPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; id?: number; type?: string };
    repository_selection?: string;
    repositories?: { id?: number; full_name?: string }[];
  };
  repository?: { id?: number; full_name?: string };
  repositories_added?: { id?: number; full_name?: string }[];
  repositories_removed?: { id?: number; full_name?: string }[];
  pull_request?: {
    number?: number;
    state?: string;
    merged?: boolean;
    draft?: boolean;
    updated_at?: string;
    head?: { sha?: string };
  };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---- what one delivery does ----

interface Effects {
  /** Reviews whose open pages should be told, as `${workspaceId}\0${slug}`. */
  touched: string[];
  /** Repositories whose routing answer may have changed. */
  invalidate: string[];
  /** An event meaning observations may have been missed: sweep and re-observe once. */
  reconcile: { installationId: number; repos: string[] | null } | null;
}

const NOTHING: Effects = { touched: [], invalidate: [], reconcile: null };

function repoNames(list: { full_name?: string }[] | undefined): string[] {
  return (list ?? []).map((r) => r.full_name).filter((n): n is string => typeof n === "string");
}

function applyPullRequest(installationId: number, payload: WebhookPayload): Effects {
  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || !repo || typeof repo.id !== "number" || typeof repo.full_name !== "string") {
    return NOTHING;
  }
  if (typeof pr.number !== "number" || typeof pr.head?.sha !== "string") return NOTHING;

  const obs: PrObservation = {
    repoId: repo.id,
    repo: repo.full_name,
    prNumber: pr.number,
    state: pr.state === "closed" ? "closed" : "open",
    merged: pr.merged === true,
    draft: pr.draft === true,
    headSha: pr.head.sha,
    // The precondition of the whole upsert. GitHub's own timestamp, not ours: two
    // deliveries racing are ordered by what GitHub says happened when.
    updatedAt: parseUpdatedAt(pr.updated_at),
  };

  // The filter is not an optimisation. An installation covering "all repositories" on a
  // busy org delivers an event for every pull request anyone opens anywhere in it;
  // writing a row for each would grow github_pr_status without bound, forever, for pull
  // requests no review names and no page renders. observePullRequest applies the filter.
  const applied = observePullRequest(installationId, obs);
  if (applied === 0) return NOTHING;

  const install = getLiveInstallation(installationId)!;
  const wsId = install.workspace_id!;
  return {
    touched: reviewsNaming(wsId, obs.repoId, obs.repo, obs.prNumber).map((slug) => `${wsId}\0${slug}`),
    invalidate: [],
    reconcile: null,
  };
}

function applyInstallation(installationId: number, payload: WebhookPayload): Effects {
  const action = payload.action ?? "";
  const account = payload.installation?.account;
  switch (action) {
    case "created":
      // The earliest trustworthy moment Seer learns an installation exists, and what
      // makes the settings picker a list of real installations rather than a box that
      // takes an id from anywhere. Recorded UNCLAIMED: it belongs to nobody until
      // somebody proves, through the OAuth leg, that they can reach it.
      recordUnclaimedInstallation({
        installationId,
        accountLogin: account?.login ?? `installation ${installationId}`,
        accountId: typeof account?.id === "number" ? account.id : 0,
        accountType: account?.type ?? "User",
        repositorySelection: payload.installation?.repository_selection ?? "selected",
      });
      return { touched: [], invalidate: repoNames(payload.installation?.repositories), reconcile: null };
    case "deleted":
      // Its status rows go with it, found by installation_id — the glyph disappears
      // rather than showing the last thing that was true about a repository we can no
      // longer read. Deleting by workspace would take the surviving installations'
      // observations with it.
      deletePrStatusForInstallation(installationId);
      markInstallationRemoved(installationId);
      return { touched: [], invalidate: repoNames(payload.installation?.repositories), reconcile: null };
    case "suspend":
      setInstallationSuspended(installationId, true);
      return NOTHING;
    case "unsuspend":
      // Already cleared by the delivery itself; this is where the sweep is triggered,
      // because everything that happened while it was suspended was never delivered.
      return { touched: [], invalidate: [], reconcile: { installationId, repos: null } };
    case "new_permissions_accepted":
      // Recorded by the delivery row and nothing more: nothing here needs a write
      // permission yet, and it matters when annotation mirroring does.
      return NOTHING;
    default:
      return NOTHING;
  }
}

function applyInstallationRepositories(installationId: number, payload: WebhookPayload): Effects {
  const added = repoNames(payload.repositories_added);
  const removed = payload.repositories_removed ?? [];
  for (const repo of removed) {
    if (typeof repo.full_name !== "string") continue;
    deletePrStatusForRepo(installationId, typeof repo.id === "number" ? repo.id : null, repo.full_name);
  }
  return {
    touched: [],
    invalidate: [...added, ...repoNames(removed)],
    // `removed` needs no sweep: its rows are gone. `added` writes nothing back on its
    // own, so every review naming that repository would render unchecked indefinitely
    // while delivery health reported perfect health — the one mechanism meant to make
    // the failure visible saying nothing is wrong.
    reconcile: added.length > 0 ? { installationId, repos: added } : null,
  };
}

function applyEvent(event: string, payload: WebhookPayload): Effects {
  const installationId = payload.installation?.id;
  if (typeof installationId !== "number" || !Number.isInteger(installationId)) return NOTHING;

  // A delivery arriving IS proof the installation is live, which repairs the suspended
  // case even when the `unsuspend` delivery was itself the one that was lost. Cleared
  // before the event is applied, so `suspend` still sets it in the same breath.
  setInstallationSuspended(installationId, false);

  const effects = dispatchEvent(event, installationId, payload);

  // The same proof, kept rather than merely acted on: settings reports the age of this
  // stamp, and with no polling left that report is the only way anyone finds out the
  // net stopped catching things. Recorded for every event, including the ones dropped
  // below — an acknowledged event nobody stored still travelled the wire.
  //
  // AFTER the event, not before: `installation.created` is the delivery that inserts
  // the row, and an UPDATE running first matches nothing, so the one installation Seer
  // learned about from a webhook was the one reporting "never delivered".
  recordInstallationDelivery(installationId);

  return effects;
}

function dispatchEvent(event: string, installationId: number, payload: WebhookPayload): Effects {
  switch (event) {
    case "pull_request":
      return PR_ACTIONS.has(payload.action ?? "")
        ? applyPullRequest(installationId, payload)
        : NOTHING;
    case "installation":
      return applyInstallation(installationId, payload);
    case "installation_repositories":
      return applyInstallationRepositories(installationId, payload);
    default:
      return NOTHING;
  }
}

interface Outcome extends Effects {
  duplicate: boolean;
}

/**
 * The delivery id and every effect of that delivery, in one transaction.
 *
 * A throw anywhere inside rolls back the id along with the work, so GitHub's retry (or
 * a human's redelivery) applies rather than being answered as a duplicate. That is the
 * whole reason this is one statement rather than "insert, then process".
 */
const applyDelivery = db.transaction(
  (deliveryId: string, event: string, payload: WebhookPayload): Outcome => {
    const seen = db
      .query<{ delivery_id: string }, [string]>(
        "SELECT delivery_id FROM github_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    if (seen) return { ...NOTHING, duplicate: true };
    db.run("INSERT INTO github_deliveries (delivery_id, received_at) VALUES (?, ?)", [
      deliveryId,
      Date.now(),
    ]);
    return { ...applyEvent(event, payload), duplicate: false };
  },
) as (deliveryId: string, event: string, payload: WebhookPayload) => Outcome;

// ---- the endpoint ----

/**
 * POST /api/github/webhook.
 *
 * The route table deliberately gives this no `originOk` guard — see the comment beside
 * it in server.ts. Every other POST has one; this one cannot, and the signature is what
 * replaces it.
 */
export async function handleGithubWebhook(req: Request): Promise<Response> {
  // No "not configured" branch: config.ts requires the App variables at boot, so a
  // server that is answering this route has a webhook secret to verify against.
  const app = config.githubApp;

  const raw = new Uint8Array(await req.arrayBuffer());
  if (!verifyWebhookSignature(app.webhookSecret, raw, req.headers.get("x-hub-signature-256"))) {
    // Forged, missing and truncated are one answer, and none of them parsed the body.
    return json({ error: "Bad signature" }, 401);
  }

  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return new Response(null, { status: 204 });

  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  if (!deliveryId) return json({ error: "Missing X-GitHub-Delivery" }, 400);

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as WebhookPayload;
  } catch {
    return json({ error: "Malformed payload" }, 400);
  }

  let outcome: Outcome;
  try {
    outcome = applyDelivery(deliveryId, event, payload);
  } catch (err) {
    // The transaction rolled back, delivery id and all, so a retry of this id applies
    // rather than being answered as a duplicate. Said out loud with the id in it: a
    // delivery that failed is the one thing nothing else will tell us about.
    console.error(`[seer] webhook delivery ${deliveryId} (${event}) failed to apply: ${String(err)}`);
    return json({ error: "Delivery could not be applied" }, 500);
  }
  if (outcome.duplicate) return json({ ok: true, duplicate: true }, 200);

  // Everything below happens only after the transaction committed. A push describing a
  // write that then rolled back would be the page holding a fact the database does not.
  for (const key of new Set(outcome.touched)) {
    const [wsId, slug] = key.split("\0");
    publishReview(wsId!, slug!);
  }
  for (const repo of new Set(outcome.invalidate)) invalidateAppRouting(repo);
  if (outcome.reconcile) {
    const { installationId, repos } = outcome.reconcile;
    // Detached, and guarded: reconcileInstallation's per-pull-request catch does not
    // cover githubClientFor or getLiveInstallation, and an unhandled rejection out of an
    // HTTP handler takes the process down.
    void reconcileInstallation(installationId, repos).catch((err) => {
      console.error(
        `[seer] reconcile after delivery ${deliveryId} (${event}) for installation ${installationId} failed: ${String(err)}`,
      );
    });
  }

  return json({ ok: true, applied: outcome.touched.length > 0 }, outcome.touched.length > 0 ? 200 : 202);
}

// ---- reconciliation ----

/**
 * Re-observe every pull request an installation could have changed under us, once.
 *
 * This is not polling returning by the back door, and the distinction is the trigger: a
 * poll fires on a timer or a render, endlessly, whether or not anything happened. This
 * fires on a discrete event that means observations *were* missed — an unsuspend, a
 * repository added back, a claim that has just made an installation ours — sweeps the
 * pull requests some review names, and stops. It writes through the same conditional
 * upsert as every other writer, so it cannot roll a newer fact back.
 */
export async function reconcileInstallation(
  installationId: number,
  repos: string[] | null,
): Promise<void> {
  const install = getLiveInstallation(installationId);
  if (!install || install.workspace_id === null) return;
  const wsId = install.workspace_id;
  const client = githubClientFor(wsId);

  const seen = new Set<string>();
  const touched = new Set<string>();
  for (const row of listWorkspacePrs(wsId, repos)) {
    const key = `${row.repo.toLowerCase()}#${row.pr_number}`;
    // One review naming a pull request and a second naming the same one is one
    // observation, not two calls.
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const pull = await client.getPull(row.repo, row.pr_number);
      const repoId = pull.base?.repo?.id ?? row.repo_id;
      if (repoId === null || repoId === undefined) continue;
      // Attributed to whichever installation actually covers this repository, not to the
      // one whose event triggered the sweep. A workspace may hold several, and stamping
      // another installation's rows with this id is what makes a later
      // `installation.deleted` delete observations a live installation still covers.
      const attributed = client.installationFor
        ? await client.installationFor(row.repo)
        : installationId;
      if (attributed === null) continue;
      const applied = observePullRequest(attributed, {
        repoId,
        repo: row.repo,
        prNumber: row.pr_number,
        state: pull.state,
        merged: pull.merged === true,
        draft: pull.draft === true,
        headSha: pull.head.sha,
        updatedAt: parseUpdatedAt(pull.updated_at),
      });
      if (applied > 0) for (const slug of reviewsNaming(wsId, repoId, row.repo, row.pr_number)) touched.add(slug);
    } catch (err) {
      // A repository this workspace no longer holds fails exactly like an unreachable
      // GitHub: the last observation stands, and the failure is said out loud.
      console.error(
        `[seer] reconcile failed for ${row.repo}#${row.pr_number} in ${wsId}: ${String(err)}`,
      );
    }
  }
  for (const slug of touched) publishReview(wsId, slug);
}

// ---- keeping the delivery table from growing forever ----

/** Long enough that a redelivery of anything GitHub still shows in its own UI is still
 *  recognised as a duplicate; short enough that the table is bounded. */
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_SWEEP_MS = 60 * 60 * 1000;

export function sweepDeliveries(now: number = Date.now()): number {
  return db.run("DELETE FROM github_deliveries WHERE received_at < ?", [now - DELIVERY_RETENTION_MS])
    .changes;
}

// Its own interval, owned by the module that owns the table — not the blob store's,
// which is a different layer entirely. Guarded, because a throw inside an interval
// callback takes the process down and this one has done it before.
setInterval(() => {
  try {
    sweepDeliveries();
  } catch (err) {
    console.error("[seer] delivery sweep error:", err);
  }
}, DELIVERY_SWEEP_MS);
