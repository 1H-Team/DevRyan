import React from 'react';

import { cn } from '@/lib/utils';

export const BOT_TYPING_DOT_DELAYS = ['0ms', '160ms', '320ms'] as const;

// The one animated three-dot glyph shared by the transcript typing bubble and
// the sidebar row, so both surfaces pulse identically.
export const BotTypingDots: React.FC<{ className?: string; dotClassName?: string }> = ({
  className,
  dotClassName,
}) => (
  <span className={cn('inline-flex items-center gap-1', className)} aria-hidden="true">
    {BOT_TYPING_DOT_DELAYS.map((animationDelay) => (
      <span
        key={animationDelay}
        className={cn(
          'h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bot-typing-dot motion-reduce:animate-none',
          dotClassName,
        )}
        style={{ animationDelay }}
      />
    ))}
  </span>
);
