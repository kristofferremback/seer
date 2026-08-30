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
import {
  createImage,
  createVersion,
  getBundle,
  listBundles,
  listImages,
  listVersions,
  type BundleKind,
} from "./db";
import { json, originOk } from "./http";
import { IMG_NAME_RE, processImage, sniffOk, type ProcessedImage } from "./images";
import { RAC_ID_RE, RLN_ID_RE, RVR_ID_RE, SLUG_RE, STA_ID_RE, STF_ID_RE, STG_ID_RE, WTR_ID_RE } from "./ids";
import { requireApiKey } from "./auth";
import { inspectZip, readZipEntry, saveImage, saveZip } from "./store";
import { handleCreateShare, handleListShares, handleRevokeShare } from "./shares";
import { handleAnnotation } from "./overseer/annotations";
import { handleRefreshReview } from "./overseer/freshness";
import { handleReadReview } from "./overseer/read";
import { handlePublishReview } from "./overseer/routes";
import { handleGithubWebhook } from "./overseer/webhook";
import {
  handleCreateNote,
  handleCreateProject,
  handleCreateTask,
  handleListProjectNotes,
  handleListProjects,
  handleProjectMembership,
  handleReadProject,
  handleUpdateProject,
  handleUpdateTask,
  resolveUploadProject,
} from "./projects/api";
import { attachBundle, listProjectsForBundle } from "./projects/db";
import { handleCreateStageCapture, handleReadStageCapture, handleReadStageObject } from "./stage/source";
import { handlePublishStage, handleReadStage } from "./stage/publish";
import { handleStageLines } from "./stage/read";
import {
  handleCreateReviewLineage,
  handleFailWitnessRequest,
  handlePublishReviewAccount,
  handleReadReviewLineage,
  handleReadReviewRevision,
  handleRetryWitnessRequest,
} from "./overseer/revision-routes";
import { handleRevisionLines } from "./overseer/revision-read";

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

  // `?kind=` is settled at first upload and immutable after. A later upload naming a
  // different kind than the stored one is refused whole: a slug that changes species
  // breaks its own history. An absent param inherits.
  const kindParam = new URL(req.url).searchParams.get("kind");
  if (kindParam !== null && kindParam !== "bundle" && kindParam !== "plan") {
    return json({ error: "`kind` must be `bundle` or `plan`" }, 400);
  }
  const existing = getBundle(ws, slug);
  if (existing && kindParam !== null && kindParam !== existing.kind) {
    return json(
      { error: `"${slug}" is a ${existing.kind} and a slug never changes kind; use a new slug` },
      409,
    );
  }
  const kind: BundleKind = existing?.kind ?? (kindParam as BundleKind | null) ?? "bundle";

  // `?project=` is resolved BEFORE the version is created: a typo'd project must fail
  // the whole upload rather than land the bundle and silently lose the grouping.
  const project = resolveUploadProject(req, ws);
  if (project instanceof Response) return project;

  const version = createVersion(ws, slug, body.length, files.length, kind);
  // The stored row is the authority on kind, re-read after the transaction: the
  // computed value above can only drift from it if an await ever lands between the
  // 409 check and createVersion, and echoing storage means that future edit shows up
  // as a wrong-looking response in tests rather than as a silent lie to the caller.
  const storedKind = getBundle(ws, slug)!.kind;

  // A plan should read like Seer: its index.html links the hosted reading surface.
  // A deliberately custom plan is legitimate, so a missing link is a warning naming
  // what is missing, never a refusal — a silent drift is the one wrong answer.
  const warnings: string[] = [];
  if (storedKind === "plan" && files.includes("index.html")) {
    const index = readZipEntry(body, "index.html") ?? "";
    if (!index.includes("/plan.css")) {
      warnings.push(
        "index.html does not link /plan.css: plans read in the house style through it, " +
          "and without it this plan will not follow the reader's theme",
      );
    }
    if (!index.includes("/theme.js")) {
      warnings.push(
        "index.html does not load /theme.js: without it this plan cannot follow the " +
          "reader's light/dark choice or the system setting",
      );
    }
  }

  await saveZip(ws, slug, version, body);
  if (project) attachBundle(project, slug);
  publish.publish(`bundle:${ws}:${slug}`, "reload");

  return json({
    slug,
    version,
    kind: storedKind,
    workspace: ws,
    url: `${config.baseUrl}/${ws}/b/${slug}/`,
    versionUrl: `${config.baseUrl}/${ws}/b/${slug}/v/${version}/`,
    bytes: body.length,
    files: files.length,
    hasIndexHtml: files.includes("index.html"),
    projects: listProjectsForBundle(ws, slug).map((p) => p.slug),
    warnings,
  });
}


const uploadBundleDoc: Omit<Operation, "operationId"> = {
  summary: "Publish a bundle, creating its next version",
  description:
    "The body is the raw zip, not multipart. It must contain a root index.html. The key " +
    "resolves the workspace, so the upload lands wherever the key belongs. PUT and POST " +
    "are identical. `?project=<slug>` attaches the bundle to that project in the same " +
    "breath; a project the workspace does not hold refuses the whole upload. " +
    "`?kind=plan` on the FIRST upload makes the slug a plan — a document that should " +
    "link /plan.css and /theme.js to read in the house style; the kind is immutable " +
    "and a later upload naming a different one is a 409.",
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
    {
      name: "kind",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["bundle", "plan"] },
      description: "Set at first upload, immutable after. Default bundle.",
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
            required: ["slug", "version", "kind", "workspace", "url", "versionUrl", "bytes", "files", "hasIndexHtml", "warnings"],
            properties: {
              slug: { type: "string" },
              version: { type: "integer" },
              kind: { type: "string", enum: ["bundle", "plan"] },
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
              warnings: {
                type: "array",
                items: { type: "string" },
                description: "Non-fatal problems, e.g. a plan whose index.html links no reading surface.",
              },
            },
          },
        },
      },
    },
    "400": errorResponse,
    "401": errorResponse,
    "404": errorResponse,
    "409": errorResponse,
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

/** One task as the API answers it, shared by the task routes and the state object. */
const taskSchema = {
  type: "object",
  required: ["id", "title", "body", "status", "gates", "prs", "drift", "createdAt", "updatedAt", "doneAt"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    body: { type: "string", description: "Constrained markdown, as authored." },
    status: PROJECT_STATUS_ENUM,
    gates: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "met"],
        properties: { text: { type: "string" }, met: { type: "boolean" } },
      },
    },
    prs: {
      type: "array",
      items: {
        type: "object",
        required: ["repo", "number", "title", "state", "url"],
        properties: {
          repo: { type: "string" },
          number: { type: "integer" },
          title: { type: ["string", "null"], description: "Fetched best-effort at write; null when GitHub could not be asked." },
          state: { type: "string", enum: ["merged", "closed", "draft", "open", "unchecked"], description: "Derived from observations, never authored." },
          url: { type: "string", format: "uri" },
        },
      },
    },
    drift: { type: ["string", "null"], description: "Derived: named when the facts contradict the authored status." },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    doneAt: { type: ["string", "null"], format: "date-time" },
  },
};

/** The state object: what create, read and update all answer with, and the reason one
 *  call is enough to resume — the whole project comes back every time it changes. */
const noteSchema = {
  type: "object",
  required: ["id", "task", "body", "author", "createdAt"],
  properties: {
    id: { type: "string" },
    task: { type: ["string", "null"], description: "The task the note hangs off, or null." },
    body: { type: "string", description: "Constrained markdown, as authored. Append-only: notes are never edited or deleted." },
    author: { type: ["string", "null"], description: "The key holder's email at write time." },
    createdAt: { type: "string", format: "date-time" },
  },
};

const projectStateSchema = {
  type: "object",
  required: [
    "slug", "title", "description", "status", "parent", "workspace", "url",
    "createdAt", "updatedAt", "children", "tasks", "plans", "bundles", "reviews",
    "reviewLineages", "stages", "notes", "noteCount",
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
        required: ["slug", "title", "status", "bundles", "reviews", "reviewLineages", "stages", "tasks"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          status: PROJECT_STATUS_ENUM,
          bundles: { type: "integer" },
          reviews: { type: "integer" },
          reviewLineages: { type: "integer" },
          stages: { type: "integer" },
          tasks: { type: "integer" },
        },
      },
    },
    tasks: {
      type: "array",
      description: "Open first, then done, then closed; created order within each.",
      items: taskSchema,
    },
    plans: {
      type: "array",
      description: "Bundles of kind plan: the project's documents to read, first.",
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
    stages: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "title", "latestVersion", "updatedAt", "url", "versionUrl", "apiUrl", "apiVersionUrl"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          latestVersion: { type: "integer" },
          updatedAt: { type: "string", format: "date-time" },
          url: { type: "string", format: "uri" },
          versionUrl: { type: "string", format: "uri" },
          apiUrl: { type: "string", format: "uri" },
          apiVersionUrl: { type: "string", format: "uri" },
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
    reviewLineages: {
      type: "array",
      description:
        "Promoted reviews: a source revision reads at /rev/N and an account at /v/N. " +
        "Listed apart from `reviews` because the two resolve through different readers.",
      items: {
        type: "object",
        required: ["slug", "title", "latestRevision", "latestAccountVersion", "updatedAt", "url", "revisionUrl", "apiUrl"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          latestRevision: { type: "integer" },
          latestAccountVersion: { type: ["integer", "null"], description: "Null while no witness has published." },
          updatedAt: { type: "string", format: "date-time" },
          url: { type: "string", format: "uri" },
          revisionUrl: { type: "string", format: "uri" },
          apiUrl: { type: "string", format: "uri" },
        },
      },
    },
    notes: {
      type: "array",
      description:
        "The most recent 20 notes, oldest first so they read chronologically. " +
        "The full record, with status events interleaved, is GET /api/projects/{slug}/notes.",
      items: noteSchema,
    },
    noteCount: { type: "integer", description: "Every note the project holds." },
  },
};

const projectStateResponse = {
  description: "The project's whole state, one call.",
  content: { "application/json": { schema: projectStateSchema } },
};

const stageBuilderSchema = {
  type: "object",
  required: ["intent", "context", "agent"],
  additionalProperties: false,
  properties: {
    intent: { type: "string", minLength: 1, maxLength: 1200, description: "Constrained markdown." },
    context: { type: "string", maxLength: 4000, description: "Constrained markdown." },
    agent: {
      type: "object",
      required: ["name", "model"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80, description: "Plain one-line text; inline code is allowed." },
        model: { type: "string", minLength: 1, maxLength: 80, description: "Plain one-line text; inline code is allowed." },
      },
    },
  },
};

const stageBuilderResponseSchema = {
  ...stageBuilderSchema,
  required: ["intent", "context", "agent", "userId", "keyId"],
  properties: {
    ...stageBuilderSchema.properties,
    userId: { type: ["string", "null"], description: "Derived builder user; null on legacy reads." },
    keyId: { type: ["string", "null"], description: "Derived builder key; null on legacy reads." },
  },
};

const stageBuilderDocSchema = {
  ...stageBuilderResponseSchema,
  properties: {
    ...stageBuilderResponseSchema.properties,
    userId: { type: "string" },
    keyId: { type: "string" },
  },
};

const stageMemberSchema = {
  oneOf: (["change", "material", "file"] as const).map((type) => ({
    type: "object",
    required: ["type", "id", "description"],
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: [type] },
      id: { type: "string", minLength: 1, maxLength: 80 },
      description: { type: "string", minLength: 1, maxLength: 400, description: "Plain one-line text; inline code is allowed." }
    },
  })),
};

const stageGroupSchema = {
  type: "object",
  required: ["id", "title", "category", "importance", "complexity", "explanation", "examples", "members"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: SLUG_RE.source },
    title: { type: "string", minLength: 1, maxLength: 60, description: "Plain one-line text; inline code is allowed." },
    category: { type: "string", enum: ["Contract", "Code", "Tests", "Test fixtures", "Docs", "Generated"] },
    importance: { type: "string", enum: ["low", "medium", "high"] },
    complexity: { type: "string", enum: ["low", "medium", "high"] },
    explanation: { type: "string", minLength: 1, maxLength: 1600, description: "Constrained markdown." },
    attention: { type: "string", maxLength: 300, description: "Plain one-line text; inline code is allowed." },
    examples: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["code", "text"],
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1, maxLength: 500 },
          text: { type: "string", minLength: 1, maxLength: 300 },
        },
      },
    },
    members: { type: "array", maxItems: 10000, items: stageMemberSchema, description: "Across all groups, at most 10,000 members are accepted." }
  },
};

const stageDocSchema = {
  type: "object",
  required: ["identity", "source", "builder", "witness", "projects"],
  additionalProperties: false,
  properties: {
    identity: {
      type: "object", required: ["id", "slug", "version", "title", "createdAt"], additionalProperties: false,
      properties: { id: { type: "string", pattern: STA_ID_RE.source }, slug: { type: "string", pattern: SLUG_RE.source }, version: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 80 }, createdAt: { type: "string", format: "date-time" } },
    },
    source: {
      type: "object", required: ["captureId", "repo", "repoId", "branch", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha"], additionalProperties: false,
      properties: { captureId: { type: "string", pattern: STG_ID_RE.source }, repo: { type: "string" }, repoId: { type: "integer" }, branch: { type: "string" }, baseRef: { type: "string" }, sourceHeadSha: { type: "string" }, baseTipSha: { type: "string" }, mergeBaseSha: { type: "string" } },
    },
    builder: stageBuilderDocSchema,
    witness: {
      type: "object", required: ["summary", "groups", "agent", "userId", "keyId"], additionalProperties: false,
      properties: { summary: { type: "string", minLength: 1, maxLength: 1200 }, groups: { type: "array", minItems: 1, maxItems: 16, items: stageGroupSchema }, agent: stageBuilderSchema.properties.agent, userId: { type: "string" }, keyId: { type: "string" } },
    },
    projects: { type: "array", maxItems: 16, items: { type: "string", pattern: SLUG_RE.source } },
  },
};

const stageCaptureChangeSchema = {
  type: "object", required: ["id", "old", "new", "oldFingerprint", "newFingerprint", "contextFingerprint", "source"], additionalProperties: false,
  properties: {
    id: { type: "string" }, old: { type: "object", required: ["start", "lines"], additionalProperties: false, properties: { start: { type: "integer" }, lines: { type: "integer" } } },
    new: { type: "object", required: ["start", "lines"], additionalProperties: false, properties: { start: { type: "integer" }, lines: { type: "integer" } } },
    oldFingerprint: { type: "string" }, newFingerprint: { type: "string" }, contextFingerprint: { type: "string" }, source: { type: "string", enum: ["patch", "reconstructed"] },
  },
};

const stageCaptureSideSchema = {
  type: "object", required: ["objectId", "mode", "kind", "availability", "blobSha256", "reason"], additionalProperties: false,
  properties: {
    objectId: { type: ["string", "null"] }, mode: { type: ["string", "null"] }, kind: { type: ["string", "null"] },
    availability: { type: "string", enum: ["retained", "unavailable", "not_applicable"] }, blobSha256: { type: ["string", "null"] }, reason: { type: ["string", "null"] },
  },
};

const stageCaptureFileSchema = {
  type: "object", required: ["id", "path", "oldPath", "status", "old", "new", "additions", "deletions", "changes"], additionalProperties: false,
  properties: {
    id: { type: "string" }, path: { type: "string" }, oldPath: { type: ["string", "null"] }, status: { type: "string", enum: ["added", "removed", "modified", "renamed", "mode_changed", "unknown"] },
    old: stageCaptureSideSchema, new: stageCaptureSideSchema, additions: { type: ["integer", "null"] }, deletions: { type: ["integer", "null"] }, changes: { type: "array", items: stageCaptureChangeSchema },
  },
};

const stageCaptureSchema = {
  type: "object", required: ["id", "workspace", "slug", "state", "repo", "repoId", "branch", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha", "patch", "complete", "reviewable", "files", "incomplete", "builder", "createdAt"], additionalProperties: false,
  properties: {
    id: { type: "string", pattern: STG_ID_RE.source }, workspace: { type: "string" }, slug: { type: "string", pattern: SLUG_RE.source }, state: { type: "string", enum: ["completed"] },
    repo: { type: "string" }, repoId: { type: "integer" }, branch: { type: "string" }, baseRef: { type: "string" }, sourceHeadSha: { type: "string" }, baseTipSha: { type: "string" }, mergeBaseSha: { type: "string" },
    patch: { type: ["object", "null"], required: ["sha256", "available"], additionalProperties: false, properties: { sha256: { type: "string" }, available: { type: "boolean" } } }, complete: { type: "boolean" }, reviewable: { type: "boolean" },
    files: { type: "array", items: stageCaptureFileSchema },
    incomplete: { type: "array", items: { type: "object", required: ["id", "kind", "path", "side", "reason"], additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string", enum: ["snapshot_incomplete", "bytes_unavailable", "lines_unavailable", "patch_unavailable", "metadata_incomplete"] }, path: { type: ["string", "null"] }, side: { type: "string", enum: ["old", "new", "snapshot"] }, reason: { type: "string" } } } },
    builder: { oneOf: [stageBuilderResponseSchema, { type: "null" }] }, createdAt: { type: "string", format: "date-time" },
  },
};

const stageLinesSchema = {
  type: "object",
  required: ["fileId", "path", "side", "start", "end", "totalLines", "lines"],
  additionalProperties: false,
  properties: {
    fileId: { type: "string", pattern: STF_ID_RE.source },
    path: { type: "string" },
    side: { type: "string", enum: ["old", "new"] },
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 0 },
    totalLines: { type: "integer", minimum: 0 },
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["number", "text"],
        additionalProperties: false,
        properties: { number: { type: "integer", minimum: 1 }, text: { type: "string" } },
      },
    },
  },
};

const stageViewSchema = {
  type: "object",
  required: ["id", "slug", "workspace", "version", "latestVersion", "isLatest", "url", "versionUrl", "apiUrl", "apiVersionUrl", "document"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: STA_ID_RE.source }, slug: { type: "string", pattern: SLUG_RE.source }, workspace: { type: "string" },
    version: { type: "integer", minimum: 1 }, latestVersion: { type: "integer", minimum: 1 }, isLatest: { type: "boolean" },
    url: { type: "string", format: "uri" }, versionUrl: { type: "string", format: "uri" },
    apiUrl: { type: "string", format: "uri" }, apiVersionUrl: { type: "string", format: "uri" }, document: stageDocSchema,
  },
};

// ---- the promoted review ----

const revisionDocSchema = {
  type: "object",
  required: ["identity", "source", "builder", "projects"],
  additionalProperties: false,
  properties: {
    identity: {
      type: "object", required: ["lineageId", "slug", "revision", "title", "createdAt"], additionalProperties: false,
      properties: { lineageId: { type: "string", pattern: RLN_ID_RE.source }, slug: { type: "string", pattern: SLUG_RE.source }, revision: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 80 }, createdAt: { type: "string", format: "date-time" } },
    },
    source: {
      type: "object",
      required: ["captureId", "repo", "repoId", "branch", "originalBaseRef", "originalBaseSha", "baseRef", "sourceHeadSha", "baseTipSha", "mergeBaseSha"],
      additionalProperties: false,
      properties: {
        captureId: { type: "string", pattern: STG_ID_RE.source }, repo: { type: "string" }, repoId: { type: "integer" }, branch: { type: "string" },
        originalBaseRef: { type: "string" }, originalBaseSha: { type: "string" }, baseRef: { type: "string" },
        sourceHeadSha: { type: "string" }, baseTipSha: { type: "string" }, mergeBaseSha: { type: "string" },
      },
    },
    builder: {
      oneOf: [
        {
          type: "object", required: ["intent", "context", "agent", "userId", "keyId"], additionalProperties: false,
          properties: {
            intent: { type: "string" }, context: { type: "string" }, agent: stageBuilderSchema.properties.agent,
            userId: { type: ["string", "null"] }, keyId: { type: ["string", "null"] },
          },
        },
        { type: "null", description: "A revision over a capture no Seer builder initiated." },
      ],
    },
    projects: { type: "array", maxItems: 16, items: { type: "string", pattern: SLUG_RE.source } },
  },
};

const focusAnchorSchema = {
  type: "object", required: ["type", "id"], additionalProperties: false,
  properties: { type: { type: "string", enum: ["change", "material", "file"] }, id: { type: "string", minLength: 1, maxLength: 80 } },
};

const focusItemSchema = {
  type: "object", required: ["id", "kind", "title", "body", "anchors"], additionalProperties: false,
  properties: {
    id: { type: "string", pattern: SLUG_RE.source },
    kind: { type: "string", enum: ["decision", "risk"] },
    title: { type: "string", minLength: 1, maxLength: 80, description: "Plain one-line text; inline code is allowed." },
    body: { type: "string", minLength: 1, maxLength: 1200, description: "Constrained markdown." },
    anchors: { type: "array", minItems: 1, maxItems: 16, items: focusAnchorSchema },
  },
};

const evidenceRefInputSchema = {
  oneOf: [
    { type: "object", required: ["kind", "id"], additionalProperties: false, properties: { kind: { type: "string", enum: ["attachment"] }, id: { type: "string", minLength: 1, maxLength: 80 } } },
    { type: "object", required: ["kind", "slug", "version"], additionalProperties: false, properties: { kind: { type: "string", enum: ["bundle"] }, slug: { type: "string", pattern: SLUG_RE.source }, version: { type: "integer", minimum: 1 } } },
  ],
};

const evidenceRefSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "id", "reviewSlug", "mediaType", "bytes", "alt", "caption"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["attachment"] }, id: { type: "string" },
        reviewSlug: { type: "string", pattern: SLUG_RE.source }, mediaType: { type: "string" },
        bytes: { type: "integer", minimum: 0 }, alt: { type: "string" }, caption: { type: "string" },
      },
    },
    { type: "object", required: ["kind", "slug", "version"], additionalProperties: false, properties: { kind: { type: "string", enum: ["bundle"] }, slug: { type: "string", pattern: SLUG_RE.source }, version: { type: "integer", minimum: 1 } } },
  ],
};

const accountDocSchema = {
  type: "object",
  required: ["identity", "witness", "groups", "focus", "evidence"],
  additionalProperties: false,
  properties: {
    identity: {
      type: "object", required: ["lineageId", "slug", "revision", "version", "createdAt"], additionalProperties: false,
      properties: { lineageId: { type: "string", pattern: RLN_ID_RE.source }, slug: { type: "string", pattern: SLUG_RE.source }, revision: { type: "integer", minimum: 1 }, version: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" } },
    },
    witness: {
      type: "object", required: ["summary", "agent", "userId", "keyId"], additionalProperties: false,
      properties: { summary: { type: "string", minLength: 1, maxLength: 1200 }, agent: stageBuilderSchema.properties.agent, userId: { type: "string" }, keyId: { type: "string" } },
    },
    groups: { type: "array", minItems: 1, maxItems: 16, items: stageGroupSchema },
    focus: { type: "array", maxItems: 24, items: focusItemSchema },
    evidence: { type: "array", maxItems: 16, items: evidenceRefSchema },
  },
};

const witnessRequestSchema = {
  type: "object",
  required: ["id", "workspace", "slug", "revision", "state", "retryCount", "failure", "accountId", "updatedAt"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: WTR_ID_RE.source },
    workspace: { type: "string" },
    slug: { type: "string", pattern: SLUG_RE.source },
    revision: { type: "integer", minimum: 1 },
    state: { type: "string", enum: ["pending", "failed", "retrying", "published"], description: "`retrying` is derived: pending after at least one failure." },
    retryCount: { type: "integer", minimum: 0 },
    failure: { type: ["string", "null"] },
    accountId: { type: ["string", "null"], pattern: RAC_ID_RE.source },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const revisionViewSchema = {
  type: "object",
  required: ["id", "lineage", "slug", "workspace", "revision", "schemaVersion", "digest", "url", "apiUrl", "createdAt", "document", "witness"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: RVR_ID_RE.source }, lineage: { type: "string", pattern: RLN_ID_RE.source },
    slug: { type: "string", pattern: SLUG_RE.source }, workspace: { type: "string" },
    revision: { type: "integer", minimum: 1 }, schemaVersion: { type: "integer", minimum: 1 }, digest: { type: "string" },
    url: { type: "string", format: "uri" }, apiUrl: { type: "string", format: "uri" },
    createdAt: { type: "string", format: "date-time" },
    document: revisionDocSchema, witness: witnessRequestSchema,
  },
};

const accountViewSchema = {
  type: "object",
  required: ["id", "lineage", "slug", "workspace", "revision", "version", "schemaVersion", "digest", "url", "revisionUrl", "createdAt", "document", "witness"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: RAC_ID_RE.source }, lineage: { type: "string", pattern: RLN_ID_RE.source },
    slug: { type: "string", pattern: SLUG_RE.source }, workspace: { type: "string" },
    revision: { type: "integer", minimum: 1 }, version: { type: "integer", minimum: 1 },
    schemaVersion: { type: "integer", minimum: 1 }, digest: { type: "string" },
    url: { type: "string", format: "uri" }, revisionUrl: { type: "string", format: "uri" },
    createdAt: { type: "string", format: "date-time" },
    document: accountDocSchema, witness: witnessRequestSchema,
  },
};

const lineageViewSchema = {
  type: "object",
  required: ["id", "slug", "workspace", "title", "repo", "repoId", "branch", "originalBaseRef", "originalBaseSha", "latestRevision", "latestAccountVersion", "url", "apiUrl", "projects", "revisions", "accounts"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: RLN_ID_RE.source }, slug: { type: "string", pattern: SLUG_RE.source }, workspace: { type: "string" },
    title: { type: "string" }, repo: { type: "string" }, repoId: { type: "integer" }, branch: { type: "string" },
    originalBaseRef: { type: "string" }, originalBaseSha: { type: "string" },
    latestRevision: { type: ["integer", "null"], minimum: 1 }, latestAccountVersion: { type: ["integer", "null"], minimum: 1 },
    url: { type: "string", format: "uri" }, apiUrl: { type: "string", format: "uri" },
    projects: { type: "array", items: { type: "string", pattern: SLUG_RE.source } },
    revisions: {
      type: "array",
      items: {
        type: "object", required: ["revision", "captureId", "createdAt", "url", "apiUrl"], additionalProperties: false,
        properties: { revision: { type: "integer", minimum: 1 }, captureId: { type: "string", pattern: STG_ID_RE.source }, createdAt: { type: "string", format: "date-time" }, url: { type: "string", format: "uri" }, apiUrl: { type: "string", format: "uri" } },
      },
    },
    accounts: {
      type: "array",
      items: {
        type: "object", required: ["version", "revision", "createdAt", "url"], additionalProperties: false,
        properties: { version: { type: "integer", minimum: 1 }, revision: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" }, url: { type: "string", format: "uri" } },
      },
    },
  },
};

const revisionParam = { name: "revision", in: "path", required: true, schema: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } };

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
                    required: ["slug", "latestVersion", "kind", "workspace", "url", "versions"],
                    properties: {
                      slug: { type: "string" },
                      latestVersion: { type: "integer" },
                      kind: { type: "string", enum: ["bundle", "plan"] },
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
            kind: b.kind,
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
                      "updatedAt", "bundles", "reviews", "reviewLineages", "stages", "children",
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
                      reviewLineages: { type: "integer" },
                      stages: { type: "integer" },
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

  route("/api/projects/:slug/tasks", {
    POST: {
      doc: {
        operationId: "createTask",
        summary: "Create a task in a project",
        description:
          "Gates are the conditions the task must pass, authored unmet and flipped as " +
          "work proves them; a task cannot be done while a gate is unmet. PR pointers " +
          "are owner/name plus number; Seer derives their state and keeps it fresh.",
        security: "key",
        parameters: [slugParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: {
                  title: { type: "string", maxLength: 120 },
                  body: { type: "string", description: "Constrained markdown." },
                  gates: {
                    type: "array",
                    maxItems: 8,
                    items: {
                      type: "object",
                      required: ["text"],
                      properties: { text: { type: "string", maxLength: 120 }, met: { type: "boolean" } },
                    },
                  },
                  prs: {
                    type: "array",
                    maxItems: 16,
                    items: {
                      type: "object",
                      required: ["repo", "number"],
                      properties: {
                        repo: { type: "string", description: "owner/name" },
                        number: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The task, with its derived PR facts.",
            content: { "application/json": { schema: taskSchema } },
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      run: (req) => handleCreateTask(req, req.params.slug),
    },
  }),

  route("/api/projects/:slug/tasks/:id", {
    PATCH: {
      doc: {
        operationId: "updateTask",
        summary: "Update a task",
        description:
          "Any of title, body, status, gates, prs; gates and prs replace whole. Entering " +
          "done with an unmet gate is a 422 naming the gate. Status transitions are " +
          "recorded by Seer; done_at is derived from them.",
        security: "key",
        parameters: [
          slugParam,
          { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^tsk_" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", maxLength: 120 },
                  body: { type: "string" },
                  status: PROJECT_STATUS_ENUM,
                  gates: { type: "array", items: {} },
                  prs: { type: "array", items: {} },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The task as patched.",
            content: { "application/json": { schema: taskSchema } },
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      run: (req) => handleUpdateTask(req, req.params.slug, req.params.id),
    },
  }),

  route("/api/projects/:slug/notes", {
    POST: {
      doc: {
        operationId: "createNote",
        summary: "Append a note to a project",
        description:
          "Notes are append-only: no edit, no delete, ever — a correction is another " +
          "note. `task` ties the note to one of the project's tasks; without it the " +
          "note belongs to the project itself.",
        security: "key",
        parameters: [slugParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["body"],
                properties: {
                  body: {
                    type: "string",
                    maxLength: 2000,
                    description: "Constrained markdown, at most 2000 characters.",
                  },
                  task: {
                    type: ["string", "null"],
                    description: "A task id (tsk_…) in this project, or null.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The note as stored.",
            content: { "application/json": { schema: noteSchema } },
          },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "422": errorResponse,
        },
      },
      run: (req) => handleCreateNote(req, req.params.slug),
    },
    GET: {
      doc: {
        operationId: "listNotes",
        summary: "The project's whole record: every note and every status transition",
        description:
          "Merged chronologically, oldest first. Notes are authored; events are " +
          "derived by Seer and cannot be written, which is what makes the record " +
          "worth reading.",
        security: "keyOrSession",
        parameters: [slugParam],
        responses: {
          "200": {
            description: "The trail.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    oneOf: [
                      {
                        title: "A note",
                        type: "object",
                        required: ["kind", "id", "task", "taskTitle", "body", "author", "createdAt"],
                        properties: {
                          kind: { type: "string", enum: ["note"] },
                          id: { type: "string" },
                          task: { type: ["string", "null"] },
                          taskTitle: { type: ["string", "null"] },
                          body: { type: "string" },
                          author: { type: ["string", "null"] },
                          createdAt: { type: "string", format: "date-time" },
                        },
                      },
                      {
                        title: "A status event",
                        type: "object",
                        required: ["kind", "task", "taskTitle", "from", "to", "createdAt"],
                        properties: {
                          kind: { type: "string", enum: ["event"] },
                          task: { type: ["string", "null"] },
                          taskTitle: { type: ["string", "null"] },
                          from: { type: "string" },
                          to: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          "404": errorResponse,
        },
      },
      run: (req) => handleListProjectNotes(req, req.params.slug),
    },
  }),

  // Stage source capture. This route resolves and retains a pinned branch snapshot;
  // stage versions and authored narrative are later slices.
  route("/api/stage-captures", {
    POST: {
      doc: {
        operationId: "createStageCapture",
        summary: "Capture a pushed same-repository branch",
        description:
          "The API key's workspace owns the capture. Send a valid stage slug, repository, " +
          "mutable source branch, and the Idempotency-Key header. baseRef defaults to the " +
          "repository's default branch. Seer resolves both refs, verifies the merge base, " +
          "walks both pinned trees, retains source objects within the configured logical-byte " +
          "cap, and writes a self-contained completed inventory before returning. Compare " +
          "metadata supplies rename and patch facts but never decides whether the snapshot " +
          "is complete. Reusing the header for another request is a 409.",
        security: "key",
        parameters: [{
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 200 },
          description: "Required replay key. It is scoped to the API key's workspace.",
        }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["slug", "repo", "branch", "builder"],
            properties: {
              slug: { type: "string", pattern: SLUG_RE.source },
              repo: { type: "string", description: "owner/name; head repository and arbitrary commits are not accepted." },
              branch: { type: "string", description: "The mutable source branch in repo. Slash-containing names are allowed." },
              baseRef: { type: "string", description: "A branch in repo. Defaults to the repository's default branch." },
              builder: stageBuilderSchema,
            },
            additionalProperties: false,
          } } },
        },
        responses: {
          "200": { description: "The completed immutable capture inventory.", content: { "application/json": { schema: stageCaptureSchema } } },
          "400": errorResponse, "401": errorResponse, "409": errorResponse, "422": errorResponse, "502": errorResponse,
        },
      },
      run: (req) => handleCreateStageCapture(req),
    },
  }),

  route("/api/stage-captures/:id", {
    GET: {
      doc: {
        operationId: "readStageCapture",
        summary: "Read a completed stage capture inventory",
        description: "Workspace members and keys read completed captures. Missing, malformed, and cross-workspace ids return the same soft 404. This route never calls GitHub.",
        security: "keyOrSession",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: STG_ID_RE.source } }],
        responses: {
          "200": { description: "The stored inventory and pinned source facts.", content: { "application/json": { schema: stageCaptureSchema } } },
          "404": errorResponse,
        },
      },
      run: (req) => handleReadStageCapture(req, req.params.id),
    },
  }),

  route("/api/stage-captures/:id/objects/:sha256", {
    GET: {
      doc: {
        operationId: "readStageCaptureObject",
        summary: "Read one retained capture object",
        description: "Reads a canonical patch or retained old/new blob named by the authorized capture. Workspace members and valid workspace keys may read it. Unknown, unrelated, malformed, and cross-workspace objects share the capture soft 404; a named object missing from durable storage is reported as storage corruption, while a store-open failure is a retryable 502.",
        security: "keyOrSession",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", pattern: STG_ID_RE.source } },
          { name: "sha256", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        ],
        responses: {
          "200": { description: "The retained patch or blob bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          "404": errorResponse,
          "500": errorResponse,
          "502": errorResponse,
        },
      },
      run: (req) => handleReadStageObject(req, req.params.id, req.params.sha256),
    },
  }),

  route("/api/stages", {
    POST: {
      doc: {
        operationId: "publishStage",
        summary: "Publish one immutable staged walkthrough",
        description: "Publishes a validated witness narrative over one completed capture. The capture slug must match, expectedPreviousVersion is 0 in this slice, every canonical change and incomplete material must be accounted for exactly once, and Project attachments resolve before the one transaction writes stage, version, and membership rows. Unknown Project slugs return 422, matching review publication.",
        security: "key",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object",
          required: ["captureId", "expectedPreviousVersion", "slug", "title", "summary", "witness", "groups"],
          properties: {
            captureId: { type: "string", pattern: STG_ID_RE.source },
            expectedPreviousVersion: { type: "integer", enum: [0] },
            slug: { type: "string", pattern: SLUG_RE.source },
            title: { type: "string", minLength: 1, maxLength: 80 },
            summary: { type: "string", minLength: 1, maxLength: 1200, description: "Constrained markdown." },
            witness: { type: "object", required: ["name", "model"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 }, model: { type: "string", minLength: 1, maxLength: 80 } } },
            groups: { type: "array", minItems: 1, maxItems: 16, items: stageGroupSchema, description: "Group ids are unique slugs. Each group must include examples, which may be an empty array. The total member count is capped at 10,000. Rejected requests contain at most 32 field errors." },
            projects: { type: "array", maxItems: 16, items: { type: "string", pattern: SLUG_RE.source } },
          },
          additionalProperties: false,
        } } } },
        responses: {
          "200": { description: "The immutable stage version and resolved document.", content: { "application/json": { schema: stageViewSchema } } },
          "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "422": errorResponse, "502": errorResponse,
        },
      },
      run: (req) => handlePublishStage(req),
    },
  }),

  route("/api/stages/:slug", {
    GET: {
      doc: { operationId: "readLatestStage", summary: "Read the latest stage version", security: "keyOrSession", parameters: [slugParam], responses: { "200": { description: "The resolved latest stage version.", content: { "application/json": { schema: stageViewSchema } } }, "404": errorResponse } },
      run: (req) => handleReadStage(req, req.params.slug, null),
    },
  }),

  route("/api/stages/:slug/v/:version", {
    GET: {
      doc: { operationId: "readStageVersion", summary: "Read one pinned stage version", security: "keyOrSession", parameters: [slugParam, { name: "version", in: "path", required: true, schema: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } }], responses: { "200": { description: "The resolved immutable stage version.", content: { "application/json": { schema: stageViewSchema } } }, "404": errorResponse } },
      run: (req) => handleReadStage(req, req.params.slug, req.params.version),
    },
  }),

  route("/api/stages/:slug/v/:version/files/:fileId", {
    GET: {
      doc: {
        operationId: "readStageFileLines",
        summary: "Read retained lines from one staged file",
        description: "The opaque file id must belong to this immutable version. Paths, repositories, Git object ids, and storage digests are never accepted as authority.",
        security: "keyOrSession",
        parameters: [
          slugParam,
          { name: "version", in: "path", required: true, schema: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } },
          { name: "fileId", in: "path", required: true, schema: { type: "string", pattern: STF_ID_RE.source } },
          { name: "side", in: "query", required: true, schema: { type: "string", enum: ["old", "new"] } },
          { name: "start", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
          { name: "end", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": { description: "At most 400 retained text lines.", content: { "application/json": { schema: stageLinesSchema } } },
          "404": errorResponse,
          "422": errorResponse,
          "500": errorResponse,
          "502": errorResponse,
        },
      },
      run: (req) => handleStageLines(req, req.params.slug, req.params.version, req.params.fileId),
    },
  }),

  // The promoted review: a completed capture becomes an immutable, readable source
  // revision before any witness has finished, and an account is published over it after.
  route("/api/review-lineages", {
    POST: {
      doc: {
        operationId: "createReviewLineage",
        summary: "Publish the first source revision of a promoted review",
        description:
          "Creates the lineage, the immutable evidence document, a pending witness request, and any " +
          "Project joins in one transaction. The capture may already back a stage version; nothing is " +
          "consumed. The requested slug may differ from the capture's, so a Stage or legacy collision " +
          "can be resolved explicitly, but it must not already name a review or a lineage in this " +
          "workspace. Replaying the same capture with the same normalized fields returns the existing " +
          "revision; replaying it with different fields is a 409.",
        security: "key",
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["captureId", "slug", "title"],
            additionalProperties: false,
            properties: {
              captureId: { type: "string", pattern: STG_ID_RE.source },
              slug: { type: "string", pattern: SLUG_RE.source },
              title: { type: "string", minLength: 1, maxLength: 80 },
              projects: { type: "array", maxItems: 16, items: { type: "string", pattern: SLUG_RE.source }, description: "Normalized to a sorted unique list, so input order does not change a replay." },
            },
          } } },
        },
        responses: {
          "200": { description: "The immutable source revision and its witness request.", content: { "application/json": { schema: revisionViewSchema } } },
          "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "422": errorResponse, "502": errorResponse,
        },
      },
      run: (req) => handleCreateReviewLineage(req),
    },
  }),

  route("/api/review-lineages/:slug", {
    GET: {
      doc: {
        operationId: "readReviewLineage",
        summary: "Read one promoted review lineage",
        description: "Its revisions, its account versions, and the Projects it belongs to. Missing, malformed, and cross-workspace slugs share the review soft 404.",
        security: "keyOrSession",
        parameters: [slugParam],
        responses: {
          "200": { description: "The lineage and what it holds.", content: { "application/json": { schema: lineageViewSchema } } },
          "404": reviewNotFound,
        },
      },
      run: (req) => handleReadReviewLineage(req, req.params.slug),
    },
  }),

  route("/api/review-lineages/:slug/revisions/:revision", {
    GET: {
      doc: {
        operationId: "readReviewRevision",
        summary: "Read one exact evidence revision",
        description: "The immutable evidence document and the current witness workflow state, which is read beside the document rather than stored in it.",
        security: "keyOrSession",
        parameters: [slugParam, revisionParam],
        responses: {
          "200": { description: "The exact evidence document and workflow state.", content: { "application/json": { schema: revisionViewSchema } } },
          "404": reviewNotFound,
        },
      },
      run: (req) => handleReadReviewRevision(req, req.params.slug, req.params.revision),
    },
  }),

  route("/api/review-lineages/:slug/revisions/:revision/accounts", {
    POST: {
      doc: {
        operationId: "publishReviewAccount",
        summary: "Publish one witness account over a source revision",
        description:
          "The groups must partition the revision's capture exactly once, exactly as a stage walkthrough " +
          "does. Focus items are bounded decisions and risks with unique slug ids and one or more anchors " +
          "into that same capture; anchors may overlap and own nothing. Evidence references must already " +
          "exist in this workspace. Publishing moves the witness request to `published` in the same " +
          "transaction. Exact replay returns the existing account; a different one is a 409.",
        security: "key",
        parameters: [slugParam, revisionParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["witness", "summary", "groups"],
            additionalProperties: false,
            properties: {
              witness: { type: "object", required: ["name", "model"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 }, model: { type: "string", minLength: 1, maxLength: 80 } } },
              summary: { type: "string", minLength: 1, maxLength: 1200, description: "Constrained markdown." },
              groups: { type: "array", minItems: 1, maxItems: 16, items: stageGroupSchema },
              focus: { type: "array", maxItems: 24, items: focusItemSchema },
              evidence: { type: "array", maxItems: 16, items: evidenceRefInputSchema },
            },
          } } },
        },
        responses: {
          "200": { description: "The immutable account and the published witness request.", content: { "application/json": { schema: accountViewSchema } } },
          "400": errorResponse, "401": errorResponse, "404": reviewNotFound, "409": errorResponse, "422": errorResponse, "502": errorResponse,
        },
      },
      run: (req) => handlePublishReviewAccount(req, req.params.slug, req.params.revision),
    },
  }),

  route("/api/review-lineages/:slug/revisions/:revision/files/:fileId", {
    GET: {
      doc: {
        operationId: "readReviewRevisionFileLines",
        summary: "Read retained lines from one file of a source revision",
        description: "The opaque file id must belong to this revision's capture. Paths, repositories, Git object ids, and storage digests are never accepted as authority. This route never calls GitHub.",
        security: "keyOrSession",
        parameters: [
          slugParam,
          revisionParam,
          { name: "fileId", in: "path", required: true, schema: { type: "string", pattern: STF_ID_RE.source } },
          { name: "side", in: "query", required: true, schema: { type: "string", enum: ["old", "new"] } },
          { name: "start", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
          { name: "end", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          "200": { description: "At most 400 retained text lines.", content: { "application/json": { schema: stageLinesSchema } } },
          "404": reviewNotFound, "422": errorResponse, "500": errorResponse, "502": errorResponse,
        },
      },
      run: (req) => handleRevisionLines(req, req.params.slug, req.params.revision, req.params.fileId),
    },
  }),

  route("/api/review-witness-requests/:id/fail", {
    POST: {
      doc: {
        operationId: "failWitnessRequest",
        summary: "Record that a witness could not produce an account",
        description: "Pending becomes failed, carrying bounded text a reader is shown. A request that already published is a 409. The query carries the key's workspace, so a request id from elsewhere misses rather than resolving.",
        security: "key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: WTR_ID_RE.source } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object", required: ["error"], additionalProperties: false,
            properties: { error: { type: "string", minLength: 1, maxLength: 600, description: "What went wrong, as a reader will see it." } },
          } } },
        },
        responses: {
          "200": { description: "The failed witness request.", content: { "application/json": { schema: witnessRequestSchema } } },
          "400": errorResponse, "401": errorResponse, "404": reviewNotFound, "409": errorResponse, "422": errorResponse,
        },
      },
      run: (req) => handleFailWitnessRequest(req, req.params.id),
    },
  }),

  route("/api/review-witness-requests/:id/retry", {
    POST: {
      doc: {
        operationId: "retryWitnessRequest",
        summary: "Put a failed witness request back in the queue",
        description: "Failed becomes pending and counts one retry, which is what makes a reader say `retrying` rather than `pending`. Retrying an already-pending request changes nothing and says so; a published one is a 409.",
        security: "key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: WTR_ID_RE.source } }],
        responses: {
          "200": { description: "The pending witness request.", content: { "application/json": { schema: witnessRequestSchema } } },
          "401": errorResponse, "404": reviewNotFound, "409": errorResponse,
        },
      },
      run: (req) => handleRetryWitnessRequest(req, req.params.id),
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
                  projects: {
                    type: "array",
                    description:
                      "Optional project slugs to attach this review to on publish. An " +
                      "unknown slug refuses the publish; attach-only, detaching is the " +
                      "membership DELETE route's explicit act.",
                    items: { type: "string", pattern: SLUG_RE.source },
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
