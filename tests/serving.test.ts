import { test, expect } from "bun:test";
import { join } from "node:path";

// The visibility matrix needs real forged sessions (member vs non-member vs anon),
// which only work when AUTH_DISABLED is unset — this process has it set (setup.ts),
// so the matrix runs in a child process that boots config with auth enabled.
test("workspace visibility matrix + soft-404 variants (real auth path, subprocess)", async () => {
  const script = join(import.meta.dir, "serving-matrix.script.ts");
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AUTH_DISABLED: undefined as unknown as string },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    console.error("subprocess stdout:", stdout);
    console.error("subprocess stderr:", stderr);
  }
  expect(exitCode).toBe(0);
  expect(stdout).toContain("all assertions passed");
});
