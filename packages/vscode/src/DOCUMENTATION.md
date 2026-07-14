# VS Code Backend Modules

Managed OpenCode startup provisions the same sanitized repository-owned user profile used by web/Electron before generating runtime overlays. It resolves `default-config/user-profile` from the extension bundle, preserves user-modified managed files, installs missing declared plugins into the user's OpenCode config directory, and fails visibly when required package installation cannot complete. Configured external OpenCode URLs remain read-only.

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

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

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - The managed `/config/providers` proxy annotates OpenAI models with the same sanitized authentication and OAuth-only availability metadata as web/Electron, using `openaiModelAvailability.ts`.
  - Managed catalogs replace any stale Cursor row with the cached Cursor SDK virtual provider and trigger a non-blocking metadata refresh. If discovery changes the cached catalog after the response, the requesting webview reloads providers once so cold-start context limits become visible without manual action. Configured external OpenCode catalogs remain unchanged, and credentials are never included in serialized responses.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - Delegates `/api/behavior/agents-md` bridge reads and saves to the injected `globalAgentsMdRuntime.ts`, keeping the actual global file authoritative while matching web/Electron read-only and partial-refresh semantics.
  - Routes agent model/variant defaults through OpenCode Slim config when `oh-my-opencode-slim` owns the active agent catalog, using Slim-installed global `agents/*.md` prompts plus Slim preset/root model metadata.
  - Passes Slim's active preset into managed OpenCode with `OH_MY_OPENCODE_SLIM_PRESET`, copies the active Slim config into the runtime overlay `OPENCODE_CONFIG_DIR`, and keeps background subagents enabled for Slim orchestration.

- `opencodeVersionPolicy.ts`
  - Target external OpenCode runtime policy. DevRyan recommends `anomalyco/opencode` v1.18.1 and exposes the upstream install command in diagnostics while still using the user/system `opencode` binary.

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).

- `managedOrchestrationRuntime.ts`
  - Composes the one VS Code-owned `@openchamber/orchestration-runtime` scheduler.
  - Enforces a maximum of three running DevRyan-managed children, a minimum 30-minute ordinary start deadline, the private Council three-minute deadline class, fresh default deadlines for retry/resume/retry-in-place, scoped task access, abortable root `barrier` plus non-blocking `barrier_status` RPCs, inspection-first confirmed agent handoff, deterministic queueing/cancellation, recovery-envelope acknowledgement (including same-child `retry_in_place` model overrides), and external-runtime unavailability.
  - Publishes safe task projections without private dispatch groups, identity-only compaction removals, and corrupt-ledger recovery warnings to open webviews.

- `managedOrchestrationPersistence.ts`
  - Stores the versioned scheduler ledger under extension global storage with atomic replacement, mode `0600`, serialized writes, pre-barrier task hydration to `dispatchGroupId: null`, validation, and quarantine-on-corruption.

- `managedOrchestrationHost.ts`
  - Hosts the private bearer-authenticated `127.0.0.1` RPC endpoint used by the bundled managed-orchestration tool.
  - Bounds request bodies, aborts active requests during shutdown, and never exposes the token through the webview bridge.

- `managedOpenCodeExecutor.ts`
  - Creates canonical OpenCode child sessions and routes normal providers through OpenCode HTTP.
  - Routes `cursor-acp` prompts, status, messages, and aborts through the shared Cursor SDK owner.
  - Applies the shared Copilot prompt-tool policy through `@openchamber/orchestration-runtime`, whose observer keeps provider retries live, recovers transient polling failures against the same child, and retains partial output on non-retryable interruption.

- `bridge-orchestration-runtime.ts`
  - Maps snapshot/status/cancel/acknowledge/handoff requests from the webview to the scoped runtime contract.
  - Returns HTTP-shaped status/body results inside successful bridge responses so authoritative failures remain visible and retryable.

- `opencode.ts`
  - Managed launches retain config-origin bundled plugins, including GitHub Copilot Auto/picker fallback and exact OpenAI GPT-5.6 Max/Ultra enrichment, and receive a validated private bridge URL/token pair. The plugins only enrich model rows advertised by that managed runtime.
  - Ambient bridge variables are stripped; incomplete or non-IPv4-loopback pairs are rejected.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## Managed orchestration lifecycle

1. `extension.ts` creates the OpenCode manager with a lazy bridge-environment callback, then creates the orchestration owner before starting OpenCode.
2. A managed OpenCode start asks the owner for the private URL/token; configured external OpenCode never receives or controls this owner.
3. Connected managed runtimes initialize/reconcile the persisted ledger. The bundled plugin uses authoritative assistant ownership plus non-blocking barrier status before primary-agent work tools, while keeping required skill invocation available; safe task and compaction events are broadcast to each open webview, while initial state remains recoverable through snapshots.
4. Webviews use `/api/orchestration/*`, which `webview/api/orchestration.ts` maps to the extension bridge.
5. Deactivation stops the private host and scheduler before stopping OpenCode, preserving terminal/partial records while releasing listeners and active work.
