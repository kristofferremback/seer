// The restore-only startup selected by SEER_MAINTENANCE_RESTORE.
//
// This module imports no application configuration or database connection. It verifies
// and restores first, then binds only /healthz so the platform can report completion
// without exposing an application route against the rolled-back database.

import { resolve } from "node:path";
import { restoreDatabase, type RestoredSnapshot } from "./db-snapshot";

export interface MaintenanceRestoreServer {
  server: ReturnType<typeof Bun.serve>;
  restore: RestoredSnapshot;
}

function portFromEnvironment(): number {
  const raw = process.env.PORT ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be a whole number from 0 through 65535; got ${JSON.stringify(raw)}`);
  }
  return port;
}

export async function startMaintenanceRestoreServer(
  snapshot: string,
  options: { dataDir?: string; port?: number } = {},
): Promise<MaintenanceRestoreServer> {
  const source = snapshot.trim();
  if (source === "") throw new Error("SEER_MAINTENANCE_RESTORE must name the snapshot path");
  const dataDir = resolve(options.dataDir ?? (process.env.DATA_DIR?.trim() || "./data"));
  const restored = restoreDatabase(source, true, dataDir);
  const port = options.port ?? portFromEnvironment();
  const server = Bun.serve({
    port,
    routes: {
      "/healthz": () => new Response("ok"),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  console.log(
    `[seer] maintenance restore verified: path=${restored.databasePath} ` +
      `user_version=${restored.userVersion} integrity=${restored.integrity} quarantine=${restored.quarantinePath}`,
  );
  console.log(`[seer] maintenance health listening on port ${server.port}; application routes are disabled`);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[seer] ${signal} received; stopping maintenance health`);
    server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  return { server, restore: restored };
}
