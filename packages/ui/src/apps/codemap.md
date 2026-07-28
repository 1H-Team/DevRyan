# packages/ui/src/apps/

## Responsibility
Hosts app-shell entry compositions for different runtime surfaces.

## Design
Thin composition roots that wire providers, routes, top-level views, and gated runtime effects such as queued sends, transient stream recovery, and the single quota-refresh lifecycle owner. The VS Code composition keeps normal chat synchronous while resolving the Agent Manager view through the shared recovery-aware lazy registry only for `agentManager` panels.
The Electron Mini Chat composition supplies the same `AgentHandoffGuardProvider`
as the main chat before rendering shared composer/model controls.

## Flow
Runtime selects an app entry, mounts providers, then renders feature components.

## Integration
Integrates contexts, stores, styles, and major view modules.
