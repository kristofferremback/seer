# Stage capture data model

Slice 2 adds the builder packet, immutable stage identity, version 1 publication, and Project membership.
A capture is readable only through its creating workspace and contains enough pinned facts,
manifest rows, canonical change anchors, and retained bytes to derive its inventory without
calling GitHub again.

## Tables

- `stage_captures` stores the workspace, slug, canonical repository name and numeric id,
  source branch, requested base ref, resolved source and base tips, verified merge base,
  optional retained canonical compare patch, completed state, and creation time.
- `stage_capture_files` stores one opaque file id per changed path pair. It records both
  paths, object ids, modes, Git kinds, compare additions/deletions, and independent old/new
  byte availability. A missing reason is written beside the affected side.
- `stage_capture_changes` stores workspace-scoped opaque deterministic ids for canonical
  changes. Each row stores old and new line spans plus old, new, and context fingerprints
  and whether the representation came from GitHub's patch or immutable blob reconstruction.
  Renderer hunk boundaries are not persisted as identities.
- `stage_capture_incomplete` stores workspace-scoped material records. `snapshot_incomplete`
  and `bytes_unavailable` make source `complete` false. `lines_unavailable`,
  `patch_unavailable`, and `metadata_incomplete` describe review limitations without saying
  the pinned source is incomplete. A truncated tree produces one snapshot item per affected
  tree, never a silent successful capture.
- `stage_blobs` maps `(workspace_id, sha256)` to the byte count of an object stored at
  `stage-blobs/<workspace>/<sha256>`. The hash is computed by Seer, not accepted from the
  caller. The canonical compare patch uses the same store and its digest is recorded on
  `stage_captures`.
- `stage_capture_idempotency` maps `(workspace_id, Idempotency-Key)` to the request digest
  and capture id. It is inserted in the same transaction as the capture rows.
- `stage_capture_builders` stores one normalized authoritative packet per capture, with the
  declared agent labels and derived user and key ids. Legacy captures may have no row.
- `stages` stores one workspace-scoped identity and latest-version pointer. Its lineage is
  the first capture's base ref and verified merge-base SHA.
- `stage_versions` stores immutable resolved StageDoc JSON, its digest, capture consumption,
  and witness actor ids. Version 1 is the only version written in this slice.
- `project_stages` stores workspace-scoped Project attachments created with publication.
  A Project state query resolves the stage and latest version rather than trusting this join.

Every child inventory and publication table includes `workspace_id`, and reads filter on
both workspace and its parent id. SQLite foreign keys are not the contract; writes and
joins validate workspace ownership explicitly.

Workspace columns are repeated on child rows so every lookup has an explicit authorization
scope. IDs are opaque `stg_` capture, `sta_` stage, `stf_`, `chg_`, `sti_`, and `stv_` values. A canonical change id is
`chg_` plus the SHA-256 of its normalized path, spans, lines, and context. It is deterministic
across captures, but carries no path-index convention from a renderer.

## Retention order

The route accepts `Idempotency-Key` as a required header. The request body contains `slug`,
`repo`, `branch`, the authoritative normalized `builder` packet, and optional `baseRef`. The
request digest covers those normalized fields,
not the key itself. `baseRef` is resolved to the repository default branch before the capture
is written.

Seer sorts changed file candidates by new path, then old path, using Unicode code-point
order independent of process locale. Within each candidate it considers the old Git blob
before the new Git blob. Duplicate Git object ids are fetched,
counted, and retained once, at the first occurrence in that order. The default logical-byte
limit is 50 MiB and tests may inject a smaller value. An object that would pass the limit is
left out with a budget reason; later objects cannot displace it. After byte and GitHub's
100 MiB object decisions, at most 64 unique Git blob requests are selected in that same
order and fetched through a pool of at most 16 calls. Later eligible objects are left out
with an object-count reason. This makes retries and re-derivation stable while keeping the
capture inside the request and idle-time budget. Git tree objects, submodule commit ids, and
modes remain metadata even when they have no retainable file bytes. Binary and symlink bytes
may be retained, while their unavailable line representation carries a concrete reason.

The compare endpoint's file list is advisory. Seer walks the verified merge-base tree and
source tree independently, and unions their non-tree entries. A compare list at GitHub's
300-file cap therefore cannot hide a path, but Seer records `metadata_incomplete` because
rename and patch facts may have been omitted. If GitHub truncates a tree, Seer writes one
explicit snapshot item and treats absent paths on that side as unknown. A tree request that
fails entirely aborts the capture. The capture remains a truthful, readable record rather
than claiming complete source coverage.

The raw unified compare diff is requested with the pinned merge-base and source SHAs. Only
that successful raw response can populate `patch_sha256`; if retrieval fails or the response
exceeds the logical-byte budget, Seer records `patch_unavailable` and uses retained immutable
file sides for canonical changes. File blobs follow in path, old-side, new-side order, using
declared tree sizes to skip objects that cannot fit before downloading them. A skipped object
gets a material record. The GitHub Git blob API's 100 MiB ceiling is also checked before a
declared-size request.

Object writes happen before the one database transaction that inserts the completed capture,
its child rows, and its idempotency row. A failed write or transaction cannot expose a
capture. A failed transaction can leave unreferenced content-addressed objects; this slice
does not sweep or delete them.

Publication validates the witness document before the transaction. Project slugs are normalized as a sorted unique list, so input order and repeated names do not change an otherwise identical replay. The transaction checks Project slugs again, creates the stage and version, and inserts Project joins. The version's
resolved document carries source facts and opaque capture ids, not patches, bytes, or line
arrays. The retained patch and old/new blobs are read through `GET /api/stage-captures/:id/objects/:sha256` only when that exact capture names their SHA-256. A capture is consumed by the unique `stage_versions.capture_id` rule. Publication assumes one SQLite writer process; uniqueness remains the final integrity guard, not a cross-process race protocol. Repeating an identical normalized narrative returns the existing version; a different narrative is a conflict. Later versions, rendered stage pages, shares, comments, read state, approval, deltas, and pull request attachments are deferred.
