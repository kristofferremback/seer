import { join } from "node:path";
import { config } from "../config";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "stage", "skill.md");
const AGENT_DOC_PATH = join(import.meta.dir, "..", "..", "docs", "stage", "agent.md");
const CANONICAL_BASE = "https://seer.build";

async function text(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return (await file.text()).replaceAll(CANONICAL_BASE, config.baseUrl);
}

async function serve(path: string, name: string): Promise<Response> {
  const body = await text(path);
  if (body === null) return new Response(`The stage ${name} is missing from this deployment`, { status: 500 });
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" } });
}

export function stageSkillText(): Promise<string | null> { return text(DOC_PATH); }
export function stageAgentText(): Promise<string | null> { return text(AGENT_DOC_PATH); }
export function handleStageSkill(): Promise<Response> { return serve(DOC_PATH, "witness skill document"); }
export function handleStageAgent(): Promise<Response> { return serve(AGENT_DOC_PATH, "builder agent document"); }
