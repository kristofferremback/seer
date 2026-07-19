import { test, expect } from "bun:test";
import { join } from "node:path";
import { loginRedirect } from "../src/auth";

function storedNext(next: string): string {
  const cookie = loginRedirect(next).headers.get("set-cookie") ?? "";
  const m = cookie.match(/seer_oauth=[0-9a-f]+:([^;]*)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

test("loginRedirect confines next to this origin (no open redirect)", () => {
  // Same-origin paths pass through untouched.
  expect(storedNext("/bundles")).toBe("/bundles");
  expect(storedNext("/invite/inv_6r3gtn3fd1")).toBe("/invite/inv_6r3gtn3fd1");
  expect(storedNext("/settings/ws_abcdefghjk?x=1")).toBe("/settings/ws_abcdefghjk?x=1");
  // Cross-origin escapes — including the backslash and scheme forms a bare
  // startsWith("//") check misses — all collapse to "/".
  expect(storedNext("//evil.com")).toBe("/");
  expect(storedNext("/\\evil.com")).toBe("/");
  expect(storedNext("https://evil.com")).toBe("/");
  expect(storedNext("javascript:alert(1)")).toBe("/");
});

// The real signed-cookie path in src/auth.ts only runs when AUTH_DISABLED is unset.
// This process has AUTH_DISABLED=true (from setup.ts), so we run the assertions in a
// child process that boots config with auth enabled.
test("session cookie signing/verification (real auth path, subprocess)", async () => {
  const script = join(import.meta.dir, "auth-realpath.script.ts");
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    // Do not inherit AUTH_DISABLED from the test process; the script sets its own env.
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
