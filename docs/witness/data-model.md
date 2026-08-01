# Witness data model

Witness stores and renders a review. It does not read code and it does not form opinions. A hosted skill running on the user's own inference does that, then publishes a document here.

This model is derived from the prototype, not from theory. Every field exists because the rendered page needed it, and several constraints exist because the prototype got them wrong first.

## The dividing line

**Witness owns facts. The skill owns judgment.**

Witness derives from the GitHub API and the skill may not author:

- pull request titles, head and base SHAs, base refs
- the file list, the hunks, every line number, every `@@` range, the `+n -n` stats
- whether a ref points inside or outside the reviewed change
- whether the review is behind the branch

The skill authors and Witness may not invent:

- the summary
- statements: what changed, of what kind, and why it matters
- notes: what is easy to miss
- the walkthrough: how the change decomposes, in what order, and what each file is doing there
- which refs to attach to which claim

This split is the single most load-bearing decision in the model. In the prototype the agent authored line numbers by hand and drifted three separate times: a ref labelled `L38-49` rendered 38 to 47, two hunks in one file overlapped, and a hunk claimed a base range that its own PR had already rewritten. None of those are possible once the numbers come from the diff instead of from a language model.

## Entities

### Review

```
review
  id              string, opaque
  slug            string, url-safe
  title           authored, <= 80 chars
  kind            derived: single | stack | set
  summary         authored, <= 2 paragraphs, <= 600 chars
  prs[]           1..n
  statements[]    3..6
  notes[]         0..6
  groups[]        2..8
  annotations[]   0..n, written after publication
  created_at, updated_at
  freshness       derived per pr: current | behind
```

`kind` is derived, not declared: one pull request is `single`, several where each is the base of the next is `stack`, anything else is `set`. The renderer draws the same chain either way; the difference is only whether the chain has edges or is a list.

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
  gist            authored, <= 100 chars, one line
  detail          authored, <= 2 sentences
  detail_ref      ref id
  kinds[]         derived: the distinct kinds of the statements attributed to this pr
```

`kinds[]` is derived on purpose. The marks on a pull request card are then provably tied to real claims, instead of being a second thing the skill can get out of step with the first.

### Statement

The atom of the overview, and the thing the whole page hangs on.

```
statement
  id
  kind        add | change | remove | keep
  text        authored, <= 120 chars, one line, no markup
  prs[]       which pull requests realize it
  refs[]      pointers backing the claim
  body        authored, <= 1200 chars, plain paragraphs
  evidence[]  ordered: ref | payload | figure
```

`body` is prose, and it is where the reader opts in. It should cover why the change exists, what it does, and how it is built. Those are areas to cover, never labels to print. The prototype tried printing them as labels and it read as a form.

Constraint: a statement of kind `add`, `change` or `remove` must carry at least one ref. `keep` is the only kind allowed to stand on its own, because it is a claim about absence.

### Note

Only things a reviewer would otherwise miss. Contract changes and data flow are not notes, they are statements: they are the change itself. The prototype had them as notes and the ordering made risks look more important than the contract, which was backwards.

```
note
  id
  kind      risk | note
  text      authored, <= 140 chars
  body      authored, <= 1600 chars
  checks[]  0..5 ordered strings, each <= 120 chars
  refs[]
  evidence[]
```

Render order is fixed: risks first, then notes, authored order within each. The renderer decides this, not the payload.

Constraint: a note of kind `risk` must carry either a non-empty `checks[]` or at least one ref into a changed hunk. A risk has to point at something falsifiable. This exists because a reviewer agent in the prototype filed "tokens carry 75 random bits, lookup is one primary-key hit" as a risk, when it is an assurance. The constraint would not have caught that one, but it raises the cost of filing a vague risk, and `checks[]` is the field that makes a real risk actionable.

### Group

A walkthrough group is a set of hunks that changed for one reason. Hunks, not files: `src/server.ts` legitimately appears under both "anonymous access" and "api surface" because it carries two unrelated changes, and a file-keyed model cannot express that without lying.

```
group
  id
  title         authored, <= 60 chars
  significance  int, 1 = most significant, unique within review
  paragraph     authored, <= 600 chars
  hunks[]       hunk ids
  file_notes[]  { path, text <= 120 chars }
  kind          derived: the dominant kind across its hunks
```

Ordering is by `significance`, which the skill sets. There are no rules for what counts as significant beyond a convention that behavior outranks mechanism outranks tests outranks chore, and that is deliberate: the judgment is the product.

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

A pointer, resolved and cached by Witness. The skill writes the pointer, never the code.

```
ref
  id
  repo, sha, path
  start_line, end_line
  highlight[]   line numbers within the range
  origin        derived: in_stack | outside
  snippet       derived, cached
```

`origin` is derived by checking whether that path at that SHA is touched by any pull request in the review. The prototype's most useful single ref was one pointing at `src/auth.ts`, untouched by the stack, to show what the new gate reuses. Getting that label wrong would be a lie about the shape of the change, so the skill does not get to write it.

Refs are SHA-pinned, so a force push cannot rot them.

### Figure

The one drawing on the page. Not free-form: a constrained graph that Witness renders in the house style.

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
  created_at
```

## Budgets are the schema, not a guideline

Every cap above is enforced on write and returns a 422 naming the field and the overage. A prompt asking for brevity is advice; a schema that refuses a seventh statement is a design.

The counts that matter: 3 to 6 statements, at most 6 notes, 2 to 8 groups, and hard caps on every one-line field. The prototype settled at 5 statements, 5 notes and 6 groups for a three-pull-request stack, which is the right density for a phone screen.

## What Witness validates on write

- every ref resolves at its SHA, otherwise 422 with the path and range
- every hunk id exists in that pull request's diff
- every `prs[]` entry is in the review
- `significance` is unique within the review
- caps
- a non-`keep` statement has at least one ref
- a `risk` note has checks or a ref into a changed hunk

## Endpoints

```
POST  /api/reviews                  publish a review document, returns resolved review or 422
GET   /api/reviews/:slug            the resolved document, for the renderer
POST  /api/reviews/:slug/refresh    re-derive against GitHub, update freshness
GET   /r/:slug                      the rendered page
POST  /api/reviews/:slug/annotations
```

A review is authored in one shot. The skill reads the pull requests, forms its view, and publishes a whole document; it does not build one up over many calls. Annotations are the only thing written afterward.

## Privacy differs from Seer

Seer bundles are public by link, because a bundle is something you want to hand to someone. A review contains private source code, so reviews are private by default and need a session. If sharing is ever wanted it should be an explicit, revocable share token per review rather than a guessable slug.

## Open questions

1. Is `keep` worth keeping? It is the only statement kind that can have no evidence, and in the prototype it carried real weight ("uploads, storage, version semantics and live reload are untouched") because a reviewer wants the blast radius stated. Keeping it for now.
2. Should `significance` be a float to make reordering cheap, or an int with a reindex on write?
3. Multi-repo reviews are expressible, since every pr and ref carries its own repo, but the rendered chain assumes one repo in its labels. Worth deciding before it is load-bearing.
4. Linear issues and other non-code refs were in the original brief. A ref with a different `kind` and its own resolver would fit without disturbing anything above.
