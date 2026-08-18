import { describe, expect, test } from 'bun:test';
import type { UsageWindow } from '@/types';
import {
  buildUsageProviderTabs,
  getVisibleUsageEntries,
  resolveActiveUsageProviderId,
  sortResetCredits,
} from './usage-groups';
import type { RateLimitGroup } from './types';

const windowStub: UsageWindow = {
  usedPercent: 25,
  remainingPercent: 75,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
};

const group = (providerId: string, entries: RateLimitGroup['entries'] = [['5h', windowStub]]): RateLimitGroup => ({
  providerId,
  providerName: providerId,
  entries,
});

describe('usage dropdown group helpers', () => {
  test('sorts provider tabs by display name without mutating the source groups', () => {
    const groups: RateLimitGroup[] = [
      { ...group('provider-10'), providerName: 'Provider 10' },
      { ...group('same-b'), providerName: 'same' },
      { ...group('alpha'), providerName: 'alpha' },
      { ...group('same-a'), providerName: 'Same' },
      { ...group('provider-2'), providerName: 'Provider 2' },
    ];
    const sourceOrder = groups.map((entry) => entry.providerId);

    const tabs = buildUsageProviderTabs(groups);

    expect(tabs.map((entry) => entry.id)).toEqual([
      'alpha',
      'provider-2',
      'provider-10',
      'same-a',
      'same-b',
    ]);
    expect(groups.map((entry) => entry.providerId)).toEqual(sourceOrder);
  });

  test('keeps active provider when it is still present', () => {
    expect(resolveActiveUsageProviderId([group('claude'), group('codex')], 'codex')).toBe('codex');
  });

  test('falls back to the first provider when active provider disappears', () => {
    expect(resolveActiveUsageProviderId([group('claude'), group('codex')], 'google')).toBe('claude');
  });

  test('returns null when no provider groups are available', () => {
    expect(resolveActiveUsageProviderId([], 'codex')).toBeNull();
  });

  test('hides legacy Codex credits row only when reset credits exist', () => {
    const codex = group('codex', [['5h', windowStub], ['credits', windowStub]]);
    expect(getVisibleUsageEntries(codex).map(([label]) => label)).toEqual(['5h', 'credits']);

    const withResetCredits: RateLimitGroup = {
      ...codex,
      resetCredits: {
        availableCount: 1,
        totalEarnedCount: null,
        source: 'usage',
        credits: [],
      },
    };
    expect(getVisibleUsageEntries(withResetCredits).map(([label]) => label)).toEqual(['5h']);
  });

  test('orders Claude short-term usage before general and model-specific weekly limits', () => {
    const anthropic = group('claude', [
      ['7d', windowStub],
      ['unknown', windowStub],
      ['5h', windowStub],
      ['7d-fable', windowStub],
      ['future-window', windowStub],
    ]);
    const sourceOrder = anthropic.entries.map(([label]) => label);

    expect(getVisibleUsageEntries(anthropic).map(([label]) => label)).toEqual([
      '5h',
      '7d',
      '7d-fable',
      'unknown',
      'future-window',
    ]);
    expect(anthropic.entries.map(([label]) => label)).toEqual(sourceOrder);
  });

  test('preserves incoming usage-window order for other providers', () => {
    const chatgpt = group('codex', [
      ['weekly', windowStub],
      ['5h', windowStub],
    ]);

    expect(getVisibleUsageEntries(chatgpt).map(([label]) => label)).toEqual(['weekly', '5h']);
  });

  test('sorts reset credits by status and soonest expiry', () => {
    const sorted = sortResetCredits([
      {
        id: 'later',
        status: 'available',
        resetType: 'codex_rate_limits',
        grantedAt: null,
        grantedAtFormatted: null,
        expiresAt: Date.parse('2026-08-01T00:00:00.000Z'),
        expiresAtFormatted: null,
      },
      {
        id: 'redeemed',
        status: 'redeemed',
        resetType: 'codex_rate_limits',
        grantedAt: null,
        grantedAtFormatted: null,
        expiresAt: Date.parse('2026-07-01T00:00:00.000Z'),
        expiresAtFormatted: null,
      },
      {
        id: 'soon',
        status: 'available',
        resetType: 'codex_rate_limits',
        grantedAt: null,
        grantedAtFormatted: null,
        expiresAt: Date.parse('2026-07-01T00:00:00.000Z'),
        expiresAtFormatted: null,
      },
      {
        id: 'no-expiry',
        status: 'available',
        resetType: 'codex_rate_limits',
        grantedAt: null,
        grantedAtFormatted: null,
        expiresAt: null,
        expiresAtFormatted: null,
      },
    ]);

    expect(sorted.map((credit) => credit.id)).toEqual(['soon', 'later', 'no-expiry', 'redeemed']);
  });
});
