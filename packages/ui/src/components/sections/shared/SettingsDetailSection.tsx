import React from 'react';
import { cn } from '@/lib/utils';

interface SettingsDetailSectionProps {
  title: React.ReactNode;
  /** Item count shown after the title, e.g. "(12)" */
  count?: number;
  /** Short secondary text next to the title, e.g. "Updated 10:42" */
  meta?: React.ReactNode;
  /** Section actions aligned to the right of the title */
  actions?: React.ReactNode;
  description?: React.ReactNode;
  /** `plain` for form content, `card` for grouped read-only rows */
  variant?: 'plain' | 'card';
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * A titled section on a settings detail page.
 *
 * @example
 * <SettingsDetailSection title="Models" count={models.length} actions={<Button size="xs">Show All</Button>}>
 *   <ModelList />
 * </SettingsDetailSection>
 */
export const SettingsDetailSection: React.FC<SettingsDetailSectionProps> = ({
  title,
  count,
  meta,
  actions,
  description,
  variant = 'plain',
  children,
  className,
  bodyClassName,
}) => {
  const headingId = React.useId();

  return (
    <section className={cn('min-w-0', className)} aria-labelledby={headingId}>
      <div className="mb-1 flex min-h-7 items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={headingId} className="typography-ui-header shrink-0 font-medium text-foreground">
            {title}
            {typeof count === 'number' ? (
              <span className="ml-1.5 typography-micro font-normal text-muted-foreground">({count})</span>
            ) : null}
          </h3>
          {meta ? <span className="min-w-0 truncate typography-meta text-muted-foreground">{meta}</span> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {description ? <p className="mb-2 px-1 typography-meta text-muted-foreground">{description}</p> : null}
      <div
        className={cn(
          variant === 'card'
            ? 'rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3'
            : 'px-2 pb-2 pt-0',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
};
