import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownedDirectories = new Set<string>();
let cleanupRegistered = false;

function testTempRoot(): string {
  if (process.env.SEER_TEST_TMPDIR) return process.env.SEER_TEST_TMPDIR;
  return existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
}

function cleanupOwnedDirectories(): void {
  for (const directory of ownedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  ownedDirectories.clear();
}

export function createTestDataDir(prefix = "seer-tests-"): string {
  const root = testTempRoot();
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, prefix));
  ownedDirectories.add(directory);

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", cleanupOwnedDirectories);
  }

  return directory;
}

export function removeTestDataDir(directory: string): void {
  if (!ownedDirectories.has(directory)) return;
  rmSync(directory, { recursive: true, force: true });
  ownedDirectories.delete(directory);
}
