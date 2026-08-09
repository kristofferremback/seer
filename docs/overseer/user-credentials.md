# User credentials

The GitHub App reaches a repository when an installation covers it. That requires somebody
with admin rights on the account to install a third-party app, which is a fine bar for your
own org and an impossible one for your employer's. So there has to be a second way in, and
it has to be the reader's own access rather than the workspace's.

This document adds one: a credential that belongs to a **person**, acquired by OAuth,
stored encrypted, and used only for work that person initiated.

## The choice, and the thing that argues against it

Two ways to hold a user's GitHub access:

| | how it is acquired | what it can reach |
|---|---|---|
| **OAuth App** | click a button, no admin approval | everything you can read — **and write** |
| **Fine-grained PAT** | paste a secret | exactly the repositories you pick, read-only |

The OAuth App was chosen for the flow: no copy-paste, revocable from GitHub's own settings,
and the secret never crosses a text field or a clipboard.

**But it is worse on scope, and by more than it looks.** OAuth Apps have **no read-only
scope for private repositories.** The only scope that reads private code is `repo`, and
GitHub describes it as *full control of private repositories* — it grants push, admin on
hooks, and delete. A fine-grained PAT can be "read the contents and pull requests of these
three repositories, and nothing else"; an OAuth App cannot express that at all.

So the credential Seer holds for your employer's code would be one that could also write to
it. Overseer never writes, and nothing in this design does, but that is a property of the
code rather than of the grant, and the grant is what an employer's security team would ask
about.

**Both are therefore built, and they are the same feature.** One table, one routing rule,
one envelope, two ways to fill it:

- **Connect with GitHub** — the button, the OAuth flow, `repo` scope. The default.
- **Paste a fine-grained token** — for a repository where the wider grant is not acceptable,
  which is a judgement only the person holding it can make.

That costs one extra `kind` column and a second form. It buys a design that does not force
the wider grant on someone who has a reason to refuse it, and the day an employer asks
"what can this thing do to our code", there is an answer that is not "everything".

## The constraint everything else follows from

**A credential belongs to a user, not to a workspace.**

Seer's assets are workspace-scoped and its members share them. If a credential were held by
the workspace, then any member could publish a review naming a repository only *one* member
can read, and Seer would fetch that private source with that member's identity. That is the
confused deputy the App work removed, rebuilt with a different credential.

So the rule, stated once and enforced at the transport:

> A user credential is used only for a derivation the owning user initiated. Never on
> behalf of another member, never on behalf of the workspace.

Two consequences fall out immediately, and one of them is the main piece of plumbing in
this change.

**`githubClientFor(workspaceId)` is not enough.** The factory knows which workspace is
asking and not which person, and a user credential is meaningless without the second. Every
call site therefore has to carry the asking user: publish already has one (`api_keys.user_id`
is on the key that authenticated), annotation answers have one, the refresh route has one.
The webhook path does **not** — it is triggered by GitHub, not by a person — and that is
correct rather than an omission: a webhook must never be able to reach a repository through
somebody's personal credential, because nobody asked it to.

**Precedence is fixed, and installation wins.**

```
1. an installation the workspace holds covers the repository   -> use it
2. the ASKING USER holds a credential that can read it         -> use that
3. otherwise                                                    -> 422, naming both routes
```

Installation first because it is the stronger grant: scoped by the org, revocable by the
org, auditable as an app rather than as a person. A personal credential is the fallback for
what no installation covers, not a shortcut around one.

## The shape

Schema v7. Purely additive.

```
github_user_credentials
  id             "guc_" + tinyId
  user_id        whose it is. There is deliberately no workspace_id
  kind           "oauth" | "pat"
  label          authored, why it exists ("work")
  secret         the envelope from src/envelope.ts
  account_login  what GitHub says the token belongs to, read at connect, never authored
  account_id     numeric, because a login can be renamed
  scopes         what GitHub reported, stored for display so a person can see the grant
  expires_at     nullable; OAuth App tokens do not expire by default, fine-grained ones do
  created_at, last_used_at, revoked_at

  CREATE INDEX ... ON github_user_credentials (user_id) WHERE revoked_at IS NULL
```

**The secret is sealed, not hashed.** This is the first row-two secret in the codebase — see
`docs/secrets.md` — and the one the envelope work was built for. Context is
`github_cred:<id>:<user_id>`, so a ciphertext moved onto another person's row stops
decrypting. That binding is doing real work here rather than being decorative: without it,
anyone who can write the column can borrow somebody else's access.

**A stored token is a much more valuable secret than anything Seer has held before.** An
installation token is minted narrow and lives an hour. This one may read — and under `repo`,
write — everything its owner can reach, and it does not expire. The key-encryption key is an
environment variable on the same host as the database, so a host compromise is a compromise
of every stored credential. That is a real limit of the current envelope design and it is
stated here rather than discovered later.

## Connecting

```
1. Settings, "Connect GitHub account". Origin-checked POST mints a nonce bound to the
   session user, and redirects to https://github.com/login/oauth/authorize
   ?client_id=…&scope=repo&state=<nonce>
2. GitHub returns code + state to /github/account/callback.
   The nonce must exist, be unused, unexpired, and name THIS session's user.
3. Exchange the code for a token.
4. GET /user with it: the login and the numeric id, from GitHub rather than from the form.
5. Seal and store. Burn the nonce.
```

It is the same shape as the App's installation claim, and deliberately so — same nonce
table, same two-stage burn, same "read the account from GitHub, never from the query
string". The one difference is that there is no second request to attach: the token *is*
the proof, so there is nothing to carry across a request boundary and no proven-ids list to
record.

**A second OAuth application has to be registered**, separate from the GitHub App, with its
own credentials:

```
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
```

Named apart from `GITHUB_APP_CLIENT_ID` / `_SECRET`, which #11 already uses for the
installation claim. Two applications, two flows, two pairs of credentials, and confusing
them would send a user through the wrong consent screen.

**The paste path** takes a token, refuses anything starting `ghp_` (a classic token, which
is all-or-nothing across everything the owner can see), verifies it with `GET /user`, and
stores it identically. A token that does not authenticate is refused at the point of entry
rather than becoming a broken review later.

## Reading through a user credential

The workspace client grows a sibling. `createUserGithubClient(userId)` routes by asking
whether any live credential of that user can read the named repository, which is one call:

```
GET /repos/{owner}/{repo}   with the user token   -> 200 means yes, 404 means no
```

Cached like the App's routing cache, with the same split the App work arrived at the hard
way: **a positive answer caches long, a negative answer caches for a minute.** A negative
that outlives the person fixing it is how "install the app" became a six-hour dead end in
the App work, and the same trap is here.

`ref_snippets` needs no new gate. Its rule is already that the cache opens for a repository
only once *this* resolution has fetched from it, and a fetch now means "through a credential
the asking user holds". The gate was rebuilt for exactly this in PR #7.

## Failure

| what broke | what happens |
|---|---|
| No installation and no credential covers the repository | 422 naming both routes: install the App on that account, or connect an account that can read it |
| The credential was revoked at GitHub | 401 from GitHub marks it dead locally and says which credential, rather than a generic error |
| The credential expired | same, distinguished by message, because the fix differs |
| A webhook names a repository only a user credential can read | nothing happens, deliberately. Status is not observed for it |
| `SEER_ENCRYPTION_KEYS` missing or wrong | fails at the point of use, naming the variable, as `envelope.ts` already does |

The fourth row is worth reading twice. A repository reachable only through a personal
credential gets **no webhook-driven status at all**, because webhooks arrive with no person
attached and this design refuses to pick one. Its status comes from publish, and from the
human refresh, and is stale in between. That is a real gap in the feature rather than an
oversight, and the page should say so where it shows a status it cannot keep current.

## Testing

The privacy script pattern, in its own process with `AUTH_DISABLED` deleted:

- **The whole feature, stated as one test:** user B, a member of the same workspace as user
  A, cannot cause a fetch through A's credential. Publish as B naming A's private
  repository, and it must 422 rather than resolve.
- A's own publish of the same repository succeeds, so the refusal is measured against a
  working success rather than against a broken feature.
- A callback with no state, a forged state, a replayed state, or **a state belonging to a
  different user** stores nothing.
- The stored secret appears in no column in plaintext — asserted after proving a token was
  actually issued and used, so the scan is not vacuous.
- A revoked credential stops working, and the corresponding live one still does.
- A classic `ghp_` token is refused at the point of entry, and a fine-grained one is
  accepted, in the same test.

## The steps

Each leaves `bun test` and `bunx tsc --noEmit` green, and each names what a verifier checks.

**1. The credential store.** Schema v7, the table, seal/open through `src/envelope.ts` with
the row-bound context, and the CRUD. No routes, no OAuth, no reading.
*Done when:* a credential round-trips; the plaintext appears in no column, asserted after
proving the value was really stored; a credential sealed for one user does not open for
another.

**2. Acquiring one.** The OAuth application config, the connect flow end to end, the paste
path with the classic-token refusal, and the settings panel listing and revoking.
*Done when:* the privacy script's state cases all store nothing, each beside its success;
`ghp_` is refused and `github_pat_` accepted; the account login comes from `GET /user` and
not from the request.

**3. Reading through it.** `createUserGithubClient`, the routing check with the long/short
TTL split, and the asking user threaded through every call site that has one.
*Done when:* B cannot fetch through A's credential while A can; an installation still wins
where both could serve; the webhook path has no user and reaches no credential.

**4. Saying so on the page.** The 422 that names both routes, the dead-credential message,
and the settings surface showing what each credential reaches and when it was last used.
*Done when:* a repository nothing covers produces an error a person can act on without
reading the source.
