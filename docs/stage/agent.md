# Seer staged walkthrough builder

This document is for the builder or orchestrator. It is not the witness brief.

Fetch the exact deployment's `https://seer.build/stage/skill.md` before using this workflow. Do not copy a skill from another host.

## Capture

Create a source capture with the API key for the target workspace:

```sh
curl -sS -X POST https://seer.build/api/stage-captures \
  -H "Authorization: Bearer $SEER_API_KEY" \
  -H "Idempotency-Key: stage-<unique-request>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "branch-slug",
    "repo": "owner/name",
    "branch": "feature/branch",
    "builder": {
      "intent": "What this change is meant to do",
      "context": "Useful implementation context, or an empty string",
      "agent": {"name": "builder", "model": "model-name"}
    }
  }'
```

The packet is authoritative builder intent. Keep it separate from the witness account. Intent is limited to 1200 characters, context to 4000, and agent name and model to 80 characters each. Intent and context use Seer's constrained markdown. Agent labels are one-line plain text.

Save the returned capture id. A capture is pinned and readable without GitHub after it completes. A new capture needs a new slug until later-version publication lands.

## Dispatch a fresh witness

Start a new sub-agent with no conversation history. Give it, in the dispatch message:

1. the exact deployment URL and the complete copy of that deployment's `/stage/skill.md`;
2. the capture URL `https://seer.build/api/stage-captures/<capture-id>` and capture id;
3. the API key it may use for that workspace;
4. the publication endpoint `https://seer.build/api/stages`;
5. `expectedPreviousVersion: 0` for this slice;
6. any open threads or the prior version only when a later slice supplies them.

The fresh witness must fetch the pinned capture and write the narrative contract. It must not receive the builder conversation or any conversation history. Freshness is a dispatch property, not a fact for the witness to claim.

## Publish

The witness submits the complete document to `/api/stages`. Check the response and retain its pinned human `versionUrl`; `apiVersionUrl` is the same immutable version as JSON. A failed validation means the walkthrough was not published. Retry the same capture only with the same narrative, or make a new capture.

Never author Git facts, capture ids, inventory ids, diff totals, completeness, actor ids, stage ids, or version movement. Seer derives those facts from the capture and authentication.

The complete hosted document is the source of truth for this deployment. Read it again if the route or contract changes.
