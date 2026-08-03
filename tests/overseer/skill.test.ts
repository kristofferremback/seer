import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { BUDGETS } from "../../src/overseer/types";
import { hunkId } from "../../src/overseer/diff";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let doc: string;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  doc = await (await fetch(`${base}/overseer/skill.md`)).text();
});

afterAll(() => {
  server.stop(true);
});

describe("overseer skill doc", () => {
  test("GET /overseer/skill.md -> 200 text/markdown, no auth", async () => {
    const r = await fetch(`${base}/overseer/skill.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect((await r.text()).length).toBeGreaterThan(2000);
  });

  test("carries the three settled opening clauses", () => {
    expect(doc).toContain("fresh sub-agent");
    expect(doc).toContain("only through the published record");
    expect(doc).toContain("annotation answers");
  });

  test("states the hunk id format and a worked example that hunkId() reproduces", () => {
    expect(doc).toContain("pr<number>:<path>:@@<old_start>,<old_lines>+<new_start>,<new_lines>");
    expect(doc).toContain(hunkId(41, "src/overseer/diff.ts", 141, 6, 141, 15));
    // The omitted-count case: `@@ -12 +12,3 @@` means a count of 1.
    expect(doc).toContain(hunkId(41, "src/overseer/diff.ts", 12, 1, 12, 3));
  });

  test("states the authored fields the write path requires", () => {
    expect(doc).toContain("{ repo, number, gist, detail, detailRef, parent }");
    expect(doc).toContain("{ id, kind, text, prs[], refs[], body, evidence[] }");
    expect(doc).toContain("{ id, kind, text, body, checks[], refs[], evidence[] }");
    expect(doc).toContain("{ id, title, significance, paragraph, hunks[], fileNotes[] }");
    // Every list is required, sent as [] when unused: the doc must not call one optional.
    expect(doc).toContain("Every list field in the");
    expect(doc).not.toContain("optional `fileNotes[]`");
  });

  test("documents answering an annotation as the skill's own act", () => {
    expect(doc).toContain("POST /api/reviews/:slug/annotations");
    expect(doc).toContain("GET /api/reviews/:slug");
    expect(doc).toContain('"answer"');
  });

  test("budget numbers match BUDGETS", () => {
    // Whole table rows, so a number is pinned to its position: a bare substring search
    // for "12" or "16" passes off the character caps and the worked example's hunk id.
    expect(doc).toContain(
      `| statements | ${BUDGETS.statements.min} to ${BUDGETS.statements.base} | +${BUDGETS.statements.perExtraPr} | ${BUDGETS.statements.ceiling} |`,
    );
    expect(doc).toContain(
      `| groups | ${BUDGETS.groups.min} to ${BUDGETS.groups.base} | +${BUDGETS.groups.perExtraPr} | ${BUDGETS.groups.ceiling} |`,
    );
    expect(doc).toContain(
      `| notes | ${BUDGETS.notes.min} to ${BUDGETS.notes.max} | +0 | ${BUDGETS.notes.max} |`,
    );
    expect(BUDGETS.statements.ceiling).toBe(12);
    expect(BUDGETS.groups.ceiling).toBe(16);
    expect(doc).toContain("decomposition");
  });

  test("names the graded failure modes", () => {
    expect(doc).toContain("assurance-filed-as-risk");
    expect(doc).toContain("label-prose");
    expect(doc).toContain("unclaimed-churn-hidden-in-a-big-group");
    expect(doc).toContain("summary-buries-intent");
  });

  test("covers the publish contract", () => {
    expect(doc).toContain("POST /api/reviews");
    expect(doc).toContain("multipart/form-data");
    expect(doc).toContain("document");
    expect(doc).toContain("422");
  });

  test("served bytes carry no em dash", () => {
    expect(doc.includes("—")).toBe(false);
  });
});
