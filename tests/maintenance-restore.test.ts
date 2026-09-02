import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, restoreDatabase } from "../src/db-snapshot";
import {
  SERVICE_HEARTBEAT_REAP_MS,
  SERVICE_HEARTBEAT_STALE_MS,
  freshServiceHeartbeats,
  reapStaleServiceHeartbeats,
  startServiceHeartbeat,
} from "../src/service-heartbeat";

let roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "seer-maintenance-test-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  roots = [];
});

function seed(path: string, version: number, value: string): void {
  const database = new Database(join(path, "seer.db"), { create: true });
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE facts (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  database.run("INSERT INTO facts (value) VALUES (?)", [value]);
  database.run(`PRAGMA user_version = ${version}`);
  database.close();
}

interface StartedProcess {
  child: ReturnType<typeof Bun.spawn>;
  base: string;
  output: { stdout: string; stderr: string };
  stop(): Promise<number>;
}

async function startCommand(dataDir: string, restoreSnapshot?: string): Promise<StartedProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: "0",
    BASE_URL: "http://localhost:0",
    AUTH_DISABLED: "true",
  };
  if (restoreSnapshot === undefined) delete env.SEER_MAINTENANCE_RESTORE;
  else env.SEER_MAINTENANCE_RESTORE = restoreSnapshot;

  const child = Bun.spawn(["bun", "run", "start"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = { stdout: "", stderr: "" };
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => { resolvePort = resolve; });
  const stdoutDone = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      output.stdout += decoder.decode(next.value, { stream: true });
      const match = output.stdout.match(/\bport ([0-9]+)(?:\)|;)/);
      if (match) resolvePort(Number(match[1]));
    }
    output.stdout += decoder.decode();
  })();
  const stderrDone = (async () => {
    output.stderr = await new Response(child.stderr).text();
  })();

  let selected: number;
  try {
    selected = await Promise.race([
      port,
      child.exited.then((code) => { throw new Error(`start exited ${code}: ${output.stdout}\n${output.stderr}`); }),
      Bun.sleep(15_000).then(() => { throw new Error(`start timed out: ${output.stdout}\n${output.stderr}`); }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    await Promise.all([stdoutDone, stderrDone]);
    throw error;
  }

  return {
    child,
    base: `http://127.0.0.1:${selected}`,
    output,
    async stop() {
      child.kill("SIGTERM");
      const code = await Promise.race([
        child.exited,
        Bun.sleep(5_000).then(() => {
          child.kill("SIGKILL");
          return child.exited;
        }),
      ]);
      await Promise.all([stdoutDone, stderrDone]);
      return code;
    },
  };
}

describe("restore maintenance startup", () => {
  test("should leave five minutes for verified restore and document a one-minute margin", () => {
    const repository = join(import.meta.dir, "..");
    expect(readFileSync(join(repository, "railway.toml"), "utf8")).toContain("healthcheckTimeout = 300");
    expect(readFileSync(join(repository, "docs/operations/migrations.md"), "utf8")).toContain("within 240 seconds");
  });

  test("should reap only day-old owned markers and fail closed only on recent malformed bytes", () => {
    const data = root();
    const directory = join(data, ".seer-service-heartbeats");
    mkdirSync(directory);
    const now = Date.now();
    const marker = (owner: string, heartbeatAt: number) => JSON.stringify({
      format: 1, mode: "normal", owner, pid: 42, startedAt: heartbeatAt, heartbeatAt,
    });
    writeFileSync(join(directory, "42-aaaaaaaaaaaaaaaa.json"), marker("42-aaaaaaaaaaaaaaaa", now - SERVICE_HEARTBEAT_REAP_MS - 1));
    writeFileSync(join(directory, "43-bbbbbbbbbbbbbbbb.json"), marker("43-bbbbbbbbbbbbbbbb", now));
    const malformed = join(directory, "44-cccccccccccccccc.json");
    writeFileSync(malformed, "not json");
    const old = new Date(now - SERVICE_HEARTBEAT_REAP_MS - 1);
    utimesSync(malformed, old, old);
    writeFileSync(join(directory, "somebody-else.txt"), "leave me");

    expect(reapStaleServiceHeartbeats(data, now)).toBe(2);
    expect(readdirSync(directory).sort()).toEqual(["43-bbbbbbbbbbbbbbbb.json", "somebody-else.txt"]);
    writeFileSync(malformed, "still not json");
    expect(() => freshServiceHeartbeats(data, now)).toThrow("unreadable");
    const stale = new Date(now - SERVICE_HEARTBEAT_STALE_MS - 1);
    utimesSync(malformed, stale, stale);
    expect(freshServiceHeartbeats(data, now).map((entry) => entry.owner)).toEqual(["43-bbbbbbbbbbbbbbbb"]);

    const live = startServiceHeartbeat(data, { intervalMs: 60_000, now: () => now });
    expect(existsSync(live.path)).toBe(true);
    live.stop();
    expect(existsSync(live.path)).toBe(false);
  });

  test("should refuse restore while the normal bun run start heartbeat is fresh, then allow the stopped stale owner", async () => {
    const data = root();
    const snapshotSource = root();
    seed(snapshotSource, 23, "snapshot");
    const snapshot = join(data, "backups", "pre-v24.sqlite");
    backupDatabase(snapshot, snapshotSource);

    const running = await startCommand(data);
    try {
      expect(await (await fetch(`${running.base}/healthz`)).text()).toBe("ok");
      expect(() => restoreDatabase(snapshot, true, data)).toThrow("service heartbeat");
    } finally {
      expect(await running.stop()).toBe(0);
    }

    const restored = restoreDatabase(snapshot, true, data, {
      now: Date.now() + SERVICE_HEARTBEAT_STALE_MS + 1,
    });
    expect(restored.userVersion).toBe(23);
    const database = new Database(join(data, "seer.db"), { readonly: true });
    expect(database.query<{ value: string }, []>("SELECT value FROM facts").get()?.value).toBe("snapshot");
    database.close();
  }, 30_000);

  test("should select restore under bun run start, expose only health after verification, and not rerun on restart", async () => {
    const data = root();
    seed(data, 24, "newer");
    const source = root();
    seed(source, 23, "rollback");
    const snapshot = join(data, "backups", "pre-v24.sqlite");
    backupDatabase(snapshot, source);

    const first = await startCommand(data, snapshot);
    try {
      expect(await (await fetch(`${first.base}/healthz`)).text()).toBe("ok");
      for (const path of ["/", "/openapi.json", "/api/reviews"]) {
        const response = await fetch(`${first.base}${path}`);
        expect({ path, status: response.status, body: await response.text() }).toEqual({
          path,
          status: 404,
          body: "Not found",
        });
      }
      expect(first.output.stdout).toContain("maintenance restore verified");
      const database = new Database(join(data, "seer.db"), { readonly: true });
      expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(23);
      expect(database.query<{ value: string }, []>("SELECT value FROM facts").get()?.value).toBe("rollback");
      database.close();
    } finally {
      expect(await first.stop()).toBe(0);
    }

    const quarantines = readdirSync(data).filter((name) => name.startsWith("restore-quarantine-")).sort();
    expect(quarantines).toHaveLength(1);
    const second = await startCommand(data, snapshot);
    try {
      expect(await (await fetch(`${second.base}/healthz`)).text()).toBe("ok");
      expect((await fetch(`${second.base}/api/reviews`)).status).toBe(404);
      expect(readdirSync(data).filter((name) => name.startsWith("restore-quarantine-")).sort()).toEqual(quarantines);
    } finally {
      expect(await second.stop()).toBe(0);
    }
  }, 30_000);
});
