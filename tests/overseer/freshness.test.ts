// Freshness: looking at a review is what checks it.
//
// The claims here are about timing and about who may listen. A render answers from
// the stored document and never waits for GitHub, the check behind it happens at most
// once a minute per review however many people are reading, a head that moved shows up
// on the next render with no refresh call at all, and the live channel a review pushes
// on is members only even when the workspace is public.

import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import {
  findPrStatus,
  listReviewPrs,
  lookupPrStatus,
  setReviewPrs,
} from "../../src/overseer/installations";
import { GithubError, type GithubClient, type GithubPull } from "../../src/overseer/github";
import { GithubCredentialDeadError, setGithubClientFactory } from "../../src/overseer/github-app";
import {
  CHECK_INTERVAL_MS,
  claimCheck,
  resetChecks,
  setFreshnessPublisher,
} from "../../src/overseer/freshness";
import { offlineGithubClientFactory } from "../offline-github";
import { tinyId } from "../../src/ids";
import { GOLDEN_HEAD_SHA_12, GOLDEN_HEAD_SHA_13, GOLDEN_REPO } from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let wsA = "";
let wsB = "";
let keyA = "";

/** The installation every fake client here says it routed through. */
const TEST_INSTALLATION = 5150;

/** A client that answers `getPull` with whatever head this test wants, and counts. */
function countingClient(head: (repo: string, number: number) => string): {
  client: GithubClient;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    // The observation has to be attributable or it is not written: the status row's
    // installation_id is how `installation.deleted` finds its own rows.
    async installationFor(): Promise<number> {
      return TEST_INSTALLATION;
    },
    async getPull(repo: string, number: number): Promise<GithubPull> {
      calls++;
      return {
        number,
        title: "A pull request",
        body: null,
        state: "open",
        user: { login: "someone" },
        head: { sha: head(repo, number), ref: "topic" },
        base: { sha: "1".repeat(40), ref: "main", repo: { id: 1301620029, full_name: repo } },
        updated_at: "2026-07-19T06:27:55Z",
      };
    },
  } as unknown as GithubClient;
  return { client, calls: () => calls };
}

/** A client that never answers. A render that waits on this one never returns. */
function hangingClient(): GithubClient {
  return {
    async getPull() {
      return new Promise<GithubPull>(() => {});
    },
  } as unknown as GithubClient;
}

/** Detached work has no handle to await, so this gives it the event loop for a while.
 *  Every fake here resolves immediately, so a few turns is generous. */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 5));
}

async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsA = createWorkspace("Fresh A", owner);
  keyA = mintApiKey(owner, wsA, "fresh").token;

  const stranger = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
    stranger,
    "fresh-stranger@example.com",
    Date.now(),
  ]);
  wsB = createWorkspace("Fresh B", stranger);
});

afterAll(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  // The publisher is a module-level singleton, and this server is about to stop.
  setFreshnessPublisher(null);
  server.stop(true);
});

beforeEach(() => {
  resetChecks();
});

describe("the rate limit", () => {
  test("a claim inside the window is refused and one after it is granted", () => {
    const t0 = 1_000_000;
    expect(claimCheck("ws_rate", "review", t0)).toBe(true);
    expect(claimCheck("ws_rate", "review", t0 + 1)).toBe(false);
    expect(claimCheck("ws_rate", "review", t0 + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(claimCheck("ws_rate", "review", t0 + CHECK_INTERVAL_MS)).toBe(true);
    // The granted claim moves the window along with it.
    expect(claimCheck("ws_rate", "review", t0 + CHECK_INTERVAL_MS + 1)).toBe(false);
  });

  test("a render costs no GitHub call at all", async () => {
    storeGoldenReview(wsA, "rate");
    const fake = countingClient((_repo, n) => (n === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13));
    setGithubClientFactory(() => fake.client);

    // The automatic on-view check is deleted rather than merely rate-limited, so this
    // is not "one call per minute" — it is no calls, ever, however many renders and
    // however long between them. A counting client is the only way to say that: a
    // window that happened to be closed would look the same.
    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    resetChecks();
    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    await settle();
    expect(fake.calls()).toBe(0);

    // And the refresh route, the one path that may reach GitHub, still does: the
    // guarantee above is about renders, not about the client being inert.
    const res = await fetch(`${base}/api/reviews/rate/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(200);
    expect(fake.calls()).toBe(2);
  });
});

describe("a head that moved", () => {
  test("the next render says behind and reaches GitHub not once", async () => {
    storeGoldenReview(wsA, "moved");
    const moved = "9".repeat(40);
    const fake = countingClient((_repo, n) => (n === 12 ? moved : GOLDEN_HEAD_SHA_13));
    setGithubClientFactory(() => fake.client);

    // Nothing has observed these pull requests and a render will not, so the page says
    // unchecked rather than asserting current.
    const first = await fetch(`${base}/${wsA}/r/moved`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("heads unchecked");
    await settle();
    expect(fake.calls()).toBe(0);

    // The repair is human-triggered, and it is what records the moved head.
    expect(
      (
        await fetch(`${base}/api/reviews/moved/refresh`, {
          method: "POST",
          headers: { authorization: `Bearer ${keyA}` },
        })
      ).status,
    ).toBe(200);

    const row = findPrStatus(wsA, GOLDEN_REPO, 12);
    expect(row?.head_sha).toBe(moved);
    expect(row?.installation_id).toBe(TEST_INSTALLATION);

    // The next render reads the stored rows and spends nothing doing it.
    const before = fake.calls();
    const second = await fetch(`${base}/${wsA}/r/moved`);
    expect(await second.text()).toContain("1 of 2 behind");
    await settle();
    expect(fake.calls()).toBe(before);
  });
});

describe("POST /api/reviews/:slug/refresh", () => {
  // This route had no origin guard while every other browser-reachable POST in the table
  // had one, and then a refresh button was put on the review page pointing at it — so any
  // page a signed-in member visited could spend their GitHub calls for them. The
  // once-a-minute window bounds the damage rather than making it harmless.
  test("a cross-site post is refused, and the two legitimate callers are not", async () => {
    storeGoldenReview(wsA, "origin-guard");
    const counter = countingClient(() => GOLDEN_HEAD_SHA_12);
    setGithubClientFactory(() => counter.client);

    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/reviews/origin-guard/refresh`, { method: "POST", headers });

    // A browser on somebody else's page sends its own Origin.
    const cross = await post({ origin: "https://evil.example", authorization: `Bearer ${keyA}` });
    expect(cross.status).toBe(403);
    expect(counter.calls()).toBe(0);

    // The page's own button sends the configured origin. Not `base` — under tests the
    // server binds port 0 while config.baseUrl keeps its fixed string, and originOk
    // compares against the configured host, which is the one a real browser would send.
    resetChecks();
    expect((await post({ origin: config.baseUrl, authorization: `Bearer ${keyA}` })).status).toBe(
      200,
    );
    const afterSameOrigin = counter.calls();
    expect(afterSameOrigin).toBeGreaterThan(0);

    // ...and an API key posts with no Origin at all, which must keep working, because
    // originOk passing on absent headers is what lets a non-browser caller through.
    resetChecks();
    expect((await post({ authorization: `Bearer ${keyA}` })).status).toBe(200);
    expect(counter.calls()).toBeGreaterThan(afterSameOrigin);
  });

  test("it answers per pull request", async () => {
    storeGoldenReview(wsA, "explicit");
    const moved = "8".repeat(40);
    setGithubClientFactory(() => countingClient((_repo, n) => (n === 12 ? GOLDEN_HEAD_SHA_12 : moved)).client);

    const res = await fetch(`${base}/api/reviews/explicit/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      workspace: string;
      prs: { pr: string; freshness: string }[];
    };
    expect(body.slug).toBe("explicit");
    expect(body.workspace).toBe(wsA);
    expect(body.prs).toEqual([
      { pr: `${GOLDEN_REPO}#12`, freshness: "current" },
      { pr: `${GOLDEN_REPO}#13`, freshness: "behind" },
    ]);
  });

  // The regression: this route called claimCheck and discarded the answer, so the
  // one-check-per-minute bound the whole module is built around held for rendering and
  // for nothing else. A caller posting in a loop spent one GitHub call per pull request
  // per request, without limit.
  test("a second refresh inside the window costs nothing and says so", async () => {
    storeGoldenReview(wsA, "bounded");
    const moved = "9".repeat(40);
    const counter = countingClient((_repo, n) => (n === 12 ? GOLDEN_HEAD_SHA_12 : moved));
    setGithubClientFactory(() => counter.client);

    const refresh = () =>
      fetch(`${base}/api/reviews/bounded/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${keyA}` },
      });

    const first = (await (await refresh()).json()) as {
      checked: boolean;
      prs: { pr: string; freshness: string }[];
    };
    expect(first.checked).toBe(true);
    const spent = counter.calls();
    expect(spent).toBe(2); // one getPull per pull request

    // Five more inside the same minute reach GitHub not once...
    for (let i = 0; i < 5; i++) {
      const again = (await (await refresh()).json()) as {
        checked: boolean;
        prs: { pr: string; freshness: string }[];
      };
      expect(again.checked).toBe(false);
      // ...and the caller is still answered, from the observation already recorded,
      // with the same readings the checked call returned. A refusal that answered
      // nothing, or answered something different, would just move the problem.
      expect(again.prs).toEqual(first.prs);
    }
    expect(counter.calls()).toBe(spent);

    // And the bound is a window, not a latch: once it lapses, a refresh checks again.
    resetChecks();
    const after = (await (await refresh()).json()) as { checked: boolean };
    expect(after.checked).toBe(true);
    expect(counter.calls()).toBe(spent * 2);
  });

  test("a review the caller may not read is the answer a missing one gets", async () => {
    storeGoldenReview(wsB, "sealed");
    setGithubClientFactory(() => countingClient(() => GOLDEN_HEAD_SHA_12).client);

    const post = (slug: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/reviews/${slug}/refresh`, { method: "POST", headers });

    const missing = await shape(await post("nowhere"));
    expect(missing.startsWith("404\napplication/json")).toBe(true);
    // Someone else's workspace, a malformed slug, and a bad key all land here.
    expect(await shape(await post("sealed"))).toBe(missing);
    expect(await shape(await post("NOT_A_SLUG"))).toBe(missing);
    expect(await shape(await post("sealed", { authorization: "Bearer not-a-key" }))).toBe(missing);
  });
});

describe("the live channel", () => {
  /** "open" when the server upgraded this request, "refused" when it did not. The
   *  socket is closed after the answer is settled: Bun dispatches close synchronously
   *  out of close(), and closing first would race the answer with itself. */
  async function upgrade(wsId: string, slug: string, kind: string): Promise<string> {
    const url = `ws://localhost:${server.port}/ws/livereload?kind=${kind}&ws=${wsId}&slug=${slug}`;
    const socket = new WebSocket(url);
    const answer = await new Promise<string>((resolve) => {
      socket.onopen = () => resolve("open");
      socket.onerror = () => resolve("refused");
      socket.onclose = () => resolve("refused");
    });
    socket.close();
    return answer;
  }

  test("a moved head reaches the page that is open on the review", async () => {
    storeGoldenReview(wsA, "pushed");
    setGithubClientFactory(() => countingClient((_repo, n) => (n === 12 ? "7".repeat(40) : GOLDEN_HEAD_SHA_13)).client);

    const url = `ws://localhost:${server.port}/ws/livereload?kind=review&ws=${wsA}&slug=pushed`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const message = new Promise<string>((resolve) => {
      socket.onmessage = (e) => resolve(String(e.data));
    });

    const res = await fetch(`${base}/api/reviews/pushed/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(200);
    // One message carrying the whole observation: the per-pull-request readings the
    // glyphs are drawn from and the counts the chip is written from, so the two cannot
    // arrive out of order and disagree on the same screen.
    expect(JSON.parse(await message)).toEqual({
      type: "review",
      prs: [
        { pr: `${GOLDEN_REPO}#12`, status: "open", freshness: "behind" },
        { pr: `${GOLDEN_REPO}#13`, status: "open", freshness: "current" },
      ],
      behind: 1,
      unknown: 0,
      total: 2,
    });
    socket.close();
  });

  test("a push says what changed, in either direction, and repeats nothing", async () => {
    storeGoldenReview(wsA, "swings");
    // An observation is of a pull request, not of a review: every review in this file
    // names the same two pull requests, so this one inherits whatever the last test
    // observed about them and would start already behind. Cleared so the swing below
    // is this test's own.
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    let head12 = "6".repeat(40);
    setGithubClientFactory(() => countingClient((_repo, n) => (n === 12 ? head12 : GOLDEN_HEAD_SHA_13)).client);

    const url = `ws://localhost:${server.port}/ws/livereload?kind=review&ws=${wsA}&slug=swings`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const heard: string[] = [];
    socket.onmessage = (e) => heard.push(String(e.data));

    const refresh = async () => {
      resetChecks();
      const res = await fetch(`${base}/api/reviews/swings/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${keyA}` },
      });
      expect(res.status).toBe(200);
      await settle(4);
    };

    await refresh();
    // The second check sees the same moved head: the page already knows.
    await refresh();
    // The branch is reset to what the review was published against.
    head12 = GOLDEN_HEAD_SHA_12;
    await refresh();
    socket.close();

    expect(heard.map((m) => JSON.parse(m) as { type: string; behind: number; unknown: number; total: number }).map(
      (m) => [m.type, m.behind, m.unknown, m.total],
    )).toEqual([
      ["review", 1, 0, 2],
      ["review", 0, 0, 2],
    ]);
  });

  test("a member subscribes and a non-member is refused", async () => {
    expect(await upgrade(wsA, "rate", "review")).toBe("open");
    // The session user is not a member of wsB, so its review channel is not theirs,
    // and the socket is refused before it can hear anything about that review.
    expect(await upgrade(wsB, "sealed", "review")).toBe("refused");
    // The bundle channel is unchanged by any of this.
    expect(await upgrade(wsA, "rate", "bundle")).toBe("open");
  });
});

describe("the repair heals what it observed", () => {
  /** A client answering as a repository that has since been renamed: the numeric id is
   *  the only thing that still joins its answer to the document's frozen name. */
  function renamedClient(newName: string, repoId: number, head: (n: number) => string): GithubClient {
    return {
      async installationFor(): Promise<number> {
        return TEST_INSTALLATION;
      },
      async getPull(_repo: string, number: number): Promise<GithubPull> {
        return {
          number,
          title: "A pull request",
          body: null,
          state: "open",
          user: { login: "someone" },
          head: { sha: head(number), ref: "topic" },
          base: { sha: "1".repeat(40), ref: "main", repo: { id: repoId, full_name: newName } },
          updated_at: "2026-07-19T06:27:55Z",
        };
      },
    } as unknown as GithubClient;
  }

  test("a refresh fills in the numeric id a backfilled row never had", async () => {
    storeGoldenReview(wsA, "backfilled");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    // What the backfill leaves: the pull requests named, and nothing numeric.
    setReviewPrs(wsA, "backfilled", [
      { repo: GOLDEN_REPO, number: 12 },
      { repo: GOLDEN_REPO, number: 13 },
    ]);
    const repoId = 42_000_042;
    setGithubClientFactory(() =>
      renamedClient("golden/renamed-since", repoId, (n) =>
        n === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13,
      ),
    );

    expect(
      (
        await fetch(`${base}/api/reviews/backfilled/refresh`, {
          method: "POST",
          headers: { authorization: `Bearer ${keyA}` },
        })
      ).status,
    ).toBe(200);

    // The status row is filed under the current name, so the document's name reaches it
    // only through the id the repair wrote back.
    expect(listReviewPrs(wsA, "backfilled").map((r) => [r.repo, r.repo_id])).toEqual([
      [GOLDEN_REPO, repoId],
      [GOLDEN_REPO, repoId],
    ]);
    expect(lookupPrStatus(wsA, GOLDEN_REPO, 12)?.head_sha).toBe(GOLDEN_HEAD_SHA_12);
    expect(lookupPrStatus(wsA, GOLDEN_REPO, 13)?.head_sha).toBe(GOLDEN_HEAD_SHA_13);
  });

  test("a refresh through the anonymous fallback still records what it saw", async () => {
    storeGoldenReview(wsA, "anon-observed");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    // Only this review may name the pull requests: the heal test above left rows for
    // the same named pull requests under a different fabricated numeric id, and the
    // name-to-id bridge answers for the workspace, not the slug.
    db.run("DELETE FROM review_prs WHERE workspace_id = ? AND slug != ?", [wsA, "anon-observed"]);
    const counting = countingClient((_repo, n) => (n === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13));
    // A routing client answering "nobody's": the reads above it succeeded anonymously.
    // "Nobody's" is not "don't know" — a repair that observed the truth and recorded
    // nothing would leave the page saying "unchecked" after every successful press.
    setGithubClientFactory(
      () => ({ ...counting.client, installationFor: async () => null }) as GithubClient,
    );

    const res = await fetch(`${base}/api/reviews/anon-observed/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checked: boolean }).checked).toBe(true);

    // Stamped with the observer no installation ever is, so `installation.deleted` can
    // never sweep a row no installation produced.
    const row = lookupPrStatus(wsA, GOLDEN_REPO, 12);
    expect(row?.head_sha).toBe(GOLDEN_HEAD_SHA_12);
    expect(row?.installation_id).toBe(0);
  });
});

describe("a refresh publishes to every review it rewrote", () => {
  test("the sibling naming the same pull request hears the moved head", async () => {
    storeGoldenReview(wsA, "pressed");
    storeGoldenReview(wsA, "sibling");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const repoId = 1301620029;
    for (const slug of ["pressed", "sibling"]) {
      setReviewPrs(wsA, slug, [
        { repo: GOLDEN_REPO, number: 12, repoId },
        { repo: GOLDEN_REPO, number: 13, repoId },
      ]);
    }
    setGithubClientFactory(
      () => countingClient((_repo, n) => (n === 12 ? "5".repeat(40) : GOLDEN_HEAD_SHA_13)).client,
    );

    const url = `ws://localhost:${server.port}/ws/livereload?kind=review&ws=${wsA}&slug=sibling`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const message = new Promise<string>((resolve) => {
      socket.onmessage = (e) => resolve(String(e.data));
    });

    // The button on the other page. The row it rewrites is the workspace's, and this
    // review renders from it too.
    expect(
      (
        await fetch(`${base}/api/reviews/pressed/refresh`, {
          method: "POST",
          headers: { authorization: `Bearer ${keyA}` },
        })
      ).status,
    ).toBe(200);

    expect(JSON.parse(await message)).toEqual({
      type: "review",
      prs: [
        { pr: `${GOLDEN_REPO}#12`, status: "open", freshness: "behind" },
        { pr: `${GOLDEN_REPO}#13`, status: "open", freshness: "current" },
      ],
      behind: 1,
      unknown: 0,
      total: 2,
    });
    socket.close();
  });
});

describe("the render is never blocked", () => {
  test("a client that never answers costs the reader nothing", async () => {
    storeGoldenReview(wsA, "hangs");
    setGithubClientFactory(() => hangingClient());

    const started = Date.now();
    const res = await fetch(`${base}/${wsA}/r/hangs`);
    expect(res.status).toBe(200);
    // Nothing has observed this review and nothing ever will through this client, so
    // the chip says so rather than claiming the heads are current.
    expect(await res.text()).toContain("heads unchecked");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a credential that died", () => {
  // The refresh button is the one path a person can press when they suspect the page is
  // stale, and the per-pull-request catch below it swallowed everything. A dead
  // credential therefore answered 200 with the rows it failed to update: the reader
  // pressed the repair, watched it succeed, and learned nothing.
  test("the refresh says 422 and names the credential", async () => {
    storeGoldenReview(wsA, "dead-credential");
    setGithubClientFactory(
      () =>
        ({
          async getPull(): Promise<GithubPull> {
            throw new GithubCredentialDeadError(
              "guc_dead",
              'Your GitHub credential for alice ("work") was revoked at GitHub, so GitHub refused it. ' +
                "Reconnect the account in settings.",
            );
          },
        }) as unknown as GithubClient,
    );

    const res = await fetch(`${base}/api/reviews/dead-credential/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(await res.text()).error).toContain('alice ("work")');
  });

  test("an unreachable GitHub still answers with the last observation", async () => {
    // The other half of the split, pinned: only the credential's death climbs out of the
    // per-pull-request catch. A transport fault is not the reader's to fix.
    storeGoldenReview(wsA, "transport-fault");
    setGithubClientFactory(
      () =>
        ({
          async getPull(): Promise<GithubPull> {
            throw new GithubError("GitHub 502", 502, "https://api.github.test/x");
          },
        }) as unknown as GithubClient,
    );

    const before = findPrStatus(wsA, GOLDEN_REPO, 12)?.head_sha ?? null;
    const res = await fetch(`${base}/api/reviews/transport-fault/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).checked).toBe(true);
    // Nothing was observed, so nothing was written over.
    expect(findPrStatus(wsA, GOLDEN_REPO, 12)?.head_sha ?? null).toBe(before);
  });
});
