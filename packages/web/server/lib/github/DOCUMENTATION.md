# GitHub Module Documentation

## Purpose

- This module owns GitHub auth, Octokit access, repo resolution, and Pull Request status resolution for OpenChamber.
- From user perspective, this is the layer that lets the app know which PR belongs to a local branch and keeps that UI feeling current.

## Entrypoints and structure

- `packages/web/server/lib/github/index.js`: public server entrypoint.
- `packages/web/server/lib/github/routes.js`: Express route registration for `/api/github/*` endpoints.
- `packages/web/server/lib/github/auth.js`: auth storage, multi-account support, client id, scope config.
- `packages/web/server/lib/github/device-flow.js`: OAuth device flow.
- `packages/web/server/lib/github/octokit.js`: Octokit factory for the current auth.
- `packages/web/server/lib/github/api-client.js`: shared Octokit construction and timeout-aware GitHub fetch wrapper.
- `packages/web/server/lib/github/repo/index.js`: remote URL parsing and directory-to-repo resolution.
- `packages/web/server/lib/github/pr-status.js`: PR lookup across remotes, forks, and upstreams.
- `packages/web/server/lib/github/rate-limit.js`: API failure classification and shared PR-status cooldown state.
- `packages/web/server/index.js`: API route layer that calls this module.
- `packages/web/src/api/github.ts`: web client wrapper for GitHub endpoints.

## Public exports

### Auth

- `getGitHubAuth()`: current auth entry.
- `getGitHubAuthAccounts()`: all configured accounts.
- `getGitHubAuthById(accountId)`: exact stored account, including its token, for server-only request scoping.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: save or update account.
- `activateGitHubAuth(accountId)`: switch active account.
- `clearGitHubAuth()`: clear current account.
- `getGitHubClientId()`: resolve client id.
- `getGitHubScopes()`: resolve scopes.
- `GITHUB_AUTH_FILE`: auth file path.

### Device flow

- `startDeviceFlow({ clientId, scope })`: request device code.
- `exchangeDeviceCode({ clientId, deviceCode })`: poll for access token.

### Octokit

- `getOctokitOrNull()`: current Octokit or `null`.
- `getOctokitForAccount(accountId)`: Octokit for one exact stored account, with no CLI/current-account fallback.
- `createGitHubApiClient({ auth })`: construct a timeout-protected client for a selected token.
- Every GitHub HTTP request has a 15-second deadline. Device-flow requests use the same timeout wrapper.

### Repo

- `parseGitHubRemoteUrl(raw)`: parse SSH or HTTPS remote URL into `{ owner, repo, url }`.
- `resolveGitHubRepoFromDirectory(directory, remoteName)`: resolve GitHub repo from a local git remote.

## Auth storage and config

- Auth storage: `~/.config/openchamber/github-auth.json`
- Writes are atomic and file mode is `0o600`.
- Client ID resolution order: `OPENCHAMBER_GITHUB_CLIENT_ID` -> `settings.json` -> default.
- Scope resolution order: `OPENCHAMBER_GITHUB_SCOPES` -> `settings.json` -> default.
- Account id resolution order: explicit `accountId` -> user login -> user id -> token prefix.
- Standalone credential selection remains the current stored account first,
  then optional `gh` CLI token when CLI credentials are enabled. OAuth
  completion creates its verification client through the same shared factory.
- Managed principals always resolve the authoritative account id from their
  user profile; assignment values are synchronized compatibility mirrors. They
  never fall back to the host-current account or `gh` CLI credentials, never
  mutate the shared account pool through runtime status controls, and do not
  delete an assigned credential when GitHub reports an authentication failure.
- `GET /api/github/auth/status` returns `activeAccountId`. Managed requests
  derive it only from `principal.githubAccountId`, normalize that account as
  active regardless of the host-global `current` flag, and merge the live
  authenticated GitHub user over stored metadata before returning both `user`
  and `accounts`. The sidebar selects by `activeAccountId`, so a stale or absent
  stored avatar cannot replace the assigned account's current GitHub image.
- The same status route remains a metadata-only read when a managed principal
  has an assigned account but GitHub operations are disabled. It returns only
  stored public identity fields and never exercises the credential; all other
  GitHub routes remain capability-gated.
- Administrators manage the token-free host inventory through
  `GET /api/admin/github-accounts` and targeted deletes through
  `DELETE /api/admin/github-accounts/:accountId`. Assigned credentials return a
  conflict until the owning profile is explicitly unassigned.
- Managed PR creation permits an assigned writable head to target a readable
  base such as `main`; update/ready operations retain the assigned account.
  Merge is rejected before GitHub when the PR target is not one of the caller's
  assigned writable branches.

## PR integration overview

- The UI asks `github.prStatus(directory, branch, remote?)` from `packages/web/src/api/github.ts`.
- That hits `GET /api/github/pr/status` in `packages/web/server/index.js`.
- The route calls `resolveGitHubPrStatus(...)` in `packages/web/server/lib/github/pr-status.js`.
- The resolver finds the most likely repo and PR for a local branch.
- The route then enriches that result with checks, mergeability, and permission-related fields.
- The client caches and shares the result between sidebar and Git view.
- `GET /api/github/pulls/list` accepts `state=open|all`; `open` remains the default for existing pickers, while the Git view requests `all` for its repository-wide browser. Results include creation/update timestamps and are ordered by most recently updated across the resolved repository network.

## Consumers of PR data

- `packages/ui/src/components/session/SessionSidebar.tsx` reads all PR entries and maps them to `directory::branch`.
- `packages/ui/src/components/session/sidebar/SessionGroupSection.tsx` renders the compact badge, PR number, title, checks summary, and GitHub link.
- `packages/ui/src/components/views/git/PullRequestSection.tsx` uses the same shared entry for the full PR workflow.
- `packages/ui/src/components/ui/MemoryDebugPanel.tsx` reads request counters for debugging.

## How PR resolution works

- It reads local git status and remotes first.
- It ranks remotes in this order: explicit remote, tracking remote, `origin`, `upstream`, then the rest.
- It resolves those remotes into GitHub repos.
- It expands each repo through `parent` and `source` so PRs in upstream repos can still be found.
- Independent remote and repository-metadata reads run concurrently, while candidate ranking and repository deduplication remain deterministic.
- Repository metadata and default branches share one bounded five-minute cache, including the upstream route.
- It skips PR lookup when the current branch matches that repo's default branch.
- It first searches for PRs by likely source owner plus exact head branch.
- If that fails, it falls back to broader GitHub search for the branch name.
- `403` and `404` during repo lookups are treated as expected gaps, not hard errors.

## Shared client state model

- Client key is effectively `directory::branch`.
- One entry stores last known status, loading state, error, timestamps, watcher count, identity, and resolved remote.
- Requests are deduplicated by branch signature, not by component instance.
- This keeps sidebar and Git view aligned and avoids duplicated fetches.

## Persistence

- PR state is persisted in local storage under `openchamber.github-pr-status`.
- Persisted fields include status, timestamps, identity, and resolved remote.
- Runtime-only details are not persisted.
- Persisted entries expire after 12 hours.
- On reload, users get last known state first, then background refresh resumes.

## Polling and refresh model

- There are two layers: entry-level polling in `useGitHubPrStatusStore` and repo scanning in `useGitHubPrBackgroundTracking`.
- Entry-level polling decides when a known branch should revalidate PR state.
- Background tracking decides which directories and branches should even be watched.

## Entry-level polling rules

- Start watching -> immediate refresh.
- If no PR is found yet -> retry after `2s` and `5s`.
- Still no PR -> discovery refresh every `5m`.
- Open PR with pending checks -> refresh about every `1m`.
- Open PR with non-pending checks -> refresh about every `5m`.
- Open PR without a stable checks signal -> refresh about every `2m`.
- Closed or merged PR -> stop regular polling.
- Hidden tab -> skip polling.
- Non-forced refreshes use a `90s` TTL.
- A GitHub rate-limit response starts a server-side cooldown. Cached status can still be served, while uncached or forced PR-status work returns a stable `429` without making another GitHub request until the cooldown expires.

## Background tracking rules

- Track up to `50` likely directories.
- Sources are current directory, projects, worktrees, active sessions, and archived sessions.
- Active directory branch TTL is `15s`.
- Background directory branch TTL is `2m`.
- Background scan wakes every `15s`, but only fetches directories whose TTL expired.
- Each scan reads `branch`, `tracking`, `ahead`, and `behind` from git status.
- If any of those branch signals change, that branch's PR status refreshes immediately.
- After that, one more delayed refresh runs after `5s` to catch GitHub eventual consistency.

## UI refresh triggers

- App or tab becomes visible.
- Window regains focus.
- Current branch changes.
- Tracking branch changes.
- Ahead or behind changes.
- User selects a different remote in Git view.
- GitHub auth state changes.

## Action-based refreshes in Git view

- After `Create PR` -> refresh now, then after `2s` and `5s`.
- After `Merge PR` -> refresh now, then after `2s` and `5s`.
- After `Mark ready for review` -> refresh now, then after `2s` and `5s`.
- After `Update PR` -> refresh now, then after `2s` and `5s`.

## Sidebar behavior

- Sidebar shows only compact PR state.
- Aggregation is by `directory::branch`, so multiple sessions on one branch share one signal.
- If multiple entries exist, sidebar keeps the strongest visible PR state.
- Visual state is based on PR health, not merge permissions.

## Git view behavior

- Git view watches one branch directly.
- It supports create, edit, mark ready, and merge.
- It can probe alternate remotes so fork-heavy setups still find the right PR.
- It uses the same shared store as the sidebar.

## Failure handling

- If GitHub is disconnected, API returns `connected: false`.
- Authentication failures and rate limits are classified separately; a rate limit never removes the active stored account.
- If a repo is private or inaccessible, resolver calls may quietly return no PR.
- If a watched directory disappears, PR resolution stops before local remote or GitHub work begins.
- Sidebar stays quiet on missing or inaccessible PR state.
- Git view is where explicit PR-level problems should be shown.

## Notes for contributors

- Keep the UI calm. Do not add noisy diagnostics to the sidebar.
- Prefer shared state over per-component fetches.
- Prefer event-shaped refreshes over blind frequent polling.
- Prefer correctness for fork and multi-remote setups over assuming `origin` is enough.
- Device flow handles GitHub `authorization_pending` at caller level.
- Repo parser supports `git@github.com:`, `ssh://git@github.com/`, and `https://github.com/`.
