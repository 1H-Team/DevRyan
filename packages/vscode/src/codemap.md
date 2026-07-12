# packages/vscode/src/

## Responsibility
VS Code extension-host implementation: activation lifecycle, command surface, webview providers, OpenCode process management, and bridge runtime handlers.

## Design
- `extension.ts` is the orchestrator entrypoint.
- Provider classes (`ChatViewProvider`, `SessionEditorPanelProvider`, `AgentManagerPanelProvider`) encapsulate webview setup and host↔webview synchronization.
- `bridge.ts` is a dispatcher that routes message types to focused runtime modules (`bridge-fs-runtime`, `bridge-git-runtime`, `bridge-system-runtime`, etc.).
- `opencode.ts` provides a manager object with explicit connection status and restart/start/stop APIs.
- `opencodeConfig.ts` owns VS Code-side config entity reads/writes, OpenCode Slim config/agent override parity, Slim-installed global agent prompt composition, and managed agent runtime overlays so saved user-side agent model defaults, plugin filtering, and blocked ambient MCP tombstones apply to the local OpenCode process.
- `bridge-system-runtime.ts` owns VS Code Cursor SDK auth/status/configure bridge behavior via `@openchamber/cursor-sdk-runtime`; Cursor usage quota remains in `quotaProviders.ts`.
- `managedOrchestrationRuntime.ts` composes the VS Code-owned scheduler and scoped RPC contract.
- `managedOrchestrationPersistence.ts` owns the private atomic extension-storage ledger and corrupt-ledger quarantine.
- `managedOrchestrationHost.ts` owns the bearer-authenticated IPv4 loopback bridge used only by managed OpenCode plugins.
- `managedOpenCodeExecutor.ts` owns canonical normal-provider and Cursor child-session execution.
- `bridge-orchestration-runtime.ts` adapts scoped webview requests without exposing private task inputs or bridge credentials.

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
