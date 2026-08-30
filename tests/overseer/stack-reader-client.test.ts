// The stack reader, run in a real DOM.
//
// Three things are browser claims rather than markup claims. The layer is a history rung
// between the panel and the review, so Escape and Back drop it before they close the
// review. A page change swaps the dialog without adding a rung. And a read posted through
// the stack route answers with the namespaced id, so the client's DOM — which only ever
// saw namespaced ids — updates exactly as a member page's would.
//
// happy-dom is registered globally, so this file gets its own process.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
await GlobalRegistrator.register({ url: "http://localhost/ws/r-stacks/stack/v/2/account" });

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { STAGE_CLIENT } from "../../src/stage/render-client";

declare const document: any;
declare const window: any;
declare const location: any;
declare const history: any;
declare const Event: any;
declare const MouseEvent: any;
declare const KeyboardEvent: any;

const A = `l1-chg_${"a".repeat(64)}`;
const B = `l2-chg_${"b".repeat(64)}`;
const C = `l3-chg_${"c".repeat(64)}`;
const PINNED = "/ws/r-stacks/stack/v/2/account";

let fetched: string[] = [];
let mobile = false;

function hunk(id: string, path: string): string {
  const position = id.slice(1, 2);
  return `<article class="hunk-review" data-change="${id}" data-read="false" data-collapsed="false"><header class="hunk-header"><button data-toggle-change="${id}" aria-expanded="true"></button><code>${path}</code><span class="dimensions"><span data-read-state><span></span><span>Unread</span></span></span><form class="read-form" action="${PINNED.replace("/account", "")}/m/${position}/changes/${id}/read"><input data-read-input name="read" value="true"><span data-read-failure></span><button data-read-button>Mark read</button></form></header><div data-hunk-body><div data-diff-frame data-layout="unified"></div></div></article>`;
}

function ledger(id: string): string {
  return `<article class="ledger-card" data-ledger-change="${id}" data-change="${id}" data-read="false"><button data-activate-change="${id}"></button><span data-read-state><span></span><span>Unread</span></span></article>`;
}

/** A focus dialog as the stack renderer draws it, for one scope and page. */
function dialogHtml(layer: string, page: string, ids: string[], review = "shared-line"): string {
  const seams = layer ? "" : ids.map((id) => `<div class="stack-seam" data-seam="l${id.slice(1, 2)}"><b>PR #${id.slice(1, 2)}</b></div>`).join("");
  return `<dialog data-focus-dialog data-review="${review}" data-layer="${layer}" data-page="${page}" data-active-change="${ids[0]}" aria-label="Shared review" open><div class="focus-shell"><button data-focus-close>Close</button><button data-focus-toggle="tree">Review</button><a data-focus-group-link data-review="other-group" href="?review=other-group">Other group</a><span class="focus-page"><a data-page-link href="${PINNED}?review=shared-line${layer ? `&layer=${layer}` : ""}" aria-disabled="${page === "1"}">‹</a>page ${page} of 2<a data-page-link href="${PINNED}?review=shared-line${layer ? `&layer=${layer}` : ""}&page=2" aria-disabled="${page === "2"}">›</a></span><div data-focus-layout data-left="open" data-right="open"><aside></aside><main data-focus-stream${layer ? "" : " data-seams"}><form class="scope-row"><select data-scope name="layer"><option value=""${layer ? "" : " selected"}>Whole stack</option><option value="pr-11"${layer === "pr-11" ? " selected" : ""}>PR #11</option><option value="pr-12"${layer === "pr-12" ? " selected" : ""}>PR #12</option><option value="pr-13"${layer === "pr-13" ? " selected" : ""}>PR #13</option></select></form>${seams}${ids.map((id) => hunk(id, `src/shared.ts:L1`)).join("")}</main><aside><button data-filter-unread aria-pressed="false">Unread</button><div>${ids.map(ledger).join("")}</div></aside><button data-focus-panel-close hidden></button></div><nav><span data-focus-change-position></span></nav></div></dialog>`;
}

function idsFor(layer: string, page: string): string[] {
  if (layer === "pr-11") return [A];
  if (layer === "pr-12") return [B];
  if (layer === "pr-13") return [C];
  return page === "2" ? [C] : [A, B];
}

function fixture(): void {
  document.body.dataset.stageChangeIds = `${A},${B},${C}`;
  document.body.dataset.stageReadIds = "";
  document.body.innerHTML = `
    <div data-stage-background>
    <main class="walkthrough">
      <section id="group-shared-line" data-group="shared-line" data-change-ids="${A},${B},${C}"><span data-group-progress></span></section>
      <a data-focus-link data-review="shared-line" data-change="${A}" href="?review=shared-line&change=${A}#${A}">Review group</a>
    </main>
    <span data-progress></span><i data-progress-fill></i><span data-unread-summary></span>
    <aside data-review-nav data-open="false"></aside><button data-review-nav-open>v2</button><button data-page-scrim hidden></button>
    </div>
    <dialog data-focus-dialog data-layer="" data-page="" aria-label="Group review"></dialog>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  window.matchMedia = (query: string) => ({ matches: query.includes("max-width") ? mobile : false, addEventListener() {} });
  (globalThis as any).matchMedia = window.matchMedia;
  (globalThis as any).DOMParser = window.DOMParser;
  delete (window as any).IntersectionObserver;
  delete (globalThis as any).IntersectionObserver;
  delete (window as any).ResizeObserver;
  delete (globalThis as any).ResizeObserver;
  fetched = [];
  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const accept = new Headers(init?.headers).get("accept");
    if (accept === "text/html") {
      fetched.push(url.search);
      const layer = url.searchParams.get("layer") ?? "";
      const page = url.searchParams.get("page") ?? "1";
      const review = url.searchParams.get("review") ?? "shared-line";
      return new Response(`<!doctype html>${dialogHtml(layer, page, idsFor(layer, page), review)}`, { status: 200, headers: { "content-type": "text/html" } });
    }
    const form = init?.body as FormData;
    const read = form.get("read") === "true";
    const id = url.pathname.split("/changes/")[1]!.split("/")[0]!;
    return new Response(JSON.stringify({ changeId: id, memberChangeId: id.slice(3), read }), { status: 200 });
  };
}

function run(): void {
  (0, eval)(STAGE_CLIENT);
}

function click(selector: string): void {
  document.querySelector(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function openReview(): Promise<void> {
  click("[data-focus-link]");
  await settle();
}

beforeEach(async () => {
  await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: "http://localhost/ws/r-stacks/stack/v/2/account" });
  mobile = false;
  fixture();
  window.history.replaceState(null, "", "http://localhost/ws/r-stacks/stack/v/2/account");
  run();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the layer rung", () => {
  test("] opens a layer as one pushed rung, ] again replaces it, and the dialog is refetched with the layer", async () => {
    await openReview();
    const dialog = document.querySelector("[data-focus-dialog]");
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.layer).toBe("");
    expect(dialog.querySelectorAll(".stack-seam").length).toBe(2);
    const depth = history.length;
    key("]");
    await settle();
    expect(new URL(location.href).searchParams.get("layer")).toBe("pr-11");
    expect(history.state).toMatchObject({ stageLayer: true, stageReview: true });
    expect(history.length).toBe(depth + 1);
    expect(dialog.dataset.layer).toBe("pr-11");
    expect(dialog.querySelectorAll(".stack-seam").length).toBe(0);
    expect(dialog.querySelectorAll(".hunk-review").length).toBe(1);
    key("]");
    await settle();
    expect(new URL(location.href).searchParams.get("layer")).toBe("pr-12");
    expect(history.length).toBe(depth + 1);
    expect(dialog.dataset.layer).toBe("pr-12");
    expect(fetched.at(-1)).toContain("layer=pr-12");
    // A page in the URL is dropped when the layer changes: page 1 of the new plan.
    expect(new URL(location.href).searchParams.has("page")).toBe(false);
  });

  test("the scope select opens a layer, and choosing the whole stack drops it", async () => {
    await openReview();
    const select = document.querySelector("[data-scope]");
    select.value = "pr-13";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(new URL(location.href).searchParams.get("layer")).toBe("pr-13");
    expect(document.querySelector("[data-focus-dialog]").dataset.layer).toBe("pr-13");
    const whole = document.querySelector("[data-scope]");
    whole.value = "";
    whole.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await settle();
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(document.querySelector("[data-focus-dialog]").dataset.layer).toBe("");
    expect(document.querySelector("[data-focus-dialog]").open).toBe(true);
  });

  test("change and group activation preserve the layer rung for Escape and Back", async () => {
    await openReview();
    key("]");
    await settle();
    click(`[data-ledger-change="${A}"] [data-activate-change]`);
    expect(history.state).toMatchObject({ stageLayer: true, stageReview: true });
    key("Escape");
    await settle();
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(document.querySelector("[data-focus-dialog]").open).toBe(true);

    key("]");
    await settle();
    click("[data-focus-group-link]");
    await settle();
    expect(new URL(location.href).searchParams.get("review")).toBe("other-group");
    expect(history.state).toMatchObject({ stageLayer: true, stageReview: true });
    history.back();
    await settle();
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBe("shared-line");
    expect(document.querySelector("[data-focus-dialog]").open).toBe(true);
  });

  test("a phone panel over a layer unwinds panel, layer, then review", async () => {
    mobile = true;
    await openReview();
    key("]");
    await settle();
    click('[data-focus-toggle="tree"]');
    await settle();
    expect(new URL(location.href).searchParams.get("panel")).toBe("tree");
    expect(history.state).toMatchObject({ stageFocusPanel: true, stageLayer: true, stageReview: true });

    key("Escape");
    await settle();
    expect(new URL(location.href).searchParams.has("panel")).toBe(false);
    expect(new URL(location.href).searchParams.get("layer")).toBe("pr-11");
    expect(document.querySelector("[data-focus-dialog]").open).toBe(true);
    key("Escape");
    await settle();
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(document.querySelector("[data-focus-dialog]").open).toBe(true);
    key("Escape");
    await settle();
    expect(new URL(location.href).searchParams.has("review")).toBe(false);
    expect(document.querySelector("[data-focus-dialog]").open).toBe(false);
  });

  test("explicit close consumes a phone panel, layer, and review without leaving a reopen rung", async () => {
    mobile = true;
    await openReview();
    key("]");
    await settle();
    click('[data-focus-toggle="tree"]');
    await settle();
    click("[data-focus-close]");
    await settle();
    await settle();
    const dialog = document.querySelector("[data-focus-dialog]");
    expect(dialog.open).toBe(false);
    expect(new URL(location.href).searchParams.has("panel")).toBe(false);
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(new URL(location.href).searchParams.has("review")).toBe(false);
    history.back();
    await settle();
    expect(new URL(location.href).searchParams.has("review")).toBe(false);
  });

  test("Escape unwinds the layer before the review, and a layer opened by URL is dropped by replace", async () => {
    // Land directly on a layered focus, as a shared link would.
    window.history.replaceState(null, "", `http://localhost${PINNED}?review=shared-line&layer=pr-12`);
    fixture();
    run();
    await settle();
    const dialog = document.querySelector("[data-focus-dialog]");
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.layer).toBe("pr-12");
    const depth = history.length;
    key("Escape");
    await settle();
    await settle();
    expect(new URL(location.href).searchParams.has("layer")).toBe(false);
    expect(new URL(location.href).searchParams.get("review")).toBe("shared-line");
    expect(history.length).toBe(depth);
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.layer).toBe("");
    key("Escape");
    await settle();
    expect(dialog.open).toBe(false);
    expect(new URL(location.href).searchParams.has("review")).toBe(false);
  });
});

describe("paging and reads", () => {
  test("a page link swaps the dialog in place without a rung, and a popstate changing only the page refetches", async () => {
    await openReview();
    const depth = history.length;
    click('[data-page-link][href$="page=2"]');
    await settle();
    expect(new URL(location.href).searchParams.get("page")).toBe("2");
    expect(history.length).toBe(depth);
    const dialog = document.querySelector("[data-focus-dialog]");
    expect(dialog.dataset.page).toBe("2");
    expect(dialog.querySelector(".hunk-review").dataset.change).toBe(C);
    // Back to page 1 by URL alone: the dialog follows.
    window.history.replaceState(history.state, "", `http://localhost${PINNED}?review=shared-line`);
    window.dispatchEvent(new Event("popstate"));
    await settle();
    expect(dialog.dataset.page).toBe("1");
    expect(dialog.querySelectorAll(".hunk-review").length).toBe(2);
  });

  test("a read through the stack route updates the namespaced change everywhere and reverses", async () => {
    await openReview();
    const dialog = document.querySelector("[data-focus-dialog]");
    const form = dialog.querySelector(`.hunk-review[data-change="${B}"] form`);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(document.body.dataset.stageReadIds).toBe(B);
    expect(dialog.querySelector(`.hunk-review[data-change="${B}"]`).dataset.read).toBe("true");
    expect(dialog.querySelector(`[data-ledger-change="${B}"]`).dataset.read).toBe("true");
    expect(document.querySelector("[data-progress]").textContent).toBe("1 / 3 read");
    expect(document.querySelector("[data-group-progress]").textContent).toBe("1 / 3 read");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(document.body.dataset.stageReadIds).toBe("");
    expect(document.querySelector("[data-progress]").textContent).toBe("0 / 3 read");
  });
});
