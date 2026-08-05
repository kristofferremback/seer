// The GitHub App credentials every process needs, because config.ts requires them at
// import time and a spawned script does not get bunfig's test preload. Imported first,
// before anything that reaches config — a static import runs before the assignments in
// the importing module's own body.
//
// The key is generated per process: nothing in the suite is ever signed with a
// credential that exists anywhere else.
import { generateKeyPairSync } from "node:crypto";

export const scriptAppPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.GITHUB_APP_ID = "424242";
process.env.GITHUB_APP_SLUG = "seer-overseer-test";
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(
  scriptAppPrivateKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
).toString("base64");
process.env.GITHUB_APP_CLIENT_ID = "Iv1.testclientid";
process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
