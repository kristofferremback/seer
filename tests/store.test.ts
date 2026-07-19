import { test, expect } from "bun:test";
import { join } from "node:path";
// Env is set by tests/setup.ts before this app module imports.
import { imageKey, s3, zipKey, zipPath } from "../src/store";
import { migrateBlobsToS3 } from "../src/migrate-blobs";
import { config } from "../src/config";

test("zipPath is scoped by workspace: zips/<ws>/<slug>/<version>.zip", () => {
  const p = zipPath("ws_abc1234567", "my-site", 3);
  expect(p).toBe(join(config.dataDir, "zips", "ws_abc1234567", "my-site", "3.zip"));
});

test("different workspaces never collide on the same slug/version", () => {
  const a = zipPath("ws_aaaaaaaaaa", "site", 1);
  const b = zipPath("ws_bbbbbbbbbb", "site", 1);
  expect(a).not.toBe(b);
});

test("S3 keys mirror the on-disk layout: zips/<ws>/<slug>/<version>.zip, images/<ws>/<id>", () => {
  expect(zipKey("ws_abc1234567", "my-site", 3)).toBe("zips/ws_abc1234567/my-site/3.zip");
  expect(imageKey("ws_abc1234567", "img_xxxxxxxxxx")).toBe("images/ws_abc1234567/img_xxxxxxxxxx");
});

test("without S3_BUCKET the store is disk-only and blob migration is a no-op", async () => {
  expect(config.s3).toBeNull();
  expect(s3).toBeNull();
  await migrateBlobsToS3(); // must resolve without touching anything
});
