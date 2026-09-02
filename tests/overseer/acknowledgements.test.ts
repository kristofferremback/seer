import { beforeAll, describe, expect, test } from "bun:test";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { tinyId } from "../../src/ids";
import { migrate } from "../../src/migrate";
import {
  carryRevisionAcknowledgements,
  listRevisionAcknowledgementCarries,
  listRevisionAcknowledgements,
  setRevisionAcknowledgement,
} from "../../src/overseer/acknowledgements-db";
import type { ExactItemEquivalence, ReviewItemIdentity } from "../../src/overseer/revision-delta";

let workspace = "";
let otherWorkspace = "";
let owner = "";
let lineage = "";
let otherLineage = "";

function revision(number: number, workspaceId = workspace, lineageId = lineage): string {
  const id = tinyId("rvr");
  db.run(
    "INSERT INTO review_revisions (id, workspace_id, lineage_id, slug, revision, capture_id, schema_version, doc, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, '{}', 'digest', ?)",
    [id, workspaceId, lineageId, `ack-${id.slice(4)}`, number, tinyId("stg"), Date.now()],
  );
  return id;
}

function item(type: "material" | "file", id = tinyId(type === "file" ? "stf" : "sti"), digest = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")): ReviewItemIdentity {
  return {
    type,
    id,
    fileId: type === "file" ? id : null,
    path: type === "file" ? "bin/run.sh" : null,
    placement: [type, id],
    evidence: [digest],
    digest,
  };
}

function equivalence(source: ReviewItemIdentity, target: ReviewItemIdentity): ExactItemEquivalence {
  return {
    type: source.type as "material" | "file",
    sourceId: source.id,
    targetId: target.id,
    sourceDigest: source.digest,
    targetDigest: target.digest,
    equivalenceDigest: crypto.randomUUID().replaceAll("-", "").padEnd(64, "f"),
  };
}

beforeAll(() => {
  migrate();
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Acknowledgements", owner);
  otherWorkspace = createWorkspace("Other acknowledgements", owner);
  lineage = tinyId("rln");
  otherLineage = tinyId("rln");
});

describe("active acknowledgement state", () => {
  test("explicit acknowledgement is per member and reversible", async () => {
    const source = revision(1);
    const required = item("material");
    const writes = await Promise.all(Array.from({ length: 8 }, async () => setRevisionAcknowledgement({
      workspaceId: workspace,
      lineageId: lineage,
      revisionId: source,
      userId: owner,
      item: required,
      acknowledged: true,
    })));
    expect(writes.every((row) => row?.provenance_kind === "explicit")).toBe(true);
    const firstAt = listRevisionAcknowledgements(workspace, source, owner).get(required.id)!.acknowledged_at;
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: source, userId: owner, item: required, acknowledged: true, now: firstAt + 10_000 });
    expect(listRevisionAcknowledgements(workspace, source, owner).get(required.id)!.acknowledged_at).toBe(firstAt);
    expect(listRevisionAcknowledgements(workspace, source, owner).size).toBe(1);
    expect(listRevisionAcknowledgements(otherWorkspace, source, owner).size).toBe(0);

    expect(setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: source, userId: owner, item: required, acknowledged: false })).toBeNull();
    expect(listRevisionAcknowledgements(workspace, source, owner).size).toBe(0);
  });

  test("a foreign workspace or lineage cannot write through a valid item", () => {
    const source = revision(1);
    const required = item("file");
    expect(() => setRevisionAcknowledgement({ workspaceId: otherWorkspace, lineageId: lineage, revisionId: source, userId: owner, item: required, acknowledged: true })).toThrow("outside the acknowledgement scope");
    expect(() => setRevisionAcknowledgement({ workspaceId: workspace, lineageId: otherLineage, revisionId: source, userId: owner, item: required, acknowledged: true })).toThrow("outside the acknowledgement scope");
    expect(listRevisionAcknowledgements(workspace, source, owner).size).toBe(0);
  });
});

describe("immutable carry provenance", () => {
  test("completion carry writes provenance first and never restores a target reversal", () => {
    const sourceRevision = revision(1);
    const targetRevision = revision(2);
    const source = item("material");
    const target = item("material");
    const match = equivalence(source, target);
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: sourceRevision, userId: owner, item: source, acknowledged: true, now: 10 });

    expect(carryRevisionAcknowledgements({
      workspaceId: workspace,
      lineageId: lineage,
      sourceRevisionId: sourceRevision,
      targetRevisionId: targetRevision,
      equivalences: new Map([[source.id, match]]),
      now: 20,
    })).toBe(1);
    expect(listRevisionAcknowledgements(workspace, targetRevision, owner).get(target.id)).toMatchObject({
      provenance_kind: "carried",
      source_revision_id: sourceRevision,
      source_item_id: source.id,
      identity_digest: target.digest,
    });
    expect(listRevisionAcknowledgementCarries(workspace, targetRevision, owner)).toHaveLength(1);

    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: targetRevision, userId: owner, item: target, acknowledged: false });
    expect(carryRevisionAcknowledgements({
      workspaceId: workspace,
      lineageId: lineage,
      sourceRevisionId: sourceRevision,
      targetRevisionId: targetRevision,
      equivalences: new Map([[source.id, match]]),
      now: 30,
    })).toBe(0);
    expect(listRevisionAcknowledgements(workspace, targetRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgementCarries(workspace, targetRevision, owner)).toHaveLength(1);

    const explicit = setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: targetRevision, userId: owner, item: target, acknowledged: true, now: 40 });
    expect(explicit).toMatchObject({ provenance_kind: "explicit", source_revision_id: null, equivalence_digest: null });
    expect(listRevisionAcknowledgementCarries(workspace, targetRevision, owner)).toHaveLength(1);
  });

  test("a direct target reversal is a boundary for publication carry", () => {
    const sourceRevision = revision(1);
    const targetRevision = revision(2);
    const source = item("material");
    const target = item("material");
    const match = equivalence(source, target);
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: sourceRevision, userId: owner, item: source, acknowledged: true, now: 10 });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: targetRevision, userId: owner, item: target, acknowledged: true, now: 20 });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: targetRevision, userId: owner, item: target, acknowledged: false, now: 30 });

    expect(carryRevisionAcknowledgements({
      workspaceId: workspace,
      lineageId: lineage,
      sourceRevisionId: sourceRevision,
      targetRevisionId: targetRevision,
      equivalences: new Map([[source.id, match]]),
      now: 40,
    })).toBe(0);
    expect(listRevisionAcknowledgements(workspace, targetRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgementCarries(workspace, targetRevision, owner)).toHaveLength(0);
    expect(db.query("SELECT created_at FROM review_revision_acknowledgement_boundaries WHERE revision_id = ? AND user_id = ? AND item_id = ?").get(targetRevision, owner, target.id)).toEqual({ created_at: 20 });
  });

  test("a direct target reversal stops late carry at that hop and every successor", () => {
    const firstRevision = revision(1);
    const secondRevision = revision(2);
    const thirdRevision = revision(3);
    const first = item("file");
    const second = item("file");
    const third = item("file");
    const one = equivalence(first, second);
    const two = equivalence(second, third);
    // The target decision happens before these successor facts are backfilled. Once they
    // exist, an older acknowledgement must stop at that recorded target boundary.
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: secondRevision, userId: owner, item: second, acknowledged: true, now: 10 });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: secondRevision, userId: owner, item: second, acknowledged: false, now: 20 });
    db.run("INSERT INTO review_revision_item_equivalences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [secondRevision, second.id, workspace, lineage, firstRevision, first.id, one.type, one.sourceDigest, one.targetDigest, one.equivalenceDigest]);
    db.run("INSERT INTO review_revision_item_equivalences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [thirdRevision, third.id, workspace, lineage, secondRevision, second.id, two.type, two.sourceDigest, two.targetDigest, two.equivalenceDigest]);

    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: firstRevision, userId: owner, item: first, acknowledged: true, now: 30 });
    expect(listRevisionAcknowledgements(workspace, secondRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgements(workspace, thirdRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgementCarries(workspace, secondRevision, owner)).toHaveLength(0);
    expect(listRevisionAcknowledgementCarries(workspace, thirdRevision, owner)).toHaveLength(0);
  });

  test("a late acknowledgement follows stored successors once and stops at prior carry history", () => {
    const firstRevision = revision(1);
    const secondRevision = revision(2);
    const thirdRevision = revision(3);
    const first = item("file");
    const second = item("file");
    const third = item("file");
    const one = equivalence(first, second);
    const two = equivalence(second, third);
    db.run(
      "INSERT INTO review_revision_item_equivalences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [secondRevision, second.id, workspace, lineage, firstRevision, first.id, one.type, one.sourceDigest, one.targetDigest, one.equivalenceDigest],
    );
    db.run(
      "INSERT INTO review_revision_item_equivalences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [thirdRevision, third.id, workspace, lineage, secondRevision, second.id, two.type, two.sourceDigest, two.targetDigest, two.equivalenceDigest],
    );

    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: firstRevision, userId: owner, item: first, acknowledged: true, now: 50 });
    expect(listRevisionAcknowledgements(workspace, secondRevision, owner).get(second.id)?.provenance_kind).toBe("carried");
    expect(listRevisionAcknowledgements(workspace, thirdRevision, owner).get(third.id)?.provenance_kind).toBe("carried");
    expect(listRevisionAcknowledgementCarries(workspace, secondRevision, owner)).toHaveLength(1);
    expect(listRevisionAcknowledgementCarries(workspace, thirdRevision, owner)).toHaveLength(1);

    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: thirdRevision, userId: owner, item: third, acknowledged: false });
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: firstRevision, userId: owner, item: first, acknowledged: true, now: 60 });
    expect(listRevisionAcknowledgements(workspace, thirdRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgementCarries(workspace, thirdRevision, owner)).toHaveLength(1);
  });

  test("carry participates in its caller's transaction", () => {
    const sourceRevision = revision(1);
    const targetRevision = revision(2);
    const source = item("material");
    const target = item("material");
    setRevisionAcknowledgement({ workspaceId: workspace, lineageId: lineage, revisionId: sourceRevision, userId: owner, item: source, acknowledged: true });
    expect(() => db.transaction(() => {
      carryRevisionAcknowledgements({
        workspaceId: workspace,
        lineageId: lineage,
        sourceRevisionId: sourceRevision,
        targetRevisionId: targetRevision,
        equivalences: new Map([[source.id, equivalence(source, target)]]),
        now: 70,
      });
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(listRevisionAcknowledgements(workspace, targetRevision, owner).size).toBe(0);
    expect(listRevisionAcknowledgementCarries(workspace, targetRevision, owner)).toHaveLength(0);
  });
});
