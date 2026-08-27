import { SLUG_RE, STG_ID_RE } from "../ids";
import { normalize, validate, validateInline } from "../overseer/markdown";
import type { StageCaptureInventory } from "./db";
import { STAGE_CATEGORIES, STAGE_SIGNALS, type StageGroup, type StageMember } from "./types";
import { BUILDER_LABEL_MAX } from "./packet";

export const STAGE_TITLE_MAX = 80;
export const STAGE_SUMMARY_MAX = 1_200;
export const GROUP_TITLE_MAX = 60;
export const GROUP_EXPLANATION_MAX = 1_600;
export const GROUP_ATTENTION_MAX = 300;
export const EXAMPLE_CODE_MAX = 500;
export const EXAMPLE_TEXT_MAX = 300;
export const MEMBER_DESCRIPTION_MAX = 400;
export const MAX_GROUPS = 16;
export const MAX_EXAMPLES = 5;
export const MAX_PROJECTS = 16;
export const MAX_TOTAL_MEMBERS = 10_000;
export const MAX_VALIDATION_ERRORS = 32;

export interface StageValidationError {
  field: string;
  message: string;
}

export interface ValidatedStagePublish {
  captureId: string;
  expectedPreviousVersion: 0;
  slug: string;
  title: string;
  summary: string;
  witness: { name: string; model: string };
  groups: StageGroup[];
  projects: string[];
}

export interface StageValidationResult {
  value: ValidatedStagePublish | null;
  errors: StageValidationError[];
}

// The field helpers below, the authored-group rule, and the partition rule are exported
// because a promoted review's account publication is authored against the same capture
// inventory under the same limits (src/overseer/revision-validate.ts). A second copy of
// "every canonical change is accounted for exactly once" is a second place for it to
// drift, and the drift would be silent: both copies would still refuse *something*.

export function error(errors: StageValidationError[], field: string, message: string): void {
  if (errors.length < MAX_VALIDATION_ERRORS) errors.push({ field, message });
}

export function line(errors: StageValidationError[], field: string, value: unknown, cap: number, required = true): string | null {
  if (typeof value !== "string") {
    error(errors, field, "must be plain text");
    return null;
  }
  const text = normalize(value).trim();
  if (required && text === "") error(errors, field, "is required");
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(text)) error(errors, field, "must be one-line text with no control characters");
  if (text.length > cap) error(errors, field, `is over budget: ${text.length} of at most ${cap} characters`);
  if (text.length <= cap) {
    const inline = validateInline(text);
    if (!inline.ok) error(errors, field, inline.message);
  }
  return text;
}

export function text(errors: StageValidationError[], field: string, value: unknown, cap: number, required = true): string | null {
  if (typeof value !== "string") {
    error(errors, field, "must be plain text");
    return null;
  }
  const normalized = normalize(value);
  if (required && normalized.trim() === "") error(errors, field, "is required");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(normalized)) error(errors, field, "carries control characters");
  if (normalized.length > cap) error(errors, field, `is over budget: ${normalized.length} of at most ${cap} characters`);
  return normalized;
}

export function markdown(errors: StageValidationError[], field: string, value: unknown, cap: number): string | null {
  if (typeof value !== "string") {
    error(errors, field, "must be constrained markdown");
    return null;
  }
  const normalized = normalize(value);
  if (normalized.trim() === "") error(errors, field, "is required");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(normalized)) error(errors, field, "carries control characters");
  if (normalized.length > cap) error(errors, field, `is over budget: ${normalized.length} of at most ${cap} characters`);
  if (normalized.length <= cap) {
    const result = validate(normalized);
    if (!result.ok) error(errors, field, result.message);
  }
  return normalized;
}

export function slug(errors: StageValidationError[], field: string, value: unknown): string | null {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    error(errors, field, "must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  return value;
}

export function enumValue<T extends string>(errors: StageValidationError[], field: string, value: unknown, allowed: readonly T[]): T | null {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  error(errors, field, `must be one of ${allowed.join(", ")}`);
  return null;
}

export function unsupported(errors: StageValidationError[], field: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) error(errors, `${field}.${extra}`, "is not a supported field");
}

function changeLabel(change: StageCaptureInventory["changes"][number], inventory: StageCaptureInventory): string {
  const path = inventory.files.find((file) => file.id === change.file_id)?.path ?? "unknown file";
  return `${path} at old ${change.old_start},${change.old_lines} and new ${change.new_start},${change.new_lines}`;
}

function materialLabel(material: StageCaptureInventory["incomplete"][number]): string {
  return `${material.path ?? "capture"}: ${material.reason}`;
}

function fileLabel(file: StageCaptureInventory["files"][number]): string {
  return file.old_path ? `${file.old_path} -> ${file.path}` : file.path;
}

function validateMember(
  errors: StageValidationError[],
  field: string,
  value: unknown,
): StageMember | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    error(errors, field, "must be an object");
    return null;
  }
  const member = value as Record<string, unknown>;
  unsupported(errors, field, member, ["type", "id", "description"]);
  const type = enumValue(errors, `${field}.type`, member.type, ["change", "material", "file"] as const);
  const id = typeof member.id === "string" && member.id.trim() !== "" && member.id.length <= 80 && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(member.id)
    ? member.id
    : (error(errors, `${field}.id`, "must be a non-empty one-line id"), null);
  const description = line(errors, `${field}.description`, member.description, MEMBER_DESCRIPTION_MAX);
  if (!type || !id || description === null) return null;
  return { type, id, description } as StageMember;
}

export function validateGroup(errors: StageValidationError[], field: string, value: unknown, skipMembers = false): StageGroup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    error(errors, field, "must be an object");
    return null;
  }
  const group = value as Record<string, unknown>;
  unsupported(errors, field, group, ["id", "title", "category", "importance", "complexity", "explanation", "attention", "examples", "members"]);
  const id = slug(errors, `${field}.id`, group.id);
  const title = line(errors, `${field}.title`, group.title, GROUP_TITLE_MAX);
  const category = enumValue(errors, `${field}.category`, group.category, STAGE_CATEGORIES);
  const importance = enumValue(errors, `${field}.importance`, group.importance, STAGE_SIGNALS);
  const complexity = enumValue(errors, `${field}.complexity`, group.complexity, STAGE_SIGNALS);
  const explanation = markdown(errors, `${field}.explanation`, group.explanation, GROUP_EXPLANATION_MAX);
  let attention: string | undefined;
  if (group.attention !== undefined) {
    const checked = line(errors, `${field}.attention`, group.attention, GROUP_ATTENTION_MAX, false);
    if (checked !== null) attention = checked;
  }
  const examples: { code: string; text: string }[] = [];
  if (!Array.isArray(group.examples)) {
    error(errors, `${field}.examples`, "must be an array");
  } else {
    if (group.examples.length > MAX_EXAMPLES) error(errors, `${field}.examples`, `has ${group.examples.length} examples, the cap is ${MAX_EXAMPLES}`);
    for (const [index, raw] of group.examples.slice(0, MAX_EXAMPLES).entries()) {
      const exampleField = `${field}.examples[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        error(errors, exampleField, "must be an object");
        continue;
      }
      const example = raw as Record<string, unknown>;
      unsupported(errors, exampleField, example, ["code", "text"]);
      const code = text(errors, `${exampleField}.code`, example.code, EXAMPLE_CODE_MAX);
      const caption = line(errors, `${exampleField}.text`, example.text, EXAMPLE_TEXT_MAX);
      if (code !== null && caption !== null) examples.push({ code, text: caption });
    }
  }
  const members: StageMember[] = [];
  if (!Array.isArray(group.members)) {
    error(errors, `${field}.members`, "must be an array");
  } else if (!skipMembers) {
    for (const [index, raw] of group.members.entries()) {
      const member = validateMember(errors, `${field}.members[${index}]`, raw);
      if (member) members.push(member);
    }
  }
  if (!id || title === null || !category || !importance || !complexity || explanation === null) return null;
  return { id, title, category, importance, complexity, explanation, ...(attention === undefined ? {} : { attention }), examples, members };
}

export function validateCompletePartition(errors: StageValidationError[], groups: StageGroup[], inventory: StageCaptureInventory): void {
  const changes = new Map(inventory.changes.map((change) => [change.id, change]));
  const materials = new Map(inventory.incomplete.map((item) => [item.id, item]));
  const files = new Map(inventory.files.map((file) => [file.id, file]));
  const seen = new Map<string, { type: string; field: string }>();
  const changeIds = new Set<string>();
  const materialIds = new Set<string>();
  const fileIds = new Set<string>();
  const representedFiles = new Set<string>();

  for (const [groupIndex, group] of groups.entries()) {
    for (const [memberIndex, member] of group.members.entries()) {
      const field = `groups[${groupIndex}].members[${memberIndex}]`;
      const previous = seen.get(member.id);
      if (previous) {
        const duplicate = changes.get(member.id)?.id === member.id
          ? changeLabel(changes.get(member.id)!, inventory)
          : materials.get(member.id)?.id === member.id
            ? materialLabel(materials.get(member.id)!)
            : files.get(member.id)?.id === member.id
              ? fileLabel(files.get(member.id)!)
              : member.id;
        error(errors, `${field}.id`, `duplicates ${member.id} (${duplicate}), already used at ${previous.field}`);
        continue;
      }
      seen.set(member.id, { type: member.type, field: `${field}.id` });
      if (member.type === "change") {
        const change = changes.get(member.id);
        if (!change) {
          if (materials.has(member.id) || files.has(member.id)) {
            const material = materials.get(member.id);
            const file = files.get(member.id);
            error(errors, `${field}.id`, `${member.id} resolves to ${material ? `material ${materialLabel(material)}` : `file ${fileLabel(file!)}`}, not a change`);
          }
          else error(errors, `${field}.id`, `${member.id} is not a canonical change in capture ${inventory.capture.id}`);
          continue;
        }
        changeIds.add(member.id);
        representedFiles.add(change.file_id);
      } else if (member.type === "material") {
        const material = materials.get(member.id);
        if (!material) {
          if (changes.has(member.id) || files.has(member.id)) {
            const change = changes.get(member.id);
            const file = files.get(member.id);
            error(errors, `${field}.id`, `${member.id} resolves to ${change ? `change ${changeLabel(change, inventory)}` : `file ${fileLabel(file!)}`}, not material`);
          }
          else error(errors, `${field}.id`, `${member.id} is not an incomplete material in capture ${inventory.capture.id}`);
          continue;
        }
        materialIds.add(member.id);
        if (material.path) {
          const file = inventory.files.find((candidate) => candidate.path === material.path);
          if (file) representedFiles.add(file.id);
        }
      } else {
        const file = files.get(member.id);
        if (!file) {
          if (changes.has(member.id) || materials.has(member.id)) {
            const change = changes.get(member.id);
            const material = materials.get(member.id);
            error(errors, `${field}.id`, `${member.id} resolves to ${change ? `change ${changeLabel(change, inventory)}` : `material ${materialLabel(material!)}`}, not a file`);
          }
          else error(errors, `${field}.id`, `${member.id} is not a changed file in capture ${inventory.capture.id}`);
          continue;
        }
        if (representedFiles.has(file.id) || inventory.changes.some((change) => change.file_id === file.id) || inventory.incomplete.some((item) => item.path !== null && item.path === file.path)) {
          const change = inventory.changes.find((candidate) => candidate.file_id === file.id);
          const material = inventory.incomplete.find((item) => item.path !== null && item.path === file.path);
          error(errors, `${field}.id`, `file ${fileLabel(file)} is already represented by ${change ? `change ${changeLabel(change, inventory)}` : `material ${materialLabel(material!)}`}`);
          continue;
        }
        fileIds.add(member.id);
      }
    }
  }

  for (const change of inventory.changes) if (!changeIds.has(change.id)) {
    error(errors, "groups.members", `omits canonical change ${change.id} for ${inventory.files.find((file) => file.id === change.file_id)?.path ?? "unknown file"} at old ${change.old_start}, new ${change.new_start}`);
  }
  for (const material of inventory.incomplete) if (!materialIds.has(material.id)) {
    error(errors, "groups.members", `omits incomplete material ${material.id}${material.path ? ` for ${material.path}` : ` (${material.reason})`}`);
  }
  for (const file of inventory.files) {
    const hasChange = inventory.changes.some((change) => change.file_id === file.id);
    const hasMaterial = inventory.incomplete.some((item) => item.path !== null && item.path === file.path);
    if (!hasChange && !hasMaterial && !fileIds.has(file.id)) error(errors, "groups.members", `omits pure file ${file.id} for ${file.path}`);
  }
}

export function validateStagePublish(input: unknown, inventory: StageCaptureInventory): StageValidationResult {
  const errors: StageValidationError[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: null, errors: [{ field: "body", message: "must be a JSON object" }] };
  const body = input as Record<string, unknown>;
  const allowed = new Set(["captureId", "expectedPreviousVersion", "slug", "title", "summary", "witness", "groups", "projects"]);
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra) error(errors, extra, "is not a supported field");

  const captureId = typeof body.captureId === "string" && STG_ID_RE.test(body.captureId) ? body.captureId : (error(errors, "captureId", "must be a stage capture id"), null);
  const expected = body.expectedPreviousVersion === 0 ? 0 : (error(errors, "expectedPreviousVersion", "must be 0 for this slice"), null);
  const slugValue = slug(errors, "slug", body.slug);
  if (slugValue && slugValue !== inventory.capture.slug) error(errors, "slug", `must equal capture slug ${inventory.capture.slug}`);
  const title = line(errors, "title", body.title, STAGE_TITLE_MAX);
  const summary = markdown(errors, "summary", body.summary, STAGE_SUMMARY_MAX);

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

  let groups: StageGroup[] = [];
  let groupValidationFailed = false;
  let tooManyMembers = false;
  if (!Array.isArray(body.groups)) {
    error(errors, "groups", "must be an array");
  } else {
    if (body.groups.length < 1) error(errors, "groups", "must contain at least 1 group");
    const tooManyGroups = body.groups.length > MAX_GROUPS;
    if (tooManyGroups) error(errors, "groups", `has ${body.groups.length} groups, the cap is ${MAX_GROUPS}`);
    let rawMemberCount = 0;
    for (const raw of body.groups.slice(0, MAX_GROUPS)) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).members)) {
        rawMemberCount += ((raw as Record<string, unknown>).members as unknown[]).length;
        if (rawMemberCount > MAX_TOTAL_MEMBERS) break;
      }
    }
    tooManyMembers = rawMemberCount > MAX_TOTAL_MEMBERS;
    if (tooManyMembers) error(errors, "groups.members", `has more than ${MAX_TOTAL_MEMBERS} members, the cap is ${MAX_TOTAL_MEMBERS}`);
    if (!tooManyGroups) {
      const ids = new Set<string>();
      for (const [index, raw] of body.groups.slice(0, MAX_GROUPS).entries()) {
        const before = errors.length;
        const group = validateGroup(errors, `groups[${index}]`, raw, tooManyMembers);
        if (errors.length > before || !group) groupValidationFailed = true;
        if (group) {
          if (ids.has(group.id)) {
            error(errors, `groups[${index}].id`, `duplicates group id ${group.id}`);
            groupValidationFailed = true;
          }
          ids.add(group.id);
          groups.push(group);
        }
      }
    }
  }
  let projects: string[] = [];
  if (body.projects !== undefined) {
    if (!Array.isArray(body.projects)) error(errors, "projects", "must be an array of project slugs");
    else {
      if (body.projects.length > MAX_PROJECTS) error(errors, "projects", `has ${body.projects.length} projects, the cap is ${MAX_PROJECTS}`);
      const seen = new Set<string>();
      for (const [index, project] of body.projects.slice(0, MAX_PROJECTS).entries()) {
        const value = slug(errors, `projects[${index}]`, project);
        if (value) {
          seen.add(value); projects.push(value);
        }
      }
    }
  }
  if (groups.length > 0 && !groupValidationFailed && !tooManyMembers) validateCompletePartition(errors, groups, inventory);
  projects = [...new Set(projects)].sort();
  if (errors.length > 0 || !captureId || expected === null || !slugValue || !title || summary === null || !witness) return { value: null, errors };
  return { value: { captureId, expectedPreviousVersion: 0, slug: slugValue, title, summary, witness, groups, projects }, errors: [] };
}
