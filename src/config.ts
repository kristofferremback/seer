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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
  dataDir: process.env.DATA_DIR ?? "./data",
  s3,

  // Optional: API_KEY (preferred) or API_TOKEN. Only the first-boot migration reads
  // it, importing it as a legacy api_keys row. Agent uploads authenticate against
  // minted keys in the db, not this value.
  apiToken: process.env.API_KEY ?? process.env.API_TOKEN,

  // Optional: Overseer derives pull request facts from the GitHub API. Absent, only
  // public repositories resolve and the rate limit is the unauthenticated one.
  githubToken: process.env.GITHUB_TOKEN,

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
