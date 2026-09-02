// What a stack account may say, before any row is written.
//
// Every rule here is about the account not being able to say more than the manifest can
// support: each reference names one member exactly as the manifest pins it, and one group
// that account actually has; every member group appears in exactly one stack group; and
// references inside a group are already in bottom-to-top member order then account group
// order — refused, never reordered, so a stored account is what its witness wrote.

import { SLUG_RE } from "../ids";
import type { StageExample } from "../stage/types";
import {
  GROUP_ATTENTION_MAX,
  GROUP_EXPLANATION_MAX,
  GROUP_TITLE_MAX,
  MAX_EXAMPLES,
  EXAMPLE_CODE_MAX,
  EXAMPLE_TEXT_MAX,
  STAGE_SUMMARY_MAX,
  error,
  line,
  markdown,
  slug as slugField,
  unsupported,
  type StageValidationError,
} from "../stage/validate";
import { BUILDER_LABEL_MAX } from "../stage/packet";
import type { ReviewAccountRow } from "./revision-db";
import type { StackManifestRow } from "./stack-db";
import { pinnedMembers } from "./stack-db";
import { MAX_STACK_GROUPS, MAX_STACK_GROUP_REFS, MAX_STACK_TOTAL_REFS, type StackGroup, type StackGroupRef } from "./stack-types";

export interface ValidatedStackAccount {
  witness: { name: string; model: string };
  summary: string;
  groups: StackGroup[];
}

export interface StackValidationResult {
  value: ValidatedStackAccount | null;
  errors: StageValidationError[];
}

export function validateStackAccountBody(
  input: unknown,
  manifest: StackManifestRow,
  pinnedAccounts: Map<string, ReviewAccountRow>,
): StackValidationResult {
  const errors: StageValidationError[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value: null, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const body = input as Record<string, unknown>;
  unsupported(errors, "body", body, ["witness", "summary", "groups"]);

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

  // The universe every reference must land in, and each of them exactly once.
  const members = pinnedMembers(manifest.doc);
  const order = new Map(members.map((member, index) => [member.lineageId, index]));
  const expected = new Map<string, string>();
  for (const member of members) {
    const account = pinnedAccounts.get(member.lineageId);
    if (!account) continue;
    for (const group of account.doc.groups) expected.set(`${member.lineageId}/${group.id}`, `${member.lineageSlug}/${group.id}`);
  }
  const groupOrder = new Map<string, number>();
  for (const [lineageId, account] of pinnedAccounts) {
    account.doc.groups.forEach((group, index) => groupOrder.set(`${lineageId}/${group.id}`, index));
  }

  const groups: StackGroup[] = [];
  if (!Array.isArray(body.groups)) {
    error(errors, "groups", "must be an array");
  } else {
    if (body.groups.length < 1) error(errors, "groups", "must contain at least 1 group");
    if (body.groups.length > MAX_STACK_GROUPS) error(errors, "groups", `has ${body.groups.length} groups, the cap is ${MAX_STACK_GROUPS}`);
    const ids = new Set<string>();
    const seen = new Map<string, string>();
    let total = 0;
    for (const [index, raw] of body.groups.slice(0, MAX_STACK_GROUPS).entries()) {
      const field = `groups[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { error(errors, field, "must be an object"); continue; }
      const group = raw as Record<string, unknown>;
      unsupported(errors, field, group, ["id", "title", "body", "attention", "examples", "members"]);
      const id = slugField(errors, `${field}.id`, group.id);
      const title = line(errors, `${field}.title`, group.title, GROUP_TITLE_MAX);
      const text = markdown(errors, `${field}.body`, group.body, GROUP_EXPLANATION_MAX);
      const attention = group.attention === undefined ? undefined : line(errors, `${field}.attention`, group.attention, GROUP_ATTENTION_MAX);
      const examples = validateExamples(errors, `${field}.examples`, group.examples);
      if (id !== null) {
        if (ids.has(id)) error(errors, `${field}.id`, `duplicates group id ${id}`);
        ids.add(id);
      }
      const refs: StackGroupRef[] = [];
      if (!Array.isArray(group.members)) {
        error(errors, `${field}.members`, "must be an array");
      } else {
        if (group.members.length < 1) error(errors, `${field}.members`, "must name at least one member account group");
        if (group.members.length > MAX_STACK_GROUP_REFS) error(errors, `${field}.members`, `has ${group.members.length} references, the cap is ${MAX_STACK_GROUP_REFS}`);
        total += group.members.length;
        let previous = -1;
        for (const [refIndex, rawRef] of group.members.slice(0, MAX_STACK_GROUP_REFS).entries()) {
          const refField = `${field}.members[${refIndex}]`;
          const ref = validateRef(errors, refField, rawRef, manifest, pinnedAccounts, order);
          if (!ref) continue;
          const key = `${ref.lineageId}/${ref.groupId}`;
          const rank = order.get(ref.lineageId)! * 1_000 + (groupOrder.get(key) ?? 0);
          if (rank <= previous) error(errors, `${field}.members`, "out of order: references must follow bottom-to-top member order, then that account's group order");
          previous = Math.max(previous, rank);
          const already = seen.get(key);
          if (already !== undefined) error(errors, `${refField}`, `${expected.get(key) ?? key} is already referenced by ${already}`);
          else seen.set(key, `${field}.id ${id ?? ""}`.trim());
          refs.push(ref);
        }
      }
      if (id === null || title === null || text === null || attention === null) continue;
      groups.push({ id, title, body: text, ...(attention === undefined ? {} : { attention }), examples, members: refs });
    }
    if (total > MAX_STACK_TOTAL_REFS) error(errors, "groups", `reference ${total} member groups in all, the cap is ${MAX_STACK_TOTAL_REFS}`);
    for (const [key, label] of expected) {
      if (!seen.has(key)) error(errors, "groups", `member group ${label} is not referenced by any stack group`);
    }
  }

  if (errors.length > 0 || !witness || summary === null) return { value: null, errors };
  return { value: { witness, summary, groups }, errors: [] };
}

function validateExamples(errors: StageValidationError[], field: string, value: unknown): StageExample[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { error(errors, field, "must be an array"); return []; }
  if (value.length > MAX_EXAMPLES) error(errors, field, `has ${value.length} examples, the cap is ${MAX_EXAMPLES}`);
  const out: StageExample[] = [];
  for (const [index, raw] of value.slice(0, MAX_EXAMPLES).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { error(errors, `${field}[${index}]`, "must be an object"); continue; }
    const example = raw as Record<string, unknown>;
    unsupported(errors, `${field}[${index}]`, example, ["code", "text"]);
    const code = line(errors, `${field}[${index}].code`, example.code, EXAMPLE_CODE_MAX);
    const text = line(errors, `${field}[${index}].text`, example.text, EXAMPLE_TEXT_MAX);
    if (code !== null && text !== null) out.push({ code, text });
  }
  return out;
}

function validateRef(
  errors: StageValidationError[],
  field: string,
  raw: unknown,
  manifest: StackManifestRow,
  pinnedAccounts: Map<string, ReviewAccountRow>,
  order: Map<string, number>,
): StackGroupRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { error(errors, field, "must be an object"); return null; }
  const ref = raw as Record<string, unknown>;
  unsupported(errors, field, ref, ["lineageId", "revision", "accountVersion", "groupId"]);
  if (typeof ref.lineageId !== "string" || !order.has(ref.lineageId)) {
    error(errors, `${field}.lineageId`, "must name a pinned member of this manifest");
    return null;
  }
  const member = manifest.doc.members.find((candidate) => candidate.lineageId === ref.lineageId)!;
  const account = pinnedAccounts.get(ref.lineageId);
  if (!account || member.accountId === null || member.accountVersion === null) {
    error(errors, `${field}.lineageId`, `"${member.lineageSlug}" has no pinned account on this manifest`);
    return null;
  }
  if (ref.revision !== member.revision) {
    error(errors, `${field}.revision`, `must be ${member.revision}, the revision this manifest pins for "${member.lineageSlug}"`);
    return null;
  }
  if (ref.accountVersion !== member.accountVersion) {
    error(errors, `${field}.accountVersion`, `must be ${member.accountVersion}, the account this manifest pins for "${member.lineageSlug}"`);
    return null;
  }
  if (typeof ref.groupId !== "string" || !SLUG_RE.test(ref.groupId) || !account.doc.groups.some((group) => group.id === ref.groupId)) {
    error(errors, `${field}.groupId`, `is not a group of "${member.lineageSlug}" account v${member.accountVersion}`);
    return null;
  }
  return { lineageId: ref.lineageId, revision: member.revision, accountVersion: member.accountVersion, groupId: ref.groupId };
}
