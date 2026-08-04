// Annotations: the one thing written to a review after it is published.
//
// One route, POST /api/reviews/:slug/annotations, and two callers with two different
// rights on it. A member of the workspace, reading the page in a browser, FILES an
// annotation: a target, an optional quote, a body. The skill, holding an API key,
// ANSWERS an open one: an id, an answer body, and refs resolved exactly the way a
// published document's refs are. Neither may do the other's half. A reader answering
// their own question would make the record of the review a conversation with itself,
// and a key filing as a reader would put words in a human's mouth.
//
// Which half a request is asking for is decided by its body, before any authorisation
// is checked, so the two never race: a body carrying `answer` is an answer and is held
// to the key's rights, and anything else is a filing and is held to the session's.
//
// The privacy gate is read.ts's, unchanged and for the same reason: a review holds
// private source, so a slug in another workspace and a slug nobody published are one
// answer with one set of bytes. Being signed out is a 404 here too, never a 401.

import { config } from "../config";
import { listUserWorkspaces } from "../db";
import { requireApiKey, sessionUser } from "../auth";
import {
  answerAnnotation,
  createAnnotation,
  getAnnotation,
  getReviewVersion,
  resolveReview,
  type ReviewDoc,
} from "./db";
import { refResolver, RefResolveError, type DerivedPr, type DerivedReview } from "./derive";
import { GithubError, type GithubClient } from "./github";
import { GithubRoutingError, githubClientFor } from "./github-app";
import { readableWorkspaces } from "./read";
import { checkRef, type RefPointerInput, type ValidationError } from "./validate";
import { BUDGETS, type Annotation, type AnnotationTargetType, type Ref } from "./types";
import type { FileDiff } from "./diff";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The target types a filing may name, as a runtime set: the union in types.ts is
 *  erased, and this is the only gate on a POSTed target. */
const TARGET_TYPES: readonly AnnotationTargetType[] = [
  "statement",
  "note",
  "group",
  "file",
  "hunk",
  "summary",
];

/** An annotation body is prose a human types in a textarea, so it is measured against
 *  the longest authored prose the document has: a note's body. The same cap covers an
 *  answer, which is prose about prose and has no reason to run longer. A quote is a
 *  selection out of the page rather than something written, so it gets the wider
 *  example cap. Neither is a new number: both are budgets the schema already sets. */
const BODY_MAX = BUDGETS.chars.noteBody;
const QUOTE_MAX = BUDGETS.chars.exampleText;

/** Every soft-404 on this path is this exact response, built from nothing the request
 *  carried. Byte-identical to read.ts's by construction, because a caller who can tell
 *  "no such review" from "not yours" can use the slug as an oracle. */
function softNotFound(): Response {
  return new Response(JSON.stringify({ error: "No such review" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function unprocessable(errors: ValidationError[]): Response {
  return json({ error: "The annotation was not written", errors }, 422);
}

/** A caller who may read this review but is asking for the other half's right. Not a
 *  404: they can already see the review, so hiding the refusal would only leave them
 *  guessing at a rule that is not a secret. */
function forbidden(message: string): Response {
  return json({ error: message }, 403);
}

// ---- the body ----

interface AnnotationBody {
  /** Set when the browser posted a plain form rather than JSON, which is what turns
   *  the answer into a redirect back to the page instead of a JSON document. */
  form: boolean;
  target: { type?: unknown; id?: unknown } | undefined;
  quote: unknown;
  body: unknown;
  id: unknown;
  answer: { body?: unknown; refs?: unknown } | undefined;
}

class BadBody extends Error {}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readBody(req: Request): Promise<AnnotationBody> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("form-urlencoded") || type.includes("multipart/form-data")) {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await req.formData();
    } catch (err) {
      throw new BadBody(`Body is not a form: ${(err as Error).message}`);
    }
    const field = (name: string): string | undefined => {
      const value = form.get(name);
      return typeof value === "string" ? value : undefined;
    };
    // A form files; it never answers. The answer half carries refs, which a flat form
    // has no honest shape for, and the skill posts JSON.
    //
    // The page's select carries one option per target, so its value is the pair
    // `type:id` in one field. The two halves are accepted separately as well, because
    // a target id may itself contain a colon (a hunk id does) and splitting is on the
    // first one only.
    const pair = field("target");
    const cut = pair === undefined ? -1 : pair.indexOf(":");
    return {
      form: true,
      target:
        cut > 0
          ? { type: pair!.slice(0, cut), id: pair!.slice(cut + 1) }
          : { type: field("target_type"), id: field("target_id") },
      quote: field("quote"),
      body: field("body"),
      id: undefined,
      answer: undefined,
    };
  }
  const text = await req.text();
  if (text.trim() === "") throw new BadBody("Empty body; send the annotation as JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BadBody(`Body is not JSON: ${(err as Error).message}`);
  }
  const obj = asObject(parsed);
  if (!obj) throw new BadBody("Body is not a JSON object");
  return {
    form: false,
    target: asObject(obj.target),
    quote: obj.quote,
    body: obj.body,
    id: obj.id,
    answer: asObject(obj.answer),
  };
}

// ---- what a target may name ----

/** The ids of every entity of a given type in this version. A target names something
 *  the reader can actually see, so this is read off the document being annotated
 *  rather than off a list of shapes. */
function targetIds(doc: ReviewDoc, type: AnnotationTargetType): Set<string> {
  switch (type) {
    case "statement":
      return new Set(doc.statements.map((s) => s.id));
    case "note":
      return new Set(doc.notes.map((n) => n.id));
    case "group":
      return new Set(doc.groups.map((g) => g.id));
    case "hunk":
      return new Set(doc.hunks.map((h) => h.id));
    case "file":
      // A file is named by its path, which the review knows only through the hunks it
      // carries: a path no pull request touched is not part of this review.
      return new Set(doc.hunks.map((h) => h.path));
    case "summary":
      // The summary is one thing, so it has one name.
      return new Set(["summary"]);
  }
}

/** A string field that must be there and must fit. Returns the trimmed value, or null
 *  once it has pushed the error that says why not. */
function text(
  errors: ValidationError[],
  field: string,
  value: unknown,
  max: number,
): string | null {
  if (typeof value !== "string") {
    errors.push({ field, rule: "required", message: `${field} is required and must be a string` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    errors.push({ field, rule: "required", message: `${field} is required` });
    return null;
  }
  if (trimmed.length > max) {
    errors.push({
      field,
      rule: "too_long",
      message: `${field} is ${trimmed.length} characters; the cap is ${max}`,
      overage: trimmed.length - max,
    });
    return null;
  }
  return trimmed;
}

// ---- resolving an answer's refs ----

/** The stored document read back as derived facts, so an answer's refs resolve through
 *  the same resolver a publish uses: the same origin rule, the same snippet cache, the
 *  same errors. The files are rebuilt from the document's hunks, which is everything
 *  the resolver reads them for. One thing does not survive the round trip: a renamed
 *  file's previous path is not on a hunk, so a ref pinned to the old path of a file
 *  this review renames resolves as `outside` rather than `in_stack`. That is a mark on
 *  a snippet, not a gate, and no answer is refused for it. */
export function derivedFromDoc(doc: ReviewDoc): DerivedReview {
  const prs: DerivedPr[] = doc.prs.map((pr) => {
    const byPath = new Map<string, FileDiff>();
    for (const h of doc.hunks) {
      if (h.repo !== pr.repo || h.prNumber !== pr.number) continue;
      let file = byPath.get(h.path);
      if (!file) {
        file = {
          path: h.path,
          previousPath: null,
          status: "modified",
          additions: 0,
          deletions: 0,
          hunks: [],
          missing: null,
        };
        byPath.set(h.path, file);
      }
      file.hunks.push(h);
    }
    return {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      baseRef: pr.baseRef,
      headRef: "",
      parent: pr.parent,
      author: pr.author,
      coAuthors: pr.coAuthors,
      body: pr.body,
      files: [...byPath.values()],
    };
  });
  return { kind: doc.kind, prs, skillContext: [] };
}

/** A ref that Overseer could not resolve because GitHub would not answer, rather than
 *  because the pointer was wrong. Same distinction the publish route draws. */
class UpstreamError extends Error {}

async function resolveAnswerRefs(
  client: GithubClient,
  doc: ReviewDoc,
  pointers: RefPointerInput[],
): Promise<{ refs: Ref[]; errors: ValidationError[] }> {
  const resolver = refResolver(client, derivedFromDoc(doc));
  const refs: Ref[] = [];
  const errors: ValidationError[] = [];
  for (const [i, pointer] of pointers.entries()) {
    try {
      refs.push(await resolver.resolve(pointer));
    } catch (err) {
      if (!(err instanceof RefResolveError)) throw err;
      // The publish route's rule, unchanged: a 404 and a client-side refusal are the
      // author's to fix, and anything else GitHub said, or failed to say, is ours.
      // The publish route's other rule, unchanged too: a repository this workspace
      // holds no installation for is our own transport refusing, and travels as itself.
      if (err.cause instanceof GithubRoutingError) throw err.cause;
      const upstreamCause = err.cause !== undefined && !(err.cause instanceof GithubError);
      if (upstreamCause || (err.status !== null && err.status !== 0 && err.status !== 404)) {
        throw new UpstreamError(err.message);
      }
      errors.push({ field: `answer.refs[${i}]`, rule: "ref_unresolved", message: err.message });
    }
  }
  return { refs, errors };
}

// ---- the route ----

/**
 * POST /api/reviews/:slug/annotations.
 *
 * Files an annotation for a member session, or answers an open one for an API key.
 */
export async function handleAnnotation(
  req: Request,
  slug: string,
  wsId: string | null = null,
): Promise<Response> {
  if (!SLUG_RE.test(slug)) return softNotFound();
  // A page is served under one workspace, so a write from it names that workspace.
  // Without it a slug two readable workspaces both hold resolves to whichever
  // published last, and a question filed from one page lands on the other's review.
  const readable = readableWorkspaces(req);
  const ids = wsId === null ? readable : readable.filter((id) => id === wsId);
  const review = ids.length === 0 ? null : resolveReview(ids, slug);
  if (!review) return softNotFound();
  const ws = review.workspace_id;
  const row = getReviewVersion(ws, slug, review.latest_version);
  // A head pointer with no row behind it is corruption, not a miss: publish writes
  // both in one transaction.
  if (!row) {
    throw new Error(`Review ${ws}/${slug} has no version row for version ${review.latest_version}`);
  }

  let body: AnnotationBody;
  try {
    body = await readBody(req);
  } catch (err) {
    if (!(err instanceof BadBody)) throw err;
    return json({ error: err.message }, 400);
  }

  return body.answer !== undefined
    ? answerHere(req, ws, slug, row.doc, body)
    : fileHere(req, ws, slug, review.latest_version, row.doc, body);
}

/** A reader files. The right is membership of the workspace the review is in, held by
 *  a session: an API key is the skill, and the skill does not get to ask itself
 *  questions in a reader's voice. */
function fileHere(
  req: Request,
  ws: string,
  slug: string,
  version: number,
  doc: ReviewDoc,
  body: AnnotationBody,
): Response {
  const user = sessionUser(req);
  const member = user !== null && listUserWorkspaces(user.id).some((w) => w.id === ws);
  if (!member) {
    return forbidden(
      "Filing an annotation is a reader's act, so it takes a signed-in member of this workspace; " +
        "an API key answers open annotations instead.",
    );
  }

  const errors: ValidationError[] = [];
  const rawType = body.target?.type;
  const type = TARGET_TYPES.find((t) => t === rawType);
  if (type === undefined) {
    errors.push({
      field: "target.type",
      rule: "target_type",
      message: `target.type is ${JSON.stringify(rawType ?? null)}; it is one of ${TARGET_TYPES.join(", ")}`,
    });
  }
  const targetId = body.target?.id;
  if (typeof targetId !== "string" || targetId === "") {
    errors.push({ field: "target.id", rule: "required", message: "target.id is required" });
  } else if (type !== undefined && !targetIds(doc, type).has(targetId)) {
    errors.push({
      field: "target.id",
      rule: "target_unknown",
      message: `target names ${type} ${JSON.stringify(targetId)}, which version ${version} of this review does not have`,
    });
  }
  const prose = text(errors, "body", body.body, BODY_MAX);
  // A quote is optional, and an empty one from a form field is an absent one rather
  // than a mistake: a browser posts every field it has, whether or not it was filled.
  let quote: string | null = null;
  if (typeof body.quote === "string" && body.quote.trim() !== "") {
    quote = text(errors, "quote", body.quote, QUOTE_MAX);
  } else if (body.quote !== undefined && body.quote !== null && typeof body.quote !== "string") {
    errors.push({ field: "quote", rule: "required", message: "quote must be a string" });
  }
  if (errors.length > 0) return unprocessable(errors);

  const id = createAnnotation(ws, slug, { type: type!, id: targetId as string }, prose!, version, quote);
  if (body.form) {
    // A plain form gets the page back, not a JSON document. 303 so a reload does not
    // re-post, and the fragment lands the reader on what they just wrote.
    return new Response(null, {
      status: 303,
      // Relative on purpose: the page the form was served from is the page to go back
      // to, whatever host it was reached on.
      headers: { location: `/${ws}/r/${slug}#${id}`, "cache-control": "no-store" },
    });
  }
  return json({ id, slug, workspace: ws, version, status: "open" });
}

/** The skill answers. The right is an API key minted in this review's workspace. */
async function answerHere(
  req: Request,
  ws: string,
  slug: string,
  doc: ReviewDoc,
  body: AnnotationBody,
): Promise<Response> {
  const auth = requireApiKey(req);
  const keyed = !(auth instanceof Response) && auth.workspaceId === ws;
  if (!keyed) {
    return forbidden(
      "Answering an annotation is the skill's act, so it takes an API key for this workspace; " +
        "a reader files annotations instead.",
    );
  }

  const errors: ValidationError[] = [];
  const id = body.id;
  let existing: Annotation | null = null;
  if (typeof id !== "string" || id === "") {
    errors.push({ field: "id", rule: "required", message: "id is required" });
  } else {
    existing = getAnnotation(ws, slug, id);
    if (!existing) {
      errors.push({
        field: "id",
        rule: "annotation_unknown",
        message: `id names ${JSON.stringify(id)}, which is not an annotation on this review`,
      });
    } else if (existing.status === "answered") {
      errors.push({
        field: "id",
        rule: "annotation_answered",
        message: `annotation ${id} is already answered; withdrawing an answer is not this route's job`,
      });
    }
  }
  const prose = text(errors, "answer.body", body.answer?.body, BODY_MAX);

  // Refs are optional and default to none: an answer that cites nothing is still an
  // answer. A present `refs` that is not a list is named rather than dropped.
  const rawRefs = body.answer?.refs;
  let pointers: RefPointerInput[] = [];
  if (rawRefs === undefined || rawRefs === null) {
    pointers = [];
  } else if (!Array.isArray(rawRefs)) {
    errors.push({ field: "answer.refs", rule: "required", message: "answer.refs must be a list" });
  } else {
    pointers = rawRefs as RefPointerInput[];
    // The single-repo rule the publish path applies, read off the document rather than
    // off the payload: this review is about the repo it was published about.
    const homeRepo = doc.prs[0]?.repo ?? null;
    pointers.forEach((p, i) => checkRef(errors, `answer.refs[${i}]`, p, homeRepo));
  }
  if (errors.length > 0) return unprocessable(errors);

  // Only now does anything reach GitHub, and only when there is something to fetch: an
  // answer citing nothing asks the workspace's installations for nothing at all. That
  // is why the client is built here rather than at the top of the route.
  let refs: Ref[] = [];
  if (pointers.length > 0) {
    let refErrors: ValidationError[];
    try {
      ({ refs, errors: refErrors } = await resolveAnswerRefs(githubClientFor(ws), doc, pointers));
    } catch (err) {
      if (err instanceof GithubRoutingError) return json({ error: err.message }, 422);
      if (!(err instanceof UpstreamError)) throw err;
      return json({ error: `Overseer could not read a ref from GitHub: ${err.message}` }, 502);
    }
    if (refErrors.length > 0) return unprocessable(refErrors);
  }

  answerAnnotation(ws, slug, existing!.id, { body: prose!, refs });
  const written = getAnnotation(ws, slug, existing!.id)!;
  return json({ id: written.id, slug, workspace: ws, status: written.status, annotation: written });
}
