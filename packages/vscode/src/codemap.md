# packages/vscode/src/

## Responsibility
VS Code extension-host implementation: activation lifecycle, command surface, webview providers, OpenCode process management, and bridge runtime handlers.

## Design
- `extension.ts` is the orchestrator entrypoint.
- Provider classes (`ChatViewProvider`, `SessionEditorPanelProvider`, `AgentManagerPanelProvider`) encapsulate webview setup and host↔webview synchronization.
- `bridge.ts` is a dispatcher that routes message types to focused runtime modules (`bridge-fs-runtime`, `bridge-git-runtime`, `bridge-system-runtime`, etc.).
- `harnessRuntime.ts` owns the extension-host lifecycle tracker, sanitized
  journal, durable worktree receipts, and optional evidence. The lightweight
  `harness-runtime-access.ts` registry lets bridge/SSE paths reach the active
  runtime without importing VS Code-only Git host dependencies.
- `worktreeLockRecovery.ts` owns bounded, identity-safe recovery for worktree
  population collisions on `index.lock`.
- `gitService.ts` injects `@openchamber/harness-runtime`'s bounded post-checkout
  hook runner into version 3 worktree receipts, matching web/Electron stage
  order and retry semantics.
- `opencode.ts` provides a manager object with explicit connection status and restart/start/stop APIs. Managed launches isolate context-mode storage under the OpenChamber data directory and expose authoritative live session counts plus recovery status.
- `contextModeRecovery.ts` owns the single-flight admission-controlled `SQLITE_IOERR` state machine, active-turn preservation, authoritative-idle restart backoff, and external-owner guidance. SQLite lock contention is excluded.
- `sessionActivityWatcher.ts` tracks session busy/idle/cooldown and feeds true context-mode IOERR tool failures into recovery; historical activity is not the idle source of truth.
- `opencodeConfig.ts` owns VS Code-side config entity reads/writes, read-only singular/plural plugin-file discovery, OpenCode Slim config/agent override parity, Slim-installed global agent prompt composition, and managed agent runtime overlays so saved user-side agent model defaults, plugin filtering, and blocked ambient MCP tombstones apply to the local OpenCode process.
- `globalAgentsMdRuntime.ts` owns user-global `~/.config/opencode/AGENTS.md` reads/writes, empty-file removal, UTF-8 limits, external-runtime read-only policy, and restart-warning results for the VS Code bridge.
- `bridge-system-runtime.ts` owns VS Code provider auth/status/configure bridge behavior, including non-billable Claude Code status checks, Cursor SDK integration via `@openchamber/cursor-sdk-runtime`, and the HTTP-shaped managed quota credential bridge contract.
- `bridge-config-runtime.ts` owns config/skills requests plus OpenCode resolution and read-only update-check parity for the shared Settings UI; the update check uses the manager's active managed or external runtime version.
- `configApplyRuntime.ts` hosts the shared revisioned configuration-apply coordinator and its status/apply/external-acknowledgement bridge contract.
- `claudeAuthStatus.ts` and `anthropicOAuthPlugin.ts` mirror the web/Electron safe auth-status contract and pinned Claude proxy migration policy.
- `quotaCredentials.ts` owns allowlisted private managed quota files and explicit read-only Cursor import; `quotaProviders.ts` owns quota-source precedence and keeps those credentials separate from Cursor SDK execution auth. z.ai, Kimi, Codex, xAI, and DeepSeek use `@openchamber/shared-runtime` adapters.
- `skillsCatalog.ts` adapts ClawdHub transport and destination policy to the shared safe-archive installer.
- `managedOrchestrationRuntime.ts` composes the VS Code-owned scheduler and scoped RPC contract, including pre-admission read-only provider compatibility and implementation-only Designer checks, validated 25-second maximum wait slices, eager/reference result projection, strictly scoped stateless `read_result` paging, unbounded root barrier inspection, and confirmed agent handoff.
- `managedOrchestrationPersistence.ts` owns the private atomic extension-storage ledger, legacy dispatch-group hydration, and corrupt-ledger quarantine.
- `managedOrchestrationHost.ts` owns the bearer-authenticated IPv4 loopback bridge used only by managed OpenCode plugins.
- `managedOpenCodeExecutor.ts` owns canonical normal-provider and Cursor child-session execution, including per-executor exact-URL status single-flight and stale fresh-child cleanup through both OpenCode and the Cursor state owner.
- `bridge-orchestration-runtime.ts` adapts scoped webview requests, including safe handoff projections, without exposing private task inputs or bridge credentials.

## Flow
1. Extension activates, creates one managed-orchestration owner, then creates/starts OpenCode with a lazily prepared private bridge for managed launches.
2. View providers register and load generated webview HTML.
3. Webview requests arrive as bridge messages.
4. Router resolves handler, executes operation, returns typed response.
5. Host pushes connection/theme/session plus safe managed-task updates and compaction removals back into webviews; extension deactivation shuts the scheduler/bridge down before OpenCode.

## Integration
- **Upstream runtime**: OpenCode CLI/server plus Cursor SDK for `cursor-acp` auth/status and managed child execution.
- **Downstream UI**: `packages/vscode/webview` bundle + shared `@openchamber/ui` contracts.
- **Host APIs**: VS Code commands, workspace filesystem, webview messaging, editor context.
