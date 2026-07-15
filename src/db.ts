import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "seer.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS bundles (
    slug TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    latest_version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    PRIMARY KEY (slug, version)
  );
`);

export interface Bundle {
  slug: string;
  created_at: number;
  latest_version: number;
}

export interface Version {
  slug: string;
  version: number;
  created_at: number;
  bytes: number;
  file_count: number;
}

export function getBundle(slug: string): Bundle | null {
  return db.query<Bundle, [string]>("SELECT * FROM bundles WHERE slug = ?").get(slug);
}

export function listBundles(): Bundle[] {
  return db.query<Bundle, []>("SELECT * FROM bundles ORDER BY created_at DESC").all();
}

export function listVersions(slug: string): Version[] {
  return db
    .query<Version, [string]>("SELECT * FROM versions WHERE slug = ? ORDER BY version DESC")
    .all(slug);
}

export const createVersion = db.transaction(
  (slug: string, bytes: number, fileCount: number): number => {
    const now = Date.now();
    const existing = getBundle(slug);
    const version = (existing?.latest_version ?? 0) + 1;
    if (existing) {
      db.run("UPDATE bundles SET latest_version = ? WHERE slug = ?", [version, slug]);
    } else {
      db.run("INSERT INTO bundles (slug, created_at, latest_version) VALUES (?, ?, ?)", [
        slug,
        now,
        version,
      ]);
    }
    db.run(
      "INSERT INTO versions (slug, version, created_at, bytes, file_count) VALUES (?, ?, ?, ?, ?)",
      [slug, version, now, bytes, fileCount],
    );
    return version;
  },
);
