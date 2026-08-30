// Reading a promoted review: the evidence revision, the accounts published over it, and
// the personal read state both share.
//
// Two things here are worth stating plainly. The first is that a revision has no
// walkthrough, because nobody has written one yet — so this module pages it along file
// seams, which are navigation and nothing else. A seam names paths and counts lines. It
// does not say what a change means, how important it is, or what category it belongs to,
// because a revision published before its witness finished has no standing to say any of
// that and a plausible guess would be indistinguishable from a witness's judgment.
//
// The second is that a pinned evidence URL stays evidence. Publishing an account adds a
// second address; it does not redirect the first or replace the code stream under it.

import { sessionEmail, sessionUser } from "../auth";
import { getWorkspace, isMember, listUserWorkspaces } from "../db";
import { SLUG_RE, STAGE_CHANGE_ID_RE, STF_ID_RE } from "../ids";
import { json, originOk } from "../http";
import { appBar, softNotFoundPage, type NavContext } from "../pages";
import {
  getStageCaptureForWorkspaces,
  type StageCaptureChangeRow,
  type StageCaptureFileRow,
  type StageCaptureInventory,
  type StageIncompleteRow,
} from "../stage/db";
import { retainedLinesResponse } from "../stage/read";
import {
  readerGroupOf,
  renderReaderPage,
  type ReaderDoc,
  type ReaderGroup,
  type ReaderMember,
  type ReaderPullRequest,
  type ReaderRoutes,
  type ReaderWorkflow,
} from "../stage/render";
import { STAGE_THEME_BOOTSTRAP } from "../stage/render-client";
import { STAGE_CSS } from "../stage/render-css";
import { escapeHtml } from "../escape";
import { agoWords } from "../relative-time";
import { actorWords } from "./github-app";
import { latestCaptureJob, type ReviewCaptureJobRow } from "./revision-jobs";
import {
  getLineagePr,
  getObservation,
  latestObservation,
  observationForRevision,
  observationStateWord,
  pullRequestUrl,
  readActorOf,
  type ReviewLineagePrRow,
  type ReviewPrObservationRow,
} from "./revision-pr";
import { MAX_EVIDENCE_PAGE_ITEMS } from "./revision-types";
import {
  getAccount,
  getLineage,
  getRevision,
  getWitnessRequestForRevision,
  latestAccountForRevision,
  listAccountVersions,
  listRevisionReadChangeIds,
  setRevisionChangeRead,
  workflowWord,
  type ReviewAccountRow,
  type ReviewLineageRow,
  type ReviewRevisionRow,
} from "./revision-db";
import { readableWorkspaces, softNotFound as softReviewJson } from "./read";
import { softNotFound as softReviewPage } from "./render";

const NUMBER_RE = /^[1-9][0-9]{0,8}$/;

// ---- deterministic file seams ----

interface SeamUnit {
  file: StageCaptureFileRow;
  changes: StageCaptureChangeRow[];
  materials: StageIncompleteRow[];
  /** A file with no change and no material of its own still has to be reachable. */
  pure: boolean;
}

function pathPrefix(paths: string[]): string {
  const parts = paths.map((path) => path.split("/").slice(0, -1));
  const first = parts[0] ?? [];
  let shared = first.length;
  for (const other of parts.slice(1)) {
    let index = 0;
    while (index < shared && index < other.length && first[index] === other[index]) index++;
    shared = index;
  }
  return first.slice(0, shared).join("/");
}

function seamTitle(files: StageCaptureFileRow[], part: number, parts: number): string {
  const suffix = parts > 1 ? ` (part ${part} of ${parts})` : "";
  if (files.length === 1) return `${files[0]!.path}${suffix}`;
  const prefix = pathPrefix(files.map((file) => file.path));
  if (prefix !== "") return `${prefix}/${suffix}`;
  return `${files.length} files${suffix}`;
}

/**
 * Page a capture along its own file boundaries, at most
 * `MAX_EVIDENCE_PAGE_CHANGES` canonical changes to a page.
 *
 * Deterministic all the way down: files come out of the inventory in path order and
 * changes in canonical order, a file's changes stay together unless the file alone is
 * larger than one page, and capture-level material lands on the first page. Every
 * change, every incomplete material and every otherwise-silent file appears exactly
 * once, so the reader's totals are the capture's totals.
 */
export function evidenceSeams(inventory: StageCaptureInventory): ReaderGroup[] {
  const changesByFile = new Map<string, StageCaptureChangeRow[]>();
  for (const change of inventory.changes) {
    const held = changesByFile.get(change.file_id);
    if (held) held.push(change);
    else changesByFile.set(change.file_id, [change]);
  }
  const claimed = new Set<string>();
  const captureMaterials: StageIncompleteRow[] = [];
  const units: SeamUnit[] = inventory.files.map((file) => {
    const changes = changesByFile.get(file.id) ?? [];
    const materials = inventory.incomplete.filter((item) => item.path !== null && item.path === file.path && !claimed.has(item.id));
    for (const material of materials) claimed.add(material.id);
    return { file, changes, materials, pure: changes.length === 0 && materials.length === 0 };
  });
  for (const material of inventory.incomplete) if (!claimed.has(material.id)) captureMaterials.push(material);

  interface Page { files: StageCaptureFileRow[]; members: ReaderMember[]; part: number; parts: number }
  const pages: Page[] = [];
  const open = (): Page => {
    const page: Page = { files: [], members: [], part: 1, parts: 1 };
    pages.push(page);
    return page;
  };
  let page = open();
  const fresh = (): void => { if (page.members.length > 0) page = open(); };
  const append = (members: ReaderMember[], file: StageCaptureFileRow | null = null): void => {
    for (const member of members) {
      if (page.members.length >= MAX_EVIDENCE_PAGE_ITEMS) page = open();
      if (file && !page.files.some((candidate) => candidate.id === file.id)) page.files.push(file);
      page.members.push(member);
    }
  };

  append(captureMaterials.map((material) => ({ type: "material" as const, id: material.id, description: null })));
  // Capture-wide limitations are not facts about the first file. Keep their own seam so
  // a 300-file metadata warning cannot be titled by whichever directory sorts first.
  fresh();
  for (const unit of units) {
    const members: ReaderMember[] = [
      ...unit.changes.map((change) => ({ type: "change" as const, id: change.id, description: null })),
      ...unit.materials.map((material) => ({ type: "material" as const, id: material.id, description: null })),
      ...(unit.pure ? [{ type: "file" as const, id: unit.file.id, description: null }] : []),
    ];
    if (members.length <= MAX_EVIDENCE_PAGE_ITEMS) {
      if (page.members.length > 0 && page.members.length + members.length > MAX_EVIDENCE_PAGE_ITEMS) page = open();
      append(members, unit.file);
      continue;
    }

    // One file has more review items than a page. Isolate it from its neighbours, then
    // split all of its changes and material in canonical order. No later file joins its
    // final part, so "part N of M" always means this file and nothing else.
    fresh();
    const chunks: ReaderMember[][] = [];
    for (let index = 0; index < members.length; index += MAX_EVIDENCE_PAGE_ITEMS) {
      chunks.push(members.slice(index, index + MAX_EVIDENCE_PAGE_ITEMS));
    }
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) page = open();
      page.part = index + 1;
      page.parts = chunks.length;
      append(chunk, unit.file);
    }
    fresh();
  }

  return pages
    .filter((entry) => entry.members.length > 0)
    .map((entry, index) => ({
      id: `seam-${index + 1}`,
      title: entry.files.length === 0 ? "Capture material" : seamTitle(entry.files, entry.part, entry.parts),
      category: null,
      importance: null,
      complexity: null,
      explanation: null,
      examples: [],
      members: entry.members,
    }));
}

// ---- routes ----

interface HistoryInput {
  workspaceId: string;
  slug: string;
  latestRevision: number;
  accounts: { version: number; revision: number }[];
  current: { kind: "revision" | "account"; number: number };
}

function history(input: HistoryInput): { label: string; href: string; current: boolean }[] {
  const revisions = Array.from({ length: input.latestRevision }, (_, index) => index + 1).map((number) => ({
    label: `rev ${number}`,
    href: `/${input.workspaceId}/r/${input.slug}/rev/${number}`,
    current: input.current.kind === "revision" && input.current.number === number,
  }));
  const accounts = input.accounts.map((account) => ({
    label: `v${account.version}`,
    href: `/${input.workspaceId}/r/${input.slug}/v/${account.version}`,
    current: input.current.kind === "account" && input.current.number === account.version,
  }));
  return [...revisions, ...accounts];
}

/** Reads belong to the member and the source revision, so the read action is
 *  revision-scoped whichever page the form was drawn on. */
function readAction(workspaceId: string, slug: string, revision: number, changeId: string): string {
  return `/${workspaceId}/r/${slug}/rev/${revision}/changes/${changeId}/read`;
}

function lineWindow(slug: string, revision: number, fileId: string, side: string, start: number, end: number): string {
  return `/api/review-lineages/${slug}/revisions/${revision}/files/${fileId}?side=${side}&start=${start}&end=${end}`;
}

function routesFor(
  workspaceId: string,
  lineage: ReviewLineageRow,
  revision: ReviewRevisionRow,
  pinned: string,
  historyInput: HistoryInput,
): ReaderRoutes {
  const group = (groupId: string, changeId?: string) => {
    const params = new URLSearchParams({ review: groupId });
    if (changeId) params.set("change", changeId);
    return `${pinned}?${params.toString()}#${changeId ?? `review-${groupId}`}`;
  };
  return {
    group,
    close: () => pinned,
    read: (changeId) => readAction(workspaceId, lineage.slug, revision.revision, changeId),
    // Said rather than derived: an evidence page's groups are computed from the capture,
    // so the read route cannot look up which one a change belongs to the way the stage
    // route reads it off a stored document.
    returnTo: (groupId, changeId) => group(groupId, changeId),
    lines: (fileId, side, start, end) => lineWindow(lineage.slug, revision.revision, fileId, side, start, end),
    history: () => history(historyInput),
  };
}

// ---- resolution ----

export interface ResolvedPromotedRead {
  workspaceId: string;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
  inventory: StageCaptureInventory;
}

/** What `/<workspace>/r/<slug>[/rev/<n>|/v/<n>]` resolves to, or null for the one
 *  soft miss. `rev` always reads evidence; `v` always reads an account; bare resolves
 *  the latest account of the latest complete revision, and its evidence otherwise. */
export function resolvePromoted(
  workspaceId: string,
  slug: string,
  pin: { kind: "revision" | "account"; raw: string } | null,
): ResolvedPromotedRead | null {
  if (!SLUG_RE.test(slug)) return null;
  const lineage = getLineage(workspaceId, slug);
  if (!lineage || lineage.latest_revision === null) return null;

  if (pin?.kind === "revision") {
    if (!NUMBER_RE.test(pin.raw)) return null;
    const revision = getRevision(workspaceId, slug, Number(pin.raw));
    if (!revision) return null;
    const inventory = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
    return inventory ? { workspaceId, lineage, revision, account: null, inventory } : null;
  }
  if (pin?.kind === "account") {
    if (!NUMBER_RE.test(pin.raw)) return null;
    const account = getAccount(workspaceId, slug, Number(pin.raw));
    if (!account) return null;
    const revision = getRevision(workspaceId, slug, account.revision);
    if (!revision) return null;
    const inventory = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
    return inventory ? { workspaceId, lineage, revision, account, inventory } : null;
  }
  const revision = getRevision(workspaceId, slug, lineage.latest_revision);
  if (!revision) return null;
  const inventory = getStageCaptureForWorkspaces(revision.capture_id, [workspaceId]);
  if (!inventory) return null;
  return { workspaceId, lineage, revision, account: latestAccountForRevision(workspaceId, revision.id), inventory };
}

export function promotedOwnsSlug(workspaceId: string, slug: string): boolean {
  return SLUG_RE.test(slug) && getLineage(workspaceId, slug) !== null;
}

function readerDoc(resolved: ResolvedPromotedRead, pinnedKind: "revision" | "account" | "latest"): ReaderDoc {
  const { lineage, revision, account } = resolved;
  const source = revision.doc.source;
  const builder = revision.doc.builder;
  const workflow: ReaderWorkflow | null = account
    ? null
    : (() => {
        const request = getWitnessRequestForRevision(resolved.workspaceId, revision.id);
        const word = workflowWord(request);
        if (word === null || word === "published") return null;
        return { word, detail: request?.failure ?? null };
      })();
  const standing = account
    ? `Version ${account.version} · revision ${revision.revision}`
    : `Revision ${revision.revision}`;
  const pin = account ? `v${account.version}` : `rev ${revision.revision}`;
  const latest = account
    ? account.version === lineage.latest_account_version
    : revision.revision === lineage.latest_revision;
  // The revision's OWN observation, read through its immutable source association. Never
  // the relation's latest: a later merge is not a fact about the code on this page, so a
  // pinned revision may go on saying "open, observed …" long after the pull request
  // merged. Task 6 owns the separate newer-observation notice.
  const observed = observationForRevision(resolved.workspaceId, revision.id);
  const currentObservation = observed ? latestObservation(resolved.workspaceId, lineage.id) : null;
  const currentRepo = currentObservation && observed && currentObservation.repo_id === observed.repo_id
    ? currentObservation.repo
    : observed?.repo;
  const pullRequest: ReaderPullRequest | null = observed
    ? {
        repo: currentRepo ?? observed.repo,
        number: observed.pr_number,
        title: observed.title,
        url: pullRequestUrl(currentRepo ?? observed.repo, observed.pr_number),
        state: observationStateWord(observed),
        observedAt: observed.observed_at,
        headSha: observed.head_sha,
      }
    : null;
  return {
    title: revision.doc.identity.title,
    source: {
      repo: source.repo,
      branch: source.branch,
      sourceHeadSha: source.sourceHeadSha,
      mergeBaseSha: source.mergeBaseSha,
    },
    pullRequest,
    builder: builder ? { agent: builder.agent, body: builder.intent, context: builder.context } : null,
    witness: account ? { agent: account.doc.witness.agent, body: account.doc.witness.summary } : null,
    groups: account ? account.doc.groups.map(readerGroupOf) : evidenceSeams(resolved.inventory),
    focus: account ? account.doc.focus : [],
    evidence: account ? account.doc.evidence.map((item) => item.kind === "bundle"
      ? {
          label: `${item.slug} v${item.version}`,
          href: `/${resolved.workspaceId}/b/${item.slug}/v/${item.version}/`,
          detail: "bundle",
        }
      : {
          label: item.caption || item.alt,
          href: `/${resolved.workspaceId}/r/${item.reviewSlug}/a/${item.id}`,
          detail: item.mediaType,
        }) : [],
    authored: account !== null,
    workflow,
    standing,
    pin,
    latest: pinnedKind === "latest" ? true : latest,
  };
}

// ---- the page ----

// ---- the shell a lineage has before its first capture completes ----

const CAPTURE_WORDS: Record<ReviewCaptureJobRow["state"], string> = {
  pending: "Capture pending",
  running: "Capturing",
  failed: "Capture failed",
  // Unreachable in practice — a completed capture is a revision, and a lineage with one
  // never renders this page — but a word that would be wrong if it ever showed is worse
  // than one that is merely surprising.
  completed: "Capture complete",
};

function shortSha(value: string): string {
  return value.slice(0, 7);
}

/**
 * A promoted review whose first source revision does not exist yet.
 *
 * Deliberately its own page rather than a `ReaderDoc` with an empty group list. A reader
 * document promises a walkthrough over a capture; there is no capture, so constructing
 * one would mean inventing an empty partition, a source rail with no history, read state
 * over nothing, and a witness request that has not been created. The shell says the four
 * true things instead — what this review is, which pull request it reviews, what source
 * it is pinned to, and where the capture has got to — using the same app bar and page
 * tokens the completed page uses, so it reads as this review's page early rather than as
 * a different kind of page.
 *
 * Nothing here needs JavaScript, there is no `/rev/` URL to link to yet, and the actor is
 * named by what kind of reader it is rather than by any credential id.
 */
function pendingCapturePage(
  nav: NavContext,
  lineage: ReviewLineageRow,
  relation: ReviewLineagePrRow | null,
  observation: ReviewPrObservationRow | null,
  currentObservation: ReviewPrObservationRow | null,
  job: ReviewCaptureJobRow | null,
  now: number = Date.now(),
): Response {
  const esc = (value: unknown): string => escapeHtml(String(value ?? ""));
  const word = job ? CAPTURE_WORDS[job.state] : "Capture pending";
  const currentRepo = currentObservation && relation && currentObservation.repo_id === relation.repo_id
    ? currentObservation.repo
    : relation?.repo;
  const prLink = relation && currentRepo
    ? `<a class="source-pr" href="${esc(pullRequestUrl(currentRepo, relation.pr_number))}" rel="noreferrer noopener" ` +
      `aria-label="${esc(`${currentRepo}#${relation.pr_number}${observation ? `: ${observation.title}` : ""}`)}">#${esc(relation.pr_number)}</a>`
    : "";
  const pinned = observation
    ? `${esc(observation.base_ref)} ${esc(shortSha(observation.base_sha))} → ${esc(observation.head_ref)} ${esc(observation.head_sha)}`
    : `${esc(lineage.original_base_ref)} → ${esc(lineage.branch)}`;
  const standing = observation
    ? `${esc(observationStateWord(observation))}, observed ${esc(agoWords(now - observation.observed_at))}`
    : "";
  const facts = [
    `<p><strong>Source</strong> ${pinned}</p>`,
    relation ? `<p><strong>Read as</strong> ${esc(actorWords(readActorOf(relation)))}</p>` : "",
    job && job.state === "failed" && job.failure ? `<p><strong>Failure</strong> ${esc(job.failure)}</p>` : "",
  ].join("");
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="robots" content="noindex,nofollow"><script>${STAGE_THEME_BOOTSTRAP}</script>` +
    `<title>${esc(lineage.title)} · Seer</title><style>${STAGE_CSS}</style></head>` +
    `<body><div data-stage-background><div class="stage-shell">${appBar(nav)}</div>` +
    `<div class="stage-grid stage-overview"><header class="stage-header">` +
    `<p class="stage-context">${esc(lineage.repo)} · ${esc(lineage.branch)}${prLink === "" ? "" : ` · ${prLink}`}</p>` +
    `<h1>${esc(lineage.title)}</h1>` +
    `<div class="stage-source"><span>${esc(word)}</span>${standing === "" ? "" : `<span class="source-observation">${standing}</span>`}</div>` +
    `</header><section class="pending-facts" aria-label="Capture">${facts}</section></div></div></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * `/<workspace>/r/<slug>`, `/rev/<n>` and `/v/<n>` for a promoted review.
 *
 * Membership only, and every refusal is the legacy review's own soft miss — the same
 * body, content type and headers — so a stranger cannot tell a promoted review that is
 * not theirs from one that does not exist, or from a legacy one.
 */
export async function handlePromotedReviewPage(
  req: Request,
  workspaceId: string,
  slug: string,
  pin: { kind: "revision" | "account"; raw: string } | null,
): Promise<Response> {
  const user = sessionUser(req);
  const workspace = getWorkspace(workspaceId);
  if (!user || !workspace || !isMember(workspaceId, user.id)) return softReviewPage();
  const nav: NavContext = {
    email: user.email,
    workspaces: listUserWorkspaces(user.id).map((item) => ({ id: item.id, name: item.name })),
    current: { id: workspace.id, name: workspace.name },
    section: "reviews",
  };
  // The latest URL of a lineage whose first capture has not completed. A pinned `/rev/`
  // or `/v/` is still a miss: those name documents, and there are none yet.
  if (pin === null && SLUG_RE.test(slug)) {
    const shell = getLineage(workspaceId, slug);
    if (shell && shell.latest_revision === null) {
      const job = latestCaptureJob(workspaceId, shell.id);
      return pendingCapturePage(
        nav,
        shell,
        getLineagePr(workspaceId, shell.id),
        job ? getObservation(workspaceId, job.observation_id) : null,
        latestObservation(workspaceId, shell.id),
        job,
      );
    }
  }
  const resolved = resolvePromoted(workspaceId, slug, pin);
  if (!resolved) return softReviewPage();

  const doc = readerDoc(resolved, pin === null ? "latest" : pin.kind);
  const { lineage, revision, account } = resolved;
  const pinnedPath = account
    ? `/${workspaceId}/r/${slug}/v/${account.version}`
    : `/${workspaceId}/r/${slug}/rev/${revision.revision}`;
  const routes = routesFor(workspaceId, lineage, revision, pinnedPath, {
    workspaceId,
    slug,
    latestRevision: lineage.latest_revision ?? revision.revision,
    accounts: listAccountVersions(workspaceId, slug),
    current: account
      ? { kind: "account", number: account.version }
      : { kind: "revision", number: revision.revision },
  });
  const readIds = listRevisionReadChangeIds(workspaceId, revision.id, user.id);
  const response = await renderReaderPage(
    req,
    nav,
    workspaceId,
    doc,
    routes,
    resolved.inventory,
    readIds,
    `review ${pinnedPath}`,
  );
  // The reader's own miss is an HTML page; on this path every miss has to be the review
  // soft miss instead, or a bad `?review=` would say whether the slug resolves.
  return response.status === 404 ? softReviewPage() : response;
}

function softHtml(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

function readJson(value: unknown, status = 200): Response {
  const response = json(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * A personal member action on one source revision. API keys cannot write somebody's
 * reading history, and the change must be one the revision's capture actually holds.
 */
export async function handleRevisionReadMutation(
  req: Request,
  workspaceId: string,
  slug: string,
  rawRevision: string,
  changeId: string,
): Promise<Response> {
  if (!originOk(req)) return new Response("Bad origin", { status: 403 });
  const user = sessionUser(req);
  if (!user || !isMember(workspaceId, user.id) || !STAGE_CHANGE_ID_RE.test(changeId)) return softHtml(req);
  const resolved = resolvePromoted(workspaceId, slug, { kind: "revision", raw: rawRevision });
  if (!resolved || !resolved.inventory.changes.some((change) => change.id === changeId)) return softHtml(req);
  const form = await req.formData().catch(() => null);
  if (form === null) return readJson({ error: "Body must be form data." }, 400);
  const rawRead = form.get("read");
  if (rawRead !== "true" && rawRead !== "false") return readJson({ error: "read must be true or false" }, 422);
  setRevisionChangeRead(workspaceId, resolved.revision.id, user.id, changeId, rawRead === "true");
  if ((req.headers.get("accept") ?? "").includes("application/json")) {
    return readJson({ changeId, read: rawRead === "true" });
  }
  // Where a no-JavaScript reader lands. Taken from the form so an account page returns
  // to itself, and constrained to this review's own paths so it can never be an open
  // redirect: the form is on Seer, but the field arrives from a request.
  const raw = form.get("return");
  const prefix = `/${workspaceId}/r/${slug}/`;
  const back = typeof raw === "string" && raw.startsWith(prefix) && !raw.startsWith(`${prefix}/`)
    && !raw.includes("://") && !raw.includes("..") && !raw.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(raw)
    ? raw
    : `/${workspaceId}/r/${slug}/rev/${resolved.revision.revision}`;
  return new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store" } });
}

/** Retained lines through a file id the exact revision's capture owns. Paths,
 *  repositories, Git object ids and storage digests are never authority. */
export async function handleRevisionLines(
  req: Request,
  slug: string,
  rawRevision: string,
  fileId: string,
): Promise<Response> {
  if (!STF_ID_RE.test(fileId)) return softReviewJson();
  for (const workspaceId of readableWorkspaces(req)) {
    const resolved = resolvePromoted(workspaceId, slug, { kind: "revision", raw: rawRevision });
    const file = resolved?.inventory.files.find((candidate) => candidate.id === fileId) ?? null;
    if (resolved && file) {
      return retainedLinesResponse(workspaceId, file, new URL(req.url), `${workspaceId}/${slug}/rev/${rawRevision}`);
    }
  }
  return softReviewJson();
}
