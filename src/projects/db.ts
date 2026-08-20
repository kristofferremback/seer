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

type MembershipTable = "project_bundles" | "project_reviews";

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
  children: number;
}

export function projectCounts(projectId: string): ProjectCounts {
  const count = (sql: string) =>
    db.query<{ n: number }, [string]>(sql).get(projectId)?.n ?? 0;
  return {
    bundles: count("SELECT COUNT(*) AS n FROM project_bundles WHERE project_id = ?"),
    reviews: count("SELECT COUNT(*) AS n FROM project_reviews WHERE project_id = ?"),
    children: count("SELECT COUNT(*) AS n FROM projects WHERE parent_id = ?"),
  };
}
