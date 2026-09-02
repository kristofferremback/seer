import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import {
  getGithubUserCredential,
  listGithubUserCredentials,
  type GithubUserCredential,
} from "./user-credentials";

export interface GithubCredentialChoice {
  value: string;
  label: string;
  account: string;
}

function valueFor(userId: string, credentialId: string): string {
  const digest = createHmac("sha256", config.sessionSecret)
    .update(`github_projection:${userId}:${credentialId}`)
    .digest("base64url");
  return `github_${digest}`;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function usable(row: GithubUserCredential, now = Date.now()): boolean {
  return row.revoked_at === null && row.dead_at === null &&
    (row.expires_at === null || row.expires_at > now);
}

export function githubCredentialChoices(userId: string, now = Date.now()): GithubCredentialChoice[] {
  const rows = listGithubUserCredentials(userId).filter((row) => usable(row, now));
  const base = (row: GithubUserCredential) => row.label.trim() === "" ? row.account_login : `${row.account_login} · ${row.label}`;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(base(row), (counts.get(base(row)) ?? 0) + 1);
  return rows.map((row, index) => ({
    value: valueFor(userId, row.id),
    label: counts.get(base(row)) === 1 ? base(row) : `${base(row)} · connection ${index + 1}`,
    account: row.account_login,
  }));
}

/** Resolve an opaque form choice by walking only the asking member's live rows. The
 * internal credential id never has to cross an HTML or JSON boundary. */
export function resolveGithubCredentialChoice(
  userId: string,
  value: unknown,
  now = Date.now(),
): GithubUserCredential | null {
  if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  for (const row of listGithubUserCredentials(userId)) {
    if (usable(row, now) && same(value, valueFor(userId, row.id))) return row;
  }
  return null;
}

export function githubCredentialLabel(userId: string, credentialId: string): string | null {
  const row = getGithubUserCredential(credentialId, userId);
  if (!row) return null;
  return row.label.trim() === "" ? row.account_login : `${row.account_login} · ${row.label}`;
}

export function githubCredentialChoice(userId: string, credentialId: string): string | null {
  return getGithubUserCredential(credentialId, userId) ? valueFor(userId, credentialId) : null;
}
