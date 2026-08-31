import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CHILD_SUITE = "SEER_TEST_CLEANUP_CHILD_SUITE";

if (process.env[CHILD_SUITE]) {
  test("child suite should receive an isolated data directory", () => {
    expect(existsSync(process.env.DATA_DIR!)).toBe(true);
  });
}

test.skipIf(!!process.env[CHILD_SUITE])(
  "should remove a child process data directory when the process exits",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "seer-cleanup-test-root-"));
    try {
      const child = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "test-data-dir-child.script.ts")],
        {
          env: { ...process.env, SEER_TEST_TMPDIR: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await child.exited;
      const directory = (await new Response(child.stdout).text()).trim();
      const stderr = await new Response(child.stderr).text();

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(dirname(directory)).toBe(root);
      expect(existsSync(directory)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!!process.env[CHILD_SUITE])(
  "should remove the Bun test suite data directory after all tests finish",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "seer-cleanup-suite-root-"));
    try {
      const child = Bun.spawn(["bun", "test", import.meta.path], {
        env: {
          ...process.env,
          [CHILD_SUITE]: "1",
          SEER_TEST_TMPDIR: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await child.exited;
      await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toContain("1 pass");
      expect(stderr).not.toContain("1 fail");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
