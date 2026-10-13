import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureReleaseLocks, acceptableReleaseLocks } from './release-startup-evidence.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

test('lock evidence distinguishes missing, malformed and live tracked locks without arguments or tokens', async () => {
  const parent = path.resolve('.cache/release-startup-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'locks-'));
  const profile = { env: { OPENCHAMBER_DATA_DIR: root } };
  const sanitizer = createDiagnosticSanitizer({ homeDir: root });
  try {
    assert.equal(acceptableReleaseLocks(await captureReleaseLocks(profile, null, sanitizer)), true);
    await fs.mkdir(path.join(root, 'runtime-service'));
    const mutation = path.join(root, 'runtime-service/owner.v1.lock.mutation');
    await fs.writeFile(mutation, '{');
    const malformed = await captureReleaseLocks(profile, null, sanitizer);
    assert.equal(malformed.locks.mutation.state, 'malformed');
    assert.equal(malformed.locks.mutation.size, 1);
    assert.equal(acceptableReleaseLocks(malformed), false);
    await fs.writeFile(mutation, JSON.stringify({ ownerToken: 'never-retain-this', pid: process.pid, createdAt: Date.now() }));
    const live = await captureReleaseLocks(profile, null, sanitizer);
    assert.equal(live.locks.mutation.state, 'valid');
    assert.equal(live.locks.mutation.alive, true);
    assert.equal(live.locks.mutation.relation, 'unrelated');
    assert.ok(live.locks.mutation.startIdentity); assert.ok(live.locks.mutation.processName);
    assert.doesNotMatch(JSON.stringify(live), /never-retain-this|commandArgs|environment/);
    const app = { getCleanupEvidence: () => ({ observedProcesses: [{ pid: process.pid, startIdentity: live.locks.mutation.startIdentity }] }) };
    assert.equal((await captureReleaseLocks(profile, app, sanitizer)).locks.mutation.relation, 'tracked');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
