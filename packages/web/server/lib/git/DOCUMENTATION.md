# Git Module Documentation

## Purpose
This module provides Git repository operations for the web server runtime, including repository management, branch/worktree operations, status/diff queries, commit handling, direct commit-message generation, conventional commit template setup, and merge/rebase workflows.

Managed callers are additionally constrained by the multi-user layer: worktree creation and commit reintegration must target a logical assigned branch, while durable chat/schedule targets use the shared branch-target resolver to reuse or create the correct checkout without switching the repository root. User-triggered worktree creation and retries require `createWorktrees`; direct branch creation and new-branch worktrees additionally require `createBranches`. Automatic assigned-branch target preparation remains available.

## Entrypoints and structure
- `packages/web/server/lib/git/`: Git module directory containing all Git-related functionality.
  - `index.js`: Public API entry point imported by `packages/web/server/index.js`.
  - `routes.js`: Express route registration for `/api/git/*` endpoints.
  - `template-routes.js`: Conventional commit template and global `commit-msg` hook setup routes.
  - `service.js`: Core Git operations (repository, branch, worktree, commit, merge/rebase, status/diff, log).
  - `@openchamber/harness-runtime/lib/git-post-checkout-hook.js`: Shared bounded post-checkout hook execution used by web/Electron and VS Code.
  - `integrate.js`: Server-owned commit reintegration, temporary worktree lifecycle, conflict continuation, and the `isIntegrateTempPath` predicate that keeps those worktrees out of managed-project registration.
  - `commit-message.js`: Session-free commit-subject prompt, normalization, validation, and direct Zen utility-model generation.
  - `commit-message-context.js`: Bounded host-side status, history, and selected-file diff collection for commit-message drafts.
  - `credentials.js`: Git credentials management.
  - `identity-storage.js`: Git identity storage under `OPENCHAMBER_DATA_DIR` with mode-`0600` atomic writes.

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Check if a directory is a Git repository.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check if local Git identity is configured.
- `setLocalIdentity(directory, profile)`: Set local Git identity (userName, userEmail, authType, sshKey/host).
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.

### Status and Diff Operations
- `getStatus(directory)`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state.
- Background status reads set `GIT_OPTIONAL_LOCKS=0`, preventing Git's optional index refresh from racing worktree population or other index writers.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree.
- `getRangeDiff(directory, { base, head, path, contextLines })`: Get diff between two refs.
- `getRangeFiles(directory, { base, head })`: Get list of changed files between two refs.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs).
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath)`: Revert a file to HEAD state.
- `stageFile(directory, filePath)`: Stage a file into the Git index.
- `unstageFile(directory, filePath)`: Remove a file from the Git index while preserving working tree changes.

### Branch Operations
- `getBranches(directory)`: Get list of local and remote branches (filtered to active remote branches); non-Git directories return an empty branch response without logging stack traces.
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
- `getRemotes(directory)`: Get list of configured remotes.

### Worktree Operations
- `getWorktrees(directory)`: List all git worktrees for a repository.
- `getPrimaryWorktreeRoot(directory)`: Resolve the primary worktree root for a repository or linked worktree without going through generic command execution.
- `validateWorktreeCreate(directory, input)`: Validate worktree creation parameters (mode, branchName, startRef, upstream config).
- `createWorktree(directory, input)`: Create a new worktree through the shared
  durable receipt state machine. The caller may provide `idempotencyKey`; the
  response preserves the legacy fields and adds `operationId` plus `bootstrap`.
  The resolved directory is a second single-flight key, so equivalent requests
  join one operation and conflicting requests return
  `409 WORKTREE_DIRECTORY_BUSY`.
- `getWorktreeBootstrapStatus(directory)`: Resolve the latest receipt by
  directory. A receipt-less existing workspace directory (including a legacy
  Git worktree or non-Git project) returns `not_applicable`; a missing directory
  returns 404 rather than claiming readiness.
- `getWorktreeBootstrapOperation(operationId)`,
  `listActiveWorktreeBootstrapOperations()`, and
  `retryWorktreeBootstrapOperation(operationId)`: durable reconnect/retry
  operations mirrored by VS Code.
- `removeWorktree(directory, input)`: Remove a worktree (optionally delete local branch). Removal reserves the directory and fails with `409 WORKTREE_DIRECTORY_BUSY` while setup or another maintenance operation is active.
- `isLinkedWorktree(directory)`: Check if directory is a linked worktree (not primary).

### Commit and Remote Operations
- `commit(directory, message, options)`: Create a commit (supports addAll, specific files, amend, or staged-only commits).
- `pull(directory, options)`: Pull changes from remote.
- `push(directory, options)`: Push changes to remote (auto-sets upstream if needed).
- `fetch(directory, options)`: Fetch changes from remote.

Managed multi-user requests take their author identity and exact GitHub token
from the authoritative request principal. Managed directories may be the real
repository root or any path inside that repository's shared OpenCode worktree
container. Pull and push use the worktree's actual checked-out branch. Fetch
uses that branch by default and may fetch another exact `origin` branch for an
Update-tab merge/rebase when the branch is assigned to the same managed project;
managed administrators may fetch any valid `origin` branch. Managed remote
operations reject alternate remotes and never fall back to host-current GitHub
credentials. Branch listings and ordinary merge/rebase sources remain
presentation-filtered; cross-branch reintegration is separately target-grant
authorized before Git runs.

### Commit Reintegration

- `POST /api/git/integrate/plan` computes the patch-unique ordered commits for a source/target pair.
- `POST /api/git/integrate/start` recomputes the plan authoritatively and cherry-picks through a server-owned temporary worktree.
- `POST /api/git/integrate/in-progress`, `/conflict-details`, `/continue`, and `/abort` resume only server-registered operations and re-check the target branch grant on every request.
- Conflict registrations are count- and TTL-bounded; a server restart safely invalidates stale browser state.

### Commit Message Generation
- `POST /api/git/commit-message/draft`: Accept `{ selectedFiles, stagedOnly, guidance?, zenModel? }`, collect authoritative Git context in the host, and return the shared workflow result `{ status, commits, message?, warnings? }`. Status and six recent subjects are loaded concurrently; up to 200 unique validated paths use at most two batched one-context-line diffs with a 16,000-character combined patch budget.
- `POST /api/git/commit-message`: Compatibility route that accepts bounded, pre-collected worktree context plus optional wording guidance and returns `{ message: { subject, highlights } }`.
- Generation uses a cached free Zen model through the direct `opencode.ai/zen` API under a 20-second end-to-end deadline. A slow or unavailable model enters a five-minute cooldown so later requests use another cached candidate or skip directly to the local fallback; one Generate action never waits for a second provider attempt. The flow never creates, prompts, switches, or deletes an OpenCode session.
- Chat-completion requests are capped at 220 tokens with hidden reasoning disabled; compatible Responses requests are capped at 256 output tokens. The compact JSON response contains a Conventional Commit subject and two to four details.
- Shared runtime policy repairs otherwise-valid overlong subjects at a word boundary. Invalid, timed-out, or unavailable AI output becomes a deterministic factual draft derived from selected paths, statuses, and line statistics. Responses disclose fallback or partial context through `warnings` while still returning a usable draft.
- Both routes are read-only for managed mutation-lock purposes, while authentication, CSRF, workspace containment, and Git policy checks still apply. Sanitized phase timings are written to the diagnostic journal, and web responses expose context/model/provider/parsing durations through `Server-Timing`.
- Route registration accepts an injected direct generator for deterministic contract tests; production defaults to `generateCommitMessageDirect`.
- Subjects must match the repository Conventional Commit types, remain at or below 72 characters, and omit trailing punctuation. Highlights are inserted as commit-body bullets. The route does not stage, commit, or otherwise mutate Git state.

### Pull Request Description Generation
- `POST /api/git/pr-description` accepts the already-rendered Generate PR instructions plus base/head metadata and returns `{ title, body }`.
- The route calls the live zero-cost Zen catalog directly, tries every model sequentially with a 15-second timeout per model, and accepts the first valid title/body JSON object.
- Generation never creates, prompts, polls, switches, or deletes an OpenCode session and never resolves the user's selected/default chat model. Exhausting the free catalog returns an error without changing the caller's draft fields.
- `removeRemote(directory, options)`: Remove a configured remote (except `origin`).
- `deleteRemoteBranch(directory, options)`: Delete a remote branch.

### Conventional Commit Template Routes
- `GET /api/git/commit-template/status`: Report whether the managed global commit template and hook are installed and configured.
- `POST /api/git/commit-template/install`: Write the managed template/hook under `~/.config/git` and configure global `commit.template` / `core.hooksPath`.
- `POST /api/git/commit-template/uninstall`: Remove the global git config pointers while leaving user-owned files on disk.
- `GET /api/git/commit-template/content`: Return the installed template content or the built-in template fallback.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters). The default current-branch log includes both local `HEAD` and the tracked upstream tip when upstream exists, so behind/ahead histories can show both positions.
- `getCommitFiles(directory, commitHash)`: Get file changes for a specific commit.

### Merge and Rebase Operations
- `rebase(directory, options)`: Start a rebase onto a target branch.
- `abortRebase(directory)`: Abort an in-progress rebase.
- `continueRebase(directory)`: Continue a rebase after conflict resolution.
- `merge(directory, options)`: Merge a branch into current branch.
- `abortMerge(directory)`: Abort an in-progress merge.
- `continueMerge(directory)`: Continue a merge after conflict resolution.
- `getConflictDetails(directory)`: Get detailed conflict information including operation type, unmerged files, and diff.

### Stash Operations
- `listStashes(directory)`: List stash entries with ref, message, relative time, and hash.
- `countStashFiles(directory, refs)`: Batch-count changed files for stash refs with bounded concurrency.
- `stashPush(directory, options)`: Stash changes, always including untracked files, with optional message.
- `stashApply(directory, options)`: Apply a stash by ref without removing it.
- `stashPop(directory, options)`: Apply a stash by ref and drop it only after a successful apply.
- `stashDrop(directory, options)`: Drop a stash by ref.

## Internal Helpers

The following functions are internal helpers used by exported functions:
- `buildSshCommand(sshKeyPath)`: Build SSH command string for git config.
- `buildGitEnv()`: Build Git environment with SSH_AUTH_SOCK resolution.
- `createGit(directory)`: Create simple-git instance with environment.
- `createGlobalConfigGit()`: Create the dedicated global-config client from a
  stable existing directory; repository clients always require a non-empty
  project directory.
- `normalizeDirectoryPath(value)`: Normalize directory paths (supports ~ expansion).
- `cleanBranchName(branch)`: Remove refs/heads/ or refs/ prefixes.
- `parseWorktreePorcelain(raw)`: Parse `git worktree list --porcelain` output.
- `resolveWorktreeProjectContext(directory)`: Resolve project context (projectID, primaryWorktree, worktreeRoot).
- `resolveCandidateDirectory(...)`: Generate unique worktree directory candidates.
- `resolveBranchForExistingMode(...)`: Resolve branch for existing-mode worktree creation.
- `applyUpstreamConfiguration(...)`: Set upstream tracking for new branches.
- And various other internal helpers for Git command execution and parsing.

## Response Contracts

### Status Response
- `current`: Current branch name.
- `tracking`: Upstream branch (e.g., 'origin/main').
- `ahead`: Number of commits ahead of upstream.
- `behind`: Number of commits behind upstream.
- `files`: Array of file objects with `path`, `index`, `working_dir` status codes.
- `isClean`: Boolean indicating if working tree is clean.
- `diffStats`: Object mapping file paths to `{ insertions, deletions }`.
- `mergeInProgress`: Object with `{ head, message }` if merge in progress.
- `rebaseInProgress`: Object with `{ headName, onto }` if rebase in progress.

### Worktree Create/Remove Response
- `head`: HEAD commit SHA.
- `name`: Worktree name.
- `branch`: Local branch name.
- `path`: Absolute path to worktree directory.
- `operationId`: Opaque durable bootstrap operation ID.
- `bootstrap`: Current receipt with per-stage status/timestamps/errors,
  warnings, attempt number, and tombstone state.

Synchronous stages are `prepare_remote`, `create_worktree`, and
`sync_project_metadata`. Population, post-checkout hook execution, upstream
configuration, project setup, and requested setup continue asynchronously.
Metadata/upstream failures can settle as `ready_with_warnings`; known setup
failures are `failed`; setup interrupted by process exit becomes
`needs_attention` and is rerun only after explicit Retry.

Immediately after successful population, the shared runner resolves the
effective Git hooks path. A configured global `core.hooksPath` intentionally
shadows repository-local hooks, matching Git. Missing hooks are skipped. An
existing hook requires Git 2.36+ and runs exactly once through
`git hook run --ignore-missing post-checkout -- 0000000000000000000000000000000000000000 <HEAD> 1`
with the worktree as `cwd`. Execution is time-bounded; nonzero, timeout, or
interruption failures do not let setup continue. Captured failure output is
bounded and sanitized before entering the durable version 3 receipt. Legacy
terminal receipts migrate with the new stage skipped, so upgrades never run a
historical hook retroactively.

The `populate_worktree` stage performs one bounded recovery when Git reports an
`index.lock` collision or cannot finalize a new index file. It resolves the
worktree-specific lock through Git, waits briefly, and removes the lock only
when its filesystem identity remains unchanged. A replacement lock is
preserved. When Git reports only the generic index-finalization failure and the
lock is already gone, the stage still retries once because the competing writer
may have just completed. Before replaying population, the stage checks `HEAD`,
status, and the Git index: populated worktrees are preserved rather than reset
destructively, while a fresh `--no-checkout` worktree with an empty index still
receives its initial checkout. Web/Electron and VS Code use the same policy.

Terminal bootstrap receipts replay only when the idempotency key and request
fingerprint still match. Reusing that key for a changed request supersedes the
old terminal receipt and starts a fresh operation; queued or running receipts
remain conflict-protected.

Pull, merge, rebase, stash, and commit classify Git's unmerged-index and
conflict responses into stable HTTP 409 results with conflict files where Git
can provide them. Filesystem writes and deletes share the same per-directory
mutation lock as Git operations so API-driven edits cannot race a merge.

### Primary Worktree Root Response
- Route: `GET /api/git/worktree-root?directory=<path>`
- Response: `{ "root": "<absolute primary worktree path>" }`

### Log Response
- `all`: Array of commit objects with hash, date, message, author info, stats, and sync metadata when available. For the default current-branch log with an upstream, this includes commits reachable from either local `HEAD` or the upstream tip.
- `latest`: Latest commit object or null.
- `total`: Total number of commits.
- `hasUpstream`: Whether the default log was computed against a tracked upstream.
- Commit sync metadata on default branch logs:
  - `syncStatus`: Whether the commit is present on the tracked upstream (`remote`) or only local (`local`).
  - `isHead`: Whether the commit is local `HEAD`.
  - `isRemoteHead`: Whether the commit is the tracked upstream tip.
  - `isSyncPoint`: Whether the commit is the merge-base between local `HEAD` and the tracked upstream.

## Notes for Contributors

### Adding a New Git Operation
1. Add the function to `packages/web/server/lib/git/service.js`.
2. Export the function if it's part of the public API.
3. Use `createGit(directory)` to get a simple-git instance with the correct environment.
4. Use `runGitCommand(cwd, args)` for direct git command execution with better error handling.
5. Use `runGitCommandOrThrow(cwd, args, fallbackMessage)` for commands that must succeed.
6. Return consistent error messages; use `parseGitErrorText(error)` to extract meaningful git errors.
7. Update this file with the new function in the appropriate API section.

### SSH Key Handling
- SSH keys are escaped and validated via `escapeSshKeyPath` to prevent command injection.
- On Windows, paths are converted to MSYS format (`C:/path` → `/c/path`).
- SSH_AUTH_SOCK is automatically resolved via `resolveSshAuthSock` (checks GPG agent, gpgconf).

### Worktree Naming
- Worktree names are slugified via `slugWorktreeName`.
- Random names use adjectives/nouns from `OPENCODE_ADJECTIVES` and `OPENCODE_NOUNS` lists.
- Branches created for new worktrees use `openchamber/<worktree-name>` pattern.

### Cross-Platform Considerations
- Use `normalizeDirectoryPath` for all directory inputs to handle `~` and path separators.
- Use `canonicalPath` for path comparisons to handle case-insensitive filesystems (Windows).
- Windows Git commands use MSYS/MinGW paths; avoid direct Windows paths in git commands.

### Error Handling
- All exported functions should throw errors with descriptive messages.
- Use `console.error` for logging Git operation failures.
- Missing-directory errors during status collection remain rejections but are
  not logged because project deletion is an expected race.
- Repository checks and status collection require the requested project
  directory itself to be the Git worktree root. A nested non-repository project
  never inherits Git state from an ancestor repository.
- Return structured objects for operations that need partial success reporting (e.g., merge/rebase conflicts).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Consider edge cases: non-Git directories, missing remotes, conflict states, concurrent worktree operations.
