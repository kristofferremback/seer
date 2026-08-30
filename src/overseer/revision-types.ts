// The two immutable documents a promoted review is made of, and the one piece of
// workflow state that is deliberately not in either of them.
//
// The split is the whole design. A REVISION is the evidence: what the source was, who
// built it, and nothing a witness said, because it is published before any witness has
// finished and it must never change afterwards. An ACCOUNT is what a witness published
// over a revision: the summary, the semantic partition, the decisions and risks worth
// pointing at, and the material it cites. A revision may carry no account, one, or
// several; the code stream underneath is the same either way, which is why a pinned
// evidence URL keeps reading as evidence after an account lands.
//
// The witness REQUEST is neither. "Pending", "failed" and "retrying" are true only
// until they are not, so putting them in a document would make an immutable row lie the
// moment the workflow moved. It lives in its own table and is read alongside.

import type { StageGroup } from "../stage/types";

/** The states a witness request passes through. `retrying` is derived rather than
 *  stored: it is `pending` with a nonzero retry count, so one row cannot claim to be
 *  waiting for a first answer and waiting for a second at once. */
export type WitnessRequestState = "pending" | "failed" | "published";
/** `superseded` is derived too, and from a different table again: a later revision was
 *  appended while this request was still unanswered, so the code it was asked about is no
 *  longer the newest. It is not a stored state, because the stored CHECK is what a
 *  previous image reads and a word it does not know would refuse the whole review. */
export type WitnessWorkflowWord = "pending" | "failed" | "retrying" | "published" | "superseded";

export interface RevisionAgent {
  name: string;
  model: string;
}

/**
 * What the builder said when the capture was made, carried onto the revision.
 *
 * Nullable, and that is a product decision rather than a defensive one: task 5 ingests
 * pull requests that no Seer builder ever initiated, and a revision over one of those
 * has no intent to state. Inventing an empty one would make "the builder said nothing"
 * indistinguishable from "there was no builder".
 */
export interface RevisionBuilder {
  intent: string;
  context: string;
  agent: RevisionAgent;
  userId: string | null;
  keyId: string | null;
}

/** The V1 evidence document. Exact source facts, nullable builder facts, Project
 *  slugs — and no witness object of any kind. */
export interface RevisionDoc {
  identity: {
    lineageId: string;
    slug: string;
    revision: number;
    title: string;
    createdAt: string;
  };
  source: {
    captureId: string;
    repo: string;
    repoId: number;
    branch: string;
    /** The lineage's first base, kept so a later revision can say what moved. */
    originalBaseRef: string;
    originalBaseSha: string;
    baseRef: string;
    sourceHeadSha: string;
    baseTipSha: string;
    mergeBaseSha: string;
  };
  builder: RevisionBuilder | null;
  projects: string[];
}

/** Where a focus item points. An anchor names capture material by its opaque id and
 *  owns nothing: two focus items may point at the same change, and a change no focus
 *  item mentions is still in the partition. */
export type FocusAnchor =
  | { type: "change"; id: string }
  | { type: "material"; id: string }
  | { type: "file"; id: string };

/** One bounded thing worth stopping on: a decision that was made, or a risk that was
 *  taken. Both are anchored, so neither can be a floating opinion about the branch. */
export interface FocusItem {
  id: string;
  kind: "decision" | "risk";
  title: string;
  body: string;
  anchors: FocusAnchor[];
}

/** Material the account cites, which must already exist in the same workspace. An
 *  account cannot mint an attachment or a bundle; it can only point at one. */
export type EvidenceRef =
  | {
      kind: "attachment";
      id: string;
      reviewSlug: string;
      mediaType: string;
      bytes: number;
      alt: string;
      caption: string;
    }
  | { kind: "bundle"; slug: string; version: number };

/** The V1 account document: the witness summary, the complete semantic partition of
 *  the revision's capture, the anchored focus items, and the evidence cited. */
export interface AccountDoc {
  identity: {
    lineageId: string;
    slug: string;
    revision: number;
    version: number;
    createdAt: string;
  };
  witness: {
    summary: string;
    agent: RevisionAgent;
    userId: string;
    keyId: string;
  };
  groups: StageGroup[];
  focus: FocusItem[];
  evidence: EvidenceRef[];
}

export const FOCUS_KINDS = ["decision", "risk"] as const;
export const MAX_FOCUS_ITEMS = 24;
export const MAX_FOCUS_ANCHORS = 16;
export const MAX_EVIDENCE_REFS = 16;
export const FOCUS_TITLE_MAX = 80;
export const FOCUS_BODY_MAX = 1_200;
export const REVISION_TITLE_MAX = 80;

/** How many canonical changes one navigation page of an evidence revision may carry.
 *  A file seam is not an authored group, so this is a legibility bound rather than a
 *  budget: a page nobody can hold in their head is not navigation. */
export const MAX_EVIDENCE_PAGE_CHANGES = 100;
/** Missing material and leafless files cost space too. This is the actual response
 * bound; the change constant remains as the narrower code-stream statement. */
export const MAX_EVIDENCE_PAGE_ITEMS = 100;
