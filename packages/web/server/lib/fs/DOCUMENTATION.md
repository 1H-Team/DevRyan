# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/git-read-cache.js`: deterministic in-memory cache for exact allowlisted Git read commands issued through foreground `/api/fs/exec`.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).
- `packages/web/server/lib/fs/watch.js`: shared watch hub and SSE handler behind `GET /api/fs/watch`.

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home` (`{ home, configDirectory }`; `configDirectory` is the injected active runtime config folder, matching filesystem policy and project-config storage. Without an injected root, it falls back to `~/.config/devryan` or the pre-rename folder while it holds the data.)
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
    - `GET /api/fs/watch` (scoped change notifications; see below)
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Applies a process-memory cache for successful foreground single-command Git reads:
    - `git rev-parse --absolute-git-dir`
    - `git rev-parse --git-common-dir`
    - `git rev-parse --absolute-git-dir --git-common-dir`
  - Cache TTL defaults to 30 seconds and can be disabled with `DEVRYAN_GIT_READ_CACHE_TTL_MS=0`.
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

## Scoped change notifications (`GET /api/fs/watch`)
- Query: `directory=<abs>` (one scalar, translated by the managed path middleware), repeated `expanded=<rel>` and at most one `selected=<rel>`, both relative to `directory` so the middleware's `path` rewriting never touches them. Cookie auth only; no credentials in the URL.
- The whole scope is authorized before any byte is streamed (`resolveWatchScopeFromContext` in `routes.js`):
  - the root gets the read-route confinement (`resolveProjectDirectory`, project or worktree or config root, canonical `realpath` inside the canonical base) and must be an existing directory; `allowOutsideWorkspace` is never honoured;
  - every entry must be relative, contain no `..`, stay inside the canonical root and have no symlink component (`rejectSymlinkComponentsInPrefix`); an existing entry of the wrong type is rejected, a missing one is watched once it appears;
  - restricted managed roles get `404 { error: 'File not found' }` for a protected `.env`/`.env.*` entry (also enforced by the dotenv middleware);
  - more than 64 distinct directories (root, expanded and the selected file's parent) is `400 fs_watch_scope_too_large`. Any failure rejects the whole scope with JSON.
- `createFsWatchHub({ watch, fsPromises, maxHandles = 512, maxHandlesPerPrincipal = 128 })` owns shared, reference-counted, nonrecursive `fs.watch` handles keyed by canonical directory. Capacity is reserved synchronously and every watcher is installed before `ready`; a full hub or principal share answers `503 fs_watch_capacity`, an install failure such as `ENOSPC` answers `503 fs_watch_unavailable` (both `retryable: true`) after rolling the lease back. Release is idempotent and closes a watcher with its last reference.
- The selected file is observed through its parent directory, filtered by basename, never by a watch on the file: on macOS that watch goes silent after an atomic save replaces the inode.
- Events are `data: <json>` frames carrying the subscription `epoch`: `ready`, `invalidate` with a `slot` (`root`, `expanded` + client index, or `selected`), `resync`, and `unavailable` with `retryable`. Hints never carry file names or contents; a `null` filename is a generic hint for the directory's slots. Events for protected dotenv names are dropped per subscriber for restricted roles.
- Hints coalesce for 200 ms per subscription; more than 512 raw events in one window, a watcher error that reopens, or a replaced root send `resync`. A watcher that cannot reopen sends `unavailable` (retryable) and closes.
- Every 15 s heartbeat re-runs the scope authorization (a failure or changed scope sends `unavailable` with `retryable: false` and closes), then compares each root's `(dev, ino)` from `realpath` + `lstat` with the recorded identity and reopens on a mismatch, then writes `:heartbeat`.
- Writes go through `createBoundedEventQueue` with drain-awaited writes; exceeding the 64 KiB bound closes the stream. Revocation reaches the stream through `requireAuth`'s `registerConnection`, and close, abort or error release every reference and timer idempotently. The route is exempt from compression (`SSE_PATH_PREFIXES`).
- `DEVRYAN_FS_WATCH` is on by default except on win32 (where `ReadDirectoryChangesW` holds directory handles); `0`/`false`/`off` makes the route answer one `unavailable` (`reason: 'disabled'`) frame, which keeps the client on polling. Native recursive watching and `fff` stay off.
- `/api/fs/list` itself remains unconfined; that is unchanged here.
- Client contract: `FilesAPI.watch` (`packages/ui/src/lib/api/types.ts`) is implemented by `createWebFilesAPI` (`packages/web/src/api/files.ts`) with a same-origin `fetch` owned by the caller's `AbortSignal`. A 4xx or a scope over 64 directories or 8 KB of URL maps to `unavailable` without retry; 5xx, network errors and a 45 s silent stream reject for retry. `FilesView` drives it through `components/views/filesViewWatch.ts`: subscribe only while the view and document are visible on a 250 ms debounced scope, abort on scope, visibility, runtime or unmount changes, refresh authoritatively on `ready`, then keep a 30 s safety net instead of the 8 s directory and 2 s selected-file polls. `invalidate` refreshes the hinted directory or re-stats the selected file through the dirty-buffer-preserving check; `resync` refreshes everything. Failure or `unavailable` restores 8 s / 2 s polling, and retries use the shared backoff (`lib/reconnectBackoff.ts`: 1 s doubling to 30 s, reset after `ready`). Selected files and expanded directories outside the root are not watched; a selected file outside the root keeps its 2 s poll.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
