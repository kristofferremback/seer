import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { sessionCookie } from "../../src/auth";
import { startServer } from "../../src/server";
import { tinyId } from "../../src/ids";
import { migrate } from "../../src/migrate";
import { carryRevisionAcknowledgements, setRevisionAcknowledgement } from "../../src/overseer/acknowledgements-db";
import {
  JUDGMENT_COMMENT_MAX,
  JudgmentWriteError,
  getMyRevisionJudgment,
  getMyStackJudgment,
  judgeRevision,
  judgeStackManifest,
  listRevisionJudgments,
  listStackJudgments,
  normalizeJudgmentComment,
  stackAcknowledgementState,
} from "../../src/overseer/judgments-db";
import { digestOf, getLineage, getRevisionById, storeRevisionMovement } from "../../src/overseer/revision-db";
import { revisionMovement } from "../../src/overseer/revision-pr";
import { requiredAcknowledgements, revisionCodeDelta } from "../../src/overseer/revision-delta";
import { getStageCaptureForWorkspaces, type StageCaptureInventory } from "../../src/stage/db";
import type { StackManifestDoc } from "../../src/overseer/stack-types";
import { createDocumentCapability } from "../../src/overseer/capability-db";
import { workspaceMemberLabels } from "../../src/overseer/thread-db";
import { resolveStackRead } from "../../src/overseer/stack-render";
import { ChromePage } from "../chrome";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workspace = "";
let otherWorkspace = "";
let owner = "";
let teammate = "";
let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let cookie = "";
let key = "";
let sequence = 0;

const sha = (value: number) => value.toString(16).padStart(40, "0");
const fp = (value: string) => value.padEnd(64, value).slice(0, 64);
const visible = (page: string) => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");

interface Fixture {
  workspaceId: string;
  lineageId: string;
  slug: string;
  revisionId: string;
  revision: number;
  captureId: string;
  changeId: string;
  inventory: StageCaptureInventory;
}

function createRevision(input: { workspaceId?: string; lineageId?: string; slug?: string; revision?: number; materialOnly?: boolean; empty?: boolean } = {}): Fixture {
  sequence += 1;
  const workspaceId = input.workspaceId ?? workspace;
  const lineageId = input.lineageId ?? tinyId("rln");
  const slug = input.slug ?? `judgment-${sequence}`;
  const revision = input.revision ?? 1;
  const captureId = tinyId("stg");
  const revisionId = tinyId("rvr");
  const textFile = tinyId("stf");
  const binaryFile = tinyId("stf");
  const leafFile = tinyId("stf");
  const changeId = `chg_${sequence.toString(16).padStart(64, "0")}`;
  const binaryMaterial = tinyId("sti");
  const captureMaterial = tinyId("sti");
  const now = Date.now() + sequence;

  if (!input.lineageId) {
    db.run(
      "INSERT INTO review_lineages VALUES (?, ?, ?, 'Acme/Judgment', 1200, 'feature/judgment', 'main', ?, 'Exact judgment', ?, NULL, ?, ?, ?, ?)",
      [lineageId, workspaceId, slug, sha(1), revision, owner, tinyId("key"), now, now],
    );
  } else {
    db.run("UPDATE review_lineages SET latest_revision = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", [revision, now, lineageId, workspaceId]);
  }
  db.run(
    "INSERT INTO stage_captures VALUES (?, ?, ?, 'Acme/Judgment', 1200, 'feature/judgment', 'main', ?, ?, ?, NULL, 'completed', ?)",
    [captureId, workspaceId, slug, sha(100 + sequence), sha(1), sha(1), now],
  );
  if (!input.materialOnly && !input.empty) {
    db.run(
      "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/value.ts', NULL, 'modified', ?, ?, '100644', '100644', 'blob', 'blob', 1, 1, 'retained', 'retained', NULL, NULL, NULL, NULL)",
      [textFile, workspaceId, captureId, sha(10), sha(11)],
    );
  }
  if (!input.empty) {
    db.run(
      "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'assets/logo.png', NULL, 'modified', ?, ?, '100644', '100644', 'blob', 'blob', 0, 0, 'retained', 'retained', NULL, NULL, NULL, NULL)",
      [binaryFile, workspaceId, captureId, sha(20), sha(21 + sequence)],
    );
    db.run(
      "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'bin/run.sh', NULL, 'mode_changed', ?, ?, '100644', '100755', 'blob', 'blob', 0, 0, 'retained', 'retained', NULL, NULL, NULL, NULL)",
      [leafFile, workspaceId, captureId, sha(30), sha(30)],
    );
  }
  if (!input.materialOnly && !input.empty) {
    db.run(
      "INSERT INTO stage_capture_changes VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?, 'patch')",
      [changeId, workspaceId, captureId, textFile, fp("old"), fp("new"), fp("context")],
    );
  }
  if (!input.empty) {
    db.run(
      "INSERT INTO stage_capture_incomplete VALUES (?, ?, ?, 'lines_unavailable', 'assets/logo.png', 'new', 'Binary bytes are retained.')",
      [binaryMaterial, workspaceId, captureId],
    );
    db.run(
      "INSERT INTO stage_capture_incomplete VALUES (?, ?, ?, 'metadata_incomplete', NULL, 'snapshot', 'GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist.')",
      [captureMaterial, workspaceId, captureId],
    );
  }
  const document = {
    identity: { lineageId, slug, revision, title: "Exact judgment", createdAt: new Date(now).toISOString() },
    source: {
      captureId, repo: "Acme/Judgment", repoId: 1200, branch: "feature/judgment",
      originalBaseRef: "main", originalBaseSha: sha(1), baseRef: "main",
      sourceHeadSha: sha(100 + sequence), baseTipSha: sha(1), mergeBaseSha: sha(1),
    },
    builder: null,
    projects: [],
  };
  db.run(
    "INSERT INTO review_revisions VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    [revisionId, workspaceId, lineageId, slug, revision, captureId, JSON.stringify(document), digestOf(document), now],
  );
  const inventory = getStageCaptureForWorkspaces(captureId, [workspaceId])!;
  return { workspaceId, lineageId, slug, revisionId, revision, captureId, changeId, inventory };
}

function acknowledgeAll(fixture: Fixture, userId = owner): void {
  for (const item of requiredAcknowledgements(fixture.inventory)) {
    setRevisionAcknowledgement({
      workspaceId: fixture.workspaceId,
      lineageId: fixture.lineageId,
      revisionId: fixture.revisionId,
      userId,
      item,
      acknowledged: true,
    });
  }
}

function createAccount(fixture: Fixture): { id: string; version: number } {
  const id = tinyId("rac");
  const version = 1;
  const document = {
    identity: { lineageId: fixture.lineageId, slug: fixture.slug, revision: fixture.revision, version, createdAt: new Date().toISOString() },
    witness: { summary: "Exact retained material.", agent: { name: "Witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    groups: [{
      id: "all-material",
      title: "Retained material",
      category: "Code",
      importance: "high",
      complexity: "low",
      explanation: "Review every retained gap.",
      examples: [],
      members: requiredAcknowledgements(fixture.inventory).map((item) => ({ type: item.type, id: item.id, description: item.path ?? "Capture material" })),
    }],
    focus: [],
    evidence: [],
  };
  db.run(
    "INSERT INTO review_accounts VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
    [id, fixture.workspaceId, fixture.lineageId, fixture.revisionId, fixture.revision, fixture.slug, version, JSON.stringify(document), digestOf(document), owner, document.witness.keyId, Date.now()],
  );
  db.run("UPDATE review_lineages SET latest_account_version = 1 WHERE id = ?", [fixture.lineageId]);
  return { id, version };
}

interface StackFixture {
  stackId: string;
  slug: string;
  manifestId: string;
  version: number;
}

function createManifest(members: { fixture: Fixture; removed?: boolean; account?: { id: string; version: number } }[], input: { stackId?: string; slug?: string; version?: number } = {}): StackFixture {
  sequence += 1;
  const stackId = input.stackId ?? tinyId("rsk");
  const slug = input.slug ?? `judgment-stack-${sequence}`;
  const version = input.version ?? 1;
  const manifestId = tinyId("rsm");
  const now = Date.now() + sequence;
  if (!input.stackId) {
    db.run(
      "INSERT INTO review_stacks VALUES (?, ?, ?, 'Exact stack judgment', 'Acme/Judgment', 1200, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, ?, ?, ?, ?, ?)",
      [stackId, workspace, slug, version, owner, tinyId("key"), now, now],
    );
  } else {
    db.run("UPDATE review_stacks SET latest_manifest_version = ?, updated_at = ? WHERE id = ?", [version, now, stackId]);
  }
  const doc: StackManifestDoc = {
    identity: { stackId, slug, title: "Exact stack judgment", version, predecessorVersion: version - 1, reason: version === 1 ? "created" : "refresh", createdAt: new Date(now).toISOString() },
    repository: { repo: "Acme/Judgment", repoId: 1200, baseRef: "main" },
    source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null },
    members: members.map(({ fixture }, index) => {
      const revisionRow = getRevisionById(workspace, fixture.revisionId)!;
      return {
        lineageId: fixture.lineageId,
        lineageSlug: fixture.slug,
        prNumber: 200 + index,
        title: `Member ${index + 1}`,
        revisionId: fixture.revisionId,
        revision: fixture.revision,
        accountId: members[index]!.account?.id ?? null,
        accountVersion: members[index]!.account?.version ?? null,
        baseRef: revisionRow.doc.source.baseRef,
        headRef: revisionRow.doc.source.branch,
        headSha: revisionRow.doc.source.sourceHeadSha,
        status: members[index]!.removed ? "removed" as const : "live" as const,
        removedReason: members[index]!.removed ? "unstacked" as const : null,
      };
    }),
    projects: [],
  };
  db.run(
    "INSERT INTO review_stack_manifests VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    [manifestId, stackId, workspace, slug, version, version - 1, version === 1 ? "created" : "refresh", JSON.stringify(doc), digestOf(doc), now],
  );
  return { stackId, slug, manifestId, version };
}

function createStackAccount(stack: StackFixture, members: { fixture: Fixture; account: { id: string; version: number } }[]): string {
  const id = tinyId("rsa");
  const document = {
    identity: { stackId: stack.stackId, slug: stack.slug, manifestId: stack.manifestId, version: stack.version, createdAt: new Date().toISOString() },
    witness: { summary: "The exact stack account.", agent: { name: "Stack witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    groups: [{
      id: "whole",
      title: "Whole stack",
      body: "Every member's exact retained material.",
      examples: [],
      members: members.map(({ fixture, account }) => ({ lineageId: fixture.lineageId, revision: fixture.revision, accountVersion: account.version, groupId: "all-material" })),
    }],
  };
  db.run(
    "INSERT INTO review_stack_accounts VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
    [id, stack.stackId, stack.manifestId, workspace, stack.slug, stack.version, JSON.stringify(document), digestOf(document), owner, document.witness.keyId, Date.now()],
  );
  return id;
}

beforeAll(async () => {
  migrate();
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Judgments", owner);
  otherWorkspace = createWorkspace("Foreign judgments", owner);
  teammate = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, 'judgment-teammate@example.com', ?)", [teammate, Date.now()]);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, teammate, Date.now()]);
  key = mintApiKey(owner, workspace, "judgments").token;
  cookie = sessionCookie(owner).split(";")[0]!;
  server = await startServer();
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

describe("one exact revision judgment", () => {
  test("every unavailable item blocks atomically while reads and open threads do not imply a verdict", () => {
    const fixture = createRevision();
    db.run("INSERT INTO review_threads VALUES (?, ?, 'lineage', ?, NULL, ?, 1, ?)", [tinyId("rth"), workspace, fixture.lineageId, owner, Date.now()]);
    const importedThread = tinyId("rgt");
    db.run("INSERT INTO review_github_threads VALUES (?, ?, ?, 1200, 1, ?, NULL, ?)", [importedThread, workspace, fixture.lineageId, `node-${sequence}`, Date.now()]);
    db.run("INSERT INTO review_github_thread_observations (id, workspace_id, thread_id, source_kind, source_id, source_observed_at, resolved, outdated, deleted, digest, observed_at) VALUES (?, ?, ?, 'webhook', ?, ?, 0, 0, 0, ?, ?)", [tinyId("rgo"), workspace, importedThread, `source-${sequence}`, Date.now(), `digest-${sequence}`, Date.now()]);

    let error: JudgmentWriteError | null = null;
    try {
      judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "" });
    } catch (caught) {
      error = caught as JudgmentWriteError;
    }
    expect(error).toBeInstanceOf(JudgmentWriteError);
    expect(error?.status).toBe(422);
    expect(error?.rule).toBe("acknowledgements_required");
    expect(error?.blockers.map((blocker) => blocker.itemType).sort()).toEqual(["file", "material", "material"]);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id = ?").get(fixture.revisionId)!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_revision_judgment_items").get()!.n).toBe(0);

    acknowledgeAll(fixture);
    const result = judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "Judged with unread code and open threads." });
    expect(result.created).toBe(true);
    expect(result.judgment).toMatchObject({ verdict: "approved", scope: { kind: "revision", revision: 1 } });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgment_items WHERE judgment_id = ?").get(result.judgment.id)!.n).toBe(3);
    expect(db.query<{ required_count: number; acknowledgement_digest: string }, [string]>("SELECT required_count, acknowledgement_digest FROM review_revision_judgments WHERE id = ?").get(result.judgment.id)).toMatchObject({ required_count: 3, acknowledgement_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  test("a successful verdict snapshots explicit and carried provenance", () => {
    const source = createRevision({ materialOnly: true });
    const target = createRevision({ lineageId: source.lineageId, slug: source.slug, revision: 2, materialOnly: true });
    const sourceMaterial = requiredAcknowledgements(source.inventory).find((item) => item.type === "material" && item.path === null)!;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: source.lineageId, revisionId: source.revisionId, userId: owner, item: sourceMaterial, acknowledged: true });
    const delta = revisionCodeDelta(source.inventory, target.inventory);
    db.transaction(() => {
      storeRevisionMovement({ workspaceId: workspace, lineageId: source.lineageId, previousRevisionId: source.revisionId, revisionId: target.revisionId, counts: delta.counts, readEquivalences: delta.readEquivalences, ackEquivalences: delta.ackEquivalences, now: Date.now() });
      carryRevisionAcknowledgements({ workspaceId: workspace, lineageId: source.lineageId, sourceRevisionId: source.revisionId, targetRevisionId: target.revisionId, equivalences: delta.ackEquivalences, now: Date.now() });
    })();
    for (const item of requiredAcknowledgements(target.inventory)) {
      const active = db.query<{ found: number }, [string, string, string]>("SELECT 1 AS found FROM review_revision_acknowledgements WHERE revision_id = ? AND user_id = ? AND item_id = ?").get(target.revisionId, owner, item.id);
      if (!active) setRevisionAcknowledgement({ workspaceId: workspace, lineageId: target.lineageId, revisionId: target.revisionId, userId: owner, item, acknowledged: true });
    }
    const result = judgeRevision({ workspaceId: workspace, lineageId: target.lineageId, revisionId: target.revisionId, userId: owner, verdict: "approved", comment: "" });
    const snapshots = db.query<{ provenance_kind: string; source_revision_id: string | null; source_item_id: string | null }, [string]>("SELECT provenance_kind, source_revision_id, source_item_id FROM review_revision_judgment_items WHERE judgment_id = ? ORDER BY item_id").all(result.judgment.id);
    expect(snapshots.some((item) => item.provenance_kind === "carried" && item.source_revision_id === source.revisionId && item.source_item_id === sourceMaterial.id)).toBe(true);
    expect(snapshots.some((item) => item.provenance_kind === "explicit")).toBe(true);
  });

  test("a direct target acknowledgement then reversal blocks an older late acknowledgement and judgment", () => {
    const source = createRevision({ materialOnly: true });
    const target = createRevision({ lineageId: source.lineageId, slug: source.slug, revision: 2, materialOnly: true });
    const delta = revisionCodeDelta(source.inventory, target.inventory);
    storeRevisionMovement({ workspaceId: workspace, lineageId: source.lineageId, previousRevisionId: source.revisionId, revisionId: target.revisionId, counts: delta.counts, readEquivalences: delta.readEquivalences, ackEquivalences: delta.ackEquivalences, now: Date.now() });
    acknowledgeAll(target);
    const targetItem = requiredAcknowledgements(target.inventory).find((item) => item.type === "material" && item.path === null)!;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: target.lineageId, revisionId: target.revisionId, userId: owner, item: targetItem, acknowledged: false });
    const sourceItem = requiredAcknowledgements(source.inventory).find((item) => item.type === "material" && item.path === null)!;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: source.lineageId, revisionId: source.revisionId, userId: owner, item: sourceItem, acknowledged: true });

    expect(db.query("SELECT 1 FROM review_revision_acknowledgements WHERE revision_id = ? AND user_id = ? AND item_id = ?").get(target.revisionId, owner, targetItem.id)).toBeNull();
    expect(db.query("SELECT 1 FROM review_revision_acknowledgement_carries WHERE target_revision_id = ? AND user_id = ? AND target_item_id = ?").get(target.revisionId, owner, targetItem.id)).toBeNull();
    let blocked: JudgmentWriteError | null = null;
    try {
      judgeRevision({ workspaceId: workspace, lineageId: target.lineageId, revisionId: target.revisionId, userId: owner, verdict: "approved", comment: "" });
    } catch (error) { blocked = error as JudgmentWriteError; }
    expect(blocked?.rule).toBe("acknowledgements_required");
    expect(blocked?.blockers.map((item) => item.itemId)).toEqual([targetItem.id]);
  });

  test("a snapshot insert failure rolls back the verdict", () => {
    const fixture = createRevision();
    acknowledgeAll(fixture);
    db.run("CREATE TEMP TRIGGER fail_judgment_snapshot BEFORE INSERT ON review_revision_judgment_items BEGIN SELECT RAISE(ABORT, 'snapshot failed'); END");
    try {
      expect(() => judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "" })).toThrow("snapshot failed");
    } finally {
      db.run("DROP TRIGGER fail_judgment_snapshot");
    }
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id = ?").get(fixture.revisionId)!.n).toBe(0);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgment_items WHERE judgment_id IN (SELECT id FROM review_revision_judgments WHERE revision_id = ?)").get(fixture.revisionId)!.n).toBe(0);
  });

  test("concurrent exact replay converges, while another verdict or comment cannot rewrite the winner", async () => {
    const fixture = createRevision();
    acknowledgeAll(fixture);
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/judgment`, {
      method: "POST",
      headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "changes_requested", comment: "Please fix `value`.\r\n" }),
    })));
    const results = await Promise.all(responses.map((response) => response.json() as Promise<any>));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(11);
    expect(new Set(results.map((result) => result.judgment.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]!.judgment.comment).toBe("Please fix `value`.\n");
    const before = db.query("SELECT * FROM review_revision_judgments WHERE revision_id = ?").get(fixture.revisionId);
    expect(() => judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "Please fix `value`." })).toThrow("immutable");
    expect(() => judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "changes_requested", comment: "Different" })).toThrow("immutable");
    expect(db.query("SELECT * FROM review_revision_judgments WHERE revision_id = ?").get(fixture.revisionId)).toEqual(before);
  });

  test("an exact replay keeps its original acknowledgement history after active timestamps change", () => {
    const fixture = createRevision();
    acknowledgeAll(fixture);
    const first = judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "Stable replay.\r\n" });
    const rowBefore = db.query("SELECT * FROM review_revision_judgments WHERE id = ?").get(first.judgment.id);
    const itemsBefore = db.query("SELECT * FROM review_revision_judgment_items WHERE judgment_id = ? ORDER BY item_id").all(first.judgment.id);
    const changed = requiredAcknowledgements(fixture.inventory)[0]!;
    const originalAt = db.query<{ acknowledged_at: number }, [string, string]>("SELECT acknowledged_at FROM review_revision_acknowledgements WHERE revision_id = ? AND item_id = ?").get(fixture.revisionId, changed.id)!.acknowledged_at;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, item: changed, acknowledged: false, now: originalAt + 1 });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, item: changed, acknowledged: true, now: originalAt + 10_000 });
    expect(db.query<{ acknowledged_at: number }, [string, string]>("SELECT acknowledged_at FROM review_revision_acknowledgements WHERE revision_id = ? AND item_id = ?").get(fixture.revisionId, changed.id)!.acknowledged_at).toBe(originalAt + 10_000);

    const replay = judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "Stable replay.\n" });
    expect(replay).toMatchObject({ created: false, judgment: { id: first.judgment.id } });
    expect(db.query("SELECT * FROM review_revision_judgments WHERE id = ?").get(first.judgment.id)).toEqual(rowBefore);
    expect(db.query("SELECT * FROM review_revision_judgment_items WHERE judgment_id = ? ORDER BY item_id").all(first.judgment.id)).toEqual(itemsBefore);
  });

  test("members judge independently and each projection uses typed display actors", () => {
    const fixture = createRevision();
    acknowledgeAll(fixture, owner);
    acknowledgeAll(fixture, teammate);
    judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "" });
    judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: teammate, verdict: "changes_requested", comment: "One issue." });
    const publicViews = listRevisionJudgments(workspace, fixture.revisionId);
    expect(publicViews).toHaveLength(2);
    expect(publicViews.map((view) => view.by)).toEqual([
      { kind: "member", label: "Member" },
      { kind: "member", label: "Member" },
    ]);
    const privateViews = listRevisionJudgments(workspace, fixture.revisionId, { viewerId: owner, memberLabels: workspaceMemberLabels(workspace) });
    expect(privateViews.find((view) => view.verdict === "approved")?.by).toEqual({ kind: "member", label: "You" });
    expect(privateViews.find((view) => view.verdict === "changes_requested")?.by).toEqual({ kind: "member", label: "judgment-teammate" });
    const serialized = JSON.stringify(privateViews);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(owner);
    expect(serialized).not.toContain(teammate);
  });

  test("a successor starts without judgment and another workspace cannot resolve or write it", () => {
    const first = createRevision();
    acknowledgeAll(first);
    judgeRevision({ workspaceId: workspace, lineageId: first.lineageId, revisionId: first.revisionId, userId: owner, verdict: "approved", comment: "" });
    const successor = createRevision({ lineageId: first.lineageId, slug: first.slug, revision: 2 });
    expect(getMyRevisionJudgment(workspace, successor.revisionId, owner)).toBeNull();
    expect(listRevisionJudgments(otherWorkspace, first.revisionId)).toEqual([]);
    expect(() => judgeRevision({ workspaceId: otherWorkspace, lineageId: first.lineageId, revisionId: first.revisionId, userId: owner, verdict: "approved", comment: "" })).toThrow("No such review");
    expect(getMyRevisionJudgment(workspace, first.revisionId, owner)?.verdict).toBe("approved");
  });

  test("an exact revision with no gaps can be judged from its overview", async () => {
    const fixture = createRevision({ empty: true });
    const path = `/${workspace}/r/${fixture.slug}/rev/1`;
    const page = visible(await (await fetch(`${base}${path}`, { headers: { cookie } })).text());
    expect(page).toContain("judgment-form");
    expect(page).toContain("0 unread · 0 open threads");
    const response = await fetch(`${base}${path}/judgment`, {
      method: "POST", headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "approved", comment: "" }),
    });
    expect(response.status).toBe(201);
    const result = await response.json() as any;
    expect(db.query<{ required_count: number }, [string]>("SELECT required_count FROM review_revision_judgments WHERE id = ?").get(result.judgment.id)?.required_count).toBe(0);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgment_items WHERE judgment_id = ?").get(result.judgment.id)!.n).toBe(0);
  });

  test("an ordinary overview puts one exact-document judgment in its source and phone Details rail", async () => {
    const fixture = createRevision({ materialOnly: true });
    createAccount(fixture);
    const html = visible(await (await fetch(`${base}/${workspace}/r/${fixture.slug}/v/1`, { headers: { cookie } })).text());
    expect(html.match(/class="judgment"/g)).toHaveLength(1);
    expect(html.match(/class="judgment-form"/g)).toHaveLength(1);
    expect(html).toMatch(/<aside class="source-rail"[^>]*>[\s\S]*class="judgment"/);
    expect(html).toContain("0 / 3 handled");
    expect(html).not.toContain("0 / 0 read");
    expect(html).toContain("data-page-details-open");
    expect(html).toContain("data-judgment-host=\"overview\"");
    expect(html).toContain("button type=\"submit\" name=\"verdict\" value=\"approved\" disabled");
  });

  test("comments are normalized constrained markdown, optional, and bounded", () => {
    expect(normalizeJudgmentComment("")).toBe("");
    expect(normalizeJudgmentComment("Line one\r\n\r\nLine two.\n")).toBe("Line one\n\nLine two.\n");
    expect(() => normalizeJudgmentComment("    indented")).toThrow("indented code block");
    expect(() => normalizeJudgmentComment("# heading")).toThrow();
    expect(() => normalizeJudgmentComment("x".repeat(JUDGMENT_COMMENT_MAX + 1))).toThrow("over budget");
  });
});

describe("one exact manifest judgment", () => {
  test("stack acknowledgement state reuses resolved inventories and still refuses missing retained evidence", () => {
    const first = createRevision();
    const second = createRevision();
    const stack = createManifest([{ fixture: first }, { fixture: second }]);
    const resolved = resolveStackRead(workspace, stack.slug, { version: "1", account: false })!;
    for (const fixture of [first, second]) {
      db.run("DELETE FROM stage_capture_changes WHERE capture_id = ?", [fixture.captureId]);
      db.run("DELETE FROM stage_capture_incomplete WHERE capture_id = ?", [fixture.captureId]);
      db.run("DELETE FROM stage_capture_files WHERE capture_id = ?", [fixture.captureId]);
      db.run("DELETE FROM stage_captures WHERE id = ?", [fixture.captureId]);
    }
    expect(stackAcknowledgementState(workspace, resolved.manifest, owner, resolved.members).requiredCount).toBe(6);
    expect(() => stackAcknowledgementState(workspace, resolved.manifest, owner)).toThrow("No such review");
  });

  test("removed pinned members contribute gaps, and stack and revision verdicts stay independent", () => {
    const first = createRevision();
    const removed = createRevision();
    const stack = createManifest([{ fixture: first }, { fixture: removed, removed: true }]);
    acknowledgeAll(first);
    let blocked: JudgmentWriteError | null = null;
    try {
      judgeStackManifest({ workspaceId: workspace, stackId: stack.stackId, manifestId: stack.manifestId, userId: owner, verdict: "approved", comment: "" });
    } catch (error) { blocked = error as JudgmentWriteError; }
    expect(blocked?.blockers).toHaveLength(3);
    expect(new Set(blocked?.blockers.map((item) => item.revisionId))).toEqual(new Set([removed.revisionId]));

    acknowledgeAll(removed);
    const judged = judgeStackManifest({ workspaceId: workspace, stackId: stack.stackId, manifestId: stack.manifestId, userId: owner, verdict: "approved", comment: "Whole stack." });
    expect(judged.created).toBe(true);
    expect(judged.judgment.scope).toEqual({ kind: "stack", manifest: 1 });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_stack_judgment_items WHERE judgment_id = ?").get(judged.judgment.id)!.n).toBe(6);
    expect(getMyRevisionJudgment(workspace, first.revisionId, owner)).toBeNull();

    judgeRevision({ workspaceId: workspace, lineageId: first.lineageId, revisionId: first.revisionId, userId: owner, verdict: "changes_requested", comment: "Member issue." });
    expect(getMyStackJudgment(workspace, stack.manifestId, owner)?.verdict).toBe("approved");
    expect(getMyRevisionJudgment(workspace, first.revisionId, owner)?.verdict).toBe("changes_requested");
  });

  test("stack judgment queries each member's acknowledgements once, not once per item", () => {
    const first = createRevision();
    const second = createRevision();
    acknowledgeAll(first);
    acknowledgeAll(second);
    const stack = createManifest([{ fixture: first }, { fixture: second }]);
    const originalQuery = db.query;
    let acknowledgementQueries = 0;
    (db as any).query = function (sql: string) {
      if (sql === "SELECT * FROM review_revision_acknowledgements WHERE workspace_id = ? AND revision_id = ? AND user_id = ? ORDER BY item_id ASC") acknowledgementQueries++;
      return originalQuery.call(this, sql);
    };
    try {
      const judged = judgeStackManifest({ workspaceId: workspace, stackId: stack.stackId, manifestId: stack.manifestId, userId: owner, verdict: "approved", comment: "" });
      expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_stack_judgment_items WHERE judgment_id = ?").get(judged.judgment.id)!.n).toBe(6);
    } finally {
      (db as any).query = originalQuery;
    }
    expect(acknowledgementQueries).toBe(2);
  });

  test("a successor manifest starts without judgment and exact replay is immutable", () => {
    const first = createRevision();
    const second = createRevision();
    acknowledgeAll(first);
    acknowledgeAll(second);
    const original = createManifest([{ fixture: first }, { fixture: second }]);
    const results = Array.from({ length: 8 }, () => judgeStackManifest({ workspaceId: workspace, stackId: original.stackId, manifestId: original.manifestId, userId: owner, verdict: "approved", comment: "Exact." }));
    expect(new Set(results.map((result) => result.judgment.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(() => judgeStackManifest({ workspaceId: workspace, stackId: original.stackId, manifestId: original.manifestId, userId: owner, verdict: "approved", comment: "Changed." })).toThrow("immutable");
    const historyBefore = db.query("SELECT * FROM review_stack_judgment_items WHERE judgment_id = ? ORDER BY revision_id, item_id").all(results[0]!.judgment.id);
    const changed = requiredAcknowledgements(first.inventory)[0]!;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: first.lineageId, revisionId: first.revisionId, userId: owner, item: changed, acknowledged: false });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: first.lineageId, revisionId: first.revisionId, userId: owner, item: changed, acknowledged: true, now: Date.now() + 10_000 });
    expect(judgeStackManifest({ workspaceId: workspace, stackId: original.stackId, manifestId: original.manifestId, userId: owner, verdict: "approved", comment: "Exact." })).toMatchObject({ created: false, judgment: { id: results[0]!.judgment.id } });
    expect(db.query("SELECT * FROM review_stack_judgment_items WHERE judgment_id = ? ORDER BY revision_id, item_id").all(results[0]!.judgment.id)).toEqual(historyBefore);

    const successor = createManifest([{ fixture: first }, { fixture: second }], { stackId: original.stackId, slug: original.slug, version: 2 });
    expect(getMyStackJudgment(workspace, successor.manifestId, owner)).toBeNull();
    expect(listStackJudgments(workspace, original.manifestId)).toHaveLength(1);
    expect(listStackJudgments(otherWorkspace, original.manifestId)).toEqual([]);
  });
});

describe("member forms and safe history", () => {
  test("an old review account acknowledges and judges its revision through ordinary and JSON forms", async () => {
    const fixture = createRevision({ materialOnly: true });
    const account = createAccount(fixture);
    const focus = `/${workspace}/r/${fixture.slug}/v/${account.version}?review=all-material`;
    const firstPage = await fetch(`${base}${focus}`, { headers: { cookie } });
    expect(firstPage.status).toBe(200);
    const firstHtml = visible(await firstPage.text());
    expect(firstHtml.match(/class="acknowledgement-form"/g)).toHaveLength(3);
    expect(firstHtml).toContain(`action="/${workspace}/r/${fixture.slug}/rev/1/judgment"`);
    expect(firstHtml).toContain("3 open thread".replace("3", "0"));

    const keyRead = await fetch(`${base}/api/review-lineages/${fixture.slug}/revisions/1/judgments`, { headers: { authorization: `Bearer ${key}` } });
    expect(keyRead.status).toBe(200);
    expect((await keyRead.json() as any).handling).toBeNull();
    const sessionRead = await fetch(`${base}/api/review-lineages/${fixture.slug}/revisions/1/judgments`, { headers: { cookie } });
    expect(await sessionRead.json() as any).toMatchObject({ handling: { required: 3, acknowledged: 0 } });

    for (const required of requiredAcknowledgements(fixture.inventory)) {
      const ack = await fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/items/${required.id}/acknowledge`, {
        method: "POST",
        headers: { cookie, accept: "application/json" },
        body: new URLSearchParams({ acknowledged: "true", return: focus }),
      });
      expect(ack.status).toBe(200);
      expect(await ack.json() as any).toMatchObject({ itemId: required.id, acknowledged: true, acknowledgement: { provenance: { kind: "explicit" } } });
    }

    const successor = createRevision({ lineageId: fixture.lineageId, slug: fixture.slug, revision: 2, materialOnly: true });
    const stale = visible(await (await fetch(`${base}${focus}`, { headers: { cookie } })).text());
    expect(stale).toContain("Revision 2 available");
    expect(stale).toContain("Approve this version");

    const judgment = await fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/judgment`, {
      method: "POST",
      headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "approved", comment: "Pinned local verdict.", return: focus }),
    });
    expect(judgment.status).toBe(201);
    const body = await judgment.json() as any;
    expect(body).toMatchObject({ created: true, judgment: { verdict: "approved", comment: "Pinned local verdict." } });
    expect(getMyRevisionJudgment(workspace, successor.revisionId, owner)).toBeNull();

    const history = visible(await (await fetch(`${base}${focus}`, { headers: { cookie } })).text());
    expect(history).toContain("Approved");
    expect(history).toContain("Pinned local verdict.");
    expect(history).not.toContain("Approve this version");
    expect(history).not.toContain("Approve on GitHub");

    const replay = await fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/judgment`, {
      method: "POST", headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "approved", comment: "Pinned local verdict.", return: focus }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json() as any).toMatchObject({ created: false, judgment: { id: body.judgment.id } });
    const conflict = await fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/judgment`, {
      method: "POST", headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "changes_requested", comment: "Pinned local verdict.", return: focus }),
    });
    expect(conflict.status).toBe(409);

    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: account.id, label: "judgment omission", userId: owner, expiresAt: null });
    const shared = visible(await (await fetch(`${base}/s/${capability.token}?review=all-material`)).text());
    for (const absent of ["acknowledgement-form", "judgment-form", "Pinned local verdict.", "dev@localhost", "Approve this version"]) expect(shared).not.toContain(absent);
  });

  test("another member's exact verdict is short history, not the viewer's editable state", async () => {
    const fixture = createRevision({ materialOnly: true });
    const account = createAccount(fixture);
    acknowledgeAll(fixture, teammate);
    judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: teammate, verdict: "changes_requested", comment: "Teammate concern." });
    const page = visible(await (await fetch(`${base}/${workspace}/r/${fixture.slug}/v/${account.version}?review=all-material`, { headers: { cookie } })).text());
    expect(page).toContain("judgment-teammate");
    expect(page).not.toContain("judgment-teammate@example.com");
    expect(page).toContain("Changes requested");
    expect(page).toContain("Teammate concern.");
    expect(page).toContain("Approve this version");
  });

  test("a movement read backfills v21 item equivalences once", () => {
    const source = createRevision({ materialOnly: true });
    const target = createRevision({ lineageId: source.lineageId, slug: source.slug, revision: 2, materialOnly: true });
    db.run(
      "INSERT INTO review_revision_movements (revision_id, workspace_id, lineage_id, previous_revision_id, unchanged, revised, new, removed, computed_at) VALUES (?, ?, ?, ?, 2, 1, 0, 0, ?)",
      [target.revisionId, workspace, source.lineageId, source.revisionId, Date.now()],
    );
    const lineage = getLineage(workspace, source.slug)!;
    const revision = getRevisionById(workspace, target.revisionId)!;
    expect(revisionMovement(workspace, lineage, revision, target.inventory)?.code).toEqual({ unchanged: 2, revised: 1, new: 0, removed: 0 });
    const marker = db.query<{ items_computed_at: number | null }, [string]>("SELECT items_computed_at FROM review_revision_movements WHERE revision_id = ?").get(target.revisionId)!.items_computed_at;
    expect(marker).not.toBeNull();
    db.run("CREATE TEMP TRIGGER refuse_repeated_movement_items BEFORE INSERT ON review_revision_item_equivalences BEGIN SELECT RAISE(ABORT, 'movement items recomputed'); END");
    try {
      expect(revisionMovement(workspace, lineage, revision, target.inventory)?.code).toEqual({ unchanged: 2, revised: 1, new: 0, removed: 0 });
      expect(db.query<{ items_computed_at: number | null }, [string]>("SELECT items_computed_at FROM review_revision_movements WHERE revision_id = ?").get(target.revisionId)!.items_computed_at).toBe(marker);
    } finally {
      db.run("DROP TRIGGER refuse_repeated_movement_items");
    }
  });

  test("a stored v21 movement still reads when its item backfill cannot load retained evidence", () => {
    const source = createRevision({ materialOnly: true });
    const target = createRevision({ lineageId: source.lineageId, slug: source.slug, revision: 2, materialOnly: true });
    db.run(
      "INSERT INTO review_revision_movements (revision_id, workspace_id, lineage_id, previous_revision_id, unchanged, revised, new, removed, computed_at) VALUES (?, ?, ?, ?, 7, 6, 5, 4, ?)",
      [target.revisionId, workspace, source.lineageId, source.revisionId, Date.now()],
    );
    db.run("DELETE FROM stage_capture_incomplete WHERE capture_id = ?", [source.captureId]);
    db.run("DELETE FROM stage_capture_files WHERE capture_id = ?", [source.captureId]);
    db.run("DELETE FROM stage_captures WHERE id = ?", [source.captureId]);
    expect(revisionMovement(workspace, getLineage(workspace, source.slug)!, getRevisionById(workspace, target.revisionId)!, target.inventory)?.code).toEqual({ unchanged: 7, revised: 6, new: 5, removed: 4 });
    expect(db.query<{ items_computed_at: number | null }, [string]>("SELECT items_computed_at FROM review_revision_movements WHERE revision_id = ?").get(target.revisionId)!.items_computed_at).toBeNull();
  });

  test("a late acknowledgement backfills v21 movement equivalence and carries forward", async () => {
    const source = createRevision({ materialOnly: true });
    const target = createRevision({ lineageId: source.lineageId, slug: source.slug, revision: 2, materialOnly: true });
    db.run(
      "INSERT INTO review_revision_movements (revision_id, workspace_id, lineage_id, previous_revision_id, unchanged, revised, new, removed, computed_at) VALUES (?, ?, ?, ?, 2, 1, 0, 0, ?)",
      [target.revisionId, workspace, source.lineageId, source.revisionId, Date.now()],
    );
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_item_equivalences WHERE target_revision_id = ?").get(target.revisionId)!.n).toBe(0);
    const sourceItem = requiredAcknowledgements(source.inventory).find((item) => item.type === "material" && item.path === null)!;
    const response = await fetch(`${base}/${workspace}/r/${source.slug}/rev/1/items/${sourceItem.id}/acknowledge`, {
      method: "POST", headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ acknowledged: "true" }),
    });
    expect(response.status).toBe(200);
    const targetItem = requiredAcknowledgements(target.inventory).find((item) => item.type === "material" && item.path === null)!;
    expect(db.query("SELECT provenance_kind, source_revision_id, source_item_id FROM review_revision_acknowledgements WHERE revision_id = ? AND user_id = ? AND item_id = ?").get(target.revisionId, owner, targetItem.id)).toEqual({
      provenance_kind: "carried", source_revision_id: source.revisionId, source_item_id: sourceItem.id,
    });
    const computedAt = db.query<{ items_computed_at: number | null }, [string]>("SELECT items_computed_at FROM review_revision_movements WHERE revision_id = ?").get(target.revisionId)!.items_computed_at;
    expect(computedAt).not.toBeNull();

    db.run("CREATE TEMP TRIGGER refuse_second_item_delta BEFORE INSERT ON review_revision_item_equivalences BEGIN SELECT RAISE(ABORT, 'item delta recomputed'); END");
    try {
      const repeated = await fetch(`${base}/${workspace}/r/${source.slug}/rev/1/items/${sourceItem.id}/acknowledge`, {
        method: "POST", headers: { cookie, accept: "application/json" },
        body: new URLSearchParams({ acknowledged: "true" }),
      });
      expect(repeated.status).toBe(200);
      expect(db.query<{ items_computed_at: number | null }, [string]>("SELECT items_computed_at FROM review_revision_movements WHERE revision_id = ?").get(target.revisionId)!.items_computed_at).toBe(computedAt);
    } finally {
      db.run("DROP TRIGGER refuse_second_item_delta");
    }
  });

  test("a stack account writes member acknowledgements and a separate exact manifest judgment", async () => {
    const githubReviewsBefore = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_github_reviews").get()!.n;
    const bottom = createRevision({ materialOnly: true });
    const top = createRevision({ materialOnly: true });
    const bottomAccount = createAccount(bottom);
    const topAccount = createAccount(top);
    const stack = createManifest([{ fixture: bottom, account: bottomAccount }, { fixture: top, account: topAccount }]);
    createStackAccount(stack, [{ fixture: bottom, account: bottomAccount }, { fixture: top, account: topAccount }]);
    const focus = `/${workspace}/r-stacks/${stack.slug}/v/1/account?review=whole`;
    const page = await fetch(`${base}${focus}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = visible(await page.text());
    expect(html.match(/class="acknowledgement-form"/g)).toHaveLength(6);
    expect(html).toContain(`action="/${workspace}/r-stacks/${stack.slug}/v/1/judgment"`);

    for (const [position, fixture] of [[1, bottom], [2, top]] as const) {
      for (const required of requiredAcknowledgements(fixture.inventory)) {
        const ack = await fetch(`${base}/${workspace}/r-stacks/${stack.slug}/v/1/members/${position}/items/${required.id}/acknowledge`, {
          method: "POST", headers: { cookie, accept: "application/json" },
          body: new URLSearchParams({ acknowledged: "true", return: focus }),
        });
        expect(ack.status).toBe(200);
        expect(await ack.json() as any).toMatchObject({ position, itemId: required.id, acknowledged: true });
      }
    }
    const judged = await fetch(`${base}/${workspace}/r-stacks/${stack.slug}/v/1/judgment`, {
      method: "POST", headers: { cookie, accept: "application/json" },
      body: new URLSearchParams({ verdict: "changes_requested", comment: "Stack-local only.", return: focus }),
    });
    expect(judged.status).toBe(201);
    expect(await judged.json() as any).toMatchObject({ judgment: { verdict: "changes_requested", scope: { kind: "stack", manifest: 1 } } });
    expect(getMyRevisionJudgment(workspace, bottom.revisionId, owner)).toBeNull();
    expect(getMyRevisionJudgment(workspace, top.revisionId, owner)).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_github_reviews").get()!.n).toBe(githubReviewsBefore);
    createManifest([{ fixture: bottom, account: bottomAccount }, { fixture: top, account: topAccount }], { stackId: stack.stackId, slug: stack.slug, version: 2 });
    const old = visible(await (await fetch(`${base}${focus}`, { headers: { cookie } })).text());
    expect(old).toContain("Earlier manifest 1");
    expect(old).toContain("Stack-local only.");
  });

  test("local judgment leaves Project state and joins unchanged", async () => {
    const fixture = createRevision({ materialOnly: true });
    acknowledgeAll(fixture);
    const projectId = tinyId("prj");
    const projectSlug = `judgment-project-${sequence}`;
    db.run("INSERT INTO projects VALUES (?, ?, ?, NULL, 'Judgment project', '', 'open', ?, ?)", [projectId, workspace, projectSlug, Date.now(), Date.now()]);
    db.run("INSERT INTO project_review_lineages VALUES (?, ?, ?, ?)", [projectId, workspace, fixture.slug, Date.now()]);
    const before = await (await fetch(`${base}/api/projects/${projectSlug}`, { headers: { authorization: `Bearer ${key}` } })).text();
    judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: owner, verdict: "approved", comment: "Project state stays workflow state." });
    const after = await (await fetch(`${base}/api/projects/${projectSlug}`, { headers: { authorization: `Bearer ${key}` } })).text();
    expect(after).toBe(before);
    expect(db.query("SELECT * FROM project_review_lineages WHERE project_id = ? AND slug = ?").get(projectId, fixture.slug)).not.toBeNull();
  });

  test("auth-enabled privacy keeps sessions, keys, capabilities, and workspaces separate", async () => {
    const fixture = createRevision({ materialOnly: true });
    const account = createAccount(fixture);
    const stackMember = createRevision({ materialOnly: true });
    const stackMemberAccount = createAccount(stackMember);
    const stack = createManifest([{ fixture, account }, { fixture: stackMember, account: stackMemberAccount }]);
    const stackAccount = createStackAccount(stack, [{ fixture, account }, { fixture: stackMember, account: stackMemberAccount }]);
    acknowledgeAll(fixture, teammate);
    judgeRevision({ workspaceId: workspace, lineageId: fixture.lineageId, revisionId: fixture.revisionId, userId: teammate, verdict: "changes_requested", comment: "Privacy projection." });
    const stranger = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, 'judgment-stranger@example.com', ?)", [stranger, Date.now()]);
    const script = new URL("./judgment-privacy.script.ts", import.meta.url).pathname;
    const process = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        AUTH_DISABLED: "",
        JUDGMENT_WORKSPACE: workspace,
        JUDGMENT_OTHER_WORKSPACE: otherWorkspace,
        JUDGMENT_OWNER: owner,
        JUDGMENT_STRANGER: stranger,
        JUDGMENT_KEY: key,
        JUDGMENT_SLUG: fixture.slug,
        JUDGMENT_REVISION: fixture.revisionId,
        JUDGMENT_ACCOUNT: account.id,
        JUDGMENT_ITEM: requiredAcknowledgements(fixture.inventory)[0]!.id,
        JUDGMENT_STACK_SLUG: stack.slug,
        JUDGMENT_STACK_MANIFEST: stack.manifestId,
        JUDGMENT_STACK_ACCOUNT: stackAccount,
        JUDGMENT_STACK_ITEM: requiredAcknowledgements(fixture.inventory)[0]!.id,
      },
    });
    const [code, out, err] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("judgment privacy: all assertions passed");
  });

  test("real Chrome covers desktop, phone history, touch Details, themes, and no-JavaScript forms", async () => {
    const evidence = process.env.SEER_TASK10_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "seer-task10-browser-"));
    mkdirSync(evidence, { recursive: true });
    const profiles = mkdtempSync(join(tmpdir(), "seer-task10-chrome-"));

    const desktopFixture = createRevision({ materialOnly: true });
    const desktopAccount = createAccount(desktopFixture);
    const desktopUrl = `${base}/${workspace}/r/${desktopFixture.slug}/v/${desktopAccount.version}`;
    const desktop = await ChromePage.launch({ width: 1440, height: 1000, profileRoot: profiles, name: "judgment-desktop" });
    try {
      await desktop.navigate(desktopUrl);
      expect(await desktop.evaluate<number>("document.querySelectorAll('.source-rail .judgment-form').length")).toBe(1);
      expect(await desktop.evaluate<string>("document.querySelector('[data-progress]')?.textContent")).toBe("0 / 3 handled");
      expect(await desktop.evaluate<boolean>("[...document.querySelectorAll('.judgment-form button')].every(button=>button.disabled)")).toBe(true);
      await desktop.evaluate("document.querySelector('[data-focus-link][data-review=all-material]').click()");
      await desktop.waitFor("document.querySelector('[data-focus-dialog]')?.open");
      expect(await desktop.evaluate<number>("document.querySelectorAll('.judgment-form').length")).toBe(1);
      expect(await desktop.evaluate<number>("document.querySelectorAll('.acknowledgement-form').length")).toBe(3);
      expect(await desktop.evaluate<number>("document.querySelectorAll('.judgment-blockers li:not([hidden])').length")).toBe(3);
      await desktop.screenshot(join(evidence, "judgment-desktop-1440-light.png"));

      const beforeAck = await desktop.evaluate<{ href: string; scroll: number }>("(()=>{const button=document.querySelector('.acknowledgement-form:has(input[name=acknowledged][value=true]) button');button.scrollIntoView({block:'center'});return{href:location.href,scroll:document.querySelector('[data-focus-stream]').scrollTop}})()");
      await desktop.click('.acknowledgement-form:has(input[name="acknowledged"][value="true"]) button');
      await desktop.waitFor("document.querySelectorAll('.acknowledgement-form:has(input[name=acknowledged][value=false])').length===1");
      expect(await desktop.evaluate<{ href: string; scroll: number; open: boolean; progress: string }>("({href:location.href,scroll:document.querySelector('[data-focus-stream]').scrollTop,open:[...document.querySelectorAll('[data-focus-dialog] .material-fact')].every(node=>node.open),progress:document.querySelector('[data-progress]').textContent})")).toEqual({ ...beforeAck, open: true, progress: "1 / 3 handled" });

      await desktop.evaluate("document.querySelector('.acknowledgement-form:has(input[name=acknowledged][value=true]) button').focus()");
      await desktop.key("Enter");
      await desktop.waitFor("document.querySelectorAll('.acknowledgement-form:has(input[name=acknowledged][value=false])').length===2");
      await desktop.click('.acknowledgement-form:has(input[name="acknowledged"][value="true"]) button');
      await desktop.waitFor("document.querySelector('.judgment-blockers')?.hidden && [...document.querySelectorAll('.judgment-form button')].every(button=>!button.disabled)");
      expect(await desktop.evaluate<string>("document.querySelector('[data-progress]')?.textContent")).toBe("3 / 3 handled");
      await desktop.setValue('.judgment-form textarea', "Browser-approved exact revision.");
      await desktop.clickAndWaitForLoad('.judgment-form button[value="approved"]');
      await desktop.waitFor("document.querySelector('.judgment-row[data-verdict=approved]') && !document.querySelector('.judgment-form')");
      await desktop.screenshot(join(evidence, "judgment-history-desktop-1440-light.png"));
    } finally {
      await desktop.close();
    }

    const phoneFixture = createRevision({ materialOnly: true });
    const phoneAccount = createAccount(phoneFixture);
    const phoneBase = `${base}/${workspace}/r/${phoneFixture.slug}/v/${phoneAccount.version}`;
    const phone = await ChromePage.launch({ width: 390, height: 844, dark: true, touch: true, profileRoot: profiles, name: "judgment-phone" });
    try {
      await phone.navigate(phoneBase);
      expect(await phone.evaluate<string[]>("[...document.querySelectorAll('.mobile-bar>*')].map(node=>node.textContent.trim())")).toEqual(["v1", "0 / 3 handled", "Details"]);
      await phone.touch('.mobile-bar [data-page-details-open]');
      await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='true'");
      expect(await phone.evaluate<string>("document.querySelector('[data-page-details] .judgment h2')?.textContent")).toBe("Judgment");
      expect(await phone.evaluate<number>("document.querySelectorAll('[data-page-details] .judgment-form').length")).toBe(1);
      await phone.screenshot(join(evidence, "judgment-phone-390-dark-details.png"));
      await phone.evaluate("history.back()");
      await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='false'");

      await phone.evaluate("document.querySelector('[data-focus-link][data-review=all-material]').click()");
      await phone.waitFor("document.querySelector('[data-focus-dialog]')?.open");
      const focusHref = await phone.evaluate<string>("location.href");
      await phone.touch('.acknowledgement-form:has(input[name="acknowledged"][value="true"]) button');
      await phone.waitFor("document.querySelectorAll('.acknowledgement-form:has(input[name=acknowledged][value=false])').length===1");
      expect(await phone.evaluate<{ href: string; progress: string; open: boolean }>("({href:location.href,progress:document.querySelector('[data-progress]').textContent,open:[...document.querySelectorAll('[data-focus-dialog] .material-fact')].every(node=>node.open)})")).toEqual({ href: focusHref, progress: "1 / 3 handled", open: true });
      await phone.touch('.focus-mobile-bar [data-focus-toggle="detail"]');
      await phone.waitFor("document.querySelector('[data-focus-layout]')?.dataset.panel==='detail'");
      expect(await phone.evaluate<string[]>("[...document.querySelectorAll('.focus-mobile-bar>*')].map(node=>node.textContent.trim())")).toEqual(["Review", "", "Details"]);
      expect(await phone.evaluate<number>("document.querySelectorAll('.judgment-form').length")).toBe(1);
      await phone.key("Escape");
      await phone.waitFor("document.querySelector('[data-focus-layout]')?.dataset.panel!=='detail'");
      await phone.key("Escape");
      await phone.waitFor("!document.querySelector('[data-focus-dialog]')?.open || !new URL(location.href).searchParams.has('review')");
      expect(await phone.evaluate<number>("document.querySelectorAll('.acknowledgement-form').length")).toBe(3);
      expect(await phone.evaluate<number>("document.querySelectorAll('.acknowledgement-form:has(input[name=acknowledged][value=false])').length")).toBe(1);
    } finally {
      await phone.close();
    }

    const noJsFixture = createRevision({ materialOnly: true });
    const noJsAccount = createAccount(noJsFixture);
    const noJsUrl = `${base}/${workspace}/r/${noJsFixture.slug}/v/${noJsAccount.version}?review=all-material`;
    const noJs = await ChromePage.launch({ width: 390, height: 1000, javascript: false, profileRoot: profiles, name: "judgment-nojs" });
    try {
      await noJs.navigate(noJsUrl);
      expect(await noJs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
      expect(await noJs.evaluate<string>("getComputedStyle(document.querySelector('.focus-right')).display")).not.toBe("none");
      expect(await noJs.evaluate<number>("document.querySelectorAll('.acknowledgement-form').length")).toBe(3);
      await noJs.evaluate("document.querySelector('.focus-right').scrollIntoView({block:'start'})");
      await noJs.screenshot(join(evidence, "judgment-phone-390-nojs-form.png"));
      await noJs.clickAndWaitForLoad('.acknowledgement-form:has(input[name="acknowledged"][value="true"]) button');
      expect(await noJs.evaluate<string>("document.querySelector('[data-group-nav-progress]')?.textContent")).toBe("1/3");
      await noJs.clickAndWaitForLoad('.acknowledgement-form:has(input[name="acknowledged"][value="false"]) button');
      expect(await noJs.evaluate<string>("document.querySelector('[data-group-nav-progress]')?.textContent")).toBe("0/3");
      for (let index = 0; index < 3; index++) {
        await noJs.clickAndWaitForLoad('.acknowledgement-form:has(input[name="acknowledged"][value="true"]) button');
      }
      expect(await noJs.evaluate<boolean>("[...document.querySelectorAll('.judgment-form button')].every(button=>!button.disabled)")).toBe(true);
      await noJs.setValue('.judgment-form textarea', "No-JavaScript exact verdict.");
      await noJs.clickAndWaitForLoad('.judgment-form button[value="changes_requested"]');
      await noJs.waitFor("document.querySelector('.judgment-row[data-verdict=changes_requested]') && !document.querySelector('.judgment-form')");
      await noJs.evaluate("document.querySelector('.focus-right').scrollIntoView({block:'start'})");
      await noJs.screenshot(join(evidence, "judgment-phone-390-nojs.png"));
    } finally {
      await noJs.close();
    }

    const wideFixture = createRevision({ materialOnly: true });
    const wideAccount = createAccount(wideFixture);
    const wide = await ChromePage.launch({ width: 1680, height: 1000, dark: true, profileRoot: profiles, name: "judgment-wide" });
    try {
      await wide.navigate(`${base}/${workspace}/r/${wideFixture.slug}/v/${wideAccount.version}?review=all-material`);
      expect(await wide.evaluate<boolean>("document.querySelector('.focus-right .judgment-form')!==null")).toBe(true);
      expect(await wide.evaluate<string>("document.documentElement.dataset.theme")).toBe("dark");
      await wide.screenshot(join(evidence, "judgment-wide-1680-dark.png"));
    } finally {
      await wide.close();
    }
  }, 60_000);

  test("a blocked no-JavaScript judgment returns the same pinned page with status 422", async () => {
    const fixture = createRevision({ materialOnly: true });
    const account = createAccount(fixture);
    const focus = `/${workspace}/r/${fixture.slug}/v/${account.version}?review=all-material`;
    const response = await fetch(`${base}/${workspace}/r/${fixture.slug}/rev/1/judgment`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ verdict: "approved", comment: "", return: focus }),
      redirect: "manual",
    });
    expect(response.status).toBe(422);
    const html = visible(await response.text());
    expect(html).toContain("Judgment");
    expect(html.match(/class="judgment-blockers"/g)).toHaveLength(1);
    expect(html).toContain("Needs acknowledgement");
    expect(html).toContain("Acknowledge every unavailable review item before judging this revision.");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id = ?").get(fixture.revisionId)!.n).toBe(0);
  });
});
