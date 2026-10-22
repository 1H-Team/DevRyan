import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INFRA, PRODUCT, boundedDiagnostic, classifyQualificationFailure, describeQualificationError, retryInfraOnce } from './release-qualification-failure.mjs';

const command = (name, stderr = '') => Object.assign(new Error(`Qualification ${name} exited (1)`), { code: 'qa_release_upgrade_command', command: name, exitCode: 1, stderr });

test('runner and network failures are infra; candidate failures and unknown errors are product', () => {
  for (const error of [command('gh'), command('git'), command('bun'), command('hdiutil'), command('ditto'), command('tar'),
    new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), new Error('hdiutil: attach failed - Resource busy'), new Error('Baseline installer digest mismatch')]) {
    assert.equal(classifyQualificationFailure(error), INFRA, error.message);
  }
  for (const error of [command('node'), new Error('Candidate producer failure'), new Error('Candidate runtime changed during qualification'),
    Object.assign(new Error('boot'), { code: 'native_process_boot_timeout' }), new Error('Sessions lost across the upgrade'), 'a string', null]) {
    assert.equal(classifyQualificationFailure(error), PRODUCT, String(error?.message ?? error));
  }
  assert.equal(classifyQualificationFailure(Object.assign(command('gh'), { qualificationClass: PRODUCT })), PRODUCT, 'an explicit class wins');
});

test('error text includes the command and its stderr tail, bounded and with run paths and tokens removed', () => {
  const text = describeQualificationError(command('gh', `line 1\nfailed at /private/run/x/home with token ghs_${'a'.repeat(36)}\n`), { runRoot: '/private/run/x' });
  assert.equal(text, 'Qualification gh exited (1) [gh exit 1] stderr: line 1 | failed at <run>/home with token <redacted>');
  assert.ok(describeQualificationError(new Error('z'.repeat(5000))).length <= 600);
  assert.equal(boundedDiagnostic(`a\u0000b ${'x'.repeat(40)}`), 'a?b <redacted>');
});

test('infra is retried exactly once and product never', async () => {
  const lines = [];
  let calls = 0;
  assert.equal(await retryInfraOnce('download', async attempt => { calls++; if (attempt === 1) throw command('gh'); return 'ok'; }, { log: line => lines.push(line) }), 'ok');
  assert.equal(calls, 2);
  assert.match(lines.join('\n'), /download attempt 1 failed \(infra\).*\n.*retrying download once/);
  calls = 0;
  await assert.rejects(retryInfraOnce('download', async () => { calls++; throw command('gh'); }, { log: () => {} }), { qualificationClass: INFRA });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retryInfraOnce('qualify', async () => { calls++; throw new Error('Sessions lost'); }, { log: () => {} }), { qualificationClass: PRODUCT });
  assert.equal(calls, 1);
});
