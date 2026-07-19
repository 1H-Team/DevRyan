import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  isAnthropicOAuthPluginSpec,
  reconcileAnthropicOAuthPluginSpecs,
} from './anthropicOAuthPlugin';

describe('VS Code Anthropic OAuth plugin spec', () => {
  it('recognizes and upgrades the DevRyan-managed legacy entry', () => {
    expect(isAnthropicOAuthPluginSpec('opencode-with-claude@1.6.18')).toBe(true);
    expect(reconcileAnthropicOAuthPluginSpecs(['opencode-with-claude'])).toEqual([
      ANTHROPIC_OAUTH_PLUGIN_SPEC,
    ]);
  });

  it('preserves an explicit user version', () => {
    expect(reconcileAnthropicOAuthPluginSpecs(['opencode-with-claude@1.6.17'])).toEqual([
      'opencode-with-claude@1.6.17',
    ]);
  });
});
