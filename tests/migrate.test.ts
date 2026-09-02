import { test, expect } from "bun:test";
import { join } from "node:path";
import { createTestDataDir, removeTestDataDir } from "./test-data-dir";

// Each migration scenario runs in its own process (the db/config singletons bind to
// one DATA_DIR per process). See tests/migrate.script.ts.
async function runScenario(scenario: string): Promise<{ code: number; out: string; err: string }> {
  const script = join(import.meta.dir, "migrate.script.ts");
  const dataDir = createTestDataDir(`seer-migrate-${scenario}-`);
  try {
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SCENARIO: scenario,
        DATA_DIR: dataDir,
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
  } finally {
    removeTestDataDir(dataDir);
  }
}

test("v0-with-data migrates losslessly and is idempotent", async () => {
  const { code, out } = await runScenario("v0");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v11 database gains the additive capture and publication tables", async () => {
  const { code, out } = await runScenario("v11");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v12 capture survives the additive v13 publication migration", async () => {
  const { code, out } = await runScenario("v12");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v13 stage survives the additive read-state migration", async () => {
  const { code, out } = await runScenario("v13");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v14 database survives v15 and rolls back by restore", async () => {
  const { code, out } = await runScenario("v14");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v15 promoted review survives v16 and rolls back by restore", async () => {
  const { code, out } = await runScenario("v15");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// The release this slice ships. Additive DDL is only half the claim; the other half is
// that going back is a database restore, which is the only rollback this repo has.
test("a populated v16 pull request lineage survives v17 and rolls back by restore", async () => {
  const { code, out } = await runScenario("v16");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// The follow-up release: stored movement is additive, and going back is still a restore.
test("a populated v17 lineage survives v18 and rolls back by restore", async () => {
  const { code, out } = await runScenario("v17");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// The release this slice ships: the stack tables are additive beside every populated
// promoted-review row, and going back is still a restore.
test("a populated v18 database survives v19 and rolls back by restore", async () => {
  const { code, out } = await runScenario("v18");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v19 database preserves every legacy share through v20 and restore", async () => {
  const { code, out } = await runScenario("v19");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v20 capability database gains empty conversation authority and restores", async () => {
  const { code, out } = await runScenario("v20");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a populated v21 review database gains judgment authority and the movement marker, then restores", async () => {
  const { code, out } = await runScenario("v21");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a database from a newer release is refused rather than walked", async () => {
  const { code, out } = await runScenario("newer");
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

// The drop is its own release: an ordinary boot of this image must leave the table
// standing, so the previous image can keep serving through the graceful-shutdown
// overlap, which calls listFreshness() on every review render.
test("an ordinary boot leaves review_freshness standing", async () => {
  const { code, out } = await runScenario("v5stops");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("a v5 db drops review_freshness and keeps everything else, when asked", async () => {
  const { code, out } = await runScenario("v5drop");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// The sequence a real operator produces, and the one whose absence hid a defect: boot
// this release ordinarily, then opt in later. While the drop was a gated step inside
// the version ladder, the first boot walked past it and the second could never run it.
test("opting into the drop after an ordinary boot still drops it", async () => {
  const { code, out } = await runScenario("v5dropafterboot");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

// user_version 6 does not say which shape is on disk: the previous image stamped it both
// with and without the user-credential tables. The repair is what makes the ambiguous one
// bootable, and only a database stamped 6 without them can prove it.
test("a db the previous image stamped 6 without the user tables is repaired", async () => {
  const { code, out } = await runScenario("v6ambiguous");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});

test("no resolvable root email with auth enabled fails loudly", async () => {
  const { code, out } = await runScenario("noemail");
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
});
