import { test, expect, beforeAll, describe } from "bun:test";
// Env is set by tests/setup.ts before these app modules import.
import { migrate } from "../../src/migrate";
import {
  answerAnnotation,
  createAnnotation,
  createAttachment,
  createReviewVersion,
  deleteAnnotation,
  getAnnotation,
  getAttachment,
  getFreshness,
  getReview,
  getReviewRead,
  getReviewVersion,
  getSnippet,
  listAnnotations,
  listFreshness,
  listReviewVersions,
  putSnippet,
  reopenAnnotation,
  setFreshness,
  setReviewRead,
  type ReviewDoc,
} from "../../src/overseer/db";
import {
  attachmentKey,
  attachmentPath,
  openAttachment,
  saveAttachment,
} from "../../src/store";
import { config } from "../../src/config";
import { ATT_ID_RE, ANN_ID_RE } from "../../src/ids";
import { join } from "node:path";

beforeAll(() => {
  migrate();
});

const WS_A = "ws_aaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbb";

function doc(title: string): Omit<ReviewDoc, "version"> {
  return {
    id: "rev_0000000000",
    slug: "the-review",
    title,
    kind: "single",
    summary: "It does the thing.",
    prs: [],
    statements: [],
    notes: [],
    groups: [],
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

  test("two workspaces hold the same slug independently", () => {
    createReviewVersion(WS_A, "shared-slug", doc("A one"));
    createReviewVersion(WS_A, "shared-slug", doc("A two"));
    const b = createReviewVersion(WS_B, "shared-slug", doc("B one"));

    expect(b).toBe(1);
    expect(getReview(WS_A, "shared-slug")?.latest_version).toBe(2);
    expect(getReview(WS_B, "shared-slug")?.latest_version).toBe(1);
    expect(getReviewVersion(WS_B, "shared-slug", 1)?.doc.title).toBe("B one");
    expect(getReviewVersion(WS_B, "shared-slug", 2)).toBeNull();
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

    const filed = getAnnotation(id)!;
    expect(filed.status).toBe("open");
    expect(filed.answer).toBeNull();
    expect(filed.quote).toBe("the quoted span");
    expect(filed.target).toEqual({ type: "statement", id: "st_1" });
    expect(filed.version).toBe(1);

    answerAnnotation(id, { body: "The gate runs first.", refs: [] });
    const answered = getAnnotation(id)!;
    expect(answered.status).toBe("answered");
    expect(answered.answer?.body).toBe("The gate runs first.");

    reopenAnnotation(id);
    expect(getAnnotation(id)?.status).toBe("open");
    expect(getAnnotation(id)?.answer).toBeNull();

    deleteAnnotation(id);
    expect(getAnnotation(id)).toBeNull();
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
    expect(getAnnotation(id)?.quote).toBeNull();
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

describe("freshness", () => {
  test("the observed head sha is per pull request and updates in place", () => {
    expect(getFreshness(WS_A, "fresh", 12)).toBeNull();

    setFreshness(WS_A, "fresh", 12, "aaa111");
    setFreshness(WS_A, "fresh", 13, "bbb222");
    expect(getFreshness(WS_A, "fresh", 12)?.observed_head_sha).toBe("aaa111");
    expect(listFreshness(WS_A, "fresh").map((f) => f.pr_number)).toEqual([12, 13]);

    setFreshness(WS_A, "fresh", 12, "ccc333");
    expect(getFreshness(WS_A, "fresh", 12)?.observed_head_sha).toBe("ccc333");
    expect(listFreshness(WS_A, "fresh")).toHaveLength(2);
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

    const row = getAttachment(id)!;
    expect(row.workspace_id).toBe(WS_A);
    expect(row.slug).toBe("with-shot");
    expect(row.version).toBe(1);
    expect(row.media_type).toBe("image/png");
    expect(row.bytes).toBe(1234);
    expect(row.alt).toBe("The chart");
    expect(row.caption).toBe("Figure 1");
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
});
