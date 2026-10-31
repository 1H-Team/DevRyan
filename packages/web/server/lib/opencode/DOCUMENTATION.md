# OpenCode Module Documentation

`session-execution-host.cancelOwnedCommand` is a constructor-only deadline
recovery boundary, not a tool RPC. It matches a single live shell by canonical
directory/session/message/call identity and waits for supervised settlement;
it never resolves processes by name or a caller-supplied PID. The web deadline
adapter bounds that wait before falling back to existing session recovery.

`createSessionExecutionHost` forwards the ledger's observers: `onDiagnostic`
(maintenance and classification failures), `onLockTiming` (every lock's wait
and hold) and `onWorkerStall` (stalls of 1 s or more of the ledger worker's
event loop, which `application.js` journals as `ledger_worker_stall` beside the
host's own `host_stall`).

`session-execution-host.stopAttemptRuns` is the constructor-only boundary the
managed scheduler calls when a task attempt settles (its durable `runCleanup`):
it cancels the child's shell jobs stamped with that attempt, and unstamped ones
(`none`, `unknown`) reserved before it settled, re-checking each against the
child's current attempt right before its abort, with `stoppedBy: 'task_settled'`.
Leases of managed children carry the attempt (`attemptFor`, from
`childAttempt`); roots and unmanaged sessions carry none.

`session-execution-host.stopSessionRuns` is the constructor-only Stop boundary.
After an accepted user Stop (`OPERATOR_STOP_SOURCES` in `application.js`), it
ends every supervised shell run of the stopped session and its descendants
(ancestry is read from OpenCode), because the native interrupt leaves a
background shell job (a dev server) running. Each run settles through its own
path: the lease is cancelled with `stoppedBy: 'operator'`, the cancelled call
is recorded as a complete empty change receipt, and its view is removed. It
takes no admission hold, unlike `executions.cancelAndWait`, so the next prompt
is not blocked; the run's completion notice is queued without restarting the
conversation (`native-admission-owner.js`). `DEVRYAN_STOP_ENDS_BACKGROUND_RUNS=0`
turns it off. `activeExecutionCalls` lists a session's calls whose supervised
command still runs; the change card reports them as `background_running`
instead of `missing_capture`. A verified termination receipt ends that running
classification even while publication, receipt delivery or cleanup is pending.
Required-check settlement receives up to 16 KiB of retained native output;
`outputComplete` is false when output was acknowledged or truncated. It reads
the existing event buffer and does not retain a second command-output history.
Writer result `metadata.mutationReceipt` includes validated `baseSequence` and
`publicationSequence` when available, so a result can identify the snapshot it
read and the publication it produced without exposing private view paths.

Native shell results retain the execution host's termination and publication
settlement through the native facade. Cancelled, uncertain, unconfined or failed
publication cannot become successful empty output when the native shell catches
an error. Partial output and receipt metadata survive. Ordinary nonzero exits
remain explicit command failures, with their verified exit code; background
completion text and state are projected from the same host evidence. An unknown
cancellation cause stays unknown. These outcomes never authorize command replay.

Root required-check observation captures the canonical original objective and
cancellation generation before command launch and rechecks both at settlement.
The existing observer receives that private scope only while it remains current;
model-supplied objective fields cannot attach evidence to a different objective.

Journal records of native executions carry `executionTier`: native `shell`,
`writer` and `read` kinds are `process`; the native `finish` and deferred
`lease_cleanup` records also carry the lease's session/message/call identity.

DevRyan agent settings use the synthetic `devryan` config key and are stored in
`.devryan/config.json` beside the OpenCode user config. The sidecar reader also
accepts `.openchamber/config.json` and the former `openchamber` config key;
canonical writes are atomic and leave the legacy sidecar available for older
installations. Neither key is written into OpenCode's own config file.
Before the web host starts, managed files under the legacy `.openchamber`
directory are copied into `.devryan`; existing canonical files win. The copy
is retryable after interruption, preserves the legacy tree, and fails visibly
on unsupported entries rather than following symlinks. A completion marker
prevents repeated traversal after a successful copy.

`session-runtime.js` owns the optional Finalizing projection in the existing
session-activity snapshot and event. Trusted native and Cursor constructors
provide exact owner/run identities and monotonic progress through
`updateSessionPresentation`; retirement uses `clearSessionPresentationOwner`.
The server mints a presentation epoch and revision, carries explicit null
clears, and keeps authoritative busy/idle/retry status separate. Unknown,
retired or stale observations cannot renew presentation or execution authority.
Accepted HTTP aborts clear only the presentation generation captured before the
request; a later turn survives a delayed abort response. An absent capture grants
no authority over a subsequently created projection.

`cursor-execution-receipts.js` records the published confined Cursor process's
outer byte receipt and retains every internal call alias. Native `task` calls
also receive exact empty internal coverage receipts, because canonical Cursor
history requires coverage for those wrappers; their bytes remain owned by the
outer process receipt. The outer call is excluded from internal empty receipts
so its published bytes cannot be overwritten by a duplicate. Unpublished leases
cannot provide receipts, and unknown calls retain the existing restore checks.
The owning test connects real mutation publication, reopened history summary and
actual file Undo/Redo. Receipt phase diagnostics observe settlement; they do not
grant execution authority or drive the orchestration save watchdog.
`persistCursorRecord` keeps native persistence and the published receipt drain
inside the existing execution meter. Durable Git work retains that meter, and
only a successfully committed receipt batch advances completion progress.
Failure, an unpublished lease or a memoized same-record no-op provides no
completion progress. The adapter returns true only after awaited owner work,
and false when its exact aliases/receipts already cover the record. This creates
neither an admission nor a new watchdog or diagnostic heartbeat.

The controller's provider policy reads translated native
`configuration.compaction.buffer` before legacy compatibility `reserved`,
including explicit zero. The legacy projector remains a separate boundary.

Cursor runtime-status reads authentication presence through the selected native
integration's credential-metadata owner at the exact registered directory.
It validates the bounded metadata response and returns only the existing
authentication boolean. Owner, readiness and configuration-snapshot fences
remain authoritative. This read does not require a project to belong to the
bundle's immutable configuration-import map; configuration reads/writes and
Cursor Configure retain their separate reviewed-source and execution contracts.

The managed Open Cursor 2.5.17 package remains a compatibility provider behind
`default-config/plugins/devryan-open-cursor.mjs`. The wrapper calls its `server`
factory, keeps local tool aliases filtered and disables its private MCP bridge
by default. Its separate native `setup` factory does not own DevRyan requests.
Web and Electron still execute `cursor-acp` through the shared
`@devryan/cursor-sdk-runtime` with its independently pinned Cursor SDK 1.0.28;
updating the compatibility package does not replace that SDK or its execution,
credential, streaming and cancellation owners.

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management, packaged/project agent discovery, packaged agent runtime sync, and provider authentication.

## Concurrent Revert integration

Only the selected native generation-2 bundle can execute work. Scoped Revert/Redo routes validate the request, capture client-disconnect cancellation and invoke the injected ownership coordinator. There is no generic OpenCode HTTP/snapshot restore fallback.

The native conversation port uses stage/clear with `files: false`, under an exact current mutation-ledger transaction and admission-owner permission. The ledger owns file publication, acknowledged target cancellation, conflict checks and recovery. Unrelated sessions can continue during qualified owned reverts. Imported history and receipts remain inspectable, but pre-capture edits without a native ledger transaction cannot be undone or redone. An interrupted compatibility-only record remains recovery-required; it does not authorize replay on the native runtime.

See the [execution contract](../../../../../docs/CONCURRENT_REVERT.md).

## Native Stop during primary handoff

A Stop durably fences the primary objective before native interruption. If that
fence races a committed `Step.Started` handoff, only the verified selected
artifact contract `devryan.primary-step-stop/1` permits a finite interruption
reply. The host checks the exact live permit, controller, canonical assistant,
objective/execution lineage, one Stop generation advance and unchanged final
cancelled record. It admits no work and acknowledges no continuation. The native
mapper strictly validates that reply, rechecks the permit and invokes its
constructor-owned raw user interrupt before delivering Effect interruption.
This preserves aborted assistant completion, interrupted idle and claim release.
Missing callbacks, legacy artifacts, malformed replies and stale/foreign/held
authority retain the original refusal path. The original HTTP graph exercises
the pending handoff independently of physical-stream Stop qualification.

## Context usage contract

DevRyan forwards OpenCode's provider-reported assistant token payloads without adding source attribution. The shared UI treats the newest token-bearing assistant message as one authoritative active-context snapshot: an explicit provider `tokens.total` wins, otherwise uncached input, cached input read/created, output, and reasoning are summed once. Capacity is resolved only from that same message's `providerID`, `modelID`, and `variant`. If the producing model or its limit is unavailable, the measured total remains visible while capacity, percentage, and free space remain unavailable. No character-count, tokenizer, prompt-category, tool-category, or message-category estimates are generated by this module.

## Bounded environment and executable discovery

`env-runtime.js` keeps its synchronous API and existing explicit/canonical/PATH/fallback precedence. Each environment capture or executable lookup owns a probe runner whose ten-second monotonic deadline begins at its first subprocess. Candidate shells are deduplicated in order. Previously unbounded probes have a five-second ceiling; WSL's existing six-second command ceiling is constrained by the enclosing lookup's remaining budget. Exhausted lookups skip further subprocesses; Node/Bun launch fallback does not repeat an unsuccessful lookup.

Every probe uses `SIGKILL` for timeout termination and rejects execution errors, signals, nonzero exits, malformed output and partial timeout stdout. Environment values and captured shell output are never logged. The internal factory supports injected execution, clock, shell candidates and executable checks; short deadline overrides are test-only dependencies, not settings. `env-runtime.test.js` uses deterministic fakes for host-specific paths plus an isolated short-deadline process that ignores SIGTERM and is verified dead after timeout. Windows and WSL behavior is simulated on non-Windows hosts.

Native Git discovery in `session-execution-host.js` skips only `ENOENT` for unrelated registered roots so removed projects do not block valid siblings; a missing requested cwd, an unowned cwd and other root errors still refuse.
Native writer and shell publication emit scoped `session_execution` finish timing after the mutation runtime and durable change-receipt recording both settle, including publication recovery. This timing observes the existing work without adding admission/deadline checks or replacing its errors; cleanup retains its separate owner and follows the receipt boundary. Fast completions use the existing admission-summary threshold, while failures remain visible.
A native `direct-finish` that presents the token of its own `direct-admit`
for the same directory, session, message, call and tool reuses the canonical
session and message identities that admission verified, instead of reading
both again; the admission is consumed, so a retry or any other call reads
them again. Revert and cancellation remain fenced by the ledger generation in
`finishDirect`; the native permit is still rechecked.

`execution-helper-command.js` resolves Apple's `/usr/bin/git` shim through bounded host-side `xcrun --find git` once per execution host. Helpers execute the selected Git binary inside the same supervisor, directory policy and clean environment; explicit non-shim commands are preserved. Failed selection is refused and can be retried. This avoids repeating Xcode discovery in each helper's empty confined home during native startup.

## Entrypoints and structure
- `runtime-helper-agents.js`: the shared host-owned no-tools title, commit and PR helper definitions, including disabled native `title`. Legacy overlays and final native configuration snapshots use the same policy; native applies it after saved/Slim role resolution so helpers are available without competing automatic title inference. Helpers inherit no pinned model or effort and retain each admitted caller's exact selection.
- `packages/web/server/lib/opencode/index.js`: public re-export boundary for configuration, agents, skills, provider auth, UI auth, and managed plugin setup.
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/question-routes.js`: focused pre-proxy question routes. Pending lists merge OpenCode and Cursor by session/request identity with directory filtering; Cursor replies and rejects settle locally while unknown IDs continue to the generic OpenCode proxy. A Skip request for a verified OpenCode question is translated into one ordered successful reply per question instructing the active turn to use best judgment and state its assumption, because native OpenCode rejection terminates the tool call instead of resuming it. OpenCode listing is bounded by a short abort timeout. When it fails or stalls but Cursor has live cards, the route returns those cards with `X-DevRyan-Question-Partial: opencode` so clients preserve both sources and retry upstream discovery. OpenCode keeps a question answerable after its turn is aborted and then drops the answer. A live question always has its session's turn running. The reply route therefore reads the question list and `GET /session/status` in parallel, both small. If the question's session is not `busy`/`retry`, the route returns `409 { code: 'question_orphaned' }` without forwarding the reply, and the client resends the answer as a new message. Both reads reuse the short listing timeout, and any failure falls through to ordinary forwarding. One residual case: an orphan whose session already runs a newer turn is still forwarded. The DevRyan client discards orphans before it starts a new turn, so only other clients can produce that state.
- `packages/web/server/lib/opencode/cursor-session-title-runtime.js`: retained compatibility coordinator; production Cursor acceptance uses the shared standard title job/outbox.
- `packages/web/server/lib/opencode/standard-session-title-runtime.js`: Provider-neutral titles across native and Cursor sessions. One 30-second deadline allows at most two model attempts: the configured shared helper, then a freshly authorized canonical active-session model after the prior attempt settles and while time remains. An unsettled owner cannot rotate. Only exhausted/unavailable model choices derive a local title. Durable candidates are projected once resolved, wait for authoritative idle/completed-turn evidence, and use native compare-before-rename plus verifying reads. Synthetic procedural instructions remain excluded. Manual renames win.
- `packages/web/server/lib/opencode/session-title-outbox.js`: Atomic private `session-title-outbox.json` under `DEVRYAN_DATA_DIR`. Original candidate/source identity, canonical source message ID, latest accepted human input ID, lifecycle state and failure count survive restart. Three failed persistence cycles use 1s/2s backoff then become durably `paused`; busy/idle-evidence waiting does not consume a cycle. Missing idle evidence pauses after the existing six-observation backoff ladder; restart and late idle signals cannot reopen it. A new verified human input resets that observation cycle. Startup refusal codes defer only while the constructor-owned lifecycle reports its current, still-starting readiness attempt inside the original absolute readiness deadline (normally 20 seconds). Missing, failed, replaced or expired readiness authority restores the three-cycle budget; the window opens at owned startup-attempt creation before restored title jobs run, and pre-bind work cannot renew it. Private busy refusals proven not dispatched defer at the existing five-second interval while the process owner retains its bounded command deadlines; consecutive deferrals are counted (`deferredRetries`) and pause the job at `MAX_DEFERRED_TITLE_RETRIES` (60), so a session that never settles cannot retry forever. Unknown errors, correlated busy replies and unknown statuses retain the three-cycle pause. Waiting does not renew inference, source authority or the 30-second generation deadline. Only the latest canonical accepted human message, unseen by that job, may reopen one bounded cycle. Malformed files are quarantined. Raw prompt text is never stored.
- `packages/web/server/lib/opencode/providers.js`: provider source detection, default Cursor provider bootstrap, and Antigravity model cleanup inside the shared Google provider config. Google auth discovery and disconnect treat `google` and `google.oauth` as aliases. OpenCode merges every existing user config file (`config.json`, `opencode.json`, `opencode.jsonc`) and every project config file, so provider detection and removal both visit all of them through `listExistingConfigFiles` in `shared.js`; removal edits each defining file in place with JSONC-preserving edits (`removeConfigKeyPaths`) and collapses containers it leaves empty. Antigravity source detection recognizes its account pool and models nested under Google configuration; disconnect removes every model the retired plugin wrote (Antigravity- and Gemini CLI-branded, see `antigravity-retirement.js`) while user-authored Google models stay. `listProviderConfigFiles` reports every layer that still defines a provider.
- `packages/web/server/lib/opencode/antigravity-retirement.js`: identifies the Google models the retired Antigravity plugin wrote (`antigravity-*` ids or `(Antigravity)`/`(Gemini CLI)` names) and plans their removal; shared by provisioning and provider disconnect.
- Provider disconnect (`DELETE /api/provider/:id/auth` in `routes.js`) always requests a runtime restart, including for an idempotent disconnect, because the runtime may still hold a provider whose source is gone. With `scope=all` it then verifies the result: `stillProvidedBy` lists every config file, auth-store entry, Antigravity account file, or credential environment variable name (never its value) that still supplies the provider, and the Providers UI reports those instead of claiming success. Antigravity account files are also found under the runtime overlay directories, because the plugin stores them in `OPENCODE_CONFIG_DIR`.
- `packages/web/server/lib/opencode/managed-plugins.js`: single source of truth for DevRyan-managed plugin IDs, exact reviewed versions, installed entrypoints and bundled-plugin runtime dependencies, relative profile registrations, legacy matchers, catalog metadata, migration, and installed-file validation. It pins `opencode-gpt-imagegen@0.1.12` as the reviewed `gpt_imagegen` parser and executor; the native owner supplies explicitly selected OpenAI API-key image access, registers the bundled skill-context adapter for forward managed profiles, and validates the document reader's exact parser packages and entrypoints before managed startup. `cursor-acp` remains a provider ID but is retired as a plugin registration.
- `packages/web/server/lib/opencode/default-plugins.js`: manifest-derived public DevRyan plugin catalog. It annotates matching user/project registrations and files, preserves effective custom specs/source paths, and keeps internal runtime helpers out of Settings.
- `packages/web/server/lib/opencode/provider-integrations.js`: canonical provider metadata helpers for DevRyan-managed provider aliases such as GitHub Copilot, plus auth alias synchronization between `github-copilot` and legacy `copilot` auth keys.
- `packages/web/server/lib/opencode/openai-model-availability.js`: reads secret-free selected-credential metadata and annotates managed OpenAI provider catalogs with `authType`. Native `chatgpt-browser`, existing `chatgpt-token-sharing` and API-key catalogs pass through; retired OAuth rows require sign-in again. No account model request or credential refresh occurs. API-key and external OpenCode catalogs remain provider-driven. Credentials and model IDs are never remapped or exposed.
- `packages/web/server/default-config/plugins/openai-gpt-5-6-models.mjs`: pins ChatGPT OAuth context windows to 1,050,000 for GPT-5.4/5.5/5.6 and 400,000 for GPT-5.4 mini, with a 256,000 auto-compaction threshold for those rows. GPT-5.3 Codex Spark retains its 121,600 context and 115,200 threshold. Its internal `limit.input` includes the resolved OpenCode compaction reservation so OpenCode's subtraction lands on the threshold; shared UI reads context and input capacity from the resolved catalog metadata, without duplicating OAuth model-name overrides; active context and cumulative usage remain separate. Does not attach Codex CLI identity headers on the SIWC path. Direct API-key, unknown model, and non-OpenAI catalogs remain provider-driven.
- `packages/web/server/lib/opencode/github-copilot-models.js`: account-specific GitHub Copilot model discovery using stored OpenCode Copilot auth, success-only in-memory caching, and emergency fallback model metadata. Discovery prefers `model_picker_enabled` models when present. When a modern account payload marks every model non-picker, it retains only API-returned GitHub utility models instead of guessing that every chat row is manually selectable; legacy payloads without capability metadata retain their compatibility behavior. Configured provider catalogs also receive the canonical selectable `auto` model (`api.id = "auto"`) with the complete limits/capability contract required by OpenCode provider listing, and all entries receive runnable `api` metadata.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). Configuration-triggered restarts coalesce and wait until live agents are idle. Before replacing a managed child, restart pauses browser-lease admission, drains and releases the old epoch, and holds admission closed for the complete replacement. It resumes leases only after successful startup and reconciliation. An unconditional finalizer clears restart flags and the shared promise even when pause or resume fails; the actual lease fence remains held so a later restart can recover. Applied settings come from the successfully ready controller snapshot, never a later mutable settings read. Restart decisions combine the event-driven activity snapshot with authoritative `/session/status` queries for known project directories; if live status cannot be verified, the current process is preserved and the check is retried. Health checks never kill a still-running busy process solely because its health endpoint timed out. An unexpected exit of a ready managed server triggers an immediate health check (and so a restart) instead of waiting for the next poll, and every exit is reported through the optional `onManagedProcessExit({ pid, code, signal, uptimeMs, expected, stderrTail })` with a bounded (16 KiB) stderr tail kept after readiness, because a runtime panic prints only there; `server/index.js` journals it as `opencode_process_exit`. `onOpenCodeRestarted` receives `{ restartStartedAt }`, and the managed instance exposes its spawn time as `startedAt`. On POSIX every managed server is tied to its owner by `parent-death-watchdog.js` (SIGTERM, then SIGKILL after about three seconds, because a busy runtime can ignore SIGTERM). A watchdog that cannot start is reported as `managed_opencode_watchdog_unavailable` and the launch is refused. `startCommandParentDeathWatchdog` applies the same contract to a child identified by its exact argv (used for `cloudflared`; see `../tunnels/DOCUMENTATION.md`). When the server exits, its process group is killed so MCP children cannot outlive it; all group signals go through the injectable `signalManagedProcessGroup`.
- Managed OpenCode startup receives only the private loopback `DEVRYAN_ORCHESTRATION_URL`/`DEVRYAN_ORCHESTRATION_TOKEN` pair and fixed `DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS=1` capability marker from the web owner. The private plugin requests root-owner agent execution before plan-safe checks, and scheduler admission repeats owner resolution. Personal account defaults are never written into generated OpenCode overlays or host agent files. Owner-conflict and lost-ownership errors from that callback continue spawn without the bridge instead of aborting OpenCode. User or shell values for those names are removed, external OpenCode receives no bridge, and the bridge owner stops before Cursor/OpenCode teardown.
- Managed Electron startup may additionally inject the exact `DEVRYAN_BROWSER_CDP_DISCOVERY_URL`/`DEVRYAN_BROWSER_CDP_TOKEN`/`DEVRYAN_AGENT_BROWSER_BIN` triple. The discovery URL must be the private IPv4 loopback endpoint and the binary must be absolute. Inherited values for these names and every `AGENT_BROWSER_*` variable are scrubbed; standalone web, external OpenCode, and legacy Tauri receive none of this contract.
- Managed OpenCode startup owns skill-source flags: it removes an inherited `OPENCODE_DISABLE_EXTERNAL_SKILLS` value so `.agents` skills remain available and forces `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` so `.claude` skills are not registered. `resolveApprovedSkills` is authoritative for Settings, warmup, preflight inputs, and managed-agent permissions: locally discovered OpenCode and `.agents` paths establish identity, live runtime metadata may enrich exact matches only, and upstream-only, `.cursor`, `.codex`, `.claude`, hidden, retired, and cache skills are rejected. Every skill-capable managed agent receives the same deny-by-default exact-name/directory policy; explicit complete denial is preserved. Configured external OpenCode runtimes remain read-only and preflight warns that enforcement cannot be guaranteed.
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime. `applyLoginShellEnvSnapshot` (run once at server import) fills only unset or empty `process.env` names from the login shell and skips every value rejected by `login-shell-env-filter.js`, logging the dropped names once (never values). Non-empty launch-environment values are never touched.
- `packages/web/server/lib/opencode/login-shell-env-filter.js`: the single login-shell filter shared with Electron main's merge (`packages/electron/shell-env-inheritance.mjs`). In every runtime it rejects login-shell values that native provisioning refuses (relative or empty `OPENCODE_DB`, any `OPENCODE_HOST` or `OPENCODE_BINARY`, `OPENCODE_SKIP_START`/`DEVRYAN_SKIP_OPENCODE_START` set to `true`, `DEVRYAN_OPENCODE_GENERATION` other than `2`) and any `DEVRYAN_RUNTIME_BUNDLE_ROOT`. Only when `DEVRYAN_PACKAGED_DESKTOP=1` (set by Electron main from `app.isPackaged` before the server import) it also rejects the dev/packaging redirections `DEVRYAN_ELECTRON_DEV`, `DEVRYAN_ELECTRON_USER_DATA_DIR`, `DEVRYAN_EXECUTION_ARTIFACTS` and `DEVRYAN_DEFAULT_CONFIG_ROOT`.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/DevRyan route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime. URL construction reports a temporarily absent managed port with the stable `managed_runtime_unavailable` code and HTTP-style 503 status so managed-child observers can wait through port transitions.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/project-icon-store.js`: serialized, atomic storage for project icon images and their versioned manifest under `<DEVRYAN_DATA_DIR>/project-icons`. New uploads record project ID/path, MIME, source, timestamp, and filename so startup can restore settings metadata or migrate the file when deterministic project identity changes. Unmanifested legacy files are deliberately not adopted.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration and reload semantics. Agent model override saves validate the merged provider/model/effort (and Council members) against the project runtime catalog before writing. Cursor uses its authoritative selection validator, not fallback display metadata. Unavailable selections return 409 with a bounded reason; unavailable/incomplete catalogs return retryable 503. A concurrent configuration change refuses the write. Partial updates persist the validated effective model/effort pair, including explicit provider default, so preset inheritance or sidecar replacement cannot change the inspected selection. Execution admission revalidates independently.
- `packages/web/server/lib/opencode/mcp.js`: MCP config CRUD, source layering, and explicit recovery. Active user MCP detection reads only official config files under `~/.config/opencode` (`config.json`, `opencode.json`, `opencode.jsonc`) so ambient home-folder `~/.opencode/opencode.json*` entries do not leak into DevRyan. Project MCP writes default to `<project>/.opencode/opencode.json` while root-level project `opencode.json` and `.jsonc` remain readable. With a project folder, listing also reads every `opencode.json(c)` and `.opencode/opencode.json(c)` OpenCode 2 discovers in parent folders (`getFolderConfigPaths`), in OpenCode's order: user files, then direct files outermost folder first, then `.opencode` files the same way (so `.opencode` overrides direct), then `OPENCODE_CONFIG`. A parent folder's server reads as `user` scope, update edits the file that defines it and delete removes it from every file that defines it; an unreadable parent file is skipped while an unreadable project file still fails the request. Without a project folder no folder walk happens, so a home-folder `~/.opencode` file is read only for projects inside the home folder, as OpenCode does. Recovery remains available through the explicit recovery API and is not part of normal MCP listing. The server-only Bot assignment adapter may resolve an exact-name, exact-URL, unexpired OAuth access token from OpenCode's private MCP auth cache; that token is never projected to the renderer and is imported through the Bot credential vault.
- `packages/web/server/lib/opencode/mcp-sources.js`: MCP source metadata for active and recoverable config locations using the same user, parent-folder (`kind: 'folder'`) and project order as `mcp.js`; without a project folder, home-folder `~/.opencode` files are excluded from active MCP sources.
Packaged prompts keep final acceptance with Orchestrator under both routing policies: specialist self-checks support, but do not replace, parent inspection of changed behavior. Browser failures require diagnosis and targeted correction rather than repeated broad checks. Specialist acceptance uses the declared command, cwd and environment; only host-attested missing Docker prerequisites become environment-only skips from exact failing receipts, never passes. Specialists complete owned implementation and available checks and may report complete with deferred check reasons when only those attested skips remain; unproven prerequisites stay pending, and application and assertion failures remain failures. Primary agents and specialists continue the original objective through host-owned compaction. Saved-plan Class 1 adjustments include necessary reversible structural/backend corrections preserving the outcome and public contracts; new authority, destructive effects and user-owned product decisions still require Class 2 approval. The Implement template in `packages/ui/src/lib/magicPrompts.ts` follows the same deviation rules, including findings that block verification.

- `packages/web/server/lib/opencode/agents.js`: packaged/project/Slim agent discovery, config resolution, and model override routing. Packaged agents are read directly from `packages/web/server/default-config/agents`; project agents are read from `.opencode/agents`; the built-in agent orchestration layers its preset/root model config over them. The packaged routing contract makes specialists the default implementers: Designer owns visual/UX implementation end to end (including fully specified tweaks, design-specific tests, and visible validation; Orchestrator owns design planning), Fixer owns bounded non-design work, including behavior under an unchanged presentation, and Librarian owns current external documentation. Orchestrator edits directly only mechanical changes with no behavior or presentation effect (typo, comment, wording); every bug fix, however small, goes to Fixer. Mixed scopes must be disjoint, and a failed Designer assignment is never silently reassigned to Fixer. DevRyan's packaged Oracle prompt is focused and read-only by default and uses the `high` reasoning variant for clean-user Slim defaults. Orchestrator may invoke Oracle only as one optional late checkpoint per phase: immediately before presenting a grounded complex plan, or after implementation delegation and initial validation. Focused or deep depth is selected before the sole dispatch, same-dispatch recovery remains one checkpoint, and a completed review cannot escalate into another Oracle call. Orchestrator alone incorporates a plan review before presentation; ordinary delegation reopens for later implementation. After a final implementation/task review, Orchestrator dispatches no more specialists and owns remediation, revalidation, and completion. User model/variant overrides remain authoritative. The built-in agent orchestration keeps DevRyan packaged/project markdown authoritative for prompts, permissions, descriptions, and plan-mode behavior while applying Slim model/variant metadata plus safe `modelResolution` provenance and exposing non-colliding Slim-only custom agents. Management read models remain backward-compatible by exposing normalized `modelRefs` and `councillors`, but those fields are never executable OpenCode frontmatter. Council's ordered model rows live in the versioned `agents/council.models.json` companion; legacy frontmatter remains an input-only migration fallback. `modelResolution` records the active preset, whether the effective value came from the preset or a root override, and the preset model/variant that was overridden; `model` and `variant` remain the executable effective values. Model/variant overrides for DevRyan packaged/project roles are written into `devryan-agents.jsonc` (seeded from a legacy `oh-my-opencode-slim.json[c]` on first write); Council members and overrides for other agents stay in DevRyan's sidecar under `devryan.agentOverrides`. `listManagedRuntimeAgentModelOverrides(workingDirectory, options?)` resolves the effective managed-runtime model map, layering wrapper-mode Slim preset/root values over sidecar overrides only for matching DevRyan packaged/project agents. `listShadowedAgentModelOverrides(workingDirectory, options?)` is the read-only mirror of that layering: per sidecar entry it reports which `model`/`variant` fields Slim shadows (`shadowedBy: 'slim-root' | 'slim-preset'`, with saved and effective values; `councillors` are never shadowed) and never prunes the sidecar. `GET /api/config/agent-overrides` returns it additively as `shadowedOverrides` (`{}` without a directory, or when the Slim config cannot be read).
- `packages/web/server/lib/opencode/slim-config.js`: configuration of the built-in agent orchestration (derived from Oh My OpenCode Slim; not a plugin and always active). Reads user/project `devryan-agents.json/jsonc`, falling back to a legacy `oh-my-opencode-slim.json/jsonc` only where no new-name file exists, with active preset + root agent override merging and normalizes effective model values and preset provenance for Settings. `migrateLegacyAgentsConfig` runs on every configured start (and in clean-user provisioning): it creates `devryan-agents.jsonc` from a legacy user file, keeping its JSONC bytes except `$schema`, never replaces an existing new-name file, leaves the legacy file untouched and never throws (a failure is logged and reads fall back to the legacy file). Project files are never rewritten. `DEVRYAN_AGENTS_PRESET` (then the legacy `OH_MY_OPENCODE_SLIM_PRESET`) overrides the saved preset. DevRyan's packaged and project agents stay the base; this layer supplies their model routing. Restricted managed-user responses retain only the safe effective model, variant, model refs, councillors, and `modelResolution` fields.
- `packages/web/server/lib/opencode/user-profile-provisioning.js`: clean-user provisioning for locally managed OpenCode. It merges the sanitized `default-config/user-profile` declarations into `~/.config/opencode`, pins and installs the manifest-owned Open Cursor, Claude proxy, GPT Image Generation, and Slim packages, preserves unrelated package fields and explicit user overrides, and validates exact installed versions plus entrypoints before startup. Known DevRyan-owned package/Git registrations migrate to local paths in `opencode.json`; exact DevRyan-owned legacy registrations are also removed from older active `config.json`/`opencode.jsonc` layers without rewriting unrelated entries or JSONC comments. The obsolete `cursor-acp` plugin registration is removed while its provider ID remains valid, and arbitrary user/project plugins remain untouched. Retired plugins are listed in `managed-plugins.js` (`RETIRED_DEVRYAN_PLUGIN_SPECS`, `RETIRED_DEVRYAN_PROFILE_DEPENDENCIES`). It synchronizes approved agents plus local adapters through `.devryan/user-profile-manifest.json`; bundled skills are no longer provisioned. A one-time manifest-driven retirement removes untouched legacy skill files, silently adopts user-modified copies, and prunes only empty skill directories. Other user-modified managed files remain conflicts, and `bun install --ignore-scripts` runs only when dependencies changed or local validation requires repair. An unchanged valid profile performs no installation or network work. The packaged profile excludes MCP configuration, Slim `mcps` fields, auth material, generated state, lockfiles, and machine-specific paths. External OpenCode mode skips this mutation path.

Antigravity (`opencode-antigravity-auth`) is retired and no longer provisioned. Provisioning removes DevRyan's former registrations (`opencode-antigravity-auth`, `@latest`, `@1.6.0`, and `./node_modules/opencode-antigravity-auth/dist/index.js` in relative, absolute, and `file://` forms), drops the profile dependency only when it is exactly the pinned `1.6.0` (triggering the pruning `bun install`), and removes the Google models the plugin wrote into `opencode.json` and older `config.json`/`opencode.jsonc` layers, keeping user-authored Google models, provider options, and JSONC comments. Leftover Antigravity account files are credentials and are removed only by an explicit Antigravity disconnect.

Context Mode is retired and no longer provisioned. Provisioning actively removes DevRyan's former registrations (`context-mode`, `context-mode@1.0.169`, and `./node_modules/context-mode/build/adapters/opencode/plugin.js`, including absolute and `file://` forms of that path) from `opencode.json` and older `config.json`/`opencode.jsonc` layers, and drops the profile dependency `"context-mode"` only when its value is exactly `1.0.169`, the only version DevRyan pinned; the resulting dependency change triggers `bun install` so the package is pruned. A user-owned `context-mode` at any other version or spec is left alone. Leftover Context Mode data directories are user data and are never deleted.

Superpowers is retired (2026-10). Writing and executing plans guidance lives in the primary agents (`orchestrator`, `builder`, `plan`). Provisioning removes DevRyan's former registrations (`./plugins/devryan-superpowers.mjs` in relative, absolute and `file://` forms, plus `superpowers@git+https://github.com/obra/superpowers.git`) and the untouched adapter file; the native configuration snapshot ignores those retired registrations when an upgraded setup still lists them instead of refusing startup. The `superpowers`, `using-superpowers`, `writing-plans` and `executing-plans` skill names are retired (`skill-policy.js`), so a leftover copy of the per-turn bootstrap skill or of the plan skills that duplicate the agents' own guidance never reaches agents (the plan-mode Orchestrator loaded `writing-plans` in the 2026-10-24 live QA). User skill folders are user data and are never deleted.

Ponytail is retired (2026-10). Its reviewed input, compiled `devryan.ponytail` registration, mode instructions, `/ponytail` commands and skills are gone. `managed-plugins.js` retires `@dietrichgebert/ponytail` (bare, `@latest`, `@4.10.0`) and `./node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs` in relative, absolute and `file://` forms, so the native configuration snapshot ignores an upgraded setup that still lists it and provisioning drops the registration. A stored mode file (`.ponytail-active`) or default (`ponytail/config.json`) in the OpenCode configuration directory is user data: it is never read, seeded or deleted.
- The managed user-profile registers the document reader and pins `@opencode-ai/plugin@1.18.33`, `adm-zip@0.6.0`, `mammoth@1.12.1`, and `unpdf@1.8.0`. These packages use the same conflict-preserving provisioning and exact installed-entrypoint validation as package-backed managed plugins; configured external runtimes are never mutated.
- `packages/web/server/default-config/plugins/devryan-document-reader.mjs`: managed provider-independent attachment adapter. Its message transform replaces every non-image raw file part with bounded extracted text or a deterministic failure notice, including historical parts that would otherwise poison later turns. CSV/text, searchable PDF, DOCX, and validated ZIP entries are parsed in resource-limited workers; extracted text is newly cached under `.devryan/document-cache-v1` with read fallback to the historical `.openchamber/document-cache-v1` tree. Small documents are inlined, while large documents and verified parent-task documents are available through the session-scoped `devryan_document` list/read/search tool. Scanned PDFs require external OCR, and unrelated sessions cannot address cached documents.
- The reviewed native document transform removes the public plugin surface and constructs cache operations inside `createReviewedDocumentCache` with the native owner's single `/devryan-documents` root. It does not use the public legacy cache fallback; every native cache read and write passes the constructor-bound path and lineage checks.
- `packages/web/server/default-config/plugins/devryan-skill-context.mjs`: same-session skill reuse, Anthropic/Grok catalog compaction, and external-reference routing adapter. Its provider-bound system transform retains every visible skill name and on-demand body while capping descriptions and removing paths/repeated loading boilerplate for Anthropic and xAI aliases.
- `packages/web/server/lib/opencode/default-config-assets.js`: canonical allowlist for distributable defaults: root `opencode.json`, `agents/**`, runtime-filtered `plugins/**`, and sanitized `user-profile/**`. It excludes test/spec/declaration files, lockfiles, generated manifests, auth/credential/secret/log/cache/backup paths, and `node_modules`; provisioning, overlays, packaging share this policy so `default-config` is the sole source asset tree.
- Managed OpenCode startup passes the active preset, enables `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, and writes the active agent configuration as `devryan-agents.json` into DevRyan's generated `OPENCODE_CONFIG_DIR` overlay so the built-in agents (legacy managed runtimes) resolve the same preset/model defaults shown in Settings. The overlay copy always sets `fallback.enabled: false` (and is written as `{ "fallback": { "enabled": false } }` when the user has no agents config): the upstream foreground fallback would otherwise promote the parent task waiter through `POST /experimental/session/{id}/background` and abort the child session, neither of which the adapter's managed prompt gate covers. Model arrays and other fallback keys are preserved; the user's own file is never rewritten. A project `.opencode/devryan-agents.json(c)` (or legacy `oh-my-opencode-slim.json(c)`) that contains any `fallback` object still overrides this, because the schema refills `enabled: true` before merging the project layer over the user layer. In wrapper mode, startup does not exclude DevRyan packaged agents.
- Managed OpenCode startup does not use `--pure` and actively removes an inherited `OPENCODE_DISABLE_DEFAULT_PLUGINS` value from the child environment; OpenCode applies either switch before loading config plugin origins and would suppress DevRyan's bundled managed-orchestration and Council tools. The generated runtime overlay is the allowlist owner instead.
- `packages/web/server/lib/opencode/packaged-agents.js`: packaged default agent reader for release-bundled markdown agents. It joins `agents/council.models.json` into the Council management read model without copying that metadata into executable markdown. `renderAgentPromptPolicies(prompt, policies?)` renders `<!-- devryan:if [!]<policy> -->` … `<!-- devryan:end -->` line blocks against `resolveNativeHarnessPolicies(process.env)`, so a default-off harness capability (`contextProjection`) costs no prompt bytes until enabled; unknown policy names or unbalanced blocks throw. Packaged prompts, project agent copies and the runtime agent files written by `syncPackagedAgents` all carry the rendered text, which is stable for the life of the process.
- `packages/web/server/lib/opencode/packaged-agent-sync.js`: materializes release-bundled packaged agents into DevRyan-managed OpenCode runtime agent files so managed OpenCode can execute them natively. Startup uses this as a stable packaged baseline, strips management-only `modelRefs`/`councillors` from executable frontmatter, and does not inject project-specific skill visibility or user model defaults into the global packaged files.
- `packages/web/server/lib/opencode/runtime-agent-overlays.js`: materializes user-scoped agent model/variant overrides, including effective Slim wrapper preset/root values, project-specific visible-skill policy, active project/worktree and process-wide DevRyan-data external-directory permissions, allowlisted active plugin registrations, bundled runtime plugin files/registrations, Anthropic OAuth proxy bootstrap config, managed runtime MCP timeout overlays, and blocked ambient MCP tombstones into a DevRyan-managed high-precedence OpenCode config directory for managed runtimes. The DevRyan-data rule resolves `DEVRYAN_DATA_DIR` or falls back to `~/.config/devryan`, so one managed OpenCode process can access DevRyan-owned files for every project without granting unrelated `~/.config` content. Executable agent markdown contains only OpenCode-supported runtime fields: DevRyan management metadata such as `modelRefs` and `councillors` is stripped from packaged, project, legacy, Slim-derived, and override-generated frontmatter. Council's resolved ordered `{ model, variant? }` rows are written atomically to the version-1 `agents/council.models.json` companion, tracked in overlay reconciliation, and removed when stale; the Council plugin prefers this companion and parses legacy frontmatter only as an input migration fallback. The overlay disables OpenCode's built-in `title` agent because DevRyan owns title generation. It configures the hidden no-tools `devryan-title` helper used for selected-model title generation; the helper uses the selected session provider/model without inheriting its reasoning variant. Project/package markdown remains the prompt/behavior source; generated overlay files replace only user-owned model fields and runtime-only permission policy, and use an empty-string variant sentinel to clear inherited project variants because OpenCode rejects YAML null and deep-merges omitted fields. Wrapper-mode override resets rematerialize the active Slim preset values on the next sync, so existing Slim configuration requires no migration. User-scoped remote MCP servers without an explicit timeout receive a generated runtime-only timeout so unavailable global MCP servers cannot hold first-turn tool resolution for the full OpenCode fallback delay. Active OpenAI auth, `OPENAI_API_KEY`, or provider config receives runtime-only liveness bounds: 120 seconds for response headers, 300 seconds between stream chunks, and a 15-minute total request deadline. Explicit numeric values and `false` remain authoritative; every startup sync replaces stale DevRyan-generated values, and a later sync removes the generated provider-options row when OpenAI is no longer active. Bundled plugin test/type files are excluded, while bundled runtime plugins—including the bounded Builder incomplete-todo continuation guard—are copied into `plugins/` and registered as local `./plugins/*` entries. A local plugin already declared by user/project config remains source-owned: the overlay neither restates that filesystem spec nor registers a packaged plugin with the same filename, preventing the same hooks and tool schemas from loading twice; removing the source entry restores the packaged registration on the next sync. Active package plugins are filtered through the managed-runtime allowlist so broad tool-surface plugins such as GitHub grep do not leak into managed OpenCode by default. Direct OpenAI model rows remain authoritative: the timeout overlay never creates models or provider availability, while the bundled GPT-5.6 plugin defaults advertised reasoning options and variants from `reasoningSummary: "auto"` to `"detailed"` without filtering provider reasoning text, removes unsupported `none` reasoning variants from managed OAuth and API-key catalogs, prunes unsupported OAuth rows, deep-merges literal `max`/`ultra` variants only into advertised Sol/Terra rows, preserves provider-advertised `max` metadata for Luna/Luna Fast while removing unverified `ultra`, and adds the Codex identity headers required by OpenCode's Luna Responses Lite transport only while OpenAI OAuth is active. Supported-model catalog normalization preserves explicit summary values; the final request hook enforces detailed summaries independently of the chosen reasoning effort. Exact GPT-5.3 Codex Spark and its existing Fast alias have a separate unsupported-summary capability: both model options/variants and final request options omit `reasoningSummary` entirely while preserving effort (including High), encrypted reasoning and unrelated provider metadata. An explicit runtime `model.api.id` determines this capability before a catalog alias. The exception is grounded in the retained 2026-09-05 Spark Explorer provider 400 for `reasoning.summary`, not a general restriction on OpenAI reasoning models. No-op normalization preserves input references. It never synthesizes model IDs or Luna Max variants; apart from the explicit none-variant and summary policies, API-key catalogs remain provider-driven, and external catalogs are unchanged at this boundary.
- `packages/web/server/lib/opencode/runtime-surface-policy.js`: central managed-runtime tool-surface policy for allowed manifest-backed local registrations, blocked MCP tombstones, forbidden live tool IDs, and the 200-tool context-review threshold used by overlay generation and harness preflight diagnostics. Known DevRyan legacy package/Git specs are rejected at runtime instead of being re-resolved.
- `packages/web/server/lib/opencode/skill-policy.js`: shared visible-skill policy helpers used by settings routes and packaged-agent runtime sync so hidden/removed skills cannot remain allowed through managed agent configs. The retired `test-driven-development` and `subagent-driven-development` names are denied across every discovered source, including project `.agents` and other harness directories.
- `packages/web/server/lib/opencode/agent-runtime-warmup.js`: non-fatal startup warmup runtime for read-only OpenCode checks, optional Cursor SDK prewarm, capped visible skill reads, and Grok tool-catalog prefetch. Directory-keyed single-flight shares concurrent client and server calls.
- `packages/web/server/lib/opencode/xai-tool-catalog-runtime.js`: shares model-catalog refresh jobs by directory/provider/model, with an owned 20-second deadline covering auth-header preparation, fetch, and JSON parsing. Refresh waits for a bound project directory, including provider-route refreshes resolved from request context. Caller cancellation only ends its own wait; already-aborted callers start no work. Private provider-discovery reads have their own 20-second bound and may be cancelled by their caller. Late or disposed results cannot populate the cache. Valid empty catalogs count as successful refreshes; failed/invalid catalogs do not. `dispose()` cancels owned reads and permanently disables periodic refresh; the separate cold-prompt wait keeps its existing budget.
- `packages/web/server/lib/opencode/project-prewarm-runtime.js`: best-effort startup/restart coordinator that waits for OpenCode readiness, sequentially warms known existing project directories, continues after per-directory failures, and supersedes stale loops by generation.
- `packages/web/server/lib/opencode/turn-timing.js`: in-memory first-turn timing diagnostics for client/proxy marks, Cursor SDK bridge marks, and observed OpenCode session/message/part events. Operational renderer marks record confirmed empty tool-input and blank inference stalls even when opt-in stream diagnostics are disabled, with only sanitized identity, source, and elapsed duration. Terminal assistant errors include a normalized transport-failure kind and elapsed time. Prompt acceptance and terminal failure also capture active-total and same-provider concurrency as explicitly evidence-only context; activity is keyed by session and cleared on authoritative idle, deletion, or record eviction. Once a correlated tool call reaches a terminal state, later stale active-state events cannot make it non-final again. The capped ordered history also exposes the latest observed tool call separately, so a late-turn pending call remains diagnosable after the history cap.
- `packages/web/server/lib/opencode/harness-result.js`: additive response-envelope helpers for diagnostics and low-risk runtime endpoints. Helpers preserve existing payload keys and add harness metadata with status, summary, next actions, artifacts, and recovery guidance.
- `packages/web/server/lib/opencode/harness-preflight.js`: read-only harness preflight diagnostics for agents, skills, MCP/tool manifest state, effective prompt-policy-aware forbidden managed-runtime tool/MCP exposure, oversized live tool catalogs, latest warmup state, packaged prompt context-budget audit, and optional session-scoped Anthropic usage. Session usage is reduced to provider token counters before it reaches the response or journal; message content and parts are discarded. When the active Anthropic provider resolves to a safe loopback Meridian proxy, preflight joins the recovered SDK session to its latest telemetry row and exposes only raw/eager/deferred tool counts. Every completed preflight may emit one bounded `anthropic_context_preflight` journal record containing only the sanitized runtime, usage, and catalog counts. Catalogs above 200 tools produce a review warning, not automatic deletion, because active agent and user integration requirements remain authoritative. An injected config credential scan adds `literal-credential-in-config` warnings (key path and credential kind only) and `config-credential-scan-unavailable` warnings for existing layers that cannot be read, and the response always carries a `configCredentialScan` coverage summary so an unavailable scan is never reported as clean.
- `packages/web/server/lib/opencode/config-credential-scan.js`: report-only scan of raw, pre-substitution OpenCode config layers (user, legacy user, `OPENCODE_CONFIG`, project, and project `.opencode`) for literal credentials in `mcp.*.environment`, `mcp.*.headers`, `provider.*.options.apiKey`, and `provider.*.options.headers`. `{env:...}` and `{file:...}` references are allowed. Results contain only layer paths, key paths, credential kinds, and per-layer availability; values, parser messages, and read errors are never returned or logged.
- `packages/web/server/lib/opencode/harness-tool-manifest.js`: lazy, read-only OpenCode tool discovery for harness preflight. It reads `/experimental/tool/ids` for every requested preflight and, only when both model selectors are present, reads `/experimental/tool` with the selected directory/provider/model. Each endpoint has an independent abort timeout (five seconds by default); endpoint, payload, authentication-header, timeout, and transport failures become explicit redacted unavailable measurements without returning upstream URLs, credentials, or response bodies.
- `packages/web/server/lib/opencode/harness-context-budget.js`: report-only UTF-8 byte accounting for parsed packaged agent prompt bodies, visible skill catalog name/description values, visible on-demand skill bodies, and the live tool ID/description/parameter catalog. Its Anthropic section projects original/transformed fixed-prefix catalog bytes and keeps provider-reported fixed-prefix, first/latest turn, request-count, active-context, cumulative-input, cache-TTL, eager/deferred-tool, and sanitized runtime-version measurements separate. Tool diagnostics retain the raw catalog while reporting unique IDs, duplicate occurrence bytes, and exact duplicate-definition fingerprints; raw definitions are never journaled. It never estimates missing token counts. The diagnostic uses the shared canonical-path skill visibility policy, reports packaged prompt provenance (`prompt`, `body`, or `contentFallback`), and labels tool measurements `runtimeCatalogUpperBound`.
- `packages/web/server/lib/opencode/claude-credential-projection.js`: `claudeKeychainService`, Claude Code's keychain item name for a config directory. Only clone and setup migration of Meridian-era Claude profiles use it; DevRyan never reads the item.
- `packages/web/server/lib/opencode/runtime-restart-reconcile.js`: after a managed OpenCode restart, settles sessions that `session-runtime.js` still lists as busy or retrying from before the restart. Each session's directory comes from its cached or fetched session info; the restarted runtime's `/session/status` is read once per directory (five-second timeout). Only sessions it reports idle are settled: the lifecycle turn is marked `failed/runtime_exit` and a synthetic `session.status` idle is published through the normal event path (session snapshots, journal, UI stores). Sessions still live, Cursor sessions (they survive an OpenCode restart), sessions updated after the restart began, and directories whose status cannot be read are left untouched. Each pass journals one `opencode_restart_reconciled` lifecycle record with counts.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/terminal/process/server teardown.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/opencode-update-check.js`: Fixed-URL npm registry lookup of the latest stable upstream OpenCode 2.x release for `GET /api/config/opencode-update-check`; no installer.
- `packages/web/server/lib/opencode/opencode-update-runtime.js`: Pure historical version normalization for offline QA; no runtime updater or network lookup.
- `packages/web/server/lib/opencode/version-policy.js`: Target external OpenCode runtime policy. DevRyan recommends `anomalyco/opencode` v1.18.33 and surfaces the upstream install command. On Unix, managed startup prefers the canonical `~/.opencode/bin/opencode` installer path over PATH shadows, while explicit settings/environment overrides remain authoritative.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/devryan-routes.js`: DevRyan update and models metadata route registration.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
  Managed icon-image persistence delegates to the multi-user project record, which
  clears principal caches and publishes the same scoped metadata invalidation used
  by selected icon, color, and background updates.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows. Skill lifecycle actions are distinct: `POST /api/config/skills/:name/hide` records the canonical skill path in `hiddenSkills` without changing files, `POST /api/config/skills/hidden/restore` makes a hidden skill visible again, and `DELETE /api/config/skills/:name` permanently removes only the exact discovered skill directory. Path-qualified hide/delete requests use strict identity matching. Successful mutations append their exact scope to the shared revisioned configuration-apply batch and never infer a restart from historical session state.
- `packages/web/server/lib/opencode/config-apply-runtime.js`: route adapter for the shared revisioned configuration-apply coordinator. It exposes status, managed wait/force apply, external-runtime acknowledgement, and the legacy reload compatibility alias without owning restart policy.
- `packages/web/server/lib/opencode/plugins-readonly.js`: read-only OpenCode plugin discovery for Settings. Lists top-level `plugin` config entries plus user/project files from both OpenCode's singular `plugin/` directory and DevRyan's plural `plugins/` compatibility directory without mutating plugin lists. Same-named files at distinct paths remain distinct because both can execute. The neighboring Slim setup routes are explicit Settings actions and do not make the plugin list itself editable.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization), including the versioned theme-catalog migration that preserves legacy Default selections after built-in theme IDs change. Writes use a `settings.json.tmp-<pid>-<ts>-<rand>` sibling plus rename, remove that temporary file when the write fails, and sweep temporaries older than a day (left by a process killed mid-write) once per runtime through `cleanupStaleAtomicFiles`.
- `packages/web/server/lib/opencode/notification-settings.js`: canonical six-event notification-template defaults and total-shape normalization shared by host settings migration and managed-account projections.
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep. `lastDirectory: ''` is kept as written: the UI sends it when the last project is removed, and every reader (startup warm-up, the legacy last-directory-to-project migration, working-directory resolution) treats it as unset.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.
- `packages/web/server/lib/opencode/proxy.js`: native API readiness gating, scoped-revert registration, projected SSE routes, and the typed browser facade. Missing or unsupported runtime identities fail before dispatch. Prompt timing records send and successful acceptance without logging bodies. Transcript responses and hub events drop diff patch text before delivery; unknown routes terminate locally. No legacy generic HTTP/SSE forwarding remains.
- `packages/web/server/lib/opencode/diff-summary.js`: diff-snapshot trimming shared by HTTP responses and the live stream. `stripMessageDiffSummary` drops `info.summary` outright for managed orchestration, `stripMessageDiffContent`/`stripSessionDiffContent` keep file/status/additions/deletions but remove `patch`/`before`/`after`/`from`/`to` bodies, and `stripEventDiffContent` applies the same trim to `message.updated`/`session.updated` SSE payloads (identity for every other event type, same reference when nothing changed). It is composed into the browser fan-out transform below, so replay and fan-out never carry patch bodies.
- `packages/web/server/lib/opencode/tool-attachment-summary.js`: tool media trimming for browser payloads. Since OpenCode 2.1.3 an MCP result keeps supported media inline and `v2/projection/tools.js` projects each `file` item into `state.attachments` with the whole `data:` URI. `stripToolPartAttachmentData`/`stripMessageToolAttachmentData`/`stripEventToolAttachmentData` keep data URIs up to 32 KiB and replace larger ones with `url: ''` plus `devryanOmitted: { bytes }` (same reference when nothing changed). The facade message page, the single-message route and the Cursor history shadow apply it through `toBrowserMessageRecord`; `stripBrowserEventPayload` (diff trim, then this trim) is the `transformEventPayload` of the global message hub in `application.js` and `event-stream/runtime.js`. The renderer fetches full media on demand with `GET /api/session/:sessionID/message/:messageID?attachments=inline`, which skips only this trim (any other `attachments` value is a 400) and keeps the route's session authorization. Kill switch: `DEVRYAN_TOOL_ATTACHMENT_OMIT=off`, read on every use, keeps every attachment inline.
- `packages/web/server/lib/opencode/tool-output-trim.js`: history pages without finished tool output. `GET /api/session/:sessionID/message?toolOutput=omit` (facade `v2/facade-routes.js` and the Cursor override in `routes.js`) replaces a completed `read`/`list`/`ls`/`webfetch`/`websearch`/`codesearch` part's `state.output` with `''` plus `outputOmitted: true` and `outputBytes` (UTF-8); any other `toolOutput` value is a 400. Tools whose output the UI derives state from stay full (task/devryan_task, skill, todowrite, question, grep/glob search paths, bash preview link and user-shell card, edit-like rows). The default response, `GET /api/session/:sessionID/message/:messageID` (which the UI uses to restore one message on expand), the live stream and every server-side reader stay full. In the Cursor override only upstream records are trimmed: Cursor runtime records have no by-id route.
- `packages/web/server/lib/opencode/sqlite-driver.js`: dependency-free SQLite driver resolution shared by the native runtime bundles, clone verification and the QA/package lanes. `resolveSqliteDriver({ order? })` loads `better-sqlite3`, then `node:sqlite` when the native binding targets another Node ABI, then `bun:sqlite` under Bun, and exposes one adapter surface (`pragma`, `prepare`, `exec`, `transaction`, `close`); with none available it throws an error starting with `NO_SQLITE_DRIVER_PREFIX`.
- `packages/web/server/lib/opencode/session-scoped-revert.js`: route validation, disconnect cancellation and lifecycle diagnostics for native ownership-coordinator Revert/Redo. Missing coordinator capability refuses mutations before runtime or filesystem effects. The retained unified-patch parser/application helpers are pure utilities; they do not connect to a legacy runtime or restore OpenCode snapshots.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime and sole owner of canonical raw-event side effects. WebSocket/SSE bridges only transport hub entries and cannot journal, time, audit, cache, or process evidence.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Default-config ownership and safety

The agent orchestration formerly shipped as the Oh My OpenCode Slim plugin is built into the native runtime (`runtime-host/native-core-registrations.js`); its code is the workspace package `packages/agents-core`. Its adapter, npm package and every spec an upgraded setup still lists are retired in `managed-plugins.js`: they load nothing, Settings does not list them, and provisioning removes the tracked adapter and DevRyan's exact 2.2.25 pin. Tauri retains its pinned legacy loader.

Clean-user provisioning writes only the conflict-tracked baseline for managed runtimes. Claude is OpenCode's built-in `claude-agent` provider (see `runtime-host/DOCUMENTATION.md`); provisioning retires the former `opencode-with-claude`/Meridian dependencies, the Claude Agent SDK/Claude Code overrides at the exact versions DevRyan pinned, and its `.devryan/meridian-sdk-features-policy.json` and `.devryan/claude-runtime-compatibility.json` markers. Other user overrides stay user-managed. Runtime overlays are separate, project-scoped launch artifacts: they carry model, permission, and plugin registration state without rewriting profile files. Configured external OpenCode runtimes remain read-only, and a source-owned local plugin suppresses the same-named packaged registration to avoid duplicate hooks and tool schemas.

Web/Electron overlays both inventory the packaged runtime plugins, including the always-on `devryan-skill-context.mjs` adapter; maintenance-only Tauri assets intentionally remain frozen without it. The `devryan-tool-input-guard.mjs` hook rejects known binary paths before native `read` or `oc_read` executes, replaces unexpected signature/control-character binary results before persistence, and removes historical binary read payloads only from provider-bound request copies. Proper image attachment parts, SVG, ordinary UTF-8/Unicode text, unrelated tool output, and canonical historical records remain unchanged. Binary input rejections retain `DEVRYAN_TOOL_INPUT_INVALID`; sanitized results use the bounded `DEVRYAN_BINARY_READ_BLOCKED` notice. The same hook rejects a `grep.path` containing multiple absolute targets and never splits paths or repairs input. It also validates absolute paths for `read`/`oc_read`, `edit`/`multiedit`/`patch`/`write`, `grep`/`glob`/`list`, and `bash`/`shell` `cwd`/`workdir` before OpenCode mints its `external_directory` prompt: a degenerate path (over 512 characters, over 40 segments, a segment over 255 bytes, a segment repeated four times, or `//` after a non-existent prefix) or an outside-project path under a directory that does not exist is rejected with `DEVRYAN_TOOL_INPUT_INVALID` naming the deepest existing ancestor, so the model self-corrects instead of the user approving a directory that is not there. Relative paths, non-strings, paths inside the project, existing paths, and writes whose external parent exists are untouched, so OpenCode's own prompt still fires for real external paths. Externally managed OpenCode servers remain responsible for their own tool execution policy.

## Public exports (auth.js)
Desktop/web OpenAI sign-in uses OpenCode's reviewed `opencode.provider.openai`
plugin and `chatgpt-browser` method, exposed as **Codex browser (legacy)**.
API key is the other visible method. Existing `chatgpt-token-sharing` credentials
keep working for chat but are hidden for new enrollment. Retired `chatgpt-siwc`
and `chatgpt-headless` rows remain removable and require one new sign-in.
Token-sharing rows mislabeled as browser credentials (`metadata.clientID`)
remain unavailable. Stored rows do not block startup; method-changing startup
migration writes remain logged no-ops.

`runtime-host/native-openai.ts` owns admission and selected-credential proof,
sharing serialized resolution/commit primitives with xAI. OpenCode refreshes
inside that commit. The physical hook enforces the exact method-specific HTTP
route: `/backend-api/codex/responses` on `chatgpt.com` for Codex, or public
`/v1/responses` for existing token-sharing credentials. It re-stamps Authorization
and only Codex's actual stored account ID. OpenCode owns request encoding and
response parsing. The Node OAuth coordinator does not refresh these tokens.

Generic `/api/provider/openai/oauth/{authorize,callback,cancel}` routes require
direct loopback administrator transport and CSRF before parsing. The facade
starts the automatic callback flow; callback polls `oauth.status` once and returns
pending, complete, failed or expired. The UI polls every 1.5 seconds, can cancel,
and hides sign-in on remote/non-admin surfaces. Normal Disconnect removes the
credential; it does not revoke consent at OpenAI.

OpenCode's Codex model list and context limits remain authoritative. Existing
token-sharing connections retain DevRyan's context pinning. Quota reuses the
selected Codex access token and actual account ID for `/wham/usage`, without
refresh or a second enrollment. Other OAuth methods return usage unavailable.
Usage publishes only provider windows and opaque connection identity, never a
credential. Managed users on OAuth still fail with
`bot_opencode_provider_authentication` (401). The `bot_*` OAuth error codes are a
fixed contract between the host coordinator and the default-config plugin.

- `readAuthFile()`: Reads and parses `~/.local/share/opencode/auth.json`.
- `writeAuthFile(auth)`: Writes auth file with automatic backup.
- `removeProviderAuth(providerId)`: Removes a provider's auth entry.
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `readProviderAuthRecord(providerId, options?)`: Reads and defensively clones
  only one selected host provider record without returning the complete store.
- `writeScopedProviderAuthRecord(options)`: Atomically writes exactly one
  provider to a private `0600` scoped `auth.json`.
- `readScopedProviderAuthRecord(options)`: Reads the selected scoped record and
  rejects a file containing any additional provider.
- `AUTH_FILE`: Auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`, `CUSTOM_CONFIG_FILE`: Path constants.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants. Agents use PACKAGED and PROJECT; commands/skills still support USER and PROJECT.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter. A write replaces the file atomically through `writeFileAtomicSync`.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom).
- `writeConfig(config, filePath)`: Writes config with automatic backup. The file is replaced atomically through `writeFileAtomicSync` from `@devryan/harness-runtime/lib/atomic-file.js` (same-directory temporary file, fsync, rename; an existing file keeps its mode, a symlink, dangling or not, is followed, a read-only file is refused), so OpenCode's watcher or a crash never sees a partial config. `removeConfigKeyPaths` uses the same replace.
- `getJsonEntrySource(layers, sectionKey, entryName)`: Resolves which config layer provides an entry.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates.
- Agent identity, prompt, mode, permissions, description, and other markdown-owned fields are read-only through the server. Project agent changes are made by editing `.opencode/agents/*.md` directly; packaged agents are not user-authored config, but managed local OpenCode startups materialize the stable packaged baseline into `~/.config/opencode/agents/*.md` and track ownership plus a top-level applied packaged-set hash in `~/.config/opencode/.devryan/packaged-agents.json`. User config may only store model/variant overrides, plus Council councillor model rows, under `devryan.agentOverrides`; `/api/config/agents` continues to expose normalized `modelRefs` and `councillors` as management metadata. Managed runtime overlays serialize only scalar OpenCode model fields into executable frontmatter and keep Council rows in `agents/council.models.json`.
- Packaged specialist prompts use ordinary Markdown result headings and a final `**Status:** complete|blocked` line. Tool-shaped XML result wrappers are prohibited because some providers interpret them as function calls; historical XML transcript rendering remains a UI compatibility concern only.
- Command/skill project-scoped creates/writes default to `.opencode/` paths when a working directory is available; user config is the fallback only when no project directory exists or user scope is explicitly requested.
- `getFolderConfigPaths(workingDirectory)`: every existing `opencode.json(c)` and `.opencode/opencode.json(c)` OpenCode 2 discovers from the project folder up to the filesystem root, lowest priority first (direct files outermost folder first, `.json` before `.jsonc`, then the `.opencode` files the same way); the global config folder's files are left out. Only MCP reads use it so far.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Recursively finds all SKILL.md files.
- `addSkillFromMdFile(skillsMap, skillMdPath, scope, source)`: Parses and indexes a skill file.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)`, `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`

- `GET /api/config/opencode-update-check`
  - `POST /api/opencode/directory`
  - `GET /api/behavior/agents-md`
  - `PUT /api/behavior/agents-md`
- `GET /api/provider/:providerId/source` reads the default location when the requested project directory is not a reviewed native location (`native_provider_configuration_location_unreviewed`), as Claude quota inspection does. Expected 4xx refusals with a bounded code log one line without a stack.
- `POST /api/provider/cursor-acp/configure`
- `GET /api/provider/cursor-acp/runtime-status`
- `DELETE /api/provider/:providerId/auth`
- Owns lazy auth library loading for provider auth checks/removal; tests may inject the auth library through `registerOpenCodeRoutes` dependencies to keep route behavior independent from module-cache ordering.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.
- `GET /api/config/opencode-resolution` reports verified bundled runtime identity and readiness. The standalone runtime update endpoint is retired; OpenCode updates ship through DevRyan updates.
- `GET /api/config/opencode-update-check` (`opencode-update-check.js`) is an authenticated, read-only, click-driven lookup of the latest upstream release: it fetches only `https://registry.npmjs.org/@opencode%2Fcli/latest` (10 s timeout, 256 KiB body cap, no credentials, redirects refused) and returns `{ latestVersion }` for stable `2.x.y` versions with `Cache-Control: no-store`. Any other outcome is 503 `{ error: 'opencode_update_check_failed', code }` with `code` one of `opencode_update_registry_unavailable`, `opencode_update_registry_timeout`, `opencode_update_metadata_invalid`, `opencode_update_version_unsupported`. Managed users need the About settings page. It installs nothing.
- Global behavior routes delegate to `global-agents-md-runtime.js`. The runtime reads and writes `~/.config/opencode/AGENTS.md`, appends a missing final newline, removes the file for whitespace-only content, enforces a one-MiB UTF-8 limit, and persists before refreshing managed OpenCode. Refresh failures return saved content with `runtimeApplied: false` and a warning; external OpenCode connections are read-only.
- `DELETE /api/provider/:providerId/auth?scope=all&directory=<active-project>` removes auth, user, custom, and only the explicitly resolved active-project config. It returns per-source removal results plus refreshed sources and always invalidates provider runtime state, including idempotent retries that only need to flush a stale catalog.
- `POST /api/provider/cursor-acp/configure` verifies Cursor SDK auth/model discovery without writing OpenCode bridge config.
- `GET /api/provider/cursor-acp/runtime-status` reports Cursor SDK execution auth and dashboard usage-token status independently as `sdkAuthConfigured` and `usageAuthConfigured`, plus Cursor worker mode/readiness/restart diagnostics.
- `GET /api/session/status` merges Cursor SDK runtime busy/idle status into the proxied OpenCode session status payload, falling back to Cursor-only status when upstream status is unavailable.
- Every `POST /api/session/:sessionID/prompt_async` applies the shared provider/agent tool policy before Cursor interception or generic proxying. Packaged Orchestrator sends merge `task: false` with any provider-specific restriction, including Copilot's optional Resend namespace limits, so web and Electron forwarding preserve the same managed-only contract as the shared UI runtime overlay.
- Accepted non-Cursor `POST /api/session/:sessionID/prompt_async` requests schedule non-blocking provider-neutral title generation with the directory and visible non-synthetic text captured at acceptance. Derived and selected-model candidates are atomically enqueued before their synthetic `session.updated` projection. Every provider waits for authoritative idle or completed-turn recovery before compare/PATCH/read verification; canonical idle, update, and delete events plus successful session-list loads drive durable reconciliation and bounded-concurrency placeholder recovery. Managed children that bypass the public prompt proxy recover from their canonical session updates and lists. This changes no public HTTP or SSE contract. Cached schema-verified Grok duplicate-tool disables merge synchronously, while discovery and refresh never block the prompt.
- Intercepted `cursor-acp` prompts schedule the same non-blocking shared helper/title outbox after acceptance, with the canonical accepted message ID. Native compare-before-rename preserves manual names.
- `GET /api/config/providers` preserves native model metadata and existing Copilot/Cursor merging. OpenAI availability reads only selected credential metadata in the requested reviewed location, falling back to the default reviewed location for unreviewed project directories. API-key and built-in ChatGPT catalogs pass through; retired sign-ins mark models `reauthorization_required`. External catalogs remain unchanged. Failed upstream catalogs retain integration providers with `catalogIncomplete: true`.

## Public exports (question-routes.js)
- `QUESTION_PARTIAL_HEADER`: response header name used to identify which pending-question source is temporarily unavailable.
- `QUESTION_ORPHANED_CODE`: the `code` of the 409 refusal for a reply to a question whose turn already stopped.
- `registerQuestionRoutes(app, dependencies)`: registers `GET /api/question`, `POST /api/question/:requestID/reply`, and `POST /api/question/:requestID/reject` before the generic proxy. Cursor settlement emits events in the Cursor question runtime, so routes do not publish duplicate lifecycle events. For a verified OpenCode request, the reject route preserves the client-side Skip contract while replying upstream with ordered best-judgment instructions so the same assistant turn resumes. An MCP elicitation (`source.type: 'mcp-elicitation'`) is declined instead: Skip falls through to the plain reject, which cancels the form.

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent? })`: creates runtime-owned state machine and APIs for session status.
- Returned API:
  - `processOpenCodeSsePayload(payload)`
  - `getSessionActivitySnapshot()`
  - `getSessionStateSnapshot()`
  - `getSessionAttentionSnapshot()`
  - `getSessionState(sessionId)`
  - `getSessionAttentionState(sessionId)`
  - `markSessionViewed(sessionId, clientId)`
  - `markSessionUnviewed(sessionId, clientId)`
  - `markUserMessageSent(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `clearSessionActivity(sessionId)`
  - `dispose()`

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: starts/replaces only the explicitly verified native generation-2 owner and waits for its catalog. Replacement drains the exact owned child and browser leases. Missing artifacts, legacy/external configuration and inherited process identity fail closed; no PATH discovery, installer or arbitrary-port process termination remains.
- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForPendingStartup()`: awaits the current boot or queued restart without starting a new attempt; propagates its failure.
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `isStartupReadinessPending()`: content-free observation of the current startup attempt's original readiness deadline; never resets a window or grants execution authority.
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `applyOpenCodeConfigChanges({ scopes, changes })`
  - `bootstrapOpenCodeAtStartup()`
  - `startHealthMonitoring(healthCheckIntervalMs)`

## Session creation (session-creation.js)

`session-creation.js` provides `session_create_restart_rejected` only before
upstream dispatch. Timeouts, resets and upstream 5xx produce
`session_create_outcome_unknown` with `retryable: false`. Successful payloads are
unchanged. `X-DevRyan-Creation-Attempt` is an opaque correlation UUID;
`X-DevRyan-Creation-Budget-Ms` can only shorten the 120-second server budget.
The early middleware and managed route journal request/upstream/ownership/response
timings without prompt content, directory, configuration or attachments. Health
adds `openCodeProbe` with recent success/failure timestamps independently of
`isOpenCodeReady`; a failed busy-runtime probe does not trigger a restart.
Journal marks use `mark: session.creation.<phase>` and the existing sanitized
`payload.operationID`/`payload.durationMs` fields. The operation ID is the creation
attempt UUID. A sanitizer round-trip test prevents silent loss of correlation.
Expired preparation returns `session_create_not_dispatched` without contacting
OpenCode; readiness waits consume the same remaining budget in web.

## Public exports (managed-process-registry.js)
- `getDevRyanDataDir(env?)`: the shared data root from `packages/shared-runtime/lib/data-root.js`: `DEVRYAN_DATA_DIR` (alias `OPENCHAMBER_DATA_DIR`), else `~/.config/devryan`, or the pre-rename `~/.config/openchamber` while it still holds the data.
- `registerManagedOpenCodeProcess(record, options?)` / `reapOrphanedManagedOpenCodeProcesses(options?)`: the per-data-directory orphan registry. Records carry the owner's `ps lstart` start time; the reaper treats an owner PID whose start time differs as dead (PID reuse) and keeps the PID-only check when the start time is unavailable (Windows).
- `readProcessStartTime(pid, options?)`: returns the process start time, or `null` when it cannot be read.

## Public exports (packaged-agent-sync.js)
- `syncPackagedAgents(options?)`: synchronizes release-bundled packaged agent markdown into the managed OpenCode runtime agent directory. It writes missing files and updates files DevRyan wrote: the last managed hash, the raw packaged source, a raw prompt shipped by an earlier release (`packaged-agent-baselines.js`, frozen at 2.0.1), or the hash recorded by the retired v1 provisioner in the sibling `user-profile-manifest.json`. Those baselines cover agents written by the v1 provisioner, which kept its own manifest, and agents the 2.0 setup seed copied without `packaged-agents.json`; before them every packaged agent was held back as user-modified. Written files carry the policy-rendered prompt body, never the policy markers. It removes stale managed files, supports explicit model/variant, skill-policy, and excluded-agent options for tests/migrations, and reports conflicts instead of overwriting user-modified same-name files. `dryRun` reports the same outcomes without writing. `restoreAgentNames` replaces only the named held-back agents with the packaged prompt, after saving each edited file under `.devryan/backups/packaged-agents/`; it is used only by the owner's explicit Settings action. Normal startup passes empty overrides so the global packaged baseline stays stable across projects. When OpenCode Slim is active, startup excludes stale DevRyan workflow agents so Slim's plugin-provided agents/prompts own those names. Clean boots short-circuit from the manifest's applied packaged-set hash after cheap target existence checks, avoiding per-agent target-file reads.
- `formatPackagedAgentSyncConflicts(conflicts)`: formats sync conflicts for startup errors and logs.

## Public exports (runtime-agent-overlays.js)

Managed runtime directory allowances include the resolved DevRyan data root, POSIX `/tmp`, the active project, the Git worktree root, the active project's OpenCode worktree container, and their canonical real-path variants. The OpenCode container resolves from `XDG_DATA_HOME` (otherwise `~/.local/share`) plus the project ID recorded in Git metadata or encoded by an active OpenCode worktree path. It permits sibling worktrees for the same project without granting the shared `worktree/` parent or another project's container. Missing or malformed identity metadata adds no broader fallback. The process-wide DevRyan data-root rule covers every project plan directory even when the long-lived OpenCode process was started for another project. These allowances are merged only into agents that already declare a permission block, preserving role-level read, edit, and tool restrictions.

- `syncRuntimeAgentOverlays(options?)`: synchronizes user-scoped agent model/variant overrides, packaged-agent visible-skill policy, active project/worktree external-directory allows, the process-wide DevRyan data-root allow, allowlisted active plugin registrations, bundled runtime plugin files/registrations (including the GitHub Copilot Auto/picker-fallback and OpenAI GPT-5.6 variant plugins), Anthropic OAuth proxy bootstrap config, Cursor provider bootstrap config, GitHub Copilot auth alias synchronization plus account-discovered `github-copilot` provider models with runnable `api` metadata (using `auth.readAuthFile` when callers omit an explicit reader), runtime-only user remote MCP timeouts, and blocked ambient MCP tombstones into a managed high-precedence OpenCode config directory. `options.dataDirectory` supplies the authoritative DevRyan root and otherwise resolves `DEVRYAN_DATA_DIR` or `~/.config/devryan`. Runtime directory allowances are applied to every effective managed agent with an explicit permission block without weakening role-level read/edit restrictions. It preserves explicit agent model overrides without synthesizing OpenAI models or availability. Provider transport deadlines are owned by the native configuration snapshot (`runtime-host/DOCUMENTATION.md`, "Provider transport deadlines").
- `getRuntimeAgentOverlayConfigDirectory(workingDirectory, options?)`: resolves the managed overlay config directory for a project directory.

## Public exports (skill-policy.js)
- `normalizeSkillPath(skillPath)`: resolves skill paths for stable hidden-skill comparisons.
- `filterVisibleSkills(skills, hiddenSkills)`: filters discovered skills against persisted hidden/removed skill paths.
- `buildVisibleSkillPolicy({ skills, hiddenSkills, runtimeExternalDirectories? })`: builds the allowed skill names/directories used to sanitize managed packaged-agent permissions, optionally carrying runtime-only project/worktree directories for overlay generation.
- `applyRuntimeExternalDirectoryPolicy(frontmatter, runtimeExternalDirectories?)`: merges normalized runtime-only directory allows into an existing permission block while preserving fallback and tool-specific rules.
- `sanitizeAgentSkillPolicy(frontmatter, policy)`: rewrites an agent frontmatter permission block so `permission.skill` defaults to deny; skill-capable agents without an explicit wildcard deny get all visible skills, explicitly restricted agents keep only their previous visible allows, and runtime external directories are added as `external_directory` allow patterns while preserving the fallback action.

## Language servers

OpenCode's language servers are always off for agent sessions; there is no
setting. The runtime overlay (`runtime-agent-overlays.js`) always writes
`lsp: false`, which replaces any `lsp` value from the user's configuration and
also reaches confined workers, because the companion sends them the host's
configuration. A confined `edit`, `write` or `apply_patch` would otherwise start
`typescript-language-server` and `tsserver` from cold for the whole project and
discard them when the call ends: measured on 2026-09-30 at 10 to 20 seconds and
2 to 3 GiB per edit. Agents run the project's own type checks instead.

## Public exports (agent-runtime-warmup.js)
- `createAgentRuntimeWarmup(dependencies)`: creates a read-only warmup runtime. Returned API:
  - `warm({ directory?, timeoutMs?, commandTimeoutMs?, mcpTimeoutMs? })`: runs health, directory-scoped config/provider/agent/session-status/OpenCode skill/MCP/command fetches, optional Cursor SDK worker prewarm, and capped visible-skill file read tasks; returns per-task ready/error/timeout results and never starts prompts, command execution, or sessions. MCP status and command discovery run concurrently with independent longer timeouts because cold OpenCode MCP/runtime loading can sit on the first-prompt critical path. Concurrent calls for the same normalized directory share one in-flight promise and its first caller's timeout configuration; different directories remain concurrent.
  - `getLatestResult()`: returns the latest in-memory warmup diagnostics, including timestamp, directory, task statuses, errors, timeout state, and additive harness metadata.
- `registerAgentRuntimeWarmupRoute(app, warmupRuntime)`: registers `POST /api/startup/agent-runtime-warmup` for optional project prewarming after UI readiness.

## Public exports (project-prewarm-runtime.js)
- `createProjectPrewarmRuntime(dependencies)`: creates a non-throwing project prewarm coordinator. Returned API:
  - `run(reason)`: waits up to 30 seconds for OpenCode readiness, discovers the current ordered directory list, and warms it sequentially. A newer invocation supersedes the older loop, shutdown can abort between directories, and failures remain visible in `[Prewarm]` diagnostics without blocking restart completion. The application does not start this all-project discovery during launch; the renderer warms only its active directory after UI readiness.

## Public exports (harness-result.js)
- `createHarnessSuccess(options?)`, `createHarnessWarning(options?)`, `createHarnessError(options?)`: build deterministic harness envelopes.
- `withHarnessResult(payload, envelope)`: adds `harness` metadata and only fills top-level envelope fields that do not already exist on the payload.

## Public exports (harness-preflight.js)
- `lintAgentHarness(options?)`: read-only linting for unavailable delegated agents, invalid permission keys, hidden skills still allowed by agents, stale model overrides, duplicate skill names by path, malformed skill frontmatter, skill names that do not use the canonical lowercase directory slug, agent `steps`/`maxSteps` caps that are not positive integers (`invalid-agent-steps`), agent `temperature`/`top_p` set for a built-in provider the native runtime never sends sampling to (`agent-sampling-not-applied`, warning; only openai-compatible provider packages receive it), and latest warmup failures.
- Skill-capable agent linting also verifies the platform skill-announcement policy is present and flags prompt conflicts when an allowed skill explicitly requires visible announcements.
- Permission-key linting accepts DevRyan's canonical tool aliases, including the edit/write/patch/apply_patch group, `webfetch`, and documented MCP-style wildcard denies such as `supabase_*`.
- `auditPackagedPromptContext(options?)`: report-only prompt context budget audit for packaged agents. It measures byte count, repeated routing rules, duplicated tool-safety text, and extraction candidates without mutating prompt content.
- `createHarnessPreflight(dependencies?)`: composes lint/audit/live tool manifest/warmup diagnostics, installed Claude runtime metadata, optional session usage, and UTF-8 context measurements into a preflight result. Tool and session discovery are lazy and run only when `run()` is called; neither is part of startup or warmup.
- `registerHarnessPreflightRoute(app, preflight)`: registers `GET` and `POST /api/diagnostics/harness/preflight`. Both accept `directory`, `providerID`, `modelID`, and optional `sessionID`. Omitting both model selectors runs IDs-only diagnostics; providing both adds provider/model catalog diagnostics; providing exactly one returns HTTP 400 with `error.kind = "invalidModelSelector"`. A session selector reads only assistant provider-token counters and sanitized Meridian tool-count telemetry.
- `extractAnthropicUsageFromMessages(payload)`: reduces OpenCode message snapshots to first/latest Anthropic provider usage and bounded aggregate counters without retaining message or tool content.

## Public exports (harness-tool-manifest.js)
- `createHarnessToolManifestReader(dependencies?)`: creates the lazy OpenCode tool-manifest reader used by preflight. It preserves live tool ordering and duplicate occurrences, carries explicit per-endpoint availability, applies an independent abort timeout to each endpoint, and never reads prompt, tool-call input, or tool output data. Tests and composition roots may inject `toolRequestTimeoutMs`; invalid values fall back to five seconds. Timeout errors are reported only as `{ kind: "timeout" }`.
- `DEFAULT_TOOL_REQUEST_TIMEOUT_MS`: default five-second timeout for each live tool-discovery endpoint.
- `getToolPermissionAliases(toolId)`: returns the server permission alias group for a live tool ID without changing the ID.
- `TOOL_PERMISSION_ALIAS_GROUPS`: canonical server-side permission alias groups used by the diagnostic manifest.

## Public exports (config-credential-scan.js)
- `getConfigCredentialSources({ directory }?)`: lists the raw user and project config layers to scan, deduplicated by path.
- `scanConfigCredentialSources(sources, { readFile }?)`: scans each layer and returns `{ availability: 'complete' | 'partial' | 'unavailable', sources, findings }`. Missing layers are `absent`; unreadable or invalid JSONC layers are `unavailable` with a `reason` kind only.
- `readConfigCredentialScan(context?, options?)`: composes the two for preflight's `getConfigCredentialScan` dependency.
- `classifyCredential(value)`: returns the credential kind for a literal string value, or `null`.

## Public exports (harness-context-budget.js)
- `buildHarnessContextBudget(options?)`: builds byte-only packaged prompt, canonical-path-visible skill metadata/body, Anthropic fixed-prefix projection, and runtime tool-catalog measurements. Optional authoritative `anthropicUsage` values populate fixed-prefix tokens, request count, active context, and cumulative processed input independently; absent token measurements remain `null`. Parsed `prompt` is authoritative over full-file `content`, and raw prompt/skill body text is never included.
- `buildPackagedPromptMeasurement(packagedAgents)`: measures parsed packaged prompt bodies in UTF-8 bytes; `default-config/agents/prompt-budget.test.js` enforces per-agent ceilings with it.
- `findDuplicateIds(ids)`: reports exact duplicate ID occurrence counts without deduplicating the measured list.
- `findDuplicateSchemas(tools)`: reports exact canonical-schema duplicate groups by SHA-256 fingerprint, occurrence count, and ordered tool IDs without returning schemas.

## Public exports (turn-timing.js)
- `createTurnTimingRuntime(options?)`: creates an in-memory capped timing store. Returned API:
  - `recordClientMark({ sessionId, messageId?, mark, directory?, metadata? })`
  - `processOpenCodeEvent(payload)`
  - `recordBridgeCall({ sessionId, method, durationMs, statusCode, reused? })`: aggregates bridge calls and status-only failures (null/incomplete status or HTTP status at least 400) globally and per retained method. The first 32 distinct methods are retained; global totals include calls for dropped methods, so retained method sums may be lower.
  - `getRecentTimings({ sessionId?, limit? })`: returns timing marks/durations plus accepted provider/model/agent/variant metadata, normalized `diagnostics.terminalFailure` kind/elapsed time, evidence-only active-total and same-provider concurrency snapshots at acceptance/failure, Cursor worker/run/stream timing, repeated text frames, malformed tool-call diagnostics, loop-guard diagnostics, mutation evidence, a capped ordered `diagnostics.toolCalls` projection, and `diagnostics.latestToolCall`. Concurrency is contextual evidence, never a causal conclusion or an admission limit. Tool calls are correlated internally by authoritative call/part identity and repeated states update one entry in place; terminal finality is monotonic if a stale active event arrives later. Tool projections contain only `ordinal`, normalized `tool`, normalized `status`, and `final`, with a default history cap of 20 and no identity/input/output fields.
- `registerTurnTimingRoutes(app, runtime, options?)`: registers internal diagnostic routes and an optional accepted-mark observer used to journal confirmed renderer tool-input stalls:
  - `POST /api/diagnostics/turn-timing/mark`
  - `GET /api/diagnostics/turn-timing/recent`
  Renderer operational marks include provider input/inference stalls and confirmed long-running tool calls. The long-running tool mark retains only tool name, source, and total elapsed duration; tool input and output are never accepted into timing or journal metadata.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `resolveWslExecutablePath()`
  - `buildWslExecArgs(execArgs, distroOverride?)`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName)`
  - `clearResolvedOpenCodeBinary()`

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`: registers common request parsing, then the optional `registerPrivateCapabilityRoutes(app)` hook, before installing the generic UI `/api` authentication middleware. The hook is reserved for independently authenticated loopback capability routes such as Electron browser discovery and leases.

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Startup settings migration converts the legacy wide-chat boolean to `chatWidth: 1024` and removes the deprecated key.
- Startup settings migration reconciles manifest-backed project icons after deterministic project-ID migration. Ordinary settings persistence does not acquire the icon-store lock, preserving one-way lock ordering for icon transactions that persist their settings projection.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`: validates that the candidate exists as a directory and returns its filesystem realpath so request-scoped OpenCode calls use the same canonical directory key as session records.
  - `resolveProjectDirectory(req)`: resolves managed assignments even when their intended worktree directory has not been provisioned yet; ordinary local/unassigned paths still require an existing directory. Without a requested directory it uses `lastDirectory`, then the active project, then (only when no project is registered) `getDefaultDirectory()`, the host's base native location, so a fresh profile's global bootstrap reads such as `GET /api/path` succeed.
  - `resolveOptionalProjectDirectory(req)`: applies the same missing-assignment behavior when an optional directory was supplied.

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents`, `/api/config/agent-overrides`, `/api/config/agents/:name`, `/api/config/agents/:name/config`, and `/api/config/agents/:name/override`. Agent reads resolve project `.opencode/agents/<name>.md` first, then packaged defaults, then overlay user model overrides. Exact `GET /api/config/agents` is also the chat bootstrap contract: administrators and users with Agents read permission receive the full settings response, while other managed users receive only executable runtime model metadata (name, model, variant, model references, and Council councillor model selections). Prompts, paths, permissions, sources, and other configuration internals are omitted from that sanitized response. Agent create/update/delete routes return 405 because markdown-owned mutation is filesystem-owned; the override route only accepts model, variant, and Council councillor model rows. Override save/reset persists first, then refreshes managed OpenCode with `{ agentName }`; if refresh fails, the route returns persisted success plus `reloadFailed`/`warning` metadata.
  - Commands: `/api/config/commands/:name`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /tunnel/connect` for quick/managed-local and previously issued one-time tunnel links; the earlier tunnel boundary owns POST exchange, including managed-remote owner links with Supabase Off
   - `GET /invite` for multi-user invitations
   - `GET /connect` as a compatibility dispatcher for previously issued links
   - `app.use('/api', ...)` auth/tunnel guard
   - Public Managed Remote auth and API access fails closed with
     `managed_account_auth_required` unless the multi-user controller is active
     or the earlier tunnel boundary has verified a Supabase-Off owner grant;
     Quick and Managed Local retain their one-time tunnel-session gate.
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`

## Public routes (config-apply-runtime.js)

- `GET /api/config/apply-status`: returns the current revision, applied revision, exact pending scopes/reason codes, active-session count, runtime mode, permissions, and state.
- `POST /api/config/apply`: accepts `{ expectedRevision, mode: "when-idle" | "force" }`. Revision conflicts are HTTP 409; force is administrator-only and rechecks authoritative active sessions before abort/restart.
- `POST /api/config/apply/acknowledge-external`: records explicit confirmation after the user restarts an externally owned OpenCode runtime and refreshes host catalogs.
- `POST /api/config/reload`: compatibility alias that records one runtime-scoped change and submits it through the same coordinator; it does not bypass revision, idle, or authorization policy.
- `resolveSharedJsonBodyLimit(pathname)`: returns the shared JSON parser limit
  for a request path (`1mb` for behavior, `16kb` for lease/apply/preview,
  `50mb` for the listed `/api` prefixes and every non-API path), or `null` for
  any other `/api` path. The dedicated `/api/provider/openai/oauth` subtree also
  bypasses shared JSON and URL-encoded parsing so local/admin/CSRF guards run
  before its route-owned bounded parser. Other raw paths stay unparsed so the OpenCode proxy can stream
  them; a route there that reads `req.body` mounts its own bounded
  `express.json`. `api-json-body-coverage.test.js` parses every server source
  and fails when a non-GET `/api` route reads the request body (directly or
  through same-file helpers) without an inline or wrapper parser or a listed
  prefix. Route tests mount `registerCommonRequestMiddleware` instead of an
  app-level `express.json()` so they exercise production parsing.
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - JSON body parsing bounded by `resolveSharedJsonBodyLimit`, including
    bounded multi-user `/api/analytics/events` batches
  - URL-encoded parser setup
  - request logging middleware

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.
- Direct CLI execution always attaches signal cleanup, including watched development servers. Dev mode keeps `exitOnShutdown` false so the watcher owns the final exit code, while the server still completes managed OpenCode teardown before its process exits.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `fetchAgentsSnapshot()`
  - `fetchProvidersSnapshot()`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Returned API:
  - `gracefulShutdown(options?)`
- Graceful shutdown first closes every active Electron browser lease before
  stopping managed orchestration/provider runtimes, ordinary OpenCode, and the
  HTTP server.

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`
- Cache policy keeps Vite's content-hashed `/assets/*` files immutable for one
  year, forces `index.html` and SPA fallbacks to revalidate, serves `sw.js` with
  `no-store`, and requires root-level unhashed files to revalidate. A newly
  deployed shell therefore cannot keep referencing chunks from an older build.

## Public exports (feature-routes-runtime.js)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
  Its `close()` remains a compatibility no-op; quota owns no separate Codex
  process. Quota registration receives the private application data directory
  and augmented executable search path for its remaining provider integrations.
- Returned API:
  - `registerRoutes(app, routeDependencies)`

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot()`: returns verified native bundle version, artifact path and already-detected runtime version; it never probes standalone executables or offers an install command.

## Public exports (opencode-update-runtime.js)
- `openCodeBaseVersion(value)`: preserves pure historical version identity for offline QA evidence. The standalone update checker and its route are retired.

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

## Public exports (devryan-routes.js)
- `registerDevRyanRoutes(app, dependencies)`: registers DevRyan endpoints:
  - DevRyan's own routes live under `/api/devryan`; `lib/legacy-api-path.js` rewrites the accepted `/api/openchamber` alias (`req.url` and `req.originalUrl`) as the first middleware of every composition, before any guard.
  - `GET /api/devryan/update-check`
  - `POST /api/devryan/update-install`
  - `GET /api/devryan/models-metadata`
  - `GET /api/zen/models`
- Update checks await asynchronous package-manager probes so background polling
  cannot block prompt admission, recovery RPCs, or SSE on the shared host event
  loop. Selection preserves forced-manager, installation-ownership, environment
  hint, runtime hint, and visible-package fallback precedence. Availability and
  metadata probes retain their 5-second and 10-second limits and 1 MiB output
  bound. Concurrent checks share one lookup; a resolved package-manager choice
  is cached. Desktop continues to report Electron ownership without probing.
  CLI detection and update execution keep their synchronous contracts.

## Public exports (pwa-manifest-routes.js)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`
  Disk-backed projects remain the first lookup source. On managed hosts, an
  assigned project may fall back to Supabase metadata; reads remain assignment
  scoped and icon upload/delete/discovery are administrator-only.
  Upload and discovery use the durable icon store transaction: image and
  manifest state are installed before settings metadata and rolled back when
  persistence fails. Delete removes the manifest before clearing metadata so
  leftover files cannot be restored after restart.

## Public exports (project-icon-store.js)
- `createProjectIconStore(dependencies)`: creates the serialized durable icon store.
- Returned API:
  - `replaceIcon(input, persistMetadata)`: atomically installs bytes and manifest metadata around the supplied settings/managed-project persistence callback.
  - `deleteIcon(input, persistMetadata)`: removes manifest ownership before clearing projected metadata, then best-effort cleans image files.
  - `migrateProjectId(input)`: moves manifest-backed icons transactionally and preserves still-visible legacy files during a known deterministic-ID migration without adopting unrelated orphan files.
  - `resolveIcon(project)`: resolves only manifest-backed icon storage; routes retain their compatibility fallback for legacy settings-backed files.
  - `reconcileProjects(projects)`: restores manifest metadata and migrates manifest-backed files by stable project path when the project ID changes. Files without a manifest entry are ignored.

## Public exports (skill-routes.js)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
  - Scoped session revert: `POST /api/devryan/session/:sessionID/scoped-revert`
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Windows `/session` merge fallback path behavior
  - OpenCode readiness gate for proxied `/api` requests

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher and retries transient readiness timeouts instead of permanently losing activity tracking after a slow startup.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/global/event` connection.
  - Can still create its own `/global/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Forwards each accepted unwrapped global payload into the canonical processor exactly once. The shared hub drops repeated non-empty upstream event IDs within its bounded replay window before transforms or side effects.

## Storage and configuration
- Provider auth: `~/.local/share/opencode/auth.json`.
- User config: `~/.config/opencode/opencode.json`.
- Project config: `<workingDirectory>/.opencode/opencode.json` or `opencode.json`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `DEVRYAN_RATE_LIMIT_MAX_ATTEMPTS`, `DEVRYAN_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
# Primary recovery integration

The bundled `devryan-primary-recovery.mjs` plugin reports request preparation
and tool execution to the host's shared recovery controller. Read-only recovery
is enforced before tool execution; native inspection-tool collisions are denied.
Provider timeout overlays and explicit user overrides remain unchanged.
The separate semantic-progress setting and observe-first rollout are described
in `docs/PROVIDER_RECOVERY.md`.

## Session change summaries

The revisioned summary and card Undo/Redo routes are owned by the shared harness session-change host, composed in `server/index.js`. Canonical observations require the native client; file mutations require the native restore owner. `computeScopedSessionChanges` returns incomplete historical coverage and never attributes worktree-wide diffs to a session. Imported pre-capture receipts remain inspectable, while mutation without a real native ledger transaction is unavailable. See `docs/CONCURRENT_REVERT.md` and `docs/SESSION_CHANGES.md`.

### Default thinking metadata

`model-default-thinking.js` adds optional display-only `defaultThinkingLevel`
to provider model metadata. Explicit supported adapter configuration wins;
otherwise only verified OpenCode runtime defaults are annotated. Unknown
defaults remain unspecified.
ModelControls renders a known level or “Provider-controlled,” explains the default,
and keeps selection/send/queue variant values unchanged. Catalog enrichment
preserves unchanged object references and never merges metadata into options.

Regression coverage lives in the model-default-thinking and mounted ModelControls
hydration tests. The opt-in isolated live comparison script was removed in app cleanup.

## Harness skill discovery

`harness-skill-discovery.js` exposes `createHarnessSkillDiscovery`, receiving filesystem, home-directory, YAML and existing skill-search services. It preserves discovered records by resolved path and retains malformed frontmatter as `parseOk: false` diagnostics. The server composition root owns its construction and passes the collection callback to harness consumers.

- `session-model-text.js` provides isolated text-helper sessions for Git generation, with an optional `variant` (reasoning effort) forwarded on the helper prompt. Git commit and PR requests go through the native `opencode` (Zen) provider with the pinned DeepSeek V4.1 Flash model at the `low` variant and all tools hidden. Caller cancellation disables response recovery, aborts native inference, and deletes the tool-denied helper before the next attempt. With `advertiseDeniedTools`, the helper session's permission is deny-all followed by a deny rule whose pattern matches no real tool input: OpenCode hides a tool only when its last matching rule is a blanket `*` deny, so tools remain in the request (which Zen's free tier requires) while every call still resolves to deny. Free-tier policy rejections are reported as `free_tier_rejected`. Embedded provider errors are classified even when the HTTP response is successful. PR session-model fallback retains its repair/recovery behavior. `runtime-agent-overlays.js` supplies hidden `devryan-commit` and `devryan-pr` no-tools agents; the shared UI and notification policy hide their internal text-helper sessions.

## Plugin upgrades and preserved agent state

Follow [the upgrade runbook](../../../../../docs/PLUGIN_UPGRADES.md) and retain a dated audit. Untracked personal presets/prompts are preserved.

## Image generation model policy

`imagegen-model-hotfix.js` patches the reviewed image plugin executable to request `gpt-6-astra` with `reasoning: { effort: "medium" }`. Managed provisioning applies the patch after dependency validation. It verifies the complete original SHA-256, accepts only the complete original or patched source, and writes via atomic replacement to preserve package-manager cache hard links. An incompatible source blocks startup without replacing that source. The original plugin schema, parser, references, quality and file output remain unchanged. The native image owner requires an explicitly selected OpenAI API key, sends the original image request to public Responses, and reports API-key billing. SIWC is refused before refresh or network traffic. Original Codex OAuth parser fixtures remain separate from this native authentication contract.

### Session title deadlines and diagnostics

The shared title coordinator uses one 30-second deadline for configured selection, first helper and authorized active-model fallback. Same-session schedules share the in-flight job. Helpers retain their actual cancellation/settlement owner when a timeout becomes `unsettled`; expired admission cannot begin a physical provider request. The native `title` agent remains disabled.

A resolved model or final derived candidate enters the existing atomic outbox before projection. Failed persistence pauses after three cycles with 1s/2s retry delays. Busy or missing-idle waiting does not count as a cycle, but 60 consecutive busy deferrals also pause the job. The configured helper sends its saved reasoning variant; the active fallback sends the session's own. `helper_create` and `session_model` diagnostics carry the helper's HTTP `status` and bounded `native_*` refusal `code`. Reopening requires a canonical user record and the private native accepted-input metadata (`origin: human`), not caller text or replay of the last accepted ID. A newly verified human input can replace the source authorization for the remaining pending persistence cycle without resetting its attempts; only a paused cycle reopens. Native rename compares the title it replaces, and manual rename remains authoritative during pause and restart recovery.

Managed native child titles enroll from the canonical accepted-user event after the constructor-owned dispatch seals the original source. The private managed source binding preserves its actual origin, which may be `unknown`; it grants nothing alone. `native-managed-title-owner.js` requires the exact durable assignment, originating assistant/control-call identities, current root objective and cancellation generation, controller/configuration, child selection, permissions, and the ordered canonical source. Starting, running, completed and failed assignments may title their accepted source while cancellation and replacement refuse it. Root and child human persistence reopening use a separate exact latest-human witness, bounded ancestry and fresh root/child permissions. Canonical reads and asynchronous scope checks repeat at physical helper/rename boundaries. The optional helper rename source ID is strictly typed and remains private. Managed witness checks share the original generation deadline and cannot buy another model budget after refusal. An unresolved delegated candidate whose source controller/configuration no longer matches after restart retains its candidate, source and attempts, then pauses after the existing three persistence cycles with `native_managed_title_source_invalid`. Historical source markers cannot renew authority; a fresh latest canonical human source or manual rename is required. Persisted titles restore without another helper request.

The private `readUserMessage` boundary preserves the exact validated native user text alongside its original metadata. Managed title recollection checks those bytes against the sealed source; the public projection cannot supply that proof. Dropping or normalizing the private text would reject a valid managed source. Accepted-command and human-input callers retain their metadata, session and directory checks.

`session_title_generation` records safe IDs, candidate/native/expected lengths, equality and provenance flags, model tuple/source, timings, bounded failure reasons and enumerated native refusal codes. Managed input capture failures, including accepted-user event triggers, retain the attempted source ID and the allowlisted refusal code instead of failing silently. Neither titles, raw exceptions nor source/job hashes enter diagnostics. The pre-persist `comparison` record is written once per job and again only when the candidate, expected or native title changes, so a busy turn's 5 s rechecks do not repeat it; `verification_comparison` and `rename_refused` are written on every attempt. `package-model-title-lane.mjs` makes actual compiled helper inference → one native rename → supervised restart restoration mandatory for full package shipping qualification; derived-only evidence fails.

## Archive diagnostics

Archive facade failures emit `session_archive_failed` to the diagnostic journal,
correlated by session ID. The payload contains only the archive/unarchive action,
a bounded machine error code, and HTTP status; messages, directories, and session
content are omitted. The native archive backfill (`v2/native-archive.js`) records
`native_archive_backfill` (outcome and counts), `native_archive_backfill_failed`
and `native_archive_repair_failed` (stage, bounded code and session ID only).

## Native startup and retained versions

The native owner now owns the launch bundle verification and invokes the
lifecycle's config synchronization before capturing the native snapshot. Boot
passes fresh verified artifacts privately to the bundle loader; this receipt
never extends the serialized verification result. Reviewed config bytes and
the controller's immediate pre-spawn artifacts still receive their own checks.

The current package and compiled host pin is OpenCode 2.2.5.
Cold startup compares the selected and shipped artifact manifest digests even
when their OpenCode versions match, so a repaired DevRyan host is activated once
through the existing verified clone, credential checkpoint and selector CAS.
An identical artifact skips preparation; the prior bundle remains available for
rollback. An explicitly selected rollback at the pinned OpenCode version stays
selected. This local runtime preparation does not check for app updates.
Artifact verification
accepts a retained bundle of any OpenCode 2.x release for rollback
(`isNativeOpenCodeVersion`), each using its matching controller; startup never runs
one above the host pin. Cross-version credential capture or projection cannot
substitute a controller: exact OpenCode version, core digest and existing manifest
checks still apply. The build pins PTY 0.4.0 bytes (`@opencode/pty`, renamed from `@opencode-ai/pty`) and the 2.2.5 compaction and finalization observation sources,
found by content (`scripts/native-core-sources.mjs`) and gated by exact SHA-256, and
keeps Photon image resizing on the main thread in every installed core copy. 2.2.0 resolves the compaction
model's ceiling inside `selectModel`, so the compaction observer recomputes it with
the same pure `calculateCeiling` from that selected model. 2.2.0 also lets a
trigger carry its own prompt estimate into the budget and `due` check; the
observer records that estimate (`trigger.estimate ?? estimatePrompt(context)`). A pinned
`@opencode/schema` agent-defaults transform restores the 2.0.24
`external_directory: * → ask` default that 2.0.26 removed.

- `lifecycle.js` owns `openCodeStartup` on `/health` and `/api/health`: an
  additive `{ state, attempt, code }` snapshot. Each boot or restart publishes
  `starting` before verification/recovery, then `ready` or `failed`; failures
  carry bounded diagnostic identifiers only. An older attempt cannot replace
  the current status. Concurrent boot/start callers share one promise and attempt.
  Explicit restarts join one queued replacement, waiting for any initial boot to
  settle (including failure) before acquiring a new attempt. Pending ownership is
  cleared on success and failure. Project preparation waits for pending startup,
  rechecks the captured locations, and restarts only if the location is still
  missing, with registration and idle-session checks intact. Consumers still
  require native readiness before use.

`native-catalog-diagnostics.ts` gives graph construction and each catalog HTTP
read its own native ErrorReporter context. Non-OK reads retain only a fixed
route, HTTP status and recognized refusal/stage or schema classification;
unknown defects remain `cause_unavailable`. Model construction, reads, account
lookup and normalization preserve deliberate denials and report fixed stage
codes. No response bodies, raw messages, stacks, paths or configuration enter
diagnostics, including when the SDK converts a defect to an empty 500.
The native owner journals startup starting/bound/ready/failed phases and
durations through its existing diagnostic callback, including failure before
binding; physical exits are recorded before fallible owner cleanup.

### Managed Cursor Plan execution

Native managed catalog reads use verified tool or recovery authority rather than a browser principal. Catalog access grants no execution rights. Managed Cursor prompt grants derive immutable read-only policy from the durable task; SDK create/resume permits only `read`, `grep`, `glob`, and `ls`, excludes task/MCP delegation, and includes policy in agent cache identity. Worker payloads carry this host-owned boolean, never a prompt-body override. Model discovery preserves SDK `reasoning_effort` choices; saved Medium resolves only to an actual Medium variant and never falls back to High or generic thinking.

OpenCode 2.0.30 and 2.0.32 use Effect 4.0.1 and its stable HTTP/process/socket exports. 2.2.2 moves to Effect 4.0.6 (2.2.5 keeps it); DevRyan's own `effect` pin follows it, or two Effect copies split every service type.
The host pins 2.2.5. Native plugin registration order
matches the installed core inventory. 2.2.1 adds `opencode.goal` (the `/goal`
command), `opencode.tool.image-generate` and `opencode.tool.schedule`, and drops the
Cohere, Perplexity and Vercel provider plugins. The image and schedule tools need
`experimental.image_generate`/`experimental.schedules`, which DevRyan's owned
`experimental` block never sets, and execution routing has no owned path for them. HTTP schema errors remain sanitized
startup evidence even when Effect marks them ignored for general reporting.
The project archive migration raises the clone migration level to 2: existing
reviewed 2.0.20/24/26 source layouts can upgrade, but migrated 2.0.30 databases
cannot clone into an older release. Rollback retains the original database.
2.0.32 adds no migration (level 2). Its database structure equals 2.0.30's, which has
`project.time_archived`, so the clone gate checks a source database against the
reviewed layout of the source release's own migration level
(`reviewedNativeCloneSourceLayout`); 2.0.30 and 2.0.32 clone in both directions.
A layout is a structural fingerprint (`inspectNativeCloneLayout`: columns by name,
keys, indexes, constraints, triggers, the legacy migration journal and
`user_version`), not DDL text. A database that an earlier release created and
2.0.30 migrated in place (`ALTER TABLE … ADD`, column last) has the same layout as
a fresh 2.0.30 one. Each reviewed value is measured from an actual controller
database; `runtime-host/test-fixtures/native-clone-layouts/` holds schema-only
dumps of the fresh 2.0.26, migrated and fresh 2.0.32 cases.
2.0.32 adds `POST /api/experimental/voice/session`, which brokers the server's
stored OpenAI/xAI keys into a realtime session; the route policy denies it.

OpenCode 2.1.0 introduced logical clone level 3: native compaction/message
formats cannot clone into older readers, while rollback keeps the original
retained database. 2.1.2, 2.1.3 and 2.1.4 add no migration and stay at level 3, so 2.1.0,
2.1.2, 2.1.3 and 2.1.4 clone in both directions. Native compaction windows use `native.messages`
and provider/model references through `SessionHistory`; helper webfetch history
uses the resolved model reference. The reviewed compaction observer follows
`isNativeCompaction` and the finalization observer retains the original native
Step writes. The generated 2.2.5 OpenAPI inventory has 169 operations; the saved-permission list, PATCH and DELETE are server-only, reached through the Saved Approvals route (`v2/saved-permission-facade.js`).

OpenCode 2.2.0 is clone level 4. It adds the `blob`/`blob_ref` media store and
drops `session_pending`, which 2.1.x declared but never wrote; host reads of
queued input use `session_inbox` only, and removal dispositions keep an empty
`pendingIDs`. A 2.2.0 database cannot clone into a 2.1.x reader. A 2.1.x source
is still checked against its own level 3 layout. A 2.2.0 controller's fresh database
and a retained 2.0.32 schema it migrates in place share one reviewed layout; no
legacy-imported 2.2.0 layout is measured yet, so such a database is not a
reviewed clone source until a later upgrade measures it. DevRyan owns the whole
`experimental` block, so `experimental.media_blob` stays off and tool media stays
inline. `@opencode/ai` 2.2.0 moved its Effect API to `@opencode/ai/effect` and
stopped exporting `schema/options`; `native-observation.ts` imports the SDK's
`mergeProviderOptions` and `DEFAULT_HTTP_TIMEOUT_MS` from that module by path.

OpenCode 2.2.1 is clone level 5. It adds the `schedule` table; a 2.2.1 database
cannot clone into a 2.2.0 reader, and a 2.2.0 source is still checked against its
own level 4 layout. A 2.2.1 controller's fresh database and a retained 2.0.32
schema it migrates in place share one reviewed layout; no legacy-imported level 5
layout is measured. The schedule routes are denied. 2.2.1 adds
`Permission.assertNotDenied` (webfetch re-checks redirect targets against deny
rules); the host evaluates it in the same location permission view as `assert`,
and the writer worker refuses it.

OpenCode 2.2.2 is clone level 6. It adds the `session_part` table, `session_v2.time_busy`
(written on every execution start) and the schedule check columns; a 2.2.2 database
cannot clone into a 2.2.1 reader, and a 2.2.1 source is still checked against its own
level 5 layout. 2.2.2 reads assistant content from `session_part` when rows exist there
and then stores `content: []` in `session_message.data`, but it never creates part
rows, so `session_message.data.content` stays authoritative and host SQL readers of
assistant content are unchanged. A release that starts writing `session_part` breaks
those readers and must be reviewed first.

OpenCode 2.2.5 is clone level 7. It adds the `job` table, moves background-job
markers out of `kv` (`job.background/*`) into it and deletes the old rows; a 2.2.5
database cannot clone into a 2.2.2 reader, and a 2.2.2 source is still checked against
its own level 6 layout. 2.2.5 still writes `session_part` only where part rows already
exist, so `session_message.data.content` stays authoritative. It adds
`opencode.tool.artifact` (opt-in through `experimental.artifacts`, no capabilities)
and the experimental artifact routes, which are denied, and `opencode.provider.claude-agent`,
which drives the user's own Claude Code through the `@anthropic-ai/claude-agent-sdk`
peer (pinned to core's 0.3.301). The confined controller cannot reach the keychain or
`~/.claude`, so admission rebuilds the plugin over host-relayed IO; see
"Claude Code through claude-agent" in `runtime-host/DOCUMENTATION.md`.
`Permission.allows` (edit adds a file-content hint to a missed match when reads are
allowed) is evaluated in the location permission view; the writer worker answers
`false`. `Tool.check` runs Code Mode schedule conditions and is refused. Compaction
`buffer` may be a percentage string such as `"20%"`; the observation accepts it and
`nativeCompactionReserve` treats it as no token reserve.

Under ChatGPT browser or headless sign-in, 2.1.4 enables only `gpt-5.6-*` and
later OpenAI models (not `gpt-5.6` itself); `gpt-5.5` and `gpt-5.3-codex-spark`
are disabled, and the 272k/500k input caps come from the new
`opencode.provider.openai-context-caps` plugin. The packaged Orchestrator, Oracle,
Fixer, Builder and Council default to `openai/gpt-6.1-sol` with their previous
variants; a saved user override of a disabled model stays authoritative and shows
as unavailable. Its V1 import probes live session directories to assign
projects; migration mode gives it a no-op file system and a refusing Project
service, so the reviewed project map remains the only owner.
`experimental.background_compaction` stays off: 2.1.4 forks the background
summary into the location scope, also when a turn ends, and DevRyan's
compaction context hook and provider attempts require the turn's live permit,
so a turn-end summary is refused (`native_permit_invalid`) before any request
and the next automatic compaction runs in the foreground. `DEVRYAN_BACKGROUND_COMPACTION=1` opts in for testing (runtime-host DOCUMENTATION.md, "Background compaction").

Known native verification commands wait for same-assistant-step writer publication
before reserving their execution view (`native-verification-order.js`). An edit
without a host job or durable publication fails with
`native_verification_publication_pending`; retry after the edit result. Independent
reads and non-verification shells retain parallel execution. Sleeping inside an
already captured view cannot refresh it. The receipt's publication sequence is
the durable revision, distinct from tool start time.

A shell command or `devryan_browser` open (including the open steps of a
sequence) that names a loopback address (`http://localhost:8090`,
`127.0.0.1:5173`, `PLAYWRIGHT_BASE_URL=…`) is checked against the server
listening there (`native-served-identity.js`): `lsof` finds the listener, and
the `DEVRYAN_EXECUTION_VIEW` marker in its environment names the call that
started it. That server serves its call's copy of the project, so once a later
commit changed project files (the ledger's `viewFreshness`) admission refuses
with `preview_stale`, before any lease exists, and tells the agent to stop it
and run the server and the check in one foreground call. A listener without a
readable marker (started outside DevRyan, or an Apple platform binary) is
external: allowed, with unknown freshness. A required visual check that named
one, or whose server fell behind while it ran, cannot pass
(`preview_freshness_unproven`, orchestration DOCUMENTATION.md). Browser results
name what served each opened address in `metadata.servedIdentity`, never the
lease token. Addresses set only in configuration files, navigation by click,
eval, tab or pushstate, and listeners on Windows are not checked. Kill switch:
`DEVRYAN_SERVED_FRESHNESS=0`.

A managed task child's `background: true` shell is refused at the same point
with `native_shell_background_unavailable` and the one-call workflow as
guidance (runtime-host DOCUMENTATION.md); a root's or an unmanaged subagent's
runs as before, and one whose role orchestration cannot tell yet runs and is
journaled (`background_policy_unknown`).

Input admission journals bounded delivery intent, requested/accepted/reconciled/
refused decisions, whether subtree settlement is required, and a refusal category.
These records contain no message text or attachments. A required settlement field
is a policy requirement, not a claim that descendants stopped.

Native packaged prompts, run fingerprints and managed-runtime capability replies use `resolveNativeHarnessPolicies`: independent parent reading is enforced by native admission, so `readOverlap` is true even when the legacy `DEVRYAN_MANAGED_READ_OVERLAP` flag is zero. The legacy resolver and plugin policy keep their rollout behavior. This advertises a native capability, never permission to mutate or bypass holds.

Native shell checks retain at most 16 KiB of transient canonical output only after the required-check observer confirms a matched check. This diagnostic buffer is independent of acknowledged transport events; overflow marks it incomplete and prevents an environment skip. Settlement releases the buffer, and durable verification stores only bounded reason/hint and canonical exit/content identities. Untracked shells allocate no separate diagnostic buffer.
