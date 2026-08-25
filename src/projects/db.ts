// Projects: the grouping. Workspace-scoped and slugged exactly like bundles and
// reviews, nested one level by `parent_id`, holding bundles and reviews through
// many-to-many membership joins. The project holds no authored list — its page and
// its API response derive the contents by query, so there is one source of truth.
//
// The write rules the model settles (docs/projects/data-model.md) are enforced here,
// inside the transactions that need them, so a racing pair of writes cannot slip a
// second nesting level or a duplicate slug past a check that ran a moment earlier.

import { db } from "../db";
import { tinyId } from "../ids";
import { sweepOrphanPrStatus } from "../overseer/installations";

export type ProjectStatus = "open" | "done" | "closed";

export const PROJECT_STATUSES: readonly ProjectStatus[] = ["open", "done", "closed"];

export interface ProjectRow {
  id: string;
  workspace_id: string;
  slug: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: ProjectStatus;
  created_at: number;
  updated_at: number;
}

export function getProject(wsId: string, slug: string): ProjectRow | null {
  return db
    .query<ProjectRow, [string, string]>(
      "SELECT * FROM projects WHERE workspace_id = ? AND slug = ?",
    )
    .get(wsId, slug);
}

export function getProjectById(id: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
}

/** Every project in a workspace, most recently touched first. */
export function listProjects(wsId: string): ProjectRow[] {
  return db
    .query<ProjectRow, [string]>(
      "SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC",
    )
    .all(wsId);
}

export function listChildren(parentId: string): ProjectRow[] {
  return db
    .query<ProjectRow, [string]>(
      "SELECT * FROM projects WHERE parent_id = ? ORDER BY updated_at DESC",
    )
    .all(parentId);
}

/** A refusal the API can put a status code on without string-matching a message. */
export class ProjectWriteError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ProjectWriteError";
  }
}

/**
 * The one-level rule, checked against the row as it stands inside the transaction.
 * A parent must exist in this workspace, must not be the project itself, must not
 * itself have a parent, and the project taking a parent must not have children —
 * both directions, or attaching two ends at once could quietly build depth two.
 */
function assertParentAllowed(wsId: string, parent: ProjectRow, childId: string | null): void {
  if (parent.workspace_id !== wsId) {
    throw new ProjectWriteError(404, `No project "${parent.slug}" in this workspace`);
  }
  if (childId !== null && parent.id === childId) {
    throw new ProjectWriteError(422, "A project cannot be its own parent");
  }
  if (parent.parent_id !== null) {
    throw new ProjectWriteError(
      422,
      `"${parent.slug}" is itself a sub-project; projects nest one level deep`,
    );
  }
  if (childId !== null && listChildren(childId).length > 0) {
    throw new ProjectWriteError(
      422,
      "This project has sub-projects of its own; projects nest one level deep",
    );
  }
}

export const createProject = db.transaction(
  (
    wsId: string,
    slug: string,
    title: string,
    description: string,
    parentSlug: string | null,
  ): ProjectRow => {
    if (getProject(wsId, slug)) {
      throw new ProjectWriteError(409, `A project "${slug}" already exists in this workspace`);
    }
    let parentId: string | null = null;
    if (parentSlug !== null) {
      const parent = getProject(wsId, parentSlug);
      if (!parent) throw new ProjectWriteError(404, `No project "${parentSlug}" in this workspace`);
      assertParentAllowed(wsId, parent, null);
      parentId = parent.id;
    }
    const now = Date.now();
    const id = tinyId("prj");
    db.run(
      "INSERT INTO projects (id, workspace_id, slug, parent_id, title, description, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      [id, wsId, slug, parentId, title, description, now, now],
    );
    return getProject(wsId, slug)!;
  },
) as (
  wsId: string,
  slug: string,
  title: string,
  description: string,
  parentSlug: string | null,
) => ProjectRow;

export interface ProjectPatch {
  title?: string;
  description?: string;
  status?: ProjectStatus;
  /** A parent slug, or null to detach. Absent means untouched. */
  parent?: string | null;
}

/**
 * Apply a patch. A status change writes its event row in the same transaction, so the
 * trail and the row cannot disagree. Returns the row as patched.
 */
export const updateProject = db.transaction(
  (wsId: string, slug: string, patch: ProjectPatch, actorUserId: string | null): ProjectRow => {
    const project = getProject(wsId, slug);
    if (!project) throw new ProjectWriteError(404, `No project "${slug}" in this workspace`);
    const now = Date.now();

    let parentId = project.parent_id;
    if (patch.parent !== undefined) {
      if (patch.parent === null) {
        parentId = null;
      } else {
        const parent = getProject(wsId, patch.parent);
        if (!parent) {
          throw new ProjectWriteError(404, `No project "${patch.parent}" in this workspace`);
        }
        assertParentAllowed(wsId, parent, project.id);
        parentId = parent.id;
      }
    }

    if (patch.status !== undefined && patch.status !== project.status) {
      db.run(
        "INSERT INTO project_events (id, workspace_id, project_id, task_id, kind, from_status, to_status, actor_user_id, created_at) " +
          "VALUES (?, ?, ?, NULL, 'status', ?, ?, ?, ?)",
        [tinyId("evt"), wsId, project.id, project.status, patch.status, actorUserId, now],
      );
    }

    db.run(
      "UPDATE projects SET parent_id = ?, title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
      [
        parentId,
        patch.title ?? project.title,
        patch.description ?? project.description,
        patch.status ?? project.status,
        now,
        project.id,
      ],
    );
    return getProjectById(project.id)!;
  },
) as (wsId: string, slug: string, patch: ProjectPatch, actorUserId: string | null) => ProjectRow;

export interface ProjectEvent {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string | null;
  kind: "status";
  from_status: string;
  to_status: string;
  actor_user_id: string | null;
  created_at: number;
}

export function listProjectEvents(projectId: string): ProjectEvent[] {
  return db
    .query<ProjectEvent, [string]>(
      "SELECT * FROM project_events WHERE project_id = ? ORDER BY created_at ASC",
    )
    .all(projectId);
}

// ---- membership ----

type MembershipTable = "project_bundles" | "project_reviews" | "project_stages";

function attach(table: MembershipTable, project: ProjectRow, slug: string): boolean {
  const before = db
    .query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM ${table} WHERE project_id = ? AND slug = ?`,
    )
    .get(project.id, slug);
  db.run(
    `INSERT OR IGNORE INTO ${table} (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)`,
    [project.id, project.workspace_id, slug, Date.now()],
  );
  return !before;
}

function detach(table: MembershipTable, project: ProjectRow, slug: string): boolean {
  const before = db
    .query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM ${table} WHERE project_id = ? AND slug = ?`,
    )
    .get(project.id, slug);
  db.run(`DELETE FROM ${table} WHERE project_id = ? AND slug = ?`, [project.id, slug]);
  return !!before;
}

/** Idempotent; the boolean says whether this call changed anything. */
export const attachBundle = (project: ProjectRow, slug: string) =>
  attach("project_bundles", project, slug);
export const detachBundle = (project: ProjectRow, slug: string) =>
  detach("project_bundles", project, slug);
export const attachReview = (project: ProjectRow, slug: string) =>
  attach("project_reviews", project, slug);
export const detachReview = (project: ProjectRow, slug: string) =>
  detach("project_reviews", project, slug);

/** The slugs a project holds, oldest attachment first — the order they arrived. */
export function listProjectBundleSlugs(projectId: string): string[] {
  return db
    .query<{ slug: string }, [string]>(
      "SELECT slug FROM project_bundles WHERE project_id = ? ORDER BY created_at ASC",
    )
    .all(projectId)
    .map((r) => r.slug);
}

export function listProjectReviewSlugs(projectId: string): string[] {
  return db
    .query<{ slug: string }, [string]>(
      "SELECT slug FROM project_reviews WHERE project_id = ? ORDER BY created_at ASC",
    )
    .all(projectId)
    .map((r) => r.slug);
}

/** Which projects hold this bundle — the upload response says where an upload landed. */
export function listProjectsForBundle(wsId: string, slug: string): ProjectRow[] {
  return db
    .query<ProjectRow, [string, string]>(
      "SELECT p.* FROM project_bundles pb JOIN projects p ON p.id = pb.project_id " +
        "WHERE pb.workspace_id = ? AND pb.slug = ? ORDER BY pb.created_at ASC",
    )
    .all(wsId, slug);
}

export interface ProjectCounts {
  bundles: number;
  reviews: number;
  stages: number;
  children: number;
  tasks: number;
}

export function projectCounts(projectId: string): ProjectCounts {
  const count = (sql: string) =>
    db.query<{ n: number }, [string]>(sql).get(projectId)?.n ?? 0;
  const stages = db.query<{ n: number }, [string, string]>(
    "SELECT COUNT(*) AS n FROM project_stages WHERE project_id = ? AND workspace_id = (SELECT workspace_id FROM projects WHERE id = ?)",
  ).get(projectId, projectId)?.n ?? 0;
  return {
    bundles: count("SELECT COUNT(*) AS n FROM project_bundles WHERE project_id = ?"),
    reviews: count("SELECT COUNT(*) AS n FROM project_reviews WHERE project_id = ?"),
    stages,
    children: count("SELECT COUNT(*) AS n FROM projects WHERE parent_id = ?"),
    tasks: count("SELECT COUNT(*) AS n FROM project_tasks WHERE project_id = ?"),
  };
}

// ---- tasks ----

export interface TaskGate {
  text: string;
  met: boolean;
}

/** The authored pointer plus the one derived word the write path could add. `title`
 *  is best-effort at write time and null when GitHub could not be asked; state words
 *  are never stored here, they are read off github_pr_status. */
export interface TaskPrPointer {
  repo: string;
  number: number;
  title: string | null;
}

export interface TaskRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  body: string;
  status: ProjectStatus;
  gates: TaskGate[];
  prs: TaskPrPointer[];
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

interface RawTaskRow extends Omit<TaskRow, "gates" | "prs"> {
  gates: string;
  prs: string;
}

/** The stored JSON was written by this module, so anything malformed is corruption;
 *  dropping the bad element (or the bad list) keeps the read alive and the row's text
 *  fields still render. The shape check matters as much as the parse: `[null]` parses
 *  fine and then explodes in every consumer that reads `.repo` off it. */
function parseTask(raw: RawTaskRow): TaskRow {
  const list = <T,>(text: string, wellFormed: (el: unknown) => el is T): T[] => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      const kept = parsed.filter(wellFormed);
      if (kept.length !== parsed.length) {
        console.error(`[seer] task ${raw.id}: stored JSON carries misshapen elements`);
      }
      return kept;
    } catch {
      console.error(`[seer] task ${raw.id}: stored JSON failed to parse`);
      return [];
    }
  };
  const isGate = (el: unknown): el is TaskGate =>
    typeof el === "object" && el !== null &&
    typeof (el as TaskGate).text === "string" && typeof (el as TaskGate).met === "boolean";
  const isPr = (el: unknown): el is TaskPrPointer =>
    typeof el === "object" && el !== null &&
    typeof (el as TaskPrPointer).repo === "string" &&
    Number.isInteger((el as TaskPrPointer).number);
  return { ...raw, gates: list(raw.gates, isGate), prs: list(raw.prs, isPr) };
}

export function getTask(wsId: string, taskId: string): TaskRow | null {
  const raw = db
    .query<RawTaskRow, [string, string]>(
      "SELECT * FROM project_tasks WHERE workspace_id = ? AND id = ?",
    )
    .get(wsId, taskId);
  return raw ? parseTask(raw) : null;
}

/** Open first, then done, then closed; created order within each. The page and the
 *  state answer in reading order, and this is it. */
export function listTasks(projectId: string): TaskRow[] {
  return db
    .query<RawTaskRow, [string]>(
      "SELECT * FROM project_tasks WHERE project_id = ? ORDER BY " +
        "CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, created_at ASC",
    )
    .all(projectId)
    .map(parseTask);
}

/** Replace the queryable copy of a task's pointers wholesale. A pointer the rewrite
 *  KEEPS keeps its healed repo_id: un-healing it would strand the pointer after a
 *  repository rename (its frozen name no longer matches new observations, so nothing
 *  would ever heal it back) and let the orphan sweep take the status row the task
 *  still renders. Genuinely new rows start null, and the first observation — or the
 *  write-time seed — heals the numeric id exactly as it heals a backfilled review row. */
function setTaskPrs(wsId: string, taskId: string, prs: TaskPrPointer[]): void {
  const healed = new Map(
    db
      .query<{ repo: string; pr_number: number; repo_id: number | null }, [string, string]>(
        "SELECT repo, pr_number, repo_id FROM project_task_prs WHERE workspace_id = ? AND task_id = ?",
      )
      .all(wsId, taskId)
      .map((r) => [`${r.repo.toLowerCase()}#${r.pr_number}`, r.repo_id] as const),
  );
  db.run("DELETE FROM project_task_prs WHERE workspace_id = ? AND task_id = ?", [wsId, taskId]);
  for (const pr of prs) {
    db.run(
      "INSERT OR IGNORE INTO project_task_prs (workspace_id, task_id, repo_id, pr_number, repo) " +
        "VALUES (?, ?, ?, ?, ?)",
      [wsId, taskId, healed.get(`${pr.repo.toLowerCase()}#${pr.number}`) ?? null, pr.number, pr.repo],
    );
  }
}

export interface TaskFields {
  title: string;
  body: string;
  gates: TaskGate[];
  prs: TaskPrPointer[];
}

export const createTask = db.transaction(
  (wsId: string, projectId: string, fields: TaskFields): TaskRow => {
    const now = Date.now();
    const id = tinyId("tsk");
    db.run(
      "INSERT INTO project_tasks (id, workspace_id, project_id, title, body, status, gates, prs, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
      [id, wsId, projectId, fields.title, fields.body, JSON.stringify(fields.gates), JSON.stringify(fields.prs), now, now],
    );
    setTaskPrs(wsId, id, fields.prs);
    return getTask(wsId, id)!;
  },
) as (wsId: string, projectId: string, fields: TaskFields) => TaskRow;

export interface TaskPatch {
  title?: string;
  body?: string;
  status?: ProjectStatus;
  gates?: TaskGate[];
  prs?: TaskPrPointer[];
}

/**
 * Apply a patch. The gate rule lives here, against the row as patched: entering done
 * is judged on the gates this same patch carries, so an agent may flip the last gate
 * and close in one call. A status change writes its event row (task_id set) in the
 * same transaction; entering done stamps done_at, leaving it clears the stamp.
 */
export const updateTask = db.transaction(
  (wsId: string, taskId: string, patch: TaskPatch, actorUserId: string | null): TaskRow => {
    const task = getTask(wsId, taskId);
    if (!task) throw new ProjectWriteError(404, "No such task in this workspace");
    // A patch carrying nothing changes nothing, including updated_at: an empty write
    // is not a touch.
    if (
      patch.title === undefined && patch.body === undefined && patch.status === undefined &&
      patch.gates === undefined && patch.prs === undefined
    ) {
      return task;
    }
    const now = Date.now();

    const gates = patch.gates ?? task.gates;
    const status = patch.status ?? task.status;
    if (status === "done" && task.status !== "done") {
      const unmet = gates.find((g) => !g.met);
      if (unmet) {
        throw new ProjectWriteError(422, `gate not met: ${unmet.text}`);
      }
    }

    if (patch.status !== undefined && patch.status !== task.status) {
      db.run(
        "INSERT INTO project_events (id, workspace_id, project_id, task_id, kind, from_status, to_status, actor_user_id, created_at) " +
          "VALUES (?, ?, ?, ?, 'status', ?, ?, ?, ?)",
        [tinyId("evt"), wsId, task.project_id, taskId, task.status, patch.status, actorUserId, now],
      );
    }

    const doneAt = status === "done" ? (task.done_at ?? now) : null;
    db.run(
      "UPDATE project_tasks SET title = ?, body = ?, status = ?, gates = ?, prs = ?, updated_at = ?, done_at = ? WHERE id = ?",
      [
        patch.title ?? task.title,
        patch.body ?? task.body,
        status,
        JSON.stringify(gates),
        JSON.stringify(patch.prs ?? task.prs),
        now,
        doneAt,
        taskId,
      ],
    );
    if (patch.prs !== undefined) {
      setTaskPrs(wsId, taskId, patch.prs);
      // The counterpart the review publish already runs: this rewrite may have
      // dropped the last naming of a pull request, and a status row nobody names is
      // exactly what the delivery filter exists to prevent. Same transaction as the
      // write that changed the answer.
      sweepOrphanPrStatus(wsId);
    }
    return getTask(wsId, taskId)!;
  },
) as (wsId: string, taskId: string, patch: TaskPatch, actorUserId: string | null) => TaskRow;

/** The healed numeric id for one authored pointer, or null while unobserved. */
export function repoIdForTaskPr(
  wsId: string,
  taskId: string,
  repo: string,
  prNumber: number,
): number | null {
  const row = db
    .query<{ repo_id: number | null }, [string, string, string, number]>(
      "SELECT repo_id FROM project_task_prs WHERE workspace_id = ? AND task_id = ? " +
        "AND lower(repo) = ? AND pr_number = ?",
    )
    .get(wsId, taskId, repo.toLowerCase(), prNumber);
  return row?.repo_id ?? null;
}

// ---- notes ----

// Append-only. There is no updateNote and no deleteNote, and there must never be:
// the notes are the record of what the agent was thinking while it worked, and a
// journal you can edit afterwards is testimony you can revise. Correcting a note
// means writing another.

export interface NoteRow {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string | null;
  body: string;
  author_user_id: string | null;
  created_at: number;
}

export const createNote = db.transaction(
  (
    wsId: string,
    projectId: string,
    taskId: string | null,
    body: string,
    authorUserId: string | null,
  ): NoteRow => {
    if (taskId !== null) {
      const task = getTask(wsId, taskId);
      // A foreign task and a missing one are the same refusal: the pointer must name
      // this project's own content.
      if (!task || task.project_id !== projectId) {
        throw new ProjectWriteError(404, "No such task in this project");
      }
    }
    const id = tinyId("note");
    db.run(
      "INSERT INTO project_notes (id, workspace_id, project_id, task_id, body, author_user_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, wsId, projectId, taskId, body, authorUserId, Date.now()],
    );
    return db.query<NoteRow, [string]>("SELECT * FROM project_notes WHERE id = ?").get(id)!;
  },
) as (
  wsId: string,
  projectId: string,
  taskId: string | null,
  body: string,
  authorUserId: string | null,
) => NoteRow;

/** The whole record, oldest first: reading it front to back is reading the history. */
export function listNotes(projectId: string): NoteRow[] {
  return db
    .query<NoteRow, [string]>(
      "SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(projectId);
}

export function countNotes(projectId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ?",
      )
      .get(projectId)?.n ?? 0
  );
}

/** The most recent `limit` notes, still oldest first, so a bounded tail reads
 *  chronologically like the full record does. */
export function listNotesTail(projectId: string, limit: number): NoteRow[] {
  return db
    .query<NoteRow, [string, number]>(
      // rowid, not the random tiny id: within one millisecond the id is no order at
      // all, and the tail must be the LAST notes in the order they were written.
      "SELECT * FROM (SELECT *, rowid AS rid FROM project_notes WHERE project_id = ? " +
        "ORDER BY created_at DESC, rid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC",
    )
    .all(projectId, limit);
}
