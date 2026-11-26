// Bounded child work for the comparer's tools and tests (package O0d). Every
// wait has an overall deadline that fails with a message naming what was
// running (a file, a scenario, a plant). A child process is stopped on its
// own deadline with its own tree only (`stopTree`: SIGTERM to the child, so a
// tool child stops what it started through its run root; after a grace,
// SIGKILL to the child and to every process listed below it), never with a
// sibling's: one child's deadline leaves the others running. In-process work
// (`withDeadline`) may stop every descendant of this process, so it is only
// for work that runs alone. A process the tool starts is never left to an
// exit hook: a tool killed by SIGINT or SIGTERM stops its descendants through
// its run root (record.mjs `createScratch`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedMarks } from './closure.mjs';
import { stopDescendants } from './record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '../..');

export class DeadlineError extends Error {
  constructor(label, ms) { super(`scheduler conformance: ${label} was still running after ${ms} ms (deadline); every process it started was stopped`); this.name = 'DeadlineError'; this.label = label; }
}

/**
 * `promise` within `ms`, or every descendant of this process stopped and a DeadlineError naming `label`. Only for
 * work that runs alone (nothing else of this process has children then); the timer is cleared on every path.
 */
export async function withDeadline(promise, ms, label) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE), ms); });
  try {
    const result = await Promise.race([promise, expired]);
    if (result === DEADLINE) { await stopDescendants(); throw new DeadlineError(label, ms); }
    return result;
  } finally { clearTimeout(timer); }
}
const DEADLINE = Symbol('deadline');

/** Every process as `ps` lists it now: pid -> { ppid, args } (the full command line, never `comm`). */
function processTable() {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const table = new Map();
  if (listed.status !== 0) return table;
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (match && Number(match[1]) !== listed.pid) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  return table;
}
/** The pids below `root` in a process table, children before their own children. */
function treeBelow(table, root) {
  const children = new Map();
  for (const [pid, { ppid }] of table) { if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid); }
  const out = [];
  const visit = (parent) => { for (const child of children.get(parent) ?? []) { out.push(child); visit(child); } };
  visit(root);
  return out;
}

/**
 * Stops one child and what it started, nothing else. The processes below the child are listed first, while they are
 * still its own; then SIGTERM to the child (a tool child stops its own descendants on it); once it has closed, or
 * after `graceMs`, SIGKILL to the child if it still runs and to every process of that list that is still there with
 * the same command line (a pid the system gave to another program since is left alone). `closed` resolves when the
 * child has closed. A sibling's processes are never in the list.
 */
export async function stopTree(child, closed, { graceMs = 2_000 } = {}) {
  const before = processTable();
  const below = treeBelow(before, child.pid);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    let timer;
    const graceful = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); })]);
    clearTimeout(timer);
    if (!graceful) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  if (below.length === 0) return;
  const after = processTable();
  for (const pid of below) {
    const now = after.get(pid);
    if (now && now.args === before.get(pid).args) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/**
 * Runs `command args` from the repository root, bounded: resolves `{ code, signal, stdout, stderr, expired }` at the
 * child's `close` (its output complete). On the deadline only this child's tree is stopped (`stopTree`) and
 * `expired` is true.
 */
export function runBounded(command, args, { deadlineMs, env = {}, cwd = REPOSITORY }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let markClosed;
    const closed = new Promise((done) => { markClosed = done; });
    const timer = setTimeout(() => { expired = true; void stopTree(child, closed); }, deadlineMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); markClosed(); resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, expired: false, spawnError: error.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); markClosed(); resolve({ code, signal, stdout, stderr, expired }); });
  });
}

/**
 * Runs `bun <args>` and parses its last stdout line as JSON. On the deadline the child and its own children are
 * stopped and `{ error, deadline: true }` names `label`; any other failure is `{ error }`.
 */
export async function bunJson(args, { deadlineMs, label, env = {} }) {
  const done = await runBounded('bun', args, { deadlineMs, env });
  if (done.spawnError) return { error: `${label}: ${done.spawnError}` };
  if (done.expired) return { error: `${label} was still running after ${deadlineMs} ms (deadline); it and what it started were stopped`, deadline: true };
  try { return JSON.parse(done.stdout.trim().split('\n').pop()); } catch { return { error: `${label}: exit ${done.code ?? done.signal}: ${done.stderr.trim().split('\n').slice(-5).join(' | ')}` }; }
}

/** Replays one container against a copy in its own bun process (as closure.mjs `replayFile`), bounded; `{ file, error, deadline? }` on any failure. */
export async function replayBounded(file, { copyDir, json, deadlineMs, label = `the replay of ${path.basename(file)}` }) {
  const done = await bunJson([path.join(HERE, 'replay.mjs'), `--copy=${copyDir}`, `--json=${json}`, file], { deadlineMs, label, env: { DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY: '1' } });
  const recorded = recordedMarks(file);
  if (done.deadline) return { file, recorded, error: done.error, deadline: true };
  if (done.error && !existsSync(json)) return { file, recorded, error: done.error };
  try { return { file, recorded, ...JSON.parse(readFileSync(json, 'utf8')) }; } catch (error) { return { file, recorded, error: `${label}: unreadable replay result: ${error.message}` }; }
}
