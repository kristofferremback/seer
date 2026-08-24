import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../src/server";
import { config } from "../src/config";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import { offlineGithubClientFactory } from "./offline-github";
import { setGithubClientFactory } from "../src/overseer/github-app";
import type { GithubClient } from "../src/overseer/github";
import { db } from "../src/db";
import { openStageBlob } from "../src/store";
import { getStageCapture, insertStageCapture } from "../src/stage/db";
import { rederiveCanonicalChanges } from "../src/stage/source";

const id = (n: number) => n.toString(16).padStart(40, "0");
const BASE = id(1), HEAD = id(2), MERGE = id(3);
const A = id(10), E = id(11), D = id(12), R = id(13), M = id(14), L = id(15), L2 = id(16), C = id(17), C2 = id(18), B = id(19), B2 = id(20), N = id(21);
const bytes: Record<string, Uint8Array> = {
  [A]: new TextEncoder().encode("old\n"),
  [E]: new TextEncoder().encode("new\n"),
  [D]: new TextEncoder().encode("deleted\n"),
  [R]: new TextEncoder().encode("renamed\n"),
  [M]: new TextEncoder().encode("mode\n"),
  [L]: new TextEncoder().encode("target\n"),
  [L2]: new TextEncoder().encode("target-new\n"),
  [B]: Uint8Array.from([0, 1, 2, 3]),
  [B2]: Uint8Array.from([0, 1, 2, 4]),
  [N]: new TextEncoder().encode("added\n"),
};

function fixtureClient(calls: { count: number; truncated?: boolean; failTree?: string; compareArgs?: [string, string]; blobCalls?: string[] } = { count: 0 }): GithubClient {
  return {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => { calls.count++; return { id: 987, full_name: "Acme/Repo", default_branch: "main" }; },
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, sha) => {
      if (calls.failTree === sha) throw new Error("tree unavailable");
      const tree = sha === HEAD ? [
        { path: "a.txt", mode: "100644", type: "blob" as const, sha: E },
        { path: "new-name.txt", mode: "100644", type: "blob" as const, sha: R },
        { path: "mode.txt", mode: "100755", type: "blob" as const, sha: M },
        { path: "link", mode: "120000", type: "blob" as const, sha: L2 },
        { path: "module", mode: "160000", type: "commit" as const, sha: C2 },
        { path: "image.bin", mode: "100644", type: "blob" as const, sha: B2 },
        { path: "new.txt", mode: "100644", type: "blob" as const, sha: N },
      ] : [
        ...(sha === BASE ? [{ path: "base-tip-only.txt", mode: "100644", type: "blob" as const, sha: D }] : []),
        { path: "a.txt", mode: "100644", type: "blob" as const, sha: A },
        { path: "deleted.txt", mode: "100644", type: "blob" as const, sha: D },
        { path: "old-name.txt", mode: "100644", type: "blob" as const, sha: R },
        { path: "mode.txt", mode: "100644", type: "blob" as const, sha: M },
        { path: "link", mode: "120000", type: "blob" as const, sha: L },
        { path: "module", mode: "160000", type: "commit" as const, sha: C },
        { path: "image.bin", mode: "100644", type: "blob" as const, sha: B },
      ];
      return { sha, truncated: !!calls.truncated, tree: tree.map((entry) => ({ ...entry, ...(entry.type === "blob" ? { size: bytes[entry.sha]?.byteLength ?? 0 } : {}) })) };
    },
    getBlobBytes: async (_repo, sha) => { calls.blobCalls?.push(sha); return bytes[sha] ?? new Uint8Array(); },
    compare: async (_repo, baseRef, headRef) => { calls.compareArgs = [baseRef, headRef]; return { merge_base_commit: { sha: MERGE }, files: [
      { filename: "a.txt", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,1 +1,1 @@\n-old\n+new\n" },
      { filename: "deleted.txt", status: "removed", additions: 0, deletions: 1, changes: 1, patch: "@@ -1,1 +0,0 @@\n-deleted\n" },
      { filename: "new-name.txt", previous_filename: "old-name.txt", status: "renamed", additions: 0, deletions: 0, changes: 0 },
      { filename: "mode.txt", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "link", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,1 +1,1 @@\n-target\n+target-new\n" },
      { filename: "module", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "image.bin", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "new.txt", status: "added", additions: 1, deletions: 0, changes: 1 },
    ] }; },
    compareDiff: async () => "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n\ndiff --git a/deleted.txt b/deleted.txt\n--- a/deleted.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-deleted\n\ndiff --git a/link b/link\n--- a/link\n+++ b/link\n@@ -1,1 +1,1 @@\n-target\n+target-new\n",
  };
}

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let key: string;
let ws: string;
const body = { slug: "branch-snapshot", repo: "Acme/Repo", branch: "feature/blue" };
const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Stage tests", owner);
  key = mintApiKey(owner, ws, "stage").token;
});
afterEach(() => setGithubClientFactory(offlineGithubClientFactory()));
afterAll(() => server.stop(true));

describe("stage captures", () => {
  test("captures a slash branch, default base, tree-complete inventory, and reconstructs patchless text", async () => {
    const calls = { count: 0, compareArgs: undefined as [string, string] | undefined, blobCalls: [] as string[] };
    setGithubClientFactory(() => fixtureClient(calls));
    const res = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "one" }), body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const capture = await res.json() as any;
    expect(capture.baseRef).toBe("main");
    expect(capture.sourceHeadSha).toBe(HEAD);
    expect(capture.baseTipSha).toBe(BASE);
    expect(capture.mergeBaseSha).toBe(MERGE);
    expect(calls.compareArgs).toEqual([BASE, HEAD]);
    expect(capture.files.some((file: any) => file.path === "base-tip-only.txt")).toBe(false);
    expect(capture.complete).toBe(true);
    expect(capture.reviewable).toBe(false);
    expect(capture.incomplete.some((item: any) => item.kind === "lines_unavailable" || item.kind === "bytes_unavailable")).toBe(true);
    expect(Object.fromEntries(capture.files.map((file: any) => [file.path, file.status]))).toEqual({
      "a.txt": "modified", "deleted.txt": "removed", "image.bin": "modified", "link": "modified",
      "mode.txt": "mode_changed", module: "modified", "new.txt": "added", "new-name.txt": "renamed",
    });
    const renamed = capture.files.find((file: any) => file.path === "new-name.txt");
    expect(renamed.oldPath).toBe("old-name.txt");
    expect(renamed.old.objectId).toBe(R);
    expect(renamed.new.objectId).toBe(R);
    expect(renamed.changes).toEqual([]);
    const mode = capture.files.find((file: any) => file.path === "mode.txt");
    expect(mode.old.reason).toContain("mode changed");
    const symlink = capture.files.find((file: any) => file.path === "link");
    expect(symlink.new.reason).toContain("symlink");
    expect(symlink.changes).toEqual([]);
    const added = capture.files.find((file: any) => file.path === "new.txt");
    expect(added.changes[0].source).toBe("reconstructed");
    expect(capture.incomplete.some((item: any) => item.reason.includes("submodule"))).toBe(true);
    expect(capture.files.find((file: any) => file.path === "module").old.availability).toBe("not_applicable");
    expect(capture.incomplete.some((item: any) => item.reason.includes("Binary"))).toBe(true);
    expect(calls.count).toBe(1);

    setGithubClientFactory(() => { throw new Error("GitHub must not be called while reading"); });
    const read = await fetch(`${base}/api/stage-captures/${capture.id}`, { headers: auth() });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(JSON.stringify(capture, null, 2));

    const inventory = getStageCapture(capture.id, ws)!;
    expect((db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM stage_blobs").get()!).count).toBeGreaterThan(0);
    const rederived = await rederiveCanonicalChanges(inventory, async (sha) => {
      const file = await openStageBlob(ws, sha);
      return file ? new Uint8Array(await new Response(file).arrayBuffer()) : null;
    });
    expect(rederived).toEqual(inventory.changes);

    const script = join(import.meta.dir, "stage-privacy.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string, STAGE_CAPTURE_ID: capture.id, STAGE_CAPTURE_KEY: key },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error("stage privacy stderr:", error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  });

  test("replays one key, rejects a changed request, and gives all misses one soft 404", async () => {
    setGithubClientFactory(() => fixtureClient());
    const headers = auth({ "content-type": "application/json", "Idempotency-Key": "replay" });
    const first = await fetch(`${base}/api/stage-captures`, { method: "POST", headers, body: JSON.stringify({ ...body, slug: "replay" }) });
    const firstText = await first.text();
    const replay = await fetch(`${base}/api/stage-captures`, { method: "POST", headers, body: JSON.stringify({ ...body, slug: "replay" }) });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText);
    const conflict = await fetch(`${base}/api/stage-captures`, { method: "POST", headers, body: JSON.stringify({ ...body, slug: "other" }) });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    const id = (JSON.parse(firstText) as { id: string }).id;
    const missing = await fetch(`${base}/api/stage-captures/not-an-id`, { headers: auth() });
    const absent = await fetch(`${base}/api/stage-captures/${"stg_0000000000"}`, { headers: auth() });
    expect(missing.status).toBe(404); expect(absent.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).toBe(await absent.text());
  });

  test("concurrent same-key creation mints one capture, and failed writes expose none", async () => {
    setGithubClientFactory(() => fixtureClient());
    const request = { ...body, slug: "concurrent" };
    const init = { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "concurrent" }), body: JSON.stringify(request) };
    const responses = await Promise.all([fetch(`${base}/api/stage-captures`, init), fetch(`${base}/api/stage-captures`, init)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(responses.map(async (response) => (await response.json() as { id: string }).id));
    expect(ids[0]).toBe(ids[1]);

    const { captureSource } = await import("../src/stage/source");
    await expect(captureSource(ws, { ...request, slug: "storage-failure" }, {
      client: fixtureClient(), idempotencyKey: "storage-failure", saveBlob: async () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");
    expect(db.query("SELECT 1 FROM stage_captures WHERE slug = 'storage-failure'").get()).toBeNull();
    await expect(captureSource(ws, { ...request, slug: "database-failure" }, {
      client: fixtureClient(), idempotencyKey: "database-failure", saveBlob: async () => {},
      persist: (input) => insertStageCapture({ ...input, files: input.files.length ? [input.files[0]!, input.files[0]!] : input.files }),
    })).rejects.toThrow();
    expect(db.query("SELECT 1 FROM stage_captures WHERE slug = 'database-failure'").get()).toBeNull();
    const missingKey = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(request) });
    expect(missingKey.status).toBe(400);
  });

  test("retained binary bytes make the source complete even when lines are not reviewable", async () => {
    const client = fixtureClient();
    const getTree = client.getTree!;
    client.getTree = async (repo, sha, recursive) => ({ ...await getTree(repo, sha, recursive), tree: (await getTree(repo, sha, recursive)).tree.filter((entry) => entry.type !== "commit") });
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({ ...await compare(repo, baseRef, branch), files: (await compare(repo, baseRef, branch)).files.filter((file) => file.filename !== "module") });
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "binary-complete", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "binary-complete" });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.capture.id).toBe(result.captureId);
    expect(inventory.files.find((file) => file.path === "image.bin")?.old_availability).toBe("retained");
    expect(inventory.incomplete.some((item) => item.kind === "lines_unavailable")).toBe(true);
    expect(inventory.incomplete.some((item) => item.kind === "bytes_unavailable")).toBe(false);
    const response = await fetch(`${base}/api/stage-captures/${result.captureId}`, { headers: auth() });
    expect((await response.json() as any).complete).toBe(true);
  });

  test("a missing aggregate patch does not hide reviewability when text reconstruction succeeds", async () => {
    const client = fixtureClient();
    const getTree = client.getTree!;
    client.getTree = async (repo, sha, recursive) => ({
      ...await getTree(repo, sha, recursive),
      tree: (await getTree(repo, sha, recursive)).tree.filter((entry) => entry.path === "a.txt"),
    });
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({
      ...await compare(repo, baseRef, branch),
      files: (await compare(repo, baseRef, branch)).files.filter((file) => file.filename === "a.txt").map(({ patch: _patch, ...file }) => file),
    });
    client.compareDiff = async () => { throw new Error("diff unavailable"); };
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "reconstructed-reviewable", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "reconstructed-reviewable" });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.incomplete.some((item) => item.kind === "patch_unavailable")).toBe(true);
    expect(inventory.incomplete.some((item) => item.kind === "lines_unavailable" || item.kind === "bytes_unavailable" || item.kind === "snapshot_incomplete")).toBe(false);
    const response = await fetch(`${base}/api/stage-captures/${result.captureId}`, { headers: auth() });
    expect((await response.json() as any).reviewable).toBe(true);
  });

  test("a 300-file compare cap cannot hide a tree change", async () => {
    const client = fixtureClient();
    const getTree = client.getTree!;
    client.getTree = async (repo, sha, recursive) => {
      const tree = await getTree(repo, sha, recursive);
      return sha === HEAD ? { ...tree, tree: [...tree.tree, { path: "tree-only.txt", mode: "100644", type: "blob", sha: N, size: bytes[N]!.byteLength }] } : tree;
    };
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({
      ...await compare(repo, baseRef, branch),
      files: [...(await compare(repo, baseRef, branch)).files, ...Array.from({ length: 292 }, (_, index) => ({ filename: `compare-only-${index}.txt`, status: "added", additions: 1, deletions: 0, changes: 1 }))],
    });
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "compare-cap", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "compare-cap" });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.files.some((file) => file.path === "tree-only.txt")).toBe(true);
    expect(inventory.files.filter((file) => file.path.startsWith("compare-only-")).length).toBe(292);
    expect(inventory.incomplete.some((item) => item.kind === "metadata_incomplete")).toBe(true);
  });

  test("a refused source tree aborts without exposing a capture", async () => {
    const { captureSource } = await import("../src/stage/source");
    await expect(captureSource(ws, { slug: "refused-tree", repo: "Acme/Repo", branch: "feature/blue" }, { client: fixtureClient({ count: 0, failTree: HEAD }), idempotencyKey: "refused-tree" })).rejects.toThrow("tree");
    expect(db.query("SELECT 1 FROM stage_captures WHERE slug = 'refused-tree'").get()).toBeNull();
  });

  test("a truncated side does not turn an omitted tree path into an add or remove", async () => {
    const client = fixtureClient({ count: 0, truncated: true });
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({ ...await compare(repo, baseRef, branch), files: (await compare(repo, baseRef, branch)).files.filter((file) => file.filename !== "deleted.txt") });
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "truncated-unknown", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "truncated-unknown" });
    const inventory = getStageCapture(result.captureId, ws)!;
    const deleted = inventory.files.find((file) => file.path === "deleted.txt")!;
    expect(deleted.status).toBe("unknown");
    expect(deleted.new_availability).toBe("unavailable");
  });

  test("tree facts classify removed and mode-only paths when compare omits them", async () => {
    const client = fixtureClient();
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({ ...await compare(repo, baseRef, branch), files: (await compare(repo, baseRef, branch)).files.filter((file) => file.filename !== "deleted.txt" && file.filename !== "mode.txt") });
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "tree-statuses", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "tree-statuses" });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.files.find((file) => file.path === "deleted.txt")?.status).toBe("removed");
    expect(inventory.files.find((file) => file.path === "mode.txt")?.status).toBe("mode_changed");
  });

  test("over-limit reconstruction retains bytes without calling quadratic alignment", async () => {
    const client = fixtureClient();
    const largeOld = new TextEncoder().encode("x\n".repeat(6001));
    const largeNew = new TextEncoder().encode("y\n".repeat(6001));
    const getTree = client.getTree!;
    client.getTree = async (repo, sha, recursive) => ({ ...await getTree(repo, sha, recursive), tree: (await getTree(repo, sha, recursive)).tree.map((entry) => entry.sha === A ? { ...entry, size: largeOld.byteLength } : entry.sha === E ? { ...entry, size: largeNew.byteLength } : entry) });
    const getBlob = client.getBlobBytes!;
    client.getBlobBytes = async (repo, sha) => sha === A ? largeOld : sha === E ? largeNew : getBlob(repo, sha);
    client.compareDiff = async () => "";
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "large-reconstruction", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "large-reconstruction" });
    const inventory = getStageCapture(result.captureId, ws)!;
    const edit = inventory.files.find((file) => file.path === "a.txt")!;
    expect(inventory.changes.filter((change) => change.file_id === edit.id)).toEqual([]);
    expect(inventory.incomplete.filter((item) => item.path === "a.txt" && item.kind === "lines_unavailable")).toHaveLength(2);
  });

  test("a truncated tree remains readable but explicitly incomplete", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "truncated-tree", repo: "Acme/Repo", branch: "feature/blue" }, { client: fixtureClient({ count: 0, truncated: true }), idempotencyKey: "truncated-tree" });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.incomplete.filter((item) => item.side === "snapshot")).toHaveLength(2);
    expect(inventory.incomplete.filter((item) => item.side === "snapshot").every((item) => item.reason.includes("tree"))).toBe(true);
    const response = await fetch(`${base}/api/stage-captures/${result.captureId}`, { headers: auth() });
    const capture = await response.json() as any;
    expect(capture.complete).toBe(false);
    expect(capture.reviewable).toBe(false);
  });

  test("a capture bounds unique blob requests with a deterministic bounded pool", async () => {
    const objectCount = 80;
    const paths = ["Z.txt", "ä.txt", ...Array.from({ length: objectCount - 2 }, (_, index) => `file-${index.toString().padStart(3, "0")}.txt`)];
    const payloads = new Map<string, Uint8Array>();
    const oldEntries = paths.map((path, index) => {
      const sha = `${index.toString(16).padStart(2, "0")}${"1".repeat(38)}`;
      const data = new TextEncoder().encode(`${sha}\n`);
      payloads.set(sha, data);
      return { path, mode: "100644", type: "blob" as const, sha, size: data.byteLength };
    });
    const newEntries = paths.map((path, index) => {
      const sha = `${index.toString(16).padStart(2, "0")}${"2".repeat(38)}`;
      const data = new TextEncoder().encode(`${sha}\n`);
      payloads.set(sha, data);
      return { path, mode: "100644", type: "blob" as const, sha, size: data.byteLength };
    });
    const calls = { active: 0, maxActive: 0, blobCalls: [] as string[] };
    const client = fixtureClient();
    client.getTree = async (_repo, sha) => ({ sha, truncated: false, tree: sha === HEAD ? newEntries : oldEntries });
    client.compare = async () => ({
      merge_base_commit: { sha: MERGE },
      files: paths.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 1, changes: 2 })),
    });
    client.compareDiff = async () => "";
    client.getBlobBytes = async (_repo, sha) => {
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      await Promise.resolve();
      calls.active--;
      calls.blobCalls.push(sha);
      return payloads.get(sha)!;
    };
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "blob-request-ceiling", repo: "Acme/Repo", branch: "feature/blue" }, { client, idempotencyKey: "blob-request-ceiling", maxLogicalBytes: 100_000 });
    const inventory = getStageCapture(result.captureId, ws)!;
    const retainedPaths = inventory.files.filter((file) => file.old_blob_sha && file.new_blob_sha).map((file) => file.path);
    const codePointOrder = [...paths].sort((left, right) => {
      const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
      const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
      for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
        if (leftPoints[index]! !== rightPoints[index]!) return leftPoints[index]! - rightPoints[index]!;
      }
      return leftPoints.length - rightPoints.length;
    });
    expect(["Z.txt", "ä.txt"].sort((left, right) => left.localeCompare(right))).toEqual(["ä.txt", "Z.txt"]);
    expect(calls.blobCalls).toHaveLength(64);
    expect(calls.maxActive).toBeLessThanOrEqual(16);
    expect(retainedPaths).toEqual(codePointOrder.slice(0, 32));
    expect(retainedPaths).toContain("Z.txt");
    expect(retainedPaths).not.toContain("ä.txt");
    const unavailable = inventory.incomplete.filter((item) => item.kind === "bytes_unavailable");
    expect(unavailable).toHaveLength((objectCount - 32) * 2);
    expect(unavailable.every((item) => item.reason.includes("64 unique Git blob requests"))).toBe(true);
    const retainedIndexes = new Set(codePointOrder.slice(0, 32).map((path) => paths.indexOf(path)));
    expect(calls.blobCalls.every((sha) => retainedIndexes.has(Number.parseInt(sha.slice(0, 2), 16)))).toBe(true);
  });

  test("a failed pinned diff never becomes a partial canonical patch", async () => {
    const client = fixtureClient();
    const compare = client.compare!;
    client.compare = async (repo, baseRef, branch) => ({
      ...await compare(repo, baseRef, branch),
      files: [
        ...(await compare(repo, baseRef, branch)).files,
        ...Array.from({ length: 292 }, (_, index) => ({ filename: `compare-only-${index}.txt`, status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1,1 @@\\n+omitted\\n" })),
      ],
    });
    client.compareDiff = async () => { throw new Error("aggregate diff unavailable"); };
    const stored = new Map<string, Uint8Array>();
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "failed-aggregate-diff", repo: "Acme/Repo", branch: "feature/blue" }, {
      client,
      idempotencyKey: "failed-aggregate-diff",
      saveBlob: async (_workspace, sha, data) => { stored.set(sha, data); },
    });
    const inventory = getStageCapture(result.captureId, ws)!;
    expect(inventory.capture.patch_sha256).toBeNull();
    expect(inventory.incomplete.some((item) => item.kind === "patch_unavailable")).toBe(true);
    expect(inventory.incomplete.some((item) => item.kind === "metadata_incomplete")).toBe(true);
    expect([...stored.values()].some((data) => new TextDecoder().decode(data).includes("diff --git"))).toBe(false);
    const rederived = await rederiveCanonicalChanges(inventory, async (sha) => stored.get(sha) ?? null);
    expect(rederived).toEqual(inventory.changes);
  });

  test("a small injected logical cap retains deterministic unique objects and leaves metadata", async () => {
    const { captureSource } = await import("../src/stage/source");
    const { getStageCapture } = await import("../src/stage/db");
    const calls = { count: 0, compareArgs: undefined as [string, string] | undefined, blobCalls: [] as string[] };
    const result = await captureSource(ws, { slug: "small-cap", repo: "Acme/Repo", branch: "feature/blue", baseRef: "main" }, { client: fixtureClient(calls), idempotencyKey: "small-cap", maxLogicalBytes: 7 });
    const inventory = getStageCapture(result.captureId, ws)!;
    const retained = inventory.files.flatMap((file) => [file.old_blob_sha, file.new_blob_sha]).filter(Boolean);
    expect(new Set(retained).size).toBeLessThanOrEqual(1);
    expect(calls.blobCalls).toEqual([A]);
    const cappedRederived = await rederiveCanonicalChanges(inventory, async (sha) => {
      const file = await openStageBlob(ws, sha);
      return file ? new Uint8Array(await new Response(file).arrayBuffer()) : null;
    });
    expect(cappedRederived).toEqual(inventory.changes);
    expect(inventory.incomplete.some((item) => item.kind === "patch_unavailable")).toBe(true);
    expect(inventory.incomplete.some((item) => item.reason.includes("budget"))).toBe(true);
    const zeroCalls = { count: 0, compareArgs: undefined as [string, string] | undefined, blobCalls: [] as string[] };
    const zero = await captureSource(ws, { slug: "zero-cap", repo: "Acme/Repo", branch: "feature/blue", baseRef: "main" }, { client: fixtureClient(zeroCalls), idempotencyKey: "zero-cap", maxLogicalBytes: 0 });
    const zeroInventory = getStageCapture(zero.captureId, ws)!;
    const zeroEdit = zeroInventory.files.find((file) => file.path === "a.txt")!;
    expect(zeroEdit.old_availability).toBe("unavailable");
    expect(zeroEdit.new_availability).toBe("unavailable");
    expect(zeroInventory.incomplete.filter((item) => item.path === "a.txt" && item.kind === "bytes_unavailable").map((item) => item.side).sort()).toEqual(["new", "old"]);
    expect(zeroCalls.blobCalls).toEqual([]);
    const same = await captureSource(ws, { slug: "small-cap-again", repo: "Acme/Repo", branch: "feature/blue", baseRef: "main" }, { client: fixtureClient(), idempotencyKey: "small-cap-again", maxLogicalBytes: 7 });
    const sameInventory = getStageCapture(same.captureId, ws)!;
    expect(sameInventory.changes.map((change) => change.id)).toEqual(inventory.changes.map((change) => change.id));
  });
});
