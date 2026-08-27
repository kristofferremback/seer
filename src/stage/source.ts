// Source capture is the first stage slice. GitHub is used only before publication:
// the tree walk proves completeness, while compare supplies patch and rename facts.
// After insertStageCapture commits, the JSON inventory and stage blobs are sufficient
// for every read and derivation. Blob writes deliberately happen before that transaction.
import { createHash } from "node:crypto";
import { requireApiKey } from "../auth";
import { config } from "../config";
import { hashKey, SLUG_RE, STG_ID_RE, tinyId } from "../ids";
import { json } from "../http";
import { openStageBlob, saveStageBlob } from "../store";
import { normalizeBuilderPacket, StagePacketError, type StageBuilderPacket } from "./packet";
import { githubClientFor, GithubRateLimitError } from "../overseer/github-app";
import { readableWorkspaces } from "../overseer/read";
import {
  assertPath,
  assertRef,
  assertRepo,
  GithubError,
  type GithubClient,
  type GithubCompare,
  type GithubFile,
  type GithubTreeEntry,
} from "../overseer/github";
import { lineDiff, parsePatch, splitUnifiedDiff, type PayloadLine } from "../overseer/diff";
import type { Hunk } from "../overseer/types";
import {
  freshFileId,
  freshIncompleteId,
  getStageCapture,
  getStageCaptureForWorkspaces,
  getStageIdempotency,
  insertStageCapture,
  StageIdempotencyConflict,
  type Availability,
  type CaptureInsert,
  type MaterialKind,
  type StageCaptureInventory,
} from "./db";

const MAX_KEY_LENGTH = 200;
const MAX_GITHUB_BLOB_BYTES = 100 * 1024 * 1024;
export interface StageCaptureRequest {
  slug: string;
  repo: string;
  branch: string;
  baseRef?: string;
  builder?: StageBuilderPacket;
}

export interface StageCaptureOptions {
  maxLogicalBytes?: number;
  /** Test seams for the two request ceilings. Production reads them from config, where
   *  they carry validated environment overrides; a fixture injects a small one so the
   *  cap it means to prove binds without a thousand-file tree. */
  maxBlobRequests?: number;
  maxGithubRequests?: number;
  client?: GithubClient;
  idempotencyKey?: string;
  requestHash?: string;
  builderUserId?: string;
  builderKeyId?: string;
  saveBlob?: typeof saveStageBlob;
  persist?: typeof insertStageCapture;
}

export class StageCaptureError extends Error {
  constructor(readonly status: 400 | 409 | 422 | 502, message: string) {
    super(message);
    this.name = "StageCaptureError";
  }
}

function softNotFound(): Response {
  return new Response(JSON.stringify({ error: "No such stage capture" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function stageJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function captureJson(inventory: StageCaptureInventory): Response {
  const { capture, files, changes, incomplete } = inventory;
  const response = json({
    id: capture.id,
    workspace: capture.workspace_id,
    slug: capture.slug,
    state: capture.state,
    repo: capture.repo,
    repoId: capture.repo_id,
    branch: capture.branch,
    baseRef: capture.base_ref,
    sourceHeadSha: capture.source_head_sha,
    baseTipSha: capture.base_tip_sha,
    mergeBaseSha: capture.merge_base_sha,
    patch: capture.patch_sha256 ? { sha256: capture.patch_sha256, available: true } : null,
    complete: incomplete.every((item) => item.kind !== "snapshot_incomplete" && item.kind !== "bytes_unavailable"),
    reviewable: incomplete.every((item) => item.kind !== "snapshot_incomplete" && item.kind !== "bytes_unavailable" && item.kind !== "lines_unavailable"),
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      oldPath: file.old_path,
      status: file.status,
      old: side(file, "old"),
      new: side(file, "new"),
      additions: file.additions,
      deletions: file.deletions,
      changes: changes.filter((change) => change.file_id === file.id).map(changeJson),
    })),
    incomplete: incomplete.map((item) => ({ id: item.id, kind: item.kind, path: item.path, side: item.side, reason: item.reason })),
    builder: inventory.builder ? {
      intent: inventory.builder.intent,
      context: inventory.builder.context,
      agent: { name: inventory.builder.agent_name, model: inventory.builder.agent_model },
      userId: inventory.builder.user_id,
      keyId: inventory.builder.key_id,
    } : null,
    createdAt: new Date(capture.created_at).toISOString(),
  }, 200, "application/json");
  response.headers.set("cache-control", "no-store");
  return response;
}

function side(file: StageCaptureInventory["files"][number], which: "old" | "new") {
  const prefix = which === "old" ? "old" : "new";
  return {
    objectId: file[`${prefix}_object_id`],
    mode: file[`${prefix}_mode`],
    kind: file[`${prefix}_kind`],
    availability: file[`${prefix}_availability`],
    blobSha256: file[`${prefix}_blob_sha`],
    reason: file[`${prefix}_reason`],
  };
}

function changeJson(change: StageCaptureInventory["changes"][number]) {
  return {
    id: change.id,
    old: { start: change.old_start, lines: change.old_lines },
    new: { start: change.new_start, lines: change.new_lines },
    oldFingerprint: change.old_fingerprint,
    newFingerprint: change.new_fingerprint,
    contextFingerprint: change.context_fingerprint,
    source: change.source,
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRequest(body: unknown, idempotencyKey: string | null): { input: StageCaptureRequest; requestHash: string } {
  if (!idempotencyKey || idempotencyKey.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    throw new StageCaptureError(400, "Idempotency-Key header is required and must be a short printable value.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StageCaptureError(400, "Body must be a JSON object.");
  const value = body as Record<string, unknown>;
  const allowed = new Set(["slug", "repo", "branch", "baseRef", "builder"]);
  const extra = Object.keys(value).find((name) => !allowed.has(name));
  if (extra) throw new StageCaptureError(400, `Unknown capture field ${JSON.stringify(extra)}.`);
  if (typeof value.slug !== "string" || !SLUG_RE.test(value.slug)) throw new StageCaptureError(400, "slug must match [a-z0-9][a-z0-9-]{0,63}.");
  if (typeof value.repo !== "string") throw new StageCaptureError(400, "repo is required and must be owner/name.");
  if (typeof value.branch !== "string" || value.branch.length === 0) throw new StageCaptureError(400, "branch is required.");
  const rawBaseRef = value.baseRef;
  if (rawBaseRef !== undefined && typeof rawBaseRef !== "string") throw new StageCaptureError(400, "baseRef must be a Git branch name.");
  const baseRef = rawBaseRef === undefined ? null : rawBaseRef;
  try {
    assertRepo(value.repo);
    assertRef(value.branch);
    if (baseRef !== null) assertRef(baseRef);
  } catch (err) {
    throw new StageCaptureError(400, err instanceof Error ? err.message : String(err));
  }
  let builder: StageBuilderPacket;
  try {
    builder = normalizeBuilderPacket(value.builder);
  } catch (err) {
    if (err instanceof StagePacketError) throw new StageCaptureError(422, err.message);
    throw err;
  }
  const input = { slug: value.slug, repo: value.repo, branch: value.branch, baseRef: baseRef ?? "", builder };
  return { input, requestHash: hashKey(stable(input)) };
}

type StageClient = Required<Pick<GithubClient, "getRepository" | "getRef" | "getTree" | "getBlobBytes" | "compare" | "compareDiff">>;
function stageClient(client: GithubClient): StageClient {
  if (!client.getRepository || !client.getRef || !client.getTree || !client.getBlobBytes || !client.compare || !client.compareDiff) {
    throw new StageCaptureError(502, "The routed GitHub client does not provide stage capture capabilities.");
  }
  return client as StageClient;
}

interface TreeResult { entries: GithubTreeEntry[]; incomplete: string | null; }

/** Git paths are ordered by Unicode code point, independent of the process locale. */
function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    if (leftPoints[index]! !== rightPoints[index]!) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

async function treeAt(client: StageClient, repo: string, sha: string, sideName: string): Promise<TreeResult> {
  try {
    const result = await client.getTree(repo, sha, true);
    for (const entry of result.tree) {
      if (entry.type === "blob" && (typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size < 0)) {
        throw new StageCaptureError(502, `GitHub returned a blob tree entry without a valid size for ${entry.path}.`);
      }
    }
    return {
      entries: result.tree.filter((entry) => entry.type !== "tree").sort((a, b) => compareCodePoints(a.path, b.path)),
      incomplete: result.truncated ? `GitHub truncated the ${sideName} commit tree; the path inventory is incomplete.` : null,
    };
  } catch (err) {
    throw new StageCaptureError(502, `GitHub refused the ${sideName} commit tree: ${message(err)}`);
  }
}

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }
export function decodeStageText(bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.slice(0, 8000).includes("\u0000") ? null : decoded;
  } catch {
    return null;
  }
}
function isText(bytes: Uint8Array): boolean { return decodeStageText(bytes) !== null; }
function text(bytes: Uint8Array): string {
  const decoded = decodeStageText(bytes);
  if (decoded === null) throw new Error("Retained bytes are not text.");
  return decoded;
}
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
function fingerprints(oldLines: string[], newLines: string[], context: string[]): { old: string; newer: string; context: string } {
  return { old: sha256(JSON.stringify(oldLines)), newer: sha256(JSON.stringify(newLines)), context: sha256(JSON.stringify(context)) };
}
function canonicalChanges(fileId: string, path: string, hunks: Hunk[], source: "patch" | "reconstructed") {
  return hunks.map((hunk) => {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.content);
    const newLines = hunk.lines.filter((line) => line.kind !== "del").map((line) => line.content);
    const context = hunk.lines.filter((line) => line.kind === "ctx").map((line) => line.content);
    const fp = fingerprints(oldLines, newLines, context);
    const canonical = { path, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, old: oldLines, newer: newLines, context };
    return {
      id: `chg_${sha256(stable(canonical))}`,
      capture_id: "",
      file_id: fileId,
      old_start: hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newStart,
      new_lines: hunk.newLines,
      old_fingerprint: fp.old,
      new_fingerprint: fp.newer,
      context_fingerprint: fp.context,
      source,
    };
  });
}
const MAX_RECONSTRUCTED_LINES = 12_000;

function reconstructedHunks(repo: string, path: string, headSha: string, oldText: string | null, newText: string | null): Hunk[] {
  const oldLines = oldText === null ? [] : linesOf(oldText);
  const newLines = newText === null ? [] : linesOf(newText);
  const rows: PayloadLine[] = oldText === null
    ? linesOf(newText ?? "").map((content) => ({ kind: "add" as const, content, wordRanges: [] }))
    : newText === null
      ? linesOf(oldText).map((content) => ({ kind: "del" as const, content, wordRanges: [] }))
      : lineDiff(oldText, newText);
  const oldCount = rows.filter((row) => row.kind !== "add").length;
  const newCount = rows.filter((row) => row.kind !== "del").length;
  let oldNo = oldCount === 0 ? 0 : 1;
  let newNo = newCount === 0 ? 0 : 1;
  return [{
    id: "",
    repo,
    prNumber: 0,
    path,
    sha: headSha,
    oldStart: oldCount === 0 ? 0 : 1,
    oldLines: oldLines.length,
    newStart: newCount === 0 ? 0 : 1,
    newLines: newLines.length,
    lines: rows.map((row) => ({ kind: row.kind, content: row.content, wordRanges: row.wordRanges,
      oldNo: row.kind === "add" ? null : oldNo++, newNo: row.kind === "del" ? null : newNo++ })),
  }];
}

interface Candidate { path: string; oldPath: string | null; old: GithubTreeEntry | null; newer: GithubTreeEntry | null; compare: GithubFile | null; }
interface ObjectState { bytes: Uint8Array | null; reason: string | null; retained: boolean; blobSha: string | null; declaredSize: number | null; skipped: boolean; }

function treeIncompleteFor(candidate: Candidate, oldTree: TreeResult, newTree: TreeResult): boolean {
  return (candidate.old === null && oldTree.incomplete !== null) || (candidate.newer === null && newTree.incomplete !== null);
}

interface ChangeDecision { hunks: Hunk[]; source: "patch" | "reconstructed" | null; reason: string | null; }
interface ChangeFileFacts {
  status: string;
  old_kind: string | null;
  new_kind: string | null;
  old_availability: Availability;
  new_availability: Availability;
  old_mode: string | null;
  new_mode: string | null;
  additions: number | null;
  deletions: number | null;
}

function compareLineChanges(file: ChangeFileFacts): boolean {
  return (file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0;
}

function missingLineChangesReason(file: ChangeFileFacts): string {
  return `GitHub compare reports ${file.additions ?? 0} additions and ${file.deletions ?? 0} deletions, but the canonical patch and retained textual sides could not represent those line changes.`;
}

function isMissingLineChangesReason(reason: string | null): boolean {
  return reason?.startsWith("GitHub compare reports ") ?? false;
}

function combineReason(sideReason: string | null, decisionReason: string | null, lineChangesUnrepresented: boolean): string | null {
  if (!sideReason || !decisionReason || !lineChangesUnrepresented) return sideReason ?? decisionReason;
  return sideReason.includes(decisionReason) ? sideReason : `${sideReason} ${decisionReason}`;
}

/** The one rule used at capture and re-derivation. It never guesses a line change
 * for a side that was not retained, and it bounds the quadratic line alignment. */
function chooseChange(file: ChangeFileFacts, path: string, patch: string | undefined, oldBytes: Uint8Array | null, newBytes: Uint8Array | null, repo: string, headSha: string): ChangeDecision {
  if (file.status === "mode_changed") return { hunks: [], source: null, reason: "Only the file mode changed, so there are no line changes." };
  if (file.old_mode === "120000" || file.new_mode === "120000") {
    return { hunks: [], source: null, reason: null };
  }
  if (file.old_kind === "commit" || file.new_kind === "commit") {
    return { hunks: [], source: null, reason: null };
  }
  if (patch !== undefined && file.new_kind === "blob") {
    const hunks = parsePatch(patch, { repo, prNumber: 0, path, sha: headSha });
    if (hunks.length > 0 || !compareLineChanges(file)) return { hunks, source: "patch", reason: null };
    return { hunks: [], source: null, reason: missingLineChangesReason(file) };
  }
  if (file.status === "renamed" && !compareLineChanges(file)) return { hunks: [], source: null, reason: null };
  const oldText = oldBytes && isText(oldBytes) ? text(oldBytes) : null;
  const newText = newBytes && isText(newBytes) ? text(newBytes) : null;
  if ((file.status === "modified" || file.status === "renamed") && oldText !== null && newText !== null) {
    if (oldBytes!.byteLength === newBytes!.byteLength && oldBytes!.every((byte, index) => byte === newBytes![index])) {
      return compareLineChanges(file)
        ? { hunks: [], source: null, reason: missingLineChangesReason(file) }
        : { hunks: [], source: null, reason: null };
    }
    if (linesOf(oldText).length + linesOf(newText).length > MAX_RECONSTRUCTED_LINES) {
      return { hunks: [], source: null, reason: compareLineChanges(file)
        ? `${missingLineChangesReason(file)} Text reconstruction exceeds the ${MAX_RECONSTRUCTED_LINES}-line alignment limit.`
        : `Text reconstruction exceeds the ${MAX_RECONSTRUCTED_LINES}-line alignment limit.` };
    }
    return { hunks: reconstructedHunks(repo, path, headSha, oldText, newText), source: "reconstructed", reason: null };
  }
  if (file.status === "added" && newText !== null && oldBytes === null) return { hunks: reconstructedHunks(repo, path, headSha, null, newText), source: "reconstructed", reason: null };
  if (file.status === "removed" && oldText !== null && newBytes === null) return { hunks: reconstructedHunks(repo, path, headSha, oldText, null), source: "reconstructed", reason: null };
  return { hunks: [], source: null, reason: compareLineChanges(file)
    ? missingLineChangesReason(file)
    : "Retained textual sides were not sufficient to reconstruct line changes." };
}

function compareFor(cmp: GithubCompare, path: string, oldPath: string | null): GithubFile | null {
  return cmp.files.find((file) => file.filename === path) ??
    cmp.files.find((file) => (oldPath !== null && file.filename === oldPath) || file.previous_filename === path || file.previous_filename === oldPath) ??
    null;
}

/**
 * What one capture may spend at GitHub, and how much of it may be in flight.
 *
 * Two ceilings rather than one, because they bound different things. The blob ceiling
 * bounds how much source a capture retains; the total bounds what the capture costs the
 * installation, and it counts the metadata calls too — repository, both refs, compare,
 * both trees, and the compare diff — so a capture cannot be "within budget" while
 * actually making a thousand-and-seven requests. At the defaults the total leaves 24
 * calls of headroom over the blob ceiling, which is why the metadata is free in practice
 * and the blob ceiling is the one that normally binds. Under an injected lower total the
 * order reverses and the total binds on its own.
 *
 * 1,000 blob requests is 20% of GitHub's shared 5,000-request hourly installation budget,
 * which is a real cost and the reason the ceiling exists at all rather than being a
 * defensive round number.
 *
 * Concurrency is separate from either budget: a 16-way pool keeps an ordinary capture
 * from scaling wall time linearly, stays well below GitHub's 100-concurrent-request
 * secondary limit, and each call keeps its own 20-second timeout. Retained-object writes
 * get their own pool of the same width for the same reason — a thousand sequential
 * awaits on the blob store is the other place a large capture goes quiet for minutes.
 * None of this claims a total wall-time bound.
 */
const STAGE_BLOB_CONCURRENCY = 16;
const STAGE_WRITE_CONCURRENCY = 16;

/** Machine-stable prefixes on a budget refusal, so a reader (or a test, or a later
 *  slice) can tell WHICH ceiling left an object out without parsing prose, while the
 *  prose still explains it to a person who has never heard of either. */
const BUDGET_BLOB_REQUESTS = "[budget:blob_requests]";
const BUDGET_GITHUB_REQUESTS = "[budget:github_requests]";
const BUDGET_LOGICAL_BYTES = "[budget:logical_bytes]";
const BUDGET_GITHUB_BLOB_CEILING = "[budget:github_blob_ceiling]";

/** Every known REST call a capture makes, counted as it is made. */
class RestBudget {
  spent = 0;
  constructor(readonly total: number) {}
  spend(calls = 1): void {
    if (this.spent + calls > this.total) {
      throw new StageCaptureError(400, `The stage capture GitHub-request limit must allow the 7 required metadata calls.`);
    }
    this.spent += calls;
  }
  get remaining(): number { return this.total - this.spent; }
}

function positiveLimit(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new StageCaptureError(400, `${name} must be a whole number of at least ${minimum} requests.`);
  }
  return value;
}

/**
 * GitHub throttling is not a fact about a blob.
 *
 * A primary or secondary rate-limit refusal aborts the capture instead of being written
 * onto the object that happened to be in flight when it arrived. Recording it per object
 * would turn one throttle into hundreds of `bytes_unavailable` rows that read exactly
 * like source GitHub does not have — an immutable, permanent-looking lie about a
 * transient condition, in the one record that is supposed to be trustworthy.
 */
function rateLimitRefusal(error: unknown): boolean {
  if (error instanceof GithubRateLimitError) return true;
  if (!(error instanceof GithubError)) return false;
  if (error.status === 429) return true;
  return error.status === 403 && /rate limit|secondary rate|abuse detection/i.test(error.message);
}

export async function captureSource(workspaceId: string, request: StageCaptureRequest, options: StageCaptureOptions = {}): Promise<{ captureId: string; created: boolean }> {
  if (!options.idempotencyKey) throw new StageCaptureError(400, "Idempotency-Key header is required.");
  if (request.builder !== undefined) {
    try {
      request = { ...request, builder: normalizeBuilderPacket(request.builder) };
    } catch (err) {
      if (err instanceof StagePacketError) throw new StageCaptureError(422, err.message);
      throw err;
    }
  }
  const client = stageClient(options.client ?? githubClientFor(workspaceId));
  const blobRequestLimit = positiveLimit("The stage capture blob-request limit", options.maxBlobRequests ?? config.stageBlobRequestLimit);
  const rest = new RestBudget(positiveLimit("The stage capture GitHub-request limit", options.maxGithubRequests ?? config.stageGithubRequestLimit, 7));
  let repo: Awaited<ReturnType<StageClient["getRepository"]>>;
  let sourceRef: Awaited<ReturnType<StageClient["getRef"]>>;
  let baseRefResult: Awaited<ReturnType<StageClient["getRef"]>>;
  let comparison: Awaited<ReturnType<StageClient["compare"]>>;
  try {
    rest.spend();
    repo = await client.getRepository(request.repo);
    if (repo.full_name.toLowerCase() !== request.repo.toLowerCase()) throw new StageCaptureError(422, `GitHub resolved ${request.repo} to a different repository, ${repo.full_name}.`);
    const baseRef = request.baseRef || repo.default_branch;
    assertRef(baseRef);
    rest.spend(2);
    [sourceRef, baseRefResult] = await Promise.all([client.getRef(request.repo, request.branch), client.getRef(request.repo, baseRef)]);
    rest.spend();
    comparison = await client.compare(request.repo, baseRefResult.sha, sourceRef.sha);
  } catch (err) {
    if (err instanceof StageCaptureError) throw err;
    if (err instanceof GithubError && err.status === 404) throw new StageCaptureError(422, `GitHub could not resolve the requested repository or ref: ${err.message}`);
    throw err;
  }
  const baseRef = request.baseRef || repo.default_branch;
  assertRef(baseRef);
  rest.spend(2);
  const [oldTree, newTree] = await Promise.all([
    treeAt(client, request.repo, comparison.merge_base_commit.sha, "merge-base"),
    treeAt(client, request.repo, sourceRef.sha, "source"),
  ]);

  const oldByPath = new Map(oldTree.entries.map((entry) => [entry.path, entry]));
  const newByPath = new Map(newTree.entries.map((entry) => [entry.path, entry]));
  const candidates: Candidate[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const file of comparison.files) {
    if (file.status !== "renamed" || !file.previous_filename) continue;
    const old = oldByPath.get(file.previous_filename) ?? null;
    const newer = newByPath.get(file.filename) ?? null;
    if (old && newer) {
      candidates.push({ path: file.filename, oldPath: file.previous_filename, old, newer, compare: file });
      usedOld.add(file.previous_filename); usedNew.add(file.filename);
    }
  }
  const paths = new Set([...oldByPath.keys(), ...newByPath.keys()]);
  for (const path of [...paths].sort(compareCodePoints)) {
    const old = usedOld.has(path) ? null : oldByPath.get(path) ?? null;
    const newer = usedNew.has(path) ? null : newByPath.get(path) ?? null;
    if (!old && !newer) continue;
    if (old && newer && old.sha === newer.sha && old.mode === newer.mode && old.type === newer.type) continue;
    candidates.push({ path, oldPath: null, old, newer, compare: compareFor(comparison, path, null) });
  }
  // If compare names a path that neither tree returned, keep its metadata visible and
  // say exactly why its object facts are unavailable.
  for (const file of comparison.files) {
    if (!candidates.some((candidate) => candidate.path === file.filename || candidate.oldPath === file.filename || candidate.oldPath === file.previous_filename)) {
      candidates.push({ path: file.filename, oldPath: file.previous_filename ?? null, old: null, newer: null, compare: file });
    }
  }
  candidates.sort((a, b) => compareCodePoints(a.path, b.path) || compareCodePoints(a.oldPath ?? "", b.oldPath ?? ""));

  const limit = options.maxLogicalBytes ?? config.maxUploadBytes;
  if (!Number.isFinite(limit) || limit < 0) throw new StageCaptureError(400, "The stage capture retention limit must be a non-negative number.");
  const captureId = tinyId("stg");
  let rawPatch: string | null = null;
  let patchReason: string | null = null;
  rest.spend();
  try { rawPatch = await client.compareDiff(request.repo, comparison.merge_base_commit.sha, sourceRef.sha); }
  catch (err) {
    if (rateLimitRefusal(err)) throw err;
    patchReason = `GitHub did not provide the pinned unified compare diff: ${message(err)}`;
  }
  const rawPatchBytes = rawPatch === null ? null : new TextEncoder().encode(rawPatch);
  const rawPatches = rawPatch && rawPatchBytes && rawPatchBytes.byteLength <= limit ? splitUnifiedDiff(rawPatch) : new Map<string, string>();
  let used = 0;
  const patchSha = rawPatchBytes && rawPatchBytes.byteLength <= limit ? sha256(rawPatchBytes) : null;
  if (rawPatchBytes && patchSha) used += rawPatchBytes.byteLength;
  else if (rawPatchBytes) patchReason = `The pinned unified compare diff is ${rawPatchBytes.byteLength} logical bytes, over the ${limit}-byte capture budget.`;

  const objectState = new Map<string, ObjectState>();
  const orderedObjects: { id: string; path: string; side: "old" | "new"; entry: GithubTreeEntry }[] = [];
  for (const candidate of candidates) for (const [sideName, entry] of [["old", candidate.old], ["new", candidate.newer]] as const) {
    if (!entry || entry.type !== "blob") continue;
    const previous = objectState.get(entry.sha);
    if (previous) {
      if (previous.declaredSize !== null && entry.size !== undefined && previous.declaredSize !== entry.size) throw new StageCaptureError(502, `Git tree reported conflicting sizes for object ${entry.sha}.`);
      if (previous.declaredSize === null && entry.size !== undefined) previous.declaredSize = entry.size;
      continue;
    }
    orderedObjects.push({ id: entry.sha, path: candidate.path, side: sideName, entry });
    objectState.set(entry.sha, { bytes: null, reason: null, retained: false, blobSha: null, declaredSize: entry.size ?? null, skipped: false });
  }
  orderedObjects.sort((a, b) => compareCodePoints(a.path, b.path) || (a.side === "old" ? -1 : 1));
  const eligibleObjects: typeof orderedObjects = [];
  for (const object of orderedObjects) {
    const state = objectState.get(object.id)!;
    if (state.declaredSize !== null && state.declaredSize > MAX_GITHUB_BLOB_BYTES) {
      state.skipped = true;
      state.reason = `${BUDGET_GITHUB_BLOB_CEILING} GitHub's Git blob API ceiling is ${MAX_GITHUB_BLOB_BYTES} bytes; the tree declares ${state.declaredSize} bytes.`;
    } else if (state.declaredSize !== null && used + state.declaredSize > limit) {
      state.skipped = true;
      state.reason = `${BUDGET_LOGICAL_BYTES} The capture's retained logical-byte budget is ${limit}; deterministic retention order left this ${state.declaredSize}-byte object out.`;
    } else {
      eligibleObjects.push(object);
      if (state.declaredSize !== null) used += state.declaredSize;
    }
  }
  // Both ceilings decide here, before any blob request goes out, so which one bound is
  // a fact about the capture rather than about how far it got. The tighter one wins, and
  // the objects it leaves out say which one it was.
  const restAllowance = rest.remaining;
  const blobAllowance = Math.min(blobRequestLimit, restAllowance);
  const boundByRest = restAllowance < blobRequestLimit;
  const fetchObjects = eligibleObjects.slice(0, blobAllowance);
  for (const object of eligibleObjects.slice(blobAllowance)) {
    const state = objectState.get(object.id)!;
    state.skipped = true;
    state.reason = boundByRest
      ? `${BUDGET_GITHUB_REQUESTS} The capture permits at most ${rest.total} GitHub REST calls in total, of which ${rest.spent} were spent resolving the repository, refs, compare, trees, and pinned diff; this object was outside the first ${blobAllowance} eligible objects in deterministic retention order.`
      : `${BUDGET_BLOB_REQUESTS} The capture permits at most ${blobRequestLimit} unique Git blob requests; this object was outside the first ${blobAllowance} eligible objects in deterministic retention order.`;
  }
  rest.spend(fetchObjects.length);
  const fetched = new Map<string, { bytes: Uint8Array | null; error: unknown }>();
  let nextObject = 0;
  let throttled: unknown = null;
  async function fetchWorker(): Promise<void> {
    while (nextObject < fetchObjects.length && throttled === null) {
      const object = fetchObjects[nextObject++]!;
      try {
        fetched.set(object.id, { bytes: await client.getBlobBytes(request.repo, object.id), error: null });
      } catch (error) {
        if (rateLimitRefusal(error)) throttled = error;
        fetched.set(object.id, { bytes: null, error });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAGE_BLOB_CONCURRENCY, fetchObjects.length) }, () => fetchWorker()));
  if (throttled !== null) throw throttled;
  // Declared sizes made the byte decisions before any request. Reconcile responses in
  // deterministic order so actual bytes and error handling never depend on completion order.
  used = patchSha ? rawPatchBytes!.byteLength : 0;
  for (const object of fetchObjects) {
    const state = objectState.get(object.id)!;
    const result = fetched.get(object.id)!;
    if (result.error) {
      if (result.error instanceof StageCaptureError) throw result.error;
      state.reason = `GitHub did not retain this Git blob: ${message(result.error)}`;
      continue;
    }
    state.bytes = result.bytes;
    if (!state.bytes) {
      state.reason = "GitHub did not provide this Git blob.";
      continue;
    }
    if (state.declaredSize !== null && state.bytes.byteLength !== state.declaredSize) {
      throw new StageCaptureError(502, `Git tree declared ${state.declaredSize} bytes for ${object.id}, but GitHub returned ${state.bytes.byteLength}.`);
    }
    if (used + state.bytes.byteLength > limit) {
      state.bytes = null;
      state.skipped = true;
      state.reason = `${BUDGET_LOGICAL_BYTES} The capture's retained logical-byte budget is ${limit}; deterministic retention order left this object out.`;
      continue;
    }
    state.retained = true; state.blobSha = sha256(state.bytes); used += state.bytes.byteLength;
  }

  const blobs = new Map<string, Uint8Array>();
  for (const state of objectState.values()) if (state.retained && state.bytes && state.blobSha) blobs.set(state.blobSha, state.bytes);
  const fileRows: CaptureInsert["files"] = [];
  const changes: CaptureInsert["changes"] = [];
  const incomplete: CaptureInsert["incomplete"] = [];
  if (oldTree.incomplete) incomplete.push({ id: freshIncompleteId(), workspace_id: workspaceId, capture_id: captureId, kind: "snapshot_incomplete", path: null, side: "snapshot", reason: oldTree.incomplete });
  if (newTree.incomplete) incomplete.push({ id: freshIncompleteId(), workspace_id: workspaceId, capture_id: captureId, kind: "snapshot_incomplete", path: null, side: "snapshot", reason: newTree.incomplete });
  if (comparison.files.length >= 300) incomplete.push({ id: freshIncompleteId(), workspace_id: workspaceId, capture_id: captureId, kind: "metadata_incomplete", path: null, side: "snapshot", reason: "GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist." });
  if (patchReason) incomplete.push({ id: freshIncompleteId(), workspace_id: workspaceId, capture_id: captureId, kind: "patch_unavailable", path: null, side: "snapshot", reason: patchReason });

  for (const candidate of candidates) {
    const fileId = freshFileId();
    const compare = candidate.compare;
      const compareStatus = compare?.status;
    const knownCompareStatus = compareStatus === "added" || compareStatus === "removed" || compareStatus === "modified" || (compareStatus === "renamed" && candidate.oldPath !== null);
    const status = compareStatus === "renamed" && candidate.oldPath ? "renamed" : candidate.old && candidate.newer && candidate.old.sha === candidate.newer.sha && candidate.old.mode !== candidate.newer.mode ? "mode_changed" : knownCompareStatus ? compareStatus : candidate.old && candidate.newer ? "modified" : treeIncompleteFor(candidate, oldTree, newTree) ? "unknown" : candidate.old ? "removed" : "added";
    const makeSide = (entry: GithubTreeEntry | null, sideName: "old" | "new"): { availability: Availability; blob: string | null; reason: string | null } => {
      if (!entry) {
        const compareEstablishesAbsence = (sideName === "old" && (status === "added" || status === "renamed")) || (sideName === "new" && (status === "removed" || status === "renamed"));
        if (compareEstablishesAbsence || !treeIncompleteFor(candidate, oldTree, newTree)) return { availability: "not_applicable", blob: null, reason: null };
        return { availability: "unavailable", blob: null, reason: `The ${sideName} tree was truncated before this path could be established.` };
      }
      if (entry.type !== "blob") return entry.type === "commit"
        ? { availability: "not_applicable", blob: null, reason: "The submodule commit id is retained, but line changes are not represented for submodules." }
        : { availability: "unavailable", blob: null, reason: "This tree object has no file bytes." };
      const state = objectState.get(entry.sha)!;
      if (!state.bytes) return { availability: "unavailable", blob: null, reason: state.reason ?? "GitHub did not provide this Git blob." };
      if (!state.retained) return { availability: "unavailable", blob: null, reason: state.reason ?? "The Git blob was outside the retention budget." };
      return { availability: "retained", blob: state.blobSha, reason: null };
    };
    const oldSide = makeSide(candidate.old, "old"), newSide = makeSide(candidate.newer, "new");
    const oldBytes = candidate.old?.type === "blob" && oldSide.availability === "retained" ? objectState.get(candidate.old.sha)!.bytes : null;
    const newBytes = candidate.newer?.type === "blob" && newSide.availability === "retained" ? objectState.get(candidate.newer.sha)!.bytes : null;
    const patch = patchSha ? rawPatches.get(candidate.path) : undefined;
    const facts: ChangeFileFacts = { status, old_kind: candidate.old?.type ?? null, new_kind: candidate.newer?.type ?? null, old_availability: oldSide.availability, new_availability: newSide.availability, old_mode: candidate.old?.mode ?? null, new_mode: candidate.newer?.mode ?? null, additions: compare?.additions ?? null, deletions: compare?.deletions ?? null };
    const decision = chooseChange(facts, candidate.path, patch, oldBytes, newBytes, request.repo, sourceRef.sha);
    const hunks = decision.hunks;
    const source = decision.source;
    const derivedAdds = hunks.reduce((n, h) => n + h.lines.filter((line) => line.kind === "add").length, 0);
    const derivedDels = hunks.reduce((n, h) => n + h.lines.filter((line) => line.kind === "del").length, 0);
    const oldSideReason = oldSide.reason ?? (candidate.old?.mode === "120000" ? "The symlink target is retained, but line changes are not represented for symlinks." : candidate.old?.type === "blob" && objectState.get(candidate.old.sha)?.bytes && !isText(objectState.get(candidate.old.sha)!.bytes!) ? "Binary bytes are retained, but line changes are unavailable." : null);
    const newSideReason = newSide.reason ?? (candidate.newer?.mode === "120000" ? "The symlink target is retained, but line changes are not represented for symlinks." : candidate.newer?.type === "blob" && objectState.get(candidate.newer.sha)?.bytes && !isText(objectState.get(candidate.newer.sha)!.bytes!) ? "Binary bytes are retained, but line changes are unavailable." : null);
    const lineChangesUnrepresented = compareLineChanges(facts) && isMissingLineChangesReason(decision.reason);
    const oldReason = combineReason(oldSideReason, decision.reason, lineChangesUnrepresented);
    const newReason = combineReason(newSideReason, decision.reason, lineChangesUnrepresented);
    const additions = compare?.additions ?? derivedAdds;
    const deletions = compare?.deletions ?? derivedDels;
    fileRows.push({ id: fileId, path: candidate.path, old_path: candidate.oldPath, status, old_object_id: candidate.old?.sha ?? null, new_object_id: candidate.newer?.sha ?? null, old_mode: candidate.old?.mode ?? null, new_mode: candidate.newer?.mode ?? null, old_kind: candidate.old?.type ?? null, new_kind: candidate.newer?.type ?? null, additions, deletions, old_availability: oldSide.availability, new_availability: newSide.availability, old_blob_sha: oldSide.blob, new_blob_sha: newSide.blob, old_reason: oldReason, new_reason: newReason });
    if (source) changes.push(...canonicalChanges(fileId, candidate.path, hunks, source).map((change) => ({ ...change, workspace_id: workspaceId, capture_id: captureId })));
    const addMaterial = (sideName: "old" | "new", availability: Availability, reason: string | null) => {
      if (!reason) return;
      const kind: MaterialKind = availability === "unavailable" ? "bytes_unavailable" : "lines_unavailable";
      incomplete.push({ id: freshIncompleteId(), workspace_id: workspaceId, capture_id: captureId, kind, path: candidate.path, side: sideName, reason });
    };
    addMaterial("old", oldSide.availability, oldReason);
    addMaterial("new", newSide.availability, newReason);
  }
  const writeBlob = options.saveBlob ?? saveStageBlob;
  // A thousand retained objects written one await at a time is the other place a large
  // capture disappears for minutes. The pool is the same width as the fetch pool, and a
  // failure is reported by lowest retention index rather than by whichever worker lost
  // the race, so the same broken store fails the same capture the same way every time.
  const writes = [...blobs];
  const writeErrors = new Map<number, unknown>();
  let nextWrite = 0;
  const writeWorker = async (): Promise<void> => {
    while (nextWrite < writes.length && writeErrors.size === 0) {
      const index = nextWrite++;
      const [digest, bytes] = writes[index]!;
      try {
        await writeBlob(workspaceId, digest, bytes);
      } catch (error) {
        writeErrors.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAGE_WRITE_CONCURRENCY, writes.length) }, writeWorker));
  if (writeErrors.size > 0) throw writeErrors.get(Math.min(...writeErrors.keys()));
  if (rawPatchBytes && patchSha) {
    await writeBlob(workspaceId, patchSha, rawPatchBytes);
    blobs.set(patchSha, rawPatchBytes);
  }
  const persist = options.persist ?? insertStageCapture;
  const result = persist({ capture: { id: captureId, workspace_id: workspaceId, slug: request.slug, repo: repo.full_name, repo_id: repo.id, branch: request.branch, base_ref: baseRef, source_head_sha: sourceRef.sha, base_tip_sha: baseRefResult.sha, merge_base_sha: comparison.merge_base_commit.sha, patch_sha256: patchSha }, requestHash: options.requestHash ?? hashKey(stable({ slug: request.slug, repo: request.repo, branch: request.branch, baseRef: request.baseRef ?? "", builder: request.builder ?? null })), idempotencyKey: options.idempotencyKey, files: fileRows, changes, incomplete,
    blobs: [...blobs].map(([sha256, data]) => ({ sha256, bytes: data.byteLength })),
    ...(request.builder ? { builder: { intent: request.builder.intent, context: request.builder.context, agent_name: request.builder.agent.name, agent_model: request.builder.agent.model, user_id: options.builderUserId ?? null, key_id: options.builderKeyId ?? null } } : {}), });
  return result;
}

/** One renderer hunk paired to the persisted identity it must reproduce. */
export interface MaterializedStageChange {
  change: StageCaptureInventory["changes"][number];
  hunk: Hunk;
}

export class StageMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageMaterializationError";
  }
}

function sameCanonicalChange(
  stored: StageCaptureInventory["changes"][number],
  derived: ReturnType<typeof canonicalChanges>[number],
): boolean {
  return stored.id === derived.id && stored.file_id === derived.file_id &&
    stored.old_start === derived.old_start && stored.old_lines === derived.old_lines &&
    stored.new_start === derived.new_start && stored.new_lines === derived.new_lines &&
    stored.old_fingerprint === derived.old_fingerprint &&
    stored.new_fingerprint === derived.new_fingerprint &&
    stored.context_fingerprint === derived.context_fingerprint && stored.source === derived.source;
}

/** Materialize the renderer lines and prove they reproduce every persisted identity.
 * The loader is the durable-storage seam; GitHub is not an allowed input. */
export async function materializeCanonicalChanges(
  inventory: StageCaptureInventory,
  loadBlob: (sha256: string) => Promise<Uint8Array | null>,
): Promise<MaterializedStageChange[]> {
  const changedFileIds = new Set(inventory.changes.map((change) => change.file_id));
  const reconstructedFileIds = new Set(inventory.changes.filter((change) => change.source === "reconstructed").map((change) => change.file_id));
  const changedFiles = inventory.files.filter((file) => changedFileIds.has(file.id));
  const patches = new Map<string, string>();
  if (inventory.capture.patch_sha256) {
    const bytes = await loadBlob(inventory.capture.patch_sha256);
    if (!bytes) throw new StageMaterializationError(`Retained canonical patch ${inventory.capture.patch_sha256} is missing.`);
    try {
      for (const [path, patch] of splitUnifiedDiff(text(bytes))) patches.set(path, patch);
    } catch (err) {
      throw new StageMaterializationError(`Retained canonical patch is corrupt: ${message(err)}`);
    }
  }

  const needsBytes = new Set(changedFiles.filter((file) =>
    !patches.has(file.path) || reconstructedFileIds.has(file.id)
  ).map((file) => file.id));
  const digests = [...new Set(changedFiles.filter((file) => needsBytes.has(file.id))
    .flatMap((file) => [file.old_blob_sha, file.new_blob_sha])
    .filter((digest): digest is string => digest !== null))];
  const retained = new Map<string, Uint8Array | null>();
  let next = 0;
  const worker = async () => {
    while (next < digests.length) {
      const digest = digests[next++]!;
      retained.set(digest, await loadBlob(digest));
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, digests.length) }, worker));

  const made = new Map<string, MaterializedStageChange>();
  for (const file of changedFiles) {
    const oldBytes = file.old_blob_sha && needsBytes.has(file.id) ? retained.get(file.old_blob_sha) ?? null : null;
    const newBytes = file.new_blob_sha && needsBytes.has(file.id) ? retained.get(file.new_blob_sha) ?? null : null;
    if (needsBytes.has(file.id) && file.old_blob_sha && !oldBytes) throw new StageMaterializationError(`Retained old blob for ${file.path} is missing.`);
    if (needsBytes.has(file.id) && file.new_blob_sha && !newBytes) throw new StageMaterializationError(`Retained new blob for ${file.path} is missing.`);
    let decision: ChangeDecision;
    try {
      decision = chooseChange({ status: file.status, old_kind: file.old_kind, new_kind: file.new_kind, old_availability: file.old_availability, new_availability: file.new_availability, old_mode: file.old_mode, new_mode: file.new_mode, additions: file.additions, deletions: file.deletions }, file.path, patches.get(file.path), oldBytes, newBytes, inventory.capture.repo, inventory.capture.source_head_sha);
    } catch (err) {
      throw new StageMaterializationError(`Retained material for ${file.path} is corrupt: ${message(err)}`);
    }
    if (!decision.source) throw new StageMaterializationError(`Retained material no longer produces the changes stored for ${file.path}.`);
    const identities = canonicalChanges(file.id, file.path, decision.hunks, decision.source);
    for (let index = 0; index < identities.length; index++) {
      const identity = identities[index]!;
      const stored = inventory.changes.find((change) => change.id === identity.id);
      if (!stored || !sameCanonicalChange(stored, identity)) {
        throw new StageMaterializationError(`Retained material does not reproduce canonical change ${identity.id}.`);
      }
      made.set(stored.id, { change: stored, hunk: decision.hunks[index]! });
    }
  }
  if (made.size !== inventory.changes.length) {
    throw new StageMaterializationError("Retained material does not reproduce every canonical change.");
  }
  return inventory.changes.map((change) => made.get(change.id)!);
}

/** Re-derive canonical anchors using only the stored patch and retained blobs. */
export async function rederiveCanonicalChanges(
  inventory: StageCaptureInventory,
  loadBlob: (sha256: string) => Promise<Uint8Array | null>,
): Promise<StageCaptureInventory["changes"]> {
  return (await materializeCanonicalChanges(inventory, loadBlob)).map(({ change }) => change);
}

export async function handleCreateStageCapture(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  let body: unknown;
  try { body = await req.json(); } catch { return stageJson({ error: "Body is not valid JSON." }, 400); }
  const key = req.headers.get("idempotency-key")?.trim() ?? null;
  try {
    const parsed = readRequest(body, key);
    const existing = getStageIdempotency(auth.workspaceId, key!);
    if (existing) {
      if (existing.request_hash !== parsed.requestHash) throw new StageIdempotencyConflict();
      const inventory = getStageCapture(existing.capture_id, auth.workspaceId);
      if (!inventory) throw new Error(`Idempotency row points to missing stage capture ${existing.capture_id}.`);
      return captureJson(inventory);
    }
    const result = await captureSource(auth.workspaceId, parsed.input, {
      client: githubClientFor(auth.workspaceId, auth.userId),
      idempotencyKey: key!,
      requestHash: parsed.requestHash,
      builderUserId: auth.userId,
      builderKeyId: auth.keyId,
    });
    const inventory = getStageCapture(result.captureId, auth.workspaceId);
    return inventory ? captureJson(inventory) : stageJson({ error: "Capture was not written." }, 502);
  } catch (err) {
    if (err instanceof StageIdempotencyConflict) return stageJson({ error: err.message }, 409);
    if (err instanceof StageCaptureError) return stageJson({ error: err.message }, err.status);
    if (err instanceof GithubError) return stageJson({ error: err.message }, err.status === 422 ? 422 : 502);
    return stageJson({ error: message(err) }, 502);
  }
}

export function handleReadStageCapture(req: Request, id: string): Response {
  const workspaces = readableWorkspaces(req);
  if (!STG_ID_RE.test(id)) return softNotFound();
  const inventory = getStageCaptureForWorkspaces(id, workspaces);
  return inventory ? captureJson(inventory) : softNotFound();
}

/** Serve one retained capture object through Seer. The inventory is the authorization
 * boundary: a digest that merely exists in the workspace is not enough to open it. */
export async function handleReadStageObject(req: Request, id: string, digest: string, loadBlob: typeof openStageBlob = openStageBlob): Promise<Response> {
  const workspaces = readableWorkspaces(req);
  if (!STG_ID_RE.test(id) || !/^[a-f0-9]{64}$/.test(digest)) return softNotFound();
  const inventory = getStageCaptureForWorkspaces(id, workspaces);
  if (!inventory) return softNotFound();

  const named = inventory.capture.patch_sha256 === digest || inventory.files.some((file) => file.old_blob_sha === digest || file.new_blob_sha === digest);
  if (!named) return softNotFound();

  let object: Awaited<ReturnType<typeof openStageBlob>>;
  try {
    object = await loadBlob(inventory.capture.workspace_id, digest);
  } catch (error) {
    console.error(`[seer] stage capture ${id} object ${digest} could not be opened:`, error);
    return new Response(JSON.stringify({ error: "Stage capture storage is temporarily unavailable." }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (object === null) {
    console.error(`[seer] stage capture ${id} names missing object ${digest}`);
    return new Response(JSON.stringify({ error: "Stage capture storage corruption." }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response(object, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
