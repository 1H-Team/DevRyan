import { expect, test } from 'bun:test';
import { assertWorkerPayloadBytes, serializeWorkerPayload, WORKER_PAYLOAD_LIMIT, cursorCatalogModels } from './worker-payload.js';

test('worker payload limits count UTF-8 bytes without truncating history', () => {
  expect(() => assertWorkerPayloadBytes(WORKER_PAYLOAD_LIMIT)).not.toThrow();
  expect(() => assertWorkerPayloadBytes(WORKER_PAYLOAD_LIMIT + 1)).toThrow('payload_too_large');
  const history = '🙂'.repeat(WORKER_PAYLOAD_LIMIT / 4);
  expect(() => serializeWorkerPayload({ history })).toThrow('payload_too_large');
  expect(history.endsWith('🙂')).toBe(true);
});

test('read-only worker policy rejects malformed authority and restricts tool surfaces', async () => {
  const { cursorReadOnlyOptions } = await import('./worker-payload.js');
  expect(cursorReadOnlyOptions(true)).toEqual({ tools: ['read', 'grep', 'glob', 'ls'], disallowedTools: ['task', 'mcp'] });
  expect(cursorReadOnlyOptions(false)).toEqual({});
  expect(cursorReadOnlyOptions(undefined)).toEqual({});
  for (const value of ['true', 1, null, {}]) expect(() => cursorReadOnlyOptions(value)).toThrow('cursor_worker_readonly_invalid');
});

test('catalog worker output projects bounded model metadata without arbitrary SDK fields', () => {
  expect(cursorCatalogModels([{ id: 'chosen', displayName: 'Chosen', apiKey: 'must-not-cross', variants: [
    { isDefault: true, secret: 'must-not-cross', params: [{ id: 'effort', value: 'medium', ignored: true }] },
  ] }, null])).toEqual([{ id: 'chosen', displayName: 'Chosen', name: '', description: '', variants: [
    { isDefault: true, params: [{ id: 'effort', value: 'medium' }] },
  ] }]);
  expect(() => cursorCatalogModels({})).toThrow('cursor_model_catalog_invalid');
  expect(() => cursorCatalogModels([{ id: 'large', description: 'x'.repeat(WORKER_PAYLOAD_LIMIT) }])).toThrow('payload_too_large');
});
