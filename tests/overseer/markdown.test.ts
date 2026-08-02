import { test, expect, describe } from "bun:test";
import {
  render,
  renderInline,
  validate,
  validateInline,
  MarkdownRejection,
} from "../../src/overseer/markdown";

function rejection(source: string) {
  const result = validate(source);
  if (result.ok) throw new Error(`expected a rejection for ${JSON.stringify(source)}`);
  return result;
}

describe("allowed constructs", () => {
  const allowed: [name: string, source: string, html: string][] = [
    ["paragraph", "plain words", "<p>plain words</p>"],
    ["emphasis", "an *emphasized* word", "<p>an <em>emphasized</em> word</p>"],
    ["strong", "a **strong** word", "<p>a <strong>strong</strong> word</p>"],
    ["strong holding emphasis", "**a *b* c**", "<p><strong>a <em>b</em> c</strong></p>"],
    ["inline code", "call `render(text)` here", "<p>call <code>render(text)</code> here</p>"],
    [
      "absolute link",
      "see [the docs](https://example.com/a)",
      '<p>see <a href="https://example.com/a">the docs</a></p>',
    ],
    ["same-origin link", "[here](/reviews/abc)", '<p><a href="/reviews/abc">here</a></p>'],
    ["fragment link", "[here](#notes)", '<p><a href="#notes">here</a></p>'],
    ["relative link", "[here](reviews/abc)", '<p><a href="reviews/abc">here</a></p>'],
    ["unordered list", "- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
    ["ordered list", "1. one\n2. two", "<ol><li>one</li><li>two</li></ol>"],
    ["list with markup", "- a *b* `c`", "<ul><li>a <em>b</em> <code>c</code></li></ul>"],
    ["fenced code", "```\nlet x = 1;\n```", "<pre><code>let x = 1;\n</code></pre>"],
    [
      "fenced code with a language",
      "```ts\nlet x = 1;\n```",
      '<pre><code class="language-ts">let x = 1;\n</code></pre>',
    ],
    [
      "two paragraphs",
      "first line\n\nsecond line",
      "<p>first line</p>\n<p>second line</p>",
    ],
  ];

  for (const [name, source, html] of allowed) {
    test(`${name} renders`, () => {
      expect(validate(source)).toEqual({ ok: true });
      expect(render(source)).toBe(html);
    });
  }
});

describe("forbidden constructs are named, never stripped", () => {
  const forbidden: [source: string, construct: string, text: string][] = [
    ["# h", "heading", "#"],
    ["text\n# h", "heading", "#"],
    ["|a|b|", "table", "|a|b|"],
    ["a | b\n--- | ---", "table", "a | b"],
    ["a|b\n-|-", "table", "a|b"],
    ["a|b\n:-|-:", "table", "a|b"],
    ["<div>", "raw HTML tag", "<div>"],
    ["<script>alert(1)</script>", "raw HTML tag", "<script>"],
    ["![img](x)", "inline image", "![img](x)"],
    ["> quote", "blockquote", ">"],
    ["title\n=====", "heading", "====="],
    ["---", "thematic break", "---"],
    ["<!-- hi -->", "raw HTML comment", "<!--"],
    ["a ~~b~~ c", "strikethrough", "~~"],
    ["a [^1] b", "footnote reference", "[^"],
    ["[ref]: https://example.com", "link reference definition", "[ref]:"],
    ["    indented", "indented code block", "indented"],
    ["```\nunclosed", "unclosed fenced code", "```"],
    ["```js foo\nlet a = 1;\n```", "fenced code info string", "js foo"],
    ["```js a\ncode\n```\n\n# heading\n\n```js b\ncode2\n```", "fenced code info string", "js a"],
    ["```ts title=a\ncode *here*\n```\n\ntext\n\n```ts title=b\nmore code\n```", "fenced code info string", "ts title=a"],
    ["[go](javascript:alert(1))", "javascript: link url", "javascript:alert(1)"],
    ["[go](data:text/html,x)", "data: link url", "data:text/html,x"],
    ["[go](//evil.example.com)", "protocol-relative link url", "//evil.example.com"],
  ];

  for (const [source, construct, text] of forbidden) {
    test(`${JSON.stringify(source)} is refused as ${construct}`, () => {
      const result = rejection(source);
      expect(result.construct).toBe(construct);
      expect(result.message).toContain(construct);
      expect(result.text).toBe(text);
      expect(result.message).toContain(text);
      expect(() => render(source)).toThrow(MarkdownRejection);
    });
  }

  test("a rejection carries a one-based position", () => {
    const result = rejection("intro line\n\n# heading");
    expect(result.position).toEqual({ line: 3, column: 1, offset: 12 });
  });

  test("the rejected source never reaches output", () => {
    for (const [source] of forbidden) {
      let html = "";
      try {
        html = render(source);
      } catch (err) {
        expect(err).toBeInstanceOf(MarkdownRejection);
        continue;
      }
      throw new Error(`rendered forbidden source: ${html}`);
    }
  });
});

describe("adversarial input", () => {
  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/g;
  const WHITELIST = new Set(["p", "em", "strong", "code", "a", "ul", "ol", "li", "pre"]);

  function emittedTags(html: string): string[] {
    return [...html.matchAll(TAG)].map((m) => m[1]!.toLowerCase());
  }

  test("an html tag inside emphasis is refused, not escaped into the page", () => {
    const result = rejection('*<img src=x onerror="alert(1)">*');
    expect(result.construct).toBe("raw HTML tag");
    expect(result.text).toBe("<img>");
  });

  test("a code span may hold angle brackets, and they leave escaped", () => {
    const html = render("`<script>alert(1)</script>`");
    expect(html).toBe("<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>");
    expect(emittedTags(html).every((t) => WHITELIST.has(t))).toBe(true);
  });

  test("a fenced block may hold anything and leaves escaped", () => {
    const html = render("```\n<script>alert(1)</script>\n```");
    expect(html).toBe("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>");
  });

  test("every emitted tag is on the whitelist", () => {
    const sources = [
      "a **b** *c* `d` [e](https://x.test/f)",
      "- one\n- two",
      "1. one\n2. two",
      "```js\nlet a = `<b>`;\n```",
      "quotes \" and & and < and >",
      "[a `b` c](/d?e=1&f=2)",
    ];
    for (const source of sources) {
      const html = render(source);
      for (const tag of emittedTags(html)) expect(WHITELIST.has(tag)).toBe(true);
    }
  });

  test("an href is escaped, not just filtered", () => {
    expect(render("[a](/d?e=1&f=2)")).toBe('<p><a href="/d?e=1&amp;f=2">a</a></p>');
    expect(render("[a](https://x.test/?q=1&r=2)")).toBe(
      '<p><a href="https://x.test/?q=1&amp;r=2">a</a></p>',
    );
  });

  test("a leading tab does not hide markup from the one-line guards", () => {
    expect(validateInline("\t# h")).toMatchObject({ ok: false, construct: "heading" });
    expect(validateInline("\t> quote")).toMatchObject({ ok: false, construct: "blockquote" });
    expect(validateInline("\t- item")).toMatchObject({ ok: false, construct: "list" });
    expect(renderInline("\tplain words")).toBe("plain words");
  });

  test("pathological nesting is a rejection, not a crash", () => {
    const deep = `${"*".repeat(50000)}x${"*".repeat(50000)}`;
    expect(validate(deep)).toMatchObject({ ok: false, construct: "nesting too deep" });
    expect(validateInline(deep).ok).toBe(false);

    // The depth limit is a stated number, not whatever the engine's stack allows, so the
    // same input has to reject on every runtime and cheaply enough to stay under a test
    // timeout. Nesting one level under the cap still renders.
    const under = `${"*".repeat(64)}x${"*".repeat(64)}`;
    expect(validate(under)).toEqual({ ok: true });
    const over = `${"*".repeat(400)}x${"*".repeat(400)}`;
    expect(validate(over)).toMatchObject({ ok: false, construct: "nesting too deep" });
  });

  test("near-miss markup either rejects or emits only whitelisted tags", () => {
    const sources = [
      "*<img src=x onerror=alert(1)>*",
      "**<script>alert(1)</script>**",
      "[<b>label</b>](https://x.test/)",
      "- <div a=b>",
      "1. <span>x</span>",
      "- a\n- <img src=x>",
      "a <div\n> b",
      "<div",
      "</p",
      "`<`",
      "``<a href=x>``",
      "a < b > c",
      "*a `<i>` b*",
      "[a *<u>b</u>* c](/d)",
      "***<b>x</b>***",
      "```\n</code></pre><script>alert(1)</script>\n```",
      "- `</li></ul><script>x</script>`",
      "text with <notatag",
      "5 <x and 6 >y",
      "[x](/a\">b)",
    ];
    let rejected = 0;
    for (const source of sources) {
      let html: string;
      try {
        html = render(source);
      } catch (err) {
        expect(err).toBeInstanceOf(MarkdownRejection);
        rejected++;
        continue;
      }
      for (const tag of emittedTags(html)) expect(WHITELIST.has(tag)).toBe(true);
      expect(html).not.toMatch(/<(?!\/?(p|em|strong|code|a|ul|ol|li|pre)[ >])/);
    }
    expect(rejected).toBeGreaterThan(0);
  });

  test("a tag split across a line break is named as a tag", () => {
    expect(rejection("<div\n>").construct).toBe("raw HTML tag");
    expect(rejection("a paragraph <div\n> and more").construct).toBe("raw HTML tag");
  });

  test("a forbidden construct inside a list item is named, not flattened", () => {
    expect(rejection("- a\n- # h").construct).toBe("heading");
    expect(rejection("- a\n- > quote").construct).toBe("blockquote");
    expect(rejection("- a\n- |x|y|").construct).toBe("table");
    expect(rejection("1. # h").construct).toBe("heading");
  });

  test("triple emphasis nests instead of leaking delimiters", () => {
    expect(render("***bold italic***")).toBe("<p><strong><em>bold italic</em></strong></p>");
  });

  test("the reported position points at the offending character", () => {
    const source = "a\n        b\nc <div x=y>";
    const result = validate(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(source[result.position.offset]).toBe("<");
    expect(result.position.line).toBe(3);
    expect(result.position.column).toBe(3);

    const second = validate("first line\n     second line has a <div a=b> tag");
    if (second.ok) throw new Error("expected a rejection");
    expect(second.position.line).toBe(2);
    expect(second.position.column).toBe(24);
  });

  test("plain one-line text carrying brackets or asterisks is not markup", () => {
    for (const text of ["items[0] is empty", "the ratio is 2 * 3", "a 5*3 grid", "TODO[1] follow up"]) {
      expect(validateInline(text).ok).toBe(true);
      expect(renderInline(text)).toBe(text);
      expect(render(text)).toBe(`<p>${text}</p>`);
    }
  });

  test("a link url carrying a quote cannot break out of the attribute", () => {
    const result = rejection('[x](https://a.test/" onmouseover="alert(1))');
    expect(result.construct).toBe("link url");
  });

  test("ampersands and quotes in text are escaped", () => {
    expect(render('a & b " c < d')).toBe("<p>a &amp; b &quot; c &lt; d</p>");
  });

  test("a JAVASCRIPT: url is refused whatever its case", () => {
    expect(rejection("[x](JaVaScRiPt:alert(1))").construct).toBe("javascript: link url");
  });

  test("an unclosed emphasis delimiter is literal text, not a dangling tag", () => {
    expect(render("a * b")).toBe("<p>a * b</p>");
    expect(render("2 ** 3")).toBe("<p>2 ** 3</p>");
  });

  test("an unclosed backtick run is literal text", () => {
    expect(render("a ` b")).toBe("<p>a ` b</p>");
  });

  test("the language class cannot carry markup", () => {
    const result = rejection('```a"b\nx\n```');
    expect(result.construct).toBe("fenced code info string");
    expect(result.text).toBe('a"b');
    expect(() => render('```a"b\nx\n```')).toThrow(MarkdownRejection);
    expect(rejection("```a`b\nx\n```").construct).toBe("fenced code info string");
    expect(rejection("```<div>\nx\n```").construct).toBe("fenced code info string");
  });

  test("prose comparing values is not a raw tag", () => {
    expect(render("the guard went from i<n to i<=n")).toBe(
      "<p>the guard went from i&lt;n to i&lt;=n</p>",
    );
    expect(render("the loop runs while i<n and then exits")).toBe(
      "<p>the loop runs while i&lt;n and then exits</p>",
    );
    expect(render("compare a<b\nand c<d")).toBe("<p>compare a&lt;b\nand c&lt;d</p>");
    expect(validate("compare a<b\nand c<d")).toEqual({ ok: true });
  });

  test("a tag split inside a list is named as a tag", () => {
    expect(rejection("- a <div\n- > q").construct).toBe("raw HTML tag");
  });
});

describe("one-line fields", () => {
  test("plain text passes through escaped", () => {
    expect(validateInline("a plain gist & more")).toEqual({ ok: true });
    expect(renderInline("a plain gist & more")).toBe("a plain gist &amp; more");
  });

  test("inline code is allowed", () => {
    expect(renderInline("calls `derive()`")).toBe("calls <code>derive()</code>");
  });

  test("emphasis is refused", () => {
    const result = validateInline("an *emphasized* gist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.construct).toBe("emphasis");
  });

  test("links, images, headings, lists and html are refused", () => {
    const cases: [string, string][] = [
      ["[a](https://x.test)", "link"],
      ["![a](x)", "inline image"],
      ["# h", "heading"],
      ["- one", "list"],
      ["<b>bold</b>", "raw HTML tag"],
      ["one\ntwo", "line break"],
    ];
    for (const [source, construct] of cases) {
      const result = validateInline(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.construct).toBe(construct);
      expect(() => renderInline(source)).toThrow(MarkdownRejection);
    }
  });
});

describe("stability", () => {
  const source = [
    "Intro *sentence* with `code` and a [link](https://example.com/a).",
    "",
    "- first item",
    "- second **item**",
    "",
    "```ts",
    "const x: number = 1;",
    "```",
  ].join("\n");

  test("render is byte-stable across calls", () => {
    expect(render(source)).toBe(render(source));
  });

  test("carriage returns do not change the output", () => {
    expect(render(source.replace(/\n/g, "\r\n"))).toBe(render(source));
  });

  test("validate and render agree on every corpus entry", () => {
    const corpus = [
      source,
      "# h",
      "|a|b|",
      "a|b\n-|-",
      "<div>x</div>",
      "![img](x)",
      "> quote",
      "```\nunclosed",
      "[a](javascript:alert(1))",
      "plain *emph* and `code`",
      "- one\n- two",
    ];
    for (const entry of corpus) {
      const result = validate(entry);
      if (result.ok) {
        expect(() => render(entry)).not.toThrow();
        continue;
      }
      let thrown: unknown;
      try {
        render(entry);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MarkdownRejection);
      expect((thrown as MarkdownRejection).construct).toBe(result.construct);
    }
  });
});

describe("authored content survives intact", () => {
  test("a url may carry balanced parentheses", () => {
    expect(render("see [Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
      '<p>see <a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo (bar)</a></p>',
    );
    expect(render("[a](/reviews/x(y)/z)")).toBe('<p><a href="/reviews/x(y)/z">a</a></p>');
  });

  test("an unbalanced destination is not a link, and nothing leaks", () => {
    expect(render("[a](http://x/y(z)")).toBe("<p>[a](http://x/y(z)</p>");
  });

  test("an ordered list keeps the number it was written with", () => {
    expect(render("3. a\n4. b")).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
    expect(render("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("a blank line between items does not split the list", () => {
    expect(render("1. a\n\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(render("- a\n\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  test("a list still ends when the next block is not an item", () => {
    expect(render("1. a\n\ntext")).toBe("<ol><li>a</li></ol>\n<p>text</p>");
  });

  test("a list indented as a whole is not a nested list", () => {
    expect(render("  - a\n  - b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(validate("  - a\n  - b")).toEqual({ ok: true });
    expect(render("  1. a\n  2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(rejection("- a\n  - b").construct).toBe("nested list");
  });

  test("a list broken by two blank lines still numbers faithfully", () => {
    expect(render("1. a\n\n\n2. b")).toBe('<ol><li>a</li></ol>\n<ol start="2"><li>b</li></ol>');
  });
});

describe("tabs do not bypass the block guards", () => {
  const tabbed: [source: string, construct: string][] = [
    ["\t# h", "indented code block"],
    ["\t> q", "indented code block"],
    ["\tcode", "indented code block"],
    ["  \t# h", "indented code block"],
  ];

  for (const [source, construct] of tabbed) {
    test(`${JSON.stringify(source)} is refused as ${construct}`, () => {
      expect(rejection(source).construct).toBe(construct);
    });
  }
});

describe("link urls carrying control characters are named", () => {
  for (const control of ["\u0000", "\u0009", "\u001f", "\u007f"]) {
    test(`${JSON.stringify(control)} in a destination is refused`, () => {
      const source = `[x](java${control}script:alert(1))`;
      expect(rejection(source).construct).toBe("link url");
      expect(() => render(source)).toThrow(MarkdownRejection);
    });
  }
});
