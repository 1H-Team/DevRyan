import { describe, expect, test } from 'bun:test';

import {
  BROWSER_PRIMARY_RESERVE_PX,
  getBrowserSidebarFit,
  resolveBrowserPanelWidth,
} from './browserPanelLayout';

describe('Browser panel workspace allocation', () => {
  test('preserves the primary workspace in the attached 1632px layout', () => {
    const workspace = 1632 - 318 - 300;
    expect(resolveBrowserPanelWidth({ preferredWidth: 750, availableWidth: workspace })).toBe(694);
    expect(workspace - 694).toBe(BROWSER_PRIMARY_RESERVE_PX);
  });

  test('accounts for an open context panel', () => {
    const workspaceAfterContext = 1280 - 220 - 360;
    expect(resolveBrowserPanelWidth({ preferredWidth: 600, availableWidth: workspaceAfterContext })).toBe(380);
  });

  test('uses a 45/55 split when the normal minimums cannot fit', () => {
    expect(resolveBrowserPanelWidth({ preferredWidth: 600, availableWidth: 580 })).toBe(261);
    expect(resolveBrowserPanelWidth({ preferredWidth: 600, availableWidth: 300 })).toBe(135);
  });

  test('expanded mode fills the available workspace', () => {
    expect(resolveBrowserPanelWidth({ preferredWidth: 600, availableWidth: 915, expanded: true })).toBe(915);
  });

  test('requires an 80px buffer before restoring the right sidebar', () => {
    const base = {
      leftSidebarWidth: 220,
      rightSidebarWidth: 300,
      contextPanelWidth: 0,
      browserPreferredWidth: 600,
    };
    expect(getBrowserSidebarFit({ ...base, windowWidth: 1440 })).toEqual({
      fits: true,
      fitsWithRestoreBuffer: false,
    });
    expect(getBrowserSidebarFit({ ...base, windowWidth: 1520 }).fitsWithRestoreBuffer).toBe(true);
  });
});
