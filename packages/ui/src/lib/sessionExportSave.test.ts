import { describe, expect, mock, test } from 'bun:test';
import {
  saveSessionExportMarkdown,
  saveWithBrowserFilePicker,
} from './sessionExportSave';

const unavailableDesktop = mock(async () => ({ status: 'unavailable' as const }));

const captureError = async (operation: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

describe('saveSessionExportMarkdown', () => {
  test('returns a confirmed desktop save without trying another runtime', async () => {
    let fetchCount = 0;
    let pickerCount = 0;
    let downloadCount = 0;

    const result = await saveSessionExportMarkdown('# Chat', 'chat.md', {
      saveDesktop: mock(async () => ({ status: 'saved' as const, path: '/tmp/chat.md' })),

      fetchRequest: async () => {
        fetchCount += 1;
        return new Response();
      },
      pickBrowserFile: async () => {
        pickerCount += 1;
        return { status: 'saved' as const };
      },
      download: () => {
        downloadCount += 1;
      },
    });

    expect(result).toEqual({ status: 'saved', path: '/tmp/chat.md' });
    expect(fetchCount).toBe(0);
    expect(pickerCount).toBe(0);
    expect(downloadCount).toBe(0);
  });

  test('stops after native desktop cancellation', async () => {
    let fetchCount = 0;
    let pickerCount = 0;
    let downloadCount = 0;

    const result = await saveSessionExportMarkdown('# Chat', 'chat.md', {
      saveDesktop: mock(async () => ({ status: 'canceled' as const })),

      fetchRequest: async () => {
        fetchCount += 1;
        return new Response();
      },
      pickBrowserFile: async () => {
        pickerCount += 1;
        return { status: 'saved' as const };
      },
      download: () => {
        downloadCount += 1;
      },
    });

    expect(result).toEqual({ status: 'canceled' });
    expect(fetchCount).toBe(0);
    expect(pickerCount).toBe(0);
    expect(downloadCount).toBe(0);
  });

  test('returns browser picker cancellation without downloading', async () => {
    let downloadCount = 0;
    const result = await saveSessionExportMarkdown('# Chat', 'chat.md', {
      saveDesktop: unavailableDesktop,

      pickBrowserFile: mock(async () => ({ status: 'canceled' as const })),
      download: () => {
        downloadCount += 1;
      },
    });

    expect(result).toEqual({ status: 'canceled' });
    expect(downloadCount).toBe(0);
  });

  test('downloads only when the browser picker is unavailable', async () => {
    const downloads: Array<[string, string]> = [];
    const result = await saveSessionExportMarkdown('# Chat', 'chat.md', {
      saveDesktop: unavailableDesktop,

      pickBrowserFile: mock(async () => ({ status: 'unavailable' as const })),
      download: (content, filename) => {
        downloads.push([content, filename]);
      },
    });

    expect(result).toEqual({ status: 'downloaded', filename: 'chat.md' });
    expect(downloads).toEqual([['# Chat', 'chat.md']]);
  });
});

describe('saveWithBrowserFilePicker', () => {
  test('writes and closes the selected browser file', async () => {
    const writes: string[] = [];
    let closeCount = 0;
    let pickerOptions: unknown;
    const showSaveFilePicker = async (options: unknown) => {
      pickerOptions = options;
      return {
        createWritable: async () => ({
          write: async (content: string) => {
            writes.push(content);
          },
          close: async () => {
            closeCount += 1;
          },
        }),
      };
    };

    const result = await saveWithBrowserFilePicker('# Chat', 'chat.md', { showSaveFilePicker });

    expect(result).toEqual({ status: 'saved' });
    expect(pickerOptions).toEqual({
      suggestedName: 'chat.md',
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md'] },
      }],
    });
    expect(writes).toEqual(['# Chat']);
    expect(closeCount).toBe(1);
  });

  test('treats browser picker AbortError as cancellation', async () => {
    const showSaveFilePicker = mock(async () => {
      throw new DOMException('Canceled', 'AbortError');
    });

    expect(await saveWithBrowserFilePicker('# Chat', 'chat.md', { showSaveFilePicker }))
      .toEqual({ status: 'canceled' });
  });

  test('propagates browser write failures', async () => {
    const showSaveFilePicker = mock(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new Error('disk full');
        },
        close: async () => {},
      }),
    }));

    const error = await captureError(() => saveWithBrowserFilePicker('# Chat', 'chat.md', { showSaveFilePicker }));
    expect(error?.message).toContain('disk full');
  });

  test('reports browsers without a save picker as unavailable', async () => {
    expect(await saveWithBrowserFilePicker('# Chat', 'chat.md', {}))
      .toEqual({ status: 'unavailable' });
  });

  test('opens the picker before asynchronous export content is ready', async () => {
    let resolveContent: ((content: string) => void) | undefined;
    const content = new Promise<string>((resolve) => {
      resolveContent = resolve;
    });
    const writes: string[] = [];
    let pickerCount = 0;
    const showSaveFilePicker = async () => {
      pickerCount += 1;
      return {
        createWritable: async () => ({
          write: async (value: string) => {
            writes.push(value);
          },
          close: async () => {},
        }),
      };
    };

    const savePromise = saveWithBrowserFilePicker(content, 'chat.md', { showSaveFilePicker });
    await Promise.resolve();

    expect(pickerCount).toBe(1);
    expect(writes).toEqual([]);

    resolveContent?.('# Hydrated chat');
    expect(await savePromise).toEqual({ status: 'saved' });
    expect(writes).toEqual(['# Hydrated chat']);
  });
});
