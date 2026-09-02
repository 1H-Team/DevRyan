import type { BotRun } from '@/lib/botsApi';

export type BotSidebarStatus = 'typing' | 'waiting';

// The sidebar mirrors the conversation: dots while the Bot is preparing or
// writing an answer, "needs you" while a run is parked on a confirmation,
// human control, or reconciliation the member has to resolve.
export const resolveBotSidebarStatus = (run: BotRun | null | undefined): BotSidebarStatus | null => {
  if (!run) return null;
  if (run.state === 'queued' || run.state === 'starting' || run.state === 'running') return 'typing';
  if (run.state === 'waiting_approval' || run.state === 'waiting_control'
    || run.state === 'needs_reconciliation') return 'waiting';
  return null;
};
