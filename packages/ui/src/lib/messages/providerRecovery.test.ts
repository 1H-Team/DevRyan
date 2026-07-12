import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { buildProviderRecoveryInput } from './providerRecovery';

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
