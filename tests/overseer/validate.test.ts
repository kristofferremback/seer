import { test, expect, describe } from "bun:test";
import { BUDGETS } from "../../src/overseer/types";
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
  goldenDerivedReview,
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

describe("the golden derived review", () => {
  test("carries the derived fields later steps read, for the payload's pull requests", () => {
    const review = goldenDerivedReview();
    expect(review.prs.map((p) => p.number)).toEqual(goldenPayload().prs.map((p) => p.number));
    for (const pr of review.prs) {
      expect(pr.title.length).toBeGreaterThan(0);
      expect(pr.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(pr.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(pr.baseRef.length).toBeGreaterThan(0);
      expect(pr.author).not.toBeNull();
      expect(Array.isArray(pr.coAuthors)).toBe(true);
      expect(typeof pr.body).toBe("string");
    }
    expect(review.prs[1]!.parent).toBe(12);
    expect(review.slug.length).toBeGreaterThan(0);
    expect(review.version).toBeGreaterThan(0);
    expect(review.attachments.map((a) => a.id)).toEqual(
      goldenPayload().attachments.map((a) => a.id),
    );
    expect(review.attachments[0]!.bytes.length).toBeGreaterThan(0);
  });
});

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

  test("13 statements on four pull requests overruns the budget of 12", () => {
    const { payload, derived } = synth({ prCount: 4, statements: 13 });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "cap_count");
    expect(err.field).toBe("statements");
    expect(err.overage).toBe(1);
    expect(err.message).toContain("12");
  });

  test("the statement budget stops climbing at the ceiling of 12", () => {
    // The linear formula would give 6 + 5*2 = 16 on six pull requests. The ceiling binds.
    const { payload, derived } = synth({ prCount: 6, statements: 13 });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "statements" && e.rule === "cap_count");
    expect(err?.overage).toBe(1);
    expect(err?.message).toContain("12");
  });

  test("9 groups on one pull request is an error with overage 1", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 3, groups: 9 });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "groups" && e.rule === "cap_count");
    expect(err?.overage).toBe(1);
    expect(err?.message).toContain("8");
  });

  test("12 groups on two pull requests is clean but warns about decomposition", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 3, groups: 12 });
    const result = validatePublish(payload, derived, null, {});
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.field === "groups");
    expect(warning?.rule).toBe("decomposition");
    expect(warning?.message).toContain("12");
  });

  test("11 groups on two pull requests is clean and unwarned about groups", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 3, groups: 11 });
    const result = validatePublish(payload, derived, null, {});
    expect(result.errors).toEqual([]);
    expect(result.warnings.find((w) => w.field === "groups")).toBeUndefined();
  });

  test("one group is below the floor, by a shortfall of one", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 3, groups: 1 });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "groups" && e.rule === "below_minimum");
    expect(err?.shortfall).toBe(1);
    expect(err?.overage).toBeUndefined();
  });

  test("the group budget stops climbing at the ceiling of 16", () => {
    // The linear formula would give 8 + 3*4 = 20 on four pull requests. The ceiling binds.
    const { payload, derived } = synth({ prCount: 4, statements: 4, groups: 17 });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "groups" && e.rule === "cap_count");
    expect(err?.overage).toBe(1);
    expect(err?.message).toContain("16");
  });

  test("a review with no pull request is below the floor of one", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 3 });
    payload.prs = [];
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "prs" && e.rule === "below_minimum");
    expect(err?.shortfall).toBe(1);
  });

  test("two statements is below the floor, by a shortfall of one", () => {
    const { payload, derived } = synth({ prCount: 1, statements: 2 });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "below_minimum");
    expect(err.field).toBe("statements");
    expect(err.shortfall).toBe(1);
    expect(err.overage).toBeUndefined();
  });

  test("a pull request named twice is an error naming the second entry", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 7 });
    payload.prs.push({ ...payload.prs[0]! });
    const result = validatePublish(payload, derived, null, {});
    const err = find(result.errors, "pr_duplicated");
    expect(err.field).toBe("prs[2]");
  });

  test("a duplicated pointer does not buy budget: 9 statements still overruns 8", () => {
    const { payload, derived } = synth({ prCount: 2, statements: 9 });
    payload.prs.push({ ...payload.prs[0]! });
    const result = validatePublish(payload, derived, null, {});
    const err = result.errors.find((e) => e.field === "statements" && e.rule === "cap_count");
    expect(err?.overage).toBe(1);
    expect(err?.message).toContain("8");
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

  test("a blank line inside a fenced block is code, not a paragraph break", () => {
    const payload = golden();
    payload.summary = "Intent first.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```";
    const errors = run(payload).errors;
    expect(rules(errors)).not.toContain("cap_paragraphs");
  });

  test("three real paragraphs around a fenced block still overrun the cap", () => {
    const payload = golden();
    payload.summary = "One.\n\n```ts\nconst a = 1;\n```\n\nTwo.\n\nThree.";
    const err = find(run(payload).errors, "cap_paragraphs");
    expect(err.field).toBe("summary");
    expect(err.overage).toBe(2);
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

  test("a hunk repeated inside one group names that group once, with both indices", () => {
    const payload = golden();
    const repeated = payload.groups[0]!.hunks[0]!;
    payload.groups[0]!.hunks.push(repeated);
    const errors = run(payload).errors;
    const err = find(errors, "hunk_repeated");
    expect(err.field).toBe(`groups[0].hunks[${payload.groups[0]!.hunks.length - 1}]`);
    expect(err.message).toContain("hunks[0]");
    expect(rules(errors)).not.toContain("hunk_double_claimed");
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

  test("an attachment without a caption is legal", () => {
    const payload = golden();
    delete (payload.attachments[0] as { caption?: unknown }).caption;
    const result = run(payload);
    expect(result.errors).toEqual([]);
  });

  test("a caption that is not text is still rejected", () => {
    const payload = golden();
    (payload.attachments[0] as { caption?: unknown }).caption = 7;
    const err = run(payload).errors.find((e) => e.field === "attachments[0].caption");
    expect(err?.rule).toBe("not_text");
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

  test("an image media type outside the allowlist is rejected", () => {
    // The stored value is echoed as a response header, so it is an allowlist, not a
    // prefix: a header-shaped string never reaches the wire.
    for (const bad of ["image/svg+xml", "image/png\r\nX-Injected: 1", "image/anything"]) {
      const payload = golden();
      payload.attachments[0]!.mediaType = bad;
      const err = find(run(payload).errors, "attachment_media_type");
      expect(err.field).toBe("attachments[0].mediaType");
    }
    const ok = golden();
    ok.attachments[0]!.mediaType = "image/webp";
    expect(run(ok).errors.find((e) => e.rule === "attachment_media_type")).toBeUndefined();
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

  test("a highlight that is a string is named, not dropped", () => {
    const payload = golden();
    (payload.statements[0]!.refs[0] as { highlight?: unknown }).highlight = "42";
    const err = run(payload).errors.find((e) => e.field === "statements[0].refs[0].highlight");
    expect(err?.rule).toBe("required");
  });

  test("a highlight that is an object is named, not dropped", () => {
    const payload = golden();
    (payload.statements[0]!.refs[0] as { highlight?: unknown }).highlight = { a: 1 };
    const err = run(payload).errors.find((e) => e.field === "statements[0].refs[0].highlight");
    expect(err?.rule).toBe("required");
  });

  test("a ref with no highlight at all stays legal", () => {
    const payload = golden();
    delete (payload.statements[0]!.refs[0] as { highlight?: unknown }).highlight;
    const result = run(payload);
    expect(result.errors).toEqual([]);
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

// ---- rule: kinds are closed lists ----

describe("statement and note kinds come from the doc's closed lists", () => {
  test("the cut `keep` kind is rejected on a statement", () => {
    const payload = golden();
    (payload.statements[0] as { kind: string }).kind = "keep";
    const err = find(run(payload).errors, "kind_unknown");
    expect(err.field).toBe("statements[0].kind");
    expect(err.message).toContain("keep");
  });

  test("an invented note kind is rejected", () => {
    const payload = golden();
    (payload.notes[0] as { kind: string }).kind = "warning";
    const err = find(run(payload).errors, "kind_unknown");
    expect(err.field).toBe("notes[0].kind");
  });
});

// ---- rule: evidence sub-objects come from the doc's closed lists ----

describe("evidence sub-objects come from the doc's closed lists", () => {
  function firstPayloadEvidence(payload: PublishPayload) {
    for (const s of payload.statements) {
      for (const e of s.evidence) if (e.type === "payload") return e.payload;
    }
    throw new Error("the golden payload carries no payload evidence");
  }

  function firstFigure(payload: PublishPayload) {
    for (const s of payload.statements) {
      for (const e of s.evidence) if (e.type === "figure") return e.figure;
    }
    throw new Error("the golden payload carries no figure evidence");
  }

  test("a payload lang outside json | text is rejected", () => {
    const payload = golden();
    (firstPayloadEvidence(payload) as { lang: string }).lang = "yaml";
    const err = find(run(payload).errors, "kind_unknown");
    expect(err.field).toContain(".payload.lang");
    expect(err.message).toContain("yaml");
    expect(err.message).toContain("json, text");
  });

  test("a figure kind other than flow is rejected", () => {
    const payload = golden();
    (firstFigure(payload) as { kind: string }).kind = "sequence";
    const err = find(run(payload).errors, "kind_unknown");
    expect(err.field).toContain(".figure.kind");
    expect(err.message).toContain("sequence");
  });

  test("a figure node state outside normal | muted is rejected", () => {
    const payload = golden();
    (firstFigure(payload).nodes[0] as { state: string }).state = "loud";
    const err = find(run(payload).errors, "kind_unknown");
    expect(err.field).toContain(".figure.nodes[0].state");
    expect(err.message).toContain("loud");
  });

  test("a figure edge naming an id no node declares is a dangling arrow", () => {
    const payload = golden();
    const figure = firstFigure(payload);
    figure.edges.push({ from: "nope", to: "alsonope", label: "" });
    const dangling = run(payload).errors.filter((e) => e.rule === "figure_edge_dangling");
    expect(dangling.length).toBe(2);
    expect(dangling[0]!.field).toContain(`.figure.edges[${figure.edges.length - 1}].from`);
    expect(dangling[0]!.message).toContain("nope");
    expect(dangling[1]!.field).toContain(`.figure.edges[${figure.edges.length - 1}].to`);
    expect(dangling[1]!.message).toContain("alsonope");
  });

  test("a ref highlight that is not a line number is rejected", () => {
    const payload = golden();
    payload.statements[0]!.refs[0]!.highlight = ["42" as unknown as number, Number.NaN];
    const bad = run(payload).errors.filter((e) => e.rule === "ref_highlight_outside");
    expect(bad.length).toBe(2);
    expect(bad[0]!.field).toBe("statements[0].refs[0].highlight");
    expect(bad[0]!.message).toContain("not a line number");
  });
});

// ---- rule: a missing list is a named error, never a crash ----

describe("a body missing a list", () => {
  test("names the absent field instead of throwing", () => {
    const payload = golden();
    delete (payload as { notes?: unknown }).notes;
    const err = find(run(payload).errors, "required");
    expect(err.field).toBe("notes");
  });

  test("a null body is a named 422, not a crash", () => {
    const result = run(null as unknown as PublishPayload);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.rule === "required" && e.field === "prs")).toBe(true);
  });

  test("a prior document missing its lists does not throw", () => {
    const result = run(golden(), goldenDerived(), {} as Parameters<typeof validatePublish>[2]);
    expect(result.errors).toEqual([]);
  });

  test("names an absent list on one entity", () => {
    const payload = golden();
    delete (payload.statements[0] as { refs?: unknown }).refs;
    const err = run(payload).errors.find(
      (e) => e.rule === "required" && e.field === "statements[0].refs",
    );
    expect(err).toBeDefined();
  });
});

// ---- rule: every entity carries an id ----

describe("entity ids", () => {
  test("a blank statement id is a required error, not a duplicate", () => {
    const payload = golden();
    payload.statements[0]!.id = "";
    const errors = run(payload).errors;
    const err = errors.find((e) => e.field === "statements[0].id");
    expect(err?.rule).toBe("required");
    expect(rules(errors)).not.toContain("id_duplicated");
  });

  test("two entities missing their ids do not collide into id_duplicated", () => {
    const payload = golden();
    delete (payload.statements[0] as { id?: string }).id;
    delete (payload.statements[1] as { id?: string }).id;
    const errors = run(payload).errors;
    expect(errors.filter((e) => e.rule === "required" && e.field.endsWith(".id")).length).toBe(2);
    expect(rules(errors)).not.toContain("id_duplicated");
  });
});

// ---- rule: attachments share the id namespace across versions too ----

describe("an attachment id from the prior version", () => {
  test("cannot come back as a statement id", () => {
    const prior = {
      statements: [],
      notes: [],
      groups: [],
      attachments: [{ id: "at_screenshot" }],
    };
    const payload = golden();
    payload.statements[0]!.id = "at_screenshot";
    const err = find(run(payload, goldenDerived(), prior).errors, "id_type_changed");
    expect(err.field).toBe("statements[0].id");
    expect(err.message).toContain("attachment");
    expect(err.message).toContain("statement");
  });
});

// ---- rule: a risk's falsifying ref may sit in evidence ----

describe("a risk with no checks", () => {
  test("is falsifiable when its ref into a changed hunk sits in evidence", () => {
    const payload = golden();
    const note = payload.notes.find((n) => n.kind === "risk")!;
    note.checks = [];
    const intoChange = note.refs.find((r) =>
      Object.values(GOLDEN_HUNKS).some((h) => h.path === r.path && h.sha === r.sha),
    );
    expect(intoChange).toBeDefined();
    note.refs = [];
    note.evidence = [...note.evidence, { type: "ref", ref: intoChange! }];
    expect(rules(run(payload).errors)).not.toContain("risk_unfalsifiable");
  });
});

// ---- rule: the evidence list is closed ----

describe("an evidence kind outside the list", () => {
  test("is an error naming the field and the kind, not a silent pass", () => {
    const payload = golden();
    payload.statements[0]!.evidence = [
      ...payload.statements[0]!.evidence,
      { type: "video", src: "http://x" } as unknown as (typeof payload.statements)[0]["evidence"][0],
    ];
    const errors = run(payload).errors;
    const err = find(errors, "evidence_kind_unknown");
    const j = payload.statements[0]!.evidence.length - 1;
    expect(err.field).toBe(`statements[0].evidence[${j}].type`);
    expect(err.message).toContain("video");
  });

  test("a null evidence entry is reported, not a crash", () => {
    const payload = golden();
    payload.notes[0]!.evidence = [
      null as unknown as (typeof payload.notes)[0]["evidence"][0],
    ];
    const errors = run(payload).errors;
    expect(find(errors, "evidence_kind_unknown").field).toBe("notes[0].evidence[0].type");
  });

  test("a known kind missing its sub-object is a required error, not a crash", () => {
    const payload = golden();
    payload.statements[0]!.evidence = [
      { type: "attachment" } as unknown as (typeof payload.statements)[0]["evidence"][0],
    ];
    const errors = run(payload).errors;
    const err = errors.find((e) => e.field === "statements[0].evidence[0].attachment");
    expect(err?.rule).toBe("required");
  });

  test("a figure missing its nodes is a required error, not a crash", () => {
    const payload = golden();
    const at = payload.statements.flatMap((s, i) =>
      s.evidence.map((e, j) => (e.type === "figure" ? ([i, j] as const) : null)),
    ).find((x) => x !== null)!;
    const figure = payload.statements[at[0]]!.evidence[at[1]]! as { figure: { nodes?: unknown } };
    delete figure.figure.nodes;
    const errors = run(payload).errors;
    const field = `statements[${at[0]}].evidence[${at[1]}].figure.nodes`;
    expect(errors.find((e) => e.field === field)?.rule).toBe("required");
  });
});

// ---- a malformed body is a 422, never a 500 ----
//
// Every scalar leaf of the golden payload, deleted and then mistyped in turn. The
// module exists to turn a bad document into an error list, so any path through it that
// throws is a 500 the publish route cannot answer with.

type Leaf = { path: string; parent: Record<string, unknown> | unknown[]; key: string | number };

function leaves(value: unknown, path: string, out: Leaf[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (v !== null && typeof v === "object") leaves(v, `${path}[${i}]`, out);
      else out.push({ path: `${path}[${i}]`, parent: value, key: i });
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") leaves(v, `${path}.${k}`, out);
      else out.push({ path: `${path}.${k}`, parent: value as Record<string, unknown>, key: k });
    }
  }
}

function scalarLeaves(): { path: string; original: unknown }[] {
  const out: Leaf[] = [];
  leaves(golden(), "", out);
  return out.map((l) => ({
    path: l.path,
    original: (l.parent as Record<string | number, unknown>)[l.key],
  }));
}

type Mutation = "deleting" | "replacing with a number" | "replacing with null";

/** A leaf that is genuinely allowed to hold this value. Everything else has to come
 *  back as an error: a leaf that validates clean when it is absent or mistyped reaches
 *  storage and then the renderer, unchecked. */
function mayHold(path: string, mutation: Mutation, original: unknown): boolean {
  // pr.parent is optional: most pull requests sit at the root of the stack.
  if (path.endsWith(".parent")) return true;
  // The data model marks attachment.alt required and leaves attachment.caption to the
  // author, and gives a figure edge label no requiredness at all: absent is legal for
  // both, a present one that is not text is not.
  if (
    mutation === "deleting" &&
    (/^\.attachments\[\d+\]\.caption$/.test(path) || /\.figure\.edges\[\d+\]\.label$/.test(path))
  ) {
    return true;
  }
  // Deleting an array element leaves a hole rather than an entry, and JSON.parse cannot
  // produce one: forEach skips it, so there is nothing to report.
  if (mutation === "deleting" && /\[\d+\]$/.test(path)) return true;
  if (mutation === "replacing with a number" && typeof original === "number") return true;
  // A payload highlight is a key or a line number, so a number is one of its two shapes.
  if (mutation === "replacing with a number" && path.includes(".payload.highlight[")) return true;
  // A bundle at a null version is the bundle at latest.
  if (mutation === "replacing with null" && path.endsWith(".version")) return true;
  return false;
}

function mutate(path: string, apply: (leaf: Leaf) => void): PublishPayload {
  const payload = golden();
  const out: Leaf[] = [];
  leaves(payload, "", out);
  const leaf = out.find((l) => l.path === path);
  expect(leaf, `no leaf at ${path}`).toBeDefined();
  apply(leaf!);
  return payload;
}

describe("a payload with a missing or mistyped scalar", () => {
  const scalars = scalarLeaves();

  const APPLY: Record<Mutation, (leaf: Leaf) => void> = {
    deleting: (leaf) => {
      delete (leaf.parent as Record<string | number, unknown>)[leaf.key];
    },
    "replacing with a number": (leaf) => {
      (leaf.parent as Record<string | number, unknown>)[leaf.key] = 5;
    },
    "replacing with null": (leaf) => {
      (leaf.parent as Record<string | number, unknown>)[leaf.key] = null;
    },
  };

  test("the golden payload has scalars at every depth to mutate", () => {
    expect(scalars.length).toBeGreaterThan(100);
  });

  for (const { path, original } of scalars) {
    for (const mutation of Object.keys(APPLY) as Mutation[]) {
      const allowed = mayHold(path, mutation, original);
      const expectation = allowed ? "is a value it may hold" : "is named as an error";
      test(`${mutation} ${path} ${expectation}`, () => {
        const payload = mutate(path, APPLY[mutation]);
        // A crash is a 500 the publish route cannot answer with, whichever way it goes.
        let result!: ReturnType<typeof run>;
        expect(() => {
          result = run(payload);
        }).not.toThrow();
        if (allowed) return;
        expect(
          result.errors.length,
          `${mutation} ${path} returned no error, so it reaches storage unchecked`,
        ).toBeGreaterThan(0);
      });
    }
  }

  test("deleting a whole entity from a list does not throw", () => {
    for (const key of ["prs", "statements", "notes", "groups", "attachments"] as const) {
      const payload = golden();
      (payload[key] as unknown[])[0] = null;
      expect(() => run(payload), `${key}[0] = null`).not.toThrow();
    }
  });

  test("a required scalar that is absent is named by its field", () => {
    const payload = golden();
    delete (payload as { title?: string }).title;
    expect(run(payload).errors.find((e) => e.field === "title")?.rule).toBe("required");
  });

  test("a body that is a number is named by its field, not silently accepted", () => {
    const payload = golden();
    (payload.statements[0] as { body: unknown }).body = 5;
    expect(run(payload).errors.find((e) => e.field === "statements[0].body")?.rule).toBe(
      "required",
    );
  });

  test("a check that is a number is named by its field", () => {
    const payload = golden();
    const note = payload.notes.find((n) => n.checks.length > 0)!;
    const i = payload.notes.indexOf(note);
    (note.checks as unknown[])[0] = 5;
    expect(run(payload).errors.find((e) => e.field === `notes[${i}].checks[0]`)?.rule).toBe(
      "not_text",
    );
  });

  test("an attachment without a media type is an attachment_media_type error", () => {
    const payload = golden();
    delete (payload.attachments[0] as { mediaType?: string }).mediaType;
    const err = find(run(payload).errors, "attachment_media_type");
    expect(err.field).toBe("attachments[0].mediaType");
    expect(err.message).toContain("absent");
  });
});

// ---- rule: a parent names a pull request in this review ----

describe("a pull request's parent", () => {
  test("naming no pull request in the review is an error", () => {
    const payload = golden();
    payload.prs[1]!.parent = 999;
    const err = find(run(payload).errors, "pr_parent_unknown");
    expect(err.field).toBe("prs[1].parent");
    expect(err.message).toContain("999");
  });

  test("naming itself is an error", () => {
    const payload = golden();
    payload.prs[1]!.parent = payload.prs[1]!.number;
    expect(find(run(payload).errors, "pr_parent_self").field).toBe("prs[1].parent");
  });

  test("naming another pull request in the review is fine", () => {
    expect(rules(run(golden()).errors)).not.toContain("pr_parent_unknown");
  });
});

// ---- rule: a statement names each pull request once ----

describe("a statement naming one pull request twice", () => {
  test("is a pr_duplicated error naming the repeated position", () => {
    const payload = golden();
    const s = payload.statements[0]!;
    s.prs = [s.prs[0]!, s.prs[0]!];
    const err = find(run(payload).errors, "pr_duplicated");
    expect(err.field).toBe("statements[0].prs[1]");
    expect(err.message).toContain(s.prs[0]!);
  });
});

// ---- rules on the leaves a sub-object carries ----

describe("a leaf that reaches the renderer", () => {
  test("a group's significance that is not a number is named", () => {
    const payload = golden();
    (payload.groups[0] as { significance: unknown }).significance = "high";
    const err = find(run(payload).errors, "significance_invalid");
    expect(err.field).toBe("groups[0].significance");
  });

  test("a statement naming no pull request is unattributed", () => {
    const payload = golden();
    payload.statements[0]!.prs = [];
    const err = find(run(payload).errors, "statement_unattributed");
    expect(err.field).toBe("statements[0].prs");
  });

  test("a file note without a path is a required error", () => {
    const payload = golden();
    const i = payload.groups.findIndex((g) => g.fileNotes.length > 0);
    delete (payload.groups[i]!.fileNotes[0] as { path?: string }).path;
    const err = run(payload).errors.find((e) => e.field === `groups[${i}].fileNotes[0].path`);
    expect(err?.rule).toBe("required");
  });

  test("a file note path over 120 characters is capped", () => {
    const payload = golden();
    const i = payload.groups.findIndex((g) => g.fileNotes.length > 0);
    payload.groups[i]!.fileNotes[0]!.path = `src/${"a".repeat(120)}.ts`;
    const err = run(payload).errors.find((e) => e.field === `groups[${i}].fileNotes[0].path`);
    expect(err?.rule).toBe("cap_chars");
    expect(err?.overage).toBe(7);
  });

  test("a file note path carrying a newline is a path_invalid error", () => {
    const payload = golden();
    const i = payload.groups.findIndex((g) => g.fileNotes.length > 0);
    payload.groups[i]!.fileNotes[0]!.path = "src/a.ts\nsrc/b.ts";
    const err = find(run(payload).errors, "path_invalid");
    expect(err.field).toBe(`groups[${i}].fileNotes[0].path`);
  });

  test("a file note on a path the group's hunks do not touch is rejected", () => {
    const payload = golden();
    const i = payload.groups.findIndex((g) => g.fileNotes.length > 0);
    payload.groups[i]!.fileNotes[0]!.path = "src/nowhere.ts";
    const err = find(run(payload).errors, "file_note_orphan");
    expect(err.field).toBe(`groups[${i}].fileNotes[0].path`);
    expect(err.message).toContain("src/nowhere.ts");
  });

  test("two file notes on one path are rejected", () => {
    const payload = golden();
    const i = payload.groups.findIndex((g) => g.fileNotes.length > 0);
    const first = payload.groups[i]!.fileNotes[0]!;
    payload.groups[i]!.fileNotes.push({ path: first.path, text: "A second word on it" });
    const err = find(run(payload).errors, "file_note_duplicate");
    expect(err.field).toBe(`groups[${i}].fileNotes[${payload.groups[i]!.fileNotes.length - 1}].path`);
  });

  test("a ref without a path is a required error, not an undefined in a message", () => {
    const payload = golden();
    delete (payload.prs[0]!.detailRef as { path?: string }).path;
    const errors = run(payload).errors;
    expect(errors.find((e) => e.field === "prs[0].detailRef.path")?.rule).toBe("required");
  });

  test("a ref pointing at no repo is a required error", () => {
    const payload = golden();
    delete (payload.statements[0]!.refs[0] as { repo?: string }).repo;
    expect(
      run(payload).errors.find((e) => e.field === "statements[0].refs[0].repo")?.rule,
    ).toBe("required");
  });

  test("a pull request number that is a string is named", () => {
    const payload = golden();
    (payload.prs[0] as { number: unknown }).number = "12";
    const err = find(run(payload).errors, "pr_number_invalid");
    expect(err.field).toBe("prs[0].number");
  });

  test("a pull request without a repo is a required error", () => {
    const payload = golden();
    delete (payload.prs[0] as { repo?: string }).repo;
    expect(run(payload).errors.find((e) => e.field === "prs[0].repo")?.rule).toBe("required");
  });

  test("a figure node without a label is a required error", () => {
    const payload = golden();
    const at = figureAt(payload);
    const figure = evidenceFigure(payload, at);
    delete (figure.nodes[0] as { label?: string }).label;
    const field = `statements[${at[0]}].evidence[${at[1]}].figure.nodes[0].label`;
    expect(run(payload).errors.find((e) => e.field === field)?.rule).toBe("required");
  });

  test("a figure node without an id is a required error", () => {
    const payload = golden();
    const at = figureAt(payload);
    const figure = evidenceFigure(payload, at);
    delete (figure.nodes[0] as { id?: string }).id;
    const field = `statements[${at[0]}].evidence[${at[1]}].figure.nodes[0].id`;
    expect(run(payload).errors.find((e) => e.field === field)?.rule).toBe("required");
  });

  test("a figure edge label that is a number is a not_text error", () => {
    const payload = golden();
    const at = figureAt(payload);
    const figure = evidenceFigure(payload, at);
    (figure.edges[0] as { label: unknown }).label = 7;
    const field = `statements[${at[0]}].evidence[${at[1]}].figure.edges[0].label`;
    expect(run(payload).errors.find((e) => e.field === field)?.rule).toBe("not_text");
  });

  test("an example without a lang is a required error", () => {
    const payload = golden();
    const at = exampleAt(payload);
    delete (evidenceExample(payload, at) as { lang?: string }).lang;
    const field = `statements[${at[0]}].evidence[${at[1]}].example.lang`;
    expect(run(payload).errors.find((e) => e.field === field)?.rule).toBe("required");
  });

  test("an example lang that is prose rather than a tag is a lang_invalid error", () => {
    const payload = golden();
    const at = exampleAt(payload);
    evidenceExample(payload, at).lang = "x".repeat(400);
    const err = find(run(payload).errors, "lang_invalid");
    expect(err.field).toBe(`statements[${at[0]}].evidence[${at[1]}].example.lang`);
  });

  test("a payload highlight that is a scalar rather than a list is a required error", () => {
    const payload = golden();
    const at = payloadAt(payload);
    (evidencePayload(payload, at) as { highlight: unknown }).highlight = 5;
    const field = `statements[${at[0]}].evidence[${at[1]}].payload.highlight`;
    expect(run(payload).errors.find((e) => e.field === field)?.rule).toBe("required");
  });

  test("a payload highlight entry that is neither a key nor a line is named", () => {
    const payload = golden();
    const at = payloadAt(payload);
    (evidencePayload(payload, at).highlight as unknown[])[0] = true;
    const err = find(run(payload).errors, "payload_highlight_invalid");
    expect(err.field).toBe(`statements[${at[0]}].evidence[${at[1]}].payload.highlight[0]`);
  });
});

function evidenceAt(payload: PublishPayload, type: string): readonly [number, number] {
  const at = payload.statements
    .flatMap((s, i) => s.evidence.map((e, j) => (e.type === type ? ([i, j] as const) : null)))
    .find((x) => x !== null);
  expect(at, `the golden payload carries no ${type} evidence on a statement`).toBeDefined();
  return at!;
}

const figureAt = (p: PublishPayload) => evidenceAt(p, "figure");
const exampleAt = (p: PublishPayload) => evidenceAt(p, "example");
const payloadAt = (p: PublishPayload) => evidenceAt(p, "payload");

function evidenceFigure(payload: PublishPayload, at: readonly [number, number]) {
  const e = payload.statements[at[0]]!.evidence[at[1]]!;
  if (e.type !== "figure") throw new Error("not a figure");
  return e.figure;
}

function evidenceExample(payload: PublishPayload, at: readonly [number, number]) {
  const e = payload.statements[at[0]]!.evidence[at[1]]!;
  if (e.type !== "example") throw new Error("not an example");
  return e.example;
}

function evidencePayload(payload: PublishPayload, at: readonly [number, number]) {
  const e = payload.statements[at[0]]!.evidence[at[1]]!;
  if (e.type !== "payload") throw new Error("not a payload");
  return e.payload;
}

// ---- rule: a pull request's detail is at most two sentences ----

describe("sentence counting", () => {
  test("counts sentences run together without a space", () => {
    const payload = golden();
    payload.prs[0]!.detail = "First thing.Second thing.Third thing.";
    const err = find(run(payload).errors, "cap_sentences");
    expect(err.field).toBe("prs[0].detail");
    expect(err.overage).toBe(1);
  });

  test("does not count a decimal point as a sentence end", () => {
    const payload = golden();
    payload.prs[0]!.detail = "The timeout moves from 1.5 seconds to 2.5 seconds.";
    expect(rules(run(payload).errors)).not.toContain("cap_sentences");
  });
});

describe("pr.detail", () => {
  test("pr.detail is capped like every other authored field", () => {
    // Every authored field carries a character cap. detail was the exception, which
    // left the one field the write path could not bound, and left it able to skip
    // markdown validation entirely once the scanners stopped parsing past the
    // largest cap in the table.
    const payload = golden();
    payload.prs[0]!.detail = "a".repeat(BUDGETS.chars.prDetail + 1);
    const { errors } = run(payload);
    const named = errors.filter((e) => e.field === "prs[0].detail");
    const capped = named.find((e) => e.rule === "cap_chars");
    expect(capped).toBeDefined();
    expect(capped!.overage).toBe(1);
  });

  test("a detail inside the cap is still parsed for forbidden constructs", () => {
    const payload = golden();
    payload.prs[0]!.detail = "# not allowed here";
    const { errors } = run(payload);
    expect(errors.some((e) => e.field === "prs[0].detail" && e.rule === "markdown_construct")).toBe(true);
  });
});

describe("a field far past its cap is not parsed", () => {
  test("an oversized body fails its cap without running the markdown scanners", () => {
    // The scanners are quadratic on pathological input and the request body limit is
    // megabytes, so parsing something no cap could ever accept is a single-threaded
    // server stalling on one authenticated publish. Measured at 80k before the guard:
    // about nine seconds.
    const big = "<".repeat(80_000);
    const payload = golden();
    payload.statements[0]!.body = big;
    const started = Date.now();
    const { errors } = run(payload);
    expect(Date.now() - started).toBeLessThan(1000);
    // It still fails, and it fails naming the cap rather than a construct inside it.
    const named = errors.filter((e) => e.field === "statements[0].body");
    expect(named.length).toBeGreaterThan(0);
    // Whatever the cap rule is called, the point is that the parse did not run:
    // no construct inside the oversized field is reported.
    expect(named.some((e) => e.rule === "markdown_construct")).toBe(false);
  });

  test("a body inside its cap is still parsed and still refused by construct", () => {
    const payload = golden();
    payload.statements[0]!.body = "# a heading";
    const { errors } = run(payload);
    expect(errors.some((e) => e.field === "statements[0].body" && e.rule === "markdown_construct")).toBe(true);
  });
});
