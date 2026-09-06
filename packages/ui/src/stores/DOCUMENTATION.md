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

`useConfigStore.ts` keeps OpenCode connection state separate from its low-frequency
provider/agent initialization status. A confirmed healthy connection stays connected
when a later bootstrap phase fails, while the non-persisted initialization status and
error let the startup gate identify the actual failing phase and retry it without an
unnecessary runtime restart.

Applying a default agent updates its agent, configured provider/model, and thinking
variant in one store transition. Only an explicit draft model selection (including
legacy drafts that persist both provider and model) may preserve a different model;
ambient directory or reload state cannot make the display diverge from send-time
agent-default routing.

An asynchronous agent-catalog refresh restores the selected draft's authoritative
send selection through `restoreLiveConfigForSelectedDraft`. It reads the active
draft when the refresh completes, so a late response cannot replace a newer
agent/model/thinking pick with account defaults or restore a draft the user left.
Explicit settings actions still apply defaults normally.

Managed non-admin accounts keep sparse per-agent provider, model, and optional
thinking overrides as account-global state, never directory snapshots. Only an
explicit Save in Settings → Sessions persists one through the server; composer
changes remain draft/session scoped. Reset removes the sparse key so the next
fresh draft inherits the live host agent model and variant. The shared resolver
uses personal override, live host agent configuration, then model-availability
fallback, normalizing thinking through the selected provider model. Council is
host-managed and ignores stale personal entries.

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

The Bot runtime uses separate low-frequency projections for catalog, channels,
operations, and persistent Shared files. `useBotSharedFilesStore.ts` is scoped to
the authenticated principal, indexes file IDs per authorized channel, and
reconciles `shared_file.updated` events without making the operations rail poll
or subscribe to transcript streaming. Snapshot ACL changes synchronously prune
files for channels the principal can no longer access.

`useConfigApplyStore.ts` is the renderer projection of the host-owned revisioned
configuration-apply coordinator. Every successful config mutation merges its
validated apply envelope. The always-mounted web/Electron shells poll only
transient pending/waiting/applying states, including after Settings closes, and stop
once the host reaches a stable state. The store sends the exact expected revision for wait/force/external
acknowledgement, retains failures for explicit retry, and refreshes only applied
agent/provider/command/skill/MCP/behavior/runtime catalogs. It never infers
restart need from a toast, route name, or historical session state.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

For a managed principal, `useProjectsStore.ts` derives the visible project registry and
active project from the authenticated assignment snapshot during settings hydration.
Project lists are naturally alphabetized by their display name at startup (numbers before
letters), while explicit drag-and-drop reordering remains available for the current runtime.
Each repository keeps the server-owned UUID and contains an ordered branch projection;
the store does not generate path-based replacement IDs or apply browser-local visual
metadata overrides. Assignment-provided icon, image, background, and color fields replace
stale cached visuals while user-local collapse and recency fields retain their identity.
Persisted host-path projects are not replayed into the live directory store;
the default assignment's public `/projects/<project>/<branch>` path becomes authoritative
instead. Managed metadata changes are admin-only, persisted through the server, and
rolled back optimistically if that request fails. Active managed clients refresh their
principal assignment snapshot after a scoped project-metadata event and after the
OpenChamber event stream reconnects, recovering changes missed while disconnected.

`useGlobalSessionsStore.ts` combines complete global HTTP listings with low-frequency
`session.created`, `session.updated`, and `session.deleted` events from the sync pipeline. Lifecycle
events from unopened directories update the sidebar cache without allocating a directory child store.
A bounded module-level lifecycle overlay protects those events from stale in-flight HTTP snapshots.
Each global list request captures the current lifecycle revision and replays only newer events, so a
later complete active+archived snapshot can authoritatively remove an orphaned create while a request
that began before a concurrent create or delete cannot overwrite it. High-frequency
message/part/status events stay out of this broad store.

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

Persisted context usage is version 2. Legacy `totalTokens` entries migrate to
`activeInputTokens` from input/cache components when available; otherwise the
old measured value is retained as a marked message fallback until live data
arrives. `useProviderContextUsageStore.ts` separately owns low-frequency,
non-persisted Meridian snapshots so provider refreshes do not widen the render
fanout of the session or context stores. It coalesces requests per session,
caps retained entries, and removes the old snapshot synchronously at a native
compaction boundary.

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
- an exact `(rootSessionId, dispatchCallId)` leaf selector for provisional chat rows
- terminal result envelopes keyed by task ID
- one narrow latest-task index keyed by canonical child session for recovered transcript presentation
- one narrow child-session-to-task index for unacknowledged manual recovery
- per-task pending action and visible action-error leaves
- one serialized snapshot load per scope, reconciled against events received
  after that load began in one atomic store update

Task records carry a `waitingReason` field for ledger/wire compatibility
(records written by v1.1.11 carry `waitingReason: null`). Ingestion still
parses it, normalizes it to `null` for any non-queued status or malformed
value (never dropping the task), and compares it structurally so identical
replays keep the record reference. No DevRyan host wires launch admission, so
sub-agent launches are never capped or held and the field is always `null` in
practice (user requirement, 2026-09-04); no store surfaces limits or pacing.

The managed agent-runtime switches (today only `lsp`, OpenCode's language
servers inside agent sessions) live in `useAgentsStore` as `agentRuntimeSettings`,
loaded and saved optimistically through `/api/config/agent-runtime` from the
Agent Runtime section of the same page. OpenCode reads these when its instance
starts, so the host answers `appliesOnRestart: true` and a `PUT` that changes
the value while a managed server runs answers `restartRequired: true`; the
store keeps that flag across reloads and later saves until
`markAgentRuntimeRestarted()` runs (the section's Restart Runtime button, which
posts the manual configuration reload through `apis.settings.restartOpenCode`).
A 404 or 501 from the host clears the state so the section hides.

Ownership and safety rules:

1. The store is not persisted. The web/Electron host ledger is the
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
   Provisional dispatch rows use the exact call selector, which returns only a
   stable task ID and never reconciles by mutable label or agent text. Once a
   completed start output exposes a task ID, its fallback row subscribes to that
   exact task leaf and may immediately request one root-scoped snapshot if the
   live event was missed. Once the shared sync layer receives the root session's
   authoritative idle event, it makes one final scoped request if the managed
   projection is still active, so a missed terminal event cannot strand
   `Preparing...`, `Running...`, or the root barrier. This
   recovery does not infer live activity from the invoking assistant record's
   historical completion; snapshot-load deduplication coalesces parallel rows
   and no poller is created.
8. The app owner resets the projection on real runtime shutdown; generation
   tokens prevent late requests from repopulating the reset store.
9. Identity-only compaction events remove the exact task, result, action state,
   and root index immediately. Active snapshot requests record removals locally
   so a stale response cannot resurrect an evicted projection.
10. `manualRecoveryTaskIdByChildSessionId` contains only failed/interrupted,
    resumable, unacknowledged tasks whose `agentRetryAvailable` flag is false
    and whose safe policy projection is either a definite provider limit or a
    grouped Orchestrator attempt at/after attempt 2. The private group ID never
    enters the store; only the immutable `dispatchGrouped` boolean does. The
    display-only `dispatchWaveId` is kept when it carries the `dvr_wave_`
    prefix (absent or malformed reads as null) and is immutable after the
    first event. `managedOrchestrationSelectors.dispatchWaveIndex` derives an
    identity-stable `{ waveIdByTaskId, openWaveIds }` index — a wave is open
    while any of its tasks is non-terminal or unacknowledged — so the chat can
    group Agent Dispatch cards by wave without re-rendering on every task event.
    Definite usage/quota exhaustion, including exhausted provider session
    and rate-limit allowances, is projected with
    `failureKind: provider_usage_limit` and closes the flag on the first
    terminal attempt. Manual recovery is therefore indexed immediately, even
    while the child still reports provider `retry` during cleanup. Accepting a
    user `retry_in_place` removes the index; another failed attempt restores it.
    Scheduler hard deadlines use the stable
    `failureKind: deadline_exceeded` projection; their final grouped attempt
    remains actionable even while the killed child is still tearing down.
    Transient non-provider-limit failures retain the single agent recovery.
    `failureKind: provider_prompt_rejected` also retains that first recovery,
    but it is never indexed for same-child Model Recovery: scheduler policy
    requires a different prompt in a fresh child and leaves a second rejection
    dispositionable without opening a model picker.
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
11. `latestTaskIdByChildSessionId` tracks the highest-sequence retained task for
    each canonical child session. The child transcript subscribes through the
    exact `latestTaskForChildSession` selector and the existing narrow manual
    recovery selector so automatic transport/resume and aborted-turn copy follows
    authoritative continuing/completed/action-required/stopped task state without
    a broad task-container subscription. Event updates, snapshots, and compaction
    recompute only affected child leaves and fall back to the previous retained
    lineage when a newer compacted task is removed.

The task ledger remains the durable result source, but a row whose terminal
result is stale while its canonical child reports live `busy`/`retry` activity
is presented as running. This is a display-only reconciliation and does not
rewrite or discard the retained failure envelope.

### Production Bots projection stores

Production Bots deliberately use focused non-persisted stores instead of the
ordinary OpenCode session/message branches:

- `useBotsStore.ts` owns low-frequency capability, Bot, safe revision metadata,
  current-principal membership, and Bot selection state.
- `useBotChannelStore.ts` owns authorized channels, normalized paged canonical
  messages, stable per-channel attachment IDs, per-channel cursors, drafts,
  coalesced owner-channel opening, and one client-stable optimistic send row.
  Attachment references are recalculated only when attachment membership
  changes, so message updates preserve the artifact leaf. One atomic send update
  inserts and orders the optimistic row, clears the exact draft, and marks the
  short acceptance request pending. Definitive rejection rolls back that row and
  restores the captured draft; ambiguous transport failure retains a
  `Not confirmed` row, refreshes history, and retries the same ID exactly once.
  Explicit failed-run retry requeues the same server run and creates no message.
  Refusals refresh run status without mutating drafts or messages; a permanent
  refusal clears stale retry eligibility even if an older status projection
  still allows it. Principal changes discard late retry/status responses.
- `useBotLiveMessageStore.ts` owns only requester-streaming message records and
  one live message ID per channel. Revisions are monotonic, payloads are capped
  at 192 KiB, and canonical/final/terminal/channel/principal/reconnect boundaries
  clear transient text without touching canonical history.
- `useBotOperationsStore.ts` owns runs, pending approvals, action metadata,
  low-frequency computer/control status, and Bot-SSE connection state.
  Screencast frames never enter Zustand.

`apps/BotsEventOwner.tsx` is the only stream owner. It applies each authorized
snapshot as the current principal's ACL boundary, preserves the last accepted
sequence across same-epoch reconnect snapshots, drops replayed events, and
resets every Bot store, including transient live text, on account change or real
owner unmount. Bot events do
not enter `sync-context.tsx`. Entity and channel/run index references are
preserved when presentation-relevant values did not change; rendering code
should use the exported per-Bot, per-channel, and per-run leaf selectors.

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
