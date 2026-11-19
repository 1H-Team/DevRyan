# Environment variables

This is the reference for the `DEVRYAN_*` (and legacy `OPENCHAMBER_*`) and
`OPENCODE_*` environment variables that DevRyan's production code reads or sets
for a process it starts. Other names the product reads (`PATH`, `HOME`,
`SHELL`, provider keys, `BUN_EXECUTABLE`) are out of scope. A variable already
described in a package `DOCUMENTATION.md` or a `docs/` page is only listed
here, with a link to that page ([Documented elsewhere](#documented-elsewhere)).

The rule for what is listed is the one the docs validator's reverse environment check (`bun run docs:validate`) enforces:
a variable is listed when a production source under `packages/` names it (tests,
fixtures, the frozen legacy `packages/desktop`, the docs site, reviewed upstream
inputs and build or development tooling are not production). That includes the
development and QA hooks that production files read; variables that only
tests, `scripts/` or build configuration read are in [Not covered](#not-covered).

## Names, aliases and values

- **Legacy alias.** The web server (`packages/web/server/index.js`) and the CLI
  (`packages/web/bin/cli.js`) first import
  `@devryan/shared-runtime/node/adopt-legacy-environment.js`, and Electron main
  imports the same module by path (`packages/shared-runtime/lib/adopt-legacy-environment.js`).
  It copies each `OPENCHAMBER_*` value to its `DEVRYAN_*` name when that is unset
  and never overrides it (`packages/shared-runtime/lib/legacy-environment.js`), so
  in those processes, and in children that inherit their environment, every
  `DEVRYAN_<NAME>` is also accepted as `OPENCHAMBER_<NAME>`. A child started with
  an explicit environment (the native controller, whose environment is an
  allowlist, and the native launchers) sees only what DevRyan passes it. New code
  reads and writes the DevRyan name; `setDevRyanEnv` writes both names.
  `OPENCODE_*` names have no alias.
- **Flags.** Unless a row says otherwise, a kill switch is on by default and only
  the exact value `0` turns it off; an opt-in switch is off and only `1` (or the
  `true` a row names) turns it on. Rows that say "true/1" accept `1` or `true` in
  any case.
- **Credentials.** Rows marked *credential* name a secret. Set it in the
  environment of the process that needs it; never put its value in a document,
  a log or a command line you share.
- **Internal.** Rows marked *internal handoff* are set by DevRyan for a process it
  starts itself. They are listed so that a reader of the code finds them; setting
  them by hand is not supported.

## Web server

| Variable | Reader | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_HOST` | `packages/web/server/application.js`, `lib/opencode/server-startup-runtime.js` | Bind address when no `--host` option is given; a network-exposed address needs a UI password or `DEVRYAN_ALLOW_UNAUTHENTICATED_LAN`. Electron sets it to its bind host. | `127.0.0.1` · address | host override |
| `DEVRYAN_UI_PASSWORD` | `application.js`, `lib/opencode/cli-options.js` | Password for the browser UI when no `--ui-password` is given. `parseServeCliOptions` falls back to `OPENCODE_UI_PASSWORD`; `main()` called without a `uiPassword` option reads only this name. | unset · text | credential |
| `OPENCODE_UI_PASSWORD` | `lib/opencode/cli-options.js` | Fallback for `DEVRYAN_UI_PASSWORD` in `devryan serve` option parsing. | unset · text | credential |
| `DEVRYAN_ALLOW_UNAUTHENTICATED_LAN` | `lib/security/bind-host.js` | Lets the server bind a network-exposed address without a UI password. Electron sets it while Network Access is enabled and removes it otherwise. | off · `true` | opt-in switch (security) |
| `DEVRYAN_TRY_CF_TUNNEL` | `lib/opencode/cli-options.js` | Starts a Cloudflare quick tunnel at startup (`tryCfTunnel`). | off · `true` | opt-in switch |
| `DEVRYAN_TUNNEL_PROVIDER` | `lib/opencode/cli-options.js` | Default for `--tunnel-provider`. See [tunnels](../packages/web/server/lib/tunnels/DOCUMENTATION.md). | unset · `cloudflare` | setting |
| `DEVRYAN_TUNNEL_MODE` | `lib/opencode/cli-options.js` | Default for `--tunnel-mode`. | unset · `quick`, `managed-remote`, `managed-local` | setting |
| `DEVRYAN_TUNNEL_CONFIG` | `lib/opencode/cli-options.js` | Default for `--tunnel-config`; an empty value means none. | unset · path | path override |
| `DEVRYAN_TUNNEL_TOKEN` | `lib/opencode/cli-options.js` | Default for `--tunnel-token` (managed remote tunnel). | unset · text | credential |
| `DEVRYAN_TUNNEL_HOSTNAME` | `lib/opencode/cli-options.js` | Default for `--tunnel-hostname`. | unset · hostname | host override |
| `DEVRYAN_PUBLIC_ORIGIN` | `lib/notifications/push-runtime.js` | Origin used as the push (VAPID) subject when `DEVRYAN_VAPID_SUBJECT` is unset; a loopback origin falls back to `mailto:devryan@localhost`. | unset · origin URL | setting |
| `DEVRYAN_VAPID_SUBJECT` | `lib/notifications/push-runtime.js` | VAPID subject for web push. Without it, `DEVRYAN_PUBLIC_ORIGIN` and then the saved public origin are used. | unset · `mailto:` or origin | setting |
| `DEVRYAN_ALLOW_REMOTE_OPENAI_COMPAT_URLS` | `lib/tts/base-url.js` | Allows a non-local custom OpenAI-compatible TTS server URL. | off · true/1 | opt-in switch (security) |
| `DEVRYAN_TERMINAL_SHELL` | `lib/terminal/runtime.js` | First shell candidate for the built-in terminal, before `SHELL` (and `ComSpec` on Windows). | unset · executable | path override |
| `DEVRYAN_FS_EXEC_TIMEOUT_MS` | `lib/fs/routes.js` | Timeout of commands the file routes run. | 300000 · positive number | limit |
| `DEVRYAN_MESSAGE_STREAM_REPLAY_BYTE_BUDGET` | `lib/event-stream/global-hub.js` | Byte budget of the global message-stream replay buffer, read at import. | 16 MiB · positive integer | limit |
| `DEVRYAN_COMPRESS_API` | `application.js` | Forces API response compression on (true/1) or off (false/0). | on, except under `DEVRYAN_RUNTIME=desktop` | setting |
| `DEVRYAN_SKIP_API_COMPRESSION` | `application.js` | Turns API compression off; wins over `DEVRYAN_COMPRESS_API`. Electron sets it to `true` unless already set. | off · true/1 | setting |
| `DEVRYAN_VERBOSE_REQUEST_LOGS` | `application.js` | Logs every request's method and path. | off · true/1 | diagnostic |
| `DEVRYAN_RUNTIME` | `application.js`, `packages/cursor-sdk-runtime/index.js` | Runtime label reported to subsystems and in health and analytics payloads; `desktop` also turns desktop notifications on and API compression off. Electron sets `desktop` for its in-process server; Electron's SSH manager (`packages/electron/ssh-managed-probe.mjs`) sets `ssh-remote` for the DevRyan it starts on a remote host. | `web` · `web`, `desktop`, `ssh-remote` | internal handoff |
| `DEVRYAN_DESKTOP_NOTIFY` | `application.js` | Enables native desktop notifications. Electron sets it to `true`. | off (on with `DEVRYAN_RUNTIME=desktop`) · `true` | setting |
| `DEVRYAN_DIST_DIR` | `lib/opencode/static-routes-runtime.js` | Directory of the built web UI the server serves. Electron sets it. | `dist` beside the server code (`resolveDistPath`) · path | path override |
| `DEVRYAN_RUNTIME_MODE` | `packages/web/server/index.js`, `packages/electron/windows-preview.mjs` | `standard-preview` loads the Windows standard-preview application; any value other than `native` or unset is refused (`runtime_mode_invalid`). Electron accepts `standard-preview` only in the packaged Windows preview app and sets it for that server. | native · `native`, `standard-preview` | internal handoff |
| `DEVRYAN_STANDARD_OPENCODE_BINARY` | `lib/opencode/standard-preview/application.js` | OpenCode executable of the Windows standard preview; set by `packages/electron/windows-preview.mjs`. | unset · path | internal handoff |
| `DEVRYAN_BUN_EXECUTABLE` | `lib/agent-browser/install.js` | Bun used to install agent-browser, tried after the explicit option and before `BUN_EXECUTABLE` and `BUN_INSTALL`; a relative path is ignored. | unset · absolute path | path override |
| `DEVRYAN_XAI_TOOLS_SESSION_FREEZE` | `lib/opencode/routes.js` | Keeps an xAI session's reduced tool overrides fixed after first use so the cached prompt prefix does not change mid-session. | on · `0` turns off | kill switch |
| `DEVRYAN_DUPLICATE_IDENTITY` | `lib/opencode/harness-duplicate-qualification.js` | `binary` makes duplicate-output qualification pin the exact runtime binary hash instead of the build identity. | build identity · `binary` | setting |
| `OPENCODE_SERVER_PASSWORD` | `lib/opencode/hmr-state-runtime.js`, `lib/opencode/auth-state-runtime.js` | Password of the managed OpenCode server. A value present at startup is kept as the user-provided password; the auth-state runtime then writes the current password here (or removes it) and falls back to it for OpenCode request headers. The Windows preview removes it from its server's environment. | managed · text | credential, internal handoff |
| `OPENCODE_JWT_SECRET` | `lib/ui-auth/ui-auth.js` | Fixed secret for UI session tokens instead of the generated, persisted one; global sign-out is unavailable while it is set. | unset · text | credential |
| `OPENCODE_EXPERIMENTAL_PLAN_MODE`, `OPENCODE_EXPERIMENTAL` | `application.js` | Either one (true/1) reports `planModeExperimentalEnabled` on `/health`, which the UI (`packages/ui/src/App.tsx`) reads to enable plan mode. | off · true/1 | opt-in switch |
| `DEVRYAN_SSH_OWNER_TOKEN`, `DEVRYAN_SSH_INSTANCE_ID` | `lib/opencode/ssh-managed-identity.js` | Identity a remote DevRyan started by Electron's SSH manager proves to its owner (identity challenge and owner shutdown); set by `packages/electron/ssh-managed-probe.mjs`. | unset | internal handoff, credential |
| `DEVRYAN_SESSION_ID` | `lib/processes/runtime.js` | Session marker of process tracking: the processes runtime reads it from the command line and environment of running processes to group them by session and stop a deleted session's dev servers. Only the legacy `default-config/plugins/devryan-tool-input-guard.mjs` exports it in front of agent shell commands, and the native runtime does not load that plugin, so in the running product no command carries it. | unset · session ID | internal handoff |
| `DEVRYAN_DEV_MODE` | `lib/opencode/core-routes.js`, `lib/opencode/server-startup-runtime.js` | Development server: `/api/system/shutdown` answers 403, and an uncaught exception runs `gracefulShutdown({ exitProcess: true })` with a forced exit after 4 seconds (outside dev mode it runs `gracefulShutdown()`); reported as `devMode`. | off · `true` | development |
| `DEVRYAN_DEV_SHUTDOWN`, `DEVRYAN_ALLOW_DEV_SHUTDOWN` | `lib/opencode/core-routes.js` | Both `true` let the development shutdown kill the dev process group. | off · `true` | development |
| `DEVRYAN_DEV_ORCHESTRATOR_PID` | `lib/opencode/core-routes.js` | PID of `scripts/dev.mjs`, signalled by the development shutdown. | unset · PID | development |

Read, but no behaviour depends on them in the native runtime:
`OPENCODE_PORT`, `DEVRYAN_OPENCODE_PORT`, `DEVRYAN_INTERNAL_PORT` and
`DEVRYAN_OPENCODE_HOSTNAME` are parsed by `lib/opencode/env-config.js` and handed to
the lifecycle runtime, which does not use them (the native runtime picks its own
port); `OPENCODE_WSL_DISTRO` and `DEVRYAN_OPENCODE_WSL_DISTRO` are read by
`application.js` for the removed WSL launch; `OPENCODE_API_PREFIX` and
`DEVRYAN_API_PREFIX` only produce the warning that the API runs at the root.

## Session execution host

Kill switches in `packages/web/server/lib/opencode/session-execution-host.js`,
read per call. Each is on by default; `0` restores the previous behaviour.

| Variable | What `0` restores |
| --- | --- |
| `DEVRYAN_CANCELLED_RECEIPTS` | No cancelled-change receipt after Stop or a task deadline. |
| `DEVRYAN_CONTROL_LEDGER_ONLY` | Read-only control executions record their empty attestation again. |
| `DEVRYAN_DEFERRED_LEASE_CLEANUP` | Lease cleanup runs inline instead of after publication. |
| `DEVRYAN_DIRECT_CONTROL_RECEIPTS` | Direct receipts are refused (`direct_receipts_disabled`); the reserved-lease protocol is used. |
| `DEVRYAN_DIRECT_LEDGER_ONLY` | Read-only direct finishes record the attestation again. |
| `DEVRYAN_LEDGER_PREWARM` | No background first build of a project's ledger when a project is opened (`warmLedger` answers `skipped: 'disabled'`); the first confined call builds it. |

## Harness runtime

| Variable | Reader (`packages/harness-runtime/lib/`) | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_CONFINED_RECEIPT_AUTHORITY` | `session-changes.js` | A receipt published by a confined execution (the call's exact bytes) is authoritative for that call: receipts derived from tool metadata (the plugin's after hook, canonical part events, history replay) may fill a gap but never override it, and a confined receipt replaces them. | on · `0` compares them as before | kill switch |
| `DEVRYAN_PATCH_CAPTURE_PATHS` | `session-changes-tools.js` | Captures only the files a patch envelope names instead of a whole-project snapshot. | on · `0` | kill switch |
| `DEVRYAN_STALL_AWARE_DEADLINES` | `host-stall-clock.js` | Deadlines exclude time the host was stalled (its 250 ms ticker ran at least 1 second late). | on · `0` makes deadlines wall-clock | kill switch |
| `DEVRYAN_EXECUTION_IDLE_WATCHDOG` | `execution-idle-watchdog.js` | Watches confined executions for idleness, read per sample. The watchdog never runs on Windows. | on · `0` | kill switch |
| `DEVRYAN_EXECUTION_IDLE_MS` | `execution-idle-watchdog.js` | Idle limit of that watchdog. | 600000 · integer ≥ 60000 | limit |
| `DEVRYAN_EXECUTION_IO_CAP` | `execution-io-pool.js` | Concurrency of execution file I/O, read per use. | 8 · 1–64 | limit |
| `DEVRYAN_WORKER_LSP_DOWNLOAD` | `session-execution.js` | `1` lets workers download language servers again (otherwise they get `OPENCODE_DISABLE_LSP_DOWNLOAD=true`). | off · `1` | opt-in switch |
| `DEVRYAN_LEDGER_FAST_INGEST` | `session-mutations.js` | A ledger build installs rows in first-build-sized batches (the initial build, and re-stamps of unchanged content) instead of the normal install batch. | on · `0` | kill switch |
| `DEVRYAN_LEDGER_ANCESTOR_MEMO` | `session-mutations.js` | During a ledger walk, each listed directory is checked for symlinks once per pass instead of once per file below it (advisory; the install re-stamps every changed file). | on · `0` | kill switch |
| `DEVRYAN_LEDGER_RECORD_CACHE` | `session-mutations.js` | Keeps parsed ledger records keyed by the immutable subtree identity they were read from, so an unchanged ledger is not re-read on every transaction; also lets active paths come from the committed file index. | on · `0` re-reads every time | kill switch |
| `DEVRYAN_LEDGER_SNAPSHOT_REUSE` | `session-mutations.js` | Read-only callers share the committed file index's winners instead of reading the active paths again. Off whenever `DEVRYAN_LEDGER_RECORD_CACHE=0`. | on · `0` | kill switch |

`DEVRYAN_LEDGER_SOURCE_DIGEST` is read when the native ledger process is compiled, not when it runs:
`build_identity` in `packages/harness-runtime/native/ledger/ledger-native/src/proto.rs` compiles its value into
the build identity the process's `ready` message carries, and uses `development` when it is unset.
`scripts/build-ledger-native.mjs` sets it to the digest of the workspace's sources for the builds it makes. The
product does not start that process.

The other ledger and view switches are described on the pages linked under
[Documented elsewhere](#documented-elsewhere). `packages/harness-runtime/lib/sanitizer.js`
reduces the values of these behaviour switches to a closed enum before they leave the host.

## Confined children (internal handoff)

Set by DevRyan in the environment of a process it launches; not user settings.

| Variable | Set by | Read by | Purpose |
| --- | --- | --- | --- |
| `DEVRYAN_EXECUTION_WORKER` | `packages/harness-runtime/lib/session-execution.js`, `runtime-host/native-process.js` (supervised controller) | `packages/cursor-sdk-runtime/node-worker.mjs`, `default-config/plugins/devryan-browser.mjs`, the shell transform in `runtime-host/reviewed-browser-transform.js` | `1` marks a confined worker. |
| `DEVRYAN_EXECUTION_CWD` | `session-execution.js`, `runtime-host/native-process.js` | `packages/harness-runtime/native/session-execution.c`, `session-execution-windows.c` | Logical working directory inside the view. |
| `DEVRYAN_EXECUTION_CACHE` | `session-execution.js` | the native launchers, `devryan-browser.mjs` | Auxiliary cache directory the launcher grants. |
| `DEVRYAN_EXECUTION_CANCEL_EVENT` | `session-execution.js` | `session-execution-windows.c`; `session-execution.js` passes it to the launcher's `--cancel` | Name of the Windows cancellation event. |
| `DEVRYAN_EXECUTION_READ_ONLY` | `session-execution.js` | `session-execution.c` | `1` also unshares the network namespace on Linux. |
| `DEVRYAN_EXECUTION_BROWSER_SCOPE` | nothing in shipped code | `devryan-browser.mjs` | Browser lease scope of a confined worker; the plugin fails closed without it. |
| `DEVRYAN_NATIVE_IMPORT_OPERATION`, `DEVRYAN_NATIVE_IMPORT_ROOT`, `DEVRYAN_NATIVE_IMPORT_ROOT_EXCLUSIONS`, `DEVRYAN_NATIVE_IMPORT_MUTATING` | the Windows native import launcher (`session-execution-windows.c`, `native_import_environment`) | `runtime-host/native-migration-files.js` | Windows only (the reader refuses other platforms). Must equal the import being proved, or the migration child is refused (`native_migration_owner_unverified`). |
| `DEVRYAN_NATIVE_IMPORT_ENVIRONMENT_ROOT` | `session-execution-windows.c` (`native_import_environment`) | nothing reads it back | Windows only. Private root of the migration child's environment; its `HOME`, `TEMP`/`TMP`, `USERPROFILE` and `XDG_*` directories are created below it. |
| `DEVRYAN_NATIVE_SHELL_TICKET` | `runtime-host/execution-routing.ts` | `runtime-host/execution-routing.ts` | One-use ticket the native shell tool puts in a command's environment so the spawner can match the spawn to the permitted command; it is removed before the command runs and a spawn without a matching ticket is refused (`native_spawn_ownership_required`). |
| `DEVRYAN_OPENCODE_ARTIFACT` | `packages/web/server/application.js` (execution readiness environment) | `application.js` | Path of the native controller artifact, used as the runtime binary for duplicate-output qualification. |
| `DEVRYAN_SSH_ASKPASS_VALUE` | `packages/electron/ssh-manager.mjs` | the askpass script `ssh-manager.mjs` writes for the SSH master connection | The saved SSH password, passed only to the `ssh` process when one is configured; the script prints it for a password or passphrase prompt. Credential. |

## Orchestration

| Variable | Reader | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_TASK_AGENT_VALIDATION` | `packages/web/server/lib/orchestration/runtime.js` | Validates a delegated task's agent name against the live catalog before the child starts. (The legacy `devryan-managed-orchestration.mjs` also reads it; see [Not loaded by the native runtime](#not-loaded-by-the-native-runtime).) | on · `0` | kill switch |

## Cursor runtime

| Variable | Reader (`packages/cursor-sdk-runtime/`) | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_CURSOR_SETTING_SOURCES` | `index.js`, `node-worker.mjs`, `persistent-worker.mjs` | Cursor setting layers the agent loads, trimming ambient rules. Unknown layers are dropped. | all (unset) · comma list of `project`, `user`, `team`, `mdm`, `plugins`, `all`, or `none` | setting |

## CLI

| Variable | Reader | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_DAEMON_READY_TIMEOUT_MS` | `packages/web/bin/cli.js` | How long `devryan` waits for a started daemon to report ready. | 60000 · positive number | timeout |

The CLI also reads `DEVRYAN_HOST` (the host it connects to; `0.0.0.0` means
`127.0.0.1`) and `DEVRYAN_UI_PASSWORD` (the default `--ui-password`), described above.

## Electron

| Variable | Reader (`packages/electron/`) | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `DEVRYAN_SERVER_URL` | `main.mjs` | Opens this DevRyan server instead of the local one or the saved default host (not during runtime-bundle recovery), and allows it as a content origin. | unset · URL | host override |
| `DEVRYAN_PREVIEW_SMOKE_ROOT`, `DEVRYAN_PREVIEW_SMOKE_RECEIPT`, `DEVRYAN_PREVIEW_SMOKE_PHASE`, `DEVRYAN_PREVIEW_SMOKE_USER_DATA` | `windows-preview.mjs`, `windows-preview-smoke.mjs`, `main.mjs` | Fixture root, receipt path, phase and user-data override of the packaged Windows preview smoke; honoured only with `--devryan-preview-smoke` in a packaged Windows preview. | unset · absolute paths, phase name | QA hook |

Electron main sets `DEVRYAN_HOST`, `DEVRYAN_DIST_DIR`, `DEVRYAN_RUNTIME`,
`DEVRYAN_DESKTOP_NOTIFY`, `DEVRYAN_SKIP_API_COMPRESSION` and
`DEVRYAN_ALLOW_UNAUTHENTICATED_LAN` for the in-process server before importing it.

Before it starts the Windows standard-preview server, `windows-preview.mjs` removes
these inherited names (and the `OPENCHAMBER_*` alias of each DevRyan one) from its
environment: `DEVRYAN_RUNTIME_BUNDLE_ROOT`, `DEVRYAN_ELECTRON_USER_DATA_DIR`,
`DEVRYAN_ELECTRON_DEV`, `DEVRYAN_SKIP_OPENCODE_START`, and OpenCode's own
`OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
`OPENCODE_CONFIG_DIR`, `OPENCODE_PORT`, `OPENCODE_SERVER_URL`,
`OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SKIP_START`,
so that no installed bundle, development redirect, external OpenCode endpoint or
credential reaches the preview.

## Built-in agent configuration

| Variable | Reader (`packages/agents-core/src/`) | What it does | Default · values | Kind |
| --- | --- | --- | --- | --- |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `config/loader.ts` | Skips the project `.opencode` configuration walk, as OpenCode does. | off · true/1 | OpenCode switch |
| `OPENCODE_TUI_CONFIG` | `cli/paths.ts` | Path of OpenCode's TUI configuration file instead of `tui.json` in the configuration directory. | unset · path | path override |

## Not loaded by the native runtime

These are read only by code that the running product does not execute. The
native controller loads only the reviewed plugins compiled into it
(`DEVRYAN_REVIEWED_PLUGIN_ORIGINS`, checked in
`packages/web/server/lib/opencode/runtime-host/controller-startup.ts`), and its
environment is an allowlist (`runtime-host/native-runtime-owner.js`), so a value
set by a user or a shell cannot reach a plugin either. The reads are kept for
the legacy companion runtime and its tests.

| Variable | Reader (`packages/web/server/default-config/plugins/`) | What the code does | Why it has no effect |
| --- | --- | --- | --- |
| `DEVRYAN_OPEN_CURSOR_LOCAL_TOOLS` | `devryan-open-cursor.mjs` | `1` keeps open-cursor's local file and shell tools, which the wrapper otherwise drops. | The open-cursor registration is mapped to the compiled `devryan.provider-compat` plugin (`runtime-host/native-default-bundle.js`), which does not import this file. |
| `DEVRYAN_OPEN_CURSOR_MCP_BRIDGE` | `devryan-open-cursor.mjs` | `1` keeps open-cursor's MCP bridge; otherwise the wrapper sets `CURSOR_ACP_MCP_BRIDGE=false` unless that is set. | As above. |
| `DEVRYAN_OPENAI_OAUTH_URL`, `DEVRYAN_OPENAI_OAUTH_TOKEN` | `devryan-openai-oauth.mjs` | Private OpenAI OAuth bridge address and bearer token (credential). | `lib/opencode/openai-oauth-bridge.js` builds the pair and `application.js` hands it to the lifecycle runtime (`getManagedOAuthEnvironment`), which never passes it on; no compiled plugin imports the reader. |
| `DEVRYAN_OPENCODE_USER_CONFIG_DIR` | `devryan-document-reader.mjs`, `devryan-open-cursor.mjs` | Configuration root of the document cache and the open-cursor install. | Nothing in DevRyan sets it and the controller's allowlisted environment cannot carry it, so the default (the directory above the plugin file) applies. |
| `DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS`, `DEVRYAN_MANAGED_RESULT_MODE` | `devryan-managed-orchestration.mjs` | Account-default marker and result mode of the legacy orchestration plugin ([orchestration](../packages/web/server/lib/orchestration/DOCUMENTATION.md)). | No compiled plugin imports the file; the marker is not in the boot payload ([opencode](../packages/web/server/lib/opencode/DOCUMENTATION.md)). |
| `DEVRYAN_TASK_AGENT_VALIDATION` (plugin half) | `devryan-managed-orchestration.mjs` | The plugin's own agent-name check. | As above; the web server's check is live. |
| `OPENCODE_EXPERIMENTAL_WEBSOCKETS`, `OPENCODE_EXPERIMENTAL_NATIVE_LLM` | `devryan-primary-recovery.mjs` | Disable the legacy recovery plugin's enforcement ([provider recovery](PROVIDER_RECOVERY.md)). | No compiled plugin imports the file. |

## Documented elsewhere

Each of these is read by shipped code and described on the linked page.

- Web server and OpenCode host ([opencode](../packages/web/server/lib/opencode/DOCUMENTATION.md)):
  `DEVRYAN_AGENT_BROWSER_BIN`, `DEVRYAN_AGENTS_PRESET`, `DEVRYAN_BACKGROUND_COMPACTION`,
  `DEVRYAN_BROWSER_CDP_DISCOVERY_URL`, `DEVRYAN_BROWSER_CDP_TOKEN`, `DEVRYAN_DEFAULT_CONFIG_ROOT`,
  `DEVRYAN_ELECTRON_DEV`, `DEVRYAN_ELECTRON_USER_DATA_DIR`, `DEVRYAN_EXECUTION_ARTIFACTS`,
  `DEVRYAN_EXECUTION_VIEW`, `DEVRYAN_GIT_BINARY`, `DEVRYAN_HEALTH_RESTART_FAILURES`,
  `DEVRYAN_MANAGED_READ_OVERLAP`, `DEVRYAN_OPENCODE_GENERATION`, `DEVRYAN_PACKAGED_DESKTOP`,
  `DEVRYAN_RATE_LIMIT_MAX_ATTEMPTS`, `DEVRYAN_RATE_LIMIT_NO_IP_MAX_ATTEMPTS`,
  `DEVRYAN_RUNTIME_BUNDLE_ROOT`, `DEVRYAN_SERVED_FRESHNESS`, `DEVRYAN_SKIP_OPENCODE_START`,
  `DEVRYAN_STOP_ENDS_BACKGROUND_RUNS`, `DEVRYAN_TOOL_ATTACHMENT_OMIT`, `DEVRYAN_UPDATE_API_URL`,
  `OPENCODE_BINARY`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`, `OPENCODE_HOST`,
  `OPENCODE_SKIP_START`.
- Native runtime host ([runtime host](../packages/web/server/lib/opencode/runtime-host/DOCUMENTATION.md)):
  `DEVRYAN_ADAPTIVE_DELEGATION`, `DEVRYAN_CAPABILITY_TOOL_SCHEMA`, `DEVRYAN_CLAUDE_PATH`,
  `DEVRYAN_CODEX_CONTEXT_PIN`, `DEVRYAN_MANAGED_RESULT_CONTRACT_VERSION`, `DEVRYAN_MCP_ELICITATION`,
  `DEVRYAN_NATIVE_ARCHIVE`, `DEVRYAN_PLAN_READ_ADVISORY`, `DEVRYAN_READ_ONLY_SHELL_LIVE`,
  `DEVRYAN_REFUSE_DELEGATED_BACKGROUND`, `DEVRYAN_SYSTEM_CACHE_PRESERVE`, `DEVRYAN_TASK_AUTO_CONTINUE`,
  `OPENCODE_CLAUDE_PATH`.
- Saved approvals ([v2](../packages/web/server/lib/opencode/v2/DOCUMENTATION.md)): `DEVRYAN_SAVED_APPROVALS`.
- Harness runtime ([harness runtime](../packages/harness-runtime/DOCUMENTATION.md)):
  `DEVRYAN_ARTIFACT_DIR`, `DEVRYAN_CHILD_VIEW_PREWARM`, `DEVRYAN_DEVELOPER_TOOL_PATH`,
  `DEVRYAN_IGNORED_WRITE_THROUGH`, `DEVRYAN_LEDGER_DIRECT_LISTINGS`, `DEVRYAN_LEDGER_DIRECT_TREES`,
  `DEVRYAN_LEDGER_INCREMENTAL_FILE_INDEX`, `DEVRYAN_LEDGER_PATH_WINNERS`, `DEVRYAN_LEDGER_PERSISTENT_INDEX`,
  `DEVRYAN_LEDGER_PERSISTENT_READER`, `DEVRYAN_LEDGER_RUST`, `DEVRYAN_LEDGER_SYNC_WALKS`,
  `DEVRYAN_LEDGER_WORKER`, `DEVRYAN_MODULE_CACHE_OVERLAY`, `DEVRYAN_PERSISTENT_OBJECT_VERIFY`,
  `DEVRYAN_PREPARED_BASELINE_REUSE`, `DEVRYAN_SESSION_TMP`, `DEVRYAN_VIEW_REUSE`,
  `DEVRYAN_VIEW_SHARED_STANDBY`, `DEVRYAN_WORKER_BROWSERS`, `DEVRYAN_WORKER_GROUP_SIGNALS`.
- Concurrent revert ([concurrent revert](CONCURRENT_REVERT.md)): `DEVRYAN_EXECUTION_BOUNDARY`,
  `DEVRYAN_LAZY_BASE_RUNS`, `DEVRYAN_LEDGER_ANCESTRY_COMPACTION`, `DEVRYAN_LEDGER_BASELINE_REFS`,
  `DEVRYAN_LEDGER_COMPLEXITY_GUARD`, `DEVRYAN_LEDGER_PACK`, `DEVRYAN_LEDGER_REPOSITORY_CACHE`,
  `DEVRYAN_LEDGER_RESTAMP_BATCH`, `DEVRYAN_VIEW_CLONE`, `DEVRYAN_VIEW_FAST_MATERIALIZE`,
  `DEVRYAN_VIEW_STAT_REUSE`.
- Harness optimization switches ([harness optimization](HARNESS_OPTIMIZATION.md)):
  `DEVRYAN_COMPACT_MANAGED_RESULTS`, `DEVRYAN_COMPACTION_ANCHOR`, `DEVRYAN_DUPLICATE_OUTPUTS`,
  `DEVRYAN_MANAGED_WAIT_ANY`, `DEVRYAN_TASK_CONTEXT_PROJECTION`.
- Orchestration ([orchestration](../packages/web/server/lib/orchestration/DOCUMENTATION.md)):
  `DEVRYAN_ORCHESTRATION_TOKEN`, `DEVRYAN_ORCHESTRATION_URL`, `DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES`.
- Orchestration runtime ([orchestration runtime](../packages/orchestration-runtime/DOCUMENTATION.md)):
  `DEVRYAN_EVENT_DRIVEN_CHILD_WAIT`, `DEVRYAN_MANAGED_STOPPED_HANDOFF`,
  `DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY`.
- Provider recovery ([provider recovery](PROVIDER_RECOVERY.md)): `DEVRYAN_ANTHROPIC_RECOVERY_MODE`,
  `DEVRYAN_PRIMARY_RECOVERY_MODE`, `DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS`,
  `DEVRYAN_RECOVERY_ADVISORY_PLUGIN`.
- Files ([fs](../packages/web/server/lib/fs/DOCUMENTATION.md)): `DEVRYAN_FS_WATCH`,
  `DEVRYAN_GIT_READ_CACHE_TTL_MS`.
- Git ([git](../packages/web/server/lib/git/DOCUMENTATION.md)): `DEVRYAN_GIT_ASKPASS_TOKEN`.
- GitHub ([GitHub](../packages/web/server/lib/github/DOCUMENTATION.md)): `DEVRYAN_GITHUB_CLIENT_ID`,
  `DEVRYAN_GITHUB_SCOPES`.
- Multi-user ([multi-user](../packages/web/server/lib/multi-user/DOCUMENTATION.md)): `DEVRYAN_SUPABASE_URL`,
  `DEVRYAN_SUPABASE_PUBLISHABLE_KEY`, `DEVRYAN_SUPABASE_SECRET_KEY`.
- Supervised restart ([Supabase connection](SUPABASE_CONNECTION.md)): `DEVRYAN_SUPERVISED_RESTART`.
- Data folder ([shared runtime](../packages/shared-runtime/DOCUMENTATION.md)): `DEVRYAN_DATA_DIR`.
- Execution timing ([cache efficiency](CACHE_EFFICIENCY.md)): `DEVRYAN_EXECUTION_SUMMARY_MIN_MS`.
- QA ([QA](QA.md)): `DEVRYAN_QA_OPENCODE_VERSION`.

## Not covered

Variables that only tests, `packages/electron/tests/`, `scripts/` (including
`scripts/dev.mjs`, `scripts/qa/` and the test runners) or build configuration read
are left out, such as `DEVRYAN_PORT`, `DEVRYAN_DISABLE_PWA_DEV`, `DEVRYAN_HMR_API_PORT`,
`DEVRYAN_HMR_UI_PORT`, `DEVRYAN_DEV_FORCE_NPX_ELECTRON`, `DEVRYAN_DEV_RESTART_DELAY_MS`,
`DEVRYAN_SKIP_INSTALL_PREPARE` and `DEVRYAN_VITEST_EXCLUDE`. The test environment and
the variables it removes or passes through are described in [testing](TESTING.md)
(`scripts/test-isolation-guard.mjs`).
