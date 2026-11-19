// The native ledger's execution context, I/O pool and stall clock against
// the JavaScript (plan package L3d), under one virtual clock: the scenarios
// of ctx-scenarios.mjs run on execution-admission.js, execution-io-pool.js
// and host-stall-clock.js with Node's own timers on a virtual clock
// (ctx-js-arm.mjs, on the reference runtime) and on the Rust probe, whose
// virtual clock drives the event loop the binary ships; the event logs
// (results, error codes, reports, progress, the order and time of every
// wake-up) must be equal.
// Restated JavaScript tests keep their own assertions (`expect`), and every
// test of those three files is either restated or listed with its reason.
//
// Order: every event is compared in order with its time, across tasks too.
// Both arms run JavaScript's job order (the Rust on the crate's `js` layer),
// so nothing inside an instant is left free.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { decodeLine, encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';
import { NOT_RESTATED, SCENARIOS } from './ctx-scenarios.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '../../packages/harness-runtime/lib');
const reference = referenceRuntime();
/** How long one arm may take for every scenario (generous: CI and loaded machines). */
const DEADLINE_MS = 300_000;
console.log(`JavaScript reference runtime: ${reference.description}`);

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
let javascript, rust;
const sendable = SCENARIOS.map(({ expect: _expect, source: _source, ...scenario }) => scenario);

before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(existsSync(probe), `${probe} does not exist`);
  const input = encodeLine(sendable);
  // Each arm answers one line per scenario; an arm past its deadline (a
  // scenario that never ends) fails, naming the first scenario it did not answer.
  const bounded = (run, arm) => {
    const answered = String(run.stdout ?? '').split('\n').filter(Boolean).length;
    assert.ok(!run.error && run.signal === null, `${arm} did not finish within ${DEADLINE_MS / 1000} s; stuck in scenario "${sendable[answered]?.name}": ${run.error?.message ?? run.signal}`);
  };
  const js = spawnSync(reference.command, ['--expose-internals', '--no-warnings', path.join(here, 'ctx-js-arm.mjs')], { input, env: { ...process.env, ...reference.env }, maxBuffer: 256 * 1024 * 1024, timeout: DEADLINE_MS, killSignal: 'SIGKILL' });
  bounded(js, 'the JavaScript arm');
  assert.equal(js.status, 0, `the JavaScript arm failed: ${js.stderr}`);
  const native = spawnSync(probe, ['scenarios'], { input, maxBuffer: 256 * 1024 * 1024, timeout: DEADLINE_MS, killSignal: 'SIGKILL' });
  bounded(native, 'the Rust probe');
  assert.equal(native.status, 0, `the Rust probe failed: ${native.stderr}`);
  javascript = String(js.stdout).split('\n').filter(Boolean);
  rust = String(native.stdout).split('\n').filter(Boolean);
});
after(() => dispose());

/** The comparable form of an event log: every event, in order. */
export const canonical = (line) => JSON.parse(line).events.map((event) => JSON.stringify(event));

describe('execution context, I/O pool and stall clock: JavaScript against Rust under one virtual clock', () => {
  SCENARIOS.forEach((scenario, index) => {
    test(scenario.name, () => {
      assert.ok(javascript[index] && rust[index], 'both arms answered');
      const events = decodeLine(javascript[index]).events;
      if (scenario.expect) assert.ok(scenario.expect(events), `the JavaScript no longer meets the restated test: ${javascript[index].slice(0, 3000)}`);
      assert.deepEqual(canonical(rust[index]), canonical(javascript[index]));
    });
  });

  test('every test of the three JavaScript modules is restated or listed with its reason', () => {
    const titles = ['execution-admission.test.js', 'execution-io-pool.test.js', 'host-stall-clock.test.js']
      .flatMap((file) => [...readFileSync(path.join(lib, file), 'utf8').matchAll(/\btest\(\s*'((?:[^'\\]|\\.)+)'/g)].map((match) => match[1].replace(/\\'/g, "'")));
    const restated = new Set(SCENARIOS.map((scenario) => scenario.source).filter(Boolean));
    const listed = new Set(NOT_RESTATED.map((entry) => entry.source));
    assert.deepEqual(titles.filter((title) => !restated.has(title) && !listed.has(title)), []);
    assert.deepEqual([...restated, ...listed].filter((title) => !titles.includes(title)), []);
    console.log(`Restated ${restated.size} of ${titles.length} JavaScript tests; ${listed.size} test host-side functions the worker never runs.`);
  });
});
