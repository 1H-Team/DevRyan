// The run root of the backend conformance harness (BH0; docs/TESTING.md,
// "Backend route-group conformance harness").
//
// Every file a run writes lives under one directory,
// <os tmpdir>/devryan-backend-conformance/run-XXXXXX. The parent must be a
// private canonical directory of this user. The run directory is created by
// mkdtemp, opened and held (its device and inode are kept) and checked before
// anything is written into it; every later write checks again that the path
// still names the held directory, refuses any symbolic link on the way and
// creates files exclusively (on Linux through the held descriptor, so a swap of
// the path between the check and the creation cannot redirect it; Node has no
// openat, so elsewhere a same-user swap in that window is detected right after
// and refused). The directory is removed on pass, failure and SIGINT, SIGTERM
// and SIGHUP (scripts/qa/run-root.mjs owns that lifecycle, and refuses to
// remove a directory whose identity changed); --keep-artifacts or
// DEVRYAN_KEEP_ARTIFACTS=1 keeps it. A run killed by SIGKILL cannot clean up:
// it leaves its directory, marked with its pid, and the next run removes every
// such directory whose process is gone. Group hosts not frozen stop by
// themselves when their launcher dies; an arm the scenario driver had frozen
// cannot, so before removing the directory the sweep continues and kills every
// process group the run recorded (arm-groups.mjs; each checked to be still the
// recorded process first) and leaves the directory when one survives.
//
// A run refuses to start outside the test isolation guard: no harness process
// may see the developer's real home, DevRyan data or Git configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_MANIFEST as RUN_MANIFEST_NAME, createRunRoot, scratchParent } from '../qa/run-root.mjs';
import { isolationProblems } from '../test-isolation-check.mjs';
import { killRunRecords } from './arm-groups.mjs';

export const SCRATCH_FAMILY = 'backend-conformance';
const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = fs.constants;

/** A refusal: the run must stop with exit 64 before it writes anything. */
export class RunRefused extends Error {
  constructor(message) { super(message); this.name = 'RunRefused'; }
}

/** Problems that make a run refuse to start: anything but a guarded test environment. */
export function isolationRefusal({ env = process.env, home = os.homedir() } = {}) {
  const problems = isolationProblems({ env, home });
  return problems.length ? `refusing to run outside the test isolation guard (run it through node scripts/test-isolation-guard.mjs or node --import=./scripts/test-isolation-preload.mjs):\n${problems.map((problem) => `  - ${problem}`).join('\n')}` : null;
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const privateDirectoryProblem = (directory, stat) => {
  if (!stat) return `${directory} does not exist`;
  if (stat.isSymbolicLink()) return `${directory} is a symbolic link`;
  if (!stat.isDirectory()) return `${directory} is not a directory`;
  if ((stat.mode & 0o077) !== 0) return `${directory} is not private (mode ${(stat.mode & 0o777).toString(8)})`;
  if (uid() !== null && stat.uid !== uid()) return `${directory} belongs to another user`;
  let real;
  try { real = fs.realpathSync(directory); } catch (error) { return `${directory} cannot be resolved (${error.code})`; }
  if (real !== directory) return `${directory} is not canonical (it resolves to ${real})`;
  return null;
};
const lstatOrNull = (target) => { try { return fs.lstatSync(target); } catch { return null; } };
const PID_FILE = 'harness-pid';
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/**
 * Removes run directories of `parentDirectory` left by runs that were killed
 * (SIGKILL): a plain directory of this user whose pid file names a process
 * that is gone and whose manifest still says running, after the process groups
 * it recorded are killed. Returns what it removed.
 */
export function sweepKilledRuns(parentDirectory) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(parentDirectory); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith('run-')) continue;
    const dir = path.join(parentDirectory, name);
    const stat = lstatOrNull(dir);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (uid() !== null && stat.uid !== uid())) continue;
    let pid;
    let status;
    try { pid = Number(fs.readFileSync(path.join(dir, PID_FILE), 'utf8').trim()); status = JSON.parse(fs.readFileSync(path.join(dir, RUN_MANIFEST_NAME), 'utf8')).status; } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0 || status !== 'running' || processAlive(pid)) continue;
    // What the killed run left frozen or running (its recorded groups) goes first; a survivor keeps the directory for the next sweep.
    if (killRunRecords(dir).some(({ result }) => result === 'survived')) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch { /* the prune tool retries */ }
  }
  return removed;
}

/**
 * Creates the run root. `parent` is for the self-test only (the default is the
 * scratch family's parent). Throws RunRefused when isolation is missing or a
 * path is refused; nothing is written then.
 */
export function createBackendRun({ owner = 'backend-conformance', parent, env = process.env, argv = process.argv, keepArtifacts = false, signals = true, onInterrupt } = {}) {
  const refusal = isolationRefusal({ env });
  if (refusal) throw new RunRefused(refusal);
  const parentDirectory = parent ?? scratchParent(SCRATCH_FAMILY);
  if (!path.isAbsolute(parentDirectory)) throw new RunRefused(`the scratch parent ${parentDirectory} is not absolute`);
  if (!lstatOrNull(parentDirectory)) {
    // Only the last component is created here, private; its parent (the OS temp dir) must exist.
    try { fs.mkdirSync(parentDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new RunRefused(`cannot create the scratch parent ${parentDirectory}: ${error.code}`); }
  }
  const parentProblem = privateDirectoryProblem(parentDirectory, lstatOrNull(parentDirectory));
  if (parentProblem) throw new RunRefused(`refusing the scratch parent: ${parentProblem}`);
  sweepKilledRuns(parentDirectory);
  const dir = fs.mkdtempSync(path.join(parentDirectory, 'run-'));
  // Held: an open descriptor on the directory; its identity is what every write checks.
  let held;
  try { held = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW); } catch (error) { throw new RunRefused(`cannot hold the run directory ${dir}: ${error.code}`); }
  const identity = fs.fstatSync(held);
  const createdProblem = privateDirectoryProblem(dir, lstatOrNull(dir));
  const current = lstatOrNull(dir);
  if (createdProblem || !current || current.dev !== identity.dev || current.ino !== identity.ino) {
    fs.closeSync(held);
    throw new RunRefused(`refusing the run directory: ${createdProblem ?? `${dir} is not the directory that was created`}`);
  }
  const root = createRunRoot({ dir, owner, argv, env, keepArtifacts, signals, onInterrupt });
  // SIGHUP (the terminal closed) ends a run like SIGTERM does.
  let onHangup = null;
  if (signals === true) {
    onHangup = () => {
      Promise.resolve().then(() => onInterrupt?.('SIGHUP')).catch(() => {}).then(() => {
        try { root.finish('interrupted'); } catch { /* identity changed: left in place */ }
        process.exit(129);
      });
    };
    process.on('SIGHUP', onHangup);
  }
  const run = wrapRun(root, { dir, held, identity, dispose: () => { if (onHangup) process.removeListener('SIGHUP', onHangup); } });
  run.writeFile(PID_FILE, `${process.pid}\n`);
  return run;
}

function wrapRun(root, { dir, held, identity, dispose = () => {} }) {
  let closed = false;
  // On Linux, creation goes through the held descriptor (the path cannot be swapped under it).
  const viaHeld = process.platform === 'linux' && lstatOrNull(`/proc/self/fd/${held}`) ? `/proc/self/fd/${held}` : null;
  const creationPath = (relative) => (viaHeld ? path.join(viaHeld, ...relative.split('/')) : path.join(dir, ...relative.split('/')));
  /** Throws unless `dir` still names the held directory, unchanged and canonical. */
  const check = () => {
    if (closed) throw new RunRefused('the run has finished');
    const stat = lstatOrNull(dir);
    const fstat = fs.fstatSync(held);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino || fstat.ino !== identity.ino) {
      throw new RunRefused(`the run directory ${dir} was replaced after it was checked`);
    }
    if (fs.realpathSync(dir) !== dir) throw new RunRefused(`the run directory ${dir} no longer resolves to itself`);
  };
  /** The absolute path of `relative` inside the run, after checking every existing component. */
  const resolveInside = (relative) => {
    if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative)) throw new RunRefused(`not a relative run path: ${String(relative)}`);
    const parts = relative.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0') || part.includes(path.sep))) throw new RunRefused(`not a plain relative run path: ${relative}`);
    check();
    let cursor = dir;
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      const stat = lstatOrNull(cursor);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new RunRefused(`${cursor} is not a plain directory inside the run`);
    }
    const target = path.join(dir, ...parts);
    const last = lstatOrNull(target);
    if (last?.isSymbolicLink()) throw new RunRefused(`${target} is a symbolic link`);
    return target;
  };
  const ensureParents = (relative) => {
    const parts = relative.split('/').slice(0, -1);
    let cursor = dir;
    let created = '';
    for (const part of parts) {
      cursor = path.join(cursor, part);
      created = created ? `${created}/${part}` : part;
      try { fs.mkdirSync(creationPath(created), { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RunRefused(`${cursor} is not a plain directory inside the run`);
    }
  };
  return {
    dir,
    get keepArtifacts() { return root.keepArtifacts; },
    get status() { return root.status; },
    check,
    /** Creates a new private directory inside the run (it must not exist) and returns its path. */
    makeDirectory(relative) {
      const target = resolveInside(relative);
      ensureParents(relative);
      fs.mkdirSync(creationPath(relative), { mode: 0o700 });
      check();
      return target;
    },
    /** Writes a new file inside the run, exclusively, never through a link. Returns its path. */
    writeFile(relative, data, { mode = 0o600 } = {}) {
      const target = resolveInside(relative);
      ensureParents(relative);
      const fd = fs.openSync(creationPath(relative), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, mode);
      try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
      check();
      return target;
    },
    /** Opens a new file inside the run for appending records; the caller closes the descriptor. */
    openNew(relative, { mode = 0o600 } = {}) {
      const target = resolveInside(relative);
      ensureParents(relative);
      const fd = fs.openSync(creationPath(relative), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, mode);
      check();
      return { path: target, fd };
    },
    /** The checked absolute path of something already inside the run (never a link). */
    pathOf(relative) { return resolveInside(relative); },
    /** Ends the run: removes it (unless kept) after run-root checks its identity once more. */
    finish(status) {
      if (closed) return root.status;
      closed = true;
      try { fs.closeSync(held); } catch { /* already closed */ }
      dispose();
      return root.finish(status);
    },
  };
}
