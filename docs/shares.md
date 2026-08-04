# Shares

A share is a revocable, read-only link to one asset in a workspace, for someone who is
not in that workspace.

Seer has two kinds of asset today and will have more. Bundles were public by link, so
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
  kind          review | bundle
  target        the asset's slug within that workspace
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

A share link renders the current version. `GET /s/<token>/v/<n>` pins one, for the same
reason the private route does.

## What a share is not

**It is never a write.** A share grants reading and nothing else: no annotations, no
publishing, no refresh. Every write path keeps requiring a session or an API key, and the
share resolver returns a reader identity that fails those checks by construction rather
than by a forgotten branch.

**It does not show the workspace's own conversation.** A shared review renders without
annotations. Questions and answers are the workspace talking to itself about a change,
and a link handed to an outsider should carry the account rather than the discussion.
This is a default rather than a law; if it turns out people share reviews _to_ discuss
them, a per-share flag is the obvious next move.

**It is not a login.** Following a share never creates a session, never joins the
workspace, and never widens on a second visit. The holder of a token sees one asset.

## Failure

A token that is unknown, revoked or expired gets the same page a private review already
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

The settings page grows a list: what is shared, why, when it was made, when it expires,
and a way to revoke. A share nobody can see is a share nobody revokes.

## Decisions taken, and what would reverse them

**Hashed at rest** rather than stored plain. Costs a lookup by hash rather than by
primary key; buys that a database copy is not a set of working links.

**One token per asset** rather than one per workspace or per person. Revocation is the
whole point, and a token that opens several things cannot be revoked for one of them.

**No expiry by default.** An expiry that surprises the holder is worse than a link the
owner forgets, given revocation exists and is visible. Optional, because a client link
for one week is a real thing to want.

**Annotations hidden.** See above; reversible per share if the need appears.

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
