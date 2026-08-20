// The HTTP API: every route an agent calls, defined once.
//
// A route here carries its handler and its description together, and the two things that
// used to be able to disagree are now the same object. `bunRoutes()` builds the table
// `Bun.serve` is given; `openApiPaths()` builds the `paths` of /openapi.json. Neither can
// name a route the other does not, because neither writes a route down — they both read
// this list.
//
// `doc` is required and nullable rather than optional, which is the whole trick: adding a
// route makes you say what it is or say, in as many words, that it is not an API anybody
// calls. There is exactly one of the latter today and it is spelled out at its entry.
//
// What the projection cannot derive is what a field means. Summaries, descriptions and
// schemas are written here by hand; the guarantee is not that they are right but that
// they are attached to the route they describe, and tests/api-contract.test.ts makes the
// parts of them that are checkable — which fields are required, what a 200 looks like —
// answerable against the running server rather than by reading.

import { config } from "./config";
import { createImage, createVersion, listBundles, listImages, listVersions } from "./db";
import { json, originOk } from "./http";
import { IMG_NAME_RE, processImage, sniffOk, type ProcessedImage } from "./images";
import { SLUG_RE } from "./ids";
import { requireApiKey } from "./auth";
import { inspectZip, saveImage, saveZip } from "./store";
import { handleCreateShare, handleListShares, handleRevokeShare } from "./shares";
import { handleAnnotation } from "./overseer/annotations";
import { handleRefreshReview } from "./overseer/freshness";
import { handleReadReview } from "./overseer/read";
import { handlePublishReview } from "./overseer/routes";
import { handleGithubWebhook } from "./overseer/webhook";
import {
  handleCreateProject,
  handleListProjects,
  handleProjectMembership,
  handleReadProject,
  handleUpdateProject,
  resolveUploadProject,
} from "./projects/api";
import { attachBundle, listProjectsForBundle } from "./projects/db";

// ---- the shape of an entry ----

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Which credentials open a route. Projected into the document's `security`, so the
 *  answer there cannot drift from the answer here — though what actually enforces it is
 *  still the handler, and this is a claim about the handler rather than a gate. */
export type Security = "key" | "keyOrSession" | "public";

/** What the handler is handed besides the request. Only `publish` is used, and it is
 *  named rather than passed as the whole Server so this module never has to know what a
 *  socket carries. */
export interface Publisher {
  publish(topic: string, data: string): unknown;
}

export interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  security: Security;
  parameters?: unknown[];
  requestBody?: unknown;
  /** Keyed by status. The `200` is what the contract test validates a real response
   *  against, so it is the one that has to be true rather than merely plausible. */
  responses: Record<string, unknown>;
}

interface Entry<P extends string> {
  /** `null` says this route is deliberately absent from the API document. Required, so
   *  that absence is a decision somebody made and not a line somebody forgot. */
  doc: Operation | null;
  run: (req: Bun.BunRequest<P>, publish: Publisher) => Response | Promise<Response>;
}

export interface ApiRoute {
  path: string;
  methods: Partial<Record<Method, Entry<string>>>;
}

function route<P extends string>(path: P, methods: Partial<Record<Method, Entry<P>>>): ApiRoute {
  return { path, methods: methods as Partial<Record<Method, Entry<string>>> };
}

// ---- shared pieces of the description ----

const errorResponse = { $ref: "#/components/responses/Error" };
const reviewNotFound = { $ref: "#/components/responses/ReviewNotFound" };

const slugParam = {
  name: "slug",
  in: "path",
  required: true,
  schema: { type: "string", pattern: SLUG_RE.source },
};

/**
 * A browser-reachable mutation. Origin is what proves it came from Seer, and it is a
 * wrapper rather than a line inside each handler so that forgetting it is a visible
 * omission at the route rather than an invisible one three files away.
 *
 * A wrapper is still only a convention — nothing in the types makes you reach for it. So
 * the obligation lives in tests/api-contract.test.ts, which derives the routes that need
 * it (a mutation a session can reach) and sends each one a foreign Origin. A new
 * unguarded mutation fails there rather than shipping.
 */
function guarded<P extends string>(
  run: (req: Bun.BunRequest<P>) => Response | Promise<Response>,
): (req: Bun.BunRequest<P>) => Response | Promise<Response> {
  return (req) => (originOk(req) ? run(req) : new Response("Bad origin", { status: 403 }));
}

// ---- bundles ----

async function uploadBundle(req: Request, slug: string, publish: Publisher): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  if (!SLUG_RE.test(slug)) {
    return json({ error: "Slug must match [a-z0-9][a-z0-9-]{0,63}" }, 400);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return json({ error: "Empty body; send the zip as the request body" }, 400);
  if (body.length > config.maxUploadBytes) {
    return json({ error: `Zip exceeds max size of ${config.maxUploadBytes} bytes` }, 413);
  }

  let files: string[];
  try {
    files = inspectZip(body);
  } catch (err) {
    return json({ error: `Invalid zip: ${(err as Error).message}` }, 400);
  }

  // The key resolves the workspace: the upload lands wherever the key belongs.
  const ws = auth.workspaceId;

  // `?project=` is resolved BEFORE the version is created: a typo'd project must fail
  // the whole upload rather than land the bundle and silently lose the grouping.
  const project = resolveUploadProject(req, ws);
  if (project instanceof Response) return project;

  const version = createVersion(ws, slug, body.length, files.length);
  await saveZip(ws, slug, version, body);
  if (project) attachBundle(project, slug);
  publish.publish(`bundle:${ws}:${slug}`, "reload");

  return json({
    slug,
    version,
    workspace: ws,
    url: `${config.baseUrl}/${ws}/b/${slug}/`,
    versionUrl: `${config.baseUrl}/${ws}/b/${slug}/v/${version}/`,
    bytes: body.length,
    files: files.length,
    hasIndexHtml: files.includes("index.html"),
    projects: listProjectsForBundle(ws, slug).map((p) => p.slug),
  });
}

const uploadBundleDoc: Omit<Operation, "operationId"> = {
  summary: "Publish a bundle, creating its next version",
  description:
    "The body is the raw zip, not multipart. It must contain a root index.html. The key " +
    "resolves the workspace, so the upload lands wherever the key belongs. PUT and POST " +
    "are identical. `?project=<slug>` attaches the bundle to that project in the same " +
    "breath; a project the workspace does not hold refuses the whole upload.",
  security: "key",
  parameters: [
    slugParam,
    {
      name: "project",
      in: "query",
      required: false,
      schema: { type: "string", pattern: SLUG_RE.source },
      description: "A project in this workspace to attach the bundle to.",
    },
  ],
  requestBody: {
    required: true,
    content: { "application/zip": { schema: { type: "string", format: "binary" } } },
  },
  responses: {
    "200": {
      description: "The version that was created, and the two URLs it can be read at.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["slug", "version", "workspace", "url", "versionUrl", "bytes", "files", "hasIndexHtml"],
            properties: {
              slug: { type: "string" },
              version: { type: "integer" },
              workspace: { type: "string" },
              url: { type: "string", format: "uri", description: "Always the latest version." },
              versionUrl: { type: "string", format: "uri", description: "Pinned to this version." },
              bytes: { type: "integer" },
              files: { type: "integer" },
              hasIndexHtml: { type: "boolean" },
              projects: {
                type: "array",
                items: { type: "string" },
                description: "Every project holding this bundle, after any `?project=` attach.",
              },
            },
          },
        },
      },
    },
    "400": errorResponse,
    "401": errorResponse,
    "404": errorResponse,
    "413": errorResponse,
  },
};

// ---- images ----

async function uploadImage(req: Request, filename: string): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  const match = filename.match(IMG_NAME_RE);
  if (!match) {
    return json(
      {
        error:
          "Filename must match [a-z0-9][a-z0-9._-]* (max 64 chars) and end in " +
          ".png, .jpg, .jpeg, .gif, .webp, .avif, or .svg",
      },
      400,
    );
  }
  const ext = match[1]!;

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return json({ error: "Empty body; send the image bytes as the request body" }, 400);
  if (body.length > config.maxUploadBytes) {
    return json({ error: `Image exceeds max size of ${config.maxUploadBytes} bytes` }, 413);
  }
  if (!sniffOk(ext, body)) {
    return json({ error: `Body does not look like a .${ext} file (magic bytes mismatch)` }, 400);
  }

  let img: ProcessedImage;
  try {
    img = await processImage(ext, filename, body);
  } catch (err) {
    return json({ error: `Could not decode image: ${(err as Error).message}` }, 400);
  }

  // Same ordering as bundles: row first, then bytes. The key resolves the workspace.
  const ws = auth.workspaceId;
  const id = createImage(ws, img.filename, img.contentType, img.data.length);
  await saveImage(ws, id, img.data);

  const url = `${config.baseUrl}/${ws}/i/${id}/${img.filename}`;
  return json({
    id,
    filename: img.filename,
    workspace: ws,
    url,
    markdown: `![${img.filename.replace(/\.[^.]+$/, "")}](${url})`,
    bytes: img.data.length,
    originalBytes: body.length,
    contentType: img.contentType,
  });
}

const uploadImageDoc: Omit<Operation, "operationId"> = {
  summary: "Publish a single image",
  description:
    "The body is the raw image bytes. Everything but SVG is re-encoded to WebP on the " +
    "way in. The response carries a markdown snippet, because the reason this route " +
    "exists is getting a screenshot into a pull request body.",
  security: "key",
  parameters: [
    {
      name: "filename",
      in: "path",
      required: true,
      schema: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
    },
  ],
  requestBody: {
    required: true,
    content: Object.fromEntries(
      ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"].map(
        (type) => [type, { schema: { type: "string", format: "binary" } }],
      ),
    ),
  },
  responses: {
    "200": {
      description: "The stored image.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["id", "filename", "workspace", "url", "markdown", "bytes", "originalBytes", "contentType"],
            properties: {
              id: { type: "string" },
              filename: { type: "string" },
              workspace: { type: "string" },
              url: { type: "string", format: "uri" },
              markdown: { type: "string", description: "Paste-ready ![alt](url)." },
              bytes: { type: "integer" },
              originalBytes: { type: "integer" },
              contentType: { type: "string" },
            },
          },
        },
      },
    },
    "400": errorResponse,
    "401": errorResponse,
    "413": errorResponse,
  },
};

// ---- projects ----

const PROJECT_STATUS_ENUM = { type: "string", enum: ["open", "done", "closed"] };

/** The state object: what create, read and update all answer with, and the reason one
 *  call is enough to resume — the whole project comes back every time it changes. */
const projectStateSchema = {
  type: "object",
  required: [
    "slug", "title", "description", "status", "parent", "workspace", "url",
    "createdAt", "updatedAt", "children", "bundles", "reviews",
  ],
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    description: { type: "string", description: "Constrained markdown, as authored." },
    status: PROJECT_STATUS_ENUM,
    parent: { type: ["string", "null"], description: "The parent project's slug, or null." },
    workspace: { type: "string" },
    url: { type: "string", format: "uri", description: "The human page; it answers markdown to Accept: text/markdown." },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    children: {
      type: "array",
      description: "Shallow summaries, never recursive.",
      items: {
        type: "object",
        required: ["slug", "title", "status", "bundles", "reviews"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          status: PROJECT_STATUS_ENUM,
          bundles: { type: "integer" },
          reviews: { type: "integer" },
        },
      },
    },
    bundles: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "latestVersion", "updatedAt", "url"],
        properties: {
          slug: { type: "string" },
          latestVersion: { type: "integer" },
          updatedAt: { type: "string", format: "date-time" },
          url: { type: "string", format: "uri" },
        },
      },
    },
    reviews: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "title", "latestVersion", "publishedAt", "url"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          latestVersion: { type: "integer" },
          publishedAt: { type: "string", format: "date-time" },
          url: { type: "string", format: "uri" },
        },
      },
    },
  },
};

const projectStateResponse = {
  description: "The project's whole state, one call.",
  content: { "application/json": { schema: projectStateSchema } },
};

/** One membership operation's doc. The four share everything but their nouns, and a
 *  builder keeps the four descriptions from drifting apart one edit at a time. */
function membershipDoc(kind: "bundle" | "review", act: "attach" | "detach"): Omit<Operation, "operationId"> {
  const flag = act === "attach" ? "attached" : "detached";
  return {
    summary: `${act === "attach" ? "Attach" : "Detach"} one ${kind}`,
    description:
      `Idempotent: \`${flag}\` says whether this call changed anything, and repeating ` +
      `it changes nothing and says so. The ${kind} must live in the key's workspace.`,
    security: "key",
    parameters: [
      slugParam,
      {
        name: kind,
        in: "path",
        required: true,
        schema: { type: "string", pattern: SLUG_RE.source },
      },
    ],
    responses: {
      "200": {
        description: `The membership, after this call.`,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["project", kind, flag],
              properties: {
                project: { type: "string" },
                [kind]: { type: "string" },
                [flag]: { type: "boolean" },
              },
            },
          },
        },
      },
      "401": errorResponse,
      "404": errorResponse,
    },
  };
}

// ---- the table ----

export const API_ROUTES: readonly ApiRoute[] = [
  route("/api/bundles", {
    GET: {
      doc: {
        operationId: "listBundles",
        summary: "The bundles in this key's workspace",
        security: "key",
        responses: {
          "200": {
            description: "Every bundle, with its version history.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["slug", "latestVersion", "workspace", "url", "versions"],
                    properties: {
                      slug: { type: "string" },
                      latestVersion: { type: "integer" },
                      workspace: { type: "string" },
                      url: { type: "string", format: "uri" },
                      versions: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["version", "createdAt", "bytes", "files"],
                          properties: {
                            version: { type: "integer" },
                            createdAt: { type: "string", format: "date-time" },
                            bytes: { type: "integer" },
                            files: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse,
        },
      },
      run: (req) => {
        const auth = requireApiKey(req);
        if (auth instanceof Response) return auth;
        const ws = auth.workspaceId;
        return json(
          listBundles(ws).map((b) => ({
            slug: b.slug,
            latestVersion: b.latest_version,
            workspace: ws,
            url: `${config.baseUrl}/${ws}/b/${b.slug}/`,
            versions: listVersions(ws, b.slug).map((v) => ({
              version: v.version,
              createdAt: new Date(v.created_at).toISOString(),
              bytes: v.bytes,
              files: v.file_count,
            })),
          })),
        );
      },
    },
  }),

  route("/api/bundles/:slug", {
    PUT: {
      doc: { operationId: "publishBundle", ...uploadBundleDoc },
      run: (req, publish) => uploadBundle(req, req.params.slug, publish),
    },
    // The same operation. Only the id has to differ, because two operations may not
    // share one.
    POST: {
      doc: { operationId: "publishBundleViaPost", ...uploadBundleDoc },
      run: (req, publish) => uploadBundle(req, req.params.slug, publish),
    },
  }),

  route("/api/images", {
    GET: {
      doc: {
        operationId: "listImages",
        summary: "The images in this key's workspace",
        security: "key",
        responses: {
          "200": {
            description: "Every image.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["id", "filename", "workspace", "url", "bytes", "contentType", "createdAt"],
                    properties: {
                      id: { type: "string" },
                      filename: { type: "string" },
                      workspace: { type: "string" },
                      url: { type: "string", format: "uri" },
                      bytes: { type: "integer" },
                      contentType: { type: "string" },
                      createdAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse,
        },
      },
      run: (req) => {
        const auth = requireApiKey(req);
        if (auth instanceof Response) return auth;
        const ws = auth.workspaceId;
        return json(
          listImages(ws).map((i) => ({
            id: i.id,
            filename: i.filename,
            workspace: ws,
            url: `${config.baseUrl}/${ws}/i/${i.id}/${i.filename}`,
            bytes: i.bytes,
            contentType: i.content_type,
            createdAt: new Date(i.created_at).toISOString(),
          })),
        );
      },
    },
  }),

  route("/api/images/:filename", {
    PUT: {
      doc: { operationId: "publishImage", ...uploadImageDoc },
      run: (req) => uploadImage(req, req.params.filename),
    },
    POST: {
      doc: { operationId: "publishImageViaPost", ...uploadImageDoc },
      run: (req) => uploadImage(req, req.params.filename),
    },
  }),

  // Projects: the grouping. Agent-first writes behind the key; reads answer to a key
  // or a session, because the page and the agent hold the same slug.
  route("/api/projects", {
    POST: {
      doc: {
        operationId: "createProject",
        summary: "Create a project",
        description:
          "A project groups the work: bundles, reviews, and later tasks and notes, " +
          "outside any repo. `parent` nests it one level under another project. The " +
          "model is docs/projects/data-model.md in the source tree.",
        security: "key",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug", "title"],
                properties: {
                  slug: { type: "string", pattern: SLUG_RE.source },
                  title: { type: "string", maxLength: 80 },
                  description: {
                    type: "string",
                    description: "Constrained markdown: emphasis, inline code, links, lists, fenced code.",
                  },
                  parent: {
                    type: ["string", "null"],
                    description: "Slug of an existing top-level project to nest under.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": projectStateResponse,
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      run: (req) => handleCreateProject(req),
    },
    GET: {
      doc: {
        operationId: "listProjects",
        summary: "The projects in this key's workspace",
        security: "key",
        responses: {
          "200": {
            description: "Every project, most recently touched first, with its counts.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: [
                      "slug", "title", "status", "parent", "workspace", "url",
                      "updatedAt", "bundles", "reviews", "children",
                    ],
                    properties: {
                      slug: { type: "string" },
                      title: { type: "string" },
                      status: PROJECT_STATUS_ENUM,
                      parent: { type: ["string", "null"] },
                      workspace: { type: "string" },
                      url: { type: "string", format: "uri" },
                      updatedAt: { type: "string", format: "date-time" },
                      bundles: { type: "integer" },
                      reviews: { type: "integer" },
                      children: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse,
        },
      },
      run: (req) => handleListProjects(req),
    },
  }),

  route("/api/projects/:slug", {
    GET: {
      doc: {
        operationId: "readProject",
        summary: "Everything one project holds, in one call",
        description:
          "The re-entry point: description, sub-projects, bundles, reviews. An agent " +
          "resuming a project reads this one URL. A key reads its own workspace; a " +
          "session reads across the caller's memberships.",
        security: "keyOrSession",
        parameters: [slugParam],
        responses: {
          "200": projectStateResponse,
          "404": errorResponse,
        },
      },
      run: (req) => handleReadProject(req, req.params.slug),
    },
    PATCH: {
      doc: {
        operationId: "updateProject",
        summary: "Update a project's title, description, status, or parent",
        description:
          "Send only what changes. Status is one of open, done, closed; transitions " +
          "are recorded by Seer with their timestamps. `parent: null` detaches.",
        security: "key",
        parameters: [slugParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", maxLength: 80 },
                  description: { type: "string" },
                  status: PROJECT_STATUS_ENUM,
                  parent: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        responses: {
          "200": projectStateResponse,
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      run: (req) => handleUpdateProject(req, req.params.slug),
    },
  }),

  route("/api/projects/:slug/bundles/:bundle", {
    PUT: {
      doc: { operationId: "attachProjectBundle", ...membershipDoc("bundle", "attach") },
      run: (req) => handleProjectMembership(req, req.params.slug, "bundle", req.params.bundle, "attach"),
    },
    DELETE: {
      doc: { operationId: "detachProjectBundle", ...membershipDoc("bundle", "detach") },
      run: (req) => handleProjectMembership(req, req.params.slug, "bundle", req.params.bundle, "detach"),
    },
  }),

  route("/api/projects/:slug/reviews/:review", {
    PUT: {
      doc: { operationId: "attachProjectReview", ...membershipDoc("review", "attach") },
      run: (req) => handleProjectMembership(req, req.params.slug, "review", req.params.review, "attach"),
    },
    DELETE: {
      doc: { operationId: "detachProjectReview", ...membershipDoc("review", "detach") },
      run: (req) => handleProjectMembership(req, req.params.slug, "review", req.params.review, "detach"),
    },
  }),

  // Overseer: a review is authored in one shot, so publishing is one POST.
  route("/api/reviews", {
    POST: {
      doc: {
        operationId: "publishReview",
        summary: "Publish a review of one or more pull requests",
        description:
          "The payload names pull requests and supplies judgment; Overseer derives every " +
          "fact — files, hunks, line numbers, SHAs — from GitHub itself and refuses a claim " +
          "that does not stand on them. Send JSON, or multipart/form-data with a `document` " +
          "part plus one part per attachment. Republishing the same slug keeps the URL and " +
          "shows what moved. The document format is long and is specified in full at " +
          `${config.baseUrl}/overseer/skill.md — author against that, not against this summary.`,
        security: "key",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug", "prs"],
                properties: {
                  slug: { type: "string", pattern: SLUG_RE.source },
                  prs: {
                    type: "array",
                    description: "Pull request pointers, as owner/repo#number or an equivalent object.",
                    items: {},
                  },
                },
                additionalProperties: true,
              },
            },
            "multipart/form-data": {
              schema: { type: "object", properties: { document: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "The published version, its URLs, what it spent, and any warnings.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["slug", "version", "workspace", "url", "versionUrl", "warnings", "usage", "document"],
                  properties: {
                    slug: { type: "string" },
                    version: { type: "integer" },
                    workspace: { type: "string" },
                    url: { type: "string", format: "uri" },
                    versionUrl: { type: "string", format: "uri" },
                    warnings: { type: "array", items: { type: "object" } },
                    usage: { type: "object" },
                    document: { type: "object" },
                  },
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "413": errorResponse,
          "422": errorResponse,
          "502": errorResponse,
        },
      },
      run: (req) => handlePublishReview(req),
    },
  }),

  // Reading takes a bare slug, resolved across the caller's workspaces: the renderer and
  // the witness both hold a slug, not a workspace id.
  route("/api/reviews/:slug", {
    GET: {
      doc: {
        operationId: "readReview",
        summary: "Read the current version of a review",
        security: "keyOrSession",
        parameters: [slugParam],
        responses: {
          "200": {
            description:
              "The stored document, plus the annotations and freshness that move on their own.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["document", "version", "latestVersion"],
                  properties: {
                    document: { type: "object" },
                    version: { type: "integer" },
                    latestVersion: { type: "integer" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "404": reviewNotFound,
        },
      },
      run: (req) => handleReadReview(req, req.params.slug, null),
    },
  }),

  route("/api/reviews/:slug/v/:n", {
    GET: {
      doc: {
        operationId: "readReviewVersion",
        summary: "Read a prior version of a review",
        security: "keyOrSession",
        parameters: [
          slugParam,
          { name: "n", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": {
            description: "That version.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["document", "version", "latestVersion"],
                  properties: {
                    document: { type: "object" },
                    version: { type: "integer" },
                    latestVersion: { type: "integer" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          "404": reviewNotFound,
        },
      },
      run: (req) => handleReadReview(req, req.params.slug, req.params.n),
    },
  }),

  // The one thing written to a review after publication. A member files, an API key
  // answers, and the route decides which by the body it was sent.
  route("/api/reviews/:slug/annotations", {
    POST: {
      doc: {
        operationId: "annotateReview",
        summary: "File a question on a review, or answer one",
        description:
          "Two acts, told apart by whether `answer` is present. Filing is a reader's and " +
          "takes a signed-in member; answering is the witness's and takes the API key. A " +
          "body with no `answer` is read as a filing, whatever else is in it.",
        security: "keyOrSession",
        parameters: [slugParam],
        requestBody: {
          required: true,
          // The two acts have disjoint field sets, and `answer` present is what picks
          // between them, so they are two schemas rather than one with everything
          // optional: a reader of this document has to be able to tell which fields go
          // together, and a flattened object would let them send half of each.
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "File a question",
                    type: "object",
                    required: ["target", "body"],
                    properties: {
                      target: {
                        type: "object",
                        required: ["type", "id"],
                        properties: {
                          type: {
                            type: "string",
                            description: "What kind of thing on the page is being asked about.",
                          },
                          id: { type: "string", description: "That thing's id in the published document." },
                        },
                      },
                      body: { type: "string", description: "The question." },
                      quote: { type: "string", description: "Optional: the text on the page it hangs off." },
                    },
                  },
                  {
                    title: "Answer an open question",
                    type: "object",
                    required: ["id", "answer"],
                    properties: {
                      id: { type: "string", description: "The annotation being answered." },
                      answer: {
                        type: "object",
                        required: ["body"],
                        properties: {
                          body: { type: "string" },
                          refs: {
                            type: "array",
                            description:
                              "Optional code references, resolved exactly as a published document's are.",
                            items: {},
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                description: "The page's own form. A form files; it never answers.",
                required: ["target", "body"],
                properties: {
                  target: { type: "string", description: "`<type>:<id>`, split on the first colon." },
                  target_type: { type: "string", description: "The two halves separately, instead of `target`." },
                  target_id: { type: "string" },
                  body: { type: "string" },
                  quote: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The annotation.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": errorResponse,
          "403": errorResponse,
          "404": reviewNotFound,
          "422": errorResponse,
        },
      },
      run: guarded((req) => handleAnnotation(req, req.params.slug)),
    },
  }),

  // Origin-checked like every other browser-reachable POST. It was not, and a button on
  // the review page then pointed at it — so any page a signed-in member visited could
  // spend their GitHub calls for them. The window bounds the damage to one check a minute
  // per review rather than making it harmless.
  route("/api/reviews/:slug/refresh", {
    POST: {
      doc: {
        operationId: "refreshReview",
        summary: "Re-read the pull requests behind a review from GitHub",
        description:
          "Rate limited to one check a minute per review, and it spends the caller's GitHub budget.",
        security: "keyOrSession",
        parameters: [slugParam],
        responses: {
          "200": {
            description: "What changed.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "403": errorResponse,
          "404": reviewNotFound,
          "429": errorResponse,
        },
      },
      run: guarded((req) => handleRefreshReview(req, req.params.slug)),
    },
  }),

  // Minting and revoking. The mint answers with the full /s/<token> URL, because the URL
  // is the thing a person wants; the list answers without tokens, because only their
  // hashes survived the mint.
  route("/api/shares", {
    GET: {
      doc: {
        operationId: "listShares",
        summary: "The live share links a workspace has minted",
        description: "Never carries a token: only their hashes survived the mint.",
        security: "keyOrSession",
        parameters: [
          { name: "workspace", in: "query", required: false, schema: { type: "string", pattern: "^ws_" } },
        ],
        responses: {
          "200": {
            description: "The shares.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["workspace", "shares"],
                  properties: {
                    workspace: { type: "string" },
                    shares: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["id", "kind", "target", "label", "createdBy", "createdAt", "expiresAt"],
                        properties: {
                          id: { type: "string" },
                          kind: { type: "string", enum: ["bundle", "review"] },
                          target: { type: "string" },
                          label: { type: "string" },
                          createdBy: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
                          expiresAt: { type: ["string", "null"], format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse,
          "403": errorResponse,
        },
      },
      run: (req) => handleListShares(req),
    },
    POST: {
      doc: {
        operationId: "createShare",
        summary: "Mint one revocable, read-only link to one bundle or review",
        description: "The token comes back exactly once, in `url`. It is not recoverable after.",
        security: "keyOrSession",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["kind", "target"],
                properties: {
                  workspace: { type: "string" },
                  kind: { type: "string", enum: ["bundle", "review"] },
                  target: { type: "string", pattern: SLUG_RE.source },
                  label: { type: "string" },
                  expiresAt: {
                    description: "An ISO instant, a day count, or null for never.",
                    anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The share, with its one-time token.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "workspace", "kind", "target", "label", "expiresAt", "token", "url"],
                  properties: {
                    id: { type: "string" },
                    workspace: { type: "string" },
                    kind: { type: "string", enum: ["bundle", "review"] },
                    target: { type: "string" },
                    label: { type: "string" },
                    expiresAt: { type: ["integer", "null"] },
                    token: { type: "string" },
                    url: { type: "string", format: "uri" },
                  },
                },
              },
            },
          },
          "400": errorResponse,
          "401": errorResponse,
          "403": errorResponse,
          "422": errorResponse,
        },
      },
      run: guarded((req) => handleCreateShare(req)),
    },
  }),

  route("/api/shares/:id", {
    DELETE: {
      doc: {
        operationId: "revokeShare",
        summary: "Revoke a share",
        description: "The link stops opening, and any page already open on it loses its live channel.",
        security: "keyOrSession",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^shr_" } }],
        responses: {
          "200": {
            description: "Revoked.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "revoked"],
                  properties: { id: { type: "string" }, revoked: { type: "boolean" } },
                },
              },
            },
          },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
        },
      },
      run: guarded((req) => handleRevokeShare(req, req.params.id)),
    },
  }),

  // The one route under /api/ that is not an API anybody calls, and the reason `doc` is
  // nullable rather than optional. GitHub posts here. It carries no Seer credential, it
  // authenticates an HMAC over the raw body, and an agent that found it in a service
  // description could do nothing with it but be confused.
  //
  // Deliberately NO origin guard, and this comment is here so the next person reading the
  // table does not add one and break it: originOk() passes when Origin and Referer are
  // both absent, GitHub is not a browser and sends neither, and it cannot hold a Seer
  // credential. The HMAC is the whole of this route's authentication and is the right
  // amount.
  route("/api/github/webhook", {
    POST: { doc: null, run: (req) => handleGithubWebhook(req) },
  }),
];

// ---- the two projections ----

/** What `Bun.serve` calls. The second argument is the Server, and `Publisher` is the
 *  slice of it any of these handlers wants — so the table can be built without this
 *  module knowing what a socket on this server carries. */
type BunHandler = (req: never, server: Publisher) => Response | Promise<Response>;

/** The table `Bun.serve` is given. The Server it hands each handler is passed on as the
 *  publisher, which is all any of them wants from it. */
export function bunRoutes(): Record<string, Record<string, BunHandler>> {
  const table: Record<string, Record<string, BunHandler>> = {};
  for (const { path, methods } of API_ROUTES) {
    const byMethod: Record<string, BunHandler> = {};
    for (const [method, entry] of Object.entries(methods)) {
      byMethod[method] = (req, server) => entry.run(req, server);
    }
    table[path] = byMethod;
  }
  return table;
}

const SECURITY: Record<Security, unknown[]> = {
  key: [{ apiKey: [] }],
  keyOrSession: [{ apiKey: [] }, { session: [] }],
  public: [],
};

/** The `paths` of the OpenAPI document. Bun writes a path parameter `:slug`; OpenAPI
 *  writes it `{slug}`, and that substitution is the only difference between the two
 *  spellings of this list. */
export function openApiPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { path, methods } of API_ROUTES) {
    const operations: Record<string, unknown> = {};
    for (const [method, entry] of Object.entries(methods)) {
      if (entry.doc === null) continue;
      const { security, ...rest } = entry.doc;
      operations[method.toLowerCase()] = { ...rest, security: SECURITY[security] };
    }
    if (Object.keys(operations).length > 0) {
      paths[path.replace(/:([^/]+)/g, "{$1}")] = operations;
    }
  }
  return paths;
}
