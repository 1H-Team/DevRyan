import { describe, expect, it, vi } from 'vitest';
import { hasBotRetrySideEffects, isBotRunRetryable } from './retry-policy.js';

const run = { id: 'run', channel_id: 'channel', state: 'failed',
  context_snapshot: { failurePhase: 'startup', retryable: true } };
const pending = { channel_id: 'channel', assistant_phase: 'pending',
  finalized_at: null, attachment_count: 0, actor_user_id: null };

describe('same-run retry safety', () => {
  it('requires explicit startup eligibility, including for historical runs', () => {
    expect(isBotRunRetryable(run)).toBe(true);
    for (const context_snapshot of [{ retryable: true },
      { failurePhase: 'execution', retryable: true },
      { failurePhase: 'startup', retryable: false }]) {
      expect(isBotRunRetryable({ ...run, context_snapshot })).toBe(false);
    }
    expect(isBotRunRetryable({ ...run, state: 'queued' })).toBe(false);
  });

  it.each([
    { agent_thread_id: 'thread' }, { agent_execution: { threadId: 'thread' } },
    { agent_execution: { invocationId: 'invocation' } },
    { agent_execution: { segmentId: 'segment' } }, { opencode_session_id: 'session' },
    { opencode_segment_id: 'segment' },
  ])('rejects a persisted execution identity %j', (identity) => {
    expect(isBotRunRetryable({ ...run, ...identity })).toBe(false);
  });

  it('exempts only an unfinalized pending placeholder from output evidence', async () => {
    const messages = vi.fn(async () => ({ items: [pending] }));
    const actions = vi.fn(async () => ({ items: [] }));
    const store = { repositories: {
      bot_messages: { list: messages }, bot_action_attempts: { list: actions },
    } };
    expect(await hasBotRetrySideEffects(store, run)).toBe(false);
    for (const change of [{ assistant_phase: 'acknowledgment' },
      { assistant_phase: 'result' }, { finalized_at: '2026-08-30' },
      { attachment_count: 1 }, { actor_user_id: 'actor' }]) {
      messages.mockResolvedValueOnce({ items: [{ ...pending, ...change }] });
      expect(await hasBotRetrySideEffects(store, run)).toBe(true);
    }
    actions.mockResolvedValueOnce({ items: [{ state: 'cancelled' }] });
    expect(await hasBotRetrySideEffects(store, run)).toBe(true);
    actions.mockRejectedValueOnce(new Error('unavailable'));
    await expect(hasBotRetrySideEffects(store, run)).rejects.toThrow('unavailable');
  });
});
