// The reviews index: the page a published review is otherwise unreachable without,
// and the one page in the codebase whose whole claim is that it asks GitHub nothing.
//
// Both halves are asserted together on purpose. "Made zero GitHub calls" passes against
// a page that renders nothing at all, so every zero-call assertion here sits beside the
// tallies the same response had to have rendered to be worth counting.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { db, legacyWorkspaceId } from "../../src/db";
import { createReviewVersion, type ReviewDoc } from "../../src/overseer/db";
import {
  reviewStatusTally,
  setReviewPrs,
  upsertPrStatus,
  type PrObservation,
} from "../../src/overseer/installations";
import { setGithubClientFactory, type GithubClientFactory } from "../../src/overseer/github-app";
import { offlineGithubClient, offlineGithubClientFactory } from "../offline-github";
import { digestOf } from "../../src/overseer/revision-db";
import { tinyId } from "../../src/ids";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let wsId: string;

/** Not the workspace the session user is in. Its reviews must never appear. */
const WS_OTHER = "ws_zzzzzzzzzz";
const INSTALL = 909090;

/** Every construction and every call counted. The offline client underneath still
 *  refuses, so a page that reached GitHub would fail loudly as well as be counted. */
let githubCalls = 0;
const countingFactory: GithubClientFactory = () => {
  githubCalls++;
  const client = offlineGithubClient();
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        githubCalls++;
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
};

function doc(title: string, prs: { repo: string; number: number }[]): Omit<ReviewDoc, "id" | "slug" | "version"> {
  return {
    title,
    kind: prs.length > 1 ? "stack" : "single",
    summary: "It does the thing.",
    // The index reads its counts from `review_prs`, not from the document; the document
    // carries these only so the fixture is a review a reader could actually open.
    prs: prs.map((p) => ({
      repo: p.repo,
      number: p.number,
      title: `PR ${p.number}`,
      headSha: `${p.number}`.repeat(40).slice(0, 40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      parent: null,
      author: "someone",
      coAuthors: [],
      kinds: [],
      gist: "a gist",
      detail: "",
      detailRef: "",
      body: "",
      files: [],
      hunks: [],
      state: "open",
      merged: false,
      draft: false,
    })) as ReviewDoc["prs"],
    statements: [],
    notes: [],
    groups: [],
    hunks: [],
    attachments: [],
    skillContext: [],
    unaccounted: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function observe(
  repo: string,
  repoId: number,
  number: number,
  o: { state?: string; merged?: boolean; draft?: boolean },
  ws = wsId,
): void {
  const obs: PrObservation = {
    repoId,
    repo,
    prNumber: number,
    state: o.state ?? "open",
    merged: o.merged ?? false,
    draft: o.draft ?? false,
    headSha: `${number}`.repeat(40).slice(0, 40),
    updatedAt: 1_700_000_000_000,
  };
  upsertPrStatus(ws, INSTALL, obs);
}

const REPO = "threahq/threa";
const REPO_ID = 5150;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  wsId = legacyWorkspaceId()!;

  // A review whose pull requests have been observed, one of each reading plus one
  // nobody has looked at — the row the tally has to be able to count as unchecked.
  // #6 is the one left unobserved.
  const mixed = [1, 2, 3, 4, 5, 6].map((n) => ({ repo: REPO, number: n }));
  createReviewVersion(wsId, "mixed-stack", doc("The mixed stack", mixed));
  createReviewVersion(wsId, "mixed-stack", doc("The mixed stack", mixed));
  setReviewPrs(wsId, "mixed-stack", mixed.map((p) => ({ ...p, repoId: REPO_ID })));
  observe(REPO, REPO_ID, 1, { state: "closed", merged: true });
  observe(REPO, REPO_ID, 2, { state: "closed", merged: true });
  observe(REPO, REPO_ID, 3, { state: "open" });
  observe(REPO, REPO_ID, 4, { state: "open", draft: true });
  observe(REPO, REPO_ID, 5, { state: "closed" });

  // A review predating any observation: rows in review_prs, none in github_pr_status.
  const unseen = [{ repo: REPO, number: 41 }, { repo: REPO, number: 42 }];
  createReviewVersion(wsId, "never-checked", doc("The unchecked review", unseen));
  setReviewPrs(wsId, "never-checked", unseen.map((p) => ({ ...p, repoId: REPO_ID })));

  const stackId = tinyId("rsk");
  const manifestId = tinyId("rsm");
  const owner = db.query<{ user_id: string }, [string]>("SELECT user_id FROM memberships WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(wsId)!.user_id;
  const now = Date.now();
  db.run(
    "INSERT INTO review_stacks VALUES (?, ?, 'retained-stack', 'The retained stack', ?, ?, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)",
    [stackId, wsId, REPO, REPO_ID, owner, tinyId("key"), now, now],
  );
  const manifest = {
    identity: { stackId, slug: "retained-stack", title: "The retained stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date(now).toISOString() },
    repository: { repo: REPO, repoId: REPO_ID, baseRef: "main" },
    source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null },
    members: [
      { lineageId: tinyId("rln"), lineageSlug: "stack-open", prNumber: 71, title: "Open member", revisionId: tinyId("rvr"), revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: "open", headSha: "7".repeat(40), status: "live", removedReason: null },
      { lineageId: tinyId("rln"), lineageSlug: "stack-merged", prNumber: 72, title: "Merged member", revisionId: tinyId("rvr"), revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: "merged", headSha: "8".repeat(40), status: "merged", removedReason: null },
    ],
    projects: [],
  };
  db.run(
    "INSERT INTO review_stack_manifests VALUES (?, ?, ?, 'retained-stack', 1, 0, 'created', 1, ?, ?, ?)",
    [manifestId, stackId, wsId, JSON.stringify(manifest), digestOf(manifest), now],
  );

  // Someone else's workspace, with a review that must not surface on this reader's page.
  createReviewVersion(WS_OTHER, "not-yours", doc("Somebody else's review", [{ repo: REPO, number: 99 }]));
  setReviewPrs(WS_OTHER, "not-yours", [{ repo: REPO, number: 99, repoId: REPO_ID }]);
  observe(REPO, REPO_ID, 99, { state: "closed", merged: true }, WS_OTHER);
});

afterAll(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  server.stop(true);
});

/** The text of one review's row, tags stripped and whitespace collapsed. */
function rowText(html: string, slug: string, route = "r"): string {
  const start = html.indexOf(`/${wsId}/${route}/${slug}/`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</tr>", start);
  return html
    .slice(start, end)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function index(): Promise<string> {
  githubCalls = 0;
  setGithubClientFactory(countingFactory);
  const r = await fetch(`${base}/reviews`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toStartWith("text/html");
  return r.text();
}

describe("the reviews index", () => {
  test("the tally matches the seeded rows, and no GitHub call was made drawing it", async () => {
    const html = await index();

    // The half that stops the zero-call assertion being vacuous: the page has to have
    // rendered the review, its title, its version and its counts.
    const row = rowText(html, "mixed-stack");
    expect(row).toContain("The mixed stack");
    expect(row).toContain("mixed-stack");
    expect(row).toContain("v2");
    expect(row).toContain("2 merged");
    expect(row).toContain("1 open");
    expect(row).toContain("1 draft");
    expect(row).toContain("1 closed");
    expect(row).toContain("1 unchecked");

    // And the counts are the rows, not a guess: the same numbers the tables hold.
    expect(reviewStatusTally(wsId, "mixed-stack")).toEqual({
      merged: 2,
      open: 1,
      draft: 1,
      closed: 1,
      unknown: 1,
      total: 6,
    });

    expect(githubCalls).toBe(0);
  });

  test("should link a retained stack with its title, pin, members, and no GitHub read", async () => {
    const html = await index();
    const row = rowText(html, "retained-stack", "r-stacks");
    expect(row).toContain("The retained stack");
    expect(row).toContain("v1");
    expect(row).toContain("1 merged");
    expect(row).toContain("1 open");
    expect(html).toContain(`href="/${wsId}/r-stacks/retained-stack/"`);
    const scoped = await (await fetch(`${base}/${wsId}/reviews`)).text();
    expect(scoped).toContain(`href="/${wsId}/r-stacks/retained-stack/"`);
    expect(githubCalls).toBe(0);
  });

  test("a merged pull request counts as merged, never as closed", () => {
    // GitHub's `state` for a merged pull request is "closed", so the ordering is
    // correctness: one seeded pull request is merged-and-closed and one is only closed.
    const t = reviewStatusTally(wsId, "mixed-stack");
    expect(t.merged).toBe(2);
    expect(t.closed).toBe(1);
  });

  test("a review nobody has observed says so, rather than reading as current", async () => {
    const html = await index();
    const row = rowText(html, "never-checked");
    expect(row).toContain("The unchecked review");
    expect(row).toContain("not checked yet");
    expect(row).not.toContain("open");
    expect(githubCalls).toBe(0);
  });

  test("republishing moves the version the index prints", async () => {
    createReviewVersion(wsId, "never-checked", doc("The unchecked review", []));
    const html = await index();
    expect(rowText(html, "never-checked")).toContain("v2");
    expect(githubCalls).toBe(0);
  });

  test("another workspace's review is not listed, while this reader's are", async () => {
    const html = await index();
    // The refusal...
    expect(html).not.toContain("Somebody else's review");
    expect(html).not.toContain(`/${WS_OTHER}/r/not-yours/`);
    // ...and the thing it withholds, demonstrably there to withhold.
    expect(html).toContain("The mixed stack");
    expect(html).toContain(`/${wsId}/r/mixed-stack/`);
    expect(githubCalls).toBe(0);
  });

  test("listing many reviews is still no calls at all", async () => {
    for (let i = 0; i < 20; i++) {
      const prs = [{ repo: REPO, number: 200 + i }];
      createReviewVersion(wsId, `bulk-${i}`, doc(`Bulk ${i}`, prs));
      setReviewPrs(wsId, `bulk-${i}`, prs.map((p) => ({ ...p, repoId: REPO_ID })));
      observe(REPO, REPO_ID, 200 + i, { state: "open" });
    }
    const html = await index();
    expect(rowText(html, "bulk-0")).toContain("1 open");
    expect(rowText(html, "bulk-19")).toContain("1 open");
    expect(githubCalls).toBe(0);
  });
});
