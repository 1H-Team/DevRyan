// The native ledger's job layer (the crate's `js` and `host` modules)
// against JavaScript: programs of jobs-programs.mjs (async functions and
// awaits of pending, settled and plain values, `return` against `return
// await`, then, catch, finally, all, allSettled, race, new Promise,
// queueMicrotask, process.nextTick, timers whose callbacks make and clear
// timers, immediates, rejections with try and catch, unhandled rejections,
// messages in the poll phase) run on V8 and Node's own task queue, timers
// and immediates under a virtual libuv clock (jobs-js-arm.mjs), on Electron's
// Node and on the Node running this test, and on the Rust
// (`ledger-native-probe jobs`). Every trace must be equal, entry for entry:
// nothing inside a program is left free.
//
// The gate runs the hand-written programs and 400 seeded random ones; the
// extended run (LEDGER_NATIVE_ODB_EXTENDED=1) 20,000 over five seeds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXTENDED_VARIABLE, LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { FIXED_PROGRAMS, generatePrograms } from './jobs-programs.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = referenceRuntime();
/** How long one arm may take for one batch of programs (generous: CI and loaded machines). */
const DEADLINE_MS = 300_000;
/** A run past its deadline fails, naming the first program it did not answer. */
const bounded = (run, arm, programs) => {
  const answered = String(run.stdout ?? '').split('\n').filter(Boolean).length;
  assert.ok(!run.error && run.signal === null, `${arm} did not finish within ${DEADLINE_MS / 1000} s; stuck in program ${answered}: ${JSON.stringify(programs[answered])?.slice(0, 2000)}`);
};
const extended = process.env[EXTENDED_VARIABLE] === '1';
const SEEDS = extended ? [11, 23, 37, 41, 59] : [11];
const PER_SEED = extended ? 4_000 : 400;

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(existsSync(probe), `${probe} does not exist`);
});
after(() => dispose());

const lines = (programs) => programs.map((program) => `${JSON.stringify(program)}\n`).join('');

/** The traces of `programs` on one JavaScript runtime. */
function javascript(command, env, programs) {
  const run = spawnSync(command, ['--expose-internals', '--no-warnings', path.join(here, 'jobs-js-arm.mjs')],
    { input: lines(programs), env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024, timeout: DEADLINE_MS, killSignal: 'SIGKILL' });
  bounded(run, 'the JavaScript arm', programs);
  assert.equal(run.status, 0, `the JavaScript arm failed: ${run.stderr}`);
  return String(run.stdout).split('\n').slice(0, programs.length);
}

/** The traces of `programs` on the Rust. */
function rust(programs) {
  const run = spawnSync(probe, ['jobs'], { input: lines(programs), maxBuffer: 512 * 1024 * 1024, timeout: DEADLINE_MS, killSignal: 'SIGKILL' });
  bounded(run, 'the Rust probe', programs);
  assert.equal(run.status, 0, `the Rust probe failed: ${run.stderr}`);
  const census = /census: .*/.exec(String(run.stderr));
  if (census) console.log(census[0]);
  return String(run.stdout).split('\n').slice(0, programs.length);
}

/** Every program where the traces differ, with both. */
function differences(programs, expected, actual) {
  return programs.flatMap((program, index) => (expected[index] === actual[index] ? []
    : [{ index, program: JSON.stringify(program), expected: expected[index], actual: actual[index] }]));
}

describe('the job layer against JavaScript (V8, Node\'s task queue, timers and immediates)', () => {
  test(`each hand-written program gives the reference trace (${reference.electron ? 'Electron\'s Node' : 'this Node'})`, () => {
    const programs = FIXED_PROGRAMS.map((entry) => entry.program);
    const expected = javascript(reference.command, reference.env, programs);
    const actual = rust(programs);
    const failed = FIXED_PROGRAMS.flatMap((entry, index) => (expected[index] === actual[index] ? [] : [`${entry.name}\n  js:   ${expected[index]}\n  rust: ${actual[index]}`]));
    for (const entry of failed) console.log(`differs: ${entry.split('\n')[0]}`);
    assert.deepEqual(failed, [], 'the Rust orders these programs differently');
  });

  for (const seed of SEEDS) {
    test(`${PER_SEED} random programs of seed ${seed}: Rust, Electron's Node and this Node give one trace`, () => {
      const programs = generatePrograms(seed, PER_SEED);
      const expected = javascript(reference.command, reference.env, programs);
      const native = differences(programs, expected, rust(programs));
      assert.deepEqual(native.slice(0, 3), [], `${native.length} of ${programs.length} programs differ between the reference and the Rust`);
      if (reference.electron) {
        const nodes = differences(programs, expected, javascript(process.execPath, {}, programs));
        assert.deepEqual(nodes.slice(0, 3), [], `${nodes.length} of ${programs.length} programs differ between Electron's Node and this Node ${process.version}`);
      }
      console.log(`seed ${seed}: ${programs.length} programs, ${expected.reduce((sum, trace) => sum + trace.split(' ').length, 0)} trace entries, all equal`);
    });
  }
});
