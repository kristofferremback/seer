# 🔮 Seer

Seer is a tiny personal preview host for self-contained HTML bundles. Point an AI coding agent at it, have the agent zip up whatever it built, and Seer gives back a stable URL you can open in a browser. It exists because agent sessions increasingly produce richer output than a Markdown reply can carry (dashboards, small apps, interactive reports), and those outputs deserve somewhere to live and be viewed rather than being pasted as a wall of code.

Uploads are immutable and versioned: every upload of a slug creates a new version, the zips on disk are the source of truth, and metadata lives in a small SQLite database. Viewers see the latest version at a clean URL with live reload, so a new upload refreshes any tab that already has the bundle open.

Seer is multi-user. Bundles live inside a **workspace**; a workspace can have more than one member, and every member mints their own API keys and can invite others. A workspace is `public` (anyone with a link can view its bundles) or `private` (members only). See [Multi-user model](#multi-user-model) below. A single-user deployment is just a deployment with one workspace and one member — the first boot migrates the old single-user layout into exactly that.

## How it works

- **Uploads** go to `PUT`/`POST /api/bundles/:slug` with a bearer API key (`seer_sk_…`). Each upload is a new immutable version (`v1`, `v2`, ...). The key resolves the workspace, so the upload lands wherever the key belongs — the API path is unchanged.
- **Images** are single-file uploads to `PUT /api/images/:filename` (raw bytes, same bearer key), made for embedding screenshots in GitHub PRs. Uploads are compressed (longest edge capped at 2000px, metadata stripped, re-encoded to WebP or — when that loses — the source format; only SVG passes through verbatim) and served immutably at `/<workspace>/i/<img_id>/<filename>` — the `img_id` is random, so the URL is unguessable. Visibility follows the workspace, except GitHub's camo image proxy is always served so images render in PRs even from a private workspace (camo is identified by User-Agent, so treat private image URLs as capability links, not secrets).
- **Storage**: the raw zip is written to disk under `DATA_DIR/zips/<workspace>/<slug>`. Metadata (users, workspaces, memberships, keys, invites, slugs, versions) goes into `bun:sqlite`. The zip is the source of truth.
- **Serving**: `/<workspace>/b/:slug/` serves the latest version, `/<workspace>/b/:slug/v/N/` serves a pinned version. A legacy `/b/:slug/...` URL `301`s to its workspace-scoped equivalent. Bundles are extracted on demand into a disposable cache.
- **Live reload**: a tiny WebSocket script is injected into HTML served from the latest URL. When a new version lands, open viewers reload themselves.
- **Auth**: writes need an API key that a member mints from a workspace's settings. A public workspace's bundle links are viewable by anyone with the URL; a private workspace's are members-only (everyone else gets a generic 404). The inventory (`/bundles` and `GET /api/bundles`) is always private.

## Quickstart

```sh
bun install
cp .env.example .env      # then edit it
bun run dev               # starts on http://localhost:3000 with hot reload
```

For local development set `AUTH_DISABLED=true` in `.env` to skip Google sign-in entirely; every viewer is treated as the root user, who is a member of the bootstrap workspace. Nothing else is required to boot.

You need an API key to upload. On first boot Seer imports the `API_KEY` env var (if set) as the root workspace's key, so an existing single-user setup keeps working. Otherwise mint one from a workspace's settings page (`/settings/<workspace>`), where it is shown exactly once.

Upload a bundle. Here is a one-file example (`$API_TOKEN` is your `seer_sk_…` key):

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

The response includes the URL to open (scoped to the key's workspace):

```json
{
  "slug": "hello",
  "version": 1,
  "workspace": "ws_…",
  "url": "http://localhost:3000/ws_…/b/hello/",
  "versionUrl": "http://localhost:3000/ws_…/b/hello/v/1/",
  "bytes": 244,
  "files": 1,
  "hasIndexHtml": true
}
```

Open the returned `url` in a browser. Upload again to the same slug and any open tab reloads to the new version.

Slugs must match `[a-z0-9][a-z0-9-]{0,63}` (lowercase, digits, and hyphens; up to 64 characters).

## API

All API routes require a bearer API key. The key resolves the workspace; you never name it in the request.

```
Authorization: Bearer $API_TOKEN     # a seer_sk_… key
```

### Upload a bundle

```
PUT  /api/bundles/:slug
POST /api/bundles/:slug
```

Send the zip as the raw request body (`--data-binary`, not multipart). `PUT` and `POST` behave identically. Each successful call creates the next version for that slug in the key's workspace. The zip is validated before it is stored: entries with unsafe paths (absolute, `..`, or containing null bytes) are rejected, and an empty zip is a `400`.

Response (`200`) — `url`/`versionUrl` are scoped under the key's `workspace`:

```json
{
  "slug": "hello",
  "version": 2,
  "workspace": "ws_…",
  "url": "http://localhost:3000/ws_…/b/hello/",
  "versionUrl": "http://localhost:3000/ws_…/b/hello/v/2/",
  "bytes": 512,
  "files": 3,
  "hasIndexHtml": true
}
```

Error responses are JSON with an `error` field. Notable statuses: `400` invalid slug, empty body, or bad zip; `401` invalid, revoked, or missing key; `413` zip exceeds `MAX_UPLOAD_BYTES`.

### List bundles

```
GET /api/bundles
```

Returns every bundle in the key's workspace with its full version history:

```json
[
  {
    "slug": "hello",
    "latestVersion": 2,
    "workspace": "ws_…",
    "url": "http://localhost:3000/ws_…/b/hello/",
    "versions": [
      { "version": 2, "createdAt": "2026-07-15T12:00:00.000Z", "bytes": 512, "files": 3 },
      { "version": 1, "createdAt": "2026-07-15T11:59:00.000Z", "bytes": 244, "files": 1 }
    ]
  }
]
```

## Serving

- **Workspace-scoped.** Bundles are served under `/<workspace>/b/:slug/`. A public workspace serves anyone; a private workspace serves only signed-in members. Any denial, unknown workspace, unknown bundle, or out-of-range version resolves to the same generic 404 — forbidden and missing are indistinguishable, so a private workspace leaks nothing.
- **Legacy redirect.** A pre-workspace `/b/:slug/...` URL `301`s to `/<legacy_workspace>/b/:slug/...`, preserving the remainder and query, so old links keep working.
- **Latest vs pinned.** `/<workspace>/b/:slug/` always serves the newest version. `/<workspace>/b/:slug/v/N/` serves version `N` forever (as long as its zip exists). Requesting a version above the latest, or below `1`, is a `404`.
- **Trailing slash.** Requests to the bundle root without a trailing slash redirect to add one, so relative asset URLs inside the bundle resolve correctly. `index.html` is served for directory requests.
- **Live reload.** When you open a latest URL, Seer injects a small script before `</body>` (or at the end of the document if there is no `</body>`). It opens a WebSocket back to the server (`/ws/livereload?ws=<workspace>&slug=<slug>`, which upgrades only when the viewer could view the bundle). A new upload to that slug pushes a reload to every connected viewer. Pinned `/v/N/` URLs are static and do not get the injected script.
- **Extraction cache.** Zips are unpacked on demand into `DATA_DIR/cache/<workspace>/<slug>`. Each request bumps the freshness of the version it touched; a sweep runs once a minute and evicts extracted directories that have not been accessed within `CACHE_TTL_MS`. The cache is disposable and is wiped clean on startup. Zips are never evicted.

## Multi-user model

- **Workspaces.** Every bundle belongs to a workspace (a `ws_…` id). A workspace is `public` (the default — anyone with a bundle link can view) or `private` (bundles are members-only). Visibility is a per-workspace toggle on its settings page. Members are all equal — there are no roles; anyone can rename the workspace, flip its visibility, invite others, and manage their own keys.
- **Users & memberships.** A user is an email (stored lowercased). A user is a member of a workspace via a membership row; the signed-in ledger and settings are scoped to the workspaces you belong to. A user can be a member of several workspaces.
- **API keys.** Every member mints, rolls, and revokes their **own** keys (`seer_sk_…`) from a workspace's settings page. A key belongs to one `(user, workspace)` pair and resolves the workspace on upload, so the agent-facing upload API is unchanged. Only the SHA-256 hash of a key is stored; the token itself is shown exactly once, on the minting response. Rolling a key revokes it and mints a replacement (same name) in one step.
- **Invites.** Any member can invite anyone via a single-use link (`/invite/<token>`) that expires after 7 days. A signed-out invitee signs in with Google and is seated in one step; a signed-in invitee accepts with one click. A used or expired token is invalid everywhere and renders as a generic 404.

## Auth model

There are two separate trust boundaries.

- **Writes (uploads and the JSON API)** are authenticated by a bearer API key (`seer_sk_…`), minted per member per workspace. The lookup is hash-indexed: Seer SHA-256s the presented token and matches it against the stored hash, so there is no secret-dependent branching. Revoked keys are rejected. Listing bundles (`GET /api/bundles`, scoped to the key's workspace) also needs a key.
- **Viewing depends on workspace visibility.** A public workspace's bundle URLs and everything under them (pinned versions, sub-assets, the live-reload socket) are served to anyone with the link — no sign-in. A private workspace serves them only to signed-in members; everyone else gets the same generic 404 as a missing bundle.
- **The inventory is private.** The signed-in ledger at `/bundles` and the per-workspace settings require Google sign-in. Seer runs a plain OIDC flow: it redirects to Google, receives an `id_token` from Google's token endpoint over TLS, and reads the verified email claim. The email is looked up in the `users` table — a known user gets a session; an unknown one gets a session only if their `next` carries a valid invite; otherwise they are told the account has no seat. (`ALLOWED_EMAILS` is no longer an access list — it only seeds the root workspace's owner on first boot; see below.) The session is a signed (HMAC-SHA256) `HttpOnly` cookie carrying the user id; there is no server-side session store. Cookies are marked `Secure` automatically when `BASE_URL` is `https`.
- **Local dev.** Set `AUTH_DISABLED=true` to bypass Google entirely. Every viewer is treated as the root user (a member of the bootstrap workspace). Do not use this in a deployment.

A bundle serves its own `index.html` as-is, so a shared link previews with whatever OG tags the bundle itself carries. The public landing page lives at `/`, and the private list of bundles lives at `/bundles`.

## Migration

On first boot Seer migrates an existing single-user deployment losslessly, driven by SQLite's `PRAGMA user_version`:

- The root user's email is the first entry of `ALLOWED_EMAILS` (or `dev@localhost` when `AUTH_DISABLED=true`); with neither set and auth enabled, startup fails loudly.
- A root user, a root workspace (named after the email's local part, `public` visibility), and a membership are created.
- The existing `API_KEY`/`API_TOKEN` (if present) is imported as a legacy key on the root workspace, so old upload credentials keep working. It is imported once and never again — a rolled or revoked legacy key stays dead. If no key env var is set, the import is skipped with a loud warning (uploads then need a minted key).
- Existing bundles are adopted into the root workspace and their zips are moved under `DATA_DIR/zips/<workspace>/`.
- A fresh/empty database is bootstrapped the same way, minus the data adoption.

A deployment already at schema v1 boots straight through — the migration is a no-op.

## For agents

Seer hosts its own usage doc, written for an AI agent that holds a base URL and an API token and wants to publish a bundle:

- `GET /skill.md` — a public, no-auth Markdown guide covering how to build the zip, upload it with `curl`, read the response (`url` = latest, `versionUrl` = pinned), iterate, and list bundles. The `curl` examples are interpolated with the deployment's `BASE_URL`, so they are copy-pasteable as-is.
- `GET /llms.txt` — the same document, at the path agents conventionally probe for.

The landing page advertises the doc via `<link rel="alternate" type="text/markdown" href="/skill.md">` and a colophon link. Point an agent at `$BASE_URL/skill.md` (or `/llms.txt`) and it has everything it needs. A public workspace's bundle URLs are viewable by anyone, so an agent can hand the returned URL out — or fetch it back itself to verify the rendered page. A private workspace's URLs are members-only. The inventory (`GET /api/bundles`) always stays behind the key.

## Configuration

All configuration is via environment variables. Bun loads `.env` automatically. Copy `.env.example` to `.env` to start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | (optional) | Legacy upload token, imported once on first boot as the root workspace's key so a pre-workspace deployment keeps working. Optional — new keys are minted in the UI. `API_TOKEN` is accepted as an alias if `API_KEY` is unset. |
| `SESSION_SECRET` | (required unless auth disabled) | HMAC key used to sign session cookies. Use a long random string, e.g. `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID` | (required unless auth disabled) | Google OAuth 2.0 client ID. |
| `GOOGLE_CLIENT_SECRET` | (required unless auth disabled) | Google OAuth 2.0 client secret. |
| `ALLOWED_EMAILS` | (optional, deprecated) | No longer an access list. Only the first entry is read, once, on first boot, to seed the root workspace's owner. Login is checked against the `users` table. Required only on a first boot with auth enabled and no `AUTH_DISABLED` fallback. |
| `AUTH_DISABLED` | `false` | Set to `true` to skip Google sign-in entirely. Local dev only. When true, `GOOGLE_*`, `SESSION_SECRET`, and `ALLOWED_EMAILS` are not required (the root user is `dev@localhost`). |
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
3. Set the environment variables from the configuration table: at minimum `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BASE_URL`. On the **very first** boot also set `ALLOWED_EMAILS` (its first entry becomes the root workspace owner) and, if you are carrying over a pre-workspace deployment, `API_KEY` (imported once as the root workspace's key). (`PORT` is injected by Railway.)
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
