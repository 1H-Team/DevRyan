import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { devtools } from './utils/devtoolsGate';
import type { Agent, PermissionConfig } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import { getSafeStorage } from "./utils/safeStorage";
import { useConfigStore } from "@/stores/useConfigStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useSelectionStore } from "@/sync/selection-store";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { recordConfigMutationResponse } from '@/stores/useConfigApplyStore';

const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  const dir = useDirectoryStore.getState().currentDirectory;
  return dir?.trim() ? dir.trim() : null;
};

const getConfigDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    
    // 1. Primary: Active project path from store
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    // 2. Fallback: current OpenCode directory (session / runtime)
    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }

    // 3. Fallback: directory store current directory. Settings → Agents no
    // longer has its own project dropdown, so the app-level directory is the
    // authoritative context when no project is explicitly active.
    const currentDirectory = getCurrentDirectory();
    if (currentDirectory?.trim()) {
      return currentDirectory.trim();
    }
  } catch (err) {
    console.warn('[AgentsStore] Error resolving config directory:', err);
  }

  return null;
};

const AGENTS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_AGENTS_CACHE_KEY = '__default__';
const agentsLastLoadedAt = new Map<string, number>();
const agentsLoadInFlight = new Map<string, Promise<boolean>>();
const agentsLoadGeneration = new Map<string, number>();

const getAgentsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_AGENTS_CACHE_KEY;
};

const invalidateAgentsLoadCache = (directory: string | null) => {
  const cacheKey = getAgentsCacheKey(directory);
  agentsLastLoadedAt.delete(cacheKey);
  agentsLoadInFlight.delete(cacheKey);
  agentsLoadGeneration.set(cacheKey, (agentsLoadGeneration.get(cacheKey) ?? 0) + 1);
};

const parseModelRef = (value: string): { providerID: string; modelID: string } | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const [providerID, ...modelParts] = trimmed.split('/');
  const modelID = modelParts.join('/');
  if (!providerID || !modelID) {
    return null;
  }

  return { providerID, modelID };
};

const modelValueToRef = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { providerID?: unknown; modelID?: unknown; providerId?: unknown; modelId?: unknown };
  const providerID = typeof candidate.providerID === 'string'
    ? candidate.providerID
    : (typeof candidate.providerId === 'string' ? candidate.providerId : '');
  const modelID = typeof candidate.modelID === 'string'
    ? candidate.modelID
    : (typeof candidate.modelId === 'string' ? candidate.modelId : '');

  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const normalizeAgentModelRefs = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(modelValueToRef)
    .filter((entry): entry is string => Boolean(entry));
};

const getAgentOptionModelRefs = (agent: AgentWithExtras): unknown => {
  const options = (agent as { options?: { modelRefs?: unknown } }).options;
  return options?.modelRefs;
};

const normalizeAgentModelFields = (agent: AgentWithExtras): AgentWithExtras => {
  const rawModelRefs = normalizeAgentModelRefs((agent as { modelRefs?: unknown }).modelRefs);
  const optionModelRefs = normalizeAgentModelRefs(getAgentOptionModelRefs(agent));
  const modelRefs = rawModelRefs.length > 0
    ? rawModelRefs
    : (optionModelRefs.length > 0 ? optionModelRefs : normalizeAgentModelRefs((agent as { model?: unknown }).model));
  if (modelRefs.length === 0) {
    return agent;
  }

  const firstModel = parseModelRef(modelRefs[0]);
  if (!firstModel) {
    return { ...agent, modelRefs };
  }

  return {
    ...agent,
    model: firstModel,
    modelRefs,
  };
};

export const normalizeAgentForSettings = (agent: AgentWithExtras): AgentWithExtras => normalizeAgentModelFields(agent);

export const buildSettingsAgentCatalog = (configAgents: Agent[], runtimeAgents: Agent[]): Agent[] => {
  void runtimeAgents;
  const agentsByName = new Map<string, Agent>();

  for (const agent of configAgents) {
    agentsByName.set(agent.name, normalizeAgentModelFields(agent as AgentWithExtras));
  }

  return Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

export const buildAgentConfigPayload = (config: Partial<AgentConfig>, options?: { defaultMode?: AgentConfig["mode"] }): Record<string, unknown> => {
  const agentConfig: Record<string, unknown> = {};

  const mode = config.mode ?? options?.defaultMode;
  if (mode !== undefined) agentConfig.mode = mode;
  if (config.description !== undefined) agentConfig.description = config.description;

  const hasModelInput = config.model !== undefined || config.modelRefs !== undefined;
  if (hasModelInput) {
    const modelRefs = normalizeAgentModelRefs(config.modelRefs);
    const fallbackModelRefs = normalizeAgentModelRefs(config.model);
    const effectiveModelRefs = modelRefs.length > 0 ? modelRefs : fallbackModelRefs;
    const scalarModel = effectiveModelRefs[0] ?? modelValueToRef(config.model) ?? null;
    agentConfig.model = scalarModel;
    agentConfig.modelRefs = effectiveModelRefs.length > 0 ? effectiveModelRefs : null;
  }

  if (config.variant !== undefined) agentConfig.variant = config.variant;
  if (config.temperature !== undefined) agentConfig.temperature = config.temperature;
  if (config.top_p !== undefined) agentConfig.top_p = config.top_p;
  if (config.prompt !== undefined) agentConfig.prompt = config.prompt;
  if (config.permission !== undefined) agentConfig.permission = config.permission;
  if (config.disable !== undefined) agentConfig.disable = config.disable;
  if (config.scope !== undefined) agentConfig.scope = config.scope;

  return agentConfig;
};

const buildAgentsSignature = (agents: Agent[]): string => {
  return agents
    .map((agent) => {
      const extended = agent as AgentWithExtras;
      const rawModelRefs = normalizeAgentModelRefs((extended as { modelRefs?: unknown }).modelRefs);
      const optionModelRefs = normalizeAgentModelRefs(getAgentOptionModelRefs(extended));
      const modelRefs = rawModelRefs.length > 0
        ? rawModelRefs
        : (optionModelRefs.length > 0 ? optionModelRefs : normalizeAgentModelRefs((extended as { model?: unknown }).model));
      return [
        agent.name,
        agent.mode ?? '',
        extended.scope ?? '',
        extended.group ?? '',
        extended.description ?? '',
        modelRefs.join(','),
        String((extended as { variant?: unknown }).variant ?? ''),
        String(typeof agent.temperature === 'number' ? agent.temperature : ''),
        String(typeof agent.topP === 'number' ? agent.topP : ''),
        String(extended.hidden === true),
        String(extended.native === true),
      ].join('|');
    })
    .join('||');
};

const loadProjectAgents = async (configDirectory: string | null): Promise<{ agents: Agent[]; staleOverrides: string[] }> => {
  const query = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
  const response = await fetch(`/api/config/agents${query}`, {
    headers: {
      'Cache-Control': 'no-cache',
      ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
    },
  });

  if (!response.ok) {
    throw new Error('Failed to load project agents');
  }

  const payload = await response.json();
  const agents: unknown[] = Array.isArray(payload?.agents) ? payload.agents : [];
  return {
    agents: agents.map((agent: unknown) => normalizeAgentModelFields({
      ...(agent as AgentWithExtras),
      scope: (agent as AgentWithExtras).scope ?? 'packaged' as AgentScope,
      source: (agent as AgentWithExtras).source ?? (agent as AgentWithExtras).scope ?? 'packaged',
      native: (agent as AgentWithExtras).native ?? (agent as AgentWithExtras).scope === 'packaged',
      builtIn: (agent as AgentWithExtras).builtIn ?? (agent as AgentWithExtras).scope === 'packaged',
    })),
    staleOverrides: Array.isArray(payload?.staleOverrides)
      ? payload.staleOverrides.filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0)
      : [],
  };
};

const replaceAgentByName = (agents: Agent[], nextAgent: Agent): Agent[] => {
  let replaced = false;
  const nextAgents = agents.map((agent) => {
    if (agent.name !== nextAgent.name) {
      return agent;
    }
    replaced = true;
    return nextAgent;
  });

  return replaced ? nextAgents : [...nextAgents, nextAgent];
};

const applySavedModelOverrideToAgent = (agent: AgentWithExtras, config: Partial<AgentConfig>): AgentWithExtras => {
  const next: AgentWithExtras = { ...agent };
  const payload = buildAgentModelOverridePayload(config);

  if (Object.prototype.hasOwnProperty.call(payload, 'model')) {
    const modelRef = modelValueToRef(payload.model);
    if (modelRef) {
      const parsedModel = parseModelRef(modelRef);
      next.modelRefs = [modelRef];
      if (parsedModel) {
        next.model = parsedModel;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'variant')) {
    const nextVariant = payload.variant;
    if (typeof nextVariant === 'string') {
      next.variant = nextVariant;
    } else {
      delete next.variant;
    }
  }

  if (Array.isArray(payload.councillors)) {
    next.councillors = payload.councillors.map((entry) => ({ ...entry }));
    next.modelRefs = payload.councillors.map((entry) => entry.model);
  }

  return normalizeAgentModelFields(next);
};

const syncConfigStoreAgent = (nextAgent: Agent) => {
  useConfigStore.setState((state) => {
    const scopedEntries = Object.entries(state.directoryScoped).map(([directoryKey, snapshot]) => [
      directoryKey,
      {
        ...snapshot,
        agents: replaceAgentByName(snapshot.agents, nextAgent),
      },
    ] as const);

    return {
      agents: replaceAgentByName(state.agents, nextAgent),
      directoryScoped: Object.fromEntries(scopedEntries),
    };
  });

  const configStore = useConfigStore.getState();
  if (configStore.currentAgentName === nextAgent.name) {
    configStore.setAgent(nextAgent.name, {
      agents: replaceAgentByName(configStore.agents, nextAgent),
    });
  }
};

export type AgentScope = 'packaged' | 'project';
export type AgentOverrideMutationResponse = Record<string, unknown> | null;

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string | null;
  modelRefs?: string[];
  councillors?: Array<{ model?: string | null; variant?: string | null }>;
  variant?: string | null;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  mode?: "primary" | "subagent" | "all";
  permission?: PermissionConfig | null;

  disable?: boolean;
  scope?: AgentScope;
}

// Extended Agent type for API properties not in SDK types
export type AgentWithExtras = Agent & {
  native?: boolean;
  builtIn?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean; modelRefs?: unknown };
  scope?: AgentScope;
  source?: AgentScope;
  /** Subfolder name parsed from file path, e.g. "business", "development" */
  group?: string;
  variant?: string | null;
  /** Ordered raw model refs for council-style multi-model agents. */
  modelRefs?: string[];
  councillors?: Array<{ model: string; variant?: string | null }>;
  modelResolution?: {
    presetName: string | null;
    source: 'root-override' | 'preset' | 'root';
    presetModelRef: string | null;
    presetVariant: string | null;
  };
};

export const buildAgentModelOverridePayload = (config: Partial<AgentConfig>): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  const model = modelValueToRef(config.model);
  if (model) {
    payload.model = model;
  }

  if (Object.prototype.hasOwnProperty.call(config, 'variant')) {
    payload.variant = config.variant && config.variant.trim().length > 0 ? config.variant : null;
  }

  if (Array.isArray(config.councillors)) {
    payload.councillors = config.councillors
      .map((entry) => {
        const councillorModel = modelValueToRef(entry.model);
        if (!councillorModel) {
          return null;
        }
        return {
          model: councillorModel,
          variant: entry.variant && entry.variant.trim().length > 0 ? entry.variant : null,
        };
      })
      .filter((entry): entry is { model: string; variant: string | null } => Boolean(entry));
  }

  return payload;
};

// Helper to check if agent is packaged (handles older builtIn/native metadata too).
export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.scope === 'packaged' || extended.source === 'packaged' || extended.native === true || extended.builtIn === true;
};

// Helper to check if agent is hidden (internal agents like title, compaction, summary)
// Checks both top-level hidden and options.hidden (OpenCode API inconsistency workaround)
export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

const normalizeAgentName = (name?: string | null) => name?.trim().toLowerCase() ?? '';

const isPlanAgentName = (name?: string | null) => normalizeAgentName(name) === 'plan';

const isBuilderAgentName = (name?: string | null) => {
  const normalized = normalizeAgentName(name);
  return normalized === 'build' || normalized === 'builder';
};

// Helper to filter only visible (non-hidden) agents
export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));

export const filterVisibleSettingsAgents = (agents: Agent[]): Agent[] =>
  filterVisibleAgents(agents).filter((agent) => !isPlanAgentName(agent.name));

export const filterVisibleAgentSelectorOptions = (agents: Agent[]): Agent[] => {
  const visibleAgents = filterVisibleAgents(agents);
  const hasBuilderAgent = visibleAgents.some((agent) => normalizeAgentName(agent.name) === 'builder');

  if (!hasBuilderAgent) {
    return visibleAgents;
  }

  // `builder` is the canonical customizable Builder agent. Hide the legacy
  // `build` alias from picker surfaces when both names are present.
  return visibleAgents.filter((agent) => !isBuilderAgentName(agent.name) || normalizeAgentName(agent.name) === 'builder');
};

const CONFIG_EVENT_SOURCE = "useAgentsStore";
interface AgentsStore {

  selectedAgentName: string | null;
  agents: Agent[];
  staleModelOverrides: string[];
  isLoading: boolean;

  setSelectedAgent: (name: string | null) => void;
  loadAgents: () => Promise<boolean>;
  getAgentByName: (name: string) => Agent | undefined;
  // Returns only visible agents (excludes hidden internal agents)
  getVisibleAgents: () => Agent[];
  saveAgentModelOverride: (name: string, config: Partial<AgentConfig>) => Promise<AgentOverrideMutationResponse>;
  resetAgentModelOverride: (name: string) => Promise<AgentOverrideMutationResponse>;
}

declare global {
  interface Window {
    __zustand_agents_store__?: UseBoundStore<StoreApi<AgentsStore>>;
  }
}

export const useAgentsStore = create<AgentsStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedAgentName: null,
        agents: [],
        staleModelOverrides: [],
        isLoading: false,

        setSelectedAgent: (name: string | null) => {
          set({ selectedAgentName: name });
        },

        loadAgents: async () => {
          const configDirectory = getConfigDirectory();
          const cacheKey = getAgentsCacheKey(configDirectory);
          const now = Date.now();
          const loadedAt = agentsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedAgents = get().agents.length > 0;

          if (hasCachedAgents && now - loadedAt < AGENTS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = agentsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            const previousAgents = get().agents;
            const previousSignature = buildAgentsSignature(previousAgents);
            const requestGeneration = agentsLoadGeneration.get(cacheKey) ?? 0;

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const { agents: configAgents, staleOverrides } = await loadProjectAgents(configDirectory);
                const agents = buildSettingsAgentCatalog(configAgents, []);

                const nextSignature = buildAgentsSignature(agents);
                if ((agentsLoadGeneration.get(cacheKey) ?? 0) !== requestGeneration) {
                  // A save/reset happened while this load was in flight. Do not let
                  // the older snapshot overwrite the just-saved model/variant values.
                  set({ staleModelOverrides: staleOverrides, isLoading: false });
                  return false;
                }
                if (previousSignature !== nextSignature) {
                  set({ agents, staleModelOverrides: staleOverrides, isLoading: false });
                } else {
                  set({ staleModelOverrides: staleOverrides, isLoading: false });
                }
                agentsLastLoadedAt.set(cacheKey, Date.now());
                return true;
              } catch {
                // ignore error
              }
            }

            set({ isLoading: false });
            return false;
          })();

          agentsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            agentsLoadInFlight.delete(cacheKey);
          }
        },

        getAgentByName: (name: string) => {
          const { agents } = get();
          return agents.find((a) => a.name === name);
        },

        getVisibleAgents: () => {
          const { agents } = get();
          return filterVisibleAgents(agents);
        },

        saveAgentModelOverride: async (name: string, config: Partial<AgentConfig>) => {
          const configDirectory = getConfigDirectory();
          const query = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
          invalidateAgentsLoadCache(configDirectory);
          const response = await fetch(`/api/config/agents/${encodeURIComponent(name)}/override${query}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify(buildAgentModelOverridePayload(config)),
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || 'Failed to save agent model override');
          }

          const payload = await response.json().catch(() => null);
          recordConfigMutationResponse(payload);
          const responseAgent = payload?.agent?.config ? normalizeAgentModelFields(payload.agent.config as AgentWithExtras) : null;
          const existingAgent = get().agents.find((agent) => agent.name === name) as AgentWithExtras | undefined;
          // Decision: reconcile successful saves locally even if a bridge/proxy returns
          // only `{ success: true }`; otherwise the form can snap back while waiting for
          // the next uncached agent reload.
          const nextAgent = responseAgent ?? (existingAgent
            ? applySavedModelOverrideToAgent(existingAgent, { ...config, name })
            : null);
          if (nextAgent?.name) {
            useSelectionStore.getState().clearAgentModelSelections(name);
            set((state) => ({
              agents: replaceAgentByName(state.agents, nextAgent),
            }));
            syncConfigStoreAgent(nextAgent as Agent);
          }
          invalidateAgentsLoadCache(configDirectory);
          return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as AgentOverrideMutationResponse : null;
        },

        resetAgentModelOverride: async (name: string) => {
          const configDirectory = getConfigDirectory();
          const query = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
          invalidateAgentsLoadCache(configDirectory);
          const response = await fetch(`/api/config/agents/${encodeURIComponent(name)}/override${query}`, {
            method: 'DELETE',
            headers: {
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || 'Failed to reset agent model override');
          }

          const payload = await response.json().catch(() => null);
          recordConfigMutationResponse(payload);
          const nextAgent = payload?.agent?.config ? normalizeAgentModelFields(payload.agent.config as AgentWithExtras) : null;
          if (nextAgent?.name) {
            useSelectionStore.getState().clearAgentModelSelections(name);
            set((state) => ({
              agents: replaceAgentByName(state.agents, nextAgent),
            }));
            syncConfigStoreAgent(nextAgent as Agent);
          }
          invalidateAgentsLoadCache(configDirectory);
          return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as AgentOverrideMutationResponse : null;
        },
      }),
      {
        name: "agents-store",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          selectedAgentName: state.selectedAgentName,
        }),
      },
    ),
    {
      name: "agents-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_agents_store__ = useAgentsStore;
}

let unsubscribeAgentsConfigChanges: (() => void) | null = null;

if (!unsubscribeAgentsConfigChanges) {
  unsubscribeAgentsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "agents")) {
      const { loadAgents } = useAgentsStore.getState();
      void loadAgents();
    }
  });
}
