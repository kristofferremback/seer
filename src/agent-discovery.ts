// What Seer says about itself to something that is not a person.
//
// Everything in this file is a description of machinery that already exists elsewhere in
// the repo: the robots rules describe the access posture the route table enforces, the
// OpenAPI document describes the routes in server.ts, the skills index points at the four
// documents Seer already serves. That is the whole rule for what belongs here. A
// discovery document that advertises an endpoint this deployment does not answer costs an
// agent a round trip and a retry, so the standards Seer cannot honestly satisfy are
// absent rather than stubbed — there is no OAuth authorization server behind an
// `/.well-known/oauth-authorization-server`, no MCP transport behind a server card, and no
// A2A service behind an agent card, so none of those three is published. See auth.md,
// which says so in prose to the agent that came looking for the OAuth flow.
//
// The one thing here that is not a description is the Content-Signal line, which is a
// preference rather than a fact: training on what people park here is refused, answering
// a question someone actually asked with it is not.

import { openApiPaths } from "./api";
import { config } from "./config";
import { projectsSkillDoc, skillDoc, skillRouter } from "./pages";
import { overseerAgentText, overseerSkillText } from "./overseer/skill";

/** The documents that are public by intent — the front page and the four an agent reads
 *  before it publishes anything. The sitemap lists these and nothing else: every other
 *  URL Seer serves belongs to one workspace, and a bundle is a half-finished page put
 *  here to be looked at once rather than a page anybody meant to index. */
const PUBLIC_DOCS: readonly { path: string; changefreq: string; priority: string }[] = [
  { path: "/", changefreq: "monthly", priority: "1.0" },
  { path: "/skill.md", changefreq: "weekly", priority: "0.9" },
  { path: "/llms.txt", changefreq: "weekly", priority: "0.9" },
  { path: "/bundles/skill.md", changefreq: "weekly", priority: "0.8" },
  { path: "/projects/skill.md", changefreq: "weekly", priority: "0.8" },
  { path: "/overseer/agent.md", changefreq: "weekly", priority: "0.8" },
  { path: "/overseer/skill.md", changefreq: "weekly", priority: "0.8" },
  { path: "/auth.md", changefreq: "monthly", priority: "0.5" },
];

// ---- robots ----

/**
 * robots.txt (RFC 9309), carrying Content-Signal preferences (contentsignals.org).
 *
 * The Disallow list is not a security boundary — every path on it already refuses a
 * stranger, and the ones that answer a soft-404 do so precisely so that a refusal and an
 * absence are indistinguishable. It is here so a crawler does not have to discover that
 * one request at a time.
 *
 * Group two is the opt-out tokens: the crawlers whose stated purpose is building a
 * training corpus. Reading a page to answer a question someone actually asked is the
 * thing this site is for and stays allowed above; harvesting someone's half-finished
 * preview into a corpus is not, and those two uses have different user agents.
 */
export function robotsTxt(): string {
  const base = config.baseUrl;
  return `# Seer — ${base}
#
# Public: this front page, and the documents an agent reads before it publishes.
# Private: every ledger, every review, every settings page, every share link. Those
# refuse a stranger on their own; the rules below are so a crawler does not have to
# find that out one request at a time.

User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /
Allow: /skill.md
Allow: /llms.txt
Allow: /auth.md
Allow: /openapi.json
Allow: /bundles/skill.md
Allow: /projects/skill.md
Allow: /overseer/skill.md
Allow: /overseer/agent.md
Allow: /.well-known/
Disallow: /api/
Disallow: /auth/
Disallow: /bundles$
Disallow: /github/
Disallow: /invite/
Disallow: /login
Disallow: /reviews
Disallow: /s/
Disallow: /settings/
Disallow: /r/
Disallow: /*/r/

# A bundle is someone's half-finished page, published here to be looked at once. It is
# not a corpus. These are the agents whose stated purpose is collecting one; the ones
# that fetch a page because a person asked a question are covered by the group above and
# are welcome.
#
# What is withheld here is what people put here, not what this site says about itself.
# So the documents below stay open even to these: they are Seer's own instructions,
# written to be read by an agent, and refusing them to the agents most likely to be
# holding a reader's question would be this file working against the rest of the change.
User-agent: anthropic-ai
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: CCBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: GPTBot
User-agent: meta-externalagent
Content-Signal: search=no, ai-input=no, ai-train=no
Allow: /$
Allow: /skill.md
Allow: /llms.txt
Allow: /auth.md
Allow: /openapi.json
Allow: /bundles/skill.md
Allow: /projects/skill.md
Allow: /overseer/skill.md
Allow: /overseer/agent.md
Allow: /.well-known/
Disallow: /

Sitemap: ${base}/sitemap.xml
`;
}

// ---- sitemap ----

/** The public documents, as the sitemaps.org protocol wants them. No bundle and no
 *  review is in here, deliberately: see PUBLIC_DOCS. */
export function sitemapXml(): string {
  const base = config.baseUrl;
  const urls = PUBLIC_DOCS.map(
    (doc) => `  <url>
    <loc>${base}${doc.path}</loc>
    <changefreq>${doc.changefreq}</changefreq>
    <priority>${doc.priority}</priority>
  </url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ---- Link headers ----

/**
 * The front page's Link header (RFC 8288), the shortest path from "an agent found the
 * homepage" to "an agent knows what this deployment can do". One header with
 * comma-separated values rather than several: both are legal, and one survives every
 * proxy that has an opinion about repeated headers.
 *
 * `service-doc` is the routing document rather than the bundle one, because that is the
 * page that says which of the two capabilities the reader wants.
 */
export function homepageLinkHeader(): string {
  return [
    `</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
    `</openapi.json>; rel="service-desc"; type="application/json"`,
    `</skill.md>; rel="service-doc"; type="text/markdown"`,
    `</skill.md>; rel="alternate"; type="text/markdown"`,
    `</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"`,
    `</auth.md>; rel="describedby"; type="text/markdown"`,
    `</healthz>; rel="status"`,
  ].join(", ");
}

// ---- API catalog ----

/** `/.well-known/api-catalog` (RFC 9727), as an RFC 9264 linkset. One API, three links:
 *  the machine description, the document a human or an agent reads, and the health
 *  endpoint that says whether any of it is up. */
export function apiCatalog(): unknown {
  const base = config.baseUrl;
  return {
    linkset: [
      {
        anchor: `${base}/api`,
        "service-desc": [
          { href: `${base}/openapi.json`, type: "application/json", title: "Seer HTTP API (OpenAPI 3.1)" },
        ],
        "service-doc": [
          { href: `${base}/skill.md`, type: "text/markdown", title: "What Seer does, and which document to read next" },
          { href: `${base}/bundles/skill.md`, type: "text/markdown", title: "Publishing an HTML bundle" },
          { href: `${base}/projects/skill.md`, type: "text/markdown", title: "Grouping work into projects" },
          { href: `${base}/overseer/agent.md`, type: "text/markdown", title: "Dispatching a pull request review" },
        ],
        "service-meta": [
          { href: `${base}/auth.md`, type: "text/markdown", title: "How an agent gets a credential" },
        ],
        status: [{ href: `${base}/healthz`, type: "text/plain", title: "Health" }],
      },
    ],
  };
}

// ---- OpenAPI ----

/**
 * The HTTP API, described.
 *
 * The `paths` are not written here. They are projected from `src/api.ts`, which is the
 * same list `Bun.serve` is handed its route table from — so this document cannot name a
 * route the server does not answer, and the server cannot answer an /api/ route this
 * document has not been made to say something about. That used to be two literals kept
 * in step by a test; the test could only report drift after somebody wrote it.
 *
 * What is left here is what is true of the API as a whole rather than of any one route:
 * who it is, where it is, the two credentials, and the two failure shapes most of the
 * routes answer with.
 *
 * Only the credential-bearing API is in here. The pages, the share read path and the
 * GitHub callbacks are not an API an agent calls; they are a browser's.
 */
export function openApiSpec(): unknown {
  const base = config.baseUrl;
  return {
    openapi: "3.1.0",
    info: {
      title: "Seer",
      version: "1.0.0",
      summary: "Publish HTML bundles and pull request reviews an agent builds and a human reads.",
      description:
        "Seer holds two things a person is meant to look at: self-contained HTML bundles an " +
        "agent built, and Overseer reviews of GitHub pull requests. Every write takes a " +
        "workspace API key, and the key is what decides which workspace the thing lands in — " +
        "no call names a workspace itself. Full prose instructions live at " +
        `${base}/skill.md; how to get a key is at ${base}/auth.md.`,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: base }],
    externalDocs: { url: `${base}/skill.md`, description: "Seer's instructions for agents" },
    security: [{ apiKey: [] }],
    components: {
      responses: {
        Error: {
          description: "The call was refused; the body says why.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string" },
                  errors: {
                    type: "array",
                    description: "Field-level validation failures, on the publish and share paths.",
                    items: {
                      type: "object",
                      properties: {
                        field: { type: "string" },
                        rule: { type: "string" },
                        message: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ReviewNotFound: {
          description:
            "No review this caller may read. A slug that does not exist, one in another " +
            "workspace, and a version out of range are one answer with one set of bytes.",
          content: {
            "application/json": {
              schema: { type: "object", properties: { error: { type: "string" } } },
            },
          },
        },
      },
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A workspace API key, `seer_sk_…`, sent as `Authorization: Bearer <key>`. A human " +
            "mints one at /settings/<workspace>, where it is shown exactly once. The key " +
            "belongs to one workspace and one person.",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "seer_session",
          description:
            "A signed-in member's browser session. The read and annotation paths accept it " +
            "beside an API key, because a person reads a review in a browser.",
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          operationId: "health",
          summary: "Liveness",
          security: [],
          responses: {
            "200": { description: "ok", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },
      ...openApiPaths(),
    },
  };
}

// ---- agent skills index ----

/** One entry of the skills index, per the Agent Skills Discovery RFC v0.2.0. */
interface SkillEntry {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: string;
}

function sha256(text: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
}

/**
 * `/.well-known/agent-skills/index.json`.
 *
 * The digests are taken over the bytes this deployment actually serves rather than over
 * the committed file, which matters because two of the four documents have their host
 * substituted on the way out: a digest of the repo copy would be wrong on every
 * deployment but the canonical one, and a digest that never matches is worse than none.
 */
export async function agentSkillsIndex(): Promise<unknown> {
  const base = config.baseUrl;
  const skills: SkillEntry[] = [
    {
      name: "seer",
      type: "skill-md",
      description:
        "Publish to Seer: HTML bundles a human can open in a browser, and Overseer reviews of " +
        "GitHub pull requests. Routes to the document for whichever you were asked to do.",
      url: `${base}/skill.md`,
      digest: sha256(skillRouter()),
    },
    {
      name: "seer-bundles",
      type: "skill-md",
      description:
        "Zip a self-contained HTML page, PUT it to Seer, and hand back a versioned URL that " +
        "live-reloads when you push the next build.",
      url: `${base}/bundles/skill.md`,
      digest: sha256(skillDoc()),
    },
    {
      name: "seer-projects",
      type: "skill-md",
      description:
        "Group the work around one thing being built — bundles, reviews, sub-projects — into a " +
        "project that outlives the session, and resume it by reading one URL.",
      url: `${base}/projects/skill.md`,
      digest: sha256(projectsSkillDoc()),
    },
  ];

  // The two documents that live on disk. A deployment missing one of them serves a 500 at
  // its own URL, and listing it here with a digest of nothing would be the index telling
  // an agent to go fetch that 500. Left out instead.
  const overseerAgent = await overseerAgentText();
  if (overseerAgent !== null) {
    skills.push({
      name: "seer-overseer",
      type: "skill-md",
      description:
        "Dispatch a blind sub-agent to review one or more GitHub pull requests and publish the " +
        "result as a page a human reads instead of the diff. Install this one.",
      url: `${base}/overseer/agent.md`,
      digest: sha256(overseerAgent),
    });
  }
  const overseerSkill = await overseerSkillText();
  if (overseerSkill !== null) {
    skills.push({
      name: "seer-overseer-witness",
      type: "skill-md",
      description:
        "What the dispatched sub-agent reads: how to author and publish an Overseer review. " +
        "Read by the witness at review time, not installed by a person.",
      url: `${base}/overseer/skill.md`,
      digest: sha256(overseerSkill),
    });
  }

  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    version: "0.2.0",
    skills,
  };
}

// ---- auth.md ----

/**
 * `/auth.md` (workos.com/auth-md): how an agent gets a credential here.
 *
 * The standard's preferred shape is a pointer at OAuth metadata, and its fallback is a
 * self-contained document for a service without an authorization server. Seer is the
 * fallback case and this document says so plainly, because the agent most likely to fetch
 * this page is one that has just failed to find `/.well-known/oauth-authorization-server`
 * and is deciding whether to keep looking.
 */
export function authMd(): string {
  const base = config.baseUrl;
  return `# auth.md

How an agent authenticates to Seer at ${base}.

## There is no OAuth here, and no self-registration

Seer issues one kind of credential: a long-lived workspace API key. There is no
authorization server, no token endpoint, no JWKS, and no dynamic client registration, so
\`/.well-known/oauth-authorization-server\`, \`/.well-known/openid-configuration\` and
\`/.well-known/oauth-protected-resource\` are all absent rather than empty. If you came
here after a failed discovery fetch, this is the end of that search: stop looking and read
the rest of this page.

An agent cannot enrol itself. A key is minted by a signed-in human, and that is deliberate
— a key spends its owner's GitHub access when it publishes a review, so it is a person's
credential lent to an agent rather than an identity of the agent's own.

## Getting a key

A human does this once, in a browser:

1. Sign in at \`${base}/login\` (Google OIDC).
2. Open the workspace's settings at \`${base}/settings/<workspace>\`.
3. Mint a key. It is shown exactly once, at mint, and only its hash is stored — there is
   no way to read it back, only to roll or revoke it.
4. They put it in your environment, conventionally as \`SEER_API_KEY\`.

Keys look like \`seer_sk_…\`. A key belongs to **one workspace and one person**. Which key
you send is which workspace you publish into; no call names a workspace itself. Someone in
several workspaces holds one key per workspace.

## Using it

Bearer, in the Authorization header. That is the only supported method — no query
parameter, no cookie, no body field.

\`\`\`sh
curl -X PUT --data-binary @bundle.zip \\
  -H "Authorization: Bearer $SEER_API_KEY" \\
  ${base}/api/bundles/your-slug
\`\`\`

| you get | it means |
|---|---|
| \`401\` | no key, or a key that does not resolve. Ask the human for a new one; do not retry. |
| \`403\` | the act needs a signed-in person rather than a key. Filing a question on a review is the one that does. |
| \`404\` | the thing is not in your key's workspace. It may exist in another; this reply will not say. |

Browser sessions are the other credential, and they are a person's, not yours. The read
paths accept either; every write that an agent makes takes the key.

## What a key can reach

Everything under \`/api/\`, scoped to that key's workspace: publishing and listing bundles
and images, publishing and reading reviews, answering annotations, and minting or revoking
share links. The full API is described at \`${base}/openapi.json\`, catalogued at
\`${base}/.well-known/api-catalog\`, and explained in prose at \`${base}/skill.md\`.

Revocation is the human's, at the same settings page. A revoked key stops resolving
immediately; a rolled one returns a new secret and the old one dies with it.
`;
}
