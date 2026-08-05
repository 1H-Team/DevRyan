# packages/ui/src/apps/

## Responsibility
Hosts app-shell entry compositions for different runtime surfaces.

## Design
Thin composition roots that wire providers, routes, top-level views, and gated runtime effects such as queued sends, transient stream recovery, and the single quota-refresh lifecycle owner. The main local Electron composition also owns exact agent-browser window claims: it reacts only to session-list membership and low-frequency managed-task changes, deduplicates known `(directory, rootSessionId)` pairs, and refreshes them on focus. The VS Code composition keeps normal chat synchronous while resolving the Agent Manager view through the shared recovery-aware lazy registry only for `agentManager` panels.
The Electron Mini Chat composition supplies the same `AgentHandoffGuardProvider`
as the main chat before rendering shared composer/model controls.
`renderBrowserPopoutApp.tsx` is the small provider root for `/browser.html`; it renders the unchanged Electron surface toolbar or the standalone-web Browser shell selected by capability. Web pop-outs receive only a random surface id in their URL and restore versioned history/diagnostics state through a same-origin channel.

## Flow
Runtime selects an app entry, mounts providers, then renders feature components.

## Integration
Integrates contexts, stores, styles, and major view modules.
