// The two things both the route table and the API table need, in a leaf module so
// neither has to import the other to get them.

import { config } from "./config";

export function json(data: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": contentType },
  });
}

/**
 * CSRF posture: SameSite=Lax session cookie + POST-only mutations, plus this origin
 * check. When an Origin/Referer header is present its host must match BASE_URL's; a
 * cross-site form post is refused. Absent headers pass (native tooling, same-origin
 * navigations that omit them), which is also why an API key posting with a bearer token
 * is unaffected. Deliberately slop-tier.
 */
export function originOk(req: Request): boolean {
  const src = req.headers.get("origin") ?? req.headers.get("referer");
  if (!src) return true;
  try {
    return new URL(src).host === new URL(config.baseUrl).host;
  } catch {
    return false;
  }
}
