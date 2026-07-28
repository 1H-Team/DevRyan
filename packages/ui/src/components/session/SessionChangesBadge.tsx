import type { SessionDiffStats } from '@/lib/sessionDiffStats';
import { cn } from '@/lib/utils';

type SessionChangesBadgeProps = {
  stats: SessionDiffStats;
  className?: string;
  title?: string;
  ariaLabel?: string;
};

export function SessionChangesBadge({ stats, className, title, ariaLabel }: SessionChangesBadgeProps) {
  return (
    <span
      title={title}
      aria-label={ariaLabel ?? title}
      className={cn(
        'inline-flex h-[14px] flex-shrink-0 items-center gap-0 self-center align-middle typography-micro text-[10.5px] font-medium leading-none',
        className,
      )}
    >
      <span className="text-status-success">+{stats.additions}</span>
      <span className="px-1 text-muted-foreground/75">/</span>
      <span className="text-status-error">-{stats.deletions}</span>
    </span>
  );
}
