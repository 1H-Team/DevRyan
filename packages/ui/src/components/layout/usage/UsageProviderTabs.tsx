import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { buildUsageProviderTabs } from './usage-groups';
import type { RateLimitGroup } from './types';

interface UsageProviderTabsProps {
  groups: RateLimitGroup[];
  activeProviderId: string | null;
  onSelectProvider: (providerId: string) => void;
  mobile?: boolean;
}

export const UsageProviderTabs = React.memo(function UsageProviderTabs({
  groups,
  activeProviderId,
  onSelectProvider,
  mobile = false,
}: UsageProviderTabsProps) {
  const { t } = useI18n();
  const items = React.useMemo(() => buildUsageProviderTabs(groups), [groups]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={mobile ? 'px-3 pb-2 pt-1' : 'border-b border-[var(--interactive-border)] px-3 pb-2 pt-1'}>
      <div
        role="tablist"
        aria-label={t('header.services.providerTabsAria')}
        className={cn(
          'grid min-w-0 gap-0.5 rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] p-0.5',
          mobile ? 'grid-cols-2' : 'grid-cols-3'
        )}
      >
        {items.map((item) => {
          const isActive = item.id === activeProviderId;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelectProvider(item.id)}
              title={item.title ?? item.label}
              className={cn(
                'flex h-7 w-full min-w-0 items-center justify-center gap-1.5 rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] px-2 text-center text-xs font-medium transition-colors duration-150 !min-h-0',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                isActive
                  ? 'border border-border/60 bg-[var(--surface-elevated)] text-foreground'
                  : 'border border-transparent bg-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
              )}
            >
              <ProviderLogo providerId={item.id} className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
