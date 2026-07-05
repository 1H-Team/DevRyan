import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  isDesktopShell,
  isElectronShell,
  requestDirectoryAccess,
  requestFileAccess,
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
});
