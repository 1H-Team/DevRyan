import React from 'react';
import { Tabs } from '@base-ui/react/tabs';

import { cn } from '@/lib/utils';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export type SettingsSectionTab = {
  slug: SettingsPageSlug;
  label: string;
};

interface SettingsSectionTabsProps {
  activeSlug: SettingsPageSlug;
  ariaLabel: string;
  idPrefix: string;
  onTabChange: (slug: SettingsPageSlug) => void;
  pendingSlug?: SettingsPageSlug | null;
  tabs: readonly SettingsSectionTab[];
  children: React.ReactNode;
}

export const SettingsSectionTabs: React.FC<SettingsSectionTabsProps> = ({
  activeSlug,
  ariaLabel,
  idPrefix,
  onTabChange,
  pendingSlug = null,
  tabs,
  children,
}) => {
  if (tabs.length <= 1) {
    return <>{children}</>;
  }

  return (
    <Tabs.Root
      value={activeSlug}
      onValueChange={(value) => onTabChange(value as SettingsPageSlug)}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="shrink-0 border-b border-border bg-background px-4 py-2.5">
        <Tabs.List
          aria-label={ariaLabel}
          className="mx-auto grid w-full max-w-[420px] grid-cols-2 gap-0.5 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] p-0.5"
        >
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.slug}
              id={`${idPrefix}-${tab.slug}-tab`}
              aria-controls={`${idPrefix}-panel`}
              aria-busy={pendingSlug === tab.slug || undefined}
              value={tab.slug}
              className={cn(
                'flex h-8 min-w-0 cursor-pointer items-center justify-center rounded-[9px] border px-2 text-center typography-ui-label font-medium',
                'transition-[background-color,border-color,color,box-shadow] duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                'border-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                'data-[active]:border-border/70 data-[active]:bg-[var(--surface-elevated)] data-[active]:text-foreground data-[active]:shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_8%,transparent)]',
              )}
            >
              <span className="truncate">{tab.label}</span>
              {pendingSlug === tab.slug ? (
                <span className="ml-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
              ) : null}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </div>
      <div
        id={`${idPrefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-${activeSlug}-tab`}
        className="min-h-0 flex-1 overflow-hidden focus-visible:outline-none"
      >
        {children}
      </div>
    </Tabs.Root>
  );
};
