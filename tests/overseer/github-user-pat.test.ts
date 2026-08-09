import { afterEach, beforeAll, expect, test } from "bun:test";
import { GithubError } from "../../src/overseer/github";
import { migrate } from "../../src/migrate";
import { generateKey, setKeyring } from "../../src/envelope";
import { handlePasteGithubToken, setGithubPatIdentifier } from "../../src/overseer/github-user-pat";
import { listGithubUserCredentials, openGithubUserCredential } from "../../src/overseer/user-credentials";

beforeAll(() => {
  setKeyring({ activeId: "pat-test", keys: new Map([["pat-test", Buffer.from(generateKey(), "base64")]]) });
  migrate();
});

const USER = "usr_pat_owner";
function request(token: string, label = "work"): Request {
  return new Request("http://seer.test/settings/ws_test/github/credentials", {
    method: "POST",
    body: new URLSearchParams({ token, label }),
  });
}

afterEach(() => setGithubPatIdentifier(null));

test("classic tokens are refused and fine-grained tokens are verified and accepted", async () => {
  let calls = 0;
  setGithubPatIdentifier(async () => { calls++; return { login: "octocat", id: 1, scopes: ["repo"] }; });
  const classic = await handlePasteGithubToken(request("ghp_classic"), USER, "/settings/ws_test");
  expect(classic.status).toBe(400);
  expect(calls).toBe(0);

  const fine = await handlePasteGithubToken(request("github_pat_fine"), USER, "/settings/ws_test");
  expect(fine.status).toBe(303);
  const credential = listGithubUserCredentials(USER)[0]!;
  expect(credential).toMatchObject({ label: "work", account_login: "octocat", kind: "pat" });
  expect(openGithubUserCredential(credential.id, USER)).toBe("github_pat_fine");
});

test("a token GitHub does not authenticate is refused and not stored", async () => {
  const user = "usr_bad_pat";
  setGithubPatIdentifier(async () => { throw new GithubError("bad credentials", 401, "https://api.github.com/user"); });
  const response = await handlePasteGithubToken(request("github_pat_invalid"), user, "/settings/ws_test");
  expect(response.status).toBe(400);
  expect(listGithubUserCredentials(user)).toHaveLength(0);
});
