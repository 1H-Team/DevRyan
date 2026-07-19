import { describe, expect, test } from 'bun:test';

import {
  buildPreviewFrameKey,
  parsePreviewHttpUrl,
  resolvePreviewReloadUrl,
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
});
