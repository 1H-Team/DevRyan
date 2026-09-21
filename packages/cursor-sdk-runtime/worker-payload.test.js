import { expect, test } from 'bun:test';
import { assertWorkerPayloadBytes, serializeWorkerPayload, WORKER_PAYLOAD_LIMIT } from './worker-payload.js';

test('worker payload limits count UTF-8 bytes without truncating history', () => {
  expect(() => assertWorkerPayloadBytes(WORKER_PAYLOAD_LIMIT)).not.toThrow();
  expect(() => assertWorkerPayloadBytes(WORKER_PAYLOAD_LIMIT + 1)).toThrow('payload_too_large');
  const history = '🙂'.repeat(WORKER_PAYLOAD_LIMIT / 4);
  expect(() => serializeWorkerPayload({ history })).toThrow('payload_too_large');
  expect(history.endsWith('🙂')).toBe(true);
});
