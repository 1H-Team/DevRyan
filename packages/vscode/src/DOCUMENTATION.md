# VS Code Backend Modules

Managed OpenCode startup provisions the same sanitized repository-owned user profile used by web/Electron before generating runtime overlays. It resolves `default-config/user-profile` from the extension bundle, preserves user-modified managed files, installs missing declared plugins into the user's OpenCode config directory, and fails visibly when required package installation cannot complete. Shared provisioning gives Meridian's OpenCode adapter a combined Claude Code/client prompt default, migrates the previously owned client-only baseline, and preserves explicit user prompt choices and unrelated Meridian settings. The provider bridge exposes the same safe persistent Claude-only compatibility switch as web/Electron; configured external runtimes are read-only. Managed agent overlays allow the active workspace, its worktree root, and the matching canonical `~/.config/openchamber/projects/<project-id>/plans` directory while preserving each agent's role-level read/edit restrictions. They also apply the web-owned approved-skill resolver: locally discovered OpenCode and `.agents` paths are authoritative, live runtime metadata may enrich exact path matches only, hidden, retired, cache, upstream-only, `.cursor`, `.codex`, and `.claude` skills are removed, and every skill-capable managed agent receives deny-by-default exact-name permissions plus only its visible named directories. Managed launches remove a broad external-skill disable flag and force the Claude-only skill disable flag so `.agents` remains available while `.claude` is never registered. When OpenAI is active through auth, `OPENAI_API_KEY`, or provider config, the managed overlay adds liveness bounds of 120 seconds for response headers, 300 seconds between stream chunks, and 15 minutes for the whole request. Explicit numeric values or `false` remain authoritative; each startup sync replaces stale DevRyan-generated values, removes the generated row when OpenAI becomes inactive, and never creates model availability.

On POSIX hosts, those managed overlays also allow `/tmp` and its canonical real path for every agent that declares a permission block, without widening the agent's read, edit, or tool permissions.

The extension copies root `opencode.json`, agents, runtime-safe plugins, and sanitized profile assets through the web-owned default-config asset policy. Its packaged VSIX gate SHA-verifies that inventory and smoke-tests provisioning/overlay behavior from the extracted artifact; configured external runtimes are never provisioned or rewritten.

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

The extension manifest targets VS Code 1.101 or newer. This keeps the extension host on a Node runtime compatible with the shared `@cursor/sdk` 1.0.28 requirement (Node.js 22.13+); the shared Cursor runtime also fails with an actionable error before SDK import when that invariant is violated.

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior. Provider source and disconnect messages in `bridge-system-runtime.ts` mirror the web contract: Google removes both credential aliases; synthetic Antigravity detects/removes its account pool and only Antigravity models nested under Google; disconnect-all includes the current workspace but never unrelated projects, reports per-source results, and invalidates the provider runtime even when storage was already clean.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers, including durable worktree receipt lookup,
    active-list, retry, preview, and legacy directory-status parity.
  - New worktrees use the shared bounded post-checkout runner immediately after
    population. Effective `core.hooksPath` semantics, Git 2.36+ capability
    checks, exact checkout arguments, timeout/output sanitization, and explicit
    retry behavior match web/Electron.
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
  - Commit-message drafts accept selected paths and staging mode, then collect status/history, line statistics, and at most two bounded batch diffs in the extension host. The shared runtime gives direct Zen generation the remainder of a 4.5-second end-to-end budget, repairs overlong Conventional Commit subjects, returns two to four commit-body details, and falls back to a deterministic factual local draft after slow, unavailable, or invalid AI output. Slow models enter a five-minute cooldown and one action never performs a second provider attempt. Sanitized timings include AI/local source and provider outcome; no OpenCode session is created. The context-based bridge message remains supported; PR generation retains its separate existing flow.

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
  - Assistant-gallery raw requests carry an internal workspace-only marker. They resolve against the active workspace with lexical and canonical containment, reject mismatched directory hints and symlink/outside paths, and never honor or forward web-server asset grants.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - The managed `/config/providers` proxy annotates OpenAI models with the same sanitized authentication and OAuth-only availability metadata as web/Electron, using `openaiModelAvailability.ts`.
  - Managed catalogs replace any stale Cursor row with the cached Cursor SDK virtual provider and trigger a non-blocking metadata refresh. If discovery changes the cached catalog after the response, the requesting webview reloads providers once so cold-start context limits become visible without manual action. Configured external OpenCode catalogs remain unchanged, and credentials are never included in serialized responses.
  - Managed Grok catalog reads prefetch tool schemas into a bounded host-local cache. Prompt forwarding merges only schema-verified duplicate MCP alias disables and never awaits discovery; missing or stale evidence preserves every tool.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - Includes the read-only OpenCode update-check parity handler used by shared About settings. It compares the manager's active managed or external runtime version without installing or restarting OpenCode.
  - Uses `opencodeConfig.ts` to expose the shared manifest-derived DevRyan default-plugin catalog, plus read-only plugin entries and both singular `plugin/` and plural `plugins/` user/project files. Matching entries/files carry their default identity so Settings can preserve effective overrides without duplicate rows. Managed entries are local installed or bundled paths; VS Code does not reintroduce package or Git registrations.
  - Delegates `/api/behavior/agents-md` bridge reads and saves to the injected `globalAgentsMdRuntime.ts`, keeping the actual global file authoritative while matching web/Electron read-only and partial-refresh semantics.
  - Routes agent model/variant defaults through OpenCode Slim config when `oh-my-opencode-slim` owns the active agent catalog, using Slim-installed global `agents/*.md` prompts plus Slim preset/root model metadata.
  - Passes Slim's active preset into managed OpenCode with `OH_MY_OPENCODE_SLIM_PRESET`, copies the active Slim config into the runtime overlay `OPENCODE_CONFIG_DIR`, and keeps background subagents enabled for Slim orchestration.

- `configApplyRuntime.ts`
  - Hosts the same `@openchamber/shared-runtime` revisioned apply coordinator as
    web/Electron and maps status, when-idle/forced apply, and external-runtime
    acknowledgement through HTTP-shaped bridge messages. Config mutations only
    mark exact scopes; restart ownership remains here rather than in UI prompts.

- `opencodeVersionPolicy.ts`
  - Target external OpenCode runtime policy. DevRyan recommends `anomalyco/opencode` v1.18.23 and exposes the upstream install command in diagnostics while still using the user/system `opencode` binary.

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers. Shared settings migrate the legacy wide-chat boolean to the numeric chat-width preference before returning it to the webview.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Update checks use the latest stable release from the canonical
    `1H-Team/DevRyan` GitHub repository by default. The compatibility
    `OPENCHAMBER_UPDATE_API_URL` override retains its legacy request contract.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Mirrors web/Electron Claude Code status and configuration with `claude auth status --json`, avoiding model requests during authentication checks and returning structured signed-in, signed-out, unavailable, and execution-error states.
  - Hosts the HTTP-shaped managed quota credential contract for the webview, including independent host-side 16 KB enforcement and the same safe error/status shapes as web/Electron.

- `anthropicOAuthPlugin.ts` and `claudeAuthStatus.ts`
  - Own VS Code parity for the reviewed installed Claude proxy entrypoint and safe Claude Code authentication-status parsing. Known DevRyan-managed package specs migrate to the provisioned local path; explicit user pins are preserved.

- `quotaCredentials.ts`
  - Owns VS Code's contract-equivalent managed quota credential files for OpenCode Zen (`opencode`), `ollama-cloud`, and canonical `cursor-acp` (`cursor` is an API alias only).
  - Uses allowlisted paths under `${OPENCHAMBER_DATA_DIR ?? ~/.config/openchamber}/quota`, `0700` directories, atomic `0600` files, exact payload normalization, fixed masking, and explicit read-only macOS Cursor import.
  - Does not read Cursor storage automatically and never modifies Cursor's database, environment/token files, OpenCode auth fields, or Cursor SDK execution credentials.

- `quotaProviders.ts`
  - Resolves quota credentials with web parity: OpenCode Zen uses only its managed workspace/dashboard cookie; OpenCode Go uses its provider API key; Cursor environment/token-file OAuth → managed OAuth/dashboard → legacy dashboard token; Ollama managed → legacy cookie file.
  - Persists a refreshed Cursor OAuth access token only when its source is managed.
  - Resolves managed Claude discovery and fetching from the same active OpenCode provider context, recognizes all supported Anthropic auth aliases, validates OAuth primary windows, uses the loopback-only Meridian structured endpoint, falls back to the non-billable Claude `/usage` command, keeps configured failures visible, and never substitutes local usage for external OpenCode runtimes.
  - Delegates OpenCode Zen, z.ai, Kimi, Codex, xAI, and DeepSeek requests/normalization to
    `@openchamber/shared-runtime`. xAI refreshes once on 401 and persists rotated
    OAuth credentials through the existing OpenCode auth writer; warning and value-only row behavior matches
    web/Electron.

- `skillsCatalog.ts`
  - Uses the shared bounded ZIP downloader and transactional safe-archive
    installer for ClawdHub. Public `ARCHIVE_*` item codes, ordinary
    `installFailed` errors, cleanup, and rollback behavior match web/Electron.

- `managedOrchestrationRuntime.ts`
  - Composes the one VS Code-owned `@openchamber/orchestration-runtime` scheduler.
  - Rejects an unsupported read-only provider with `MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED` and rejects read-only Designer dispatch with `MANAGED_READ_ONLY_AGENT_UNSUPPORTED` before scheduler persistence or event publication, matching web/Electron admission behavior.
  - Immediately admits every eligible DevRyan-managed child without an artificial concurrency cap, gives focused Oracle reviews 15 minutes, preserves explicit 30-minute deep Oracle windows, keeps 60-minute Designer/Fixer deadlines and a 30-minute floor for other ordinary specialists on starts and follow-ups, preserves the private Council three-minute deadline class, makes retry/resume/retry-in-place inherit at least the source task's full window while accepting larger explicit extensions, preserves timeout causes with bounded abort-request cancellation and same-child resumability after failed immediate recovery, scopes task access, clamps optional positive-safe-integer wait slices to 25 seconds, supports eager-by-default private result projection plus strictly task/root/directory-scoped stateless `read_result` pages without scheduler mutation, exposes abortable `wait_result_action` recovery synchronization, atomic claim/release RPCs for exactly-once recovered-parent wakes, unbounded root `barrier`, and non-blocking `barrier_status` RPCs, performs inspection-first confirmed agent handoff, preserves deterministic admission/cancellation, requires explicit user-selected same-child `retry_in_place` for provider-limit recovery, requires provider prompt rejection recovery to use one rewritten-prompt fresh child, returns recovered lineage to the pending parent tool invocation, maps manual and prompt-rejection policy conflicts to HTTP 409, retains legacy `recover_in_place` ledger compatibility, reports external-runtime unavailability, and uses the shared managed executor so OpenCode-backed child starts and continuations retain the same writable/read-only Context Mode grants as web/Electron while Cursor SDK turns remain unchanged.
  - Publishes safe task projections without private dispatch groups, identity-only compaction removals, and corrupt-ledger recovery warnings to open webviews.

- `managedOrchestrationPersistence.ts`
  - Stores the versioned scheduler ledger under extension global storage with atomic replacement, mode `0600`, serialized writes, pre-barrier task hydration to `dispatchGroupId: null`, pre-correlation task hydration to `dispatchCallId: null`, validation, and quarantine-on-corruption.

- `managedOrchestrationHost.ts`
  - Hosts the private bearer-authenticated `127.0.0.1` RPC endpoint used by the bundled managed-orchestration tool.
  - Bounds request bodies, aborts active requests during shutdown, and never exposes the token through the webview bridge.

- `managedOpenCodeExecutor.ts`
  - Creates canonical OpenCode child sessions and routes normal providers through OpenCode HTTP. Pending status reads share only an exact fully resolved URL within this executor; settled requests, directory/port changes, and Cursor SDK status never share that transport operation.
  - Routes `cursor-acp` prompts, status, messages, aborts, and stale-child state cleanup through the shared Cursor SDK owner.
  - Enforces scheduler lease checkpoints before prompt and after provider acceptance; a stale fresh child is aborted and deleted from OpenCode instead of being prompted or left orphaned.
  - Applies the shared Copilot prompt-tool policy through `@openchamber/orchestration-runtime`, whose observer keeps transient provider retries live, immediately settles structured OpenCode `free_tier_limit` retries for Model Recovery, recovers transient polling failures against the same child, and retains partial output on non-retryable interruption. Its typed 503 API-URL unavailability also feeds the shared deadline-bounded reconciliation retry, preserving the canonical child while the VS Code runtime reconnects.
  - Routes canonical global `session.error` events into the shared bounded terminal-error registry. Prompt-attempt boundaries ignore stale failures; model-not-found events settle immediately as `model_unavailable` with retained partial output and user-selected Model Recovery. Before child creation, a readable directory-scoped `/config/providers` catalog must contain the exact selected provider/model; catalog transport failure remains non-authoritative.

- `bridge-orchestration-runtime.ts`
  - Maps snapshot/status/cancel/acknowledge/handoff requests from the webview to the scoped runtime contract.
  - Returns HTTP-shaped status/body results inside successful bridge responses so authoritative failures remain visible and retryable.

- `opencode.ts`
  - Managed launches retain config-origin bundled plugins, including GitHub Copilot Auto/picker fallback and exact OpenAI GPT-5.6 Max/Ultra enrichment, and receive a validated private bridge URL/token pair. The OpenAI plugin also upgrades advertised reasoning-summary defaults from `auto` to `detailed` while preserving explicit provider values and provider reasoning text. The plugins only enrich model rows advertised by that managed runtime. Configuration changes use the revisioned apply coordinator: they can wait for authoritative idle state or take the administrator-authorized force path without losing concurrent mutations. Managed spawn also sets aligned `CONTEXT_MODE_DATA_DIR` and `CONTEXT_MODE_DIR` under the OpenChamber data directory.
  - Ambient bridge variables are stripped; incomplete or non-IPv4-loopback pairs are rejected.
  - A surviving context-mode `SQLITE_IOERR` closes prompt and managed-task admission, preserves active turns while polling authoritative runtime status, and restarts at zero active sessions with capped backoff. Recovery status is exposed through diagnostics; lock contention does not restart, and configured external OpenCode receives owner-restart guidance without mutation.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## Standard session titles

`sessionTitleRuntime.ts` instantiates the same authoritative coordinator used by web/Electron against the manager's current OpenCode URL and auth headers. `bridge-proxy-runtime.ts` schedules it only after an accepted non-Cursor prompt, captures visible non-synthetic text plus provider/model/variant, and triggers bounded placeholder recovery after session-list loads. Valid free-Zen or isolated selected-model results are broadcast immediately to chat, agent-manager, and session-editor webviews; `sessionActivityWatcher.ts` forwards canonical events for safe idle persistence, manual-rename protection, and deletion cleanup. `zenModelCatalogRuntime.ts` shares one five-minute, single-flight served-and-zero-cost catalog between Settings and title generation. Managed runtime overlays disable OpenCode's built-in title agent and add hidden no-tools `devryan-title`; the topic-first contract ignores Plan mode and requested planning deliverables, title source text is isolated as untrusted JSON data, and source-aware local correction removes incidental planning prefixes without another model call while preserving literal Plan concepts. One invalid helper answer gets a bounded repair request, and stale exact-title helper sessions are removed on watcher connection. Cursor execution remains on its existing title path and receives no request from this runtime.

## Quota credential parity

The webview maps `GET`, `PUT`, `POST validate`, `POST import`, and `DELETE` under `/api/quota/credentials/:providerId` to one `api:quota:credentials` bridge message. It checks the 16 KB body limit before crossing the bridge; the extension host recomputes and enforces the limit again. The bridge returns an HTTP-shaped `{ status, body }` result so the shared settings UI receives the same canonical provider IDs, safe metadata, and stable error codes in web, Electron, and VS Code. The shared UI continues to use the single existing quota refresh coordinator after save, delete, or import.

## Managed orchestration lifecycle

1. `extension.ts` creates the OpenCode manager with a lazy bridge-environment callback, then creates the orchestration owner before starting OpenCode.
2. A managed OpenCode start asks the owner for the private URL/token; configured external OpenCode never receives or controls this owner.
3. Connected managed runtimes initialize/reconcile the persisted ledger. The bundled plugin uses authoritative assistant ownership plus non-blocking barrier status before primary-agent work tools, while keeping required skill invocation available; safe task and compaction events are broadcast to each open webview, while initial state remains recoverable through snapshots.
4. Webviews use `/api/orchestration/*`, which `webview/api/orchestration.ts` maps to the extension bridge.
5. Deactivation stops the private host and scheduler before stopping OpenCode, preserving terminal/partial records while releasing listeners and active work.
