import React from 'react';
import { cn } from '@/lib/utils';

interface SettingsDetailHeaderProps {
  /** Leading icon or logo, rendered at 20px */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** Full title shown on hover when the title may truncate */
  titleTooltip?: string;
  /** Status or scope badges shown next to the title */
  badges?: React.ReactNode;
  /** Secondary line under the title */
  subtitle?: React.ReactNode;
  /** Primary actions; they wrap below the title when the column is narrow */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Header for a settings detail page: icon, title with badges, subtitle, and actions.
 *
 * @example
 * <SettingsDetailHeader
 *   icon={<RiServerLine />}
 *   title={server.name}
 *   badges={<SettingsBadge tone="success" dot>Connected</SettingsBadge>}
 *   subtitle="Local (stdio)"
 *   actions={<Button size="xs">Test</Button>}
 * />
 */
export const SettingsDetailHeader: React.FC<SettingsDetailHeaderProps> = ({
  icon,
  title,
  titleTooltip,
  badges,
  subtitle,
  actions,
  className,
}) => (
  <header className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
    <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
      {icon ? (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:h-5 [&>svg]:w-5">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="typography-ui-header min-w-0 truncate font-semibold text-foreground" title={titleTooltip}>
            {title}
          </h2>
          {badges}
        </div>
        {subtitle ? <div className="typography-meta mt-0.5 min-w-0 text-muted-foreground">{subtitle}</div> : null}
      </div>
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
  </header>
);
