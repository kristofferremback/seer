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
// GITHUB_TOKEN no longer exists; the App credentials below are what a client is
// built from, and the offline factory at the bottom is what stops one reaching a
// network. The delete stays because a developer's shell may still export it and its
// presence must never be what makes a test pass.
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

// ...and nothing else reaches it either. Every GitHub call in the suite is made by a
// client the factory below built, so the default here is a factory that returns a
// client which refuses, loudly and offline. A test that wants GitHub installs its own
// with setGithubClientFactory().
//
// There are two seams to close, not one: the per-workspace client factory and the
// OAuth transport, which is not a GithubClient. Leaving either open would let the
// suite make a real request with the app credentials above.
const { setGithubClientFactory } = await import("../src/overseer/github-app");
const { setGithubOAuth } = await import("../src/overseer/github-oauth");
const { offlineGithubClientFactory, offlineGithubOAuth } = await import("./offline-github");
setGithubClientFactory(offlineGithubClientFactory());
setGithubOAuth(offlineGithubOAuth());
