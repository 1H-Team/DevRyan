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

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `message`, `part`, `permission`, `question`, etc. | One directory |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

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

`useGlobalSessionsStore` is not maintained by SSE directly. It is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
   - archive
   - delete
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must derive from aggregated child-store state.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Revert/fork input restoration belongs in `session-actions.ts`; for safe scoped revert, restore the clicked prompt/attachments only after the server acknowledges the revert so failed reverts do not leave the input out of sync with visible history.
5. Draft sends must resolve and validate provider/model/agent selection before creating the backend session. A missing model should keep the draft intact and avoid creating an empty chat.
6. A foreground send must always target a real session ID. If the UI has no current session and no open draft, `session-ui-store.ts` creates and selects a normal session before optimistic send/routing; never route a prompt with an empty session ID.
7. Backend session creation retries transient 5xx/startup responses in `createSessionRecord()`. The managed OpenCode server can still be warming up when the web UI is already interactive, so a single `503 OpenCode is restarting` must not strand the user's first prompt.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `deleteSession()` -> `removeSessions([id])`

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
| `message.updated` | `message`; `session_status` only for terminal trailing assistant status settlement |
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

Completion indicators are derived from final visible assistant summaries, not from historical unread state alone. The green sidebar completion indicator means the trailing assistant message is terminal, is not an intermediate `finish: "tool-calls"` message, has no running tool parts, and has visible assistant text or reasoning summary content. Finalized tool rows and unread completion notifications do not create the green indicator by themselves.

A trailing assistant message can settle stale `busy`/`retry` status to `idle` only when it is terminal, has no running tool parts, has no pending permission or question, and is not `finish: "tool-calls"`. This keeps the session working spinner visible between tool calls while OpenCode is still running and prevents an intermediate tool-call shell from hiding the final summary stream.

Accepted `busy`/`retry` status is treated as a new-work edge. When the sync store still contains `busy`/`retry` after reducing a status event, `sync-context.tsx` clears pending and visible completion indicators for that session. Delayed completion timers in `session-ui-store.ts` also re-check live status before writing so a green dot cannot appear after the session has started working again.

When OpenCode emits `message.part.updated` before the owning `message.updated`, the reducer may insert a provisional assistant message so live output renders immediately. This is intentionally narrow: reasoning parts preserve the existing provisional path, while text/tool parts only provisionalize for an actively busy/retrying session. The real `message.updated` later replaces the provisional message by ID, and buffered `message.part.delta` events replay once the part exists.

## Active-session recovery watchdog

`sync-context.tsx` tracks the last observed `session.status` and message/part output event per `directory + sessionID`. A 5-second watchdog checks only the active viewed session; when that session remains `busy` or `retry` without fresh status or output activity for 20 seconds, it runs a targeted reconnect resync for that session only. A 15-second per-session cooldown prevents repeated recovery calls.

## Stop-during-retry guard

OpenCode ignores `session.abort` while a session sleeps between provider retry attempts (out of usage / rate limit) and keeps emitting `session.status: retry` — it never emits `session.idle`/`session.error` from inside the loop. `abort-retry-guard.ts` makes a manual Stop stick:

- Every user-initiated abort path (`abortCurrentOperation`, queued-send interrupt, archive/delete pre-abort, revert/unrevert) registers a per-session guard via `registerManualAbortGuard`.
- While active (60s TTL), `filterSessionStatusThroughAbortGuard` coerces incoming `retry` statuses to `idle` (event reducer and reconnect status merge both route through it) and schedules bounded, debounced re-aborts (max 3) so the server loop is cancelled the moment its next attempt creates an abortable in-flight request.
- The guard clears on authoritative idle (`session.idle`, `session.error`, idle `session.status`) and on any new local send (`optimisticSend`, `usePromptSubmit`), so a legitimate new turn is never suppressed or re-aborted.
- When the TTL expires without idle, live server state wins again — the guard never permanently masks real activity.

`abortCurrentOperation` additionally settles a local `retry` status to `idle` right after the abort request (narrow optimistic transition mirroring `revertToMessage`), so the input and model picker unlock immediately.

## Selector hygiene

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
