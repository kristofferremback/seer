import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { zipSync, strToU8 } from "fflate";

// Env comes from tests/setup.ts (AUTH_DISABLED=true); same harness as
// tests/projects.test.ts. Plans are a bundle kind, so most of this is the upload
// path, the reading surface, and where the pages seat a plan.
import { startServer } from "../src/server";
import { createWorkspace, legacyWorkspaceId, listMembers, mintApiKey } from "../src/db";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let ws = "";
let key = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  const owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  ws = createWorkspace("Plans", owner);
  key = mintApiKey(owner, ws, "plans").token;
});

afterAll(() => {
  server.stop(true);
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function zipOf(index: string): Uint8Array {
  return zipSync({ "index.html": strToU8(index) });
}

const LINKED =
  `<!doctype html><html><head><link rel="stylesheet" href="/plan.css">` +
  `<script src="/theme.js"></script><title>t</title></head><body><h1>t</h1></body></html>`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(r: Response): Promise<any> {
  return r.json();
}

function upload(slug: string, query: string, index: string): Promise<Response> {
  return fetch(`${base}/api/bundles/${slug}${query}`, {
    method: "PUT",
    headers: auth(),
    body: zipOf(index),
  });
}

describe("the plan kind", () => {
  test("should read a dot-prefixed index.html when judging the links", async () => {
    // Some zip producers write `./index.html`. inspectZip normalizes names, so the
    // link check must look the entry up by the same normalized view, or a correctly
    // linked plan earns two false warnings.
    const res = await fetch(`${base}/api/bundles/dotted-plan?kind=plan`, {
      method: "PUT",
      headers: auth(),
      body: zipSync({ "./index.html": strToU8(LINKED) }),
    });
    const body = await readJson(res);
    expect(body.hasIndexHtml).toBe(true);
    expect(body.warnings).toEqual([]);
  });

  test("should set kind at first upload and inherit it after", async () => {
    const first = await readJson(await upload("the-plan", "?kind=plan", LINKED));
    expect(first.kind).toBe("plan");
    expect(first.warnings).toEqual([]);

    const second = await readJson(await upload("the-plan", "", LINKED));
    expect(second.kind).toBe("plan");
    expect(second.version).toBe(2);

    const listed = await readJson(await fetch(`${base}/api/bundles`, { headers: auth() }));
    expect(listed.find((b: { slug: string }) => b.slug === "the-plan").kind).toBe("plan");
  });

  test("should refuse a later upload naming a different kind, naming the stored one", async () => {
    const res = await upload("the-plan", "?kind=bundle", LINKED);
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toContain("plan");
    // The refusal left no version behind.
    const listed = await readJson(await fetch(`${base}/api/bundles`, { headers: auth() }));
    expect(listed.find((b: { slug: string }) => b.slug === "the-plan").latestVersion).toBe(2);
  });

  test("should refuse an unknown kind value", async () => {
    const res = await upload("odd-kind", "?kind=augury", LINKED);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("kind");
  });

  test("should warn once per missing reading-surface link, and never refuse", async () => {
    const bare = await readJson(
      await upload("bare-plan", "?kind=plan", "<!doctype html><html><body>bare</body></html>"),
    );
    expect(bare.warnings).toHaveLength(2);
    expect(bare.warnings.join(" ")).toContain("/plan.css");
    expect(bare.warnings.join(" ")).toContain("/theme.js");

    const half = await readJson(
      await upload(
        "half-plan",
        "?kind=plan",
        `<!doctype html><html><head><link rel="stylesheet" href="/plan.css"></head><body>h</body></html>`,
      ),
    );
    expect(half.warnings).toHaveLength(1);
    expect(half.warnings[0]).toContain("/theme.js");
  });

  test("should not warn about the surface on a plain bundle", async () => {
    const plain = await readJson(await upload("plain-bundle", "", "<html><body>x</body></html>"));
    expect(plain.kind).toBe("bundle");
    expect(plain.warnings).toEqual([]);
  });
});

describe("the reading surface", () => {
  test("should serve /plan.css with both themes fully defined", async () => {
    const res = await fetch(`${base}/plan.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const css = await res.text();
    // The stored choice, and the scriptless system fallback: both dark paths exist.
    expect(css).toContain(`:root[data-theme="dark"]`);
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain(":root:not([data-theme])");
    expect(css).toContain("Cabinet Grotesk");
  });

  test("should serve /theme.js resolving the app's stored choice", async () => {
    const res = await fetch(`${base}/theme.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("seer:theme");
    expect(js).toContain("storage");
  });
});

describe("where a plan is seated", () => {
  test("should seat plans under their own heading in the bundles ledger", async () => {
    const page = await (await fetch(`${base}/${ws}/bundles`)).text();
    expect(page).toContain("<span>Plans</span>");
    expect(page).toContain("the-plan");
    // A workspace with no plans draws no Plans heading.
    const empty = createWorkspace("No plans", listMembers(legacyWorkspaceId()!)[0]!.id);
    const emptyPage = await (await fetch(`${base}/${empty}/bundles`)).text();
    expect(emptyPage).not.toContain("<span>Plans</span>");
  });

  test("should split plans from bundles in a project's state and pages", async () => {
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ slug: "grouping", title: "The grouping" }),
    });
    await upload("grouped-plan", "?kind=plan&project=grouping", LINKED);
    await upload("grouped-bundle", "?project=grouping", "<html><body>b</body></html>");

    const state = await readJson(await fetch(`${base}/api/projects/grouping`, { headers: auth() }));
    expect(state.plans.map((p: { slug: string }) => p.slug)).toEqual(["grouped-plan"]);
    expect(state.bundles.map((b: { slug: string }) => b.slug)).toEqual(["grouped-bundle"]);

    const html = await (await fetch(`${base}/${ws}/p/grouping`)).text();
    expect(html).toContain("Plans");
    expect(html).toContain("grouped-plan");

    const md = await (
      await fetch(`${base}/${ws}/p/grouping`, { headers: { accept: "text/markdown" } })
    ).text();
    expect(md).toContain("## Plans");
    expect(md).toContain("grouped-plan");
  });
});
