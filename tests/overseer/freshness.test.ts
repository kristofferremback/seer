// Freshness: looking at a review is what checks it.
//
// The claims here are about timing and about who may listen. A render answers from
// the stored document and never waits for GitHub, the check behind it happens at most
// once a minute per review however many people are reading, a head that moved shows up
// on the next render with no refresh call at all, and the live channel a review pushes
// on is members only even when the workspace is public.

import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { findPrStatus } from "../../src/overseer/installations";
import type { GithubClient, GithubPull } from "../../src/overseer/github";
import { setGithubClientFactory } from "../../src/overseer/github-app";
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

  test("two renders inside the window cost one check and a later one costs another", async () => {
    storeGoldenReview(wsA, "rate");
    const fake = countingClient((_repo, n) => (n === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13));
    setGithubClientFactory(() => fake.client);

    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    await settle();
    // Two pull requests, checked once: the second render found the window closed.
    expect(fake.calls()).toBe(2);

    // The window elapses.
    resetChecks();
    expect((await fetch(`${base}/${wsA}/r/rate`)).status).toBe(200);
    await settle();
    expect(fake.calls()).toBe(4);
  });
});

describe("a head that moved", () => {
  test("the next render says behind with no refresh call of its own", async () => {
    storeGoldenReview(wsA, "moved");
    const moved = "9".repeat(40);
    const fake = countingClient((_repo, n) => (n === 12 ? moved : GOLDEN_HEAD_SHA_13));
    setGithubClientFactory(() => fake.client);

    const first = await fetch(`${base}/${wsA}/r/moved`);
    expect(first.status).toBe(200);
    // The page that triggered the check was rendered before it landed, and nothing had
    // observed these pull requests, so it says unchecked rather than asserting current.
    expect(await first.text()).toContain("heads unchecked");
    await settle();

    const row = findPrStatus(wsA, GOLDEN_REPO, 12);
    expect(row?.head_sha).toBe(moved);
    expect(row?.installation_id).toBe(TEST_INSTALLATION);

    // The next render reads the stored rows. Nothing is refreshed for it: the window
    // is still closed, and the client would count the call if it were.
    const before = fake.calls();
    const second = await fetch(`${base}/${wsA}/r/moved`);
    expect(await second.text()).toContain("1 of 2 behind");
    await settle();
    expect(fake.calls()).toBe(before);
  });
});

describe("POST /api/reviews/:slug/refresh", () => {
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
    expect(JSON.parse(await message)).toEqual({
      type: "freshness",
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

    expect(heard.map((m) => JSON.parse(m))).toEqual([
      { type: "freshness", behind: 1, unknown: 0, total: 2 },
      { type: "freshness", behind: 0, unknown: 0, total: 2 },
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
