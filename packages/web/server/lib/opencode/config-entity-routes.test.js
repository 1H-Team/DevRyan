import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from '../../test-supertest.js';
import { registerCommonRequestMiddleware } from './core-routes.js';

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
import { registerConfigEntityRoutes, sanitizeAgentRuntimeMetadata } from './config-entity-routes.js';

describe('agent override selection admission', () => {
  const model = { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' };
  const catalog = { providers: [{ id: model.providerID, models: {
    [model.modelID]: { variants: { low: {}, high: {}, max: {} } },
    other: { variants: { high: {} } },
  } }] };
  const setup = () => {
    let config = { name: 'explorer', model, variant: 'medium' };
    const getAgentConfig = vi.fn(() => ({ config: structuredClone(config) }));
    const write = vi.fn((_name, patch) => {
      config = { ...config, ...patch, model: patch.model ?? config.model };
      return patch;
    });
    const readCatalog = vi.fn(async () => structuredClone(catalog));
    const validateCursor = vi.fn(async () => null);
    const mark = vi.fn(async () => ({ requiresApply: true, runtimeApplied: false }));
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerConfigEntityRoutes(app, {
      resolveProjectDirectory: async () => ({ directory: '/project' }),
      getAgentConfig, writeAgentModelOverride: write, readAgentModelCatalog: readCatalog, validateCursorModelSelection: validateCursor, markConfigChange: mark,
    });
    const put = patch => request(app).put('/api/config/agents/explorer/override').send(patch);
    return { put, write, readCatalog, validateCursor, mark, getAgentConfig, config: () => config };
  };

  it('rejects the observed unsupported effort without writing or marking an apply', async () => {
    const h = setup();
    const response = await h.put({ model: 'opencode-go/deepseek-v4.1-flash', variant: 'medium' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'managed_agent_model_unavailable', retryable: false,
      details: { reason: 'variant_missing', agent: 'explorer', ...model, variant: 'medium' } });
    expect(h.write).not.toHaveBeenCalled(); expect(h.mark).not.toHaveBeenCalled();
    expect(h.config().variant).toBe('medium');
    expect(h.readCatalog).toHaveBeenCalledWith('/project');
  });

  it.each(['low', null])('admits an explicit supported effort or provider default: %s', async variant => {
    const h = setup();
    await h.put({ variant }).expect(200);
    expect(h.write).toHaveBeenCalledExactlyOnceWith('explorer', { model: 'opencode-go/deepseek-v4.1-flash', variant }, '/project');
    expect(h.mark).toHaveBeenCalledTimes(1);
  });

  it('checks the inherited effort on model-only changes', async () => {
    const h = setup();
    await h.put({ model: 'opencode-go/other' }).expect(409);
    expect(h.write).not.toHaveBeenCalled();
    await h.put({ model: 'opencode-go/other', variant: 'high' }).expect(200);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it.each([null, { catalogIncomplete: true, providers: [] }, { providers: [{ id: 'opencode-go' }] }])(
    'treats missing or incomplete catalog evidence as retryable', async value => {
      const h = setup(); h.readCatalog.mockResolvedValue(value);
      const response = await h.put({ variant: 'low' });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'managed_agent_model_availability_unknown', retryable: true,
        details: { reason: 'catalog_unavailable' } });
      expect(h.write).not.toHaveBeenCalled();
    });

  it('refuses catalog transport failures without mutating settings', async () => {
    const h = setup(); h.readCatalog.mockRejectedValue(new Error('offline'));
    await h.put({ variant: 'low' }).expect(503);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a concurrent settings change during catalog discovery', async () => {
    const h = setup();
    h.readCatalog.mockImplementation(async () => {
      h.getAgentConfig.mockReturnValue({ config: { ...h.config(), variant: 'max' } });
      return catalog;
    });
    const response = await h.put({ variant: 'low' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('agent_configuration_changed');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('validates all effective Council member selections before writing', async () => {
    const h = setup();
    await h.put({ variant: 'low', councillors: [{ model: 'opencode-go/other', variant: 'medium' }] }).expect(409);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('requires authoritative Cursor selection evidence rather than a display fallback', async () => {
    const h = setup();
    await h.put({ model: 'cursor-acp/chosen', variant: 'low' }).expect(503);
    expect(h.write).not.toHaveBeenCalled(); expect(h.readCatalog).not.toHaveBeenCalled();
    h.validateCursor.mockResolvedValue(false);
    await h.put({ model: 'cursor-acp/chosen', variant: 'low' }).expect(409);
    expect(h.write).not.toHaveBeenCalled();
    h.validateCursor.mockResolvedValue(true);
    await h.put({ model: 'cursor-acp/chosen', variant: 'low' }).expect(200);
    expect(h.validateCursor).toHaveBeenLastCalledWith(expect.objectContaining({ directory: '/project', modelID: 'chosen', variant: 'low' }));
  });
});

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

describe('packaged prompt maintenance routes', () => {
  it('requires host administration and records restore through the configuration apply owner', async () => {
    const getPackagedAgentPrompts = vi.fn(async () => ({ prompts: [] }));
    const restorePackagedAgentPrompt = vi.fn(async () => ({ changed: true, backups: [{ name: 'builder', backupPath: '/owned/backup.md' }] }));
    const markConfigChange = vi.fn(async () => ({ runtimeApplied: false, requiresApply: true }));
    const appFor = (principal) => {
      const app = express();app.use((req, _res, next) => { req.principal = principal; next(); });
      registerConfigEntityRoutes(app, { getPackagedAgentPrompts, restorePackagedAgentPrompt, markConfigChange });return app;
    };
    for (const principal of [undefined, { scope: 'managed-user', role: 'developer' }]) {
      await request(appFor(principal)).get('/api/config/packaged-agent-prompts').expect(403);
      await request(appFor(principal)).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(64)}).expect(403);
    }
    expect(getPackagedAgentPrompts).not.toHaveBeenCalled();expect(restorePackagedAgentPrompt).not.toHaveBeenCalled();
    const admin = appFor({ scope: 'local-admin' });
    await request(admin).get('/api/config/packaged-agent-prompts').expect(200);
    await request(admin).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(64),force:true}).expect(400);
    await request(admin).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(4096)}).expect(413);
    expect(restorePackagedAgentPrompt).not.toHaveBeenCalled();
    await request(admin).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(64)})
      .expect(200).expect(res => expect(res.body).toMatchObject({success:true,runtimeApplied:false,requiresApply:true}));
    expect(markConfigChange).toHaveBeenCalledWith('packaged agent prompt restored', {agentName:'builder'}, true);
    restorePackagedAgentPrompt.mockRejectedValueOnce(Object.assign(new Error('Changed'), {status:409,code:'packaged_agent_changed'}));
    await request(admin).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(64)}).expect(409);
    expect(markConfigChange).toHaveBeenCalledTimes(1);
    markConfigChange.mockRejectedValueOnce(new Error('Apply queue unavailable'));
    await request(admin).post('/api/config/packaged-agent-prompts/restore').send({name:'builder',expectedHash:'a'.repeat(64)})
      .expect(200).expect(res => expect(res.body).toMatchObject({success:true,reloadFailed:true,runtimeApplied:false,warning:'Apply queue unavailable'}));
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
    registerCommonRequestMiddleware(app, { express });
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
    registerCommonRequestMiddleware(app, { express });
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
      readOpenCodeConfig: () => ({ plugin: [] }),
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
