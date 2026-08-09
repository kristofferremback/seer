function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const authDisabled = process.env.AUTH_DISABLED === "true";

// Blob store: when S3_BUCKET is set, bundle zips and images live in S3 and the
// only durable local state is SQLite (auth + metadata). Credentials/region come
// from the standard env names (S3_* preferred, AWS_* accepted). Misconfiguration
// fails loudly at boot rather than at the first upload.
const s3Bucket = process.env.S3_BUCKET;
const s3 = s3Bucket
  ? {
      bucket: s3Bucket,
      region: process.env.S3_REGION ?? process.env.AWS_REGION,
      endpoint: process.env.S3_ENDPOINT, // optional: non-AWS S3-compatible stores
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    }
  : null;
if (s3) {
  if (!s3.accessKeyId || !s3.secretAccessKey) {
    throw new Error(
      "S3_BUCKET is set but credentials are missing: set S3_ACCESS_KEY_ID and " +
        "S3_SECRET_ACCESS_KEY (or their AWS_* equivalents).",
    );
  }
  if (!s3.region && !s3.endpoint) {
    throw new Error("S3_BUCKET is set but S3_REGION/AWS_REGION (or S3_ENDPOINT) is missing.");
  }
}

// The GitHub App. All six are required: with GITHUB_TOKEN gone there is no other way to
// reach GitHub, so an instance without them is one that boots happily and then fails at
// the first publish and answers every delivery 503 — the silent misconfiguration this
// repo refuses elsewhere. Requiring them makes registering an App part of running the
// server at all (docs/overseer/github-app.md, "Removing the token").
const APP_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
] as const;

function githubAppConfig() {
  const missing = APP_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `GitHub App is not configured: missing ${missing.join(", ")}. All of ${APP_VARS.join(", ")} are required.`,
    );
  }
  // The PEM arrives base64-encoded because a raw PEM's newlines do not survive a
  // Railway environment variable. An unparseable key fails here, naming the variable,
  // rather than at the first JWT signature.
  const pem = Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, "base64").toString("utf8");
  if (!pem.includes("-----BEGIN") || !pem.includes("PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is not a base64-encoded PEM private key (decoded value has no PEM header).",
    );
  }
  return {
    appId: process.env.GITHUB_APP_ID!,
    slug: process.env.GITHUB_APP_SLUG!,
    privateKeyPem: pem,
    clientId: process.env.GITHUB_APP_CLIENT_ID!,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET!,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  };
}

export interface GithubUserOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * The user OAuth application, optional as a pair.
 *
 * It is a SECOND GitHub application beside the App above, and it buys one thing: the
 * connect button in settings. Pasting a fine-grained token does the same job without it,
 * so requiring it at boot would mean every existing deployment refuses to start on
 * upgrade until its operator registers another application — a cost paid by everyone for
 * a path some will never use.
 *
 * Half of it is still a mistake rather than a choice, and one that would only surface at
 * the token exchange, so exactly one variable set throws here and names both.
 */
export function githubUserOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): GithubUserOAuthConfig | null {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GitHub user OAuth is half configured: GITHUB_OAUTH_CLIENT_ID and " +
        "GITHUB_OAUTH_CLIENT_SECRET must be set together, or neither.",
    );
  }
  return { clientId, clientSecret };
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
  dataDir: process.env.DATA_DIR ?? "./data",
  s3,

  // Optional: API_KEY (preferred) or API_TOKEN. Only the first-boot migration reads
  // it, importing it as a legacy api_keys row. Agent uploads authenticate against
  // minted keys in the db, not this value.
  apiToken: process.env.API_KEY ?? process.env.API_TOKEN,

  // GITHUB_TOKEN is gone: every GitHub call is made with a credential minted for the
  // installation a workspace holds, so there is no server-wide token to fall back to.
  githubApp: githubAppConfig(),
  // Null when the pair is absent: the connect button disappears and the paste path
  // stands alone.
  githubUserOAuth: githubUserOAuthConfig(),

  // Viewer auth (Google OIDC). AUTH_DISABLED=true skips it entirely — local dev only.
  authDisabled,
  googleClientId: authDisabled ? "" : required("GOOGLE_CLIENT_ID"),
  googleClientSecret: authDisabled ? "" : required("GOOGLE_CLIENT_SECRET"),
  sessionSecret: authDisabled ? "dev" : required("SESSION_SECRET"),
  // Optional, deprecated: only the first-boot migration reads this to pick the root
  // workspace owner. Login is checked against the users table, not this list.
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 30 * 60 * 1000),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
};
