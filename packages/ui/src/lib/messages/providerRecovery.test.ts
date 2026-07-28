import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
  buildProviderRecoveryInput,
  getProviderUsageLimitDisplayReason,
} from './providerRecovery';

describe('buildProviderRecoveryInput', () => {
  test('captures the authoritative latest user send snapshot', () => {
    const messages = [
      {
        id: 'msg_user',
        sessionID: 'ses_1',
        role: 'user',
        time: { created: 10 },
        agent: 'builder',
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', variant: 'high' },
      },
      {
        id: 'msg_assistant',
        sessionID: 'ses_1',
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
        time: { created: 11 },
      },
    ] as unknown as Message[];

    expect(buildProviderRecoveryInput({
      sessionId: 'ses_1',
      directory: '/workspace',
      reason: 'out of usage',
      messages,
      now: 20,
    })).toEqual({
      sessionId: 'ses_1',
      directory: '/workspace',
      anchorUserMessageId: 'msg_user',
      reason: 'out of usage',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash',
      variant: 'high',
      agent: 'builder',
      createdAt: 20,
    });
  });

  test('returns null without a usable user model snapshot', () => {
    expect(buildProviderRecoveryInput({
      sessionId: 'ses_1',
      directory: '/workspace',
      reason: 'rate limited',
      messages: [],
      now: 20,
    })).toBeNull();
  });
});

describe('getProviderUsageLimitDisplayReason', () => {
  test('keeps the reset detail and removes runtime noise from an Anthropic limit', () => {
    expect(getProviderUsageLimitDisplayReason(
      "Claude Code returned an error result: You've hit your limit · resets 1:30am (Africa/Casablanca) "
      + 'Subprocess stderr: Permission deny rule "MultiEdit" matches no known tool. Warning: ignored',
    )).toBe("You've hit your limit · resets 1:30am (Africa/Casablanca)");
  });

  test('returns null for unrelated provider failures', () => {
    expect(getProviderUsageLimitDisplayReason('Streaming response failed')).toBeNull();
  });
});
