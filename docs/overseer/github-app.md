# The GitHub App

Overseer reaches GitHub through one personal access token held in `GITHUB_TOKEN`, read
once at boot, used by every workspace. This document replaces it with a GitHub App whose
installations are owned by workspaces, and then spends the capability that buys: a pull
request on a review page says whether it is open, merged, closed or draft, and says it
within a second of it changing.

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
  workspace_id          the owning workspace. Many rows may share one
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

**The join key is GitHub's numeric repository id, not `owner/name`.** GitHub treats
those names case-insensitively and renames change them outright, so a review published as
`ThreaHQ/Threa` would never join a webhook carrying `threahq/threa`, and a renamed repo
would silently stop matching everything. The name is kept alongside for display.

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

Two credentials are derived at runtime and **neither is persisted**:

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
5. **Present the intersection** — the installations they can reach that are not already
   claimed — and let them pick. This is the picker, now built from proof instead of from
   a query parameter.
6. **Attach** on an Origin-checked POST, re-checking membership and re-checking that the
   chosen id is in the list step 4 returned.
7. **Discard the user token.** It is never stored.

Two further corrections fall out:

**The callback must not write.** The first draft attached on the redirect GET. `originOk`
returns `true` when Origin and Referer are both absent (`server.ts:145`), which is the
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

**`config.ts` will break the suite** if the App variables are `required()` at import time,
because `config` is imported by nearly every module and therefore nearly every test.
`tests/setup.ts` seeds a generated keypair — which step 1 needs anyway for the JWT tests.

## Pull request status

### Polling happens only while someone is looking

**There is no background poller.** No timer, no cron, no sweep. The only thing that causes
Overseer to ask GitHub about a pull request is a person opening a page that shows it, plus
the explicit `POST /api/reviews/:slug/refresh`, which is a person asking on purpose. A
workspace with two hundred reviews nobody is reading costs nothing.

**The bound was not real, and is now.** The first draft said "the existing bound stays
exactly as it is: at most one check per review per minute". It did not hold for explicit
refresh: `handleRefreshReview` called `claimCheck` and **threw the return value away**,
then checked anyway, so a member or an API key could POST in a loop and spend one GitHub
call per pull request per request without limit. **Fixed ahead of this plan** — a refused
claim answers from the observation already recorded, with `checked: false` so a caller
that really needs a fetch can tell it did not happen.

**And the claim key moves.** The best argument for dropping `review_freshness` is that the
head SHA is a property of the pull request, not of the review looking at it. The same is
true of the check. `claimCheck(wsId, slug)` keys on the review, so a workspace with three
reviews of one stack pays three calls a minute for the same pull requests and writes the
same row three times. The claim moves to `(wsId, repo_id, prNumber)` in the same step —
otherwise the row has moved and the thing guarding it has not, which is where the next
disagreement starts.

### One observation, not two checks

There is one call, one row, one moment of observation, and both readings come out of it.
`checkReview` already calls `getPull` and reads exactly one field. The change is that it
stops throwing away three-quarters of what it fetched. `freshness.ts` becomes the module
that **observes a pull request**, and webhooks write the same row through the same upsert
— a second way for the row to become true, not a second source of truth.

**Publish observes too.** `derivePrs` already calls `getPull` per pull request at publish
and drops `state`, `merged` and `draft` (`derive.ts:255-267`). Left as the first draft had
it, a freshly published review renders with no glyph despite Seer having held the answer
seconds earlier. The status fields ride through `DerivedPr` and are upserted in the
publish transaction.

### Ordering: the upsert needs a precondition

Deduplication does not order anything, and polling races webhooks:

1. A poll starts before a merge and receives `open`.
2. The merge webhook arrives and writes `merged`.
3. The slow poll completes and writes `open` over it.

A delayed delivery does the same in reverse. The first draft stored `updated_at` and never
used it. **The upsert is conditional on `updated_at` being newer than the stored row**,
with an explicit tie policy: equal timestamps let the write through, because GitHub's
`updated_at` has one-second resolution and a genuine later state is likelier than a
duplicate. Without this the single row is just one place where the fact oscillates.

### The reviews index, which does not exist yet

`listReviews` exists in `overseer/db.ts` and is tested, and **nothing calls it**.
`/bundles` renders bundles only, so a published review is reachable today only by its URL.
So this is not a column added to a page; it is the page.

**And it ships after webhooks, not before.** The first draft had it as step 5 and webhooks
as 6, which is backwards: with no background poller, `github_pr_status` has rows only for
reviews someone recently opened. The index's whole pitch — see a stack land without
opening it — is exactly what the polling rule guarantees you do not have until you open
it. Before webhooks it would show tallies only for the reviews you did not need it for.
Webhooks first; and the index renders "not checked yet" rather than a tally that silently
reads as zero merged.

The tally is derived at render from rows already written and **does not trigger an
observation**. Listing twenty reviews must not become twenty calls to GitHub — the polling
rule at the one place it would be easiest to break.

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
| `pull_request` | opened, closed, reopened, edited, synchronize, converted_to_draft, ready_for_review | conditional upsert into `github_pr_status` |
| `installation` | created | record as an **unclaimed** installation, with its `repositories[]` |
| `installation` | deleted | mark removed; drop that installation's status rows |
| `installation` | suspend, unsuspend | set / clear `suspended_at` |
| `installation` | new_permissions_accepted | record; matters when annotation mirroring needs write |
| `installation_repositories` | added, removed | invalidate routing cache; drop status rows for removed repos |
| `ping` | — | 204 |
| anything else | — | 202, ignored |

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
observation — a reader's poll or a webhook — the wire shape is identical.

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
| Installation suspended | 422 naming the account and saying suspended |
| Installation already claimed | refused without naming the holding workspace |
| Token mint fails | the publish fails with GitHub's status and call site, as `GithubError` already does |
| Webhook signature wrong, missing, or truncated | 401, nothing written |
| Webhook for an unknown installation | 202, nothing written |
| No observation for a pull request yet | no glyph, chip says unchecked — never "current" |
| GitHub unreachable during an observation | last observation stands |
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

1. **App identity.** Config, the JWT (backdated `iat`), the installation-token cache with
   narrow minting, repository routing inside a per-workspace client factory, the test seam
   successor. No schema, no UI.
2. **Schema v5 and the claim.** Tables, partial unique index, `review_prs` backfill from
   latest versions, the OAuth claim flow end to end, the settings panel. The token still
   works.
3. **Derivation through installations, and the token deleted.** All four call sites
   threaded; `GITHUB_TOKEN`, `config.githubToken` and the lazy default removed together.
4. **One observation.** Status written from the call `checkReview` already makes and from
   the publish transaction; `unknown` added to `Freshness`; the claim key moved from the
   review to the pull request; the conditional upsert; the glyph and the colour rule.
   `review_freshness` stops being written.
5. **Webhooks.** Endpoint, signature, one-transaction dedupe, the event table, the single
   live message, the script that swaps glyphs and chip together.
6. **The reviews index.** The page that does not exist, with tallies that are now
   populated because step 5 shipped first, and "not checked yet" where they are not.
7. **v6: drop `review_freshness`.** One release after step 4 stopped writing it.

Steps 1–4 are the spine: at the end of step 4 the App owns every credential, the token is
gone, the confused deputy is gone, and status is on the page as of whenever someone last
looked. Step 5 is what makes it true while nobody is looking, which is why the index waits
for it.

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
