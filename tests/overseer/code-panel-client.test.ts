// The full-screen code panel, run in a real DOM.
//
// The panel is the one part of reading code on a phone that cannot be done with markup
// alone, so it is the one part a rendering test cannot reach: the server ships a hidden
// button and a script, and everything that matters happens after both arrive. What is
// asserted here is what a reader would notice if it broke — the control appears only
// once it works, the code inside the panel is the same code that was on the page, the
// page's own ids are not duplicated by the copy, and the back button closes it.
//
// happy-dom is registered globally, so this file gets its own process (bun test runs
// one process per file) and nothing else in the suite sees these globals.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

await GlobalRegistrator.register();

import { test, expect, describe, afterAll, beforeEach } from "bun:test";
import { renderReviewPage } from "../../src/overseer/render";
import type { ReviewDoc } from "../../src/overseer/db";
import { goldenStoredDoc } from "./fixtures/stored-review";
import { GOLDEN_HUNKS } from "./fixtures/golden-review";
import { contextLines } from "../../src/overseer/render-diff";
import { GOLDEN_REF_END, GOLDEN_REF_START } from "./fixtures/stored-review";

// tsconfig omits the DOM lib on purpose: this is a server, and `document` quietly
// typechecking inside src/ would be a mistake worth catching. happy-dom installs the
// real globals at runtime, so what is named here is only the surface this file touches.
interface El {
  innerHTML: string;
  textContent: string | null;
  hidden: boolean;
  open: boolean;
  className: string;
  dataset: Record<string, string | undefined>;
  click(): void;
  close(): void;
  dispatchEvent(event: unknown): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  cloneNode(deep: boolean): El;
  appendChild(child: El): El;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): El[] & { length: number };
}
declare const document: El & { documentElement: El; body: El };
declare const window: {
  dispatchEvent(event: unknown): boolean;
  history: { length: number; state: unknown; back(): void; pushState(a: unknown, b: string): void };
  happyDOM?: { waitUntilComplete(): Promise<void> };
};
declare const PopStateEvent: new (type: string) => unknown;
declare const Event: new (type: string) => unknown;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function doc(over: Partial<ReviewDoc> = {}): ReviewDoc {
  return { ...goldenStoredDoc(), id: "rev_test", slug: "golden", version: 1, ...over };
}

/** Render the review, drop it into the document, and run the page's own scripts, which
 *  is the only honest way to test them: they are shipped as text inside the page. */
function render(over: { context?: boolean } = {}): void {
  const html = renderReviewPage({
    wsId: "ws_test",
    slug: "golden",
    doc: doc(),
    version: 1,
    latestVersion: 1,
    pinned: true,
    freshness: {},
    ...over,
  });
  document.documentElement.innerHTML = html;
  for (const script of [...document.querySelectorAll("script")]) {
    if (!script.textContent?.includes("zoomdlg")) continue;
    new Function(script.textContent)();
  }
}

const controls = (): El[] => [...document.querySelectorAll("button.zoom")];
const panel = (): El | null => document.querySelector("dialog.zoomdlg");

beforeEach(() => {
  render();
});

describe("the full-screen code panel", () => {
  test("the control ships hidden and only the script offers it", () => {
    const served = renderReviewPage({
      wsId: "ws_test",
      slug: "golden",
      doc: doc(),
      version: 1,
      latestVersion: 1,
      pinned: true,
      freshness: {},
    });
    // Every control in the bytes the server writes carries `hidden`: a reader with no
    // scripting is never shown a button whose only job is to run one.
    const tags = served.match(/<button[^>]*class="zoom"[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(" hidden ");
    // And after the script, every one of them is on the page.
    expect(controls().length).toBe(tags.length);
    for (const b of controls()) expect(b.hidden).toBe(false);
  });

  test("every code surface carries one, named by what it holds", () => {
    const named = controls().map((b) => b.dataset.zoom);
    // The walkthrough's file diffs, by path.
    expect(named).toContain(GOLDEN_HUNKS.auth.path);
    // A quoted ref, by the lines it quotes.
    expect(named.some((n) => /:.*L\d+-\d+$|L\d+-\d+$/.test(n ?? ""))).toBe(true);
    // One control per surface, never two on one.
    for (const box of document.querySelectorAll(".filediff, .snipbox")) {
      expect(box.querySelectorAll("button.zoom").length).toBe(1);
    }
  });

  test("opening puts the same code in the panel, under the file's own name", () => {
    const control = controls().find((b) => b.dataset.zoom === GOLDEN_HUNKS.auth.path)!;
    expect(control).toBeDefined();
    control.click();

    const dlg = panel()!;
    expect(dlg).not.toBeNull();
    expect(dlg.open).toBe(true);
    expect(dlg.querySelector(".zoom-title")!.textContent).toBe(GOLDEN_HUNKS.auth.path);
    // The code in the panel is the code that was on the page: same hunk, same lines.
    const lines = dlg.querySelectorAll(".zoom-body .snip .l");
    expect(lines.length).toBeGreaterThan(0);
    const onPage = document
      .querySelector(`.filediff:has(button[data-zoom="${GOLDEN_HUNKS.auth.path}"]) .snip`)!
      .textContent;
    expect(dlg.querySelector(".zoom-body .snip")!.textContent).toBe(onPage);
  });

  test("the copy carries no id the page already answers to", () => {
    controls()[0]!.click();
    const dlg = panel()!;
    expect(dlg.querySelectorAll(".zoom-body [id]").length).toBe(0);
    // Nor a second control, which would open a panel from inside the panel.
    expect(dlg.querySelectorAll(".zoom-body button.zoom").length).toBe(0);
  });

  test("the cross closes it, and so does the back button", () => {
    controls()[0]!.click();
    expect(panel()!.open).toBe(true);
    (panel()!.querySelector(".zoom-x") as El).click();
    expect(panel()!.open).toBe(false);
    // Nothing of the closed panel is left holding a copy of the page's code.
    expect(panel()!.querySelector(".zoom-inner")!.innerHTML).toBe("");

    controls()[0]!.click();
    expect(panel()!.open).toBe(true);
    // The phone's back gesture, which is how a full-screen thing is actually closed.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(panel()!.open).toBe(false);
  });

  test("the back gesture closes the panel and stops there", async () => {
    // The one thing this must never do. `dialog.close()` only *queues* the close
    // event, so a guard that is raised and lowered around the call is already down by
    // the time the handler reads it, and the panel walks back a second entry: the
    // reader presses back to leave the code and leaves the review instead. happy-dom
    // fires `close` synchronously, so the queued task is staged here by hand.
    const back = window.history.back;
    let backs = 0;
    window.history.back = function () { backs++; return back.apply(this, arguments as never); };
    try {
      controls()[0]!.click();
      // The spec's queued task, in place of happy-dom's synchronous dispatch: shut the
      // dialog now, tell the page about it after the current task has finished.
      const dlg = panel()!;
      dlg.close = () => {
        dlg.open = false;
        queueMicrotask(() => dlg.dispatchEvent(new Event("close")));
      };
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(dlg.open).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(backs).toBe(0);
    } finally {
      window.history.back = back;
    }
  });

  test("the panel takes back a history entry it no longer needs", async () => {
    // A mark of the reader's own place, so what the panel does to the history is
    // measured against where it started rather than against an empty stack.
    window.history.pushState({ readersPlace: 1 }, "");
    controls()[0]!.click();
    // The entry the back gesture consumes.
    expect((window.history.state as { overseerCode?: number } | null)?.overseerCode).toBe(1);
    // Closed by the cross instead, the panel walks that entry back itself, so the
    // reader who then presses back leaves the review rather than un-closing a panel.
    (panel()!.querySelector(".zoom-x") as El).click();
    await window.happyDOM?.waitUntilComplete();
    expect(window.history.state).toEqual({ readersPlace: 1 });
  });
});

// ---- the file around the hunks ----
//
// What the panel opens on is the hunks, and that is what the block above pins. This
// block is the second half: the panel then asks for the file those hunks were cut from
// and lays them back into it, so a reader sees the change sitting inside something.
//
// The fetch is stubbed rather than mocked away, because every number that matters here
// is one the client works out for itself — which lines it is missing, where the hunk
// goes back in, how much file is left between two stretches. A stub that answers with
// the file it was asked for is what makes those numbers checkable.

/** A file long enough to have a gap in it that is worth a control. Lines 40, 41 and 42
 *  are the golden hunk's own, so the file and the hunk agree about the code there. */
const FILE: string[] = (() => {
  const out: string[] = [];
  for (let n = 1; n <= 300; n++) out.push("const filler" + n + " = " + n + ";");
  out[39] = "export function gate(req: Request) {";
  out[40] = "  return session(req) !== null;";
  out[41] = "}";
  return out;
})();

interface Asked {
  path: string;
  sha: string;
  from: number;
  to: number;
}

let asked: Asked[] = [];
let answer: "file" | "refuse" | "dead" = "file";
/** Once the file is on screen, everything after this many answers fails. */
let failAfter = Infinity;
const realFetch = globalThis.fetch;

function serveFile(): void {
  asked = [];
  answer = "file";
  failAfter = Infinity;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (input: string) => {
    const url = new URL(String(input), "https://seer.test");
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    asked.push({
      path: url.searchParams.get("path") ?? "",
      sha: url.searchParams.get("sha") ?? "",
      from,
      to,
    });
    if (answer === "dead") throw new Error("offline");
    if (answer === "refuse" || asked.length > failAfter) {
      return new Response(JSON.stringify({ context: null, why: "GitHub would not serve this file." }), {
        headers: { "content-type": "application/json" },
      });
    }
    const start = Math.min(from, FILE.length + 1);
    const end = Math.min(to, FILE.length);
    const slice = end < start ? [] : FILE.slice(start - 1, end);
    return new Response(
      JSON.stringify({
        path: url.searchParams.get("path"),
        sha: url.searchParams.get("sha"),
        total: FILE.length,
        from: start,
        to: start + slice.length - 1,
        lines: contextLines(start, slice, "ts"),
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
}

/** Let every stubbed answer land, including the ones the answers themselves ask for. */
async function settled(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

const openFile = (path: string): void => {
  controls().find((b) => b.dataset.zoom === path)!.click();
};
const view = (): El | null => document.querySelector(".zoom-body .filefull");
const gaps = (): El[] => [...document.querySelectorAll(".zoom-body .gapfill")];
/** Every new-side line number the panel is drawing, in the order it draws them. */
const numbers = (): number[] =>
  [...document.querySelectorAll(".zoom-body .filefull .l")]
    .filter((l) => !l.className.includes("del"))
    .map((l) => Number(l.querySelector(".n")!.textContent));

describe("the file the hunks were cut from", () => {
  beforeEach(() => {
    serveFile();
    render();
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = realFetch;
  });

  test("it asks for the file the hunk names, around the lines the hunk draws", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    // The hunk draws new-side lines 40 to 42, so the first ask is the twenty lines
    // each side of that, minus the three the page already has.
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) {
      expect(a.path).toBe(GOLDEN_HUNKS.auth.path);
      expect(a.sha).toBe(GOLDEN_HUNKS.auth.sha);
    }
    // Nothing asks for a line the hunk itself is carrying.
    for (const a of asked) expect(a.from > 42 || a.to < 40).toBe(true);
  });

  test("the hunk lands back on its own line numbers, with the file running through it", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(view()).not.toBeNull();

    const seen = numbers();
    // Unbroken from the first line the panel draws to the last: that is the whole
    // claim, and a hunk dropped in at the wrong number would break it here.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
    expect(seen[0]).toBe(1);
    // The file is around the hunk on both sides.
    expect(seen).toContain(20);
    expect(seen).toContain(41);
    expect(seen).toContain(60);
    // And the hunk is still the hunk: its removed line is in there, carrying the old
    // file's number rather than the new one.
    const del = document.querySelector(".zoom-body .filefull .l.del")!;
    expect(del.textContent).toContain("return true;");

    // The hunk the reader pressed is marked, in the panel and only in the panel.
    expect(document.querySelectorAll(".zoom-body .hunk.focus").length).toBe(1);
    expect(document.querySelectorAll(".walk .hunk.focus").length).toBe(0);
  });

  test("what is left of the file is said, and pressing it takes the rest", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();

    const gap = gaps()[0]!;
    expect(gaps().length).toBe(1);
    const from = Number(gap.getAttribute("data-from"));
    const to = Number(gap.getAttribute("data-to"));
    expect(to).toBe(FILE.length);
    expect(gap.textContent).toContain(String(to - from + 1) + " lines");

    gap.click();
    await settled();
    // Nothing left to say: the file runs to its end.
    expect(gaps().length).toBe(0);
    expect(numbers()[numbers().length - 1]).toBe(FILE.length);
  });

  test("the range header goes, because the numbers are saying it", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    // Still in the markup, so nothing was surgically removed from a clone; hidden by
    // the panel's own rule, which is where the decision belongs.
    expect(document.querySelector(".zoom-body .hh")).not.toBeNull();
    expect(view()!.className).toContain("filefull");
  });

  test("one row, two commits, and the panel keeps the hunks it opened on", async () => {
    // A file whose hunks count against two different commits is two files underneath,
    // and there is no single one to lay them out in. The walkthrough already marks
    // that seam; the panel declines rather than inventing a file.
    const row = document.querySelector(`.filediff:has(button[data-zoom="${GOLDEN_HUNKS.auth.path}"])`)!;
    const twin = row.querySelector(".hunk")!.cloneNode(true);
    twin.setAttribute("data-sha", "9".repeat(40));
    twin.setAttribute("data-new-from", "80");
    twin.setAttribute("data-new-to", "84");
    row.appendChild(twin);

    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(view()).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a file that will not come leaves the hunks and says so once", async () => {
    answer = "refuse";
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(view()).toBeNull();
    const said = document.querySelectorAll(".zoom-body .nocontext");
    expect(said.length).toBe(1);
    expect(said[0]!.textContent).toContain("GitHub would not serve this file");
    // The code the panel opened on is untouched: the reader keeps everything they had
    // before any of this was offered.
    expect(document.querySelectorAll(".zoom-body .hunk").length).toBe(1);
  });

  test("a network that is simply not there says the same kind of thing", async () => {
    answer = "dead";
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(view()).toBeNull();
    expect(document.querySelectorAll(".zoom-body .nocontext").length).toBe(1);
    expect(document.querySelectorAll(".zoom-body .hunk").length).toBe(1);
  });

  test("a stretch that will not come stops pulsing, says why, and stops asking", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(view()).not.toBeNull();
    const before = asked.length;

    // Everything from here on fails. The reader presses the gap at the end of the file.
    failAfter = before;
    const gap = gaps()[0]!;
    const from = Number(gap.getAttribute("data-from"));
    gap.click();
    await settled();

    // The gap is still there, because the lines behind it never arrived, and it says
    // what happened instead of how many. Nothing is left pulsing in its place.
    const after = gaps();
    expect(after.length).toBe(1);
    expect(Number(after[0]!.getAttribute("data-from"))).toBe(from);
    expect(after[0]!.textContent).toContain("GitHub would not serve this file");
    expect(after[0]!.getAttribute("data-failed")).not.toBeNull();
    expect(document.querySelectorAll(".zoom-body .l.sk").length).toBe(0);
    // The file the reader already had is untouched.
    expect(numbers()[0]).toBe(1);

    // And it does not ask again. A gap that failed and kept offering itself would
    // re-issue the same request on every scroll for as long as the reader sat there.
    const spent = asked.length;
    after[0]!.click();
    await settled();
    expect(asked.length).toBe(spent);
  });

  test("closing drops what it was waiting for", async () => {
    openFile(GOLDEN_HUNKS.auth.path);
    (panel()!.querySelector(".zoom-x") as El).click();
    await settled();
    // The answers landed on a panel that is not there, and none of them put anything
    // back into it.
    expect(panel()!.querySelector(".zoom-inner")!.innerHTML).toBe("");
  });

  test("a quoted ref opens the file around the lines it quotes", async () => {
    // A ref is the other kind of code surface on the page, and it wears the same
    // control. The panel does the same thing with it: the file, with the quoted lines
    // marked rather than alone.
    const control = controls().find((b) => /L\d+-\d+$/.test(b.dataset.zoom ?? ""))!;
    expect(control).toBeDefined();
    control.click();
    await settled();

    expect(view()).not.toBeNull();
    const seen = numbers();
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
    // The quoted range sits inside a stretch of the file rather than being all of it.
    expect(seen[0]).toBe(1);
    expect(seen).toContain(GOLDEN_REF_START - 5);
    expect(seen).toContain(GOLDEN_REF_END + 5);

    // Marked, so the reader can still see which lines the claim stood on...
    const marked = [...document.querySelectorAll(".zoom-body .filefull .l.focus")].map((l) =>
      Number(l.querySelector(".n")!.textContent),
    );
    expect(marked[0]).toBe(GOLDEN_REF_START);
    expect(marked[marked.length - 1]).toBe(GOLDEN_REF_END);
    // ...and the line it singled out inside them keeps its own wash.
    const lit = [...document.querySelectorAll(".zoom-body .filefull .l.hl")].map((l) =>
      Number(l.querySelector(".n")!.textContent),
    );
    expect(lit).toEqual([42]);

    // It asked for the file the ref names, and never for a hunk's file.
    for (const a of asked) expect(a.path).toBe("src/auth.ts");
  });

  test("a shared page never asks", async () => {
    render({ context: false });
    openFile(GOLDEN_HUNKS.auth.path);
    await settled();
    expect(asked).toEqual([]);
    expect(view()).toBeNull();
    // And the panel is exactly the one that shipped before any of this existed.
    expect(document.querySelectorAll(".zoom-body .hunk").length).toBe(1);
  });
});
