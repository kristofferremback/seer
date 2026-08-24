import { GlobalRegistrator } from "@happy-dom/global-registrator";
await GlobalRegistrator.register({ url: "http://localhost/ws/st/reader/v/1" });

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { STAGE_CLIENT } from "../src/stage/render-client";

declare const document: any;
declare const window: any;
declare const history: any;
declare const location: any;
declare const Event: any;
declare const MouseEvent: any;
declare const KeyboardEvent: any;

afterAll(async () => GlobalRegistrator.unregister());

let resizeCallbacks: ((entries: any[]) => void)[] = [];

function fixture(mobile = false): void {
  document.body.innerHTML = `
    <main class="walkthrough">
      <details open data-change="chg_${"a".repeat(64)}" data-file="stf_0000000000" data-read="false" data-path="src/a.ts" data-description="First description" data-group-title="First" data-signals="Code · importance high · complexity medium">
        <div data-review-core><div data-diff-frame data-layout="unified"></div><form class="read-form" action="/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark as read</button></form></div>
      </details>
      <details open data-change="chg_${"b".repeat(64)}" data-file="stf_0000000001" data-read="false"><div data-review-core></div></details>
    </main>
    <span data-progress></span>
    <section data-group data-change-ids="chg_${"a".repeat(64)},chg_${"b".repeat(64)}"><span data-group-progress></span></section>
    <details data-tree-node data-files="1" data-change-ids="chg_${"a".repeat(64)},chg_${"b".repeat(64)}"><summary><span data-tree-summary></span></summary></details>
    <a data-tree-file data-change-ids="chg_${"a".repeat(64)}"></a>
    <a href="#chg_${"a".repeat(64)}" data-focus-link data-focus="chg_${"a".repeat(64)}">Review</a>
    <aside data-repo-rail data-open="false"><a data-tree-file href="#chg_${"b".repeat(64)}">Second</a></aside><button data-repo-open>Repository</button><button data-scrim hidden></button>
    <dialog data-focus-dialog><button data-focus-toggle="tree">Repository</button><a data-tree-focus="chg_${"b".repeat(64)}" href="#chg_${"b".repeat(64)}">Second focus</a><div data-focus-layout data-left="open" data-right="open"><span data-focus-title></span><main data-focus-center></main><aside><div data-focus-detail-content></div></aside></div><button data-focus-close>Close</button></dialog>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  window.matchMedia = (query: string) => ({ matches: mobile && query.includes("max-width"), addEventListener() {} });
  (globalThis as any).matchMedia = window.matchMedia;
  resizeCallbacks = [];
  class ResizeObserverStub {
    callback: (entries: any[]) => void;
    constructor(callback: (entries: any[]) => void) { this.callback = callback; resizeCallbacks.push(callback); }
    observe() {}
  }
  window.ResizeObserver = ResizeObserverStub;
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  window.history.replaceState(null, "", "http://localhost/ws/st/reader/v/1");
}

function run(): void {
  (0, eval)(STAGE_CLIENT);
}

beforeEach(() => {
  fixture();
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ changeId: `chg_${"a".repeat(64)}`, read: true }) });
});

describe("stage reader client", () => {
  test("marking read collapses only that change and updates recursive summaries", async () => {
    run();
    const changes = document.querySelectorAll("[data-change]");
    const form = changes[0].querySelector("form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(changes[0].open).toBe(false);
    expect(changes[1].open).toBe(true);
    expect(changes[0].dataset.read).toBe("true");
    expect(document.querySelector("[data-progress]").textContent).toBe("1 / 2 read");
    expect(document.querySelector("[data-tree-summary]").textContent).toBe("1 files · 2 changes · 1 unread");
    expect(document.querySelector("[data-tree-file]").dataset.unread).toBe("false");
  });

  test("focus lives in the URL and native cancel returns to the page", async () => {
    run();
    document.querySelector("[data-focus-link]").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const dialog = document.querySelector("dialog");
    expect(dialog.open).toBe(true);
    expect(new URL(location.href).searchParams.get("focus")).toBe(`chg_${"a".repeat(64)}`);
    expect(dialog.querySelector("[data-focus-center]").textContent).toContain("Mark as read");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(dialog.open).toBe(false);
  });

  test("explicit close exits focus after navigating to another change", async () => {
    run();
    document.querySelector("[data-focus-link]").click();
    document.querySelector("[data-tree-focus]").click();
    expect(new URL(location.href).searchParams.get("focus")).toBe(`chg_${"b".repeat(64)}`);
    document.querySelector("[data-focus-close]").click();
    await Bun.sleep(0);
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("focus")).toBeNull();
  });

  test("panel toggles preserve the focused diff and loaded context DOM", () => {
    run();
    document.querySelector("[data-focus-link]").click();
    const center = document.querySelector("[data-focus-center]");
    const content = center.firstChild;
    document.querySelector("[data-focus-toggle]").click();
    expect(center.firstChild).toBe(content);
  });

  test("mobile panel navigation still closes focus in one action", async () => {
    fixture(true); run();
    document.querySelector("[data-focus-link]").click();
    document.querySelector("[data-focus-toggle]").click();
    document.querySelector("[data-tree-focus]").click();
    document.querySelector("[data-focus-close]").click();
    await Bun.sleep(0);
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("focus")).toBeNull();
  });

  test("direct focus landing closes without leaving or preserving focus state", () => {
    const id = `chg_${"a".repeat(64)}`;
    history.replaceState(null, "", `http://localhost/ws/st/reader/v/1?focus=${id}#${id}`);
    run();
    document.querySelector("[data-tree-focus]").click();
    document.querySelector("[data-focus-close]").click();
    expect(document.querySelector("dialog").open).toBe(false);
    expect(new URL(location.href).searchParams.get("focus")).toBeNull();
  });

  test("switches each diff at exactly 1400 pixels of its own width", () => {
    run();
    const frame = document.querySelector("[data-diff-frame]");
    expect(resizeCallbacks.length).toBeGreaterThan(0);
    for (const callback of resizeCallbacks) callback([{ contentRect: { width: 1399 } }]);
    expect(frame.dataset.layout).toBe("unified");
    for (const callback of resizeCallbacks) callback([{ contentRect: { width: 1400 } }]);
    expect(frame.dataset.layout).toBe("split");
  });

  test("repository drawer uses history state and remains contained by its rail", () => {
    run();
    document.querySelector("[data-repo-open]").click();
    expect(document.querySelector("[data-repo-rail]").dataset.open).toBe("true");
    expect(new URL(location.href).searchParams.get("panel")).toBe("repository");
    document.querySelector("[data-repo-rail] [data-tree-file]").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelector("[data-repo-rail]").dataset.open).toBe("false");
    expect(new URL(location.href).searchParams.get("panel")).toBeNull();
  });
});
