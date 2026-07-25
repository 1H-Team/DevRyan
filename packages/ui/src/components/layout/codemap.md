# packages/ui/src/components/layout/

## Responsibility
Application shell/layout components (panes, headers, split views, containers).

## Design
Structural components define composition boundaries between navigation, chat, and side panels. `MainLayout`, `RightSidebarTabs`, `ContextPanel`, and `VSCodeLayout` consume heavyweight views through `components/views/lazyViews.tsx`; they must not statically import those implementations. `ContextPanel` treats an open plan as session-family-bound presentation: it stays visible while navigating between the owning parent session and its descendants, then collapses synchronously for drafts, unrelated sessions, or unresolved lineage so a directory-shared plan tab cannot leak stale content across chats.

## Flow
App entry mounts layout; feature regions receive data via context/hooks.

## Integration
Integrated with views, sidebar/session/chat components, and global providers.
