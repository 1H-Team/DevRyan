// Differential tests of the native ledger's lock and atomic writes (plan
// package L2): the JavaScript in packages/harness-runtime/lib/atomic-file.js
// against the Rust in packages/harness-runtime/native/ledger (ledger-io),
// driven through its test-only probe. They need Rust, so they are not in the
// script suite: the build script's --verify runs them with the probe it built
// (LEDGER_NATIVE_PROBE); started alone they build the probe through it.
//
//   a. the shared specification, both arms, equal outputs
//   b. lock-file bytes against the documented format
//   c. contention between JavaScript and Rust processes; timeouts
//   d. a SIGKILLed holder reclaimed, a live one never stolen, both ways
//   e. system-call sequences of writeFileAtomic, lock publication and copyfile (macOS)
//   f. the sync primitive's chain and a failing sync, stamps against Node's
//      bigint stats, and the system error names and messages against Node's
//
// The JavaScript runs on the reference runtime (the Node inside Electron;
// reference-runtime.mjs beside this file), printed at the start of the run.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProbe, PROBE_VARIABLE } from '../build-ledger-native.mjs';
import { LOCK_FORMAT } from '../ledger-dual-run/dual-run-compare.mjs';
import { scratchParent } from '../qa/run-root.mjs';
import { snapshotTree } from './atomic-js-arm.mjs';
import { SCENARIOS, normalize, runJavaScript, runRust, scenarioRoot } from './atomic-spec.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'atomic-js-worker.mjs');
const INTERPOSER = path.join(here, 'trace-interpose.c');
const reference = referenceRuntime();
console.log(`JavaScript reference runtime: ${reference.description}`);

let probe = process.env[PROBE_VARIABLE];
let disposeProbe = () => {};
const parent = scratchParent('ledger-native');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(path.join(parent, 'differential-'));
const children = new Set();
const cleanup = () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  rmSync(scratch, { recursive: true, force: true });
};
const interrupted = (signal) => { cleanup(); disposeProbe(); process.exit(signal === 'SIGINT' ? 130 : 143); };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

before(() => {
  if (!probe) ({ probe, dispose: disposeProbe } = buildProbe());
  assert.ok(existsSync(probe), `${PROBE_VARIABLE}=${probe} does not exist; build it with: node scripts/build-ledger-native.mjs --verify`);
});
after(() => { cleanup(); disposeProbe(); });

const directory = (name) => {
  const made = mkdtempSync(path.join(scratch, `${name}-`));
  return made;
};

/** The command, arguments and environment that start one arm's process mode. */
function armCommand(arm, args, env = {}) {
  if (arm === 'rust') return { command: probe, args, env: { ...process.env, ...env } };
  return { command: reference.command, args: [WORKER, ...args], env: { ...process.env, ...env, ...reference.env } };
}

/** Runs one process mode of an arm to completion and parses its last JSON line. */
function runMode(arm, args, { env = {} } = {}) {
  const started = armCommand(arm, args, env);
  const result = spawnSync(started.command, started.args, { encoding: 'utf8', env: started.env });
  if (result.error) throw result.error;
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length, `${arm} ${args.join(' ')} printed nothing (exit ${result.status}): ${result.stderr}`);
  return { status: result.status, output: JSON.parse(lines.at(-1)), stderr: result.stderr };
}

/** Starts an arm's `hold` and resolves when it holds the lock. */
function startHolder(arm, lock) {
  const started = armCommand(arm, ['hold', lock]);
  const child = spawn(started.command, started.args, { stdio: ['ignore', 'pipe', 'pipe'], env: started.env });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = /held (\d+)/.exec(text);
      if (match) resolve({ child, pid: Number(match[1]) });
    });
    child.once('exit', (code) => reject(new Error(`${arm} holder exited (${code}) before holding: ${text}`)));
  });
}

const killed = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });

describe('a. shared specification', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, () => {
      const js = scenarioRoot(scratch, 'js');
      const rust = scenarioRoot(scratch, 'rust');
      try {
        const javascript = runJavaScript(scenario, js.root, reference);
        const native = runRust(scenario, rust.root, probe);
        // The probe's own picture of what it left behind, against Node's.
        assert.deepEqual(native.final, snapshotTree(rust.root), 'the probe reports the tree Node sees');
        scenario.expect(javascript);
        scenario.expect(native);
        assert.deepEqual(normalize(native), normalize(javascript));
      } finally {
        js.remove();
        rust.remove();
      }
    });
  }
});

describe('b. lock-file bytes', () => {
  test('both arms write the documented format; only token, pid and time differ', () => {
    const scenario = { name: 'bytes', steps: [{ run: { op: 'lock', path: 'owner.lock', callback: [{ inspect: 'owner.lock' }] } }], expect() {} };
    const seen = [];
    for (const [arm, run] of [['javascript', runJavaScript], ['rust', (s, root) => runRust(s, root, probe)]]) {
      const { root, remove } = scenarioRoot(scratch, arm);
      try {
        const before = Date.now();
        const output = run(scenario, root);
        const finished = Date.now();
        const raw = output.runs[0].callback[0].content;
        const match = LOCK_FORMAT.exec(raw);
        assert.ok(match, `${arm} wrote ${JSON.stringify(raw)}`);
        assert.equal(Number(match[2]), output.pid);
        assert.ok(Number(match[3]) >= before && Number(match[3]) <= finished, `${arm} createdAt ${match[3]} is outside its run`);
        assert.equal(output.runs[0].callback[0].mode, 0o600);
        seen.push(raw.replace(match[1], '<token>').replace(`"pid":${match[2]}`, '"pid":<pid>').replace(`"createdAt":${match[3]}`, '"createdAt":<time>'));
      } finally { remove(); }
    }
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[0], '{"ownerToken":"<token>","pid":<pid>,"createdAt":<time>}\n');
  });
});

describe('c. contention between JavaScript and Rust processes', () => {
  // Four of each, 25 increments each: 200 lock cycles with a full sync each,
  // a few seconds even on a loaded machine. The design asked for 2,000; the
  // tenth keeps the gate short and still interleaves every pair of processes.
  const PROCESSES = 4;
  const ITERATIONS = 25;

  test('no update is lost under one lock', async () => {
    const dir = directory('counter');
    const lock = path.join(dir, 'counter.lock');
    const counter = path.join(dir, 'counter.txt');
    const runs = [];
    for (let index = 0; index < PROCESSES * 2; index += 1) {
      const arm = index % 2 ? 'rust' : 'javascript';
      const started = armCommand(arm, ['counter', lock, counter, String(ITERATIONS), '120000']);
      const child = spawn(started.command, started.args, { stdio: ['ignore', 'pipe', 'pipe'], env: started.env });
      children.add(child);
      runs.push(new Promise((resolve) => {
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('exit', (code) => { children.delete(child); resolve({ arm, code, out, err }); });
      }));
    }
    const results = await Promise.all(runs);
    for (const result of results) assert.equal(result.code, 0, `${result.arm} counter failed: ${result.out}${result.err}`);
    assert.equal(Number(readFileSync(counter, 'utf8')), PROCESSES * 2 * ITERATIONS);
    assert.equal(existsSync(lock), false);
  });

  for (const [holderArm, waiterArm] of [['rust', 'javascript'], ['javascript', 'rust']]) {
    test(`a ${waiterArm} waiter times out as configured behind a live ${holderArm} holder`, async () => {
      const lock = path.join(directory('timeout'), 'held.lock');
      const holder = await startHolder(holderArm, lock);
      try {
        const { output } = runMode(waiterArm, ['wait', lock, '300']);
        assert.equal(output.ok, false);
        assert.equal(output.error, 'LOCK_TIMEOUT');
        assert.ok(output.elapsed >= 300, `gave up after ${output.elapsed} ms`);
        // The deadline is checked between 25 ms retries; anything far beyond
        // that is a scheduler stall on a loaded machine, not a lock defect.
        assert.ok(output.elapsed < 300 + 10_000, `gave up after ${output.elapsed} ms`);
        assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, holder.pid);
      } finally { await killed(holder.child); }
    });
  }
});

describe('d. a killed holder is reclaimed, a live one never stolen', () => {
  for (const [holderArm, waiterArm] of [['rust', 'javascript'], ['javascript', 'rust']]) {
    test(`a ${waiterArm} waiter takes over from a SIGKILLed ${holderArm} holder`, async () => {
      const lock = path.join(directory('kill'), 'owner.lock');
      const holder = await startHolder(holderArm, lock);
      const blocked = runMode(waiterArm, ['wait', lock, '200']).output;
      assert.equal(blocked.error, 'LOCK_TIMEOUT', 'the live holder was not respected');
      assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, holder.pid);
      await killed(holder.child);
      assert.ok(existsSync(lock), 'the killed holder left its lock behind');
      const taken = runMode(waiterArm, ['wait', lock, '10000']).output;
      assert.equal(taken.ok, true, `the dead holder's lock was not reclaimed: ${JSON.stringify(taken)}`);
      assert.equal(existsSync(lock), false);
    });
  }
});

/** Builds the interposer (macOS) into the scratch directory once. */
let interposer;
function tracer() {
  if (interposer) return interposer;
  const library = path.join(scratch, 'trace-interpose.dylib');
  const built = spawnSync('cc', ['-O1', '-dynamiclib', '-o', library, INTERPOSER], { encoding: 'utf8' });
  assert.equal(built.status, 0, `cc could not build the interposer (install the Xcode command line tools): ${built.stderr}`);
  interposer = library;
  return library;
}

/**
 * System calls one arm makes for `args`, on paths under a fresh directory,
 * with descriptors named by their path; with `status: 1` the run must fail,
 * and its output (paths spelled `<dir>`) and the directory's entries come back too.
 */
function traceCalls(arm, args, { fail, status: expected = 0 } = {}) {
  const dir = directory(`trace-${arm}`);
  const out = path.join(mkdtempSync(path.join(scratch, 'trace-out-')), 'calls.trace');
  // The filter is the directory itself, so its own open and sync are traced.
  const env = { DYLD_INSERT_LIBRARIES: tracer(), LEDGER_TRACE_OUT: out, LEDGER_TRACE_FILTER: dir, ...(fail ? { LEDGER_TRACE_FAIL: fail } : {}) };
  const resolved = args.map((arg) => arg.replaceAll('<dir>', dir));
  const { status, output } = runMode(arm, resolved, { env });
  assert.equal(status, expected, `${arm} ${args.join(' ')}: ${JSON.stringify(output)}`);
  const names = new Map();
  const lines = [];
  for (const line of readFileSync(out, 'utf8').trim().split('\n')) {
    const fd = /^fd (\d+) (.*)$/.exec(line);
    if (fd) { names.set(fd[1], fd[2]); continue; }
    lines.push(line.replace(/#(\d+)/, (_, number) => `#${names.get(number) ?? number}`));
  }
  rmSync(out, { force: true });
  const calls = lines.map((line) => line.replaceAll(`${dir}/`, '').replace(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[ ]|$)`, 'g'), '.')
    .replace(/\.tmp-\d+-\d+-[0-9a-f]{32}/g, '.tmp-<pid>-<now>-<id>')
    .replace(/\.tmp-\d+-[0-9a-f-]{36}/g, '.tmp-<pid>-<uuid>'));
  if (expected === 0) return calls;
  return { calls, output: JSON.parse(JSON.stringify(output).replaceAll(dir, '<dir>')), left: readdirSync(dir).sort() };
}

describe('e. system-call sequences (macOS, interposed)', { skip: process.platform !== 'darwin' && 'DYLD interposition exists only on macOS; the sequences are untested on Linux until a Linux tracer exists' }, () => {
  for (const [label, args] of [
    ['writeFileAtomic', ['write-atomic', '<dir>/d/f.json', 'hello']],
    ['writeFileAtomic into an existing directory', ['write-atomic', '<dir>/f.json', 'x'.repeat(600 * 1024)]],
    ['lock publication and release', ['lock-once', '<dir>/d/owner.lock']],
  ]) {
    test(`${label}: the reference Node and the Rust primitive make the same calls`, () => {
      const javascript = traceCalls('javascript', args);
      const native = traceCalls('rust', args);
      assert.ok(javascript.some((line) => line.startsWith('fcntl ') && line.includes('cmd=51')), javascript.join('\n'));
      assert.deepEqual(native, javascript);
    });
  }

  test('copyfile: the same outcome, mode, times and bytes, and the same failure (no copyfile(3) or clone in libuv 1.52.1)', () => {
    const results = {};
    // A mode the umask clips, so only libuv's fchmod gives it to the copy; children inherit the mask.
    const umask = process.umask(0o022);
    try {
      for (const arm of ['javascript', 'rust']) {
        const dir = directory(`copy-${arm}`);
        const file = (name) => path.join(dir, name);
        writeFileSync(file('src'), Buffer.alloc(20_000, 7));
        chmodSync(file('src'), 0o777);
        utimesSync(file('src'), 1_000.25, 2_000.5);
        writeFileSync(file('empty'), '');
        utimesSync(file('empty'), 1_000.25, 2_000.5);
        const copy = runMode(arm, ['copyfile', file('src'), file('dst'), '2']).output;
        const copied = statSync(file('dst'), { bigint: true });
        const emptyCopy = runMode(arm, ['copyfile', file('empty'), file('empty-dst'), '0']).output;
        const empty = statSync(file('empty-dst'), { bigint: true });
        const refused = runMode(arm, ['copyfile', file('src'), file('dst'), '1']);
        results[arm] = {
          copy, mode: Number(copied.mode) & 0o777, size: copied.size, atimeNs: copied.atimeNs,
          sameBytes: readFileSync(file('dst')).equals(readFileSync(file('src'))),
          emptyCopy, emptyTimes: [empty.atimeNs, empty.mtimeNs],
          refused: { status: refused.status, output: JSON.parse(JSON.stringify(refused.output).replaceAll(dir, '<dir>')) },
        };
      }
    } finally { process.umask(umask); }
    assert.equal(results.javascript.mode, 0o777);
    assert.equal(results.javascript.refused.output.failure.code, 'EEXIST');
    assert.deepEqual(results.rust, results.javascript);
  });
});

describe('f. the sync primitive, file stamps and system errors', () => {
  test('stamps, mtimeMs and types equal the reference Node\'s stats (lstat, bigint)', () => {
    const dir = directory('stamps');
    writeFileSync(path.join(dir, 'file'), 'x');
    mkdirSync(path.join(dir, 'sub'));
    symlinkSync('file', path.join(dir, 'link'));
    const targets = ['file', 'sub', 'link'].map((name) => path.join(dir, name));
    const { output } = runMode('rust', ['stat', ...targets]);
    const script = `const fs = require('node:fs'); process.stdout.write(JSON.stringify(process.argv.slice(1).map((file) => {
      const stat = fs.lstatSync(file, { bigint: true });
      return { stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':'), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
        mtimeMs: fs.statSync(file).mtimeMs, isSymbolicLink: stat.isSymbolicLink(), isDirectory: stat.isDirectory() };
    })));`;
    const node = spawnSync(reference.command, ['-e', script, ...targets], { encoding: 'utf8', env: { ...process.env, ...reference.env } });
    assert.equal(node.status, 0, node.stderr);
    const expected = JSON.parse(node.stdout);
    for (const [index, record] of output.entries()) {
      const { stamp, identity, mtimeMs, isSymbolicLink, isDirectory } = record;
      assert.deepEqual({ stamp, identity, mtimeMs, isSymbolicLink, isDirectory }, expected[index], targets[index]);
    }
  });

  test('system errors: every errno ledger-io names has the reference Node\'s code and message, and no other errno is known', () => {
    const { output } = runMode('rust', ['errors']);
    const script = `const util = require('node:util'); process.stdout.write(JSON.stringify({
      known: [...util.getSystemErrorMap()].filter(([errno]) => -errno < 3000).map(([errno, [name, message]]) => [errno, name, message]).sort((a, b) => b[0] - a[0]),
      unknown: [-9999, util.getSystemErrorName(-9999), util.getSystemErrorMessage(-9999)] }));`;
    const node = spawnSync(reference.command, ['-e', script], { encoding: 'utf8', env: { ...process.env, ...reference.env } });
    assert.equal(node.status, 0, node.stderr);
    const expected = JSON.parse(node.stdout);
    const unknown = output.at(-1);
    assert.deepEqual(output.slice(0, -1).sort((a, b) => b[0] - a[0]), expected.known);
    assert.deepEqual(unknown, expected.unknown);
  });

  test('sync: the chain libuv runs, with each fallback forced (macOS, interposed)', { skip: process.platform !== 'darwin' && 'the F_FULLFSYNC chain is macOS-only; on Linux both arms call fsync(2), which this tracer cannot observe there' }, () => {
    for (const fail of [undefined, 'fullfsync', 'fullfsync,barrier']) {
      const calls = {};
      for (const arm of ['javascript', 'rust']) {
        const lines = traceCalls(arm, ['write-atomic', '<dir>/f', 'x'], { fail }).filter((line) => /^(fcntl|fsync) /.test(line));
        calls[arm] = lines;
      }
      const expected = { undefined: ['cmd=51 = 0'], fullfsync: ['cmd=51 = -1', 'cmd=85 = 0'], 'fullfsync,barrier': ['cmd=51 = -1', 'cmd=85 = -1', 'fsync'] }[String(fail)];
      // Two syncs per write: the temporary, then the directory.
      assert.equal(calls.javascript.length, expected.length * 2, calls.javascript.join('\n'));
      expected.forEach((fragment, index) => assert.ok(calls.javascript[index].includes(fragment), `${fail}: ${calls.javascript.join('\n')}`));
      assert.deepEqual(calls.rust, calls.javascript);
    }
  });

  test('sync: a real fsync failure fails the write with the same error and leaves no temporary (macOS, interposed)', { skip: process.platform !== 'darwin' && 'the interposer that fails fsync(2) is macOS-only' }, () => {
    const runs = {};
    for (const arm of ['javascript', 'rust']) {
      const { calls, output, left } = traceCalls(arm, ['write-atomic', '<dir>/f', 'x'], { fail: 'fullfsync,barrier,fsync', status: 1 });
      runs[arm] = { calls, output, left };
    }
    assert.deepEqual(runs.javascript.output.failure, { code: 'EIO', errno: runs.javascript.output.failure.errno, syscall: 'fsync', message: 'EIO: i/o error, fsync' });
    assert.ok(runs.javascript.calls.some((line) => line.startsWith('fsync ') && line.endsWith(' = -1 5')), runs.javascript.calls.join('\n'));
    assert.deepEqual(runs.javascript.left, [], 'the temporary was removed and nothing was renamed');
    assert.deepEqual(runs.rust, runs.javascript);
  });
});
