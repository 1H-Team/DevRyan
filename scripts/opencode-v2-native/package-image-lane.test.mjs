import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createCompiledImageLane } from './package-image-lane.mjs';
import { createOpenAiOAuthCoordinator } from '../../packages/web/server/lib/opencode/openai-oauth-coordinator.js';

test('finite image transport is captured during initial and replacement startup and refuses unrelated network after restoration', { timeout: 45000 }, async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/image-lane-'));
  const server = http.createServer((_request, response) => { response.end('owned fixture origin'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, original = globalThis.fetch;
  const lane = createCompiledImageLane({ root, getOwnedOrigins: () => [origin] });
  try {
    await fs.mkdir(path.join(root, 'project')); await fs.writeFile(path.join(root, 'native.sqlite'), '');
    const prepared = await lane.prepare({ databasePath: path.join(root, 'native.sqlite'), directory: path.join(root, 'project') });
    assert.equal(prepared.sourceOAuthCreation, true); assert.equal(prepared.compiledOAuthCreation, false);
    let captured;
    await lane.withCapturedTransport(async () => {
      captured = globalThis.fetch; assert.notEqual(captured, original);
      assert.equal(await (await captured(origin)).text(), 'owned fixture origin');
      await assert.rejects(captured('https://example.invalid/private'), /denied non-owned transport/);
      await assert.rejects(captured('https://api.openai.com/v1/responses', { method: 'POST' }), /Unexpected or repeated physical image/);
      await assert.rejects(captured('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' }), /denied non-owned transport/);
      await assert.rejects(captured('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', redirect: 'error',
        body: new URLSearchParams({ grant_type: 'client_credentials' }) }));
    });
    assert.equal(globalThis.fetch, original);
    await assert.rejects(captured('http://127.0.0.1:1/unowned'), /denied non-owned transport/);
    const marker = Error('owned startup failed');
    await assert.rejects(lane.withCapturedTransport(async () => { throw marker; }), error => error === marker);
    assert.equal(globalThis.fetch, original);
    let auth = {
      type: 'oauth', methodID: 'chatgpt-siwc', accountId: 'owned-image-account-B',
      access: 'owned-image-access-B', refresh: 'owned-image-refresh-B', expires: 0,
      clientId: 'oaiapp_fixture_client',
      scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
    };
    let writes = 0;
    const owner = { async start() {
      const coordinator = createOpenAiOAuthCoordinator({ asyncStorage: {
        isActive: () => true, readAuth: async () => auth,
        compareAndSwap: async (expected, next) => { assert.deepEqual(expected, auth); auth = next; writes++; return true; },
      } });
      coordinator.markReady(); return coordinator;
    } };
    // Coordinator refresh is independently exercised here; the compiled image
    // lane must refuse SIWC without reaching this endpoint. Every replacement
    // must capture the same finite fetch before it is restored.
    await lane.withCapturedTransport(() => owner.start());
    lane.captureRestarts(owner);
    const replacement = await owner.start();
    assert.equal(globalThis.fetch, original);
    const refreshed = await replacement.access({ expectedAccountId: auth.accountId });
    assert.equal(refreshed.accessToken, 'owned-image-access-B-refreshed');
    assert.equal(auth.refresh, 'owned-image-refresh-B-rotated'); assert.equal(writes, 1);
    const repeated = await owner.start();
    assert.equal(globalThis.fetch, original);
    assert.equal((await repeated.access({ expectedAccountId: auth.accountId })).accessToken, refreshed.accessToken);
    assert.equal(writes, 1, 'Replacement repeated the settled refresh');
    await lane.close();
    await assert.rejects(captured(origin), /after close/);
  } finally {
    assert.equal(globalThis.fetch, original); await lane.close();
    await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
  }
});
