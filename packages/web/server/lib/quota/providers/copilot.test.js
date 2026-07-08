import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readAuthFile } from '../../opencode/auth.js';
import { fetchQuotaForProvider } from './index.js';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
}));

describe('GitHub Copilot quota provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows token-based billing quota as AI Credits', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { access: 'copilot-token' } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        quota_reset_date_utc: '2026-07-01T00:00:00.000Z',
        token_based_billing: true,
        quota_snapshots: {
          premium_interactions: {
            entitlement: 7000,
            remaining: 5250,
          },
        },
      }),
    }));

    const result = await fetchQuotaForProvider('github-copilot', { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.premium).toBeUndefined();
    expect(result.usage.windows['ai-credits']).toMatchObject({
      usedPercent: 25,
      resetAt: Date.parse('2026-07-01T00:00:00.000Z'),
      valueLabel: '5250 / 7000 credits left',
      description: 'AI Credits are consumed from token usage, including input, output, and cached tokens.',
    });
  });

  it('keeps legacy premium request labeling for request-based quota payloads', async () => {
    readAuthFile.mockReturnValue({ 'github-copilot': { access: 'copilot-token' } });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        quota_reset_date: '2026-07-01',
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 225,
          },
        },
      }),
    }));

    const result = await fetchQuotaForProvider('github-copilot', { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['ai-credits']).toBeUndefined();
    expect(result.usage.windows.premium).toMatchObject({
      usedPercent: 25,
      valueLabel: '225 / 300 requests left',
    });
  });
});
