# Secrets

Seer holds three kinds of secret, and the kind decides how it is stored. Getting this
wrong in either direction is expensive: encrypting something that should be hashed keeps a
plaintext around that never needed to exist, and hashing something that has to be read back
means discovering, at the worst moment, that it cannot be.

| kind | Seer needs to | examples | how it is stored |
|---|---|---|---|
| **Verify-only** | check a value someone presents | API keys, share tokens, invite tokens, the GitHub App claim nonce | **hashed** — `hashKey`, SHA-256, indexed by hash |
| **Use-later** | present the value to someone else | a user's GitHub token | **envelope-encrypted** — `src/envelope.ts` |
| **Ambient** | have it from boot | GitHub App private key, webhook secret, session secret | **environment variable** |

Verify-only is the default and should stay the default. A secret Seer never needs to
replay is a secret that should be irrecoverable, because then a copy of the database is not
a copy of the secrets.

## Envelope encryption

Only for the middle row. The shape is standard and the reason for it is rotation:

```
secret     encrypted under a fresh, single-use data key (DEK)
DEK        encrypted under a long-lived key from the environment (KEK)
both       stored together in one opaque string
```

Rotating the KEK re-wraps data keys rather than re-encrypting secrets, and because every
envelope names the KEK that sealed it, several KEKs can be configured at once — so a
rotation is a config change and a background sweep, with no migration and no downtime.

```ts
import { seal, open } from "./envelope";

const stored = seal(token, `github_pat:${userId}`);
const token  = open(stored, `github_pat:${userId}`);
```

### The context argument is not optional decoration

The second argument is additional authenticated data. It is not secret and is not stored,
but **an envelope sealed under one context cannot be opened under another**. Pass something
that names where the secret lives, and a ciphertext copied from one row to another stops
decrypting.

Without it, anyone who can write the column can move one user's stored token onto another
user's row and have Seer use it as that user's. Encryption alone does not stop that; the
binding does. An empty context is refused rather than silently binding to nothing.

### Configuration

```
SEER_ENCRYPTION_KEYS="v1:<base64 32 bytes>,v2:<base64 32 bytes>"
SEER_ENCRYPTION_ACTIVE_KEY="v2"
```

Mint a key with `openssl rand -base64 32`. Every misconfiguration — a missing variable, a
malformed pair, a short key, an active id naming a key that is not there — throws at the
point of use with the variable named, because the alternative is a column that quietly
cannot be decrypted months later.

### Rotating

1. Add the new key to `SEER_ENCRYPTION_KEYS`, leaving the old one in place.
2. Point `SEER_ENCRYPTION_ACTIVE_KEY` at it. New writes seal under the new key immediately;
   old rows keep opening under the old one.
3. Sweep stored rows through `rewrap(envelope, context)`, which is idempotent and a no-op
   on rows already moved. `keyIdOf(envelope)` reads which key a row names without
   decrypting it, so the sweep can find its work.
4. Only once no row names the old key, remove it.

**A key still named by any stored envelope must stay configured.** Removing it early is not
a security improvement, it is data loss, and `open` says so by name rather than reporting
what looks like corruption.

### What this is not

- **Not a KMS.** The KEK is an environment variable, so the trust boundary is the host:
  anyone who can read the environment can decrypt. That is a deliberate trade for now. The
  format version byte is what lets a KMS-backed KEK arrive later without invalidating a
  single stored envelope.
- **Not authorization.** `context` binds a ciphertext to a location. It does not decide who
  may ask for it; that is the caller's job, as it is everywhere else in this codebase.
- **Not a reason to store more.** The GitHub App deliberately stores no GitHub credential
  at all — its tokens are minted on demand and held in memory (see
  `docs/overseer/github-app.md`). That decision does not change now that encryption exists.
  Not storing a secret remains stronger than storing it well.

## A note on testing this module

Two of the first tests written for `envelope.ts` were vacuous, and it is worth recording
why, because both mistakes are easy to repeat.

**"Two seals of the same secret differ" does not test that the data key is fresh.** It
passes with a hardcoded data key, because the payload's IV is random by itself. The
freshness of the DEK has no black-box consequence at all, so it is tested white-box, by
unwrapping both data keys and comparing them.

**"The same key bytes under a different id are refused" does not test the id's
authentication.** The ring lookup refuses it first. Testing the binding needs an attacker
who *has* a key in the ring and relabels an envelope to name it.

Both were found by deliberately removing the property and checking the suite went red. That
is the standard for anything in this file: a security test that has never been seen to fail
is a security test that has not been run.
