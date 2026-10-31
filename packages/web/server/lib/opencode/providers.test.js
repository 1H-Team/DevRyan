import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import * as providers from './providers.js';
import {
  getProviderSources,
  listProviderConfigFiles,
  removeAntigravityProviderConfig,
  removeProviderConfig,
} from './providers.js';

let tempDir = null;

const makeProjectDir = () => {
  tempDir = mkdtempSync(join(tmpdir(), 'devryan-provider-config-'));
  return tempDir;
};

describe('provider config helpers', () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('no longer writes or reports the retired Claude OAuth proxy config', () => {
    expect(providers).not.toHaveProperty('ensureAnthropicOAuthProviderConfig');
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugin: ['./node_modules/opencode-with-claude/dist/index.js'],
      provider: {
        anthropic: {
          options: { baseURL: 'http://127.0.0.1:3456', apiKey: 'dummy' },
        },
      },
    }), 'utf8');

    for (const providerId of ['claude', 'anthropic-oauth', 'opencode-with-claude']) {
      const sources = getProviderSources(providerId, projectDir).sources;
      expect(sources).not.toHaveProperty('anthropicOAuth');
      // Claude aliases no longer resolve to the Anthropic provider stanza.
      expect(sources.project.exists).toBe(false);
    }
    const anthropic = getProviderSources('anthropic', projectDir).sources;
    expect(anthropic).not.toHaveProperty('anthropicOAuth');
    expect(anthropic.project).toEqual({ exists: true, path: configPath });
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

  it('removes a provider from every config file of the scope, not only the first one that exists', () => {
    const projectDir = makeProjectDir();
    const rootConfigPath = join(projectDir, 'opencode.json');
    const nestedConfigPath = join(projectDir, '.opencode', 'opencode.jsonc');
    writeFileSync(rootConfigPath, JSON.stringify({ theme: 'keep' }), 'utf8');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(
      nestedConfigPath,
      '{\n  // keep this comment\n  "provider": {\n    "google": { "options": {} },\n    "openai": { "options": {} }\n  }\n}\n',
      'utf8',
    );

    expect(listProviderConfigFiles('google', projectDir)).toContain(nestedConfigPath);
    expect(getProviderSources('google', projectDir).sources.project).toEqual({
      exists: true,
      path: nestedConfigPath,
    });

    expect(removeProviderConfig('google', projectDir, 'project')).toBe(true);

    const nestedSource = readFileSync(nestedConfigPath, 'utf8');
    expect(nestedSource).toContain('// keep this comment');
    expect(nestedSource).not.toContain('google');
    expect(nestedSource).toContain('openai');
    expect(JSON.parse(readFileSync(rootConfigPath, 'utf8'))).toEqual({ theme: 'keep' });
    expect(listProviderConfigFiles('google', projectDir)).not.toContain(nestedConfigPath);
    expect(removeProviderConfig('google', projectDir, 'project')).toBe(false);
  });

  it('removes every Antigravity plugin model and the Google block it leaves empty', () => {
    const projectDir = makeProjectDir();
    const configPath = join(projectDir, '.opencode', 'opencode.json');
    mkdirSync(join(projectDir, '.opencode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      theme: 'keep',
      provider: {
        google: {
          models: {
            'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
            'gemini-2.5-flash': { name: 'Gemini 2.5 Flash (Gemini CLI)' },
          },
        },
      },
    }), 'utf8');

    expect(removeAntigravityProviderConfig(projectDir, 'project')).toBe(true);

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ theme: 'keep' });
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
