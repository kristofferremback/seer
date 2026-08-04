// What a workspace holds on GitHub, and the rows that hang off it.
//
// `github-app.ts` knows how to act as the App; this module knows *which installations a
// workspace may act through*, which is the question the whole design turns on. Step 1
// answered it against an injected fake so routing could be built before the schema
// existed; this is the implementation that reads the database, and it is deliberately
// the only place that decides.
//
// Two rules run through every query here. An installation with no `workspace_id`
// belongs to nobody — it was recorded from `installation.created` before anyone claimed
// it — so no workspace-keyed query may ever walk it. And `removed_at IS NULL` is what
// "held" means: the audit row survives a disconnect, the claim does not.

import { db } from "../db";
import { hashKey, tinyId } from "../ids";
import type { WorkspaceHoldings } from "./github-app";

// ---- installations ----

export interface InstallationRow {
  id: string;
  workspace_id: string | null;
  installation_id: number;
  account_login: string;
  account_id: number;
  account_type: string;
  repository_selection: string;
  connected_by: string | null;
  connected_at: number | null;
  created_at: number;
  suspended_at: number | null;
  removed_at: number | null;
}

/** The live row for an installation id, claimed or not. `removed_at IS NULL` is what
 *  makes this at most one row: the partial unique index is on exactly that predicate. */
export function getLiveInstallation(installationId: number): InstallationRow | null {
  return db
    .query<InstallationRow, [number]>(
      "SELECT * FROM github_installations WHERE installation_id = ? AND removed_at IS NULL",
    )
    .get(installationId);
}

/** What one workspace holds, newest first. Never an unclaimed row, never a removed one. */
export function listWorkspaceInstallations(wsId: string): InstallationRow[] {
  return db
    .query<InstallationRow, [string]>(
      "SELECT * FROM github_installations WHERE workspace_id = ? AND removed_at IS NULL " +
        "ORDER BY connected_at DESC, created_at DESC",
    )
    .all(wsId);
}

/** Record an installation nobody has claimed yet — what `installation.created` writes,
 *  and what makes the picker a list of real installations rather than a box that takes
 *  an id from anywhere. Idempotent on the live row. */
export function recordUnclaimedInstallation(args: {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  repositorySelection: string;
}): InstallationRow {
  const existing = getLiveInstallation(args.installationId);
  if (existing) return existing;
  const id = tinyId("ghi");
  db.run(
    "INSERT INTO github_installations " +
      "(id, workspace_id, installation_id, account_login, account_id, account_type, " +
      " repository_selection, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
    [
      id,
      args.installationId,
      args.accountLogin,
      args.accountId,
      args.accountType,
      args.repositorySelection,
      Date.now(),
    ],
  );
  return getLiveInstallation(args.installationId)!;
}

/** Why an attach did not happen. The caller turns this into a message; only
 *  `already_claimed` is delicate, and the message for it never names the workspace
 *  that holds the installation — see attachInstallation. */
export type AttachRefusal = "already_claimed";

/**
 * Bind an installation to a workspace.
 *
 * The caller has already proved that the person asking can reach this installation;
 * this is only the write. It runs in one transaction so two claims racing for one
 * unclaimed row cannot both win: the second sees a `workspace_id` and is refused.
 *
 * Re-claiming into the workspace that already holds it is a success and not a refusal —
 * `setup_action=update` and a double-submitted form both land here, and telling someone
 * their own installation belongs to someone else would be false as well as unhelpful.
 */
export const attachInstallation = db.transaction(
  (args: {
    wsId: string;
    userId: string;
    installationId: number;
    accountLogin: string;
    accountId: number;
    accountType: string;
    repositorySelection: string;
  }): InstallationRow | AttachRefusal => {
    const now = Date.now();
    const existing = getLiveInstallation(args.installationId);
    if (existing && existing.workspace_id !== null && existing.workspace_id !== args.wsId) {
      return "already_claimed";
    }
    if (existing) {
      db.run(
        "UPDATE github_installations SET workspace_id = ?, connected_by = ?, connected_at = ?, " +
          "account_login = ?, account_id = ?, account_type = ?, repository_selection = ? " +
          "WHERE id = ?",
        [
          args.wsId,
          args.userId,
          existing.connected_at ?? now,
          args.accountLogin,
          args.accountId,
          args.accountType,
          args.repositorySelection,
          existing.id,
        ],
      );
      return getLiveInstallation(args.installationId)!;
    }
    db.run(
      "INSERT INTO github_installations " +
        "(id, workspace_id, installation_id, account_login, account_id, account_type, " +
        " repository_selection, connected_by, connected_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        tinyId("ghi"),
        args.wsId,
        args.installationId,
        args.accountLogin,
        args.accountId,
        args.accountType,
        args.repositorySelection,
        args.userId,
        now,
        now,
      ],
    );
    return getLiveInstallation(args.installationId)!;
  },
) as (args: {
  wsId: string;
  userId: string;
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  repositorySelection: string;
}) => InstallationRow | AttachRefusal;

/** Refresh what GitHub says the installation now covers. `setup_action=update` is a
 *  better trigger for this than the webhook, because it is synchronous with the click
 *  that caused it. */
export function updateRepositorySelection(installationId: number, selection: string): void {
  db.run(
    "UPDATE github_installations SET repository_selection = ? " +
      "WHERE installation_id = ? AND removed_at IS NULL",
    [selection, installationId],
  );
}

/**
 * `suspended_at`, set by `installation.suspend` and cleared by anything that proves the
 * installation is live again.
 *
 * The clear is not only `unsuspend`: a delivery arriving at all is proof, which is what
 * repairs the case where the `unsuspend` delivery was itself the one that was lost.
 * The column is a display hint and never the fact — a publish is refused because GitHub
 * declined to mint a token, not because of what this column says.
 */
export function setInstallationSuspended(installationId: number, suspended: boolean): void {
  db.run(
    "UPDATE github_installations SET suspended_at = ? WHERE installation_id = ? AND removed_at IS NULL",
    [suspended ? Date.now() : null, installationId],
  );
}

/** `installation.deleted`: the claim ends, the audit row survives, and the id is
 *  released — the partial unique index only covers live rows. */
export function markInstallationRemoved(installationId: number): boolean {
  return (
    db.run(
      "UPDATE github_installations SET removed_at = ? WHERE installation_id = ? AND removed_at IS NULL",
      [Date.now(), installationId],
    ).changes > 0
  );
}

/** The rows an installation was the source of, found by `installation_id` — which is
 *  the whole reason that column exists. By the time `installation.deleted` arrives the
 *  installation is gone, so GitHub cannot be asked which repositories were its own, and
 *  deleting by workspace would destroy the surviving installations' observations. */
export function deletePrStatusForInstallation(installationId: number): number {
  return db.run("DELETE FROM github_pr_status WHERE installation_id = ?", [installationId]).changes;
}

/** What `installation_repositories.removed` drops. The glyph disappears rather than
 *  rendering indefinitely after access ended. */
export function deletePrStatusForRepo(
  installationId: number,
  repoId: number | null,
  repoFullName: string,
): number {
  return db.run(
    "DELETE FROM github_pr_status WHERE installation_id = ? AND " +
      "(repo_id = ? OR (repo_id IS NULL AND lower(repo) = ?))",
    [installationId, repoId, repoFullName.toLowerCase()],
  ).changes;
}

/** Disconnect: stamp the row rather than delete it, so what was connected stays
 *  auditable — and release the installation id, because the partial unique index only
 *  covers live rows and a stranded id is one nobody can ever reconnect. */
export function disconnectInstallation(wsId: string, id: string): boolean {
  return (
    db.run(
      "UPDATE github_installations SET removed_at = ? WHERE id = ? AND workspace_id = ? AND removed_at IS NULL",
      [Date.now(), id, wsId],
    ).changes > 0
  );
}

/**
 * The database-backed answer to "which installations may this workspace act through".
 *
 * This is what step 1's `WorkspaceHoldings` interface was shaped for. Unclaimed rows are
 * excluded by the `workspace_id = ?` predicate itself, which is the point: an
 * installation belonging to nobody must never be walked as if it belonged to somebody.
 */
/** The synchronous narrowing of WorkspaceHoldings, which allows a promise it never
 *  returns. Structural typing makes it a WorkspaceHoldings wherever one is wanted. */
export interface SyncWorkspaceHoldings extends WorkspaceHoldings {
  installationIds(workspaceId: string): number[];
}

// The return type is the synchronous narrowing rather than the interface itself: this
// implementation answers from SQLite and never awaits, and callers that want the set
// itself should not have to unwrap a promise the interface only allows for.
export function dbWorkspaceHoldings(): SyncWorkspaceHoldings {
  return {
    installationIds(workspaceId: string): number[] {
      return db
        .query<{ installation_id: number }, [string]>(
          "SELECT installation_id FROM github_installations " +
            "WHERE workspace_id = ? AND removed_at IS NULL",
        )
        .all(workspaceId)
        .map((r) => r.installation_id);
    },
  };
}

// ---- the claim row: a proof that crosses a request boundary ----

export interface ClaimRow {
  id: string;
  workspace_id: string;
  user_id: string;
  proven_ids: string | null;
  github_login: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  attached_at: number | null;
}

const CLAIM_COLS =
  "id, workspace_id, user_id, proven_ids, github_login, created_at, expires_at, consumed_at, attached_at";

/** Minutes, not hours: this is a bearer secret in a query string. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

function newSecret(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Mint the OAuth `state`. Bound to both the workspace and the session user id, because
 *  proving *which workspace* and proving *who* are two different questions and the
 *  callback has to ask both. Only the hash is stored. */
export function createClaim(wsId: string, userId: string): { id: string; nonce: string } {
  // Minting is the only moment this table is touched by a human, so it is where the
  // dead rows go — no interval, no second thing to guard.
  sweepExpiredClaims();
  const nonce = newSecret("seer_ghs");
  const id = tinyId("ghc");
  const now = Date.now();
  db.run(
    "INSERT INTO github_app_claims (id, workspace_id, user_id, nonce_hash, created_at, expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [id, wsId, userId, hashKey(nonce), now, now + CLAIM_TTL_MS],
  );
  return { id, nonce };
}

/** The claim a `state` names, whatever state it is in. Unknown, spent and expired are
 *  told apart here and nowhere else: the route collapses them into one refusal. */
export function findClaimByNonce(nonce: string): ClaimRow | null {
  return db
    .query<ClaimRow, [string]>(`SELECT ${CLAIM_COLS} FROM github_app_claims WHERE nonce_hash = ?`)
    .get(hashKey(nonce));
}

export function findClaimByAttachToken(token: string): ClaimRow | null {
  return db
    .query<ClaimRow, [string]>(`SELECT ${CLAIM_COLS} FROM github_app_claims WHERE attach_hash = ?`)
    .get(hashKey(token));
}

/**
 * Burn the nonce and record the proof, in one statement.
 *
 * The `consumed_at IS NULL` predicate is the single-use guard: a replayed `state`
 * changes no rows and gets nothing back, so a callback that arrives twice cannot mint a
 * second attach handle. The proven ids are integers a person demonstrated access to,
 * not a credential — the user access token that produced them is dropped and never
 * reaches this table in any form.
 */
export function consumeClaim(
  claimId: string,
  provenIds: ProvenInstallation[],
  githubLogin: string | null,
): { attachToken: string } | null {
  const attachToken = newSecret("seer_gha");
  const changed = db.run(
    "UPDATE github_app_claims SET consumed_at = ?, proven_ids = ?, github_login = ?, attach_hash = ? " +
      "WHERE id = ? AND consumed_at IS NULL",
    [Date.now(), JSON.stringify(provenIds), githubLogin, hashKey(attachToken), claimId],
  ).changes;
  return changed > 0 ? { attachToken } : null;
}

/** The second burn. Two stages, two burns: without this the attach POST would be
 *  replayable even though the callback that authorised it was not. */
export function burnClaimAttach(claimId: string): boolean {
  return (
    db.run("UPDATE github_app_claims SET attached_at = ? WHERE id = ? AND attached_at IS NULL", [
      Date.now(),
      claimId,
    ]).changes > 0
  );
}

/** One installation a person demonstrated access to. The account fields ride along
 *  because the attach request has no user token left to ask GitHub with — and they are
 *  not a credential, just the display facts that came back with the id. */
export interface ProvenInstallation {
  id: number;
  login: string;
  type: string;
  selection: string;
}

function parseProven(claim: ClaimRow): ProvenInstallation[] {
  if (!claim.proven_ids) return [];
  try {
    const parsed: unknown = JSON.parse(claim.proven_ids);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is ProvenInstallation => !!p && typeof p === "object" && Number.isInteger((p as ProvenInstallation).id))
      .map((p) => ({
        id: p.id,
        login: typeof p.login === "string" ? p.login : `installation ${p.id}`,
        type: typeof p.type === "string" ? p.type : "User",
        selection: typeof p.selection === "string" ? p.selection : "selected",
      }));
  } catch {
    return [];
  }
}

/** The installation ids the person actually proved they can reach. A row that never
 *  reached the callback has none, which is refusal by construction. */
export function claimProvenIds(claim: ClaimRow): number[] {
  return parseProven(claim).map((p) => p.id);
}

/** The proven entry for one id, or null when the proof does not name it. */
export function claimProven(claim: ClaimRow, installationId: number): ProvenInstallation | null {
  return parseProven(claim).find((p) => p.id === installationId) ?? null;
}

export function sweepExpiredClaims(now = Date.now()): number {
  return db.run("DELETE FROM github_app_claims WHERE expires_at < ?", [now - CLAIM_TTL_MS]).changes;
}

// ---- review_prs: which pull requests a page actually renders ----

export interface ReviewPrRow {
  workspace_id: string;
  slug: string;
  repo_id: number | null;
  pr_number: number;
  repo: string;
}

/** Replace a review's pull request set wholesale. A republish that drops #4 and adds #9
 *  must delete #4's row, or a webhook keeps pushing to a review that no longer names it. */
export const setReviewPrs = db.transaction(
  (wsId: string, slug: string, prs: { repo: string; number: number; repoId?: number | null }[]) => {
    db.run("DELETE FROM review_prs WHERE workspace_id = ? AND slug = ?", [wsId, slug]);
    for (const pr of prs) {
      db.run(
        "INSERT OR IGNORE INTO review_prs (workspace_id, slug, repo_id, pr_number, repo) VALUES (?, ?, ?, ?, ?)",
        [wsId, slug, pr.repoId ?? null, pr.number, pr.repo],
      );
    }
  },
) as (
  wsId: string,
  slug: string,
  prs: { repo: string; number: number; repoId?: number | null }[],
) => void;

export function listReviewPrs(wsId: string, slug: string): ReviewPrRow[] {
  return db
    .query<ReviewPrRow, [string, string]>(
      "SELECT * FROM review_prs WHERE workspace_id = ? AND slug = ? ORDER BY repo ASC, pr_number ASC",
    )
    .all(wsId, slug);
}

/**
 * The join, and the whole of the transitional path.
 *
 * ```
 * match on repo_id            when both sides have one
 * fall back to lower(repo)    only when the stored repo_id is null
 * heal null -> id             on the first observation of that row
 * ```
 *
 * The fallback exists solely for rows the migration wrote, and retires itself as they
 * are observed — it is an ending path, not a permanent second join. Without it a
 * backfilled review would never match a delivery and would render unchecked forever
 * while delivery health looked perfectly fine.
 */
export function matchReviewPrs(
  repoId: number,
  repoFullName: string,
  prNumber: number,
): ReviewPrRow[] {
  return db
    .query<ReviewPrRow, [number, number, string]>(
      "SELECT * FROM review_prs WHERE pr_number = ? AND " +
        "(repo_id = ? OR (repo_id IS NULL AND lower(repo) = ?))",
    )
    .all(prNumber, repoId, repoFullName.toLowerCase());
}

/** Every pull request any review in this workspace names, optionally narrowed to a set
 *  of repositories. What reconciliation walks: bounded by the reviews that exist, not
 *  by a clock, and it stops when it has been round them once. */
export function listWorkspacePrs(wsId: string, repos: string[] | null = null): ReviewPrRow[] {
  const rows = db
    .query<ReviewPrRow, [string]>("SELECT * FROM review_prs WHERE workspace_id = ?")
    .all(wsId);
  if (repos === null) return rows;
  const wanted = new Set(repos.map((r) => r.toLowerCase()));
  return rows.filter((r) => wanted.has(r.repo.toLowerCase()));
}

/** Heal a backfilled row the first time an observation names its numeric id. */
export function healReviewPrRepoId(
  wsId: string,
  slug: string,
  repoFullName: string,
  prNumber: number,
  repoId: number,
): void {
  db.run(
    "UPDATE review_prs SET repo_id = ?, repo = ? " +
      "WHERE workspace_id = ? AND slug = ? AND pr_number = ? AND repo_id IS NULL AND lower(repo) = ?",
    [repoId, repoFullName, wsId, slug, prNumber, repoFullName.toLowerCase()],
  );
}

// ---- github_pr_status ----

export interface PrStatusRow {
  workspace_id: string;
  repo_id: number | null;
  pr_number: number;
  installation_id: number;
  repo: string;
  state: string;
  merged: number;
  draft: number;
  head_sha: string;
  updated_at: number;
  observed_at: number;
}

export interface PrObservation {
  repoId: number;
  repo: string;
  prNumber: number;
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  /** GitHub's own timestamp, in milliseconds. The write's whole precondition. */
  updatedAt: number;
}

export function getPrStatus(wsId: string, repoId: number, prNumber: number): PrStatusRow | null {
  return db
    .query<PrStatusRow, [string, number, number]>(
      "SELECT * FROM github_pr_status WHERE workspace_id = ? AND repo_id = ? AND pr_number = ?",
    )
    .get(wsId, repoId, prNumber);
}

/**
 * The observation for one pull request as a page names it: "owner/name" and a number.
 *
 * The read path has no numeric repository id — a stored document carries none — so it
 * asks by the display name, which every observation keeps current. Absence is null and
 * the caller says `unknown` rather than guessing `current`.
 */
export function findPrStatus(wsId: string, repo: string, prNumber: number): PrStatusRow | null {
  return db
    .query<PrStatusRow, [string, string, number]>(
      "SELECT * FROM github_pr_status WHERE workspace_id = ? AND lower(repo) = ? AND pr_number = ? " +
        "ORDER BY updated_at DESC LIMIT 1",
    )
    .get(wsId, repo.toLowerCase(), prNumber);
}

/**
 * The conditional upsert. Newer wins; equal timestamps let the write through, because
 * GitHub's `updated_at` has one-second resolution and a genuine later state is likelier
 * than a duplicate.
 *
 * The precondition is not decoration: publish can race a webhook, and webhooks race each
 * other because GitHub guarantees no delivery order. Without it the single row is just
 * one place where the fact oscillates.
 */
export function upsertPrStatus(
  wsId: string,
  installationId: number,
  obs: PrObservation,
): boolean {
  const existing = getPrStatus(wsId, obs.repoId, obs.prNumber);
  if (existing && existing.updated_at > obs.updatedAt) return false;
  // A row the backfill left with a null repo_id is the same pull request; adopt it
  // rather than writing a second row beside it.
  db.run(
    "DELETE FROM github_pr_status WHERE workspace_id = ? AND repo_id IS NULL AND lower(repo) = ? AND pr_number = ?",
    [wsId, obs.repo.toLowerCase(), obs.prNumber],
  );
  db.run(
    "INSERT OR REPLACE INTO github_pr_status " +
      "(workspace_id, repo_id, pr_number, installation_id, repo, state, merged, draft, head_sha, updated_at, observed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      wsId,
      obs.repoId,
      obs.prNumber,
      installationId,
      obs.repo,
      obs.state,
      obs.merged ? 1 : 0,
      obs.draft ? 1 : 0,
      obs.headSha,
      obs.updatedAt,
      Date.now(),
    ],
  );
  return true;
}

/**
 * Apply one observation of a pull request, attributed by installation.
 *
 * The installation decides whose rows are written and nothing else does — not the
 * repository's name, which is display only. The write is filtered by `review_prs`: an
 * installation covering a whole busy org delivers events for pull requests no review
 * mentions, and those are acknowledged and dropped rather than stored forever.
 *
 * Step 5's webhook endpoint is the caller this exists for; it is here rather than there
 * because the join and the filter are properties of these tables, and the backfill has
 * to be shown to produce rows this can actually match.
 */
export function observePullRequest(installationId: number, obs: PrObservation): number {
  const install = getLiveInstallation(installationId);
  // An unclaimed or unknown installation writes nothing: it belongs to no workspace, so
  // there is no workspace whose rows these would be.
  if (!install || install.workspace_id === null) return 0;
  const wsId = install.workspace_id;

  const named = matchReviewPrs(obs.repoId, obs.repo, obs.prNumber).filter(
    (row) => row.workspace_id === wsId,
  );
  if (named.length === 0) return 0;
  for (const row of named) {
    healReviewPrRepoId(row.workspace_id, row.slug, obs.repo, obs.prNumber, obs.repoId);
  }
  return upsertPrStatus(wsId, installationId, obs) ? named.length : 0;
}

/**
 * Collect status rows no review in this workspace names any more.
 *
 * The counterpart to the filtered upsert: a republish that drops a pull request deletes
 * its `review_prs` row, but the status row is keyed per workspace and may still be named
 * by a *second* review, so it cannot be deleted with the one that dropped it. It goes
 * when nothing names it, which is why this asks the question of the whole workspace and
 * runs inside the publish transaction that changed the answer.
 */
export function sweepOrphanPrStatus(wsId: string): number {
  return db.run(
    "DELETE FROM github_pr_status WHERE workspace_id = ? AND NOT EXISTS (" +
      "SELECT 1 FROM review_prs r WHERE r.workspace_id = github_pr_status.workspace_id " +
      "AND r.pr_number = github_pr_status.pr_number " +
      "AND (r.repo_id = github_pr_status.repo_id OR lower(r.repo) = lower(github_pr_status.repo)))",
    [wsId],
  ).changes;
}

/** Which reviews in a workspace name this pull request. The webhook pushes to the pages
 *  open on each of them, and one pull request may be named by two reviews. */
export function reviewsNaming(wsId: string, repoId: number, repo: string, prNumber: number): string[] {
  return [
    ...new Set(
      matchReviewPrs(repoId, repo, prNumber)
        .filter((r) => r.workspace_id === wsId)
        .map((r) => r.slug),
    ),
  ];
}

// ---- the derived readings ----

export type PrStatusWord = "merged" | "closed" | "draft" | "open";

/** `merged` is tested before `closed` and that is correctness, not style: GitHub's
 *  `state` for a merged pull request *is* `"closed"`, so any other order renders every
 *  merged pull request as closed. */
export function statusOf(row: Pick<PrStatusRow, "state" | "merged" | "draft">): PrStatusWord {
  if (row.merged) return "merged";
  if (row.state === "closed") return "closed";
  if (row.draft) return "draft";
  return "open";
}
