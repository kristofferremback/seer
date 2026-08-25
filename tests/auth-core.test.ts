import { test, expect, beforeAll, describe } from "bun:test";

// Env is set by tests/setup.ts (AUTH_DISABLED=true, API_TOKEN=test-token).
import { migrate } from "../src/migrate";
import { db, legacyWorkspaceId } from "../src/db";
import { requireApiKey, acceptInvite, lookupValidInvite } from "../src/auth";
import { newApiKey, hashKey, tinyId } from "../src/ids";

let rootUserId: string;
let rootWs: string;

beforeAll(() => {
  // Idempotent — brings the shared db to v1 and bootstraps the root user/workspace
  // (and imports API_TOKEN=test-token as the legacy key) if no prior test file did.
  migrate();
  rootWs = legacyWorkspaceId()!;
  rootUserId = db.query<{ user_id: string }, [string]>(
    "SELECT user_id FROM api_keys WHERE workspace_id = ? AND is_legacy = 1 ORDER BY created_at ASC LIMIT 1",
  ).get(rootWs)!.user_id;
});

function bearer(token: string): Request {
  return new Request("http://localhost/api/bundles", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Insert a ready-to-use key row and return its token + id. */
function mintKey(
  opts: { workspaceId?: string; userId?: string; revoked?: boolean; lastUsedAt?: number | null } = {},
): { id: string; token: string } {
  const token = newApiKey();
  const id = tinyId("key");
  db.run(
    "INSERT INTO api_keys (id, user_id, workspace_id, name, token_hash, token_hint, is_legacy, created_at, last_used_at, revoked_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    [
      id,
      opts.userId ?? rootUserId,
      opts.workspaceId ?? rootWs,
      "test key",
      hashKey(token),
      token.slice(0, 12),
      Date.now(),
      opts.lastUsedAt ?? null,
      opts.revoked ? Date.now() : null,
    ],
  );
  return { id, token };
}

// ---- key auth matrix ----

describe("requireApiKey", () => {
  test("legacy imported env key authenticates", () => {
    const res = requireApiKey(bearer("test-token"));
    expect(res).not.toBeInstanceOf(Response);
    const auth = res as { keyId: string; userId: string; workspaceId: string };
    expect(auth.workspaceId).toBe(rootWs);
    expect(auth.userId).toBe(rootUserId);
  });

  test("valid minted key authenticates with its own (user, workspace)", () => {
    const { id, token } = mintKey();
    const res = requireApiKey(bearer(token));
    expect(res).not.toBeInstanceOf(Response);
    expect((res as { keyId: string }).keyId).toBe(id);
  });

  test("revoked key -> 401", async () => {
    const { token } = mintKey({ revoked: true });
    const res = requireApiKey(bearer(token));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(await (res as Response).json()).toHaveProperty("error");
  });

  test("unknown token -> 401", () => {
    const res = requireApiKey(bearer("seer_sk_totally-unknown-token"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  test("missing/malformed Authorization -> 401", () => {
    expect((requireApiKey(new Request("http://localhost/")) as Response).status).toBe(401);
    expect(
      (requireApiKey(
        new Request("http://localhost/", { headers: { authorization: "test-token" } }),
      ) as Response).status,
    ).toBe(401);
  });

  test("last_used_at bumps on first use, then throttles for 60s", () => {
    const { id, token } = mintKey({ lastUsedAt: null });
    const read = () =>
      db.query<{ last_used_at: number | null }, [string]>(
        "SELECT last_used_at FROM api_keys WHERE id = ?",
      ).get(id)!.last_used_at;

    expect(read()).toBeNull();
    requireApiKey(bearer(token));
    const first = read();
    expect(first).not.toBeNull();

    // Within 60s: no write, timestamp unchanged.
    requireApiKey(bearer(token));
    expect(read()).toBe(first!);

    // Older than 60s: bumped again.
    db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [Date.now() - 61_000, id]);
    const stale = read();
    requireApiKey(bearer(token));
    expect(read()).toBeGreaterThan(stale!);
  });
});

// ---- invite acceptance core (Google-free) ----

function makeWorkspace(name = "team"): string {
  const id = tinyId("ws");
  db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)", [
    id,
    name,
    Date.now(),
  ]);
  return id;
}

function mintInvite(wsId: string, opts: { expiresAt?: number } = {}): string {
  const token = tinyId("inv");
  db.run(
    "INSERT INTO invites (token, workspace_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [token, wsId, rootUserId, Date.now(), opts.expiresAt ?? Date.now() + 7 * 24 * 60 * 60 * 1000],
  );
  return token;
}

function membership(wsId: string, userId: string): boolean {
  return !!db
    .query("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?")
    .get(wsId, userId);
}

describe("acceptInvite", () => {
  test("new user: creates user + membership + stamps invite accepted", () => {
    const ws = makeWorkspace();
    const token = mintInvite(ws);
    const res = acceptInvite(token, "Newbie@Example.com");
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(res!.workspaceId).toBe(ws);

    const user = db
      .query<{ id: string; email: string }, [string]>("SELECT id, email FROM users WHERE id = ?")
      .get(res!.userId)!;
    expect(user.email).toBe("newbie@example.com"); // lowercased
    expect(membership(ws, res!.userId)).toBe(true);

    const inv = db
      .query<{ accepted_by: string; accepted_at: number }, [string]>(
        "SELECT accepted_by, accepted_at FROM invites WHERE token = ?",
      )
      .get(token)!;
    expect(inv.accepted_by).toBe(res!.userId);
    expect(inv.accepted_at).not.toBeNull();
  });

  test("existing user joins a second workspace without a new user row", () => {
    const rootEmail = db.query<{ email: string }, [string]>("SELECT email FROM users WHERE id = ?").get(rootUserId)!.email;
    const before = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM users").get()!.c;
    const ws = makeWorkspace("second");
    const token = mintInvite(ws);

    const res = acceptInvite(token, rootEmail);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(false);
    expect(res!.userId).toBe(rootUserId);
    expect(membership(ws, rootUserId)).toBe(true);
    const after = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM users").get()!.c;
    expect(after).toBe(before); // no new user
  });

  test("expired token is invalid (and lookupValidInvite agrees)", () => {
    const ws = makeWorkspace();
    const token = mintInvite(ws, { expiresAt: Date.now() - 1000 });
    expect(lookupValidInvite(token)).toBeNull();
    expect(acceptInvite(token, "late@example.com")).toBeNull();
    // No user minted for a rejected accept.
    expect(db.query("SELECT 1 FROM users WHERE email = 'late@example.com'").get()).toBeNull();
  });

  test("single-use: a used token is rejected on the second accept", () => {
    const ws = makeWorkspace();
    const token = mintInvite(ws);
    const first = acceptInvite(token, "once@example.com");
    expect(first).not.toBeNull();
    expect(lookupValidInvite(token)).toBeNull();
    expect(acceptInvite(token, "twice@example.com")).toBeNull();
    // The second email never became a user.
    expect(db.query("SELECT 1 FROM users WHERE email = 'twice@example.com'").get()).toBeNull();
  });

  test("unknown token -> null", () => {
    expect(acceptInvite("inv_0000000000", "x@example.com")).toBeNull();
  });
});
