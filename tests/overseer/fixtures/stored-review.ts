// The golden review as a stored document, written straight to the database.
//
// The read path never re-validates a published document, so a read test does not
// need the publish route, its fake GitHub or its ref resolver to get a realistic row
// in front of the reader. It needs the shape: the golden pull requests with their
// real head SHAs, so freshness has something to compare against, and one of each
// authored entity so the response can be checked field by field. Publishing is
// covered end to end by routes.test.ts.

import { createReviewVersion, type ReviewDoc } from "../../../src/overseer/db";
import { prKey, type Ref, type Review } from "../../../src/overseer/types";
import {
  GOLDEN_HUNKS,
  GOLDEN_REPO,
  goldenDerivedReview,
  goldenPayload,
} from "./golden-review";

/**
 * The nine lines every ref in this fixture quotes, at 40..48 of the file it names.
 *
 * They used to be the placeholder `// a resolved snippet`, which was enough while
 * nothing compared a snippet to anything. The context route does: a ref's stored lines
 * are the only evidence that the file it fetches is the file the page already showed,
 * so a fixture whose snippet could not be true of any file left that check untestable.
 *
 * The first three are the golden hunk's own new-side lines, so one file can satisfy
 * both the hunk check and the ref check at once.
 */
export const GOLDEN_REF_LINES = [
  "export function gate(req: Request) {",
  "  return session(req) !== null;",
  "}",
  "",
  "export function readable(req: Request): string[] {",
  "  const user = sessionUser(req);",
  "  if (!user) return [];",
  "  return listUserWorkspaces(user.id).map((w) => w.id);",
  "}",
];

export const GOLDEN_REF_START = 40;
export const GOLDEN_REF_END = GOLDEN_REF_START + GOLDEN_REF_LINES.length - 1;

export function goldenRef(id: string, path: string, sha: string): Ref {
  return {
    id,
    repo: GOLDEN_REPO,
    sha,
    path,
    startLine: GOLDEN_REF_START,
    endLine: GOLDEN_REF_END,
    highlight: [42],
    origin: "in_stack",
    snippet: GOLDEN_REF_LINES.join("\n"),
  };
}

const ref = goldenRef;

/** The golden review as it sits in `review_versions`, minus the fields the store
 *  owns: `id`, `slug` and `version` are written by createReviewVersion. */
export function goldenStoredDoc(): Omit<ReviewDoc, "id" | "slug" | "version"> {
  const derived = goldenDerivedReview();
  const payload = goldenPayload();
  const hunks = derived.prs.flatMap((pr) => pr.hunks);
  const now = Date.now();
  return {
    title: payload.title,
    kind: "stack",
    authorIntent: payload.authorIntent,
    summary: payload.summary,
    prs: derived.prs.map((pr, i) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      baseRef: pr.baseRef,
      parent: pr.parent,
      author: pr.author,
      coAuthors: pr.coAuthors,
      body: pr.body,
      gist: payload.prs[i]!.gist,
      detail: payload.prs[i]!.detail,
      detailRef: `ref_pr_${pr.number}`,
      kinds: ["change"],
    })),
    statements: [
      {
        id: "st_gate",
        kind: "change",
        text: "Reviews move behind the workspace session gate",
        prs: [prKey(GOLDEN_REPO, 12)],
        refs: [ref("ref_st_gate", "src/auth.ts", derived.prs[0]!.headSha)],
        body: "The gate is the helper bundles already use.",
        evidence: [],
      },
    ],
    notes: [
      {
        id: "no_keys",
        kind: "risk",
        text: "A key minted before the gate still reads its own workspace",
        body: "Keys are workspace scoped already.",
        checks: ["Read a review with a foreign key and expect a 404"],
        refs: [],
        evidence: [],
      },
    ],
    codeDesign: {
      placement: payload.codeDesign.placement,
      modules: [
        {
          ...payload.codeDesign.modules[0]!,
          refs: [ref("ref_mod_gate", "src/auth.ts", derived.prs[0]!.headSha)],
        },
      ],
      coverage: [
        {
          ...payload.codeDesign.coverage[0]!,
          refs: [ref("ref_cov_routes", "src/server.ts", derived.prs[0]!.headSha)],
        },
      ],
    },
    groups: [
      {
        id: "gr_gate",
        title: "The gate",
        significance: 1,
        paragraph: "The session check and the routes it covers.",
        hunks: hunks.map((h) => h.id),
        fileNotes: [{ path: GOLDEN_HUNKS.auth.path, text: "The helper itself" }],
        kind: "change",
      },
    ],
    hunks,
    skillContext: [],
    unaccounted: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Publish the golden document to (workspace, slug) without going through the route.
 *  Returns the version it landed as, so a caller can republish for a second one. */
export function storeGoldenReview(wsId: string, slug: string): number {
  return createReviewVersion(wsId, slug, goldenStoredDoc());
}

/** The full document a read returns: the stored one with the two moving parts back on. */
export type ReadDocument = ReviewDoc & Pick<Review, "annotations" | "freshness">;
