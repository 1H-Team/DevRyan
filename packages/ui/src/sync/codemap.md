# packages/ui/src/sync/

## Responsibility
Implements client-side sync primitives for session/event reconciliation and cache updates.

## Design
Event-reducer style updates with normalized entities and optimistic-safe merge utilities.
Draft persistence helpers (`session-draft-storage.ts`) own localStorage keys and migration for new-chat draft state.
Cursor ACP title persistence is server-owned for intercepted SDK prompts; the sync layer consumes authoritative `session.updated` events and does not write prompt-derived fallback titles.
Plan proposal idle settlement is isolated in `plan-idle-settlement.ts` so completed plan cards can clear stale optimistic busy status without changing generic assistant activity rules.
Synthetic session-status compatibility events are normalized in `event-pipeline.ts` before routing/coalescing, terminal assistant status settlement stays provider-neutral and trailing-turn scoped in `event-reducer.ts`, and active-session stale recovery stays scoped to the viewed session in `sync-context.tsx`.
Stop-during-retry handling is isolated in `abort-retry-guard.ts`: manual aborts register a time-bounded per-session guard that suppresses stale `retry` statuses (OpenCode ignores abort during retry backoff) and re-issues bounded aborts when the loop's next attempt fires; new local sends and authoritative idle clear it.
Transient provider stream recovery is executed through `transient-retry.ts`, which reuses authoritative sync snapshots and the existing per-session send pipeline for both automatic and manual retries.

## Flow
SSE/polling events enter reducers, then produce store patches consumed by chat/session UI.

## Integration
Bridges lib/opencode streams with Zustand stores and session/chat components.
