import { unzipSync } from "fflate";
import { S3Client, type BunFile, type S3File } from "bun";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config";

const zipsDir = join(config.dataDir, "zips");
const cacheDir = join(config.dataDir, "cache");
const imagesDir = join(config.dataDir, "images");
const attachmentsDir = join(config.dataDir, "review-attachments");
const stageBlobsDir = join(config.dataDir, "stage-blobs");

mkdirSync(zipsDir, { recursive: true });
mkdirSync(imagesDir, { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });
mkdirSync(stageBlobsDir, { recursive: true });
// Zips are the source of truth; the extraction cache is disposable, so start clean.
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });

// ---- blob store ----

// Two backends behind one surface: S3 when configured (durable blobs live in the
// bucket; local disk holds only SQLite and the disposable extraction cache), plain
// disk otherwise (local dev, tests). Everything downstream — serving, extraction,
// upload — goes through these helpers and never branches on the backend itself.
export const s3: S3Client | null = config.s3
  ? new S3Client({
      bucket: config.s3.bucket,
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    })
  : null;

export function zipKey(wsId: string, slug: string, version: number): string {
  return `zips/${wsId}/${slug}/${version}.zip`;
}

export function imageKey(wsId: string, imageId: string): string {
  return `images/${wsId}/${imageId}`;
}

export function zipPath(wsId: string, slug: string, version: number): string {
  return join(zipsDir, wsId, slug, `${version}.zip`);
}

/** One entry's text, or null when the zip does not carry it. The lookup matches by
 *  NORMALIZED name, the same view inspectZip and extraction hold — some producers
 *  write `./index.html`, and matching raw names would miss what the served bundle
 *  carries. The filter also keeps fflate from decompressing every other entry a
 *  second time. Decoded as UTF-8; the caller only substring-searches, so a stray
 *  byte sequence is harmless. Null on a malformed archive rather than a throw: the
 *  caller treats it as absent, and the archive already passed inspectZip. */
export function readZipEntry(data: Uint8Array, name: string): string | null {
  try {
    const entries = unzipSync(data, { filter: (file) => normalize(file.name) === name });
    const key = Object.keys(entries)[0];
    if (key === undefined) return null;
    return new TextDecoder().decode(entries[key]!);
  } catch {
    return null;
  }
}

/** Validates zip contents and returns the sanitized file list. Throws on bad archives. */
export function inspectZip(data: Uint8Array): string[] {
  const entries = unzipSync(data);
  const files: string[] = [];
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    const clean = normalize(name);
    if (clean.startsWith("..") || clean.startsWith("/") || clean.includes("\0")) {
      throw new Error(`Unsafe path in zip: ${name}`);
    }
    void content;
    files.push(clean);
  }
  if (files.length === 0) throw new Error("Zip contains no files");
  return files;
}

export async function saveZip(
  wsId: string,
  slug: string,
  version: number,
  data: Uint8Array,
): Promise<void> {
  if (s3) {
    await s3.write(zipKey(wsId, slug, version), data);
    return;
  }
  mkdirSync(join(zipsDir, wsId, slug), { recursive: true });
  await Bun.write(zipPath(wsId, slug, version), data);
}

async function loadZip(wsId: string, slug: string, version: number): Promise<Uint8Array> {
  if (s3) return new Uint8Array(await s3.file(zipKey(wsId, slug, version)).arrayBuffer());
  return Bun.file(zipPath(wsId, slug, version)).bytes();
}

// ---- images ----

// Images are single blobs keyed by the img id alone; filename and content-type
// live in the db row. Serving always streams through Seer — an S3File is never
// handed to Response directly (that would redirect to a presigned AWS URL and
// give up our access control).
export function imagePath(wsId: string, imageId: string): string {
  return join(imagesDir, wsId, imageId);
}

export async function saveImage(wsId: string, imageId: string, data: Uint8Array): Promise<void> {
  if (s3) {
    await s3.write(imageKey(wsId, imageId), data);
    return;
  }
  mkdirSync(join(imagesDir, wsId), { recursive: true });
  await Bun.write(imagePath(wsId, imageId), data);
}

/** The image blob for serving, or null if it's missing from the store. */
export async function openImage(
  wsId: string,
  imageId: string,
): Promise<BunFile | ReadableStream<Uint8Array> | null> {
  if (s3) {
    const file: S3File = s3.file(imageKey(wsId, imageId));
    if (!(await file.exists())) return null;
    return file.stream();
  }
  const file: BunFile = Bun.file(imagePath(wsId, imageId));
  if (!(await file.exists())) return null;
  return file;
}

/** Where the image blob lives, for corruption logging. */
export function imageLocation(wsId: string, imageId: string): string {
  return s3 ? `s3://${config.s3!.bucket}/${imageKey(wsId, imageId)}` : imagePath(wsId, imageId);
}

// ---- review attachments ----

// Review attachments are single blobs keyed by the att id alone, exactly like
// images; media type, alt and caption live in the db row. Reviews are private to a
// workspace, so serving always streams through Seer and never hands out an S3File.
export function attachmentKey(wsId: string, attachmentId: string): string {
  return `review-attachments/${wsId}/${attachmentId}`;
}

export function attachmentPath(wsId: string, attachmentId: string): string {
  return join(attachmentsDir, wsId, attachmentId);
}

export async function saveAttachment(
  wsId: string,
  attachmentId: string,
  data: Uint8Array,
): Promise<void> {
  if (s3) {
    await s3.write(attachmentKey(wsId, attachmentId), data);
    return;
  }
  mkdirSync(join(attachmentsDir, wsId), { recursive: true });
  await Bun.write(attachmentPath(wsId, attachmentId), data);
}

/** The attachment blob for serving, or null if it's missing from the store. */
export async function openAttachment(
  wsId: string,
  attachmentId: string,
): Promise<BunFile | ReadableStream<Uint8Array> | null> {
  if (s3) {
    const file: S3File = s3.file(attachmentKey(wsId, attachmentId));
    if (!(await file.exists())) return null;
    return file.stream();
  }
  const file: BunFile = Bun.file(attachmentPath(wsId, attachmentId));
  if (!(await file.exists())) return null;
  return file;
}

/** Where the attachment blob lives, for corruption logging. */
export function attachmentLocation(wsId: string, attachmentId: string): string {
  return s3
    ? `s3://${config.s3!.bucket}/${attachmentKey(wsId, attachmentId)}`
    : attachmentPath(wsId, attachmentId);
}

// ---- staged capture blobs ----

/** Stage objects are durable, workspace-scoped, and addressed only by a server-computed
 * SHA-256. Readers stream them through Seer, never through a presigned store URL. */
export function stageBlobKey(workspaceId: string, sha256: string): string {
  return `stage-blobs/${workspaceId}/${sha256}`;
}

export function stageBlobPath(workspaceId: string, sha256: string): string {
  return join(stageBlobsDir, workspaceId, sha256);
}

export async function saveStageBlob(workspaceId: string, sha256: string, data: Uint8Array): Promise<void> {
  if (s3) {
    await s3.write(stageBlobKey(workspaceId, sha256), data);
    return;
  }
  mkdirSync(join(stageBlobsDir, workspaceId), { recursive: true });
  await Bun.write(stageBlobPath(workspaceId, sha256), data);
}

export async function openStageBlob(
  workspaceId: string,
  sha256: string,
): Promise<BunFile | ReadableStream<Uint8Array> | null> {
  if (s3) {
    const file: S3File = s3.file(stageBlobKey(workspaceId, sha256));
    if (!(await file.exists())) return null;
    return file.stream();
  }
  const file: BunFile = Bun.file(stageBlobPath(workspaceId, sha256));
  if (!(await file.exists())) return null;
  return file;
}

// ---- extraction cache with freshness bumping ----

const lastAccess = new Map<string, number>(); // "slug/version" -> ms
const inflight = new Map<string, Promise<string>>();

function extractedDir(wsId: string, slug: string, version: number): string {
  return join(cacheDir, wsId, slug, String(version));
}

/** Returns the extracted directory for a version, extracting from the zip if needed. Bumps freshness. */
export async function ensureExtracted(
  wsId: string,
  slug: string,
  version: number,
): Promise<string> {
  const key = `${wsId}/${slug}/${version}`;
  lastAccess.set(key, Date.now());

  const dir = extractedDir(wsId, slug, version);
  if (existsSync(dir)) return dir;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const zip = await loadZip(wsId, slug, version);
    const entries = unzipSync(zip);
    const tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [name, content] of Object.entries(entries)) {
      if (name.endsWith("/")) continue;
      const clean = normalize(name);
      if (clean.startsWith("..") || clean.startsWith("/")) continue;
      await Bun.write(join(tmp, clean), content);
    }
    mkdirSync(join(dir, ".."), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(tmp, dir);
    return dir;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/** Evict extracted dirs that haven't been touched within the TTL. Zips are never evicted. */
export function sweepCache(): void {
  const cutoff = Date.now() - config.cacheTtlMs;
  for (const [key, at] of lastAccess) {
    if (at >= cutoff) continue;
    const [wsId, slug, version] = key.split("/");
    // Per-entry guard: a filesystem error on one dir (e.g. a transient volume
    // I/O error) must not abort the sweep or bubble out of the interval and
    // kill the process. Log and move on.
    try {
      rmSync(extractedDir(wsId!, slug!, Number(version)), { recursive: true, force: true });
      lastAccess.delete(key);
    } catch (err) {
      console.error(`[seer] cache sweep failed to evict ${key}:`, err);
    }
  }
}

// Never let a throw inside the interval callback take down the server.
setInterval(() => {
  try {
    sweepCache();
  } catch (err) {
    console.error("[seer] cache sweep error:", err);
  }
}, 60_000);
