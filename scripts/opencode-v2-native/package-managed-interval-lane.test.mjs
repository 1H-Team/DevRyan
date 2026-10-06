import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gradeCompiledManagedInterval, managedIntervalPolicy, isCompiledIntervalParentCompletion } from './package-managed-interval-lane.mjs';
import { parseV2EventBlock } from '../../packages/web/server/lib/opencode/opencode-client/v2.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';

test('actual native terminal shape settles only the owned interval parent after its reply', () => {
  const directory = '/private/interval-project', rootID = 'ses_owned';
  const frame = (changes = {}) => parseV2EventBlock('data: ' + JSON.stringify({
    id: 'evt_owned', type: 'session.execution.succeeded', data: { sessionID: rootID }, ...changes,
  }));
  assert.equal(isCompiledIntervalParentCompletion(frame(), directory, rootID, true), true);
  assert.equal(isCompiledIntervalParentCompletion(frame({ location: { directory } }), directory, rootID, true), true);
  for (const parsed of [frame({ data: { sessionID: 'ses_child' } }), frame({ location: { directory: '/foreign' } }),
    frame({ location: { directory: '' } }), frame({ type: 'session.execution.failed' })]) {
    assert.equal(isCompiledIntervalParentCompletion(parsed, directory, rootID, true), false);
  }
  assert.equal(isCompiledIntervalParentCompletion(frame(), directory, rootID, false), false);
  assert.equal(isCompiledIntervalParentCompletion(frame(), directory, undefined, true), false);
});

// Finite synthetic policy records only: no native, provider or OS measurements.
const cohort = () => managedIntervalPolicy.order.map(intervalMs => ({ intervalMs, correctness: 'passed', cleanup: 'passed',
  identity: { artifactSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64) },
  quietReads: { active: intervalMs === 750 ? 6 : 3, history: 0 }, httpOperations: intervalMs === 750 ? 30 : 27,
  proof: { receiptToken: 'owned-writer' },
  timing: { status: 'measured', waitSettlementMs: intervalMs === 750 ? 20 : 30 },
  resources: { samples: [{ processes: [{ pid: 456, startIdentity: 'writer-start' }] }], failures: [], exitedBeforeSample: [],
    receiptProcessIdentities: { status: 'observed', required: 1, observed: 1,
      identities: [{ receiptToken: 'owned-writer', pid: 456, startIdentity: 'writer-start' }] },
    processOwnership: { rootIdentity: 'owned-start', observedProcesses: [{ pid: 123, startIdentity: 'native-start' }] },
    metrics: { hostCpuMs: 100, sampledDescendantCpuMs: 100, peakHostRssMiB: 80, peakDescendantRssMiB: 100 } } }));

test('prospective compiled interval diagnostic requires complete same-artifact causal and resource evidence without claiming retention', () => {
  assert.deepEqual(managedIntervalPolicy.order, [750, 1500, 1500, 750, 750, 1500]);
  assert.equal(managedIntervalPolicy.quietHoldMs, 4500);
  const complete = gradeCompiledManagedInterval(cohort());
  assert.equal(complete.status, 'measured'); assert.equal(complete.diagnosticCriteriaSatisfied, true);
  assert.equal(complete.productionRetentionQualified, false);
  assert.deepEqual(complete.quietReads, { baseline: 6, candidate: 3 });
  const incomplete = cohort().slice(1);
  assert.equal(gradeCompiledManagedInterval(incomplete).status, 'inconclusive');
  for (const alter of [
    rows => { rows[1].identity.artifactSha256 = 'd'.repeat(64); },
    rows => { rows[1].identity.configurationSha256 = 'd'.repeat(64); },
    rows => { rows[1].timing.status = 'inconclusive'; },
    rows => { rows[1].timing.waitSettlementMs = undefined; },
    rows => { rows[1].timing.waitSettlementMs = -1; },
    rows => { rows[1].cleanup = 'failed'; },
    rows => { rows[1].quietReads.active = undefined; },
    rows => { rows[1].resources.receiptProcessIdentities.status = 'unavailable'; },
    rows => { rows[1].resources.receiptProcessIdentities.required = 0; },
    rows => { rows[1].resources.receiptProcessIdentities.identities = [null]; },
    rows => { rows[1].resources.receiptProcessIdentities.identities[0].receiptToken = 'foreign'; },
    rows => { rows[1].resources.samples[0].processes[0].startIdentity = 'reused-pid'; },
    rows => { rows[1].resources.failures = undefined; },
    rows => { rows[1].resources.exitedBeforeSample = undefined; },
    rows => { rows[1].resources.processOwnership.rootIdentity = null; },
    rows => { rows[1].resources.exitedBeforeSample.push({ pid: 123 }); },
    rows => { rows[1].resources.metrics.hostCpuMs = NaN; },
  ]) {
    const rows = cohort(); alter(rows);
    const result = gradeCompiledManagedInterval(rows);
    assert.equal(result.status, 'inconclusive'); assert.equal(result.diagnosticCriteriaSatisfied, false);
  }
  for (const alter of [
    row => { row.quietReads.active = 5; },
    row => { row.timing.waitSettlementMs = 121; },
    row => { row.resources.metrics.hostCpuMs = 131; },
    row => { row.resources.metrics.peakHostRssMiB = 97; },
    row => { row.httpOperations = 35; },
  ]) {
    const rows = cohort(); rows.filter(row => row.intervalMs === 1500).forEach(alter);
    const result = gradeCompiledManagedInterval(rows);
    assert.equal(result.status, 'measured'); assert.equal(result.diagnosticCriteriaSatisfied, false);
  }
});

test('exited-process diagnostics preserve valid metrics while the exact receipt writer still requires a sample', () => {
  const rows = cohort();
  rows[1].resources.exitedBeforeSample.push({ pid: 789, startIdentity: 'unrelated-helper-start', at: 1 });
  const measured = gradeCompiledManagedInterval(rows);
  assert.equal(measured.status, 'measured');
  assert.equal(measured.diagnosticCriteriaSatisfied, true);
  assert.equal(measured.resources.length, 4);
  assert.equal(rows[1].resources.exitedBeforeSample.length, 1);

  rows[1].resources.samples[0].processes = [{ pid: 789, startIdentity: 'unrelated-helper-start' }];
  const missingWriter = gradeCompiledManagedInterval(rows);
  assert.equal(missingWriter.status, 'inconclusive');
  assert.ok(missingWriter.reasons.includes('owned_resource_identity_unavailable'));
  assert.equal(missingWriter.diagnosticCriteriaSatisfied, false);
});

test('original interval CLI reports a failed first arm without an unsettled import await or native/provider execution', { timeout: 30_000 }, async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const cache = path.join(repository, '.cache/v2-validation');
  await fs.mkdir(cache, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(cache, 'managed-interval-cli-test-'));
  const artifactRoot = path.join(fixture, 'empty-artifact');
  const recordedRoots = path.join(fixture, 'created-roots.jsonl');
  let recorder;
  try {
    await fs.mkdir(artifactRoot);
    const preload = path.join(fixture, 'record-roots.mjs');
    // Observe only directories created by this original child, including the
    // policy root published before the old CLI import cycle could settle.
    await fs.writeFile(preload, `import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
const original = fs.mkdtemp;
fs.mkdtemp = async (...args) => {
  const root = await original(...args);
  writeSync(3, JSON.stringify(root) + '\\n');
  return root;
};
`, { flag: 'wx', mode: 0o600 });
    recorder = await fs.open(recordedRoots, 'wx', 0o600);
    const environment = createQaHostLaunchEnvironment({ HOME: fixture, TMPDIR: fixture,
      GIT_CEILING_DIRECTORIES: repository, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
    const child = spawn(process.execPath, ['--import', preload,
      path.join(repository, 'scripts/opencode-v2-native/package-managed-interval-lane.mjs'), '--artifact-root', artifactRoot],
    { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', recorder.fd] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    assert.equal(exit.signal, null, 'Original CLI exceeded its disposable subprocess bound');
    assert.equal(exit.code, 1, Buffer.concat(stderr).toString('utf8'));
    assert.doesNotMatch(Buffer.concat(stderr).toString('utf8'), /unsettled top-level await/i);
    const output = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    assert.equal(output.status, 'inconclusive');
    assert.equal(output.diagnosticCriteriaSatisfied, false);
    const created = (await fs.readFile(recordedRoots, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(created.includes(path.dirname(output.result)), 'Returned diagnostic root must belong to this subprocess');
    const result = JSON.parse(await fs.readFile(output.result, 'utf8'));
    assert.equal(result.arms.length, 1);
    assert.equal(result.arms[0].intervalMs, 750);
    assert.equal(result.arms[0].cleanup, 'failed');
    assert.equal(result.productionRetentionQualified, false);
    assert.ok(created.includes(path.dirname(result.arms[0].packageResult)), 'Returned package root must belong to this subprocess');
    const arm = JSON.parse(await fs.readFile(result.arms[0].packageResult, 'utf8'));
    assert.equal(arm.status, 'failed');
    assert.equal(arm.error.code, 'ENOENT');
    assert.match(arm.error.message, /native-bundle\.json/);
    assert.deepEqual(arm.cases, []);
    assert.deepEqual(arm.observations, []);
    assert.deepEqual(arm.diagnostics, []);
    assert.deepEqual(arm.cleanupFailures, []);
    assert.equal(arm.sourceCohort.valid, true);
  } finally {
    await recorder?.close();
    const roots = await fs.readFile(recordedRoots, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const root of roots.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) {
      assert.ok(root.startsWith(path.join(cache, 'managed-interval-')) || root.startsWith(path.join(cache, 'package-')));
      assert.equal(await fs.realpath(root), root);
      await fs.rm(root, { recursive: true });
    }
    await fs.rm(fixture, { recursive: true });
  }
});
