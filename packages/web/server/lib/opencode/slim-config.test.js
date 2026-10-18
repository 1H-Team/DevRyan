import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  resolveSlimConfig,
  writeSlimAgentModelOverride,
} from './slim-config.js';

const writeJson = async (filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const writeJsonc = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
};

const readJsonc = async (filePath) => parseJsonc(await fs.readFile(filePath, 'utf8'), [], { allowTrailingComma: true });

describe('oh-my-opencode-slim config adapter', () => {
  let tempRoot;
  let configDirectory;
  let projectDirectory;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-slim-config-'));
    configDirectory = path.join(tempRoot, 'opencode-config');
    projectDirectory = path.join(tempRoot, 'project');
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('merges active presets with user and project root agent overrides', async () => {
    await writeJsonc(path.join(configDirectory, 'oh-my-opencode-slim.jsonc'), `{
      // jsonc should be accepted
      "preset": "openai",
      "presets": {
        "openai": {
          "orchestrator": { "model": "openai/gpt-5.5", "variant": "medium", "skills": ["*"], "mcps": ["*"] },
          "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium", "skills": [], "mcps": [] },
          "fixer": { "model": "openai/gpt-5.5", "variant": "low", "skills": [], "mcps": [] },
          "observer": { "model": "openai/gpt-5.4-mini" }
        }
      },
      "agents": {
        "orchestrator": { "model": "openai/gpt-5.6-sol", "variant": "high" },
        "designer": { "model": "openai/gpt-5.5", "variant": "high", "skills": ["simplify"], "mcps": ["websearch"] }
      },
      "disabled_agents": ["observer"],
    }`);
    await writeJson(path.join(projectDirectory, '.opencode', 'oh-my-opencode-slim.json'), {
      agents: {
        fixer: { variant: 'high', mcps: ['docs-mcp'] },
      },
    });

    const resolved = resolveSlimConfig(projectDirectory, { configDirectory });

    expect(resolved.activePreset).toBe('openai');
    expect(resolved.agentNames).toEqual(['designer', 'fixer', 'orchestrator']);
    expect(resolved.agents.designer).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      modelRefs: ['openai/gpt-5.5'],
      variant: 'high',
      skills: ['simplify'],
      mcps: ['websearch'],
    });
    expect(resolved.agents.fixer).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      modelRefs: ['openai/gpt-5.5'],
      variant: 'high',
      mcps: ['docs-mcp'],
    });
    expect(resolved.agents.orchestrator).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      modelRefs: ['openai/gpt-5.6-sol'],
      variant: 'high',
      skills: ['*'],
      modelResolution: {
        presetName: 'openai',
        source: 'root-override',
        presetModelRef: 'openai/gpt-5.5',
        presetVariant: 'medium',
      },
    });
    expect(resolved.agents.observer).toBeUndefined();
  });

  it('resolves the built-in agent routing without any plugin registration', async () => {
    // Upgraded setups may still list the retired adapter; it changes nothing.
    await writeJson(path.join(configDirectory, 'opencode.json'), {
      plugin: ['./plugins/devryan-oh-my-opencode-slim.mjs'],
    });
    await writeJson(path.join(configDirectory, 'oh-my-opencode-slim.json'), {
      preset: 'openai',
      presets: {
        openai: {
          orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
          fixer: { model: 'openai/gpt-5.5', variant: 'low' },
        },
      },
    });
    const listed = resolveSlimConfig(projectDirectory, { configDirectory });
    await fs.rm(path.join(configDirectory, 'opencode.json'));
    const unlisted = resolveSlimConfig(projectDirectory, { configDirectory });

    expect(unlisted.agentNames).toEqual(['fixer', 'orchestrator']);
    expect(unlisted).toEqual(listed);
    expect(unlisted).not.toHaveProperty('pluginEnabled');
    expect(unlisted).not.toHaveProperty('enabled');
  });

  it('writes model overrides to root agents while preserving Slim-owned fields and deleting cleared variants', async () => {
    const slimConfigPath = path.join(configDirectory, 'oh-my-opencode-slim.jsonc');
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          oracle: { model: 'openai/gpt-5.5', variant: 'high', skills: ['simplify'], mcps: [] },
        },
      },
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          variant: 'high',
          skills: ['simplify'],
          mcps: ['websearch'],
          prompt: 'Keep the Slim prompt override.',
        },
      },
    });

    const override = writeSlimAgentModelOverride('oracle', {
      model: 'openai/gpt-5.4-mini',
      variant: null,
    }, { configDirectory });

    await expect(readJsonc(slimConfigPath)).resolves.toMatchObject({
      agents: {
        oracle: {
          model: 'openai/gpt-5.4-mini',
          skills: ['simplify'],
          mcps: ['websearch'],
          prompt: 'Keep the Slim prompt override.',
        },
      },
    });
    const written = await readJsonc(slimConfigPath);
    expect(written.agents.oracle).not.toHaveProperty('variant');
    expect(override).toEqual({ model: 'openai/gpt-5.4-mini', variant: null });
  });

  it('persists a Grok fixer model and low variant as one Slim override', async () => {
    const slimConfigPath = path.join(configDirectory, 'oh-my-opencode-slim.json');
    await writeJson(slimConfigPath, {
      preset: 'openai',
      presets: {
        openai: {
          fixer: { model: 'openai/gpt-5.5', variant: 'low' },
        },
      },
    });

    writeSlimAgentModelOverride('fixer', {
      model: 'cursor-acp/grok-4.5',
      variant: 'low',
    }, { configDirectory });

    await expect(readJsonc(slimConfigPath)).resolves.toMatchObject({
      agents: {
        fixer: {
          model: 'cursor-acp/grok-4.5',
          variant: 'low',
        },
      },
    });
    expect(resolveSlimConfig(projectDirectory, { configDirectory }).agents.fixer).toMatchObject({
      model: { providerID: 'cursor-acp', modelID: 'grok-4.5' },
      modelRefs: ['cursor-acp/grok-4.5'],
      variant: 'low',
    });
  });
});
