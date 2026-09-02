import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { tinyId } from "../../src/ids";
import { startServer } from "../../src/server";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let owner = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
});

afterAll(() => server.stop(true));

function workspace(name: string): { id: string; key: string } {
  const id = createWorkspace(name, owner);
  return { id, key: mintApiKey(owner, id, name).token };
}

function headers(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function lineage(workspaceId: string, slug: string): string {
  const id = tinyId("rln");
  const now = Date.now();
  db.run(
    "INSERT INTO review_lineages VALUES (?, ?, ?, 'Acme/Inventory', 77, ?, 'main', ?, ?, 1, NULL, ?, ?, ?, ?)",
    [id, workspaceId, slug, `branch-${slug}`, "a".repeat(40), slug, owner, tinyId("key"), now, now],
  );
  return id;
}

function memberRequest(input: {
  workspaceId: string;
  lineageId: string;
  slug: string;
  revision: number;
  state: "pending" | "failed" | "published";
  retry?: number;
  updatedAt: number;
  superseded?: boolean;
}): string {
  const id = tinyId("wtr");
  const revisionId = tinyId("rvr");
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, '{}', 'inventory', ?)",
    [revisionId, input.workspaceId, input.lineageId, input.slug, input.revision, tinyId("stg"), input.updatedAt],
  );
  db.run(
    "INSERT INTO review_witness_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, input.lineageId, revisionId, input.revision, input.state,
      input.retry ?? 0, input.state === "failed" ? "Witness could not finish." : null,
      input.state === "published" ? tinyId("rac") : null, input.updatedAt, input.updatedAt],
  );
  if (input.superseded) {
    db.run(
      "INSERT INTO review_witness_supersessions VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.workspaceId, input.lineageId, revisionId, tinyId("rvr"), input.updatedAt + 1],
    );
  }
  return id;
}

function stackRequest(input: {
  workspaceId: string;
  slug: string;
  version: number;
  state: "pending" | "failed" | "published";
  retry?: number;
  updatedAt: number;
  superseded?: boolean;
}): string {
  const stackId = tinyId("rsk");
  const manifestId = tinyId("rsm");
  const id = tinyId("rsw");
  db.run(
    "INSERT INTO review_stacks VALUES (?, ?, ?, ?, 'Acme/Inventory', 77, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, ?, ?, ?, ?, ?)",
    [stackId, input.workspaceId, input.slug, input.slug, input.version, owner, tinyId("key"), input.updatedAt, input.updatedAt],
  );
  db.run(
    "INSERT INTO review_stack_witness_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.workspaceId, stackId, manifestId, input.version, input.state, input.retry ?? 0,
      input.state === "failed" ? "Stack witness could not finish." : null,
      input.state === "published" ? tinyId("rsa") : null, input.updatedAt, input.updatedAt],
  );
  if (input.superseded) {
    db.run(
      "INSERT INTO review_stack_witness_supersessions VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.workspaceId, stackId, manifestId, tinyId("rsm"), input.updatedAt + 1],
    );
  }
  return id;
}

describe("hosted witness inventory", () => {
  test("should list pending, retrying, and failed exact work without claiming it", async () => {
    const ws = workspace("witness inventory states");
    const lineageId = lineage(ws.id, "inventory-member");
    const now = Date.now() - 10_000;
    const pending = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-member", revision: 1, state: "pending", updatedAt: now });
    const retrying = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-member", revision: 2, state: "pending", retry: 2, updatedAt: now + 1 });
    const failed = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-member", revision: 3, state: "failed", updatedAt: now + 2 });
    const published = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-member", revision: 4, state: "published", updatedAt: now + 3 });
    const superseded = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-member", revision: 5, state: "pending", updatedAt: now + 4, superseded: true });
    const stackPending = stackRequest({ workspaceId: ws.id, slug: "inventory-stack", version: 1, state: "pending", updatedAt: now });
    const stackFailed = stackRequest({ workspaceId: ws.id, slug: "inventory-stack-failed", version: 2, state: "failed", updatedAt: now + 1 });

    const response = await fetch(`${base}/api/witness-requests`, { headers: headers(ws.key) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as any;
    expect(Object.keys(body)).toEqual(["member", "stack", "truncated"]);
    expect(body.member.map((row: any) => ({ id: row.id, state: row.state }))).toEqual([
      { id: pending, state: "pending" },
      { id: retrying, state: "retrying" },
      { id: failed, state: "failed" },
    ]);
    expect(body.member[0]).toMatchObject({ kind: "member", revision: 1, retryCount: 0, retryUrl: null, priorAccountAvailable: false });
    expect(body.member[0].claimUrl).toBe(`${config.baseUrl}/api/review-witness-requests/${pending}/claim`);
    expect(body.member[2]).toMatchObject({ claimUrl: null, retryUrl: `${config.baseUrl}/api/review-witness-requests/${failed}/retry` });
    expect(body.stack.map((row: any) => ({ id: row.id, state: row.state }))).toEqual([
      { id: stackPending, state: "pending" },
      { id: stackFailed, state: "failed" },
    ]);
    expect(body.truncated).toEqual({ member: 0, stack: 0 });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_witness_claims WHERE workspace_id = ?").get(ws.id)!.n).toBe(0);
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_stack_witness_claims WHERE workspace_id = ?").get(ws.id)!.n).toBe(0);

    const history = await (await fetch(`${base}/api/witness-requests?state=all`, { headers: headers(ws.key) })).json() as any;
    expect(history.member.find((row: any) => row.id === published)?.state).toBe("published");
    expect(history.member.find((row: any) => row.id === superseded)?.state).toBe("superseded");
    expect(history.member.find((row: any) => row.id === superseded)?.claimUrl).toBeNull();
  });

  test("should cap each kind and report the exact omitted count", async () => {
    const ws = workspace("witness inventory cap");
    const lineageId = lineage(ws.id, "inventory-cap");
    for (let index = 0; index < 501; index++) {
      memberRequest({
        workspaceId: ws.id,
        lineageId,
        slug: "inventory-cap",
        revision: index + 1,
        state: "pending",
        updatedAt: index + 1,
      });
    }
    const body = await (await fetch(`${base}/api/witness-requests`, { headers: headers(ws.key) })).json() as any;
    expect(body.member).toHaveLength(500);
    expect(body.truncated).toEqual({ member: 1, stack: 0 });
    expect(body.member[0].revision).toBe(1);
    expect(body.member[499].revision).toBe(500);
  });

  test("should keep workspace privacy and exact claim lease ownership", async () => {
    const ws = workspace("witness inventory lease");
    const lineageId = lineage(ws.id, "inventory-lease");
    const requestId = memberRequest({ workspaceId: ws.id, lineageId, slug: "inventory-lease", revision: 1, state: "pending", updatedAt: Date.now() });
    const secondUser = tinyId("usr");
    db.run("INSERT INTO users VALUES (?, ?, ?)", [secondUser, `inventory-${secondUser}@example.com`, Date.now()]);
    db.run("INSERT INTO memberships VALUES (?, ?, ?)", [ws.id, secondUser, Date.now()]);
    const secondKey = mintApiKey(secondUser, ws.id, "second witness").token;
    const foreign = workspace("witness inventory foreign");

    const noKey = await fetch(`${base}/api/witness-requests`);
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get("cache-control")).toBe("no-store");
    expect((await (await fetch(`${base}/api/witness-requests`, { headers: headers(foreign.key) })).json() as any).member).toEqual([]);
    expect((await fetch(`${base}/api/witness-requests?state=pending`, { headers: headers(ws.key) })).status).toBe(400);

    const first = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, { method: "POST", headers: headers(ws.key) });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/api/review-witness-requests/${requestId}/claim`, { method: "POST", headers: headers(secondKey) });
    expect(second.status).toBe(409);
    expect((await second.json() as any).error).toContain("Another agent holds");
  });
});
