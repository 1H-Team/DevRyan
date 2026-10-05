import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

test('Windows qualification builds and executes independent pinned native architectures with no publication authority', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs.native;
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.include, [{ runner: 'windows-2022', arch: 'x64' }, { runner: 'windows-11-arm', arch: 'arm64' }]);
  assert.equal(job.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@')).with['bun-version'], '1.3.14');
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with.architecture, '${{ matrix.arch }}');
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /process\.arch!==process\.env\.EXPECTED_ARCH/);
  assert.match(commands, /--frozen-lockfile --ignore-scripts/);
  assert.match(commands, /build-session-execution\.mjs.*--verify/);
  assert.match(commands, /bun scripts\/build-native-runtime\.mjs/);
  assert.match(commands, /node scripts\/verify-opencode-v2-package\.mjs/);
  assert.doesNotMatch(commands, /npm publish|supabase|gh release|git (?:push|tag)|docker (?:push|login)|checkpoint-export/);
  assert.ok(!job.steps.some(step => /action-gh-release|login-action/.test(step.uses ?? '')));
  const processSource = fs.readFileSync(new URL('../packages/web/server/lib/opencode/runtime-host/native-process.js', import.meta.url), 'utf8');
  assert.match(processSource, /process\.platform !== 'darwin'.*native_controller_supervisor_unavailable/);
});
