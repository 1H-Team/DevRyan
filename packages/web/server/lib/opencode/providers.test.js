import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANTHROPIC_OAUTH_PLUGIN_SPEC,
  ensureAnthropicOAuthProviderConfig,
  getProviderSources,
} from './providers.js';

let tempDir = null;

const makeProjectDir = () => {
  tempDir = mkdtempSync(join(tmpdir(), 'openchamber-provider-config-'));
  return tempDir;
};

describe('provider config helpers', () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('writes the Claude OAuth proxy config to the active project', () => {
    const projectDir = makeProjectDir();

    const result = ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });

    expect(result.changed).toBe(true);
    expect(result.path).toBe(join(projectDir, '.opencode', 'opencode.json'));

    const config = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(config.plugin).toContain(ANTHROPIC_OAUTH_PLUGIN_SPEC);
    expect(config.provider.anthropic.options).toEqual({
      baseURL: 'http://127.0.0.1:3456',
      apiKey: 'dummy',
    });
  });

  it('detects the written config as an Anthropic OAuth provider source', () => {
    const projectDir = makeProjectDir();
    ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });

    const sources = getProviderSources('claude', projectDir).sources;

    expect(sources.project.exists).toBe(true);
    expect(sources.anthropicOAuth.exists).toBe(true);
    expect(sources.anthropicOAuth.path).toBe(join(projectDir, '.opencode', 'opencode.json'));
  });

  it('does not report project provider config during global source lookup', () => {
    const projectDir = makeProjectDir();
    const providerId = 'test-global-provider-source';
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      provider: {
        [providerId]: {
          options: {
            apiKey: 'test-key',
          },
        },
      },
    }), 'utf8');

    const projectSources = getProviderSources(providerId, projectDir).sources;
    const globalSources = getProviderSources(providerId, null).sources;

    expect(projectSources.project.exists).toBe(true);
    expect(projectSources.project.path).toBe(configPath);
    expect(globalSources.project.exists).toBe(false);
    expect(globalSources.project.path).toBeNull();
  });

  it('does not rewrite an already valid Anthropic OAuth project config', () => {
    const projectDir = makeProjectDir();
    ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });

    const result = ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });

    expect(result.changed).toBe(false);
  });

  it('migrates a bare managed plugin but preserves an explicit user pin', () => {
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugin: ['opencode-with-claude'],
      provider: {
        anthropic: {
          options: { baseURL: 'http://127.0.0.1:3456', apiKey: 'dummy' },
        },
      },
    }), 'utf8');

    const migrated = ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });
    expect(migrated.changed).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).plugin).toEqual([ANTHROPIC_OAUTH_PLUGIN_SPEC]);

    const explicitlyPinned = JSON.parse(readFileSync(configPath, 'utf8'));
    explicitlyPinned.plugin = ['opencode-with-claude@1.6.17'];
    writeFileSync(configPath, JSON.stringify(explicitlyPinned), 'utf8');
    const preserved = ensureAnthropicOAuthProviderConfig({ workingDirectory: projectDir });
    expect(preserved.changed).toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).plugin).toEqual(['opencode-with-claude@1.6.17']);
  });

  it('detects an existing Cursor provider source without generating an open-cursor config', () => {
    const userConfigPath = join(makeProjectDir(), 'opencode.json');
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        'cursor-acp': {
          name: 'Cursor',
        },
      },
    }), 'utf8');

    const sources = getProviderSources('cursor-acp', null, { userConfigPath }).sources;

    expect(sources.user.exists).toBe(true);
    expect(sources.user.path).toBe(userConfigPath);
  });
});
