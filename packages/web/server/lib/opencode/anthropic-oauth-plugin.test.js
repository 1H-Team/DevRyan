import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  isAnthropicOAuthPluginSpec,
  reconcileAnthropicOAuthPluginSpecs,
} from './anthropic-oauth-plugin.js';

describe('Anthropic OAuth plugin spec', () => {
  it('recognizes legacy package specs and installed local registrations', () => {
    expect(isAnthropicOAuthPluginSpec('opencode-with-claude')).toBe(true);
    expect(isAnthropicOAuthPluginSpec('opencode-with-claude@1.6.18')).toBe(true);
    expect(isAnthropicOAuthPluginSpec('./node_modules/opencode-with-claude/dist/index.js')).toBe(true);
    expect(isAnthropicOAuthPluginSpec('opencode-with-claude@')).toBe(false);
    expect(isAnthropicOAuthPluginSpec('opencode-with-claude-copy')).toBe(false);
  });

  it('migrates a legacy bare entry to the installed local entrypoint', () => {
    expect(reconcileAnthropicOAuthPluginSpecs(['custom', 'opencode-with-claude'])).toEqual([
      'custom',
      ANTHROPIC_OAUTH_PLUGIN_SPEC,
    ]);
  });

  it('preserves an explicit user pin and removes its bare duplicate', () => {
    expect(reconcileAnthropicOAuthPluginSpecs([
      'opencode-with-claude',
      'opencode-with-claude@1.6.17',
    ])).toEqual(['opencode-with-claude@1.6.17']);
  });

  it('migrates tuple entries without discarding their options', () => {
    expect(reconcileAnthropicOAuthPluginSpecs([
      ['opencode-with-claude', { enabled: true }],
    ])).toEqual([
      [ANTHROPIC_OAUTH_PLUGIN_SPEC, { enabled: true }],
    ]);
  });

  it('uses an absolute installed entrypoint when the target config is outside the profile', () => {
    const absoluteSpec = 'file:///Users/test/.config/opencode/node_modules/opencode-with-claude/dist/index.js';
    expect(reconcileAnthropicOAuthPluginSpecs([], absoluteSpec)).toEqual([absoluteSpec]);
  });
});
