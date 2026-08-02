// The golden review: a valid publish payload that exercises every entity kind and
// every evidence kind, with the derived facts it validates against. It returns zero
// errors and zero warnings from validatePublish(), and later steps build on it rather
// than inventing a second document that drifts from this one.
//
// Shape: two pull requests on one repo, a stack (the second is based on the first),
// five hunks across four files, partitioned into two groups. Four statements covering
// all three kinds (add, change, remove), two notes (one risk, one note), one
// attachment, two bundle references (one latest, one pinned). One ref points at a path
// no pull request touches, so `origin` derives as `outside` and the renderer's
// outside-ref label has a case here rather than one invented per step.

import { hunkId } from "../../../src/overseer/diff";
import type { Hunk, HunkLine } from "../../../src/overseer/types";
import type { DerivedFacts, PublishPayload } from "../../../src/overseer/validate";

export const GOLDEN_REPO = "acme/seer";
export const GOLDEN_BASE_SHA = "1111111111111111111111111111111111111111";
export const GOLDEN_HEAD_SHA_12 = "2222222222222222222222222222222222222222";
export const GOLDEN_HEAD_SHA_13 = "3333333333333333333333333333333333333333";
export const GOLDEN_BUNDLE_SLUG = "overseer-contact-sheet";
/** The pinned version the workspace holds, alongside latest. */
export const GOLDEN_BUNDLE_VERSION = 3;
/** A path no pull request in the review touches: refs into it derive origin `outside`. */
export const GOLDEN_OUTSIDE_PATH = "src/session.ts";

function line(kind: HunkLine["kind"], oldNo: number | null, newNo: number | null, content: string): HunkLine {
  return { kind, oldNo, newNo, content, wordRanges: [] };
}

/** A hunk with plausible lines, so a renderer test has something to draw. */
export function makeHunk(args: {
  prNumber: number;
  path: string;
  sha: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}): Hunk {
  const { prNumber, path, sha, oldStart, oldLines, newStart, newLines } = args;
  const lines: HunkLine[] = [
    line("ctx", oldStart, newStart, "export function gate(req: Request) {"),
    line("del", oldStart + 1, null, "  return true;"),
    line("add", null, newStart + 1, "  return session(req) !== null;"),
    line("ctx", oldStart + 2, newStart + 2, "}"),
  ];
  return {
    id: hunkId(prNumber, path, oldStart, oldLines, newStart, newLines),
    repo: GOLDEN_REPO,
    prNumber,
    path,
    sha,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

const H_AUTH = makeHunk({
  prNumber: 12,
  path: "src/auth.ts",
  sha: GOLDEN_HEAD_SHA_12,
  oldStart: 40,
  oldLines: 6,
  newStart: 40,
  newLines: 9,
});
const H_SERVER_GATE = makeHunk({
  prNumber: 12,
  path: "src/server.ts",
  sha: GOLDEN_HEAD_SHA_12,
  oldStart: 120,
  oldLines: 4,
  newStart: 120,
  newLines: 7,
});
const H_SERVER_API = makeHunk({
  prNumber: 13,
  path: "src/server.ts",
  sha: GOLDEN_HEAD_SHA_13,
  oldStart: 300,
  oldLines: 5,
  newStart: 303,
  newLines: 11,
});
const H_ROUTES = makeHunk({
  prNumber: 13,
  path: "src/routes/reviews.ts",
  sha: GOLDEN_HEAD_SHA_13,
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 32,
});
const H_TESTS = makeHunk({
  prNumber: 13,
  path: "tests/reviews.test.ts",
  sha: GOLDEN_HEAD_SHA_13,
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 24,
});

export const GOLDEN_HUNKS = {
  auth: H_AUTH,
  serverGate: H_SERVER_GATE,
  serverApi: H_SERVER_API,
  routes: H_ROUTES,
  tests: H_TESTS,
};

/** The validator's narrow view of the derived facts, taken from the full review below
 *  so the two cannot disagree about which pull request carries which hunk. */
export function goldenDerived(): DerivedFacts {
  return {
    prs: goldenDerivedReview().prs.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      hunks: pr.hunks,
    })),
  };
}

/** The slug and version this review publishes as. */
export const GOLDEN_SLUG = "reviews-get-a-workspace";
export const GOLDEN_VERSION = 1;
/** The bytes stored for `att_gate`: a 1x1 png, small enough to check in. */
export const GOLDEN_ATTACHMENT_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** The derived side of a pull request, as the data model specifies it: everything
 *  Overseer fetches rather than the skill authoring it. `goldenDerived()` is the
 *  validator's narrow view of this; the publish route, storage and the renderer read
 *  the whole thing, from here rather than from a second fixture that drifts. */
export interface GoldenDerivedPr {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  parent: number | null;
  author: string | null;
  coAuthors: string[];
  body: string;
  hunks: Hunk[];
}

export interface GoldenDerivedReview {
  slug: string;
  version: number;
  prs: GoldenDerivedPr[];
  /** Attachment id to its stored bytes and media type. */
  attachments: { id: string; mediaType: string; bytes: Uint8Array }[];
}

export function goldenDerivedReview(): GoldenDerivedReview {
  return {
    slug: GOLDEN_SLUG,
    version: GOLDEN_VERSION,
    prs: [
      {
        repo: GOLDEN_REPO,
        number: 12,
        title: "Put reviews behind the workspace session gate",
        headSha: GOLDEN_HEAD_SHA_12,
        baseSha: GOLDEN_BASE_SHA,
        baseRef: "main",
        parent: null,
        author: "kremback",
        coAuthors: ["Claude Fable 5 <noreply@anthropic.com>"],
        body: "Reuses the bundle `session()` helper for review routes.",
        hunks: [H_AUTH, H_SERVER_GATE],
      },
      {
        repo: GOLDEN_REPO,
        number: 13,
        title: "Add the review publish and read endpoints",
        headSha: GOLDEN_HEAD_SHA_13,
        baseSha: GOLDEN_HEAD_SHA_12,
        baseRef: "reviews-session-gate",
        parent: 12,
        author: "kremback",
        coAuthors: [],
        body: "Two routes and their tests, on top of the gate in #12.",
        hunks: [H_SERVER_API, H_ROUTES, H_TESTS],
      },
    ],
    attachments: [
      { id: "att_gate", mediaType: "image/png", bytes: GOLDEN_ATTACHMENT_BYTES },
    ],
  };
}

/** The workspace this golden review publishes into holds exactly one bundle. */
export function goldenBundleExists(slug: string, version: number | null): boolean {
  return slug === GOLDEN_BUNDLE_SLUG && (version === null || version === GOLDEN_BUNDLE_VERSION);
}

export function goldenPayload(): PublishPayload {
  return {
    title: "Reviews get a private workspace and an api",
    summary:
      "Reviews carry private source, so they move behind a workspace session and " +
      "stop being public by link.\n\n" +
      "The gate is the one `session()` helper bundles already use, and the publish " +
      "route lands on top of it rather than beside it.",
    prs: [
      {
        repo: GOLDEN_REPO,
        number: 12,
        gist: "Put reviews behind a workspace session",
        detail: "The bundle gate is reused verbatim. Nothing about bundle access changes.",
        detailRef: {
          repo: GOLDEN_REPO,
          sha: GOLDEN_HEAD_SHA_12,
          path: "src/auth.ts",
          startLine: 40,
          endLine: 48,
          highlight: [42],
        },
        parent: null,
      },
      {
        repo: GOLDEN_REPO,
        number: 13,
        gist: "Add the publish and read endpoints",
        detail: "Two routes and their tests. The renderer is not in this pull request.",
        detailRef: {
          repo: GOLDEN_REPO,
          sha: GOLDEN_HEAD_SHA_13,
          path: "src/routes/reviews.ts",
          startLine: 1,
          endLine: 32,
        },
        parent: 12,
      },
    ],
    statements: [
      {
        id: "st_gate",
        kind: "change",
        text: "Review pages require a workspace session",
        prs: [`${GOLDEN_REPO}#12`],
        refs: [
          {
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_12,
            path: "src/auth.ts",
            startLine: 40,
            endLine: 48,
            highlight: [41, 42],
          },
        ],
        body:
          "A review quotes private source, so it cannot be public by link the way a " +
          "bundle is. The gate is the existing `session()` check, called from the " +
          "review routes:\n\n" +
          "- bundles keep their public-by-link behaviour\n" +
          "- reviews answer 404 to a session-less reader, not 403\n",
        evidence: [
          {
            type: "ref",
            ref: {
              repo: GOLDEN_REPO,
              sha: GOLDEN_HEAD_SHA_12,
              path: "src/server.ts",
              startLine: 120,
              endLine: 126,
            },
          },
          {
            type: "figure",
            figure: {
              kind: "flow",
              nodes: [
                { id: "req", label: "request", state: "normal" },
                { id: "gate", label: "session gate", state: "normal" },
                { id: "page", label: "review page", state: "normal" },
                { id: "miss", label: "404", state: "muted" },
              ],
              edges: [
                { from: "req", to: "gate", label: "" },
                { from: "gate", to: "page", label: "session" },
                { from: "gate", to: "miss", label: "none" },
              ],
            },
          },
        ],
      },
      {
        id: "st_api",
        kind: "add",
        text: "Publishing a review is one POST that returns the resolved document",
        prs: [`${GOLDEN_REPO}#13`],
        refs: [
          {
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_13,
            path: "src/routes/reviews.ts",
            startLine: 1,
            endLine: 32,
          },
        ],
        body:
          "The skill publishes a whole document in one call and gets back what " +
          "Overseer resolved, plus any warnings. A 422 names the field and the overage.",
        evidence: [
          {
            type: "payload",
            payload: {
              lang: "json",
              before: '{ "public": true }',
              after: '{ "workspace_id": "ws_1", "public": false }',
              highlight: ["public", "workspace_id"],
            },
          },
          {
            type: "example",
            example: {
              lang: "bash",
              text: "curl -X POST /api/reviews -d @review.json",
              caption: "Publishing a review from the skill",
            },
          },
          {
            type: "bundle",
            bundle: {
              slug: GOLDEN_BUNDLE_SLUG,
              version: null,
              caption: "The contact sheet this review was drawn against",
            },
          },
        ],
      },
      {
        id: "st_tests",
        kind: "add",
        text: "The route contract is covered by tests",
        prs: [`${GOLDEN_REPO}#13`, `${GOLDEN_REPO}#12`],
        refs: [
          {
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_13,
            path: "tests/reviews.test.ts",
            startLine: 1,
            endLine: 24,
          },
        ],
        body: "Publish, read back, and the session gate, one test each.",
        evidence: [
          {
            type: "attachment",
            attachment: { id: "att_gate" },
          },
        ],
      },
      {
        id: "st_public_link",
        kind: "remove",
        text: "Public-by-link access to a review is gone",
        prs: [`${GOLDEN_REPO}#12`],
        refs: [
          {
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_12,
            path: "src/server.ts",
            startLine: 120,
            endLine: 126,
          },
          {
            // Outside the change: the helper the gate leans on, untouched by either
            // pull request. Its origin derives as `outside`.
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_12,
            path: GOLDEN_OUTSIDE_PATH,
            startLine: 8,
            endLine: 20,
            highlight: [12],
          },
        ],
        body:
          "The unauthenticated branch of the review route is deleted rather than " +
          "narrowed. A reader without a session gets the same 404 a missing review " +
          "gets, so the existence of a review leaks nothing.",
        evidence: [
          {
            type: "bundle",
            bundle: {
              slug: GOLDEN_BUNDLE_SLUG,
              version: GOLDEN_BUNDLE_VERSION,
              caption: "The contact sheet as it stood before the gate",
            },
          },
        ],
      },
    ],
    notes: [
      {
        id: "nt_session_cookie",
        kind: "risk",
        text: "A stale session cookie renders the page but not its refs",
        body:
          "The gate runs once per request, and ref snippets are fetched after it. A " +
          "session that expires between the two renders an empty snippet rather than " +
          "a sign-in prompt.",
        checks: [
          "Open a review with an expired cookie and confirm the page redirects",
          "Confirm no snippet is served without a live session",
        ],
        refs: [
          {
            repo: GOLDEN_REPO,
            sha: GOLDEN_HEAD_SHA_12,
            path: "src/server.ts",
            startLine: 121,
            endLine: 124,
          },
        ],
        evidence: [],
      },
      {
        id: "nt_slug_reuse",
        kind: "note",
        text: "Publishing to an existing slug creates a version, it does not overwrite",
        body: "Same as bundles. The prior version stays readable at `/r/:slug/v/:n`.",
        checks: [],
        refs: [],
        evidence: [],
      },
    ],
    groups: [
      {
        id: "gr_gate",
        title: "The session gate",
        significance: 1,
        paragraph:
          "The gate itself and its one call site. `src/auth.ts` gains the helper and " +
          "`src/server.ts` calls it before the review routes.",
        hunks: [H_AUTH.id, H_SERVER_GATE.id],
        fileNotes: [
          { path: "src/auth.ts", text: "The helper, reused from the bundle path" },
          { path: "src/server.ts", text: "Calls the gate ahead of the review routes" },
        ],
      },
      {
        id: "gr_api",
        title: "The publish api",
        significance: 2,
        paragraph: "Two routes, their wiring, and the tests that hold the contract.",
        hunks: [H_SERVER_API.id, H_ROUTES.id, H_TESTS.id],
        fileNotes: [{ path: "tests/reviews.test.ts", text: "Publish and read back" }],
      },
    ],
    attachments: [
      {
        id: "att_gate",
        mediaType: "image/png",
        alt: "A review page showing the sign-in prompt for a session-less reader",
        caption: "The gate as a reader sees it",
      },
    ],
  };
}
