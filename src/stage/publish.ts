import { createHash } from "node:crypto";
import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import { SLUG_RE, STG_ID_RE, tinyId } from "../ids";
import { getProject } from "../projects/db";
import {
  getStage,
  getStageCaptureForWorkspaces,
  getStageVersion,
  getStageVersionByCapture,
  type StageCaptureInventory,
  type StageRow,
  type StageVersionRow,
} from "./db";
import type { StageBuilderPacket } from "./packet";
import { validateStagePublish, type ValidatedStagePublish } from "./validate";
import type { StageDoc } from "./types";
import { readableWorkspaces } from "../overseer/read";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function narrative(doc: StageDoc | ValidatedStagePublish, builder: StageBuilderPacket): unknown {
  if ("identity" in doc) {
    return { captureId: doc.source.captureId, slug: doc.identity.slug, title: doc.identity.title, summary: doc.witness.summary, witness: doc.witness.agent, groups: doc.witness.groups, projects: doc.projects, builder };
  }
  return { captureId: doc.captureId, slug: doc.slug, title: doc.title, summary: doc.summary, witness: doc.witness, groups: doc.groups, projects: doc.projects, builder };
}

export class StagePublishError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 502, message: string) {
    super(message);
    this.name = "StagePublishError";
  }
}

function softNotFound(): Response {
  return new Response(JSON.stringify({ error: "No such stage" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function stageJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function stageView(stage: StageRow, version: StageVersionRow, latestVersion: number): unknown {
  return {
    id: stage.id,
    slug: stage.slug,
    workspace: stage.workspace_id,
    version: version.version,
    latestVersion,
    isLatest: version.version === latestVersion,
    url: `${config.baseUrl}/${stage.workspace_id}/st/${stage.slug}`,
    versionUrl: `${config.baseUrl}/${stage.workspace_id}/st/${stage.slug}/v/${version.version}`,
    apiUrl: `${config.baseUrl}/api/stages/${stage.slug}`,
    apiVersionUrl: `${config.baseUrl}/api/stages/${stage.slug}/v/${version.version}`,
    document: version.doc,
  };
}

function builderFor(inventory: StageCaptureInventory): StageBuilderPacket {
  const row = inventory.builder;
  if (!row || !row.user_id || !row.key_id) {
    throw new StagePublishError(422, "Capture has no builder packet with derived actor facts. Create a new capture with builder.intent, builder.context, and builder.agent.");
  }
  return { intent: row.intent, context: row.context, agent: { name: row.agent_name, model: row.agent_model } };
}

function resolveProjects(workspaceId: string, slugs: string[]): void {
  for (const slug of slugs) {
    if (!getProject(workspaceId, slug)) throw new StagePublishError(422, `No project "${slug}" in this workspace`);
  }
}

interface PublishArgs {
  workspaceId: string;
  userId: string;
  keyId: string;
  inventory: StageCaptureInventory;
  builder: StageBuilderPacket;
  input: ValidatedStagePublish;
}

const publish = db.transaction((args: PublishArgs): { stage: StageRow; version: StageVersionRow } => {
  const { workspaceId, userId, keyId, inventory, builder, input } = args;
  if (input.expectedPreviousVersion !== 0) throw new StagePublishError(409, "expectedPreviousVersion must be 0 for this slice");
  const existingByCapture = getStageVersionByCapture(workspaceId, inventory.capture.id);
  if (existingByCapture) {
    if (digest(narrative(existingByCapture.doc, builder)) !== digest(narrative(input, builder))) {
      throw new StagePublishError(409, `Capture ${inventory.capture.id} already published a different narrative`);
    }
    const existingStage = getStage(workspaceId, existingByCapture.slug);
    if (!existingStage) throw new Error(`Stage version ${existingByCapture.id} has no stage`);
    return { stage: existingStage, version: existingByCapture };
  }

  const occupied = getStage(workspaceId, input.slug);
  if (occupied) throw new StagePublishError(409, `Stage slug "${input.slug}" already names another stage`);
  resolveProjects(workspaceId, input.projects);
  const now = Date.now();
  const stageId = tinyId("sta");
  db.run(
    "INSERT INTO stages (id, workspace_id, slug, repo, repo_id, branch, lineage_base_ref, lineage_base_sha, latest_version, created_by_user_id, created_by_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    [stageId, workspaceId, input.slug, inventory.capture.repo, inventory.capture.repo_id, inventory.capture.branch, inventory.capture.base_ref, inventory.capture.merge_base_sha, userId, keyId, now, now],
  );
  const stage: StageRow = getStage(workspaceId, input.slug)!;
  const versionId = tinyId("stv");
  const doc: StageDoc = {
    identity: { id: stage.id, slug: stage.slug, version: 1, title: input.title, createdAt: new Date(now).toISOString() },
    source: {
      captureId: inventory.capture.id,
      repo: inventory.capture.repo,
      repoId: inventory.capture.repo_id,
      branch: inventory.capture.branch,
      baseRef: inventory.capture.base_ref,
      sourceHeadSha: inventory.capture.source_head_sha,
      baseTipSha: inventory.capture.base_tip_sha,
      mergeBaseSha: inventory.capture.merge_base_sha,
    },
    builder: { ...builder, userId: inventory.builder!.user_id!, keyId: inventory.builder!.key_id! },
    witness: { summary: input.summary, groups: input.groups, agent: input.witness, userId, keyId },
    projects: input.projects,
  };
  const docDigest = digest(doc);
  db.run(
    "INSERT INTO stage_versions (id, workspace_id, stage_id, slug, version, capture_id, doc, digest, witness_user_id, witness_key_id, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    [versionId, workspaceId, stage.id, stage.slug, inventory.capture.id, JSON.stringify(doc), docDigest, userId, keyId, now],
  );
  for (const slug of input.projects) {
    const project = getProject(workspaceId, slug)!;
    db.run(
      "INSERT OR IGNORE INTO project_stages (project_id, workspace_id, slug, created_at) VALUES (?, ?, ?, ?)",
      [project.id, workspaceId, input.slug, now],
    );
  }
  const version = getStageVersionByCapture(workspaceId, inventory.capture.id)!;
  return { stage, version };
});

export async function handlePublishStage(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  let body: unknown;
  try { body = await req.json(); } catch { return stageJson({ error: "Body is not valid JSON." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return stageJson({ error: "Body must be a JSON object." }, 400);
  const raw = body as Record<string, unknown>;
  if (typeof raw.captureId !== "string") return stageJson({ error: "captureId: is required" }, 422);
  if (!STG_ID_RE.test(raw.captureId)) return stageJson({ error: "No completed capture in this workspace" }, 404);
  const inventory = getStageCaptureForWorkspaces(raw.captureId, [auth.workspaceId]);
  if (!inventory) return stageJson({ error: "No completed capture in this workspace" }, 404);
  let builder: StageBuilderPacket;
  try { builder = builderFor(inventory); } catch (err) { return stageJson({ error: (err as Error).message }, 422); }
  const checked = validateStagePublish(body, inventory);
  if (checked.errors.length > 0 || !checked.value) return stageJson({ errors: checked.errors }, 422);
  try {
    resolveProjects(auth.workspaceId, checked.value.projects);
    const result = publish({ workspaceId: auth.workspaceId, userId: auth.userId, keyId: auth.keyId, inventory, builder, input: checked.value });
    return stageJson(stageView(result.stage, result.version, result.stage.latest_version));
  } catch (err) {
    if (err instanceof StagePublishError) return stageJson({ error: err.message }, err.status);
    if (err && typeof err === "object" && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return stageJson({ error: "Stage publication conflicted with an existing stage or capture." }, 409);
    }
    return stageJson({ error: "Stage publication failed." }, 502);
  }
}

function resolveStage(req: Request, slug: string): { stage: StageRow; version: StageVersionRow } | null {
  if (!SLUG_RE.test(slug)) return null;
  const ids = readableWorkspaces(req);
  for (const workspaceId of ids) {
    const stage = getStage(workspaceId, slug);
    if (stage) {
      const version = getStageVersion(workspaceId, slug, stage.latest_version);
      if (!version) continue;
      return { stage, version };
    }
  }
  return null;
}

export function handleReadStage(req: Request, slug: string, rawVersion: string | null): Response {
  if (!SLUG_RE.test(slug)) return softNotFound();
  const resolved = resolveStage(req, slug);
  if (!resolved) return softNotFound();
  const { stage } = resolved;
  let version = resolved.version;
  if (rawVersion !== null) {
    if (!/^[1-9][0-9]{0,8}$/.test(rawVersion) || Number(rawVersion) > stage.latest_version) return softNotFound();
    const pinned = getStageVersion(stage.workspace_id, slug, Number(rawVersion));
    if (!pinned) return softNotFound();
    version = pinned;
  }
  return stageJson(stageView(stage, version, stage.latest_version));
}
