// Seeing that the net is there.
//
// Nothing polls GitHub any more. A review's status is exactly as true as the last thing
// that touched it, which means two silences have to become visible or deleting the poll
// traded a small recurring cost for an invisible failure:
//
//   * an observation nobody has confirmed for longer than the threshold, which the page
//     dates rather than stating bare, and which the refresh control repairs;
//   * an installation that has stopped delivering, which settings says without being
//     asked.
//
// Both halves are tested here, and each refusal has its success beside it: a fresh
// observation renders bare, a live installation is not called quiet. A page that always
// said "as of" would tell a reader nothing by saying it.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { db } from "../../src/db";
import { createWorkspace, createVersion, legacyWorkspaceId, listMembers } from "../../src/db";
import { asOfMark } from "../../src/overseer/render";
import { observedAtOf } from "../../src/overseer/read";
import { getReviewVersion } from "../../src/overseer/db";
import {
  attachInstallation,
  deliveryIsQuiet,
  DELIVERY_QUIET_MS,
  getLiveInstallation,
  recordInstallationDelivery,
  upsertPrStatus,
} from "../../src/overseer/installations";
import { agoWords } from "../../src/relative-time";
import { OBSERVATION_STALE_MS } from "../../src/overseer/types";
import { GOLDEN_BUNDLE_SLUG, GOLDEN_BUNDLE_VERSION, GOLDEN_REPO } from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { resetChecks } from "../../src/overseer/freshness";
import { offlineGithubClientFactory } from "../offline-github";
import type { GithubClient, GithubPull } from "../../src/overseer/github";

const REPO_ID = 1301620029;
const INSTALLATION = 990125;

/** Just enough GitHub to re-observe the golden pull requests where they already are:
 *  the repair has to be shown to move `observed_at` without moving anything else. */
const HEADS: Record<number, string> = {};

const fake: GithubClient = {
  async installationFor() {
    return INSTALLATION;
  },
  async getPull(_repo, number): Promise<GithubPull> {
    return {
      number,
      title: `pull ${number}`,
      body: "",
      state: "open",
      merged: false,
      draft: false,
      user: { login: "kremback" },
      head: { sha: HEADS[number]!, ref: `branch-${number}` },
      base: { sha: "0".repeat(40), ref: "main", repo: { id: REPO_ID, full_name: GOLDEN_REPO } },
      updated_at: "2026-07-19T06:27:55Z",
    };
  },
  async listCommits() {
    return [];
  },
  async listFiles() {
    return [];
  },
  async listReviewComments() {
    return [];
  },
  async getFileAtSha() {
    return "";
  },
  async getPullDiff() {
    throw new Error("not used here");
  },
};

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let ws = "";
let owner = "";

/** Observe both of the golden review's pull requests at their published heads, then
 *  move `observed_at` to whatever age the test is about. The upsert always stamps
 *  "now", so ageing is a separate write — which is honest: nothing in production can
 *  make an observation older than it is either. */
function observeGolden(slug: string, observedAt: number): void {
  const row = getReviewVersion(ws, slug, 1)!;
  for (const pr of row.doc.prs) {
    HEADS[pr.number] = pr.headSha;
    upsertPrStatus(ws, INSTALLATION, {
      repoId: REPO_ID,
      repo: pr.repo,
      prNumber: pr.number,
      state: "open",
      merged: false,
      draft: false,
      headSha: pr.headSha,
      updatedAt: Date.parse("2026-07-19T06:27:55Z"),
    });
  }
  db.run("UPDATE github_pr_status SET observed_at = ? WHERE workspace_id = ?", [observedAt, ws]);
}

async function pageOf(slug: string): Promise<string> {
  const res = await fetch(`${base}/${ws}/r/${slug}`);
  expect(res.status).toBe(200);
  return res.text();
}

function chip(html: string): string {
  const found = /<span class="heads" id="heads">([^<]*)</.exec(html);
  expect(found).not.toBeNull();
  return found![1]!;
}

/** The dateline as the page drew it, or null when the page drew none. Read out of the
 *  element rather than searched for as a substring, so the script's own strings cannot
 *  be mistaken for the mark. */
function asOf(html: string): string | null {
  const found = /<span class="asof" id="asof">([^<]*)</.exec(html);
  return found ? found[1]! : null;
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Net", owner);
  // The golden document points its evidence at this bundle version.
  for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(ws, GOLDEN_BUNDLE_SLUG, 10, 1);
});

afterAll(() => {
  server.stop(true);
});

// ---- the threshold itself ----

describe("the observation threshold", () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  test("an observation inside the threshold is stated bare", () => {
    expect(asOfMark(now - (OBSERVATION_STALE_MS - 60_000), now)).toBe("");
  });

  test("an observation past the threshold is dated", () => {
    const mark = asOfMark(now - 3 * 60 * 60 * 1000, now);
    expect(mark).toContain("as of 3 hours ago");
    expect(mark).toContain('id="asof"');
  });

  test("no observation at all has no age to report", () => {
    // Absence is already said by the chip ("heads unchecked"). Dating a row that does
    // not exist would be inventing a time nothing was observed at.
    expect(asOfMark(null, now)).toBe("");
  });

  test("the threshold is one hour, and it is one constant", () => {
    expect(OBSERVATION_STALE_MS).toBe(60 * 60 * 1000);
    expect(asOfMark(now - 59 * 60_000, now)).toBe("");
    expect(asOfMark(now - 61 * 60_000, now)).toContain("as of 1 hour ago");
  });

  test("ages are said in words a reader can act on", () => {
    expect(agoWords(30_000)).toBe("just now");
    expect(agoWords(5 * 60_000)).toBe("5 minutes ago");
    expect(agoWords(60 * 60_000)).toBe("1 hour ago");
    expect(agoWords(14 * 24 * 60 * 60_000)).toBe("14 days ago");
  });
});

// ---- the page ----

describe("a review page dates an observation it can no longer vouch for", () => {
  test("a fresh observation renders the reading and nothing else", async () => {
    storeGoldenReview(ws, "fresh");
    observeGolden("fresh", Date.now());

    const html = await pageOf("fresh");
    expect(chip(html)).toBe("up to date");
    // The success beside the refusal: the page can say "as of" and here it does not,
    // because there is nothing to disclaim.
    expect(asOf(html)).toBeNull();
  });

  test("an observation older than the threshold renders as of <time>", async () => {
    storeGoldenReview(ws, "stale");
    const threeHours = Date.now() - 3 * 60 * 60 * 1000;
    observeGolden("stale", threeHours);

    const html = await pageOf("stale");
    // The reading is still there — this is a dateline on a status, not a replacement
    // for one.
    expect(chip(html)).toBe("up to date");
    expect(asOf(html)).toBe("as of 3 hours ago");
  });

  test("the page reports the age of its stalest row, not its freshest", () => {
    storeGoldenReview(ws, "mixed");
    const old = Date.now() - 5 * 60 * 60 * 1000;
    observeGolden("mixed", old);
    const doc = getReviewVersion(ws, "mixed", 1)!.doc;
    // One pull request re-observed a moment ago must not vouch for the other.
    db.run(
      "UPDATE github_pr_status SET observed_at = ? WHERE workspace_id = ? AND pr_number = ?",
      [Date.now(), ws, doc.prs[0]!.number],
    );
    expect(observedAtOf(ws, "mixed", doc)).toBe(old);
  });

  test("a review nothing has observed reports no age", () => {
    // Its own workspace: observations are keyed per workspace and per pull request,
    // not per review, so a second review of the same pull requests in this workspace
    // would inherit rows and prove nothing.
    const blind = createWorkspace("Unobserved", owner);
    for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(blind, GOLDEN_BUNDLE_SLUG, 10, 1);
    storeGoldenReview(blind, "blind");
    const doc = getReviewVersion(blind, "blind", 1)!.doc;
    expect(observedAtOf(blind, "blind", doc)).toBeNull();
  });
});

// ---- the repair ----

describe("the refresh control", () => {
  test("a member reading the current version is offered it, beside the chip", async () => {
    storeGoldenReview(ws, "repairable");
    observeGolden("repairable", Date.now() - 3 * 60 * 60 * 1000);

    const html = await pageOf("repairable");
    expect(html).toContain('id="refresh"');
    // It posts to the one route left that reaches GitHub, and it is a button rather
    // than something a render triggers.
    expect(html).toContain("/api/reviews/");
    expect(html).toContain('class="refresh"');
    // Beside the chip: same paragraph, after it.
    expect(html.indexOf('id="heads"')).toBeLessThan(html.indexOf('id="refresh"'));
  });

  test("a pinned version offers no repair, because it is a record", async () => {
    const res = await fetch(`${base}/${ws}/r/repairable/v/1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The version is pinned, so this page is what was published rather than what is
    // true now — and the route the button posts to refreshes the current version,
    // which is not this one.
    expect(html).not.toContain('id="refresh"');
  });

  test("pressing it re-observes, and the page stops saying as of", async () => {
    // The point of the control is not that it answers: it is that the dateline goes
    // away because the observation behind it is new. Without this the button could be
    // a no-op and every assertion above would still pass.
    resetChecks();
    setGithubClientFactory((forWs) => (forWs === ws ? fake : offlineGithubClientFactory()(forWs)));
    try {
      expect(asOf(await pageOf("repairable"))).toBe("as of 3 hours ago");

      const res = await fetch(`${base}/api/reviews/repairable/refresh`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checked: boolean; prs: unknown[] };
      expect(body.checked).toBe(true);
      expect(body.prs.length).toBe(2);

      const doc = getReviewVersion(ws, "repairable", 1)!.doc;
      expect(Date.now() - observedAtOf(ws, "repairable", doc)!).toBeLessThan(OBSERVATION_STALE_MS);
      expect(asOf(await pageOf("repairable"))).toBeNull();
    } finally {
      setGithubClientFactory(offlineGithubClientFactory());
    }
  });
});

// ---- delivery health ----

describe("delivery health per installation", () => {
  function connect(): void {
    attachInstallation({
      wsId: ws,
      userId: owner,
      installationId: INSTALLATION,
      accountLogin: "threahq",
      accountId: 42,
      accountType: "Organization",
      repositorySelection: "all",
    });
  }

  async function settings(): Promise<string> {
    const res = await fetch(`${base}/settings/${ws}`);
    expect(res.status).toBe(200);
    return res.text();
  }

  test("a delivery arriving is recorded against the installation that sent it", () => {
    connect();
    const at = Date.now() - 60_000;
    recordInstallationDelivery(INSTALLATION, at);
    expect(getLiveInstallation(INSTALLATION)!.last_delivery_at).toBe(at);
    expect(deliveryIsQuiet(at)).toBe(false);
  });

  test("a live installation is not called quiet", async () => {
    connect();
    recordInstallationDelivery(INSTALLATION, Date.now() - 5 * 60_000);
    const html = await settings();
    expect(html).toContain("threahq");
    expect(html).toContain("5 minutes ago");
    expect(html).not.toContain("no recent deliveries");
  });

  test("an installation whose last delivery is old says so without being asked", async () => {
    connect();
    const old = Date.now() - 14 * 24 * 60 * 60 * 1000;
    recordInstallationDelivery(INSTALLATION, old);
    expect(deliveryIsQuiet(old)).toBe(true);

    const html = await settings();
    expect(html).toContain("14 days ago");
    expect(html).toContain("no recent deliveries");
  });

  test("an installation that has never delivered is quiet, not healthy", async () => {
    connect();
    db.run("UPDATE github_installations SET last_delivery_at = NULL WHERE installation_id = ?", [
      INSTALLATION,
    ]);
    expect(deliveryIsQuiet(null)).toBe(true);

    const html = await settings();
    expect(html).toContain("never");
    expect(html).toContain("no recent deliveries");
  });

  test("suspension is reported beside it, since a suspended installation stops talking", async () => {
    connect();
    db.run("UPDATE github_installations SET suspended_at = ? WHERE installation_id = ?", [
      Date.now(),
      INSTALLATION,
    ]);
    const html = await settings();
    expect(html).toContain("suspended");
    db.run("UPDATE github_installations SET suspended_at = NULL WHERE installation_id = ?", [
      INSTALLATION,
    ]);
    expect(await settings()).not.toContain(">suspended<");
  });

  test("the quiet threshold is longer than the observation one, and deliberately", () => {
    // The two silences are different questions: an afternoon without a delivery is a
    // quiet repository, while an hour without a confirmed observation is a page that
    // should stop asserting.
    expect(DELIVERY_QUIET_MS).toBeGreaterThan(OBSERVATION_STALE_MS);
    expect(deliveryIsQuiet(Date.now() - (DELIVERY_QUIET_MS - 60_000))).toBe(false);
    expect(deliveryIsQuiet(Date.now() - (DELIVERY_QUIET_MS + 60_000))).toBe(true);
  });
});

// ---- the observations the App inherited ----

describe("a head recorded before the App still answers the chip", () => {
  // `review_freshness` is what a review published before the App left behind: a head
  // per pull request, per review, and nothing about state. The v5 migration could not
  // turn that into a status row without inventing the state, so the reading has to
  // come off the old table at read time or an upgrade silently forgets a warning a
  // reader was already acting on.
  let wsOld = "";

  function record(slug: string, prNumber: number, sha: string, checkedAt: number = Date.now()): void {
    db.run(
      "INSERT OR REPLACE INTO review_freshness " +
        "(workspace_id, slug, repo, pr_number, observed_head_sha, checked_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [wsOld, slug, GOLDEN_REPO, prNumber, sha, checkedAt],
    );
  }

  async function oldPageOf(slug: string): Promise<string> {
    const res = await fetch(`${base}/${wsOld}/r/${slug}`);
    expect(res.status).toBe(200);
    return res.text();
  }

  beforeAll(() => {
    // Its own workspace: `github_pr_status` keys on the pull request rather than the
    // review, so a workspace whose other reviews have been observed has no pre-App
    // case left to test.
    wsOld = createWorkspace("Before the App", owner);
    for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(wsOld, GOLDEN_BUNDLE_SLUG, 10, 1);
  });

  test("a head that had moved still reads behind, with no glyph beside it", async () => {
    storeGoldenReview(wsOld, "pre-app-behind");
    const doc = getReviewVersion(wsOld, "pre-app-behind", 1)!.doc;
    record("pre-app-behind", doc.prs[0]!.number, "9".repeat(40));
    record("pre-app-behind", doc.prs[1]!.number, doc.prs[1]!.headSha);

    const html = await oldPageOf("pre-app-behind");
    expect(chip(html)).toBe("1 of 2 behind");
    // The old table never knew open, merged, closed or draft, so the card draws no
    // glyph: the fallback restores the recorded fact and not a status nobody observed.
    expect(html).not.toContain('href="#i-pr-');
  });

  test("and the reading arrives dated, because nobody has confirmed it since", async () => {
    storeGoldenReview(wsOld, "pre-app-dated");
    const doc = getReviewVersion(wsOld, "pre-app-dated", 1)!.doc;
    // Recorded long before the migration. The chip is about to assert this reading,
    // and undated it would be trusted as though somebody had just confirmed it — the
    // "as of" mark is the only hedge a reading this old gets.
    const months = Date.now() - 90 * 24 * 60 * 60 * 1000;
    record("pre-app-dated", doc.prs[0]!.number, doc.prs[0]!.headSha, months);
    record("pre-app-dated", doc.prs[1]!.number, doc.prs[1]!.headSha, months);

    const html = await oldPageOf("pre-app-dated");
    expect(chip(html)).toBe("up to date");
    expect(asOf(html)).not.toBeNull();
  });

  test("and a head that had not moved reads up to date", async () => {
    storeGoldenReview(wsOld, "pre-app-current");
    const doc = getReviewVersion(wsOld, "pre-app-current", 1)!.doc;
    for (const pr of doc.prs) record("pre-app-current", pr.number, pr.headSha);

    expect(chip(await oldPageOf("pre-app-current"))).toBe("up to date");
  });

  test("with neither row the chip is still unchecked", async () => {
    // The refusal beside the two successes: the fallback answers from what was
    // recorded and invents nothing when nothing was.
    storeGoldenReview(wsOld, "pre-app-silent");
    expect(chip(await oldPageOf("pre-app-silent"))).toBe("heads unchecked");
  });
});
