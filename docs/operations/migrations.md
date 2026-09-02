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
  'curl -fsS "http://127.0.0.1:$PORT/healthz"'
railway ssh --service "$SERVICE" --environment "$ENVIRONMENT" -- \
  'curl -fsS "http://127.0.0.1:$PORT/openapi.json" | grep -F '"'"'listWitnessRequests'"'"''
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
SERVICE=<exact service name or id>
ENVIRONMENT=<exact environment name or id>
REGION=<the service's only Railway region name or id>
V24_DEPLOYMENT=<verified v24 deployment id>
V23_COMMIT=f3cbb6a5fd5b94485039930fcb2e24caf0beda28
SNAPSHOT=/data/backups/pre-v24.sqlite
```

The service must have exactly one configured region. Stop if it has more. Run
`railway status --json` and `railway deployment list --service "$SERVICE" --environment
"$ENVIRONMENT" --json`; record that the newest deployment is `V24_DEPLOYMENT` from the
expected task-12 commit before changing anything.

1. Verify the snapshot again while v24 still has the volume:

   ```sh
   railway ssh --service "$SERVICE" --environment "$ENVIRONMENT" -- \
     "bun run db:verify -- $SNAPSHOT"
   ```

2. Stop the service and wait until no deployment or restart is running:

   ```sh
   railway scale --service "$SERVICE" --environment "$ENVIRONMENT" "$REGION=0"
   ```

3. Wait 35 seconds. Do not delete heartbeat files. Stage the restore variable without
   triggering a deployment:

   ```sh
   railway variable set --service "$SERVICE" --environment "$ENVIRONMENT" \
     --skip-deploys "SEER_MAINTENANCE_RESTORE=$SNAPSHOT"
   ```

   Read the variables back and require that exact path. A plain `variable set` is unsafe
   here because it deploys immediately.

4. Confirm again that the newest deployment is still `V24_DEPLOYMENT`, then run
   `railway redeploy --service "$SERVICE" --yes` in the exact linked environment. Do not
   use `railway up`, a dashboard start-command override, or a newer deployment. The
   staged variable and the committed `bun run start` select restore-only maintenance;
   task 12's committed replica setting starts exactly one process.

5. Wait for terminal deployment status `SUCCESS`. Require `maintenance restore verified`,
   `user_version=23`, `integrity=ok`, and the quarantine path in its logs. Check from
   inside the container:

   ```sh
   curl -fsS "http://127.0.0.1:$PORT/healthz"
   test "$(curl -sS -o /dev/null -w '%{http_code}' \
     "http://127.0.0.1:$PORT/openapi.json")" = 404
   ```

   Health must print `ok`; the application route must be 404. Railway allows 300 seconds
   for health, and the private rehearsal must have finished in at most 240. A maintenance
   restart must report the same quarantine path.

6. Stop maintenance and wait until it is gone:

   ```sh
   railway scale --service "$SERVICE" --environment "$ENVIRONMENT" "$REGION=0"
   ```

7. Keep `SEER_MAINTENANCE_RESTORE` set. The v23 image does not contain the maintenance
   branch and ignores it, while keeping it prevents any accidental v24 start from opening
   and migrating the restored database.

8. In a clean detached worktree at the recorded commit, verify `git rev-parse HEAD` equals
   `V23_COMMIT`, then deploy that directory to the same service and environment:

   ```sh
   git worktree add /tmp/seer-v23-rollback "$V23_COMMIT"
   test "$(git -C /tmp/seer-v23-rollback rev-parse HEAD)" = "$V23_COMMIT"
   cd /tmp/seer-v23-rollback
   railway up --detach --service "$SERVICE" --environment "$ENVIRONMENT"
   ```

   Poll `railway deployment list --service "$SERVICE" --environment "$ENVIRONMENT"
   --json` until that exact deployment reaches terminal `SUCCESS`. A queued build is not
   success. Do not run v24 again if this deployment fails; fix or retry the v23 deployment.

9. Check `/healthz`, the v23 startup log, one legacy page, one Stage V1 page, and
   representative local or S3 blob reads. Confirm the startup log does not contain a v24
   migration. Only after v23 is healthy, delete the maintenance variable:

   ```sh
   railway variable delete --service "$SERVICE" --environment "$ENVIRONMENT" \
     SEER_MAINTENANCE_RESTORE
   ```

   Variable deletion may deploy. That is safe only now because the newest code is v23.
   Wait for its resulting deployment to reach terminal `SUCCESS` and repeat `/healthz`.

Never remove the maintenance variable while v24 is the newest deployable image. Never
start v23 against `user_version = 24`; `assertDatabaseVersionSupported(23)` refuses it.
Never delete the quarantine or restore-state file during the incident. Remove the clean
rollback worktree only by its exact path after the incident is closed.
