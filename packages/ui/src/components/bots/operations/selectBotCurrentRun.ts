import type { BotRun } from '@/lib/botsApi';
import type { BotOperationsState } from '@/stores/useBotOperationsStore';

const executingStates = new Set<BotRun['state']>([
  'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation',
]);

export const selectBotCurrentRunId = (
  state: Pick<BotOperationsState, 'runIdsByChannelId' | 'runsById'>,
  channelId: string,
): string | null => {
  let queued: BotRun | undefined;
  for (const id of state.runIdsByChannelId[channelId] ?? []) {
    const candidate = state.runsById[id];
    if (!candidate) continue;
    if (executingStates.has(candidate.state)) return id;
    if (candidate.state === 'queued' && (!queued
      || (candidate.queueSequence ?? Infinity) < (queued.queueSequence ?? Infinity))) queued = candidate;
  }
  return queued?.id ?? null;
};
