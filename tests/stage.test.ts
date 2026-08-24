import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { join } from "node:path";
import { startServer } from "../src/server";
import { config } from "../src/config";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import { sessionCookie } from "../src/auth";
import { offlineGithubClientFactory } from "./offline-github";
import { setGithubClientFactory } from "../src/overseer/github-app";
import type { GithubClient } from "../src/overseer/github";
import { db } from "../src/db";
import { tinyId } from "../src/ids";
import { openStageBlob, saveStageBlob, stageBlobPath } from "../src/store";
import { getStageCapture, insertStageCapture } from "../src/stage/db";
import { rederiveCanonicalChanges } from "../src/stage/source";
import { validateStagePublish } from "../src/stage/validate";
import { createProject } from "../src/projects/db";
import { openApiSpec } from "../src/agent-discovery";

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

function renameFixtureClient(options: { changed?: boolean; aggregate?: boolean; includeAdded?: boolean; addedFirst?: boolean; renameBytesUnavailable?: boolean } = {}): GithubClient {
  const changed = options.changed ?? true;
  const aggregate = options.aggregate ?? true;
  const oldBytes = new TextEncoder().encode("old\n");
  const movedBytes = changed ? new TextEncoder().encode("new\n") : oldBytes;
  const addedBytes = new TextEncoder().encode("added\n");
  const oldSha = id(30), movedSha = changed ? id(31) : oldSha, addedSha = id(32);
  const blobBytes = new Map([[oldSha, oldBytes], [movedSha, movedBytes], [addedSha, addedBytes]]);
  const rename = { filename: "0-moved.txt", previous_filename: "a.txt", status: "renamed", additions: changed ? 1 : 0, deletions: changed ? 1 : 0, changes: changed ? 2 : 0 } as const;
  const added = { filename: "a.txt", status: "added", additions: 1, deletions: 0, changes: 1 } as const;
  const compareFiles = options.includeAdded
    ? options.addedFirst ? [added, rename] : [rename, added]
    : [rename];
  const renamePatch = [
    "diff --git a/a.txt b/0-moved.txt",
    changed ? "similarity index 50%" : "similarity index 100%",
    "rename from a.txt",
    "rename to 0-moved.txt",
    ...(changed ? [
      "--- a/a.txt",
      "+++ b/0-moved.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ] : []),
    "",
  ].join("\n");
  const addedPatch = [
    "diff --git a/a.txt b/a.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.txt",
    "@@ -0,0 +1,1 @@",
    "+added",
    "",
  ].join("\n");
  const patch = options.includeAdded && options.addedFirst
    ? addedPatch + renamePatch
    : renamePatch + (options.includeAdded ? addedPatch : "");
  return {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => ({ id: 987, full_name: "Acme/Repo", default_branch: "main" }),
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, sha) => {
      const tree = sha === HEAD
        ? [
            { path: "0-moved.txt", mode: "100644", type: "blob" as const, sha: movedSha },
            ...(options.includeAdded ? [{ path: "a.txt", mode: "100644", type: "blob" as const, sha: addedSha }] : []),
          ]
        : [{ path: "a.txt", mode: "100644", type: "blob" as const, sha: oldSha }];
      return { sha, truncated: false, tree: tree.map((entry) => ({ ...entry, size: blobBytes.get(entry.sha)!.byteLength })) };
    },
    getBlobBytes: async (_repo, sha) => {
      if (options.renameBytesUnavailable && (sha === oldSha || sha === movedSha)) throw new Error("rename bytes unavailable");
      return blobBytes.get(sha)!;
    },
    compare: async () => ({ merge_base_commit: { sha: MERGE }, files: compareFiles }),
    compareDiff: async () => {
      if (!aggregate) throw new Error("diff unavailable");
      return patch;
    },
  };
}

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
      { filename: "module", status: "modified", additions: 1, deletions: 1, changes: 2 },
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
const body = {
  slug: "branch-snapshot",
  repo: "Acme/Repo",
  branch: "feature/blue",
  builder: {
    intent: "Capture the pushed branch for a staged walkthrough.",
    context: "The witness will inspect the pinned source.",
    agent: { name: "builder", model: "test-model" },
  },
};
const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });

async function rederiveStored(inventory: NonNullable<ReturnType<typeof getStageCapture>>) {
  return rederiveCanonicalChanges(inventory, async (sha) => {
    const file = await openStageBlob(inventory.capture.workspace_id, sha);
    return file ? new Uint8Array(await new Response(file).arrayBuffer()) : null;
  });
}

function validateOpenApiResponse(operationId: string, body: unknown): void {
  const spec = openApiSpec() as any;
  const operation = Object.values(spec.paths).flatMap((path: any) => Object.values(path)).find((candidate: any) => candidate.operationId === operationId) as any;
  const schema = operation.responses["200"].content["application/json"].schema;
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(body)) throw new Error(`${operationId}: ${ajv.errorsText(validate.errors)}`);
}

async function createCapture(slug: string, builder = body.builder, idempotencySuffix = slug): Promise<any> {
  setGithubClientFactory(() => fixtureClient());
  const response = await fetch(`${base}/api/stage-captures`, {
    method: "POST",
    headers: auth({ "content-type": "application/json", "Idempotency-Key": `capture-${idempotencySuffix}` }),
    body: JSON.stringify({ ...body, slug, builder }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function partitionMembers(capture: any): any[] {
  return [
    ...capture.incomplete.filter((item: any) => item.path === null).map((item: any) => ({ type: "material", id: item.id, description: "Capture material" })),
    ...capture.files.flatMap((file: any) => {
      const materials = capture.incomplete.filter((item: any) => item.path === file.path);
      return [
        ...file.changes.map((change: any) => ({ type: "change", id: change.id, description: `Read ${file.path}` })),
        ...materials.map((item: any) => ({ type: "material", id: item.id, description: `Material for ${file.path}` })),
        ...(file.changes.length === 0 && materials.length === 0 ? [{ type: "file", id: file.id, description: `Retained file ${file.path}` }] : []),
      ];
    }),
  ];
}

function publishPayload(capture: any, overrides: Record<string, unknown> = {}): any {
  return {
    captureId: capture.id,
    expectedPreviousVersion: 0,
    slug: capture.slug,
    title: "Pinned branch walkthrough",
    summary: "The witness account.",
    witness: { name: "witness", model: "fresh-model" },
    groups: [{ id: "source-account", title: "Source account", category: "Code", importance: "high", complexity: "medium", explanation: "The pinned source account.", examples: [], members: partitionMembers(capture) }],
    ...overrides,
  };
}

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
    const objectSha = capture.patch?.sha256 ?? capture.files.flatMap((file: any) => [file.old.blobSha256, file.new.blobSha256]).find(Boolean);
    validateOpenApiResponse("createStageCapture", capture);
    expect(capture.id).toMatch(/^stg_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
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
    const symlinkReason = "The symlink target is retained, but line changes are not represented for symlinks.";
    expect(symlink.old.reason).toBe(symlinkReason);
    expect(symlink.new.reason).toBe(symlinkReason);
    expect(capture.incomplete.filter((item: any) => item.path === "link").map((item: any) => item.reason)).toEqual([symlinkReason, symlinkReason]);
    expect(symlink.changes).toEqual([]);
    const added = capture.files.find((file: any) => file.path === "new.txt");
    expect(added.changes[0].source).toBe("reconstructed");
    const submodule = capture.files.find((file: any) => file.path === "module");
    const submoduleReason = "The submodule commit id is retained, but line changes are not represented for submodules.";
    expect(submodule.old.reason).toBe(submoduleReason);
    expect(submodule.new.reason).toBe(submoduleReason);
    expect(capture.incomplete.filter((item: any) => item.path === "module").map((item: any) => item.reason)).toEqual([submoduleReason, submoduleReason]);
    expect(submodule.old.availability).toBe("not_applicable");
    const binary = capture.files.find((file: any) => file.path === "image.bin");
    const binaryReason = "Binary bytes are retained, but line changes are unavailable.";
    expect(binary.old.reason).toBe(binaryReason);
    expect(binary.new.reason).toBe(binaryReason);
    expect(capture.incomplete.filter((item: any) => item.path === "image.bin").map((item: any) => item.reason)).toEqual([binaryReason, binaryReason]);
    expect(calls.count).toBe(1);

    const otherClient = fixtureClient();
    otherClient.compareDiff = async () => "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+other\n";
    setGithubClientFactory(() => otherClient);
    const otherResponse = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "privacy-second" }), body: JSON.stringify({ ...body, slug: "privacy-second" }) });
    expect(otherResponse.status).toBe(200);
    const otherCapture = await otherResponse.json() as any;
    const otherObjectSha = otherCapture.patch?.sha256 ?? otherCapture.files.flatMap((file: any) => [file.old.blobSha256, file.new.blobSha256]).find(Boolean);
    expect(otherObjectSha).toBeTruthy();
    expect(otherObjectSha).not.toBe(objectSha);

    setGithubClientFactory(() => { throw new Error("GitHub must not be called while reading"); });
    const objectOperation = Object.values((openApiSpec() as any).paths).flatMap((path: any) => Object.values(path)).find((operation: any) => operation.operationId === "readStageCaptureObject") as any;
    expect(objectOperation.responses["200"].content["application/octet-stream"].schema).toEqual({ type: "string", format: "binary" });
    const read = await fetch(`${base}/api/stage-captures/${capture.id}`, { headers: auth() });
    expect(read.status).toBe(200);
    const readText = await read.text();
    validateOpenApiResponse("readStageCapture", JSON.parse(readText));
    expect(readText).toBe(JSON.stringify(capture, null, 2));

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
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string, STAGE_CAPTURE_ID: capture.id, STAGE_CAPTURE_KEY: key, STAGE_OTHER_CAPTURE_ID: otherCapture.id, STAGE_OTHER_OBJECT_SHA: otherObjectSha },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error("stage privacy stderr:", error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  });

  test("prefers the exact current path when a rename's old path is also newly added", async () => {
    const { captureSource } = await import("../src/stage/source");
    for (const [suffix, addedFirst] of [["rename-first", false], ["added-first", true]] as const) {
      const result = await captureSource(ws, { slug: `rename-path-${suffix}`, repo: "Acme/Repo", branch: "feature/blue" }, {
        client: renameFixtureClient({ includeAdded: true, addedFirst }), idempotencyKey: `rename-path-${suffix}`,
      });
      const inventory = getStageCapture(result.captureId, ws)!;
      const added = inventory.files.find((file) => file.path === "a.txt")!;
      expect(added.status).toBe("added");
      expect(added.additions).toBe(1);
      expect(added.deletions).toBe(0);
      expect(inventory.changes.filter((change) => change.file_id === added.id)).toHaveLength(1);
      expect(inventory.changes.find((change) => change.file_id === added.id)?.source).toBe("patch");
      const renamed = inventory.files.find((file) => file.path === "0-moved.txt")!;
      expect(inventory.changes.filter((change) => change.file_id === renamed.id)).toHaveLength(1);
      expect(inventory.changes.find((change) => change.file_id === renamed.id)?.source).toBe("patch");
      expect(await rederiveStored(inventory)).toEqual(inventory.changes);
    }
  });

  test("keeps patch-backed edited renames as patch-sourced changes", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "edited-rename-patch", repo: "Acme/Repo", branch: "feature/blue" }, {
      client: renameFixtureClient(), idempotencyKey: "edited-rename-patch",
    });
    const inventory = getStageCapture(result.captureId, ws)!;
    const renamed = inventory.files.find((file) => file.path === "0-moved.txt")!;
    expect(renamed.status).toBe("renamed");
    expect(inventory.changes.filter((change) => change.file_id === renamed.id).map((change) => change.source)).toEqual(["patch"]);
    expect(await rederiveStored(inventory)).toEqual(inventory.changes);
  });

  test("reconstructs an edited rename when the aggregate patch is unavailable", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "edited-rename-reconstructed", repo: "Acme/Repo", branch: "feature/blue" }, {
      client: renameFixtureClient({ aggregate: false }), idempotencyKey: "edited-rename-reconstructed",
    });
    const inventory = getStageCapture(result.captureId, ws)!;
    const renamed = inventory.files.find((file) => file.path === "0-moved.txt")!;
    expect(inventory.changes.filter((change) => change.file_id === renamed.id).map((change) => change.source)).toEqual(["reconstructed"]);
    expect(inventory.incomplete.some((item) => item.kind === "patch_unavailable")).toBe(true);
    expect(inventory.incomplete.some((item) => item.path === "0-moved.txt" && item.kind === "lines_unavailable")).toBe(false);
    expect(await rederiveStored(inventory)).toEqual(inventory.changes);
  });

  test("leaves a pure rename unchanged when its old path is recreated and rename bytes are unavailable", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "pure-rename", repo: "Acme/Repo", branch: "feature/blue" }, {
      client: renameFixtureClient({ changed: false, includeAdded: true, renameBytesUnavailable: true }), idempotencyKey: "pure-rename",
    });
    const inventory = getStageCapture(result.captureId, ws)!;
    const renamed = inventory.files.find((file) => file.path === "0-moved.txt")!;
    const added = inventory.files.find((file) => file.path === "a.txt")!;
    expect(renamed.status).toBe("renamed");
    expect(renamed.additions).toBe(0);
    expect(renamed.deletions).toBe(0);
    expect(renamed.old_availability).toBe("unavailable");
    expect(renamed.new_availability).toBe("unavailable");
    expect(inventory.changes.filter((change) => change.file_id === renamed.id)).toEqual([]);
    expect(inventory.changes.filter((change) => change.file_id === added.id)).toHaveLength(1);
    expect(inventory.incomplete.filter((item) => item.path === "0-moved.txt" && item.kind === "bytes_unavailable")).toHaveLength(2);
    expect(await rederiveStored(inventory)).toEqual(inventory.changes);
  });

  test("names compare line loss for an edited rename without retained sides", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "edited-rename-unavailable", repo: "Acme/Repo", branch: "feature/blue" }, {
      client: renameFixtureClient({ aggregate: false }), idempotencyKey: "edited-rename-unavailable", maxLogicalBytes: 0,
    });
    const inventory = getStageCapture(result.captureId, ws)!;
    const renamed = inventory.files.find((file) => file.path === "0-moved.txt")!;
    expect(inventory.changes.filter((change) => change.file_id === renamed.id)).toEqual([]);
    const reasons = inventory.incomplete.filter((item) => item.path === "0-moved.txt").map((item) => item.reason).join(" ");
    expect(reasons).toContain("compare reports 1 additions and 1 deletions");
    expect(reasons).toContain("retained logical-byte budget");
    expect(inventory.incomplete.filter((item) => item.path === "0-moved.txt" && item.kind === "bytes_unavailable")).toHaveLength(2);
    expect(await rederiveStored(inventory)).toEqual(inventory.changes);
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

  test("publishes an exact partition with separate builder and witness actors and Project state", async () => {
    setGithubClientFactory(() => fixtureClient());
    const captureResponse = await fetch(`${base}/api/stage-captures`, {
      method: "POST",
      headers: auth({ "content-type": "application/json", "Idempotency-Key": "publish-capture" }),
      body: JSON.stringify({ ...body, slug: "publish-stage" }),
    });
    expect(captureResponse.status).toBe(200);
    const capture = await captureResponse.json() as any;
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ slug: "stage-project", title: "Stage project" }),
    });
    expect(projectResponse.status).toBe(200);
    const members = [
      ...capture.incomplete.filter((item: any) => item.path === null).map((item: any) => ({ type: "material", id: item.id, description: "Capture material" })),
      ...capture.files.flatMap((file: any) => [
      ...file.changes.map((change: any) => ({ type: "change", id: change.id, description: `Read ${file.path}` })),
      ...capture.incomplete.filter((item: any) => item.path === file.path).map((item: any) => ({ type: "material", id: item.id, description: `Material for ${file.path}` })),
      ...(file.changes.length === 0 && !capture.incomplete.some((item: any) => item.path === file.path)
        ? [{ type: "file", id: file.id, description: `Retained file ${file.path}` }]
        : []),
      ]),
    ];
    const witnessUser = tinyId("usr");
    db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [witnessUser, "witness@stage.test", Date.now()]);
    db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [ws, witnessUser, Date.now()]);
    const witnessKey = mintApiKey(witnessUser, ws, "witness");
    const publishResponse = await fetch(`${base}/api/stages`, {
      method: "POST",
      headers: { authorization: `Bearer ${witnessKey.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        captureId: capture.id,
        expectedPreviousVersion: 0,
        slug: capture.slug,
        title: "Pinned branch walkthrough",
        summary: "The witness account.",
        witness: { name: "witness", model: "fresh-model" },
        groups: [{ id: "source-account", title: "Source account", category: "Code", importance: "high", complexity: "medium", explanation: "The pinned source account.", examples: [], members }],
        projects: ["stage-project"],
      }),
    });
    expect(publishResponse.status).toBe(200);
    const published = await publishResponse.json() as any;
    validateOpenApiResponse("publishStage", published);
    expect(published.version).toBe(1);
    expect(published.id).toMatch(/^sta_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    expect(published.document.identity.id).toBe(published.id);
    expect((db.query<{ id: string }, [string]>('SELECT id FROM stage_versions WHERE capture_id = ?').get(capture.id)!).id).toMatch(/^stv_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    expect(published.document.builder.userId).toBe((capture.builder as any).userId);
    expect(published.document.witness.userId).toBe(witnessUser);
    expect(published.document.builder.keyId).toBe((capture.builder as any).keyId);
    expect(published.document.witness.keyId).toBe(witnessKey.id);
    expect(published.document.builder.keyId).not.toBe(published.document.witness.keyId);
    expect(db.query("SELECT witness_user_id, witness_key_id FROM stage_versions WHERE capture_id = ?").get(capture.id)).toEqual({ witness_user_id: witnessUser, witness_key_id: witnessKey.id });
    expect(published.document.source.mergeBaseSha).toBe(capture.mergeBaseSha);
    expect(db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ?").get(ws)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM stage_versions WHERE workspace_id = ?").get(ws)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM project_stages WHERE workspace_id = ?").get(ws)).toEqual({ count: 1 });
    const read = await fetch(`${base}/api/stages/${capture.slug}`, { headers: auth() });
    expect(read.status).toBe(200);
    expect((await read.json() as any).document.identity.version).toBe(1);
    const project = await (await fetch(`${base}/api/projects/stage-project`, { headers: auth() })).json() as any;
    expect(project.stages).toEqual([{ slug: capture.slug, title: "Pinned branch walkthrough", latestVersion: 1, updatedAt: project.stages[0].updatedAt, url: `${config.baseUrl}/${ws}/st/${capture.slug}`, versionUrl: `${config.baseUrl}/${ws}/st/${capture.slug}/v/1`, apiUrl: `${config.baseUrl}/api/stages/${capture.slug}`, apiVersionUrl: `${config.baseUrl}/api/stages/${capture.slug}/v/1` }]);
    const projectMarkdown = await fetch(`${base}/${ws}/p/stage-project`, { headers: { ...auth(), accept: "text/markdown" } });
    const projectMarkdownText = await projectMarkdown.text();
    expect(projectMarkdownText).toContain(`[Pinned branch walkthrough](${config.baseUrl}/${ws}/st/${capture.slug}) (publish-stage) v1`);
    const projectHtml = await (await fetch(`${base}/${ws}/p/stage-project`, { headers: auth() })).text();
    expect(projectHtml).toContain(`<a href="${config.baseUrl}/${ws}/st/${capture.slug}">Pinned branch walkthrough</a>`);
    const script = join(import.meta.dir, "stage-privacy.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string, STAGE_CAPTURE_ID: capture.id, STAGE_CAPTURE_KEY: key, STAGE_SLUG: capture.slug },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error("stage publication privacy stderr:", error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  });

  test("replays and conflicts immutably, handles same-process finalization, and refuses Project writes", async () => {
    const capture = await createCapture("replay-publication");
    const payload = publishPayload(capture);
    const publish = () => fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(payload) });
    const first = await publish();
    expect(first.status).toBe(200);
    const firstText = await first.text();
    const replay = await publish();
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText);
    const conflictPayload = publishPayload(capture, { summary: "A changed witness account." });
    const conflict = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(conflictPayload) });
    expect(conflict.status).toBe(409);
    createProject(ws, "replay-a", "Replay A", "", null);
    createProject(ws, "replay-z", "Replay Z", "", null);
    const projectCapture = await createCapture("replay-project-order");
    const projectPayload = publishPayload(projectCapture, { projects: ["replay-z", "replay-a"] });
    const projectFirst = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(projectPayload) });
    expect(projectFirst.status).toBe(200);
    const projectFirstText = await projectFirst.text();
    const projectReplay = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify({ ...projectPayload, projects: ["replay-a", "replay-z", "replay-a"] }) });
    expect(projectReplay.status).toBe(200);
    expect(await projectReplay.text()).toBe(projectFirstText);

    const secondCapture = await createCapture("concurrent-publication");
    const concurrentPayload = publishPayload(secondCapture);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(concurrentPayload) })));
    expect(concurrent.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const concurrentBodies = await Promise.all(concurrent.map((response) => response.text()));
    expect(new Set(concurrentBodies).size).toBe(1);
    expect(db.query("SELECT COUNT(*) AS count FROM stage_versions WHERE workspace_id = ? AND capture_id = ?").get(ws, secondCapture.id)).toEqual({ count: 1 });

    const unknownProjectCapture = await createCapture("unknown-project-publication");
    const before = db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ?").get(ws);
    const unknownProject = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(unknownProjectCapture, { projects: ["missing-project"] })) });
    expect(unknownProject.status).toBe(422);
    expect(db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ?").get(ws)).toEqual(before);
    const otherWorkspace = createWorkspace("Stage other", listMembers(legacyWorkspaceId()!)[0]!.id);
    createProject(otherWorkspace, "other-project", "Other", "", null);
    const crossWorkspace = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(unknownProjectCapture, { projects: ["other-project"] })) });
    expect(crossWorkspace.status).toBe(422);
    expect(db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ?").get(ws)).toEqual(before);

    const conflictCapture = await createCapture("occupied-stage");
    expect((await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(conflictCapture)) })).status).toBe(200);
    const duplicateSlugCapture = await createCapture("occupied-stage", body.builder, "occupied-stage-2");
    const duplicateSlug = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(duplicateSlugCapture)) });
    expect(duplicateSlug.status).toBe(409);
  });

  test("reads latest and pinned versions without GitHub, and rejects capture and slug mismatches", async () => {
    const capture = await createCapture("read-stage");
    const malformedCapture = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(capture, { captureId: "x".repeat(100_000) })) });
    expect(malformedCapture.status).toBe(404);
    expect(await malformedCapture.text()).toBe(JSON.stringify({ error: "No completed capture in this workspace" }, null, 2));
    const mismatch = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(capture, { slug: "different-slug" })) });
    expect(mismatch.status).toBe(422);
    expect(db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ? AND slug = ?").get(ws, "different-slug")).toEqual({ count: 0 });
    const published = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(capture)) });
    expect(published.status).toBe(200);
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while reading a stage"); });
    const latest = await fetch(`${base}/api/stages/${capture.slug}`, { headers: auth() });
    const pinned = await fetch(`${base}/api/stages/${capture.slug}/v/1`, { headers: auth() });
    expect(latest.status).toBe(200);
    expect(pinned.status).toBe(200);
    const latestText = await latest.text();
    const pinnedText = await pinned.text();
    validateOpenApiResponse("readLatestStage", JSON.parse(latestText));
    validateOpenApiResponse("readStageVersion", JSON.parse(pinnedText));
    expect(latestText).toBe(pinnedText);
    const leadingZero = await fetch(`${base}/api/stages/${capture.slug}/v/01`, { headers: auth() });
    expect(leadingZero.status).toBe(404);
    const absent = await fetch(`${base}/api/stages/${capture.slug}/v/2`, { headers: auth() });
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
  });

  test("normalizes builder packets, rejects forbidden input, and includes builder content in idempotency", async () => {
    setGithubClientFactory(() => fixtureClient());
    const normalized = await createCapture("normalized-packet", {
      intent: "  Keep *the intent*\r\n on two lines  ",
      context: "Pinned\tcontext",
      agent: { name: "  builder  ", model: "model" },
    });
    expect(normalized.builder.intent).toBe("  Keep *the intent*\n on two lines  ");
    expect(normalized.builder.context).toBe("Pinned\tcontext");
    expect(normalized.builder.agent.name).toBe("builder");
    const identifiers = await createCapture("plain-identifiers", {
      intent: "Capture identifiers.", context: "", agent: { name: "agent_model_v2", model: "Array<T> stable() [old_path] `code`" },
    });
    expect(identifiers.builder.agent.model).toBe("Array<T> stable() [old_path] `code`");
    const missingContext = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-missing-context" }), body: JSON.stringify({ ...body, slug: "packet-missing-context", builder: { ...body.builder, context: undefined } }) });
    expect(missingContext.status).toBe(422);
    expect(await missingContext.text()).toContain("builder.context");
    const forbidden = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-forbidden" }), body: JSON.stringify({ ...body, slug: "packet-forbidden", builder: { ...body.builder, intent: "# not a heading" } }) });
    expect(forbidden.status).toBe(422);
    expect(await forbidden.text()).toContain("builder.intent");
    const del = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-del" }), body: JSON.stringify({ ...body, slug: "packet-del", builder: { ...body.builder, intent: "DEL\u007f" } }) });
    expect(del.status).toBe(422);
    const overlong = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-overlong" }), body: JSON.stringify({ ...body, slug: "packet-overlong", builder: { ...body.builder, context: "x".repeat(4001) } }) });
    expect(overlong.status).toBe(422);
    expect(await overlong.text()).toContain("4000");
    for (const [suffix, builder] of [
      ["intent", { ...body.builder, intent: "x".repeat(1201) }],
      ["agent", { ...body.builder, agent: { name: "x".repeat(81), model: "model" } }],
      ["control", { ...body.builder, agent: { name: "builder\nname", model: "model" } }],
    ] as const) {
      const response = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": `packet-${suffix}` }), body: JSON.stringify({ ...body, slug: `packet-${suffix}`, builder }) });
      expect(response.status).toBe(422);
    }
    const first = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-digest" }), body: JSON.stringify({ ...body, slug: "packet-digest" }) });
    expect(first.status).toBe(200);
    const changedPacket = await fetch(`${base}/api/stage-captures`, { method: "POST", headers: auth({ "content-type": "application/json", "Idempotency-Key": "packet-digest" }), body: JSON.stringify({ ...body, slug: "packet-digest", builder: { ...body.builder, intent: "A different intent" } }) });
    expect(changedPacket.status).toBe(409);
  });

  test("validates every publication enum, nested shape, budget, and exact leaf partition", async () => {
    const capture = await createCapture("validation-boundaries");
    const post = (payload: any) => fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(payload) });
    const normalizedProjects = validateStagePublish(publishPayload(capture, { projects: ["z-project", "a-project", "z-project"] }), getStageCapture(capture.id, ws)!);
    expect(normalizedProjects.value?.projects).toEqual(["a-project", "z-project"]);
    const punctuation = publishPayload(await createCapture("punctuation"));
    punctuation.title = "stable()";
    punctuation.witness = { name: "agent_model_v2", model: "Array<T>" };
    punctuation.groups[0].title = "[old_path]";
    punctuation.groups[0].attention = "_attention_";
    punctuation.groups[0].members[0].description = "`code` _identifier_";
    expect((await post(punctuation)).status).toBe(200);
    const narrativeDel = publishPayload(await createCapture("narrative-del"), { summary: "DEL\u007f" });
    expect((await post(narrativeDel)).status).toBe(422);
    const inlineRejection = publishPayload(await createCapture("inline-rejection"), { title: "# heading" });
    const inlineResponse = await post(inlineRejection);
    expect(inlineResponse.status).toBe(422);
    expect((await inlineResponse.json() as any).errors).toContainEqual({ field: "title", message: expect.stringContaining("heading") });
    const enumCases: [string, (payload: any) => void][] = [
      ["category", (payload) => { payload.groups[0].category = "Other"; }],
      ["importance", (payload) => { payload.groups[0].importance = "urgent"; }],
      ["complexity", (payload) => { payload.groups[0].complexity = "hard"; }],
      ["member type", (payload) => { payload.groups[0].members.find((member: any) => member.type === "change").type = "material"; }],
    ];
    for (const [name, mutate] of enumCases) {
      const payload = publishPayload(capture);
      mutate(payload);
      const response = await post(payload);
      const body = await response.text();
      expect({ name, status: response.status, body }).toMatchObject({ name, status: 422 });
      if (name === "category") expect(body).not.toContain("omits canonical");
    }
    const budgetCases: [string, (payload: any) => void][] = [
      ["title", (payload) => { payload.title = "x".repeat(81); }],
      ["summary", (payload) => { payload.summary = "x".repeat(1201); }],
      ["group title", (payload) => { payload.groups[0].title = "x".repeat(61); }],
      ["explanation", (payload) => { payload.groups[0].explanation = "x".repeat(1601); }],
      ["attention", (payload) => { payload.groups[0].attention = "x".repeat(301); }],
      ["member description", (payload) => { payload.groups[0].members[0].description = "x".repeat(401); }],
      ["witness name", (payload) => { payload.witness.name = "x".repeat(81); }],
      ["witness model", (payload) => { payload.witness.model = "x".repeat(81); }],
      ["example code", (payload) => { payload.groups[0].examples = [{ code: "x".repeat(501), text: "caption" }]; }],
      ["example text", (payload) => { payload.groups[0].examples = [{ code: "code", text: "x".repeat(301) }]; }],
    ];
    for (const [name, mutate] of budgetCases) {
      const payload = publishPayload(capture);
      mutate(payload);
      const response = await post(payload);
      expect({ name, status: response.status, body: await response.text() }).toMatchObject({ name, status: 422 });
    }
    const examples = publishPayload(capture);
    examples.groups[0].examples = Array.from({ length: 6 }, () => ({ code: "code", text: "caption" }));
    expect((await post(examples)).status).toBe(422);
    const hugeExamples = publishPayload(capture);
    hugeExamples.groups[0].examples = Array.from({ length: 1000 }, () => ({ code: "code", text: "caption" }));
    const hugeExamplesResponse = await post(hugeExamples);
    expect(hugeExamplesResponse.status).toBe(422);
    expect(((await hugeExamplesResponse.json()) as any).errors.length).toBeLessThanOrEqual(32);
    const groups = publishPayload(capture);
    groups.groups = Array.from({ length: 17 }, (_, index) => ({ ...groups.groups[0], id: `group-${index}` }));
    expect((await post(groups)).status).toBe(422);
    const projects = publishPayload(capture, { projects: Array.from({ length: 17 }, (_, index) => `project-${index}`) });
    expect((await post(projects)).status).toBe(422);
    const hugeGroups = publishPayload(capture);
    hugeGroups.groups = Array.from({ length: 1000 }, (_, index) => ({ ...hugeGroups.groups[0], id: `group-${index}` }));
    const hugeGroupsResponse = await post(hugeGroups);
    expect(hugeGroupsResponse.status).toBe(422);
    expect(((await hugeGroupsResponse.json()) as any).errors.length).toBeLessThanOrEqual(32);
    const hugeMembers = publishPayload(capture);
    hugeMembers.groups[0].members = Array.from({ length: 10001 }, (_, index) => ({ type: "file", id: `file-${index}`, description: "file" }));
    const hugeMembersResponse = await post(hugeMembers);
    expect(hugeMembersResponse.status).toBe(422);
    expect(((await hugeMembersResponse.json()) as any).errors.length).toBeLessThanOrEqual(32);
    const extra = publishPayload(capture);
    extra.groups[0].unknown = true;
    extra.groups[0].examples = [{ code: "code", text: "caption", extra: true }];
    extra.groups[0].members[0].extra = true;
    expect((await post(extra)).status).toBe(422);

    const members = partitionMembers(capture);
    const cases: [string, any[]][] = [
      ["unknown", [{ ...members[0], id: "unknown-leaf" }, ...members.slice(1)]],
      ["duplicate", [...members, members[0]]],
      ["omitted", members.slice(1)],
    ];
    const changeIndex = members.findIndex((member) => member.type === "change");
    cases.push(["wrong type", members.map((member, index) => index === changeIndex ? { ...member, type: "material" } : member)]);
    for (const [name, changedMembers] of cases) {
      const payload = publishPayload(capture);
      payload.groups[0].members = changedMembers;
      const response = await post(payload);
      const text = await response.text();
      expect({ name, status: response.status, concrete: text.includes("a.txt") || text.includes("new.txt") || text.includes("material") || text.includes("change") }).toMatchObject({ name, status: 422, concrete: true });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM stages WHERE workspace_id = ? AND slug = ?").get(ws, capture.slug)).toEqual({ count: 0 });
  });

  test("associates material with its current path only across a rename and recreate", async () => {
    const capture = await createCapture("rename-recreate-material");
    const inventory = getStageCapture(capture.id, ws)!;
    const custom = {
      ...inventory,
      files: [
        { ...inventory.files[0]!, id: "rename-file", path: "b.txt", old_path: "a.txt", status: "renamed" },
        { ...inventory.files[1]!, id: "created-file", path: "a.txt", old_path: null, status: "added" },
      ],
      changes: [],
      incomplete: [{ ...inventory.incomplete[0]!, id: "material-a", path: "a.txt", side: "new", kind: "bytes_unavailable", reason: "new bytes unavailable" }],
    } as any;
    const checked = validateStagePublish({
      captureId: capture.id, expectedPreviousVersion: 0, slug: capture.slug, title: "Rename", summary: "Summary",
      witness: { name: "w", model: "m" },
      groups: [{ id: "rename", title: "Rename", category: "Code", importance: "high", complexity: "low", explanation: "Files", examples: [], members: [
        { type: "material", id: "material-a", description: "Material for a" },
        { type: "file", id: "rename-file", description: "Renamed file" },
      ] }],
    }, custom);
    expect(checked.errors).toEqual([]);
    expect(checked.value).not.toBeNull();
    const pathless = { ...custom, incomplete: [...custom.incomplete, { ...custom.incomplete[0], id: "snapshot-material", path: null, reason: "tree snapshot was truncated" }] } as any;
    const omitted = validateStagePublish({
      captureId: capture.id, expectedPreviousVersion: 0, slug: capture.slug, title: "Rename", summary: "Summary",
      witness: { name: "w", model: "m" }, groups: [{ id: "rename", title: "Rename", category: "Code", importance: "high", complexity: "low", explanation: "Files", examples: [], members: [
        { type: "material", id: "material-a", description: "Material for a" }, { type: "file", id: "rename-file", description: "Renamed file" },
      ] }],
    }, pathless);
    expect(omitted.errors.map((error) => error.message)).toContain("omits incomplete material snapshot-material (tree snapshot was truncated)");
  });

  test("a capture without a builder packet is readable but cannot publish", async () => {
    const { captureSource } = await import("../src/stage/source");
    const result = await captureSource(ws, { slug: "legacy-no-packet", repo: "Acme/Repo", branch: "feature/blue" }, { client: fixtureClient(), idempotencyKey: "legacy-no-packet" });
    const response = await fetch(`${base}/api/stages`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ captureId: result.captureId, expectedPreviousVersion: 0, slug: "legacy-no-packet", title: "No packet", summary: "Summary", witness: { name: "w", model: "m" }, groups: [] }),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("new capture");
  });

  test("soft-404s a malformed stored stage document", async () => {
    const capture = await createCapture("malformed-stage-document");
    createProject(ws, "malformed-project", "Malformed project", "", null);
    const malformedPayload = publishPayload(capture, { projects: ["malformed-project"] });
    const response = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(malformedPayload) });
    expect(response.status).toBe(200);
    const stored = JSON.stringify((await response.clone().json() as any).document);
    for (const malformed of ["{", "{}", JSON.stringify({ identity: {}, source: "wrong" })]) {
      db.run("UPDATE stage_versions SET doc = ? WHERE workspace_id = ? AND capture_id = ?", [malformed, ws, capture.id]);
      const read = await fetch(`${base}/api/stages/${capture.slug}`, { headers: auth() });
      const pinned = await fetch(`${base}/api/stages/${capture.slug}/v/1`, { headers: auth() });
      const project = await fetch(`${base}/api/projects/malformed-project`, { headers: auth() });
      const page = await fetch(`${base}/${ws}/p/malformed-project`);
      expect(read.status).toBe(404);
      expect(pinned.status).toBe(404);
      expect(project.status).toBe(200);
      expect(page.status).toBe(200);
      expect(read.headers.get("cache-control")).toBe("no-store");
      const replay = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(malformedPayload) });
      expect(replay.status).toBe(409);
    }
    const mismatched = JSON.parse(stored) as any;
    mismatched.identity.version = 2;
    db.run("UPDATE stage_versions SET doc = ? WHERE workspace_id = ? AND capture_id = ?", [JSON.stringify(mismatched), ws, capture.id]);
    const mismatchRead = await fetch(`${base}/api/stages/${capture.slug}`, { headers: auth() });
    const mismatchProject = await fetch(`${base}/api/projects/malformed-project`, { headers: auth() });
    const mismatchReplay = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(malformedPayload) });
    expect(mismatchRead.status).toBe(404);
    expect(mismatchProject.status).toBe(200);
    expect(mismatchReplay.status).toBe(409);
    db.run("UPDATE stage_versions SET doc = ? WHERE workspace_id = ? AND capture_id = ?", [stored, ws, capture.id]);
  });

  test("continues to a healthy same-slug stage in a later readable workspace", async () => {
    const capture = await createCapture("cross-workspace-corruption");
    const published = await fetch(`${base}/api/stages`, { method: "POST", headers: auth({ "content-type": "application/json" }), body: JSON.stringify(publishPayload(capture)) });
    expect(published.status).toBe(200);
    const healthy = await published.json() as any;
    const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
    const laterWs = createWorkspace("Stage later readable", owner);
    const laterStageId = tinyId("sta");
    const laterCaptureId = tinyId("stg");
    const laterVersionId = tinyId("stv");
    const laterDoc = JSON.parse(JSON.stringify(healthy.document)) as any;
    laterDoc.identity.id = laterStageId;
    laterDoc.source.captureId = laterCaptureId;
    db.run("INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", [laterStageId, laterWs, capture.slug, "Acme/Repo", 987, "feature/blue", "main", MERGE, owner, "key_later", Date.now(), Date.now()]);
    db.run("INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)", [laterVersionId, laterWs, laterStageId, capture.slug, laterCaptureId, JSON.stringify(laterDoc), "healthy", owner, "key_later", Date.now()]);
    db.run("UPDATE stage_versions SET doc = ? WHERE workspace_id = ? AND capture_id = ?", ["{", ws, capture.id]);
    try {
      const read = await fetch(`${base}/api/stages/${capture.slug}`, { headers: { cookie: sessionCookie(owner).split(";")[0]! } });
      expect(read.status).toBe(200);
      expect((await read.json() as any).workspace).toBe(laterWs);
    } finally {
      db.run("DELETE FROM stage_versions WHERE workspace_id = ? AND capture_id = ?", [laterWs, laterCaptureId]);
      db.run("DELETE FROM stages WHERE workspace_id = ? AND id = ?", [laterWs, laterStageId]);
      db.run("UPDATE stage_versions SET doc = ? WHERE workspace_id = ? AND capture_id = ?", [JSON.stringify(healthy.document), ws, capture.id]);
    }
  });

  test("hosts complete builder and witness documents with deployment discovery", async () => {
    const agent = await fetch(`${base}/stage/agent.md`);
    const witness = await fetch(`${base}/stage/skill.md`);
    expect(agent.status).toBe(200);
    expect(witness.status).toBe(200);
    const agentText = await agent.text();
    const witnessText = await witness.text();
    for (const text of [agentText, witnessText]) {
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
    }
    expect(agentText).toContain("/api/stage-captures");
    expect(agentText).toContain("no conversation history");
    expect(agentText).toContain("/stage/skill.md");
    expect(witnessText).toContain("/api/stage-captures/<capture-id>");
    expect(witnessText).toContain("/api/stages");
    expect(witnessText).toContain("canonical change id");
    expect(witnessText).toContain("Do not claim");
    const discovery = await (await fetch(`${base}/.well-known/agent-skills/index.json`)).json() as any;
    expect(discovery.skills.map((skill: any) => skill.name)).toEqual(expect.arrayContaining(["seer-stage", "seer-stage-witness"]));
  });

  test("reports missing named object storage as corruption", async () => {
    const capture = await createCapture("missing-object-storage");
    const sha = capture.patch.sha256 as string;
    const stored = await openStageBlob(ws, sha);
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await new Response(stored!).arrayBuffer());
    const path = stageBlobPath(ws, sha);
    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);
    const { rmSync } = await import("node:fs");
    rmSync(path);
    try {
      const response = await fetch(`${base}/api/stage-captures/${capture.id}/objects/${sha}`, { headers: auth() });
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("storage corruption");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await saveStageBlob(ws, sha, bytes);
    }
  });

  test("reports a named object store exception as a retryable no-store error", async () => {
    const capture = await createCapture("object-store-outage");
    const sha = capture.patch.sha256 as string;
    const operation = Object.values((openApiSpec() as any).paths).flatMap((path: any) => Object.values(path)).find((candidate: any) => candidate.operationId === "readStageCaptureObject") as any;
    expect(operation.responses["500"]).toBeDefined();
    expect(operation.responses["502"]).toBeDefined();
    const { handleReadStageObject } = await import("../src/stage/source");
    const response = await handleReadStageObject(new Request(`${base}/api/stage-captures/${capture.id}/objects/${sha}`, { headers: auth() }), capture.id, sha, async () => {
      throw new Error("configured store unavailable");
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(JSON.stringify({ error: "Stage capture storage is temporarily unavailable." }));
    expect(response.headers.get("cache-control")).toBe("no-store");
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
