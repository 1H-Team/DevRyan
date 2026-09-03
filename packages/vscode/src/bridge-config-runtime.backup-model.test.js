import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeAgentBackupModel: vi.fn(),
  deleteAgentBackupModel: vi.fn(),
  writeAgentModelOverride: vi.fn(),
  deleteAgentModelOverride: vi.fn(),
  getAgentConfig: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => ''),
    })),
  },
}));

vi.mock('./opencodeConfig', () => ({
  AGENT_SCOPE: { USER: 'user', PROJECT: 'project', PACKAGED: 'packaged' },
  COMMAND_SCOPE: { USER: 'user', PROJECT: 'project' },
  SKILL_SCOPE: { USER: 'user', PROJECT: 'project' },
  createCommand: vi.fn(),
  deleteAgentBackupModel: mocks.deleteAgentBackupModel,
  deleteAgentModelOverride: mocks.deleteAgentModelOverride,
  deleteCommand: vi.fn(),
  getAgentConfig: mocks.getAgentConfig,
  getAgentSources: vi.fn(),
  getCommandSources: vi.fn(),
  listAgentModelOverrides: vi.fn(() => []),
  listConfigAgents: vi.fn(() => []),
  listReadonlyPlugins: vi.fn(() => []),
  updateCommand: vi.fn(),
  writeAgentBackupModel: mocks.writeAgentBackupModel,
  writeAgentModelOverride: mocks.writeAgentModelOverride,
  discoverSkills: vi.fn(() => []),
  getSkillSources: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  readSkillSupportingFile: vi.fn(),
  writeSkillSupportingFile: vi.fn(),
  deleteSkillSupportingFile: vi.fn(),
  listMcpConfigs: vi.fn(() => []),
  getMcpConfig: vi.fn(),
  createMcpConfig: vi.fn(),
  updateMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
  recoverMcpConfigs: vi.fn(() => ({ migrated: [] })),
}));

vi.mock('./skillsCatalog', () => ({
  getSkillsCatalog: vi.fn(),
  scanSkillsRepository: vi.fn(),
  installSkillsFromRepository: vi.fn(),
}));

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');

const createCtx = (workingDirectory = '/tmp/project') => ({
  manager: {
    getWorkingDirectory: () => workingDirectory,
    restart: vi.fn(async () => {}),
    getDebugInfo: vi.fn(() => ({ cliPath: '/usr/local/bin/opencode', version: '1.18.27' })),
  },
});

const createDeps = () => ({
  markConfigChange: vi.fn(async () => ({ requiresApply: true })),
});

const backupRecord = { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' };

describe('handleConfigBridgeMessage agent backup models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentConfig.mockReturnValue({
      source: 'md',
      scope: 'project',
      config: { name: 'builder', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, backupModel: backupRecord },
    });
  });

  it('routes backupModel PUT to the sidecar writer without touching overrides or config apply', async () => {
    mocks.writeAgentBackupModel.mockReturnValue({ model: 'openai/gpt-5.5', variant: 'high' });
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      {
        id: 'backup-put',
        type: 'api:config/agents',
        payload: {
          method: 'PUT',
          name: 'builder',
          body: { model: 'openai/gpt-5.5', variant: 'high' },
          directory: '/tmp/project',
          backupModel: true,
        },
      },
      createCtx(),
      deps,
    );

    expect(response).toEqual({
      id: 'backup-put',
      type: 'api:config/agents',
      success: true,
      data: {
        success: true,
        backupModel: { model: 'openai/gpt-5.5', variant: 'high' },
        agent: {
          source: 'md',
          scope: 'project',
          config: { name: 'builder', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, backupModel: backupRecord },
        },
      },
    });
    expect(mocks.writeAgentBackupModel).toHaveBeenCalledWith('builder', { model: 'openai/gpt-5.5', variant: 'high' }, '/tmp/project');
    expect(mocks.writeAgentModelOverride).not.toHaveBeenCalled();
    expect(mocks.deleteAgentModelOverride).not.toHaveBeenCalled();
    expect(deps.markConfigChange).not.toHaveBeenCalled();
  });

  it('routes backupModel DELETE to the sidecar deleter and reports the cleared record', async () => {
    mocks.deleteAgentBackupModel.mockReturnValue(true);
    mocks.getAgentConfig.mockReturnValue({ source: 'md', scope: 'project', config: { name: 'builder', backupModel: null } });
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      {
        id: 'backup-delete',
        type: 'api:config/agents',
        payload: { method: 'DELETE', name: 'builder', directory: '/tmp/project', backupModel: true },
      },
      createCtx(),
      deps,
    );

    expect(response).toEqual({
      id: 'backup-delete',
      type: 'api:config/agents',
      success: true,
      data: {
        success: true,
        deleted: true,
        backupModel: null,
        agent: { source: 'md', scope: 'project', config: { name: 'builder', backupModel: null } },
      },
    });
    expect(mocks.deleteAgentBackupModel).toHaveBeenCalledWith('builder');
    expect(mocks.deleteAgentModelOverride).not.toHaveBeenCalled();
    expect(deps.markConfigChange).not.toHaveBeenCalled();
  });

  it('surfaces validation errors and rejects unsupported backupModel methods', async () => {
    mocks.writeAgentBackupModel.mockImplementation(() => {
      throw new Error('Agent backup model must differ from the primary model');
    });

    const rejected = await handleConfigBridgeMessage(
      {
        id: 'backup-invalid',
        type: 'api:config/agents',
        payload: { method: 'PUT', name: 'builder', body: { model: 'anthropic/claude-sonnet-4-5' }, backupModel: true },
      },
      createCtx(),
      createDeps(),
    );
    expect(rejected).toEqual({
      id: 'backup-invalid',
      type: 'api:config/agents',
      success: false,
      error: 'Agent backup model must differ from the primary model',
    });

    const unsupported = await handleConfigBridgeMessage(
      {
        id: 'backup-post',
        type: 'api:config/agents',
        payload: { method: 'POST', name: 'builder', body: {}, backupModel: true },
      },
      createCtx(),
      createDeps(),
    );
    expect(unsupported).toEqual({
      id: 'backup-post',
      type: 'api:config/agents',
      success: false,
      error: 'Unsupported backup model method: POST',
    });
    expect(mocks.writeAgentModelOverride).not.toHaveBeenCalled();
  });

  it('keeps the override flag on its own path', async () => {
    mocks.writeAgentModelOverride.mockReturnValue({ model: 'openai/gpt-5.5', variant: 'high' });
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      {
        id: 'override-put',
        type: 'api:config/agents',
        payload: { method: 'PUT', name: 'builder', body: { model: 'openai/gpt-5.5', variant: 'high' }, directory: '/tmp/project', override: true },
      },
      createCtx(),
      deps,
    );

    expect(response?.success).toBe(true);
    expect(mocks.writeAgentModelOverride).toHaveBeenCalledWith('builder', { model: 'openai/gpt-5.5', variant: 'high' }, '/tmp/project');
    expect(mocks.writeAgentBackupModel).not.toHaveBeenCalled();
    expect(deps.markConfigChange).toHaveBeenCalled();
  });
});
