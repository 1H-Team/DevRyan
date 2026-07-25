# packages/ui/src/hooks/

## Responsibility
Reusable React hooks for UI behavior orchestration: keyboard shortcuts, session lifecycle status, routing sync, TTS/voice, runtime capability detection, and interaction ergonomics (swipe, long-press, debounced values).

## Design
- **Behavior hooks, not data stores**: hooks compose existing store/sync selectors and runtime APIs; they avoid owning canonical state.
- **Runtime-aware wrappers**: several hooks gate behavior for desktop/web/vscode differences (menu actions, filesystem access, PWA, voice availability).
- **Stability and hot-path safety**: hooks tend to memoize callbacks/selectors and use refs to avoid frequent effect resubscription.
- **Manual provider recovery**: `useProviderErrorRecovery.ts` converts terminal transient/model errors into explicit recovery records; transient stream retry loops are aborted after a bounded attempt count and converted into the same explicit recovery card, but recovery never resends automatically.
- **Queued reconnect recovery**: `useQueuedMessageAutoSend.ts` dispatches only from authoritative idle/first-seen or disconnected-to-connected edges. A failed flush restored during connection loss gets one retry opportunity after reconnect, while steady connected renders cannot create a retry loop.
- **Context usage stability**: `useSelectedModelContextCapacity.ts` subscribes to leaf model-selection fields and resolves next-send capacity, while `useStableSessionContextUsage.ts` retains completed usage only for the same directory/session key and clears cross-session bleed synchronously.
- **Cold-project status**: `useAssistantStatus.ts` preserves specific reasoning/tool/composing labels, but replaces a generic working phrase with `preparing project` while the active session directory matches the app-owned runtime warmup leaf.
- **Stable routed sessions**: `useRouter.ts` resolves session directories dynamically from live hints and global snapshots, retains cold deep-link parameters until metadata loads, and reconciles without binding an unknown session to the ambient directory.

## Flow
1. Components call hooks with local props/context.
2. Hooks subscribe to narrow slices of `stores`/`sync` and/or browser/runtime events.
3. Hooks expose derived flags, actions, and event handlers for component rendering and side effects.
4. Cleanup unbinds listeners/timers to keep long-running sessions stable.

## Integration
- Consumed broadly by `components/*` and `App.tsx`.
- Depends on `lib/*` helpers (`router`, `desktop`, `tts`, `i18n`, etc.) and multiple Zustand/sync stores.
- Acts as the main adaptation layer between UI components and host/runtime environment APIs.
