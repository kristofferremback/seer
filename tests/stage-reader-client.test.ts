import { GlobalRegistrator } from "@happy-dom/global-registrator";
await GlobalRegistrator.register({ url: "http://localhost/ws/st/reader/v/1" });

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { STAGE_CLIENT } from "../src/stage/render-client";
import { STAGE_CSS } from "../src/stage/render-css";

declare const document: any;
declare const window: any;
declare const history: any;
declare const location: any;
declare const Event: any;
declare const MouseEvent: any;
declare const KeyboardEvent: any;

const A = `chg_${"a".repeat(64)}`;
const B = `chg_${"b".repeat(64)}`;
const C = `chg_${"c".repeat(64)}`;

let resizeCallbacks: ((entries: any[]) => void)[] = [];
let mobile = false;

function hunk(id: string, path: string): string {
  return `<article class="hunk-review" data-change="${id}" data-read="false" data-collapsed="false"><header class="hunk-header"><button data-toggle-change="${id}" aria-expanded="true"></button><code>${path}</code><span class="dimensions"><span data-read-state><span></span><span>Unread</span></span></span><form class="read-form" action="/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark as read</button></form></header><div data-hunk-body><div data-diff-frame data-layout="unified"></div><div data-context><button data-context-trigger data-context-url="/context">Context</button><div data-context-lines></div></div></div></article>`;
}

function ledger(id: string): string {
  return `<article class="ledger-card" data-ledger-change="${id}" data-change="${id}" data-read="false"><button data-activate-change="${id}"></button><span data-read-state><span></span><span>Unread</span></span><form class="read-form" action="/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark as read</button></form></article>`;
}

function dialogContent(group = "first", ids = [A, B]): string {
  return `<div class="focus-shell"><button data-focus-close>Close</button><button data-focus-toggle="tree">Review</button><button data-change-step="previous">Previous</button><button data-change-step="next">Next</button><a data-focus-group-link data-review="second" href="?review=second">Second group</a><div data-focus-layout data-left="open" data-right="open"><aside><a data-activate-change="${ids[1]}" href="#${ids[1]}">Second change</a></aside><main data-focus-stream><details class="file-review" open><summary><span data-file-progress>0 / ${ids.length} read</span></summary>${ids.map((id, index) => hunk(id, `src/${index}.ts:L1`)).join("")}</details></main><aside><button data-filter-unread aria-pressed="false">Unread</button><div>${ids.map(ledger).join("")}</div></aside><button data-focus-panel-close hidden></button></div><nav><span data-focus-change-position></span></nav></div>`;
}

function fixture(onMobile = false): void {
  mobile = onMobile;
  document.body.dataset.stageChangeIds = `${A},${B},${C}`;
  document.body.dataset.stageReadIds = "";
  document.body.innerHTML = `
    <div data-stage-background>
    <main class="walkthrough">
      <section id="group-first" data-group="first" data-change-ids="${A},${B}"><span data-group-progress></span></section>
      <section data-group="second" data-change-ids="${C}"><span data-group-progress></span></section>
      <a data-focus-link data-review="first" data-change="${A}" href="?review=first&change=${A}#${A}">Review group</a>
    </main>
    <span data-progress></span><i data-progress-fill></i><span data-unread-summary></span>
    <span data-group-nav-progress data-change-ids="${A},${B}"></span>
    <details data-tree-node data-files="1" data-change-ids="${A},${B}"><summary><span data-tree-summary><span>1 file</span><span class="tree-read"><i></i>0/2</span></span></summary></details>
    <aside data-review-nav data-open="false"><nav class="group-links"><a href="#group-first">First group</a></nav></aside><button data-review-nav-open>v1</button><aside data-page-details data-open="false"><button data-page-details-close>Close</button></aside><button data-page-details-open>Details</button><button data-page-scrim hidden></button>
    </div>
    <dialog data-focus-dialog data-review="first" data-active-change="${A}">${dialogContent()}</dialog>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  window.matchMedia = (query: string) => ({ matches: query.includes("max-width") ? mobile : false, addEventListener() {} });
  (globalThis as any).matchMedia = window.matchMedia;
  (globalThis as any).DOMParser = window.DOMParser;
  resizeCallbacks = [];
  class ResizeObserverStub {
    callback: (entries: any[]) => void;
    constructor(callback: (entries: any[]) => void) { this.callback = callback; resizeCallbacks.push(callback); }
    observe() {}
  }
  window.ResizeObserver = ResizeObserverStub;
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  delete (window as any).IntersectionObserver;
  delete (globalThis as any).IntersectionObserver;
  window.history.replaceState(null, "", "http://localhost/ws/st/reader/v/1");
}

function run(): void {
  (0, eval)(STAGE_CLIENT);
}

function click(selector: string): void {
  document.querySelector(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: "http://localhost/ws/st/reader/v/1" });
  fixture();
  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const accept = new Headers(init?.headers).get("accept");
    if (accept === "text/html") {
      return new Response(`<!doctype html><dialog data-focus-dialog data-review="second" data-active-change="${C}" aria-label="Second review" open>${dialogContent("second", [C])}</dialog>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (accept === "application/json" && String(input).includes("context")) return new Response(JSON.stringify({ lines: [{ number: 1, text: "line" }] }), { status: 200 });
    return new Response(JSON.stringify({ changeId: A, read: true }), { status: 200 });
  };
});

afterAll(async () => GlobalRegistrator.unregister());

describe("stage reader client", () => {
  test("should keep the stack index in the overview column above phone width", () => {
    expect(STAGE_CSS).toContain(".stack-lines,.stack-members{grid-column:2}");
    expect(STAGE_CSS).toContain("@media(max-width:760px)");
  });

  test("should keep linked hover quieter than the active change in both panes", () => {
    expect(STAGE_CSS).toContain(".hunk-review.is-active .hunk-header{box-shadow:inset 3px");
    expect(STAGE_CSS).toContain(".hunk-review.is-linked-hover:not(.is-active) .hunk-header{box-shadow:none");
    expect(STAGE_CSS).toContain(".ledger-card.is-active{background:");
    expect(STAGE_CSS).toContain(".ledger-card.is-linked-hover:not(.is-active){background:");
    expect(STAGE_CSS).not.toContain(".ledger-card.is-active,.ledger-card.is-linked-hover");
  });

  test("should use AA muted text and readable walkthrough category text in light mode", () => {
    expect(STAGE_CSS).toContain("--muted:30 8% 39%");
    expect(STAGE_CSS).toContain(".group-links small,.focus-group-link small{font:11px");
  });

  test("should keep author form styles from exposing closed native details", () => {
    expect(STAGE_CSS).toContain("details:not([open])>:not(summary){display:none}");
  });

  test("should give capture failure text and retry their own visible treatment", () => {
    expect(STAGE_CSS).toContain(".capture-state[data-capture-state=failed]{color:hsl(var(--accent))}");
    expect(STAGE_CSS).toContain(".pending-facts .capture-failure{");
    expect(STAGE_CSS).toContain(".capture-retry button{min-height:40px;border:1px solid hsl(var(--accent));border-radius:3px");
  });

  test("should keep the closed mobile panel scrim off the focused review", () => {
    expect(STAGE_CSS).toContain("[hidden]{display:none!important}");
    expect(STAGE_CSS).toContain(".focus-layout[data-panel=tree] .focus-scrim");
    expect(STAGE_CSS).toContain(".focus-layout[data-panel=detail] .focus-scrim");
    expect(STAGE_CSS).not.toContain(".focus-layout[data-panel] .focus-scrim");
  });

  test("marking read collapses only that change and updates every aggregate", async () => {
    run(); click("[data-focus-link]");
    const hunks = document.querySelectorAll(".hunk-review[data-change]");
    hunks[0].querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(hunks[0].dataset.collapsed).toBe("true");
    expect(hunks[1].dataset.collapsed).toBe("false");
    expect(hunks[0].dataset.read).toBe("true");
    expect(document.querySelector("[data-progress]").textContent).toBe("1 / 3 handled");
    expect(document.querySelector("[data-group-progress]").textContent).toBe("1 / 2 handled");
    expect(document.querySelector("[data-file-progress]").textContent).toBe("1 / 2 read");
    expect(document.querySelector("[data-tree-summary] .tree-read").textContent).toBe("1/2");
    expect(document.querySelector(`[data-ledger-change="${A}"]`).dataset.read).toBe("true");
  });

  test("acknowledgement patches handling and reversal in place", async () => {
    const item = `sti_${"d".repeat(10)}`;
    document.body.dataset.stageAcknowledgementIds = item;
    document.body.dataset.stageAcknowledgedIds = "";
    const group = document.querySelector('[data-group="first"]');
    group.dataset.acknowledgementIds = item;
    group.insertAdjacentHTML("beforeend", `<details open><summary>Material · <span data-acknowledgement-summary="${item}">Needs acknowledgement</span></summary><form class="acknowledgement-form" action="/ack" data-acknowledgement-item="${item}"><input name="acknowledged" value="true"><span class="acknowledgement-state">Needs acknowledgement</span><span role="status"></span><button type="submit">Acknowledge</button></form></details>`);
    document.querySelector("[data-stage-background]").insertAdjacentHTML("beforeend", `<section class="judgment"><p id="judgment-acknowledgements" data-judgment-required>1 acknowledgement required</p><ul class="judgment-blockers"><li data-judgment-blocker="${item}"><a href="#">Material</a></li></ul><form class="judgment-form"><button type="submit" aria-describedby="judgment-acknowledgements" disabled>Approve</button></form></section>`);
    (globalThis as any).fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const acknowledged = (init?.body as FormData).get("acknowledged") === "true";
      return new Response(JSON.stringify({ itemId: item, acknowledged, acknowledgement: acknowledged ? { provenance: { kind: "explicit" } } : null }), { status: 200 });
    };
    const disclosure = group.querySelector("details");
    const href = location.href;
    run();
    expect(document.querySelector("[data-progress]").textContent).toBe("0 / 4 handled");
    expect(document.querySelector("[data-judgment-required]").textContent).toBe("1 acknowledgement required");
    expect(group.querySelector("[data-acknowledgement-summary]").textContent).toBe("Needs acknowledgement");
    const form = group.querySelector(".acknowledgement-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(disclosure.open).toBe(true);
    expect(group.querySelector("details")).toBe(disclosure);
    expect(location.href).toBe(href);
    expect(form.elements.namedItem("acknowledged").value).toBe("false");
    expect(form.querySelector("button").textContent).toBe("Undo");
    expect(document.querySelector("[data-progress]").textContent).toBe("1 / 4 handled");
    expect(document.querySelector(".judgment-blockers").hidden).toBe(true);
    expect(document.querySelector("[data-judgment-required]").hidden).toBe(true);
    expect(group.querySelector("[data-acknowledgement-summary]").textContent).toBe("Acknowledged");
    expect(document.querySelector(".judgment-form button").disabled).toBe(false);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(disclosure.open).toBe(true);
    expect(form.elements.namedItem("acknowledged").value).toBe("true");
    expect(form.querySelector("button").textContent).toBe("Acknowledge");
    expect(document.querySelector("[data-progress]").textContent).toBe("0 / 4 handled");
    expect(document.querySelector("[data-judgment-blocker]").hidden).toBe(false);
    expect(document.querySelector("[data-judgment-required]").hidden).toBe(false);
    expect(document.querySelector("[data-judgment-required]").textContent).toBe("1 acknowledgement required");
    expect(group.querySelector("[data-acknowledgement-summary]").textContent).toBe("Needs acknowledgement");
    expect(document.querySelector(".judgment-form button").disabled).toBe(true);
  });

  test("group focus lives in the URL and Escape returns to the overview", async () => {
    run(); click("[data-focus-link]");
    const dialog = document.querySelector("dialog");
    expect(dialog.open).toBe(true);
    expect(new URL(location.href).searchParams.get("review")).toBe("first");
    expect(new URL(location.href).searchParams.get("change")).toBe(A);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(dialog.open).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("change navigation stays inside one group and explicit close takes one action", async () => {
    run(); click("[data-focus-link]");click('[data-change-step="next"]');
    expect(new URL(location.href).searchParams.get("review")).toBe("first");
    expect(new URL(location.href).searchParams.get("change")).toBe(B);
    expect(document.querySelector(`[data-change="${B}"]`).classList.contains("is-active")).toBe(true);
    click("[data-focus-close]");await Bun.sleep(0);
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("switching groups preserves collapsed rails without adding another close step", async () => {
    run();click("[data-focus-link]");click("[data-focus-toggle]");click("[data-focus-group-link]");await Bun.sleep(0);
    const dialog = document.querySelector("dialog");
    expect(dialog.dataset.review).toBe("second");
    expect(dialog.querySelectorAll(".hunk-review[data-change]").length).toBe(1);
    expect(new URL(location.href).searchParams.get("review")).toBe("second");
    expect(new URL(location.href).searchParams.get("tree")).toBe("closed");
    expect(dialog.querySelector("[data-focus-layout]").dataset.left).toBe("closed");
    click("[data-focus-close]");await Bun.sleep(0);
    expect(dialog.open).toBe(false);
  });

  test("panel toggles preserve the focused code and loaded context DOM", async () => {
    run();click("[data-focus-link]");click("[data-context-trigger]");await Bun.sleep(0);
    const stream = document.querySelector("[data-focus-stream]");
    const content = stream.firstChild;
    const loaded = stream.querySelector("[data-context-lines]");
    expect(loaded.textContent).toContain("line");
    click("[data-focus-toggle]");
    expect(stream.firstChild).toBe(content);
    expect(stream.querySelector("[data-context-lines]")).toBe(loaded);
  });

  test("mobile panel history does not make explicit focus close take two actions", async () => {
    fixture(true);run();click("[data-focus-link]");click("[data-focus-toggle]");
    expect(new URL(location.href).searchParams.get("panel")).toBe("tree");
    click("[data-focus-close]");await Bun.sleep(0);
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("mobile change selection consumes the panel entry before focus closes", async () => {
    fixture(true);run();click("[data-focus-link]");click("[data-focus-toggle]");
    click(`[data-activate-change="${B}"]`);await Bun.sleep(0);
    expect(new URL(location.href).searchParams.get("panel")).toBeNull();
    expect(new URL(location.href).searchParams.get("change")).toBe(B);
    click("[data-focus-close]");await Bun.sleep(0);
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("direct mobile panel close consumes both focus entries", async () => {
    fixture(true);document.querySelector("[data-stage-background]").remove();
    history.replaceState(null, "", `http://localhost/ws/st/reader/v/1?review=first&change=${A}#${A}`);
    const length = history.length;
    run();click("[data-focus-toggle]");
    expect(history.length).toBe(length + 1);
    click("[data-focus-close]");await Bun.sleep(0);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
    history.back();await Bun.sleep(0);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
  });

  test("focus-only reload closes by replacing stale overlay history", () => {
    document.querySelector("[data-stage-background]").remove();
    history.replaceState({ stageReview: true, directReview: false }, "", `http://localhost/ws/st/reader/v/1?review=first&change=${A}#${A}`);
    const length = history.length;
    run();
    expect(history.state).toEqual({ directReview: true });
    click("[data-focus-close]");
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
    expect(history.length).toBe(length);
  });

  test("direct group landing closes without preserving review state", () => {
    history.replaceState(null, "", `http://localhost/ws/st/reader/v/1?review=first&change=${A}#${A}`);
    run();click('[data-change-step="next"]');
    expect(history.state.directReview).toBe(true);
    click("[data-focus-close]");
    expect(document.querySelector("dialog").open).toBe(false);
    expect(document.querySelector("[data-stage-background]").hasAttribute("inert")).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBeNull();
    expect(new URL(location.href).searchParams.get("change")).toBeNull();
  });

  test("switches each focused diff at exactly 1400 pixels of its own width", () => {
    run();click("[data-focus-link]");
    const frame = document.querySelector("[data-diff-frame]");
    expect(resizeCallbacks.length).toBeGreaterThan(0);
    for (const callback of resizeCallbacks) callback([{ contentRect: { width: 1399 } }]);
    expect(frame.dataset.layout).toBe("unified");
    for (const callback of resizeCallbacks) callback([{ contentRect: { width: 1400 } }]);
    expect(frame.dataset.layout).toBe("split");
  });

  test("phone Details uses one history state and the overview rail", async () => {
    fixture(true);run();click("[data-page-details-open]");
    expect(document.querySelector("[data-page-details]").dataset.open).toBe("true");
    expect(new URL(location.href).searchParams.get("panel")).toBe("details");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));await Bun.sleep(0);
    expect(document.querySelector("[data-page-details]").dataset.open).toBe("false");
    expect(new URL(location.href).searchParams.get("panel")).toBeNull();
  });

  test("review drawer uses history state and remains contained by its rail", async () => {
    run();click("[data-review-nav-open]");
    expect(document.querySelector("[data-review-nav]").dataset.open).toBe("true");
    expect(new URL(location.href).searchParams.get("panel")).toBe("review-navigation");
    click(".group-links a");await Bun.sleep(0);
    expect(document.querySelector("[data-review-nav]").dataset.open).toBe("false");
    expect(new URL(location.href).searchParams.get("panel")).toBeNull();
    expect(location.hash).toBe("#group-first");
  });

  test("active change follows the reading line instead of the shortest visible hunk", () => {
    let intersect: ((entries: any[]) => void) | null = null;
    class IntersectionObserverStub {
      constructor(callback: (entries: any[]) => void) { intersect = callback; }
      observe() {}
      disconnect() {}
    }
    window.IntersectionObserver = IntersectionObserverStub;
    (globalThis as any).IntersectionObserver = IntersectionObserverStub;
    const stream = document.querySelector("[data-focus-stream]");
    const hunks = document.querySelectorAll(".hunk-review[data-change]");
    stream.getBoundingClientRect = () => ({ top: 0, bottom: 700, height: 700 });
    hunks[0].getBoundingClientRect = () => ({ top: 60, bottom: 180, height: 120 });
    hunks[1].getBoundingClientRect = () => ({ top: 220, bottom: 520, height: 300 });
    run(); click("[data-focus-link]"); click(`[data-activate-change="${B}"]`);
    intersect!([
      { target: hunks[0], isIntersecting: true, intersectionRatio: 0.95 },
      { target: hunks[1], isIntersecting: true, intersectionRatio: 0.4 },
    ]);
    expect(document.querySelector("[data-focus-dialog]").dataset.activeChange).toBe(B);
    expect(new URL(location.href).searchParams.get("change")).toBe(B);
  });

  test("unread filter and linked hover change emphasis without changing content", () => {
    run();click("[data-focus-link]");click("[data-filter-unread]");
    expect(document.querySelector("[data-filter-unread]").getAttribute("aria-pressed")).toBe("true");
    const hunk = document.querySelector(".hunk-review[data-change]");
    hunk.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(document.querySelector(`[data-ledger-change="${A}"]`).classList.contains("is-linked-hover")).toBe(true);
    expect(document.querySelectorAll(".hunk-review[data-change]").length).toBe(2);
  });
});
