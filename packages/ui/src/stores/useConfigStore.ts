import { useMemo } from "react";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { devtools } from './utils/devtoolsGate';
import type { Provider, Agent } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import type { ModelMetadata } from "@/types";
import { getSafeStorage } from "./utils/safeStorage";
import { filterVisibleAgentSelectorOptions } from "./useAgentsStore";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSelectionStore } from "@/sync/selection-store";
import { hasExplicitDraftModelIntent } from "@/sync/send-config";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { updateDesktopSettings } from "@/lib/persistence";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import {
    findSelectableAgentByName,
    resolveDefaultAgentName,
    resolveSelectableAgentOptions,
} from "@/lib/agentSelection";
import { cacheResponseStyleInstructionFromSettings } from "@/lib/responseStyle";
import { getOrderedThinkingVariants, resolveProviderModelVariant, resolveThinkingVariant } from "@/lib/providers/variantControls";
import { isProviderModelAvailable, resolveAvailableProviderModel } from "@/lib/providers/modelAvailability";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_PROXY_URL = "/api/openchamber/models-metadata";

const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";
type SttProvider = 'browser' | 'server' | 'macos' | 'wasm';
type ActiveSttProvider = Exclude<SttProvider, 'wasm'>;
export type ConfigLoadStatus = "idle" | "loading" | "ready" | "error";

const isElectronMacHost = (): boolean => {
    if (typeof window === 'undefined') return false;
    const electron = (window as unknown as { __OPENCHAMBER_ELECTRON__?: { runtime?: string } }).__OPENCHAMBER_ELECTRON__;
    const macosMajor = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (electron?.runtime === 'electron' && typeof macosMajor === 'number' && macosMajor > 0) return true;
    return electron?.runtime === 'electron' && /mac/i.test(window.navigator?.platform ?? '');
};

const normalizeSttProviderForRuntime = (provider: SttProvider): ActiveSttProvider => {
    if (provider === 'wasm') {
        return isElectronMacHost() ? 'macos' : 'browser';
    }
    return provider;
};

interface OpenChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultAgent?: string;
    defaultPlanMode?: boolean;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    responseStyleInstructionLoaded?: boolean;
}

const fetchOpenChamberDefaults = async (): Promise<OpenChamberDefaults> => {
    try {
        // 1. Runtime settings API (VSCode)
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
            try {
                const result = await runtimeSettings.load();
                const data = result?.settings;
                if (data) {
                    cacheResponseStyleInstructionFromSettings(data);
                    const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
                    const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
                    const defaultAgent = typeof data?.defaultAgent === 'string' ? data.defaultAgent.trim() : '';
                    const defaultPlanMode = typeof data?.defaultPlanMode === 'boolean' ? data.defaultPlanMode : undefined;
                    const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
                    const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
                    const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
                    const messageStreamTransport =
                        data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                            ? data.messageStreamTransport
                            : undefined;

                    return {
                        defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
                        defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
                        defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
                        defaultPlanMode,
                        autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
                        gitmojiEnabled,
                        defaultFileViewerPreview,
                        zenModel: zenModel.length > 0 ? zenModel : undefined,
                        messageStreamTransport,
                        responseStyleInstructionLoaded: true,
                    };
                }
            } catch {
                // Fall through to fetch
            }
        }

        // 2. Fetch API (Web/server)
        const response = await fetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            cacheResponseStyleInstructionFromSettings(null);
            return { responseStyleInstructionLoaded: true };
        }
        const data = await response.json();
        cacheResponseStyleInstructionFromSettings(data);
        const defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel.trim() : '';
        const defaultVariant = typeof data?.defaultVariant === 'string' ? data.defaultVariant.trim() : '';
        const defaultAgent = typeof data?.defaultAgent === 'string' ? data.defaultAgent.trim() : '';
        const defaultPlanMode = typeof data?.defaultPlanMode === 'boolean' ? data.defaultPlanMode : undefined;
        const gitmojiEnabled = typeof data?.gitmojiEnabled === 'boolean' ? data.gitmojiEnabled : undefined;
        const defaultFileViewerPreview = typeof data?.defaultFileViewerPreview === 'boolean' ? data.defaultFileViewerPreview : undefined;
        const zenModel = typeof data?.zenModel === 'string' ? data.zenModel.trim() : '';
        const messageStreamTransport =
            data?.messageStreamTransport === 'ws' || data?.messageStreamTransport === 'sse' || data?.messageStreamTransport === 'auto'
                ? data.messageStreamTransport
                : undefined;

        return {
            defaultModel: defaultModel.length > 0 ? defaultModel : undefined,
            defaultVariant: defaultVariant.length > 0 ? defaultVariant : undefined,
            defaultAgent: defaultAgent.length > 0 ? defaultAgent : undefined,
            defaultPlanMode,
            autoCreateWorktree: typeof data?.autoCreateWorktree === 'boolean' ? data.autoCreateWorktree : undefined,
            gitmojiEnabled,
            defaultFileViewerPreview,
            zenModel: zenModel.length > 0 ? zenModel : undefined,
            messageStreamTransport,
            responseStyleInstructionLoaded: true,
        };
    } catch {
        cacheResponseStyleInstructionFromSettings(null);
        return { responseStyleInstructionLoaded: true };
    }
};

const fetchConfigAgentsSnapshot = async (directory: string | null): Promise<Agent[]> => {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    try {
        const response = await fetch(`/api/config/agents${query}`, {
            headers: {
                Accept: 'application/json',
                'Cache-Control': 'no-cache',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
            },
        });
        if (!response.ok) {
            return [];
        }
        const payload = await response.json();
        return Array.isArray(payload?.agents) ? payload.agents as Agent[] : [];
    } catch {
        return [];
    }
};

const normalizeProviderId = (value: string) => value?.toLowerCase?.() ?? '';

const normalizeProviderDisplayName = (name: string) => (
    name === 'Anthropic OAuth' ? 'Anthropic' : name
);

type ProviderModel = Provider["models"][string];
type ProviderWithModelList = Omit<Provider, "models"> & { models: ProviderModel[] };

type GitModelSelection = { providerId: string; modelId: string };

const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    if (typeof error === "string" && error.trim().length > 0) {
        return error;
    }
    return fallback;
};

const hasProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string
): boolean => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        return false;
    }
    return provider.models.some((model) => model.id === modelId && isProviderModelAvailable(model));
};

export const mergeRuntimeAgentsWithConfigOverrides = (runtimeAgents: Agent[], configAgents: Agent[]): Agent[] => {
    const configByName = new Map(configAgents.map((agent) => [agent.name, agent]));
    return runtimeAgents.map((agent) => {
        const configAgent = configByName.get(agent.name) as (Agent & {
            variant?: string | null;
            modelRefs?: string[];
            councillors?: Array<{ model: string; variant?: string | null }>;
        }) | undefined;
        if (!configAgent) {
            return agent;
        }

        return {
            ...agent,
            ...(configAgent.model ? { model: configAgent.model } : {}),
            ...(Object.prototype.hasOwnProperty.call(configAgent, 'variant') ? { variant: configAgent.variant ?? undefined } : {}),
            ...(Array.isArray(configAgent.modelRefs) ? { modelRefs: configAgent.modelRefs } : {}),
            ...(Array.isArray(configAgent.councillors) ? { councillors: configAgent.councillors } : {}),
        } as Agent;
    });
};

const resolveGitGenerationModelSelection = ({
    providers,
    settingsZenModel,
}: {
    providers: ProviderWithModelList[];
    settingsZenModel?: string;
}): GitModelSelection | null => {
    const zenModel = normalizeOptionalString(settingsZenModel);

    if (!Array.isArray(providers) || providers.length === 0) {
        if (zenModel) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
        }
        return null;
    }

    if (zenModel && hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, zenModel)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
    }

    if (hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, GIT_UTILITY_PREFERRED_MODEL_ID)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: GIT_UTILITY_PREFERRED_MODEL_ID };
    }

    const zenProvider = providers.find((provider) => provider.id === GIT_UTILITY_PROVIDER_ID);
    if (zenProvider?.models.length) {
        const randomIndex = Math.floor(Math.random() * zenProvider.models.length);
        const randomModelId = normalizeOptionalString(zenProvider.models[randomIndex]?.id);
        if (randomModelId) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: randomModelId };
        }
    }

    return null;
};

interface ModelsDevModelEntry {
    id?: string;
    name?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    attachment?: boolean;
    modalities?: {
        input?: string[];
        output?: string[];
    };
    cost?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
    limit?: {
        context?: number;
        output?: number;
    };
    knowledge?: string;
    release_date?: string;
    last_updated?: string;
}

interface ModelsDevProviderEntry {
    id?: string;
    models?: Record<string, ModelsDevModelEntry | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");

const isModelsDevModelEntry = (value: unknown): value is ModelsDevModelEntry => {
    if (!isRecord(value)) {
        return false;
    }
    const candidate = value as ModelsDevModelEntry;
    if (candidate.modalities) {
        const { input, output } = candidate.modalities;
        if (input && !isStringArray(input)) {
            return false;
        }
        if (output && !isStringArray(output)) {
            return false;
        }
    }
    return true;
};

const isModelsDevProviderEntry = (value: unknown): value is ModelsDevProviderEntry => {
    if (!isRecord(value)) {
        return false;
    }
    const candidate = value as ModelsDevProviderEntry;
    return candidate.models === undefined || isRecord(candidate.models);
};

const buildModelMetadataKey = (providerId: string, modelId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    if (!normalizedProvider || !modelId) {
        return '';
    }
    return `${normalizedProvider}/${modelId}`;
};

const mapModalities = (cap: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean } | undefined): string[] => {
    if (!cap) return [];
    const result: string[] = [];
    if (cap.text) result.push('text');
    if (cap.audio) result.push('audio');
    if (cap.image) result.push('image');
    if (cap.video) result.push('video');
    if (cap.pdf) result.push('pdf');
    return result;
};

const deriveModelMetadata = (providerId: string, model: ProviderModel): ModelMetadata => ({
    id: model.id,
    providerId,
    name: model.name,
    tool_call: model.capabilities?.toolcall,
    reasoning: model.capabilities?.reasoning,
    temperature: model.capabilities?.temperature,
    attachment: model.capabilities?.attachment,
    modalities: model.capabilities ? {
        input: mapModalities(model.capabilities.input),
        output: mapModalities(model.capabilities.output),
    } : undefined,
    cost: model.cost ? {
        input: model.cost.input,
        output: model.cost.output,
        cache_read: model.cost.cache?.read,
        cache_write: model.cost.cache?.write,
    } : undefined,
    limit: model.limit,
    release_date: model.release_date,
});

const transformModelsDevResponse = (payload: unknown): Map<string, ModelMetadata> => {
    const metadataMap = new Map<string, ModelMetadata>();

    if (!isRecord(payload)) {
        return metadataMap;
    }

    for (const [providerKey, providerValue] of Object.entries(payload)) {
        if (!isModelsDevProviderEntry(providerValue)) {
            continue;
        }

        const providerId = typeof providerValue.id === 'string' && providerValue.id.length > 0 ? providerValue.id : providerKey;
        const models = providerValue.models;
        if (!models || !isRecord(models)) {
            continue;
        }

        for (const [modelKey, modelValue] of Object.entries(models)) {
            if (!isModelsDevModelEntry(modelValue)) {
                continue;
            }

            const resolvedModelId =
                typeof modelKey === 'string' && modelKey.length > 0
                    ? modelKey
                    : modelValue.id;

            if (!resolvedModelId || typeof resolvedModelId !== 'string' || resolvedModelId.length === 0) {
                continue;
            }

            const metadata: ModelMetadata = {
                id: typeof modelValue.id === 'string' && modelValue.id.length > 0 ? modelValue.id : resolvedModelId,
                providerId,
                name: typeof modelValue.name === 'string' ? modelValue.name : undefined,
                tool_call: typeof modelValue.tool_call === 'boolean' ? modelValue.tool_call : undefined,
                reasoning: typeof modelValue.reasoning === 'boolean' ? modelValue.reasoning : undefined,
                temperature: typeof modelValue.temperature === 'boolean' ? modelValue.temperature : undefined,
                attachment: typeof modelValue.attachment === 'boolean' ? modelValue.attachment : undefined,
                modalities: modelValue.modalities
                    ? {
                          input: isStringArray(modelValue.modalities.input) ? modelValue.modalities.input : undefined,
                          output: isStringArray(modelValue.modalities.output) ? modelValue.modalities.output : undefined,
                      }
                    : undefined,
                cost: modelValue.cost,
                limit: modelValue.limit,
                knowledge: typeof modelValue.knowledge === 'string' ? modelValue.knowledge : undefined,
                release_date: typeof modelValue.release_date === 'string' ? modelValue.release_date : undefined,
                last_updated: typeof modelValue.last_updated === 'string' ? modelValue.last_updated : undefined,
            };

            const key = buildModelMetadataKey(providerId, resolvedModelId);
            if (key) {
                metadataMap.set(key, metadata);
            }
        }
    }

    return metadataMap;
};

const fetchModelsDevMetadata = async (): Promise<Map<string, ModelMetadata>> => {
    if (typeof fetch !== 'function') {
        return new Map();
    }

    const sources = [MODELS_DEV_PROXY_URL, MODELS_DEV_API_URL];

    for (const source of sources) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        const timeout = controller ? setTimeout(() => controller.abort(), 8000) : undefined;

        try {
            const isAbsoluteUrl = /^https?:\/\//i.test(source);
            const requestInit: RequestInit = {
                signal: controller?.signal,
                headers: {
                    Accept: 'application/json',
                },
                cache: 'no-store',
            };

            if (isAbsoluteUrl) {
                requestInit.mode = 'cors';
            } else {
                requestInit.credentials = 'same-origin';
            }

            const response = await fetch(source, requestInit);

            if (!response.ok) {
                throw new Error(`Metadata request to ${source} returned status ${response.status}`);
            }

            const data = await response.json();
            return transformModelsDevResponse(data);
        } catch (error: unknown) {
            if ((error as Error)?.name === 'AbortError') {
                console.warn(`Model metadata request aborted (${source})`);
            } else {
                console.warn(`Failed to fetch model metadata from ${source}:`, error);
            }
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    return new Map();
};

let modelsMetadataInFlight: Promise<Map<string, ModelMetadata>> | null = null;

const ensureModelsMetadataFetch = (
    getModelsMetadata: () => Map<string, ModelMetadata>,
    setModelsMetadata: (metadata: Map<string, ModelMetadata>) => void,
) => {
    const existing = getModelsMetadata();
    if (existing.size > 0) {
        return;
    }

    if (modelsMetadataInFlight) {
        return;
    }

    modelsMetadataInFlight = fetchModelsDevMetadata()
        .then((metadata) => {
            if (metadata.size > 0) {
                setModelsMetadata(metadata);
            }
            return metadata;
        })
        .catch(() => new Map<string, ModelMetadata>())
        .finally(() => {
            modelsMetadataInFlight = null;
        });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_PROBE_TIMEOUT_MS = 800;

const probeOpenCodeHealth = async (timeoutMs = CONNECTION_PROBE_TIMEOUT_MS): Promise<boolean> => {
    return Promise.race([
        opencodeClient.checkHealth().catch(() => false),
        sleep(Math.max(1, timeoutMs)).then(() => false),
    ]);
};

const DIRECTORY_KEY_GLOBAL = "__global__";

const toDirectoryKey = (directory: string | null | undefined): string => {
    const trimmed = typeof directory === 'string' ? directory.trim() : '';
    return trimmed.length > 0 ? trimmed : DIRECTORY_KEY_GLOBAL;
};

const fromDirectoryKey = (key: string): string | null => (key === DIRECTORY_KEY_GLOBAL ? null : key);

const resolveInitialDirectoryKey = (): string => {
    if (typeof window === 'undefined') {
        return DIRECTORY_KEY_GLOBAL;
    }

    const directory = opencodeClient.getDirectory() ?? useDirectoryStore.getState().currentDirectory;
    return toDirectoryKey(directory);
};

interface DirectoryScopedConfig {

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant?: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
}

interface ConfigStore {

    activeDirectoryKey: string;
    directoryScoped: Record<string, DirectoryScopedConfig>;

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    agentModelSelections: { [agentName: string]: { providerId: string; modelId: string } };
    defaultProviders: { [key: string]: string };
    isConnected: boolean;
    hasEverConnected: boolean;
    connectionPhase: "connecting" | "connected" | "reconnecting";
    lastDisconnectReason: string | null;
    isInitialized: boolean;
    providersLoadStatus: ConfigLoadStatus;
    providersLoadError: string | undefined;
    agentsLoadStatus: ConfigLoadStatus;
    agentsLoadError: string | undefined;
    responseStyleInstructionLoaded: boolean;
    modelsMetadata: Map<string, ModelMetadata>;
    // Persisted OpenChamber defaults. Model/variant fields are retained only for
    // compatibility with older settings files; new sessions resolve from agents.
    settingsDefaultModel: string | undefined; // format: "provider/model"
    settingsDefaultVariant: string | undefined;
    settingsDefaultAgent: string | undefined;
    settingsDefaultPlanMode: boolean;
    settingsAutoCreateWorktree: boolean;
    settingsGitmojiEnabled: boolean;
    settingsDefaultFileViewerPreview: boolean;
    settingsZenModel: string | undefined;
    settingsMessageStreamTransport: 'auto' | 'ws' | 'sse';
    // Voice provider preference ('browser', 'openai', 'openai-compatible', or 'say' for macOS)
    voiceProvider: 'browser' | 'openai' | 'openai-compatible' | 'say';
    setVoiceProvider: (provider: 'browser' | 'openai' | 'openai-compatible' | 'say') => void;
    // TTS settings
    speechRate: number;
    speechPitch: number;
    speechVolume: number;
    sayVoice: string;
    browserVoice: string;
    openaiVoice: string;
    openaiApiKey: string;
    openaiCompatibleUrl: string;
    openaiCompatibleVoice: string;
    openaiCompatibleTtsModel: string;
    // STT (speech-to-text) settings
    sttProvider: SttProvider;
    voiceInputDeviceId: string;
    sttServerUrl: string;
    sttModel: string;
    wasmSttModel: string;
    sttLanguage: string;
    sttSilenceThresholdDb: number;
    sttSilenceHoldMs: number;
    showMessageTTSButtons: boolean;
    voiceModeEnabled: boolean;
    voicePlaybackEnabled: boolean;
    // Summarization settings
    summarizeMessageTTS: boolean;
    summarizeCharacterThreshold: number;
    summarizeMaxLength: number;
    setSpeechRate: (rate: number) => void;
    setSpeechPitch: (pitch: number) => void;
    setSpeechVolume: (volume: number) => void;
    setSayVoice: (voice: string) => void;
    setBrowserVoice: (voice: string) => void;
    setOpenaiVoice: (voice: string) => void;
    setOpenaiApiKey: (apiKey: string) => void;
    setOpenaiCompatibleUrl: (url: string) => void;
    setOpenaiCompatibleVoice: (voice: string) => void;
    setOpenaiCompatibleTtsModel: (model: string) => void;
    setSttProvider: (provider: SttProvider) => void;
    setVoiceInputDeviceId: (deviceId: string) => void;
    setSttServerUrl: (url: string) => void;
    setSttModel: (model: string) => void;
    setWasmSttModel: (model: string) => void;
    setSttLanguage: (lang: string) => void;
    setSttSilenceThresholdDb: (db: number) => void;
    setSttSilenceHoldMs: (ms: number) => void;
    setShowMessageTTSButtons: (show: boolean) => void;
    setVoiceModeEnabled: (enabled: boolean) => void;
    setVoicePlaybackEnabled: (enabled: boolean) => void;
    setSummarizeMessageTTS: (enabled: boolean) => void;
    setSummarizeCharacterThreshold: (threshold: number) => void;
    setSummarizeMaxLength: (maxLength: number) => void;

    activateDirectory: (directory: string | null | undefined) => Promise<void>;

    loadProviders: (options?: { directory?: string | null }) => Promise<void>;
    loadAgents: (options?: { directory?: string | null }) => Promise<boolean>;
    invalidateModelMetadataCache: () => void;
    setProvider: (providerId: string) => void;
    setProviderModel: (providerId: string, modelId: string, variant?: string) => void;
    setModel: (modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
    cycleCurrentVariant: () => void;
    getCurrentModelVariants: () => string[];
    setAgent: (
        agentName: string | undefined,
        options?: { agents?: Agent[]; preserveCurrentModel?: boolean; recordSessionSelection?: boolean },
    ) => void;
    applyDefaultsToCurrent: (options?: {
        preserveCurrentModel?: boolean;
        preserveRehydratedDraftModel?: boolean;
    }) => void;
    setSelectedProvider: (providerId: string) => void;
    setSettingsDefaultModel: (model: string | undefined) => void;
    setSettingsDefaultVariant: (variant: string | undefined) => void;
    setSettingsDefaultAgent: (agent: string | undefined) => void;
    setSettingsDefaultPlanMode: (enabled: boolean) => void;
    setSettingsAutoCreateWorktree: (enabled: boolean) => void;
    setSettingsGitmojiEnabled: (enabled: boolean) => void;
    setSettingsDefaultFileViewerPreview: (enabled: boolean) => void;
    setSettingsZenModel: (model: string | undefined) => void;
    setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => void;
    getResolvedGitGenerationModel: () => { providerId: string; modelId: string } | null;
    saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => void;
    getAgentModelSelection: (agentName: string) => { providerId: string; modelId: string } | null;
    probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
    checkConnection: () => Promise<boolean>;
    initializeApp: () => Promise<void>;
    getCurrentProvider: () => ProviderWithModelList | undefined;
    getCurrentModel: () => ProviderModel | undefined;
    getCurrentAgent: () => Agent | undefined;
    getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
    // Returns only visible agents (excludes hidden internal agents like title, compaction, summary)
    getVisibleAgents: () => Agent[];
}

const emptyDirectoryScopedConfig = (): DirectoryScopedConfig => ({
    providers: [],
    agents: [],
    currentProviderId: "",
    currentModelId: "",
    currentVariant: undefined,
    currentAgentName: undefined,
    selectedProviderId: "",
    agentModelSelections: {},
    defaultProviders: {},
});

const directoryScopedConfigFromActiveState = (state: ConfigStore): DirectoryScopedConfig => ({
    providers: state.providers,
    agents: state.agents,
    currentProviderId: state.currentProviderId,
    currentModelId: state.currentModelId,
    currentVariant: state.currentVariant,
    currentAgentName: state.currentAgentName,
    selectedProviderId: state.selectedProviderId,
    agentModelSelections: state.agentModelSelections,
    defaultProviders: state.defaultProviders,
});

const getDirectoryScopedConfigBase = (
    state: ConfigStore,
    directoryKey: string,
): DirectoryScopedConfig => (
    state.directoryScoped[directoryKey]
    ?? (state.activeDirectoryKey === directoryKey
        ? directoryScopedConfigFromActiveState(state)
        : emptyDirectoryScopedConfig())
);

declare global {
    interface Window {
        __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
    }
}

// In-flight dedup: prevent concurrent duplicate loadProviders/loadAgents calls for the same directory
const _inFlightProviders = new Map<string, Promise<void>>();
const _inFlightAgents = new Map<string, Promise<boolean>>();
let _initializeAppInFlight: Promise<void> | null = null;

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                directoryScoped: {},

                providers: [],
                agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                defaultProviders: {},
                isConnected: false,
                hasEverConnected: false,
                connectionPhase: "connecting",
                lastDisconnectReason: null,
                isInitialized: false,
                providersLoadStatus: "idle",
                providersLoadError: undefined,
                agentsLoadStatus: "idle",
                agentsLoadError: undefined,
                responseStyleInstructionLoaded: false,
                modelsMetadata: new Map<string, ModelMetadata>(),
                settingsDefaultModel: undefined,
                settingsDefaultVariant: undefined,
                settingsDefaultAgent: undefined,
                settingsDefaultPlanMode: false,
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsDefaultFileViewerPreview: false,
                settingsZenModel: undefined,
                settingsMessageStreamTransport: 'auto',
                // Voice provider preference - load from localStorage or default to 'browser'
                voiceProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceProvider');
                        if (saved === 'openai' || saved === 'browser' || saved === 'say' || saved === 'openai-compatible') return saved;
                    }
                    return 'browser';
                })(),
                // TTS settings - load from localStorage with defaults
                speechRate: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechRate');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechPitch: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechPitch');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechVolume: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechVolume');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
                        }
                    }
                    return 1;
                })(),
                // macOS Say voice - load from localStorage or default to 'Samantha'
                sayVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sayVoice');
                        if (saved) return saved;
                    }
                    return 'Samantha';
                })(),
                // Browser voice - load from localStorage or default to empty (auto-select)
                browserVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('browserVoice');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI voice - load from localStorage or default to 'nova'
                openaiVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiVoice');
                        if (saved) return saved;
                    }
                    return 'nova';
                })(),
                // OpenAI API key for TTS - load from localStorage or default to empty
                openaiApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server URL
                openaiCompatibleUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleUrl');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server voice
                openaiCompatibleVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleVoice');
                        if (saved) return saved;
                    }
                    return 'af_sky';
                })(),
                // OpenAI-compatible custom server TTS model
                openaiCompatibleTtsModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleTtsModel');
                        if (saved && saved !== 'speaches-ai/Kokoro-82M-v1.0-ONNX') return saved;
                    }
                    return 'kokoro';
                })(),
                // STT provider: 'browser' (Web Speech API), 'server' (OpenAI-compat), or 'macos' (native Apple Speech).
                sttProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttProvider');
                        if (saved === 'browser' || saved === 'server' || saved === 'macos' || saved === 'wasm') {
                            return normalizeSttProviderForRuntime(saved);
                        }
                    }
                    if (isElectronMacHost()) return 'macos' as const;
                    return 'browser' as const;
                })(),
                voiceInputDeviceId: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceInputDeviceId');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                sttServerUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttServerUrl');
                        if (saved) return saved;
                    }
                    return 'http://localhost:8001/v1';
                })(),
                sttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttModel');
                        if (saved) return saved;
                    }
                    return 'deepdml/faster-whisper-large-v3-turbo-ct2';
                })(),
                wasmSttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('wasmSttModel');
                        if (saved) return saved;
                    }
                    return 'Xenova/whisper-base.en';
                })(),
                sttLanguage: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLanguage');
                        if (saved !== null) return saved;
                    }
                    return '';
                })(),
                sttSilenceThresholdDb: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttSilenceThresholdDb');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed)) return parsed;
                        }
                    }
                    return -45;
                })(),
                sttSilenceHoldMs: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttSilenceHoldMs');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed)) return parsed;
                        }
                    }
                    return 1500;
                })(),
                // Show TTS buttons on messages - disabled by default until user enables it
                showMessageTTSButtons: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('showMessageTTSButtons');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                // Voice mode enabled - load from localStorage or default to false
                voiceModeEnabled: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceModeEnabled');
                        if (saved === 'false') return false;
                        if (saved === 'true') return true;
                    }
                    return true;
                })(),
                voicePlaybackEnabled: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voicePlaybackEnabled');
                        if (saved === 'true') return true;
                        if (saved === 'false') return false;
                    }
                    return false;
                })(),
                // Summarization settings
                summarizeMessageTTS: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMessageTTS');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeCharacterThreshold: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeCharacterThreshold');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 200;
                })(),
                summarizeMaxLength: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMaxLength');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 500;
                })(),
                activateDirectory: async (directory) => {
                    const directoryKey = toDirectoryKey(directory);

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        if (snapshot) {
                            return {
                                activeDirectoryKey: directoryKey,
                                providers: snapshot.providers,
                                agents: snapshot.agents,
                                currentProviderId: snapshot.currentProviderId,
                                currentModelId: snapshot.currentModelId,
                                currentVariant: snapshot.currentVariant,
                                currentAgentName: snapshot.currentAgentName,
                                selectedProviderId: snapshot.selectedProviderId,
                                agentModelSelections: snapshot.agentModelSelections,
                                defaultProviders: snapshot.defaultProviders,
                            };
                        }

                        return {
                            activeDirectoryKey: directoryKey,
                            providers: [],
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentVariant: undefined,
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };
                    });

                    if (!get().isConnected) {
                        return;
                    }

                    await get().loadProviders({ directory: fromDirectoryKey(directoryKey) });
                    await get().loadAgents({ directory: fromDirectoryKey(directoryKey) });
                },

                loadProviders: async (options) => {
                    const directoryKey = toDirectoryKey(options?.directory ?? fromDirectoryKey(get().activeDirectoryKey));

                    // Dedup: if a load is already in-flight for this directory, reuse it
                    const existing = _inFlightProviders.get(directoryKey);
                    if (existing) return existing;
                    if (get().activeDirectoryKey === directoryKey) {
                        set({ providersLoadStatus: "loading", providersLoadError: undefined });
                    }

                    const promise = (async () => {
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousProviders = existingSnapshot?.providers ?? (get().activeDirectoryKey === directoryKey ? get().providers : []);
                    const previousDefaults = existingSnapshot?.defaultProviders ?? (get().activeDirectoryKey === directoryKey ? get().defaultProviders : {});
                    let lastError: unknown = null;

                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            ensureModelsMetadataFetch(
                                () => get().modelsMetadata,
                                (metadata) => set({ modelsMetadata: metadata }),
                            );
                            const apiResult = await opencodeClient.withDirectory(
                                fromDirectoryKey(directoryKey),
                                () => opencodeClient.getProviders()
                            );
                            const providers = Array.isArray(apiResult?.providers) ? apiResult.providers : [];
                            const defaults = apiResult?.default || {};

                            const processedProviders: ProviderWithModelList[] = providers.map((provider) => {
                                const modelRecord = provider.models ?? {};
                                const models: ProviderModel[] = Object.keys(modelRecord).map((modelId) => modelRecord[modelId]);
                                return {
                                    ...provider,
                                    name: normalizeProviderDisplayName(provider.name),
                                    models,
                                };
                            });

                            set((state) => {
                                const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers: processedProviders,
                                    defaultProviders: defaults,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.providers = processedProviders;
                                    nextState.defaultProviders = defaults;
                                    nextState.providersLoadStatus = "ready";
                                    nextState.providersLoadError = undefined;

                                    // Ensure a valid model stays selected after (re)loading providers.
                                    // Otherwise switching to an uncached directory (which blanks the
                                    // selection in activateDirectory) leaves the composer stuck on
                                    // "Not selected" even though a model is available. Only resolve a
                                    // default when the current selection is missing/unavailable — never
                                    // override a still-valid explicit choice.
                                    const selectionIsValid = Boolean(state.currentProviderId)
                                        && Boolean(state.currentModelId)
                                        && processedProviders.some((p) => p.id === state.currentProviderId
                                            && p.models.some((m) => m.id === state.currentModelId && isProviderModelAvailable(m)));
                                    if (!selectionIsValid) {
                                        let resolved: { providerId: string; modelId: string } | null = null;
                                        for (const p of processedProviders) {
                                            const def = defaults?.[p.id];
                                            if (def && p.models.some((m) => m.id === def && isProviderModelAvailable(m))) {
                                                resolved = { providerId: p.id, modelId: def };
                                                break;
                                            }
                                        }
                                        if (!resolved) {
                                            const firstWithModel = processedProviders.find((p) => p.models.some(isProviderModelAvailable));
                                            if (firstWithModel) {
                                                resolved = {
                                                    providerId: firstWithModel.id,
                                                    modelId: firstWithModel.models.find(isProviderModelAvailable)?.id ?? "",
                                                };
                                            }
                                        }
                                        if (resolved) {
                                            nextState.currentProviderId = resolved.providerId;
                                            nextState.currentModelId = resolved.modelId;
                                            nextState.selectedProviderId = resolved.providerId;
                                            nextSnapshot.currentProviderId = resolved.providerId;
                                            nextSnapshot.currentModelId = resolved.modelId;
                                            nextSnapshot.selectedProviderId = resolved.providerId;
                                        }
                                    }
                                }

                                return nextState;
                            });

                            return;
                        } catch (error) {
                            lastError = error;
                            const waitMs = 200 * (attempt + 1);
                            await new Promise((resolve) => setTimeout(resolve, waitMs));
                        }
                    }

                    console.error("Failed to load providers:", lastError);
                    const errorMessage = getErrorMessage(lastError, "Failed to load providers");

                    set((state) => {
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers: previousProviders,
                            defaultProviders: previousDefaults,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.providers = previousProviders;
                            nextState.defaultProviders = previousDefaults;
                            nextState.providersLoadStatus = "error";
                            nextState.providersLoadError = errorMessage;
                        }

                        return nextState;
                    });
                    })().finally(() => _inFlightProviders.delete(directoryKey));

                    _inFlightProviders.set(directoryKey, promise);
                    return promise;
                },

                setProvider: (providerId: string) => {
                    const { providers } = get();
                    const provider = providers.find((p) => p.id === providerId);
 
                    if (!provider) {
                        return;
                    }
 
                    const firstModel = provider.models.find(isProviderModelAvailable);
                    const newModelId = firstModel?.id || "";
 
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                        };

                        return {
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setProviderModel: (providerId: string, modelId: string, variant?: string) => {
                    const { providers } = get();
                    const provider = providers.find((p) => p.id === providerId);
                    if (!provider?.models.some((model) => model.id === modelId && isProviderModelAvailable(model))) {
                        return;
                    }

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentProviderId: providerId,
                            currentModelId: modelId,
                            currentVariant: variant,
                            selectedProviderId: providerId,
                        };

                        return {
                            currentProviderId: providerId,
                            currentModelId: modelId,
                            currentVariant: variant,
                            selectedProviderId: providerId,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setModel: (modelId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);
 
                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentModelId: modelId,
                        };
 
                        return {
                            currentModelId: modelId,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setCurrentVariant: (variant: string | undefined) => {
                    set((state) => {
                        if (state.currentVariant === variant) {
                            return state;
                        }

                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentVariant: variant,
                        };

                        return {
                            currentVariant: variant,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getCurrentModelVariants: () => {
                    const model = get().getCurrentModel();
                    const variants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
                    return getOrderedThinkingVariants(variants, { providerId: get().currentProviderId });
                },

                cycleCurrentVariant: () => {
                    const variantKeys = get().getCurrentModelVariants();
                    if (variantKeys.length === 0) {
                        return;
                    }

                    const current = get().currentVariant;
                    if (!current || !variantKeys.includes(current)) {
                        get().setCurrentVariant(resolveThinkingVariant(
                            current,
                            variantKeys,
                            { providerId: get().currentProviderId },
                        ));
                        return;
                    }

                    const index = variantKeys.indexOf(current);
                    const nextIndex = (index + 1) % variantKeys.length;
                    get().setCurrentVariant(variantKeys[nextIndex]);
                },
 
                setSelectedProvider: (providerId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            selectedProviderId: providerId,
                        };

                        return {
                            selectedProviderId: providerId,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                saveAgentModelSelection: (agentName: string, providerId: string, modelId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const nextSelections = {
                            ...state.agentModelSelections,
                            [agentName]: { providerId, modelId },
                        };

                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            agentModelSelections: nextSelections,
                        };

                        return {
                            agentModelSelections: nextSelections,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getAgentModelSelection: (agentName: string) => {
                    const { agentModelSelections } = get();
                    return agentModelSelections[agentName] || null;
                },

                applyDefaultsToCurrent: (options) => {
                    const state = get();
                    const selectable = resolveSelectableAgentOptions(state.agents ?? [], []);
                    const defaultName = resolveDefaultAgentName(state.settingsDefaultAgent, selectable);
                    const target = findSelectableAgentByName(selectable, defaultName);
                    if (!target) {
                        return;
                    }

                    const sessionState = useSessionUIStore.getState();
                    const currentDraftId = sessionState.currentSessionId ? null : sessionState.currentDraftId;
                    const draftSendConfig = currentDraftId
                        ? (sessionState.draftsById[currentDraftId]?.sendConfig ?? sessionState.newSessionDraft?.sendConfig)
                        : undefined;
                    const hasExplicitDraftModel = !!currentDraftId && hasExplicitDraftModelIntent(draftSendConfig);
                    const isReapplyingCurrentAgent = !state.currentAgentName || state.currentAgentName === target.name;
                    const hasRehydratedDraftVariant = !sessionState.currentSessionId
                        && options?.preserveRehydratedDraftModel !== false
                        && isReapplyingCurrentAgent
                        && draftSendConfig?.modelProvenance !== 'agent-default'
                        && typeof state.currentVariant === 'string'
                        && state.currentVariant.trim().length > 0
                        && hasProviderModel(state.providers, state.currentProviderId, state.currentModelId);

                    get().setAgent(target.name, {
                        preserveCurrentModel: options?.preserveCurrentModel === true
                            || hasExplicitDraftModel
                            || hasRehydratedDraftVariant,
                        recordSessionSelection: false,
                    });
                },

                loadAgents: async (options) => {
                    const directoryKey = toDirectoryKey(options?.directory ?? fromDirectoryKey(get().activeDirectoryKey));

                    // Dedup: if a load is already in-flight for this directory, reuse it
                    const existing = _inFlightAgents.get(directoryKey);
                    if (existing) return existing;
                    if (get().activeDirectoryKey === directoryKey) {
                        set({ agentsLoadStatus: "loading", agentsLoadError: undefined });
                    }

                    const promise = (async (): Promise<boolean> => {
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousAgents = existingSnapshot?.agents ?? (get().activeDirectoryKey === directoryKey ? get().agents : []);
                    let lastError: unknown = null;

                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            // Fetch agents and OpenChamber settings in parallel
                            const directory = fromDirectoryKey(directoryKey);
                            const [agents, configAgents, openChamberDefaults] = await Promise.all([
                                opencodeClient.withDirectory(fromDirectoryKey(directoryKey), () => opencodeClient.listAgentsStrict()),
                                fetchConfigAgentsSnapshot(directory),
                                fetchOpenChamberDefaults(),
                            ]);

                            const safeAgents = mergeRuntimeAgentsWithConfigOverrides(
                                Array.isArray(agents) ? agents : [],
                                configAgents,
                            );

                            const providers = get().activeDirectoryKey === directoryKey
                                ? get().providers
                                : (get().directoryScoped[directoryKey]?.providers ?? []);

                            const existingZenModel = normalizeOptionalString(get().settingsZenModel);

                            const defaultZenModel = normalizeOptionalString(openChamberDefaults.zenModel);

                            const resolvedExistingGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: existingZenModel,
                            });

                            const resolvedDefaultGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: defaultZenModel,
                            });

                            const resolvedGitSelection = resolvedExistingGitSelection || resolvedDefaultGitSelection;
                            const resolvedGitModelId = resolvedGitSelection?.modelId;
                            const resolvedZenModel = resolvedGitModelId || defaultZenModel || existingZenModel;
                            const resolvedDefaultPlanMode = openChamberDefaults.defaultPlanMode ?? false;

                            set((state) => {
                                const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers,
                                    agents: safeAgents,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    settingsDefaultModel: openChamberDefaults.defaultModel,
                                    settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                    settingsDefaultAgent: openChamberDefaults.defaultAgent,
                                    settingsDefaultPlanMode: resolvedDefaultPlanMode,
                                    settingsAutoCreateWorktree: openChamberDefaults.autoCreateWorktree ?? false,
                                    settingsGitmojiEnabled: openChamberDefaults.gitmojiEnabled ?? false,
                                    settingsDefaultFileViewerPreview: openChamberDefaults.defaultFileViewerPreview ?? false,
                                    settingsZenModel: resolvedZenModel,
                                    settingsMessageStreamTransport: openChamberDefaults.messageStreamTransport ?? state.settingsMessageStreamTransport ?? 'auto',
                                    responseStyleInstructionLoaded: openChamberDefaults.responseStyleInstructionLoaded ?? state.responseStyleInstructionLoaded,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.agents = safeAgents;
                                    nextState.agentsLoadStatus = "ready";
                                    nextState.agentsLoadError = undefined;
                                }

                                return nextState;
                            });
                            useSelectionStore.getState().setDefaultPlanModeSelection(resolvedDefaultPlanMode);

                            const shouldPersistResolvedZenModel =
                                !!resolvedZenModel &&
                                resolvedZenModel !== defaultZenModel;

                            if (shouldPersistResolvedZenModel && resolvedZenModel) {
                                updateDesktopSettings({
                                    zenModel: resolvedZenModel,
                                    gitProviderId: '',
                                    gitModelId: '',
                                }).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            if (safeAgents.length === 0) {
                                set((state) => {
                                    const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                                    const nextSnapshot: DirectoryScopedConfig = {
                                        ...baseSnapshot,
                                        providers,
                                        agents: [],
                                        currentAgentName: undefined,
                                    };

                                    const nextState: Partial<ConfigStore> = {
                                        directoryScoped: {
                                            ...state.directoryScoped,
                                            [directoryKey]: nextSnapshot,
                                        },
                                    };

                                    if (state.activeDirectoryKey === directoryKey) {
                                        nextState.currentAgentName = undefined;
                                    }

                                    return nextState;
                                });

                                return true;
                            }

                            const selectableSafeAgents = resolveSelectableAgentOptions(safeAgents, []);
                            const invalidSettings: { defaultAgent?: string } = {};
                            const settingsAgent = openChamberDefaults.defaultAgent
                                ? findSelectableAgentByName(selectableSafeAgents, openChamberDefaults.defaultAgent)
                                : undefined;
                            if (openChamberDefaults.defaultAgent && !settingsAgent) {
                                // Agent no longer exists, is hidden/internal, or is not primary-selectable.
                                invalidSettings.defaultAgent = '';
                            }

                            if (Object.keys(invalidSettings).length > 0) {
                                set({
                                    settingsDefaultAgent: invalidSettings.defaultAgent !== undefined ? undefined : get().settingsDefaultAgent,
                                });
                                updateDesktopSettings(invalidSettings).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            if (get().activeDirectoryKey === directoryKey) {
                                get().applyDefaultsToCurrent();
                            }

                            return true;
                        } catch (error) {
                            lastError = error;
                            const waitMs = 200 * (attempt + 1);
                            await new Promise((resolve) => setTimeout(resolve, waitMs));
                        }
                    }

                    console.error("Failed to load agents:", lastError);
                    const errorMessage = getErrorMessage(lastError, "Failed to load agents");

                    set((state) => {
                        const providers = state.activeDirectoryKey === directoryKey
                            ? state.providers
                            : (state.directoryScoped[directoryKey]?.providers ?? []);

                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents: previousAgents,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.agents = previousAgents;
                            nextState.agentsLoadStatus = "error";
                            nextState.agentsLoadError = errorMessage;
                        }

                        return nextState;
                    });

                    return false;
                    })().finally(() => _inFlightAgents.delete(directoryKey));

                    _inFlightAgents.set(directoryKey, promise);
                    return promise;
                },

                invalidateModelMetadataCache: () => {
                    modelsMetadataInFlight = null;
                    set({ modelsMetadata: new Map<string, ModelMetadata>() });
                },

                setAgent: (
                    agentName: string | undefined,
                    options?: { agents?: Agent[]; preserveCurrentModel?: boolean; recordSessionSelection?: boolean },
                ) => {
                    const {
                        agents,
                        providers,
                        currentProviderId,
                        currentModelId,
                    } = get();
                    const agentOptions = options?.agents?.length ? options.agents : agents;

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentAgentName: agentName,
                        };

                        return {
                            currentAgentName: agentName,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });

                    if (agentName && options?.recordSessionSelection !== false) {
                        const { currentSessionId } = useSessionUIStore.getState();
                        const selState = useSelectionStore.getState();

                        if (currentSessionId) {
                            selState.saveSessionAgentSelection(currentSessionId, agentName);
                        }

                        if (currentSessionId && useSessionUIStore.getState().isOpenChamberCreatedSession(currentSessionId)) {
                            const existingAgentModel = selState.getAgentModelForSession(currentSessionId, agentName);
                            if (!existingAgentModel) {
                                useSessionUIStore.getState().initializeNewOpenChamberSession(currentSessionId, agents);
                            }
                        }
                    }

                    if (options?.preserveCurrentModel) {
                        return;
                    }

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();

                        const applyResolvedModelSelection = (providerId: string, modelId: string, variant?: string) => {
                            set((state) => {
                                const directoryKey = state.activeDirectoryKey;
                                const baseSnapshot = getDirectoryScopedConfigBase(state, directoryKey);

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: providerId,
                                };

                                return {
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: providerId,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                            });
                        };

                        if (currentSessionId) {
                            const existingAgentModel = useSelectionStore.getState().getAgentModelForSession(currentSessionId, agentName);
                            if (existingAgentModel && hasProviderModel(providers, existingAgentModel.providerId, existingAgentModel.modelId)) {
                                const savedVariant = useSelectionStore.getState().getAgentModelVariantForSession(
                                    currentSessionId,
                                    agentName,
                                    existingAgentModel.providerId,
                                    existingAgentModel.modelId,
                                );
                                if (
                                    currentProviderId !== existingAgentModel.providerId
                                    || currentModelId !== existingAgentModel.modelId
                                    || get().currentVariant !== savedVariant
                                ) {
                                    applyResolvedModelSelection(existingAgentModel.providerId, existingAgentModel.modelId, savedVariant);
                                }
                                return;
                            }
                        }

                        // Agent-specific model configuration is an override. It should apply
                        // when switching agents even if the current model is otherwise valid.
                        const agent = agentOptions.find((candidate) => candidate.name === agentName);
                        const agentModelSelection = agent?.model;
                        if (agentModelSelection?.providerID && agentModelSelection?.modelID) {
                            const { providerID, modelID } = agentModelSelection;
                            const agentProvider = providers.find((provider) => provider.id === providerID);
                            const agentModel = agentProvider?.models.find((model) => model.id === modelID) as { variants?: Record<string, unknown> } | undefined;

                            if (agentModel && isProviderModelAvailable(agentModel)) {
                                const agentVariant = typeof (agent as { variant?: unknown }).variant === 'string'
                                    ? (agent as { variant: string }).variant
                                    : undefined;
                                const nextVariant = agentVariant
                                    ? resolveProviderModelVariant(agentProvider, modelID, agentVariant)
                                    : undefined;
                                applyResolvedModelSelection(providerID, modelID, nextVariant);
                                return;
                            }
                        }

                        if (hasProviderModel(providers, currentProviderId, currentModelId)) {
                            return;
                        }

                        const fallback = resolveAvailableProviderModel(
                            providers,
                            currentProviderId,
                            currentModelId,
                        );
                        if (fallback) {
                            applyResolvedModelSelection(fallback.providerId, fallback.modelId);
                        }
                    }
                },

                 setSettingsDefaultModel: (model: string | undefined) => {
                     set({ settingsDefaultModel: model });
                 },

                 setSettingsDefaultVariant: (variant: string | undefined) => {
                     set({ settingsDefaultVariant: variant });
                 },
 
                 setSettingsDefaultAgent: (agent: string | undefined) => {
                     set({ settingsDefaultAgent: agent });
                     if (useSessionUIStore.getState().currentSessionId === null) {
                         get().applyDefaultsToCurrent();
                     }
                 },

                setSettingsDefaultPlanMode: (enabled: boolean) => {
                    set({ settingsDefaultPlanMode: enabled });
                    useSelectionStore.getState().setDefaultPlanModeSelection(enabled, { syncDraft: true });
                },

                setSettingsAutoCreateWorktree: (enabled: boolean) => {
                    set({ settingsAutoCreateWorktree: enabled });
                },

                setSettingsGitmojiEnabled: (enabled: boolean) => {
                    set({ settingsGitmojiEnabled: enabled });
                },

                setSettingsDefaultFileViewerPreview: (enabled: boolean) => {
                    set({ settingsDefaultFileViewerPreview: enabled });
                },

                setSettingsZenModel: (model: string | undefined) => {
                    set({ settingsZenModel: model });
                },

                setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => {
                    set({ settingsMessageStreamTransport: transport });
                },

                getResolvedGitGenerationModel: () => {
                    const state = get();
                    return resolveGitGenerationModelSelection({
                        providers: state.providers,
                        settingsZenModel: state.settingsZenModel,
                    });
                },

                setVoiceProvider: (provider: 'browser' | 'openai' | 'openai-compatible' | 'say') => {
                    set({ voiceProvider: provider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceProvider', provider);
                    }
                },

                setSpeechRate: (rate: number) => {
                    const clampedRate = Math.max(0.5, Math.min(2, rate));
                    set({ speechRate: clampedRate });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechRate', String(clampedRate));
                    }
                },

                setSpeechPitch: (pitch: number) => {
                    const clampedPitch = Math.max(0.5, Math.min(2, pitch));
                    set({ speechPitch: clampedPitch });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechPitch', String(clampedPitch));
                    }
                },

                setSpeechVolume: (volume: number) => {
                    const clampedVolume = Math.max(0, Math.min(1, volume));
                    set({ speechVolume: clampedVolume });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechVolume', String(clampedVolume));
                    }
                },

                setSayVoice: (voice: string) => {
                    set({ sayVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sayVoice', voice);
                    }
                },

                setBrowserVoice: (voice: string) => {
                    set({ browserVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('browserVoice', voice);
                    }
                },

                setOpenaiVoice: (voice: string) => {
                    set({ openaiVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiVoice', voice);
                    }
                },

                setOpenaiApiKey: (apiKey: string) => {
                    set({ openaiApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiApiKey', apiKey);
                    }
                },

                setOpenaiCompatibleUrl: (url: string) => {
                    set({ openaiCompatibleUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleUrl', url);
                    }
                },

                setOpenaiCompatibleVoice: (voice: string) => {
                    set({ openaiCompatibleVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleVoice', voice);
                    }
                },

                setOpenaiCompatibleTtsModel: (model: string) => {
                    set({ openaiCompatibleTtsModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleTtsModel', model);
                    }
                },

                setSttProvider: (provider: SttProvider) => {
                    const normalizedProvider = normalizeSttProviderForRuntime(provider);
                    set({ sttProvider: normalizedProvider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttProvider', normalizedProvider);
                    }
                    updateDesktopSettings({ sttProvider: normalizedProvider }).catch(() => {});
                },

                setVoiceInputDeviceId: (deviceId: string) => {
                    set({ voiceInputDeviceId: deviceId });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceInputDeviceId', deviceId);
                    }
                },

                setSttServerUrl: (url: string) => {
                    set({ sttServerUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttServerUrl', url);
                    }
                    updateDesktopSettings({ sttServerUrl: url }).catch(() => {});
                },

                setSttModel: (model: string) => {
                    set({ sttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttModel', model);
                    }
                    updateDesktopSettings({ sttModel: model }).catch(() => {});
                },

                setWasmSttModel: (model: string) => {
                    set({ wasmSttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('wasmSttModel', model);
                    }
                    updateDesktopSettings({ wasmSttModel: model }).catch(() => {});
                },

                setSttLanguage: (lang: string) => {
                    set({ sttLanguage: lang });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLanguage', lang);
                    }
                    updateDesktopSettings({ sttLanguage: lang }).catch(() => {});
                },

                setSttSilenceThresholdDb: (db: number) => {
                    set({ sttSilenceThresholdDb: db });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttSilenceThresholdDb', String(db));
                    }
                    updateDesktopSettings({ sttSilenceThresholdDb: db }).catch(() => {});
                },

                setSttSilenceHoldMs: (ms: number) => {
                    set({ sttSilenceHoldMs: ms });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttSilenceHoldMs', String(ms));
                    }
                    updateDesktopSettings({ sttSilenceHoldMs: ms }).catch(() => {});
                },

                setShowMessageTTSButtons: (show: boolean) => {
                    set({ showMessageTTSButtons: show });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('showMessageTTSButtons', String(show));
                    }
                },

                setVoiceModeEnabled: (enabled: boolean) => {
                    set({ voiceModeEnabled: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceModeEnabled', String(enabled));
                    }
                },

                setVoicePlaybackEnabled: (enabled: boolean) => {
                    set({ voicePlaybackEnabled: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voicePlaybackEnabled', String(enabled));
                    }
                },

                setSummarizeMessageTTS: (enabled: boolean) => {
                    set({ summarizeMessageTTS: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMessageTTS', String(enabled));
                    }
                },

                setSummarizeCharacterThreshold: (threshold: number) => {
                    const clamped = Math.max(50, Math.min(2000, threshold));
                    set({ summarizeCharacterThreshold: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeCharacterThreshold', String(clamped));
                    }
                },

                setSummarizeMaxLength: (maxLength: number) => {
                    const clamped = Math.max(50, Math.min(2000, maxLength));
                    set({ summarizeMaxLength: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMaxLength', String(clamped));
                    }
                },

                probeConnection: async (options?: { timeoutMs?: number }) => {
                    const isHealthy = await probeOpenCodeHealth(options?.timeoutMs);
                    if (isHealthy) {
                        set({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                        return true;
                    }

                    const state = get();
                    if (state.isConnected) {
                        return true;
                    }

                    set({
                        isConnected: false,
                        connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_probe_unhealthy',
                    });
                    return false;
                },

                checkConnection: async () => {
                    const maxAttempts = 5;
                    let attempt = 0;
                    let lastError: unknown = null;

                    while (attempt < maxAttempts) {
                        try {
                            const isHealthy = await opencodeClient.checkHealth();
                            const hasEverConnected = get().hasEverConnected;
                            set(isHealthy
                                ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                                : {
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                            return isHealthy;
                        } catch (error) {
                            lastError = error;
                            attempt += 1;
                            const delay = 400 * attempt;
                            await sleep(delay);
                        }
                    }

                    if (lastError) {
                        console.warn("[ConfigStore] Failed to reach OpenCode after retrying:", lastError);
                    }
                    set({
                        isConnected: false,
                        connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_check_failed',
                    });
                    return false;
                },

                initializeApp: async () => {
                    if (_initializeAppInFlight) {
                        return _initializeAppInFlight;
                    }

                    const run = (async () => {
                        try {
                            const debug = streamDebugEnabled();
                            if (debug) console.log("Starting app initialization...");

                            const isConnected = await get().checkConnection();
                            if (debug) console.log("Connection check result:", isConnected);

                            if (!isConnected) {
                                if (debug) console.log("Server not connected");
                                // checkConnection already set lastDisconnectReason; do not overwrite.
                                set({
                                    isConnected: false,
                                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                });
                                return;
                            }

                            if (debug) console.log("Loading providers...");
                            await get().loadProviders();
                            if (get().providersLoadStatus === "error") {
                                throw new Error(get().providersLoadError || "Failed to load providers");
                            }

                            if (debug) console.log("Loading agents...");
                            const agentsReady = await get().loadAgents();
                            if (!agentsReady || get().agentsLoadStatus === "error") {
                                throw new Error(get().agentsLoadError || "Failed to load agents");
                            }

                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                            if (debug) console.log("App initialized successfully");
                        } catch (error) {
                            console.error("Failed to initialize app:", error);
                            const coreDataLoadFailed =
                                get().providersLoadStatus === "error" || get().agentsLoadStatus === "error";
                            set({
                                isInitialized: false,
                                isConnected: coreDataLoadFailed ? true : false,
                                connectionPhase: coreDataLoadFailed
                                    ? "connected"
                                    : get().hasEverConnected ? "reconnecting" : "connecting",
                                lastDisconnectReason: 'init_error',
                            });
                        }
                    })().finally(() => {
                        _initializeAppInFlight = null;
                    });

                    _initializeAppInFlight = run;
                    return run;
                },

                getCurrentProvider: () => {
                    const { providers, currentProviderId } = get();
                    return providers.find((p) => p.id === currentProviderId);
                },

                getCurrentModel: () => {
                    const provider = get().getCurrentProvider();
                    const { currentModelId } = get();
                    if (!provider) {
                        return undefined;
                    }
                    return provider.models.find((model) => model.id === currentModelId);
                },

                getCurrentAgent: () => {
                    const { agents, currentAgentName } = get();
                    if (!currentAgentName) return undefined;
                    return agents.find((a) => a.name === currentAgentName);
                },
                getModelMetadata: (providerId: string, modelId: string) => {
                    const key = buildModelMetadataKey(providerId, modelId);
                    if (!key) {
                        return undefined;
                    }
                    const { modelsMetadata, providers } = get();
                    const cached = modelsMetadata.get(key);
                    if (cached) {
                        return cached;
                    }

                    // Fallback: derive metadata from provider model data (covers custom providers not in models.dev)
                    const provider = providers.find((p) => p.id === providerId);
                    if (!provider) {
                        return undefined;
                    }
                    const model = provider.models.find((m) => m.id === modelId);
                    if (!model) {
                        return undefined;
                    }

                    return deriveModelMetadata(providerId, model);
                },
                getVisibleAgents: () => {
                    const { agents } = get();
                    return filterVisibleAgentSelectorOptions(agents);
                },
            }),
            {
                name: "config-store",
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    activeDirectoryKey: state.activeDirectoryKey,
                    directoryScoped: state.directoryScoped,
                    currentProviderId: state.currentProviderId,
                    currentModelId: state.currentModelId,
                    currentVariant: state.currentVariant,
                    currentAgentName: state.currentAgentName,
                    selectedProviderId: state.selectedProviderId,
                    agentModelSelections: state.agentModelSelections,
                    defaultProviders: state.defaultProviders,
                    settingsDefaultModel: state.settingsDefaultModel,
                    settingsDefaultVariant: state.settingsDefaultVariant,
                    settingsDefaultAgent: state.settingsDefaultAgent,
                    settingsDefaultPlanMode: state.settingsDefaultPlanMode,
                    settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
                    settingsGitmojiEnabled: state.settingsGitmojiEnabled,
                    settingsDefaultFileViewerPreview: state.settingsDefaultFileViewerPreview,
                    settingsZenModel: state.settingsZenModel,
                    settingsMessageStreamTransport: state.settingsMessageStreamTransport,
                    speechRate: state.speechRate,
                    speechPitch: state.speechPitch,
                    speechVolume: state.speechVolume,
                }),
                onRehydrateStorage: () => (state) => {
                    useSelectionStore.getState().setDefaultPlanModeSelection(
                        state?.settingsDefaultPlanMode === true,
                        { syncDraft: true }
                    );
                },
             },
         ),
    ),
);

export const useVisibleConfigAgents = (): Agent[] => {
    const agents = useConfigStore((state) => state.agents);
    return useMemo(() => filterVisibleAgentSelectorOptions(agents), [agents]);
};

if (typeof window !== "undefined") {
    window.__zustand_config_store__ = useConfigStore;
}

let unsubscribeConfigStoreChanges: (() => void) | null = null;

if (!unsubscribeConfigStoreChanges) {
    unsubscribeConfigStoreChanges = subscribeToConfigChanges(async (event) => {
        const tasks: Promise<void>[] = [];

        if (scopeMatches(event, "agents")) {
            const { loadAgents } = useConfigStore.getState();
            tasks.push(loadAgents().then(() => {}));
        }

        if (scopeMatches(event, "providers")) {
            const { loadProviders } = useConfigStore.getState();
            tasks.push(loadProviders());
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    });
}

let unsubscribeConfigStoreDirectoryChanges: (() => void) | null = null;

if (typeof window !== "undefined" && !unsubscribeConfigStoreDirectoryChanges) {
    unsubscribeConfigStoreDirectoryChanges = useDirectoryStore.subscribe((state, prevState) => {
        const nextKey = toDirectoryKey(state.currentDirectory);
        const prevKey = toDirectoryKey(prevState.currentDirectory);
        if (nextKey === prevKey) {
            return;
        }

        void useConfigStore.getState().activateDirectory(state.currentDirectory);
    });
}
