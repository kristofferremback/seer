// Shares: the token, the link it opens, and everything the link is not.
//
// Env is set by tests/setup.ts (AUTH_DISABLED=true), so every request in this file
// arrives with the root user's session. That is exactly the shape the refusals have to
// survive, and it is why most of the fixtures live in a workspace the root user is NOT
// a member of: a signed-in stranger is the reader a share is aimed at, and the one
// documented exception (a member following a dead link) then has its own workspace to
// be tested in.

import { join } from "node:path";

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { zipSync, strToU8 } from "fflate";

import { startServer } from "../src/server";
import { config } from "../src/config";
import { createVersion, db, legacyWorkspaceId } from "../src/db";
import { tinyId, hashKey, newShareToken } from "../src/ids";
import { createAnnotation, createAttachment } from "../src/overseer/db";
import { saveAttachment, saveZip } from "../src/store";
import {
  createShare,
  listShares,
  lookupShare,
  resolveShare,
  revokeShare,
  SHARE_KINDS,
  SERVED_SHARE_KINDS,
} from "../src/shares";
import { renderReviewPage } from "../src/overseer/render";
import type { Evidence } from "../src/overseer/types";
import {
  goldenStoredDoc,
  storeGoldenReview,
} from "./overseer/fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

// The workspace the root user is not in: a share's reader is a stranger to it.
let wsOut: string;
// The bootstrap workspace, which the root user IS a member of.
let rootWs: string;
let rootUser: string;
let attachmentId: string;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  rootWs = legacyWorkspaceId()!;
  rootUser = db.query<{ id: string }, []>("SELECT id FROM users LIMIT 1").get()!
    .id;

  wsOut = tinyId("ws");
  db.run(
    "INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'private', ?)",
    [wsOut, "Outside", Date.now()],
  );
  storeGoldenReview(wsOut, "shared-review");
  storeGoldenReview(wsOut, "other-review");
  storeGoldenReview(rootWs, "own-review");

  // A question filed on the review, so "a shared page shows no annotations" is asked of
  // a review that has one.
  createAnnotation(
    wsOut,
    "shared-review",
    { type: "summary", id: "summary" },
    "Is the gate reachable?",
    1,
  );

  const bytes = new Uint8Array([137, 80, 78, 71]);
  attachmentId = createAttachment(
    wsOut,
    "shared-review",
    1,
    "image/png",
    bytes.length,
    "A shot",
    "",
  );
  await saveAttachment(wsOut, attachmentId, bytes);

  // Two versions of a bundle in the workspace the reader is a stranger to, one more in
  // the reader's own, and a sibling nothing points at.
  await publish(wsOut, "shared-bundle", "one");
  await publish(wsOut, "shared-bundle", "two");
  await publish(wsOut, "other-bundle", "not this one");
  await publish(rootWs, "own-bundle", "mine");
});

/** A bundle version, as an upload would leave it: a row, then its bytes. A nested asset
 *  and a subdirectory come with every one, because a bundle is a tree and the share
 *  route has to serve all of it, not just the page at the root. */
async function publish(wsId: string, slug: string, body: string): Promise<number> {
  const zip = zipSync({
    "index.html": strToU8(`<!doctype html><title>${slug}</title><body>${body}</body>`),
    "assets/app.css": strToU8(`/* ${body} */`),
    "deep/index.html": strToU8(`<!doctype html><body>deep ${body}</body>`),
  });
  const version = createVersion(wsId, slug, zip.length, 3);
  await saveZip(wsId, slug, version, zip);
  return version;
}

afterAll(() => {
  server.stop(true);
});

function mint(over: Partial<Parameters<typeof createShare>[0]> = {}) {
  return createShare({
    wsId: wsOut,
    kind: "review",
    target: "shared-review",
    label: "for Anna",
    userId: rootUser,
    expiresAt: null,
    ...over,
  });
}

/** Status, content type and body: "the same 404" has to mean the same response rather
 *  than the same status line. */
async function shape(res: Response): Promise<string> {
  return [res.status, res.headers.get("content-type"), await res.text()].join(
    "\n",
  );
}

// ---- storage ----

describe("share storage", () => {
  test("a token is minted once, stored hashed, and resolves to its row", () => {
    const { id, token } = mint({ label: "hashed at rest" });
    expect(token).toMatch(/^seer_sh_[A-Za-z0-9_-]{32}$/);

    const stored = db
      .query<{ token_hash: string }, [string]>(
        "SELECT token_hash FROM shares WHERE id = ?",
      )
      .get(id)!;
    expect(stored.token_hash).toBe(hashKey(token));
    expect(stored.token_hash).not.toContain(token);

    const live = resolveShare(token)!;
    expect(live.id).toBe(id);
    expect(live.workspace_id).toBe(wsOut);
    expect(live.kind).toBe("review");
    expect(live.target).toBe("shared-review");
    expect(live.label).toBe("hashed at rest");
  });

  test("resolveShare answers null for unknown, revoked and expired alike", () => {
    expect(resolveShare(newShareToken())).toBeNull();
    expect(resolveShare("not-a-token")).toBeNull();

    const revoked = mint({ label: "revoked" });
    revokeShare(revoked.id);
    expect(resolveShare(revoked.token)).toBeNull();
    // Revoked is still a row: the link stays auditable after it stops working.
    expect(lookupShare(revoked.token)!.revoked_at).not.toBeNull();

    const expired = mint({ label: "expired", expiresAt: Date.now() - 1000 });
    expect(resolveShare(expired.token)).toBeNull();
    expect(lookupShare(expired.token)!.id).toBe(expired.id);
  });

  test("listing a workspace's shares never returns a token", () => {
    const { id, token } = mint({ label: "listed" });
    const listed = listShares(wsOut);
    const row = listed.find((s) => s.id === id)!;
    expect(row.label).toBe("listed");
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("token");

    // A revoked share leaves the list a member reads.
    revokeShare(id);
    expect(listShares(wsOut).some((s) => s.id === id)).toBe(false);
  });
});

// ---- the read route ----

describe("the share read route", () => {
  test("a minted token opens the review, current and pinned", async () => {
    const { token } = mint();

    const current = await fetch(`${base}/s/${token}`);
    expect(current.status).toBe(200);
    const html = await current.text();
    expect(html).toContain("<title>");
    expect(html).toContain("overseer");

    const pinned = await fetch(`${base}/s/${token}/v/1`);
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toContain("overseer");
  });

  test("a shared page hangs off the token, not off the private URL", async () => {
    const { token } = mint();
    const html = await (await fetch(`${base}/s/${token}`)).text();
    // Every link the page draws is one the holder can follow.
    expect(html).not.toContain(`/${wsOut}/r/shared-review`);
    // And nothing on it opens the review's live channel, which asks for membership.
    expect(html).not.toContain("/ws/livereload");
  });

  test("following a share is not a login", async () => {
    const { token } = mint();
    const res = await fetch(`${base}/s/${token}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    // Nor does it widen: the review it names is still the only thing the token opens.
    const elsewhere = await fetch(`${base}/${wsOut}/r/shared-review`);
    expect(elsewhere.status).toBe(404);
  });

  test("a shared attachment is served under the token", async () => {
    const { token } = mint();
    const res = await fetch(`${base}/s/${token}/a/${attachmentId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(4);
  });

  test("evidence on a shared page points at the token path", () => {
    const stored = goldenStoredDoc();
    const attachment: Evidence = {
      type: "attachment",
      attachment: {
        id: "att_abc123",
        mediaType: "image/png",
        bytes: 12,
        alt: "A shot",
        caption: "",
      },
    };
    const doc = {
      ...stored,
      id: "rev_shared",
      slug: "shared-review",
      version: 1,
      statements: [{ ...stored.statements[0]!, evidence: [attachment] }],
    };
    const html = renderReviewPage({
      wsId: wsOut,
      slug: "shared-review",
      basePath: "/s/seer_sh_probe",
      live: false,
      doc,
      version: 1,
      latestVersion: 1,
      pinned: false,
      freshness: {},
    });
    expect(html).toContain('src="/s/seer_sh_probe/a/att_abc123"');
    expect(html).not.toContain(`/${wsOut}/r/`);
  });

  test("unknown, revoked and expired tokens are one byte-identical soft-404", async () => {
    const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));
    expect(unknown.startsWith("404\n")).toBe(true);

    const revoked = mint();
    revokeShare(revoked.id);
    expect(await shape(await fetch(`${base}/s/${revoked.token}`))).toBe(
      unknown,
    );

    const expired = mint({ expiresAt: Date.now() - 1000 });
    expect(await shape(await fetch(`${base}/s/${expired.token}`))).toBe(
      unknown,
    );

    // A token that is not even the right shape, and a version nobody published.
    expect(await shape(await fetch(`${base}/s/nonsense`))).toBe(unknown);
    const live = mint();
    expect(await shape(await fetch(`${base}/s/${live.token}/v/9`))).toBe(
      unknown,
    );
  });

  test("Referrer-Policy: no-referrer is on the page and on the refusal", async () => {
    const { token } = mint();
    const page = await fetch(`${base}/s/${token}`);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const gone = await fetch(`${base}/s/${newShareToken()}`);
    expect(gone.headers.get("referrer-policy")).toBe("no-referrer");
    const attachment = await fetch(`${base}/s/${token}/a/${attachmentId}`);
    expect(attachment.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("a token for one review does not open another", async () => {
    const { token } = mint({ target: "shared-review" });
    const html = await (await fetch(`${base}/s/${token}`)).text();
    // The share names its own review and no other, at every URL it has.
    expect(html).not.toContain("other-review");
    expect(html).toContain("shared-review");
  });

  test("a token minted in one workspace does not reach an asset in another", async () => {
    // A row that names a workspace and a slug that do not go together: the asset exists,
    // but not there. The resolver scopes on both, so this opens nothing.
    const token = newShareToken();
    db.run(
      "INSERT INTO shares (id, workspace_id, kind, target, label, token_hash, created_by, created_at) " +
        "VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
      [
        tinyId("shr"),
        rootWs,
        "shared-review",
        "crossed wires",
        hashKey(token),
        rootUser,
        Date.now(),
      ],
    );
    const crossed = await shape(await fetch(`${base}/s/${token}`));
    const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));
    expect(crossed).toBe(unknown);
  });

  test("a member following a revoked link reaches the asset", async () => {
    // The one documented exception, and it is the reader's own workspace that earns it.
    const own = createShare({
      wsId: rootWs,
      kind: "review",
      target: "own-review",
      label: "stale",
      userId: rootUser,
      expiresAt: null,
    });
    revokeShare(own.id);
    const res = await fetch(`${base}/s/${own.token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/${rootWs}/r/own-review`);

    // Followed, it lands on the review itself rather than on the refusal.
    const followed = await fetch(`${base}/s/${own.token}`);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain("own-review");
  });
});

// ---- a shared bundle ----
//
// A bundle is a tree, not a page, so the questions here are the ones a review never
// raised: does the trailing slash arrive, does a relative asset resolve, does the
// version pin work through the token, and does the page that reloads itself reload
// itself for someone who is not a member.

function bundleShare(over: Partial<Parameters<typeof createShare>[0]> = {}) {
  return createShare({
    wsId: wsOut,
    kind: "bundle",
    target: "shared-bundle",
    label: "the preview",
    userId: rootUser,
    expiresAt: null,
    ...over,
  });
}

describe("a shared bundle", () => {
  test("the token's root redirects onto its trailing slash, then serves the page", async () => {
    const { token } = bundleShare();

    // Without the slash every relative URL in the page would resolve one level too high.
    const bare = await fetch(`${base}/s/${token}`, { redirect: "manual" });
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe(`/s/${token}/`);

    const page = await fetch(`${base}/s/${token}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html;charset=utf-8");
    const html = await page.text();
    expect(html).toContain("two"); // the latest version, as a share link should show
    expect(html).not.toContain("one");
  });

  test("the whole tree comes with it, not just the page at the root", async () => {
    const { token } = bundleShare();

    const css = await fetch(`${base}/s/${token}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("two");

    // A directory request falls back to its index.html, exactly as the private route does.
    const deep = await fetch(`${base}/s/${token}/deep/`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("deep two");

    expect((await fetch(`${base}/s/${token}/nothing-here.js`)).status).toBe(404);
  });

  test("a version pins through the token, and an unpublished one is the soft-404", async () => {
    const { token } = bundleShare();

    const pinned = await fetch(`${base}/s/${token}/v/1/`);
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toContain("one");
    // Pinned content never changes, so it opens no socket — but see the caching test
    // below for why it is still not cached the way the workspace path caches it.
    expect(pinned.headers.get("content-type")).toBe("text/html;charset=utf-8");

    const bare = await fetch(`${base}/s/${token}/v/1`, { redirect: "manual" });
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe(`/s/${token}/v/1/`);

    expect(await shape(await fetch(`${base}/s/${token}/v/9/`))).toBe(
      await shape(await fetch(`${base}/s/${newShareToken()}`)),
    );
  });

  test("the live page reloads over the token, never over the workspace", async () => {
    const { token } = bundleShare();
    const html = await (await fetch(`${base}/s/${token}/`)).text();
    // The holder is not a member, so the workspace channel would refuse them; the
    // socket carries the token and the server reads the workspace off the share.
    expect(html).toContain(`/ws/livereload?share=${token}`);
    expect(html).not.toContain(`ws=${wsOut}`);
    expect(html).not.toContain(`/${wsOut}/b/`);
  });

  test("the socket opens for a live token and shuts for a dead one", async () => {
    const live = bundleShare();
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws/livereload?share=${live.token}`);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    });
    expect(opened).toBe(true);

    const dead = bundleShare();
    revokeShare(dead.id);
    const refused = await fetch(`${base}/ws/livereload?share=${dead.token}`);
    expect(refused.status).toBe(404);
    // And a review's token opens no bundle channel, whatever it names.
    expect((await fetch(`${base}/ws/livereload?share=${mint().token}`)).status).toBe(404);
  });

  test("a dead token is the same refusal at the root and everywhere under it", async () => {
    const unknown = await shape(await fetch(`${base}/s/${newShareToken()}`));

    const revoked = bundleShare();
    revokeShare(revoked.id);
    for (const path of ["", "/", "/assets/app.css", "/v/1/"]) {
      expect(await shape(await fetch(`${base}/s/${revoked.token}${path}`))).toBe(unknown);
    }

    const expired = bundleShare({ expiresAt: Date.now() - 1000 });
    expect(await shape(await fetch(`${base}/s/${expired.token}/`))).toBe(unknown);
  });

  test("a token opens its own bundle and no sibling", async () => {
    const { token } = bundleShare();
    const html = await (await fetch(`${base}/s/${token}/`)).text();
    expect(html).toContain("shared-bundle");
    expect(html).not.toContain("other-bundle");
    // The workspace's other bundle stays where it was: private to a workspace this
    // reader is not in.
    expect((await fetch(`${base}/${wsOut}/b/other-bundle/`)).status).toBe(404);
  });

  test("a member following a revoked bundle link reaches the bundle", async () => {
    const own = createShare({
      wsId: rootWs,
      kind: "bundle",
      target: "own-bundle",
      label: "stale",
      userId: rootUser,
      expiresAt: null,
    });
    revokeShare(own.id);
    const res = await fetch(`${base}/s/${own.token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/${rootWs}/b/own-bundle/`);
  });

  test("Referrer-Policy: no-referrer rides on the page and on its assets", async () => {
    const { token } = bundleShare();
    for (const path of ["/", "/assets/app.css", "/v/1/"]) {
      expect((await fetch(`${base}/s/${token}${path}`)).headers.get("referrer-policy")).toBe(
        "no-referrer",
      );
    }
  });

  test("nothing a share serves may be cached by anything but the reader", async () => {
    // What revocation withdraws here is authorization, not content — so the reasoning
    // the workspace path uses (a pinned version's bytes never change, therefore cache
    // them forever) does not carry across. A year-long `public` entry is a copy of the
    // bytes in an intermediary that no revocation can reach.
    const { token } = bundleShare();
    for (const path of ["/", "/assets/app.css", "/v/1/", "/v/1/assets/app.css"]) {
      const res = await fetch(`${base}/s/${token}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    }

    // The control: on the workspace path a pinned version still caches forever, which
    // is what makes the line above a decision rather than a blanket rule.
    const own = await fetch(`${base}/${rootWs}/b/own-bundle/v/1/`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a shared page is not indexable and does not print its own token", async () => {
    const { token } = bundleShare();

    // The other way a URL escapes a page is a crawler that fetched it.
    for (const path of ["/", "/assets/app.css", "/v/1/"]) {
      expect((await fetch(`${base}/s/${token}${path}`)).headers.get("x-robots-tag")).toBe(
        "noindex, nofollow",
      );
    }
    // Including the refusal, or an unknown token would be the indexable one.
    expect((await fetch(`${base}/s/${newShareToken()}`)).headers.get("x-robots-tag")).toBe(
      "noindex, nofollow",
    );

    // og:url would put the token in a meta tag, which is the one part of the page an
    // unfurler copies onward and a crawler reads as the address to index. The other
    // social tags stay: a shared link should still unfurl as a Seer card.
    const html = await (await fetch(`${base}/s/${token}/`)).text();
    expect(html).toContain(`property="og:title"`);
    expect(html).toContain(`property="og:image"`);
    expect(html).not.toContain(`property="og:url"`);
    for (const tag of html.match(/<meta[^>]*>/g) ?? []) expect(tag).not.toContain(token);

    // The live page does carry the token once, in the reload socket's URL, and has to:
    // that is how the socket authorises. It is not a leak of the same kind — a script
    // in the bundle can read location.href regardless, and no unfurler copies a script
    // tag onward. A pinned page opens no socket, so it holds the token nowhere at all.
    const pinned = await (await fetch(`${base}/s/${token}/v/1/`)).text();
    expect(pinned).not.toContain(token);

    // The control: the workspace path does declare its canonical URL, because there the
    // URL is not a secret.
    const own = await (await fetch(`${base}/${rootWs}/b/own-bundle/`)).text();
    expect(own).toContain(`property="og:url"`);
  });

  test("revoking a share shuts the socket it already had open", async () => {
    const live = bundleShare();
    const socket = new WebSocket(`ws://localhost:${server.port}/ws/livereload?share=${live.token}`);
    const closed = new Promise<boolean>((resolve) => {
      socket.onopen = () => revokeShare(live.id);
      socket.onclose = () => resolve(true);
      socket.onerror = () => resolve(false);
    });
    // A socket is authorised once, at upgrade. Without this a revoked holder keeps a
    // live channel and goes on being told that new versions exist.
    expect(await closed).toBe(true);
  });

  test("the share route has no verb but GET", async () => {
    const { token } = bundleShare();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${base}/s/${token}/`, { method, body: method === "DELETE" ? undefined : "x" });
      expect(res.status).toBe(405);
    }
  });
});

// ---- a share is never a write ----

describe("a share is never a write", () => {
  test("a share token is not an API key", async () => {
    const { token } = mint();
    const res = await fetch(`${base}/api/reviews/shared-review/annotations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: { type: "summary", id: "summary" },
        body: "Can I write here?",
      }),
    });
    expect(res.status).not.toBe(200);
    const filed = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) c FROM review_annotations WHERE body = ?",
      )
      .get("Can I write here?")!.c;
    expect(filed).toBe(0);
  });

  test("the share path offers no write of its own", async () => {
    const { token } = mint();
    for (const path of [`/s/${token}/annotations`, `/s/${token}`]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "target=summary%3Asummary&body=written+through+a+share",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const filed = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) c FROM review_annotations WHERE body = ?",
      )
      .get("written through a share")!.c;
    expect(filed).toBe(0);
  });

  test("a member's own page offers to share it; a shared page does not", async () => {
    // rootWs is the workspace the root user is in, so this is the member's view.
    const mine = await (await fetch(`${base}/${rootWs}/r/own-review`)).text();
    expect(mine).toContain("data-share-open");
    expect(mine).toContain("data-sharebox");
    expect(mine).toContain("/api/shares");

    // The same review through a token: no control, and no script that could reach
    // the mint route even if one were forged by hand.
    const { token } = mint();
    const shared = await (await fetch(`${base}/s/${token}`)).text();
    expect(shared).not.toContain("data-share-open");
    expect(shared).not.toContain("data-sharebox");
    expect(shared).not.toContain("/api/shares");
  });

  test("a shared page carries no annotations and no ask form", async () => {
    const { token } = mint();
    const html = await (await fetch(`${base}/s/${token}`)).text();
    expect(html).not.toContain("Is the gate reachable?");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/annotations");
  });
});

// ---- the API ----

/** POST /api/shares as the signed-in root user. */
function post(body: unknown): Promise<Response> {
  return fetch(`${base}/api/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ApiError {
  field: string;
  rule: string;
  message: string;
}

/** The first error of a 422, which is the one a caller reads to know what to fix. */
async function errorOf(res: Response): Promise<ApiError> {
  expect(res.status).toBe(422);
  const errors = ((await res.json()) as { errors: ApiError[] }).errors;
  expect(errors.length).toBeGreaterThan(0);
  return errors[0]!;
}

describe("the shares API", () => {
  test("POST mints a share and answers with the /s/<token> URL", async () => {
    const res = await post({
      workspace: rootWs,
      kind: "review",
      target: "own-review",
      label: "for the client",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      token: string;
      url: string;
      label: string;
      expiresAt: number | null;
    };
    expect(body.token).toMatch(/^seer_sh_[A-Za-z0-9_-]{32}$/);
    expect(body.url).toBe(`${config.baseUrl}/s/${body.token}`);
    expect(body.label).toBe("for the client");
    expect(body.expiresAt).toBeNull();

    // The URL it handed back is one that opens the review.
    const page = await fetch(`${base}/s/${body.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("own-review");
  });

  test("an expiry is honoured, and a past one is refused", async () => {
    const soon = Date.now() + 60_000;
    const res = await post({
      workspace: rootWs,
      kind: "review",
      target: "own-review",
      expiresAt: soon,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; expiresAt: number };
    expect(body.expiresAt).toBe(soon);

    const past = await post({
      workspace: rootWs,
      kind: "review",
      target: "own-review",
      expiresAt: Date.now() - 1000,
    });
    expect((await errorOf(past)).field).toBe("expiresAt");
  });

  test("an unknown kind is a 422 naming kind", async () => {
    const res = await post({
      workspace: rootWs,
      kind: "wallpaper",
      target: "own-review",
    });
    const error = await errorOf(res);
    expect(error.field).toBe("kind");
    expect(error.rule).toBe("kind_unknown");
  });

  test("POST mints a bundle share, and the URL it hands back opens the bundle", async () => {
    const res = await post({
      workspace: rootWs,
      kind: "bundle",
      target: "own-bundle",
      label: "for the client",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; kind: string };
    expect(body.kind).toBe("bundle");
    expect(body.url).toBe(`${config.baseUrl}/s/${body.token}`);

    const page = await fetch(`${base}/s/${body.token}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("mine");
  });

  test("a bundle target that is not a bundle is a 422 naming target", async () => {
    // `own-review` exists in this workspace, but as a review. The kind and the target
    // are checked together, so a share can never name one thing and open another.
    const res = await post({ workspace: rootWs, kind: "bundle", target: "own-review" });
    const error = await errorOf(res);
    expect(error.field).toBe("target");
    expect(error.rule).toBe("target_unknown");
  });

  test("every kind the table allows is a kind some route serves", () => {
    // A kind in SHARE_KINDS but not in SERVED_SHARE_KINDS mints a 422 (kind_not_served)
    // rather than a link that dead-ends. Nothing is in that state today, so the guard
    // is asserted here rather than exercised over HTTP: adding a third kind without a
    // branch in handleShareRequest is what this is here to catch.
    expect([...SHARE_KINDS].sort()).toEqual([...SERVED_SHARE_KINDS].sort());
  });

  test("an unknown target is a 422 naming target", async () => {
    const res = await post({
      workspace: rootWs,
      kind: "review",
      target: "no-such-review",
    });
    const error = await errorOf(res);
    expect(error.field).toBe("target");
    expect(error.rule).toBe("target_unknown");
  });

  test("a target in another workspace is a 422 naming target", async () => {
    // `shared-review` is real, but it belongs to wsOut, and this mint names rootWs.
    const res = await post({
      workspace: rootWs,
      kind: "review",
      target: "shared-review",
      label: "reaching across",
    });
    const error = await errorOf(res);
    expect(error.field).toBe("target");
    expect(error.rule).toBe("target_unknown");
    // A refused mint writes nothing.
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) c FROM shares WHERE label = ?",
        )
        .get("reaching across")!.c,
    ).toBe(0);
  });

  test("a label longer than the cap is a 422 naming label", async () => {
    const res = await post({
      workspace: rootWs,
      kind: "review",
      target: "own-review",
      label: "x".repeat(81),
    });
    expect((await errorOf(res)).field).toBe("label");
  });

  test("minting into a workspace the caller is not in is a 404", async () => {
    const res = await post({
      workspace: wsOut,
      kind: "review",
      target: "shared-review",
    });
    expect(res.status).toBe(404);
  });

  test("GET lists the workspace's shares and never a token", async () => {
    const minted = (await (
      await post({
        workspace: rootWs,
        kind: "review",
        target: "own-review",
        label: "listed by api",
      })
    ).json()) as { id: string; token: string };

    const res = await fetch(`${base}/api/shares?workspace=${rootWs}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(minted.token);
    expect(text).not.toContain("token");
    const body = JSON.parse(text) as {
      shares: { id: string; label: string; target: string }[];
    };
    expect(
      body.shares.some(
        (s) => s.id === minted.id && s.label === "listed by api",
      ),
    ).toBe(true);

    // Another workspace's shares are not this list's to hand over.
    expect(
      await (
        await fetch(`${base}/api/shares?workspace=${wsOut}`)
      ).status,
    ).toBe(404);
  });

  test("the settings page lists the workspace's shares and never a token", async () => {
    const listed = createShare({
      wsId: rootWs,
      kind: "review",
      target: "own-review",
      label: "on the settings page",
      userId: rootUser,
      expiresAt: Date.now() + 86_400_000,
    });
    const html = await (await fetch(`${base}/settings/${rootWs}`)).text();
    expect(html).toContain("on the settings page");
    expect(html).toContain("own-review");
    expect(html).toContain(`/settings/${rootWs}/shares/${listed.id}/revoke`);
    expect(html).not.toContain(listed.token);
    expect(html).not.toContain("seer_sh_");

    // Another workspace's shares are not on this page.
    const elsewhere = mint({ label: "belongs to wsOut" });
    expect(html).not.toContain("belongs to wsOut");
    expect(
      await (await fetch(`${base}/settings/${rootWs}`)).text(),
    ).not.toContain(elsewhere.token);
  });

  test("the settings revoke control revokes, and only its own workspace's shares", async () => {
    const own = createShare({
      wsId: rootWs,
      kind: "review",
      target: "own-review",
      label: "revoked from settings",
      userId: rootUser,
      expiresAt: null,
    });
    const res = await fetch(
      `${base}/settings/${rootWs}/shares/${own.id}/revoke`,
      {
        method: "POST",
        redirect: "manual",
      },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/settings/${rootWs}`);
    expect(resolveShare(own.token)).toBeNull();
    expect(
      await (await fetch(`${base}/settings/${rootWs}`)).text(),
    ).not.toContain("revoked from settings");

    // A share in another workspace, revoked through this one's settings: a 404, and the
    // share is untouched.
    const theirs = mint({ label: "not revocable from here" });
    const refused = await fetch(
      `${base}/settings/${rootWs}/shares/${theirs.id}/revoke`,
      {
        method: "POST",
        redirect: "manual",
      },
    );
    expect(refused.status).toBe(404);
    expect(resolveShare(theirs.token)).not.toBeNull();
  });

  test("DELETE revokes, and only for a member of the owning workspace", async () => {
    const mine = (await (
      await post({
        workspace: rootWs,
        kind: "review",
        target: "own-review",
        label: "to revoke",
      })
    ).json()) as { id: string; token: string };

    const res = await fetch(`${base}/api/shares/${mine.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(resolveShare(mine.token)).toBeNull();
    expect(lookupShare(mine.token)!.revoked_at).not.toBeNull();

    // A share in a workspace the caller is not in: the same answer an id that never
    // existed gets, and the row is untouched.
    const theirs = mint({ label: "not yours to revoke" });
    const refused = await fetch(`${base}/api/shares/${theirs.id}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(404);
    expect(resolveShare(theirs.token)).not.toBeNull();

    expect(
      (await fetch(`${base}/api/shares/shr_nosuchsha`, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });
});

// ---- the reader with no session at all ----
//
// Everything above arrives as the root user, because AUTH_DISABLED short-circuits
// sessionUser. A share's actual reader has no session, and the one branch that treats a
// dead token differently is keyed on exactly that, so the signed-out questions are asked
// in their own process where the env can be undone.
test("share-privacy.script.ts passes with AUTH_DISABLED unset", async () => {
  const script = join(import.meta.dir, "share-privacy.script.ts");
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AUTH_DISABLED: undefined as unknown as string },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    console.error("subprocess stdout:", stdout);
    console.error("subprocess stderr:", stderr);
  }
  expect(exitCode).toBe(0);
  expect(stdout).toContain("all assertions passed");
}, 30_000);
