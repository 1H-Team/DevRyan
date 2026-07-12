# packages/ui/src/sync/

## Responsibility
Implements client-side sync primitives for session/event reconciliation and cache updates.

## Design
Event-reducer style updates with normalized entities and optimistic-safe merge utilities.
Draft persistence helpers (`session-draft-storage.ts`) own localStorage keys and migration for new-chat draft state.
Automatic title ownership is provider-specific and exclusive: the server-side standard title runtime owns accepted non-Cursor prompts, the separate server-side Cursor runtime owns Cursor ACP titles, and explicit custom draft titles remain authoritative. The sync layer never persists prompt-derived automatic titles and consumes authoritative `session.updated` events instead.
Plan proposal idle settlement is isolated in `plan-idle-settlement.ts` so completed plan cards can clear stale optimistic busy status without changing generic assistant activity rules.
Synthetic session-status compatibility events are normalized in `event-pipeline.ts` before routing/coalescing, terminal assistant status settlement stays provider-neutral and trailing-turn scoped in `event-reducer.ts`, and active-session stale recovery stays scoped to the viewed session in `sync-context.tsx`.
Stop-during-retry handling is isolated in `abort-retry-guard.ts`: manual aborts register a time-bounded per-session guard that suppresses stale `retry` statuses (OpenCode ignores abort during retry backoff) and re-issues bounded aborts when the loop's next attempt fires; new local sends and authoritative idle clear it.
Transient provider stream recovery is executed through `transient-retry.ts`, which reuses authoritative sync snapshots and the existing per-session send pipeline for both automatic and manual retries.
Directory lifecycle ownership is centralized in `child-store.ts`; `directory-disposal.ts` provides cold-path routing/timer cleanup and restart-safe provider teardown. `sync-context.tsx` fans that boundary out to prefetch, pending-delta, session-child, materializer, action/ref, reconnect, toast, and event-pipeline resources, while generation/store-identity guards prevent late async completions from repopulating an evicted directory.

## Flow
SSE/polling events enter reducers, then produce store patches consumed by chat/session UI.

## Integration
Bridges lib/opencode streams with Zustand stores and session/chat components.
