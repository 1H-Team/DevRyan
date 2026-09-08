import React from 'react';
import { RiComputerLine, RiUserSharedLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import type { BotSummary } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { useBotsStore } from '@/stores/useBotsStore';

const ACTIVE_STATES = new Set(['queued', 'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation']);

// Computer activity is a leaf subscription: neither frames nor composer text
// should repaint the transcript or the surrounding chat chrome.
export const BotComputerStatusBar = React.memo(function BotComputerStatusBar({
  bot, channelId, onVisible,
}: { bot: BotSummary; channelId: string; onVisible?: () => void }) {
  const { t } = useI18n();
  const member = useBotsStore((state) => state.membershipsByBotId[bot.id]);
  const activity = useBotComputerActivityStore((state) => state.byBotId[bot.id]);
  const shown = useBotComputerActivityStore((state) => state.manualByBotId[bot.id]?.channelId === channelId);
  const runState = useBotOperationsStore((state) => activity ? state.runsById[activity.runId]?.state : undefined);
  const usingComputer = activity?.channelId === channelId && activity.state !== 'idle'
    && (runState === undefined || ACTIVE_STATES.has(runState));
  const visible = Boolean(member && bot.lifecycle === 'active' && (usingComputer || shown));
  const wasVisibleRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (visible && !wasVisibleRef.current) onVisible?.();
    wasVisibleRef.current = visible;
  }, [onVisible, visible]);
  if (!visible) return null;
  const waiting = usingComputer && (activity.state === 'waiting' || runState === 'waiting_control');
  const Icon = waiting ? RiUserSharedLine : RiComputerLine;
  return (
    <div className="mx-3 mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
      data-bot-computer-status={bot.id} data-bot-chat-control-wait={waiting || undefined}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span role="status" className="min-w-0 flex-1 typography-micro text-foreground">
        {waiting ? t('bots.chat.computer.waiting', { bot: bot.name })
          : usingComputer ? t('bots.chat.computer.using', { bot: bot.name }) : t('bots.chat.computer.title')}
      </span>
      <Button type="button" variant="ghost" size="xs" aria-expanded={shown} aria-controls={`bot-computer-${bot.id}`}
        onClick={() => {
          const computer = useBotComputerActivityStore.getState();
          if (shown) computer.hide(bot.id);
          else computer.show(bot.id, channelId);
        }}>
        {shown ? t('bots.chat.computer.hide') : t('bots.chat.computer.show')}
      </Button>
    </div>
  );
});
