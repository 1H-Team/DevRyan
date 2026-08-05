# VS Code Backend Modules

Managed OpenCode startup provisions the same sanitized repository-owned user profile used by web/Electron before generating runtime overlays. It resolves `default-config/user-profile` from the extension bundle, preserves user-modified managed files, installs missing declared plugins into the user's OpenCode config directory, and fails visibly when required package installation cannot complete. Shared provisioning also gives Meridian's OpenCode adapter a client-only prompt default, performs only the ownership-tracked exact-legacy-default migration, preserves explicit user prompt choices and unrelated Meridian settings, and reports combined prompting without overriding it. Managed agent overlays allow the active workspace, its worktree root, and the matching canonical `~/.config/openchamber/projects/<project-id>/plans` directory while preserving each agent's role-level read/edit restrictions. They also apply the web-owned visible-skill policy: only OpenCode and `.agents` sources are discovered, hidden and package-cache skills are removed, and each effective agent receives deny-by-default skill permissions plus only its visible named directories. Managed launches remove a broad external-skill disable flag and force the Claude-only skill disable flag so `.agents` remains available while `.claude` is never registered. When OpenAI is active through auth, `OPENAI_API_KEY`, or provider config, the managed overlay adds liveness bounds of 120 seconds for response headers, 300 seconds between stream chunks, and 15 minutes for the whole request. Explicit numeric values or `false` remain authoritative; each startup sync replaces stale DevRyan-generated values, removes the generated row when OpenAI becomes inactive, and never creates model availability. Configured external OpenCode URLs remain read-only.

The extension copies root `opencode.json`, agents, runtime-safe plugins, and sanitized profile assets through the web-owned default-config asset policy. Its packaged VSIX gate SHA-verifies that inventory and smoke-tests provisioning/overlay behavior from the extracted artifact; configured external runtimes are never provisioned or rewritten.

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers, including durable worktree receipt lookup,
    active-list, retry, preview, and legacy directory-status parity.
  - Repository checks and status are rooted at the exact requested project;
    nested non-repository projects do not inherit an ancestor's Git state.

- `worktreeLockRecovery.ts`
  - Applies the same bounded, file-identity-safe `populate_worktree` index-lock
    recovery used by web/Electron. Replaced locks are never removed.

- `harnessRuntime.ts`
  - Extension-host owner for the shared lifecycle tracker, 256 MiB sanitized
    journal, durable worktree store/reconciliation, and optional project turn
    evidence under `globalStorageUri/harness/`.
- `harness-runtime-access.ts`
  - Dependency-light active-runtime registry used by SSE and proxy hot paths
    without loading VS Code-only Git host code.

- `bridge-diagnostics-runtime.ts` / `bridge-evidence-runtime.ts`
  - Mirror the web diagnostics and evidence contracts through the extension
    bridge, including status, export, and journal clearing. Diagnostics ZIPs
    use a native save dialog and private atomic sibling file; evidence remains
    default-off and read-only.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`commit-message`, `pr-description`, `conflict-details`) and generation helpers.
  - Commit-message generation sends bounded worktree context directly to the commit-specific free Zen model `deepseek-v4-flash-free` with a 60-second request deadline and returns one validated Conventional Commit subject without creating an OpenCode session. Explicit model overrides remain supported; PR generation retains its separate existing flow.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper
  - File reads and mutations are canonicalized against the active workspace plus the narrow compatibility config root `~/.config/openchamber`. Other home-directory paths remain denied, command execution remains workspace-only, and symlink escapes from either allowed root are rejected.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - The managed `/config/providers` proxy annotates OpenAI models with the same sanitized authentication and OAuth-only availability metadata as web/Electron, using `openaiModelAvailability.ts`.
  - Managed catalogs replace any stale Cursor row with the cached Cursor SDK virtual provider and trigger a non-blocking metadata refresh. If discovery changes the cached catalog after the response, the requesting webview reloads providers once so cold-start context limits become visible without manual action. Configured external OpenCode catalogs remain unchanged, and credentials are never included in serialized responses.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - Includes the read-only OpenCode update-check parity handler used by shared About settings. It compares the manager's active managed or external runtime version without installing or restarting OpenCode.
  - Uses `opencodeConfig.ts` to expose the shared manifest-derived DevRyan default-plugin catalog, plus read-only plugin entries and both singular `plugin/` and plural `plugins/` user/project files. Matching entries/files carry their default identity so Settings can preserve effective overrides without duplicate rows. Managed entries are local installed or bundled paths; VS Code does not reintroduce package or Git registrations.
  - Delegates `/api/behavior/agents-md` bridge reads and saves to the injected `globalAgentsMdRuntime.ts`, keeping the actual global file authoritative while matching web/Electron read-only and partial-refresh semantics.
  - Routes agent model/variant defaults through OpenCode Slim config when `oh-my-opencode-slim` owns the active agent catalog, using Slim-installed global `agents/*.md` prompts plus Slim preset/root model metadata.
  - Passes Slim's active preset into managed OpenCode with `OH_MY_OPENCODE_SLIM_PRESET`, copies the active Slim config into the runtime overlay `OPENCODE_CONFIG_DIR`, and keeps background subagents enabled for Slim orchestration.

- `opencodeVersionPolicy.ts`
  - Target external OpenCode runtime policy. DevRyan recommends `anomalyco/opencode` v1.18.13 and exposes the upstream install command in diagnostics while still using the user/system `opencode` binary.

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Update checks use the latest stable release from the canonical
    `zoubenr/DevRyan` GitHub repository by default. The compatibility
    `OPENCHAMBER_UPDATE_API_URL` override retains its legacy request contract.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Mirrors web/Electron Claude Code status and configuration with `claude auth status --json`, avoiding model requests during authentication checks and returning structured signed-in, signed-out, unavailable, and execution-error states.
  - Hosts the HTTP-shaped managed quota credential contract for the webview, including independent host-side 16 KB enforcement and the same safe error/status shapes as web/Electron.

- `anthropicOAuthPlugin.ts` and `claudeAuthStatus.ts`
  - Own VS Code parity for the reviewed installed Claude proxy entrypoint and safe Claude Code authentication-status parsing. Known DevRyan-managed package specs migrate to the provisioned local path; explicit user pins are preserved.

- `quotaCredentials.ts`
  - Owns VS Code's contract-equivalent managed quota credential files for `opencode-go`, `ollama-cloud`, and canonical `cursor-acp` (`cursor` is an API alias only).
  - Uses allowlisted paths under `${OPENCHAMBER_DATA_DIR ?? ~/.config/openchamber}/quota`, `0700` directories, atomic `0600` files, exact payload normalization, fixed masking, and explicit read-only macOS Cursor import.
  - Does not read Cursor storage automatically and never modifies Cursor's database, environment/token files, OpenCode auth fields, or Cursor SDK execution credentials.

- `quotaProviders.ts`
  - Resolves quota credentials with web parity: OpenCode Go environment → managed → legacy; Cursor environment/token-file OAuth → managed OAuth/dashboard → legacy dashboard token; Ollama managed → legacy cookie file.
  - Persists a refreshed Cursor OAuth access token only when its source is managed.
  - Resolves managed Claude discovery and fetching from the same active OpenCode provider context, recognizes all supported Anthropic auth aliases, validates OAuth primary windows, uses the loopback-only Meridian structured endpoint, falls back to the non-billable Claude `/usage` command, keeps configured failures visible, and never substitutes local usage for external OpenCode runtimes.

- `managedOrchestrationRuntime.ts`
  - Composes the one VS Code-owned `@openchamber/orchestration-runtime` scheduler.
  - Immediately admits every eligible DevRyan-managed child without an artificial concurrency cap, enforces a minimum 30-minute ordinary deadline plus a 60-minute Oracle floor for starts and follow-ups, preserves the private Council three-minute deadline class, gives retry/resume/retry-in-place fresh agent-aware default deadlines, preserves timeout causes with bounded abort-request cancellation and same-child resumability after failed immediate recovery, scopes task access, clamps optional positive-safe-integer wait slices to 25 seconds, exposes abortable `wait_result_action` recovery synchronization, unbounded root `barrier`, and non-blocking `barrier_status` RPCs, performs inspection-first confirmed agent handoff, preserves deterministic admission/cancellation, requires explicit user-selected same-child `retry_in_place` for provider-limit recovery, returns the recovered lineage to the pending parent tool invocation, maps `manual_model_recovery_required` to HTTP 409, retains legacy `recover_in_place` ledger compatibility, and reports external-runtime unavailability.
  - Publishes safe task projections without private dispatch groups, identity-only compaction removals, and corrupt-ledger recovery warnings to open webviews.

- `managedOrchestrationPersistence.ts`
  - Stores the versioned scheduler ledger under extension global storage with atomic replacement, mode `0600`, serialized writes, pre-barrier task hydration to `dispatchGroupId: null`, pre-correlation task hydration to `dispatchCallId: null`, validation, and quarantine-on-corruption.

- `managedOrchestrationHost.ts`
  - Hosts the private bearer-authenticated `127.0.0.1` RPC endpoint used by the bundled managed-orchestration tool.
  - Bounds request bodies, aborts active requests during shutdown, and never exposes the token through the webview bridge.

- `managedOpenCodeExecutor.ts`
  - Creates canonical OpenCode child sessions and routes normal providers through OpenCode HTTP.
  - Routes `cursor-acp` prompts, status, messages, aborts, and stale-child state cleanup through the shared Cursor SDK owner.
  - Enforces scheduler lease checkpoints before prompt and after provider acceptance; a stale fresh child is aborted and deleted from OpenCode instead of being prompted or left orphaned.
  - Applies the shared Copilot prompt-tool policy through `@openchamber/orchestration-runtime`, whose observer keeps provider retries live, recovers transient polling failures against the same child, and retains partial output on non-retryable interruption. Its typed 503 API-URL unavailability also feeds the shared deadline-bounded reconciliation retry, preserving the canonical child while the VS Code runtime reconnects.

- `bridge-orchestration-runtime.ts`
  - Maps snapshot/status/cancel/acknowledge/handoff requests from the webview to the scoped runtime contract.
  - Returns HTTP-shaped status/body results inside successful bridge responses so authoritative failures remain visible and retryable.

- `opencode.ts`
  - Managed launches retain config-origin bundled plugins, including GitHub Copilot Auto/picker fallback and exact OpenAI GPT-5.6 Max/Ultra enrichment, and receive a validated private bridge URL/token pair. The OpenAI plugin also upgrades advertised reasoning-summary defaults from `auto` to `detailed` while preserving explicit provider values and provider reasoning text. The plugins only enrich model rows advertised by that managed runtime. Configuration restarts coalesce while sessions are busy; the explicit Restart API command retains a forced recovery path.
  - Ambient bridge variables are stripped; incomplete or non-IPv4-loopback pairs are rejected.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## Quota credential parity

The webview maps `GET`, `PUT`, `POST validate`, `POST import`, and `DELETE` under `/api/quota/credentials/:providerId` to one `api:quota:credentials` bridge message. It checks the 16 KB body limit before crossing the bridge; the extension host recomputes and enforces the limit again. The bridge returns an HTTP-shaped `{ status, body }` result so the shared settings UI receives the same canonical provider IDs, safe metadata, and stable error codes in web, Electron, and VS Code. The shared UI continues to use the single existing quota refresh coordinator after save, delete, or import.

## Managed orchestration lifecycle

1. `extension.ts` creates the OpenCode manager with a lazy bridge-environment callback, then creates the orchestration owner before starting OpenCode.
2. A managed OpenCode start asks the owner for the private URL/token; configured external OpenCode never receives or controls this owner.
3. Connected managed runtimes initialize/reconcile the persisted ledger. The bundled plugin uses authoritative assistant ownership plus non-blocking barrier status before primary-agent work tools, while keeping required skill invocation available; safe task and compaction events are broadcast to each open webview, while initial state remains recoverable through snapshots.
4. Webviews use `/api/orchestration/*`, which `webview/api/orchestration.ts` maps to the extension bridge.
5. Deactivation stops the private host and scheduler before stopping OpenCode, preserving terminal/partial records while releasing listeners and active work.
