---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

@AGENTS.md

## Publishing previews to the deployed Seer

This repo is Seer's source, and a production instance runs at **https://seer.build**. Use it to share anything with the user that reads better rendered than pasted — plans, design mockups, diagrams, reports. The user's Claude artifacts do not render for them; Seer is the replacement. (Voice-transcribed messages sometimes garble "seer" as "CR".)

Auth is `Bearer $SEER_API_KEY`, already set in the environment — never print it.

1. Build in a fresh temp dir (`dir=$(mktemp -d)`) with `index.html` at the root and relative asset paths. Absolute `/fonts/*.woff2` and `/favicon.svg` do resolve — the host serves them — so previews can use the real Seer type (see `src/pages.ts` for the design language).
2. Zip from inside the build dir: `(cd "$dir" && zip -r bundle.zip . -x bundle.zip)`
3. Upload: `curl -X PUT --data-binary @"$dir/bundle.zip" -H "Authorization: Bearer $SEER_API_KEY" https://seer.build/api/bundles/<slug>` — slug matches `[a-z0-9][a-z0-9-]{0,63}`; suffix a short random token (e.g. `design-$(openssl rand -hex 3)`) so parallel sessions never clobber each other. Reuse a slug only to deliberately update that preview at its URL.

The response's `url` is the latest version (live-reloads on re-PUT); `versionUrl` is pinned. Hand the user `url`. Full contract: https://seer.build/skill.md

Seer also hosts single images — the way to get a screenshot into a GitHub PR body: `curl -X PUT --data-binary @shot.png -H "Authorization: Bearer $SEER_API_KEY" https://seer.build/api/images/shot.png` returns a `markdown` field to paste straight into the PR. Images are compressed to WebP on upload and always render on GitHub (camo is allowed through) even when the workspace is private.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### Testing anything that turns on who is asking

`tests/setup.ts` sets `AUTH_DISABLED=true`, and the repo's `.env` sets it too, which Bun
loads before any script you run by hand. Under it `sessionUser` returns the root user for
every request, so a fetch with no cookie is not a signed-out visitor. A test that means to
ask what a stranger sees is silently asking what a signed-in root user sees, and a probe
you write in the scratchpad has the same problem unless it starts with
`delete process.env.AUTH_DISABLED`.

Privacy questions therefore run in their own process, spawned from the suite:
`tests/share-privacy.script.ts` and `tests/overseer/read-privacy.script.ts` are the
pattern. Copy one. They assert on status, content type and body together, because
"the same 404" has to mean the same response and not merely the same status line.

When a refusal is the thing under test, check that the corresponding success actually
works in the same script. A guarantee is only tested when the thing it withholds is
demonstrably there to withhold.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
