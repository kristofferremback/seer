import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "seer.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");

// The v1 schema is created and populated by src/migrate.ts, which runs once at
// startup before the server binds. This module only opens the connection and
// exposes workspace-scoped query helpers; every bundle/version row is keyed by
// its owning workspace.

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
