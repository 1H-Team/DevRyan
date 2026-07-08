import React from 'react';
import { RiTimeLine } from '@remixicon/react';
import type { UsageResetCredits } from '@/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  buildResetCreditsSummary,
  getResetCreditsAvailableCount,
} from './reset-credit-summary';

interface UsageResetCreditsListProps {
  resetCredits: UsageResetCredits;
}

export const UsageResetCreditsList = React.memo(function UsageResetCreditsList({
  resetCredits,
}: UsageResetCreditsListProps) {
  const { t } = useI18n();
  const availableCount = getResetCreditsAvailableCount(resetCredits);
  const expirySummary = React.useMemo(() => buildResetCreditsSummary(resetCredits), [resetCredits]);

  return (
    <div className="rounded-lg border border-[var(--interactive-border)] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <RiTimeLine className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="typography-ui-label font-medium text-foreground">
          {t('header.services.resetCredits.title')}
        </span>
      </div>

      <div className="mt-2 divide-y divide-[var(--interactive-border)] rounded-md bg-[var(--surface-elevated)]">
        <div className="flex min-w-0 items-center justify-between gap-3 px-2 py-1.5">
          <span className="typography-micro text-muted-foreground">
            {t('header.services.resetCredits.availableLabel')}
          </span>
          <span className="typography-ui-label tabular-nums text-foreground">
            {t('header.services.resetCredits.availableCount', { count: availableCount })}
          </span>
        </div>

        <div className="flex min-w-0 items-start justify-between gap-3 px-2 py-1.5">
          <span className="shrink-0 typography-micro text-muted-foreground">
            {t('header.services.resetCredits.expiryLabel')}
          </span>
          {expirySummary.length === 0 ? (
            <span className="min-w-0 text-right typography-micro text-muted-foreground">
              {t('header.services.resetCredits.expiryUnavailable')}
            </span>
          ) : (
            <div className="flex min-w-0 flex-wrap justify-end gap-1">
              {expirySummary.map((summary) => (
                <span
                  key={summary.label ?? 'no-expiry'}
                  className={cn(
                    'max-w-full truncate rounded border border-[var(--interactive-border)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-1.5 py-0.5 typography-micro tabular-nums text-muted-foreground',
                    summary.expiresSoon && 'border-[var(--status-warning-border)] text-[var(--status-warning)]'
                  )}
                >
                  {summary.count > 1 ? `${summary.count}x ` : ''}
                  {summary.label ?? t('header.services.resetCredits.noExpiry')}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
