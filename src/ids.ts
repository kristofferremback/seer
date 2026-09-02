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
export const STG_ID_RE = new RegExp(`^stg_${TINY}$`);
export const STA_ID_RE = new RegExp(`^sta_${TINY}$`);
export const STF_ID_RE = new RegExp(`^stf_${TINY}$`);
export const STI_ID_RE = new RegExp(`^sti_${TINY}$`);
// A promoted review: the lineage, one source revision of it, one account published over
// a revision, and the witness request that is waiting to become that account.
export const RLN_ID_RE = new RegExp(`^rln_${TINY}$`);
export const RVR_ID_RE = new RegExp(`^rvr_${TINY}$`);
export const RAC_ID_RE = new RegExp(`^rac_${TINY}$`);
export const WTR_ID_RE = new RegExp(`^wtr_${TINY}$`);
// A pull request joined to a lineage: one immutable observation of it, and the capture
// job that turns an observation into a source revision.
export const POB_ID_RE = new RegExp(`^pob_${TINY}$`);
export const RCJ_ID_RE = new RegExp(`^rcj_${TINY}$`);
// A stack of promoted reviews: the stack, one immutable manifest of it, one account over a
// manifest, the witness request waiting to become that account, one receipt-owned stack
// observation, and the installation-owned refresh job it queues. Each prefix is its own,
// so no stack route can resolve a row of another table.
export const RSK_ID_RE = new RegExp(`^rsk_${TINY}$`);
export const RSM_ID_RE = new RegExp(`^rsm_${TINY}$`);
export const RSA_ID_RE = new RegExp(`^rsa_${TINY}$`);
export const RSW_ID_RE = new RegExp(`^rsw_${TINY}$`);
// One provider stack-membership reading from an accepted webhook receipt.
export const RSO_ID_RE = new RegExp(`^rso_${TINY}$`);
export const RSJ_ID_RE = new RegExp(`^rsj_${TINY}$`);
// Exact local conversation, imported GitHub identities and immutable observations.
export const RTH_ID_RE = new RegExp(`^rth_${TINY}$`);
export const RTE_ID_RE = new RegExp(`^rte_${TINY}$`);
export const RGT_ID_RE = new RegExp(`^rgt_${TINY}$`);
export const RGC_ID_RE = new RegExp(`^rgc_${TINY}$`);
export const RGR_ID_RE = new RegExp(`^rgr_${TINY}$`);
export const RGO_ID_RE = new RegExp(`^rgo_${TINY}$`);
export const RCI_ID_RE = new RegExp(`^rci_${TINY}$`);
// One member's immutable judgment over an exact revision or stack manifest.
export const RJD_ID_RE = new RegExp(`^rjd_${TINY}$`);
export const SJD_ID_RE = new RegExp(`^sjd_${TINY}$`);
// One permanent conversion of a legacy ReviewDoc into immutable review lineage work.
export const LSC_ID_RE = new RegExp(`^lsc_${TINY}$`);
// One durable personal GitHub projection job or explicit submission.
export const GVP_ID_RE = new RegExp(`^gvp_${TINY}$`);
export const GHS_ID_RE = new RegExp(`^ghs_${TINY}$`);
export const STAGE_CHANGE_ID_RE = /^chg_[a-f0-9]{64}$/;
/** A member's change or file inside a stack reader, namespaced by the member's position:
 *  canonical ids are content-derived and two layers can hold identical hunks. */
export const STACK_CHANGE_ID_RE = /^l[1-9][0-9]?-chg_[a-f0-9]{64}$/;
export const STACK_FILE_ID_RE = new RegExp(`^l[1-9][0-9]?-stf_${TINY}$`);
export const API_KEY_RE = /^seer_sk_[A-Za-z0-9_-]{32}$/;
export const SHARE_TOKEN_RE = /^seer_sh_[A-Za-z0-9_-]{32}$/;

/** What a bundle, a review and a share target may be called. Not an id — the publisher
 *  chooses it — but it is matched in the same places and by the same rule, and the API
 *  document states this pattern to callers, so it lives beside them. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
