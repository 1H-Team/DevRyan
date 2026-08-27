import React from 'react';
import { RiRobot2Line, RiTerminalBoxLine } from '@remixicon/react';

import { useI18n } from '@/lib/i18n';
import { hasAuthCapability, useAuthPrincipal } from '@/lib/authSession';
import { cn } from '@/lib/utils';
import type { ProductAudience } from '@/stores/useMainSidebarAudienceStore';

const AUDIENCES: readonly ProductAudience[] = ['coding-agents', 'bots'];

type ProductAudienceTabsProps = {
  audience: ProductAudience;
  onAudienceChange: (audience: ProductAudience) => void;
  className?: string;
  idPrefix: string;
  labelledBy?: string;
  panelId?: string;
  variant?: 'sidebar' | 'settings';
  botsAllowed?: boolean;
};

export const ProductAudienceTabs: React.FC<ProductAudienceTabsProps> = ({
  audience,
  onAudienceChange,
  className,
  idPrefix,
  labelledBy,
  panelId,
  variant = 'settings',
  botsAllowed,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const sidebar = variant === 'sidebar';

  const selectAndFocus = React.useCallback((index: number) => {
    const nextAudience = AUDIENCES[index];
    if (!nextAudience) return;
    onAudienceChange(nextAudience);
    refs.current[index]?.focus();
  }, [onAudienceChange]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % AUDIENCES.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + AUDIENCES.length) % AUDIENCES.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = AUDIENCES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectAndFocus(nextIndex);
  }, [selectAndFocus]);

  if (!(botsAllowed ?? hasAuthCapability(principal, 'bots'))) return null;

  return (
    <div
      role="tablist"
      aria-label={labelledBy
        ? undefined
        : t(sidebar ? 'audience.tabs.sidebarAria' : 'audience.tabs.aria')}
      aria-labelledby={labelledBy}
      className={cn(
        'grid gap-0.5 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] p-0.5',
        sidebar
          ? 'mb-1 grid-cols-2'
          : 'w-full max-w-[320px] grid-cols-2',
        className,
      )}
    >
      {AUDIENCES.map((item, index) => {
        const selected = audience === item;
        const Icon = item === 'coding-agents' ? RiTerminalBoxLine : RiRobot2Line;
        const label = item === 'coding-agents'
          ? t(sidebar ? 'audience.tabs.sidebarAgents' : 'audience.tabs.codingAgents')
          : t('audience.tabs.bots');
        return (
          <button
            key={item}
            ref={(node) => { refs.current[index] = node; }}
            id={`${idPrefix}-${item}-tab`}
            type="button"
            role="tab"
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-controls={panelId}
            onClick={() => onAudienceChange(item)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'flex h-8 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border px-2 text-center typography-ui-label font-medium transition-[background-color,border-color,color,box-shadow] duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              selected
                ? 'border-border/70 bg-[var(--surface-elevated)] text-foreground shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_8%,transparent)]'
                : 'border-transparent text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
            )}
          >
            {sidebar ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
};
