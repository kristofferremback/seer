import { unzipSync } from "fflate";
import { S3Client, type BunFile, type S3File } from "bun";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config";

const zipsDir = join(config.dataDir, "zips");
const cacheDir = join(config.dataDir, "cache");
const imagesDir = join(config.dataDir, "images");

mkdirSync(zipsDir, { recursive: true });
mkdirSync(imagesDir, { recursive: true });
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
