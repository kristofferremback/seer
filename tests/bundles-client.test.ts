// The ledger's client-side pass, run in a real DOM.
//
// The server sections the page in UTC, because that is the timezone it prints every
// other timestamp in and it has no way to know the reader's. The browser then re-cuts
// the same rows in the reader's own timezone, which is the one that decides what
// "today" means for someone still working at one in the morning. pages.test.ts proves
// the two copies of the rule agree; this proves the pass that applies the browser's one
// actually runs, moves the rows it should, and leaves every section counted and sorted.
//
// happy-dom is registered globally, so this file gets its own process (bun test runs
// one process per file) and nothing else in the suite sees these globals.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

await GlobalRegistrator.register();

import { test, expect, describe, afterAll } from "bun:test";
import { bundlesPage, type LedgerGroup } from "../src/pages";

// tsconfig omits the DOM lib on purpose: this is a server, and `document` quietly
// typechecking inside src/ would be a mistake worth catching. happy-dom installs the
// real globals at runtime, so what is named here is only the surface this file touches.
interface El {
  innerHTML: string;
  textContent: string | null;
  hidden: boolean;
  open: boolean;
  href: string;
  className: string;
  dataset: Record<string, string | undefined>;
  classList: { contains(name: string): boolean };
  click(): void;
  dispatchEvent(event: unknown): boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El> & { length: number };
}
declare const document: El & { documentElement: El };

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const DAY = 86_400_000;
// The real clock, deliberately. The browser's pass reads Date.now() — it has no pinned
// instant to be handed, and that is the whole point of it — so a fixture dated against
// a frozen NOW would be testing the server's cut a second time rather than the
// browser's. Every instant below is therefore an offset from this moment, and every
// assertion holds on any weekday and in any timezone.
const NOW = Date.now();

/** An instant at a wall-clock time on one of the reader's own days, which is the thing
 *  UTC cannot express and the reason this pass exists. */
function localTime(daysAgo: number, hours: number, minutes: number): number {
  const d = new Date(NOW - daysAgo * DAY);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

function group(bundles: { slug: string; at: number; versions?: number[] }[]): LedgerGroup[] {
  return [
    {
      wsId: "ws_7g2kq4xbvm",
      name: "Crystal Palace",
      visibility: "private",
      bundles: bundles.map((b) => ({
        slug: b.slug,
        latestVersion: b.versions?.[0] ?? 1,
        updatedAt: b.at,
        versions: b.versions ?? [1],
      })),
    },
  ];
}

/** Render, drop into the document, and run the page's own scripts — which is the only
 *  honest way to test them, since they are shipped as text inside the page. Returns the
 *  server's HTML, so a test can ask what the UTC cut did before the browser redid it. */
function render(groups: LedgerGroup[], now: number): string {
  const html = bundlesPage(
    {
      email: "me@example.com",
      workspaces: [{ id: "ws_7g2kq4xbvm", name: "Crystal Palace" }],
      current: null,
      section: "bundles",
    },
    groups,
    now,
  );
  document.documentElement.innerHTML = html;
  for (const script of [...document.querySelectorAll("script")]) {
    if (!script.textContent?.includes("data-ledger-group")) continue;
    new Function(script.textContent)();
  }
  return html;
}

/** Which section the server put a slug in, read off its HTML: the nearest section
 *  opened before the row. */
function serverSectionOf(html: string, slug: string): string {
  const row = html.indexOf(`data-slug="${slug}"`);
  expect(row).toBeGreaterThan(-1);
  const opened = html.lastIndexOf('data-section="', row);
  return html.slice(opened + 'data-section="'.length, html.indexOf('"', opened + 15));
}

/** The slugs a section holds, in the order it holds them. */
function slugsIn(key: string): string[] {
  const rows = document.querySelectorAll(`[data-section="${key}"] [data-section-rows] tr`);
  return [...rows].map((r) => r.querySelector(".slug a")!.textContent!);
}

function countOf(key: string): string {
  return document.querySelector(`[data-section="${key}"] [data-section-count]`)!.textContent!;
}

function hiddenOf(key: string): boolean {
  return document.querySelector(`[data-section="${key}"]`)!.hidden;
}

describe("the ledger's client-side re-dating", () => {
  test("it runs without throwing and leaves every row somewhere", () => {
    render(
      group([
        { slug: "fresh", at: NOW },
        { slug: "last-night", at: NOW - DAY },
        { slug: "monday", at: NOW - 2 * DAY },
        { slug: "sunday", at: NOW - 3 * DAY },
        { slug: "ancient", at: NOW - 40 * DAY },
      ]),
      NOW,
    );
    const placed = [...document.querySelectorAll("[data-section-rows] tr")].length;
    expect(placed).toBe(5);
    // Nothing stranded outside a section, which is what a thrown exception mid-pass
    // would look like.
    expect(document.querySelectorAll("tr[data-at]").length).toBe(5);
  });

  test("counts and folds follow the rows, and an emptied section hides itself", () => {
    render(
      group([
        { slug: "a", at: NOW },
        { slug: "b", at: NOW },
        { slug: "old", at: NOW - 40 * DAY },
      ]),
      NOW,
    );
    expect(countOf("today")).toBe("2");
    expect(countOf("older")).toBe("1");
    expect(hiddenOf("today")).toBe(false);
    expect(hiddenOf("this-week")).toBe(true);
    expect(hiddenOf("yesterday")).toBe(true);
    // Older stays folded; it is the one that grows without bound.
    expect(document.querySelector('[data-section="older"]')!.open).toBe(false);
    expect(document.querySelector('[data-section="today"]')!.open).toBe(true);
  });

  test("every section stays newest-first, however many rows moved into it", () => {
    // Instants an hour apart across two UTC days: whichever way the reader's offset
    // runs, some of these cross a local midnight and land in a different section than
    // the server put them in. The order inside each section must survive that.
    const bundles = Array.from({ length: 30 }, (_, i) => ({
      slug: `b${String(i).padStart(2, "0")}`,
      at: NOW - i * 3_600_000,
    }));
    render(group(bundles), NOW);

    const seen: number[] = [];
    for (const key of ["today", "yesterday", "this-week", "last-week", "older"]) {
      const ats = [...document.querySelectorAll(`[data-section="${key}"] tr[data-at]`)].map((r) =>
        Number(r.dataset.at),
      );
      // Descending within the section...
      expect(ats).toEqual([...ats].sort((a, b) => b - a));
      seen.push(...ats);
    }
    // ...and descending across the sections, which are drawn newest-first.
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    expect(seen.length).toBe(30);
  });

  test("stamps are rewritten from UTC into the reader's own clock", () => {
    const at = localTime(1, 22, 30);
    render(group([{ slug: "late", at }]), NOW);
    const time = document.querySelector("time")!;
    // The machine-readable value is the instant and never moves; the printed one is
    // local, so it matches what this process's own clock would say.
    expect(time.getAttribute("datetime")).toBe(new Date(at).toISOString());
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(time.textContent).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
  });

  test("a minute past the reader's midnight reads as today, not as yesterday", () => {
    // The case that made this worth doing at all: east of UTC, 00:01 local is still
    // yesterday by the server's cut, and it is the small hours of today to the person
    // who made the thing.
    render(group([{ slug: "one-past-midnight", at: localTime(0, 0, 1) }]), NOW);
    expect(slugsIn("today")).toEqual(["one-past-midnight"]);
    expect(countOf("today")).toBe("1");
    expect(hiddenOf("yesterday")).toBe(true);
  });

  test("the last minute of the reader's yesterday reads as yesterday", () => {
    // And the mirror of it: west of UTC, 23:59 local is already today by the server's
    // cut, and it is last night to the reader.
    render(group([{ slug: "just-before-midnight", at: localTime(1, 23, 59) }]), NOW);
    expect(slugsIn("yesterday")).toEqual(["just-before-midnight"]);
    expect(slugsIn("today")).toEqual([]);
    expect(countOf("yesterday")).toBe("1");
  });
});

// ---- the row menu, and the version history it takes over from the row ----

describe("the row menu's version list", () => {
  const versions = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  /** Open the menu by clicking something, and read back the versions it drew. */
  function openVia(selector: string): { text: string[]; hrefs: string[] } {
    document.querySelector(selector)!.click();
    const links = [...document.querySelectorAll("[data-versions-list] a")];
    return {
      text: links.map((a) => a.textContent!),
      hrefs: links.map((a) => a.href),
    };
  }

  test("the menu holds every version, not only the five the row printed", () => {
    render(group([{ slug: "many", at: NOW, versions }]), NOW);
    // The row itself printed five and a "+7".
    expect(document.querySelectorAll(".history a").length).toBe(5);
    expect(document.querySelector("[data-menu-more]")!.textContent).toBe("+7");

    const drawn = openVia("[data-menu-open]");
    expect(drawn.text).toEqual(versions.map((v) => `v${v}`));
    expect(document.querySelector("[data-versions-count]")!.textContent).toBe("12");
    // Each one links at its own pinned URL, under the bundle it belongs to.
    expect(drawn.hrefs.every((h) => h.includes("/ws_7g2kq4xbvm/b/many/v/"))).toBe(true);
    expect(drawn.hrefs[0]!.endsWith("/ws_7g2kq4xbvm/b/many/v/12/")).toBe(true);
    expect(drawn.hrefs.at(-1)!.endsWith("/ws_7g2kq4xbvm/b/many/v/1/")).toBe(true);
    // Only the newest is marked as such.
    const marked = [...document.querySelectorAll("[data-versions-list] a")].filter((a) =>
      a.classList.contains("latest"),
    );
    expect(marked.length).toBe(1);
    expect(marked[0]!.textContent).toBe("v12");
  });

  test("the row's +N opens the same menu the row's own button does", () => {
    render(group([{ slug: "many", at: NOW, versions }]), NOW);
    const viaMore = openVia("[data-menu-more]");
    expect(viaMore.text).toEqual(versions.map((v) => `v${v}`));
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(false);
    expect(document.querySelector("[data-menu-title]")!.textContent).toBe("many");
    // One panel, so the row's own button reports it as the open one.
    expect(document.querySelector("[data-menu-open]")!.getAttribute("aria-expanded")).toBe("true");
  });

  test("the menu is refilled for whichever row asked for it", () => {
    render(
      group([
        { slug: "many", at: NOW, versions },
        { slug: "one", at: NOW - 1000, versions: [1] },
      ]),
      NOW,
    );
    const buttons = [...document.querySelectorAll("[data-menu-open]")];
    buttons[0]!.click();
    expect(document.querySelectorAll("[data-versions-list] a").length).toBe(12);
    // Clicking a different row's button moves the one panel rather than opening a second.
    buttons[1]!.click();
    expect(document.querySelector("[data-menu-title]")!.textContent).toBe("one");
    expect(document.querySelectorAll("[data-versions-list] a").length).toBe(1);
    expect(document.querySelectorAll("[data-rowmenu]").length).toBe(1);
  });

  test("scrolling the version list does not close the menu; scrolling the page does", () => {
    // The menu shuts on scroll so it cannot end up floating beside a row that has moved
    // on. That listener captures, so it also sees scrolls from inside the menu — and a
    // long version list is exactly the thing a reader scrolls. On a phone that made the
    // list unreadable: one swipe and the panel was gone.
    render(group([{ slug: "many", at: NOW, versions }]), NOW);
    document.querySelector("[data-menu-open]")!.click();
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(false);

    const scroll = () => new Event("scroll", { bubbles: true });
    document.querySelector("[data-versions-list]")!.dispatchEvent(scroll());
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(false);
    document.querySelector("[data-rowmenu]")!.dispatchEvent(scroll());
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(false);

    // Anything outside it still shuts the menu, which is the behaviour being preserved.
    document.querySelector(".ledger")!.dispatchEvent(scroll());
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(true);
  });

  test("clicking the open row's own button again closes the menu", () => {
    render(group([{ slug: "many", at: NOW, versions }]), NOW);
    const button = document.querySelector("[data-menu-open]")!;
    button.click();
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(false);
    button.click();
    expect(document.querySelector("[data-rowmenu]")!.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});

// ---- and it is the reader's timezone, not this machine's ----
//
// The two tests above pass on a machine already in UTC without proving anything: the
// two cuts agree there. So the clock is moved to either edge of the world and the same
// questions asked, with the server's own answer read off the HTML to show the browser
// actually overruled it.

describe("the reader's own timezone decides", () => {
  const host = process.env.TZ;
  afterAll(() => {
    if (host === undefined) delete process.env.TZ;
    else process.env.TZ = host;
  });

  // +14 and -11: the far edges, where local midnight is most of a day away from UTC's.
  for (const zone of ["Pacific/Kiritimati", "Pacific/Niue", "UTC"]) {
    test(`the reader's own day is what gets counted in ${zone}`, () => {
      process.env.TZ = zone;
      const html = render(
        group([
          { slug: "past-midnight", at: localTime(0, 0, 1) },
          { slug: "before-midnight", at: localTime(1, 23, 59) },
          // Both ends of the reader's yesterday. At either edge of the world at least
          // one of these falls on a different UTC date than local date, whatever hour
          // the suite runs at — which is what makes the check below non-vacuous.
          { slug: "yesterday-opened", at: localTime(1, 0, 1) },
          { slug: "yesterday-closed", at: localTime(1, 23, 58) },
        ]),
        NOW,
      );
      expect(slugsIn("today")).toEqual(["past-midnight"]);
      expect(slugsIn("yesterday")).toEqual([
        "before-midnight",
        "yesterday-closed",
        "yesterday-opened",
      ]);

      // In UTC the two cuts agree and there is nothing to overrule; anywhere else the
      // browser had to move at least one row. Asserted so this cannot quietly become a
      // tautology on a machine that happens to run UTC.
      const yesterdays = ["yesterday-opened", "yesterday-closed"];
      const misplaced = yesterdays.filter((s) => serverSectionOf(html, s) !== "yesterday");
      if (zone === "UTC") expect(misplaced).toEqual([]);
      else expect(misplaced.length).toBeGreaterThan(0);
    });
  }
});
