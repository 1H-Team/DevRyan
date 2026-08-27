import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { packagedVisualShellCandidates } from './package-production-bots-visual-shell.mjs';

describe('Production Bots packaged visual shell', () => {
  test('resolves only the dedicated test application on macOS', () => {
    const candidates = packagedVisualShellCandidates({
      platform: 'darwin',
      arch: 'arm64',
      root: '/tmp/visual-shell',
    });
    assert.deepEqual(candidates, [
      '/tmp/visual-shell/mac-arm64/DevRyan Production Bots Visual Fixture.app/Contents/MacOS/DevRyan Production Bots Visual Fixture',
      '/tmp/visual-shell/mac/DevRyan Production Bots Visual Fixture.app/Contents/MacOS/DevRyan Production Bots Visual Fixture',
    ]);
    assert.equal(candidates.some((candidate) => candidate.includes('/packages/electron/dist/')), false);
  });

  test('uses unpacked test-only targets on Linux and Windows', () => {
    assert.deepEqual(packagedVisualShellCandidates({
      platform: 'linux',
      arch: 'x64',
      root: '/tmp/visual-shell',
    }), ['/tmp/visual-shell/linux-unpacked/DevRyan Production Bots Visual Fixture']);
    assert.deepEqual(packagedVisualShellCandidates({
      platform: 'win32',
      arch: 'x64',
      root: 'C:/visual-shell',
    }), ['C:/visual-shell/win-unpacked/DevRyan Production Bots Visual Fixture.exe']);
  });
});
