// The witness skill document, served. Public and unauthenticated, the same shape as
// Seer's own /skill.md: an agent fetches it before it publishes anything.
//
// The bytes are the committed doc, docs/overseer/skill.md, read at request time rather
// than inlined into TypeScript. The document is prose the reader also reads in the repo,
// and one copy cannot drift from the other if there is only one copy.

import { join } from "node:path";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "overseer", "skill.md");
const AGENT_DOC_PATH = join(import.meta.dir, "..", "..", "docs", "overseer", "agent.md");

async function serveDoc(path: string, what: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    // Loud rather than an empty 200: a deployment missing its own skill doc is broken,
    // and an agent reading a blank page would never find out.
    return new Response(`The Overseer ${what} is missing from this deployment`, {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }
  return new Response(file, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** What the witness is told: what to write, and how. Fetched at review time. */
export async function handleOverseerSkill(): Promise<Response> {
  return serveDoc(DOC_PATH, "skill document");
}

/** What a person installs so their agent can dispatch a witness at all. Two audiences,
 *  two documents: this one is read once by whoever sets it up, that one is read on every
 *  review by the agent doing it. */
export async function handleOverseerAgentSkill(): Promise<Response> {
  return serveDoc(AGENT_DOC_PATH, "agent skill document");
}
