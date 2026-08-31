import { GlobalRegistrator } from "@happy-dom/global-registrator";
await GlobalRegistrator.register({ url: "http://localhost/ws/r/review/rev/1?review=group" });
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { STAGE_CLIENT } from "../../src/stage/render-client";
import { STAGE_CSS } from "../../src/stage/render-css";

declare const document: any;
declare const window: any;
declare const Event: any;
declare const MouseEvent: any;

const CHANGE = `chg_${"a".repeat(64)}`;

function fixture(): void {
  document.body.innerHTML = `<div data-stage-background></div><dialog open data-focus-dialog data-review="group" data-active-change="${CHANGE}"><div data-focus-layout data-left="open" data-right="open"><main data-focus-stream><article class="hunk-review" data-change="${CHANGE}" data-collapsed="false"><header class="hunk-header"><button data-toggle-change="${CHANGE}"></button><code>src/a.ts:L1</code></header><div class="diff-line"><button data-line-select data-line-side="new" data-line-number="1">1</button></div><div class="diff-line add"><button data-line-select data-line-side="new" data-line-number="2">2</button></div><div class="diff-line"><button data-line-select data-line-side="new" data-line-number="3">3</button></div></article></main><aside><article data-ledger-change="${CHANGE}" data-change="${CHANGE}"><details class="range-thread"><form class="thread-new range" action="/threads"><input name="idempotencyKey" value="render-key"><input name="side"><input name="startLine"><input name="endLine"><textarea name="body">Question</textarea><span role="status"></span><button type="submit">Add</button></form></details></article></aside><button data-focus-panel-close hidden></button></div><nav><span data-focus-change-position></span></nav></dialog>`;
  const dialog = document.querySelector("dialog"); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  window.matchMedia = () => ({ matches: false, addEventListener() {} }); (globalThis as any).matchMedia = window.matchMedia;
  class ResizeObserverStub { constructor(_callback: unknown) {} observe() {} } (globalThis as any).ResizeObserver = ResizeObserverStub;
  delete (globalThis as any).IntersectionObserver;
  window.history.replaceState({ directReview: true }, "", "http://localhost/ws/r/review/rev/1?review=group");
}

function run(): void { (0, eval)(STAGE_CLIENT); }
function pointer(type: string, target: any, pointerType: string): void { const event = new Event(type, { bubbles: true }); Object.defineProperty(event, "pointerType", { value: pointerType }); target.dispatchEvent(event); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => { fixture(); run(); });
afterAll(() => GlobalRegistrator.unregister());

describe("conversation line selection", () => {
  test("should select one keyboard line and extend with Shift+Enter semantics", () => {
    const lines = [...document.querySelectorAll("[data-line-select]")];
    lines[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    lines[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(lines.map((line) => line.getAttribute("aria-pressed"))).toEqual(["true", "true", "true"]);
    const form = document.querySelector(".range-thread form");
    expect([form.elements.namedItem("side").value, form.elements.namedItem("startLine").value, form.elements.namedItem("endLine").value]).toEqual(["new", "1", "3"]);
  });

  test("should extend a touch selection on the second line", () => {
    const lines = [...document.querySelectorAll("[data-line-select]")];
    lines[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    pointer("pointerdown", lines[2], "touch"); pointer("pointerup", lines[2], "touch"); lines[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lines.map((line) => line.getAttribute("aria-pressed"))).toEqual(["true", "true", "true"]);
  });

  test("should extend a pointer drag across line controls", () => {
    const lines = [...document.querySelectorAll("[data-line-select]")];
    pointer("pointerdown", lines[0], "mouse"); pointer("pointermove", lines[2], "mouse"); pointer("pointerup", lines[2], "mouse"); lines[2].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(lines.map((line) => line.getAttribute("aria-pressed"))).toEqual(["true", "true", "true"]);
  });

  test("should not suppress the first pointer or keyboard line after another dialog control", () => {
    const toggle = document.querySelector("[data-toggle-change]");
    const lines = [...document.querySelectorAll("[data-line-select]")];
    pointer("pointerdown", toggle, "mouse"); pointer("pointerup", toggle, "mouse");
    pointer("pointerdown", lines[0], "mouse"); pointer("pointerup", lines[0], "mouse"); lines[0].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(lines.map((line) => line.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    pointer("pointerdown", toggle, "mouse"); pointer("pointerup", toggle, "mouse");
    lines[2].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(lines.map((line) => line.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  });

  test("should reuse one operation key for an uncertain retry and rotate it after correction", async () => {
    const form = document.querySelector(".range-thread form");
    const uncertain: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      uncertain.push(String((init.body as FormData).get("idempotencyKey")));
      throw new Error("connection lost");
    };
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    expect(uncertain[0]).toBe(uncertain[1]);

    const corrected: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      corrected.push(String((init.body as FormData).get("idempotencyKey")));
      return Response.json({ error: "The selection mixes changed and unchanged lines.", rule: "anchor_mixed", details: { ranges: [{ kind: "unchanged", startLine: 1, endLine: 1 }, { kind: "changed", startLine: 2, endLine: 2 }] } }, { status: 422 });
    };
    form.elements.namedItem("startLine").value = "1"; form.elements.namedItem("endLine").value = "2";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    const choices = [...form.querySelectorAll('[role="status"] button')];
    expect(choices.map((button) => button.textContent)).toEqual(["Unchanged L1–1", "Changed L2–2"]);
    choices[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await tick();
    expect(corrected[0]).not.toBe(corrected[1]);
    expect([form.elements.namedItem("startLine").value, form.elements.namedItem("endLine").value]).toEqual(["2", "2"]);
  });

  test("should keep the no-JavaScript details rail in flow", () => {
    expect(STAGE_CSS).toContain("html:not(.js) .focus-right{position:static;display:block");
  });
});
