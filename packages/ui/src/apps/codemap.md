# packages/ui/src/apps/

## Responsibility
Hosts app-shell entry compositions for different runtime surfaces.

## Design
Thin composition roots that wire providers, routes, top-level views, and gated runtime effects such as queued sends, transient stream recovery, and the single quota-refresh lifecycle owner. The main local Electron composition also owns exact agent-browser window claims: it reacts only to session-list membership and low-frequency managed-task changes, deduplicates known `(directory, rootSessionId)` pairs, and refreshes them on focus. The VS Code composition keeps normal chat synchronous while resolving the Agent Manager view through the shared recovery-aware lazy registry only for `agentManager` panels.
`BotsEventOwner.tsx` owns the separate principal-filtered Production Bot SSE connection. It reconciles snapshot epochs and monotonic sequences into the isolated canonical stores, routes requester-only `message.streaming` revisions into `useBotLiveMessageStore`, dispatches `memory.changed` as a narrow settings refresh signal, clears transient text on authoritative lifecycle boundaries, resets principal-scoped data on account changes, and deliberately avoids ordinary OpenCode sync stores. VS Code is gated before either HTTP streaming or local runtime-management access.
`AppEffects.tsx` also mounts the runtime-gated project-preview grant owner. It subscribes imperatively to terminal-store changes, registers discovered loopback project apps without rendering from the terminal collection, and remains inactive in VS Code and runtimes without the Browser surface.
The main web/Electron and VS Code compositions mount
`AgentHandoffGuardProvider` outside their audience-switched layouts. Queued
Builder authorization and handoff reconciliation therefore remain live while
the Bots presentation replaces `ChatView`. Electron Mini Chat supplies the same
provider before rendering shared composer/model controls.
`renderBrowserPopoutApp.tsx` is the small provider root for `/browser.html`; it renders the Electron or standalone-web Browser shell selected by capability. Manual Browser pop-outs receive only a random workspace id in their URL and restore the complete ordered page workspace through a versioned same-origin channel; legacy/lease surface pop-outs retain their surface-id contract.

## Flow
Runtime selects an app entry, mounts providers, then renders feature components.

## Integration
Integrates contexts, stores, styles, and major view modules.
