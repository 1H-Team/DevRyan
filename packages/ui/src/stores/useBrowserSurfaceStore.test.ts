import { beforeEach, describe, expect, test } from 'bun:test';

import {
  sanitizeBrowserSurfaceSnapshot,
  useBrowserSurfaceStore,
} from './useBrowserSurfaceStore';

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  surfaceId: 'manual:1:1',
  kind: 'manual',
  workspaceId: 'browser-workspace:test',
  tabId: 'browser-tab:test',
  placement: 'inline',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: true,
  devToolsOpen: false,
  viewportMode: 'responsive',
  ...overrides,
});

describe('browser surface store', () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({
      byId: new Map(),
      surfaceIdByTabId: new Map(),
      poppedManualTabIds: [],
    });
  });

  test('accepts only the token-free snapshot shape', () => {
    expect(sanitizeBrowserSurfaceSnapshot(snapshot())).toEqual(snapshot());
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ placement: 'elsewhere' }))).toBeNull();
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ kind: 'unknown' }))).toBeNull();
    expect(sanitizeBrowserSurfaceSnapshot({ token: 'secret' })).toBeNull();
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ viewportMode: 'mobile' }))?.viewportMode).toBe('mobile');
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ viewportMode: 'unknown' }))?.viewportMode).toBe('responsive');
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ faviconUrl: 'https://example.com/favicon.ico' }))?.faviconUrl)
      .toBe('https://example.com/favicon.ico');
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ faviconUrl: 'javascript:alert(1)' }))?.faviconUrl)
      .toBe(undefined);
    expect(sanitizeBrowserSurfaceSnapshot(snapshot({ faviconUrl: 'data:image/png;base64,AAAA' }))?.faviconUrl)
      .toBe('data:image/png;base64,AAAA');
  });

  test('keeps a popped manual tab retained and clears it on dock or release', () => {
    useBrowserSurfaceStore.getState().applySnapshot(snapshot(), 'browser-tab');
    expect(useBrowserSurfaceStore.getState().poppedManualTabIds).toEqual([]);

    useBrowserSurfaceStore.getState().applySnapshot(snapshot({ placement: 'popout' }));
    expect(useBrowserSurfaceStore.getState().poppedManualTabIds).toEqual(['browser-tab']);

    useBrowserSurfaceStore.getState().applySnapshot(snapshot({ placement: 'inline' }));
    expect(useBrowserSurfaceStore.getState().poppedManualTabIds).toEqual([]);

    useBrowserSurfaceStore.getState().removeSurface('manual:1:1');
    expect(useBrowserSurfaceStore.getState().surfaceIdByTabId.size).toBe(0);
  });
});
