import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  getAgentConfig,
  listConfigAgents,
  writeAgentModelOverride,
} from './agents.js';
import { DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC } from './slim-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');

const writeAgentMarkdown = async (agentDirectory, name, frontmatterLines) => {
  await fs.mkdir(agentDirectory, { recursive: true });
  await fs.writeFile(
    path.join(agentDirectory, `${name}.md`),
    [
      '---',
      ...frontmatterLines,
      '---',
      '',
      `${name} prompt`,
      '',
    ].join('\n'),
    'utf8',
  );
};

const writeProjectAgent = async (projectDirectory, name, frontmatterLines) => (
  writeAgentMarkdown(path.join(projectDirectory, '.opencode', 'agents'), name, frontmatterLines)
);

const writeSlimInstalledAgent = async (slimConfigDirectory, name, frontmatterLines) => (
  writeAgentMarkdown(path.join(slimConfigDirectory, 'agents'), name, frontmatterLines)
);

const writeJson = async (filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const readJsonc = async (filePath) => parseJsonc(await fs.readFile(filePath, 'utf8'), [], { allowTrailingComma: true });

describe('agent model overrides', () => {
  let tempRoot;
  let projectDirectory;
  let userConfigPath;

  beforeEach(async () => {
    await fs.mkdir(path.join(repoRoot, '.cache'), { recursive: true });
    tempRoot = await fs.mkdtemp(path.join(repoRoot, '.cache', 'agent-model-overrides-'));
    projectDirectory = path.join(tempRoot, 'project');
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('replaces markdown modelRefs when applying a saved scalar model override', async () => {
    await writeProjectAgent(projectDirectory, 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
      'modelRefs:',
      '  - anthropic/claude-sonnet-4-5',
      'variant: low',
    ]);

    writeAgentModelOverride(
      'builder',
      { model: 'openai/gpt-5.5', variant: 'high' },
      projectDirectory,
      { userConfigPath },
    );

    const config = getAgentConfig('builder', projectDirectory, { userConfigPath }).config;
    const listed = listConfigAgents(projectDirectory, { userConfigPath }).find((agent) => agent.name === 'builder');

    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.modelRefs).toEqual(['openai/gpt-5.5']);
    expect(config.variant).toBe('high');
    expect(listed?.modelRefs).toEqual(['openai/gpt-5.5']);
  });

  it('clears an inherited thinking variant when the override variant is null', async () => {
    await writeProjectAgent(projectDirectory, 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
      'variant: low',
    ]);

    writeAgentModelOverride(
      'builder',
      { model: 'openai/gpt-5.5', variant: null },
      projectDirectory,
      { userConfigPath },
    );

    const config = getAgentConfig('builder', projectDirectory, { userConfigPath }).config;

    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.modelRefs).toEqual(['openai/gpt-5.5']);
    expect(config.variant).toBeUndefined();
  });

  it('preserves ordered Council councillor modelRefs while keeping the scalar model as synthesizer', async () => {
    await writeProjectAgent(projectDirectory, 'council', [
      'mode: all',
      'model: anthropic/claude-sonnet-4-5',
      'modelRefs:',
      '  - anthropic/claude-sonnet-4-5',
      'variant: low',
    ]);

    writeAgentModelOverride(
      'council',
      {
        model: 'openai/gpt-5.5',
        variant: 'medium',
        councillors: [
          { model: 'openai/gpt-5.3-codex', variant: 'high' },
          { model: 'opencode-go/kimi-k2.6', variant: null },
        ],
      },
      projectDirectory,
      { userConfigPath },
    );

    const config = getAgentConfig('council', projectDirectory, { userConfigPath }).config;

    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.variant).toBe('medium');
    expect(config.councillors).toEqual([
      { model: 'openai/gpt-5.3-codex', variant: 'high' },
      { model: 'opencode-go/kimi-k2.6', variant: null },
    ]);
    expect(config.modelRefs).toEqual([
      'openai/gpt-5.3-codex',
      'opencode-go/kimi-k2.6',
    ]);
  });

  it('lists Slim-managed agents instead of stale packaged defaults when the Slim plugin is active', async () => {
    const slimConfigDirectory = path.dirname(userConfigPath);
    await writeJson(userConfigPath, {
      plugin: ['opencode-with-claude'],
    });
    await writeJson(path.join(slimConfigDirectory, 'opencode.json'), {
      plugin: ['oh-my-opencode-slim'],
    });
    await writeJson(path.join(slimConfigDirectory, 'oh-my-opencode-slim.json'), {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*'] },
          designer: { model: 'openai/gpt-5.4-mini', variant: 'medium', skills: [], mcps: [] },
          fixer: { model: 'openai/gpt-5.5', variant: 'low', skills: [], mcps: [] },
        },
      },
    });
    await writeSlimInstalledAgent(slimConfigDirectory, 'builder', [
      'mode: primary',
      'model: openai/gpt-5.5',
      'variant: medium',
    ]);
    await writeSlimInstalledAgent(slimConfigDirectory, 'council', [
      'mode: all',
      'model: openai/gpt-5.5',
      'modelRefs:',
      '  - openai/gpt-5.5',
      '  - opencode/claude-opus-4-5',
      'variant: medium',
    ]);
    await writeProjectAgent(projectDirectory, 'orchestrator', [
      'mode: primary',
      'model: stale/project-orchestrator',
      'variant: stale',
    ]);
    await writeProjectAgent(projectDirectory, 'council', [
      'mode: all',
      'model: stale/project-council',
      'variant: stale',
    ]);
    await writeProjectAgent(projectDirectory, 'custom-reviewer', [
      'mode: subagent',
      'model: openai/gpt-5.4',
    ]);

    const agents = listConfigAgents(projectDirectory, { userConfigPath, slimConfigDirectory });
    const names = agents.map((agent) => agent.name);
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');

    expect(names).toContain('custom-reviewer');
    expect(names).toContain('orchestrator');
    expect(names).toContain('designer');
    expect(names).toContain('fixer');
    expect(names).toContain('builder');
    expect(names).toContain('council');
    expect(orchestrator).toMatchObject({
      scope: 'slim',
      source: 'slim',
      mode: 'primary',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      modelRefs: ['openai/gpt-5.5'],
      variant: 'medium',
      overrides: { model: false, variant: false, councillors: false },
    });

    expect(agents.find((agent) => agent.name === 'council')).toMatchObject({
      scope: 'slim',
      source: 'slim',
      mode: 'all',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      modelRefs: ['openai/gpt-5.5', 'opencode/claude-opus-4-5'],
      variant: 'medium',
    });
  });

  it('writes Slim-managed model overrides to oh-my-opencode-slim config instead of the DevRyan sidecar', async () => {
    const slimConfigDirectory = path.dirname(userConfigPath);
    const slimConfigPath = path.join(slimConfigDirectory, 'oh-my-opencode-slim.json');
    await writeJson(userConfigPath, {
      plugin: ['oh-my-opencode-slim'],
    });
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*'] },
        },
      },
      agents: {
        orchestrator: { skills: ['*'], mcps: ['*'] },
      },
    });

    writeAgentModelOverride(
      'orchestrator',
      { model: 'openai/gpt-5.4-mini', variant: null },
      projectDirectory,
      { userConfigPath, slimConfigDirectory },
    );

    const slimConfig = await readJsonc(slimConfigPath);
    expect(slimConfig.agents.orchestrator).toEqual({
      model: 'openai/gpt-5.4-mini',
      skills: ['*'],
      mcps: ['*'],
    });
    await expect(fs.stat(path.join(path.dirname(userConfigPath), '.openchamber', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const config = getAgentConfig('orchestrator', projectDirectory, { userConfigPath, slimConfigDirectory }).config;
    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.4-mini' });
    expect(config.variant).toBeUndefined();
    expect(config.overrides).toEqual({ model: true, variant: true, councillors: false });
  });

  it('routes Slim-installed global agent overrides to Slim config', async () => {
    const slimConfigDirectory = path.dirname(userConfigPath);
    const slimConfigPath = path.join(slimConfigDirectory, 'oh-my-opencode-slim.json');
    await writeJson(userConfigPath, {
      plugin: ['oh-my-opencode-slim'],
    });
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
        },
      },
    });
    await writeSlimInstalledAgent(slimConfigDirectory, 'council', [
      'mode: all',
      'model: openai/gpt-5.5',
      'variant: medium',
    ]);

    writeAgentModelOverride(
      'council',
      { model: 'openai/gpt-5.4-mini', variant: 'low' },
      projectDirectory,
      { userConfigPath, slimConfigDirectory },
    );

    const slimConfig = await readJsonc(slimConfigPath);
    expect(slimConfig.agents.council).toEqual({
      model: 'openai/gpt-5.4-mini',
      variant: 'low',
    });

    const config = getAgentConfig('council', projectDirectory, { userConfigPath, slimConfigDirectory }).config;
    expect(config.scope).toBe('slim');
    expect(config.source).toBe('slim');
    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.4-mini' });
    expect(config.variant).toBe('low');
    expect(config.prompt).toBe('council prompt');
  });

  it('keeps DevRyan project agents authoritative in wrapper mode while applying Slim model metadata', async () => {
    const slimConfigDirectory = path.dirname(userConfigPath);
    const slimConfigPath = path.join(slimConfigDirectory, 'oh-my-opencode-slim.json');
    await writeJson(userConfigPath, {
      plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC],
    });
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium', skills: ['*'], mcps: ['*'] },
          fixer: { model: 'openai/gpt-5.5', variant: 'low', skills: [], mcps: [] },
          'slim-only': { model: 'openai/gpt-5.4-mini', variant: 'low' },
        },
      },
    });
    await writeSlimInstalledAgent(slimConfigDirectory, 'orchestrator', [
      'mode: primary',
      'model: stale/slim',
      'permission:',
      '  "*": allow',
    ]);
    await writeProjectAgent(projectDirectory, 'orchestrator', [
      'mode: primary',
      'model: stale/project-orchestrator',
      'variant: stale',
      'permission:',
      '  "*": deny',
      '  task:',
      '    fixer: allow',
    ]);

    const agents = listConfigAgents(projectDirectory, { userConfigPath, slimConfigDirectory });
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    const fixer = agents.find((agent) => agent.name === 'fixer');

    expect(orchestrator).toMatchObject({
      scope: 'project',
      source: 'project',
      prompt: 'orchestrator prompt',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      modelRefs: ['openai/gpt-5.5'],
      variant: 'medium',
      permission: {
        '*': 'deny',
        task: { fixer: 'allow' },
      },
      overrides: { model: false, variant: false, councillors: false },
    });
    expect(fixer).toMatchObject({
      scope: 'packaged',
      source: 'packaged',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      variant: 'low',
    });
    expect(agents.find((agent) => agent.name === 'slim-only')).toMatchObject({
      scope: 'slim',
      source: 'slim',
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
    });

    writeAgentModelOverride(
      'orchestrator',
      { model: 'openai/gpt-5.4-mini', variant: null },
      projectDirectory,
      { userConfigPath, slimConfigDirectory },
    );

    const slimConfig = await readJsonc(slimConfigPath);
    expect(slimConfig.agents.orchestrator).toEqual({
      model: 'openai/gpt-5.4-mini',
    });
    await expect(fs.stat(path.join(path.dirname(userConfigPath), '.openchamber', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getAgentConfig('orchestrator', projectDirectory, { userConfigPath, slimConfigDirectory }).config).toMatchObject({
      scope: 'project',
      source: 'project',
      model: { providerID: 'openai', modelID: 'gpt-5.4-mini' },
      overrides: { model: true, variant: true, councillors: false },
    });
  });
});
