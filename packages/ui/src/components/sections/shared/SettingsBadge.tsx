import React from 'react';
import { cn } from '@/lib/utils';

export type SettingsBadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

interface SettingsBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: SettingsBadgeTone;
  /** Leading status dot (decorative) */
  dot?: boolean;
}

const TONE_CLASSES: Record<SettingsBadgeTone, string> = {
  neutral: 'border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-muted-foreground',
  accent: 'border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-foreground',
  success: 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)]',
  warning: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning)]',
  error: 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error)]',
};

/** Pill badge for scope, source and status labels on settings pages. */
export const SettingsBadge: React.FC<SettingsBadgeProps> = ({
  tone = 'neutral',
  dot = false,
  className,
  children,
  ...props
}) => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 typography-micro font-medium',
      TONE_CLASSES[tone],
      className,
    )}
    {...props}
  >
    {dot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /> : null}
    {children}
  </span>
);
