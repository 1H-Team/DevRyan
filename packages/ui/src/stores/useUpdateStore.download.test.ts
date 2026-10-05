import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DesktopUpdateDownloadResult, UpdateInfo } from '@/lib/desktop';

let downloadResult: DesktopUpdateDownloadResult | Error = 'downloaded';
const toasts: Array<{ message: string; description?: string }> = [];
const desktopInfo: UpdateInfo = { available: true, currentVersion: '2.0.1', version: '2.0.2' };

const ui = await import('@/components/ui');
mock.module('@/components/ui', () => ({
  ...ui,
  toast: { ...ui.toast, success: (message: string, options?: { description?: string }) => { toasts.push({ message, description: options?.description }); } },
}));
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktop,
  checkForDesktopUpdates: async () => desktopInfo,
  downloadDesktopUpdate: async () => {
    if (downloadResult instanceof Error) throw downloadResult;
    return downloadResult;
  },
  restartToApplyUpdate: async () => true,
  isDesktopLocalOriginActive: () => true,
  isElectronShell: () => true,
  isTauriShell: () => true,
  isWebRuntime: () => false,
}));

const { useUpdateStore } = await import('./useUpdateStore');

const download = async (result: DesktopUpdateDownloadResult | Error) => {
  downloadResult = result;
  useUpdateStore.setState({ available: true, runtimeType: 'desktop', info: desktopInfo, downloaded: false, error: null });
  await useUpdateStore.getState().downloadUpdate();
  return useUpdateStore.getState();
};

describe('desktop update download outcome', () => {
  beforeEach(() => { toasts.length = 0; });

  test('an externally opened installer or release page is reported without an error or restart prompt', async () => {
    for (const [result, message] of [
      ['installer', 'Opened the DevRyan installer download in your browser'],
      ['release-page', 'Opened the DevRyan release page in your browser'],
    ] as const) {
      toasts.length = 0;
      expect(await download(result)).toMatchObject({ downloading: false, downloaded: false, error: null });
      expect(toasts.map((entry) => entry.message)).toEqual([message]);
      expect(toasts[0]?.description?.startsWith('The background runtime was stopped for the update. ')).toBe(true);
      expect(toasts[0]?.description?.endsWith(', then quit DevRyan before replacing it in Applications.')).toBe(true);
    }
  });

  test('an in-app download still offers the restart', async () => {
    expect(await download('downloaded')).toMatchObject({ downloading: false, downloaded: true, error: null });
    expect(toasts).toEqual([]);
  });

  test('the main-process failure reaches the user instead of the Local-instance message', async () => {
    const state = await download(new Error('DevRyan 2.0.2 has no verified installer download yet. Retry later.'));
    expect(state.error).toBe('DevRyan 2.0.2 has no verified installer download yet. Retry later.');
    expect((await download('unavailable')).error).toBe('Desktop update only works on Local instance');
  });
});
