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
  writeAgentBackupModel,
  writeAgentModelOverride,
} from './agents.js';
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
