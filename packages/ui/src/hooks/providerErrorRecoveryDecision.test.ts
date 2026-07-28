import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
  decideProviderErrorRecovery,
  decideProviderRetryLoopRecovery,
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

  test('does not offer recovery for stale, blocked, or authentication failures', () => {
    const base = {
      messages: [user, assistant('Streaming response failed')],
      observedActiveUserMessageId: 'user-1',
      queuedMessageCount: 0,
      blockingRequestCount: 0,
    };
    expect(decideProviderErrorRecovery({ ...base, observedActiveUserMessageId: 'other' })).toBeNull();
    expect(decideProviderErrorRecovery({ ...base, queuedMessageCount: 1 })).toBeNull();
    expect(decideProviderErrorRecovery({ ...base, messages: [user, assistant('OAuth token refresh failed')] })).toBeNull();
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
