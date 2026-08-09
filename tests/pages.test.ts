import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// Env is set by tests/setup.ts (preload) before these app modules import.
import { config } from "../src/config";
import {
  bundlesPage,
  bucketFor,
  utcDay,
  landingPage,
  settingsPage,
  githubClaimPage,
  invitePage,
  noSeatPage,
  type LedgerBundle,
  type LedgerGroup,
  type SettingsData,
  type InviteData,
} from "../src/pages";
import { startServer } from "../src/server";
import { legacyWorkspaceId } from "../src/db";

// ---- reusable fixtures ----

function settings(over: Partial<SettingsData> = {}): SettingsData {
  return {
    wsId: "ws_7g2kq4xbvm",
    name: "Crystal Palace",
    visibility: "private",
    email: "kristoffer.remback@gmail.com",
    members: [
      { email: "kristoffer.remback@gmail.com", id: "usr_x7k2m9q4bd", joined: "2026-06-02", isYou: true },
      { email: "pierre@example.com", id: "usr_4n8rp2wcfd", joined: "2026-07-19", isYou: false },
    ],
    keys: [
      { id: "key_aaaaaaaaaa", name: "macbook agent", hint: "seer_sk_9f3K····sD2e", created: "2026-07-18", lastUsed: "3 min ago", isLegacy: false },
      { id: "key_bbbbbbbbbb", name: "imported from env", hint: "(pre-workspace key)", created: "2026-06-02", lastUsed: "2 days ago", isLegacy: true },
    ],
    installations: [],
    credentials: [],
    githubInstallUrl: "https://github.com/apps/seer-overseer-test/installations/new",
    githubUserOAuthEnabled: true,
    shares: [
      {
        id: "shr_2n7kq4xbvm",
        label: "for Anna",
        kind: "review",
        target: "gate-rewrite",
        created: "2026-07-20",
        expires: "never",
        isExpired: false,
      },
    ],
    ...over,
  };
}

// The connect button is the only thing the second GitHub application buys, so a
// deployment without one must show the paste form standing alone rather than a button
// leading to an authorize URL with no client_id.
describe("settings personal credentials", () => {
  test("with the OAuth application configured, the connect posts to the connect route", () => {
    expect(settingsPage(settings())).toContain('action="/github/account/connect"');
  });

  test("without it, nothing offers the connect", () => {
    const html = settingsPage(settings({ githubUserOAuthEnabled: false }));
    expect(html).not.toContain("/github/account/connect");
    expect(html).not.toContain("Connect GitHub account");
    expect(html).toContain("Add fine-grained token");
  });
});

// ---- settings: the GitHub panel ----

describe("settings github panel", () => {
  const held = {
    id: "ghi_2n7kq4xbvm",
    installationId: 111,
    account: "threahq",
    accountType: "Organization",
    repositorySelection: "all",
    connected: "2026-08-01",
    isSuspended: false,
    lastDelivery: "3 minutes ago",
    isQuiet: false,
  };

  test("a connected installation is listed with a way to disconnect it", () => {
    const html = settingsPage(settings({ installations: [held] }));
    expect(html).toContain("threahq");
    expect(html).toContain("/settings/ws_7g2kq4xbvm/github/ghi_2n7kq4xbvm/disconnect");
    expect(html).toContain("/settings/ws_7g2kq4xbvm/github/connect");
  });

  test("with nothing connected the panel says so and still offers the connect", () => {
    const html = settingsPage(settings({ installations: [] }));
    expect(html).toContain("No GitHub account connected yet.");
    expect(html).toContain("/settings/ws_7g2kq4xbvm/github/connect");
  });

  test("a suspended installation says so rather than looking healthy", () => {
    const html = settingsPage(settings({ installations: [{ ...held, isSuspended: true }] }));
    expect(html).toContain("suspended");
  });

  // Delivery health is the point of the panel now that nothing polls: an installation
  // that stopped talking has to say so here, because nowhere else would.
  test("a healthy installation states when it was last heard from, and is not called quiet", () => {
    const html = settingsPage(settings({ installations: [held] }));
    expect(html).toContain("3 minutes ago");
    expect(html).not.toContain("no recent deliveries");
  });

  test("an installation that has gone quiet says so without being asked", () => {
    const html = settingsPage(
      settings({ installations: [{ ...held, lastDelivery: "14 days ago", isQuiet: true }] }),
    );
    expect(html).toContain("14 days ago");
    expect(html).toContain("no recent deliveries");
  });

  test("an installation that has never delivered says never", () => {
    const html = settingsPage(
      settings({ installations: [{ ...held, lastDelivery: "never", isQuiet: true }] }),
    );
    expect(html).toContain("never");
    expect(html).toContain("no recent deliveries");
  });

  // There is no "not configured" state to render: config.ts requires all six App
  // variables at boot. The panel therefore always offers both doors, and the one that
  // used to be conditional — install first, then connect — is the one a fresh account
  // needs, so its absence would be the failure.
  test("the panel offers connecting and, for a fresh account, installing first", () => {
    const html = settingsPage(settings({ installations: [] }));
    expect(html).toContain("/github/connect");
    expect(html).toContain("https://github.com/apps/seer-overseer-test/installations/new");
  });

  // A credential that stopped working is invisible unless the page says so, and the two
  // ways it stops have different remedies, so one word for both would send half the
  // readers to the wrong place.
  test("each credential's state is named, and a working one is left alone", () => {
    const base = { account: "alice", kind: "pat" as const, lastUsed: "3 minutes ago" };
    const html = settingsPage(
      settings({
        credentials: [
          { ...base, id: "guc_live", label: "work", isDead: false, isExpired: false },
          { ...base, id: "guc_dead", label: "old laptop", isDead: true, isExpired: false },
          { ...base, id: "guc_gone", label: "temporary", isDead: true, isExpired: true },
        ],
      }),
    );
    expect(html).toContain("revoked at GitHub — reconnect");
    expect(html).toContain("expired");

    const live = html.split("guc_live")[0]!.split("<tr>").pop()!;
    expect(live).not.toContain("revoked at GitHub");
    expect(live).not.toContain("expired");
  });
});

// ---- the claim page ----

describe("github claim page", () => {
  const choice = {
    installationId: 111,
    account: "threahq",
    accountType: "Organization",
    repositorySelection: "all",
    held: false,
  };

  test("the picker carries the one-time handle and the ids it may attach", () => {
    const html = githubClaimPage({
      wsId: "ws_7g2kq4xbvm",
      headline: "Choose what to connect",
      note: "n",
      login: "kristofferremback",
      claimToken: "seer_gha_abc",
      choices: [choice],
    });
    expect(html).toContain('name="claim" value="seer_gha_abc"');
    expect(html).toContain('value="111"');
    expect(html).toContain('action="/github/claim"');
  });

  test("a refusal carries no form at all, so it cannot write", () => {
    const html = githubClaimPage({
      wsId: "ws_7g2kq4xbvm",
      headline: "That installation is not yours to connect",
      note: "n",
      login: null,
      claimToken: null,
      choices: [],
    });
    expect(html).not.toContain('action="/github/claim"');
    expect(html).not.toContain('name="claim"');
  });
});

// ---- settings: one-time reveal presence rules ----

describe("settings reveal presence", () => {
  test("no reveal box when no reveal is passed (a plain load)", () => {
    const html = settingsPage(settings());
    expect(html).not.toContain('class="reveal"');
    expect(html).not.toContain("shown once");
    expect(html).not.toContain("single use");
  });

  test("key reveal renders the token once, with only the key note", () => {
    const token = "seer_sk_9f3KJq0v0Zr1yWmPnQ7TuXbA4cL8sD2e";
    const html = settingsPage(settings({ reveal: { kind: "key", token } }));
    expect(html).toContain('class="reveal"');
    expect(html).toContain(token);
    expect(html).toContain("shown once");
    expect(html).not.toContain("single use"); // invite note must not appear
  });

  test("invite reveal renders the URL once, with only the invite note", () => {
    const url = "http://localhost:3000/invite/inv_9k2mq7x4tv";
    const html = settingsPage(settings({ reveal: { kind: "invite", url, expires: "2026-07-25" } }));
    expect(html).toContain('class="reveal"');
    expect(html).toContain(url);
    expect(html).toContain("single use");
    expect(html).toContain("expires 2026-07-25");
    expect(html).not.toContain("shown once"); // key note must not appear
  });
});

// ---- settings: legacy pill + affordances + escaping ----

describe("settings markers", () => {
  test("legacy key gets the legacy pill; a normal key does not", () => {
    const html = settingsPage(settings());
    expect(html).toContain('imported from env <span class="pill">legacy</span>');
    // The non-legacy key name is present without a trailing legacy pill.
    expect(html).toContain("macbook agent</td>");
  });

  test("visibility pill carries the public modifier only when public", () => {
    expect(settingsPage(settings({ visibility: "public" }))).toContain('class="pill public"');
    expect(settingsPage(settings({ visibility: "private" }))).not.toContain('class="pill public"');
  });

  test("roll/revoke forms post to the owning key's endpoints", () => {
    const html = settingsPage(settings());
    expect(html).toContain('action="/settings/ws_7g2kq4xbvm/keys/key_aaaaaaaaaa/roll"');
    expect(html).toContain('action="/settings/ws_7g2kq4xbvm/keys/key_aaaaaaaaaa/revoke"');
    expect(html).toContain('action="/settings/ws_7g2kq4xbvm/invites"');
    expect(html).toContain('action="/settings/ws_7g2kq4xbvm/keys"');
  });

  test("a share is listed with what it is, and with a way to revoke it", () => {
    const html = settingsPage(settings());
    expect(html).toContain("<p class=\"eyebrow\">Shares</p>");
    expect(html).toContain("for Anna");
    expect(html).toContain("gate-rewrite");
    expect(html).toContain("2026-07-20");
    expect(html).toContain("never");
    expect(html).toContain('action="/settings/ws_7g2kq4xbvm/shares/shr_2n7kq4xbvm/revoke"');
  });

  test("an expired share says so; a live one does not", () => {
    const live = settings().shares[0]!;
    expect(settingsPage(settings())).not.toContain('<span class="pill">expired</span>');
    const html = settingsPage(
      settings({ shares: [{ ...live, expires: "2026-07-01", isExpired: true }] }),
    );
    expect(html).toContain('<span class="pill">expired</span>');
  });

  test("a workspace with no shares says so and still draws the panel", () => {
    const html = settingsPage(settings({ shares: [] }));
    expect(html).toContain("<p class=\"eyebrow\">Shares</p>");
    expect(html).toContain("Nothing shared yet.");
    expect(html).not.toContain("/shares/shr_");
  });

  test("a share's label is html-escaped", () => {
    const html = settingsPage(
      settings({
        shares: [
          {
            id: "shr_dddddddddd",
            label: "<b>anna</b>",
            kind: "review",
            target: "gate-rewrite",
            created: "2026-07-20",
            expires: "never",
            isExpired: false,
          },
        ],
      }),
    );
    expect(html).toContain("&lt;b&gt;anna&lt;/b&gt;");
    expect(html).not.toContain("<b>anna</b>");
  });

  test("workspace name and key name are html-escaped", () => {
    const html = settingsPage(
      settings({
        name: '<script>alert(1)</script>',
        keys: [{ id: "key_cccccccccc", name: "<b>x</b>", hint: "h", created: "c", lastUsed: "l", isLegacy: false }],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

// ---- bundles: grouping + new-workspace affordance ----

// A Wednesday, so that "this week" (Monday the 3rd onward) and "last week" are both
// reachable and distinguishable from yesterday. Every offset below is days back from it.
const NOW = Date.parse("2026-08-05T09:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => NOW - n * DAY;

function groups(): LedgerGroup[] {
  return [
    {
      wsId: "ws_7g2kq4xbvm",
      name: "Crystal Palace",
      visibility: "private",
      bundles: [
        { slug: "onboarding-report", latestVersion: 3, updatedAt: daysAgo(18), versions: [3, 2, 1] },
      ],
    },
    {
      wsId: "ws_4n8rp2wcfd",
      name: "Pierre's bench",
      visibility: "public",
      bundles: [{ slug: "recipe-box", latestVersion: 2, updatedAt: daysAgo(19), versions: [2, 1] }],
    },
  ];
}

describe("bundles grouping", () => {
  test("one group head per workspace: name, ws id, visibility pill, settings link", () => {
    const html = bundlesPage("kristoffer.remback@gmail.com", groups(), NOW);
    expect(html).toContain("<h2>Crystal Palace</h2>");
    expect(html).toContain("<h2>Pierre's bench</h2>"); // escapeHtml leaves apostrophes alone
    expect(html).toContain("ws_7g2kq4xbvm");
    expect(html).toContain("ws_4n8rp2wcfd");
    // Private group: bare pill; public group: pill with the public modifier.
    expect(html).toContain('class="pill"><span class="bead"></span>private');
    expect(html).toContain('class="pill public"><span class="bead"></span>public');
    expect(html).toContain('href="/settings/ws_7g2kq4xbvm"');
    expect(html).toContain('href="/settings/ws_4n8rp2wcfd"');
  });

  test("bundle and history URLs are workspace-scoped", () => {
    const html = bundlesPage("me@example.com", groups(), NOW);
    expect(html).toContain('href="/ws_7g2kq4xbvm/b/onboarding-report/"');
    expect(html).toContain('href="/ws_7g2kq4xbvm/b/onboarding-report/v/3/"');
    expect(html).toContain('href="/ws_4n8rp2wcfd/b/recipe-box/v/1/"');
  });

  test("a New workspace button posts to /workspaces", () => {
    const html = bundlesPage("me@example.com", groups(), NOW);
    expect(html).toContain('action="/workspaces"');
    expect(html).toContain("New workspace");
  });

  test("a workspace with no bundles still gets its head and an empty note", () => {
    const html = bundlesPage(
      "me@example.com",
      [{ wsId: "ws_0000000000", name: "Empty", visibility: "public", bundles: [] }],
      NOW,
    );
    expect(html).toContain("<h2>Empty</h2>");
    expect(html).toContain("No bundles here yet");
    // No bundles means no sections at all, not five empty ones.
    expect(html).not.toContain(`<details class="ledger-section"`);
  });
});

// ---- bundles: the recency sections ----

/** One workspace holding one bundle per bucket, plus a second bundle sharing "today"
 *  so a count of more than one is exercised. */
function dated(): LedgerGroup[] {
  const at = (slug: string, days: number): LedgerBundle => ({
    slug,
    latestVersion: 1,
    updatedAt: daysAgo(days),
    versions: [1],
  });
  return [
    {
      wsId: "ws_7g2kq4xbvm",
      name: "Crystal Palace",
      visibility: "private",
      bundles: [
        at("fresh", 0),
        at("also-fresh", 0),
        at("last-night", 1),
        at("monday", 2),
        at("sunday", 3),
        at("ancient", 10),
      ],
    },
  ];
}

/** The section element for one bucket, from `<details` to its closing tag. */
function sectionOf(html: string, key: string): string {
  const start = html.indexOf(`<details class="ledger-section" data-section="${key}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</details>", start);
  return html.slice(start, end);
}

describe("bundles recency sections", () => {
  test("bucketFor cuts days into the five sections, with the future reading as today", () => {
    const today = utcDay(NOW);
    expect(bucketFor(today, today)).toBe("today");
    expect(bucketFor(today + 3, today)).toBe("today"); // a clock ahead of this one
    expect(bucketFor(today - 1, today)).toBe("yesterday");
    expect(bucketFor(today - 2, today)).toBe("this-week"); // Monday the 3rd
    expect(bucketFor(today - 3, today)).toBe("last-week"); // Sunday the 2nd
    expect(bucketFor(today - 9, today)).toBe("last-week"); // Monday the 27th, the edge
    expect(bucketFor(today - 10, today)).toBe("older");
  });

  test("every bucket is drawn in one order, and each row lands in its own", () => {
    const html = bundlesPage("me@example.com", dated(), NOW);
    const order = ["today", "yesterday", "this-week", "last-week", "older"];
    let at = -1;
    for (const key of order) {
      const next = html.indexOf(`data-section="${key}"`);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(sectionOf(html, "today")).toContain(">fresh<");
    expect(sectionOf(html, "today")).toContain(">also-fresh<");
    expect(sectionOf(html, "yesterday")).toContain(">last-night<");
    expect(sectionOf(html, "this-week")).toContain(">monday<");
    expect(sectionOf(html, "last-week")).toContain(">sunday<");
    expect(sectionOf(html, "older")).toContain(">ancient<");
  });

  test("each head carries its own count", () => {
    const html = bundlesPage("me@example.com", dated(), NOW);
    expect(sectionOf(html, "today")).toContain(">Today</span><span class=\"section-count\" data-section-count>2<");
    expect(sectionOf(html, "yesterday")).toContain(">Yesterday</span><span class=\"section-count\" data-section-count>1<");
    expect(sectionOf(html, "older")).toContain(">Older</span><span class=\"section-count\" data-section-count>1<");
  });

  test("Older ships folded and the rest open; an empty bucket is hidden, not dropped", () => {
    const html = bundlesPage("me@example.com", dated(), NOW);
    expect(sectionOf(html, "today").startsWith('<details class="ledger-section" data-section="today" open')).toBe(true);
    expect(sectionOf(html, "older")).not.toContain(" open");

    // One bundle, one occupied bucket: the other four are still there for the browser
    // to move rows into when it re-dates them locally.
    const one = bundlesPage(
      "me@example.com",
      [{ wsId: "ws_7g2kq4xbvm", name: "One", visibility: "public", bundles: [
        { slug: "solo", latestVersion: 1, updatedAt: daysAgo(0), versions: [1] },
      ] }],
      NOW,
    );
    expect(sectionOf(one, "yesterday")).toContain(" hidden");
    expect(sectionOf(one, "today")).not.toContain(" hidden");
  });

  test("the browser's copy of the rule agrees with the server's, day for day", () => {
    // The sections are cut twice: on the server in UTC, so a scriptless page is still
    // sectioned, and again in the browser in the reader's own timezone, which is the
    // one that decides what "today" means for someone working past midnight. The rule
    // is therefore written twice, and this is what stops the two from drifting: the
    // browser's copy is lifted out of the page it was emitted into and asked the same
    // questions the server's answers.
    const html = bundlesPage("me@example.com", dated(), NOW);
    const opens = "const bucket = (day, today) => {";
    const closes = "\n  };";
    const start = html.indexOf(opens);
    expect(start).toBeGreaterThan(-1);
    const src = html.slice(start, html.indexOf(closes, start) + closes.length);
    const inBrowser = new Function(`${src} return bucket;`)() as (d: number, t: number) => string;

    const server: string[] = [];
    const browser: string[] = [];
    // Every weekday as "today" — the Monday boundary is the part that could drift —
    // and a year of history behind each, plus a few days of clock skew ahead.
    for (let today = utcDay(NOW); today < utcDay(NOW) + 7; today++) {
      for (let day = today - 370; day <= today + 3; day++) {
        server.push(bucketFor(day, today));
        browser.push(inBrowser(day, today));
      }
    }
    expect(browser).toEqual(server);
    expect(new Set(server).size).toBe(5); // all five reached, or the sweep proved nothing
  });

  test("a row carries the raw instant and a machine-readable stamp beside the printed one", () => {
    const html = bundlesPage("me@example.com", dated(), NOW);
    expect(html).toContain(`data-at="${daysAgo(0)}"`);
    expect(html).toContain(`<time datetime="${new Date(daysAgo(1)).toISOString()}">2026-08-04 09:00</time>`);
  });
});

// ---- bundles: the row menu, which is where a bundle is shared ----

describe("the bundle row menu", () => {
  test("every row gets a menu button naming its workspace, slug and URL", () => {
    const html = bundlesPage("me@example.com", groups(), NOW);
    expect(html).toContain('data-ws="ws_7g2kq4xbvm" data-slug="onboarding-report" data-url="/ws_7g2kq4xbvm/b/onboarding-report/"');
    expect(html).toContain('aria-label="Actions for recipe-box"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("one popover serves the page, and it mints bundle shares", () => {
    const html = bundlesPage("me@example.com", groups(), NOW);
    expect(html.split('<div class="rowmenu"').length - 1).toBe(1);
    expect(html).toContain("data-share-new");
    expect(html).toContain("data-share-list");
    expect(html).toContain("/api/shares");
    expect(html).toContain(`kind: 'bundle'`);
    // The link is shown once because only its hash survives; the page says so.
    expect(html).toContain("cannot be shown again");
  });

  test("a short history prints in full and asks for no overflow", () => {
    const html = bundlesPage(
      "me@example.com",
      [{ wsId: "ws_7g2kq4xbvm", name: "Five", visibility: "public", bundles: [
        { slug: "five", latestVersion: 5, updatedAt: daysAgo(0), versions: [5, 4, 3, 2, 1] },
      ] }],
      NOW,
    );
    for (const v of [5, 4, 3, 2, 1]) {
      expect(html).toContain(`href="/ws_7g2kq4xbvm/b/five/v/${v}/">v${v}</a>`);
    }
    expect(html).not.toContain(`class="more-versions"`);
  });

  test("a long history prints its head and hands the tail to the menu", () => {
    const versions = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const html = bundlesPage(
      "me@example.com",
      [{ wsId: "ws_7g2kq4xbvm", name: "Many", visibility: "public", bundles: [
        { slug: "many", latestVersion: 12, updatedAt: daysAgo(0), versions },
      ] }],
      NOW,
    );
    // The five newest, inline.
    for (const v of [12, 11, 10, 9, 8]) {
      expect(html).toContain(`href="/ws_7g2kq4xbvm/b/many/v/${v}/">v${v}</a>`);
    }
    // And not the rest — the row is a glance, not a paragraph.
    for (const v of [7, 6, 5, 4, 3, 2, 1]) {
      expect(html).not.toContain(`href="/ws_7g2kq4xbvm/b/many/v/${v}/">v${v}</a>`);
    }
    expect(html).toContain(`>+7</button>`);
    expect(html).toContain(`aria-label="All 12 versions of many"`);
    // The whole history still travels, as numbers rather than as markup: shorter than
    // the seven links it replaced, and the menu builds them back.
    expect(html).toContain(`data-versions="${versions.join(",")}"`);
  });

  test("no bundles, no menu button — but the popover markup is harmless either way", () => {
    const html = bundlesPage(
      "me@example.com",
      [{ wsId: "ws_0000000000", name: "Empty", visibility: "public", bundles: [] }],
      NOW,
    );
    expect(html).not.toContain(`class="menu-btn"`);
  });
});

// ---- invite: signed-in vs signed-out affordances ----

function invite(over: Partial<InviteData> = {}): InviteData {
  return {
    token: "inv_9k2mq7x4tv",
    workspaceName: "Crystal Palace",
    inviterEmail: "kristoffer.remback@gmail.com",
    expires: "2026-07-25",
    signedIn: false,
    ...over,
  };
}

describe("invite affordances", () => {
  test("signed-out viewer gets a Google sign-in carrying the invite as next", () => {
    const html = invitePage(invite({ signedIn: false }));
    expect(html).toContain('href="/login?next=/invite/inv_9k2mq7x4tv"');
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('action="/invite/inv_9k2mq7x4tv/accept"');
  });

  test("signed-in viewer gets a one-click accept POST", () => {
    const html = invitePage(invite({ signedIn: true }));
    expect(html).toContain('action="/invite/inv_9k2mq7x4tv/accept"');
    expect(html).toContain("Take your seat");
    expect(html).not.toContain("Sign in with Google");
  });

  test("workspace name, inviter, and expiry are shown and escaped", () => {
    const html = invitePage(invite({ workspaceName: "<x>", inviterEmail: "a@b.co" }));
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("a@b.co");
    expect(html).toContain("2026-07-25");
  });
});

// ---- no-seat 403 page (OIDC sign-in with no user and no valid invite) ----

describe("no-seat page", () => {
  test("carries the exact spec line, in the site's voice, with no sign-in affordance", () => {
    const html = noSeatPage("stranger@example.com");
    // The exact message must survive contiguously (the plain-text 403 it replaced).
    expect(html).toContain("This account has no seat at Seer.");
    expect(html).toContain("403");
    // The viewer just authenticated — no point offering another sign-in round-trip.
    expect(html).not.toContain("/login?next=");
    // Site register: the paper shell and mark, not a bare string.
    expect(html).toContain("void-mark");
  });

  test("shows the signed-in email (escaped) when present, omits it otherwise", () => {
    expect(noSeatPage("a@b.co")).toContain("a@b.co");
    // A hostile email is escaped: the raw attack sequence never appears verbatim.
    const escaped = noSeatPage('"><script>alert(1)</script>');
    expect(escaped).not.toContain('"><script>alert(1)');
    expect(escaped).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // A null email still renders without leaking an "undefined".
    expect(noSeatPage(null)).not.toContain("undefined");
  });
});

// ---- the reveal-only-on-mint invariant, over HTTP ----
//
// A plain GET of the settings page (AUTH_DISABLED → root member) must never carry a
// reveal box: only the token's hash survives in the db, so a token shown on the mint
// POST can never reappear on a later load.

describe("reveal never survives to a plain GET", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let rootWs: string;

  beforeAll(async () => {
    server = await startServer();
    base = `http://localhost:${server.port}`;
    rootWs = legacyWorkspaceId()!;
  });
  afterAll(() => server.stop(true));

  test("GET /settings/<ws> has no reveal box, even right after a mint", async () => {
    // Mint a key: the POST response reveals it once.
    const minted = await fetch(`${base}/settings/${rootWs}/keys`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=probe",
      redirect: "manual",
    });
    expect(await minted.text()).toContain("shown once");

    // A subsequent GET of the same page carries no reveal.
    const page = await fetch(`${base}/settings/${rootWs}`);
    const html = await page.text();
    expect(html).not.toContain('class="reveal"');
    expect(html).not.toContain("shown once");
  });
});

test("the landing page says the deployment reads pull requests, and where to start", () => {
  const html = landingPage(false);
  // Overseer was invisible on the front page while being half the deployment.
  expect(html).toContain("Overseer");
  expect(html).toContain("/overseer/agent.md");
  // The front door is what it points at, not a second copy of the instructions.
  expect(html).toContain(`${config.baseUrl}/skill.md`);
  expect(html).not.toContain("POST /api/reviews");
  // The two claims that make it different from a diff, in the reader's language.
  expect(html).toContain("instead of the diff");
  expect(html).toContain("did not write the change");
});
