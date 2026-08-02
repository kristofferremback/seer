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
// derive.ts, which fetches, and so cannot live behind a pure signature.

import { validate as validateMarkdown, validateInline } from "./markdown";
import {
  BUDGETS,
  maxGroups,
  maxNotes,
  maxStatements,
  type Figure,
  type Hunk,
  type NoteKind,
  type Payload,
  type StatementKind,
} from "./types";

// ---- what the skill writes ----

/** A ref as authored: a pointer, never the code. Ids are minted when it resolves. */
export interface RefPointerInput {
  id?: string;
  repo: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
  highlight?: number[];
}

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
  caption: string;
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

// ---- helpers ----

/** Code points, not UTF-16 units: an emoji in a title is one character to its author. */
function len(s: string): number {
  return [...s].length;
}

function capText(
  errors: ValidationError[],
  field: string,
  value: string,
  cap: number,
): void {
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
      overage: count - min,
    });
  }
}

function required(errors: ValidationError[], field: string, value: string): boolean {
  if (value.trim() === "") {
    errors.push({ field, rule: "required", message: `${field} is required` });
    return false;
  }
  return true;
}

/** A multi-line authored body: the constrained markdown subset from step 5. */
function checkBody(errors: ValidationError[], field: string, value: string): void {
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
  const result = validateInline(value);
  if (!result.ok) {
    errors.push({
      field,
      rule: "markdown_construct",
      message: `${field}: ${result.message}`,
    });
  }
}

function paragraphsOf(source: string): number {
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (text === "") return 0;
  return text.split(/\n[ \t]*\n+/).length;
}

/** Sentence terminators followed by a break or the end of the field. Abbreviations
 *  ending in a period followed by a space would count as a sentence here, which the
 *  cap of two makes tolerable and nothing else depends on. */
function sentencesOf(source: string): number {
  const text = source.trim();
  if (text === "") return 0;
  const ends = text.match(/[.!?]+(\s+|$)/g);
  return ends ? ends.length : 1;
}

function prKeyOf(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** `pr<number>:<path>:@@<old>,<n>+<new>,<n>`, per diff.hunkId(). */
function rangeOf(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
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

  const prCount = payload.prs.length;
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

  required(errors, "title", payload.title);
  capText(errors, "title", payload.title, BUDGETS.chars.reviewTitle);
  checkLine(errors, "title", payload.title);

  required(errors, "summary", payload.summary);
  capText(errors, "summary", payload.summary, BUDGETS.chars.summary);
  checkBody(errors, "summary", payload.summary);
  const paragraphs = paragraphsOf(payload.summary);
  if (paragraphs > BUDGETS.paragraphs.summary) {
    errors.push({
      field: "summary",
      rule: "cap_paragraphs",
      message: `summary is ${paragraphs} paragraphs, the cap is ${BUDGETS.paragraphs.summary}`,
      overage: paragraphs - BUDGETS.paragraphs.summary,
    });
  }

  // ---- single repo, until multi-repo is actually built ----

  const repos = new Set<string>();
  for (const pr of payload.prs) repos.add(pr.repo);
  const homeRepo = payload.prs[0]?.repo ?? null;
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

  const derivedByKey = new Map(derived.prs.map((p) => [prKeyOf(p.repo, p.number), p]));
  const payloadKeys = new Set(payload.prs.map((pr) => prKeyOf(pr.repo, pr.number)));

  payload.prs.forEach((pr, i) => {
    const at = `prs[${i}]`;
    if (required(errors, `${at}.gist`, pr.gist)) {
      capText(errors, `${at}.gist`, pr.gist, BUDGETS.chars.prGist);
      checkLine(errors, `${at}.gist`, pr.gist);
    }
    if (required(errors, `${at}.detail`, pr.detail)) {
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
  });

  // ---- statements ----

  const claimedPrs = new Set<string>();
  const attachmentIds = new Set(payload.attachments.map((a) => a.id));
  const referencedAttachments = new Set<string>();
  const bundleExists = options.bundleExists;

  payload.statements.forEach((s, i) => {
    const at = `statements[${i}]`;
    if (required(errors, `${at}.text`, s.text)) {
      capText(errors, `${at}.text`, s.text, BUDGETS.chars.statementText);
      checkLine(errors, `${at}.text`, s.text);
    }
    capText(errors, `${at}.body`, s.body, BUDGETS.chars.statementBody);
    checkBody(errors, `${at}.body`, s.body);

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
    s.prs.forEach((key, j) => {
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
    const key = prKeyOf(pr.repo, pr.number);
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
    if (required(errors, `${at}.text`, n.text)) {
      capText(errors, `${at}.text`, n.text, BUDGETS.chars.noteText);
      checkLine(errors, `${at}.text`, n.text);
    }
    capText(errors, `${at}.body`, n.body, BUDGETS.chars.noteBody);
    checkBody(errors, `${at}.body`, n.body);
    capCount(errors, `${at}.checks`, n.checks.length, BUDGETS.checks.max, "checks");
    n.checks.forEach((c, j) => {
      capText(errors, `${at}.checks[${j}]`, c, BUDGETS.chars.check);
      checkLine(errors, `${at}.checks[${j}]`, c);
    });
    n.refs.forEach((r, j) => checkRef(errors, `${at}.refs[${j}]`, r, homeRepo));

    // "a risk note has checks or a ref into a changed hunk": a risk has to point at
    // something falsifiable.
    if (n.kind === "risk") {
      const hasChecks = n.checks.some((c) => c.trim() !== "");
      const pointsAtChange = n.refs.some((r) => refTouchesChange(r, changedRefKeys));
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
    capText(errors, `${at}.paragraph`, g.paragraph, BUDGETS.chars.groupParagraph);
    checkBody(errors, `${at}.paragraph`, g.paragraph);
    g.fileNotes.forEach((fn, j) => {
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
    capText(errors, `${at}.caption`, a.caption, BUDGETS.chars.caption);
    checkLine(errors, `${at}.caption`, a.caption);
    if (!a.mediaType.startsWith("image/")) {
      errors.push({
        field: `${at}.mediaType`,
        rule: "attachment_media_type",
        message: `${at}.mediaType is ${a.mediaType || "empty"}; attachments are image/* to start`,
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
    for (const s of prior.statements) typeOfPriorId.set(s.id, "statement");
    for (const n of prior.notes) typeOfPriorId.set(n.id, "note");
    for (const g of prior.groups) typeOfPriorId.set(g.id, "group");
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
  }

  // ---- duplicate ids within this version ----

  const seenIds = new Map<string, string>();
  const claimId = (id: string, kind: string, field: string) => {
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
  if (homeRepo !== null && ref.repo !== homeRepo) {
    errors.push({
      field: `${field}.repo`,
      rule: "single_repo",
      message: `${field} points at ${ref.repo}, and this review is about ${homeRepo}; a review spans one repo until multi-repo is built`,
    });
  }
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
  for (const line of ref.highlight ?? []) {
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
 *  changed hunk on the head side. A risk's ref counts as falsifiable when it lands
 *  inside one of those ranges. */
function changedHunkIndex(derived: DerivedFacts): Map<string, Hunk[]> {
  const index = new Map<string, Hunk[]>();
  for (const pr of derived.prs) {
    for (const h of pr.hunks) {
      const key = `${h.repo}:${h.path}`;
      const list = index.get(key);
      if (list) list.push(h);
      else index.set(key, [h]);
    }
  }
  return index;
}

function refTouchesChange(ref: RefPointerInput, index: Map<string, Hunk[]>): boolean {
  const hunks = index.get(`${ref.repo}:${ref.path}`);
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
      case "payload":
        capText(errors, `${at}.payload.before`, e.payload.before, BUDGETS.chars.payloadSide);
        capText(errors, `${at}.payload.after`, e.payload.after, BUDGETS.chars.payloadSide);
        break;
      case "figure":
        e.figure.nodes.forEach((n, j) => {
          capText(
            errors,
            `${at}.figure.nodes[${j}].label`,
            n.label,
            BUDGETS.chars.figureNodeLabel,
          );
          checkLine(errors, `${at}.figure.nodes[${j}].label`, n.label);
        });
        e.figure.edges.forEach((edge, j) => {
          capText(
            errors,
            `${at}.figure.edges[${j}].label`,
            edge.label,
            BUDGETS.chars.figureEdgeLabel,
          );
          checkLine(errors, `${at}.figure.edges[${j}].label`, edge.label);
        });
        break;
      case "example":
        capText(errors, `${at}.example.text`, e.example.text, BUDGETS.chars.exampleText);
        if (required(errors, `${at}.example.caption`, e.example.caption)) {
          capText(errors, `${at}.example.caption`, e.example.caption, BUDGETS.chars.caption);
          checkLine(errors, `${at}.example.caption`, e.example.caption);
        }
        break;
      case "attachment":
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
      case "bundle": {
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
    }
  });
}
