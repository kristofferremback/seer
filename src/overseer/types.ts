// The Overseer review document, transcribed field-for-field from
// docs/overseer/data-model.md. That document is the law; this file is its shape in
// TypeScript. Fields marked "derived" are Overseer's to write and the skill may not
// author them; fields marked "authored" are the skill's and Overseer may not invent
// them. See "The dividing line" in the doc.

/** Statement kinds. Closed list: `keep` was cut, see the doc's Statement section. */
export const STATEMENT_KINDS = ["add", "change", "remove"] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const NOTE_KINDS = ["risk", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Derived: one pr is `single`, a chain of bases is `stack`, anything else is `set`. */
export type ReviewKind = "single" | "stack" | "set";

/** Derived per pr by comparing the stored head sha against GitHub. */
export type Freshness = "current" | "behind";

/** Derived: whether the ref's path at its sha is touched by a pr in the review. */
export type RefOrigin = "in_stack" | "outside";

export type HunkLineKind = "ctx" | "add" | "del";

/** Closed list: the doc's Figure block gives node state as normal | muted. */
export const FIGURE_NODE_STATES = ["normal", "muted"] as const;
export type FigureNodeState = (typeof FIGURE_NODE_STATES)[number];

/** Closed list: the doc's Figure block gives one kind, and Mermaid was rejected. */
export const FIGURE_KINDS = ["flow"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** Closed list: the doc's Payload block gives lang as json | text. */
export const PAYLOAD_LANGS = ["json", "text"] as const;
export type PayloadLang = (typeof PAYLOAD_LANGS)[number];

export type AnnotationTargetType =
  | "statement"
  | "note"
  | "group"
  | "file"
  | "hunk"
  | "summary";

export type AnnotationStatus = "open" | "answered";

/** Ordered evidence on a statement or note: ref | payload | figure | example | attachment | bundle. */
export type Evidence =
  | { type: "ref"; ref: Ref }
  | { type: "payload"; payload: Payload }
  | { type: "figure"; figure: Figure }
  | { type: "example"; example: Example }
  | { type: "attachment"; attachment: AttachmentRef }
  | { type: "bundle"; bundle: BundleRef };

export interface Review {
  /** Opaque, `rev_` + tinyId. */
  id: string;
  /** Url-safe. */
  slug: string;
  /** Derived: incremented on each publish to the same slug. */
  version: number;
  /** Authored, <= BUDGETS.chars.reviewTitle. */
  title: string;
  /** Derived. */
  kind: ReviewKind;
  /** Authored, <= 2 paragraphs, <= BUDGETS.chars.summary, constrained markdown. */
  summary: string;
  /** 1..n. */
  prs: Pr[];
  /** BUDGETS.statements.min .. the scaled maximum. */
  statements: Statement[];
  /** BUDGETS.notes.min .. BUDGETS.notes.max. */
  notes: Note[];
  /** BUDGETS.groups.min .. the scaled maximum. */
  groups: Group[];
  /** 0..n, written after publication. */
  annotations: Annotation[];
  /** Derived: every hunk of every pr, in pull request and file order. The groups
   *  partition these by id, so the walkthrough can be redrawn from the document alone. */
  hunks: Hunk[];
  /** Derived and never rendered: the pull request review comments, handed back to the
   *  skill on its next pass. See the data model's "Rendering comment threads". */
  skillContext: ReviewComment[];
  createdAt: number;
  updatedAt: number;
  /** Derived per pr, keyed by `${repo}#${number}`. */
  freshness: Record<string, Freshness>;
}

export interface Pr {
  /** Authored (the pointer): "owner/name". */
  repo: string;
  /** Authored (the pointer). */
  number: number;
  /** Derived. */
  title: string;
  /** Derived. */
  headSha: string;
  /** Derived. */
  baseSha: string;
  /** Derived. */
  baseRef: string;
  /** Derived from base_ref when it names another pr in the review, else authored. */
  parent: number | null;
  /** Derived: the GitHub login, or null when the account is gone. A deleted account
   *  renders as a visible absence rather than as a blank name. */
  author: string | null;
  /** Derived: Co-Authored-By trailers across the pr's commits, deduplicated. */
  coAuthors: string[];
  /** Derived: the pull request description, markdown as GitHub holds it. */
  body: string;
  /** Authored, <= BUDGETS.chars.prGist, one line. */
  gist: string;
  /** Authored, <= 2 sentences. */
  detail: string;
  /** A ref id. */
  detailRef: string;
  /** Derived: the distinct kinds of the statements attributed to this pr. */
  kinds: StatementKind[];
}

export interface Statement {
  id: string;
  kind: StatementKind;
  /** Authored, <= BUDGETS.chars.statementText, one line, no markup. */
  text: string;
  /** Which pull requests realize it, as `${repo}#${number}`. */
  prs: string[];
  /** Pointers backing the claim. At least one: a claim with nothing behind it does not belong on the page. */
  refs: Ref[];
  /** Authored, <= BUDGETS.chars.statementBody, constrained markdown. */
  body: string;
  /** Ordered. */
  evidence: Evidence[];
}

export interface Note {
  id: string;
  kind: NoteKind;
  /** Authored, <= BUDGETS.chars.noteText. */
  text: string;
  /** Authored, <= BUDGETS.chars.noteBody, constrained markdown. */
  body: string;
  /** 0..BUDGETS.checks.max ordered strings, each <= BUDGETS.chars.check. */
  checks: string[];
  refs: Ref[];
  evidence: Evidence[];
}

export interface Group {
  id: string;
  /** Authored, <= BUDGETS.chars.groupTitle. */
  title: string;
  /** Ascending, 1.0 = most significant. Ties broken by id. */
  significance: number;
  /** Authored, <= BUDGETS.chars.groupParagraph, constrained markdown. */
  paragraph: string;
  /** Hunk ids. Every hunk in every pr belongs to exactly one group. */
  hunks: string[];
  fileNotes: { path: string; text: string }[];
  /**
   * Derived: the dominant kind across its hunks. Resolved deliberately as
   * StatementKind (add|change|remove), not HunkLineKind: a group's mark reads
   * next to statement marks, and a group whose hunks contain both adds and
   * deletions is a change, which HunkLineKind cannot express.
   */
  kind: StatementKind;
}

/** One pull request review comment, kept for the skill and never rendered. Lives here
 *  rather than in derive.ts because it is a field of the stored document; the deriver
 *  re-exports it under the name it has always used. */
export interface ReviewComment {
  repo: string;
  prNumber: number;
  id: number;
  path: string;
  line: number | null;
  startLine: number | null;
  body: string;
  author: string | null;
  commitId: string;
  inReplyTo: number | null;
  createdAt: string;
}

/** Fully derived. The skill never writes one. */
export interface Hunk {
  id: string;
  repo: string;
  prNumber: number;
  path: string;
  sha: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface HunkLine {
  kind: HunkLineKind;
  oldNo: number | null;
  newNo: number | null;
  content: string;
  /** Character ranges within `content` that changed, for word-level rendering. */
  wordRanges: [number, number][];
}

/** A pointer, resolved and cached by Overseer. The skill writes the pointer, never the code. */
export interface Ref {
  id: string;
  repo: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Line numbers within the range. */
  highlight: number[];
  /** Derived. */
  origin: RefOrigin;
  /** Derived, cached. */
  snippet: string;
}

/** What the skill writes for a ref: a pointer, never the code. Ids are minted when it
 *  resolves. Lives here rather than in derive.ts or validate.ts because both sides of
 *  the write path read it, and validation cannot import the deriver. */
export interface RefPointer {
  id?: string;
  repo: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Line numbers within the range. */
  highlight?: number[];
}

/** How a pull request is named in `statement.prs[]` and in `review.freshness`. */
export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** The one drawing on the page: a constrained graph, rendered in the house style. */
export interface Figure {
  kind: FigureKind;
  nodes: { id: string; label: string; state: FigureNodeState }[];
  edges: { from: string; to: string; label: string }[];
}

/** A before and after pair, for contract changes. */
export interface Payload {
  lang: PayloadLang;
  /** <= BUDGETS.chars.payloadSide. */
  before: string;
  /** <= BUDGETS.chars.payloadSide. */
  after: string;
  /** Keys or line numbers changed. */
  highlight: (string | number)[];
}

/** Authored illustration. The one evidence kind that is invented rather than quoted. */
export interface Example {
  /** Syntax color when the renderer knows the language, mono otherwise. */
  lang: string;
  /** <= BUDGETS.chars.exampleText. */
  text: string;
  /** Authored, <= BUDGETS.chars.caption, required. */
  caption: string;
}

/** A file uploaded with the review. `id` is `att_` + tinyId. */
export interface AttachmentRef {
  id: string;
  /** image/* to start. */
  mediaType: string;
  /** Derived. */
  bytes: number;
  /** Authored, <= BUDGETS.chars.alt, required. */
  alt: string;
  /** Authored, <= BUDGETS.chars.caption. */
  caption: string;
}

/** A pointer to a Seer bundle in the same workspace. A resolved in-house link, not a URL. */
export interface BundleRef {
  slug: string;
  /** null = latest. */
  version: number | null;
  /** Authored, <= BUDGETS.chars.caption, required. */
  caption: string;
}

/** Deferred, but the shape is settled. `id` is `ann_` + tinyId. */
export interface Annotation {
  id: string;
  target: { type: AnnotationTargetType; id: string };
  /** For a text selection. */
  quote: string | null;
  /** Authored by the human. */
  body: string;
  status: AnnotationStatus;
  answer: { body: string; refs: Ref[] } | null;
  /** The review version it was filed against. */
  version: number;
  createdAt: number;
}

// ---- Budgets ----
//
// "Budgets are the schema, not a guideline": every cap is enforced on write and
// returns a 422 naming the field and the overage. Breadth scales with decomposition,
// not with diff size: each pull request past the first adds 2 to the statement
// ceiling and 4 to the group ceiling, to absolute ceilings of 12 and 16. Notes stay
// at 6 regardless, because things a reviewer would miss do not multiply with size.
export const BUDGETS = {
  statements: { min: 3, base: 6, perExtraPr: 2, ceiling: 12 },
  notes: { min: 0, max: 6 },
  groups: { min: 2, base: 8, perExtraPr: 4, ceiling: 16 },
  checks: { max: 5 },
  chars: {
    reviewTitle: 80, // review.title
    summary: 600, // review.summary, also <= BUDGETS.paragraphs.summary paragraphs
    prGist: 100, // pr.gist, one line
    // pr.detail is two sentences by rule, and this is the ceiling those two
    // sentences may not exceed. Every authored field carries a character cap:
    // an uncapped one is a field the write path cannot bound, and the markdown
    // scanners refuse to parse anything past the largest cap in this table.
    prDetail: 400,
    statementText: 120, // statement.text, one line, no markup
    statementBody: 1200, // statement.body
    noteText: 140, // note.text
    noteBody: 1600, // note.body
    check: 120, // each note.checks[] entry
    groupTitle: 60, // group.title
    groupParagraph: 600, // group.paragraph
    fileNote: 120, // group.file_notes[].text
    figureNodeLabel: 40, // figure.nodes[].label
    figureEdgeLabel: 24, // figure.edges[].label
    payloadSide: 800, // payload.before, payload.after
    exampleText: 800, // example.text
    caption: 120, // example.caption, attachment.caption, bundle.caption
    alt: 140, // attachment.alt
  },
  paragraphs: {
    summary: 2, // review.summary, <= 2 paragraphs
  },
} as const;

/** Max statements for a review of `prCount` pull requests. */
export function maxStatements(prCount: number): number {
  const { base, perExtraPr, ceiling } = BUDGETS.statements;
  return Math.min(ceiling, base + Math.max(0, prCount - 1) * perExtraPr);
}

/** Max groups for a review of `prCount` pull requests. */
export function maxGroups(prCount: number): number {
  const { base, perExtraPr, ceiling } = BUDGETS.groups;
  return Math.min(ceiling, base + Math.max(0, prCount - 1) * perExtraPr);
}

/** Max notes. Flat: notes do not scale with the number of pull requests. */
export function maxNotes(): number {
  return BUDGETS.notes.max;
}
