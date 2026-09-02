import {
  pendingGithubViewedCredentials,
  runNextGithubViewedJob,
} from "./github-viewed";
import {
  pendingGithubSubmissionCredentials,
  runNextGithubSubmission,
} from "./github-submissions";

const lanes = new Map<string, Promise<void>>();

async function runLane(credentialId: string): Promise<void> {
  for (;;) {
    if (await runNextGithubViewedJob(credentialId)) continue;
    if (await runNextGithubSubmission(credentialId)) continue;
    return;
  }
}

/** One process-local lane per exact credential. Durable leases make restart and overlap
 * safe; this map keeps Viewed and submission mutations serial inside one process. */
export function scheduleGithubProjectionCredential(credentialId: string): void {
  if (lanes.has(credentialId)) return;
  const running = runLane(credentialId)
    .catch((error) => console.error(`[seer] GitHub projection lane ${credentialId} failed:`, error))
    .finally(() => lanes.delete(credentialId));
  lanes.set(credentialId, running);
}

export function recoverGithubProjectionJobs(now = Date.now()): number {
  const credentials = new Set([
    ...pendingGithubViewedCredentials(now),
    ...pendingGithubSubmissionCredentials(now),
  ]);
  for (const credentialId of credentials) scheduleGithubProjectionCredential(credentialId);
  return credentials.size;
}

let sweep: ReturnType<typeof setInterval> | null = null;

export function startGithubProjectionSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    try { recoverGithubProjectionJobs(); }
    catch (error) { console.error("[seer] GitHub projection sweep failed:", error); }
  }, 120_000);
  (sweep as unknown as { unref?: () => void }).unref?.();
}

export function stopGithubProjectionSweep(): void {
  if (!sweep) return;
  clearInterval(sweep);
  sweep = null;
}
