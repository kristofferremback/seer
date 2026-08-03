// The GitHub client the test suite runs with by default: one that cannot reach a
// network. Every path that talks to GitHub goes through the injection seam, so
// installing this once at preload turns "a test forgot its fake" from a silent
// outbound request into a named error in the log.
//
// Type-only import on purpose: this module is loaded by preloads that must finish
// setting env before any app module is imported.
import type { GithubClient } from "../src/overseer/github";

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
