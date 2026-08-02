import { test, expect, describe } from "bun:test";
import {
  REINDEX_EPSILON,
  reindexSignificance,
  validatePublish,
  type DerivedFacts,
  type PublishPayload,
  type ValidationError,
} from "../../src/overseer/validate";
import {
  GOLDEN_BUNDLE_SLUG,
  GOLDEN_BUNDLE_VERSION,
  GOLDEN_HEAD_SHA_12,
  GOLDEN_HEAD_SHA_13,
  GOLDEN_OUTSIDE_PATH,
  GOLDEN_HUNKS,
  GOLDEN_REPO,
  goldenBundleExists,
  goldenDerived,
  goldenPayload,
  makeHunk,
} from "./fixtures/golden-review";

const SHA = GOLDEN_HEAD_SHA_12;

function run(
  payload: PublishPayload,
  derived: DerivedFacts = goldenDerived(),
  prior: Parameters<typeof validatePublish>[2] = null,
) {
  return validatePublish(payload, derived, prior, { bundleExists: goldenBundleExists });
}

function golden() {
  return goldenPayload();
}

function rules(errors: ValidationError[]): string[] {
  return errors.map((e) => e.rule);
}

function find(errors: ValidationError[], rule: string): ValidationError {
  const hit = errors.find((e) => e.rule === rule);
  expect(hit, `expected a ${rule} error, got ${JSON.stringify(rules(errors))}`).toBeDefined();
  return hit!;
}

// ---- a synthetic review, sized to order ----
//
// Budget tests need reviews of a shape the golden fixture does not have: seven
// statements on one pull request, thirteen on four. This builds one that is otherwise
// valid, so the only errors it can produce are the ones the test is about.

function synth(opts: {
  prCount: number;
  statements: number;
  groups?: number;
  notes?: number;
}): { payload: PublishPayload; derived: DerivedFacts } {
  const prCount = opts.prCount;
  const groupCount = opts.groups ?? 2;
  const prs = Array.from({ length: prCount }, (_, i) => i + 1);
  const hunks = prs.flatMap((n) =>
    Array.from({ length: groupCount }, (_, g) =>
      makeHunk({
        prNumber: n,
        path: `src/pr${n}/file${g}.ts`,
        sha: SHA,
        oldStart: 1 + g,
        oldLines: 2,
        newStart: 1 + g,
        newLines: 3,
      }),
    ),
  );
  const derived: DerivedFacts = {
    prs: prs.map((n) => ({
      repo: GOLDEN_REPO,
      number: n,
      hunks: hunks.filter((h) => h.prNumber === n),
    })),
  };
  const ref = (path: string) => ({
    repo: GOLDEN_REPO,
    sha: SHA,
    path,
    startLine: 1,
    endLine: 3,
  });
  const payload: PublishPayload = {
    title: "A synthetic review",
    summary: "It exists to be counted.",
    prs: prs.map((n) => ({
      repo: GOLDEN_REPO,
      number: n,
      gist: `Pull request ${n}`,
      detail: "One sentence of detail.",
      detailRef: ref(`src/pr${n}/file0.ts`),
    })),
    statements: Array.from({ length: opts.statements }, (_, i) => ({
      id: `st_${i}`,
      kind: "change" as const,
      text: `Statement ${i}`,
      // Every pull request is realized: the first statements spread across them.
      prs: [`${GOLDEN_REPO}#${prs[i % prCount]}`],
      refs: [ref(`src/pr${prs[i % prCount]}/file0.ts`)],
      body: "Body.",
      evidence: [],
    })),
    notes: Array.from({ length: opts.notes ?? 0 }, (_, i) => ({
      id: `nt_${i}`,
      kind: "note" as const,
      text: `Note ${i}`,
      body: "Body.",
      checks: [],
      refs: [],
      evidence: [],
    })),
    groups: Array.from({ length: groupCount }, (_, g) => ({
      id: `gr_${g}`,
      title: `Group ${g}`,
      significance: g + 1,
      paragraph: "Paragraph.",
      hunks: hunks.filter((h) => h.path.endsWith(`file${g}.ts`)).map((h) => h.id),
      fileNotes: [],
    })),
    attachments: [],
  };
  return { payload, derived };
}

// ---- the golden fixture ----

describe("the golden payload", () => {
  test("returns zero errors and zero warnings", () => {
    const result = run(golden());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("exercises every evidence kind", () => {
    const kinds = new Set(
      golden()
        .statements.flatMap((s) => s.evidence)
        .concat(golden().notes.flatMap((n) => n.evidence))
        .map((e) => e.type),
    );
    for (const kind of ["ref", "payload", "figure", "example", "attachment", "bundle"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  test("its significance values need no reindex", () => {
    expect(run(golden()).significance).toBeNull();
  });

  test("exercises every statement kind", () => {
    const kinds = new Set(golden().statements.map((s) => s.kind));
    for (const kind of ["add", "change", "remove"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  test("carries a ref outside the change, so origin has both values", () => {
    const changed = new Set(
      goldenDerived().prs.flatMap((pr) => pr.hunks.map((h) => `${h.sha}:${h.path}`)),
    );
    const refs = golden().statements.flatMap((s) => s.refs);
    expect(refs.some((r) => changed.has(`${r.sha}:${r.path}`))).toBe(true);
    const outside = refs.filter((r) => !changed.has(`${r.sha}:${r.path}`));
    expect(outside.map((r) => r.path)).toContain(GOLDEN_OUTSIDE_PATH);
  });

  test("names a bundle at a pinned version as well as at latest", () => {
    const bundles = golden()
      .statements.flatMap((s) => s.evidence)
      .filter((e) => e.type === "bundle")
      .map((e) => (e.type === "bundle" ? e.bundle.version : undefined));
    expect(bundles).toContain(null);
    expect(bundles).toContain(GOLDEN_BUNDLE_VERSION);
  });
});

// ---- rule: caps, with pull-request scaling ----

describe("count caps scale with decomposition", () => {
  test("7 statements on one pull request is an error with overage 1", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 7 });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "cap_count");
    expect(err.field).toBe("statements");
    expect(err.overage).toBe(1);
  });

  test("7 statements on two pull requests is clean and unwarned", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 7 });
    const result = validatePublish(payload, derived, null, {});
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("8 statements on two pull requests is clean but warns about decomposition", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 8 });
    const result = validatePublish(payload, derived, null, {});
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.field === "statements");
    expect(warning?.rule).toBe("decomposition");
  });

  test("13 statements on four pull requests hits the absolute ceiling of 12", () => {
    const { payload, derived } = synth({ prCount: 4, statements: 13 });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "cap_count");
    expect(err.field).toBe("statements");
    expect(err.overage).toBe(1);
    expect(err.message).toContain("12");
  });

  test("two statements is below the floor, by a shortfall of one", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 2 });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "below_minimum");
    expect(err.field).toBe("statements");
    expect(err.shortfall).toBe(1);
    expect(err.overage).toBeUndefined();
  });

  test("seven notes is an error whatever the decomposition", () => {
    const { payload, derived } = synth({ prCount: 4, statements: 4, notes: 7 });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "notes");
    expect(err?.rule).toBe("cap_count");
    expect(err?.overage).toBe(1);
  });
});

describe("character caps name the field and the overage", () => {
  test("a title over 80 characters", () => {
    const payload = golden();
    payload.title = "x".repeat(83);
    const err = find(run(payload).errors, "cap_chars");
    expect(err.field).toBe("title");
    expect(err.overage).toBe(3);
  });

  test("a statement text over 120 characters", () => {
    const payload = golden();
    payload.statements[0]!.text = "y".repeat(125);
    const err = run(payload).errors.find((e) => e.field === "statements[0].text");
    expect(err?.rule).toBe("cap_chars");
    expect(err?.overage).toBe(5);
  });

  test("a summary over 600 characters, and over two paragraphs", () => {
    const payload = golden();
    payload.summary = ["a".repeat(300), "b".repeat(300), "c".repeat(20)].join("\n\n");
    const errors = run(payload).errors;
    const chars = errors.find((e) => e.rule === "cap_chars");
    expect(chars?.field).toBe("summary");
    expect(chars?.overage).toBe(24);
    const paras = find(errors, "cap_paragraphs");
    expect(paras.field).toBe("summary");
    expect(paras.overage).toBe(1);
  });

  test("a note carrying six checks", () => {
    const payload = golden();
    payload.notes[0]!.checks = Array.from({ length: 6 }, (_, i) => `check ${i}`);
    const err = run(payload).errors.find((e) => e.field === "notes[0].checks");
    expect(err?.rule).toBe("cap_count");
    expect(err?.overage).toBe(1);
  });
});

// ---- rule: the walkthrough is a partition of the diff ----

describe("every hunk belongs to exactly one group", () => {
  test("an unclaimed hunk names its path, its range and its id", () => {
    const payload = golden();
    const dropped = GOLDEN_HUNKS.tests;
    payload.groups[1]!.hunks = payload.groups[1]!.hunks.filter((id) => id !== dropped.id);
    const err = find(run(payload).errors, "hunk_unclaimed");
    expect(err.field).toBe("groups");
    expect(err.message).toContain(dropped.path);
    expect(err.message).toContain("@@ -1,0 +1,24 @@");
    expect(err.message).toContain(dropped.id);
  });

  test("a double-claimed hunk names both groups", () => {
    const payload = golden();
    payload.groups[0]!.hunks.push(GOLDEN_HUNKS.routes.id);
    const err = find(run(payload).errors, "hunk_double_claimed");
    expect(err.message).toContain("gr_api");
    expect(err.message).toContain("gr_gate");
    expect(err.message).toContain(GOLDEN_HUNKS.routes.path);
  });

  test("a hunk id that is in no pull request's diff is rejected", () => {
    const payload = golden();
    payload.groups[0]!.hunks.push("pr12:src/ghost.ts:@@1,2+1,3");
    const err = find(run(payload).errors, "hunk_unknown");
    expect(err.field).toBe("groups[0].hunks[2]");
    expect(err.message).toContain("src/ghost.ts");
  });
});

// ---- rule: every pull request is realized by at least one statement ----

test("a pull request no statement realizes is an error naming it", () => {
  const payload = golden();
  for (const s of payload.statements) {
    s.prs = s.prs.filter((k) => k !== `${GOLDEN_REPO}#12`);
  }
  const err = find(run(payload).errors, "pr_unrealized");
  expect(err.field).toBe("prs[0]");
  expect(err.message).toContain(`${GOLDEN_REPO}#12`);
});

// ---- rule: every prs[] entry is in the review ----

test("a statement naming a pull request outside the review is an error", () => {
  const payload = golden();
  payload.statements[0]!.prs = [`${GOLDEN_REPO}#99`];
  const errors = run(payload).errors;
  const err = find(errors, "pr_not_in_review");
  expect(err.field).toBe("statements[0].prs[0]");
  expect(err.message).toContain("#99");
});

// ---- rule: every statement has at least one ref ----

test("a statement with no ref is an error", () => {
  const payload = golden();
  payload.statements[1]!.refs = [];
  const err = find(run(payload).errors, "statement_unbacked");
  expect(err.field).toBe("statements[1].refs");
});

// ---- rule: a risk note has checks or a ref into a changed hunk ----

describe("a risk has to point at something falsifiable", () => {
  test("no checks and no ref is an error", () => {
    const payload = golden();
    payload.notes[0]!.checks = [];
    payload.notes[0]!.refs = [];
    const err = find(run(payload).errors, "risk_unfalsifiable");
    expect(err.field).toBe("notes[0]");
  });

  test("no checks but a ref into a changed hunk is fine", () => {
    const payload = golden();
    payload.notes[0]!.checks = [];
    expect(run(payload).errors).toEqual([]);
  });

  test("no checks and a ref outside every changed hunk is an error", () => {
    const payload = golden();
    payload.notes[0]!.checks = [];
    payload.notes[0]!.refs = [
      { repo: GOLDEN_REPO, sha: SHA, path: "src/untouched.ts", startLine: 1, endLine: 4 },
    ];
    expect(rules(run(payload).errors)).toContain("risk_unfalsifiable");
  });

  test("no checks and a ref pinned outside the review is an error", () => {
    const payload = golden();
    payload.notes[0]!.checks = [];
    // The path is touched by this review, the sha is not part of it.
    payload.notes[0]!.refs[0]!.sha = "4444444444444444444444444444444444444444";
    expect(rules(run(payload).errors)).toContain("risk_unfalsifiable");
  });

  test("a plain note needs neither", () => {
    const payload = golden();
    payload.notes[1]!.checks = [];
    payload.notes[1]!.refs = [];
    expect(run(payload).errors).toEqual([]);
  });
});

// ---- rule: one repo, until multi-repo is actually built ----

describe("a review spans one repo", () => {
  test("a second repo among the pull requests is rejected", () => {
    const payload = golden();
    payload.prs[1]!.repo = "acme/other";
    const err = find(run(payload).errors, "single_repo");
    expect(err.field).toBe("prs[1].repo");
  });

  test("a ref into another repo is rejected", () => {
    const payload = golden();
    payload.statements[0]!.refs[0]!.repo = "acme/other";
    const err = run(payload).errors.find((e) => e.rule === "single_repo");
    expect(err?.field).toBe("statements[0].refs[0].repo");
  });
});

// ---- rule: markdown outside the subset, and the one-line rule ----

describe("authored text stays inside the subset", () => {
  test("a heading in a statement body is rejected by name", () => {
    const payload = golden();
    payload.statements[0]!.body = "# Not allowed\n\nprose";
    const err = find(run(payload).errors, "markdown_construct");
    expect(err.field).toBe("statements[0].body");
    expect(err.message).toContain("heading");
  });

  test("a table in the summary is rejected by name", () => {
    const payload = golden();
    payload.summary = "a | b\n--- | ---\n1 | 2";
    const err = find(run(payload).errors, "markdown_construct");
    expect(err.field).toBe("summary");
  });

  test("markup in a one-line field is rejected", () => {
    const payload = golden();
    payload.prs[0]!.gist = "**bold** gist";
    const err = run(payload).errors.find((e) => e.field === "prs[0].gist");
    expect(err?.rule).toBe("markdown_construct");
  });

  test("inline code in a one-line field is allowed", () => {
    const payload = golden();
    payload.prs[0]!.gist = "Reuse the `session()` gate";
    expect(run(payload).errors).toEqual([]);
  });

  test("a fenced code block in a group paragraph is allowed", () => {
    const payload = golden();
    payload.groups[0]!.paragraph = "The gate:\n\n```ts\nsession(req);\n```\n";
    expect(run(payload).errors).toEqual([]);
  });
});

// ---- rule: attachments ----

describe("attachments", () => {
  test("an attachment nothing references is rejected", () => {
    const payload = golden();
    payload.statements[2]!.evidence = [];
    const err = find(run(payload).errors, "attachment_unreferenced");
    expect(err.field).toBe("attachments[0]");
    expect(err.message).toContain("att_gate");
  });

  test("an attachment without alt text is rejected", () => {
    const payload = golden();
    payload.attachments[0]!.alt = "";
    const err = run(payload).errors.find((e) => e.field === "attachments[0].alt");
    expect(err?.rule).toBe("required");
  });

  test("alt text over 140 characters names its overage", () => {
    const payload = golden();
    payload.attachments[0]!.alt = "z".repeat(148);
    const err = run(payload).errors.find((e) => e.field === "attachments[0].alt");
    expect(err?.rule).toBe("cap_chars");
    expect(err?.overage).toBe(8);
  });

  test("a non-image attachment is rejected", () => {
    const payload = golden();
    payload.attachments[0]!.mediaType = "application/pdf";
    const err = find(run(payload).errors, "attachment_media_type");
    expect(err.field).toBe("attachments[0].mediaType");
  });

  test("evidence naming an attachment that was not uploaded is rejected", () => {
    const payload = golden();
    payload.statements[2]!.evidence = [{ type: "attachment", attachment: { id: "att_ghost" } }];
    const errors = run(payload).errors;
    expect(rules(errors)).toContain("attachment_unknown");
    expect(rules(errors)).toContain("attachment_unreferenced");
  });
});

// ---- rule: bundle evidence resolves in the workspace ----

describe("bundle evidence", () => {
  test("a bundle that is not in the workspace is rejected", () => {
    const payload = golden();
    const bundle = payload.statements[1]!.evidence[2]!;
    if (bundle.type !== "bundle") throw new Error("fixture drifted");
    bundle.bundle.slug = "not-here";
    const err = find(run(payload).errors, "bundle_unresolved");
    expect(err.field).toBe("statements[1].evidence[2].bundle");
    expect(err.message).toContain("not-here");
  });

  test("with no resolver injected, nothing resolves", () => {
    const result = validatePublish(golden(), goldenDerived(), null, {});
    expect(rules(result.errors)).toContain("bundle_unresolved");
  });

  test("a bundle caption is required", () => {
    const payload = golden();
    const bundle = payload.statements[1]!.evidence[2]!;
    if (bundle.type !== "bundle") throw new Error("fixture drifted");
    bundle.bundle.caption = "";
    const err = run(payload).errors.find(
      (e) => e.field === "statements[1].evidence[2].bundle.caption",
    );
    expect(err?.rule).toBe("required");
  });
});

// ---- rule: refs are pinned pointers ----

describe("refs", () => {
  test("a ref that is not pinned to a full sha is rejected", () => {
    const payload = golden();
    payload.statements[0]!.refs[0]!.sha = "main";
    const err = find(run(payload).errors, "ref_unpinned");
    expect(err.field).toBe("statements[0].refs[0].sha");
  });

  test("a backwards range is rejected", () => {
    const payload = golden();
    payload.statements[0]!.refs[0]!.startLine = 90;
    const err = find(run(payload).errors, "ref_range");
    expect(err.field).toBe("statements[0].refs[0]");
  });

  test("a highlight outside the range is rejected", () => {
    const payload = golden();
    payload.statements[0]!.refs[0]!.highlight = [200];
    const err = find(run(payload).errors, "ref_highlight_outside");
    expect(err.field).toBe("statements[0].refs[0].highlight");
  });
});

// ---- rule: an id reused from the prior version keeps its type ----

describe("id reuse across versions", () => {
  const prior = {
    statements: [{ id: "st_gate" }],
    notes: [{ id: "nt_session_cookie" }],
    groups: [{ id: "gr_gate" }],
  };

  test("reusing ids for the same types is fine", () => {
    expect(run(golden(), goldenDerived(), prior).errors).toEqual([]);
  });

  test("reusing a statement id for a group is an error naming both types", () => {
    const payload = golden();
    payload.groups[0]!.id = "st_gate";
    const err = find(run(payload, goldenDerived(), prior).errors, "id_type_changed");
    expect(err.field).toBe("groups[0].id");
    expect(err.message).toContain("statement");
    expect(err.message).toContain("group");
  });

  test("two entities sharing an id within one version is an error", () => {
    const payload = golden();
    payload.notes[0]!.id = "st_api";
    const err = find(run(payload).errors, "id_duplicated");
    expect(err.field).toBe("notes[0].id");
  });
});

// ---- rule: significance reindex ----

describe("significance reindex", () => {
  test("well-spaced values are left alone", () => {
    expect(reindexSignificance([{ id: "b", significance: 2 }, { id: "a", significance: 1 }])).toBeNull();
  });

  test("neighbours inside the epsilon get evenly spaced values", () => {
    const out = reindexSignificance([
      { id: "a", significance: 1 },
      { id: "b", significance: 1 + REINDEX_EPSILON / 2 },
      { id: "c", significance: 4 },
    ]);
    expect(out).toEqual([
      { id: "a", significance: 1 },
      { id: "b", significance: 2 },
      { id: "c", significance: 3 },
    ]);
  });

  test("equal values reindex, and ties break by id", () => {
    const out = reindexSignificance([
      { id: "zz", significance: 2 },
      { id: "aa", significance: 2 },
    ]);
    expect(out).toEqual([
      { id: "aa", significance: 1 },
      { id: "zz", significance: 2 },
    ]);
  });

  test("validatePublish returns the respaced values", () => {
    const payload = golden();
    payload.groups[1]!.significance = 1;
    const result = run(payload);
    expect(result.significance).toEqual([
      { id: "gr_api", significance: 1 },
      { id: "gr_gate", significance: 2 },
    ]);
  });
});

// ---- rule: every pull request in the payload has derived facts ----

describe("a pull request with no derived facts", () => {
  test("is rejected rather than counting as a fully claimed diff", () => {
    const payload = golden();
    payload.prs.push({
      repo: GOLDEN_REPO,
      number: 99,
      gist: "A pull request Overseer never derived",
      detail: "It has no facts behind it.",
      detailRef: {
        repo: GOLDEN_REPO,
        sha: GOLDEN_HEAD_SHA_13,
        path: "src/routes/reviews.ts",
        startLine: 1,
        endLine: 32,
      },
      parent: null,
    });
    payload.statements[0]!.prs.push(`${GOLDEN_REPO}#99`);
    const err = find(run(payload).errors, "pr_not_derived");
    expect(err.field).toBe("prs[2]");
    expect(err.message).toContain(`${GOLDEN_REPO}#99`);
  });
});

// ---- rule: pr.detail is authored prose, and gated like every other authored field ----

describe("a pull request detail", () => {
  test("rejects raw html by name", () => {
    const payload = golden();
    payload.prs[0]!.detail = "<script>alert(1)</script> is not prose.";
    const err = run(payload).errors.find((e) => e.field === "prs[0].detail");
    expect(err?.rule).toBe("markdown_construct");
    expect(err?.message).toContain("raw HTML");
  });

  test("rejects a heading by name", () => {
    const payload = golden();
    payload.prs[0]!.detail = "## A heading.";
    const err = run(payload).errors.find((e) => e.field === "prs[0].detail");
    expect(err?.rule).toBe("markdown_construct");
    expect(err?.message).toContain("heading");
  });

  test("caps its characters, so one endless sentence cannot slip through", () => {
    const payload = golden();
    payload.prs[0]!.detail = `${"d".repeat(243)}.`;
    const err = run(payload).errors.find(
      (e) => e.field === "prs[0].detail" && e.rule === "cap_chars",
    );
    expect(err?.overage).toBe(4);
  });

  test("caps its sentences", () => {
    const payload = golden();
    payload.prs[0]!.detail = "One. Two. Three.";
    const err = find(run(payload).errors, "cap_sentences");
    expect(err.field).toBe("prs[0].detail");
    expect(err.overage).toBe(1);
  });
});

// ---- rule: ids are unique within a version, attachments included ----

test("two attachments sharing an id is an error", () => {
  const payload = golden();
  payload.attachments.push({ ...payload.attachments[0]!, alt: "A second upload" });
  const err = find(run(payload).errors, "id_duplicated");
  expect(err.field).toBe("attachments[1].id");
});

// ---- rule: authored bodies are not blank, and a group is not empty ----

describe("authored prose is present", () => {
  test("a blank statement body is rejected", () => {
    const payload = golden();
    payload.statements[0]!.body = "";
    const err = run(payload).errors.find((e) => e.field === "statements[0].body");
    expect(err?.rule).toBe("required");
  });

  test("a blank note body is rejected", () => {
    const payload = golden();
    payload.notes[0]!.body = "   ";
    const err = run(payload).errors.find((e) => e.field === "notes[0].body");
    expect(err?.rule).toBe("required");
  });

  test("a blank group paragraph is rejected", () => {
    const payload = golden();
    payload.groups[0]!.paragraph = "";
    const err = run(payload).errors.find((e) => e.field === "groups[0].paragraph");
    expect(err?.rule).toBe("required");
  });

  test("a group claiming no hunk is rejected", () => {
    const payload = golden();
    payload.groups.push({
      id: "gr_empty",
      title: "Nothing in particular",
      significance: 3,
      paragraph: "It claims no hunk.",
      hunks: [],
      fileNotes: [],
    });
    const err = find(run(payload).errors, "group_empty");
    expect(err.field).toBe("groups[2].hunks");
  });
});

// ---- purity ----

test("the module imports nothing that touches a database or a network", async () => {
  const source = await Bun.file(`${import.meta.dir}/../../src/overseer/validate.ts`).text();
  const imports = source.match(/^import[\s\S]*?from "[^"]+";$/gm) ?? [];
  const froms = imports.map((i) => /from "([^"]+)";$/.exec(i)![1]!);
  expect(froms.sort()).toEqual(["./markdown", "./types"]);
  // A side-effect import runs the module for its side effects alone, which is exactly
  // how `import "./db"` would open SQLite behind a pure signature. A dynamic import
  // hides the same thing behind a call.
  expect(source).not.toMatch(/\bimport\s+["\']/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
  expect(source).not.toContain("bun:sqlite");
});
