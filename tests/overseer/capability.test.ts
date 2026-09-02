import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { hashKey, newShareToken, tinyId } from "../../src/ids";
import { saveAttachment, saveStageBlob } from "../../src/store";
import { conversationPlacementHomes } from "../../src/stage/render";
import { ChromePage } from "../chrome";
import {
  capabilityAssetPath,
  createDocumentCapability,
  documentProjectionForShare,
  resolveCapabilityTargetForMint,
  resolveDocumentCapability,
} from "../../src/overseer/capability-db";
import { getShare, SHARE_KINDS, SERVED_SHARE_KINDS } from "../../src/shares";
import { appendLocalReply, createLocalThread, projectLocalThread } from "../../src/overseer/thread-db";
import { recordGithubCommentWebhook, recordGithubReviewWebhook, recordGithubThreadWebhook } from "../../src/overseer/conversation-import";
import { readCapabilityConversation, stackWitnessConversationContext } from "../../src/overseer/conversation-read";
import { mapSubmittedGithubThread } from "../../src/overseer/github-thread-sync";
import { getStackManifest } from "../../src/overseer/stack-db";
import { digestOf } from "../../src/overseer/revision-db";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
};
const sha = (n: number) => n.toString(16).padStart(40, "0");

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let otherWorkspace = "";
let owner = "";
let stranger = "";
let otherMember = "";
let key = "";
let lineageId = "";
let stackId = "";
let revisionId = "";
let laterRevisionId = "";
let accountId = "";
let manifestId = "";
let stackAccountId = "";
let fileId = "";
let laterFileId = "";
let largeFileId = "";
let attachmentId = "";

function visible(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
}

function attributeUrls(page: string): string[] {
  return [...page.matchAll(/\s(?:href|action|data-[a-z0-9-]+)="([^"]*)"/gi)]
    .map((match) => match[1]!)
    .filter((value) => value.startsWith("/") || /^https?:\/\//.test(value));
}

async function insertRevision(input: { lineageId: string; slug: string; revision: number; accountVersion: number; value: number }) {
  const captureId = tinyId("stg");
  const revision = tinyId("rvr");
  const file = tinyId("stf");
  const before = "const before = true;";
  const after = "const after = true;";
  const oldLine = `export const value = ${input.value - 1};`;
  const newLine = `export const value = ${input.value};`;
  const oldText = `${before}\n${oldLine}\n${after}\nconst untouched = 1;\nconst tail = true;\n`;
  const newText = `${before}\n${newLine}\n${after}\nconst untouched = 1;\nconst tail = true;\n`;
  const oldBlob = digest(oldText);
  const newBlob = digest(newText);
  const patch = `diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1,3 +1,3 @@\n ${before}\n-${oldLine}\n+${newLine}\n ${after}\n`;
  const patchBlob = digest(patch);
  await saveStageBlob(workspace, oldBlob, new TextEncoder().encode(oldText));
  await saveStageBlob(workspace, newBlob, new TextEncoder().encode(newText));
  await saveStageBlob(workspace, patchBlob, new TextEncoder().encode(patch));
  db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, oldBlob, oldText.length, Date.now()]);
  db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, newBlob, newText.length, Date.now()]);
  db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, patchBlob, patch.length, Date.now()]);
  db.run(
    "INSERT INTO stage_captures VALUES (?, ?, ?, 'Acme/Capability', 990, 'feature/share', 'main', ?, ?, ?, ?, 'completed', ?)",
    [captureId, workspace, input.slug, sha(2 + input.revision), sha(1), sha(1), patchBlob, Date.now()],
  );
  db.run(
    "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/value.ts', NULL, 'modified', ?, ?, '100644', '100644', 'blob', 'blob', 1, 1, 'retained', 'retained', ?, ?, NULL, NULL)",
    [file, workspace, captureId, sha(10), sha(11 + input.revision), oldBlob, newBlob],
  );
  const oldHunk = [before, oldLine, after];
  const newHunk = [before, newLine, after];
  const context = [before, after];
  const change = `chg_${digest(stable({ path: "src/value.ts", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, old: oldHunk, newer: newHunk, context }))}`;
  db.run(
    "INSERT INTO stage_capture_changes VALUES (?, ?, ?, ?, 1, 3, 1, 3, ?, ?, ?, 'patch')",
    [change, workspace, captureId, file, digest(JSON.stringify(oldHunk)), digest(JSON.stringify(newHunk)), digest(JSON.stringify(context))],
  );
  let largeFile: string | null = null;
  if (input.revision === 1) {
    largeFile = tinyId("stf");
    const largeText = `${"x".repeat(513 * 1024)}\n`;
    const largeBlob = digest(largeText);
    await saveStageBlob(workspace, largeBlob, new TextEncoder().encode(largeText));
    db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, largeBlob, largeText.length, Date.now()]);
    db.run(
      "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/large.txt', NULL, 'added', NULL, ?, NULL, '100644', NULL, 'blob', 1, 0, 'not_applicable', 'retained', NULL, ?, NULL, NULL)",
      [largeFile, workspace, captureId, sha(30), largeBlob],
    );
  }
  db.run(
    "INSERT INTO stage_capture_builders VALUES (?, ?, 'Build exact evidence.', 'Internal context.', 'Builder', 'build-model', ?, ?, ?)",
    [workspace, captureId, owner, tinyId("key"), Date.now()],
  );
  const revisionDoc = {
    identity: { lineageId: input.lineageId, slug: input.slug, revision: input.revision, title: "Exact capability", createdAt: new Date().toISOString() },
    source: { captureId, repo: "Acme/Capability", repoId: 990, branch: "feature/share", originalBaseRef: "main", originalBaseSha: sha(1), baseRef: "main", sourceHeadSha: sha(2 + input.revision), baseTipSha: sha(1), mergeBaseSha: sha(1) },
    builder: { intent: "Build exact evidence.", context: "Internal context.", agent: { name: "Builder", model: "build-model" }, userId: owner, keyId: tinyId("key") },
    projects: ["secret-project"],
  };
  db.run(
    "INSERT INTO review_revisions VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    [revision, workspace, input.lineageId, input.slug, input.revision, captureId, JSON.stringify(revisionDoc), digest(JSON.stringify(revisionDoc)), Date.now()],
  );
  const account = tinyId("rac");
  const accountDoc = {
    identity: { lineageId: input.lineageId, slug: input.slug, revision: input.revision, version: input.accountVersion, createdAt: new Date().toISOString() },
    witness: { summary: `Witness account ${input.accountVersion}.`, agent: { name: "Witness", model: "review-model" }, userId: owner, keyId: tinyId("key") },
    groups: [{ id: "exact", title: "Exact file", category: "Code", importance: "high", complexity: "low", explanation: "One retained file.", examples: [], members: [
      { type: "change", id: change, description: "The exact retained change." },
      ...(largeFile ? [{ type: "file", id: largeFile, description: "The exact retained large file." }] : []),
    ] }],
    focus: [{ id: "decision", kind: "decision", title: "Exact evidence", body: "Read the retained file.", anchors: [{ type: "change", id: change }] }],
    evidence: input.revision === 1 ? [
      { kind: "attachment", id: attachmentId, reviewSlug: "legacy-evidence", mediaType: "image/png", bytes: 3, alt: "evidence", caption: "Pinned image" },
      { kind: "bundle", slug: "private-bundle", version: 7 },
    ] : [],
  };
  db.run(
    "INSERT INTO review_accounts VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
    [account, workspace, input.lineageId, revision, input.revision, input.slug, input.accountVersion, JSON.stringify(accountDoc), digest(JSON.stringify(accountDoc)), owner, tinyId("key"), Date.now()],
  );
  return { revision, account, file, change, captureId, largeFile };
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  stranger = tinyId("usr");
  otherMember = tinyId("usr");
  db.run("INSERT INTO users VALUES (?, 'capability-stranger@example.com', ?), (?, 'teammate@example.com', ?)", [stranger, Date.now(), otherMember, Date.now()]);
  workspace = createWorkspace("Capability", owner);
  db.run("INSERT INTO memberships VALUES (?, ?, ?)", [workspace, otherMember, Date.now()]);
  otherWorkspace = createWorkspace("Other capability", owner);
  key = mintApiKey(owner, workspace, "capability").token;
  attachmentId = tinyId("att");
  db.run("INSERT INTO review_attachments VALUES (?, ?, 'legacy-evidence', 1, 'image/png', 3, 'evidence', 'Pinned image', ?)", [attachmentId, workspace, Date.now()]);
  await saveAttachment(workspace, attachmentId, Uint8Array.from([1, 2, 3]));

  lineageId = tinyId("rln");
  db.run(
    "INSERT INTO review_lineages VALUES (?, ?, 'exact-review', 'Acme/Capability', 990, 'feature/share', 'main', ?, 'Exact capability', 2, 2, ?, ?, ?, ?)",
    [lineageId, workspace, sha(1), owner, tinyId("key"), Date.now(), Date.now()],
  );
  const first = await insertRevision({ lineageId, slug: "exact-review", revision: 1, accountVersion: 1, value: 1 });
  const second = await insertRevision({ lineageId, slug: "exact-review", revision: 2, accountVersion: 2, value: 2 });
  revisionId = first.revision;
  laterRevisionId = second.revision;
  accountId = first.account;
  fileId = first.file;
  laterFileId = second.file;
  largeFileId = first.largeFile!;
  db.run(
    "INSERT INTO review_lineage_prs VALUES (?, ?, 'exact-review', 990, 'Acme/Capability', 42, 'feature/share', 'main', 'anonymous', NULL, NULL, NULL, ?, NULL)",
    [lineageId, workspace, Date.now()],
  );
  const pinnedObservation = tinyId("pob");
  const newerObservation = tinyId("pob");
  db.run(
    "INSERT INTO review_pr_observations VALUES (?, ?, ?, 990, 'Acme/Capability', 42, 'Pinned PR title', 'open', 0, 0, 'main', ?, 'feature/share', ?, ?, ?, ?, 'anonymous', NULL, NULL, NULL, 'pinned-observation')",
    [pinnedObservation, workspace, lineageId, sha(1), sha(3), sha(1), Date.now() - 1000, Date.now() - 1000],
  );
  db.run(
    "INSERT INTO review_pr_observations VALUES (?, ?, ?, 990, 'Acme/Renamed', 42, 'Newer private title', 'closed', 1, 0, 'main', ?, 'feature/share', ?, ?, ?, ?, 'installation', 7331, NULL, NULL, 'newer-observation')",
    [newerObservation, workspace, lineageId, sha(1), sha(4), sha(1), Date.now(), Date.now()],
  );
  db.run("INSERT INTO review_revision_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [first.revision, workspace, lineageId, pinnedObservation, sha(1), sha(3), sha(1), Date.now()]);
  db.run("INSERT INTO review_revision_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [second.revision, workspace, lineageId, newerObservation, sha(1), sha(4), sha(1), Date.now()]);

  stackId = tinyId("rsk");
  manifestId = tinyId("rsm");
  stackAccountId = tinyId("rsa");
  db.run(
    "INSERT INTO review_stacks VALUES (?, ?, 'exact-stack', 'Exact stack', 'Acme/Capability', 990, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)",
    [stackId, workspace, owner, tinyId("key"), Date.now(), Date.now()],
  );
  const manifestDoc = {
    identity: { stackId, slug: "exact-stack", title: "Exact stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date().toISOString() },
    repository: { repo: "Acme/Capability", repoId: 990, baseRef: "main" },
    source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null },
    members: [{ lineageId, lineageSlug: "exact-review", prNumber: 42, title: "Exact capability", revisionId: first.revision, revision: 1, accountId: first.account, accountVersion: 1, baseRef: "main", headRef: "feature/share", headSha: sha(3), status: "live", removedReason: null }],
    projects: ["secret-project"],
  };
  db.run("INSERT INTO review_stack_manifests VALUES (?, ?, ?, 'exact-stack', 1, 0, 'created', 1, ?, ?, ?)", [manifestId, stackId, workspace, JSON.stringify(manifestDoc), digest(JSON.stringify(manifestDoc)), Date.now()]);
  const stackAccountDoc = {
    identity: { stackId, slug: "exact-stack", manifestId, version: 1, createdAt: new Date().toISOString() },
    witness: { summary: "One exact member.", agent: { name: "Stack witness", model: "stack-model" }, userId: owner, keyId: tinyId("key") },
    groups: [{ id: "whole", title: "Whole stack", body: "The exact member group.", examples: [], members: [{ lineageId, revision: 1, accountVersion: 1, groupId: "exact" }] }],
  };
  db.run("INSERT INTO review_stack_accounts VALUES (?, ?, ?, ?, 'exact-stack', 1, 1, ?, ?, ?, ?, ?)", [stackAccountId, stackId, manifestId, workspace, JSON.stringify(stackAccountDoc), digest(JSON.stringify(stackAccountDoc)), owner, tinyId("key"), Date.now()]);
});

afterAll(() => server.stop(true));

function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("exact document capabilities", () => {
  test("mints all four immutable document targets with copied inventories", async () => {
    const targets = [
      ["review_document", revisionId, "review_revision"],
      ["review_document", accountId, "review_account"],
      ["stack_document", manifestId, "stack_manifest"],
      ["stack_document", stackAccountId, "stack_account"],
    ] as const;
    for (const [kind, target, documentKind] of targets) {
      const response = await post({ workspace, kind, target, label: documentKind });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.document.kind).toBe(documentKind);
      expect(body.document.title).toBe(kind === "stack_document" ? "Exact stack" : "Exact capability");
      expect(body.document.pin).toBe(documentKind === "review_revision" ? "rev 1" : documentKind === "review_account" ? "v1" : documentKind === "stack_manifest" ? "v1" : "v1 account");
      expect(body.token).toMatch(/^seer_sh_/);
      expect(db.query<{ token_hash: string }, [string]>("SELECT token_hash FROM shares WHERE id = ?").get(body.id)!.token_hash).toBe(hashKey(body.token));
      expect(resolveDocumentCapability(getShare(body.id)!)?.share.id).toBe(body.id);
      expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM share_capability_files WHERE share_id = ?").get(body.id)!.n).toBeGreaterThan(0);
      const files = db.query<{ ordinal: number }, [string]>("SELECT ordinal FROM share_capability_files WHERE share_id = ? ORDER BY ordinal").all(body.id);
      const items = db.query<{ ordinal: number }, [string]>("SELECT ordinal FROM share_capability_items WHERE share_id = ? ORDER BY ordinal").all(body.id);
      expect(items.length).toBeGreaterThan(0);
      expect(files.map((row) => row.ordinal)).toEqual(files.map((_, index) => index + 1));
      expect(items.map((row) => row.ordinal)).toEqual(items.map((_, index) => index + 1));
      const attachments = db.query<{ attachment_id: string }, [string]>("SELECT attachment_id FROM share_capability_attachments WHERE share_id = ? ORDER BY ordinal").all(body.id);
      expect(attachments.map((row) => row.attachment_id)).toEqual(documentKind === "review_revision" ? [] : [attachmentId]);
      if (kind === "stack_document") {
        const staleFallback = await fetch(`${base}/s/${body.token}?fallback-page=2`, { redirect: "manual" });
        expect(staleFallback.status).toBe(303);
        expect(staleFallback.headers.get("location")).toBe(`/s/${body.token}`);
      }
    }
    const replayOne = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "replay", userId: owner, expiresAt: null });
    const replayTwo = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "replay", userId: owner, expiresAt: null });
    expect(replayOne.id).not.toBe(replayTwo.id);
    expect(replayOne.token).not.toBe(replayTwo.token);
    expect([...SHARE_KINDS]).toEqual([...SERVED_SHARE_KINDS]);
  });

  test("soft-misses relational corruption at the shared mint and read boundary", async () => {
    const review = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "relationship review", userId: owner, expiresAt: null });
    const stack = await createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "relationship stack", userId: owner, expiresAt: null });
    const unknown = await (await fetch(`${base}/s/${newShareToken()}`)).text();
    const revision = db.query<{ capture_id: string; doc: string }, [string]>("SELECT capture_id, doc FROM review_revisions WHERE id = ?").get(revisionId)!;
    const account = db.query<{ doc: string }, [string]>("SELECT doc FROM review_accounts WHERE id = ?").get(accountId)!;
    const manifest = db.query<{ doc: string }, [string]>("SELECT doc FROM review_stack_manifests WHERE id = ?").get(manifestId)!;
    const fakeLineage = tinyId("rln");
    const fakeRevision = tinyId("rvr");
    const fakeCapture = tinyId("stg");
    const fakeStack = tinyId("rsk");
    const fakeManifest = tinyId("rsm");
    const fakeAccount = tinyId("rac");
    const manifestWithMember = (change: Record<string, unknown>): string => {
      const document = JSON.parse(manifest.doc) as any;
      Object.assign(document.members[0], change);
      return JSON.stringify(document);
    };
    const cases = [
      {
        name: "workspace", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET workspace_id = ? WHERE id = ?", [otherWorkspace, accountId]),
        restore: () => db.run("UPDATE review_accounts SET workspace_id = ? WHERE id = ?", [workspace, accountId]),
      },
      {
        name: "lineage", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET lineage_id = ? WHERE id = ?", [fakeLineage, accountId]),
        restore: () => db.run("UPDATE review_accounts SET lineage_id = ? WHERE id = ?", [lineageId, accountId]),
      },
      {
        name: "slug", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET slug = 'corrupt-slug' WHERE id = ?", [accountId]),
        restore: () => db.run("UPDATE review_accounts SET slug = 'exact-review' WHERE id = ?", [accountId]),
      },
      {
        name: "revision id", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET revision_id = ? WHERE id = ?", [fakeRevision, accountId]),
        restore: () => db.run("UPDATE review_accounts SET revision_id = ? WHERE id = ?", [revisionId, accountId]),
      },
      {
        name: "revision version", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_revisions SET revision = 9 WHERE id = ?", [revisionId]),
        restore: () => db.run("UPDATE review_revisions SET revision = 1 WHERE id = ?", [revisionId]),
      },
      {
        name: "capture", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_revisions SET capture_id = ? WHERE id = ?", [fakeCapture, revisionId]),
        restore: () => db.run("UPDATE review_revisions SET capture_id = ? WHERE id = ?", [revision.capture_id, revisionId]),
      },
      {
        name: "capture document chain", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE stage_captures SET repo = 'Acme/Corrupt' WHERE id = ?", [revision.capture_id]),
        restore: () => db.run("UPDATE stage_captures SET repo = 'Acme/Capability' WHERE id = ?", [revision.capture_id]),
      },
      {
        name: "account version", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET version = 9 WHERE id = ?", [accountId]),
        restore: () => db.run("UPDATE review_accounts SET version = 1 WHERE id = ?", [accountId]),
      },
      {
        name: "account document chain", capability: review, kind: "review_document", target: accountId,
        mutate: () => db.run("UPDATE review_accounts SET doc = ? WHERE id = ?", [account.doc.replace('"version":1', '"version":9'), accountId]),
        restore: () => db.run("UPDATE review_accounts SET doc = ? WHERE id = ?", [account.doc, accountId]),
      },
      {
        name: "stack", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_manifests SET stack_id = ? WHERE id = ?", [fakeStack, manifestId]),
        restore: () => db.run("UPDATE review_stack_manifests SET stack_id = ? WHERE id = ?", [stackId, manifestId]),
      },
      {
        name: "manifest id", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_accounts SET manifest_id = ? WHERE id = ?", [fakeManifest, stackAccountId]),
        restore: () => db.run("UPDATE review_stack_accounts SET manifest_id = ? WHERE id = ?", [manifestId, stackAccountId]),
      },
      {
        name: "manifest version", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_manifests SET version = 9 WHERE id = ?", [manifestId]),
        restore: () => db.run("UPDATE review_stack_manifests SET version = 1 WHERE id = ?", [manifestId]),
      },
      {
        name: "stack account version", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_accounts SET version = 9 WHERE id = ?", [stackAccountId]),
        restore: () => db.run("UPDATE review_stack_accounts SET version = 1 WHERE id = ?", [stackAccountId]),
      },
      {
        name: "member account id", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifestWithMember({ accountId: fakeAccount }), manifestId]),
        restore: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifest.doc, manifestId]),
      },
      {
        name: "member account version", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifestWithMember({ accountVersion: 9 }), manifestId]),
        restore: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifest.doc, manifestId]),
      },
      {
        name: "manifest document chain", capability: stack, kind: "stack_document", target: stackAccountId,
        mutate: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifest.doc.replace('"version":1', '"version":9'), manifestId]),
        restore: () => db.run("UPDATE review_stack_manifests SET doc = ? WHERE id = ?", [manifest.doc, manifestId]),
      },
    ] as const;
    for (const item of cases) {
      item.mutate();
      try {
        expect(resolveDocumentCapability(getShare(item.capability.id)!)).toBeNull();
        expect(await (await fetch(`${base}/s/${item.capability.token}`)).text()).toBe(unknown);
        const refused = await post({ workspace, kind: item.kind, target: item.target, label: item.name });
        expect(refused.status).toBe(422);
        expect((await refused.json() as any).errors[0].rule).toBe("target_unknown");
      } finally {
        item.restore();
      }
      expect(resolveDocumentCapability(getShare(item.capability.id)!)).not.toBeNull();
    }

    db.run("UPDATE share_document_capabilities SET document_kind = 'stack_manifest' WHERE share_id = ?", [review.id]);
    expect(await (await fetch(`${base}/s/${review.token}`)).text()).toBe(unknown);
    db.run("UPDATE share_document_capabilities SET document_kind = 'review_account' WHERE share_id = ?", [review.id]);
    expect(resolveDocumentCapability(getShare(review.id)!)).not.toBeNull();
  });

  test("renders exact review evidence and bounded retained context without personal state", async () => {
    const revision = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "revision", userId: owner, expiresAt: null });
    const account = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "account", userId: owner, expiresAt: null });
    const revisionPage = await fetch(`${base}/s/${revision.token}`);
    expect(revisionPage.status).toBe(200);
    expect(revisionPage.headers.get("cache-control")).toBe("no-store");
    const revisionHtml = visible(await revisionPage.text());
    expect(revisionHtml).toContain("rev 1");
    expect(revisionHtml).not.toContain("Witness account 1");
    expect(revisionHtml).not.toContain("secret-project");
    expect(revisionHtml).toContain("Pinned PR title");
    expect(revisionHtml).toContain("https://github.com/Acme/Capability/pull/42");
    expect(revisionHtml).not.toContain("Newer private title");
    expect(revisionHtml).not.toContain("Acme/Renamed");
    expect(revisionHtml).not.toContain("rev 2 available");
    expect(revisionHtml).not.toContain(owner);
    expect(revisionHtml).not.toContain("read-form");
    expect(revisionHtml).not.toContain("unread");
    expect(revisionHtml).not.toContain(`/${workspace}/`);

    const accountHtml = visible(await (await fetch(`${base}/s/${account.token}`)).text());
    expect(accountHtml).toContain("Witness account 1");
    expect(accountHtml).not.toContain("Witness account 2");
    expect(accountHtml).toContain("private-bundle v7");
    expect(accountHtml).not.toContain(`/${workspace}/b/private-bundle`);

    const lines = await fetch(`${base}/s/${revision.token}/files/${fileId}?side=new&start=2&end=2`);
    expect(lines.status).toBe(200);
    expect((await lines.json() as any).lines).toEqual([{ number: 2, text: "export const value = 1;" }]);
    expect((await fetch(`${base}/s/${revision.token}/files/${fileId}?side=new&start=1&end=401`)).status).toBe(422);
    const tooLarge = await fetch(`${base}/s/${revision.token}/files/${largeFileId}?side=new&start=1&end=1`);
    expect(tooLarge.status).toBe(422);
    expect((await tooLarge.json() as any).error).toContain("response budget");

    const accountFocus = await (await fetch(`${base}/s/${account.token}?review=exact`)).text();
    expect(accountFocus).toContain(`<a class="context-trigger" href="/s/${account.token}/files/${fileId}?side=new&amp;start=1&amp;end=163"`);
    const noJsContext = await fetch(`${base}/s/${account.token}/files/${fileId}?side=new&start=1&end=163`, { headers: { accept: "text/html" } });
    expect(noJsContext.status).toBe(200);
    expect((await noJsContext.json() as any).lines).toEqual([
      { number: 1, text: "const before = true;" },
      { number: 2, text: "export const value = 1;" },
      { number: 3, text: "const after = true;" },
      { number: 4, text: "const untouched = 1;" },
      { number: 5, text: "const tail = true;" },
    ]);
    const memberFocus = await (await fetch(`${base}/${workspace}/r/exact-review/v/1?review=exact`)).text();
    expect(memberFocus).toContain("<button class=\"context-trigger\" type=\"button\" data-context-trigger");

    const stack = await createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "stack account", userId: owner, expiresAt: null });
    const stackRoot = await fetch(`${base}/s/${stack.token}`);
    expect(stackRoot.status).toBe(200);
    expect(visible(await stackRoot.text())).toContain("One exact member.");
    const stackGroup = await fetch(`${base}/s/${stack.token}?review=whole&page=1`);
    expect(stackGroup.status).toBe(200);
    const stackHtml = visible(await stackGroup.text());
    expect(stackHtml).toContain("The exact member group.");
    expect(stackHtml).toContain("Whole stack · 1 layer");
    expect(stackHtml).not.toContain("read-form");
    expect(stackHtml).toContain(`href="/s/${stack.token}?layer=exact-review"`);
    const stackUrls = attributeUrls(stackHtml);
    expect(stackUrls.filter((value) => value.includes(`/${workspace}/`))).toEqual([]);
    expect(stackUrls.filter((value) => value.startsWith("/")).every((value) => value.startsWith(`/s/${stack.token}`))).toBe(true);

    const memberReview = await (await fetch(`${base}/${workspace}/r/exact-review/v/1`)).text();
    expect(memberReview).toContain(`data-kind="review_document" data-target="${accountId}"`);
    expect(memberReview).toContain('<form method="post" action="/api/shares">');
    const memberStack = await (await fetch(`${base}/${workspace}/r-stacks/exact-stack/v/1/account`)).text();
    expect(memberStack).toContain(`data-kind="stack_document" data-target="${stackAccountId}"`);
  });

  test("creates a share through the native no-JavaScript form and returns its one-time link", async () => {
    const returnTo = `/${workspace}/r/exact-review/v/1?review=exact`;
    const response = await fetch(`${base}/api/shares`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        workspace,
        kind: "review_document",
        target: accountId,
        label: "No JavaScript",
        return: returnTo,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Link created");
    expect(html).toMatch(/href="http:\/\/localhost:0\/s\/seer_sh_[^"]+"/);
    expect(html).toContain(`href="${returnTo}"`);
  });

  test("preserves historical positions above 16 and excludes removed positions", async () => {
    const stored = db.query<{ doc: string }, [string]>("SELECT doc FROM review_stack_manifests WHERE id = ?").get(manifestId)!;
    const original = JSON.parse(stored.doc) as any;
    const live = original.members[0];
    const removed = { ...live, status: "removed", removedReason: "detached" };
    const position = 64;
    const document = {
      ...original,
      identity: { ...original.identity, version: 2, predecessorVersion: 1, reason: "refresh", createdAt: new Date().toISOString() },
      members: [...Array.from({ length: position - 1 }, () => ({ ...removed })), live],
    };
    const historicalManifest = tinyId("rsm");
    db.run(
      "INSERT INTO review_stack_manifests VALUES (?, ?, ?, 'exact-stack', 2, 1, 'refresh', 1, ?, ?, ?)",
      [historicalManifest, stackId, workspace, JSON.stringify(document), digest(JSON.stringify(document)), Date.now()],
    );
    const capability = await createDocumentCapability({ wsId: workspace, kind: "stack_document", target: historicalManifest, label: "historical positions", userId: owner, expiresAt: null });
    const grantedPositions = db.query<{ member_position: number }, [string]>("SELECT member_position FROM share_capability_files WHERE share_id = ?").all(capability.id).map((row) => row.member_position);
    expect(grantedPositions.length).toBe(2);
    expect(grantedPositions.every((value) => value === position)).toBe(true);
    db.run("UPDATE review_stacks SET latest_manifest_version = 99, base_ref = 'moved-base' WHERE id = ?", [stackId]);
    try {
      expect(resolveCapabilityTargetForMint(workspace, "stack_document", historicalManifest).documentId).toBe(historicalManifest);
      expect(resolveDocumentCapability(getShare(capability.id)!)).not.toBeNull();
    } finally {
      db.run("UPDATE review_stacks SET latest_manifest_version = 1, base_ref = 'main' WHERE id = ?", [stackId]);
    }

    const retained = await fetch(`${base}/s/${capability.token}/m/${position}/files/${fileId}?side=new&start=2&end=2`);
    expect(retained.status).toBe(200);
    expect((await retained.json() as any).lines[0].text).toBe("export const value = 1;");
    const unknown = await (await fetch(`${base}/s/${newShareToken()}`)).text();
    expect(await (await fetch(`${base}/s/${capability.token}/m/1/files/${fileId}?side=new&start=1&end=1`)).text()).toBe(unknown);

    const privateRemoved = await fetch(`${base}/api/review-stacks/exact-stack/manifests/2/members/1/files/${fileId}?side=new&start=1&end=1`);
    const privateLive = await fetch(`${base}/api/review-stacks/exact-stack/manifests/2/members/${position}/files/${fileId}?side=new&start=1&end=1`);
    expect(privateRemoved.status).toBe(404);
    expect(privateLive.status).toBe(200);
  });

  test("never widens to later files, foreign positions, attachments, or unsupported tails", async () => {
    const review = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "review", userId: owner, expiresAt: null });
    const stack = await createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "stack", userId: owner, expiresAt: null });
    const unknown = await fetch(`${base}/s/${newShareToken()}`);
    const expected = await unknown.text();
    for (const url of [
      `${base}/s/${review.token}/files/${laterFileId}?side=new&start=1&end=1`,
      `${base}/s/${stack.token}/m/2/files/${fileId}?side=new&start=1&end=1`,
      `${base}/s/${stack.token}/account`,
      `${base}/s/${review.token}/v/2`,
      `${base}/s/${review.token}?conversation=snapshot`,
      `${base}/s/${review.token}/threads`,
      `${base}/s/${review.token}/a/att_0000000000`,
    ]) {
      const miss = await fetch(url);
      expect(miss.status).toBe(404);
      expect(await miss.text()).toBe(expected);
      expect(miss.headers.get("cache-control")).toBe("no-store");
      expect(miss.headers.get("referrer-policy")).toBe("no-referrer");
      expect(miss.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    const attachment = await fetch(`${base}/s/${review.token}/a/${attachmentId}`);
    expect(attachment.status).toBe(200);
    expect(await attachment.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer);

    const narrowed = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "corrupt item", userId: owner, expiresAt: null });
    db.run("DELETE FROM share_capability_items WHERE share_id = ? AND ordinal = 1", [narrowed.id]);
    expect(await (await fetch(`${base}/s/${narrowed.token}`)).text()).toBe(expected);
    const mismatched = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "corrupt scope", userId: owner, expiresAt: null });
    db.run("UPDATE share_document_capabilities SET document_id = ? WHERE share_id = ?", [revisionId, mismatched.id]);
    expect(await (await fetch(`${base}/s/${mismatched.token}`)).text()).toBe(expected);
  });

  test("validates exact families, workspace scope, unknown fields, and token-once listing", async () => {
    for (const [kind, target, rule] of [
      ["review_document", manifestId, "target_malformed"],
      ["stack_document", revisionId, "target_malformed"],
      ["review_document", tinyId("rvr"), "target_unknown"],
    ] as const) {
      const response = await post({ workspace, kind, target });
      expect(response.status).toBe(422);
      expect((await response.json() as any).errors[0].rule).toBe(rule);
    }
    const cross = await post({ workspace: otherWorkspace, kind: "review_document", target: revisionId });
    expect(cross.status).toBe(422);
    expect((await cross.json() as any).errors[0].rule).toBe("target_unknown");
    const conversation = await post({ workspace, kind: "review_document", target: revisionId, conversation: true });
    expect(conversation.status).toBe(200);
    const conversationBody = await conversation.json() as any;
    expect(conversationBody.conversation).toBe(true);
    expect(db.query<{ conversation_scope: string }, [string]>("SELECT conversation_scope FROM share_document_capabilities WHERE share_id = ?").get(conversationBody.id)?.conversation_scope).toBe("snapshot");

    const minted = await (await post({ workspace, kind: "review_document", target: accountId, label: "listed" })).json() as any;
    const mintedStack = await (await post({ workspace, kind: "stack_document", target: stackAccountId, label: "listed stack" })).json() as any;
    const listing = await (await fetch(`${base}/api/shares?workspace=${workspace}`)).text();
    expect(listing).not.toContain(minted.token);
    expect(listing).not.toContain(mintedStack.token);
    const rows = (JSON.parse(listing) as any).shares;
    expect(rows.find((share: any) => share.id === minted.id).document).toEqual({ kind: "review_account", slug: "exact-review", pin: "v1", title: "Exact capability" });
    expect(rows.find((share: any) => share.id === mintedStack.id).document).toEqual({ kind: "stack_account", slug: "exact-stack", pin: "v1 account", title: "Exact stack" });
  });

  test("snapshots exact local conversation and remains read-only", async () => {
    const local = createLocalThread({
      workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId,
      anchor: { workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null },
      body: "Included at mint", author: { kind: "member", userId: owner }, idempotencyKey: "capability-conversation-create",
    });
    createLocalThread({
      workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId,
      anchor: { workspace_id: workspace, anchor_kind: "member_group", lineage_id: lineageId, revision_id: revisionId, account_id: accountId, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: "exact", change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null },
      body: "Account-only group conversation", author: { kind: "member", userId: owner }, idempotencyKey: "capability-account-only-thread",
    });
    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "conversation snapshot", userId: owner, expiresAt: null, conversation: true });
    appendLocalReply({ workspaceId: workspace, threadId: local.thread.id, body: "Too late for the snapshot", author: { kind: "member", userId: owner }, idempotencyKey: "capability-conversation-late" });
    const html = visible(await (await fetch(`${base}/s/${capability.token}`)).text());
    expect(html).toContain("Included at mint");
    expect(html).not.toContain("Too late for the snapshot");
    expect(html).not.toContain("Account-only group conversation");
    expect(html).not.toContain("thread-reply");
    expect(html).not.toContain("thread-new");
    expect(html).not.toContain(owner);
    expect(await fetch(`${base}/s/${capability.token}`, { method: "POST" }).then((response) => response.status)).toBe(405);
  });

  test("shows stable teammate attribution only on private member pages", async () => {
    createLocalThread({
      workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId,
      anchor: { workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null },
      body: "Attributed teammate message", author: { kind: "member", userId: otherMember }, idempotencyKey: "capability-attributed-member",
    });
    const page = await (await fetch(`${base}/${workspace}/r/exact-review/rev/1`)).text();
    expect(page).toContain("teammate");
    const api = await (await fetch(`${base}/api/review-lineages/exact-review/conversations?workspace=${workspace}`)).text();
    expect(api).toContain('"label": "Member"');
    expect(api).not.toContain('"label": "teammate"');
    expect(api).not.toContain("teammate@example.com");
  });

  test("snapshots only imported bodies placeable on the exact retained head", async () => {
    const observedAt = Date.now();
    const imported = (id: string, commitSha: string, path = "src/value.ts") => {
      const thread = recordGithubThreadWebhook({ workspaceId: workspace, lineageId, repoId: 990, prNumber: 42, sourceId: `cap-scope-${id}`, sourceAt: observedAt, nodeId: `CAP_SCOPE_THREAD_${id}`, firstCommentDatabaseId: id, resolved: false, path, side: "new", startLine: 1, endLine: 1, commitSha, githubUrl: `https://github.test/comment/${id}` });
      recordGithubCommentWebhook({ workspaceId: workspace, threadId: thread, sourceId: `cap-scope-${id}`, sourceAt: observedAt, databaseId: id, nodeId: `CAP_SCOPE_COMMENT_${id}`, createdAt: observedAt, updatedAt: observedAt, authorLogin: "reviewer", body: `Imported ${id}`, githubUrl: `https://github.test/comment/${id}`, deleted: false });
      return thread;
    };
    const exactThread = imported("9101", sha(3));
    const laterThread = imported("9102", sha(4));
    imported("9103", sha(99), "missing.ts");
    const exactReview = recordGithubReviewWebhook({ workspaceId: workspace, lineageId, sourceId: "cap-review-exact", sourceAt: observedAt, review: { databaseId: "9201", nodeId: "CAP_REVIEW_EXACT", authorLogin: "reviewer", state: "commented", body: "Exact review body", url: "https://github.test/review/9201", commitSha: sha(3), submittedAt: observedAt, dismissed: false } });
    recordGithubReviewWebhook({ workspaceId: workspace, lineageId, sourceId: "cap-review-later", sourceAt: observedAt, review: { databaseId: "9202", nodeId: "CAP_REVIEW_LATER", authorLogin: "reviewer", state: "commented", body: "Later review body", url: "https://github.test/review/9202", commitSha: sha(4), submittedAt: observedAt, dismissed: false } });

    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "exact imported scope", userId: owner, expiresAt: null, conversation: true });
    expect(db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM share_capability_github_threads WHERE share_id = ?").all(capability.id)).toEqual([{ thread_id: exactThread }]);
    expect(db.query<{ review_id: string }, [string]>("SELECT review_id FROM share_capability_github_reviews WHERE share_id = ?").all(capability.id)).toEqual([{ review_id: exactReview }]);
    const overview = visible(await (await fetch(`${base}/s/${capability.token}`)).text());
    const detail = visible(await (await fetch(`${base}/s/${capability.token}?review=seam-1`)).text());
    expect(`${overview}${detail}`).toContain("Imported 9101");
    expect(`${overview}${detail}`).toContain("Exact review body");
    expect(`${overview}${detail}`).not.toContain("Imported 9102");
    expect(`${overview}${detail}`).not.toContain("Imported 9103");
    expect(`${overview}${detail}`).not.toContain("Later review body");

    db.run("UPDATE share_capability_github_threads SET workspace_id = ? WHERE share_id = ? AND thread_id = ?", [otherWorkspace, capability.id, exactThread]);
    expect((await fetch(`${base}/s/${capability.token}`)).status).toBe(404);
    db.run("UPDATE share_capability_github_threads SET workspace_id = ? WHERE share_id = ? AND thread_id = ?", [workspace, capability.id, exactThread]);
    const laterObservation = db.query<{ id: string }, [string]>("SELECT id FROM review_github_thread_observations WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(laterThread)!.id;
    db.run("UPDATE share_capability_github_threads SET thread_id = ?, thread_observation_id = ? WHERE share_id = ? AND thread_id = ?", [laterThread, laterObservation, capability.id, exactThread]);
    expect((await fetch(`${base}/s/${capability.token}`)).status).toBe(404);
  });

  test("merges a mapped GitHub thread once and suppresses its empty wrapper review", async () => {
    const observedAt = Date.now();
    const local = createLocalThread({
      workspaceId: workspace,
      scopeKind: "lineage",
      scopeId: lineageId,
      anchor: { workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null },
      body: "Mapped capability thread",
      author: { kind: "member", userId: owner },
      idempotencyKey: "capability-mapped-local",
    });
    const importedThread = recordGithubThreadWebhook({
      workspaceId: workspace, lineageId, repoId: 990, prNumber: 42,
      sourceId: "cap-mapped-thread", sourceAt: observedAt,
      nodeId: "CAP_MAPPED_THREAD", firstCommentDatabaseId: "9301", resolved: false,
      path: "src/value.ts", side: "new", startLine: 1, endLine: 1,
      commitSha: sha(3), githubUrl: "https://github.test/comment/9301",
    });
    recordGithubCommentWebhook({
      workspaceId: workspace, threadId: importedThread,
      sourceId: "cap-mapped-comment", sourceAt: observedAt,
      databaseId: "9301", nodeId: "CAP_MAPPED_COMMENT", createdAt: observedAt,
      updatedAt: observedAt, authorLogin: "owner", body: "Mapped capability thread",
      githubUrl: "https://github.test/comment/9301", deleted: false,
    });
    const wrapperReview = recordGithubReviewWebhook({
      workspaceId: workspace, lineageId, sourceId: "cap-mapped-review", sourceAt: observedAt,
      review: { databaseId: "9302", nodeId: "CAP_MAPPED_REVIEW", authorLogin: "owner", state: "commented", body: "", url: "https://github.test/review/9302", commitSha: sha(3), submittedAt: observedAt, dismissed: false },
    });
    mapSubmittedGithubThread({
      workspaceId: workspace,
      lineageId,
      revisionId,
      localThreadId: local.thread.id,
      localMessageId: local.entries[0]!.id,
      submissionId: tinyId("gsb"),
      githubReviewId: "CAP_MAPPED_REVIEW",
      githubThreadId: "CAP_MAPPED_THREAD",
      githubCommentId: "CAP_MAPPED_COMMENT",
      commitSha: sha(3),
    });

    const capability = await createDocumentCapability({
      wsId: workspace, kind: "review_document", target: revisionId,
      label: "mapped conversation", userId: owner, expiresAt: null, conversation: true,
    });
    const resolved = resolveDocumentCapability(getShare(capability.id)!)!;
    const conversation = await readCapabilityConversation(resolved);
    expect(conversation).not.toBeNull();
    expect(conversation!.imported.map((thread) => thread.id)).not.toContain(importedThread);
    expect(conversation!.reviews.map((review) => review.id)).not.toContain(wrapperReview);
    const projected = conversation!.local.find((thread) => thread.id === local.thread.id)!;
    expect(projected.entries.filter((entry) => entry.body === "Mapped capability thread")).toHaveLength(1);
  });

  test("pins stack reads and witness context to the exact stack account and member document", async () => {
    const direct = createLocalThread({ workspaceId: workspace, scopeKind: "stack", scopeId: stackId, anchor: { workspace_id: workspace, anchor_kind: "stack", lineage_id: null, revision_id: null, account_id: null, stack_id: stackId, stack_manifest_id: manifestId, stack_account_id: stackAccountId, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null }, body: "Exact stack account thread", author: { kind: "member", userId: owner }, idempotencyKey: "stack-direct-context" });
    const directGroup = createLocalThread({ workspaceId: workspace, scopeKind: "stack", scopeId: stackId, anchor: { workspace_id: workspace, anchor_kind: "stack_group", lineage_id: null, revision_id: null, account_id: null, stack_id: stackId, stack_manifest_id: manifestId, stack_account_id: stackAccountId, group_id: "whole", change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null }, body: "Exact stack group thread", author: { kind: "member", userId: owner }, idempotencyKey: "stack-group-context" });
    const exact = createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId, anchor: { workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null }, body: "Pinned member revision thread", author: { kind: "member", userId: owner }, idempotencyKey: "stack-member-exact" });
    const later = createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId, anchor: { workspace_id: workspace, anchor_kind: "review", lineage_id: lineageId, revision_id: laterRevisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: null, side: null, start_line: null, end_line: null, range_kind: null, old_object_digest: null, new_object_digest: null, object_digest: null }, body: "Later member revision thread", author: { kind: "member", userId: owner }, idempotencyKey: "stack-member-later" });
    const manifest = getStackManifest(workspace, "exact-stack", 1)!;
    const witness = await stackWitnessConversationContext(workspace, manifest);
    expect(witness.local.map((thread) => thread.id)).toContain(direct.thread.id);
    expect(witness.local.map((thread) => thread.id)).toContain(directGroup.thread.id);
    expect(witness.local.map((thread) => thread.id)).toContain(exact.thread.id);
    expect(witness.local.map((thread) => thread.id)).not.toContain(later.thread.id);
    expect(JSON.stringify(witness)).toContain("Imported 9101");
    expect(JSON.stringify(witness)).not.toContain("Imported 9102");
    expect(JSON.stringify(witness)).toContain("Exact review body");
    expect(JSON.stringify(witness)).not.toContain("Later review body");

    const api = await fetch(`${base}/api/review-stacks/exact-stack/manifests/1/conversations?workspace=${workspace}`);
    expect(api.status).toBe(200);
    const body = await api.json() as any;
    expect(body.local.map((thread: any) => thread.id)).toContain(direct.thread.id);
    expect(body.local.map((thread: any) => thread.id)).toContain(directGroup.thread.id);
    expect(body.local.map((thread: any) => thread.id)).toContain(exact.thread.id);
    expect(body.local.map((thread: any) => thread.id)).not.toContain(later.thread.id);
    expect(JSON.stringify(body)).toContain("Imported 9101");
    expect(JSON.stringify(body)).not.toContain("Imported 9102");
  });

  test("renders one range thread in detail and never in overview", async () => {
    const objectDigest = db.query<{ new_blob_sha: string }, [string]>("SELECT new_blob_sha FROM stage_capture_files WHERE id = ?").get(fileId)!.new_blob_sha;
    const range = createLocalThread({ workspaceId: workspace, scopeKind: "lineage", scopeId: lineageId, anchor: { workspace_id: workspace, anchor_kind: "range", lineage_id: lineageId, revision_id: revisionId, account_id: null, stack_id: null, stack_manifest_id: null, stack_account_id: null, group_id: null, change_id: null, file_id: fileId, side: "new", start_line: 1, end_line: 1, range_kind: "changed", old_object_digest: null, new_object_digest: null, object_digest: objectDigest }, body: "Range appears once", author: { kind: "member", userId: owner }, idempotencyKey: "capability-range-once" });
    const overview = await (await fetch(`${base}/${workspace}/r/exact-review/v/1`)).text();
    const detail = await (await fetch(`${base}/${workspace}/r/exact-review/v/1?review=exact`)).text();
    expect(overview).not.toContain("Range appears once");
    expect(detail.match(new RegExp(`id="${range.thread.id}"`, "g"))).toHaveLength(1);

    const firstChange = db.query<{ id: string }, [string]>("SELECT id FROM stage_capture_changes WHERE file_id = ? LIMIT 1").get(fileId)!.id;
    const secondChange = `chg_${digest("second-overlapping-home")}`;
    const projected = projectLocalThread(range, owner);
    const homes = conversationPlacementHomes({ local: [projected], imported: [], reviews: [], importState: "never", complete: true, truncated: false, exactRevisionId: revisionId, exactAccountId: accountId, createAction: null, replyAction: null, resolutionAction: null, refreshAction: null, returnTo: "/" }, [
      { id: firstChange, file_id: fileId, old_start: 1, old_lines: 1, new_start: 1, new_lines: 1 },
      { id: secondChange, file_id: fileId, old_start: 1, old_lines: 1, new_start: 1, new_lines: 1 },
    ] as any);
    expect(homes.local.get(range.thread.id)).toBe(firstChange);
  });

  test("lets a later GitHub tombstone override a copied imported body", async () => {
    const observedAt = Date.now();
    const githubThread = recordGithubThreadWebhook({ workspaceId: workspace, lineageId, repoId: 990, prNumber: 42, sourceId: "cap-import", sourceAt: observedAt, nodeId: null, firstCommentDatabaseId: "9000000000000001", resolved: false, path: "src/value.ts", side: "new", startLine: 1, endLine: 1, commitSha: sha(3), githubUrl: "https://github.test/comment" });
    recordGithubCommentWebhook({ workspaceId: workspace, threadId: githubThread, sourceId: "cap-import", sourceAt: observedAt, databaseId: "9000000000000001", nodeId: "CAP_COMMENT", createdAt: observedAt, updatedAt: observedAt, authorLogin: "reviewer", body: "Private imported body", githubUrl: "https://github.test/comment", deleted: false });
    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "import tombstone", userId: owner, expiresAt: null, conversation: true });
    recordGithubCommentWebhook({ workspaceId: workspace, threadId: githubThread, sourceId: "cap-delete", sourceAt: observedAt + 1, databaseId: "9000000000000001", nodeId: "CAP_COMMENT", createdAt: observedAt, updatedAt: observedAt + 1, authorLogin: "reviewer", body: null, githubUrl: "https://github.test/comment", deleted: true });
    const html = visible(await (await fetch(`${base}/s/${capability.token}?review=seam-1`)).text());
    expect(html).toContain("Deleted on GitHub");
    expect(html).not.toContain("Private imported body");
  });

  test("gives a fresh witness every open thread and waits for a refresh lease", async () => {
    const requestId = tinyId("wtr");
    db.run("INSERT INTO review_witness_requests VALUES (?, ?, ?, ?, 1, 'pending', 0, NULL, NULL, ?, ?)", [requestId, workspace, lineageId, revisionId, Date.now(), Date.now()]);
    const running = tinyId("rci");
    db.run("INSERT INTO review_conversation_imports (id, workspace_id, lineage_id, observation_id, state, actor_kind, installation_id, lease_token, lease_expires_at, started_at) VALUES (?, ?, ?, 'pob_refresh00', 'running', 'installation', 7331, 'lease', ?, ?)", [running, workspace, lineageId, Date.now() + 60_000, Date.now()]);
    const blocked = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    expect(blocked.status).toBe(409);
    db.run("UPDATE review_conversation_imports SET state = 'failed', lease_token = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?", [Date.now(), running]);
    const claimed = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    expect(claimed.status).toBe(200);
    const body = await claimed.json() as any;
    expect(body.threads.local.some((thread: any) => thread.entries.some((entry: any) => entry.body === "Included at mint"))).toBe(true);
    expect(JSON.stringify(body.threads)).not.toContain(owner);
    expect(JSON.stringify(body.threads)).not.toContain("key_");
  });

  test("serves member and no-JavaScript thread forms with pinned 303 returns", async () => {
    const page = await (await fetch(`${base}/${workspace}/r/exact-review/v/1?review=exact`)).text();
    expect(page).toContain("thread-new");
    expect(page).toContain("thread-reply");
    expect(page).toContain('<details class="thread-composer"><summary><span class="disclosure-cue" aria-hidden="true">›</span><span>New thread</span></summary>');
    expect(page).not.toContain('<details class="thread-composer" open>');
    expect(page).toContain("data-line-select");
    expect(page).toContain(`action="/${workspace}/r/exact-review/v/1/threads"`);
    const created = await fetch(`${base}/${workspace}/r/exact-review/rev/1/threads`, {
      method: "POST",
      body: new URLSearchParams({ anchorKind: "change", changeId: db.query<{ id: string }, [string]>("SELECT id FROM stage_capture_changes WHERE file_id = ?").get(fileId)!.id, body: "No JavaScript change thread", idempotencyKey: "no-js-change", return: `/${workspace}/r/exact-review/rev/1?review=src-value-ts` }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    const location = created.headers.get("location")!;
    expect(location).toMatch(new RegExp(`^/${workspace}/r/exact-review/rev/1.*#rth_`));
    const threadId = location.match(/#(rth_[0-9a-z]+)$/)![1]!;
    const reply = await fetch(`${base}/${workspace}/review-threads/${threadId}/replies`, { method: "POST", body: new URLSearchParams({ body: "No JavaScript reply", idempotencyKey: "no-js-reply", return: `/${workspace}/r/exact-review/rev/1?review=exact` }), redirect: "manual" });
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toContain(`#${threadId}`);
    const resolved = await fetch(`${base}/${workspace}/review-threads/${threadId}/resolution`, { method: "POST", body: new URLSearchParams({ state: "resolved", idempotencyKey: "no-js-resolve", return: `/${workspace}/r/exact-review/rev/1?review=exact` }), redirect: "manual" });
    expect(resolved.status).toBe(303);
  });

  test("should use one disclosure grammar and put change details before document actions", async () => {
    const overview = visible(await (await fetch(`${base}/${workspace}/r/exact-review/v/1`)).text());
    const focused = visible(await (await fetch(`${base}/${workspace}/r/exact-review/v/1?review=exact`)).text());
    for (const className of ["focus-item", "material-fact", "document-share", "tree-folder"]) {
      expect(overview).toMatch(new RegExp(`class="[^"]*${className}[^"]*"[\\s\\S]*?<summary[^>]*><span class="disclosure-cue"`));
    }
    expect(focused).toMatch(/class="file-disclosure"[^>]*><span class="disclosure-cue">›<\/span>/);
    const ledger = focused.indexOf('class="ledger-card');
    expect(ledger).toBeGreaterThan(-1);
    for (const action of ['class="focus-pr-source"', 'class="document-share"', 'class="github-projection"', 'class="judgment"']) {
      expect(focused.indexOf(action)).toBeGreaterThan(ledger);
    }
    expect(focused.match(/data-read-state><span class="read-mark" data-read-mark aria-hidden="true">○<\/span><span>Unread<\/span>/g)).toHaveLength(2);
    const lineButtons = [...focused.matchAll(/<button[^>]*data-line-select[^>]*>/g)].map((match) => match[0]);
    expect(lineButtons.length).toBeGreaterThan(4);
    expect(lineButtons.every((tag) => tag.includes('aria-pressed="false"') && /tabindex="(?:0|-1)"/.test(tag))).toBe(true);
    expect(lineButtons.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(4);
  });

  test("scope none remains byte-equivalent when snapshot rows are poisoned", async () => {
    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "none stays none", userId: owner, expiresAt: null });
    const before = await (await fetch(`${base}/s/${capability.token}`)).text();
    db.run("INSERT INTO share_capability_local_threads VALUES (?, ?, 'rth_0000000000', 1, 1)", [capability.id, workspace]);
    db.run("INSERT INTO share_capability_github_threads VALUES (?, ?, 'rgt_0000000000', 'rgo_0000000000', 1)", [capability.id, workspace]);
    const after = await (await fetch(`${base}/s/${capability.token}`)).text();
    expect(after).toBe(before);
    expect(db.query<{ conversation_scope: string }, [string]>("SELECT conversation_scope FROM share_document_capabilities WHERE share_id = ?").get(capability.id)?.conversation_scope).toBe("none");
  });

  test("projects listing and redirect metadata from only the exact target row", async () => {
    const capability = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "projected row", userId: owner, expiresAt: null });
    const share = getShare(capability.id)!;
    const stored = db.query<{ capture_id: string; doc: string }, [string]>("SELECT capture_id, doc FROM review_revisions WHERE id = ?").get(revisionId)!;
    const displacedCapture = tinyId("stg");
    db.run("UPDATE stage_captures SET id = ? WHERE id = ?", [displacedCapture, stored.capture_id]);
    try {
      expect(documentProjectionForShare(share)).toEqual({
        kind: "review_revision",
        slug: "exact-review",
        pin: "rev 1",
        title: "Exact capability",
      });
      expect(capabilityAssetPath(share)).toBe(`/${workspace}/r/exact-review/rev/1`);
      db.run("UPDATE review_revisions SET doc = '{' WHERE id = ?", [revisionId]);
      expect(documentProjectionForShare(share)).toBeNull();
    } finally {
      db.run("UPDATE review_revisions SET doc = ? WHERE id = ?", [stored.doc, revisionId]);
      db.run("UPDATE stage_captures SET id = ? WHERE id = ?", [stored.capture_id, displacedCapture]);
    }
  });

  test("rejects non-reads before token resolution", async () => {
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shares").get()!.n;
    const response = await fetch(`${base}/s/${newShareToken()}`, { method: "POST", body: "x" });
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shares").get()!.n).toBe(before);
  });

  test("drives member conversation in live Chrome at phone, desktop, wide, light, dark and no-JavaScript", async () => {
    const evidenceDir = "/home/kristofferremback/.cache/pi/seer-task9/browser";
    rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(evidenceDir, { recursive: true });
    const review = await createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "browser review", userId: owner, expiresAt: null, conversation: true });
    const stack = await createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "browser stack", userId: owner, expiresAt: null });
    const log: string[] = [];
    const mark = async (message: string) => {
      log.push(message);
      await Bun.write(`${evidenceDir}/evidence.txt`, `${log.join("\n")}\n`);
    };
    const launch = async (name: string, options: Omit<Parameters<typeof ChromePage.launch>[0], "name" | "profileRoot">) => {
      const page = await ChromePage.launch({ ...options, name, profileRoot: evidenceDir });
      await mark(`${name}: live ${base}, Chrome PID ${page.pid}`);
      return page;
    };
    const threadByBody = (body: string) => db.query<{ id: string }, [string]>("SELECT thread_id AS id FROM review_thread_entries WHERE body = ? ORDER BY rowid DESC LIMIT 1").get(body)!.id;
    const anchorByBody = (body: string) => db.query<{ start_line: number; end_line: number }, [string]>("SELECT a.start_line, a.end_line FROM review_thread_entries e JOIN review_thread_anchors a ON a.thread_id = e.thread_id WHERE e.body = ? ORDER BY e.rowid DESC LIMIT 1").get(body)!;

    const desktop = await launch("member-1440-dark", { width: 1440, dark: true, javascript: true });
    let browserRefreshImport: string | null = null;
    let browserRefreshKey: string | null = null;
    try {
      db.run("UPDATE review_lineage_prs SET actor_kind = 'installation', installation_id = 7331, user_id = NULL, credential_id = NULL WHERE workspace_id = ? AND lineage_id = ?", [workspace, lineageId]);
      const observationId = db.query<{ id: string }, [string, string]>("SELECT id FROM review_pr_observations WHERE workspace_id = ? AND lineage_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1").get(workspace, lineageId)!.id;
      browserRefreshImport = tinyId("rci");
      const refreshedAt = Date.now();
      db.run("INSERT INTO review_conversation_imports (id, workspace_id, lineage_id, observation_id, state, complete, actor_kind, installation_id, started_at, completed_at) VALUES (?, ?, ?, ?, 'completed', 1, 'installation', 7331, ?, ?)", [browserRefreshImport, workspace, lineageId, observationId, refreshedAt, refreshedAt]);
      await desktop.navigate(`${base}/${workspace}/r/exact-review/v/1`);
      await mark("member-1440-dark: page loaded");
      expect(await desktop.evaluate<{ width: number; theme: string }>(`({width:innerWidth,theme:document.documentElement.dataset.theme})`)).toEqual({ width: 1440, theme: "dark" });
      await desktop.evaluate("document.querySelector('.discussion > .thread-composer').open=true");
      await desktop.setValue(".discussion > .thread-composer > form.thread-new textarea", "Chrome created thread");
      await desktop.activateAndWaitForLoad(".discussion > .thread-composer > form.thread-new button[type=submit]");
      const createdId = await desktop.evaluate<string>("location.hash.slice(1)");
      expect(createdId).toMatch(/^rth_/);
      expect(threadByBody("Chrome created thread")).toBe(createdId);
      expect(await desktop.evaluate<number>(`document.querySelectorAll('#${createdId}').length`)).toBe(1);

      await desktop.setValue(`#${createdId} .thread-reply textarea`, "Chrome member reply");
      await desktop.activateAndWaitForLoad(`#${createdId} .thread-reply button[type=submit]`);
      expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_thread_entries WHERE thread_id = ?").get(createdId)!.n).toBe(2);
      expect(await desktop.evaluate<number>(`[...document.querySelectorAll('#${createdId} .markdown')].filter(node=>node.textContent.includes('Chrome member reply')).length`)).toBe(1);

      await desktop.activateAndWaitForLoad(`#${createdId} .thread-resolution button[type=submit]`);
      await desktop.waitFor(`document.querySelector('#${createdId}')?.dataset.threadState==='resolved'`);
      expect(await desktop.evaluate<string>(`document.querySelector('#${createdId}').dataset.threadState`)).toBe("resolved");
      await desktop.activateAndWaitForLoad(`#${createdId} .thread-resolution button[type=submit]`);
      await desktop.waitFor(`document.querySelector('#${createdId}')?.dataset.threadState==='open'`);
      expect(await desktop.evaluate<string>(`document.querySelector('#${createdId}').dataset.threadState`)).toBe("open");
      expect(db.query<{ kinds: string }, [string]>("SELECT group_concat(kind, ',') AS kinds FROM review_thread_entries WHERE thread_id = ? ORDER BY seq").get(createdId)!.kinds).toBe("message,message,resolved,reopened");

      await desktop.reload(`${base}/${workspace}/r/exact-review/v/1#${createdId}`);
      expect(await desktop.evaluate<{ hash: string; count: number }>(`({hash:location.hash,count:document.querySelectorAll(location.hash).length})`)).toEqual({ hash: `#${createdId}`, count: 1 });

      browserRefreshKey = await desktop.evaluate<string>(`document.querySelector('.conversation-refresh [name=idempotencyKey]').value`);
      const refreshHash = digestOf({ operation: "conversation_refresh", lineageId, observationId, actor: { kind: "installation", installationId: 7331 } });
      db.run("INSERT INTO review_conversation_refresh_idempotency VALUES (?, ?, ?, ?, ?, ?)", [workspace, browserRefreshKey, refreshHash, lineageId, browserRefreshImport, Date.now()]);
      const importCount = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ?").get(workspace, lineageId)!.n;
      await desktop.evaluate(`(()=>{const form=document.querySelector('.conversation-refresh');form.requestSubmit();form.requestSubmit();return true})()`);
      await Bun.sleep(750);
      await desktop.waitFor(`document.readyState==='complete'&&location.pathname===${JSON.stringify(`/${workspace}/r/exact-review/v/1`)}&&document.querySelector('.conversation-refresh')`);
      expect(await desktop.evaluate<boolean>(`document.body.textContent.includes('Discussion')&&!document.body.textContent.trim().startsWith('{')`)).toBe(true);
      expect(await desktop.evaluate<string>(`document.querySelector('.conversation-refresh [name=idempotencyKey]').value`)).not.toBe(browserRefreshKey);
      await desktop.activateAndWaitForLoad(".conversation-refresh button[type=submit]");
      expect(await desktop.evaluate<{ path: string; review: boolean; json: boolean }>(`({path:location.pathname,review:document.body.textContent.includes('Discussion'),json:document.body.textContent.trim().startsWith('{')})`)).toEqual({ path: `/${workspace}/r/exact-review/v/1`, review: true, json: false });
      expect(db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM review_conversation_imports WHERE workspace_id = ? AND lineage_id = ?").get(workspace, lineageId)!.n).toBe(importCount);

      await desktop.screenshot(`${evidenceDir}/member-1440-dark.png`);
      await mark(`member-1440-dark: create/reply/resolve/reopen persisted; refresh double-submit replay and fresh-key cooldown both returned to the review`);
    } finally {
      if (browserRefreshKey) db.run("DELETE FROM review_conversation_refresh_idempotency WHERE workspace_id = ? AND idempotency_key = ?", [workspace, browserRefreshKey]);
      if (browserRefreshImport) db.run("DELETE FROM review_conversation_imports WHERE workspace_id = ? AND id = ?", [workspace, browserRefreshImport]);
      db.run("UPDATE review_lineage_prs SET actor_kind = 'anonymous', installation_id = NULL, user_id = NULL, credential_id = NULL WHERE workspace_id = ? AND lineage_id = ?", [workspace, lineageId]);
      await desktop.close();
    }

    const phone = await launch("ranges-390-light", { width: 390, dark: false, touch: true, javascript: true });
    try {
      const focusUrl = `${base}/${workspace}/r/exact-review/v/1?review=exact`;
      const openDetails = async () => {
        await phone.click('.focus-mobile-bar [data-focus-toggle="detail"]');
        await phone.waitFor("new URL(location.href).searchParams.get('panel')==='detail'");
      };
      await phone.navigate(focusUrl);
      expect(await phone.evaluate<number>("innerWidth")).toBe(390);
      expect(await phone.evaluate<string[]>(`([...document.querySelector('.focus-mobile-bar').children].map(node=>node.textContent.trim()))`)).toEqual(["Review", "1 / 1", "Details"]);
      await openDetails();
      await phone.evaluate("history.back()");
      await phone.waitFor("!new URL(location.href).searchParams.has('panel') && document.querySelector('[data-focus-dialog]').open");
      await openDetails();
      await phone.key("Escape");
      await phone.waitFor("!new URL(location.href).searchParams.has('panel') && document.querySelector('[data-focus-dialog]').open");

      await phone.evaluate(`document.querySelectorAll('[data-line-select][data-line-side="new"]')[0].focus()`);
      await phone.key("Enter");
      await phone.evaluate(`document.querySelectorAll('[data-line-select][data-line-side="new"]')[2].focus()`);
      await phone.key("Enter", 8);
      await openDetails();
      expect(await phone.evaluate<string[]>(`[document.querySelector('.range-thread [name=startLine]').value,document.querySelector('.range-thread [name=endLine]').value]`)).toEqual(["1", "3"]);
      await phone.setValue(".range-thread textarea", "Keyboard range");
      await phone.activateAndWaitForLoad(".range-thread button[type=submit]");
      expect(anchorByBody("Keyboard range")).toEqual({ start_line: 1, end_line: 3 });

      await phone.navigate(focusUrl);
      await phone.drag('[data-line-select][data-line-side="new"]', 0, '[data-line-select][data-line-side="new"]', 2);
      await openDetails();
      expect(await phone.evaluate<string[]>(`[document.querySelector('.range-thread [name=startLine]').value,document.querySelector('.range-thread [name=endLine]').value]`)).toEqual(["1", "3"]);
      await phone.setValue(".range-thread textarea", "Mouse range");
      await phone.activateAndWaitForLoad(".range-thread button[type=submit]");
      expect(anchorByBody("Mouse range")).toEqual({ start_line: 1, end_line: 3 });

      await phone.navigate(focusUrl);
      await phone.touch('[data-line-select][data-line-side="new"]', 0);
      await phone.touch('[data-line-select][data-line-side="new"]', 2);
      await openDetails();
      await phone.waitFor("document.querySelector('.range-thread [name=endLine]').value==='3'");
      await phone.setValue(".range-thread textarea", "Touch range");
      await phone.activateAndWaitForLoad(".range-thread button[type=submit]");
      expect(anchorByBody("Touch range")).toEqual({ start_line: 1, end_line: 3 });

      await phone.navigate(focusUrl); await openDetails();
      await phone.setValue(".range-thread [name=side]", "new");
      await phone.setValue(".range-thread [name=startLine]", "4");
      await phone.setValue(".range-thread [name=endLine]", "4");
      await phone.setValue(".range-thread textarea", "Unchanged range");
      await phone.activateAndWaitForLoad(".range-thread button[type=submit]");
      expect(anchorByBody("Unchanged range")).toEqual({ start_line: 4, end_line: 4 });

      await phone.navigate(focusUrl); await openDetails();
      await phone.setValue(".range-thread [name=side]", "new");
      await phone.setValue(".range-thread [name=startLine]", "3");
      await phone.setValue(".range-thread [name=endLine]", "4");
      await phone.setValue(".range-thread textarea", "Corrected mixed range");
      await phone.evaluate(`document.querySelector('.range-thread button[type=submit]').click()`);
      await phone.waitFor("document.querySelectorAll('.range-thread [role=status] button').length===2");
      expect(await phone.evaluate<string[]>(`[...document.querySelectorAll('.range-thread [role=status] button')].map(button=>button.textContent)`)).toEqual(["Changed L3–3", "Unchanged L4–4"]);
      await phone.evaluate(`document.querySelectorAll('.range-thread [role=status] button')[0].click()`);
      expect(await phone.evaluate<string[]>(`[document.querySelector('.range-thread [name=startLine]').value,document.querySelector('.range-thread [name=endLine]').value]`)).toEqual(["3", "3"]);
      await phone.activateAndWaitForLoad(".range-thread button[type=submit]");
      expect(anchorByBody("Corrected mixed range")).toEqual({ start_line: 3, end_line: 3 });
      expect(await phone.evaluate<number>(`document.querySelectorAll('#'+location.hash.slice(1)).length`)).toBe(1);
      await phone.screenshot(`${evidenceDir}/ranges-390-light.png`);
      await mark("ranges-390-light: Back and Escape closed Details first; keyboard, mouse, touch, unchanged and mixed-corrected ranges persisted");
    } finally {
      await phone.close();
    }

    const nojs = await launch("member-1680-dark-nojs", { width: 1680, dark: true, javascript: false });
    try {
      await nojs.navigate(`${base}/${workspace}/r/exact-review/v/1?review=exact`);
      expect(await nojs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
      await nojs.setValue(".range-thread [name=side]", "new");
      await nojs.setValue(".range-thread [name=startLine]", "4");
      await nojs.setValue(".range-thread [name=endLine]", "4");
      await nojs.setValue(".range-thread textarea", "No JavaScript range");
      await nojs.activateAndWaitForLoad(".range-thread button[type=submit]");
      const nojsId = await nojs.evaluate<string>("location.hash.slice(1)");
      expect(threadByBody("No JavaScript range")).toBe(nojsId);
      await nojs.setValue(`#${nojsId} .thread-reply textarea`, "No JavaScript Chrome reply");
      await nojs.activateAndWaitForLoad(`#${nojsId} .thread-reply button[type=submit]`);
      await nojs.activateAndWaitForLoad(`#${nojsId} .thread-resolution button[type=submit]`);
      await nojs.waitFor(`document.querySelector('#${nojsId}')?.dataset.threadState==='resolved'`);
      expect(await nojs.evaluate<string>(`document.querySelector('#${nojsId}').dataset.threadState`)).toBe("resolved");
      await nojs.activateAndWaitForLoad(`#${nojsId} .thread-resolution button[type=submit]`);
      await nojs.waitFor(`document.querySelector('#${nojsId}')?.dataset.threadState==='open'`);
      expect(await nojs.evaluate<string>(`document.querySelector('#${nojsId}').dataset.threadState`)).toBe("open");
      expect(db.query<{ kinds: string }, [string]>("SELECT group_concat(kind, ',') AS kinds FROM review_thread_entries WHERE thread_id = ? ORDER BY seq").get(nojsId)!.kinds).toBe("message,message,resolved,reopened");
      await nojs.screenshot(`${evidenceDir}/member-1680-dark-nojs.png`);
      await mark(`member-1680-dark-nojs: native range/create/reply/resolve/reopen followed 303s to #${nojsId}`);
    } finally {
      await nojs.close();
    }

    const light = await launch("stack-1440-light", { width: 1440, dark: false, javascript: true });
    try {
      await light.navigate(`${base}/s/${stack.token}?review=whole&layer=exact-review&page=1`);
      expect(await light.evaluate<{ width: number; theme: string; forms: number }>(`({width:innerWidth,theme:document.documentElement.dataset.theme,forms:document.querySelectorAll('.thread-new,.thread-reply,.thread-resolution').length})`)).toEqual({ width: 1440, theme: "light", forms: 0 });
      await light.screenshot(`${evidenceDir}/stack-1440-light.png`);
      await mark(`stack-1440-light: exact read-only stack capability rendered from live origin; review capability ${review.id} also minted`);
    } finally {
      await light.close();
    }

    await Bun.write(`${evidenceDir}/evidence.txt`, `${log.join("\n")}\n`);
    expect(log.filter((line) => line.includes("Chrome PID"))).toHaveLength(4);
    for (const shot of ["member-1440-dark.png", "ranges-390-light.png", "member-1680-dark-nojs.png", "stack-1440-light.png"]) expect(Bun.file(`${evidenceDir}/${shot}`).size).toBeGreaterThan(3_000);
  }, 120_000);

  test("passes the auth-enabled holder and privacy matrix with GitHub sealed", async () => {
    const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/capability-privacy.script.ts`], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DATA_DIR: config.dataDir,
        PORT: "0",
        CAP_WORKSPACE: workspace,
        CAP_OWNER: owner,
        CAP_STRANGER: stranger,
        CAP_KEY: key,
        CAP_REVISION: revisionId,
        CAP_ACCOUNT: accountId,
        CAP_MANIFEST: manifestId,
        CAP_STACK_ACCOUNT: stackAccountId,
        CAP_FILE: fileId,
        CAP_LATER_FILE: laterFileId,
        CAP_ATTACHMENT: attachmentId,
      },
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await Bun.write("/home/kristofferremback/.cache/pi/seer-task9/capability-auth-enabled-matrix.txt", `${stdout}${stderr}`);
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("capability privacy: all assertions passed");
  });
});
