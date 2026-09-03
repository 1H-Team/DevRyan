import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOrchestrationLimits: vi.fn(),
  writeOrchestrationLimits: vi.fn(),
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
  readOrchestrationLimits: mocks.readOrchestrationLimits,
  updateCommand: vi.fn(),
  writeAgentBackupModel: vi.fn(),
  writeAgentModelOverride: vi.fn(),
  writeOrchestrationLimits: mocks.writeOrchestrationLimits,
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

const unavailablePressure = {
  state: 'normal',
  availableRatio: null,
  swapUsedRatio: null,
  sampledAt: null,
  source: 'unavailable',
};

describe('handleConfigBridgeMessage orchestration limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOrchestrationLimits.mockReturnValue({ maxConcurrentSubagents: 4, pauseUnderMemoryPressure: true });
  });

  it('answers :get with a 200 envelope carrying the sidecar limits and an unavailable pressure snapshot', async () => {
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      { id: 'limits-get', type: 'api:config/orchestration-limits:get' },
      createCtx(),
      deps,
    );

    expect(response).toEqual({
      id: 'limits-get',
      type: 'api:config/orchestration-limits:get',
      success: true,
      data: {
        status: 200,
        body: { maxConcurrentSubagents: 4, pauseUnderMemoryPressure: true, pressure: unavailablePressure },
      },
    });
    expect(mocks.readOrchestrationLimits).toHaveBeenCalledTimes(1);
    expect(mocks.writeOrchestrationLimits).not.toHaveBeenCalled();
    expect(deps.markConfigChange).not.toHaveBeenCalled();
  });

  it('routes :set to the sidecar writer with the PUT body and skips config apply', async () => {
    mocks.writeOrchestrationLimits.mockReturnValue({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false });
    const deps = createDeps();

    const response = await handleConfigBridgeMessage(
      {
        id: 'limits-set',
        type: 'api:config/orchestration-limits:set',
        payload: { maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false },
      },
      createCtx(),
      deps,
    );

    expect(response).toEqual({
      id: 'limits-set',
      type: 'api:config/orchestration-limits:set',
      success: true,
      data: {
        status: 200,
        body: { maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false, pressure: unavailablePressure },
      },
    });
    expect(mocks.writeOrchestrationLimits).toHaveBeenCalledWith({ maxConcurrentSubagents: 8, pauseUnderMemoryPressure: false });
    expect(mocks.readOrchestrationLimits).not.toHaveBeenCalled();
    expect(deps.markConfigChange).not.toHaveBeenCalled();
  });

  it('answers invalid input with a 400 envelope and other failures with 500', async () => {
    mocks.writeOrchestrationLimits.mockImplementation(() => {
      throw Object.assign(new Error('maxConcurrentSubagents must be an integer between 1 and 16'), {
        code: 'invalid_orchestration_limits',
      });
    });

    const rejected = await handleConfigBridgeMessage(
      { id: 'limits-invalid', type: 'api:config/orchestration-limits:set', payload: { maxConcurrentSubagents: 0 } },
      createCtx(),
      createDeps(),
    );
    expect(rejected).toEqual({
      id: 'limits-invalid',
      type: 'api:config/orchestration-limits:set',
      success: true,
      data: { status: 400, body: { error: 'maxConcurrentSubagents must be an integer between 1 and 16' } },
    });

    mocks.writeOrchestrationLimits.mockImplementation(() => {
      throw new Error('EACCES: sidecar not writable');
    });
    const failed = await handleConfigBridgeMessage(
      { id: 'limits-failed', type: 'api:config/orchestration-limits:set', payload: { maxConcurrentSubagents: 2 } },
      createCtx(),
      createDeps(),
    );
    expect(failed).toEqual({
      id: 'limits-failed',
      type: 'api:config/orchestration-limits:set',
      success: true,
      data: { status: 500, body: { error: 'EACCES: sidecar not writable' } },
    });
  });
});
