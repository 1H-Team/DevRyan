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

- build caches and tool state: `typecheck`, `shared`, `worktrees`, `session-execution` and `windows-native` (`KEPT_CACHE_FAMILIES`, derived from `GUARD_ALLOWANCES` in `scripts/cache-guard.mjs`, which names each one's writer);
- `sessions/*` entries younger than 14 days (agent session notes live in `.cache/sessions/<date>-<task>/`);
- runs pinned with `"pinned": true` in `run.json` or `storage-retention.json` (the reusable live-provider QA profile);
- anything modified in the last hour, and symlinks.

Git worktrees under `.cache/worktrees` are never touched. Remove ones you created with `git worktree remove`.

## Scratch guard

`bun run validate` and `bun run validate:full` (and the CI lanes, which run `scripts/validate.mjs`) walk the repository before and after the run and fail if anything new is left: a file or a folder, empty and dot-named ones included, that is not tracked and not allowed by `GUARD_ALLOWANCES` in `scripts/cache-guard.mjs`. That list is the only place that says what may appear, each entry with its writer: the `node_modules` and `.git` folders at any depth; editor and operating-system droppings, files only, each pattern matched against the whole file name (`.DS_Store`, Vim swap files and its `4913` probe, `*~` backups, Emacs `.#` locks, JetBrains `___jb_tmp___`/`___jb_old___`); `.claude/` as a whole (agent worktrees, local settings and anything else written there); the build outputs (`packages/web/dist`, `packages/electron/resources/web-dist`, `packages/electron/dist-bundle`, `packages/web/runtime/<platform>-<arch>`, the `packages/native` and desktop cargo `target` folders); the kept caches above; and the scratch-family folders the pools create (`.cache/v2-validation`, `.cache/qa`, `.cache/perf`: the folder may appear, anything new inside it may not). A folder holding a `.git` entry (a nested worktree) is not entered, and symbolic links are never followed. The walk reads directory entries only and takes well under a second on a normal checkout.

The failure names each new path. A file you or another tool created during the run is not test scratch: re-run, and it predates the next run. Scratch a test left must be fixed in the test (OS temp dir, deleted on pass, failure and interruption). The guard fails closed: when a folder could not be read, `.cache` is a symbolic link or not a folder, or `git ls-files` fails, it reports that it could not judge the run, and why.

The guard and the test pools only read and report; nothing in them removes a file. A test that is killed (its timeout, a signal, an interrupted run) cannot run its own cleanup, so what it made under `.cache/` stays, and the guard of that run names it. Because `cache:prune` keeps anything modified in the last hour, the report prints the exact command that removes those leftovers now (`rm -rf -- '<repository>/.cache/…'`, every path shell-quoted), and says that after an hour `bun run cache:prune` previews them and `bun run cache:prune -- --apply` deletes them. A later run does not report them again: they predate it.

## Keeping artifacts

`scripts/qa/run-root.mjs` removes a QA or benchmark run directory on pass, failure and interruption. Set `--keep-artifacts` (where the script accepts it) or `DEVRYAN_KEEP_ARTIFACTS=1` to keep it for diagnosis, and remove it yourself afterwards. Run directories live under `<os tmpdir>/devryan-<family>`. `scripts/qa/package-electron.mjs` keeps one packaged app in a fixed slot, `.cache/qa/packaged-electron-current`, which the next package replaces.

## Freeing space

1. `bun run cache:report`, then `bun run cache:prune -- --apply`.
2. A packaged QA app is about 1.8 GB. Check `df -h .` before packaging.
3. Delete stale `devryan-*` directories in the OS temp directory if a crashed run left any.
4. Dependencies and builds (`node_modules`, `packages/*/dist`, `packages/desktop/src-tauri/target`) regenerate with `bun install` and `bun run build`.
