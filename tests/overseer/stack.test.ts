// A stack keeps the whole and every layer.
//
// Four pull requests on one branch chain are ingested exactly as task 5 ingests them, each
// gains its own witness account, and a stack groups them. Everything a member owns stays
// the member's: its revisions, its accounts, its reads. The stack pins order, publishes an
// immutable manifest per reading, and carries one account over a manifest that partitions
// every member account group exactly once.
//
// Nothing here opens a socket. The read router seam records which actor was opened and
// hands back a fixture client; rendering and paging tests install a GitHub factory that
// throws, so any call would fail the test rather than pass silently.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { sessionCookie } from "../../src/auth";
import { tinyId } from "../../src/ids";
import { createReviewVersion, ReviewSlugTaken } from "../../src/overseer/db";
import { openApiSpec } from "../../src/agent-discovery";
import { setGithubClientFactory, setReadRouter, type GithubReadSession, type ReadActor } from "../../src/overseer/github-app";
import { GithubError, type GithubClient, type GithubPull, type GithubPullStack, type GithubTreeEntry } from "../../src/overseer/github";
import { offlineGithubClientFactory, offlineReadRouter } from "../offline-github";
import { settleCaptureJobs, stopCaptureSweep } from "../../src/overseer/revision-jobs";
import { getLineage, getRevision, listRevisionReadChangeIds, setRevisionChangeRead } from "../../src/overseer/revision-db";
import { WEBHOOK_PATH, webhookSignature } from "../../src/overseer/webhook";
import { getStageCapture } from "../../src/stage/db";
import { getStack, getStackManifest, StackWriteError } from "../../src/overseer/stack-db";
import { normalizeInferredChain, normalizeNativeStack, recordStackObservation } from "../../src/overseer/stack-pr";
import { ingestPullRequest, PrIngestError } from "../../src/overseer/revision-pr";
import { stackPages, type StackUnit } from "../../src/overseer/stack-read";
import { CAPTURE_LEASE_MS } from "../../src/overseer/revision-jobs";
import { recoverStackRefreshJobs, settleStackRefreshJobs } from "../../src/overseer/stack-jobs";
import { MAX_STACK_PAGE_CHANGES, MAX_STACK_PAGE_HUNK_LINES, STACK_PAGE_HTML_MAX_BYTES, STACK_PAGE_HTML_TARGET_BYTES } from "../../src/overseer/stack-types";
import { goldenStoredDoc } from "./fixtures/stored-review";
import { evidenceSeams } from "../../src/overseer/revision-read";

// ---- the repository: one trunk, several branch chains ----

const sha = (n: number) => n.toString(16).padStart(40, "0");
const REPO = "Acme/Stack";
const REPO_ID = 770;
const OTHER_REPO = "Acme/Other";
const OTHER_REPO_ID = 771;
const INSTALLATION = 7100;
const MAIN = sha(0x1000);

const enc = (value: string) => new TextEncoder().encode(value);
const blobs = new Map<string, Uint8Array>();
let nextObject = 0x20000;
function blob(text: string): string {
  const id = sha(nextObject++);
  blobs.set(id, enc(text));
  return id;
}

interface ChainPr {
  number: number;
  headRef: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  /** Files at the head, path → object id. */
  tree: Record<string, string>;
  /** Files at the base, path → object id. */
  baseTree: Record<string, string>;
  files: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
  repo?: string;
  repoId?: number;
}

const SHARED_V0 = blob("export const shared = 0;\n");
const prs = new Map<number, ChainPr>();
const trees: Record<string, GithubTreeEntry[]> = {};

function entryOf(path: string, object: string): GithubTreeEntry {
  return { path, mode: "100644", type: "blob", sha: object, size: blobs.get(object)!.byteLength };
}

function registerTree(commit: string, tree: Record<string, string>): void {
  trees[commit] = Object.entries(tree).map(([path, object]) => entryOf(path, object));
}
registerTree(MAIN, { "src/shared.ts": SHARED_V0 });

/**
 * One chain of pull requests off `main`. Each layer changes `src/shared.ts` (the same line,
 * so one path is touched by every layer) and adds its own `src/<ref>.ts`, so every member
 * has two canonical changes and the tree can prove "4 layers" on one path.
 */
function chain(numbers: number[], refPrefix: string, options: { repo?: string; repoId?: number; extra?: (index: number) => { path: string; text: string }[] } = {}): ChainPr[] {
  let baseSha = MAIN;
  let baseRef = "main";
  let tree: Record<string, string> = { "src/shared.ts": SHARED_V0 };
  const out: ChainPr[] = [];
  numbers.forEach((number, index) => {
    const headRef = `${refPrefix}${index + 1}`;
    const headSha = sha(0x3000 + number);
    const sharedBefore = tree["src/shared.ts"]!;
    const shared = blob(`export const shared = ${refPrefix}${index + 1};\n`);
    const own = blob(`export const ${refPrefix}${index + 1} = true;\n`);
    const nextTree = { ...tree, "src/shared.ts": shared, [`src/${headRef}.ts`]: own };
    const files = [
      { filename: "src/shared.ts", status: "modified", additions: 1, deletions: 1, patch: `@@ -1,1 +1,1 @@\n-${new TextDecoder().decode(blobs.get(sharedBefore)!).trimEnd()}\n+export const shared = ${refPrefix}${index + 1};\n` },
      { filename: `src/${headRef}.ts`, status: "added", additions: 1, deletions: 0, patch: `@@ -0,0 +1,1 @@\n+export const ${refPrefix}${index + 1} = true;\n` },
    ];
    for (const extra of options.extra?.(index) ?? []) {
      const lines = extra.text.split("\n").filter(() => true);
      const count = extra.text.endsWith("\n") ? lines.length - 1 : lines.length;
      nextTree[extra.path] = blob(extra.text);
      files.push({ filename: extra.path, status: "added", additions: count, deletions: 0, patch: `@@ -0,0 +1,${count} @@\n${extra.text.trimEnd().split("\n").map((line) => `+${line}`).join("\n")}\n` });
    }
    registerTree(headSha, nextTree);
    const pr: ChainPr = { number, headRef, baseRef, baseSha, headSha, tree: nextTree, baseTree: tree, files, ...(options.repo ? { repo: options.repo, repoId: options.repoId } : {}) };
    prs.set(number, pr);
    out.push(pr);
    baseSha = headSha;
    baseRef = headRef;
    tree = nextTree;
  });
  return out;
}

/** `count` separated one-line changes in one file: a member group wider than a page. */
function wideText(count: number, version: number): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(`export const w${index} = ${version};`);
    for (let pad = 0; pad < 8; pad++) lines.push(`// pad ${index}-${pad}`);
  }
  return `${lines.join("\n")}\n`;
}

const MAIN_CHAIN = chain([11, 12, 13, 14], "l");
const NATIVE_CHAIN = chain([21, 22, 23], "n");
const USER_CHAIN = chain([61, 62], "u");
const ADDITION_CHAIN = chain([71, 72, 73], "a");
const OWNERSHIP_CHAIN = chain([81, 82, 83], "x");
const MATERIAL_CHAIN = chain([91, 92], "m");
const DETACH_CHAIN = chain([111, 112, 113], "d");
const NATIVE_MIDDLE_DROP_CHAIN = chain([121, 122, 123], "q");
const NATIVE_MERGED_DROP_CHAIN = chain([131, 132, 133], "g");
const OTHER_CHAIN = chain([31], "o", { repo: OTHER_REPO, repoId: OTHER_REPO_ID });
// A fork of the main chain: based on l1, beside l2.
const FORK = (() => {
  const l1 = prs.get(11)!;
  const own = blob("export const fork = true;\n");
  const shared = blob("export const shared = fork;\n");
  const tree = { ...l1.tree, "src/shared.ts": shared, "src/fork.ts": own };
  const headSha = sha(0x3000 + 41);
  registerTree(headSha, tree);
  const pr: ChainPr = {
    number: 41, headRef: "fork1", baseRef: "l1", baseSha: l1.headSha, headSha, tree, baseTree: l1.tree,
    files: [
      { filename: "src/shared.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,1 +1,1 @@\n-export const shared = l1;\n+export const shared = fork;\n" },
      { filename: "src/fork.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+export const fork = true;\n" },
    ],
  };
  prs.set(41, pr);
  return pr;
})();
// The budget chain: 101 separated hunks in one file, then one hunk far over the line bound.
const WIDE_COUNT = MAX_STACK_PAGE_CHANGES + 1;
const BIG_LINES = MAX_STACK_PAGE_HUNK_LINES + 100;
const MAIN_WIDE = sha(0x1001);
const BUDGET_CHAIN = (() => {
  const wideOld = wideText(WIDE_COUNT, 0);
  const wideNew = wideText(WIDE_COUNT, 1);
  const wideOldId = blob(wideOld);
  const wideNewId = blob(wideNew);
  // Its own trunk commit, so the main chain's base tree is untouched.
  registerTree(MAIN_WIDE, { "src/shared.ts": SHARED_V0, "src/wide.ts": wideOldId });
  const bigText = `${Array.from({ length: BIG_LINES }, (_, index) => `export const big${index} = ${index};`).join("\n")}\n`;
  const out = chain([51, 52], "b", {
    extra: (index) => index === 1 ? [{ path: "src/big.ts", text: bigText }] : [],
  });
  const first = out[0]!;
  first.baseSha = MAIN_WIDE;
  first.baseTree["src/wide.ts"] = wideOldId;
  first.tree["src/wide.ts"] = wideNewId;
  trees[first.headSha] = Object.entries(first.tree).map(([path, object]) => entryOf(path, object));
  const hunks: string[] = [];
  for (let index = 0; index < WIDE_COUNT; index++) {
    const line = index * 9 + 1;
    hunks.push(`@@ -${line},1 +${line},1 @@\n-export const w${index} = 0;\n+export const w${index} = 1;\n`);
  }
  first.files.push({ filename: "src/wide.ts", status: "modified", additions: WIDE_COUNT, deletions: WIDE_COUNT, patch: hunks.join("") });
  const second = out[1]!;
  second.baseTree["src/wide.ts"] = wideNewId;
  second.tree["src/wide.ts"] = wideNewId;
  trees[second.headSha] = Object.entries(second.tree).map(([path, object]) => entryOf(path, object));
  return out;
})();

function pullOf(pr: ChainPr, overrides: Partial<{ merged: boolean; state: string; title: string; updated_at: string }> = {}): GithubPull {
  const repo = { id: pr.repoId ?? REPO_ID, full_name: pr.repo ?? REPO };
  return {
    number: pr.number,
    title: overrides.title ?? `Layer #${pr.number}`,
    body: null,
    state: overrides.state ?? "open",
    draft: false,
    merged: overrides.merged ?? false,
    user: null,
    head: { sha: pr.headSha, ref: pr.headRef, repo },
    base: { sha: pr.baseSha, ref: pr.baseRef, repo },
    updated_at: overrides.updated_at ?? "2026-06-01T10:00:00Z",
  };
}

function diffOf(pr: ChainPr): string {
  return pr.files.map((file) => [`diff --git a/${file.filename} b/${file.filename}`, `--- ${file.status === "added" ? "/dev/null" : `a/${file.filename}`}`, `+++ b/${file.filename}`, file.patch.trimEnd(), ""].join("\n")).join("\n");
}

let pullOverrides = new Map<number, Partial<{ merged: boolean; state: string; title: string; updated_at: string }>>();
let stacks = new Map<number, GithubPullStack | (() => never)>();
let pullStackCalls = 0;

function fixtureClient(): GithubClient {
  return {
    async getPull(_repo, number) {
      const pr = prs.get(number);
      if (!pr) throw new GithubError(`no fixture pull ${number}`, 404, "");
      return pullOf(pr, pullOverrides.get(number));
    },
    async listCommits() { return []; },
    async listFiles() { return []; },
    async listReviewComments() { return []; },
    async getFileAtSha() { throw new Error("unused"); },
    async getPullDiff() { return ""; },
    async getRepository(repo) { return repo === OTHER_REPO ? { id: OTHER_REPO_ID, full_name: OTHER_REPO, default_branch: "main" } : { id: REPO_ID, full_name: REPO, default_branch: "main" }; },
    async getRef(_repo, ref) {
      const pr = [...prs.values()].find((candidate) => candidate.headRef === ref);
      return { ref: `refs/heads/${ref}`, sha: ref === "main" ? MAIN : pr?.headSha ?? MAIN, type: "commit" as const };
    },
    async getTree(_repo, commit) { return { sha: commit, truncated: false, tree: trees[commit] ?? [] }; },
    async getBlobBytes(_repo, object) {
      const bytes = blobs.get(object);
      if (!bytes) throw new GithubError(`no fixture blob ${object}`, 404, "");
      return bytes;
    },
    async compare(_repo, base, head) {
      const pr = [...prs.values()].find((candidate) => candidate.headSha === head);
      if (!pr) throw new GithubError(`no fixture comparison for ${head}`, 404, "");
      return { merge_base_commit: { sha: base }, files: pr.files.map((file) => ({ ...file, changes: file.additions + file.deletions })) };
    },
    async compareDiff(_repo, _base, head) {
      const pr = [...prs.values()].find((candidate) => candidate.headSha === head)!;
      return diffOf(pr);
    },
    async getPullStack(_repo, number) {
      pullStackCalls += 1;
      const direct = stacks.get(number);
      if (typeof direct === "function") return direct();
      if (direct !== undefined) return direct;
      // GitHub answers the same stack whichever member is asked about.
      for (const stack of stacks.values()) {
        if (typeof stack !== "function" && stack && stack.pullRequests.some((entry) => entry.number === number)) return stack;
      }
      return null;
    },
  };
}

// ---- the read router seam ----

let opened: ReadActor[] = [];
let resolvedActor: ReadActor = { kind: "installation", installationId: INSTALLATION };

function installRouter(): void {
  setReadRouter({
    async resolve() { return resolvedActor; },
    async open(_workspaceId, actor) { opened.push(actor); return fixtureClient(); },
  });
}

// ---- fixtures ----

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let second = "";
let key = "";
let secondKey = "";
let cookie = "";
let secondCookie = "";
let otherWorkspace = "";
let otherKey = "";
let moves = 0;

/** Push a new head on one pull request: the shared line changes again. */
function moveHead(number: number, marker: string): void {
  const pr = prs.get(number)!;
  moves += 1;
  const shared = blob(`export const shared = ${marker};\n`);
  const tree = { ...pr.tree, "src/shared.ts": shared };
  const headSha = sha(0x4000 + number + moves * 0x100);
  registerTree(headSha, tree);
  const before = new TextDecoder().decode(blobs.get(pr.baseTree["src/shared.ts"]!)!).trimEnd();
  pr.headSha = headSha;
  pr.tree = tree;
  pr.files = pr.files.map((file) => file.filename === "src/shared.ts" ? { ...file, patch: `@@ -1,1 +1,1 @@\n-${before}\n+export const shared = ${marker};\n` } : file);
  pullOverrides.set(number, { ...(pullOverrides.get(number) ?? {}), updated_at: `2026-06-10T10:${String(moves).padStart(2, "0")}:00Z` });
}

async function refreshMember(slug: string, idempotency: string): Promise<void> {
  const response = await fetch(`${base}/api/review-lineages/${slug}/refresh`, { method: "POST", headers: jsonHeaders(key, idempotency) });
  if (response.status !== 200) throw new Error(`refresh ${slug}: ${response.status} ${await response.text()}`);
  await settleCaptureJobs();
}

const jsonHeaders = (token = key, idempotency?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...(idempotency === undefined ? {} : { "idempotency-key": idempotency }),
});

function validateResponse(operationId: string, body: unknown, status = "200"): void {
  const operation = Object.values((openApiSpec() as any).paths)
    .flatMap((path: any) => Object.values(path))
    .find((candidate: any) => candidate.operationId === operationId) as any;
  if (!operation) throw new Error(`no operation ${operationId} in the served document`);
  const schema = operation.responses[status]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`no ${status} schema for ${operationId}`);
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(body)) throw new Error(`${operationId}: ${ajv.errorsText(validate.errors)}`);
}

function visible(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
}

function count(sql: string, ...params: (string | number)[]): number {
  return db.query<{ n: number }, (string | number)[]>(sql).get(...params)!.n;
}

async function ingest(number: number, slug: string, token = key): Promise<void> {
  const pr = prs.get(number)!;
  const response = await fetch(`${base}/api/pull-request-review-lineages`, {
    method: "POST", headers: jsonHeaders(token, `ingest-${slug}`), body: JSON.stringify({ repo: pr.repo ?? REPO, number, slug }),
  });
  if (response.status !== 202 && response.status !== 200) throw new Error(`ingest ${slug}: ${response.status} ${await response.text()}`);
  await settleCaptureJobs();
  const lineage = getLineage(workspace, slug);
  if (!lineage || lineage.latest_revision === null) throw new Error(`ingest ${slug}: no revision`);
}

/** Two account groups per member: the shared-line change, and everything else. */
function memberGroups(slug: string, revision = 1): unknown[] {
  const row = getRevision(workspace, slug, revision)!;
  const inventory = getStageCapture(row.capture_id, workspace)!;
  const shared = inventory.files.find((file) => file.path === "src/shared.ts");
  const sharedChanges = inventory.changes.filter((change) => change.file_id === shared?.id);
  const rest = inventory.changes.filter((change) => change.file_id !== shared?.id);
  const leaf = inventory.files.filter((file) => !inventory.changes.some((change) => change.file_id === file.id) && !inventory.incomplete.some((item) => item.path === file.path));
  return [
    { id: "shared", title: "Shared line", category: "Code", importance: "medium", complexity: "low", explanation: "The line every layer moves.", examples: [], members: sharedChanges.map((change) => ({ type: "change", id: change.id, description: "Shared moved" })) },
    { id: "own", title: "Own file", category: "Code", importance: "low", complexity: "low", explanation: "What this layer adds.", examples: [], members: [
      ...rest.map((change) => ({ type: "change", id: change.id, description: "Added here" })),
      ...inventory.incomplete.map((item) => ({ type: "material", id: item.id, description: "Missing here" })),
      ...leaf.map((file) => ({ type: "file", id: file.id, description: "Structural" })),
    ] },
  ].filter((group) => (group.members as unknown[]).length > 0);
}

async function publishMemberAccount(slug: string, revision = 1, token = key): Promise<Response> {
  return fetch(`${base}/api/review-lineages/${slug}/revisions/${revision}/accounts`, {
    method: "POST", headers: jsonHeaders(token),
    body: JSON.stringify({ witness: { name: "Witness", model: "review-model" }, summary: `Account of ${slug}.`, groups: memberGroups(slug, revision) }),
  });
}

async function createStack(body: unknown, idempotency: string, token = key): Promise<Response> {
  return fetch(`${base}/api/review-stacks`, { method: "POST", headers: jsonHeaders(token, idempotency), body: JSON.stringify(body) });
}

async function readStack(slug: string, headers: Record<string, string> = { authorization: `Bearer ${key}` }): Promise<any> {
  return (await fetch(`${base}/api/review-stacks/${slug}`, { headers })).json();
}

/** A stack account that references every pinned member group, in the required order. */
function stackAccountBody(manifest: any, overrides: Partial<{ groups: unknown[] }> = {}): unknown {
  const pinned = manifest.members.filter((member: any) => member.status !== "removed");
  const shared = pinned.map((member: any) => ({ lineageId: member.lineageId, revision: member.revision, accountVersion: member.accountVersion, groupId: "shared" }));
  const own = pinned.map((member: any) => ({ lineageId: member.lineageId, revision: member.revision, accountVersion: member.accountVersion, groupId: "own" }));
  return {
    witness: { name: "Stack witness", model: "stack-model" },
    summary: "The stack moves one shared line and adds one file per layer.",
    groups: overrides.groups ?? [
      { id: "shared-line", title: "One line, every layer", body: "Each layer moves the same line.", examples: [], members: shared },
      { id: "own-files", title: "One file per layer", body: "Each layer adds its own file.", attention: "Files never overlap.", examples: [], members: own },
    ],
  };
}

async function publishStackAccount(slug: string, version: number, body: unknown, token = key): Promise<Response> {
  return fetch(`${base}/api/review-stacks/${slug}/manifests/${version}/account`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
}

async function refreshStack(slug: string, idempotency: string, token = key): Promise<Response> {
  const response = await fetch(`${base}/api/review-stacks/${slug}/refresh`, { method: "POST", headers: jsonHeaders(token, idempotency) });
  if (response.status >= 500 || (response.status === 422 && !idempotency.includes("expect-422"))) console.error(`refresh ${slug}: ${response.status} ${await response.clone().text()}`);
  return response;
}

function deliver(payload: unknown, deliveryId: string): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${base}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": deliveryId, "x-hub-signature-256": webhookSignature(config.githubApp.webhookSecret, body) },
    body,
  });
}

function deliveryPayload(number: number, action: string, updatedAt: string, stack: unknown | undefined, overrides: Partial<{ state: string; merged: boolean; baseRef: string; baseSha: string }> = {}): unknown {
  const pr = prs.get(number)!;
  const repo = { id: REPO_ID, full_name: REPO };
  return {
    action,
    installation: { id: INSTALLATION },
    repository: repo,
    pull_request: {
      number, title: `Layer #${number}`, state: overrides.state ?? "open", merged: overrides.merged ?? false, draft: false, updated_at: updatedAt,
      base: { ref: overrides.baseRef ?? pr.baseRef, sha: overrides.baseSha ?? pr.baseSha, repo }, head: { ref: pr.headRef, sha: pr.headSha, repo },
      ...(stack === undefined ? {} : { stack }),
    },
  };
}

function changeIdsOf(page: string): string[] {
  return [...page.matchAll(/<(?:article class="hunk-review[^"]*" id|li data-(?:change|item))="(l[0-9]+-chg_[a-f0-9]{64})"/g)].map((match) => match[1]!);
}

function fallbackLinks(page: string): { id: string; kind: "change" | "material" | "file"; href: string }[] {
  return [...page.matchAll(/<li data-item="([^"]+)" data-kind="(change|material|file)"><a href="([^"]+)"/g)]
    .map((match) => ({ id: match[1]!, kind: match[2]! as "change" | "material" | "file", href: match[3]!.replaceAll("&amp;", "&") }));
}

async function markRead(slug: string, version: number, position: number, changeId: string, read: boolean, who = cookie): Promise<Response> {
  return fetch(`${base}/${workspace}/r-stacks/${slug}/v/${version}/m/${position}/changes/${changeId}/read`, {
    method: "POST",
    headers: { cookie: who, origin: new URL(config.baseUrl).origin, accept: "application/json" },
    body: new URLSearchParams({ read: String(read) }),
  });
}

function throwingGithub(): void {
  setGithubClientFactory(() => { throw new Error("GitHub must not be called while reading a stack"); });
  setReadRouter({
    async resolve() { throw new Error("GitHub must not be resolved while reading a stack"); },
    async open() { throw new Error("GitHub must not be opened while reading a stack"); },
  });
}

const nativeStack: GithubPullStack = {
  id: 501, number: 9, baseRef: "main", open: true,
  pullRequests: NATIVE_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
};

beforeAll(async () => {
  server = await startServer();
  stopCaptureSweep();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Stacked reviews", owner);
  key = mintApiKey(owner, workspace, "stacker").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  second = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, ?, ?)", [second, "stack-second@example.com", Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, second, Date.now()]);
  secondKey = mintApiKey(second, workspace, "stacker-second").token;
  secondCookie = sessionCookie(second).split(";")[0]!;
  db.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at, created_at) VALUES (?, ?, ?, 'Acme', 1, 'Organization', 'all', ?, ?, ?)",
    [tinyId("ghi"), workspace, INSTALLATION, owner, Date.now(), Date.now()],
  );
  installRouter();
  otherWorkspace = createWorkspace("Other stacks", owner);
  otherKey = mintApiKey(owner, otherWorkspace, "other-stacker").token;
  for (const pr of [...MAIN_CHAIN, ...NATIVE_CHAIN, ...OTHER_CHAIN, FORK, ...BUDGET_CHAIN, ...USER_CHAIN, ...ADDITION_CHAIN, ...OWNERSHIP_CHAIN, ...MATERIAL_CHAIN, ...DETACH_CHAIN, ...NATIVE_MIDDLE_DROP_CHAIN, ...NATIVE_MERGED_DROP_CHAIN]) await ingest(pr.number, `pr-${pr.number}`);
});

afterEach(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  resolvedActor = { kind: "installation", installationId: INSTALLATION };
  opened = [];
  pullOverrides = new Map();
  stacks = new Map();
  stopCaptureSweep();
  installRouter();
});

afterAll(async () => {
  stopCaptureSweep();
  await settleCaptureJobs();
  await settleStackRefreshJobs();
  setReadRouter(offlineReadRouter());
  server.stop(true);
});

// ---- proof 1 and 2: normalization and refusals ----

describe("normalizing a chain", () => {
  test("the inferred and native readings of one chain pin byte-equal members and differ only in provenance", async () => {
    const inferred = normalizeInferredChain(workspace, ["pr-11", "pr-12", "pr-13", "pr-14"]);
    stacks.set(12, { id: 900, number: 4, baseRef: "main", open: true, pullRequests: MAIN_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })) });
    const session: GithubReadSession = { actor: { kind: "installation", installationId: INSTALLATION }, client: fixtureClient() };
    const native = await normalizeNativeStack(workspace, getLineage(workspace, "pr-12")!, session);
    expect(JSON.stringify(native.members)).toBe(JSON.stringify(inferred.members));
    expect(inferred.members.map((member) => member.lineageSlug)).toEqual(["pr-11", "pr-12", "pr-13", "pr-14"]);
    expect(inferred.members.map((member) => [member.baseRef, member.headRef])).toEqual([["main", "l1"], ["l1", "l2"], ["l2", "l3"], ["l3", "l4"]]);
    expect(inferred.source).toBe("inferred");
    expect(native.source).toBe("native");
    expect(native.provider.stackNumber).toBe(4);
    expect(inferred.provider.stackNumber).toBeNull();
    // Chain facts come from Seer's observations: no member's base ref was taken from GitHub's listing.
    expect(inferred.members.every((member) => member.accountId === null)).toBe(true);
  });

  test("every malformed chain is refused by name", async () => {
    const refuse = (slugs: string[], rule: string, member: string): void => {
      let caught: unknown;
      try { normalizeInferredChain(workspace, slugs); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(StackWriteError);
      const error = caught as StackWriteError;
      expect(error.status).toBe(422);
      expect(error.message).toContain(`[${rule}]`);
      expect(error.message).toContain(`"${member}"`);
    };
    refuse(["pr-11", "pr-31"], "cross-repository", "pr-31");
    refuse(["pr-11", "pr-12", "pr-41"], "fork", "pr-41");
    refuse(["pr-11", "nobody"], "no-lineage", "nobody");
    refuse(["pr-11", "pr-11"], "duplicate", "pr-11");
    refuse(["pr-11", "pr-21"], "fan", "pr-21");
    refuse(["pr-12", "pr-11"], "cycle", "pr-11");
    refuse(["pr-11", "pr-13"], "broken-chain", "pr-13");
    refuse(["pr-11"], "too-few-members", "pr-11");
    refuse(Array.from({ length: 17 }, (_, index) => `x-${index}`), "too-many-members", "x-16");

    // No pull request: a branch-first lineage that never named one.
    const { captureSource } = await import("../../src/stage/source");
    const captured = await captureSource(workspace, { slug: "branch-only", repo: REPO, branch: "l1" }, { client: fixtureClient(), idempotencyKey: "branch-only-capture" });
    const created = await fetch(`${base}/api/review-lineages`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ captureId: captured.captureId, slug: "branch-only", title: "Branch only" }) });
    expect(created.status).toBe(200);
    refuse(["branch-only", "pr-12"], "no-pull-request", "branch-only");

    // No revision: a shell whose capture has not completed.
    db.run(
      "INSERT INTO review_lineages (id, workspace_id, slug, repo, repo_id, branch, original_base_ref, original_base_sha, title, latest_revision, latest_account_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, 'shell-only', ?, ?, 'l9', 'main', ?, 'Shell', NULL, NULL, ?, 'key_x', 1, 1)",
      ["rln_shellonly0", workspace, REPO, REPO_ID, MAIN, owner],
    );
    db.run(
      "INSERT INTO review_lineage_prs (lineage_id, workspace_id, slug, repo_id, repo, pr_number, head_ref, base_ref, actor_kind, installation_id, user_id, credential_id, attached_at, detached_at) VALUES ('rln_shellonly0', ?, 'shell-only', ?, ?, 99, 'l9', 'main', 'installation', ?, NULL, NULL, 1, NULL)",
      [workspace, REPO_ID, REPO, INSTALLATION],
    );
    db.run(
      "INSERT INTO review_pr_observations (id, workspace_id, lineage_id, repo_id, repo, pr_number, title, state, merged, draft, base_ref, base_sha, head_ref, head_sha, merge_base_sha, github_updated_at, observed_at, actor_kind, installation_id, user_id, credential_id, digest) VALUES ('pob_shellonly0', ?, 'rln_shellonly0', ?, ?, 99, 'Shell', 'open', 0, 0, 'main', ?, 'l9', ?, NULL, 1, 1, 'installation', ?, NULL, NULL, 'shell-digest')",
      [workspace, REPO_ID, REPO, MAIN, sha(0x3099), INSTALLATION],
    );
    refuse(["shell-only", "pr-12"], "no-revision", "shell-only");

    // Native: two stacks for one pull request, and a native member no lineage reviews.
    const session: GithubReadSession = { actor: { kind: "installation", installationId: INSTALLATION }, client: fixtureClient() };
    stacks.set(22, () => { throw new GithubError("GitHub returned two stacks for one pull request at x", 0, "x"); });
    await expect(normalizeNativeStack(workspace, getLineage(workspace, "pr-22")!, session)).rejects.toThrow(/\[ambiguous-native\]/);
    stacks.set(22, { ...nativeStack, pullRequests: [...nativeStack.pullRequests, { number: 77, state: "open", draft: false, mergedAt: null, headRef: "n4", headSha: sha(0x3077) }] });
    await expect(normalizeNativeStack(workspace, getLineage(workspace, "pr-22")!, session)).rejects.toThrow(/\[unresolved-native-member\]/);
    stacks.set(22, null as unknown as GithubPullStack);
    await expect(normalizeNativeStack(workspace, getLineage(workspace, "pr-22")!, session)).rejects.toThrow(/\[no-native-stack\]/);
  });
});

// ---- creation, evidence, and the account-ready successor ----

describe("a stack over four members", () => {
  test("creating an inferred stack publishes manifest 1 with no witness request, and replays", async () => {
    const body = { slug: "stack-a", title: "The whole chain", members: ["pr-11", "pr-12", "pr-13", "pr-14"] };
    const responses = await Promise.all(Array.from({ length: 4 }, () => createStack(body, "stack-a-create")));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses[statuses.length - 1]).toBe(201);
    expect(statuses.every((status) => status === 200 || status === 201)).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.json() as any));
    validateResponse("createReviewStack", bodies.find((entry: any) => entry.latestManifestVersion === 1), "201");
    expect(new Set(bodies.map((entry: any) => entry.id)).size).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_stacks WHERE workspace_id = ?", workspace)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_manifests WHERE workspace_id = ?", workspace)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_witness_requests WHERE workspace_id = ?", workspace)).toBe(0);
    const view = bodies[0] as any;
    expect(view.source).toBe("inferred");
    expect(view.manifest.document.members.map((member: any) => member.lineageSlug)).toEqual(["pr-11", "pr-12", "pr-13", "pr-14"]);
    expect(view.manifest.witness).toBeNull();
    expect(view.manifest.progress).toBeNull();
    expect(view.members.every((member: any) => member.live)).toBe(true);

    // A different body under the same key is a conflict; a member already stacked is refused.
    expect((await createStack({ ...body, title: "Other" }, "stack-a-create")).status).toBe(409);
    const again = await createStack({ slug: "stack-dup", members: ["pr-11", "pr-12"] }, "stack-dup-create");
    expect(again.status).toBe(422);
    expect((await again.json() as any).error).toContain("already a member of stack \"stack-a\"");
    // And every other slug owner refuses the name.
    expect((await createStack({ slug: "pr-11", members: ["pr-21", "pr-22"] }, "stack-slugclash")).status).toBe(409);
    createReviewVersion(workspace, "legacy-stack-owner", goldenStoredDoc());
    expect((await createStack({ slug: "legacy-stack-owner", members: ["pr-21", "pr-22"] }, "stack-legacy-slugclash")).status).toBe(409);
  });

  test("legacy, branch-first, and pull-request-first writers cannot take a stack slug", async () => {
    expect(() => createReviewVersion(workspace, "stack-a", goldenStoredDoc())).toThrow(ReviewSlugTaken);

    const { captureSource } = await import("../../src/stage/source");
    const captured = await captureSource(workspace, { slug: "reverse-branch-slug", repo: REPO, branch: "n1" }, {
      client: fixtureClient(),
      idempotencyKey: "reverse-branch-slug-capture",
    });
    const branchFirst = await fetch(`${base}/api/review-lineages`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ captureId: captured.captureId, slug: "stack-a", title: "Cannot steal stack" }),
    });
    expect(branchFirst.status).toBe(409);
    expect((await branchFirst.json() as any).error).toContain("review stack");

    const pr = prs.get(21)!;
    const prFirst = await fetch(`${base}/api/pull-request-review-lineages`, {
      method: "POST",
      headers: jsonHeaders(key, "reverse-pr-route-slug"),
      body: JSON.stringify({ repo: REPO, number: pr.number, slug: "stack-a" }),
    });
    expect(prFirst.status).toBe(409);
    expect((await prFirst.json() as any).error).toContain("review stack");

    // Call the transaction directly too. This is the recheck after any preflight and
    // provider read, where a stack created during that gap must still win the slug.
    expect(() => ingestPullRequest({
      workspaceId: workspace,
      userId: owner,
      keyId: "key_reverse",
      operation: "create",
      idempotencyKey: "reverse-pr-slug",
      requestHash: "reverse-pr-slug-hash",
      slug: "stack-a",
      title: "Cannot steal stack",
      projects: [],
      actor: { kind: "installation", installationId: INSTALLATION },
      facts: {
        repoId: REPO_ID, repo: REPO, number: pr.number, title: `Layer #${pr.number}`,
        state: "open", merged: false, draft: false, baseRef: pr.baseRef, baseSha: pr.baseSha,
        headRef: pr.headRef, headSha: pr.headSha, mergeBaseSha: MAIN, githubUpdatedAt: 1,
      },
      legacyOwnsSlug: () => false,
    })).toThrow(PrIngestError);
    expect(getLineage(workspace, "stack-a")).toBeNull();
  });

  test("the evidence-only manifest reads every member while member witnesses are pending", async () => {
    throwingGithub();
    const page = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a`, { headers: { cookie } })).text());
    expect(page).toContain("The whole chain");
    expect(page).toContain("Manifest 1");
    for (const number of [11, 12, 13, 14]) expect(page).toContain(`#${number} Layer #${number}`);
    expect(page).toContain("witness pending");
    expect(page).toContain("awaiting member accounts #11, #12, #13, #14");
    // Evidence seams, one member's at a time, namespaced by position.
    expect(page).toContain('data-group="l1-seam-1"');
    expect(page).toContain('data-group="l4-seam-1"');
    expect(page).toContain("PR #12 · ");
    const focus = await fetch(`${base}/${workspace}/r-stacks/stack-a/v/1?review=l2-seam-1`, { headers: { cookie } });
    expect(focus.status).toBe(200);
    expect(focus.headers.get("x-seer-page-count")).toBe("1");
    const dialog = visible(await focus.text());
    expect(dialog).toContain('data-change="l2-chg_');
    expect(dialog).not.toContain('data-change="l1-chg_');
    expect(dialog).toContain('data-layer=""');
  });

  test("the first time every member has an account, exactly one account-ready successor and one request appear — under eight concurrent final publications", async () => {
    for (const slug of ["pr-11", "pr-12", "pr-13"]) expect((await publishMemberAccount(slug)).status).toBe(200);
    expect(getStack(workspace, "stack-a")!.latest_manifest_version).toBe(1);
    const responses = await Promise.all(Array.from({ length: 8 }, () => publishMemberAccount("pr-14")));
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    const stack = getStack(workspace, "stack-a")!;
    expect(stack.latest_manifest_version).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_manifests WHERE stack_id = ?", stack.id)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_witness_requests WHERE stack_id = ?", stack.id)).toBe(1);
    const manifest = getStackManifest(workspace, "stack-a", 2)!;
    expect(manifest.reason).toBe("account-ready");
    expect(manifest.predecessor_version).toBe(1);
    expect(manifest.doc.members.every((member) => member.accountId !== null && member.accountVersion === 1)).toBe(true);
    // Manifest 1 is what it was.
    const first = getStackManifest(workspace, "stack-a", 1)!;
    expect(first.doc.members.every((member) => member.accountId === null)).toBe(true);

    const view = await readStack("stack-a");
    validateResponse("readReviewStack", view);
    expect(view.manifest.witness.state).toBe("pending");
    expect(view.manifests.map((row: any) => [row.version, row.reason])).toEqual([[1, "created"], [2, "account-ready"]]);
    const manifestView = await (await fetch(`${base}/api/review-stacks/stack-a/manifests/2`, { headers: { cookie } })).json() as any;
    validateResponse("readReviewStackManifest", manifestView);
    expect(manifestView.progress).toEqual({ read: 0, total: 8 });
  });

  test("the partition is checked exactly: omission, duplication, wrong pins, wrong group, out of order", async () => {
    const manifest = (await readStack("stack-a")).manifest;
    const good = stackAccountBody(manifest) as any;
    const attempt = async (groups: unknown[]): Promise<{ status: number; body: any }> => {
      const response = await publishStackAccount("stack-a", 2, { ...good, groups });
      return { status: response.status, body: await response.json() };
    };
    const shared = good.groups[0].members;
    const own = good.groups[1].members;
    // Omission: the last member's own group is never referenced.
    let result = await attempt([good.groups[0], { ...good.groups[1], members: own.slice(0, 3) }]);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body.errors)).toContain("pr-14/own is not referenced");
    // Duplication.
    result = await attempt([good.groups[0], { ...good.groups[1], members: [...own, own[0]] }]);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body.errors)).toContain("already referenced");
    // Wrong revision, wrong account version, wrong group id.
    result = await attempt([{ ...good.groups[0], members: [{ ...shared[0], revision: 2 }, ...shared.slice(1)] }, good.groups[1]]);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body.errors)).toContain("must be 1, the revision this manifest pins");
    result = await attempt([{ ...good.groups[0], members: [{ ...shared[0], accountVersion: 2 }, ...shared.slice(1)] }, good.groups[1]]);
    expect(result.status).toBe(422);
    result = await attempt([{ ...good.groups[0], members: [{ ...shared[0], groupId: "nope" }, ...shared.slice(1)] }, good.groups[1]]);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body.errors)).toContain("is not a group of");
    // Out of order: refused, never reordered.
    result = await attempt([{ ...good.groups[0], members: [shared[1], shared[0], ...shared.slice(2)] }, good.groups[1]]);
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body.errors)).toContain("out of order");
    result = await attempt([{ ...good.groups[0], members: [shared[0], own[0], shared[1], own[1], shared[2], own[2], shared[3], own[3]] }]);
    expect(result.status).toBe(200);
    validateResponse("publishReviewStackAccount", result.body);
    // Nothing was reordered: the account says what the witness wrote, in that order.
    expect(result.body.document.groups[0].members.map((ref: any) => ref.groupId)).toEqual(["shared", "own", "shared", "own", "shared", "own", "shared", "own"]);
    // Exact replay is the same account; a different one is a conflict.
    const replay = await attempt([{ ...good.groups[0], members: [shared[0], own[0], shared[1], own[1], shared[2], own[2], shared[3], own[3]] }]);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(result.body.id);
    expect((await attempt(good.groups)).status).toBe(409);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_accounts WHERE workspace_id = ?", workspace)).toBe(1);
    const view = await readStack("stack-a");
    expect(view.manifest.witness.state).toBe("published");
    expect(view.account.version).toBe(2);
    expect(view.latestAccountVersion).toBe(2);
    const account = await (await fetch(`${base}/api/review-stacks/stack-a/manifests/2/account`, { headers: { cookie } })).json();
    validateResponse("readReviewStackAccount", account);
  });
});

// ---- proof 6: progress is the sum of member reads ----

describe("reads and progress", () => {
  test("a read through the stack route is the member's read: it sums into progress, filters by layer, reverses, and writes no stack row", async () => {
    throwingGithub();
    const revision = getRevision(workspace, "pr-12", 1)!;
    const inventory = getStageCapture(revision.capture_id, workspace)!;
    const bare = inventory.changes[0]!.id;
    const namespaced = `l2-${bare}`;
    const marked = await markRead("stack-a", 2, 2, namespaced, true);
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ changeId: namespaced, memberChangeId: bare, read: true });
    expect(listRevisionReadChangeIds(workspace, revision.id, owner)).toEqual(new Set([bare]));
    // The position in the path and the prefix in the id must agree, and the change must be that member's.
    expect((await markRead("stack-a", 2, 1, namespaced, true)).status).toBe(404);
    expect((await markRead("stack-a", 2, 1, `l1-${bare}`, true)).status).toBe(404);

    // The member's own page shares the mark: it is one read, not a copy.
    const memberPage = visible(await (await fetch(`${base}/${workspace}/r/pr-12/rev/1`, { headers: { cookie } })).text());
    expect(memberPage).toContain("1 / 2 handled");
    const bySession = await (await fetch(`${base}/api/review-stacks/stack-a/manifests/2`, { headers: { cookie } })).json() as any;
    validateResponse("readReviewStackManifest", bySession);
    expect(bySession.progress).toEqual({ read: 1, total: 8 });
    expect(bySession.members[1].progress).toEqual({ read: 1, total: 2 });
    const byKey = await (await fetch(`${base}/api/review-stacks/stack-a/manifests/2`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    expect(byKey.progress).toBeNull();
    expect(byKey.members.every((member: any) => member.progress === null)).toBe(true);

    const page = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a`, { headers: { cookie } })).text());
    expect(page).toContain("1 / 8 handled");
    const layer = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a?layer=pr-12`, { headers: { cookie } })).text());
    expect(layer).toContain("1 / 2 handled");
    expect(layer).toMatch(/data-stage-change-ids="l2-chg_[a-f0-9]{64},l2-chg_[a-f0-9]{64}"/);
    expect((await fetch(`${base}/${workspace}/r-stacks/stack-a?layer=nobody`, { headers: { cookie } })).status).toBe(404);

    // Another member's read is theirs alone, through the same production write.
    setRevisionChangeRead(workspace, revision.id, second, inventory.changes[1]!.id, true);
    expect(listRevisionReadChangeIds(workspace, revision.id, owner)).toEqual(new Set([bare]));
    setRevisionChangeRead(workspace, revision.id, second, inventory.changes[1]!.id, false);

    // Reversal, and no stack read table anywhere.
    const unmarked = await markRead("stack-a", 2, 2, namespaced, false);
    expect(await unmarked.json()).toEqual({ changeId: namespaced, memberChangeId: bare, read: false });
    expect(listRevisionReadChangeIds(workspace, revision.id, owner)).toEqual(new Set());
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'review_stack%read%'").get()).toBeNull();

    // Without JavaScript the form lands back on the stack's own page, and only there.
    const action = `${base}/${workspace}/r-stacks/stack-a/v/2/m/2/changes/${namespaced}/read`;
    const wanted = `/${workspace}/r-stacks/stack-a/v/2/account?review=shared-line&change=${namespaced}`;
    const noJs = await fetch(action, { method: "POST", headers: { cookie, origin: new URL(config.baseUrl).origin }, body: new URLSearchParams({ read: "true", return: wanted }), redirect: "manual" });
    expect(noJs.status).toBe(303);
    expect(noJs.headers.get("location")).toBe(wanted);
    const foreign = await fetch(action, { method: "POST", headers: { cookie, origin: new URL(config.baseUrl).origin }, body: new URLSearchParams({ read: "false", return: "https://evil.example/" }), redirect: "manual" });
    expect(foreign.headers.get("location")).toBe(`/${workspace}/r-stacks/stack-a/v/2`);
    expect(listRevisionReadChangeIds(workspace, revision.id, owner)).toEqual(new Set());
  });
});

// ---- proofs 4, 5 and 7: movement, refresh, supersession, races, immutability ----

describe("movement, refresh and immutability", () => {
  let before: { manifests: unknown[]; accounts: unknown[]; requests: unknown[] };
  const rows = () => ({
    manifests: db.query("SELECT id, version, predecessor_version, reason, doc, digest FROM review_stack_manifests WHERE workspace_id = ? AND slug = 'stack-a' ORDER BY version").all(workspace),
    accounts: db.query("SELECT id, manifest_id, version, doc, digest FROM review_stack_accounts WHERE workspace_id = ? AND slug = 'stack-a' ORDER BY version").all(workspace),
    requests: db.query("SELECT id, manifest_id, version, state, account_id FROM review_stack_witness_requests WHERE workspace_id = ? ORDER BY version").all(workspace),
  });

  test("a newer member revision marks the manifest behind and rewrites nothing", async () => {
    before = rows();
    moveHead(12, "l2b");
    await refreshMember("pr-12", "pr-12-refresh-1");
    expect(getLineage(workspace, "pr-12")!.latest_revision).toBe(2);
    expect(rows()).toEqual(before);
    const view = await readStack("stack-a");
    validateResponse("readReviewStack", view);
    expect(view.latestManifestVersion).toBe(2);
    expect(view.manifest.drift.newerRevisions).toEqual([{ position: 2, lineageSlug: "pr-12", revision: 2, url: `${config.baseUrl}/${workspace}/r/pr-12/rev/2` }]);
    expect(view.manifest.drift.refreshRequired).toBe(true);
    throwingGithub();
    const page = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a`, { headers: { cookie } })).text());
    expect(page).toContain("#12 revision 2 available");
    expect(page).toContain("refresh required");
  });

  test("an explicit refresh publishes manifest 3 pinning the newer revision without an account; an unchanged refresh publishes nothing; the key replays", async () => {
    const refreshed = await refreshStack("stack-a", "stack-a-refresh-1");
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as any;
    validateResponse("refreshReviewStack", body);
    expect(body.created).toBe(true);
    expect(body.latestManifestVersion).toBe(3);
    expect(body.manifest.reason).toBe("refresh");
    expect(body.manifest.predecessorVersion).toBe(2);
    expect(body.manifest.members[1]).toMatchObject({ lineageSlug: "pr-12", revision: 2, accountId: null, accountVersion: null });
    expect(body.manifest.witness).toBeNull();
    expect(body.account).toBeNull();
    expect(body.latestAccountVersion).toBe(2);
    // Inferred: proved from rows, nothing opened.
    expect(opened).toEqual([]);

    const again = await refreshStack("stack-a", "stack-a-refresh-2");
    expect((await again.json() as any).created).toBe(false);
    expect(getStack(workspace, "stack-a")!.latest_manifest_version).toBe(3);
    const replay = await refreshStack("stack-a", "stack-a-refresh-1");
    expect((await replay.json() as any).replayed).toBe(true);
    expect((await refreshStack("stack-a", "stack-a-refresh-1", secondKey)).status).toBe(200);

    // Manifest 2 still reads with its account, forever; manifest 3 is evidence until its member account lands.
    throwingGithub();
    expect((await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2/account`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/${workspace}/r-stacks/stack-a/v/3/account`, { headers: { cookie } })).status).toBe(404);
    const third = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a/v/3`, { headers: { cookie } })).text());
    expect(third).toContain("awaiting member accounts #12");
    expect(third).toContain("Manifest 3");
    expect(before.requests).toEqual(rows().requests.slice(0, 1));
    expect((rows().requests[0] as any).state).toBe("published");
  });

  test("the next member account makes manifest 4 account-ready; claim, fail and retry drive its request; a later refresh supersedes it", async () => {
    expect((await publishMemberAccount("pr-12", 2)).status).toBe(200);
    const stack = getStack(workspace, "stack-a")!;
    expect(stack.latest_manifest_version).toBe(4);
    const view = await readStack("stack-a");
    expect(view.manifest.reason).toBe("account-ready");
    expect(view.manifest.witness.state).toBe("pending");
    const requestId = view.manifest.witness.id as string;
    expect(requestId).toMatch(/^rsw_/);

    const claim = async (token = key) => fetch(`${base}/api/review-stack-witness-requests/${requestId}/claim`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const first = await claim();
    expect(first.status).toBe(200);
    const claimed = await first.json() as any;
    validateResponse("claimStackWitnessRequest", claimed);
    expect(claimed.claim.claimed).toBe(true);
    expect(claimed.manifestUrl).toContain("/api/review-stacks/stack-a/manifests/4");
    expect(((await (await claim()).json()) as any).claim.claimed).toBe(false);
    expect((await claim(secondKey)).status).toBe(409);
    // A foreign key cannot fail a request another agent holds; the holder can.
    const fail = async (token = key) => fetch(`${base}/api/review-stack-witness-requests/${requestId}/fail`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ error: "The stack account could not be written." }) });
    expect((await fail(secondKey)).status).toBe(409);
    const failed = await fail();
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as any;
    validateResponse("failStackWitnessRequest", failedBody);
    expect(failedBody.state).toBe("failed");
    expect((await publishStackAccount("stack-a", 4, stackAccountBody(view.manifest))).status).toBe(409);
    const retried = await (await fetch(`${base}/api/review-stack-witness-requests/${requestId}/retry`, { method: "POST", headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("retryStackWitnessRequest", retried);
    expect(retried.state).toBe("retrying");
    expect(retried.retryCount).toBe(1);
    throwingGithub();
    expect(visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a`, { headers: { cookie } })).text())).toContain("Witness retrying");

    // Movement supersedes: pr-13 moves, the refresh publishes 5, and request 4 is left behind.
    installRouter();
    moveHead(13, "l3b");
    await refreshMember("pr-13", "pr-13-refresh-1");
    expect((await (await refreshStack("stack-a", "stack-a-refresh-3")).json() as any).latestManifestVersion).toBe(5);
    const superseded = await readStack("stack-a");
    expect(superseded.manifests.find((row: any) => row.version === 4).witness).toBe("superseded");
    expect((await publishStackAccount("stack-a", 4, stackAccountBody(view.manifest))).status).toBe(409);
    expect((await (await publishStackAccount("stack-a", 4, stackAccountBody(view.manifest))).json() as any).error).toContain("superseded");
    expect((await claim()).status).toBe(409);
    expect((await fail()).status).toBe(409);
    expect((await fetch(`${base}/api/review-stack-witness-requests/${requestId}/retry`, { method: "POST", headers: { authorization: `Bearer ${key}` } })).status).toBe(409);
    // Manifest 5 awaits pr-13's new account, so it has no request of its own yet.
    expect(superseded.manifest.witness).toBeNull();
  });

  test("a refresh racing the final member account converges on one successor and never answers 500", async () => {
    const results = await Promise.all([
      publishMemberAccount("pr-13", 2),
      refreshStack("stack-a", "race-1"),
      publishMemberAccount("pr-13", 2),
      refreshStack("stack-a", "race-2", secondKey),
      publishMemberAccount("pr-13", 2),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const stack = getStack(workspace, "stack-a")!;
    expect(stack.latest_manifest_version).toBe(6);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_manifests WHERE stack_id = ?", stack.id)).toBe(6);
    const manifest = getStackManifest(workspace, "stack-a", 6)!;
    expect(manifest.doc.members.every((member) => member.accountId !== null)).toBe(true);
    // Requests: 2 published, 4 superseded, 6 pending — and nothing else.
    expect((rows().requests as any[]).map((row) => [row.version, row.state])).toEqual([[2, "published"], [4, "pending"], [6, "pending"]]);
    const view = await readStack("stack-a");
    expect(view.manifest.witness.state).toBe("pending");
    // And the stack account over 6 partitions every pinned member group, including the moved ones.
    const published = await publishStackAccount("stack-a", 6, stackAccountBody(view.manifest));
    expect(published.status).toBe(200);
  });

  test("an inferred refresh keeps a detached middle member in its historical slot", async () => {
    expect((await createStack({ slug: "stack-detach", members: ["pr-111", "pr-112", "pr-113"] }, "stack-detach-create")).status).toBe(201);
    const middle = getLineage(workspace, "pr-112")!;
    db.run("UPDATE review_lineage_prs SET detached_at = ? WHERE workspace_id = ? AND lineage_id = ?", [Date.now(), workspace, middle.id]);
    const refreshed = await refreshStack("stack-detach", "stack-detach-refresh");
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as any;
    expect(body.manifest.members.map((member: any) => [member.position, member.lineageSlug, member.status, member.removedReason])).toEqual([
      [1, "pr-111", "live", null],
      [2, "pr-112", "removed", "detached"],
      [3, "pr-113", "live", null],
    ]);
  });

  test("every earlier manifest, account and request row is byte-identical to when it was published", () => {
    const now = rows();
    expect(now.manifests.slice(0, 2)).toEqual(before.manifests);
    expect(now.accounts.slice(0, 1)).toEqual(before.accounts);
    expect(now.requests.slice(0, 1)).toEqual(before.requests);
  });
});

// ---- proof 8: native membership, deliveries, jobs, both provider behaviours ----

describe("native membership", () => {
  test("a native stack is created through the installation, in GitHub's order", async () => {
    stacks.set(22, nativeStack);
    const created = await createStack({ slug: "stack-n", native: { seed: "pr-22" } }, "stack-n-create");
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    validateResponse("createReviewStack", body, "201");
    expect(body.source).toBe("native");
    expect(body.providerStackNumber).toBe(9);
    expect(body.actor).toBe("installation");
    expect(body.manifest.document.members.map((member: any) => member.lineageSlug)).toEqual(["pr-21", "pr-22", "pr-23"]);
    expect(body.manifest.document.source).toMatchObject({ kind: "native", providerStackId: 501, providerStackNumber: 9 });
    expect(opened).toEqual([{ kind: "installation", installationId: INSTALLATION }]);
    expect(pullStackCalls).toBeGreaterThan(0);
  });

  test("stacked, synchronize with stack, and edited without stack each record one observation and one installation-owned job; replay is a duplicate; leases recover", async () => {
    stacks.set(22, nativeStack);
    const stackId = getStack(workspace, "stack-n")!.id;
    const facts = { id: 501, number: 9, size: 3, position: 2, base: { ref: "main", sha: MAIN } };
    const observations = () => db.query<{ id: string; receipt_id: string; pull_request_observation_id: string | null; provider_stack_number: number | null }, [string, number]>("SELECT id, receipt_id, pull_request_observation_id, provider_stack_number FROM review_stack_pr_observations WHERE workspace_id = ? AND repo_id = ? AND pr_number = 22 ORDER BY observed_at, rowid").all(workspace, REPO_ID);
    const jobs = () => db.query<{ id: string; stack_observation_id: string | null; pull_request_observation_id: string | null; state: string; result_manifest_id: string | null; actor_key: string }, [string]>("SELECT id, stack_observation_id, pull_request_observation_id, state, result_manifest_id, actor_key FROM review_stack_refresh_jobs WHERE stack_id = ? ORDER BY created_at, id").all(stackId);
    const lineage = getLineage(workspace, "pr-22")!;
    const promotedBefore = count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id);
    const capturesBefore = count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id);

    const first = await deliver(deliveryPayload(22, "stacked", "2026-06-03T10:00:00Z", facts), "stack-n-d1");
    expect([200, 202]).toContain(first.status);
    await settleStackRefreshJobs();
    expect(observations().map(({ provider_stack_number }) => ({ provider_stack_number }))).toEqual([{ provider_stack_number: 9 }]);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]!.state).toBe("completed");
    expect(jobs()[0]!.result_manifest_id).toBe(getStackManifest(workspace, "stack-n", 1)!.id);
    expect(jobs()[0]!.actor_key).toBe(`stack/${workspace}/installation/${INSTALLATION}`);
    expect(observations()[0]!.pull_request_observation_id).not.toBeNull();
    expect(jobs()[0]!.stack_observation_id).toBe(observations()[0]!.id);
    expect(jobs()[0]!.pull_request_observation_id).toBeNull();
    // A redelivery of the same id writes nothing.
    expect(((await (await deliver(deliveryPayload(22, "stacked", "2026-06-03T10:00:00Z", facts), "stack-n-d1")).json()) as any).duplicate).toBe(true);
    expect(observations()).toHaveLength(1);
    expect(jobs()).toHaveLength(1);

    // Identical pull request facts with only stack membership changing still get a fresh
    // pull request observation, stack reading, and refresh job. Source capture converges.
    await deliver(deliveryPayload(22, "synchronize", "2026-06-03T10:00:00Z", undefined), "stack-n-stack-only");
    await settleStackRefreshJobs();
    expect(observations().map((row) => row.provider_stack_number)).toEqual([9, null]);
    expect(new Set(observations().map((row) => row.id)).size).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM review_pr_observations WHERE lineage_id = ?", lineage.id)).toBe(promotedBefore + 2);
    expect(count("SELECT COUNT(*) AS n FROM review_capture_jobs WHERE lineage_id = ?", lineage.id)).toBe(capturesBefore);

    await deliver(deliveryPayload(22, "synchronize", "2026-06-03T10:05:00Z", facts), "stack-n-d2");
    await deliver(deliveryPayload(22, "edited", "2026-06-03T10:10:00Z", undefined), "stack-n-d3");
    await settleStackRefreshJobs();
    expect(observations().map((row) => row.provider_stack_number)).toEqual([9, null, 9, null]);
    expect(jobs()).toHaveLength(4);
    expect(jobs().every((job) => job.state === "completed")).toBe(true);
    const view = await readStack("stack-n");
    validateResponse("readReviewStack", view);
    expect(view.manifest.drift.membershipChanged).toEqual([{ position: 2, lineageSlug: "pr-22" }]);
    expect(view.refreshJobs).toHaveLength(4);
    const job = await (await fetch(`${base}/api/review-stack-refresh-jobs/${jobs()[3]!.id}`, { headers: { cookie } })).json();
    validateResponse("readStackRefreshJob", job);

    // An abandoned lease is released and re-run by the sweep; a failed job is retried by hand.
    db.run("UPDATE review_stack_refresh_jobs SET state = 'running', lease_token = 'lse_lost', lease_expires_at = ?, result_manifest_id = NULL WHERE id = ?", [Date.now() - CAPTURE_LEASE_MS - 1, jobs()[3]!.id]);
    recoverStackRefreshJobs();
    await settleStackRefreshJobs();
    expect(jobs()[3]!.state).toBe("completed");
    db.run("UPDATE review_stack_refresh_jobs SET state = 'failed', failure = 'boom', result_manifest_id = NULL WHERE id = ?", [jobs()[3]!.id]);
    const retried = await fetch(`${base}/api/review-stack-refresh-jobs/${jobs()[3]!.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    expect(retried.status).toBe(202);
    validateResponse("retryStackRefreshJob", await retried.json(), "202");
    await settleStackRefreshJobs();
    expect(jobs()[3]!.state).toBe("completed");
    expect((await fetch(`${base}/api/review-stack-refresh-jobs/${jobs()[3]!.id}/retry`, { method: "POST", headers: { authorization: `Bearer ${key}` } })).status).toBe(409);
    expect(getStack(workspace, "stack-n")!.latest_manifest_version).toBe(1);
  });

  test("an accepted incomplete webhook gets a fresh stack receipt and job, while a malformed present stack is ignored", async () => {
    stacks.set(22, nativeStack);
    const stackId = getStack(workspace, "stack-n")!.id;
    const beforeObservations = db.query<{ id: string }, [string]>("SELECT id FROM review_stack_pr_observations WHERE workspace_id = ? ORDER BY rowid",).all(workspace);
    const beforeJobs = db.query<{ id: string }, [string]>("SELECT id FROM review_stack_refresh_jobs WHERE stack_id = ? ORDER BY rowid").all(stackId);
    expect(beforeJobs.at(-1)).toBeDefined();

    const incomplete = deliveryPayload(22, "stacked", "2026-06-03T11:00:00Z", { id: 501, number: 9, size: 3, position: 2 }) as any;
    incomplete.pull_request.head.repo = null;
    const accepted = await deliver(incomplete, "stack-n-incomplete");
    expect([200, 202]).toContain(accepted.status);
    await settleStackRefreshJobs();
    const observations = db.query<{ id: string; receipt_id: string; pull_request_observation_id: string | null; provider_stack_number: number | null }, [string]>(
      "SELECT id, receipt_id, pull_request_observation_id, provider_stack_number FROM review_stack_pr_observations WHERE workspace_id = ? ORDER BY rowid",
    ).all(workspace);
    const jobs = db.query<{ id: string; stack_observation_id: string | null; pull_request_observation_id: string | null; state: string }, [string]>(
      "SELECT id, stack_observation_id, pull_request_observation_id, state FROM review_stack_refresh_jobs WHERE stack_id = ? ORDER BY rowid",
    ).all(stackId);
    expect(observations).toHaveLength(beforeObservations.length + 1);
    expect(jobs).toHaveLength(beforeJobs.length + 1);
    const stackObservation = observations.at(-1)!;
    expect(stackObservation).toMatchObject({ pull_request_observation_id: null, provider_stack_number: 9 });
    expect(stackObservation.receipt_id.startsWith("stack-n-incomplete\0")).toBe(true);
    expect(stackObservation.id).not.toBe(beforeObservations.at(-1)!.id);
    expect(jobs.at(-1)).toMatchObject({ stack_observation_id: stackObservation.id, pull_request_observation_id: null, state: "completed" });
    expect(jobs.at(-1)!.id).not.toBe(beforeJobs.at(-1)!.id);

    const malformedStacks: unknown[] = [
      { size: 3, position: 2 },
      { id: -1, number: 9, size: 3, position: 2 },
      { id: 501.5, number: 9, size: 3, position: 2 },
      { id: 501, number: 0, size: 3, position: 2 },
      { id: 501, number: 9.5, size: 3, position: 2 },
      { id: 501, number: 9, size: 3, position: -2 },
      { id: 501, number: 9, size: Number.POSITIVE_INFINITY, position: 2 },
      { id: 501, number: 9, size: 3, position: 2, base: "main" },
      { id: 501, number: 9, size: 3, position: 2, base: { ref: "bad ref", sha: MAIN } },
      { id: 501, number: 9, size: 3, position: 2, base: { ref: "main", sha: "not-a-sha" } },
    ];
    for (const [index, malformedStack] of malformedStacks.entries()) {
      const malformed = deliveryPayload(22, "stacked", `2026-06-03T11:${String(index + 5).padStart(2, "0")}:00Z`, malformedStack);
      const malformedAccepted = await deliver(malformed, `stack-n-malformed-${index}`);
      expect([200, 202]).toContain(malformedAccepted.status);
    }
    await settleStackRefreshJobs();
    expect(count("SELECT COUNT(*) AS n FROM review_stack_pr_observations WHERE workspace_id = ?", workspace)).toBe(observations.length);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_refresh_jobs WHERE stack_id = ?", stackId)).toBe(jobs.length);
    expect((await readStack("stack-n")).manifest.drift.membershipChanged).toEqual([]);
  });

  test("a merged member GitHub still lists stays a merged member; one it drops becomes a removed stub; an unstacked one too", async () => {
    // GitHub says #21 merged and retargeted #22 to main; Seer observes both.
    pullOverrides.set(21, { merged: true, state: "closed", updated_at: "2026-06-04T10:00:00Z" });
    await deliver(deliveryPayload(21, "closed", "2026-06-04T10:00:00Z", { ...{ id: 501, number: 9, size: 3, position: 1 } }, { state: "closed", merged: true }), "stack-n-d4");
    await deliver(deliveryPayload(22, "edited", "2026-06-04T10:01:00Z", { id: 501, number: 9, size: 3, position: 2 }, { baseRef: "main", baseSha: prs.get(21)!.headSha }), "stack-n-d5");
    await settleStackRefreshJobs();
    const listed = { ...nativeStack, pullRequests: nativeStack.pullRequests.map((entry) => entry.number === 21 ? { ...entry, state: "closed" as const, mergedAt: "2026-06-04T10:00:00Z" } : entry) };
    stacks.set(22, listed);
    const kept = await (await refreshStack("stack-n", "stack-n-refresh-1")).json() as any;
    validateResponse("refreshReviewStack", kept);
    expect(kept.created).toBe(true);
    expect(kept.manifest.members.map((member: any) => [member.lineageSlug, member.status, member.baseRef])).toEqual([["pr-21", "merged", "main"], ["pr-22", "live", "main"], ["pr-23", "live", "n2"]]);
    // The member rows are still live: a merged member is a member.
    expect(kept.members.every((member: any) => member.live)).toBe(true);

    // GitHub drops the merged pull request from the listing.
    stacks.set(22, { ...nativeStack, pullRequests: nativeStack.pullRequests.filter((entry) => entry.number !== 21) });
    const dropped = await (await refreshStack("stack-n", "stack-n-refresh-2")).json() as any;
    expect(dropped.created).toBe(true);
    expect(dropped.manifest.members.map((member: any) => [member.lineageSlug, member.status, member.removedReason])).toEqual([["pr-21", "removed", "merged"], ["pr-22", "live", null], ["pr-23", "live", null]]);
    expect(dropped.members.find((member: any) => member.lineageSlug === "pr-21")).toMatchObject({ live: false, removedReason: "merged" });

    // And an open pull request GitHub no longer lists was unstacked.
    stacks.set(22, { ...nativeStack, pullRequests: nativeStack.pullRequests.filter((entry) => entry.number === 22) });
    const unstacked = await (await refreshStack("stack-n", "stack-n-refresh-3")).json() as any;
    expect(unstacked.manifest.members.map((member: any) => [member.lineageSlug, member.status, member.removedReason])).toEqual([["pr-21", "removed", "merged"], ["pr-22", "live", null], ["pr-23", "removed", "unstacked"]]);
    expect(unstacked.manifest.drift.removed).toEqual([{ position: 1, lineageSlug: "pr-21", reason: "merged" }, { position: 3, lineageSlug: "pr-23", reason: "unstacked" }]);
    throwingGithub();
    const page = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-n`, { headers: { cookie } })).text());
    expect(page).toContain("removed (unstacked)");
    expect(page).toContain("removed (merged)");
    // The old manifest still reads all three in full.
    const old = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-n/v/1`, { headers: { cookie } })).text());
    expect(old).toContain('data-group="l3-seam-1"');
    // A lineage that left may join another stack.
    expect((await createStack({ slug: "stack-n2", members: ["pr-21", "pr-23"] }, "stack-n2-create")).status).toBe(422);
  });

  test("a native successor keeps a dropped middle unstacked member as the historical chain slot", async () => {
    const initial: GithubPullStack = {
      id: 901, number: 18, baseRef: "main", open: true,
      pullRequests: NATIVE_MIDDLE_DROP_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
    };
    stacks.set(121, initial);
    expect((await createStack({ slug: "stack-middle-drop", native: { seed: "pr-121" } }, "stack-middle-drop-create")).status).toBe(201);

    stacks.set(121, { ...initial, pullRequests: initial.pullRequests.filter((entry) => entry.number !== 122) });
    const refreshed = await refreshStack("stack-middle-drop", "stack-middle-drop-refresh");
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as any;
    expect(body.manifest.members.map((member: any) => [member.position, member.lineageSlug, member.status, member.removedReason, member.baseRef])).toEqual([
      [1, "pr-121", "live", null, "main"],
      [2, "pr-122", "removed", "unstacked", "q1"],
      [3, "pr-123", "live", null, "q2"],
    ]);
  });

  test("a native successor keeps a dropped merged middle slot after its successor is retargeted", async () => {
    resolvedActor = { kind: "user", userId: owner, credentialId: "cred_middle_merge" };
    const initial: GithubPullStack = {
      id: 902, number: 19, baseRef: "main", open: true,
      pullRequests: NATIVE_MERGED_DROP_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
    };
    stacks.set(131, initial);
    expect((await createStack({ slug: "stack-middle-merged", native: { seed: "pr-131" } }, "stack-middle-merged-create")).status).toBe(201);
    await deliver(deliveryPayload(132, "closed", "2026-06-04T12:00:00Z", { id: 902, number: 19, position: 2, size: 3 }, { state: "closed", merged: true }), "stack-middle-merged-middle");
    await deliver(deliveryPayload(133, "edited", "2026-06-04T12:01:00Z", { id: 902, number: 19, position: 2, size: 2 }, { baseRef: "g1", baseSha: prs.get(131)!.headSha }), "stack-middle-merged-top");

    stacks.set(131, { ...initial, pullRequests: initial.pullRequests.filter((entry) => entry.number !== 132) });
    const refreshed = await refreshStack("stack-middle-merged", "stack-middle-merged-refresh");
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as any;
    expect(body.manifest.members.map((member: any) => [member.position, member.lineageSlug, member.status, member.removedReason, member.baseRef])).toEqual([
      [1, "pr-131", "live", null, "main"],
      [2, "pr-132", "removed", "merged", "g1"],
      [3, "pr-133", "live", null, "g1"],
    ]);
  });

  test("a removed native member rejoins its own slot and new members keep GitHub order", async () => {
    const initial: GithubPullStack = {
      id: 701, number: 14, baseRef: "main", open: true,
      pullRequests: ADDITION_CHAIN.slice(0, 2).map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
    };
    stacks.set(71, initial);
    expect((await createStack({ slug: "stack-add", native: { seed: "pr-71" } }, "stack-add-create")).status).toBe(201);

    stacks.set(71, { ...initial, pullRequests: initial.pullRequests.slice(0, 1) });
    const removed = await (await refreshStack("stack-add", "stack-add-remove")).json() as any;
    expect(removed.manifest.members.map((member: any) => [member.lineageSlug, member.status])).toEqual([["pr-71", "live"], ["pr-72", "removed"]]);

    stacks.set(71, {
      ...initial,
      pullRequests: ADDITION_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
    });
    const rejoined = await (await refreshStack("stack-add", "stack-add-rejoin-and-add")).json() as any;
    expect(rejoined.manifest.members.map((member: any) => [member.lineageSlug, member.status])).toEqual([["pr-71", "live"], ["pr-72", "live"], ["pr-73", "live"]]);
    const rows = db.query<{ lineage_slug: string; removed_at: number | null; removed_reason: string | null; removed_manifest_id: string | null }, [string]>(
      "SELECT lineage_slug, removed_at, removed_reason, removed_manifest_id FROM review_stack_members WHERE stack_id = ? ORDER BY lineage_slug",
    ).all(getStack(workspace, "stack-add")!.id);
    expect(rows).toEqual([
      { lineage_slug: "pr-71", removed_at: null, removed_reason: null, removed_manifest_id: null },
      { lineage_slug: "pr-72", removed_at: null, removed_reason: null, removed_manifest_id: null },
      { lineage_slug: "pr-73", removed_at: null, removed_reason: null, removed_manifest_id: null },
    ]);
  });

  test("a successor cannot reclaim a removed member now owned by another live stack", async () => {
    const initial: GithubPullStack = {
      id: 801, number: 15, baseRef: "main", open: true,
      pullRequests: OWNERSHIP_CHAIN.slice(0, 2).map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })),
    };
    stacks.set(81, initial);
    expect((await createStack({ slug: "stack-owner-b", native: { seed: "pr-81" } }, "stack-owner-b-create")).status).toBe(201);
    stacks.set(81, { ...initial, pullRequests: initial.pullRequests.slice(0, 1) });
    expect((await refreshStack("stack-owner-b", "stack-owner-b-remove")).status).toBe(200);
    expect((await createStack({ slug: "stack-owner-a", members: ["pr-82", "pr-83"] }, "stack-owner-a-create")).status).toBe(201);

    stacks.set(81, initial);
    const rejected = await refreshStack("stack-owner-b", "stack-owner-b-expect-422-readd");
    expect(rejected.status).toBe(422);
    expect((await rejected.json() as any).error).toContain('"pr-82" is already a member of stack "stack-owner-a"');
    expect(getStack(workspace, "stack-owner-b")!.latest_manifest_version).toBe(2);
    expect((await readStack("stack-owner-b")).manifest.members.map((member: any) => [member.lineageSlug, member.status])).toEqual([["pr-81", "live"], ["pr-82", "removed"]]);
    expect((await readStack("stack-owner-a")).manifest.members.map((member: any) => [member.lineageSlug, member.status])).toEqual([["pr-82", "live"], ["pr-83", "live"]]);
  });

  test("a user-actor stack records membership and drift, queues no job, and refuses a stranger's refresh", async () => {
    resolvedActor = { kind: "user", userId: owner, credentialId: "cred_stack_owner" };
    const userStack: GithubPullStack = { id: 601, number: 12, baseRef: "main", open: true, pullRequests: USER_CHAIN.map((pr) => ({ number: pr.number, state: "open" as const, draft: false, mergedAt: null, headRef: pr.headRef, headSha: pr.headSha })) };
    stacks.set(61, userStack);
    const created = await createStack({ slug: "stack-u", native: { seed: "pr-61" } }, "stack-u-create");
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.actor).toBe("user");
    expect(body.actorLabel).toBe("the owning member's GitHub connection");
    const stackId = getStack(workspace, "stack-u")!.id;
    await deliver(deliveryPayload(61, "stacked", "2026-06-05T10:00:00Z", undefined), "stack-u-d1");
    await settleStackRefreshJobs();
    expect(count("SELECT COUNT(*) AS n FROM review_stack_pr_observations WHERE repo_id = ? AND pr_number = 61", REPO_ID)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM review_stack_refresh_jobs WHERE stack_id = ?", stackId)).toBe(0);
    const view = await readStack("stack-u");
    expect(view.manifest.drift.membershipChanged).toEqual([{ position: 1, lineageSlug: "pr-61" }]);
    const stranger = await refreshStack("stack-u", "stack-u-refresh-stranger", secondKey);
    expect(stranger.status).toBe(403);
    expect((await stranger.json() as any).error).toBe("This stack reads through another member's account");
    opened = [];
    const own = await refreshStack("stack-u", "stack-u-refresh-owner");
    expect(own.status).toBe(200);
    expect(opened).toEqual([{ kind: "user", userId: owner, credentialId: "cred_stack_owner" }]);
  });

  test("native drift ignores newer observations from another workspace in either arrival order", async () => {
    const now = Date.now() + 10_000;
    const manifest = getStackManifest(workspace, "stack-n", getStack(workspace, "stack-n")!.latest_manifest_version)!;
    const active = manifest.doc.members.filter((member) => member.status !== "removed");
    const member = active.find((entry) => entry.prNumber === 22)!;
    const baseMember = active.find((entry) => entry.baseRef === manifest.doc.repository.baseRef)!;
    const baseSha = getRevision(workspace, baseMember.lineageSlug, baseMember.revision)!.doc.source.baseTipSha;
    const valid = { stackId: 501, stackNumber: 9, position: active.indexOf(member) + 1, size: active.length, baseRef: manifest.doc.repository.baseRef, baseSha };
    recordStackObservation({ workspaceId: workspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: 22, stack: valid, now });
    recordStackObservation({ workspaceId: otherWorkspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: 22, stack: null, now: now + 1 });
    expect((await readStack("stack-n")).manifest.drift.membershipChanged).toEqual([]);

    recordStackObservation({ workspaceId: workspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: 22, stack: null, now: now + 2 });
    recordStackObservation({ workspaceId: otherWorkspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: 22, stack: valid, now: now + 3 });
    expect((await readStack("stack-n")).manifest.drift.membershipChanged).toEqual([{ position: 2, lineageSlug: "pr-22" }]);
  });

  test("native drift compares every supplied membership fact for installation and user stacks", async () => {
    const cases = [
      { slug: "stack-add", prNumber: 72, actor: "installation" },
      { slug: "stack-u", prNumber: 61, actor: "user" },
    ] as const;
    let now = db.query<{ observed_at: number }, []>("SELECT COALESCE(MAX(observed_at), 0) AS observed_at FROM review_stack_pr_observations").get()!.observed_at + 1;
    for (const item of cases) {
      const stack = getStack(workspace, item.slug)!;
      expect(stack.actor_kind).toBe(item.actor);
      const manifest = getStackManifest(workspace, item.slug, stack.latest_manifest_version)!;
      const active = manifest.doc.members.filter((member) => member.status !== "removed");
      const member = active.find((entry) => entry.prNumber === item.prNumber)!;
      const baseMember = active.find((entry) => entry.baseRef === manifest.doc.repository.baseRef)!;
      const baseSha = getRevision(workspace, baseMember.lineageSlug, baseMember.revision)!.doc.source.baseTipSha;
      const valid = {
        stackId: stack.provider_stack_id!,
        stackNumber: stack.provider_stack_number!,
        position: active.indexOf(member) + 1,
        size: active.length,
        baseRef: manifest.doc.repository.baseRef,
        baseSha,
      };
      const expected = [{ position: manifest.doc.members.indexOf(member) + 1, lineageSlug: member.lineageSlug }];
      const changed = [
        { ...valid, stackId: valid.stackId + 1 },
        { ...valid, stackNumber: valid.stackNumber + 1 },
        { ...valid, position: valid.position === 1 ? 2 : 1 },
        { ...valid, size: valid.size + 1 },
        { ...valid, baseRef: "release" },
        { ...valid, baseSha: sha(0xffff) },
      ];
      for (const facts of changed) {
        recordStackObservation({ workspaceId: workspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: item.prNumber, stack: facts, now: now++ });
        expect((await readStack(item.slug)).manifest.drift.membershipChanged).toEqual(expected);
      }
      recordStackObservation({ workspaceId: workspace, receiptId: tinyId("receipt"), pullRequestObservationId: null, repoId: REPO_ID, prNumber: item.prNumber, stack: valid, now: now++ });
      expect((await readStack(item.slug)).manifest.drift.membershipChanged).toEqual([]);
    }
  });
});

// ---- proof 9: paging ----

describe("paging", () => {
  const unit = (key: string, changes: number, lines: number): StackUnit => ({
    key, position: 1, memberGroupId: key,
    changeIds: Array.from({ length: changes }, (_, index) => `${key}-${index}`),
    hunkLines: lines,
  });

  test("pages fill greedily at member-group seams and serve each oversized unit whole", () => {
    const plan = stackPages([unit("a", 60, 1000), unit("b", 50, 1000), unit("c", 10, 7500), unit("d", 1, 9000), unit("e", 5, 100)]);
    expect(plan.pages.map((page) => page.map((entry) => entry.unit.key))).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    expect([...plan.overBudget]).toEqual([4]);
    expect(plan.pages[3]![0]).toMatchObject({ changeIds: ["d-0"], part: null });
    const wide = stackPages([unit("w", 250, 250), unit("x", 3, 3)]);
    expect(wide.pages.map((page) => page.map((entry) => [entry.unit.key, entry.changeIds.length, entry.part]))).toEqual([
      [["w", 250, null]], [["x", 3, null]],
    ]);
    expect([...wide.overBudget]).toEqual([1]);
    const all = wide.pages.flatMap((page) => page.flatMap((entry) => entry.changeIds));
    expect(new Set(all).size).toBe(253);
    expect(all).toHaveLength(253);
    expect(stackPages([]).pages).toEqual([[]]);
  });

  test("oversized member groups stay whole and the 4 MiB fallback links every item through its exact member group", async () => {
    const budgetRevision = getRevision(workspace, "pr-52", 1)!;
    const budgetInventory = getStageCapture(budgetRevision.capture_id, workspace)!;
    const bigFile = budgetInventory.files.find((file) => file.path === "src/big.ts")!;
    const materialId = tinyId("sti");
    db.run(
      "INSERT INTO stage_capture_incomplete (id, workspace_id, capture_id, kind, path, side, reason) VALUES (?, ?, ?, 'bytes_unavailable', 'src/big.ts', 'new', 'fixture bytes unavailable')",
      [materialId, workspace, budgetRevision.capture_id],
    );
    const leafId = tinyId("stf");
    db.run(
      "INSERT INTO stage_capture_files SELECT ?, workspace_id, capture_id, 'src/structure-only.ts', NULL, status, old_object_id, new_object_id, old_mode, new_mode, old_kind, new_kind, additions, deletions, old_availability, new_availability, old_blob_sha, new_blob_sha, old_reason, new_reason FROM stage_capture_files WHERE capture_id = ? AND id = ?",
      [leafId, budgetRevision.capture_id, bigFile.id],
    );
    for (const slug of ["pr-51", "pr-52"]) expect((await publishMemberAccount(slug)).status).toBe(200);
    const created = await createStack({ slug: "stack-budget", members: ["pr-51", "pr-52"] }, "stack-budget-create");
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.manifest.witness.state).toBe("pending");
    expect((await publishStackAccount("stack-budget", 1, stackAccountBody(body.manifest))).status).toBe(200);
    throwingGithub();
    const path = `${base}/${workspace}/r-stacks/stack-budget/v/1/account?review=own-files`;
    const first = await fetch(path, { headers: { cookie } });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-seer-page-count")).toBe("2");
    const secondPage = await fetch(`${path}&page=2`, { headers: { cookie } });
    expect(secondPage.status).toBe(200);
    expect(first.headers.get("x-seer-page-fallback")).toBeNull();
    expect(secondPage.headers.get("x-seer-page-fallback")).toBe("over-limit");
    expect(Number(first.headers.get("x-seer-page-bytes"))).toBeLessThanOrEqual(STACK_PAGE_HTML_TARGET_BYTES);
    expect(Number(secondPage.headers.get("x-seer-page-bytes"))).toBeGreaterThan(STACK_PAGE_HTML_TARGET_BYTES);
    const pages = [await first.text(), await secondPage.text()];
    expect(Buffer.byteLength(pages[1]!)).toBeLessThan(STACK_PAGE_HTML_TARGET_BYTES);
    const ids = pages.map(changeIdsOf);
    expect(ids.map((list) => list.length)).toEqual([102, 2]);
    const all = ids.flat();
    expect(new Set(all).size).toBe(all.length);
    const expected = body.manifest.members.flatMap((member: any) => {
      const revision = getRevision(workspace, member.lineageSlug, member.revision)!;
      const inventory = getStageCapture(revision.capture_id, workspace)!;
      const shared = inventory.files.find((file) => file.path === "src/shared.ts")!;
      return inventory.changes.filter((change) => change.file_id !== shared.id).map((change) => `l${member.position}-${change.id}`);
    });
    expect(new Set(all)).toEqual(new Set(expected));
    expect(visible(pages[0]!)).toContain("over budget");
    expect(visible(pages[1]!)).toContain("exceeds the 4 MiB response limit");
    expect(pages[0]).toContain('data-page="1"');
    const links = fallbackLinks(pages[1]!);
    expect(links.map((link) => link.kind).sort()).toEqual(["change", "change", "file", "material"]);
    for (const link of links) {
      const target = new URL(link.href, base);
      const bare = link.id.replace(/^l2-/, "");
      expect(target.pathname).toBe(`/${workspace}/r/pr-52/v/1`);
      expect(target.searchParams.get("review")).toBe("own");
      expect(target.searchParams.get("change")).toBe(link.kind === "change" ? bare : null);
      expect(target.hash).toBe(link.kind === "change" ? `#${bare}` : `#focus-${bare}`);
      const followed = await fetch(target, { headers: { cookie } });
      expect(followed.status).toBe(200);
      expect(await followed.text()).toContain(link.kind === "change" ? `data-change="${bare}"` : `id="focus-${bare}"`);
    }
    // Beyond the last page lands on the page the link was pinned to; a change finds its own page.
    const beyond = await fetch(`${path}&page=3`, { headers: { cookie }, redirect: "manual" });
    expect(beyond.status).toBe(303);
    expect(beyond.headers.get("location")).toBe(`/${workspace}/r-stacks/stack-budget/v/1/account`);
    const found = await fetch(`${path}&change=${ids[1]![0]}`, { headers: { cookie } });
    expect(found.status).toBe(200);
    expect(await found.text()).toContain("exceeds the 4 MiB response limit");

    // Evidence mode uses the pinned revision and the member's evidence seam, not its
    // account group. Every fallback link resolves to the named retained change.
    const revision = getRevision(workspace, "pr-52", 1)!;
    const inventory = getStageCapture(revision.capture_id, workspace)!;
    const evidenceBigFile = inventory.files.find((file) => file.path === "src/big.ts")!;
    const bigChange = inventory.changes.find((change) => change.file_id === evidenceBigFile.id)!;
    const seam = evidenceSeams(inventory).find((candidate) => candidate.members.some((member) => member.id === bigChange.id))!;
    const evidence = await fetch(`${base}/${workspace}/r-stacks/stack-budget/v/1?review=l2-${seam.id}`, { headers: { cookie } });
    expect(evidence.headers.get("x-seer-page-fallback")).toBe("over-limit");
    const evidencePage = await evidence.text();
    const evidenceLinks = fallbackLinks(evidencePage);
    expect(evidenceLinks.map((link) => link.kind).sort()).toEqual(["change", "change", "change", "file", "material"]);
    for (const link of evidenceLinks) {
      const target = new URL(link.href, base);
      const bare = link.id.replace(/^l2-/, "");
      expect(target.pathname).toBe(`/${workspace}/r/pr-52/rev/1`);
      expect(target.searchParams.get("review")).toBe(seam.id);
      expect(target.searchParams.get("change")).toBe(link.kind === "change" ? bare : null);
      expect(target.hash).toBe(link.kind === "change" ? `#${bare}` : `#focus-${bare}`);
      const followed = await fetch(target, { headers: { cookie } });
      expect(followed.status).toBe(200);
      expect(await followed.text()).toContain(link.kind === "change" ? `data-change="${bare}"` : `id="focus-${bare}"`);
    }

    // The emergency list can cross the hard limit independently of the diff. It gets its
    // own deterministic pages, every response is bounded, and all four items still link.
    const long = `src/${"x".repeat(2_200_000)}.ts`;
    db.run("UPDATE stage_capture_files SET path = ? WHERE id = ?", [long, leafId]);
    db.run("UPDATE stage_capture_incomplete SET path = ? WHERE id = ?", [long, materialId]);
    const overflowUrl = `${path}&page=2`;
    const overflowFirst = await fetch(overflowUrl, { headers: { cookie } });
    const fallbackPageCount = Number(overflowFirst.headers.get("x-seer-fallback-pages"));
    expect(fallbackPageCount).toBeGreaterThan(1);
    const overflowLinks: ReturnType<typeof fallbackLinks> = [];
    for (let number = 1; number <= fallbackPageCount; number++) {
      const response = number === 1 ? overflowFirst : await fetch(`${overflowUrl}&fallback-page=${number}`, { headers: { cookie } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-seer-fallback-page")).toBe(String(number));
      expect(Number(response.headers.get("x-seer-fallback-bytes"))).toBe(Buffer.byteLength(html));
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(STACK_PAGE_HTML_MAX_BYTES);
      overflowLinks.push(...fallbackLinks(html));
    }
    expect(overflowLinks.map((link) => link.id)).toEqual(links.map((link) => link.id));
    expect(new Set(overflowLinks.map((link) => link.href))).toEqual(new Set(links.map((link) => link.href)));
    db.run("UPDATE stage_capture_files SET path = 'src/structure-only.ts' WHERE id = ?", [leafId]);
    db.run("UPDATE stage_capture_incomplete SET path = 'src/big.ts' WHERE id = ?", [materialId]);
  });
});

// ---- proof 10: rendering and retained lines ----

describe("rendering and lines", () => {
  test("the whole-stack focus draws seams bottom-to-top, one tree row per path with its layer count, and the layer view hides seams", async () => {
    throwingGithub();
    const page = await (await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2/account?review=shared-line`, { headers: { cookie } })).text();
    expect([...page.matchAll(/data-seam="(l[0-9]+)"/g)].map((match) => match[1])).toEqual(["l1", "l2", "l3", "l4"]);
    expect(page).toContain("<main class=\"focus-stream\" data-focus-stream data-seams>");
    expect(page).toContain("4 layers");
    expect(visible(page)).toContain("Whole stack · 4 layers");
    expect(page).toContain('<select class="scope-select" name="layer" data-scope');
    expect(page).toContain('<option value="pr-12"');
    expect(page).toContain('data-layer=""');
    // Every hunk carries its namespaced id, and the read form posts to the stack route. The
    // account over manifest 2 put all eight member groups in this one stack group.
    expect(changeIdsOf(page)).toHaveLength(8);
    expect(page).toContain(`/r-stacks/stack-a/v/2/m/3/changes/l3-chg_`);
    const layer = await (await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2/account?review=shared-line&layer=pr-12`, { headers: { cookie } })).text();
    expect(layer).not.toContain('data-seam="');
    expect(layer).toContain("Layer 2/4 · PR #12");
    expect(layer).toContain('data-layer="pr-12"');
    expect(changeIdsOf(layer)).toHaveLength(2);
    const overview = visible(await (await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2/account`, { headers: { cookie } })).text());
    expect(overview).toContain("v2 account");
    expect(overview).toContain("Manifest 2 · account");
    // A stale group on a resolved stack lands on the stack, not on a miss.
    const stale = await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2?review=gone`, { headers: { cookie }, redirect: "manual" });
    expect(stale.status).toBe(303);
  });

  test("validated member account group order wins when file paths sort in reverse", async () => {
    throwingGithub();
    const page = await (await fetch(`${base}/${workspace}/r-stacks/stack-a/v/2/account?review=shared-line`, { headers: { cookie } })).text();
    const expectedReferenceOrder = ["pr-11", "pr-12", "pr-13", "pr-14"].flatMap((slug, index) => {
      const revision = getRevision(workspace, slug, 1)!;
      const inventory = getStageCapture(revision.capture_id, workspace)!;
      const shared = inventory.files.find((file) => file.path === "src/shared.ts")!;
      return [
        ...inventory.changes.filter((change) => change.file_id === shared.id),
        ...inventory.changes.filter((change) => change.file_id !== shared.id),
      ].map((change) => `l${index + 1}-${change.id}`);
    });
    expect(changeIdsOf(page)).toEqual(expectedReferenceOrder);
  });

  test("a mixed change, material, and leaf-only group renders one reference-ranked seam stream", async () => {
    const fixture = new Map<string, { material: string; leaf: string }>();
    for (const slug of ["pr-91", "pr-92"]) {
      const revision = getRevision(workspace, slug, 1)!;
      const before = getStageCapture(revision.capture_id, workspace)!;
      const leaf = before.files.find((file) => file.path !== "src/shared.ts")!;
      db.run("DELETE FROM stage_capture_changes WHERE capture_id = ? AND file_id = ?", [revision.capture_id, leaf.id]);
      const material = tinyId("sti");
      db.run(
        "INSERT INTO stage_capture_incomplete (id, workspace_id, capture_id, kind, path, side, reason) VALUES (?, ?, ?, 'bytes_unavailable', ?, 'new', 'fixture bytes unavailable')",
        [material, workspace, revision.capture_id, `${slug}.bin`],
      );
      const inventory = getStageCapture(revision.capture_id, workspace)!;
      const groups = [
        { id: "material", title: "Material", category: "Code", importance: "medium", complexity: "low", explanation: "Missing bytes.", examples: [], members: [{ type: "material", id: material, description: "Missing here" }] },
        { id: "leaf", title: "Leaf", category: "Code", importance: "low", complexity: "low", explanation: "Structure only.", examples: [], members: [{ type: "file", id: leaf.id, description: "Leaf here" }] },
        { id: "code", title: "Code", category: "Code", importance: "low", complexity: "low", explanation: "Remaining changes.", examples: [], members: inventory.changes.map((change) => ({ type: "change", id: change.id, description: "Changed here" })) },
      ];
      const published = await fetch(`${base}/api/review-lineages/${slug}/revisions/1/accounts`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ witness: { name: "Witness", model: "review-model" }, summary: `Account of ${slug}.`, groups }),
      });
      expect(published.status).toBe(200);
      fixture.set(slug, { material, leaf: leaf.id });
    }
    const created = await createStack({ slug: "stack-material", members: ["pr-91", "pr-92"] }, "stack-material-create");
    expect(created.status).toBe(201);
    const manifest = (await created.json() as any).manifest;
    const account = stackAccountBody(manifest, { groups: [
      { id: "mixed", title: "Mixed", body: "Code and retained material by member.", examples: [], members: manifest.members.flatMap((member: any) => [
        { lineageId: member.lineageId, revision: 1, accountVersion: 1, groupId: "material" },
        { lineageId: member.lineageId, revision: 1, accountVersion: 1, groupId: "leaf" },
        { lineageId: member.lineageId, revision: 1, accountVersion: 1, groupId: "code" },
      ]) },
    ] });
    expect((await publishStackAccount("stack-material", 1, account)).status).toBe(200);
    throwingGithub();
    const page = await (await fetch(`${base}/${workspace}/r-stacks/stack-material/v/1/account?review=mixed`, { headers: { cookie } })).text();
    expect([...page.matchAll(/<section class="stack-layer">/g)]).toHaveLength(2);
    expect([...page.matchAll(/data-seam="(l[0-9]+)"/g)].map((match) => match[1])).toEqual(["l1", "l2"]);
    const firstSeam = page.indexOf('data-seam="l1"');
    const secondSeam = page.indexOf('data-seam="l2"');
    const first = fixture.get("pr-91")!;
    const second = fixture.get("pr-92")!;
    expect(page.indexOf(`id="focus-l1-${first.material}"`)).toBeGreaterThan(firstSeam);
    expect(page.indexOf(`id="focus-l1-${first.leaf}"`)).toBeLessThan(secondSeam);
    expect(page.indexOf('data-change="l1-chg_')).toBeGreaterThan(firstSeam);
    expect(page.indexOf('data-change="l1-chg_')).toBeLessThan(secondSeam);
    expect(page.indexOf(`id="focus-l2-${second.material}"`)).toBeGreaterThan(secondSeam);
    expect(page.indexOf(`id="focus-l2-${second.leaf}"`)).toBeGreaterThan(secondSeam);
    expect(page.indexOf('data-change="l2-chg_')).toBeGreaterThan(secondSeam);
  });

  test("retained lines resolve through manifest, position and the member's own file id; anything else is the review soft miss", async () => {
    throwingGithub();
    const revision = getRevision(workspace, "pr-12", 1)!;
    const file = getStageCapture(revision.capture_id, workspace)!.files.find((candidate) => candidate.path === "src/shared.ts")!;
    const ok = await fetch(`${base}/api/review-stacks/stack-a/manifests/2/members/2/files/${file.id}?side=new&start=1&end=1`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    const lines = await ok.json() as any;
    validateResponse("readReviewStackMemberFileLines", lines);
    expect(lines.lines[0].text).toBe("export const shared = l2;");
    for (const path of [
      `/api/review-stacks/stack-a/manifests/2/members/1/files/${file.id}?side=new`,
      `/api/review-stacks/stack-a/manifests/99/members/2/files/${file.id}?side=new`,
      `/api/review-stacks/stack-a/manifests/2/members/2/files/stf_nope?side=new`,
      `/api/review-stacks/not-a-stack/manifests/2/members/2/files/${file.id}?side=new`,
    ]) {
      const miss = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ error: "No such review" });
    }
  });
});

// ---- Project integration ----

describe("projects", () => {
  test("a stack attaches to a project, reads in its state and its page, and detaches", async () => {
    const project = await fetch(`${base}/api/projects`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ slug: "stack-project", title: "Stack project" }) });
    expect([200, 201]).toContain(project.status);
    const attach = await fetch(`${base}/api/projects/stack-project/review-stacks/stack-a`, { method: "PUT", headers: { authorization: `Bearer ${key}` } });
    expect(attach.status).toBe(200);
    expect(await attach.json()).toEqual({ project: "stack-project", stack: "stack-a", attached: true });
    expect((await (await fetch(`${base}/api/projects/stack-project/review-stacks/stack-a`, { method: "PUT", headers: { authorization: `Bearer ${key}` } })).json() as any).attached).toBe(false);
    expect((await fetch(`${base}/api/projects/stack-project/review-stacks/nope`, { method: "PUT", headers: { authorization: `Bearer ${key}` } })).status).toBe(404);
    const state = await (await fetch(`${base}/api/projects/stack-project`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    validateResponse("readProject", state);
    expect(state.reviewStacks).toHaveLength(1);
    expect(state.reviewStacks[0]).toMatchObject({ slug: "stack-a", title: "The whole chain", latestManifestVersion: 6, latestAccountVersion: 6 });
    const page = visible(await (await fetch(`${base}/${workspace}/p/stack-project`, { headers: { cookie } })).text());
    expect(page).toContain("The whole chain");
    expect(page).toContain("stack v6");

    await fetch(`${base}/api/projects`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ slug: "stack-summary", title: "Stack summary" }) });
    await fetch(`${base}/api/projects`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ slug: "stack-summary-child", title: "Stack summary child", parent: "stack-summary" }) });
    for (const slug of ["stack-summary", "stack-summary-child"]) {
      const attached = await fetch(`${base}/api/projects/${slug}/review-stacks/stack-a`, { method: "PUT", headers: { authorization: `Bearer ${key}` } });
      expect(attached.status).toBe(200);
    }
    const parentState = await (await fetch(`${base}/api/projects/stack-summary`, { headers: { authorization: `Bearer ${key}` } })).json() as any;
    expect(parentState.reviewStacks).toHaveLength(1);
    expect(parentState.children).toEqual([{ slug: "stack-summary-child", title: "Stack summary child", status: "open", bundles: 0, reviews: 0, reviewLineages: 0, reviewStacks: 1, stages: 0, tasks: 0 }]);
    const ledger = await (await fetch(`${base}/${workspace}/projects`, { headers: { cookie } })).text();
    for (const slug of ["stack-summary", "stack-summary-child"]) {
      const row = ledger.split("<tr").find((entry) => entry.includes(`<span class="row-sub mono">${slug}</span>`));
      expect(row).toContain('<span class="tally-n">1</span><span class="tally-w">review</span>');
    }
    const parentPage = await (await fetch(`${base}/${workspace}/p/stack-summary`, { headers: { cookie } })).text();
    const childRow = parentPage.split("<tr").find((entry) => entry.includes("stack-summary-child"));
    expect(childRow).toContain('<span class="tally-n">1</span><span class="tally-w">review</span>');

    const detach = await fetch(`${base}/api/projects/stack-project/review-stacks/stack-a`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    expect(await detach.json()).toEqual({ project: "stack-project", stack: "stack-a", detached: true });
  });

  test("member pages, reads and lines stay private with auth enabled", async () => {
    const stranger = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [stranger, "stack-stranger@example.com", Date.now()]);
    const revision = getRevision(workspace, "pr-12", 1)!;
    const inventory = getStageCapture(revision.capture_id, workspace)!;
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "stack-privacy.script.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AUTH_DISABLED: undefined as unknown as string,
        DATA_DIR: config.dataDir,
        STACK_WORKSPACE: workspace,
        STACK_SLUG: "stack-a",
        STACK_OWNER: owner,
        STACK_MEMBER: second,
        STACK_STRANGER: stranger,
        STACK_CHANGE: `l2-${inventory.changes[0]!.id}`,
        STACK_FILE: inventory.files.find((file) => file.path === "src/shared.ts")!.id,
        STACK_KEY: key,
        STACK_OTHER_KEY: otherKey,
      },
    });
    const code = await proc.exited;
    const output = await new Response(proc.stdout).text();
    const errors = await new Response(proc.stderr).text();
    if (code !== 0) console.error(output, errors);
    expect(code).toBe(0);
    expect(output).toContain("stack privacy: all assertions passed");
  });
});
