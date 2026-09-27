import { retryBotsEventConnection } from '@/apps/botEventConnection';
import { useBotsStore } from '@/stores/useBotsStore';

// After Setup, Repair, Update, Restore, Start Empty, Resume or an import the
// catalog and execution state changed underneath the UI: re-read the
// capability summary, then reconnect the event stream and reload the
// assigned catalog through the single owner connection.
export const refreshBotsState = async (): Promise<void> => {
  await useBotsStore.getState().loadCapabilities().catch(() => null);
  retryBotsEventConnection();
};
