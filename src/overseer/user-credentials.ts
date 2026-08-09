import { db } from "../db";
import { open, seal } from "../envelope";
import { tinyId } from "../ids";

export type GithubUserCredentialKind = "oauth" | "pat";

export interface GithubUserCredential {
  id: string;
  user_id: string;
  kind: GithubUserCredentialKind;
  label: string;
  account_login: string;
  account_id: number;
  scopes: string[];
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  dead_at: number | null;
}

interface StoredCredential extends Omit<GithubUserCredential, "scopes"> {
  secret: string;
  scopes: string;
}

// Deliberately WITHOUT `secret`. Every read that is not a decrypt selects these, so
// the ciphertext never enters a row that a caller could pass onward by accident. The
// previous shape selected it and dropped it one destructure later in publicRow, which
// worked and relied on remembering: a field added to that type, or a caller reaching
// for StoredCredential directly, would have carried it out of this module. Not
// fetching what must not be shown is the version that cannot be forgotten.
//
// The token itself is never in any of this either way: the column holds an envelope,
// and openGithubUserCredential is the only thing that opens one.
const COLUMNS =
  "id, user_id, kind, label, account_login, account_id, scopes, expires_at, " +
  "created_at, last_used_at, revoked_at, dead_at";

/** The write side, which is the only place the envelope belongs. Kept separate from
 *  COLUMNS rather than derived from it, so that widening one cannot silently widen the
 *  other -- they are different lists for a reason and the reason is one-directional. */
const INSERT_COLUMNS =
  "id, user_id, kind, label, secret, account_login, account_id, scopes, expires_at, " +
  "created_at, last_used_at, revoked_at, dead_at";

function context(id: string, userId: string): string {
  return `github_cred:${id}:${userId}`;
}

function publicRow(row: Omit<StoredCredential, "secret">): GithubUserCredential {
  const { scopes, ...credential } = row;
  return { ...credential, scopes: JSON.parse(scopes) as string[] };
}

export function createGithubUserCredential(input: {
  userId: string;
  kind: GithubUserCredentialKind;
  label: string;
  secret: string;
  accountLogin: string;
  accountId: number;
  scopes: string[];
  expiresAt?: number | null;
}): string {
  const id = tinyId("guc");
  const encrypted = seal(input.secret, context(id, input.userId));
  db.run(
    `INSERT INTO github_user_credentials (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    [
      id,
      input.userId,
      input.kind,
      input.label,
      encrypted,
      input.accountLogin,
      input.accountId,
      JSON.stringify(input.scopes),
      input.expiresAt ?? null,
      Date.now(),
    ],
  );
  return id;
}

export function getGithubUserCredential(id: string, userId: string): GithubUserCredential | null {
  const row = db
    .query<Omit<StoredCredential, "secret">, [string, string]>(
      `SELECT ${COLUMNS} FROM github_user_credentials WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  return row ? publicRow(row) : null;
}

export function listGithubUserCredentials(userId: string): GithubUserCredential[] {
  return db
    .query<Omit<StoredCredential, "secret">, [string]>(
      `SELECT ${COLUMNS} FROM github_user_credentials WHERE user_id = ? AND revoked_at IS NULL ` +
        "AND dead_at IS NULL " +
        "ORDER BY created_at DESC, id DESC",
    )
    .all(userId)
    .map(publicRow);
}

/** What settings shows: everything the person has not revoked themselves, including the
 *  ones GitHub has since refused. A credential that stopped working is exactly what they
 *  came to the page to find out about, so routing's live list is the wrong one here. */
export function listGithubUserCredentialsForSettings(userId: string): GithubUserCredential[] {
  return db
    .query<Omit<StoredCredential, "secret">, [string]>(
      `SELECT ${COLUMNS} FROM github_user_credentials WHERE user_id = ? AND revoked_at IS NULL ` +
        "ORDER BY created_at DESC, id DESC",
    )
    .all(userId)
    .map(publicRow);
}

/** Decrypt only after an owner-scoped lookup; revoked credentials are not usable. */
export function openGithubUserCredential(id: string, userId: string): string | null {
  const row = db
    .query<{ secret: string }, [string, string]>(
      "SELECT secret FROM github_user_credentials " +
        "WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .get(id, userId);
  return row ? open(row.secret, context(id, userId)) : null;
}

export function touchGithubUserCredential(id: string, userId: string, usedAt = Date.now()): boolean {
  return (
    db.run(
      "UPDATE github_user_credentials SET last_used_at = ? " +
        "WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      [usedAt, id, userId],
    ).changes === 1
  );
}

/** GitHub answered 401 through this credential, so it is revoked or expired at the far
 *  end. The row stays: settings shows it, with the state, so the person knows which of
 *  their credentials stopped working and why. The live listing routing walks drops it;
 *  the settings listing and the single-row read still return it. */
export function markGithubUserCredentialDead(id: string, userId: string, at = Date.now()): boolean {
  return (
    db.run(
      "UPDATE github_user_credentials SET dead_at = ? WHERE id = ? AND user_id = ? AND dead_at IS NULL",
      [at, id, userId],
    ).changes === 1
  );
}

export function revokeGithubUserCredential(id: string, userId: string): boolean {
  return (
    db.run(
      "UPDATE github_user_credentials SET revoked_at = ? " +
        "WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      [Date.now(), id, userId],
    ).changes === 1
  );
}
