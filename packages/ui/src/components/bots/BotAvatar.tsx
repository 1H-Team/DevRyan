import React from 'react';

import type { BotSummary } from '@/lib/botsApi';
import { botAvatarCache } from '@/lib/botAvatarCache';
import { useBotsStore } from '@/stores/useBotsStore';
import { cn } from '@/lib/utils';

const initialsFor = (name: string): string => {
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  return initials || 'B';
};

type BotAvatarProps = {
  bot: Pick<BotSummary, 'id' | 'name' | 'title' | 'avatarUrl' | 'avatarFallback' | 'updatedAt'>;
  className?: string;
  imageUrl?: string | null;
  priority?: number;
  lazy?: boolean;
};

export const BotAvatar: React.FC<BotAvatarProps> = ({ bot, className, imageUrl, priority = 0, lazy = false }) => {
  const element = React.useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = React.useState(!lazy || typeof IntersectionObserver === 'undefined');
  React.useEffect(() => {
    if (!lazy || !element.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: '80px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [lazy]);
  const principalId = useBotsStore((state) => state.principalId);
  const source = imageUrl === undefined ? bot.avatarUrl : imageUrl;
  // Editor previews are local data URLs, never retained as authenticated avatars.
  const localPreview = imageUrl !== undefined;
  const identity = React.useMemo(() => ({ principalId, botId: bot.id, source: source ?? '' }),
    [principalId, bot.id, source]);
  const subscribe = React.useCallback((notify: () => void) => (
    source && !localPreview && (visible || !lazy) ? botAvatarCache.subscribe(identity, notify, priority) : () => undefined
  ), [identity, lazy, localPreview, priority, source, visible]);
  const getSnapshot = React.useCallback(() => localPreview ? source : botAvatarCache.peek(identity),
    [identity, localPreview, source]);
  const loadedSource = React.useSyncExternalStore(subscribe, getSnapshot, () => null);

  return (
    <span ref={element} data-bot-avatar={bot.id} className={cn(
      'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] text-foreground',
      className,
    )}>
      {!loadedSource ? <span aria-hidden className="font-semibold">{bot.avatarFallback || initialsFor(bot.name)}</span> : null}
      {loadedSource ? (
        <img
          key={`${principalId}:${bot.id}:${source}`}
          src={loadedSource}
          alt={`${bot.title || bot.name} avatar`}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
};
