# packages/ui/src/stores/

## Responsibility
Zustand store layer for persisted and session-local client state: UI preferences, config/providers/agents, directory/worktree context, queueing, git metadata, skills/MCP/projects configuration, and supporting store utilities.

## Design
- **Store-per-domain**: each feature has a focused store (`useUIStore`, `useConfigStore`, `useGitStore`, `useSkillsStore`, etc.) to limit cross-feature coupling.
- **Middleware stack**: many stores use `persist` + `devtools`; persistence uses `getSafeStorage()` for environment-safe access.
- **Utility-first reducers**: `utils/*` centralizes reusable transforms/projectors (stream debug, message/context utilities, permission helpers).
- **Inter-store orchestration**: stores often call other stores via `.getState()` in actions to avoid broad subscriptions.
- **Quota refresh coordination**: `quota-refresh-coordinator.ts` owns the single 30-minute baseline timer and serialized refresh lifecycle; `useQuotaStore.ts` owns configured-provider discovery, per-provider request deduplication, and last-valid-data retention.
- **Managed orchestration projection**: `useManagedOrchestrationStore.ts` owns non-persisted, low-frequency safe task/result projections keyed by task and root session. It reconciles snapshots with sequenced events, deduplicates actions, and preserves terminal results and visible failures until authoritative acknowledgement.
- **Provider recovery projection**: `useProviderRecoveryStore.ts` owns non-persisted, per-session manual model recovery state without placing provider errors in hot session stores.

## Flow
1. Components/hooks subscribe via narrow selectors.
2. User actions invoke store actions; actions may call backend helpers in `lib/*`.
3. Persisted stores serialize selected state slices to storage/settings.
4. Sync system and feature hooks consume store state for rendering and command execution.
5. The app-level quota owner starts/stops the quota coordinator; rendering surfaces request manual refreshes without creating timers.
6. The app-level managed-orchestration owner loads/reloads snapshots, while the sync pipeline routes safe managed events directly into the dedicated store before directory reduction.

## Integration
- Works alongside `src/sync/*`: sync owns high-frequency live message/session data; the managed-task store owns only bounded low-frequency scheduler projections and never child output streams.
- Consumed throughout `components/*` and `hooks/*`.
- Depends on `lib/*` for transport and persistence side effects (e.g., config reload, desktop settings writes, git/project operations).
