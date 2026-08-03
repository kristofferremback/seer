// The witness skill document, served. Public and unauthenticated, the same shape as
// Seer's own /skill.md: an agent fetches it before it publishes anything.
//
// The bytes are the committed doc, docs/overseer/skill.md, read at request time rather
// than inlined into TypeScript. The document is prose the reader also reads in the repo,
// and one copy cannot drift from the other if there is only one copy.

import { join } from "node:path";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "overseer", "skill.md");

export async function handleOverseerSkill(): Promise<Response> {
  const file = Bun.file(DOC_PATH);
  if (!(await file.exists())) {
    // Loud rather than an empty 200: a deployment missing its own skill doc is broken,
    // and an agent reading a blank page would never find out.
    return new Response("The Overseer skill document is missing from this deployment", {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }
  return new Response(file, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}
