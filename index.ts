import { startServer } from "./src/server";

// Crash diagnostics. Without these, a stray uncaught error exits the process
// with little context and Railway just reports "crashed" — these print the full
// reason to the logs first. An unhandled promise rejection (e.g. one bad request
// path) is logged loudly but does NOT tear down the server for every viewer; a
// truly uncaught exception leaves the process in an unknown state, so we log and
// exit to let Railway restart cleanly.
process.on("unhandledRejection", (reason) => {
  console.error("[seer] UNHANDLED REJECTION (not exiting):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[seer] UNCAUGHT EXCEPTION (exiting):", err);
  process.exit(1);
});

// Top-level await: a failed boot (bad S3 config, failed blob migration) must exit
// non-zero, not linger serverless behind the unhandledRejection log-and-continue.
await startServer();
