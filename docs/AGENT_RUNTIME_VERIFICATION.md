# Agent runtime verification

Use this for live multi-user checks and runtime incident investigation. Deterministic tests are in [TESTING.md](TESTING.md); isolated QA runners are in [QA.md](QA.md).

## Agent-test login

The Supabase control plane reserves two fixture accounts for AI agents (`account_kind = 'agent_test'`). They are hidden from the Users page and `GET /api/admin/users`, and go through the same authentication, policy, ownership and audit checks as human accounts.

| Account | Email | Verifies |
| --- | --- | --- |
| Test Administrator | `admin@1health.ae` | Host-path pass-through, project registration, user management |
| Test Developer | `developer@1health.ae` | Path aliasing, out-of-scope 403s, hidden settings |

Never type, store or transmit passwords. Use the loopback-only password-free endpoint `POST /auth/agent-test-session` (`handleAgentTestSession` in `packages/web/server/lib/multi-user/runtime.js`, mounted in `packages/web/server/lib/opencode/core-routes.js`). It accepts only active `agent_test` profiles, only from 127.0.0.1, and mints a normal 12-hour session audited as `auth.agent_test_login`. From the app's own browser tab:

```js
await fetch('/auth/agent-test-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
  body: JSON.stringify({ email: 'developer@1health.ae' }),
});
location.reload();
```

Call it again with the other email to switch roles. `POST /auth/logout` (with the CSRF header) ends the session.

## Isolated verification

Only one DevRyan runtime may own a selected bundle. Never stop or reuse the user's running app, data or Docker Engine.

- Fixture QA: `bun run qa` starts its own server on a private data directory (see [QA.md](QA.md)).
- Live checks: build the current source (`bun run build` plus the native artifact build), then start a private profile through `scripts/qa/native-profile-factory.mjs` and `scripts/qa/native-profile-preparation.mjs`. Setting only `DEVRYAN_DATA_DIR` is not enough: native bundle selection also uses the state root, and provider owners have their own configuration.
- Credential-free check of the profile factory:

```bash
node scripts/qa/native-profile-factory-diagnostic.mjs --artifact-root "$PWD/.cache/v2-validation/native-artifact"
```

Use a fresh verified artifact directory in place of the example. It checks isolated startup and usage discovery (providers without an account report not configured); it does not prove personal provider access. Providers that need an account are signed in by a human through Providers in the isolated host. Never construct credential files by hand.

Managed-user tests need a non-production Supabase deployment that contains migration `20260830150000`. If it is missing, report `migration_required`, create no fixture, and mark the membership, transcript, ACL and runtime cases unavailable.

## Diagnostic journal

For any runtime issue (stuck sessions, missing or duplicated events, failed prompts, aborts that did not take effect, sync anomalies, worktree lifecycle), read the journal before forming a code-only theory:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
bun scripts/journal.mjs gaps --verify
bun scripts/journal.mjs summary <rootSessionID>
```

`gaps` skips session buckets whose manifest records zero gaps; `gaps --verify` rereads every chunk and is the form qualification runs use. `show` also accepts `--type`, `--event`, `--since`, `--until` and `--grep`. Pass `--dir <journal-dir>` to read a specific host's journal.

`summary` reads the root session and every descendant session (parents come from bucket manifests, or from `session.*` events when a manifest is missing) and prints: the session tree with agent, model, last status, active span and assistant busy time; tokens, cost and cache hit ratio (cache read / (input + cache read + cache write)) by agent/model, by agent and by model; tool calls with p50/p90/max/total latency, errors and unfinished calls; `session_execution` phases by action and phase; tool and `session.error` errors; and controls (aborts with their source, retries, provider recovery, permission and question events). It accepts `--since`/`--until` (records only; the tree is kept) and `--json` for the full structure (text output caps phases, errors and controls). It never prints control bodies, prompt text or question answers. Run `gaps` as well: a gap count above zero qualifies the summary.

| Topic | Detail |
| --- | --- |
| Location | `<selected descriptor launch.webDataDirectory>/harness/journal/` (web and Electron). Journals under `~/.config/devryan/` (before the data-folder move, `~/.config/openchamber/`) describe the old runtime. |
| Layout | `index.json` summarizes `sessions/<sessionID>/manifest.json`. Closed chunks are `*.ndjson.gz`, the active chunk is `*.ndjson.open`, large strings are `blobs/<sha256>.txt.gz`, sessionless records are under `runtime/`. The generated `README.md` there is the format guide. |
| Record types | `open_code_event`, `prompt`, `control`, `lifecycle`, `worktree_transition`, `evidence_transition`, `connection`, `timing`, `log`, `gap`. |
| Intentional trims | `message.part.delta` is not stored. Repeated `message.part.updated` and `session.updated` are last-write-wins (`coalesced` counts the source events). These are not gaps. |
| Gaps | A `gap` record means queue overflow, sanitization failure or parse failure. It qualifies any conclusion drawn from that range. |
| Retention | 7 days and 1 GiB total. Records are sanitized before disk: secrets redacted, paths rewritten to `<WORKTREE_...>` placeholders. |
| Aborts | `control` records with `action: "abort"` carry `payload.source` (`stop_button`, `double_escape`, `steered_send`, `session_removal`, `revert`, `redo`, `abort_guard`, `provider_retry`, `stall_watchdog`, `status_row`, or `unknown`). Use it to explain `MessageAbortedError` or `Tool execution aborted`. |
| Crashes | A managed OpenCode exit is a `runtime/` lifecycle `opencode_process_exit` (`code`, `signal`, `uptimeMs`, `expected`, sanitized stderr tail). `expected: false` is a crash; `opencode_restart_reconciled` counts sessions settled as `turn_failed` / `runtime_exit`. macOS crash reports: `~/Library/Logs/DiagnosticReports/DevRyan-opencode-*.ips`. |
| Health | `GET /api/diagnostics/status` (port 3000; `dev:server` uses `${DEVRYAN_PORT:-3001}`) reports `sessionCount`, bytes, queue/write/gap counts and the last error. |

Absence of an expected non-delta record is itself evidence: the runtime never saw it. Storage, sanitizer, export and HTTP contracts: `packages/harness-runtime/DOCUMENTATION.md` and `packages/web/server/lib/diagnostics/DOCUMENTATION.md`.

### Error Log correlation

An Error Log event UUID is an administrative locator, not an execution record.

1. Resolve the UUID through the administrator Error Log detail surface or API. Capture `sessionId`, timestamp, action/kind and every `callId`, `toolId`, `messageId` or `taskId`.
2. Query the journal with the session and the strongest ID, for example `bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to the tool/message/task ID or a bounded `--since`/`--until` window.
3. Run `bun scripts/journal.mjs gaps` before concluding.
4. Do not expect the UUID in journal records. If the journal is missing, expired or has a gap, say so; never reconstruct detail from the Error Log summary.

### Desktop runtime ownership after restart

Separate the Electron window, the web listener, the native runtime and usable chat. `/health` and `/api/health` expose `openCodeStartup` with `state` (`idle`, `starting`, `ready`, `failed`), `attempt` and a bounded `code`. A failed attempt is terminal until recovery starts a new one; a listening web server alone does not mean OpenCode is ready. The UI polls once a second with a three-second request timeout. It gives up after 120 seconds without progress; each snapshot that reports `starting` restarts that window, up to 10 minutes in total. After it gives up, the Retry screen keeps checking every five seconds and continues by itself once the host reports ready.

Startup logs:

- `[electron] startup phase` gives durations for shell preparation, server import/listen, background-runtime retirement (`foreground_preparation`) and renderer navigation. Phases can nest; do not add them as if sequential.
- `[runtime-bundle] startup phase` gives the verified bundle upgrade duration. `bundle_lease_recovery` means startup settled abandoned control leases first. `abandoned control leases not settled: <codes>` means a lease will refuse launch with `bundle_execution_unsettled`.
- `[runtime-bundle] startup upgrade not applied: <code>` means the launch continues on the previous runtime; `/health` lists it under `startupNotices`.
- `startup isolated a record instead of refusing: {...}` names a finished or derived record that startup set aside.
- `[electron] restart recovery preparation failed` records why **Prepare recovery for restart** was refused.

For `runtime_service_owner_active`, `runtime_service_owner_stale` or `runtime_service_owner_unverified`, correlate the Electron startup log with `runtime-service/owner.v1.lock` under the data directory. A `service`-mode owner there was left by the retired background runtime; `[runtime-service] background runtime retirement deferred` means its registration could not yet be withdrawn and `runtime-service/retired.v1` is absent. A live PID alone does not prove DevRyan is running; the OS reuses PIDs.

Owners also write `owner-process.v1.json` (instance, generation, PID, OS boot UUID and process start identity) before publishing the lock. macOS reads the start identity with `/bin/ps -p <pid> -o lstart=` (`LC_ALL=C`, `TZ=UTC`); Linux uses `/proc/<pid>/stat` start ticks. Proven-stopped owners are reclaimed under the mutation guard; live or unverifiable owners stay fenced, and missing OS evidence never authorizes takeover. An old lock without matching evidence is saved as `owner-recovery.v2.json` and reports `runtime_service_owner_unverified`: restart the computer, then reopen DevRyan. Do not delete the lock or kill its PID. Ownership logs carry bounded reasons such as `boot_changed`, `pid_reused` and `legacy_boot_changed`.

### OpenCode runtime selection

The entrypoint binds the selected native bundle before importing data owners. The authoritative selector is `selection.json` under `DEVRYAN_RUNTIME_BUNDLE_ROOT`, or by default `$XDG_STATE_HOME/devryan/runtime-bundles` (`~/.local/state/devryan/runtime-bundles`). It pins a revision, bundle ID and manifest hash; `bundles/<id>/descriptor.json` supplies the database, configuration, web-data, journal and Global paths. Do not infer the active database from timestamps or old `opencode-runtime-selection.json` files.

- First startup keeps validated setup and creates fresh conversations and journals. Old databases stay unused.
- When an update pins a newer OpenCode, or the same version with a different core digest, startup clones the bundle onto the shipped runtime and selects the clone; the old bundle becomes `previousBundleID`. It logs `[runtime-bundle] upgraded the selected runtime ...` or `startup upgrade not applied: <code>`.
- When only DevRyan's artifacts changed (same OpenCode version and core digest), startup rebinds the selected bundle in place: same bundle ID and data, new controller, writer, artifact manifest and reviewed plugins, and the next revision. It logs `[runtime-bundle] rebound the selected runtime to new artifacts ...`. `rebind/intent.json` journals the previous launch documents (`rebind/previous-*.json`); a rollback restores them. A `pending` or `restoring` journal is settled by the next launch before binding. Do not edit or delete the journal by hand.
- For an incident, record the selected bundle ID, revision, artifact hash and owner process identity before reading that bundle's journal. Never delete the selector, database or ownership files to force recovery.
- A pending rollback intent holds startup while `selection.json` still points at the candidate; the recovery process serves loopback reads only. After the original process exits, run `openchamber runtime bundle resume --expected-revision N` in the original control-root environment, or use the Electron recovery page's Resume action. Both need the original checkpoint, drain and physical-exit proof. Missing proof is never replaced by PID absence.

## Startup ownership contracts

- `retryRuntimeServiceConnection` bounds the foreground connection at 20 seconds, extended to 60 only while the service is still booting. A stale descriptor triggers one guarded ownership check: only proved stopped or missing ownership ends the wait early. Each attempt gets the retry's absolute deadline; bootstrap and lease HTTP requests abort after five seconds or the remaining deadline.
- Recovery unregisters, proves the owner stopped again, and acquires exclusively before persisting app-bound mode. Phase logs report each step with elapsed milliseconds and allowlisted failure codes.
- Startup health owner: `packages/ui/src/lib/startup/health.ts` validates the optional host startup snapshot and polls health every second (three-second request deadline, 120-second window without progress, 10-minute cap while the host reports `starting`). `useConfigStore.initializeApp` deduplicates it before loading providers and agents; `App` cancels old owners on retry or unmount, and terminal failures reach the Retry screen. Older health servers stay compatible.
- `bun run test:startup` covers these contracts (see [TESTING.md](TESTING.md)).
