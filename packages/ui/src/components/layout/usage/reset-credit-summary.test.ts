import { describe, expect, test } from 'bun:test';
import type { UsageResetCredit, UsageResetCredits } from '@/types';
import {
  buildResetCreditsSummary,
  getResetCreditsAvailableCount,
} from './reset-credit-summary';

const credit = (overrides: Partial<UsageResetCredit>): UsageResetCredit => ({
  id: overrides.id ?? 'credit',
  status: overrides.status ?? 'available',
  resetType: overrides.resetType ?? 'codex_rate_limits',
  grantedAt: overrides.grantedAt ?? null,
  grantedAtFormatted: overrides.grantedAtFormatted ?? null,
  expiresAt: overrides.expiresAt ?? null,
  expiresAtFormatted: overrides.expiresAtFormatted ?? null,
});

const resetCredits = (overrides: Partial<UsageResetCredits>): UsageResetCredits => ({
  availableCount: overrides.availableCount ?? null,
  totalEarnedCount: overrides.totalEarnedCount ?? null,
  source: overrides.source ?? 'dedicated',
  credits: overrides.credits ?? [],
});

describe('reset credit summary helpers', () => {
  test('falls back to counting available credits when available count is absent', () => {
    const count = getResetCreditsAvailableCount(resetCredits({
      credits: [
        credit({ id: 'available-a', status: 'available' }),
        credit({ id: 'available-b', status: 'AVAILABLE' }),
        credit({ id: 'redeemed', status: 'redeemed' }),
      ],
    }));

    expect(count).toBe(2);
  });

  test('uses the provided available count when present', () => {
    const count = getResetCreditsAvailableCount(resetCredits({
      availableCount: 4,
      credits: [
        credit({ id: 'available-a', status: 'available' }),
      ],
    }));

    expect(count).toBe(4);
  });

  test('summarizes only available reset expiries by soonest expiry', () => {
    const summary = buildResetCreditsSummary(resetCredits({
      credits: [
        credit({
          id: 'redeemed',
          status: 'redeemed',
          expiresAt: Date.parse('2026-07-01T00:00:00.000Z'),
          expiresAtFormatted: 'Jul 1, 2026',
        }),
        credit({
          id: 'later',
          status: 'available',
          expiresAt: Date.parse('2026-08-07T00:00:00.000Z'),
          expiresAtFormatted: 'Aug 7, 2026',
        }),
        credit({
          id: 'soon',
          status: 'available',
          expiresAt: Date.parse('2026-07-31T00:00:00.000Z'),
          expiresAtFormatted: 'Jul 31, 2026',
        }),
      ],
    }), Date.parse('2026-07-01T00:00:00.000Z'));

    expect(summary).toEqual([
      { label: 'Jul 31, 2026', count: 1, expiresSoon: false },
      { label: 'Aug 7, 2026', count: 1, expiresSoon: false },
    ]);
  });

  test('groups multiple available resets with the same expiry label', () => {
    const summary = buildResetCreditsSummary(resetCredits({
      credits: [
        credit({
          id: 'first',
          status: 'available',
          expiresAt: Date.parse('2026-07-31T00:00:00.000Z'),
          expiresAtFormatted: 'Jul 31, 2026',
        }),
        credit({
          id: 'second',
          status: 'available',
          expiresAt: Date.parse('2026-07-31T12:00:00.000Z'),
          expiresAtFormatted: 'Jul 31, 2026',
        }),
      ],
    }), Date.parse('2026-07-01T00:00:00.000Z'));

    expect(summary).toEqual([
      { label: 'Jul 31, 2026', count: 2, expiresSoon: false },
    ]);
  });

  test('marks available resets expiring within 24 hours as expiring soon', () => {
    const summary = buildResetCreditsSummary(resetCredits({
      credits: [
        credit({
          id: 'soon',
          status: 'available',
          expiresAt: Date.parse('2026-07-07T20:00:00.000Z'),
          expiresAtFormatted: 'Jul 7, 2026',
        }),
      ],
    }), Date.parse('2026-07-07T00:00:00.000Z'));

    expect(summary).toEqual([
      { label: 'Jul 7, 2026', count: 1, expiresSoon: true },
    ]);
  });

  test('returns no expiry summaries when credit details are empty', () => {
    const summary = buildResetCreditsSummary(resetCredits({
      availableCount: 2,
      credits: [],
    }), Date.parse('2026-07-01T00:00:00.000Z'));

    expect(summary).toEqual([]);
  });
});
