import React from 'react';

import { cn } from '@/lib/utils';
import type { SessionLeadingIndicatorPresentation } from './sessionIndicator';

// Must match `.animate-session-working-blink` in index.css.
export const SESSION_WORKING_BLINK_DURATION_MS = 2400;

const DOT_CLASS = 'h-1.5 w-1.5 flex-shrink-0 rounded-full';

type SessionStatusDotProps = {
  presentation: SessionLeadingIndicatorPresentation;
  /** Translated label for status/working; ignored for the idle ring. */
  label?: string;
};

function SessionWorkingDot({ label }: { label?: string }) {
  // Phase-align every working dot to wall-clock time so all rows blink in
  // unison, including rows that mount later.
  const [animationDelay] = React.useState(
    () => `-${Date.now() % SESSION_WORKING_BLINK_DURATION_MS}ms`,
  );

  return (
    <span
      role="img"
      className={cn(DOT_CLASS, 'bg-muted-foreground animate-session-working-blink')}
      style={{ animationDelay }}
      aria-label={label}
      title={label}
    />
  );
}

// The single leading status marker shared by sidebar rows and the mobile
// session status bar: a colored attention dot, a slow gray working blink, or a
// faint idle ring that holds the slot.
export function SessionStatusDot({ presentation, label }: SessionStatusDotProps) {
  if (presentation.kind === 'status') {
    return (
      <span
        role="img"
        className={cn(DOT_CLASS, presentation.indicator.className)}
        aria-label={label}
        title={label}
      />
    );
  }

  if (presentation.kind === 'working') {
    return <SessionWorkingDot label={label} />;
  }

  return (
    <span
      className={cn(DOT_CLASS, 'border border-muted-foreground/60')}
      aria-hidden="true"
    />
  );
}
