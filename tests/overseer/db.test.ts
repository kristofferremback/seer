import { test, expect, beforeAll, describe } from "bun:test";
// Env is set by tests/setup.ts before these app modules import.
import { db } from "../../src/db";
import { migrate } from "../../src/migrate";
import {
  answerAnnotation,
  createAnnotation,
  createAttachment,
  createReviewVersion,
  deleteAnnotation,
  getAnnotation,
  getAttachment,
  getReview,
  getReviewRead,
  getReviewVersion,
  getSnippet,
  listAnnotations,
  listAttachments,
  listReviewVersions,
  listReviews,
  putSnippet,
  reopenAnnotation,
  setReviewRead,
  type ReviewDoc,
} from "../../src/overseer/db";
import { listReviewPrs, setReviewPrs } from "../../src/overseer/installations";
import {
  attachmentKey,
  attachmentLocation,
  attachmentPath,
  openAttachment,
  saveAttachment,
} from "../../src/store";
import { config } from "../../src/config";
import { ATT_ID_RE, ANN_ID_RE, REV_ID_RE } from "../../src/ids";
import { join } from "node:path";

beforeAll(() => {
  migrate();
});

const WS_A = "ws_aaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbb";

// The store owns id, slug and version, so the fixture carries none of them.
function doc(title: string): Omit<ReviewDoc, "id" | "slug" | "version"> {
  return {
    title,
    kind: "single",
    summary: "It does the thing.",
    prs: [],
    statements: [],
    notes: [],
    groups: [],
    hunks: [],
    attachments: [],
    skillContext: [],
    unaccounted: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe("review versions", () => {
  test("first publish is version 1 and creates the review head", () => {
    const version = createReviewVersion(WS_A, "first", doc("First pass"));
    expect(version).toBe(1);
    const review = getReview(WS_A, "first");
    expect(review?.latest_version).toBe(1);
    expect(review?.slug).toBe("first");
  });

  test("republishing the same slug appends version 2 and moves the head", () => {
    createReviewVersion(WS_A, "again", doc("First pass"));
    const second = createReviewVersion(WS_A, "again", doc("Second pass"));
    expect(second).toBe(2);
    expect(getReview(WS_A, "again")?.latest_version).toBe(2);

    // Both versions stay readable, and each holds the document it was published with.
    expect(getReviewVersion(WS_A, "again", 1)?.doc.title).toBe("First pass");
    expect(getReviewVersion(WS_A, "again", 2)?.doc.title).toBe("Second pass");
    // The stored document carries its own version number.
    expect(getReviewVersion(WS_A, "again", 2)?.doc.version).toBe(2);
  });

  test("the stored document names its own slug and keeps one id across versions", () => {
    createReviewVersion(WS_A, "self-naming", doc("First pass"));
    createReviewVersion(WS_A, "self-naming", doc("Second pass"));

    const v1 = getReviewVersion(WS_A, "self-naming", 1)!;
    const v2 = getReviewVersion(WS_A, "self-naming", 2)!;
    expect(v1.doc.slug).toBe("self-naming");
    expect(v2.doc.slug).toBe("self-naming");
    expect(REV_ID_RE.test(v1.doc.id)).toBe(true);
    expect(v2.doc.id).toBe(v1.doc.id);

    // A different review under a different slug is a different identity.
    createReviewVersion(WS_A, "other-naming", doc("Elsewhere"));
    expect(getReviewVersion(WS_A, "other-naming", 1)?.doc.id).not.toBe(v1.doc.id);
  });

  test("two workspaces hold the same slug independently", () => {
    createReviewVersion(WS_A, "shared-slug", doc("A one"));
    createReviewVersion(WS_A, "shared-slug", doc("A two"));
    const b = createReviewVersion(WS_B, "shared-slug", doc("B one"));

    expect(b).toBe(1);
    expect(getReview(WS_A, "shared-slug")?.latest_version).toBe(2);
    expect(getReview(WS_B, "shared-slug")?.latest_version).toBe(1);
    expect(getReviewVersion(WS_B, "shared-slug", 1)?.doc.title).toBe("B one");
    expect(getReviewVersion(WS_B, "shared-slug", 2)).toBeNull();

    // Same slug, two reviews: each document names the slug it lives under and the two
    // identities are distinct.
    const aDoc = getReviewVersion(WS_A, "shared-slug", 2)!.doc;
    const bDoc = getReviewVersion(WS_B, "shared-slug", 1)!.doc;
    expect(aDoc.slug).toBe("shared-slug");
    expect(bDoc.slug).toBe("shared-slug");
    expect(bDoc.id).not.toBe(aDoc.id);
  });

  test("listReviews is scoped to the workspace, newest first", () => {
    createReviewVersion(WS_B, "listed-b-one", doc("one"));
    createReviewVersion(WS_B, "listed-b-two", doc("two"));

    const slugs = listReviews(WS_B).map((r) => r.slug);
    expect(slugs).toContain("listed-b-one");
    expect(slugs).toContain("listed-b-two");
    expect(slugs).not.toContain("first"); // WS_A only
    expect(listReviews("ws_cccccccccc")).toEqual([]);
  });

  test("listReviewVersions is newest first and scoped to the workspace", () => {
    createReviewVersion(WS_A, "listed", doc("one"));
    createReviewVersion(WS_A, "listed", doc("two"));
    createReviewVersion(WS_A, "listed", doc("three"));
    expect(listReviewVersions(WS_A, "listed").map((v) => v.version)).toEqual([3, 2, 1]);
    expect(listReviewVersions(WS_B, "listed")).toEqual([]);
  });

  test("an unknown review reads as null, never as a throw", () => {
    expect(getReview(WS_A, "nope")).toBeNull();
    expect(getReviewVersion(WS_A, "nope", 1)).toBeNull();
  });
});

describe("annotations", () => {
  test("filed open, answered, reopened, deleted", () => {
    createReviewVersion(WS_A, "annotated", doc("Pass one"));
    const id = createAnnotation(
      WS_A,
      "annotated",
      { type: "statement", id: "st_1" },
      "Why is this safe?",
      1,
      "the quoted span",
    );
    expect(ANN_ID_RE.test(id)).toBe(true);

    const filed = getAnnotation(WS_A, "annotated", id)!;
    expect(filed.status).toBe("open");
    expect(filed.answer).toBeNull();
    expect(filed.quote).toBe("the quoted span");
    expect(filed.target).toEqual({ type: "statement", id: "st_1" });
    expect(filed.version).toBe(1);

    answerAnnotation(WS_A, "annotated", id, { body: "The gate runs first.", refs: [] });
    const answered = getAnnotation(WS_A, "annotated", id)!;
    expect(answered.status).toBe("answered");
    expect(answered.answer?.body).toBe("The gate runs first.");

    reopenAnnotation(WS_A, "annotated", id);
    expect(getAnnotation(WS_A, "annotated", id)?.status).toBe("open");
    expect(getAnnotation(WS_A, "annotated", id)?.answer).toBeNull();

    deleteAnnotation(WS_A, "annotated", id);
    expect(getAnnotation(WS_A, "annotated", id)).toBeNull();
  });

  test("a question filed against version 1 survives a republish", () => {
    createReviewVersion(WS_A, "surviving", doc("Pass one"));
    const id = createAnnotation(WS_A, "surviving", { type: "summary", id: "summary" }, "Still?", 1);
    createReviewVersion(WS_A, "surviving", doc("Pass two"));

    const open = listAnnotations(WS_A, "surviving");
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(id);
    expect(open[0]!.version).toBe(1); // still tied to the version it was filed against
  });

  test("annotations are scoped to their workspace and slug", () => {
    createAnnotation(WS_A, "scoped", { type: "note", id: "n1" }, "a", 1);
    expect(listAnnotations(WS_B, "scoped")).toEqual([]);
    expect(listAnnotations(WS_A, "other-slug")).toEqual([]);
  });

  test("quote is optional and reads back as null", () => {
    const id = createAnnotation(WS_A, "unquoted", { type: "hunk", id: "h1" }, "no selection", 1);
    expect(getAnnotation(WS_A, "unquoted", id)?.quote).toBeNull();
  });

  test("every accessor is scoped, so another workspace cannot read or touch one", () => {
    const id = createAnnotation(WS_A, "guarded", { type: "note", id: "n1" }, "mine", 1);

    expect(getAnnotation(WS_B, "guarded", id)).toBeNull();
    expect(getAnnotation(WS_A, "other-slug", id)).toBeNull();

    answerAnnotation(WS_B, "guarded", id, { body: "not yours", refs: [] });
    expect(getAnnotation(WS_A, "guarded", id)?.status).toBe("open");

    answerAnnotation(WS_A, "guarded", id, { body: "mine", refs: [] });
    reopenAnnotation(WS_B, "guarded", id);
    expect(getAnnotation(WS_A, "guarded", id)?.status).toBe("answered");

    deleteAnnotation(WS_B, "guarded", id);
    expect(getAnnotation(WS_A, "guarded", id)).not.toBeNull();

    deleteAnnotation(WS_A, "guarded", id);
    expect(getAnnotation(WS_A, "guarded", id)).toBeNull();
  });
});

describe("read state", () => {
  test("the last opened version is per user and overwrites in place", () => {
    expect(getReviewRead(WS_A, "read-me", "usr_1")).toBeNull();

    setReviewRead(WS_A, "read-me", "usr_1", 1);
    expect(getReviewRead(WS_A, "read-me", "usr_1")?.version).toBe(1);

    setReviewRead(WS_A, "read-me", "usr_1", 3);
    expect(getReviewRead(WS_A, "read-me", "usr_1")?.version).toBe(3);

    // A second reader has their own base version.
    setReviewRead(WS_A, "read-me", "usr_2", 2);
    expect(getReviewRead(WS_A, "read-me", "usr_1")?.version).toBe(3);
    expect(getReviewRead(WS_A, "read-me", "usr_2")?.version).toBe(2);
  });
});

// This release stops writing `review_freshness` and leaves it standing; v6 drops it a
// release later, so the previous image keeps finding what it reads through a redeploy.
// The observation it used to hold lives in `review_prs` joined to `github_pr_status`,
// so the survivor is asserted beside the table rather than on its own.
describe("the freshness table the write path abandoned", () => {
  test("review_freshness still exists after migration in this release", () => {
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("review_freshness");
    expect(row).not.toBeNull();
    // Standing and readable, not just named in sqlite_master.
    expect(db.query("SELECT * FROM review_freshness").all()).toEqual([]);
  });

  test("the pull requests a review names are still recorded, per repo", () => {
    setReviewPrs(WS_A, "fresh", [
      { repo: "owner/one", number: 12, repoId: 1 },
      { repo: "owner/two", number: 12, repoId: 2 },
      { repo: "owner/one", number: 13, repoId: 1 },
    ]);
    expect(listReviewPrs(WS_A, "fresh").map((r) => `${r.repo}#${r.pr_number}`)).toEqual([
      "owner/one#12",
      "owner/one#13",
      "owner/two#12",
    ]);
  });
});

describe("ref snippet cache", () => {
  test("get after put returns identical content, keyed by repo, sha and path", () => {
    const content = "export function gate() {\n  return true;\n}\n";
    expect(getSnippet("owner/name", "sha1", "src/auth.ts")).toBeNull();

    putSnippet("owner/name", "sha1", "src/auth.ts", content);
    expect(getSnippet("owner/name", "sha1", "src/auth.ts")).toBe(content);
  });

  test("a different sha, path or repo misses", () => {
    putSnippet("owner/name", "sha-a", "src/x.ts", "at sha a");
    expect(getSnippet("owner/name", "sha-b", "src/x.ts")).toBeNull();
    expect(getSnippet("owner/name", "sha-a", "src/y.ts")).toBeNull();
    expect(getSnippet("other/name", "sha-a", "src/x.ts")).toBeNull();
    expect(getSnippet("owner/name", "sha-a", "src/x.ts")).toBe("at sha a");
  });
});

describe("attachments", () => {
  test("the row records media type, size and the authored alt", () => {
    createReviewVersion(WS_A, "with-shot", doc("Pass one"));
    const id = createAttachment(WS_A, "with-shot", 1, "image/png", 1234, "The chart", "Figure 1");
    expect(ATT_ID_RE.test(id)).toBe(true);

    const row = getAttachment(WS_A, "with-shot", id)!;
    expect(row.workspace_id).toBe(WS_A);
    expect(row.slug).toBe("with-shot");
    expect(row.version).toBe(1);
    expect(row.media_type).toBe("image/png");
    expect(row.bytes).toBe(1234);
    expect(row.alt).toBe("The chart");
    expect(row.caption).toBe("Figure 1");

    // Scoped like the annotation accessors: the id alone reaches nothing.
    expect(getAttachment(WS_B, "with-shot", id)).toBeNull();
    expect(getAttachment(WS_A, "other-slug", id)).toBeNull();
  });

  test("listAttachments returns one review's attachments and nobody else's", () => {
    createReviewVersion(WS_A, "gallery", doc("Pass one"));
    const first = createAttachment(WS_A, "gallery", 1, "image/png", 10, "One", "");
    const second = createAttachment(WS_A, "gallery", 1, "image/png", 20, "Two", "");

    expect(listAttachments(WS_A, "gallery").map((a) => a.id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(listAttachments(WS_B, "gallery")).toEqual([]);
    expect(listAttachments(WS_A, "no-such-review")).toEqual([]);
  });

  test("the blob round-trips through the disk store", async () => {
    const id = createAttachment(WS_A, "with-shot", 1, "image/png", 4, "Four bytes", "");
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await saveAttachment(WS_A, id, data);
    expect(attachmentPath(WS_A, id)).toBe(
      join(config.dataDir, "review-attachments", WS_A, id),
    );

    const opened = await openAttachment(WS_A, id);
    expect(opened).not.toBeNull();
    const bytes = new Uint8Array(await new Response(opened as Blob).arrayBuffer());
    expect(bytes).toEqual(data);
  });

  test("a missing blob opens as null rather than throwing", async () => {
    expect(await openAttachment(WS_A, "att_zzzzzzzzzz")).toBeNull();
  });

  test("the S3 key mirrors the on-disk layout", () => {
    expect(attachmentKey(WS_A, "att_xxxxxxxxxx")).toBe(
      `review-attachments/${WS_A}/att_xxxxxxxxxx`,
    );
  });

  test("the logged location is the on-disk path when there is no S3", () => {
    expect(attachmentLocation(WS_A, "att_xxxxxxxxxx")).toBe(
      attachmentPath(WS_A, "att_xxxxxxxxxx"),
    );
  });
});
