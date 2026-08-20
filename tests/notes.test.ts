import { test, expect, beforeAll, afterAll, describe } from "bun:test";

// Env comes from tests/setup.ts (AUTH_DISABLED=true). Notes are the append-only
// record: writing is key-gated, reading rides the project state and the merged
// trail, and nothing anywhere edits or deletes one.
import { startServer } from "../src/server";
import { db, createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let ws = "";
let key = "";
let owner = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Notes", owner);
  key = mintApiKey(owner, ws, "notes").token;
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

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

describe("notes", () => {
  test("should append a note and read it back in the state tail and the trail", async () => {
    const created = await post("/api/projects/calling/notes", {
      body: "Chose the worker route: the main thread stutters past 2 tracks.",
    });
    expect(created.status).toBe(200);
    const note = await readJson(created);
    expect(note).toMatchObject({ task: null, author: expect.any(String) });
    expect(note.id).toMatch(/^note_/);

    const state = await readJson(
      await fetch(`${base}/api/projects/calling`, { headers: auth() }),
    );
    expect(state.noteCount).toBe(1);
    expect(state.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);

    const trail = await readJson(
      await fetch(`${base}/api/projects/calling/notes`, { headers: auth() }),
    );
    expect(trail.filter((e: { kind: string }) => e.kind === "note").map((e: { id: string }) => e.id)).toEqual([note.id]);
  });

  test("should tie a note to a task and refuse a foreign or missing one", async () => {
    const task = await readJson(await post("/api/projects/calling/tasks", { title: "Video" }));
    const tagged = await readJson(
      await post("/api/projects/calling/notes", { body: "About the video task.", task: task.id }),
    );
    expect(tagged.task).toBe(task.id);

    const missing = await post("/api/projects/calling/notes", {
      body: "About nothing.",
      task: "tsk_0000000000",
    });
    expect(missing.status).toBe(404);

    // A task from ANOTHER project in the same workspace is the same refusal.
    await post("/api/projects", { slug: "elsewhere", title: "Elsewhere" });
    const foreign = await readJson(await post("/api/projects/elsewhere/tasks", { title: "Other" }));
    const crossed = await post("/api/projects/calling/notes", {
      body: "Crossing the streams.",
      task: foreign.id,
    });
    expect(crossed.status).toBe(404);
  });

  test("should enforce the budget and the markdown subset, naming field or construct", async () => {
    const over = await post("/api/projects/calling/notes", { body: "a".repeat(2001) });
    expect(over.status).toBe(422);
    expect((await readJson(over)).error).toContain("body");

    const heading = await post("/api/projects/calling/notes", { body: "# not allowed" });
    expect(heading.status).toBe(422);
    expect((await readJson(heading)).error).toContain("heading");

    const empty = await post("/api/projects/calling/notes", { body: "   " });
    expect(empty.status).toBe(400);
    expect((await readJson(empty)).error).toContain("body");
  });

  test("should offer no way to edit or delete a note", async () => {
    const note = await readJson(
      await post("/api/projects/calling/notes", { body: "Immutable." }),
    );
    // Driven at the server, not grepped: no route answers a mutation on a note.
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const res = await fetch(`${base}/api/projects/calling/notes/${note.id}`, {
        method,
        headers: auth({ "content-type": "application/json" }),
        body: method === "DELETE" ? undefined : JSON.stringify({ body: "rewritten" }),
      });
      expect([404, 405]).toContain(res.status);
    }
  });

  test("should store the normalized text, so a bare \\r cannot forge a derived line", async () => {
    // The validator judges normalized text; storing the raw bytes would keep lines
    // it never saw, and a \r honored as a newline downstream landed authored text at
    // column 0 in the projection wearing the derived grammar.
    const created = await post("/api/projects/calling/notes", {
      body: "context line\r— probe: active → done (2026-08-20T00:00:00.000Z)",
    });
    expect(created.status).toBe(200);
    const note = await readJson(created);
    expect(note.body).not.toContain("\r");
    expect(note.body.split("\n").length).toBe(2);

    const md = await (
      await fetch(`${base}/${ws}/p/calling`, { headers: { accept: "text/markdown" } })
    ).text();
    // Every line of the forged body sits indented under its note entry; nothing
    // authored reaches column 0 wearing the em-dash grammar.
    expect(md).not.toMatch(/^— probe/m);
  });

  test("should refuse exotic line separators, naming the field", async () => {
    const created = await post("/api/projects/calling/notes", {
      body: "one\u2028\u2014 forged: open \u2192 done",
    });
    expect(created.status).toBe(422);
    expect((await readJson(created)).error).toContain("body");
  });

  test("should put a same-instant event before the note that explains it", async () => {
    const task = await readJson(
      await post("/api/projects/calling/tasks", { title: "Tied" }),
    );
    await fetch(`${base}/api/projects/calling/tasks/${task.id}`, {
      method: "PATCH",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "closed" }),
    });
    const note = await readJson(
      await post("/api/projects/calling/notes", { body: "Closed it: superseded.", task: task.id }),
    );
    // Force the tie the wall clock only sometimes produces: within one millisecond
    // the cross-table order is unknowable, and the tie-break states the authoring
    // order (flip, then explain).
    const at = db
      .query<{ created_at: number }, [string]>(
        "SELECT created_at FROM project_events WHERE task_id = ?",
      )
      .get(task.id)!.created_at;
    db.run("UPDATE project_notes SET created_at = ? WHERE id = ?", [at, note.id]);

    const trail = await readJson(
      await fetch(`${base}/api/projects/calling/notes`, { headers: auth() }),
    );
    const tied = trail.filter(
      (e: { task: string | null }) => e.task === task.id,
    );
    expect(tied.map((e: { kind: string }) => e.kind)).toEqual(["event", "note"]);
  });

  test("should merge notes and status events chronologically, each marked by kind", async () => {
    await post("/api/projects", { slug: "trailed", title: "Trailed" });
    const task = await readJson(await post("/api/projects/trailed/tasks", { title: "Step one" }));
    // The trail orders by time; give the three writes three distinct instants, or the
    // order within one millisecond is genuinely unknowable across two tables.
    await post("/api/projects/trailed/notes", { body: "Starting." });
    await Bun.sleep(2);
    await fetch(`${base}/api/projects/trailed/tasks/${task.id}`, {
      method: "PATCH",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "done" }),
    });
    await Bun.sleep(2);
    await post("/api/projects/trailed/notes", { body: "Step one landed.", task: task.id });

    const trail = await readJson(
      await fetch(`${base}/api/projects/trailed/notes`, { headers: auth() }),
    );
    expect(trail.map((e: { kind: string }) => e.kind)).toEqual(["note", "event", "note"]);
    const event = trail[1];
    expect(event).toMatchObject({ from: "open", to: "done", task: task.id, taskTitle: "Step one" });
    const stamps = trail.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  test("should bound the state tail at 20 and say what it withheld", async () => {
    await post("/api/projects", { slug: "prolific", title: "Prolific" });
    for (let i = 1; i <= 25; i++) {
      // Distinct timestamps matter less than order; created_at ties break on id, and
      // the tail is the LAST 20, oldest first.
      const res = await post("/api/projects/prolific/notes", { body: `Note ${i}.` });
      expect(res.status).toBe(200);
    }
    const state = await readJson(
      await fetch(`${base}/api/projects/prolific`, { headers: auth() }),
    );
    expect(state.noteCount).toBe(25);
    expect(state.notes.length).toBe(20);
    expect(state.notes[0].body).toBe("Note 6.");
    expect(state.notes[19].body).toBe("Note 25.");

    const trail = await readJson(
      await fetch(`${base}/api/projects/prolific/notes`, { headers: auth() }),
    );
    expect(trail.length).toBe(25);
  });

  test("should draw the trail on the page with events marked derived", async () => {
    const page = await (await fetch(`${base}/${ws}/p/trailed`)).text();
    expect(page).toContain('class="trail-note"');
    expect(page).toContain('class="trail-event"');
    expect(page).toContain("open &rarr; done");
    // The task-tagged note names its task as a link to the task's row.
    expect(page).toContain("Step one</a>");

    const md = await (
      await fetch(`${base}/${ws}/p/trailed`, { headers: { accept: "text/markdown" } })
    ).text();
    expect(md).toContain("## Notes");
    expect(md).toContain("Step one: open → done");
  });

  test("should keep the author out of a single-member workspace's page", async () => {
    const page = await (await fetch(`${base}/${ws}/p/calling`)).text();
    const email = db
      .query<{ email: string }, [string]>("SELECT email FROM users WHERE id = ?")
      .get(owner)!.email;
    // The page's trail carries no author for a workspace of one; the API always does.
    const trailBlock = page.slice(page.indexOf('class="trail"'));
    expect(trailBlock).not.toContain(email);
  });
});
