import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '../../test-supertest.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE,
  DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
  SLIM_MANAGED_VERSION,
  createSlimSetupRuntime,
  registerSlimSetupRoutes,
} from './slim-install.js';

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('Slim setup runtime', () => {
  let root;
  let home;
  let configDir;
  let commands;

  const createRuntime = (overrides = {}) => createSlimSetupRuntime({
    fs,
    path,
    homedir: () => home,
    env: {},
    now: () => new Date('2026-06-27T12:34:56.000Z'),
    runCommand: async (command, args, options) => {
      commands.push({ command, args, cwd: options?.cwd });
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-slim-install-'));
    home = path.join(root, 'home');
    configDir = path.join(home, '.config', 'opencode');
    commands = [];
  });

  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  it('detects missing Slim setup before mutation', async () => {
    const status = await createRuntime().getStatus();

    expect(status.installedVersion).toBeNull();
    expect(status.runtimeEnabled).toBe(false);
    expect(status.wrapperConfigured).toBe(false);
    expect(status.packageDependencyInstalled).toBe(false);
    expect(status.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'slim-package-missing' }),
      expect.objectContaining({ code: 'slim-wrapper-missing' }),
    ]));
  });

  it('installs the DevRyan wrapper while preserving existing provider, MCP, and non-Slim plugin config', async () => {
    const opencodeConfigPath = path.join(configDir, 'opencode.json');
    const slimConfigPath = path.join(configDir, 'oh-my-opencode-slim.json');
    writeJson(opencodeConfigPath, {
      provider: {
        anthropic: { npm: '@ai-sdk/anthropic' },
      },
      mcp: {
        context7: { type: 'remote', url: 'https://mcp.example.test' },
      },
      plugin: [
        'opencode-with-claude',
        'oh-my-opencode-slim',
        ['local-plugin', { enabled: true }],
      ],
      agent: {
        explore: { disable: false },
        custom: { description: 'keep me' },
      },
    });
    writeJson(slimConfigPath, {
      preset: 'custom',
      presets: { custom: { orchestrator: { model: 'test/original' } } },
    });

    const result = await createRuntime().install();
    const opencodeConfig = readJson(opencodeConfigPath);
    const packageJson = readJson(path.join(configDir, 'package.json'));
    const wrapperPath = path.join(configDir, 'plugins', DEVRYAN_SLIM_WRAPPER_PLUGIN_FILE);
    const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');

    expect(result.ok).toBe(true);
    expect(result.installedVersion).toBe(SLIM_MANAGED_VERSION);
    expect(result.wrapperStatus.configured).toBe(true);
    expect(result.backupPaths).toEqual(expect.arrayContaining([
      expect.stringContaining('opencode.json.devryan-slim-backup-20260627T123456000Z'),
    ]));
    for (const backupPath of result.backupPaths) {
      expect(fs.existsSync(backupPath)).toBe(true);
    }
    expect(opencodeConfig.provider).toEqual({
      anthropic: { npm: '@ai-sdk/anthropic' },
    });
    expect(opencodeConfig.mcp.context7.url).toBe('https://mcp.example.test');
    expect(opencodeConfig.plugin).toEqual([
      'opencode-with-claude',
      ['local-plugin', { enabled: true }],
      DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC,
    ]);
    expect(opencodeConfig.agent).toMatchObject({
      explore: { disable: true },
      general: { disable: true },
      custom: { description: 'keep me' },
    });
    expect(opencodeConfig.lsp).toBe(true);
    expect(packageJson.dependencies['oh-my-opencode-slim']).toBe(SLIM_MANAGED_VERSION);
    expect(wrapperSource).toContain("'node_modules', 'oh-my-opencode-slim', 'dist', 'index.js'");
    expect(wrapperSource).toContain('experimental.chat.system.transform');
    expect(wrapperSource).toContain('delete plugin.agent');
    expect(readJson(slimConfigPath).preset).toBe('custom');
    expect(commands).toEqual([
      { command: 'bun', args: ['install', '--ignore-scripts'], cwd: configDir },
    ]);
  });

  it('writes the pinned generated Slim preset config only when missing', async () => {
    const result = await createRuntime().install();
    const slimConfig = readJson(path.join(configDir, 'oh-my-opencode-slim.json'));

    expect(result.changedFiles).toContain(path.join(configDir, 'oh-my-opencode-slim.json'));
    expect(slimConfig.preset).toBe('openai');
    expect(slimConfig.presets.openai.orchestrator).toMatchObject({
      model: 'openai/gpt-5.5',
      variant: 'medium',
    });
    expect(slimConfig.presets.openai.orchestrator.mcps).toEqual([]);
    expect(slimConfig.presets.openai.oracle.mcps).toEqual([]);
    expect(slimConfig.presets['opencode-go'].orchestrator.mcps).toEqual([]);
    expect(slimConfig.presets['opencode-go'].oracle.mcps).toEqual([]);
    expect(slimConfig.presets['opencode-go'].orchestrator.model).toBe('opencode-go/glm-5.1');
    expect(slimConfig.companion).toEqual({ enabled: false });
  });

  it('exposes status, install, and repair routes with refresh metadata', async () => {
    const app = express();
    app.use(express.json());
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => ({
      reloadScheduled: true,
      message: 'reload scheduled',
    }));
    registerSlimSetupRoutes(app, {
      slimSetupRuntime: createRuntime(),
      refreshOpenCodeAfterConfigChange,
    });

    const missing = await request(app).get('/api/config/slim/status');
    const installed = await request(app).post('/api/config/slim/install').send({});
    const repaired = await request(app).post('/api/config/slim/repair').send({});

    expect(missing.status).toBe(200);
    expect(missing.body.runtimeEnabled).toBe(false);
    expect(installed.status).toBe(200);
    expect(installed.body.installedVersion).toBe(SLIM_MANAGED_VERSION);
    expect(installed.body.wrapperStatus.configured).toBe(true);
    expect(repaired.status).toBe(200);
    expect(repaired.body.repair).toBe(true);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith(
      'Slim runtime install',
      expect.objectContaining({ restart: true }),
    );
  });
});
