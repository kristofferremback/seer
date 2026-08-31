import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { hashKey, newShareToken, tinyId } from "../../src/ids";
import { saveAttachment, saveStageBlob } from "../../src/store";
import {
  capabilityAssetPath,
  createDocumentCapability,
  documentProjectionForShare,
  resolveCapabilityTargetForMint,
  resolveDocumentCapability,
} from "../../src/overseer/capability-db";
import { getShare, SHARE_KINDS, SERVED_SHARE_KINDS } from "../../src/shares";

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
let key = "";
let lineageId = "";
let stackId = "";
let revisionId = "";
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
  const oldText = `export const value = ${input.value - 1};\n`;
  const newText = `export const value = ${input.value};\n`;
  const oldBlob = digest(oldText);
  const newBlob = digest(newText);
  await saveStageBlob(workspace, oldBlob, new TextEncoder().encode(oldText));
  await saveStageBlob(workspace, newBlob, new TextEncoder().encode(newText));
  db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, oldBlob, oldText.length, Date.now()]);
  db.run("INSERT OR IGNORE INTO stage_blobs VALUES (?, ?, ?, ?)", [workspace, newBlob, newText.length, Date.now()]);
  db.run(
    "INSERT INTO stage_captures VALUES (?, ?, ?, 'Acme/Capability', 990, 'feature/share', 'main', ?, ?, ?, NULL, 'completed', ?)",
    [captureId, workspace, input.slug, sha(2 + input.revision), sha(1), sha(1), Date.now()],
  );
  db.run(
    "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/value.ts', NULL, 'modified', ?, ?, '100644', '100644', 'blob', 'blob', 1, 1, 'retained', 'retained', ?, ?, NULL, NULL)",
    [file, workspace, captureId, sha(10), sha(11 + input.revision), oldBlob, newBlob],
  );
  const oldLine = oldText.trimEnd();
  const newLine = newText.trimEnd();
  const change = `chg_${digest(stable({ path: "src/value.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, old: [oldLine], newer: [newLine], context: [] }))}`;
  db.run(
    "INSERT INTO stage_capture_changes VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?, 'reconstructed')",
    [change, workspace, captureId, file, digest(JSON.stringify([oldLine])), digest(JSON.stringify([newLine])), digest("[]")],
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
  db.run("INSERT INTO users VALUES (?, 'capability-stranger@example.com', ?)", [stranger, Date.now()]);
  workspace = createWorkspace("Capability", owner);
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
    }
    const replayOne = createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "replay", userId: owner, expiresAt: null });
    const replayTwo = createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "replay", userId: owner, expiresAt: null });
    expect(replayOne.id).not.toBe(replayTwo.id);
    expect(replayOne.token).not.toBe(replayTwo.token);
    expect([...SHARE_KINDS]).toEqual([...SERVED_SHARE_KINDS]);
  });

  test("soft-misses relational corruption at the shared mint and read boundary", async () => {
    const review = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "relationship review", userId: owner, expiresAt: null });
    const stack = createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "relationship stack", userId: owner, expiresAt: null });
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
    const revision = createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "revision", userId: owner, expiresAt: null });
    const account = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "account", userId: owner, expiresAt: null });
    const revisionPage = await fetch(`${base}/s/${revision.token}`);
    expect(revisionPage.status).toBe(200);
    expect(revisionPage.headers.get("cache-control")).toBe("no-store");
    const revisionHtml = visible(await revisionPage.text());
    expect(revisionHtml).toContain("Revision 1");
    expect(revisionHtml).not.toContain("Witness account 1");
    expect(revisionHtml).not.toContain("secret-project");
    expect(revisionHtml).toContain("Pinned PR title");
    expect(revisionHtml).toContain("https://github.com/Acme/Capability/pull/42");
    expect(revisionHtml).not.toContain("Newer private title");
    expect(revisionHtml).not.toContain("Acme/Renamed");
    expect(revisionHtml).not.toContain("Revision 2 available");
    expect(revisionHtml).not.toContain(owner);
    expect(revisionHtml).not.toContain("read-form");
    expect(revisionHtml).not.toContain("unread");
    expect(revisionHtml).not.toContain(`/${workspace}/`);

    const accountHtml = visible(await (await fetch(`${base}/s/${account.token}`)).text());
    expect(accountHtml).toContain("Witness account 1");
    expect(accountHtml).not.toContain("Witness account 2");
    expect(accountHtml).toContain("private-bundle v7");
    expect(accountHtml).not.toContain(`/${workspace}/b/private-bundle`);

    const lines = await fetch(`${base}/s/${revision.token}/files/${fileId}?side=new&start=1&end=1`);
    expect(lines.status).toBe(200);
    expect((await lines.json() as any).lines).toEqual([{ number: 1, text: "export const value = 1;" }]);
    expect((await fetch(`${base}/s/${revision.token}/files/${fileId}?side=new&start=1&end=401`)).status).toBe(422);
    const tooLarge = await fetch(`${base}/s/${revision.token}/files/${largeFileId}?side=new&start=1&end=1`);
    expect(tooLarge.status).toBe(422);
    expect((await tooLarge.json() as any).error).toContain("response budget");

    const accountFocus = await (await fetch(`${base}/s/${account.token}?review=exact`)).text();
    expect(accountFocus).toContain(`<a class="context-trigger" href="/s/${account.token}/files/${fileId}?side=new&amp;start=1&amp;end=161"`);
    const noJsContext = await fetch(`${base}/s/${account.token}/files/${fileId}?side=new&start=1&end=161`, { headers: { accept: "text/html" } });
    expect(noJsContext.status).toBe(200);
    expect((await noJsContext.json() as any).lines).toEqual([{ number: 1, text: "export const value = 1;" }]);
    const memberFocus = await (await fetch(`${base}/${workspace}/r/exact-review/v/1?review=exact`)).text();
    expect(memberFocus).toContain("<button class=\"context-trigger\" type=\"button\" data-context-trigger");

    const stack = createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "stack account", userId: owner, expiresAt: null });
    const stackRoot = await fetch(`${base}/s/${stack.token}`);
    expect(stackRoot.status).toBe(200);
    expect(visible(await stackRoot.text())).toContain("One exact member.");
    const stackGroup = await fetch(`${base}/s/${stack.token}?review=whole&page=1`);
    expect(stackGroup.status).toBe(200);
    const stackHtml = visible(await stackGroup.text());
    expect(stackHtml).toContain("The exact member group.");
    expect(stackHtml).not.toContain("read-form");
    expect(stackHtml).toContain(`href="/s/${stack.token}?layer=exact-review"`);
    const stackUrls = attributeUrls(stackHtml);
    expect(stackUrls.filter((value) => value.includes(`/${workspace}/`))).toEqual([]);
    expect(stackUrls.filter((value) => value.startsWith("/")).every((value) => value.startsWith(`/s/${stack.token}`))).toBe(true);

    const memberReview = await (await fetch(`${base}/${workspace}/r/exact-review/v/1`)).text();
    expect(memberReview).toContain(`data-kind="review_document" data-target="${accountId}"`);
    const memberStack = await (await fetch(`${base}/${workspace}/r-stacks/exact-stack/v/1/account`)).text();
    expect(memberStack).toContain(`data-kind="stack_document" data-target="${stackAccountId}"`);
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
    const capability = createDocumentCapability({ wsId: workspace, kind: "stack_document", target: historicalManifest, label: "historical positions", userId: owner, expiresAt: null });
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

    const retained = await fetch(`${base}/s/${capability.token}/m/${position}/files/${fileId}?side=new&start=1&end=1`);
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
    const review = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "review", userId: owner, expiresAt: null });
    const stack = createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "stack", userId: owner, expiresAt: null });
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

    const narrowed = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "corrupt item", userId: owner, expiresAt: null });
    db.run("DELETE FROM share_capability_items WHERE share_id = ? AND ordinal = 1", [narrowed.id]);
    expect(await (await fetch(`${base}/s/${narrowed.token}`)).text()).toBe(expected);
    const mismatched = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "corrupt scope", userId: owner, expiresAt: null });
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
    expect(conversation.status).toBe(422);
    expect((await conversation.json() as any).errors[0]).toMatchObject({ field: "conversation", rule: "field_unknown" });

    const minted = await (await post({ workspace, kind: "review_document", target: revisionId, label: "listed" })).json() as any;
    const listing = await (await fetch(`${base}/api/shares?workspace=${workspace}`)).text();
    expect(listing).not.toContain(minted.token);
    const row = (JSON.parse(listing) as any).shares.find((share: any) => share.id === minted.id);
    expect(row.document).toEqual(minted.document);
  });

  test("projects listing and redirect metadata from only the exact target row", () => {
    const capability = createDocumentCapability({ wsId: workspace, kind: "review_document", target: revisionId, label: "projected row", userId: owner, expiresAt: null });
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

  test("renders phone and desktop capability pages in Chrome, including dark and no-JavaScript", async () => {
    const evidenceDir = "/home/kristofferremback/.cache/pi/seer-task8/browser";
    rmSync(evidenceDir, { recursive: true, force: true });
    mkdirSync(evidenceDir, { recursive: true });
    const review = createDocumentCapability({ wsId: workspace, kind: "review_document", target: accountId, label: "browser review", userId: owner, expiresAt: null });
    const stack = createDocumentCapability({ wsId: workspace, kind: "stack_document", target: stackAccountId, label: "browser stack", userId: owner, expiresAt: null });
    const runs = [
      { name: "review-390-light", width: 390, path: `/s/${review.token}?review=exact`, flags: ["--touch-events=enabled"] },
      { name: "review-390-dark", width: 390, path: `/s/${review.token}?review=exact`, flags: ["--touch-events=enabled", "--force-dark-mode"] },
      { name: "review-1440-light", width: 1440, path: `/s/${review.token}`, flags: [] },
      { name: "review-1440-dark", width: 1440, path: `/s/${review.token}`, flags: ["--force-dark-mode"] },
      { name: "stack-1680-light", width: 1680, path: `/s/${stack.token}?review=whole&layer=exact-review&page=1`, flags: [] },
      { name: "stack-1680-dark-nojs", width: 1680, path: `/s/${stack.token}?review=whole&page=1`, flags: ["--force-dark-mode"], noJs: true },
    ];
    const log: string[] = [];
    for (const run of runs) {
      const screenshot = `${evidenceDir}/${run.name}.png`;
      const htmlPath = `${evidenceDir}/${run.name}.html`;
      const rendered = await fetch(`${base}${run.path}`);
      expect(rendered.status).toBe(200);
      const renderedHtml = await rendered.text();
      await Bun.write(htmlPath, "noJs" in run && run.noJs
        ? renderedHtml.replace("<html lang=", "<html data-theme=\"dark\" lang=")
        : renderedHtml);
      let code = -1;
      let size = 0;
      let attempt = 0;
      for (; attempt < 3 && size <= 3_000; attempt++) {
        const profile = `${evidenceDir}/${run.name}-profile-${attempt}`;
        if ("noJs" in run && run.noJs) {
          mkdirSync(`${profile}/Default`, { recursive: true });
          await Bun.write(`${profile}/Default/Preferences`, JSON.stringify({ profile: { default_content_setting_values: { javascript: 2 } } }));
        }
        const proc = Bun.spawn([
          "/usr/bin/google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
          `--user-data-dir=${profile}`, `--window-size=${run.width},1000`, `--screenshot=${screenshot}`,
          "--virtual-time-budget=1500", ...run.flags, `file://${htmlPath}${run.path.includes("?") ? `?${run.path.split("?")[1]}` : ""}`,
        ], { stdout: "ignore", stderr: "ignore" });
        code = await proc.exited;
        size = Bun.file(screenshot).size;
        rmSync(profile, { recursive: true, force: true });
      }
      log.push(`${run.name}: exit ${code}, ${size} bytes, ${attempt} attempt${attempt === 1 ? "" : "s"}`);
      expect(code).toBe(0);
      expect(size).toBeGreaterThan(3_000);
    }
    await Bun.write(`${evidenceDir}/evidence.txt`, `${log.join("\n")}\n`);
  }, 90_000);

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
    await Bun.write("/home/kristofferremback/.cache/pi/seer-task8/auth-enabled-matrix.txt", `${stdout}${stderr}`);
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain("capability privacy: all assertions passed");
  });
});
