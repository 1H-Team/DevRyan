import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchQuotaMock, fetchOpenCodeGoQuotaMock } = vi.hoisted(() => ({
  fetchQuotaMock: vi.fn(async () => ({
    providerId: 'zhipuai-coding-plan',
    providerName: 'Zhipu AI Coding Plan',
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: 1
  })),
  fetchOpenCodeGoQuotaMock: vi.fn(async () => ({
    providerId: 'opencode-go',
    providerName: 'OpenCode Go',
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: 1
  }))
}));

vi.mock('./zhipuai-coding-plan.js', () => ({
  providerId: 'zhipuai-coding-plan',
  providerName: 'Zhipu AI Coding Plan',
  isConfigured: () => true,
  fetchQuota: fetchQuotaMock
}));

vi.mock('./opencode-go.js', () => ({
  providerId: 'opencode-go',
  providerName: 'OpenCode Go',
  isConfigured: () => true,
  fetchQuota: fetchOpenCodeGoQuotaMock
}));

import { fetchQuotaForProvider } from './index.js';

describe('quota provider registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes zhipu aliases to the coding plan provider', async () => {
    const result = await fetchQuotaForProvider('zhipu');

    expect(result.providerId).toBe('zhipuai-coding-plan');
    expect(fetchQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('routes OpenCode Go usage requests to the OpenCode Go provider', async () => {
    const result = await fetchQuotaForProvider('opencode-go');

    expect(result.providerId).toBe('opencode-go');
    expect(fetchOpenCodeGoQuotaMock).toHaveBeenCalledTimes(1);
  });
});
