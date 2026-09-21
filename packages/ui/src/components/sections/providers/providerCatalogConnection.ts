import { create } from 'zustand';

interface PendingConnection {
  id: string;
  name: string;
  lastAttemptRevision: number;
}

interface ProviderConnectionStore {
  pending: Record<string, PendingConnection>;
  markPending: (provider: PendingConnection) => void;
  clear: (providerId: string) => void;
}

// Credential-free, transient state survives navigation between settings sections.
export const useProviderConnectionStore = create<ProviderConnectionStore>((set) => ({
  pending: {},
  markPending: (provider) => set((state) => ({ pending: { ...state.pending, [provider.id]: provider } })),
  clear: (providerId) => set((state) => {
    if (!state.pending[providerId]) return state;
    const pending = { ...state.pending };
    delete pending[providerId];
    return { pending };
  }),
}));

export const waitForProviderCatalogReady = async ({
  refresh,
  isReady,
  onStalled,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  refresh: () => Promise<void>;
  isReady: () => boolean;
  onStalled?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<boolean> => {
  const delays = [0, 500, 1000, 1500, 2000, 3000, 3000, 4000];
  for (const [attempt, delay] of delays.entries()) {
    if (delay) await sleep(delay);
    try {
      if (attempt === 3 && onStalled && !await onStalled()) return false;
      await refresh();
      if (isReady()) return true;
    } catch {
      // A saved credential is not a failed save when catalog discovery is unavailable.
    }
  }
  return false;
};
