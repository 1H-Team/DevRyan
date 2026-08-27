import { describe, expect, it } from 'bun:test';

import {
  parseNativePointerSmokeArguments,
  packagedDevRyanBinaryCandidates,
  screenPointForCssRect,
} from './bot-catalog-native-pointer-smoke.mjs';

describe('Bot Catalog native pointer smoke helpers', () => {
  it('uses an isolated agent-test config and deterministic argument validation', () => {
    const defaults = parseNativePointerSmokeArguments([], {
      homeDirectory: '/Users/tester',
      outputDirectory: '/tmp/native-pointer-output',
    });
    expect(defaults).toEqual({
      outputDirectory: '/tmp/native-pointer-output',
      supabaseConfig: '/Users/tester/.config/openchamber/supabase.json',
      electronBinary: null,
      electronMode: 'raw',
      timeoutMs: 60_000,
    });

    expect(() => parseNativePointerSmokeArguments(['--timeout-ms', '0'])).toThrow(
      '--timeout-ms must be a positive integer',
    );
    expect(() => parseNativePointerSmokeArguments(['--unknown', 'value'])).toThrow(
      'Unknown native pointer smoke flag',
    );
    expect(() => parseNativePointerSmokeArguments(['--electron-mode', 'other'])).toThrow(
      'raw or packaged',
    );
  });

  it('finds only packaged DevRyan application binaries', () => {
    const candidates = packagedDevRyanBinaryCandidates({ platform: 'darwin', arch: 'arm64' });
    expect(candidates.some((candidate) => candidate.endsWith(
      'dist/mac-arm64/DevRyan.app/Contents/MacOS/DevRyan',
    ))).toBe(true);
    expect(candidates.some((candidate) => candidate.endsWith('/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))).toBe(false);
  });

  it('targets the center of the live DOM button in macOS screen coordinates', () => {
    expect(screenPointForCssRect({
      screenX: 100,
      screenY: 50,
      rect: { left: 24, top: 18, width: 36, height: 36 },
    })).toEqual({ x: 142, y: 86 });
    expect(() => screenPointForCssRect({
      screenX: 0,
      screenY: 0,
      rect: { left: 0, top: 0, width: 0, height: 36 },
    })).toThrow('valid screen coordinates');
  });
});
