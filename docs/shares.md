# Shares

A share is a revocable, read-only link to one asset in a workspace, for someone who is
not in that workspace.

Seer has two kinds of asset today and will have more. Bundles are public by link, so
they need no share; reviews are workspace-private, so today they cannot be handed to
anyone at all. That asymmetry is the thing to fix, and fixing it per-asset would mean
inventing the same table twice. So the share is generic from the start: it names a kind
and a target, and each asset type opts in by teaching the read path to accept one.

The prize beyond reviews: once sharing exists, a bundle no longer has to be public to be
sendable. Public-by-link stays the default because handing someone a preview is what
Seer is for, but a workspace that wants private bundles gains the option without a
second mechanism.

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
This is a default rather than a law; if it turns out people share reviews *to* discuss
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

Session-authenticated, member-only, and the response carries the full `/s/<token>` URL
rather than the bare token, because the URL is the thing a person actually wants.

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
