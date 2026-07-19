import { existsSync } from "node:fs";
import { config } from "./config";
import { db, getMeta, setMeta } from "./db";
import { s3, imageKey, imagePath, zipKey, zipPath } from "./store";

// One-time blob migration: copy every bundle zip and image from local disk into
// S3. Runs at boot (before the server binds) whenever S3 is configured and the
// meta marker for this bucket isn't set yet; on a fresh deployment it sees zero
// rows and just writes the marker.
//
// Idempotent and crash-safe: blobs already present in S3 with the right size are
// skipped, the marker is written only after every blob is accounted for, and a
// crash mid-run re-enters cleanly. Local files are left in place (the volume can
// be detached once the migration has been verified); a blob missing from BOTH
// disk and S3 fails the boot loudly — serving from S3 would 404 content the db
// says exists, and that's corruption to surface, not paper over.

const CONCURRENCY = 8;

interface Blob {
  label: string;
  localPath: string;
  s3Key: string;
  bytes: number;
}

function allBlobs(): Blob[] {
  const versions = db
    .query<{ workspace_id: string; slug: string; version: number; bytes: number }, []>(
      "SELECT workspace_id, slug, version, bytes FROM versions",
    )
    .all();
  const images = db
    .query<{ id: string; workspace_id: string; bytes: number }, []>(
      "SELECT id, workspace_id, bytes FROM images",
    )
    .all();
  return [
    ...versions.map((v) => ({
      label: `zip ${v.workspace_id}/${v.slug}/v${v.version}`,
      localPath: zipPath(v.workspace_id, v.slug, v.version),
      s3Key: zipKey(v.workspace_id, v.slug, v.version),
      bytes: v.bytes,
    })),
    ...images.map((i) => ({
      label: `image ${i.workspace_id}/${i.id}`,
      localPath: imagePath(i.workspace_id, i.id),
      s3Key: imageKey(i.workspace_id, i.id),
      bytes: i.bytes,
    })),
  ];
}

async function migrateOne(blob: Blob): Promise<"uploaded" | "skipped"> {
  const stat = await s3!.stat(blob.s3Key).catch(() => null);
  if (stat && stat.size === blob.bytes) return "skipped";
  if (!existsSync(blob.localPath)) {
    if (stat) return "skipped"; // in S3 with a size the db doesn't know; trust the blob
    throw new Error(`${blob.label}: missing from both ${blob.localPath} and s3://${blob.s3Key}`);
  }
  await s3!.write(blob.s3Key, Bun.file(blob.localPath));
  return "uploaded";
}

export async function migrateBlobsToS3(): Promise<void> {
  if (!s3) return;
  const marker = `s3:${config.s3!.bucket}`;
  if (getMeta("blob_store") === marker) return;

  const blobs = allBlobs();
  console.log(`[seer] blob migration: moving ${blobs.length} blob(s) to ${marker} ...`);

  let uploaded = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (let i = 0; i < blobs.length; i += CONCURRENCY) {
    const batch = blobs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(migrateOne));
    for (const r of results) {
      if (r.status === "fulfilled") r.value === "uploaded" ? uploaded++ : skipped++;
      else failures.push(String(r.reason));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[seer] blob migration failed for ${failures.length}/${blobs.length} blob(s):\n` +
        failures.join("\n"),
    );
  }

  setMeta("blob_store", marker);
  console.log(
    `[seer] blob migration complete: ${uploaded} uploaded, ${skipped} already present. ` +
      "Local blob files were left in place and are no longer read.",
  );
}
