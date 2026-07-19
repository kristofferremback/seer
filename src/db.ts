import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { hashKey, keyHint, newApiKey, tinyId } from "./ids";

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "seer.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");

// The v1 schema is created and populated by src/migrate.ts, which runs once at
// startup before the server binds. This module only opens the connection and
// exposes workspace-scoped query helpers; every bundle/version row is keyed by
// its owning workspace.

export interface Workspace {
  id: string;
  name: string;
  visibility: "public" | "private";
  created_at: number;
}

export function getWorkspace(id: string): Workspace | null {
  return db
    .query<Workspace, [string]>("SELECT * FROM workspaces WHERE id = ?")
    .get(id);
}

/** Every workspace the user belongs to, oldest membership first — the ledger grouping. */
export function listUserWorkspaces(userId: string): Workspace[] {
  return db
    .query<Workspace, [string]>(
      "SELECT w.id, w.name, w.visibility, w.created_at FROM memberships m " +
        "JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at ASC",
    )
    .all(userId);
}

/** A user by id — the inviter behind an invite, for the invite page. */
export function getUser(id: string): { id: string; email: string } | null {
  return db
    .query<{ id: string; email: string }, [string]>("SELECT id, email FROM users WHERE id = ?")
    .get(id);
}

/** Membership is the private-workspace access gate; all members are equal. */
export function isMember(wsId: string, userId: string): boolean {
  return !!db
    .query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM memberships WHERE workspace_id = ? AND user_id = ?",
    )
    .get(wsId, userId);
}

export interface Bundle {
  workspace_id: string;
  slug: string;
  created_at: number;
  latest_version: number;
}

export interface Version {
  workspace_id: string;
  slug: string;
  version: number;
  created_at: number;
  bytes: number;
  file_count: number;
}

export function getBundle(wsId: string, slug: string): Bundle | null {
  return db
    .query<Bundle, [string, string]>(
      "SELECT * FROM bundles WHERE workspace_id = ? AND slug = ?",
    )
    .get(wsId, slug);
}

export function listBundles(wsId: string): Bundle[] {
  return db
    .query<Bundle, [string]>(
      "SELECT * FROM bundles WHERE workspace_id = ? ORDER BY created_at DESC",
    )
    .all(wsId);
}

export function getVersion(wsId: string, slug: string, version: number): Version | null {
  return db
    .query<Version, [string, string, number]>(
      "SELECT * FROM versions WHERE workspace_id = ? AND slug = ? AND version = ?",
    )
    .get(wsId, slug, version);
}

export function listVersions(wsId: string, slug: string): Version[] {
  return db
    .query<Version, [string, string]>(
      "SELECT * FROM versions WHERE workspace_id = ? AND slug = ? ORDER BY version DESC",
    )
    .all(wsId, slug);
}

export const createVersion = db.transaction(
  (wsId: string, slug: string, bytes: number, fileCount: number): number => {
    const now = Date.now();
    const existing = getBundle(wsId, slug);
    const version = (existing?.latest_version ?? 0) + 1;
    if (existing) {
      db.run("UPDATE bundles SET latest_version = ? WHERE workspace_id = ? AND slug = ?", [
        version,
        wsId,
        slug,
      ]);
    } else {
      db.run(
        "INSERT INTO bundles (workspace_id, slug, created_at, latest_version) VALUES (?, ?, ?, ?)",
        [wsId, slug, now, version],
      );
    }
    db.run(
      "INSERT INTO versions (workspace_id, slug, version, created_at, bytes, file_count) VALUES (?, ?, ?, ?, ?, ?)",
      [wsId, slug, version, now, bytes, fileCount],
    );
    return version;
  },
);

// ---- images ----

// A single immutable image file. The id doubles as the URL capability: 50 random
// bits, never reused, so a private workspace's image URL is unguessable.
export interface Image {
  id: string;
  workspace_id: string;
  filename: string;
  content_type: string;
  bytes: number;
  created_at: number;
}

export function getImage(id: string): Image | null {
  return db.query<Image, [string]>("SELECT * FROM images WHERE id = ?").get(id);
}

export function listImages(wsId: string): Image[] {
  return db
    .query<Image, [string]>(
      "SELECT * FROM images WHERE workspace_id = ? ORDER BY created_at DESC",
    )
    .all(wsId);
}

export function createImage(
  wsId: string,
  filename: string,
  contentType: string,
  bytes: number,
): string {
  const id = tinyId("img");
  db.run(
    "INSERT INTO images (id, workspace_id, filename, content_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, wsId, filename, contentType, bytes, Date.now()],
  );
  return id;
}

// ---- workspaces, members (mutations) ----

/** Create a public workspace and seat its creator as a member. Returns the ws id. */
export const createWorkspace = db.transaction((name: string, userId: string): string => {
  const id = tinyId("ws");
  const now = Date.now();
  db.run("INSERT INTO workspaces (id, name, visibility, created_at) VALUES (?, ?, 'public', ?)", [
    id,
    name,
    now,
  ]);
  db.run("INSERT INTO memberships (workspace_id, user_id, created_at) VALUES (?, ?, ?)", [
    id,
    userId,
    now,
  ]);
  return id;
}) as (name: string, userId: string) => string;

export function setWorkspaceName(wsId: string, name: string): void {
  db.run("UPDATE workspaces SET name = ? WHERE id = ?", [name, wsId]);
}

export function setWorkspaceVisibility(wsId: string, visibility: "public" | "private"): void {
  db.run("UPDATE workspaces SET visibility = ? WHERE id = ?", [visibility, wsId]);
}

export interface Member {
  id: string;
  email: string;
  created_at: number;
}

export function listMembers(wsId: string): Member[] {
  return db
    .query<Member, [string]>(
      "SELECT u.id, u.email, m.created_at FROM memberships m " +
        "JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC",
    )
    .all(wsId);
}

// ---- api keys (mutations) ----

export interface ApiKeyRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  token_hint: string;
  is_legacy: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const KEY_COLS =
  "id, user_id, workspace_id, name, token_hint, is_legacy, created_at, last_used_at, revoked_at";

/** A member's still-live keys in one workspace, newest first. Revoked keys are hidden. */
export function listUserKeys(userId: string, wsId: string): ApiKeyRow[] {
  return db
    .query<ApiKeyRow, [string, string]>(
      `SELECT ${KEY_COLS} FROM api_keys WHERE user_id = ? AND workspace_id = ? ` +
        "AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .all(userId, wsId);
}

export function getApiKey(keyId: string): ApiKeyRow | null {
  return db
    .query<ApiKeyRow, [string]>(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`)
    .get(keyId);
}

/** Mint a fresh key. Only the token_hash and hint are stored; the raw token is
 *  returned once for a one-time reveal and never recoverable after. */
export function mintApiKey(
  userId: string,
  wsId: string,
  name: string,
): { id: string; token: string } {
  const token = newApiKey();
  const id = tinyId("key");
  db.run(
    "INSERT INTO api_keys (id, user_id, workspace_id, name, token_hash, token_hint, is_legacy, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    [id, userId, wsId, name, hashKey(token), keyHint(token), Date.now()],
  );
  return { id, token };
}

export function revokeApiKey(keyId: string): void {
  db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
    Date.now(),
    keyId,
  ]);
}

/** Roll a key: revoke it and mint a replacement with the same name in one breath.
 *  Returns the new key, or null if the key is not the caller's in this workspace. */
export const rollApiKey = db.transaction(
  (keyId: string, userId: string, wsId: string): { id: string; token: string } | null => {
    const key = getApiKey(keyId);
    // A dead key must not be rollable — a double-submitted roll would otherwise
    // silently mint an extra live key.
    if (!key || key.user_id !== userId || key.workspace_id !== wsId || key.revoked_at !== null) {
      return null;
    }
    db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
      Date.now(),
      keyId,
    ]);
    return mintApiKey(userId, wsId, key.name);
  },
) as (keyId: string, userId: string, wsId: string) => { id: string; token: string } | null;

// ---- invites (mutations) ----

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createInvite(wsId: string, userId: string): { token: string; expiresAt: number } {
  const token = tinyId("inv");
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  db.run(
    "INSERT INTO invites (token, workspace_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [token, wsId, userId, now, expiresAt],
  );
  return { token, expiresAt };
}

// ---- meta ----

export function getMeta(key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
}

/** The bootstrap workspace that adopted the pre-multi-user deployment's bundles. */
export function legacyWorkspaceId(): string | null {
  return getMeta("legacy_workspace_id");
}
