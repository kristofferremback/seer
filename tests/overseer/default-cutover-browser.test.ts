import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, db, legacyWorkspaceId, listMembers } from "../../src/db";
import { tinyId } from "../../src/ids";
import { startServer } from "../../src/server";
import { createReviewVersion } from "../../src/overseer/db";
import { digestOf } from "../../src/overseer/revision-db";
import { goldenStoredDoc } from "./fixtures/stored-review";
import { ChromePage } from "../chrome";

let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
let workspace = "";
let owner = "";
let slug = "";
let stackSlug = "";
let stageSlug = "";
let legacySlug = "";

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
  owner = listMembers(legacyWorkspaceId()!)[0]!.id;
  workspace = createWorkspace("Default cutover browser", owner);
  slug = "browser-immutable";
  stackSlug = "browser-stack";
  stageSlug = "browser-stage";
  legacySlug = "browser-legacy";
  seedFixture();
});

afterAll(() => server.stop(true));

function seedCapture(captureId: string, fileId: string, sourceSlug: string): void {
  db.run(
    "INSERT INTO stage_captures VALUES (?, ?, ?, 'Acme/BrowserCutover', 880, ?, 'main', ?, ?, ?, NULL, 'completed', ?)",
    [captureId, workspace, sourceSlug, `feature-${sourceSlug}`, "2".repeat(40), "1".repeat(40), "1".repeat(40), Date.now()],
  );
  db.run(
    "INSERT INTO stage_capture_files VALUES (?, ?, ?, 'src/mobile-route.txt', NULL, 'mode_changed', ?, ?, '100644', '100755', 'blob', 'blob', 0, 0, 'retained', 'retained', NULL, NULL, NULL, NULL)",
    [fileId, workspace, captureId, "a".repeat(40), "a".repeat(40)],
  );
}

function seedFixture(): void {
  const captureId = tinyId("stg"), fileId = tinyId("stf"), lineageId = tinyId("rln"), revisionId = tinyId("rvr"), requestId = tinyId("wtr");
  const now = Date.now();
  seedCapture(captureId, fileId, slug);
  db.run("INSERT INTO review_lineages VALUES (?, ?, ?, 'Acme/BrowserCutover', 880, ?, 'main', ?, 'Immutable browser review', 1, NULL, ?, ?, ?, ?)", [lineageId, workspace, slug, `feature-${slug}`, "1".repeat(40), owner, tinyId("key"), now, now]);
  const revision = {
    identity: { lineageId, slug, revision: 1, title: "Immutable browser review", createdAt: new Date(now).toISOString() },
    source: { captureId, repo: "Acme/BrowserCutover", repoId: 880, branch: `feature-${slug}`, originalBaseRef: "main", originalBaseSha: "1".repeat(40), baseRef: "main", sourceHeadSha: "2".repeat(40), baseTipSha: "1".repeat(40), mergeBaseSha: "1".repeat(40) },
    builder: null,
    projects: [],
  };
  db.run("INSERT INTO review_revisions VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)", [revisionId, workspace, lineageId, slug, captureId, JSON.stringify(revision), digestOf(revision), now]);
  db.run("INSERT INTO review_witness_requests VALUES (?, ?, ?, ?, 1, 'pending', 0, NULL, NULL, ?, ?)", [requestId, workspace, lineageId, revisionId, now, now]);

  const stackId = tinyId("rsk"), manifestId = tinyId("rsm");
  db.run("INSERT INTO review_stacks VALUES (?, ?, ?, 'Immutable browser stack', 'Acme/BrowserCutover', 880, 'main', 'inferred', NULL, NULL, 'anonymous', NULL, NULL, NULL, 1, ?, ?, ?, ?)", [stackId, workspace, stackSlug, owner, tinyId("key"), now, now]);
  const manifest = {
    identity: { stackId, slug: stackSlug, title: "Immutable browser stack", version: 1, predecessorVersion: 0, reason: "created", createdAt: new Date(now).toISOString() },
    repository: { repo: "Acme/BrowserCutover", repoId: 880, baseRef: "main" },
    source: { kind: "inferred", providerStackId: null, providerStackNumber: null, observedAt: null },
    members: [{ lineageId, lineageSlug: slug, prNumber: 41, title: "Immutable browser review", revisionId, revision: 1, accountId: null, accountVersion: null, baseRef: "main", headRef: `feature-${slug}`, headSha: "2".repeat(40), status: "live", removedReason: null }],
    projects: [],
  };
  db.run("INSERT INTO review_stack_manifests VALUES (?, ?, ?, ?, 1, 0, 'created', 1, ?, ?, ?)", [manifestId, stackId, workspace, stackSlug, JSON.stringify(manifest), digestOf(manifest), now]);
  db.run("INSERT INTO review_stack_members VALUES (?, ?, ?, ?, 880, 41, ?, NULL, NULL, NULL)", [stackId, lineageId, workspace, slug, manifestId]);

  const stageCapture = tinyId("stg"), stageFile = tinyId("stf"), stageId = tinyId("sta"), stageVersion = tinyId("stv");
  seedCapture(stageCapture, stageFile, stageSlug);
  db.run("INSERT INTO stages VALUES (?, ?, ?, 'Acme/BrowserCutover', 880, ?, 'main', ?, 1, ?, ?, ?, ?)", [stageId, workspace, stageSlug, `feature-${stageSlug}`, "1".repeat(40), owner, tinyId("key"), now, now]);
  const stageGroup = { id: "stage-browser", title: "Stage browser", category: "Code", importance: "low", complexity: "low", explanation: "The Stage V1 reader remains reachable without JavaScript.", examples: [], members: [{ type: "file", id: stageFile, description: "The retained file stays in the Stage partition." }] };
  const stageDoc = {
    identity: { id: stageId, slug: stageSlug, version: 1, title: "Stage V1 browser proof", createdAt: new Date(now).toISOString() },
    source: { captureId: stageCapture, repo: "Acme/BrowserCutover", repoId: 880, branch: `feature-${stageSlug}`, baseRef: "main", sourceHeadSha: "2".repeat(40), baseTipSha: "1".repeat(40), mergeBaseSha: "1".repeat(40) },
    builder: { intent: "Keep Stage V1", context: "", agent: { name: "Builder", model: "test" }, userId: owner, keyId: tinyId("key") },
    witness: { summary: "Stage V1 remains an explicit compatibility reader.", groups: [stageGroup], agent: { name: "Witness", model: "test" }, userId: owner, keyId: tinyId("key") },
    projects: [],
  };
  db.run("INSERT INTO stage_versions VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)", [stageVersion, workspace, stageId, stageSlug, stageCapture, JSON.stringify(stageDoc), digestOf(stageDoc), owner, stageDoc.witness.keyId, now]);

  createReviewVersion(workspace, legacySlug, { ...goldenStoredDoc(), title: "Legacy browser artifact" });
  const successionId = tinyId("lsc");
  db.run("INSERT INTO review_legacy_successions VALUES (?, ?, ?, 'single', ?, '[]', 'completed', ?, ?, 1, NULL, ?, NULL, NULL, NULL, ?, ?)", [successionId, workspace, legacySlug, slug, owner, tinyId("key"), lineageId, now, now]);
  db.run("INSERT INTO review_legacy_succession_members VALUES (?, 1, ?, 'Acme/BrowserCutover', 41, ?, ?, NULL, ?, NULL, ?)", [successionId, workspace, slug, lineageId, revisionId, now]);
}

test("should prove the default reader on desktop, phone, wide stack, and no-JavaScript", async () => {
  const evidence = process.env.SEER_TASK12_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "seer-task12-browser-"));
  mkdirSync(evidence, { recursive: true });
  const profiles = mkdtempSync(join(tmpdir(), "seer-task12-chrome-"));
  const results: Record<string, unknown> = {};

  const desktop = await ChromePage.launch({ width: 1440, height: 1000, profileRoot: profiles, name: "cutover-desktop" });
  try {
    const url = `${base}/${workspace}/r/${slug}/rev/1`;
    await desktop.navigate(url);
    await desktop.reload(url);
    results.desktop = await desktop.evaluate(`({title:document.querySelector('h1')?.textContent.trim(),path:location.pathname,focusLinks:document.querySelectorAll('[data-focus-link]').length,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})`);
    expect(results.desktop).toMatchObject({ title: "Immutable browser review", path: `/${workspace}/r/${slug}/rev/1`, overflow: 0 });
    expect((results.desktop as any).focusLinks).toBeGreaterThan(0);
    const focusHref = await desktop.evaluate<string>("document.querySelector('[data-focus-link]').href");
    await desktop.navigate(focusHref);
    await desktop.waitFor("document.querySelector('[data-focus-dialog]')?.open===true");
    await desktop.key("Escape");
    await desktop.waitFor("!new URL(location.href).searchParams.has('review')");
    await desktop.screenshot(join(evidence, "default-canonical-desktop-1440-light.png"));
  } finally { await desktop.close(); }

  const phone = await ChromePage.launch({ width: 390, height: 844, dark: true, touch: true, profileRoot: profiles, name: "cutover-phone" });
  try {
    const url = `${base}/${workspace}/r/${slug}/rev/1`;
    await phone.navigate(url);
    expect(await phone.evaluate<string[]>("[...document.querySelectorAll('.mobile-bar>*')].map(node=>node.textContent.trim())")).toEqual(["Review", "0 / 1 handled", "Details"]);
    await phone.touch("[data-page-details-open]");
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='true'");
    expect(await phone.evaluate<string>("new URL(location.href).searchParams.get('panel')")).toBe("details");
    expect(await phone.evaluate<number>("document.documentElement.scrollWidth-document.documentElement.clientWidth")).toBe(0);
    await phone.screenshot(join(evidence, "default-canonical-phone-390-dark-details.png"));
    await phone.evaluate("history.back()");
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='false'");
    await phone.touch("[data-page-details-open]");
    await phone.key("Escape");
    await phone.waitFor("document.querySelector('[data-page-details]')?.dataset.open==='false'");
    results.phone = { slots: 3, touch: true, back: true, escape: true };
  } finally { await phone.close(); }

  const wide = await ChromePage.launch({ width: 1680, height: 1000, dark: true, profileRoot: profiles, name: "cutover-wide" });
  try {
    const url = `${base}/${workspace}/r-stacks/${stackSlug}/v/1?layer=${slug}`;
    await wide.navigate(url);
    await wide.reload(url);
    results.wide = await wide.evaluate(`({title:document.querySelector('h1')?.textContent.trim(),layer:new URL(location.href).searchParams.get('layer'),theme:document.documentElement.dataset.theme,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})`);
    expect(results.wide).toMatchObject({ title: "Immutable browser stack", layer: slug, theme: "dark", overflow: 0 });
    await wide.screenshot(join(evidence, "default-stack-1680-dark-layer.png"));
  } finally { await wide.close(); }

  const noJs = await ChromePage.launch({ width: 390, height: 1000, javascript: false, profileRoot: profiles, name: "cutover-nojs" });
  try {
    await noJs.navigate(`${base}/${workspace}/r/${legacySlug}`);
    expect(await noJs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
    const successorHref = await noJs.evaluate<string>("document.querySelector('.successor a')?.getAttribute('href')");
    expect(successorHref).toBe(`/${workspace}/r/${slug}`);
    expect(await noJs.evaluate<number>("document.querySelectorAll('a').length")).toBeGreaterThan(0);
    await noJs.screenshot(join(evidence, "default-legacy-successor-phone-390-nojs.png"));
    await noJs.navigate(`${base}${successorHref}`);
    expect(await noJs.evaluate<string>("document.querySelector('h1')?.textContent.trim()")).toBe("Immutable browser review");
    expect(await noJs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
    await noJs.navigate(`${base}/${workspace}/st/${stageSlug}/v/1`);
    expect(await noJs.evaluate<string>("document.querySelector('h1')?.textContent.trim()")).toBe("Stage V1 browser proof");
    expect(await noJs.evaluate<boolean>("document.documentElement.classList.contains('js')")).toBe(false);
    await noJs.screenshot(join(evidence, "default-stage-v1-phone-390-nojs.png"));
    results.noJavaScript = { legacySuccessor: true, stageV1: true, nativeNavigation: true };
  } finally { await noJs.close(); }

  await Bun.write(join(evidence, "browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
}, 60_000);
