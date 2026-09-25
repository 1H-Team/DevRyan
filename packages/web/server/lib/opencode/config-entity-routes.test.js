import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from '../../test-supertest.js';

import {
  deleteAgentBackupModel,
  deleteAgentModelOverride,
  getAgentConfig,
  listAgentModelOverrides,
  listConfigAgents,
  listShadowedAgentModelOverrides,
  listStaleAgentModelOverrides,
  writeAgentBackupModel,
  writeAgentModelOverride,
} from './agents.js';
import { DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC } from './slim-config.js';
import { registerConfigEntityRoutes, sanitizeAgentRuntimeMetadata } from './config-entity-routes.js';
import {
  clearAgentRuntimeSettingsCache,
  readAgentRuntimeSettings,
  writeAgentRuntimeSettings,
} from './agent-runtime-settings.js';

describe('restricted agent runtime metadata', () => {
  it('preserves effective model and safe Slim preset provenance', () => {
    expect(sanitizeAgentRuntimeMetadata({
      name: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      variant: 'high',
      prompt: 'private host prompt',
      modelResolution: {
        presetName: 'openai',
        source: 'root-override',
        presetModelRef: 'openai/gpt-5.5',
        presetVariant: 'medium',
      },
    })).toEqual({
      name: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      variant: 'high',
      modelResolution: {
        presetName: 'openai',
        source: 'root-override',
        presetModelRef: 'openai/gpt-5.5',
        presetVariant: 'medium',
      },
    });
  });
});

describe('agent backup model routes', () => {
  let tempRoot;
  let projectDirectory;
  let userConfigPath;
  let sidecarPath;
  let markConfigChange;

  const writeProjectAgent = async (name, frontmatterLines) => {
    const agentDirectory = path.join(projectDirectory, '.opencode', 'agents');
    await fs.mkdir(agentDirectory, { recursive: true });
    await fs.writeFile(
      path.join(agentDirectory, `${name}.md`),
      ['---', ...frontmatterLines, '---', '', `${name} prompt`, ''].join('\n'),
      'utf8',
    );
  };

  const createApp = () => {
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: projectDirectory }),
      resolveOptionalProjectDirectory: async () => ({ directory: projectDirectory }),
      markConfigChange,
      clientReloadDelayMs: 0,
      getAgentSources: () => ({ md: { exists: true, scope: 'project' }, json: { exists: false } }),
      getAgentConfig: (name, directory) => getAgentConfig(name, directory, { userConfigPath }),
      listAgentModelOverrides: () => listAgentModelOverrides({ userConfigPath }),
      writeAgentModelOverride: (name, body, directory) => writeAgentModelOverride(name, body, directory, { userConfigPath }),
      deleteAgentModelOverride: (name) => deleteAgentModelOverride(name, { userConfigPath }),
      writeAgentBackupModel: (name, body, directory) => writeAgentBackupModel(name, body, directory, { userConfigPath }),
      deleteAgentBackupModel: (name) => deleteAgentBackupModel(name, { userConfigPath }),
      listConfigAgents: (directory) => listConfigAgents(directory, { userConfigPath }),
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
    });
    return app;
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-backup-model-routes-'));
    projectDirectory = path.join(tempRoot, 'project');
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    sidecarPath = path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
    markConfigChange = vi.fn(async () => ({ runtimeApplied: false, requiresApply: true, applyRevision: 1, applyScopes: ['agents'], applyStatus: { state: 'pending' }, requiresReload: false }));
    await writeProjectAgent('builder', ['mode: primary', 'model: anthropic/claude-sonnet-4-5', 'variant: low']);
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('writes and clears a backup model through the sidecar without queueing an OpenCode apply', async () => {
    const app = createApp();

    await request(app)
      .put('/api/config/agents/builder/backup-model')
      .send({ model: 'openai/gpt-5.5', variant: 'high' })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.backupModel).toEqual({ model: 'openai/gpt-5.5', variant: 'high' });
        expect(res.body.agent.config.backupModel).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
        expect(res.body.agent.config.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
        expect(res.body.agent.config.variant).toBe('low');
        expect(res.body).not.toHaveProperty('requiresApply');
      });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar.agentBackupModels).toEqual({ builder: { model: 'openai/gpt-5.5', variant: 'high' } });
    expect(sidecar).not.toHaveProperty('agentOverrides');

    await request(app)
      .get('/api/config/agents')
      .expect(200)
      .expect((res) => {
        const builder = res.body.agents.find((agent) => agent.name === 'builder');
        expect(builder.backupModel).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
      });

    await request(app)
      .delete('/api/config/agents/builder/backup-model')
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({ success: true, deleted: true, backupModel: null });
        expect(res.body.agent.config.backupModel).toBeNull();
      });

    await request(app)
      .delete('/api/config/agents/builder/backup-model')
      .expect(200)
      .expect((res) => {
        expect(res.body.deleted).toBe(false);
      });

    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies, primary-equal backups, and unknown agents', async () => {
    const app = createApp();

    await request(app)
      .put('/api/config/agents/builder/backup-model')
      .send({ model: 'anthropic/claude-sonnet-4-5', variant: 'high' })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toMatch(/must differ from the primary model/);
      });

    await request(app)
      .put('/api/config/agents/builder/backup-model')
      .send({ model: 'gpt-5.5' })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toMatch(/provider\/model/);
      });

    await request(app)
      .put('/api/config/agents/builder/backup-model')
      .send({ model: 'openai/gpt-5.5', councillors: [] })
      .expect(400);

    await request(app)
      .put('/api/config/agents/builder/backup-model')
      .send({})
      .expect(400);

    await request(app)
      .put('/api/config/agents/ghost/backup-model')
      .send({ model: 'openai/gpt-5.5' })
      .expect(404);

    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('keeps the read-only agent mutation guards in place', async () => {
    const app = createApp();

    await request(app).post('/api/config/agents/builder').send({}).expect(405);
    await request(app).patch('/api/config/agents/builder').send({}).expect(405);
    await request(app).delete('/api/config/agents/builder').expect(405);
  });
});
describe('agent runtime settings routes', () => {
  let tempRoot;
  let userConfigPath;
  let sidecarPath;
  let markConfigChange;
  let syncManagedAgentRuntimeConfig;
  let managedRunning;

  const createApp = (principal, overrides = {}) => {
    const app = express();
    app.use(express.json());
    if (principal) {
      app.use((req, _res, next) => {
        req.principal = principal;
        next();
      });
    }
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: tempRoot }),
      resolveOptionalProjectDirectory: async () => ({ directory: tempRoot }),
      markConfigChange,
      clientReloadDelayMs: 0,
      getAgentSources: () => ({ md: { exists: false }, json: { exists: false } }),
      getAgentConfig: () => null,
      listAgentModelOverrides: () => ({}),
      writeAgentModelOverride: () => {},
      deleteAgentModelOverride: () => false,
      readAgentRuntimeSettings: () => readAgentRuntimeSettings({ userConfigPath }),
      writeAgentRuntimeSettings: (body) => writeAgentRuntimeSettings(body, { userConfigPath }),
      syncManagedAgentRuntimeConfig,
      isManagedOpenCodeRunning: () => managedRunning,
      listConfigAgents: () => [],
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      createCommand: () => {},
      updateCommand: () => {},
      deleteCommand: () => {},
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      createMcpConfig: () => {},
      updateMcpConfig: () => {},
      deleteMcpConfig: () => {},
      ...overrides,
    });
    return app;
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-runtime-routes-'));
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    sidecarPath = path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
    markConfigChange = vi.fn(async () => ({ runtimeApplied: false, requiresApply: true }));
    syncManagedAgentRuntimeConfig = vi.fn(async () => ({ changed: true }));
    managedRunning = true;
    clearAgentRuntimeSettingsCache();
  });

  afterEach(async () => {
    clearAgentRuntimeSettingsCache();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('reads the language-server default without touching the sidecar', async () => {
    await request(createApp())
      .get('/api/config/agent-runtime')
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: true, appliesOnRestart: true });
      });

    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(syncManagedAgentRuntimeConfig).not.toHaveBeenCalled();
  });

  it('round-trips lsp through the sidecar, re-syncs the overlay, and owes a restart once per change', async () => {
    const app = createApp({ role: 'admin' });
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({
      agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } },
    }));
    clearAgentRuntimeSettingsCache();

    await request(app)
      .put('/api/config/agent-runtime')
      .send({ lsp: false })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: false, appliesOnRestart: true, restartRequired: true });
      });
    expect(syncManagedAgentRuntimeConfig).toHaveBeenCalledTimes(1);

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar).toEqual({
      agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } },
      agentRuntime: { lsp: false },
    });
    await expect(fs.stat(userConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await request(app)
      .get('/api/config/agent-runtime')
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: false, appliesOnRestart: true });
      });

    // Writing the value that is already stored changes nothing: no overlay
    // sync, no restart owed.
    await request(app)
      .put('/api/config/agent-runtime')
      .send({ lsp: false })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: false, appliesOnRestart: true, restartRequired: false });
      });
    expect(syncManagedAgentRuntimeConfig).toHaveBeenCalledTimes(1);

    await request(app)
      .put('/api/config/agent-runtime')
      .send({ lsp: true })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: true, appliesOnRestart: true, restartRequired: true });
      });
    expect(syncManagedAgentRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('owes no restart without a running managed server and keeps the write when the overlay sync fails', async () => {
    managedRunning = false;
    await request(createApp({ role: 'admin' }))
      .put('/api/config/agent-runtime')
      .send({ lsp: false })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ lsp: false, appliesOnRestart: true, restartRequired: false });
      });
    expect(syncManagedAgentRuntimeConfig).toHaveBeenCalledTimes(1);

    managedRunning = true;
    syncManagedAgentRuntimeConfig.mockRejectedValueOnce(new Error('overlay root not writable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(createApp({ role: 'admin' }))
        .put('/api/config/agent-runtime')
        .send({ lsp: true })
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual({ lsp: true, appliesOnRestart: true, restartRequired: true });
        });
    } finally {
      warn.mockRestore();
    }
    expect(JSON.parse(await fs.readFile(sidecarPath, 'utf8'))).toEqual({ agentRuntime: { lsp: true } });
  });

  it('rejects invalid bodies with 400 without touching the sidecar or the overlay', async () => {
    const app = createApp({ role: 'admin' });

    for (const body of [
      { lsp: 'no' },
      { lsp: 1 },
      { formatter: true },
      [true],
    ]) {
      await request(app)
        .put('/api/config/agent-runtime')
        .send(body)
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toMatch(/lsp|formatter|plain object/);
        });
    }

    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(syncManagedAgentRuntimeConfig).not.toHaveBeenCalled();
    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('answers 501 without the host helpers and guards restricted principals', async () => {
    const unsupported = createApp({ role: 'admin' }, {
      readAgentRuntimeSettings: undefined,
      writeAgentRuntimeSettings: undefined,
    });
    await request(unsupported).get('/api/config/agent-runtime').expect(501);
    await request(unsupported).put('/api/config/agent-runtime').send({ lsp: false }).expect(501);

    const restricted = createApp({ scope: 'managed', role: 'member', policy: { settingsPages: ['home'] } });
    await request(restricted).get('/api/config/agent-runtime').expect(403);
    await request(restricted).put('/api/config/agent-runtime').send({ lsp: false }).expect(403);
    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(syncManagedAgentRuntimeConfig).not.toHaveBeenCalled();

    await request(createApp({ scope: 'managed', role: 'member', policy: { settingsPages: ['agents'] } }))
      .get('/api/config/agent-runtime')
      .expect(200);
  });

  it('assumes a running server when the host exposes no process getter', async () => {
    await request(createApp({ role: 'admin' }, { isManagedOpenCodeRunning: undefined }))
      .put('/api/config/agent-runtime')
      .send({ lsp: false })
      .expect(200)
      .expect((res) => {
        expect(res.body.restartRequired).toBe(true);
      });
  });
});

describe('agent overrides listing route', () => {
  let tempRoot;
  let projectDirectory;
  let userConfigPath;
  let slimConfigPath;
  let options;
  let warnSpy;

  const writeJson = async (filePath, data) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };

  const createApp = ({ directory = projectDirectory, ...overrides } = {}) => {
    const app = express();
    app.use(express.json());
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory }),
      resolveOptionalProjectDirectory: async () => ({ directory }),
      markConfigChange: vi.fn(),
      clientReloadDelayMs: 0,
      listAgentModelOverrides: () => listAgentModelOverrides(options),
      listStaleAgentModelOverrides: (dir) => listStaleAgentModelOverrides(dir, options),
      listShadowedAgentModelOverrides: (dir) => listShadowedAgentModelOverrides(dir, options),
      listConfigAgents: (dir) => listConfigAgents(dir, options),
      getCommandSources: () => ({ md: { exists: false }, json: { exists: false } }),
      listMcpConfigs: () => [],
      getMcpConfig: () => null,
      ...overrides,
    });
    return app;
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-overrides-route-'));
    projectDirectory = path.join(tempRoot, 'project');
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    slimConfigPath = path.join(path.dirname(userConfigPath), 'oh-my-opencode-slim.json');
    await fs.mkdir(projectDirectory, { recursive: true });
    // Plugin detection is injected so the route never reads the real OpenCode config.
    options = {
      userConfigPath,
      slimConfigDirectory: path.dirname(userConfigPath),
      readOpenCodeConfig: () => ({ plugin: [DEVRYAN_SLIM_WRAPPER_PLUGIN_SPEC] }),
      env: {},
    };
    await writeJson(path.join(path.dirname(userConfigPath), '.openchamber', 'config.json'), {
      agentOverrides: {
        fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
        ghost: { model: 'openai/gpt-5.5' },
      },
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('adds shadowed sidecar fields for the directory while keeping the existing fields', async () => {
    await writeJson(slimConfigPath, { agents: { fixer: { model: 'xai/grok-4.6', variant: 'high' } } });

    await request(createApp())
      .get('/api/config/agent-overrides')
      .expect(200)
      .expect((res) => {
        expect(res.body.overrides).toEqual({
          fixer: { model: 'openai/gpt-5.5', variant: 'medium' },
          ghost: { model: 'openai/gpt-5.5' },
        });
        expect(res.body.staleOverrides).toEqual(['ghost']);
        expect(res.body.shadowedOverrides).toEqual({
          fixer: {
            fields: {
              model: { saved: 'openai/gpt-5.5', effective: 'xai/grok-4.6', shadowedBy: 'slim-root' },
              variant: { saved: 'medium', effective: 'high', shadowedBy: 'slim-root' },
            },
            effective: { model: 'xai/grok-4.6', variant: 'high' },
            presetName: null,
          },
        });
      });
  });

  it('reports nothing shadowed without a directory or a host diagnostic', async () => {
    const shadowSpy = vi.fn(() => ({ fixer: {} }));
    await request(createApp({ directory: null, listShadowedAgentModelOverrides: shadowSpy }))
      .get('/api/config/agent-overrides')
      .expect(200)
      .expect((res) => {
        expect(res.body.staleOverrides).toEqual([]);
        expect(res.body.shadowedOverrides).toEqual({});
      });
    expect(shadowSpy).not.toHaveBeenCalled();

    await request(createApp({ listShadowedAgentModelOverrides: undefined }))
      .get('/api/config/agent-overrides')
      .expect(200)
      .expect((res) => {
        expect(res.body.shadowedOverrides).toEqual({});
      });
  });

  it('reports nothing shadowed instead of failing when the Slim config cannot be read', async () => {
    await fs.mkdir(path.dirname(slimConfigPath), { recursive: true });
    await fs.writeFile(slimConfigPath, '{ "agents": { "fixer": ', 'utf8');

    await request(createApp({ listStaleAgentModelOverrides: undefined }))
      .get('/api/config/agent-overrides')
      .expect(200)
      .expect((res) => {
        expect(res.body.overrides.fixer).toEqual({ model: 'openai/gpt-5.5', variant: 'medium' });
        expect(res.body.shadowedOverrides).toEqual({});
      });
    expect(warnSpy).toHaveBeenCalledWith(
      '[API:Agent overrides] Shadowed override diagnostic unavailable:',
      expect.any(String),
    );
  });
});
