// What one capture may spend at GitHub, measured rather than asserted.
//
// The fixtures are 100, 300 and 1,000 changed files, because the two ceilings bind in
// different places and the interesting cases are the ones where a capture is large
// enough to feel them. Nothing here touches SQLite or the blob store: `persist` and
// `saveBlob` are injected, which is also what makes the accounting checkable — the whole
// CaptureInsert is in hand, so "every object is either retained or named" is a property
// of the record rather than of a query.

import { beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { createWorkspace, legacyWorkspaceId, listMembers } from "../src/db";
import { migrate } from "../src/migrate";
import { GithubError } from "../src/overseer/github";
import { GithubRateLimitError } from "../src/overseer/github-app";
import type { GithubClient, GithubTreeEntry } from "../src/overseer/github";
import { captureSource } from "../src/stage/source";
import type { CaptureInsert } from "../src/stage/db";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE = sha(1), HEAD = sha(2), MERGE = sha(3);

/** Metadata calls every capture makes: the repository, both refs, compare, both trees,
 *  and the pinned compare diff. Counted against the total ceiling, which is what makes
 *  the total honest rather than "blobs, plus however much else we felt like". */
const METADATA_CALLS = 7;

interface Fixture {
  client: GithubClient;
  /** Every unique Git object id the trees name, in retention order. */
  objects: string[];
  paths: string[];
  blobCalls: string[];
  maxActiveFetches: () => number;
}

/** N changed files, both sides differing, zero-padded so Unicode code-point order and
 *  numeric order are the same thing and the deterministic omission is legible. */
function fixture(count: number): Fixture {
  const paths = Array.from({ length: count }, (_, index) => `f-${index.toString().padStart(4, "0")}.txt`);
  const payloads = new Map<string, Uint8Array>();
  const entriesFor = (side: "old" | "new"): GithubTreeEntry[] =>
    paths.map((path, index) => {
      const object = `${side === "old" ? "1" : "2"}${index.toString(16).padStart(7, "0")}${"0".repeat(32)}`;
      const bytes = new TextEncoder().encode(`${side} ${path}\n`);
      payloads.set(object, bytes);
      return { path, mode: "100644", type: "blob" as const, sha: object, size: bytes.byteLength };
    });
  const oldEntries = entriesFor("old");
  const newEntries = entriesFor("new");
  const objects = paths.flatMap((_, index) => [oldEntries[index]!.sha, newEntries[index]!.sha]);

  const blobCalls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const client: GithubClient = {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => ({ id: 900, full_name: "Acme/Budget", default_branch: "main" }),
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, commit) => ({ sha: commit, truncated: false, tree: commit === HEAD ? newEntries : oldEntries }),
    getBlobBytes: async (_repo, object) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      blobCalls.push(object);
      return payloads.get(object)!;
    },
    // No compare files and no pinned diff: the tree union is what produces the
    // candidates, so this fixture measures budgets and nothing else.
    compare: async () => ({ merge_base_commit: { sha: MERGE }, files: [] }),
    compareDiff: async () => "",
  };
  return { client, objects, paths, blobCalls, maxActiveFetches: () => maxActive };
}

interface Captured {
  insert: CaptureInsert;
  writes: string[];
  maxActiveWrites: number;
}

async function capture(
  workspaceId: string,
  slug: string,
  fx: Fixture,
  limits: { maxBlobRequests?: number; maxGithubRequests?: number } = {},
): Promise<Captured> {
  let insert: CaptureInsert | null = null;
  const writes: string[] = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  await captureSource(workspaceId, { slug, repo: "Acme/Budget", branch: "feature/wide" }, {
    client: fx.client,
    idempotencyKey: slug,
    maxLogicalBytes: 50_000_000,
    ...limits,
    saveBlob: async (_ws, digest) => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await Promise.resolve();
      activeWrites--;
      writes.push(digest);
    },
    persist: (value) => { insert = value; return { captureId: value.capture.id, created: true }; },
  });
  if (!insert) throw new Error("the capture never reached its transaction");
  return { insert: insert as CaptureInsert, writes, maxActiveWrites };
}

/** Every unique object the trees named is either retained or carries a reason. Nothing
 *  is allowed to simply vanish from the record. */
function accounting(insert: CaptureInsert, objects: string[]): { retained: number; named: number } {
  const retained = new Set<string>();
  const named = new Set<string>();
  for (const file of insert.files) {
    for (const [object, availability, reason] of [
      [file.old_object_id, file.old_availability, file.old_reason],
      [file.new_object_id, file.new_availability, file.new_reason],
    ] as const) {
      if (object === null) continue;
      if (availability === "retained") retained.add(object);
      else if (reason !== null && reason !== "") named.add(object);
    }
  }
  const unique = new Set(objects);
  expect(retained.size + named.size).toBe(unique.size);
  return { retained: retained.size, named: named.size };
}

let ws = "";
beforeAll(() => {
  migrate();
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Capture budgets", owner);
});

describe("capture budgets", () => {
  test("the defaults leave 24 REST calls of headroom over the blob ceiling", () => {
    expect(config.stageBlobRequestLimit).toBe(1000);
    expect(config.stageGithubRequestLimit).toBe(1024);
    expect(config.stageGithubRequestLimit - config.stageBlobRequestLimit).toBe(24);
    // And the metadata a capture actually spends fits inside that headroom several times
    // over, which is why the blob ceiling is the one that normally binds.
    expect(METADATA_CALLS).toBeLessThan(24);
  });

  test("a validated environment override replaces a ceiling, and garbage is refused at boot", async () => {
    const { requestLimit } = await import("../src/config");
    expect(requestLimit("X", 1000, {})).toBe(1000);
    expect(requestLimit("X", 1000, { X: "" })).toBe(1000);
    expect(requestLimit("X", 1000, { X: "250" })).toBe(250);
    for (const bad of ["many", "0", "-5", "12.5", "1e400", " "]) {
      expect(() => requestLimit("STAGE_MAX_BLOB_REQUESTS", 1000, { STAGE_MAX_BLOB_REQUESTS: bad }))
        .toThrow("STAGE_MAX_BLOB_REQUESTS must be a whole number of at least 1");
    }
    expect(() => requestLimit("STAGE_MAX_GITHUB_REQUESTS", 1024, { STAGE_MAX_GITHUB_REQUESTS: "6" }, 7))
      .toThrow("STAGE_MAX_GITHUB_REQUESTS must be a whole number of at least 7");
  });

  test("100 changed files are captured whole, with bounded parallel fetch and write work", async () => {
    const fx = fixture(100);
    const captured = await capture(ws, "budget-100", fx);
    const { retained, named } = accounting(captured.insert, fx.objects);
    expect(retained).toBe(200);
    expect(named).toBe(0);
    expect(fx.blobCalls).toHaveLength(200);
    expect(captured.insert.files).toHaveLength(100);
    expect(captured.insert.changes).toHaveLength(100);
    expect(captured.insert.incomplete).toHaveLength(0);
    // 200 objects plus the pinned compare patch, none of them serialized and none of
    // them a stampede. The patch is written after the pool, on its own.
    expect(captured.writes).toHaveLength(201);
    expect(fx.maxActiveFetches()).toBeLessThanOrEqual(16);
    expect(captured.maxActiveWrites).toBeLessThanOrEqual(16);
    expect(captured.maxActiveWrites).toBeGreaterThan(1);
  });

  test("300 changed files bind on the total REST ceiling, independently of the blob ceiling", async () => {
    const fx = fixture(300);
    // 200 calls left for blobs after the metadata, against a blob ceiling of 1,000 that
    // could not bind here: the total is doing the work on its own.
    const captured = await capture(ws, "budget-300", fx, { maxGithubRequests: METADATA_CALLS + 200 });
    const { retained, named } = accounting(captured.insert, fx.objects);
    expect(retained).toBe(200);
    expect(named).toBe(400);
    expect(fx.blobCalls).toHaveLength(200);

    // Deterministic omission: the first 100 paths in code-point order keep both sides,
    // and every later one is named rather than dropped.
    const wholeFiles = captured.insert.files
      .filter((file) => file.old_availability === "retained" && file.new_availability === "retained")
      .map((file) => file.path);
    expect(wholeFiles).toEqual(fx.paths.slice(0, 100));
    const omitted = captured.insert.files.filter((file) => file.new_availability !== "retained");
    expect(omitted).toHaveLength(200);
    expect(omitted.every((file) => file.new_reason!.startsWith("[budget:github_requests] "))).toBe(true);
    expect(omitted[0]!.new_reason).toContain("at most 207 GitHub REST calls in total");
    expect(omitted[0]!.new_reason).toContain(`of which ${METADATA_CALLS} were spent`);
    // Named in the incomplete ledger too, one row per unavailable side.
    expect(captured.insert.incomplete.filter((item) => item.kind === "bytes_unavailable")).toHaveLength(400);
  });

  test("1,000 changed files bind on the default blob ceiling and leave the rest named", async () => {
    const fx = fixture(1000);
    const captured = await capture(ws, "budget-1000", fx);
    const { retained, named } = accounting(captured.insert, fx.objects);
    // 2,000 unique objects, 1,000 requests allowed: the blob ceiling binds, not the total.
    expect(retained).toBe(config.stageBlobRequestLimit);
    expect(named).toBe(2000 - config.stageBlobRequestLimit);
    expect(fx.blobCalls).toHaveLength(config.stageBlobRequestLimit);
    expect(captured.insert.files).toHaveLength(1000);

    const wholeFiles = captured.insert.files
      .filter((file) => file.old_availability === "retained" && file.new_availability === "retained")
      .map((file) => file.path);
    expect(wholeFiles).toEqual(fx.paths.slice(0, 500));
    const omitted = captured.insert.files.filter((file) => file.new_availability !== "retained");
    expect(omitted.every((file) => file.new_reason!.startsWith("[budget:blob_requests] "))).toBe(true);
    expect(omitted[0]!.new_reason).toContain("at most 1000 unique Git blob requests");
    expect(fx.maxActiveFetches()).toBeLessThanOrEqual(16);
    expect(captured.maxActiveWrites).toBeLessThanOrEqual(16);
    // Only the retained half is written, each object exactly once, plus the pinned patch.
    expect(new Set(captured.writes).size).toBe(captured.writes.length);
    expect(captured.writes).toHaveLength(config.stageBlobRequestLimit + 1);
  });

  test("a rate-limit refusal aborts the capture instead of naming hundreds of sides unavailable", async () => {
    const tooSmall = fixture(1);
    await expect(captureSource(ws, { slug: "budget-too-small", repo: "Acme/Budget", branch: "feature/wide" }, {
      client: tooSmall.client,
      idempotencyKey: "budget-too-small",
      maxGithubRequests: 6,
    })).rejects.toThrow("at least 7 requests");
    expect(tooSmall.blobCalls).toHaveLength(0);

    for (const refusal of [
      new GithubRateLimitError("GitHub's rate limit for this Seer instance's App is exhausted (GitHub answered 403)."),
      new GithubError("You have exceeded a secondary rate limit.", 403, ""),
      new GithubError("Too many requests", 429, ""),
    ]) {
      const fx = fixture(100);
      let calls = 0;
      const throwing: GithubClient = {
        ...fx.client,
        getBlobBytes: async (repo, object) => {
          if (++calls > 20) throw refusal;
          return fx.client.getBlobBytes!(repo, object);
        },
      };
      let persisted = false;
      await expect(captureSource(ws, { slug: "budget-throttled", repo: "Acme/Budget", branch: "feature/wide" }, {
        client: throwing,
        idempotencyKey: `budget-throttled-${refusal.status}-${calls}`,
        maxLogicalBytes: 50_000_000,
        saveBlob: async () => {},
        persist: (value) => { persisted = true; return { captureId: value.capture.id, created: true }; },
      })).rejects.toThrow();
      // The capture never reached its transaction, so there is no immutable record
      // claiming GitHub does not have this source.
      expect(persisted).toBe(false);
    }

    // The pinned diff is metadata too. Throttling there aborts rather than becoming a
    // permanent-looking patch_unavailable item.
    const atDiff = fixture(1);
    let persisted = false;
    await expect(captureSource(ws, { slug: "budget-diff-throttled", repo: "Acme/Budget", branch: "feature/wide" }, {
      client: { ...atDiff.client, compareDiff: async () => { throw new GithubError("secondary rate limit", 403, ""); } },
      idempotencyKey: "budget-diff-throttled",
      persist: (value) => { persisted = true; return { captureId: value.capture.id, created: true }; },
    })).rejects.toThrow("secondary rate limit");
    expect(persisted).toBe(false);
  });

  test("an injected ceiling below the metadata cost retains nothing and says which cap bound", async () => {
    const fx = fixture(100);
    const captured = await capture(ws, "budget-starved", fx, { maxGithubRequests: METADATA_CALLS });
    expect(fx.blobCalls).toHaveLength(0);
    const { retained, named } = accounting(captured.insert, fx.objects);
    expect(retained).toBe(0);
    expect(named).toBe(200);
    expect(captured.insert.files[0]!.new_reason).toContain("[budget:github_requests]");
  });
});
