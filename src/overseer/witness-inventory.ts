// The hosted-agent work list.
//
// Inventory is deliberately separate from claiming. A GET observes exact member and
// stack requests but acquires no lease; the returned claim URL still enters the existing
// `(request id, retry count)` arbiter, so two agents that saw the same list cannot both
// own the attempt.

import { requireApiKey } from "../auth";
import { config } from "../config";
import { db } from "../db";
import { json } from "../http";
import {
  latestAccountBeforeRevision,
  workflowWord,
  type WitnessRequestRow,
} from "./revision-db";
import {
  stackWorkflowWord,
  type StackWitnessRequestRow,
} from "./stack-db";

export const WITNESS_INVENTORY_MAX = 500;

type InventoryState = "pending" | "retrying" | "failed" | "published" | "superseded";

interface MemberInventoryRow extends WitnessRequestRow {
  slug: string;
}

interface StackInventoryRow extends StackWitnessRequestRow {
  slug: string;
}

function inventoryJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function memberRows(workspaceId: string, all: boolean): { rows: MemberInventoryRow[]; total: number } {
  const open = all
    ? ""
    : "AND w.state != 'published' AND NOT EXISTS (SELECT 1 FROM review_witness_supersessions s WHERE s.request_id = w.id) ";
  const from =
    "FROM review_witness_requests w JOIN review_lineages l ON l.id = w.lineage_id AND l.workspace_id = w.workspace_id " +
    "WHERE w.workspace_id = ? " + open;
  const total = db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n ${from}`).get(workspaceId)?.n ?? 0;
  const rows = db.query<MemberInventoryRow, [string, number]>(
    `SELECT w.*, l.slug AS slug ${from} ORDER BY w.updated_at ASC, w.id ASC LIMIT ?`,
  ).all(workspaceId, WITNESS_INVENTORY_MAX);
  return { rows, total };
}

function stackRows(workspaceId: string, all: boolean): { rows: StackInventoryRow[]; total: number } {
  const open = all
    ? ""
    : "AND w.state != 'published' AND NOT EXISTS (SELECT 1 FROM review_stack_witness_supersessions s WHERE s.request_id = w.id) ";
  const from =
    "FROM review_stack_witness_requests w JOIN review_stacks s ON s.id = w.stack_id AND s.workspace_id = w.workspace_id " +
    "WHERE w.workspace_id = ? " + open;
  const total = db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n ${from}`).get(workspaceId)?.n ?? 0;
  const rows = db.query<StackInventoryRow, [string, number]>(
    `SELECT w.*, s.slug AS slug ${from} ORDER BY w.updated_at ASC, w.id ASC LIMIT ?`,
  ).all(workspaceId, WITNESS_INVENTORY_MAX);
  return { rows, total };
}

/** GET /api/witness-requests. Key workspace only, and never a claim. */
export function handleListWitnessRequests(req: Request): Response {
  const auth = requireApiKey(req);
  if (auth instanceof Response) {
    auth.headers.set("cache-control", "no-store");
    return auth;
  }
  const rawState = new URL(req.url).searchParams.get("state");
  if (rawState !== null && rawState !== "all") {
    return inventoryJson({ error: "state must be `all` when present." }, 400);
  }
  const all = rawState === "all";
  const members = memberRows(auth.workspaceId, all);
  const stacks = stackRows(auth.workspaceId, all);

  return inventoryJson({
    member: members.rows.map((request) => {
      const state = workflowWord(request) as InventoryState;
      const claimable = state === "pending" || state === "retrying";
      return {
        kind: "member" as const,
        id: request.id,
        slug: request.slug,
        revision: request.revision,
        state,
        retryCount: request.retry_count,
        revisionUrl: `${config.baseUrl}/${request.workspace_id}/r/${request.slug}/rev/${request.revision}`,
        claimUrl: claimable ? `${config.baseUrl}/api/review-witness-requests/${request.id}/claim` : null,
        retryUrl: state === "failed" ? `${config.baseUrl}/api/review-witness-requests/${request.id}/retry` : null,
        priorAccountAvailable:
          latestAccountBeforeRevision(request.workspace_id, request.lineage_id, request.revision) !== null,
        updatedAt: new Date(request.updated_at).toISOString(),
      };
    }),
    stack: stacks.rows.map((request) => {
      const state = stackWorkflowWord(request) as InventoryState;
      const claimable = state === "pending" || state === "retrying";
      return {
        kind: "stack" as const,
        id: request.id,
        slug: request.slug,
        manifest: request.version,
        state,
        retryCount: request.retry_count,
        manifestUrl: `${config.baseUrl}/${request.workspace_id}/r-stacks/${request.slug}/v/${request.version}`,
        claimUrl: claimable ? `${config.baseUrl}/api/review-stack-witness-requests/${request.id}/claim` : null,
        retryUrl: state === "failed" ? `${config.baseUrl}/api/review-stack-witness-requests/${request.id}/retry` : null,
        updatedAt: new Date(request.updated_at).toISOString(),
      };
    }),
    truncated: {
      member: Math.max(0, members.total - members.rows.length),
      stack: Math.max(0, stacks.total - stacks.rows.length),
    },
  });
}
