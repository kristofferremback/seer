// One observation, and the two readings that come off it.
//
// The claims here are the ones the design rests on. A published review has its status
// before any webhook exists, because the publish transaction writes what the getPull it
// already made saw — with polling gone there is no second thing that would fill that
// window, and for a pull request that is already merged there may never be a delivery
// at all. Absence is absence on all three surfaces that speak about it: the glyph, the
// chip and the refresh route's JSON, which had three separate defaults quietly reading
// "nobody has looked" as "current". A merged pull request reads merged and not closed,
// which is correctness rather than style: GitHub's `state` for a merged pull request
// *is* "closed". And an older observation landing after a newer one does not win.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { createVersion, createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import {
  findPrStatus,
  statusOf,
  upsertPrStatus,
  type PrObservation,
} from "../../src/overseer/installations";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { resetChecks } from "../../src/overseer/freshness";
import { offlineGithubClientFactory } from "../offline-github";
import type { GithubClient, GithubFile, GithubPull } from "../../src/overseer/github";
import {
  GOLDEN_BASE_SHA,
  GOLDEN_BUNDLE_SLUG,
  GOLDEN_BUNDLE_VERSION,
  GOLDEN_HEAD_SHA_12,
  GOLDEN_HEAD_SHA_13,
  GOLDEN_HUNKS,
  GOLDEN_REPO,
  goldenPayload,
} from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";
import type { PublishPayload } from "../../src/overseer/validate";

// ---- the fake GitHub, whose pull requests this file moves ----

const REPO_ID = 1301620029;
const INSTALLATION = 5150;

function patchFor(oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  const k = Math.min(oldLines, newLines);
  const lines = [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`];
  for (let i = 0; i < k; i++) lines.push(` context line ${i}`);
  for (let i = k; i < oldLines; i++) lines.push(`-removed line ${i}`);
  for (let i = k; i < newLines; i++) lines.push(`+added line ${i}`);
  return lines.join("\n");
}

function fileOf(h: {
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}): GithubFile {
  return {
    filename: h.path,
    status: h.oldLines === 0 ? "added" : "modified",
    additions: h.newLines,
    deletions: h.oldLines,
    changes: h.newLines + h.oldLines,
    patch: patchFor(h.oldStart, h.oldLines, h.newStart, h.newLines),
  };
}

const FILES: Record<number, GithubFile[]> = {
  12: [fileOf(GOLDEN_HUNKS.auth), fileOf(GOLDEN_HUNKS.serverGate)],
  13: [fileOf(GOLDEN_HUNKS.serverApi), fileOf(GOLDEN_HUNKS.routes), fileOf(GOLDEN_HUNKS.tests)],
};

/** What GitHub currently says about each pull request. Tests move this. */
interface PullState {
  state: string;
  merged: boolean;
  draft: boolean;
  updatedAt: string;
}

const pulls: Record<number, PullState> = {
  12: { state: "open", merged: false, draft: false, updatedAt: "2026-07-19T06:27:55Z" },
  13: { state: "open", merged: false, draft: false, updatedAt: "2026-07-19T08:12:28Z" },
};

function resetPulls(): void {
  pulls[12] = { state: "open", merged: false, draft: false, updatedAt: "2026-07-19T06:27:55Z" };
  pulls[13] = { state: "open", merged: false, draft: false, updatedAt: "2026-07-19T08:12:28Z" };
}

const fake: GithubClient = {
  // The client is the only thing that knows which installation a repository routed
  // through, which is why the seam for it lives here rather than beside the caller.
  async installationFor() {
    return INSTALLATION;
  },
  async getPull(_repo, number): Promise<GithubPull> {
    const now = pulls[number]!;
    return {
      number,
      title: number === 12 ? "Put reviews behind the workspace session gate" : "Add the review publish and read endpoints",
      body: "",
      state: now.state,
      merged: now.merged,
      draft: now.draft,
      user: { login: "kremback" },
      head: {
        sha: number === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13,
        ref: number === 12 ? "reviews-session-gate" : "reviews-api",
      },
      base: {
        sha: number === 12 ? GOLDEN_BASE_SHA : GOLDEN_HEAD_SHA_12,
        ref: number === 12 ? "main" : "reviews-session-gate",
        repo: { id: REPO_ID, full_name: GOLDEN_REPO },
      },
      updated_at: now.updatedAt,
    };
  },
  async listCommits(_repo, number) {
    return [
      {
        sha: number === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13,
        commit: { message: "A commit", author: null },
        author: null,
      },
    ];
  },
  async listFiles(_repo, number) {
    return FILES[number]!;
  },
  async listReviewComments() {
    return [];
  },
  async getFileAtSha(_repo, path) {
    return Array.from({ length: 400 }, (_, i) => `// ${path} line ${i + 1}`).join("\n") + "\n";
  },
  async getPullDiff() {
    throw new Error("every file carries its own patch");
  },
};

// ---- the server ----

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
/** The workspace that publishes through the fake, and so has observations. */
let wsSeen = "";
let keySeen = "";
/** A workspace whose reviews nothing has ever observed. */
let wsBlind = "";
let keyBlind = "";

/** The golden payload with its attachment removed: attachment bytes travel as
 *  multipart parts, and nothing here is about attachments. */
function noAttachments(): PublishPayload {
  const payload = goldenPayload();
  payload.attachments = [];
  for (const s of payload.statements) {
    s.evidence = s.evidence.filter((e) => e.type !== "attachment");
  }
  return payload;
}

function publish(slug: string, key = keySeen): Promise<Response> {
  return fetch(`${base}/api/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ slug, ...noAttachments() }),
  });
}

/** The heads chip as the page drew it. Read out of the element rather than searched
 *  for in the page, because the enhancement script carries every sentence the chip can
 *  say and a substring match would find those too. */
function chip(html: string): string {
  const found = /<span class="heads" id="heads">([^<]*)</.exec(html);
  expect(found).not.toBeNull();
  return found![1]!;
}

async function pageOf(wsId: string, slug: string): Promise<string> {
  const res = await fetch(`${base}/${wsId}/r/${slug}`);
  expect(res.status).toBe(200);
  return res.text();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  expect(res.status).toBe(200);
  return res.json();
}

function refresh(slug: string, key: string): Promise<Response> {
  return fetch(`${base}/api/reviews/${slug}/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
  });
}

function observation(over: Partial<PrObservation> = {}): PrObservation {
  return {
    repoId: REPO_ID,
    repo: GOLDEN_REPO,
    prNumber: 12,
    state: "open",
    merged: false,
    draft: false,
    headSha: GOLDEN_HEAD_SHA_12,
    updatedAt: Date.parse("2026-07-19T06:27:55Z"),
    ...over,
  };
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsSeen = createWorkspace("Observed", owner);
  keySeen = mintApiKey(owner, wsSeen, "observed").token;
  wsBlind = createWorkspace("Unobserved", owner);
  keyBlind = mintApiKey(owner, wsBlind, "unobserved").token;
  for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(wsSeen, GOLDEN_BUNDLE_SLUG, 10, 1);
  // Only the publishing workspace reaches the fake. wsBlind gets the offline client,
  // which is what makes "nothing ever observed this" true rather than arranged.
  setGithubClientFactory((ws) => (ws === wsSeen ? fake : offlineGithubClientFactory()(ws)));
});

afterAll(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  server.stop(true);
});

describe("publish seeds the observation", () => {
  test("a published review renders its glyphs with no webhook and no poll", async () => {
    resetPulls();
    resetChecks();
    expect((await publish("seeded")).status).toBe(200);

    // The rows are there the moment the publish transaction commits: nothing was
    // delivered, nothing was polled, and the only GitHub call was the one the
    // derivation was making anyway.
    const twelve = findPrStatus(wsSeen, GOLDEN_REPO, 12)!;
    expect(twelve).not.toBeNull();
    expect(twelve.installation_id).toBe(INSTALLATION);
    expect(twelve.repo_id).toBe(REPO_ID);
    expect(twelve.head_sha).toBe(GOLDEN_HEAD_SHA_12);
    expect(statusOf(twelve)).toBe("open");
    expect(statusOf(findPrStatus(wsSeen, GOLDEN_REPO, 13)!)).toBe("open");

    const html = await pageOf(wsSeen, "seeded");
    expect(html).toContain('aria-label="open"');
    expect(html).toContain('class="ic c-status s-open"');
    expect(html).toContain('href="#i-pr-open"');
    // Both heads are exactly what the review was published against, and both are
    // observed, so the chip says so without hedging.
    expect(chip(html)).toBe("heads current");
  });

  test("a merged pull request renders merged, not closed", async () => {
    resetPulls();
    resetChecks();
    // GitHub's own shape for a merged pull request: state is "closed" and merged is
    // true. Testing state before merged renders every merged pull request as closed.
    pulls[13] = { state: "closed", merged: true, draft: false, updatedAt: "2026-07-20T09:00:00Z" };
    pulls[12] = { state: "open", merged: false, draft: true, updatedAt: "2026-07-20T09:00:00Z" };
    expect((await publish("merged-first")).status).toBe(200);

    expect(statusOf(findPrStatus(wsSeen, GOLDEN_REPO, 13)!)).toBe("merged");
    expect(statusOf(findPrStatus(wsSeen, GOLDEN_REPO, 12)!)).toBe("draft");

    const html = await pageOf(wsSeen, "merged-first");
    expect(html).toContain('aria-label="merged"');
    expect(html).toContain('class="ic c-status s-merged"');
    // The whole point: the merged pull request is closed on GitHub and must not read
    // that way here, and no card claims it.
    expect(html).not.toContain('aria-label="closed"');
    // The fourth state is drawn too, and the four are told apart by shape and by the
    // word rather than by colour alone.
    expect(html).toContain('aria-label="draft"');
    expect(html).toContain('class="ic c-status s-draft"');
    expect(html).toContain('href="#i-pr-merged"');
    expect(html).toContain('href="#i-pr-draft"');
  });

  test("the four readings come off the row in the one order that is correct", () => {
    // The word is what the accessible name carries and what the glyph is chosen by, so
    // this is the ordering rule stated once more where it is cheapest to read: a
    // merged pull request is closed on GitHub, and merged has to be asked first.
    const words = ["open", "merged", "closed", "draft"] as const;
    const rows = [
      observation({ state: "open" }),
      observation({ state: "closed", merged: true }),
      observation({ state: "closed" }),
      observation({ state: "open", draft: true }),
    ];
    expect(rows.map((o) => statusOf({ state: o.state, merged: o.merged ? 1 : 0, draft: o.draft ? 1 : 0 }))).toEqual([
      ...words,
    ]);
  });
});

describe("an absent observation is absence, on all three surfaces", () => {
  test("no glyph, an unchecked chip, and unknown from the refresh route", async () => {
    resetChecks();
    storeGoldenReview(wsBlind, "unseen");
    expect(findPrStatus(wsBlind, GOLDEN_REPO, 12)).toBeNull();

    // 1. the glyph: nothing, rather than a fourth state Seer invented.
    const html = await pageOf(wsBlind, "unseen");
    // The stylesheet names the class whether or not a card uses it, so the glyph is
    // looked for by its sprite reference, which only a drawn glyph emits.
    expect(html).not.toContain('href="#i-pr-');
    // 2. the chip: it used to collapse to "heads current" on `behind === 0`, which is
    // the chip asserting a freshness the glyph beside it cannot show.
    expect(chip(html)).toBe("heads unchecked");

    // 3a. the read route's freshness map.
    const read = await readJson(await fetch(`${base}/api/reviews/unseen`, {
      headers: { authorization: `Bearer ${keyBlind}` },
    }));
    expect(read.document.freshness).toEqual({
      [`${GOLDEN_REPO}#12`]: "unknown",
      [`${GOLDEN_REPO}#13`]: "unknown",
    });

    // 3b. the checked branch of the refresh route: this workspace holds no
    // installation, so the call cannot land and nothing is learnt. Still unknown,
    // never current. (The render above claims nothing any more — it reaches GitHub on
    // no path at all — so this refresh is the first thing to claim the window.)
    const unknownPrs = [
      { pr: `${GOLDEN_REPO}#12`, freshness: "unknown" },
      { pr: `${GOLDEN_REPO}#13`, freshness: "unknown" },
    ];
    const checked = await readJson(await refresh("unseen", keyBlind));
    expect(checked.checked).toBe(true);
    expect(checked.prs).toEqual(unknownPrs);

    // 3c. and inside the window, where it answers from what is recorded. This is the
    // third home of the old default and the worst of them: this is the repair path,
    // the one route a reader reaches for when they already suspect something is
    // stale, so it is the last place that may say "current" about a pull request
    // nothing has observed.
    const inWindow = await readJson(await refresh("unseen", keyBlind));
    expect(inWindow.checked).toBe(false);
    expect(inWindow.prs).toEqual(unknownPrs);
  });

  test("and with an observation the same three say current", async () => {
    // The guarantee is only tested when the thing it withholds is there to withhold:
    // one row, and all three surfaces change together.
    resetChecks();
    storeGoldenReview(wsBlind, "then-seen");
    for (const [number, head] of [
      [12, GOLDEN_HEAD_SHA_12],
      [13, GOLDEN_HEAD_SHA_13],
    ] as const) {
      expect(upsertPrStatus(wsBlind, INSTALLATION, observation({ prNumber: number, headSha: head }))).toBe(true);
    }

    const html = await pageOf(wsBlind, "then-seen");
    expect(html).toContain('href="#i-pr-open"');
    expect(chip(html)).toBe("heads current");

    const read = await readJson(await fetch(`${base}/api/reviews/then-seen`, {
      headers: { authorization: `Bearer ${keyBlind}` },
    }));
    expect(read.document.freshness).toEqual({
      [`${GOLDEN_REPO}#12`]: "current",
      [`${GOLDEN_REPO}#13`]: "current",
    });

    const answer = await readJson(await refresh("then-seen", keyBlind));
    expect(answer.prs).toEqual([
      { pr: `${GOLDEN_REPO}#12`, freshness: "current" },
      { pr: `${GOLDEN_REPO}#13`, freshness: "current" },
    ]);
  });

  test("a head that moved under an observed review still reads behind", async () => {
    // The middle reading has not gone anywhere: unknown is a third value, not a
    // replacement for behind.
    resetChecks();
    storeGoldenReview(wsBlind, "moved-on");
    upsertPrStatus(
      wsBlind,
      INSTALLATION,
      observation({ prNumber: 12, headSha: "9".repeat(40) }),
    );
    upsertPrStatus(wsBlind, INSTALLATION, observation({ prNumber: 13, headSha: GOLDEN_HEAD_SHA_13 }));
    const html = await pageOf(wsBlind, "moved-on");
    expect(chip(html)).toBe("1 of 2 behind");
  });
});

describe("ordering: the upsert's precondition", () => {
  const ws = "ws_ordering";
  const noon = Date.parse("2026-07-20T12:00:00Z");

  test("an older observation applied after a newer one does not overwrite it", () => {
    expect(
      upsertPrStatus(ws, INSTALLATION, observation({ state: "closed", merged: true, updatedAt: noon })),
    ).toBe(true);
    expect(statusOf(findPrStatus(ws, GOLDEN_REPO, 12)!)).toBe("merged");

    // The race this exists for: a publish that started before the merge, or a retried
    // delivery landing after a newer one succeeded. Either would reopen a merged pull
    // request on the page, and the row would be one place where the fact oscillates.
    const stale = upsertPrStatus(
      ws,
      INSTALLATION,
      observation({ state: "open", headSha: "7".repeat(40), updatedAt: noon - 60_000 }),
    );
    expect(stale).toBe(false);
    const row = findPrStatus(ws, GOLDEN_REPO, 12)!;
    expect(statusOf(row)).toBe("merged");
    expect(row.head_sha).toBe(GOLDEN_HEAD_SHA_12);
    expect(row.updated_at).toBe(noon);
  });

  test("a newer one does overwrite, and a tie is let through", () => {
    // The refusal above is only a guarantee if the write it withholds works.
    expect(
      upsertPrStatus(ws, INSTALLATION, observation({ prNumber: 99, state: "open", updatedAt: noon })),
    ).toBe(true);
    expect(
      upsertPrStatus(
        ws,
        INSTALLATION,
        observation({ prNumber: 99, state: "closed", updatedAt: noon + 1000 }),
      ),
    ).toBe(true);
    expect(statusOf(findPrStatus(ws, GOLDEN_REPO, 99)!)).toBe("closed");

    // Equal timestamps let the write through: GitHub's updated_at has one-second
    // resolution, so a genuine later state is likelier than a duplicate.
    expect(
      upsertPrStatus(
        ws,
        INSTALLATION,
        observation({ prNumber: 99, state: "closed", merged: true, updatedAt: noon + 1000 }),
      ),
    ).toBe(true);
    expect(statusOf(findPrStatus(ws, GOLDEN_REPO, 99)!)).toBe("merged");
  });

  test("a publish that raced a merge does not roll the merge back", async () => {
    resetPulls();
    resetChecks();
    // The merge is already recorded, from a delivery or an earlier observation, and is
    // newer than anything this publish's getPull will report.
    upsertPrStatus(
      wsSeen,
      INSTALLATION,
      observation({
        prNumber: 13,
        headSha: GOLDEN_HEAD_SHA_13,
        state: "closed",
        merged: true,
        updatedAt: Date.parse("2026-08-01T00:00:00Z"),
      }),
    );

    expect((await publish("raced")).status).toBe(200);

    // The publish went through the same conditional upsert everything else does, so
    // its older "open" lost.
    expect(statusOf(findPrStatus(wsSeen, GOLDEN_REPO, 13)!)).toBe("merged");
    const html = await pageOf(wsSeen, "raced");
    expect(html).toContain('aria-label="merged"');
  });
});
