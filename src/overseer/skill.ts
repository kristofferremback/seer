// The witness skill document, served. Public and unauthenticated. A fresh agent fetches
// it after receiving one exact member or stack witness claim.
//
// The bytes are the committed doc, docs/overseer/skill.md, read at request time rather
// than inlined into TypeScript. The document is prose the reader also reads in the repo,
// and one copy cannot drift from the other if there is only one copy.

import { join } from "node:path";

import { config } from "../config";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "overseer", "skill.md");
const AGENT_DOC_PATH = join(import.meta.dir, "..", "..", "docs", "overseer", "agent.md");

/** The document as this deployment serves it, or null when it is not on disk. Split out
 *  from serveDoc so the skills discovery index can take a digest over the same bytes:
 *  a digest of the committed file would be wrong on every deployment but the canonical
 *  one, because of the host substitution below. */
async function docText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  // Both documents name a host, and both are read as instructions rather than as prose:
  // the agent document carries a dispatch brief the reader is told to copy exactly, and
  // the witness document names the origin to publish to. So the host in each has to be
  // this deployment's rather than the canonical one the repo copy is written against.
  // A document that is wrong for everyone but one instance is worse than no document.
  return (await file.text()).replaceAll(CANONICAL_BASE, config.baseUrl);
}

async function serveDoc(path: string, what: string): Promise<Response> {
  const text = await docText(path);
  if (text === null) {
    // Loud rather than an empty 200: a deployment missing its own skill doc is broken,
    // and an agent reading a blank page would never find out.
    return new Response(`The Overseer ${what} is missing from this deployment`, {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }
  return new Response(text, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** The witness document's served bytes, for the skills index. */
export function overseerSkillText(): Promise<string | null> {
  return docText(DOC_PATH);
}

/** The dispatch document's served bytes, for the skills index. */
export function overseerAgentText(): Promise<string | null> {
  return docText(AGENT_DOC_PATH);
}

/** The base URL the committed documents are written against. Any other deployment has
 *  its own substituted at serve time. */
const CANONICAL_BASE = "https://seer.build";

/** What the witness is told: claim one immutable request, then publish its account.
 *
 *  Host-substituted like the agent document, because this one now names the origin to
 *  publish to. It did not, and a witness reading it had to infer the host from wherever
 *  it happened to fetch the page — which works right up until someone runs their own
 *  instance and the document sends their review to this one. */
export async function handleOverseerSkill(): Promise<Response> {
  return serveDoc(DOC_PATH, "skill document");
}

/** What a person installs so their agent can ingest exact pushed pull requests and
 *  dispatch one leased witness. Two audiences, two documents. */
export async function handleOverseerAgentSkill(): Promise<Response> {
  return serveDoc(AGENT_DOC_PATH, "agent skill document");
}
