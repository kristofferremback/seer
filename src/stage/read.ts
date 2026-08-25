import { sessionEmail, sessionUser } from "../auth";
import { isMember } from "../db";
import { json, originOk } from "../http";
import { SLUG_RE, STAGE_CHANGE_ID_RE, STF_ID_RE } from "../ids";
import { readableWorkspaces } from "../overseer/read";
import { softNotFoundPage } from "../pages";
import { openStageBlob } from "../store";
import { decodeStageText } from "./source";
import {
  getStage,
  getStageCaptureForWorkspaces,
  getStageVersion,
  setStageChangeRead,
  type StageCaptureFileRow,
  type StageCaptureInventory,
  type StageRow,
  type StageVersionRow,
} from "./db";

const MAX_LINE_SPAN = 400;
const MAX_LINE_BYTES = 512 * 1024;
const VERSION_RE = /^[1-9][0-9]{0,8}$/;

interface ResolvedStageVersion {
  workspaceId: string;
  stage: StageRow;
  version: StageVersionRow;
  inventory: StageCaptureInventory;
}

export class StageStoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageStoreUnavailable";
  }
}

export class StageStoreCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageStoreCorrupt";
  }
}

function resolveStageVersion(
  workspaceIds: string[],
  slug: string,
  rawVersion: string,
): ResolvedStageVersion | null {
  if (!SLUG_RE.test(slug) || !VERSION_RE.test(rawVersion)) return null;
  const number = Number(rawVersion);
  for (const workspaceId of workspaceIds) {
    const stage = getStage(workspaceId, slug);
    if (!stage || number > stage.latest_version) continue;
    const version = getStageVersion(workspaceId, slug, number);
    if (!version) continue;
    const inventory = getStageCaptureForWorkspaces(version.capture_id, [workspaceId]);
    if (inventory) return { workspaceId, stage, version, inventory };
  }
  return null;
}

export async function loadStageBytes(workspaceId: string, digest: string): Promise<Uint8Array> {
  let object: Awaited<ReturnType<typeof openStageBlob>>;
  try {
    object = await openStageBlob(workspaceId, digest);
  } catch (err) {
    throw new StageStoreUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (object === null) throw new StageStoreCorrupt(`Retained object ${digest} is missing.`);
  try {
    return new Uint8Array(await new Response(object).arrayBuffer());
  } catch (err) {
    throw new StageStoreUnavailable(err instanceof Error ? err.message : String(err));
  }
}

interface RetainedLineWindow {
  totalLines: number;
  lines: string[];
  tooLarge: boolean;
}

/** Scan all line boundaries for the total, but decode only the bounded requested window. */
export function retainedLineWindow(bytes: Uint8Array, start: number, end: number): RetainedLineWindow | null {
  if (decodeStageText(bytes) === null) return null;
  if (bytes.length === 0) return { totalLines: 0, lines: [], tooLarge: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lines: string[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  let totalLines = 0;
  let selectedBytes = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 10) continue;
    if (index === bytes.length && lineStart === bytes.length && bytes.at(-1) === 10) break;
    totalLines++;
    if (lineNumber >= start && lineNumber <= end) {
      selectedBytes += index - lineStart;
      if (selectedBytes <= MAX_LINE_BYTES) lines.push(decoder.decode(bytes.subarray(lineStart, index)));
    }
    lineStart = index + 1;
    lineNumber++;
  }
  return { totalLines, lines, tooLarge: selectedBytes > MAX_LINE_BYTES };
}

function softJson(): Response {
  return new Response(JSON.stringify({ error: "No such stage file" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function stageJson(value: unknown, status = 200): Response {
  const response = json(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function positive(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!VERSION_RE.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function sideDigest(file: StageCaptureFileRow, side: "old" | "new"): {
  availability: StageCaptureFileRow["old_availability"];
  digest: string | null;
  reason: string | null;
  path: string;
} {
  return side === "old"
    ? { availability: file.old_availability, digest: file.old_blob_sha, reason: file.old_reason, path: file.old_path ?? file.path }
    : { availability: file.new_availability, digest: file.new_blob_sha, reason: file.new_reason, path: file.path };
}

/** Read retained text only through a file id owned by this immutable version. */
export async function handleStageLines(
  req: Request,
  slug: string,
  rawVersion: string,
  fileId: string,
): Promise<Response> {
  if (!STF_ID_RE.test(fileId)) return softJson();
  let resolved: ResolvedStageVersion | null = null;
  let file: StageCaptureFileRow | null = null;
  for (const workspaceId of readableWorkspaces(req)) {
    const candidate = resolveStageVersion([workspaceId], slug, rawVersion);
    const candidateFile = candidate?.inventory.files.find((item) => item.id === fileId) ?? null;
    if (candidate && candidateFile) { resolved = candidate; file = candidateFile; break; }
  }
  if (!resolved || !file) return softJson();

  const params = new URL(req.url).searchParams;
  const side = params.get("side");
  if (side !== "old" && side !== "new") return stageJson({ error: "side must be old or new" }, 422);
  const start = positive(params.get("start"), 1);
  const end = positive(params.get("end"), (start ?? 1) + 199);
  if (start === null || end === null || end < start || end - start + 1 > MAX_LINE_SPAN) {
    return stageJson({ error: `line range must contain at most ${MAX_LINE_SPAN} positive lines` }, 422);
  }

  const selected = sideDigest(file, side);
  if (selected.availability !== "retained" || selected.digest === null) {
    return stageJson({ error: selected.reason ?? `${side} side is unavailable` }, 422);
  }
  try {
    const window = retainedLineWindow(await loadStageBytes(resolved.workspaceId, selected.digest), start, end);
    if (window === null) return stageJson({ error: `${side} side is binary` }, 422);
    if (window.tooLarge) return stageJson({ error: "requested lines exceed the retained-line response budget" }, 422);
    if (window.totalLines === 0) {
      if (start !== 1) return stageJson({ error: "start is beyond the retained file" }, 422);
      return stageJson({ fileId, path: selected.path, side, start: 0, end: 0, totalLines: 0, lines: [] });
    }
    if (start > window.totalLines) return stageJson({ error: "start is beyond the retained file" }, 422);
    const last = Math.min(end, window.totalLines);
    return stageJson({
      fileId,
      path: selected.path,
      side,
      start,
      end: last,
      totalLines: window.totalLines,
      lines: window.lines.map((text, index) => ({ number: start + index, text })),
    });
  } catch (err) {
    console.error(`[seer] retained lines failed for ${resolved.workspaceId}/${slug}/v/${rawVersion}/${fileId}:`, err);
    if (err instanceof StageStoreUnavailable) return stageJson({ error: "Stage storage is temporarily unavailable." }, 502);
    return stageJson({ error: "Stage storage is corrupt." }, 500);
  }
}

function softHtml(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

/** A personal member action. API keys cannot write somebody's reading history. */
export async function handleStageReadMutation(
  req: Request,
  workspaceId: string,
  slug: string,
  rawVersion: string,
  changeId: string,
): Promise<Response> {
  if (!originOk(req)) return new Response("Bad origin", { status: 403 });
  const user = sessionUser(req);
  if (!user || !isMember(workspaceId, user.id) || !STAGE_CHANGE_ID_RE.test(changeId)) return softHtml(req);
  const resolved = resolveStageVersion([workspaceId], slug, rawVersion);
  if (!resolved || !resolved.inventory.changes.some((change) => change.id === changeId)) return softHtml(req);
  const form = await req.formData().catch(() => null);
  if (form === null) return stageJson({ error: "Body must be form data." }, 400);
  const rawRead = form.get("read");
  if (rawRead !== "true" && rawRead !== "false") return stageJson({ error: "read must be true or false" }, 422);
  const read = rawRead === "true";
  setStageChangeRead(workspaceId, resolved.version.id, user.id, changeId, read);
  if ((req.headers.get("accept") ?? "").includes("application/json")) return stageJson({ changeId, read });
  const group = resolved.version.doc.witness.groups.find((candidate) =>
    candidate.members.some((member) => member.type === "change" && member.id === changeId),
  );
  if (!group) return softHtml(req);
  const params = new URLSearchParams({ review: group.id, change: changeId });
  return new Response(null, {
    status: 303,
    headers: {
      location: `/${workspaceId}/st/${slug}/v/${rawVersion}?${params}#${changeId}`,
      "cache-control": "no-store",
    },
  });
}
