import { ATT_ID_RE, STF_ID_RE } from "../ids";
import { getAttachment } from "./db";
import { openAttachment, attachmentLocation } from "../store";
import { retainedLinesResponse } from "../stage/read";
import {
  readerGroupOf,
  renderReaderPage,
  type ReaderDoc,
  type ReaderPullRequest,
  type ReaderRoutes,
} from "../stage/render";
import type { ShareRow } from "../shares";
import { projectAgent } from "./actor-projection";
import { resolveDocumentCapability } from "./capability-db";
import type { ResolvedCapability, ReviewCapability } from "./capability-types";
import { MAX_STACK_MEMBER_POSITIONS } from "./stack-types";
import { observationForRevision, observationStateWord, pullRequestUrl } from "./revision-pr";
import { evidenceSeams } from "./revision-read";
import { softNotFound } from "./render";
import { renderStackCapability } from "./stack-render";
import { readCapabilityConversation } from "./conversation-read";

const REVIEW_FILE_RE = /^files\/([^/]+)\/?$/;
const STACK_FILE_RE = /^m\/([1-9][0-9]?)\/files\/([^/]+)\/?$/;
const ATTACHMENT_RE = /^a\/([^/]+)\/?$/;

function capabilityRoutes(basePath: string): ReaderRoutes {
  return {
    group(groupId, changeId) {
      const params = new URLSearchParams({ review: groupId });
      if (changeId) params.set("change", changeId);
      return `${basePath}?${params.toString()}#${changeId ?? `review-${groupId}`}`;
    },
    close: () => basePath,
    lines: (fileId, side, start, end) => `${basePath}/files/${fileId}?side=${side}&start=${start}&end=${end}`,
    history: () => [],
    contextLinks: true,
  };
}

function projectedAgent(agent: { name: string; model: string }): { name: string; model: string } {
  const projected = projectAgent(agent.name, agent.model);
  if (projected.kind !== "agent") throw new Error("agent projection changed family");
  return { name: projected.label, model: projected.model };
}

function pullRequestOf(capability: ReviewCapability): ReaderPullRequest | null {
  const observed = observationForRevision(capability.share.workspace_id, capability.revision.id);
  return observed ? {
    repo: observed.repo,
    number: observed.pr_number,
    title: observed.title,
    url: pullRequestUrl(observed.repo, observed.pr_number),
    state: observationStateWord(observed),
    observedAt: observed.observed_at,
    headSha: observed.head_sha,
  } : null;
}

function reviewDoc(capability: ReviewCapability, basePath: string): ReaderDoc {
  const { revision, account } = capability;
  const builder = revision.doc.builder;
  return {
    title: revision.doc.identity.title,
    source: {
      repo: revision.doc.source.repo,
      branch: revision.doc.source.branch,
      sourceHeadSha: revision.doc.source.sourceHeadSha,
      mergeBaseSha: revision.doc.source.mergeBaseSha,
    },
    pullRequest: pullRequestOf(capability),
    builder: builder ? { agent: projectedAgent(builder.agent), body: builder.intent, context: builder.context } : null,
    witness: account ? { agent: projectedAgent(account.doc.witness.agent), body: account.doc.witness.summary } : null,
    groups: account ? account.doc.groups.map(readerGroupOf) : evidenceSeams(capability.inventory),
    focus: account ? account.doc.focus : [],
    evidence: account ? account.doc.evidence.map((item) => item.kind === "bundle"
      ? { label: `${item.slug} v${item.version}`, href: null, detail: "bundle" }
      : { label: item.caption || item.alt, href: `${basePath}/a/${item.id}`, detail: item.mediaType }) : [],
    authored: account !== null,
    workflow: null,
    drift: null,
    movement: null,
    standing: account ? `v${account.version} · rev ${revision.revision}` : `rev ${revision.revision}`,
    pin: account ? `v${account.version}` : `rev ${revision.revision}`,
    latest: false,
  };
}

async function root(req: Request, share: ShareRow, token: string): Promise<Response> {
  const allowed = new Set(share.kind === "stack_document"
    ? ["review", "change", "panel", "tree", "detail", "layer", "page", "fallback-page"]
    : ["review", "change", "panel", "tree", "detail"]);
  if ([...new URL(req.url).searchParams.keys()].some((key) => !allowed.has(key))) return softNotFound();
  const resolved = resolveDocumentCapability(share);
  if (!resolved) return softNotFound();
  const basePath = `/s/${token}`;
  if (resolved.kind === "stack") {
    const response = await renderStackCapability(req, resolved, basePath);
    return response.status === 404 ? softNotFound() : response;
  }
  const doc = reviewDoc(resolved, basePath);
  if (resolved.scope.conversation_scope === "snapshot") {
    const conversation = await readCapabilityConversation(resolved);
    if (!conversation) return softNotFound();
    doc.conversation = { ...conversation, importState: "never", complete: true, truncated: false, exactRevisionId: resolved.revision.id, exactAccountId: resolved.account?.id ?? null, createAction: null, replyAction: null, resolutionAction: null, refreshAction: null, returnTo: basePath };
  }
  const routes = capabilityRoutes(basePath);
  routes.history = () => [{ label: doc.pin, href: basePath, current: true }];
  const response = await renderReaderPage(
    req,
    { kind: "capability", nav: null, handling: null, basePath },
    share.workspace_id,
    doc,
    routes,
    resolved.inventory,
    `capability ${share.id}`,
    { brandPath: basePath },
  );
  return response.status === 404 ? softNotFound() : response;
}

function memberAt(capability: ResolvedCapability, position: number) {
  return capability.kind === "review"
    ? position === 1 ? capability : null
    : capability.members.find((member) => member.position === position) ?? null;
}

async function lines(req: Request, capability: ResolvedCapability, position: number, fileId: string): Promise<Response> {
  if (!STF_ID_RE.test(fileId)) return softNotFound();
  const member = memberAt(capability, position);
  const file = member?.inventory.files.find((candidate) => candidate.id === fileId);
  const grant = capability.files.find((row) => row.member_position === position && row.file_id === fileId);
  if (!member || !file || !grant || grant.workspace_id !== capability.share.workspace_id ||
      grant.revision_id !== member.revision.id || grant.capture_id !== member.revision.capture_id) return softNotFound();
  return retainedLinesResponse(grant.workspace_id, file, new URL(req.url), `share/${capability.share.id}/${position}`);
}

async function attachment(capability: ResolvedCapability, attachmentId: string): Promise<Response> {
  if (!ATT_ID_RE.test(attachmentId)) return softNotFound();
  const held = capability.attachments.find((row) => row.attachment_id === attachmentId);
  if (!held || held.workspace_id !== capability.share.workspace_id) return softNotFound();
  const row = getAttachment(held.workspace_id, held.review_slug, held.attachment_id);
  if (!row) return softNotFound();
  const body = await openAttachment(held.workspace_id, held.attachment_id);
  if (body === null) {
    console.error(`[seer] capability attachment ${held.attachment_id} has no blob at ${attachmentLocation(held.workspace_id, held.attachment_id)}`);
    return softNotFound();
  }
  return new Response(body, { headers: {
    "content-type": row.media_type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  } });
}

export async function handleDocumentCapabilityRequest(
  req: Request,
  share: ShareRow,
  token: string,
  rest: string | null,
): Promise<Response> {
  const tail = rest ?? "";
  if (tail === "" || tail === "/") return root(req, share, token);
  const capability = resolveDocumentCapability(share);
  if (!capability) return softNotFound();
  const attachmentMatch = tail.match(ATTACHMENT_RE);
  if (attachmentMatch) return attachment(capability, attachmentMatch[1]!);
  if (share.kind === "review_document") {
    const file = tail.match(REVIEW_FILE_RE);
    return file ? lines(req, capability, 1, file[1]!) : softNotFound();
  }
  if (share.kind === "stack_document") {
    const file = tail.match(STACK_FILE_RE);
    const position = file ? Number(file[1]) : 0;
    return file && position <= MAX_STACK_MEMBER_POSITIONS ? lines(req, capability, position, file[2]!) : softNotFound();
  }
  return softNotFound();
}
