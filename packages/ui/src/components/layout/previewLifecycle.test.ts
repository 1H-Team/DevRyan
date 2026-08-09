import { describe, expect, test } from 'bun:test';

import {
  buildPreviewFrameKey,
  isBrowserHostRoutedUrl,
  parsePreviewHttpUrl,
  resolvePreviewReloadUrl,
  shouldRestorePreviewProxyPath,
} from './previewLifecycle';

describe('preview lifecycle', () => {
  test('keeps frame identity independent from in-frame display navigation', () => {
    const key = buildPreviewFrameKey('preview-tab', 'http://127.0.0.1:3000/', 0);
    const displayRoutes = ['/one', '/two', '/three'];

    expect(new Set(displayRoutes.map(() => key)).size).toBe(1);
    expect(buildPreviewFrameKey('preview-tab', 'http://127.0.0.1:3000/', 1)).not.toBe(key);
    expect(buildPreviewFrameKey('preview-tab', 'http://127.0.0.1:4000/', 0)).not.toBe(key);
  });

  test('reloads the current route only when it belongs to the registered target origin', () => {
    expect(resolvePreviewReloadUrl(
      'http://localhost:3000/',
      'http://127.0.0.1:3000/docs?tab=api#example',
    )?.toString()).toBe('http://127.0.0.1:3000/docs?tab=api#example');

    expect(resolvePreviewReloadUrl(
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:4000/other',
    )?.toString()).toBe('http://127.0.0.1:3000/');
  });

  test('accepts only HTTP targets and normalizes common loopback aliases', () => {
    expect(parsePreviewHttpUrl('file:///tmp/index.html')).toBeNull();
    expect(parsePreviewHttpUrl('not a URL')).toBeNull();
    expect(parsePreviewHttpUrl('http://0.0.0.0:4173/path')?.hostname).toBe('127.0.0.1');
  });

  test('routes only loopback project URLs through the DevRyan host', () => {
    expect(isBrowserHostRoutedUrl('http://localhost:4173/app')).toBe(true);
    expect(isBrowserHostRoutedUrl('https://127.0.0.1:8443/app')).toBe(true);
    expect(isBrowserHostRoutedUrl('https://example.com/')).toBe(false);
    expect(isBrowserHostRoutedUrl('http://192.168.1.20/')).toBe(false);
    expect(isBrowserHostRoutedUrl('file:///tmp/app.html')).toBe(false);
  });

  test('keeps a bridge-virtualized target route inside the existing iframe document', () => {
    expect(shouldRestorePreviewProxyPath({
      frameOrigin: 'http://127.0.0.1:3101',
      parentOrigin: 'http://127.0.0.1:3101',
      framePathname: '/ar/',
      proxyBasePath: '/api/preview/proxy/0123456789abcdef',
      bridgeInstalled: true,
    })).toBe(false);
  });

  test('restores an unbridged same-origin navigation that escaped the preview proxy', () => {
    expect(shouldRestorePreviewProxyPath({
      frameOrigin: 'http://127.0.0.1:3101',
      parentOrigin: 'http://127.0.0.1:3101',
      framePathname: '/ar/',
      proxyBasePath: '/api/preview/proxy/0123456789abcdef',
      bridgeInstalled: false,
    })).toBe(true);

    expect(shouldRestorePreviewProxyPath({
      frameOrigin: 'http://127.0.0.1:3101',
      parentOrigin: 'http://127.0.0.1:3101',
      framePathname: '/api/preview/proxy/0123456789abcdef/ar/',
      proxyBasePath: '/api/preview/proxy/0123456789abcdef',
      bridgeInstalled: false,
    })).toBe(false);
  });
});
