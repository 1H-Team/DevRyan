import { describe, expect, test } from 'bun:test';

import { shouldShowSidebarFileRowActions } from './sidebarFilesTreeRuntime';

describe('shouldShowSidebarFileRowActions', () => {
  test('hides row actions in the browser runtime', () => {
    expect(shouldShowSidebarFileRowActions({
      platform: 'web',
      isDesktop: false,

    })).toBe(false);
  });

  test('keeps row actions in the desktop runtime', () => {
    expect(shouldShowSidebarFileRowActions({
      platform: 'desktop',
      isDesktop: true,

    })).toBe(true);
  });

});
