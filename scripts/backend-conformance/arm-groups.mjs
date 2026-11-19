// What outlives a harness killed by SIGKILL (BH2 fix; docs/TESTING.md,
// "Backend route-group conformance harness"). An arm leads a process group of
// its own, so when the harness dies no signal reaches it; while the driver has
// it frozen (SIGSTOP) it cannot even read the end of its stdin. Two remedies,
// each enough alone:
//   - the keeper (keeper.mjs): one small process per harness process, in a
//     session of its own, holding a pipe from the harness. Every arm group is
//     handed to it before the arm can be frozen; when the pipe ends (the
//     harness is gone, by any signal) it continues and kills exactly the
//     groups it still holds, then exits;
//   - the record: every arm group (and the keeper) is written into the run
//     directory before the arm can be frozen, and the next run's sweep of
//     killed runs (run-scratch.mjs) continues and kills those groups before it
//     removes the directory.
// A record names the group's leader by pid, start time and a marker of its
// command line (the arm's data root, inside the run directory), so a pid the
// system reused for an unrelated process is never signalled.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupMembers, liveOnly } from './tree.mjs';

export const KEEPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keeper.mjs');
export const RECORDS_DIRECTORY = 'process-groups';

const alive = (target) => { try { process.kill(target, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** `{ start, command }` of each of `pids` that exists (start: the kernel's start time as `ps` prints it). */
export function processFacts(pids) {
  const facts = new Map();
  const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (wanted.length === 0) return facts;
  let text = '';
  try { text = execFileSync('ps', ['-ww', '-o', 'pid=,lstart=,command=', '-p', wanted.join(',')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (error) {
    text = typeof error.stdout === 'string' ? error.stdout : ''; // ps exits 1 when a pid is gone
  }
  for (const line of text.split('\n')) {
    // lstart is five fields: "Wed Nov 19 07:38:12 2026".
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
    if (match) facts.set(Number(match[1]), { start: match[2].replace(/\s+/g, ' '), command: match[3] });
  }
  return facts;
}

/** A record for process `pid` (leading group `pgid`, or null for a process that leads none), as it is now. */
export function recordFor({ kind, pid, pgid = pid, marker, label = null }) {
  const facts = processFacts([pid]).get(pid);
  if (!facts) throw new Error(`process ${pid} (${kind}${label ? ` ${label}` : ''}) is gone before it could be recorded`);
  if (typeof marker !== 'string' || marker === '' || !facts.command.includes(marker)) throw new Error(`process ${pid}'s command line does not hold its marker ${JSON.stringify(marker)}: ${facts.command.slice(0, 300)}`);
  return { kind, pid, pgid, start: facts.start, marker, label };
}
export const recordKey = (record) => `${record.kind}:${record.pid}:${record.start}`;

/** True when the process `record` names is still the one recorded (same start time, marker in its command line). */
export function stillOurs(record, facts = processFacts([record.pid])) {
  const now = facts.get(record.pid);
  return Boolean(now && now.start === record.start && now.command.includes(record.marker));
}

/**
 * Continues and kills what `record` names, synchronously, and waits (bounded)
 * until it is gone. A group is signalled when its leader is still the recorded
 * process, or when the leader is gone and members are left (a group id is not
 * reused while the group has members). Returns 'gone' | 'not-ours' | 'killed' | 'survived'.
 */
export function killRecorded(record, { deadlineMs = 10_000 } = {}) {
  const group = record.pgid !== null && record.pgid !== undefined;
  const target = group ? -record.pgid : record.pid;
  if (!alive(target)) return 'gone';
  const facts = processFacts([record.pid]);
  // A zombie is no process to compare: its group, if members are left, is still the recorded one.
  const leader = facts.get(record.pid);
  const present = Boolean(leader) && !/<defunct>|^\(.*\)$/.test(leader.command.trim());
  // The pid names another process now: never signalled. (A group of ours can only be left without its leader.)
  if (present && !stillOurs(record, facts)) return 'not-ours';
  if (!group && !present) return 'gone';
  for (const signal of ['SIGCONT', 'SIGKILL']) { try { process.kill(target, signal); } catch { /* gone */ } }
  // Gone once nothing but zombies is left (their parent reaps them; this wait may be that parent's thread).
  const running = () => alive(target) && liveOnly(group ? groupMembers(record.pgid) : processAt(record.pid)).length > 0;
  const until = Date.now() + deadlineMs;
  while (running()) {
    if (Date.now() > until) return 'survived';
    sleepSync(20);
  }
  return 'killed';
}

const processAt = (pid) => { try { const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return state ? [{ pid, state }] : []; } catch { return []; } };

/** Reads every record of a run directory (`process-groups/*.json`); unreadable files are skipped. */
export function readRecords(runDirectory) {
  const directory = path.join(runDirectory, RECORDS_DIRECTORY);
  let names = [];
  try { names = fs.readdirSync(directory); } catch { return []; }
  const records = [];
  for (const name of names.sort()) {
    try { const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); if (Number.isInteger(record?.pid) && typeof record.start === 'string' && typeof record.marker === 'string') records.push(record); } catch { /* half written: the process it names was never frozen */ }
  }
  return records;
}

/** The run directories a killed run holds inside it (a self-test's runs in a private parent of its own: `<dir>/<parent>/run-*`). */
const nestedRuns = (runDirectory) => {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(runDirectory, { withFileTypes: true }); } catch { return found; }
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name === RECORDS_DIRECTORY) continue;
    let inner = [];
    try { inner = fs.readdirSync(path.join(runDirectory, entry.name), { withFileTypes: true }); } catch { continue; }
    for (const run of inner) {
      if (!run.isDirectory() || !run.name.startsWith('run-')) continue;
      const dir = path.join(runDirectory, entry.name, run.name);
      // Only a nested run whose own harness is gone too.
      let pid = null;
      try { pid = Number(fs.readFileSync(path.join(dir, 'harness-pid'), 'utf8').trim()); } catch { /* no pid: never started a process */ }
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) found.push(dir);
    }
  }
  return found;
};
/** The sweep's half: kills what a killed run recorded, and what runs nested in it recorded (arm groups and escaped processes first, keepers last). */
export function killRunRecords(runDirectory, options) {
  const records = [runDirectory, ...nestedRuns(runDirectory)].flatMap((dir) => readRecords(dir)).sort((a, b) => Number(a.kind === 'keeper') - Number(b.kind === 'keeper'));
  return records.map((record) => ({ record, result: killRecorded(record, options) }));
}

// ------------------------------------------------------------------ the keeper, from the harness's side
let keeper = null;
let counter = 0;
const keptRuns = new WeakSet();

function startKeeper() {
  const child = spawn(process.execPath, [KEEPER], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const state = { child, acks: new Map(), buffered: '', exited: false, record: null };
  child.on('exit', () => { state.exited = true; for (const resolve of state.acks.values()) resolve(false); state.acks.clear(); if (keeper === state) keeper = null; });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.buffered += chunk;
    let newline;
    while ((newline = state.buffered.indexOf('\n')) >= 0) {
      const line = state.buffered.slice(0, newline);
      state.buffered = state.buffered.slice(newline + 1);
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.ready) state.ready?.(true);
      const key = parsed?.watching;
      if (key && state.acks.has(key)) { state.acks.get(key)(true); state.acks.delete(key); }
    }
  });
  // The keeper never keeps the harness alive: it lives exactly as long as the pipe.
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.();
  state.readyPromise = new Promise((resolve) => { state.ready = resolve; child.once('exit', () => resolve(false)); });
  return state;
}

const withDeadline = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); });
});

/**
 * Hands `record` to the keeper and records it (and, once per run, the keeper)
 * in `run`'s directory. Resolves once both hold it; throws, naming what did
 * not answer, when the keeper does not acknowledge within `deadlineMs`.
 */
export async function keepRecord(run, record, { deadlineMs = 60_000 } = {}) {
  counter += 1;
  run.writeFile(`${RECORDS_DIRECTORY}/${process.pid}-${counter}-${record.kind}.json`, `${JSON.stringify(record)}\n`);
  keeper ??= startKeeper();
  const state = keeper;
  if (!(await withDeadline(state.readyPromise, deadlineMs))) throw new Error(`the keeper (pid ${state.child.pid}) did not start within ${deadlineMs} ms`);
  if (!keptRuns.has(run)) {
    state.record ??= recordFor({ kind: 'keeper', pid: state.child.pid, pgid: null, marker: KEEPER });
    run.writeFile(`${RECORDS_DIRECTORY}/${process.pid}-keeper-${state.child.pid}.json`, `${JSON.stringify(state.record)}\n`);
    keptRuns.add(run);
  }
  const key = recordKey(record);
  const acknowledged = new Promise((resolve) => { state.acks.set(key, resolve); });
  state.child.stdin.write(`${JSON.stringify({ watch: record })}\n`);
  if (!(await withDeadline(acknowledged, deadlineMs))) throw new Error(`the keeper (pid ${state.child.pid}) did not acknowledge ${key} within ${deadlineMs} ms`);
  return key;
}
/** Tells the keeper a group is gone (it no longer needs killing). */
export function forgetRecord(key) { if (keeper && !keeper.exited) keeper.child.stdin.write(`${JSON.stringify({ forget: key })}\n`); }
/** The keeper's pid (tests), or null when none runs. */
export const keeperPid = () => (keeper && !keeper.exited ? keeper.child.pid : null);
