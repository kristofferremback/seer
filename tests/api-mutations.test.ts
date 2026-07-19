import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";

// Env is set by tests/setup.ts (AUTH_DISABLED=true → sessionUser resolves to the
// root user, who is a member of the bootstrap workspace). That covers everything
// here: bearer-key uploads (no session needed) and mutations by a member of their
// own workspace. Cross-user authz (non-member 404, key ownership, invite accept as
// a different user) needs forged sessions and lives in api-mutations.script.ts.
import { startServer } from "../src/server";
import { config } from "../src/config";
import { db, legacyWorkspaceId, createWorkspace, mintApiKey } from "../src/db";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let rootWs: string;
let rootUser: string;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  rootWs = legacyWorkspaceId()!;
  rootUser = db.query<{ id: string }, []>("SELECT id FROM users LIMIT 1").get()!.id;
});

afterAll(() => {
  server.stop(true);
});

const LEGACY = config.apiToken!; // imported env key → root workspace
const TOKEN_RE = /seer_sk_[A-Za-z0-9_-]{32}/;

function htmlZip(body: string): Uint8Array {
  return zipSync({ "index.html": strToU8(`<!doctype html><html><body>${body}</body></html>`) });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

function put(slug: string, token: string, body: Uint8Array) {
  return fetch(`${base}/api/bundles/${slug}`, { method: "PUT", headers: bearer(token), body });
}

function form(fields: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual" as const,
  };
}

// ---- upload scoping across two workspaces ----

describe("upload scoping", () => {
  test("two keys in two workspaces; same slug coexists; GET /api/bundles is scoped", async () => {
    // A second workspace with its own key (root is the owner for test convenience).
    const ws2 = createWorkspace("second-space", rootUser);
    const { token: key2 } = mintApiKey(rootUser, ws2, "ws2 key");

    // The same slug uploaded through each key lands in that key's workspace.
    const r1 = await put("coexist", LEGACY, htmlZip("ROOT-BODY"));
    const j1 = await readJson(r1);
    expect(r1.status).toBe(200);
    expect(j1.workspace).toBe(rootWs);
    expect(j1.url).toBe(`${config.baseUrl}/${rootWs}/b/coexist/`);
    expect(j1.versionUrl).toBe(`${config.baseUrl}/${rootWs}/b/coexist/v/1/`);

    const r2 = await put("coexist", key2, htmlZip("WS2-BODY"));
    const j2 = await readJson(r2);
    expect(r2.status).toBe(200);
    expect(j2.workspace).toBe(ws2);
    expect(j2.version).toBe(1); // independent version counters per workspace

    // Each workspace serves its own bytes for the shared slug.
    expect(await (await fetch(`${base}/${rootWs}/b/coexist/`)).text()).toContain("ROOT-BODY");
    expect(await (await fetch(`${base}/${ws2}/b/coexist/`)).text()).toContain("WS2-BODY");

    // GET /api/bundles returns only the key's workspace.
    const rootList = await readJson(await fetch(`${base}/api/bundles`, { headers: bearer(LEGACY) }));
    const rootSlugs = rootList.map((b: { slug: string }) => b.slug);
    expect(rootSlugs).toContain("coexist");
    expect(rootList.every((b: { workspace: string }) => b.workspace === rootWs)).toBe(true);

    const ws2List = await readJson(await fetch(`${base}/api/bundles`, { headers: bearer(key2) }));
    expect(ws2List.map((b: { slug: string }) => b.slug)).toEqual(["coexist"]);
    expect(ws2List[0].workspace).toBe(ws2);
    expect(ws2List[0].url).toBe(`${config.baseUrl}/${ws2}/b/coexist/`);
  });
});

// ---- key lifecycle over HTTP: mint, roll, revoke ----

describe("key lifecycle over HTTP", () => {
  test("mint → upload works; roll → old dead, new works, same name; revoke → dead", async () => {
    // Mint: the token is revealed exactly once, on the mint response.
    const minted = await fetch(`${base}/settings/${rootWs}/keys`, form({ name: "lifecycle" }));
    expect(minted.status).toBe(200);
    const mintedHtml = await minted.text();
    const token = mintedHtml.match(TOKEN_RE)?.[0];
    expect(token).toBeTruthy();
    expect(mintedHtml).toContain("shown once");

    // The revealed token uploads into the root workspace.
    const up = await put("keyed-upload", token!, htmlZip("hi"));
    expect(up.status).toBe(200);
    expect((await readJson(up)).workspace).toBe(rootWs);

    const keyId = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM api_keys WHERE name = 'lifecycle' AND revoked_at IS NULL AND workspace_id = ?",
      )
      .get(rootWs)!.id;

    // Roll: response reveals a new token; the old one is dead, the new one works,
    // and the replacement carries the same name.
    const rolled = await fetch(`${base}/settings/${rootWs}/keys/${keyId}/roll`, form({}));
    expect(rolled.status).toBe(200);
    const newToken = (await rolled.text()).match(TOKEN_RE)?.[0];
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(token);

    expect((await put("after-roll", token!, htmlZip("x"))).status).toBe(401); // old dead
    expect((await put("after-roll", newToken!, htmlZip("x"))).status).toBe(200); // new works

    // Same name survived the roll — and it is a different row from the revoked one.
    const replacement = db
      .query<{ id: string; name: string }, [string]>(
        "SELECT id, name FROM api_keys WHERE workspace_id = ? AND name = 'lifecycle' AND revoked_at IS NULL",
      )
      .get(rootWs)!;
    expect(replacement.name).toBe("lifecycle");
    expect(replacement.id).not.toBe(keyId);

    // Revoke: 303 back to settings, and the key stops authenticating.
    const revoked = await fetch(
      `${base}/settings/${rootWs}/keys/${replacement.id}/revoke`,
      form({}),
    );
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe(`/settings/${rootWs}`);
    expect((await put("after-revoke", newToken!, htmlZip("x"))).status).toBe(401);
  });
});

// ---- invite mint reveal ----

describe("invite mint", () => {
  test("POST /settings/<ws>/invites reveals a single-use invite URL once", async () => {
    const r = await fetch(`${base}/settings/${rootWs}/invites`, form({}));
    expect(r.status).toBe(200);
    const body = await r.text();
    const m = body.match(/\/invite\/(inv_[0-9abcdefghjkmnpqrstvwxyz]{10})/);
    expect(m).toBeTruthy();
    expect(body).toContain("single use");
    // The invite exists, unaccepted, in this workspace.
    const inv = db
      .query<{ workspace_id: string; accepted_at: number | null }, [string]>(
        "SELECT workspace_id, accepted_at FROM invites WHERE token = ?",
      )
      .get(m![1]!)!;
    expect(inv.workspace_id).toBe(rootWs);
    expect(inv.accepted_at).toBeNull();
  });
});

// ---- name / visibility mutations ----

describe("settings mutations", () => {
  test("rename + visibility persist and redirect back", async () => {
    const rn = await fetch(`${base}/settings/${rootWs}/name`, form({ name: "Renamed WS" }));
    expect(rn.status).toBe(303);
    expect(rn.headers.get("location")).toBe(`/settings/${rootWs}`);
    expect(
      db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE id = ?").get(rootWs)!
        .name,
    ).toBe("Renamed WS");

    const vis = await fetch(`${base}/settings/${rootWs}/visibility`, form({ visibility: "private" }));
    expect(vis.status).toBe(303);
    expect(
      db.query<{ visibility: string }, [string]>("SELECT visibility FROM workspaces WHERE id = ?").get(
        rootWs,
      )!.visibility,
    ).toBe("private");
    // restore so it doesn't disturb other assumptions
    await fetch(`${base}/settings/${rootWs}/visibility`, form({ visibility: "public" }));
  });

  test("empty name rejected (400); bad visibility rejected (400)", async () => {
    expect((await fetch(`${base}/settings/${rootWs}/name`, form({ name: "  " }))).status).toBe(400);
    expect(
      (await fetch(`${base}/settings/${rootWs}/visibility`, form({ visibility: "secret" }))).status,
    ).toBe(400);
  });
});

// ---- workspace creation ----

describe("workspace creation", () => {
  test("POST /workspaces creates a public ws, seats the creator, redirects to its settings", async () => {
    const r = await fetch(`${base}/workspaces`, form({ name: "Fresh Space" }));
    expect(r.status).toBe(303);
    const loc = r.headers.get("location")!;
    expect(loc).toMatch(/^\/settings\/ws_[0-9abcdefghjkmnpqrstvwxyz]{10}$/);
    const wsId = loc.slice("/settings/".length);

    const wsRow = db
      .query<{ visibility: string; name: string }, [string]>(
        "SELECT visibility, name FROM workspaces WHERE id = ?",
      )
      .get(wsId)!;
    expect(wsRow.name).toBe("Fresh Space");
    expect(wsRow.visibility).toBe("public");
    expect(
      db.query("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?").get(wsId, rootUser),
    ).not.toBeNull();

    // The creator can load the new workspace's settings page.
    const settings = await fetch(`${base}/settings/${wsId}`);
    expect(settings.status).toBe(200);
    expect(await settings.text()).toContain("Fresh Space");
  });

  test("empty workspace name rejected (400)", async () => {
    expect((await fetch(`${base}/workspaces`, form({ name: "" }))).status).toBe(400);
  });
});

// ---- CSRF / origin guard ----

describe("origin guard", () => {
  test("a mutation with a cross-origin Origin header is refused (403)", async () => {
    const r = await fetch(
      `${base}/settings/${rootWs}/name`,
      form({ name: "hijack" }, { origin: "http://evil.example" }),
    );
    expect(r.status).toBe(403);
    // The name was not changed by the refused request.
    expect(
      db.query<{ name: string }, [string]>("SELECT name FROM workspaces WHERE id = ?").get(rootWs)!
        .name,
    ).not.toBe("hijack");
  });
});

// ---- cross-user authz (needs real forged sessions → subprocess with auth on) ----

describe("cross-user authorization (subprocess, real auth)", () => {
  test("non-member 404/403, key ownership, invite accept flow", async () => {
    const script = join(import.meta.dir, "api-mutations.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
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
});
