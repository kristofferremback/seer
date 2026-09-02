// The moving reader, run in a real DOM.
//
// Two claims are browser claims rather than markup claims, and both are about what did NOT
// change. A read that arrived by carry has to reverse exactly like one somebody clicked —
// the client cannot have a second idea of where a read came from — and the two new header
// lines have to be inert: an ordinary link and an ordinary line of text, with no control,
// no handler and no interception, so Back and Escape behave as they did before them.
//
// happy-dom is registered globally, so this file gets its own process (bun test runs one
// process per file) and nothing else in the suite sees these globals.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
await GlobalRegistrator.register({ url: "http://localhost/ws/r/mover/rev/3" });

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { STAGE_CLIENT } from "../../src/stage/render-client";
import { STAGE_CSS } from "../../src/stage/render-css";

declare const document: any;
declare const window: any;
declare const location: any;
declare const Event: any;
declare const MouseEvent: any;
declare const KeyboardEvent: any;

const A = `chg_${"a".repeat(64)}`;
const B = `chg_${"b".repeat(64)}`;
const C = `chg_${"c".repeat(64)}`;
const DRIFT_HREF = "/ws/r/mover/rev/4";

function hunk(id: string, path: string): string {
  return `<article class="hunk-review" data-change="${id}" data-read="false" data-collapsed="false"><header class="hunk-header"><button data-toggle-change="${id}" aria-expanded="true"></button><code>${path}</code><span class="dimensions"><span data-read-state><span></span><span>Unread</span></span></span><form class="read-form" action="/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark read</button></form></header><div data-hunk-body><div data-diff-frame data-layout="unified"></div></div></article>`;
}

function ledger(id: string): string {
  return `<article class="ledger-card" data-ledger-change="${id}" data-change="${id}" data-read="false"><button data-activate-change="${id}"></button><span data-read-state><span></span><span>Unread</span></span><form class="read-form" action="/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark read</button></form></article>`;
}

function dialogContent(ids = [A, B]): string {
  return `<div class="focus-shell"><button data-focus-close>Close</button><button data-focus-toggle="tree">Review</button><button data-change-step="previous">Previous</button><button data-change-step="next">Next</button><div data-focus-layout data-left="open" data-right="open"><aside><a data-activate-change="${ids[1]}" href="#${ids[1]}">Second change</a></aside><main data-focus-stream><details class="file-review" open><summary><span data-file-progress>0 / ${ids.length} read</span></summary>${ids.map((id, index) => hunk(id, `src/${index}.ts:L1`)).join("")}</details></main><aside><button data-filter-unread aria-pressed="false">Unread</button><div>${ids.map(ledger).join("")}</div></aside><button data-focus-panel-close hidden></button></div><nav><span data-focus-change-position></span></nav></div>`;
}

/** The overview a promoted revision renders, including the two lines this slice adds. */
function fixture(): void {
  document.body.dataset.stageChangeIds = `${A},${B},${C}`;
  // One read that arrived by carry rather than by anybody clicking. The client is not told
  // which, deliberately: a read is a read.
  document.body.dataset.stageReadIds = A;
  document.body.innerHTML = `
    <div data-stage-background>
    <div class="stage-grid stage-overview"><header class="stage-header">
      <div class="stage-source"><span>Revision 3 · latest</span></div>
      <p class="stage-drift"><a href="${DRIFT_HREF}">Revision 4 available</a></p>
      <p class="stage-movement">Since rev 2 · 1 unchanged · 1 revised</p>
    </header></div>
    <main class="walkthrough">
      <section id="group-first" data-group="first" data-change-ids="${A},${B}"><span data-group-progress></span></section>
      <section data-group="second" data-change-ids="${C}"><span data-group-progress></span></section>
      <a data-focus-link data-review="first" data-change="${A}" href="?review=first&change=${A}#${A}">Review group</a>
    </main>
    <span data-progress></span><i data-progress-fill></i><span data-unread-summary></span>
    <span data-group-nav-progress data-change-ids="${A},${B}"></span>
    <details data-tree-node data-files="1" data-change-ids="${A},${B}"><summary><span data-tree-summary><span>1 file</span><span class="tree-read"><i></i>0/2</span></span></summary></details>
    <aside data-review-nav data-open="false"><nav class="group-links"><a href="#group-first">First group</a></nav></aside><button data-review-nav-open>rev 3</button><button data-page-scrim hidden></button>
    </div>
    <dialog data-focus-dialog data-review="first" data-active-change="${A}">${dialogContent()}</dialog>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  (globalThis as any).matchMedia = window.matchMedia;
  (globalThis as any).DOMParser = window.DOMParser;
  class ResizeObserverStub { constructor(_callback: unknown) {} observe() {} }
  window.ResizeObserver = ResizeObserverStub;
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  delete (window as any).IntersectionObserver;
  delete (globalThis as any).IntersectionObserver;
  window.history.replaceState(null, "", "http://localhost/ws/r/mover/rev/3");
}

function run(): void {
  (0, eval)(STAGE_CLIENT);
}

function click(selector: string): any {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.querySelector(selector).dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: "http://localhost/ws/r/mover/rev/3" });
  fixture();
  // The server is the authority on a read; the client only reflects what it answered.
  (globalThis as any).fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as { get(name: string): string } | undefined;
    const read = body?.get("read") === "true";
    return new Response(JSON.stringify({ changeId: A, read }), { status: 200 });
  };
});

afterAll(async () => GlobalRegistrator.unregister());

describe("a carried read behaves like any other read", () => {
  test("it is read on arrival, everywhere the page counts reads", () => {
    run();
    expect(document.querySelector("[data-progress]").textContent).toBe("1 / 3 handled");
    expect(document.querySelector(`.hunk-review[data-change="${A}"]`).dataset.read).toBe("true");
    expect(document.querySelector(`[data-ledger-change="${A}"]`).dataset.read).toBe("true");
    // And its form offers the reversal rather than the mark.
    expect(document.querySelector(`.hunk-review[data-change="${A}"] [data-read-button]`).textContent).toBe("Mark unread");
    expect(document.querySelector(`.hunk-review[data-change="${A}"] [data-read-input]`).value).toBe("false");
  });

  test("reversing it takes one action and updates every aggregate", async () => {
    run();
    const carried = document.querySelector(`.hunk-review[data-change="${A}"]`);
    carried.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(carried.dataset.read).toBe("false");
    expect(document.querySelector("[data-progress]").textContent).toBe("0 / 3 handled");
    expect(document.querySelector(`[data-ledger-change="${A}"]`).dataset.read).toBe("false");
    expect(carried.querySelector("[data-read-button]").textContent).toBe("Mark read");
  });
});

describe("the newer-source lines are inert", () => {
  test("the drift link is an ordinary link the client never touches", () => {
    run();
    const link = document.querySelector(".stage-drift a");
    expect(link.getAttribute("href")).toBe(DRIFT_HREF);
    // No client hook of any kind: nothing here opens a dialog, pushes state, or fetches.
    const dataAttributes = (node: any) => [...node.attributes].map((attribute: any) => attribute.name).filter((name: string) => name.startsWith("data-"));
    expect(dataAttributes(link)).toEqual([]);
    expect(dataAttributes(document.querySelector(".stage-movement"))).toEqual([]);
    const event = click(".stage-drift a");
    expect(event.defaultPrevented).toBe(false);
  });

  test("Back and Escape are unchanged by them", async () => {
    run();
    click("[data-focus-link]");
    const dialog = document.querySelector("dialog");
    expect(dialog.open).toBe(true);
    expect(new URL(location.href).searchParams.get("review")).toBe("first");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(dialog.open).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("the phone hunk header wraps its labels and the nav opener is a 44px target", () => {
    // Both were measured in a real browser at 390px: `medium importa` clipped mid-word,
    // and the pin word that opens group navigation was 14px wide. The rule that
    // un-hides the label on phone has to undo the desktop clipping too, and the only way
    // into navigation on a phone overview has to be a finger's width.
    const phone = STAGE_CSS.slice(STAGE_CSS.indexOf("@media(max-width:760px)"));
    expect(phone).toContain(".dimensions.in-header .dimension>span:last-child,.dimensions.in-header .dimension:not(.read-dimension)>span:last-child{position:static;width:auto;height:auto;clip-path:none;overflow:visible;white-space:normal}");
    expect(phone).toContain(".mobile-bar button{min-height:44px;min-width:44px;");
  });

  test("neither line adds a phone control, and both read as the source facts above them", () => {
    // Same type, same weight, same colour as the workflow line they sit under: three facts
    // about one source, one visual grammar.
    expect(STAGE_CSS).toContain(".stage-drift,.stage-movement{margin:6px 0 0;font:11px var(--mono);color:hsl(var(--muted))}");
    expect(STAGE_CSS).toContain(".stage-drift a{color:inherit;text-decoration:underline;text-underline-offset:2px}");
    // No pill, no banner, no modal, and nothing new in the three-slot phone chrome.
    expect(STAGE_CSS).not.toContain(".stage-drift button");
    expect(STAGE_CSS).not.toContain(".drift-banner");
    expect(STAGE_CLIENT).not.toContain("stage-drift");
    expect(STAGE_CLIENT).not.toContain("stage-movement");
  });
});
