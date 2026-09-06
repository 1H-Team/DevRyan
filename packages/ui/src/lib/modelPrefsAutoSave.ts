import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { createModelPrefsBaseline, modelPrefsEqual, type ModelPrefsSnapshot } from '@/lib/modelPrefsSync';

export const startModelPrefsAutoSave = () => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let timer: number | null = null;
  let lastSent: ModelPrefsSnapshot = createModelPrefsBaseline({
    favoriteModels: useUIStore.getState().favoriteModels,
    favoriteModelsUpdatedAt: useUIStore.getState().favoriteModelsUpdatedAt,
    hiddenModels: useUIStore.getState().hiddenModels,
    hiddenModelsUpdatedAt: useUIStore.getState().hiddenModelsUpdatedAt,
  });

  const flush = () => {
    timer = null;
    const state = useUIStore.getState();
    const payload = {
      favoriteModels: state.favoriteModels,
      favoriteModelsUpdatedAt: state.favoriteModelsUpdatedAt,
      hiddenModels: state.hiddenModels,
      hiddenModelsUpdatedAt: state.hiddenModelsUpdatedAt,
    };

    if (modelPrefsEqual(lastSent, payload)) {
      return;
    }

    lastSent = createModelPrefsBaseline(payload);

    void updateDesktopSettings(payload).catch(() => {});
  };

  const schedule = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(flush, 1200);
  };

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    const next = {
      favoriteModels: state.favoriteModels,
      favoriteModelsUpdatedAt: state.favoriteModelsUpdatedAt,
      hiddenModels: state.hiddenModels,
      hiddenModelsUpdatedAt: state.hiddenModelsUpdatedAt,
    };
    const prev = {
      favoriteModels: prevState.favoriteModels,
      favoriteModelsUpdatedAt: prevState.favoriteModelsUpdatedAt,
      hiddenModels: prevState.hiddenModels,
      hiddenModelsUpdatedAt: prevState.hiddenModelsUpdatedAt,
    };
    if (modelPrefsEqual(next, prev)) {
      return;
    }
    schedule();
  });

  return () => {
    unsubscribe();
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};
