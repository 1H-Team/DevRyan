# packages/web/server/lib/fs/

## Responsibility
Filesystem helper domain for server-side file operations; key modules provide fuzzy file search with optional `.gitignore` awareness and deterministic Git read caching for FS exec hot paths.

## Design
- **Runtime factory** (`createFsSearchRuntime`) injects fs/path/spawn/git-binary dependencies.
- **Bounded traversal**: controlled concurrency, excluded directory set, hidden-file toggle, and candidate collection caps.
- **Hybrid matching**: substring bonus + fuzzy character-sequence scoring to rank candidate paths.
- **Gitignore-aware filtering** via `git check-ignore` for directory-local entries.
- **Deterministic Git read cache** (`createDeterministicGitReadCache`) dedupes exact allowlisted `git rev-parse` reads by cwd for foreground `/api/fs/exec`.

## Flow
1. Caller passes root path, query, limits, and visibility/gitignore options.
2. Runtime breadth-first scans directories with batched async reads.
3. Files are filtered/scored and accumulated until collection threshold.
4. Results are sorted and truncated to requested limit.

## Integration
- Wired into server routes for file search APIs.
- Consumed by UI file picker/search features through web runtime adapters.
- Depends on git binary resolution from server bootstrap for ignore checks.

- `file-versions.js` owns complete text reads, source digests and expected-version saves. Saves reject stale content with HTTP 409, atomically rename the replacement, and fsync its parent where supported. This coordinates DevRyan writes; external writers are not subject to a filesystem-wide compare-and-swap lock.
