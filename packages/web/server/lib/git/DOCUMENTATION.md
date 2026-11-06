# Git Module Documentation

## Purpose
This module provides Git repository operations for the web server runtime, including repository management, branch/worktree operations, status/diff queries, commit handling, direct commit-message generation, conventional commit template setup, and merge/rebase workflows.

Managed callers are additionally constrained by the multi-user layer: worktree creation and commit reintegration must target a logical assigned branch, while durable chat/schedule targets use the shared branch-target resolver to reuse or create the correct checkout without switching the repository root. User-triggered worktree creation and retries require `createWorktrees`; direct branch creation and new-branch worktrees additionally require `createBranches`. Automatic assigned-branch target preparation remains available.

## Entrypoints and structure
- `packages/web/server/lib/git/`: Git module directory containing all Git-related functionality.
  - `index.js`: Public API entry point imported by `packages/web/server/index.js`.
  - `routes.js`: Express route registration for `/api/git/*` endpoints.
  - `template-routes.js`: Conventional commit template and global `commit-msg` hook setup routes.
  - `operation-state.js`: Shared per-worktree Git operation and HEAD state reader, plus remote-operation preconditions.
  - `service.js`: Core Git operations (repository, branch, worktree, commit, merge/rebase, status/diff, log).
  - `@devryan/harness-runtime/lib/git-post-checkout-hook.js`: Shared bounded post-checkout hook execution used by web/Electron.
  - `integrate.js`: Server-owned commit reintegration, temporary worktree lifecycle, conflict continuation, and the `isIntegrateTempPath` predicate that keeps those worktrees out of managed-project registration.
  - `commit-message.js`: Session-free commit-subject prompt, normalization, validation, and direct Zen utility-model generation.
  - `commit-message-context.js`: Bounded host-side status, history, and selected-file diff collection for commit-message drafts.
  - `credentials.js`: Git credentials management.
  - `identity-storage.js`: Git identity storage under `DEVRYAN_DATA_DIR` with mode-`0600` atomic writes.
  - `ssh-command.js`: `sshCommandKeyPath`, which reads the key path back out of a `core.sshCommand` value (see [Local identity profiles](#local-identity-profiles)).

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Check if a directory is a Git repository.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check if local Git identity is configured.
- `setLocalIdentity(directory, profile)`: Set local Git identity (userName, userEmail, authType, sshKey/host); see [Local identity profiles](#local-identity-profiles).
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.

### Status and Diff Operations
- `getStatus(directory)`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state.
- Status reads set `GIT_OPTIONAL_LOCKS=0`, preventing Git's optional index refresh from racing worktree population or other index writers.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree.
- `getRangeDiff(directory, { base, head, path, contextLines })`: Get diff between two refs.
- `getRangeFiles(directory, { base, head })`: Get list of changed files between two refs.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs).
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath)`: Revert a file to HEAD state.
- `stageFile(directory, filePath)`: Stage a file into the Git index.
- `unstageFile(directory, filePath)`: Remove a file from the Git index while preserving working tree changes.

### Branch Operations
- `getBranches(directory, { remote = 'local' })`: List local and remote-tracking branches as `{ all, current, branches }`; `remotes/<remote>/HEAD` is always excluded from `all`, and non-Git directories return an empty branch response without logging stack traces.
  - `local` (default, every routine listing) reads refs on disk only: no credentials, no askpass helper, no `ls-remote`, so it performs no network operation.
  - `live` loads Git credentials and drops remote-tracking refs that `ls-remote --heads` no longer reports, keeping known refs for any remote that cannot be probed. It never fetches.
  - `GET /api/git/branches?directory=…&remote=live` selects live mode only for exactly `remote=live`; any other or missing value is local. In the UI only the New Worktree dialog's "Fetch Branches" action requests live (`GitAPI.getGitBranches(directory, { remote: 'live' })`, `useGitStore.fetchBranches(directory, git, { remote: 'live' })`). The store applies results only from the newest request per directory, and routine reads made during a live listing join it.
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
  operations.
- `removeWorktree(directory, input)`: Remove a worktree (optionally delete local branch). Removal reserves the directory and fails with `409 WORKTREE_DIRECTORY_BUSY` while setup or another maintenance operation is active.
- `isLinkedWorktree(directory)`: Check if directory is a linked worktree (not primary).

### Commit and Remote Operations
- `commit(directory, message, options)`: Create a commit (supports addAll, specific files, amend, or staged-only commits).
- `pull(directory, options)`: Pull changes from remote.
- `push(directory, options)`: Push directly to the remote (auto-sets upstream if needed) with `--porcelain --no-verify`. All app-issued pushes, including managed pushes, upstream retries and remote-branch deletion, skip local pre-push hooks per command; repository/global Git configuration and terminal Git behavior are unchanged. Porcelain `!` rows are collected into `rejected[]` (stdout is kept even when Git exits non-zero); any rejected ref throws HTTP 409 `GIT_PUSH_REJECTED` with `rejected` and `pushed`, while accepted refs of a multi-ref push still land. Non-ref failures use HTTP 500 `GIT_PUSH_FAILED` with bounded, credential-scrubbed message and `details` (last ~60 lines). Generic Git failures are never inferred to be local hook failures. Remote-resolution config lookups run concurrently. Server-side hooks and branch policies remain enforced.
- Shared UI **Push** and **Commit & Push** call the direct push API without fetching, pulling/rebasing or reading synchronization status first. **Sync** and **Commit & Sync** retain fetch → pull/rebase when needed → push. Behind-branch rejections direct the user to Sync and resolve conflicts before retrying; no automatic force-push or rejected-push retry occurs. Status/history refresh after attempts, and a failed Commit & Push keeps the local commit for retry.
- `fetch(directory, options)`: Fetch changes from remote.

Managed multi-user requests take their author identity and exact GitHub token
from the authoritative request principal. Managed directories may be the real
repository root or any path inside that repository's shared OpenCode worktree
container. Pull and push use the worktree's actual checked-out branch. Fetch
uses that branch by default and may fetch another exact `origin` branch for an
Update-tab merge/rebase when the branch is assigned to the same managed project;
managed administrators may fetch any valid `origin` branch. Managed remote
operations reject alternate remotes and never fall back to the host's current
GitHub account. Branch listings and ordinary merge/rebase sources remain
presentation-filtered; cross-branch reintegration is separately target-grant
authorized before Git runs. The identity reaches Git as `GIT_AUTHOR_*` and
`GIT_COMMITTER_*`. Remote commands authenticate only with the principal's token,
which DevRyan's askpass helper gives only to `https://github.com`. The host's
credential helpers and askpass programs are switched off, so a managed user
without a connected GitHub account cannot authenticate to an HTTPS remote. Git
refuses SSH remotes for managed users, because they would authenticate with the
host's SSH agent and keys (see [Git child environment](#git-child-environment)).

### Commit Reintegration

- `POST /api/git/integrate/plan` computes the patch-unique ordered commits for a source/target pair.
- `POST /api/git/integrate/start` recomputes the plan authoritatively and cherry-picks through a server-owned temporary worktree.
- `POST /api/git/integrate/in-progress`, `/conflict-details`, `/continue`, and `/abort` resume only server-registered operations and re-check the target branch grant on every request.
- Conflict registrations are count- and TTL-bounded; a server restart safely invalidates stale browser state.

### Commit Message Generation
- `POST /api/git/commit-message/draft`: Accept `{ selectedFiles, stagedOnly, guidance?, sessionID? }`, collect authoritative Git context in the host, and return the shared workflow result `{ status, commits, message?, warnings? }`. Status and six recent subjects are loaded concurrently; history failure is disclosed without discarding readable changes. Up to 200 unique validated paths use batched tracked diffs and individual untracked-file diffs, with at most two concurrent Git reads and a 16,000-character combined patch budget. Untracked content is included only for unstaged scope, without staging files.
- `POST /api/git/commit-message`: Compatibility route that accepts bounded, pre-collected worktree context plus optional wording guidance and returns `{ message: { subject, highlights } }`.
- Both routes use `helperModelSelection` from Settings → Agents → Session Defaults (the Helper Model). The default is `opencode/deepseek-v4.1-flash` with Default reasoning (no native variant); a saved reasoning `variant` is forwarded. `zen-text.js` passes the resolved selection object to `generateTextWithSessionModel({ selection })`, which maps the exact tuple, variant and revision into native helper admission with the existing commit/PR purpose; it resolves/rechecks the effective setting within the owned scope. Tools remain empty and input/output bounded. The selected chat model is unchanged. The same Helper Model also drives always-on notification summaries through the hidden `devryan-notify` role (see `lib/notifications/DOCUMENTATION.md`).
- The compact JSON response contains a Conventional Commit subject and two to four details. Native OpenCode owns provider-specific inference options; the retained injectable standalone transport uses 220 Chat Completions / 256 Responses output-token caps for compatibility tests.
- Shared runtime policy repairs otherwise-valid overlong subjects at a word boundary. Production disables local factual fallback. After a settled configured-helper failure, only the authorized canonical active session identified by `sessionID` may supply a fallback, with that session's own reasoning variant. Builder configuration and request model hints cannot select it. Missing active selection produces an actionable error directing the user to Session Defaults or an accessible chat; revoked access retains its authorization refusal. An unsettled helper stops rotation. A changed configured revision returns `HELPER_SELECTION_CHANGED` with refresh guidance and does not authorize fallback. Missing capture/recheck authority refuses admission; unavailable settings retain a 503 classification.
- A failed helper draft attempt logs `[git] Helper draft attempt failed:` with only its agent, reason, HTTP status and bounded `native_*` refusal code.
- Both routes are read-only for managed mutation-lock purposes, while authentication, CSRF, workspace containment, and Git policy checks still apply. Sanitized phase timings and per-model attempts (model, sequence, duration, HTTP status, and failure category) are written to the diagnostic journal, and web responses expose context/model/provider/parsing durations through `Server-Timing`.
- Route registration accepts an injected direct generator for deterministic contract tests; production defaults to `generateCommitMessageDirect`.
- Subjects must match the repository Conventional Commit types, remain at or below 72 characters, and omit trailing punctuation. Highlights are inserted as commit-body bullets. The route does not stage, commit, or otherwise mutate Git state.

### Worktree Branch Name Generation
- `POST /api/git/branch-name?directory=…` accepts `{ prompt }` (a new chat's first message, capped at 4 000 characters) and returns `{ slug, source: 'helper_model', model }`. `branch-name.js` owns the prompt and `normalizeBranchSlug`, which reduces model output to a two-to-five-word lowercase kebab-case slug of at most 40 characters, or null.
- Only the configured helper model is used, through the hidden no-tools `devryan-branch` agent with a 6-second bound; a draft has no active session to fall back to. Any failure returns 502 `HELPER_MODEL_FAILED` (authorization refusals keep their status), and the UI then names the branch `DevRyan/<adjective-noun>`. The route does not touch Git state.
- The shared UI calls it when a new chat is sent with the composer's Worktree box ticked (`createWorktreeDraftForPrompt` in `packages/ui/src/lib/worktreeSessionCreator.ts`), then creates the worktree on branch `DevRyan/<slug>` in directory `<slug>`.

### Pull Request Description Generation
- `POST /api/git/pr-description` accepts the already-rendered Generate PR instructions plus base/head metadata and returns `{ title, body, source, selectionMode, model, attempts }`. The HTTP client preserves these fields; both commit endpoints also return `source`, `selectionMode` and the provider/model tuple. Configured selections use `source: helper_model`; active-model fallbacks use `source: session_model` and surface their model in a draft toast.
- The route adds bounded base/head diff context to the rendered prompt and tries the shared configured helper in a 45-second attempt. It accepts normalized title/body JSON or a usable plain-text draft.
- After actual settlement, the authorized canonical active model may use the existing isolated `devryan-pr` purpose and 60-second bound with that session's own reasoning variant. The UI sends only the active session ID; the server resolves the model and current grants. Missing active selection returns `HELPER_ACTIVE_MODEL_REQUIRED`; revoked access retains its authorization refusal; an unusable authorized fallback returns `SESSION_MODEL_FAILED`. Sanitized model attempt evidence remains available. Generation does not publish a PR.
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
- `buildGitEnv()`: Build the Git child environment (see [Git child environment](#git-child-environment)).
- `createGit(directory)`: Create a simple-git instance whose Git children receive that environment.
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
receives its initial checkout. Web/Electron use the same policy.

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

### Git child environment

`buildGitEnv(directory, options)` copies the server's `process.env`, drops any
inherited `DEVRYAN_GIT_ASKPASS_TOKEN`, and changes only these variables:

- `GIT_OPTIONAL_LOCKS=0` with `optionalLocks: false` (status reads).
- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
  `GIT_COMMITTER_EMAIL` for a managed request principal: its GitHub account's
  name and email, otherwise the principal's own.
- Credential isolation, for a managed request principal and for any call that
  attaches a token: inherited `GIT_ASKPASS` and `SSH_ASKPASS` are dropped,
  `GIT_TERMINAL_PROMPT=0` is set,
  `'credential.helper=' 'core.askPass=' 'protocol.ssh.allow=never'` is appended
  to `GIT_CONFIG_PARAMETERS` after any inherited entries, and `ssh` is removed
  from an inherited `GIT_ALLOW_PROTOCOL`.
- `GIT_ASKPASS` (DevRyan's helper) and `DEVRYAN_GIT_ASKPASS_TOKEN` with
  `includeCredentials`, when the managed principal's GitHub account (or an
  explicit `githubAccountId` for durable provisioning retries) has a token.
  The helper gives the token only to `https://github.com` (see below).
  Unmanaged requests never receive a token and keep the host's credential
  helpers and inherited askpass programs.
- `SSH_AUTH_SOCK` from the gpg-agent SSH socket when the server has none.

Git asks every configured credential helper before any askpass program, then
passes the credential that worked to each helper's `store` (a rejected one to
`erase`). `GIT_CONFIG_PARAMETERS` is how Git passes `git -c` settings to its own
children, such as `git-remote-https`. The empty `credential.helper` clears every
configured helper (system, global, URL-scoped and repository), and the empty
`core.askPass` stops Git falling back to `SSH_ASKPASS`. So a managed HTTPS
operation authenticates only with the principal's token: the host's keychain,
`gh` or Git Credential Manager never answers for it or receives its token, and a
managed user without a connected account cannot authenticate. The commands that
request credentials are push, pull, fetch, live branch listings, worktree
provisioning fetches, worktree validation's `ls-remote` checks, reintegration's
target fetch, `POST /api/fs/clone` ([clone
credentials](../fs/DOCUMENTATION.md#clone-credentials)) and a managed
principal's skills catalog scans and installs ([managed
principals](../skills-catalog/DOCUMENTATION.md#managed-principals)). Worktree setup commands
and the post-checkout hook get the same environment, so Git that they start for
a managed user is isolated too, without a token.

DevRyan's askpass helper (`runtime/git-askpass` in the data root,
`git-askpass.cmd` on Windows) contains no token; it reads
`DEVRYAN_GIT_ASKPASS_TOKEN`. It answers only Git's username and password prompts
for `https://github.com`, with `x-access-token` and the token. Git's prompt names
the URL the credential is for, after `url.*.insteadOf` rewrites and redirects,
and the helper fails every prompt for another host, a port, plain HTTP, a proxy
or a client certificate. Git then sends no credential and fails with
`error: unable to read askpass response` and
`could not read Username for '<url>'`. So a remote, submodule or clone URL
outside GitHub never receives a managed user's token. The host may be written in
any letter case. With `credential.useHttpPath` the prompt also names the path.
The helper refuses a username or path that contains `@`: Git versions that print
the username undecoded would otherwise let one such as
`x-access-token@github.com/x` pass for github.com. On Windows the helper answers
only `Username for 'https://github.com': ` and
`Password for 'https://x-access-token@github.com': `.

`protocol.ssh.allow=never` makes Git refuse the SSH transport with
`fatal: transport 'ssh' not allowed`. Git checks it after `url.*.insteadOf` and
`pushInsteadOf` rewrites and before it starts ssh, so no managed operation
reaches the host's SSH agent (inherited, or the gpg-agent socket above), the
host's `~/.ssh` keys and configuration, or the key in a `core.sshCommand`.
`GIT_CONFIG_PARAMETERS` is read after `GIT_CONFIG_COUNT`, so it also overrides
inherited pairs. An inherited `GIT_ALLOW_PROTOCOL` would replace every
`protocol.*.allow` setting, so it loses `ssh` and keeps the rest. A managed
project whose origin is an SSH URL therefore needs an HTTPS `remoteUrl`; project
registration stores `git@github.com:` and `ssh://git@github.com/` origins as
their `https://github.com/` URL. Without one, its push, pull and fetch fail, and
live listings keep the remote-tracking refs they could not verify. The same
applies to a host `insteadOf` that rewrites HTTPS to SSH, a managed clone of an
SSH URL, and SSH remotes that setup commands fetch from, such as `git+ssh`
dependencies. Unmanaged Git keeps the SSH transport.

Not covered: credentials embedded in a remote URL or sent by `http.extraHeader`;
commit signing, which uses the host's signing key and agent when the host's
configuration enables it; ssh started by programs other than Git, such as Git
LFS for an SSH remote or a setup command; and `ext::` and other remote-helper
transports (such as `codecommit::`), which run host programs with the host's own
credentials (`ext::` only when the host's configuration allows it).

`runGitCommand` passes the environment to `execFile`. `createGit` passes it with
simple-git's `.env()`: simple-git ignores an `env` constructor option, and
`.env()` replaces the child's environment, so the complete set is passed; add a
variable to one instance with `git.env(name, value)`. simple-git refuses editor,
pager, askpass, SSH-command and config-path variables unless the matching
`unsafe` option is set. Each one present, inherited or DevRyan's, enables only
its own option (`SCREENED_GIT_ENV_OPTIONS`), so Git keeps seeing the server
environment it inherits; a new variable that simple-git screens needs an entry
there. Inherited `GIT_CONFIG_COUNT` pairs that set a key simple-git screens,
such as `core.sshCommand`, are still refused. simple-git also refuses `-c`
arguments and `GIT_CONFIG_COUNT` pairs that name `credential.helper` or
`protocol.*.allow` unless `allowUnsafeCredentialHelper` or
`allowUnsafeProtocolOverride` is set, which would allow that key in every
argument of the instance. It does not screen `GIT_CONFIG_PARAMETERS` or
`GIT_ALLOW_PROTOCOL`, so credential isolation needs no `unsafe` option. If a
simple-git upgrade starts screening them, managed Git is refused and
`service.git-credentials.test.js` and `service.git-ssh.test.js` fail.
simple-git's debug output (`DEBUG=simple-git*`) shows the environment as
variable names, never values.

Regression tests: `service.git-env.test.js` records each Git child's environment
through a `git` wrapper first on `PATH`. `service.git-askpass.test.js` runs the
askpass helper with Git's prompts, directly and through `git credential fill`.
`service.git-credentials.test.js` serves a repository through
`git http-backend` at `https://github.com` and at `https://git.example.test`,
adds fake host credential helpers and askpass programs, and checks which
credential authenticates each managed and unmanaged operation;
`../fs/routes.clone-credentials.test.js` does the same for `POST /api/fs/clone`,
and `../skills-catalog/git.managed-credentials.test.js` for the skills catalog's
scan, install and catalog source routes at `https://github.com`.
They reach the hosts through `test-https-hosts.js`, a CONNECT proxy on
127.0.0.1 that terminates TLS with a throwaway certificate (made with the
`openssl` command-line tool), so Git formats its prompts for the real host names
and nothing leaves the machine. `service.git-ssh.test.js` puts a fake `ssh`
first on `PATH`. It records the agent socket and key Git hands it and serves a
local bare repository. The test checks that managed operations never start
ssh, whatever the host's agent, identity profile, URL rewrite or
`GIT_ALLOW_PROTOCOL`, and that unmanaged operations keep the host's agent.

### Local identity profiles

`setLocalIdentity(directory, profile)` builds the profile's SSH command before
any write, so a key path that `escapeSshKeyPath` refuses changes nothing. It
writes `user.name` and `user.email` to the repository's local config, then the
profile's authentication:

- `authType: 'ssh'` with `sshKey`: sets `core.sshCommand` to
  `buildSshCommand(sshKey)` and unsets `credential.helper`.
- `authType: 'token'` with `host`: sets `credential.helper` to `store` and unsets
  `core.sshCommand`.

simple-git refuses to set or unset either key, `--unset` included, unless the
instance enables `allowUnsafeSshCommand` and `allowUnsafeCredentialHelper`.
Only the `setLocalIdentity` instance enables them
(`createGit(directory, { authConfigWrites: true })`); its values are fixed or
validated by `escapeSshKeyPath`. An unset of a key that is not set is ignored.

`POST /api/git/set-identity` with `profileId: 'global'` builds the profile from
the global `user.name`, `user.email` and `core.sshCommand`. Its `sshKey` is
`sshCommandKeyPath(sshCommand)`: the command is read as the shell reads it, and
only `ssh -i <key>`, alone or with `-o IdentitiesOnly=yes` and in any quoting,
gives the exact key path, with a leading `~/` expanded under HOME as ssh does.
Any other command (another program or option, a shell expansion, another
user's `~`) gives no key, so the repository's local authentication config is
left as it was, and without a local `core.sshCommand` the global command keeps
applying. A key path that `escapeSshKeyPath` refuses stays the profile's key,
so applying it fails and writes nothing. `POST /api/fs/clone` with
`gitIdentityId: 'global'` builds the same profile (`resolveCloneGitIdentity` in
`lib/fs/routes.js`, see the [FS module](../fs/DOCUMENTATION.md#clone-with-a-git-identity)).

Regression tests: `service.local-identity.test.js` applies both profile types to
a real repository and reads its local config back. `routes.global-identity.test.js`
applies the global profile for each global command form to a real repository
with a stub HOME, and `ssh-command.test.js` lists the forms `sshCommandKeyPath`
reads and refuses.

### SSH Key Handling
- SSH keys are escaped and validated via `escapeSshKeyPath` to prevent command injection.
- `sshCommandKeyPath` reads a key path back out of a `core.sshCommand` without validating it; the path still goes through `escapeSshKeyPath` before a profile writes it, and through `escapeCloneSshKeyPath` (`lib/fs/routes.js`) before a clone uses it.
- On Windows, paths are converted to MSYS format (`C:/path` → `/c/path`).
- SSH_AUTH_SOCK is automatically resolved via `resolveSshAuthSock` (checks GPG agent, gpgconf). Managed Git never authenticates with it: Git refuses SSH remotes for managed users (see [Git child environment](#git-child-environment)).

### Worktree Naming
- Worktree names are slugified via `slugWorktreeName`.
- Random names use adjectives/nouns from `OPENCODE_ADJECTIVES` and `OPENCODE_NOUNS` lists.
- Branches created for new worktrees use `devryan/<worktree-name>`; existing `openchamber/*` branches remain valid.

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

### Rebase recovery and remote preconditions

Status, conflict details, and worktree attention use Git's `--absolute-git-dir`
to read per-worktree metadata, including linked worktrees whose `.git` is a file.
Both `rebase-merge` and `rebase-apply` count as active even when optional branch
or target metadata is absent. Status adds `headState` (`branch`, `detached`, or
`unborn`) without replacing `current`, `mergeInProgress`, or `rebaseInProgress`.

`POST /api/git/push` still strips an optional body `progressID` so older clients
keep working; it is never passed to Git and no longer broadcasts progress events.
The route sets no deadline of its own; Git owns the transport operation. `sendGitError` forwards `details` the same way it forwards `rejected`.

Push and pull reject an active rebase with HTTP 409 `GIT_REBASE_IN_PROGRESS`,
and a detached HEAD without a rebase with HTTP 409 `GIT_DETACHED_HEAD`, before
remote commands. Managed credential and branch restrictions remain in place.
Rebase and merge continuation add only the fixed noninteractive editor
(`GIT_EDITOR=true`) to the normal Git environment. Rebase continuation
propagates failed commands, never implicitly skips an empty patch, and checks
that rebase metadata is gone before returning completion. The UI invalidates cached status
after operation attempts and guards push synchronization before fetch and after
pull, including a pull conflict paired with a stale status response.

Regression tests: `operation-state.test.js` (real Git and routes), UI
`gitApi.test.ts`, and the `tests/visual-git-rebase/` presentation fixture.
