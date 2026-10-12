import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireDisposableMacRunner } from './macos-gui-prerequisites.mjs';
import { createExecutionHostOwner, executionHostOwnerLost } from '../../packages/harness-runtime/lib/execution-host-owner.js';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';

/** A private historical ledger records a claimed process whose owner died without a termination receipt. */
export async function seedReleaseUnsettledProcess(profile, scope) {
  requireDisposableMacRunner();
  for (const key of ['sessionID', 'messageID', 'userMessageID', 'callID']) assert.ok(typeof scope[key] === 'string' && scope[key]);
  const launch = profile.binding().descriptor.launch;
  const launcher = path.join(path.dirname(launch.artifactManifestPath), `DevRyan-execution-${process.platform}-${process.arch}`);
  const directory = path.join(launch.webDataDirectory, 'harness/execution-owners');
  const owner = await createExecutionHostOwner({ directory, launcher });
  const runtime = createSessionMutationRuntime({ directory: path.join(launch.webDataDirectory, 'harness/session-mutations') });
  let lease;
  try {
    const reserved = await runtime.reserve({ directory: profile.workspace, ...scope, ownerID: owner.id });
    const prepared = await runtime.prepare(reserved);
    lease = await runtime.claimLease({ directory: profile.workspace, token: prepared.token, kind: 'process' });
    await fs.writeFile(path.join(lease.viewDirectory, 'unpublished-fixture.txt'), 'Retain until reboot recovery.\n', { mode: 0o600 });
    assert.equal(await executionHostOwnerLost({ directory, launcher, id: owner.id }), false);
  } finally { try { await runtime.drain(); } finally { await owner.close(); } }
  assert.equal(await executionHostOwnerLost({ directory, launcher, id: owner.id }), true);
  return { token: lease.token, ownerID: owner.id, viewDirectory: lease.viewDirectory, ownerLost: true, receiptMissing: true };
}

export async function releaseFixtureScope(launch, profile, sessionID) {
  const result = await launch.request(`/api/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(profile.workspace)}`);
  assert.equal(result.status, 200);
  const user = result.body.find(row => row.info?.role === 'user');
  const assistant = result.body.find(row => row.info?.role === 'assistant' && row.info?.time?.completed);
  assert.ok(user?.info?.id && assistant?.info?.id);
  return { sessionID, userMessageID: user.info.id, messageID: assistant.info.id, callID: 'release-unsettled-fixture' };
}
