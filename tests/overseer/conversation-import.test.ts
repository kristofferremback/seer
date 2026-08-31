import { beforeAll, describe, expect, test } from "bun:test";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { tinyId } from "../../src/ids";
import { migrate } from "../../src/migrate";
import { applyConversationSnapshot, latestThreadObservation, recordGithubCommentWebhook, recordGithubThreadWebhook, runConversationImport, startConversationImport } from "../../src/overseer/conversation-import";
import { listImportedThreads } from "../../src/overseer/conversation-read";
import type { GithubConversationSnapshot, GithubReviewThread } from "../../src/overseer/github-graphql";
import type { ReviewLineageRow } from "../../src/overseer/revision-db";
import type { ReviewPrObservationRow } from "../../src/overseer/revision-pr";
import { setReadRouter } from "../../src/overseer/github-app";
import { offlineReadRouter } from "../offline-github";

let workspace = "";
let lineage: ReviewLineageRow;
let observation: ReviewPrObservationRow;

const comment = (id: string, body: string) => ({ databaseId: id, nodeId: `COMMENT_${id}`, authorLogin: "octocat", body, url: `https://github.test/c/${id}`, createdAt: 1000, updatedAt: 1000, commitSha: "a".repeat(40), originalCommitSha: "a".repeat(40) });
const thread = (id: string, body = `body ${id}`): GithubReviewThread => ({ nodeId: `THREAD_${id}`, resolved: false, outdated: false, path: "src/a.ts", side: "new", startLine: 1, endLine: 1, originalStartLine: 1, originalEndLine: 1, commitSha: "a".repeat(40), originalCommitSha: "a".repeat(40), url: `https://github.test/t/${id}`, comments: [comment(id, body)] });
const review = (id: string, commitSha = "a".repeat(40)) => ({ databaseId: id, nodeId: `REVIEW_${id}`, authorLogin: "reviewer", state: "approved" as const, body: `review ${id}`, url: `https://github.test/r/${id}`, commitSha, submittedAt: 1000, dismissed: false });
const snapshot = (threads: GithubReviewThread[], complete = true, truncated = false, reviews: ReturnType<typeof review>[] = []): GithubConversationSnapshot => ({ threads, reviews, complete, truncated, logicalBodyBytes: [...threads.flatMap((item) => item.comments.map((entry) => entry.body)), ...reviews.map((item) => item.body)].reduce((sum, body) => sum + Buffer.byteLength(body), 0) });

beforeAll(() => {
  migrate();
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Conversation import", owner);
  lineage = { id: tinyId("rln"), workspace_id: workspace, slug: "imported", repo: "Acme/Imported", repo_id: 811, branch: "feature", original_base_ref: "main", original_base_sha: "1".repeat(40), title: "Imported", latest_revision: null, latest_account_version: null, created_by_user_id: owner, created_by_key_id: tinyId("key"), created_at: 1, updated_at: 1 };
  db.run("INSERT INTO review_lineages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, 1)", [lineage.id, workspace, lineage.slug, lineage.repo, lineage.repo_id, lineage.branch, lineage.original_base_ref, lineage.original_base_sha, lineage.title, owner, lineage.created_by_key_id]);
  observation = { seq: 1, id: tinyId("pob"), workspace_id: workspace, lineage_id: lineage.id, repo_id: 811, repo: "Acme/Imported", pr_number: 9, title: "Imported", state: "open", merged: 0, draft: 0, base_ref: "main", base_sha: "1".repeat(40), head_ref: "feature", head_sha: "a".repeat(40), merge_base_sha: "1".repeat(40), github_updated_at: 1, observed_at: 1, digest: "digest", actor_kind: "installation", installation_id: 77, user_id: null, credential_id: null };
});

function apply(value: GithubConversationSnapshot, now = Date.now()) {
  const row = startConversationImport({ workspaceId: workspace, lineageId: lineage.id, observationId: observation.id, actor: { kind: "installation", installationId: 77 }, now });
  applyConversationSnapshot({ importRow: row, lineage, observation, snapshot: value });
  return row;
}

describe("immutable conversation import", () => {
  test("should append edits, dedupe repeats and make deletion terminal", async () => {
    apply(snapshot([thread("1", "first")]));
    apply(snapshot([thread("1", "first")]));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_github_comment_observations").get()!.n).toBe(1);
    apply(snapshot([thread("1", "edited")]));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_github_comment_observations").get()!.n).toBe(2);
    apply(snapshot([]));
    const projected = await listImportedThreads(workspace, lineage);
    expect(projected[0]!.deleted).toBe(true);
    expect(projected[0]!.comments[0]!.body).toBeNull();
    expect(projected[0]!.comments[0]!.deleted).toBe(true);
  });

  test("should never tombstone absent identities from a truncated snapshot", async () => {
    apply(snapshot([thread("2"), thread("3")]));
    apply(snapshot([thread("2")], false, true));
    const projected = await listImportedThreads(workspace, lineage);
    expect(projected.find((item) => item.id === db.query<{ id: string }, []>("SELECT id FROM review_github_threads WHERE github_node_id = 'THREAD_3'").get()!.id)?.deleted).toBe(false);
  });

  test("should heal a webhook identity and keep a newer resolution over a slow import", () => {
    const sourceAt = Date.now();
    const localId = recordGithubThreadWebhook({ workspaceId: workspace, lineageId: lineage.id, repoId: 811, prNumber: 9, sourceId: "comment-webhook", sourceAt, nodeId: null, firstCommentDatabaseId: "44", resolved: false, path: "src/a.ts", side: "new", startLine: 1, endLine: 1 });
    recordGithubCommentWebhook({ workspaceId: workspace, threadId: localId, sourceId: "comment-webhook", sourceAt, databaseId: "44", nodeId: "COMMENT_44", createdAt: sourceAt, updatedAt: sourceAt, authorLogin: "reviewer", body: "webhook", githubUrl: "https://github.test/c/44", deleted: false });
    const started = startConversationImport({ workspaceId: workspace, lineageId: lineage.id, observationId: observation.id, actor: { kind: "installation", installationId: 77 }, now: sourceAt + 1 });
    const value = thread("44", "graphql"); value.nodeId = "THREAD_44";
    recordGithubThreadWebhook({ workspaceId: workspace, lineageId: lineage.id, repoId: 811, prNumber: 9, sourceId: "resolved-webhook", sourceAt: sourceAt + 2, nodeId: "THREAD_44", firstCommentDatabaseId: "44", resolved: true });
    applyConversationSnapshot({ importRow: started, lineage, observation, snapshot: snapshot([value]) });
    const healed = db.query<{ id: string; github_node_id: string }, []>("SELECT id, github_node_id FROM review_github_threads WHERE first_comment_database_id = '44'").get()!;
    expect(healed).toEqual({ id: localId, github_node_id: "THREAD_44" });
    expect(latestThreadObservation(workspace, localId)?.resolved).toBe(1);
  });

  test("should not tombstone an identity observed by a newer webhook", async () => {
    const sourceAt = Date.now();
    const threadId = recordGithubThreadWebhook({ workspaceId: workspace, lineageId: lineage.id, repoId: 811, prNumber: 9, sourceId: "before-import", sourceAt, nodeId: null, firstCommentDatabaseId: "55", resolved: false });
    recordGithubCommentWebhook({ workspaceId: workspace, threadId, sourceId: "before-import", sourceAt, databaseId: "55", nodeId: "COMMENT_55", createdAt: sourceAt, updatedAt: sourceAt, authorLogin: "reviewer", body: "before", githubUrl: null, deleted: false });
    const started = startConversationImport({ workspaceId: workspace, lineageId: lineage.id, observationId: observation.id, actor: { kind: "installation", installationId: 77 }, now: sourceAt + 1 });
    recordGithubCommentWebhook({ workspaceId: workspace, threadId, sourceId: "after-import", sourceAt: sourceAt + 2, databaseId: "55", nodeId: "COMMENT_55", createdAt: sourceAt, updatedAt: sourceAt + 2, authorLogin: "reviewer", body: "newer webhook", githubUrl: null, deleted: false });
    applyConversationSnapshot({ importRow: started, lineage, observation, snapshot: snapshot([]) });
    const projected = (await listImportedThreads(workspace, lineage)).find((item) => item.id === threadId)!;
    expect(projected.deleted).toBe(false);
    expect(projected.comments[0]!.body).toBe("newer webhook");
  });

  test("should scope comments through their thread and reviews through their lineage after reattach", () => {
    const value = snapshot([thread("reattach")], true, false, [review("reattach")]);
    apply(value);
    const secondLineage = { ...lineage, id: tinyId("rln"), slug: "imported-reattached" };
    db.run("INSERT INTO review_lineages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, 1)", [secondLineage.id, workspace, secondLineage.slug, secondLineage.repo, secondLineage.repo_id, secondLineage.branch, secondLineage.original_base_ref, secondLineage.original_base_sha, secondLineage.title, secondLineage.created_by_user_id, secondLineage.created_by_key_id]);
    const secondObservation = { ...observation, id: tinyId("pob"), lineage_id: secondLineage.id };
    const started = startConversationImport({ workspaceId: workspace, lineageId: secondLineage.id, observationId: secondObservation.id, actor: { kind: "installation", installationId: 77 } });
    applyConversationSnapshot({ importRow: started, lineage: secondLineage, observation: secondObservation, snapshot: value });
    const comments = db.query<{ lineage_id: string }, []>("SELECT t.lineage_id FROM review_github_comments c JOIN review_github_threads t ON t.id = c.thread_id WHERE c.github_node_id = 'COMMENT_reattach' ORDER BY t.lineage_id").all();
    expect(comments.map((row) => row.lineage_id).sort()).toEqual([lineage.id, secondLineage.id].sort());
    expect(db.query<{ lineage_id: string }, []>("SELECT lineage_id FROM review_github_reviews WHERE github_node_id = 'REVIEW_reattach' ORDER BY lineage_id").all().map((row) => row.lineage_id).sort()).toEqual([lineage.id, secondLineage.id].sort());
  });

  test("should execute with the exact actor recorded on the authorized import row", async () => {
    const opened: unknown[] = [];
    setReadRouter({
      async resolve() { throw new Error("import execution must not resolve another actor"); },
      async open() { throw new Error("import execution must not open REST"); },
      async openGraphql(_workspaceId, actor) {
        opened.push(actor);
        return { async listReviewThreads() { return snapshot([]); } };
      },
    });
    try {
      const divergent = { ...observation, id: tinyId("pob"), actor_kind: "user" as const, installation_id: null, user_id: tinyId("usr"), credential_id: tinyId("ghc") };
      const started = startConversationImport({ workspaceId: workspace, lineageId: lineage.id, observationId: divergent.id, actor: { kind: "installation", installationId: 7007 } });
      const completed = await runConversationImport(workspace, lineage, divergent, started);
      expect(completed.state).toBe("completed");
      expect(opened).toEqual([{ kind: "installation", installationId: 7007 }]);
      expect(completed).toMatchObject({ actor_kind: "installation", installation_id: 7007, user_id: null, credential_id: null });
    } finally {
      setReadRouter(offlineReadRouter());
    }
  });

  test("should store GitHub node and database identities as text", () => {
    const columns = db.query<{ name: string; type: string }, []>("PRAGMA table_info(review_github_comments)").all();
    expect(columns.find((column) => column.name === "github_database_id")?.type).toBe("TEXT");
    expect(columns.find((column) => column.name === "github_node_id")?.type).toBe("TEXT");
  });
});
