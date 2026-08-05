import { describe, expect, test } from 'bun:test';
import {
  getSelectableVoiceInputProviders,
  getVoiceInputSourceMode,
  normalizeVoiceInputProvider,
} from './voiceSettingsUtils';

describe('VoiceSettings input source behavior', () => {
  test('uses provider-specific input source modes', () => {
    expect(getVoiceInputSourceMode('browser')).toBe('fixed-default');
    expect(getVoiceInputSourceMode('server')).toBe('media-device');
    expect(getVoiceInputSourceMode('macos')).toBe('native-device');
    expect(getVoiceInputSourceMode('wasm')).toBe('media-device');
  });

  test('exposes the local input provider when its browser APIs are available', () => {
    expect(getSelectableVoiceInputProviders(true, true)).toEqual(['macos', 'browser', 'wasm', 'server']);
    expect(getSelectableVoiceInputProviders(false, true)).toEqual(['browser', 'wasm', 'server']);
    expect(getSelectableVoiceInputProviders(false, false)).toEqual(['browser', 'server']);
  });

  test('preserves local input when supported and normalizes unavailable providers', () => {
    expect(normalizeVoiceInputProvider('wasm', true, true)).toBe('wasm');
    expect(normalizeVoiceInputProvider('wasm', false, false)).toBe('browser');
    expect(normalizeVoiceInputProvider('macos', false, true)).toBe('browser');
    expect(normalizeVoiceInputProvider('server', true)).toBe('server');
  });
});
