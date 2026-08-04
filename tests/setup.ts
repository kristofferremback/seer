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

// A GitHub App the suite owns, with a keypair generated for this process. config.ts
// reads these at import time, so they are seeded here rather than in any test — and a
// generated key means nothing in the suite is signed with a credential that exists
// anywhere else, while the JWT tests still get a real RSA key to verify against.
const { generateKeyPairSync } = await import("node:crypto");
export const testAppPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GITHUB_APP_ID = "424242";
process.env.GITHUB_APP_SLUG = "seer-overseer-test";
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(
  testAppPrivateKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
).toString("base64");
process.env.GITHUB_APP_CLIENT_ID = "Iv1.testclientid";
process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

// ...and nothing else reaches it either. Deleting the token above only makes an
// outbound call anonymous; this makes one impossible. Every GitHub call in the suite
// goes through the injection seam, so the default here is a client that refuses,
// loudly and offline. A test that wants GitHub installs its own fake with
// setGithubClient(), and clearing the seam with setGithubClient(null) still exposes
// the real fetch-backed default to the one test that asks for it by name.
//
// There are two seams to close, not one: the per-workspace client factory and the
// OAuth transport, which is not a GithubClient. Leaving either open would let the
// suite make a real request with the app credentials above.
const { setGithubClient } = await import("../src/overseer/github");
const { setGithubClientFactory } = await import("../src/overseer/github-app");
const { setGithubOAuth } = await import("../src/overseer/github-oauth");
const { offlineGithubClient, offlineGithubClientFactory, offlineGithubOAuth } = await import(
  "./offline-github"
);
setGithubClient(offlineGithubClient());
setGithubClientFactory(offlineGithubClientFactory());
setGithubOAuth(offlineGithubOAuth());
