import {
  GithubGraphqlPermissionError,
  GithubGraphqlShapeError,
  GithubGraphqlTargetError,
  GithubGraphqlTransportError,
} from "./github-graphql";

export type ProjectionFailureState = "failed" | "refused" | "unknown" | "stale";

export interface ProjectionFailure {
  state: ProjectionFailureState;
  code: string;
  message: string;
  retryAt: number | null;
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600) || "GitHub projection failed.";
}

export function projectionFailure(
  error: unknown,
  attempts: number,
  now = Date.now(),
): ProjectionFailure {
  if (error instanceof GithubGraphqlPermissionError) {
    return { state: "refused", code: error.code, message: safeMessage(error), retryAt: null };
  }
  if (error instanceof GithubGraphqlTargetError) {
    return { state: "stale", code: error.code, message: safeMessage(error), retryAt: null };
  }
  if (error instanceof GithubGraphqlTransportError && error.mayHaveLeftProcess) {
    return { state: "unknown", code: "mutation_unknown", message: safeMessage(error), retryAt: null };
  }
  if (error instanceof GithubGraphqlShapeError) {
    return { state: "failed", code: error.code, message: safeMessage(error), retryAt: null };
  }
  const named = error as { name?: unknown; retryAt?: unknown };
  if (named?.name === "GithubCredentialDeadError") {
    return { state: "refused", code: "credential_dead", message: safeMessage(error), retryAt: null };
  }
  if (named?.name === "GithubRateLimitError") {
    const retryAt = typeof named.retryAt === "number" && Number.isFinite(named.retryAt)
      ? named.retryAt
      : now + Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
    return { state: "failed", code: "rate_limited", message: safeMessage(error), retryAt };
  }
  return {
    state: "failed",
    code: error instanceof GithubGraphqlTransportError ? error.code : "projection_failed",
    message: safeMessage(error),
    retryAt: now + Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1)),
  };
}
