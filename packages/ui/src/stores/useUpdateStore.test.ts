import { describe, expect, test } from 'bun:test';
import type { UpdateInfo } from '@/lib/desktop';
import { resolveDesktopUpdateState } from './useUpdateStore';

const updateInfo = (overrides: Partial<UpdateInfo>): UpdateInfo => ({
  available: false,
  currentVersion: '1.0.0',
  ...overrides,
});

describe('desktop update source of truth', () => {
  test('does not let the legacy server override the native GitHub updater result', () => {
    const desktopInfo = updateInfo({
      available: false,
      version: '1.0.0',
      body: 'DevRyan release notes',
    });
    const sidecarInfo = updateInfo({
      available: true,
      version: '9.9.9',
      body: 'Legacy OpenChamber release notes',
      nextSuggestedCheckInSec: 3_600,
    });

    expect(resolveDesktopUpdateState(desktopInfo, sidecarInfo)).toEqual({
      available: false,
      info: desktopInfo,
      nextCheckInSec: 3_600,
    });
  });

  test('keeps a native DevRyan update available when the server reports no update', () => {
    const desktopInfo = updateInfo({
      available: true,
      version: '1.1.0',
      body: 'DevRyan 1.1.0',
    });
    const sidecarInfo = updateInfo({
      available: false,
      nextSuggestedCheckInSec: 7_200,
    });

    expect(resolveDesktopUpdateState(desktopInfo, sidecarInfo)).toEqual({
      available: true,
      info: desktopInfo,
      nextCheckInSec: 7_200,
    });
  });
});
