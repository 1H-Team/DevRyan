import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchQuotaMock, fetchOpenCodeGoQuotaMock, fetchCursorQuotaMock, fetchXaiQuotaMock, fetchDeepSeekQuotaMock } = vi.hoisted(() => ({
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
  })),
  fetchCursorQuotaMock: vi.fn(async () => ({
    providerId: 'cursor-acp',
    providerName: 'Cursor',
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: 1,
  })),
  fetchXaiQuotaMock: vi.fn(async () => ({
    providerId: 'xai',
    providerName: 'xAI',
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: 1,
  })),
  fetchDeepSeekQuotaMock: vi.fn(async () => ({
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    ok: true,
    configured: true,
    usage: { windows: {} },
    fetchedAt: 1,
  })),
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

vi.mock('./cursor-acp.js', () => ({
  providerId: 'cursor-acp',
  providerName: 'Cursor',
  isConfigured: () => true,
  fetchQuota: fetchCursorQuotaMock,
}));

vi.mock('./xai.js', () => ({
  providerId: 'xai',
  providerName: 'xAI',
  isConfigured: () => true,
  fetchQuota: fetchXaiQuotaMock,
}));

vi.mock('./deepseek.js', () => ({
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  isConfigured: () => true,
  fetchQuota: fetchDeepSeekQuotaMock,
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

  it('routes the Cursor API alias to the canonical provider without adding another registry row', async () => {
    const result = await fetchQuotaForProvider('cursor');

    expect(result.providerId).toBe('cursor-acp');
    expect(fetchCursorQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('routes Grok aliases to the canonical xAI provider', async () => {
    const result = await fetchQuotaForProvider('grok');

    expect(result.providerId).toBe('xai');
    expect(fetchXaiQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('routes DeepSeek requests to its balance provider', async () => {
    const result = await fetchQuotaForProvider('deepseek');

    expect(result.providerId).toBe('deepseek');
    expect(fetchDeepSeekQuotaMock).toHaveBeenCalledTimes(1);
  });
});
