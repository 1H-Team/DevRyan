// The native ledger's `node` module (ledger-native/src/node: the
// `fs.promises` facade, the file read stream, `zlib.deflate`) against
// Node's own, in the reduced form of research file 33: what the language
// defines stays exact, and of what Node's library decides on top of the
// loop only three rules are kept (DOCUMENTATION.md, "Node's library on the
// loop"):
//   1. a completion never settles in the checkpoint that started it;
//   2. the events of one source keep their order;
//   3. the receipt byte stream's file reads are Node's cut (128 KiB reads, a short last one).
// Arms: Electron's Node (the reference), the Node running this test, and
// the Rust (`ledger-native-probe fs-steps` / `fs-programs`).
//
// - Outcomes (fs-spec.mjs): every built call on real files in scratch, one
//   step at a time on all three arms, each in its own directory: results and
//   error objects field by field, a stat's fields against Node's own stat of
//   that arm's file right after the step, and the tree afterwards.
// - Rule 3: the cut of a 128 KiB read stream (and the default 64 KiB) over
//   files of many sizes, byte for byte (length and FNV-1a of every chunk)
//   against Electron's Node and the file itself, and over a file that grows
//   or shrinks between two reads (changed while no read is in flight).
// - Rule 2: a `for await` ends after the stream's close; leaving it (return
//   at once, or while a read is in flight) closes the descriptor; errors.
// - Rule 1 and the rest: I/O programs (fs-programs.mjs: the named ones and
//   seeded random ones) on all three arms. Node's internal job and round
//   trip counts are not reproduced, so the traces are not compared entry
//   for entry. Each arm's trace must satisfy the same constraints:
//   (a) its pure part (the entries that descend from no I/O completion) is
//       Electron's, entry for entry, with times and frames;
//   (b) each I/O strand (what descends from one completion) is Electron's,
//       entry for entry, with times and frames (for the Rust; the system
//       Node's strands are information: its library's other job counts
//       inside a call, such as a stream iterator's `return()`, can move a
//       strand's own jobs against the continuation);
//   (c) rule 1: an I/O call's first continuation is in a later checkpoint
//       than its start and after every entry of the starting checkpoint
//       (the Rust prints its measured checkpoint epoch; the JavaScript arm
//       prints the unit Node's construction gives each entry);
//   (d) rule 2: a stream's values in order, then end or error (not both),
//       then close, nothing after; a `for await`'s values in order, then its end.
//   The interleaving between strands, and between strands and the pure
//   part, is what arrival leaves free; both orders satisfy (a) to (d).
//
// The gate runs every case, the cut tests, the named programs and 60
// random programs; the extended run (LEDGER_NATIVE_ODB_EXTENDED=1) 2,000
// programs over five seeds. Every wait has a deadline that names what did
// not answer; the scratch is removed on success and failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { EXTENDED_VARIABLE, LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { keepArtifactsRequested, scratchParent } from '../qa/run-root.mjs';
import { FIXED_PROGRAMS, fileBytes, fnv, generatePrograms, prepareDir } from './fs-programs.mjs';
import { CASES, CUT_SIZES } from './fs-spec.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = referenceRuntime();
const extended = process.env[EXTENDED_VARIABLE] === '1';
const SEEDS = extended ? [7, 19, 31, 43, 61] : [7];
const PER_SEED = extended ? 400 : 60;
/** How long one step may take on one arm (generous: CI and loaded machines). */
const STEP_MS = 60_000;
/** How long one arm may take for one batch of programs. */
const BATCH_MS = 600_000;
const K128 = 128 * 1024;

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
let scratch;
const arms = [];

/** One step server: a long-lived process answering one line per line, each within its deadline. */
function stepServer(name, command, args, env) {
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
  child.on('exit', (code, signal) => { for (const entry of waiting.splice(0)) entry.reject(new Error(`${name} exited (${code ?? signal}): ${stderr.slice(-2000)}`)); });
  return {
    name,
    request(step) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name} did not answer ${JSON.stringify(step).slice(0, 300)} within ${STEP_MS / 1000} s`)), STEP_MS);
        waiting.push({ resolve: (line) => { clearTimeout(timer); resolve(JSON.parse(line)); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify(step)}\n`);
      });
    },
    close: () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('exit', () => resolve()); child.stdin.end(); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }),
  };
}

const jsArgs = (mode) => ['--expose-internals', '--no-warnings', path.join(here, 'fs-js-arm.mjs'), mode];

before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(fs.existsSync(probe), `${probe} does not exist`);
  const parent = scratchParent('ledger-native');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  scratch = fs.mkdtempSync(path.join(parent, 'fs-'));
  arms.push({ name: 'electron', server: stepServer('Electron\'s Node', reference.command, jsArgs('steps'), reference.env) });
  if (reference.electron) arms.push({ name: 'node', server: stepServer(`this Node ${process.version}`, process.execPath, jsArgs('steps'), {}) });
  arms.push({ name: 'rust', server: stepServer('the Rust', probe, ['fs-steps'], {}) });
});

after(async () => {
  for (const arm of arms) await arm.server.close();
  if (scratch) {
    const failed = process.exitCode !== undefined && process.exitCode !== 0;
    if (!(failed && keepArtifactsRequested())) { makeWritable(scratch); fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  dispose();
});

function makeWritable(root) {
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    try { fs.chmodSync(dir, 0o700); } catch { /* gone */ }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(path.join(dir, entry.name));
  };
  walk(root);
}

/** Builds a case's tree in `root`. */
function buildTree(root, tree) {
  fs.mkdirSync(root, { recursive: true });
  const modes = [];
  for (const [kind, rel, a, b] of tree) {
    const at = path.join(root, rel);
    if (kind === 'dir') { fs.mkdirSync(at, { recursive: true }); if (a !== undefined) modes.push([at, a]); }
    else if (kind === 'file') { fs.writeFileSync(at, a); if (b !== undefined) modes.push([at, b]); }
    else if (kind === 'bytes') fs.writeFileSync(at, fileBytes(a, 11));
    else if (kind === 'link') fs.symlinkSync(a, at);
    else if (kind === 'rawlink') fs.symlinkSync(Buffer.from(a, 'hex'), at);
    else if (kind === 'rawfile') fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from(rel, 'hex')]), 'raw');
    else if (kind === 'mode') modes.push([at, a]);
  }
  modes.sort((left, right) => right[0].length - left[0].length);
  for (const [at, mode] of modes) fs.chmodSync(at, mode);
}

/** A name or target as compared: its text, and its bytes in hex when they are not UTF-8. */
const shownBytes = (bytes) => { const text = bytes.toString('utf8'); return Buffer.from(text).equals(bytes) ? text : `${text} [${bytes.toString('hex')}]`; };

/** The tree as compared afterwards: per entry its type, permission bits, and for files size, links and contents, for links the target's bytes. */
function snapshot(root, timed = []) {
  const out = {};
  const walk = (rel) => {
    const at = Buffer.from(path.join(root, rel));
    for (const raw of fs.readdirSync(at, { encoding: 'buffer' }).sort(Buffer.compare)) {
      const name = shownBytes(raw);
      const child = rel ? `${rel}/${name}` : name, full = Buffer.concat([at, Buffer.from('/'), raw]);
      const stat = fs.lstatSync(full);
      const entry = { type: stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'other', mode: (stat.mode & 0o7777).toString(8) };
      if (stat.isFile()) Object.assign(entry, { size: stat.size, nlink: stat.nlink, sha: createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) });
      if (stat.isSymbolicLink()) entry.target = shownBytes(fs.readlinkSync(full, { encoding: 'buffer' }));
      if (timed.includes(child)) Object.assign(entry, { atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs });
      out[child] = entry;
      if (stat.isDirectory()) { const mode = stat.mode; try { fs.chmodSync(full, 0o700); walk(path.join(rel, raw.toString('utf8'))); } finally { fs.chmodSync(full, mode & 0o7777); } }
    }
  };
  walk('');
  return out;
}

const STAT_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs'];

/** A stat outcome checked against Node's own stat of the same file, right after the step: each field `=`, or what differs. */
function witnessed(stats, file, follow) {
  if (!file) return stats;
  let number, big;
  try {
    number = follow ? fs.statSync(file) : fs.lstatSync(file);
    big = follow ? fs.statSync(file, { bigint: true }) : fs.lstatSync(file, { bigint: true });
  } catch (error) { return { ...stats, witness: error.code }; }
  const out = { type: stats.type, bigint: stats.bigint, mode: stats.mode, nlink: stats.nlink, size: stats.size };
  for (const key of [...STAT_FIELDS, ...(stats.bigint ? ['atimeNs', 'mtimeNs', 'ctimeNs'] : [])]) {
    const expected = stats.bigint ? String(big[key]) : number[key];
    out[key] = stats[key] === expected ? '=' : `${stats[key]} != ${expected}`;
  }
  return out;
}

/** The fields of a `statfs` outcome checked against Node's own `statfsSync` of the same path right after the step. */
function witnessedFs(statfs, file) {
  const bigint = typeof statfs.bsize === 'string';
  let own;
  try { own = fs.statfsSync(file, { bigint }); } catch (error) { return { ...statfs, witness: error.code }; }
  const out = { type: statfs.type, bsize: statfs.bsize };
  // Free space moves with whatever else writes to the disk meanwhile: equal
  // within a thousandth of the blocks (bavail and bfree differ by the
  // reserve, 5% on ext4; they are equal on APFS).
  const slack = Number(own.blocks) / 1000;
  for (const key of ['blocks', 'bfree', 'bavail', 'files', 'ffree']) {
    const difference = Math.abs(Number(statfs[key]) - Number(own[key]));
    const near = key === 'blocks' ? difference === 0 : key.startsWith('b') ? difference <= slack : true;
    out[key] = near && typeof statfs[key] === typeof (bigint ? String(own[key]) : own[key]) ? '=' : `${statfs[key]} != ${own[key]}`;
  }
  return out;
}

/** Replaces the arm's directory (and its real path) by `<root>` in every string. */
function rooted(value, roots) {
  if (typeof value === 'string') { let text = value; for (const root of roots) text = text.split(root).join('<root>'); return text; }
  if (Array.isArray(value)) return value.map((item) => rooted(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rooted(item, roots)]));
  return value;
}

/** An error's compared fields in a fixed order. */
const errorFields = (error) => Object.fromEntries(['name', 'message', 'code', 'errno', 'syscall', 'path', 'dest', 'value'].filter((key) => error[key] !== undefined).map((key) => [key, error[key]]));

const resolvePath = (root, rel) => (rel === undefined ? undefined : rel.startsWith('/') ? rel : rel === '.' ? root : path.join(root, rel));

/** Runs one case on one arm in `root`: the normalized outcomes and the tree. */
async function runCase(arm, entry, root, tag) {
  buildTree(root, entry.tree);
  const roots = [fs.realpathSync(root), root].sort((left, right) => right.length - left.length);
  const handles = new Map();
  const outcomes = [];
  const fdsBefore = (await arm.server.request({ op: 'fds' })).ok;
  for (const raw of entry.steps) {
    const step = { ...raw };
    for (const key of ['path', 'src', 'dest']) if (step[key] !== undefined) step[key] = resolvePath(root, step[key]);
    if (step.h) step.h = `${tag}:${step.h}`;
    if (step.as) step.as = `${tag}:${step.as}`;
    if (Array.isArray(step.flags)) step.flags = step.flags.reduce((bits, name) => bits | fs.constants[name], 0);
    const outcome = await arm.server.request(step);
    if (step.op === 'open' && outcome.ok !== undefined) handles.set(step.as, step.path);
    let shown = outcome;
    if (outcome.err) shown = { err: errorFields(outcome.err) };
    else if (outcome.ok && typeof outcome.ok === 'object' && 'blksize' in outcome.ok) {
      const file = raw.op === 'h.stat' ? handles.get(step.h) : step.path;
      shown = { ok: witnessed(outcome.ok, file, raw.op !== 'lstat' && raw.op !== 'lstatSync') };
    } else if (raw.op === 'statfs' && outcome.ok) {
      shown = { ok: witnessedFs(outcome.ok, step.path) };
    } else if (raw.op === 'deflate' && outcome.ok !== undefined) {
      const input = raw.b64 !== undefined ? Buffer.from(raw.b64, 'base64') : Buffer.from(raw.text ?? '', 'utf8');
      shown = { ok: { inflates: zlib.inflateSync(Buffer.from(outcome.ok, 'base64')).equals(input) } };
    }
    outcomes.push({ op: raw.op, ...rooted(shown, roots) });
  }
  const fdsAfter = (await arm.server.request({ op: 'fds' })).ok;
  const tree = snapshot(root, entry.timed);
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
  // A call that leaks its descriptor (on success or on failure) shows here.
  assert.equal(fdsAfter, fdsBefore, `${arm.name} left ${fdsAfter - fdsBefore} descriptors open after "${entry.name}"`);
  return { outcomes, tree };
}

/** JSON with object keys sorted (objects compare by content, not key order). */
const canonical = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

/** The first difference between two values, for the message. */
function firstDifference(expected, actual, at = '') {
  if (canonical(expected) === canonical(actual)) return null;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const found = firstDifference(expected[key], actual[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  return `${at}: ${JSON.stringify(expected)?.slice(0, 400)} != ${JSON.stringify(actual)?.slice(0, 400)}`;
}

let caseIndex = 0;
describe('the node module\'s outcomes against Node\'s fs.promises, FileHandle and zlib.deflate', () => {
  for (const entry of CASES) {
    test(`outcome: ${entry.name}`, { skip: entry.linuxOnly && process.platform !== 'linux' ? 'Linux only' : false }, async () => {
      const tag = `c${caseIndex++}`;
      const results = {};
      for (const arm of arms) results[arm.name] = await runCase(arm, entry, path.join(scratch, `${tag}-${arm.name}`), tag);
      const difference = firstDifference(results.electron, results.rust);
      assert.equal(difference, null, `the Rust differs from Electron's Node at ${difference}`);
      if (results.node) {
        const nodes = firstDifference(results.electron, results.node);
        if (nodes) console.log(`information: this Node ${process.version} differs from Electron's Node in "${entry.name}" at ${nodes}`);
      }
      // A failure case must fail somewhere, so the case is not vacuous.
      if (/missing|EEXIST|refused|permission|a directory|dangling|middle/.test(entry.name)) assert.ok(results.electron.outcomes.some((outcome) => outcome.err), `${entry.name}: no step failed`);
    });
  }
});

/** The (length, FNV-1a) of every chunk a 128 KiB-style read stream gives, via one arm's steps. */
async function cut(arm, file, hwm, name, between = () => {}) {
  await arm.server.request({ op: 'rs.create', s: name, path: file, hwm });
  const chunks = [];
  for (let at = 0; at < 10_000; at++) {
    const step = await arm.server.request({ op: 'rs.next', s: name });
    if (step.err) { chunks.push({ err: step.err.code }); break; }
    if (step.ok.done) break;
    chunks.push([step.ok.length, step.ok.fnv]);
    await between(at, name);
  }
  const state = await arm.server.request({ op: 'rs.state', s: name });
  return { chunks, closed: state.ok.closed };
}

/** What Node's cut must be for an unchanging regular file: `hwm` bytes a read, a short last one. */
function expectedCut(bytes, hwm) {
  const out = [];
  for (let at = 0; at < bytes.length; at += hwm) { const chunk = bytes.subarray(at, at + hwm); out.push([chunk.length, fnv(chunk)]); }
  return out;
}

let cutIndex = 0;
describe('rule 3: the read stream\'s cut is Node\'s', () => {
  for (const hwm of [K128, 64 * 1024]) {
    test(`a ${hwm / 1024} KiB read stream over files of ${CUT_SIZES.length} sizes gives Node's chunks byte for byte, and ends after its close`, async () => {
      const failures = [];
      for (const size of CUT_SIZES) {
        const bytes = fileBytes(size, size & 255);
        const results = {};
        for (const arm of arms) {
          const file = path.join(scratch, `cut-${cutIndex}-${arm.name}`);
          fs.writeFileSync(file, bytes);
          results[arm.name] = await cut(arm, file, hwm, `cut${cutIndex}`);
          fs.rmSync(file, { force: true });
        }
        cutIndex += 1;
        const expected = expectedCut(bytes, hwm);
        if (JSON.stringify(results.electron.chunks) !== JSON.stringify(expected)) failures.push(`${size} bytes: Electron's Node is not the expected cut: ${JSON.stringify(results.electron.chunks).slice(0, 300)}`);
        if (JSON.stringify(results.rust.chunks) !== JSON.stringify(results.electron.chunks)) failures.push(`${size} bytes: the Rust ${JSON.stringify(results.rust.chunks).slice(0, 300)} != Electron's ${JSON.stringify(results.electron.chunks).slice(0, 300)}`);
        for (const arm of arms) if (!results[arm.name].closed) failures.push(`${size} bytes: ${arm.name}'s for await ended before its stream closed`);
      }
      assert.deepEqual(failures, []);
    });
  }

  // A file changed between two reads, while none is in flight (the stream
  // has read ahead and waits): the next read sees the change on both arms.
  // (Changed while a read is in flight, the outcome is a race in Node too.)
  const CHANGES = [
    { name: 'grows by 100,000 bytes after the first chunk', size: 300_000, at: 0, change: (file) => fs.appendFileSync(file, fileBytes(100_000, 99)) },
    { name: 'grows after its short last read was buffered', size: 140_000, at: 0, change: (file) => fs.appendFileSync(file, fileBytes(5000, 98)) },
    { name: 'shrinks below the next read', size: 400_000, at: 0, change: (file) => fs.truncateSync(file, 200_000) },
    { name: 'shrinks below what was already read', size: 400_000, at: 0, change: (file) => fs.truncateSync(file, 10_000) },
    { name: 'shrinks inside the read after next', size: 600_000, at: 1, change: (file) => fs.truncateSync(file, 3 * K128 + 77) },
  ];
  for (const change of CHANGES) {
    test(`a 128 KiB read stream over a file that ${change.name} gives Electron's chunks`, async () => {
      const results = {};
      for (const arm of arms) {
        const file = path.join(scratch, `change-${cutIndex}-${arm.name}`);
        fs.writeFileSync(file, fileBytes(change.size, 5));
        results[arm.name] = await cut(arm, file, K128, `chg${cutIndex}`, async (at, name) => {
          if (at !== change.at) return;
          const idle = await arm.server.request({ op: 'rs.idle', s: name });
          assert.ok(!idle.timeout, `${arm.name}: ${idle.timeout}`);
          change.change(file);
        });
        fs.rmSync(file, { force: true });
      }
      cutIndex += 1;
      assert.deepEqual(results.rust, results.electron);
      if (results.node) assert.deepEqual(results.node.chunks, results.electron.chunks, 'this Node cuts it differently');
    });
  }
});

let streamIndex = 0;
describe('rule 2: a read stream\'s events keep their order, and leaving it closes it', () => {
  const big = 600_000;
  /** Steps on every arm in their own file; returns each arm's outcomes. */
  const onEveryArm = async (size, script) => {
    const results = {};
    for (const arm of arms) {
      const file = path.join(scratch, `rs-${streamIndex}-${arm.name}`);
      if (size !== null) fs.writeFileSync(file, fileBytes(size, 3));
      const name = `rs${streamIndex}`;
      const ask = (op, extra = {}) => arm.server.request({ op, s: name, ...extra });
      results[arm.name] = await script(ask, file);
      fs.rmSync(file, { force: true, recursive: true });
    }
    streamIndex += 1;
    return results;
  };
  test('for await left at once (return) destroys the stream and closes its descriptor; the descriptor count comes back', async () => {
    const results = await onEveryArm(big, async (ask, file) => {
      const before = (await ask('fds')).ok;
      await ask('rs.create', { path: file, hwm: K128 });
      const first = await ask('rs.next');
      const returned = await ask('rs.return');
      const closed = await ask('rs.waitClosed');
      const state = await ask('rs.state');
      const afterwards = (await ask('fds')).ok;
      return { first: first.ok.length, returned: returned.ok, closed: !closed.timeout, state: state.ok.destroyed && state.ok.closed, fdsBack: afterwards === before };
    });
    for (const [name, result] of Object.entries(results)) assert.deepEqual(result, { first: K128, returned: { done: true }, closed: true, state: true, fdsBack: true }, name);
  });
  test('for await left while a read is in flight waits for that read, then closes the descriptor', async () => {
    const results = await onEveryArm(big, async (ask, file) => {
      const before = (await ask('fds')).ok;
      await ask('rs.create', { path: file, hwm: K128 });
      await ask('rs.next');
      // No idle: the read of the second chunk is in flight.
      const returned = await ask('rs.return');
      const closed = await ask('rs.waitClosed');
      const state = await ask('rs.state');
      return { returned: returned.ok, closed: !closed.timeout, read: state.ok.bytesRead, fdsBack: (await ask('fds')).ok === before };
    });
    // Whether the second read lands before the return is a race on every
    // arm: landed, bytesRead counts it; still in flight, the destroyed
    // stream discards it (Node's _read callback returns before counting).
    // Either way the descriptor is closed only after it (the Rust asserts
    // that where it closes; unit a_read_stream_never_closes_…).
    for (const [name, result] of Object.entries(results)) {
      assert.deepEqual({ ...result, read: undefined }, { returned: { done: true }, closed: true, read: undefined, fdsBack: true }, name);
      assert.ok([K128, 2 * K128].includes(result.read), `${name}: bytesRead ${result.read} is neither the first read nor the first two`);
    }
  });
  test('a missing file: the first next rejects with ENOENT (open), nothing is left open', async () => {
    const results = await onEveryArm(null, async (ask, file) => {
      const before = (await ask('fds')).ok;
      await ask('rs.create', { path: file, hwm: K128 });
      const next = await ask('rs.next');
      const state = await ask('rs.state');
      return { err: next.err && errorFields(next.err).code, syscall: next.err?.syscall, state: state.ok, fdsBack: (await ask('fds')).ok === before };
    });
    for (const [name, result] of Object.entries(results)) assert.deepEqual({ ...result, state: { ...result.state, bytesRead: 0 } }, { err: 'ENOENT', syscall: 'open', state: { destroyed: true, closed: true, bytesRead: 0 }, fdsBack: true }, name);
  });
  test('a directory: it opens, the first next rejects with EISDIR (read), then the descriptor is closed', async () => {
    const results = await onEveryArm(null, async (ask, file) => {
      fs.mkdirSync(file);
      const before = (await ask('fds')).ok;
      await ask('rs.create', { path: file, hwm: K128 });
      const next = await ask('rs.next');
      await ask('rs.waitClosed');
      const state = await ask('rs.state');
      return { err: next.err?.code, syscall: next.err?.syscall, message: next.err?.message, closed: state.ok.closed, fdsBack: (await ask('fds')).ok === before };
    });
    for (const [name, result] of Object.entries(results)) assert.deepEqual(result, results.electron, name);
    assert.equal(results.electron.err, 'EISDIR');
  });
  test('a next after the end gives done again; return after the end is done', async () => {
    const results = await onEveryArm(1000, async (ask, file) => {
      await ask('rs.create', { path: file, hwm: K128 });
      const steps = [];
      for (let at = 0; at < 4; at++) steps.push((await ask('rs.next')).ok);
      steps.push((await ask('rs.return')).ok);
      return steps;
    });
    assert.deepEqual(results.rust, results.electron);
  });
});

// The I/O programs.

/** One entry of a trace: its strand (`undefined` when pure), its text without the unit, its unit. */
function parse(trace) {
  return trace.split(' ').filter(Boolean).map((raw, index) => {
    const match = /^(?:io:([^:]+):)?(.*)#(\d+)$/.exec(raw);
    if (!match) return { index, strand: undefined, text: raw, unit: -1 };
    return { index, strand: match[1], text: match[2], unit: Number(match[3]) };
  });
}

const projection = (entries) => {
  const pure = entries.filter((entry) => entry.strand === undefined).map((entry) => entry.text);
  const strands = {};
  for (const entry of entries) if (entry.strand !== undefined) (strands[entry.strand] ??= []).push(entry.text);
  return { pure, strands };
};

/** What one arm's trace breaks of rules 1 and 2 (empty when it keeps them). */
function broken(entries, program) {
  const problems = [];
  const label = (entry) => /^([^=>@!.~]+)/.exec(entry.text)?.[1];
  // Rule 1: each start `L>` and its first continuation (the first entry of strand L).
  for (const start of entries.filter((entry) => /^[^=@]+>@/.test(entry.text))) {
    const name = /^([^>]+)>/.exec(start.text)[1];
    const first = entries.find((entry) => entry.strand === name);
    if (!first) continue;
    if (first.unit === start.unit) problems.push(`${name}: continued in the checkpoint that started it (#${start.unit})`);
    const lastOfStart = Math.max(...entries.filter((entry) => entry.unit === start.unit).map((entry) => entry.index));
    if (first.index < lastOfStart) problems.push(`${name}: continued before the end of its starting checkpoint`);
    if (first.index < start.index) problems.push(`${name}: continued before it started`);
  }
  // Rule 2: per stream, per for await.
  const statements = [];
  const collect = (body) => { for (const st of body ?? []) { statements.push(st); collect(st.body); } };
  collect(program.main);
  for (const fn of program.fns ?? []) collect(fn.body);
  // Only what ran (a stream made in a callback that never ran has no start).
  const started = new Set(entries.map((entry) => /^([^>@]+)>@/.exec(entry.text)?.[1]).filter(Boolean));
  for (const st of statements.filter((item) => (item.s === 'stream' || item.s === 'forAwait') && started.has(item.l))) {
    const own = entries.filter((entry) => entry.strand === st.l && label(entry) === st.l && entry.text.startsWith(`${st.l}.`));
    const kinds = own.map((entry) => /^[^.]+\.(close|caught|done|end|err|d|c)(\d*)/.exec(entry.text)).filter(Boolean).map((match) => ({ kind: match[1], at: match[2] === '' ? null : Number(match[2]) }));
    const values = kinds.filter((item) => item.kind === 'd' || item.kind === 'c');
    values.forEach((item, at) => { if (item.at !== at) problems.push(`${st.l}: value ${item.at} out of order`); });
    const lastValue = kinds.findLastIndex((item) => item.kind === 'd' || item.kind === 'c');
    if (st.s === 'stream') {
      const end = kinds.findIndex((item) => item.kind === 'end'), error = kinds.findIndex((item) => item.kind === 'err'), close = kinds.findIndex((item) => item.kind === 'close');
      if (end !== -1 && error !== -1) problems.push(`${st.l}: both end and error`);
      if (end !== -1 && end < lastValue) problems.push(`${st.l}: a value after end`);
      if (error !== -1 && error < lastValue) problems.push(`${st.l}: a value after error`);
      if (close === -1) problems.push(`${st.l}: never closed`);
      else if (close !== kinds.length - 1 || kinds.filter((item) => item.kind === 'close').length > 1) problems.push(`${st.l}: an event after close`);
      if (close !== -1 && (end > close || error > close)) problems.push(`${st.l}: end or error after close`);
    } else {
      const ends = kinds.filter((item) => item.kind === 'done' || item.kind === 'caught');
      if (ends.length !== 1 || (kinds.at(-1)?.kind !== 'done' && kinds.at(-1)?.kind !== 'caught')) problems.push(`${st.l}: for await without exactly one end, last`);
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
  const input = programs.map((program, index) => `${JSON.stringify({ dir: dirs[index], program })}\n`).join('');
  const [command, args, env] = arm === 'rust' ? [probe, ['fs-programs'], {}] : arm === 'electron' ? [reference.command, jsArgs('programs'), reference.env] : [process.execPath, jsArgs('programs'), {}];
  const run = spawnSync(command, args, { input, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: BATCH_MS, killSignal: 'SIGKILL' });
  for (const dir of dirs) { makeWritable(dir); fs.rmSync(dir, { recursive: true, force: true }); }
  const answered = String(run.stdout ?? '').split('\n').filter(Boolean);
  assert.ok(!run.error && run.signal === null, `${arm} did not finish within ${BATCH_MS / 1000} s; stuck in program ${answered.length}: ${JSON.stringify(programs[answered.length])?.slice(0, 2000)}`);
  assert.equal(run.status, 0, `${arm} failed: ${String(run.stderr).slice(-3000)}`);
  const traces = answered.slice(0, programs.length);
  const failedRun = traces.findIndex((trace) => trace.startsWith('!'));
  assert.equal(failedRun, -1, `${arm}, program ${failedRun}: ${traces[failedRun]}`);
  return traces;
}

/** Compares the arms on `programs`; returns counts for the log, fails with the first problems. */
function comparePrograms(programs, tag, names = []) {
  const traces = { electron: runPrograms('electron', programs, tag), rust: runPrograms('rust', programs, tag) };
  if (reference.electron) traces.node = runPrograms('node', programs, tag);
  const problems = [];
  let identical = 0, entries = 0, nodeDiffers = 0;
  programs.forEach((program, index) => {
    const name = names[index] ?? `program ${index}: ${JSON.stringify(program).slice(0, 1500)}`;
    const parsed = Object.fromEntries(Object.entries(traces).map(([arm, list]) => [arm, parse(list[index])]));
    entries += parsed.electron.length;
    for (const [arm, list] of Object.entries(parsed)) for (const problem of broken(list, program)) problems.push(`${name}\n  ${arm} breaks a rule: ${problem}\n  trace: ${traces[arm][index]}`);
    const expected = projection(parsed.electron), actual = projection(parsed.rust);
    const difference = firstDifference(expected, actual);
    if (difference) problems.push(`${name}\n  the Rust differs from Electron's Node at ${difference}\n  electron: ${traces.electron[index]}\n  rust:     ${traces.rust[index]}`);
    // The system Node is information here: its library spends other job
    // counts inside a call (Node 26's stream iterator takes fewer jobs in
    // `return()` than 24.22's generator), which can move a strand's own
    // pure jobs against the call's continuation. Its trace must still keep
    // rules 1 and 2 (above).
    if (parsed.node && firstDifference(expected, projection(parsed.node))) nodeDiffers += 1;
    const strip = (list) => list.map((entry) => `${entry.strand ?? ''}:${entry.text}`).join(' ');
    if (strip(parsed.electron) === strip(parsed.rust)) identical += 1;
  });
  return { problems, identical, entries, nodeDiffers };
}

describe('rule 1: I/O programs on Electron\'s Node, this Node and the Rust', () => {
  test(`the ${FIXED_PROGRAMS.length} named programs keep rules 1 and 2, and their pure part and strands are Electron's`, () => {
    const { problems, identical, entries, nodeDiffers } = comparePrograms(FIXED_PROGRAMS.map((entry) => entry.program), 'named', FIXED_PROGRAMS.map((entry) => entry.name));
    assert.deepEqual(problems.slice(0, 5), [], `${problems.length} problems`);
    console.log(`${FIXED_PROGRAMS.length} named I/O programs, ${entries} entries: all admissible; ${identical} in Electron's own interleaving too; this Node's strands differ in ${nodeDiffers}`);
  });
  for (const seed of SEEDS) {
    test(`${PER_SEED} random I/O programs of seed ${seed} keep rules 1 and 2, and their pure part and strands are Electron's`, () => {
      const programs = generatePrograms(seed, PER_SEED);
      const { problems, identical, entries, nodeDiffers } = comparePrograms(programs, `seed${seed}`);
      assert.deepEqual(problems.slice(0, 5), [], `${problems.length} problems`);
      console.log(`seed ${seed}: ${programs.length} I/O programs, ${entries} entries: all admissible; ${identical} in Electron's own interleaving too; this Node's strands differ in ${nodeDiffers} (information)`);
    });
  }
  test('the constraints are not vacuous: an inline settlement and a value after end are refused', () => {
    const program = { main: [{ s: 'io', op: 'lstat', a: 'f0', l: 'i0' }, { s: 'stream', a: 'f0', hwm: 4, l: 's0' }, { s: 'chain', n: 3, l: 'c' }] };
    assert.deepEqual(broken(parse('i0>@1000#0 s0>@1000#0 c@1000#0 io:s0:s0.d0=4@1000#2 io:s0:s0.end@1000#3 io:s0:s0.close@1000#4 io:i0:i0=f:4@1000#1'), program), []);
    assert.match(broken(parse('i0>@1000#0 io:i0:i0=f:4@1000#0 c@1000#0 s0>@1000#0 io:s0:s0.close@1000#4'), program).join('; '), /i0: continued in the checkpoint that started it/);
    assert.match(broken(parse('i0>@1000#0 s0>@1000#0 c@1000#0 io:i0:i0=f:4@1000#1 io:s0:s0.end@1000#3 io:s0:s0.d0=4@1000#3 io:s0:s0.close@1000#4'), program).join('; '), /s0: a value after end/);
    assert.match(broken(parse('i0>@1000#0 s0>@1000#0 c@1000#0 io:i0:i0=f:4@1000#1 io:s0:s0.close@1000#3 io:s0:s0.end@1000#4'), program).join('; '), /s0: an event after close/);
  });
});
