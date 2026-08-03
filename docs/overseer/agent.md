---
name: overseer
description: Publish an Overseer review of one or more GitHub pull requests, readable as a page instead of a diff. Dispatches a fresh blind sub-agent that reads the pull requests and publishes to seer.build. Use when the user asks for a review of a PR or a stack of PRs, or asks you to "overseer" something. Do NOT use to review uncommitted local work; that has no pull request to derive facts from.
---

# Overseer

Save this file as `~/.claude/skills/overseer/SKILL.md` (or your agent's equivalent) and
your agent can publish reviews. It needs `SEER_API_KEY` in its environment, which is the
same workspace key that uploads bundles.


Overseer turns one or more pull requests into a page a human reads instead of the diff.
It derives every fact itself (files, hunks, line numbers, SHAs) and a sub-agent supplies
the judgment (summary, statements, notes, walkthrough). The service refuses anything
that does not add up, so a published review cannot claim a line that is not there.

## The one rule that matters

**You do not write the review. A fresh sub-agent does.**

The reviewing agent is called the witness, and it testifies to what it observed. If you
wrote the change, or planned it, or watched it being built, your context is full of what
the change was *meant* to do, and you will describe the intent rather than the diff. That
is the single failure this design exists to prevent.

So: spawn a sub-agent with **no context from this conversation**. Give it the repository,
the pull request numbers, a slug, and nothing else. It gets its instructions from the
service, not from you. Do not summarise the change for it, do not tell it what to look
for, and do not tell it who wrote the code.

## Dispatch

Spawn one sub-agent (Task/Agent tool, general-purpose) with exactly this brief, filling
in the four values:

> You are a review witness. Author and publish a code review of the pull requests below,
> following the instructions of the service you publish to.
>
> - Review service: `https://seer.build`
> - Its instructions for you: `GET https://seer.build/overseer/skill.md`, fetch this
>   FIRST and follow it exactly. It defines what you write, the document format, the
>   budgets, how to reference code, and how to publish.
> - API key: the value of the `SEER_API_KEY` environment variable, sent as
>   `Authorization: Bearer $SEER_API_KEY`. Do not print it.
> - Repository: `<owner/repo>`
> - Pull request(s): `<#N>` (or the list, lowest first, for a stack)
> - Slug to publish under: `<slug>`
>
> `gh` is authenticated for reading. Read-only: do not comment on, edit, merge or
> otherwise touch the repository on GitHub.
>
> A 422 names exactly what is wrong; read it and correct your document rather than
> fighting it. On a large pull request the first publish will come back naming hunks you
> could not have computed: claim those ids and publish again, that round trip is
> expected.
>
> Return: the url and version published, any warnings verbatim, and a friction report of
> anything in the service's instructions that was unclear or wrong.

Pick the slug yourself if the user did not: `<repo>-<number>` for one pull request,
something short and descriptive for a stack (`threa-ledger-stack`). Republishing to an
existing slug makes the next version and the reader sees what changed, so reuse the slug
when re-reviewing the same pull requests.

## After it returns

Give the user the url, the warnings, and anything substantive the witness found. Pass on
the friction report too if it named something wrong; that is how the hosted instructions
get better.

Two warnings mean something and are worth repeating to the user rather than swallowing:

- `decomposition` says the review spent its whole budget on too few pull requests. On a
  monolithic pull request this is forced rather than a judgment, so say which it is.
- `missing_patch` says a file could not be read at all and nothing on the page accounts
  for it. The page says so too, but the user should hear it from you.

## Not this

- Do not review local uncommitted work with it. Overseer derives its facts from a pull
  request; there is nothing to derive from a working tree. Use `pre-pr-review` for that.
- Do not publish a review of a pull request the user has not asked you to review.
- Do not read the witness's document and "improve" it. If it is wrong, say so to the
  user; editing it makes you the author and the reader loses the one guarantee the
  design provides.
