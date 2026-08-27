// What a promoted review will accept from a caller, before any row is written.
//
// Two bodies are checked here. Creating a lineage is small — a capture, a slug, a title
// and optional Project slugs — and its whole difficulty is that the slug may differ from
// the capture's, deliberately, so an existing Stage or legacy collision can be resolved
// by naming a new one.
//
// Publishing an account is the large one, and every rule in it is about the account not
// being able to say more than the revision can support: the partition must cover the
// capture exactly once, a focus anchor must name material the capture actually holds,
// focus ids must be unique so a link means one thing, and cited evidence must already
// exist in this workspace.

import { getBundle } from "../db";
import { SLUG_RE, STG_ID_RE } from "../ids";
import type { StageCaptureInventory } from "../stage/db";
import type { StageGroup } from "../stage/types";
import {
  MAX_GROUPS,
  MAX_PROJECTS,
  MAX_TOTAL_MEMBERS,
  STAGE_SUMMARY_MAX,
  enumValue,
  error,
  line,
  markdown,
  slug as slugField,
  unsupported,
  validateCompletePartition,
  validateGroup,
  type StageValidationError,
} from "../stage/validate";
import { BUILDER_LABEL_MAX } from "../stage/packet";
import { getAttachmentInWorkspace } from "./db";
import {
  FOCUS_BODY_MAX,
  FOCUS_KINDS,
  FOCUS_TITLE_MAX,
  MAX_EVIDENCE_REFS,
  MAX_FOCUS_ANCHORS,
  MAX_FOCUS_ITEMS,
  REVISION_TITLE_MAX,
  type EvidenceRef,
  type FocusAnchor,
  type FocusItem,
} from "./revision-types";

export type { StageValidationError as RevisionValidationError };

export interface ValidatedLineageCreate {
  captureId: string;
  slug: string;
  title: string;
  projects: string[];
}

export interface ValidatedAccountPublish {
  witness: { name: string; model: string };
  summary: string;
  groups: StageGroup[];
  focus: FocusItem[];
  evidence: EvidenceRef[];
}

export interface RevisionValidationResult<T> {
  value: T | null;
  errors: StageValidationError[];
}

export function validateLineageCreate(input: unknown): RevisionValidationResult<ValidatedLineageCreate> {
  const errors: StageValidationError[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value: null, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const body = input as Record<string, unknown>;
  unsupportedTop(errors, body, ["captureId", "slug", "title", "projects"]);

  const captureId = typeof body.captureId === "string" && STG_ID_RE.test(body.captureId)
    ? body.captureId
    : (error(errors, "captureId", "must be a stage capture id"), null);
  const slug = slugField(errors, "slug", body.slug);
  const title = line(errors, "title", body.title, REVISION_TITLE_MAX);
  const projects = projectSlugs(errors, body.projects);

  if (errors.length > 0 || !captureId || !slug || !title) return { value: null, errors };
  return { value: { captureId, slug, title, projects }, errors: [] };
}

/**
 * The account a witness publishes over one revision.
 *
 * `inventory` is the revision's own capture, so every anchor and every partition member
 * is checked against the code the account is actually about rather than against whatever
 * the caller thinks it is reviewing.
 */
export function validateAccountPublish(
  input: unknown,
  inventory: StageCaptureInventory,
  workspaceId: string,
): RevisionValidationResult<ValidatedAccountPublish> {
  const errors: StageValidationError[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value: null, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const body = input as Record<string, unknown>;
  unsupportedTop(errors, body, ["witness", "summary", "groups", "focus", "evidence"]);

  let witness: { name: string; model: string } | null = null;
  if (!body.witness || typeof body.witness !== "object" || Array.isArray(body.witness)) {
    error(errors, "witness", "is required and must be an object");
  } else {
    const raw = body.witness as Record<string, unknown>;
    unsupported(errors, "witness", raw, ["name", "model"]);
    witness = {
      name: line(errors, "witness.name", raw.name, BUILDER_LABEL_MAX) ?? "",
      model: line(errors, "witness.model", raw.model, BUILDER_LABEL_MAX) ?? "",
    };
  }
  const summary = markdown(errors, "summary", body.summary, STAGE_SUMMARY_MAX);

  const groups: StageGroup[] = [];
  let groupsUsable = true;
  if (!Array.isArray(body.groups)) {
    error(errors, "groups", "must be an array");
    groupsUsable = false;
  } else {
    if (body.groups.length < 1) error(errors, "groups", "must contain at least 1 group");
    const tooManyGroups = body.groups.length > MAX_GROUPS;
    if (tooManyGroups) error(errors, "groups", `has ${body.groups.length} groups, the cap is ${MAX_GROUPS}`);
    let members = 0;
    for (const raw of body.groups.slice(0, MAX_GROUPS)) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).members)) {
        members += ((raw as Record<string, unknown>).members as unknown[]).length;
        if (members > MAX_TOTAL_MEMBERS) break;
      }
    }
    const tooManyMembers = members > MAX_TOTAL_MEMBERS;
    if (tooManyMembers) error(errors, "groups.members", `has more than ${MAX_TOTAL_MEMBERS} members, the cap is ${MAX_TOTAL_MEMBERS}`);
    if (tooManyGroups || tooManyMembers) groupsUsable = false;
    else {
      const ids = new Set<string>();
      for (const [index, raw] of body.groups.entries()) {
        const before = errors.length;
        const group = validateGroup(errors, `groups[${index}]`, raw);
        if (errors.length > before || !group) { groupsUsable = false; continue; }
        if (ids.has(group.id)) {
          error(errors, `groups[${index}].id`, `duplicates group id ${group.id}`);
          groupsUsable = false;
        }
        ids.add(group.id);
        groups.push(group);
      }
    }
  }
  if (groupsUsable && groups.length > 0) validateCompletePartition(errors, groups, inventory);

  const focus = validateFocus(errors, body.focus, inventory);
  const evidence = validateEvidence(errors, body.evidence, workspaceId);

  if (errors.length > 0 || !witness || summary === null) return { value: null, errors };
  return { value: { witness, summary, groups, focus, evidence }, errors: [] };
}

function unsupportedTop(errors: StageValidationError[], body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) error(errors, extra, "is not a supported field");
}

/** Sorted and de-duplicated, so input order and a repeated name cannot make an
 *  otherwise identical replay look like a different request. */
function projectSlugs(errors: StageValidationError[], value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error(errors, "projects", "must be an array of project slugs");
    return [];
  }
  if (value.length > MAX_PROJECTS) error(errors, "projects", `has ${value.length} projects, the cap is ${MAX_PROJECTS}`);
  const out: string[] = [];
  for (const [index, entry] of value.slice(0, MAX_PROJECTS).entries()) {
    const checked = slugField(errors, `projects[${index}]`, entry);
    if (checked) out.push(checked);
  }
  return [...new Set(out)].sort();
}

/**
 * Decisions and risks, each anchored into the capture.
 *
 * Anchors overlap freely and own nothing — two focus items may point at the same change,
 * and pointing at it does not take it out of the partition. What they may not do is
 * point at material this capture does not hold, because a decision anchored to nothing
 * is an opinion wearing a citation.
 */
function validateFocus(
  errors: StageValidationError[],
  value: unknown,
  inventory: StageCaptureInventory,
): FocusItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error(errors, "focus", "must be an array");
    return [];
  }
  if (value.length > MAX_FOCUS_ITEMS) error(errors, "focus", `has ${value.length} items, the cap is ${MAX_FOCUS_ITEMS}`);
  const changes = new Set(inventory.changes.map((change) => change.id));
  const materials = new Set(inventory.incomplete.map((item) => item.id));
  const files = new Set(inventory.files.map((file) => file.id));
  const ids = new Map<string, string>();
  const out: FocusItem[] = [];
  for (const [index, raw] of value.slice(0, MAX_FOCUS_ITEMS).entries()) {
    const field = `focus[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      error(errors, field, "must be an object");
      continue;
    }
    const item = raw as Record<string, unknown>;
    unsupported(errors, field, item, ["id", "kind", "title", "body", "anchors"]);
    const id = slugField(errors, `${field}.id`, item.id);
    const kind = enumValue(errors, `${field}.kind`, item.kind, FOCUS_KINDS);
    const title = line(errors, `${field}.title`, item.title, FOCUS_TITLE_MAX);
    const body = markdown(errors, `${field}.body`, item.body, FOCUS_BODY_MAX);
    if (id !== null) {
      const previous = ids.get(id);
      if (previous !== undefined) error(errors, `${field}.id`, `duplicates focus id ${id}, already used at ${previous}`);
      else ids.set(id, `${field}.id`);
    }
    const anchors: FocusAnchor[] = [];
    if (!Array.isArray(item.anchors)) {
      error(errors, `${field}.anchors`, "must be an array");
    } else {
      if (item.anchors.length < 1) error(errors, `${field}.anchors`, "must name at least one change, material, or file");
      if (item.anchors.length > MAX_FOCUS_ANCHORS) {
        error(errors, `${field}.anchors`, `has ${item.anchors.length} anchors, the cap is ${MAX_FOCUS_ANCHORS}`);
      }
      const seen = new Set<string>();
      for (const [anchorIndex, rawAnchor] of item.anchors.slice(0, MAX_FOCUS_ANCHORS).entries()) {
        const anchorField = `${field}.anchors[${anchorIndex}]`;
        if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) {
          error(errors, anchorField, "must be an object");
          continue;
        }
        const anchor = rawAnchor as Record<string, unknown>;
        unsupported(errors, anchorField, anchor, ["type", "id"]);
        const type = enumValue(errors, `${anchorField}.type`, anchor.type, ["change", "material", "file"] as const);
        const anchorId = typeof anchor.id === "string" && anchor.id.length >= 1 && anchor.id.length <= 80
          ? anchor.id
          : (error(errors, `${anchorField}.id`, "must be a non-empty one-line id"), null);
        if (!type || anchorId === null) continue;
        const owned = type === "change" ? changes.has(anchorId) : type === "material" ? materials.has(anchorId) : files.has(anchorId);
        if (!owned) {
          error(errors, `${anchorField}.id`, `${anchorId} is not a ${type} in capture ${inventory.capture.id}`);
          continue;
        }
        const key = `${type}:${anchorId}`;
        if (seen.has(key)) {
          error(errors, `${anchorField}.id`, `repeats ${anchorId} inside the same focus item`);
          continue;
        }
        seen.add(key);
        anchors.push({ type, id: anchorId } as FocusAnchor);
      }
    }
    if (!id || !kind || title === null || body === null || anchors.length === 0) continue;
    out.push({ id, kind, title, body, anchors });
  }
  return out;
}

/** Cited material, which must already exist in this workspace. An account points; it
 *  never mints, so a reference GitHub or another workspace owns is refused rather than
 *  rendered as a link nobody can open. */
function validateEvidence(
  errors: StageValidationError[],
  value: unknown,
  workspaceId: string,
): EvidenceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error(errors, "evidence", "must be an array");
    return [];
  }
  if (value.length > MAX_EVIDENCE_REFS) error(errors, "evidence", `has ${value.length} references, the cap is ${MAX_EVIDENCE_REFS}`);
  const out: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.slice(0, MAX_EVIDENCE_REFS).entries()) {
    const field = `evidence[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      error(errors, field, "must be an object");
      continue;
    }
    const ref = raw as Record<string, unknown>;
    const kind = enumValue(errors, `${field}.kind`, ref.kind, ["attachment", "bundle"] as const);
    if (kind === "attachment") {
      unsupported(errors, field, ref, ["kind", "id"]);
      const id = typeof ref.id === "string" && ref.id.length >= 1 && ref.id.length <= 80
        ? ref.id
        : (error(errors, `${field}.id`, "must be a review attachment id"), null);
      if (id === null) continue;
      const attachment = getAttachmentInWorkspace(workspaceId, id);
      if (!attachment) {
        error(errors, `${field}.id`, `no attachment ${id} in this workspace`);
        continue;
      }
      if (seen.has(`attachment:${id}`)) { error(errors, `${field}.id`, `repeats attachment ${id}`); continue; }
      seen.add(`attachment:${id}`);
      out.push({
        kind,
        id,
        reviewSlug: attachment.slug,
        mediaType: attachment.media_type,
        bytes: attachment.bytes,
        alt: attachment.alt,
        caption: attachment.caption,
      });
      continue;
    }
    if (kind === "bundle") {
      unsupported(errors, field, ref, ["kind", "slug", "version"]);
      const slug = typeof ref.slug === "string" && SLUG_RE.test(ref.slug)
        ? ref.slug
        : (error(errors, `${field}.slug`, "must match [a-z0-9][a-z0-9-]{0,63}"), null);
      const version = Number.isInteger(ref.version) && (ref.version as number) >= 1
        ? (ref.version as number)
        : (error(errors, `${field}.version`, "must be a bundle version number"), null);
      if (slug === null || version === null) continue;
      const bundle = getBundle(workspaceId, slug);
      if (!bundle || version > bundle.latest_version) {
        error(errors, `${field}.version`, `no bundle "${slug}" at version ${version} in this workspace`);
        continue;
      }
      if (seen.has(`bundle:${slug}:${version}`)) { error(errors, `${field}.slug`, `repeats bundle ${slug} v${version}`); continue; }
      seen.add(`bundle:${slug}:${version}`);
      out.push({ kind, slug, version });
    }
  }
  return out;
}
