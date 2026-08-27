import { describe, expect, test } from 'bun:test';

import { importWithChunkRecovery } from './chunkLoadRecovery';

const rejectionMessage = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    await operation();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('importWithChunkRecovery', () => {
  test('recovers a corrupt marker, retries once, and reloads at most once for the same failure', async () => {
    const globalWithWindow = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWithWindow.window;
    let storedMarker: string | null = '{not json';
    let reloadCount = 0;
    let loadCount = 0;

    globalWithWindow.window = {
      sessionStorage: {
        getItem: () => storedMarker,
        setItem: (_key: string, value: string) => { storedMarker = value; },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      location: { reload: () => { reloadCount += 1; } },
    };

    const load = async () => {
      loadCount += 1;
      throw new Error('ChunkLoadError: Loading chunk settings failed');
    };
    try {
      expect(await rejectionMessage(() => importWithChunkRecovery(load))).toContain('ChunkLoadError');
      expect(await rejectionMessage(() => importWithChunkRecovery(load))).toContain('ChunkLoadError');
      expect(loadCount).toBe(4);
      expect(storedMarker).not.toBeNull();
      expect(reloadCount).toBe(1);
    } finally {
      if (previousWindow === undefined) delete globalWithWindow.window;
      else globalWithWindow.window = previousWindow;
    }
  });

  test('does not retry or reload ordinary import failures', async () => {
    let loadCount = 0;
    const message = await rejectionMessage(() => importWithChunkRecovery(async () => {
      loadCount += 1;
      throw new Error('module initialization failed');
    }));
    expect(message).toContain('module initialization failed');
    expect(loadCount).toBe(1);
  });

});
