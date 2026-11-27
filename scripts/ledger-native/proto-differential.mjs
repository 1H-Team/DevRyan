// Protocol conformance of the native ledger process (plan package L3d):
// scripted host transcripts (proto-transcripts.mjs) run against the
// product's ledger worker as a stdio process and against devryan-ledger,
// and what each said must be equal under the ordering rules the protocol
// guarantees (proto-driver.mjs `shapeOf`). Then what only the native
// process does: the refused tagged types, the protocol check, the line and
// depth guards, every product method answering `mutation_method_unimplemented`,
// and its lifecycle (stdin EOF, a signal, the parent's death).
//
// Arms: the JavaScript worker on the reference runtime (the Node inside
// Electron; reference-runtime.mjs) with the stub runtime substituted by a
// module hook, as a stdio process (proto-js-process.mjs) and, for the stub
// transcripts, on a real worker thread driven through postMessage
// (proto-thread-process.mjs: the true reference for how the worker orders
// what arrives), or with its real runtime; and the Rust builds the verify
// passes in LEDGER_NATIVE_LEDGER (plain) and LEDGER_NATIVE_LEDGER_HOOKS
// (test-hooks); started alone, the test builds them through the build script.
// A transcript's `ordered` messages must come in the same order on every arm.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_HOOKS_VARIABLE, LEDGER_PROBE_VARIABLE, LEDGER_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';
import { scratchParent } from '../qa/run-root.mjs';
import { productMethods } from './generate-methods.mjs';
import { normalizeMessage, progressPrecedesResults, runTranscript, shapeOf } from './proto-driver.mjs';
import { PRODUCT_TRANSCRIPTS, STUB_TRANSCRIPTS, VIRTUAL_TRANSCRIPTS } from './proto-transcripts.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const libDirectory = path.join(repositoryRoot, 'packages/harness-runtime/lib');
const reference = referenceRuntime();
console.log(`JavaScript reference runtime: ${reference.description}`);

const parent = scratchParent('ledger-native');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(path.join(parent, 'proto-'));
let binaries = { plain: process.env[LEDGER_VARIABLE], hooks: process.env[LEDGER_HOOKS_VARIABLE], probe: process.env[LEDGER_PROBE_VARIABLE] };
let dispose = () => {};
const children = new Set();
const cleanup = () => {
  for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true });
};
const interrupted = (signal) => { cleanup(); dispose(); process.exit(signal === 'SIGINT' ? 130 : 143); };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

before(() => {
  if (!binaries.plain || !binaries.hooks || !binaries.probe) ({ binaries, dispose } = buildLedgerBinaries());
  for (const binary of [binaries.plain, binaries.hooks, binaries.probe]) assert.ok(existsSync(binary), `${binary} does not exist; build it with: node scripts/build-ledger-native.mjs --verify`);
});
after(() => { cleanup(); dispose(); });

const environment = (extra = {}) => ({ ...process.env, TMPDIR: scratch, ...extra });
const arms = {
  stub: {
    js: () => ({ command: reference.command, args: [path.join(here, 'proto-js-process.mjs'), libDirectory], env: environment(reference.env) }),
    thread: () => ({ command: reference.command, args: [path.join(here, 'proto-thread-process.mjs'), libDirectory], env: environment(reference.env) }),
    rust: () => ({ command: binaries.hooks, args: [], env: environment() }),
  },
  product: {
    js: () => ({ command: reference.command, args: [path.join(repositoryRoot, 'scripts/ledger-dual-run/ledger-process.mjs'), libDirectory], env: environment(reference.env) }),
    rust: () => ({ command: binaries.plain, args: [], env: environment() }),
  },
};

// JavaScript: a throw while reading a line is an uncaught exception (1); a
// runtime that refuses its options fails the worker's import (70). Rust
// exits 70 for both.
const JS_EXIT = { eof: { code: 0, signal: null }, corrupt: { code: 1, signal: null }, refused: { code: 70, signal: null } };
const RUST_EXIT = { eof: { code: 0, signal: null }, corrupt: { code: 70, signal: null }, refused: { code: 70, signal: null } };

/** The messages a transcript orders, normalized, in arrival order. */
const orderedOf = (run, ordered) => run.raw.filter(ordered).map((message) => JSON.stringify(normalizeMessage(message)));

async function compare(kind, transcript) {
  const thread = arms[kind].thread;
  const [js, rust, onThread] = await Promise.all([runTranscript(arms[kind].js(), transcript), runTranscript(arms[kind].rust(), transcript),
    thread ? runTranscript(thread(), transcript) : null]);
  const jsShape = shapeOf(js), rustShape = shapeOf(rust);
  assert.deepEqual(jsShape.exit, JS_EXIT[transcript.exit], `JavaScript exit (stderr: ${js.stderr.slice(-2000)})`);
  assert.deepEqual(rustShape.exit, RUST_EXIT[transcript.exit], `Rust exit (stderr: ${rust.stderr.slice(-2000)})`);
  delete jsShape.exit;
  delete rustShape.exit;
  assert.deepEqual(rustShape, jsShape);
  if (onThread) {
    const threadShape = shapeOf(onThread);
    assert.deepEqual(threadShape.exit, JS_EXIT[transcript.exit], `worker thread exit (stderr: ${onThread.stderr.slice(-2000)})`);
    delete threadShape.exit;
    assert.deepEqual(jsShape, threadShape, 'the stdio process and the worker thread differ');
  }
  if (transcript.ordered) {
    const reference = orderedOf(onThread ?? js, transcript.ordered);
    assert.deepEqual(orderedOf(js, transcript.ordered), reference, 'the stdio process orders differently from the worker thread');
    assert.deepEqual(orderedOf(rust, transcript.ordered), reference, 'devryan-ledger orders differently from the worker');
  }
  for (const run of [js, rust, onThread].filter(Boolean)) {
    assert.deepEqual(progressPrecedesResults(run), [], 'a progress message came after its result');
    if (transcript.never) assert.deepEqual(run.raw.filter(transcript.never), [], 'a message the transcript rules out');
  }
  return { js, rust, onThread };
}

describe('protocol conformance: the product worker with the stub runtime against devryan-ledger with test-hooks', () => {
  for (const transcript of STUB_TRANSCRIPTS) {
    test(transcript.name, async () => {
      const { js } = await compare('stub', transcript);
      if (transcript.exit === 'eof' || transcript.exit === 'corrupt') assert.equal(js.raw[0]?.type, 'ready');
    });
  }
});

describe('protocol conformance: the product worker with its runtime against the plain devryan-ledger', () => {
  for (const transcript of PRODUCT_TRANSCRIPTS) test(transcript.name, () => compare('product', transcript));

  test('ready lists the product runtime\'s methods, then the native build\'s protocol and an unported build identity', async () => {
    const run = await runTranscript(arms.product.rust(), { name: 'ready', steps: [], exit: 'eof' });
    assert.deepEqual(run.raw[0].methods, productMethods());
    assert.equal(run.raw[0].protocol, 1);
    assert.match(run.raw[0].build, /^unported\+/);
  });
});

/** Runs a transcript on one Rust build only (what the JavaScript does differently by design). */
const rustOnly = (transcript, build = 'hooks', extra = {}) => runTranscript({ command: binaries[build], args: [], env: environment(extra) }, transcript);
const resultOf = (run, id) => run.raw.find((message) => message.type === 'result' && message.id === id);

/** Runs one timed script on one virtual arm: `[{ t, line }]`. */
function runVirtual(command, args, env, script) {
  // Bounded (generous for loaded machines): an arm that hangs fails, naming the script.
  const run = spawnSync(command, args, { input: encodeLine(script), env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
  assert.ok(!run.error, `${path.basename(args.at(-1) ?? command)} did not finish script "${script.name}" within 120 s: ${run.error?.message}`);
  assert.equal(run.status, 0, `${path.basename(args.at(-1) ?? command)} failed: ${run.stderr}`);
  return run.stdout.split('\n').filter(Boolean).map((row) => { const tab = row.indexOf('\t'); return { t: Number(row.slice(0, tab)), line: row.slice(tab + 1) }; });
}

/**
 * The comparable form of a virtual run: every message with its time, in
 * order, across calls too. Both arms run JavaScript's job order (the Rust on
 * the crate's `js` layer), so nothing inside an instant is left free.
 */
export const virtualCanonical = (rows) => rows.map(({ t, line }) => `${t}\t${JSON.stringify(normalizeMessage(JSON.parse(line)))}`);

describe('the protocol under one virtual clock: the worker on Node\'s own timers against devryan-ledger\'s event loop', () => {
  for (const script of VIRTUAL_TRANSCRIPTS) {
    test(script.name, () => {
      const js = runVirtual(reference.command, ['--expose-internals', '--no-warnings', path.join(here, 'proto-virtual-js-arm.mjs'), libDirectory], environment(reference.env), script);
      const rust = runVirtual(binaries.probe, ['transcript'], environment(), script);
      assert.ok(js.length > 1, 'the worker said more than ready');
      assert.deepEqual(virtualCanonical(rust), virtualCanonical(js));
    });
  }
});

describe('progress reaches the host at least once per move of the meter on every arm', () => {
  // Each `progress` op is followed by a 300 ms sleep, and the 250 ms ticker
  // is due before that sleep ends whatever the machine's load, so it
  // forwards every move (the last one by the final forward): at least six
  // messages on any arm, and an implementation that forwards only changes
  // of `waiting`, or ticks less often, sends fewer.
  const moves = 6;
  const transcript = {
    name: 'progress lower bound', init: { directory: '/tmp/ledger-native-conformance', observers: {} },
    steps: [
      { send: { type: 'call', id: 1, method: 'stubRun', input: [{ program: Array.from({ length: moves }, () => [{ op: 'progress' }, { op: 'sleep', ms: 300 }]).flat(), fns: [] }],
        context: { deadline: null, cancellable: true, reporting: true, metered: true, summary: null, observeOnly: false } } },
      { await: (message) => message?.type === 'result' && message.id === 1, label: 'result 1' },
    ],
  };
  for (const arm of ['js', 'thread', 'rust']) {
    test(arm, async () => {
      const run = await runTranscript(arms.stub[arm](), transcript);
      const progress = run.raw.filter((message) => message.type === 'progress' && message.id === 1);
      assert.ok(progress.length >= moves, `${progress.length} progress messages for ${moves} moves`);
      assert.deepEqual(progressPrecedesResults(run), []);
    });
  }
});

describe('what only the native process does', () => {
  test('the clock is epoch milliseconds: a deadline ten minutes ahead leaves at most ten minutes', async () => {
    const deadline = Date.now() + 600_000;
    const run = await rustOnly({ name: 'epoch', steps: [
      { send: { type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'remaining', exact: true, as: 'ms' }, { op: 'return', value: { $stub: 'regs' } }], fns: [] }],
        context: { deadline, cancellable: true, reporting: false, metered: false, summary: null, observeOnly: false } } },
      { await: (message) => message?.type === 'result' && message.id === 1 },
    ] });
    const remaining = resultOf(run, 1).value.ms;
    assert.ok(remaining > 0 && remaining <= 600_000, `remaining ${remaining}`);
  });

  test('every product method fails with mutation_method_unimplemented, with or without a context', async () => {
    const methods = productMethods();
    const steps = methods.flatMap((method, index) => [
      { send: { type: 'call', id: index + 1, method, input: [{}], context: index % 2 ? null : { cancellable: true, reporting: true, metered: true, summary: { minMs: 0 } } } },
      { await: (message) => message?.type === 'result' && message.id === index + 1 },
    ]);
    const run = await rustOnly({ name: 'unported', steps }, 'plain');
    assert.equal(run.exit.code, 0);
    for (const [index] of methods.entries()) {
      const result = resultOf(run, index + 1);
      assert.equal(result.failed, true);
      assert.deepEqual(result.error, { __devryanError: true, name: 'Error', message: 'mutation_method_unimplemented', code: 'mutation_method_unimplemented' });
    }
  });

  test('Map, Set, Date and BigInt tags are refused with mutation_wire_type', async () => {
    const run = await rustOnly({
      name: 'tags',
      answer: () => ({ defer: 'held' }),
      steps: [
        { raw: '{"type":"call","id":1,"method":"stubEcho","input":[{"$dr":"map","entries":[]}],"context":null}\n' },
        { await: (message) => message?.type === 'result' && message.id === 1 },
        { raw: '{"type":"call","id":2,"method":"stubEcho","input":[],"context":{"deadline":{"$dr":"date","value":1}}}\n' },
        { await: (message) => message?.type === 'result' && message.id === 2 },
        { send: { type: 'call', id: 3, method: 'stubRun', input: [{ program: [{ op: 'try', body: [{ op: 'call', fn: 0, args: ['x'] }], as: 'r' }, { op: 'return', value: { $stub: 'regs' } }], fns: [{ __devryanFunction: 1 }] }], context: null } },
        { await: (message) => message?.type === 'callback' },
        { raw: '{"type":"callback-result","id":1,"failed":false,"value":{"$dr":"bigint","value":"1"}}\n' },
        { await: (message) => message?.type === 'result' && message.id === 3 },
      ],
    });
    for (const id of [1, 2]) assert.equal(resultOf(run, id).error.code, 'mutation_wire_type');
    assert.equal(resultOf(run, 3).value.r.caught.code, 'mutation_wire_type');
  });

  test('an init naming another protocol is refused before ready', async () => {
    for (const protocol of [2, '1', 0]) {
      const run = await rustOnly({ name: 'protocol', protocol, init: { directory: '/tmp/x' }, steps: [] }, 'plain');
      assert.deepEqual([run.exit.code, run.raw.length], [70, 0], `protocol ${JSON.stringify(protocol)}`);
    }
  });

  test('a line past the length guard ends the process (70), a line at it is read', async () => {
    const line = (padding) => `{"type":"call","id":1,"method":"stubEcho","input":["${'x'.repeat(padding)}"],"context":null}`;
    const limit = line(100).length;
    const fits = await rustOnly({ name: 'fits', steps: [{ raw: `${line(100)}\n` }, { await: (message) => message?.type === 'result' }] }, 'hooks', { LEDGER_NATIVE_TEST_MAX_LINE: String(limit) });
    assert.equal(fits.exit.code, 0);
    const over = await rustOnly({ name: 'over', steps: [{ raw: `${line(101)}\n` }, { pause: 300 }] }, 'hooks', { LEDGER_NATIVE_TEST_MAX_LINE: String(limit) });
    assert.deepEqual([over.exit.code, over.raw.length], [70, 1]);
    // A guard counts bytes before the newline arrives.
    const unterminated = await rustOnly({ name: 'unterminated', steps: [{ raw: 'x'.repeat(limit + 1) }, { pause: 300 }] }, 'hooks', { LEDGER_NATIVE_TEST_MAX_LINE: String(limit) });
    assert.equal(unterminated.exit.code, 70);
  });

  test('a line nested deeper than the JSON bound ends the process (70)', async () => {
    const deep = `${'['.repeat(600)}${']'.repeat(600)}`;
    const run = await rustOnly({ name: 'deep', steps: [{ raw: `{"type":"call","id":1,"method":"stubEcho","input":${deep},"context":null}\n` }, { pause: 300 }] });
    assert.equal(run.exit.code, 70);
  });

  test('random lines never make it panic: each is a message, ignored, or the end of the stream (70)', async () => {
    let seed = 0x5eed;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const pieces = ['{', '}', '[', ']', '"', ':', ',', 'type', 'call', 'pull', '$dr', 'bytes', 'escape', 'number', 'null', '1e999', '-0', '\\u', '\\ud800', 'ÿ', 'stream', 'id', 'abort', ' '];
    const lines = Array.from({ length: 60 }, () => Array.from({ length: 1 + Math.floor(random() * 12) }, () => pieces[Math.floor(random() * pieces.length)]).join(''));
    for (const line of lines) {
      const run = await rustOnly({ name: 'random', steps: [{ raw: `${line}\n` }, { send: { type: 'call', id: 'alive', method: 'stubEcho', input: [], context: null } }, { pause: 50 }] });
      assert.ok([0, 70].includes(run.exit.code), `${JSON.stringify(line)} -> ${JSON.stringify(run.exit)} ${run.stderr.slice(-500)}`);
      assert.doesNotMatch(run.stderr, /panicked/, line);
    }
  });
});

/** Spawns a ledger and resolves once `ready` arrived: `{ child, lines }`. */
function startLedger(command, args = [], env = environment()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child.pid);
    let text = '';
    const lines = [];
    child.stdout.on('data', (chunk) => {
      text += chunk;
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n')) { lines.push(text.slice(0, at)); text = text.slice(at + 1); }
      if (lines.length === 1) resolve({ child, lines });
    });
    child.on('error', reject);
    // Bounded: a ledger that never says `ready` fails the test.
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} sent no ready within 60 s`)); }, 60_000);
    child.stdout.on('data', () => clearTimeout(deadline));
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({ type: 'init', workerData: { directory: '/tmp/x', observers: {} } })}\n`);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

describe('lifecycle of devryan-ledger', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`${signal} ends it`, async () => {
      const { child } = await startLedger(binaries.plain);
      const exited = new Promise((resolve) => child.on('close', (code, received) => resolve({ code, received })));
      child.kill(signal);
      assert.deepEqual(await exited, { code: null, received: signal });
      children.delete(child.pid);
    });
  }

  test('stdin EOF ends it at once, mid-call included, with nothing written after', async () => {
    const { child, lines } = await startLedger(binaries.hooks);
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    child.stdin.write(`${JSON.stringify({ type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'sleep', ms: 200 }, { op: 'return', value: 'late' }] }], context: null })}\n`);
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(lines.length, 1, lines.join('\n'));
    children.delete(child.pid);
  });

  test('stdin EOF runs none of the calls still queued, however large', async () => {
    // Call 0 holds the loop while twenty 1 MiB calls and the end of stdin
    // arrive; the reader says when it saw the end, and only then is the loop
    // let go. From the end on nothing more starts.
    const { child, lines } = await startLedger(binaries.hooks);
    let stderr = '';
    const closed = new Promise((resolve) => child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.includes('stdin closed')) resolve(); }));
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const release = path.join(scratch, 'eof-release');
    child.stdin.write(`${JSON.stringify({ type: 'call', id: 0, method: 'stubRun', input: [{ program: [{ op: 'blockUntil', path: release }] }], context: null })}\n`);
    const big = 'x'.repeat(1 << 20);
    for (let id = 1; id <= 20; id++) child.stdin.write(`${JSON.stringify({ type: 'call', id, method: 'stubEcho', input: [big], context: null })}\n`);
    child.stdin.end();
    await closed;
    writeFileSync(release, '');
    assert.equal(await exited, 0);
    const answered = lines.slice(1).map((line) => JSON.parse(line)).filter((message) => message.type === 'result' && message.id !== 0).map((message) => message.id);
    assert.deepEqual(answered, [], 'queued calls ran after stdin closed');
    children.delete(child.pid);
  });

  test('a panic in a call that has suspended ends the process (70), after what it already wrote', async () => {
    const { child, lines } = await startLedger(binaries.hooks);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    child.stdin.write(`${JSON.stringify({ type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'diagnostic', record: { before: 'the panic' } }, { op: 'sleep', ms: 20 }, { op: 'panic', message: 'planted' }] }], context: { deadline: null, cancellable: true, reporting: true, metered: false, summary: null, observeOnly: false } })}\n`);
    child.stdin.write(`${JSON.stringify({ type: 'call', id: 2, method: 'stubRun', input: [{ program: [{ op: 'sleep', ms: 60_000 }] }], context: null })}\n`);
    assert.deepEqual(await exited, { code: 70, signal: null });
    assert.match(stderr, /stub panic: planted/);
    assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line).type), ['report']);
    children.delete(child.pid);
  });

  test('a panic before a call first suspends ends the process too, after flushing what it wrote just before', async () => {
    // The exit's flush window is 2 s; under load an 8 MiB line can take longer
    // to reach this reader, so the test build is given a window no load reaches
    // (S1). The exit still ends as soon as the line is written.
    const { child, lines } = await startLedger(binaries.hooks, [], { ...environment(), LEDGER_NATIVE_TEST_EXIT_FLUSH_MS: '600000' });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    // An 8 MiB report is still being written when the panic comes; the exit waits for it.
    const big = 'x'.repeat(8 << 20);
    child.stdin.write(`${JSON.stringify({ type: 'call', id: 1, method: 'stubRun', input: [{ program: [{ op: 'diagnostic', record: { big } }, { op: 'panic', message: 'at once' }] }], context: { deadline: null, cancellable: true, reporting: true, metered: false, summary: null, observeOnly: false } })}\n`);
    assert.deepEqual(await exited, { code: 70, signal: null });
    assert.equal(lines.length, 2, 'ready and the report');
    assert.equal(JSON.parse(lines[1]).record.big.length, big.length);
    children.delete(child.pid);
  });

  test('the death of its parent ends it although stdin stays open', async () => {
    // The ledger's stdin is a FIFO this test holds open, so its parent's
    // death (Node closes a dead child's own pipes) cannot end it by EOF.
    const fifo = path.join(scratch, 'parent-death.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo');
    const script = `const { spawn } = require('node:child_process');
      const { openSync } = require('node:fs');
      const ledger = spawn(process.argv[1], [], { stdio: [openSync(process.argv[2], 'r'), 'ignore', 'inherit'] });
      process.stdout.write(String(ledger.pid) + '\\n');
      setInterval(() => {}, 1000);`;
    const middle = spawn(process.execPath, ['-e', script, binaries.plain, fifo], { stdio: ['ignore', 'pipe', 'inherit'], env: environment() });
    children.add(middle.pid);
    const writer = openSync(fifo, 'w');
    try {
      const pid = await new Promise((resolve) => middle.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
      children.add(pid);
      writeSync(writer, `${JSON.stringify({ type: 'init', workerData: { directory: '/tmp/x', observers: {} } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.ok(alive(pid), 'the ledger runs while its parent does');
      process.kill(middle.pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(await until(() => !alive(pid)), 'the ledger outlived its parent');
      children.delete(pid);
      children.delete(middle.pid);
    } finally {
      closeSync(writer);
    }
  });

  test('it starts no process of its own', async () => {
    const { child } = await startLedger(binaries.plain);
    const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    const own = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === child.pid);
    assert.deepEqual(own, []);
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    children.delete(child.pid);
  });
});
