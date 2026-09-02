// Cross-container proof that a normal Seer process still owns the shared volume.
//
// Each process writes its own marker so a rolling handoff may overlap without either
// container hiding the other. Restore scans every marker and refuses while any is fresh.
// Markers remain after shutdown and become harmless only after the bounded stale window.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SERVICE_HEARTBEAT_INTERVAL_MS = 5_000;
export const SERVICE_HEARTBEAT_STALE_MS = 30_000;
const HEARTBEAT_DIRECTORY = ".seer-service-heartbeats";

export interface ServiceHeartbeat {
  format: 1;
  mode: "normal";
  owner: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface ServiceHeartbeatController {
  owner: string;
  path: string;
  stop(): void;
}

function heartbeatDirectory(dataDir: string): string {
  return join(resolve(dataDir), HEARTBEAT_DIRECTORY);
}

function markerPath(dataDir: string, owner: string): string {
  return join(heartbeatDirectory(dataDir), `${owner}.json`);
}

function writeMarker(path: string, marker: ServiceHeartbeat): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function parseMarker(path: string): ServiceHeartbeat {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Service heartbeat marker ${path} is unreadable; restore is refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Service heartbeat marker ${path} has an invalid shape; restore is refused`);
  }
  const row = value as Record<string, unknown>;
  if (row.format !== 1 || row.mode !== "normal" || typeof row.owner !== "string" || row.owner === "" ||
      !Number.isInteger(row.pid) || !Number.isFinite(row.startedAt) || !Number.isFinite(row.heartbeatAt)) {
    throw new Error(`Service heartbeat marker ${path} has invalid values; restore is refused`);
  }
  return row as unknown as ServiceHeartbeat;
}

/** Start the marker before importing the application database. A later write failure is
 * fatal by default because allowing the marker to age while the server remains live
 * would turn the restore safety check into a lie. */
export function startServiceHeartbeat(
  dataDir: string = process.env.DATA_DIR?.trim() || "./data",
  options: {
    intervalMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
  } = {},
): ServiceHeartbeatController {
  const directory = heartbeatDirectory(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const path = markerPath(dataDir, owner);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const onError = options.onError ?? ((error: unknown) => {
    console.error("[seer] service heartbeat failed; exiting:", error);
    process.exit(1);
  });
  const beat = () => writeMarker(path, {
    format: 1,
    mode: "normal",
    owner,
    pid: process.pid,
    startedAt,
    heartbeatAt: now(),
  });
  beat();
  const timer = setInterval(() => {
    try {
      beat();
    } catch (error) {
      clearInterval(timer);
      onError(error);
    }
  }, options.intervalMs ?? SERVICE_HEARTBEAT_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    owner,
    path,
    stop() {
      clearInterval(timer);
    },
  };
}

/** Every fresh owner on the shared volume. Malformed markers fail closed. */
export function freshServiceHeartbeats(
  dataDir: string,
  now: number = Date.now(),
  staleMs: number = SERVICE_HEARTBEAT_STALE_MS,
): ServiceHeartbeat[] {
  const directory = heartbeatDirectory(dataDir);
  if (!existsSync(directory)) return [];
  const fresh: ServiceHeartbeat[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const marker = parseMarker(join(directory, name));
    if (now - marker.heartbeatAt <= staleMs) fresh.push(marker);
  }
  return fresh;
}

export function assertNoFreshServiceHeartbeat(
  dataDir: string,
  now: number = Date.now(),
  staleMs: number = SERVICE_HEARTBEAT_STALE_MS,
): void {
  const fresh = freshServiceHeartbeats(dataDir, now, staleMs);
  if (fresh.length === 0) return;
  const owners = fresh.map((marker) => marker.owner).join(", ");
  throw new Error(
    `Restore refused: ${fresh.length} Seer service heartbeat${fresh.length === 1 ? " is" : "s are"} fresh ` +
      `(${owners}). Stop every replica and wait more than ${Math.ceil(staleMs / 1000)} seconds.`,
  );
}
