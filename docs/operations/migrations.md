# Database migration recovery

Seer keeps one SQLite database at `$DATA_DIR/seer.db`. A newer image may advance
`PRAGMA user_version`. An older image refuses a version it does not know, so selecting the
old image is not a database rollback. Restore the pre-deploy snapshot before starting it.

Normal operation remains one replica with the committed `bun run start` command in
`railway.toml`. Do not mount this SQLite volume into two application replicas.

## Snapshot commands

The snapshot program imports neither application configuration nor GitHub code. It reads
only `DATA_DIR` and the supplied snapshot path.

```sh
bun run db:backup -- /data/backups/pre-v24.sqlite
bun run db:verify -- /data/backups/pre-v24.sqlite
bun run db:restore -- /data/backups/pre-v24.sqlite --confirm-service-stopped
```

Backup refuses an existing destination. It runs SQLite `quick_check`, serializes one
consistent read transaction while WAL writers continue, writes the database and its
`.json` SHA-256 manifest as mode 0600 temp files, fsyncs them, and renames them into
place. Verify checks the manifest length and hash, opens the snapshot read-only, runs
`quick_check`, and removes any SQLite `-wal` or `-shm` files created by inspection.
Verification leaves the snapshot directory unchanged.

The confirmation flag does not prove that the service stopped. Every normal `bun run
start` process writes its own owner heartbeat under
`$DATA_DIR/.seer-service-heartbeats/` every five seconds. Restore refuses if any marker is
30 seconds old or newer, even when `--confirm-service-stopped` is present. Multiple marker
files are expected during a normal rolling handoff. A graceful stop removes its own
marker. A later normal start reaps valid or malformed Seer marker names only after a full
day without a beat. Restore fails closed on a malformed marker written within the last
30 seconds and ignores an older malformed file, which cannot come from the atomic active
writer. Operators never need to delete one during rollback.

## Blob limits

The snapshot contains SQLite only. It does not copy these local directories when they
exist under `DATA_DIR`:

- `zips/`
- `images/`
- `review-attachments/`
- `stage-blobs/`

It does not inspect, copy, or restore S3. Task 12 changes no blob names and deletes no
blobs. Rolling the database back can leave newer immutable blobs unreferenced, which is
safe. It cannot recover a local or S3 object deleted after the snapshot, and a successful
`db:verify` says nothing about blob availability. Preserve the configured blob store
separately and check representative legacy, Stage, revision, and stack objects before a
rollback is declared complete. Do not change local versus S3 configuration as part of the
database restore.

Restore moves only `seer.db`, `seer.db-wal`, and `seer.db-shm` into one
`restore-quarantine-*` directory. It then installs the verified snapshot through a mode
0600 temp file, fsyncs it, reopens it, and checks its exact bytes and `user_version`.
Nothing deletes the quarantine.

`$DATA_DIR/.seer-restore-state.json` records `prepared` before the first rename and
`completed` after verification. If the maintenance container restarts, the same snapshot
resumes a prepared operation or verifies the completed one without creating another
quarantine. If the live database changed after completion, rerunning that operation is
refused. Archive the state file only after the incident is closed and before a distinct
future restore.

## Pre-deploy snapshot

Run backup while the v23 service has one replica and the volume mounted:

```sh
railway ssh --service "$SERVICE" --environment "$ENVIRONMENT" -- \
  "bun run db:backup -- /data/backups/pre-v24.sqlite"
railway ssh --service "$SERVICE" --environment "$ENVIRONMENT" -- \
  "bun run db:verify -- /data/backups/pre-v24.sqlite"
```

Record the printed path, `user_version=23`, and `integrity=ok` in the rollout evidence.
Do not deploy v24 if either command fails. Also record that the local blob directories or
S3 bucket expected by the old image remain available. Never record keys, cookies,
credential ids, source bodies, or private repository content.

## Private v24 proof

Use a private environment with one replica, its own volume snapshot, and no public domain.
Deploy the v24 image there. Do not point a v23 image at the migrated volume. The committed
healthcheck timeout is 300 seconds because restore verifies and copies the complete SQLite
file before binding `/healthz`.

Check startup and health:

```sh
railway logs --service "$SERVICE" --environment "$ENVIRONMENT" --lines 200 --json
railway ssh --service "$SERVICE" --environment "$ENVIRONMENT" -- \
  'bun -e "const base=\"http://127.0.0.1:\"+process.env.PORT;
    const health=await fetch(base+\"/healthz\"); const body=await health.text();
    if(health.status!==200||body!==\"ok\")process.exit(1); console.log(body);
    const spec=await fetch(base+\"/openapi.json\");
    if(spec.status!==200||!(await spec.text()).includes(\"listWitnessRequests\"))process.exit(1)"'
```

Require the v24 migration log once, `ok` from health, and the OpenAPI operation. Measure
snapshot verification and one restore against a disposable copy of this environment's
current database. Each must finish within 240 seconds, leaving 60 seconds of platform
margin. Do not roll out while either exceeds that bound.

Then run one private same-repository pull request through the hosted contract:

```sh
curl -sS -X POST "$BASE_URL/api/pull-request-review-lineages" \
  -H "Authorization: Bearer $SEER_API_KEY" \
  -H "Idempotency-Key: rollout-v24-private-pr" \
  -H "Content-Type: application/json" \
  -d "{\"repo\":\"$PRIVATE_REPO\",\"number\":$PRIVATE_PR,\"slug\":\"v24-private-proof\"}"
```

Poll the returned capture job. When it names a revision, read that exact revision API view
and use its `witness.claimUrl`. Dispatch a fresh witness, publish its account, then reload
the latest and pinned revision URLs. Inventory is only a diagnostic if the original
response was lost.

Also prove these compatibility paths:

1. Publish the committed StageDoc V1 fixture and reload its latest and pinned URLs.
2. Read one legacy page and `GET /api/reviews/<legacy-slug>`.
3. Confirm a new `POST /api/reviews` returns rule `legacy_creation_retired`, while an
   existing legacy slug republishes its next version with `prs` present.
4. Confirm a stack slug matching a review slug is refused.
5. Create a stack, use the returned manifest witness `claimUrl`, and reload its latest and
   pinned manifest URLs.
6. Read representative local or S3 blobs through each preserved reader.

## Roll forward

If v24 behavior fails while SQLite integrity and v24 rows are sound, fix v24 and deploy the
fix. This is the default recovery. Keep one replica and repeat the private proof. The
normal start command, health path, replica count, and rolling behavior do not change.

## Restore and roll back

Use this only when the v24 database must be abandoned. Rehearse these exact commands in
the private environment first, including the transition back to the exact v23 commit.
The production rollback is blocked until that rehearsal completes in 240 seconds or less.

Set these shell values from the Railway service and the recorded rollout evidence:

```sh
REPOSITORY="/absolute/path/to/a/clean/seer-repository"
PROJECT="exact Railway project id"
SERVICE="exact Railway service id"
ENVIRONMENT="exact Railway environment id"
REGION="Railway CLI alias for the only region, for example eu-west"
V24_DEPLOYMENT="verified v24 deployment id"
V23_COMMIT=b0c136cd870935d31afc42f1cef67b21000b9d85
SNAPSHOT=/data/backups/pre-v24.sqlite
ROLLOUT_EVIDENCE="/durable/operator-only/rollout.log"
umask 077
set -euo pipefail
```

Replace every example value before enabling `set -euo pipefail`, then run the complete
sequence in that same shell. Use a dedicated operator directory so commands that require Railway's linked context
cannot inherit another service:

```sh
mkdir -p /tmp/seer-railway-rollback-control
cd /tmp/seer-railway-rollback-control
railway link --project "$PROJECT" --environment "$ENVIRONMENT" \
  --service "$SERVICE" --json > /tmp/seer-rollback-link.json
```

Require the returned project, environment, and service ids to equal the recorded values.
Create the evidence file before any deployment mutation:

```sh
mkdir -p "$(dirname "$ROLLOUT_EVIDENCE")"
touch "$ROLLOUT_EVIDENCE"
chmod 600 "$ROLLOUT_EVIDENCE"
test -w "$ROLLOUT_EVIDENCE"
```

The service must have exactly one configured region. Stop if it has more. Railway's
service manifest may expose an infrastructure key such as `europe-west4-drams3a`, while
`railway scale` accepts the stable aliases printed by `railway scale --help`, such as
`eu-west`. Set `REGION` to that alias and stop if the mapping is ambiguous. Run `railway
status --project "$PROJECT" --environment "$ENVIRONMENT" --json` and `railway deployment
list --project "$PROJECT" --service "$SERVICE" --environment "$ENVIRONMENT" --json`;
record that the newest deployment is `V24_DEPLOYMENT` from the expected task-12 commit
before changing anything.

1. Verify the snapshot again while v24 still has the volume:

   ```sh
   railway ssh --project "$PROJECT" --service "$SERVICE" \
     --environment "$ENVIRONMENT" -- "bun run db:verify -- $SNAPSHOT"
   ```

2. Stop the service and wait until status reports no running instance:

   ```sh
   cd /tmp/seer-railway-rollback-control
   test "$(jq -r '.projectId' /tmp/seer-rollback-link.json)" = "$PROJECT"
   test "$(jq -r '.environmentId' /tmp/seer-rollback-link.json)" = "$ENVIRONMENT"
   test "$(jq -r '.serviceId' /tmp/seer-rollback-link.json)" = "$SERVICE"
   railway scale --service "$SERVICE" --environment "$ENVIRONMENT" "$REGION=0" --json \
     | tee /tmp/seer-rollback-scale.json
   test "$(jq '.regions | length' /tmp/seer-rollback-scale.json)" = 1
   test "$(jq '[.regions[] | select(. != null)] | length' \
     /tmp/seer-rollback-scale.json)" = 0
   deadline=$((SECONDS + 120))
   while :; do
     railway status --project "$PROJECT" --environment "$ENVIRONMENT" --json \
       > /tmp/seer-rollback-status.json
     test "$(jq --arg service "$SERVICE" --arg environment "$ENVIRONMENT" \
       '[.environments.edges[].node | select(.id == $environment) |
         .serviceInstances.edges[].node | select(.serviceId == $service)] | length' \
       /tmp/seer-rollback-status.json)" = 1
     live=$(jq --arg service "$SERVICE" --arg environment "$ENVIRONMENT" \
       '[.environments.edges[].node | select(.id == $environment) |
         .serviceInstances.edges[].node | select(.serviceId == $service) |
         .activeDeployments[].instances[] |
         select(.status == "CREATED" or .status == "INITIALIZING" or
           .status == "RESTARTING" or .status == "RUNNING")] | length' \
       /tmp/seer-rollback-status.json)
     railway deployment list --project "$PROJECT" --service "$SERVICE" \
       --environment "$ENVIRONMENT" --json > /tmp/seer-rollback-deployments.json
     moving=$(jq '[.[] | select(.status == "QUEUED" or .status == "INITIALIZING" or
       .status == "WAITING" or .status == "BUILDING" or .status == "DEPLOYING")] |
       length' /tmp/seer-rollback-deployments.json)
     test "$live" != 0 || test "$moving" != 0 || break
     test "$SECONDS" -lt "$deadline" || { echo "service did not stop" >&2; exit 1; }
     sleep 5
   done
   ```

   Require the returned internal region to have zero replicas. Stop if Railway introduces
   another region, starts a replacement, or leaves a deployment in progress.

3. Wait 35 seconds. Do not delete heartbeat files. Stage the restore variable without
   triggering a deployment:

   ```sh
   sleep 35
   railway variable set --project "$PROJECT" --service "$SERVICE" \
     --environment "$ENVIRONMENT" --skip-deploys \
     "SEER_MAINTENANCE_RESTORE=$SNAPSHOT"
   railway variable list --project "$PROJECT" --service "$SERVICE" \
     --environment "$ENVIRONMENT" --json \
     | jq -e --arg path "$SNAPSHOT" '.SEER_MAINTENANCE_RESTORE == $path'
   ```

   Require the read-back to succeed. A plain `variable set` is unsafe here because it
   deploys immediately.

4. Redeploy the recorded v24 artifact by id. Scaling may mark it removed or create a
   source deployment, so `railway redeploy` is unsafe because it only addresses whatever
   is newest. Query the recorded deployment first and require `canRedeploy: true`, then
   use Railway's public GraphQL operation and record the returned id:

   ```sh
   railway api 'query($id:String!){deployment(id:$id){id status canRedeploy}}' \
     --raw-var "id=$V24_DEPLOYMENT" --compact > /tmp/seer-v24-state.json
   test "$(jq -r '.data.deployment.canRedeploy' /tmp/seer-v24-state.json)" = true
   railway api 'mutation($id:String!){deploymentRedeploy(id:$id){id status}}' \
     --raw-var "id=$V24_DEPLOYMENT" --compact \
     | tee /tmp/seer-maintenance-deployment.json
   MAINTENANCE_DEPLOYMENT=$(jq -er '.data.deploymentRedeploy.id' \
     /tmp/seer-maintenance-deployment.json)
   printf 'maintenance_deployment=%s\n' "$MAINTENANCE_DEPLOYMENT" \
     >> "$ROLLOUT_EVIDENCE"
   cat /tmp/seer-maintenance-deployment.json >> "$ROLLOUT_EVIDENCE"
   ```

   Do not use `railway up`, a dashboard start-command override,
   `serviceInstanceRedeploy`, or the CLI's latest-deployment redeploy. Railway's current
   environment variables apply to an exact artifact redeploy; the private rehearsal must
   prove this before production. The staged variable selects restore-only maintenance,
   and the recorded artifact's committed replica setting starts one process. If the next
   step sees normal application routes or anything other than one running instance,
   remove that attempted deployment and stop.

5. Poll that exact id with `railway api`, not the service's newest deployment. Require
   terminal status `SUCCESS`, exactly one successful instance, and record its id:

   ```sh
   deadline=$((SECONDS + 240))
   while :; do
     railway api \
       'query($id:String!){deployment(id:$id){id status deploymentStopped instances{id status}}}' \
       --raw-var "id=$MAINTENANCE_DEPLOYMENT" --compact \
       > /tmp/seer-maintenance-state.json
     status=$(jq -r '.data.deployment.status' /tmp/seer-maintenance-state.json)
     case "$status" in
       SUCCESS) break ;;
       FAILED|CRASHED|REMOVED|NEEDS_APPROVAL) echo "$status" >&2; exit 1 ;;
     esac
     test "$SECONDS" -lt "$deadline" || { echo "maintenance timed out" >&2; exit 1; }
     sleep 5
   done
   test "$(jq -r '.data.deployment.deploymentStopped' \
     /tmp/seer-maintenance-state.json)" = false
   test "$(jq '[.data.deployment.instances[] |
     select(.status == "CREATED" or .status == "INITIALIZING" or
       .status == "RESTARTING" or .status == "RUNNING")] | length' \
     /tmp/seer-maintenance-state.json)" = 1
   test "$(jq '[.data.deployment.instances[] | select(.status == "RUNNING")] | length' \
     /tmp/seer-maintenance-state.json)" = 1
   MAINTENANCE_INSTANCE=$(jq -er \
     '.data.deployment.instances[] | select(.status == "RUNNING") | .id' \
     /tmp/seer-maintenance-state.json)
   printf 'maintenance_instance=%s\n' "$MAINTENANCE_INSTANCE" >> "$ROLLOUT_EVIDENCE"
   ```

   Require `maintenance restore verified`, `user_version=23`, `integrity=ok`, and the
   quarantine path in that deployment's exact logs. Then check the exact instance from
   inside the container:

   ```sh
   railway logs "$MAINTENANCE_DEPLOYMENT" --deployment --project "$PROJECT" \
     --service "$SERVICE" --environment "$ENVIRONMENT" --lines 200 --json \
     | jq -r '.message // .' > /tmp/seer-maintenance.log
   grep -Fq 'maintenance restore verified:' /tmp/seer-maintenance.log
   grep -Fq 'user_version=23' /tmp/seer-maintenance.log
   grep -Fq 'integrity=ok' /tmp/seer-maintenance.log
   grep -Fq 'quarantine=' /tmp/seer-maintenance.log
   railway ssh --project "$PROJECT" --service "$SERVICE" \
     --environment "$ENVIRONMENT" --deployment-instance "$MAINTENANCE_INSTANCE" -- \
     'bun -e "const base=\"http://127.0.0.1:\"+process.env.PORT;
       const health=await fetch(base+\"/healthz\"); const body=await health.text();
       if(health.status!==200||body!==\"ok\")process.exit(1); console.log(body);
       if((await fetch(base+\"/openapi.json\")).status!==404)process.exit(1)"'
   ```

   Health must print `ok`; the application route must be 404. Railway allows 300 seconds
   for health, and the private rehearsal must have finished in at most 240. A maintenance
   restart must report the same quarantine path.

6. Stop that exact maintenance deployment and wait until status reports no running
   instance. Removing by id avoids starting the repository's configured source revision:

   ```sh
   railway api 'mutation($id:String!){deploymentRemove(id:$id)}' \
     --raw-var "id=$MAINTENANCE_DEPLOYMENT" --compact
   deadline=$((SECONDS + 120))
   while :; do
     railway api 'query($id:String!){deployment(id:$id){id status instances{id status}}}' \
       --raw-var "id=$MAINTENANCE_DEPLOYMENT" --compact \
       > /tmp/seer-maintenance-removed.json
     status=$(jq -r '.data.deployment.status' /tmp/seer-maintenance-removed.json)
     test "$status" != REMOVED || break
     test "$SECONDS" -lt "$deadline" || { echo "maintenance did not stop" >&2; exit 1; }
     sleep 5
   done
   test "$(jq '[((.data.deployment.instances // [])[]) |
     select(.status == "CREATED" or .status == "INITIALIZING" or
       .status == "RESTARTING" or .status == "RUNNING")] | length' \
     /tmp/seer-maintenance-removed.json)" = 0
   ```

   If the shell is interrupted after step 4, recover the maintenance id from `railway
   deployment list --project "$PROJECT" --service "$SERVICE" --environment
   "$ENVIRONMENT" --json`. Match the rollout time and the v24 image digest, then record
   the recovered id before continuing.

7. Keep `SEER_MAINTENANCE_RESTORE` set. The v23 image does not contain the maintenance
   branch and ignores it, while keeping it prevents any accidental v24 start from opening
   and migrating the restored database.

8. In a clean detached worktree at the recorded commit, verify `git rev-parse HEAD` equals
   `V23_COMMIT`, then deploy that directory to the same service and environment:

   ```sh
   ROLLBACK_WORKTREE="/tmp/seer-v23-rollback.$(date +%s).$$"
   test ! -e "$ROLLBACK_WORKTREE"
   git -C "$REPOSITORY" worktree add --detach "$ROLLBACK_WORKTREE" "$V23_COMMIT"
   test "$(git -C "$ROLLBACK_WORKTREE" rev-parse HEAD)" = "$V23_COMMIT"
   cd "$ROLLBACK_WORKTREE"
   railway status --project "$PROJECT" --environment "$ENVIRONMENT" --json \
     > /tmp/seer-v23-target.json
   test "$(jq --arg service "$SERVICE" --arg environment "$ENVIRONMENT" \
     '[.environments.edges[].node | select(.id == $environment) |
       .serviceInstances.edges[].node | select(.serviceId == $service)] | length' \
     /tmp/seer-v23-target.json)" = 1
   railway up --detach --json --project "$PROJECT" --service "$SERVICE" \
     --environment "$ENVIRONMENT" -m "Restore exact Seer v23" \
     | tee /tmp/seer-v23-deployment.json
   cat /tmp/seer-v23-deployment.json >> "$ROLLOUT_EVIDENCE"
   V23_DEPLOYMENT=$(jq -er '.deploymentId' /tmp/seer-v23-deployment.json)
   printf 'v23_deployment=%s\n' "$V23_DEPLOYMENT" >> "$ROLLOUT_EVIDENCE"
   ```

   Poll that exact deployment to terminal `SUCCESS`:

   ```sh
   deadline=$((SECONDS + 240))
   while :; do
     railway deployment list --project "$PROJECT" --service "$SERVICE" \
       --environment "$ENVIRONMENT" --json > /tmp/seer-v23-deployments.json
     status=$(jq -r --arg id "$V23_DEPLOYMENT" \
       '.[] | select(.id == $id) | .status' /tmp/seer-v23-deployments.json)
     case "$status" in
       SUCCESS) break ;;
       FAILED|CRASHED|REMOVED|NEEDS_APPROVAL) echo "$status" >&2; exit 1 ;;
     esac
     test "$SECONDS" -lt "$deadline" || { echo "v23 deploy timed out" >&2; exit 1; }
     sleep 5
   done
   ```

   A queued build is not success. Do not run v24 again if this deployment fails; fix or
   retry the v23 deployment.

9. Check `/healthz`, the v23 startup log, one legacy page, one Stage V1 page, and
   representative local or S3 blob reads. Confirm the startup log does not contain a v24
   migration. Keep `SEER_MAINTENANCE_RESTORE` set throughout the rollback. Deleting a
   variable can deploy the repository's configured source, which still points at v24 even
   after a local v23 upload.

Remove the maintenance variable only as part of a separately approved roll-forward after
`main` points at a corrected v24 revision. Treat the variable-triggered deployment as that
v24 rollout and monitor it to terminal `SUCCESS` before declaring recovery complete.

Never remove the maintenance variable while a broken v24 is the configured source. Never
start v23 against `user_version = 24`; `assertDatabaseVersionSupported(23)` refuses it.
Never delete the quarantine or restore-state file during the incident. After the incident
or rehearsal is closed, remove only the recorded `ROLLBACK_WORKTREE` with `git -C
"$REPOSITORY" worktree remove "$ROLLBACK_WORKTREE"`.
