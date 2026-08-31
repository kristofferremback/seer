// The one transaction boundary between authoritative local handling and best-effort
// GitHub Viewed intent. Network work is scheduled only after this function commits.

import { db } from "../db";
import { setRevisionAcknowledgementInTransaction, type AcknowledgementRow } from "./acknowledgements-db";
import { queueCurrentViewedJobs, queuedGithubViewedCredentials } from "./github-viewed";
import { setRevisionChangeReadInTransaction } from "./revision-db";
import type { ReviewItemIdentity } from "./revision-delta";

function schedule(credentialId: string | null): void {
  if (!credentialId) return;
  queueMicrotask(() => {
    void import("./github-projection-worker")
      .then(({ scheduleGithubProjectionCredential }) => scheduleGithubProjectionCredential(credentialId))
      .catch((error) => console.error("[seer] could not schedule GitHub projection:", error));
  });
}

export function writeRevisionReadHandling(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  changeId: string;
  read: boolean;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const credentialIds = db.transaction(() => {
    setRevisionChangeReadInTransaction(
      input.workspaceId,
      input.revisionId,
      input.userId,
      input.changeId,
      input.read,
      now,
    );
    queueCurrentViewedJobs({
      workspaceId: input.workspaceId,
      lineageId: input.lineageId,
      userId: input.userId,
      now,
    });
    return queuedGithubViewedCredentials(input.workspaceId, input.lineageId, input.userId);
  })();
  for (const credentialId of credentialIds) schedule(credentialId);
}

export function writeRevisionAcknowledgementHandling(input: {
  workspaceId: string;
  lineageId: string;
  revisionId: string;
  userId: string;
  item: ReviewItemIdentity;
  acknowledged: boolean;
  now?: number;
}): AcknowledgementRow | null {
  const now = input.now ?? Date.now();
  const result = db.transaction(() => {
    const acknowledgement = setRevisionAcknowledgementInTransaction({ ...input, now });
    queueCurrentViewedJobs({
      workspaceId: input.workspaceId,
      lineageId: input.lineageId,
      userId: input.userId,
      now,
    });
    return { acknowledgement, credentialIds: queuedGithubViewedCredentials(input.workspaceId, input.lineageId, input.userId) };
  })();
  for (const credentialId of result.credentialIds) schedule(credentialId);
  return result.acknowledgement;
}
