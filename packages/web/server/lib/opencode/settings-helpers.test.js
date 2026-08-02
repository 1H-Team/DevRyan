import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';

const createTestHelpers = (overrides = {}) => createSettingsHelpers({
  normalizePathForPersistence: (value) => value,
  normalizeDirectoryPath: (value) => value,
  normalizeTunnelBootstrapTtlMs: (value) => value,
  normalizeTunnelSessionTtlMs: (value) => value,
  normalizeTunnelProvider: (value) => value,
  normalizeTunnelMode: (value) => value,
  normalizeOptionalPath: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: () => undefined,
  normalizeManagedRemoteTunnelPresetTokens: () => undefined,
  sanitizeTypographySizesPartial: () => undefined,
  normalizeStringArray: (input) => input,
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeHiddenSkills: (input) => Array.isArray(input) ? input : undefined,
  sanitizeProjects: () => undefined,
  ...overrides,
});

describe('settings helpers', () => {
  it('accepts a non-negative theme catalog version', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ themeCatalogVersion: 2 })).toEqual({
      themeCatalogVersion: 2,
    });
    expect(helpers.sanitizeSettingsUpdate({ themeCatalogVersion: -1 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ themeCatalogVersion: 2.5 })).toEqual({});
  });

  it('accepts messageStreamTransport as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'ws' })).toEqual({
      messageStreamTransport: 'ws',
    });
    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'sse' })).toEqual({
      messageStreamTransport: 'sse',
    });
    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'auto' })).toEqual({
      messageStreamTransport: 'auto',
    });
  });

  it('accepts rationale-depth presets while keeping legacy values readable', () => {
    const helpers = createTestHelpers();

    for (const responseStylePreset of [
      'actions',
      'concise',
      'detailed',
      'mentor',
      'pushback',
      'noFiller',
      'matchEnergy',
      'warmPeer',
      'custom',
    ]) {
      expect(helpers.sanitizeSettingsUpdate({ responseStylePreset })).toEqual({ responseStylePreset });
    }
    expect(helpers.sanitizeSettingsUpdate({ responseStylePreset: 'provider' })).toEqual({});
  });

  it('rejects invalid messageStreamTransport values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ messageStreamTransport: 'websocket' })).toEqual({});
  });

  it('accepts desktopLanAccessEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopLanAccessEnabled: true })).toEqual({
      desktopLanAccessEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopLanAccessEnabled: false })).toEqual({
      desktopLanAccessEnabled: false,
    });
  });

  it('accepts desktopKeepAwakeEnabled as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ desktopKeepAwakeEnabled: true })).toEqual({
      desktopKeepAwakeEnabled: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopKeepAwakeEnabled: false })).toEqual({
      desktopKeepAwakeEnabled: false,
    });
    expect(helpers.sanitizeSettingsUpdate({ desktopKeepAwakeEnabled: 'true' })).toEqual({});
  });

  it('sanitizes Plan Ready notification preferences and templates', () => {
    const helpers = createTestHelpers();
    const result = helpers.sanitizeSettingsUpdate({
      notifyOnPlanReady: false,
      notificationTemplates: {
        planReady: { title: 'Review plan', message: '{last_message}' },
        completion: { title: 123, message: 'invalid' },
        unknown: { title: 'Unknown', message: 'Unknown' },
      },
    });

    expect(result).toEqual({
      notifyOnPlanReady: false,
      notificationTemplates: {
        planReady: { title: 'Review plan', message: '{last_message}' },
      },
    });
    expect(helpers.sanitizeSettingsUpdate({ notifyOnPlanReady: 'false' })).toEqual({});
  });

  it('accepts hiddenSkills as a persisted shared setting', () => {
    const helpers = createTestHelpers();
    const hiddenSkills = [
      {
        name: 'lint-helper',
        path: '/Users/example/.config/opencode/skills/lint-helper/SKILL.md',
        scope: 'user',
        source: 'opencode',
      },
    ];

    expect(helpers.sanitizeSettingsUpdate({ hiddenSkills })).toEqual({
      hiddenSkills,
    });
  });

  it('accepts hiddenModels as a persisted shared setting', () => {
    const hiddenModels = [
      { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
      { providerID: 'openai', modelID: 'gpt-4o' },
    ];
    const calls = [];
    const helpers = createTestHelpers({
      sanitizeModelRefs: (input, limit) => {
        calls.push({ input, limit });
        return input === hiddenModels ? hiddenModels : undefined;
      },
    });

    expect(helpers.sanitizeSettingsUpdate({ hiddenModels })).toEqual({
      hiddenModels,
    });
    expect(calls).toContainEqual({ input: hiddenModels, limit: 64 });
  });

  it('accepts non-negative integer model preference timestamps', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      favoriteModelsUpdatedAt: 123,
      hiddenModelsUpdatedAt: 0,
    })).toEqual({
      favoriteModelsUpdatedAt: 123,
      hiddenModelsUpdatedAt: 0,
    });
  });

  it('rejects invalid model preference timestamps', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({
      favoriteModelsUpdatedAt: -1,
      hiddenModelsUpdatedAt: 1.5,
    })).toEqual({});
  });

  it('accepts defaultPlanMode as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ defaultPlanMode: true })).toEqual({
      defaultPlanMode: true,
    });
    expect(helpers.sanitizeSettingsUpdate({ defaultPlanMode: false })).toEqual({
      defaultPlanMode: false,
    });
    expect(helpers.sanitizeSettingsUpdate({ defaultPlanMode: 'true' })).toEqual({});
  });

  it('accepts mobileKeyboardMode as a persisted shared setting', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'native' })).toEqual({
      mobileKeyboardMode: 'native',
    });
    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'resize-content' })).toEqual({
      mobileKeyboardMode: 'resize-content',
    });
    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: ' resize-content ' })).toEqual({
      mobileKeyboardMode: 'resize-content',
    });
  });

  it('rejects invalid mobileKeyboardMode values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ mobileKeyboardMode: 'fixed-layout' })).toEqual({});
  });

  it('rejects removed local voice input provider values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ sttProvider: 'wasm' })).toEqual({});
  });
});
