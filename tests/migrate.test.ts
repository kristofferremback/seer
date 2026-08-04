import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each migration scenario runs in its own process (the db/config singletons bind to
// one DATA_DIR per process). See tests/migrate.script.ts.
async function runScenario(scenario: string): Promise<{ code: number; out: string; err: string }> {
  const script = join(import.meta.dir, "migrate.script.ts");
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SCENARIO: scenario,
      DATA_DIR: mkdtempSync(join(tmpdir(), `seer-migrate-${scenario}-`)),
      // Let the script own auth-related env; don't inherit the suite's AUTH_DISABLED.
      AUTH_DISABLED: undefined as unknown as string,
      ALLOWED_EMAILS: undefined as unknown as string,
      API_TOKEN: undefined as unknown as string,
      API_KEY: undefined as unknown as string,
    },
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if (code !== 0) {
    console.error(`[migrate ${scenario}] stdout:`, out);
    console.error(`[migrate ${scenario}] stderr:`, err);
  }
  return { code, out, err };
}

test("v0-with-data migrates losslessly and is idempotent", async () => {
  const { code, out } = await runScenario("v0");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("fresh/empty db bootstraps the root workspace", async () => {
  const { code, out } = await runScenario("fresh");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a v2 db gains the overseer tables and re-running is a no-op", async () => {
  const { code, out } = await runScenario("v2");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a v3 db gains the shares table and re-running is a no-op", async () => {
  const { code, out } = await runScenario("v3");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("v5 backfills review_prs from each review's latest version only", async () => {
  const { code, out } = await runScenario("v4backfill");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a malformed stored document aborts the v5 backfill, naming the row", async () => {
  const { code, out } = await runScenario("v4malformed");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// The drop is its own release: an ordinary boot of this image must stop at v5 with the
// table standing, so the previous image can keep serving through the overlap and a
// rollback still recognises the database.
test("an ordinary boot stops at v5 and leaves review_freshness standing", async () => {
  const { code, out } = await runScenario("v5stops");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a v5 db drops review_freshness and keeps everything else, when asked", async () => {
  const { code, out } = await runScenario("v5drop");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("no resolvable root email with auth enabled fails loudly", async () => {
  const { code, out } = await runScenario("noemail");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});
