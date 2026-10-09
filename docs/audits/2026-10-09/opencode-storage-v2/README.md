# OpenCode Storage on native v2

Settings → About → Data & Storage → OpenCode Storage said "The OpenCode
database layout is not the one DevRyan knows; maintenance stays off." for every
native OpenCode v2 runtime (2.0.24 and 2.0.26 alike). This records the facts
established on 2026-10-09, the decision, and the verification. Nothing was
committed or released.

## Which database the route inspects

`GET /api/storage/opencode-db` → `createOpenCodeDbMaintenance().inspect()` →
`resolveOpenCodeDatabaseSelection`.

- The only runtime-selection writer is `packages/web/server/application.js`
  (once at server boot, `ownerPid: process.pid`, generation 2, kind `host`).
  It records `databasePath = descriptor.launch.opencodeDatabasePath`, which
  `runtime-bundle-binding.js` pins to `<bundleRoot>/opencode/opencode.db`.
- The selection file lives in `OPENCHAMBER_DATA_DIR`, which the bundle binding
  rewrites to `<bundleRoot>/web-data` before the server module loads; the
  maintenance facade reads the same directory.
- Web (`bun run dev`, `serve`, QA isolated host), Electron (server in-process)
  and the launchd runtime service each write the selection and serve the route
  in the same process, so the pid check passes and `dbSource` is `selection`.
- The suspected stale `<XDG data>/opencode/opencode.db` is only the
  `legacy-newest` fallback (no selection, a malformed one, or another pid), and
  that fallback is read-only.

So the route inspected the right file. The notice came from how a recognised v2
database was reported.

## Why the notice appeared

Real native databases (`.cache/v2-validation/*/bundles/bundles/*/opencode/opencode.db`,
opened read-only) have `kv` (with `migration.v1-v2`), `session_v2`,
`session_message`, `event`, `event_sequence`, the legacy `session` table and
both migration journals, and no `session_context_epoch`. The core already
detected generation 2 (`kv`) and returned `schema: 'unknown'`,
`error: 'v2_database'`; the UI shows the unknown-layout text for any
`schema !== 'ok'`.

## Is v1 maintenance safe on v2? No.

Readers and writers of `event` / `event_sequence` in the pinned
`@opencode/core` 2.0.26 dist (`node_modules/.bun/@opencode+core@2.0.26+*/…/dist`;
2.0.20 has the same tables and columns):

| Finding | Evidence |
| --- | --- |
| Projections (`session_v2`, `session_message`, …) are written by projectors inside the publish transaction; nothing replays `event` to rebuild them. | `chunks/location-services-g93vh8n3.js` publish path; session projector chunk |
| `event` rows are inserted only `if (persist)`; `persist` defaults to `false`. `event_sequence` is upserted on every publish. | `location-services-g93vh8n3.js` (`options?.persist ?? false`) |
| DevRyan's native host runs with `events: { persist: false }`. | `runtime-host/bootstrap.ts`, `runtime-host/writer-worker.ts` |
| `Session.remove` → `bus.remove` deletes the session's `event_sequence` and `event` rows. | `location-services-g93vh8n3.js` (`delete(EventSequenceTable…)`, `delete(EventTable…)`) |
| `session_message.seq` is the event seq, with a unique `(session_id, seq)` index. | session table chunk |
| v2 never writes the legacy `session` table (only the v1 importer reads it). | session table chunk, `database/v1-migration.bun.js` |
| DevRyan stores recovered-input cancellation receipts as `event` rows under `ses_<id>:recovered-input-cancellation`. | `runtime-host/native-input-cancellation-receipt.ts`, `native-input-cancellation.js` |

Consequences for the three v1 operations:

- **Orphan purge (unsafe).** It keys on the legacy `session` table, so on a
  native database every live session's `event_sequence` row (and every
  receipt) counts as orphaned. Deleting a sequence makes the next publish reuse
  a seq that `session_message` already holds; the unique-index failure ends the
  session. Losing receipts fails recovered-input cancellation.
- **Idle prune (nothing to do).** With `persist: false` there are no native
  event rows to trim; the test databases hold 0–3 `event` rows, all receipts.
- **VACUUM gate (blind).** `listOtherOpenCodeProcessesDefault` looks for
  `opencode` processes; the v2 host runs inside the DevRyan process.

Decision: option (b), an honest status. v2 maintenance is not provably safe,
and on the main host there is nothing for it to reclaim.

## Change

- `db-maintenance-core.js`: a database with `kv` is reported as `v2_database`
  only when it also matches the native v2 profile (`kv`, `session_v2`,
  `session_message`, `event`, `event_sequence`); otherwise
  `schema: 'mismatch'`. Mutation paths are unchanged: any `kv` database is
  skipped before a read-write open, and mutations still need runtime
  generation 1.
- `db-maintenance-routes.js`: a non-dry Compact answers
  `409 maintenance_not_applicable` (with the inspection `reason`) unless the
  database is positively v1 with a matching schema; it never schedules or
  restarts in that case, so `compactionPending` cannot stick.
- `OpenCodeStorageSettings.tsx`: a native v2 database shows its size and
  "Cleanup is not needed …", with Dry Run and Compact Now disabled; Compact Now
  additionally requires generation 1. Unknown layouts keep the fail-closed
  notice.

## Verification

Load averages were 2.6–57 during the runs (other projects on this machine).

- Targeted suites: `db-maintenance.test.js` + `db-maintenance-routes.test.js`
  (vitest, 50 passed); `OpenCodeStorageSettings.test.tsx` + `controlCopy.test.ts`
  (bun test, 14 passed). New cases: native v2 detection, inspection
  (`v2_database`, read-only open only), a bare `kv` table failing closed as
  `schema_mismatch`, a forced generation-1 run leaving every live
  `event_sequence` row and the receipt untouched, the facade over a recorded
  generation-2 selection, the v2 GET response, the Compact `409`, and the v2
  view with both actions disabled.
- `DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full`: lint, type-check
  and docs passed; tests 6,539 passed, 1 failed:
  `server/lib/agent-browser/install.test.js` "shares concurrent install work
  through one singleflight" (`vi.waitFor` timeout, load average ≈ 57). That
  file is unrelated to this change and passed 3/3 when rerun alone.
- `bun run build`: passed. `bun run bundle:check`: `PASS bundle budgets`
  (web-main gzip 1,440,721 / 1,456,388).
- Isolated native host: fresh artifact from
  `bun scripts/build-native-runtime.mjs --output-root .cache/v2-validation/storage-v2-artifact`,
  profile from `scripts/qa/native-profile-factory-diagnostic.mjs` (status
  `passed`, artifacts kept), its `isolated-host.mjs` relaunched with the
  profile's own launch environment (`DEVRYAN_QA_RUNTIME=web`), and the
  profile's `workspace` selected through that host's settings API. Never the
  installed app, its data, or the user's runtime.
  - `GET /api/storage/opencode-db` (sanitized):

    ```json
    {
      "exists": true, "dbSource": "selection", "runtimeGeneration": 2,
      "generation": 2, "schema": "unknown", "error": "v2_database",
      "dbBytes": 339968, "walBytes": 4152, "eventRows": 0, "orphanEventRows": 0,
      "managedRuntime": true, "compactionPending": false, "running": false,
      "lastRun": null, "lastDryRun": null,
      "dbPath": "<QA_RUN>/runtime/native-bundles/bundles/candidate/opencode/opencode.db"
    }
    ```

  - `POST /api/storage/opencode-db/compact` `{}` →
    `409 {"code":"maintenance_not_applicable","reason":"v2_database"}`;
    `compactionPending` stayed `false`, no restart.
  - About → OpenCode Storage: "Database 332.0 KiB (+ 4.1 KiB WAL) · OpenCode 2
    layout" and the not-needed explanation; Dry Run and Compact Now
    `disabled` (`about-storage-native-v2-desktop.jpg`,
    `about-storage-native-v2-compact.jpg` at 375 px). The storage requests
    returned 200; the console errors on that page came from the first load
    against the unregistered bundle home, before the workspace was selected.
- Cleanup: the host and its native controller exited; the kept QA run and the
  artifact directory were deleted after the screenshots were copied here.
- Not run: Electron runtime-service visual check (same route and process
  model, covered by the source trace above).

## Follow-ups (not changed here)

- Resolved the same day (see below): `lifecycle.js` never called the
  `beforeManagedSpawn` hook that `application.js` passed, so the pre-launch
  pass and the forced-compaction hand-off (`consumeForced`) never ran.
- The Bot server runs with `events: { persist: true }` (`bot-v2.db`), the one
  place a native event log grows. Trimming it needs a v2-specific design:
  `session_v2` timestamps, skipping inbox, pending and receipt aggregates, and a
  host-quiesce gate instead of the process listing.

## Follow-up: pre-launch wiring removed

Decision: remove the dead wiring rather than keep it inert. A mutating pass
needs a generation-1 runtime selection (`db-maintenance-core.js`), and
`runtime-selection.js` accepts generation 2 only, so no pre-launch pass or
forced compaction could ever edit a database, even if the hook were wired. The
hand-off was also harmful: when no selection is readable, inspection falls back
to a legacy v1 file, Compact Now was enabled, and the route restarted OpenCode
(interrupting every session) and left `compactionPending` set with nothing to
consume it.

- `application.js`: removed `runOpenCodeDbMaintenanceBeforeSpawn`, the
  `beforeManagedSpawn` pass-through and the compaction scheduler.
- `db-maintenance.js` / `db-maintenance-core.js`: removed
  `createOpenCodeDbCompactionScheduler` and `OPENCODE_DB_PRELAUNCH_TIME_BUDGET_MS`.
  The v1 core, the facade's `run()` and their tests are unchanged.
- `db-maintenance-routes.js`: `GET` drops `managedRuntime`/`compactionPending`;
  `POST …/compact` serves only `{ dryRun: true }` and answers every other body
  with `409 maintenance_not_applicable`, without running a pass or restarting.
- Settings → OpenCode Storage: Compact Now, its dialog, polling and toasts are
  gone, along with the "Cleanup runs before every OpenCode launch" and
  `opencodeDbMaintenance.enabled` notices (the setting no longer has an effect).
