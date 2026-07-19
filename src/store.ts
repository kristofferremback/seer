import { unzipSync } from "fflate";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config";

const zipsDir = join(config.dataDir, "zips");
const cacheDir = join(config.dataDir, "cache");

mkdirSync(zipsDir, { recursive: true });
// Zips are the source of truth; the extraction cache is disposable, so start clean.
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });

export function zipPath(wsId: string, slug: string, version: number): string {
  return join(zipsDir, wsId, slug, `${version}.zip`);
}

function extractedDir(wsId: string, slug: string, version: number): string {
  return join(cacheDir, wsId, slug, String(version));
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
  mkdirSync(join(zipsDir, wsId, slug), { recursive: true });
  await Bun.write(zipPath(wsId, slug, version), data);
}

// ---- extraction cache with freshness bumping ----

const lastAccess = new Map<string, number>(); // "slug/version" -> ms
const inflight = new Map<string, Promise<string>>();

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
    const zip = await Bun.file(zipPath(wsId, slug, version)).bytes();
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
