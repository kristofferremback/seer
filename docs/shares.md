# Shares

A share is a revocable, read-only link to one asset in a workspace, for someone who is
not in that workspace.

Seer has legacy review and bundle links plus exact immutable promoted-review and stack document capabilities. Bundles were public by link, so
they needed no share; reviews are workspace-private, so they could not be handed to
anyone at all. That asymmetry is the thing to fix, and fixing it per-asset would mean
inventing the same table twice. So the share is generic from the start: it names a kind
and a target, and each asset type opts in by teaching the read path to accept one.

The prize beyond reviews, and now collected: a bundle no longer has to be public to be
sendable. Public-by-link stays the default because handing someone a preview is what
Seer is for, but a workspace that wants private bundles has the option without a second
mechanism.

## The shape

```
share
  token         "seer_sh_" + 32 random chars, the secret itself
  workspace_id  the workspace that owns the asset
  kind          review | bundle | review_document | stack_document
  target        a legacy slug, or one exact rvr_ / rac_ / rsm_ / rsa_ document id
  label         authored, why this link exists ("for Anna", "the client")
  created_by    user id
  created_at
  expires_at    nullable; null means no expiry
  revoked_at    nullable; set rather than deleted, so a revoked link stays auditable
```

The token is the row's identity and its secret at once, exactly as an API key is. It is
shown once at mint and stored hashed, so a leaked database does not become a set of live
links.

## The route

`GET /s/<token>` resolves the share and renders the asset it names, at the same URL shape
whatever the kind is. One route rather than a query parameter on each asset's own URL,
for three reasons: it matches `/invite/<token>` which already exists, it keeps the secret
out of the asset's canonical URL so the two can be reasoned about separately, and it
gives one place to set `Referrer-Policy: no-referrer` so following a link out of a shared
page cannot hand the token to a third party.

A legacy share link renders the current version. `GET /s/<token>/v/<n>` pins one, for
the same reason the private route does.

A document capability is pinned when minted. `review_document` accepts one exact source
revision or review account id. `stack_document` accepts one exact manifest or stack
account id. Minting copies the exact retained file, review-item, and attachment inventory
into capability-owned rows in the same transaction as the share. Resolution never follows
a slug, latest pointer, path, Git object id, or blob digest supplied by the holder.

## What a share is not

**It is never a write.** A share grants reading and nothing else: no annotations, no
publishing, no refresh. Every write path keeps requiring a session or an API key, and the
share resolver returns a reader identity that fails those checks by construction rather
than by a forgotten branch.

**Conversation is a separate exact grant.** Legacy review links permanently keep their
shipped no-annotation and no-conversation behavior. Document capabilities default to
`conversation_scope = none`. Existing task-8 capabilities keep that default and never
consult snapshot rows, including malformed or stray rows inserted later.

A new document capability may set `conversation: true`. Minting copies local threads only
from the exact revision, account, manifest, and stack account named by the document. It
copies an imported thread only when retained commit, path, side, object, and line facts
place it on an exact pinned revision. Comments copy only under those threads. A review
observation copies only when its commit is an exact pinned head. Unmappable and later
conversation bodies never enter the grant.

Each copied row carries the workspace and the reader rechecks its thread, observation,
and document relationship before returning anything. Later local replies, threads, and
imported identities do not appear. A later GitHub deletion tombstone is terminal and
replaces a copied body with `Deleted on GitHub`. Conversation capabilities remain
read-only, expose projected actors only, and render without refresh state or private Seer
links.

**It carries the change, not the codebase.** A shared review draws its hunks, the same
ones the walkthrough drew. It does not draw the file around them: for a member the
full-screen panel asks `/<ws>/r/<slug>/c` for the file at the commit a hunk counts
against and lays the hunks back into it, and on a share that route answers the soft 404
and the page does not offer the control in the first place. The difference is what was
agreed to. The person who minted the link handed over a review of a change; the whole of
every file that change touches is a larger thing, and links already in the wild would
have widened silently on the day the feature shipped. This no-context behavior is permanent for legacy links.

New document capabilities make a separate, explicit grant: every retained old and new
side of each copied file id may be read in windows of at most 400 lines and 512 KiB.
The request supplies only the copied opaque file id, side, and bounds. It cannot supply a
revision, capture, repository, path, object id, or digest as authority.

**It is not a login.** Following a share never creates a session, never joins the
workspace, and never widens on a second visit. The holder of a token sees one asset.

## Failure

A token that is unknown, malformed, revoked, expired, corrupt, cross-workspace, or outside
a copied document inventory gets the same page a private review already
gives a stranger: the soft 404, byte-identical to a slug that never existed. A revoked
link must not be distinguishable from a wrong one, or revocation becomes a way to confirm
that something was there.

The one exception is where the reader plainly has a session for the owning workspace: a
member following a stale share link should be sent to the asset itself rather than told
it does not exist, because for them it does.

## Minting and revoking

```
POST   /api/shares          { kind, target, label?, expiresAt? }  -> token, shown once
GET    /api/shares          the workspace's shares, without tokens
DELETE /api/shares/:id      sets revoked_at
```

The response carries the full `/s/<token>` URL rather than the bare token, because the
URL is the thing a person actually wants.

**Two credentials mint.** A session, which reaches several workspaces and so has to name
one; and an API key, which belongs to exactly one workspace and therefore names it by
existing. The key is the point: the agent that built and uploaded a bundle is the thing
best placed to hand out the link to it, and asking it to stop and fetch a human breaks
the one flow this is for — publish a preview, paste the link into the pull request.

That is a real widening of what a leaked key can do. A key could already upload and list,
but it could not read a private bundle's bytes; a share it mints can. The trade is taken
deliberately: minting is visible in the workspace's own list, every link is revocable,
and the alternative is a capability that only works when a human is watching. A share
token remains not a credential — it authenticates nothing, including this route.

The settings page lists what is shared, why, when it was made, when it expires, and a way
to revoke. Document rows use the projected title and exact pin rather than exposing raw
stored documents or actor identity. A share nobody can see is a share nobody revokes.

## Decisions taken, and what would reverse them

**Hashed at rest** rather than stored plain. Costs a lookup by hash rather than by
primary key; buys that a database copy is not a set of working links.

**One token per asset** rather than one per workspace or per person. Revocation is the
whole point, and a token that opens several things cannot be revoked for one of them.

**No expiry by default.** An expiry that surprises the holder is worse than a link the
owner forgets, given revocation exists and is visible. Optional, because a client link
for one week is a real thing to want.

**Personal and workflow state omitted.** A document capability adapts immutable V1 rows
without changing their bytes. It projects an agent to name and model only. Member ids,
key ids, credential and installation ids, email, Projects, reads, carry provenance,
progress, unread filters, acknowledgements, judgments, refresh state, GitHub actions,
private canonical links, all forms, and every mutation stay absent. Bundle evidence in an
account is inert text. Only copied attachment ids are readable.

Every `/s/` response carries `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex, nofollow`. Document capability responses, soft misses, and method
refusals also carry `Cache-Control: no-store`. Legacy bundle successes keep their shipped
`Cache-Control: private, no-cache`; the capability wrapper does not overwrite it. HTML also
carries the robots meta tag. Rendering a document capability uses retained rows and objects
with GitHub transports sealed.

## As built

Three things the sketch above leaves open, settled by the implementation rather than
against it.

**The mint names its workspace.** A session reaches several workspaces, so
`POST /api/shares` and `GET /api/shares` take one: `{ workspace, kind, target, label?,
expiresAt? }` and `?workspace=`. A workspace the caller is not in is a 404, the same
answer an id that never existed gets. Everything else that is wrong is a 422 naming the
field, in the shape the publish path already uses.

**Annotations are hidden by accident as much as by design, for now.** The share path
withholds them, but `QUESTIONS_ON_PAGE` is off, so no page renders an annotation and the
test that asserts a shared page carries none passes without exercising anything. The
assertion is kept because it starts testing something real the day the questions UI comes
back; until then this guarantee is unverified rather than verified.

**Bundles are shareable, and the tree is what made it work.** A bundle is a tree of
files whose every relative URL resolves against the path it is served from, so `/s/<token>`
for one meant the trailing slash, the asset remainder and the version pin all rewritten
onto the token path. That is a route rather than a resolver call, which is why the whole
of `/s/` is now matched in the server's fallback rather than declared as three routes:
the remainder after the token is arbitrary, and what it means is not knowable until the
token says which kind of asset it opens. `src/serve-bundle.ts` holds the part both the
workspace path and the share path do identically.

The live-reload channel is the one place a shared bundle is not simply the private one
re-rooted. A page served at the latest version reloads itself when a new one lands, over
a socket the workspace gates on membership — which the holder of a share does not have.
So a shared page's socket carries `?share=<token>` and nothing else: the server reads
the workspace and the slug off the share row, so a holder cannot widen the channel by
editing the query, and a token that stops resolving stops reloading. Pinned versions
open no socket at all, because they never change.

`SERVED_SHARE_KINDS` stays. Both kinds are served today, so the mint's `kind_not_served`
refusal is a standing check on the next kind rather than a live one — the read route and
the mint must not drift, and a link no route opens is worse than a refusal that says why.

**Where a share is minted.** From the bundle's own row in `/bundles`, through a menu that
also lists the links already open on it and revokes them, and from the review's page for a
review. Both go through `POST /api/shares` and show the token exactly once, because only
its hash survives. The settings page keeps the workspace-wide list: it is where a link
someone else made is seen and taken back.
