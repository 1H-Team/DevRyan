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

Use a fresh verified artifact directory in place of the example. This checks isolated startup and credential-free usage discovery (providers without an account report not configured through the actual controller), not personal provider access or managed-user authorization. Live checks need the reviewed setup and their explicit account bootstrap; never construct credential files by hand.

The attended `live-credential-owner.mjs` and credential-free compiled rehearsal
are documented in [tracked live credential ownership](QA.md#tracked-live-credential-owner).
The live source uses independent owner sign-ins, a constructor-only held grant,
memory-only snapshots and private candidate CAS. It never discovers installed
accounts. Managed-user tests still require the separate non-production
Supabase prerequisites below.

For an attended sign-in handoff while host corrections are still being qualified,
run `node scripts/qa/live-provider-handoff.mjs --artifact-root <verified-repo-cache-artifact>`
from an attended terminal. It creates a persistent private profile under
`.cache/qa`, using the existing native preparation factory, selected bundle,
constructor checkpoint and one-use local-owner link. It supplies a fresh
nonsecret OpenAI/Cursor Grok configuration and the Default Zen helper; it does
not read installed setup or accounts. Native health must be ready before the
owner link is printed. The human opens that link and signs in through Providers.
Keep the link, cookie and sign-in screens out of evidence.

The attended workflow accepts `status`, `owner-link`, `restart`, `close` and the
explicitly qualified `exercise` and `qualify-providers` JSON commands described below. Sign-in/status
commands do not run inference. It has no credential snapshot, copy or matrix command.
Status reports readiness and owner-session issuance. After the existing issuer
creates the human owner session, its memory-only callback can report connection
flags and model counts for OpenAI, Cursor, Zen and Anthropic, catalog completeness,
and Claude's installed/logged-in booleans with known auth/error codes. Catalog and
Claude inspection fail independently with bounded codes. Provider entries, account
identifiers, paths, raw errors and credentials stay inside the callback. Catalog
flags are availability metadata; the status command makes no account-verification claim.
Startup and upgrade child refusals use only an exact `status`/`code` IPC record
with the existing bounded error-code policy. They are sent before the returned
owner can be settled; resume forwards them once, and upgrade preserves the cause
after physical teardown confirms. Missing receipts and failed teardown remain
refusals. Raw child stdout/stderr, stacks and account output remain discarded.
After a host rebuild, `restart` physically settles the owned child and imports
current host/UI code into the same selected private profile. It issues a new
human owner link; no principal or checkpoint is serialized as an account grant.
Close credential-entry flows before restarting. After launcher exit, resume with
`node scripts/qa/live-provider-handoff.mjs --resume <private-profile>/handoff.json`.
The private `.cache/qa/provider-handoff-current.json` selector registers that
exact retained profile as `V1` / `QA1`; these are human profile labels, not runtime
versions. `--resume-current` uses it. Once registered, `--artifact-root` and a
different `--resume` path refuse replacement, preserving the existing sign-ins.
Registration is an atomic, directory-synced, no-clobber publication and contains
only paths and labels. It cannot supply an account, principal or checkpoint.
After the original full Node package qualification passes, resume the same registered
profile with `--resume-current --qualification-report <absolute-original-package-result.json>`.
The report must be the original private `.cache/v2-validation/package-*/result.json`
with its passed owner run record, every mandatory full-package case, empty cleanup
and remaining-gate lists, exact selected build/manifest, current source inventory
and runner hash. Diagnostic, preflight and retained-only reports refuse. The
native source inventory includes QA scripts, agent-eval scripts and Cursor runtime;
the exercise checks it again immediately before inference and approval.

Consume the new one-use owner link through the normal browser sign-in flow.
With the owner's standing QA authorization recorded in `AGENTS.md`, the agent
may complete that sign-in through computer use without asking for another click.
Otherwise the human consumes it manually. The existing issuer keeps its cookie
in memory; only a post-validation successful admission enables
its exercise closures. Failed or expired issuance cannot replace a prior admitted
exercise session. Enter `{"command":"exercise"}` only in the original attended
launcher. It refuses absent admission/qualification, a busy or incomplete
catalog, changed artifact/selection, a missing restorable project directory, wrong
saved Grok 4.6 Explorer model, or unavailable Astra Medium and Default helper.
The [standing-authorized QA1 view](audits/2026-10-15/qa1-standing-admission.png)
records a normal isolated sign-in; it is not provider or release qualification.
The [effort-observation correction](audits/2026-10-15/effort-update-observation-correction.json)
records pinned GPT-6 input controls separately from literal top-level wire options;
its focused proof does not qualify a provider account or the updated release.
The collector keeps native `/api/provider` connections and metadata for non-Cursor
providers, and reads Cursor virtual models from `/api/config/providers`. Cursor
requires successful existing Configure/Verify (`success`, `ok`, `configured`, SDK
models), known configured SDK authentication from runtime status, and the exact
merged Grok 4.6 Medium variant; declared fallback models cannot qualify. Configure
has a 25-second issuer request bound around the existing 20-second native owner.
The exercise captures the exact Explorer override and a clean managed Apply
baseline before temporarily selecting Medium through the existing override route.
It applies only the captured agents-only revision with `when-idle`, then requires
clean Apply status and the exact live Explorer selection. Restoration uses the
same checks after PUT, or DELETE for an originally absent override. Apply requests
have a 40-second bound; subsequent live convergence has a 20-second window.
HTTP refusals from fixed, reviewed QA endpoints retain an enumerated operation
and numeric status in their existing bounded error code. Unknown routes remain
generic; query values, request/response bodies and provider account fields are
never included. Apply-specific refusal codes and optional-resource 404 handling
remain unchanged.
Cleanup has an independent 60-second bound and refuses newer changes or an Apply
still in progress, reporting incomplete restoration instead of overlapping
restarts or overwriting a human change. Other agent defaults stay intact.
Saved helper UUID revisions are retained. Builder and Orchestrator use supported
Astra Medium per-turn selections, preserving saved primary model defaults; actual
canonical user and child records must prove the requested model and effort.

`scripts/qa/qa1-profile-exercise.mjs` runs the exact supplied original prompt in a
new disposable profile-site analogue, preserves its dirty user note and existing
tests, verifies no implementation changes in Plan mode, and clicks the actual
saved Plan card for approval. It joins timed native reads, failing original tests,
mutation, passing original tests and full suite with the exact private published
lease and retained physical termination receipt. The inspector is constructor-only
and exports IDs and bounded proof values. It uses the existing agent-eval runner
for three further tasks: `inspect` and `repair-and-test` with Builder, followed by
`managed-independent` with Orchestrator. Those are separate from the three input
regression sets and thirteen unauthenticated browser scenes. Independent test
processes cannot write files, spawn children or access network/account roots.

The run has a fifteen-minute absolute bound, existing per-case budgets and owned
session-tree cancellation. Cleanup drains the exercise before host shutdown,
settles browser processes independently, preserves primary failure plus cleanup
failure, and restores the runtime directory through its existing owner before
restoring settings, provided no newer human directory selection intervened.
Sanitized results and screenshots stay in its owned `.cache/qa` run; the retained
V1 / QA1 account profile remains unchanged. Physical helper sampling, live provider
silence and actual mobile browser-chrome movement remain separate mandatory
checks; a successful exercise does not claim full live qualification.
`{"command":"qualify-providers"}` uses the same validated issuer, qualification
report and single active-work guard. It samples three bounded Astra High turns
and uses the completed original Medium turn retained only in child memory,
plus the existing title/commit/PR helper operations with the actual saved helper
revision. Its constructor journal reader flushes through the original owner,
checks the exact selected descriptor path and health, reads only bounded owned
session/directory windows, then rechecks selection/readiness. Generated helper
titles and bodies are reduced to response-validity facts inside the original
issuer. Missing/expired/gapped evidence remains unqualified. See the
[implementation proof](audits/2026-10-14/qa1-exercise-implementation.json).
The [registered-project Cursor status correction](audits/2026-10-15/cursor-registered-project-status.json)
retains its failed preflight, exact-location status checks and qualification scope.
The retained Medium sample is validated before any paid High/helper dispatch.
Missing or unqualified Medium evidence refuses the run; it is never replaced by
a newly generated sample or transferred to another issuer.

The separate `qualify-providers` attended command runs
`scripts/qa/qa1-provider-qualification.mjs` through the same validated human
issuer and exact fresh full-native source/artifact/runner pin. It creates a
disposable project, submits three bounded Astra High inspection tasks, and calls
only the commit-message and PR-description draft endpoints. Each inspection
uses canonical Plan admission and each paid dispatch checks fresh idle state.
Ordinary naming waits up to its existing thirty-second budget for exact owned
model-generation and source-message-bound durable persistence diagnostics.
Projection alone cannot finish this wait; failed persistence attempts may recover
within the existing budget, while pause, cancellation or deadline ends it. Saved model defaults
and the actual helper revision are preserved; the original exercise's Medium
request is retained only in issuer memory and is never replaced by a new sample.
Every silence sample joins the exact accepted input and canonical native step to
its prepared model, physical HTTP request, wire effort and body-end counters.
These are measured stream gaps, not a deliberate silence injection. WebSocket,
missing/ambiguous timing, incomplete journal coverage or gaps remain unqualified.
The product timeout stays at 300 seconds.
Every canonical step for the sampled user is checked before effort filtering.
Other turns, including Implement traffic in the Medium window, are excluded only
when their physical requests are attributable to another accepted canonical turn.
Unlinked requests remain explicit scope gaps.

The original issuer flushes its own journal before a bounded private reader
projects IDs, fixed model tuples, reasoning enums and numeric counters. Content,
titles, account fields, paths and hashes never enter the qualification result.
Helpers qualify only when actual prepared and serialized physical tool counts
are zero, both observations carry the exact Node-owner-captured configured
helper revision, and default reasoning and ordinary naming settlement are
observed. Older records, unknown wire counts, active-session fallback or missing
revision proof remain explicit gaps. Session cancellation and directory
restoration use independent cleanup budgets. See the source-only
[provider qualification proof](audits/2026-10-14/qa1-provider-qualification.json).
Helper operations remain serialized within bounded session/agent windows. Every
applicable prepared request and physical retry is validated, with unique positive
send ordinals. Default reasoning means no variant and no reviewed reasoning keys;
the projection's `reasoningOptionsEmpty` fields do not claim all private provider
options are empty. Unattributable sends or ambiguous same-agent concurrency cannot
qualify. Naming persistence and projection are separate stages; a diagnostic is
not a substitute for the compiled owner's exact native mutation-count proof.

The original provider owners retain their account stores in that profile. A
`storage-retention.json` pin protects this reusable profile from ordinary pruning,
including after the run metadata changes on close; automatic finish cleanup also
retains it. Removing the profile requires an explicit owner decision, not a QA
retry cleanup. Owner-session issuance does not prove the human completed sign-in:
link previews can consume a GET link. Use a fresh manual link or the already
authorized application origin and keep account verification pending.
A changed native artifact or held selection is refused; it requires the original
bundle upgrade/handoff workflow rather than editing the state record. After the
qualified package gate passes and all credential-entry flows and the old attended
host are closed, the attended `--upgrade-current --artifact-root <target>
--build-id <exact-build> --manifest-sha256 <exact-hash>` command invokes the
original runtime lifecycle upgrade. The native owner verifies, checkpoints,
clones and selects within the same control root; the previous bundle remains its
rollback target. This workflow never recreates source settings or edits provider
stores. It adopts only the exact selected/previous/source/checkpoint, next
revision, target artifact and unchanged workspace lineage, after physical child
settlement. Project-map fingerprints use native `canonicalJSON`: object-key
insertion order does not alter identity, while exact fields, paths, modes and
array order remain pinned. See the [QA1 lineage incident proof](audits/2026-10-14/qa1-upgrade-lineage-correction.json). Repeating the same exact command can recover a committed native
transition whose nonsecret handoff identity update was interrupted. No mutable
intent file or account grant is serialized. A truthful needs-resume result keeps
the committed selection explicit. Then use `--resume-current` for a new human
owner link. Paid QA and credential admission still require the qualified frozen
live owner above; deterministic lineage tests do not qualify a live upgrade.
The handoff child passes the actual OS-user home through the reviewed
`nativeClaudeSecurityHome` constructor option. Private QA HOME remains unchanged;
only the owner-validated isolated Claude enrollment/lifecycle service uses that
command-local security home. Default and legacy installed services are excluded.

## Diagnostic journal (check it before theorizing)

Whenever the user reports a DevRyan runtime issue — stuck or hung sessions, missing or duplicated events, failed/rejected prompts, aborts that did not take effect, streaming or sync anomalies, worktree or evidence lifecycle issues — inspect the journal before forming a code-only theory. Start from the repository root:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
```

The [13 October OpenCode 2 live agent QA](audits/2026-10-13/opencode-v2-live-qa/README.md)
records slow Cursor admission and settlement, corrupted child reports, repeated
result delivery, and a failed partial plan/retry. Its implementation audit links
the corrections and current qualification evidence; source and native package
passes remain separate from live, visual and release qualification.

The [11 October Cursor Explorer QA investigation](audits/2026-10-11/live-agent-qa.md)
records an interrupted native Plan-mode run, diagnostic evidence, and the proposed
authorization, model-effort and read-only execution repairs.

The [23:09 live orchestration QA](audits/2026-10-11/live-agent-qa-2309.md)
records Cursor delegation startup failure, cancellation-state disagreement,
context and resource observations from a subsequent interrupted plan run.
Its isolated skill UI follow-up retains screenshots of
[loading](audits/2026-10-11/live-agent-qa-skill-preparing.png),
[failure after reload](audits/2026-10-11/live-agent-qa-skill-preparation-failed-reloaded.png),
and [loaded](audits/2026-10-11/live-agent-qa-skill-loaded.png).
The same investigation retains dedicated-profile deletion
[API proof](audits/2026-10-11/live-agent-qa-profile-delete.json) and
[visible controls](audits/2026-10-11/live-agent-qa-profile-delete.png), plus the
direct live attempt's [task record](audits/2026-10-11/live-agent-qa-direct-attempt1.json)
and [blocked planning view](audits/2026-10-11/live-agent-qa-cursor-model-failure.png).
The requested Explorer model change has a
[saved Cursor Grok view](audits/2026-10-11/live-agent-qa-explorer-grok.jpg).
The fresh run captured [parallel Grok dispatch](audits/2026-10-11/live-agent-qa-grok-parallel.png).
The separate Claude route rejection showed a [settled failed child](audits/2026-10-11/live-agent-qa-settled-failure.png) without a processing indicator.
The [partial Grok journey record](audits/2026-10-11/live-agent-qa-grok-partial.json) separates completed backend checks from the blocked UI phase.
The next [saved-plan replay record](audits/2026-10-11/live-agent-qa-missing-project.json) captures a missing registered-project helper failure before implementation.
The [Claude version refusal](audits/2026-10-11/live-agent-qa-claude-version.json)
records the upstream minimum-version requirement after the native launch repair.
The [macOS CLI verification](audits/2026-10-12/claude-cli-2.1.280.json)
records archive integrity, Apple signature and confined offline version checks.
The [Claude process replay record](audits/2026-10-11/live-agent-qa-claude-partial.json)
separates its [settled failure](audits/2026-10-11/live-agent-qa-claude-settled.jpg)
from the [successfully reopened Fixer](audits/2026-10-11/live-agent-qa-fixer-open.jpg).
The [stale Cursor picker](audits/2026-10-11/live-agent-qa-cursor-missing-model.jpg)
records missing live models before a catalog refresh; the SDK receipt still
identifies the actual executed Grok model and effort.
The rebuilt UI shows the [corrected Explorer header](audits/2026-10-11/live-agent-qa-cursor-header-fixed.png)
and [Grok choices under Cursor](audits/2026-10-11/live-agent-qa-cursor-picker-fixed.png).
The [cold-start picker check](audits/2026-10-11/live-agent-qa-cursor-cold-start.png)
records the same catalog after an owned runtime restart.
The fresh upgraded run shows [Explorer dispatch and its first completion](audits/2026-10-12/live-agent-qa-final-parallel.png).
The [completed fresh journey](audits/2026-10-12/live-agent-qa-final.md) has
[sanitized proof](audits/2026-10-12/live-agent-qa-final.json),
[final orchestration](audits/2026-10-12/live-agent-qa-final-complete.jpg),
[settled Cursor output](audits/2026-10-12/live-agent-qa-final-explorer.jpg),
[desktop behavior](audits/2026-10-12/live-agent-qa-final-board.jpg) and
[mobile focus](audits/2026-10-12/live-agent-qa-final-mobile.jpg).

### Desktop runtime ownership after restart

For slow startup, separate the Electron window, web listener, native runtime
and usable chat. `/health` and `/api/health` expose `openCodeStartup` with
`state` (`idle`, `starting`, `ready`, `failed`), `attempt`, and a bounded `code`.
A failed attempt is terminal until recovery starts a new attempt; a listening
web server alone does not establish OpenCode readiness. Older hosts may omit
this additive field. The UI polls startup health once a second with a
three-second request timeout and a 120-second overall health deadline, and
shows an authoritative failure without exhausting transient retries.

Electron logs `[electron] startup phase` durations for shell preparation, server
import/listen, runtime-service connection/recovery and renderer navigation.
`[runtime-bundle] startup phase` records the verified bundle upgrade duration.
A `bundle_lease_recovery` phase means startup settled abandoned control leases
of the selected bundle before verification; `abandoned control leases not
settled: <codes>` means a remaining lease will refuse launch with
`bundle_execution_unsettled`. `bundle_lease_recovery_failed:ENOENT` there is a
process lease with no termination receipt that is not yet old enough to cancel
as never started. `startup upgrade not applied: bundle_execution_unsettled`
is followed by the ledger prefix and the token, state and kind of each held
lease. `[electron] restart recovery preparation failed` records why **Prepare
recovery for restart** was refused.
`startup isolated a record instead of refusing: {…}` names a finished or
derived record that startup set aside (source, code, ledger prefix and key).
After `startup upgrade not applied`, a launch that continues is running the
previous runtime; `/health` lists both conditions under `startupNotices`.
Correlate those with the selected-bundle journal's native startup records;
do not add concurrent phase durations as if every phase were sequential.
A stale service descriptor stops connection retries early only when a fresh
ownership inspection proves the owner stopped. Live or unverifiable owners
retain conservative fencing and the existing bounded recovery transaction.

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

First startup preserves validated setup while creating fresh conversations and journals. Old databases remain unused and do not block startup; later starts reuse the valid v2 selection and retain new work. When a DevRyan update pins a newer OpenCode version than the selected bundle runs, startup clones that bundle onto the shipped runtime and selects the clone (the old bundle becomes `previousBundleID`). It logs `[runtime-bundle] upgraded the selected runtime ...` or `[runtime-bundle] startup upgrade not applied: <code>`; in the second case the runtime is refused before launch with `bundle_upgrade_required` and that code (`bundle_upgrade_owner_active` means another live process still owned the old bundle). The native selector, admission owner and mutation ledger govern updates, removal and rollback. A stale selection revision or unresolved rollback reconciliation refuses admission. Legacy database inspection helpers remain read-only for native v2 files; the old event-pruning pass is not a native maintenance operation.

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

## Startup ownership contracts

The [startup reliability investigation](audits/2026-10-09/startup-reliability/README.md)
records the implementation evidence and remaining acceptance gaps.

`retryRuntimeServiceConnection` bounds the foreground connection at 20 seconds,
extended to 60 only while the service is still booting (no descriptor, a stale
owner, or health not yet ready). A stale descriptor triggers one guarded current-owner
observation: only proved stopped/missing ownership ends the wait early; live or
unverified ownership retains normal retries. Recovery still unregisters, proves
stopped again, and acquires exclusively before persisting app-bound mode.
Each connection attempt receives the retry's absolute deadline. Bootstrap and
desktop-host lease HTTP requests (including lease response bodies and capability
fallback) abort after at most five seconds or the remaining deadline. Health
polling also respects its remaining deadline. Broker admission stores the validated
lease synchronously and starts deferred OpenCode without holding the lease response;
generation publication remains owned by the web runtime-service route.
Startup phase logs report elapsed milliseconds and allowlisted failure codes for
shell environment, server import/listen, service connection/recovery, foreground
preparation, URL resolution, renderer navigation, and service OpenCode readiness.
Service recovery also reports unregister, stopped-owner wait, exclusive
app-bound acquisition and mode persistence separately. These nested durations
retain the same ownership checks and deadlines.

- **Startup health owner**: `src/lib/startup/health.ts` validates optional host startup snapshots and polls health every second with a three-second request deadline and a two-minute overall deadline. `useConfigStore.initializeApp` deduplicates that owner before loading providers then agents; `App` cancels old owners on retry/unmount and exposes authoritative terminal failures through the existing Retry screen. Older health servers retain readiness compatibility, and startup warmup/sync gates remain required.
