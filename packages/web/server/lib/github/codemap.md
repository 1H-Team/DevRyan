# packages/web/server/lib/github/

## Responsibility
GitHub integration boundary: account auth storage/activation, OAuth device flow, Octokit client creation, and repository URL resolution.

## Design
- **Barrel exports** (`index.js`) expose stable GitHub operations to the rest of server runtime.
- **Auth split**:
  - `auth.js`: persisted auth accounts/tokens, standalone active-account
    switching, profile-scoped managed reads, and exact internal removal
  - `device-flow.js`: OAuth device-code start/exchange
- `api-client.js` creates every authenticated Octokit client and supplies the shared per-request timeout fetch wrapper.
- `rate-limit.js` classifies GitHub failures and owns the shared PR-status cooldown without conflating rate limits with invalid authentication.
- **Repository parsing module** under `repo/` decouples remote URL normalization from auth logic.

## Flow
1. UI/CLI triggers login or repo inspection API route.
2. Device-flow helpers obtain tokens; standalone mode may activate one, while
   managed mode leaves new credentials unassigned for User Management.
3. `octokit.js` returns a scoped client for the managed user's profile-level
   GitHub association when auth exists.
4. Repo resolver parses git remotes to owner/repo identifiers for status/PR operations.

## Integration
- Consumed by Git routes and GitHub-specific endpoints in server runtime.
- Downstream dependency for UI GitHub settings and repo status actions.
- External integration with GitHub OAuth and REST APIs via Octokit.
