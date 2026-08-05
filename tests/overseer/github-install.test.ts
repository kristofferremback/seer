import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The claim flow turns on who is asking, and the whole suite runs under
// AUTH_DISABLED=true, where sessionUser() answers "the root user" to a request with no
// cookie at all. A test asking what workspace B can reach would silently be asking what a
// signed-in root user can reach. So it runs in its own process, like the other two
// privacy scripts. See tests/overseer/github-install-privacy.script.ts.
test("installations, the claim flow, and what one workspace cannot reach", async () => {
  const script = join(import.meta.dir, "github-install-privacy.script.ts");
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATA_DIR: mkdtempSync(join(tmpdir(), "seer-ghi-privacy-")),
      // The script owns its auth env; inheriting the suite's would defeat the point.
      AUTH_DISABLED: undefined as unknown as string,
      ALLOWED_EMAILS: undefined as unknown as string,
      API_KEY: undefined as unknown as string,
      API_TOKEN: undefined as unknown as string,
    },
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if (code !== 0) {
    console.error("[github-install-privacy] stdout:", out);
    console.error("[github-install-privacy] stderr:", err);
  }
  expect(code).toBe(0);
  expect(out).toContain("all assertions passed");
}, 30_000);
