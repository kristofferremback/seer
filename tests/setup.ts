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
// Tests authenticate with API_TOKEN above; a developer's real API_KEY (from a
// local .env, which Bun auto-loads) would otherwise win in config.ts.
delete process.env.API_KEY;
// Tests always run against the disk blob store, whatever the developer's shell has.
delete process.env.S3_BUCKET;
// Tests never reach the real GitHub API, whatever the developer's shell has.
delete process.env.GITHUB_TOKEN;

// ...and nothing else reaches it either. Deleting the token above only makes an
// outbound call anonymous; this makes one impossible. Every GitHub call in the suite
// goes through the injection seam, so the default here is a client that refuses,
// loudly and offline. A test that wants GitHub installs its own fake with
// setGithubClient(), and clearing the seam with setGithubClient(null) still exposes
// the real fetch-backed default to the one test that asks for it by name.
const { setGithubClient } = await import("../src/overseer/github");
const { offlineGithubClient } = await import("./offline-github");
setGithubClient(offlineGithubClient());
