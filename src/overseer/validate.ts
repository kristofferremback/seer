// Publish validation. Every line of the data model's "What Overseer validates on
// write", as one pure function: no database, no GitHub client, no clock. It takes the
// authored payload, the facts Overseer derived for it, and the prior version's
// document when the slug already exists, and answers with errors and warnings.
//
// Purity is the point. The publish route turns an error list into a 422 and a warning
// list into the publish response, and every rule below is testable without a socket or
// a file. The two facts this module cannot compute itself, whether a bundle exists in
// the workspace and whether a ref resolves at its sha, are handled the same way: the
// bundle check is an injected predicate, and ref resolution belongs to the resolver in
// derive.ts, which fetches, and so cannot live behind a pure signature. Note the
// asymmetry: the bundle predicate is injected here, refResolver() is not, so the
// publish route has to call it and turn a RefResolveError into a 422 itself. That is
// the route's obligation, not this module's, and step 7 owes it a test: a payload whose
// ref does not resolve at its sha is a 422 naming the path and the range, and this
// function will not catch it because it never fetches. What this
// module can check about a ref without fetching it, ref_unpinned, ref_range and
// ref_highlight_outside, it does check.

import { validate as validateMarkdown, validateInline } from "./markdown";
import {
  BUDGETS,
  maxGroups,
  maxNotes,
  maxStatements,
  prKey,
  FIGURE_KINDS,
  FIGURE_NODE_STATES,
  NOTE_KINDS,
  PAYLOAD_LANGS,
  STATEMENT_KINDS,
  type Figure,
  type Hunk,
  type NoteKind,
  type Payload,
  type RefPointer,
  type StatementKind,
} from "./types";

// ---- what the skill writes ----

/** A ref as authored. One shape, defined in types.ts, so the deriver and the validator
 *  cannot drift apart the first time a field is added. */
export type RefPointerInput = RefPointer;

export interface ExampleInput {
  lang: string;
  text: string;
  caption: string;
}

export interface AttachmentEvidenceInput {
  id: string;
}

export interface BundleEvidenceInput {
  slug: string;
  version: number | null;
  caption: string;
}

export type EvidenceInput =
  | { type: "ref"; ref: RefPointerInput }
  | { type: "payload"; payload: Payload }
  | { type: "figure"; figure: Figure }
  | { type: "example"; example: ExampleInput }
  | { type: "attachment"; attachment: AttachmentEvidenceInput }
  | { type: "bundle"; bundle: BundleEvidenceInput };

/** The closed list from the data model. Anything else is not evidence Overseer stores. */
export const EVIDENCE_KINDS = [
  "ref",
  "payload",
  "figure",
  "example",
  "attachment",
  "bundle",
] as const satisfies readonly EvidenceInput["type"][];

export interface PrInput {
  repo: string;
  number: number;
  gist: string;
  detail: string;
  detailRef: RefPointerInput;
  parent?: number | null;
}

export interface StatementInput {
  id: string;
  kind: StatementKind;
  text: string;
  /** `${repo}#${number}` per prKey(). */
  prs: string[];
  refs: RefPointerInput[];
  body: string;
  evidence: EvidenceInput[];
}

export interface NoteInput {
  id: string;
  kind: NoteKind;
  text: string;
  body: string;
  checks: string[];
  refs: RefPointerInput[];
  evidence: EvidenceInput[];
}

export interface GroupInput {
  id: string;
  title: string;
  significance: number;
  paragraph: string;
  hunks: string[];
  fileNotes: { path: string; text: string }[];
}

export interface AttachmentInput {
  id: string;
  mediaType: string;
  alt: string;
  /** Optional: the data model marks alt required and leaves caption to the author. */
  caption?: string;
}

/** The whole document the skill publishes, in one shot. */
export interface PublishPayload {
  title: string;
  summary: string;
  prs: PrInput[];
  statements: StatementInput[];
  notes: NoteInput[];
  groups: GroupInput[];
  attachments: AttachmentInput[];
}

/** The facts side, narrowed to what validation reads. Structural on purpose: this
 *  module imports nothing that talks to GitHub or to SQLite. */
export interface DerivedFacts {
  prs: { repo: string; number: number; hunks: Hunk[] }[];
}

/** The prior version's stored document, narrowed to the ids validation compares. */
export interface PriorDoc {
  statements: { id: string }[];
  notes: { id: string }[];
  groups: { id: string }[];
  /** Attachments share the id namespace within a version, so they share it across
   *  versions too: an id that named an attachment cannot come back as a statement. */
  attachments?: { id: string }[];
}

export interface ValidateOptions {
  /** Does this bundle exist in the publishing workspace? Injected: the check is a
   *  database read, and this module does not do those. Absent means nothing resolves,
   *  which fails loudly rather than passing a bundle nobody looked up. */
  bundleExists?: (slug: string, version: number | null) => boolean;
}

export interface ValidationError {
  /** JSON path into the payload, e.g. `statements[2].text`. */
  field: string;
  rule: string;
  message: string;
  /** How far past a cap, in the cap's own unit. Only on cap violations. */
  overage?: number;
  /** How far below a floor, in the floor's own unit. Only on below_minimum. A
   *  magnitude, kept apart from `overage` so a consumer never renders "over by -1". */
  shortfall?: number;
}

export interface ValidationWarning {
  field: string;
  rule: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  /** Evenly respaced significance values, when two neighbours had drifted within
   *  REINDEX_EPSILON of each other. Null when the authored values are fine as written. */
  significance: { id: string; significance: number }[] | null;
}

/** Neighbouring significance values closer than this cannot be trusted to keep two
 *  groups apart, so the write path respaces the whole list. */
export const REINDEX_EPSILON = 1e-6;

/** The media types an attachment may be stored as. An allowlist rather than an
 *  `image/*` prefix: the stored value is echoed back as the response content-type when
 *  the bytes are served, and a header value is not a place for free text. SVG is left
 *  out: it is a document that can carry script, and these bytes are served from the
 *  same origin as the page. */
export const ATTACHMENT_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// ---- helpers ----

/** Code points, not UTF-16 units: an emoji in a title is one character to its author.
 *  Anything that is not text has no length to measure; the rule that owns the field
 *  reports its absence by name, and this returns 0 rather than throwing on the spread. */
function len(s: unknown): number {
  return typeof s === "string" ? [...s].length : 0;
}

/** Text this rule expects to exist. A number or an absent field is a 422 naming the
 *  field, not a crash inside whichever helper reads it first. */
function isText(errors: ValidationError[], field: string, value: unknown): value is string {
  if (typeof value === "string") return true;
  errors.push({
    field,
    rule: "not_text",
    message: `${field} is ${value === undefined ? "absent" : JSON.stringify(value)}, and it is text`,
  });
  return false;
}

function capText(
  errors: ValidationError[],
  field: string,
  value: string,
  cap: number,
): void {
  if (typeof value !== "string") return;
  const n = len(value);
  if (n > cap) {
    errors.push({
      field,
      rule: "cap_chars",
      message: `${field} is ${n} characters, the cap is ${cap}`,
      overage: n - cap,
    });
  }
}

function capCount(
  errors: ValidationError[],
  field: string,
  count: number,
  cap: number,
  unit: string,
): void {
  if (count > cap) {
    errors.push({
      field,
      rule: "cap_count",
      message: `${field} has ${count} ${unit}, the cap is ${cap}`,
      overage: count - cap,
    });
  }
}

function minCount(
  errors: ValidationError[],
  field: string,
  count: number,
  min: number,
  unit: string,
): void {
  if (count < min) {
    errors.push({
      field,
      rule: "below_minimum",
      message: `${field} has ${count} ${unit}, the minimum is ${min}`,
      shortfall: min - count,
    });
  }
}

function required(errors: ValidationError[], field: string, value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ field, rule: "required", message: `${field} is required` });
    return false;
  }
  return true;
}

/** A multi-line authored body: the constrained markdown subset from step 5. */
function checkBody(errors: ValidationError[], field: string, value: string): void {
  if (typeof value !== "string") return;
  const result = validateMarkdown(value);
  if (!result.ok) {
    errors.push({
      field,
      rule: "markdown_construct",
      message: `${field}: ${result.message}`,
    });
  }
}

/** A one-line field: plain text and inline code, nothing else. */
function checkLine(errors: ValidationError[], field: string, value: string): void {
  if (typeof value !== "string") return;
  const result = validateInline(value);
  if (!result.ok) {
    errors.push({
      field,
      rule: "markdown_construct",
      message: `${field}: ${result.message}`,
    });
  }
}

/** A closed list from the doc: anything outside it is not a kind Overseer renders. */
function checkKind(
  errors: ValidationError[],
  field: string,
  value: string,
  allowed: readonly string[],
): void {
  if (allowed.includes(value)) return;
  errors.push({
    field,
    rule: "kind_unknown",
    message: `${field} is "${value}", which is not one of ${allowed.join(", ")}`,
  });
}

function paragraphsOf(source: string): number {
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (text === "") return 0;
  // A blank line inside a fenced code block is code, not a paragraph break; the
  // constrained subset allows fences, so counting them as breaks is a false rejection.
  let paragraphs = 1;
  let inFence = false;
  let blankRun = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (blankRun) paragraphs += 1;
      blankRun = false;
      inFence = !inFence;
      continue;
    }
    const blank = line.trim() === "";
    if (blank && !inFence) {
      if (!blankRun) blankRun = true;
    } else if (!blank) {
      if (blankRun) paragraphs += 1;
      blankRun = false;
    }
  }
  return paragraphs;
}

/** Sentence terminators followed by a break, the end of the field, or the start of the
 *  next sentence written without a space. Abbreviations ending in a period followed by a
 *  space would count as a sentence here, which the cap of two makes tolerable and
 *  nothing else depends on. */
function sentencesOf(source: string): number {
  const text = source.trim();
  if (text === "") return 0;
  const ends = text.match(/[.!?]+(?:\s+|$|(?=["'(\[]|[A-Z]))/g);
  return ends ? ends.length : 1;
}

/** A path as authored: one line, no control characters. It renders as a filename, so a
 *  newline or a tab in it is a layout break rather than a path. */
function checkPath(errors: ValidationError[], field: string, value: string, cap: number): void {
  if (!required(errors, field, value)) return;
  capText(errors, field, value, cap);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    errors.push({
      field,
      rule: "path_invalid",
      message: `${field} contains a control character, and a path is one line of plain text`,
    });
  }
}

/** `pr<number>:<path>:@@<old>,<n>+<new>,<n>`, per diff.hunkId(). */
function rangeOf(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/** The list at `field`, or [] plus a `required` error when it is absent or not a list. */
function requireList<T>(errors: ValidationError[], field: string, value: T[] | undefined): T[] {
  if (Array.isArray(value)) return value;
  errors.push({
    field,
    rule: "required",
    message: `${field} is required and is a list`,
  });
  return [];
}

/** The sub-object at `field`, or a `required` error naming it. Evidence carries its
 *  content in a nested object, and an absent one is a 422 about that field rather than
 *  a crash on the first property read. */
function requireObject(errors: ValidationError[], field: string, value: unknown): boolean {
  if (value !== null && typeof value === "object") return true;
  errors.push({ field, rule: "required", message: `${field} is required` });
  return false;
}

/** An entry the rules read fields off, coerced to an object. A null in a list would
 *  otherwise crash the first property read; as {} every field below it reports itself
 *  absent by name. */
function asRecord<T>(entry: T): T {
  return { ...(entry as object) } as T;
}

/** Every list the rules walk, coerced to a list. Shape errors are reported by name so a
 *  malformed body reads as a 422 about a field rather than as a crash. */
function normalizeLists(errors: ValidationError[], input: PublishPayload): PublishPayload {
  // A POST body of `null` parses to null, and an array or a string is a body too. Each
  // is a 422 naming every absent field, never a crash on the first property read.
  const payload: PublishPayload =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? input
      : ({} as PublishPayload);
  const prs = requireList(errors, "prs", payload.prs);
  const statements = requireList(errors, "statements", payload.statements);
  const notes = requireList(errors, "notes", payload.notes);
  const groups = requireList(errors, "groups", payload.groups);
  const attachments = requireList(errors, "attachments", payload.attachments);
  return {
    ...payload,
    prs: prs.map(asRecord),
    statements: statements.map((s, i) => ({
      ...asRecord(s),
      prs: requireList(errors, `statements[${i}].prs`, s?.prs),
      refs: requireList(errors, `statements[${i}].refs`, s?.refs),
      evidence: requireList(errors, `statements[${i}].evidence`, s?.evidence).map(asRecord),
    })),
    notes: notes.map((n, i) => ({
      ...asRecord(n),
      checks: requireList(errors, `notes[${i}].checks`, n?.checks),
      refs: requireList(errors, `notes[${i}].refs`, n?.refs),
      evidence: requireList(errors, `notes[${i}].evidence`, n?.evidence).map(asRecord),
    })),
    groups: groups.map((g, i) => ({
      ...asRecord(g),
      hunks: requireList(errors, `groups[${i}].hunks`, g?.hunks),
      fileNotes: requireList(errors, `groups[${i}].fileNotes`, g?.fileNotes).map(asRecord),
    })),
    attachments: attachments.map(asRecord),
  };
}

// ---- the rules ----

export function validatePublish(
  payload: PublishPayload,
  derived: DerivedFacts,
  prior: PriorDoc | null,
  options: ValidateOptions = {},
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // A body missing a list is a 422 naming the field, not a 500 from the first `.length`
  // below. Absence is answered once, here, and every rule after this reads a list.
  payload = normalizeLists(errors, payload);

  // Budgets scale with distinct pull requests, never with repeated pointers: the same
  // repo#number twice would otherwise buy breadth for a review that named one change.
  const seenPrKeys = new Set<string>();
  payload.prs.forEach((pr, i) => {
    const key = prKey(pr.repo, pr.number);
    if (seenPrKeys.has(key)) {
      errors.push({
        field: `prs[${i}]`,
        rule: "pr_duplicated",
        message: `${key} is named more than once; a review names each pull request once`,
      });
      return;
    }
    seenPrKeys.add(key);
  });

  const prCount = seenPrKeys.size;
  const statementCap = maxStatements(prCount);
  const groupCap = maxGroups(prCount);

  // ---- counts, and the decomposition warning ----

  minCount(errors, "prs", prCount, 1, "entries");
  capCount(errors, "statements", payload.statements.length, statementCap, "statements");
  minCount(errors, "statements", payload.statements.length, BUDGETS.statements.min, "statements");
  capCount(errors, "notes", payload.notes.length, maxNotes(), "notes");
  capCount(errors, "groups", payload.groups.length, groupCap, "groups");
  minCount(errors, "groups", payload.groups.length, BUDGETS.groups.min, "groups");

  // "A monolithic pull request that exhausts its budget is not an error": the write
  // path takes it and says out loud that the change may have warranted decomposition.
  if (payload.statements.length === statementCap) {
    warnings.push({
      field: "statements",
      rule: "decomposition",
      message: `this review spends its whole statement budget of ${statementCap} on ${prCount} pull request${prCount === 1 ? "" : "s"}, which may mean the change warranted further decomposition`,
    });
  }
  if (payload.groups.length === groupCap) {
    warnings.push({
      field: "groups",
      rule: "decomposition",
      message: `this review spends its whole group budget of ${groupCap} on ${prCount} pull request${prCount === 1 ? "" : "s"}, which may mean the change warranted further decomposition`,
    });
  }

  // ---- review head ----

  if (required(errors, "title", payload.title)) {
    capText(errors, "title", payload.title, BUDGETS.chars.reviewTitle);
    checkLine(errors, "title", payload.title);
  }

  const hasSummary = required(errors, "summary", payload.summary);
  if (hasSummary) {
    capText(errors, "summary", payload.summary, BUDGETS.chars.summary);
    checkBody(errors, "summary", payload.summary);
  }
  const paragraphs = hasSummary ? paragraphsOf(payload.summary) : 0;
  if (paragraphs > BUDGETS.paragraphs.summary) {
    errors.push({
      field: "summary",
      rule: "cap_paragraphs",
      message: `summary is ${paragraphs} paragraphs, the cap is ${BUDGETS.paragraphs.summary}`,
      overage: paragraphs - BUDGETS.paragraphs.summary,
    });
  }

  // ---- single repo, until multi-repo is actually built ----

  // Only a repo that is actually text can anchor the rule; an absent one is reported by
  // the required guard on prs[0].repo below rather than quietly disabling it here.
  const firstRepo = payload.prs[0]?.repo;
  const homeRepo = typeof firstRepo === "string" && firstRepo !== "" ? firstRepo : null;
  payload.prs.forEach((pr, i) => {
    if (homeRepo !== null && pr.repo !== homeRepo) {
      errors.push({
        field: `prs[${i}].repo`,
        rule: "single_repo",
        message: `this review names ${pr.repo} and ${homeRepo}; a review spans one repo until multi-repo is built`,
      });
    }
  });

  // ---- pull requests ----

  const derivedKeys = new Set(derived.prs.map((p) => prKey(p.repo, p.number)));
  const payloadKeys = new Set(payload.prs.map((pr) => prKey(pr.repo, pr.number)));

  payload.prs.forEach((pr, i) => {
    const at = `prs[${i}]`;
    // Without facts there is no diff to partition, so an underived pull request would
    // be trivially "fully claimed" and its whole diff would vanish from the account.
    if (!derivedKeys.has(prKey(pr.repo, pr.number))) {
      errors.push({
        field: at,
        rule: "pr_not_derived",
        message: `${prKey(pr.repo, pr.number)} is in the review but Overseer derived no facts for it; its diff cannot be accounted for`,
      });
    }
    // repo and number are the identity every other rule keys off, including the single
    // repo rule and prKey(); an absent repo would silently disable both.
    required(errors, `${at}.repo`, pr.repo);
    if (!Number.isInteger(pr.number)) {
      errors.push({
        field: `${at}.number`,
        rule: "pr_number_invalid",
        message: `${at}.number is ${pr.number === undefined ? "absent" : JSON.stringify(pr.number)}, and a pull request number is a whole number`,
      });
    }
    if (required(errors, `${at}.gist`, pr.gist)) {
      capText(errors, `${at}.gist`, pr.gist, BUDGETS.chars.prGist);
      checkLine(errors, `${at}.gist`, pr.gist);
    }
    if (required(errors, `${at}.detail`, pr.detail)) {
      checkBody(errors, `${at}.detail`, pr.detail);
      const sentences = sentencesOf(pr.detail);
      if (sentences > 2) {
        errors.push({
          field: `${at}.detail`,
          rule: "cap_sentences",
          message: `${at}.detail is ${sentences} sentences, the cap is 2`,
          overage: sentences - 2,
        });
      }
    }
    checkRef(errors, `${at}.detailRef`, pr.detailRef, homeRepo);

    // A parent names another pull request in this review: the stack the renderer draws
    // is a chain through the review, and a parent outside it is a dangling link.
    if (pr.parent !== undefined && pr.parent !== null) {
      if (pr.parent === pr.number) {
        errors.push({
          field: `${at}.parent`,
          rule: "pr_parent_self",
          message: `${at}.parent is ${pr.parent}, which is the pull request itself`,
        });
      } else if (!payloadKeys.has(prKey(pr.repo, pr.parent))) {
        errors.push({
          field: `${at}.parent`,
          rule: "pr_parent_unknown",
          message: `${at}.parent is ${JSON.stringify(pr.parent)}, which names no pull request in this review`,
        });
      }
    }
  });

  // ---- statements ----

  const claimedPrs = new Set<string>();
  const attachmentIds = new Set(payload.attachments.map((a) => a.id));
  const referencedAttachments = new Set<string>();
  const bundleExists = options.bundleExists;

  payload.statements.forEach((s, i) => {
    const at = `statements[${i}]`;
    checkKind(errors, `${at}.kind`, s.kind, STATEMENT_KINDS);
    if (required(errors, `${at}.text`, s.text)) {
      capText(errors, `${at}.text`, s.text, BUDGETS.chars.statementText);
      checkLine(errors, `${at}.text`, s.text);
    }
    if (required(errors, `${at}.body`, s.body)) {
      capText(errors, `${at}.body`, s.body, BUDGETS.chars.statementBody);
      checkBody(errors, `${at}.body`, s.body);
    }

    // "every statement carries at least one ref": a claim with nothing behind it does
    // not belong on the page.
    if (s.refs.length === 0) {
      errors.push({
        field: `${at}.refs`,
        rule: "statement_unbacked",
        message: `${at} carries no ref; every statement points at the code it stands on`,
      });
    }
    s.refs.forEach((r, j) => checkRef(errors, `${at}.refs[${j}]`, r, homeRepo));

    if (s.prs.length === 0) {
      errors.push({
        field: `${at}.prs`,
        rule: "statement_unattributed",
        message: `${at} names no pull request`,
      });
    }
    // Named once each, as at the review level: a repeat says nothing a single mention
    // does not, and it reads as an attribution the author lost track of.
    const namedHere = new Set<string>();
    s.prs.forEach((key, j) => {
      if (namedHere.has(key)) {
        errors.push({
          field: `${at}.prs[${j}]`,
          rule: "pr_duplicated",
          message: `${at}.prs names ${key} more than once`,
        });
        return;
      }
      namedHere.add(key);
      if (!payloadKeys.has(key)) {
        errors.push({
          field: `${at}.prs[${j}]`,
          rule: "pr_not_in_review",
          message: `${at}.prs names ${key}, which is not a pull request in this review`,
        });
        return;
      }
      claimedPrs.add(key);
    });

    checkEvidence(
      errors,
      `${at}.evidence`,
      s.evidence,
      homeRepo,
      attachmentIds,
      referencedAttachments,
      bundleExists,
    );
  });

  // ---- every pull request is realized by at least one statement ----

  payload.prs.forEach((pr, i) => {
    const key = prKey(pr.repo, pr.number);
    if (!claimedPrs.has(key)) {
      errors.push({
        field: `prs[${i}]`,
        rule: "pr_unrealized",
        message: `${key} is in the review but no statement realizes it`,
      });
    }
  });

  // ---- notes ----

  const changedRefKeys = changedHunkIndex(derived);

  payload.notes.forEach((n, i) => {
    const at = `notes[${i}]`;
    checkKind(errors, `${at}.kind`, n.kind, NOTE_KINDS);
    if (required(errors, `${at}.text`, n.text)) {
      capText(errors, `${at}.text`, n.text, BUDGETS.chars.noteText);
      checkLine(errors, `${at}.text`, n.text);
    }
    if (required(errors, `${at}.body`, n.body)) {
      capText(errors, `${at}.body`, n.body, BUDGETS.chars.noteBody);
      checkBody(errors, `${at}.body`, n.body);
    }
    capCount(errors, `${at}.checks`, n.checks.length, BUDGETS.checks.max, "checks");
    n.checks.forEach((c, j) => {
      if (!isText(errors, `${at}.checks[${j}]`, c)) return;
      capText(errors, `${at}.checks[${j}]`, c, BUDGETS.chars.check);
      checkLine(errors, `${at}.checks[${j}]`, c);
    });
    n.refs.forEach((r, j) => checkRef(errors, `${at}.refs[${j}]`, r, homeRepo));

    // "a risk note has checks or a ref into a changed hunk": a risk has to point at
    // something falsifiable. Any ref backing the note counts, whether it sits in refs[]
    // or in evidence[] as a ref: both are the note's pointers into the code.
    if (n.kind === "risk") {
      const hasChecks = n.checks.some((c) => typeof c === "string" && c.trim() !== "");
      const evidenceRefs = n.evidence.flatMap((e) => (e.type === "ref" ? [e.ref] : []));
      const pointsAtChange = [...n.refs, ...evidenceRefs].some((r) =>
        refTouchesChange(r, changedRefKeys),
      );
      if (!hasChecks && !pointsAtChange) {
        errors.push({
          field: at,
          rule: "risk_unfalsifiable",
          message: `${at} is a risk with neither checks nor a ref into a changed hunk`,
        });
      }
    }

    checkEvidence(
      errors,
      `${at}.evidence`,
      n.evidence,
      homeRepo,
      attachmentIds,
      referencedAttachments,
      bundleExists,
    );
  });

  // ---- groups, and the partition of the diff ----

  const groupOf = new Map<string, GroupInput>();
  const derivedHunks = new Map<string, Hunk>();
  for (const pr of derived.prs) for (const h of pr.hunks) derivedHunks.set(h.id, h);

  payload.groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    if (required(errors, `${at}.title`, g.title)) {
      capText(errors, `${at}.title`, g.title, BUDGETS.chars.groupTitle);
      checkLine(errors, `${at}.title`, g.title);
    }
    if (required(errors, `${at}.paragraph`, g.paragraph)) {
      capText(errors, `${at}.paragraph`, g.paragraph, BUDGETS.chars.groupParagraph);
      checkBody(errors, `${at}.paragraph`, g.paragraph);
    }
    // "a set of hunks that changed for one reason": an empty set is not a group.
    if (g.hunks.length === 0) {
      errors.push({
        field: `${at}.hunks`,
        rule: "group_empty",
        message: `${at} claims no hunk; a group is the set of hunks that changed for one reason`,
      });
    }
    // The paths this group's own hunks touch: a file note is drawn on one of those
    // rows, so a note naming any other path has nowhere on the page to go.
    const groupPaths = new Set<string>();
    for (const id of g.hunks) {
      const hunk = derivedHunks.get(id);
      if (hunk) groupPaths.add(hunk.path);
    }
    const notedPaths = new Set<string>();
    g.fileNotes.forEach((fn, j) => {
      // The path is the filename the walkthrough prints above the note.
      checkPath(errors, `${at}.fileNotes[${j}].path`, fn.path, BUDGETS.chars.fileNote);
      if (typeof fn.path === "string") {
        if (notedPaths.has(fn.path)) {
          errors.push({
            field: `${at}.fileNotes[${j}].path`,
            rule: "file_note_duplicate",
            message: `${at} carries two notes for ${fn.path}; a file row holds one note`,
          });
        } else if (groupPaths.size > 0 && !groupPaths.has(fn.path)) {
          errors.push({
            field: `${at}.fileNotes[${j}].path`,
            rule: "file_note_orphan",
            message: `${at} notes ${fn.path}, which none of the group's hunks touch; the note would have no row to sit on`,
          });
        }
        notedPaths.add(fn.path);
      }
      if (!isText(errors, `${at}.fileNotes[${j}].text`, fn.text)) return;
      capText(errors, `${at}.fileNotes[${j}].text`, fn.text, BUDGETS.chars.fileNote);
      checkLine(errors, `${at}.fileNotes[${j}].text`, fn.text);
    });
    if (!Number.isFinite(g.significance)) {
      errors.push({
        field: `${at}.significance`,
        rule: "significance_invalid",
        message: `${at}.significance is not a finite number`,
      });
    }

    g.hunks.forEach((id, j) => {
      const hunk = derivedHunks.get(id);
      if (!hunk) {
        errors.push({
          field: `${at}.hunks[${j}]`,
          rule: "hunk_unknown",
          message: `${at}.hunks names ${id}, which is not a hunk in any pull request's diff`,
        });
        return;
      }
      const owner = groupOf.get(id);
      if (owner === g) {
        const first = g.hunks.indexOf(id);
        errors.push({
          field: `${at}.hunks[${j}]`,
          rule: "hunk_repeated",
          message:
            `${hunk.path} ${rangeOf(hunk)} (${id}) is claimed twice by ` +
            `"${g.title}" (${g.id}), at hunks[${first}] and hunks[${j}]; ` +
            `every hunk belongs to exactly one group`,
        });
        return;
      }
      if (owner) {
        errors.push({
          field: `${at}.hunks[${j}]`,
          rule: "hunk_double_claimed",
          message:
            `${hunk.path} ${rangeOf(hunk)} (${id}) is claimed by both ` +
            `"${owner.title}" (${owner.id}) and "${g.title}" (${g.id}); ` +
            `every hunk belongs to exactly one group`,
        });
        return;
      }
      groupOf.set(id, g);
    });
  });

  // "The walkthrough is a partition of the diff, not a selection from it."
  for (const [id, hunk] of derivedHunks) {
    if (groupOf.has(id)) continue;
    errors.push({
      field: "groups",
      rule: "hunk_unclaimed",
      message: `${hunk.path} ${rangeOf(hunk)} (${id}) belongs to no group; every hunk in the diff belongs to exactly one`,
    });
  }

  // ---- attachments ----

  payload.attachments.forEach((a, i) => {
    const at = `attachments[${i}]`;
    if (required(errors, `${at}.alt`, a.alt)) {
      capText(errors, `${at}.alt`, a.alt, BUDGETS.chars.alt);
      checkLine(errors, `${at}.alt`, a.alt);
    }
    // The data model marks alt required and pointedly does not mark caption so: an
    // attachment may carry none. A present one is still text.
    if (a.caption !== undefined && isText(errors, `${at}.caption`, a.caption)) {
      capText(errors, `${at}.caption`, a.caption, BUDGETS.chars.caption);
      checkLine(errors, `${at}.caption`, a.caption);
    }
    if (typeof a.mediaType !== "string" || !ATTACHMENT_MEDIA_TYPES.has(a.mediaType)) {
      errors.push({
        field: `${at}.mediaType`,
        rule: "attachment_media_type",
        message: `${at}.mediaType is ${typeof a.mediaType === "string" ? a.mediaType || "empty" : "absent"}; attachments are one of ${[...ATTACHMENT_MEDIA_TYPES].join(", ")}`,
      });
    }
    if (!referencedAttachments.has(a.id)) {
      errors.push({
        field: at,
        rule: "attachment_unreferenced",
        message: `attachment ${a.id} is uploaded but no evidence references it`,
      });
    }
  });

  // ---- ids reused across versions ----

  if (prior) {
    const typeOfPriorId = new Map<string, string>();
    // A prior document read back from storage may be missing a list, and a missing one
    // reuses no ids: this rule reports nothing rather than crashing on it.
    for (const s of prior.statements ?? []) typeOfPriorId.set(s.id, "statement");
    for (const n of prior.notes ?? []) typeOfPriorId.set(n.id, "note");
    for (const g of prior.groups ?? []) typeOfPriorId.set(g.id, "group");
    for (const a of prior.attachments ?? []) typeOfPriorId.set(a.id, "attachment");
    const check = (id: string, kind: string, field: string) => {
      const was = typeOfPriorId.get(id);
      if (was && was !== kind) {
        errors.push({
          field,
          rule: "id_type_changed",
          message: `${id} was a ${was} in the prior version and is a ${kind} here; a reused id keeps its type`,
        });
      }
    };
    payload.statements.forEach((s, i) => check(s.id, "statement", `statements[${i}].id`));
    payload.notes.forEach((n, i) => check(n.id, "note", `notes[${i}].id`));
    payload.groups.forEach((g, i) => check(g.id, "group", `groups[${i}].id`));
    payload.attachments.forEach((a, i) => check(a.id, "attachment", `attachments[${i}].id`));
  }

  // ---- duplicate ids within this version ----

  const seenIds = new Map<string, string>();
  const claimId = (id: string, kind: string, field: string) => {
    // The delta matches entities by id across versions, so a blank or absent id would
    // silently degrade every later version. Two of them would also collide here into a
    // confusing id_duplicated, which says nothing about what is actually wrong.
    if (!required(errors, field, id)) return;
    const was = seenIds.get(id);
    if (was !== undefined) {
      errors.push({
        field,
        rule: "id_duplicated",
        message: `${id} is used by both a ${was} and a ${kind} in this version`,
      });
      return;
    }
    seenIds.set(id, kind);
  };
  payload.statements.forEach((s, i) => claimId(s.id, "statement", `statements[${i}].id`));
  payload.notes.forEach((n, i) => claimId(n.id, "note", `notes[${i}].id`));
  payload.groups.forEach((g, i) => claimId(g.id, "group", `groups[${i}].id`));
  // Attachments share the namespace: two attachments under one id would let a single
  // evidence reference mark both as referenced, and an unreferenced upload would ship.
  payload.attachments.forEach((a, i) => claimId(a.id, "attachment", `attachments[${i}].id`));

  return { errors, warnings, significance: reindexSignificance(payload.groups) };
}

// ---- significance ----

/**
 * Groups sorted by significance ascending, ties broken by id, respaced to 1..n when
 * any two neighbours sit within REINDEX_EPSILON of each other. Null when the authored
 * values already separate every pair, which is the common case: a review is published
 * in one shot and has at most eight groups.
 */
export function reindexSignificance(
  groups: { id: string; significance: number }[],
): { id: string; significance: number }[] | null {
  if (groups.length === 0) return null;
  const sorted = [...groups].sort(
    (a, b) => a.significance - b.significance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let crowded = false;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.significance - sorted[i - 1]!.significance;
    if (!Number.isFinite(gap) || gap < REINDEX_EPSILON) crowded = true;
  }
  if (!crowded) return null;
  return sorted.map((g, i) => ({ id: g.id, significance: i + 1 }));
}

// ---- refs and evidence ----

function checkRef(
  errors: ValidationError[],
  field: string,
  ref: RefPointerInput | undefined,
  homeRepo: string | null,
): void {
  if (!ref) {
    errors.push({ field, rule: "required", message: `${field} is required` });
    return;
  }
  if (required(errors, `${field}.repo`, ref.repo) && homeRepo !== null && ref.repo !== homeRepo) {
    errors.push({
      field: `${field}.repo`,
      rule: "single_repo",
      message: `${field} points at ${ref.repo}, and this review is about ${homeRepo}; a review spans one repo until multi-repo is built`,
    });
  }
  // A ref renders as a file path over a snippet, so an absent one would print as
  // "undefined:40-48" in the ref_range message below and as nothing on the page.
  checkPath(errors, `${field}.path`, ref.path, BUDGETS.chars.fileNote);
  if (!/^[0-9a-f]{40}$/i.test(ref.sha)) {
    errors.push({
      field: `${field}.sha`,
      rule: "ref_unpinned",
      message: `${field} names ${ref.sha || "no sha"}; refs are pinned to a full commit sha so a force push cannot rot them`,
    });
  }
  if (
    !Number.isInteger(ref.startLine) ||
    !Number.isInteger(ref.endLine) ||
    ref.startLine < 1 ||
    ref.endLine < ref.startLine
  ) {
    errors.push({
      field: field,
      rule: "ref_range",
      message: `${field} names ${ref.path}:${ref.startLine}-${ref.endLine}, which is not a line range`,
    });
  }
  // An absent highlight is legal, a whole range with nothing picked out. A present one
  // that is not a list is named, not dropped: the renderer indexes into it, so a string
  // would coerce and highlight the wrong lines and an object would throw on .includes.
  const highlight =
    ref.highlight === undefined || ref.highlight === null
      ? []
      : requireList(errors, `${field}.highlight`, ref.highlight as number[] | undefined);
  for (const line of highlight) {
    // Types are erased at runtime and this is the only gate on a POSTed document, so a
    // string or a NaN has to be caught here: both comparisons below are false for it.
    if (!Number.isInteger(line)) {
      errors.push({
        field: `${field}.highlight`,
        rule: "ref_highlight_outside",
        message: `${field} highlights ${JSON.stringify(line)}, which is not a line number`,
      });
      continue;
    }
    if (line < ref.startLine || line > ref.endLine) {
      errors.push({
        field: `${field}.highlight`,
        rule: "ref_highlight_outside",
        message: `${field} highlights line ${line}, outside its range ${ref.startLine}-${ref.endLine}`,
      });
    }
  }
}

/** Paths a pull request actually changed, per repo, with the line ranges of each
 *  changed hunk on the head side, keyed by sha as well as path: a ref pinned to a
 *  commit outside this review is not evidence about this review, however familiar its
 *  path looks. A risk's ref counts as falsifiable when it lands inside one of those
 *  ranges. */
function changedHunkIndex(derived: DerivedFacts): Map<string, Hunk[]> {
  const index = new Map<string, Hunk[]>();
  for (const pr of derived.prs) {
    for (const h of pr.hunks) {
      const key = `${h.repo}@${h.sha.toLowerCase()}:${h.path}`;
      const list = index.get(key);
      if (list) list.push(h);
      else index.set(key, [h]);
    }
  }
  return index;
}

function refTouchesChange(ref: RefPointerInput | undefined, index: Map<string, Hunk[]>): boolean {
  if (!ref || typeof ref.sha !== "string") return false;
  const hunks = index.get(`${ref.repo}@${ref.sha.toLowerCase()}:${ref.path}`);
  if (!hunks) return false;
  return hunks.some((h) => {
    const start = h.newStart;
    const end = h.newStart + Math.max(h.newLines, 1) - 1;
    return ref.startLine <= end && ref.endLine >= start;
  });
}

function checkEvidence(
  errors: ValidationError[],
  field: string,
  evidence: EvidenceInput[],
  homeRepo: string | null,
  attachmentIds: Set<string>,
  referencedAttachments: Set<string>,
  bundleExists: ((slug: string, version: number | null) => boolean) | undefined,
): void {
  evidence.forEach((e, i) => {
    const at = `${field}[${i}]`;
    switch (e.type) {
      case "ref":
        checkRef(errors, `${at}.ref`, e.ref, homeRepo);
        break;
      case "payload": {
        const p = e.payload;
        if (!requireObject(errors, `${at}.payload`, p)) break;
        checkKind(errors, `${at}.payload.lang`, p.lang, PAYLOAD_LANGS);
        if (isText(errors, `${at}.payload.before`, p.before)) {
          capText(errors, `${at}.payload.before`, p.before, BUDGETS.chars.payloadSide);
        }
        if (isText(errors, `${at}.payload.after`, p.after)) {
          capText(errors, `${at}.payload.after`, p.after, BUDGETS.chars.payloadSide);
        }
        // The keys or line numbers the renderer marks on both sides. A scalar here, or
        // an entry that is neither, marks nothing and would reach the renderer as it is.
        const highlight = requireList(errors, `${at}.payload.highlight`, p.highlight);
        highlight.forEach((h, j) => {
          if (typeof h === "string" || Number.isInteger(h)) return;
          errors.push({
            field: `${at}.payload.highlight[${j}]`,
            rule: "payload_highlight_invalid",
            message: `${at}.payload.highlight[${j}] is ${h === undefined ? "absent" : JSON.stringify(h)}, and a highlight is a key or a line number`,
          });
        });
        break;
      }
      case "figure": {
        if (!requireObject(errors, `${at}.figure`, e.figure)) break;
        checkKind(errors, `${at}.figure.kind`, e.figure.kind, FIGURE_KINDS);
        const nodes = requireList(errors, `${at}.figure.nodes`, e.figure.nodes).map(asRecord);
        const edges = requireList(errors, `${at}.figure.edges`, e.figure.edges).map(asRecord);
        // Node ids first: an edge naming an id no node declares is a dangling arrow the
        // renderer would have to defend against, so it never reaches storage.
        const nodeIds = new Set(nodes.map((n) => n.id));
        nodes.forEach((n, j) => {
          // An unnamed node is an edge target nothing can point at, and a box the
          // renderer would draw empty.
          required(errors, `${at}.figure.nodes[${j}].id`, n.id);
          if (required(errors, `${at}.figure.nodes[${j}].label`, n.label)) {
            capText(
              errors,
              `${at}.figure.nodes[${j}].label`,
              n.label,
              BUDGETS.chars.figureNodeLabel,
            );
            checkLine(errors, `${at}.figure.nodes[${j}].label`, n.label);
          }
          checkKind(errors, `${at}.figure.nodes[${j}].state`, n.state, FIGURE_NODE_STATES);
        });
        edges.forEach((edge, j) => {
          // An edge label may be absent or empty, a plain arrow, but it cannot be a
          // number.
          const edgeLabel = edge.label as string | undefined;
          if (edgeLabel !== undefined && isText(errors, `${at}.figure.edges[${j}].label`, edgeLabel)) {
            capText(
              errors,
              `${at}.figure.edges[${j}].label`,
              edgeLabel,
              BUDGETS.chars.figureEdgeLabel,
            );
            checkLine(errors, `${at}.figure.edges[${j}].label`, edgeLabel);
          }
          for (const end of ["from", "to"] as const) {
            if (nodeIds.has(edge[end])) continue;
            errors.push({
              field: `${at}.figure.edges[${j}].${end}`,
              rule: "figure_edge_dangling",
              message: `${at}.figure.edges[${j}].${end} names "${edge[end]}", which no node in this figure declares`,
            });
          }
        });
        break;
      }
      case "example": {
        const x = e.example;
        if (!requireObject(errors, `${at}.example`, x)) break;
        // The lang is a syntax tag the renderer puts in a class name, not prose: a
        // short token, never an absent field and never a paragraph.
        if (required(errors, `${at}.example.lang`, x.lang) && !/^[A-Za-z0-9+#.-]{1,20}$/.test(x.lang)) {
          errors.push({
            field: `${at}.example.lang`,
            rule: "lang_invalid",
            message: `${at}.example.lang is ${JSON.stringify(x.lang)}, and a language tag is a short token such as "ts"`,
          });
        }
        if (isText(errors, `${at}.example.text`, x.text)) {
          capText(errors, `${at}.example.text`, x.text, BUDGETS.chars.exampleText);
        }
        if (required(errors, `${at}.example.caption`, x.caption)) {
          capText(errors, `${at}.example.caption`, x.caption, BUDGETS.chars.caption);
          checkLine(errors, `${at}.example.caption`, x.caption);
        }
        break;
      }
      case "attachment": {
        if (!requireObject(errors, `${at}.attachment`, e.attachment)) break;
        if (!attachmentIds.has(e.attachment.id)) {
          errors.push({
            field: `${at}.attachment.id`,
            rule: "attachment_unknown",
            message: `${at} references attachment ${e.attachment.id}, which was not uploaded with this review`,
          });
          break;
        }
        referencedAttachments.add(e.attachment.id);
        break;
      }
      case "bundle": {
        if (!requireObject(errors, `${at}.bundle`, e.bundle)) break;
        if (required(errors, `${at}.bundle.caption`, e.bundle.caption)) {
          capText(errors, `${at}.bundle.caption`, e.bundle.caption, BUDGETS.chars.caption);
          checkLine(errors, `${at}.bundle.caption`, e.bundle.caption);
        }
        const resolves = bundleExists?.(e.bundle.slug, e.bundle.version) ?? false;
        if (!resolves) {
          const version = e.bundle.version === null ? "latest" : `v${e.bundle.version}`;
          errors.push({
            field: `${at}.bundle`,
            rule: "bundle_unresolved",
            message: `${at} points at bundle ${e.bundle.slug} (${version}), which is not in this workspace`,
          });
        }
        break;
      }
      default:
        // The evidence list in the data model is closed. An invented kind that fell
        // through here would reach storage and become the renderer's problem, so it
        // stops at the door instead.
        errors.push({
          field: `${at}.type`,
          rule: "evidence_kind_unknown",
          message: `${at}.type is ${(e as { type?: unknown }).type === undefined ? "absent" : JSON.stringify((e as { type?: unknown }).type)}, which is not one of ${EVIDENCE_KINDS.join(", ")}`,
        });
    }
  });
}
