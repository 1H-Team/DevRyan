import React from 'react';

import type { BotSummary } from '@/lib/botsApi';
import { cn } from '@/lib/utils';

const initialsFor = (name: string): string => {
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return initials || 'B';
};

type BotAvatarProps = {
  bot: Pick<BotSummary, 'name' | 'title' | 'avatarUrl' | 'avatarFallback' | 'updatedAt'>;
  className?: string;
  imageUrl?: string | null;
};

export const BotAvatar: React.FC<BotAvatarProps> = ({ bot, className, imageUrl }) => {
  const [imageFailed, setImageFailed] = React.useState(false);
  const source = imageUrl === undefined
    ? bot.avatarUrl
    : imageUrl;

  React.useEffect(() => setImageFailed(false), [source]);

  return (
    <span className={cn(
      'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] text-foreground',
      className,
    )}>
      {source && !imageFailed ? (
        <img
          src={source}
          alt={`${bot.title || bot.name} avatar`}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span aria-hidden className="font-semibold">{bot.avatarFallback || initialsFor(bot.name)}</span>
      )}
    </span>
  );
};
