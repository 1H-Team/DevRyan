// Shared run-directory lifecycle for QA, validation and perf producers.
//
// Run directories live in the OS temp dir (see `scratchParent`), never in the
// repository. A run directory gets `run.json` ({ schemaVersion, owner,
// createdAt, completedAt, status, pinned }). On any terminal status (passed,
// failed, interrupted) the WHOLE run directory and its `external` paths are
// removed. A failed run first prints a one-line hint to stderr. Producers whose
// payload is a deliverable (`keepOnPass`) keep the directory on pass only.
// `--keep-artifacts` or DEVRYAN_KEEP_ARTIFACTS=1 keeps everything in every case.
import { constants as fsConstants, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUN_MANIFEST = 'run.json';
export const RUN_STATUSES = Object.freeze(['running', 'passed', 'failed', 'interrupted']);
/** Top-level directory names under a run root that hold rebuildable payloads. */
export const HEAVY_TOP_LEVEL = Object.freeze(['runtime', 'home', 'profile']);
/** Directory names removed at any depth. */
export const HEAVY_ANYWHERE = Object.freeze(['node_modules', 'runtime-bundles']);
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 };
const ownedScratchRuns = new WeakMap();

/** OS-temp parent directory for a scratch family, e.g. `<tmpdir>/devryan-qa`. */
export function scratchParent(family) {
  if (typeof family !== 'string' || !/^[a-z0-9-]+$/.test(family)) throw new TypeError(`Invalid scratch family: ${String(family)}`);
  return path.join(realpathSync(os.tmpdir()), `devryan-${family}`);
}

/** Admit only descendants of a live run created by this process in the QA/perf temp families. */
export function isOwnedScratchPath(file, { scope, future = false } = {}) {
  const owned = scope && ownedScratchRuns.get(scope);
  if (!owned || typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) return false;
  const { root, dev, ino } = owned;
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino || realpathSync(root) !== root) return false;
    let ancestor = file;
    if (future) {
      while (!lstatOrNull(ancestor)) ancestor = path.dirname(ancestor);
    }
    return realpathSync(ancestor) === ancestor && (ancestor === root || ancestor.startsWith(root + path.sep));
  } catch { return false; }
}

export function keepArtifactsRequested({ argv = process.argv, env = process.env, keep = false } = {}) {
  return Boolean(keep) || argv.includes('--keep-artifacts') || env.DEVRYAN_KEEP_ARTIFACTS === '1';
}

/** Clone-on-write copy (APFS clonefile, reflink) with a plain-copy fallback. */
export function cloneFile(source, target) {
  try { copyFileSync(source, target, fsConstants.COPYFILE_FICLONE); } catch { copyFileSync(source, target); }
}

/** Recursive copy that clones each file where the filesystem supports it. */
export function cloneTree(source, target, options = {}) {
  // COPYFILE_FICLONE (not _FORCE) already degrades to a plain copy per file.
  cpSync(source, target, { recursive: true, mode: fsConstants.COPYFILE_FICLONE, errorOnExist: true, force: false, ...options });
}

function writeManifest(file, manifest) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Delete the heavy payloads inside a run root. Returns the removed paths. */
export function removeRunPayloads(root, { topLevel = HEAVY_TOP_LEVEL, anywhere = HEAVY_ANYWHERE, extra = [] } = {}) {
  const removed = [];
  const remove = target => { rmSync(target, { recursive: true, force: true }); removed.push(target); };
  const walk = (directory, depth) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue; // symlinks are never followed
      if ((depth === 0 && topLevel.includes(entry.name)) || anywhere.includes(entry.name) || entry.name.endsWith('.app')) remove(target);
      else walk(target, depth + 1);
    }
  };
  walk(root, 0);
  for (const target of extra) {
    const absolute = path.resolve(root, target);
    if (absolute !== root && absolute.startsWith(root + path.sep) && lstatOrNull(absolute)) remove(absolute);
  }
  return removed;
}

function lstatOrNull(target) { try { return lstatSync(target); } catch { return null; } }

/**
 * Create `<parent>/<prefix>XXXXXX` with a run manifest and lifecycle handlers.
 * `finish('passed'|'failed')` is idempotent; the first terminal status wins.
 * `extraPayloads` and `heavyNames` are retained for caller compatibility; the whole
 * directory is removed on a terminal status, so they only matter to `removeRunPayloads`.
 * `external` are paths outside the run dir owned by this run (a tmpdir runtime).
 * `dir` adopts an existing run directory created by a shared fixture helper.
 * `name` uses a fixed directory name instead of a unique `prefix` suffix.
 * `keepOnPass` is for producers whose payload is the deliverable (a packaged app
 * consumed by later runs): a pass keeps it, a failure or interrupt removes it.
 * `signals: 'exit'` installs only the exit hook, for producers that handle
 * SIGINT/SIGTERM themselves and then call `finish('interrupted')`.
 * `onInterrupt` runs before interrupt cleanup so owned processes can stop.
 */
export function createRunRoot({ parent, prefix = 'run-', name, dir: adoptedDir, owner, keepArtifacts, keepOnPass = false, argv, env, extraPayloads = [], heavyNames = [], external = [], onInterrupt,
  signals = true, exitProcessOnSignal = true } = {}) {
  if (!owner || (!parent && !adoptedDir)) throw new TypeError('createRunRoot requires owner and parent (or dir)');
  for (const component of [prefix, name].filter(value => value !== undefined)) {
    if (typeof component !== 'string' || !component || component === '.' || component === '..' || path.basename(component) !== component || component.includes('\0'))
      throw new TypeError('Run directory name must be one path component');
  }
  if (parent) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratchFamily = parent && ['qa', 'perf'].find(family => parent === scratchParent(family));
  if (scratchFamily) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent
      || (stat.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error('Scratch parent must be a private canonical directory');
  }
  const dir = adoptedDir ? path.resolve(adoptedDir) : name ? path.join(parent, name) : mkdtempSync(path.join(parent, prefix));
  if (name) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scope = Object.freeze({});
  const initial = lstatSync(dir);
  const canonicalAtStart = realpathSync(dir);
  if (!initial.isDirectory() || initial.isSymbolicLink() || scratchFamily && canonicalAtStart !== dir) throw new Error('Run directory must be canonical');
  if (scratchFamily) ownedScratchRuns.set(scope, { root: dir, dev: initial.dev, ino: initial.ino });
  const keep = keepArtifactsRequested({ argv, env: env ?? process.env, keep: keepArtifacts });
  const manifestPath = path.join(dir, RUN_MANIFEST);
  const manifest = { schemaVersion: 1, owner, createdAt: new Date().toISOString(), completedAt: null, status: 'running', pinned: false };
  writeManifest(manifestPath, manifest);
  const externalPaths = [...external];
  const handlers = [];
  let finished = false;
  let payloadsRemoved = [];
  let removed = false;

  const finishSync = status => {
    if (finished) return manifest.status;
    if (!RUN_STATUSES.includes(status) || status === 'running') throw new TypeError(`Invalid run status: ${status}`);
    const current = lstatOrNull(dir);
    if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || realpathSync(dir) !== canonicalAtStart) {
      dispose(); ownedScratchRuns.delete(scope);
      throw new Error('Run directory identity changed before cleanup');
    }
    finished = true;
    manifest.status = status;
    manifest.completedAt = new Date().toISOString();
    if (!keep && !(keepOnPass && status === 'passed')) {
      if (status === 'failed') process.stderr.write(`[run-root] ${owner} failed; its files were removed. Re-run with --keep-artifacts to keep ${dir}.\n`);
      try {
        for (const target of externalPaths) { rmSync(target, { recursive: true, force: true }); payloadsRemoved.push(target); }
        rmSync(dir, { recursive: true, force: true });
        payloadsRemoved.push(dir);
        removed = true;
      } catch { /* the prune tool retries */ }
    }
    if (!removed) { try { writeManifest(manifestPath, manifest); } catch { /* run dir already removed */ } }
    dispose();
    ownedScratchRuns.delete(scope);
    return status;
  };
  function dispose() { for (const [event, handler] of handlers.splice(0)) process.removeListener(event, handler); }

  if (signals) {
    const onExit = () => { if (!finished) finishSync('failed'); };
    process.on('exit', onExit); handlers.push(['exit', onExit]);
  }
  if (signals === true) {
    for (const signal of Object.keys(SIGNAL_CODES)) {
      const handler = () => {
        Promise.resolve().then(() => onInterrupt?.(signal)).catch(() => {}).then(() => {
          finishSync('interrupted');
          if (exitProcessOnSignal) process.exit(SIGNAL_CODES[signal]);
        });
      };
      process.on(signal, handler); handlers.push([signal, handler]);
    }
  }
  return {
    dir, scope, manifestPath, keepArtifacts: keep,
    get status() { return manifest.status; },
    get payloadsRemoved() { return payloadsRemoved; },
    /** Register another path outside the run dir that this run owns. */
    own(target) { externalPaths.push(target); return target; },
    finish: finishSync,
    dispose,
  };
}
