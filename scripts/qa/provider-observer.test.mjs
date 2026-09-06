import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QaProviderObserver from './provider-observer.mjs';

test('observer records reasoning controls without mutating options or recording unrelated provider data', async () => {
  const cacheRoot = fileURLToPath(new URL('../../.cache/', import.meta.url));
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(path.join(cacheRoot, 'observer-test-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  await writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
  const previous = [process.env.DEVRYAN_QA_RUNTIME_ROOT, process.env.DEVRYAN_QA_HOME];
  process.env.DEVRYAN_QA_RUNTIME_ROOT = root;
  process.env.DEVRYAN_QA_HOME = home;
  const options = { reasoningEffort: 'high', reasoningSummary: 'detailed', thinking: { type: 'adaptive', secret: 'private' },
    output_config: { effort: 'medium', prompt: 'private' }, headers: { authorization: 'private' }, apiKey: 'private', prompt: 'private' };
  const before = structuredClone(options);
  try {
    const observer = await QaProviderObserver();
    await observer['chat.params']({ sessionID: 'ses_test', message: { id: 'msg_test' }, model: { id: 'model', providerID: 'openai' } }, { options });
    const contents = await readFile(path.join(root, 'provider-evidence.ndjson'), 'utf8');
    const records = contents.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.at(-1).options, { reasoningEffort: 'high', reasoningSummary: 'detailed',
      thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    assert.equal(contents.includes('private'), false);
    assert.deepEqual(options, before);
    await observer.event({ event: { type: 'session.error', properties: { sessionID: 'ses_test',
      error: { name: 'UnknownError', data: { message: 'private', authorization: 'private' } } } } });
    const updated = await readFile(path.join(root, 'provider-evidence.ndjson'), 'utf8');
    const failure = JSON.parse(updated.trim().split('\n').at(-1));
    assert.equal(failure.kind, 'native.session.error');
    assert.equal(failure.errorName, 'UnknownError');
    assert.equal(updated.includes('private'), false);
    await observer.event({ event: { type: 'permission.asked', properties: {
      id: 'per_test', sessionID: 'ses_test', permission: 'external_directory', patterns: ['private'],
      metadata: { path: 'private' }, tool: { messageID: 'msg_test', callID: 'call_test' },
    } } });
    await observer.event({ event: { type: 'permission.replied', properties: {
      sessionID: 'ses_test', requestID: 'per_test', reply: 'reject', explanation: 'private',
    } } });
    const permissionContents = await readFile(path.join(root, 'provider-evidence.ndjson'), 'utf8');
    const permissionRows = permissionContents.trim().split('\n').map(JSON.parse).slice(-2)
      .map(({ at: _at, schemaVersion: _schemaVersion, ...record }) => record);
    assert.deepEqual(permissionRows, [
      { kind: 'native.permission.asked', sessionID: 'ses_test', requestID: 'per_test', messageID: 'msg_test', callID: 'call_test' },
      { kind: 'native.permission.replied', sessionID: 'ses_test', requestID: 'per_test', reply: 'reject' },
    ]);
    assert.equal(permissionContents.includes('private'), false);
  } finally {
    for (const [i, name] of ['DEVRYAN_QA_RUNTIME_ROOT', 'DEVRYAN_QA_HOME'].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
    await rm(root, { recursive: true, force: true });
  }
});
