import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionExecutionHost } from '../../packages/web/server/lib/opencode/session-execution-host.js';

// Diagnostic of the actual host contract, not a simulated process receipt.
test('terminal host drain permanently fences context assets even with a fresh controller grant', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/host-lifetime-'));
  let captures = 0, generation = 1;
  const marker = Object.assign(Error('captured_current_controller'), { code: 'captured_current_controller' });
  const host = createSessionExecutionHost({ dataDirectory: root, openCodeClient: { generation: () => 2 },
    nativeExecution: { locations: [{ directory: root }], captureContextAssets: async () => { captures++; assert.ok(generation > 0); throw marker; } } });
  const scope = { directory: root, sessionID: 'ses_lifetime', messageID: 'msg_user', messageIDs:['msg_user'], permit: { token: 'private' } };
  try {
    await assert.rejects(host.nativeContextAssets(scope), error => error === marker);
    assert.equal(captures, 1);
    await host.drain(); generation++;
    await assert.rejects(host.nativeContextAssets(scope), error => error.code === 'execution_cancelled');
    await assert.rejects(host.nativeInterviewDocument(scope, {}), error => error.code === 'execution_cancelled');
    assert.equal(captures, 1, 'A new grant cannot revive the permanently aborted host lifetime');
  } finally { await host.drain(); await fs.rm(root, { recursive: true, force: true }); }
});
