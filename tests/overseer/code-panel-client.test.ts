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
function render(): void {
  const html = renderReviewPage({
    wsId: "ws_test",
    slug: "golden",
    doc: doc(),
    version: 1,
    latestVersion: 1,
    pinned: true,
    freshness: {},
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
