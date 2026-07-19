import { test, expect } from "bun:test";
import { join } from "node:path";
// Env is set by tests/setup.ts before this app module imports.
import { zipPath } from "../src/store";
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
