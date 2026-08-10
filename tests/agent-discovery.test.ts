// What Seer tells an agent about itself, checked against what Seer actually does.
//
// The point of every document under test is that it describes real machinery. So the
// assertions that matter here are not "the JSON parses" but "the path it advertises is a
// path this server answers", and "the standard it stays silent about is one this
// deployment could not honestly satisfy". A discovery document is only worth serving if
// drift from the route table is a test failure.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// Env is set by tests/setup.ts (preload) before these app modules import.
import { config } from "../src/config";
import {
  agentSkillsIndex,
  apiCatalog,
  authMd,
  homepageLinkHeader,
  openApiSpec,
  robotsTxt,
  sitemapXml,
} from "../src/agent-discovery";
import { skillDoc, skillRouter } from "../src/pages";
import { startServer } from "../src/server";

function sha256(text: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
}

describe("the documents an agent discovers", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let base: string;

  beforeAll(async () => {
    server = await startServer();
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  // ---- robots ----

  test("robots.txt is plain text, names its sitemap, and declares content signals", async () => {
    const res = await fetch(`${base}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    const body = await res.text();

    expect(body).toContain("User-agent: *");
    expect(body).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no");
    expect(body).toContain(`Sitemap: ${config.baseUrl}/sitemap.xml`);
    // Allow and Disallow both, or it is a file with no rules in it.
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /settings/");
  });

  test("robots.txt keeps every private surface off the map", async () => {
    const body = await (await fetch(`${base}/robots.txt`)).text();
    // These are not a security boundary — each already refuses a stranger — but a
    // crawler should not have to learn that one request at a time.
    for (const path of ["/api/", "/settings/", "/invite/", "/s/", "/r/", "/*/r/", "/github/"]) {
      expect(body).toContain(`Disallow: ${path}`);
    }
  });

  test("the training crawlers get their own group, and it refuses", async () => {
    const body = await (await fetch(`${base}/robots.txt`)).text();
    const group = body.slice(body.indexOf("User-agent: anthropic-ai"));
    for (const bot of ["GPTBot", "CCBot", "Google-Extended", "Applebot-Extended"]) {
      expect(group).toContain(`User-agent: ${bot}`);
    }
    expect(group).toContain("Content-Signal: search=no, ai-input=no, ai-train=no");
    expect(group).toContain("Disallow: /");
  });

  test("the paths robots.txt allows are paths the server answers", async () => {
    const body = robotsTxt();
    const allowed = [...body.matchAll(/^Allow: (\/\S*)$/gm)]
      .map((m) => m[1]!)
      // The bare "/" and the directory prefix are shapes, not URLs to fetch.
      .filter((p) => p !== "/" && !p.endsWith("/"));
    expect(allowed.length).toBeGreaterThan(0);
    for (const path of allowed) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  // ---- sitemap ----

  test("sitemap.xml lists only URLs that answer 200", async () => {
    const res = await fetch(`${base}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/xml");
    const body = await res.text();
    expect(body).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs).toContain(`${config.baseUrl}/`);
    expect(locs).toContain(`${config.baseUrl}/skill.md`);
    for (const loc of locs) {
      const res = await fetch(loc.replace(config.baseUrl, base));
      expect({ loc, status: res.status }).toEqual({ loc, status: 200 });
    }
  });

  test("the sitemap holds no bundle and no review", () => {
    // Deliberate: a bundle is a half-finished page put here to be looked at once, and a
    // sitemap listing every public one would turn an unlisted URL into an index.
    const body = sitemapXml();
    expect(body).not.toContain("/b/");
    expect(body).not.toContain("/r/");
  });

  // ---- Link headers ----

  test("the homepage carries a Link header pointing at each machine-readable document", async () => {
    const res = await fetch(`${base}/`);
    const link = res.headers.get("link");
    expect(link).not.toBeNull();
    expect(link).toContain(`rel="api-catalog"`);
    expect(link).toContain(`rel="service-desc"`);
    expect(link).toContain(`rel="service-doc"`);
    expect(link).toContain(`rel="describedby"`);
    expect(link).toContain(`rel="status"`);
  });

  test("every target the Link header names answers 200", async () => {
    const targets = [...homepageLinkHeader().matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of new Set(targets)) {
      const res = await fetch(`${base}${target}`);
      expect({ target, status: res.status }).toEqual({ target, status: 200 });
    }
  });

  // ---- markdown negotiation ----

  test("the homepage answers markdown to a caller that asks for markdown", async () => {
    const res = await fetch(`${base}/`, { headers: { accept: "text/markdown" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/markdown");
    // Vary, or a cache serves one representation to everyone who asks for the other.
    expect(res.headers.get("vary")).toBe("Accept");
    const body = await res.text();
    expect(body).toStartWith("# Seer");
    expect(body).toContain(`${config.baseUrl}/skill.md`);
    expect(body).not.toContain("<!doctype html>");
  });

  test("a browser still gets the page", async () => {
    const res = await fetch(`${base}/`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(await res.text()).toStartWith("<!doctype html>");
  });

  test("no Accept header at all is HTML, and so is a tie", async () => {
    // curl sends */* and means "whatever"; the URL has always meant the page.
    for (const accept of [undefined, "*/*", "text/html,text/markdown"]) {
      const res = await fetch(`${base}/`, { headers: accept ? { accept } : {} });
      expect({ accept, type: res.headers.get("content-type") }).toEqual({
        accept,
        type: "text/html;charset=utf-8",
      });
    }
  });

  test("a weighted preference for markdown wins over a weighted one for HTML", async () => {
    const res = await fetch(`${base}/`, { headers: { accept: "text/html;q=0.3, text/markdown;q=0.9" } });
    expect(res.headers.get("content-type")).toStartWith("text/markdown");
  });

  // ---- API catalog ----

  test("the API catalog is a linkset whose every href answers", async () => {
    const res = await fetch(`${base}/.well-known/api-catalog`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/linkset+json");

    const body = (await res.json()) as { linkset: Record<string, { href: string }[] | string>[] };
    expect(Array.isArray(body.linkset)).toBe(true);
    const entry = body.linkset[0]!;
    expect(typeof entry.anchor).toBe("string");
    for (const rel of ["service-desc", "service-doc", "status"]) {
      const links = entry[rel] as { href: string }[];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        const hit = await fetch(link.href.replace(config.baseUrl, base));
        expect({ href: link.href, status: hit.status }).toEqual({ href: link.href, status: 200 });
      }
    }
  });

  // ---- OpenAPI ----

  test("openapi.json is served as JSON and describes this deployment", async () => {
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const spec = (await res.json()) as {
      openapi: string;
      servers: { url: string }[];
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(spec.openapi).toStartWith("3.1");
    expect(spec.servers[0]!.url).toBe(config.baseUrl);
    // Bearer keys and browser sessions are the two credentials that exist; naming a
    // third would be describing machinery that is not here.
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(["apiKey", "session"]);
  });

  test("every path in the OpenAPI document is a route the server declares", async () => {
    const spec = openApiSpec() as { paths: Record<string, Record<string, unknown>> };
    // Drift is the only thing that can go wrong in a hand-written spec, so it is the
    // thing under test: a described path nothing answers is a lie told to an agent.
    //
    // "Nothing answers" cannot be read off the status, because several of these paths
    // answer 404 on purpose — a review a caller may not read is indistinguishable from
    // one that is not there, and that is the whole point of that route. What is read
    // instead is the catch-all's exact bytes: `fetch()` in server.ts ends with a plain
    // "Not found", and getting those back means no route matched at all.
    for (const [path, methods] of Object.entries(spec.paths)) {
      const probe = path.replace(/\{[^}]+\}/g, "probe");
      for (const method of Object.keys(methods)) {
        const res = await fetch(`${base}${probe}`, { method: method.toUpperCase() });
        const unmatched = res.status === 404 && (await res.text()) === "Not found";
        expect({ path, method, unmatched }).toEqual({ path, method, unmatched: false });
      }
    }
  });

  // ---- agent skills index ----

  test("the skills index digests match the bytes each URL actually serves", async () => {
    const res = await fetch(`${base}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      $schema: string;
      skills: { name: string; type: string; description: string; url: string; digest: string }[];
    };
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills.length).toBe(4);

    for (const skill of body.skills) {
      expect(skill.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(skill.type).toBe("skill-md");
      expect(skill.description.length).toBeGreaterThan(0);
      const served = await fetch(skill.url.replace(config.baseUrl, base));
      expect({ url: skill.url, status: served.status }).toEqual({ url: skill.url, status: 200 });
      // The digest is over what this deployment serves, not over the committed file:
      // two of the four have their host substituted on the way out.
      expect({ url: skill.url, digest: sha256(await served.text()) }).toEqual({
        url: skill.url,
        digest: skill.digest,
      });
    }
  });

  test("a skill document missing from the deployment is left out rather than listed broken", async () => {
    // The two generated documents are always there; the two on disk are conditional,
    // and the index's contract is that it never points at a 500.
    const body = (await agentSkillsIndex()) as { skills: { name: string; digest: string }[] };
    const byName = new Map(body.skills.map((s) => [s.name, s.digest]));
    expect(byName.get("seer")).toBe(sha256(skillRouter()));
    expect(byName.get("seer-bundles")).toBe(sha256(skillDoc()));
  });

  // ---- auth.md ----

  test("auth.md is markdown, headed auth.md, and says how a credential is got", async () => {
    const res = await fetch(`${base}/auth.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/markdown");
    const body = await res.text();
    expect(body).toStartWith("# auth.md");
    expect(body).toContain("Authorization: Bearer");
    expect(body).toContain(`${config.baseUrl}/settings/`);
  });

  test("auth.md says plainly that the OAuth discovery an agent just failed to find is absent", () => {
    // The likeliest reader of this page is an agent that has already probed the OAuth
    // well-knowns and found nothing. Ending that search is the page's first job.
    const body = authMd();
    expect(body).toContain("/.well-known/oauth-authorization-server");
    expect(body).toContain("no JWKS, and no dynamic client registration");
    expect(body).toContain("cannot enrol itself");
  });

  test("the OAuth, MCP and A2A well-knowns are absent rather than stubbed", async () => {
    // Seer has no authorization server, no MCP transport and no A2A service. A card
    // pointing at an endpoint that does not answer costs an agent a round trip and a
    // retry, so these stay 404 until the machinery behind them exists.
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/mcp/server-card.json",
      "/.well-known/agent-card.json",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  // ---- WebMCP ----

  // The WebMCP block is JavaScript inside a template literal inside TypeScript, which is
  // three layers of quoting and no compiler between them. So it is not string-matched
  // here; it is pulled out of the served page, parsed, and run against a stub browser.

  /** The page's WebMCP script, as a browser would receive it. */
  async function webMcpSource(): Promise<string> {
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const found = scripts.find((s) => s.includes("modelContext"));
    expect(found).toBeDefined();
    return found!;
  }

  /**
   * Run it against a stubbed navigator, and put the globals back afterwards. `while`
   * runs with the stubs still in place, because a tool's `execute` calls `fetch` on a
   * page-relative URL — which a browser resolves against the page and this process
   * cannot.
   *
   * The source is fetched before `fetch` is replaced out from under it.
   */
  async function runWebMcp(modelContext: unknown, during: () => Promise<void> = async () => {}): Promise<void> {
    const source = await webMcpSource();
    const realNavigator = Reflect.getOwnPropertyDescriptor(globalThis, "navigator");
    const realFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, "navigator", { value: { modelContext }, configurable: true });
      globalThis.fetch = (async (url: string) => new Response(`stub:${url}`)) as typeof fetch;
      new Function(source)();
      await during();
    } finally {
      globalThis.fetch = realFetch;
      if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  }

  test("the homepage registers WebMCP tools that run", async () => {
    type Tool = { name: string; description: string; inputSchema: { type: string }; execute: Function };
    const tools: Tool[] = [];
    const reached: string[] = [];

    await runWebMcp({ registerTool: (t: Tool) => tools.push(t) }, async () => {
      for (const tool of tools) {
        const out = (await tool.execute({})) as { content: { type: string; text: string }[] };
        expect(out.content[0]!.type).toBe("text");
        reached.push(out.content[0]!.text.replace("stub:", ""));
      }
    });

    expect(tools.map((t) => t.name)).toEqual(["seer_get_instructions", "seer_list_skills"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
    // A tool that fetches a URL this deployment does not answer is a tool that hands an
    // agent a 404 and calls it an answer.
    expect(reached).toEqual(["/skill.md", "/.well-known/agent-skills/index.json"]);
    for (const path of reached) {
      expect({ path, status: (await fetch(`${base}${path}`)).status }).toEqual({ path, status: 200 });
    }
  });

  test("both spellings of the draft are honoured, and a browser with neither is unharmed", async () => {
    // Which of registerTool and provideContext a browser ships is not this page's
    // business, and a browser that has shipped neither must not see an exception.
    const viaContext: { name: string }[] = [];
    await runWebMcp({ provideContext: (c: { tools: { name: string }[] }) => viaContext.push(...c.tools) });
    expect(viaContext.map((t) => t.name)).toEqual(["seer_get_instructions", "seer_list_skills"]);

    await runWebMcp(undefined);
  });
});
