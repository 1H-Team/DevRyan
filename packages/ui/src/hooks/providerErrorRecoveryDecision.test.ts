import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
  decideProviderErrorRecovery,
  decideProviderRetryLoopRecovery,
  decideInterruptedProviderRecovery,
  INTERRUPTED_PROVIDER_RESPONSE_REASON,
  isPrimaryProviderRecoverySession,
} from './providerErrorRecoveryDecision';

const user = { id: 'user-1', sessionID: 'ses_1', role: 'user', time: { created: 1 } } as Message;
const assistant = (detail: string, name = 'UnknownError') => ({
  id: 'assistant-1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2 },
  error: { name, data: { message: detail } },
}) as unknown as Message;

describe('decideProviderErrorRecovery', () => {
  test('offers manual recovery for transient and model-not-found provider errors', () => {
    expect(decideProviderErrorRecovery({
      messages: [user, assistant('Streaming response failed')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: 'Streaming response failed' });

    expect(decideProviderErrorRecovery({
      messages: [user, assistant('The operation timed out.')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: 'The operation timed out.' });

    expect(decideProviderErrorRecovery({
      messages: [user, assistant('Model not found: opencode-go/missing', 'ProviderModelNotFoundError')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: 'Model not found: opencode-go/missing' });
  });

  test('offers manual recovery for certificate verification failures', () => {
    expect(decideProviderErrorRecovery({
      messages: [user, assistant('unknown certificate verification error')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: 'unknown certificate verification error' });
  });

  test('offers manual recovery for Claude third-party usage classification errors', () => {
    const reason = 'Claude Code returned an error result: API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.';
    expect(decideProviderErrorRecovery({
      messages: [user, assistant(reason)],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason });
  });

  test('does not offer recovery for stale, blocked, or authentication failures', () => {
    const base = {
      messages: [user, assistant('Streaming response failed')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    };
    expect(decideProviderErrorRecovery({ ...base, observedActiveUserMessageId: 'other' })).toBeNull();
    expect(decideProviderErrorRecovery({ ...base, queuedMessageCount: 1 })).toBeNull();
    expect(decideProviderErrorRecovery({ ...base, blockingRequestCount: 1 })).toBeNull();
    expect(decideProviderErrorRecovery({ ...base, messages: [user, assistant('OAuth token refresh failed')] })).toBeNull();
  });
});

describe('decideInterruptedProviderRecovery', () => {
  const incompleteAssistant = {
    id: 'assistant-incomplete',
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created: 2 },
  } as unknown as Message;

  test('offers manual recovery for an incomplete response observed idle after reconnect', () => {
    expect(decideInterruptedProviderRecovery({
      messages: [user, incompleteAssistant],
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: INTERRUPTED_PROVIDER_RESPONSE_REASON });
  });

  test('does not recover a completed, errored, blocked, or unanchored response', () => {
    const complete = {
      ...incompleteAssistant,
      time: { created: 2, completed: 3 },
    } as unknown as Message;
    const errored = {
      ...incompleteAssistant,
      error: { name: 'UnknownError', data: { message: 'failed' } },
    } as unknown as Message;

    expect(decideInterruptedProviderRecovery({
      messages: [user, complete],
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toBeNull();
    expect(decideInterruptedProviderRecovery({
      messages: [user, errored],
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toBeNull();
    expect(decideInterruptedProviderRecovery({
      messages: [user, incompleteAssistant],
      queuedMessageCount: 1,
      blockingRequestCount: 0,
    })).toBeNull();
    expect(decideInterruptedProviderRecovery({
      messages: [incompleteAssistant],
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toBeNull();
  });
});

describe('decideProviderRetryLoopRecovery', () => {
  test('stops a definite provider usage limit on the first retry', () => {
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 1,
      message: "Claude Code returned an error result: You've hit your limit · resets 1:30am (Africa/Casablanca) Subprocess stderr: ignored",
      next: 10,
    })).toEqual({
      reason: "Claude Code returned an error result: You've hit your limit · resets 1:30am (Africa/Casablanca) Subprocess stderr: ignored",
    });
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 1,
      message: 'Rate limited',
      next: 10,
    })).toEqual({ reason: 'Rate limited' });
  });

  test('stops a Claude third-party usage classifier retry on the first attempt', () => {
    const reason = 'API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Subprocess stderr: Warning: ignored';
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 1,
      message: reason,
      next: 10,
    })).toEqual({ reason });
  });

  test('stops a transient provider retry loop at the bounded attempt limit', () => {
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 2,
      message: 'Stream idle timeout',
      next: 10,
    })).toBeNull();
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: 'Stream idle timeout',
      next: 10,
    })).toEqual({ reason: 'Stream idle timeout' });

    const overloaded = 'Our servers are currently overloaded. Please try again later.';
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 2,
      message: overloaded,
      next: 10,
    })).toBeNull();
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: overloaded,
      next: 10,
    })).toEqual({ reason: overloaded });
  });

  test('does not stop authentication or unrelated retries', () => {
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: 'OAuth token refresh failed',
      next: 10,
    })).toBeNull();
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: 'Provider warming up',
      next: 10,
    })).toBeNull();
  });
});

describe('isPrimaryProviderRecoverySession', () => {
  test('accepts only an authoritative root session', () => {
    expect(isPrimaryProviderRecoverySession({ parentID: null })).toBe(true);
    expect(isPrimaryProviderRecoverySession({})).toBe(true);
    expect(isPrimaryProviderRecoverySession({ parentID: 'ses_parent' })).toBe(false);
    expect(isPrimaryProviderRecoverySession(undefined)).toBe(false);
  });
});
