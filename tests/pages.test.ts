import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// Env is set by tests/setup.ts (preload) before these app modules import.
import {
  bundlesPage,
  settingsPage,
  invitePage,
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
    ...over,
  };
}

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

function groups(): LedgerGroup[] {
  return [
    {
      wsId: "ws_7g2kq4xbvm",
      name: "Crystal Palace",
      visibility: "private",
      bundles: [
        { slug: "onboarding-report", latestVersion: 3, updated: "2026-07-18 09:41", versions: [3, 2, 1] },
      ],
    },
    {
      wsId: "ws_4n8rp2wcfd",
      name: "Pierre's bench",
      visibility: "public",
      bundles: [{ slug: "recipe-box", latestVersion: 2, updated: "2026-07-17 14:12", versions: [2, 1] }],
    },
  ];
}

describe("bundles grouping", () => {
  test("one group head per workspace: name, ws id, visibility pill, settings link", () => {
    const html = bundlesPage("kristoffer.remback@gmail.com", groups());
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
    const html = bundlesPage("me@example.com", groups());
    expect(html).toContain('href="/ws_7g2kq4xbvm/b/onboarding-report/"');
    expect(html).toContain('href="/ws_7g2kq4xbvm/b/onboarding-report/v/3/"');
    expect(html).toContain('href="/ws_4n8rp2wcfd/b/recipe-box/v/1/"');
  });

  test("a New workspace button posts to /workspaces", () => {
    const html = bundlesPage("me@example.com", groups());
    expect(html).toContain('action="/workspaces"');
    expect(html).toContain("New workspace");
  });

  test("a workspace with no bundles still gets its head and an empty note", () => {
    const html = bundlesPage("me@example.com", [
      { wsId: "ws_0000000000", name: "Empty", visibility: "public", bundles: [] },
    ]);
    expect(html).toContain("<h2>Empty</h2>");
    expect(html).toContain("No bundles here yet");
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

// ---- the reveal-only-on-mint invariant, over HTTP ----
//
// A plain GET of the settings page (AUTH_DISABLED → root member) must never carry a
// reveal box: only the token's hash survives in the db, so a token shown on the mint
// POST can never reappear on a later load.

describe("reveal never survives to a plain GET", () => {
  let server: ReturnType<typeof startServer>;
  let base: string;
  let rootWs: string;

  beforeAll(() => {
    server = startServer();
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
