import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('package qualification refuses Bun before starting an owned runtime and gives the shipping Node command', async () => {
  await assert.rejects(run('bun', ['scripts/verify-opencode-v2-package.mjs', '--artifact-root', '/unowned-artifact'],
    { cwd: process.cwd(), timeout: 10_000, maxBuffer: 4096 }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'native_package_node_host_required: Run node scripts/verify-opencode-v2-package.mjs\n');
    return true;
  });
});
test('imported package acceptance also refuses an unsupported Bun host before fixture creation', async () => {
  const code = "const {runNativePackageAcceptance}=await import('./scripts/verify-opencode-v2-package.mjs');try{await runNativePackageAcceptance({artifactRoot:'/unowned-artifact'});process.exit(2)}catch(error){if(error.code!=='native_package_node_host_required')throw error}";
  const result = await run('bun', ['--eval', code], { cwd: process.cwd(), timeout: 10_000, maxBuffer: 4096 });
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
test('focused retained-shell qualification requires diagnostic scope before fixture creation', async () => {
  const { runNativePackageAcceptance } = await import('../verify-opencode-v2-package.mjs');
  for (const options of [{}, { diagnostic: true, preflight: true }, { diagnostic: true, managedCorrectness: true }]) {
    await assert.rejects(runNativePackageAcceptance({ retainedShellDiagnostic: true, ...options }),
      /Retained shell diagnostic is a separate compiled qualification/);
  }
});
