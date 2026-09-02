import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startServer } from "../../src/server";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { config } from "../../src/config";
import { tinyId } from "../../src/ids";
import { appendLocalReply, appendResolutionEvent, createLocalThread, getLocalThread, projectLocalThread } from "../../src/overseer/thread-db";
import { ConversationError } from "../../src/overseer/conversation-types";
import { digestOf } from "../../src/overseer/revision-db";
import type { ValidatedThreadAnchor } from "../../src/overseer/thread-anchors";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let token = "";
let otherMember = "";
let stranger = "";
let foreignToken = "";
let otherMemberToken = "";
const lineageId = tinyId("rln");
const revisionId = tinyId("rvr");
const stackId = tinyId("rsk");
const manifestId = tinyId("rsm");
const ownerCredentialId = tinyId("ghc");
const observedCredentialId = tinyId("ghc");
const stackSlug = "thread-stack";

const anchor = (): ValidatedThreadAnchor => ({
  workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: revisionId,
  account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null,
  group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null,
  range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null,
});

beforeAll(async () => {
  server = await startServer(); base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Local threads", owner);
  token = mintApiKey(owner, workspace, "thread agent").token;
  otherMember = tinyId("usr"); stranger = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, 'thread-member@example.com', ?), (?, 'thread-stranger@example.com', ?)", [otherMember, Date.now(), stranger, Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, otherMember, Date.now()]);
  otherMemberToken = mintApiKey(otherMember, workspace, "other member thread agent").token;
  const foreign = createWorkspace("Foreign threads", stranger);
  foreignToken = mintApiKey(stranger, foreign, "foreign thread agent").token;
  db.run("INSERT INTO review_lineages VALUES (?, ?, 'thread-privacy', 'Acme/Threads', 900, 'feature', 'main', ?, 'Thread privacy', 1, NULL, ?, ?, ?, ?)", [lineageId, workspace, "1".repeat(40), owner, tinyId("key"), Date.now(), Date.now()]);
  const captureId = tinyId("stg");
  const head = "3".repeat(40);
  const revisionDoc = { identity: { lineageId, slug: "thread-privacy", revision: 1, title: "Thread privacy", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Threads", repoId: 900, branch: "feature", originalBaseRef: "main", originalBaseSha: "1".repeat(40), baseRef: "main", sourceHeadSha: head, baseTipSha: "1".repeat(40), mergeBaseSha: "1".repeat(40) }, builder: null, projects: [] };
  db.run("INSERT INTO review_revisions VALUES (?, ?, ?, 'thread-privacy', 1, ?, 1, ?, ?, ?)", [revisionId, workspace, lineageId, captureId, JSON.stringify(revisionDoc), digestOf(revisionDoc), Date.now()]);
  db.run("INSERT INTO review_lineage_prs VALUES (?, ?, 'thread-privacy', 900, 'Acme/Threads', 19, 'feature', 'main', 'user', NULL, ?, ?, ?, NULL)", [lineageId, workspace, owner, ownerCredentialId, Date.now()]);
  const observationId = tinyId("pob");
  db.run("INSERT INTO review_pr_observations VALUES (?, ?, ?, 900, 'Acme/Threads', 19, 'Thread privacy', 'open', 0, 0, 'main', ?, 'feature', ?, ?, ?, ?, 'user', NULL, ?, ?, 'thread-observation')", [observationId, workspace, lineageId, "1".repeat(40), head, "1".repeat(40), Date.now(), Date.now(), otherMember, observedCredentialId]);
  db.run("INSERT INTO review_stacks VALUES (?, ?, ?, 'Thread stack', 'Acme/Threads', 900, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)", [stackId, workspace, stackSlug, owner, tinyId("key"), Date.now(), Date.now()]);
  const manifestDoc = { identity: { stackId, slug: stackSlug, title: "Thread stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date().toISOString() }, repository: { repo: "Acme/Threads", repoId: 900, baseRef: "main" }, source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null }, members: [{ lineageId, lineageSlug: "thread-privacy", prNumber: 19, title: "Thread privacy", revisionId, revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: "feature", headSha: head, status: "live", removedReason: null }], projects: [] };
  db.run("INSERT INTO review_stack_manifests VALUES (?, ?, ?, ?, 1, 0, 'created', 1, ?, ?, ?)", [manifestId, stackId, workspace, stackSlug, JSON.stringify(manifestDoc), digestOf(manifestDoc), Date.now()]);
});
afterAll(() => server.stop(true));

function create(key: string = crypto.randomUUID()) {
  return createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId, anchor: anchor(), body: "First message", author: { kind: "member", userId: owner }, idempotencyKey: key });
}

describe("append-only local conversation", () => {
  test("should create, reply, resolve, reopen and keep exact ordered entries", () => {
    const thread = create("thread-lifecycle");
    appendLocalReply({ workspaceId: workspace, threadId: thread.thread.id, body: "Agent answer", author: { kind: "agent", userId: owner, keyId: tinyId("key"), name: "Agent", model: "model" }, idempotencyKey: "thread-agent" });
    appendResolutionEvent({ workspaceId: workspace, threadId: thread.thread.id, state: "resolved", author: { kind: "member", userId: owner }, idempotencyKey: "thread-resolve" });
    expect(() => appendLocalReply({ workspaceId: workspace, threadId: thread.thread.id, body: "too soon", author: { kind: "member", userId: owner }, idempotencyKey: "thread-closed-reply" })).toThrow(ConversationError);
    appendResolutionEvent({ workspaceId: workspace, threadId: thread.thread.id, state: "open", author: { kind: "member", userId: owner }, idempotencyKey: "thread-reopen" });
    const held = getLocalThread(workspace, thread.thread.id)!;
    expect(held.entries.map((entry) => [entry.seq, entry.kind, entry.body])).toEqual([
      [1, "message", "First message"], [2, "message", "Agent answer"], [3, "resolved", null], [4, "reopened", null],
    ]);
    const projected = projectLocalThread(held, null);
    expect(JSON.stringify(projected)).not.toContain(owner);
    expect(JSON.stringify(projected)).not.toContain("key_");
    expect(projected.entries[1]!.author).toEqual({ kind: "agent", label: "Agent", model: "model" });
  });

  test("should replay identical writes, reject changed hashes and append no duplicate state", () => {
    const first = create("thread-create-replay");
    const replay = create("thread-create-replay");
    expect(replay.thread.id).toBe(first.thread.id);
    expect(() => createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId, anchor: anchor(), body: "Changed", author: { kind: "member", userId: owner }, idempotencyKey: "thread-create-replay" })).toThrow(ConversationError);
    appendResolutionEvent({ workspaceId: workspace, threadId: first.thread.id, state: "resolved", author: { kind: "member", userId: owner }, idempotencyKey: "resolve-once" });
    appendResolutionEvent({ workspaceId: workspace, threadId: first.thread.id, state: "resolved", author: { kind: "member", userId: owner }, idempotencyKey: "resolve-noop" });
    expect(getLocalThread(workspace, first.thread.id)!.entries.filter((entry) => entry.kind === "resolved")).toHaveLength(1);
  });

  test("should let API agents reply concurrently while only sessions change resolution", async () => {
    const thread = create("thread-http");
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => fetch(`${base}/api/review-threads/${thread.thread.id}/replies`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `parallel-${index}` },
      body: JSON.stringify({ body: `reply ${index}`, agentName: "Parallel agent", agentModel: "test" }),
    })));
    expect(replies.every((response) => response.status === 200)).toBe(true);
    const held = getLocalThread(workspace, thread.thread.id)!;
    expect(held.entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));

    const resolve = await fetch(`${base}/${workspace}/review-threads/${thread.thread.id}/resolution`, {
      method: "POST", headers: { accept: "application/json" },
      body: new URLSearchParams({ state: "resolved", idempotencyKey: "session-resolve" }),
    });
    expect(resolve.status).toBe(200);
    const apiResolution = await fetch(`${base}/api/review-threads/${thread.thread.id}/resolution`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(apiResolution.status).toBe(404);
  });

  test("should enforce message, entry, thread-count and UTF-8 aggregate limits", () => {
    expect(() => createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: tinyId("rln"), anchor: anchor(), body: "x".repeat(4001), author: { kind: "member", userId: owner }, idempotencyKey: "body-over-limit" })).toThrow(ConversationError);

    const countScope = tinyId("rln");
    const countRevision = tinyId("rvr");
    const countAnchor = { ...anchor(), lineage_id: countScope, revision_id: countRevision };
    for (let index = 0; index < 500; index++) createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: countScope, anchor: countAnchor, body: "x", author: { kind: "member", userId: owner }, idempotencyKey: `count-${index}` });
    expect(() => createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: countScope, anchor: countAnchor, body: "x", author: { kind: "member", userId: owner }, idempotencyKey: "count-over" })).toThrow(ConversationError);
    const successor = createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: countScope, anchor: { ...countAnchor, revision_id: tinyId("rvr") }, body: "successor stays writable", author: { kind: "member", userId: owner }, idempotencyKey: "count-successor" });
    expect(successor.entries[0]!.body).toBe("successor stays writable");

    const entryThread = create("entry-limit");
    for (let index = 2; index <= 200; index++) appendLocalReply({ workspaceId: workspace, threadId: entryThread.thread.id, body: "x", author: { kind: "member", userId: owner }, idempotencyKey: `entry-${index}` });
    expect(() => appendLocalReply({ workspaceId: workspace, threadId: entryThread.thread.id, body: "x", author: { kind: "member", userId: owner }, idempotencyKey: "entry-over" })).toThrow(ConversationError);

    const byteScope = tinyId("rln");
    const byteRevision = tinyId("rvr");
    const byteThread = createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: byteScope, anchor: { ...anchor(), lineage_id: byteScope, revision_id: byteRevision }, body: "😀".repeat(1000), author: { kind: "member", userId: owner }, idempotencyKey: "bytes-first" });
    let refused = false;
    for (let index = 0; index < 200; index++) {
      try { appendLocalReply({ workspaceId: workspace, threadId: byteThread.thread.id, body: "😀".repeat(1000), author: { kind: "member", userId: owner }, idempotencyKey: `bytes-${index}` }); }
      catch (error) { expect(error).toBeInstanceOf(ConversationError); refused = true; break; }
    }
    expect(refused).toBe(true);
    expect(db.query<{ local_body_bytes: number }, [string, string]>("SELECT local_body_bytes FROM review_thread_scopes WHERE workspace_id = ? AND document_id = ?").get(workspace, byteRevision)!.local_body_bytes).toBeLessThanOrEqual(512 * 1024);
  });

  test("should pass the auth-enabled conversation privacy matrix with GitHub sealed", async () => {
    const thread = create("thread-privacy-matrix");
    const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/conversation-privacy.script.ts`], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DATA_DIR: config.dataDir, PORT: "0", CONV_WORKSPACE: workspace, CONV_SLUG: "thread-privacy", CONV_STACK_SLUG: stackSlug, CONV_OWNER: owner, CONV_MEMBER: otherMember, CONV_STRANGER: stranger, CONV_KEY: token, CONV_MEMBER_KEY: otherMemberToken, CONV_FOREIGN_KEY: foreignToken, CONV_THREAD: thread.thread.id, CONV_OWNER_CREDENTIAL: ownerCredentialId, CONV_OBSERVED_CREDENTIAL: observedCredentialId },
    });
    const code = await proc.exited; const stdout = await new Response(proc.stdout).text(); const stderr = await new Response(proc.stderr).text();
    await Bun.write("/home/kristofferremback/.cache/pi/seer-task9/conversation-privacy.txt", `${stdout}${stderr}`);
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("conversation privacy: all assertions passed");
  });

  test("should keep entries free of update and delete statements", () => {
    const source = readFileSync(new URL("../../src/overseer/thread-db.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/UPDATE\s+review_thread_entries/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+review_thread_entries/i);
    expect(source).not.toMatch(/github.*mutation|mutation.*github/i);
  });
});
