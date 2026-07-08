import type { UsageResetCredits } from '@/types';
import { sortResetCredits } from './usage-groups';

const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

export interface ResetCreditExpirySummary {
  label: string | null;
  count: number;
  expiresSoon: boolean;
}

export const getResetCreditsAvailableCount = (resetCredits: UsageResetCredits): number => (
  resetCredits.availableCount
    ?? resetCredits.credits.filter((credit) => credit.status.toLowerCase() === 'available').length
);

export const buildResetCreditsSummary = (
  resetCredits: UsageResetCredits,
  now = Date.now(),
): ResetCreditExpirySummary[] => {
  const groups = new Map<string, ResetCreditExpirySummary>();

  for (const credit of sortResetCredits(resetCredits.credits)) {
    if (credit.status.toLowerCase() !== 'available') {
      continue;
    }

    const key = credit.expiresAtFormatted ?? '__no_expiry__';
    const expiresSoon = typeof credit.expiresAt === 'number'
      && credit.expiresAt > now
      && credit.expiresAt - now <= EXPIRING_SOON_MS;
    const existing = groups.get(key);

    if (existing) {
      existing.count += 1;
      existing.expiresSoon = existing.expiresSoon || expiresSoon;
      continue;
    }

    groups.set(key, {
      label: credit.expiresAtFormatted,
      count: 1,
      expiresSoon,
    });
  }

  return Array.from(groups.values());
};
