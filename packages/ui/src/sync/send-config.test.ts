import { beforeEach, describe, expect, test } from "bun:test"
import type { Model, Provider } from "@opencode-ai/sdk/v2"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSelectionStore } from "./selection-store"
import {
  resolveCurrentSendConfig,
  resolveDraftSendSelection,
  resolveSessionSendConfig,
  resolveSessionSendConfigSnapshot,
  type SendConfigResolverSnapshot,
} from "./send-config"

const snapshot = (overrides: Partial<SendConfigResolverSnapshot> = {}): SendConfigResolverSnapshot => ({
  currentAgentName: "builder",
  currentProviderId: "openai",
  currentModelId: "gpt-5.5",
  currentVariant: "medium",
  settingsDefaultAgent: "builder",
  lastUsedProvider: null,
  agents: [
    {
      name: "builder",
      mode: "primary",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      variant: "high",
    },
    {
      name: "reviewer",
      mode: "primary",
      model: { providerID: "openai", modelID: "gpt-5.2" },
      variant: "low",
    },
  ],
  providers: [
    {
      id: "openai",
      models: [
        { id: "gpt-5.5", variants: { medium: {}, high: {} } },
        { id: "gpt-5.2", variants: { low: {}, medium: {} } },
      ],
    },
    {
      id: "anthropic",
      models: [{ id: "claude-sonnet-4-5", variants: { high: {}, medium: {} } }],
    },
  ],
  sessionAgentSelection: null,
  contextSessionAgentSelection: null,
  contextCurrentAgent: undefined,
  sessionModelSelection: null,
  contextSessionModelSelection: null,
  sessionAgentModelSelection: null,
  contextSessionAgentModelSelection: null,
  sessionAgentModelVariant: undefined,
  contextSessionAgentModelVariant: undefined,
  planMode: false,
  ...overrides,
})

type TestProvider = Omit<Provider, "models"> & { models: Model[] }

const createStoreModel = (providerID: string, id: string, variants?: Model["variants"]): Model => ({
  id,
  providerID,
  api: { id: providerID, url: "https://example.test", npm: providerID },
  name: id,
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants,
})

describe("send config resolution", () => {
  test("falls back from a stale session model that is absent from the provider catalog", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      sessionModelSelection: { providerId: "codex", modelId: "gpt-5.4" },
    }))

    expect(result).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: "medium",
      planMode: false,
    })
  })

  test("does not route a send through an explicitly unavailable model", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      currentProviderId: "openai",
      currentModelId: "gpt-5.6-luna",
      currentVariant: "high",
      providers: [{
        id: "openai",
        models: [
          { id: "gpt-5.6-luna", available: false },
          { id: "gpt-5.6", variants: { medium: {}, high: {} } },
        ],
      }],
    }))

    expect(result.providerID).toBe(undefined)
    expect(result.modelID).toBe(undefined)
    expect(result.variant).toBe(undefined)
  })
  beforeEach(() => {
    useConfigStore.setState({
      currentAgentName: undefined,
      currentProviderId: "",
      currentModelId: "",
      currentVariant: undefined,
      agents: [],
      providers: [],
    })
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionPlanModeSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      draftModelSelections: new Map(),
      draftAgentSelections: new Map(),
      draftAgentModelSelections: new Map(),
      draftAgentModelVariantSelections: new Map(),
      lastUsedProvider: null,
      defaultPlanModeSelection: false,
      draftPlanModeSelection: false,
    })
    useSelectionStore.getState().setPlanModeSelection(null, false)
  })

  test("uses the default agent model for a new draft when no explicit agent or valid input model is selected", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: undefined,
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "missing-provider",
      inputModelID: "missing-model",
      inputVariant: undefined,
      currentProviderID: "missing-current-provider",
      currentModelID: "missing-current-model",
      currentVariant: undefined,
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "high",
    })
  })

  test("uses the selected agent model before the retained current model", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "missing-provider",
      inputModelID: "missing-model",
      inputVariant: undefined,
      currentProviderID: "openai",
      currentModelID: "gpt-5.5",
      currentVariant: "high",
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "high",
    })
  })

  test("preserves an explicit draft model selection instead of applying the default agent model", () => {
    const input = {
      requestedAgent: undefined,
      currentAgent: undefined,
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "openai",
      inputModelID: "gpt-5.2",
      inputVariant: "low",
      currentProviderID: "anthropic",
      currentModelID: "claude-sonnet-4-5",
      currentVariant: "high",
      draftAgentSelection: "reviewer",
      draftModelSelection: { providerId: "openai", modelId: "gpt-5.2" },
      draftAgentModelSelection: { providerId: "openai", modelId: "gpt-5.2" },
      draftAgentModelVariant: "low",
    }

    const result = resolveDraftSendSelection(input)

    expect(result).toEqual({
      agent: "reviewer",
      providerID: "openai",
      modelID: "gpt-5.2",
      variant: "low",
    })
  })

  test("uses persisted draft send config before legacy draft and live defaults", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "openai",
      inputModelID: "gpt-5.5",
      inputVariant: "medium",
      currentProviderID: "anthropic",
      currentModelID: "claude-sonnet-4-5",
      currentVariant: "high",
      draftAgentSelection: "builder",
      draftModelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      draftAgentModelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      draftAgentModelVariant: "high",
      draftSendConfig: {
        providerID: "openai",
        modelID: "gpt-5.2",
        agent: "reviewer",
        variant: "low",
        planMode: true,
      },
    })

    expect(result).toEqual({
      agent: "reviewer",
      providerID: "openai",
      modelID: "gpt-5.2",
      variant: "low",
    })
  })

  test("new draft ignores stale global thinking and uses the selected agent default variant", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "anthropic",
      inputModelID: "claude-sonnet-4-5",
      inputVariant: "medium",
      currentProviderID: "anthropic",
      currentModelID: "claude-sonnet-4-5",
      currentVariant: "medium",
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "high",
    })
  })

  test("new draft uses the model thinking fallback when the selected agent has no matching default variant", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: [{
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      }],
      providers: snapshot().providers,
      inputProviderID: "anthropic",
      inputModelID: "claude-sonnet-4-5",
      inputVariant: "medium",
      currentProviderID: "anthropic",
      currentModelID: "claude-sonnet-4-5",
      currentVariant: "medium",
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "medium",
    })
  })

  test("new draft keeps an explicit draft thinking selection", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: snapshot().agents,
      providers: snapshot().providers,
      inputProviderID: "anthropic",
      inputModelID: "claude-sonnet-4-5",
      inputVariant: "medium",
      currentProviderID: "anthropic",
      currentModelID: "claude-sonnet-4-5",
      currentVariant: "medium",
      draftAgentSelection: "builder",
      draftAgentModelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      draftAgentModelVariant: "medium",
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "medium",
    })
  })

  test("preserves captured queue config over live session selections", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      sessionAgentSelection: "builder",
      sessionAgentModelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      sessionAgentModelVariant: "high",
    }), {
      providerID: "openai",
      modelID: "gpt-5.2",
      agent: "reviewer",
      variant: "low",
      planMode: true,
    })

    expect(result).toEqual({
      providerID: "openai",
      modelID: "gpt-5.2",
      agent: "reviewer",
      variant: "low",
      planMode: true,
    })
  })

  test("uses session agent model and thinking for continuation when no captured config is provided", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      sessionAgentSelection: "builder",
      sessionModelSelection: { providerId: "openai", modelId: "gpt-5.5" },
      sessionAgentModelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      sessionAgentModelVariant: "high",
      planMode: true,
    }))

    expect(result).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      agent: "builder",
      variant: "high",
      planMode: true,
    })
  })

  test("resolves current draft send config when no session is active", () => {
    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentAgentName: "builder",
      currentVariant: "medium",
      providers: [{
        id: "openai",
        name: "OpenAI",
        source: "custom",
        options: {},
        env: [],
        models: [
          createStoreModel("openai", "gpt-5.5", { medium: {}, high: {} }),
        ],
      }],
    })
    useSelectionStore.getState().setPlanModeSelection(null, true)

    expect(resolveCurrentSendConfig(null)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: "medium",
      planMode: true,
    })
  })

  test("preserves advertised OpenAI Ultra as the exact current send variant", () => {
    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.6",
      currentAgentName: "builder",
      currentVariant: "ultra",
      providers: [{
        id: "openai",
        name: "OpenAI",
        source: "custom",
        options: {},
        env: [],
        models: [
          createStoreModel("openai", "gpt-5.6", { xhigh: {}, ultra: {} }),
        ],
      }],
    })

    expect(resolveCurrentSendConfig(null)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
      agent: "builder",
      variant: "ultra",
      planMode: false,
    })
  })

  test("preserves captured Ultra queue config over later live selections", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      providers: [{
        id: "openai",
        models: [{ id: "gpt-5.6", variants: { xhigh: {}, ultra: {} } }],
      }],
      currentVariant: "xhigh",
      sessionAgentModelVariant: "xhigh",
    }), {
      providerID: "openai",
      modelID: "gpt-5.6",
      agent: "builder",
      variant: "ultra",
      planMode: false,
    })

    expect(result.variant).toBe("ultra")
  })

  test("drops stale current variants when provider metadata is unavailable", () => {
    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentAgentName: "builder",
      currentVariant: "medium",
      providers: [],
    })

    expect(resolveCurrentSendConfig(null)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: undefined,
      planMode: false,
    })
  })

  test("drops stale session variants when provider metadata is unavailable", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentVariant: "medium",
      providers: [],
      agents: [{ name: "builder", mode: "primary" }],
    }))

    expect(result).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: undefined,
      planMode: false,
    })
  })

  test("drops unadvertised OpenAI fast mode for current draft sends", () => {
    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentAgentName: "builder",
      currentVariant: "fast",
      providers: [{
        id: "openai",
        name: "OpenAI",
        source: "custom",
        options: {},
        env: [],
        models: [
          createStoreModel("openai", "gpt-5.5"),
        ],
      }],
    })

    expect(resolveCurrentSendConfig(null)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: undefined,
      planMode: false,
    })
  })

  test("drops persisted draft fast send config for unadvertised OpenAI fast models", () => {
    const result = resolveDraftSendSelection({
      requestedAgent: undefined,
      currentAgent: "builder",
      settingsDefaultAgent: "builder",
      agents: [{ name: "builder", mode: "primary" }],
      providers: [{
        id: "openai",
        models: [{ id: "gpt-5.5" }],
      }],
      inputProviderID: "openai",
      inputModelID: "gpt-5.5",
      inputVariant: "fast",
      currentProviderID: "openai",
      currentModelID: "gpt-5.5",
      currentVariant: "fast",
      draftSendConfig: {
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "builder",
        variant: "fast",
      },
    })

    expect(result).toEqual({
      agent: "builder",
      providerID: "openai",
      modelID: "gpt-5.5",
      variant: undefined,
    })
  })

  test("drops session fast selections for unadvertised OpenAI fast models", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentVariant: "fast",
      providers: [{
        id: "openai",
        models: [{ id: "gpt-5.5" }],
      }],
      agents: [{ name: "builder", mode: "primary" }],
      sessionAgentSelection: "builder",
      sessionAgentModelSelection: { providerId: "openai", modelId: "gpt-5.5" },
      sessionAgentModelVariant: "fast",
    }))

    expect(result).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: undefined,
      planMode: false,
    })
  })

  test("drops unsupported fast selections before send", () => {
    const result = resolveSessionSendConfigSnapshot(snapshot({
      currentProviderId: "anthropic",
      currentModelId: "claude-sonnet-4-5",
      currentVariant: "fast",
      providers: [{
        id: "anthropic",
        models: [{ id: "claude-sonnet-4-5" }],
      }],
      agents: [{ name: "builder", mode: "primary" }],
    }))

    expect(result).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      agent: "builder",
      variant: undefined,
      planMode: false,
    })
  })

  test("resolves an unset current thinking value to a concrete model fallback before send", () => {
    const providers: TestProvider[] = [{
      id: "openai",
      name: "OpenAI",
      source: "custom",
      options: {},
      env: [],
      models: [
        createStoreModel("openai", "gpt-5.5", { high: {}, medium: {} }),
      ],
    }]

    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentAgentName: "builder",
      currentVariant: undefined,
      providers,
    })

    expect(resolveCurrentSendConfig(null)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      agent: "builder",
      variant: "medium",
      planMode: false,
    })
  })

  test("resolves live session config through the same snapshot ordering", () => {
    useConfigStore.setState({
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentAgentName: "reviewer",
      currentVariant: "medium",
      agents: [],
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          options: {},
          env: [],
          models: [
            createStoreModel("openai", "gpt-5.5", { medium: {}, high: {} }),
            createStoreModel("openai", "gpt-5.2", { low: {}, medium: {} }),
          ],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          source: "custom",
          options: {},
          env: [],
          models: [
            createStoreModel("anthropic", "claude-sonnet-4-5", { high: {}, medium: {} }),
          ],
        },
      ],
    })
    const selection = useSelectionStore.getState()
    selection.saveSessionAgentSelection("session-live", "builder")
    selection.saveSessionModelSelection("session-live", "openai", "gpt-5.2")
    selection.saveAgentModelForSession("session-live", "builder", "anthropic", "claude-sonnet-4-5")
    selection.saveAgentModelVariantForSession("session-live", "builder", "anthropic", "claude-sonnet-4-5", "high")
    selection.setPlanModeSelection("session-live", true)

    expect(resolveSessionSendConfig("session-live")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      agent: "builder",
      variant: "high",
      planMode: true,
    })
  })
})
