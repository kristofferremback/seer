import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { generateKey, setKeyring } from "../../src/envelope";
import { migrate } from "../../src/migrate";
import {
  createGithubUserCredential,
  getGithubUserCredential,
  listGithubUserCredentials,
  openGithubUserCredential,
  revokeGithubUserCredential,
  touchGithubUserCredential,
} from "../../src/overseer/user-credentials";

beforeAll(() => {
  setKeyring({ activeId: "test", keys: new Map([["test", Buffer.from(generateKey(), "base64")]]) });
  migrate();
});

const A = "usr_credential_a";
const B = "usr_credential_b";

function create(userId: string, secret: string, label = "work"): string {
  return createGithubUserCredential({
    userId,
    kind: "pat",
    label,
    secret,
    accountLogin: "octocat",
    accountId: 583231,
    scopes: ["contents:read", "pull_requests:read"],
    expiresAt: 2_000_000_000_000,
  });
}

describe("GitHub user credential store", () => {
  test("a credential round-trips while no column contains its plaintext", () => {
    const token = "github_pat_secret-that-was-really-stored";
    const id = create(A, token);

    expect(openGithubUserCredential(id, A)).toBe(token);
    expect(openGithubUserCredential(id, B)).toBeNull();
    expect(getGithubUserCredential(id, A)).toMatchObject({
      id,
      user_id: A,
      kind: "pat",
      label: "work",
      account_login: "octocat",
      scopes: ["contents:read", "pull_requests:read"],
    });

    const raw = db
      .query<Record<string, unknown>, [string]>("SELECT * FROM github_user_credentials WHERE id = ?")
      .get(id)!;
    expect(Object.values(raw)).not.toContain(token);
    expect(JSON.stringify(raw)).not.toContain(token);
  });

  test("row-bound context rejects ciphertext moved to another row", () => {
    const first = create(A, "github_pat_belongs-to-a", "a");
    const second = create(B, "github_pat_belongs-to-b", "b");
    const ciphertext = db
      .query<{ secret: string }, [string]>("SELECT secret FROM github_user_credentials WHERE id = ?")
      .get(first)!.secret;
    db.run("UPDATE github_user_credentials SET secret = ? WHERE id = ?", [ciphertext, second]);

    expect(() => openGithubUserCredential(second, B)).toThrow("context does not match");
  });

  // The test above moves a ciphertext to a row with BOTH a different id and a different
  // owner, so the id half of the context alone rejects it — and it therefore stays green
  // if the user is dropped from the context entirely. That was the state of this file:
  // half the binding the design calls load-bearing was asserted by nothing.
  //
  // The case the design actually argues for is this one. The attacker does not move the
  // secret; they reassign the row, which is the cheaper write and the one that gets them
  // somebody else's access under their own name.
  test("reassigning a row to another user does not hand them its secret", () => {
    const token = "github_pat_reassignment-must-not-work";
    const id = create(A, token, "reassigned");

    // The whole row stays put. Only its owner changes.
    db.run("UPDATE github_user_credentials SET user_id = ? WHERE id = ?", [B, id]);

    expect(() => openGithubUserCredential(id, B)).toThrow("context does not match");

    // And the success beside the refusal, so this cannot pass because decryption is
    // simply broken: put the owner back and the same bytes open again.
    db.run("UPDATE github_user_credentials SET user_id = ? WHERE id = ?", [A, id]);
    expect(openGithubUserCredential(id, A)).toBe(token);
  });

  // Seer must never show anybody the token, and the read path is where that would
  // happen: a settings panel renders whatever the list hands it. So the list does not
  // carry the secret at all -- not the plaintext, which exists only inside a request
  // that is using it, and not the envelope either, which is what a `SELECT *` would
  // have handed to a template.
  test("nothing on the read path carries the secret, in either form", () => {
    const token = "github_pat_must-never-be-rendered";
    const id = create(A, token, "unrendered");

    const ciphertext = db
      .query<{ secret: string }, [string]>("SELECT secret FROM github_user_credentials WHERE id = ?")
      .get(id)!.secret;
    expect(ciphertext.length).toBeGreaterThan(0); // there really is something to withhold

    for (const row of [listGithubUserCredentials(A)[0]!, getGithubUserCredential(id, A)!]) {
      expect(Object.keys(row)).not.toContain("secret");
      const rendered = JSON.stringify(row);
      expect(rendered).not.toContain(token);
      expect(rendered).not.toContain(ciphertext);
    }

    // And the one door that does open it still works, so this is a withholding rather
    // than a store that lost the token.
    expect(openGithubUserCredential(id, A)).toBe(token);
  });
  test("list, last-use, and soft revocation are owner scoped", () => {
    const id = create(A, "github_pat_lifecycle", "lifecycle");
    expect(listGithubUserCredentials(A).some((row) => row.id === id)).toBe(true);
    expect(touchGithubUserCredential(id, B, 123)).toBe(false);
    expect(touchGithubUserCredential(id, A, 123)).toBe(true);
    expect(getGithubUserCredential(id, A)?.last_used_at).toBe(123);
    expect(revokeGithubUserCredential(id, B)).toBe(false);
    expect(revokeGithubUserCredential(id, A)).toBe(true);
    expect(openGithubUserCredential(id, A)).toBeNull();
    expect(listGithubUserCredentials(A).some((row) => row.id === id)).toBe(false);
    expect(getGithubUserCredential(id, A)?.revoked_at).not.toBeNull();
  });
});
