// The publish route, end to end: a real server, a real database, a fake GitHub.
// Nothing here opens a socket to github.com; the client is injected, and the derived
// facts come from patches crafted to produce exactly the golden review's hunk ids.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { zipSync, strToU8 } from "fflate";

import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createVersion, createWorkspace, db, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { getAttachment, getReviewVersion, listAttachments } from "../../src/overseer/db";
import { attachmentPath } from "../../src/store";
import { setGithubClient, type GithubClient, type GithubFile, type GithubPull } from "../../src/overseer/github";
import { validatePublish, type PublishPayload } from "../../src/overseer/validate";
import { ATT_ID_RE } from "../../src/ids";
import {
  GOLDEN_ATTACHMENT_BYTES,
  GOLDEN_BASE_SHA,
  GOLDEN_BUNDLE_SLUG,
  GOLDEN_BUNDLE_VERSION,
  GOLDEN_HEAD_SHA_12,
  GOLDEN_HEAD_SHA_13,
  GOLDEN_HUNKS,
  goldenDerived,
  goldenPayload,
} from "./fixtures/golden-review";

// ---- the fake GitHub ----

/** A unified patch whose header is exactly this range, and whose body carries the
 *  line counts that header claims: k shared context lines, then the deletions and the
 *  additions that make up the difference. The parser checks those counts, so this is
 *  the smallest patch that yields the golden hunk id. */
function patchFor(oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  const k = Math.min(oldLines, newLines);
  const lines = [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`];
  for (let i = 0; i < k; i++) lines.push(` context line ${i}`);
  for (let i = k; i < oldLines; i++) lines.push(`-removed line ${i}`);
  for (let i = k; i < newLines; i++) lines.push(`+added line ${i}`);
  return lines.join("\n");
}

function fileOf(h: { path: string; oldStart: number; oldLines: number; newStart: number; newLines: number }): GithubFile {
  return {
    filename: h.path,
    status: h.oldLines === 0 ? "added" : "modified",
    additions: h.newLines,
    deletions: h.oldLines,
    changes: h.newLines + h.oldLines,
    patch: patchFor(h.oldStart, h.oldLines, h.newStart, h.newLines),
  };
}

const PULLS: Record<number, GithubPull> = {
  12: {
    number: 12,
    title: "Put reviews behind the workspace session gate",
    body: "Reuses the bundle `session()` helper for review routes.",
    state: "open",
    user: { login: "kremback" },
    head: { sha: GOLDEN_HEAD_SHA_12, ref: "reviews-session-gate" },
    base: { sha: GOLDEN_BASE_SHA, ref: "main" },
  },
  13: {
    number: 13,
    title: "Add the review publish and read endpoints",
    body: "Two routes and their tests, on top of the gate in #12.",
    state: "open",
    user: { login: "kremback" },
    head: { sha: GOLDEN_HEAD_SHA_13, ref: "reviews-api" },
    base: { sha: GOLDEN_HEAD_SHA_12, ref: "reviews-session-gate" },
  },
};

const FILES: Record<number, GithubFile[]> = {
  12: [fileOf(GOLDEN_HUNKS.auth), fileOf(GOLDEN_HUNKS.serverGate)],
  13: [fileOf(GOLDEN_HUNKS.serverApi), fileOf(GOLDEN_HUNKS.routes), fileOf(GOLDEN_HUNKS.tests)],
};

/** A file long enough for every ref range in the golden review to land inside it. */
function blob(path: string): string {
  return Array.from({ length: 400 }, (_, i) => `// ${path} line ${i + 1}`).join("\n") + "\n";
}

let missingBlob: string | null = null;

const fake: GithubClient = {
  async getPull(_repo, number) {
    return PULLS[number]!;
  },
  async listCommits(_repo, number) {
    const message =
      number === 12
        ? "Gate reviews\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
        : "Add the publish route";
    return [{ sha: PULLS[number]!.head.sha, commit: { message, author: null }, author: null }];
  },
  async listFiles(_repo, number) {
    return FILES[number]!;
  },
  async listReviewComments(_repo, number) {
    return number === 12
      ? [
          {
            id: 900,
            path: "src/auth.ts",
            body: "Is this the same helper bundles use?",
            user: { login: "reviewer" },
            commit_id: GOLDEN_HEAD_SHA_12,
            line: 42,
            start_line: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]
      : [];
  },
  async getFileAtSha(_repo, path, sha) {
    if (missingBlob !== null && path === missingBlob) {
      throw new Error(`GitHub 404 for ${sha}:${path}`);
    }
    return blob(path);
  },
  async getPullDiff() {
    throw new Error("every file carries its own patch");
  },
};

// A parsed JSON body. The route's shapes are asserted field by field below, so the
// response is read loosely rather than restated as a type here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

// ---- the server ----

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let keyA = "";
let keyB = "";
let wsA = "";
let wsB = "";
let priorToken: string | undefined;

/** The golden payload as a publish body: the document plus the slug it lands on. */
function body(slug: string, payload: PublishPayload = goldenPayload()): string {
  return JSON.stringify({ slug, ...payload });
}

/** The golden payload with its one attachment removed, for the bare-JSON path: an
 *  attachment with no bytes behind it is a 422 by design. */
function noAttachments(): PublishPayload {
  const payload = goldenPayload();
  payload.attachments = [];
  for (const s of payload.statements) {
    s.evidence = s.evidence.filter((e) => e.type !== "attachment");
  }
  return payload;
}

function publish(slug: string, payload: PublishPayload | string, key = keyA): Promise<Response> {
  return fetch(`${base}/api/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: typeof payload === "string" ? payload : body(slug, payload),
  });
}

function counts(): { versions: number; reviews: number; attachments: number } {
  const one = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  return {
    versions: one("SELECT COUNT(*) AS n FROM review_versions"),
    reviews: one("SELECT COUNT(*) AS n FROM reviews"),
    attachments: one("SELECT COUNT(*) AS n FROM review_attachments"),
  };
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  setGithubClient(fake);
  // The route refuses to publish without a token, and tests/setup.ts deletes it so
  // nothing can reach the real API by accident. The fake client is what answers.
  priorToken = config.githubToken;
  config.githubToken = "fake-token";

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  wsA = createWorkspace("Workspace A", owner);
  wsB = createWorkspace("Workspace B", owner);
  keyA = mintApiKey(owner, wsA, "a").token;
  keyB = mintApiKey(owner, wsB, "b").token;
  // The golden review cites a bundle twice, latest and pinned at 3, so the workspace
  // publishing it holds three versions of that bundle.
  for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(wsA, GOLDEN_BUNDLE_SLUG, 10, 1);
  for (let i = 0; i < GOLDEN_BUNDLE_VERSION; i++) createVersion(wsB, GOLDEN_BUNDLE_SLUG, 10, 1);
});

afterAll(() => {
  setGithubClient(null);
  config.githubToken = priorToken;
  server.stop(true);
});

// ---- the happy path ----

describe("POST /api/reviews", () => {
  test("the golden review publishes as version 1 and is stored", async () => {
    const res = await publish("golden", noAttachments());
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.version).toBe(1);
    expect(json.slug).toBe("golden");
    expect(json.workspace).toBe(wsA);
    expect(json.warnings).toEqual([]);
    expect(json.url).toBe(`${config.baseUrl}/${wsA}/r/golden`);

    // The response document is the stored document.
    const stored = getReviewVersion(wsA, "golden", 1)!;
    expect(stored.doc).toEqual(json.document);
    expect(stored.doc.slug).toBe("golden");
    expect(stored.doc.version).toBe(1);
    expect(stored.doc.id).toMatch(/^rev_/);
    expect(stored.doc.kind).toBe("stack");
    expect(stored.doc.title).toBe(goldenPayload().title);
  });

  test("the stored document carries the derived halves the renderer needs", async () => {
    const doc = getReviewVersion(wsA, "golden", 1)!.doc;
    // Every hunk of both pull requests, and the groups partition them.
    expect(doc.hunks.map((h) => h.id).sort()).toEqual(
      Object.values(GOLDEN_HUNKS)
        .map((h) => h.id)
        .sort(),
    );
    expect(doc.groups.flatMap((g) => g.hunks).sort()).toEqual(doc.hunks.map((h) => h.id).sort());
    // Refs are resolved, not echoed: a snippet and a derived origin.
    const ref = doc.statements[0]!.refs[0]!;
    expect(ref.snippet.split("\n").length).toBe(9);
    expect(ref.origin).toBe("in_stack");
    const outside = doc.statements
      .flatMap((s) => s.refs)
      .find((r) => r.path === "src/session.ts")!;
    expect(outside.origin).toBe("outside");
    // Pull request facts and marks are derived.
    const pr12 = doc.prs.find((p) => p.number === 12)!;
    expect(pr12.title).toBe(PULLS[12]!.title);
    expect(pr12.author).toBe("kremback");
    expect(pr12.coAuthors).toEqual(["Claude Fable 5 <noreply@anthropic.com>"]);
    expect(pr12.kinds).toEqual(["add", "change", "remove"]);
    expect(doc.prs.find((p) => p.number === 13)!.parent).toBe(12);
    expect(pr12.detailRef).toContain("src/auth.ts");
    // The review comments travel with the document for the skill's next pass.
    expect(doc.skillContext.map((c) => c.id)).toEqual([900]);
  });

  test("republishing the same slug creates version 2 and keeps the review id", async () => {
    const res = await publish("golden", noAttachments());
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.version).toBe(2);
    expect(getReviewVersion(wsA, "golden", 1)!.doc.id).toBe(json.document.id);
    expect(getReviewVersion(wsA, "golden", 2)!.doc.version).toBe(2);
    // createdAt survives the republish; updatedAt moves.
    expect(json.document.createdAt).toBe(getReviewVersion(wsA, "golden", 1)!.doc.createdAt);
  });

  test("the same slug in two workspaces is two reviews", async () => {
    const a = await publish("shared-slug", noAttachments(), keyA);
    const b = await publish("shared-slug", noAttachments(), keyB);
    expect((await readJson(a)).version).toBe(1);
    expect((await readJson(b)).version).toBe(1);
    expect(getReviewVersion(wsA, "shared-slug", 1)!.doc.id).not.toBe(
      getReviewVersion(wsB, "shared-slug", 1)!.doc.id,
    );
  });
});

// ---- refusals ----

describe("publish refusals", () => {
  test("no api key -> 401", async () => {
    const res = await fetch(`${base}/api/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body("no-key", noAttachments()),
    });
    expect(res.status).toBe(401);
  });

  test("an over-budget title -> 422 carrying the validator's own error", async () => {
    const payload = noAttachments();
    payload.title = "x".repeat(90);
    const before = counts();
    const res = await publish("over-budget", payload);
    expect(res.status).toBe(422);
    const json = await readJson(res);
    // Verbatim: the route reports what step 6 computed, field and overage included.
    const expected = validatePublish(payload, goldenDerived(), null, {
      bundleExists: () => true,
    }).errors;
    expect(json.errors).toEqual(expected);
    expect(json.errors[0].field).toBe("title");
    expect(json.errors[0].overage).toBe(10);
    // Atomicity: a 422 writes nothing.
    expect(counts()).toEqual(before);
  });

  test("a ref that does not resolve -> 422 naming the path and the range", async () => {
    const before = counts();
    // A path nothing has fetched before, so the snippet cache cannot answer for it.
    const payload = noAttachments();
    const ref = payload.statements
      .flatMap((s) => s.refs)
      .find((r) => r.path === "src/session.ts")!;
    ref.path = "src/gone.ts";
    missingBlob = "src/gone.ts";
    const res = await publish("bad-ref", payload);
    missingBlob = null;
    expect(res.status).toBe(422);
    const json = await readJson(res);
    const err = json.errors.find((e: { rule: string }) => e.rule === "ref_unresolved");
    expect(err.message).toContain("src/gone.ts:8-20");
    expect(err.field).toContain("refs");
    expect(counts()).toEqual(before);
  });

  test("a slug that is not a slug -> 400", async () => {
    const res = await publish("", JSON.stringify({ slug: "Not A Slug", ...noAttachments() }));
    expect(res.status).toBe(400);
  });

  test("a body that is not JSON -> 400", async () => {
    const res = await publish("", "not json at all");
    expect(res.status).toBe(400);
  });

  test("an attachment declared with no bytes -> 422 naming it", async () => {
    const before = counts();
    const res = await publish("no-bytes", goldenPayload());
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors[0].rule).toBe("attachment_missing_part");
    expect(json.errors[0].message).toContain("att_gate");
    expect(counts()).toEqual(before);
  });
});

// ---- multipart and attachments ----

function multipart(slug: string, payload: PublishPayload, parts: [string, Blob, string][]): FormData {
  const form = new FormData();
  form.set("document", JSON.stringify({ slug, ...payload }));
  for (const [name, blobPart, filename] of parts) form.append(name, blobPart, filename);
  return form;
}

function png(): Blob {
  return new Blob([GOLDEN_ATTACHMENT_BYTES], { type: "image/png" });
}

function postForm(form: FormData, key = keyA): Promise<Response> {
  return fetch(`${base}/api/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
}

describe("attachments", () => {
  test("a multipart publish lands an attachment row and its blob", async () => {
    const res = await postForm(
      multipart("with-image", goldenPayload(), [["att_gate", png(), "gate.png"]]),
    );
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.version).toBe(1);

    const rows = listAttachments(wsA, "with-image");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.id).toMatch(ATT_ID_RE);
    expect(row.version).toBe(1);
    expect(row.alt).toBe(goldenPayload().attachments[0]!.alt);
    expect(row.caption).toBe(goldenPayload().attachments[0]!.caption!);
    expect(row.media_type.startsWith("image/")).toBe(true);
    expect(row.bytes).toBeGreaterThan(0);
    expect(getAttachment(wsA, "with-image", row.id)!.id).toBe(row.id);
    // The other workspace cannot read it by id.
    expect(getAttachment(wsB, "with-image", row.id)).toBeNull();

    // Row then bytes: the blob is in the store under the same id.
    const stored = Bun.file(attachmentPath(wsA, row.id));
    expect(await stored.exists()).toBe(true);
    expect(stored.size).toBe(row.bytes);

    // The document names the stored attachment, not the authored handle.
    const doc = getReviewVersion(wsA, "with-image", 1)!.doc;
    const evidence = doc.statements
      .flatMap((s) => s.evidence)
      .find((e) => e.type === "attachment")!;
    expect(evidence.type).toBe("attachment");
    if (evidence.type !== "attachment") throw new Error("unreachable");
    expect(evidence.attachment.id).toBe(row.id);
    expect(evidence.attachment.bytes).toBe(row.bytes);
    expect(evidence.attachment.alt).toBe(row.alt);
  });

  test("a part no attachment declares -> 422 naming it", async () => {
    const before = counts();
    const res = await postForm(
      multipart("stray-part", noAttachments(), [["att_stray", png(), "stray.png"]]),
    );
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors[0].rule).toBe("attachment_part_undeclared");
    expect(json.errors[0].message).toContain("att_stray");
    expect(counts()).toEqual(before);
  });

  test("a part that is not an image -> 422", async () => {
    const before = counts();
    const res = await postForm(
      multipart("not-an-image", goldenPayload(), [
        ["att_gate", new Blob(["PK not a picture"], { type: "application/zip" }), "gate.zip"],
      ]),
    );
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors[0].rule).toBe("attachment_not_image");
    expect(counts()).toEqual(before);
  });

  test("a part claiming .png that is not png bytes -> 422", async () => {
    const res = await postForm(
      multipart("lying-part", goldenPayload(), [
        ["att_gate", new Blob(["<html>error page</html>"], { type: "image/png" }), "gate.png"],
      ]),
    );
    expect(res.status).toBe(422);
    expect((await readJson(res)).errors[0].rule).toBe("attachment_not_image");
  });
});

// ---- misconfiguration ----

describe("without GITHUB_TOKEN", () => {
  test("publishing -> 503 naming the variable, while bundles still upload", async () => {
    const held = config.githubToken;
    config.githubToken = undefined;
    try {
      const res = await publish("no-token", noAttachments());
      expect(res.status).toBe(503);
      expect((await readJson(res)).error).toContain("GITHUB_TOKEN");

      const zip = await fetch(`${base}/api/bundles/still-works`, {
        method: "PUT",
        headers: { authorization: `Bearer ${keyA}` },
        body: zipSync({ "index.html": strToU8("<!doctype html>still here") }),
      });
      expect(zip.status).toBe(200);
      expect((await readJson(zip)).version).toBe(1);
    } finally {
      config.githubToken = held;
    }
  });
});
