import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discoveredSkills: [],
  getSkillSources: vi.fn(),
  deleteSkill: vi.fn(),
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
  deleteSkill: mocks.deleteSkill,
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

const createApplyResponse = (changed = true, runtimeMode = 'managed') => ({
  runtimeApplied: false,
  runtimeMessage: runtimeMode === 'external'
    ? 'Configuration saved. Restart the external OpenCode runtime, then acknowledge the restart in DevRyan.'
    : 'Configuration saved. Apply the pending changes when it is safe to restart OpenCode.',
  requiresApply: changed,
  applyRevision: changed ? 1 : 0,
  applyScopes: changed ? ['skills'] : [],
  applyStatus: {
    revision: changed ? 1 : 0,
    appliedRevision: 0,
    state: changed ? (runtimeMode === 'external' ? 'external_restart_required' : 'pending') : 'clean',
    pending: changed,
    scopes: changed ? ['skills'] : [],
    reasonCodes: changed ? ['CONFIG_SKILLS_CHANGED'] : [],
    activeSessionCount: 0,
    runtimeMode,
    canApplyWhenIdle: runtimeMode === 'managed',
    canForceRestart: runtimeMode === 'managed',
  },
  requiresReload: false,
});

const createDeps = (openCodeSkills = [], overrides = {}) => ({
  readSettings: vi.fn(() => ({ hiddenSkills: [] })),
  persistSettings: vi.fn(async (changes) => changes),
  readMagicPromptOverrides: vi.fn(() => ({ version: 1, overrides: {} })),
  saveMagicPromptOverride: vi.fn(),
  resetMagicPromptOverride: vi.fn(),
  resetAllMagicPromptOverrides: vi.fn(),
  fetchOpenCodeSkillsFromApi: vi.fn(async () => openCodeSkills),
  markConfigChange: vi.fn(async (_reason, _metadata, changed = true) => createApplyResponse(changed)),
  getGlobalAgentsMdRuntime: vi.fn(() => ({
    read: vi.fn(async () => ({ content: '', exists: false, editable: true })),
    save: vi.fn(async () => ({
      success: true,
      content: '',
      exists: false,
      editable: true,
      runtimeApplied: true,
    })),
  })),
  checkForOpenCodeUpdates: vi.fn(async ({ currentVersion, supportedVersion }) => ({
    currentVersion,
    latestVersion: '1.18.23',
    supportedVersion,
    updateAvailable: true,
    supportStatus: 'supported',
  })),
  ...overrides,
});

const createCtx = (workingDirectory = '/tmp/project') => ({
  manager: {
    getWorkingDirectory: () => workingDirectory,
    restart: vi.fn(async () => {}),
    getDebugInfo: vi.fn(() => ({
      cliPath: '/usr/local/bin/opencode',
      version: '1.18.23',
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
      targetVersion: '1.18.23',
      detectedVersion: '1.18.23',
      installCommand: 'curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.23 --no-modify-path',
    });
  });
});

describe('handleConfigBridgeMessage OpenCode update check', () => {
  it.each([
    ['managed', '1.18.23'],
    ['external', '1.18.10'],
  ])('uses the active %s runtime version', async (mode, version) => {
    const checkForOpenCodeUpdates = vi.fn(async ({ currentVersion, supportedVersion }) => ({
      currentVersion,
      latestVersion: '1.18.23',
      supportedVersion,
      updateAvailable: true,
      supportStatus: currentVersion === supportedVersion ? 'supported' : 'older',
    }));
    const ctx = createCtx();
    ctx.manager.getDebugInfo = vi.fn(() => ({
      mode,
      cliPath: mode === 'managed' ? '/usr/local/bin/opencode' : null,
      version,
    }));

    const response = await handleConfigBridgeMessage(
      { id: 'opencode-update', type: 'api:opencode:update-check', payload: {} },
      ctx,
      createDeps([], { checkForOpenCodeUpdates }),
    );

    expect(checkForOpenCodeUpdates).toHaveBeenCalledWith({
      currentVersion: version,
      supportedVersion: '1.18.23',
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        currentVersion: version,
        latestVersion: '1.18.23',
      },
    });
  });

  it('returns a safe bridge error when the upstream check fails', async () => {
    const response = await handleConfigBridgeMessage(
      { id: 'opencode-update', type: 'api:opencode:update-check', payload: {} },
      createCtx(),
      createDeps([], {
        checkForOpenCodeUpdates: vi.fn(async () => {
          throw new Error('OpenCode release check failed with 429');
        }),
      }),
    );

    expect(response).toEqual({
      id: 'opencode-update',
      type: 'api:opencode:update-check',
      success: false,
      error: 'OpenCode release check failed with 429',
    });
  });
});

describe('handleConfigBridgeMessage global AGENTS.md', () => {
  it('reads through the injected file runtime', async () => {
    const read = vi.fn(async () => ({
      content: '# Global\n',
      exists: true,
      editable: true,
    }));
    const getGlobalAgentsMdRuntime = vi.fn(() => ({ read, save: vi.fn() }));

    const response = await handleConfigBridgeMessage(
      { id: 'agents-read', type: 'api:behavior/agents-md:get', payload: {} },
      createCtx(),
      createDeps([], { getGlobalAgentsMdRuntime }),
    );

    expect(response).toEqual({
      id: 'agents-read',
      type: 'api:behavior/agents-md:get',
      success: true,
      data: { content: '# Global\n', exists: true, editable: true },
    });
    expect(getGlobalAgentsMdRuntime).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('saves through the injected runtime and preserves refresh warnings', async () => {
    const save = vi.fn(async () => ({
      success: true,
      content: '# Global\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
      warning: 'restart failed',
    }));
    const getGlobalAgentsMdRuntime = vi.fn(() => ({ read: vi.fn(), save }));

    const response = await handleConfigBridgeMessage(
      {
        id: 'agents-save',
        type: 'api:behavior/agents-md:save',
        payload: { content: '# Global' },
      },
      createCtx(),
      createDeps([], { getGlobalAgentsMdRuntime }),
    );

    expect(response).toEqual({
      id: 'agents-save',
      type: 'api:behavior/agents-md:save',
      success: true,
      data: {
        success: true,
        content: '# Global\n',
        exists: true,
        editable: true,
        runtimeApplied: false,
        warning: 'restart failed',
      },
    });
    expect(save).toHaveBeenCalledWith('# Global');
  });
});

describe('handleConfigBridgeMessage skills discovery', () => {
  beforeEach(() => {
    mocks.discoveredSkills = [];
    mocks.getSkillSources.mockReset();
    mocks.deleteSkill.mockReset();
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

  it('rejects upstream-only OpenCode skills without an approved local path', async () => {
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
    expect(response?.data.skills).toEqual([localSkill]);
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

  it('hides every package-cache skill from the managed skill catalog', async () => {
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
    expect(response?.data.skills).toEqual([localSkill]);
  });

  it('denies retired Superpowers names returned by any harness skill source', async () => {
    const controlSkill = {
      name: 'systematic-debugging',
      path: '/Users/test/.config/opencode/skills/superpowers/systematic-debugging/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Installed control skill',
    };
    const retiredSkills = [
      {
        name: 'test-driven-development',
        path: '/tmp/project/.agents/skills/test-driven-development/SKILL.md',
        scope: 'project',
        source: 'agents',
      },
      {
        name: 'subagent-driven-development',
        path: '/Users/test/.agents/skills/subagent-driven-development/SKILL.md',
        scope: 'user',
        source: 'agents',
      },
    ];
    mocks.discoveredSkills = [controlSkill];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET' } },
      createCtx(),
      createDeps(retiredSkills),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual([controlSkill]);
  });

  it('excludes Claude skills returned by the managed OpenCode API', async () => {
    const opencodeSkill = {
      name: 'frontend-design',
      path: '/Users/test/.config/opencode/skills/frontend-design/SKILL.md',
      scope: 'user',
      source: 'opencode',
      description: 'Design skill',
    };
    const claudeSkill = {
      name: 'claude-design',
      path: '/Users/test/.claude/skills/claude-design/SKILL.md',
      scope: 'user',
      source: 'claude',
      description: 'Disallowed Claude skill',
    };
    mocks.discoveredSkills = [opencodeSkill];

    const response = await handleConfigBridgeMessage(
      { id: '1', type: 'api:config/skills', payload: { method: 'GET' } },
      createCtx(),
      createDeps([opencodeSkill, claudeSkill]),
    );

    expect(response?.success).toBe(true);
    expect(response?.data.skills).toEqual([opencodeSkill]);
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

  it('passes only approved local skills into catalog installed state resolution', async () => {
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
      [localSkill],
    );
  });

  it('hides and restores the exact selected skill path', async () => {
    const projectSkill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [projectSkill];
    mocks.getSkillSources.mockReturnValue({
      md: {
        exists: true,
        path: projectSkill.path,
        scope: projectSkill.scope,
        source: projectSkill.source,
        fields: [],
        supportingFiles: [],
      },
    });
    const settings = { hiddenSkills: [] };
    const persistSettings = vi.fn(async (changes) => {
      Object.assign(settings, changes);
      return settings;
    });
    const ctx = createCtx();

    const hidden = await handleConfigBridgeMessage(
      { id: 'hide', type: 'api:config/skills:hidden:hide', payload: { name: 'lint-helper', path: projectSkill.path, scope: 'project' } },
      ctx,
      createDeps([], { readSettings: () => settings, persistSettings }),
    );
    const restored = await handleConfigBridgeMessage(
      { id: 'restore', type: 'api:config/skills:hidden:restore', payload: { path: projectSkill.path } },
      ctx,
      createDeps([], { readSettings: () => settings, persistSettings }),
    );

    expect(hidden?.success).toBe(true);
    expect(hidden?.data.message).toContain('hidden successfully');
    expect(restored?.success).toBe(true);
    expect(settings.hiddenSkills).toEqual([]);
    expect(ctx.manager.restart).not.toHaveBeenCalled();
  });

  it('permanently deletes the exact selected identity and rejects stale paths', async () => {
    const userSkill = {
      name: 'lint-helper',
      path: '/Users/test/.agents/skills/lint-helper/SKILL.md',
      scope: 'user',
      source: 'agents',
    };
    const projectSkill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [userSkill, projectSkill];
    mocks.getSkillSources.mockImplementation((_name, _directory, skill) => ({
      md: {
        exists: true,
        path: skill.path,
        scope: skill.scope,
        source: skill.source,
        fields: [],
        supportingFiles: [],
      },
    }));
    const deleted = await handleConfigBridgeMessage(
      { id: 'delete', type: 'api:config/skills', payload: { method: 'DELETE', name: 'lint-helper', path: projectSkill.path, scope: 'project' } },
      createCtx(),
      createDeps([], { readSettings: () => ({ hiddenSkills: [{ ...projectSkill }] }) }),
    );
    const stale = await handleConfigBridgeMessage(
      { id: 'stale', type: 'api:config/skills', payload: { method: 'DELETE', name: 'lint-helper', path: '/tmp/stale/SKILL.md' } },
      createCtx(),
      createDeps(),
    );

    expect(deleted?.success).toBe(true);
    expect(deleted?.data.message).toContain('permanently deleted');
    expect(deleted?.data).toMatchObject({
      requiresApply: true,
      requiresReload: false,
      runtimeApplied: false,
    });
    expect(mocks.deleteSkill).toHaveBeenCalledWith('lint-helper', '/tmp/project', expect.objectContaining({ path: projectSkill.path }));
    expect(stale).toEqual({ id: 'stale', type: 'api:config/skills', success: false, error: 'Skill "lint-helper" not found' });
  });

  it('queues permanent deletion without restarting the managed runtime immediately', async () => {
    const skill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [skill];
    mocks.getSkillSources.mockReturnValue({
      md: { exists: true, path: skill.path, scope: skill.scope, source: skill.source, fields: [], supportingFiles: [] },
    });
    const ctx = createCtx();
    const markConfigChange = vi.fn(async () => createApplyResponse(true));

    const deleted = await handleConfigBridgeMessage(
      { id: 'delete-pending', type: 'api:config/skills', payload: { method: 'DELETE', name: skill.name, path: skill.path, scope: skill.scope } },
      ctx,
      createDeps([], { markConfigChange }),
    );

    expect(deleted?.success).toBe(true);
    expect(markConfigChange).toHaveBeenCalledWith('skill deletion');
    expect(ctx.manager.restart).not.toHaveBeenCalled();
  });

  it('returns explicit external restart state without restarting OpenCode', async () => {
    const skill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [skill];
    mocks.getSkillSources.mockReturnValue({
      md: { exists: true, path: skill.path, scope: skill.scope, source: skill.source, fields: [], supportingFiles: [] },
    });
    const ctx = createCtx();
    ctx.manager.getDebugInfo = vi.fn(() => ({ mode: 'external' }));
    const markConfigChange = vi.fn(async () => createApplyResponse(true, 'external'));

    const deleted = await handleConfigBridgeMessage(
      { id: 'delete-external', type: 'api:config/skills', payload: { method: 'DELETE', name: skill.name, path: skill.path, scope: skill.scope } },
      ctx,
      createDeps([], { markConfigChange }),
    );

    expect(deleted?.data).toMatchObject({
      runtimeApplied: false,
      requiresApply: true,
      applyStatus: { state: 'external_restart_required', runtimeMode: 'external' },
    });
    expect(deleted?.data.runtimeMessage).toContain('Restart the external OpenCode runtime');
    expect(ctx.manager.restart).not.toHaveBeenCalled();
  });

  it('keeps the deletion durable when recording the apply request fails', async () => {
    const skill = {
      name: 'lint-helper',
      path: '/tmp/project/.opencode/skills/lint-helper/SKILL.md',
      scope: 'project',
      source: 'opencode',
    };
    mocks.discoveredSkills = [skill];
    mocks.getSkillSources.mockReturnValue({
      md: { exists: true, path: skill.path, scope: skill.scope, source: skill.source, fields: [], supportingFiles: [] },
    });
    const ctx = createCtx();
    const markConfigChange = vi.fn(async () => {
      throw new Error('coordinator unavailable');
    });

    await expect(handleConfigBridgeMessage(
      { id: 'delete-record-failed', type: 'api:config/skills', payload: { method: 'DELETE', name: skill.name, path: skill.path, scope: skill.scope } },
      ctx,
      createDeps([], { markConfigChange }),
    )).rejects.toThrow('coordinator unavailable');
    expect(mocks.deleteSkill).toHaveBeenCalled();
    expect(ctx.manager.restart).not.toHaveBeenCalled();
  });
});
