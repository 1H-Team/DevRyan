import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPreagedUpgrades } from './release-preaged-upgrades.mjs';

for (const failure of [null, 'producer', 'candidate', 'cleanup']) test(`pre-aging preserves all lanes and cleans local state (${failure ?? 'success'})`, async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  const calls = [];
  let scratch;
  try {
    const options = { reportDirectory, digest: async () => 'unchanged',
      prepare: async options => {
        const lane = options.directBaseline ?? 'aging';
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
      acquire: async root => { scratch = root; calls.push('acquire'); if (failure === 'producer') throw new Error('producer failed'); return '/candidate'; },
    };
    if (failure) await assert.rejects(runPreagedUpgrades(options), /failed/);
    else assert.equal((await runPreagedUpgrades(options)).passed, true);
    assert.deepEqual(calls.slice(0, 4), ['prepare:v2.0.2', 'prepare:aging', 'prepare:v2.0.15', 'acquire']);
    assert.deepEqual(calls.filter(call => call.startsWith('cleanup:')), ['cleanup:v2.0.2', 'cleanup:aging', 'cleanup:v2.0.15']);
    if (!failure) assert.deepEqual(calls.slice(4, 7), ['qualify:v2.0.2', 'qualify:aging', 'qualify:v2.0.15']);
    await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
    assert.equal((await fs.readdir(reportDirectory)).length, 4);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});

test('candidate mutation invalidates otherwise passing profiles', async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  let count = 0;
  try {
    await assert.rejects(runPreagedUpgrades({ reportDirectory, digest: async () => String(count++), acquire: async () => '/candidate',
      prepare: async () => ({ qualify: async () => ({ passed: true }), cleanup: async () => {} }) }), /changed/);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});

test('partial profile preparation cleans completed lanes and writes missing reports', async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-preaged-test-'));
  const cleaned = [];
  let acquired = false;
  try {
    await assert.rejects(runPreagedUpgrades({ reportDirectory,
      prepare: async options => {
        if (options.directBaseline !== 'v2.0.2') throw new Error('preparation failed');
        return { cleanup: async () => { cleaned.push('v2.0.2'); } };
      },
      acquire: async () => { acquired = true; return '/candidate'; },
    }), /preparation failed/);
    assert.equal(acquired, false);
    assert.deepEqual(cleaned, ['v2.0.2']);
    assert.equal((await fs.readdir(reportDirectory)).length, 4);
    const timings = JSON.parse(await fs.readFile(path.join(reportDirectory, 'qualification-timings.json'), 'utf8'));
    assert.equal(timings.passed, false);
  } finally { await fs.rm(reportDirectory, { recursive: true, force: true }); }
});
