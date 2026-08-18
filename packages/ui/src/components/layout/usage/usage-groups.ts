import type { UsageResetCredit } from '@/types';
import type { RateLimitGroup } from './types';

export const resolveActiveUsageProviderId = (
  groups: RateLimitGroup[],
  currentId: string | null,
): string | null => {
  if (currentId && groups.some((group) => group.providerId === currentId)) {
    return currentId;
  }
  return groups[0]?.providerId ?? null;
};

const providerNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export const buildUsageProviderTabs = (groups: RateLimitGroup[]) => (
  groups
    .map((group) => ({
      id: group.providerId,
      label: group.providerName,
      title: group.providerName,
    }))
    .sort((left, right) => (
      providerNameCollator.compare(left.label, right.label)
      || left.id.localeCompare(right.id)
    ))
);

export const sortUsageEntries = (
  providerId: string,
  entries: RateLimitGroup['entries'],
): RateLimitGroup['entries'] => {
  if (providerId !== 'claude') {
    return entries;
  }

  const anthropicWindowRank = (label: string): number => {
    if (label === '5h') return 0;
    if (label === '7d') return 1;
    if (label.startsWith('7d-')) return 2;
    return 3;
  };

  return [...entries].sort(
    ([leftLabel], [rightLabel]) => anthropicWindowRank(leftLabel) - anthropicWindowRank(rightLabel),
  );
};

export const getVisibleUsageEntries = (group: RateLimitGroup) => {
  const entries = group.providerId === 'codex' && group.resetCredits
    ? group.entries.filter(([label]) => label !== 'credits')
    : group.entries;

  return sortUsageEntries(group.providerId, entries);
};

const creditStatusRank = (status: string): number => {
  const normalized = status.toLowerCase();
  if (normalized === 'available') return 0;
  if (normalized === 'redeeming') return 1;
  if (normalized === 'redeemed') return 2;
  if (normalized === 'expired') return 3;
  return 4;
};

const expiryRank = (credit: UsageResetCredit): number => {
  return typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt)
    ? credit.expiresAt
    : Number.MAX_SAFE_INTEGER;
};

export const sortResetCredits = (credits: UsageResetCredit[]): UsageResetCredit[] => (
  [...credits].sort((left, right) => {
    const statusDelta = creditStatusRank(left.status) - creditStatusRank(right.status);
    if (statusDelta !== 0) return statusDelta;
    const expiryDelta = expiryRank(left) - expiryRank(right);
    if (expiryDelta !== 0) return expiryDelta;
    return left.id.localeCompare(right.id);
  })
);
