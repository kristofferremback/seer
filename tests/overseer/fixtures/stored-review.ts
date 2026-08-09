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

function ref(id: string, path: string, sha: string): Ref {
  return {
    id,
    repo: GOLDEN_REPO,
    sha,
    path,
    startLine: 40,
    endLine: 48,
    highlight: [42],
    origin: "in_stack",
    snippet: "// a resolved snippet\n",
  };
}

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
