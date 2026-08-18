import { beforeEach, describe, expect, mock, test } from 'bun:test';

const savedSettings: Array<{
  favoriteModels?: Array<{ providerID: string; modelID: string }>;
  favoriteModelsUpdatedAt?: number;
  hiddenModels?: Array<{ providerID: string; modelID: string }>;
  hiddenModelsUpdatedAt?: number;
}> = [];

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async (changes: {
    favoriteModels?: Array<{ providerID: string; modelID: string }>;
    favoriteModelsUpdatedAt?: number;
    hiddenModels?: Array<{ providerID: string; modelID: string }>;
    hiddenModelsUpdatedAt?: number;
  }) => {
    savedSettings.push(changes);
  }),
}));

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
  isTauriShell: () => false,
}));

const { startModelPrefsAutoSave } = await import('./modelPrefsAutoSave');
const { useUIStore } = await import('@/stores/useUIStore');

describe('startModelPrefsAutoSave', () => {
  beforeEach(() => {
    savedSettings.length = 0;
    useUIStore.setState({
      favoriteModels: [],
      favoriteModelsUpdatedAt: 0,
      hiddenModels: [],
      hiddenModelsUpdatedAt: 0,
    });
  });

  test('persists the first hidden model change after startup', async () => {
    (globalThis as Record<string, unknown>).window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    const stopAutoSave = startModelPrefsAutoSave();
    const originalDateNow = Date.now;
    Date.now = () => 1234;

    try {
      useUIStore.getState().toggleHiddenModel('anthropic', 'claude-hidden');
      await new Promise((resolve) => setTimeout(resolve, 1250));

      expect(savedSettings).toEqual([
        {
          favoriteModels: [],
          favoriteModelsUpdatedAt: 0,
          hiddenModels: [{ providerID: 'anthropic', modelID: 'claude-hidden' }],
          hiddenModelsUpdatedAt: 1234,
        },
      ]);
    } finally {
      Date.now = originalDateNow;
      stopAutoSave();
      (globalThis as Record<string, unknown>).window = undefined;
    }
  });
});
