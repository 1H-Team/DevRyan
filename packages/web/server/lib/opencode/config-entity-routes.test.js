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
  invalidateOrchestrationLimitsCache,
  readOrchestrationLimits,
  writeOrchestrationLimits,
} from './orchestration-limits.js';

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

describe('orchestration limits routes', () => {
  let tempRoot;
  let userConfigPath;
  let sidecarPath;
  let markConfigChange;
  let pressure;

  const createApp = (principal) => {
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
      readOrchestrationLimits: () => readOrchestrationLimits({ userConfigPath }),
      writeOrchestrationLimits: (body) => writeOrchestrationLimits(body, { userConfigPath }),
      getSystemPressure: () => pressure,
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
    });
    return app;
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-orchestration-limit-routes-'));
    userConfigPath = path.join(tempRoot, 'opencode-config', 'config.json');
    sidecarPath = path.join(path.dirname(userConfigPath), '.openchamber', 'config.json');
    await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
    markConfigChange = vi.fn(async () => ({ runtimeApplied: false, requiresApply: true }));
    pressure = { state: 'elevated', availableRatio: 0.12, swapUsedRatio: 0.4, sampledAt: 1_000, source: 'vm_stat' };
    invalidateOrchestrationLimitsCache();
  });

  afterEach(async () => {
    invalidateOrchestrationLimitsCache();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    tempRoot = undefined;
  });

  it('reads defaults with the live pressure snapshot and writes only the sidecar', async () => {
    const app = createApp();

    await request(app)
      .get('/api/config/orchestration-limits')
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({
          maxConcurrentSubagents: 4,
          pauseUnderMemoryPressure: true,
          pressure,
        });
      });

    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify({ agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } } }));
    invalidateOrchestrationLimitsCache();

    await request(app)
      .put('/api/config/orchestration-limits')
      .send({ maxConcurrentSubagents: 8 })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: true, pressure });
      });

    await request(app)
      .put('/api/config/orchestration-limits')
      .send({ pauseUnderMemoryPressure: false, pressure: { state: 'ignored' } })
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false, pressure });
      });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar).toEqual({
      agentBackupModels: { builder: { model: 'openai/gpt-5.5', variant: null } },
      orchestrationLimits: { maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false },
    });
    await expect(fs.stat(userConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await request(app)
      .get('/api/config/orchestration-limits')
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false });
      });
    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies with 400 without touching the sidecar', async () => {
    const app = createApp({ role: 'admin' });

    for (const body of [
      { maxConcurrentSubagents: 0 },
      { maxConcurrentSubagents: 17 },
      { maxConcurrentSubagents: 2.5 },
      { maxConcurrentSubagents: '4' },
      { pauseUnderMemoryPressure: 'yes' },
    ]) {
      await request(app)
        .put('/api/config/orchestration-limits')
        .send(body)
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toMatch(/maxConcurrentSubagents|pauseUnderMemoryPressure/);
        });
    }

    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(markConfigChange).not.toHaveBeenCalled();
  });

  it('falls back to an unavailable pressure snapshot and guards restricted principals', async () => {
    pressure = null;
    await request(createApp({ role: 'admin' }))
      .get('/api/config/orchestration-limits')
      .expect(200)
      .expect((res) => {
        expect(res.body.pressure).toEqual({
          state: 'normal',
          availableRatio: null,
          swapUsedRatio: null,
          sampledAt: null,
          source: 'unavailable',
        });
      });

    const restricted = createApp({ scope: 'managed', role: 'member', policy: { settingsPages: ['home'] } });
    await request(restricted).get('/api/config/orchestration-limits').expect(403);
    await request(restricted).put('/api/config/orchestration-limits').send({ maxConcurrentSubagents: 2 }).expect(403);
    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await request(createApp({ scope: 'managed', role: 'member', policy: { settingsPages: ['agents'] } }))
      .get('/api/config/orchestration-limits')
      .expect(200);
  });
});
