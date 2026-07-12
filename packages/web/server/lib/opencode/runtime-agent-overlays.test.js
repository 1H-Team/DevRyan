import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';

import { deleteAgentModelOverride, writeAgentModelOverride } from './agents.js';
import * as authModule from './auth.js';
import { GITHUB_COPILOT_AUTO_MODEL } from './github-copilot-models.js';
import { syncRuntimeAgentOverlays } from './runtime-agent-overlays.js';
import { DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE, DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC } from './slim-config.js';

const writeAgent = async (agentDirectory, name, frontmatterLines, prompt) => {
  await fs.mkdir(agentDirectory, { recursive: true });
  await fs.writeFile(
    path.join(agentDirectory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      ...frontmatterLines,
      '---',
      '',
      prompt,
      '',
    ].join('\n'),
    'utf8',
  );
};

const readOverlayAgent = async (overlayDirectory, name) => {
  const content = await fs.readFile(path.join(overlayDirectory, 'agents', `${name}.md`), 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  expect(match).toBeTruthy();
  return {
    content,
    frontmatter: yaml.parse(match[1]) || {},
    prompt: match[2].trim(),
  };
};

const readManifest = async (manifestPath) => JSON.parse(await fs.readFile(manifestPath, 'utf8'));

const writeJson = async (filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const runtimeDirectoryAllows = (...directories) => Object.fromEntries(
  directories.flatMap((directory) => {
    const resolved = path.resolve(directory);
    const candidates = [resolved];
    try {
      const real = fsSync.realpathSync(resolved);
      if (real && real !== resolved) candidates.push(real);
    } catch {
    }
    return candidates.map((candidate) => [`${candidate.replace(/\/+$/, '')}/*`, 'allow']);
  }),
);

const BLOCKED_MCP_TOMBSTONES = {
  context7: { enabled: false },
  ghgrep: { enabled: false },
  'gh-grep': { enabled: false },
  gh_grep: { enabled: false },
  'grep-app': { enabled: false },
  grep_app: { enabled: false },
};

describe('syncRuntimeAgentOverlays', () => {
  let tempRoot;
  let projectDirectory;
  let packagedAgentDirectory;
  let packagedPluginDirectory;
  let overlayRoot;
  let manifestPath;
  let targetConfigDirectory;
  let readAuthSpy;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-runtime-agent-overlays-'));
    projectDirectory = path.join(tempRoot, 'project');
    packagedAgentDirectory = path.join(tempRoot, 'packaged-agents');
    packagedPluginDirectory = path.join(tempRoot, 'packaged-plugins');
    overlayRoot = path.join(tempRoot, 'runtime-overlays');
    manifestPath = path.join(overlayRoot, 'manifest.json');
    targetConfigDirectory = path.join(overlayRoot, crypto.createHash('sha256').update(projectDirectory).digest('hex'));
    // Keep suite hermetic: real machine Copilot auth must not leak into overlay expectations.
    readAuthSpy = vi.spyOn(authModule, 'readAuthFile').mockReturnValue({});
  });

  afterEach(async () => {
    readAuthSpy?.mockRestore();
    readAuthSpy = undefined;
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('writes project agent overlays with user model settings while preserving project prompt and permissions', async () => {
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: anthropic/claude-sonnet-4-5',
      'modelRefs:',
      '  - anthropic/claude-sonnet-4-5',
      'variant: low',
      'permission:',
      '  "*": allow',
      '  read:',
      '    "*.env": ask',
    ], 'Project builder prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        builder: {
          model: 'openai/gpt-5.5',
          variant: 'high',
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'builder');
    expect(result.changed).toBe(true);
    expect(result.written).toEqual(['builder']);
    expect(overlay.frontmatter).toMatchObject({
      name: 'builder',
      mode: 'subagent',
      model: 'openai/gpt-5.5',
      modelRefs: ['openai/gpt-5.5'],
      variant: 'high',
      permission: {
        '*': 'allow',
        read: { '*.env': 'ask' },
      },
    });
    expect(overlay.prompt).toBe('Project builder prompt');
  });

  it('preserves a stale Luna agent override without manufacturing provider availability', async () => {
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'explorer', [
      'mode: subagent',
      'model: openai/gpt-5.5',
    ], 'Project explorer prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        explorer: {
          model: 'openai/gpt-5.6-luna',
          variant: 'max',
        },
      },
      readAuthFile: () => ({}),
      writeAuthFile: () => {},
      readConfig: () => ({}),
      listMcpConfigs: () => [],
    });

    const runtimeConfig = JSON.parse(await fs.readFile(
      path.join(result.targetConfigDirectory, 'opencode.json'),
      'utf8',
    ));
    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'explorer');

    expect(overlay.frontmatter.model).toBe('openai/gpt-5.6-luna');
    expect(overlay.frontmatter.variant).toBe('max');
    expect(runtimeConfig.provider?.openai).toBeUndefined();
  });

  it('uses an OpenCode-compatible empty variant sentinel to clear inherited project thinking', async () => {
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: anthropic/claude-sonnet-4-5',
      'variant: low',
    ], 'Project builder prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        builder: {
          model: 'openai/gpt-5.5',
          variant: null,
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'builder');
    expect(overlay.frontmatter.model).toBe('openai/gpt-5.5');
    expect(overlay.frontmatter.modelRefs).toEqual(['openai/gpt-5.5']);
    expect(overlay.frontmatter.variant).toBe('');
  });

  it('writes Cursor model overrides into runtime overlay frontmatter', async () => {
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'fixer', [
      'mode: subagent',
      'model: openai/gpt-5.5',
      'modelRefs:',
      '  - openai/gpt-5.5',
      'variant: high',
    ], 'Project fixer prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        fixer: {
          model: 'cursor-acp/composer-2.5',
          variant: null,
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'fixer');
    expect(overlay.frontmatter).toMatchObject({
      name: 'fixer',
      mode: 'subagent',
      model: 'cursor-acp/composer-2.5',
      modelRefs: ['cursor-acp/composer-2.5'],
      variant: '',
    });
    expect(overlay.prompt).toBe('Project fixer prompt');
  });

  it('prefers project prompt over same-name packaged prompt while applying the user model override', async () => {
    await writeAgent(packagedAgentDirectory, 'builder', [
      'mode: subagent',
      'model: packaged/old',
    ], 'Packaged prompt');
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: project/old',
    ], 'Project prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        builder: {
          model: 'openai/gpt-5.5',
          variant: 'medium',
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'builder');
    expect(overlay.frontmatter.model).toBe('openai/gpt-5.5');
    expect(overlay.frontmatter.variant).toBe('medium');
    expect(overlay.prompt).toBe('Project prompt');
  });

  it('writes packaged skill-policy overlays even when the agent has no user model override', async () => {
    await writeAgent(packagedAgentDirectory, 'builder', [
      'mode: subagent',
      'model: packaged/old',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '    /tmp/skills/frontend-design/*: allow',
      '    /tmp/skills/debugging/*: allow',
      '  skill:',
      '    frontend-design: allow',
    ], 'Packaged prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['frontend-design', 'project-audit'],
        skillDirectories: [
          '/tmp/skills/frontend-design',
          '/tmp/project/.opencode/skills/project-audit',
        ],
        skillDirectoriesByName: {
          'frontend-design': ['/tmp/skills/frontend-design'],
          'project-audit': ['/tmp/project/.opencode/skills/project-audit'],
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'builder');
    expect(result.written).toEqual(['builder']);
    expect(overlay.frontmatter.permission.skill).toEqual({
      '*': 'deny',
      'frontend-design': 'allow',
      'project-audit': 'allow',
    });
    expect(overlay.frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      ...runtimeDirectoryAllows(projectDirectory),
      '/tmp/skills/frontend-design/*': 'allow',
      '/tmp/project/.opencode/skills/project-audit/*': 'allow',
    });
    expect(overlay.prompt).toBe('Packaged prompt');
  });

  it('writes packaged overlays with active project and worktree external-directory allows', async () => {
    const worktreeRoot = path.join(tempRoot, 'repo');
    const appDirectory = path.join(worktreeRoot, 'packages', 'app');
    projectDirectory = appDirectory;
    await fs.mkdir(path.join(worktreeRoot, '.git'), { recursive: true });
    await writeAgent(packagedAgentDirectory, 'explorer', [
      'mode: subagent',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '  read:',
      '    "*.env": ask',
      '  skill:',
      '    codemap: allow',
    ], 'Packaged prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: appDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['codemap'],
        skillDirectories: ['/tmp/skills/codemap'],
        skillDirectoriesByName: {
          codemap: ['/tmp/skills/codemap'],
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'explorer');
    expect(result.written).toEqual(['explorer']);
    expect(overlay.frontmatter.permission.read).toEqual({ '*.env': 'ask' });
    expect(overlay.frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      ...runtimeDirectoryAllows(worktreeRoot, appDirectory),
      '/tmp/skills/codemap/*': 'allow',
    });
  });

  it('copies the active Slim config into the managed overlay config directory', async () => {
    const opencodeConfigDirectory = path.join(tempRoot, 'opencode-config');
    const slimConfigPath = path.join(opencodeConfigDirectory, 'oh-my-opencode-slim.json');
    const slimConfig = {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
          designer: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
        },
      },
    };
    await writeJson(slimConfigPath, slimConfig);

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      slimConfigDirectory: opencodeConfigDirectory,
      readConfig: () => ({ plugin: ['oh-my-opencode-slim'] }),
      readOpenCodeConfig: () => ({ plugin: ['oh-my-opencode-slim'] }),
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'oh-my-opencode-slim.json'), 'utf8'))
      .resolves.toBe(`${JSON.stringify(slimConfig, null, 2)}\n`);
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8'))
      .resolves.toContain('oh-my-opencode-slim');
    expect(result.slimConfigWritten).toBe(true);
  });

  it('materializes wrapper-mode Slim model saves into managed agent overlays', async () => {
    const opencodeConfigDirectory = path.join(tempRoot, 'opencode-config');
    const userConfigPath = path.join(opencodeConfigDirectory, 'opencode.json');
    const slimConfigPath = path.join(opencodeConfigDirectory, 'oh-my-opencode-slim.json');
    const wrapperSource = 'export default async function wrapper() { return {}; }\n';
    await writeJson(userConfigPath, {
      plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC],
    });
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
        },
      },
    });
    await writeAgent(packagedAgentDirectory, 'fixer', [
      'mode: subagent',
      'model: openai/gpt-5.5',
      'modelRefs:',
      '  - openai/gpt-5.5',
      'variant: medium',
    ], 'Packaged DevRyan fixer prompt');
    await fs.mkdir(packagedPluginDirectory, { recursive: true });
    await fs.writeFile(path.join(packagedPluginDirectory, DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE), wrapperSource, 'utf8');

    writeAgentModelOverride(
      'fixer',
      { model: 'openai/gpt-5.6-terra', variant: 'low' },
      projectDirectory,
      {
        userConfigPath,
        slimConfigDirectory: opencodeConfigDirectory,
      },
    );

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      userConfigPath,
      slimConfigDirectory: opencodeConfigDirectory,
      readConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      readOpenCodeConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      skillPolicy: {
        skillNames: [],
        skillDirectories: [],
        skillDirectoriesByName: {},
      },
    });

    const overlayConfig = JSON.parse(await fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8'));
    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'fixer');
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'oh-my-opencode-slim.json'), 'utf8'))
      .resolves.toContain('"preset": "openai"');
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'plugins', DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE), 'utf8'))
      .resolves.toBe(wrapperSource);
    expect(overlayConfig.plugin).toContain(DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC);
    expect(overlay.prompt).toBe('Packaged DevRyan fixer prompt');
    expect(overlay.frontmatter.model).toBe('openai/gpt-5.6-terra');
    expect(overlay.frontmatter.modelRefs).toEqual(['openai/gpt-5.6-terra']);
    expect(overlay.frontmatter.variant).toBe('low');
  });

  it('updates wrapper-mode Slim overlays and restores preset values after reset', async () => {
    const opencodeConfigDirectory = path.join(tempRoot, 'opencode-config');
    const userConfigPath = path.join(opencodeConfigDirectory, 'opencode.json');
    await writeJson(userConfigPath, {
      plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC],
    });
    await writeJson(path.join(opencodeConfigDirectory, 'oh-my-opencode-slim.json'), {
      preset: 'openai',
      presets: {
        openai: {
          fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
        },
      },
    });
    await writeAgent(packagedAgentDirectory, 'fixer', [
      'mode: subagent',
      'model: openai/gpt-5.5',
      'variant: medium',
    ], 'Packaged DevRyan fixer prompt');

    const writeOptions = {
      userConfigPath,
      slimConfigDirectory: opencodeConfigDirectory,
    };
    const syncOptions = {
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      userConfigPath,
      slimConfigDirectory: opencodeConfigDirectory,
      readConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      readOpenCodeConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      skillPolicy: {
        skillNames: [],
        skillDirectories: [],
        skillDirectoriesByName: {},
      },
    };

    writeAgentModelOverride('fixer', { model: 'openai/gpt-5.6-terra', variant: 'low' }, projectDirectory, writeOptions);
    await syncRuntimeAgentOverlays(syncOptions);
    writeAgentModelOverride('fixer', { model: 'openai/gpt-5.7', variant: 'high' }, projectDirectory, writeOptions);

    const updated = await syncRuntimeAgentOverlays(syncOptions);
    const updatedOverlay = await readOverlayAgent(updated.targetConfigDirectory, 'fixer');
    expect(updated.updated).toContain('fixer');
    expect(updatedOverlay.frontmatter.model).toBe('openai/gpt-5.7');
    expect(updatedOverlay.frontmatter.variant).toBe('high');

    deleteAgentModelOverride('fixer', {
      ...writeOptions,
      workingDirectory: projectDirectory,
    });

    const reset = await syncRuntimeAgentOverlays(syncOptions);
    const resetOverlay = await readOverlayAgent(reset.targetConfigDirectory, 'fixer');
    expect(reset.updated).toContain('fixer');
    expect(resetOverlay.frontmatter.model).toBe('openai/gpt-5.5');
    expect(resetOverlay.frontmatter.variant).toBe('medium');
  });

  it('clears inherited variants in wrapper-mode Slim overlays', async () => {
    const opencodeConfigDirectory = path.join(tempRoot, 'opencode-config');
    const userConfigPath = path.join(opencodeConfigDirectory, 'opencode.json');
    await writeJson(userConfigPath, {
      plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC],
    });
    await writeJson(path.join(opencodeConfigDirectory, 'oh-my-opencode-slim.json'), {
      preset: 'openai',
      presets: {
        openai: {
          fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
        },
      },
    });
    await writeAgent(packagedAgentDirectory, 'fixer', [
      'mode: subagent',
      'model: openai/gpt-5.5',
      'variant: medium',
    ], 'Packaged DevRyan fixer prompt');

    writeAgentModelOverride(
      'fixer',
      { model: 'openai/gpt-5.6-terra', variant: null },
      projectDirectory,
      {
        userConfigPath,
        slimConfigDirectory: opencodeConfigDirectory,
      },
    );

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      userConfigPath,
      slimConfigDirectory: opencodeConfigDirectory,
      readConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      readOpenCodeConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      skillPolicy: {
        skillNames: [],
        skillDirectories: [],
        skillDirectoriesByName: {},
      },
    });
    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'fixer');
    expect(overlay.frontmatter.model).toBe('openai/gpt-5.6-terra');
    expect(overlay.frontmatter.variant).toBe('');
  });

  it('keeps project-directory allows out of global packaged agent sync output', async () => {
    await writeAgent(packagedAgentDirectory, 'explorer', [
      'mode: subagent',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '  skill:',
      '    codemap: allow',
    ], 'Packaged prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['codemap'],
        skillDirectories: [],
        skillDirectoriesByName: {
          codemap: [],
        },
      },
    });

    const sourceContent = await fs.readFile(path.join(packagedAgentDirectory, 'explorer.md'), 'utf8');
    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'explorer');
    expect(sourceContent).not.toContain(`${projectDirectory}/*`);
    expect(overlay.frontmatter.permission.external_directory).toMatchObject({
      '*': 'ask',
      ...runtimeDirectoryAllows(projectDirectory),
    });
  });

  it('updates stale project-directory allows when the working directory changes', async () => {
    const firstDirectory = path.join(tempRoot, 'project-one');
    const secondDirectory = path.join(tempRoot, 'project-two');
    const targetConfigDirectoryOverride = path.join(overlayRoot, 'stable-project-key');
    await writeAgent(packagedAgentDirectory, 'explorer', [
      'mode: subagent',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '  skill:',
      '    codemap: allow',
    ], 'Packaged prompt');

    const baseOptions = {
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      targetConfigDirectory: targetConfigDirectoryOverride,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['codemap'],
        skillDirectories: [],
        skillDirectoriesByName: {
          codemap: [],
        },
      },
    };

    await syncRuntimeAgentOverlays({
      ...baseOptions,
      workingDirectory: firstDirectory,
    });
    const result = await syncRuntimeAgentOverlays({
      ...baseOptions,
      workingDirectory: secondDirectory,
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'explorer');
    expect(result.updated).toEqual(['explorer']);
    expect(overlay.frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      ...runtimeDirectoryAllows(secondDirectory),
    });
  });

  it('writes skill-policy overlays for project agents that define skill permissions', async () => {
    await writeAgent(packagedAgentDirectory, 'builder', [
      'mode: subagent',
      'model: packaged/old',
      'permission:',
      '  skill:',
      '    frontend-design: allow',
    ], 'Packaged prompt');
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: project/old',
      'permission:',
      '  "*": allow',
      '  external_directory:',
      '    "*": ask',
      '    /tmp/skills/frontend-design/*: allow',
      '    /tmp/skills/debugging/*: allow',
      '  skill:',
      '    frontend-design: allow',
      '    debugging: allow',
    ], 'Project prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['frontend-design'],
        skillDirectories: ['/tmp/skills/frontend-design'],
        skillDirectoriesByName: {
          'frontend-design': ['/tmp/skills/frontend-design'],
        },
      },
    });

    const overlay = await readOverlayAgent(result.targetConfigDirectory, 'builder');
    expect(result.written).toEqual(['builder']);
    expect(overlay.frontmatter.permission.skill).toEqual({
      '*': 'deny',
      'frontend-design': 'allow',
    });
    expect(overlay.frontmatter.permission.external_directory).toEqual({
      '*': 'ask',
      ...runtimeDirectoryAllows(projectDirectory),
      '/tmp/skills/frontend-design/*': 'allow',
    });
    expect(overlay.prompt).toBe('Project prompt');
  });

  it('does not write skill-policy overlays for project agents without skill permissions', async () => {
    await writeAgent(packagedAgentDirectory, 'builder', [
      'mode: subagent',
      'model: packaged/old',
      'permission:',
      '  skill:',
      '    frontend-design: allow',
    ], 'Packaged prompt');
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: project/old',
    ], 'Project prompt');

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
      skillPolicy: {
        skillNames: ['frontend-design'],
        skillDirectories: ['/tmp/skills/frontend-design'],
        skillDirectoriesByName: {
          'frontend-design': ['/tmp/skills/frontend-design'],
        },
      },
    });

    await expect(fs.stat(path.join(result.targetConfigDirectory, 'agents', 'builder.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.written).toEqual([]);
  });

  it('removes stale overlay files after an override reset', async () => {
    await writeAgent(path.join(projectDirectory, '.opencode', 'agents'), 'builder', [
      'mode: subagent',
      'model: project/old',
    ], 'Project prompt');

    await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {
        builder: {
          model: 'openai/gpt-5.5',
          variant: 'medium',
        },
      },
    });

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      overlayRoot,
      manifestPath,
      agentOverrides: {},
    });

    await expect(fs.stat(path.join(targetConfigDirectory, 'agents', 'builder.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.removed).toEqual(['builder']);
    await expect(readManifest(manifestPath)).resolves.toMatchObject({
      projects: {
        [crypto.createHash('sha256').update(projectDirectory).digest('hex')]: {
          agents: {},
        },
      },
    });
  });

  it('writes runtime MCP timeouts for enabled remote MCP servers missing an explicit timeout', async () => {
    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({}),
      listMcpConfigs: () => [
        {
          name: 'slow-remote',
          type: 'remote',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          scope: 'user',
        },
        {
          name: 'explicit-timeout',
          type: 'remote',
          url: 'https://timeout.example.test/mcp',
          enabled: true,
          timeout: 30_000,
          scope: 'user',
        },
        {
          name: 'disabled-remote',
          type: 'remote',
          url: 'https://disabled.example.test/mcp',
          enabled: false,
          scope: 'user',
        },
        {
          name: 'project-remote',
          type: 'remote',
          url: 'https://project.example.test/mcp',
          enabled: true,
          scope: 'project',
        },
        {
          name: 'local-server',
          type: 'local',
          command: ['node', 'server.js'],
          enabled: true,
        },
      ],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: {
          ...BLOCKED_MCP_TOMBSTONES,
          'slow-remote': {
            type: 'remote',
            url: 'https://mcp.example.test/mcp',
            enabled: true,
            timeout: 5_000,
          },
        },
      });
    expect(result.configWritten).toBe(true);
  });

  it('carries Anthropic OAuth proxy config into the active runtime config while preserving MCP timeout overlays', async () => {
    const activeConfig = {
      plugin: ['opencode-with-claude'],
      provider: {
        anthropic: {
          options: {
            baseURL: 'http://127.0.0.1:3456',
            apiKey: 'dummy',
          },
        },
      },
    };

    await fs.mkdir(path.join(projectDirectory, '.opencode'), { recursive: true });
    await fs.writeFile(
      path.join(projectDirectory, '.opencode', 'opencode.json'),
      `${JSON.stringify(activeConfig, null, 2)}\n`,
      'utf8',
    );

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => activeConfig,
      listMcpConfigs: () => [
        {
          name: 'slow-remote',
          type: 'remote',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          scope: 'user',
        },
      ],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: {
          ...BLOCKED_MCP_TOMBSTONES,
          'slow-remote': {
            type: 'remote',
            url: 'https://mcp.example.test/mcp',
            enabled: true,
            timeout: 5_000,
          },
        },
        plugin: ['opencode-with-claude'],
        provider: {
          anthropic: {
            options: {
              baseURL: 'http://127.0.0.1:3456',
              apiKey: 'dummy',
            },
          },
        },
      });
    expect(result.configWritten).toBe(true);
  });

  it('preserves remote MCP OAuth, headers, and environment in timeout overlays', async () => {
    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({}),
      listMcpConfigs: () => [
        {
          name: 'supabase',
          type: 'remote',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          scope: 'user',
          headers: { 'X-Provider': 'supabase' },
          environment: { SUPABASE_PROJECT: 'example' },
          oauth: {
            redirectUri: 'http://localhost:55676/mcp/oauth/callback',
            scope: 'projects:read',
          },
        },
      ],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: {
          ...BLOCKED_MCP_TOMBSTONES,
          supabase: {
            type: 'remote',
            url: 'https://mcp.supabase.com/mcp',
            enabled: true,
            headers: { 'X-Provider': 'supabase' },
            environment: { SUPABASE_PROJECT: 'example' },
            oauth: {
              redirectUri: 'http://localhost:55676/mcp/oauth/callback',
              scope: 'projects:read',
            },
            timeout: 5_000,
          },
        },
      });
  });

  it('removes stale runtime MCP timeout config when no remote MCP needs it', async () => {
    await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({}),
      listMcpConfigs: () => [
        {
          name: 'slow-remote',
          type: 'remote',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          scope: 'user',
        },
      ],
    });

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({}),
      listMcpConfigs: () => [
        {
          name: 'slow-remote',
          type: 'remote',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          timeout: 10_000,
          scope: 'user',
        },
      ],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: BLOCKED_MCP_TOMBSTONES,
      });
    expect(result.configUpdated).toBe(true);
  });

  it('writes blocked MCP tombstones while preserving explicitly configured blocked MCP names', async () => {
    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({}),
      listMcpConfigs: () => [
        {
          name: 'context7',
          type: 'remote',
          url: 'https://context7.example.test/mcp',
          enabled: true,
          scope: 'user',
          timeout: 10_000,
        },
      ],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: {
          ...Object.fromEntries(
            Object.entries(BLOCKED_MCP_TOMBSTONES).filter(([name]) => name !== 'context7'),
          ),
        },
      });
    expect(result.configWritten).toBe(true);
  });

  it('copies and registers packaged runtime plugins while skipping test files', async () => {
    await fs.mkdir(packagedPluginDirectory, { recursive: true });
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'council-session.js'),
      'export const CouncilSessionPlugin = async () => ({ tool: { council_session: {} } });\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'openai-tool-schema-sanitizer.mjs'),
      'export default async () => ({ "tool.definition": async () => {} });\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'openai-tool-schema-sanitizer.test.mjs'),
      'throw new Error("test files must not be loaded as runtime plugins");\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'council-session.spec.js'),
      'throw new Error("spec files must not be loaded as runtime plugins");\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'types.d.ts'),
      'export type RuntimeOnly = never;\n',
      'utf8',
    );

    const activeConfig = {
      plugin: ['opencode-with-claude'],
      provider: {
        anthropic: {
          options: {
            baseURL: 'http://127.0.0.1:3456',
            apiKey: 'dummy',
          },
        },
      },
    };

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => activeConfig,
      listMcpConfigs: () => [
        {
          name: 'slow-remote',
          type: 'remote',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          scope: 'user',
        },
      ],
    });

    await expect(fs.readdir(result.targetPluginDirectory).then((files) => files.sort()))
      .resolves.toEqual(['council-session.js', 'openai-tool-schema-sanitizer.mjs']);
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'plugins', 'council-session.js'), 'utf8'))
      .resolves.toContain('council_session');
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'plugins', 'openai-tool-schema-sanitizer.mjs'), 'utf8'))
      .resolves.toContain('tool.definition');
    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: {
          ...BLOCKED_MCP_TOMBSTONES,
          'slow-remote': {
            type: 'remote',
            url: 'https://mcp.example.test/mcp',
            enabled: true,
            timeout: 5_000,
          },
        },
        plugin: [
          'opencode-with-claude',
          './plugins/council-session.js',
          './plugins/openai-tool-schema-sanitizer.mjs',
        ],
        provider: {
          anthropic: {
            options: {
              baseURL: 'http://127.0.0.1:3456',
              apiKey: 'dummy',
            },
          },
        },
      });
    expect(result.pluginsWritten).toEqual(['council-session.js', 'openai-tool-schema-sanitizer.mjs']);
  });

  it('filters active user plugin entries through the managed runtime allowlist while adding packaged runtime plugins', async () => {
    await fs.mkdir(packagedPluginDirectory, { recursive: true });
    await fs.writeFile(
      path.join(packagedPluginDirectory, 'council-session.js'),
      'export const CouncilSessionPlugin = async () => ({ tool: { council_session: {} } });\n',
      'utf8',
    );

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readConfig: () => ({
        plugin: [
          'opencode-antigravity-auth@latest',
          '@rama_nigg/open-cursor@latest',
          'cursor-acp',
          'opencode-with-claude',
          'oh-my-opencode-slim',
          'superpowers@git+https://github.com/obra/superpowers.git',
          'context7@latest',
          'grep-app@latest',
        ],
      }),
      listMcpConfigs: () => [],
    });

    await expect(fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8')
      .then((content) => JSON.parse(content)))
      .resolves.toEqual({
        mcp: BLOCKED_MCP_TOMBSTONES,
        plugin: [
          'opencode-antigravity-auth@latest',
          '@rama_nigg/open-cursor@latest',
          'cursor-acp',
          'opencode-with-claude',
          'oh-my-opencode-slim',
          './plugins/council-session.js',
        ],
      });
  });

  it('writes GitHub Copilot provider models into the runtime overlay when auth exists', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
          { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
        ],
      }),
    });

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readAuthFile: () => ({ 'github-copilot': { access: 'copilot-token' } }),
      writeAuthFile: () => {},
      fetchImpl,
      readConfig: () => ({}),
      listMcpConfigs: () => [],
    });

    expect(result.configWritten || result.configUpdated).toBe(true);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8'));
    expect(runtimeConfig.provider?.['github-copilot']).toEqual({
      name: 'GitHub Copilot',
      models: {
        auto: GITHUB_COPILOT_AUTO_MODEL,
        'gpt-5.3-codex': {
          id: 'gpt-5.3-codex',
          name: 'GPT-5.3 Codex',
          api: {
            id: 'gpt-5.3-codex',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
        'gpt-5.4-mini': {
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 Mini',
          api: {
            id: 'gpt-5.4-mini',
            url: 'https://api.githubcopilot.com',
            npm: '@ai-sdk/github-copilot',
          },
        },
      },
    });
  });

  it('does not synthesize direct OpenAI GPT-5.6 model availability', async () => {
    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      readAuthFile: () => ({}),
      writeAuthFile: () => {},
      readConfig: () => ({}),
      listMcpConfigs: () => [],
    });

    const runtimeConfig = JSON.parse(await fs.readFile(
      path.join(result.targetConfigDirectory, 'opencode.json'),
      'utf8',
    ));
    expect(runtimeConfig.provider?.openai).toBeUndefined();
    expect(runtimeConfig.provider?.anthropic).toBeUndefined();
  });

  it('writes GitHub Copilot provider models using auth-module fallback when readAuthFile is omitted', async () => {
    readAuthSpy.mockReturnValue({
      'github-copilot': { access: 'copilot-token' },
    });
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }],
      }),
    });

    const result = await syncRuntimeAgentOverlays({
      workingDirectory: projectDirectory,
      packagedAgentDirectory,
      packagedPluginDirectory,
      overlayRoot,
      manifestPath,
      writeAuthFile: () => {},
      fetchImpl,
      readConfig: () => ({}),
      listMcpConfigs: () => [],
    });

    expect(result.configWritten || result.configUpdated).toBe(true);
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(result.targetConfigDirectory, 'opencode.json'), 'utf8'));
    expect(runtimeConfig.provider?.['github-copilot']?.models?.['gpt-5.3-codex']?.api).toEqual({
      id: 'gpt-5.3-codex',
      url: 'https://api.githubcopilot.com',
      npm: '@ai-sdk/github-copilot',
    });
    expect(readAuthSpy).toHaveBeenCalled();
  });
});
