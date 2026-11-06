# Skills Catalog Module Documentation

## Purpose
This module provides skill discovery, scanning, and installation capabilities for OpenCode. It supports multiple skill sources including GitHub repositories and the ClawdHub registry, with caching and conflict resolution for skill installation.

## Entrypoints and structure
- `packages/web/server/lib/skills-catalog/`: Skills catalog module directory containing all skill-related functionality.
  - `cache.js`: In-memory cache for scan results with TTL support.
  - `curated-sources.js`: Predefined skill sources (Anthropic, ClawdHub).
  - `git.js`: Git operations helpers for cloning, auth error detection, the quoted SSH command for a Git identity's key, and the Git environment, which is isolated for managed principals.
  - `install.js`: Skills installation from GitHub repositories.
  - `scan.js`: Skills scanning from GitHub repositories.
  - `source.js`: Source string parsing for GitHub repositories.
  - `clawdhub/`: ClawdHub registry integration.
    - `index.js`: Public API exports for ClawdHub.
    - `scan.js`: Scanning ClawdHub registry with pagination.
    - `install.js`: Installation from ClawdHub (ZIP download).
    - `api.js`: ClawdHub API client with rate limiting.
- `@devryan/shared-runtime/lib/safe-archive.js`: shared web ZIP download, preflight, extraction audit, and transactional target replacement.

## Public API

The following functions are exported and used by the web server:

### Cache (`cache.js`)
- `getCacheKey({ normalizedRepo, subpath, identityId })`: Generate cache key for scan results. The key also names the request's credential scope, so each managed principal has its own entries (see [Managed principals](#managed-principals)).
- `getCachedScan(key)`: Retrieve cached scan result if not expired.
- `setCachedScan(key, value, ttlMs)`: Store scan result with TTL (default 30 minutes).
- `clearCache()`: Clear all cached scan results.

### Curated Sources (`curated-sources.js`)
- `getCuratedSkillsSources()`: Return list of curated skill sources (Anthropic, ClawdHub).
- `CURATED_SKILLS_SOURCES`: Constant array of predefined sources.

### Source Parsing (`source.js`)
- `parseSkillRepoSource(source, { subpath })`: Parse GitHub repository source string into structured object with SSH/HTTPS clone URLs, normalized repo, and effective subpath. Supports SSH URLs, HTTPS URLs, and shorthand `owner/repo[/subpath]` format.

### Git Repository Scanning (`scan.js`)
- `scanSkillsRepository({ source, subpath, defaultSubpath, identity })`: Scan GitHub repository for skills by cloning and analyzing SKILL.md files. Returns array of skill items with metadata. An `identity.sshKey` that `sshCommandForIdentity` refuses fails the scan before any git command runs (see [SSH key paths](#ssh-key-paths)). For a managed request principal the identity is ignored and the scan clones over HTTPS (see [Managed principals](#managed-principals)).

### Git Repository Installation (`install.js`)
- `installSkillsFromRepository({ source, subpath, defaultSubpath, identity, scope, targetSource, workingDirectory, userSkillDir, selections, conflictPolicy, conflictDecisions })`: Install skills from GitHub repository. Supports user/project scopes, opencode/agents targets, conflict resolution (prompt/skipAll/overwriteAll), and sparse checkout for efficiency. A refused `identity.sshKey` fails the install the same way, before any git command runs or any file is written. A managed request principal's identity is ignored in the same way as for a scan.

### ClawdHub Integration (`clawdhub/index.js`)
- `isClawdHubSource(source)`: Check if source string refers to ClawdHub.
- `scanClawdHub()`: Scan entire ClawdHub registry for all skills (paginated, max 20 pages).
- `scanClawdHubPage({ cursor })`: Scan a single page of ClawdHub results with cursor-based pagination.
- `installSkillsFromClawdHub({ scope, targetSource, workingDirectory, userSkillDir, selections, conflictPolicy, conflictDecisions })`: Install skills from ClawdHub through the shared bounded ZIP pipeline.
- `fetchClawdHubSkills({ cursor })`: Fetch paginated skills list from ClawdHub API.
- `fetchClawdHubSkillVersion(slug, version)`: Fetch specific skill version details.
- `fetchClawdHubSkillInfo(slug)`: Fetch skill metadata without version details.
- `downloadClawdHubSkill(slug, version)`: Download skill package as ZIP buffer.

### ClawdHub Constants (`clawdhub/index.js`)
- `CLAWDHUB_SOURCE_ID`: Source identifier for curated sources.
- `CLAWDHUB_SOURCE_STRING`: Source string format.

## Internal Helpers

The following functions are internal helpers used by exported functions:

### Git Helpers (`git.js`)
- `sshCommandForIdentity(identity, platform = process.platform)`: The `core.sshCommand` for `identity.sshKey`: `{ ok: true, sshCommand }` (`null` without a key), or `{ ok: false, error: { kind: 'invalidSource', message } }` for a refused key path. Exported for `scan.js` and `install.js`; `platform` is a parameter so tests can check the Windows form.
- `gitIdentityForRequest(identity)`: The identity a scan or install clones with: `null` for a managed request principal, which clones over HTTPS, otherwise `identity`.
- `authRequiredError()`: The `authRequired` error for a clone that failed to authenticate. It tells a managed principal to connect a GitHub account that can read the repository.
- `runGit(args, options)`: Execute git command with optional SSH identity, timeout, and max buffer. Returns `{ ok, stdout, stderr, message, code, signal }`. With `options.identity`, git gets `-c core.sshCommand=<sshCommandForIdentity's command>`; a refused key path returns `ok: false` with the refusal as `message`, without starting git. For a managed request principal git runs in `buildGitEnv(null, { includeCredentials: true })` from `lib/git`; otherwise it runs in the server's environment. Both set `GIT_TERMINAL_PROMPT=0` (see [Managed principals](#managed-principals)).
- `looksLikeAuthError(message)`: Detect if error message indicates authentication failure (permission denied, publickey, etc.).
- `assertGitAvailable()`: Check if git is available in PATH.

### Skill Name Validation (used in `install.js`, `scan.js`, `clawdhub/install.js`)
- `validateSkillName(skillName)`: Validate skill name against pattern `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars, lowercase alphanumeric with hyphens).

### File System Helpers (`install.js`, `scan.js`)
- `safeRm(dir)`: Safely remove directory recursively (ignores errors).
- `ensureDir(dirPath)`: Ensure directory exists with recursive creation.
- `copyDirectoryNoSymlinks(srcDir, dstDir)`: Copy directory contents without symlinks, with path traversal protection.
- `normalizeUserSkillDir(userSkillDir)`: Normalize user skill directory path (handles legacy `~/.config/opencode/skill` → `~/.config/opencode/skills` migration).

### Git Clone Helpers (`install.js`, `scan.js`)
- `cloneRepo({ cloneUrl, identity, tempDir })`: Clone GitHub repository with preferred partial clone (`--filter=blob:none`) and fallback. Uses non-interactive mode.

### SKILL.md Parsing (`scan.js`)
- `parseSkillMd(content)`: Parse YAML frontmatter from SKILL.md content. Returns `{ ok, frontmatter, warnings }`.

### Path Helpers (`install.js`)
- `toFsPath(repoDir, repoRelPosixPath)`: Convert POSIX path to filesystem path.
- `getTargetSkillDir({ scope, targetSource, workingDirectory, userSkillDir, skillName })`: Determine target installation directory based on scope (user/project), targetSource (opencode/agents), and skill name.

### ClawdHub API Helpers (`clawdhub/api.js`)
- `rateLimitedFetch(url, options)`: Fetch with rate limiting (120 req/min limit, 100ms delay between requests, exponential backoff on 429/500 errors).
- `mapClawdHubItem(item)`: Transform ClawdHub API response to SkillsCatalogItem format.

## Response Contracts

### Scan Skills Repository Response
- `ok`: Boolean indicating success.
- `normalizedRepo`: Normalized GitHub repo string (`owner/repo`).
- `effectiveSubpath`: Effective subpath used for scanning (may be from source string or defaultSubpath).
- `items`: Array of skill items with `{ repoSource, repoSubpath, skillDir, skillName, frontmatterName, description, installable, warnings }`.
- `error`: Error object with `{ kind, message }` on failure.

### Install Skills Response
- `ok`: Boolean indicating success.
- `installed`: Array of installed skills with `{ skillName, scope, source }`.
- `skipped`: Array of skipped skills with `{ skillName, reason }`.
- `error`: Error object with `{ kind, message, conflicts? }` on failure. Kinds: `authRequired`, `networkError`, `conflicts`, `invalidSource`, `unknown`.

### ClawdHub Scan Response
- `ok`: Boolean indicating success.
- `items`: Array of skill items with ClawdHub-specific metadata in `clawdhub` property.
- `nextCursor`: Pagination cursor for next page (only for `scanClawdHubPage`).
- `error`: Error object with `{ kind, message }` on failure.

### Parse Source Response
- `ok`: Boolean indicating success.
- `host`: GitHub host (`github.com`).
- `owner`: Repository owner.
- `repo`: Repository name.
- `cloneUrlSsh`: SSH clone URL.
- `cloneUrlHttps`: HTTPS clone URL.
- `effectiveSubpath`: Subpath for scanning (from source string or options).
- `normalizedRepo`: Normalized repo string (`owner/repo`).
- `error`: Error object with `{ kind, message }` on failure.

## Notes for Contributors

### Adding a New Skill Source
1. Create a new subdirectory under `packages/web/server/lib/skills-catalog/` (e.g., `newsource/`).
2. Implement `scan.js` with a function that returns `{ ok, items, error? }` matching the SkillsCatalogItem contract.
3. Implement `install.js` with a function that accepts selections and returns `{ ok, installed, skipped, error? }`.
4. Add the source to `CURATED_SKILLS_SOURCES` in `curated-sources.js` if it should appear in the default catalog.
5. Update `packages/web/server/index.js` to import and wire up the new source.

### Skill Name Validation
- All skill names must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars).
- Skill names are derived from directory basenames for GitHub repos and slugs for ClawdHub.
- Invalid names result in non-installable skills with appropriate warnings.

### Git Cloning Strategy
- Use sparse checkout to minimize clone size: `sparse-checkout init`, `sparse-checkout set`, `checkout HEAD`.
- Preferred clone uses `--depth=1 --filter=blob:none` for partial clone with fallback to `--depth=1`.
- Always use non-interactive mode (`GIT_TERMINAL_PROMPT=0`) to avoid hangs. A managed principal's Git also runs without the host's credentials (see [Managed principals](#managed-principals)).
- SSH keys are injected via `core.sshCommand` in git config, on every git command of a scan or install (a blobless clone fetches blobs over SSH again during checkout).

### SSH key paths
The identity is a stored Git identity profile's `sshKey` (`resolveGitIdentity` in `lib/opencode/skill-routes.js`, through `getProfile`). Git runs `core.sshCommand` through the shell, so `sshCommandForIdentity` applies the rule of `escapeSshKeyPath` (`lib/git/service.js`) and `escapeCloneSshKeyPath` (`lib/fs/routes.js`):
- The key path is trimmed. On Windows, backslashes become forward slashes first.
- A path holding any of `` ` `` `$ ! " ' ; & | < > ( ) { } [ ] * ? # ~` is refused with `SSH key path contains invalid characters: <path>`. The set includes `~`, so a `~/…` key path is refused here as it is by the other two. A stored profile's key path is not tilde-expanded (owner decision 2026-11-06), so it must be absolute.
- Any other path is single-quoted, so spaces stay part of it: `ssh -i '<path>' -o BatchMode=yes -o StrictHostKeyChecking=accept-new`. On Windows a drive path takes the MSYS form, `C:\keys\id` → `'/c/keys/id'`.

`scanSkillsRepository` and `installSkillsFromRepository` check the key before anything else (except for a managed principal, whose identity is never used) and return the refusal as `{ ok: false, error: { kind: 'invalidSource', message } }`. The scan and install routes answer it with 400 and their dialogs show the message; the catalog source listing answers 500 with the same error. `runGit` refuses the same paths itself for any other caller.

### Managed principals
Managed (multi-user) principals reach the catalog routes through the `skills.catalog` settings page (`settingsPageForRequest` in `lib/multi-user/policy.js`).
- Managed administrators reach them by default.
- Other roles need a `skills.catalog` override: read for the catalog source listing, read and edit for scan and install.
- The multi-user middleware runs each request inside `runWithRequestPrincipal`, so `runGit` sees the principal through `getRequestPrincipal()`.

Managed Git authenticates only with the principal's own GitHub token, never with the host's credentials (owner decision 2026-11-06). For a managed principal, every catalog Git command runs in the Git service's environment, `buildGitEnv(null, { includeCredentials: true })` ([Git child environment](../git/DOCUMENTATION.md#git-child-environment)). That covers the clone, the sparse checkout, the checkout that fetches a blobless clone's blobs, `ls-files` and `show`. `runGit` loads `lib/git` lazily, only for managed requests. Git then runs without:
- the host's credential helpers (system, global, URL-scoped) and `core.askPass`;
- inherited `GIT_ASKPASS` and `SSH_ASKPASS`;
- terminal prompts;
- the SSH transport (`protocol.ssh.allow=never`).

Only DevRyan's askpass helper answers, with the principal's token and only for `https://github.com`. A managed user with no connected GitHub account, or whose account cannot read a private repository, gets `authRequired`: 401 from scan and install, 500 from the catalog source listing.

A managed scan or install never uses a Git identity profile (owner decision 2026-11-06, "HTTPS only"). `gitIdentityForRequest` drops the identity that the request or the stored catalog source names. So the clone is `https://github.com/<owner>/<repo>.git` with no `core.sshCommand`, even for a key path the catalog would refuse. Git refuses the SSH transport for managed principals anyway.

When a managed clone cannot authenticate:
- Scan and install answer 401 `authRequired` with the message `Authentication required to access this repository. Connect a GitHub account that can read it.`
- The response carries `identities: []`, so the host's Git identity profiles are never listed to a managed principal.
- The harness `safeRetry` is `Retry after connecting a GitHub account that can read the repository`.
- The catalog source listing answers 500 with the same error.

Every `authRequired` error keeps `sshOnly: true`, a field of the response contract that no client reads.

The catalog source listing caches scans per credential scope (owner decision 2026-11-06). `getCacheKey` appends `managed:<principal id>` for a managed principal and `host` for every other request. So a managed user is only served listings fetched with their own token, never one fetched with the host's credentials or another user's token. Unmanaged requests share the host's entries. Each managed user adds at most one entry per repository, subpath and identity every 30 minutes.

The local owner keeps the server's environment with `GIT_TERMINAL_PROMPT=0`. That is a request with no principal, or with the `local-admin` scope. Its scans and installs still use the host's credential helpers, askpass programs, SSH agent and identity profile keys, and its auth failures still list the host's identity profiles.

### Conflict Resolution
- Installation checks for existing skills before downloading/cloning.
- Three conflict policies: `prompt`, `skipAll`, `overwriteAll`.
- Per-skill decisions override global policy via `conflictDecisions` map.
- Conflict response includes `{ skillName, scope, source }` for each conflict.

### ClawdHub Integration
- ClawdHub API base URL: `https://clawdhub.com/api/v1`.
- Pagination uses cursor-based approach with `MAX_PAGES=20` safety limit.
- Rate limiting: 120 req/min with 100ms delay between requests.
- Downloaded ZIPs use HTTPS-only, bounded, timeout-aware streaming. Redirects must remain on an explicitly allowed origin.
- Archive metadata is fully preflighted for count/size/path/encryption/special-file/collision hazards before any entry is written. Extraction uses a sibling staging directory, caps actual expanded bytes, audits the completed tree, requires a root `SKILL.md`, and transactionally replaces the target only after validation.
- Public archive safety failures use stable `ARCHIVE_*` values directly in `skipped[].code`; ordinary network or installation failures remain `installFailed`. Host recovery metadata contains only the safe code and fixed guidance.

### Cache Management
- Cache keys include `normalizedRepo`, `subpath`, `identityId` and the request's credential scope for isolation. The scope is `managed:<principal id>` or `host` (see [Managed principals](#managed-principals)).
- Default TTL is 30 minutes; can be overridden via `ttlMs` parameter.
- Cache is in-memory (not persisted across restarts).

### Security Considerations
- Path traversal protection in `copyDirectoryNoSymlinks`: resolves real paths and checks containment.
- Symlinks are explicitly rejected to prevent escape from skill directory.
- ClawdHub ZIP entries additionally reject absolute/traversal/NUL/overlong/deep paths, duplicate and case-colliding paths, file/directory conflicts, encryption, symlinks, and other Unix special modes. Containment is rechecked immediately before each staged write.
- Existing installations are not touched until the staged tree passes its final audit; commit failures restore the prior target, including the cross-device fallback path.
- SSH key paths are refused or single-quoted before they reach the shell that runs `core.sshCommand` (see [SSH key paths](#ssh-key-paths)).
- A managed principal's catalog Git never authenticates with the host's credential helpers, askpass programs or SSH keys, only with the principal's own GitHub token. It is never served a scan cached for another credential scope (see [Managed principals](#managed-principals)).
- Temporary directories are cleaned up in `finally` blocks.

### Error Handling
- All exported functions return `{ ok, ... }` result objects, not throw.
- Error kinds: `authRequired`, `networkError`, `conflicts`, `invalidSource`, `archiveRejected`, `unknown`. Per-item ClawdHub failures use stable `skipped[].code` values. `invalidSource` covers any invalid request input, including a refused SSH key path.
- Use `looksLikeAuthError` to detect SSH/HTTPS auth failures for better UX.
- Log errors to console for debugging but return structured errors to callers.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Tests: `bun run --cwd packages/web test:vitest --project=web server/lib/skills-catalog`.
  - `scan.test.js` and `git.ssh-key.test.js` clone from a local bare repository in the OS temp dir.
  - `git.ssh-key.test.js` connects through a stand-in `ssh` on PATH that records its arguments, so the real shell and Git show what a key path becomes.
  - `git.managed-credentials.test.js` serves a private repository at `https://github.com` through `git http-backend` and `lib/git/test-https-hosts.js`, which needs the `openssl` CLI. It adds a fake host credential helper and askpass programs, and checks through the scan, install and catalog source routes which credential authenticates each managed and unmanaged request. It also checks four more things:
    - managed requests never use an identity profile (a stand-in `ssh` on PATH records any start);
    - their auth failures list no identity profiles;
    - unmanaged auth failures still list them;
    - the catalog source listing's cache never serves a listing across credential scopes.
- Consider edge cases: non-existent repos, private repos without auth, missing SKILL.md files, invalid skill names, conflicts, network failures.

## Verification Commands
- Type-check: `bun run type-check`
- Lint: `bun run lint`
- Build: `bun run build`
