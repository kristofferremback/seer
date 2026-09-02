// What moved between two retained captures, and what did not.
//
// One deterministic boundary over two `StageCaptureInventory` values and, separately, two
// account documents. It reads rows and nothing else: no blob is fetched, no GitHub call is
// made, and no display prose decides anything. Handed the same two captures twice it
// returns the same answer, which is the only reason a carried read is allowed to exist.
//
// The rule underneath every key here is ONE UNIQUE EXACT MATCH. A key that occurs once in
// the previous capture and once in the current one identifies the same material; a key that
// occurs twice on either side identifies nothing, and produces no equivalence rather than
// an arbitrary pairing. That is stricter than a diff tool would be, deliberately: the
// consequence of being wrong is a member's "I have read this" carried onto code they have
// never seen.
//
// Delta CLASSIFICATION and handling CARRY are separate strengths on purpose. Classification
// may pair two placements to say "this was revised", because being wrong there costs a
// count on a line of text. Carry only ever follows a unique exact match.

import { createHash } from "node:crypto";
import type { StageCaptureFileRow, StageCaptureInventory } from "../stage/db";
import type { AccountDoc } from "./revision-types";
import { digestOf } from "./revision-db";

// ---- results ----

export type DeltaStatus = "unchanged" | "revised" | "new" | "removed";
export type DeltaItemType = "change" | "material" | "file";

/**
 * One item's fate, named by ids and paths the authorized retained document already
 * carries. Blob digests and Git object ids participate in the KEY and never appear here:
 * they are how a match is proved, not something a reader is owed.
 */
export interface DeltaItem {
  type: DeltaItemType;
  status: DeltaStatus;
  /** The previous capture's item id, or null when this item is new. */
  oldId: string | null;
  /** The current capture's item id, or null when this item is gone. */
  newId: string | null;
  /** Rename-resolved where a rename was unambiguous; null for capture-level material. */
  path: string | null;
  /** The changed file's own status word, for a file item that carries no other material. */
  fileStatus: string | null;
}

export interface DeltaCounts {
  unchanged: number;
  revised: number;
  new: number;
  removed: number;
}

/** One exact text equivalence: the previous change, the current change that is the same
 *  change, and the digest of the key that proved it. */
export interface TextEquivalence {
  sourceChangeId: string;
  targetChangeId: string;
  digest: string;
}

export interface RevisionCodeDelta {
  counts: DeltaCounts;
  items: DeltaItem[];
  /** Keyed by the PREVIOUS change id, which is what a stored read names. */
  equivalences: Map<string, TextEquivalence>;
}

/**
 * A key is a JSON array rather than a joined string, so no field's tail can read as the
 * next field's head. A path may contain any byte a separator could; a length-delimited
 * encoding has nothing to escape and nothing to collide.
 */
function keyOf(parts: (string | null)[]): string {
  return JSON.stringify(parts);
}

// ---- path resolution ----

export interface PathResolution {
  /** The current path a previous path continues as, or null when no unambiguous one
   *  exists — which is what "ambiguous renames produce no equivalence" means in code. */
  resolve(previousPath: string): string | null;
}

/**
 * Map previous paths onto current paths, by declared rename and by identity only.
 *
 * No similarity score, no basename heuristic, no "these two files look alike". A rename is
 * something the capture recorded, and where it recorded two of them onto one path — or a
 * path that is both a rename target and a file of its own — there is no single answer, so
 * there is no answer at all.
 *
 * Every capture records renames against the merge base, so a pull request that renamed
 * `old.ts` to `new.ts` carries that same `old_path → path` pair in every revision. The
 * pair is the file's identity across captures: a previous file whose pair the current
 * capture records again is the same file, and only when no such pair exists does the
 * question fall through to rename targets and plain path identity.
 */
export function resolvePaths(
  previous: StageCaptureInventory,
  current: StageCaptureInventory,
): PathResolution {
  const targets = new Map<string, Set<string>>();
  const identity = new Set<string>();
  const occupied = new Set<string>();
  const pairs = new Set<string>();
  for (const file of current.files) {
    occupied.add(file.path);
    if (file.old_path !== null && file.old_path !== file.path) {
      const held = targets.get(file.old_path) ?? new Set<string>();
      held.add(file.path);
      targets.set(file.old_path, held);
      pairs.add(keyOf([file.old_path, file.path]));
    } else {
      identity.add(file.path);
    }
  }
  const answers = new Map<string, string | null>();
  for (const file of previous.files) {
    if (answers.has(file.path)) continue;
    const renamed = file.old_path !== null && file.old_path !== file.path ? file.old_path : null;
    if (renamed !== null && pairs.has(keyOf([renamed, file.path]))) {
      // The same rename, recorded again: the file continues under the same name.
      answers.set(file.path, file.path);
      continue;
    }
    const candidates = new Set(targets.get(file.path) ?? []);
    // A file the previous capture already saw renamed from `renamed` may be renamed
    // again from that same original in the current one; both readings name one file.
    if (renamed !== null) for (const path of targets.get(renamed) ?? []) candidates.add(path);
    if (identity.has(file.path)) candidates.add(file.path);
    if (candidates.size === 1) {
      answers.set(file.path, [...candidates][0]!);
    } else if (candidates.size > 1) {
      // Two current files claim one previous path, or a rename target collides with a file
      // of the same name. Either way nothing here is the continuation of that path.
      answers.set(file.path, null);
    } else if (occupied.has(file.path)) {
      // Nothing claims it, but something else now sits at that name — a delete beside a
      // rename INTO the freed path. The previous file is gone; the current one is not it.
      answers.set(file.path, null);
    } else {
      // Removed. Keeping the previous name is what lets its items key stably as removed.
      answers.set(file.path, file.path);
    }
  }
  return {
    resolve: (path) => (answers.has(path) ? answers.get(path)! : path),
  };
}

// ---- keys ----

/** The bracketed machine code a capture prefixes a budget refusal with, and nothing else.
 *  Display prose after it is deliberately dropped: a sentence that gains a word must not
 *  turn a stable limitation into permanent movement, and prose must never authorize carry. */
function machineReason(reason: string): string {
  return /^\[[a-z0-9_:.-]+\]/.exec(reason)?.[0] ?? "";
}

interface Placed {
  type: DeltaItemType;
  id: string;
  path: string | null;
  fileStatus: string | null;
  /** The exact equivalence key. A unique match on BOTH sides is `unchanged`. */
  key: string;
  /** The coarser placement. The same placement with a different key is `revised`. */
  placement: string;
}

interface SideIdentity {
  kind: string | null;
  mode: string | null;
  objectId: string | null;
}

function sideOf(
  file: StageCaptureFileRow | undefined,
  side: "old" | "new" | "snapshot",
): SideIdentity {
  if (!file || side === "snapshot") return { kind: null, mode: null, objectId: null };
  return side === "old"
    ? { kind: file.old_kind, mode: file.old_mode, objectId: file.old_object_id }
    : { kind: file.new_kind, mode: file.new_mode, objectId: file.new_object_id };
}

/**
 * Every reviewable item of one capture, keyed and placed in the shared path space.
 *
 * The item set is exactly the reader's: canonical changes, explicit incomplete material,
 * and files that carry neither. Anything else would make the delta's totals a different
 * count from the walkthrough's.
 */
function describe(
  inventory: StageCaptureInventory,
  resolve: (path: string) => string | null,
): Placed[] {
  const fileById = new Map(inventory.files.map((file) => [file.id, file]));
  const fileByPath = new Map<string, StageCaptureFileRow>();
  for (const file of inventory.files) if (!fileByPath.has(file.path)) fileByPath.set(file.path, file);
  const changedFiles = new Set(inventory.changes.map((change) => change.file_id));
  const materialPaths = new Set(
    inventory.incomplete.map((item) => item.path).filter((path): path is string => path !== null),
  );

  const placed: Placed[] = [];
  /** An item whose placement is ambiguous keys on its own id, so it matches nothing on
   *  either side and is reported honestly as removed or new. */
  const unplaceable = (
    type: DeltaItemType,
    id: string,
    path: string | null,
    fileStatus: string | null,
  ): Placed => ({ type, id, path, fileStatus, key: keyOf(["unplaced", id]), placement: keyOf(["unplaced", id]) });

  for (const change of inventory.changes) {
    const file = fileById.get(change.file_id);
    const resolved = file ? resolve(file.path) : null;
    if (!file || resolved === null) {
      placed.push(unplaceable("change", change.id, file?.path ?? null, null));
      continue;
    }
    placed.push({
      type: "change",
      id: change.id,
      path: resolved,
      fileStatus: file.status,
      key: keyOf(["text", resolved, change.old_fingerprint, change.new_fingerprint, change.context_fingerprint]),
      placement: keyOf(["text", resolved]),
    });
  }

  for (const item of inventory.incomplete) {
    const resolved = item.path === null ? null : resolve(item.path);
    if (item.path !== null && resolved === null) {
      placed.push(unplaceable("material", item.id, item.path, null));
      continue;
    }
    const identity = sideOf(item.path === null ? undefined : fileByPath.get(item.path), item.side);
    // Object identity when the capture knows one; otherwise the machine reason code alone.
    // Identical prose at an identical placement is therefore unchanged, so a stable binary
    // or 300-file limitation does not read as movement every time it is captured again.
    const tail = identity.objectId !== null
      ? [identity.kind ?? "", identity.mode ?? "", identity.objectId]
      : [machineReason(item.reason)];
    placed.push({
      type: "material",
      id: item.id,
      path: resolved,
      fileStatus: null,
      key: keyOf(["nontext", "material", item.kind, resolved, item.side, ...tail]),
      placement: keyOf(["nontext", "material", item.kind, resolved, item.side]),
    });
  }

  for (const file of inventory.files) {
    if (changedFiles.has(file.id) || materialPaths.has(file.path)) continue;
    const resolved = resolve(file.path);
    if (resolved === null) {
      placed.push(unplaceable("file", file.id, file.path, file.status));
      continue;
    }
    placed.push({
      type: "file",
      id: file.id,
      path: resolved,
      fileStatus: file.status,
      key: keyOf(["nontext", "file", resolved, file.status,
        file.old_kind, file.old_mode, file.old_object_id,
        file.new_kind, file.new_mode, file.new_object_id]),
      placement: keyOf(["nontext", "file", resolved]),
    });
  }
  return placed;
}

function tally(items: Placed[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  return counts;
}

/**
 * Both captures' items, each classified exactly once.
 *
 * Exact keys first, and only where the key is unique on BOTH sides. What is left is paired
 * by placement in canonical inventory order, which is what lets "the same hunk, rewritten"
 * read as one revision rather than as a deletion beside an arrival. That ordinal pairing
 * decides a count and never a carry.
 */
export function revisionCodeDelta(
  previous: StageCaptureInventory,
  current: StageCaptureInventory,
): RevisionCodeDelta {
  const resolution = resolvePaths(previous, current);
  const before = describe(previous, (path) => resolution.resolve(path));
  const after = describe(current, (path) => path);

  const beforeKeys = tally(before);
  const afterKeys = tally(after);
  const beforeByKey = new Map<string, Placed>();
  for (const item of before) if (beforeKeys.get(item.key) === 1) beforeByKey.set(item.key, item);

  const items: DeltaItem[] = [];
  const equivalences = new Map<string, TextEquivalence>();
  const pairedBefore = new Set<string>();
  const leftoverAfter: Placed[] = [];

  for (const item of after) {
    const twin = afterKeys.get(item.key) === 1 ? beforeByKey.get(item.key) : undefined;
    if (!twin) {
      leftoverAfter.push(item);
      continue;
    }
    pairedBefore.add(twin.id);
    items.push({ type: item.type, status: "unchanged", oldId: twin.id, newId: item.id, path: item.path, fileStatus: item.fileStatus });
    if (item.type === "change") {
      equivalences.set(twin.id, {
        sourceChangeId: twin.id,
        targetChangeId: item.id,
        digest: createHash("sha256").update(item.key).digest("hex"),
      });
    }
  }

  const leftoverBefore = before.filter((item) => !pairedBefore.has(item.id));

  // An exact duplicate key is unchanged evidence, even though it is too ambiguous to
  // authorize a read carry. Pair equal leftovers only for classification; equivalences
  // remain reserved for the one-to-one unique pass above.
  const exact = new Map<string, Placed[]>();
  for (const item of leftoverBefore) {
    const held = exact.get(item.key) ?? [];
    held.push(item);
    exact.set(item.key, held);
  }
  const placementAfter: Placed[] = [];
  for (const item of leftoverAfter) {
    const twin = exact.get(item.key)?.shift();
    if (!twin) {
      placementAfter.push(item);
      continue;
    }
    pairedBefore.add(twin.id);
    items.push({ type: item.type, status: "unchanged", oldId: twin.id, newId: item.id, path: item.path, fileStatus: item.fileStatus });
  }

  const placements = new Map<string, Placed[]>();
  for (const item of leftoverBefore) {
    if (pairedBefore.has(item.id)) continue;
    const held = placements.get(item.placement) ?? [];
    held.push(item);
    placements.set(item.placement, held);
  }
  for (const item of placementAfter) {
    const twin = placements.get(item.placement)?.shift();
    if (!twin) {
      items.push({ type: item.type, status: "new", oldId: null, newId: item.id, path: item.path, fileStatus: item.fileStatus });
      continue;
    }
    pairedBefore.add(twin.id);
    items.push({ type: item.type, status: "revised", oldId: twin.id, newId: item.id, path: item.path, fileStatus: item.fileStatus });
  }
  for (const item of leftoverBefore) {
    if (pairedBefore.has(item.id)) continue;
    items.push({ type: item.type, status: "removed", oldId: item.id, newId: null, path: item.path, fileStatus: item.fileStatus });
  }

  const counts: DeltaCounts = { unchanged: 0, revised: 0, new: 0, removed: 0 };
  for (const item of items) counts[item.status] += 1;
  return { counts, items, equivalences };
}

// ---- the account ----

export type AccountSummaryDelta = "unchanged" | "revised" | "absent";
export type AccountEntityKind = "group" | "focus" | "evidence";

export interface AccountEntityDelta {
  kind: AccountEntityKind;
  id: string;
  status: DeltaStatus;
}

export interface RevisionAccountDelta {
  summary: AccountSummaryDelta;
  counts: DeltaCounts;
  entities: AccountEntityDelta[];
}

/** An evidence reference's identity: the attachment it points at, or the exact bundle
 *  version. Never its caption, which is prose the witness may reword. */
function evidenceKey(ref: AccountDoc["evidence"][number]): string {
  return ref.kind === "bundle" ? `bundle:${ref.slug}:${ref.version}` : `attachment:${ref.id}`;
}

function entityDelta<T>(
  kind: AccountEntityKind,
  prior: T[],
  current: T[],
  idOf: (item: T) => string,
  authoredOf: (item: T) => unknown,
): AccountEntityDelta[] {
  const before = new Map<string, string>();
  for (const item of prior) before.set(idOf(item), digestOf(authoredOf(item)));
  const seen = new Set<string>();
  const out: AccountEntityDelta[] = [];
  for (const item of current) {
    const id = idOf(item);
    seen.add(id);
    const held = before.get(id);
    if (held === undefined) out.push({ kind, id, status: "new" });
    else out.push({ kind, id, status: held === digestOf(authoredOf(item)) ? "unchanged" : "revised" });
  }
  for (const item of prior) {
    const id = idOf(item);
    if (!seen.has(id)) out.push({ kind, id, status: "removed" });
  }
  return out;
}

/**
 * What one account changed about the one before it.
 *
 * Identity is the witness's own stable id — a group id, a focus id, an attachment id, or a
 * bundle version — and never position, because a witness who reorders their groups has not
 * rewritten any of them. A removed entity is reported as removed and linked back to the
 * account that still holds it; nothing here rewrites a published account.
 */
export function accountDelta(
  prior: AccountDoc | null,
  current: AccountDoc | null,
): RevisionAccountDelta | null {
  if (!prior) return null;
  if (!current) {
    const entities: AccountEntityDelta[] = [
      ...prior.groups.map((group) => ({ kind: "group" as const, id: group.id, status: "removed" as const })),
      ...prior.focus.map((item) => ({ kind: "focus" as const, id: item.id, status: "removed" as const })),
      ...prior.evidence.map((ref) => ({ kind: "evidence" as const, id: evidenceKey(ref), status: "removed" as const })),
    ];
    return { summary: "absent", counts: { unchanged: 0, revised: 0, new: 0, removed: entities.length }, entities };
  }
  const entities = [
    ...entityDelta("group", prior.groups, current.groups, (group) => group.id, (group) => ({
      title: group.title,
      category: group.category,
      importance: group.importance,
      complexity: group.complexity,
      explanation: group.explanation,
      attention: group.attention ?? null,
      examples: group.examples,
      members: group.members,
    })),
    ...entityDelta("focus", prior.focus, current.focus, (item) => item.id, (item) => ({
      kind: item.kind, title: item.title, body: item.body, anchors: item.anchors,
    })),
    ...entityDelta("evidence", prior.evidence, current.evidence, evidenceKey, (ref) => ref),
  ];
  const counts: DeltaCounts = { unchanged: 0, revised: 0, new: 0, removed: 0 };
  for (const entity of entities) counts[entity.status] += 1;
  return {
    summary: prior.witness.summary === current.witness.summary ? "unchanged" : "revised",
    counts,
    entities,
  };
}
