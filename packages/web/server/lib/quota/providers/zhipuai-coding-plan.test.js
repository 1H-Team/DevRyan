import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readAuthFile } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import { fetchQuota, isConfigured } from './zhipuai-coding-plan.js';

vi.mock('../../opencode/auth.js', () => ({
  OPENCODE_DATA_DIR: new URL('../../../../../../.cache/v2-validation/quota-fixtures/zhipuai/data', import.meta.url).pathname,
  readAuthFile: vi.fn(() => ({}))
}));

vi.mock('../../opencode/shared.js', () => ({
  OPENCODE_CONFIG_DIR: new URL('../../../../../../.cache/v2-validation/quota-fixtures/zhipuai/config', import.meta.url).pathname,
  readConfigLayers: vi.fn(() => ({ mergedConfig: {} }))
}));

describe('Zhipu AI Coding Plan quota provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: 12,
              nextResetTime: 1_700_000_000_000
            }
          ]
        }
      })
    }));
  });

  it('uses zhipu config-layer api keys when auth file aliases are missing', async () => {
    readAuthFile.mockReturnValue({});
    readConfigLayers.mockReturnValue({
      mergedConfig: {
        provider: {
          zhipu: {
            options: {
              apiKey: 'config-api-key'
            }
          }
        }
      }
    });

    expect(isConfigured()).toBe(true);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer config-api-key'
        })
      })
    );
  });
});
