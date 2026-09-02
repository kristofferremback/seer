# Stage capture data model

Slices 1 through 3 add immutable capture, version 1 publication, the member reader, and personal read state.
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
  tree, never a silent successful capture. Both keep the shipped capture-level side
  `snapshot`. Their stored reason sentences remain unchanged. A shared typed reason module
  writes the merge-base/source forms and maps existing old/new forms to the same distinct
  side identities. A unique truncation can carry across captures; duplicate evidence stays
  ambiguous. Capture-wide material such as the 300-file compare ceiling and an over-budget
  compare diff also records side `snapshot`. Pinned-diff fetch failure and over-budget
  responses retain separate identities while ignoring their variable message, byte count,
  and limit. Other capture-level prose does not authorize carry.
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
- `stage_change_reads` stores a member's explicit read marks by workspace, immutable
  stage-version id, user, and canonical change id. It never changes StageDoc.

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
100 MiB object decisions, the request budgets choose how many objects are fetched, in that
same order, through a pool of at most 16 calls. Retained objects are written through a
second pool of the same width; a write failure is reported by lowest retention index, so a
broken store fails the same capture the same way every time. Later eligible objects are
left out with a machine-stable budget reason. This makes retries and re-derivation stable
while bounding the number of external calls and writes one capture can start.

Two request ceilings bound one capture, and they bound different things. `STAGE_MAX_BLOB_REQUESTS`
(default 1,000) is how many unique Git blob requests it may make, which is how much source
it retains; 1,000 is 20% of GitHub's shared 5,000-request hourly installation budget.
`STAGE_MAX_GITHUB_REQUESTS` (default 1,024) is every known REST call the capture makes,
metadata included: the repository, both refs, compare, both trees, and the pinned compare
diff, seven in total. At the defaults the total leaves 24 calls of headroom over the blob
ceiling, so the blob ceiling is the one that normally binds; under a lower injected or
configured total the total binds on its own. Both overrides are validated at boot and a
non-integer value fails loudly naming the variable. The total must allow the seven required
metadata calls; the blob limit must be positive. An object left out
carries a reason prefixed `[budget:blob_requests]`, `[budget:github_requests]`,
`[budget:logical_bytes]`, or `[budget:github_blob_ceiling]`, so which ceiling bound is
machine-readable while the rest of the sentence still explains it to a person.

A GitHub primary or secondary rate-limit refusal aborts the capture rather than being
recorded against the object that happened to be in flight. Writing it per object would
turn one throttle into hundreds of `bytes_unavailable` rows that read exactly like source
GitHub does not have — a permanent-looking claim about a transient condition, in the one
record that is supposed to be trustworthy. Git tree objects, submodule commit ids, and
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
arrays. The retained patch and old/new blobs are read through `GET /api/stage-captures/:id/objects/:sha256` only when that exact capture names their SHA-256. The member page re-materializes persisted changes from those bytes and refuses a mismatch. Its retained-line API accepts only an opaque file id belonging to the exact immutable version; it never accepts a path or object digest as authority. Marking a change read writes only the current member's `stage_change_reads` row.

## A capture may also be promoted

The same completed capture can back a promoted review's source revision, independently of
any stage version it already backs. `review_revisions.capture_id UNIQUE` is that table's
own rule and says nothing about `stage_versions.capture_id`: neither consumes the other,
and the promoted slug may differ from the capture slug so an existing collision can be
resolved by naming a new one. See docs/overseer/data-model.md.

A capture is consumed by the unique `stage_versions.capture_id` rule. Publication assumes one SQLite writer process; uniqueness remains the final integrity guard, not a cross-process race protocol. Repeating an identical normalized narrative returns the existing version; a different narrative is a conflict. StageDoc V1 itself does not gain promoted-review sharing, conversation, acknowledgement, judgment, pull request, or GitHub projection state. Those live beside promoted review revisions as described in `docs/overseer/data-model.md`.

## Pinned-ref capture

Branch mode asks GitHub what two branch names point at right now. A promoted review's pull
request capture must not: the observation that queued it named exact commits, and a branch
that moved in between would silently produce a revision of different code under the same
pull request.

So the engine takes an internal resolved source — canonical repository identity, both refs
and all three SHAs — and spends **five** fixed metadata calls instead of seven: the
repository, the compare, both pinned trees, and the pinned diff. The two branch-ref
lookups are what it drops, and they are exactly the two that could have moved. The
repository is still confirmed by numeric id. A newer canonical name with that id is a
rename and remains the same source; the observed name resolving to a different id is a
substitution and is refused. The compare's merge base must also equal the observed one, or
the pin no longer holds and the capture is refused with the two SHAs in the message. A
request-budget refusal reports the count that actually applies in either mode.

No route accepts a resolved source. The Stage capture API is unchanged.

## Two captures compared

`src/overseer/revision-delta.ts` compares two retained inventories and nothing else: no
blob is fetched and GitHub is never called, so the answer is identical every time and
available when GitHub is not. It exists because a promoted review's pull request moves, and
a member who has read a hunk should not have to read it again because the branch was
rebased under it.

Paths map by declared rename and by identity only — no similarity score and no
display-name heuristic. One previous path may map to one current path; two current files
claiming one previous path, or a rename target colliding with a file of the same name,
produce no mapping and therefore no equivalence for the items involved.

A text item's key is `text`, the rename-resolved path, and the old, new and context
fingerprints. A non-text item's key is the resolved path, side, object kind, mode and Git
object id where one is known; where none is, one machine reason code such as
`[budget:blob_requests]` or one typed production reason identity participates. Production
classes cover both tree-path sides, both tree snapshots, insufficient retained text,
compare line loss with a separate alignment-ceiling class, both pinned-diff failure
classes, and the 300-file ceiling. Counts, limits, and fetch messages do not participate.
A file that carries neither a change nor material of its own keys on both side identities
and its status.
`unchanged` requires the full key to occur exactly once on each side; anything else is
ambiguous and produces no equivalence rather than an arbitrary pairing. What is left is
paired by placement in canonical inventory order to say `revised`, which decides a count
and never a handling carry. Every item of both captures is classified exactly once as
`unchanged`, `revised`, `new`, or `removed`.
