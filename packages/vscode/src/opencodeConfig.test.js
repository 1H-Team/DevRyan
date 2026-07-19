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
        'oh-my-opencode-slim',
        'opencode-with-claude',
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
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = undefined;
    originalSlimPreset = undefined;
    originalOpenAIApiKey = undefined;
    originalOpenCodeConfigDirectory = undefined;
    vi.resetModules();
  });

  const loadRuntime = async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-cursor-provider-'));
    originalHome = process.env.HOME;
    originalSlimPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
    originalOpenAIApiKey = process.env.OPENAI_API_KEY;
    originalOpenCodeConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = tempHome;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_CONFIG_DIR;
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

    expect(overlayConfig.plugin).toContain('@rama_nigg/open-cursor@latest');
    expect(overlayConfig.plugin).toContain('./plugins/openai-tool-schema-sanitizer.mjs');
    expect(overlayConfig.provider?.['cursor-acp']).toBeUndefined();
    expect(overlayConfig.provider?.openai).toBeUndefined();
    expect(JSON.stringify(readJson(configPath))).toContain('@rama_nigg/open-cursor@latest');
    fs.rmSync(projectDir, { recursive: true, force: true });
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

  it('adds the bounded OpenAI header timeout for OAuth auth while preserving plugin and MCP overlays', async () => {
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
        options: { headerTimeout: 60_000 },
      });
      expect(overlayConfig.provider.openai.models).toBeUndefined();
      expect(overlayConfig.plugin).toContain('opencode-antigravity-auth@latest');
      expect(overlayConfig.mcp.ghgrep).toEqual({ enabled: false });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds the bounded OpenAI header timeout for an API-key environment', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-env-'));
    process.env.OPENAI_API_KEY = 'test-api-key';

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai?.options?.headerTimeout).toBe(60_000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('adds the bounded OpenAI header timeout for an existing provider configuration', async () => {
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
        options: { headerTimeout: 60_000 },
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each([30_000, false])('preserves an explicit OpenAI header timeout of %s', async (headerTimeout) => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-openai-explicit-'));
    writeJson(path.join(projectDir, 'opencode.json'), {
      provider: {
        openai: {
          options: { headerTimeout },
        },
      },
    });

    try {
      const result = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(result.targetConfigDirectory, 'opencode.json'));
      expect(overlayConfig.provider?.openai?.options?.headerTimeout).toBe(headerTimeout);
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
        .provider?.openai?.options?.headerTimeout).toBe(60_000);

      fs.unlinkSync(authPath);
      const updated = syncRuntimeAgentOverlays(projectDir);
      const overlayConfig = readJson(path.join(updated.targetConfigDirectory, 'opencode.json'));
      expect(updated.changed).toBe(true);
      expect(overlayConfig.provider?.openai).toBeUndefined();
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

  it('adds active project external-directory allows to VS Code runtime agent overlays', async () => {
    const { syncRuntimeAgentOverlays } = await loadRuntime();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-vscode-overlay-repo-'));
    const projectDir = path.join(repoDir, 'packages', 'app');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), {
      openchamber: {
        agentOverrides: {
          explorer: {
            model: 'openai/gpt-5.5',
          },
        },
      },
    });

    const result = syncRuntimeAgentOverlays(projectDir);
    const frontmatter = readAgentFrontmatter(path.join(result.targetConfigDirectory, 'agents', 'explorer.md'));

    expect(frontmatter).toContain(`${repoDir}/*: allow`);
    expect(frontmatter).toContain(`${projectDir}/*: allow`);
    expect(frontmatter).toContain('"*": ask');
    expect(frontmatter).toContain('"*.env": ask');
    fs.rmSync(repoDir, { recursive: true, force: true });
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
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*', '!context7'] },
          designer: { model: 'openai/gpt-5.4-mini', variant: 'medium', skills: [], mcps: [] },
          fixer: { model: 'openai/gpt-5.5', variant: 'low', skills: [], mcps: [] },
        },
      },
      agents: {
        orchestrator: { skills: ['*'], mcps: ['*', '!context7'] },
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
        mcps: ['*', '!context7'],
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
      expect(overlayAgent).toContain('  - openai/gpt-5.4-mini');
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
        'oh-my-opencode-slim',
        'superpowers@git+https://github.com/obra/superpowers.git',
        'context7@latest',
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

      expect(overlayConfig.plugin).toContain('opencode-antigravity-auth@latest');
      expect(overlayConfig.plugin).toContain('@rama_nigg/open-cursor@latest');
      expect(overlayConfig.plugin).toContain('cursor-acp');
      expect(overlayConfig.plugin).toContain('oh-my-opencode-slim');
      expect(overlayConfig.plugin).toContain('./plugins/council-session.js');
      expect(overlayConfig.plugin).toContain('./plugins/openai-tool-schema-sanitizer.mjs');
      expect(overlayConfig.plugin).not.toContain('superpowers@git+https://github.com/obra/superpowers.git');
      expect(overlayConfig.plugin).not.toContain('context7@latest');
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
        context7: { type: 'remote', url: 'https://ambient.example.test/mcp' },
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
