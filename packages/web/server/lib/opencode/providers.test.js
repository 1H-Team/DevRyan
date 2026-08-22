import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureAnthropicOAuthProviderConfig,
  getProviderSources,
  removeAntigravityProviderConfig,
  removeProviderConfig,
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
    expect(config.plugin).toHaveLength(1);
    expect(config.plugin[0]).toMatch(/^file:.*\/node_modules\/opencode-with-claude\/dist\/index\.js$/);
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
    expect(JSON.parse(readFileSync(configPath, 'utf8')).plugin).toEqual([
      expect.stringMatching(/^file:.*\/node_modules\/opencode-with-claude\/dist\/index\.js$/),
    ]);

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

  it('removes only Antigravity models from the shared Google provider config', () => {
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      provider: {
        google: {
          npm: '@ai-sdk/google',
          models: {
            'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
            'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
          },
        },
      },
    }), 'utf8');

    expect(removeAntigravityProviderConfig(projectDir, 'project')).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.provider.google).toEqual({
      npm: '@ai-sdk/google',
      models: {
        'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
      },
    });
  });

  it('reports nested Antigravity models as an active provider source', () => {
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      provider: {
        google: {
          models: {
            'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
            'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
          },
        },
      },
    }), 'utf8');

    const sources = getProviderSources('antigravity', projectDir).sources;

    expect(sources.project.exists).toBe(true);
    expect(sources.project.path).toBe(configPath);
  });

  it('removes provider config only from the explicitly targeted project', () => {
    const projectsRoot = makeProjectDir();
    const activeProject = join(projectsRoot, 'active');
    const unrelatedProject = join(projectsRoot, 'unrelated');
    const writeProjectConfig = (projectDir) => {
      const configPath = join(projectDir, '.opencode', 'opencode.json');
      mkdirSync(join(projectDir, '.opencode'), { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        provider: {
          google: { models: { 'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' } } },
        },
      }), 'utf8');
      return configPath;
    };
    const activeConfig = writeProjectConfig(activeProject);
    const unrelatedConfig = writeProjectConfig(unrelatedProject);

    expect(removeProviderConfig('google', activeProject, 'project')).toBe(true);
    expect(JSON.parse(readFileSync(activeConfig, 'utf8')).provider?.google).toBeUndefined();
    expect(JSON.parse(readFileSync(unrelatedConfig, 'utf8')).provider?.google).toBeDefined();
  });

  it('classifies and removes Google config aliases together', () => {
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      provider: {
        google: { models: { gemini: { name: 'Gemini' } } },
        'google.oauth': { options: { legacy: true } },
      },
    }), 'utf8');

    expect(getProviderSources('google', projectDir).sources.project.exists).toBe(true);
    expect(removeProviderConfig('google', projectDir, 'project')).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).provider).toBeUndefined();
  });
});
