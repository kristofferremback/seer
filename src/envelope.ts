// Envelope encryption: the one way Seer stores a secret it will need to read back.
//
// Everything Seer has stored until now is verify-only — API keys, share tokens, invite
// tokens. Those are hashed, and hashing is strictly better than encryption for them
// because there is nothing to leak and no key to lose. This module exists for the other
// kind: a credential a workspace hands Seer to *use on its behalf*, where the plaintext
// has to come back out. A user's GitHub personal access token is the first of those.
//
// The shape is the standard one, and the reason for it is key rotation. The secret is
// encrypted under a fresh single-use data key (a DEK); the DEK is encrypted under a
// long-lived key from the environment (a KEK); both ciphertexts travel together. Rotating
// the KEK then means re-wrapping DEKs, not re-encrypting every secret — and because the
// envelope names which KEK sealed it, old and new KEKs can be configured at once and a
// rotation needs no migration and no downtime.
//
// What this deliberately is NOT:
//
//   - It is not a hashing replacement. A secret Seer only ever *checks* must keep using
//     `hashKey`. Reversible storage is a cost, paid only where reading back is required.
//   - It is not a KMS. The KEK is an environment variable, which means the trust boundary
//     is the host: anyone who can read the environment can decrypt. That is a deliberate
//     trade for now, and the version byte below is what lets a KMS-backed KEK arrive later
//     without invalidating a single stored envelope.
//   - It is not authentication. `context` binds a ciphertext to where it lives, so a row
//     cannot be moved; it does not decide who may ask.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** AES-256-GCM everywhere: one algorithm, authenticated, no mode to choose wrongly. */
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

/**
 * Envelope format version. The first byte of every envelope, so the reader never guesses
 * at the layout. Bump it when the layout or the algorithm changes; `open` refuses a
 * version it does not know rather than misparsing one it half-recognises.
 */
const FORMAT_V1 = 0x01;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

// ---- the keyring ----
//
// Keys come from the environment as `id:base64key` pairs, and one id is active. Reading
// them at call time rather than at import keeps this module testable and keeps a missing
// key a loud failure at the moment it matters rather than a boot failure in every process
// that happens to import something that imports this.

export interface Keyring {
  /** The key new envelopes are sealed under. */
  activeId: string;
  /** Every key that can open an envelope, including retired ones. */
  keys: Map<string, Buffer>;
}

/** A key id is short, opaque and travels inside every envelope, so it is kept boring. */
const KEY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Parse `SEER_ENCRYPTION_KEYS` and `SEER_ENCRYPTION_ACTIVE_KEY`.
 *
 * ```
 * SEER_ENCRYPTION_KEYS="v1:<base64 32 bytes>,v2:<base64 32 bytes>"
 * SEER_ENCRYPTION_ACTIVE_KEY="v2"
 * ```
 *
 * Every failure here is a configuration mistake, and every one of them throws with the
 * variable named. A half-configured keyring that silently encrypts under the wrong key is
 * how you discover, months later, that a column cannot be decrypted.
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.SEER_ENCRYPTION_KEYS;
  if (!raw || raw.trim() === "") {
    throw new EnvelopeError(
      "SEER_ENCRYPTION_KEYS is not set. It holds the key-encryption keys, as " +
        'comma-separated "id:base64" pairs — e.g. SEER_ENCRYPTION_KEYS="v1:$(openssl rand -base64 32)".',
    );
  }

  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const cut = trimmed.indexOf(":");
    if (cut < 1) {
      throw new EnvelopeError(
        `SEER_ENCRYPTION_KEYS entry ${JSON.stringify(trimmed.slice(0, 24))} is malformed: expected "id:base64key".`,
      );
    }
    const id = trimmed.slice(0, cut);
    if (!KEY_ID_RE.test(id)) {
      throw new EnvelopeError(
        `SEER_ENCRYPTION_KEYS key id ${JSON.stringify(id)} is malformed: expected [a-z0-9][a-z0-9_-]{0,31}.`,
      );
    }
    if (keys.has(id)) {
      throw new EnvelopeError(`SEER_ENCRYPTION_KEYS names key id ${JSON.stringify(id)} twice.`);
    }
    const key = Buffer.from(trimmed.slice(cut + 1), "base64");
    if (key.length !== KEY_BYTES) {
      // Said in bytes rather than characters, because base64 length is not the thing wrong.
      throw new EnvelopeError(
        `SEER_ENCRYPTION_KEYS key ${JSON.stringify(id)} decodes to ${key.length} bytes; ${KEY_BYTES} are required.`,
      );
    }
    keys.set(id, key);
  }

  if (keys.size === 0) {
    throw new EnvelopeError("SEER_ENCRYPTION_KEYS is set but contains no keys.");
  }

  const activeId = env.SEER_ENCRYPTION_ACTIVE_KEY?.trim() || [...keys.keys()][0]!;
  if (!keys.has(activeId)) {
    throw new EnvelopeError(
      `SEER_ENCRYPTION_ACTIVE_KEY names ${JSON.stringify(activeId)}, which is not among the ` +
        `keys in SEER_ENCRYPTION_KEYS (${[...keys.keys()].join(", ")}).`,
    );
  }
  return { activeId, keys };
}

let cached: Keyring | null = null;

/** The process keyring, parsed once. */
export function keyring(): Keyring {
  cached ??= loadKeyring();
  return cached;
}

/** Tests install their own keyring; passing null makes the next call re-read the env. */
export function setKeyring(k: Keyring | null): void {
  cached = k;
}

/** A fresh 32-byte key, base64, for putting in the environment. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

// ---- seal and open ----
//
// Layout, all binary, base64url once at the end:
//
//   1  byte    format version
//   1  byte    key id length
//   n  bytes   key id, utf8
//   12 bytes   iv for the wrapped DEK
//   16 bytes   tag for the wrapped DEK
//   32 bytes   the DEK, encrypted under the KEK
//   12 bytes   iv for the payload
//   16 bytes   tag for the payload
//   rest       the payload, encrypted under the DEK
//
// Fixed-width fields in a fixed order, so parsing needs no length prefixes and a truncated
// envelope fails a length check rather than reading past its own end.

/**
 * Encrypt `plaintext`, bound to `context`.
 *
 * `context` is additional authenticated data: it is not stored in the envelope and not
 * secret, but an envelope sealed under one context cannot be opened under another. Pass
 * something that names where the secret lives — `"github_pat:usr_7c2k9"` — and a ciphertext
 * copied from one row to another stops decrypting. Without it, a database write is enough
 * to make one user's stored token answer for another's.
 */
export function seal(plaintext: string, context: string, ring: Keyring = keyring()): string {
  if (context === "") {
    throw new EnvelopeError(
      "seal() needs a non-empty context: it binds the ciphertext to where it is stored, " +
        "and an empty one binds it to nothing.",
    );
  }
  const kek = ring.keys.get(ring.activeId);
  if (!kek) {
    throw new EnvelopeError(`The active key ${JSON.stringify(ring.activeId)} is not in the keyring.`);
  }
  const idBytes = Buffer.from(ring.activeId, "utf8");
  if (idBytes.length > 255) {
    throw new EnvelopeError(`Key id ${JSON.stringify(ring.activeId)} is too long to encode.`);
  }

  // A fresh data key per secret. Two seals of the same plaintext under the same KEK
  // therefore share no bytes, which is the property that keeps a column from leaking
  // which rows hold equal values.
  const dek = randomBytes(KEY_BYTES);

  const dekIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv(ALGORITHM, kek, dekIv);
  // The key id is authenticated, so an envelope cannot be relabelled to point at a
  // different KEK without the tag failing.
  wrapper.setAAD(idBytes);
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
  const dekTag = wrapper.getAuthTag();

  const payloadIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, payloadIv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payloadTag = cipher.getAuthTag();

  // The data key exists only for this call; nothing downstream should be able to reach it.
  dek.fill(0);

  return Buffer.concat([
    Buffer.from([FORMAT_V1, idBytes.length]),
    idBytes,
    dekIv,
    dekTag,
    wrappedDek,
    payloadIv,
    payloadTag,
    payload,
  ]).toString("base64url");
}

/**
 * Decrypt an envelope produced by `seal`, under the same `context`.
 *
 * Throws `EnvelopeError` on anything wrong: a tampered byte, the wrong context, an unknown
 * key id, a truncated envelope. There is deliberately no "return null on failure" variant —
 * a caller that cannot tell a decryption failure from a legitimately absent secret will
 * eventually treat one as the other.
 */
export function open(envelope: string, context: string, ring: Keyring = keyring()): string {
  if (context === "") {
    throw new EnvelopeError("open() needs the same non-empty context the envelope was sealed with.");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(envelope, "base64url");
  } catch {
    throw new EnvelopeError("Envelope is not valid base64url.");
  }
  if (buf.length < 2) throw new EnvelopeError("Envelope is truncated: no header.");

  const version = buf[0]!;
  if (version !== FORMAT_V1) {
    throw new EnvelopeError(
      `Envelope format version ${version} is not one this build knows (expected ${FORMAT_V1}).`,
    );
  }

  const idLength = buf[1]!;
  const fixed = 2 + idLength + IV_BYTES + TAG_BYTES + KEY_BYTES + IV_BYTES + TAG_BYTES;
  if (buf.length < fixed) {
    throw new EnvelopeError(`Envelope is truncated: ${buf.length} bytes, at least ${fixed} required.`);
  }

  let at = 2;
  const idBytes = buf.subarray(at, (at += idLength));
  const keyId = idBytes.toString("utf8");
  const dekIv = buf.subarray(at, (at += IV_BYTES));
  const dekTag = buf.subarray(at, (at += TAG_BYTES));
  const wrappedDek = buf.subarray(at, (at += KEY_BYTES));
  const payloadIv = buf.subarray(at, (at += IV_BYTES));
  const payloadTag = buf.subarray(at, (at += TAG_BYTES));
  const payload = buf.subarray(at);

  const kek = ring.keys.get(keyId);
  if (!kek) {
    // Naming the id is safe — it is not a secret — and it is the only way a person can
    // tell "the key was retired too early" from "this ciphertext is corrupt".
    throw new EnvelopeError(
      `Envelope was sealed under key ${JSON.stringify(keyId)}, which is not in the keyring ` +
        `(${[...ring.keys.keys()].join(", ") || "empty"}). A key still named by stored ` +
        "envelopes must stay in SEER_ENCRYPTION_KEYS even after it stops being active.",
    );
  }

  let dek: Buffer;
  try {
    const unwrapper = createDecipheriv(ALGORITHM, kek, dekIv);
    unwrapper.setAAD(idBytes);
    unwrapper.setAuthTag(dekTag);
    dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()]);
  } catch {
    throw new EnvelopeError(
      `Envelope's data key does not authenticate under key ${JSON.stringify(keyId)}: ` +
        "the envelope was altered, or that key is not the one that sealed it.",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, dek, payloadIv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(payloadTag);
    const out = Buffer.concat([decipher.update(payload), decipher.final()]);
    return out.toString("utf8");
  } catch {
    throw new EnvelopeError(
      "Envelope does not authenticate: it was altered, or the context does not match the " +
        "one it was sealed with.",
    );
  } finally {
    dek.fill(0);
  }
}

/** The key id an envelope names, without decrypting it. What a re-wrap sweep reads. */
export function keyIdOf(envelope: string): string {
  const buf = Buffer.from(envelope, "base64url");
  if (buf.length < 2 || buf[0] !== FORMAT_V1) {
    throw new EnvelopeError("Envelope is not a readable v1 envelope.");
  }
  const idLength = buf[1]!;
  if (buf.length < 2 + idLength) throw new EnvelopeError("Envelope is truncated inside its key id.");
  return buf.subarray(2, 2 + idLength).toString("utf8");
}

/**
 * Re-seal an envelope under the active key. The plaintext is decrypted and encrypted
 * again, so this is what a rotation sweep calls, row by row, after a new active key is
 * configured and before the old one is removed from the keyring.
 *
 * Returns the envelope unchanged when it already names the active key, so a sweep can be
 * run repeatedly and over rows it has already done.
 */
export function rewrap(envelope: string, context: string, ring: Keyring = keyring()): string {
  if (keyIdOf(envelope) === ring.activeId) return envelope;
  return seal(open(envelope, context, ring), context, ring);
}

/** Constant-time equality for two secrets held as strings. Here because everything that
 *  compares a decrypted secret should reach for this rather than `===`. */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
