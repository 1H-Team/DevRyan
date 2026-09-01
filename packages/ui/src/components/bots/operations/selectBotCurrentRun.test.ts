import { describe, expect, test } from 'bun:test';
import type { BotRun } from '@/lib/botsApi';
import { selectBotCurrentRunId } from './selectBotCurrentRun';

const run = (id: string, state: BotRun['state'], queueSequence: number): BotRun => ({
  id, state, queueSequence, botId: 'bot', channelId: 'channel', revisionId: 'revision', modelSnapshot: null,
  computerScopeKey: 'scope', retryable: false, interruptionKind: null, createdAt: null, updatedAt: null, startedAt: null, finishedAt: null,
});
describe('current Bot execution selection', () => {
  test('new queued requests do not hide the executing run or confirmation/control waits', () => {
    for (const state of ['starting', 'running', 'waiting_control', 'waiting_approval', 'needs_reconciliation'] as const) {
      expect(selectBotCurrentRunId({ runsById: { active: run('active', state, 1), later: run('later', 'queued', 2) },
        runIdsByChannelId: { channel: ['active', 'later'] } }, 'channel')).toBe('active');
    }
  });
  test('shows the next FIFO entry when there is no executing run', () => {
    expect(selectBotCurrentRunId({ runsById: { oldest: run('oldest', 'queued', 1), newest: run('newest', 'queued', 2) },
      runIdsByChannelId: { channel: ['newest', 'oldest'] } }, 'channel')).toBe('oldest');
  });
});
