import type { BotHumanInputEvent } from '@/lib/botsApi';

export const queueBotHumanInputEvent = (
  pending: BotHumanInputEvent[],
  event: BotHumanInputEvent,
  maximum: number,
): boolean => {
  const last = pending[pending.length - 1];
  if (event.type === 'pointer' && event.phase === 'move'
    && event.buttons === 0
    && last?.type === 'pointer' && last.phase === 'move' && last.buttons === 0) {
    pending[pending.length - 1] = event;
    return true;
  }
  if (event.type === 'wheel' && last?.type === 'wheel') {
    pending[pending.length - 1] = {
      ...event,
      deltaX: Math.max(-100_000, Math.min(100_000, last.deltaX + event.deltaX)),
      deltaY: Math.max(-100_000, Math.min(100_000, last.deltaY + event.deltaY)),
    };
    return true;
  }
  if (pending.length >= maximum) {
    const disposableIndex = pending.findIndex((candidate) => (
      (candidate.type === 'pointer' && candidate.phase === 'move')
      || candidate.type === 'wheel'
    ));
    if (disposableIndex < 0) {
      if (event.type === 'pointer' && (event.phase === 'down' || event.phase === 'up')) {
        pending.push(event);
        return true;
      }
      return false;
    }
    pending.splice(disposableIndex, 1);
  }
  pending.push(event);
  return true;
};
