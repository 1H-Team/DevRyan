# packages/vscode/webview/api/

## Responsibility
Defines the webview-side API bridge used by VS Code UI code to call extension-host capabilities.

## Design
Thin transport wrappers around message passing: typed request/response helpers and feature-level API modules that hide `postMessage` protocol details from UI components.

`orchestration.ts` is the API-shaped adapter for managed task snapshot, status, cancellation, and result acknowledgement. It validates JSON/body size locally and preserves extension-host HTTP status semantics.

## Flow
1. Webview component invokes an API helper from this folder.
2. Helper sends a structured message to extension host.
3. Extension responds; helper resolves data/errors back to the caller.

## Integration
- Called by: `packages/vscode/webview/*` UI/state modules.
- Talks to: `packages/vscode/src/extension.ts` command/message handlers.
- Mirrors shared contracts with web/desktop where possible for cross-runtime parity.
