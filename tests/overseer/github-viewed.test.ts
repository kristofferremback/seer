import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { generateKey, setKeyring } from "../../src/envelope";
import { migrate } from "../../src/migrate";
import { tinyId } from "../../src/ids";
import { createGithubUserCredential } from "../../src/overseer/user-credentials";
import {
  setPersonalGithubGraphqlClientFactory,
  GithubGraphqlPermissionError,
  GithubGraphqlTransportError,
  type PersonalGithubGraphqlClient,
} from "../../src/overseer/github-graphql";
import {
  fileHandlingState,
  getGithubProjectionPreference,
  getGithubViewedJob,
  queueOwnedMarksForRemoval,
  queueCurrentViewedJobs,
  runNextGithubViewedJob,
  setGithubProjectionPreference,
} from "../../src/overseer/github-viewed";
import { getLineage, getRevision, setRevisionChangeRead } from "../../src/overseer/revision-db";
import { requiredAcknowledgements } from "../../src/overseer/revision-delta";
import { getStageCaptureForWorkspaces } from "../../src/stage/db";
import { setRevisionAcknowledgement } from "../../src/overseer/acknowledgements-db";
import { writeRevisionReadHandling } from "../../src/overseer/review-handling";
import { completeCaptureJob } from "../../src/overseer/revision-jobs";
import { githubProjectionForReader } from "../../src/overseer/github-projection-read";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = (value: string) => value.repeat(40).slice(0, 40);
let sequence = 0;
const clients = new Map<string, PersonalGithubGraphqlClient>();
const actors: { userId: string; credentialId: string }[] = [];

beforeAll(() => {
  setKeyring({ activeId: "viewed", keys: new Map([["viewed", Buffer.from(generateKey(), "base64")]]) });
  migrate();
  setPersonalGithubGraphqlClientFactory((userId, credentialId) => {
    actors.push({ userId, credentialId });
    const client = clients.get(credentialId);
    if (!client) throw new Error(`No fake personal client for ${credentialId}`);
    return client;
  });
});

interface Fixture {
  workspaceId: string;
  userId: string;
  credentialId: string;
  lineageId: string;
  revisionId: string;
  captureId: string;
  fileId: string;
  changeId: string;
  materialId: string;
  captureMaterialId: string;
  observationId: string;
  slug: string;
  path: string;
  head: string;
  base: string;
}

function fixture(): Fixture {
  sequence += 1;
  const workspaceId = tinyId("ws");
  const userId = tinyId("usr");
  const credentialId = createGithubUserCredential({ userId, kind: "pat", label: `work-${sequence}`, secret: `token-${sequence}`, accountLogin: `octocat-${sequence}`, accountId: sequence, scopes: [], expiresAt: Date.now() + 60_000 });
  const lineageId = tinyId("rln");
  const revisionId = tinyId("rvr");
  const captureId = tinyId("stg");
  const fileId = tinyId("stf");
  const materialId = tinyId("sti");
  const captureMaterialId = tinyId("sti");
  const changeId = `chg_${sequence.toString(16).padStart(64, "0")}`;
  const slug = `viewed-${sequence}`;
  const path = "src/value.ts";
  const head = sequence.toString(16).padStart(40, "a").slice(-40);
  const base = sha("b");
  db.run("INSERT INTO workspaces VALUES (?,?,'private',?)", [workspaceId, `Viewed ${sequence}`, Date.now()]);
  db.run("INSERT INTO users VALUES (?,?,?)", [userId, `viewed-${sequence}@example.com`, Date.now()]);
  db.run("INSERT INTO memberships VALUES (?,?,?)", [workspaceId, userId, Date.now()]);
  db.run("INSERT INTO review_lineages VALUES (?,?,?,'Acme/Viewed',77,'feature','main',?,'Viewed projection',1,NULL,?,?,?,?)", [lineageId, workspaceId, slug, base, userId, tinyId("key"), Date.now(), Date.now()]);
  db.run("INSERT INTO stage_captures VALUES (?,?,?,'Acme/Viewed',77,'feature','main',?,?,?,NULL,'completed',?)", [captureId, workspaceId, slug, head, base, base, Date.now()]);
  db.run("INSERT INTO stage_capture_files VALUES (?,?,?, ?,NULL,'modified',?,?, '100644','100644','blob','blob',1,1,'retained','retained',NULL,NULL,NULL,NULL)", [fileId, workspaceId, captureId, path, sha("c"), sha("d")]);
  db.run("INSERT INTO stage_capture_changes VALUES (?,?,?,?,1,1,1,1,?,?,?,'patch')", [changeId, workspaceId, captureId, fileId, "e".repeat(64), "f".repeat(64), "1".repeat(64)]);
  db.run("INSERT INTO stage_capture_incomplete VALUES (?,?,?,'lines_unavailable',?,'new','Binary bytes are retained.')", [materialId, workspaceId, captureId, path]);
  db.run("INSERT INTO stage_capture_incomplete VALUES (?,?,?,'metadata_incomplete',NULL,'snapshot','GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist.')", [captureMaterialId, workspaceId, captureId]);
  const doc = { identity: { lineageId, slug, revision: 1, title: "Viewed projection", createdAt: new Date().toISOString() }, source: { captureId, repo: "Acme/Viewed", repoId: 77, branch: "feature", originalBaseRef: "main", originalBaseSha: base, baseRef: "main", sourceHeadSha: head, baseTipSha: base, mergeBaseSha: base }, builder: null, projects: [] };
  db.run("INSERT INTO review_revisions VALUES (?,?,?,?,1,?,1,?,?,?)", [revisionId, workspaceId, lineageId, slug, captureId, JSON.stringify(doc), `digest-${sequence}`, Date.now()]);
  db.run("INSERT INTO review_lineage_prs VALUES (?,?,?,77,'Acme/Viewed',23,'feature','main','user',NULL,?,?,?,NULL)", [lineageId, workspaceId, slug, userId, credentialId, Date.now()]);
  const observationId = tinyId("pob");
  const observedAt = Date.now();
  db.run("INSERT INTO review_pr_observations VALUES (?,?,?,77,'Acme/Viewed',23,'Viewed projection','open',0,0,'main',?,'feature',?,?,?,?,'user',NULL,?,? ,?)", [observationId, workspaceId, lineageId, base, head, base, observedAt, observedAt, userId, credentialId, `observation-${sequence}`]);
  db.run("INSERT INTO review_revision_sources VALUES (?,?,?,?,?,?,?,?)", [revisionId, workspaceId, lineageId, observationId, base, head, base, observedAt]);
  return { workspaceId, userId, credentialId, lineageId, revisionId, captureId, fileId, changeId, materialId, captureMaterialId, observationId, slug, path, head, base };
}

function fakeClient(input: {
  head: () => string;
  state: () => "VIEWED" | "UNVIEWED" | "DISMISSED";
  mark?: () => void | Promise<void>;
  unmark?: () => void | Promise<void>;
  onMutation?: (kind: "mark" | "unmark") => void;
}): PersonalGithubGraphqlClient {
  return {
    async pullRequest() { return { id: "PR_23", headRefOid: input.head(), files: [{ path: "src/value.ts", viewerViewedState: input.state() }], filesTruncated: false, rate: { limit: 5000, cost: 1, remaining: 4999, resetAt: Date.now() + 60_000, used: 1 } }; },
    async markFileAsViewed() { input.onMutation?.("mark"); await input.mark?.(); },
    async unmarkFileAsViewed() { input.onMutation?.("unmark"); await input.unmark?.(); },
    async addReview() { throw new Error("not used"); },
    async addThreadReply() { throw new Error("not used"); },
    async resolveThread() { throw new Error("not used"); },
    async unresolveThread() { throw new Error("not used"); },
    async findReviewThreadByComment() { return null; },
    async recoverReview() { return { kind: "none" }; },
  };
}

function handle(f: Fixture): void {
  const inventory = getStageCaptureForWorkspaces(f.captureId, [f.workspaceId])!;
  setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, true);
  const item = requiredAcknowledgements(inventory).find((candidate) => candidate.id === f.materialId)!;
  setRevisionAcknowledgement({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, item, acknowledged: true });
}

function queued(f: Fixture) {
  return db.query<{ id: string }, [string, string, string]>("SELECT id FROM review_github_viewed_jobs WHERE lineage_id=? AND user_id=? AND path=?").get(f.lineageId, f.userId, f.path);
}

function preparePush(f: Fixture, ordinal = 2) {
  const captureId = tinyId("stg"), fileId = tinyId("stf"), materialId = tinyId("sti"), captureMaterialId = tinyId("sti");
  const head = `${sequence + ordinal}`.padStart(40, "9").slice(-40);
  const observedAt = Date.now() + ordinal * 1_000;
  db.run("INSERT INTO stage_captures VALUES (?,?,?,'Acme/Viewed',77,'feature','main',?,?,?,NULL,'completed',?)", [captureId, f.workspaceId, f.slug, head, f.base, f.base, observedAt]);
  db.run("INSERT INTO stage_capture_files VALUES (?,?,?, ?,NULL,'modified',?,?, '100644','100644','blob','blob',1,1,'retained','retained',NULL,NULL,NULL,NULL)", [fileId, f.workspaceId, captureId, f.path, sha("c"), sha("d")]);
  db.run("INSERT INTO stage_capture_changes VALUES (?,?,?,?,1,1,1,1,?,?,?,'patch')", [f.changeId, f.workspaceId, captureId, fileId, "e".repeat(64), "f".repeat(64), "1".repeat(64)]);
  db.run("INSERT INTO stage_capture_incomplete VALUES (?,?,?,'lines_unavailable',?,'new','Binary bytes are retained.')", [materialId, f.workspaceId, captureId, f.path]);
  db.run("INSERT INTO stage_capture_incomplete VALUES (?,?,?,'metadata_incomplete',NULL,'snapshot','GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist.')", [captureMaterialId, f.workspaceId, captureId]);
  const observationId = tinyId("pob");
  db.run("INSERT INTO review_pr_observations VALUES (?,?,?,77,'Acme/Viewed',23,'Viewed projection','open',0,0,'main',?,'feature',?,?,?,?,'user',NULL,?,?,?)", [observationId, f.workspaceId, f.lineageId, f.base, head, f.base, observedAt, observedAt, f.userId, f.credentialId, `push-${sequence}-${ordinal}`]);
  const jobId = tinyId("rcj"), lease = `lease-${sequence}-${ordinal}`;
  db.run(
    "INSERT INTO review_capture_jobs (id,workspace_id,lineage_id,slug,observation_id,state,actor_kind,installation_id,user_id,credential_id,actor_key,attempts,failure,lease_token,lease_expires_at,capture_id,revision_id,created_at,updated_at) VALUES (?,?,?,?,?,'running','user',NULL,?,?,?,1,NULL,?,?,NULL,NULL,?,?)",
    [jobId, f.workspaceId, f.lineageId, f.slug, observationId, f.userId, f.credentialId, `${f.userId}/${f.credentialId}`, lease, Date.now() + 60_000, observedAt, observedAt],
  );
  return {
    head,
    publish() {
      const completed = completeCaptureJob({ jobId, leaseToken: lease, captureId });
      const lineage = getLineage(f.workspaceId, f.slug)!;
      const revision = getRevision(f.workspaceId, f.slug, lineage.latest_revision!)!;
      return { completed, revision, materialId };
    },
  };
}

async function run(f: Fixture): Promise<void> {
  while (await runNextGithubViewedJob(f.credentialId)) {}
}

describe("personal GitHub Viewed projection", () => {
  test("should queue only after complete exact file handling and ignore capture-wide material", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    const mutations: string[] = [];
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; }, onMutation: (kind) => mutations.push(kind) }));
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    expect(queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, completeOnly: true })).toBe(f.credentialId);
    expect(queued(f)).toBeNull();
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, true);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    expect(queued(f)).toBeNull();
    const inventory = getStageCaptureForWorkspaces(f.captureId, [f.workspaceId])!;
    const item = requiredAcknowledgements(inventory).find((candidate) => candidate.id === f.materialId)!;
    setRevisionAcknowledgement({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, item, acknowledged: true });
    expect(fileHandlingState(f.workspaceId, f.lineageId, f.revisionId, f.userId, f.path)).toEqual({ complete: true, changes: { total: 1, read: 1 }, gaps: { total: 1, acknowledged: 1 } });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    expect(queued(f)).not.toBeNull();
    await run(f);
    expect(mutations).toEqual(["mark"]);
    expect(getGithubViewedJob(queued(f)!.id)?.state).toBe("synced");
  });

  test("should treat a pre-existing Viewed marker as foreign and never own or unmark it", async () => {
    const f = fixture();
    const mutations: string[] = [];
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => "VIEWED", onMutation: (kind) => mutations.push(kind) }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    expect(getGithubViewedJob(queued(f)!.id)?.state).toBe("foreign");
    expect(db.query<{ one: number }, [string]>("SELECT 1 AS one FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toBeNull();
    expect(mutations).toEqual([]);
  });

  test("should mark and unmark only Seer-owned state for the same pull-request file", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    const mutations: string[] = [];
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; }, unmark: () => { state = "UNVIEWED"; }, onMutation: (kind) => mutations.push(kind) }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, false);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    expect(mutations).toEqual(["mark", "unmark"]);
    expect(db.query<{ unmarked_at: number | null }, [string]>("SELECT unmarked_at FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)?.unmarked_at).toBeNumber();
  });

  test("should wait through a push gap, enqueue fully carried handling on publication, and unview across heads", async () => {
    const f = fixture();
    let liveHead = f.head;
    let state: "VIEWED" | "UNVIEWED" | "DISMISSED" = "UNVIEWED";
    const mutations: string[] = [];
    clients.set(f.credentialId, fakeClient({ head: () => liveHead, state: () => state, mark: () => { state = "VIEWED"; }, unmark: () => { state = "UNVIEWED"; }, onMutation: (kind) => mutations.push(kind) }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    expect(mutations).toEqual(["mark"]);

    const push = preparePush(f);
    const beforeJob = getGithubViewedJob(queued(f)!.id)!;
    const beforeOwnership = db.query<any, [string]>("SELECT * FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId);
    writeRevisionReadHandling({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, changeId: f.changeId, read: true });
    expect(getGithubViewedJob(beforeJob.id)).toEqual(beforeJob);
    expect(db.query<any, [string]>("SELECT * FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toEqual(beforeOwnership);
    const oldLineage = getLineage(f.workspaceId, f.slug)!;
    const oldRevision = getRevision(f.workspaceId, f.slug, 1)!;
    expect(githubProjectionForReader({ workspaceId: f.workspaceId, lineage: oldLineage, revision: oldRevision, userId: f.userId })?.viewed.waitingForRevision).toBe(true);

    liveHead = push.head;
    state = "DISMISSED";
    const actorsBeforePublication = actors.length;
    const published = push.publish();
    expect(actors).toHaveLength(actorsBeforePublication);
    expect(published.completed.viewedCredentials).toContain(f.credentialId);
    expect(fileHandlingState(f.workspaceId, f.lineageId, published.revision.id, f.userId, f.path).complete).toBe(true);
    expect(getGithubViewedJob(beforeJob.id)).toMatchObject({ revision_id: published.revision.id, head_sha: push.head, desired: "viewed", state: "pending" });
    await run(f);
    expect(mutations).toEqual(["mark", "mark"]);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)?.n).toBe(1);
    expect(db.query<{ head_sha: string; revision_id: string; pre_state: string }, [string]>("SELECT head_sha,revision_id,pre_state FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toEqual({ head_sha: push.head, revision_id: published.revision.id, pre_state: "DISMISSED" });

    setRevisionChangeRead(f.workspaceId, published.revision.id, f.userId, f.changeId, false);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    expect(mutations).toEqual(["mark", "mark", "unmark"]);
    expect(state as string).toBe("UNVIEWED");
  });

  test("should remove owned marks after a push and preserve foreign Viewed state", async () => {
    const owned = fixture();
    let ownedHead = owned.head;
    let ownedState: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    const ownedMutations: string[] = [];
    clients.set(owned.credentialId, fakeClient({ head: () => ownedHead, state: () => ownedState, mark: () => { ownedState = "VIEWED"; }, unmark: () => { ownedState = "UNVIEWED"; }, onMutation: (kind) => ownedMutations.push(kind) }));
    handle(owned);
    setGithubProjectionPreference({ workspaceId: owned.workspaceId, lineageId: owned.lineageId, userId: owned.userId, credentialId: owned.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: owned.workspaceId, lineageId: owned.lineageId, userId: owned.userId });
    await run(owned);
    const push = preparePush(owned);
    ownedHead = push.head;
    push.publish();
    await run(owned);
    expect(queueOwnedMarksForRemoval({ workspaceId: owned.workspaceId, lineageId: owned.lineageId, userId: owned.userId })).toEqual([owned.credentialId]);
    await run(owned);
    expect(ownedMutations).toEqual(["mark", "unmark"]);
    expect(ownedState).toBe("UNVIEWED");

    const foreign = fixture();
    let foreignHead = foreign.head;
    const foreignMutations: string[] = [];
    clients.set(foreign.credentialId, fakeClient({ head: () => foreignHead, state: () => "VIEWED", onMutation: (kind) => foreignMutations.push(kind) }));
    handle(foreign);
    setGithubProjectionPreference({ workspaceId: foreign.workspaceId, lineageId: foreign.lineageId, userId: foreign.userId, credentialId: foreign.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: foreign.workspaceId, lineageId: foreign.lineageId, userId: foreign.userId });
    await run(foreign);
    const foreignPush = preparePush(foreign, 3);
    foreignHead = foreignPush.head;
    foreignPush.publish();
    await run(foreign);
    expect(getGithubViewedJob(queued(foreign)!.id)?.state).toBe("foreign");
    expect(queueOwnedMarksForRemoval({ workspaceId: foreign.workspaceId, lineageId: foreign.lineageId, userId: foreign.userId })).toEqual([]);
    expect(foreignMutations).toEqual([]);
  });

  test("should remove a mark through the credential that made it without disabling sync", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; }, unmark: () => { state = "UNVIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    const replacement = createGithubUserCredential({ userId: f.userId, kind: "pat", label: "replacement", secret: "replacement-token", accountLogin: "replacement", accountId: 9999, scopes: [], expiresAt: Date.now() + 60_000 });
    clients.set(replacement, fakeClient({ head: () => f.head, state: () => state }));
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: replacement, enabled: true });
    expect(queueOwnedMarksForRemoval({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId })).toEqual([f.credentialId]);
    await run(f);
    expect(state).toBe("UNVIEWED");
    expect(getGithubProjectionPreference(f.workspaceId, f.lineageId, f.userId)).toMatchObject({ viewed_enabled: 1, credential_id: replacement });
  });

  test("should remove an owned mark with a live replacement for the same GitHub account", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    expect(state as string).toBe("VIEWED");
    db.run("UPDATE github_user_credentials SET expires_at=? WHERE id=?", [Date.now() - 1, f.credentialId]);
    const replacement = createGithubUserCredential({ userId: f.userId, kind: "pat", label: "replacement", secret: `replacement-same-${sequence}`, accountLogin: `OCTOCAT-${sequence}`, accountId: sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    clients.set(replacement, fakeClient({ head: () => f.head, state: () => state, unmark: () => { state = "UNVIEWED"; } }));
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: replacement, enabled: true });

    expect(queueOwnedMarksForRemoval({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId })).toEqual([replacement]);
    const job = getGithubViewedJob(queued(f)!.id)!;
    expect(job).toMatchObject({ credential_id: replacement, desired: "unviewed", state: "pending" });
    while (await runNextGithubViewedJob(replacement)) {}
    expect(state).toBe("UNVIEWED");
    expect(db.query<{ credential_id: string; unmarked_at: number | null }, [string]>("SELECT credential_id,unmarked_at FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toEqual({ credential_id: f.credentialId, unmarked_at: expect.any(Number) });
    expect(db.query<{ ownership_credential_id: string; credential_id: string; account_login: string; account_id: number }, [string, number]>("SELECT ownership_credential_id,credential_id,account_login,account_id FROM review_github_viewed_credential_substitutions WHERE job_id=? AND generation=?").get(job.id, job.generation)).toEqual({ ownership_credential_id: f.credentialId, credential_id: replacement, account_login: `octocat-${sequence}`, account_id: sequence });
    expect(actors.at(-1)).toEqual({ userId: f.userId, credentialId: replacement });
  });

  test("should refuse to remove a mark with a replacement from another GitHub account", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);
    db.run("UPDATE github_user_credentials SET expires_at=? WHERE id=?", [Date.now() - 1, f.credentialId]);
    const replacement = createGithubUserCredential({ userId: f.userId, kind: "pat", label: "wrong account", secret: `replacement-other-${sequence}`, accountLogin: `someone-else-${sequence}`, accountId: 400_000 + sequence, scopes: [], expiresAt: Date.now() + 60_000 });
    const replacementMutations: string[] = [];
    clients.set(replacement, fakeClient({ head: () => f.head, state: () => state, unmark: () => { state = "UNVIEWED"; }, onMutation: (kind) => replacementMutations.push(kind) }));
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: replacement, enabled: true });

    expect(() => queueOwnedMarksForRemoval({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId })).toThrow(/different GitHub account/);
    expect(state as string).toBe("VIEWED");
    expect(replacementMutations).toEqual([]);
    expect(db.query<{ credential_id: string; unmarked_at: number | null }, [string]>("SELECT credential_id,unmarked_at FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toEqual({ credential_id: f.credentialId, unmarked_at: null });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_viewed_credential_substitutions WHERE job_id=?").get(queued(f)!.id)?.n).toBe(0);
  });

  test("should refuse a moved head before mutation and record a head race after mutation without judgment", async () => {
    const before = fixture();
    handle(before);
    const beforeMutations: string[] = [];
    clients.set(before.credentialId, fakeClient({ head: () => sha("9"), state: () => "UNVIEWED", onMutation: (kind) => beforeMutations.push(kind) }));
    setGithubProjectionPreference({ workspaceId: before.workspaceId, lineageId: before.lineageId, userId: before.userId, credentialId: before.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: before.workspaceId, lineageId: before.lineageId, userId: before.userId });
    await run(before);
    expect(beforeMutations).toEqual([]);
    expect(getGithubViewedJob(queued(before)!.id)?.failure_code).toBe("head_moved_before");

    const racing = fixture();
    handle(racing);
    let liveHead = racing.head;
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    clients.set(racing.credentialId, fakeClient({ head: () => liveHead, state: () => state, mark: () => { state = "VIEWED"; liveHead = sha("8"); } }));
    setGithubProjectionPreference({ workspaceId: racing.workspaceId, lineageId: racing.lineageId, userId: racing.userId, credentialId: racing.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: racing.workspaceId, lineageId: racing.lineageId, userId: racing.userId });
    expect({ liveHead, storedHead: getGithubViewedJob(queued(racing)!.id)?.head_sha }).toEqual({ liveHead: racing.head, storedHead: racing.head });
    await run(racing);
    expect(getGithubViewedJob(queued(racing)!.id)?.failure_code).toBe("head_moved_during");
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_revision_judgments WHERE revision_id=?").get(racing.revisionId)?.n).toBe(0);
  });

  test("should keep a local read committed when the selected personal actor is refused", async () => {
    const f = fixture();
    clients.set(f.credentialId, { ...fakeClient({ head: () => f.head, state: () => "UNVIEWED" }), async pullRequest() { throw new GithubGraphqlPermissionError("write permission revoked"); } });
    const inventory = getStageCaptureForWorkspaces(f.captureId, [f.workspaceId])!;
    const item = requiredAcknowledgements(inventory).find((candidate) => candidate.id === f.materialId)!;
    setRevisionAcknowledgement({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, item, acknowledged: true });
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    writeRevisionReadHandling({ workspaceId: f.workspaceId, lineageId: f.lineageId, revisionId: f.revisionId, userId: f.userId, changeId: f.changeId, read: true });
    for (let attempt = 0; attempt < 50 && getGithubViewedJob(queued(f)!.id)?.state === "pending"; attempt++) await Bun.sleep(5);
    expect(db.query("SELECT 1 AS one FROM review_revision_change_reads WHERE revision_id=? AND user_id=? AND change_id=?").get(f.revisionId, f.userId, f.changeId)).toEqual({ one: 1 });
    expect(getGithubViewedJob(queued(f)!.id)?.state).toBe("refused");
    expect(actors.at(-1)).toEqual({ userId: f.userId, credentialId: f.credentialId });
  });

  test("should not claim work before the credential's stored retry time", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: () => { state = "VIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    db.run("INSERT INTO github_graphql_rate_limits (credential_id,user_id,retry_after,observed_at) VALUES (?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET retry_after=excluded.retry_after,observed_at=excluded.observed_at", [f.credentialId, f.userId, Date.now() + 60_000, Date.now()]);
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(false);
    expect(getGithubViewedJob(queued(f)!.id)).toMatchObject({ attempts: 0, state: "failed", failure_code: "rate_limited" });
    db.run("UPDATE github_graphql_rate_limits SET retry_after=0 WHERE credential_id=?", [f.credentialId]);
    db.run("UPDATE review_github_viewed_jobs SET retry_at=0 WHERE id=?", [queued(f)!.id]);
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(true);
    expect(getGithubViewedJob(queued(f)!.id)?.state).toBe("synced");
  });

  test("should recover an expired lease, stop after five transport retries, and keep local state", async () => {
    const f = fixture();
    clients.set(f.credentialId, { ...fakeClient({ head: () => f.head, state: () => "UNVIEWED" }), async pullRequest() { throw new GithubGraphqlTransportError("network unavailable", false); } });
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const id = queued(f)!.id;
    db.run("UPDATE review_github_viewed_jobs SET state='running',lease_token='dead-worker',lease_expires_at=0 WHERE id=?", [id]);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await runNextGithubViewedJob(f.credentialId)).toBe(true);
      if (attempt < 4) db.run("UPDATE review_github_viewed_jobs SET retry_at=0 WHERE id=?", [id]);
    }
    expect(getGithubViewedJob(id)).toMatchObject({ state: "failed", attempts: 5, failure_code: "transport_failed" });
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(false);
    expect(db.query("SELECT 1 AS one FROM review_revision_change_reads WHERE revision_id=? AND user_id=? AND change_id=?").get(f.revisionId, f.userId, f.changeId)).toEqual({ one: 1 });
  });

  test("should disable Viewed with a credential-dead refusal before opening an actor", async () => {
    const f = fixture();
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    db.run("UPDATE github_user_credentials SET expires_at=? WHERE id=?", [Date.now() - 1, f.credentialId]);
    const openedBefore = actors.length;
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(true);
    expect(getGithubViewedJob(queued(f)!.id)).toMatchObject({ state: "refused", failure_code: "credential_dead" });
    expect(getGithubProjectionPreference(f.workspaceId, f.lineageId, f.userId)?.viewed_enabled).toBe(0);
    expect(actors).toHaveLength(openedBefore);
  });

  test("should keep member, key, capability and credential privacy boundaries", async () => {
    const evidence = process.env.SEER_TASK11_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "seer-task11-privacy-"));
    mkdirSync(evidence, { recursive: true });
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "github-projection-privacy.script.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DATA_DIR: mkdtempSync(join(tmpdir(), "seer-github-projection-privacy-")),
        AUTH_DISABLED: undefined as unknown as string,
        ALLOWED_EMAILS: undefined as unknown as string,
        API_KEY: undefined as unknown as string,
        API_TOKEN: undefined as unknown as string,
      },
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    writeFileSync(join(evidence, "privacy.txt"), `${out}${err}`);
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("github projection privacy: all assertions passed");
  });

  test("should keep a superseding generation behind the live lease before mutation", async () => {
    const f = fixture();
    let release!: () => void, queryBegan!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { queryBegan = resolve; });
    const mutations: string[] = [];
    const baseClient = fakeClient({ head: () => f.head, state: () => "UNVIEWED", onMutation: (kind) => mutations.push(kind) });
    let queries = 0;
    clients.set(f.credentialId, {
      ...baseClient,
      async pullRequest(...args) {
        queries += 1;
        if (queries === 1) { queryBegan(); await blocked; }
        return baseClient.pullRequest(...args);
      },
    });
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const holder = runNextGithubViewedJob(f.credentialId);
    await started;
    const held = getGithubViewedJob(queued(f)!.id)!;
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, false);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    expect(getGithubViewedJob(held.id)).toMatchObject({ state: "running", lease_token: held.lease_token, desired: "unviewed", generation: held.generation + 1 });
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(false);
    release();
    await holder;
    await run(f);
    expect(mutations).toEqual([]);
    expect(getGithubViewedJob(held.id)).toMatchObject({ desired: "unviewed", state: "synced" });
  });

  test("should reactivate ownership when an old unmark races a newer read", async () => {
    const f = fixture();
    const state: { value: "VIEWED" | "UNVIEWED" } = { value: "UNVIEWED" };
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state.value, mark: () => { state.value = "VIEWED"; }, unmark: () => { state.value = "UNVIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    await run(f);

    let release!: () => void, unmarkBegan!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { unmarkBegan = resolve; });
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state.value, mark: () => { state.value = "VIEWED"; }, unmark: async () => { unmarkBegan(); await blocked; state.value = "UNVIEWED"; } }));
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, false);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const old = runNextGithubViewedJob(f.credentialId);
    await started;
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, true);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const held = getGithubViewedJob(queued(f)!.id)!;
    expect(held).toMatchObject({ state: "running", desired: "viewed" });
    expect(held.lease_token).not.toBeNull();
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(false);
    release();
    await old;
    await run(f);
    expect(state.value).toBe("VIEWED");
    expect(getGithubViewedJob(queued(f)!.id)).toMatchObject({ desired: "viewed", state: "synced" });
    expect(db.query<{ unmarked_at: number | null; lost_at: number | null }, [string]>("SELECT unmarked_at,lost_at FROM review_github_viewed_ownership WHERE lineage_id=?").get(f.lineageId)).toEqual({ unmarked_at: null, lost_at: null });
  });

  test("should converge a successful old generation into the newer local reversal", async () => {
    const f = fixture();
    let state: "VIEWED" | "UNVIEWED" = "UNVIEWED";
    let release!: () => void;
    let markBegan!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markBegan = resolve; });
    clients.set(f.credentialId, fakeClient({ head: () => f.head, state: () => state, mark: async () => { markBegan(); await blocked; state = "VIEWED"; }, unmark: () => { state = "UNVIEWED"; } }));
    handle(f);
    setGithubProjectionPreference({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId, credentialId: f.credentialId, enabled: true });
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const running = runNextGithubViewedJob(f.credentialId);
    await started;
    setRevisionChangeRead(f.workspaceId, f.revisionId, f.userId, f.changeId, false);
    queueCurrentViewedJobs({ workspaceId: f.workspaceId, lineageId: f.lineageId, userId: f.userId });
    const held = getGithubViewedJob(queued(f)!.id)!;
    expect(held).toMatchObject({ state: "running", desired: "unviewed" });
    expect(held.lease_token).not.toBeNull();
    expect(await runNextGithubViewedJob(f.credentialId)).toBe(false);
    release();
    await running;
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_github_viewed_ownership WHERE lineage_id=? AND unmarked_at IS NULL AND lost_at IS NULL").get(f.lineageId)?.n).toBe(1);
    await run(f);
    expect(state).toBe("UNVIEWED");
    expect(getGithubViewedJob(queued(f)!.id)?.desired).toBe("unviewed");
    expect({ state: getGithubViewedJob(queued(f)!.id)?.state, failure: getGithubViewedJob(queued(f)!.id)?.failure_code }).toEqual({ state: "synced", failure: null });
  });
});
