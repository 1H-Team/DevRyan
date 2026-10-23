import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
  decideProviderErrorRecovery,
  decideProviderRetryLoopRecovery,
  MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS,
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
  test('an empty data.message falls through to the error message', () => {
    const withEmptyData = {
      ...assistant(''),
      error: { name: 'UnknownError', message: 'Streaming response failed', data: { message: '' } },
    } as unknown as Message;
    expect(decideProviderErrorRecovery({
      messages: [user, withEmptyData],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    })).toEqual({ reason: 'Streaming response failed' });
  });

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

  test('stops a transient provider retry loop only past both the attempt and time bounds', () => {
    const window = MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS;
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 2,
      message: 'Stream idle timeout',
      next: 10,
    }, window)).toBeNull();
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: 'Stream idle timeout',
      next: 10,
    }, window)).toEqual({ reason: 'Stream idle timeout' });

    const overloaded = 'Our servers are currently overloaded. Please try again later.';
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 2,
      message: overloaded,
      next: 10,
    }, window)).toBeNull();
    expect(decideProviderRetryLoopRecovery({
      type: 'retry',
      attempt: 3,
      message: overloaded,
      next: 10,
    }, window)).toEqual({ reason: overloaded });
  });

  // Live QA 2026-10-23: a plan turn was aborted at attempt 3, 95 s into
  // OpenCode's own bounded retry loop, discarding 11 minutes of work.
  test('lets the runtime keep retrying transient failures inside the time window', () => {
    for (const message of [
      'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
      'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    ]) {
      expect(decideProviderRetryLoopRecovery({ type: 'retry', attempt: 3, message, next: 10 }, 95_000)).toBeNull();
      expect(decideProviderRetryLoopRecovery({ type: 'retry', attempt: 8, message, next: 10 }, MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS - 1)).toBeNull();
      expect(decideProviderRetryLoopRecovery({ type: 'retry', attempt: 8, message, next: 10 }, MAX_TRANSIENT_PROVIDER_RETRY_WINDOW_MS)).toEqual({ reason: message });
    }
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
