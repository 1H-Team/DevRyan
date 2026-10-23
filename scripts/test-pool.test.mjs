import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { DEFAULT_TEST_UNIT_TIMEOUT_MS, recordTestTimings, runTestUnits, summarizeTestUnits, testConcurrency, testUnitTimeoutMs } from './test-pool.mjs';

const node = (source) => ({ command: process.execPath, args: ['-e', source] });
// Children must not inherit the node:test reporting channel of this file.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const quiet = { log: () => {}, heartbeatMs: 0, env };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('bounded test pool', () => {
  test('serializes a shared resource while independent work can run', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-resource-'));
    try {
      const lock = path.join(scratch, 'lock');
      const exclusive = node(`const fs = require('node:fs'); fs.closeSync(fs.openSync(${JSON.stringify(lock)}, 'wx'));
        setTimeout(() => fs.unlinkSync(${JSON.stringify(lock)}), 150);`);
      const outcome = await runTestUnits([
        ...['a', 'b', 'c'].map(name => ({ name, resource: 'port', ...exclusive })),
        { name: 'independent', ...node(`require('node:fs').writeFileSync(${JSON.stringify(path.join(scratch, 'independent'))}, '')`) },
      ], { ...quiet, concurrency: 3 });
      assert.equal(outcome.passed, true);
      assert.equal(existsSync(path.join(scratch, 'independent')), true);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  test('kills a unit that outlives its wall-clock budget, with its process group, and fails it', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-timeout-'));
    try {
      const pidFile = path.join(scratch, 'grandchild.pid');
      // The unit never exits and keeps a grandchild alive, like a hung test with a leaked server.
      const hung = node(`const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        setInterval(() => {}, 1000);`);
      const lines = [];
      const started = performance.now();
      const outcome = await runTestUnits([
        { name: 'hung', timeoutMs: 400, ...hung },
        { name: 'quick', ...node('') },
      ], { ...quiet, concurrency: 2, log: (line) => lines.push(line) });
      assert.ok(performance.now() - started < 8000, 'the hung unit must not stall the run');
      assert.equal(outcome.passed, false);
      assert.deepEqual(outcome.results.map((row) => [row.name, row.status, row.timedOut]), [['hung', 'failed', true], ['quick', 'passed', false]]);
      assert.ok(lines.some((line) => /hung exceeded/.test(line)));
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      for (let attempt = 0; attempt < 20 && alive(grandchild); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(grandchild), false, 'the timed-out unit\'s process group is killed');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  test('takes the unit budget from the unit, then the environment, then the default', () => {
    assert.equal(testUnitTimeoutMs({ timeoutMs: 1234 }, { DEVRYAN_TEST_UNIT_TIMEOUT_MS: '99' }), 1234);
    assert.equal(testUnitTimeoutMs({}, { DEVRYAN_TEST_UNIT_TIMEOUT_MS: '99' }), 99);
    assert.equal(testUnitTimeoutMs({}, {}), DEFAULT_TEST_UNIT_TIMEOUT_MS);
    assert.throws(() => testUnitTimeoutMs({}, { DEVRYAN_TEST_UNIT_TIMEOUT_MS: '0' }), /positive integer/);
  });

  test('runs units at the same time up to the bound and reports each one', async () => {
    const units = ['a', 'b', 'c'].map((name) => ({ name, ...node('setTimeout(() => {}, 700)') }));
    const outcome = await runTestUnits(units, { ...quiet, concurrency: 3 });
    assert.equal(outcome.passed, true);
    assert.ok(outcome.wallMs < 1900, `three 700 ms units took ${outcome.wallMs} ms with three slots`);
    assert.deepEqual(outcome.results.map((row) => [row.name, row.status]), [['a', 'passed'], ['b', 'passed'], ['c', 'passed']]);
    const serial = await runTestUnits(units.slice(0, 2), { ...quiet, concurrency: 1, log: () => {} });
    assert.ok(serial.wallMs >= 1300, `one slot must run units one after another (${serial.wallMs} ms)`);
  });

  test('a failure fails the run without skipping the other units, and fail-fast stops scheduling', async () => {
    const units = [
      { name: 'fails', ...node('process.exit(3)') },
      { name: 'passes', ...node('setTimeout(() => {}, 200)') },
      { name: 'later', ...node('') },
    ];
    const outcome = await runTestUnits(units, { ...quiet, concurrency: 2 });
    assert.equal(outcome.passed, false);
    assert.deepEqual(outcome.results.map((row) => [row.name, row.status, row.code]), [['fails', 'failed', 3], ['passes', 'passed', 0], ['later', 'passed', 0]]);
    const lines = [];
    summarizeTestUnits(outcome, { log: (line) => lines.push(line) });
    assert.ok(lines.some((line) => line === '[tests] FAILED: fails (exit 3)'));
    assert.match(lines[0], /2 passed, 1 failed, 0 not run/);

    const stopped = await runTestUnits([
      { name: 'fails', ...node('process.exit(1)') },
      { name: 'never', ...node('') },
    ], { ...quiet, concurrency: 1, failFast: true });
    assert.deepEqual(stopped.results.map((row) => row.status), ['failed', 'not-run']);
    const missing = await runTestUnits([{ name: 'missing', command: path.join(os.tmpdir(), 'devryan-missing-binary'), args: [] }], quiet);
    assert.equal(missing.passed, false);
  });

  test('prints each concurrent unit whole, never interleaved', async () => {
    const chatty = (tag) => node(`let n = 0; const t = setInterval(() => { console.log('${tag}-' + n); if (++n === 5) clearInterval(t); }, 20)`);
    const output = [];
    await runTestUnits([{ name: 'x', ...chatty('x') }, { name: 'y', ...chatty('y') }], { heartbeatMs: 0, concurrency: 2, env,
      log: (line) => output.push(`${line}\n`), write: (text) => output.push(text) });
    const text = output.join('');
    for (const tag of ['x', 'y']) {
      const start = process.env.GITHUB_ACTIONS === 'true' ? '::group::' : '===== ';
      const end = process.env.GITHUB_ACTIONS === 'true' ? '::endgroup::' : `===== end ${tag}`;
      assert.match(text, new RegExp(`${start}${tag}: passed in \\d+s\\n[^\\n]*\\n${tag}-0\\n${tag}-1\\n${tag}-2\\n${tag}-3\\n${tag}-4\\n${end}`));
    }
  });

  test('an interrupt stops every owned process group and removes scratch', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-pool-check-'));
    const callerScratch = path.join(scratch, 'caller');
    writeFileSync(callerScratch, '');
    try {
      // Each unit starts a grandchild that would outlive a plain child kill.
      const grandchild = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        require('node:fs').writeFileSync(process.argv[1], String(c.pid)); setInterval(() => {}, 1000);`;
      const runner = `import { runTestUnits } from ${JSON.stringify(new URL('./test-pool.mjs', import.meta.url).href)};
        import { rmSync } from 'node:fs';
        await runTestUnits([0, 1].map((index) => ({ name: 'u' + index, command: process.execPath, args: ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(scratch)} + '/pid-' + index] })),
          { concurrency: 2, heartbeatMs: 0, cleanup: () => rmSync(${JSON.stringify(callerScratch)}) });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { env: { ...env, TMPDIR: scratch }, stdio: 'ignore' });
      const deadline = Date.now() + 10_000;
      while (!['pid-0', 'pid-1'].every((name) => existsSync(path.join(scratch, name)) && readFileSync(path.join(scratch, name), 'utf8'))) {
        assert.ok(Date.now() < deadline, 'units did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const grandchildren = ['pid-0', 'pid-1'].map((name) => Number(readFileSync(path.join(scratch, name), 'utf8')));
      child.kill('SIGINT');
      const [code] = await new Promise((resolve) => child.once('exit', (...result) => resolve(result)));
      assert.equal(code, 130);
      const settled = Date.now() + 5000;
      while (grandchildren.some(alive) && Date.now() < settled) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(grandchildren.filter(alive), []);
      assert.equal(existsSync(callerScratch), false, 'caller cleanup did not run');
      assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith('devryan-test-pool-')), []);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  test('reads its bound from DEVRYAN_TEST_CONCURRENCY and refuses duplicate units', async () => {
    assert.equal(testConcurrency({ DEVRYAN_TEST_CONCURRENCY: '2' }), 2);
    assert.ok(testConcurrency({}) >= 1);
    assert.ok(testConcurrency({}) <= 2);
    assert.throws(() => testConcurrency({ DEVRYAN_TEST_CONCURRENCY: '0' }), /positive integer/);
    await assert.rejects(runTestUnits([{ name: 'a', ...node('') }, { name: 'a', ...node('') }], quiet), /Duplicate test unit/);
  });
  test('records unit timings only where DEVRYAN_TEST_TIMINGS points', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-timings-'));
    try {
      const outcome = { wallMs: 1234.4, results: [{ name: 'a', status: 'passed', durationMs: 1000.6 }, { name: 'b', status: 'failed', durationMs: 20 }] };
      const units = [{ name: 'a', suite: 'ui' }, { name: 'b' }];
      assert.equal(recordTestTimings(outcome, units, { environment: {} }), null);
      const file = path.join(scratch, 'nested', 'lane.json');
      assert.equal(recordTestTimings(outcome, units, { label: 'ci', environment: { DEVRYAN_TEST_TIMINGS: file } }), file);
      const record = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.wallMs, 1234);
      assert.deepEqual(record.units, [{ name: 'a', suite: 'ui', status: 'passed', ms: 1001 }, { name: 'b', suite: null, status: 'failed', ms: 20 }]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
