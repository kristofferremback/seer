// Crash diagnostics. Without these, a stray uncaught error exits the process
// with little context and Railway just reports "crashed". An unhandled promise
// rejection is logged but does not tear down the server for every viewer. A truly
// uncaught exception leaves the process in an unknown state, so it exits.
process.on("unhandledRejection", (reason) => {
  console.error("[seer] UNHANDLED REJECTION (not exiting):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[seer] UNCAUGHT EXCEPTION (exiting):", err);
  process.exit(1);
});

// railway.toml always starts `bun run start`. This explicit variable is the only way
// that command enters restore-only maintenance. Keep the branch ahead of every app
// import so maintenance never opens seer.db through src/db.ts.
if (process.env.SEER_MAINTENANCE_RESTORE !== undefined) {
  const snapshot = process.env.SEER_MAINTENANCE_RESTORE.trim();
  const { startMaintenanceRestoreServer } = await import("./src/maintenance-restore");
  await startMaintenanceRestoreServer(snapshot);
} else {
  // Write the shared-volume heartbeat before importing the database. Restore cannot
  // mistake a slow application boot for a stopped service.
  const { startServiceHeartbeat } = await import("./src/service-heartbeat");
  const heartbeat = startServiceHeartbeat(process.env.DATA_DIR?.trim() || "./data");
  try {
    const { startServer } = await import("./src/server");
    await startServer();
  } catch (error) {
    heartbeat.stop();
    throw error;
  }
}
