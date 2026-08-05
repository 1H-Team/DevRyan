# packages/ui/src/components/layout/

## Responsibility
Application shell/layout components (panes, headers, split views, containers).

## Design
Structural components define composition boundaries between navigation, chat, and side panels. `MainLayout`, `RightSidebarTabs`, `ContextPanel`, and `VSCodeLayout` consume heavyweight views through `components/views/lazyViews.tsx`; they must not statically import those implementations. `ContextPanel` treats an open plan as session-family-bound presentation: it stays visible while navigating between the owning parent session and its descendants, then collapses synchronously for drafts, unrelated sessions, or unresolved lineage so a directory-shared plan tab cannot leak stale content across chats.
`MainLayout` threads a browser-action portal from `DesktopEdgeChrome` into `Header`/`ProjectActionsButton`; the globe is directory-gated, not project-gated. Local Electron and every standalone web origin (local, managed, or tunneled) open a real manual Browser tab even when no project record resolves. Project-action URLs use that Browser surface where supported. Local Electron also shows the root-session-scoped agent-lease menu. VS Code and legacy Tauri retain the Preview fallback.

`ContextPanel` projects Electron surfaces into validated renderer placeholder bounds; it never creates a `<webview>`. The invariant lease fleet remains driven by authoritative lease snapshots, while main owns the paintable parked views and CDP binding. Manual surfaces keep the 60-second inactive retention policy, except popped surfaces remain retained; closing a manual tab releases its surface, while closing a lease presentation tab does not release the lease. `DesktopBrowserPane` supplies the shared address/navigation/loading/pop-out/dock/external shell. Standalone web uses a sandboxed iframe: approved loopback project apps route through the host preview proxy, while public URLs load directly from the viewer. `previewDiagnostics.tsx` is shared with Preview for the bounded console and screenshot-backed element picker; its serializable pure contract lives in `previewDiagnosticsState.ts`, and `PreviewConsolePanel.tsx` owns the shared presentation.

The active standalone Browser registers current-directory terminal-discovered loopback URLs as short-lived project grants and lists live project-shared endpoints without exposing terminal IDs or host paths. It never starts commands or scans ports. Its serializable state retains display URL, history/index, console buffer, and inspection state. `/browser.html` receives that state over a versioned random-surface `BroadcastChannel`, with strict same-origin `postMessage` fallback; URLs and directories never enter the popup URL. Popup console/annotation attachments are forwarded to the authenticated opener so they target the correct chat. Electron inspection, capture, and resizable native DevTools remain unchanged.

## Flow
App entry mounts layout; feature regions receive data via context/hooks.

## Integration
Integrated with views, sidebar/session/chat components, and global providers.
