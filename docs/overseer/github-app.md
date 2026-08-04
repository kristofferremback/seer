# The GitHub App

Overseer reaches GitHub through one personal access token held in `GITHUB_TOKEN`, read
once at boot, used by every workspace. This document replaces it with a GitHub App whose
installations are owned by workspaces, and then spends the capability that buys: a pull
request on a review page says whether it is open, merged, closed or draft, and says it
within a second of it changing.

> **Line citations in this document are relative to `origin/main` at the commit that
> merged bundle shares (#8) and the skill-doc pass (#9), plus PR #7. They were verified
> against that tree, not assumed. If a citation lands somewhere surprising, the tree has
> moved and the citation is wrong — trust the surrounding prose, which names the symbol.

> **Revision, 2026-08-04.** The first draft of this document was reviewed adversarially
> by two models against the real tree. They independently found the same critical flaw in
> the claim flow — the three gates it proposed proved who was asking but never that the
> asker had anything to do with the installation they named — plus about twenty smaller
> errors, several of which were pre-existing bugs in code this plan touches. This version
> is the corrected one. Where a correction reverses something the first draft asserted,
> it says so rather than quietly reading as though it always knew.

## What is wrong with the token

**It is a confused deputy.** The token is the server's, not the caller's. Any workspace
that can publish a review can name any repository the token can read, and Overseer will
fetch it, cache its source in `ref_snippets`, and render it. Nothing in the request has
to prove the caller may see that repository, because nothing in the design ever asked.
The comment above `ref_snippets` in `migrate.ts` already admits this, and the one in
`derive.ts` goes further — *"if per-workspace tokens ever arrive this gate has to be
rebuilt around them."* This is that.

**It is one person's credential with one person's reach**, rotated by hand. (The first
draft said "a 90-day credential"; that is wrong — classic PATs can be created with no
expiry at all, and fine-grained ones run to a year. The reach and the manual rotation are
the argument, not the number.)

**It shares one rate limit.** 5,000 requests an hour for the whole instance, however many
workspaces are using it.

An App fixes the first two outright and the third mostly — see the rate-limit note under
routing, which is the one place a shared budget survives.

## What an installation is

A GitHub App is installed onto an **account**: a user (`kristofferremback`) or an
organisation (`threahq`). One installation covers one account and some set of that
account's repositories.

Two different questions live here and they must not be confused.

**Many installations per workspace: supported from day one.** A workspace holds as many
as it likes. `kristofferremback` and `threahq` in the same Seer workspace is the first
thing this has to do. The mapping is a plain foreign key and the routing walks the set.

**Many workspaces per installation: deliberately not yet.** GitHub lets an account
install an app exactly once, so there is only ever one installation for `threahq` in the
world. Letting two Seer workspaces both use it means Seer doing that multi-tenancy
itself, which is a real authorisation problem and not the first one to solve.

**Own the blast radius.** The first draft framed this as an unusual sharing case. It is
not: it is the default org shape. There is one `threahq` installation, so the first Threa
person to connect it takes it, and every colleague with their own Seer workspace is
locked out. The deferral's real cost is **one Seer workspace per GitHub org**, not "an
edge case", and that is worth knowing before it is discovered by a second person.

**What unblocks it later:** a link table replacing the single `workspace_id` column, plus
a claim proof per workspace — the same flow run again by a member of the second
workspace, probably with a confirmation from whoever already holds it. The routing code
does not change; it already asks a set-membership question.

## The shape

Schema **v5**, purely additive. The drop of `review_freshness` is **v6, a release
later** — see "Why the drop is its own release".

```
github_installations
  id                    "ghi_" + tinyId
  workspace_id          the owning workspace, NULL while unclaimed. Many rows may
                        share one. See "Unclaimed installations" below
  installation_id       GitHub's numeric id
  account_login         "kristofferremback" | "threahq"
  account_id            numeric; a login can be renamed, this cannot
  account_type          "User" | "Organization"
  repository_selection  "all" | "selected"
  connected_by, connected_at
  suspended_at          nullable
  removed_at            nullable; the audit row survives a disconnect

  CREATE UNIQUE INDEX ... ON github_installations (installation_id)
    WHERE removed_at IS NULL

github_pr_status
  workspace_id, repo_id, pr_number      PRIMARY KEY
  repo_id           GitHub's numeric id; NULL only on backfilled rows, healed
                    on first observation
  installation_id   which installation this observation came through
  repo              "owner/name" as last seen, for display only
  state             "open" | "closed"
  merged            0 | 1
  draft             0 | 1
  head_sha
  updated_at        GitHub's timestamp. The write precondition — see "Ordering"
  observed_at       ours

review_prs
  workspace_id, slug, repo_id, pr_number   PRIMARY KEY
  repo              display only
  (replaced wholesale on every publish, in the publish transaction)

github_deliveries
  delivery_id, received_at   PRIMARY KEY (delivery_id)
```

Three corrections are folded into that block, each from a review finding:

**The unique constraint is partial.** A column-level `UNIQUE` plus a soft `removed_at`
means disconnecting an installation strands its id forever: it can never be reconnected,
by that workspace or any other, and no user action recovers it because only reinstalling
on GitHub mints a new id. The claim and the audit trail have to be different things.

**Status rows carry `installation_id`.** Without it, `installation.deleted` cannot find
its own rows — and by the time the event arrives the installation is gone, so
`GET /repos/{o}/{r}/installation` cannot be asked either. Deleting by workspace would
destroy the surviving installations' observations, which is exactly the case this design
leads with as day-one supported.

**The join key is GitHub's numeric repository id, not `owner/name`.** GitHub treats those
names case-insensitively and renames change them outright, so a review published as
`ThreaHQ/Threa` would never join a webhook carrying `threahq/threa`, and a renamed repo
would silently stop matching everything. The name is kept alongside for display.

**But `repo_id` is nullable, because the migration cannot invent one.** This is the
correction that nearly shipped a silently broken backfill. `review_prs` backfills from
stored v4 documents, and **the v4 document has no numeric repository id anywhere**: `Pr`
carries `repo: string`, and `GithubPull` captures `head` and `base` with no repository
object at all. So a migration could produce `repo_id` only by calling GitHub — a migration
that reaches the network, unprecedented in this repo and impossible for a repository no
installation covers any more — or by writing a sentinel, in which case **webhooks join on
`repo_id` and never match a backfilled row**, every pre-App review renders unchecked
forever, and settings reports healthy deliveries throughout. Step 2's done-condition would
have passed.

So the join is explicit about its transitional state:

```
match on repo_id                     when both sides have one
fall back to lower(repo)             only when the stored repo_id is null
heal null -> id                      on the first observation of that row
```

The fallback exists solely for rows the migration wrote and retires itself as they are
observed. It is a stated, ending transitional path rather than a permanent second join.

**Two fields have to be captured that are not captured today.** `GithubPull` grows the
repository id (`base.repo.id` at minimum) and `updated_at` — the first so new documents
never need the fallback, the second because the conditional upsert's whole precondition is
a timestamp the client does not currently read. Neither exists in `github.ts` now, and
both are step 1 work rather than something a later step discovers.

**Unclaimed installations.** The webhook table records `installation.created` as an
*unclaimed* installation, which the schema as first written could not represent:
`workspace_id` was non-null and the claim flow "attaches", implying an UPDATE of a row
that had to exist first with no workspace. An implementer building the schema from the
schema block and the handler from the event table would have produced two incompatible
things. So `workspace_id` is nullable, and three consequences are stated rather than left
to be discovered:

- The partial unique index still keys on `installation_id WHERE removed_at IS NULL`, so an
  unclaimed row reserves the id exactly as a claimed one does — which is what stops a claim
  race from producing two rows for one installation.
- Every workspace-keyed query filters `workspace_id IS NOT NULL`. An unclaimed row belongs
  to nobody and must never be walked as if it belonged to somebody.
- **Routing refuses an unclaimed installation.** Resolving a repository to a row with no
  workspace is not a match; it is a 422 telling the caller the installation exists but is
  not connected to any workspace, which is both true and actionable.

### The derived readings

`github_pr_status` carries facts. Both readings are functions of the row and neither is
stored as a word:

```
status     merged ? "merged"
         : state === "closed" ? "closed"
         : draft ? "draft"
         : "open"

freshness  no row      -> "unknown"
           head match  -> "current"
           otherwise   -> "behind"
```

**`merged` must be tested before `closed`, and that is correctness rather than style:**
GitHub's `state` for a merged pull request *is* `"closed"`, so any other order renders
every merged pull request as closed. It gets a comment saying so in the code.

**`unknown` is a new third value, and it is load-bearing.** Today `read.ts:72` reads an
absent observation as `current`:

```ts
out[key] = seen && seen !== pr.headSha ? "behind" : "current";
```

That is why the first draft's claim about the drop — *"nothing is lost… the worst case is
one extra call"* — was wrong. With no rows, every review in the instance renders "heads
current", including ones that were correctly saying "3 of 7 behind" a minute before. And
it recurs every time an installation goes away and takes its rows with it: the glyph
correctly disappears while the chip beside it, from the same missing row, asserts
"current". That is the two-readings-disagree failure this whole design exists to prevent,
introduced by the design itself.

So absence renders as absence on both: no glyph, and a chip that says **heads unchecked**.
`Freshness` gains `"unknown"` in `types.ts`, `read.ts` stops defaulting, and the chip
learns a third string.

## Credentials

```
GITHUB_APP_ID             the app's numeric id
GITHUB_APP_SLUG           its URL slug (not a secret; it is in every install URL)
GITHUB_APP_PRIVATE_KEY    the PEM, base64-encoded — a raw PEM's newlines do not
                          survive a Railway environment variable
GITHUB_APP_CLIENT_ID      \  the user-authorization leg. Required. See "Claiming".
GITHUB_APP_CLIENT_SECRET  /
GITHUB_WEBHOOK_SECRET     the HMAC key for inbound deliveries
```

**The first draft said there was no client id or secret, "because Overseer never acts as
the reader on GitHub". That was the critical error.** It has to, exactly once, at claim
time, and nothing else can do that job. Details below.

### Secrets, and what is stored

Asked directly: **where is the credential GitHub gives us encrypted at rest?** It is not,
because it is never at rest. That is not this plan having quietly covered the question —
it is a consequence of a choice made for a different reason, and the choice deserves to be
argued against its alternative rather than assumed.

The rule for the whole system, written down so the next secret is not invented ad hoc:

| kind | example | how it is stored |
|---|---|---|
| **Verify-only** — Seer only ever needs to check a presented value | API keys, share tokens, the claim nonce | **hashed.** Not reversible, not readable back |
| **Use-later** — Seer needs the plaintext again to act with it | *nothing, today* | would need **envelope encryption** |
| **Ambient** — the process needs it from boot | app private key, webhook secret | environment variable |

Everything Seer stores today is in row one. `hashKey` is the only treatment of a secret in
the codebase and there is no `createCipheriv` anywhere in `src/`.

**Why nothing in this feature lands in row two.** The app JWT lives ten minutes and is
derived from the private key on demand. The installation token lives an hour and is minted
on demand. The user access token from the claim flow is used to list what the person can
reach and then dropped — **not** carried to the attach request, which reads a proof
recorded server-side instead; see "The proof has to cross a request", which is the one
place this question genuinely bit, and
dropped. A webhook needs no token at all — the payload carries the whole observation. Even
the deferred work does not create one: re-deriving a review when a head moves mints a token
from the private key with no user present.

So the plan is not "we store the token, encrypted". It is "we do not store the token",
which is the stronger of the two. A database copy is not a set of live GitHub credentials
either way, and the version with no ciphertext also has no key to rotate, no decrypt path
to get wrong, and no key-loss failure mode.

**Where the question does land, and where this plan was thin.** The claim nonce is a
short-lived bearer secret that *is* written to the database, and the first draft said
nothing about how. It is row one: hashed at rest, looked up by hash, exactly as
`shares.ts` and `api_keys` do. That is the real gap the question surfaces, and it is now
specified rather than left to whoever writes the migration.

**What would move something into row two**, so this is a decision with a trigger rather
than a permanent no:

- Persisting installation tokens so they survive a restart or are shared between
  instances. Today the cost of not doing this is one re-mint per process per installation
  per hour, which is negligible at this scale and spends the one shared budget only
  trivially.
- Storing a GitHub user **refresh** token, which would be needed only if Seer ever acted
  as a person on GitHub outside a request they are present for. Nothing here does.
- Any third-party credential a workspace hands Seer to use on its behalf.

**Recommendation, and it is a recommendation rather than a decision.** Build the envelope
primitive when the first row-two secret appears, not before. Unused crypto is worse than
absent crypto: the key rotation is never exercised, the decrypt path is never run, and its
first real use is by someone who reasonably assumes both work. If any of the three
triggers above is coming sooner than it looks — say the intent is for tokens to survive
across instances from the start — then it is row two now, and the shape is the one from
Threa: a data key per secret, sealed by a KEK from an env var, ciphertext and wrapped key
stored together with an explicit version byte so the KEK can be rotated without a
migration. Say the word and it goes in step 1 rather than in a later step.

### The runtime credentials

Two are derived at runtime and **neither is persisted**:

**The app JWT.** RS256 over `{iat, exp, iss}`, signed with `node:crypto`. **`iat` is
backdated 60 seconds** — GitHub rejects a JWT whose `iat` is in the future, and a second
or two of clock skew is normal on a shared host. `iat = now - 60`, `exp = now + 540`,
which stays inside the ten-minute ceiling with a minute of slack. This is the single most
common way a first App integration works locally and fails in production.

**The installation token.** `POST /app/installations/{id}/access_tokens`, good for an
hour, cached in memory keyed by installation id, re-minted five minutes early, never
written to SQLite — a copy of the database must not be a set of working credentials.

**Mint it narrower than the installation.** That endpoint accepts `repository_ids` and
`permissions`, so a derivation that names one repository can hold a token good for that
one repository. Given that the whole argument of this document is about a credential
being wider than its caller, using the full-breadth token when a narrow one costs one
field on the mint body would be odd. Routing becomes defence in depth rather than the
only barrier.

**Permissions requested:** Metadata read, Pull requests read, Contents read. That covers
`getPull`, `listCommits`, `listFiles`, `listReviewComments`, `getPullDiff` (the diff
media type on the PR endpoint) and `getFileAtSha`. Say plainly what Contents read
actually grants: **read access to the entire source of every selected repository at every
ref**, not "the code in this pull request". That is the grant an installer will pause
over, and it should be stated rather than softened. Nothing is requested for writing;
annotation mirroring will need Pull requests write, and asking now would be asking for a
permission with no use.

**Events:** only **Pull request** is subscribed. `installation` and
`installation_repositories` are delivered to every App automatically and *cannot* be
subscribed to — the first draft listed all three as subscriptions, which would send
whoever sets this up looking for two checkboxes that do not exist.

## Claiming an installation

**This section is rewritten. The first draft's three gates do not work.**

They were: a single-use nonce bound to the workspace, a member session, and
`GET /app/installations/N` with the app JWT. The first two establish *who is asking* and
*which workspace to attach to*. The third establishes only that `N` belongs to this App —
true of every installation in the world. **Nothing established any relationship between
the asker and `N`.**

The attack, which both reviewers found independently:

1. Mallory signs in to Seer and owns workspace `ws_m`.
2. She obtains an installation id belonging to someone else. They are small integers,
   enumerable, and not secret.
3. She reaches the setup callback with that id — with a nonce she minted legitimately, or
   through the first draft's no-state picker, which dropped the nonce gate entirely.
4. Membership passes. `GET /app/installations/N` passes.
5. Seer records `N → ws_m`.
6. She publishes a review naming a repository under `N`. Routing resolves it to `N`, sees
   `N` in her workspace's set, mints the token, and renders someone else's private source
   — and caches it in `ref_snippets`.

The `UNIQUE` index narrows this to installations nobody has claimed yet. That is every
installation between "installed on GitHub" and "connected in Seer", plus every one whose
owner never connects, plus every one released by a disconnect. Not narrow enough.

GitHub documents this exact hazard on the setup URL: do not rely on `installation_id`;
generate a user access token for the person and check the installation is associated with
them.

### What replaces it

Seer authenticates people through Google and therefore holds **no binding between a Seer
user and a GitHub identity**. The claim flow has to establish one, transiently.

1. **Connect** — an Origin-checked POST from workspace settings mints a nonce bound to
   **both the workspace and the session user id**, and redirects to GitHub's
   user-authorization endpoint with that nonce as OAuth `state`.
2. **GitHub returns** `code` and `state` to a callback. The nonce must exist, be unused,
   be unexpired, name a workspace this session's user is a member of, **and name this
   session's user**.
3. **Exchange** `code` for a user access token, with the client id and secret.
4. **Ask what they actually have:** `GET /user/installations` with that token. This is
   the only step that proves anything about the relationship between the person and the
   installation.
5. **Record the proof and present the intersection** — the installations they can reach
   that are not already claimed. This is the picker, built from proof rather than from a
   query parameter.
6. **Attach** on an Origin-checked POST, re-checking membership and re-checking that the
   chosen id is one the recorded proof names.
7. **Discard the user token.** It is never stored.

### The proof has to cross a request, and that is where the secret question actually lands

Steps 4 and 6 are **different requests**. The list of installations the person proved they
can reach is produced in the callback and consumed by the attach POST, so something has to
carry it between them. There are only three ways, and an earlier draft of this section
specified none of them while separately claiming that no GitHub credential outlives a
request — which the most natural reading of "re-checking that the chosen id is in the list
step 4 returned" quietly contradicts.

| how | verdict |
|---|---|
| Keep the user token and re-ask GitHub at attach time | **No.** That is a GitHub credential surviving a request boundary — a use-later secret, and the secrets table says there are none |
| Record the proven installation ids server-side, bound to the claim row | **Yes.** Not a credential: a list of integers the person demonstrated access to |
| Sign the list into the browser and verify at attach | Workable, and no worse; rejected only because it puts a second signing scheme beside the session HMAC for no gain |

**So the claim row carries the proof.** The row already exists — it is the nonce row —
and it gains the proven ids, the GitHub login they were proved for, and its own short
expiry. Three properties are not optional:

- **It lives in SQLite, not process memory.** This document establishes that old and new
  containers overlap by design during a Railway redeploy (`cc41e33`), so the callback and
  the attach can land on different processes. A memory-held proof is a claim flow that
  fails intermittently, during deploys, in a way no test will show.
- **The nonce is consumed at the callback, and the attach is gated by the claim row's own
  single-use flag.** Two stages, two burns; otherwise "must exist, be unused" at step 2
  leaves step 6 ungated.
- **The row is hashed like every other bearer secret here** if the browser holds a handle
  to it, and expires in minutes rather than hours.

The user access token is used to produce that list and is then gone. It never reaches the
database in any form, encrypted or otherwise — which is the claim the secrets section
makes, now with the mechanism that makes it true rather than an assertion that it is.

Two further corrections fall out:

**The callback must not write.** The first draft attached on the redirect GET. `originOk`
returns `true` when Origin and Referer are both absent (`server.ts:147`), which is the
normal case for a top-level navigation, so it is no guard at all there — an `<img src>`
pointing at the callback would have been enough. The callback renders a confirm page; the
POST from it writes.

**The refusal must not name the workspace.** The first draft said an already-claimed
installation would be declined "in plain words… told which of their workspaces already
has it". Combined with the attack above that is a free directory: enumerate ids, learn
which Seer workspaces exist and what they are called. Every other surface in the codebase
does the opposite — `requireMember` returns 404 specifically so "a non-member learns
nothing about the ws", and `shares.ts` works hard to make unknown, revoked and expired one
answer. The message says the installation is already connected to another Seer workspace
and to ask whoever connected it. It does not say which.

**Residual question, stated rather than assumed:** `GET /user/installations` returns
installations the user can reach, which for an org can mean a member with access to one
repository rather than an admin. Whether that is enough to bind an org installation to a
Seer workspace is a real decision. For a first version it is: the claim is first-come, the
workspace is private, and the alternative (requiring org admin) locks out exactly the
people most likely to be using this. It should be a conscious choice, not an accident.

### `setup_action`

- `install` — the ordinary path, handled above.
- `request` — an org member who cannot install has asked an admin. No installation exists
  yet; the page says so and attaches nothing.
- **`update`** — missing from the first draft. Someone clicks Configure and changes the
  repository selection; GitHub redirects here **if** the app has "Redirect on update"
  enabled, which is an opt-in setting worth naming. As first written this would fall into
  the claim path and hit the unique refusal, telling a user their own installation belongs
  to their own workspace. It is recognised and treated as "refresh
  `repository_selection`, invalidate the routing cache" — a better trigger than the
  webhook, because it is synchronous with the user's action.

**On `state` through the install URL.** The first draft leaned on `state` surviving
`/apps/<slug>/installations/new`. That has historically been dropped, reported fixed in
2023 and reported broken again since. The flow above does not depend on it: the nonce
rides GitHub's OAuth `state`, which is specified and reliable. A callback arriving with no
usable state is an error that says so and offers to start again — never a form that
accepts an id.

## Routing a repository to an installation

```
GET /repos/{owner}/{repo}/installation      (app JWT)
  -> the installation covering that repo, or 404
```

Then the only question that matters: **is that installation id one of this workspace's?**
If not — 404, or someone else's — the publish fails with a 422 naming the repository and
the account that needs the app.

**`repo` goes through `assertRepo()`** (`github.ts:98`) before it is interpolated. That
guard exists because `/repos/a/b#x/pulls/42` resolves to `/repos/a/b` and answers 200
with a payload nothing downstream would recognise as wrong.

### Routing lives inside the client, not in front of it

The first draft said "routing runs before the cache is read, so a derivation can only
reach snippets for a repository its own installation can read." That is not true of the
architecture as it stands, and it is the second-most-serious finding.

`refResolver` **used to seed** its gate from the *review's own PR repositories*, and
every method on `GithubClient` takes `repo` as its first argument. Worse,
`annotations.ts:270` builds a resolver from a **stored document**:

```ts
const resolver = refResolver(githubClient(), derivedFromDoc(doc));
```

So `proven` was whatever the document claimed, not what the caller may read. Answering an
annotation with a ref into such a repository returned private bytes from `getSnippet()`
with no GitHub call at all — no fetch, no token, no check. The seed asserted a fetch that
had never happened on any path, since deriving a pull request reads pulls, files and
commits and never reads file contents.

**Fixed ahead of this plan**: the set starts empty and only a successful fetch puts a
repository in it, which is what the comment above it always claimed. The cost is one
fetch per repository per resolver. A test asserting the old behaviour as correct was
rewritten, and it is worth saying plainly that a test was changed to let a fix pass —
the test encoded a behaviour its own source comment disclaimed.

That fix removes the reachable hole. It does **not** remove the reason routing belongs
inside the client, because the gate is still per-derivation rather than per-caller, and
today the containment on which repositories a ref may name is an accident rather than a
design: `validate.ts:1041` enforces `single_repo`. The moment that lifts — which this
document's whole multi-installation framing anticipates — the containment goes.

**So the workspace client refuses a repository the workspace does not hold, per call, at
the transport.** Not a check the callers remember to run first. Then the guarantee holds
whatever the validator does later, and the `ref_snippets` gate becomes per-workspace by
construction.

### The one shared budget that survives

`GET /repos/{o}/{r}/installation` authenticates as the **app**, with the JWT, and that
rate limit is app-scoped — shared across every workspace and every installation. It is
the instance-wide bottleneck this design otherwise removes, and it sits on the hottest
path, since routing runs per derivation and per observation.

The first draft said "cached with a short TTL", which is precisely backwards: the cache is
invalidated by `installation_repositories` and by `setup_action=update`, both of which are
correct invalidations, so **a long TTL is safe and a short one spends the scarcest budget
there is.** (The app-JWT limit is app-scoped rather than per-installation; the specific
number is unverified and should be checked against the docs before tuning.)

### Every call site

The first draft named two modules. There are four:

| site | what it does |
|---|---|
| `routes.ts:665` | `derivePrs` on publish |
| `routes.ts:240` | ref resolution on publish |
| `annotations.ts:270` | ref resolution on **annotation answer** |
| `freshness.ts:115` | the on-view observation |

`annotations.ts` also has its own `config.githubToken` guard at line 457. Deleting the
config entry while threading only two modules either stops that path compiling or, worse,
leaves it on the lazy default — the one surviving confused deputy, reachable by any API
key that can answer an annotation.

### The test seam needs a successor

`githubClient()` / `setGithubClient()` is a process-global singleton, and
`tests/setup.ts` installs an `offlineGithubClient()` into it so that, in its own words,
"nothing else reaches it either". Both privacy scripts repeat that install by hand because
they do not get the preload.

"A client built for the workspace" is a factory, not a singleton. The plan has to say what
the offline default becomes, or the suite starts making real network calls with real app
credentials during a routing lookup — **silently**, because a 404 from routing is
indistinguishable from "not installed". The factory takes the same injection seam, and
the preload installs a factory rather than a client.

## Removing the token

`GITHUB_TOKEN`, `config.githubToken` and the lazy default client go, in one commit, with
all four call sites threaded. No announced fallback, no grace release: a fallback is a
second path to GitHub that exists to be forgotten, and this one exists to restore exactly
the reach the App removes.

**The runbook, corrected.** The first draft's ordering contradicted its own step list — it
had you deploy first and connect second, which is an outage for the whole window between.

1. Create the App; install it on `kristofferremback` and on `threahq`.
2. Deploy **step 2** (the claim flow). The token still works.
3. Connect both installations through settings. Verify a publish derives through one.
4. Deploy **step 3**, which removes the token.

**Local dev now requires App credentials.** Today `githubToken` is optional and public repositories resolve anonymously. Once the App variables are `required()`, nobody runs the server without registering a GitHub App. That is consistent with failing loudly and is the right trade, but it is a real change to the dev loop and is chosen here rather than discovered.

**`config.ts` will break the suite** if the App variables are `required()` at import time,
because `config` is imported by nearly every module and therefore nearly every test.
`tests/setup.ts` seeds a generated keypair — which step 1 needs anyway for the JWT tests.

## Pull request status

### There is no polling

The first two drafts kept an automatic check on the read path — `refreshOnView`, once a
minute per review, triggered by a render. **It goes.** Not "goes eventually": it is
deleted in the step that adds webhooks, and nothing replaces it.

The argument for keeping it was that webhooks make status *instant* rather than
*possible*, so polling was the floor and webhooks the accelerant. That argument does not
survive contact with the fact that **publish already observes every pull request**.
`derivePrs` calls `getPull` per pull request while building the document, so the moment a
review exists its status rows exist. There is no window in which a review has no
observation and a poll is what fills it.

So the two write paths become:

```
publish   seeds     one getPull per pull request, already happening
webhook   maintains every subsequent change, pushed
```

That is one automatic write path after creation, not two. Every argument this document
makes about drift applies with more force to two *sources* than to two *readings*, and
polling was the second source.

**What is lost, precisely.** A change that happens while the app cannot tell Seer about
it: a suspended installation, a rotated webhook secret, a delivery GitHub gave up
retrying, the minutes of a redeploy. Under polling, those healed silently on the next
render. Without it they persist until something repairs them.

**So the repair has to become visible instead of automatic**, and that is the real cost of
this simplification:

- **`POST /api/reviews/:slug/refresh` survives** as the repair, now the only thing that
  reaches GitHub on the read path, and it is human-triggered. The review page grows a
  control for it beside the heads chip. (Its rate-limit bug is already fixed; the window
  now guards this route alone.)
- **Every observation carries `observed_at`,** and a row older than a threshold renders as
  *as of \<time\>* rather than as bare truth. A status nobody has confirmed for a week
  should look like one.
- **Delivery health is surfaced in settings.** If the safety net is removed, you have to
  be able to see that the net is gone: last delivery received per installation, and its
  suspended state. A webhook integration that silently stopped a fortnight ago is the
  failure mode this design is choosing, so it is the one thing the UI must make loud.

Without those three, dropping polling trades a small recurring cost for a silent failure,
which is the wrong trade. With them it trades it for a visible one, which is the right
one.

### Terminal transitions, and why visibility alone is not enough

The three mechanisms above make a stale status *visible*. They do not make it *correct*,
and there is one class of loss where visibility arrives too late to matter.

**A lost `synchronize` heals itself; a lost `closed` never does.** Push again and another
`synchronize` arrives carrying the new head. But merging or closing a pull request is the
**last event that pull request will ever emit**. Lose that one delivery — a ten-second
timeout, a redeploy window, a suspended installation, a rotated secret — and the row says
`open` for the rest of time, on a page with no reason to doubt itself. The single most
important status transition is precisely the one webhooks cannot self-heal.

Two more with no repair path at all under the design as first revised:

- **`installation.unsuspend`.** Miss it and `suspended_at` stays set forever. The failure
  table promises a 422 "naming the account and saying it is suspended" — which would then
  be asserting something false, permanently, with nothing anywhere to clear it.
- **`installation_repositories.added`.** The `removed` action drops that repository's
  status rows; `added` writes nothing back. Every review naming that repository renders
  unchecked indefinitely **while delivery health in settings looks perfectly fine**,
  because deliveries are flowing. The one mechanism meant to make the failure visible
  reports health.

**The answer is reconciliation, and it is not polling returning by the back door.** The
distinction is the trigger: a poll fires on a timer or a render, endlessly, whether or not
anything happened. Reconciliation fires on a **discrete event that means observations may
have been missed**, and then stops:

```
installation.unsuspend            \
installation_repositories.added    >  sweep review_prs for the affected repositories,
a successful claim                /   re-observe each pull request once, then stop
```

Bounded by the number of pull requests in affected reviews, triggered by an event rather
than a clock, and it writes through the same conditional upsert as everything else. It
also clears `suspended_at` on any delivery received from that installation, because a
delivery arriving *is* proof the installation is live — which repairs the unsuspend case
even when the unsuspend event itself was the one that was lost.

What reconciliation still cannot repair is the lost merge on an otherwise healthy
installation, because nothing announces that it happened. That is what the human refresh
control is for, and it is the residual risk this design accepts knowingly rather than by
omission.

**A GitHub behaviour to verify before building step 5, flagged as uncertain rather than
asserted:** whether GitHub automatically retries failed webhook deliveries at all. The
belief is that it does not — one attempt, a ten-second timeout, and redelivery is manual
via the UI or `POST /app/hook/deliveries/{id}/attempts`. If that is right, every delivery
is one-shot and the losses above are permanent by default rather than unlucky, which
raises reconciliation from prudent to required, and makes `GET /app/hook/deliveries` worth
reading in the settings panel rather than merely recording what arrived. Confirm against
the current documentation; do not build the retry assumption into a test that then models a
mechanism production does not have.

**The consequences that ripple out.** `claimCheck`'s window, the `LAST_CHECK` map and its
eviction bound exist to protect the read path from a render storm. With no automatic
check, they guard exactly one human-triggered route. They stay — a loop on that route is
still a loop — but they stop being load-bearing, and the question of re-keying the claim
from the review to the pull request becomes moot rather than urgent.

**And it has two homes, not one.** `read.ts:72` is the one the first draft named. The
second is `freshness.ts:219` — `known[key] ?? "current"` — written into the refresh route
by the very fix that closed its rate-limit bug, which means the pattern this document
spends two pages condemning was planted, by this author, on what is now the *only repair
path*. `headsChip` in `render.ts` is a third: it collapses to "heads current" whenever
`behind === 0`, so it needs the unknown count rather than a zero check. All three change
together in step 4, or the chip lies where the glyph is honest on the one route a human
reaches for when they already suspect something is stale.

`unknown` **is still needed**, and is now needed for a narrower and clearer reason: not
"nobody has looked yet" but "this review predates the App", which is exactly the reviews
the migration backfills and cannot observe.

### One observation

There is one row per pull request and both readings are derived from it. Publish writes it
from the `getPull` it already makes; webhooks write the same row through the same upsert.
A second way for the row to become true, not a second source of truth.

**Publish is the seed, and this is now load-bearing rather than an optimisation.**
`derivePrs` already calls `getPull` per pull request and drops `state`, `merged` and
`draft` (`derive.ts:255-267`). Those fields ride through `DerivedPr` and are upserted in
the publish transaction. With polling gone, this is the *only* thing that gives a new
review its first status — get it wrong and every review renders glyph-less until its first
webhook, which for a merged or abandoned pull request may be never.

### Ordering: the upsert needs a precondition

Removing polling removes one race and leaves two, so the precondition is still required:

1. **Publish races a webhook.** A publish that started before a merge writes `open` from
   its `getPull` after the merge webhook has already written `merged`.
2. **Webhooks race each other.** GitHub does not guarantee delivery order, and a retried
   delivery can land after a newer one succeeded.

**The upsert is conditional on `updated_at` being newer than the stored row**, with an
explicit tie policy: equal timestamps let the write through, because GitHub's `updated_at`
has one-second resolution and a genuine later state is likelier than a duplicate. Without
this the single row is just one place where the fact oscillates.

### The reviews index, which does not exist yet

`listReviews` exists in `overseer/db.ts` and is tested, and **nothing calls it**.
`/bundles` renders bundles only, so a published review is reachable today only by its URL.
So this is not a column added to a page; it is the page.

**It ships after webhooks.** With publish seeding and webhooks maintaining, the index is
correct the moment both exist; before webhooks it would show each review's status frozen
at publication, which reads as truth and is not.

The tally is derived at render from rows already written and **reaches GitHub never**.
Listing twenty reviews must not become twenty calls — and with the automatic check gone
this is no longer a rule the index has to remember, because there is no code path left
that could observe from a render at all. The rule became a property of the architecture,
which is the better version of it.

### Where the glyph goes

In `card()`, inside the `c-id` span, before the `#1723` link — the line that already talks
about GitHub rather than about the review. Four glyphs from GitHub's own vocabulary.

### The colour argument, because it breaks the colour law

Seer's review page runs a closed palette: a small set of mark families, quiet washes,
oxblood as the only accent. Green, purple and red are none of those.

They are admitted on one ground: **these colours are quoted, not authored.** They express
GitHub's encoding, not Seer's judgment, and a reader who has seen ten thousand of them
reads the card without being taught anything. The exception is bounded, and the bound is
the rule:

- The GitHub palette appears **only** in this glyph. Never a wash, border, text or chip.
- One glyph per card, at the size of the marks beside it.
- Colour is never the only channel: four distinct shapes, and the word in the accessible
  name.
- Dark theme uses GitHub's dark variants, not lightened light ones.

If it spreads past the glyph, the rule has been broken — the exception does not widen.

### When an installation goes away

Its status rows go with it (found by `installation_id`, which is why that column exists),
and the glyph disappears rather than showing the last thing that was true. The chip beside
it says **unchecked**, not "current" — see the `unknown` reading above. The same applies
when `installation_repositories` removes a repository: the rows for that repository go,
or the glyph renders indefinitely after access ended.

## Webhooks

One endpoint, `POST /api/github/webhook`, authenticated by signature alone — the correct
amount, since GitHub cannot hold a Seer credential.

**It must not have an `originOk` guard**, unlike every other POST in the route table.
Worth a comment there, or the next person to read the table will add one and break it.

**The signature.** `sha256=` plus HMAC-SHA256 of the **raw** body under
`GITHUB_WEBHOOK_SECRET`, verified before the body is parsed. The comparison reuses the
length guard from `auth.ts:11` — `timingSafeEqual` **throws** on unequal lengths, so a
truncated header would be a 500 rather than the promised 401. A missing secret fails at
boot, naming the variable, like the private key.

**Replay.** The delivery id and every database effect commit in **one transaction**, and
websocket messages publish only after commit. The first draft inserted the id and then
did the work: if processing failed after the insert, GitHub's retry would be classified as
a duplicate and the event lost for good.

**Attribution.** Every payload carries `installation.id`, which resolves to one workspace,
and that is the **only** thing deciding whose rows are written. Nothing is trusted from
`repository.full_name` — the numeric `repository.id` is the join key. An unknown
installation is a 202 that writes nothing, because an installation removed a second ago
has deliveries in flight.

| event | actions | effect |
|---|---|---|
| `pull_request` | opened, closed, reopened, edited, synchronize, converted_to_draft, ready_for_review | conditional upsert **only for pull requests some review names** — see below |
| `installation` | created | record as an **unclaimed** installation, with its `repositories[]` |
| `installation` | deleted | mark removed; drop that installation's status rows |
| `installation` | suspend, unsuspend | set / clear `suspended_at` |
| `installation` | new_permissions_accepted | record; matters when annotation mirroring needs write |
| `installation_repositories` | added, removed | invalidate routing cache; drop status rows for removed repos |
| `ping` | — | 204 |
| anything else | — | 202, ignored |

**The upsert is filtered, and the filter is not an optimisation.** An installation
covering "all repositories" on a busy org delivers a `pull_request` event for every pull
request anyone opens anywhere in that org. Writing a row for each would grow
`github_pr_status` without bound, forever, for pull requests no review mentions and no
page renders. So the upsert applies only where `(workspace_id, repo_id, pr_number)` appears
in `review_prs`; everything else is acknowledged and dropped. The counterpart is a sweep
nobody had specified: when a republish removes a pull request from a review, its
`review_prs` row goes, but its status row is keyed per workspace and may still be named by
another review — so status rows are collected when **no** `review_prs` row in that
workspace names them, in the same publish transaction.

`installation.created` was missing from the first draft and is the most useful of them: it
is the earliest trustworthy moment Seer learns an installation exists, it carries
`repositories[]` and `sender`, and recording it unclaimed means the settings page can
offer a real list rather than take an id from anywhere.

**Sweeping `github_deliveries`.** Not on the blob store's interval, as the first draft
said — that is `store.ts:234`, a module-level `setInterval` in a different layer, and
commit `8a59cc6` ("guard the cache sweeper") suggests it has already taken the process
down once. A second guarded interval, owned by the module that owns the table.

### Reaching the page you have open

**One message, not two.** The first draft added a `{"type":"pr"}` message beside the
existing `{"type":"freshness"}` and called it "not a change to the first". Two messages
describing one observation is two sources of one truth on the wire: they can arrive out of
order and leave the chip disagreeing with the glyphs on the same screen — the exact
failure the "one observation" section exists to prevent, reintroduced at the transport.

It also could not have worked. `freshnessScript` (`render.ts:2086`) rewrites the chip from
`m.behind` and `m.total`, counts the *server* computed. Given one pull request's headSha
the script cannot recompute `behind`: the page emits no per-PR head SHA and the script
holds no per-PR state.

So one message carries the whole observation:

```json
{
  "type": "review",
  "prs": [{ "pr": "threahq/threa#1723", "status": "merged", "freshness": "current" }],
  "behind": 0, "unknown": 0, "total": 5
}
```

The script swaps glyphs and rewrites the chip from the same message. Whatever caused the
observation — a webhook, or a human pressing refresh — the wire shape is identical.

## Migration

### Why the drop is its own release

The first draft called v5 "purely additive except one drop". Two things break.

**Rollback.** `migrate()` throws on an unexpected `user_version`. Deploy v5, hit a
problem, roll the image back, and the v4 container reads `user_version = 5` and refuses to
start. There was no reverse path and the document did not say so.

**Overlap.** Graceful SIGTERM shutdown (`cc41e33`) means old and new containers overlap by
design during a Railway redeploy. The old one calls `listFreshness()` →
`SELECT * FROM review_freshness` → `no such table`, on every review render and inside
every detached refresh.

Splitting costs nothing: **v5 adds the tables and stops writing `review_freshness`; v6, a
release later, drops it.** The anti-drift argument was about two *writers* of one fact, and
stopping the write settles that. The `DROP TABLE` is bookkeeping.

### The backfill

`review_prs` backfills from **each review's `latest_version` only**. Backfilling every
stored version would index pull requests that later versions dropped, so webhooks would
push to reviews that no longer name them and the index tally would count them. The
consequence, stated: a reader on `/r/slug/v/1` may see `unknown` for a pull request the
current version dropped, which is honest.

**Republish replaces the set.** A v2 that drops PR #4 and adds #9 deletes the #4 row in
the same transaction as `createReviewVersion`. The first draft said "written by the publish
path" and nothing about the delete.

**Malformed documents abort, loudly.** This is the first migration in the repo that reads
an application-level JSON format rather than doing pure DDL, and `getReviewVersion` does
an unchecked `JSON.parse`. A document with no iterable `prs` aborts the transaction with
the exact `(workspace_id, slug, version)` in the message. Silent skipping would leave an
incomplete security index, which is worse than a boot failure that names the row. The
parser reads the **v4 shape** and keeps reading the v4 shape forever, rather than
importing `ReviewDoc` and rotting the day someone edits it.

## Failure

| what broke | what happens |
|---|---|
| App private key or webhook secret missing/unparseable | fails at boot, naming the variable |
| Repository outside every installation the workspace holds | 422 on publish, naming the repository and the account |
| Installation suspended | 422 naming the account and saying suspended — sourced from GitHub refusing the mint, not from a `suspended_at` that a lost `unsuspend` could leave stale forever. The column is a display hint; the refusal is the fact |
| Installation already claimed | refused without naming the holding workspace |
| Token mint fails | the publish fails with GitHub's status and call site, as `GithubError` already does |
| Webhook signature wrong, missing, or truncated | 401, nothing written |
| Webhook for an unknown installation | 202, nothing written |
| No observation for a pull request yet | no glyph, chip says unchecked — never "current" |
| GitHub unreachable during an observation | last observation stands |
| Webhook deliveries stop arriving | status freezes at its last observation and **says so**: `as of <time>` on the page, last-delivery age in settings. Repaired by the refresh control. This is the failure mode dropping the poll chooses, which is why step 6 is not optional |
| An installation is suspended | deliveries stop; settings says suspended rather than merely quiet |
| App-JWT rate limit exhausted | routing fails; publish 422s naming the limit rather than the repository |

## Testing

**Its own process, no `AUTH_DISABLED`.** `tests/overseer/github-install-privacy.script.ts`,
spawned by the suite in the pattern `share-privacy.script.ts` set:

- Workspace B cannot list, see, or derive through workspace A's installation.
- A callback with no state, a forged state, a replayed state, or **a state belonging to a
  different user** attaches nothing.
- **The unheld case**: a signed-in member of B, valid session, valid Origin, naming an
  installation id belonging to A's account that nobody has claimed. This is the finding.
  The first draft's test list covered only the already-claimed case — the asymmetry was
  itself the tell that the hole was in the design rather than the code.
- An installation id absent from `GET /user/installations` is refused even with everything
  else valid.
- A repository outside every installation the workspace holds is refused on publish — and
  refused at the client, with the validator's `single_repo` rule disabled, so the
  guarantee is shown not to depend on it.
- An annotation answer cannot reach `ref_snippets` for a repository the workspace does not
  hold.

**And the success beside every refusal.** A guarantee is only tested when the thing it
withholds is demonstrably there to withhold. Each refusal runs beside the case that should
work.

**Webhooks.** Forged signature: 401, nothing written. Truncated signature: 401, not 500.
Unknown installation: 202, nothing written. Same delivery twice: applied once. A failed
apply followed by a retry: applied, not swallowed. An event for A writes into A and leaves
B untouched. **An out-of-order delivery does not roll a newer status back.**

**The JWT.** Generate a keypair in the test; verify header and claims; assert
`exp - iat <= 600` **and `iat < now`**.

**The token-secrecy test, fixed.** "Assert the installation token appears nowhere in
SQLite" passes against an implementation that never mints anything and returns an empty
string — vacuous by this repo's own rule. It first demonstrates the token exists and is
the credential the client used (a fake transport asserting the `Authorization` header
carried it), and only then that no row contains it.

**The glyph.** Four states, four shapes, the word in the accessible name, and the four
still distinguishable with colour removed. Plus: a merged pull request renders as merged
and not closed — the ordering constraint, tested.

## The steps

These are sized for a build-then-verify pass per step, where the implementer and the
verifier are different runs that do not share a context. That imposes two rules on how a
step is written: **it must be checkable from the tree alone**, without knowing what the
previous step was thinking, and **it must leave `bun test` and `tsc` green**, because a
verifier's first question is whether the tree is sound and a red suite makes every later
answer ambiguous.

Each step therefore names its own done-condition, which is the thing the verifier checks
rather than a summary of the work.

**1. App identity.** Config, the JWT with backdated `iat`, the installation-token cache
with narrow minting, repository routing, the per-workspace client factory, the test seam
successor. `GithubPull` grows `updated_at` and the repository id. A second injection seam
for the OAuth transport, which is not a `GithubClient` and does not fit the first one.
No schema, no UI, no route.
*Done when:* a generated keypair signs a JWT whose claims and lifetime are asserted, and
`iat < now`; a fake transport shows the `Authorization` header carried the minted token,
and that the token appears in no SQLite row afterwards; **the factory refuses a repository
the workspace does not hold, against an injected holdings interface** — the DB-backed
implementation does not exist yet and is step 2's to verify; the suite still cannot reach
the network **through either seam**.

**2. Schema v5 and the claim.** Tables, the partial unique index, the hashed claim nonce,
`review_prs` backfill from latest versions, the OAuth claim flow end to end, the settings
panel. The old token still works throughout.
*Done when:* `github-install-privacy.script.ts` passes in its own process — including the
unheld-installation case — and each refusal has its success beside it.

**3. Derivation through installations, and the token deleted.** All four call sites
threaded; `GITHUB_TOKEN`, `config.githubToken` and the lazy default removed in one commit.
Four existing tests set `config.githubToken` and assert the 503 it produces
(`routes.test.ts`, `annotations.test.ts`); the behaviour they cover is being deleted, so
they are **rewritten to assert the 422-no-installation refusal that replaces it**, not
deleted to make the suite green.
*Done when:* no `githubToken` remains in `src/`; publish, ref resolution and annotation
answers all derive through a workspace client; and those four tests still assert a refusal
rather than having been removed.

**4. One observation.** Status upserted in the publish transaction; `unknown` added to
`Freshness`; the conditional `updated_at` precondition; the glyph and the colour rule.
`review_freshness` stops being written.
*Done when:* a published review renders its glyphs immediately with no webhook and no
poll; an absent row renders as unchecked on **all three** of glyph, chip and the refresh
route's JSON; a merged pull request renders merged rather than closed; **an older
observation applied after a newer one does not overwrite it** — the precondition is built
here, so it is verified here rather than waiting for step 5 to exercise it.

**5. Webhooks, and polling deleted.** Endpoint, signature, one-transaction dedupe, the
event table, the single live message. `refreshOnView` and its call site go in the same
commit; `handleRefreshReview` stays as the human repair.
*Done when:* an out-of-order delivery cannot roll a newer status back; a failed apply
followed by a retry applies; nothing in `src/` reaches GitHub from a render.

**6. Seeing that the net is there.** `observed_at` surfaced as *as of \<time\>* past a
threshold, the refresh control on the review page, delivery health per installation in
settings.
*Done when:* an installation whose last delivery is old says so in settings without being
asked, **and** a review whose observation is older than the threshold renders "as of
&lt;time&gt;" rather than bare status. The threshold is one hour, named here so it is not
invented three times.

**7. The reviews index.** The page that does not exist, with tallies from rows already
written.
*Done when:* the index renders tallies that match seeded rows, **and** makes zero GitHub
calls doing it, asserted by a counting client. The zero-call assertion alone passes against
a page that renders nothing, which is the vacuity this document names elsewhere and would
otherwise have written into its own plan.

**8. v6: drop `review_freshness`.** One release after step 4 stopped writing it.

Steps 1–4 are the spine: at the end of 4 the App owns every credential, the token is gone,
the confused deputy is gone, and a published review shows its status. Step 5 makes it stay
true. **Step 6 is not polish** — it is the price of deleting the poll, and shipping 5
without 6 leaves a silent failure where there used to be a self-healing one.

## Settled

**Many installations per workspace, one workspace per installation.** The second is a
deferral whose real cost is one Seer workspace per GitHub org. Reversed by a link table
plus a per-workspace claim proof; routing unchanged.

**The token is deleted, not deprecated.** The cost is an ordering constraint on the
deploy, not a risk.

**One observation, two derivations** — with a third freshness value, because absence has
to be sayable or the chip lies where the glyph is honest.

**Status on the reviews index,** which is its own step, and now after webhooks rather than
before.

**No polling at all.** Publish seeds, webhooks maintain, a human repairs. The automatic
on-view check is deleted rather than kept as a floor, because publish already observes
every pull request and so there is no window for a poll to fill. Reversed only by
discovering that webhook delivery is unreliable enough to need a safety net — which step 6
exists to make observable rather than assumed.

**Nothing GitHub gives Seer is stored.** Not stored encrypted: not stored. Envelope
encryption waits for the first secret that needs reading back, and the triggers that would
create one are written down.

## What the review changed

For the record, so a reader of the first version knows what moved:

1. The claim flow gained the GitHub OAuth leg. Without it, any signed-in user could bind
   an unclaimed installation to their own workspace and read its private source.
2. The refusal stopped naming the holding workspace.
3. `UNIQUE` became a partial index, so disconnect releases rather than strands.
4. `github_pr_status` gained `installation_id`; the join key became the numeric repo id.
5. `Freshness` gained `unknown`; the "drop is free" claim was withdrawn.
6. The drop moved to its own release, for rollback and redeploy overlap.
7. Routing moved inside the client; the call-site list went from two to four.
8. The upsert gained an ordering precondition.
9. The two live messages became one, which is also the only version that works.
10. The index and webhooks swapped places.
11. GitHub corrections: two events cannot be subscribed to, `setup_action=update` exists,
    `installation.created` matters, the app-JWT rate limit is shared and wants a long
    cache rather than a short one, Contents read grants whole-repository source, tokens
    can be minted narrower, `iat` needs backdating, `merged` before `closed` is
    correctness, and the PAT expiry claim was wrong.
12. Pre-existing problems surfaced. Two were live bugs and are **already fixed**, ahead of
    this plan and independent of it: the ignored refresh claim, and the `ref_snippets`
    gate opening for repositories nothing had fetched. Two were not bugs and the first
    report of them overstated the case — the discarded publish observation is unused data
    that only matters once step 4 wants it, and the vacuous token-secrecy test is a test
    in this plan rather than one in the tree.
