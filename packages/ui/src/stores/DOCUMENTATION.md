# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, session id)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

There are multiple store categories in this directory.

### Feature cache / query stores

These are the most performance-sensitive.

- `useGitStore.ts`
- `useGitHubPrStatusStore.ts`
- `useFilesViewTabsStore.ts`

These stores act like centralized keyed caches. UI should consume narrow slices from them instead of re-fetching the same data in multiple places.

### UI state stores

Examples:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`

`useAgentRuntimeWarmupStore.ts` is a narrow, non-persisted status store for the
single directory currently being warmed by the app startup effect. Assistant
status consumers subscribe only to this string and replace a generic working
phrase with `Preparing project…` when their active directory matches. The app
clears the value on warmup settlement and effect cleanup only when it still owns
the same directory value.

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

`useGlobalSessionsStore.ts` combines complete global HTTP listings with low-frequency
`session.created`, `session.updated`, and `session.deleted` events from the sync pipeline. Lifecycle
events from unopened directories update the sidebar cache without allocating a directory child store.
A bounded module-level lifecycle overlay protects those events from stale in-flight HTTP snapshots:
upserts remain until complete active+archived listings confirm equal-or-newer membership, and deletes
remain tombstoned until both listings confirm absence. High-frequency message/part/status events stay
out of this broad store.

### Message queue store

`messageQueueStore.ts` owns persisted queued prompt rows per session. Queue-time
rows capture directory, attachments, and send configuration but intentionally do
not receive a transport message ID until their first dispatch attempt.

The store exposes two claim shapes:

- `claimQueueForSession` atomically drains the FIFO queue for sequential idle or
  send-now flushing; `restoreClaimedQueue` prepends the unprocessed tail.
- `claimMessageForSession` atomically removes one selected chip and records its
  original index; `restoreClaimedMessage` restores the same row at that position
  after a failed manual dispatch.

Exact-row claim/restore is the ownership boundary between a manual chip send and
the idle auto-sender. Only the successful claimant may invoke the transport. The
restored row retains its queue ID, creation time, captured payload/config, and
dispatch-scoped message ID so an ambiguous retry cannot create a duplicate user
turn.

Queued rows survive reversible archive updates. An authoritative
`session.deleted` event clears only the permanently deleted session's queue key,
which removes its prompt and attachment data from persisted storage. Cleanup is
not performed at optimistic delete initiation, so a failed delete cannot discard
queued user work.

### Persisted session context store

`contextStore.ts` persists slow-changing session choices and derived context
usage separately from the high-frequency sync stores. Its session-keyed state
includes model, agent, per-agent model/variant, current-agent, context-usage,
and edit-mode maps.

`utils/modelContextCapacity.ts` normally treats a positive provider input limit
as the usable capacity. When an internal compaction input threshold exceeds the
advertised context limit, the smaller context limit is authoritative for usage
and display; this keeps OpenCode's Codex-reservation shim out of user-facing
capacity calculations.

An authoritative `session.deleted` event calls `clearSessionContext()` for the
exact deleted ID. The action preserves unrelated session entries and the
reserved `__global__` edit-mode fallback. It also cancels queued usage
microtasks and owned token-poll timers before removing the maps, so deferred
work cannot recreate a permanently deleted row. Deferred work records are
released on completion or cancellation; the store does not retain deleted-ID
tombstones. Archive and failed optimistic delete paths preserve this state.

### Permission auto-accept store

`permissionStore.ts` persists explicit per-session auto-accept overrides and
mirrors enabled state to the host notification runtime. The host needs that
mirror to suppress permission notifications before the renderer's automatic
reply round-trip completes.

Mirror requests are serialized independently per session. This keeps unrelated
sessions concurrent while guaranteeing that a later state change for one
session reaches the host after its older request settles. Authoritative
`session.deleted` removes only that session's persisted override and queues a
final `enabled: false`, preventing an older hydration/toggle request from
re-enabling server suppression after deletion. Completed tails are released;
there is no deleted-session tombstone. Archive and failed optimistic deletion
preserve the explicit override.

### Managed orchestration projection store

`useManagedOrchestrationStore.ts` is the dedicated client projection of the
host-owned DevRyan scheduler. It is intentionally separate from directory sync
stores and provider-native tool activity.

Core model:

- safe task records keyed by `dvr_task_*` identity
- root-session task ID arrays with stable references
- terminal result envelopes keyed by task ID
- one narrow child-session-to-task index for unacknowledged manual recovery
- per-task pending action and visible action-error leaves
- one serialized snapshot load per scope, reconciled against events received
  after that load began in one atomic store update

Ownership and safety rules:

1. The store is not persisted. The web/Electron or VS Code host ledger is the
   durable source of truth and every app owner performs an initial snapshot.
2. Ingestion reconstructs an explicit safe projection. Prompt text,
   idempotency keys, lease tokens, and unknown fields are not retained.
3. Managed events are low frequency and never carry child streaming output;
   child output remains in the existing directory-scoped session stores.
4. A malformed snapshot fails as a unit and preserves the last valid records.
   It must not silently filter a record and then delete known-good state.
5. Late snapshots cannot replace a task updated by a newer event. Task status,
   child identity, timestamps, and terminal state never regress.
6. Cancel/retry/resume/continue/abandon keep the card in place until the host
   returns authoritative state. Duplicate requests share one promise, failures
   remain visible, and retry reuses its idempotency key.
7. Components subscribe through one-root or one-task selectors. Do not select
   `tasksById` or `resultEnvelopesByTaskId` from rendering components.
8. The app owner resets the projection on real runtime shutdown; generation
   tokens prevent late requests from repopulating the reset store.
9. Identity-only compaction events remove the exact task, result, action state,
   and root index immediately. Active snapshot requests record removals locally
   so a stale response cannot resurrect an evicted projection.
10. `manualRecoveryTaskIdByChildSessionId` contains only failed/interrupted,
    resumable, unacknowledged tasks whose `agentRetryAvailable` flag is false.
    Definite usage/quota exhaustion, including exhausted provider session
    and rate-limit allowances, is projected with
    `failureKind: provider_usage_limit` and closes the flag on the first
    terminal attempt. Manual recovery is therefore indexed immediately, even
    while the child still reports provider `retry` during cleanup. Accepting a
    user `retry_in_place` removes the index; another failed attempt restores it.
    Transient non-provider-limit failures retain the single agent recovery.
    If that recovery also fails or is interrupted while remaining resumable,
    the host keeps the envelope unacknowledged and rejects agent `abandon`, so
    every failed sibling child retains its own Model Recovery card until the
    user starts a `retry_in_place` attempt.
    Events, snapshots, acknowledgement responses, and compaction recompute only
    affected child leaves; unrelated task, root, and index references remain
    stable. The sidebar consumes the narrow one-root recovery selector so
    managed-child recovery attention appears on the parent row without
    subscribing to task or envelope containers. Task-specific recovery
    surfaces may consume the one-child selectors.

The task ledger remains the durable result source, but a row whose terminal
result is stale while its canonical child reports live `busy`/`retry` activity
is presented as running. This is a display-only reconciliation and does not
rewrite or discard the retained failure envelope.

### Provider recovery store

`useProviderRecoveryStore.ts` retains one low-frequency, non-persisted recovery
record per root session. Retryable terminal provider errors populate it after
an authoritative active-to-idle transition. A definite provider usage limit in
a live root retry status first receives a confirmed abort, then populates the
same record immediately; ordinary transient retry loops remain bounded at
three attempts. Child sessions are excluded by authoritative `parentID` and
continue through managed-task recovery. The record owns a local
provider/model/variant selection plus pending/action error leaves. Normal user
sends clear it, while a manual recovery send preserves it until the send
succeeds so failed retries remain actionable. Successful recovery sends clear
only the recovery record they started from; a newer limit failure cannot be
erased by the older send resolving afterward. An authoritative newer user
message clears a stale record, including continuations created by another
connected surface; the record is retained while its own replacement send is
pending so the optimistic user message cannot clear it prematurely.

`useProviderStallStore.ts` is the separate, low-frequency pre-error projection
for a semantically silent empty pending tool call or exact blank inference
shell. It stores only the discriminant, session, directory, message/part
identity, tool/call or step-start identity, confirmation time, and action
state. It does not retain provider output/tool input or join high-frequency
sync state. Semantic output and lifecycle cleanup remove the record; exact
fingerprint checks prevent an older manual tool action or automatic inference
recovery from clearing or aborting newer work.

### MCP runtime store

`useMcpStore.ts` keeps live MCP status and transient error details scoped by the
normalized project directory. It separately persists only a sanitized last-issue
kind (`failed`, `needs_auth`, or `needs_client_registration`) per directory and
server so disabled MCP rows can distinguish a known connection problem from an
ordinary disabled state after an app restart. Raw errors, authorization URLs,
and credential-related content remain memory-only. A connected status or
successful connection test clears the remembered issue; disabling preserves it,
and successful server deletion removes only the deleted server's entry.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized per-directory Git cache.

Core model:

- top-level keyed by `directory`
- each directory entry contains:
  - repo detection
  - status
  - branches
  - log
  - identity
  - diff cache
  - per-directory loading flags
  - freshness timestamps

Important properties:

- `directories: Map<string, DirectoryGitState>` is the source of truth
- loading state is per-directory, not global
- `ensureStatus()` and `ensureAll()` are the preferred entry points for consumers
- in-flight dedupe exists for status and `ensureAll()`
- diff data is separately cached and capped with size + count limits

### `useGitHubPrStatusStore.ts`

`useGitHubPrStatusStore` is a centralized PR cache keyed by `directory::branch`.

Core model:

- each entry stores:
  - current PR status payload
  - loading / error state
  - whether initial status was resolved
  - refresh timestamps
  - watch count
  - runtime params
  - resolved identity

Important properties:

- `ensureEntry()` initializes a key lazily
- `setParams()` attaches runtime context
- `startWatching()` / `stopWatching()` are for true live PR consumers only
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- persisted cache is for page refresh continuity, not for broad background syncing

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. Closed sidebar should not create live PR work.
8. File tree Git status should update only when the file tree is visible.

## Selector Rules

Use leaf selectors.

Good:

- `useGitStatus(directory)`
- `useGitBranches(directory)`
- `useGitBranchLabel(directory)`
- `useGitRepoStatusMap(directories)`
- `usePrVisualSummaryByKeys(keys)`

Bad:

- `useGitStore((state) => state.directories)` in feature components
- `useGitHubPrStatusStore((state) => state.entries)` in feature components
- render-time scans over every PR entry for a single project/group badge

Why this matters:

- Zustand reruns selectors on every `set`
- rerenders are avoided only if the selected result stays referentially stable
- broad subscriptions magnify fanout even when only one directory changed

## Performance Rules

### 1. Preserve references for unaffected entities

If directory `A` changes, directory `B` should keep the same derived reference where possible.

### 2. Keep loading state per entity

Do not add new global `isLoadingWhatever` flags for keyed cache work.

### 3. Avoid hidden work

If a surface is not visible, it should not keep refreshing Git/PR state.

Examples:

- `PullRequestSection` may watch a PR while visible
- `SessionSidebar` may bootstrap missing PR data for expanded visible groups
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Example already in use:

- successful mutating tools emit a centralized Git refresh hint through `sessionEvents`
- visible `GitView` / `DiffView` consume the hint and refresh current-directory status

This is preferred over background polling.

### 5. Treat `diffStats` carefully

`GitStatus.diffStats` may be omitted by light status fetches.

Rules:

- do not erase richer existing `diffStats` with a lighter payload
- if a UI surface requires per-file `+/-` stats, it must ensure a full enough status payload exists

### 6. Keep diff cache bounded

Diff cache has explicit limits because large repos can otherwise blow up memory.

Do not raise limits casually.

## Refresh Model

### Git

Expected model:

- `GitView` / `DiffView` ensure current-directory Git state when visible
- explicit Git actions refresh status/branches/log as needed
- successful file-mutating tools can issue a one-shot Git refresh hint
- no root-level background Git polling

### PR

Expected model:

- `PullRequestSection` is the only true live PR watcher
- `SessionSidebar` may do one-shot bootstrap for expanded visible project/worktree groups if PR info is missing
- no live PR work for header
- no background PR sweeps outside visible demand

## Known Intentional Fallbacks

There is still one explicit fallback path worth knowing about:

- `SessionSidebar` may call `checkIsGitRepository(...)` during initial worktree/project discovery when store state is not populated yet

This is currently acceptable as a narrow bootstrap fallback.

Do not widen it into a polling or broad refresh system.

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (directory, branch, session, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Worktree sessions still show branch labels in header.
5. Expanded sidebar projects/worktrees can show PR state without requiring prior selection.
6. Hidden surfaces do not reintroduce live background work.
