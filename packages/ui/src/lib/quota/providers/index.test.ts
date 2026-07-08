import { describe, expect, test } from 'bun:test';

import { QUOTA_PROVIDERS, getSortedQuotaProviders } from './index';

describe('quota provider metadata', () => {
  test('returns providers sorted alphabetically by display name without mutating registry order or duplicating ids', () => {
    const sorted = getSortedQuotaProviders();

    expect(sorted.map((provider) => provider.name)).toEqual([
      'Anthropic',
      'Antigravity',
      'Codex',
      'Cursor',
      'GitHub Copilot',
      'Google',
      'Kimi for Coding',
      'MiniMax Coding Plan (minimax.io)',
      'MiniMax Coding Plan (minimaxi.com)',
      'NanoGPT',
      'Ollama Cloud',
      'OpenCode Go',
      'OpenRouter',
      'z.ai',
      'Zhipu AI Coding Plan',
    ]);
    expect(new Set(QUOTA_PROVIDERS.map((provider) => provider.id)).size).toBe(QUOTA_PROVIDERS.length);
    expect(QUOTA_PROVIDERS[0]).toEqual({ id: 'claude', name: 'Anthropic' });
  });
});
