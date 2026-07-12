import { create } from 'zustand';

export type ProviderRecoverySelection = {
  providerId: string;
  modelId: string;
  variant: string | null;
};

export type ProviderRecoveryInput = {
  sessionId: string;
  directory: string;
  anchorUserMessageId: string;
  reason: string;
  providerId: string;
  modelId: string;
  variant: string | null;
  agent: string | null;
  createdAt: number;
};

export type ProviderRecoveryRecord = ProviderRecoveryInput & {
  selection: ProviderRecoverySelection;
  pending: boolean;
  actionError: string | null;
};

type ProviderRecoveryStore = {
  recoveriesBySessionId: Readonly<Record<string, ProviderRecoveryRecord>>;
  offerRecovery(recovery: ProviderRecoveryInput): void;
  setSelection(sessionId: string, selection: ProviderRecoverySelection): void;
  setActionState(sessionId: string, pending: boolean, actionError: string | null): void;
  clearRecovery(sessionId: string): void;
  reset(): void;
};

const emptyRecoveries = () => ({} as Readonly<Record<string, ProviderRecoveryRecord>>);

export const useProviderRecoveryStore = create<ProviderRecoveryStore>()((set) => ({
  recoveriesBySessionId: emptyRecoveries(),
  offerRecovery(recovery) {
    set((state) => {
      const previous = state.recoveriesBySessionId[recovery.sessionId];
      const selection = previous?.anchorUserMessageId === recovery.anchorUserMessageId
        ? previous.selection
        : {
            providerId: recovery.providerId,
            modelId: recovery.modelId,
            variant: recovery.variant,
          };
      const next: ProviderRecoveryRecord = {
        ...recovery,
        selection,
        pending: previous?.pending ?? false,
        actionError: previous?.actionError ?? null,
      };
      return {
        recoveriesBySessionId: { ...state.recoveriesBySessionId, [recovery.sessionId]: next },
      };
    });
  },
  setSelection(sessionId, selection) {
    set((state) => {
      const previous = state.recoveriesBySessionId[sessionId];
      if (!previous) return state;
      if (
        previous.selection.providerId === selection.providerId
        && previous.selection.modelId === selection.modelId
        && previous.selection.variant === selection.variant
      ) return state;
      return {
        recoveriesBySessionId: {
          ...state.recoveriesBySessionId,
          [sessionId]: { ...previous, selection, actionError: null },
        },
      };
    });
  },
  setActionState(sessionId, pending, actionError) {
    set((state) => {
      const previous = state.recoveriesBySessionId[sessionId];
      if (!previous) return state;
      if (previous.pending === pending && previous.actionError === actionError) return state;
      return {
        recoveriesBySessionId: {
          ...state.recoveriesBySessionId,
          [sessionId]: { ...previous, pending, actionError },
        },
      };
    });
  },
  clearRecovery(sessionId) {
    set((state) => {
      if (!state.recoveriesBySessionId[sessionId]) return state;
      const recoveriesBySessionId = { ...state.recoveriesBySessionId };
      delete recoveriesBySessionId[sessionId];
      return { recoveriesBySessionId };
    });
  },
  reset() {
    set({ recoveriesBySessionId: emptyRecoveries() });
  },
}));

export const providerRecoverySelector = (sessionId: string) => (state: ProviderRecoveryStore) => (
  state.recoveriesBySessionId[sessionId]
);
