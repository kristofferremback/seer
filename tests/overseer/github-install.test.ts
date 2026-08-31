import { test, expect } from "bun:test";
import { join } from "node:path";
import { createFetchGithubOAuth } from "../../src/overseer/github-oauth";
import { createTestDataDir, removeTestDataDir } from "../test-data-dir";

const OAUTH_API = "https://api.github.test";

function oauthWith(fetchImpl: typeof fetch) {
  return createFetchGithubOAuth({
    clientId: "cid",
    clientSecret: "secret",
    apiBase: OAUTH_API,
    fetchImpl,
  });
}

// The list is the whole proof the claim flow has, so an installation on the second page
// is one the person would be told they do not have.
test("the installations a person can reach are read across every page", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("page=2")) {
      return Response.json({ installations: [{ id: 2, account: null }] });
    }
    return Response.json(
      { installations: [{ id: 1, account: null }] },
      { headers: { Link: `<${OAUTH_API}/user/installations?per_page=100&page=2>; rel="next"` } },
    );
  }) as unknown as typeof fetch;

  const installations = await oauthWith(fetchImpl).listUserInstallations("tok");
  expect(installations.map((i) => i.id)).toEqual([1, 2]);
  expect(seen).toHaveLength(2);
});

test("a paging link pointing somewhere else does not receive the person's token", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return Response.json(
      { installations: [{ id: 1, account: null }] },
      { headers: { Link: `<https://evil.test/user/installations?page=2>; rel="next"` } },
    );
  }) as unknown as typeof fetch;

  await expect(oauthWith(fetchImpl).listUserInstallations("tok")).rejects.toThrow(
    /Refusing to send the token/,
  );
  expect(seen).toHaveLength(1);
});

// The claim flow turns on who is asking, and the whole suite runs under
// AUTH_DISABLED=true, where sessionUser() answers "the root user" to a request with no
// cookie at all. A test asking what workspace B can reach would silently be asking what a
// signed-in root user can reach. So it runs in its own process, like the other two
// privacy scripts. See tests/overseer/github-install-privacy.script.ts.
test("installations, the claim flow, and what one workspace cannot reach", async () => {
  const script = join(import.meta.dir, "github-install-privacy.script.ts");
  const dataDir = createTestDataDir("seer-ghi-privacy-");
  try {
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DATA_DIR: dataDir,
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
  } finally {
    removeTestDataDir(dataDir);
  }
}, 30_000);
