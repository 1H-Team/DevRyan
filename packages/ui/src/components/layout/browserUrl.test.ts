import { describe, expect, test } from 'bun:test';

import {
  formatBrowserAddress,
  isLocalDevServerHost,
  normalizeBrowserUrl,
  reconcileWebBrowserDisplayUrl,
  sanitizeWebBrowserDisplayUrl,
} from './browserUrl';

describe('formatBrowserAddress', () => {
  test('hides the internal blank-page URL', () => {
    expect(formatBrowserAddress('')).toBe('');
    expect(formatBrowserAddress('about:blank')).toBe('');
  });

  test('keeps real browser URLs visible', () => {
    expect(formatBrowserAddress('https://example.com/docs')).toBe('https://example.com/docs');
    expect(formatBrowserAddress('http://localhost:3000/')).toBe('http://localhost:3000/');
  });
});

describe('normalizeBrowserUrl', () => {
  test('maps empty and about:blank input to about:blank', () => {
    expect(normalizeBrowserUrl('')).toBe('about:blank');
    expect(normalizeBrowserUrl('   ')).toBe('about:blank');
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
  });

  test('keeps explicit http and https URLs', () => {
    expect(normalizeBrowserUrl('https://example.com/docs?a=1#b')).toBe('https://example.com/docs?a=1#b');
    expect(normalizeBrowserUrl('http://localhost:3000/app')).toBe('http://localhost:3000/app');
  });

  test('refuses non-http(s) protocols', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBe('about:blank');
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBe('about:blank');
    expect(normalizeBrowserUrl('mailto:user@example.com')).toBe('about:blank');
    expect(normalizeBrowserUrl('chrome://settings')).toBe('about:blank');
    expect(normalizeBrowserUrl('about:config')).toBe('about:blank');
  });

  test('defaults schemeless local development hosts to HTTP', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('localhost:3000/app?x=1')).toBe('http://localhost:3000/app?x=1');
    expect(normalizeBrowserUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(normalizeBrowserUrl('app.localhost:8080')).toBe('http://app.localhost:8080/');
    expect(normalizeBrowserUrl('mymac.local:9000')).toBe('http://mymac.local:9000/');
  });

  test('defaults schemeless public hosts to HTTPS', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('example.com:8443/path')).toBe('https://example.com:8443/path');
    expect(normalizeBrowserUrl('sub.domain.dev/docs')).toBe('https://sub.domain.dev/docs');
  });

  test('collapses garbage to about:blank', () => {
    expect(normalizeBrowserUrl('http://')).toBe('about:blank');
    expect(normalizeBrowserUrl('://nope')).toBe('about:blank');
  });
});

describe('isLocalDevServerHost', () => {
  test('recognizes loopback and local-dev hostnames', () => {
    expect(isLocalDevServerHost('localhost')).toBe(true);
    expect(isLocalDevServerHost('127.0.0.1')).toBe(true);
    expect(isLocalDevServerHost('127.42.0.7')).toBe(true);
    expect(isLocalDevServerHost('[::1]')).toBe(true);
    expect(isLocalDevServerHost('0.0.0.0')).toBe(true);
    expect(isLocalDevServerHost('app.localhost')).toBe(true);
    expect(isLocalDevServerHost('workstation.local')).toBe(true);
  });

  test('rejects public hosts', () => {
    expect(isLocalDevServerHost('example.com')).toBe(false);
    expect(isLocalDevServerHost('localhost.evil.com')).toBe(false);
    expect(isLocalDevServerHost('')).toBe(false);
  });
});

describe('standalone web Browser display URLs', () => {
  test('never presents internal reload parameters', () => {
    expect(sanitizeWebBrowserDisplayUrl(
      'http://localhost:4173/docs?viewer=admin&ocPreview=2&ocBrowser=1#intro',
    )).toBe('http://localhost:4173/docs?viewer=admin#intro');
  });

  test('preserves the user-entered loopback hostname when the proxy reports its canonical origin', () => {
    expect(reconcileWebBrowserDisplayUrl(
      'http://127.0.0.1:4173/page-two?tab=logs',
      'http://localhost:4173/',
    )).toBe('http://localhost:4173/page-two?tab=logs');
  });

  test('does not merge different ports or public origins', () => {
    expect(reconcileWebBrowserDisplayUrl(
      'http://127.0.0.1:5000/page-two',
      'http://localhost:4173/',
    )).toBe('http://127.0.0.1:5000/page-two');
    expect(reconcileWebBrowserDisplayUrl(
      'https://example.net/page-two',
      'https://example.com/',
    )).toBe('https://example.net/page-two');
  });
});
