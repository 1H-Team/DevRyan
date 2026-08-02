# packages/ui/src/components/layout/

## Responsibility
Application shell/layout components (panes, headers, split views, containers).

## Design
Structural components define composition boundaries between navigation, chat, and side panels. `MainLayout`, `RightSidebarTabs`, `ContextPanel`, and `VSCodeLayout` consume heavyweight views through `components/views/lazyViews.tsx`; they must not statically import those implementations. `ContextPanel` treats an open plan as session-family-bound presentation: it stays visible while navigating between the owning parent session and its descendants, then collapses synchronously for drafts, unrelated sessions, or unresolved lineage so a directory-shared plan tab cannot leak stale content across chats.
`MainLayout` threads a browser-action portal from `DesktopEdgeChrome` into `Header`/`ProjectActionsButton`; the right chrome is shared by desktop-width web and Electron, while native left chrome remains Electron-only. On a local Electron origin the globe uses a small count-free blue activity dot and opens a root-session-scoped list of active agent-browser leases, with the manual browser kept as a separate secondary action. Choosing a lease creates an ephemeral browser tab owned by that root and marks only that lease observed; switching roots closes every lease presentation tab owned by another root without stopping or remounting any lease guest. Manual browser and file tabs remain intact. Outside local Electron the globe retains the reusable `about:blank` preview fallback.

`ContextPanel` owns an invariant lease fleet derived directly from authoritative lease snapshots: one `DesktopBrowserPane`/Electron `<webview>` per active lease mounts immediately, binds its `webContentsId` to that lease through IPC, and remains mounted and paintable but visually transparent across panel close, tab changes, and session or directory switches. Paintability is required for background CDP screenshots; `visibility:hidden` stalls Chromium capture until observation. Lease removal unmounts the guest and prunes its ephemeral tabs. Unobserved guests receive no input-event presentation; only the visible observed lease renders `BrowserAgentCursor`, and `browser-agent-input` is rejected unless its `leaseId` matches. The reducer coalesces only pointer moves, never presses, releases, keys, text, or touches. Manual browser guests are outside the lease fleet and keep the short `useGuestRetention` sleep policy; the old global wake/`agentDriving` pin is not used. All browser guests deliberately share `persist:openchamber-browser`; guest hardening and lease ownership enforcement live in Electron main.

The active blank manual browser projects current-directory running terminal tabs with detected loopback preview URLs through `localPreviewInstances.ts`, confirms only those candidates through the bounded preview liveness route, and never starts commands, scans ports, or mixes other project directories. The browser toolbar's Inspect Element control reserves a resizable bottom dock, synchronizes bounds through validated Electron IPC, and tracks the native DevTools lifecycle; opening DevTools disconnects only that lease's debugger client. The neighboring cursor control remains the separate select-for-chat annotation flow. Chat-tab iframes use their own long retention grace.

## Flow
App entry mounts layout; feature regions receive data via context/hooks.

## Integration
Integrated with views, sidebar/session/chat components, and global providers.
