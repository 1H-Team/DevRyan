# packages/ui/src/stores/

## Responsibility
Zustand store layer for persisted and session-local client state: UI preferences, config/providers/agents, directory/worktree context, queueing, git metadata, skills/MCP/projects configuration, and supporting store utilities.

## Design
- **Store-per-domain**: each feature has a focused store (`useUIStore`, `useConfigStore`, `useGitStore`, `useSkillsStore`, etc.) to limit cross-feature coupling.
- **Managed project projection**: `useProjectsStore.ts` treats the accepted managed principal's assignment list as authoritative immediately at principal acceptance and again during settings hydration. It groups assigned branches by project, replaces stale host-path projects with public `/projects/*` entries, and selects the default assignment before app effects mount. Git-integrate temp directories (`devryan-integrate-*`) are ignored by `addProject` and stripped during settings sanitization so leftover conflict worktrees cannot reappear in the admin sidebar.
- **Managed account defaults**: `useConfigStore.ts` keeps sparse per-agent
  model/thinking overrides account-global, reports personal override keys from
  settings hydration, and persists/resets them only through explicit Sessions
  settings actions. `lib/agentDefaultResolution.ts` is shared with send
  resolution; composer and directory selection stores never write account
  defaults.
- **Cold-runtime status leaf**: `useAgentRuntimeWarmupStore.ts` carries only the currently warming directory so generic assistant busy rows can show honest project-preparation status without subscribing app chrome to live session collections.
- **Middleware stack**: many stores use `persist` + `devtools`; persistence uses `getSafeStorage()` for environment-safe access.
- **Utility-first reducers**: `utils/*` centralizes reusable transforms/projectors (stream debug, message/context utilities, permission helpers).
- **Queue claim ownership**: `messageQueueStore.ts` supports whole-session FIFO claims and exact-row claims. Exact-row rollback restores the original row object and queue position so manual send failures preserve captured config and dispatch identity without reordering unrelated chips. Authoritative permanent deletion clears only the deleted session's persisted queue; archive preserves it.
- **Context lifecycle**: `contextStore.ts` owns seven persisted session-keyed maps for model/agent choices, current agent, versioned message-fallback context usage, and edit modes. `useProviderContextUsageStore.ts` is the narrow, capped, non-persisted source for low-frequency Meridian snapshots and compaction revisions. Authoritative permanent deletion clears both paths for the exact session, preserves the `__global__` edit-mode fallback, and cancels owned deferred usage work so microtasks or token polls cannot recreate deleted state.
- **Permission mirror lifecycle**: `permissionStore.ts` persists explicit per-session auto-accept overrides and serializes host mirror requests by session. Authoritative permanent deletion removes only the exact override and queues `enabled: false` after older same-session requests, while archive preserves policy.
- **Authoritative context projection**: `utils/contextUsageUtils.ts` selects the newest token-bearing assistant message, prefers its explicit provider total (otherwise sums uncached input, cache read/create, output, and reasoning once), and resolves capacity from that same message's provider/model/variant through `modelContextCapacity.ts`. Missing provenance or catalog limits preserve the measured total while leaving capacity, percentage, and Free Space unavailable. Subagent aggregation repeats the same projection per child, preserves the descendant tree (`parentSessionId`/`depth`), and emits `hasData: false` rows for unloaded children; no tokenizer or source-category estimate is stored.
- **Inter-store orchestration**: stores often call other stores via `.getState()` in actions to avoid broad subscriptions.
- **Quota refresh coordination**: `quota-refresh-coordinator.ts` owns the single 30-minute baseline timer and serialized refresh lifecycle; `useQuotaStore.ts` owns configured-provider discovery, per-provider request deduplication, and last-valid-data retention.
- **Configuration apply projection**: `useConfigApplyStore.ts` validates revisioned host envelopes, merges mutation responses, owns apply/external-acknowledgement requests, and refreshes only catalogs covered by successfully applied scopes.
- **Managed orchestration projection**: `useManagedOrchestrationStore.ts` owns non-persisted, low-frequency safe task/result projections keyed by task and root session. It reconciles snapshots with sequenced events, deduplicates actions, preserves terminal results and visible failures until authoritative acknowledgement, and exposes narrow root-barrier, exact task, and exact dispatch-call task-ID leaves for managed waiting plus one-shot settled-turn reconciliation.
- **Agent-browser lease projection**: `useBrowserAgentStore.ts` accepts only revisioned, allowlisted lease snapshots on a local Electron origin. It stores no capability URLs or tokens, preserves unchanged lease/root-index references, exposes narrow per-lease and per-root selectors plus the currently observed lease, and derives deduplicated exact window-claim pairs from known session lineage plus active managed tasks. `useUIStore.ts` owns non-persisted directory-scoped lease presentation tabs and active lease identity for the dedicated Browser panel, prunes them when leases disappear or session roots change, and never persists them. Shared cycle-guarded session lineage in `lib/sessionLineage.ts` root-scopes both parent and child sessions consistently.
- **Browser panel + surface projection**: `useUIStore.ts` persists only low-frequency Browser panel open/expanded/width state and keeps its expanded state mutually exclusive with `ContextPanel`. `useBrowserSurfaceStore.ts` is the narrow, non-persisted placement/navigation/favicon projection for token-free Electron surface snapshots. It maps manual tab IDs to surface IDs so popped manual tabs bypass the ordinary sleep timer without adding live browser state to the broad UI store.
- **Manual Browser workspace**: `useManualBrowserTabsStore.ts` persists directory-scoped manual page order, active identity, safe current URLs, Electron-published page titles (with host fallback), optional allowlisted favicons, viewport mode, and an opaque workspace ID. It clears a retained favicon when navigation changes host. It remains separate from `useUIStore` panel/lease state; live history, diagnostics, proxy grants, and native surfaces remain runtime-only.
- **Provider recovery projection**: `useProviderRecoveryStore.ts` owns non-persisted, per-session manual model recovery state without placing provider errors in hot session stores.
- **Provider stall projection**: `useProviderStallStore.ts` owns the low-frequency actionable identity for a confirmed empty pending tool-input stall; semantic activity and lifecycle cleanup clear it without adding timestamps to hot session stores.
- **Long-running tool projection**: `useLongRunningToolStore.ts` owns exact active `ctx_execute`/MCP-alias/`bash`/`shell` identity, first-observed/last-activity timestamps, five-minute confirmation, one-shot diagnostic attribution, and Stop action state. It stays outside hot session stores, resets confirmation on progress, excludes managed child dispatch, and never treats legitimate tool execution as a provider failure or retry candidate.
- **Global session lifecycle projection**: `useGlobalSessionsStore.ts` merges complete global listings
  with low-frequency cross-directory session lifecycle events and protects remote creates, updates,
  archive moves, and deletes from stale HTTP snapshots via a bounded, request-revisioned non-Zustand
  overlay that also lets later authoritative listings prune orphaned events.
- **Session plan-file pointer**: `useSessionPlanFileStore.ts` owns the narrow non-persisted `saving | saved | error` record for the latest plan revision in each session plus the atomic one-time auto-reveal claim for that revision. Permanent session deletion clears the pointer/claim but intentionally leaves the Markdown artifact intact; archive preserves both.
- **Session-change attribution**: `useSessionChangeAttributionStore.ts` owns a non-persisted, low-frequency projection keyed by directory and session. Reconciliation preserves the map reference on no-op updates, while permanent session deletion and directory disposal clear only their exact ownership.

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
