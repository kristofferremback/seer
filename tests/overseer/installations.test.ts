// The rows the GitHub App hangs off, at the level of the database.
//
// The questions that turn on *who is asking* over HTTP are in
// github-install-privacy.script.ts, which runs in its own process because this suite
// runs under AUTH_DISABLED. What is left here is what the tables themselves promise:
// which installations a workspace holds, what a disconnect releases, and the ordering
// precondition that keeps one row from oscillating.
import { beforeEach, expect, test } from "bun:test";
import { db } from "../../src/db";
import { migrate } from "../../src/migrate";
import {
  attachInstallation,
  burnClaimAttach,
  claimProven,
  claimProvenIds,
  consumeClaim,
  createClaim,
  findClaimByAttachToken,
  findClaimByNonce,
  dbWorkspaceHoldings,
  disconnectInstallation,
  getLiveInstallation,
  getPrStatus,
  listReviewPrs,
  listWorkspaceInstallations,
  matchReviewPrs,
  observePullRequest,
  recordUnclaimedInstallation,
  setReviewPrs,
  statusOf,
  upsertPrStatus,
} from "../../src/overseer/installations";

const WS_A = "ws_aaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbb";
const USER = "usr_aaaaaaaaaa";

beforeEach(() => {
  migrate();
  db.run("DELETE FROM github_installations");
  db.run("DELETE FROM github_pr_status");
  db.run("DELETE FROM review_prs");
  db.run("DELETE FROM github_app_claims");
});

function attach(wsId: string, installationId: number, login = "acme") {
  return attachInstallation({
    wsId,
    userId: USER,
    installationId,
    accountLogin: login,
    accountId: 1,
    accountType: "Organization",
    repositorySelection: "all",
  });
}

// ---- holdings: the lookup step 1 could only prove against a fake ----

test("a workspace holds exactly what it claimed, and nothing unclaimed", () => {
  attach(WS_A, 111);
  attach(WS_A, 112);
  attach(WS_B, 222);
  recordUnclaimedInstallation({
    installationId: 999,
    accountLogin: "nobody",
    accountId: 9,
    accountType: "User",
    repositorySelection: "selected",
  });

  const holdings = dbWorkspaceHoldings();
  expect(holdings.installationIds(WS_A).sort()).toEqual([111, 112]);
  expect(holdings.installationIds(WS_B)).toEqual([222]);
  // An unclaimed row belongs to nobody, so it belongs to no workspace-keyed query.
  expect(holdings.installationIds(WS_A)).not.toContain(999);
  expect(listWorkspaceInstallations(WS_A).map((r) => r.installation_id).sort()).toEqual([111, 112]);
});

test("an unclaimed row still reserves the id, which is what stops a claim race", () => {
  recordUnclaimedInstallation({
    installationId: 111,
    accountLogin: "acme",
    accountId: 1,
    accountType: "Organization",
    repositorySelection: "all",
  });
  attach(WS_A, 111);
  // The claim adopted the reserved row rather than writing a second one beside it.
  const rows = db
    .query<{ c: number }, [number]>("SELECT COUNT(*) c FROM github_installations WHERE installation_id = ?")
    .get(111)!.c;
  expect(rows).toBe(1);
  expect(getLiveInstallation(111)!.workspace_id).toBe(WS_A);
});

test("an installation another workspace holds is refused, and re-claiming your own is not", () => {
  attach(WS_A, 111);
  expect(attach(WS_B, 111)).toBe("already_claimed");
  expect(getLiveInstallation(111)!.workspace_id).toBe(WS_A);
  // The success beside it: the workspace that already holds it may say so again — a
  // double-submitted form and setup_action=update both land here.
  expect(attach(WS_A, 111)).not.toBe("already_claimed");
});

test("disconnect releases the id rather than stranding it, and keeps the audit row", () => {
  const row = attach(WS_A, 111);
  expect(typeof row === "string" ? null : row.id).toBeTruthy();
  const id = (row as { id: string }).id;

  expect(disconnectInstallation(WS_B, id)).toBe(false); // not B's to disconnect
  expect(disconnectInstallation(WS_A, id)).toBe(true);
  expect(getLiveInstallation(111)).toBeNull();
  expect(dbWorkspaceHoldings().installationIds(WS_A)).toEqual([]);

  const audit = db
    .query<{ c: number }, [number]>("SELECT COUNT(*) c FROM github_installations WHERE installation_id = ?")
    .get(111)!.c;
  expect(audit).toBe(1);
  // Released, not stranded: the partial index only covers live rows.
  expect(attach(WS_B, 111)).not.toBe("already_claimed");
  expect(getLiveInstallation(111)!.workspace_id).toBe(WS_B);
});

// ---- the claim row ----

test("the nonce burns once, and the burn is what records the proof", () => {
  const { id, nonce } = createClaim(WS_A, USER);
  const claim = findClaimByNonce(nonce)!;
  expect(claim.id).toBe(id);
  expect(claim.workspace_id).toBe(WS_A);
  expect(claim.user_id).toBe(USER);
  expect(claimProvenIds(claim)).toEqual([]); // nothing is proved until the callback

  const proven = [{ id: 111, login: "acme", type: "Organization", selection: "all" }];
  const first = consumeClaim(id, proven, "acme");
  expect(first).not.toBeNull();
  // A replayed state changes nothing and mints no second handle.
  expect(consumeClaim(id, proven, "acme")).toBeNull();

  const after = findClaimByAttachToken(first!.attachToken)!;
  expect(claimProvenIds(after)).toEqual([111]);
  expect(claimProven(after, 111)!.login).toBe("acme");
  expect(claimProven(after, 222)).toBeNull();

  expect(burnClaimAttach(after.id)).toBe(true);
  expect(burnClaimAttach(after.id)).toBe(false);
});

test("an expired claim is still findable, so the route can refuse it rather than 500", () => {
  const { id, nonce } = createClaim(WS_A, USER);
  db.run("UPDATE github_app_claims SET expires_at = ? WHERE id = ?", [Date.now() - 1, id]);
  const claim = findClaimByNonce(nonce)!;
  expect(claim.expires_at).toBeLessThan(Date.now());
});

// ---- review_prs ----

test("republishing replaces a review's pull request set wholesale", () => {
  setReviewPrs(WS_A, "stack", [
    { repo: "acme/seer", number: 4 },
    { repo: "acme/seer", number: 5 },
  ]);
  setReviewPrs(WS_A, "stack", [{ repo: "acme/seer", number: 9 }]);
  expect(listReviewPrs(WS_A, "stack").map((r) => r.pr_number)).toEqual([9]);
});

test("the join matches on repo_id, falls back to the name, and heals", () => {
  // A backfilled row: no numeric id anywhere in the v4 document to write.
  db.run(
    "INSERT INTO review_prs (workspace_id, slug, repo_id, pr_number, repo) VALUES (?, ?, NULL, ?, ?)",
    [WS_A, "old", 42, "AcMe/Seer"],
  );
  expect(matchReviewPrs(55501, "acme/seer", 42)).toHaveLength(1);
  expect(matchReviewPrs(55501, "acme/other", 42)).toHaveLength(0);

  attach(WS_A, 111);
  expect(
    observePullRequest(111, {
      repoId: 55501,
      repo: "acme/seer",
      prNumber: 42,
      state: "open",
      merged: false,
      draft: false,
      headSha: "a".repeat(40),
      updatedAt: 1000,
    }),
  ).toBe(1);
  expect(listReviewPrs(WS_A, "old")[0]!.repo_id).toBe(55501);
  // Healed: it now matches by id, whatever the name does next.
  expect(matchReviewPrs(55501, "acme/renamed", 42)).toHaveLength(1);
});

test("an observation for a pull request no review names writes nothing", () => {
  attach(WS_A, 111);
  const applied = observePullRequest(111, {
    repoId: 55501,
    repo: "acme/seer",
    prNumber: 7,
    state: "open",
    merged: false,
    draft: false,
    headSha: "a".repeat(40),
    updatedAt: 1000,
  });
  expect(applied).toBe(0);
  expect(getPrStatus(WS_A, 55501, 7)).toBeNull();
});

test("an event for A writes into A and leaves B untouched", () => {
  attach(WS_A, 111);
  attach(WS_B, 222);
  setReviewPrs(WS_A, "a-review", [{ repo: "acme/seer", number: 12, repoId: 55501 }]);
  setReviewPrs(WS_B, "b-review", [{ repo: "acme/seer", number: 12, repoId: 55501 }]);

  observePullRequest(111, {
    repoId: 55501,
    repo: "acme/seer",
    prNumber: 12,
    state: "open",
    merged: false,
    draft: false,
    headSha: "a".repeat(40),
    updatedAt: 1000,
  });
  expect(getPrStatus(WS_A, 55501, 12)).not.toBeNull();
  expect(getPrStatus(WS_B, 55501, 12)).toBeNull();
});

// ---- ordering ----

test("an older observation applied after a newer one does not overwrite it", () => {
  const newer = {
    repoId: 55501,
    repo: "acme/seer",
    prNumber: 12,
    state: "closed",
    merged: true,
    draft: false,
    headSha: "b".repeat(40),
    updatedAt: 2000,
  };
  expect(upsertPrStatus(WS_A, 111, newer)).toBe(true);
  expect(upsertPrStatus(WS_A, 111, { ...newer, state: "open", merged: false, updatedAt: 1000 })).toBe(
    false,
  );
  expect(getPrStatus(WS_A, 55501, 12)!.merged).toBe(1);
  // Equal timestamps let the write through: GitHub's updated_at has one-second
  // resolution, so a genuine later state is likelier than a duplicate.
  expect(upsertPrStatus(WS_A, 111, { ...newer, headSha: "c".repeat(40), updatedAt: 2000 })).toBe(true);
  expect(getPrStatus(WS_A, 55501, 12)!.head_sha).toBe("c".repeat(40));
});

test("merged is read before closed, or every merged pull request renders as closed", () => {
  expect(statusOf({ state: "closed", merged: 1, draft: 0 })).toBe("merged");
  expect(statusOf({ state: "closed", merged: 0, draft: 0 })).toBe("closed");
  expect(statusOf({ state: "open", merged: 0, draft: 1 })).toBe("draft");
  expect(statusOf({ state: "open", merged: 0, draft: 0 })).toBe("open");
});
