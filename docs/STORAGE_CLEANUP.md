# Local repository storage

Tests and QA put disposable files in the OS temp directory and delete them when they pass, fail or are interrupted. The gitignored `.cache/` holds only build caches and leftovers from older runs.

## Commands

```sh
bun run cache:report              # size of each .cache family, largest first
bun run cache:prune               # preview what would be deleted
bun run cache:prune -- --apply    # delete it
```

Both accept `--json`. Preview before `--apply`; nothing stops running builds or QA, so pause them first.

## What is kept

`cache:prune` deletes every `.cache` family except:

- build caches: `eslint`, `typecheck`, `shared`, `worktrees`, `session-execution`, `windows-native`, `revert-runtime-companion` (`KEPT_CACHE_FAMILIES` in `scripts/cache-guard.mjs`);
- `sessions/*` entries younger than 14 days (agent session notes live in `.cache/sessions/<date>-<task>/`);
- runs pinned with `"pinned": true` in `run.json` or `storage-retention.json` (the reusable live-provider QA profile);
- anything modified in the last hour, and symlinks.

Git worktrees under `.cache/worktrees` are never touched. Remove ones you created with `git worktree remove`.

## Cache guard

`bun run validate` and `bun run validate:full` fail if the run left new entries in `.cache/` outside the kept families (`scripts/cache-guard.mjs`). If one does, a test or script is writing scratch in the repository: move it to the OS temp directory and delete it on exit.

## Keeping artifacts

`scripts/qa/run-root.mjs` removes a QA or benchmark run directory on pass, failure and interruption. Set `--keep-artifacts` (where the script accepts it) or `DEVRYAN_KEEP_ARTIFACTS=1` to keep it for diagnosis, and remove it yourself afterwards. Run directories live under `<os tmpdir>/devryan-<family>`. `scripts/qa/package-electron.mjs` keeps one packaged app in a fixed slot, `.cache/qa/packaged-electron-current`, which the next package replaces.

## Freeing space

1. `bun run cache:report`, then `bun run cache:prune -- --apply`.
2. A packaged QA app is about 1.8 GB. Check `df -h .` before packaging.
3. Delete stale `devryan-*` directories in the OS temp directory if a crashed run left any.
4. Dependencies and builds (`node_modules`, `packages/*/dist`, `packages/desktop/src-tauri/target`) regenerate with `bun install` and `bun run build`.
