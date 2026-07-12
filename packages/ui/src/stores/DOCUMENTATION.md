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

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

### Managed orchestration projection store

`useManagedOrchestrationStore.ts` is the dedicated client projection of the
host-owned DevRyan scheduler. It is intentionally separate from directory sync
stores and provider-native tool activity.

Core model:

- safe task records keyed by `dvr_task_*` identity
- root-session task ID arrays with stable references
- terminal result envelopes keyed by task ID
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

### Provider recovery store

`useProviderRecoveryStore.ts` retains one low-frequency, non-persisted recovery
record per session. Retryable terminal provider errors populate it after an
authoritative active-to-idle transition; live provider retry statuses do not.
The record owns a local provider/model/variant selection plus pending/action
error leaves. Normal user sends clear it, while a manual recovery send preserves
it until the send succeeds so failed retries remain actionable.

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
