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

`author_intent` and `summary` are the forest with provenance kept visible. `author_intent` paraphrases only the problem and reason stated in the pull request descriptions. `summary` is the witness's independent account of what the code accomplishes, its important implication and high-level mechanism. A mismatch between them is a finding, not something the witness silently resolves by replacing the author's account. For a stack both describe the completed feature, fix or implementation, not the pull requests in sequence. File names, test counts and minor edge cases stay out. The first rendering of this very document buried its own purpose and read, for a moment, as if the tool were the reviewer. That is the failure this split exists to prevent, and the skill gets graded on it.

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

`kinds[]` is derived on purpose. The marks on a pull request card are then provably tied to real claims, instead of being a second thing the skill can get out of step with the first.

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

Constraint: every statement carries at least one ref. A claim with nothing behind it does not belong on the page.

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

`modules[]` distinguishes the policy or state owner from entry adapters, consumers and presentation. `coverage[]` is the sprawl check: fresh reads, cached reads, asynchronous work, repair and other distinct paths the feature must cover. Every entry is ref-backed. The object and its lists are always present in a new publish, but may be empty for a change with no useful code-design judgment; avoiding dead prose wins over filling the section.

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

A ref renders its snippet and links out to GitHub at the pinned SHA. The snippet is the bounded view and the link is the unbounded one; Overseer never grows a code browser. The point of the page is that the reader should not have to read code to review, and the point of the evidence is that they always can: every claim stays one tap from the lines it stands on, which is what keeps the skill honest even on the days nobody taps.

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
