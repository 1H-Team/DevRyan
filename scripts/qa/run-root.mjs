// Shared run-directory lifecycle for QA, validation and perf producers.
//
// A run directory gets `run.json` ({ schemaVersion, owner, createdAt,
// completedAt, status, pinned }). On pass and on interrupt the heavy payloads
// (runtime, home, profile, apps, node_modules, runtime bundles, copied native
// binaries) are deleted; evidence files stay. On failure everything stays.
// `--keep-artifacts` or DEVRYAN_KEEP_ARTIFACTS=1 keeps payloads in every case.
import { constants as fsConstants, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RUN_MANIFEST = 'run.json';
export const RUN_STATUSES = Object.freeze(['running', 'passed', 'failed', 'interrupted']);
/** Top-level directory names under a run root that hold rebuildable payloads. */
export const HEAVY_TOP_LEVEL = Object.freeze(['runtime', 'home', 'profile']);
/** Directory names removed at any depth. */
export const HEAVY_ANYWHERE = Object.freeze(['node_modules', 'runtime-bundles']);
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 };

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
 * `extraPayloads` are extra paths (relative to the run dir, or absolute inside
 * it) removed alongside the standard heavy subtrees, e.g. copied binaries.
 * `external` are paths outside the run dir owned by this run (a tmpdir runtime).
 * `keepOnPass` is for producers whose payload is the deliverable (a packaged app
 * consumed by later runs): a pass keeps it, an interrupt still removes it.
 * `signals: 'exit'` installs only the exit hook, for producers that handle
 * SIGINT/SIGTERM themselves and then call `finish('interrupted')`.
 * `onInterrupt` runs before interrupt cleanup so owned processes can stop.
 */
export function createRunRoot({ parent, prefix = 'run-', owner, keepArtifacts, keepOnPass = false, argv, env, extraPayloads = [], external = [], onInterrupt,
  signals = true, exitProcessOnSignal = true } = {}) {
  if (!parent || !owner) throw new TypeError('createRunRoot requires parent and owner');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(parent, prefix));
  const keep = keepArtifactsRequested({ argv, env: env ?? process.env, keep: keepArtifacts });
  const manifestPath = path.join(dir, RUN_MANIFEST);
  const manifest = { schemaVersion: 1, owner, createdAt: new Date().toISOString(), completedAt: null, status: 'running', pinned: false };
  writeManifest(manifestPath, manifest);
  const externalPaths = [...external];
  const handlers = [];
  let finished = false;
  let payloadsRemoved = [];

  const finishSync = status => {
    if (finished) return manifest.status;
    if (!RUN_STATUSES.includes(status) || status === 'running') throw new TypeError(`Invalid run status: ${status}`);
    finished = true;
    manifest.status = status;
    manifest.completedAt = new Date().toISOString();
    if (!keep && status !== 'failed' && !(keepOnPass && status === 'passed')) {
      try {
        payloadsRemoved = removeRunPayloads(dir, { extra: extraPayloads });
        for (const target of externalPaths) { rmSync(target, { recursive: true, force: true }); payloadsRemoved.push(target); }
      } catch { /* evidence stays; the prune tool retries */ }
    }
    try { writeManifest(manifestPath, manifest); } catch { /* run dir already removed */ }
    dispose();
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
    dir, manifestPath, keepArtifacts: keep,
    get status() { return manifest.status; },
    get payloadsRemoved() { return payloadsRemoved; },
    /** Register another path outside the run dir that this run owns. */
    own(target) { externalPaths.push(target); return target; },
    finish: finishSync,
    dispose,
  };
}
