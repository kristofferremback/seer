// The GitHub client the test suite runs with by default: one that cannot reach a
// network. Every path that talks to GitHub goes through the injection seam, so
// installing this once at preload turns "a test forgot its fake" from a silent
// outbound request into a named error in the log.
//
// Type-only import on purpose: this module is loaded by preloads that must finish
// setting env before any app module is imported.
import type { GithubClient } from "../src/overseer/github";
import type { GithubClientFactory } from "../src/overseer/github-app";
import type { GithubOAuth } from "../src/overseer/github-oauth";

function refuse(method: string): never {
  throw new Error(
    `[tests] GitHub is offline in tests: ${method} was called with no fake installed. Install one with setGithubClient().`,
  );
}

/** Refuses every call. Nothing here ever opens a socket. */
export function offlineGithubClient(): GithubClient {
  return {
    getPull: () => refuse("getPull"),
    listCommits: () => refuse("listCommits"),
    listFiles: () => refuse("listFiles"),
    listReviewComments: () => refuse("listReviewComments"),
    getFileAtSha: () => refuse("getFileAtSha"),
    getPullDiff: () => refuse("getPullDiff"),
  };
}

/**
 * The successor seam. Once a client is built per workspace, installing one offline
 * *instance* is no longer enough — the factory itself would otherwise route a
 * repository against the real app credentials, and a 404 from routing looks exactly
 * like "not installed", so the call would be silent as well as real.
 */
export function offlineGithubClientFactory(): GithubClientFactory {
  return () => offlineGithubClient();
}

/** The OAuth leg is not a GithubClient, so it needs its own offline default. */
export function offlineGithubOAuth(): GithubOAuth {
  return {
    exchangeCode: () => refuse("exchangeCode"),
    listUserInstallations: () => refuse("listUserInstallations"),
  };
}
