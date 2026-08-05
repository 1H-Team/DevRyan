import { describe, expect, test } from 'bun:test';
import { resolveVoiceModeEnabledPreference } from './voicePreferences';

describe('voice mode preference defaults', () => {
  test('defaults missing and invalid values to disabled', () => {
    expect(resolveVoiceModeEnabledPreference(null)).toBe(false);
    expect(resolveVoiceModeEnabledPreference('')).toBe(false);
    expect(resolveVoiceModeEnabledPreference('yes')).toBe(false);
  });

  test('preserves explicit enabled and disabled choices', () => {
    expect(resolveVoiceModeEnabledPreference('true')).toBe(true);
    expect(resolveVoiceModeEnabledPreference('false')).toBe(false);
  });
});
