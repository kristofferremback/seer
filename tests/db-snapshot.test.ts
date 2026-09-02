import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupDatabase,
  restoreDatabase,
  verifySnapshot,
} from "../src/db-snapshot";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "seer-snapshot-test-"));
  roots.push(path);
  return path;
}

function seed(path: string, version: number, value: string): void {
  const database = new Database(join(path, "seer.db"), { create: true });
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  database.run("INSERT INTO facts (value) VALUES (?)", [value]);
  database.run(`PRAGMA user_version = ${version}`);
  database.close();
}

async function activeWriter(databasePath: string): Promise<ReturnType<typeof Bun.spawn>> {
  const source = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(databasePath)});
    db.exec("PRAGMA journal_mode = WAL");
    console.log("ready");
    for (let i = 0; i < 500; i++) {
      db.run("INSERT INTO facts (value) VALUES (?)", ["writer-" + i]);
      await Bun.sleep(2);
    }
    await Bun.sleep(5000);
    db.close();
  `;
  const process = Bun.spawn(["bun", "-e", source], { stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 5_000;
  while (!output.includes("ready") && Date.now() < deadline) {
    const result = await reader.read();
    if (result.done) break;
    output += new TextDecoder().decode(result.value);
  }
  if (!output.includes("ready")) {
    const error = await new Response(process.stderr).text();
    process.kill("SIGKILL");
    throw new Error(`writer did not start: ${error}`);
  }
  return process;
}

async function stop(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  process.kill("SIGKILL");
  await process.exited;
}

async function leaveHotWal(databasePath: string): Promise<void> {
  const source = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(databasePath)});
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    db.run("INSERT INTO facts (value) VALUES ('after-snapshot')");
    console.log("ready");
    await Bun.sleep(5000);
  `;
  const process = Bun.spawn(["bun", "-e", source], { stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  const result = await reader.read();
  const output = result.done ? "" : new TextDecoder().decode(result.value);
  if (!output.includes("ready")) {
    process.kill("SIGKILL");
    await process.exited;
    throw new Error("hot WAL writer did not start");
  }
  await stop(process);
}

describe("standalone SQLite snapshots", () => {
  test("should serialize one valid WAL snapshot while another process writes", async () => {
    const data = root();
    seed(data, 23, "before");
    const writer = await activeWriter(join(data, "seer.db"));
    try {
      const destination = join(data, "backups", "pre-v24.sqlite");
      const backed = backupDatabase(destination, data);
      expect(backed).toMatchObject({ path: destination, userVersion: 23, integrity: "ok" });
      const snapshotDirectory = join(data, "backups");
      const beforeVerify = new Map(
        readdirSync(snapshotDirectory).sort().map((name) => [name, readFileSync(join(snapshotDirectory, name))]),
      );
      expect(verifySnapshot(destination)).toEqual(backed);
      expect(readdirSync(snapshotDirectory).sort()).toEqual([...beforeVerify.keys()]);
      for (const [name, bytes] of beforeVerify) {
        expect(readFileSync(join(snapshotDirectory, name))).toEqual(bytes);
      }
      expect(readdirSync(snapshotDirectory).some((name) => name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith(".tmp"))).toBe(false);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      expect(statSync(`${destination}.json`).mode & 0o777).toBe(0o600);
      const snapshot = new Database(destination, { readonly: true });
      expect(snapshot.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(snapshot.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts").get()!.n).toBeGreaterThan(0);
      snapshot.close();
      expect(() => backupDatabase(destination, data)).toThrow("Refusing to overwrite");
    } finally {
      await stop(writer);
    }
  });

  test("should serialize a stopped database whose last writer left a hot WAL", async () => {
    const data = root();
    seed(data, 23, "before-hot-wal");
    const writer = await activeWriter(join(data, "seer.db"));
    await Bun.sleep(20);
    await stop(writer);
    expect(statSync(join(data, "seer.db-wal")).size).toBeGreaterThan(0);
    const destination = join(data, "hot-wal.sqlite");
    expect(backupDatabase(destination, data)).toMatchObject({ userVersion: 23, integrity: "ok" });
    const snapshot = new Database(destination, { readonly: true });
    expect(snapshot.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts").get()!.n).toBeGreaterThan(1);
    snapshot.close();
  });

  test("should reject a manifest mismatch and bytes that no longer form the recorded database", () => {
    const data = root();
    seed(data, 23, "old");
    const destination = join(data, "pre-v24.sqlite");
    backupDatabase(destination, data);

    const manifest = JSON.parse(readFileSync(`${destination}.json`, "utf8"));
    writeFileSync(`${destination}.json`, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    chmodSync(`${destination}.json`, 0o600);
    expect(() => verifySnapshot(destination)).toThrow("SHA-256");

    const bytes = Buffer.from(readFileSync(destination));
    bytes.fill(0, 0, Math.min(128, bytes.length));
    writeFileSync(destination, bytes);
    writeFileSync(`${destination}.json`, JSON.stringify({
      ...manifest,
      bytes: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    }));
    expect(() => verifySnapshot(destination)).toThrow();
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
  });

  test("should require stopped-service confirmation and quarantine every live SQLite file", () => {
    const data = root();
    seed(data, 23, "old");
    const destination = join(data, "pre-v24.sqlite");
    backupDatabase(destination, data);

    const live = new Database(join(data, "seer.db"));
    live.run("INSERT INTO facts (value) VALUES ('new')");
    live.run("PRAGMA user_version = 24");
    live.close();

    expect(() => restoreDatabase(destination, false, data)).toThrow("--confirm-service-stopped");
    const restored = restoreDatabase(destination, true, data);
    expect(restored).toMatchObject({ userVersion: 23, integrity: "ok", databasePath: join(data, "seer.db") });
    expect(readdirSync(restored.quarantinePath)).toContain("seer.db");

    const database = new Database(join(data, "seer.db"), { readonly: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(23);
    expect(database.query<{ value: string }, []>("SELECT value FROM facts ORDER BY id").all()).toEqual([{ value: "old" }]);
    database.close();

    const quarantined = new Database(join(restored.quarantinePath, "seer.db"), { readonly: true });
    expect(quarantined.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(24);
    expect(quarantined.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts").get()!.n).toBe(2);
    quarantined.close();

    const quarantineNames = readdirSync(data).filter((name) => name.startsWith("restore-quarantine-"));
    const sidecarsBeforeReplay = {
      wal: existsSync(join(data, "seer.db-wal")),
      shm: existsSync(join(data, "seer.db-shm")),
    };
    const replay = restoreDatabase(destination, true, data);
    expect(replay.quarantinePath).toBe(restored.quarantinePath);
    expect(readdirSync(data).filter((name) => name.startsWith("restore-quarantine-"))).toEqual(quarantineNames);
    expect({
      wal: existsSync(join(data, "seer.db-wal")),
      shm: existsSync(join(data, "seer.db-shm")),
    }).toEqual(sidecarsBeforeReplay);
  });

  test("should quarantine a hot WAL even when the live main file still equals the snapshot", async () => {
    const data = root();
    seed(data, 23, "old");
    const destination = join(data, "pre-v24.sqlite");
    backupDatabase(destination, data);
    writeFileSync(join(data, "seer.db"), readFileSync(destination));
    await leaveHotWal(join(data, "seer.db"));
    expect(existsSync(join(data, "seer.db-wal"))).toBe(true);

    const restored = restoreDatabase(destination, true, data);
    expect(readdirSync(restored.quarantinePath)).toContain("seer.db-wal");
    const quarantined = new Database(join(restored.quarantinePath, "seer.db"), { readonly: true });
    expect(quarantined.query<{ value: string }, []>("SELECT value FROM facts ORDER BY id").all()).toEqual([
      { value: "old" },
      { value: "after-snapshot" },
    ]);
    quarantined.close();
  });

  test("should never clean a live hot WAL when verify or self-restore refuses", async () => {
    const data = root();
    seed(data, 23, "old");
    const destination = join(data, "pre-v24.sqlite");
    backupDatabase(destination, data);
    const livePath = join(data, "seer.db");
    writeFileSync(livePath, readFileSync(destination));
    await leaveHotWal(livePath);

    expect(() => verifySnapshot(livePath)).toThrow("manifest is missing");
    expect(existsSync(`${livePath}-wal`)).toBe(true);
    expect(() => restoreDatabase(livePath, true, data)).toThrow("Cannot restore seer.db from itself");
    expect(existsSync(`${livePath}-wal`)).toBe(true);
    const live = new Database(livePath, { readonly: true });
    expect(live.query<{ value: string }, []>("SELECT value FROM facts ORDER BY id").all()).toEqual([
      { value: "old" },
      { value: "after-snapshot" },
    ]);
    live.close();
  });

  test("should put a hot WAL back unchanged when restore refuses after quarantine begins", async () => {
    const data = root();
    seed(data, 23, "old");
    const destination = join(data, "pre-v24.sqlite");
    const snapshot = backupDatabase(destination, data);
    writeFileSync(join(data, "seer.db"), readFileSync(destination));
    await leaveHotWal(join(data, "seer.db"));

    const quarantine = join(data, "restore-quarantine-probe");
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, "seer.db-shm"), "collision");
    writeFileSync(join(data, ".seer-restore-state.json"), JSON.stringify({
      format: 1,
      phase: "prepared",
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
      snapshotBytes: snapshot.bytes,
      snapshotUserVersion: snapshot.userVersion,
      quarantinePath: quarantine,
      preparedAt: new Date().toISOString(),
      completedAt: null,
    }));

    expect(() => restoreDatabase(destination, true, data)).toThrow("both live and quarantined copies");
    expect(existsSync(join(data, "seer.db-wal"))).toBe(true);
    const live = new Database(join(data, "seer.db"), { readonly: true });
    expect(live.query<{ value: string }, []>("SELECT value FROM facts ORDER BY id").all()).toEqual([
      { value: "old" },
      { value: "after-snapshot" },
    ]);
    live.close();
  });

  test("should run backup and verify through the package commands", async () => {
    const data = root();
    seed(data, 23, "command");
    const destination = join(data, "command.sqlite");
    const run = async (script: "db:backup" | "db:verify") => {
      const child = Bun.spawn(["bun", "run", script, "--", destination], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, DATA_DIR: data },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await child.exited;
      const out = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      if (code !== 0) throw new Error(error);
      return out;
    };
    expect(await run("db:backup")).toContain("user_version=23 integrity=ok");
    expect(await run("db:verify")).toContain("user_version=23 integrity=ok");
  });

  test("should import neither application configuration nor GitHub code", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "db-snapshot.ts"), "utf8");
    expect(source).not.toContain('from "./config"');
    expect(source).not.toContain('from "./db"');
    expect(source).not.toContain("GITHUB_");
    expect(source).not.toContain("SEER_API_KEY");
  });
});
