# packages/ui/src/components/layout/

## Responsibility
Application shell/layout components (panes, headers, split views, containers).

## Design
Structural components define composition boundaries between navigation, chat, and side panels. `MainLayout`, `RightSidebarTabs`, `ContextPanel`, and `VSCodeLayout` consume heavyweight views through `components/views/lazyViews.tsx`; they must not statically import those implementations. `ContextPanel` treats an open plan as session-family-bound presentation: it stays visible while navigating between the owning parent session and its descendants, then collapses synchronously for drafts, unrelated sessions, or unresolved lineage so a directory-shared plan tab cannot leak stale content across chats.
`MainLayout` threads a browser-action portal from `DesktopEdgeChrome` into `Header`/`ProjectActionsButton`; the globe is directory-gated, not project-gated. Local Electron and every standalone web origin (local, managed, or tunneled) open a real manual Browser tab even when no project record resolves. Project-action URLs use that Browser surface where supported. Local Electron also shows the root-session-scoped agent-lease menu. VS Code and legacy Tauri retain the Preview fallback.

The effective Browser capability gates the globe, manual/lease tab creation,
Browser-specific server routes, and pop-out session continuity. Revocation
prunes mounted Browser tabs and releases native surfaces; Preview stays
available according to its existing policy. In Electron, role does not select
the transport: every Browser-capable principal uses the native surface and the
main process independently validates the authenticated session. The header
mounts a Browser-only project-actions projection when Terminal is disabled, so
the developer default does not inherit terminal-backed run controls just to
expose the globe.

`ContextPanel` projects Electron surfaces into validated renderer placeholder bounds; it never creates a `<webview>`. The invariant lease fleet remains driven by authoritative lease snapshots, while main owns the paintable parked views and CDP binding. One outer manual Browser workspace entry owns a dedicated inner page-tab strip, so manual browser pages never share identity, ordering, or close behavior with File, Plan, Diff, Preview, Chat, or agent lease tabs. Manual page surfaces keep the 60-second inactive retention policy, except popped workspace surfaces remain retained; closing a manual page releases only its surface, while closing a lease presentation tab does not release the lease. `DesktopBrowserPane` supplies the shared address/navigation/loading/pop-out/dock/external shell, and `ManualBrowserWorkspacePane` owns page switching plus the versioned detached-window exchange. Electron always uses native Chromium for manual HTTP(S) browsing, including managed developer accounts, so destinations resolve over the person's workstation network. Standalone web uses one sandboxed iframe per retained approved loopback project app; every non-loopback HTTP(S) address opens in the viewer's regular browser, with a retryable action when popup blocking intervenes. Proxy ids carry their authoritative origin so a navigation can never transiently combine a new URL with the previous project target. The last rendered frame remains mounted behind an opaque loading surface until the replacement document fires `load`, preventing blank flashes during target registration and navigation. Cross-origin external redirects are handed to the client instead of registering another host proxy target. Page-driven handoffs and stale-target re-registration remain rate-limited, and inspection state is keyed to the mounted iframe. `previewDiagnostics.tsx` is shared with Preview for the bounded console and screenshot-backed element picker; its serializable pure contract lives in `previewDiagnosticsState.ts`, and `PreviewConsolePanel.tsx` owns the shared presentation.

`ProjectPreviewGrantOwner` runs with the main web/Electron app effects and imperatively registers terminal-discovered loopback URLs across live directories without subscribing a shell component to the terminal collection. Registration is independent of Browser visibility; Browser panels only list project-shared endpoints and create session-bound proxy targets. The owner never starts commands or scans ports. Standalone Browser serializable workspace state retains ordered page tabs plus each page's display URL, history/index, console buffer, and inspection state. `/browser.html` receives that state over a versioned random-workspace `BroadcastChannel`, with strict same-origin `postMessage` fallback; URLs and directories never enter the popup URL. Popup console/annotation attachments are forwarded to the authenticated opener so they target the correct chat. Electron inspection, capture, and resizable native DevTools remain unchanged.

## Flow
App entry mounts layout; feature regions receive data via context/hooks.

## Integration
Integrated with views, sidebar/session/chat components, and global providers.
