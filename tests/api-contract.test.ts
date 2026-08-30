// The API document, checked against the API.
//
// Structure is no longer at risk: src/api.ts is the single list both the route table and
// /openapi.json are built from, so a path can no longer appear in one and not the other.
// What is still hand-written, and so still able to be wrong, is what each operation SAYS
// — which fields a caller must send, and what comes back. That is what this file makes
// answerable against a running server.
//
// The two questions it asks of every operation it can reach:
//
//   1. Is each field the document calls `required` actually required? Omit it and the
//      handler must refuse, naming that field. This is the check that would have caught
//      the annotation route being described with `answer` as a string and no `id`.
//   2. Does a real 200 match the declared response schema? Validated with ajv rather
//      than by hand, because hand-rolling a validator to check hand-rolled schemas
//      proves very little.
//
// Where an operation cannot be driven to a 200 here it is named in UNREACHABLE below,
// with why. A silent gap would read as coverage.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { API_ROUTES, openApiPaths } from "../src/api";
import { openApiSpec } from "../src/agent-discovery";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import { startServer } from "../src/server";
import { storeGoldenReview } from "./overseer/fixtures/stored-review";

// ---- schema validation ----

// The document's own `components` are registered so `$ref` into them resolves, which is
// how the shared Error and ReviewNotFound shapes stay one definition.
function validator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(openApiSpec() as object, "openapi");
  return ajv;
}

/** The 200's JSON schema for an operation, as a standalone schema whose `$ref`s still
 *  point into the served document. */
function okSchema(operation: any): unknown | null {
  const content = operation?.responses?.["200"]?.content?.["application/json"];
  return content?.schema ?? null;
}

// ---- fixtures ----

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let ws = "";
let key = "";
const SLUG = "contract-golden";
const BUNDLE = "contract-bundle";

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...extra };
}

async function readJson(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Contract", owner);
  key = mintApiKey(owner, ws, "contract").token;
  // Seeded rather than published: what is under test is the document, not the publish
  // path, and seeding needs no GitHub at all.
  storeGoldenReview(ws, SLUG);
  await fetch(`${base}/api/bundles/${BUNDLE}`, {
    method: "PUT",
    headers: auth(),
    body: zipSync({ "index.html": strToU8("<html></html>") }),
  });
});
afterAll(() => server.stop(true));

// ---- the structure the projection guarantees ----

describe("the document and the router are one list", () => {
  test("exactly one route is deliberately undescribed, and it is the webhook", () => {
    // `doc` is required and nullable, so a route cannot be added without deciding. This
    // pins what has been decided: any second `null` should be argued for in review
    // rather than arrive with a diff.
    const undescribed = API_ROUTES.flatMap((r) =>
      Object.entries(r.methods)
        .filter(([, entry]) => entry.doc === null)
        .map(([method]) => `${method} ${r.path}`),
    );
    expect(undescribed).toEqual(["POST /api/github/webhook"]);
  });

  test("the stage capture read has one indistinguishable refusal response", () => {
    const route = API_ROUTES.find((entry) => entry.path === "/api/stage-captures/:id")!;
    const responses = route.methods.GET!.doc!.responses;
    expect(responses["401"]).toBeUndefined();
    expect(responses["404"]).toBeDefined();
  });

  test("no two operations share an operationId", () => {
    const ids = API_ROUTES.flatMap((r) =>
      Object.values(r.methods)
        .map((entry) => entry.doc?.operationId)
        .filter((id): id is string => id !== undefined),
    );
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("every mutation a session can reach refuses a foreign Origin", async () => {
    // `guarded()` is a wrapper, and a wrapper is a convention: nothing in the types makes
    // anyone reach for it. This is where it becomes an obligation. The list is derived
    // rather than written down, so a new session-reachable mutation joins it without
    // anybody remembering to.
    const shouldGuard = API_ROUTES.flatMap((r) =>
      Object.entries(r.methods)
        .filter(([method, entry]) => entry.doc?.security === "keyOrSession" && method !== "GET")
        .map(([method]) => ({ path: r.path, method })),
    );
    expect(shouldGuard.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "DELETE /api/shares/:id",
      "POST /api/reviews/:slug/annotations",
      "POST /api/reviews/:slug/refresh",
      "POST /api/shares",
    ]);

    for (const { path, method } of shouldGuard) {
      const probe = path.replace("/:slug", `/${SLUG}`).replace(/\/:[^/]+/g, "/probe");
      const res = await fetch(`${base}${probe}`, {
        method,
        headers: auth({ "content-type": "application/json", origin: "https://evil.example" }),
        body: method === "DELETE" ? undefined : "{}",
      });
      // 403 with these bytes, and before anything else the handler would have said —
      // a cross-site post must not reach the work.
      expect({ path, method, status: res.status, said: await res.text() }).toEqual({
        path,
        method,
        status: 403,
        said: "Bad origin",
      });
    }
  });

  test("every described path is one Bun actually routes", async () => {
    // The projection rewrites `:slug` to `{slug}`. That rewrite, and nothing else, stands
    // between the two spellings — so this is the one structural thing still worth
    // checking end to end. A path nothing matched comes back as the catch-all's exact
    // bytes; several of these answer 404 on purpose and are not that.
    //
    // Walked off the whole served document rather than off openApiPaths(), so /healthz —
    // the one path still written by hand, because it is not an /api/ route — is checked
    // too. It was not, briefly, and nothing said so.
    const served = (openApiSpec() as { paths: Record<string, Record<string, unknown>> }).paths;
    for (const [path, operations] of Object.entries(served)) {
      const probe = path.replace(/\{[^}]+\}/g, "probe");
      for (const method of Object.keys(operations)) {
        const res = await fetch(`${base}${probe}`, { method: method.toUpperCase() });
        const unmatched = res.status === 404 && (await res.text()) === "Not found";
        expect({ path, method, unmatched }).toEqual({ path, method, unmatched: false });
      }
    }
  });
});

// ---- what the document says a caller must send ----

describe("a required field is one the handler requires", () => {
  /** Every `required` field of an operation's JSON request schema, with the branch it
   *  came from when the schema is a `oneOf`. */
  function requiredFields(operation: any): { branch: string; required: string[]; body: any }[] {
    const schema = operation?.requestBody?.content?.["application/json"]?.schema;
    if (!schema) return [];
    const branches = schema.oneOf ?? [schema];
    return branches.map((b: any) => ({
      branch: b.title ?? "body",
      required: b.required ?? [],
      body: b,
    }));
  }

  function operation(path: string, method: string): any {
    return (openApiPaths()[path] as any)?.[method];
  }

  /** A body satisfying a branch's required fields, with one of them left out. */
  function bodyMissing(branch: any, omit: string, sample: Record<string, unknown>): unknown {
    const body: Record<string, unknown> = {};
    for (const field of branch.required) {
      if (field !== omit) body[field] = sample[field];
    }
    return body;
  }

  test("POST /api/reviews refuses a body missing `slug` or `prs`, naming it", async () => {
    const branch = requiredFields(operation("/api/reviews", "post"))[0]!;
    expect(branch.required).toEqual(["slug", "prs"]);
    const sample = { slug: "contract-probe", prs: ["acme/seer#1"] };

    for (const omit of branch.required) {
      const res = await fetch(`${base}/api/reviews`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify(bodyMissing(branch.body, omit, sample)),
      });
      const said = JSON.stringify(await readJson(res));
      expect({ omit, refused: res.status >= 400, named: said.includes(omit) }).toEqual({
        omit,
        refused: true,
        named: true,
      });
    }
  });

  test("POST /api/projects/{slug}/tasks refuses a body missing `title`, naming it", async () => {
    const branch = requiredFields(operation("/api/projects/{slug}/tasks", "post"))[0]!;
    expect(branch.required).toEqual(["title"]);
    // The project must exist first, or its 404 answers before the field is judged.
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ slug: "contract-tasks", title: "Contract tasks" }),
    });
    const res = await fetch(`${base}/api/projects/contract-tasks/tasks`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    const said = JSON.stringify(await readJson(res));
    expect({ refused: res.status >= 400, named: said.includes("title") }).toEqual({
      refused: true,
      named: true,
    });
  });

  test("POST /api/projects/{slug}/notes refuses a body missing `body`, naming it", async () => {
    const branch = requiredFields(operation("/api/projects/{slug}/notes", "post"))[0]!;
    expect(branch.required).toEqual(["body"]);
    // The project must exist, or the 404 answers before the field is judged.
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ slug: "contract-notes", title: "Contract notes" }),
    });
    const res = await fetch(`${base}/api/projects/contract-notes/notes`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    const said = JSON.stringify(await readJson(res));
    expect({ refused: res.status >= 400, named: said.includes("body") }).toEqual({
      refused: true,
      named: true,
    });
  });

  test("POST /api/projects refuses a body missing `slug` or `title`, naming it", async () => {
    const branch = requiredFields(operation("/api/projects", "post"))[0]!;
    expect(branch.required).toEqual(["slug", "title"]);
    const sample = { slug: "contract-probe-project", title: "Contract probe" };

    for (const omit of branch.required) {
      const res = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify(bodyMissing(branch.body, omit, sample)),
      });
      const said = JSON.stringify(await readJson(res));
      expect({ omit, refused: res.status >= 400, named: said.includes(omit) }).toEqual({
        omit,
        refused: true,
        named: true,
      });
    }
  });

  test("POST /api/shares refuses a body missing `kind` or `target`, naming it", async () => {
    const branch = requiredFields(operation("/api/shares", "post"))[0]!;
    expect(branch.required).toEqual(["kind", "target"]);
    const sample = { kind: "bundle", target: BUNDLE };

    for (const omit of branch.required) {
      const res = await fetch(`${base}/api/shares`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ workspace: ws, ...(bodyMissing(branch.body, omit, sample) as object) }),
      });
      const said = JSON.stringify(await readJson(res));
      expect({ omit, refused: res.status >= 400, named: said.includes(omit) }).toEqual({
        omit,
        refused: true,
        named: true,
      });
    }
  });

  test("both branches of the annotation body are required as described", async () => {
    // The regression this file exists for. The document said `answer: string` and named
    // no `id`; the handler puts `answer` through `asObject` and requires a top-level
    // `id`. Both halves are now driven from what the document claims.
    const branches = requiredFields(operation("/api/reviews/{slug}/annotations", "post"));
    expect(branches.map((b) => b.branch)).toEqual(["File a question", "Answer an open question"]);

    const [filing, answering] = branches;
    expect(filing!.required).toEqual(["target", "body"]);
    expect(answering!.required).toEqual(["id", "answer"]);

    // Filing is a member's act; AUTH_DISABLED makes every request in this process the
    // root user's session, so no header is sent. Answering is the key's.
    const samples: Record<string, unknown> = {
      target: { type: "statement", id: "s1" },
      body: "why this way?",
      id: "ann_probeprobe",
      answer: { body: "because" },
    };

    // `answer` is not merely required by its branch — it is what tells the two branches
    // apart. A body without it is not a malformed answer, it is a filing, and the handler
    // is right to read it as one. A presence-discriminated union cannot be probed for its
    // own discriminator; everything else in both branches is, and the fall-through is
    // asserted directly below instead.
    const DISCRIMINATOR = "answer";

    for (const [branch, headers] of [
      [filing!, { "content-type": "application/json" }],
      [answering!, auth({ "content-type": "application/json" })],
    ] as const) {
      for (const omit of branch.required.filter((f) => f !== DISCRIMINATOR)) {
        const res = await fetch(`${base}/api/reviews/${SLUG}/annotations`, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyMissing(branch.body, omit, samples)),
        });
        const said = JSON.stringify(await readJson(res));
        expect({ branch: branch.branch, omit, refused: res.status >= 400, named: said.includes(omit) }).toEqual({
          branch: branch.branch,
          omit,
          refused: true,
          named: true,
        });
      }
    }
  });

  test("a body without `answer` is read as a filing, which is what the two schemas mean", async () => {
    // The other half of the discriminator: the document says `answer` present is what
    // picks the answering branch, so a body carrying only the answering branch's `id`
    // must still land in the filing branch. What proves which branch ran is which fields
    // the refusal names — filing's, not answering's.
    const res = await fetch(`${base}/api/reviews/${SLUG}/annotations`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ id: "ann_probeprobe" }),
    });
    const said = (await readJson(res)) as { errors: { field: string }[] };
    expect(said.errors.map((e) => e.field).sort()).toEqual(["body", "target.id", "target.type"]);
  });
});

// ---- what the document says comes back ----

describe("a 200 matches the schema the document declares for it", () => {
  /** Operations whose 200 is not driven here, and why. Named rather than skipped
   *  silently, because a gap that looks like coverage is worse than a gap. */
  const UNREACHABLE: Record<string, string> = {
    publishReview:
      "needs the offline GitHub fixture and the golden derivation; covered end to end in " +
      "tests/overseer/routes.test.ts, and its required fields are checked above",
    publishReviewViaPost: "same operation as publishReview",
    refreshReview: "spends a GitHub budget and is rate limited; its 200 declares only an object",
    annotateReview: "declares only an object; the annotation's own shape is tests/overseer/annotations.test.ts",
    publishImage: "sharp re-encodes on the way in; covered end to end in tests/images.test.ts",
    publishImageViaPost: "same operation as publishImage",
    health: "not an /api/ route; its 200 is the four bytes of `ok`",
    createStageCapture: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    readStageCapture: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    publishStage: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    readLatestStage: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    readStageVersion: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    readStageCaptureObject: "stage operations are validated by the authenticated integration coverage in tests/stage.test.ts and tests/stage-reader.test.ts",
    readStageFileLines: "stage operations are validated by the authenticated integration coverage in tests/stage-reader.test.ts",
    // The promoted review needs a completed capture behind it, which needs a GitHub
    // fixture. It is driven, and its 200s are checked against these same schemas, in
    // tests/overseer/revision.test.ts.
    createReviewLineage: "a promoted review needs a completed capture; driven and schema-checked in tests/overseer/revision.test.ts",
    readReviewLineage: "a promoted review needs a completed capture; driven and schema-checked in tests/overseer/revision.test.ts",
    readReviewRevision: "a promoted review needs a completed capture; driven and schema-checked in tests/overseer/revision.test.ts",
    readReviewRevisionDelta: "a promoted review needs two completed captures; driven and schema-checked in tests/overseer/pr-movement.test.ts",
    publishReviewAccount: "a promoted review needs a completed capture; driven and schema-checked in tests/overseer/revision.test.ts",
    readReviewRevisionFileLines: "a promoted review needs a completed capture; driven and schema-checked in tests/overseer/revision.test.ts",
    failWitnessRequest: "a witness request only exists behind a published revision; driven in tests/overseer/revision.test.ts",
    retryWitnessRequest: "a witness request only exists behind a published revision; driven in tests/overseer/revision.test.ts",
    claimWitnessRequest: "a witness request only exists behind a published revision; driven in tests/overseer/revision-pr.test.ts",
    // The pull request path needs a GitHub fixture for both the observation and the
    // pinned capture behind it. Every one of these is driven, and its body checked
    // against these same schemas, in tests/overseer/revision-pr.test.ts.
    createPullRequestReviewLineage: "needs a GitHub fixture and a pinned capture; driven and schema-checked in tests/overseer/revision-pr.test.ts",
    attachPullRequestToReviewLineage: "needs a GitHub fixture and a completed capture; driven and schema-checked in tests/overseer/revision-pr.test.ts",
    refreshReviewLineagePullRequest: "needs a stored read actor and a GitHub fixture; driven and schema-checked in tests/overseer/revision-pr.test.ts",
    readReviewCaptureJob: "a capture job only exists behind an ingested pull request; driven and schema-checked in tests/overseer/revision-pr.test.ts",
    retryReviewCaptureJob: "a failed capture job only exists behind an ingested pull request; driven in tests/overseer/revision-pr.test.ts",
    // A stack needs several ingested pull requests with completed revisions and accounts.
    // Every one of these is driven, and its body checked against these same schemas, in
    // tests/overseer/stack.test.ts.
    createReviewStack: "needs ingested pull request lineages; driven and schema-checked in tests/overseer/stack.test.ts",
    readReviewStack: "needs a created stack; driven and schema-checked in tests/overseer/stack.test.ts",
    readReviewStackManifest: "needs a created stack; driven and schema-checked in tests/overseer/stack.test.ts",
    readReviewStackAccount: "needs a published stack account; driven and schema-checked in tests/overseer/stack.test.ts",
    publishReviewStackAccount: "needs an account-ready manifest; driven and schema-checked in tests/overseer/stack.test.ts",
    refreshReviewStack: "needs a created stack; driven and schema-checked in tests/overseer/stack.test.ts",
    readReviewStackMemberFileLines: "needs a created stack; driven and schema-checked in tests/overseer/stack.test.ts",
    claimStackWitnessRequest: "needs an account-ready manifest; driven and schema-checked in tests/overseer/stack.test.ts",
    failStackWitnessRequest: "needs an account-ready manifest; driven in tests/overseer/stack.test.ts",
    retryStackWitnessRequest: "needs an account-ready manifest; driven in tests/overseer/stack.test.ts",
    readStackRefreshJob: "a refresh job only exists behind a stack membership delivery; driven and schema-checked in tests/overseer/stack.test.ts",
    retryStackRefreshJob: "a failed refresh job only exists behind a stack membership delivery; driven in tests/overseer/stack.test.ts",
    attachProjectReviewStack: "needs a created stack; driven in tests/overseer/stack.test.ts",
    detachProjectReviewStack: "needs a created stack; driven in tests/overseer/stack.test.ts",
  };

  let ajv: Ajv2020;
  beforeAll(() => {
    ajv = validator();
  });

  /** Drive an operation to a 200 and check the body against its declared schema. */
  async function check(operationId: string, run: () => Promise<Response>): Promise<void> {
    const operation = Object.values(openApiPaths())
      .flatMap((ops) => Object.values(ops as Record<string, any>))
      .find((op: any) => op.operationId === operationId);
    expect(operation).toBeDefined();

    const schema = okSchema(operation);
    expect({ operationId, hasSchema: schema !== null }).toEqual({ operationId, hasSchema: true });

    const res = await run();
    expect({ operationId, status: res.status }).toEqual({ operationId, status: 200 });
    const body = await readJson(res);

    const validate = ajv.compile(schema as object);
    if (!validate(body)) {
      throw new Error(
        `${operationId} answered a body the document does not describe:\n` +
          ajv.errorsText(validate.errors, { separator: "\n" }),
      );
    }
  }

  test("listBundles", async () => {
    await check("listBundles", () => fetch(`${base}/api/bundles`, { headers: auth() }));
  });

  test("publishBundle, by both verbs", async () => {
    // Both, because the document says PUT and POST are identical and that is a claim
    // about the server rather than a note about the code. Listing the POST as driven
    // while driving only the PUT was how this test file first said it.
    const zip = () => zipSync({ "index.html": strToU8("<html></html>") });
    await check("publishBundle", () =>
      fetch(`${base}/api/bundles/contract-published`, { method: "PUT", headers: auth(), body: zip() }),
    );
    await check("publishBundleViaPost", () =>
      fetch(`${base}/api/bundles/contract-published`, { method: "POST", headers: auth(), body: zip() }),
    );
  });

  test("listImages", async () => {
    await check("listImages", () => fetch(`${base}/api/images`, { headers: auth() }));
  });

  test("readReview and readReviewVersion", async () => {
    await check("readReview", () => fetch(`${base}/api/reviews/${SLUG}`, { headers: auth() }));
    await check("readReviewVersion", () => fetch(`${base}/api/reviews/${SLUG}/v/1`, { headers: auth() }));
  });

  test("the projects operations, end to end", async () => {
    // One walk drives all eight: parent and child created, listed, read, updated,
    // then the bundle and review attached and detached again. The walk leaves the
    // projects standing — later assertions read the same workspace.
    const json = (body: unknown) => ({
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    await check("createProject", () =>
      fetch(`${base}/api/projects`, json({ slug: "contract-parent", title: "Contract parent" })),
    );
    await check("listProjects", async () => {
      // The child exists before the list is checked, so the listing covers a row
      // whose `parent` is a slug rather than always null.
      await fetch(
        `${base}/api/projects`,
        json({ slug: "contract-child", title: "Contract child", parent: "contract-parent" }),
      );
      return fetch(`${base}/api/projects`, { headers: auth() });
    });
    await check("readProject", () =>
      fetch(`${base}/api/projects/contract-parent`, { headers: auth() }),
    );
    await check("updateProject", () =>
      fetch(`${base}/api/projects/contract-parent`, {
        method: "PATCH",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ status: "done" }),
      }),
    );
    await check("attachProjectBundle", () =>
      fetch(`${base}/api/projects/contract-parent/bundles/${BUNDLE}`, { method: "PUT", headers: auth() }),
    );
    await check("detachProjectBundle", () =>
      fetch(`${base}/api/projects/contract-parent/bundles/${BUNDLE}`, { method: "DELETE", headers: auth() }),
    );
    await check("attachProjectReview", () =>
      fetch(`${base}/api/projects/contract-parent/reviews/${SLUG}`, { method: "PUT", headers: auth() }),
    );
    await check("detachProjectReview", () =>
      fetch(`${base}/api/projects/contract-parent/reviews/${SLUG}`, { method: "DELETE", headers: auth() }),
    );

    let taskId = "";
    await check("createTask", async () => {
      const res = await fetch(
        `${base}/api/projects/contract-parent/tasks`,
        json({ title: "Contract task", gates: [{ text: "the walk passes" }] }),
      );
      taskId = ((await res.clone().json()) as { id: string }).id;
      return res;
    });
    await check("updateTask", () =>
      fetch(`${base}/api/projects/contract-parent/tasks/${taskId}`, {
        method: "PATCH",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ gates: [{ text: "the walk passes", met: true }] }),
      }),
    );

    await check("createNote", () =>
      fetch(
        `${base}/api/projects/contract-parent/notes`,
        json({ body: "A contract note.", task: taskId }),
      ),
    );
    await check("listNotes", () =>
      fetch(`${base}/api/projects/contract-parent/notes`, { headers: auth() }),
    );
  });

  test("createShare, listShares and revokeShare", async () => {
    let minted = "";
    await check("createShare", async () => {
      const res = await fetch(`${base}/api/shares`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ workspace: ws, kind: "bundle", target: BUNDLE, label: "contract" }),
      });
      minted = ((await res.clone().json()) as { id: string }).id;
      return res;
    });

    await check("listShares", () => fetch(`${base}/api/shares?workspace=${ws}`, { headers: auth() }));
    await check("revokeShare", () =>
      fetch(`${base}/api/shares/${minted}`, { method: "DELETE", headers: auth() }),
    );
  });

  test("every operation is either driven above or named unreachable", () => {
    const driven = new Set([
      "listBundles",
      "publishBundle",
      "publishBundleViaPost",
      "listImages",
      "readReview",
      "readReviewVersion",
      "createShare",
      "listShares",
      "revokeShare",
      "createProject",
      "listProjects",
      "readProject",
      "updateProject",
      "attachProjectBundle",
      "detachProjectBundle",
      "attachProjectReview",
      "detachProjectReview",
      "createTask",
      "updateTask",
      "createNote",
      "listNotes",
    ]);
    const ids = Object.values((openApiSpec() as any).paths as Record<string, Record<string, any>>)
      .flatMap((ops) => Object.values(ops))
      .map((op: any) => op.operationId as string);

    const unaccounted = ids.filter((id) => !driven.has(id) && !(id in UNREACHABLE));
    expect(unaccounted).toEqual([]);
  });
});
