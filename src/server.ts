import type { ServerWebSocket, WebSocketHandler } from "bun";
import { join, resolve } from "node:path";
import { config } from "./config";
import {
  db,
  getApiKey,
  getBundle,
  getImage,
  getVersion,
  getUser,
  getWorkspace,
  isMember,
  listBundles,
  listMembers,
  listUserKeys,
  listUserWorkspaces,
  listVersions,
  createInvite,
  createWorkspace,
  mintApiKey,
  revokeApiKey,
  rollApiKey,
  setWorkspaceName,
  setWorkspaceVisibility,
  legacyWorkspaceId,
  type Workspace,
} from "./db";
import { bunRoutes } from "./api";
import { json, originOk } from "./http";
import { migrate } from "./migrate";
import { openImage, imageLocation, s3 } from "./store";
import { migrateBlobsToS3 } from "./migrate-blobs";
import {
  acceptInvite,
  loginRedirect,
  handleCallback,
  lookupValidInvite,
  requireSession,
  sessionEmail,
  sessionUser,
  type SessionUser,
} from "./auth";
import { IMG_ID_RE, INV_ID_RE, SLUG_RE, WS_ID_RE } from "./ids";
import {
  getShare,
  handleShareRequest,
  listShares,
  resolveShare,
  revokeShare,
  setShareRevokedHook,
} from "./shares";
import { serveBundleFile } from "./serve-bundle";
import {
  handleClaimInstallation,
  handleConnectGithub,
  handleDisconnectGithub,
  handleGithubSetupCallback,
  installUrl,
} from "./overseer/github-claim";
import { handleConnectGithubAccount, handleGithubAccountCallback } from "./overseer/github-user-connect";
import { handlePasteGithubToken } from "./overseer/github-user-pat";
import {
  listGithubUserCredentialsForSettings,
  revokeGithubUserCredential,
} from "./overseer/user-credentials";
import { getReview, getReviewVersion, listReviewVersions, listReviews } from "./overseer/db";
import {
  dbWorkspaceHoldings,
  deliveryIsQuiet,
  listReviewPrs,
  listWorkspaceInstallations,
  reviewStatusTally,
} from "./overseer/installations";
import { agoWords } from "./relative-time";
import { setWorkspaceHoldings } from "./overseer/github-app";
import { handleOverseerSkill, handleOverseerAgentSkill } from "./overseer/skill";
import { handleStageSkill, handleStageAgent } from "./stage/skill";
import { handleStagePage } from "./stage/render";
import { handleStageReadMutation } from "./stage/read";
import { handleAnnotation } from "./overseer/annotations";
import { reviewTopic, setFreshnessPublisher } from "./overseer/freshness";
import { handleReviewAttachment, handleReviewPage } from "./overseer/render";
import { handleReviewContext } from "./overseer/context";
import {
  handlePromotedReviewPage,
  handleRevisionReadMutation,
  promotedOwnsSlug,
} from "./overseer/revision-read";
import { recoverCaptureJobs, startCaptureSweep } from "./overseer/revision-jobs";
import {
  agentSkillsIndex,
  apiCatalog,
  authMd,
  homepageLinkHeader,
  openApiSpec,
  robotsTxt,
  sitemapXml,
} from "./agent-discovery";
import {
  landingPage,
  landingMarkdown,
  bundlesPage,
  reviewsPage,
  planCss,
  planThemeJs,
  projectsPage,
  projectPage,
  projectMarkdown,
  invitePage,
  settingsPage,
  skillDoc,
  projectsSkillDoc,
  skillRouter,
  softNotFoundPage,
  type BundleMeta,
  type LedgerGroup,
  type NavContext,
  type NavSection,
  type ProjectLedgerGroup,
  type ProjectLedgerRow,
  type ProjectPageData,
  type ReviewLedgerGroup,
  type SettingsReveal,
} from "./pages";
import { escapeHtml } from "./escape";
import { getProject, listNotesTail, listProjects, projectCounts, type ProjectRow } from "./projects/db";
import { NOTES_TAIL, projectState, projectTrail } from "./projects/api";
import { render as renderConstrainedMarkdown } from "./overseer/markdown";

// Workspace-scoped bundle path: /<ws_id>/b/<slug>[/v/N][/rest]. Anything under a
// well-formed /<ws_id>/b/ that doesn't resolve becomes a soft-404. The ws id class
// is composed from WS_ID_RE (minus its ^…$ anchors) so the two never drift apart.
const WS_BUNDLE_RE = new RegExp(`^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/b/`);
// Workspace-scoped image path: /<ws_id>/i/<img_id>/<filename>.
const WS_IMG_RE = new RegExp(`^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/i/`);
// Workspace-scoped review path: /<ws_id>/r/<slug>[/v/N | /a/<att_id>]. This is the
// URL publish hands back; the bare /r/<slug> routes resolve the same review across
// every workspace the reader can reach.
const WS_REVIEW_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)(?:/(v|a|rev)/([^/]+))?/?$`,
);
// A promoted review's read mark. Its own pattern, and revision-scoped rather than
// account-scoped: the code a member marks read belongs to the source revision, so an
// account published over that revision reads with the same handling state.
const WS_REVISION_READ_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)/rev/([^/]+)/changes/([^/]+)/read/?$`,
);
const WS_STAGE_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/st/([^/]+)(?:/v/([^/]+))?/?$`,
);
const WS_STAGE_READ_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/st/([^/]+)/v/([^/]+)/changes/([^/]+)/read/?$`,
);
// The same review's surrounding code: /<ws_id>/r/<slug>/c, everything else in the
// query. Its own pattern rather than a third branch of the one above, because the tail
// carries no path segment of its own and folding it in would make `v` and `a` optional
// too, which would let `/r/<slug>/v` through as a version of nothing.
const WS_REVIEW_CONTEXT_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)/c/?$`,
);

// The write a review page makes, under the workspace that page is served from: the
// slug alone is ambiguous across workspaces, so the form posts the workspace with it.
const WS_ANNOTATIONS_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/r/([^/]+)/annotations/?$`,
);

// The workspace's own pages: /<ws_id> (its front door), /<ws_id>/bundles,
// /<ws_id>/reviews, /<ws_id>/projects, /<ws_id>/settings. Members only; anyone else
// meets the same soft-404 an unknown workspace gives.
const WS_PAGE_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})(?:/(bundles|reviews|projects|settings))?/?$`,
);

// One project's page: /<ws_id>/p/<slug>. Members only, the same posture as the
// workspace pages: a stranger cannot tell a project that is not theirs from one that
// does not exist.
const WS_PROJECT_RE = new RegExp(
  `^/(${WS_ID_RE.source.replace(/^\^|\$$/g, "")})/p/([^/]+)/?$`,
);

// A live socket is either a bundle's reload channel or a review's freshness channel.
// The two are gated differently, so which one this is travels with the socket rather
// than being re-derived at subscribe time. `shareId` is set when the socket was
// authorised by a share token rather than by membership: a socket is gated once, at
// upgrade, so revocation has to be able to find this one again and shut it.
type WSData = { ws: string; slug: string; kind: "bundle" | "review"; shareId?: string };

function markdown(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}

function text(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=3600" },
  });
}

/**
 * Proactive content negotiation (RFC 9110 §12.5.1), cut down to the one question this
 * server asks a request: would you rather have markdown than HTML?
 *
 * The comparison is what makes it safe to turn on for a page a browser also loads.
 * `Accept: text/markdown` scores markdown 1 and HTML 0 and gets markdown; a browser
 * leads with `text/html` at 1 and reaches markdown only through its trailing wildcard
 * at 0.8, so it gets the page. A tie goes to HTML, because HTML is what the URL has
 * always meant, and a caller that named neither gets the page too.
 *
 * `q=0` is a refusal rather than a low score (RFC 9110 §12.4.2), so it is checked
 * separately from the comparison. Comparing alone was not enough: an absent type scores
 * -1, so `text/markdown;q=0` — a caller saying markdown is the one thing it cannot read
 * — beat an unmentioned HTML and was served markdown.
 */
function prefersMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  const best = (type: string): number => {
    // A more specific range overrides a broader one rather than competing with it
    // (RFC 9110 §12.5.1), so the three specificities are collected apart: `*/*;q=0.1`
    // beside `text/markdown;q=0` does not lift the refusal, it is overridden by it.
    const ranges = [type, `${type.split("/")[0]}/*`, "*/*"];
    const q: (number | undefined)[] = [undefined, undefined, undefined];
    for (const part of accept.split(",")) {
      const [raw, ...params] = part.split(";");
      const rank = ranges.indexOf(raw!.trim().toLowerCase());
      if (rank < 0) continue;
      const weight = params
        .map((p) => p.trim().toLowerCase())
        .find((p) => p.startsWith("q="));
      const value = weight === undefined ? 1 : Number(weight.slice(2));
      // A malformed q is not a preference; treat it as absent rather than as zero.
      const parsed = Number.isFinite(value) ? value : 1;
      q[rank] = q[rank] === undefined ? parsed : Math.max(q[rank]!, parsed);
    }
    // Absent at every specificity scores below zero, which is how "not asked for" stays
    // distinguishable from "asked for and refused".
    return q[0] ?? q[1] ?? q[2] ?? -1;
  };
  const markdown = best("text/markdown");
  return markdown > 0 && markdown > best("text/html");
}

function favicon(name: string, contentType: string): Response {
  const file = Bun.file(join(import.meta.dir, "..", "assets", name));
  return new Response(file, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=604800" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

// See other: turn a mutation POST into a plain GET of the redirect target.
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// A mutation must come from a signed-in member of the target workspace. No session
// → 403; unknown ws or non-member → 404 (a non-member learns nothing about the ws).
function requireMember(req: Request, wsId: string): SessionUser | Response {
  const user = sessionUser(req);
  if (!user) return new Response("Sign in required", { status: 403 });
  if (!WS_ID_RE.test(wsId) || !isMember(wsId, user.id)) {
    return new Response("Not found", { status: 404 });
  }
  return user;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// The app bar's data: who this is, every workspace they can switch to, and where
// they are standing. One builder so every signed-in page draws the same chrome.
function navFor(
  user: SessionUser,
  section: NavSection,
  current: { id: string; name: string } | null,
): NavContext {
  return {
    email: user.email,
    workspaces: listUserWorkspaces(user.id).map((w) => ({ id: w.id, name: w.name })),
    current,
    section,
  };
}

// Render the settings page for a member, optionally with a one-time reveal box.
function settingsResponse(wsId: string, user: SessionUser, reveal?: SettingsReveal): Response {
  const ws = getWorkspace(wsId)!;
  return html(
    settingsPage({
      nav: navFor(user, "settings", { id: ws.id, name: ws.name }),
      wsId,
      name: ws.name,
      visibility: ws.visibility,
      email: user.email,
      members: listMembers(wsId).map((m) => ({
        email: m.email,
        id: m.id,
        joined: fmtDate(m.created_at),
        isYou: m.id === user.id,
      })),
      keys: listUserKeys(user.id, wsId).map((k) => ({
        id: k.id,
        name: k.name,
        hint: k.token_hint,
        created: fmtDate(k.created_at),
        lastUsed: k.last_used_at ? fmtDateTime(k.last_used_at) : "never",
        isLegacy: !!k.is_legacy,
      })),
      // The workspace's shares, not the viewer's: a share is the workspace's to see and
      // to revoke, or a link nobody can see is a link nobody takes back. No token is in
      // this list, because none survived the mint.
      // What this workspace may derive through. Unclaimed and disconnected installations
      // are not in here: listWorkspaceInstallations answers the same question routing
      // asks, so the panel cannot claim a reach the client would refuse.
      credentials: listGithubUserCredentialsForSettings(user.id).map((credential) => ({
        id: credential.id,
        label: credential.label,
        account: credential.account_login,
        kind: credential.kind,
        lastUsed: credential.last_used_at ? agoWords(Date.now() - credential.last_used_at) : "never",
        isDead: credential.dead_at !== null,
        isExpired: credential.expires_at !== null && credential.expires_at <= Date.now(),
      })),
      installations: listWorkspaceInstallations(wsId).map((g) => ({
        id: g.id,
        installationId: g.installation_id,
        account: g.account_login,
        accountType: g.account_type,
        repositorySelection: g.repository_selection,
        connected: g.connected_at ? fmtDate(g.connected_at) : "—",
        isSuspended: g.suspended_at !== null,
        // Said in ages rather than dates, because the question a reader has here is
        // "has this stopped?" and a date makes them do the subtraction themselves.
        lastDelivery: g.last_delivery_at ? agoWords(Date.now() - g.last_delivery_at) : "never",
        isQuiet: deliveryIsQuiet(g.last_delivery_at),
      })),
      githubInstallUrl: installUrl(),
      githubUserOAuthEnabled: config.githubUserOAuth !== null,
      shares: listShares(wsId).map((sh) => ({
        id: sh.id,
        label: sh.label,
        kind: sh.kind,
        target: sh.target,
        created: fmtDate(sh.created_at),
        expires: sh.expires_at === null ? "never" : fmtDate(sh.expires_at),
        isExpired: sh.expires_at !== null && sh.expires_at <= Date.now(),
      })),
      reveal,
    }),
  );
}

// ---- access ----

// A workspace is viewable by anyone when public; a private workspace only by its
// members. The same rule gates page serving and the live-reload socket.
function workspaceViewable(ws: Workspace, req: Request): boolean {
  if (ws.visibility === "public") return true;
  const user = sessionUser(req);
  return user ? isMember(ws.id, user.id) : false;
}

// Membership, whatever the workspace's visibility says. A review holds private source
// and is never served by visibility alone, so its live channel is not either.
function workspaceMember(ws: Workspace, req: Request): boolean {
  const user = sessionUser(req);
  return user ? isMember(ws.id, user.id) : false;
}

function softNotFound(req: Request): Response {
  const url = new URL(req.url);
  return new Response(softNotFoundPage(sessionEmail(req), url.pathname + url.search), {
    status: 404,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
  });
}

// ---- bundle serving ----
//
// The file-by-file part lives in ./serve-bundle, because the share route serves the
// same trees. What is left here is the workspace path's own reading of the URL.

// Workspace-scoped serving: /<ws_id>/b/<slug>[/v/N][/rest]. Public workspaces serve
// anyone; private ones only members. Every denial, unknown workspace, unknown bundle,
// or out-of-range version resolves to the same soft-404 — forbidden and missing are
// indistinguishable, so a private workspace leaks nothing to a non-member.
async function handleWorkspaceBundle(req: Request, wsId: string): Promise<Response> {
  const url = new URL(req.url);
  const tail = url.pathname.slice(`/${wsId}/b/`.length);
  const match = tail.match(/^([^/]+)(?:\/v\/(\d+))?(\/.*)?$/);

  const ws = getWorkspace(wsId);
  if (!ws || !workspaceViewable(ws, req) || !match) return softNotFound(req);
  const [, slug, versionStr, rest] = match;
  if (!SLUG_RE.test(slug!)) return softNotFound(req);

  const bundle = getBundle(wsId, slug!);
  if (!bundle) return softNotFound(req);

  const pinned = versionStr !== undefined;
  const version = pinned ? Number(versionStr) : bundle.latest_version;
  if (pinned && (version < 1 || version > bundle.latest_version)) return softNotFound(req);

  // Require a trailing slash on the bundle root so relative asset URLs resolve.
  if (rest === undefined) {
    return new Response(null, { status: 302, headers: { location: `${url.pathname}/${url.search}` } });
  }

  const meta: BundleMeta = {
    slug: slug!,
    version,
    updatedAt: getVersion(wsId, slug!, version)?.created_at ?? bundle.created_at,
    url: `${config.baseUrl}${url.pathname}`,
  };
  return serveBundleFile(wsId, meta, rest.slice(1), {
    live: pinned ? null : { via: "workspace", wsId, slug: slug! },
    shared: false,
    // The way back into Seer, for members only: an anonymous reader of a public
    // bundle, and every share holder, gets the page untouched.
    overlay: workspaceMember(ws, req)
      ? { wsId, slug: slug!, version, latestVersion: bundle.latest_version, pinned }
      : undefined,
  });
}

// ---- images ----

// GitHub fetches every image embedded in a PR, issue, or README through its camo
// asset proxy, which sends no credentials — only this User-Agent. The UA is
// spoofable, so treat this as an availability carve-out, not an auth boundary:
// the unguessable img id in the path is what actually protects a private image.
function isGithubCamo(req: Request): boolean {
  return (req.headers.get("user-agent") ?? "").toLowerCase().includes("github-camo");
}

// Workspace-scoped image serving: /<ws_id>/i/<img_id>/<filename>. Same soft-404
// posture as bundles — denial, unknown id, and filename mismatch are all
// indistinguishable — with one deliberate exception: GitHub's camo proxy is always
// served, so an image pasted into a PR renders even from a private workspace.
async function handleWorkspaceImage(req: Request, wsId: string): Promise<Response> {
  const url = new URL(req.url);
  const [id, filename, ...extra] = url.pathname.slice(`/${wsId}/i/`.length).split("/");

  const ws = getWorkspace(wsId);
  if (!ws || !id || !filename || extra.length > 0 || !IMG_ID_RE.test(id)) {
    return softNotFound(req);
  }
  const image = getImage(id);
  if (!image || image.workspace_id !== wsId || image.filename !== filename) {
    return softNotFound(req);
  }
  if (!workspaceViewable(ws, req) && !isGithubCamo(req)) return softNotFound(req);

  const body = await openImage(wsId, image.id);
  if (body === null) {
    // A db row without its blob is corruption (or a mispointed store) — say so.
    console.error(`[seer] image ${image.id} has a db row but no blob at ${imageLocation(wsId, image.id)}`);
    return softNotFound(req);
  }

  const headers: Record<string, string> = {
    "content-type": image.content_type,
    "content-length": String(image.bytes),
    // An img id is minted once and never rewritten, so the URL is immutable.
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  // SVG can carry script; as an <img> it never runs, but this URL opened as a
  // top-level document would execute it on this origin. Neuter that.
  if (image.content_type === "image/svg+xml") {
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return new Response(body, { headers });
}

// ---- bundle ledger (signed-in view data) ----

// The ledger, grouped by the session user's workspaces. Each group carries that
// workspace's own bundles; the page scopes every URL to the group's ws id.
function ledgerGroups(userId: string): LedgerGroup[] {
  return listUserWorkspaces(userId).map((ws) => ({
    wsId: ws.id,
    name: ws.name,
    visibility: ws.visibility,
    // Newest first, and the raw instant rather than a rendered one: the page sorts by
    // it, sections by it, and decides how it should read.
    bundles: listBundles(ws.id)
      .map((b) => {
        const versions = listVersions(ws.id, b.slug);
        return {
          slug: b.slug,
          kind: b.kind,
          latestVersion: b.latest_version,
          updatedAt: versions[0]?.created_at ?? b.created_at,
          versions: versions.map((v) => v.version),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

// The reviews index, grouped the same way. Every field comes out of SQLite: the title
// off the latest stored version, the tally off `review_prs` joined to the observations
// already written. Nothing here can reach GitHub, because after the on-view check was
// deleted no code path from a render to an observation exists at all.
function reviewLedgerGroups(userId: string): ReviewLedgerGroup[] {
  return listUserWorkspaces(userId).map((ws) => ({
    wsId: ws.id,
    name: ws.name,
    visibility: ws.visibility,
    reviews: listReviews(ws.id)
      .map((r) => {
        const versions = listReviewVersions(ws.id, r.slug);
        const latest = getReviewVersion(ws.id, r.slug, r.latest_version);
        return {
          slug: r.slug,
          // A review with no version row behind its head pointer cannot happen —
          // createReviewVersion moves both in one transaction — but the index is not
          // the place to throw over it, so the slug stands in for the title.
          title: latest?.doc.title ?? r.slug,
          latestVersion: r.latest_version,
          publishedAt: versions[0]?.created_at ?? r.created_at,
          prs: listReviewPrs(ws.id, r.slug).map((p) => ({ repo: p.repo, number: p.pr_number })),
          tally: reviewStatusTally(ws.id, r.slug),
        };
      })
      .sort((a, b) => b.publishedAt - a.publishedAt),
  }));
}

// The projects ledger, grouped the same way: top-level projects carrying their
// children, both in the builder so the page stays presentational. `listProjects`
// answers most recently touched first, and that order survives the split.
function projectLedgerGroups(userId: string): ProjectLedgerGroup[] {
  return listUserWorkspaces(userId).map((ws) => {
    const rows = listProjects(ws.id);
    const byParent = new Map<string, ProjectRow[]>();
    for (const p of rows) {
      if (p.parent_id === null) continue;
      const held = byParent.get(p.parent_id);
      if (held) held.push(p);
      else byParent.set(p.parent_id, [p]);
    }
    const toRow = (p: ProjectRow, children: ProjectLedgerRow[]): ProjectLedgerRow => {
      const counts = projectCounts(p.id);
      return {
        slug: p.slug,
        title: p.title,
        status: p.status,
        updatedAt: p.updated_at,
        bundles: counts.bundles,
        // Both kinds, added: the ledger cell says how many reviews this project holds,
        // and to a reader a promoted one is a review.
        reviews: counts.reviews + counts.reviewLineages,
        tasks: counts.tasks,
        children,
      };
    };
    return {
      wsId: ws.id,
      name: ws.name,
      visibility: ws.visibility,
      projects: rows
        .filter((p) => p.parent_id === null)
        .map((p) => toRow(p, (byParent.get(p.id) ?? []).map((c) => toRow(c, [])))),
    };
  });
}

/**
 * GET /<ws_id>/p/<slug>: one project's page, and — under `Accept: text/markdown` —
 * the same state as markdown, so the human entry point and the agent context are one
 * address. Members only, soft-404 posture throughout.
 */
function handleProjectPage(req: Request, wsId: string, slug: string): Response {
  const user = sessionUser(req);
  if (!user) return requireSession(req)!;
  const ws = getWorkspace(wsId);
  if (!ws || !isMember(wsId, user.id)) return softNotFound(req);
  if (!SLUG_RE.test(slug)) return softNotFound(req);
  const project = getProject(wsId, slug);
  if (!project) return softNotFound(req);

  const state = projectState(project);

  // The stored description passed the write-side validator, so a rejection here is
  // corruption of some kind: log it and show the text escaped rather than a 500.
  let descriptionHtml = "";
  if (project.description.trim() !== "") {
    try {
      descriptionHtml = renderConstrainedMarkdown(project.description);
    } catch (err) {
      console.error(`[seer] project ${wsId}/${slug}: stored description failed to render:`, err);
      descriptionHtml = `<p>${escapeHtml(project.description)}</p>`;
    }
  }

  const data: ProjectPageData = {
    nav: navFor(user, "projects", { id: ws.id, name: ws.name }),
    wsId,
    slug: project.slug,
    title: project.title,
    status: project.status,
    updatedAt: project.updated_at,
    parent: state.parent ? { slug: state.parent.slug, title: state.parent.title } : null,
    description: project.description,
    descriptionHtml,
    children: state.children,
    // Task bodies render through the same constrained renderer as the description,
    // with the same corruption fallback: escaped text over a 500, and a log line.
    tasks: state.tasks.map((t) => {
      let bodyHtml = "";
      if (t.body.trim() !== "") {
        try {
          bodyHtml = renderConstrainedMarkdown(t.body);
        } catch (err) {
          console.error(`[seer] task ${t.id}: stored body failed to render:`, err);
          bodyHtml = `<p>${escapeHtml(t.body)}</p>`;
        }
      }
      return { ...t, bodyHtml };
    }),
    plans: state.plans,
    bundles: state.bundles,
    reviews: state.reviews,
    reviewLineages: state.reviewLineages,
    stages: state.stages,
    // The record's tail: notes and derived status events, oldest first. Note bodies
    // render through the same constrained renderer, same corruption fallback.
    trail: projectTrail(project, listNotesTail(project.id, NOTES_TAIL)).map((e) => {
      if (e.kind === "event") return e;
      let bodyHtml = "";
      try {
        bodyHtml = renderConstrainedMarkdown(e.body);
      } catch (err) {
        console.error(`[seer] note ${e.id}: stored body failed to render:`, err);
        bodyHtml = `<p>${escapeHtml(e.body)}</p>`;
      }
      return { ...e, bodyHtml };
    }),
    noteCount: state.noteCount,
    // Self-attribution is noise in a workspace of one; names earn their place when
    // there is a second member to tell apart.
    showAuthors: listMembers(wsId).length > 1,
  };

  // Vary names Accept on both representations: without it a cache that saw one would
  // serve it to a caller that asked for the other.
  if (prefersMarkdown(req)) {
    return new Response(projectMarkdown(data), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        vary: "Accept",
        "cache-control": "no-cache",
      },
    });
  }
  return new Response(projectPage(data), {
    headers: { "content-type": "text/html;charset=utf-8", vary: "Accept", "cache-control": "no-cache" },
  });
}

// ---- workspace pages ----

/**
 * GET /<ws_id>[/bundles|/reviews|/projects|/settings]: one workspace's own view of the same
 * ledgers. The bare id is a front door and goes to bundles; settings already has a
 * canonical URL and keeps it. Members only, with the usual posture: an unknown
 * workspace and someone else's workspace are the same soft-404, and a signed-out
 * reader is asked to sign in first (the link they were sent may resolve after).
 */
function handleWorkspacePage(req: Request, wsId: string, section: string | undefined): Response {
  const user = sessionUser(req);
  if (!user) return requireSession(req)!;
  const ws = getWorkspace(wsId);
  if (!ws || !isMember(wsId, user.id)) return softNotFound(req);
  if (section === undefined) return redirect(`/${wsId}/bundles`);
  if (section === "settings") return redirect(`/settings/${wsId}`);

  const nav = navFor(user, section as NavSection, { id: ws.id, name: ws.name });
  if (section === "bundles") {
    return html(bundlesPage(nav, ledgerGroups(user.id).filter((g) => g.wsId === wsId)));
  }
  if (section === "projects") {
    return html(projectsPage(nav, projectLedgerGroups(user.id).filter((g) => g.wsId === wsId)));
  }
  return html(reviewsPage(nav, reviewLedgerGroups(user.id).filter((g) => g.wsId === wsId)));
}

// ---- server ----

export async function startServer() {
  // Bring the database to the current schema (v2; bootstrapping the root workspace
  // on first boot) before the server binds — no request may hit an unmigrated db.
  migrate();
  // Then move any local blobs into S3 (no-op when already done or disk-only).
  // Runs before the server binds so requests never race a half-moved store.
  await migrateBlobsToS3();

  // The database-backed answer to "which installations may this workspace act through",
  // installed once the schema is known to be current. Without it githubClientFor() has
  // no holdings source and refuses to build a client at all, which is the loud failure
  // the alternative — a client that routes against nothing — would not be.
  setWorkspaceHoldings(dbWorkspaceHoldings());

  // Only now, and not a line earlier: a capture job reopens an exact stored actor, so
  // recovering one before the holdings source exists would ask an installation-backed job
  // to route through nothing. A lease that expired while this process was down is
  // released and re-queued; a healthy lease is left alone, because another container may
  // be halfway through it.
  recoverCaptureJobs();
  // And again, on a timer. A lane this process left because another container held the
  // lease has nothing else that would look at it: without the sweep, "another process may
  // recover an abandoned claim" would only be true at boot.
  startCaptureSweep();

  // Only the sockets a share opened, so revocation can find them. Membership-gated
  // sockets are not in here: nothing revokes a membership mid-connection today, and a
  // registry of every open socket would be a leak waiting to happen.
  const shareSockets = new Set<ServerWebSocket<WSData>>();

  const websocket: WebSocketHandler<WSData> = {
    open(ws) {
      ws.subscribe(
        ws.data.kind === "review"
          ? reviewTopic(ws.data.ws, ws.data.slug)
          : `bundle:${ws.data.ws}:${ws.data.slug}`,
      );
      if (ws.data.shareId) shareSockets.add(ws);
    },
    close(ws) {
      shareSockets.delete(ws);
    },
    message() {},
  };

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 120,
    maxRequestBodySize: config.maxUploadBytes + 1024,

    routes: {
      "/healthz": () => new Response("ok"),

      // The credential-bearing API, spread from the one list it and /openapi.json are
      // both built from. See src/api.ts: a route added there is answered here and
      // described there in the same breath, which is the only way the two can be made to
      // agree without a test standing between them.
      ...bunRoutes(),

      "/login": (req) => {
        const next = new URL(req.url).searchParams.get("next") ?? "/bundles";
        return loginRedirect(next);
      },
      "/auth/callback": (req) => handleCallback(req),

      // Public pamphlet. No auth; shows a quiet link onward when signed in.
      //
      // The front door is also where a thing that is not a person arrives, so this
      // response carries the Link header that says where everything machine-readable
      // lives, and answers in markdown to a caller that asked for markdown.
      //
      // Vary names both things this URL turns on, and both are load-bearing. Accept,
      // because without it a cache that saw one representation would serve it to
      // everyone who asked for the other. Cookie, because the page's action link reads
      // the session, and a shared cache told to key on Accept alone would hand a
      // signed-in reader's page to a stranger.
      "/": (req) => {
        const headers: Record<string, string> = {
          link: homepageLinkHeader(),
          vary: "Accept, Cookie",
        };
        if (prefersMarkdown(req)) {
          return new Response(landingMarkdown(), {
            headers: { ...headers, "content-type": "text/markdown; charset=utf-8" },
          });
        }
        // A signed-in browser is sent into the app rather than shown the pamphlet:
        // the front door is for strangers and for machines, and both are handled
        // above or below. 302 rather than 301 — the same URL is the pamphlet again
        // the moment the session ends — and Vary already names Cookie for any cache.
        if (sessionUser(req)) {
          return new Response(null, {
            status: 302,
            headers: { ...headers, location: "/bundles", "cache-control": "no-store" },
          });
        }
        return new Response(landingPage(false), {
          headers: { ...headers, "content-type": "text/html;charset=utf-8" },
        });
      },

      // ---- what this deployment says about itself to something that is not a person ----
      //
      // The documents live in ./agent-discovery, which explains why the OAuth, MCP and
      // A2A well-knowns the same standards suite asks for are deliberately absent.

      "/robots.txt": () => text(robotsTxt(), "text/plain;charset=utf-8"),
      "/sitemap.xml": () => text(sitemapXml(), "application/xml;charset=utf-8"),
      "/auth.md": () => markdown(authMd()),
      "/openapi.json": () => json(openApiSpec()),
      "/.well-known/api-catalog": () => json(apiCatalog(), 200, "application/linkset+json"),
      "/.well-known/agent-skills/index.json": async () => json(await agentSkillsIndex()),

      // Agent-facing usage doc. Public, no auth — agents (and llms.txt probers)
      // fetch this to learn how to publish. Both paths serve identical markdown.
      // The front door: what this deployment can do, and where each capability's own
      // instructions are. Bundle publishing kept its document, one hop further in.
      "/skill.md": () => markdown(skillRouter()),
      "/llms.txt": () => markdown(skillRouter()),
      "/bundles/skill.md": () => markdown(skillDoc()),
      "/projects/skill.md": () => markdown(projectsSkillDoc()),
      "/stage/skill.md": () => handleStageSkill(),
      "/stage/agent.md": () => handleStageAgent(),

      // The signed-in ledger of held bundles, grouped by the user's workspaces.
      "/bundles": (req) => {
        const user = sessionUser(req);
        if (!user) return requireSession(req)!;
        return html(bundlesPage(navFor(user, "bundles", null), ledgerGroups(user.id)));
      },

      // The signed-in index of published reviews, beside the bundle ledger.
      "/reviews": (req) => {
        const user = sessionUser(req);
        if (!user) return requireSession(req)!;
        return html(reviewsPage(navFor(user, "reviews", null), reviewLedgerGroups(user.id)));
      },

      // The signed-in projects ledger, third of the three.
      "/projects": (req) => {
        const user = sessionUser(req);
        if (!user) return requireSession(req)!;
        return html(projectsPage(navFor(user, "projects", null), projectLedgerGroups(user.id)));
      },

      // The plan reading surface: tokens, type and theme for a bundle of kind plan.
      // Fetched live rather than vendored — a redesign restyles every published
      // plan — with a five-minute cache bounding how long that takes to land.
      "/plan.css": () =>
        new Response(planCss(), {
          headers: {
            "content-type": "text/css;charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        }),
      "/theme.js": () =>
        new Response(planThemeJs(), {
          headers: {
            "content-type": "text/javascript;charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        }),

      // Self-hosted type. A closed whitelist — only these five faces are ever
      // served, so a slug like "../secret" can never traverse out of assets/fonts.
      "/fonts/:file": (req) => {
        const allowed = new Set([
          "switzer.woff2",
          "cabinet-grotesk.woff2",
          "commit-mono-400.woff2",
          "commit-mono-500.woff2",
          "commit-mono-700.woff2",
        ]);
        const name = req.params.file;
        if (!allowed.has(name)) return new Response("Not found", { status: 404 });
        const file = Bun.file(join(import.meta.dir, "..", "assets", "fonts", name));
        return new Response(file, {
          headers: {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },

      // Committed OG card asset. Long cache; it only changes when the art does.
      "/og.png": () => {
        const file = Bun.file(join(import.meta.dir, "..", "assets", "og.png"));
        return new Response(file, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=604800, immutable",
          },
        });
      },

      // The scrying-glass mark as the site icon. SVG for modern browsers,
      // PNG fallbacks for older ones and iOS home-screen.
      "/favicon.svg": () => favicon("favicon.svg", "image/svg+xml"),
      "/favicon.ico": () => favicon("favicon.png", "image/png"),
      "/favicon.png": () => favicon("favicon.png", "image/png"),
      "/apple-touch-icon.png": () => favicon("apple-touch-icon.png", "image/png"),


      // The witness skill doc. Public, no auth, same contract as /skill.md: an agent
      // reads this before it publishes a review.
      "/overseer/skill.md": () => handleOverseerSkill(),

      // What a person installs into their own agent so it can dispatch a witness.
      // The witness never reads this one; whoever sets Overseer up reads it once.
      "/overseer/agent.md": () => handleOverseerAgentSkill(),

      // The review itself, as a page. Same gate as the JSON, same soft-404.
      "/r/:slug": {
        GET: (req) => handleReviewPage(req, req.params.slug, null),
      },
      "/r/:slug/v/:n": {
        GET: (req) => handleReviewPage(req, req.params.slug, req.params.n),
      },
      "/r/:slug/a/:id": {
        GET: (req) => handleReviewAttachment(req, req.params.slug, req.params.id),
      },
      // The code around a hunk, for the full-screen panel. Same gate again, and the
      // file it will serve is named by the review's own hunks rather than by the URL.
      "/r/:slug/c": {
        GET: (req) => handleReviewContext(req, req.params.slug),
      },

      // ---- workspace + settings mutations (session + membership; Origin guard) ----

      "/workspaces": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const user = sessionUser(req);
          if (!user) return new Response("Sign in required", { status: 403 });
          const name = String((await req.formData()).get("name") ?? "").trim();
          if (!name || name.length > 80) return new Response("Invalid workspace name", { status: 400 });
          const id = createWorkspace(name, user.id);
          return redirect(`/settings/${id}`);
        },
      },

      "/settings/:ws": {
        GET: (req) => {
          const wsId = req.params.ws;
          const user = sessionUser(req);
          if (!user) return requireSession(req)!;
          if (!WS_ID_RE.test(wsId) || !isMember(wsId, user.id)) return softNotFound(req);
          return settingsResponse(wsId, user);
        },
      },

      "/settings/:ws/name": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const name = String((await req.formData()).get("name") ?? "").trim();
          if (!name || name.length > 80) return new Response("Invalid name", { status: 400 });
          setWorkspaceName(req.params.ws, name);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      "/settings/:ws/visibility": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const v = String((await req.formData()).get("visibility") ?? "");
          if (v !== "public" && v !== "private") return new Response("Invalid visibility", { status: 400 });
          setWorkspaceVisibility(req.params.ws, v);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      "/settings/:ws/invites": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const { token, expiresAt } = createInvite(req.params.ws, gate.id);
          return settingsResponse(req.params.ws, gate, {
            kind: "invite",
            url: `${config.baseUrl}/invite/${token}`,
            expires: fmtDate(expiresAt),
          });
        },
      },

      "/settings/:ws/keys": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const name = String((await req.formData()).get("name") ?? "").trim() || "unnamed key";
          if (name.length > 80) return new Response("Invalid key name", { status: 400 });
          const { token } = mintApiKey(gate.id, req.params.ws, name);
          return settingsResponse(req.params.ws, gate, { kind: "key", token });
        },
      },

      "/settings/:ws/keys/:keyId/roll": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          // Ownership is enforced inside rollApiKey (key must be the caller's in this ws).
          const rolled = rollApiKey(req.params.keyId, gate.id, req.params.ws);
          if (!rolled) return new Response("Not found", { status: 404 });
          return settingsResponse(req.params.ws, gate, { kind: "key", token: rolled.token });
        },
      },

      "/settings/:ws/keys/:keyId/revoke": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const key = getApiKey(req.params.keyId);
          if (!key || key.user_id !== gate.id || key.workspace_id !== req.params.ws) {
            return new Response("Not found", { status: 404 });
          }
          revokeApiKey(req.params.keyId);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      // The same revocation the API does, as a form a browser can post: an HTML form
      // cannot send a DELETE, and the settings page is where a share is seen.
      "/settings/:ws/shares/:shareId/revoke": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          const share = getShare(req.params.shareId);
          if (!share || share.workspace_id !== req.params.ws) {
            return new Response("Not found", { status: 404 });
          }
          revokeShare(share.id);
          return redirect(`/settings/${req.params.ws}`);
        },
      },

      "/github/setup": {
        GET: (req) => handleGithubSetupCallback(req),
      },
      "/github/account/callback": {
        GET: (req) => handleGithubAccountCallback(req),
      },
      "/github/account/connect": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const user = sessionUser(req);
          if (!user) return new Response("Sign in first", { status: 403 });
          return handleConnectGithubAccount(user.id);
        },
      },
      "/settings/:ws/github/credentials": {
        POST: async (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          return handlePasteGithubToken(req, gate.id, `/settings/${req.params.ws}`);
        },
      },
      "/settings/:ws/github/credentials/:id/revoke": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          if (!revokeGithubUserCredential(req.params.id, gate.id)) return new Response("Not found", { status: 404 });
          return redirect(`/settings/${req.params.ws}`);
        },
      },
      "/github/claim": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          return handleClaimInstallation(req);
        },
      },

      "/settings/:ws/github/connect": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          return handleConnectGithub(req.params.ws, gate.id);
        },
      },

      "/settings/:ws/github/:id/disconnect": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const gate = requireMember(req, req.params.ws);
          if (gate instanceof Response) return gate;
          return handleDisconnectGithub(req.params.ws, req.params.id);
        },
      },

      // Public invite page. A valid, unaccepted, unexpired token renders the invite;
      // a signed-in viewer gets a one-click accept, a signed-out one a Google sign-in
      // that carries the invite as `next`. Anything invalid is a soft-404 (an oracle
      // for used/expired/unknown tokens would leak which workspaces exist).
      "/invite/:token": {
        GET: (req) => {
          const token = req.params.token;
          if (!INV_ID_RE.test(token)) return softNotFound(req);
          const inv = lookupValidInvite(token);
          if (!inv) return softNotFound(req);
          const ws = getWorkspace(inv.workspace_id);
          const inviter = getUser(inv.created_by);
          if (!ws) return softNotFound(req);
          return html(
            invitePage({
              token,
              workspaceName: ws.name,
              inviterEmail: inviter?.email ?? "a member",
              expires: fmtDate(inv.expires_at),
              signedIn: !!sessionUser(req),
            }),
          );
        },
      },

      // A signed-in user accepts an invite (new members join via the OIDC path).
      "/invite/:token/accept": {
        POST: (req) => {
          if (!originOk(req)) return new Response("Bad origin", { status: 403 });
          const token = req.params.token;
          if (!INV_ID_RE.test(token)) return softNotFound(req);
          const user = sessionUser(req);
          if (!user) return new Response("Sign in required", { status: 403 });
          // Invalid, expired, or used token is indistinguishable from missing.
          if (!acceptInvite(token, user.email)) return softNotFound(req);
          return redirect("/bundles");
        },
      },
    },

    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws/livereload") {
        // A shared bundle page names its token and nothing else: the workspace and the
        // slug come off the share row, so a holder cannot widen the channel by editing
        // the query, and a token that stops resolving stops reloading. Everyone else
        // names the workspace and is gated on it.
        const shareToken = url.searchParams.get("share");
        if (shareToken !== null) {
          const share = resolveShare(shareToken);
          if (!share || share.kind !== "bundle") return new Response("Not found", { status: 404 });
          const data: WSData = {
            ws: share.workspace_id,
            slug: share.target,
            kind: "bundle",
            shareId: share.id,
          };
          if (srv.upgrade(req, { data })) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        const wsId = url.searchParams.get("ws") ?? "";
        const slug = url.searchParams.get("slug") ?? "";
        const kind = url.searchParams.get("kind") === "review" ? "review" : "bundle";
        if (!WS_ID_RE.test(wsId) || !SLUG_RE.test(slug)) {
          return new Response("Bad request", { status: 400 });
        }
        // Same access rule as serving: only upgrade when the viewer could view it. A
        // review channel is stricter than a bundle's: a public workspace serves its
        // bundles to anyone, but a review holds private source, so this one asks for
        // membership rather than viewability.
        const ws = getWorkspace(wsId);
        if (!ws) return new Response("Not found", { status: 404 });
        const allowed = kind === "review" ? workspaceMember(ws, req) : workspaceViewable(ws, req);
        if (!allowed) return new Response("Not found", { status: 404 });
        if (srv.upgrade(req, { data: { ws: wsId, slug, kind } }))
          return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // A share: one revocable, read-only link to one asset, at one URL shape whatever
      // the asset is. The token is the whole of the authorisation, which is why it
      // travels in the path rather than on the asset's own URL: the secret and the
      // canonical URL stay separate things, and this is the one place that sets
      // Referrer-Policy so following a link out of a shared page cannot leak it.
      //
      // It is matched here rather than declared as routes because a shared bundle is a
      // whole tree: the remainder after the token is arbitrary, and what it means is
      // not knowable until the token says which kind of asset it opens.
      if (url.pathname.startsWith("/s/")) return handleShareRequest(req);

      const stageRead = url.pathname.match(WS_STAGE_READ_RE);
      if (stageRead) {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        return handleStageReadMutation(req, stageRead[1]!, stageRead[2]!, stageRead[3]!, stageRead[4]!);
      }
      const stagePage = url.pathname.match(WS_STAGE_RE);
      if (stagePage) {
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        return handleStagePage(req, stagePage[1]!, stagePage[2]!, stagePage[3] ?? null);
      }

      const wsPage = url.pathname.match(WS_PAGE_RE);
      if (wsPage) return handleWorkspacePage(req, wsPage[1]!, wsPage[2]);

      const wsProject = url.pathname.match(WS_PROJECT_RE);
      if (wsProject) return handleProjectPage(req, wsProject[1]!, wsProject[2]!);

      const wsBundle = url.pathname.match(WS_BUNDLE_RE);
      if (wsBundle) return handleWorkspaceBundle(req, wsBundle[1]!);

      const wsImage = url.pathname.match(WS_IMG_RE);
      if (wsImage) return handleWorkspaceImage(req, wsImage[1]!);

      const wsAnnotations = url.pathname.match(WS_ANNOTATIONS_RE);
      if (wsAnnotations) {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (!originOk(req)) return new Response("Bad origin", { status: 403 });
        return handleAnnotation(req, wsAnnotations[2]!, wsAnnotations[1]!);
      }

      const wsContext = url.pathname.match(WS_REVIEW_CONTEXT_RE);
      if (wsContext) return handleReviewContext(req, wsContext[2]!, wsContext[1]!);

      const revisionRead = url.pathname.match(WS_REVISION_READ_RE);
      if (revisionRead) {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        return handleRevisionReadMutation(req, revisionRead[1]!, revisionRead[2]!, revisionRead[3]!, revisionRead[4]!);
      }

      const wsReview = url.pathname.match(WS_REVIEW_RE);
      if (wsReview) {
        const [, wsId, slug, part, value] = wsReview;
        if (part === "a") return handleReviewAttachment(req, slug!, value!, wsId!);
        // `/rev/` exists only for a promoted review, so it never falls back: on a slug a
        // legacy review owns it is a miss, not that review's latest version.
        if (part === "rev") return handlePromotedReviewPage(req, wsId!, slug!, { kind: "revision", raw: value! });
        // Legacy first, and that ordering is the guarantee: a slug a legacy review
        // already holds keeps its shipped page, so no promoted review can change what an
        // old link means. Publishing refuses the collision in both directions anyway;
        // this is the reading half of the same rule.
        if (getReview(wsId!, slug!)) return handleReviewPage(req, slug!, part === "v" ? value! : null, wsId!);
        if (promotedOwnsSlug(wsId!, slug!)) {
          return handlePromotedReviewPage(req, wsId!, slug!, part === "v" ? { kind: "account", raw: value! } : null);
        }
        return handleReviewPage(req, slug!, part === "v" ? value! : null, wsId!);
      }

      // Legacy /b/<slug>[...] → 301 to the bootstrap workspace, preserving the full
      // remainder and query. No legacy workspace recorded → a plain 404.
      if (url.pathname.startsWith("/b/")) {
        const ws = legacyWorkspaceId();
        if (!ws) return new Response("Not found", { status: 404 });
        const remainder = url.pathname.slice("/b/".length);
        return new Response(null, {
          status: 301,
          headers: { location: `/${ws}/b/${remainder}${url.search}` },
        });
      }

      return new Response("Not found", { status: 404 });
    },

    websocket,
  });

  // Freshness pushes go out over this server's sockets. Handed in rather than imported
  // so the freshness module never has to know a server exists to be tested.
  setFreshnessPublisher((topic, message) => {
    server.publish(topic, message);
  });

  // A revoked share loses its live channel in the same breath as its link. Without this
  // a holder whose page is already open keeps being told that new versions exist —
  // the reload lands on the soft-404, but being told at all is more than a revoked
  // token should be able to learn.
  setShareRevokedHook((shareId) => {
    for (const socket of shareSockets) {
      if (socket.data.shareId === shareId) socket.close();
    }
  });

  console.log(`Seer listening on ${config.baseUrl} (port ${server.port})`);
  // Log the absolute data path so a Railway volume's mount path can be verified
  // against it — they must match, or writes land on ephemeral disk.
  console.log(`Data dir: ${resolve(config.dataDir)} (SQLite + extraction cache)`);
  console.log(
    s3
      ? `Blob store: s3://${config.s3!.bucket} (${config.s3!.region ?? config.s3!.endpoint})`
      : "Blob store: local disk (set S3_BUCKET to use S3)",
  );

  // Graceful shutdown. Railway (and most platforms) send SIGTERM to the old
  // container on every redeploy. Without a handler the process is terminated
  // with a non-zero code (143), which the platform reports as a crash. Stop
  // the server, flush SQLite (WAL checkpoint on close), and exit 0 so a redeploy
  // is a clean handoff, not a "crash".
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[seer] ${signal} received — shutting down gracefully`);
    server.stop();
    try {
      db.close();
    } catch (err) {
      console.error("[seer] error closing database on shutdown:", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}
