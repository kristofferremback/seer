import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { tinyId } from "../../src/ids";
import { startServer } from "../../src/server";
import { createReviewVersion, getReview, ReviewSlugTaken } from "../../src/overseer/db";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { offlineGithubClientFactory } from "../offline-github";
import { goldenStoredDoc } from "./fixtures/stored-review";
import { getLineage, publishFirstRevision, RevisionWriteError } from "../../src/overseer/revision-db";
import { createStack, getStack, StackWriteError, type NormalizedStack } from "../../src/overseer/stack-db";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let owner = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
});

afterEach(() => setGithubClientFactory(offlineGithubClientFactory()));
afterAll(() => server.stop(true));

function workspace(name: string): { id: string; key: string; keyId: string } {
  const id = createWorkspace(name, owner);
  const minted = mintApiKey(owner, id, name);
  return { id, key: minted.token, keyId: minted.id };
}

function capture(slug: string) {
  return {
    id: tinyId("stg"),
    repo: "Acme/Cutover",
    repoId: 991,
    branch: `feature-${slug}`,
    baseRef: "main",
    sourceHeadSha: "2".repeat(40),
    baseTipSha: "1".repeat(40),
    mergeBaseSha: "1".repeat(40),
  };
}

function normalized(slug: string): NormalizedStack {
  const bottomId = tinyId("rln"), topId = tinyId("rln");
  return {
    repo: "Acme/Cutover",
    repoId: 991,
    baseRef: "main",
    source: "inferred",
    provider: { stackId: null, stackNumber: null, observedAt: null },
    members: [
      { lineageId: bottomId, lineageSlug: `${slug}-bottom`, prNumber: 1, title: "Bottom", revisionId: tinyId("rvr"), revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: `${slug}-bottom`, headSha: "2".repeat(40), status: "live", removedReason: null },
      { lineageId: topId, lineageSlug: `${slug}-top`, prNumber: 2, title: "Top", revisionId: tinyId("rvr"), revision: 1, accountId: null, accountVersion: null, baseRef: `${slug}-bottom`, headRef: `${slug}-top`, headSha: "3".repeat(40), status: "live", removedReason: null },
    ],
  };
}

describe("the default Overseer cutover", () => {
  test("should retire every new ReviewDoc slug before GitHub or storage and expose no mode escape", async () => {
    const ws = workspace("cutover retired writer");
    let githubCalls = 0;
    setGithubClientFactory(() => {
      githubCalls += 1;
      throw new Error("GitHub must not be constructed for a retired slug");
    });
    const before = {
      reviews: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM reviews WHERE workspace_id = ?").get(ws.id)!.n,
      lineages: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_lineages WHERE workspace_id = ?").get(ws.id)!.n,
      attachments: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_attachments WHERE workspace_id = ?").get(ws.id)!.n,
    };
    const response = await fetch(`${base}/api/reviews`, {
      method: "POST",
      headers: { authorization: `Bearer ${ws.key}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "retired-new", prs: [], mode: "legacy" }),
    });
    expect(response.status).toBe(409);
    const retired = await response.json() as any;
    expect(retired).toMatchObject({
      error: "New Overseer reviews use immutable review lineages.",
      rule: "legacy_creation_retired",
    });
    expect(new URL(retired.pullRequestCreateUrl).pathname).toBe("/api/pull-request-review-lineages");
    expect(new URL(retired.captureCreateUrl).pathname).toBe("/api/review-lineages");
    expect(new URL(retired.stackCreateUrl).pathname).toBe("/api/review-stacks");
    expect(githubCalls).toBe(0);
    expect({
      reviews: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM reviews WHERE workspace_id = ?").get(ws.id)!.n,
      lineages: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_lineages WHERE workspace_id = ?").get(ws.id)!.n,
      attachments: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_attachments WHERE workspace_id = ?").get(ws.id)!.n,
    }).toEqual(before);
  });

  test("should refuse the same slug across legacy reviews, promoted lineages, and stacks in every direction", async () => {
    const ws = workspace("cutover collisions");
    const legacyOwnsSlug = (slug: string) => getReview(ws.id, slug) !== null;

    createReviewVersion(ws.id, "legacy-owner", goldenStoredDoc());
    expect(() => publishFirstRevision({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, slug: "legacy-owner", title: "Collision",
      projects: [], capture: capture("legacy-owner"), builder: null, legacyOwnsSlug,
    })).toThrow(RevisionWriteError);
    expect(() => createStack({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, idempotencyKey: "legacy-stack-clash",
      requestHash: "legacy-stack-clash", slug: "legacy-owner", title: "Collision", projects: [],
      actor: { kind: "anonymous" }, normalized: normalized("legacy-stack-clash"), legacyOwnsSlug,
    })).toThrow(StackWriteError);

    publishFirstRevision({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, slug: "promoted-owner", title: "Promoted",
      projects: [], capture: capture("promoted-owner"), builder: null, legacyOwnsSlug,
    });
    expect(() => createReviewVersion(ws.id, "promoted-owner", goldenStoredDoc())).toThrow(ReviewSlugTaken);
    expect(() => createStack({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, idempotencyKey: "promoted-stack-clash",
      requestHash: "promoted-stack-clash", slug: "promoted-owner", title: "Collision", projects: [],
      actor: { kind: "anonymous" }, normalized: normalized("promoted-stack-clash"), legacyOwnsSlug,
    })).toThrow(StackWriteError);

    createStack({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, idempotencyKey: "stack-owner",
      requestHash: "stack-owner", slug: "stack-owner", title: "Stack", projects: [],
      actor: { kind: "anonymous" }, normalized: normalized("stack-owner"), legacyOwnsSlug,
    });
    expect(() => createReviewVersion(ws.id, "stack-owner", goldenStoredDoc())).toThrow(ReviewSlugTaken);
    expect(() => publishFirstRevision({
      workspaceId: ws.id, userId: owner, keyId: ws.keyId, slug: "stack-owner", title: "Collision",
      projects: [], capture: capture("stack-owner"), builder: null, legacyOwnsSlug,
    })).toThrow(RevisionWriteError);
    expect(getStack(ws.id, "stack-owner")).not.toBeNull();
    expect(getReview(ws.id, "stack-owner")).toBeNull();
    expect(getLineage(ws.id, "stack-owner")).toBeNull();

    const legacyPromotedResponse = await fetch(`${base}/api/pull-request-review-lineages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ws.key}`,
        "content-type": "application/json",
        "idempotency-key": "promoted-collision-legacy-owner",
      },
      body: JSON.stringify({ repo: "acme/cutover", number: 1, slug: "legacy-owner" }),
    });
    expect(legacyPromotedResponse.status).toBe(409);
    expect(await legacyPromotedResponse.json()).toMatchObject({ rule: "review_slug_taken" });

    for (const slug of ["legacy-owner", "promoted-owner", "stack-owner"]) {
      const stackResponse = await fetch(`${base}/api/review-stacks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ws.key}`,
          "content-type": "application/json",
          "idempotency-key": `stack-collision-${slug}`,
        },
        body: JSON.stringify({ slug, members: ["missing-bottom", "missing-top"] }),
      });
      expect(stackResponse.status).toBe(409);
      expect(await stackResponse.json()).toMatchObject({ rule: "review_slug_taken" });
    }

    for (const [slug, ownerKind] of [["promoted-owner", "promoted review"], ["stack-owner", "review stack"]] as const) {
      const legacyResponse = await fetch(`${base}/api/reviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${ws.key}`, "content-type": "application/json" },
        body: JSON.stringify({ slug, prs: [] }),
      });
      expect(legacyResponse.status).toBe(409);
      expect(await legacyResponse.json()).toMatchObject({
        error: expect.stringContaining(ownerKind),
        rule: "review_slug_taken",
      });

      const promotedResponse = await fetch(`${base}/api/pull-request-review-lineages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ws.key}`,
          "content-type": "application/json",
          "idempotency-key": `promoted-collision-${slug}`,
        },
        body: JSON.stringify({ repo: "acme/cutover", number: 1, slug }),
      });
      expect(promotedResponse.status).toBe(409);
      expect(await promotedResponse.json()).toMatchObject({ rule: "review_slug_taken" });
    }
  });

  test("should leave the hosted Stage V1 documents byte-for-byte at the parent contract", async () => {
    const digest = async (path: string) => createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex");
    expect(await digest(`${import.meta.dir}/../../docs/stage/agent.md`)).toBe("382c83644f7891b564769909659113f4342bc9cfa5c69512299fe1a0dc5f8232");
    expect(await digest(`${import.meta.dir}/../../docs/stage/skill.md`)).toBe("dd74efe10cd3464e69a1db77892515f55780204e35d848580a0343ff7094992b");
    expect((await fetch(`${base}/stage/agent.md`)).status).toBe(200);
    expect((await fetch(`${base}/stage/skill.md`)).status).toBe(200);
  });

  test("should preserve auth, privacy, and capability boundaries with AUTH_DISABLED removed", async () => {
    const process = Bun.spawn(["bun", "run", `${import.meta.dir}/legacy-successor-privacy.script.ts`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnvWithoutTestAuth() },
    });
    const code = await process.exited;
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("legacy-successor-privacy: all assertions passed");
  });
});

function processEnvWithoutTestAuth(): Record<string, string | undefined> {
  return {
    ...process.env,
    AUTH_DISABLED: undefined,
    API_KEY: undefined,
    API_TOKEN: undefined,
    ALLOWED_EMAILS: undefined,
  };
}
