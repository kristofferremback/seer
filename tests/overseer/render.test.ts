// The renderer: the page a review is read as, and the gate in front of it.
//
// Two halves. The first renders documents directly and reads the HTML: what survives
// with every script stripped, what order notes come out in, what an example may not
// contain, and what an authored string looks like once it reaches the page. The second
// runs the routes over a real server, because the soft-404 claim is about bytes on the
// wire rather than about a string a function returned.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { createAttachment } from "../../src/overseer/db";
import { saveAttachment } from "../../src/store";
import { tinyId } from "../../src/ids";
import { renderReviewPage } from "../../src/overseer/render";
import type { ReviewDoc } from "../../src/overseer/db";
import type { Evidence, Note, Ref, Statement } from "../../src/overseer/types";
import { GOLDEN_REPO } from "./fixtures/golden-review";
import { goldenStoredDoc, storeGoldenReview } from "./fixtures/stored-review";

const RENDER_SOURCE = `${import.meta.dir}/../../src/overseer/render.ts`;
const EVIDENCE_SOURCE = `${import.meta.dir}/../../src/overseer/render-evidence.ts`;

function ref(id: string, path: string, startLine = 40): Ref {
  return {
    id,
    repo: GOLDEN_REPO,
    sha: "4".repeat(40),
    path,
    startLine,
    endLine: startLine + 2,
    highlight: [startLine + 1],
    origin: "in_stack",
    snippet: "const gate = true;\nif (gate) return null;\nreturn deny();\n",
  };
}

function statement(over: Partial<Statement> = {}): Statement {
  return {
    id: "st_x",
    kind: "add",
    text: "The gate moves to the session helper",
    prs: [`${GOLDEN_REPO}#12`],
    refs: [ref("ref_a", "src/auth.ts")],
    body: "Plain body.",
    evidence: [],
    ...over,
  };
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: "no_x",
    kind: "note",
    text: "A note",
    body: "Body.",
    checks: [],
    refs: [],
    evidence: [],
    ...over,
  };
}

/** The golden stored document with the pieces a render test needs swapped in. */
function doc(over: Partial<ReviewDoc> = {}): ReviewDoc {
  return {
    ...goldenStoredDoc(),
    id: "rev_test",
    slug: "golden",
    version: 1,
    ...over,
  };
}

function page(document: ReviewDoc, over: Partial<Parameters<typeof renderReviewPage>[0]> = {}): string {
  return renderReviewPage({
    wsId: "ws_test",
    slug: "golden",
    doc: document,
    version: 1,
    latestVersion: 1,
    pinned: false,
    freshness: {},
    ...over,
  });
}

function withoutScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

describe("the page itself", () => {
  test("nothing on the page depends on a script", () => {
    const html = page(
      doc({
        statements: [statement({ id: "st_a" }), statement({ id: "st_b", kind: "change" })],
      }),
    );
    // No inline handlers anywhere, script or no script.
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);

    const stripped = withoutScripts(html);
    expect(stripped).not.toContain("<script");
    // Every disclosure is markup, not behaviour.
    expect(stripped).toContain(`<details class="row" id="st_a"`);
    expect(stripped).toContain("<summary>");
    // Every citation is a fragment link to a panel that exists on the page.
    const links = [...stripped.matchAll(/<a class="ref" href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const id of links) expect(stripped).toContain(`<details class="fold" id="${id}"`);
    // The one control that needs a script is hidden until it has one.
    expect(stripped).toContain("data-theme-toggle hidden");
  });

  test("the refresh button tells a fresh observation from the recorded one", () => {
    const html = page(doc(), { canRefresh: true });
    // The route answers 200 with `checked:false` when the window refused the fetch, so
    // a 200 alone is not grounds to reload: that would show the reader the same stale
    // page and call it new.
    expect(html).not.toContain("String(r.status));location.reload()");
    expect(html).toContain("d.checked===false");
    expect(html).toContain("checked moments ago \\u2014 try again shortly");
    // A transport failure still says so and leaves the button pressable.
    expect(html).toContain("refresh failed \\u2014 try again");
  });

  test("the page names the forest, design, focus, and implementation layers", () => {
    const html = page(doc());
    expect(html).toContain('<section id="summary"><h2>Overview</h2>');
    expect(html).toContain('<section id="design"><h2>Code design</h2>');
    expect(html).toContain('<section id="notes"><h2>Review focus</h2>');
    expect(html).toContain('<span>Implementation walkthrough</span>');
    // The arc's stations carry stable ids, for whatever navigation points at them.
    // Nothing navigational sits inside the column itself.
    expect(html).toContain('<div class="account" id="problem">');
    expect(html).toContain('<div class="account" id="solution">');
    expect(html).toContain('<p class="rows-title" id="changes">');
    expect(html).not.toContain('class="spine"');
    expect(html).not.toContain('class="contents"');
    expect(html).toContain('<p class="account-title"><svg class="account-icon"');
    // The reader's questions lead; whose account each is stays as the suffix.
    expect(html).toContain("<span>The problem</span>");
    expect(html).toContain('<span class="account-prov">· as the authors state it</span>');
    expect(html).toContain("<span>The solution</span>");
    expect(html).toContain('<span class="account-prov">· as the witness verified it</span>');
    expect(html).toContain('<p class="rows-title" id="changes">What changes</p>');
    expect(html).toContain(doc().authorIntent!);
    expect(html).not.toContain("verified against the code");
    expect(html).not.toContain('class="provenance"');
    expect(html).not.toContain('class="source-tag"');
  });

  test("what a section holds is drawn, not captioned", () => {
    const html = page(doc());
    // Review focus keys its icon vocabulary beside the counts.
    expect(html).toContain('<p class="focus-key">');
    expect(html).toContain("1 risk</span>");
    // The walkthrough heading carries the whole diff's tally, and every group
    // wears its share of the changed lines as a bar beside its count.
    expect(html).toContain('<span class="walk-head">');
    expect(html).toContain('<span class="gbar" aria-hidden="true">');
    // No sentence stands under any heading to explain the page to the reader.
    expect(html).not.toContain("secnote");
  });

  test("two or more coverage paths draw the convergence figure, one draws none", () => {
    const two = doc();
    two.codeDesign = {
      ...two.codeDesign!,
      coverage: [
        { id: "cov_a", title: "Browser reads", body: "b", refs: [] },
        { id: "cov_b", title: "API reads", body: "b", refs: [] },
      ],
    };
    const drawn = page(two);
    const design = drawn.slice(
      drawn.indexOf('<section id="design"'),
      drawn.indexOf('<div class="coverage-list">'),
    );
    expect(design).toContain('<svg class="fig"');
    expect(design).toContain(">this change</text>");
    expect(design).toContain(">Browser reads</text>");
    // One path is not a sprawl check, and gets no drawing. The golden fixture
    // carries exactly one coverage path, which is what makes it the case.
    expect(doc().codeDesign!.coverage.length).toBe(1);
    const one = page(doc());
    const oneDesign = one.slice(
      one.indexOf('<section id="design"'),
      one.indexOf('<div class="coverage-list">'),
    );
    expect(oneDesign).not.toContain('<svg class="fig"');
  });

  test("code design renders responsibility areas, paths, coverage, and refs", () => {
    const html = page(doc());
    expect(html).toContain('class="dmodule" id="mod_gate"');
    expect(html).toContain("The workspace session boundary");
    expect(html).toContain('<span class="dpath">src/auth.ts</span>');
    const moduleSummary = html.slice(
      html.indexOf('<details class="dmodule" id="mod_gate"'),
      html.indexOf("</summary>", html.indexOf('<details class="dmodule" id="mod_gate"')),
    );
    expect(moduleSummary).not.toContain("src/auth.ts");
    expect(moduleSummary).not.toContain('class="ref"');
    expect(html).toContain('class="design-refs"');
    expect(html).toContain('class="coverage-row" id="cov_review_routes"');
    expect(html).toContain('<h3 class="design-heading">');
    expect(html).toContain("<span>Coverage</span>");
    expect(html).toContain('href="#mod_gate-ref_mod_gate"');
  });

  test("a document published before the new overview fields still renders", () => {
    const legacy = doc();
    delete legacy.codeDesign;
    delete legacy.authorIntent;
    const html = page(legacy);
    expect(html).not.toContain('<section id="design"');
    expect(html).not.toContain('<a href="#design">');
    expect(html).not.toContain("<span>The problem</span>");
    expect(html).toContain("Reviews carry private source");
  });

  test("decisions precede risks and notes whatever order they were published in", () => {
    const html = page(
      doc({
        notes: [
          note({ id: "no_one", kind: "note", text: "An observation" }),
          note({ id: "no_two", kind: "risk", text: "A risk" }),
          note({ id: "no_five", kind: "decision", text: "A decision" }),
          note({ id: "no_three", kind: "note", text: "Another observation" }),
          note({ id: "no_four", kind: "risk", text: "A second risk" }),
        ],
      }),
    );
    const order = [...html.matchAll(/<details class="note is-(decision|risk|note)" id="(no_[a-z]+)"/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(order).toEqual([
      ["decision", "no_five"],
      ["risk", "no_two"],
      ["risk", "no_four"],
      ["note", "no_one"],
      ["note", "no_three"],
    ]);
  });

  test("every statement renders every ref it carries", () => {
    const statements = [
      statement({ id: "st_a", refs: [ref("ref_1", "src/auth.ts"), ref("ref_2", "src/db.ts", 80)] }),
      // The same resolved ref cited twice: one panel each, no duplicated id.
      statement({ id: "st_b", refs: [ref("ref_1", "src/auth.ts")] }),
    ];
    const html = page(doc({ statements }));
    for (const s of statements) {
      for (const r of s.refs) {
        expect(html).toContain(`<a class="ref" href="#${s.id}-${r.id}"`);
        expect(html).toContain(`<details class="fold" id="${s.id}-${r.id}"`);
      }
    }
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    // The panel names the file, the commit and the range it was quoted at.
    expect(html).toContain("<b>src/db.ts</b>");
    expect(html).toContain("L80-82");
    expect(html).toContain("4444444");
  });

  test("an example carries no line numbers and no path", () => {
    const evidence: Evidence[] = [
      {
        type: "example",
        example: {
          lang: "json",
          // A path-looking string inside the example itself: it stays text, it does
          // not become a citation, and it grows no gutter beside it.
          text: '{\n  "from": "src/auth.ts:42",\n  "slug": "atlas-hum"\n}',
          caption: "The shape a caller reads back",
        },
      },
    ];
    const html = page(doc({ statements: [statement({ evidence })] }));
    const block = html.match(/<figure class="ev ev-example"[\s\S]*?<\/figure>/)![0];
    expect(block).toContain("The shape a caller reads back");
    // No gutter, and nothing that could be read as a citation.
    expect(block).not.toContain('class="n"');
    expect(block).not.toMatch(/L\d+-\d+/);
    expect(block).not.toContain("github.com");
    expect(block).not.toContain("<a ");
    expect(block).toContain("src/auth.ts:42");
  });

  test("a ref panel links out to GitHub at the sha it was pinned at", () => {
    const html = page(doc({ statements: [statement({ refs: [ref("ref_a", "src/auth.ts")] })] }));
    expect(html).toContain(
      `https://github.com/${GOLDEN_REPO}/blob/${"4".repeat(40)}/src/auth.ts#L40-L42`,
    );
    expect(html).toContain("in this stack");
  });

  describe("a ref into changed code is drawn as the change", () => {
    const fold = (html: string, id: string): string => {
      const start = html.indexOf(`<details class="fold" id="${id}"`);
      expect(start).toBeGreaterThan(-1);
      return html.slice(start, html.indexOf("</details>", start));
    };

    test("the quoted range renders the diff that produced it", () => {
      // The golden statement's ref quotes src/auth.ts at the head sha whose hunk
      // rewrote line 41, so the citation is the change, not the file after it.
      const html = page(doc());
      const block = fold(html, "st_gate-ref_st_gate");
      // The deleted line is laid back in with its old-file number and glyph.
      expect(block).toContain(
        '<span class="l del"><span class="n">41</span><span class="g">-</span>',
      );
      // The deleted text itself, syntax-classed like every other line of code.
      expect(block).toContain('<span class="kw">true</span>;');
      // The added line keeps its wash and its word marks.
      expect(block).toContain(
        '<span class="l add"><span class="n">41</span><span class="g">+</span>',
      );
      expect(block).toContain('class="w"');
      // Lines the change did not write still come from the snippet, numbered on,
      // and the line the ref singles out keeps its mark.
      expect(block).toContain('<span class="l hl"><span class="n">42</span>');
      expect(block).toContain('<span class="n">48</span>');
      // The way out leads to the pull request that wrote these lines, with the
      // sha-pinned quote still one tap away.
      expect(block).toContain(`https://github.com/${GOLDEN_REPO}/pull/12/files#diff-`);
      expect(block).toContain(`${GOLDEN_REPO}#12</a>`);
      expect(block).toContain(">at 2222222</a>");
    });

    test("a ref at a commit the hunks do not count against keeps the snippet", () => {
      // ref() pins at 44…4, a sha no hunk counts against: its numbering names a
      // different tree, so no diff may be laid over it.
      const html = page(doc({ statements: [statement()] }));
      const block = fold(html, "st_x-ref_a");
      expect(block).not.toContain('class="l del"');
      expect(block).not.toContain("/pull/");
      expect(block).toContain(`blob/${"4".repeat(40)}/src/auth.ts#L40-L42`);
    });
  });

  test("payload, attachment and bundle evidence render as themselves", () => {
    const evidence: Evidence[] = [
      {
        type: "payload",
        payload: { lang: "json", before: '{ "url": 1 }', after: '{ "shareUrl": 2 }', highlight: ["shareUrl"] },
      },
      {
        type: "attachment",
        attachment: {
          id: "att_abc123",
          mediaType: "image/png",
          bytes: 12,
          alt: "The inventory with a share link per bundle",
          caption: "After the flip",
        },
      },
      {
        type: "bundle",
        bundle: { slug: "contact-sheet", version: 3, caption: "The sheet this was drawn from" },
      },
    ];
    const html = page(doc({ statements: [statement({ evidence })] }));
    // A payload is one diff, not two columns to compare by eye: the old line is
    // marked deleted, the new one added, and the word that moved carries the mark.
    expect(html).not.toContain("ba-label");
    expect(html).toContain('<span class="l del">');
    expect(html).toContain('<span class="l add">');
    expect(html).toContain('<span class="w">');
    expect(html).toContain("&quot;shareUrl&quot;");
    // No line numbers: a value counts into nothing, so the gutter is the glyph alone.
    expect(html).toContain('<span class="n"></span><span class="g">+</span>');
    expect(html).toContain('src="/ws_test/r/golden/a/att_abc123"');
    expect(html).toContain('alt="The inventory with a share link per bundle"');
    expect(html).toContain('href="/ws_test/b/contact-sheet/v/3/"');
  });


  test("each pull request card counts the lines its own hunks carry", () => {
    const d = doc();
    const html = page(d);
    for (const pr of d.prs) {
      const mine = d.hunks.filter((h) => h.prNumber === pr.number && h.repo === pr.repo);
      let added = 0;
      let removed = 0;
      for (const h of mine) {
        for (const l of h.lines) {
          if (l.kind === "add") added++;
          if (l.kind === "del") removed++;
        }
      }
      // The card counts the document's own hunks, so it cannot drift from the
      // walkthrough: both add up the same lines.
      // Each half carries its own change hue, the same meaning the gutter glyphs
      // carry in the walkthrough.
      expect(html).toContain(`<span class="s-add">+${added}</span>`);
      expect(html).toContain(`<span class="s-del">\u2212${removed}</span>`);
      expect(html).toContain(`aria-label="${added} added, ${removed} removed"`);
    }
  });

  test("a pull request with no hunks shows no count rather than a confident zero", () => {
    const d = doc();
    const html = page({ ...d, hunks: [] });
    // Scoped to the chain: a pull request can legitimately carry no hunks, while a
    // walkthrough group cannot (the partition rule sees to that), so only the card
    // has a silence to keep.
    const chain = html.slice(html.indexOf('<div class="chain">'), html.indexOf("</section>"));
    expect(chain).not.toContain('class="c-stat"');
    expect(chain).not.toContain(`<span class="s-add">+0</span>`);
  });


  test("the chain still precedes the summary in the markup", () => {
    // The two sit side by side on a wide screen by CSS order, never by markup
    // order: a phone and a reader with no styles both meet the pull request
    // links before the prose.
    const html = page(doc());
    const chainAt = html.indexOf('<div class="chain">');
    const summaryAt = html.indexOf('<section id="summary">');
    expect(chainAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(chainAt);
    // Both are inside the one row the layout flexes.
    const ledeAt = html.indexOf('<div class="lede">');
    expect(ledeAt).toBeGreaterThan(-1);
    expect(ledeAt).toBeLessThan(chainAt);
    expect(html).toContain("</section></div>");
  });


  test("a file cited at several lines says the file once", () => {
    const refs = [
      ref("ref_a", "src/responsive-dialog.tsx", 97),
      ref("ref_b", "src/responsive-dialog.tsx", 151),
      ref("ref_c", "src/other.ts", 12),
    ];
    const html = page(doc({ statements: [statement({ id: "st_m", refs })] }));
    const head = html.slice(html.indexOf('id="st_m"'), html.indexOf("</summary>", html.indexOf('id="st_m"')));
    // The repeated file name appears once in the row head, and each line keeps
    // its own link into its own panel.
    expect((head.match(/responsive-dialog\.tsx/g) ?? []).length).toBe(1);
    expect(head).toContain('href="#st_m-ref_a"');
    expect(head).toContain('href="#st_m-ref_b"');
    expect(head).toContain('<span class="reftext">97</span></a>');
    expect(head).toContain('<span class="reftext">151</span></a>');
    expect(head).toContain('<span class="refset"><span class="reffile">responsive-dialog.tsx</span>');
    expect(head).not.toContain('class="ref refset"');
    const refRule = html.match(/\.ref \{([^}]*)\}/)?.[1] ?? "";
    expect(refRule).not.toContain("border");
    expect(refRule).not.toContain("background");
    expect(html).toContain(".reftext { text-decoration: underline");
    // A file cited once is still an ordinary link carrying file and line.
    expect(head).toContain("other.ts:12");
    for (const r of refs) expect(html).toContain(`<details class="fold" id="st_m-${r.id}"`);
  });


  test("quoted code carries syntax classes, like the diff of the same file does", () => {
    // A citation and a hunk of the same file used to look like different languages:
    // hunks were classed and snippets were plain escaped text, so everything on the
    // page read with equal weight and nothing was ranked.
    const r = ref("ref_ts", "src/auth.ts");
    r.snippet = "const gate = true;\nreturn deny();\n";
    const html = page(doc({ statements: [statement({ id: "st_c", refs: [r] })] }));
    const fold = html.slice(html.indexOf('id="st_c-ref_ts"'));
    expect(fold).toContain('<span class="kw">const</span>');
    expect(fold).toContain('<span class="kw">return</span>');
  });

  test("an example is classed by the language it declares, and unknown stays mono", () => {
    const known: Evidence[] = [
      { type: "example", example: { lang: "ts", text: "const x = 1;", caption: "A call" } },
    ];
    const shown = page(doc({ statements: [statement({ id: "st_k", evidence: known })] }));
    expect(shown).toContain('<span class="kw">const</span>');

    const odd: Evidence[] = [
      { type: "example", example: { lang: "cobol", text: "const x = 1;", caption: "A call" } },
    ];
    const plain = page(doc({ statements: [statement({ id: "st_u", evidence: odd })] }));
    const block = plain.slice(plain.indexOf("ev-example"));
    // No tokenizer for it, so no classes invented: mono is the honest answer.
    expect(block.slice(0, 300)).not.toContain('class="kw"');
  });

  test("authored text arrives escaped", () => {
    const html = page(
      doc({
        statements: [statement({ text: '<img src=x onerror=1>' })],
        notes: [note({ text: '<script>alert(1)</script>', checks: ['<b>check</b>'] })],
        title: '<svg onload=1>',
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;svg onload=1&gt;");
    // The escaped characters are text, so no tag on the page grew a handler.
    expect(html).not.toMatch(/<[a-z]+[^>]*\son[a-z]+\s*=/i);
    // Only the four scripts the renderer writes itself: the theme floor, the page
    // enhancement, the full-screen code panel, and the freshness channel an
    // unpinned page subscribes to.
    expect(html.match(/<script/g)!.length).toBe(4);
    // A pinned version is a record, so it has no channel and one script fewer.
    const pinned = page(doc(), { pinned: true });
    expect(pinned.match(/<script/g)!.length).toBe(3);
  });

  test("the chain draws arrows for a stack and none for a set", () => {
    const stack = page(doc({ kind: "stack" }));
    const set = page(doc({ kind: "set" }));
    expect(stack).toContain('class="arw"');
    expect(set).not.toContain('class="arw"');
    expect(stack).toContain(`https://github.com/${GOLDEN_REPO}/pull/12`);
    expect(stack).toContain(`https://github.com/${GOLDEN_REPO}/pull/13`);
  });

  test("the chain is drawn from the parent links, not from the array order", () => {
    const base = doc();
    const [bottom, top] = base.prs;
    expect(bottom!.number).toBe(12);
    expect(top!.parent).toBe(12);
    // The same document with the pointers listed newest first, as a publish may.
    const html = page({ ...base, prs: [top!, bottom!] });
    const order = [...html.matchAll(/<details class="card" id="pr-(\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["12", "13"]);
    // The base line names the root's base branch, not another pr's head.
    expect(html).toContain(`<span>${bottom!.baseRef}</span>`);
    expect(html).not.toContain(`<span>${top!.baseRef}</span>`);
  });

  test("a set gets no shared base line", () => {
    const html = page(doc({ kind: "set" }));
    expect(html).not.toContain('<p class="base">');
    expect(page(doc({ kind: "stack" }))).toContain('<p class="base">');
  });

  test("a pull request description is folded and never parsed as markup", () => {
    const base = doc();
    const prs = base.prs.map((pr) => ({
      ...pr,
      body: "## A heading\n\n- a bullet with <b>markup</b>",
    }));
    const html = page({ ...base, prs });
    expect(html).toContain(`<details class="fold" id="pr-12-body"`);
    expect(html).toContain("## A heading");
    expect(html).toContain("&lt;b&gt;markup&lt;/b&gt;");
    expect(html).not.toContain("<b>markup</b>");
    // An empty description grows no fold at all.
    expect(page({ ...base, prs: base.prs.map((pr) => ({ ...pr, body: "  " })) })).not.toContain(
      `id="pr-12-body"`,
    );
  });

  test("a card detail is rendered as the constrained markdown it was validated as", () => {
    const base = doc();
    const prs = base.prs.map((pr) => ({
      ...pr,
      detail: "Adds the table. See [the plan](https://example.com/p) and the *rest*.",
    }));
    const html = page({ ...base, prs });
    expect(html).toContain(`<a href="https://example.com/p"`);
    expect(html).toContain("<em>rest</em>");
    expect(html).not.toContain("[the plan]");
  });

  test("a card points at the claims that realize it, never at a code panel", () => {
    const base = doc();
    const mine = statement({
      id: "st_mine",
      text: "The gate moves to the session helper",
      prs: [`${GOLDEN_REPO}#12`],
    });
    const other = statement({
      id: "st_other",
      text: "A claim another pull request realizes",
      prs: [`${GOLDEN_REPO}#13`],
    });
    const html = page(doc({ statements: [mine, other] }));
    const cardBlock = html.slice(
      html.indexOf('<details class="card" id="pr-12"'),
      html.indexOf('<details class="card" id="pr-13"'),
    );
    // Each realizing statement, behind its kind mark, as a jump to the claim.
    expect(cardBlock).toContain('<div class="c-claims">');
    expect(cardBlock).toContain('<a href="#st_mine">');
    expect(cardBlock).toContain("The gate moves to the session helper");
    // Only its own: a card cannot advertise a claim the overview ties elsewhere.
    expect(cardBlock).not.toContain('href="#st_other"');
    // The detail ref stays in the document as the pointer behind the detail; the
    // card no longer wears it as a code panel.
    expect(html).not.toContain(`id="pr-12-${base.prs[0]!.detailRef}"`);
  });

  test("a row citing one pointer twice draws it once", () => {
    const r = ref("ref_1", "src/auth.ts");
    const html = page(doc({ statements: [statement({ id: "st_a", refs: [r, r] })] }));
    expect(html.split(`<a class="ref" href="#st_a-ref_1"`).length - 1).toBe(1);
    expect(html.split(`<details class="fold" id="st_a-ref_1"`).length - 1).toBe(1);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("one-line fields keep the one markup the data model allows", () => {
    const base = doc();
    const html = page({
      ...base,
      title: "The `session()` gate",
      statements: [statement({ text: "The `session()` helper moves" })],
      notes: [note({ text: "A key minted before `session()` still reads" })],
    });
    expect(html).toContain(`<h1 class="title">The <code>session()</code> gate</h1>`);
    expect(html).toContain(`<span class="rwhat">The <code>session()</code> helper moves</span>`);
    expect(html).toContain(
      `<span class="none">A key minted before <code>session()</code> still reads</span>`,
    );
    // The document title is a plain string in a plain-text element, so it keeps its
    // characters there and grows markup only where markup renders.
    expect(html).toContain("<title>The `session()` gate · Overseer</title>");
  });

  // Step 9 could only list a figure's nodes and edges; step 10 draws them. The claim
  // is the same one, made against the drawing: every node reaches the page, the muted
  // one is drawn muted, and the words on an edge are on the page beside it.
  test("a figure draws its nodes and edges rather than vanishing", () => {
    const html = page(
      doc({
        statements: [
          statement({
            evidence: [
              {
                type: "figure",
                figure: {
                  kind: "flow",
                  nodes: [
                    { id: "a", label: "request", state: "normal" },
                    { id: "b", label: "gate", state: "muted" },
                  ],
                  edges: [{ from: "a", to: "b", label: "cookie" }],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain('class="ev ev-figure"');
    const svg = html.match(/<svg class="fig"[\s\S]*?<\/svg>/)![0];
    expect(svg).toContain(">request</text>");
    expect(svg).toContain('class="dim"');
    expect(svg).toContain(">gate</text>");
    expect(svg).toContain("fig-dim");
    expect(svg).toContain('class="cap"');
    expect(svg).toContain(">cookie</text>");
    expect(svg).toContain('role="img"');
    expect(svg).toContain(
      'aria-label="A flow figure: request, gate (muted). request to gate, cookie."',
    );
  });

  test("the meta row says how fresh the heads are", () => {
    const d = doc();
    const current = page(d, { freshness: {} });
    expect(current).toContain("up to date");
    const behind = page(d, {
      freshness: { [`${GOLDEN_REPO}#12`]: "behind", [`${GOLDEN_REPO}#13`]: "current" },
    });
    expect(behind).toContain("1 of 2 behind");
  });

  test("a version page carries its version marking", () => {
    const pinned = page(doc(), { version: 1, latestVersion: 2, pinned: true });
    expect(pinned).toContain("version 1 of 2");
    const latest = page(doc(), { version: 2, latestVersion: 2, pinned: false });
    expect(latest).toContain("version 2");
    expect(latest).not.toContain("version 2 of 2");
  });

  test("the token block is the prototype's", async () => {
    const html = page(doc());
    // Spot-checked against the transcribed block: the accent at both ends of the
    // scale, the diff washes and the syntax tokens.
    for (const token of [
      "--accent: 8 24% 5%;",
      "--accent: 28 35% 95%;",
      "--wash-add: hsl(var(--add) / 0.13);",
      "--wash-rem: hsl(var(--remove) / 0.11);",
      "--rail-add: hsl(var(--add) / 0.8);",
      // The syntax hues were raised off the prototype's values after measuring a
      // real page: at the old chroma ceiling a keyword cleared body text by dE 23
      // with a 5.7 lightness gap, which reads as no colour at all. Hue distance
      // from the semantic marks is what keeps them apart, and it is unchanged.
      // Raised a second time after measuring against the sunk panel a diff is
      // actually drawn on, where the comment stood at 3.4:1, under the floor for
      // text of any size. Both hues still sit under the loudest semantic mark in
      // chroma; what changed is that the band is now spent rather than saved.
      "--syn-cm: 12 22% 40%;",
      "--syn-kw: 280 56% 33%;",
      "--syn-st: 214 93% 30%;",
      "--syn-cm: 14 16% 62%;",
      "--syn-kw: 286 72% 79%;",
      "--syn-st: 204 95% 72%;",
    ]) {
      expect(html).toContain(token);
    }
    // The no-script floor: system dark still lands on the dark surface.
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(':root:not([data-theme="light"])');
    // The sprite is inline, so no mark is a network request.
    expect(html).toContain('<symbol id="i-risk"');
    expect(html).toContain('href="/fonts/switzer.woff2"');
  });

  test("code on a phone scrolls sideways rather than wrapping", () => {
    const html = page(doc());
    // A line of code is the line the author wrote at every width: nothing anywhere
    // re-flows it, which is what the phone block used to do below 700px.
    expect(html).not.toContain("pre-wrap; overflow-wrap: anywhere");
    expect(html).toContain(".snip .l {\n    display: block;\n    white-space: pre;");
    // The gesture is contained, so swiping to the end of a line cannot be handed to
    // the browser's back navigation instead.
    expect(html).toContain("overscroll-behavior-x: contain");
    // And the gutter rides along at every width, so the numbers and the +/- never
    // scroll off the left edge of a diff.
    expect(html).toContain(".filediff .snip .gut {\n    position: sticky; left: 0;");
  });

  test("a long file name wraps rather than dragging the page sideways", () => {
    const long =
      "packages/server/migrations/20260808073545_bot_invocation_source_revisions.sql";
    const html = page(
      doc({ statements: [statement({ id: "st_w", refs: [ref("ref_w", long)] })] }),
    );
    // A migration filename is wider than a phone. The ref label may break anywhere,
    // because the alternative was the whole page scrolling sideways to reach it.
    const refRule = html.match(/\.ref \{([^}]*)\}/)?.[1] ?? "";
    expect(refRule).not.toContain("nowrap");
    expect(html).toContain(".reftext { text-decoration: underline");
    expect(html).toContain("min-width: 0; overflow-wrap: anywhere; }");
    // The fold head carries the full path, which wraps the same way with the
    // separator glued to its tail rather than being guillotined by the fold's edge.
    expect(html).toContain(`<span class="fhpath"><b>${long}</b>&nbsp;·</span>`);
    expect(html).toContain(".fold > summary .fh .fhpath { overflow-wrap: anywhere; }");
    // And the two page-level guards: prose breaks a long word instead of widening
    // the column, and the horizontal axis is clipped outright, not scroll-hidden,
    // because a phone will pan a hidden viewport to whatever pokes past the edge.
    expect(html).toContain("overflow-wrap: break-word");
    expect(html).toContain("-webkit-text-size-adjust: 100%; overflow-x: clip;");
    expect(html).toContain("overflow-x: clip;\n    /* every string");
  });

  test("no em dash reaches the page", async () => {
    const html = page(doc());
    expect(html).not.toContain("—");
    // And none was written into the renderer's own copy.
    for (const path of [RENDER_SOURCE, EVIDENCE_SOURCE]) {
      const source = await Bun.file(path).text();
      const authored = source
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"));
      expect(authored.join("\n")).not.toContain("—");
    }
  });
});

// ---- the routes ----

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let wsA = "";
let wsB = "";

async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join("\n");
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsA = createWorkspace("Render A", owner);

  const stranger = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
    stranger,
    "render-stranger@example.com",
    Date.now(),
  ]);
  wsB = createWorkspace("Render B", stranger);

  storeGoldenReview(wsA, "shown");
  storeGoldenReview(wsA, "shown");
  storeGoldenReview(wsB, "hidden");
});

afterAll(() => {
  server.stop(true);
});

describe("GET /r/:slug", () => {
  test("a member reads the page", async () => {
    const res = await fetch(`${base}/r/shown`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<title>");
    expect(html).toContain("version 2");
    expect(html).toContain('<div class="chain">');
  });

  test("the workspace-scoped url publish hands back serves the same page", async () => {
    const res = await fetch(`${base}/${wsA}/r/shown`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div class="chain">');
  });

  test("a member's page carries the way back to the workspace's reviews", async () => {
    const res = await fetch(`${base}/${wsA}/r/shown`);
    expect(await res.text()).toContain(
      `<a class="head-index" href="/${wsA}/reviews">All reviews</a>`,
    );
  });

  test("a pinned version marks itself", async () => {
    const res = await fetch(`${base}/r/shown/v/1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("version 1 of 2");
  });

  test("a review in someone else's workspace is the same answer as one that never existed", async () => {
    const foreign = await shape(await fetch(`${base}/r/hidden`));
    const missing = await shape(await fetch(`${base}/r/nowhere`));
    const malformed = await shape(await fetch(`${base}/r/NOT_A_SLUG`));
    const outOfRange = await shape(await fetch(`${base}/r/shown/v/9`));
    const scopedForeign = await shape(await fetch(`${base}/${wsB}/r/hidden`));
    expect(foreign).toBe(missing);
    expect(malformed).toBe(missing);
    expect(outOfRange).toBe(missing);
    expect(scopedForeign).toBe(missing);
    expect(missing.startsWith("404\ntext/html;charset=utf-8")).toBe(true);
  });
});

describe("GET /r/:slug/a/:id", () => {
  test("an attachment is served to a member and withheld from everyone else", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const mine = createAttachment(wsA, "shown", 1, "image/png", bytes.length, "A shot", "");
    await saveAttachment(wsA, mine, bytes);
    const theirs = createAttachment(wsB, "hidden", 1, "image/png", bytes.length, "A shot", "");
    await saveAttachment(wsB, theirs, bytes);

    const ok = await fetch(`${base}/r/shown/a/${mine}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);

    const missing = await shape(await fetch(`${base}/r/shown/a/att_nothinghere`));
    // Another workspace's attachment, and this workspace's slug quoting it.
    expect(await shape(await fetch(`${base}/r/hidden/a/${theirs}`))).toBe(missing);
    expect(await shape(await fetch(`${base}/r/shown/a/${theirs}`))).toBe(missing);
    expect(await shape(await fetch(`${base}/r/shown/a/not-an-id`))).toBe(missing);
  });
});
