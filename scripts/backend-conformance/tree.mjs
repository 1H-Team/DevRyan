// The state an arm leaves, and the processes that leave it (BH2; design file
// 31 §5.3, §5.4, §7 "Inode"): the data-root walk (S1, S2), the descriptors the
// driver holds across an exchange, the files an arm still has open, and the
// arm's process group (members, freeze and thaw, gone).
//
// Every wait here is bounded and names what did not happen. Nothing decides by
// elapsed time: a freeze is confirmed by the kernel's process state, a group is
// gone when the kernel has no member of it, and a walk is consistent when two
// walks in a row agree.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TREE_LIMITS = Object.freeze({ freezeMs: 60_000, goneMs: 60_000, pollMs: 20 });

/** A wait that passed its deadline; `what` names what did not answer. */
export class DeadlineError extends Error {
  constructor(what, ms) { super(`${what} within ${ms} ms`); this.name = 'DeadlineError'; this.what = what; }
}
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ------------------------------------------------------------------ the walk
const TYPE = (stat) => (stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other');
const digestFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** A file this user may not read (its mode): its digest is unknown, which the walk says instead of failing. */
const unreadable = (error) => error?.code === 'EACCES';

/**
 * One walk of `root`: the root's own permission bits (`rootMode`), and
 * every entry below it with its relative path, type, permission bits, size, content digest (files), link
 * target (links), inode and mtime (recorded, never compared as values), and
 * each directory's names in the order the OS listed them. Links are never
 * followed. A file whose mode forbids reading it is `unreadable: true`, with no digest.
 */
export function walkTree(root, { digests = true } = {}) {
  const entries = [];
  const order = {};
  const visit = (relative) => {
    const absolute = relative ? path.join(root, ...relative.split('/')) : root;
    const names = fs.readdirSync(absolute);
    order[relative || '.'] = names;
    for (const name of [...names].sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(absolute, name);
      const stat = fs.lstatSync(file);
      const type = TYPE(stat);
      const entry = { path: child, type, mode: stat.mode & 0o7777, size: type === 'dir' ? null : stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs };
      if (type === 'file' && digests) {
        try { entry.sha256 = digestFile(file); } catch (error) { if (!unreadable(error)) throw error; entry.unreadable = true; }
      }
      if (type === 'symlink') entry.target = fs.readlinkSync(file);
      entries.push(entry);
      if (type === 'dir') visit(child);
    }
  };
  visit('');
  return { entries, order, rootMode: fs.lstatSync(root).mode & 0o7777 };
}

const factsOf = ({ ino: _ino, mtimeMs: _mtime, ...rest }) => rest;
/** The part of a walk that two consistent walks must share (inode and mtime are facts of the walk, compared elsewhere by rule); the other tracked roots included. */
export const treeFingerprint = (tree) => JSON.stringify({ entries: tree.entries.map(factsOf), order: tree.order, rootMode: tree.rootMode ?? null, ...(tree.roots ? { roots: Object.fromEntries(Object.entries(tree.roots).map(([name, other]) => [name, { entries: other.entries.map(factsOf), order: other.order, rootMode: other.rootMode ?? null }])) } : {}) });

/**
 * A consistent snapshot: two walks that agree. Taken only when nothing can
 * write (the arm frozen, quiescent or gone); when the walks disagree the tree
 * moved under the walk, and the snapshot says so (`stable: false`) instead
 * of choosing one. `between` runs between the two walks (the self-test moves the tree there).
 */
export function snapshotTree(root, { between = null, others = {} } = {}) {
  const walk = () => ({ ...walkTree(root), ...(Object.keys(others).length ? { roots: Object.fromEntries(Object.entries(others).map(([name, other]) => [name, walkTree(other)])) } : {}) });
  const first = walk();
  between?.(); // the self-test's way to move the tree between the walks
  const second = walk();
  const stable = treeFingerprint(first) === treeFingerprint(second);
  return { ...second, stable, ...(stable ? {} : { firstWalk: first }) };
}

/**
 * The paths whose recorded state differs between two snapshots (added,
 * removed or changed), sorted; a path of another tracked root is prefixed
 * with its name (`home:.config/x`).
 */
export function treeChanges(before, after) {
  const changed = [];
  const compare = (left, right, prefix) => {
    const key = (entry) => JSON.stringify(factsOf(entry));
    const was = new Map((left?.entries ?? []).map((entry) => [entry.path, key(entry)]));
    const now = new Map((right?.entries ?? []).map((entry) => [entry.path, key(entry)]));
    for (const [file, value] of was) if (now.get(file) !== value) changed.push(`${prefix}${file}`);
    for (const file of now.keys()) if (!was.has(file)) changed.push(`${prefix}${file}`);
    if (JSON.stringify(left?.order ?? {}) !== JSON.stringify(right?.order ?? {})) changed.push(`${prefix}(listing order)`);
    if ((left?.rootMode ?? null) !== (right?.rootMode ?? null)) changed.push(`${prefix}(root mode)`);
  };
  compare(before, after, '');
  for (const name of new Set([...Object.keys(before.roots ?? {}), ...Object.keys(after.roots ?? {})])) compare(before.roots?.[name], after.roots?.[name], `${name}:`);
  return [...new Set(changed)].sort();
}

/** Copies the tree at `root` into `into` (a new directory), modes kept and links copied as links. */
export function copyTree(root, into) {
  fs.cpSync(root, into, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
  fs.chmodSync(into, fs.statSync(root).mode & 0o7777);
}

/** Makes `root` hold exactly what `from` holds (its own directory kept, so its identity and the arm's path stay). */
export function restoreTree(from, root) {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(from)) fs.cpSync(path.join(from, name), path.join(root, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  fs.chmodSync(root, fs.statSync(from).mode & 0o7777);
}

// ------------------------------------------------------------------ held descriptors
const heldSets = new Set();
/** Every descriptor the driver holds right now (an exchange in progress holds some; between steps none). */
export const heldDescriptorCount = () => [...heldSets].reduce((sum, set) => sum + set.size, 0);

/**
 * Opens and holds a descriptor on every regular file under `roots` (design
 * §5.3 step 1): while it is open the file's inode cannot be reused, so
 * `release()` can tell a file rewritten in place from one replaced (a new
 * inode at the path) or removed. `release()` closes every descriptor and
 * returns `{ replaced, removed }` (relative paths, `<root index>:<path>`).
 */
export function holdDescriptors(roots) {
  const held = new Map();
  heldSets.add(held);
  roots.forEach((root, index) => {
    // Types only: the descriptors need no digest (a digest walk per exchange is the snapshots' cost).
    for (const entry of walkTree(root, { digests: false }).entries) {
      if (entry.type !== 'file') continue;
      const file = path.join(root, ...entry.path.split('/'));
      let fd;
      try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) {
        // A file nobody may read cannot be held: its inode is taken by lstat, so a replacement is seen unless the
        // file system gives the new file the old one's number (no descriptor keeps that number taken).
        if (!unreadable(error)) throw error;
        held.set(`${index}:${entry.path}`, { fd: null, file, ino: entry.ino });
        continue;
      }
      held.set(`${index}:${entry.path}`, { fd, file, ino: fs.fstatSync(fd).ino });
    }
  });
  let released = null;
  return {
    get size() { return held.size; },
    release() {
      if (released) return released;
      const replaced = [];
      const removed = [];
      for (const [key, { fd, file, ino }] of held) {
        try {
          const now = fs.lstatSync(file);
          if (now.ino !== ino || (fd !== null && fs.fstatSync(fd).ino !== ino)) replaced.push(key);
        } catch (error) { if (error.code === 'ENOENT') removed.push(key); else throw error; }
      }
      for (const { fd } of held.values()) { if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ } }
      held.clear();
      heldSets.delete(held);
      released = { replaced: replaced.sort(), removed: removed.sort() };
      return released;
    },
  };
}
/** Closes every held descriptor (teardown). */
export function releaseAllHeld() { for (const held of [...heldSets]) { for (const { fd } of held.values()) { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } } held.clear(); heldSets.delete(held); } }

// ------------------------------------------------------------------ process groups
/** The members of process group `pgid`: `[{ pid, state }]` (the kernel's state letters, `T` for stopped). */
export function groupMembers(pgid, table = processTable()) {
  return table.filter((row) => row.pgid === pgid).map(({ pid, state }) => ({ pid, state }));
}
/** Every process: `[{ pid, ppid, pgid, state }]`. */
export function processTable() {
  const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4] });
  }
  return rows;
}
/**
 * The live descendants of group `pgid`'s members that are outside the group
 * (a child that made a session or group of its own): found by parent pid, so
 * a process whose parent has already exited is no longer linked to the arm.
 */
export function escapedDescendants(pgid, table = processTable()) {
  const children = new Map();
  for (const row of table) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row); }
  const queue = table.filter((row) => row.pgid === pgid);
  const seen = new Set(queue.map((row) => row.pid));
  const escaped = [];
  while (queue.length) {
    const row = queue.shift();
    for (const child of children.get(row.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (child.pgid !== pgid && liveOnly([child]).length) escaped.push(child);
      queue.push(child);
    }
  }
  return escaped;
}

/** True while any process of group `pgid` exists (zombies included). */
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
/** Sends `signal` to every member of group `pgid`; false when the group is gone. */
export function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
/** Members that can still run: not a zombie (Z, X) and not already exiting (E). */
export const liveOnly = (members) => members.filter((member) => !/^[ZX]/.test(member.state) && !member.state.includes('E'));
const live = liveOnly;
/** Waits until every live member of `pgid` satisfies `test(state)`; throws DeadlineError naming the members that did not. */
async function waitForStates(pgid, test, what, { deadlineMs, pollMs = TREE_LIMITS.pollMs }) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const table = processTable();
    const members = live(groupMembers(pgid, table));
    const late = members.filter((member) => !test(member.state));
    // The table of the last look goes with the members (the escape walk reads it: no second ps).
    if (late.length === 0) return Object.assign(members, { table });
    if (Date.now() > until) throw new DeadlineError(`${what}: ${late.map((member) => `pid ${member.pid} (${member.state})`).join(', ')}`, deadlineMs);
    await pause(pollMs);
  }
}

/**
 * Freezes group `pgid` (SIGSTOP to the group) and resolves once the kernel
 * reports every live member stopped. Returns the members.
 */
export async function freezeGroup(pgid, { deadlineMs = TREE_LIMITS.freezeMs } = {}) {
  if (!signalGroup(pgid, 'SIGSTOP')) throw new Error(`process group ${pgid} is gone; it cannot be frozen`);
  return waitForStates(pgid, (state) => state.startsWith('T'), `process group ${pgid} did not stop`, { deadlineMs });
}
/** Continues group `pgid` (SIGCONT) and resolves once no live member is stopped. */
export async function thawGroup(pgid, { deadlineMs = TREE_LIMITS.freezeMs } = {}) {
  if (!signalGroup(pgid, 'SIGCONT')) return [];
  return waitForStates(pgid, (state) => !state.startsWith('T'), `process group ${pgid} did not continue`, { deadlineMs });
}
/**
 * Runs `action(members)` with group `pgid` frozen (its stopped members), and continues the group afterwards
 * on every path (the action's failure included). Returns the action's result.
 */
export async function whileFrozen(pgid, action, options = {}) {
  let frozen = false;
  try {
    const members = await freezeGroup(pgid, options).finally(() => { frozen = true; });
    return await action(members);
  } finally {
    if (frozen) await thawGroup(pgid, options);
  }
}

/** Resolves once no process of group `pgid` is left; throws DeadlineError naming the survivors. */
export async function groupGone(pgid, { deadlineMs = TREE_LIMITS.goneMs, pollMs = TREE_LIMITS.pollMs } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (!groupAlive(pgid)) return;
    if (Date.now() > until) throw new DeadlineError(`process group ${pgid} still has ${groupMembers(pgid).map((member) => `pid ${member.pid} (${member.state})`).join(', ') || 'members'}`, deadlineMs);
    await pause(pollMs);
  }
}

// ------------------------------------------------------------------ open files
/**
 * The files under `roots` that processes `pids` hold open, as
 * `[{ pid, file }]` (absolute, canonical). Linux reads /proc; elsewhere the
 * system's lsof. A file opened through another spelling of a root is found by
 * its canonical path.
 */
export function openFilesUnder(pids, roots) {
  const canonical = roots.map((root) => fs.realpathSync(root));
  const under = (file) => canonical.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
  const found = [];
  if (pids.length === 0) return found;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      let names = [];
      try { names = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const name of names) { let target; try { target = fs.readlinkSync(`/proc/${pid}/fd/${name}`); } catch { continue; } if (under(target)) found.push({ pid, file: target }); }
    }
    return found;
  }
  let text = '';
  try { text = execFileSync('lsof', ['-n', '-P', '-w', '-F', 'pn', '-p', pids.join(',')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (error) {
    // lsof exits 1 when it lists nothing (or a pid is gone); what it printed still counts.
    text = typeof error.stdout === 'string' ? error.stdout : '';
  }
  let pid = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) { const file = line.slice(1); if (under(file)) found.push({ pid, file }); }
  }
  return found;
}
