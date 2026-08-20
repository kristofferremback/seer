import { createHash, randomBytes } from "node:crypto";

// Crockford base32, lowercase, ambiguous letters (i, l, o, u) removed. 32 chars,
// so 256 % 32 === 0 and a `byte % 32` map is unbiased over randomBytes.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** `<prefix>_` + 10 Crockford chars (50 random bits). */
export function tinyId(prefix: string): string {
  const bytes = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[bytes[i]! % 32];
  return `${prefix}_${s}`;
}

/** A fresh agent-facing API key token: `seer_sk_` + 32 url-safe base64 chars. */
export function newApiKey(): string {
  return `seer_sk_${randomBytes(24).toString("base64url")}`;
}

/** A fresh share token: `seer_sh_` + 32 url-safe base64 chars. Same entropy and the
 *  same hashing as an API key, because it is the same kind of secret: the row's
 *  identity, shown once at mint and stored only as its hash. */
export function newShareToken(): string {
  return `seer_sh_${randomBytes(24).toString("base64url")}`;
}

/** SHA-256 hex of the exact full token string; what we store and index on. */
export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Display hint: first 12 + `····` + last 4, e.g. `seer_sk_9f3K····sD2e`. */
export function keyHint(token: string): string {
  return `${token.slice(0, 12)}····${token.slice(-4)}`;
}

// Route matching validates ids against these before touching the db.
const TINY = "[0-9abcdefghjkmnpqrstvwxyz]{10}";
export const USR_ID_RE = new RegExp(`^usr_${TINY}$`);
export const WS_ID_RE = new RegExp(`^ws_${TINY}$`);
export const INV_ID_RE = new RegExp(`^inv_${TINY}$`);
export const KEY_ID_RE = new RegExp(`^key_${TINY}$`);
export const IMG_ID_RE = new RegExp(`^img_${TINY}$`);
export const REV_ID_RE = new RegExp(`^rev_${TINY}$`);
export const ANN_ID_RE = new RegExp(`^ann_${TINY}$`);
export const ATT_ID_RE = new RegExp(`^att_${TINY}$`);
export const SHR_ID_RE = new RegExp(`^shr_${TINY}$`);
export const PRJ_ID_RE = new RegExp(`^prj_${TINY}$`);
export const TSK_ID_RE = new RegExp(`^tsk_${TINY}$`);
export const API_KEY_RE = /^seer_sk_[A-Za-z0-9_-]{32}$/;
export const SHARE_TOKEN_RE = /^seer_sh_[A-Za-z0-9_-]{32}$/;

/** What a bundle, a review and a share target may be called. Not an id — the publisher
 *  chooses it — but it is matched in the same places and by the same rule, and the API
 *  document states this pattern to callers, so it lives beside them. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
