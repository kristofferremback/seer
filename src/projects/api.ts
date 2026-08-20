// The projects API handlers. Thin over ./db: parse, authenticate, validate the
// authored fields, translate ProjectWriteError into its status. The route table in
// src/api.ts carries the documentation; this file carries the behavior.

import { config } from "../config";
import { getBundle, isMember, listUserWorkspaces, listVersions } from "../db";
import { json } from "../http";
import { SLUG_RE } from "../ids";
import { requireApiKey, sessionUser } from "../auth";
import { validate as validateMarkdown } from "../overseer/markdown";
import { getReview, getReviewVersion } from "../overseer/db";
import {
  attachBundle,
  attachReview,
  createProject,
  detachBundle,
  detachReview,
  getProject,
  getProjectById,
  listChildren,
  listProjectBundleSlugs,
  listProjectReviewSlugs,
  listProjects,
  projectCounts,
  PROJECT_STATUSES,
  ProjectWriteError,
  updateProject,
  type ProjectPatch,
  type ProjectRow,
  type ProjectStatus,
} from "./db";

export const TITLE_MAX = 80;
/** Generous — the description is the project's whole brief — but a budget all the
 *  same: it is rendered into every page view and every state response. */
export const DESCRIPTION_MAX = 16_384;

// ---- the resolved state: one call to resume ----

export interface ProjectChildSummary {
  slug: string;
  title: string;
  status: ProjectStatus;
  bundles: number;
  reviews: number;
}

export interface ProjectBundleEntry {
  slug: string;
  latestVersion: number;
  updatedAt: number;
  url: string;
}

export interface ProjectReviewEntry {
  slug: string;
  title: string;
  latestVersion: number;
  publishedAt: number;
  url: string;
}

export interface ProjectState {
  project: ProjectRow;
  parent: { slug: string; title: string; status: ProjectStatus } | null;
  children: ProjectChildSummary[];
  bundles: ProjectBundleEntry[];
  reviews: ProjectReviewEntry[];
}

/**
 * Everything one project holds, resolved by query. Children are shallow summaries,
 * never recursive, so a parent's response stays bounded. A membership row whose
 * bundle or review has since vanished is skipped rather than rendered as a hole —
 * deleting assets is not a thing Seer does today, but a join must not trust that.
 */
export function projectState(project: ProjectRow): ProjectState {
  const ws = project.workspace_id;
  const parentRow = project.parent_id ? getProjectById(project.parent_id) : null;

  const bundles: ProjectBundleEntry[] = [];
  for (const slug of listProjectBundleSlugs(project.id)) {
    const bundle = getBundle(ws, slug);
    if (!bundle) continue;
    const versions = listVersions(ws, slug);
    bundles.push({
      slug,
      latestVersion: bundle.latest_version,
      updatedAt: versions[0]?.created_at ?? bundle.created_at,
      url: `${config.baseUrl}/${ws}/b/${slug}/`,
    });
  }

  const reviews: ProjectReviewEntry[] = [];
  for (const slug of listProjectReviewSlugs(project.id)) {
    const review = getReview(ws, slug);
    if (!review) continue;
    const latest = getReviewVersion(ws, slug, review.latest_version);
    reviews.push({
      slug,
      title: latest?.doc.title ?? slug,
      latestVersion: review.latest_version,
      publishedAt: latest?.created_at ?? review.created_at,
      url: `${config.baseUrl}/${ws}/r/${slug}/`,
    });
  }

  return {
    project,
    parent: parentRow
      ? { slug: parentRow.slug, title: parentRow.title, status: parentRow.status }
      : null,
    children: listChildren(project.id).map((child) => {
      const counts = projectCounts(child.id);
      return {
        slug: child.slug,
        title: child.title,
        status: child.status,
        bundles: counts.bundles,
        reviews: counts.reviews,
      };
    }),
    bundles,
    reviews,
  };
}

function projectUrl(project: ProjectRow): string {
  return `${config.baseUrl}/${project.workspace_id}/p/${project.slug}`;
}

function stateJson(state: ProjectState): unknown {
  const p = state.project;
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    status: p.status,
    parent: state.parent?.slug ?? null,
    workspace: p.workspace_id,
    url: projectUrl(p),
    createdAt: new Date(p.created_at).toISOString(),
    updatedAt: new Date(p.updated_at).toISOString(),
    children: state.children,
    bundles: state.bundles.map((b) => ({
      slug: b.slug,
      latestVersion: b.latestVersion,
      updatedAt: new Date(b.updatedAt).toISOString(),
      url: b.url,
    })),
    reviews: state.reviews.map((r) => ({
      slug: r.slug,
      title: r.title,
      latestVersion: r.latestVersion,
      publishedAt: new Date(r.publishedAt).toISOString(),
      url: r.url,
    })),
  };
}

// ---- authored-field validation ----

type FieldError = { error: string; status: 400 | 422 };

function badField(error: string, status: 400 | 422 = 400): FieldError {
  return { error, status };
}

function checkTitle(title: unknown): string | FieldError {
  if (typeof title !== "string" || title.trim() === "") {
    return badField("`title` is required: a non-empty string of at most 80 characters");
  }
  const trimmed = title.trim();
  // One line, and only printable characters: the title flows into the markdown
  // projection as a `# ` heading, where an authored newline could forge lines the
  // model says only Seer may write.
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return badField("`title` is one line: no newlines or control characters", 422);
  }
  if (trimmed.length > TITLE_MAX) {
    return badField(`\`title\` is over budget: ${trimmed.length} of at most ${TITLE_MAX} characters`, 422);
  }
  return trimmed;
}

function checkDescription(description: unknown): string | FieldError {
  if (typeof description !== "string") {
    return badField("`description` must be a string of constrained markdown");
  }
  if (description.length > DESCRIPTION_MAX) {
    return badField(
      `\`description\` is over budget: ${description.length} of at most ${DESCRIPTION_MAX} characters`,
      422,
    );
  }
  const result = validateMarkdown(description);
  if (!result.ok) return badField(`\`description\`: ${result.message}`, 422);
  return description;
}

function checkStatus(status: unknown): ProjectStatus | FieldError {
  if (typeof status === "string" && (PROJECT_STATUSES as readonly string[]).includes(status)) {
    return status as ProjectStatus;
  }
  return badField(`\`status\` must be one of ${PROJECT_STATUSES.join(", ")}`);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ error: "The body must be a JSON object" }, 400);
    }
    return body as Record<string, unknown>;
  } catch {
    return json({ error: "The body must be JSON" }, 400);
  }
}

function refusal(err: unknown): Response {
  if (err instanceof ProjectWriteError) return json({ error: err.message }, err.status);
  throw err;
}

// ---- handlers ----

export async function handleCreateProject(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  const slug = body.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return json({ error: "`slug` is required and must match [a-z0-9][a-z0-9-]{0,63}" }, 400);
  }
  const title = checkTitle(body.title);
  if (typeof title !== "string") return json({ error: title.error }, title.status);
  const description = checkDescription(body.description ?? "");
  if (typeof description !== "string") return json({ error: description.error }, description.status);
  const parent = body.parent ?? null;
  if (parent !== null && (typeof parent !== "string" || !SLUG_RE.test(parent))) {
    return json({ error: "`parent` must be a project slug, or null" }, 400);
  }

  try {
    const project = createProject(auth.workspaceId, slug, title, description, parent);
    return json(stateJson(projectState(project)));
  } catch (err) {
    return refusal(err);
  }
}

export function handleListProjects(req: Request): Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  const rows = listProjects(auth.workspaceId);
  const bySlug = new Map(rows.map((p) => [p.id, p.slug]));
  return json(
    rows.map((p) => {
      const counts = projectCounts(p.id);
      return {
        slug: p.slug,
        title: p.title,
        status: p.status,
        parent: p.parent_id ? (bySlug.get(p.parent_id) ?? null) : null,
        workspace: p.workspace_id,
        url: projectUrl(p),
        updatedAt: new Date(p.updated_at).toISOString(),
        bundles: counts.bundles,
        reviews: counts.reviews,
        children: counts.children,
      };
    }),
  );
}

/**
 * Resolve a slug for a read: the key's workspace and the session's memberships are
 * unioned, first hit wins. A key that does not authenticate contributes nothing
 * rather than answering 401 — on the shared read address, unauthenticated and
 * unauthorized are the same generic 404, the posture the review read path settled
 * (src/overseer/read.ts): anything else is a key-validity oracle, and a stale header
 * beside a valid session would otherwise shadow the session entirely.
 */
function resolveProjectForRead(req: Request, slug: string): ProjectRow | Response {
  const wsIds: string[] = [];
  if (req.headers.get("authorization")) {
    const auth = requireApiKey(req);
    if (!(auth instanceof Response)) wsIds.push(auth.workspaceId);
  }
  const user = sessionUser(req);
  if (user) for (const ws of listUserWorkspaces(user.id)) wsIds.push(ws.id);
  for (const wsId of wsIds) {
    const project = getProject(wsId, slug);
    if (project) return project;
  }
  return json({ error: "Not found" }, 404);
}

export function handleReadProject(req: Request, slug: string): Response {
  if (!SLUG_RE.test(slug)) return json({ error: "Not found" }, 404);
  const project = resolveProjectForRead(req, slug);
  if (project instanceof Response) return project;
  return json(stateJson(projectState(project)));
}

export async function handleUpdateProject(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug)) return json({ error: "Not found" }, 404);
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  const patch: ProjectPatch = {};
  if (body.title !== undefined) {
    const title = checkTitle(body.title);
    if (typeof title !== "string") return json({ error: title.error }, title.status);
    patch.title = title;
  }
  if (body.description !== undefined) {
    const description = checkDescription(body.description);
    if (typeof description !== "string") {
      return json({ error: description.error }, description.status);
    }
    patch.description = description;
  }
  if (body.status !== undefined) {
    const status = checkStatus(body.status);
    if (typeof status !== "string") return json({ error: status.error }, status.status);
    patch.status = status;
  }
  if (body.parent !== undefined) {
    if (body.parent !== null && (typeof body.parent !== "string" || !SLUG_RE.test(body.parent))) {
      return json({ error: "`parent` must be a project slug, or null" }, 400);
    }
    patch.parent = body.parent as string | null;
  }

  try {
    const project = updateProject(auth.workspaceId, slug, patch, auth.userId);
    return json(stateJson(projectState(project)));
  } catch (err) {
    return refusal(err);
  }
}

/** Attach or detach one bundle or review. Idempotent: the response says what this
 *  call changed, and repeating it changes nothing and says so. */
export function handleProjectMembership(
  req: Request,
  slug: string,
  kind: "bundle" | "review",
  target: string,
  act: "attach" | "detach",
): Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug) || !SLUG_RE.test(target)) return json({ error: "Not found" }, 404);
  const project = getProject(auth.workspaceId, slug);
  if (!project) return json({ error: `No project "${slug}" in this workspace` }, 404);

  const exists =
    kind === "bundle"
      ? getBundle(auth.workspaceId, target) !== null
      : getReview(auth.workspaceId, target) !== null;
  if (!exists) return json({ error: `No ${kind} "${target}" in this workspace` }, 404);

  const changed =
    act === "attach"
      ? (kind === "bundle" ? attachBundle : attachReview)(project, target)
      : (kind === "bundle" ? detachBundle : detachReview)(project, target);
  return json({ project: slug, [kind]: target, [act === "attach" ? "attached" : "detached"]: changed });
}

/**
 * The upload-time attachment: `?project=<slug>` on PUT/POST /api/bundles/:slug.
 * Resolved BEFORE the version is created, so a typo'd project fails the whole upload
 * rather than landing the bundle and losing the grouping.
 */
export function resolveUploadProject(req: Request, wsId: string): ProjectRow | null | Response {
  const slug = new URL(req.url).searchParams.get("project");
  if (slug === null) return null;
  if (!SLUG_RE.test(slug)) {
    return json({ error: "`project` must be a project slug: [a-z0-9][a-z0-9-]{0,63}" }, 400);
  }
  const project = getProject(wsId, slug);
  if (!project) return json({ error: `No project "${slug}" in this workspace` }, 404);
  return project;
}

/** Membership is workspace-agnostic in shape but the page needs it per user. */
export function userCanReadProject(userId: string, project: ProjectRow): boolean {
  return isMember(project.workspace_id, userId);
}
