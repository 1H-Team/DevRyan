import { beforeEach, describe, expect, test } from "bun:test"
import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useSelectionStore } from "@/sync/selection-store"
import { mergeRuntimeAgentsWithConfigOverrides, useConfigStore } from "./useConfigStore"

type TestProvider = Omit<Provider, "models"> & { models: Model[] }

const createModel = (providerID: string, id: string, variants?: Model["variants"]): Model => ({
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

const providers: TestProvider[] = [
  {
    id: "opencode",
    name: "OpenCode",
    source: "custom",
    options: {},
    env: [],
    models: [
      createModel("opencode", "small"),
      createModel("opencode", "builder-model", { high: {} }),
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    source: "custom",
    options: {},
    env: [],
    models: [createModel("anthropic", "claude")],
  },
]

const agents: Agent[] = [
  {
    name: "Orchestrator",
    mode: "primary",
    model: { providerID: "opencode", modelID: "small" },
    permission: [],
    options: {},
  },
  {
    name: "Builder",
    mode: "primary",
    model: { providerID: "opencode", modelID: "builder-model" },
    variant: "high",
    permission: [],
    options: {},
  },
]

describe("useConfigStore default agent selection", () => {
  beforeEach(() => {
    useSessionUIStore.setState({ currentSessionId: null, currentDraftId: null })
    useSelectionStore.setState((state) => ({
      ...state,
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionPlanModeSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      draftModelSelections: new Map(),
      draftAgentSelections: new Map(),
      draftAgentModelSelections: new Map(),
      draftAgentModelVariantSelections: new Map(),
      lastUsedProvider: null,
    }))
    useConfigStore.setState({
      activeDirectoryKey: "__global__",
      providers,
      agents,
      settingsDefaultAgent: "Builder",
      currentAgentName: "Orchestrator",
      currentProviderId: "anthropic",
      currentModelId: "claude",
      currentVariant: undefined,
      selectedProviderId: "anthropic",
      directoryScoped: {},
    })
  })

  test("applies the configured default agent with its model and variant to the draft selection", () => {
    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })

  test("preserves Ultra from an advertised agent default", () => {
    useConfigStore.setState({
      providers: [{
        id: "openai",
        name: "OpenAI",
        source: "custom",
        options: {},
        env: [],
        models: [createModel("openai", "gpt-5.6", { xhigh: {}, ultra: {} })],
      }],
      agents: [{
        name: "Builder",
        mode: "primary",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        variant: "ultra",
        permission: [],
        options: {},
      }],
      settingsDefaultAgent: "Builder",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentProviderId).toBe("openai")
    expect(useConfigStore.getState().currentModelId).toBe("gpt-5.6")
    expect(useConfigStore.getState().currentVariant).toBe("ultra")
  })

  test("keeps a rehydrated draft model and variant when startup reapplies the default agent", () => {
    useConfigStore.setState({
      providers: [
        ...providers,
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          options: {},
          env: [],
          models: [createModel("openai", "gpt-5.6-sol", { max: {}, ultra: {} })],
        },
      ],
      currentProviderId: "openai",
      currentModelId: "gpt-5.6-sol",
      currentVariant: "ultra",
      currentAgentName: "Builder",
      settingsDefaultAgent: "Builder",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("openai")
    expect(useConfigStore.getState().currentModelId).toBe("gpt-5.6-sol")
    expect(useConfigStore.getState().currentVariant).toBe("ultra")
  })

  test("keeps a rehydrated draft variant when startup already created an empty draft placeholder", () => {
    useSessionUIStore.setState({ currentSessionId: null, currentDraftId: "draft-placeholder" })
    useConfigStore.setState({
      providers: [
        ...providers,
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          options: {},
          env: [],
          models: [createModel("openai", "gpt-5.6-sol", { max: {}, ultra: {} })],
        },
      ],
      currentProviderId: "openai",
      currentModelId: "gpt-5.6-sol",
      currentVariant: "ultra",
      currentAgentName: "Builder",
      settingsDefaultAgent: "Builder",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("openai")
    expect(useConfigStore.getState().currentModelId).toBe("gpt-5.6-sol")
    expect(useConfigStore.getState().currentVariant).toBe("ultra")
  })

  test("applies the default model and variant when a fresh draft disables rehydration preservation", () => {
    useSessionUIStore.setState({ currentSessionId: null, currentDraftId: "draft-fresh" })
    useConfigStore.setState({
      providers: [
        ...providers,
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          options: {},
          env: [],
          models: [createModel("openai", "gpt-5.6-sol", { max: {}, ultra: {} })],
        },
      ],
      currentProviderId: "openai",
      currentModelId: "gpt-5.6-sol",
      currentVariant: "ultra",
      currentAgentName: "Builder",
      settingsDefaultAgent: "Builder",
    })

    useConfigStore.getState().applyDefaultsToCurrent({ preserveRehydratedDraftModel: false })

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })

  test("updates an empty draft immediately when the configured default agent changes", () => {
    useConfigStore.getState().setSettingsDefaultAgent("Builder")

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })

  test("applies an agent configured model when switching without preservation", () => {
    useConfigStore.getState().setAgent("Builder")

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })

  test("can switch draft agents without replacing a manually selected model", () => {
    useConfigStore.getState().setAgent("Builder", { preserveCurrentModel: true })

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("anthropic")
    expect(useConfigStore.getState().currentModelId).toBe("claude")
    expect(useConfigStore.getState().currentVariant).toBe(undefined)
  })

  test("updates provider, model, and variant atomically", () => {
    const observed: Array<{ providerId: string; modelId: string; variant?: string }> = []
    const unsubscribe = useConfigStore.subscribe((state) => {
      observed.push({
        providerId: state.currentProviderId,
        modelId: state.currentModelId,
        variant: state.currentVariant,
      })
    })

    try {
      useConfigStore.getState().setProviderModel("opencode", "builder-model", "high")
    } finally {
      unsubscribe()
    }

    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
    expect(observed).toEqual([
      { providerId: "opencode", modelId: "builder-model", variant: "high" },
    ])
  })

  test("clears stale variants when activating a directory with no snapshot", async () => {
    useConfigStore.setState({
      isConnected: false,
      activeDirectoryKey: "__global__",
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentVariant: "medium",
      directoryScoped: {},
    })

    await useConfigStore.getState().activateDirectory("/tmp/other-project")

    expect(useConfigStore.getState().currentProviderId).toBe("")
    expect(useConfigStore.getState().currentModelId).toBe("")
    expect(useConfigStore.getState().currentVariant).toBe(undefined)
  })

  test("keeps the current variant in directory snapshots when only selected provider changes", () => {
    useConfigStore.setState({
      activeDirectoryKey: "__global__",
      currentProviderId: "opencode",
      currentModelId: "builder-model",
      currentVariant: "high",
      selectedProviderId: "opencode",
      directoryScoped: {},
    })

    useConfigStore.getState().setSelectedProvider("anthropic")

    expect(useConfigStore.getState().directoryScoped.__global__?.currentVariant).toBe("high")
  })

  test("restores Ultra from a directory snapshot and clears it when switching models", async () => {
    const openaiProvider: TestProvider = {
      id: "openai",
      name: "OpenAI",
      source: "custom",
      options: {},
      env: [],
      models: [
        createModel("openai", "gpt-5.6", { xhigh: {}, ultra: {} }),
        createModel("openai", "gpt-5.6-no-ultra", { xhigh: {} }),
      ],
    }
    useConfigStore.setState({ providers: [openaiProvider], isConnected: false })

    useConfigStore.getState().setProviderModel("openai", "gpt-5.6", "ultra")
    await useConfigStore.getState().activateDirectory("/tmp/other-project")
    await useConfigStore.getState().activateDirectory(null)

    expect(useConfigStore.getState().currentVariant).toBe("ultra")

    useConfigStore.getState().setProviderModel("openai", "gpt-5.6-no-ultra")
    expect(useConfigStore.getState().currentVariant).toBe(undefined)
  })

  test("cycles through concrete thinking variants without wrapping to default", () => {
    useConfigStore.setState({
      currentProviderId: "opencode",
      currentModelId: "builder-model",
      currentVariant: undefined,
      providers: [{
        id: "opencode",
        name: "OpenCode",
        source: "custom",
        options: {},
        env: [],
        models: [
          createModel("opencode", "builder-model", {
            low: {},
            medium: {},
            high: {},
            xhigh: {},
            ultra: {},
          }),
        ],
      }],
    })

    useConfigStore.getState().cycleCurrentVariant()
    expect(useConfigStore.getState().currentVariant).toBe("medium")

    useConfigStore.getState().cycleCurrentVariant()
    expect(useConfigStore.getState().currentVariant).toBe("high")

    useConfigStore.getState().cycleCurrentVariant()
    expect(useConfigStore.getState().currentVariant).toBe("xhigh")

    useConfigStore.getState().cycleCurrentVariant()
    expect(useConfigStore.getState().currentVariant).toBe("ultra")

    useConfigStore.getState().cycleCurrentVariant()
    expect(useConfigStore.getState().currentVariant).toBe("low")
  })

  test("leaves an active session selection unchanged when the configured default agent changes", () => {
    useSessionUIStore.setState({ currentSessionId: "session-1" })

    useConfigStore.getState().setSettingsDefaultAgent("Builder")

    expect(useConfigStore.getState().currentAgentName).toBe("Orchestrator")
    expect(useConfigStore.getState().currentProviderId).toBe("anthropic")
    expect(useConfigStore.getState().currentModelId).toBe("claude")
    expect(useConfigStore.getState().currentVariant).toBe(undefined)
  })

  test("applyDefaultsToCurrent does not overwrite saved session agent selection", () => {
    useSessionUIStore.setState({ currentSessionId: "session-1" })
    useSelectionStore.getState().saveSessionAgentSelection("session-1", "Builder")
    useConfigStore.setState({
      settingsDefaultAgent: "Orchestrator",
      currentAgentName: "Builder",
      currentProviderId: "opencode",
      currentModelId: "builder-model",
      currentVariant: "high",
      selectedProviderId: "opencode",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Orchestrator")
    expect(useSelectionStore.getState().getSessionAgentSelection("session-1")).toBe("Builder")
  })

  test("applyDefaultsToCurrent preserves explicit draft model intent", () => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-explicit",
      draftsById: {
        "draft-explicit": {
          id: "draft-explicit",
          text: "",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: null,
          parentID: null,
          sendConfig: {
            providerID: "anthropic",
            modelID: "claude",
            agent: "Orchestrator",
            modelProvenance: "explicit",
          },
        },
      },
      draftOrder: ["draft-explicit"],
      newSessionDraft: {
        open: true,
        id: "draft-explicit",
        directoryOverride: null,
        parentID: null,
        sendConfig: {
          providerID: "anthropic",
          modelID: "claude",
          agent: "Orchestrator",
          modelProvenance: "explicit",
        },
      },
    })
    useConfigStore.setState({
      settingsDefaultAgent: "Builder",
      currentAgentName: "Orchestrator",
      currentProviderId: "anthropic",
      currentModelId: "claude",
      currentVariant: undefined,
      selectedProviderId: "anthropic",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("anthropic")
    expect(useConfigStore.getState().currentModelId).toBe("claude")
  })

  test("applyDefaultsToCurrent preserves legacy draft model without provenance", () => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-legacy",
      draftsById: {
        "draft-legacy": {
          id: "draft-legacy",
          text: "",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: null,
          parentID: null,
          sendConfig: {
            providerID: "anthropic",
            modelID: "claude",
            agent: "Orchestrator",
          },
        },
      },
      draftOrder: ["draft-legacy"],
      newSessionDraft: {
        open: true,
        id: "draft-legacy",
        directoryOverride: null,
        parentID: null,
        sendConfig: {
          providerID: "anthropic",
          modelID: "claude",
          agent: "Orchestrator",
        },
      },
    })
    useConfigStore.setState({
      settingsDefaultAgent: "Builder",
      currentAgentName: "Orchestrator",
      currentProviderId: "anthropic",
      currentModelId: "claude",
      currentVariant: undefined,
      selectedProviderId: "anthropic",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentProviderId).toBe("anthropic")
    expect(useConfigStore.getState().currentModelId).toBe("claude")
  })

  test("applyDefaultsToCurrent does not preserve agent-default draft model", () => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-agent-default",
      draftsById: {
        "draft-agent-default": {
          id: "draft-agent-default",
          text: "",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: null,
          parentID: null,
          sendConfig: {
            providerID: "anthropic",
            modelID: "claude",
            agent: "Builder",
            variant: "high",
            modelProvenance: "agent-default",
          },
        },
      },
      draftOrder: ["draft-agent-default"],
      newSessionDraft: {
        open: true,
        id: "draft-agent-default",
        directoryOverride: null,
        parentID: null,
        sendConfig: {
          providerID: "anthropic",
          modelID: "claude",
          agent: "Builder",
          variant: "high",
          modelProvenance: "agent-default",
        },
      },
    })
    useConfigStore.setState({
      settingsDefaultAgent: "Builder",
      currentAgentName: "Builder",
      currentProviderId: "anthropic",
      currentModelId: "claude",
      currentVariant: "high",
      selectedProviderId: "anthropic",
    })

    useConfigStore.getState().applyDefaultsToCurrent()

    expect(useConfigStore.getState().currentAgentName).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })

  test("setAgent records explicit active-session selection and applies the agent model", () => {
    useSessionUIStore.setState({ currentSessionId: "session-1" })

    useConfigStore.getState().setAgent("Builder")

    expect(useSelectionStore.getState().getSessionAgentSelection("session-1")).toBe("Builder")
    expect(useConfigStore.getState().currentProviderId).toBe("opencode")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("high")
  })
})

describe("mergeRuntimeAgentsWithConfigOverrides", () => {
  test("applies config-backed model and variant overrides to runtime agents", () => {
    const runtimeAgents = [{
      name: "Builder",
      mode: "primary",
      model: { providerID: "opencode", modelID: "small" },
      variant: "low",
      permission: [],
      options: {},
    }] as Agent[]
    const configAgents = [{
      name: "Builder",
      mode: "primary",
      model: { providerID: "opencode", modelID: "builder-model" },
      variant: "high",
      modelRefs: ["opencode/builder-model", "anthropic/claude"],
      councillors: [{ model: "anthropic/claude", variant: "medium" }],
      permission: [],
      options: {},
    }] as unknown as Agent[]

    const merged = mergeRuntimeAgentsWithConfigOverrides(runtimeAgents, configAgents)

    expect(merged[0].model).toEqual({ providerID: "opencode", modelID: "builder-model" })
    expect((merged[0] as Agent & { variant?: string }).variant).toBe("high")
    expect((merged[0] as Agent & { modelRefs?: string[] }).modelRefs).toEqual([
      "opencode/builder-model",
      "anthropic/claude",
    ])
    expect((merged[0] as Agent & { councillors?: unknown[] }).councillors).toEqual([
      { model: "anthropic/claude", variant: "medium" },
    ])
  })

  test("keeps metadata-only config agents out of the executable runtime list", () => {
    const runtimeAgents = [{
      name: "Builder",
      mode: "primary",
      model: { providerID: "opencode", modelID: "small" },
      permission: [],
      options: {},
    }] as Agent[]
    const configAgents = [{
      name: "Orchestrator",
      mode: "primary",
      model: { providerID: "anthropic", modelID: "claude" },
      permission: [],
      options: {},
    }] as Agent[]

    const merged = mergeRuntimeAgentsWithConfigOverrides(runtimeAgents, configAgents)

    expect(merged.map((agent) => agent.name)).toEqual(["Builder"])
  })

  test("keeps synced packaged agents selectable when they are present in runtime", () => {
    const runtimeAgents = [
      {
        name: "builder",
        mode: "primary",
        model: { providerID: "opencode", modelID: "small" },
        permission: [],
        options: {},
      },
      {
        name: "orchestrator",
        mode: "primary",
        model: { providerID: "opencode", modelID: "small" },
        permission: [],
        options: {},
      },
    ] as Agent[]
    const configAgents = [{
      name: "orchestrator",
      mode: "primary",
      model: { providerID: "anthropic", modelID: "claude" },
      variant: "high",
      permission: [],
      options: {},
    }] as Agent[]

    const merged = mergeRuntimeAgentsWithConfigOverrides(runtimeAgents, configAgents)

    expect(merged.map((agent) => agent.name)).toEqual(["builder", "orchestrator"])
    expect(merged[1].model).toEqual({ providerID: "anthropic", modelID: "claude" })
    expect((merged[1] as Agent & { variant?: string }).variant).toBe("high")
  })

  test("keeps runtime execution metadata when applying config-backed model overrides", () => {
    const runtimeAgents = [{
      name: "explorer",
      mode: "subagent",
      model: { providerID: "opencode", modelID: "small" },
      permission: [{ id: "bash", action: "allow" }],
      options: { hidden: true },
    }] as unknown as Agent[]
    const configAgents = [{
      name: "explorer",
      mode: "primary",
      model: { providerID: "anthropic", modelID: "claude" },
      variant: null,
      permission: [],
      options: {},
    }] as unknown as Agent[]

    const merged = mergeRuntimeAgentsWithConfigOverrides(runtimeAgents, configAgents)
    const explorer = merged[0] as Agent & { variant?: string; options?: { hidden?: boolean } }

    expect(explorer.model).toEqual({ providerID: "anthropic", modelID: "claude" })
    expect(explorer.variant).toBe(undefined)
    expect(explorer.mode).toBe("subagent")
    expect(explorer.permission).toEqual([{ id: "bash", action: "allow" }])
    expect(explorer.options?.hidden).toBe(true)
  })
})
