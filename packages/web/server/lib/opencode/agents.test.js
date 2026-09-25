import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  deleteAgentBackupModel,
  getAgentConfig,
  listAgentBackupModels,
  listConfigAgents,
  listManagedRuntimeAgentModelOverrides,
  listShadowedAgentModelOverrides,
  normalizeAgentBackupModel,
  resolveLocalAgentBackupExecution,
  writeAgentBackupModel,
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

  it('projects a Council companion into the existing agent read-model contract', async () => {
    await writeProjectAgent(projectDirectory, 'council', [
      'mode: all',
      'model: openai/gpt-5.5',
    ]);
    await writeJson(path.join(projectDirectory, '.opencode', 'agents', 'council.models.json'), {
      version: 1,
      councillors: [
        { model: 'openai/gpt-5.5', variant: 'medium' },
        { model: 'opencode/deepseek-v4-flash' },
      ],
    });

    const config = getAgentConfig('council', projectDirectory, { userConfigPath }).config;

    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.councillors).toEqual([
      { model: 'openai/gpt-5.5', variant: 'medium' },
      { model: 'opencode/deepseek-v4-flash' },
    ]);
    expect(config.modelRefs).toEqual([
      'openai/gpt-5.5',
      'opencode/deepseek-v4-flash',
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

describe('agent backup models', () => {
  let tempRoot;
  let projectDirectory;
  let userConfigPath;
  let sidecarPath;

  beforeEach(async () => {
    await fs.mkdir(path.join(repoRoot, '.cache'), { recursive: true });
    tempRoot = await fs.mkdtemp(path.join(repoRoot, '.cache', 'agent-backup-models-'));
    projectDirectory = path.join(tempRoot, 'project');
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    sidecarPath = path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('normalizes backup model payloads to provider/model plus variant', () => {
    expect(normalizeAgentBackupModel({ model: 'openai/gpt-5.5', variant: 'high' })).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });
    expect(normalizeAgentBackupModel({ model: 'openai/gpt-5.5' })).toEqual({ model: 'openai/gpt-5.5', variant: null });
    expect(normalizeAgentBackupModel({ model: ' openai/gpt-5.5 ', variant: '  ' })).toEqual({ model: 'openai/gpt-5.5', variant: null });
    expect(normalizeAgentBackupModel({ model: { providerID: 'openai', modelID: 'gpt-5.5' }, variant: null })).toEqual({ model: 'openai/gpt-5.5', variant: null });
    expect(normalizeAgentBackupModel({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'max' })).toEqual({ model: 'anthropic/claude-sonnet-4-6', variant: 'max' });

    expect(() => normalizeAgentBackupModel(undefined)).toThrow(/must be an object/);
    expect(() => normalizeAgentBackupModel('openai/gpt-5.5')).toThrow(/must be an object/);
    expect(() => normalizeAgentBackupModel({})).toThrow(/provider\/model/);
    expect(() => normalizeAgentBackupModel({ model: '' })).toThrow(/provider\/model/);
    expect(() => normalizeAgentBackupModel({ model: 'gpt-5.5' })).toThrow(/provider\/model/);
    expect(() => normalizeAgentBackupModel({ model: 'openai/gpt-5.5', variant: 7 })).toThrow(/variant must be a string or null/);
    expect(() => normalizeAgentBackupModel({ model: 'openai/gpt-5.5', councillors: [] })).toThrow(/Only model and variant/);
  });

  it('resolves Explorer backup execution independently from its primary', async () => {
    await writeProjectAgent(projectDirectory, 'explorer', ['mode: subagent', 'model: openai/primary-model']);
    writeAgentBackupModel('explorer', { model: 'opencode/backup-model', variant: 'fast' }, projectDirectory, { userConfigPath });
    expect(resolveLocalAgentBackupExecution({ directory: projectDirectory, agent: 'Explorer', options: { userConfigPath } }))
      .toEqual({ providerId: 'opencode', modelId: 'backup-model', variant: 'fast' });
    expect(getAgentConfig('explorer', projectDirectory, { userConfigPath }).config.model)
      .toEqual({ providerID: 'openai', modelID: 'primary-model' });
  });

  it('round-trips a backup model through the sidecar without touching the primary model', async () => {
    await writeProjectAgent(projectDirectory, 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
      'variant: low',
    ]);

    expect(listConfigAgents(projectDirectory, { userConfigPath }).find((agent) => agent.name === 'builder')?.backupModel).toBeNull();
    expect(getAgentConfig('builder', projectDirectory, { userConfigPath }).config.backupModel).toBeNull();

    const saved = writeAgentBackupModel(
      'builder',
      { model: 'openai/gpt-5.5', variant: 'high' },
      projectDirectory,
      { userConfigPath },
    );
    expect(saved).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar.agentBackupModels).toEqual({ builder: { model: 'openai/gpt-5.5', variant: 'high' } });
    const opencodeConfig = await readJsonc(userConfigPath);
    expect(opencodeConfig).not.toHaveProperty('openchamber');
    expect(opencodeConfig).not.toHaveProperty('agentBackupModels');

    expect(listAgentBackupModels({ userConfigPath })).toEqual({ builder: { model: 'openai/gpt-5.5', variant: 'high' } });

    const config = getAgentConfig('builder', projectDirectory, { userConfigPath }).config;
    expect(config.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
    expect(config.variant).toBe('low');
    expect(config.overrides).toEqual({ model: false, variant: false, councillors: false });
    expect(config.backupModel).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });

    const listed = listConfigAgents(projectDirectory, { userConfigPath }).find((agent) => agent.name === 'builder');
    expect(listed?.backupModel).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
    expect(listed?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });

    expect(resolveLocalAgentBackupExecution({ directory: projectDirectory, agent: 'Builder', options: { userConfigPath } }))
      .toEqual({ providerId: 'openai', modelId: 'gpt-5.5', variant: 'high' });
    expect(resolveLocalAgentBackupExecution({ directory: projectDirectory, agent: 'missing', options: { userConfigPath } })).toBeNull();

    expect(deleteAgentBackupModel('builder', { userConfigPath })).toBe(true);
    expect(deleteAgentBackupModel('builder', { userConfigPath })).toBe(false);
    expect(getAgentConfig('builder', projectDirectory, { userConfigPath }).config.backupModel).toBeNull();
    expect(resolveLocalAgentBackupExecution({ directory: projectDirectory, agent: 'builder', options: { userConfigPath } })).toBeNull();
    expect(JSON.parse(await fs.readFile(sidecarPath, 'utf8')).agentBackupModels).toEqual({});
  });

  it('keeps backup models separate from agent overrides in the sidecar', async () => {
    await writeProjectAgent(projectDirectory, 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
    ]);

    writeAgentModelOverride('builder', { model: 'openai/gpt-5.5', variant: 'medium' }, projectDirectory, { userConfigPath });
    writeAgentBackupModel('builder', { model: 'anthropic/claude-sonnet-4-6', variant: null }, projectDirectory, { userConfigPath });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar.agentOverrides.builder).toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });
    expect(sidecar.agentOverrides.builder).not.toHaveProperty('backupModel');
    expect(sidecar.agentBackupModels.builder).toEqual({ model: 'anthropic/claude-sonnet-4-6', variant: null });

    const config = getAgentConfig('builder', projectDirectory, { userConfigPath }).config;
    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.variant).toBe('medium');
    expect(config.backupModel).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: null });

    expect(deleteAgentBackupModel('builder', { userConfigPath })).toBe(true);
    expect(JSON.parse(await fs.readFile(sidecarPath, 'utf8')).agentOverrides.builder).toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });
  });

  it('rejects a backup model equal to the effective primary model and unknown agents', async () => {
    await writeProjectAgent(projectDirectory, 'builder', [
      'mode: primary',
      'model: anthropic/claude-sonnet-4-5',
    ]);

    expect(() => writeAgentBackupModel('builder', { model: 'anthropic/claude-sonnet-4-5', variant: 'high' }, projectDirectory, { userConfigPath }))
      .toThrow(/must differ from the primary model/);

    writeAgentModelOverride('builder', { model: 'openai/gpt-5.5' }, projectDirectory, { userConfigPath });
    expect(() => writeAgentBackupModel('builder', { model: 'openai/gpt-5.5' }, projectDirectory, { userConfigPath }))
      .toThrow(/must differ from the primary model/);
    expect(writeAgentBackupModel('builder', { model: 'anthropic/claude-sonnet-4-5' }, projectDirectory, { userConfigPath }))
      .toEqual({ model: 'anthropic/claude-sonnet-4-5', variant: null });

    expect(() => writeAgentBackupModel('ghost', { model: 'openai/gpt-5.5' }, projectDirectory, { userConfigPath }))
      .toThrow(/not found/);
    expect(() => writeAgentBackupModel('builder', { model: 'nope' }, projectDirectory, { userConfigPath }))
      .toThrow(/provider\/model/);
    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.not.toContain('ghost');
  });

  it('ignores malformed sidecar entries instead of hiding agents', async () => {
    await writeProjectAgent(projectDirectory, 'builder', ['mode: primary', 'model: anthropic/claude-sonnet-4-5']);
    await writeJson(sidecarPath, {
      agentBackupModels: {
        builder: { model: 'not-a-ref' },
        other: 'garbage',
      },
    });

    expect(listAgentBackupModels({ userConfigPath })).toEqual({});
    const listed = listConfigAgents(projectDirectory, { userConfigPath }).find((agent) => agent.name === 'builder');
    expect(listed).toBeTruthy();
    expect(listed.backupModel).toBeNull();
  });

  it('stores Slim-managed agent backup models in the DevRyan sidecar, never in Slim config', async () => {
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
    const options = { userConfigPath, slimConfigDirectory };

    expect(() => writeAgentBackupModel('orchestrator', { model: 'openai/gpt-5.5' }, projectDirectory, options))
      .toThrow(/must differ from the primary model/);

    writeAgentBackupModel('orchestrator', { model: 'anthropic/claude-sonnet-4-6', variant: 'high' }, projectDirectory, options);

    const slimConfig = await readJsonc(slimConfigPath);
    expect(slimConfig.agents.orchestrator).toEqual({ skills: ['*'], mcps: ['*'] });
    expect(JSON.stringify(slimConfig)).not.toContain('claude-sonnet-4-6');
    expect(JSON.parse(await fs.readFile(sidecarPath, 'utf8')).agentBackupModels).toEqual({
      orchestrator: { model: 'anthropic/claude-sonnet-4-6', variant: 'high' },
    });

    const config = getAgentConfig('orchestrator', projectDirectory, options).config;
    expect(config.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(config.backupModel).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: 'high' });
    const listed = listConfigAgents(projectDirectory, options).find((agent) => agent.name === 'orchestrator');
    expect(listed?.backupModel).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: 'high' });
    expect(resolveLocalAgentBackupExecution({ directory: projectDirectory, agent: 'orchestrator', options }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'high' });

    expect(deleteAgentBackupModel('orchestrator', options)).toBe(true);
    expect(getAgentConfig('orchestrator', projectDirectory, options).config.backupModel).toBeNull();
  });
});

describe('shadowed sidecar agent overrides', () => {
  let tempRoot;
  let projectDirectory;
  let userConfigPath;
  let slimConfigDirectory;
  let sidecarPath;
  let plugins;
  let options;

  const writeSidecarOverrides = (agentOverrides) => writeJson(sidecarPath, { agentOverrides });
  const writeSlimConfig = (config) => writeJson(path.join(slimConfigDirectory, 'oh-my-opencode-slim.json'), config);
  const writeProjectSlimConfig = (config) => writeJson(path.join(projectDirectory, '.opencode', 'oh-my-opencode-slim.json'), config);

  // Every shadowed entry must describe what the managed runtime actually runs.
  const expectMirrorsRuntime = (shadowed) => {
    const runtime = listManagedRuntimeAgentModelOverrides(projectDirectory, options);
    for (const [agentName, entry] of Object.entries(shadowed)) {
      expect(runtime[agentName].variant).toBe(entry.effective.variant);
      if (runtime[agentName].model) {
        expect(runtime[agentName].model).toBe(entry.effective.model);
      }
    }
  };

  beforeEach(async () => {
    await fs.mkdir(path.join(repoRoot, '.cache'), { recursive: true });
    tempRoot = await fs.mkdtemp(path.join(repoRoot, '.cache', 'agent-shadowed-overrides-'));
    projectDirectory = path.join(tempRoot, 'project');
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    slimConfigDirectory = path.dirname(userConfigPath);
    sidecarPath = path.join(slimConfigDirectory, '.openchamber', 'config.json');
    await fs.mkdir(projectDirectory, { recursive: true });
    plugins = [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC];
    // Plugin detection is injected so no test reads the real OpenCode config.
    options = {
      userConfigPath,
      slimConfigDirectory,
      readOpenCodeConfig: () => ({ plugin: plugins }),
      env: {},
    };
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('shows the model that actually runs when a Slim entry sets only a variant', async () => {
    await writeSidecarOverrides({ oracle: { model: 'test/sidecar-model', variant: 'low' }, fixer: { model: 'openai/gpt-5.5' } });
    await writeSlimConfig({ agents: { oracle: { variant: 'high' }, fixer: { model: 'xai/grok-4.6', variant: 'high' } } });

    const runtime = listManagedRuntimeAgentModelOverrides(projectDirectory, options);
    const agents = Object.fromEntries(listConfigAgents(projectDirectory, options).map((agent) => [agent.name, agent]));
    const shown = (agent) => (typeof agent.model === 'string' ? agent.model : `${agent.model?.providerID}/${agent.model?.modelID}`);

    // No Slim model: the saved sidecar model runs, and Settings shows it.
    expect(runtime.oracle).toMatchObject({ model: 'test/sidecar-model', variant: 'high' });
    expect(shown(agents.oracle)).toBe('test/sidecar-model');
    expect(agents.oracle.variant).toBe('high');
    // A Slim model wins at runtime and in Settings.
    expect(runtime.fixer.model).toBe('xai/grok-4.6');
    expect(shown(agents.fixer)).toBe('xai/grok-4.6');
  });

  it('reports sidecar model and variant shadowed by a Slim root override without touching config', async () => {
    await writeSidecarOverrides({ fixer: { model: 'openai/gpt-5.5', variant: 'medium' } });
    await writeSlimConfig({ agents: { fixer: { model: 'xai/grok-4.6', variant: 'high' } } });
    const sidecarBefore = await fs.readFile(sidecarPath, 'utf8');

    const shadowed = listShadowedAgentModelOverrides(projectDirectory, options);

    expect(shadowed).toEqual({
      fixer: {
        fields: {
          model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-root' },
          variant: { saved: 'medium', effective: 'high', shadowedBy: 'slim-root' },
        },
        effective: { model: 'xai/grok-4.6', variant: 'high' },
        presetName: null,
      },
    });
    expectMirrorsRuntime(shadowed);
    expect(await fs.readFile(sidecarPath, 'utf8')).toBe(sidecarBefore);
    // The Settings read model already shows the effective Slim value, not the sidecar.
    expect(listConfigAgents(projectDirectory, options).find((agent) => agent.name === 'fixer')).toMatchObject({
      model: { providerID: 'xai', modelID: 'grok-4.6' },
      variant: 'high',
    });
  });

  it('attributes preset-only values to the preset and splits root variant from preset model', async () => {
    await writeSidecarOverrides({
      fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
      oracle: { model: 'openai/gpt-5.5', variant: 'medium' },
    });
    await writeSlimConfig({
      preset: 'team',
      presets: {
        team: {
          fixer: { model: 'xai/grok-4.6', variant: 'low', skills: [] },
          oracle: { model: 'xai/grok-4.6', variant: 'low' },
        },
      },
      agents: { oracle: { variant: 'xhigh' } },
    });

    const shadowed = listShadowedAgentModelOverrides(projectDirectory, options);

    expect(shadowed.fixer).toEqual({
      fields: {
        model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-preset' },
        variant: { saved: 'medium', effective: 'low', shadowedBy: 'slim-preset' },
      },
      effective: { model: 'xai/grok-4.6', variant: 'low' },
      presetName: 'team',
    });
    expect(shadowed.oracle.fields).toEqual({
      model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-preset' },
      variant: { saved: 'medium', effective: 'xhigh', shadowedBy: 'slim-root' },
    });
    expectMirrorsRuntime(shadowed);
  });

  it('keeps the sidecar model in effect when the Slim entry supplies no model', async () => {
    await writeSidecarOverrides({
      oracle: { model: 'test/sidecar-model', variant: 'medium' },
      explorer: { variant: 'low' },
      fixer: { variant: 'medium' },
    });
    await writeSlimConfig({
      preset: 'team',
      presets: { team: { fixer: { model: 'xai/grok-4.6' } } },
      agents: {
        oracle: { variant: 'high' },
        explorer: { skills: ['*'] },
      },
    });

    const shadowed = listShadowedAgentModelOverrides(projectDirectory, options);

    expect(shadowed.oracle).toEqual({
      fields: {
        variant: { saved: 'medium', effective: 'high', shadowedBy: 'slim-root' },
      },
      effective: { model: 'test/sidecar-model', variant: 'high' },
      presetName: 'team',
    });
    // A bare Slim entry still replaces the variant, falling back to the packaged model.
    expect(shadowed.explorer.fields).toEqual({
      variant: { saved: 'low', effective: null, shadowedBy: 'slim-root' },
    });
    expect(shadowed.explorer.effective.variant).toBeNull();
    expect(typeof shadowed.explorer.effective.model).toBe('string');
    // A preset entry without a variant clears the saved variant.
    expect(shadowed.fixer).toEqual({
      fields: {
        variant: { saved: 'medium', effective: null, shadowedBy: 'slim-preset' },
      },
      effective: { model: 'xai/grok-4.6', variant: null },
      presetName: 'team',
    });
    expectMirrorsRuntime(shadowed);
  });

  it('reports nothing when wrapper layering does not apply', async () => {
    await writeSidecarOverrides({ fixer: { model: 'openai/gpt-5.5', variant: 'medium' } });
    await writeSlimConfig({ agents: { fixer: { model: 'xai/grok-4.6', variant: 'high' } } });

    plugins = [];
    expect(listShadowedAgentModelOverrides(projectDirectory, options)).toEqual({});
    expect(listManagedRuntimeAgentModelOverrides(projectDirectory, options).fixer)
      .toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });

    // Raw Slim owns the catalog: the sidecar is not layered under Slim values.
    plugins = ['oh-my-opencode-slim'];
    expect(listShadowedAgentModelOverrides(projectDirectory, options)).toEqual({});
  });

  it('honors project-level Slim config over user Slim config', async () => {
    await writeSidecarOverrides({ fixer: { model: 'openai/gpt-5.5', variant: 'medium' } });
    await writeSlimConfig({ agents: { fixer: { model: 'anthropic/claude-sonnet-4-6', variant: 'low' } } });
    await writeProjectSlimConfig({ agents: { fixer: { model: 'xai/grok-4.6', variant: 'high' } } });

    const shadowed = listShadowedAgentModelOverrides(projectDirectory, options);

    expect(shadowed.fixer.fields).toEqual({
      model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-root' },
      variant: { saved: 'medium', effective: 'high', shadowedBy: 'slim-root' },
    });
    expectMirrorsRuntime(shadowed);
  });

  it('never shadows councillors and skips agents Slim does not layer', async () => {
    await writeSidecarOverrides({
      council: { model: 'openai/gpt-5.5', councillors: [{ model: 'openai/gpt-5.5' }, { model: 'xai/grok-4.6', variant: 'high' }] },
      librarian: { councillors: [{ model: 'openai/gpt-5.5' }] },
      builder: { model: 'openai/gpt-5.5', variant: 'medium' },
      'slim-only': { model: 'openai/gpt-5.5', variant: 'medium' },
    });
    await writeSlimConfig({
      agents: {
        council: { model: 'xai/grok-4.6', variant: 'high' },
        librarian: { model: 'xai/grok-4.6' },
        'slim-only': { model: 'xai/grok-4.6', variant: 'high' },
      },
    });

    const shadowed = listShadowedAgentModelOverrides(projectDirectory, options);

    expect(Object.keys(shadowed)).toEqual(['council']);
    expect(shadowed.council.fields).toEqual({
      model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-root' },
    });
    expect(listManagedRuntimeAgentModelOverrides(projectDirectory, options).council.councillors).toHaveLength(2);
    expectMirrorsRuntime(shadowed);
  });
});
