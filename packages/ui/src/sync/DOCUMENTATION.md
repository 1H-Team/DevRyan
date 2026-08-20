# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session/message/part/permission/question state
   - Backed by SSE / directory-scoped polling
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
     - active sessions indexed by directory

These two scopes are intentionally different, but they are no longer equal peers for live UI truth.

### Why both exist

The directory-scoped sync stores are **not** a complete global view.

- They are created lazily per directory
- They only contain data for directories initialized in the current app session
- They are optimized for live per-directory domain data
- They do not maintain the complete global active+archived session view needed by the sidebar and retention settings

So:

- Use the **directory sync stores** for per-directory live session/message state
- Use the **global sessions store** for cold/global session coverage (especially archived pages and unopened directories)
- Use **aggregated child-store snapshots** for live session/status truth across already initialized directories

Anthropic context measurement is deliberately low frequency. Completed
assistant messages request a normalized provider snapshot when the runtime
offers the optional context API. `session.compacted` synchronously invalidates
the previous provider value and triggers a mapping refresh; no UI fallback may
reuse a token-bearing message before the latest compaction part. Web/Electron
prefer Meridian, while VS Code and external OpenCode settle on the bounded
post-compaction message fallback without failing bootstrap.

The composer subscribes to the selected session's message metadata and only
context-bearing parts (`step-finish`, native compaction, and the legacy exact
`/compact` marker). Streaming text and unrelated part updates preserve the
projection reference and do not repaint composer chrome. Positive message-level
tokens are authoritative; a present but still-zero message token shell falls
back to the latest measured `step-finish` part. A newer zero-token assistant
shell does not erase the preceding completed measurement.

## Directory subscription bootstrap authority

Creating a directory store and bootstrapping its OpenCode runtime are separate
operations. `useDirectoryStore()` and explicit-directory `useSession()` reads
grant bootstrap authority only when the normalized requested directory equals
the current `SyncProvider` directory. Inactive session rows may therefore create
passive stores seeded from persisted cache without issuing directory-scoped API
requests.

The provider's current-directory effect and imperative operations such as
explicit session materialization retain normal bootstrap authority. Provider
configuration selects only the normalized current-directory store. Reconnect,
visibility, server-reconnect, transport-switch, and replay-gap recovery also
revisit already-initialized background stores while they still project a
`busy` or `retry` session. Passive or fully idle background stores remain
untouched, so recovery cannot turn a cached directory into a new OpenCode
runtime context.

Managed draft sends wait for a pending branch worktree to reach a ready state
before creating the OpenCode session. An explicit send may retry one failed
`populate_worktree` operation; if readiness still fails, the draft remains
intact and no empty session is created. Background bootstrap observers never
retry failed operations on their own.

Draft submission ownership is atomic and keyed by the stable draft ID. The
first caller claims one abort controller before validation, worktree waits, or
session creation; another Enter/click handler or remounted composer observing
the same draft is a silent no-op. The owner snapshots the submitted text,
attachments, target, agent, model, variant, and plan mode once, promotes the
same controller from the draft key to the created session, and removes that
exact draft once. Validation, abort, creation, and transport failures release
only the controller they own, so an explicit retry can claim the draft without
allowing an older completion to clear or replace a newer owner.

Fresh-draft send resolution and composer display use the same authoritative
agent-default resolver. Precedence is explicit draft selection, then the
managed account's personal per-agent default, then live host agent
configuration, then the existing availability fallback. `agent-default` draft
provenance records that resolved personal-or-inherited provider/model/thinking
snapshot; it does not mean host-only. Existing-session selection and captured
queue rows remain authoritative and are never rewritten when account or host
defaults change. Provider hydration preserves a captured default until the
catalog can authoritatively invalidate it.

## Snapshot materialization non-regression

`materialization.ts` merges bounded HTTP message snapshots into the existing
directory cache; it does not interpret omitted historical messages as deleted.
The merge preserves live streaming text and enforces monotonic same-ID terminal
state: an incomplete assistant snapshot cannot reopen an already terminal
assistant message, and an in-flight tool snapshot cannot restart an already
finalized tool part. Forward progress from incomplete/in-flight state to a
terminal snapshot remains authoritative.

Linked child-session polling in `ToolPart.tsx` uses this same materializer for
both regular polling and its final settlement fetch. A response captured before
a child terminal event therefore cannot regress the newer SSE state or remove
older cached child activity when the response's fetch limit is smaller than the
loaded history.

## Authoritative session-change attribution

Per-session change badges must not use user-message `summary.diffs`,
session-level additions/deletions, `session.diff`, or patch snapshot parts.
Those records can describe the shared working tree and can include changes made
before or outside the current session.

`sessionChangeAttribution.ts` projects ownership only from completed,
successful, explicit file-tool parts. Paths are normalized relative to the
session directory and outside-repository paths are rejected. Successful shell
tools are represented as `hasUnattributedMutations` because their commands may
change files without providing a trustworthy bounded path set.

`sync-context.tsx` reconciles that projection after relevant live events and
reconnect materialization; `use-sync.ts` does the same after message-page
materialization. The dedicated `useSessionChangeAttributionStore.ts` stays
outside high-frequency session/message state. The active badge intersects its
attributed paths with current rich Git working-tree stats, so committed,
reverted, or otherwise clean files disappear without transferring unrelated
workspace changes into the session.

Permanent session deletion clears the exact attribution entry. Directory
disposal clears the directory's entries. Revert boundaries are respected during
projection, so hidden tool parts cannot retain attribution.

## Message pagination and first-page loading

`message-pagination-store.ts` owns the shared pagination record for each exact
`(directory, session)` pair: initialization, loading, retained limit, cursor,
and completion. The selected chat subscribes only to its exact record, so
metadata repair rerenders a cache-only session without exposing unrelated
session loads to chat chrome.

First-page requests from chat, sidebar prefetch, and model restoration are
coalesced by the same exact key. A caller that arrives during an existing load
awaits that request instead of treating `loading` as successful completion.
The retained request limit never falls below the full message page size, even
when a short initial response contains only one turn. This keeps OpenCode's
oldest-record cursor from being mistaken for proof of older history on a later
refresh. Limits may still grow as additional pages are retained in memory.
Session eviction/deletion and directory disposal remove the matching record and
invalidate its load token; late responses therefore cannot recreate retired
pagination state.

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `message`, `part`, `permission`, `question`, etc. | One directory |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `useManagedOrchestrationStore.ts` | Safe DevRyan-managed task projections and result envelopes | Global, keyed by root session; low frequency |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

`selection-store.ts` retains reversible archive context, but permanent
`session.deleted` events clear every selection keyed by the deleted session:
model, agent, plan mode, per-agent model, and module-local variant choices.
The same store owns a non-persisted Builder handoff-clearance set. A newly
created Builder-first session records clearance before its session selection is
published, and a successful scheduler inspection records clearance before
Builder is committed. This prevents post-promotion hydration from treating a
new session as a restored Orchestrator handoff. Leaving Builder or permanently
deleting the session clears the entry. Builder sends still run the authoritative
scheduler inspection, so clearance never replaces the live safety gate.
Cleanup happens on the authoritative event rather than optimistic delete
initiation, so failed deletes and archived sessions keep their selections.
That same permanent-delete boundary clears the deleted session's persisted
message queue while preserving queues for archived and unrelated sessions.
It clears all seven session-keyed maps in the persisted `contextStore` while
preserving unrelated rows and the global edit-mode fallback. Context usage
microtasks and token-poll timers are canceled before removal so a delayed writer
cannot recreate deleted state; completed work releases its cancellation record.
The exact session's persisted permission auto-accept override is also removed.
Its final `enabled: false` host mirror is serialized after any older
same-session hydration/toggle request, so stale client work cannot recreate
server notification suppression after the host processes deletion.
It also removes the session's persisted composer text and confirmed mentions.
Mounted composers receive that removal synchronously, cancel pending persistence,
and retire the matching target until the target-switch save boundary passes, so
the normal old-target save cannot recreate deleted data. Archive and failed
optimistic deletion do not enter this path. If that authoritative deletion was
initiated by another renderer or runtime, the same boundary synchronously
clears `currentSessionId` only when it still names the deleted session. The
non-throwing optional UI-store ref in `sync-refs.ts` keeps headless sync use
valid and avoids an asynchronous frame where composer/actions target a missing
session. Background-session deletion preserves the current selection, and no
replacement session is guessed.

The same authoritative boundary calls `session-ui-store.ts`
`retireDeletedSession()`. That action cancels exact-session completion timers,
aborts and removes a pending send controller, and retires worktree routing,
creation/abort flags, plan lifecycle, starter context, and pending-changes UI
entries. It also removes the session-owned plan message and delimiter-prefixed
implementation requests from compact persistence, clears a legacy Cursor draft
prewarm record, and removes the exact authoritative worktree attachment.
Unrelated collection references remain stable when their entries do not change.
Archive preserves all of this reversible state.

## Plan proposal persistence

Completed plan proposals are detected from authoritative session/message state
after reduction. The lifecycle marks the proposed indicator immediately, then
uses `lib/plans/sessionPlanPersistence.ts` and the scoped runtime
`SessionPlansAPI` to save the exact detected Markdown
without requiring the chat or `PlanCard` to be mounted. The coordinator
deduplicates same-revision work, protects the latest session pointer from stale
completions, and leaves failures stable until the Plan Card requests an explicit
retry. Web/Electron storage never traverses generic filesystem routes, allowing
managed developers to retain `files: false`.

The compact plan-message state also persists a bounded map of actionable
`proposed` entries keyed by session and source assistant message. Store creation
hydrates that map synchronously, so the sidebar can show Plan Ready before the
session chat mounts. Active-directory bootstrap force-refreshes only those
persisted proposals before revalidating them against authoritative messages;
ordinary idle sessions remain cache-only and inactive directories retain
passive stores. A failed validation preserves the last confirmed proposal,
while implementation, handoff, supersession, and permanent deletion remove or
replace its persisted entry. A valid host `plan-ready` notification likewise
updates lifecycle state before focus and visibility gates suppress native
notification delivery. Persisted-indicator restoration awaits the same plan
save after materializing messages, so a reload also repopulates the in-memory
saved path in the background.

Plan implementation requests use the same authoritative-history rule. The
Plan Card sends a versioned `synthetic: true` action marker containing the
exact source session, assistant message, and plan index. Lifecycle detection
reconciles that marker after live message/part events and after session
materialization, projecting the matching implementation key and implementing
indicator into `session-ui-store.ts`. The local persisted request sets provide
an immediate same-client lock but are not the cross-client source of truth.
Visible and configurable implementation prompt text is never parsed as
lifecycle state, and legacy requests without the marker keep their existing
client-local behavior.

Before reducing an authoritative `session.deleted` event, `sync-context.tsx`
also retires exact `(directory, session)` recovery ownership. It cancels a
queued snapshot retry, invalidates in-flight message, persisted-indicator,
blocking-request, child-session, and prefetch generations, and removes buffered
part deltas owned by the session's indexed messages. Existing materializers
verify their captured map identity or token immediately before committing, so a
response accepted before deletion cannot restore the deleted session, messages,
parts, plan indicators, or retry state afterward. The same boundary clears the
exact abort-retry guard and live-recovery timestamps. Archive does not retire
these owners, so reversible sessions can finish hydration normally.

The delete tombstone is recorded before routing cleanup. Deletion scans every
initialized child store only at this low-frequency lifecycle boundary, removes
the session and its caches from every store that contains it, and then retires
the routing index. This is required because a delete event can omit or report
the wrong directory. The sidebar global/live merge rejects IDs protected by an
active global delete tombstone, so a stale child snapshot cannot append the row
again while authoritative refresh catches up.

Unexpected-abort message reconciliation is owned separately by
`session-actions.ts`. Its exact `(directory, session)` promise identity is
checked after the message response resolves and before snapshot materialization.
Permanent deletion removes only that exact owner, while directory disposal
removes every owner for the directory; late responses therefore cannot restore
deleted messages or write into a disposed store. A reconciliation requested
after deletion is ignored once both the live session and cached message branch
are absent. Archive does not release this reversible recovery work.

## Directory disposal ownership

`ChildStoreManager` is the single release boundary for a directory store. Both
LRU/TTL eviction through `disposeDirectory()` and provider shutdown through
`disposeAll()` snapshot the store, remove it from the registry, run registered
hook-local disposers, and invoke the configured sync ownership callback exactly
once. The currently displayed directory is pinned while mounted, and normal
eviction continues to protect booting, loading, pinned, and blocking-request
stores.

The ownership callback releases all ephemeral directory-scoped resources:

- session prefetch data, in-flight markers, and generation revisions;
- message-loading metadata and optimistic shadow entries owned by `useSync()`;
- pending part deltas, materialization retries, child-session fetches, and
  archived-session offload timers;
- event-pipeline queues and session/message routing-index entries;
- reconnect/activity timestamps, abort guards, toast dedupe keys, and
  imperative SDK/store references on provider shutdown.

Async loaders compare their generation token, promise identity, or child-store
identity before committing. A late request from an evicted directory therefore
cannot write into a replacement store or repopulate a cleared cache. Provider teardown
is deferred by one microtask and generation-checked so React Strict Mode's
development cleanup/restart cycle does not dispose stores still referenced by
mounted hooks; a real unmount still deterministically calls `disposeAll()`.

`directory-disposal.ts` owns the cold-path routing, timer, prefix-clear, and
restart-safe cleanup helpers. These helpers are intentionally used only at
directory lifecycle edges, where bounded scans are acceptable; they are not
part of high-frequency SSE reduction. `event-pipeline.ts` deletes an empty
directory queue after each flush while retaining only a 64-entry LRU of recent
flush timestamps, preserving frame pacing without retaining queue arrays.

## Managed orchestration event routing

`openchamber:managed-task`, `openchamber:managed-task-removed`, and
`openchamber:managed-orchestration-warning` are host-owned synthetic events.
`event-pipeline.ts` normalizes and routes them to
`useManagedOrchestrationStore.ts` before resolving a directory, allocating a
queue, coalescing, or invoking the session reducer. This guarantees that a
managed status transition cannot clone session/message/part collections or be
mistaken for provider-native task activity.

Removal events contain only DevRyan task/root/directory/sequence identity and
mirror a successfully persisted host-ledger compaction. The projection store
requires an exact identity match, releases task/result/action leaves, and marks
the removal against every in-flight snapshot so stale snapshot data cannot
resurrect it.

`AppEffects.tsx` owns the initial host-ledger snapshot and direct VS Code
webview events. `sync-context.tsx` reloads the snapshot after reconnect or a
replay gap. Snapshot requests are scope-deduplicated, so overlapping lifecycle
signals do not create overlapping host work. High-frequency output from the
managed child is still delivered through its canonical OpenCode session and is
not copied into the managed-task event stream.

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

A successful directory `session.list` response is authoritative, including an
empty list. Each request captures the directory's lifecycle revision before
transport. A bounded module-level overlay records later `session.created`,
`session.updated`, and `session.deleted` events; reconciliation applies only
changes newer than the request revision, so a concurrent create/update survives
the snapshot and a concurrent delete wins. Historical cached rows that received
no concurrent lifecycle event are removed instead of being preserved forever.

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Current consumers:

- `useSessionAutoCleanup.ts`

### Live cross-directory session/status view

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

### Mutation responsibility

`useGlobalSessionsStore` combines:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. low-frequency `session.created`, `session.updated`, and `session.deleted` SSE lifecycle events
   from every directory, including directories with no child sync store
3. optimistic mutation from session actions, followed by authoritative reconciliation:
   - create
   - title update
   - share
   - unshare
   - archive
   - delete
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive while preserving server authority.
High-frequency background message, part, status, permission, and question events are not mirrored
into this broad store and do not allocate inactive directory child stores.

Remote lifecycle events use a bounded module-level overlay. Creates and updates remain visible until
complete active+archived global snapshots confirm the same membership and equal-or-newer metadata;
deletes remain tombstoned until both complete lists confirm absence. This prevents a global HTTP
request that began before an SSE event from erasing a remote create/archive or resurrecting a remote
delete. The overlay is deliberately outside Zustand state so lifecycle bookkeeping adds no render
subscription boundary.

Manual archive, delete, and unarchive actions use a module-level membership-mutation shadow in
`useGlobalSessionsStore.ts`. `beginGlobalSessionMembershipMutation()` records a versioned intent
and applies the optimistic list change atomically. `settleGlobalSessionMembershipMutation()` clears
failed intents before their original snapshots are restored, while successful intents remain
protected from stale global snapshots. The shadow is deliberately outside Zustand state so it does
not add a render subscription boundary.

A successful intent is cleared only after complete active and archived listings jointly confirm its
target membership: archived sessions are absent from active and present in archived, deleted sessions
are absent from both, and unarchived sessions are present in active and absent from archived. Partial
or failed listings cannot confirm an intent. Per-session versions ensure an older overlapping action
cannot settle a newer opposite action.

`queueGlobalSessionsRefreshAfterMutation()` waits for any refresh that predated the mutation, then
guarantees a new post-mutation refresh. Concurrent completions are coalesced, with another pass queued
when a later mutation completes during reconciliation. Do not replace this with a direct
`loadSessions()` call, because that may reuse a stale in-flight promise.

Directory-store rollback after optimistic archive/delete removal is additive.
`restoreOptimisticallyRemovedSessions()` restores only failed target sessions that
are still absent from the current store. It must not replace a captured session
array: `session.created` or `session.updated` can add a newer target record or
unrelated sessions while the mutation request is pending. Directory-specific
delete uses the same reconciliation helper as batch archive/delete rollback.

Failed scoped reverts immediately restore the optimistic session marker, message,
and part snapshots, then start a version-owned bounded authoritative message refetch,
including when the session was idle before the
request. A pending revert intentionally suppresses suffix `message.updated`
events, so the pre-request snapshot cannot recover a concurrent turn created by
another client.

While a scoped revert transaction is pending, the shared session mutation guard
rejects sends (including shell, slash-command, and active-subtask routes), undo,
and redo for that session. Confirmed or rolled-back transactions immediately
release the guard; other sessions are unaffected. Send routes recheck this guard
immediately before each transport request, after attachment conversion and
worktree bootstrap, so a revert that begins during asynchronous preflight cannot
be raced by an already-admitted send.

Optimistic message reconciliation uses the echoed client-generated message ID
as its confirmation boundary. Once a REST message page contains that ID, the
fetched message and server-generated part IDs remain authoritative and the
shadow entry is cleared. Client-only part IDs are merged only while the message
itself is absent from the fetched page; requiring server parts to echo those IDs
would reintroduce duplicate optimistic content and retain the shadow forever.

Live activity/status indicators must not depend on this cache. They must derive from aggregated child-store state.

When an authoritative `session.status` event advances a loaded session to
`busy` or `retry`, the sync boundary settles older terminal notification and
completion attention for that session and its loaded descendants. This makes an
in-place root resume equivalent to reopening the root for sidebar read state,
while rejected/stale working events leave the prior error visible. Durable
managed-task failure results remain unchanged; their cards continue to report
the historical attempt accurately.

After both the initial directory status snapshot and session list load successfully,
bootstrap materializes an explicit `idle` status for every listed session absent
from the snapshot. Existing `busy`/`retry` entries are preserved so a newer live
event still wins. This makes an empty authoritative snapshot after an OpenCode
restart settle stale incomplete message history instead of reviving it as live work.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there. Canonical manual archive/delete/unarchive actions must use the versioned membership lifecycle rather than direct list helpers. Unarchive also removes the archived timestamp from matching loaded directory-store records before awaiting transport so the sidebar cannot prefer a stale live record over the optimistic global membership. Failed requests restore only the exact optimistic objects they still own; a newer event or mutation wins by replacing that reference.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Revert/fork input restoration belongs in `session-actions.ts`; for safe scoped revert, queue the clicked prompt/attachments only after the server acknowledges the revert so failed reverts do not leave the input out of sync with visible history. Revert restoration is keyed to the target session and the composer revision captured when the revert began: navigation cannot overwrite another chat, and a user edit made while the request is pending invalidates the stale restoration. After any scoped-revert failure, roll back immediately and launch (without awaiting) a bounded message reconciliation regardless of the pre-request live status because the pending transaction may have suppressed concurrent suffix events. The reconciliation must retain transaction/directory ownership so a late response cannot overwrite a newer revert or a disposed store.
5. Draft sends must resolve and validate provider/model/agent selection before creating the backend session. A missing model should keep the draft intact and avoid creating an empty chat.
6. A foreground send must always target a real session ID. If the UI has no current session and no open draft, `session-ui-store.ts` creates and selects a normal session before optimistic send/routing; never route a prompt with an empty session ID.
7. Backend session creation retries only the explicit pre-creation `503 OpenCode is restarting` response. Managed ownership registration retries happen server-side against one provisional OpenCode session; `503 identity_unavailable` with `retryable: false`, arbitrary 5xx responses, and ambiguous transport failures must preserve the draft without replaying the non-idempotent create request.
8. Automatic session titles have exactly one owner. Standard-provider sessions are created without a title, then the server-side standard title runtime generates and persists the authoritative Zen summary after an accepted proxied prompt; the sync layer consumes the resulting `session.updated` event and must not persist a prompt-derived fallback. Cursor sessions remain owned by the separate server-side Cursor title runtime, and explicit custom draft titles remain authoritative for every provider.
9. `session-actions.ts` resolves the UI store through the registered reference in `sync-refs.ts`; `session-ui-store.ts` registers the completed Zustand store after initialization. Authoritative deletion may use the optional ref read to invalidate an exact selected session synchronously, while headless consumers no-op when no UI store is registered. Tests that need a narrow UI store must register and release that reference instead of replacing the entire `session-ui-store` module, because Bun module mocks are process-wide and can leak into later chat-flow suites.
10. When session creation has an explicit directory, that requested directory is the UI routing authority even if OpenCode returns an equivalent filesystem alias (for example `/tmp/project` as `/private/tmp/project`). Keep the returned value on the session as server metadata, but register/select the explicit path and expose it through the narrow per-session routing hint so every live consumer uses one child store.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `deleteSession()` -> `removeSessions([id])`

Session summary updates are monotonic by finite `time.updated`, falling back to
finite `time.created`. Only strictly older records are rejected; equal or
incomparable timestamps remain eligible. The sync handler performs this gate
before cloning any directory-store branch, the reducer repeats it at its
mutation boundary, and global upserts use the same comparator. Successful
direct title updates are mirrored into the exact loaded directory child store
and the global snapshot, both freshness-aware, so a delayed SSE or REST echo
cannot restore an older title or archive state.

URL routing resolves a session directory dynamically from live routing hints
and then the global active/archived snapshot, including parent lineage for
no-directory children. Cold deep links retain their original
session/tab/settings/diff parameters while metadata is loading and reconcile
once an authoritative directory appears; they never bind an unknown session to
the ambient current directory.

Cursor ACP title repair is a narrow sync-side exception: `sync-context.tsx`
observes live idle/message/session events and calls `session-actions.updateSessionTitle()`
only when a `cursor-acp error:` title or generated `New session - <ISO timestamp>`
title is stale and the live session has completed assistant output or mutation
evidence. Genuine provider failures without completion or mutation evidence keep
their error title.

## The golden rule

When creating a draft in `handleDirectoryEvent`, **only clone the state fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  session: [...current.session],
  message: { ...current.message },
  part: { ...current.part },
  permission: { ...current.permission },
  // ...
}

// RIGHT — only clone what this event type touches
const draft = { ...current }
switch (event.type) {
  case "message.part.delta":
    draft.part = { ...current.part }
    break
}
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you spread `session: [...current.session]` but the event only modifies `part`, the `session` array gets a new reference. Every component using `useSessions()` re-renders for nothing.

During streaming, `message.part.delta` fires ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

## Event → field mapping

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part` |
| `session.diff` | `session_diff` |
| `session.status` | `session_status` |
| `todo.updated` | `todo` |
| `message.updated` | `message` |
| `message.removed` | `message`, `part` |
| `message.part.updated` | `part`; `message` only when inserting a provisional live assistant message for an orphan assistant text/reasoning/tool part |
| `message.part.removed/delta` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` |

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Synthetic status events

Server compatibility events named `openchamber:session-status` are normalized in `event-pipeline.ts` before routing and coalescing. The normalized event uses the canonical `session.status` type with `properties.sessionID` and a `properties.status` object. This keeps reducers, routing keys, and coalescing on the same path as OpenCode-native status events.

## Completion vs active work

Completion indicators combine an authoritatively idle lifecycle record with unread state; neither historical messages nor unread notifications create green by themselves. Green is restricted to an idle background session with a terminal visible summary, no active tools or blocking requests, and unread completion. The active session never renders green, and selecting a session synchronously marks its root/descendant notifications viewed and clears settled normal/completed-plan indicators. Pending questions retain their blocking presentation. For all other states the precedence is active work (neutral spinner), idle proposed plan (yellow), unread error, then idle unread completion (green).

Proposed-plan and unread-completion state are restored after startup from authoritative materialized messages. Restoration is narrowed by the persisted session-to-plan-mode-message ownership map and compact completion identity/read records, processed sequentially per directory, and re-runs normal lifecycle detection after each snapshot load. Only completion identity, directory/session/message IDs, timestamp, and read state are persisted; provider errors and response content are not. This avoids treating arbitrary historical output as active while preserving yellow/green background indicators across reload and reconnect.

Authoritative permanent deletion removes only the deleted session's notification rows, rewrites compact completion persistence, and delegates to the session UI retirement action to cancel pending normal/plan completion-settlement timers before they can repopulate indicator state. Archive remains reversible and preserves those completion records and timers.

Plan revision and actionability remain derived from canonical message history rather than a second ledger. Plan-mode user turns are ordered by their canonical user message IDs/turn projection, assistant sources attach through `parentID`, and completed plan cards receive monotonic versions. A newer plan-mode user turn immediately supersedes older cards even before its replacement card is complete; history remains visible, but only the latest completed and unimplemented source is actionable. Unchanged plan trace indexes preserve reference identity while text streams.

Assistant completion and session idleness are separate lifecycle edges. A terminal assistant message, including final text and completed tool rows, never converts `busy`/`retry` to `idle` and never retires streaming ownership. Only authoritative idle (`session.status: idle` or `session.idle`), confirmed abort cleanup, or `session.error` ends working state. A terminal message may trigger a targeted status refresh, but the refreshed status remains the source of truth. `time.completed` is terminal evidence only when it is a finite positive timestamp; optimistic messages omit it entirely.

Streaming ownership, the Stop action, and the shared working-status shimmer remain active for the full authoritative `busy`/`retry` period. This includes the finalization tail after visible final text or completed tools arrive but before idle. An explicit idle status immediately retires the exact session's streaming ownership; historical incomplete message shells cannot override it.

Accepted `busy`/`retry` status is treated as a new-work edge. When the sync store still contains `busy`/`retry` after reducing a status event, `sync-context.tsx` clears pending and visible completion indicators for that session. Delayed completion timers in `session-ui-store.ts` also re-check live status before writing so a green dot cannot appear after the session has started working again.

When OpenCode emits `message.part.updated` before the owning `message.updated`, the reducer may insert a provisional assistant message so live output renders immediately. This is intentionally narrow: reasoning parts preserve the existing provisional path, while text/tool parts only provisionalize for an actively busy/retrying session. The real `message.updated` later replaces the provisional message by ID; the lightweight no-op gate compares `parentID` so a non-terminal owning update cannot leave the provisional assistant orphaned. Buffered `message.part.delta` events replay once the part exists.

## Active-session recovery watchdog

`sync-context.tsx` tracks the last observed `session.status` and semantic message/part output event per `directory + sessionID`. A 5-second watchdog checks only the active viewed session; when that session remains `busy` or `retry` without fresh activity for 20 seconds, it runs a targeted reconnect resync for that session only. Successful probes retain the normal 15-second cooldown but continue while the authoritative state remains unchanged; transport success alone is not execution progress. Failed probes use a 15/30/60-second bounded backoff. Duplicate `busy` statuses do not reset semantic-output age, while retry-status changes still count as retry-loop activity.

After five minutes of semantic silence, an unchanged authoritative resync becomes actionable for two exact trailing root-assistant shapes. An identified tool call in `pending + input:{} + raw:""` remains an explicit **Stop & Retry** action. An initial shell containing only `step-start` plus one empty reasoning/text part is inert and is stopped automatically. Both paths perform another authoritative resync and exact fingerprint check before aborting; a resumed or replaced stream wins the race and remains running. A confirmed abort opens the existing manual model-recovery card anchored to the authoritative user message, and DevRyan never resends a recovery prompt automatically. Non-empty or previously productive inference, partial input, running/final tools, terminal assistants, provider retries, permission/question blockers, managed dispatches, and active managed children are excluded. Any semantic event, terminal status, session switch/deletion, or directory disposal clears the low-frequency stall record. Confirmed stalls also emit sanitized operational journal marks containing only identity, source, and elapsed duration.

Running `ctx_execute` calls use a separate low-frequency observation record because a long tool call is not evidence of a provider failure. The record preserves exact session/message/part/call identity plus first-observed and last-activity timestamps. The status row shows elapsed time immediately; after ten minutes without a semantic update, the watchdog confirms the same call through an authoritative resync and offers a user-controlled **Stop** action. Stop rechecks identity once more before the existing confirmed abort, never kills work automatically, never retries, and never opens model recovery. Progress clears the warning and restarts the silence window; completion, replacement, blockers, session lifecycle cleanup, and directory disposal retire the record. Confirmation emits one sanitized `renderer_long_running_tool_confirmed` mark containing only tool name, source, and elapsed duration.

Reconnect recovery treats its status response as a snapshot, not a live event.
For every candidate it captures the complete current status before requesting the
snapshot and merges the response only while that baseline is unchanged. Because
the same snapshot is reconsidered after message and blocking-request recovery,
that second merge uses a new post-merge baseline. A newer live status event in
either async window therefore remains authoritative; unchanged candidates still
receive the authoritative status snapshot without message-based settlement. All baselines stay
scoped to the existing `directory + sessionID` candidates.

## Manual provider recovery and stop-during-retry guard

Subtask composer sends preserve the agent assigned by the child's original user
message. A later continuation cannot silently replace that child identity with
the globally selected primary agent; root sessions continue restoring their
latest user-selected agent and model. When a same-child Model Recovery appends a
new user record, the composer combines that stable specialist identity with the
latest authoritative provider/model/variant, applies the four fields together,
and scopes the child-session lookup by directory. This restoration waits for the
message list itself, not full assistant-part materialization, because a failed
provider turn can legitimately leave an empty assistant shell in history.
Reopening the recovered child therefore shows Oracle (or the assigned
specialist) beside the selected recovery model and thinking level instead of
inheriting the previously viewed session's agent.

OpenCode ignores `session.abort` while a session sleeps between provider retry attempts (out of usage / rate limit) and keeps emitting `session.status: retry` — it never emits `session.idle`/`session.error` from inside the loop. `abort-retry-guard.ts` makes a manual Stop stick:

- Every user-initiated abort path (`abortCurrentOperation`, queued-send interrupt, archive/delete pre-abort, revert/unrevert) registers a per-session guard via `registerManualAbortGuard`.
- An unguarded provider `retry` remains authoritative so OpenCode can apply its retry policy, except when a root session reports a definite shared usage-limit classification. That case receives a confirmed abort immediately and creates the same explicit recovery record. Child sessions are excluded by authoritative `parentID` and continue through managed-task recovery.
- The guard starts with a 60-second base window. When the stopped status is `retry`, it is seeded from the authoritative `attempt`/`next` identity and remains active through that normalized retry target plus the same settlement window. New retry identities can advance the deadline, while duplicate relative deadlines reuse their first normalized target instead of sliding forever.
- While active, `filterSessionStatusThroughAbortGuard` coerces incoming `retry` statuses to `idle` (live event reduction, reconnect status merge, and directory bootstrap snapshots all route through it) and schedules bounded, debounced re-aborts (max 3) so the server loop is cancelled when its next attempt creates an abortable in-flight request. Snapshot filtering preserves the original status-map reference when no guard changes a value.
- Streaming derivation does not retain an incomplete assistant shell across that guarded `idle`; explicit idle is authoritative, so the composer unlocks without consulting historical message completion.
- After a successful reconnect/bootstrap status snapshot, every listed session omitted from that snapshot is materialized as authoritative `idle`. Bootstrap explicitly settles any pre-existing streaming ownership for those sessions first, so a historical incomplete assistant shell cannot survive the snapshot as live activity or leave a plan card finishing forever.
- The guard clears on authoritative idle (`session.idle`, `session.error`, idle `session.status`), on any new local send (`optimisticSend`, `usePromptSubmit`), and when an authoritative user message advances the cached user-turn boundary and proves that another connected surface started new work. Historical replay into an empty or newer cache cannot clear it.
- `useProviderErrorRecovery` creates root-session recovery records after an authoritative active-to-idle transition ends with a matching retryable terminal assistant error. On first observation after reconnect, authoritative idle plus a trailing incomplete root response also becomes an explicit interrupted-response recovery instead of historical live activity. A definite provider usage limit is stopped on its first live retry; other transient stream retry loops remain capped after three attempts. DevRyan first receives a successful abort acknowledgement, then offers the same explicit recovery card. Manual recovery waits for guard settlement before sending the captured provider/model/agent/variant, preventing an explicitly stopped retry loop from overlapping the replacement turn; no recovery is resent automatically. A newer authoritative user turn clears an older recovery record, and the retry action performs the same final check so stale cards disappear without surfacing a misleading “failed turn is no longer available” error.
- When the current retry deadline plus its settlement window expires without idle, live server state wins again — the guard never permanently masks real activity.

`abortCurrentOperation` first cancels the active top-level DevRyan-managed tasks for the parent session with scheduler cascade enabled, then aborts the parent OpenCode session. This stops queued and running managed descendants without emitting cancellation tool calls into chat. It additionally settles a local `retry` status to `idle` right after the abort request (narrow optimistic transition mirroring `revertToMessage`); guarded streaming derivation completes the stopped assistant shell so the input and model picker unlock immediately. If the abort started from `retry` and the provider races the next attempt to `busy` before acknowledging it, the same narrow transition settles that raced state. An abort that started from ordinary `busy` still waits for the authoritative idle event.

Direct steering and queued **send now** share the same successful-abort path and record abort display reason `steered`; the explicit Stop action remains `manual`. Send-now performs the steer before claiming the queue, then atomically flushes every claimed item FIFO. Natural idle auto-send never aborts and waits for the pre-existing user turn to have a terminal, parent-correlated assistant response before its first send. Before every later item, the flush likewise requires a terminal assistant message whose `parentID` matches the prior queued transport message ID while live status is idle; an early idle event cannot advance the queue. Queue rows capture a stable queue-item ID, session directory, provider/model/agent/variant/plan mode, and attachments at enqueue time. An OpenCode-compatible, time-sortable transport message ID is assigned immediately before each individual FIFO dispatch—after the preceding assistant turn—and is then preserved across rollback and ambiguous retries. Later, unattempted claimed rows remain without a transport ID until their turn; legacy queue-time IDs without dispatch scope are refreshed before dispatch. Missing directories use the authoritative session lookup.

Plan mode is also preserved into the prompt transport. Immediately before every primary fetch attempt—including queued sends and retries—the transport resolves the current health-advertised `contextModeAvailable` capability (`contextModeReadOnlyIndexing` remains a response compatibility alias). Writable turns explicitly receive canonical and MCP-prefixed Context Mode execution/index/search/statistics/web-fetch grants. Plan turns receive only index/search/statistics/web-fetch, while execution and administration remain disabled. All grants fail closed for external or not-yet-verified runtimes, and Cursor SDK-backed turns remain unchanged. Broad local analysis is instructed to use `ctx_index → ctx_search`, broad web research uses `ctx_fetch_and_index → ctx_search`, and bounded exact lookups remain native.

If an auto-send fails while the transport disconnects, the claimed rows are restored with their dispatch identity intact. The queue hook never dispatches while disconnected and grants that restored idle queue exactly one new attempt on the authoritative disconnected-to-connected edge. A WS-to-SSE switch preserves the current connection state because selecting a fallback transport does not prove that it connected. The SSE SDK also constructs its stream wrapper before opening the response, so SSE publishes recovery only after its first parsed or yielded event; an error response cannot create a transient connected pulse. A steady connected state is not a retry signal, so persistent validation, authorization, or provider failures cannot create an automatic retry loop.

## Session history loader

`SessionMessageLoader` is created once by `SyncProvider` and owns first-page,
older-page, stale-tail, prefetch, optimistic-shadow, and in-flight state for a
normalized `(directory, session ID)` key. Metadata and the first message page
start concurrently in `useSync`; metadata failure never blocks a valid message
snapshot. The loader materializes a page once after any adaptive expansion, so
catch-up never replays historical events through the live reducer.

With `sessionFastLoadEnabled`, web/Electron starts at 50 records and expands to
100 then 150 only when a cursor remains without a user-turn boundary. VS Code
uses 30, 50, 80, then 120. Disabling the non-persisted flag keeps the same
correctness owner but restores a 200-record first request and disables intent
prefetch. Explicit Load Older pages remain 200 records.

Renderable snapshots are stale-while-revalidate for 15 seconds. A stale reopen
paints from memory immediately and merges a 30-record tail refresh while
preserving the established older-history cursor. Generation and child-store
identity guards prevent deletion, directory disposal, and rapid switching from
accepting late results. Selected-session hydration does not invoke the broad
focus/reconnect recovery path; only an actually incomplete trailing assistant
turn may request that recovery.

Intent prefetch is active-directory-only, one request at a time, and limited to
six queued targets. Rows start exact-session work on pointer-down/click, hover
after 180 ms, keyboard focus immediately, and settled neighbors after 600 ms.
Only two non-active prefetched snapshots are retained on web/Electron and one
in VS Code. No directory-wide runtime bootstrap is performed by prefetch.

`useSessionMessageLoadState(sessionID, directory)` is the exact reactive leaf
for status, loading kind, error, resolution, retained limit, cursor,
completeness, and update time. Opt-in performance metrics cover navigation to
first-visible frame, requests, retries, payload sizes, and materialization; no
directory, session ID, or message content is emitted.

## Selector hygiene

Session metadata has an additional subscription boundary. `useSession()` and
`useSessionDirectory()` subscribe only to the `session` branch of the relevant
directory stores; message, part, status, permission, and question events do not
notify them. Cross-directory reads use
`ChildStoreManager.subscribeSessionLists()` instead of the all-state channel.
`useSessionDirectory()` returns the directory primitive directly, so a title or
timestamp replacement for the same session cannot repaint Markdown/tool leaves
whose effective directory is unchanged.

`useSessionChildren(parentID, directory)` is the canonical direct-child
projection for mounted chat/task rows. It returns its previous array when child
membership, ordering, and child object references are unchanged, even if an
unrelated session is created, updated, or deleted. Use `useSessions()` only for
surfaces that genuinely render or rank the full structural list; do not scan it
from message, tool, permission, question, or selection leaves.

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files | User typing, file attach, revert/fork |
| `selection-store.ts` | Per-session model/agent/variant choices | Model/agent picker |
| `viewport-store.ts` | Scroll anchors, session memory state, sync status | Streaming, scroll, session switch |

### Rules for new UI state

1. **Never add to `session-ui-store`** unless it's session selection, draft lifecycle, or abort state
2. **Group by change frequency** — state that changes during streaming (viewport, memory) must not live with state that changes on user action (selections, input)
3. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
4. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
5. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

### Anti-patterns

```typescript
// WRONG — stuffing unrelated state into one store
const useEverythingStore = create(() => ({
  voiceMode: "idle",
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useVoiceStore = create(() => ({ voiceMode: "idle" }))
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```
