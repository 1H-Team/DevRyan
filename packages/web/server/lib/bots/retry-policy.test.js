import { describe, expect, it, vi } from 'vitest';
import {
  hasBotExecutionIdentity,
  hasBotRetrySideEffects,
  isBotRunRetryable,
  isReadOnlySettledAttempt,
  operationKindFromRow,
} from './retry-policy.js';

const run = { id: 'run', channel_id: 'channel', state: 'failed',
  context_snapshot: { failurePhase: 'startup', retryable: true } };
const pending = { channel_id: 'channel', assistant_phase: 'pending',
  finalized_at: null, attachment_count: 0, actor_user_id: null };

describe('same-run retry safety', () => {
  it('requires the dispatcher retry verdict for a startup or execution failure', () => {
    expect(isBotRunRetryable(run)).toBe(true);
    expect(isBotRunRetryable({
      ...run, context_snapshot: { failurePhase: 'execution', retryable: true },
    })).toBe(true);
    for (const context_snapshot of [{ retryable: true },
      { failurePhase: 'startup', retryable: false },
      { failurePhase: 'execution', retryable: false },
      { failurePhase: 'completion', retryable: true }]) {
      expect(isBotRunRetryable({ ...run, context_snapshot })).toBe(false);
    }
    expect(isBotRunRetryable({ ...run, state: 'queued' })).toBe(false);
  });

  it.each([
    { agent_thread_id: 'thread' }, { agent_execution: { threadId: 'thread' } },
    { agent_execution: { invocationId: 'invocation' } },
    { agent_execution: { segmentId: 'segment' } }, { opencode_session_id: 'session' },
    { opencode_segment_id: 'segment' },
  ])('detects a persisted execution identity %j without treating it as a side effect', (identity) => {
    expect(hasBotExecutionIdentity({ ...run, ...identity })).toBe(true);
    expect(isBotRunRetryable({ ...run, ...identity })).toBe(true);
  });

  it('exempts only an unfinalized pending placeholder from output evidence', async () => {
    const messages = vi.fn(async () => ({ items: [pending] }));
    const actions = vi.fn(async () => ({ items: [], nextCursor: null }));
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
    actions.mockResolvedValueOnce({ items: [{ state: 'cancelled' }], nextCursor: null });
    expect(await hasBotRetrySideEffects(store, run)).toBe(true);
    actions.mockRejectedValueOnce(new Error('unavailable'));
    await expect(hasBotRetrySideEffects(store, run)).rejects.toThrow('unavailable');
  });

  it('ignores settled safe reads but treats writes and uncertain outcomes as side effects', async () => {
    const safeRead = {
      tool: 'browser', action: 'snapshot', target: { operationKind: 'read' },
      state: 'succeeded', unknown_outcome: false,
      execution_receipt: { operationKind: 'read', writeGuarantee: 'safe_to_retry' },
    };
    expect(operationKindFromRow(safeRead)).toBe('read');
    expect(isReadOnlySettledAttempt(safeRead)).toBe(true);
    expect(isReadOnlySettledAttempt({
      ...safeRead, state: 'failed', execution_receipt: { operationKind: 'read', writeGuarantee: null },
    })).toBe(true);
    expect(isReadOnlySettledAttempt({ ...safeRead, state: 'denied', execution_receipt: null })).toBe(true);
    expect(isReadOnlySettledAttempt({ ...safeRead, unknown_outcome: true })).toBe(false);
    expect(isReadOnlySettledAttempt({
      ...safeRead, target: { operationKind: 'write' }, action: 'click',
    })).toBe(false);

    const messages = vi.fn(async () => ({ items: [] }));
    const actions = vi.fn(async () => ({ items: [safeRead], nextCursor: null }));
    const store = { repositories: {
      bot_messages: { list: messages }, bot_action_attempts: { list: actions },
    } };
    expect(await hasBotRetrySideEffects(store, run)).toBe(false);
    actions.mockResolvedValueOnce({
      items: [{ ...safeRead, target: { operationKind: 'write' }, action: 'click' }],
      nextCursor: null,
    });
    expect(await hasBotRetrySideEffects(store, run)).toBe(true);
    actions.mockResolvedValueOnce({ items: [safeRead], nextCursor: 'more' });
    expect(await hasBotRetrySideEffects(store, run)).toBe(true);
  });
});
