import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateBotMemoryRecoverySnapshot,
  parseBotMemorySmokeArguments,
} from './smoke-bot-memory-recovery.mjs';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const RUN_ONE = 'f0000000-0000-4000-8000-000000000001';
const RUN_TWO = 'f0000000-0000-4000-8000-000000000002';

describe('packaged/web Bot memory recovery smoke', () => {
  it('requires two completed recovery runs and an explicit target runtime', () => {
    assert.deepEqual(parseBotMemorySmokeArguments([
      '--base-url', 'http://127.0.0.1:3101/path',
      '--bot-id', BOT_ID,
      '--run-id', RUN_ONE,
      '--run-id', RUN_TWO,
    ]), {
      baseUrl: 'http://127.0.0.1:3101',
      botId: BOT_ID,
      runIds: [RUN_ONE, RUN_TWO],
      timeoutMs: 120_000,
    });
    assert.throws(() => parseBotMemorySmokeArguments([
      '--base-url', 'http://127.0.0.1:3101', '--bot-id', BOT_ID, '--run-id', RUN_ONE,
    ]), /at least two/);
  });

  it('accepts only resolved audits and exactly one persisted source per run/key', () => {
    const auditLogs = [RUN_ONE, RUN_TWO].flatMap((runId, index) => [
      {
        eventId: `c0000000-0000-4000-8000-00000000000${index + 1}`,
        action: 'bot.memory.extract', result: 'failure', target: { id: runId },
        resolvedAt: '2026-09-01T12:00:00.000Z',
        resolvedByEventId: `d0000000-0000-4000-8000-00000000000${index + 1}`,
      },
      { action: 'bot.memory.extract', result: 'success', target: { id: runId } },
    ]);
    const memoryDetails = [{
      memory: { logicalKey: 'deployment.region' },
      sources: [{ runId: RUN_ONE }, { runId: RUN_TWO }],
    }];
    assert.deepEqual(evaluateBotMemoryRecoverySnapshot({
      auditLogs, memoryDetails, runIds: [RUN_ONE, RUN_TWO],
    }).complete, true);
    assert.deepEqual(evaluateBotMemoryRecoverySnapshot({
      auditLogs, memoryDetails, runIds: [RUN_ONE, RUN_TWO],
    }).duplicateSourceCount, 0);

    memoryDetails[0].sources.push({ runId: RUN_ONE });
    assert.deepEqual(evaluateBotMemoryRecoverySnapshot({
      auditLogs, memoryDetails, runIds: [RUN_ONE, RUN_TWO],
    }).complete, false);
    assert.deepEqual(evaluateBotMemoryRecoverySnapshot({
      auditLogs, memoryDetails, runIds: [RUN_ONE, RUN_TWO],
    }).duplicateSourceCount, 1);
  });
});
