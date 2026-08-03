// Recorded GitHub payloads and the fake client every Overseer test runs against.
// tests/fixtures/github/pull-*.json were captured with `gh api` from this repo's own
// merged pull requests; degenerate-*.json are hand-crafted for the cases those pull
// requests happen not to contain (rename, deletion, binary, no newline at EOF).
// Nothing here opens a socket.

import { readFileSync } from "node:fs";
import type {
  GithubClient,
  GithubCommit,
  GithubFile,
  GithubPull,
  GithubReviewComment,
} from "../../src/overseer/github";

// Synchronous on purpose: a fixture loader that returned promises would make every
// table-driven test in this directory async for no gain.
const DIR = new URL("../fixtures/github/", import.meta.url).pathname;

const read = (name: string): string => readFileSync(`${DIR}${name}`, "utf8");

function readJson<T>(name: string): T {
  return JSON.parse(read(name)) as T;
}

export function loadPull(n: number): GithubPull {
  return readJson<GithubPull>(`pull-${n}.json`);
}

export function loadFiles(n: number): GithubFile[] {
  return readJson<GithubFile[]>(`pull-${n}-files.json`);
}

export function loadCommits(n: number): GithubCommit[] {
  return readJson<GithubCommit[]>(`pull-${n}-commits.json`);
}

export function loadComments(n: number): GithubReviewComment[] {
  return readJson<GithubReviewComment[]>(`pull-${n}-comments.json`);
}

export function loadDegenerateFiles(): GithubFile[] {
  return readJson<GithubFile[]>("degenerate-files.json");
}

export function degenerateDiff(): string {
  return read("degenerate-diff.txt");
}

export interface FakeGithubOptions {
  pull?: GithubPull;
  commits?: GithubCommit[];
  files?: GithubFile[];
  comments?: GithubReviewComment[];
  diff?: string;
  blobs?: Record<string, string>;
  onDiff?: () => void;
}

/** A GithubClient backed by fixtures. Anything not supplied throws rather than lies. */
export function fakeGithubClient(options: FakeGithubOptions = {}): GithubClient {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`fake github client has no ${what}`);
    return value;
  };
  return {
    async getPull() {
      return need(options.pull, "pull");
    },
    async listCommits() {
      return need(options.commits, "commits");
    },
    async listFiles() {
      return need(options.files, "files");
    },
    async listReviewComments() {
      return need(options.comments, "comments");
    },
    async getFileAtSha(_repo, path, sha) {
      const blobs = need(options.blobs, "blobs");
      return need(blobs[`${sha}:${path}`], `blob ${sha}:${path}`);
    },
    async getPullDiff() {
      options.onDiff?.();
      return need(options.diff, "diff");
    },
  };
}
