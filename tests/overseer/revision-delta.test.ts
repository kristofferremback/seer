// What moved between two retained captures, and — much more carefully — what did not.
//
// Everything here is built from row shapes rather than from a database or a fixture
// repository, because the engine's whole contract is that it reads rows: the same two
// inventories must produce the same answer with no store, no network and no clock. A test
// that had to capture two branches first would be testing the capture.
//
// The two strengths are asserted separately throughout. `counts` is a display fact and may
// pair two placements to call something revised; `equivalences` is what authorizes carrying
// a member's "I have read this" onto code they have not opened, and only ever follows one
// unique exact match on both sides.

import { describe, expect, test } from "bun:test";
import { accountDelta, resolvePaths, revisionCodeDelta } from "../../src/overseer/revision-delta";
import type {
  StageCaptureChangeRow,
  StageCaptureFileRow,
  StageCaptureInventory,
  StageCaptureRow,
  StageIncompleteRow,
} from "../../src/stage/db";
import type { AccountDoc } from "../../src/overseer/revision-types";

const WS = "ws_delta00000";

function captureRow(id: string): StageCaptureRow {
  return {
    id, workspace_id: WS, slug: "delta", repo: "acme/repo", repo_id: 7, branch: "feature",
    base_ref: "main", source_head_sha: "h".repeat(40), base_tip_sha: "b".repeat(40),
    merge_base_sha: "m".repeat(40), patch_sha256: null, state: "completed", created_at: 1,
  };
}

function file(
  captureId: string,
  id: string,
  path: string,
  overrides: Partial<StageCaptureFileRow> = {},
): StageCaptureFileRow {
  return {
    id, workspace_id: WS, capture_id: captureId, path, old_path: null, status: "modified",
    old_object_id: null, new_object_id: null, old_mode: null, new_mode: null,
    old_kind: null, new_kind: null, additions: null, deletions: null,
    old_availability: "retained", new_availability: "retained",
    old_blob_sha: null, new_blob_sha: null, old_reason: null, new_reason: null,
    ...overrides,
  };
}

/** Line positions are passed but deliberately never asserted on: they are exactly what a
 *  rebase moves, and exactly what must not decide whether a read carries. */
function change(
  captureId: string,
  id: string,
  fileId: string,
  fingerprints: { old: string; new: string; context: string },
  positions: { oldStart?: number; newStart?: number } = {},
): StageCaptureChangeRow {
  return {
    id: `chg_${id.padEnd(64, "0")}`, workspace_id: WS, capture_id: captureId, file_id: fileId,
    old_start: positions.oldStart ?? 1, old_lines: 1,
    new_start: positions.newStart ?? 1, new_lines: 1,
    old_fingerprint: fingerprints.old, new_fingerprint: fingerprints.new,
    context_fingerprint: fingerprints.context, source: "patch",
  };
}

function material(
  captureId: string,
  id: string,
  kind: StageIncompleteRow["kind"],
  path: string | null,
  side: StageIncompleteRow["side"],
  reason: string,
): StageIncompleteRow {
  return { id, workspace_id: WS, capture_id: captureId, kind, path, side, reason };
}

function inventory(
  captureId: string,
  parts: {
    files?: StageCaptureFileRow[];
    changes?: StageCaptureChangeRow[];
    incomplete?: StageIncompleteRow[];
  },
): StageCaptureInventory {
  return {
    capture: captureRow(captureId),
    builder: null,
    files: parts.files ?? [],
    changes: parts.changes ?? [],
    incomplete: parts.incomplete ?? [],
  };
}

const FP = { old: "of1", new: "nf1", context: "cf1" };
const OTHER = { old: "of2", new: "nf2", context: "cf2" };

/** The previous change id every carry assertion names, so the shape of a carry — source
 *  change to target change — is checked rather than merely its count. */
function carries(result: ReturnType<typeof revisionCodeDelta>): { from: string; to: string }[] {
  return [...result.equivalences.values()].map((entry) => ({ from: entry.sourceChangeId, to: entry.targetChangeId }));
}

describe("a rebase moves lines and nothing else", () => {
  test("a position-only move is unchanged and carries, with ids that differ on both sides", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/value.ts")],
      changes: [change("stg_a", "a", "stf_1", FP, { oldStart: 10, newStart: 10 })],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_9", "src/value.ts")],
      changes: [change("stg_b", "z", "stf_9", FP, { oldStart: 812, newStart: 940 })],
    });
    const delta = revisionCodeDelta(before, after);
    expect(delta.counts).toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
    expect(carries(delta)).toEqual([{ from: `chg_${"a".padEnd(64, "0")}`, to: `chg_${"z".padEnd(64, "0")}` }]);
    // The key digest is recorded so a later reader can say what was matched.
    expect([...delta.equivalences.values()][0]!.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changed bytes are revised and carry nothing", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/value.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_1", "src/value.ts")],
      changes: [change("stg_b", "a", "stf_1", { old: "of1", new: "nfCHANGED", context: "cf1" })],
    });
    const delta = revisionCodeDelta(before, after);
    expect(delta.counts).toEqual({ unchanged: 0, revised: 1, new: 0, removed: 0 });
    expect(delta.equivalences.size).toBe(0);
  });

  test("the same fingerprints in another file are not the same change", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/value.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_2", "src/other.ts")],
      changes: [change("stg_b", "a", "stf_2", FP)],
    });
    const delta = revisionCodeDelta(before, after);
    expect(delta.counts).toEqual({ unchanged: 0, revised: 0, new: 1, removed: 1 });
    expect(delta.equivalences.size).toBe(0);
  });

  test("a duplicate candidate on either side is ambiguous and carries nothing", () => {
    const twice = (captureId: string, fileId: string) => [
      change(captureId, "a", fileId, FP, { oldStart: 1 }),
      change(captureId, "b", fileId, FP, { oldStart: 90 }),
    ];
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/value.ts")],
      changes: twice("stg_a", "stf_1"),
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_1", "src/value.ts")],
      changes: twice("stg_b", "stf_1"),
    });
    const delta = revisionCodeDelta(before, after);
    // Exact duplicate evidence is unchanged, but its ambiguity still authorizes no carry.
    expect(delta.counts).toEqual({ unchanged: 2, revised: 0, new: 0, removed: 0 });
    expect(delta.equivalences.size).toBe(0);
  });

  test("a split is one revision and one arrival; a merge is one revision and one departure", () => {
    const one = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/value.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const two = inventory("stg_b", {
      files: [file("stg_b", "stf_1", "src/value.ts")],
      changes: [change("stg_b", "a", "stf_1", OTHER), change("stg_b", "b", "stf_1", { old: "of3", new: "nf3", context: "cf3" })],
    });
    expect(revisionCodeDelta(one, two).counts).toEqual({ unchanged: 0, revised: 1, new: 1, removed: 0 });
    expect(revisionCodeDelta(one, two).equivalences.size).toBe(0);
    expect(revisionCodeDelta(two, one).counts).toEqual({ unchanged: 0, revised: 1, new: 0, removed: 1 });
    expect(revisionCodeDelta(two, one).equivalences.size).toBe(0);
  });

  test("a deleted file is removed and carries nothing", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/gone.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", { files: [], changes: [] });
    const delta = revisionCodeDelta(before, after);
    expect(delta.counts).toEqual({ unchanged: 0, revised: 0, new: 0, removed: 1 });
    expect(delta.items[0]).toMatchObject({ status: "removed", path: "src/gone.ts", newId: null });
    expect(delta.equivalences.size).toBe(0);
  });
});

describe("a rename is something the capture recorded, or it is nothing", () => {
  test("an exact rename resolves and carries", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/old.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_2", "src/new.ts", { old_path: "src/old.ts", status: "renamed" })],
      changes: [change("stg_b", "z", "stf_2", FP)],
    });
    expect(resolvePaths(before, after).resolve("src/old.ts")).toBe("src/new.ts");
    const delta = revisionCodeDelta(before, after);
    expect(delta.counts).toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
    expect(carries(delta)).toHaveLength(1);
  });

  test("two files claiming one previous path resolve to nothing and carry nothing", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/old.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", {
      files: [
        file("stg_b", "stf_2", "src/new-a.ts", { old_path: "src/old.ts", status: "renamed" }),
        file("stg_b", "stf_3", "src/new-b.ts", { old_path: "src/old.ts", status: "renamed" }),
      ],
      changes: [change("stg_b", "y", "stf_2", FP), change("stg_b", "z", "stf_3", FP)],
    });
    expect(resolvePaths(before, after).resolve("src/old.ts")).toBeNull();
    const delta = revisionCodeDelta(before, after);
    expect(delta.equivalences.size).toBe(0);
    expect(delta.counts.unchanged).toBe(0);
    expect(delta.counts.removed).toBe(1);
  });

  test("a delete beside a rename into the freed name resolves to nothing", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "src/taken.ts"), file("stg_a", "stf_2", "src/other.ts")],
      changes: [change("stg_a", "a", "stf_1", FP)],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_3", "src/taken.ts", { old_path: "src/other.ts", status: "renamed" })],
      changes: [change("stg_b", "z", "stf_3", FP)],
    });
    expect(resolvePaths(before, after).resolve("src/taken.ts")).toBeNull();
    expect(revisionCodeDelta(before, after).equivalences.size).toBe(0);
  });
});

describe("material without line changes still has an identity", () => {
  const binary = (captureId: string, object: string) => inventory(captureId, {
    files: [file(captureId, "stf_1", "assets/logo.png", {
      status: "modified", old_kind: "blob", new_kind: "blob", old_mode: "100644", new_mode: "100644",
      old_object_id: "o".repeat(40), new_object_id: object,
    })],
    incomplete: [material(captureId, `sti_${captureId}`, "lines_unavailable", "assets/logo.png", "new",
      "Binary bytes are retained, but line changes are unavailable.")],
  });

  test("identical object identity at the same placement is unchanged", () => {
    const delta = revisionCodeDelta(binary("stg_a", "n".repeat(40)), binary("stg_b", "n".repeat(40)));
    expect(delta.counts).toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
    // Non-text material has no handling mutation yet, so nothing carries either way.
    expect(delta.equivalences.size).toBe(0);
  });

  test("a different Git object at the same placement is revised", () => {
    const delta = revisionCodeDelta(binary("stg_a", "n".repeat(40)), binary("stg_b", "p".repeat(40)));
    expect(delta.counts).toEqual({ unchanged: 0, revised: 1, new: 0, removed: 0 });
  });

  test("a mode-only change on a leafless file is revised, and an identical one is unchanged", () => {
    const leafless = (captureId: string, mode: string) => inventory(captureId, {
      files: [file(captureId, "stf_1", "bin/run.sh", {
        status: "mode_changed", old_kind: "blob", new_kind: "blob",
        old_mode: "100644", new_mode: mode, old_object_id: "o".repeat(40), new_object_id: "o".repeat(40),
      })],
    });
    expect(revisionCodeDelta(leafless("stg_a", "100755"), leafless("stg_b", "100755")).counts)
      .toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
    expect(revisionCodeDelta(leafless("stg_a", "100755"), leafless("stg_b", "100644")).counts)
      .toEqual({ unchanged: 0, revised: 1, new: 0, removed: 0 });
  });

  test("a symlink and a submodule keep their own object identity", () => {
    const odd = (captureId: string, target: string, commit: string) => inventory(captureId, {
      files: [
        file(captureId, "stf_1", "link", { old_kind: "blob", new_kind: "blob", old_mode: "120000", new_mode: "120000", old_object_id: target, new_object_id: target }),
        file(captureId, "stf_2", "vendor/lib", { old_kind: "commit", new_kind: "commit", old_mode: "160000", new_mode: "160000", old_object_id: commit, new_object_id: commit }),
      ],
    });
    expect(revisionCodeDelta(odd("stg_a", "t".repeat(40), "c".repeat(40)), odd("stg_b", "t".repeat(40), "c".repeat(40))).counts)
      .toEqual({ unchanged: 2, revised: 0, new: 0, removed: 0 });
    expect(revisionCodeDelta(odd("stg_a", "t".repeat(40), "c".repeat(40)), odd("stg_b", "t".repeat(40), "d".repeat(40))).counts)
      .toEqual({ unchanged: 1, revised: 1, new: 0, removed: 0 });
  });

  test("identical capture-level prose at an identical placement is zero phantom movement", () => {
    const ceiling = (captureId: string) => inventory(captureId, {
      incomplete: [material(captureId, `sti_${captureId}`, "metadata_incomplete", null, "snapshot",
        "GitHub compare returned its 300-file ceiling; tree facts are complete, but omitted rename and patch metadata may exist.")],
    });
    expect(revisionCodeDelta(ceiling("stg_a"), ceiling("stg_b")).counts)
      .toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
  });

  test("a machine reason code decides, and the prose after it does not", () => {
    const budget = (captureId: string, prefix: string, prose: string) => inventory(captureId, {
      files: [file(captureId, "stf_1", "big.bin")],
      incomplete: [material(captureId, `sti_${captureId}`, "bytes_unavailable", "big.bin", "new", `${prefix} ${prose}`)],
    });
    // The same limitation, reworded and recounted, is still the same limitation.
    expect(revisionCodeDelta(
      budget("stg_a", "[budget:blob_requests]", "The capture made 1000 blob requests."),
      budget("stg_b", "[budget:blob_requests]", "The capture made 1000 unique Git blob requests."),
    ).counts).toEqual({ unchanged: 1, revised: 0, new: 0, removed: 0 });
    // A different limitation is not.
    expect(revisionCodeDelta(
      budget("stg_a", "[budget:blob_requests]", "over budget"),
      budget("stg_b", "[budget:logical_bytes]", "over budget"),
    ).counts).toEqual({ unchanged: 0, revised: 1, new: 0, removed: 0 });
  });

  test("both-tree truncation matches per side, and legacy snapshot rows stay unmatched", () => {
    const sided = (captureId: string) => inventory(captureId, {
      incomplete: [
        material(captureId, `sti_${captureId}_old`, "snapshot_incomplete", null, "old", "GitHub truncated the old commit tree; the path inventory is incomplete."),
        material(captureId, `sti_${captureId}_new`, "snapshot_incomplete", null, "new", "GitHub truncated the new commit tree; the path inventory is incomplete."),
      ],
    });
    expect(revisionCodeDelta(sided("stg_a"), sided("stg_b")).counts)
      .toEqual({ unchanged: 2, revised: 0, new: 0, removed: 0 });

    // A capture written before the sides were separated has two rows that key alike. They
    // remain ambiguous for handling carry, but unchanged delta must not invent movement.
    const legacy = (captureId: string) => inventory(captureId, {
      incomplete: [
        material(captureId, `sti_${captureId}_1`, "snapshot_incomplete", null, "snapshot", "GitHub truncated the old commit tree; the path inventory is incomplete."),
        material(captureId, `sti_${captureId}_2`, "snapshot_incomplete", null, "snapshot", "GitHub truncated the new commit tree; the path inventory is incomplete."),
      ],
    });
    expect(revisionCodeDelta(legacy("stg_a"), legacy("stg_b")).counts)
      .toEqual({ unchanged: 2, revised: 0, new: 0, removed: 0 });
  });
});

describe("every item is classified exactly once", () => {
  test("a mixed capture accounts for both sides completely", () => {
    const before = inventory("stg_a", {
      files: [
        file("stg_a", "stf_1", "src/kept.ts"),
        file("stg_a", "stf_2", "src/gone.ts"),
        file("stg_a", "stf_3", "bin/tool", { status: "mode_changed", old_mode: "100644", new_mode: "100755" }),
      ],
      changes: [change("stg_a", "a", "stf_1", FP), change("stg_a", "b", "stf_2", OTHER)],
      incomplete: [material("stg_a", "sti_a", "metadata_incomplete", null, "snapshot", "ceiling")],
    });
    const after = inventory("stg_b", {
      files: [
        file("stg_b", "stf_1", "src/kept.ts"),
        file("stg_b", "stf_4", "src/arrived.ts", { status: "added" }),
        file("stg_b", "stf_3", "bin/tool", { status: "mode_changed", old_mode: "100644", new_mode: "100755" }),
      ],
      changes: [change("stg_b", "a", "stf_1", FP), change("stg_b", "c", "stf_4", { old: "of4", new: "nf4", context: "cf4" })],
      incomplete: [material("stg_b", "sti_b", "metadata_incomplete", null, "snapshot", "ceiling")],
    });
    const delta = revisionCodeDelta(before, after);
    const totalBefore = before.changes.length + before.incomplete.length + 1; // the leafless bin/tool
    const totalAfter = after.changes.length + after.incomplete.length + 1;
    const paired = delta.items.filter((item) => item.oldId !== null && item.newId !== null).length;
    expect(delta.items.filter((item) => item.oldId !== null).length).toBe(totalBefore);
    expect(delta.items.filter((item) => item.newId !== null).length).toBe(totalAfter);
    expect(delta.items.length).toBe(totalBefore + totalAfter - paired);
    expect(delta.counts.unchanged + delta.counts.revised).toBe(paired);
  });

  test("no blob digest or Git object id reaches an item record", () => {
    const before = inventory("stg_a", {
      files: [file("stg_a", "stf_1", "assets/logo.png", { old_object_id: "o".repeat(40), new_object_id: "n".repeat(40), old_blob_sha: "d".repeat(64), new_blob_sha: "e".repeat(64) })],
    });
    const after = inventory("stg_b", {
      files: [file("stg_b", "stf_1", "assets/logo.png", { old_object_id: "o".repeat(40), new_object_id: "q".repeat(40), old_blob_sha: "d".repeat(64), new_blob_sha: "f".repeat(64) })],
    });
    const serialized = JSON.stringify(revisionCodeDelta(before, after).items);
    for (const secret of ["o".repeat(40), "n".repeat(40), "q".repeat(40), "d".repeat(64), "e".repeat(64), "f".repeat(64)]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("an account is compared by the witness's own ids", () => {
  const group = (id: string, title: string, explanation: string) => ({
    id, title, category: "Code" as const, importance: "low" as const, complexity: "low" as const,
    explanation, examples: [], members: [],
  });

  const account = (overrides: Partial<AccountDoc>): AccountDoc => ({
    identity: { lineageId: "rln_0000000000", slug: "acct", revision: 1, version: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    witness: { summary: "It reads.", agent: { name: "W", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    groups: [group("one", "One", "First.")],
    focus: [],
    evidence: [],
    ...overrides,
  });

  test("stable ids distinguish unchanged, revised, new and removed", () => {
    const prior = account({
      groups: [group("one", "One", "First."), group("two", "Two", "Second.")],
      focus: [{ id: "risk-a", kind: "risk", title: "A", body: "Body", anchors: [{ type: "change", id: "chg" }] }],
      evidence: [{ kind: "bundle", slug: "shot", version: 1 }],
    });
    const current = account({
      // Reordered on purpose: a witness who moves a group has not rewritten it.
      groups: [group("two", "Two", "Second."), group("one", "One", "Rewritten."), group("three", "Three", "Third.")],
      focus: [],
      evidence: [{ kind: "bundle", slug: "shot", version: 2 }],
    });
    const delta = accountDelta(prior, current)!;
    expect(delta.summary).toBe("unchanged");
    const status = (kind: string, id: string) => delta.entities.find((entity) => entity.kind === kind && entity.id === id)?.status;
    expect(status("group", "one")).toBe("revised");
    expect(status("group", "two")).toBe("unchanged");
    expect(status("group", "three")).toBe("new");
    expect(status("focus", "risk-a")).toBe("removed");
    // A bundle version is part of the evidence's identity, so v2 is a different reference.
    expect(status("evidence", "bundle:shot:1")).toBe("removed");
    expect(status("evidence", "bundle:shot:2")).toBe("new");
    expect(delta.counts).toEqual({ unchanged: 1, revised: 1, new: 2, removed: 2 });
  });

  test("the summary is unchanged, revised, or absent, and a first account compares to nothing", () => {
    const prior = account({});
    expect(accountDelta(prior, account({}))!.summary).toBe("unchanged");
    expect(accountDelta(prior, account({
      witness: { summary: "It reads differently.", agent: { name: "W", model: "m" }, userId: "usr_0000000000", keyId: "key_0000000000" },
    }))!.summary).toBe("revised");
    const absent = accountDelta(prior, null)!;
    expect(absent.summary).toBe("absent");
    expect(absent.counts.removed).toBe(prior.groups.length);
    expect(accountDelta(null, account({}))).toBeNull();
  });
});
