// The projects API handlers. Thin over ./db: parse, authenticate, validate the
// authored fields, translate ProjectWriteError into its status. The route table in
// src/api.ts carries the documentation; this file carries the behavior.

import { config } from "../config";
import { getBundle, getUser, isMember, listUserWorkspaces, listVersions } from "../db";
import { json } from "../http";
import { SLUG_RE, TSK_ID_RE } from "../ids";
import { requireApiKey, sessionUser } from "../auth";
import { normalize as normalizeMarkdown, validate as validateMarkdown } from "../overseer/markdown";
import { getReview, getReviewVersion } from "../overseer/db";
import { getLineage } from "../overseer/revision-db";
import {
  ANONYMOUS_OBSERVER,
  findPrStatus,
  getPrStatus,
  healTaskPrRepoId,
  statusOf,
  upsertPrStatus,
} from "../overseer/installations";
import { parseUpdatedAt } from "../overseer/derive";
import { githubClientFor } from "../overseer/github-app";
import { getStage, getStageVersion, listProjectStageSlugs } from "../stage/db";
import {
  attachBundle,
  attachReview,
  countNotes,
  createNote,
  createProject,
  createTask,
  getTask,
  listNotes,
  listNotesTail,
  listProjectEvents,
  listTasks,
  type NoteRow,
  repoIdForTaskPr,
  updateTask,
  type TaskGate,
  type TaskPatch,
  type TaskPrPointer,
  type TaskRow,
  detachBundle,
  detachReview,
  getProject,
  getProjectById,
  listChildren,
  listProjectBundleSlugs,
  listProjectReviewLineageSlugs,
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
  /** Legacy reviews and promoted lineages are counted apart, because they resolve
   *  through different readers. The page adds them up under one heading; the state does
   *  not, so a caller can still tell which kind it is looking at. */
  reviews: number;
  reviewLineages: number;
  stages: number;
  tasks: number;
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

export interface ProjectReviewLineageEntry {
  slug: string;
  title: string;
  latestRevision: number;
  latestAccountVersion: number | null;
  updatedAt: number;
  url: string;
  revisionUrl: string;
  apiUrl: string;
}

export interface ProjectStageEntry {
  slug: string;
  title: string;
  latestVersion: number;
  updatedAt: number;
  url: string;
  versionUrl: string;
  apiUrl: string;
  apiVersionUrl: string;
}

export interface ProjectState {
  project: ProjectRow;
  parent: { slug: string; title: string; status: ProjectStatus } | null;
  children: ProjectChildSummary[];
  tasks: TaskView[];
  /** Bundles of kind plan, first: the project's documents to read. */
  plans: ProjectBundleEntry[];
  bundles: ProjectBundleEntry[];
  reviews: ProjectReviewEntry[];
  reviewLineages: ProjectReviewLineageEntry[];
  stages: ProjectStageEntry[];
  /** The most recent NOTES_TAIL notes, oldest first so they read chronologically. */
  notes: NoteView[];
  /** Every note the project holds, so a bounded tail says what it withheld. */
  noteCount: number;
}

/** How many notes the one-call state carries. The full record stays one call away
 *  (GET /api/projects/:slug/notes); the tail keeps the resume read bounded. */
export const NOTES_TAIL = 20;

export interface NoteView {
  id: string;
  /** The task the note hangs off, when it does. */
  task: string | null;
  taskTitle: string | null;
  body: string;
  /** The key holder's email at write time, or null when unknown. */
  author: string | null;
  createdAt: number;
}

function noteView(note: NoteRow): NoteView {
  const task = note.task_id ? getTask(note.workspace_id, note.task_id) : null;
  return {
    id: note.id,
    task: note.task_id,
    taskTitle: task?.title ?? null,
    body: note.body,
    author: note.author_user_id ? (getUser(note.author_user_id)?.email ?? null) : null,
    createdAt: note.created_at,
  };
}

/** One entry of the merged record: an authored note, or a derived status event. The
 *  two kinds carry the split the whole model runs on, and every consumer keeps them
 *  visually and structurally distinct. */
export type TrailEntry =
  | ({ kind: "note" } & NoteView)
  | {
      kind: "event";
      task: string | null;
      taskTitle: string | null;
      from: string;
      to: string;
      createdAt: number;
    };

/** Notes and status events, one chronological list. `notes` is passed in rather than
 *  queried so the caller chooses the tail or the whole record. */
export function projectTrail(project: ProjectRow, notes: NoteRow[]): TrailEntry[] {
  const entries: TrailEntry[] = notes.map((n) => ({ kind: "note" as const, ...noteView(n) }));
  for (const e of listProjectEvents(project.id)) {
    const task = e.task_id ? getTask(project.workspace_id, e.task_id) : null;
    entries.push({
      kind: "event",
      task: e.task_id,
      taskTitle: task?.title ?? null,
      from: e.from_status,
      to: e.to_status,
      createdAt: e.created_at,
    });
  }
  // Within one millisecond the order across two tables is genuinely unknowable, so
  // the tie-break states the authoring order that produces ties: an agent flips the
  // status and then writes the note explaining it, and the explanation must not
  // precede the thing it explains.
  return entries.sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1),
  );
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

  const plans: ProjectBundleEntry[] = [];
  const bundles: ProjectBundleEntry[] = [];
  for (const slug of listProjectBundleSlugs(project.id)) {
    const bundle = getBundle(ws, slug);
    if (!bundle) continue;
    const versions = listVersions(ws, slug);
    (bundle.kind === "plan" ? plans : bundles).push({
      slug,
      latestVersion: bundle.latest_version,
      updatedAt: versions[0]?.created_at ?? bundle.created_at,
      url: `${config.baseUrl}/${ws}/b/${slug}/`,
    });
  }

  const stages: ProjectStageEntry[] = [];
  for (const slug of listProjectStageSlugs(ws, project.id)) {
    const stage = getStage(ws, slug);
    if (!stage) continue;
    const latest = getStageVersion(ws, slug, stage.latest_version);
    if (!latest) continue;
    stages.push({
      slug,
      title: latest.doc.identity.title,
      latestVersion: stage.latest_version,
      updatedAt: latest.created_at,
      url: `${config.baseUrl}/${ws}/st/${slug}`,
      versionUrl: `${config.baseUrl}/${ws}/st/${slug}/v/${stage.latest_version}`,
      apiUrl: `${config.baseUrl}/api/stages/${slug}`,
      apiVersionUrl: `${config.baseUrl}/api/stages/${slug}/v/${stage.latest_version}`,
    });
  }

  const reviewLineages: ProjectReviewLineageEntry[] = [];
  for (const slug of listProjectReviewLineageSlugs(ws, project.id)) {
    const lineage = getLineage(ws, slug);
    if (!lineage || lineage.latest_revision === null) continue;
    reviewLineages.push({
      slug,
      title: lineage.title,
      latestRevision: lineage.latest_revision,
      latestAccountVersion: lineage.latest_account_version,
      updatedAt: lineage.updated_at,
      url: `${config.baseUrl}/${ws}/r/${slug}`,
      revisionUrl: `${config.baseUrl}/${ws}/r/${slug}/rev/${lineage.latest_revision}`,
      apiUrl: `${config.baseUrl}/api/review-lineages/${slug}`,
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
        reviewLineages: counts.reviewLineages,
        stages: counts.stages,
        tasks: counts.tasks,
      };
    }),
    tasks: listTasks(project.id).map(taskView),
    plans,
    bundles,
    reviews,
    reviewLineages,
    stages,
    notes: listNotesTail(project.id, NOTES_TAIL).map(noteView),
    noteCount: countNotes(project.id),
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
    tasks: state.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      body: t.body,
      status: t.status,
      gates: t.gates,
      prs: t.prs,
      drift: t.drift,
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.updatedAt).toISOString(),
      doneAt: t.doneAt === null ? null : new Date(t.doneAt).toISOString(),
    })),
    plans: state.plans.map((b) => ({
      slug: b.slug,
      latestVersion: b.latestVersion,
      updatedAt: new Date(b.updatedAt).toISOString(),
      url: b.url,
    })),
    bundles: state.bundles.map((b) => ({
      slug: b.slug,
      latestVersion: b.latestVersion,
      updatedAt: new Date(b.updatedAt).toISOString(),
      url: b.url,
    })),
    stages: state.stages.map((s) => ({
      slug: s.slug,
      title: s.title,
      latestVersion: s.latestVersion,
      updatedAt: new Date(s.updatedAt).toISOString(),
      url: s.url,
      versionUrl: s.versionUrl,
      apiUrl: s.apiUrl,
      apiVersionUrl: s.apiVersionUrl,
    })),
    reviews: state.reviews.map((r) => ({
      slug: r.slug,
      title: r.title,
      latestVersion: r.latestVersion,
      publishedAt: new Date(r.publishedAt).toISOString(),
      url: r.url,
    })),
    reviewLineages: state.reviewLineages.map((r) => ({
      slug: r.slug,
      title: r.title,
      latestRevision: r.latestRevision,
      latestAccountVersion: r.latestAccountVersion,
      updatedAt: new Date(r.updatedAt).toISOString(),
      url: r.url,
      revisionUrl: r.revisionUrl,
      apiUrl: r.apiUrl,
    })),
    notes: state.notes.map(noteJson),
    noteCount: state.noteCount,
  };
}

function noteJson(n: NoteView): unknown {
  return {
    id: n.id,
    task: n.task,
    body: n.body,
    author: n.author,
    createdAt: new Date(n.createdAt).toISOString(),
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

function checkMarkdownField(field: string, value: unknown, cap = DESCRIPTION_MAX): string | FieldError {
  if (typeof value !== "string") {
    return badField(`\`${field}\` must be a string of constrained markdown`);
  }
  // Validate and STORE the same document: the validator normalizes line endings
  // before judging, so storing the raw text would keep lines it never saw. A bare
  // \r read as a newline downstream is exactly how a body forges lines only Seer
  // may write. The exotic separators (NEL, LS, PS, vertical tab, form feed) have no
  // legitimate markdown use and are refused outright, the same class the one-line
  // title rule closes.
  const text = normalizeMarkdown(value);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0085\u2028\u2029]/.test(text)) {
    return badField(`\`${field}\` carries control characters; write plain lines`, 422);
  }
  if (text.length > cap) {
    return badField(
      `\`${field}\` is over budget: ${text.length} of at most ${cap} characters`,
      422,
    );
  }
  const result = validateMarkdown(text);
  if (!result.ok) return badField(`\`${field}\`: ${result.message}`, 422);
  return text;
}

function checkDescription(description: unknown): string | FieldError {
  return checkMarkdownField("description", description);
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
        reviewLineages: counts.reviewLineages,
        stages: counts.stages,
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

// ---- tasks ----

export const TASK_TITLE_MAX = 120;
export const GATE_TEXT_MAX = 120;
export const MAX_GATES = 8;
export const MAX_TASK_PRS = 16;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface TaskPrView {
  repo: string;
  number: number;
  /** Best-effort at write time; null when GitHub could not be asked. */
  title: string | null;
  /** Read off github_pr_status at answer time; "unchecked" when no observation. */
  state: "merged" | "closed" | "draft" | "open" | "unchecked";
  url: string;
}

export interface TaskView {
  id: string;
  title: string;
  body: string;
  status: ProjectStatus;
  gates: TaskGate[];
  prs: TaskPrView[];
  /** Derived, never authored: the page states the drift, it never fixes the status. */
  drift: string | null;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
}

/** One task with its derived facts attached: PR state words off the observations the
 *  webhooks and publishes have landed, and the drift line when every named pull
 *  request is merged while the task still says open. */
export function taskView(task: TaskRow): TaskView {
  const ws = task.workspace_id;
  const prs: TaskPrView[] = task.prs.map((p) => {
    const repoId = repoIdForTaskPr(ws, task.id, p.repo, p.number);
    const row = repoId !== null ? getPrStatus(ws, repoId, p.number) : findPrStatus(ws, p.repo, p.number);
    return {
      repo: p.repo,
      number: p.number,
      title: p.title,
      state: row ? statusOf(row) : "unchecked",
      url: `https://github.com/${p.repo}/pull/${p.number}`,
    };
  });
  const drift =
    task.status === "open" && prs.length > 0 && prs.every((p) => p.state === "merged")
      ? "all pull requests merged"
      : null;
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    gates: task.gates,
    prs,
    drift,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    doneAt: task.done_at,
  };
}

function checkTaskTitle(title: unknown): string | FieldError {
  if (typeof title !== "string" || title.trim() === "") {
    return badField("`title` is required: a non-empty string of at most 120 characters");
  }
  const trimmed = title.trim();
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return badField("`title` is one line: no newlines or control characters", 422);
  }
  if (trimmed.length > TASK_TITLE_MAX) {
    return badField(`\`title\` is over budget: ${trimmed.length} of at most ${TASK_TITLE_MAX} characters`, 422);
  }
  return trimmed;
}

function checkGates(gates: unknown): TaskGate[] | FieldError {
  if (!Array.isArray(gates)) return badField("`gates` must be an array of { text, met }");
  if (gates.length > MAX_GATES) {
    return badField(`\`gates\` is over budget: ${gates.length} of at most ${MAX_GATES}`, 422);
  }
  const checked: TaskGate[] = [];
  for (const [i, gate] of gates.entries()) {
    const g = gate as { text?: unknown; met?: unknown };
    if (typeof g !== "object" || g === null || typeof g.text !== "string" || g.text.trim() === "") {
      return badField(`\`gates[${i}]\` needs a non-empty \`text\``);
    }
    const text = g.text.trim();
    if (/[\u0000-\u001f]/.test(text)) {
      return badField(`\`gates[${i}].text\` is one line: no newlines or control characters`, 422);
    }
    if (text.length > GATE_TEXT_MAX) {
      return badField(
        `\`gates[${i}].text\` is over budget: ${text.length} of at most ${GATE_TEXT_MAX} characters`,
        422,
      );
    }
    if (g.met !== undefined && typeof g.met !== "boolean") {
      return badField(`\`gates[${i}].met\` must be a boolean`);
    }
    checked.push({ text, met: g.met === true });
  }
  return checked;
}

function checkPrPointers(prs: unknown): { repo: string; number: number }[] | FieldError {
  if (!Array.isArray(prs)) return badField("`prs` must be an array of { repo, number }");
  if (prs.length > MAX_TASK_PRS) {
    return badField(`\`prs\` is over budget: ${prs.length} of at most ${MAX_TASK_PRS}`, 422);
  }
  const checked: { repo: string; number: number }[] = [];
  const seen = new Set<string>();
  for (const [i, pr] of prs.entries()) {
    const p = pr as { repo?: unknown; number?: unknown };
    if (typeof p !== "object" || p === null || typeof p.repo !== "string" || !REPO_RE.test(p.repo)) {
      return badField(`\`prs[${i}].repo\` must be "owner/name"`);
    }
    // Refuse what the GitHub plumbing refuses (assertRepo): a "." or ".." segment
    // would store a pointer no client can ever resolve and render a nonsense link.
    if (p.repo.split("/").some((segment) => segment === "." || segment === "..")) {
      return badField(`\`prs[${i}].repo\` must be "owner/name"`);
    }
    if (!Number.isInteger(p.number) || (p.number as number) < 1) {
      return badField(`\`prs[${i}].number\` must be a positive integer`);
    }
    const key = `${p.repo.toLowerCase()}#${p.number}`;
    if (seen.has(key)) {
      return badField(`\`prs[${i}]\` names ${p.repo}#${p.number} more than once`, 422);
    }
    seen.add(key);
    checked.push({ repo: p.repo, number: p.number as number });
  }
  return checked;
}

/** How long a task write waits on GitHub for a title before shrugging. The fetch is
 *  a courtesy, not a dependency: on timeout or refusal the pointer stores a null
 *  title and the write proceeds. */
export const TITLE_FETCH_TIMEOUT_MS = 4_000;

/** What one successful write-time fetch observed, kept so the task does not have to
 *  wait for a webhook that may never come: a pointer at an already-merged pull
 *  request has no future deliveries, and the seed is the only thing that gives it a
 *  state word — the same reason review publish seeds (src/overseer/routes.ts). */
interface TaskPrSeed {
  repo: string;
  number: number;
  repoId: number | null;
  installationId: number | null;
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  updatedAt: number;
}

/**
 * Best-effort derived facts for pointers this write introduces. Pointers the task
 * already carries keep the title they have, fetched or null; only new (repo, number)
 * pairs cost a request. Every failure path is the same answer: a null title and no
 * seed — the write never waits on GitHub beyond the timeout and never fails over it.
 */
async function withDerivedPrFacts(
  wsId: string,
  userId: string,
  prs: { repo: string; number: number }[],
  existing: TaskPrPointer[],
): Promise<{ prs: TaskPrPointer[]; seeds: TaskPrSeed[] }> {
  const known = new Map<string, string | null>(
    existing.map((p) => [`${p.repo.toLowerCase()}#${p.number}`, p.title]),
  );
  const seeds: TaskPrSeed[] = [];
  const pointers = await Promise.all(
    prs.map(async (p): Promise<TaskPrPointer> => {
      const key = `${p.repo.toLowerCase()}#${p.number}`;
      if (known.has(key)) return { ...p, title: known.get(key) ?? null };
      try {
        const client = githubClientFor(wsId, userId);
        const pull = await Promise.race([
          client.getPull(p.repo, p.number),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("title fetch timed out")), TITLE_FETCH_TIMEOUT_MS),
          ),
        ]);
        seeds.push({
          repo: p.repo,
          number: p.number,
          repoId: pull.base?.repo?.id ?? null,
          // Same attribution rule as the review derivation: a client with no notion
          // of installations keeps the seed away; a routing client answering
          // "nobody's" still made the observation, and it is worth keeping.
          installationId: client.installationFor
            ? ((await client.installationFor(p.repo)) ?? ANONYMOUS_OBSERVER)
            : null,
          state: pull.state === "closed" ? "closed" : "open",
          merged: pull.merged === true,
          draft: pull.draft === true,
          headSha: pull.head.sha,
          updatedAt: parseUpdatedAt(pull.updated_at),
        });
        return { ...p, title: typeof pull.title === "string" ? pull.title : null };
      } catch {
        return { ...p, title: null };
      }
    }),
  );
  return { prs: pointers, seeds };
}

/** Land what the write-time fetch observed, after the task row exists: heal the
 *  pointer's numeric id, and put the state through the same conditional upsert every
 *  other writer uses, so a seed that raced a webhook cannot roll a newer fact back. */
function applyPrSeeds(wsId: string, taskId: string, seeds: TaskPrSeed[]): void {
  for (const seed of seeds) {
    if (seed.repoId === null) continue;
    healTaskPrRepoId(wsId, taskId, seed.repo, seed.number, seed.repoId);
    if (seed.installationId === null) continue;
    upsertPrStatus(wsId, seed.installationId, {
      repoId: seed.repoId,
      repo: seed.repo,
      prNumber: seed.number,
      state: seed.state,
      merged: seed.merged,
      draft: seed.draft,
      headSha: seed.headSha,
      updatedAt: seed.updatedAt,
    });
  }
}

function taskJsonOf(task: TaskRow): unknown {
  const view = taskView(task);
  return {
    ...view,
    createdAt: new Date(view.createdAt).toISOString(),
    updatedAt: new Date(view.updatedAt).toISOString(),
    doneAt: view.doneAt === null ? null : new Date(view.doneAt).toISOString(),
  };
}

export async function handleCreateTask(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug)) return json({ error: "Not found" }, 404);
  const project = getProject(auth.workspaceId, slug);
  if (!project) return json({ error: `No project "${slug}" in this workspace` }, 404);
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  const title = checkTaskTitle(body.title);
  if (typeof title !== "string") return json({ error: title.error }, title.status);
  const taskBody = checkMarkdownField("body", body.body ?? "");
  if (typeof taskBody !== "string") return json({ error: taskBody.error }, taskBody.status);
  const gates = checkGates(body.gates ?? []);
  if (!Array.isArray(gates)) return json({ error: gates.error }, gates.status);
  const pointers = checkPrPointers(body.prs ?? []);
  if (!Array.isArray(pointers)) return json({ error: pointers.error }, pointers.status);

  const derived = await withDerivedPrFacts(auth.workspaceId, auth.userId, pointers, []);
  const task = createTask(auth.workspaceId, project.id, {
    title,
    body: taskBody,
    gates,
    prs: derived.prs,
  });
  applyPrSeeds(auth.workspaceId, task.id, derived.seeds);
  return json(taskJsonOf(task));
}

export async function handleUpdateTask(req: Request, slug: string, taskId: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug) || !TSK_ID_RE.test(taskId)) return json({ error: "Not found" }, 404);
  const project = getProject(auth.workspaceId, slug);
  if (!project) return json({ error: `No project "${slug}" in this workspace` }, 404);
  const existing = getTask(auth.workspaceId, taskId);
  if (!existing || existing.project_id !== project.id) return json({ error: "Not found" }, 404);
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  const patch: TaskPatch = {};
  if (body.title !== undefined) {
    const title = checkTaskTitle(body.title);
    if (typeof title !== "string") return json({ error: title.error }, title.status);
    patch.title = title;
  }
  if (body.body !== undefined) {
    const taskBody = checkMarkdownField("body", body.body);
    if (typeof taskBody !== "string") return json({ error: taskBody.error }, taskBody.status);
    patch.body = taskBody;
  }
  if (body.status !== undefined) {
    const status = checkStatus(body.status);
    if (typeof status !== "string") return json({ error: status.error }, status.status);
    patch.status = status;
  }
  if (body.gates !== undefined) {
    const gates = checkGates(body.gates);
    if (!Array.isArray(gates)) return json({ error: gates.error }, gates.status);
    patch.gates = gates;
  }
  let seeds: TaskPrSeed[] = [];
  if (body.prs !== undefined) {
    const pointers = checkPrPointers(body.prs);
    if (!Array.isArray(pointers)) return json({ error: pointers.error }, pointers.status);
    const derived = await withDerivedPrFacts(auth.workspaceId, auth.userId, pointers, existing.prs);
    patch.prs = derived.prs;
    seeds = derived.seeds;
  }

  try {
    const task = updateTask(auth.workspaceId, taskId, patch, auth.userId);
    applyPrSeeds(auth.workspaceId, taskId, seeds);
    return json(taskJsonOf(task));
  } catch (err) {
    return refusal(err);
  }
}

// ---- notes ----

export const NOTE_BODY_MAX = 2_000;

export async function handleCreateNote(req: Request, slug: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug)) return json({ error: "Not found" }, 404);
  const project = getProject(auth.workspaceId, slug);
  if (!project) return json({ error: `No project "${slug}" in this workspace` }, 404);
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  const noteBody = checkMarkdownField("body", body.body, NOTE_BODY_MAX);
  if (typeof noteBody !== "string") return json({ error: noteBody.error }, noteBody.status);
  if (noteBody.trim() === "") {
    return json({ error: "`body` is required: a note says something" }, 400);
  }
  let taskId: string | null = null;
  if (body.task !== undefined && body.task !== null) {
    if (typeof body.task !== "string" || !TSK_ID_RE.test(body.task)) {
      return json({ error: "`task` must be a task id (tsk_…), or null" }, 400);
    }
    taskId = body.task;
  }

  try {
    const note = createNote(auth.workspaceId, project.id, taskId, noteBody, auth.userId);
    return json(noteJson(noteView(note)));
  } catch (err) {
    return refusal(err);
  }
}

/** The whole record, notes and status events merged chronologically. Same resolve
 *  posture as reading the project: a key that does not authenticate contributes
 *  nothing, and every denial is the same generic 404. */
export function handleListProjectNotes(req: Request, slug: string): Response {
  if (!SLUG_RE.test(slug)) return json({ error: "Not found" }, 404);
  const project = resolveProjectForRead(req, slug);
  if (project instanceof Response) return project;
  const trail = projectTrail(project, listNotes(project.id));
  return json(
    trail.map((entry) =>
      entry.kind === "note"
        ? {
            kind: "note",
            id: entry.id,
            task: entry.task,
            taskTitle: entry.taskTitle,
            body: entry.body,
            author: entry.author,
            createdAt: new Date(entry.createdAt).toISOString(),
          }
        : {
            kind: "event",
            task: entry.task,
            taskTitle: entry.taskTitle,
            from: entry.from,
            to: entry.to,
            createdAt: new Date(entry.createdAt).toISOString(),
          },
    ),
  );
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
