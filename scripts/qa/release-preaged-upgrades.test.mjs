import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPreagedUpgrades } from './release-preaged-upgrades.mjs';

const infra = () => Object.assign(new Error('Qualification gh exited (1)'), { code: 'qa_release_upgrade_command', command: 'gh', exitCode: 1, stderr: 'HTTP 502: Bad Gateway' });

for (const failure of [null, 'producer', 'candidate', 'cleanup']) test(`the previous-release lane prepares, qualifies and cleans local state (${failure ?? 'success'})`, async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  const calls = [];
  let scratch;
  try {
    const options = { reportDirectory, digest: async () => 'unchanged', log: () => {},
      prepare: async options => {
        const lane = options.directBaseline;
        calls.push(`prepare:${lane}`);
        return {
          qualify: async candidate => {
            assert.equal(candidate, '/candidate');
            calls.push(`qualify:${lane}`);
            if (failure === 'candidate') throw new Error('candidate failed');
            await fs.writeFile(options.report, JSON.stringify({ passed: true }));
            return { passed: true };
          },
          cleanup: async () => { calls.push(`cleanup:${lane}`); if (failure === 'cleanup') throw new Error('cleanup failed'); },
        };
      },
      acquire: async root => { scratch = root; calls.push('acquire'); if (failure === 'producer') throw new Error('Candidate producer failure'); return '/candidate'; },
    };
    if (failure) await assert.rejects(runPreagedUpgrades(options), /failed|failure/);
    else assert.equal((await runPreagedUpgrades(options)).passed, true);
    assert.deepEqual(calls.slice(0, 2), ['prepare:previous', 'acquire'], 'a product failure of the producer is never retried');
    assert.deepEqual(calls.filter(call => call.startsWith('cleanup:')), ['cleanup:previous']);
    if (!failure) assert.deepEqual(calls.slice(2, 3), ['qualify:previous']);
    await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
    assert.equal((await fs.readdir(reportDirectory)).length, 2);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});

test('candidate mutation invalidates otherwise passing profiles', async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  let count = 0;
  try {
    await assert.rejects(runPreagedUpgrades({ reportDirectory, digest: async () => String(count++), acquire: async () => '/candidate', log: () => {},
      prepare: async () => ({ qualify: async () => ({ passed: true }), cleanup: async () => {} }) }), /changed/);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});

test('an infrastructure failure in setup is retried once with its error text logged', async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  const lines = [];
  let prepares = 0, acquires = 0;
  const deadlines = [];
  try {
    const result = await runPreagedUpgrades({ reportDirectory, digest: async () => 'same', log: line => lines.push(line),
      prepare: async options => {
        if (++prepares === 1) throw infra();
        return { qualify: async () => { await fs.writeFile(options.report, '{"passed":true}'); return { passed: true }; }, cleanup: async () => {} };
      },
      acquire: async (_root, _environment, attempt, deadline) => {
        acquires++;
        deadlines.push(deadline);
        if (attempt === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return '/candidate';
      } });
    assert.equal(result.passed, true);
    assert.deepEqual([prepares, acquires], [2, 2]);
    assert.equal(deadlines[0], deadlines[1], 'an infrastructure retry cannot reset the producer budget');
    assert.match(lines.join('\n'), /prepare:previous attempt 1 failed \(infra\): Qualification gh exited \(1\) \[gh exit 1\] stderr: HTTP 502: Bad Gateway/);
    assert.match(lines.join('\n'), /candidate-download attempt 1 failed \(infra\): fetch failed/);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});

test('a second infrastructure failure or any product failure in setup is not retried again', async () => {
  for (const [error, expectedPrepares] of [[infra, 2], [() => Object.assign(new Error('Baseline release lacks a verified installer identity')), 1]]) {
    const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
    let prepares = 0, acquired = false;
    try {
      await assert.rejects(runPreagedUpgrades({ reportDirectory, log: () => {}, prepare: async () => { prepares++; throw error(); },
        acquire: async () => { acquired = true; return '/candidate'; } }), err => typeof err.qualificationClass === 'string');
      assert.equal(prepares, expectedPrepares);
      assert.equal(acquired, false);
      assert.equal((await fs.readdir(reportDirectory)).length, 2, 'missing lane reports are still written');
      const timings = JSON.parse(await fs.readFile(path.join(reportDirectory, 'qualification-timings.json'), 'utf8'));
      assert.equal(timings.passed, false);
    } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
  }
});
