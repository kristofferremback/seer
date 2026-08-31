import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { tinyId } from "../../src/ids";
import { migrate } from "../../src/migrate";
import { saveStageBlob } from "../../src/store";
import { getStageCaptureForWorkspaces } from "../../src/stage/db";
import { getAccountById, getLineage, getRevisionById } from "../../src/overseer/revision-db";
import { validateThreadAnchor } from "../../src/overseer/thread-anchors";
import { ConversationError } from "../../src/overseer/conversation-types";
import { createConversationReadContext, placeImportedThread } from "../../src/overseer/conversation-read";
import type { GithubThreadObservationRow } from "../../src/overseer/conversation-import";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = (value: number) => value.toString(16).padStart(40, "0");
let workspace = "";
let otherWorkspace = "";
let lineageId = "";
let revisionId = "";
let accountId = "";
let fileId = "";
let changeId = "";
let binaryDigest = "";

beforeAll(async () => {
  migrate();
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Thread anchors", owner);
  otherWorkspace = createWorkspace("Other anchors", owner);
  lineageId = tinyId("rln");
  const captureId = tinyId("stg"); revisionId = tinyId("rvr"); accountId = tinyId("rac"); fileId = tinyId("stf");
  const oldText = "same\nold\ntail\n"; const newText = "same\nnew\ntail\n";
  const oldDigest = digest(oldText); const newDigest = digest(newText);
  binaryDigest = digest("binary-anchor");
  await saveStageBlob(workspace, binaryDigest, Uint8Array.from([0, 1, 2]));
  await saveStageBlob(workspace, oldDigest, new TextEncoder().encode(oldText));
  await saveStageBlob(workspace, newDigest, new TextEncoder().encode(newText));
  db.run("INSERT INTO stage_blobs VALUES (?, ?, ?, ?), (?, ?, ?, ?)", [workspace, oldDigest, oldText.length, Date.now(), workspace, newDigest, newText.length, Date.now()]);
  db.run("INSERT INTO stage_captures VALUES (?, ?, 'anchor-review', 'Acme/Anchors', 700, 'feature', 'main', ?, ?, ?, NULL, 'completed', ?)", [captureId, workspace, sha(3), sha(1), sha(1), Date.now()]);
  db.run("INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/a.ts', NULL, 'modified', ?, ?, '100644', '100644', 'blob', 'blob', 1, 1, 'retained', 'retained', ?, ?, NULL, NULL)", [fileId, workspace, captureId, sha(10), sha(11), oldDigest, newDigest]);
  changeId = `chg_${digest("anchor-change")}`;
  db.run("INSERT INTO stage_capture_changes VALUES (?, ?, ?, ?, 2, 1, 2, 1, ?, ?, ?, 'reconstructed')", [changeId, workspace, captureId, fileId, digest("old"), digest("new"), digest("same")]);
  db.run("INSERT INTO review_lineages VALUES (?, ?, 'anchor-review', 'Acme/Anchors', 700, 'feature', 'main', ?, 'Anchors', 1, 1, ?, ?, ?, ?)", [lineageId, workspace, sha(1), owner, tinyId("key"), Date.now(), Date.now()]);
  const revisionDoc = { identity: { lineageId, slug: "anchor-review", revision: 1, title: "Anchors", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Anchors", repoId: 700, branch: "feature", originalBaseRef: "main", originalBaseSha: sha(1), baseRef: "main", sourceHeadSha: sha(3), baseTipSha: sha(1), mergeBaseSha: sha(1) }, builder: null, projects: [] };
  db.run("INSERT INTO review_revisions VALUES (?, ?, ?, 'anchor-review', 1, ?, 1, ?, ?, ?)", [revisionId, workspace, lineageId, captureId, JSON.stringify(revisionDoc), digest(JSON.stringify(revisionDoc)), Date.now()]);
  const accountDoc = { identity: { lineageId, slug: "anchor-review", revision: 1, version: 1, createdAt: new Date().toISOString() }, witness: { summary: "Exact groups.", agent: { name: "Witness", model: "test" }, userId: owner, keyId: tinyId("key") }, groups: [{ id: "exact", title: "Exact", category: "Code", importance: "high", complexity: "low", explanation: "Exact.", examples: [], members: [{ type: "change", id: changeId, description: "Changed line." }] }], focus: [], evidence: [] };
  db.run("INSERT INTO review_accounts VALUES (?, ?, ?, ?, 1, 'anchor-review', 1, 1, ?, ?, ?, ?, ?)", [accountId, workspace, lineageId, revisionId, JSON.stringify(accountDoc), digest(JSON.stringify(accountDoc)), owner, tinyId("key"), Date.now()]);
});

function context() {
  return { kind: "review" as const, workspaceId: workspace, lineage: getLineage(workspace, "anchor-review")!, revision: getRevisionById(workspace, revisionId)!, account: getAccountById(workspace, accountId)!, inventory: getStageCaptureForWorkspaces(getRevisionById(workspace, revisionId)!.capture_id, [workspace])! };
}

async function rule(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "none"; } catch (error) { return error instanceof ConversationError ? error.rule : "other"; }
}

describe("exact thread anchors", () => {
  test("should pin review, account, group, change, changed range and unchanged range", async () => {
    expect((await validateThreadAnchor({ kind: "review" }, context())).revision_id).toBe(revisionId);
    expect((await validateThreadAnchor({ kind: "account", accountId }, context())).account_id).toBe(accountId);
    expect((await validateThreadAnchor({ kind: "member_group", accountId, groupId: "exact" }, context())).group_id).toBe("exact");
    const change = await validateThreadAnchor({ kind: "change", changeId }, context());
    expect(change).toMatchObject({ revision_id: revisionId, file_id: fileId, change_id: changeId });
    expect(change.old_object_digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 2, endLine: 2 }, context())).range_kind).toBe("changed");
    expect((await validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 1 }, context())).range_kind).toBe("unchanged");
  });

  test("should pin stack and stack-group anchors to one exact account and manifest", async () => {
    const stackId = tinyId("rsk"); const manifestId = tinyId("rsm"); const stackAccountId = tinyId("rsa");
    const stackContext = {
      kind: "stack" as const, workspaceId: workspace,
      stack: { id: stackId, workspace_id: workspace, slug: "anchor-stack" },
      manifest: { id: manifestId, stack_id: stackId, workspace_id: workspace },
      account: { id: stackAccountId, stack_id: stackId, manifest_id: manifestId, workspace_id: workspace, doc: { groups: [{ id: "whole" }] } },
    } as any;
    expect(await validateThreadAnchor({ kind: "stack", stackAccountId }, stackContext)).toMatchObject({ stack_id: stackId, stack_manifest_id: manifestId, stack_account_id: stackAccountId });
    expect(await validateThreadAnchor({ kind: "stack_group", stackAccountId, groupId: "whole" }, stackContext)).toMatchObject({ group_id: "whole", stack_account_id: stackAccountId });
    expect(await rule(validateThreadAnchor({ kind: "stack_group", stackAccountId, groupId: "later" }, stackContext))).toBe("anchor_group");
  });

  test("should place imported left and right ranges only against exact retained code", async () => {
    const observed: GithubThreadObservationRow = { id: tinyId("rgo"), workspace_id: workspace, thread_id: tinyId("rgt"), source_kind: "graphql", source_id: "import", source_observed_at: 1, path: "src/a.ts", side: "new", start_line: 2, end_line: 2, original_start_line: 2, original_end_line: 2, commit_sha: sha(3), original_commit_sha: sha(3), resolved: 0, outdated: 0, deleted: 0, github_url: "https://github.test/comment", digest: "digest", observed_at: 1 };
    expect(await placeImportedThread(workspace, context().lineage, observed)).toMatchObject({ kind: "code", revisionId, fileId, side: "new", startLine: 2 });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, side: "old" })).toMatchObject({ kind: "code", side: "old" });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, outdated: 1, commit_sha: sha(99), original_commit_sha: sha(3) })).toMatchObject({ kind: "code", revisionId });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, commit_sha: sha(99) })).toEqual({ kind: "conversation", reason: "commit_not_retained" });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, path: "missing.ts" })).toEqual({ kind: "conversation", reason: "path_not_retained" });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, start_line: 99, end_line: 99 })).toEqual({ kind: "conversation", reason: "line_not_retained" });
    expect(await placeImportedThread(workspace, context().lineage, { ...observed, start_line: 1, end_line: 4 })).toEqual({ kind: "conversation", reason: "line_not_retained" });

    const placementContext = createConversationReadContext(workspace);
    await Promise.all([
      placeImportedThread(workspace, context().lineage, observed, placementContext),
      placeImportedThread(workspace, context().lineage, { ...observed, start_line: 1, end_line: 1 }, placementContext),
    ]);
    expect({ lineages: placementContext.lineages.size, inventories: placementContext.inventories.size, retainedObjects: placementContext.retainedObjects.size }).toEqual({ lineages: 1, inventories: 1, retainedObjects: 1 });
  });

  test("should refuse mixed, absent, unavailable, non-text, oversized and cross-workspace authority", async () => {
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 2 }, context()))).toBe("anchor_mixed");
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 201 }, context()))).toBe("anchor_range");
    const unavailable = context(); unavailable.inventory = { ...unavailable.inventory, files: unavailable.inventory.files.map((file) => file.id === fileId ? { ...file, new_availability: "unavailable", new_blob_sha: null } : file) };
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 1 }, unavailable))).toBe("anchor_unretained");
    const symlink = context(); symlink.inventory = { ...symlink.inventory, files: symlink.inventory.files.map((file) => file.id === fileId ? { ...file, new_kind: "symlink" } : file) };
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 1 }, symlink))).toBe("anchor_unretained");
    const binary = context(); binary.inventory = { ...binary.inventory, files: binary.inventory.files.map((file) => file.id === fileId ? { ...file, new_blob_sha: binaryDigest } : file) };
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 1 }, binary))).toBe("anchor_binary");
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 99, endLine: 99 }, context()))).toBe("anchor_lines");
    expect(await rule(validateThreadAnchor({ kind: "range", fileId, side: "new", startLine: 1, endLine: 4 }, context()))).toBe("anchor_lines");
    expect(await rule(validateThreadAnchor({ kind: "change", changeId: `chg_${"0".repeat(64)}` }, context()))).toBe("anchor_unknown");
    const foreign = { ...context(), workspaceId: otherWorkspace };
    expect(await rule(validateThreadAnchor({ kind: "change", changeId }, foreign))).toBe("anchor_scope");
    // The route constructs contexts from workspace-scoped rows; a forged context is not a public seam.
    expect(getRevisionById(otherWorkspace, revisionId)).toBeNull();
  });
});
