// The read path: GET /api/reviews/:slug and its /v/:n sibling, over a real server.
//
// The documents are seeded straight into the store (see fixtures/stored-review.ts),
// because what is under test here is who may read a review and which one a bare slug
// names, not publication. Signed-out and non-member reads need forged cookies, which
// AUTH_DISABLED makes impossible in this process; they live in read-privacy.script.ts.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { join } from "node:path";

import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { createAnnotation, setFreshness } from "../../src/overseer/db";
import { tinyId } from "../../src/ids";
import { GOLDEN_REPO, GOLDEN_HEAD_SHA_12, goldenPayload } from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let wsA = "";
let wsB = "";
let keyA = "";
let keyB = "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Status, content type and body together: the privacy gate's claim is that two
 *  refusals are indistinguishable, and a body alone would not show that. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsA = createWorkspace("Read A", owner);
  keyA = mintApiKey(owner, wsA, "a").token;

  // A workspace the session user is not in, so the key path can be tested on its own:
  // AUTH_DISABLED resolves every request to the root user, and a workspace they belong
  // to would let the session answer for the key.
  const stranger = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
    stranger,
    "stranger@example.com",
    Date.now(),
  ]);
  wsB = createWorkspace("Read B", stranger);
  keyB = mintApiKey(stranger, wsB, "b").token;

  storeGoldenReview(wsA, "golden");
  storeGoldenReview(wsB, "theirs");
});

afterAll(() => {
  server.stop(true);
});

// ---- reading ----

describe("GET /api/reviews/:slug", () => {
  test("a member session reads the golden review", async () => {
    const res = await get("/api/reviews/golden");
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.slug).toBe("golden");
    expect(json.workspace).toBe(wsA);
    expect(json.version).toBe(1);
    expect(json.latestVersion).toBe(1);
    expect(json.isLatest).toBe(true);
    expect(json.url).toBe(`${config.baseUrl}/${wsA}/r/golden`);
    expect(json.versionUrl).toBe(`${config.baseUrl}/${wsA}/r/golden/v/1`);

    const doc = json.document;
    expect(doc.id).toMatch(/^rev_/);
    expect(doc.slug).toBe("golden");
    expect(doc.version).toBe(1);
    expect(doc.title).toBe(goldenPayload().title);
    expect(doc.prs.map((p: { number: number }) => p.number)).toEqual([12, 13]);
    expect(doc.statements[0]!.refs[0]!.snippet).toContain("resolved snippet");
    expect(doc.groups[0]!.hunks.length).toBe(doc.hunks.length);
  });

  test("the document carries its annotations and its freshness", async () => {
    const before = await readJson(await get("/api/reviews/golden"));
    // Nothing has been checked against GitHub, so the stored document is the last
    // thing known true and every pull request reads current.
    expect(before.document.freshness).toEqual({
      [`${GOLDEN_REPO}#12`]: "current",
      [`${GOLDEN_REPO}#13`]: "current",
    });
    expect(before.document.annotations).toEqual([]);

    createAnnotation(wsA, "golden", { type: "statement", id: "st_gate" }, "Why here?", 1);
    // A head that has moved since publication, and one that has not.
    setFreshness(wsA, "golden", GOLDEN_REPO, 12, "9".repeat(40));
    setFreshness(wsA, "golden", GOLDEN_REPO, 13, GOLDEN_HEAD_SHA_12);

    const after = await readJson(await get("/api/reviews/golden"));
    expect(after.document.freshness[`${GOLDEN_REPO}#12`]).toBe("behind");
    // 13's stored head is a different sha, so an observation equal to 12's head is
    // still a move: freshness compares against the pull request's own head.
    expect(after.document.freshness[`${GOLDEN_REPO}#13`]).toBe("behind");
    setFreshness(wsA, "golden", GOLDEN_REPO, 13, after.document.prs[1]!.headSha);
    const settled = await readJson(await get("/api/reviews/golden"));
    expect(settled.document.freshness[`${GOLDEN_REPO}#13`]).toBe("current");

    expect(after.document.annotations.length).toBe(1);
    const ann = after.document.annotations[0]!;
    expect(ann.target).toEqual({ type: "statement", id: "st_gate" });
    expect(ann.body).toBe("Why here?");
    expect(ann.status).toBe("open");
    expect(ann.version).toBe(1);
  });

  test("after a republish the bare slug is version 2 and /v/1 is the prior one", async () => {
    expect(storeGoldenReview(wsA, "golden")).toBe(2);
    const latest = await readJson(await get("/api/reviews/golden"));
    expect(latest.version).toBe(2);
    expect(latest.document.version).toBe(2);
    expect(latest.isLatest).toBe(true);

    const prior = await readJson(await get("/api/reviews/golden/v/1"));
    expect(prior.version).toBe(1);
    expect(prior.latestVersion).toBe(2);
    expect(prior.isLatest).toBe(false);
    expect(prior.document.version).toBe(1);
    expect(prior.document.id).toBe(latest.document.id);
    expect(prior.versionUrl).toBe(`${config.baseUrl}/${wsA}/r/golden/v/1`);
    // Annotations belong to the review, not to the version, so a question asked
    // against version 1 is still on the page at version 2.
    expect(latest.document.annotations.length).toBe(1);

    expect((await readJson(await get("/api/reviews/golden/v/2"))).version).toBe(2);
  });

  test("a slug in two of the caller's workspaces resolves to the newest publish", async () => {
    const wsC = createWorkspace("Read C", listMembers(legacyWorkspaceId()!)[0]!.id);
    // Two publishes land in the same millisecond often enough that the clock cannot
    // order them, so the test writes the times it is asserting about.
    const publishedAt = (ws: string, version: number, at: number) =>
      db.run("UPDATE review_versions SET created_at = ? WHERE workspace_id = ? AND slug = ? AND version = ?", [
        at,
        ws,
        "shared-slug",
        version,
      ]);
    const t0 = Date.now();
    storeGoldenReview(wsA, "shared-slug");
    publishedAt(wsA, 1, t0);
    storeGoldenReview(wsC, "shared-slug");
    publishedAt(wsC, 1, t0 + 1000);
    const first = await readJson(await get("/api/reviews/shared-slug"));
    expect(first.workspace).toBe(wsC);
    // Publishing again in the older workspace moves the slug back to it.
    storeGoldenReview(wsA, "shared-slug");
    publishedAt(wsA, 2, t0 + 2000);
    const second = await readJson(await get("/api/reviews/shared-slug"));
    expect(second.workspace).toBe(wsA);
    expect(second.version).toBe(2);
  });
});

// ---- the gate ----

describe("the read gate", () => {
  test("the owning workspace's api key reads, and a foreign key does not", async () => {
    // wsB is a workspace the session user is not a member of, so only the key can
    // reach it and the session cannot mask a failure here.
    const owning = await get("/api/reviews/theirs", bearer(keyB));
    expect(owning.status).toBe(200);
    expect((await readJson(owning)).workspace).toBe(wsB);

    const foreign = await get("/api/reviews/theirs", bearer(keyA));
    expect(await shape(foreign)).toBe(await shape(await get("/api/reviews/no-such-review")));
  });

  test("an unusable key is refused exactly like a miss", async () => {
    const bad = await get("/api/reviews/theirs", bearer("seer_sk_not-a-real-key"));
    expect(await shape(bad)).toBe(await shape(await get("/api/reviews/no-such-review")));
  });

  test("a version out of range is byte-identical to an unknown slug", async () => {
    const unknown = await shape(await get("/api/reviews/no-such-review"));
    for (const path of [
      "/api/reviews/golden/v/99",
      "/api/reviews/golden/v/0",
      "/api/reviews/golden/v/abc",
      "/api/reviews/golden/v/-1",
      "/api/reviews/golden/v/1.5",
      "/api/reviews/NotASlug",
      "/api/reviews/no-such-review/v/1",
    ]) {
      expect(await shape(await get(path))).toBe(unknown);
    }
  });

  test("the soft 404 says nothing about the review and is not cached", async () => {
    const res = await get("/api/reviews/theirs", bearer(keyA));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("theirs");
  });
});

// ---- signed out and non-member (own process) ----

describe("cross-user reads", () => {
  test("read-privacy.script.ts passes with AUTH_DISABLED unset", async () => {
    const script = join(import.meta.dir, "read-privacy.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      console.error("subprocess stdout:", stdout);
      console.error("subprocess stderr:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("all assertions passed");
  }, 30_000);
});
