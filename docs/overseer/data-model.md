# Overseer data model

Overseer is a tool for a human to run a review. A hosted skill, running on the user's own inference, reads the pull requests and prepares the briefing: what changed, what matters, where to look closely. Overseer stores that briefing and renders it. Neither of them is the reviewer. The reader is, and every entity below exists to put the reader in a position to judge.

The name splits the roles. Overseer is the tool through which the reader oversees, and it sits over Seer, whose deployment it shares. The sub-agent that authors a review is the witness: it testifies to what it observed, and the reader judges. This project was called Witness until the better name arrived; the old name survives as the agent's, where it was always most accurate.

This model is derived from the prototype, not from theory. Every field exists because the rendered page needed it, and several constraints exist because the prototype got them wrong first.

## The dividing line

**Overseer owns facts. The skill owns judgment.**

Overseer derives from the GitHub API and the skill may not author:

- pull request titles, head and base SHAs, base refs
- the file list, the hunks, every line number, every `@@` range, the `+n -n` stats
- whether a ref points inside or outside the reviewed change
- whether the review is behind the branch

The skill authors and Overseer may not invent:

- author intent: what the pull request descriptions say the problem and reason are
- the summary: what the witness verifies, its implication and the high-level solution
- statements: the behavior, contract or architectural consequences to judge
- review focus: decisions the human must make and things easy to miss
- code design: policy/state ownership, responsibility areas and conceptual path coverage
- the walkthrough: how the implementation works, decomposed in reading order
- which refs to attach to which claim

This split is the single most load-bearing decision in the model. In the prototype the agent authored line numbers by hand and drifted three separate times: a ref labelled `L38-49` rendered 38 to 47, two hunks in one file overlapped, and a hunk claimed a base range that its own PR had already rewritten. None of those are possible once the numbers come from the diff instead of from a language model.

## Entities

### Review

```
review
  id              string, opaque
  slug            string, url-safe
  version         derived: int, incremented on each publish to the same slug
  title           authored, <= 80 chars
  kind            derived: single | stack | set
  author_intent   authored paraphrase of PR descriptions, <= 2 paragraphs, <= 600 chars
  summary         authored witness account, <= 2 paragraphs, <= 600 chars, constrained markdown
  prs[]           1..n
  statements[]    3..6
  notes[]         0..6
  code_design     authored: placement, modules, conceptual coverage
  groups[]        2..8
  annotations[]   0..n, written after publication
  created_at, updated_at
  freshness       derived per pr: current | behind
```

`kind` is derived, not declared: one pull request is `single`, several where each is the base of the next is `stack`, anything else is `set`. The renderer draws the same chain either way; the difference is only whether the chain has edges or is a list.

`author_intent` and `summary` are the forest with provenance kept visible. `author_intent` paraphrases only the problem and reason stated in the pull request descriptions. `summary` is the witness's independent account of what the code accomplishes, its important implication and high-level mechanism. The renderer titles them by the reader's question — the problem, the solution — and keeps the provenance as each label's quiet suffix, so the arc reads in order and whose words are whose stays visible. A mismatch between them is a finding, not something the witness silently resolves by replacing the author's account. For a stack both describe the completed feature, fix or implementation, not the pull requests in sequence. File names, test counts and minor edge cases stay out. The first rendering of this very document buried its own purpose and read, for a moment, as if the tool were the reviewer. That is the failure this split exists to prevent, and the skill gets graded on it.

### PullRequest

```
pr
  repo            "owner/name"          authored (the pointer)
  number          int                   authored (the pointer)
  title           derived
  head_sha        derived
  base_sha        derived
  base_ref        derived
  parent          number | null         derived from base_ref when it names another pr in the review, else authored
  author          derived: the GitHub login
  co_authors[]    derived: Co-Authored-By trailers across the pr's commits, deduplicated
  body            derived: the pull request description, markdown as GitHub holds it
  gist            authored, <= 100 chars, one line
  detail          authored, <= 2 sentences, <= 400 chars
  detail_ref      ref id
  kinds[]         derived: the distinct kinds of the statements attributed to this pr
```

`kinds[]` is derived on purpose. The marks on a pull request card are then provably tied to real claims, instead of being a second thing the skill can get out of step with the first. The card goes further and draws the realizing statements themselves, each behind its kind mark, each a jump to the claim — because the most important thing a card can point at is what the pull request is on the page for, not a window into its code. `detail_ref` remains the mandatory pointer behind the card's detail, but the card does not wear it as a code panel: one quoted stretch cannot back a whole pull request, and rendering it as evidence gave an arbitrary snippet the most prominent code surface in the stack view.

Every pull request in the review is realized by at least one statement. A pull request that warrants no statement warrants a question, namely why it is in the review at all. Its `gist` names the part of the whole change that this pull request contributes. Its `detail` gives the reason for that slice and its high-level mechanism, rather than repeating the GitHub title or listing files. Both are mandatory; this closes the other gap, a card the overview never mentions.

`author` and `co_authors[]` are how attribution survives: agent-written changes already announce themselves through Co-Authored-By trailers, so who wrote what, human or agent, is a derivable fact and Overseer derives it. `body` is the description the author actually published, rendered behind a disclosure on the card so it is available without being re-summarized. Review comments and threads are also derived and handed to the skill as context, but rendering them is deferred, see the end of this document.

### Statement

The atom of the overview, and the thing the whole page hangs on.

```
statement
  id
  kind        add | change | remove
  text        authored, <= 120 chars, one line, no markup
  prs[]       which pull requests realize it
  refs[]      pointers backing the claim
  body        authored, <= 1200 chars, constrained markdown
  evidence[]  ordered: ref | payload | figure | example | attachment | bundle
```

`body` is prose, and it is where the reader opts in. It explains why the change exists, its important implication, and the high-level mechanism. Low-level control flow belongs in the walkthrough. These are areas to cover, never labels to print. The prototype tried printing them as labels and it read as a form.

Constraint: every statement carries at least one ref, in `refs[]` or as a `ref` entry in `evidence[]`. A claim with nothing behind it does not belong on the page, and either place is a pointer the reader can follow, so the rule reads both the way the note rules always have.

The prototype also had a fourth kind, `keep`, for stating what a change deliberately does not touch. It is cut. It was the only kind that could carry no evidence, which made it the only place a claim could be unfalsifiable, and it is not needed to ship a first review. If the blast radius is worth stating, it belongs in the summary or in the body of the statement whose scope it bounds. This can come back later on evidence that reviews are worse without it, and the renderer should treat the kind list as closed until then.

### Note

Only things a reviewer would otherwise miss or must personally judge. Contract changes and data flow are not notes, they are statements: they are the change itself. The prototype had them as notes and the ordering made risks look more important than the contract, which was backwards. A `decision` is drawn before risks and observations because the reader's judgment is the purpose of the page.

```
note
  id
  kind      decision | risk | note
  text      authored, <= 140 chars
  body      authored, <= 1600 chars, constrained markdown
  checks[]  0..5 ordered strings, each <= 120 chars
  refs[]
  evidence[]
```

Render order is fixed: decisions first, then risks, then notes, authored order within each. The renderer decides this, not the payload.

Constraint: a note of kind `risk` must carry either a non-empty `checks[]` or at least one ref into a changed hunk. A risk has to point at something falsifiable. This exists because a reviewer agent in the prototype filed "tokens carry 75 random bits, lookup is one primary-key hit" as a risk, when it is an assurance. The constraint would not have caught that one, but it raises the cost of filing a vague risk, and `checks[]` is the field that makes a real risk actionable. A `decision` carries a check or ref showing what the reader should inspect; a free-floating philosophical question is not review focus.

### CodeDesign

The account of where the change lives in the code and whether every conceptual path reaches it. It is authored judgment, not a second file list.

```
code_design
  placement       authored, <= 800 chars; central policy/state owner and why
  modules[]       0..6 responsibility areas
    id
    title         <= 60 chars
    paths[]       concrete paths, each <= 180 chars
    body          <= 800 chars
    refs[]        at least one
  coverage[]      0..8 conceptual paths
    id
    title         <= 80 chars
    body          <= 600 chars
    refs[]        at least one
```

`modules[]` distinguishes the policy or state owner from entry adapters, consumers and presentation. `coverage[]` is the sprawl check: fresh reads, cached reads, asynchronous work, repair and other distinct paths the feature must cover. Every entry is ref-backed. The renderer states what the sprawl check means by drawing it — the coverage titles as nodes converging on the change — derived from the titles alone so the drawing can never claim an edge the rows do not carry; a single path draws nothing, because one arrow into a box is decoration rather than a check. The object and its lists are always present in a new publish, but may be empty for a change with no useful code-design judgment; avoiding dead prose wins over filling the section.

### Group

A walkthrough group is a set of hunks that changed for one reason. Hunks, not files: `src/server.ts` legitimately appears under both "anonymous access" and "api surface" because it carries two unrelated changes, and a file-keyed model cannot express that without lying.

```
group
  id
  title         authored, <= 60 chars
  significance  float, ascending, 1.0 = most significant
  paragraph     authored, <= 600 chars, constrained markdown
  hunks[]       hunk ids
  file_notes[]  { path, text <= 120 chars }
  kind          derived: the dominant kind across its hunks
```

Ordering is by `significance` ascending, ties broken by `id` so the order is always deterministic. It is a float rather than a rank so that moving one group means writing one value: to put something between 2.0 and 3.0, write 2.5. With integer ranks every group below the insertion point has to be rewritten, which is a whole-document edit to express a one-line judgment.

The known cost of float ordering is precision decay after many insertions in the same gap. It does not bite here, because a review has at most eight groups and is published in one shot, but the write path should reindex to evenly spaced values when the gap between two neighbours falls below a threshold, so a long-lived review that gets reordered repeatedly cannot drift into equal values.

There are no rules for what counts as significant beyond a convention that behavior outranks mechanism outranks tests outranks chore, and that is deliberate: the judgment is the product.

The walkthrough is a partition of the diff, not a selection from it. Every hunk in every pull request belongs to exactly one group, and a hunk left unclaimed is a 422 naming the path and range. Nothing can be left out of the account by being left out of the walkthrough: mechanical churn does not escape, it gets grouped as the chore it is and ranked last, which costs the skill one line and buys the reader a guarantee, that absence on the page means absence in the diff.

The group paragraph is technical documentation of that part of the implementation. It explains the control flow, data flow, state transition or responsibility split that makes the hunks one mechanism. Exact functions, types, routes and values belong here when they clarify the explanation. A file note names that file's specific role. Across groups, the walkthrough identifies the module that owns the central policy or state, the entry points that adapt into it, and the read surfaces that consume it. Cross-cutting changes account for every distinct path that must participate, so a reader can judge both placement and missing sprawl. A file or symbol inventory is not an explanation; the rows under the paragraph already provide the inventory.

### Hunk

Fully derived. The skill never writes one.

```
hunk
  id
  repo, pr_number, path, sha
  old_start, old_lines, new_start, new_lines
  lines[]  { kind: ctx | add | del, old_no, new_no, content, word_ranges[] }
```

### Ref

A pointer, resolved and cached by Overseer. The skill writes the pointer, never the code.

```
ref
  id
  repo, sha, path
  start_line, end_line
  highlight[]   line numbers within the range
  origin        derived: in_stack | outside
  snippet       derived, cached
```

`origin` is `in_stack` when the review carries that SHA and changes that path, in that repo. The SHAs it carries are every pull request's base, head and commits; the paths it changes are every changed file, under both names when it is a rename. The two sets are unioned across the review rather than paired per pull request, because a stack's child contains its parent's work and a witness may pin a whole review's refs at one commit. The prototype's most useful single ref was one pointing at `src/auth.ts`, untouched by the stack, to show what the new gate reuses. Getting that label wrong would be a lie about the shape of the change, so the skill does not get to write it.

The remaining way to be wrong is to quote a changed file at a SHA the review does not carry: the page would tell the reader that a file this very change edits is outside it. That is refused at publish, with the head SHA to use, rather than rendered.

Refs are SHA-pinned, so a force push cannot rot them.

A ref whose lines a hunk of the review wrote renders as that diff — the deleted lines laid back in, the added lines washed — and links to the pull request's files view, because the claim it backs is about the change and the file standing where the change was asks the reader to find it again. Every other ref renders its snippet and links out to GitHub at the pinned SHA. Either way the snippet is the bounded view and the link is the unbounded one; Overseer never grows a code browser. The point of the page is that the reader should not have to read code to review, and the point of the evidence is that they always can: every claim stays one tap from the lines it stands on, which is what keeps the skill honest even on the days nobody taps.

### Figure

The one drawing on the page. Not free-form: a constrained graph that Overseer renders in the house style.

```
figure
  kind    flow
  nodes[] { id, label <= 40 chars, state: normal | muted }
  edges[] { from, to, label <= 24 chars }
```

Mermaid was the obvious alternative and is rejected. Arbitrary diagram source lets the model produce output that fights the design system, and this project has spent most of its effort removing exactly that kind of drift.

### Payload

A before and after pair, for contract changes.

```
payload
  lang        json | text
  before      <= 800 chars
  after       <= 800 chars
  highlight[] keys or line numbers changed
```

### Example

Authored illustration: a request as a client would send it, a config as it would be written, a call as it would be made. An example puts a change in context the way no diff can, and it is the one evidence kind that is invented rather than quoted, so the renderer must make that unmistakable: an example never carries line numbers, never names a file, and always carries its caption.

```
example
  lang      string; syntax color when the renderer knows the language, mono otherwise
  text      <= 800 chars
  caption   authored, <= 120 chars, required
```

### Attachment

A file the skill uploads with the review: a screenshot, a rendered chart, a before and after capture. First class, not a link out. Seer already stores files as the truth on disk, and attachments ride the same discipline.

```
attachment
  id
  media_type   image/* to start
  bytes        derived
  alt          authored, <= 140 chars, required
  caption      authored, <= 120 chars
```

Attachments are uploaded as part of publication and referenced from `evidence[]` by id; an attachment nothing references is rejected. Formats start at images. The record already carries `media_type`, so widening later is a renderer change, not a model change.

### Bundle

A pointer to a Seer bundle in the same workspace: a prototype, a contact sheet, a rendered artifact of the change under review. Reviews and bundles live in one deployment, so this is a resolved in-house link, not a URL.

```
bundle
  slug
  version   int | null, null = latest
  caption   authored, <= 120 chars, required
```

### Annotation

Deferred, but the shape is settled: comments and questions are one primitive. A question is an annotation awaiting an answer.

```
annotation
  id
  target      { type: statement | note | group | file | hunk | summary, id }
  quote       string | null, for a text selection
  body        authored by the human
  status      open | answered
  answer      { body, refs[] } | null
  version     the review version it was filed against
  created_at
```

## Authored text is constrained markdown

`author_intent`, `summary`, design placement and bodies, statement and note bodies, and group paragraphs accept a fixed subset: emphasis, inline code, links, lists, and fenced code. Headings, tables, raw HTML, and inline images are rejected with a 422 naming the construct, not silently stripped. Structure belongs to the schema, and images are attachments, which are first class evidence rather than inline decoration. One-line fields (`text`, `gist`, `title`, captions, checks) stay plain: no markup at all except inline code.

## Budgets are the schema, not a guideline

Every cap above is enforced on write and returns a 422 naming the field and the overage. A prompt asking for brevity is advice; a schema that refuses a seventh statement is a design.

The counts for a single pull request: 3 to 6 statements, at most 6 review-focus notes, at most 6 design modules, at most 8 coverage paths, 2 to 8 groups, and hard caps on every one-line field. The prototype settled at 5 statements, 5 notes and 6 groups for a three-pull-request stack, comfortably inside even this budget, which is the right density for a phone screen.

Breadth scales with decomposition, not with diff size. Each additional pull request in the review adds 2 to the statement ceiling and 4 to the group ceiling, to absolute ceilings of 12 and 16. Notes stay at 6 regardless: things a reviewer would miss do not multiply with size. Line count is deliberately not the scaler, because 8,000 lines of codegen deserve a smaller review than 800 lines of auth rewrite. The pull request is the unit the author controls, and it is an honest proxy for how many independent judgments the change contains, which is what a review actually scales with. Depth needs no scaling because it is unbounded already: a group can hold five hundred hunks and a statement can stack all the evidence it needs. The top of the page staying one screen is not the review being small, it is the review being sorted.

A monolithic pull request that exhausts its budget is not an error, and the write path does not refuse it. The publish response carries a warning naming the pressure: this change may have warranted further decomposition. The compression is the system telling the truth about reviewability, and the summary should say it out loud.

## What Overseer validates on write

- every ref resolves at its SHA, otherwise 422 with the path and range
- every hunk id exists in that pull request's diff
- every hunk in every pull request's diff belongs to exactly one group
- every pull request is realized by at least one statement
- every `prs[]` entry is in the review
- caps
- every statement has at least one ref
- a `risk` note has checks or a ref into a changed hunk
- a `decision` has a check or ref showing what to judge
- every design module and coverage path has a ref; module paths are concrete
- every pull request and every ref in one review names the same repo, until multi-repo is actually built
- markdown outside the allowed subset is a 422 naming the construct
- every attachment is referenced by some `evidence[]`, carries a required `alt`, and is `image/*`
- every bundle evidence resolves to a bundle in the same workspace
- on republish, an id reused from the prior version must name an entity of the same type

## Endpoints

```
POST  /api/reviews                  publish a review document, returns the resolved review
                                    plus any warnings, or 422
GET   /api/reviews/:slug            the resolved document, for the renderer
POST  /api/reviews/:slug/refresh    re-derive against GitHub, update freshness
GET   /r/:slug                      the rendered page, current version
GET   /r/:slug/v/:n                 a prior version, marked as such
POST  /api/reviews/:slug/annotations
```

A review is authored in one shot. The skill reads the pull requests, forms its view, and publishes a whole document with its attachments; it does not build one up over many calls. Annotations are the only thing written afterward.

One shot does not mean one pass. Publishing to an existing slug creates the next version, exactly as uploading a bundle does in Seer, and prior versions stay readable at `/r/:slug/v/:n`. This is how reviewing happens in passes: the branch moves, the skill publishes again, and the reader comes back to the same link. On a second pass the skill is given the prior version and the open annotations, which is published record, not private context, and it keeps the ids of statements, notes, design modules, coverage paths and groups whose claims survive. The renderer derives the delta between any two versions from those ids and the text, so a returning reader sees what is new, what was revised, and what was answered, as marks on the rows rather than as a changelog to read. Derived, never authored: the skill does not get to say what changed about its own account.

Annotations belong to the review, not to a version, and each records the version it was filed against, so a question asked on pass one is still open on pass three and its quote still resolves against the version that produced it.

## The delta is first class

The delta between versions is computed, never written, and no language model is in the loop. Overseer derives it on three levels: entities by stable id first, then by a conservative rough match of headings, authored bodies and code names when a witness renamed an id; authored text by word-level diff wherever an entity survives, so a revised 600-word body shows its dozen changed words instead of asking to be reread; code by the head SHAs, so the timeline states whether the branch itself moved between passes. Weak entity matches remain new and removed rather than asserting a false identity. Removed entities stay visible in the delta view rather than vanishing, because an absence you cannot see is not reviewable.

The renderer gives every review a revision menu: the versions as a timeline, each entry carrying its derived counts and whether code moved. Delta marks on the page are measured against a base version the reader can pick, and the default is the version this reader last opened, falling back to the previous one. The goal is mechanical: a returning reader should never have to reread the whole account to discover what they would have needed to read.

The same machinery covers derived text. A pull request description that changed between passes is word-diffed like any authored body, which is how "the agent improved the description" stops meaning "read all 600 words again."

How the delta renders is part of the design, not a renderer whim. Revised prose stays clean under a short yellow italic `edited` control. Opening it swaps a word-level redline into the same place: prior words precede their replacements and current words carry the insertion mark. Every changed field inside an entity shares one explicit `edited` control in that entity's expanded body; opening the row itself never reveals a diff. Density never switches the page to a second diff grammar. New and removed rows use their coloured inline state text as the indication, while their titles and content remain neutral even when opened. Removed rows remain near the next surviving section from their base ordering rather than collecting at the end. Author intent, the witness summary and code design are not exempt: authored text diffs wherever it appears. The page states which base version its marks are measured against, and row-level marks exist only as the sum of their spans, so a mark can never claim a change the text does not show.

Viewing is the refresh trigger. Opening `/r/:slug` compares the stored head SHAs against GitHub, rate limited to once a minute per review, and kicks an asynchronous re-derivation when a head has moved. The page renders the stored document immediately and updates its freshness marks when the refresh lands, over the same live channel Seer already uses for bundles. `POST /api/reviews/:slug/refresh` stays for explicit calls, but nothing depends on remembering to make one: a review someone is looking at cannot silently claim `current` while the branch moves underneath it, because looking at it is what checks.

## The promoted review: evidence before an account

A review published from a pull request is authored in one shot, and everything above is
about that. A **promoted** review is the other order: a completed stage capture becomes a
readable review the moment it exists, and a witness publishes an account over it later, or
fails, or is retried. The reason is a product one. A reader who has just pushed a branch
should be able to open it, page through the code, and mark what they have handled, without
waiting for a model to finish; and the account, when it arrives, must not disturb any of
that.

Three rows carry it, all workspace-scoped and slugged exactly as a legacy review is.

- `review_lineages` is the identity: repository, branch, the original base ref and merge
  base the lineage started from, its title, and pointers to the latest revision and the
  latest account version. A slug is unique across `reviews` and `review_lineages`
  together. SQLite cannot spell that, so both write paths enforce it — the promoted
  publish refuses a slug a legacy review owns, and a FIRST legacy publish refuses one a
  lineage owns. An existing legacy review is untouched by the rule and keeps appending
  versions: it owned its slug first, and `/r/<slug>` has to keep meaning what it meant.
- `review_revisions` is the evidence: one immutable V1 document per source revision, over
  one completed capture. It stores identity, exact source facts, nullable builder facts,
  and Project slugs — and no witness object of any kind, because it is published before
  any witness has finished and it must never change afterwards. The builder is nullable
  rather than blank: a pull request nobody initiated through Seer has no intent to state,
  and inventing an empty one would make "the builder said nothing" indistinguishable from
  "there was no builder". `capture_id UNIQUE` here is this table's own rule and says
  nothing about `stage_versions.capture_id`; one capture may back both, and neither
  consumes the other.
- `review_accounts` is what a witness published over a revision: the summary and agent,
  the complete semantic partition of that capture, anchored focus items, and cited
  evidence. Its `version` is lineage-wide rather than per revision, so `/v/<n>` names one
  publication of the whole promoted review the way a legacy version does, while
  `revision_id` records which code stream it accounts for.

A **focus item** is one bounded thing worth stopping on: a decision that was made or a
risk that was taken, with a stable slug id, a constrained body, and one or more anchors
into the capture. Anchors own nothing and may overlap — two items may point at the same
change, and pointing at it does not take it out of the partition. What they may not do is
point at material the capture does not hold, because a decision anchored to nothing is an
opinion wearing a citation. **Evidence references** are exact existing same-workspace
attachments or bundle versions: an account points, it never mints. Attachment references
resolve and store their owning review slug, media type, byte count, alt text, and caption so
the immutable account can render the citation without rediscovering it from another row.

`review_witness_requests` is workflow state, and it is deliberately in neither document.
"Pending", "failed" and "retrying" are true only until they are not, so storing one in an
immutable row would make that row lie the moment the workflow moved. It is read beside the
document instead. Retry turns `failed` back to `pending` and counts one retry; `retrying`
is derived from pending plus a nonzero count, so one row cannot claim to be waiting for a
first answer and a second at once. A failed request must retry before it can publish.
Publication moves it to `published` in the same transaction as the account, and stale
failure or retry writers re-read that state inside their transaction before changing it. One initial request per revision in this slice, held by a
unique index rather than by a convention.

`review_revision_change_reads` keys on the REVISION, not on an account. The code a member
marks read belongs to the source revision, so evidence and every account published over it
share one exact handling state instead of resetting when a witness arrives.

### What each address means

- `/<workspace>/r/<slug>/rev/<n>` always reads the evidence revision, and keeps reading it
  after an account is published. A pinned evidence URL does not redirect and does not gain
  an account; it is the code stream, and that is the whole point of pinning it.
- `/<workspace>/r/<slug>/v/<n>` reads one immutable account publication.
- `/<workspace>/r/<slug>` resolves the latest account of the latest revision, and the
  evidence document when no account exists yet.
- Bare `/r/<slug>` and `/r/<slug>/v/<n>` stay legacy-only, and workspace-scoped dispatch
  checks a legacy review first. No promoted review can change what an old link means.

Evidence rendering uses retained objects only and never calls GitHub. It offers the same
overview-to-focus flow as a stage walkthrough, through neutral, deterministic file-seam
pages of at most 100 review items. Changes, incomplete material, and leafless files all
count against that response bound. A seam is navigation, not an authored group: it
names paths and counts lines, shows builder attribution where there is one, states the
witness workflow, and says nothing about category, importance, complexity, or what any
change means. A revision published before its witness finished has no standing to say any
of that, and a plausible guess would be indistinguishable from a witness's judgment.

Project membership is its own join, `project_review_lineages`, and Project state carries a
`reviewLineages` list beside the existing `reviews` one rather than widening it: the two
resolve through different readers. The human Project page composes both under one Reviews
heading, which is a presentation decision and stays one. Creation owns the promoted joins
in this slice; separate attach and detach routes are deferred until promoted lineage
management needs them.

Deferred here on purpose: repeated source revisions, stacks, sharing, local discussion,
judgments, and any GitHub write.

### One pull request, one review lineage

A lineage owns at most one current pull request, and a live pull request is owned by at
most one lineage in a workspace. Both halves are constraints rather than conventions:
`review_lineage_prs` has the lineage as its primary key, and a partial unique index on
`(workspace, repo id, pr number) WHERE detached_at IS NULL` holds the other side. A later
explicit detach releases the pull request by stamping `detached_at` while the historical
row survives; task 5 adds no detach action.

That one row is the whole relationship, and everything joins it: route resolution, webhook
filtering, reconciliation, and the sweep that retires an orphaned status row. A second
table naming the same fact would be a second place for the join to drift, and the sweep in
particular has to ask all three naming tables — reviews, tasks, lineages — in one
paragraph of code or it deletes something somebody still renders. Renames match by
repository id; a stored name is a historical display fact and is never rewritten under the
document that froze it. Current lineage views and native GitHub links use the newest stored
observation's canonical name for that same id, so a freed name can never send a reader to a
different repository's pull request.

Seer reviews **same-repository** pull requests. A fork head, a missing head repository, a
repository mismatch, a branch mismatch, and a base-ref mismatch are each an explicit 422
with its own sentence. None of them falls back to another credential, another base, or
another repository: a fork is not "a branch we could not find", and answering it as one
sends somebody hunting for a typo.

`review_pr_observations` is one immutable reading of a pull request. Its digest covers the
normalized GitHub facts **and the exact read actor**, but not Seer's own `observed_at`.
Re-reading unchanged facts through the same actor therefore reuses the row rather than
accumulating one an hour; reading them through a different actor records a separately
attributed observation, because who was allowed to see it is part of what was seen. A
webhook observation has a null `merge_base_sha`, deliberately: a delivery carries no merge
base, and a fabricated third leg would let an unasked-for reading be mistaken for a
capturable source.

`review_revision_sources` is the source-tuple arbiter, and the reason task 5 needs no V2
revision document. A revision points at the immutable observation it was captured from, so
pull request identity has one stored home, and the unique
`(lineage, base tip, head, merge base)` is what stops a second capture result publishing a
duplicate revision. The API exposes the associated observation **beside** the V1 document;
the document's digest continues to cover only its own immutable bytes. A V2 document would
duplicate the observation's facts and soft-404 every old reader during a mixed-image
deploy, for nothing.

A **branch-first exact attachment** — a pull request whose base tip, head and merge base
are exactly the latest revision's — records one immutable attachment and source
association and reuses that revision. No recapture, no duplicate revision, no second
witness request, no reading state reset, no account rewrite. The attachment is lineage
history; source revision numbering changes only when source evidence changes.

### Reading as somebody, and staying that somebody

Every observation and every capture job stores its read actor: an installation this
workspace holds, one credential of one member, or `anonymous`. The initial resolver may
choose an installation, otherwise a credential of the asking member, otherwise anonymity —
but once stored, the actor is reopened exactly and never rerouted. A worker that fell back
would mean the stored attribution and the credential actually spent had come apart.

A stored personal credential is not the workspace's to spend. Refreshing and retrying a
job that reads through a member's connection require that member. An anonymous read uses
no workspace credential and gets no webhook-owned refresh promise: there is no
installation, so there are no deliveries.

`review_capture_jobs` is workflow state, in neither document. A pending or failed job is
visible and retryable and is **not** a source revision — a lineage whose only job failed
has no revision at all rather than an empty one. `actor_key` is the queue lane: one actor
runs one capture at a time, and the renewable lease is what makes that true across
processes as well as inside one, so a killed worker's claim can be recovered without two
healthy workers spending one credential on one capture. A worker whose heartbeat says it no
longer holds the job stops rather than publishing over the process that took it over.

Recovery runs at startup and then on a timer one lease period long. Startup alone was not
enough: a lane a process left because another container held the lease, or because a caller
queued work while the lane was busy, has nothing else that would ever look at it, so its
pending job would wait for the next ingest for that same actor or for a restart. A failed
job does not end its lane either — the jobs behind it were queued by their own callers,
each already holding a 202.

An ingestion or attachment that meets an existing FAILED job answers 409 with the failure
text in `error` and the job in `job`, `retryUrl` included, so the recovery is in the answer
rather than something to go and look up. Every other conflict on those routes carries
`error` alone, and the served document declares both shapes.

Two replay identities, deliberately separate. The client's `Idempotency-Key` plus a request
hash over the operation, the target slug and the normalized body replays the USER
OPERATION; the source tuple prevents a second capture result publishing another revision.
Merging them would be wrong in both directions: two different requests may legitimately
observe the same bytes, and one request replayed must return one answer.

`review_witness_claims` is keyed by `(request, retry count)`, because the retry count is
exactly what makes a second attempt a different piece of work. A same-key claim renews its
lease; an expired one may be recovered by anyone without touching the count; a healthy
claim held by another key makes a claim, an account publication, or a failure a 409.
Publication and failure claim and consume the attempt themselves when nothing stands in
the way, which is what preserves the single-agent path exactly as it shipped.

### The page before the first capture

A lineage created from a pull request is real from the moment it is created — it owns its
slug and its pull request — but it has no source revision until its capture completes. Its
latest URL therefore renders a retained-only shell rather than a reader document: there is
no capture, so constructing one would mean inventing an empty partition, a source rail
with no history, reading state over nothing, and a witness request that does not exist.
The shell says the four true things — what this review is, which pull request it reviews,
what source it is pinned to, and where the capture has got to — under the same app bar and
page tokens the completed page uses. `Capture pending`, `Capturing` and `Capture failed`
replace the standing line; there is no `/rev/` URL to link to yet, and the actor is named
as the GitHub App installation, the owning member's GitHub connection, or public GitHub,
never by a credential id.

On a completed revision the pull request reads as a short native link — `#41` — beside the
repository and branch, with its status and age in restrained inline text. The observation
shown is **the revision's own**, never the relation's latest, so a pinned page can go on
saying `open, observed …` after the pull request has merged. The newer-source notice beside
it is a separate, dynamic line; see below.

A shell joins its Projects at creation, so a Project holds it before its capture finishes.
`reviewLineages` therefore carries a nullable `latestRevision` and `revisionUrl` and a
`captureState` of `pending`, `running` or `failed`, null once there is a revision to read.
Listing only lineages with a revision was the alternative, and it was worse: the Project's
own count includes the join row either way, so a Project said it held three reviews, listed
two, and named nowhere the third or the fact that its capture had failed. An entry that has
a revision is unchanged, so a reader written against the earlier shape still reads it.

### A moving pull request appends, and carries only what it can prove

A complete source tuple that nobody has captured appends **one** immutable V1 revision and
one pending witness request, and the previous complete revision stays current until that
capture finishes. Nothing about the earlier revision changes: its document, its digest, its
code, its accounts, its reading state and its URL are what they were.

Three writers produce that source and converge on one capture. An explicit refresh reads
through the stored actor. A signed `pull_request` delivery records its observation inside
the delivery transaction, whatever the legacy `github_pr_status` upsert decides about the
same timestamp — that row is one mutable fact per pull request and legitimately declines an
equal-or-older one, while observations are history, and base-only movement carries no new
GitHub timestamp at all. Reconciliation records the same thing from the payload its sweep
already fetched. Webhook and reconciliation queue a capture only for a relation that reads
through an **installation**: a delivery is GitHub telling us something happened, so there
is nobody whose personal credential it is entitled to spend, and a PAT-owned relation
records the drift and waits for its owner to ask.

One pending or running job is reused per `(lineage, base, head)` pair, however many
observations of those bytes exist — a title edit, a draft flip, a second actor's reading and
a worker's merge-base enrichment all produce their own immutable rows and none of them is
worth a second capture. A refresh **adopts** a pending webhook job by replacing its trigger
observation with the complete reading it just took; a running job is never rewritten,
because its observation is what its capture is being recorded against.

A webhook carries no merge base, so its worker establishes one by comparing the delivery's
**own pinned base and head** through the relation's exact stored actor, publishes a complete
observation with that merge base, adopts it on its own running job under its lease, and then
captures those same SHAs. There is no `getPull`: asking what the pull request looks like now
would let a push that landed while the job waited replace the source the delivery was about.

Order is `github_updated_at`, then Seer's immutable `observed_at`, then SQLite's insertion
`rowid`. The last two are Seer's and are not dressed up as GitHub's: they exist because
base-only movement leaves `updated_at` untouched, and because two processes deciding "is
this newer" must decide the same way rather than falling back on a random id. Every drift,
queue and completion decision uses those same three keys. A capture that finishes against
source the lineage has already moved past completes as **superseded**, points at the
revision that overtook it, and appends nothing. Before a claimed job spends a GitHub
request, a complete observation whose exact source tuple already has a revision completes as
converged instead. If GitHub later force-pushes back to retained source, drift links the
matching earlier revision rather than asking for a refresh that cannot create another copy.

**Read carry is per member and exact.** `review_revision_change_reads` is still the one
active read; `review_revision_read_carries` is why one arrived. Both are written in the
completion transaction, so a mark whose reason did not commit cannot exist. A text change
carries only when its full key — rename-resolved path plus old, new and context
fingerprints — occurs exactly once in the previous capture and exactly once in the current
one. Line positions and canonical ids do not participate. Changed bytes, the same
fingerprint in another file, a split, a merge, a deletion, a duplicate candidate and an
ambiguous rename all carry nothing. Duplicate exact evidence still classifies as unchanged
movement, but its ambiguity creates no carry equivalence. Approval never carries, and no acknowledgement or
judgment table exists yet, so this is the only carried state there is; a future handling
write must cite the same equivalence key and source revision rather than infer from display
text. Unmarking a carried read removes the active row and leaves the provenance standing —
the history still says why it once arrived.

Non-text equivalence uses rename-resolved path, side, object kind, mode and Git object id
where one is known. Where none is, one stable machine reason code such as
`[budget:blob_requests]` participates and display prose never does, so a stable binary or
300-file limitation reads as unchanged rather than as permanent movement. The shipped
old/new tree truncation rows both remain capture-level `snapshot` facts; duplicate exact
rows classify as unchanged while their ambiguity authorizes no handling carry. Delta
classification may pair two placements to say `revised`; **carry** only ever follows a
unique exact match, which is the stricter of the two on purpose.

The account delta is a separate engine from the legacy `src/overseer/delta.ts`, whose
rough-match ReviewDoc semantics are intentionally incompatible. Identity is the witness's
own stable id — a group id, a focus id, an attachment id, a bundle version — and never
position, and an entity the current account dropped is reported as removed and linked back
to the account that still holds it rather than rewritten into one that never said it.

`review_witness_supersessions` records that appending revision N left an earlier
unpublished witness request behind. It is a JOIN rather than a fourth stored state: widening
the v16 CHECK would mean a previous image refusing a whole promoted review over a word it
does not recognise. The request id is the primary key and the insert ignores conflicts, so
the FIRST successor is preserved; claim, publish, fail and retry all refuse a superseded
request, and its page says `superseded` rather than pending forever.

A fresh witness claim is handed `priorAccount`: the exact latest account published over a
revision **lower** than this one, whole, or null. Never an account from this revision,
never a later one, and never a rewritten summary.

## Privacy differs from Seer

Seer bundles are public by link, because a bundle is something you want to hand to someone. A review contains private source code, so reviews belong to a workspace, the same unit bundles now live under, and are private within it: viewing needs a workspace session. If sharing is ever wanted it should be an explicit, revocable share token per review rather than a guessable slug.

## Deliberately not built yet

**Multi-repo.** Every pull request and every ref already carries its own repo, so the model can express a review spanning several, and nothing here needs to change to allow it later. Nothing supports it: the rendered chain assumes one repo in its labels, and the write path rejects a review that mixes them. That rejection is the point. An unenforced capability that no renderer honours is a trap for the first person who tries it, and the constraint is one line to lift on the day it is real.

**Non-code references.** Linear issues and their kin were in the original brief and are deferred. When they arrive the shape is a ref with a different kind and its own resolver, which is why `ref` is already a resolved pointer rather than a code-specific record. No further preparation is warranted now.

**The `keep` statement kind.** Cut, see the statement section.

**Rendering comment threads.** Pull request comments and review threads are derived and handed to the skill as context, so discussion informs the briefing. Rendering the threads themselves re-hosts GitHub's conversation UI, which is a project of its own and not this one. If a comment matters to the review, the skill says so in a statement or note and refs the code it is about.

**Attachment formats beyond images.** The `media_type` field is already there; each new format is a renderer decision made when a real review needs it.

**Mirroring annotations to GitHub.** The review should ultimately still live on GitHub, with Overseer as the better view of it. The shape is already implied by the model: an annotation whose target carries a ref is expressible as a GitHub review comment, because a SHA, a path and a line range are exactly what that API wants, and one without a code anchor is an issue comment on the pull request. One way, Overseer to GitHub, storing the mirrored comment id on the annotation. Not built until annotations themselves are, and two-way sync is deliberately not planned: pulling GitHub's conversation back in re-hosts it, which the comment-threads entry above already declines.

## Open questions

None outstanding in the document model. Witness instructions live separately in `skill.md`.
