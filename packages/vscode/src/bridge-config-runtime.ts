import * as vscode from 'vscode';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import {
  createCommand,
  deleteAgentBackupModel,
  deleteAgentModelOverride,
  deleteCommand,
  getAgentConfig,
  getAgentSources,
  getCommandSources,
  INVALID_AGENT_RUNTIME_SETTINGS_CODE,
  INVALID_ORCHESTRATION_LIMITS_CODE,
  listAgentModelOverrides,
  listConfigAgents,
  readAgentRuntimeSettings,
  readOrchestrationLimits,
  updateCommand,
  writeAgentBackupModel,
  writeAgentModelOverride,
  writeAgentRuntimeSettings,
  writeOrchestrationLimits,
  type CommandScope,
  COMMAND_SCOPE,
  discoverSkills,
  getSkillSources,
  createSkill,
  updateSkill,
  deleteSkill,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  listReadonlyPlugins,
  type SkillScope,
  type DiscoveredSkill,
  SKILL_SCOPE,
  listMcpConfigs,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
  recoverMcpConfigs,
} from './opencodeConfig';
import {
  getSkillsCatalog,
  installSkillsFromClawdHub,
  isClawdHubSource,
  scanSkillsRepository as scanSkillsRepositoryFromGit,
  installSkillsFromRepository as installSkillsFromGit,
  type SkillsCatalogSourceConfig,
} from './skillsCatalog';
import type { BridgeContext, BridgeResponse } from './bridge';
import { OPENCODE_TARGET_INSTALL_COMMAND, TARGET_OPENCODE_VERSION } from './opencodeVersionPolicy';
import type { GlobalAgentsMdRuntime } from './globalAgentsMdRuntime';
import {
  filterVisibleSkills,
  isRetiredDevRyanSkillName,
  normalizeSkillPath,
  resolveApprovedSkills,
} from '../../web/server/lib/opencode/skill-policy.js';
import type { ConfigApplyMutationResponse } from '@openchamber/shared-runtime';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type OpenCodeUpdateInfo = {
  currentVersion: string | null;
  latestVersion: string;
  supportedVersion: string;
  updateAvailable: boolean | null;
  supportStatus: 'supported' | 'older' | 'newer' | 'unknown';
};

type ConfigRuntimeDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  persistSettings: (changes: Record<string, unknown>, ctx?: BridgeContext) => Promise<Record<string, unknown>>;
  readMagicPromptOverrides: () => { version: number; overrides: Record<string, string> };
  saveMagicPromptOverride: (id: string, text: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetMagicPromptOverride: (id: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetAllMagicPromptOverrides: () => Promise<{ version: number; overrides: Record<string, string> }>;
  fetchOpenCodeSkillsFromApi: (ctx: BridgeContext | undefined, workingDirectory?: string) => Promise<DiscoveredSkill[] | null>;
  markConfigChange: (
    reason: string,
    metadata?: unknown,
    changed?: boolean,
  ) => Promise<ConfigApplyMutationResponse & { runtimeApplied: false; runtimeMessage: string }>;
  getGlobalAgentsMdRuntime: (ctx?: BridgeContext) => GlobalAgentsMdRuntime;
  checkForOpenCodeUpdates: (input: {
    currentVersion: string | null;
    supportedVersion: string;
  }) => Promise<OpenCodeUpdateInfo>;
};

const resolveWorkingDirectory = (ctx: BridgeContext | undefined, directory?: string): string | undefined => (
  (typeof directory === 'string' && directory.trim())
    ? directory.trim()
    : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
);

const getAgentRuntimeExpectation = (agent: ReturnType<typeof getAgentConfig>) => {
  const config = agent?.config && typeof agent.config === 'object' && !Array.isArray(agent.config)
    ? agent.config as Record<string, unknown>
    : null;
  if (!config) return {};

  const modelRefs = Array.isArray(config.modelRefs) ? config.modelRefs : [];
  const firstModelRef = modelRefs.find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
  let expectedAgentModelRef = firstModelRef?.trim();
  if (!expectedAgentModelRef && typeof config.model === 'string' && config.model.trim()) {
    expectedAgentModelRef = config.model.trim();
  } else if (!expectedAgentModelRef && config.model && typeof config.model === 'object' && !Array.isArray(config.model)) {
    const model = config.model as Record<string, unknown>;
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (providerID && modelID) expectedAgentModelRef = `${providerID}/${modelID}`;
  }

  return {
    ...(expectedAgentModelRef ? { expectedAgentModelRef } : {}),
    ...(Object.prototype.hasOwnProperty.call(config, 'variant') ? { expectedAgentVariant: config.variant } : {}),
  };
};

const parseSkillsCatalogSources = (settings: Record<string, unknown>): SkillsCatalogSourceConfig[] => {
  const rawCatalogs = (settings as { skillCatalogs?: unknown }).skillCatalogs;
  if (!Array.isArray(rawCatalogs)) {
    return [];
  }

  return rawCatalogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
      if (!id || !label || !source) return null;
      const normalized: SkillsCatalogSourceConfig = {
        id,
        label,
        description: source,
        source,
        ...(subpath ? { defaultSubpath: subpath } : {}),
      };
      return normalized;
    })
    .filter((value): value is SkillsCatalogSourceConfig => value !== null);
};

type HiddenSkillConfig = {
  name: string;
  path: string;
  scope?: SkillScope;
  source?: 'opencode' | 'claude' | 'agents';
};

const sanitizeHiddenSkills = (value: unknown): HiddenSkillConfig[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: HiddenSkillConfig[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const skillPath = normalizeSkillPath(candidate.path);
    const scope = candidate.scope === 'project' ? SKILL_SCOPE.PROJECT : candidate.scope === 'user' ? SKILL_SCOPE.USER : undefined;
    const source = candidate.source === 'opencode' || candidate.source === 'claude' || candidate.source === 'agents'
      ? candidate.source
      : undefined;

    if (!name || !skillPath || seen.has(skillPath)) continue;
    seen.add(skillPath);
    result.push({
      name,
      path: skillPath,
      ...(scope ? { scope } : {}),
      ...(source ? { source } : {}),
    });
  }

  return result;
};

const normalizeSkillScopeFilter = (value: unknown): SkillScope | 'all' => {
  if (value === SKILL_SCOPE.USER || value === SKILL_SCOPE.PROJECT) {
    return value;
  }
  return 'all';
};

const filterSkillsByScope = (skills: DiscoveredSkill[], scope: SkillScope | 'all'): DiscoveredSkill[] => {
  if (scope !== SKILL_SCOPE.USER && scope !== SKILL_SCOPE.PROJECT) {
    return skills;
  }
  return skills.filter((skill) => skill.scope === scope);
};

const findSkillByIdentity = (
  skills: DiscoveredSkill[],
  skillName: string,
  requestedPath: unknown,
  scope: SkillScope | 'all',
  strictPath = false,
): DiscoveredSkill | null => {
  if (isRetiredDevRyanSkillName(skillName)) {
    return null;
  }
  const normalizedRequestedPath = normalizeSkillPath(requestedPath);
  if (normalizedRequestedPath) {
    const byPath = skills.find((skill) => (
      skill.name === skillName
      && normalizeSkillPath(skill.path) === normalizedRequestedPath
      && (scope === 'all' || skill.scope === scope)
    ));
    if (byPath) {
      return { ...byPath, preferDiscoveredPath: true } as DiscoveredSkill;
    }
    if (strictPath) {
      return null;
    }
  }

  const byName = skills.find((skill) => (
    skill.name === skillName
    && (scope === 'all' || skill.scope === scope)
  ));
  return byName ? ({ ...byName, preferDiscoveredPath: true } as DiscoveredSkill) : null;
};

const resolveDiscoveredSkills = async (
  ctx: BridgeContext | undefined,
  workingDirectory: string | undefined,
  deps: ConfigRuntimeDeps,
): Promise<DiscoveredSkill[]> => {
  const localSkills = discoverSkills(workingDirectory);
  const openCodeSkills = await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory);
  return resolveApprovedSkills({
    discoveredSkills: localSkills,
    runtimeSkills: Array.isArray(openCodeSkills) ? openCodeSkills : [],
  }) as DiscoveredSkill[];
};

const buildHiddenSkillsResponse = (
  discoveredSkills: DiscoveredSkill[],
  hiddenSkills: HiddenSkillConfig[],
  workingDirectory?: string,
) => {
  const discoveredByPath = new Map(
    discoveredSkills
      .map((skill) => [normalizeSkillPath(skill.path), skill] as const)
      .filter(([skillPath]) => Boolean(skillPath))
  );
  const seen = new Set<string>();
  const result = [];

  for (const hiddenSkill of hiddenSkills) {
    const skillPath = normalizeSkillPath(hiddenSkill.path);
    if (!skillPath || seen.has(skillPath)) continue;
    seen.add(skillPath);

    const discovered = discoveredByPath.get(skillPath) || null;
    const name = discovered?.name || hiddenSkill.name;
    const baseSkill = {
      ...hiddenSkill,
      ...(discovered || {}),
      name,
      path: discovered?.path || skillPath,
      scope: discovered?.scope || hiddenSkill.scope || SKILL_SCOPE.USER,
      source: discovered?.source || hiddenSkill.source || 'opencode',
      description: discovered?.description,
    };
    const sources = getSkillSources(name, workingDirectory, { ...baseSkill, preferDiscoveredPath: true } as DiscoveredSkill);
    result.push({
      ...baseSkill,
      sources,
    });
  }

  return result;
};

export async function handleConfigBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ConfigRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:config/opencode-resolution:get': {
      const debugInfo = ctx?.manager?.getDebugInfo();
      const configuredFromWorkspace = vscode.workspace.getConfiguration('openchamber').get<string>('opencodeBinary');
      const configured = typeof configuredFromWorkspace === 'string' && configuredFromWorkspace.trim().length > 0
        ? configuredFromWorkspace.trim()
        : null;
      const resolved = debugInfo?.cliPath ?? null;
      const source = (() => {
        if (!resolved) return null;
        if (configured && configured === resolved) return 'settings';
        const envBinary = typeof process.env.OPENCODE_BINARY === 'string' ? process.env.OPENCODE_BINARY.trim() : '';
        if (envBinary && envBinary === resolved) return 'env';
        return 'path';
      })();

      return {
        id,
        type,
        success: true,
        data: {
          targetVersion: TARGET_OPENCODE_VERSION,
          detectedVersion: debugInfo?.version ?? null,
          installCommand: OPENCODE_TARGET_INSTALL_COMMAND,
          configured,
          resolved,
          resolvedDir: resolved ? path.dirname(resolved) : null,
          source,
          detectedNow: resolved,
          detectedSourceNow: source,
          shim: null,
          viaWsl: false,
          wslBinary: null,
          wslPath: null,
          wslDistro: null,
          node: process.execPath || null,
          bun: null,
        },
      };
    }

    case 'api:opencode:update-check': {
      const currentVersion = ctx?.manager?.getDebugInfo()?.version ?? null;
      try {
        const updateInfo = await deps.checkForOpenCodeUpdates({
          currentVersion,
          supportedVersion: TARGET_OPENCODE_VERSION,
        });
        return { id, type, success: true, data: updateInfo };
      } catch (error) {
        return {
          id,
          type,
          success: false,
          error: error instanceof Error ? error.message : 'Unable to check the latest OpenCode version',
        };
      }
    }

    case 'api:config/settings:get': {
      const settings = deps.readSettings(ctx);
      return { id, type, success: true, data: settings };
    }

    case 'api:config/settings:save': {
      const changes = (payload as Record<string, unknown>) || {};
      const previous = Object.prototype.hasOwnProperty.call(changes, 'opencodeBinary')
        ? deps.readSettings(ctx)
        : null;
      const updated = await deps.persistSettings(changes, ctx);
      const runtimeSettingChanged = previous !== null
        && String(previous.opencodeBinary ?? '').trim() !== String(updated.opencodeBinary ?? '').trim();
      const applyResult = await deps.markConfigChange('runtime binary setting', {}, runtimeSettingChanged);
      return { id, type, success: true, data: { ...updated, ...applyResult } };
    }

    case 'api:behavior/agents-md:get': {
      const runtime = deps.getGlobalAgentsMdRuntime(ctx);
      return { id, type, success: true, data: await runtime.read() };
    }

    case 'api:behavior/agents-md:save': {
      const request = (payload || {}) as { content?: unknown };
      const runtime = deps.getGlobalAgentsMdRuntime(ctx);
      return { id, type, success: true, data: await runtime.save(request.content) };
    }

    case 'api:magic-prompts:get': {
      return { id, type, success: true, data: deps.readMagicPromptOverrides() };
    }

    case 'api:magic-prompts:save': {
      const request = (payload || {}) as { id?: string; text?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      if (typeof request.text !== 'string') {
        return { id, type, success: false, error: 'Prompt text is required' };
      }
      const data = await deps.saveMagicPromptOverride(promptId, request.text);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset': {
      const request = (payload || {}) as { id?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      const data = await deps.resetMagicPromptOverride(promptId);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset-all': {
      const data = await deps.resetAllMagicPromptOverrides();
      return { id, type, success: true, data };
    }

    case 'api:config/agent-overrides': {
      return { id, type, success: true, data: { overrides: listAgentModelOverrides() } };
    }

    case 'api:config/orchestration-limits:get':
    case 'api:config/orchestration-limits:set': {
      // Mirrors GET/PUT /api/config/orchestration-limits and answers a
      // `{ status, body }` envelope (like the prompt-mode bridge) so an invalid
      // PUT reaches the settings page as a 400, exactly as on the web host.
      // DevRyan-only sidecar state (OpenCode never reads it), so no
      // markConfigChange. VS Code samples no memory pressure: the snapshot is
      // always `unavailable` and the scheduler applies the concurrency cap alone.
      const isWrite = type === 'api:config/orchestration-limits:set';
      const pressure = {
        state: 'normal',
        availableRatio: null,
        swapUsedRatio: null,
        sampledAt: null,
        source: 'unavailable',
      };
      try {
        const limits = isWrite
          ? writeOrchestrationLimits((payload as Record<string, unknown>) || {})
          : readOrchestrationLimits();
        return { id, type, success: true, data: { status: 200, body: { ...limits, pressure } } };
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : (isWrite ? 'Failed to update orchestration limits' : 'Failed to read orchestration limits');
        const invalid = (error as { code?: unknown })?.code === INVALID_ORCHESTRATION_LIMITS_CODE;
        return { id, type, success: true, data: { status: invalid ? 400 : 500, body: { error: message } } };
      }
    }

    case 'api:config/agent-runtime:get':
    case 'api:config/agent-runtime:set': {
      // Mirrors GET/PUT /api/config/agent-runtime with the orchestration-limits
      // `{ status, body }` envelope. Sidecar-only state, so no markConfigChange;
      // OpenCode reads `lsp` when its instance starts, so a changed value owes
      // a restart and the settings page offers one.
      const isWrite = type === 'api:config/agent-runtime:set';
      try {
        const previous = readAgentRuntimeSettings();
        if (!isWrite) {
          return {
            id,
            type,
            success: true,
            data: { status: 200, body: { lsp: previous.lsp, appliesOnRestart: true } },
          };
        }
        const next = writeAgentRuntimeSettings((payload as Record<string, unknown>) || {});
        return {
          id,
          type,
          success: true,
          data: {
            status: 200,
            body: { lsp: next.lsp, appliesOnRestart: true, restartRequired: next.lsp !== previous.lsp },
          },
        };
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : (isWrite ? 'Failed to update agent runtime settings' : 'Failed to read agent runtime settings');
        const invalid = (error as { code?: unknown })?.code === INVALID_AGENT_RUNTIME_SETTINGS_CODE;
        return { id, type, success: true, data: { status: invalid ? 400 : 500, body: { error: message } } };
      }
    }

    case 'api:config/agents': {
      const { method, name, body, directory, override, backupModel } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
        override?: boolean;
        backupModel?: boolean;
      };
      const agentName = typeof name === 'string' ? name.trim() : '';

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (!agentName && normalizedMethod === 'GET') {
        return { id, type, success: true, data: { agents: listConfigAgents(workingDirectory) } };
      }

      if (!agentName) {
        return { id, type, success: false, error: 'Agent name is required' };
      }

      if (backupModel === true) {
        // Backup models are DevRyan-only sidecar state (OpenCode never reads them),
        // so no markConfigChange: nothing needs an apply/restart.
        try {
          if (normalizedMethod === 'PUT') {
            const saved = writeAgentBackupModel(agentName, body || {}, workingDirectory);
            const agent = getAgentConfig(agentName, workingDirectory);
            return { id, type, success: true, data: { success: true, backupModel: saved, agent } };
          }

          if (normalizedMethod === 'DELETE') {
            const deleted = deleteAgentBackupModel(agentName);
            const agent = getAgentConfig(agentName, workingDirectory);
            return { id, type, success: true, data: { success: true, deleted, backupModel: null, agent } };
          }
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : 'Failed to update agent backup model';
          return { id, type, success: false, error: message };
        }

        return { id, type, success: false, error: `Unsupported backup model method: ${normalizedMethod}` };
      }

      if (override === true) {
        if (normalizedMethod === 'PUT') {
          const previousAgent = getAgentConfig(agentName, workingDirectory);
          const saved = writeAgentModelOverride(agentName, body || {}, workingDirectory);
          const agent = getAgentConfig(agentName, workingDirectory);
          const applyResult = await deps.markConfigChange('agent model override', {
            agentName,
            ...getAgentRuntimeExpectation(agent),
          }, !isDeepStrictEqual(previousAgent?.config, agent?.config));
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              override: saved,
              agent,
              ...applyResult,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          const deleted = deleteAgentModelOverride(agentName, workingDirectory);
          const agent = getAgentConfig(agentName, workingDirectory);
          const applyResult = await deps.markConfigChange(
            'agent model override deletion',
            { agentName },
            deleted,
          );
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              deleted,
              agent,
              ...applyResult,
            },
          };
        }

        return { id, type, success: false, error: `Unsupported override method: ${normalizedMethod}` };
      }

      if (normalizedMethod === 'GET') {
        const sources = getAgentSources(agentName, workingDirectory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        return {
          id,
          type,
          success: true,
          data: {
            name: agentName,
            sources,
            scope,
            isBuiltIn: scope === 'packaged',
            isPackaged: scope === 'packaged',
          },
        };
      }

      if (normalizedMethod === 'POST') {
        return { id, type, success: false, error: 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.' };
      }

      if (normalizedMethod === 'PATCH') {
        return { id, type, success: false, error: 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.' };
      }

      if (normalizedMethod === 'DELETE') {
        return { id, type, success: false, error: 'Agent configuration is read-only. Edit project .opencode/agents/*.md files directly.' };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/commands': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const commandName = typeof name === 'string' ? name.trim() : '';
      if (!commandName) {
        return { id, type, success: false, error: 'Command name is required' };
      }

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const sources = getCommandSources(commandName, workingDirectory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        return {
          id,
          type,
          success: true,
          data: { name: commandName, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const scope: CommandScope | undefined = scopeValue === 'project' ? COMMAND_SCOPE.PROJECT : scopeValue === 'user' ? COMMAND_SCOPE.USER : undefined;
        createCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        const applyResult = await deps.markConfigChange('command creation');
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Command ${commandName} created successfully. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        const changed = updateCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory);
        const applyResult = await deps.markConfigChange('command update', {}, changed);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Command ${commandName} updated successfully. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteCommand(commandName, workingDirectory);
        const applyResult = await deps.markConfigChange('command deletion');
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Command ${commandName} deleted successfully. Changes are pending.`,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/mcp': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const mcpName = typeof name === 'string' ? name.trim() : '';
      const workingDirectory = resolveWorkingDirectory(ctx, directory);

      if (normalizedMethod === 'GET' && !mcpName) {
        const configs = listMcpConfigs(workingDirectory);
        return { id, type, success: true, data: configs };
      }

      if (!mcpName) {
        return { id, type, success: false, error: 'MCP server name is required' };
      }

      if (normalizedMethod === 'GET') {
        const config = getMcpConfig(mcpName, workingDirectory);
        if (!config) {
          return { id, type, success: false, error: `MCP server "${mcpName}" not found` };
        }
        return { id, type, success: true, data: config };
      }

      if (normalizedMethod === 'POST') {
        const scope = body?.scope as 'user' | 'project' | undefined;
        const mutationResult = createMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        const applyResult = await deps.markConfigChange('mcp creation', {}, mutationResult.changed);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `MCP server "${mcpName}" created. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        const mutationResult = updateMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory);
        const applyResult = await deps.markConfigChange('mcp update', {}, mutationResult.changed);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `MCP server "${mcpName}" updated. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        const mutationResult = deleteMcpConfig(mcpName, workingDirectory);
        const applyResult = await deps.markConfigChange('mcp deletion', {}, mutationResult.changed);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `MCP server "${mcpName}" deleted. Changes are pending.`,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/mcp/recover': {
      const { directory } = (payload || {}) as { directory?: string };
      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const result = recoverMcpConfigs(workingDirectory);
      if (result.migrated.length === 0) {
        const applyResult = await deps.markConfigChange('mcp recovery', {}, false);
        return {
          id,
          type,
          success: true,
          data: { ...result, ...applyResult },
        };
      }
      const applyResult = await deps.markConfigChange('mcp recovery');
      return {
        id,
        type,
        success: true,
        data: {
          ...result,
          ...applyResult,
        },
      };
    }

    case 'api:config/plugins': {
      const { directory } = (payload || {}) as { directory?: string };
      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      return { id, type, success: true, data: listReadonlyPlugins(workingDirectory) };
    }

    case 'api:config/skills': {
      const { method, name, body, includeHidden, scope: rawScope, path: requestedPath } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown>; includeHidden?: boolean; scope?: unknown; path?: unknown };
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const scope = normalizeSkillScopeFilter(rawScope);
      const settings = deps.readSettings(ctx);
      const hiddenSkills = sanitizeHiddenSkills((settings as { hiddenSkills?: unknown }).hiddenSkills);

      if (!name && normalizedMethod === 'GET') {
        const discoveredSkills = filterSkillsByScope(
          await resolveDiscoveredSkills(ctx, workingDirectory, deps),
          scope,
        );
        const data: Record<string, unknown> = {
          skills: filterVisibleSkills(discoveredSkills, hiddenSkills),
        };
        if (includeHidden) {
          data.hiddenSkills = filterSkillsByScope(
            buildHiddenSkillsResponse(discoveredSkills, hiddenSkills, workingDirectory) as DiscoveredSkill[],
            scope,
          );
        }
        return { id, type, success: true, data };
      }

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      if (normalizedMethod === 'GET') {
        const discoveredSkill = findSkillByIdentity(
          await resolveDiscoveredSkills(ctx, workingDirectory, deps),
          skillName,
          requestedPath,
          scope,
        );
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
        if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        return {
          id,
          type,
          success: true,
          data: { name: skillName, sources, scope: sources.md.scope, source: sources.md.source },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const sourceValue = body?.source as string | undefined;
        const scope: SkillScope | undefined = scopeValue === 'project' ? SKILL_SCOPE.PROJECT : scopeValue === 'user' ? SKILL_SCOPE.USER : undefined;
        const normalizedSource = sourceValue === 'agents' ? 'agents' : 'opencode';
        createSkill(skillName, { ...(body || {}), source: normalizedSource } as Record<string, unknown>, workingDirectory, scope);
        const applyResult = await deps.markConfigChange('skill creation');
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Skill ${skillName} created successfully. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        const discoveredSkill = findSkillByIdentity(
          await resolveDiscoveredSkills(ctx, workingDirectory, deps),
          skillName,
          requestedPath,
          scope,
        );
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
        if (!sources.md.exists || !sources.md.path) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        const changed = updateSkill(skillName, (body || {}) as Record<string, unknown>, workingDirectory, discoveredSkill);
        const applyResult = await deps.markConfigChange('skill update', {}, changed);
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Skill ${skillName} updated successfully. Changes are pending.`,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        const discoveredSkill = findSkillByIdentity(
          await resolveDiscoveredSkills(ctx, workingDirectory, deps),
          skillName,
          requestedPath,
          scope,
          true,
        );
        if (!discoveredSkill) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill);
        if (!sources.md.exists || !sources.md.path) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }

        const skillPath = normalizeSkillPath(sources.md.path);
        deleteSkill(skillName, workingDirectory, discoveredSkill);
        const nextHiddenSkills = hiddenSkills.filter((skill) => normalizeSkillPath(skill.path) !== skillPath);
        let warning: string | undefined;
        if (nextHiddenSkills.length !== hiddenSkills.length) {
          try {
            await deps.persistSettings({ hiddenSkills: nextHiddenSkills }, ctx);
          } catch (settingsError) {
            const message = settingsError instanceof Error ? settingsError.message : 'Failed to update settings';
            warning = `The skill was deleted, but its hidden-skill settings entry could not be removed: ${message}`;
            console.warn('[Skill delete] Failed to remove stale hidden-skill settings entry:', settingsError);
          }
        }
        const applyResult = await deps.markConfigChange('skill deletion');
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            ...applyResult,
            message: `Skill ${skillName} permanently deleted.`,
            ...(warning ? { warning } : {}),
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/skills:hidden:hide': {
      const { name, path: requestedPath, scope: rawScope } = (payload || {}) as { name?: unknown; path?: unknown; scope?: unknown };
      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const scope = normalizeSkillScopeFilter(rawScope);
      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(ctx, workingDirectory, deps),
        skillName,
        requestedPath,
        scope,
        true,
      );
      if (!discoveredSkill) {
        return { id, type, success: false, error: `Skill "${skillName}" not found` };
      }
      const sources = getSkillSources(skillName, workingDirectory, discoveredSkill);
      if (!sources.md.exists || !sources.md.path || (scope !== 'all' && sources.md.scope !== scope)) {
        return { id, type, success: false, error: `Skill "${skillName}" not found` };
      }

      const settings = deps.readSettings(ctx);
      const hiddenSkills = sanitizeHiddenSkills((settings as { hiddenSkills?: unknown }).hiddenSkills);
      const skillPath = normalizeSkillPath(sources.md.path);
      const changed = !hiddenSkills.some((skill) => normalizeSkillPath(skill.path) === skillPath);
      if (changed) {
        await deps.persistSettings({
          hiddenSkills: [
            ...hiddenSkills,
            {
              name: skillName,
              path: skillPath,
              ...(sources.md.scope ? { scope: sources.md.scope } : {}),
              ...(sources.md.source ? { source: sources.md.source } : {}),
            },
          ],
        }, ctx);
      }
      const applyResult = await deps.markConfigChange('skill hide', {}, changed);
      return {
        id,
        type,
        success: true,
        data: {
          success: true,
          ...applyResult,
          message: `Skill ${skillName} hidden successfully. Changes are pending.`,
        },
      };
    }

    case 'api:config/skills:hidden:restore': {
      const { path: requestedRawPath } = (payload || {}) as { path?: unknown };
      const requestedPath = normalizeSkillPath(requestedRawPath);
      if (!requestedPath) {
        return { id, type, success: false, error: 'Skill path is required' };
      }

      const settings = deps.readSettings(ctx);
      const hiddenSkills = sanitizeHiddenSkills((settings as { hiddenSkills?: unknown }).hiddenSkills);
      const nextHiddenSkills = hiddenSkills.filter((skill) => normalizeSkillPath(skill.path) !== requestedPath);
      if (nextHiddenSkills.length === hiddenSkills.length) {
        return { id, type, success: false, error: 'Hidden skill not found' };
      }

      const updated = await deps.persistSettings({ hiddenSkills: nextHiddenSkills }, ctx);
      const applyResult = await deps.markConfigChange('skill restore');

      return {
        id,
        type,
        success: true,
        data: {
          success: true,
          hiddenSkills: sanitizeHiddenSkills((updated as { hiddenSkills?: unknown }).hiddenSkills),
          ...applyResult,
          message: 'Skill restored successfully. Changes are pending.',
        },
      };
    }

    case 'api:config/skills:catalog': {
      const refresh = Boolean((payload as { refresh?: boolean } | undefined)?.refresh);
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const settings = deps.readSettings(ctx);
      const additionalSources = parseSkillsCatalogSources(settings);
      const hiddenSkills = sanitizeHiddenSkills((settings as { hiddenSkills?: unknown }).hiddenSkills);
      const discoveredSkills = await resolveDiscoveredSkills(ctx, workingDirectory, deps);
      const installedSkills = filterVisibleSkills(discoveredSkills, hiddenSkills);
      const data = await getSkillsCatalog(workingDirectory, refresh, additionalSources, installedSkills);
      return { id, type, success: true, data };
    }

    case 'api:config/skills:scan': {
      const body = (payload || {}) as { source?: string; subpath?: string; gitIdentityId?: string };
      const data = await scanSkillsRepositoryFromGit({
        source: String(body.source || ''),
        subpath: body.subpath,
      });
      return { id, type, success: true, data };
    }

    case 'api:config/skills:install': {
      const body = (payload || {}) as {
        source?: string;
        subpath?: string;
        scope?: 'user' | 'project';
        targetSource?: 'opencode' | 'agents';
        selections?: Array<{ skillDir: string; clawdhub?: { slug: string; version: string } }>;
        conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
        conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
      };

      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const installOptions = {
        scope: body.scope === 'project' ? 'project' as const : 'user' as const,
        targetSource: body.targetSource === 'agents' ? 'agents' as const : 'opencode' as const,
        workingDirectory: body.scope === 'project' ? workingDirectory : undefined,
        selections: Array.isArray(body.selections) ? body.selections : [],
        conflictPolicy: body.conflictPolicy,
        conflictDecisions: body.conflictDecisions,
      };
      const source = String(body.source || '');
      const data = isClawdHubSource(source)
        ? await installSkillsFromClawdHub(installOptions)
        : await installSkillsFromGit({
          ...installOptions,
          source,
          subpath: body.subpath,
        });

      if (data.ok) {
        const installed = data.installed || [];
        const skipped = data.skipped || [];
        const changed = installed.length > 0;
        const applyResult = await deps.markConfigChange('skills install', {}, changed);

        return {
          id,
          type,
          success: true,
          data: {
            ok: true,
            installed,
            skipped,
            ...applyResult,
            message: changed ? 'Skills installed successfully. Changes are pending.' : 'No skills were installed',
          },
        };
      }

      return { id, type, success: true, data };
    }

    case 'api:config/skills/files': {
      const { method, name, filePath, content, scope: rawScope, path: requestedPath } = (payload || {}) as {
        method?: string;
        name?: string;
        filePath?: string;
        content?: string;
        scope?: unknown;
        path?: unknown;
      };
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const scope = normalizeSkillScopeFilter(rawScope);

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      const relativePath = typeof filePath === 'string' ? filePath.trim() : '';
      if (!relativePath) {
        return { id, type, success: false, error: 'File path is required' };
      }

      const discoveredSkill = findSkillByIdentity(
        await resolveDiscoveredSkills(ctx, workingDirectory, deps),
        skillName,
        requestedPath,
        scope,
      );
      const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
      if (!sources.md.dir) {
        return { id, type, success: false, error: `Skill "${skillName}" not found` };
      }
      if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
        return { id, type, success: false, error: `Skill "${skillName}" not found` };
      }

      const skillDir = sources.md.dir;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const fileContent = readSkillSupportingFile(skillDir, relativePath);
        if (fileContent === null) {
          return { id, type, success: false, error: `File "${relativePath}" not found in skill "${skillName}"` };
        }
        return { id, type, success: true, data: { content: fileContent } };
      }

      if (normalizedMethod === 'PUT') {
        writeSkillSupportingFile(skillDir, relativePath, content || '');
        return { id, type, success: true, data: { success: true } };
      }

      if (normalizedMethod === 'DELETE') {
        deleteSkillSupportingFile(skillDir, relativePath);
        return { id, type, success: true, data: { success: true } };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    default:
      return null;
  }
}
