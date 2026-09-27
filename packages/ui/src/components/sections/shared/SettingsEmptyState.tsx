import React from 'react';
import { cn } from '@/lib/utils';

interface SettingsEmptyStateProps {
  /** Illustrative icon component */
  icon?: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional follow-up action, such as a create button */
  action?: React.ReactNode;
  /** `sidebar` for list columns, `page` for a centered detail placeholder */
  size?: 'sidebar' | 'page';
  className?: string;
}

/**
 * Consistent empty and placeholder state for settings sidebars and pages.
 *
 * @example
 * <SettingsEmptyState icon={RiPlugLine} title="No Plugins" description="Add one in opencode.json" />
 */
export const SettingsEmptyState: React.FC<SettingsEmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  size = 'sidebar',
  className,
}) => {
  const isPage = size === 'page';

  return (
    <div
      className={cn(
        'text-center text-muted-foreground',
        isPage ? 'flex h-full min-h-[240px] items-center justify-center px-6' : 'px-4 py-12',
        className,
      )}
    >
      <div className={cn(isPage && 'max-w-sm')}>
        {Icon ? <Icon className={cn('mx-auto mb-3 opacity-50', isPage ? 'h-12 w-12' : 'h-10 w-10')} /> : null}
        <p className={isPage ? 'typography-body' : 'typography-ui-label font-medium'}>{title}</p>
        {description ? <p className="typography-meta mt-1 opacity-75">{description}</p> : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
};
