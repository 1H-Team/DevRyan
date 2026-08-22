# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/git-read-cache.js`: deterministic in-memory cache for exact allowlisted Git read commands issued through foreground `/api/fs/exec`.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
  - `GET /api/fs/raw`
    - `GET /api/fs/stat`
    - `POST /api/fs/write`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Applies a process-memory cache for successful foreground single-command Git reads:
    - `git rev-parse --absolute-git-dir`
    - `git rev-parse --git-common-dir`
    - `git rev-parse --absolute-git-dir --git-common-dir`
  - Cache TTL defaults to 30 seconds and can be disabled with `OPENCHAMBER_GIT_READ_CACHE_TTL_MS=0`.
  - Failures, non-allowlisted commands, multi-command jobs, and background jobs bypass the cache.
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - Accepts a short-lived `assetGrant` only for assistant gallery files prepared
    by the image-assets module. The grant is revalidated against the request
    principal and exact canonical path; ordinary raw-file policy is unchanged.
  - `GET /api/fs/stat` supports `optional=true` for UI existence probes; expected misses return `{ exists: false, isFile: false }` with HTTP 200 while non-optional callers keep strict 400/403/404 behavior.
- `createDeterministicGitReadCache(options)` from `git-read-cache.js`
  - Caches by resolved cwd and normalized command.
  - Dedupes in-flight identical reads.
  - Bounds memory by entry count and result byte size.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
