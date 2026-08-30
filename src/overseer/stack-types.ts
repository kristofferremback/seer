// The two immutable documents a stack of promoted reviews is made of.
//
// A MANIFEST pins order: which lineages, in which bottom-to-top order, at which exact
// revision and — once it exists — which exact account. It is published the moment the
// chain is known and never changes; later movement is a successor manifest, never an edit.
// A stack ACCOUNT is what a witness published over one manifest: the summary and the stack
// groups that partition every pinned member account group exactly once. There is one
// account per manifest, so a manifest version is the only counter a stack has.
//
// Everything a member owns — source revisions, accounts, reads, its own witness workflow —
// stays the member's. A stack references; it never copies.

import type { StageExample } from "../stage/types";

export type StackSource = "native" | "inferred";
export type StackMemberStatus = "live" | "merged" | "removed";
export type StackRemovedReason = "unstacked" | "merged" | "closed" | "detached";
export type StackManifestReason = "created" | "refresh" | "account-ready";

/** One member as a manifest pins it. `accountId` is null until that member's revision has
 *  an account; the first manifest on which every member has one is the account-ready one. */
export interface StackMemberSnapshot {
  lineageId: string;
  lineageSlug: string;
  prNumber: number;
  title: string;
  revisionId: string;
  revision: number;
  accountId: string | null;
  accountVersion: number | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  status: StackMemberStatus;
  removedReason: StackRemovedReason | null;
}

export interface StackManifestDoc {
  identity: {
    stackId: string;
    slug: string;
    title: string;
    version: number;
    predecessorVersion: number;
    reason: StackManifestReason;
    createdAt: string;
  };
  repository: { repo: string; repoId: number; baseRef: string };
  /** Provenance. Outside the member comparison on purpose: a native and an inferred reading
   *  of the same four pull requests pin the same members and differ only here. */
  source: {
    kind: StackSource;
    providerStackId: number | null;
    providerStackNumber: number | null;
    observedAt: string | null;
  };
  /** Bottom-to-top. `index + 1` is the member position used in ids and routes. */
  members: StackMemberSnapshot[];
  projects: string[];
}

/** One reference from a stack group to one member account group. Exact on purpose: a
 *  reference that named a lineage without its pinned revision and account could mean a
 *  group that no longer exists. */
export interface StackGroupRef {
  lineageId: string;
  revision: number;
  accountVersion: number;
  groupId: string;
}

export interface StackGroup {
  id: string;
  title: string;
  body: string;
  attention?: string;
  examples: StageExample[];
  members: StackGroupRef[];
}

export interface StackAccountDoc {
  identity: {
    stackId: string;
    slug: string;
    manifestId: string;
    version: number;
    createdAt: string;
  };
  witness: {
    summary: string;
    agent: { name: string; model: string };
    userId: string;
    keyId: string;
  };
  groups: StackGroup[];
}

export const STACK_SCHEMA_VERSION = 1;
export const MIN_STACK_MEMBERS = 2;
export const MAX_STACK_MEMBERS = 16;
export const MAX_STACK_GROUPS = 16;
export const MAX_STACK_GROUP_REFS = 256;
export const MAX_STACK_TOTAL_REFS = 256;
export const STACK_TITLE_MAX = 80;
/** Paging bounds over retained rows: canonical changes to a page, and the sum of old and new
 *  hunk lines over them. Rows can bound counts; a diff line is unbounded, so bytes are
 *  measured on the response rather than promised by the plan. */
export const MAX_STACK_PAGE_CHANGES = 100;
export const MAX_STACK_PAGE_HUNK_LINES = 8_000;
/** The size a page is expected to stay under, asserted by the suite on the budget fixture. */
export const STACK_PAGE_HTML_TARGET_BYTES = 2 * 1024 * 1024;
/** The hard response limit. A page over this is not served as is. Its complete item list
 *  is byte-paged into ordinary member links, and every fallback response is measured
 *  against this same bound. */
export const STACK_PAGE_HTML_MAX_BYTES = 4 * 1024 * 1024;
