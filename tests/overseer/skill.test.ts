import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { config } from "../../src/config";
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
    expect(doc).toContain("{ placement, modules[], coverage[] }");
    expect(doc).toContain("{ id, title, paths[], body, refs[] }");
    expect(doc).toContain("{ id, title, significance, paragraph, hunks[], fileNotes[] }");
    // Every list is required, sent as [] when unused: the doc must not call one optional.
    expect(doc).toContain("Every list field in the");
    expect(doc).not.toContain("optional `fileNotes[]`");
  });

  test("documents answering an annotation as the skill's own act", () => {
    expect(doc).toContain("POST /api/reviews/:slug/annotations");
    expect(doc).toContain("GET /api/reviews/:slug");
    expect(doc).toContain("{ document, version, latestVersion, ... }");
    expect(doc).toContain("document.annotations");
    expect(doc).toContain('"answer"');
  });

  test("budget numbers match BUDGETS", () => {
    // Whole table rows, so a number is pinned to its position: a bare substring search
    // for "12" or "16" passes off the character caps and the worked example's hunk id.
    // The minimum has its own column: two witnesses read "2 to 8 | +4" as a floor that
    // scaled to 14 on a four-pull-request stack and padded to reach it.
    expect(doc).toContain(
      `| statements | ${BUDGETS.statements.min} | ${BUDGETS.statements.base} | +${BUDGETS.statements.perExtraPr} | ${BUDGETS.statements.ceiling} |`,
    );
    expect(doc).toContain(
      `| groups | ${BUDGETS.groups.min} | ${BUDGETS.groups.base} | +${BUDGETS.groups.perExtraPr} | ${BUDGETS.groups.ceiling} |`,
    );
    expect(doc).toContain(
      `| notes | ${BUDGETS.notes.min} | ${BUDGETS.notes.max} | +0 | ${BUDGETS.notes.max} |`,
    );
    // And it says so in words, because the table alone was what misled them.
    expect(doc).toContain("Only the maximum scales. The minimum is flat and small.");
    expect(BUDGETS.statements.ceiling).toBe(12);
    expect(BUDGETS.groups.ceiling).toBe(16);
    expect(doc).toContain("decomposition");
  });

  test("separates attributed intent, the witness account, and implementation", () => {
    expect(doc).toContain("The overview gives the forest. The walkthrough");
    expect(doc).toContain("`authorIntent` paraphrases only the problem");
    expect(doc).toContain("The summary is the witness account");
    expect(doc).toContain("For a stack, combine them into the net intent");
    expect(doc).toContain("control flow, data flow, state transition or");
    expect(doc).toContain("perform a sprawl check");
    expect(doc).toContain("module that owns the policy or state");
    expect(doc).toContain("Use plain technical English.");
  });

  test("names the graded failure modes", () => {
    expect(doc).toContain("assurance-filed-as-risk");
    expect(doc).toContain("label-prose");
    expect(doc).toContain("stack-as-changelog");
    expect(doc).toContain("walkthrough-as-inventory");
    expect(doc).toContain("sprawl-without-an-owner");
    expect(doc).toContain("intent-substitution");
    expect(doc).toContain("unclaimed-churn-hidden-in-a-big-group");
    expect(doc).toContain("summary-buries-result");
  });

  test("covers the publish contract", () => {
    expect(doc).toContain("{ slug, title, authorIntent, summary");
    expect(doc).toContain("{ repo, number, gist, detail, detailRef, parent }");
    expect(doc).not.toContain("{ id, repo, number");
    expect(doc).toContain("POST /api/reviews");
    expect(doc).toContain("multipart/form-data");
    expect(doc).toContain("document");
    expect(doc).toContain("422");
  });

  test("served bytes carry no em dash", () => {
    expect(doc.includes("—")).toBe(false);
  });
});

describe("the agent skill document", () => {
  test("it is served, public and markdown, and says how to install itself", async () => {
    const res = await fetch(`${base}/overseer/agent.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    // It is the file a person saves, so it carries its own frontmatter and says where.
    expect(text.startsWith("---")).toBe(true);
    expect(text).toContain("name: overseer");
    expect(text).toContain("~/.claude/skills/overseer/SKILL.md");
    expect(text).toContain("SEER_API_KEY");
    // The rule the whole design rests on has to survive into the installed copy.
    expect(text).toContain("You do not write the review. A fresh sub-agent does.");
    // It points the witness at the other document rather than repeating it.
    expect(text).toContain("/overseer/skill.md");
  });

  test("the dispatch brief names this deployment, not the canonical one", async () => {
    // The brief is a block the reader is told to copy exactly, so a hardcoded
    // seer.build in it sends every other deployment's witness to the wrong host.
    const text = await (await fetch(`${base}/overseer/agent.md`)).text();
    expect(text).toContain(`Review service: \`${config.baseUrl}\``);
    expect(text).not.toContain("https://seer.build/overseer/skill.md");
    expect(text).toContain(`${config.baseUrl}/overseer/skill.md`);
    // The repo copy still names the canonical host, so this is substitution rather
    // than a document that only works on one deployment.
    const onDisk = await Bun.file(
      `${import.meta.dir}/../../docs/overseer/agent.md`,
    ).text();
    expect(onDisk).toContain("https://seer.build");
  });

  test("the two documents are different documents", async () => {
    const agent = await (await fetch(`${base}/overseer/agent.md`)).text();
    const witness = await (await fetch(`${base}/overseer/skill.md`)).text();
    expect(agent).not.toBe(witness);
    // The witness doc tells an agent what to write; the agent doc tells a person how to
    // dispatch one. Neither should have grown the other's job.
    expect(witness).not.toContain("~/.claude/skills");
    expect(agent).not.toContain("Budgets are the schema");
  });
});
