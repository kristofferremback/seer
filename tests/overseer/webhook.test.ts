// Deliveries: the only thing that keeps a published review's status true once polling
// is gone.
//
// The claims here are the ones the design turns on. A forged, missing or truncated
// signature writes nothing and is a 401 rather than a 500. A delivery id and its
// effects commit together, so a failed apply followed by a retry applies rather than
// being swallowed as a duplicate. An out-of-order delivery cannot roll a newer status
// back. An event for workspace A writes into A and leaves B untouched. And every
// refusal here runs beside the case that should work, because a guarantee is only
// tested when the thing it withholds is demonstrably there to withhold.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

import { startServer } from "../../src/server";
import { createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { tinyId } from "../../src/ids";
import {
  deliveryIsQuiet,
  getLiveInstallation,
  getPrStatus,
  listReviewPrs,
  reviewStatusTally,
  setReviewPrs,
  sweepOrphanPrStatus,
  upsertPrStatus,
} from "../../src/overseer/installations";
import { setGithubClientFactory } from "../../src/overseer/github-app";
import { resetChecks } from "../../src/overseer/freshness";
import { sweepDeliveries, verifyWebhookSignature, webhookSignature } from "../../src/overseer/webhook";
import type { GithubClient, GithubPull } from "../../src/overseer/github";
import { offlineGithubClientFactory } from "../offline-github";
import { GOLDEN_HEAD_SHA_12, GOLDEN_HEAD_SHA_13, GOLDEN_REPO } from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";

const SECRET = "test-webhook-secret";
const REPO_ID = 55501;
const INSTALL_A = 9001;
const INSTALL_B = 9002;

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let wsA = "";
let wsB = "";
let keyA = "";

function attach(wsId: string, installationId: number, login: string): void {
  db.run("DELETE FROM github_installations WHERE installation_id = ?", [installationId]);
  db.run(
    "INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_id, " +
      "account_type, repository_selection, connected_by, connected_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 'Organization', 'all', 'usr_x', ?, ?)",
    [tinyId("ghi"), wsId, installationId, login, installationId, Date.now(), Date.now()],
  );
}

interface PullPayload {
  action?: string;
  number: number;
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  updatedAt?: string;
  head?: string;
  installationId?: number;
  repoId?: number;
  repo?: string;
}

function prEvent(p: PullPayload): Record<string, unknown> {
  return {
    action: p.action ?? "synchronize",
    installation: { id: p.installationId ?? INSTALL_A },
    repository: { id: p.repoId ?? REPO_ID, full_name: p.repo ?? GOLDEN_REPO },
    pull_request: {
      number: p.number,
      state: p.state ?? "open",
      merged: p.merged ?? false,
      draft: p.draft ?? false,
      updated_at: p.updatedAt ?? "2026-08-01T10:00:00Z",
      head: { sha: p.head ?? "a".repeat(40) },
    },
  };
}

interface DeliverOptions {
  delivery?: string;
  /** null omits the header entirely; a string is sent as given, forged or truncated. */
  signature?: string | null;
}

async function deliver(
  event: string,
  payload: unknown,
  options: DeliverOptions = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": options.delivery ?? tinyId("dlv"),
  };
  const sig = "signature" in options ? options.signature : webhookSignature(SECRET, body);
  if (typeof sig === "string") headers["x-hub-signature-256"] = sig;
  return fetch(`${base}/api/github/webhook`, { method: "POST", body, headers });
}

/** A client that answers getPull with whatever this test wants, and counts. */
function countingClient(
  answer: (repo: string, number: number) => Partial<GithubPull>,
  installationId = INSTALL_A,
): { client: GithubClient; calls: () => number } {
  let calls = 0;
  const client = {
    async installationFor(): Promise<number> {
      return installationId;
    },
    async getPull(repo: string, number: number): Promise<GithubPull> {
      calls++;
      return {
        number,
        title: "A pull request",
        body: null,
        state: "open",
        user: { login: "someone" },
        head: { sha: "a".repeat(40), ref: "topic" },
        base: { sha: "1".repeat(40), ref: "main", repo: { id: REPO_ID, full_name: repo } },
        updated_at: "2026-08-01T10:00:00Z",
        ...answer(repo, number),
      } as GithubPull;
    },
  } as unknown as GithubClient;
  return { client, calls: () => calls };
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsA = createWorkspace("Hook A", owner);
  keyA = mintApiKey(owner, wsA, "hook").token;
  const stranger = tinyId("usr");
  db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [
    stranger,
    "hook-stranger@example.com",
    Date.now(),
  ]);
  wsB = createWorkspace("Hook B", stranger);

  attach(wsA, INSTALL_A, "acme");
  attach(wsB, INSTALL_B, "other");
});

afterAll(() => {
  setGithubClientFactory(offlineGithubClientFactory());
  server.stop(true);
});

/** A review in `wsId` that names the golden pull requests, with its review_prs rows —
 *  which is what makes a delivery for them something the filter lets through. */
function reviewNaming(wsId: string, slug: string): void {
  storeGoldenReview(wsId, slug);
  setReviewPrs(wsId, slug, [
    { repo: GOLDEN_REPO, number: 12, repoId: REPO_ID },
    { repo: GOLDEN_REPO, number: 13, repoId: REPO_ID },
  ]);
}

function statusA(number: number) {
  return getPrStatus(wsA, REPO_ID, number);
}

describe("the signature", () => {
  test("forged, missing and truncated are 401 with nothing written, and a good one applies", async () => {
    reviewNaming(wsA, "signed");
    const payload = prEvent({ number: 12, head: "b".repeat(40) });
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);

    const forged = await deliver("pull_request", payload, {
      signature: `sha256=${"0".repeat(64)}`,
    });
    expect(forged.status).toBe(401);
    expect(statusA(12)).toBeNull();

    const missing = await deliver("pull_request", payload, { signature: null });
    expect(missing.status).toBe(401);
    expect(statusA(12)).toBeNull();

    // The one that used to be a 500: timingSafeEqual throws on unequal lengths, so
    // without the length guard a truncated header crashes the handler instead of
    // refusing it.
    const good = webhookSignature(SECRET, JSON.stringify(payload));
    const truncated = await deliver("pull_request", payload, { signature: good.slice(0, 20) });
    expect(truncated.status).toBe(401);
    expect(statusA(12)).toBeNull();

    // Nothing above was recorded as a delivery either: a refused body is one that was
    // never parsed, let alone acted on.
    expect(db.query("SELECT COUNT(*) AS n FROM github_deliveries").get()).toEqual({ n: 0 });

    // And the success beside the refusal: the same payload, correctly signed, lands.
    const ok = await deliver("pull_request", payload);
    expect(ok.status).toBe(200);
    expect(statusA(12)?.head_sha).toBe("b".repeat(40));
  });

  test("a signed delivery from a foreign Origin still applies", async () => {
    reviewNaming(wsA, "no-origin-guard");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const body = JSON.stringify(
      prEvent({ number: 13, head: "f".repeat(40), updatedAt: "2026-07-01T10:00:00Z" }),
    );
    // Every other POST in the table has an originOk guard and would be a 403 here.
    // This one must not: GitHub is not a browser, sends no Origin, and the signature
    // is the whole of this route's authentication. A guard would silently stop every
    // delivery, which is exactly the failure this design has no second mechanism for.
    const res = await fetch(`${base}/api/github/webhook`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
        "x-github-event": "pull_request",
        "x-github-delivery": tinyId("dlv"),
        "x-hub-signature-256": webhookSignature(SECRET, body),
      },
    });
    expect(res.status).toBe(200);
    expect(statusA(13)!.head_sha).toBe("f".repeat(40));
  });

  test("verification is over the raw bytes, so a re-serialised body does not verify", () => {
    const raw = '{"a":1,"b":[2,3]}';
    const sig = webhookSignature(SECRET, raw);
    const bytes = new TextEncoder().encode(raw);
    expect(verifyWebhookSignature(SECRET, bytes, sig)).toBe(true);
    // Same object, different bytes: any implementation that parsed first and hashed a
    // re-serialisation would call this valid.
    const reserialised = new TextEncoder().encode(JSON.stringify(JSON.parse(raw)).replace(",", ", "));
    expect(verifyWebhookSignature(SECRET, reserialised, sig)).toBe(false);
    expect(verifyWebhookSignature(SECRET, bytes, null)).toBe(false);
    expect(verifyWebhookSignature(SECRET, bytes, sig.slice(0, 12))).toBe(false);
  });
});

describe("what one delivery does", () => {
  test("ping is 204 and an event nobody handles is 202", async () => {
    expect((await deliver("ping", { zen: "hello" })).status).toBe(204);
    expect((await deliver("star", { action: "created", installation: { id: INSTALL_A } })).status).toBe(202);
  });

  test("an unknown installation is 202 and writes nothing", async () => {
    reviewNaming(wsA, "unknown-install");
    const before = statusA(12)?.head_sha ?? null;
    const res = await deliver(
      "pull_request",
      prEvent({ number: 12, installationId: 424242, head: "c".repeat(40) }),
    );
    // An installation removed a second ago still has deliveries in flight, so this is
    // acknowledged rather than refused.
    expect(res.status).toBe(202);
    expect(statusA(12)?.head_sha ?? null).toBe(before);
  });

  test("a pull request no review names is dropped, and one a review names is kept", async () => {
    reviewNaming(wsA, "filtered");
    // #99 is in the same repository, under the same installation, and nothing names
    // it. An installation covering a whole org delivers thousands of these.
    const dropped = await deliver("pull_request", prEvent({ number: 99 }));
    expect(dropped.status).toBe(202);
    expect(statusA(99)).toBeNull();

    const kept = await deliver("pull_request", prEvent({ number: 13, head: "d".repeat(40) }));
    expect(kept.status).toBe(200);
    expect(statusA(13)?.head_sha).toBe("d".repeat(40));
  });

  test("merged arrives as merged rather than as closed", async () => {
    reviewNaming(wsA, "merged");
    const res = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        action: "closed",
        state: "closed",
        merged: true,
        updatedAt: "2026-08-02T10:00:00Z",
        head: "e".repeat(40),
      }),
    );
    expect(res.status).toBe(200);
    const row = statusA(12)!;
    expect(row.merged).toBe(1);
    expect(row.state).toBe("closed");
  });
});

// The net is only visible if the deliveries that prove it is there leave a trace.
// Without this, settings can report health for an integration that stopped a fortnight
// ago, which is the exact failure deleting the poll chose to accept and therefore the
// one thing the UI has to make loud.
describe("delivery health", () => {
  test("an installation nothing has delivered for has no stamp and is quiet", () => {
    attach(wsA, INSTALL_A, "acme");
    expect(getLiveInstallation(INSTALL_A)!.last_delivery_at).toBeNull();
    expect(deliveryIsQuiet(null)).toBe(true);
  });

  test("a delivery stamps the installation it came from", async () => {
    attach(wsA, INSTALL_A, "acme");
    reviewNaming(wsA, "health");
    const before = Date.now();
    expect((await deliver("pull_request", prEvent({ number: 12, head: "f".repeat(40), updatedAt: "2026-09-01T10:00:00Z" }))).status).toBe(200);

    const stamp = getLiveInstallation(INSTALL_A)!.last_delivery_at;
    expect(stamp).not.toBeNull();
    expect(stamp!).toBeGreaterThanOrEqual(before);
    expect(deliveryIsQuiet(stamp)).toBe(false);
  });

  test("an event that writes nothing still proves the transport is alive", async () => {
    attach(wsA, INSTALL_A, "acme");
    reviewNaming(wsA, "health-dropped");
    // #99 is named by no review, so the upsert drops it. The delivery still arrived,
    // and delivery health is a question about the wire rather than about the rows.
    const before = Date.now();
    expect((await deliver("pull_request", prEvent({ number: 99 }))).status).toBe(202);
    expect(getLiveInstallation(INSTALL_A)!.last_delivery_at!).toBeGreaterThanOrEqual(before);
  });

  test("a forged delivery stamps nothing", async () => {
    attach(wsA, INSTALL_A, "acme");
    db.run("UPDATE github_installations SET last_delivery_at = NULL WHERE installation_id = ?", [
      INSTALL_A,
    ]);
    const res = await deliver("pull_request", prEvent({ number: 12 }), {
      signature: `sha256=${"0".repeat(64)}`,
    });
    expect(res.status).toBe(401);
    // A page that would say "heard from a moment ago" because someone unauthenticated
    // knocked would be worse than one that says nothing.
    expect(getLiveInstallation(INSTALL_A)!.last_delivery_at).toBeNull();
  });

  test("one installation's delivery does not vouch for another's", async () => {
    attach(wsA, INSTALL_A, "acme");
    attach(wsB, INSTALL_B, "other");
    reviewNaming(wsA, "health-attribution");
    expect((await deliver("pull_request", prEvent({ number: 12, head: "1".repeat(40), updatedAt: "2026-09-02T10:00:00Z" }))).status).toBe(200);
    expect(getLiveInstallation(INSTALL_A)!.last_delivery_at).not.toBeNull();
    expect(getLiveInstallation(INSTALL_B)!.last_delivery_at).toBeNull();
  });
});

describe("ordering and replay", () => {
  test("an out-of-order delivery cannot roll a newer status back", async () => {
    reviewNaming(wsA, "ordering");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);

    const newer = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        action: "closed",
        state: "closed",
        merged: true,
        updatedAt: "2026-08-03T12:00:00Z",
        head: "f".repeat(40),
      }),
    );
    expect(newer.status).toBe(200);
    expect(statusA(12)!.merged).toBe(1);

    // The retried `synchronize` from an hour earlier, landing after the merge. GitHub
    // guarantees no delivery order, so this is ordinary rather than exotic — and
    // without the precondition the row is just a place where the fact oscillates.
    const older = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        action: "synchronize",
        state: "open",
        updatedAt: "2026-08-03T11:00:00Z",
        head: "0".repeat(40),
      }),
    );
    expect(older.status).toBe(202);
    const row = statusA(12)!;
    expect(row.merged).toBe(1);
    expect(row.head_sha).toBe("f".repeat(40));

    // And forward still moves: the precondition is an ordering rule, not a latch.
    const forward = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        action: "reopened",
        state: "open",
        updatedAt: "2026-08-03T13:00:00Z",
        head: "1".repeat(40),
      }),
    );
    expect(forward.status).toBe(200);
    expect(statusA(12)!.head_sha).toBe("1".repeat(40));
    expect(statusA(12)!.merged).toBe(0);
  });

  test("the same delivery twice is applied once", async () => {
    reviewNaming(wsA, "replay");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const id = "dlv-replay-1";

    const first = await deliver(
      "pull_request",
      prEvent({ number: 12, updatedAt: "2026-08-04T10:00:00Z", head: "2".repeat(40) }),
      { delivery: id },
    );
    expect(first.status).toBe(200);
    expect(statusA(12)!.head_sha).toBe("2".repeat(40));

    // A newer payload under a delivery id already seen changes nothing: the id is the
    // thing being deduplicated, so this is what "applied once" has to mean.
    const again = await deliver(
      "pull_request",
      prEvent({ number: 12, updatedAt: "2026-08-04T11:00:00Z", head: "3".repeat(40) }),
      { delivery: id },
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(statusA(12)!.head_sha).toBe("2".repeat(40));
  });

  test("a failed apply followed by a retry applies rather than being swallowed", async () => {
    reviewNaming(wsA, "retry");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const id = "dlv-retry-1";
    const payload = prEvent({ number: 12, updatedAt: "2026-08-04T12:00:00Z", head: "4".repeat(40) });

    // A real failure inside the transaction, from the database rather than from a
    // stub: the write this delivery exists to make is made to abort.
    db.run("CREATE TRIGGER webhook_boom BEFORE INSERT ON github_pr_status BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const failed = await deliver("pull_request", payload, { delivery: id });
    expect(failed.status).toBe(500);
    expect(statusA(12)).toBeNull();
    // The delivery id rolled back with the work. Recording it first and then doing the
    // work is what turns a retry into a duplicate and loses the event for good.
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM github_deliveries WHERE delivery_id = ?").get(id),
    ).toEqual({ n: 0 });

    db.run("DROP TRIGGER webhook_boom");
    const retried = await deliver("pull_request", payload, { delivery: id });
    expect(retried.status).toBe(200);
    expect(statusA(12)!.head_sha).toBe("4".repeat(40));
  });

  test("the delivery table is swept by age", () => {
    db.run("INSERT OR REPLACE INTO github_deliveries (delivery_id, received_at) VALUES ('dlv-old', 1000)");
    db.run("INSERT OR REPLACE INTO github_deliveries (delivery_id, received_at) VALUES ('dlv-new', ?)", [
      Date.now(),
    ]);
    expect(sweepDeliveries()).toBeGreaterThan(0);
    expect(db.query("SELECT delivery_id FROM github_deliveries WHERE delivery_id = 'dlv-old'").get()).toBeNull();
    expect(db.query("SELECT delivery_id FROM github_deliveries WHERE delivery_id = 'dlv-new'").get()).not.toBeNull();
  });
});

describe("attribution", () => {
  test("an event for A writes into A and leaves B untouched", async () => {
    reviewNaming(wsA, "mine");
    reviewNaming(wsB, "theirs");
    db.run("DELETE FROM github_pr_status");

    const res = await deliver(
      "pull_request",
      prEvent({ number: 12, installationId: INSTALL_A, head: "5".repeat(40), updatedAt: "2026-08-04T13:00:00Z" }),
    );
    expect(res.status).toBe(200);
    // Both workspaces name the same repository and the same pull request; only the
    // installation says whose observation this is.
    expect(getPrStatus(wsA, REPO_ID, 12)!.head_sha).toBe("5".repeat(40));
    expect(getPrStatus(wsB, REPO_ID, 12)).toBeNull();

    // And B is reachable through its own installation, so the silence above is
    // attribution rather than B being unwritable.
    const theirs = await deliver(
      "pull_request",
      prEvent({ number: 12, installationId: INSTALL_B, head: "6".repeat(40), updatedAt: "2026-08-04T13:00:00Z" }),
    );
    expect(theirs.status).toBe(200);
    expect(getPrStatus(wsB, REPO_ID, 12)!.head_sha).toBe("6".repeat(40));
    expect(getPrStatus(wsA, REPO_ID, 12)!.head_sha).toBe("5".repeat(40));
  });

  test("the join is the numeric repository id, not the name", async () => {
    reviewNaming(wsA, "renamed");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);

    // The account renamed the repository. The name in the payload matches nothing
    // stored; the id matches, so the observation lands and the display name is healed.
    const res = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        repo: "acme/seer-renamed",
        head: "7".repeat(40),
        updatedAt: "2026-08-04T14:00:00Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(statusA(12)!.repo).toBe("acme/seer-renamed");
  });

  test("a repository renamed after publish still renders: glyph, chip, tally and refresh", async () => {
    reviewNaming(wsA, "renamed-read");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);

    // The account renamed the repository after the review was published. The stored
    // document — and every reading taken from it — still says `acme/seer` forever.
    const renamed = "acme/seer-renamed";
    for (const [number, head] of [
      [12, GOLDEN_HEAD_SHA_12],
      [13, GOLDEN_HEAD_SHA_13],
    ] as const) {
      const res = await deliver(
        "pull_request",
        prEvent({
          number,
          repo: renamed,
          action: "closed",
          state: "closed",
          merged: true,
          head,
          updatedAt: "2026-08-04T15:00:00Z",
        }),
      );
      expect(res.status).toBe(200);
    }
    // The observations landed under the numeric id.
    expect(statusA(12)!.merged).toBe(1);
    expect(statusA(13)!.merged).toBe(1);

    // And the reader can see them. The page draws the merged glyph and the chip says
    // the heads are current, rather than losing both at the moment the merge arrived.
    const page = await fetch(`${base}/r/renamed-read`, {
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("c-status s-merged");
    expect(html).toContain(">heads current<");

    // The reviews index reads the same rows through its own query.
    expect(reviewStatusTally(wsA, "renamed-read")).toEqual({
      merged: 2,
      closed: 0,
      draft: 0,
      open: 0,
      unknown: 0,
      total: 2,
    });

    // And refresh — which reads the known row before it writes — neither loses the
    // observation nor rolls it back with a staler answer from GitHub.
    resetChecks();
    const fake = countingClient((repo, number) => ({
      number,
      state: "closed",
      merged: true,
      head: { sha: number === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13, ref: "topic" },
      // GitHub answers under the name the repository has now, whatever name it was
      // asked with.
      base: { sha: "1".repeat(40), ref: "main", repo: { id: REPO_ID, full_name: renamed } },
      updated_at: "2026-08-04T16:00:00Z",
    }));
    setGithubClientFactory(() => fake.client);
    const refreshed = await fetch(`${base}/api/reviews/renamed-read/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(refreshed.status).toBe(200);
    setGithubClientFactory(offlineGithubClientFactory());

    expect(statusA(12)!.merged).toBe(1);
    // GitHub's answer names the repository as it is called now, and the row keeps that
    // name rather than rolling back to the one the document froze at publication.
    expect(statusA(12)!.repo).toBe(renamed);
    const after = await fetch(`${base}/r/renamed-read`, {
      headers: { authorization: `Bearer ${keyA}` },
    });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("c-status s-merged");
    expect(afterHtml).toContain(">heads current<");
  });
});

describe("the installation lifecycle", () => {
  test("created is recorded as unclaimed", async () => {
    const id = 777001;
    db.run("DELETE FROM github_installations WHERE installation_id = ?", [id]);
    const res = await deliver("installation", {
      action: "created",
      installation: {
        id,
        account: { login: "newcomer", id: 4242, type: "Organization" },
        repository_selection: "selected",
        repositories: [{ id: 1, full_name: "newcomer/thing" }],
      },
    });
    expect(res.status).toBe(202);
    const row = getLiveInstallation(id)!;
    // Unclaimed: it belongs to nobody until somebody proves through the OAuth leg that
    // they can reach it. It reserves the id, which is what stops a claim race.
    expect(row.workspace_id).toBeNull();
    expect(row.account_login).toBe("newcomer");
  });

  test("deleted takes its own status rows and leaves another installation's alone", async () => {
    reviewNaming(wsA, "goes-away");
    reviewNaming(wsB, "stays");
    db.run("DELETE FROM github_pr_status");
    await deliver("pull_request", prEvent({ number: 12, installationId: INSTALL_A, head: "8".repeat(40) }));
    await deliver("pull_request", prEvent({ number: 12, installationId: INSTALL_B, head: "9".repeat(40) }));
    expect(getPrStatus(wsA, REPO_ID, 12)).not.toBeNull();
    expect(getPrStatus(wsB, REPO_ID, 12)).not.toBeNull();

    const res = await deliver("installation", { action: "deleted", installation: { id: INSTALL_A } });
    expect(res.status).toBe(202);
    expect(getLiveInstallation(INSTALL_A)).toBeNull();
    expect(getPrStatus(wsA, REPO_ID, 12)).toBeNull();
    // Found by installation_id, which is why that column exists: deleting by workspace
    // would take the surviving installation's observations too.
    expect(getPrStatus(wsB, REPO_ID, 12)).not.toBeNull();

    attach(wsA, INSTALL_A, "acme");
  });

  test("suspend sets the hint and any later delivery clears it", async () => {
    await deliver("installation", { action: "suspend", installation: { id: INSTALL_A } });
    expect(getLiveInstallation(INSTALL_A)!.suspended_at).not.toBeNull();

    // Not the unsuspend event: an ordinary pull_request delivery. A delivery arriving
    // at all is proof the installation is live, which is what repairs the case where
    // the unsuspend delivery was itself the one that was lost.
    reviewNaming(wsA, "wakes");
    await deliver("pull_request", prEvent({ number: 12, head: "a".repeat(40) }));
    expect(getLiveInstallation(INSTALL_A)!.suspended_at).toBeNull();
  });

  test("removed repositories lose their status rows", async () => {
    reviewNaming(wsA, "dropped-repo");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    await deliver("pull_request", prEvent({ number: 12, head: "b".repeat(40) }));
    expect(statusA(12)).not.toBeNull();

    const res = await deliver("installation_repositories", {
      action: "removed",
      installation: { id: INSTALL_A },
      repositories_removed: [{ id: REPO_ID, full_name: GOLDEN_REPO }],
    });
    expect(res.status).toBe(202);
    // The glyph goes rather than rendering indefinitely after access ended.
    expect(statusA(12)).toBeNull();
  });
});

describe("reconciliation", () => {
  test("unsuspend re-observes the pull requests some review names, once each", async () => {
    reviewNaming(wsA, "recon");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    // A second review naming the same pull requests: one observation, not two calls.
    reviewNaming(wsA, "recon-too");
    const fake = countingClient(() => ({
      head: { sha: "c".repeat(40), ref: "topic" },
      updated_at: "2026-08-05T10:00:00Z",
    }));
    setGithubClientFactory(() => fake.client);

    const res = await deliver("installation", { action: "unsuspend", installation: { id: INSTALL_A } });
    expect(res.status).toBe(202);
    // Detached: the delivery is acknowledged before the sweep finishes.
    for (let i = 0; i < 20 && statusA(12) === null; i++) await new Promise((r) => setTimeout(r, 10));

    expect(statusA(12)!.head_sha).toBe("c".repeat(40));
    expect(statusA(13)!.head_sha).toBe("c".repeat(40));
    expect(fake.calls()).toBe(2);
    setGithubClientFactory(offlineGithubClientFactory());
  });

  test("a sweep attributes each row to the installation that covers the repository", async () => {
    // A workspace holding two installations, which the design calls day-one supported.
    // The sweep is triggered by the second one; the repository belongs to the first.
    const INSTALL_OTHER = 9003;
    attach(wsA, INSTALL_OTHER, "acme-two");
    reviewNaming(wsA, "two-installs");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const fake = countingClient(
      () => ({ head: { sha: "e".repeat(40), ref: "topic" }, updated_at: "2026-08-06T10:00:00Z" }),
      INSTALL_A,
    );
    setGithubClientFactory(() => fake.client);

    await deliver("installation", { action: "unsuspend", installation: { id: INSTALL_OTHER } });
    for (let i = 0; i < 20 && statusA(12) === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(statusA(12)!.installation_id).toBe(INSTALL_A);

    // The half that used to destroy data: stamping the triggering installation on
    // another one's rows means its removal deletes observations a live installation
    // still covers.
    const res = await deliver("installation", {
      action: "deleted",
      installation: { id: INSTALL_OTHER },
    });
    expect(res.status).toBe(202);
    expect(statusA(12)).not.toBeNull();
    setGithubClientFactory(offlineGithubClientFactory());
  });

  test("repositories added are swept, and repositories nobody added are not", async () => {
    reviewNaming(wsA, "added");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    const fake = countingClient(() => ({
      head: { sha: "d".repeat(40), ref: "topic" },
      updated_at: "2026-08-05T11:00:00Z",
    }));
    setGithubClientFactory(() => fake.client);

    // A repository this workspace names nothing about: the sweep is narrowed to what
    // the event says changed, so it costs nothing here.
    await deliver("installation_repositories", {
      action: "added",
      installation: { id: INSTALL_A },
      repositories_added: [{ id: 999, full_name: "acme/unrelated" }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls()).toBe(0);
    expect(statusA(12)).toBeNull();

    // And the repository a review does name is re-observed, because `added` otherwise
    // writes nothing back and every review naming it renders unchecked forever while
    // delivery health reports perfect health.
    await deliver("installation_repositories", {
      action: "added",
      installation: { id: INSTALL_A },
      repositories_added: [{ id: REPO_ID, full_name: GOLDEN_REPO }],
    });
    for (let i = 0; i < 20 && statusA(12) === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(statusA(12)!.head_sha).toBe("d".repeat(40));
    setGithubClientFactory(offlineGithubClientFactory());
  });
});

describe("the single live message", () => {
  test("one message carries the glyphs and the chip together", async () => {
    reviewNaming(wsA, "live");
    db.run("DELETE FROM github_pr_status WHERE workspace_id = ?", [wsA]);
    // #13 observed at its published head, #12 about to move: so the message has to say
    // two different things about two pull requests and one sentence about the review.
    upsertPrStatus(wsA, INSTALL_A, {
      repoId: REPO_ID,
      repo: GOLDEN_REPO,
      prNumber: 13,
      state: "open",
      merged: false,
      draft: false,
      headSha: GOLDEN_HEAD_SHA_13,
      updatedAt: 1000,
    });

    const socket = new WebSocket(
      `ws://localhost:${server.port}/ws/livereload?kind=review&ws=${wsA}&slug=live`,
    );
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const heard = new Promise<string>((resolve) => {
      socket.onmessage = (e) => resolve(String(e.data));
    });

    const res = await deliver(
      "pull_request",
      prEvent({
        number: 12,
        action: "converted_to_draft",
        draft: true,
        head: "e".repeat(40),
        updatedAt: "2026-08-05T12:00:00Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(await heard)).toEqual({
      type: "review",
      prs: [
        { pr: `${GOLDEN_REPO}#12`, status: "draft", freshness: "behind" },
        { pr: `${GOLDEN_REPO}#13`, status: "open", freshness: "current" },
      ],
      behind: 1,
      unknown: 0,
      total: 2,
    });
    socket.close();
  });

  test("the page carries the anchor the message is keyed to", async () => {
    reviewNaming(wsA, "anchored");
    const html = await (await fetch(`${base}/${wsA}/r/anchored`)).text();
    // Without this the script could find the card but not its glyph, and the message
    // would describe an observation the page could not draw.
    expect(html).toContain(`data-pr="${GOLDEN_REPO}#12"`);
    expect(html).toContain(`m.type!=="review"`);
  });
});

describe("nothing reaches GitHub from a render", () => {
  test("the automatic on-view check is gone from the source, not merely unused", async () => {
    const freshness = await Bun.file("src/overseer/freshness.ts").text();
    const render = await Bun.file("src/overseer/render.ts").text();
    // `refreshOnView` was the one path from a render to the network. It is deleted
    // rather than left in place uncalled, because an uncalled path is one somebody
    // calls again.
    expect(freshness).not.toContain("refreshOnView");
    expect(render).not.toContain("refreshOnView");
    expect(render).not.toContain("checkReview");
  });

  test("rendering a review with observations makes no call", async () => {
    resetChecks();
    reviewNaming(wsA, "renders");
    const fake = countingClient(() => ({}));
    setGithubClientFactory(() => fake.client);
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base}/${wsA}/r/renders`)).status).toBe(200);
      expect(
        (await fetch(`${base}/api/reviews/renders`, { headers: { authorization: `Bearer ${keyA}` } })).status,
      ).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.calls()).toBe(0);
    setGithubClientFactory(offlineGithubClientFactory());
  });
});

describe("the orphan sweep", () => {
  test("a republish that drops a pull request collects its status row, and keeps one another review names", () => {
    // Its own workspace: the sweep asks a question of the whole workspace, so every
    // other review in this file would answer it.
    const wsC = createWorkspace("Hook C", listMembers(legacyWorkspaceId()!)[0]!.id);
    const slugOne = "sweep-one";
    const slugTwo = "sweep-two";
    setReviewPrs(wsC, slugOne, [
      { repo: GOLDEN_REPO, number: 12, repoId: REPO_ID },
      { repo: GOLDEN_REPO, number: 13, repoId: REPO_ID },
    ]);
    setReviewPrs(wsC, slugTwo, [{ repo: GOLDEN_REPO, number: 13, repoId: REPO_ID }]);
    for (const n of [12, 13]) {
      upsertPrStatus(wsC, INSTALL_A, {
        repoId: REPO_ID,
        repo: GOLDEN_REPO,
        prNumber: n,
        state: "open",
        merged: false,
        draft: false,
        headSha: n === 12 ? GOLDEN_HEAD_SHA_12 : GOLDEN_HEAD_SHA_13,
        updatedAt: 9_000_000,
      });
    }

    // v2 of the first review drops #12. Its status row is keyed per workspace, so it
    // cannot be deleted with the review_prs row that dropped it...
    setReviewPrs(wsC, slugOne, [{ repo: GOLDEN_REPO, number: 13, repoId: REPO_ID }]);
    expect(listReviewPrs(wsC, slugOne)).toHaveLength(1);
    expect(sweepOrphanPrStatus(wsC)).toBe(1);
    expect(getPrStatus(wsC, REPO_ID, 12)).toBeNull();
    // ...and #13 stays, because the second review still names it. That is the whole
    // reason the sweep asks the question of the workspace rather than of the review.
    expect(getPrStatus(wsC, REPO_ID, 13)).not.toBeNull();
  });
});
