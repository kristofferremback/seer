// Standalone SQLite snapshot, verification, and restore commands.
//
// This file intentionally imports neither config.ts nor db.ts. Operators must be able to
// restore an older database while the application image or its secrets are broken. The
// only environment input is DATA_DIR; every other path is an explicit argument.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertNoFreshServiceHeartbeat,
  SERVICE_HEARTBEAT_STALE_MS,
} from "./service-heartbeat";

export interface SnapshotManifest {
  format: 1;
  userVersion: number;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface VerifiedSnapshot {
  path: string;
  manifestPath: string;
  userVersion: number;
  bytes: number;
  sha256: string;
  integrity: "ok";
}

export interface RestoredSnapshot extends VerifiedSnapshot {
  databasePath: string;
  quarantinePath: string;
}

function dataDirectory(): string {
  const raw = process.env.DATA_DIR?.trim();
  return resolve(raw && raw !== "" ? raw : "./data");
}

function databasePath(directory: string = dataDirectory()): string {
  return join(directory, "seer.db");
}

function manifestPath(snapshotPath: string): string {
  return `${snapshotPath}.json`;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempPath(destination: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeTemp(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function quickCheck(database: Database): void {
  const rows = database.query<Record<string, unknown>, []>("PRAGMA quick_check").all();
  const values = rows.flatMap((row) => Object.values(row));
  if (values.length !== 1 || values[0] !== "ok") {
    throw new Error(`SQLite quick_check failed: ${values.map(String).join("; ") || "no result"}`);
  }
}

function userVersion(database: Database): number {
  const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  if (!row || !Number.isInteger(row.user_version) || row.user_version < 0) {
    throw new Error("SQLite user_version is not readable");
  }
  return row.user_version;
}

type SidecarPresence = { wal: boolean; shm: boolean };

function sidecarPresence(path: string): SidecarPresence {
  return { wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
}

/** Remove only sidecars this process created while inspecting a standalone copy. */
function cleanCreatedReadonlySidecars(path: string, before: SidecarPresence): void {
  if (!before.wal && existsSync(`${path}-wal`)) unlinkSync(`${path}-wal`);
  if (!before.shm && existsSync(`${path}-shm`)) unlinkSync(`${path}-shm`);
}

function inspectDatabase(
  path: string,
  cleanCreatedSidecars: boolean = true,
): { userVersion: number; bytes: number; serialized: Uint8Array } {
  const before = sidecarPresence(path);
  let database: Database | null = null;
  try {
    database = new Database(path, { readonly: true });
    quickCheck(database);
    return {
      userVersion: userVersion(database),
      bytes: statSync(path).size,
      serialized: new Uint8Array(database.serialize()),
    };
  } finally {
    try {
      database?.close();
    } finally {
      if (cleanCreatedSidecars) cleanCreatedReadonlySidecars(path, before);
    }
  }
}

/** Take one sqlite3_serialize snapshot from a read transaction while WAL writers continue. */
export function backupDatabase(destination: string, directory: string = dataDirectory()): VerifiedSnapshot {
  const target = resolve(destination);
  const targetManifest = manifestPath(target);
  const source = databasePath(resolve(directory));
  if (target === source || targetManifest === source) {
    throw new Error("Snapshot destination must not be the live seer.db path");
  }
  if (existsSync(target) || existsSync(targetManifest)) {
    throw new Error(`Refusing to overwrite existing snapshot or manifest at ${target}`);
  }
  if (!existsSync(source)) throw new Error(`No live database at ${source}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  let database: Database | null = null;
  let serialized: Uint8Array;
  try {
    database = new Database(source, { readonly: true });
    database.run("BEGIN");
    quickCheck(database);
    serialized = new Uint8Array(database.serialize());
    database.run("COMMIT");
  } catch (error) {
    try { database?.run("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database?.close();
  }

  const snapshotTemp = tempPath(target);
  const manifestTemp = tempPath(targetManifest);
  let snapshotRenamed = false;
  try {
    writeTemp(snapshotTemp, serialized);
    const inspected = inspectDatabase(snapshotTemp);
    const sha256 = hash(serialized);
    const manifest: SnapshotManifest = {
      format: 1,
      userVersion: inspected.userVersion,
      bytes: serialized.byteLength,
      sha256,
      createdAt: new Date().toISOString(),
    };
    writeTemp(manifestTemp, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    renameSync(snapshotTemp, target);
    snapshotRenamed = true;
    renameSync(manifestTemp, targetManifest);
    syncDirectory(dirname(target));
    return {
      path: target,
      manifestPath: targetManifest,
      userVersion: inspected.userVersion,
      bytes: serialized.byteLength,
      sha256,
      integrity: "ok",
    };
  } catch (error) {
    if (existsSync(snapshotTemp)) unlinkSync(snapshotTemp);
    if (existsSync(manifestTemp)) unlinkSync(manifestTemp);
    if (snapshotRenamed && existsSync(target) && !existsSync(targetManifest)) unlinkSync(target);
    throw error;
  }
}

function readManifest(path: string): SnapshotManifest {
  const sibling = manifestPath(path);
  if (!existsSync(sibling)) throw new Error(`Snapshot manifest is missing: ${sibling}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(sibling, "utf8"));
  } catch (error) {
    throw new Error(`Snapshot manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Snapshot manifest is not an object");
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["bytes", "createdAt", "format", "sha256", "userVersion"])) {
    throw new Error("Snapshot manifest has an unsupported shape");
  }
  if (manifest.format !== 1 || !Number.isInteger(manifest.userVersion) || (manifest.userVersion as number) < 0 ||
      !Number.isInteger(manifest.bytes) || (manifest.bytes as number) < 1 ||
      typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("Snapshot manifest has invalid values");
  }
  return manifest as unknown as SnapshotManifest;
}

/** Verify manifest identity and SQLite integrity without loading application secrets. */
export function verifySnapshot(snapshot: string): VerifiedSnapshot {
  const path = resolve(snapshot);
  const before = sidecarPresence(path);
  try {
    if (!existsSync(path)) throw new Error(`Snapshot does not exist: ${path}`);
    const manifest = readManifest(path);
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.byteLength !== manifest.bytes) {
      throw new Error(`Snapshot byte length mismatch: manifest ${manifest.bytes}, file ${bytes.byteLength}`);
    }
    const sha256 = hash(bytes);
    if (sha256 !== manifest.sha256) throw new Error("Snapshot SHA-256 does not match its manifest");
    const inspected = inspectDatabase(path);
    if (inspected.userVersion !== manifest.userVersion) {
      throw new Error(`Snapshot user_version mismatch: manifest ${manifest.userVersion}, database ${inspected.userVersion}`);
    }
    return {
      path,
      manifestPath: manifestPath(path),
      userVersion: inspected.userVersion,
      bytes: bytes.byteLength,
      sha256,
      integrity: "ok",
    };
  } finally {
    cleanCreatedReadonlySidecars(path, before);
  }
}

function quarantineName(): string {
  return `restore-quarantine-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(4).toString("hex")}`;
}

const RESTORE_STATE_FILE = ".seer-restore-state.json";

type RestorePhase = "prepared" | "completed";

interface RestoreState {
  format: 1;
  phase: RestorePhase;
  snapshotPath: string;
  snapshotSha256: string;
  snapshotBytes: number;
  snapshotUserVersion: number;
  quarantinePath: string;
  preparedAt: string;
  completedAt: string | null;
}

export interface RestoreSafetyOptions {
  /** Test seam for proving a stopped marker has crossed the production stale bound. */
  now?: number;
  heartbeatStaleMs?: number;
}

function statePath(directory: string): string {
  return join(directory, RESTORE_STATE_FILE);
}

function readRestoreState(directory: string): RestoreState | null {
  const path = statePath(directory);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Restore state ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Restore state ${path} has an invalid shape`);
  const row = value as Record<string, unknown>;
  if (row.format !== 1 || (row.phase !== "prepared" && row.phase !== "completed") ||
      typeof row.snapshotPath !== "string" || typeof row.snapshotSha256 !== "string" ||
      !Number.isInteger(row.snapshotBytes) || !Number.isInteger(row.snapshotUserVersion) ||
      typeof row.quarantinePath !== "string" || typeof row.preparedAt !== "string" ||
      !(typeof row.completedAt === "string" || row.completedAt === null)) {
    throw new Error(`Restore state ${path} has invalid values`);
  }
  return row as unknown as RestoreState;
}

function writeRestoreState(directory: string, state: RestoreState): void {
  const path = statePath(directory);
  const temp = tempPath(path);
  try {
    writeTemp(temp, new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`));
    renameSync(temp, path);
    syncDirectory(directory);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function assertSameRestore(state: RestoreState, verified: VerifiedSnapshot, directory: string): void {
  if (state.snapshotPath !== verified.path || state.snapshotSha256 !== verified.sha256 ||
      state.snapshotBytes !== verified.bytes || state.snapshotUserVersion !== verified.userVersion) {
    throw new Error(
      `Restore state ${statePath(directory)} belongs to another snapshot. Archive it only after the prior maintenance operation is resolved.`,
    );
  }
  if (dirname(state.quarantinePath) !== directory || !basename(state.quarantinePath).startsWith("restore-quarantine-")) {
    throw new Error(`Restore state ${statePath(directory)} names an invalid quarantine path`);
  }
}

function liveMatchesSnapshot(live: string, verified: VerifiedSnapshot): boolean {
  if (!existsSync(live)) return false;
  const bytes = new Uint8Array(readFileSync(live));
  if (bytes.byteLength !== verified.bytes || hash(bytes) !== verified.sha256) return false;

  // The main file may still equal the snapshot while a hot WAL holds later writes.
  // Compare SQLite's complete serialized view before treating a restart as an already
  // completed restore. Remove only inspection-created sidecars; a pre-existing WAL is
  // retained even when it makes no logical change, because it is operator evidence.
  const before = sidecarPresence(live);
  const inspected = inspectDatabase(live, false);
  const matches = inspected.userVersion === verified.userVersion &&
    inspected.serialized.byteLength === verified.bytes &&
    hash(inspected.serialized) === verified.sha256;
  if (matches) cleanCreatedReadonlySidecars(live, before);
  return matches;
}

/** Restore only after the caller has stopped every service replica. The confirmation
 * flag cannot bypass a fresh shared-volume heartbeat. A durable prepared/completed state
 * makes a maintenance-container restart resume or replay the same operation, never
 * quarantine the restored database a second time. */
export function restoreDatabase(
  snapshot: string,
  confirmedStopped: boolean,
  dataDir: string = dataDirectory(),
  safety: RestoreSafetyOptions = {},
): RestoredSnapshot {
  if (!confirmedStopped) {
    throw new Error("Restore requires --confirm-service-stopped after every service replica is at zero");
  }
  const directory = resolve(dataDir);
  const live = databasePath(directory);
  if (resolve(snapshot) === live) throw new Error("Cannot restore seer.db from itself");
  const verified = verifySnapshot(snapshot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safetyNow = safety.now ?? Date.now();
  const staleMs = safety.heartbeatStaleMs ?? SERVICE_HEARTBEAT_STALE_MS;
  assertNoFreshServiceHeartbeat(directory, safetyNow, staleMs);

  let state = readRestoreState(directory);
  let createdState = false;
  if (state) {
    assertSameRestore(state, verified, directory);
    if (state.phase === "completed") {
      if (!liveMatchesSnapshot(live, verified)) {
        throw new Error("The completed restore state exists, but seer.db no longer matches that snapshot. Refusing to rerun it.");
      }
      return { ...verified, databasePath: live, quarantinePath: state.quarantinePath };
    }
  } else {
    const quarantinePath = join(directory, quarantineName());
    mkdirSync(quarantinePath, { mode: 0o700 });
    state = {
      format: 1,
      phase: "prepared",
      snapshotPath: verified.path,
      snapshotSha256: verified.sha256,
      snapshotBytes: verified.bytes,
      snapshotUserVersion: verified.userVersion,
      quarantinePath,
      preparedAt: new Date().toISOString(),
      completedAt: null,
    };
    try {
      writeRestoreState(directory, state);
      createdState = true;
    } catch (error) {
      try { rmdirSync(quarantinePath); } catch {}
      throw error;
    }
  }

  const quarantine = state.quarantinePath;
  if (!existsSync(quarantine)) throw new Error(`Prepared restore quarantine is missing: ${quarantine}`);
  const moved: { from: string; to: string }[] = [];
  const liveFiles = [live, `${live}-wal`, `${live}-shm`];
  let installed = false;
  try {
    // Close the small gap between journal creation and the destructive rename.
    assertNoFreshServiceHeartbeat(directory, safetyNow, staleMs);

    // A crash after installation but before the completed stamp resumes here without
    // moving the restored database into a second quarantine.
    if (!liveMatchesSnapshot(live, verified)) {
      for (const from of liveFiles) {
        const to = join(quarantine, basename(from));
        if (existsSync(to)) {
          if (existsSync(from)) {
            throw new Error(`Prepared restore has both live and quarantined copies of ${basename(from)}; refusing an ambiguous rerun`);
          }
          continue;
        }
        if (!existsSync(from)) continue;
        renameSync(from, to);
        moved.push({ from, to });
      }
      syncDirectory(directory);

      const temp = tempPath(live);
      try {
        writeTemp(temp, new Uint8Array(readFileSync(verified.path)));
        renameSync(temp, live);
        installed = true;
        syncDirectory(directory);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    }

    if (!liveMatchesSnapshot(live, verified)) {
      throw new Error("Restored seer.db does not match the verified snapshot bytes and user_version");
    }
    const completed: RestoreState = {
      ...state,
      phase: "completed",
      completedAt: new Date().toISOString(),
    };
    writeRestoreState(directory, completed);
    return { ...verified, databasePath: live, quarantinePath: quarantine };
  } catch (error) {
    if (installed && existsSync(live)) unlinkSync(live);
    for (const move of [...moved].reverse()) {
      if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from);
    }
    if (createdState) {
      if (existsSync(statePath(directory))) unlinkSync(statePath(directory));
      try { rmdirSync(quarantine); } catch {}
    }
    // The restored live files may include a hot WAL. Do not run read-only inspection
    // cleanup after putting them back: refusal must preserve the exact pre-restore state.
    syncDirectory(directory);
    throw error;
  }
}

function usage(): never {
  throw new Error(
    "Usage: bun src/db-snapshot.ts backup|verify <snapshot.sqlite> | " +
      "bun src/db-snapshot.ts restore <snapshot.sqlite> --confirm-service-stopped",
  );
}

function printVerified(result: VerifiedSnapshot): void {
  console.log(`path=${result.path} user_version=${result.userVersion} integrity=${result.integrity}`);
}

async function main(): Promise<void> {
  const [command, path, ...flags] = process.argv.slice(2);
  if (!command || !path) usage();
  if (command === "backup") {
    if (flags.length > 0) usage();
    printVerified(backupDatabase(path));
    return;
  }
  if (command === "verify") {
    if (flags.length > 0) usage();
    printVerified(verifySnapshot(path));
    return;
  }
  if (command === "restore") {
    if (flags.length !== 1 || flags[0] !== "--confirm-service-stopped") usage();
    const result = restoreDatabase(path, true);
    console.log(
      `path=${result.databasePath} user_version=${result.userVersion} integrity=${result.integrity} quarantine=${result.quarantinePath}`,
    );
    return;
  }
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
