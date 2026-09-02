---
name: overseer
description: Review one pushed same-repository GitHub pull request, or an exact stack, in Seer's immutable Overseer reader. Creates or adopts one lineage per pull request, then dispatches a fresh witness through an exact leased request. Do not use for local-only work or private forks.
---

# Overseer

**If you are setting this up:** save this file as
`~/.claude/skills/overseer/SKILL.md`, or the equivalent path for your agent. Put a
workspace API key in `SEER_API_KEY`. A human mints one at
`https://seer.build/settings/<workspace>`.

**If you are an agent reading this at request time:** follow the workflow below. Do not
save this file.

## The rule

**You do not write the review. A fresh sub-agent does.**

The fresh witness must not receive the builder conversation, a plan, a summary of the
change, or hints about what to find. It receives one exact witness claim and Seer's hosted
`/overseer/skill.md`. Seer retains the facts. The witness authors one complete account.

Seer does not invoke a model. The agent that dispatches the witness owns that inference.

## Require an exact remote pull request

The default workflow starts from pushed GitHub pull requests. It does not capture an
unpushed branch and does not fall back to Stage or legacy ReviewDoc publication.

Before creating anything, establish all of these facts:

1. The requested commit is on a remote branch. If the current checkout is the source,
   compare `git rev-parse HEAD` with `git rev-parse @{upstream}`. Dirty and unpushed work
   is outside the pull request and cannot enter this review.
2. GitHub has a pull request whose head OID is that pushed commit. Read it with `gh pr
   view --json number,headRefName,headRefOid,headRepository,baseRefName,baseRepository,url`.
3. The head and base repository are the same repository. Private forks are deferred in
   this release. Do not substitute the base repository's branch, another credential, or
   an anonymous read for a fork head.
4. A stack is one same-repository head-to-base chain in bottom-to-top order. Unrelated
   pull requests are not a stack.

If any fact is missing, stop and report what must be pushed or opened. Do not push a
branch or open a pull request unless the user authorized that GitHub change.

## Create one lineage per pull request

For each pull request, call the exact ingestion route. Use a stable idempotency key for
that intended operation.

```sh
curl -sS -X POST https://seer.build/api/pull-request-review-lineages \
  -H "Authorization: Bearer $SEER_API_KEY" \
  -H "Idempotency-Key: overseer-owner-repo-pr-123" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "owner/repo",
    "number": 123,
    "slug": "repo-123"
  }'
```

One pull request has one live lineage owner in a workspace. If the response says another
lineage already owns it, do not create a duplicate or silently change the slug. Return the
owning lineage URL, or ask for an explicit successor slug when a legacy ReviewDoc owns the
requested name.

A `202` is a real pending capture, not a review document. Poll the returned job URL until
it names a completed `revision` and immutable `revisionUrl`.

```sh
curl -sS -H "Authorization: Bearer $SEER_API_KEY" \
  https://seer.build/api/review-capture-jobs/<rcj-id>
```

A failed job carries its failure and retry URL. Report it. Retry only through that URL
after the cause is fixed. Never post the same change to `/api/reviews` as a fallback.

When the job names a revision, read that exact revision API view:

```sh
curl -sS -H "Authorization: Bearer $SEER_API_KEY" \
  https://seer.build/api/review-lineages/<slug>/revisions/<revision>
```

Its `witness.claimUrl` is the member witness handoff. Use that returned URL. Do not list
workspace inventory and choose a row during the normal flow. Publish every requested
member account before creating a whole-stack account.

## Create the stack when requested

After the exact member accounts publish, create an inferred stack from those lineage slugs
when the retained base and head refs prove the chain:

```sh
curl -sS -X POST https://seer.build/api/review-stacks \
  -H "Authorization: Bearer $SEER_API_KEY" \
  -H "Idempotency-Key: overseer-stack-owner-repo-feature" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "feature-stack",
    "members": ["repo-121", "repo-122", "repo-123"]
  }'
```

When GitHub itself reports a native stack, use the native adapter explicitly:

```json
{"slug":"feature-stack","native":{"seed":"repo-121"}}
```

Native and inferred input normalize to the same ordered manifest. Do not try native and
silently fall back to inferred, or reverse that order. A refusal names the broken member,
cycle, fork, fan, repository mismatch, or unresolved native member.

ReviewDoc, promoted lineage, and stack slugs share one flat workspace namespace despite
their separate routes. A collision is a refusal. Never treat `/r-stacks/` as permission to
reuse review text.

The create response contains the exact manifest at `manifest`. Once every pinned member
has an account, `manifest.witness.claimUrl` is the stack witness handoff. If `witness` is
null, member accounts are still missing. Finish those exact member requests and re-read
the latest stack manifest rather than inventing a stack account.

## Dispatch the returned exact witness request

Spawn one fresh general-purpose sub-agent with exactly this brief, filling in the values:

> You are a fresh Overseer witness. You have no builder conversation and must not ask for
> one.
>
> - Review service: `https://seer.build`
> - Instructions: fetch `https://seer.build/overseer/skill.md` first and follow the
>   immutable witness contract exactly.
> - Exact claim URL: `<claimUrl from the returned revision or stack manifest witness>`
> - API key: use `SEER_API_KEY` as `Authorization: Bearer $SEER_API_KEY`. Never print it.
> - Expected work: `<member slug and revision, or stack slug and manifest>`
>
> Claim that exact request before reading. Read only the retained revision or manifest,
> its prior account, and its open threads returned by the claim. Publish one complete
> replacement account. Do not read a moving branch for evidence. Do not comment, merge,
> edit, or otherwise mutate GitHub.
>
> Return the canonical latest URL, the immutable revision or manifest URL, the account URL
> if publication completed, any failure verbatim, and any error in these instructions.

The claim route leases `(request id, retry count)`, so only one agent can own the attempt.

If the dispatcher lost the creation response, `GET /api/witness-requests` is
bounded recovery inventory. Match the exact slug and revision or manifest. Failed rows have a
`retryUrl` and no `claimUrl`; retry the exact failed row only after its cause is fixed.
Inventory does not claim or renew work and is not the default dispatch path.

## Return what exists

For a member, return:

- latest: `/<workspace>/r/<slug>`
- immutable evidence: `/<workspace>/r/<slug>/rev/<revision>`
- immutable account: `/<workspace>/r/<slug>/v/<version>`, once published

For a stack, return:

- latest: `/<workspace>/r-stacks/<slug>`
- immutable manifest: `/<workspace>/r-stacks/<slug>/v/<manifest>`
- immutable account: the manifest URL plus `/account`, once published

Pending and failed work stays pending or failed in the answer. Do not present a lineage
shell, capture job, evidence-only revision, or manifest awaiting member accounts as a
completed witnessed review.

These URLs need workspace access unless someone mints an exact document capability. A
private miss and a missing document both return the same 404.

## Explicit legacy mode

`POST /api/reviews` now republishes only a slug that already exists in the legacy
`reviews` table. It cannot create a new ReviewDoc, and no mode flag changes that.

A permanent legacy successor is explicit:

```text
POST /api/reviews/<legacy-slug>/successor
```

Use it only when the user asks to move an existing legacy artifact forward. It never
redirects or copies old annotations, shares, reads, handling, discussion, or evidence.
The old artifact and every old URL remain readable. Unrelated legacy sets return
`unsupported_source` and stay legacy.

Retry uses the exact API key that created the succession. If a slug race leaves a failed
workflow with no result, that same key may post a new idempotency key and amend only the
unresolved target or member slugs. Retained pull requests, Projects, order, and resolved
member slugs cannot change.

Stage V1 is also explicit compatibility work. `/stage/agent.md`, StageDoc V1 publication,
and `/st/` URLs remain available, but the default `/overseer` flow never falls back to
them.
