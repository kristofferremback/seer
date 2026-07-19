// Test preload: MUST set env before any app module (config/db/store) is imported,
// because config.ts reads env at import time and db/store have import side effects.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One fresh data dir per test process so DB/cache start clean and files don't collide.
const dataDir = mkdtempSync(join(tmpdir(), "seer-tests-"));

process.env.API_TOKEN = "test-token";
process.env.AUTH_DISABLED = "true";
process.env.DATA_DIR = dataDir;
process.env.PORT = "0";
// TTL 0 makes every cached extraction immediately eligible for sweepCache().
process.env.CACHE_TTL_MS = "0";
// Tests always run against the disk blob store, whatever the developer's shell has.
delete process.env.S3_BUCKET;
