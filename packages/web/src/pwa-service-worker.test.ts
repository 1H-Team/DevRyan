import { describe, expect, it } from 'vitest';

import {
  getPwaServiceWorkerStartupAction,
  isDesktopRuntimeWindow,
} from './pwa-service-worker';

describe('pwa service worker startup policy', () => {
  it('unregisters instead of registering service workers for packaged desktop runtime', () => {
    expect(getPwaServiceWorkerStartupAction({
      isProduction: true,
      isDesktopRuntime: true,
    })).toBe('unregister');
  });

  it('keeps production PWA registration enabled for browser runtime', () => {
    expect(getPwaServiceWorkerStartupAction({
      isProduction: true,
      isDesktopRuntime: false,
    })).toBe('register');
  });

  it('unregisters service workers in development runtime', () => {
    expect(getPwaServiceWorkerStartupAction({
      isProduction: false,
      isDesktopRuntime: false,
    })).toBe('unregister');
  });

  it('detects Electron desktop from the preload runtime globals', () => {
    expect(isDesktopRuntimeWindow({
      __OPENCHAMBER_DESKTOP_SERVER__: { origin: 'http://127.0.0.1:55676' },
    })).toBe(true);

    expect(isDesktopRuntimeWindow({
      __OPENCHAMBER_RUNTIME_APIS__: {
        runtime: { isDesktop: true },
      },
    })).toBe(true);

    expect(isDesktopRuntimeWindow({
      __OPENCHAMBER_RUNTIME_APIS__: {
        runtime: { isDesktop: false, },
      },
    })).toBe(false);
  });
});
