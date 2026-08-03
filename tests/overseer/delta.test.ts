// The delta engine, and the marks it puts on a page.
//
// Two halves, the same shape as the renderer's own tests. The first works on the
// pure function: two documents in, one derived delta out, with no page anywhere
// near it. The second renders and reads the HTML, because the law the page is
// held to is about what a reader sees: every chip on the page came from the
// delta, and every chip has something marked inside its own row. The third
// stretch drives the routes, because which version the marks are measured
// against depends on what this reader last opened, which is a database fact.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { createReviewVersion, type ReviewDoc } from "../../src/overseer/db";
import {
  computeDelta,
  DeltaIndex,
  diffField,
  evidenceFieldNames,
  markField,
  MAX_DIFF_WORDS,
  prBodyHtml,
  safeId,
  textOf,
} from "../../src/overseer/delta";
import { baseVersion, renderReviewPage } from "../../src/overseer/render";
import { safeInline } from "../../src/overseer/render-evidence";
import { prKey, type Annotation } from "../../src/overseer/types";
import { GOLDEN_REPO } from "./fixtures/golden-review";
import { goldenStoredDoc } from "./fixtures/stored-review";

const DELTA_SOURCE = `${import.meta.dir}/../../src/overseer/delta.ts`;
/** Every file this step's user-facing copy lives in: the delta's own chips, the
 *  revision menu strings, and the kind marks. */
const COPY_SOURCES = [
  DELTA_SOURCE,
  `${import.meta.dir}/../../src/overseer/render.ts`,
  `${import.meta.dir}/../../src/overseer/render-diff.ts`,
];

type Doc = ReviewDoc;

/** A stored document, fixed rather than freshly stamped: two documents built for
 *  one comparison must not differ only in the clock they were built at. */
function doc(over: (d: Doc) => void = () => {}): Doc {
  const base = goldenStoredDoc();
  const d: Doc = {
    ...base,
    id: "rev_delta",
    slug: "delta",
    version: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  const copy: Doc = JSON.parse(JSON.stringify(d));
  over(copy);
  return copy;
}

function side(d: Doc, annotations: Annotation[] = []) {
  return { doc: d, annotations };
}

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann_one",
    target: { type: "statement", id: "st_gate" },
    quote: null,
    body: "Is the key path covered?",
    status: "open",
    answer: null,
    version: 1,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function page(current: Doc, prev: Doc | null, annotations: Annotation[] = []): string {
  const delta =
    prev === null
      ? null
      : new DeltaIndex(computeDelta(side(prev), side(current, annotations)));
  return renderReviewPage({
    wsId: "ws_delta",
    slug: "delta",
    doc: current,
    version: prev === null ? 1 : 2,
    latestVersion: prev === null ? 1 : 2,
    pinned: false,
    freshness: {},
    baseVersion: prev === null ? null : 1,
    delta,
    timeline: [],
  });
}

/** The `details` element a chip sits inside, with its whole body. Walked rather
 *  than matched: rows nest folds, and a regex cannot say where one ends. */
function unitAround(html: string, at: number): string {
  const start = html.lastIndexOf("<details", at);
  expect(start).toBeGreaterThan(-1);
  const re = /<details\b|<\/details>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    if (m[0] === "</details>") {
      if (--depth === 0) return html.slice(start, m.index + "</details>".length);
    } else depth++;
  }
  throw new Error("unclosed details around a chip");
}

describe("the delta itself", () => {
  test("an id that survives with its text edited is revised, with the regions to show it", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
    });
    const delta = computeDelta(side(before), side(after));
    const e = delta.entities.find((x) => x.kind === "statement" && x.id === "st_gate");
    expect(e).toBeDefined();
    expect(e!.status).toBe("revised");
    const field = e!.fields.find((f) => f.field === "text")!;
    expect(field.mode).toBe("words");
    expect(field.regions.length).toBe(1);
    expect(field.priorWords).toContain("session");
    expect(field.density).toBeLessThan(0.4);
  });

  test("an id the current version does not carry is removed, with what it said", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements = [];
    });
    const delta = computeDelta(side(before), side(after));
    const e = delta.entities.find((x) => x.kind === "statement")!;
    expect(e.status).toBe("removed");
    expect(e.id).toBe("st_gate");
    expect(e.former!.head).toBe("Reviews move behind the workspace session gate");
    expect(e.former!.body[0]).toBe("<p>The gate is the helper bundles already use.</p>");
  });

  test("a removed entity keeps the shape of what it said, not just the words", () => {
    const before = doc((d) => {
      d.statements[0]!.body = "intro\n\n- one\n- two";
    });
    const after = doc((d) => {
      d.statements = [];
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "statement")!;
    expect(e.former!.body[0]).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  test("an id the base version never had is new", () => {
    const before = doc();
    const after = doc((d) => {
      d.notes.push({
        id: "no_fresh",
        kind: "note",
        text: "The freshness check runs on read",
        body: "It compares the stored head.",
        checks: [],
        refs: [],
        evidence: [],
      });
    });
    const delta = computeDelta(side(before), side(after));
    const e = delta.entities.find((x) => x.id === "no_fresh")!;
    expect(e.status).toBe("new");
    expect(e.kind).toBe("note");
    // A new entity still marks something, so its chip is never the only sign of it.
    expect(e.fields.length).toBe(1);
  });

  test("a body rewritten past the density threshold is shown whole", () => {
    const before = doc((d) => {
      d.statements[0]!.body = "one two three four five six seven eight nine ten";
    });
    const after = doc((d) => {
      d.statements[0]!.body = "one two three four five alpha beta gamma delta epsilon";
    });
    const delta = computeDelta(side(before), side(after));
    const field = delta.entities[0]!.fields.find((f) => f.field === "body")!;
    expect(field.density).toBeGreaterThan(0.4);
    expect(field.mode).toBe("whole");
    expect(field.priorWords.join(" ")).toContain("six seven eight");
  });

  // The threshold itself, bracketed either side of 0.4 so the constant is what
  // decides rather than some far-away score.
  test("a body edited at the threshold stays in place, and one word more goes whole", () => {
    const before = doc((d) => {
      d.statements[0]!.body = "one two three four five six seven eight nine ten";
    });
    const bodyField = (after: Doc) =>
      computeDelta(side(before), side(after)).entities[0]!.fields.find((f) => f.field === "body")!;
    // Two of ten words replaced: two inserted and two deleted over ten, which is
    // 0.4 exactly, and the threshold is the word past it.
    const at = bodyField(
      doc((d) => {
        d.statements[0]!.body = "one two three four five six seven eight alpha beta";
      }),
    );
    expect(at.density).toBeCloseTo(0.4, 5);
    expect(at.mode).toBe("words");
    // Three of ten, which is 0.6.
    const over = bodyField(
      doc((d) => {
        d.statements[0]!.body = "one two three four five six seven alpha beta gamma";
      }),
    );
    expect(over.density).toBeCloseTo(0.6, 5);
    expect(over.mode).toBe("whole");
  });

  test("a light edit to the same body stays in place", () => {
    const before = doc((d) => {
      d.statements[0]!.body = "one two three four five six seven eight nine ten";
    });
    const after = doc((d) => {
      d.statements[0]!.body = "one two three four five six seven eight nine eleven";
    });
    const field = computeDelta(side(before), side(after)).entities[0]!.fields.find(
      (f) => f.field === "body",
    )!;
    expect(field.mode).toBe("words");
    expect(field.density).toBeLessThan(0.4);
  });

  test("an annotation answered between the two versions is answered", () => {
    const before = doc();
    const after = doc();
    const open = annotation();
    const delta = computeDelta(
      side(before, [open]),
      side(after, [{ ...open, status: "answered", answer: { body: "It is", refs: [] } }]),
    );
    expect(delta.answered).toEqual(["ann_one"]);
    // One that was already answered at the base did not move.
    const still = computeDelta(
      side(before, [{ ...open, status: "answered", answer: { body: "It is", refs: [] } }]),
      side(after, [{ ...open, status: "answered", answer: { body: "It is", refs: [] } }]),
    );
    expect(still.answered).toEqual([]);
  });

  test("a pull request whose head moved is marked, without any word being marked", () => {
    const before = doc();
    const after = doc((d) => {
      d.prs[0]!.headSha = "9".repeat(40);
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "pr")!;
    expect(e.id).toBe(prKey(GOLDEN_REPO, 12));
    expect(e.codeMoved).toBe(true);
    expect(e.fields).toEqual([]);
  });

  test("the derived pull request description is diffed like any other prose", () => {
    const before = doc();
    const after = doc((d) => {
      d.prs[0]!.body = `${d.prs[0]!.body}\n\nA paragraph the description grew.`;
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "pr")!;
    expect(e.fields.some((f) => f.field === "body")).toBe(true);
  });

  test("an inserted run that straddles a tag is marked piece by piece, never dropped", () => {
    const html = safeInline("the `gate` helper now reads keys");
    const d = diffField("text", true, "", html)!;
    const out = markField(html, d, "no_code");
    expect(out).toContain("<code>");
    // Every word of the run carries a mark, on both sides of the tag.
    expect([...out.matchAll(/<ins class="dw dnew">/g)].length).toBe(3);
    for (const word of ["the", "gate", "helper now reads keys"]) {
      expect(out).toContain(`<ins class="dw dnew">${word}</ins>`);
    }
  });

  test("a pure deletion in a one-line field still draws a mark, with the row shut", () => {
    const prior = safeInline("Reviews move behind the workspace session gate");
    const html = safeInline("Reviews move behind the workspace gate");
    const d = diffField("text", true, prior, html)!;
    const out = markField(html, d, "st_gate");
    // The prior words are hidden until the row opens, so the cut itself carries
    // the ink the chip stands over.
    expect(out).toContain('<span class="dw dcut" aria-hidden="true"></span>');
    expect(out).toContain('<span class="dp">session </span>');
  });

  test("the deletion caret is drawn, and drawn only where nothing was inserted", () => {
    const prior = safeInline("keys read the old helper");
    const html = safeInline("keys read the new helper");
    const d = diffField("text", true, prior, html)!;
    const out = markField(html, d, "st_swap");
    // A replacement already shows its inserted word, so it needs no caret.
    expect(out).toContain('<ins class="dw">new</ins>');
    expect(out).not.toContain("dcut");
  });

  test("a revised field whose insert straddles a tag keeps both the mark and the prior words", () => {
    // A long field with a two-word insert, so density stays well under the
    // threshold and the straddle is the only reason the field goes whole. The
    // insert lands either side of the code span, which is what makes it straddle.
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const prior = safeInline(`${words} carries helper`);
    const html = safeInline(`${words} carries the \`slow\` helper`);
    const d = diffField("text", false, prior, html)!;
    expect(d.density).toBeLessThan(0.4);
    expect(d.mode).toBe("whole");
    const out = markField(html, d, "st_x");
    expect(/class="dw/.test(out)).toBe(true);
    // The insert lands in two pieces around the code span, so the prior words cannot
    // ride along inside one mark: they come out on their own, and the whole prior
    // line is readable from what the field drew.
    expect(out).toContain(`<span class="dp dpb">${textOf(prior)}</span>`);
    expect(out).toMatch(/<input type="checkbox" class="dtog"[^>]*aria-label="prior text"/);
  });

  test("a field past the word ceiling is republished whole rather than aligned", () => {
    const long = Array.from({ length: MAX_DIFF_WORDS + 40 }, (_, i) => `w${i}`).join(" ");
    const started = Date.now();
    const d = diffField("body", false, `<p>${long}</p>`, `<p>${long} tail</p>`)!;
    expect(d.mode).toBe("whole");
    expect(d.density).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("two identical documents move nothing", () => {
    expect(computeDelta(side(doc()), side(doc())).entities).toEqual([]);
  });

  test("a field with no base text is all insertion and hides nothing behind a disclosure", () => {
    const d = diffField("text", true, "", "a wholly new line")!;
    expect(d.priorWords).toEqual([]);
    expect(d.regions).toEqual([{ d0: 0, d1: 0, c0: 0, c1: 4 }]);
    expect(textOf("<p>a <em>marked</em> line</p>")).toBe("a marked line");
  });
});

describe("the marks on the page", () => {
  test("every chip on a rendered page has a mark inside its own row", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.statements.push({
        id: "st_keys",
        kind: "add",
        text: "Keys read the workspace they were minted in",
        prs: [prKey(GOLDEN_REPO, 12)],
        refs: [],
        body: "One workspace, one key.",
        evidence: [],
      });
      d.notes[0]!.body = "Keys are workspace scoped, and the read path proves it.";
      d.notes.push({
        id: "no_new",
        kind: "note",
        text: "A note the base version did not have",
        body: "Body.",
        checks: [],
        refs: [],
        evidence: [],
      });
      // An inserted run that straddles a tag is the case a mark is easiest to
      // lose: the words sit either side of the code span and cannot be one span.
      d.notes.push({
        id: "no_code",
        kind: "note",
        text: "the `gate` helper now reads keys",
        body: "Body.",
        checks: [],
        refs: [],
        evidence: [],
      });
      d.notes[0]!.text = "Keys are read through the `slow gate` helper now";
      d.groups[0]!.title = "The session gate";
      d.summary = `${d.summary} A sentence the summary grew.`;
      d.prs[0]!.gist = "A gist that reads differently now";
    });
    const html = page(after, before);

    const chips = [...html.matchAll(/<span class="rev">/g)];
    expect(chips.length).toBeGreaterThan(3);
    for (const m of chips) {
      const unit = unitAround(html, m.index!);
      const marked = /class="(dw|dp|dw dnew|dw dall|dw dxo|dp dpb|dp dpstub)/.test(unit);
      expect(marked).toBe(true);
    }
    // The page says what it is measuring against.
    expect(html).toContain("marks since v1");
    // The summary is diffed like any other body. Bounded to the summary block
    // itself, which ends where the statement rows begin, so the assertion cannot
    // pass on some other section's ink.
    const summaryBlock = html.slice(
      html.indexOf('id="summary"'),
      html.indexOf('<div class="rows">'),
    );
    expect(summaryBlock).toContain('class="dw');
    expect(summaryBlock).toMatch(/<ins class="dw dnew">[^<]*grew/);
  });

  // One mutation per compared field, on every entity that can carry a chip. A field
  // the delta compares and the renderer never draws would mint a chip over an
  // unmarked row, which is the one thing the page may not do, so the sweep asks the
  // question field by field rather than trusting one fixture to touch them all.
  const singleFieldEdits: Array<[string, (d: Doc) => void]> = [
    ["statement text", (d) => { d.statements[0]!.text = "Reviews move behind the login gate"; }],
    ["statement body", (d) => { d.statements[0]!.body = "A body the statement now carries."; }],
    ["statement kind", (d) => { d.statements[0]!.kind = "remove"; }],
    ["note text", (d) => { d.notes[0]!.text = "Keys are read through the helper now"; }],
    ["note body", (d) => { d.notes[0]!.body = "A body the note now carries."; }],
    ["note check", (d) => { d.notes[0]!.checks = ["a check worded differently"]; }],
    ["note kind", (d) => { d.notes[0]!.kind = "note"; }],
    ["group title", (d) => { d.groups[0]!.title = "The session gate"; }],
    ["group paragraph", (d) => { d.groups[0]!.paragraph = "A paragraph the group now carries."; }],
    ["group kind", (d) => { d.groups[0]!.kind = "remove"; }],
    ["pr gist", (d) => { d.prs[0]!.gist = "A gist that reads differently now"; }],
    ["pr detail", (d) => { d.prs[0]!.detail = "A detail the card now carries."; }],
    ["pr body", (d) => { d.prs[0]!.body = `${d.prs[0]!.body}\n\nA paragraph the description grew.`; }],
  ];

  for (const [name, edit] of singleFieldEdits) {
    test(`a chip minted by a change to ${name} alone has a mark inside its own row`, () => {
      const before = doc();
      const after = doc(edit);
      const html = page(after, before);
      const chips = [...html.matchAll(/<span class="rev">/g)];
      expect(chips.length).toBeGreaterThan(0);
      for (const m of chips) {
        const unit = unitAround(html, m.index!);
        expect(/class="(dw|dp|dw dnew|dw dall|dw dxo|dp dpb|dp dpstub)/.test(unit)).toBe(true);
      }
    });
  }

  test("a chip on a card whose description was emptied still has a mark under it", () => {
    const before = doc();
    const after = doc((d) => {
      d.prs[0]!.body = "";
    });
    expect(before.prs[0]!.body).not.toBe("");
    const html = page(after, before);
    const chips = [...html.matchAll(/<span class="rev">/g)];
    expect(chips.length).toBe(1);
    for (const m of chips) {
      const unit = unitAround(html, m.index!);
      expect(/class="(dw|dp|dw dnew|dw dall|dw dxo|dp dpb|dp dpstub)/.test(unit)).toBe(true);
      // The prior description is in the page, behind its own disclosure.
      expect(unit).toContain(textOf(prBodyHtml(before.prs[0]!.body)).split(" ")[0]!);
    }
  });

  test("a note that dropped a check says so, and the check comes back", () => {
    const before = doc((d) => {
      d.notes[0]!.checks = ["alpha check", "beta check", "gamma check"];
    });
    const after = doc((d) => {
      d.notes[0]!.checks = ["alpha check"];
    });
    const delta = computeDelta(side(before), side(after));
    const e = delta.entities.find((x) => x.kind === "note" && x.id === before.notes[0]!.id)!;
    expect(e).toBeDefined();
    expect(e.status).toBe("revised");
    expect(e.fields.map((f) => f.field).sort()).toEqual(["check-1", "check-2"]);
    for (const f of e.fields) {
      expect(f.mode).toBe("whole");
      expect(f.density).toBe(1);
    }
    expect(e.fields.find((f) => f.field === "check-1")!.priorWords.join(" ")).toBe("beta check");

    const html = page(after, before);
    const at = html.indexOf(`id="${before.notes[0]!.id}"`);
    const unit = unitAround(html, at + 20);
    expect(unit).toContain("beta check");
    expect(unit).toContain("gamma check");
    expect(unit).toContain('class="dp dpb"');
    expect(unit).toContain('<span class="rev">revised</span>');
  });

  test("two keys that differ anywhere still differ as ids", () => {
    expect(safeId("acme/seer#1")).not.toBe(safeId("acme-seer-1"));
    expect(safeId("a_b")).not.toBe(safeId("a/b"));
    expect(safeId("st_gate")).toBe(safeId("st_gate"));
    expect(/^[a-zA-Z0-9_-]+$/.test(safeId("acme/seer#1"))).toBe(true);
  });

  test("a note that dropped every check still says a check went", () => {
    const before = doc((d) => {
      d.notes[0]!.checks = ["alpha check"];
    });
    const after = doc((d) => {
      d.notes[0]!.checks = [];
    });
    const e = computeDelta(side(before), side(after)).entities.find(
      (x) => x.kind === "note" && x.id === before.notes[0]!.id,
    )!;
    expect(e.fields.map((f) => f.field)).toEqual(["check-0"]);
    const html = page(after, before);
    const unit = unitAround(html, html.indexOf(`id="${before.notes[0]!.id}"`) + 20);
    expect(unit).toContain("alpha check");
    expect(unit).toContain('<span class="rev">revised</span>');
  });

  test("a page with no base carries no chip and no mark at all", () => {
    const html = page(doc(), null);
    expect(html).not.toContain('<span class="rev">');
    expect(html).not.toContain('class="dtog"');
    expect(html).not.toContain("marks since");
  });

  test("a removed statement comes back as a stub holding everything it said", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements = [];
      d.statements.push({
        id: "st_other",
        kind: "add",
        text: "Something else entirely",
        prs: [prKey(GOLDEN_REPO, 12)],
        refs: [],
        body: "Body.",
        evidence: [],
      });
    });
    const html = page(after, before);
    const at = html.indexOf('class="row dgoneunit"');
    expect(at).toBeGreaterThan(-1);
    const stub = unitAround(html, at);
    expect(stub).toContain("Reviews move behind the workspace session gate");
    expect(stub).toContain("The gate is the helper bundles already use.");
    expect(stub).toContain('<span class="rev">removed</span>');
  });

  test("a pull request the base version carried and this one does not stays as a stub", () => {
    const before = doc();
    const after = doc((d) => {
      d.prs = d.prs.slice(0, d.prs.length - 1);
    });
    expect(after.prs.length).toBeLessThan(before.prs.length);
    const dropped = before.prs[before.prs.length - 1]!;
    const html = page(after, before);
    const at = html.indexOf('class="card dgoneunit"');
    expect(at).toBeGreaterThan(-1);
    const stub = unitAround(html, at);
    expect(stub).toContain('<span class="rev">removed</span>');
    expect(stub).toContain(textOf(dropped.gist).split(" ")[0]!);
    // What the menu counts, the page accounts for.
    const counts = new DeltaIndex(computeDelta(side(before), side(after))).counts();
    expect(counts.removed).toBe(
      [...html.matchAll(/<span class="rev">removed<\/span>/g)].length,
    );
  });

  test("prior text is behind a control everywhere it is drawn, and never left open", () => {
    const before = doc();
    const after = doc((d) => {
      d.title = `${d.title}, restated`;
      d.statements[0]!.body = "one two three four five alpha beta gamma delta epsilon";
    });
    const html = page(after, before);
    // The title stands on its own, so its prior words grow a control of their own.
    const head = html.slice(html.indexOf('<h1 class="title">'), html.indexOf("</h1>"));
    expect(head).toContain('class="dtog"');
    expect(head).toContain('class="dp"');
    // A whole prior block is hidden until its own checkbox is checked.
    expect(html).toContain(".dp.dpb { margin-top");
    expect(html).toContain(".dtog:checked + .dw + .dp.dpb { display: block; }");
    // The row reveal is scoped to the summary, so an open row does not print its
    // whole prior body.
    expect(html).toContain("details.row[open] > summary .dp");
    expect(html).not.toContain("details.row[open] .dp,");
    // The deletion caret is ink of its own rather than something a shut row hides.
    expect(html).toContain(".dw.dcut {");
    expect(html).not.toMatch(/\.dw\.dcut \{[^}]*display: none/);
  });

  test("every checkbox the delta emits has a name a screen reader can read", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements[0]!.body = "one two three four five alpha beta gamma delta epsilon";
    });
    const html = page(after, before);
    const boxes = [...html.matchAll(/<input type="checkbox" class="dtog"[^>]*>/g)];
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b[0]).toContain('aria-label="prior text"');
  });

  test("a head that moved marks the card without claiming a word changed", () => {
    const before = doc();
    const after = doc((d) => {
      d.prs[0]!.headSha = "9".repeat(40);
    });
    const html = page(after, before);
    expect(html).toContain("code moved");
    expect(html).not.toContain('<span class="rev">revised</span>');
  });

  test("two renders of the same pair are byte-identical", () => {
    const before = doc();
    const after = doc((d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.statements[0]!.body = "one two three four five alpha beta gamma delta epsilon";
      d.notes = [];
    });
    expect(page(after, before)).toBe(page(after, before));
  });

  test("no em dash reaches the copy of any file this step draws from", async () => {
    for (const path of COPY_SOURCES) {
      const source = await Bun.file(path).text();
      const authored = source
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"));
      expect(authored.join("\n")).not.toContain("—");
    }
  });
});

describe("authored evidence, and the fields that are not prose", () => {
  const example = {
    type: "example" as const,
    example: { lang: "ts", text: "const a = 1;", caption: "How a caller sees it" },
  };
  const attachment = {
    type: "attachment" as const,
    attachment: {
      id: "att_one",
      mediaType: "image/png",
      bytes: 10,
      alt: "The gate as a sequence",
      caption: "Where the check lands",
    },
  };
  const bundle = {
    type: "bundle" as const,
    bundle: { slug: "gate", version: null, caption: "The bundle it came from" },
  };
  const figure = {
    type: "figure" as const,
    figure: {
      kind: "flow" as const,
      nodes: [
        { id: "n1", label: "request", state: "normal" as const },
        { id: "n2", label: "gate", state: "normal" as const },
      ],
      edges: [{ from: "n1", to: "n2", label: "session" }],
    },
  };

  test("an example's text and caption are authored, and both are diffed", () => {
    const before = doc((d) => {
      d.statements[0]!.evidence = [example];
    });
    const after = doc((d) => {
      d.statements[0]!.evidence = [
        {
          type: "example",
          example: {
            lang: "ts",
            text: "const a = 2;",
            caption: "How a caller sees it after the rewrite",
          },
        },
      ];
    });
    const e = computeDelta(side(before), side(after)).entities.find(
      (x) => x.kind === "statement",
    )!;
    expect(e.status).toBe("revised");
    expect(e.fields.map((f) => f.field).sort()).toEqual(["ev-0-caption", "ev-0-text"]);
    expect(new DeltaIndex(computeDelta(side(before), side(after))).counts().revised).toBe(1);

    const html = page(after, before);
    const unit = unitAround(html, html.indexOf('id="st_gate"'));
    expect(unit).toContain('<span class="rev">revised</span>');
    expect(/class="(dw|dp)/.test(unit)).toBe(true);
    expect(unit).toContain("rewrite");
    // The words the caption used to say come back with it.
    expect(unit).toContain("How a caller sees it");
  });

  test("an attachment's alt text moves the page even though the image did not", () => {
    const before = doc((d) => {
      d.statements[0]!.evidence = [attachment];
    });
    const after = doc((d) => {
      d.statements[0]!.evidence = [
        { type: "attachment", attachment: { ...attachment.attachment, alt: "The gate as a table" } },
      ];
    });
    const e = computeDelta(side(before), side(after)).entities.find(
      (x) => x.kind === "statement",
    )!;
    expect(e.fields.map((f) => f.field)).toEqual(["ev-0-alt"]);
    const unit = unitAround(page(after, before), page(after, before).indexOf('id="st_gate"'));
    expect(unit).toContain('class="ev-was"');
    expect(unit).toContain("table");
    expect(unit).toContain("sequence");
    expect(unit).toContain('<span class="rev">revised</span>');
  });

  test("a bundle caption and a figure label are authored too", () => {
    const before = doc((d) => {
      d.notes[0]!.evidence = [bundle, figure];
    });
    const after = doc((d) => {
      d.notes[0]!.evidence = [
        { type: "bundle", bundle: { ...bundle.bundle, caption: "The bundle it grew from" } },
        {
          type: "figure",
          figure: {
            ...figure.figure,
            nodes: [
              { id: "n1", label: "request", state: "normal" },
              { id: "n2", label: "session gate", state: "normal" },
            ],
          },
        },
      ];
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "note")!;
    expect(e.fields.map((f) => f.field).sort()).toEqual(["ev-0-caption", "ev-1-node-n2"]);
    const html = page(after, before);
    const unit = unitAround(html, html.indexOf('id="no_keys"'));
    expect(unit).toContain("grew");
    expect(unit).toContain('class="ev-was"');
  });

  test("evidence the base version carried and this one dropped comes back", () => {
    const before = doc((d) => {
      d.statements[0]!.evidence = [example];
    });
    const after = doc((d) => {
      d.statements[0]!.evidence = [];
    });
    const e = computeDelta(side(before), side(after)).entities.find(
      (x) => x.kind === "statement",
    )!;
    expect(e.fields.map((f) => f.field).sort()).toEqual(["ev-0-caption", "ev-0-text"]);
    const html = page(after, before);
    const unit = unitAround(html, html.indexOf('id="st_gate"'));
    expect(unit).toContain("How a caller sees it");
    expect(unit).toContain("const a = 1;");
    expect(unit).toContain('<span class="rev">revised</span>');
  });

  test("a risk quietly restated as a note is a movement the page shows", () => {
    const before = doc();
    const after = doc((d) => {
      d.notes[0]!.kind = "note";
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "note")!;
    expect(e.fields.map((f) => f.field)).toEqual(["kind"]);
    const html = page(after, before);
    const unit = unitAround(html, html.indexOf('id="no_keys"'));
    expect(unit).toContain('<span class="rev">revised</span>');
    expect(unit).toContain("risk");
    expect(/class="(dw|dp)/.test(unit)).toBe(true);
  });

  test("a group that lost a file says so, and the path comes back", () => {
    const before = doc();
    const dropped = before.hunks[before.hunks.length - 1]!;
    const kept = before.groups[0]!.hunks.filter((id) => id !== dropped.id);
    expect(kept.length).toBeLessThan(before.groups[0]!.hunks.length);
    const after = doc((d) => {
      d.groups[0]!.hunks = kept;
    });
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "group")!;
    expect(e.fields.some((f) => f.field === "files")).toBe(true);
    const html = page(after, before);
    const unit = unitAround(html, html.indexOf('id="gr_gate"'));
    expect(unit).toContain('class="gfiles"');
    expect(unit).toContain('<span class="rev">revised</span>');
    expect(unit).toContain(dropped.path);
  });

  test("a removed note keeps the kind it was removed with", () => {
    const before = doc();
    const after = doc((d) => {
      d.notes = [];
    });
    expect(before.notes[0]!.kind).toBe("risk");
    const e = computeDelta(side(before), side(after)).entities.find((x) => x.kind === "note")!;
    expect(e.formerKind).toBe("risk");
    const html = page(after, before);
    const at = html.indexOf(`dgone-${safeId("no_keys")}`);
    expect(at).toBeGreaterThan(-1);
    const stub = unitAround(html, at);
    expect(stub).toContain('class="note is-risk dgoneunit"');
    expect(stub).toContain('href="#i-risk"');
    expect(stub).toContain('<span class="rev">removed</span>');
  });

  test("a removed group keeps the kind it was removed with", () => {
    const before = doc();
    const gone = before.groups[0]!;
    const after = doc((d) => {
      d.groups = d.groups.filter((g) => g.id !== gone.id);
      d.hunks = d.hunks.filter((h) => !gone.hunks.includes(h.id));
    });
    const e = computeDelta(side(before), side(after)).entities.find(
      (x) => x.kind === "group" && x.id === gone.id,
    )!;
    expect(e.status).toBe("removed");
    expect(e.formerKind).toBe(gone.kind);
    const html = page(after, before);
    const at = html.indexOf(`dgone-${safeId(gone.id)}`);
    expect(at).toBeGreaterThan(-1);
    const stub = unitAround(html, at);
    expect(stub).toContain(`<svg class="ic k-${gone.kind}"`);
    expect(stub).toContain(`href="#i-${gone.kind}"`);
    expect(stub).toContain(gone.title);
    expect(stub).toContain('<span class="rev">removed</span>');
  });

  test("a summary-only revision is movement the timeline names", () => {
    const before = doc();
    const after = doc((d) => {
      d.summary = `${d.summary}\n\nA whole new paragraph the reader has not seen before.`;
      d.title = `${d.title}, restated`;
    });
    const counts = new DeltaIndex(computeDelta(side(before), side(after))).counts();
    expect(counts.revised).toBe(0);
    expect(counts.restated).toEqual(["title", "summary"]);
  });

  test("a quoted thing is still never marked inside", () => {
    const before = doc((d) => {
      d.statements[0]!.evidence = [
        { type: "payload", payload: { lang: "json", before: "{a:1}", after: "{a:2}", highlight: [] } },
      ];
    });
    const after = doc((d) => {
      d.statements[0]!.evidence = [
        { type: "payload", payload: { lang: "json", before: "{a:1}", after: "{a:9}", highlight: [] } },
      ];
    });
    expect(computeDelta(side(before), side(after)).entities).toEqual([]);
  });
});

describe("which version the marks are measured against", () => {
  test("the reader's last-opened version wins, clamped below the one being read", () => {
    expect(baseVersion(null, 3, 1)).toBe(1);
    expect(baseVersion(null, 3, 3)).toBe(2);
    expect(baseVersion(null, 3, 9)).toBe(2);
  });

  test("a reader who never opened this review gets the previous version", () => {
    expect(baseVersion(null, 3, null)).toBe(2);
  });

  test("the first version ever published has no base and renders no marks", () => {
    expect(baseVersion(null, 1, null)).toBe(null);
    expect(baseVersion(null, 1, 1)).toBe(null);
  });

  test("from overrides the reader's own history, and nonsense falls back", () => {
    expect(baseVersion("2", 4, 1)).toBe(2);
    expect(baseVersion("4", 4, 1)).toBe(1);
    expect(baseVersion("nope", 4, 1)).toBe(1);
  });
});

// ---- over the routes ----

let server: Awaited<ReturnType<typeof startServer>>;
let host = "";
let ws = "";

function publish(slug: string, over: (d: Doc) => void): number {
  const d = doc(over);
  const { id: _id, slug: _slug, version: _version, ...rest } = d;
  return createReviewVersion(ws, slug, rest);
}

beforeAll(async () => {
  server = await startServer();
  host = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Delta", owner);
  db.run("SELECT 1");
});

afterAll(() => {
  server.stop(true);
});

describe("the revision timeline over the routes", () => {
  test("a reader who opened v1 sees v3 against v1, and from overrides it", async () => {
    const slug = "timeline";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
    });
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.notes[0]!.text = "A key minted before the gate reads only its own workspace";
    });

    // Opening v1 is what puts this reader's read state at v1.
    expect((await fetch(`${host}/${ws}/r/${slug}/v/1`)).status).toBe(200);

    const three = await fetch(`${host}/${ws}/r/${slug}`);
    const html = await three.text();
    expect(html).toContain("marks since v1");
    // The statement moved in v2 and the note in v3, so both are marked against v1.
    expect(html).toContain("session");
    expect((html.match(/<span class="rev">revised<\/span>/g) ?? []).length).toBeGreaterThan(1);

    const from = await (await fetch(`${host}/${ws}/r/${slug}?from=2`)).text();
    expect(from).toContain("marks since v2");
    // Against v2 only the note moved.
    expect((from.match(/<span class="rev">revised<\/span>/g) ?? []).length).toBe(1);
  });

  test("a reader who never opened a review reads the newest version against the one before it", async () => {
    const slug = "unopened";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.groups[0]!.title = "The gate, restated";
    });
    const html = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    expect(html).toContain("marks since v1");
  });

  test("the first version of a review renders no marks", async () => {
    const slug = "firstopen";
    publish(slug, () => {});
    const html = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    expect(html).not.toContain("marks since");
    expect(html).not.toContain('<span class="rev">');
  });

  test("the revision menu lists every version with what moved in it", async () => {
    const slug = "menu";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.prs[0]!.headSha = "9".repeat(40);
    });
    const html = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    expect(html).toContain('id="revisions"');
    expect(html).toContain(`href="/${ws}/r/${slug}/v/2"`);
    expect(html).toContain(`href="/${ws}/r/${slug}/v/1"`);
    expect(html).toContain("?from=1");
    expect(html).toContain("1 revised");
    // v1 has nothing before it, so it moved nothing.
    expect(html).toContain("nothing moved");
    expect(html).toContain("code moved");
  });

  test("a version whose only movement is its summary never says nothing moved", async () => {
    const slug = "restated";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.summary = `${d.summary}\n\nA whole new paragraph the reader has not seen before.`;
      d.title = `${d.title}, restated`;
    });
    const html = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    // The page marks the summary, so the menu row for the version that moved it may
    // not deny it. Only v1, which has nothing before it, moved nothing.
    expect(html).toContain("marks since v1");
    expect(html).toContain("title and summary restated");
    expect((html.match(/nothing moved/g) ?? []).length).toBe(1);
  });

  test("a version whose only movement is a head sha never says nothing moved", async () => {
    const slug = "shaonly";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.prs[0]!.headSha = "9".repeat(40);
    });
    const html = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    // The row marks the move with its own chip, so it may not deny it in the same
    // breath. Only v1, which has nothing before it, moved nothing.
    expect(html).toContain("code moved");
    expect((html.match(/nothing moved/g) ?? []).length).toBe(1);
  });

  test("only a version below the one being read carries a from link", async () => {
    const slug = "fromlinks";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
    });
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.notes[0]!.text = "A key minted before the gate reads only its own workspace";
    });
    const html = await (await fetch(`${host}/${ws}/r/${slug}/v/2`)).text();
    // v1 is below v2 and can be a base. v3 is not, and offers no control at all.
    expect(html).toContain("?from=1");
    expect(html).not.toContain("?from=3");
    expect(html).not.toContain("?from=2");
    // Every from link on the page is one the page would honour.
    for (const m of html.matchAll(/\?from=([0-9]+)/g)) {
      expect(Number(m[1])).toBeLessThan(2);
    }
  });

  test("opening a version moves the reader's mark, so the next open measures from here", async () => {
    const slug = "advance";
    publish(slug, () => {});
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
    });
    publish(slug, (d) => {
      d.statements[0]!.text = "Reviews move behind the workspace login gate";
      d.notes[0]!.text = "A key minted before the gate reads only its own workspace";
    });
    expect((await fetch(`${host}/${ws}/r/${slug}/v/1`)).status).toBe(200);
    const first = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    expect(first).toContain("marks since v1");
    // The read moved to v3 on that request, so the next one measures from v2. The
    // page says which base it used both times, so the change is never silent.
    const second = await (await fetch(`${host}/${ws}/r/${slug}`)).text();
    expect(second).toContain("marks since v2");
    // A named base is unaffected by any of it, and repeats byte for byte.
    const pinned = await (await fetch(`${host}/${ws}/r/${slug}?from=1`)).text();
    const again = await (await fetch(`${host}/${ws}/r/${slug}?from=1`)).text();
    expect(pinned).toBe(again);
  });
});

describe("evidence fields a stored document does not carry", () => {
  test("an absent optional field is not a delta target and does not throw", () => {
    // The witness may omit an optional field rather than send "". Naming it as a
    // field would claim the next version removed something that was never there.
    const evidence = [
      { type: "figure", figure: { kind: "flow", nodes: [{ id: "a", label: "A", state: "normal" }], edges: [{ from: "a", to: "a" }] } },
      { type: "bundle", bundle: { slug: "b", version: null } },
    ] as never;
    const names = evidenceFieldNames(evidence);
    expect(names).toEqual(["ev-0-node-a"]);
  });
});
