# Projects data model

A project groups the work. One entity gathers everything produced around one piece of
work: prototypes, plans, reviews, tasks, notes. It lives in Seer, outside any repo, and
persists across sessions. Agents write it, humans read it, and every part of it is
optional except the grouping itself.

The unit is deliberately sizeless: a feature spanning months, a modal fixed in an
afternoon, a cleanup that runs forever. Nesting is what lets one word cover that range,
the way directories cover folders of any size, so the name stays the plain one.

This model was settled in a design session on 2026-08-20, against the vocabulary and
dividing line the review model established. It follows `docs/overseer/data-model.md` in
shape and shares its rules where they apply.

It ships in slices. The project entity, nesting, membership and the read pages are
live; the plan kind (`?kind=plan` and the reading surface), tasks, notes, and the
`projects[]` field on a review document are settled here but not yet served — a
route or field below that names them is contract for its slice, not a description of
today's deployment.

## The dividing line

The split reviews settled applies unchanged. Authored is what the agent may say and
Seer may not invent: titles, descriptions, bodies, statuses, gates, every pointer.
Derived is what Seer computes and the agent may not write: timestamps, attribution,
PR titles and states, status transition history, counts, freshness.

## One status set

`open | done | closed`, for projects and tasks alike. Done is finished; closed is
stopped without finishing. There is no doing, blocked, or shelved: notes and drift
hints carry that texture better than a status enum, and a status typed rather than
demonstrated is a claim the page cannot check.

Status transitions are recorded by Seer with their timestamps. "When did this move"
is derived, never journaled.

## Entities

### Project

```
project
  id           prj_…
  slug         url-safe, workspace-scoped, SLUG_RE
  parent       prj_… | null, same workspace, one level deep
  title        authored, <= 80 chars
  description  authored markdown, the constrained subset reviews use
  status       authored: open | done | closed
  created_at, updated_at    derived
```

Slugged and workspace-scoped exactly like bundles and reviews.

A sub-project is not a second kind. It is a project whose `parent` is set, with its own
plans, bundles, reviews, tasks and notes. The parent page derives a rollup of its
children: their statuses and counts, as shallow summaries next to its own assets.

One level deep to start. A parent that itself has a parent is refused as a 422, the
same posture as multi-repo reviews: an unenforced depth nobody renders is a trap, and
the constraint is one line to lift on the day a real tree needs it. Cycles are
impossible at depth one for free. A parent marked done while children stay open renders
as drift, the same derived grammar tasks use for merged PRs.

The line between a task and a sub-project stays loose on purpose. A task is a line in a
checklist; the moment it starts accumulating assets of its own, it grows into a
sub-project. That migration is creating one and moving pointers, not a schema event.

### Membership

A bundle or review can belong to any number of projects; a join row carries each
membership. The project holds no authored list on itself. Its page derives the contents
by query, so there is one source of truth and nothing to drift.

Memberships are written at upload or publish (`PUT /api/bundles/:slug?project=<slug>`,
a `projects[]` field in a review document) and attachable or detachable later, because
agents forget and late attachment has to work.

Tasks and notes are the exception: each belongs to exactly one project, because they
are the project's own content rather than assets that visit it.

### Plan

A plan is a bundle of kind `plan`. Same storage, same serving, same live reload;
versioning already gives "a plan we revise several times" for free, and republishing
live-reloads any open reader. What changes is the framing: the ledger seats plans under
their own heading and pages describe them as documents to read, not things being hosted.

```
bundle
  kind    bundle | plan     set at first upload, per slug, immutable
```

Immutable because a slug that changes species breaks its own history. A plan may exist
with no project, exactly as a bundle may.

**The plan reading surface.** A plan should read like Seer no matter which agent wrote
it, in light, dark and system. A prompt alone cannot guarantee that: one forgotten
media query and the page glows white at midnight. A hard template would guarantee it by
taking the bundle's power away. The system's own split resolves it: the agent authors
the content, Seer owns the reading surface. Seer hosts two files the way it already
hosts `/fonts/*` into bundles:

- `/plan.css`: tokens, type, spacing and rules of the house style, both themes fully
  defined. Fetched live, not vendored, so a redesign restyles every published plan.
- `/theme.js`: the app's three-state theme resolution. Bundles are same-origin, so the
  toggle choice made in the app carries into every plan, and system mode tracks the OS
  live.

The plan skill hands the agent a skeleton linking both; past that, the full bundle
remains available. Publishing a `kind=plan` upload that links neither returns a warning
naming what is missing, not a 422: a deliberately custom plan is legitimate, a silent
drift is not.

Markdown plans that Seer renders itself, with derived deltas between revisions, are
deferred until "what changed since I last read this plan" hurts for real. The bundle
kind does not block adding them later as a second shape of the same kind.

### Task

```
task
  id         tsk_…
  project    required
  title      authored, <= 120 chars, one line
  body       authored markdown
  status     authored: open | done | closed
  gates[]    0..8 { text <= 120 chars, met: bool }
  prs[]      authored pointers { repo, number }; title, state, merged derived
  created_at, updated_at, done_at    derived
```

Gates are the conditions the task must pass, authored unmet and flipped as work proves
them. The write path refuses `done` while a gate is unmet, a 422 naming the gate;
`closed` needs no such proof, stopping is always allowed. Budgets are the schema here
too.

PR pointers reuse the plumbing reviews already have: the agent writes repo and number,
Seer derives title and state, and viewing refreshes them the way review freshness
works. A task whose PRs are all merged while it still says open renders that drift as a
derived hint. The page checks the claim; it never silently corrects it.

### Note

```
note
  id         note_…
  project    required
  task       optional pointer
  body       authored markdown, <= 2000 chars
  author     derived from the key
  created_at derived
```

One kind of note, sheet-style: it belongs to a task, and by extension the project, or
to the project directly. Append-only and immutable, because the notes are the record of
what the agent was thinking while it worked, and a journal you can edit afterwards is
testimony you can revise. Reading a project's notes front to back is reading its
history, with status transitions rendered inline as derived lines, marked as such.

The word collides with review-focus notes the way "version" already serves both bundles
and reviews: different table, different place, context disambiguates.

## One call to resume

`GET /api/projects/:slug` returns the whole state in one response: the description,
plans with their latest versions, tasks with gates and PR freshness, bundles, reviews,
the notes tail. Children appear as shallow summaries (id, title, status, counts), never
recursively, so a parent's response stays bounded. An agent resuming after a month
reads one URL.

The human page serves the same projection as markdown under `Accept: text/markdown`,
the pattern the front page already uses, so the human entry point and the agent context
are the same address.

## Endpoints

```
POST   /api/projects                              create
GET    /api/projects                              ledger with counts
GET    /api/projects/:slug                        everything, one call
PATCH  /api/projects/:slug                        title, description, status, parent
POST   /api/projects/:slug/tasks
PATCH  /api/projects/:slug/tasks/:id
POST   /api/projects/:slug/notes
PUT    /api/projects/:slug/bundles/:bundleSlug    attach   (DELETE detaches)
PUT    /api/projects/:slug/reviews/:reviewSlug    attach   (DELETE detaches)
PUT    /api/bundles/:slug?project=&kind=plan      attach at upload
```

Every route lands in `src/api.ts` with its doc string, so `openapi.json` and the
contract test cover it, and the hosted skill docs grow with each slice.

## What Seer validates on write

- slugs match `SLUG_RE`; unknown project, bundle, review, task or parent is a 404
  within the workspace and indistinguishable from missing
- `parent` names a project in the same workspace that itself has no parent (one level),
  and never the project itself
- membership joins name a bundle or review in the same workspace
- `kind` is set on first upload only; a later upload naming a different kind is a 409
- status is one of `open | done | closed`; a task refusing `done` over an unmet gate is
  a 422 naming the gate
- caps: title 80 (project) / 120 (task), gate text 120, at most 8 gates, note body
  2000, project description 16384; titles are one line, control characters refused
- authored markdown outside the allowed subset is a 422 naming the construct
- notes are append-only: no update, no delete

## Privacy

Projects are members-only, like reviews: they carry work notes and reference private
reviews, so viewing needs a workspace session and every denial is the same generic 404
as a miss. Bundles keep their own visibility rules; a public workspace's bundle stays
link-viewable even when it belongs to a project.

## Deliberately not built

- Task dependencies, ordering, estimates, or anything that smells of ceremony.
- Editing pages for humans. Reading is the product; the first write control should be
  earned by a real want, probably flipping a task's status from a phone.
- Share tokens for projects. The shape exists if ever wanted; wanting it first.
- A delta between plan versions. The review delta machinery suggests itself; it can
  wait for a real want.
- Nesting deeper than one level. The 422 is the fence; lifting it is one line plus a
  renderer that draws a real tree.
