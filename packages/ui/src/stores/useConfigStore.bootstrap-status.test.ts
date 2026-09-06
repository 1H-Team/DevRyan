import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Model } from "@opencode-ai/sdk/v2"

let getProvidersImpl: (options?: { directory?: string | null }) => Promise<unknown>
let listAgentsStrictImpl: () => Promise<unknown>
let providerCallOptions: Array<{ directory?: string | null } | undefined>
let settingsDefaultAgent: string | undefined

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    setDirectory: () => {},
    getDirectory: () => "/repo",
    withDirectory: (_directory: string | undefined | null, fn: () => Promise<unknown>) => fn(),
    getProviders: (options?: { directory?: string | null }) => {
      providerCallOptions.push(options)
      return getProvidersImpl(options)
    },
    listAgentsStrict: () => listAgentsStrictImpl(),
    checkHealth: () => Promise.resolve(true),
  },
}))

const { useConfigStore } = await import("./useConfigStore")
const { useDirectoryStore } = await import("./useDirectoryStore")
const { useSessionUIStore } = await import("@/sync/session-ui-store")
const { useSelectionStore } = await import("@/sync/selection-store")
const { resolveCurrentDraftSendConfig } = await import("@/sync/send-config")

const selectionModel = (id: string): Model => ({
  id, providerID: "fixture", name: id,
  api: { id, url: "https://fixture.invalid", npm: "fixture" },
  capabilities: {
    temperature: true, reasoning: true, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 }, status: "active",
  options: {}, headers: {}, release_date: "2026-01-01", variants: { low: {}, high: {} },
})

const prepareDraftSelection = (id: string, agent: string, model: string, variant: string | null) => {
  const sendConfig = { providerID: "fixture", modelID: model, agent, variant, modelProvenance: "explicit" as const }
  const draft = { id, text: "", createdAt: 1, updatedAt: 1, selectedProjectId: null,
    directoryOverride: null, parentID: null, sendConfig }
  useSessionUIStore.setState(state => ({
    currentSessionId: null, currentDraftId: id,
    draftsById: { ...state.draftsById, [id]: draft },
    newSessionDraft: { open: true, id, directoryOverride: null, parentID: null, sendConfig },
  }))
  useSelectionStore.getState().saveDraftAgentSelection(id, agent)
  useConfigStore.getState().setAgent(agent, { recordSessionSelection: false })
  useConfigStore.getState().setProviderModel("fixture", model, variant)
}

const prepareSelectionCatalog = () => {
  settingsDefaultAgent = "orchestrator"
  useConfigStore.setState({
    providers: [{ id: "fixture", name: "Fixture", source: "custom", options: {}, env: [],
      models: [selectionModel("builder-model"), selectionModel("orchestrator-model")] }],
    agents: [
      { name: "builder", mode: "primary", model: { providerID: "fixture", modelID: "builder-model" }, permission: [], options: {} },
      { name: "orchestrator", mode: "primary", model: { providerID: "fixture", modelID: "orchestrator-model" }, permission: [], options: {} },
    ],
  })
}

describe("useConfigStore startup load status", () => {
  beforeEach(() => {
    console.error = mock(() => {}) as unknown as typeof console.error
    providerCallOptions = []
    settingsDefaultAgent = undefined
    getProvidersImpl = () => Promise.resolve({ providers: [], default: {} })
    listAgentsStrictImpl = () => Promise.resolve([])
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("/api/config/agents")) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [] }), { status: 200 }))
      }
      if (url === "/api/config/settings") {
        return Promise.resolve(new Response(JSON.stringify({
          responseStyleEnabled: false,
          responseStylePreset: "concise",
          responseStyleCustomInstructions: "",
          defaultAgent: settingsDefaultAgent,
        }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    }) as unknown as typeof fetch

    useConfigStore.setState({
      activeDirectoryKey: "__global__",
      directoryScoped: {},
      providers: [],
      agents: [],
      providersLoadStatus: "idle",
      providersLoadError: undefined,
      agentsLoadStatus: "idle",
      agentsLoadError: undefined,
      responseStyleInstructionLoaded: false,
      isConnected: true,
      isInitialized: false,
      initializationLoadStatus: "idle",
      initializationLoadError: undefined,
      currentAgentName: undefined,
      currentProviderId: "",
      currentModelId: "",
      currentVariant: undefined,
    })
    useSessionUIStore.setState({ currentSessionId: null, currentDraftId: null, draftsById: {},
      newSessionDraft: { open: false, directoryOverride: null, parentID: null } })
    useSelectionStore.setState({ draftAgentSelections: new Map(), draftModelSelections: new Map(),
      draftAgentModelSelections: new Map(), draftAgentModelVariantSelections: new Map() })
    useDirectoryStore.setState({
      currentDirectory: "/repo",
      directoryHistory: ["/repo"],
      historyIndex: 0,
      homeDirectory: "/default-workspace",
      hasPersistedDirectory: true,
      isHomeReady: true,
      isSwitchingDirectory: false,
    })
  })

  test("provider transient failures set error state and retry can recover to a valid empty list", async () => {
    getProvidersImpl = () => Promise.reject(new Error("provider 503"))

    await useConfigStore.getState().loadProviders()

    expect(useConfigStore.getState().providersLoadStatus).toBe("error")
    expect(useConfigStore.getState().providersLoadError).toContain("provider 503")

    getProvidersImpl = () => Promise.resolve({ providers: [], default: {} })

    await useConfigStore.getState().loadProviders()

    expect(useConfigStore.getState().providersLoadStatus).toBe("ready")
    expect(useConfigStore.getState().providersLoadError).toBe(undefined)
    expect(useConfigStore.getState().providers).toEqual([])
  })

  test("agent transient failures set error state and retry can recover to a valid empty list", async () => {
    listAgentsStrictImpl = () => Promise.reject(new Error("agent 503"))

    const failed = await useConfigStore.getState().loadAgents()

    expect(failed).toBe(false)
    expect(useConfigStore.getState().agentsLoadStatus).toBe("error")
    expect(useConfigStore.getState().agentsLoadError).toContain("agent 503")

    listAgentsStrictImpl = () => Promise.resolve([])

    const recovered = await useConfigStore.getState().loadAgents()

    expect(recovered).toBe(true)
    expect(useConfigStore.getState().agentsLoadStatus).toBe("ready")
    expect(useConfigStore.getState().agentsLoadError).toBe(undefined)
    expect(useConfigStore.getState().agents).toEqual([])
    expect(useConfigStore.getState().responseStyleInstructionLoaded).toBe(true)
  })

  test("a late agent catalog keeps draft controls aligned with the actual Default send selection", async () => {
    prepareSelectionCatalog()
    const catalog = useConfigStore.getState().agents
    let finishLoad!: (value: unknown) => void
    listAgentsStrictImpl = () => new Promise(resolve => { finishLoad = resolve })
    const loading = useConfigStore.getState().loadAgents()

    prepareDraftSelection("picked-during-load", "builder", "builder-model", null)
    finishLoad(catalog)
    expect(await loading).toBe(true)

    const state = useConfigStore.getState()
    const draft = useSessionUIStore.getState().draftsById["picked-during-load"]
    const send = resolveCurrentDraftSendConfig(draft.id, draft.sendConfig)
    expect(state.settingsDefaultAgent).toBe("orchestrator")
    expect(state.currentAgentName).toBe(send.agent)
    expect(state.currentAgentName).toBe("builder")
    expect(state.currentModelId).toBe(send.modelID)
    expect(state.currentModelId).toBe("builder-model")
    expect(state.currentVariant).toBe(send.variant)
    expect(state.currentVariant).toBe(null)
  })

  test("agent catalog completion restores the draft selected during the request", async () => {
    prepareSelectionCatalog()
    const catalog = useConfigStore.getState().agents
    prepareDraftSelection("previous-draft", "orchestrator", "orchestrator-model", "high")
    let finishLoad!: (value: unknown) => void
    listAgentsStrictImpl = () => new Promise(resolve => { finishLoad = resolve })
    const loading = useConfigStore.getState().loadAgents()

    prepareDraftSelection("current-draft", "builder", "builder-model", "low")
    finishLoad(catalog)
    expect(await loading).toBe(true)

    expect(useConfigStore.getState().currentAgentName).toBe("builder")
    expect(useConfigStore.getState().currentModelId).toBe("builder-model")
    expect(useConfigStore.getState().currentVariant).toBe("low")
    expect(useSessionUIStore.getState().draftsById["previous-draft"].sendConfig?.agent).toBe("orchestrator")
  })

  test("agent catalog still applies the configured default when no draft is selected", async () => {
    prepareSelectionCatalog()
    listAgentsStrictImpl = () => Promise.resolve(useConfigStore.getState().agents)
    expect(await useConfigStore.getState().loadAgents()).toBe(true)
    expect(useConfigStore.getState().currentAgentName).toBe("orchestrator")
    expect(useConfigStore.getState().currentModelId).toBe("orchestrator-model")
  })

  test("workspace 403 retries providers once without a directory and resets the saved workspace", async () => {
    let callCount = 0
    getProvidersImpl = () => {
      callCount += 1
      if (callCount === 1) {
        return Promise.reject(Object.assign(
          new Error("config.providers failed (403): Directory is outside your assigned workspace"),
          { status: 403 },
        ))
      }
      return Promise.resolve({ providers: [], default: {} })
    }

    await useConfigStore.getState().loadProviders()

    expect(providerCallOptions).toEqual([undefined, { directory: null }])
    expect(useConfigStore.getState().providersLoadStatus).toBe("ready")
    expect(useConfigStore.getState().providersLoadError).toBe(undefined)
    expect(useDirectoryStore.getState().currentDirectory).toBe("/default-workspace")
  })

  test("workspace recovery cancels the remaining stale directory activation", async () => {
    let providerCallCount = 0
    let agentCallCount = 0
    getProvidersImpl = (options) => {
      providerCallCount += 1
      if (providerCallCount === 1 && options === undefined) {
        return Promise.reject(Object.assign(
          new Error("config.providers failed (403): Directory is outside your assigned workspace"),
          { status: 403 },
        ))
      }
      return Promise.resolve({ providers: [], default: {} })
    }
    listAgentsStrictImpl = () => {
      agentCallCount += 1
      return Promise.resolve([])
    }

    await useConfigStore.getState().activateDirectory("/stale-workspace")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useDirectoryStore.getState().currentDirectory).toBe("/default-workspace")
    expect(useConfigStore.getState().activeDirectoryKey).toBe("/default-workspace")
    expect(agentCallCount).toBe(1)
  })

  test("workspace 403 still surfaces when the directory-less retry fails", async () => {
    let callCount = 0
    getProvidersImpl = () => {
      callCount += 1
      if (callCount === 1) {
        return Promise.reject(Object.assign(
          new Error("config.providers failed (403): Directory is outside your assigned workspace"),
          { status: 403 },
        ))
      }
      return Promise.reject(new Error("default workspace failed"))
    }

    await useConfigStore.getState().loadProviders()

    expect(providerCallOptions).toEqual([undefined, { directory: null }])
    expect(useConfigStore.getState().providersLoadStatus).toBe("error")
    expect(useConfigStore.getState().providersLoadError).toContain("default workspace failed")
  })

  test("concurrent provider loads dedup by default but force issues a real refetch", async () => {
    let callCount = 0
    let releaseFirst: (() => void) | undefined
    getProvidersImpl = () => {
      callCount += 1
      if (callCount === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ providers: [], default: {} })
        })
      }
      return Promise.resolve({ providers: [], default: {} })
    }

    const inFlight = useConfigStore.getState().loadProviders()
    // Deduped: reuses the in-flight request rather than hitting the API again.
    const deduped = useConfigStore.getState().loadProviders()
    expect(callCount).toBe(1)

    // Forced: polling for a freshly-authorized provider must not resolve against the
    // pre-auth catalog that the in-flight request already fetched.
    const forced = useConfigStore.getState().loadProviders({ force: true })
    expect(callCount).toBe(2)

    releaseFirst?.()
    await Promise.all([inFlight, deduped, forced])
  })

  test("initialization preserves healthy connectivity when provider bootstrap fails", async () => {
    getProvidersImpl = () => Promise.reject(new Error("provider bootstrap failed"))

    await useConfigStore.getState().initializeApp()

    const state = useConfigStore.getState()
    expect(state.isConnected).toBe(true)
    expect(state.connectionPhase).toBe("connected")
    expect(state.isInitialized).toBe(false)
    expect(state.providersLoadStatus).toBe("error")
    expect(state.initializationLoadStatus).toBe("error")
    expect(state.initializationLoadError).toBe("provider bootstrap failed")
    expect(state.lastDisconnectReason).toBe("init_error")
  })
})
