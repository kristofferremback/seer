# Glossary

Two products live in this repository and they share a vocabulary that is not obvious
from the code. Some of it is deliberate nicknames; the rest is words that mean something
narrower here than they do in general.

## The two things

**Seer** is the host. It stores self-contained HTML bundles and serves them at stable,
versioned URLs a human can open. Uploading the same slug again makes a new version and
live-reloads anyone already reading it.

**Overseer** is the review side, built on Seer and sharing its deployment, its
workspaces and its keys. It turns one or more GitHub pull requests into a page you read
instead of the diff. The name is literal on both counts: it is the instrument through
which a reader *oversees* a change, and it sits over Seer.

**The witness** is the sub-agent that reads the pull requests and writes the review. It
testifies to what it observed; the reader judges. It is always a fresh agent with no
memory of the work under review, because an agent that helped build a change describes
what the change was *meant* to do rather than what the diff says. The name is the older
name of the whole project, kept where it was always most accurate.

## The document

A **review** is one published document about one or more pull requests. It is authored
in one shot and published whole; nothing is appended afterwards except annotations.

A **version** is one publication of a review. Publishing to the same slug makes the next
version and the previous ones stay readable, which is how a review can be done in passes.

The **delta** is what changed between two versions. It is computed, never authored: the
witness may not write "revised" anywhere, because a chip that is typed rather than
derived is a claim the page cannot check.

## What a review is made of

A **statement** is the atom of the overview: one line of what changed, of kind `add`,
`change` or `remove`, backed by at least one ref, with prose behind it that says why.
A statement may span several pull requests, which is the shape a per-pull-request
reading hides.

A **note** is only something a reviewer would otherwise miss, of kind `risk` or `note`.
Contract changes and data flow are not notes; they are the change itself, so they are
statements. A `risk` must be falsifiable: it carries checks, or a ref into changed code.

A **group** is a set of hunks that changed for one reason, and the walkthrough is the
ordered list of them. Groups hold hunks rather than files, because one file can carry
two unrelated changes, and a group may hold hunks from several pull requests.

**Evidence** is what a claim is shown with, in the order the witness chose: a ref, a
payload, an example, a figure, an attachment, or a link to a Seer bundle.

## The facts underneath

A **hunk** is one `@@` block of a diff, with every line number derived from GitHub
rather than authored. Its **id** is a deterministic function of the pull request, the
path and the range, so the same diff parsed twice produces the same ids.

A **ref** is a SHA-pinned pointer at some lines of some file: repo, sha, path, start and
end. Overseer resolves it and caches the snippet. Its **origin** is derived, `in_stack`
when those lines belong to a pull request in the review and `outside` when they do not,
which is what makes a ref into untouched code legible as such.

**Derived** means Overseer computed it and the witness may not write it: titles, SHAs,
hunks, line numbers, stats, origin, freshness, the review's `kind`. **Authored** means
the witness wrote it and Overseer may not invent it: the summary, statements, notes,
groups, and which evidence backs which claim. That split is the whole design.

**Unaccounted** files are ones GitHub served no diff for and that could not be rebuilt
from their contents either. The walkthrough names them, because it promises that absence
on the page means absence in the diff.

## The rules with names

**The partition.** Every hunk in every pull request belongs to exactly one group. A hunk
no group claims is a 422. Mechanical churn does not escape by being boring; it gets a
group named for the chore it is and ranks last.

**Budgets are the schema.** Every cap is enforced on write and returns a 422 naming the
field and the overage. Only the maximum scales with the number of pull requests; the
minimum is flat, so nothing ever obliges a witness to pad.

**The decomposition warning** fires when a review spends its whole budget. On a
monolithic pull request that is forced rather than a judgment, and the summary should
say which it is.

## Elsewhere

`docs/overseer/data-model.md` is the settled model. `docs/overseer/skill.md` is what the
witness is told. `docs/overseer/agent.md` is what a person installs so their agent can
dispatch one. `/skill.md` on a running deployment routes between all of it.
