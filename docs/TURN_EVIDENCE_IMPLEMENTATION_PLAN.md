# Standalone implementation plan: Exact turn checkpoints as evidence

This scope excludes durable worktree bootstrap and diagnostic bundles.

> Status note: implementation is underway in the working tree. The shared
> primitives live in `packages/harness-runtime` (`createTurnEvidenceRuntime`,
> `createEvidenceGitRuntime`, `createEvidenceLedger`, `createRecordStore`), the
> web host integration in `packages/web/server/lib/evidence/`, and the VS Code
> host in `packages/vscode/src/bridge-evidence-runtime.ts`. This plan is the
> spec those pieces must satisfy; where the implementation already made a
> structural choice (package location, state machine, routes, ref scheme), the
> plan has been reconciled to it.

## 0. Relationship to existing snapshot machinery

OpenCode already snapshots workspace state on its own: user messages carry git
diff snapshots (which our proxy strips for performance in
`packages/web/server/lib/opencode/diff-summary.js` — a large untracked tree
once produced a 92MB transcript payload), and session revert restores files via
`openCodeSnapshotRoot` (`session-scoped-revert.js`). Turn evidence exists
separately because it must:

- cover Cursor SDK sessions, which bypass OpenCode's snapshot pipeline;
- capture *external* edits (user, other sessions, other processes), not just
  what OpenCode observed;
- survive OpenCode's own snapshot retention;
- remain evidence-only, with no restore path.

Turn evidence must never read or write `openCodeSnapshotRoot` or OpenCode's
snapshot refs, and the UI must not conflate evidence with the existing
tool-derived changed-file surfaces or `PendingChangesBar`.

## 1. Shared runtime

The shared runtime lives in `packages/harness-runtime`, a private Node ESM
package shared by Web/Electron and VS Code (Electron embeds the web server, so
the web wiring covers it).

It owns:

- Turn lifecycle correlation.
- Git checkpoint creation and comparison.
- Durable checkpoint records and retention.
- Concurrency and recovery semantics.

Hosts inject Git execution, storage directory, per-project enablement lookup,
session-state resolution, logging, and event publication. Web/Electron data
lives under the harness data root (`harnessRuntime.paths.evidenceDir`, under
`OPENCHAMBER_DATA_DIR`); VS Code data under
`context.globalStorageUri/turn-evidence/`.

Use versioned JSON records with serialized atomic writes, `0600` permissions,
fsync, corruption quarantine, and startup recovery.

## 2. Product behavior

- Disabled by default, enabled per project.
- The project identity is derived from Git's common directory
  (`git rev-parse --git-common-dir`), so the setting applies to the primary
  repository and every linked worktree.
- Non-Git projects cannot enable it.
- Checkpoints record Git-visible workspace content:
  - Tracked files.
  - Non-ignored untracked files.
  - Deletions, renames, symlinks, executable bits, and submodule pointers.
  - Excludes ignored files, dirty submodule contents, and anything outside the
    worktree.
- Evidence never blocks or changes agent behavior. A failed or timed-out
  capture becomes an explicit gap and the prompt continues.
- Evidence is never treated as proof that the agent authored a change.
- No restore, reset, clean, apply, revert, cherry-pick, or attribution
  functionality may consume these checkpoints.

Use this wording throughout the UI:

> Workspace changes observed during this turn. This may include edits from
> you, other sessions, or external processes.

## 3. Turn lifecycle

### Before the turn

Intercept the prompt at the final host boundary. There are four distinct
entry points; the Express middleware covers only the first two, so the managed
paths need their own hooks:

- Standard Web/Electron: middleware on `/api/session/:sessionID/prompt_async`,
  registered ahead of the existing three handlers in
  `packages/web/server/lib/opencode/routes.js` (provider tool overrides, title
  scheduling, and the terminal Cursor handler at `routes.js:858`) so both the
  standard proxy path and the Cursor path pass through it. The harness prompt
  admission middleware (`packages/web/server/lib/harness/runtime.js`) already
  emits the lifecycle event; evidence subscribes to that rather than adding a
  second middleware.
- VS Code: `bridge-proxy-runtime.ts` `admitPrompt` already records the prompt
  (path, directory, `messageID`) into the harness runtime; evidence subscribes
  to the same lifecycle events.
- Managed orchestration tasks: `packages/web/server/lib/orchestration/open-code-executor.js`
  and `packages/vscode/src/managedOpenCodeExecutor.ts` post `prompt_async`
  directly to the OpenCode backend and call
  `cursorSdkRuntime.handlePromptAsync` directly — both bypass the Express
  layer. They must emit the same lifecycle events explicitly.

Use the existing `x-openchamber-message-id` header
(`PROMPT_ASYNC_MESSAGE_ID_HEADER` in `proxy.js`) or the body `messageID` as the
stable user-message identity from which `turnID` is derived.

When enabled:

1. Resolve the canonical worktree and project (cached per directory).
2. Persist a `capturing_before` record.
3. Capture the before checkpoint.
4. Persist the checkpoint identity.
5. Forward the prompt.

The before capture sits on the prompt critical path. Cap it at 10 seconds by
default (configurable); the after capture may use a longer 30-second cap. On
timeout or failure, mark the record `gap` with a reason and forward the prompt
anyway.

If the prompt is rejected before acceptance, remove the preliminary hidden ref
and close the record as `gap` with reason `prompt_rejected`.

### After the turn

Settle from host-provided signals only:

- The lifecycle event stream (prompt accepted, turn terminal, abort).
- The host's authoritative session-activity state
  (`getSessionActivity`-style resolver: `busy`/`retry` → busy,
  `idle`/`cooldown` → idle).

Do **not** poll or reconcile full message transcripts to detect turn end.
Transcript fetches carry diff snapshots and have already caused a
92MB-payload stall (see `diff-summary.js`); if a reconciliation read is ever
required, it must go through the diff-stripping proxy path with a strict
timeout and pagination. Inspecting per-message tool parts is likewise out of
scope — the activity resolver is the authority.

Allow a short event-drain window after the terminal event, then capture.
Capture aborted and failed turns as well (the `/api/session/:sessionID/abort`
route and Cursor abort path emit the terminal lifecycle event).

Concurrency: checkpoint captures are serialized per worktree, but a prompt
must never queue indefinitely behind another turn's capture. If a capture is
already in flight for the worktree, wait a bounded interval (a few seconds);
on expiry, forward the prompt and record the evidence as `gap`
(`capture_contended`) or capture with `overlap: true` once the slot frees.
Overlapping turn intervals in the same worktree are both captured normally and
marked `overlap: true`.

### Restart recovery

Records are persisted before prompt forwarding, so open intervals survive
restarts. On startup:

- Busy session: resume observation and capture after the eventual idle.
- Already-idle session with a verifiable before checkpoint: capture late and
  mark reason `recovered_late` (the after boundary is approximate).
- Deleted or unavailable session: mark `gap` and remove the preliminary ref.
- Missing worktree, missing hidden ref, or missing before commit: mark `gap`
  (`before_checkpoint_missing`); never recreate evidence heuristically.

## 4. Git checkpoint implementation

For each snapshot:

1. Create a temporary index outside the repository (scratch/data dir, not
   `/tmp` of the repo).
2. Set `GIT_INDEX_FILE` and `GIT_OPTIONAL_LOCKS=0`.
3. Run `git read-tree HEAD`, or `git read-tree --empty` for an unborn
   repository.
4. Run `git add -A -- .` from the worktree root.
5. Run `git write-tree`.
6. Run `git -c commit.gpgsign=false commit-tree` with a DevRyan-controlled
   author identity.
7. Atomically update a hidden ref (`git update-ref`).
8. Delete the temporary index in `finally`.

Rules for every Git invocation in this module:

- Always separate paths with `--`; never let a recorded path be parsed as an
  option (filenames starting with `-`).
- Plumbing only (`read-tree`, `add`, `write-tree`, `commit-tree`,
  `update-ref`, `diff-tree`): no hooks run, no signing, no gc is triggered.
- Timeouts and bounded buffers on every subprocess.

Ref scheme (matches `evidence-git.js`):

```text
refs/devryan/evidence/<session-component>/<turn-component>/<phase>
```

with sanitized/derived components and `phase` ∈ `before`/`after`. Refs live
inside the project's own repository, so a project component is redundant, and
they are never pushed or fetched by default refspecs. Every ref deletion path
must verify the `refs/devryan/evidence/` prefix before acting (already
enforced in `evidence-git.js`).

Record the real `HEAD` OID at both boundaries separately from the evidence
commits.

This process may add Git objects and hidden refs, but must leave these
unchanged:

- Working files.
- Real index and staging state.
- Current branch and `HEAD`.
- Existing refs, reflogs, and `info/exclude`.

Known hazards to handle explicitly:

- **Sparse checkout**: a fresh temp index built from `read-tree HEAD` loses
  skip-worktree state, so `git add -A` would record mass phantom deletions.
  Detect `core.sparseCheckout=true` and skip capture with reason
  `sparse_checkout_unsupported` until properly supported.
- **Object-store growth**: `git add -A` hashes all non-ignored untracked
  content twice per turn; unchanged files dedupe to existing objects, but
  churned large binaries multiply across up to 200 retained turns. Record
  capture duration in the evidence record, and if workspace enumeration
  exceeds a configurable threshold, capture as `gap`
  (`workspace_too_large`) rather than stalling the prompt. The setting UI
  must disclose that evidence adds Git objects.

## 5. Evidence model

Keep the state machine small; failure detail belongs in `reason`, not in new
states (matches the implemented ledger):

```ts
type CheckpointStatus =
  | 'capturing_before'
  | 'capturing_after'
  | 'complete'
  | 'gap';

interface EvidenceRecord {
  checkpointID: string;        // opaque public identity
  turnID: string;              // derived from the user message identity
  sessionID: string;
  directory: string;           // worktree the turn ran in
  projectDirectory: string;    // primary repository root
  status: CheckpointStatus;
  reason: string | null;       // gap reason: capture_timeout, prompt_rejected,
                               // recovered_late, sparse_checkout_unsupported,
                               // workspace_too_large, before_checkpoint_missing, …
  outcome: 'completed' | 'failed' | 'aborted' | 'unknown';
  overlap: boolean;            // another turn's interval overlapped this worktree
  before: { head: string | null; commit: string | null };
  after: { head: string | null; commit: string | null };
  createdAt: number;
  settledAt: number | null;
}
```

The public API exposes only opaque `checkpointID` values — never hidden Git
refs, commit OIDs as inputs, or arbitrary revision arguments.

## 6. APIs and runtime parity

Shared runtime surface (already sketched in `harness-runtime`):

- `getProjectSetting(directory)` / `setProjectSetting(directory, value)`
- `listBySession({ sessionID })` — public summaries for a whole session in one
  read (preferred over per-turn lookups so the UI fetches once per session).
- `getDiff(checkpointID, path)` — lazy per-file patch.
- `clearProject(directory)`

HTTP mirror (implemented in `packages/web/server/lib/evidence/routes.js`;
VS Code mirrors via `bridge-evidence-runtime.ts` + webview API):

- `GET/PUT /api/evidence/project`
- `DELETE /api/evidence/project`
- `GET /api/evidence/turns/:sessionID`
- `GET /api/evidence/checkpoints/:checkpointID/diff`

Server-side validation:

- Resolve and canonicalize directories server-side; verify the checkpoint
  belongs to the resolved project before serving diffs or deletions.
- Reject diff paths that are not among the checkpoint's recorded changed
  files; pass them to Git only after `--`.
- Never accept a Git ref or revision from the renderer.

The turn summary returns file path, change type, additions, deletions, binary
status, and capture metadata (status, reason, overlap). Patches are fetched
lazily per file; binary and oversized files return type, size, and object
hashes instead of content.

## 7. UI

### Project setting

Add to the project Worktrees section (`TurnEvidenceSettingsSection.tsx`):

- "Capture exact turn evidence" checkbox, off by default.
- Explanation that it creates hidden Git objects (repo size can grow with
  large churned files) and is evidence only.
- "Clear saved evidence" action with the number of retained turns.

The setting is enforced by the host runtime (`isEnabled` at capture time), not
only by UI state.

### Turn footer

For completed Git turns (`TurnEvidenceDropdown.tsx`):

- `capturing_*`: subtle spinner and "Capturing workspace evidence."
- `complete`: observed file count and dropdown.
- `complete` + `overlap`: warning indicator explaining overlapping workspace
  activity.
- `gap` (`recovered_late`): warning that the after boundary was captured after
  restart.
- `gap` (other reasons): small non-blocking tooltip; never show the turn
  itself as failed.

Open file patches through the existing diff viewer.

Keep evidence in a narrow keyed Zustand store (`evidence-store.ts`), keyed by
session → turn. Do not add evidence records to the hot sync/session stores or
subscribe message shells to the entire collection.

Existing non-Git tool-derived changed-file behavior and `PendingChangesBar`
remain unchanged.

## 8. Retention and cleanup

- Retain seven days or 200 completed turns per repository, whichever limit is
  reached first.
- Protect active (unsettled) records from pruning.
- Permanent session deletion (`session.deleted` OpenCode event) removes that
  session's refs and records; archiving preserves evidence.
- Disabling capture stops new checkpoints but leaves existing evidence until
  normal pruning.
- "Clear saved evidence" deletes only refs under the verified
  `refs/devryan/evidence/` namespace of that project's repository.
- Never run Git garbage collection; removed refs make objects eligible for
  Git's own GC.
- If a repository is temporarily unavailable, retain a cleanup tombstone and
  retry when it is reopened.

## 9. Test plan

- Real temporary Git repositories covering dirty baselines, staged and
  unstaged edits, additions, deletions, renames, untracked and ignored files,
  binaries, symlinks, submodules, unborn repositories, and linked worktrees.
- Adversarial content: filenames beginning with `-`, filenames containing
  newlines and non-UTF-8 bytes, and a sparse-checkout worktree (expected:
  `gap`/`sparse_checkout_unsupported`).
- Verify the real index, staging state, branch, `HEAD`, reflogs, and working
  files are byte-for-byte unchanged after capture; verify no hooks ran and no
  commits were signed.
- Crash-safety: a capture killed mid-flight leaves no temp index behind after
  the next startup recovery, and the record settles as `gap`.
- Lifecycle: event orderings, missing events, aborts, provider failures,
  prompt rejection, restart recovery (busy, idle-with-completion, deleted
  session), and the bounded-wait path when a capture slot is contended —
  proving prompts are never blocked past the bound.
- Overlapping sessions in one worktree produce `overlap: true` on both
  records without blocking either turn.
- Setting off, non-Git projects, capture timeout, oversized-workspace guard,
  missing worktrees, deleted refs, session deletion, retention limits, and
  project clearing (including the ref-prefix guard).
- API validation: path traversal, non-recorded diff paths, refs/revisions in
  inputs, and cross-project checkpoint access are all rejected.
- Contract-test identical Web/Electron and VS Code behavior across standard
  OpenCode, Cursor, and managed orchestration prompt paths.
- UI tests for leaf-store isolation, loading/complete/warning/gap states, lazy
  diff loading, and the absence of restore controls.
- A perf smoke test on a repository with a large untracked tree, asserting
  the capture respects its timeout and the prompt proceeds.
- Update root and package codemaps plus Git, OpenCode event, VS Code, and
  chat documentation.
- Validate with `bun test packages/harness-runtime`,
  `bun run validate:full`, and `bun run build`.
