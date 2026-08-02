// The golden review: a valid publish payload that exercises every entity kind and
// every evidence kind, with the derived facts it validates against. It returns zero
// errors and zero warnings from validatePublish(), and later steps build on it rather
// than inventing a second document that drifts from this one.
//
// Shape: two pull requests on one repo, a stack (the second is based on the first),
// five hunks across four files, partitioned into two groups. Three statements, two
// notes (one risk, one note), one attachment, one bundle.

import { hunkId } from "../../../src/overseer/diff";
import type { Hunk, HunkLine } from "../../../src/overseer/types";
import type { DerivedFacts, PublishPayload } from "../../../src/overseer/validate";

export const GOLDEN_REPO = "acme/seer";
export const GOLDEN_BASE_SHA = "1111111111111111111111111111111111111111";
export const GOLDEN_HEAD_SHA_12 = "2222222222222222222222222222222222222222";
export const GOLDEN_HEAD_SHA_13 = "3333333333333333333333333333333333333333";
export const GOLDEN_BUNDLE_SLUG = "overseer-contact-sheet";

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

export function goldenDerived(): DerivedFacts {
  return {
    prs: [
      { repo: GOLDEN_REPO, number: 12, hunks: [H_AUTH, H_SERVER_GATE] },
      { repo: GOLDEN_REPO, number: 13, hunks: [H_SERVER_API, H_ROUTES, H_TESTS] },
    ],
  };
}

/** The workspace this golden review publishes into holds exactly one bundle. */
export function goldenBundleExists(slug: string, version: number | null): boolean {
  return slug === GOLDEN_BUNDLE_SLUG && (version === null || version === 3);
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
