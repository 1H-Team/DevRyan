// The scratch guard of `bun run validate`.
//
// `snapshotRepository` walks the repository (directory entries only, no file
// reads) before and after a run; `scratchGrowthFailure` fails the run on any file
// or directory that appeared (empty and dot-named ones included) and is not
// tracked and not allowed by GUARD_ALLOWANCES, the only list of what may appear
// (every entry names its writer). It fails closed: when it cannot judge (an
// unreadable directory, `.cache` a symbolic link, Git unavailable) it says so.
// The guard only reads and reports; it never removes anything. Leftovers under
// `.cache` are removed by the person, with the commands the report names.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What may appear during a run. `kind`:
 * - `skipped-directory`: a directory with this name, at any depth, is neither walked nor reported;
 * - `dropping`: a file whose name matches `pattern` (editor and operating-system droppings) is not reported;
 *   every pattern is anchored at both ends, so it matches one whole file name, never a prefix or a part;
 * - `output`: this path and everything under it may appear or change;
 * - `scratch-family`: the folder itself may appear (a pool pre-creates it); anything new inside it is scratch.
 */
export const GUARD_ALLOWANCES = Object.freeze([
  { kind: 'skipped-directory', name: '.git', reason: 'Git metadata; checkouts and hooks write it' },
  { kind: 'skipped-directory', name: 'node_modules', reason: 'installed dependencies and the tool caches inside them (node_modules/.cache, .vite, .bun)' },
  { kind: 'dropping', pattern: /^\.DS_Store$/, reason: 'macOS Finder writes it whenever a folder is shown' },
  { kind: 'dropping', pattern: /^(?:\..+\.sw[a-p]|4913)$/, reason: 'Vim swap files, and the 4913 probe file Vim writes to test a folder' },
  { kind: 'dropping', pattern: /^.+~$/, reason: 'editor backup files (Vim, Emacs, nano)' },
  { kind: 'dropping', pattern: /^\.#.+$/, reason: 'Emacs lock files' },
  { kind: 'dropping', pattern: /^.+___jb_(?:tmp|old)___$/, reason: 'JetBrains safe-write temporaries' },
  { kind: 'output', path: '.claude', reason: 'Claude Code settings and agent worktrees, written by people and agents beside a run' },
  { kind: 'output', path: 'packages/web/dist', reason: 'Vite build.outDir (packages/web/vite.config.ts), `bun run build:web`' },
  { kind: 'output', path: 'packages/electron/resources/web-dist', reason: 'packages/electron/scripts/build-web-assets.mjs, `bun run build`' },
  { kind: 'output', path: 'packages/electron/dist-bundle', reason: 'packages/electron/scripts/bundle-main.mjs, `bun run build:electron`' },
  { kind: 'output', path: `packages/web/runtime/${process.platform}-${process.arch}`, reason: 'scripts/build-native-runtime.mjs production output, built by the native suites' },
  { kind: 'output', path: 'packages/native/target', reason: 'cargo target of the native workspace (scripts/check-native.mjs)' },
  { kind: 'output', path: 'packages/desktop/src-tauri/target', reason: 'cargo target of the frozen desktop suite (`cargo test --manifest-path src-tauri/Cargo.toml`)' },
  { kind: 'output', path: '.cache/typecheck', reason: 'tsBuildInfoFile of packages/ui and packages/web, scripts/typecheck-diagnostics.mjs' },
  { kind: 'output', path: '.cache/shared', reason: 'BUN_INSTALL_CACHE_DIR of QA profiles (scripts/qa/profile-preparation.mjs)' },
  { kind: 'output', path: '.cache/session-execution', reason: 'default output of scripts/build-session-execution.mjs' },
  { kind: 'output', path: '.cache/windows-native', reason: 'Windows runtime candidate and reviewed executables (scripts/build-native-runtime.mjs, build-windows-*.mjs)' },
  { kind: 'output', path: '.cache/worktrees', reason: 'Git worktrees made by agents and tools; never scratch' },
  { kind: 'output', path: '.cache/sessions', reason: 'agent session notes (.cache/sessions/<date>-<task>/), written beside a run' },
  { kind: 'scratch-family', path: '.cache', reason: 'parent of the families; prepareScriptTestEnvironment creates it' },
  { kind: 'scratch-family', path: '.cache/v2-validation', reason: 'pre-created by prepareScriptTestEnvironment for native graph builds that resolve repository node_modules' },
  { kind: 'scratch-family', path: '.cache/qa', reason: 'pre-created (private) by prepareScriptTestEnvironment for QA code that requires a repository .cache path' },
  { kind: 'scratch-family', path: '.cache/perf', reason: 'pre-created by prepareScriptTestEnvironment for benchmark fixtures' },
]);

const SKIPPED_DIRECTORIES = new Set(GUARD_ALLOWANCES.filter((entry) => entry.kind === 'skipped-directory').map((entry) => entry.name));
const DROPPINGS = GUARD_ALLOWANCES.filter((entry) => entry.kind === 'dropping').map((entry) => entry.pattern);
const OUTPUTS = new Set(GUARD_ALLOWANCES.filter((entry) => entry.kind === 'output').map((entry) => entry.path));
const FAMILY_SET = new Set(GUARD_ALLOWANCES.filter((entry) => entry.kind === 'scratch-family').map((entry) => entry.path));

/** `.cache` families that `cache:prune` keeps (scripts/storage.mjs): the kept caches above. */
export const KEPT_CACHE_FAMILIES = Object.freeze([...OUTPUTS].filter((entry) => entry.startsWith('.cache/')).map((entry) => entry.slice('.cache/'.length)));

/** Why `root/.cache` cannot be judged, or null when it is absent or a real directory. */
function cacheProblem(root) {
  let stat;
  try { stat = fs.lstatSync(path.join(root, '.cache')); } catch (error) { return error?.code === 'ENOENT' ? null : `.cache cannot be read (${error?.code ?? error})`; }
  return stat.isDirectory() ? null : '.cache is not a real directory (a symbolic link or a file)';
}

/**
 * Every file and directory under `root/base` the guard watches (directories end
 * in `/`), and `problems`: what could not be read. Skipped directories and
 * outputs are not entered, nor is a directory holding a `.git` entry (a nested
 * checkout, which runs its own guard); symbolic links are recorded, never followed.
 */
export function snapshotRepository(root, { base = '' } = {}) {
  const entries = new Set(), problems = [];
  const cache = cacheProblem(root);
  if (cache) problems.push(cache);
  const walk = (relative) => {
    let children;
    try { children = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch (error) {
      // A folder removed while the walk runs is simply gone; any other error means the walk is incomplete.
      if (error?.code !== 'ENOENT') problems.push(`${relative || '.'} could not be read (${error?.code ?? error})`);
      return;
    }
    for (const entry of children) {
      const directory = entry.isDirectory();
      if (directory && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (!directory && DROPPINGS.some((pattern) => pattern.test(entry.name))) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (OUTPUTS.has(child)) continue;
      entries.add(directory ? `${child}/` : child);
      if (directory && !fs.existsSync(path.join(root, child, '.git'))) walk(child);
    }
  };
  if (!(base === '.cache' && cache)) walk(base);
  return { entries, problems };
}

/** Entries present after but not before, each at its topmost new ancestor; scratch-family folders are never reported themselves. */
export function newEntries(before, after) {
  const added = [...after.entries].filter((entry) => !before.entries.has(entry) && !FAMILY_SET.has(entry.replace(/\/$/, '')));
  const addedDirectories = new Set(added.filter((entry) => entry.endsWith('/')));
  return added.filter((entry) => {
    for (let parent = path.posix.dirname(entry.replace(/\/$/, '')); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (addedDirectories.has(`${parent}/`)) return false;
    }
    return true;
  }).map((entry) => entry.replace(/\/$/, '')).sort();
}

/** `{ tracked }`: the subset of `paths` that is tracked or contains tracked files; `{ error }` when Git could not answer. */
function trackedAmong(root, paths) {
  if (paths.length === 0) return { tracked: new Set() };
  const result = spawnSync('git', ['ls-files', '-z', '--', ...paths.map((entry) => `:(literal)${entry}`)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { error: `git ls-files failed (${result.error?.code ?? `exit ${result.status}`}: ${String(result.stderr ?? '').trim().split('\n')[0] || 'no output'})` };
  const files = result.stdout.split('\0').filter(Boolean);
  return { tracked: new Set(paths.filter((entry) => files.some((file) => file === entry || file.startsWith(`${entry}/`)))) };
}

function filesUnder(target) {
  const found = [];
  const walk = (directory) => {
    let children = [];
    try { children = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of children) {
      if (found.length >= 10) return;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else found.push(child);
    }
  };
  walk(target);
  return found;
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function size(file) {
  const result = spawnSync('du', ['-sh', file], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\t')[0] : '?';
}

/**
 * Returns a failure message naming what the run left behind, or saying why the
 * guard could not judge; null when nothing new appeared.
 */
export function scratchGrowthFailure(root, before, { after = snapshotRepository(root) } = {}) {
  const problems = [...new Set([...before.problems, ...after.problems])];
  const candidates = newEntries(before, after);
  const { tracked, error } = trackedAmong(root, candidates);
  if (error) problems.push(error);
  if (problems.length) {
    return ['The scratch guard could not judge this run:', ...problems.map((problem) => `- ${problem}`),
      ...(candidates.length ? ['New entries it saw (some may be tracked):', ...candidates.slice(0, 20).map((entry) => `- ${entry}`)] : []),
      'Fix the cause and re-run.'].join('\n');
  }
  const added = candidates.filter((entry) => !tracked.has(entry));
  if (added.length === 0) return null;
  const shown = added.slice(0, 20).flatMap((entry) => {
    const absolute = path.join(root, entry);
    const directory = after.entries.has(`${entry}/`);
    const files = directory ? filesUnder(absolute).slice(0, 10) : [];
    const label = directory ? (files.length ? `directory, ${size(absolute)}` : 'empty directory') : size(absolute);
    return [`- ${entry} (${label})`, ...files.map((file) => `    ${path.relative(root, file)}`)];
  });
  const inCache = added.filter((entry) => entry.startsWith('.cache/'));
  return [
    `These ${added.length} entr${added.length === 1 ? 'y' : 'ies'} appeared in the repository during this run and are neither tracked nor allowed (GUARD_ALLOWANCES in scripts/cache-guard.mjs):`,
    ...shown,
    ...(added.length > 20 ? [`- … and ${added.length - 20} more`] : []),
    'A file you created yourself during the run (or another tool did) is not test scratch: re-run, and it predates the next run.',
    'Scratch a test left must be fixed in the test: use the OS temp dir and delete it on pass, failure and interruption (docs/TESTING.md).',
    ...(inCache.length ? [
      'Nothing was removed. A test that was killed (its timeout, a signal, an interrupted run) cannot clean up, so what it made under .cache/ stays until you remove it.',
      '`bun run cache:prune` keeps anything modified in the last hour; to remove these leftovers now, run:',
      `  rm -rf -- ${inCache.map((entry) => shellQuote(path.join(root, entry))).join(' ')}`,
      'or, after an hour, preview with `bun run cache:prune` and delete with `bun run cache:prune -- --apply`.',
    ] : []),
  ].join('\n');
}
