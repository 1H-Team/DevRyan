import { describe, expect, it } from 'vitest';

import {
  BOT_TARGET_OPENCODE_VERSION,
  OPENCODE_TARGET_INSTALL_COMMAND,
  TARGET_OPENCODE_VERSION,
} from './version-policy.js';

describe('OpenCode version policy', () => {
  it('pins the host and Bot runtime targets as exact release versions', () => {
    expect(TARGET_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BOT_TARGET_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(OPENCODE_TARGET_INSTALL_COMMAND).toContain(`--version ${TARGET_OPENCODE_VERSION} `);
  });
});
