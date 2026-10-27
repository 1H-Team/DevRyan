import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { invalidateSettingsCache, syncDesktopSettings } from './persistence';

const globals = globalThis as unknown as Record<string, unknown>;
type Saved = Record<'window' | 'fetch', PropertyDescriptor | undefined>;
let saved: Saved;
let initialShowDeletionDialog: boolean;

const serveSettings = (payload: unknown) => {
  globals.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  invalidateSettingsCache();
};

beforeEach(() => {
  saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  };
  const events = new EventTarget();
  globals.window = Object.assign(events, { localStorage: undefined });
  initialShowDeletionDialog = useUIStore.getState().showDeletionDialog;
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  useUIStore.getState().setShowDeletionDialog(initialShowDeletionDialog);
  invalidateSettingsCache();
});

describe('desktop deletion-dialog preference hydration', () => {
  test('applies a saved "off" preference to the UI store', async () => {
    useUIStore.getState().setShowDeletionDialog(true);
    serveSettings({ showDeletionDialog: false });

    await syncDesktopSettings();

    expect(useUIStore.getState().showDeletionDialog).toBe(false);
  });

  test('applies a saved "on" preference to the UI store', async () => {
    useUIStore.getState().setShowDeletionDialog(false);
    serveSettings({ showDeletionDialog: true });

    await syncDesktopSettings();

    expect(useUIStore.getState().showDeletionDialog).toBe(true);
  });

  test('ignores a non-boolean saved preference instead of coercing it', async () => {
    useUIStore.getState().setShowDeletionDialog(true);
    serveSettings({ showDeletionDialog: 'false' });

    await syncDesktopSettings();

    expect(useUIStore.getState().showDeletionDialog).toBe(true);
  });
});
