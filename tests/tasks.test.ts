import { test, expect, beforeAll, afterAll, describe } from "bun:test";

// Env comes from tests/setup.ts (AUTH_DISABLED=true). Tasks are the third slice of
// projects: gates, derived PR state through the same observation plumbing reviews
// use, and the drift line when the facts disagree with the authored status.
import { startServer } from "../src/server";
import { db, createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import {
  attachInstallation,
  getPrStatus,
  observePullRequest,
  sweepOrphanPrStatus,
  type PrObservation,
} from "../src/overseer/installations";
import { setGithubClientFactory } from "../src/overseer/github-app";
import { offlineGithubClientFactory } from "./offline-github";

const INSTALLATION = 6160;
const REPO = "acme/site";
const REPO_ID = 424242;

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let ws = "";
let key = "";
let owner = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Tasks", owner);
  key = mintApiKey(owner, ws, "tasks").token;
  // The offline client refuses every call, which is what makes "GitHub could not be
  // asked" the observed case rather than an arranged one: titles come back null and
  // the writes still succeed.
  setGithubClientFactory(offlineGithubClientFactory());
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ slug: "calling", title: "Calling functionality" }),
  });
  expect(created.status).toBe(200);
});

afterAll(() => {
  server.stop(true);
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...extra };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

function createTask(body: unknown): Promise<Response> {
  return fetch(`${base}/api/projects/calling/tasks`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function patchTask(id: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/projects/calling/tasks/${id}`, {
    method: "PATCH",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function observation(over: Partial<PrObservation> = {}): PrObservation {
  return {
    repoId: REPO_ID,
    repo: REPO,
    prNumber: 7,
    state: "open",
    merged: false,
    draft: false,
    headSha: "a".repeat(40),
    updatedAt: Date.parse("2026-08-20T10:00:00Z"),
    ...over,
  };
}

describe("task rules", () => {
  test("should create a task whose PR pointers are unchecked with null titles offline", async () => {
    const res = await createTask({
      title: "Video pipeline",
      body: "Capture and encode in the worker.",
      gates: [{ text: "loopback works" }, { text: "two-tab call", met: false }],
      prs: [{ repo: REPO, number: 7 }],
    });
    expect(res.status).toBe(200);
    const task = await readJson(res);
    expect(task).toMatchObject({
      title: "Video pipeline",
      status: "open",
      gates: [
        { text: "loopback works", met: false },
        { text: "two-tab call", met: false },
      ],
      drift: null,
      doneAt: null,
    });
    expect(task.prs).toEqual([
      {
        repo: REPO,
        number: 7,
        title: null,
        state: "unchecked",
        url: `https://github.com/${REPO}/pull/7`,
      },
    ]);
  });

  test("should refuse done while a gate is unmet, naming the gate", async () => {
    const task = await readJson(
      await createTask({ title: "Gated", gates: [{ text: "the proof exists" }] }),
    );
    const refused = await patchTask(task.id, { status: "done" });
    expect(refused.status).toBe(422);
    expect((await readJson(refused)).error).toContain("the proof exists");

    // Closing needs no proof: stopping is always allowed.
    const closed = await patchTask(task.id, { status: "closed" });
    expect(closed.status).toBe(200);
    expect((await readJson(closed)).status).toBe("closed");
  });

  test("should let one call flip the last gate and finish, stamping doneAt", async () => {
    const task = await readJson(
      await createTask({ title: "Finishable", gates: [{ text: "it ships" }] }),
    );
    const done = await readJson(
      await patchTask(task.id, { status: "done", gates: [{ text: "it ships", met: true }] }),
    );
    expect(done.status).toBe("done");
    expect(done.doneAt).not.toBeNull();

    const reopened = await readJson(await patchTask(task.id, { status: "open" }));
    expect(reopened.doneAt).toBeNull();
  });

  test("should record exactly one event per status transition, carrying the task id", async () => {
    const task = await readJson(await createTask({ title: "Evented" }));
    await patchTask(task.id, { status: "closed" });
    await patchTask(task.id, { title: "Evented still" }); // no transition, no event
    await patchTask(task.id, { status: "open" });
    const events = db
      .query<{ from_status: string; to_status: string }, [string]>(
        "SELECT from_status, to_status FROM project_events WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all(task.id);
    expect(events).toEqual([
      { from_status: "open", to_status: "closed" },
      { from_status: "closed", to_status: "open" },
    ]);
  });

  test("should enforce the budgets, naming the field", async () => {
    const overTitle = await createTask({ title: "x".repeat(121) });
    expect(overTitle.status).toBe(422);
    expect((await readJson(overTitle)).error).toContain("title");

    const overGates = await createTask({
      title: "Gates",
      gates: Array.from({ length: 9 }, (_, i) => ({ text: `gate ${i}` })),
    });
    expect(overGates.status).toBe(422);
    expect((await readJson(overGates)).error).toContain("gates");

    const overBody = await createTask({ title: "Body", body: "a".repeat(16_385) });
    expect(overBody.status).toBe(422);
    expect((await readJson(overBody)).error).toContain("body");

    const overPrs = await createTask({
      title: "Prs",
      prs: Array.from({ length: 17 }, (_, i) => ({ repo: REPO, number: i + 1 })),
    });
    expect(overPrs.status).toBe(422);
    expect((await readJson(overPrs)).error).toContain("prs");

    const badRepo = await createTask({ title: "Repo", prs: [{ repo: "not-a-repo", number: 1 }] });
    expect(badRepo.status).toBe(400);
    expect((await readJson(badRepo)).error).toContain("repo");
  });

  test("should refuse a duplicate pointer and a dot-segment repo, naming the entry", async () => {
    const dup = await createTask({
      title: "Doubled",
      prs: [
        { repo: "acme/site", number: 3 },
        { repo: "ACME/site", number: 3 },
      ],
    });
    expect(dup.status).toBe(422);
    expect((await readJson(dup)).error).toContain("prs[1]");

    const dotted = await createTask({ title: "Dotted", prs: [{ repo: "../evil", number: 1 }] });
    expect(dotted.status).toBe(400);
    expect((await readJson(dotted)).error).toContain("prs[0].repo");
  });

  test("should treat an empty patch as no touch at all", async () => {
    const task = await readJson(await createTask({ title: "Untouched" }));
    const before = task.updatedAt;
    const patched = await readJson(await patchTask(task.id, {}));
    expect(patched.updatedAt).toBe(before);
  });

  test("should answer tasks open first in the project state", async () => {
    const state = await readJson(
      await fetch(`${base}/api/projects/calling`, { headers: auth() }),
    );
    const statuses = state.tasks.map((t: { status: string }) => t.status);
    const firstNonOpen = statuses.findIndex((s: string) => s !== "open");
    if (firstNonOpen !== -1) {
      expect(statuses.slice(firstNonOpen).every((s: string) => s !== "open")).toBe(true);
    }
    expect(state.tasks.length).toBeGreaterThan(0);
  });
});

describe("task PR observations", () => {
  beforeAll(() => {
    const attached = attachInstallation({
      wsId: ws,
      userId: owner,
      installationId: INSTALLATION,
      accountLogin: "acme",
      accountId: 99,
      accountType: "Organization",
      repositorySelection: "all",
    });
    expect(typeof attached).not.toBe("string");
  });

  test("should keep an observation only a task names, and heal the pointer's repo id", async () => {
    const task = await readJson(
      await createTask({ title: "Observed", prs: [{ repo: REPO, number: 7 }] }),
    );

    // A pull request nothing names is acknowledged and dropped: the growth bound.
    expect(observePullRequest(INSTALLATION, observation({ prNumber: 999 }))).toBe(0);
    expect(getPrStatus(ws, REPO_ID, 999)).toBeNull();

    // One a task names is kept, and the first observation heals the numeric id.
    expect(observePullRequest(INSTALLATION, observation())).toBeGreaterThan(0);
    const healed = db
      .query<{ repo_id: number | null }, [string]>(
        "SELECT repo_id FROM project_task_prs WHERE task_id = ?",
      )
      .get(task.id);
    expect(healed?.repo_id).toBe(REPO_ID);

    const read = await readJson(
      await fetch(`${base}/api/projects/calling`, { headers: auth() }),
    );
    const seen = read.tasks.find((t: { id: string }) => t.id === task.id);
    expect(seen.prs[0].state).toBe("open");
  });

  test("should carry the drift line when every named pull request is merged", async () => {
    const task = await readJson(
      await createTask({ title: "Drifting", prs: [{ repo: REPO, number: 8 }] }),
    );
    observePullRequest(
      INSTALLATION,
      observation({ prNumber: 8, state: "closed", merged: true }),
    );
    const drifted = await readJson(
      await fetch(`${base}/api/projects/calling`, { headers: auth() }),
    );
    const seen = drifted.tasks.find((t: { id: string }) => t.id === task.id);
    expect(seen.prs[0].state).toBe("merged");
    expect(seen.drift).toBe("all pull requests merged");

    // The drift is a hint, not an auto-fix: done by hand clears it.
    const done = await readJson(await patchTask(task.id, { status: "done" }));
    expect(done.drift).toBeNull();
  });

  test("should not sweep a status row a task still names", () => {
    // The publish-side sweep collects rows nothing names; a task's naming counts.
    sweepOrphanPrStatus(ws);
    expect(getPrStatus(ws, REPO_ID, 7)).not.toBeNull();
  });

  test("should keep a healed repo id through a prs rewrite", async () => {
    // Un-healing a kept pointer would strand it after a repo rename: the frozen name
    // no longer matches new observations, so nothing would ever heal it back.
    const task = await readJson(
      await createTask({ title: "Rewritten", prs: [{ repo: REPO, number: 13 }] }),
    );
    observePullRequest(INSTALLATION, observation({ prNumber: 13 }));
    const rewritten = await patchTask(task.id, {
      prs: [
        { repo: REPO, number: 13 },
        { repo: REPO, number: 14 },
      ],
    });
    expect(rewritten.status).toBe(200);
    const rows = db
      .query<{ pr_number: number; repo_id: number | null }, [string]>(
        "SELECT pr_number, repo_id FROM project_task_prs WHERE task_id = ? ORDER BY pr_number",
      )
      .all(task.id);
    expect(rows).toEqual([
      { pr_number: 13, repo_id: REPO_ID },
      { pr_number: 14, repo_id: null },
    ]);
  });

  test("should sweep a status row when a task rewrite drops its last naming", async () => {
    const task = await readJson(
      await createTask({ title: "Dropped", prs: [{ repo: REPO, number: 15 }] }),
    );
    observePullRequest(INSTALLATION, observation({ prNumber: 15 }));
    expect(getPrStatus(ws, REPO_ID, 15)).not.toBeNull();
    await patchTask(task.id, { prs: [] });
    // Nothing names it any more, so the row a future delivery would be dropped for
    // must not linger either.
    expect(getPrStatus(ws, REPO_ID, 15)).toBeNull();
  });

  test("should seed the state at write for an already-merged pull request", async () => {
    // The authoring order that matters: merge first, record the task after. There
    // will never be a webhook for it, so the write-time fetch is the only observer.
    const offline = offlineGithubClientFactory();
    setGithubClientFactory((wsId, userId) => ({
      ...offline(wsId, userId),
      getPull: async () => ({
        title: "Merged before the task existed",
        state: "closed",
        merged: true,
        draft: false,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40), repo: { id: REPO_ID, full_name: REPO } },
        updated_at: "2026-08-20T10:00:00Z",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      installationFor: async () => INSTALLATION,
    }));
    try {
      const task = await readJson(
        await createTask({ title: "Late record", prs: [{ repo: REPO, number: 21 }] }),
      );
      expect(task.prs[0]).toMatchObject({
        title: "Merged before the task existed",
        state: "merged",
      });
      const healed = db
        .query<{ repo_id: number | null }, [string]>(
          "SELECT repo_id FROM project_task_prs WHERE task_id = ?",
        )
        .get(task.id);
      expect(healed?.repo_id).toBe(REPO_ID);
      expect(task.drift).toBe("all pull requests merged");
    } finally {
      setGithubClientFactory(offline);
    }
  });

  test("should keep the read alive over misshapen stored JSON", async () => {
    const task = await readJson(await createTask({ title: "Corrupted" }));
    db.run("UPDATE project_tasks SET prs = '[null]', gates = '[3]' WHERE id = ?", [task.id]);
    const read = await fetch(`${base}/api/projects/calling`, { headers: auth() });
    expect(read.status).toBe(200);
    const seen = (await readJson(read)).tasks.find((t: { id: string }) => t.id === task.id);
    expect(seen).toMatchObject({ gates: [], prs: [] });
    const page = await fetch(`${base}/${ws}/p/calling`);
    expect(page.status).toBe(200);
  });

  test("should render tasks in the markdown projection with checkbox gates", async () => {
    // A fresh open task naming the already-merged pull request, so the projection has
    // a live drift line to carry (the earlier one was deliberately closed by hand).
    await createTask({ title: "Still drifting", prs: [{ repo: REPO, number: 8 }] });
    const res = await fetch(`${base}/${ws}/p/calling`, {
      headers: { accept: "text/markdown" },
    });
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain("## Tasks");
    expect(md).toContain("- [ ] loopback works");
    expect(md).toContain("acme/site#7 (open)");
    expect(md).toContain("drift: all pull requests merged");
  });
});
