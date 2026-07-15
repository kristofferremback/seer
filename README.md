# 🔮 Seer

Seer is a tiny personal preview host for self-contained HTML bundles. Point an AI coding agent at it, have the agent zip up whatever it built, and Seer gives back a stable URL you can open in a browser. It exists because agent sessions increasingly produce richer output than a Markdown reply can carry (dashboards, small apps, interactive reports), and those outputs deserve somewhere to live and be viewed rather than being pasted as a wall of code.

Uploads are immutable and versioned: every upload of a slug creates a new version, the zips on disk are the source of truth, and metadata lives in a small SQLite database. Viewers see the latest version at a clean URL with live reload, so a new upload refreshes any tab that already has the bundle open.

## How it works

- **Uploads** go to `PUT`/`POST /api/bundles/:slug` with a bearer token. Each upload is a new immutable version (`v1`, `v2`, ...).
- **Storage**: the raw zip is written to disk under `DATA_DIR/zips`. Metadata (slugs, versions, sizes) goes into `bun:sqlite`. The zip is the source of truth.
- **Serving**: `/b/:slug/` serves the latest version, `/b/:slug/v/N/` serves a pinned version. Bundles are extracted on demand into a disposable cache.
- **Live reload**: a tiny WebSocket script is injected into HTML served from the latest URL. When a new version lands, open viewers reload themselves.
- **Auth**: writes need the API token. Reads need Google sign-in against an email allowlist.

## Quickstart

```sh
bun install
cp .env.example .env      # then edit it (at minimum set API_KEY)
bun run dev               # starts on http://localhost:3000 with hot reload
```

For local development you can skip Google sign-in entirely by setting `AUTH_DISABLED=true` in `.env`. With that set, only `API_KEY` is required.

Upload a bundle. Here is a one-file example:

```sh
# build a tiny zip containing an index.html
mkdir -p /tmp/hello && echo '<h1>hello from seer</h1>' > /tmp/hello/index.html
(cd /tmp/hello && zip -r /tmp/hello.zip .)

# upload it as the slug "hello"
curl -X PUT \
  --data-binary @/tmp/hello.zip \
  -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/api/bundles/hello
```

The response includes the URL to open:

```json
{
  "slug": "hello",
  "version": 1,
  "url": "http://localhost:3000/b/hello/",
  "versionUrl": "http://localhost:3000/b/hello/v/1/",
  "bytes": 244,
  "files": 1,
  "hasIndexHtml": true
}
```

Open `http://localhost:3000/b/hello/` in a browser. Upload again to the same slug and any open tab reloads to the new version.

Slugs must match `[a-z0-9][a-z0-9-]{0,63}` (lowercase, digits, and hyphens; up to 64 characters).

## API

All API routes require the bearer token:

```
Authorization: Bearer $API_TOKEN
```

### Upload a bundle

```
PUT  /api/bundles/:slug
POST /api/bundles/:slug
```

Send the zip as the raw request body (`--data-binary`, not multipart). `PUT` and `POST` behave identically. Each successful call creates the next version for that slug. The zip is validated before it is stored: entries with unsafe paths (absolute, `..`, or containing null bytes) are rejected, and an empty zip is a `400`.

Response (`200`):

```json
{
  "slug": "hello",
  "version": 2,
  "url": "http://localhost:3000/b/hello/",
  "versionUrl": "http://localhost:3000/b/hello/v/2/",
  "bytes": 512,
  "files": 3,
  "hasIndexHtml": true
}
```

Error responses are JSON with an `error` field. Notable statuses: `400` invalid slug, empty body, or bad zip; `401` invalid or missing token; `413` zip exceeds `MAX_UPLOAD_BYTES`.

### List bundles

```
GET /api/bundles
```

Returns every bundle with its full version history:

```json
[
  {
    "slug": "hello",
    "latestVersion": 2,
    "url": "http://localhost:3000/b/hello/",
    "versions": [
      { "version": 2, "createdAt": "2026-07-15T12:00:00.000Z", "bytes": 512, "files": 3 },
      { "version": 1, "createdAt": "2026-07-15T11:59:00.000Z", "bytes": 244, "files": 1 }
    ]
  }
]
```

## Serving

- **Latest vs pinned.** `/b/:slug/` always serves the newest version. `/b/:slug/v/N/` serves version `N` forever (as long as its zip exists). Requesting a version above the latest, or below `1`, is a `404`.
- **Trailing slash.** Requests to `/b/:slug` (no trailing slash) redirect to `/b/:slug/` so relative asset URLs inside the bundle resolve correctly. `index.html` is served for directory requests.
- **Live reload.** When you open a latest URL, Seer injects a small script before `</body>` (or at the end of the document if there is no `</body>`). It opens a WebSocket back to the server. A new upload to that slug pushes a reload to every connected viewer. Pinned `/v/N/` URLs are static and do not get the injected script.
- **Extraction cache.** Zips are unpacked on demand into `DATA_DIR/cache`. Each request bumps the freshness of the version it touched; a sweep runs once a minute and evicts extracted directories that have not been accessed within `CACHE_TTL_MS`. The cache is disposable and is wiped clean on startup. Zips are never evicted.

## Auth model

There are two separate trust boundaries.

- **Writes (uploads and the JSON API)** are authenticated by a single shared bearer token, `API_TOKEN`. This is what an AI agent uses. The comparison is constant-time. There are no per-user upload credentials.
- **Reads (viewing bundles in a browser)** require Google sign-in. Seer runs a plain OIDC flow: it redirects to Google, receives an `id_token` from Google's token endpoint over TLS, reads the email claim, and checks it against `ALLOWED_EMAILS`. Only verified, allowlisted emails get a session. The session is a signed (HMAC-SHA256) `HttpOnly` cookie; there is no server-side session store. Cookies are marked `Secure` automatically when `BASE_URL` is `https`.
- **Local dev.** Set `AUTH_DISABLED=true` to bypass Google entirely. Every viewer is treated as `dev@localhost`. Do not use this in a deployment.

Public, unauthenticated bundle URLs render an OG-tagged sign-in shell page so a link previews nicely in chat and lands the visitor at Google sign-in. The public landing page lives at `/`, and the signed-in list of bundles lives at `/bundles`.

## For agents

Seer hosts its own usage doc, written for an AI agent that holds a base URL and an API token and wants to publish a bundle:

- `GET /skill.md` — a public, no-auth Markdown guide covering how to build the zip, upload it with `curl`, read the response (`url` = latest, `versionUrl` = pinned), iterate, and list bundles. The `curl` examples are interpolated with the deployment's `BASE_URL`, so they are copy-pasteable as-is.
- `GET /llms.txt` — the same document, at the path agents conventionally probe for.

The landing page advertises the doc via `<link rel="alternate" type="text/markdown" href="/skill.md">` and a colophon link. Point an agent at `$BASE_URL/skill.md` (or `/llms.txt`) and it has everything it needs. Note that *viewing* a bundle still requires Google sign-in, so agents should hand the returned URL to a human rather than trying to fetch it back.

## Configuration

All configuration is via environment variables. Bun loads `.env` automatically. Copy `.env.example` to `.env` to start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | (required) | Bearer token that upload requests must send. Always required. `API_TOKEN` is accepted as an alias if `API_KEY` is unset. |
| `SESSION_SECRET` | (required unless auth disabled) | HMAC key used to sign session cookies. Use a long random string, e.g. `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID` | (required unless auth disabled) | Google OAuth 2.0 client ID. |
| `GOOGLE_CLIENT_SECRET` | (required unless auth disabled) | Google OAuth 2.0 client secret. |
| `ALLOWED_EMAILS` | (required unless auth disabled) | Comma-separated allowlist of emails permitted to view bundles. At least one is required when auth is enabled. Compared case-insensitively. |
| `AUTH_DISABLED` | `false` | Set to `true` to skip Google sign-in entirely. Local dev only. When true, `GOOGLE_*`, `SESSION_SECRET`, and `ALLOWED_EMAILS` are not required. |
| `BASE_URL` | `http://localhost:$PORT` | Public base URL of the deployment. Used to build OAuth redirects and the URLs returned from uploads. Cookies are `Secure` when this is `https`. A trailing slash is stripped. |
| `PORT` | `3000` | Port to listen on. |
| `DATA_DIR` | `./data` | Directory for the SQLite database, uploaded zips, and the extraction cache. Point this at a mounted volume in production. |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MiB) | Maximum upload size in bytes. Larger uploads get `413`. |
| `CACHE_TTL_MS` | `1800000` (30 min) | How long an extracted bundle stays in the cache after its last access. |
| `SESSION_TTL_MS` | `2592000000` (30 days) | Session cookie lifetime in milliseconds. |

## Deploying on Railway

Seer keeps state on local disk (SQLite database and zip files), so it must run as a **single instance** with a persistent volume. Do not scale it horizontally.

Build and deploy settings (start command, healthcheck, single replica, restart policy) are committed in [`railway.toml`](./railway.toml), so Railway picks them up automatically. Two things still have to be done in the dashboard because they can't live in the repo: attaching the volume and setting the variables.

1. Create a new service pointed at this repository. Railway reads `railway.toml`, detects Bun, and runs `bun run start`.
2. Attach a **volume** and mount it at `/data`, then set `DATA_DIR=/data` so the database, zips, and cache live on the volume and survive redeploys.
3. Set the environment variables from the configuration table: at minimum `API_TOKEN`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`, and `BASE_URL`. (`PORT` is injected by Railway.)
4. Deploy once, then set `BASE_URL` to the service's public domain (for example `https://seer.up.railway.app`) and redeploy. It must exactly match the domain Google redirects back to.

The healthcheck path (`/healthz`, returns `200 ok`) is already declared in `railway.toml`.

### Google OAuth setup

In the Google Cloud Console, create an OAuth 2.0 Client ID (type: Web application) and add the **authorized redirect URI**:

```
https://<your-domain>/auth/callback
```

This must match `$BASE_URL/auth/callback` exactly. Put the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The OAuth scope Seer requests is `openid email`.

## Development

```sh
bun run dev         # hot-reloading dev server (index.ts)
bun test            # run the test suite
bun run typecheck   # tsc --noEmit
```

## License

MIT. See [LICENSE](./LICENSE).
