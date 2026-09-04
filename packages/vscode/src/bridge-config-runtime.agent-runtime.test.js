import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAgentRuntimeSettings: vi.fn(),
  writeAgentRuntimeSettings: vi.fn(),
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
  INVALID_AGENT_RUNTIME_SETTINGS_CODE: 'invalid_agent_runtime_settings',
  INVALID_ORCHESTRATION_LIMITS_CODE: 'invalid_orchestration_limits',
  SKILL_SCOPE: { USER: 'user', PROJECT: 'project' },
  createCommand: vi.fn(),
  deleteAgentBackupModel: vi.fn(),
  deleteAgentModelOverride: vi.fn(),
  deleteCommand: vi.fn(),
  getAgentConfig: vi.fn(),
  getAgentSources: vi.fn(),
  getCommandSources: vi.fn(),
  listAgentModelOverrides: vi.fn(() => []),
  listConfigAgents: vi.fn(() => []),
  listReadonlyPlugins: vi.fn(() => []),
  readAgentRuntimeSettings: mocks.readAgentRuntimeSettings,
  updateCommand: vi.fn(),
  writeAgentBackupModel: vi.fn(),
  writeAgentModelOverride: vi.fn(),
  writeAgentRuntimeSettings: mocks.writeAgentRuntimeSettings,
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

describe('handleConfigBridgeMessage agent runtime settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAgentRuntimeSettings.mockReturnValue({ lsp: true });
  });

  it('answers :get with a 200 envelope carrying the sidecar switch and the restart semantics', async () => {
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      { id: 'runtime-get', type: 'api:config/agent-runtime:get' },
      createCtx(),
      deps,
    );

    expect(response).toEqual({
      id: 'runtime-get',
      type: 'api:config/agent-runtime:get',
      success: true,
      data: { status: 200, body: { lsp: true, appliesOnRestart: true } },
    });
    expect(mocks.readAgentRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(mocks.writeAgentRuntimeSettings).not.toHaveBeenCalled();
    expect(deps.markConfigChange).not.toHaveBeenCalled();
  });

  it('routes :set to the sidecar writer, owes a restart only when the value changed, and never restarts itself', async () => {
    mocks.writeAgentRuntimeSettings.mockReturnValue({ lsp: false });
    const deps = createDeps();
    const ctx = createCtx();

    const changed = await handleConfigBridgeMessage(
      { id: 'runtime-set', type: 'api:config/agent-runtime:set', payload: { lsp: false } },
      ctx,
      deps,
    );

    expect(changed).toEqual({
      id: 'runtime-set',
      type: 'api:config/agent-runtime:set',
      success: true,
      data: { status: 200, body: { lsp: false, appliesOnRestart: true, restartRequired: true } },
    });
    expect(mocks.writeAgentRuntimeSettings).toHaveBeenCalledWith({ lsp: false });
    expect(deps.markConfigChange).not.toHaveBeenCalled();
    expect(ctx.manager.restart).not.toHaveBeenCalled();

    mocks.readAgentRuntimeSettings.mockReturnValue({ lsp: false });
    const unchanged = await handleConfigBridgeMessage(
      { id: 'runtime-same', type: 'api:config/agent-runtime:set', payload: { lsp: false } },
      ctx,
      deps,
    );
    expect(unchanged.data).toEqual({
      status: 200,
      body: { lsp: false, appliesOnRestart: true, restartRequired: false },
    });
  });

  it('answers invalid input with a 400 envelope and other failures with 500', async () => {
    mocks.writeAgentRuntimeSettings.mockImplementation(() => {
      throw Object.assign(new Error('Agent runtime setting "lsp" must be a boolean'), {
        code: 'invalid_agent_runtime_settings',
      });
    });

    const rejected = await handleConfigBridgeMessage(
      { id: 'runtime-invalid', type: 'api:config/agent-runtime:set', payload: { lsp: 'no' } },
      createCtx(),
      createDeps(),
    );
    expect(rejected).toEqual({
      id: 'runtime-invalid',
      type: 'api:config/agent-runtime:set',
      success: true,
      data: { status: 400, body: { error: 'Agent runtime setting "lsp" must be a boolean' } },
    });

    mocks.writeAgentRuntimeSettings.mockImplementation(() => {
      throw new Error('EACCES: sidecar not writable');
    });
    const failed = await handleConfigBridgeMessage(
      { id: 'runtime-failed', type: 'api:config/agent-runtime:set', payload: { lsp: false } },
      createCtx(),
      createDeps(),
    );
    expect(failed).toEqual({
      id: 'runtime-failed',
      type: 'api:config/agent-runtime:set',
      success: true,
      data: { status: 500, body: { error: 'EACCES: sidecar not writable' } },
    });
  });
});
