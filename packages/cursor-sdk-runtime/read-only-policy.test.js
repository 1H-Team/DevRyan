import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { cursorReadOnlyOptions } from './worker-payload.js';

test('persistent agent cache isolates policy and applies it to create and resume', async () => {
  const source = await readFile(new URL('./persistent-worker.mjs', import.meta.url), 'utf8');
  const cache = new Map(), calls = [];
  const create = runInNewContext(`${source.slice(source.indexOf('const getAgentCacheKey ='), source.indexOf('const handlePrepare ='))}; getOrCreateAgent`, {
    trimString: value => typeof value === 'string' ? value.trim() : '', stableJson: JSON.stringify,
    credentialCacheIdentity: value => value, normalizeModelSelection: value => value,
    normalizeCursorSdkAgentDefinitions: value => value, pinCursorSdkSubagentModels: value => value,
    isPlainObject: value => Boolean(value && typeof value === 'object'), CURSOR_SETTING_SOURCES: undefined,
    cursorReadOnlyOptions, isMissingCursorAgentError: () => false,
    agentCache: { get: key => cache.get(key), set: (key, agent) => { cache.set(key, agent); return agent; }, markActive() {} },
    Agent: { create: async options => { calls.push(options); return { agentId: `agent_${calls.length}` }; },
      resume: async (id, options) => { calls.push(options); return { agentId: id }; } },
  });
  const input = { apiKey: 'synthetic', sessionID: 'ses_policy', directory: '/fixture', model: { id: 'model' } };
  expect((await create(input)).cacheHit).toBe(false);
  expect((await create({ ...input, readOnly: true })).cacheHit).toBe(false);
  expect((await create({ ...input, readOnly: true })).cacheHit).toBe(true);
  await create({ ...input, sessionID: 'ses_resume', agentID: 'agent_saved', readOnly: true });
  expect(calls).toHaveLength(3);
  expect(calls[0].tools).toBeUndefined();
  for (const options of calls.slice(1)) {
    expect(options.tools).toEqual(['read', 'grep', 'glob', 'ls']);
    expect(options.disallowedTools).toEqual(['task', 'mcp']);
  }
});
