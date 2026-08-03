// Annotations: filing one, answering one, and what the page does with both.
//
// The documents are seeded straight into the store, as the read tests do: what is
// under test is the one thing written after publication, not publication. The two
// questions this process cannot ask, what a signed-out browser gets and what an API
// key gets when it tries to file, need forged cookies and no ambient session, so they
// live in annotations-roles.script.ts and run in their own process.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { join } from "node:path";

import { startServer } from "../../src/server";
import { config } from "../../src/config";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../../src/db";
import { listAnnotations } from "../../src/overseer/db";
import { setGithubClient, type GithubClient } from "../../src/overseer/github";
import { offlineGithubClient } from "../offline-github";
import { GOLDEN_HEAD_SHA_12 } from "./fixtures/golden-review";
import { storeGoldenReview } from "./fixtures/stored-review";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let ws = "";
let key = "";
let otherKey = "";
let priorToken: string | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

/** A file long enough for every ref range below to land inside it. */
function blob(path: string): string {
  return Array.from({ length: 400 }, (_, i) => `// ${path} line ${i + 1}`).join("\n") + "\n";
}

const fake: GithubClient = {
  ...offlineGithubClient(),
  async getFileAtSha(_repo, path) {
    return blob(path);
  },
};

/** A filing, as the browser's own JSON. No authorization header: AUTH_DISABLED makes
 *  every request in this process the root user's session, which is what a member is. */
function file(slug: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/reviews/${slug}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An answer, as the skill sends it: an API key and a JSON body carrying `answer`. */
function answer(slug: string, body: unknown, token = key): Promise<Response> {
  return fetch(`${base}/api/reviews/${slug}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function page(slug: string): Promise<Response> {
  return fetch(`${base}/r/${slug}`);
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  setGithubClient(fake);
  priorToken = config.githubToken;
  config.githubToken = "fake-token";

  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Annotations", owner);
  key = mintApiKey(owner, ws, "annotations").token;
  const other = createWorkspace("Elsewhere", owner);
  otherKey = mintApiKey(owner, other, "elsewhere").token;
});

afterAll(() => {
  config.githubToken = priorToken;
  setGithubClient(offlineGithubClient());
  server.stop(true);
});

describe("filing", () => {
  test("a member files against a real statement and gets an id", async () => {
    storeGoldenReview(ws, "filed");
    const res = await file("filed", {
      target: { type: "statement", id: "st_gate" },
      quote: "the workspace session gate",
      body: "Does a key minted before the gate still read?",
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.id).toMatch(/^ann_/);
    expect(json.version).toBe(1);
    expect(json.status).toBe("open");

    const stored = listAnnotations(ws, "filed");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.target).toEqual({ type: "statement", id: "st_gate" });
    expect(stored[0]!.status).toBe("open");
    expect(stored[0]!.version).toBe(1);
  });

  test("the filed annotation comes back on the read route", async () => {
    const res = await fetch(`${base}/api/reviews/filed`);
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.document.annotations).toHaveLength(1);
    expect(json.document.annotations[0].body).toContain("Does a key minted");
  });

  test("the page draws it under its target, open, with the version it was filed against", async () => {
    const html = await (await page("filed")).text();
    expect(html).toContain(`<section id="questions">`);
    expect(html).toContain("Does a key minted before the gate still read?");
    expect(html).toContain("filed against v1");
    expect(html).toContain(`<span class="is-open">open</span>`);
    // Anchored both ways: the question points at its target, the target row points back.
    expect(html).toContain(`<a href="#st_gate">statement st_gate</a>`);
    expect(html).toMatch(/<p class="qhere"><a href="#ann_[a-z0-9]+">open question<\/a><\/p>/);
  });

  test("every target type the review actually has is fileable", async () => {
    storeGoldenReview(ws, "targets");
    for (const target of [
      { type: "note", id: "no_keys" },
      { type: "group", id: "gr_gate" },
      { type: "summary", id: "summary" },
    ]) {
      const res = await file("targets", { target, body: `About ${target.type}` });
      expect(res.status).toBe(200);
    }
    expect(listAnnotations(ws, "targets")).toHaveLength(3);
  });

  test("a target the version does not have is a 422 naming it", async () => {
    storeGoldenReview(ws, "badtarget");
    const res = await file("badtarget", {
      target: { type: "statement", id: "st_nothing" },
      body: "Where is this?",
    });
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors[0].field).toBe("target.id");
    expect(json.errors[0].rule).toBe("target_unknown");
    expect(json.errors[0].message).toContain("st_nothing");
    expect(listAnnotations(ws, "badtarget")).toHaveLength(0);
  });

  test("a target type that is not one is a 422 naming the type", async () => {
    const res = await file("badtarget", {
      target: { type: "paragraph", id: "st_gate" },
      body: "Where is this?",
    });
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors.some((e: { field: string }) => e.field === "target.type")).toBe(true);
  });

  test("an empty body is a 422, and nothing is written", async () => {
    const res = await file("badtarget", {
      target: { type: "statement", id: "st_gate" },
      body: "   ",
    });
    expect(res.status).toBe(422);
    expect(listAnnotations(ws, "badtarget")).toHaveLength(0);
  });

  test("an unknown slug is the read path's 404, not a 401 or a 400", async () => {
    const res = await file("no-such-review-here", {
      target: { type: "summary", id: "summary" },
      body: "Anyone?",
    });
    expect(res.status).toBe(404);
    expect(await readJson(res)).toEqual({ error: "No such review" });
  });
});

describe("the plain form", () => {
  test("a form post files and redirects back to the page", async () => {
    storeGoldenReview(ws, "formfiled");
    const res = await fetch(`${base}/api/reviews/formfiled/annotations`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        target: "statement:st_gate",
        body: "Asked without any javascript at all",
        quote: "",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const stored = listAnnotations(ws, "formfiled");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.quote).toBeNull();
    expect(res.headers.get("location")).toBe(`/${ws}/r/formfiled#${stored[0]!.id}`);
  });

  test("the page carries a plain form for a member, posting to the route", async () => {
    const html = await (await page("formfiled")).text();
    expect(html).toContain(`action="/api/reviews/formfiled/annotations"`);
    expect(html).toContain(`method="post"`);
    expect(html).toContain(`<option value="statement:st_gate">`);
    // No scripting anywhere in the ask block: the form is the whole mechanism.
    expect(html).not.toContain("data-js-only");
  });
});

describe("answering", () => {
  test("an API key answers an open annotation, refs and all", async () => {
    storeGoldenReview(ws, "answered");
    const filed = await readJson(
      await file("answered", {
        target: { type: "statement", id: "st_gate" },
        body: "Which helper does the gate reuse?",
      }),
    );

    const res = await answer("answered", {
      id: filed.id,
      answer: {
        body: "The same session() bundles use.",
        refs: [
          {
            repo: "acme/seer",
            sha: GOLDEN_HEAD_SHA_12,
            path: "src/auth.ts",
            startLine: 40,
            endLine: 48,
            highlight: [42],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.status).toBe("answered");
    expect(json.annotation.answer.refs).toHaveLength(1);
    expect(json.annotation.answer.refs[0].snippet).toContain("src/auth.ts line 40");
    // The ref resolved through the same rule a published ref does: it lands on a path
    // this stack changes, so it is marked as inside it.
    expect(json.annotation.answer.refs[0].origin).toBe("in_stack");

    const html = await (await page("answered")).text();
    expect(html).toContain("The same session() bundles use.");
    expect(html).toContain(`<span class="is-answered">answered</span>`);
    expect(html).toContain("src/auth.ts");
    expect(html).toMatch(/<p class="qhere"><a href="#ann_[a-z0-9]+">answered question<\/a><\/p>/);
  });

  test("an answer with no refs needs nothing from GitHub", async () => {
    storeGoldenReview(ws, "norefs");
    const filed = await readJson(
      await file("norefs", { target: { type: "summary", id: "summary" }, body: "Why one shot?" }),
    );
    const token = config.githubToken;
    config.githubToken = "";
    try {
      const res = await answer("norefs", { id: filed.id, answer: { body: "Because a pass is." } });
      expect(res.status).toBe(200);
    } finally {
      config.githubToken = token;
    }
    expect(listAnnotations(ws, "norefs")[0]!.status).toBe("answered");
  });

  test("an already answered annotation is a 422, not a silent overwrite", async () => {
    const filed = listAnnotations(ws, "norefs")[0]!;
    const res = await answer("norefs", { id: filed.id, answer: { body: "Again." } });
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors[0].rule).toBe("annotation_answered");
    expect(listAnnotations(ws, "norefs")[0]!.answer!.body).toBe("Because a pass is.");
  });

  test("an id that names no annotation on this review is a 422", async () => {
    const res = await answer("norefs", { id: "ann_nothinghere", answer: { body: "Hello?" } });
    expect(res.status).toBe(422);
    expect((await readJson(res)).errors[0].rule).toBe("annotation_unknown");
  });

  test("an unpinned ref is refused before anything is fetched", async () => {
    storeGoldenReview(ws, "badref");
    const filed = await readJson(
      await file("badref", { target: { type: "summary", id: "summary" }, body: "Why?" }),
    );
    const res = await answer("badref", {
      id: filed.id,
      answer: {
        body: "Here.",
        refs: [{ repo: "acme/seer", sha: "abc", path: "src/auth.ts", startLine: 1, endLine: 2 }],
      },
    });
    expect(res.status).toBe(422);
    const json = await readJson(res);
    expect(json.errors.some((e: { rule: string }) => e.rule === "ref_unpinned")).toBe(true);
    expect(listAnnotations(ws, "badref")[0]!.status).toBe("open");
  });

  test("a member session with no key cannot answer", async () => {
    storeGoldenReview(ws, "sessionanswer");
    const filed = await readJson(
      await file("sessionanswer", { target: { type: "summary", id: "summary" }, body: "Why?" }),
    );
    const res = await fetch(`${base}/api/reviews/sessionanswer/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: filed.id, answer: { body: "I will answer myself." } }),
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toContain("API key");
    expect(listAnnotations(ws, "sessionanswer")[0]!.status).toBe("open");
  });

  test("a key minted in another workspace cannot answer", async () => {
    const filed = listAnnotations(ws, "sessionanswer")[0]!;
    const res = await answer("sessionanswer", { id: filed.id, answer: { body: "Mine." } }, otherKey);
    expect(res.status).toBe(403);
    expect(listAnnotations(ws, "sessionanswer")[0]!.status).toBe("open");
  });
});

describe("across versions", () => {
  test("an annotation filed on v1 still renders on v3 with the version it recorded", async () => {
    storeGoldenReview(ws, "moving");
    await file("moving", {
      target: { type: "statement", id: "st_gate" },
      body: "Asked on the first pass",
    });
    storeGoldenReview(ws, "moving");
    storeGoldenReview(ws, "moving");

    const json = await readJson(await fetch(`${base}/api/reviews/moving`));
    expect(json.version).toBe(3);
    expect(json.document.annotations[0].version).toBe(1);

    const html = await (await page("moving")).text();
    expect(html).toContain("Asked on the first pass");
    expect(html).toContain("filed against v1");
    expect(html).toContain("reading v3");
  });
});

describe("escaping", () => {
  test("an adversarial body and answer arrive escaped", async () => {
    storeGoldenReview(ws, "hostile");
    const nasty = `<script>alert("q")</script> & <img src=x onerror=1>`;
    const filed = await readJson(
      await file("hostile", {
        target: { type: "statement", id: "st_gate" },
        quote: `<b>quoted</b>`,
        body: nasty,
      }),
    );
    await answer("hostile", {
      id: filed.id,
      answer: { body: `</p><script>alert("a")</script>` },
    });

    const html = await (await page("hostile")).text();
    expect(html).toContain("&lt;script&gt;alert(&quot;q&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;quoted&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;a&quot;)&lt;/script&gt;");
    expect(html).not.toContain(`<script>alert("q")</script>`);
    expect(html).not.toContain(`<script>alert("a")</script>`);
    expect(html).not.toContain("onerror=1>");
  });
});

// ---- signed out and key-as-reader (own process) ----

describe("roles across processes", () => {
  test("annotations-roles.script.ts passes with AUTH_DISABLED unset", async () => {
    const script = join(import.meta.dir, "annotations-roles.script.ts");
    const proc = Bun.spawn(["bun", "run", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AUTH_DISABLED: undefined as unknown as string },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      console.error("subprocess stdout:", stdout);
      console.error("subprocess stderr:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("all assertions passed");
  }, 30_000);
});
