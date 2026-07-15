function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const authDisabled = process.env.AUTH_DISABLED === "true";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
  dataDir: process.env.DATA_DIR ?? "./data",

  apiToken: required("API_TOKEN"),

  // Viewer auth (Google OIDC). AUTH_DISABLED=true skips it entirely — local dev only.
  authDisabled,
  googleClientId: authDisabled ? "" : required("GOOGLE_CLIENT_ID"),
  googleClientSecret: authDisabled ? "" : required("GOOGLE_CLIENT_SECRET"),
  sessionSecret: authDisabled ? "dev" : required("SESSION_SECRET"),
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 30 * 60 * 1000),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
};

if (!config.authDisabled && config.allowedEmails.length === 0) {
  throw new Error("ALLOWED_EMAILS must list at least one email when auth is enabled");
}
