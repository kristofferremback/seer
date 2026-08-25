import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { startServer } from "../src/server";
import { config } from "../src/config";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import { db } from "../src/db";
import { sessionCookie } from "../src/auth";
import { tinyId } from "../src/ids";
import { setGithubClientFactory } from "../src/overseer/github-app";
import { offlineGithubClientFactory } from "./offline-github";
import type { GithubClient } from "../src/overseer/github";
import { openApiSpec } from "../src/agent-discovery";
import { getStageCapture, getStageVersion, listStageReadChangeIds } from "../src/stage/db";
import { openStageBlob } from "../src/store";
import { materializeCanonicalChanges } from "../src/stage/source";
import { retainedLineWindow } from "../src/stage/read";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE = sha(1), HEAD = sha(2), MERGE = sha(3);
const OLD = sha(10), NEW = sha(11), DOC = sha(12), BIN1 = sha(13), BIN2 = sha(14), SCRIPT = sha(15);
const blobs = new Map<string, Uint8Array>([
  [OLD, new TextEncoder().encode("export const value = 1;\n")],
  [NEW, new TextEncoder().encode("export const value = 2;\n")],
  [DOC, new TextEncoder().encode("# Reader\n\nPinned source.\n")],
  [BIN1, Uint8Array.from([0, 1, 2])],
  [BIN2, Uint8Array.from([0, 1, 3])],
  [SCRIPT, new TextEncoder().encode("#!/bin/sh\n")],
]);

function githubFixture(): GithubClient {
  return {
    getPull: async () => { throw new Error("unused"); },
    listCommits: async () => [], listFiles: async () => [], listReviewComments: async () => [],
    getFileAtSha: async () => { throw new Error("unused"); }, getPullDiff: async () => "",
    getRepository: async () => ({ id: 440, full_name: "Acme/Reader", default_branch: "main" }),
    getRef: async (_repo, ref) => ({ ref: `refs/heads/${ref}`, sha: ref === "main" ? BASE : HEAD, type: "commit" as const }),
    getTree: async (_repo, commit) => {
      const tree = commit === HEAD ? [
        { path: "src/value.ts", mode: "100644", type: "blob" as const, sha: NEW },
        { path: "docs/readme.md", mode: "100644", type: "blob" as const, sha: DOC },
        { path: "tests/data.bin", mode: "100644", type: "blob" as const, sha: BIN2 },
        { path: "scripts/run.sh", mode: "100755", type: "blob" as const, sha: SCRIPT },
      ] : [
        { path: "src/value.ts", mode: "100644", type: "blob" as const, sha: OLD },
        { path: "tests/data.bin", mode: "100644", type: "blob" as const, sha: BIN1 },
        { path: "scripts/run.sh", mode: "100644", type: "blob" as const, sha: SCRIPT },
      ];
      return { sha: commit, truncated: false, tree: tree.map((entry) => ({ ...entry, size: blobs.get(entry.sha)!.byteLength })) };
    },
    getBlobBytes: async (_repo, object) => blobs.get(object)!,
    compare: async () => ({ merge_base_commit: { sha: MERGE }, files: [
      { filename: "src/value.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n" },
      { filename: "docs/readme.md", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Reader\n+\n+Pinned source.\n" },
      { filename: "tests/data.bin", status: "modified", additions: 0, deletions: 0, changes: 0 },
      { filename: "scripts/run.sh", status: "modified", additions: 0, deletions: 0, changes: 0 },
    ] }),
    compareDiff: async () => [
      "diff --git a/src/value.ts b/src/value.ts", "--- a/src/value.ts", "+++ b/src/value.ts", "@@ -1,1 +1,1 @@", "-export const value = 1;", "+export const value = 2;", "",
      "diff --git a/docs/readme.md b/docs/readme.md", "new file mode 100644", "--- /dev/null", "+++ b/docs/readme.md", "@@ -0,0 +1,3 @@", "+# Reader", "+", "+Pinned source.", "",
    ].join("\n"),
  };
}

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let workspace: string;
let owner: string;
let key: string;
let cookie: string;
let capture: any;
let otherCapture: any;
let changeIds: string[];
let groupByChange: Map<string, string>;
let second: string;
let stranger: string;
let otherWorkspace: string;
let otherWorkspaceKey: string;
let sameSlugOtherCapture: any;

const apiHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
const sessionHeaders = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

function partition(captured: any): any[] {
  return [
    ...captured.incomplete.filter((item: any) => item.path === null).map((item: any) => ({ type: "material", id: item.id, description: "Capture material" })),
    ...captured.files.flatMap((file: any) => {
      const material = captured.incomplete.filter((item: any) => item.path === file.path);
      return [
        ...file.changes.map((change: any) => ({ type: "change", id: change.id, description: `Read ${file.path} with Array<T> intact` })),
        ...material.map((item: any) => ({ type: "material", id: item.id, description: `Account for ${file.path}` })),
        ...(file.changes.length === 0 && material.length === 0 ? [{ type: "file", id: file.id, description: `Structural change in ${file.path}` }] : []),
      ];
    }),
  ];
}

function validateResponse(operationId: string, body: unknown): void {
  const operation = Object.values((openApiSpec() as any).paths)
    .flatMap((path: any) => Object.values(path))
    .find((candidate: any) => candidate.operationId === operationId) as any;
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(operation.responses["200"].content["application/json"].schema);
  if (!validate(body)) throw new Error(ajv.errorsText(validate.errors));
}

async function createCapture(slug: string, idempotency: string, token = key): Promise<any> {
  setGithubClientFactory(() => githubFixture());
  const response = await fetch(`${base}/api/stage-captures`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idempotency },
    body: JSON.stringify({
      slug, repo: "Acme/Reader", branch: "feature/reader",
      builder: { intent: "Keep retained code readable.", context: "Phone and desktop use the same evidence.", agent: { name: "Builder", model: "build-model" } },
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  server = await startServer(); base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Stage reader", owner);
  key = mintApiKey(owner, workspace, "reader").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  second = tinyId("usr"); stranger = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, ?, ?)", [second, "second-reader@example.com", Date.now()]);
  db.run("INSERT INTO users VALUES (?, ?, ?)", [stranger, "stage-stranger@example.com", Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, second, Date.now()]);
  otherWorkspace = createWorkspace("Other stage reader", owner);
  otherWorkspaceKey = mintApiKey(owner, otherWorkspace, "other-reader").token;
  capture = await createCapture("reader-stage", "reader-capture");
  otherCapture = await createCapture("reader-other", "reader-other-capture");
  sameSlugOtherCapture = await createCapture("reader-stage", "reader-same-other", otherWorkspaceKey);
  const otherMembers = partition(sameSlugOtherCapture);
  const otherPublish = await fetch(`${base}/api/stages`, {
    method: "POST", headers: { authorization: `Bearer ${otherWorkspaceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ captureId: sameSlugOtherCapture.id, expectedPreviousVersion: 0, slug: "reader-stage", title: "Other reader", summary: "Other workspace.", witness: { name: "Witness", model: "review-model" }, groups: [{ id: "other", title: "Other", category: "Code", importance: "low", complexity: "low", explanation: "Other workspace.", examples: [], members: otherMembers }] }),
  });
  if (otherPublish.status !== 200) throw new Error(await otherPublish.text());
  const members = partition(capture);
  const changeMembers = members.filter((member: any) => member.type === "change");
  const implementationMembers = [
    ...[...changeMembers].reverse(),
    ...members.filter((member: any) => member.type !== "change" && member.description.includes("scripts/")),
  ];
  const implementationIds = new Set(implementationMembers.map((member: any) => member.id));
  const supportingMembers = members.filter((member: any) => !implementationIds.has(member.id));
  changeIds = changeMembers.map((member: any) => member.id);
  groupByChange = new Map(changeIds.map((id) => [id, "implementation"]));
  const response = await fetch(`${base}/api/stages`, {
    method: "POST", headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      captureId: capture.id, expectedPreviousVersion: 0, slug: capture.slug,
      title: "Read retained source", summary: "The witness accounts for every retained and unavailable leaf.",
      witness: { name: "Witness", model: "review-model" },
      groups: [
        { id: "implementation", title: "Implementation", category: "Code", importance: "high", complexity: "medium", explanation: "Read the implementation before its supporting material.", examples: [{ code: "Array<T>", text: "The identifier remains plain." }], members: implementationMembers },
        { id: "supporting-material", title: "Supporting material", category: "Test fixtures", importance: "medium", complexity: "low", explanation: "Docs and fixtures remain explicit.", examples: [], members: supportingMembers },
      ],
    }),
  });
  if (response.status !== 200) throw new Error(await response.text());
});

afterEach(() => setGithubClientFactory(offlineGithubClientFactory()));
afterAll(() => server.stop(true));

describe("stage reader", () => {
  test("serves the current and pinned member page entirely from retained storage", async () => {
    setGithubClientFactory(() => { throw new Error("GitHub must not be called while rendering"); });
    const current = await fetch(`${base}/${workspace}/st/${capture.slug}`, { headers: sessionHeaders() });
    const pinned = await fetch(`${base}/${workspace}/st/${capture.slug}/v/1`, { headers: sessionHeaders() });
    expect(current.status).toBe(200); expect(pinned.status).toBe(200);
    const body = await current.text();
    expect(body).toContain("Read retained source");
    expect(body).toContain("Builder<span> · build-model");
    expect(body).toContain("Witness<span> · review-model");
    expect(body).toContain("Implementation"); expect(body).toContain("Supporting material");
    expect(body).toContain("category-summary"); expect(body).toContain("data-tree-node");
    expect(body.match(/class="review-group-card"/g)?.length).toBe(2);
    expect(body.match(/data-focus-link data-review=/g)?.length).toBeGreaterThanOrEqual(2);
    const renderedBody = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
    expect(renderedBody).not.toContain("data-diff-frame");
    expect(renderedBody).not.toContain("class=\"hunk-review");
    expect(body).toContain("Binary bytes are retained"); expect(body).toContain("Only the file mode changed");
    expect(body).toContain("Array&lt;T&gt;"); expect(body).not.toContain("github.com");

    const implementationChange = changeIds.find((id) => groupByChange.get(id) === "implementation")!;
    const focusedResponse = await fetch(`${base}/${workspace}/st/${capture.slug}/v/1?review=implementation&change=${implementationChange}#${implementationChange}`, { headers: sessionHeaders() });
    expect(focusedResponse.status).toBe(200);
    const focused = await focusedResponse.text();
    const focusedContent = focused.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
    expect(focusedContent).toContain(`data-review="implementation"`);
    expect(focusedContent).not.toContain("data-stage-background");
    expect(focusedContent).not.toContain("review-group-card");
    expect(focusedContent).toContain("Read retained source · 01 · Code");
    expect(focused).toContain(`id="${implementationChange}" data-change="${implementationChange}"`);
    expect(focused).toContain("class=\"file-review\"");
    expect(focused).toContain("data-layout=\"unified\"");
    expect(focused).toContain("Mark as read"); expect(focused).toContain("Load file context");
    const withoutScripts = focused.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).toContain("diff-line add");
    expect(withoutScripts).toContain("read-form");
    expect(withoutScripts).toContain("focus-file-tree");
    expect(withoutScripts).toContain("Close group review");
    const focusTargets = [...focused.matchAll(/data-scroll-file="([^"]+)"/g)].map((match) => match[1]!);
    const focusIds = new Set([...focused.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    expect(focusTargets.every((target) => focusIds.has(target))).toBe(true);
    const treeCodeOrder = focusTargets.filter((target) => target.startsWith("review-file-"));
    const streamFileOrder = [...focused.matchAll(/<details class="file-review" id="([^"]+)"/g)].map((match) => match[1]);
    expect(streamFileOrder).toEqual(treeCodeOrder);
  });

  test("uses one private HTML refusal for malformed and missing pages", async () => {
    const wrongGroupChange = changeIds[0]!;
    const responses = await Promise.all([
      fetch(`${base}/${workspace}/st/not-here`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/st/${capture.slug}/v/01`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/st/${capture.slug}/v/1?review=not-a-group`, { headers: sessionHeaders() }),
      fetch(`${base}/${workspace}/st/${capture.slug}/v/1?review=supporting-material&change=${wrongGroupChange}`, { headers: sessionHeaders() }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(responses.map((response) => response.headers.get("cache-control"))).toEqual(["no-store", "no-store", "no-store", "no-store"]);
    expect(new Set(bodies).size).toBe(1);
  });

  test("refuses retained material that no longer reproduces persisted identity", async () => {
    const inventory = getStageCapture(capture.id, workspace)!;
    const load = async (digest: string) => {
      const object = await openStageBlob(workspace, digest);
      return object ? new Uint8Array(await new Response(object).arrayBuffer()) : null;
    };
    const materialized = await materializeCanonicalChanges(inventory, load);
    expect(materialized.map((item) => item.change.id)).toEqual(inventory.changes.map((change) => change.id));
    const asked: string[] = [];
    await materializeCanonicalChanges(inventory, async (digest) => { asked.push(digest); return load(digest); });
    expect(asked).toEqual([inventory.capture.patch_sha256!]);
    const corrupt = { ...inventory, changes: inventory.changes.map((change, index) => index === 0 ? { ...change, context_fingerprint: "wrong" } : change) };
    await expect(materializeCanonicalChanges(corrupt, load)).rejects.toThrow("does not reproduce");
    await expect(materializeCanonicalChanges(inventory, async () => null)).rejects.toThrow("missing");
  });

  test("bounds retained-line bytes as well as line count", () => {
    expect(retainedLineWindow(new TextEncoder().encode("one\ntwo\n"), 1, 1)).toEqual({ totalLines: 2, lines: ["one"], tooLarge: false });
    const giant = retainedLineWindow(new Uint8Array(512 * 1024 + 1).fill(97), 1, 1);
    expect(giant).toEqual({ totalLines: 1, lines: [], tooLarge: true });
  });

  test("reads bounded text through an exact version-owned opaque file id", async () => {
    const file = capture.files.find((candidate: any) => candidate.path === "src/value.ts");
    const response = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${file.id}?side=new&start=1&end=1`, { headers: apiHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json(); validateResponse("readStageFileLines", body);
    expect(body).toEqual({ fileId: file.id, path: "src/value.ts", side: "new", start: 1, end: 1, totalLines: 1, lines: [{ number: 1, text: "export const value = 2;" }] });
    const session = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${file.id}?side=old`, { headers: sessionHeaders({ authorization: "Bearer stale-token" }) });
    expect(session.status).toBe(200);
    const sameSlugFile = sameSlugOtherCapture.files.find((candidate: any) => candidate.path === "src/value.ts");
    const secondWorkspace = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${sameSlugFile.id}?side=new`, { headers: sessionHeaders() });
    expect(secondWorkspace.status).toBe(200);
    const wrongCaptureFile = otherCapture.files.find((candidate: any) => candidate.path === "src/value.ts");
    const refusal = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${wrongCaptureFile.id}?side=new`, { headers: apiHeaders() });
    const malformed = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/not-an-id?side=new`, { headers: apiHeaders() });
    expect(refusal.status).toBe(404); expect(await refusal.text()).toBe(await malformed.text());
    const tooWide = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${file.id}?side=new&start=1&end=401`, { headers: apiHeaders() });
    expect(tooWide.status).toBe(422);
    const binary = capture.files.find((candidate: any) => candidate.path === "tests/data.bin");
    const binaryRead = await fetch(`${base}/api/stages/${capture.slug}/v/1/files/${binary.id}?side=new`, { headers: apiHeaders() });
    expect(binaryRead.status).toBe(422);
  });

  test("keeps read state personal to a member and immutable version", async () => {
    const changeId = changeIds[0]!;
    const action = `${base}/${workspace}/st/${capture.slug}/v/1/changes/${changeId}/read`;
    const saved = await fetch(action, { method: "POST", headers: sessionHeaders({ origin: new URL(config.baseUrl).origin, accept: "application/json" }), body: new URLSearchParams({ read: "true" }) });
    expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ changeId, read: true });
    const groupId = groupByChange.get(changeId)!;
    const page = await (await fetch(`${base}/${workspace}/st/${capture.slug}/v/1?review=${groupId}&change=${changeId}`, { headers: sessionHeaders() })).text();
    expect(page).toContain(`data-change="${changeId}" data-read="true"`);

    expect(listStageReadChangeIds(workspace, getStageVersion(workspace, capture.slug, 1)!.id, second)).toEqual(new Set());

    const reversed = await fetch(action, { method: "POST", headers: sessionHeaders({ origin: new URL(config.baseUrl).origin }), body: new URLSearchParams({ read: "false" }), redirect: "manual" });
    expect(reversed.status).toBe(303);
    expect(reversed.headers.get("location")).toBe(`/${workspace}/st/${capture.slug}/v/1?review=${groupId}&change=${changeId}#${changeId}`);
    const foreign = await fetch(action, { method: "POST", headers: sessionHeaders({ origin: "https://elsewhere.example" }), body: new URLSearchParams({ read: "true" }) });
    expect(foreign.status).toBe(403);
  });

  test("keeps member pages, read state, line ids, and stale credentials private with auth enabled", async () => {
    const file = capture.files.find((candidate: any) => candidate.path === "src/value.ts");
    const otherFile = otherCapture.files.find((candidate: any) => candidate.path === "src/value.ts");
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "stage-reader-privacy.script.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AUTH_DISABLED: undefined as unknown as string,
        DATA_DIR: config.dataDir,
        STAGE_READER_WORKSPACE: workspace,
        STAGE_READER_SLUG: capture.slug,
        STAGE_READER_OWNER: owner,
        STAGE_READER_MEMBER: second,
        STAGE_READER_STRANGER: stranger,
        STAGE_READER_CHANGE: changeIds[0]!,
        STAGE_READER_GROUP: groupByChange.get(changeIds[0]!)!,
        STAGE_READER_FILE: file.id,
        STAGE_READER_OTHER_FILE: otherFile.id,
        STAGE_READER_KEY: key,
        STAGE_READER_OTHER_KEY: otherWorkspaceKey,
      },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    if (code !== 0) console.error(error);
    expect(code).toBe(0);
    expect(output).toContain("all assertions passed");
  });
});
