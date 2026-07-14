import * as vscode from 'vscode';
import * as path from 'path';
import {
  createCommand,
  deleteAgentModelOverride,
  deleteCommand,
  getAgentConfig,
  getAgentSources,
  getCommandSources,
  listAgentModelOverrides,
  listConfigAgents,
  updateCommand,
  writeAgentModelOverride,
  type CommandScope,
  COMMAND_SCOPE,
  discoverSkills,
  getSkillSources,
  createSkill,
  updateSkill,
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
  scanSkillsRepository as scanSkillsRepositoryFromGit,
  installSkillsFromRepository as installSkillsFromGit,
  type SkillsCatalogSourceConfig,
} from './skillsCatalog';
import type { BridgeContext, BridgeResponse } from './bridge';
import { OPENCODE_TARGET_INSTALL_COMMAND, TARGET_OPENCODE_VERSION } from './opencodeVersionPolicy';
import type { GlobalAgentsMdRuntime } from './globalAgentsMdRuntime';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ConfigRuntimeDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  persistSettings: (changes: Record<string, unknown>, ctx?: BridgeContext) => Promise<Record<string, unknown>>;
  readMagicPromptOverrides: () => { version: number; overrides: Record<string, string> };
  saveMagicPromptOverride: (id: string, text: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetMagicPromptOverride: (id: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetAllMagicPromptOverrides: () => Promise<{ version: number; overrides: Record<string, string> }>;
  fetchOpenCodeSkillsFromApi: (ctx: BridgeContext | undefined, workingDirectory?: string) => Promise<DiscoveredSkill[] | null>;
  clientReloadDelayMs: number;
  getGlobalAgentsMdRuntime: (ctx?: BridgeContext) => GlobalAgentsMdRuntime;
};

const resolveWorkingDirectory = (ctx: BridgeContext | undefined, directory?: string): string | undefined => (
  (typeof directory === 'string' && directory.trim())
    ? directory.trim()
    : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
);

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

const normalizeSkillPath = (skillPath: unknown): string => {
  if (typeof skillPath !== 'string' || !skillPath.trim()) {
    return '';
  }
  return path.resolve(skillPath.trim());
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

const getHiddenSkillPathSet = (hiddenSkills: HiddenSkillConfig[]) => new Set(
  hiddenSkills.map((skill) => normalizeSkillPath(skill.path)).filter(Boolean)
);

const isPackageCacheSkillPath = (skillPath: unknown): boolean => {
  const normalized = normalizeSkillPath(skillPath).replace(/\\/g, '/');
  return /\/(\.cache\/opencode|Library\/Caches\/opencode)\/packages\//.test(normalized);
};

const filterVisibleSkills = (skills: DiscoveredSkill[], hiddenSkills: HiddenSkillConfig[]): DiscoveredSkill[] => {
  const hiddenPaths = getHiddenSkillPathSet(hiddenSkills);
  const nonCacheNames = new Set(
    skills
      .filter((skill) => skill.name && !isPackageCacheSkillPath(skill.path))
      .map((skill) => skill.name)
  );
  const seenPaths = new Set<string>();
  const visibleSkills: DiscoveredSkill[] = [];
  let changed = false;

  for (const skill of skills) {
    if (skill.name && nonCacheNames.has(skill.name) && isPackageCacheSkillPath(skill.path)) {
      changed = true;
      continue;
    }
    const skillPath = normalizeSkillPath(skill.path);
    if (skillPath && hiddenPaths.has(skillPath)) {
      changed = true;
      continue;
    }
    if (skillPath && seenPaths.has(skillPath)) {
      changed = true;
      continue;
    }
    if (skillPath) {
      seenPaths.add(skillPath);
    }
    visibleSkills.push(skill);
  }

  return changed ? visibleSkills : skills;
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
): DiscoveredSkill | null => {
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
  }

  const byName = skills.find((skill) => (
    skill.name === skillName
    && (scope === 'all' || skill.scope === scope)
  ));
  return byName ? ({ ...byName, preferDiscoveredPath: true } as DiscoveredSkill) : null;
};

const mergeDiscoveredSkills = (
  localSkills: DiscoveredSkill[] = [],
  openCodeSkills: DiscoveredSkill[] = [],
): DiscoveredSkill[] => {
  const merged: DiscoveredSkill[] = [];
  const indexByPath = new Map<string, number>();

  const addOrMerge = (skill: DiscoveredSkill | null | undefined, preferIncoming: boolean) => {
    if (!skill?.name && !skill?.path) {
      return;
    }

    const skillPath = normalizeSkillPath(skill.path);
    const existingIndex = skillPath ? indexByPath.get(skillPath) : undefined;
    if (typeof existingIndex === 'number') {
      merged[existingIndex] = preferIncoming
        ? { ...merged[existingIndex], ...skill }
        : { ...skill, ...merged[existingIndex] };
      return;
    }

    const nextIndex = merged.length;
    merged.push(skill);
    if (skillPath) {
      indexByPath.set(skillPath, nextIndex);
    }
  };

  for (const skill of localSkills) {
    addOrMerge(skill, false);
  }
  for (const skill of openCodeSkills) {
    addOrMerge(skill, true);
  }

  return merged;
};

const resolveDiscoveredSkills = async (
  ctx: BridgeContext | undefined,
  workingDirectory: string | undefined,
  deps: ConfigRuntimeDeps,
): Promise<DiscoveredSkill[]> => {
  const localSkills = discoverSkills(workingDirectory);
  const openCodeSkills = await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory);
  return mergeDiscoveredSkills(localSkills, Array.isArray(openCodeSkills) ? openCodeSkills : []);
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

const refreshManagedRuntimeAfterAgentOverride = async (ctx: BridgeContext | undefined) => {
  const mode = ctx?.manager?.getDebugInfo()?.mode;
  if (mode === 'external') {
    return {
      runtimeApplied: false,
      requiresReload: false,
      runtimeMessage: 'Agent model defaults were saved, but DevRyan cannot apply them to an external OpenCode runtime automatically.',
    };
  }

  await ctx?.manager?.restart();
  return {
    runtimeApplied: true,
    requiresReload: true,
  };
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

    case 'api:config/settings:get': {
      const settings = deps.readSettings(ctx);
      return { id, type, success: true, data: settings };
    }

    case 'api:config/settings:save': {
      const changes = (payload as Record<string, unknown>) || {};
      const updated = await deps.persistSettings(changes, ctx);
      return { id, type, success: true, data: updated };
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

    case 'api:config/reload': {
      await ctx?.manager?.restart();
      return { id, type, success: true, data: { restarted: true } };
    }

    case 'api:config/agent-overrides': {
      return { id, type, success: true, data: { overrides: listAgentModelOverrides() } };
    }

    case 'api:config/agents': {
      const { method, name, body, directory, override } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
        override?: boolean;
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

      if (override === true) {
        if (normalizedMethod === 'PUT') {
          const saved = writeAgentModelOverride(agentName, body || {}, workingDirectory);
          const agent = getAgentConfig(agentName, workingDirectory);
          const refreshResult = await refreshManagedRuntimeAfterAgentOverride(ctx);
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              override: saved,
              agent,
              ...refreshResult,
              reloadDelayMs: deps.clientReloadDelayMs,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          const deleted = deleteAgentModelOverride(agentName, workingDirectory);
          const agent = getAgentConfig(agentName, workingDirectory);
          const refreshResult = deleted
            ? await refreshManagedRuntimeAfterAgentOverride(ctx)
            : { runtimeApplied: true, requiresReload: false };
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              deleted,
              agent,
              ...refreshResult,
              reloadDelayMs: deps.clientReloadDelayMs,
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
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} created successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} updated successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteCommand(commandName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} deleted successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
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
        createMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" created. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" updated. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteMcpConfig(mcpName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" deleted. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
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
        return {
          id,
          type,
          success: true,
          data: { ...result, requiresReload: false },
        };
      }
      await ctx?.manager?.restart();
      return {
        id,
        type,
        success: true,
        data: {
          ...result,
          requiresReload: true,
          reloadDelayMs: deps.clientReloadDelayMs,
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
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} created successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
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
        updateSkill(skillName, (body || {}) as Record<string, unknown>, workingDirectory, discoveredSkill);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} updated successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        const discoveredSkill = findSkillByIdentity(
          await resolveDiscoveredSkills(ctx, workingDirectory, deps),
          skillName,
          requestedPath,
          scope,
        );
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill);
        if (!sources.md.exists || !sources.md.path) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }
        if (scope !== 'all' && sources.md.scope && sources.md.scope !== scope) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }

        const skillPath = normalizeSkillPath(sources.md.path);
        const alreadyHidden = hiddenSkills.some((skill) => normalizeSkillPath(skill.path) === skillPath);
        if (!alreadyHidden) {
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
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} removed successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
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
      await ctx?.manager?.restart();

      return {
        id,
        type,
        success: true,
        data: {
          success: true,
          hiddenSkills: sanitizeHiddenSkills((updated as { hiddenSkills?: unknown }).hiddenSkills),
          requiresReload: true,
          message: 'Skill restored successfully. Reloading interface…',
          reloadDelayMs: deps.clientReloadDelayMs,
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
        selections?: Array<{ skillDir: string }>;
        conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
        conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
      };

      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const data = await installSkillsFromGit({
        source: String(body.source || ''),
        subpath: body.subpath,
        scope: body.scope === 'project' ? 'project' : 'user',
        targetSource: body.targetSource === 'agents' ? 'agents' : 'opencode',
        workingDirectory: body.scope === 'project' ? workingDirectory : undefined,
        selections: Array.isArray(body.selections) ? body.selections : [],
        conflictPolicy: body.conflictPolicy,
        conflictDecisions: body.conflictDecisions,
      });

      if (data.ok) {
        const installed = data.installed || [];
        const skipped = data.skipped || [];
        const requiresReload = installed.length > 0;

        if (requiresReload) {
          await ctx?.manager?.restart();
        }

        return {
          id,
          type,
          success: true,
          data: {
            ok: true,
            installed,
            skipped,
            requiresReload,
            message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
            reloadDelayMs: requiresReload ? deps.clientReloadDelayMs : undefined,
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
