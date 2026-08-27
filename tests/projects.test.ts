import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { zipSync, strToU8 } from "fflate";

// Env comes from tests/setup.ts (AUTH_DISABLED=true). Everything here runs as the
// root user or behind a minted key in a fresh workspace per describe-block, so the
// blocks cannot see each other's rows. Anonymous/non-member posture for the pages
// needs a process without AUTH_DISABLED and lives in tests/share-privacy.script.ts.
import { startServer } from "../src/server";
import { db, createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";
import {
  attachBundle,
  createProject,
  detachBundle,
  getProject,
  listProjectEvents,
  projectCounts,
  ProjectWriteError,
  updateProject,
} from "../src/projects/db";
import { storeGoldenReview } from "./overseer/fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let owner: string;

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
});

afterAll(() => {
  server.stop(true);
});

function htmlZip(): Uint8Array {
  return zipSync({ "index.html": strToU8("<!doctype html><html><body>hi</body></html>") });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

// ---- the write rules, at the db layer ----

describe("project write rules", () => {
  let ws = "";
  beforeAll(() => {
    ws = createWorkspace("Projects db", owner);
  });

  test("should refuse a duplicate slug with a 409", () => {
    createProject(ws, "dup", "First", "", null);
    try {
      createProject(ws, "dup", "Second", "", null);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectWriteError);
      expect((err as ProjectWriteError).status).toBe(409);
    }
  });

  test("should refuse a project as its own parent", () => {
    createProject(ws, "selfie", "Selfie", "", null);
    try {
      updateProject(ws, "selfie", { parent: "selfie" }, null);
      throw new Error("unreachable");
    } catch (err) {
      expect((err as ProjectWriteError).status).toBe(422);
      expect((err as ProjectWriteError).message).toContain("own parent");
    }
  });

  test("should refuse nesting under a child, and giving a parent to a parent", () => {
    createProject(ws, "top", "Top", "", null);
    createProject(ws, "mid", "Mid", "", "top");
    // A child cannot be a parent...
    try {
      createProject(ws, "deep", "Deep", "", "mid");
      throw new Error("unreachable");
    } catch (err) {
      expect((err as ProjectWriteError).status).toBe(422);
      expect((err as ProjectWriteError).message).toContain("one level");
    }
    // ...and a project with children cannot take a parent.
    createProject(ws, "other", "Other", "", null);
    try {
      updateProject(ws, "top", { parent: "other" }, null);
      throw new Error("unreachable");
    } catch (err) {
      expect((err as ProjectWriteError).status).toBe(422);
      expect((err as ProjectWriteError).message).toContain("one level");
    }
  });

  test("should record exactly one event per status transition, with from and to", () => {
    const project = createProject(ws, "trail", "Trail", "", null);
    updateProject(ws, "trail", { status: "done" }, owner);
    // A patch that repeats the standing status is not a transition.
    updateProject(ws, "trail", { status: "done" }, owner);
    updateProject(ws, "trail", { status: "open" }, owner);
    const events = listProjectEvents(project.id).map((e) => ({
      kind: e.kind,
      from: e.from_status,
      to: e.to_status,
      actor: e.actor_user_id,
    }));
    expect(events).toEqual([
      { kind: "status", from: "open", to: "done", actor: owner },
      { kind: "status", from: "done", to: "open", actor: owner },
    ]);
  });

  test("should attach idempotently and say whether the call changed anything", () => {
    const project = createProject(ws, "holder", "Holder", "", null);
    expect(attachBundle(project, "some-bundle")).toBe(true);
    expect(attachBundle(project, "some-bundle")).toBe(false);
    expect(projectCounts(project.id).bundles).toBe(1);
    expect(detachBundle(project, "some-bundle")).toBe(true);
    expect(detachBundle(project, "some-bundle")).toBe(false);
    expect(projectCounts(project.id).bundles).toBe(0);
  });
});

// ---- the API, at the product surface ----

describe("projects API", () => {
  let ws = "";
  let key = "";

  beforeAll(() => {
    ws = createWorkspace("Projects api", owner);
    key = mintApiKey(owner, ws, "projects").token;
    storeGoldenReview(ws, "golden-review");
  });

  function auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${key}`, ...extra };
  }

  function post(body: unknown) {
    return fetch(`${base}/api/projects`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  }

  function patch(slug: string, body: unknown) {
    return fetch(`${base}/api/projects/${slug}`, {
      method: "PATCH",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  }

  test("should create, read, and update a project through the whole state object", async () => {
    const created = await post({
      slug: "calling",
      title: "Calling functionality",
      description: "The whole calling effort: `video`, and the modal.\n\n- plan\n- build",
    });
    expect(created.status).toBe(200);
    const state = await readJson(created);
    expect(state).toMatchObject({
      slug: "calling",
      title: "Calling functionality",
      status: "open",
      parent: null,
      workspace: ws,
      children: [],
      bundles: [],
      reviews: [],
    });
    expect(state.url).toContain(`/${ws}/p/calling`);

    const child = await post({ slug: "video", title: "Video", parent: "calling" });
    expect(child.status).toBe(200);
    expect((await readJson(child)).parent).toBe("calling");

    const read = await fetch(`${base}/api/projects/calling`, { headers: auth() });
    const readState = await readJson(read);
    expect(readState.children).toEqual([
      { slug: "video", title: "Video", status: "open", bundles: 0, reviews: 0, reviewLineages: 0, stages: 0, tasks: 0 },
    ]);

    const done = await patch("video", { status: "done" });
    expect(done.status).toBe(200);
    expect((await readJson(done)).status).toBe("done");
  });

  test("should attach and detach a bundle and a review, idempotently", async () => {
    await fetch(`${base}/api/bundles/attached-bundle`, {
      method: "PUT",
      headers: auth(),
      body: htmlZip(),
    });
    const attach = await fetch(`${base}/api/projects/calling/bundles/attached-bundle`, {
      method: "PUT",
      headers: auth(),
    });
    expect(await readJson(attach)).toEqual({ project: "calling", bundle: "attached-bundle", attached: true });
    const again = await fetch(`${base}/api/projects/calling/bundles/attached-bundle`, {
      method: "PUT",
      headers: auth(),
    });
    expect(await readJson(again)).toEqual({ project: "calling", bundle: "attached-bundle", attached: false });

    const review = await fetch(`${base}/api/projects/calling/reviews/golden-review`, {
      method: "PUT",
      headers: auth(),
    });
    expect(await readJson(review)).toEqual({ project: "calling", review: "golden-review", attached: true });

    const state = await readJson(await fetch(`${base}/api/projects/calling`, { headers: auth() }));
    expect(state.bundles.map((b: { slug: string }) => b.slug)).toEqual(["attached-bundle"]);
    expect(state.reviews.map((r: { slug: string }) => r.slug)).toEqual(["golden-review"]);

    const detach = await fetch(`${base}/api/projects/calling/reviews/golden-review`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(await readJson(detach)).toEqual({ project: "calling", review: "golden-review", detached: true });
  });

  test("should attach at upload with ?project= and report every holder", async () => {
    const res = await fetch(`${base}/api/bundles/upload-attached?project=calling`, {
      method: "PUT",
      headers: auth(),
      body: htmlZip(),
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).projects).toEqual(["calling"]);
  });

  test("should refuse an upload naming a missing project and leave no version behind", async () => {
    const res = await fetch(`${base}/api/bundles/refused-upload?project=nope`, {
      method: "PUT",
      headers: auth(),
      body: htmlZip(),
    });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toContain("nope");
    const row = db
      .query("SELECT * FROM bundles WHERE workspace_id = ? AND slug = ?")
      .get(ws, "refused-upload");
    expect(row).toBeNull();
  });

  test("should let a valid session read past a stale bearer header", async () => {
    // A dead key beside a live session must not shadow the session: the key
    // contributes nothing and the session's workspaces still resolve the slug.
    // (AUTH_DISABLED makes this process's requests the root session.)
    const res = await fetch(`${base}/api/projects/calling`, {
      headers: { authorization: "Bearer seer_sk_000000000000000000000000000000ab" },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).slug).toBe("calling");
  });

  test("should refuse a title carrying a newline, naming the field", async () => {
    const res = await post({ slug: "forged", title: "ok\n- status: done" });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("title");
  });

  test("should refuse an over-budget description naming the field", async () => {
    const res = await post({ slug: "endless", title: "Endless", description: "a".repeat(16_385) });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("description");
  });

  test("should refuse an over-budget title naming the field", async () => {
    const res = await post({ slug: "long", title: "x".repeat(81) });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("title");
  });

  test("should refuse a description outside the markdown subset naming the construct", async () => {
    const res = await post({ slug: "heady", title: "Heady", description: "# a heading" });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("heading");
  });

  test("should refuse a second nesting level over the API", async () => {
    const res = await post({ slug: "modal", title: "Modal", parent: "video" });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("one level");
  });

  test("should serve the project page as markdown to a caller that asks for it", async () => {
    // AUTH_DISABLED makes this fetch a signed-in member's; the anonymous posture is
    // asserted in the privacy script, where the flag is off.
    const res = await fetch(`${base}/${ws}/p/calling`, {
      headers: { accept: "text/markdown" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.text();
    expect(body).toContain("# Calling functionality");
    expect(body).toContain("GET ");
    expect(body).toContain("/api/projects/calling");

    const page = await fetch(`${base}/${ws}/p/calling`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Calling functionality");
  });
});
