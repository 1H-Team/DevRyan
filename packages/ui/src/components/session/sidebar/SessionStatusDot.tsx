import React from 'react';

import { cn } from '@/lib/utils';
import type { SessionLeadingIndicatorPresentation } from './sessionIndicator';
import { useSharedBlink } from '@/components/chat/message/parts/useDurationTicker';

const DOT_CLASS = 'h-1.5 w-1.5 flex-shrink-0 rounded-full';

type SessionStatusDotProps = {
  presentation: SessionLeadingIndicatorPresentation;
  /** Translated label for status/working; ignored for the idle ring. */
  label?: string;
};

// Every working dot blinks on the one shared document tick, so all rows stay in
// unison (including rows that mount later or are hidden by the hover swap) and
// an idle sidebar draws one frame per second instead of animating continuously.
function SessionWorkingDot({ label }: { label?: string }) {
  useSharedBlink(true);

  return (
    <span
      role="img"
      className={cn(DOT_CLASS, 'bg-muted-foreground oc-tick-blink')}
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
