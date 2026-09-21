import { expect, test } from 'bun:test';
import { cleanupExecutionLease } from './execution-cleanup.js';

test('cleanup failure reports retry work without replacing a durable publication outcome', async () => {
  const result = { operationID: 'published', files: [{ path: 'accepted' }] }, reports = [];
  const runtime = { cleanupLease: async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); } };
  const publish = async () => { await cleanupExecutionLease(runtime, {}, (record) => reports.push(record)); return result; };
  expect(await publish()).toBe(result);
  expect(reports).toEqual([{ event: 'session_execution', phase: 'cleanup_pending', code: 'EACCES' }]);
});
