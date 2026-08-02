// Review storage. The schema is created by src/migrate.ts (v3); this module only
// holds the queries, on the same connection every other part of Seer uses.
//
// A review versions exactly like a bundle: `reviews` carries the head pointer and
// each publish appends an immutable `review_versions` row holding the whole
// resolved document as JSON. The renderer reads one row. Annotations, read state
// and freshness are mutable and live outside the document, in their own tables,
// so writing them never rewrites a published version.
import { db } from "../db";
import { tinyId } from "../ids";
import type {
  Annotation,
  AnnotationStatus,
  AnnotationTargetType,
  Ref,
  Review,
} from "./types";

/** What a published version stores: the document minus the parts kept in tables.
 *
 *  `Group.hunks` holds hunk ids, and `Review.hunks` holds the `Hunk` bodies they name,
 *  so a version row redraws the walkthrough on its own. Both land in this one `doc`
 *  column; the alternative, a second column, would let a version row exist with its
 *  lines missing. Nothing else may be added to `review_versions`. */
export type ReviewDoc = Omit<Review, "annotations" | "freshness">;

export interface ReviewRow {
  workspace_id: string;
  slug: string;
  latest_version: number;
  created_at: number;
}

export interface ReviewVersionRow {
  workspace_id: string;
  slug: string;
  version: number;
  created_at: number;
  doc: ReviewDoc;
}

interface RawVersionRow {
  workspace_id: string;
  slug: string;
  version: number;
  created_at: number;
  doc: string;
}

// ---- reviews and versions ----

export function getReview(wsId: string, slug: string): ReviewRow | null {
  return db
    .query<ReviewRow, [string, string]>(
      "SELECT * FROM reviews WHERE workspace_id = ? AND slug = ?",
    )
    .get(wsId, slug);
}

export function listReviews(wsId: string): ReviewRow[] {
  return db
    .query<ReviewRow, [string]>(
      "SELECT * FROM reviews WHERE workspace_id = ? ORDER BY created_at DESC",
    )
    .all(wsId);
}

export function getReviewVersion(
  wsId: string,
  slug: string,
  version: number,
): ReviewVersionRow | null {
  const row = db
    .query<RawVersionRow, [string, string, number]>(
      "SELECT * FROM review_versions WHERE workspace_id = ? AND slug = ? AND version = ?",
    )
    .get(wsId, slug, version);
  return row ? { ...row, doc: JSON.parse(row.doc) as ReviewDoc } : null;
}

/** Version metadata, newest first. The documents stay out of it: the revision
 *  timeline lists many versions and needs none of their bodies. */
export function listReviewVersions(
  wsId: string,
  slug: string,
): { version: number; created_at: number }[] {
  return db
    .query<{ version: number; created_at: number }, [string, string]>(
      "SELECT version, created_at FROM review_versions " +
        "WHERE workspace_id = ? AND slug = ? ORDER BY version DESC",
    )
    .all(wsId, slug);
}

/** Publish a document to a slug, creating the review on first publish. Returns the
 *  new version number. Mirrors createVersion() for bundles: head pointer and the
 *  version row move in one transaction, so a concurrent publish cannot observe a
 *  latest_version that has no row behind it.
 *
 *  The three key-derived fields are owned here, never taken from the caller: `slug`
 *  and `version` come from the row the document is stored under, and `id` is minted on
 *  the first publish and carried forward from the previous version on every republish.
 *  A stored document therefore always names itself correctly, and a review keeps one
 *  identity for its whole life. */
export const createReviewVersion = db.transaction(
  (wsId: string, slug: string, doc: Omit<ReviewDoc, "id" | "slug" | "version">): number => {
    const now = Date.now();
    const existing = getReview(wsId, slug);
    const version = (existing?.latest_version ?? 0) + 1;
    let id: string;
    if (existing) {
      const prior = getReviewVersion(wsId, slug, existing.latest_version);
      if (!prior) {
        throw new Error(
          `Review ${wsId}/${slug} has latest_version ${existing.latest_version} with no version row behind it`,
        );
      }
      id = prior.doc.id;
    } else {
      id = tinyId("rev");
    }
    if (existing) {
      db.run("UPDATE reviews SET latest_version = ? WHERE workspace_id = ? AND slug = ?", [
        version,
        wsId,
        slug,
      ]);
    } else {
      db.run(
        "INSERT INTO reviews (workspace_id, slug, latest_version, created_at) VALUES (?, ?, ?, ?)",
        [wsId, slug, version, now],
      );
    }
    db.run(
      "INSERT INTO review_versions (workspace_id, slug, version, doc, created_at) VALUES (?, ?, ?, ?, ?)",
      [wsId, slug, version, JSON.stringify({ ...doc, id, slug, version }), now],
    );
    return version;
  },
) as (
  wsId: string,
  slug: string,
  doc: Omit<ReviewDoc, "id" | "slug" | "version">,
) => number;

// ---- attachments ----

export interface AttachmentRow {
  id: string;
  workspace_id: string;
  slug: string;
  version: number;
  media_type: string;
  bytes: number;
  alt: string;
  caption: string;
  created_at: number;
}

/** Record an uploaded attachment. The blob itself goes to the store under the id
 *  this returns, which doubles as the URL capability. */
export function createAttachment(
  wsId: string,
  slug: string,
  version: number,
  mediaType: string,
  bytes: number,
  alt: string,
  caption: string,
  /** The publish path mints the id before the document that names it is built, and
   *  passes it here. Default: minted for a caller that has no document to write into. */
  id: string = tinyId("att"),
): string {
  db.run(
    "INSERT INTO review_attachments " +
      "(id, workspace_id, slug, version, media_type, bytes, alt, caption, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, wsId, slug, version, mediaType, bytes, alt, caption, Date.now()],
  );
  return id;
}

/** Scoped like the annotation accessors: the owning workspace and slug are part of
 *  the WHERE clause, so a route holding only an id from the URL misses rather than
 *  reading another workspace's attachment. */
export function getAttachment(wsId: string, slug: string, id: string): AttachmentRow | null {
  return db
    .query<AttachmentRow, [string, string, string]>(
      "SELECT * FROM review_attachments WHERE workspace_id = ? AND slug = ? AND id = ?",
    )
    .get(wsId, slug, id);
}

export function listAttachments(wsId: string, slug: string): AttachmentRow[] {
  return db
    .query<AttachmentRow, [string, string]>(
      "SELECT * FROM review_attachments WHERE workspace_id = ? AND slug = ? ORDER BY created_at ASC",
    )
    .all(wsId, slug);
}

// ---- annotations ----

interface RawAnnotationRow {
  id: string;
  workspace_id: string;
  slug: string;
  target_type: AnnotationTargetType;
  target_id: string;
  quote: string | null;
  body: string;
  status: AnnotationStatus;
  answer: string | null;
  version: number;
  created_at: number;
}

function toAnnotation(row: RawAnnotationRow): Annotation {
  return {
    id: row.id,
    target: { type: row.target_type, id: row.target_id },
    quote: row.quote,
    body: row.body,
    status: row.status,
    answer: row.answer ? (JSON.parse(row.answer) as { body: string; refs: Ref[] }) : null,
    version: row.version,
    createdAt: row.created_at,
  };
}

/** File an annotation against the review, recording the version it was filed
 *  against. Annotations belong to the review, not to a version: a question asked on
 *  pass one is still open on pass three. */
export function createAnnotation(
  wsId: string,
  slug: string,
  target: { type: AnnotationTargetType; id: string },
  body: string,
  version: number,
  quote: string | null = null,
): string {
  const id = tinyId("ann");
  db.run(
    "INSERT INTO review_annotations " +
      "(id, workspace_id, slug, target_type, target_id, quote, body, status, answer, version, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)",
    [id, wsId, slug, target.type, target.id, quote, body, version, Date.now()],
  );
  return id;
}

/** Read one annotation. Every accessor below takes the owning workspace and slug and
 *  puts them in the WHERE clause, so a route holding only an id from the URL cannot
 *  reach across workspaces: the wrong call misses rather than succeeding. */
export function getAnnotation(wsId: string, slug: string, id: string): Annotation | null {
  const row = db
    .query<RawAnnotationRow, [string, string, string]>(
      "SELECT * FROM review_annotations WHERE workspace_id = ? AND slug = ? AND id = ?",
    )
    .get(wsId, slug, id);
  return row ? toAnnotation(row) : null;
}

export function listAnnotations(wsId: string, slug: string): Annotation[] {
  return db
    .query<RawAnnotationRow, [string, string]>(
      "SELECT * FROM review_annotations WHERE workspace_id = ? AND slug = ? ORDER BY created_at ASC",
    )
    .all(wsId, slug)
    .map(toAnnotation);
}

/** Answer an open annotation. Answering is what flips the status: `answered` is
 *  never set without an answer body behind it. */
export function answerAnnotation(
  wsId: string,
  slug: string,
  id: string,
  answer: { body: string; refs: Ref[] },
): void {
  db.run(
    "UPDATE review_annotations SET status = 'answered', answer = ? " +
      "WHERE workspace_id = ? AND slug = ? AND id = ?",
    [JSON.stringify(answer), wsId, slug, id],
  );
}

/** Withdraw an answer: back to open, and the answer goes with it. */
export function reopenAnnotation(wsId: string, slug: string, id: string): void {
  db.run(
    "UPDATE review_annotations SET status = 'open', answer = NULL " +
      "WHERE workspace_id = ? AND slug = ? AND id = ?",
    [wsId, slug, id],
  );
}

export function deleteAnnotation(wsId: string, slug: string, id: string): void {
  db.run("DELETE FROM review_annotations WHERE workspace_id = ? AND slug = ? AND id = ?", [
    wsId,
    slug,
    id,
  ]);
}

// ---- read state ----

export interface ReadStateRow {
  workspace_id: string;
  slug: string;
  user_id: string;
  version: number;
  opened_at: number;
}

/** The version this reader last opened. The delta view's default base. */
export function getReviewRead(wsId: string, slug: string, userId: string): ReadStateRow | null {
  return db
    .query<ReadStateRow, [string, string, string]>(
      "SELECT * FROM review_reads WHERE workspace_id = ? AND slug = ? AND user_id = ?",
    )
    .get(wsId, slug, userId);
}

export function setReviewRead(
  wsId: string,
  slug: string,
  userId: string,
  version: number,
): void {
  db.run(
    "INSERT OR REPLACE INTO review_reads (workspace_id, slug, user_id, version, opened_at) " +
      "VALUES (?, ?, ?, ?, ?)",
    [wsId, slug, userId, version, Date.now()],
  );
}

// ---- freshness ----

export interface FreshnessRow {
  workspace_id: string;
  slug: string;
  repo: string;
  pr_number: number;
  observed_head_sha: string;
  checked_at: number;
}

/** The head SHA last seen on GitHub for one pull request in this review. Keyed by
 *  repo as well as number: pull request 12 exists in every repository. */
export function getFreshness(
  wsId: string,
  slug: string,
  repo: string,
  prNumber: number,
): FreshnessRow | null {
  return db
    .query<FreshnessRow, [string, string, string, number]>(
      "SELECT * FROM review_freshness " +
        "WHERE workspace_id = ? AND slug = ? AND repo = ? AND pr_number = ?",
    )
    .get(wsId, slug, repo, prNumber);
}

export function listFreshness(wsId: string, slug: string): FreshnessRow[] {
  return db
    .query<FreshnessRow, [string, string]>(
      "SELECT * FROM review_freshness WHERE workspace_id = ? AND slug = ? " +
        "ORDER BY repo ASC, pr_number ASC",
    )
    .all(wsId, slug);
}

export function setFreshness(
  wsId: string,
  slug: string,
  repo: string,
  prNumber: number,
  observedHeadSha: string,
): void {
  db.run(
    "INSERT OR REPLACE INTO review_freshness " +
      "(workspace_id, slug, repo, pr_number, observed_head_sha, checked_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [wsId, slug, repo, prNumber, observedHeadSha, Date.now()],
  );
}

// ---- ref snippet cache ----

// Refs are SHA-pinned, so a cached file at (repo, sha, path) can never go stale:
// the same key always names the same bytes. The resolver is what holds that true, by
// refusing a ref whose sha is not a full sha before it ever reaches this table. A put on an existing key replaces it,
// which writes back identical bytes and keeps two concurrent fetches of the same file
// from colliding on the primary key.
export function getSnippet(repo: string, sha: string, path: string): string | null {
  const row = db
    .query<{ content: string }, [string, string, string]>(
      "SELECT content FROM ref_snippets WHERE repo = ? AND sha = ? AND path = ?",
    )
    .get(repo, sha, path);
  return row?.content ?? null;
}

/** `fetchedAt` is when the bytes came off GitHub, which is what the sweep ages rows by.
 *  It defaults to now and is passed explicitly only by a caller holding an older
 *  reading of the clock. */
export function putSnippet(
  repo: string,
  sha: string,
  path: string,
  content: string,
  fetchedAt = Date.now(),
): void {
  db.run(
    "INSERT OR REPLACE INTO ref_snippets (repo, sha, path, content, fetched_at) VALUES (?, ?, ?, ?, ?)",
    [repo, sha, path, content, fetchedAt],
  );
}

/** Drop cached files fetched before `cutoff`. The eviction policy itself lives with
 *  the resolver that fills the table; this is only the query. */
export function sweepSnippets(cutoff: number): number {
  return db.run("DELETE FROM ref_snippets WHERE fetched_at < ?", [cutoff]).changes;
}
