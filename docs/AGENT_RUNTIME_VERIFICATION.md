# Agent runtime verification

Use this runbook for live multi-user checks and runtime incident investigation. Deterministic test guidance lives in [TESTING.md](TESTING.md).

## Multi-user visual verification (agent-test accounts)

The Supabase multi-user control plane reserves two fixture accounts exclusively
for AI agents doing visual verification. They are `account_kind = 'agent_test'`
in `user_profiles`, are deliberately hidden from the Users settings page and
`GET /api/admin/users`, and pass through the exact same authentication, policy,
assignment, ownership, and audit enforcement as human accounts:

- **Test Administrator** — `admin@1health.ae` (role `admin`; verifies admin
  flows: host-path pass-through, project registration, user management).
- **Test Developer** — `developer@1health.ae` (role `developer`; verifies the
  restricted experience: path aliasing, out-of-scope 403s, hidden settings).

**Agents must never type, store, or transmit passwords.** Instead use the
loopback-only, password-free login endpoint (`handleAgentTestSession` in
`packages/web/server/lib/multi-user/runtime.js`, mounted at
`POST /auth/agent-test-session` in `server/lib/opencode/core-routes.js`). It
only accepts active `agent_test` profiles, only from 127.0.0.1, and mints a
normal 12-hour app session (audited as `auth.agent_test_login`). From the
app's own browser tab:

```js
await fetch('/auth/agent-test-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
  body: JSON.stringify({ email: 'developer@1health.ae' }),
});
location.reload();
```

Calling it again with the other email switches roles; `POST /auth/logout`
(with the CSRF header) ends the session.

**Isolated verification.** Only one DevRyan runtime may own a selected bundle. Keep the user's running app and its data untouched. Use the repository-owned private profiles in `scripts/qa/native-profile-factory.mjs` and `scripts/qa/native-profile-preparation.mjs`, as described in [QA.md](QA.md#interpreting-an-incomplete-acceptance-run). Their copied setup manifest, explicit credential-owner callback, selected bundle and private home cover both web and Electron. Overriding only `OPENCHAMBER_DATA_DIR` is insufficient: native bundle selection also uses the state root, and provider owners have their own configuration.

Build the current source before verification (`bun run build` and the native artifact build required by the QA profile). The credential-free factory diagnostic is:

```bash
node scripts/qa/native-profile-factory-diagnostic.mjs --artifact-root "$PWD/.cache/v2-validation/native-artifact"
```

Use a fresh verified artifact directory in place of the example. This checks isolated startup, not personal provider access or managed-user authorization. Live checks need the reviewed setup and their explicit account bootstrap; never construct credential files by hand.

The attended `live-credential-owner.mjs` and credential-free compiled rehearsal
are documented in [tracked live credential ownership](QA.md#tracked-live-credential-owner).
The live source uses independent owner sign-ins, a constructor-only held grant,
memory-only snapshots and private candidate CAS. It never discovers installed
accounts. Managed-user tests still require the separate non-production
Supabase prerequisites below.

## Diagnostic journal (check it before theorizing)

Whenever the user reports a DevRyan runtime issue — stuck or hung sessions, missing or duplicated events, failed/rejected prompts, aborts that did not take effect, streaming or sync anomalies, worktree or evidence lifecycle issues — inspect the journal before forming a code-only theory. Start from the repository root:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
```

### Desktop runtime ownership after restart

For launch failures with `runtime_service_owner_active`, `runtime_service_owner_stale`,
or `runtime_service_owner_unverified`, correlate the Electron startup log with
`runtime-service/owner.v1.lock` and the non-secret PID/instance/generation fields
of `handshake.v1.json` under the configured data directory. Do not dump the
handshake's sealed bootstrap token. A live PID alone does not prove DevRyan is
running: the OS can assign yesterday's PID to an unrelated process after reboot.

New owners also persist private `owner-process.v1.json` evidence before publishing
the lock. Its instance/generation/PID must match the owner; the OS boot UUID and
process-start identity then distinguish the original process from a reused PID.
Start identities are equality tokens, never wall-clock age thresholds. macOS
uses bounded `/bin/ps -p <pid> -o lstart=` with `LC_ALL=C` and `TZ=UTC`; Linux uses
`/proc/<pid>/stat` start ticks. Unsupported platforms retain conservative PID fencing.

Acquisition and stopped-owner polling use the same decision. Proven-stopped
owners can be reclaimed under the mutation guard after rechecking the exact
file; verified live owners remain protected. Missing OS evidence and permission
failures cannot authorize takeover. The foreground also rejects obsolete
descriptors before attempting bootstrap.

An old valid lock without matching process evidence may remain ambiguous. Its
first observation saves `owner-recovery.v2.json` and reports
`runtime_service_owner_unverified`: restart the computer, then reopen DevRyan.
The unchanged file plus a different boot UUID permits recovery. Repeated Retry
preserves the original evidence; changing the file requires fresh evidence.
This is a one-time migration path, not a request to delete the lock or kill its
PID. Damaged-file quarantine retains its existing safety checks.

Ownership logs contain only bounded phase/code/reason fields, including
`boot_changed`, `pid_reused`, `legacy_boot_changed`, and identity-unavailable
reasons. A stale identity companion after release is harmless: only an exact
owner match can use it, and the next acquisition replaces it.

The Electron runtime-service tests include an isolated native process smoke:
disposable Node children contend for one temporary data directory, expose
stable OS start identities, and recover after the winning child exits. It does
not inspect the user's installed runtime. This does not replace packaged
launchd, signing, or physical-reboot acceptance.

### OpenCode runtime selection (storage writers)

The entrypoint prepares and binds the selected native generation-2 bundle before importing data owners. The authoritative selector is `selection.json` under `DEVRYAN_RUNTIME_BUNDLE_ROOT`, or the default `$XDG_STATE_HOME/devryan/runtime-bundles` (`~/.local/state/devryan/runtime-bundles` without that override). It pins a selection revision, bundle ID and prepared-manifest hash. The selected `bundles/<id>/descriptor.json` supplies the database, configuration, web-data, journal and Global paths. Do not infer the active database from timestamps, old `opencode-runtime-selection.json` files or an installed standalone executable.

First startup preserves validated setup while creating fresh conversations and journals. Old databases remain unused and do not block startup; later starts reuse the valid v2 selection and retain new work. The native selector, admission owner and mutation ledger govern updates, removal and rollback. A stale selection revision or unresolved rollback reconciliation refuses admission. Legacy database inspection helpers remain read-only for native v2 files; the old event-pruning pass is not a native maintenance operation.

For an incident, capture the non-secret selected bundle ID, revision, artifact hash and owner process identity before inspecting that bundle's journal. Never delete the selector, database or ownership files to manufacture successful recovery.

A durable pending rollback intent also holds startup when `selection.json`
still points to the candidate. The recovery process exposes loopback reads only.
After the original runtime process has exited, use
`openchamber runtime bundle resume --expected-revision N` in the original
control-root environment, or the cold Electron recovery page's native Resume
action. Both require the original checkpoint/drain/physical-exit proof and
unchanged candidate state, increment the revision even when resuming the already
selected candidate, and require a fresh composition. Partial prior-bundle state
remains available for inspection. Missing proof cannot be replaced by PID absence.

Claude verification uses independently enrolled DevRyan profiles for automatic
renewal mechanics. Enrollment is available in Providers through the prepared
vendor login; profile selection is a separate explicit action. Shared CLI
profiles and the default live acceptance lane remain access-only and refuse at
expiry. Quota and status inspection never renew credentials. Renewal fault tests
use isolated synthetic credential backends and the original native KV owner.

### Error Log correlation and journal coverage

When the report starts with an Error Log event UUID, treat that UUID as a durable administrative locator, not as the detailed execution record:

1. Resolve the UUID through the administrator Error Log detail surface/API first. Capture the `sessionId`, timestamp, action/kind, and every available `callId`, `toolId`, `messageId`, or `taskId`.
2. Use the session plus the strongest correlation identifier to inspect the corresponding local journal, for example `bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to `toolId`, `messageId`, `taskId`, or a bounded `--since`/`--until` timestamp window when no call ID exists.
3. Run `bun scripts/journal.mjs gaps` before drawing conclusions.
4. Do not expect the Error Log UUID itself to appear in journal records. Error Logs and the journal are separate stores correlated through session and tool/message/task identifiers: Error Logs provide durable administrative indexing, classification, and bounded sanitized summaries; the journal is the source for prompts, tool output, lifecycle ordering, recovery behavior, and detailed failure evidence.
5. If the relevant host journal is unavailable, expired, or contains a qualifying gap, report that limitation instead of reconstructing missing detail.

- Location (web/Electron): `<selected descriptor launch.webDataDirectory>/harness/journal/`. Binding sets `OPENCHAMBER_DATA_DIR` to this bundle-owned data root. Pass `--dir <journal-dir>` to the CLI for either host; old journals under `~/.config/openchamber/` do not describe the new runtime.
- Layout: `index.json` summarizes `sessions/<sessionID>/manifest.json`; closed chunks are `*.ndjson.gz`, the active crash-safe chunk is plain `*.ndjson.open`, large strings are `blobs/<sha256>.txt.gz`, and records without a resolvable session are under `runtime/`. The directory's generated `README.md` is the self-describing format guide.
- Legacy root `*.ndjson` segments remain readable by offline tools and are listed as `legacy`. Fresh v2 startup does not import them; historical journal evidence cannot qualify a current v2 journey.
- `message.part.delta` is intentionally absent. Repeated `message.part.updated` and `session.updated` records are last-write-wins; `coalesced` reports how many source events a stored record represents. These trims are not data-loss gaps. `gap` still means queue overflow, sanitization failure, or parse failure and must qualify conclusions.
- Record types remain `open_code_event`, `prompt`, `control`, `lifecycle`, `worktree_transition`, `evidence_transition`, `connection`, `timing`, `log`, and `gap`. Resolved session IDs are stamped at the top level before storage.
- `control` records with `action: "abort"` carry `payload.source`, which names the UI path that stopped the session (`stop_button`, `double_escape`, `steered_send`, `session_removal`, `revert`, `redo`, `abort_guard`, `provider_retry`, `stall_watchdog`, `status_row`). A missing or unrecognized value is recorded as `unknown`, for example an older client or a direct API call. Controls are journaled before primary recovery handles them, so primary-session aborts are recorded too. Use this to explain an unexpected `MessageAbortedError` or `Tool execution aborted`.
- Runtime crashes: a managed OpenCode exit is recorded under `runtime/` as lifecycle `opencode_process_exit` (`code`, `signal`, `uptimeMs`, `expected`, and a sanitized stderr tail, where a Bun panic and its `bun.report` link appear); an `expected: false` record is a crash. The following `opencode_restart_reconciled` record counts sessions settled as `turn_failed` / `runtime_exit` because they died with that process. Crash reports themselves are in `~/Library/Logs/DiagnosticReports/DevRyan-opencode-*.ips` on macOS.
- A turn stopped while OpenCode waited to retry the provider settles as `turn_aborted` with reason `abort_requested`. A managed child stopped by the user settles its task as `aborted` ("Stopped by the user") with no automatic continuation prompt afterwards.
- Runtime health: `GET /api/diagnostics/status` (default port 3000; `dev:server` uses `${OPENCHAMBER_PORT:-3001}`) reports `sessionCount`, bytes, queue/write/gap counts, segment count, and the last error.
- Caveats: records and manifests are sanitized before disk (secrets redacted, home/worktree paths rewritten to `<WORKTREE_…>` placeholders); retention is 7 days / 1 GiB total. Absence of an expected non-delta record is itself evidence — the runtime never saw it.
- Deep contracts: `packages/harness-runtime/DOCUMENTATION.md` (journal, sanitizer, export, storage limits) and `packages/web/server/lib/diagnostics/DOCUMENTATION.md` (HTTP status/clear/export/sanitize).
