import { describe, expect, it } from 'vitest';

import {
  BOT_TARGET_OPENCODE_VERSION,
  TARGET_OPENCODE_VERSION,
  isNativeOpenCodeVersion,
  resolveQaTargetOpenCodeVersion,
} from './version-policy.js';

describe('OpenCode version policy', () => {
  it('pins the host and Bot runtime targets as exact release versions', () => {
    expect(TARGET_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BOT_TARGET_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('accepts any exact OpenCode 2.x release for native and retained bundles', () => {
    for (const version of ['2.0.20', '2.0.24', '2.0.26', '2.0.27', '2.1.0', TARGET_OPENCODE_VERSION]) {
      expect(isNativeOpenCodeVersion(version)).toBe(true);
    }
    for (const value of ['1.18.33', '3.0.0', '2.0', '2.0.26-devryan.1', 'v2.0.26', ' 2.0.26', '2.0.26 ', 'latest', null, undefined, 2]) {
      expect(isNativeOpenCodeVersion(value)).toBe(false);
    }
  });

  it('targets the host pin for QA unless a candidate version is named explicitly', () => {
    expect(resolveQaTargetOpenCodeVersion({})).toEqual({ version: TARGET_OPENCODE_VERSION, source: 'host-pin' });
    expect(resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '  ' })).toEqual({ version: TARGET_OPENCODE_VERSION, source: 'host-pin' });
    expect(resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '2.0.20' }))
      .toEqual({ version: '2.0.20', source: 'DEVRYAN_QA_OPENCODE_VERSION' });
    expect(resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: '2.0.20-beta.1' }))
      .toEqual({ version: '2.0.20-beta.1', source: 'DEVRYAN_QA_OPENCODE_VERSION' });
  });

  it('rejects ranges, tags and prefixed versions as QA targets', () => {
    for (const value of ['1.18.33', '3.0.0', 'latest', '^2.0.0', 'v2.0.20', '2.0', '2.0.20-devryan.1 x']) {
      expect(() => resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: value })).toThrow(/exact OpenCode version/);
    }
  });
});
