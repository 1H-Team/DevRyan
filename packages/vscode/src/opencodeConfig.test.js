import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listRuntimePluginAssets } from '../../web/server/lib/opencode/default-config-assets.js';
import { deleteSkill, discoverSkills, getSkillSources } from './opencodeConfig';

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const writeAgentMarkdown = (agentDirectory, name, frontmatterLines) => {
  fs.mkdirSync(agentDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(agentDirectory, `${name}.md`),
    ['---', ...frontmatterLines, '---', '', `${name} prompt`, ''].join('\n'),
    'utf8',
  );
};

const readAgentFrontmatter = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).toBeTruthy();
  return match[1];
};

describe('VS Code skill discovery', () => {
  it('does not treat non-file discovered skill paths as editable markdown sources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-runtime-skill-'));

    try {
      const sources = getSkillSources('runtime-helper', root, {
        name: 'runtime-helper',
        description: 'Runtime helper',
        path: '<built-in>',
        scope: 'user',
        source: 'opencode',
        preferDiscoveredPath: true,
      });

      expect(sources.md.exists).toBe(false);
      expect(sources.md.path).toBe(null);
      expect(sources.md.supportingFiles).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps duplicate skill names when their canonical paths differ', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-skills-'));
    const opencodeSkill = path.join(root, '.opencode', 'skills', 'lint-helper');
    const agentsSkill = path.join(root, '.agents', 'skills', 'lint-helper');
    fs.mkdirSync(opencodeSkill, { recursive: true });
    fs.mkdirSync(agentsSkill, { recursive: true });
    fs.writeFileSync(path.join(opencodeSkill, 'SKILL.md'), '---\nname: lint-helper\ndescription: Project default\n---\n');
    fs.writeFileSync(path.join(agentsSkill, 'SKILL.md'), '---\nname: lint-helper\ndescription: Agents skill\n---\n');

    try {
      const skills = discoverSkills(root)
        .filter((skill) => skill.name === 'lint-helper' && skill.path.startsWith(root))
        .sort((a, b) => a.path.localeCompare(b.path));

      expect(skills).toHaveLength(2);
      expect(skills.map((skill) => skill.path)).toEqual([
        path.join(root, '.agents', 'skills', 'lint-helper', 'SKILL.md'),
        path.join(root, '.opencode', 'skills', 'lint-helper', 'SKILL.md'),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers OpenCode and .agents skills while excluding .claude skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-skill-sources-'));
    const opencodeSkill = path.join(root, '.opencode', 'skills', 'project-tool');
    const agentsSkill = path.join(root, '.agents', 'skills', 'agent-tool');
    const claudeSkill = path.join(root, '.claude', 'skills', 'claude-tool');
    for (const skillDir of [opencodeSkill, agentsSkill, claudeSkill]) {
      fs.mkdirSync(skillDir, { recursive: true });
      const name = path.basename(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    }

    try {
      const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));
      expect(skills.map((skill) => skill.name).sort()).toEqual(['agent-tool', 'project-tool']);
      expect(skills.map((skill) => skill.source).sort()).toEqual(['agents', 'opencode']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('permanently deletes only the supplied discovered skill directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-skills-delete-'));
    const userSkill = path.join(root, '.agents', 'skills', 'lint-helper');
    const projectSkill = path.join(root, '.opencode', 'skills', 'lint-helper');
    const userSkillPath = path.join(userSkill, 'SKILL.md');
    const projectSkillPath = path.join(projectSkill, 'SKILL.md');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.mkdirSync(projectSkill, { recursive: true });
    fs.writeFileSync(userSkillPath, '---\nname: lint-helper\n---\n');
    fs.writeFileSync(projectSkillPath, '---\nname: lint-helper\n---\n');

    try {
      deleteSkill('lint-helper', root, {
        name: 'lint-helper',
        path: projectSkillPath,
        scope: 'project',
        source: 'opencode',
      });

      expect(fs.existsSync(projectSkill)).toBe(false);
      expect(fs.existsSync(userSkill)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('VS Code plugin discovery', () => {
  let tempHome;
  let originalHome;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    vi.resetModules();
  });

  const loadRuntime = async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-plugins-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    vi.resetModules();
    return import('./opencodeConfig');
  };

  it('lists existing plugin entries and files without mutating config', async () => {
    const { listReadonlyPlugins } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-plugins-project-'));
    const userConfigPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    const projectConfigPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(userConfigPath, { plugin: ['user-plugin@1.0.0'] });
    writeJson(projectConfigPath, { plugin: [['./project-plugin.js', { local: true }]] });
    fs.mkdirSync(path.join(tempHome, '.config', 'opencode', 'plugin'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, '.config', 'opencode', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.opencode', 'plugin'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.opencode', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.config', 'opencode', 'plugin', 'user-file.mjs'), '', 'utf8');
    fs.writeFileSync(path.join(tempHome, '.config', 'opencode', 'plugins', 'user-file.mjs'), '', 'utf8');
    fs.writeFileSync(path.join(projectDir, '.opencode', 'plugin', 'project-legacy.js'), '', 'utf8');
    fs.writeFileSync(path.join(projectDir, '.opencode', 'plugins', 'project-file.ts'), '', 'utf8');

    try {
      const result = listReadonlyPlugins(projectDir);

      expect(result.defaults.map((plugin) => plugin.pluginId)).toEqual([
        'opencode-antigravity-auth',
        '@rama_nigg/open-cursor',
        'opencode-with-claude',
        'opencode-gpt-imagegen',
        'context-mode',
        'oh-my-opencode-slim',
        'superpowers',
        'devryan-skill-context',
        'devryan-document-reader',
        'openai-tool-schema-sanitizer',
      ]);
      expect(result.entries.map((plugin) => `${plugin.scope}:${plugin.spec}:${plugin.parsedKind}`)).toEqual([
        'user:user-plugin@1.0.0:npm',
        'project:./project-plugin.js:path',
      ]);
      expect(result.entries[1].options).toEqual({ local: true });
      expect(result.files.map((pluginFile) => `${pluginFile.scope}:${pluginFile.fileName}`)).toEqual([
        'user:user-file.mjs',
        'user:user-file.mjs',
        'project:project-legacy.js',
        'project:project-file.ts',
      ]);
      expect(result.files.slice(0, 2).map((pluginFile) => pluginFile.absolutePath)).toEqual([
        path.join(tempHome, '.config', 'opencode', 'plugin', 'user-file.mjs'),
        path.join(tempHome, '.config', 'opencode', 'plugins', 'user-file.mjs'),
      ]);
      expect(readJson(userConfigPath)).toEqual({ plugin: ['user-plugin@1.0.0'] });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('VS Code Cursor SDK config handling', () => {
  let tempHome;
  let originalHome;
  let originalSlimPreset;
  let originalOpenAIApiKey;
  let originalOpenCodeConfigDirectory;
  let originalDataDirectory;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalSlimPreset === undefined) {
      delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    } else {
      process.env.OH_MY_OPENCODE_SLIM_PRESET = originalSlimPreset;
    }
    if (originalOpenAIApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIApiKey;
    }
    if (originalOpenCodeConfigDirectory === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDirectory;
    }
    if (originalDataDirectory === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = originalDataDirectory;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    originalSlimPreset = undefined;
    originalOpenAIApiKey = undefined;
    originalOpenCodeConfigDirectory = undefined;
    originalDataDirectory = undefined;
    vi.resetModules();
  });

  const loadRuntime = async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-cursor-provider-'));
    originalHome = process.env.HOME;
    originalSlimPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
    originalOpenAIApiKey = process.env.OPENAI_API_KEY;
    originalOpenCodeConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
    originalDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
    process.env.HOME = tempHome;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCHAMBER_DATA_DIR;
    vi.resetModules();
    return import('./opencodeConfig');
  };

  it('does not generate the old open-cursor provider in runtime overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-cursor-project-'));
    const configPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      plugin: ['@rama_nigg/open-cursor@latest'],
      provider: {
        'cursor-acp': {
          name: 'Cursor',
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:32124/v1',
          },
          models: {
            'claude-opus-4-7': { name: 'claude opus 4 7' },
            'claude-opus-4-7-thinking-xhigh': { name: 'claude opus 4 7 thinking extra high' },
          },
        },
      },
    });

    const result = syncRuntimeAgentOverlays(projectDir);
    const overlayConfigPath = path.join(result.targetConfigDirectory, 'opencode.json');
    const overlayConfig = readJson(overlayConfigPath);

    expect(overlayConfig.plugin).not.toContain('@rama_nigg/open-cursor@latest');
    expect(overlayConfig.plugin).toContain('./plugins/openai-tool-schema-sanitizer.mjs');
    expect(overlayConfig.provider?.['cursor-acp']).toBeUndefined();
    expect(overlayConfig.provider?.openai).toBeUndefined();
    expect(overlayConfig.agent).toMatchObject({
      title: { disable: true },
      'devryan-title': {
        mode: 'subagent',
        hidden: true,
        permission: { '*': 'deny' },
        prompt: expect.stringContaining('untrusted data'),
      },
    });
    expect(JSON.stringify(readJson(configPath))).toContain('@rama_nigg/open-cursor@latest');
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('removes only Antigravity models from a project Google provider config', async () => {
    const { removeAntigravityProviderConfig } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-antigravity-project-'));
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      provider: {
        google: {
          npm: '@ai-sdk/google',
          models: {
            'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
            'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
          },
        },
      },
    });

    expect(removeAntigravityProviderConfig(projectDir, 'project')).toBe(true);
    expect(readJson(configPath).provider.google).toEqual({
      npm: '@ai-sdk/google',
      models: {
        'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
      },
    });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('classifies Antigravity models nested under Google as a project source', async () => {
    const { getProviderSources } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-antigravity-source-'));
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      provider: {
        google: {
          models: {
            'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
          },
        },
      },
    });

    try {
      expect(getProviderSources('antigravity', projectDir).project).toEqual({
        exists: true,
        path: configPath,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('classifies and removes Google config aliases together', async () => {
    const { getProviderSources, removeProviderConfig } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-google-alias-'));
    const configPath = path.join(projectDir, '.opencode', 'opencode.json');
    writeJson(configPath, {
      provider: {
        google: { models: { gemini: { name: 'Gemini' } } },
        'google.oauth': { options: { legacy: true } },
      },
    });

    try {
      expect(getProviderSources('google', projectDir).project.exists).toBe(true);
      expect(removeProviderConfig('google', projectDir, 'project')).toBe(true);
      expect(readJson(configPath).provider).toBeUndefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not synthesize direct OpenAI GPT-5.6 model availability', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-native-ultra-'));

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai).toBeUndefined();
      expect(overlayConfig.provider?.anthropic).toBeUndefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds bounded OpenAI connection and total-request liveness timeouts for OAuth auth', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-oauth-'));
    writeJson(path.join(tempHome, '.local', 'share', 'opencode', 'auth.json'), {
      openai: { type: 'oauth', access: 'oauth-token' },
    });
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      plugin: ['opencode-antigravity-auth@latest'],
    });

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai).toEqual({
        options: {
          headerTimeout: 120_000,
          chunkTimeout: 300_000,
          timeout: 900_000,
        },
      });
      expect(overlayConfig.provider.openai.models).toBeUndefined();
      expect(overlayConfig.plugin).not.toContain('opencode-antigravity-auth@latest');
      expect(overlayConfig.mcp.ghgrep).toEqual({ enabled: false });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds OpenAI connection-liveness timeouts for an API-key environment', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-env-'));
    process.env.OPENAI_API_KEY = 'test-api-key';

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai?.options).toEqual({
        headerTimeout: 120_000,
        chunkTimeout: 300_000,
        timeout: 900_000,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds OpenAI connection-liveness timeouts for an existing provider configuration', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-provider-'));
    writeJson(path.join(projectDir, 'opencode.json'), {
      provider: {
        openai: {
          options: { baseURL: 'https://api.openai.com/v1' },
        },
      },
    });

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai).toEqual({
        options: {
          headerTimeout: 120_000,
          chunkTimeout: 300_000,
          timeout: 900_000,
        },
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each([
    { headerTimeout: 30_000, chunkTimeout: 45_000, timeout: 90_000 },
    { headerTimeout: false, chunkTimeout: false, timeout: false },
  ])('preserves explicit OpenAI timeout options: %j', async (providerOptions) => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-explicit-'));
    writeJson(path.join(projectDir, 'opencode.json'), {
      provider: {
        openai: {
          options: providerOptions,
        },
      },
    });

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai?.options).toEqual(providerOptions);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('removes a stale generated OpenAI timeout after auth is removed', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-cleanup-'));
    const authPath = path.join(tempHome, '.local', 'share', 'opencode', 'auth.json');
    writeJson(authPath, {
      openai: { type: 'oauth', access: 'oauth-token' },
    });

    try {
      const initial = syncRuntimeAgentOverlays(projectDir);
      expect(readJson(path.join(initial.targetConfigDirectory, 'opencode.json'))
        .provider?.openai?.options?.headerTimeout).toBe(120_000);

      fs.unlinkSync(authPath);
      const updated = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(updated.targetConfigDirectory, 'opencode.json'));
      expect(updated.changed).toBe(true);
      expect(overlayConfig.provider?.openai).toBeUndefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('replaces a stale generated OpenAI total deadline on the next startup sync', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-refresh-'));
    writeJson(path.join(tempHome, '.local', 'share', 'opencode', 'auth.json'), {
      openai: { type: 'oauth', access: 'oauth-token' },
    });

    try {
      const initial = syncRuntimeAgentOverlays(projectDir);
      const generatedConfigPath = path.join(initial.targetConfigDirectory, 'opencode.json');
      const staleConfig = readJson(generatedConfigPath);
      staleConfig.provider.openai.options = {
        headerTimeout: 60_000,
        chunkTimeout: 120_000,
        timeout: 600_000,
      };
      writeJson(generatedConfigPath, staleConfig);

      const refreshed = syncRuntimeAgentOverlays(projectDir);
      expect(refreshed.changed).toBe(true);
      expect(readJson(generatedConfigPath).provider.openai.options).toEqual({
        headerTimeout: 120_000,
        chunkTimeout: 300_000,
        timeout: 900_000,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('copies and registers packaged runtime plugins in managed overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-packaged-plugins-'));
    const defaultConfigRoot = path.resolve(process.cwd(), '..', 'web', 'server', 'default-config');
    const expectedPlugins = await listRuntimePluginAssets(defaultConfigRoot);

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfigPath = path.join(result.targetConfigDirectory, 'opencode.json');
      const pluginDirectory = path.join(result.targetConfigDirectory, 'plugins');
      const config = readJson(overlayConfigPath);
      const pluginFiles = fs.readdirSync(pluginDirectory).sort();
      const expectedPluginSpecs = expectedPlugins.map((relativePath) => `./${relativePath}`);
      const expectedPluginFiles = expectedPlugins.map((relativePath) => path.basename(relativePath));

      expect(expectedPlugins).not.toEqual([]);
      expect(config.plugin).toEqual(expect.arrayContaining(expectedPluginSpecs));
      expect(pluginFiles).toEqual(expect.arrayContaining(expectedPluginFiles));
      for (const relativePath of expectedPlugins) {
        expect(fs.readFileSync(path.join(pluginDirectory, path.basename(relativePath)), 'utf8'))
          .toBe(fs.readFileSync(path.join(defaultConfigRoot, relativePath), 'utf8'));
      }
      expect(pluginFiles.some((fileName) => fileName.includes('.test.') || fileName.includes('.spec.') || fileName.endsWith('.d.ts'))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps the packaged Orchestrator managed-only in VS Code runtime overlays', async () => {
    const { listConfigAgents, syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-managed-orchestrator-'));

    try {
      const orchestrator = listConfigAgents(projectDir)
        .find((agent) => agent.name === 'orchestrator');
      expect(orchestrator?.permission).toMatchObject({
        task: 'deny',
        devryan_task: 'allow',
      });

      const result = syncRuntimeAgentOverlays(projectDir);
      const frontmatter = readAgentFrontmatter(
        path.join(result.targetConfigDirectory, 'agents', 'orchestrator.md'),
      );
      expect(frontmatter).toContain('  task: deny');
      expect(frontmatter).toContain('  devryan_task: allow');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps Zen model selection while moving Council metadata out of executable agent frontmatter', async () => {
    const { syncRuntimeAgentOverlays, writeAgentModelOverride } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-agent-metadata-'));
    const agentDirectory = path.join(projectDir, '.opencode', 'agents');
    writeAgentMarkdown(agentDirectory, 'explorer', [
      'mode: subagent',
      'model: opencode-go/deepseek-v4-flash',
      'modelRefs:',
      '  - opencode-go/deepseek-v4-flash',
      'councillors:',
      '  - model: opencode-go/deepseek-v4-flash',
    ]);
    writeAgentMarkdown(agentDirectory, 'council', [
      'mode: all',
      'model: openai/gpt-5.5',
    ]);
    writeJson(path.join(agentDirectory, 'council.models.json'), {
      version: 1,
      councillors: [
        { model: 'openai/gpt-5.5', variant: 'medium' },
        { model: 'opencode/deepseek-v4-flash' },
      ],
    });

    try {
      writeAgentModelOverride('explorer', {
        model: 'opencode/deepseek-v4-flash',
        variant: 'medium',
      }, projectDir);
      const result = syncRuntimeAgentOverlays(projectDir);
      const explorerFrontmatter = readAgentFrontmatter(
        path.join(result.targetConfigDirectory, 'agents', 'explorer.md'),
      );
      const councilFrontmatter = readAgentFrontmatter(
        path.join(result.targetConfigDirectory, 'agents', 'council.md'),
      );

      expect(explorerFrontmatter).toContain('model: opencode/deepseek-v4-flash');
      expect(explorerFrontmatter).not.toContain('modelRefs:');
      expect(explorerFrontmatter).not.toContain('councillors:');
      expect(councilFrontmatter).not.toContain('modelRefs:');
      expect(councilFrontmatter).not.toContain('councillors:');
      expect(readJson(path.join(result.targetConfigDirectory, 'agents', 'council.models.json'))).toEqual({
        version: 1,
        councillors: [
          { model: 'openai/gpt-5.5', variant: 'medium' },
          { model: 'opencode/deepseek-v4-flash' },
        ],
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('sanitizes Designer to its visible named skill subset and allowed source directories', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-designer-skills-'));
    const frontendSkill = path.join(projectDir, '.opencode', 'skills', 'frontend-design');
    const agentBrowserSkill = path.join(projectDir, '.agents', 'skills', 'agent-browser');
    const claudeSkill = path.join(projectDir, '.claude', 'skills', 'accessibility');
    for (const skillDir of [frontendSkill, agentBrowserSkill, claudeSkill]) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${path.basename(skillDir)}\ndescription: test skill\n---\n`,
      );
    }
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'designer', [
      'mode: subagent',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '    /tmp/legacy/.cursor/skills/frontend-design/*: allow',
      '  skill:',
      '    "*": deny',
      '    frontend-design: allow',
      '    agent-browser: allow',
      '    accessibility: allow',
    ]);

    try {
      const result = syncRuntimeAgentOverlays(projectDir, {
        hiddenSkills: [{
          name: 'agent-browser',
          path: path.join(agentBrowserSkill, 'SKILL.md'),
          scope: 'project',
          source: 'agents',
        }],
      });
      const frontmatter = readAgentFrontmatter(
        path.join(result.targetConfigDirectory, 'agents', 'designer.md'),
      );

      expect(frontmatter).toContain('skill:\n    "*": deny\n    frontend-design: allow');
      expect(frontmatter).toContain(`${frontendSkill}/*: allow`);
      expect(frontmatter).not.toContain(`${agentBrowserSkill}/*: allow`);
      expect(frontmatter).not.toContain(`${claudeSkill}/*: allow`);
      expect(frontmatter).not.toContain('.cursor/skills');
      expect(frontmatter).not.toContain('agent-browser: allow');
      expect(frontmatter).not.toContain('accessibility: allow');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds active project external-directory allows to VS Code runtime agent overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-overlay-repo-'));
    const projectDir = path.join(repoDir, 'packages', 'app');
    const openCodeDataDirectory = path.join(tempHome, '.local', 'share', 'opencode');
    const projectId = 'project-one';
    const projectWorktreeContainer = path.join(openCodeDataDirectory, 'worktree', projectId);
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git', 'opencode'), `${projectId}\n`, 'utf8');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(projectWorktreeContainer, { recursive: true });
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'reviewer', [
      'mode: subagent',
      'permission:',
      '  "*": deny',
      '  external_directory:',
      '    "*": ask',
      '  read:',
      '    "*": allow',
      '    "*.env": ask',
    ]);
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      openchamber: {
        agentOverrides: {
          explorer: {
            model: 'openai/gpt-5.5',
          },
        },
      },
    });
    const dataDirectory = path.join(tempHome, '.config', 'openchamber');
    fs.mkdirSync(dataDirectory, { recursive: true });

    const result = syncRuntimeAgentOverlays(projectDir, { openCodeDataDirectory });
    const frontmatter = readAgentFrontmatter(path.join(result.targetConfigDirectory, 'agents', 'explorer.md'));
    const reviewerFrontmatter = readAgentFrontmatter(
      path.join(result.targetConfigDirectory, 'agents', 'reviewer.md'),
    );

    expect(frontmatter).toContain(`${repoDir}/*: allow`);
    expect(frontmatter).toContain(`${projectDir}/*: allow`);
    expect(frontmatter).toContain(`${projectWorktreeContainer}/*: allow`);
    expect(frontmatter).toContain(`${dataDirectory}/*: allow`);
    expect(frontmatter).toContain(`${fs.realpathSync(dataDirectory)}/*: allow`);
    expect(frontmatter).not.toContain(`${path.join(tempHome, '.config')}/*: allow`);
    expect(frontmatter).not.toContain(`${path.join(openCodeDataDirectory, 'worktree')}/*: allow`);
    expect(frontmatter).not.toContain(`${path.join(openCodeDataDirectory, 'worktree', 'project-two')}/*: allow`);
    expect(path.join(
      dataDirectory,
      'projects',
      'another-project',
      'plans',
      'revision.md',
    ).startsWith(`${dataDirectory}${path.sep}`)).toBe(true);
    if (process.platform !== 'win32') {
      expect(frontmatter).toContain('/tmp/*: allow');
      expect(frontmatter).toContain(`${fs.realpathSync('/tmp')}/*: allow`);
    }
    expect(frontmatter).toContain('"*": ask');
    expect(frontmatter).toContain('"*.env": ask');
    expect(reviewerFrontmatter).toContain(`${dataDirectory}/*: allow`);
    expect(reviewerFrontmatter).toContain('"*": deny');
    expect(reviewerFrontmatter).toContain('"*.env": ask');
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('uses OPENCHAMBER_DATA_DIR for VS Code runtime agent overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-data-root-project-'));
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-data-root-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDirectory;
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'reviewer', [
      'mode: subagent',
      'permission:',
      '  "*": deny',
      '  external_directory:',
      '    "*": ask',
      '  read:',
      '    "*": allow',
    ]);

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const frontmatter = readAgentFrontmatter(
        path.join(result.targetConfigDirectory, 'agents', 'reviewer.md'),
      );

      expect(frontmatter).toContain(`${dataDirectory}/*: allow`);
      expect(frontmatter).toContain(`${fs.realpathSync(dataDirectory)}/*: allow`);
      expect(frontmatter).not.toContain(`${path.join(tempHome, '.config', 'openchamber')}/*: allow`);
      expect(frontmatter).toContain('"*": deny');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it('lists Slim-managed agents instead of packaged defaults and writes overrides to Slim config', async () => {
    const {
      getAgentConfig,
      listConfigAgents,
      resolveSlimRuntimePreset,
      writeAgentModelOverride,
    } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-slim-project-'));
    const opencodeConfigDir = path.join(tempHome, '.config', 'opencode');
    const slimConfigPath = path.join(opencodeConfigDir, 'oh-my-opencode-slim.json');
    writeJson(path.join(opencodeConfigDir, 'opencode.json'), {
      plugin: ['oh-my-opencode-slim'],
    });
    writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*'] },
          designer: { model: 'openai/gpt-5.4-mini', variant: 'medium', skills: [], mcps: [] },
          fixer: { model: 'openai/gpt-5.5', variant: 'low', skills: [], mcps: [] },
        },
      },
      agents: {
        orchestrator: { skills: ['*'], mcps: ['*'] },
      },
    });
    writeAgentMarkdown(path.join(opencodeConfigDir, 'agents'), 'builder', [
      'mode: primary',
      'model: openai/gpt-5.5',
      'variant: medium',
    ]);
    writeAgentMarkdown(path.join(opencodeConfigDir, 'agents'), 'council', [
      'mode: all',
      'model: openai/gpt-5.5',
      'modelRefs:',
      '  - openai/gpt-5.5',
      '  - opencode/claude-opus-4-5',
      'variant: medium',
    ]);
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'orchestrator', [
      'mode: primary',
      'model: stale/project-orchestrator',
      'variant: stale',
    ]);
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'council', [
      'mode: all',
      'model: stale/project-council',
      'variant: stale',
    ]);
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'custom-reviewer', [
      'mode: subagent',
      'model: openai/gpt-5.4',
    ]);

    try {
      const agents = listConfigAgents(projectDir);
      const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
      const council = agents.find((agent) => agent.name === 'council');

      expect(resolveSlimRuntimePreset(projectDir)).toBe('openai');
      expect(agents.map((agent) => agent.name)).toEqual(['builder', 'council', 'custom-reviewer', 'designer', 'fixer', 'orchestrator']);
      expect(orchestrator).toMatchObject({
        scope: 'slim',
        source: 'slim',
        mode: 'primary',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'medium',
      });
      expect(council).toMatchObject({
        scope: 'slim',
        source: 'slim',
        mode: 'all',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        modelRefs: ['openai/gpt-5.5', 'opencode/claude-opus-4-5'],
        variant: 'medium',
      });

      writeAgentModelOverride('orchestrator', { model: 'openai/gpt-5.4-mini', variant: null }, projectDir);

      const slimConfig = readJson(slimConfigPath);
      expect(slimConfig.agents.orchestrator).toEqual({
        model: 'openai/gpt-5.4-mini',
        skills: ['*'],
        mcps: ['*'],
      });
      expect(fs.existsSync(path.join(opencodeConfigDir, '.openchamber', 'config.json'))).toBe(false);
      expect(getAgentConfig('orchestrator', projectDir).config).toMatchObject({
        model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
        overrides: { model: true, variant: true, councillors: false },
      });
      expect(getAgentConfig('orchestrator', projectDir).config).not.toHaveProperty('variant');

      writeAgentModelOverride('council', { model: 'openai/gpt-5.4-mini', variant: 'low' }, projectDir);
      const updatedSlimConfig = readJson(slimConfigPath);
      expect(updatedSlimConfig.agents.council).toEqual({
        model: 'openai/gpt-5.4-mini',
        variant: 'low',
      });
      expect(getAgentConfig('council', projectDir).config).toMatchObject({
        scope: 'slim',
        source: 'slim',
        model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
        variant: 'low',
        prompt: 'council prompt',
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps project agents authoritative for the DevRyan Slim wrapper mode', async () => {
    const {
      getAgentConfig,
      listConfigAgents,
      resolveSlimRuntimePreset,
      syncRuntimeAgentOverlays,
      writeAgentModelOverride,
    } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-slim-wrapper-project-'));
    const opencodeConfigDir = path.join(tempHome, '.config', 'opencode');
    const slimConfigPath = path.join(opencodeConfigDir, 'oh-my-opencode-slim.json');
    writeJson(path.join(opencodeConfigDir, 'opencode.json'), {
      plugin: ['./plugins/devryan-oh-my-opencode-slim.mjs'],
    });
    writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*'] },
          fixer: { model: 'openai/gpt-5.5', variant: 'low' },
          'slim-only': { model: 'openai/gpt-5.4-mini', variant: 'low' },
        },
      },
    });
    writeAgentMarkdown(path.join(opencodeConfigDir, 'agents'), 'orchestrator', [
      'mode: primary',
      'model: stale/slim',
    ]);
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'orchestrator', [
      'mode: primary',
      'model: stale/project-orchestrator',
      'variant: stale',
      'permission:',
      '  "*": deny',
      '  task:',
      '    fixer: allow',
    ]);

    try {
      const agents = listConfigAgents(projectDir);
      const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
      const slimOnly = agents.find((agent) => agent.name === 'slim-only');

      expect(resolveSlimRuntimePreset(projectDir)).toBe('openai');
      expect(orchestrator).toMatchObject({
        scope: 'project',
        source: 'project',
        prompt: 'orchestrator prompt',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'medium',
      });
      expect(orchestrator.permission).toEqual({
        '*': 'deny',
        task: { fixer: 'allow' },
      });
      expect(slimOnly).toMatchObject({
        scope: 'slim',
        source: 'slim',
        model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      });

      writeAgentModelOverride('orchestrator', { model: 'openai/gpt-5.4-mini', variant: null }, projectDir);
      const slimConfig = readJson(slimConfigPath);
      expect(slimConfig.agents.orchestrator).toEqual({
        model: 'openai/gpt-5.4-mini',
      });
      expect(fs.existsSync(path.join(opencodeConfigDir, '.openchamber', 'config.json'))).toBe(false);
      expect(getAgentConfig('orchestrator', projectDir).config).toMatchObject({
        scope: 'project',
        source: 'project',
        model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
        overrides: { model: true, variant: true, councillors: false },
      });

      const overlayResult = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(overlayResult.targetConfigDirectory, 'opencode.json'));
      const overlaySlimConfig = readJson(path.join(overlayResult.targetConfigDirectory, 'oh-my-opencode-slim.json'));
      const overlayAgentPath = path.join(overlayResult.targetConfigDirectory, 'agents', 'orchestrator.md');
      expect(overlayConfig.plugin).toContain('./plugins/devryan-oh-my-opencode-slim.mjs');
      expect(overlaySlimConfig.preset).toBe('openai');
      expect(fs.existsSync(overlayAgentPath)).toBe(true);
      const overlayAgent = readAgentFrontmatter(overlayAgentPath);
      expect(overlayAgent).toContain('model: openai/gpt-5.4-mini');
      expect(overlayAgent).not.toContain('modelRefs:');
      expect(overlayAgent).toContain('variant: ""');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('filters active Slim and user plugin entries through the managed runtime allowlist in VS Code runtime overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-slim-overlay-'));
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      plugin: [
        'opencode-antigravity-auth@latest',
        '@rama_nigg/open-cursor@latest',
        'cursor-acp',
        'context-mode@1.0.169',
        'oh-my-opencode-slim',
        'superpowers@git+https://github.com/obra/superpowers.git',
        'unapproved-docs@latest',
        'grep-app@latest',
      ],
    });
    writeJson(path.join(tempHome, '.config', 'opencode', 'oh-my-opencode-slim.json'), {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
          designer: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
        },
      },
    });

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      const overlaySlimConfig = readJson(path.join(result.targetConfigDirectory, 'oh-my-opencode-slim.json'));

      expect(overlayConfig.plugin).not.toContain('opencode-antigravity-auth@latest');
      expect(overlayConfig.plugin).not.toContain('@rama_nigg/open-cursor@latest');
      expect(overlayConfig.plugin).not.toContain('cursor-acp');
      expect(overlayConfig.plugin).not.toContain('context-mode@1.0.169');
      expect(overlayConfig.plugin).not.toContain('oh-my-opencode-slim');
      expect(overlayConfig.plugin).toContain('./plugins/council-session.js');
      expect(overlayConfig.plugin).toContain('./plugins/openai-tool-schema-sanitizer.mjs');
      expect(overlayConfig.plugin).not.toContain('superpowers@git+https://github.com/obra/superpowers.git');
      expect(overlayConfig.plugin).not.toContain('unapproved-docs@latest');
      expect(overlayConfig.plugin).not.toContain('grep-app@latest');
      expect(overlayConfig.mcp.ghgrep).toEqual({ enabled: false });
      expect(overlaySlimConfig.preset).toBe('openai');
      expect(overlaySlimConfig.presets.openai.designer).toEqual({
        model: 'openai/gpt-5.4-mini',
        variant: 'medium',
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('VS Code MCP OAuth stale-state handling', () => {
  let tempHome;
  let originalHome;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    vi.resetModules();
  });

  const loadRuntime = async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-mcp-oauth-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    vi.resetModules();
    return import('./opencodeConfig');
  };

  const mcpAuthPath = () => path.join(tempHome, '.local', 'share', 'opencode', 'mcp-auth.json');

  it('deletes matching MCP OAuth cache when deleting an MCP config', async () => {
    const { deleteMcpConfig } = await loadRuntime();
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp' },
      },
    });
    writeJson(mcpAuthPath(), {
      linear: { clientInfo: { client_id: 'stale-linear' }, oauthState: 'old-state' },
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });

    deleteMcpConfig('linear');

    expect(readJson(mcpAuthPath())).toEqual({
      supabase: { clientInfo: { client_id: 'keep-supabase' }, oauthState: 'keep-state' },
    });
  });

  it('invalidates matching MCP OAuth cache when OAuth redirect changes', async () => {
    const { updateMcpConfig } = await loadRuntime();
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        supabase: {
          type: 'remote',
          url: 'https://mcp.supabase.com/mcp',
          oauth: { redirectUri: 'http://localhost:55676/mcp/oauth/callback' },
        },
      },
    });
    writeJson(mcpAuthPath(), {
      supabase: { clientInfo: { client_id: 'stale-supabase' }, oauthState: 'old-state' },
    });

    updateMcpConfig('supabase', {
      oauth: { redirectUri: 'http://127.0.0.1:55676/mcp/oauth/callback' },
    });

    expect(readJson(mcpAuthPath())).toEqual({});
  });

  it('reports an unchanged effective MCP update without rewriting configuration', async () => {
    const { updateMcpConfig } = await loadRuntime();
    const configPath = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp', enabled: true },
      },
    });
    const before = fs.readFileSync(configPath, 'utf8');

    const result = updateMcpConfig('linear', { enabled: true });

    expect(result).toEqual({ changed: false, authReset: { ok: true, removed: false } });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('does not recover explicitly deleted MCP configs', async () => {
    const {
      deleteMcpConfig,
      recoverMcpConfigs,
      listMcpConfigs,
    } = await loadRuntime();
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(projectDir, 'opencode.json'), {
      mcp: {
        linear: { type: 'remote', url: 'https://mcp.linear.app/mcp' },
      },
    });
    writeJson(path.join(projectDir, 'opencode.json.openchamber.backup'), {
      mcp: {
        linear: { type: 'remote', url: 'https://stale-linear.example.test/mcp' },
      },
    });

    deleteMcpConfig('linear', projectDir);
    const recovered = recoverMcpConfigs(projectDir);

    expect(recovered.migrated).toEqual([]);
    expect(recovered.skipped).toContainEqual({ name: 'linear', reason: 'deleted' });
    expect(listMcpConfigs(projectDir).find((entry) => entry.name === 'linear')).toBeUndefined();
  });

  it('ignores home-folder ambient MCP configs while preserving official user and project configs', async () => {
    const { listMcpConfigs } = await loadRuntime();
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        userOfficial: { type: 'remote', url: 'https://official.example.test/mcp' },
      },
    });
    writeJson(path.join(tempHome, '.opencode', 'opencode.json'), {
      mcp: {
        ambientDocs: { type: 'remote', url: 'https://ambient.example.test/mcp' },
      },
    });
    writeJson(path.join(projectDir, '.opencode', 'opencode.json'), {
      mcp: {
        projectLocal: { type: 'local', command: ['project-mcp'] },
      },
    });

    expect(listMcpConfigs(projectDir).map((entry) => [entry.name, entry.type, entry.url, entry.command, entry.scope]).sort()).toEqual([
      ['projectLocal', 'local', undefined, ['project-mcp'], 'project'],
      ['userOfficial', 'remote', 'https://official.example.test/mcp', undefined, 'user'],
    ].sort());
  });
});

describe('VS Code agent backup models', () => {
  let tempHome;
  let originalHome;
  let originalOpenCodeConfigDirectory;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalOpenCodeConfigDirectory === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDirectory;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    originalOpenCodeConfigDirectory = undefined;
    vi.resetModules();
  });

  const loadRuntime = async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-backup-models-'));
    originalHome = process.env.HOME;
    originalOpenCodeConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = tempHome;
    delete process.env.OPENCODE_CONFIG_DIR;
    vi.resetModules();
    return import('./opencodeConfig');
  };

  it('normalizes backup model payloads to provider/model plus variant', async () => {
    const { normalizeAgentBackupModel } = await loadRuntime();

    expect(normalizeAgentBackupModel({ model: 'openai/gpt-5.5', variant: 'high' })).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });
    expect(normalizeAgentBackupModel({ model: 'openai/gpt-5.5' })).toEqual({ model: 'openai/gpt-5.5', variant: null });
    expect(normalizeAgentBackupModel({ model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: '  ' })).toEqual({ model: 'openai/gpt-5.5', variant: null });
    expect(normalizeAgentBackupModel({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'max' })).toEqual({ model: 'anthropic/claude-sonnet-4-6', variant: 'max' });

    expect(() => normalizeAgentBackupModel(undefined)).toThrow(/must be an object/);
    expect(() => normalizeAgentBackupModel({})).toThrow(/provider\/model/);
    expect(() => normalizeAgentBackupModel({ model: 'gpt-5.5' })).toThrow(/provider\/model/);
    expect(() => normalizeAgentBackupModel({ model: 'openai/gpt-5.5', variant: 7 })).toThrow(/variant must be a string or null/);
    expect(() => normalizeAgentBackupModel({ model: 'openai/gpt-5.5', councillors: [] })).toThrow(/Only model and variant/);
  });

  it('round-trips a backup model through the sidecar and attaches it to agent records', async () => {
    const {
      deleteAgentBackupModel,
      getAgentConfig,
      listAgentBackupModels,
      listConfigAgents,
      readAgentBackupModel,
      writeAgentBackupModel,
      writeAgentModelOverride,
    } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-backup-project-'));
    const sidecarPath = path.join(tempHome, '.config', 'opencode', '.openchamber', 'config.json');
    writeAgentMarkdown(path.join(projectDir, '.opencode', 'agents'), 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
      'variant: low',
    ]);

    try {
      expect(getAgentConfig('builder', projectDir).config.backupModel).toBeNull();
      expect(listConfigAgents(projectDir).find((agent) => agent.name === 'builder').backupModel).toBeNull();
      expect(readAgentBackupModel('builder')).toBeNull();

      expect(writeAgentBackupModel('builder', { model: 'openai/gpt-5.5', variant: 'high' }, projectDir))
        .toEqual({ model: 'openai/gpt-5.5', variant: 'high' });

      const sidecar = readJson(sidecarPath);
      expect(sidecar.agentBackupModels).toEqual({ builder: { model: 'openai/gpt-5.5', variant: 'high' } });
      expect(sidecar).not.toHaveProperty('agentOverrides');
      const opencodeConfig = readJson(path.join(tempHome, '.config', 'opencode', 'config.json'));
      expect(opencodeConfig).not.toHaveProperty('openchamber');
      expect(opencodeConfig).not.toHaveProperty('agentBackupModels');

      expect(listAgentBackupModels()).toEqual({ builder: { model: 'openai/gpt-5.5', variant: 'high' } });
      expect(readAgentBackupModel('builder')).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });

      const config = getAgentConfig('builder', projectDir).config;
      expect(config.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
      expect(config.variant).toBe('low');
      expect(config.overrides).toEqual({ model: false, variant: false, councillors: false });
      expect(config.backupModel).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
      expect(listConfigAgents(projectDir).find((agent) => agent.name === 'builder').backupModel)
        .toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });

      expect(() => writeAgentBackupModel('builder', { model: 'anthropic/claude-sonnet-4-5' }, projectDir))
        .toThrow(/must differ from the primary model/);
      expect(() => writeAgentBackupModel('ghost', { model: 'openai/gpt-5.5' }, projectDir)).toThrow(/not found/);
      expect(() => writeAgentBackupModel('builder', { model: 'nope' }, projectDir)).toThrow(/provider\/model/);

      writeAgentModelOverride('builder', { model: 'openai/gpt-5.5', variant: 'medium' }, projectDir);
      expect(() => writeAgentBackupModel('builder', { model: 'openai/gpt-5.5' }, projectDir))
        .toThrow(/must differ from the primary model/);
      const overridden = readJson(sidecarPath);
      expect(overridden.agentOverrides.builder).toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });
      expect(overridden.agentOverrides.builder).not.toHaveProperty('backupModel');
      expect(overridden.agentBackupModels.builder).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });

      expect(deleteAgentBackupModel('builder')).toBe(true);
      expect(deleteAgentBackupModel('builder')).toBe(false);
      expect(readAgentBackupModel('builder')).toBeNull();
      expect(getAgentConfig('builder', projectDir).config.backupModel).toBeNull();
      expect(readJson(sidecarPath).agentOverrides.builder).toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
