import { beforeEach, describe, expect, test } from 'bun:test';

import { useProviderRecoveryStore } from './useProviderRecoveryStore';

const recovery = {
  sessionId: 'ses_1',
  directory: '/workspace',
  anchorUserMessageId: 'msg_user',
  reason: 'out of usage',
  providerId: 'opencode-go',
  modelId: 'deepseek-v4-flash',
  variant: null,
  agent: 'builder',
  createdAt: 1_000,
} as const;

beforeEach(() => useProviderRecoveryStore.getState().reset());

describe('provider recovery store', () => {
  test('retains one recovery per session with a local model selection', () => {
    useProviderRecoveryStore.getState().offerRecovery(recovery);
    useProviderRecoveryStore.getState().setSelection('ses_1', {
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'high',
    });

    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1).toEqual({
      ...recovery,
      selection: { providerId: 'openai', modelId: 'gpt-5.4', variant: 'high' },
      pending: false,
      actionError: null,
    });
  });

  test('does not replace the selected model for a duplicate retry event', () => {
    const store = useProviderRecoveryStore.getState();
    store.offerRecovery(recovery);
    store.setSelection('ses_1', { providerId: 'openai', modelId: 'gpt-5.4', variant: null });
    store.offerRecovery({ ...recovery, reason: 'rate limited again', createdAt: 2_000 });

    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1?.reason).toBe('rate limited again');
    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1?.selection).toEqual({
      providerId: 'openai', modelId: 'gpt-5.4', variant: null,
    });
  });

  test('keeps a failed manual action visible and clears exact session recovery', () => {
    const store = useProviderRecoveryStore.getState();
    store.offerRecovery(recovery);
    store.setActionState('ses_1', true, null);
    store.setActionState('ses_1', false, 'provider loop did not stop');

    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1?.pending).toBe(false);
    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1?.actionError).toBe('provider loop did not stop');

    store.clearRecovery('ses_1');
    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1).toBe(undefined);
  });

  test('does not clear a newer failed retry with an older successful send', () => {
    const store = useProviderRecoveryStore.getState();
    store.offerRecovery(recovery);
    store.offerRecovery({
      ...recovery,
      anchorUserMessageId: 'msg_retry',
      reason: "You've hit your limit",
      createdAt: 2_000,
    });

    store.clearRecovery('ses_1', recovery);
    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1?.anchorUserMessageId)
      .toBe('msg_retry');

    store.clearRecovery('ses_1', {
      anchorUserMessageId: 'msg_retry',
      createdAt: 2_000,
    });
    expect(useProviderRecoveryStore.getState().recoveriesBySessionId.ses_1).toBe(undefined);
  });
});
