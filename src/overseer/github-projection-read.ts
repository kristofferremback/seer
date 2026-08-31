import { db } from "../db";
import type { StageCaptureInventory } from "../stage/db";
import type { ProjectedLocalThread } from "./conversation-types";
import {
  githubCredentialChoice,
  githubCredentialChoices,
  githubCredentialLabel,
  type GithubCredentialChoice,
} from "./github-projection-credentials";
import {
  countActiveGithubViewedOwnership,
  getGithubProjectionPreference,
  listGithubViewedStatus,
  type GithubViewedStatusView,
} from "./github-viewed";
import {
  getGithubSubmission,
  githubThreadDraft,
  listGithubSubmissions,
  submissionView,
  type GithubSubmissionView,
} from "./github-submissions";
import { getLocalGithubThread, githubThreadProjectionState } from "./github-thread-sync";
import { getLocalThread } from "./thread-db";
import type { ReviewLineageRow, ReviewRevisionRow } from "./revision-db";
import { latestObservation } from "./revision-pr";

export interface ReaderGithubProjection {
  credentials: GithubCredentialChoice[];
  viewed: {
    enabled: boolean;
    credential: string | null;
    credentialLabel: string | null;
    action: string;
    retryAction: string;
    owned: number;
    waitingForRevision: boolean;
    statuses: GithubViewedStatusView[];
  };
  review: {
    action: string | null;
    headSha: string;
    localComment: string;
    submissions: GithubSubmissionView[];
  };
}

export interface ReaderGithubThreadAction {
  mapped: boolean;
  githubState: "open" | "resolved" | null;
  publishAction: string | null;
  replyAction: string | null;
  resolutionAction: string | null;
  retryAction: (submissionId: string) => string;
  credentials: GithubCredentialChoice[];
  submissions: GithubSubmissionView[];
}

export function githubProjectionForReader(input: {
  workspaceId: string;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  userId: string;
  localComment?: string;
}): ReaderGithubProjection | null {
  const relation = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM review_lineage_prs WHERE workspace_id=? AND lineage_id=? AND detached_at IS NULL",
  ).get(input.workspaceId, input.lineage.id);
  if (!relation) return null;
  const credentials = githubCredentialChoices(input.userId);
  const preference = getGithubProjectionPreference(input.workspaceId, input.lineage.id, input.userId);
  const observedHead = latestObservation(input.workspaceId, input.lineage.id)?.head_sha ?? null;
  const current = input.lineage.latest_revision === input.revision.revision &&
    observedHead === input.revision.doc.source.sourceHeadSha;
  const submissions = listGithubSubmissions(input.workspaceId, input.lineage.id, input.userId)
    .filter((row) => row.kind === "approve" || row.kind === "request_changes");
  return {
    credentials,
    viewed: {
      enabled: preference?.viewed_enabled === 1,
      credential: preference ? githubCredentialChoice(input.userId, preference.credential_id) : null,
      credentialLabel: preference ? githubCredentialLabel(input.userId, preference.credential_id) : null,
      action: `/${input.workspaceId}/r/${input.lineage.slug}/github/viewed`,
      retryAction: `/${input.workspaceId}/r/${input.lineage.slug}/github/viewed/retry`,
      owned: countActiveGithubViewedOwnership(input.workspaceId, input.lineage.id, input.userId),
      waitingForRevision: preference?.viewed_enabled === 1 && observedHead !== null && observedHead !== input.revision.doc.source.sourceHeadSha,
      statuses: listGithubViewedStatus(input.workspaceId, input.lineage.id, input.userId),
    },
    review: {
      action: current ? `/${input.workspaceId}/r/${input.lineage.slug}/rev/${input.revision.revision}/github/review` : null,
      headSha: input.revision.doc.source.sourceHeadSha,
      localComment: input.localComment ?? "",
      submissions,
    },
  };
}

export function githubThreadActionsForReader(input: {
  workspaceId: string;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  inventory: StageCaptureInventory;
  userId: string;
  threads: ProjectedLocalThread[];
}): Map<string, ReaderGithubThreadAction> {
  const result = new Map<string, ReaderGithubThreadAction>();
  const credentials = githubCredentialChoices(input.userId);
  const current = input.lineage.latest_revision === input.revision.revision &&
    latestObservation(input.workspaceId, input.lineage.id)?.head_sha === input.revision.doc.source.sourceHeadSha;
  for (const projected of input.threads) {
    const local = getLocalThread(input.workspaceId, projected.id);
    if (!local || local.thread.lineage_id !== input.lineage.id) continue;
    const mapping = getLocalGithubThread(input.workspaceId, projected.id);
    const submissionRows = db.query<{ id: string }, [string, string]>(
      "SELECT id FROM review_github_submissions WHERE workspace_id=? AND local_thread_id=? ORDER BY created_at,id",
    ).all(input.workspaceId, projected.id).flatMap((row) => {
      const submission = getGithubSubmission(row.id);
      return submission ? [submission] : [];
    });
    const rows = submissionRows.map(submissionView);
    const githubState = mapping
      ? githubThreadProjectionState(input.workspaceId, projected.id)?.state ?? projected.githubState ?? "open"
      : null;
    const publishable = current && !mapping && githubThreadDraft(input.workspaceId, input.revision, projected.id, input.inventory).ok;
    result.set(projected.id, {
      mapped: mapping !== null,
      githubState,
      publishAction: publishable ? `/${input.workspaceId}/r/${input.lineage.slug}/threads/${projected.id}/github` : null,
      replyAction: mapping ? `/${input.workspaceId}/r/threads/${projected.id}/messages/github` : null,
      resolutionAction: mapping ? `/${input.workspaceId}/r/threads/${projected.id}/events/github` : null,
      retryAction: (submissionId) => `/${input.workspaceId}/r/${input.lineage.slug}/github/submissions/${submissionId}/retry`,
      credentials,
      submissions: rows,
    });
  }
  return result;
}
