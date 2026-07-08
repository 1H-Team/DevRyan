import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discoveredSkills: [],
  getSkillSources: vi.fn(),
  readSkillSupportingFile: vi.fn(),
  getSkillsCatalog: vi.fn(),
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
  deleteAgentModelOverride: vi.fn(),
  deleteCommand: vi.fn(),
  getAgentConfig: vi.fn(),
  getAgentSources: vi.fn(),
  getCommandSources: vi.fn(),
  listAgentModelOverrides: vi.fn(() => []),
  listConfigAgents: vi.fn(() => []),
  updateCommand: vi.fn(),
  writeAgentModelOverride: vi.fn(),
  discoverSkills: vi.fn(() => mocks.discoveredSkills),
  getSkillSources: mocks.getSkillSources,
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  readSkillSupportingFile: mocks.readSkillSupportingFile,
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
  getSkillsCatalog: mocks.getSkillsCatalog,
  scanSkillsRepository: vi.fn(),
  installSkillsFromRepository: vi.fn(),
}));

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');

const createDeps = (openCodeSkills = []) => ({
  readSettings: vi.fn(() => ({ hiddenSkills: [] })),
  persistSettings: vi.fn(async (changes) => changes),
  readMagicPromptOverrides: vi.fn(() => ({ version: 1, overrides: {} })),
  saveMagicPromptOverride: vi.fn(),
  resetMagicPromptOverride: vi.fn(),
  resetAllMagicPromptOverrides: vi.fn(),
  fetchOpenCodeSkillsFromApi: vi.fn(async () => openCodeSkills),
  clientReloadDelayMs: 0,
});

const createCtx = (workingDirectory = '/tmp/project') => ({
  manager: {
    getWorkingDirectory: () => workingDirectory,
    restart: vi.fn(async () => {}),
    getDebugInfo: vi.fn(() => ({
      cliPath: '/usr/local/bin/opencode',
      version: '1.17.16',
    })),
  },
});

describe('handleConfigBridgeMessage OpenCode resolution', () => {
  it('returns target install policy and detected runtime version', async () => {
    const response = await handleConfigBridgeMessage(
      { id: 'resolution', type: 'api:config/opencode-resolution:get', payload: {} },
      createCtx(),
      createDeps(),
    );

    expect(response?.success).toBe(true);
    expect(response?.data).toMatchObject({
      targetVersion: '1.17.16',
      detectedVersion: '1.17.16',
      installCommand: 'curl -fsSL https://opencode.ai/install | bash -s -- --version 1.17.16 --no-modify-path',
    });
  });
});

describe('handleConfigBridgeMessage skills discovery', () => {
  beforeEach(() => {
    mocks.discoveredSkills = [];
    mocks.getSkillSources.mockReset();
    mocks.readSkillSupportingFile.mockReset();
    mocks.getSkillsCatalog.mockReset();
  });

  it('lists local user skills when the OpenCode skills API returns an empty array', async () => {
    mocks.discoveredSkills = [
      {
        name: 'writing-plans',
        path: '/Users/test/.config/opencode/skills/superpowers/writing-plans/SKILL.md',
        scope: 'user',
        source: 'opencode',
        description: 'Plan work',
      },
    ];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET', scope: 'user' } },
      createCtx(),
      createDeps([]),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual(mocks.discoveredSkills);
  });

  it('merges OpenCode skills with local nested user skills without collapsing different paths', async () => {
    const localSkill = {
      name: 'writing-plans',
      path: '/Users/test/.config/opencode/skills/superpowers/writing-plans/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Local plan skill',
    };
    const runtimeSkill = {
      name: 'writing-plans',
      path: '/tmp/project/.opencode/skills/writing-plans/SKILL.md',
      scope: 'project',
      source: 'opencode',
      description: 'Project plan skill',
    };
    mocks.discoveredSkills = [localSkill];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET' } },
      createCtx(),
      createDeps([runtimeSkill]),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual([localSkill, runtimeSkill]);
  });

  it('removes duplicate skill entries with the same path', async () => {
    const localSkill = {
      name: 'writing-plans',
      path: '/Users/test/.config/opencode/skills/superpowers/writing-plans/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Local plan skill',
    };
    const duplicateSkill = {
      ...localSkill,
      description: 'Duplicate plan skill',
    };
    const projectSkill = {
      name: 'writing-plans',
      path: '/tmp/project/.opencode/skills/writing-plans/SKILL.md',
      scope: 'project',
      source: 'opencode',
      description: 'Project plan skill',
    };
    mocks.discoveredSkills = [localSkill, duplicateSkill, projectSkill];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET' } },
      createCtx(),
      createDeps([]),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual([localSkill, projectSkill]);
  });

  it('hides package cache duplicates when a real skill has the same name', async () => {
    const localSkill = {
      name: 'dispatching-parallel-agents',
      path: '/Users/test/.config/opencode/skills/superpowers/dispatching-parallel-agents/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Installed copy',
    };
    const packageCacheSkill = {
      name: 'dispatching-parallel-agents',
      path: '/Users/test/.cache/opencode/packages/superpowers/node_modules/superpowers/skills/dispatching-parallel-agents/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Package cache copy',
    };
    const cacheOnlySkill = {
      name: 'cache-only',
      path: '/Users/test/.cache/opencode/packages/example/skills/cache-only/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Cache-only copy',
    };
    mocks.discoveredSkills = [localSkill];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET' } },
      createCtx(),
      createDeps([packageCacheSkill, cacheOnlySkill]),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual([localSkill, cacheOnlySkill]);
  });

  it('uses local discovered skill paths for detail and supporting file lookups when OpenCode returns no skills', async () => {
    const localSkill = {
      name: 'writing-plans',
      path: '/Users/test/.config/opencode/skills/superpowers/writing-plans/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Local plan skill',
    };
    mocks.discoveredSkills = [localSkill];
    mocks.getSkillSources.mockReturnValue({
      md: {
        exists: true,
        path: localSkill.path,
        dir: '/Users/test/.config/opencode/skills/superpowers/writing-plans',
        scope: 'user',
        source: 'opencode',
        fields: ['description'],
        supportingFiles: [],
      },
    });
    mocks.readSkillSupportingFile.mockReturnValue('reference file');

    const detail = await handleConfigBridgeMessage(
      {
        id: '1',
        type: 'api:config/skills',
        payload: { method: 'GET', name: 'writing-plans', scope: 'user', path: localSkill.path },
      },
      createCtx(),
      createDeps([]),
    );
    const file = await handleConfigBridgeMessage(
      {
        id: '2',
        type: 'api:config/skills/files',
        payload: { method: 'GET', name: 'writing-plans', filePath: 'references/example.md' },
      },
      createCtx(),
      createDeps([]),
    );

    expect(detail?.success).toBe(true);
    expect(mocks.getSkillSources).toHaveBeenCalledWith(
      'writing-plans',
      '/tmp/project',
      expect.objectContaining({ path: localSkill.path, preferDiscoveredPath: true }),
    );
    expect(file?.success).toBe(true);
    expect(file?.data).toEqual({ content: 'reference file' });
    expect(mocks.readSkillSupportingFile).toHaveBeenCalledWith(
      '/Users/test/.config/opencode/skills/superpowers/writing-plans',
      'references/example.md',
    );
  });

  it('uses the requested same-name skill path for updates and supporting file lookups', async () => {
    const userSkill = {
      name: 'lint-helper',
      path: '/Users/test/.agents/skills/lint-helper/SKILL.md',
      scope: 'user',
      source: 'agents',
      description: 'User helper',
    };
    const projectSkill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
      description: 'Project helper',
    };
    mocks.discoveredSkills = [userSkill, projectSkill];
    mocks.getSkillSources.mockImplementation((_name, _dir, discoveredSkill) => ({
      md: {
        exists: true,
        path: discoveredSkill.path,
        dir: discoveredSkill.path.replace('/SKILL.md', ''),
        scope: discoveredSkill.scope,
        source: discoveredSkill.source,
        fields: ['description'],
        supportingFiles: [],
      },
    }));
    mocks.readSkillSupportingFile.mockReturnValue('project reference');

    const detail = await handleConfigBridgeMessage(
      {
        id: '1',
        type: 'api:config/skills',
        payload: {
          method: 'PATCH',
          name: 'lint-helper',
          path: projectSkill.path,
          scope: 'project',
          body: { description: 'Updated project helper' },
        },
      },
      createCtx(),
      createDeps([]),
    );
    const file = await handleConfigBridgeMessage(
      {
        id: '2',
        type: 'api:config/skills/files',
        payload: {
          method: 'GET',
          name: 'lint-helper',
          path: projectSkill.path,
          scope: 'project',
          filePath: 'reference.md',
        },
      },
      createCtx(),
      createDeps([]),
    );

    expect(detail?.success).toBe(true);
    expect(file?.success).toBe(true);
    expect(mocks.getSkillSources).toHaveBeenCalledWith(
      'lint-helper',
      '/tmp/project',
      expect.objectContaining({ path: projectSkill.path, preferDiscoveredPath: true }),
    );
    expect(mocks.readSkillSupportingFile).toHaveBeenCalledWith(
      '/tmp/project/.opencode/skills/lint-helper',
      'reference.md',
    );
  });

  it('passes merged local and OpenCode skills into catalog installed state resolution', async () => {
    const localSkill = {
      name: 'writing-plans',
      path: '/Users/test/.config/opencode/skills/superpowers/writing-plans/SKILL.md',
      scope: 'user',
      source: 'opencode',
    };
    const runtimeSkill = {
      name: 'project-audit',
      path: '/tmp/project/.opencode/skills/project-audit/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [localSkill];
    mocks.getSkillsCatalog.mockResolvedValue({ ok: true, sources: [], itemsBySource: {} });

    await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills:catalog', payload: { refresh: true } },
      createCtx(),
      createDeps([runtimeSkill]),
    );

    expect(mocks.getSkillsCatalog).toHaveBeenCalledWith(
      '/tmp/project',
      true,
      [],
      [localSkill, runtimeSkill],
    );
  });
});
