import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runtimeCompatibilityCases, runtimeCompatibilityProject, compatibilityPayload, validateLocalStdioReceipt } from './diagnose-windows-runtime-compatibility.mjs';

test('real project scripts exercise EOF, binary/backpressure, sync/async spawning and ignored/inherited streams', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-project-contract-'));
  try {
    await fs.writeFile(path.join(root, 'project.cjs'), runtimeCompatibilityProject);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'devryan-lpac-project', scripts: { build: 'node project.cjs leaf' } }));
    assert.equal(runtimeCompatibilityCases.length, 8);
    for (const executable of [process.execPath, 'bun']) for (const cell of runtimeCompatibilityCases) {
      const result = spawnSync(executable, ['project.cjs', cell.mode], { cwd: root, input: compatibilityPayload(cell.size), timeout: 15000, maxBuffer: 1048576 });
      assert.equal(result.error, undefined); assert.equal(result.status, 0);
      const expected = cell.mode === 'ignore' ? Buffer.alloc(0) : compatibilityPayload(cell.size);
      assert.deepEqual(result.stdout, expected); assert.deepEqual(result.stderr, expected);
      if (cell.mode !== 'ignore') assert.deepEqual(await fs.readFile(path.join(root, 'build-output.bin')), expected);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local stdio evidence refuses missing settlement, widened keys, corrupted bytes and inference of admission', () => {
  const receipt = { protocol: 'devryan.windows-local-stdio/1', created: true, windowsError: 0, exitCode: 0, settled: true,
    inputBytes: 0, inputError: 0, stdoutBytes: 0, stdoutHash: 2166136261, stdoutError: 0,
    stderrBytes: 0, stderrHash: 2166136261, stderrError: 0, admission: false };
  assert.equal(validateLocalStdioReceipt(receipt, runtimeCompatibilityCases[0]), receipt);
  for (const change of [{ created: false }, { settled: false }, { admission: true }, { stdoutHash: 0 }, { stderrBytes: 1 },
    { inputError: 5 }, { exitCode: 125 }, { extra: true }]) assert.throws(() => validateLocalStdioReceipt({ ...receipt, ...change }, runtimeCompatibilityCases[0]));
});
