import React from 'react';

import { cn } from '@/lib/utils';
import type { SessionLeadingIndicatorPresentation } from './sessionIndicator';
import { SESSION_WORKING_BLINK_DURATION_MS, resolveWorkingBlinkCurrentTimeMs } from './sessionWorkingBlink';

const DOT_CLASS = 'h-1.5 w-1.5 flex-shrink-0 rounded-full';

type SessionStatusDotProps = {
  presentation: SessionLeadingIndicatorPresentation;
  /** Translated label for status/working; ignored for the idle ring. */
  label?: string;
};

// Must match the keyframes used by `.animate-session-working-blink`.
const SESSION_WORKING_BLINK_ANIMATION_NAME = 'oc-busy-pulse';

// A CSS animation restarts whenever its element leaves and re-enters rendering
// (for example the parent-row hover swap hides the dot with `display: none`),
// but keeps the mount-time delay, so realign it on every start.
const alignWorkingBlinkToWallClock = (event: React.AnimationEvent<HTMLSpanElement>) => {
  if (event.animationName !== SESSION_WORKING_BLINK_ANIMATION_NAME) return;
  const element = event.currentTarget;
  if (typeof element.getAnimations !== 'function' || typeof CSSAnimation === 'undefined') return;
  const nowMs = Date.now();
  for (const animation of element.getAnimations()) {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== SESSION_WORKING_BLINK_ANIMATION_NAME) continue;
    const delay = animation.effect?.getTiming().delay ?? 0;
    animation.currentTime = resolveWorkingBlinkCurrentTimeMs(nowMs, delay);
  }
};

function SessionWorkingDot({ label }: { label?: string }) {
  // Phase-align every working dot to wall-clock time so all rows blink in
  // unison, including rows that mount later. The delay covers the first frame
  // and server markup; `onAnimationStart` realigns each (re)start.
  const [animationDelay] = React.useState(
    () => `-${Date.now() % SESSION_WORKING_BLINK_DURATION_MS}ms`,
  );

  return (
    <span
      role="img"
      className={cn(DOT_CLASS, 'bg-muted-foreground animate-session-working-blink')}
      style={{ animationDelay }}
      onAnimationStart={alignWorkingBlinkToWallClock}
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
