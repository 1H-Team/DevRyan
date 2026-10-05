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
  assert.deepEqual(workflow.on.push.branches, ['release/2.0.2']);
  assert.deepEqual(workflow.on.push.paths, workflow.on.pull_request.paths);
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with.architecture, '${{ matrix.arch }}');
  assert.equal(job.env.GIT_CEILING_DIRECTORIES, '${{ github.workspace }}/.cache/test-fixtures');
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /process\.arch!==process\.env\.EXPECTED_ARCH/);
  assert.match(commands, /--frozen-lockfile --ignore-scripts/);
  assert.match(commands, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.ARM64/);
  assert.match(commands, /build-session-execution\.mjs.*--verify/);
  assert.match(commands, /bun scripts\/build-native-runtime\.mjs/);
  assert.match(commands, /node scripts\/verify-opencode-v2-package\.mjs/);
  assert.doesNotMatch(commands, /npm publish|supabase|gh release|git (?:push|tag)|docker (?:push|login)|checkpoint-export/);
  assert.ok(!job.steps.some(step => /action-gh-release|login-action/.test(step.uses ?? '')));
  const byID = Object.fromEntries(job.steps.filter(step => step.id).map(step => [step.id, step]));
  assert.ok(!byID.runtime.if.includes('supervisor'), 'Supervisor refusal must not hide an independent controller/writer build failure');
  assert.ok(byID.runtime_acceptance.if.includes("steps.supervisor_acceptance.outcome == 'success'"));
  const required = job.steps.find(step => step.env?.SUPERVISOR_ACCEPTANCE);
  assert.equal(required.if, '${{ always() }}');
  assert.equal(required['continue-on-error'], undefined);
  assert.deepEqual(Object.keys(required.env).sort(), ['RUNTIME', 'RUNTIME_ACCEPTANCE', 'SUPERVISOR', 'SUPERVISOR_ACCEPTANCE']);
  assert.match(required.run, /\$outcome -ne 'success'/);
  assert.match(required.run, /if \(\$failed\).*throw/);
  const processSource = fs.readFileSync(new URL('../packages/web/server/lib/opencode/runtime-host/native-process.js', import.meta.url), 'utf8');
  assert.match(processSource, /process\.platform !== 'darwin'.*native_controller_supervisor_unavailable/);
});

test('the Windows supervisor requires kernel job assignment before creating a child', () => {
  const source = fs.readFileSync(new URL('../packages/harness-runtime/native/session-execution-windows.c', import.meta.url), 'utf8');
  const attributes = source.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST');
  const create = source.indexOf('checked(CreateProcessAsUserW(');
  assert.ok(attributes > 0 && attributes < create);
  assert.match(source, /&job, sizeof\(job\), NULL, NULL\), "atomic command ownership"/);
  assert.doesNotMatch(source, /if\s*\(!AssignProcessToJobObject/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.doesNotMatch(source, /JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK/);
});
