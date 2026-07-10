# packages/ui/src/hooks/

## Responsibility
Reusable React hooks for UI behavior orchestration: keyboard shortcuts, session lifecycle status, routing sync, TTS/voice, runtime capability detection, and interaction ergonomics (swipe, long-press, debounced values).

## Design
- **Behavior hooks, not data stores**: hooks compose existing store/sync selectors and runtime APIs; they avoid owning canonical state.
- **Runtime-aware wrappers**: several hooks gate behavior for desktop/web/vscode differences (menu actions, filesystem access, PWA, voice availability).
- **Stability and hot-path safety**: hooks tend to memoize callbacks/selectors and use refs to avoid frequent effect resubscription.
- **Transient stream recovery**: `useTransientErrorAutoRetry.ts` reacts only to observed live busy/retry-to-idle transitions and delegates one-shot eligibility to a pure decision helper.

## Flow
1. Components call hooks with local props/context.
2. Hooks subscribe to narrow slices of `stores`/`sync` and/or browser/runtime events.
3. Hooks expose derived flags, actions, and event handlers for component rendering and side effects.
4. Cleanup unbinds listeners/timers to keep long-running sessions stable.

## Integration
- Consumed broadly by `components/*` and `App.tsx`.
- Depends on `lib/*` helpers (`router`, `desktop`, `tts`, `i18n`, etc.) and multiple Zustand/sync stores.
- Acts as the main adaptation layer between UI components and host/runtime environment APIs.
