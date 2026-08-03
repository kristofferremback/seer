// Shares: the token, the link it opens, and everything the link is not.
//
// Env is set by tests/setup.ts (AUTH_DISABLED=true), so every request in this file
// arrives with the root user's session. That is exactly the shape the refusals have to
// survive, and it is why most of the fixtures live in a workspace the root user is NOT
// a member of: a signed-in stranger is the reader a share is aimed at, and the one
// documented exception (a member following a dead link) then has its own workspace to
// be tested in.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../src/server";
import { db, legacyWorkspaceId } from "../src/db";
import { tinyId, hashKey, newShareToken } from "../src/ids";
import { createAnnotation, createAttachment } from "../src/overseer/db";
import { saveAttachment } from "../src/store";
import { createShare, listShares, lookupShare, resolveShare, revokeShare } from "../src/shares";
import { storeGoldenReview } from "./overseer/fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

// The workspace the root user is not in: a share's reader is a stranger to it.
let wsOut: string;
// The bootstrap workspace, which the root user IS a member of.
let rootWs: string;
let rootUser: string;
let attachmentId: string;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  rootWs = legacyWorkspaceId()!;
  rootUser = db.query<{ id: string }, []>("SELECT id FROM users LIMIT 1").get()!.id;

  wsOut = tinyId("ws");
  db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'private', ?)", [
    wsOut,
    "Outside",
    Date.now(),
  ]);
  storeGoldenReview(wsOut, "shared-review");
  storeGoldenReview(wsOut, "other-review");
  storeGoldenReview(rootWs, "own-review");

  // A question filed on the review, so "a shared page shows no annotations" is asked of
  // a review that has one.
  createAnnotation(wsOut, "shared-review", { type: "summary", id: "summary" }, "Is the gate reachable?", 1);

  const bytes = new Uint8Array([137, 80, 78, 71]);
  attachmentId = createAttachment(wsOut, "shared-review", 1, "image/png", bytes.length, "A shot", "");
  await saveAttachment(wsOut, attachmentId, bytes);
});

afterAll(() => {
  server.stop(true);
});

function mint(over: Partial<Parameters<typeof createShare>[0]> = {}) {
  return createShare({
    wsId: wsOut,
    kind: "review",
    target: "shared-review",
    label: "for Anna",
    userId: rootUser,
    expiresAt: null,
    ...over,
  });
}

/** Status, content type and body: "the same 404" has to mean the same response rather
 *  than the same status line. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

// ---- storage ----

describe("share storage", () => {
  test("a token is minted once, stored hashed, and resolves to its row", () => {
    const { id, token } = mint({ label: "hashed at rest" });
    expect(token).toMatch(/^seer_sh_[A-Za-z0-9_-]{32}$/);

    const stored = db
      .query<{ token_hash: string }, [string]>("SELECT token_hash FROM shares WHERE id = ?")
      .get(id)!;
    expect(stored.token_hash).toBe(hashKey(token));
    expect(stored.token_hash).not.toContain(token);

    const live = resolveShare(token)!;
    expect(live.id).toBe(id);
    expect(live.workspace_id).toBe(wsOut);
    expect(live.kind).toBe("review");
    expect(live.target).toBe("shared-review");
    expect(live.label).toBe("hashed at rest");
  });

  test("resolveShare answers null for unknown, revoked and expired alike", () => {
    expect(resolveShare(newShareToken())).toBeNull();
    expect(resolveShare("not-a-token")).toBeNull();

    const revoked = mint({ label: "revoked" });
    revokeShare(revoked.id);
    expect(resolveShare(revoked.token)).toBeNull();
    // Revoked is still a row: the link stays auditable after it stops working.
    expect(lookupShare(revoked.token)!.revoked_at).not.toBeNull();

    const expired = mint({ label: "expired", expiresAt: Date.now() - 1000 });
    expect(resolveShare(expired.token)).toBeNull();
    expect(lookupShare(expired.token)!.id).toBe(expired.id);
  });

  test("listing a workspace's shares never returns a token", () => {
    const { id, token } = mint({ label: "listed" });
    const listed = listShares(wsOut);
    const row = listed.find((s) => s.id === id)!;
    expect(row.label).toBe("listed");
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("token");

    // A revoked share leaves the list a member reads.
    revokeShare(id);
    expect(listShares(wsOut).some((s) => s.id === id)).toBe(false);
  });
});

// ---- the read route ----

describe("the share read route", () => {
  test("a minted token opens the review, current and pinned", async () => {
    const { token } = mint();

    const current = await fetch(`${base}/s/${token}`);
    expect(current.status).toBe(200);
    const html = await current.text();
    expect(html).toContain("<title>");
    expect(html).toContain("overseer");

    const pinned = await fetch(`${base}/s/${token}/v/1`);
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toContain("overseer");
  });

  test("a shared page hangs off the token, not off the private URL", async () => {
    const { token } = mint();
    const html = await (await fetch(`${base}/s/${token}`)).text();
    // Every link the page draws is one the holder can follow.
    expect(html).not.toContain(`/${wsOut}/r/shared-review`);
    // And nothing on it opens the review's live channel, which asks for membership.
    expect(html).not.toContain("/ws/livereload");
  });

  test("a shared attachment is served under the token", async () => {
    const { token } = mint();
    const res = await fetch(`${base}/s/${token}/a/${attachmentId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(4);
  });

  test("unknown, revoked and expired tokens are one byte-identical soft-404", async () => {
    const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));
    expect(unknown.startsWith("404\n")).toBe(true);

    const revoked = mint();
    revokeShare(revoked.id);
    expect(await shape(await fetch(`${base}/s/${revoked.token}`))).toBe(unknown);

    const expired = mint({ expiresAt: Date.now() - 1000 });
    expect(await shape(await fetch(`${base}/s/${expired.token}`))).toBe(unknown);

    // A token that is not even the right shape, and a version nobody published.
    expect(await shape(await fetch(`${base}/s/nonsense`))).toBe(unknown);
    const live = mint();
    expect(await shape(await fetch(`${base}/s/${live.token}/v/9`))).toBe(unknown);
  });

  test("Referrer-Policy: no-referrer is on the page and on the refusal", async () => {
    const { token } = mint();
    const page = await fetch(`${base}/s/${token}`);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const gone = await fetch(`${base}/s/${newShareToken()}`);
    expect(gone.headers.get("referrer-policy")).toBe("no-referrer");
    const attachment = await fetch(`${base}/s/${token}/a/${attachmentId}`);
    expect(attachment.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("a token for one review does not open another", async () => {
    const { token } = mint({ target: "shared-review" });
    const html = await (await fetch(`${base}/s/${token}`)).text();
    // The share names its own review and no other, at every URL it has.
    expect(html).not.toContain("other-review");
    expect(html).toContain("shared-review");
  });

  test("a token minted in one workspace does not reach an asset in another", async () => {
    // A row that names a workspace and a slug that do not go together: the asset exists,
    // but not there. The resolver scopes on both, so this opens nothing.
    const token = newShareToken();
    db.run(
      "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) " +
        "VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
      [tinyId("shr"), rootWs, "shared-review", "crossed wires", hashKey(token), rootUser, Date.now()],
    );
    const crossed = await shape(await fetch(`${base}/s/${token}`));
    const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));
    expect(crossed).toBe(unknown);
  });

  test("a member following a revoked link reaches the asset", async () => {
    // The one documented exception, and it is the reader's own workspace that earns it.
    const own = createShare({
      wsId: rootWs,
      kind: "review",
      target: "own-review",
      label: "stale",
      userId: rootUser,
      expiresAt: null,
    });
    revokeShare(own.id);
    const res = await fetch(`${base}/s/${own.token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/${rootWs}/r/own-review`);

    // Followed, it lands on the review itself rather than on the refusal.
    const followed = await fetch(`${base}/s/${own.token}`);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain("own-review");
  });
});

// ---- a share is never a write ----

describe("a share is never a write", () => {
  test("a share token is not an API key", async () => {
    const { token } = mint();
    const res = await fetch(`${base}/api/reviews/shared-review/annotations`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ target: { type: "summary", id: "summary" }, body: "Can I write here?" }),
    });
    expect(res.status).not.toBe(200);
    const filed = db
      .query<{ c: number }, [string]>("SELECT COUNT(*) c FROM review_annotations WHERE body = ?")
      .get("Can I write here?")!.c;
    expect(filed).toBe(0);
  });

  test("the share path offers no write of its own", async () => {
    const { token } = mint();
    for (const path of [`/s/${token}/annotations`, `/s/${token}`]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "target=summary%3Asummary&body=written+through+a+share",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const filed = db
      .query<{ c: number }, [string]>("SELECT COUNT(*) c FROM review_annotations WHERE body = ?")
      .get("written through a share")!.c;
    expect(filed).toBe(0);
  });

  test("a shared page carries no annotations and no ask form", async () => {
    const { token } = mint();
    const html = await (await fetch(`${base}/s/${token}`)).text();
    expect(html).not.toContain("Is the gate reachable?");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/annotations");
  });
});
