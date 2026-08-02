// The Overseer write path. One route today: POST /api/reviews, the one-shot publish.
//
// A review is authored in one shot, so this is one straight line with no partial
// states in it: parse the body, derive the facts from GitHub, validate the whole
// document, resolve every ref and every attachment, and only then write. Nothing
// touches the database until every check has passed, which is what makes a 422 leave
// the workspace exactly as it found it.
//
// The pieces this composes are the ones earlier steps built and this module does not
// re-implement: derivePrs()/refResolver() for the fact half, validatePublish() for the
// rules, processImage() for attachment bytes, createReviewVersion() for storage.

import { config } from "../config";
import { getBundle } from "../db";
import { IMAGE_TYPES, processImage, sniffOk } from "../images";
import { saveAttachment } from "../store";
import { db } from "../db";
import { tinyId } from "../ids";
import { requireApiKey } from "../auth";
import { createAttachment, createReviewVersion, getReview, getReviewVersion, type ReviewDoc } from "./db";
import {
  derivePrs,
  PrPointerError,
  hunksOf,
  kindsForPr,
  refResolver,
  RefResolveError,
  type DerivedPr,
  type DerivedReview,
  type PrPointer,
} from "./derive";
import { GithubError, githubClient } from "./github";
import {
  validatePublish,
  type EvidenceInput,
  type PriorDoc,
  type PublishPayload,
  type RefPointerInput,
  type ValidationError,
  type ValidationWarning,
} from "./validate";
import {
  prKey,
  type Evidence,
  type Group,
  type Hunk,
  type Note,
  type Pr,
  type Ref,
  type Statement,
  type StatementKind,
} from "./types";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unprocessable(errors: ValidationError[], warnings: ValidationWarning[] = []): Response {
  return json({ error: "The review was not published", errors, warnings }, 422);
}

// ---- the body ----

/** The publish body: the document itself, plus the slug it publishes to. Attachment
 *  bytes travel as multipart parts named by the attachment id the document authors. */
interface PublishBody {
  slug: unknown;
  payload: PublishPayload;
  /** The bytes actually read, document part and attachment parts together. The route
   *  measures the upload against this rather than against a declared content-length,
   *  which a chunked request does not send and a lying one gets wrong. */
  bytes: number;
  /** Part name (an authored attachment id) to its bytes. Empty for a bare JSON body. */
  parts: Map<string, { bytes: Uint8Array; filename: string; type: string }>;
}

const DOCUMENT_PART = "document";

class BadBody extends Error {}

async function readBody(req: Request): Promise<PublishBody> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) {
    const text = await req.text();
    if (text.trim() === "") throw new BadBody("Empty body; send the review document as JSON");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new BadBody(`Body is not JSON: ${(err as Error).message}`);
    }
    return {
      slug: slugOf(parsed),
      payload: parsed as PublishPayload,
      parts: new Map(),
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }

  // The runtime FormData, whose values are string | File. Spelled off the method so
  // the DOM and undici declarations of it cannot disagree here.
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch (err) {
    throw new BadBody(`Body is not multipart/form-data: ${(err as Error).message}`);
  }
  const document = form.get(DOCUMENT_PART);
  if (document === null) {
    throw new BadBody(`Multipart body has no "${DOCUMENT_PART}" part carrying the review JSON`);
  }
  const text = typeof document === "string" ? document : await document.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BadBody(`The "${DOCUMENT_PART}" part is not JSON: ${(err as Error).message}`);
  }

  const parts = new Map<string, { bytes: Uint8Array; filename: string; type: string }>();
  let bytes = Buffer.byteLength(text, "utf8");
  for (const [name, value] of form.entries()) {
    if (name === DOCUMENT_PART) continue;
    if (typeof value === "string") {
      throw new BadBody(`Part "${name}" carries text; an attachment part carries file bytes`);
    }
    if (parts.has(name)) {
      throw new BadBody(`Part "${name}" appears more than once`);
    }
    const partBytes = new Uint8Array(await value.arrayBuffer());
    bytes += partBytes.length;
    parts.set(name, {
      bytes: partBytes,
      filename: value.name ?? "",
      type: value.type ?? "",
    });
  }
  return { slug: slugOf(parsed), payload: parsed as PublishPayload, parts, bytes };
}

function slugOf(parsed: unknown): unknown {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { slug?: unknown }).slug
    : undefined;
}

// ---- pull request pointers ----

/** The pointers to derive from, or null when the authored `prs` cannot be read as
 *  pointers at all. Null sends the payload through the validator with no derived facts,
 *  which answers with a 422 naming every field that is wrong rather than a crash out of
 *  the deriver. Duplicates are refused here too, for the same reason: derivePrs()
 *  throws on them and validatePublish() reports them by field. */
function pointersOf(payload: PublishPayload): PrPointer[] | null {
  const prs = payload?.prs;
  if (!Array.isArray(prs) || prs.length === 0) return null;
  const seen = new Set<string>();
  const out: PrPointer[] = [];
  for (const pr of prs) {
    if (pr === null || typeof pr !== "object") return null;
    const { repo, number } = pr;
    if (typeof repo !== "string" || repo === "" || !Number.isInteger(number)) return null;
    const key = prKey(repo, number);
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ repo, number, parent: pr.parent ?? null });
  }
  return out;
}

// ---- resolution ----

/** Every ref pointer in the document, in one list, each with the field path it was
 *  authored at, so a ref that does not resolve is a 422 naming that field. */
function pointerSites(payload: PublishPayload): { field: string; pointer: RefPointerInput }[] {
  const sites: { field: string; pointer: RefPointerInput }[] = [];
  payload.prs.forEach((pr, i) => {
    if (pr.detailRef) sites.push({ field: `prs[${i}].detailRef`, pointer: pr.detailRef });
  });
  const evidenceSites = (at: string, evidence: EvidenceInput[]) => {
    evidence.forEach((e, j) => {
      if (e?.type === "ref" && e.ref) sites.push({ field: `${at}.evidence[${j}].ref`, pointer: e.ref });
    });
  };
  payload.statements.forEach((s, i) => {
    s.refs.forEach((r, j) => sites.push({ field: `statements[${i}].refs[${j}]`, pointer: r }));
    evidenceSites(`statements[${i}]`, s.evidence);
  });
  payload.notes.forEach((n, i) => {
    n.refs.forEach((r, j) => sites.push({ field: `notes[${i}].refs[${j}]`, pointer: r }));
    evidenceSites(`notes[${i}]`, n.evidence);
  });
  return sites;
}

function pointerKey(p: RefPointerInput): string {
  return `${p.repo}@${p.sha}:${p.path}:${p.startLine}-${p.endLine}:${(p.highlight ?? []).join(",")}`;
}

/** A ref that Overseer could not resolve because GitHub would not answer, rather than
 *  because the pointer was wrong. The skill rewriting a correct ref would not help. */
class UpstreamError extends Error {}

/** Resolve every pointer once. Returns the resolved refs by pointer key, or the 422
 *  errors when one or more pointers do not resolve. */
async function resolveRefs(
  review: DerivedReview,
  payload: PublishPayload,
): Promise<{ refs: Map<string, Ref>; errors: ValidationError[] }> {
  const resolver = refResolver(githubClient(), review);
  const refs = new Map<string, Ref>();
  const errors: ValidationError[] = [];
  for (const site of pointerSites(payload)) {
    const key = pointerKey(site.pointer);
    if (refs.has(key)) continue;
    try {
      refs.set(key, await resolver.resolve(site.pointer));
    } catch (err) {
      if (!(err instanceof RefResolveError)) throw err;
      // Per RefResolveError.status: a 404 and a client-side refusal (0) are the skill's
      // fault. Anything else GitHub answered is Overseer's, and answering 422 would make
      // the skill rewrite a correct ref. A null status is ambiguous on its own: the
      // deriver refuses a malformed pointer before fetching with no cause at all, but a
      // transport failure (DNS, a reset connection, `fetch failed`) also arrives as a
      // plain Error carried as the cause. So the cause decides: a failure the client
      // threw that is not a GithubError never reached GitHub, and is upstream.
      const upstreamCause = err.cause !== undefined && !(err.cause instanceof GithubError);
      if (upstreamCause || (err.status !== null && err.status !== 0 && err.status !== 404)) {
        throw new UpstreamError(err.message);
      }
      errors.push({ field: site.field, rule: "ref_unresolved", message: err.message });
    }
  }
  return { refs, errors };
}

// ---- attachments ----

interface ResolvedAttachment {
  /** The id the document authors and evidence references. */
  authoredId: string;
  /** The minted `att_` id the blob is stored under and the document names. */
  id: string;
  mediaType: string;
  bytes: Uint8Array;
  alt: string;
  caption: string;
}

/** The image extension for a part, from its filename first and its declared type
 *  second. Null when neither names an image format Seer processes. */
function extOf(filename: string, type: string): string | null {
  const named = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  // Own keys only: IMAGE_TYPES is a plain object, so `in` would accept a part named
  // "shot.constructor" as an image format and hand it to a pipeline that cannot read it.
  if (named && Object.hasOwn(IMAGE_TYPES, named)) return named;
  for (const [ext, mime] of Object.entries(IMAGE_TYPES)) {
    if (mime === type.toLowerCase().split(";")[0]?.trim()) return ext;
  }
  return null;
}

/** Pair each authored attachment with its multipart part. Every error here is the
 *  author's: a declared attachment with no bytes, bytes with nothing declaring them,
 *  or a part that is not an image. */
function pairAttachments(payload: PublishPayload, body: PublishBody): ValidationError[] {
  const errors: ValidationError[] = [];
  const declared = new Set<string>();
  payload.attachments.forEach((a, i) => {
    if (typeof a.id !== "string" || a.id === "") return; // validatePublish names it
    declared.add(a.id);
    if (!body.parts.has(a.id)) {
      errors.push({
        field: `attachments[${i}]`,
        rule: "attachment_missing_part",
        message: `attachment ${a.id} is declared but no part of the upload carries its bytes`,
      });
    }
  });
  for (const [name, part] of body.parts) {
    if (!declared.has(name)) {
      errors.push({
        field: "attachments",
        rule: "attachment_part_undeclared",
        message: `part ${name} carries bytes for an attachment the document does not declare`,
      });
      continue;
    }
    const ext = extOf(part.filename, part.type);
    if (ext === null || !sniffOk(ext, part.bytes)) {
      errors.push({
        field: "attachments",
        rule: "attachment_not_image",
        message: `part ${name} is not an image; attachments are image/* to start`,
      });
    }
  }
  return errors;
}

/** Process every attachment's bytes through the same pipeline images take. Runs after
 *  pairAttachments(), so every declared attachment has a part and every part is an
 *  image. Nothing is written here: the ids are minted, the bytes are held. */
async function resolveAttachments(
  payload: PublishPayload,
  body: PublishBody,
): Promise<{ attachments: ResolvedAttachment[]; errors: ValidationError[] }> {
  const attachments: ResolvedAttachment[] = [];
  const errors: ValidationError[] = [];
  for (const [i, a] of payload.attachments.entries()) {
    const part = body.parts.get(a.id)!;
    const ext = extOf(part.filename, part.type)!;
    try {
      // The same pipeline /api/images uses, SVG passthrough included: an SVG is text,
      // so its bytes are stored verbatim under image/svg+xml. Whichever route serves an
      // attachment blob must send the header the image route sends for that media type
      // (`content-security-policy: default-src 'none'; style-src 'unsafe-inline'`), or
      // an uploaded SVG is stored script inside the workspace.
      const image = await processImage(ext, `attachment.${ext}`, part.bytes);
      attachments.push({
        authoredId: a.id,
        id: tinyId("att"),
        mediaType: image.contentType,
        bytes: image.data,
        alt: a.alt,
        caption: a.caption ?? "",
      });
    } catch (err) {
      errors.push({
        field: `attachments[${i}]`,
        rule: "attachment_undecodable",
        message: `attachment ${a.id} could not be decoded: ${(err as Error).message}`,
      });
    }
  }
  return { attachments, errors };
}

// ---- the resolved document ----

function resolveEvidence(
  evidence: EvidenceInput[],
  refs: Map<string, Ref>,
  attachments: Map<string, ResolvedAttachment>,
): Evidence[] {
  return evidence.map((e): Evidence => {
    switch (e.type) {
      case "ref":
        return { type: "ref", ref: refs.get(pointerKey(e.ref))! };
      case "attachment": {
        const a = attachments.get(e.attachment.id)!;
        return {
          type: "attachment",
          attachment: {
            id: a.id,
            mediaType: a.mediaType,
            bytes: a.bytes.length,
            alt: a.alt,
            caption: a.caption,
          },
        };
      }
      case "bundle":
        return {
          type: "bundle",
          bundle: {
            slug: e.bundle.slug,
            version: e.bundle.version,
            caption: e.bundle.caption,
          },
        };
      // The three authored kinds carry no derived half, but they are still picked field
      // by field: a stored document is a known shape, never whatever keys the body had.
      case "payload":
        return {
          type: "payload",
          payload: {
            lang: e.payload.lang,
            before: e.payload.before,
            after: e.payload.after,
            highlight: e.payload.highlight,
          },
        };
      case "figure":
        return {
          type: "figure",
          figure: {
            kind: e.figure.kind,
            nodes: e.figure.nodes.map((n) => ({ id: n.id, label: n.label, state: n.state })),
            edges: e.figure.edges.map((edge) => ({
              from: edge.from,
              to: edge.to,
              label: edge.label,
            })),
          },
        };
      case "example":
        return {
          type: "example",
          example: { lang: e.example.lang, text: e.example.text, caption: e.example.caption },
        };
    }
  });
}

/** A group's mark: `change` when its hunks both add and delete lines, and the one kind
 *  it does otherwise. A group of pure context (no changed lines at all) cannot exist,
 *  because a hunk without a changed line is not a hunk; `change` is the safe reading if
 *  one ever did. */
function groupKind(hunks: Hunk[]): StatementKind {
  let added = false;
  let removed = false;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added = true;
      if (line.kind === "del") removed = true;
    }
  }
  if (added && !removed) return "add";
  if (removed && !added) return "remove";
  return "change";
}

function buildDocument(args: {
  payload: PublishPayload;
  review: DerivedReview;
  refs: Map<string, Ref>;
  attachments: Map<string, ResolvedAttachment>;
  significance: { id: string; significance: number }[] | null;
  createdAt: number;
  updatedAt: number;
}): Omit<ReviewDoc, "id" | "slug" | "version"> {
  const { payload, review, refs, attachments } = args;
  const derivedByKey = new Map(review.prs.map((pr) => [prKey(pr.repo, pr.number), pr] as const));
  const hunks = review.prs.flatMap((pr) => hunksOf(pr));
  const hunkById = new Map(hunks.map((h) => [h.id, h] as const));
  const respaced = new Map((args.significance ?? []).map((g) => [g.id, g.significance] as const));

  const statements: Statement[] = payload.statements.map((s) => ({
    id: s.id,
    kind: s.kind,
    text: s.text,
    prs: s.prs,
    refs: s.refs.map((r) => refs.get(pointerKey(r))!),
    body: s.body,
    evidence: resolveEvidence(s.evidence, refs, attachments),
  }));

  const prs: Pr[] = payload.prs.map((pr): Pr => {
    const derived = derivedByKey.get(prKey(pr.repo, pr.number)) as DerivedPr;
    return {
      repo: derived.repo,
      number: derived.number,
      title: derived.title,
      headSha: derived.headSha,
      baseSha: derived.baseSha,
      baseRef: derived.baseRef,
      parent: derived.parent,
      author: derived.author,
      coAuthors: derived.coAuthors,
      body: derived.body,
      gist: pr.gist,
      detail: pr.detail,
      detailRef: refs.get(pointerKey(pr.detailRef))!.id,
      // The derived-kinds rule from step 4, called with the document's own statements
      // so a card's marks are tied to claims that survived validation.
      kinds: kindsForPr(statements, prKey(derived.repo, derived.number)),
    };
  });

  const notes: Note[] = payload.notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    text: n.text,
    body: n.body,
    checks: n.checks,
    refs: n.refs.map((r) => refs.get(pointerKey(r))!),
    evidence: resolveEvidence(n.evidence, refs, attachments),
  }));

  const groups: Group[] = payload.groups.map((g) => ({
    id: g.id,
    title: g.title,
    significance: respaced.get(g.id) ?? g.significance,
    paragraph: g.paragraph,
    hunks: g.hunks,
    fileNotes: g.fileNotes,
    kind: groupKind(g.hunks.map((id) => hunkById.get(id)!).filter(Boolean)),
  }));

  return {
    title: payload.title,
    kind: review.kind,
    // The authored handle travels with the minted id: the next publish to this slug
    // reads it back as the prior version's attachment ids, which is what keeps the
    // id namespace shared across versions rather than only within one.
    attachments: payload.attachments.map((a) => {
      const stored = attachments.get(a.id)!;
      return {
        id: stored.id,
        authoredId: stored.authoredId,
        mediaType: stored.mediaType,
        bytes: stored.bytes.length,
        alt: stored.alt,
        caption: stored.caption,
      };
    }),
    summary: payload.summary,
    prs,
    statements,
    notes,
    groups,
    hunks,
    skillContext: review.skillContext,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
  };
}

// ---- the route ----

export async function handlePublishReview(req: Request): Promise<Response> {
  const auth = requireApiKey(req);
  if (auth instanceof Response) return auth;
  const ws = auth.workspaceId;

  const tooBig = (): Response =>
    json({ error: `Review exceeds max size of ${config.maxUploadBytes} bytes` }, 413);

  // A declared size over the limit is refused before the body is read at all. It is
  // only a hint: a chunked request declares nothing, so the real check is on the bytes.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > config.maxUploadBytes) return tooBig();

  // Every fact half of a review comes off the GitHub API, so publishing without a
  // token is a misconfiguration and not a smaller review. Bundles and images are
  // untouched by it, which is why this refuses here rather than at boot.
  if (!config.githubToken) {
    return json(
      {
        error:
          "GITHUB_TOKEN is not set, and Overseer derives every review from the GitHub API. " +
          "Set GITHUB_TOKEN and publish again.",
      },
      503,
    );
  }

  let body: PublishBody;
  try {
    body = await readBody(req);
  } catch (err) {
    if (!(err instanceof BadBody)) throw err;
    return json({ error: err.message }, 400);
  }
  if (body.bytes > config.maxUploadBytes) return tooBig();
  if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
    return json({ error: "slug is required and must match [a-z0-9][a-z0-9-]{0,63}" }, 400);
  }
  const slug = body.slug;
  const payload = body.payload;

  const bundleExists = (bundleSlug: string, version: number | null): boolean => {
    const bundle = getBundle(ws, bundleSlug);
    if (!bundle) return false;
    return version === null || (Number.isInteger(version) && version >= 1 && version <= bundle.latest_version);
  };

  const pointers = pointersOf(payload);
  if (!pointers) {
    // Unusable pointers: the validator answers with the fields that are wrong.
    const { errors, warnings } = validatePublish(payload, { prs: [] }, null, { bundleExists });
    if (errors.length === 0) {
      // Unreachable while the validator reports a pull request list it has no derived
      // facts for, which it does today. A 422 carrying nothing would leave the skill
      // with no field to fix, so this says what happened instead of shipping an empty one.
      errors.push({
        field: "prs",
        rule: "pr_not_derivable",
        message: "prs could not be read as pull request pointers",
      });
    }
    return unprocessable(errors, warnings);
  }

  let review: DerivedReview;
  try {
    review = await derivePrs(githubClient(), pointers);
  } catch (err) {
    // Only the pointers themselves are the skill's to fix. GitHub answering badly, or
    // not answering at all, is Overseer's: telling the skill its pull requests are
    // invalid would have it re-author correct content against a network fault.
    if (err instanceof PrPointerError) {
      return unprocessable([{ field: "prs", rule: "pr_not_derivable", message: err.message }]);
    }
    return json(
      { error: `Overseer could not read the pull requests from GitHub: ${(err as Error).message}` },
      502,
    );
  }

  const existing = getReview(ws, slug);
  const priorVersion = existing ? getReviewVersion(ws, slug, existing.latest_version) : null;
  // The prior document as the validator reads it. Attachments are mapped back to the
  // handles the prior publish authored, because those are the ids this payload's
  // statements, notes and groups share a namespace with; the minted `att_` ids are
  // Overseer's own and no payload ever names them.
  const priorDoc = priorVersion ? priorVersion.doc : null;
  const prior: PriorDoc | null = priorDoc
    ? {
        statements: priorDoc.statements,
        notes: priorDoc.notes,
        groups: priorDoc.groups,
        attachments: (priorDoc.attachments ?? []).map((a) => ({ id: a.authoredId })),
      }
    : null;

  const result = validatePublish(
    payload,
    { prs: review.prs.map((pr) => ({ repo: pr.repo, number: pr.number, hunks: hunksOf(pr) })) },
    prior,
    { bundleExists },
  );
  // The rules run first and alone: every check after this one reads the payload's
  // lists directly, and a payload that failed here may not have any.
  if (result.errors.length > 0) return unprocessable(result.errors, result.warnings);
  const partErrors = pairAttachments(payload, body);
  if (partErrors.length > 0) return unprocessable(partErrors, result.warnings);

  // Refs and attachment bytes are the two checks that cost work, so they run once the
  // cheap rules have passed. Both still write nothing: their failures are 422s too.
  let refs: Map<string, Ref>;
  let refErrors: ValidationError[];
  try {
    ({ refs, errors: refErrors } = await resolveRefs(review, payload));
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    return json({ error: `Overseer could not read a ref from GitHub: ${err.message}` }, 502);
  }
  const resolved = await resolveAttachments(payload, body);
  const lateErrors = [...refErrors, ...resolved.errors];
  if (lateErrors.length > 0) return unprocessable(lateErrors, result.warnings);

  const attachments = new Map(resolved.attachments.map((a) => [a.authoredId, a] as const));
  const now = Date.now();
  const doc = buildDocument({
    payload,
    review,
    refs,
    attachments,
    significance: result.significance,
    createdAt: priorDoc?.createdAt ?? now,
    updatedAt: now,
  });

  // Row then bytes, as bundles and images do: the version and its attachment rows land
  // in one transaction, and the blobs follow. A row without its blob is loud
  // corruption on read; a blob without its row is garbage nothing points at.
  const version = db.transaction(() => {
    const v = createReviewVersion(ws, slug, doc);
    for (const a of resolved.attachments) {
      createAttachment(ws, slug, v, a.mediaType, a.bytes.length, a.alt, a.caption, a.id);
    }
    return v;
  })();
  for (const a of resolved.attachments) {
    await saveAttachment(ws, a.id, a.bytes);
  }

  const stored = getReviewVersion(ws, slug, version)!;
  return json({
    slug,
    version,
    workspace: ws,
    // Reviews are keyed by (workspace, slug) exactly as bundles are, so the URL is
    // workspace-scoped like theirs rather than the bare /r/:slug the data model sketches.
    url: `${config.baseUrl}/${ws}/r/${slug}`,
    versionUrl: `${config.baseUrl}/${ws}/r/${slug}/v/${version}`,
    warnings: result.warnings,
    document: stored.doc,
  });
}
