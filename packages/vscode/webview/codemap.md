# packages/vscode/webview/

## Responsibility
Browser-side bootstrap for the VS Code-hosted DevRyan UI. It initializes runtime APIs backed by the extension bridge, manages startup/loading UX, and adapts VS Code theme/connection state into the shared React app.

## Design
- **Adapter pattern**: `main.tsx` builds VS Code-specific runtime APIs and assigns them to `window.__OPENCHAMBER_RUNTIME_APIS__` consumed by shared UI.
- **Bridge client modules** (`api/*`): narrow wrappers for git/files/settings/notifications/permissions/editor/proxy calls to extension host.
- **Bootstrap resilience**: connection status state machine + overlay logic tolerates delayed API readiness and partial fetch failures.
- **Theme translation**: VS Code palette is converted into shared theme token shape before app mount.
- **SSE tunneling**: stream start/stop requests go through extension messaging rather than direct unrestricted sockets.
- **Managed-orchestration adapter**: `api/orchestration.ts` maps the shared HTTP-shaped snapshot/status/cancel/acknowledge/handoff surface to the extension host, preserves authoritative status codes, and enforces the UI body limit.

## Flow
1. `main.tsx` reads injected globals from `webviewHtml.ts` (workspace, status, panel type, platform).
2. Webview initializes bridge-backed runtime API surface and connection state.
3. Shared UI mounts and uses runtime APIs; outbound API intents become bridge messages.
4. Incoming messages (`connectionStatus`, commands, stream events, safe managed-task projections/removals) update globals and dispatch window events; `managedOrchestrationWindowEvents.ts` owns the narrow event-type allowlist.
5. Loading overlay hides only after UI mount + connection/critical bootstrap conditions.

## Integration
- **Depends on**: VS Code webview messaging + extension bridge protocol.
- **Consumed by**: extension host webview providers (`ChatViewProvider`, panel providers).
- **Shares contracts with**: `@openchamber/ui` runtime API interfaces and theme adapter types.
- **Security boundary**: privileged filesystem/system access stays in extension host; webview remains capability-thin.
