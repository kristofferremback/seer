// Claiming an installation: the one place Seer acts as a *person* on GitHub.
//
// Seer authenticates people through Google and therefore holds no binding at all
// between a Seer user and a GitHub identity. Everything here exists to establish one
// transiently, because without it the claim proves only that an installation id belongs
// to this App — which is true of every installation in the world. An id is a small
// integer, enumerable and not secret, so "a member of some workspace named an
// installation id" is not evidence of anything.
//
// The flow, and every step of it is load-bearing:
//
//   1. connect   an Origin-checked POST mints a nonce bound to BOTH the workspace and
//                the session user, and redirects to GitHub's user-authorization endpoint
//   2. callback  the nonce must exist, be unused, be unexpired, name a workspace this
//                session's user is a member of, and name this session's user
//   3. exchange  the code for a user access token
//   4. prove     GET /user/installations as that person — the only step that establishes
//                any relationship between the asker and the installation
//   5. record    the proven ids on the claim row, and render the picker
//   6. attach    an Origin-checked POST, re-checking membership and that the chosen id
//                is one the recorded proof names
//   7. drop      the user token, which is never stored anywhere in any form
//
// Two properties are easy to lose and are called out where they happen: the callback
// RENDERS and the POST WRITES (originOk passes when Origin and Referer are both absent,
// which is the normal case for a top-level navigation, so it is no guard at all on a
// redirect GET), and the refusal for an installation somebody else holds never names the
// workspace that holds it.

import { config } from "../config";
import { sessionUser } from "../auth";
import { isMember } from "../db";
import { githubClaimPage, type GithubClaimChoice } from "../pages";
import { GithubError } from "./github";
import { githubOAuth, type UserInstallation } from "./github-oauth";
import {
  attachInstallation,
  burnClaimAttach,
  claimProven,
  claimProvenIds,
  consumeClaim,
  createClaim,
  disconnectInstallation,
  findClaimByAttachToken,
  findClaimByNonce,
  getLiveInstallation,
  updateRepositorySelection,
} from "./installations";
import { reconcileInstallation } from "./webhook";

/** GitHub's user-authorization endpoint. The nonce rides OAuth `state`, which is
 *  specified and reliable — unlike `state` through `/apps/<slug>/installations/new`,
 *  which has been dropped, reported fixed, and reported broken again. */
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** Where GitHub sends the person back. Registered as both the callback URL and the
 *  setup URL of the App, which is why one handler reads `setup_action` too. */
export const CALLBACK_PATH = "/github/setup";

export function installUrl(): string | null {
  const app = config.githubApp;
  return app ? `https://github.com/apps/${app.slug}/installations/new` : null;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8" } });
}

function refusal(wsId: string | null, headline: string, note: string, status = 400): Response {
  return html(
    githubClaimPage({ wsId, headline, note, login: null, claimToken: null, choices: [] }),
    status,
  );
}

/**
 * POST /settings/:ws/github/connect. The caller has already been checked for Origin and
 * membership by the route table; this mints the nonce and hands the browser to GitHub.
 */
export function handleConnectGithub(wsId: string, userId: string): Response {
  const app = config.githubApp;
  if (!app) {
    return refusal(
      wsId,
      "GitHub App is not configured",
      "This deployment has no GITHUB_APP_CLIENT_ID, so there is nothing to authorize against.",
      503,
    );
  }
  const { nonce } = createClaim(wsId, userId);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("state", nonce);
  url.searchParams.set("redirect_uri", `${config.baseUrl}${CALLBACK_PATH}`);
  return new Response(null, { status: 303, headers: { location: url.toString() } });
}

/**
 * GET /github/setup — where GitHub sends the person back.
 *
 * It renders and it does not attach. Every refusal below is the same shape: a page that
 * says what to do next and offers to start again, never a form that takes an id.
 */
export async function handleGithubSetupCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const setupAction = url.searchParams.get("setup_action");

  const user = sessionUser(req);
  if (!user) {
    return refusal(
      null,
      "Sign in first",
      "This page finishes connecting a GitHub account to a Seer workspace, and it has to know who you are. Sign in and start again from workspace settings.",
      403,
    );
  }

  // No state at all is the case GitHub's own install button produces when `state` is
  // dropped in transit. It is an error that says so, and never a form that accepts an
  // installation id — an id proves nothing about who is asking.
  if (!state) {
    return refusal(
      null,
      "This link carried no claim",
      "Start again from workspace settings: the connect button mints a one-time claim that this page needs.",
    );
  }

  const claim = findClaimByNonce(state);
  // Unknown, already-spent and expired are one answer. A forged state and a replayed one
  // must not be told apart, or this route becomes a way to ask which claims exist.
  if (
    !claim ||
    claim.consumed_at !== null ||
    claim.expires_at <= Date.now() ||
    claim.user_id !== user.id ||
    !isMember(claim.workspace_id, user.id)
  ) {
    return refusal(
      null,
      "This claim is not usable",
      "It may have expired, been used already, or belong to someone else. Start again from workspace settings.",
      403,
    );
  }

  // An org member who cannot install has asked an admin to. No installation exists yet,
  // so there is nothing to attach and nothing to pick from.
  if (setupAction === "request") {
    consumeClaim(claim.id, [], null);
    return refusal(
      claim.workspace_id,
      "Your request went to an administrator",
      "GitHub has asked whoever administers that account to install the app. Come back and connect it once they have.",
      200,
    );
  }

  if (!code) {
    return refusal(
      claim.workspace_id,
      "GitHub sent no authorization code",
      "Nothing was connected. Start again from workspace settings.",
    );
  }

  const oauth = githubOAuth();
  let installations: UserInstallation[];
  let login: string | null = null;
  try {
    // Steps 3 and 4. The token exists only inside this block: it is used to ask the one
    // question that binds this person to these installations, and then it is gone.
    const userToken = await oauth.exchangeCode(code);
    installations = await oauth.listUserInstallations(userToken);
  } catch (err) {
    const status = err instanceof GithubError ? err.status : 502;
    return refusal(
      claim.workspace_id,
      "GitHub would not confirm who you are",
      `The authorization could not be completed (${status}). Nothing was connected; start again from workspace settings.`,
      502,
    );
  }

  const proven = installations
    .filter((i) => Number.isInteger(i.id))
    .map((i) => ({
      id: i.id,
      login: i.account?.login ?? `installation ${i.id}`,
      type: i.account?.type ?? "User",
      selection: i.repository_selection ?? "selected",
    }));
  login = proven[0]?.login ?? null;

  // `setup_action=update` is someone changing the repository selection on an
  // installation they already have. Treating it as a fresh claim would tell a user their
  // own installation belongs to their own workspace, so it is recognised: refresh what
  // GitHub now says it covers, and drop the routing cache that says otherwise.
  if (setupAction === "update") {
    consumeClaim(claim.id, proven, login);
    let refreshed = 0;
    for (const installation of installations) {
      const row = getLiveInstallation(installation.id);
      if (!row || row.workspace_id !== claim.workspace_id) continue;
      updateRepositorySelection(installation.id, installation.repository_selection ?? "selected");
      refreshed++;
    }
    return refusal(
      claim.workspace_id,
      refreshed > 0 ? "Repository access updated" : "Nothing to update here",
      refreshed > 0
        ? "Seer has refreshed what that installation covers."
        : "That installation is not connected to this workspace, so there was nothing to refresh.",
      200,
    );
  }

  const consumed = consumeClaim(claim.id, proven, login);
  if (!consumed) {
    // Lost the race against a concurrent callback carrying the same state.
    return refusal(
      claim.workspace_id,
      "This claim is not usable",
      "It may have expired, been used already, or belong to someone else. Start again from workspace settings.",
      403,
    );
  }

  const choices: GithubClaimChoice[] = [];
  for (const installation of installations) {
    const row = getLiveInstallation(installation.id);
    // Held by another workspace: not offered, and not named as such either. The picker
    // simply does not contain it.
    if (row && row.workspace_id !== null && row.workspace_id !== claim.workspace_id) continue;
    choices.push({
      installationId: installation.id,
      account: installation.account?.login ?? `installation ${installation.id}`,
      accountType: installation.account?.type ?? "User",
      repositorySelection: installation.repository_selection ?? "selected",
      held: row?.workspace_id === claim.workspace_id,
    });
  }

  if (choices.length === 0) {
    return html(
      githubClaimPage({
        wsId: claim.workspace_id,
        headline: "Nothing here to connect",
        note:
          "None of the installations you can reach are available to this workspace. If the account you want is already connected somewhere in Seer, ask whoever connected it.",
        login,
        claimToken: null,
        choices: [],
      }),
      200,
    );
  }

  return html(
    githubClaimPage({
      wsId: claim.workspace_id,
      headline: "Choose what to connect",
      note: "These are the installations you can reach on GitHub. Connecting one lets this workspace derive reviews through it.",
      login,
      claimToken: consumed.attachToken,
      choices,
    }),
  );
}

/**
 * POST /github/claim — the write.
 *
 * Everything the callback checked is checked again, because the callback's checks were
 * on a different request: the session user, their membership of the claim's workspace,
 * and — the one that matters — that the chosen id is one the recorded proof names.
 */
export async function handleClaimInstallation(req: Request): Promise<Response> {
  const user = sessionUser(req);
  if (!user) return refusal(null, "Sign in first", "Nothing was connected.", 403);

  const form = await req.formData();
  const token = String(form.get("claim") ?? "");
  const chosen = Number(form.get("installation_id"));

  const claim = token ? findClaimByAttachToken(token) : null;
  if (
    !claim ||
    claim.attached_at !== null ||
    claim.expires_at <= Date.now() ||
    claim.user_id !== user.id ||
    !isMember(claim.workspace_id, user.id)
  ) {
    return refusal(
      null,
      "This claim is not usable",
      "It may have expired, been used already, or belong to someone else. Start again from workspace settings.",
      403,
    );
  }

  // The unheld case, and the whole reason this flow has an OAuth leg: a signed-in member
  // with a valid session, a valid Origin and a real claim, naming an installation id
  // that is simply not theirs. Nothing above catches it; this does.
  if (!Number.isInteger(chosen) || !claimProvenIds(claim).includes(chosen)) {
    return refusal(
      claim.workspace_id,
      "That installation is not yours to connect",
      "GitHub does not list it among the installations you can reach, so nothing was connected.",
      403,
    );
  }

  if (!burnClaimAttach(claim.id)) {
    return refusal(
      claim.workspace_id,
      "This claim is not usable",
      "It may have expired, been used already, or belong to someone else. Start again from workspace settings.",
      403,
    );
  }

  // Re-read from GitHub? No: the proof is the recorded list, and the account facts come
  // off the row we already have or off the payload the caller submitted with it. A
  // second GitHub call here would need the user token to still exist, which is exactly
  // the thing this design refuses to keep.
  const existing = getLiveInstallation(chosen);
  const facts = claimProven(claim, chosen)!;
  const result = attachInstallation({
    wsId: claim.workspace_id,
    userId: user.id,
    installationId: chosen,
    accountLogin: facts.login,
    accountId: existing?.account_id ?? 0,
    accountType: facts.type,
    repositorySelection: facts.selection,
  });

  if (result === "already_claimed") {
    // Deliberately does not say which workspace. Combined with enumerable installation
    // ids, naming it would be a free directory of which Seer workspaces exist.
    return refusal(
      claim.workspace_id,
      "Already connected elsewhere",
      "That installation is already connected to another Seer workspace. Ask whoever connected it.",
      409,
    );
  }

  // A successful claim is one of the three events that mean observations were missed:
  // everything GitHub delivered for this installation before it belonged to a workspace
  // was acknowledged and dropped, because there were no rows to write. Detached — the
  // person is being redirected to settings and has nothing to wait for.
  void reconcileInstallation(chosen, null).catch((err) => {
    console.error(`[seer] reconcile after claim of installation ${chosen} failed: ${String(err)}`);
  });

  return new Response(null, { status: 303, headers: { location: `/settings/${claim.workspace_id}` } });
}

/** POST /settings/:ws/github/:id/disconnect. Origin and membership are the route's. */
export function handleDisconnectGithub(wsId: string, id: string): Response {
  if (!disconnectInstallation(wsId, id)) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 303, headers: { location: `/settings/${wsId}` } });
}
