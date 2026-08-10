import { afterEach, beforeAll, expect, test } from "bun:test";
import { GithubError } from "../../src/overseer/github";
import { migrate } from "../../src/migrate";
import { generateKey, setKeyring } from "../../src/envelope";
import { handlePasteGithubToken, parseTokenExpiry, setGithubPatIdentifier } from "../../src/overseer/github-user-pat";
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

const EXPIRY = Date.UTC(2026, 8, 10, 15, 22, 33);

test("classic tokens are refused and fine-grained tokens are verified and accepted", async () => {
  let calls = 0;
  setGithubPatIdentifier(async () => { calls++; return { login: "octocat", id: 1, expiresAt: EXPIRY }; });
  const classic = await handlePasteGithubToken(request("ghp_classic"), USER, "/settings/ws_test");
  expect(classic.status).toBe(400);
  expect(calls).toBe(0);

  const fine = await handlePasteGithubToken(request("github_pat_fine"), USER, "/settings/ws_test");
  expect(fine.status).toBe(303);
  const credential = listGithubUserCredentials(USER)[0]!;
  expect(credential).toMatchObject({ label: "work", account_login: "octocat", kind: "pat" });
  expect(openGithubUserCredential(credential.id, USER)).toBe("github_pat_fine");
  // Stored, not dropped. `expires_at` is the only thing that tells an expiry apart from a
  // revocation later, and it used to arrive here and go nowhere.
  expect(credential.expires_at).toBe(EXPIRY);
});

// A fine-grained token always expires, so a paste path that discards the date guarantees
// two wrong answers later: settings can never show "expired", and github-user.ts's dead()
// reports every dead credential as revoked at GitHub — sending the person to reissue a
// token when the fix was to paste a fresh one.
test("the expiry GitHub reports is recorded, in each shape GitHub sends it", () => {
  expect(parseTokenExpiry("2026-09-10 15:22:33 UTC")).toBe(EXPIRY);
  expect(parseTokenExpiry("2026-09-10T15:22:33Z")).toBe(EXPIRY);
  expect(parseTokenExpiry("2026-09-10 17:22:33 +0200")).toBe(EXPIRY);
  // A token Seer cannot date still works, so an unreadable header is null, never a throw.
  expect(parseTokenExpiry(null)).toBeNull();
  expect(parseTokenExpiry("")).toBeNull();
  expect(parseTokenExpiry("   ")).toBeNull();
  expect(parseTokenExpiry("whenever GitHub feels like it")).toBeNull();
});

// A non-expiring token is a legitimate answer, not a failure to read one.
test("a token GitHub gives no expiry for is stored with none", async () => {
  const user = "usr_undated_pat";
  setGithubPatIdentifier(async () => ({ login: "octocat", id: 1, expiresAt: null }));
  const response = await handlePasteGithubToken(request("github_pat_undated"), user, "/settings/ws_test");
  expect(response.status).toBe(303);
  expect(listGithubUserCredentials(user)[0]!.expires_at).toBeNull();
});

test("a token GitHub does not authenticate is refused and not stored", async () => {
  const user = "usr_bad_pat";
  setGithubPatIdentifier(async () => { throw new GithubError("bad credentials", 401, "https://api.github.com/user"); });
  const response = await handlePasteGithubToken(request("github_pat_invalid"), user, "/settings/ws_test");
  expect(response.status).toBe(400);
  expect(listGithubUserCredentials(user)).toHaveLength(0);
});

// The first fine-grained token connected to the deployed instance appeared to fail with
// "GitHub would not authenticate this token (502)" while GitHub had in fact answered
// fine: SEER_ENCRYPTION_KEYS was unset, seal() threw, and one try around both steps
// blamed the far end for a local misconfiguration. What this pins is not the wording but
// the distinction -- a failure on our side of the line must not read as GitHub's.
test("a token that verifies but cannot be stored blames the configuration, not GitHub", async () => {
  const user = "usr_unsealable_pat";
  setGithubPatIdentifier(async () => ({ login: "octocat", id: 1, expiresAt: null }));
  // An active key that is not in the keyring: seal() throws, without depending on what
  // the environment happens to hold.
  setKeyring({ activeId: "absent", keys: new Map() });
  try {
    const response = await handlePasteGithubToken(request("github_pat_fine"), user, "/settings/ws_test");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toMatch(/GitHub would not authenticate/);
    expect(body).toMatch(/could not store it/);
    expect(listGithubUserCredentials(user)).toHaveLength(0);
  } finally {
    setKeyring({ activeId: "pat-test", keys: new Map([["pat-test", Buffer.from(generateKey(), "base64")]]) });
  }
});
