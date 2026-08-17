// The walkthrough, the hunks inside it, the syntax classes on their lines, and the
// figure the layout draws.
//
// The claim the whole section rests on is that the groups partition the document's
// hunks, so the first test here walks the document's own hunk ids against the ids that
// reached the page and expects each one exactly once. The rest hold the page to the
// document in the same way: the line numbers are the parsed ones, the word marks are
// the parsed ranges, and two renders of one document are the same bytes.

import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";

import { renderReviewPage } from "../../src/overseer/render";
import { codeHtml, groupsInOrder, langOfPath, walkthroughSection } from "../../src/overseer/render-diff";
import { figureLabel, figureSvg } from "../../src/overseer/figure";
import { lineDiff } from "../../src/overseer/diff";
import type { ReviewDoc } from "../../src/overseer/db";
import type { Group, Hunk } from "../../src/overseer/types";
import { GOLDEN_HUNKS } from "./fixtures/golden-review";
import { goldenStoredDoc } from "./fixtures/stored-review";

function doc(over: Partial<ReviewDoc> = {}): ReviewDoc {
  return { ...goldenStoredDoc(), id: "rev_test", slug: "golden", version: 1, ...over };
}

function page(document: ReviewDoc): string {
  return renderReviewPage({
    wsId: "ws_test",
    slug: "golden",
    doc: document,
    version: 1,
    latestVersion: 1,
    pinned: false,
    freshness: {},
  });
}

function group(over: Partial<Group> = {}): Group {
  return {
    id: "gr_a",
    title: "A group",
    significance: 1,
    paragraph: "What it does.",
    hunks: [],
    fileNotes: [],
    kind: "change",
    ...over,
  };
}

/** The two groups the golden hunks split into, as the derived facts have them. */
function twoGroups(): Group[] {
  return [
    group({
      id: "gr_gate",
      title: "The gate",
      significance: 1,
      hunks: [GOLDEN_HUNKS.auth.id, GOLDEN_HUNKS.serverGate.id],
      fileNotes: [{ path: GOLDEN_HUNKS.auth.path, text: "The helper itself" }],
    }),
    group({
      id: "gr_api",
      title: "The endpoints",
      significance: 2,
      hunks: [GOLDEN_HUNKS.serverApi.id, GOLDEN_HUNKS.routes.id, GOLDEN_HUNKS.tests.id],
      kind: "add",
    }),
  ];
}

function hunkIdsOf(html: string): string[] {
  return [...html.matchAll(/data-hunk="([^"]+)"/g)].map((m) => m[1]!);
}

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("the walkthrough", () => {
  test("every hunk of the document reaches the page exactly once", () => {
    const d = doc({ groups: twoGroups() });
    const ids = hunkIdsOf(walkthroughSection(d));
    const want = d.hunks.map((h) => h.id);
    expect(ids.length).toBe(want.length);
    expect([...ids].sort()).toEqual([...want].sort());
    for (const id of want) {
      expect(ids.filter((x) => x === id).length).toBe(1);
    }
  });

  test("groups come out in significance order, ties broken by id", () => {
    const groups = [
      group({ id: "gr_c", significance: 2, hunks: [GOLDEN_HUNKS.tests.id] }),
      group({ id: "gr_b", significance: 1, hunks: [GOLDEN_HUNKS.routes.id] }),
      group({ id: "gr_a", significance: 1, hunks: [GOLDEN_HUNKS.auth.id] }),
    ];
    expect(groupsInOrder(groups).map((g) => g.id)).toEqual(["gr_a", "gr_b", "gr_c"]);
    // The sort does not touch the array it was handed.
    expect(groups.map((g) => g.id)).toEqual(["gr_c", "gr_b", "gr_a"]);

    const html = walkthroughSection(doc({ groups }));
    const order = [...html.matchAll(/<details class="grp" id="([^"]+)"/g)].map((m) => m[1]!);
    expect(order).toEqual(["gr_a", "gr_b", "gr_c"]);
  });

  test("two renders of one document are the same bytes", () => {
    const d = doc({ groups: twoGroups() });
    expect(page(d)).toBe(page(d));
    // Even when the groups arrive in a different order and tie on significance.
    const tied = [
      group({ id: "gr_b", significance: 1, hunks: [GOLDEN_HUNKS.routes.id] }),
      group({ id: "gr_a", significance: 1, hunks: [GOLDEN_HUNKS.auth.id] }),
    ];
    const one = walkthroughSection(doc({ groups: tied }));
    const other = walkthroughSection(doc({ groups: [...tied].reverse() }));
    expect(one).toBe(other);
  });

  test("the line numbers on the page are the ones the document carries", () => {
    const hunk = GOLDEN_HUNKS.auth;
    const html = walkthroughSection(
      doc({ groups: [group({ hunks: [hunk.id] })] }),
    );
    const block = html.match(/<div class="hunk"[\s\S]*?<\/pre>/)![0];
    const numbers = [...block.matchAll(/<span class="n">([^<]*)<\/span>/g)].map((m) => m[1]!);
    // A deletion counts against the old file, everything else against the new one.
    expect(numbers).toEqual(
      hunk.lines.map((l) => {
        const no = l.kind === "del" ? l.oldNo : l.newNo;
        return no === null ? "" : String(no);
      }),
    );
    // Nothing on the page recounts the range either.
    expect(block).toContain(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    expect(block).toContain(`#${hunk.prNumber} ${hunk.sha.slice(0, 7)}`);
  });

  test("a hunk's source links to those lines on the pull request's files tab", () => {
    const hunk = GOLDEN_HUNKS.auth;
    const html = walkthroughSection(doc({ groups: [group({ hunks: [hunk.id] })] }));
    // The anchor GitHub keys a file by: the SHA-256 of its path, computed here a
    // second time so the page is held to the mechanism rather than to itself.
    const anchor = createHash("sha256").update(hunk.path).digest("hex");
    expect(html).toContain(
      `<span class="hh-src"><a href="https://github.com/${hunk.repo}/pull/${hunk.prNumber}` +
        `/files#diff-${anchor}R${hunk.newStart}">#${hunk.prNumber} ${hunk.sha.slice(0, 7)}</a></span>`,
    );
  });

  test("a hunk that only deletes links to its file, not to a new-side line", () => {
    const source = GOLDEN_HUNKS.auth;
    const hunk: Hunk = {
      ...source,
      newLines: 0,
      lines: [{ kind: "del", oldNo: 40, newNo: null, content: "gone();", wordRanges: [] }],
    };
    const html = walkthroughSection(
      doc({ hunks: [hunk], groups: [group({ hunks: [hunk.id] })] }),
    );
    const anchor = createHash("sha256").update(hunk.path).digest("hex");
    expect(html).toContain(`/files#diff-${anchor}"`);
    expect(html).not.toContain(`/files#diff-${anchor}R`);
  });

  test("word marks land exactly on the ranges the hunk carries, and nowhere else", () => {
    const source = GOLDEN_HUNKS.auth;
    const del = { ...source.lines[1]!, wordRanges: [[9, 13]] as [number, number][] };
    const add = { ...source.lines[2]!, wordRanges: [[9, 30]] as [number, number][] };
    const hunk: Hunk = {
      ...source,
      lines: [source.lines[0]!, del, add, source.lines[3]!],
    };
    const html = walkthroughSection(
      doc({ hunks: [hunk], groups: [group({ hunks: [hunk.id] })] }),
    );
    // One mark per line that carried a range, holding exactly the characters the
    // range names once the syntax spans inside it are stripped back off.
    const lines = html.split('<span class="l').slice(1);
    expect(lines.length).toBe(hunk.lines.length);
    const marksOn = (line: string) =>
      [...line.matchAll(/<span class="w">((?:(?!<span class="w">)[\s\S])*?)<\/span>(?=<|$)/g)].map(
        (m) => unescape(m[1]!.replace(/<[^>]*>/g, "")),
      );
    expect(marksOn(lines[0]!)).toEqual([]);
    expect(marksOn(lines[1]!)).toEqual([del.content.slice(9, 13)]);
    expect(marksOn(lines[2]!)).toEqual([add.content.slice(9, 30)]);
    expect(marksOn(lines[3]!)).toEqual([]);
    expect(html.match(/class="w"/g)!.length).toBe(2);
  });

  test("a group paragraph is block markdown, rendered as markup and not as source", () => {
    const g = group({
      hunks: [GOLDEN_HUNKS.auth.id],
      paragraph: "The session check, see [the gate](https://example.com).\n\n- one\n- two",
    });
    const html = walkthroughSection(doc({ hunks: [GOLDEN_HUNKS.auth], groups: [g] }));
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<li>one</li>");
    expect(html).not.toContain("[the gate]");
    expect(html).not.toContain("- one");
  });

  test("the golden document draws the word marks its hunks carry", () => {
    const document = doc({ groups: twoGroups() });
    const marked = document.hunks.flatMap((h) => h.lines.filter((l) => l.wordRanges.length > 0));
    expect(marked.length).toBeGreaterThan(0);
    const html = walkthroughSection(document);
    const total = marked.reduce((n, l) => n + l.wordRanges.length, 0);
    expect(html.match(/class="w"/g)!.length).toBe(total);
  });

  test("added and removed lines are counted off the lines themselves", () => {
    const html = walkthroughSection(doc({ groups: twoGroups() }));
    // Every golden hunk holds one addition and one deletion; src/server.ts appears in
    // the first group once, so its row counts one of each.
    expect(html).toContain(`<span class="s-add">+1</span> <span class="s-del">−1</span>`);
  });

  test("adjacent hunks from different pull requests are marked as a seam", () => {
    // Both src/server.ts hunks in one group: they come from #12 and #13.
    const g = group({
      hunks: [GOLDEN_HUNKS.serverGate.id, GOLDEN_HUNKS.serverApi.id],
    });
    const html = walkthroughSection(doc({ groups: [g] }));
    expect(html.match(/data-src-break/g)!.length).toBe(1);
    // One file row holding two hunks sums both of them, rather than counting one.
    expect(html).toContain(`<span class="s-add">+2</span> <span class="s-del">−2</span>`);
    // The first hunk of the file is nobody's neighbour.
    const first = html.indexOf(`data-hunk="${GOLDEN_HUNKS.serverGate.id}"`);
    expect(html.slice(first, first + 200)).not.toContain("data-src-break");
  });

  test("file rows carry their file note and only their own", () => {
    const html = walkthroughSection(doc({ groups: twoGroups() }));
    expect(html).toContain('<span class="fnote">The helper itself</span>');
    expect(html.match(/class="fnote"/g)!.length).toBe(1);
  });

  test("the walkthrough is disclosures alone, with no script behind it", () => {
    const html = page(doc({ groups: twoGroups() })).replace(/<script[\s\S]*?<\/script>/g, "");
    const start = html.indexOf('<section id="walkthrough"');
    const section = html.slice(start, html.indexOf("</section>", start));
    expect(section).toContain('<details class="grp"');
    expect(section).toContain('<details class="frow">');
    expect(section).not.toMatch(/\son[a-z]+\s*=/i);
    expect(section).not.toContain("<script");
    // The one control the walkthrough carries is the full-screen panel, and it
    // ships hidden: a page with no script never offers a button that does
    // nothing, and the diff under it reads either way.
    for (const tag of section.match(/<button[^>]*>/g) ?? []) {
      expect(tag).toContain(' hidden ');
      expect(tag).toContain('class="zoom"');
    }
    expect(section).toContain('data-zoom="src/auth.ts"');
    // The contents row points at it.
    expect(html).toContain('<a href="#walkthrough">implementation walkthrough</a>');
  });

  test("a group naming a hunk the document has no facts for draws the rest", () => {
    const g = group({ hunks: ["pr99:nowhere.ts:@@1,1+1,1", GOLDEN_HUNKS.auth.id] });
    const html = walkthroughSection(doc({ groups: [g] }));
    expect(hunkIdsOf(html)).toEqual([GOLDEN_HUNKS.auth.id]);
  });
});

describe("syntax", () => {
  test("the language is read off the path, and an unknown one gets none", () => {
    expect(langOfPath("src/auth.ts")).toBe("ts");
    expect(langOfPath("src/app.tsx")).toBe("ts");
    expect(langOfPath("package.json")).toBe("json");
    expect(langOfPath("README.md")).toBe(null);
    expect(langOfPath("Makefile")).toBe(null);
  });

  test("the four classes, on one line of TypeScript", () => {
    const html = codeHtml('const Gate = "on"; // why', "ts");
    expect(html).toContain('<span class="kw">const</span>');
    expect(html).toContain('<span class="ty">Gate</span>');
    expect(html).toContain('<span class="st">&quot;on&quot;</span>');
    expect(html).toContain('<span class="cm">// why</span>');
  });

  test("what the tokenizer has no opinion about keeps the ink around it", () => {
    // Only the four classes are ever emitted. Punctuation was briefly a fifth and its
    // cost was a doubling of the markup of every hunk, so a brace, an operator and a
    // separator are the ink of the code and carry no span at all.
    const html = codeHtml("const x = { a: 1 };", "ts");
    expect(html).not.toContain('class="pn"');
    expect(html).toBe('<span class="kw">const</span> x = { a: <span class="st">1</span> };');
    // And a letter the tokenizer does not know is a letter, not a symbol: a negated
    // character class would have greyed these out one at a time, mid-word.
    expect(codeHtml("const naïve = café(x);", "ts")).toContain("naïve = café(x);");
    expect(codeHtml("const 名前 = 値;", "ts")).toContain("名前 = 値;");
  });

  test("a declared name is a name whatever case it is written in", () => {
    expect(codeHtml("function gate(req) {", "ts")).toContain('<span class="ty">gate</span>');
    expect(codeHtml("  const slug = value;", "ts")).not.toContain('class="ty"');
  });

  test("an unterminated string or comment stops at the end of its line", () => {
    expect(codeHtml('const s = "open', "ts")).toContain('<span class="st">&quot;open</span>');
    expect(codeHtml("x /* open", "ts")).toContain('<span class="cm">/* open</span>');
  });

  test("a JSON key is a name and its value is a literal", () => {
    const html = codeHtml('  "slug": "atlas", "n": 3, "ok": true', "json");
    expect(html).toContain('<span class="ty">&quot;slug&quot;</span>');
    expect(html).toContain('<span class="st">&quot;atlas&quot;</span>');
    expect(html).toContain('<span class="st">3</span>');
    expect(html).toContain('<span class="kw">true</span>');
  });

  test("an unknown language is escaped text and nothing else", () => {
    const html = codeHtml('const x = "<b>"; // no', null);
    expect(html).toBe("const x = &quot;&lt;b&gt;&quot;; // no");
  });

  test("a mark wraps its syntax rather than the other way round", () => {
    const html = codeHtml('const x = "on";', "ts", [[10, 14]]);
    expect(html).toContain('<span class="w"><span class="st">&quot;on&quot;</span></span>');
  });

  test("a range the line cannot hold is dropped, and a zero width one is a seam", () => {
    expect(codeHtml("abc", null, [[2, 1]])).toBe("abc");
    // Wholly off the line: dropped rather than clamped into a seam at column 0.
    expect(codeHtml("abc", null, [[-5, -1]])).toBe("abc");
    expect(codeHtml("abc", null, [[7, 9]])).toBe("abc");
    expect(codeHtml("abc", null, [[0, 99]])).toBe('<span class="w">abc</span>');
    expect(codeHtml("abc", null, [[3, 3]])).toBe('abc<span class="w"></span>');
    // Overlapping ranges merge instead of nesting.
    expect(codeHtml("abcdef", null, [[0, 3], [2, 5]])).toBe('<span class="w">abcde</span>f');
  });
});

describe("figures", () => {
  const figure = {
    kind: "flow" as const,
    nodes: [
      { id: "in", label: "GET /s/:token", state: "normal" as const },
      { id: "res", label: "resolve", state: "normal" as const },
      { id: "old", label: "GET /b/:slug", state: "muted" as const },
    ],
    edges: [
      { from: "in", to: "res", label: "match" },
      { from: "old", to: "res", label: "" },
    ],
  };

  test("nodes and edges are drawn, muted state included", () => {
    const svg = figureSvg(figure);
    expect(svg.startsWith('<svg class="fig"')).toBe(true);
    expect(svg).toContain(">GET /s/:token</text>");
    expect(svg).toContain(">resolve</text>");
    expect(svg).toContain(">GET /b/:slug</text>");
    expect(svg.match(/<rect /g)!.length).toBe(3);
    expect(svg.match(/<path class="fig-edge/g)!.length).toBe(2);
    expect(svg).toContain('class="fig-box fig-dim"');
    expect(svg).toContain(">match</text>");
  });

  test("the whole drawing is one image with a composed label", () => {
    expect(figureLabel(figure)).toBe(
      "A flow figure: GET /s/:token, resolve, GET /b/:slug (muted). " +
        "GET /s/:token to resolve, match. GET /b/:slug to resolve.",
    );
    expect(figureSvg(figure)).toContain(`role="img" aria-label="${figureLabel(figure)}"`);
  });

  test("an edge with no label at all draws, and does not cost the page", () => {
    // A stored document may omit an optional field entirely rather than send "".
    // The renderer must treat absent and empty the same way: no label, no throw.
    const bare = {
      kind: "flow" as const,
      nodes: figure.nodes,
      edges: [{ from: "in", to: "res" }, { from: "old", to: "res", label: "" }],
    } as unknown as typeof figure;
    const svg = figureSvg(bare);
    expect(svg.match(/<path class="fig-edge/g)!.length).toBe(2);
    expect(svg).not.toContain("undefined");
    expect(figureLabel(bare)).toBe(
      "A flow figure: GET /s/:token, resolve, GET /b/:slug (muted). " +
        "GET /s/:token to resolve. GET /b/:slug to resolve.",
    );
  });

  test("the layout is layered top-down and stable", () => {
    const svg = figureSvg(figure);
    const ys = [...svg.matchAll(/<rect class="[^"]*" x="[^"]*" y="([^"]*)"/g)].map((m) => Number(m[1]));
    // The two entry nodes share the first rank; the node both point at sits below,
    // and the rects come out rank by rank rather than in the order they were authored.
    expect(ys[0]).toBe(ys[1]!);
    expect(ys[2]!).toBeGreaterThan(ys[0]!);
    expect(figureSvg(figure)).toBe(svg);
  });

  test("a cycle lays out rather than looping forever", () => {
    const svg = figureSvg({
      kind: "flow",
      nodes: [
        { id: "a", label: "a", state: "normal" },
        { id: "b", label: "b", state: "normal" },
      ],
      edges: [
        { from: "a", to: "b", label: "" },
        { from: "b", to: "a", label: "" },
      ],
    });
    expect(svg.match(/<rect /g)!.length).toBe(2);
  });

  test("an edge naming a node the figure does not have is not drawn", () => {
    const svg = figureSvg({
      kind: "flow",
      nodes: [{ id: "a", label: "a", state: "normal" }],
      edges: [{ from: "a", to: "gone", label: "x" }],
    });
    expect(svg).not.toContain("<path");
    expect(svg).not.toContain(">x</text>");
    // The label is composed from the edges that were drawn, so it does not announce an
    // arrow the sighted reader cannot see.
    expect(svg).not.toContain("a to gone");
  });

  test("a label with markup in it arrives escaped", () => {
    const svg = figureSvg({
      kind: "flow",
      nodes: [{ id: "a", label: '<script>alert(1)</script>', state: "normal" }],
      edges: [],
    });
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("payload as a diff", () => {
  const rows = (before: string, after: string) => lineDiff(before, after);

  test("one changed word marks that word, and leaves its neighbours as context", () => {
    const r = rows('{\n  "url": 1\n}', '{\n  "shareUrl": 1\n}');
    expect(r.map((x) => x.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    const del = r[1]!;
    const add = r[2]!;
    // The mark covers the key that moved, not the whole line.
    expect(del.wordRanges.length).toBeGreaterThan(0);
    expect(add.wordRanges.length).toBeGreaterThan(0);
    const marked = add.content.slice(add.wordRanges[0]![0], add.wordRanges[0]![1]);
    expect(marked).toContain("shareUrl");
    expect(marked).not.toContain("{");
  });

  test("a pure addition has no deletions, and a pure deletion no additions", () => {
    const added = rows("a\nb", "a\nb\nc");
    expect(added.filter((x) => x.kind === "del")).toEqual([]);
    expect(added.filter((x) => x.kind === "add").map((x) => x.content)).toEqual(["c"]);

    const removed = rows("a\nb\nc", "a\nb");
    expect(removed.filter((x) => x.kind === "add")).toEqual([]);
    expect(removed.filter((x) => x.kind === "del").map((x) => x.content)).toEqual(["c"]);
  });

  test("identical sides are all context and do not throw", () => {
    const r = rows("same\nlines", "same\nlines");
    expect(r.map((x) => x.kind)).toEqual(["ctx", "ctx"]);
    expect(r.every((x) => x.wordRanges.length === 0)).toBe(true);
  });

  test("a trailing newline does not invent an empty last row", () => {
    expect(rows("a\n", "a\n").length).toBe(1);
  });

  test("the same pair diffs identically twice", () => {
    const a = JSON.stringify(rows('{ "a": 1 }', '{ "a": 2 }'));
    const b = JSON.stringify(rows('{ "a": 1 }', '{ "a": 2 }'));
    expect(a).toBe(b);
  });
});

describe("what the walkthrough could not cover", () => {
  test("a file with no diff is named above the groups, or the partition promise is a lie", () => {
    const d = doc({
      groups: twoGroups(),
      unaccounted: [
        {
          repo: "acme/seer",
          prNumber: 12,
          path: "tests/fixtures/huge.json",
          status: "added",
          reason: "GitHub returned no patch for this file, and the pull request diff could not be read: too large.",
        },
      ],
    });
    const html = walkthroughSection(d);
    expect(html).toContain("One file of this change is not in the walkthrough below.");
    expect(html).toContain("tests/fixtures/huge.json");
    expect(html).toContain("too large");
    // Above the groups: it qualifies all of them.
    expect(html.indexOf("unaccounted")).toBeLessThan(html.indexOf('class="walk"'));
  });

  test("a review that accounts for everything says nothing", () => {
    const html = walkthroughSection(doc({ groups: twoGroups(), unaccounted: [] }));
    expect(html).not.toContain("unaccounted");
    expect(html).not.toContain("not in the walkthrough");
  });
});
