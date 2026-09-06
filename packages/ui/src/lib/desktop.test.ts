import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  clearDesktopCache,
  getDesktopCacheInfo,
  isDesktopShell,
  isElectronShell,
  requestDirectoryAccess,
  requestFileAccess,
  saveDesktopMarkdownFile,
  setDesktopKeepAwake,
} from './desktop';

type TestWindow = Window & typeof globalThis & {
  __OPENCHAMBER_ELECTRON__?: { runtime: string };
  __OPENCHAMBER_LOCAL_ORIGIN__?: string;
  __TAURI__?: {
    core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    dialog?: { open?: (options: Record<string, unknown>) => Promise<unknown> };
  };
};

const installWindow = (windowShape: Partial<TestWindow>) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { origin: 'http://127.0.0.1:3001' },
      ...windowShape,
    } as TestWindow,
  });
};

describe('desktop access helpers', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('does not open native directory dialogs for Electron shim access', async () => {
    const dialogCalls: Record<string, unknown>[] = [];
    const dialogOpen = mock(async (options: Record<string, unknown>) => {
      dialogCalls.push(options);
      return '/Users/dev/Selected';
    });
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: { invoke: mock(async () => null) },
        dialog: { open: dialogOpen },
      },
    });

    expect(isElectronShell()).toBe(true);
    expect(isDesktopShell()).toBe(true);

    const result = await requestDirectoryAccess('/tmp/outside-project');

    expect(result).toEqual({ success: true, path: '/tmp/outside-project' });
    expect(dialogCalls).toEqual([]);
  });

  test('keeps legacy Tauri directory access on the native picker path', async () => {
    const dialogCalls: Record<string, unknown>[] = [];
    const dialogOpen = mock(async (options: Record<string, unknown>) => {
      dialogCalls.push(options);
      return '/Users/dev/Selected';
    });
    installWindow({
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: { invoke: mock(async () => null) },
        dialog: { open: dialogOpen },
      },
    });

    expect(isElectronShell()).toBe(false);
    expect(isDesktopShell()).toBe(true);

    const result = await requestDirectoryAccess('/Users/dev/Documents');

    expect(result).toEqual({ success: true, path: '/Users/dev/Selected' });
    expect(dialogCalls).toEqual([{
      directory: true,
      multiple: false,
      title: 'Select Working Directory',
    }]);
  });

  test('keeps legacy Tauri file access on the native picker path', async () => {
    const dialogCalls: Record<string, unknown>[] = [];
    const dialogOpen = mock(async (options: Record<string, unknown>) => {
      dialogCalls.push(options);
      return '/Users/dev/file.txt';
    });
    installWindow({
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: { invoke: mock(async () => null) },
        dialog: { open: dialogOpen },
      },
    });

    const filters = [{ name: 'Text', extensions: ['txt'] }];
    const result = await requestFileAccess({ filters });

    expect(result).toEqual({ success: true, path: '/Users/dev/file.txt' });
    expect(dialogCalls).toEqual([{
      directory: false,
      multiple: false,
      title: 'Select File',
      filters,
    }]);
  });

  test('applies Electron keep awake through desktop IPC on the local origin', async () => {
    const invocations: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            return { enabled: true, active: true };
          }),
        },
      },
    });

    const result = await setDesktopKeepAwake(true);

    expect(result).toEqual({ enabled: true, active: true });
    expect(invocations).toEqual([
      { cmd: 'desktop_set_keep_awake', args: { enabled: true } },
    ]);
  });

  test('reads and clears the Electron cache through local desktop IPC', async () => {
    const invocations: string[] = [];
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async (cmd: string) => {
            invocations.push(cmd);
            return cmd === 'desktop_get_cache_info'
              ? { sizeBytes: 4_096 }
              : { sizeBytes: 0 };
          }),
        },
      },
    });

    expect(await getDesktopCacheInfo()).toEqual({ sizeBytes: 4_096 });
    expect(await clearDesktopCache()).toEqual({ sizeBytes: 0 });
    expect(invocations).toEqual(['desktop_get_cache_info', 'desktop_clear_cache']);
  });

  test('does not expose Electron cache IPC to web, legacy Tauri, or remote pages', async () => {
    let invokeCount = 0;
    const invoke = mock(async () => {
      invokeCount += 1;
      return { sizeBytes: 1_024 };
    });

    installWindow({
      __TAURI__: { core: { invoke } },
    });
    expect(await getDesktopCacheInfo()).toBeNull();

    installWindow({});
    expect(await clearDesktopCache()).toBeNull();

    installWindow({
      location: { origin: 'https://remote.example.com' } as Location,
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: { core: { invoke } },
    });
    expect(await clearDesktopCache()).toBeNull();
    expect(invokeCount).toBe(0);
  });

  test('rejects malformed Electron cache responses', async () => {
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: { invoke: mock(async () => ({ sizeBytes: -1 })) },
      },
    });

    let thrown: unknown;
    try {
      await getDesktopCacheInfo();
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).message).toContain('invalid cache size');
  });

  test('reports the selected desktop export path as saved', async () => {
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async () => '/Users/dev/Exports/chat.md'),
        },
      },
    });

    expect(await saveDesktopMarkdownFile('chat.md', '# Chat')).toEqual({
      status: 'saved',
      path: '/Users/dev/Exports/chat.md',
    });
  });

  test('reports native desktop export cancellation without falling back', async () => {
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async () => null),
        },
      },
    });

    expect(await saveDesktopMarkdownFile('chat.md', '# Chat')).toEqual({
      status: 'canceled',
    });
  });

  test('reports desktop export as unavailable outside a local desktop origin', async () => {
    installWindow({
      location: { origin: 'https://remote.example.com' } as Location,
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async () => '/should/not/be/used.md'),
        },
      },
    });

    expect(await saveDesktopMarkdownFile('chat.md', '# Chat')).toEqual({
      status: 'unavailable',
    });
  });

  test('reports desktop export as unavailable when the native save API is missing', async () => {
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: { core: {} },
    });

    expect(await saveDesktopMarkdownFile('chat.md', '# Chat')).toEqual({
      status: 'unavailable',
    });
  });

  test('does not convert desktop export IPC failures into cancellation', async () => {
    installWindow({
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: {
        core: {
          invoke: mock(async () => {
            throw new Error('dialog failed');
          }),
        },
      },
    });

    let thrown: unknown;
    try {
      await saveDesktopMarkdownFile('chat.md', '# Chat');
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).message).toContain('dialog failed');
  });
});
