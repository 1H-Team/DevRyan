// The native ledger's child processes (ledger-native/src/node/child.rs and
// net.rs: `child_process.spawn`, its stdio sockets, `pipeline` into its
// stdin) against Node's own, in the reduced form of research file 33: what
// the language defines stays exact; of what Node's library decides on top
// of the loop only these rules are kept (DOCUMENTATION.md, "Node's library
// on the loop"):
//   1. a completion never settles in the checkpoint that started it (the
//      `spawn` event, a run-time spawn error and a write that goes at once
//      come on a tick of that checkpoint, as Node's own order);
//   2. the events of one source keep their order: an output's data before
//      its end, its end before its close; the child's exit before its close,
//      which comes after every output's close (or inside the last one);
//   3. independent sources may arrive in any order.
// Arms: Electron's Node (the reference), the Node running this test
// (information), and the Rust (`ledger-native-probe child-cases` /
// `child-programs`).
//
// - Outcomes (child-spec.mjs): each case one child, run to its end on every
//   arm in its own scratch directory: each source's events in order
//   (consecutive data collapsed) exactly, the cross-source rules, the error
//   objects, output bytes and the final state exactly (fields a case marks
//   loose as sets: a stdin pipeline's outcome must be one Electron's Node
//   gives in that situation, its error object Node's own; how far a child
//   ran ahead of a slow consumer within its bound); around every case each
//   arm's descriptor count, live children, helper threads and open sources
//   come back, and no child is left a zombie. Cases that need the
//   descriptor limit run on a second pair of arms started under
//   `ulimit -n 256`; so does the check that an `error` nobody listens to
//   ends the process (F2 of the O2e review).
// - Programs (child-programs.mjs, named and seeded): each arm's trace must
//   have Electron's pure part and (the Rust) Electron's strands entry for
//   entry, times and frames included (each event of each child is a strand
//   of its own), keep rule 1 per event source (the Rust prints its measured
//   checkpoint epoch) and rule 2 per child.
//
// The gate runs every case, the named programs and 40 random ones; the
// extended run (LEDGER_NATIVE_ODB_EXTENDED=1) 1,000 programs over five
// seeds. Every wait has a deadline and names what it waited for; an arm
// that timed out once fails its later cases at once, and a program arm
// stops at its first stuck program, so a planted hang costs one deadline,
// not one per case. The scratch is removed on success and failure; only
// children (and a case's grandchild) the arms started are signalled.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXTENDED_VARIABLE, LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { keepArtifactsRequested, scratchParent } from '../qa/run-root.mjs';
import { AHEAD_BOUND, CASES, EXTENDED_CASES } from './child-spec.mjs';
import { FIXED_PROGRAMS, generatePrograms, prepareDir, withEnv } from './child-programs.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = referenceRuntime();
const extended = process.env[EXTENDED_VARIABLE] === '1';
const SEEDS = extended ? [7, 19, 31, 43, 61] : [7];
const PER_SEED = extended ? 200 : 40;
const STEP_MS = 60_000;
// A program batch's deadline: each program has its own (20 s, after which the
// arm stops), but an arm whose loop is blocked cannot keep it.
const BATCH_MS = extended ? 600_000 : 120_000;
const PATH_ENV = [['PATH', process.env.PATH ?? '/usr/bin:/bin']];

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
let scratch;
const arms = [];
/** The arms under `ulimit -n 256` (Electron's Node and the Rust), started for the first case that needs them. */
let limitedArms = null;
/** `sh -c 'ulimit -n 256 && exec …'`: a command started with 256 descriptors at most (low enough to take them all, high enough for Electron to start). */
const underLimit = (command, args) => ['/bin/sh', ['-c', 'ulimit -n 256 && exec "$0" "$@"', command, ...args]];

/** One case server: a long-lived process answering one line per line, each within its deadline. */
function caseServer(name, command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '', stderr = '';
  const waiting = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      waiting.shift()?.resolve(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code, signal) => { for (const entry of waiting.splice(0)) entry.reject(new Error(`${name} exited (${code ?? signal}) while answering: ${stderr.slice(-2000)}`)); });
  return {
    name,
    request(request) {
      return new Promise((resolve, reject) => {
        // A server that died answers nothing more: fail at once, not after the deadline.
        if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(`${name} exited (${child.exitCode ?? child.signalCode}): ${stderr.slice(-2000)}`)); return; }
        const timer = setTimeout(() => reject(new Error(`${name} did not answer ${JSON.stringify(request).slice(0, 300)} within ${STEP_MS / 1000} s`)), STEP_MS);
        waiting.push({ resolve: (line) => { clearTimeout(timer); resolve(JSON.parse(line)); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    close: () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('exit', () => resolve()); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }),
  };
}

const jsArgs = (mode) => ['--expose-internals', '--no-warnings', path.join(here, 'child-js-arm.mjs'), mode];

before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(fs.existsSync(probe), `${probe} does not exist`);
  const parent = scratchParent('ledger-native');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  scratch = fs.mkdtempSync(path.join(parent, 'child-'));
  arms.push({ name: 'electron', server: caseServer('Electron\'s Node', reference.command, jsArgs('cases'), reference.env) });
  if (reference.electron) arms.push({ name: 'node', server: caseServer(`this Node ${process.version}`, process.execPath, jsArgs('cases'), {}) });
  arms.push({ name: 'rust', server: caseServer('the Rust', probe, ['child-cases'], {}) });
});

after(async () => {
  for (const arm of [...arms, ...(limitedArms ?? [])]) await arm.server.close();
  if (scratch) {
    const failed = process.exitCode !== undefined && process.exitCode !== 0;
    if (!(failed && keepArtifactsRequested())) fs.rmSync(scratch, { recursive: true, force: true });
  }
  dispose();
});

/** The case for one arm: its directories, files and links made, `./` paths and `<dir>` in its directory, PATH first in the environment (unless `noPath`). */
function resolved(entry, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of entry.dirs ?? []) fs.mkdirSync(path.join(dir, sub.name), { recursive: true });
  for (const file of entry.files ?? []) { fs.writeFileSync(path.join(dir, file.name), file.text); fs.chmodSync(path.join(dir, file.name), file.mode); }
  for (const link of entry.links ?? []) fs.symlinkSync(link.to, path.join(dir, link.name));
  const local = (value) => (typeof value === 'string' && value.startsWith('./') ? path.join(dir, value.slice(2)) + (value === './' ? '/' : '') : value);
  const env = [...(entry.noPath ? [] : PATH_ENV), ...(entry.env ?? [])].map(([key, value]) => [key, value.split('<dir>').join(dir)]);
  const stdout = entry.stdout?.watch ? { ...entry.stdout, watch: local(entry.stdout.watch) } : entry.stdout;
  const kill = entry.kill?.map((kill) => (kill.check ? { ...kill, check: local(kill.check) } : kill));
  return { ...entry, file: local(entry.file), cwd: entry.cwd === './' ? dir : entry.cwd, env, stdout, kill, reap: entry.reap && path.join(dir, entry.reap) };
}

/** The stdin pipeline's error object as Node makes it for `code` (`ErrnoException(-errno, 'write')`, or the premature close). */
export function writingErrorOf(code) {
  if (code === 'ERR_STREAM_PREMATURE_CLOSE') return { name: 'Error', message: 'Premature close', code };
  const errno = os.constants.errno[code];
  return errno === undefined ? undefined : { name: 'Error', message: `write ${code}`, errno: -errno, code, syscall: 'write' };
}

/** Replaces the arm's root directory by `<root>` in every string. */
function rooted(value, roots) {
  if (typeof value === 'string') { let text = value; for (const root of roots) text = text.split(root).join('<root>'); return text; }
  if (Array.isArray(value)) return value.map((item) => rooted(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rooted(item, roots)]));
  return value;
}

/** `ps` on a pid: whether it is a zombie child of `parent` (no signal is sent). */
function zombieOf(pid, parent) {
  if (!Number.isInteger(pid)) return false;
  const shown = spawnSync('ps', ['-o', 'ppid=,stat=', '-p', String(pid)], { encoding: 'utf8' });
  const [ppid, stat] = shown.stdout.trim().split(/\s+/);
  return Number(ppid) === parent && /Z/.test(stat ?? '');
}

/**
 * Each source's events in order, consecutive data collapsed. A stdin's
 * `finish` is left out: it needs the shutdown to complete before the exit
 * destroys the stdin, which is arrival's when the child does not wait for its
 * input's end (the order rules still see it).
 */
function perSource(events) {
  const out = {};
  for (const [source, name, value] of events) {
    if (source === 'stdin' && name === 'finish') continue;
    const list = (out[source] ??= []);
    const shown = value === undefined ? name : `${name}=${value}`;
    if (shown === 'data' && list.at(-1) === 'data') continue;
    list.push(shown);
  }
  return out;
}

/** What a case record breaks of rule 2 (empty when it keeps it). */
export function caseRules(record) {
  const problems = [];
  const events = record.events ?? [];
  const at = (source, name) => events.findIndex(([s, n]) => s === source && n === name);
  const child = events.filter(([source]) => source === 'child').map(([, name]) => name);
  if (child.length && !['spawn', 'error'].includes(child[0])) problems.push(`the child's first event is ${child[0]}`);
  const close = at('child', 'close');
  if (close === -1) problems.push('the child never closed');
  else if (child.at(-1) !== 'close') problems.push('a child event after close');
  const exit = at('child', 'exit');
  if (exit !== -1 && close !== -1 && exit > close) problems.push('exit after close');
  let after = 0;
  for (const source of ['stdout', 'stderr']) {
    const own = events.map((event, index) => ({ event, index })).filter(({ event }) => event[0] === source);
    if (!own.length) continue;
    const kinds = own.map(({ event }) => event[1]);
    const end = kinds.indexOf('end'), lastData = kinds.lastIndexOf('data'), shut = kinds.indexOf('close');
    if (end !== -1 && lastData > end) problems.push(`${source}: data after end`);
    if (shut === -1) problems.push(`${source}: never closed`);
    else if (shut !== kinds.length - 1) problems.push(`${source}: an event after close`);
    if (end !== -1 && shut !== -1 && end > shut) problems.push(`${source}: end after close`);
    const closedAt = own.find(({ event }) => event[1] === 'close')?.index ?? -1;
    if (close !== -1 && closedAt > close) {
      // Only inside the last output's close: what runs between is the child's close listeners.
      after += 1;
      if (events.slice(close + 1, closedAt).some(([s]) => s !== 'kill' && s !== 'child')) problems.push(`${source}: closed after the child's close, not inside it`);
    }
  }
  if (after > 1) problems.push('the child closed before both outputs had');
  return problems;
}

/** The compared part of a record, the loose fields set aside. */
function compared(record, entry) {
  const { events, pidNumber: _pid, ...rest } = record;
  const sources = perSource(events ?? []);
  const loose = entry.loose ?? {};
  delete rest.ahead;
  if (loose.stdin) delete sources.stdin;
  if (loose.writing) { delete sources.writing; delete rest.writing; delete rest.writingError; }
  if (loose.out) delete rest.out;
  if (loose.err) rest.err = rest.err.length;
  return { sources, rest };
}

/** Runs one case on one arm: census before and after, the record, the zombie check. */
async function runCase(arm, entry, index) {
  // An arm stuck once (its own child killed by its deadline) fails the rest at once.
  assert.ok(!arm.stuck, `${arm.name} timed out in "${arm.stuck}" before; its later cases are not run against it`);
  // `<scratch>/<arm>/case<i>`: the same name on every arm, its root replaced in every string.
  const root = path.join(scratch, arm.name), dir = path.join(root, `case${index}`);
  // A server that does not answer in time is stuck too (its loop blocked).
  const ask = async (request) => { try { return await arm.server.request(request); } catch (error) { arm.stuck = entry.name; throw error; } };
  const before = await ask({ op: 'census' });
  const raw = await ask({ case: resolved(entry, dir) });
  const roots = [...new Set([fs.realpathSync(scratch), scratch])].map((base) => path.join(base, arm.name)).sort((a, b) => b.length - a.length);
  const record = rooted(raw, roots);
  if (record.timeout) arm.stuck = entry.name;
  assert.ok(!record.timeout, `${arm.name}: ${record.timeout}`);
  // Every close a case waits for is in; what is left in flight is the case's.
  let census = await ask({ op: 'census' });
  for (let tries = 0; tries < 50 && JSON.stringify(census) !== JSON.stringify(before); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    census = await ask({ op: 'census' });
  }
  assert.deepEqual(census, before, `${arm.name} left something of "${entry.name}" open after 1 s (descriptors, children, helper threads, sources)`);
  assert.ok(!zombieOf(record.pidNumber, before.pid), `${arm.name} left child ${record.pidNumber} a zombie after "${entry.name}"`);
  fs.rmSync(dir, { recursive: true, force: true });
  return record;
}

const canonical = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

function firstDifference(expected, actual, at = '') {
  if (canonical(expected) === canonical(actual)) return null;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const found = firstDifference(expected[key], actual[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  return `${at}: ${JSON.stringify(expected)?.slice(0, 600)} != ${JSON.stringify(actual)?.slice(0, 600)}`;
}

describe('child processes: outcomes against Electron\'s Node, field by field', () => {
  (extended ? [...CASES, ...EXTENDED_CASES] : CASES).forEach((entry, index) => {
    test(`outcome: ${entry.name}`, async () => {
      const records = {};
      if (entry.free !== undefined) {
        limitedArms ??= [
          { name: 'electron', server: caseServer('Electron\'s Node under ulimit -n 256', ...underLimit(reference.command, jsArgs('cases')), reference.env) },
          { name: 'rust', server: caseServer('the Rust under ulimit -n 256', ...underLimit(probe, ['child-cases']), {}) },
        ];
      }
      for (const arm of entry.free !== undefined ? limitedArms : arms) records[arm.name] = await runCase(arm, entry, index);
      for (const [name, record] of Object.entries(records)) assert.deepEqual(record.thrown ? [] : caseRules(record), [], `${name} breaks rule 2: ${JSON.stringify(record.events)}`);
      const difference = firstDifference(compared(records.electron, entry), compared(records.rust, entry));
      assert.equal(difference, null, `the Rust differs from Electron's Node at ${difference}\n  electron: ${JSON.stringify(records.electron.events)}\n  rust:     ${JSON.stringify(records.rust.events)}`);
      for (const [name, record] of Object.entries(records)) {
        if (entry.loose?.writing) {
          assert.ok(entry.loose.writing.includes(record.writing), `${name}: writing ${record.writing} is not one of ${entry.loose.writing}`);
          assert.deepEqual(record.writingError, writingErrorOf(record.writing), `${name}: the pipeline's ${record.writing} is not Node's error object`);
        }
        if (entry.loose?.out) assert.ok(record.out.length > 100_000, `${name}: read ${record.out.length} bytes`);
        if (entry.loose?.ahead !== undefined) {
          assert.ok(Number.isFinite(record.ahead) && record.ahead <= entry.loose.ahead, `${name}: the child ran ${record.ahead} bytes ahead of its consumer (bound ${entry.loose.ahead})`);
        }
      }
      if (entry.loose?.chunks !== undefined) {
        const chunks = (record) => record.events.filter(([source, name]) => source === 'stdout' && name === 'data').length;
        assert.ok(chunks(records.rust) <= entry.loose.chunks * chunks(records.electron), `the Rust took ${chunks(records.rust)} chunks where Electron's Node took ${chunks(records.electron)}: its reads are smaller than Node's`);
      }
      if (entry.loose?.ahead !== undefined) console.log(`information: "${entry.name}": ahead ${Object.entries(records).map(([name, record]) => `${name} ${record.ahead}`).join(', ')} (bound ${AHEAD_BOUND})`);
      if (records.node) {
        const nodes = firstDifference(compared(records.electron, entry), compared(records.node, entry));
        if (nodes) console.log(`information: this Node ${process.version} differs from Electron's Node in "${entry.name}" at ${nodes}`);
      }
    });
  });
});

describe('child processes: an error nobody listens to ends the process', () => {
  test('at the descriptor limit, a spawn with no error listener: the process dies of the uncaught EMFILE on both arms (F2)', () => {
    const run = (name, command, args, env) => {
      const [shell, shellArgs] = underLimit(command, args);
      const result = spawnSync(shell, shellArgs, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      // The deadline's kill is the only SIGKILL; the Rust's panic aborts (SIGABRT), Node exits non-zero.
      assert.ok(!result.error && result.signal !== 'SIGKILL', `${name} did not end within 30 s: ${result.error ?? result.signal}`);
      assert.ok(result.status !== 0, `${name} survived an 'error' nobody listened to (exit ${result.status ?? result.signal}): ${result.stdout}`);
      assert.ok(!result.stdout.includes('survived'), `${name} went on after the uncaught error`);
      return result.stderr;
    };
    assert.match(run('Electron\'s Node', reference.command, jsArgs('emfile-uncaught'), reference.env), /spawn sh EMFILE/);
    assert.match(run('the Rust', probe, ['child-emfile-uncaught'], {}), /'error' nobody listened to: spawn sh EMFILE/);
  });
});

// The programs.

/** One entry of a trace: its strand (`undefined` when pure), its text without the unit, its unit. */
export function parse(trace) {
  return trace.split(' ').filter(Boolean).map((raw, index) => {
    const match = /^(?:io:([^:]+):)?(.*)#(\d+)$/.exec(raw);
    if (!match) return { index, strand: undefined, text: raw, unit: -1 };
    return { index, strand: match[1], text: match[2], unit: Number(match[3]) };
  });
}

/** The pure part and each strand, consecutive data entries collapsed (chunk boundaries are arrival's). */
function projection(entries) {
  const pure = entries.filter((entry) => entry.strand === undefined).map((entry) => entry.text);
  const strands = {};
  for (const entry of entries) {
    if (entry.strand === undefined) continue;
    // A stdin's finish races the exit that destroys it (see perSource).
    if (/^[^.]+\.0\.finish@/.test(entry.text)) continue;
    const list = (strands[entry.strand] ??= []);
    const repeated = /\.(?:\d\.d|c)@/.test(entry.text) && list.at(-1) === entry.text;
    if (!repeated) list.push(entry.text);
  }
  return { pure, strands };
}

/** Strands whose first entry is on a tick of the starting checkpoint (Node's own order). */
const SAME_CHECKPOINT = new Set(['spawn', 'error', 'wcb']);

/** What one arm's trace breaks of rules 1 and 2 (empty when it keeps them). */
export function broken(entries) {
  const problems = [];
  const starts = entries.filter((entry) => /^[^=@.]+>@/.test(entry.text));
  for (const start of starts) {
    const name = /^([^>]+)>/.exec(start.text)[1];
    const lastOfStart = Math.max(...entries.filter((entry) => entry.unit === start.unit).map((entry) => entry.index));
    const strands = new Set(entries.filter((entry) => entry.strand === name || entry.strand?.startsWith(`${name}.`)).map((entry) => entry.strand));
    for (const strand of strands) {
      const first = entries.find((entry) => entry.strand === strand);
      const kind = strand.slice(name.length + 1);
      if (first.index < start.index) problems.push(`${strand}: before its start`);
      if (SAME_CHECKPOINT.has(kind)) {
        if (first.unit !== start.unit) problems.push(`${strand}: not on a tick of the checkpoint that started it (#${start.unit}, #${first.unit})`);
      } else if (kind !== 'kill') {
        if (first.unit === start.unit) problems.push(`${strand}: settled in the checkpoint that started it (#${start.unit})`);
        if (first.index < lastOfStart) problems.push(`${strand}: before the end of its starting checkpoint`);
      }
    }
    // Rule 2 per child (spawn statements).
    const own = (strand) => entries.filter((entry) => entry.strand === `${name}.${strand}`);
    const textAt = (strand, kind) => entries.findIndex((entry) => entry.strand === `${name}.${strand}` && entry.text.startsWith(`${name}.${kind}`));
    const closeAt = textAt('close', 'close=');
    if (strands.has(`${name}.spawn`) || strands.has(`${name}.error`)) {
      if (strands.has(`${name}.spawn`) === strands.has(`${name}.error`)) problems.push(`${name}: spawn and error, or neither`);
      if (closeAt === -1) problems.push(`${name}: never closed`);
      const exitAt = textAt('exit', 'exit=');
      if (exitAt !== -1 && closeAt !== -1 && exitAt > closeAt) problems.push(`${name}: exit after close`);
      let late = 0;
      for (const fd of ['0', '1', '2']) {
        // The stream's own events (a listener's body entries are its strand's too).
        const events = own(fd).filter((entry) => entry.text.startsWith(`${name}.${fd}.`));
        const kinds = events.map((entry) => /^[^.]+\.\d\.([a-z]+)/.exec(entry.text)?.[1]);
        if (!kinds.length) continue;
        const end = kinds.indexOf('end'), lastData = kinds.lastIndexOf('d'), shut = kinds.indexOf('close'), finish = kinds.indexOf('finish');
        if (end !== -1 && lastData > end) problems.push(`${name}.${fd}: data after end`);
        if (shut === -1) problems.push(`${name}.${fd}: never closed`);
        else if (shut !== kinds.length - 1) problems.push(`${name}.${fd}: an event after close`);
        if (end !== -1 && finish !== -1 && finish < end) problems.push(`${name}.${fd}: finish before end`);
        if (fd === '0' || shut === -1 || closeAt === -1) continue;
        const shutAt = entries.indexOf(events[shut]);
        if (shutAt > closeAt) {
          late += 1;
          if (entries.slice(closeAt + 1, shutAt).some((entry) => entry.strand !== `${name}.close`)) problems.push(`${name}.${fd}: closed after the child's close, not inside it`);
        }
      }
      if (late > 1) problems.push(`${name}: closed before both outputs had`);
    }
    // git(): its loop, then one ending, then the end.
    const git = entries.filter((entry) => entry.strand === name && entry.text.startsWith(`${name}.`));
    if (git.length && !strands.has(`${name}.close`) && !strands.has(`${name}.spawn`) && !strands.has(`${name}.error`)) {
      const kinds = git.map((entry) => /^[^.]+\.([a-z]+)/.exec(entry.text)?.[1]);
      const ends = kinds.filter((kind) => ['done', 'broke', 'caught'].includes(kind));
      if (kinds.at(-1) !== 'end') problems.push(`${name}: git() did not end last`);
      if (!ends.length || ends.length > 2) problems.push(`${name}: git() without one way out of its loop`);
      if (kinds.lastIndexOf('c') > kinds.findIndex((kind) => ['done', 'broke', 'caught'].includes(kind))) problems.push(`${name}: a chunk after the loop ended`);
    }
  }
  return problems;
}

/** Runs `programs` on one arm (a fresh directory per program); its traces. */
function runPrograms(arm, programs, tag) {
  const dirs = programs.map((program, index) => {
    const dir = path.join(scratch, `${tag}-${arm}-${index}`);
    prepareDir(dir, program);
    return dir;
  });
  // `<dir>` in a program (a child's environment) is its directory.
  const input = programs.map((program, index) => `${JSON.stringify({ dir: dirs[index], program: withEnv(program, PATH_ENV) }).split('<dir>').join(dirs[index])}\n`).join('');
  const [command, args, env] = arm === 'rust' ? [probe, ['child-programs'], {}] : arm === 'electron' ? [reference.command, jsArgs('programs'), reference.env] : [process.execPath, jsArgs('programs'), {}];
  const run = spawnSync(command, args, { input, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: BATCH_MS, killSignal: 'SIGKILL' });
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  const answered = String(run.stdout ?? '').split('\n').filter(Boolean);
  assert.ok(!run.error && run.signal === null, `${arm} did not finish within ${BATCH_MS / 1000} s; stuck in program ${answered.length}: ${JSON.stringify(programs[answered.length])?.slice(0, 2000)}`);
  assert.equal(run.status, 0, `${arm} failed: ${String(run.stderr).slice(-3000)}`);
  const traces = answered.slice(0, programs.length);
  const failedRun = traces.findIndex((trace) => trace.startsWith('!'));
  assert.equal(failedRun, -1, `${arm}, program ${failedRun}: ${traces[failedRun]}`);
  return traces;
}

function comparePrograms(programs, tag, names = []) {
  const traces = { electron: runPrograms('electron', programs, tag), rust: runPrograms('rust', programs, tag) };
  if (reference.electron) traces.node = runPrograms('node', programs, tag);
  const problems = [];
  let identical = 0, entries = 0, nodeDiffers = 0;
  programs.forEach((program, index) => {
    const name = names[index] ?? `program ${index}: ${JSON.stringify(program).slice(0, 1500)}`;
    const parsed = Object.fromEntries(Object.entries(traces).map(([arm, list]) => [arm, parse(list[index])]));
    entries += parsed.electron.length;
    for (const [arm, list] of Object.entries(parsed)) for (const problem of broken(list)) problems.push(`${name}\n  ${arm} breaks a rule: ${problem}\n  trace: ${traces[arm][index]}`);
    const expected = projection(parsed.electron), actual = projection(parsed.rust);
    const difference = firstDifference(expected, actual);
    if (difference) problems.push(`${name}\n  the Rust differs from Electron's Node at ${difference}\n  electron: ${traces.electron[index]}\n  rust:     ${traces.rust[index]}`);
    if (parsed.node && firstDifference(expected, projection(parsed.node))) nodeDiffers += 1;
    const strip = (list) => list.map((entry) => `${entry.strand ?? ''}:${entry.text}`).join(' ');
    if (strip(parsed.electron) === strip(parsed.rust)) identical += 1;
  });
  return { problems, identical, entries, nodeDiffers };
}

describe('child processes: programs on Electron\'s Node, this Node and the Rust', () => {
  test(`the ${FIXED_PROGRAMS.length} named programs keep rules 1 and 2, and their pure part and strands are Electron's`, () => {
    const { problems, identical, entries, nodeDiffers } = comparePrograms(FIXED_PROGRAMS.map((entry) => entry.program), 'named', FIXED_PROGRAMS.map((entry) => entry.name));
    assert.deepEqual(problems.slice(0, 5), [], `${problems.length} problems`);
    console.log(`${FIXED_PROGRAMS.length} named child programs, ${entries} entries: all admissible; ${identical} in Electron's own interleaving too; this Node differs in ${nodeDiffers} (information)`);
  });
  for (const seed of SEEDS) {
    test(`${PER_SEED} random child programs of seed ${seed} keep rules 1 and 2, and their pure part and strands are Electron's`, () => {
      const programs = generatePrograms(seed, PER_SEED);
      const { problems, identical, entries, nodeDiffers } = comparePrograms(programs, `seed${seed}`);
      assert.deepEqual(problems.slice(0, 5), [], `${problems.length} problems`);
      console.log(`seed ${seed}: ${programs.length} child programs, ${entries} entries: all admissible; ${identical} in Electron's own interleaving too; this Node differs in ${nodeDiffers} (information)`);
    });
  }
  if (extended) {
    test('100 children at once, each a strand of its own, keep the rules and Electron\'s strands', () => {
      const program = { main: Array.from({ length: 100 }, (_, at) => ({ s: 'spawn', l: `k${at}`, file: 'sh', args: ['-c', at % 2 ? 'printf abc; printf de >&2' : 'printf x; exit 3'], input: 'end', consume: 'data' })) };
      const { problems } = comparePrograms([program], 'wide', ['100 children at once']);
      assert.deepEqual(problems.slice(0, 3), [], `${problems.length} problems`);
    });
  }
  test('the constraints are not vacuous: a settlement in the starting checkpoint, close before exit, data after end, close on exit alone are refused', () => {
    const good = 'k0>@1000#0 io:k0.spawn:k0.spawn@1000#0 io:k0.1:k0.1.d@1000#1 io:k0.1:k0.1.end@1000#2 io:k0.exit:k0.exit=0,null,true@1000#3 io:k0.2:k0.2.end@1000#4 io:k0.2:k0.2.close=false@1000#5 io:k0.close:k0.close=0,null@1000#6 io:k0.1:k0.1.close=false@1000#6';
    assert.deepEqual(broken(parse(good)), []);
    assert.match(broken(parse(good.replace('k0.exit=0,null,true@1000#3', 'k0.exit=0,null,true@1000#0'))).join('; '), /k0\.exit: settled in the checkpoint that started it/);
    assert.match(broken(parse(good.replace('io:k0.spawn:k0.spawn@1000#0', 'io:k0.spawn:k0.spawn@1000#1'))).join('; '), /k0\.spawn: not on a tick/);
    assert.match(broken(parse('k0>@1000#0 io:k0.spawn:k0.spawn@1000#0 io:k0.close:k0.close=0,null@1000#2 io:k0.exit:k0.exit=0,null,true@1000#3 io:k0.1:k0.1.close=false@1000#1 io:k0.2:k0.2.close=false@1000#1')).join('; '), /exit after close/);
    assert.match(broken(parse(good.replace('io:k0.1:k0.1.end@1000#2', 'io:k0.1:k0.1.end@1000#2 io:k0.1:k0.1.d@1000#2'))).join('; '), /data after end/);
    const early = 'k0>@1000#0 io:k0.spawn:k0.spawn@1000#0 io:k0.exit:k0.exit=0,null,true@1000#1 io:k0.close:k0.close=0,null@1000#1 io:k0.1:k0.1.end@1000#2 io:k0.1:k0.1.close=false@1000#3 io:k0.2:k0.2.close=false@1000#4';
    assert.match(broken(parse(early)).join('; '), /closed (after the child's close|before both outputs)/);
    assert.deepEqual(caseRules({ events: [['child', 'spawn'], ['stdout', 'end'], ['stdout', 'close', false], ['child', 'exit', '0,null,true'], ['stderr', 'close', false], ['child', 'close', '0,null']] }), []);
    assert.match(caseRules({ events: [['child', 'spawn'], ['child', 'exit', '0'], ['child', 'close', '0'], ['stdout', 'end'], ['stdout', 'close', false], ['stderr', 'close', false]] }).join('; '), /closed after the child's close|before both outputs/);
  });
});
