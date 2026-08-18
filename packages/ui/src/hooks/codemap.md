# packages/ui/src/hooks/

## Responsibility
Reusable React hooks for UI behavior orchestration: keyboard shortcuts, session lifecycle status, routing sync, TTS/voice, runtime capability detection, and interaction ergonomics (swipe, long-press, debounced values).

## Design
- **Behavior hooks, not data stores**: hooks compose existing store/sync selectors and runtime APIs; they avoid owning canonical state.
- **Runtime-aware wrappers**: several hooks gate behavior for desktop/web/vscode differences (menu actions, filesystem access, PWA, voice availability).
- **Stability and hot-path safety**: hooks tend to memoize callbacks/selectors and use refs to avoid frequent effect resubscription.
- **Manual provider recovery**: `useProviderErrorRecovery.ts` waits for the authoritative busy/retry-to-idle failure edge, then converts classified request/header/stream-idle/connection or model errors into explicit recovery records only when queued and blocking work are absent. On reconnect, an authoritative first-seen idle session with a trailing incomplete root response receives the same explicit recovery surface instead of being treated as live; idle sessions whose history hydrates later are evaluated when their message-list reference arrives. The subscription excludes part-delta updates. Retry loops are aborted after a bounded attempt count and converted into the same card, but recovery remains manual and single-flight; a newer authoritative user turn supersedes any older card.
- **Queued reconnect recovery**: `useQueuedMessageAutoSend.ts` dispatches only from authoritative idle/first-seen or disconnected-to-connected edges. A failed flush restored during connection loss gets one retry opportunity after reconnect, while steady connected renders cannot create a retry loop.
- **Context usage stability**: `useStableSessionContextUsage.ts` retains completed provider measurements only for the same directory/session key and clears cross-session bleed synchronously. Capacity is resolved by the shared context projection from the measured assistant message, never from mutable next-send model selection.
- **Cold-project status**: `useAssistantStatus.ts` preserves specific reasoning/tool/composing labels, but replaces a generic working phrase with `preparing project` while the active session directory matches the app-owned runtime warmup leaf.
- **Stable routed sessions**: `useRouter.ts` resolves session directories dynamically from live hints and global snapshots, retains cold deep-link parameters until metadata loads, and reconciles without binding an unknown session to the ambient directory.
- **Blocking activity priority**: `useSessionActivity.ts` subscribes to narrow per-session permission and question leaves; either pending blocker projects the session as idle so answer/permission controls take priority over stop-state UI.

## Flow
1. Components call hooks with local props/context.
2. Hooks subscribe to narrow slices of `stores`/`sync` and/or browser/runtime events.
3. Hooks expose derived flags, actions, and event handlers for component rendering and side effects.
4. Cleanup unbinds listeners/timers to keep long-running sessions stable.

## Integration
- Consumed broadly by `components/*` and `App.tsx`.
- Depends on `lib/*` helpers (`router`, `desktop`, `tts`, `i18n`, etc.) and multiple Zustand/sync stores.
- Acts as the main adaptation layer between UI components and host/runtime environment APIs.
