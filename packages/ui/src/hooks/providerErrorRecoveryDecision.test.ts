import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { decideProviderErrorRecovery } from './providerErrorRecoveryDecision';

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
