import { describe, expect, test } from 'bun:test';

import {
  BROWSER_WEBVIEW_PARTITION,
  hardenWebviewAttachParams,
  isAllowedWebviewNavigationUrl,
  isAllowedWebviewSourceUrl,
} from '../browser-webview-policy.mjs';

describe('isAllowedWebviewSourceUrl', () => {
  test('allows about:blank, empty, and http(s)', () => {
    expect(isAllowedWebviewSourceUrl('')).toBe(true);
    expect(isAllowedWebviewSourceUrl(undefined)).toBe(true);
    expect(isAllowedWebviewSourceUrl('about:blank')).toBe(true);
    expect(isAllowedWebviewSourceUrl('http://localhost:3000/')).toBe(true);
    expect(isAllowedWebviewSourceUrl('https://example.com/page')).toBe(true);
  });

  test('rejects every other protocol and unparseable input', () => {
    expect(isAllowedWebviewSourceUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedWebviewSourceUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWebviewSourceUrl('chrome://gpu')).toBe(false);
    expect(isAllowedWebviewSourceUrl('about:config')).toBe(false);
    expect(isAllowedWebviewSourceUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isAllowedWebviewSourceUrl('not a url')).toBe(false);
  });

  test('navigation allowlist matches the source allowlist', () => {
    expect(isAllowedWebviewNavigationUrl('https://example.com/')).toBe(true);
    expect(isAllowedWebviewNavigationUrl('file:///tmp/x')).toBe(false);
  });
});

describe('hardenWebviewAttachParams', () => {
  test('strips the preload and forces an isolated sandboxed guest', () => {
    const webPreferences = {
      preload: '/app/preload.mjs',
      preloadURL: 'file:///app/preload.mjs',
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'ShadowDOMV0',
      webviewTag: true,
    };
    const params = { preload: '/app/preload.mjs', partition: 'persist:evil', src: 'https://example.com/' };

    hardenWebviewAttachParams(webPreferences, params);

    expect('preload' in webPreferences).toBe(false);
    expect('preloadURL' in webPreferences).toBe(false);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.webSecurity).toBe(true);
    expect(webPreferences.allowRunningInsecureContent).toBe(false);
    expect(webPreferences.experimentalFeatures).toBe(false);
    expect(webPreferences.enableBlinkFeatures).toBe('');
    expect(webPreferences.webviewTag).toBe(false);
    expect(webPreferences.backgroundThrottling).toBe(true);
    expect('preload' in params).toBe(false);
    expect(params.partition).toBe(BROWSER_WEBVIEW_PARTITION);
    expect(params.src).toBe('https://example.com/');
  });

  test('rewrites a disallowed src to about:blank and pins the partition', () => {
    const params = { src: 'file:///etc/passwd' };
    hardenWebviewAttachParams({}, params);
    expect(params.src).toBe('about:blank');
    expect(params.partition).toBe(BROWSER_WEBVIEW_PARTITION);
  });

  test('tolerates missing inputs', () => {
    const result = hardenWebviewAttachParams(undefined, undefined);
    expect(result.webPreferences.sandbox).toBe(true);
    expect(result.params.partition).toBe(BROWSER_WEBVIEW_PARTITION);
  });
});
