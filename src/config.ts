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

  // Accept API_KEY (preferred) or API_TOKEN. Agents send this as the bearer token.
  apiToken: (() => {
    const value = process.env.API_KEY ?? process.env.API_TOKEN;
    if (!value) throw new Error("Missing required environment variable: API_KEY (or API_TOKEN)");
    return value;
  })(),

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
