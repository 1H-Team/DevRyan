import { beforeEach, describe, expect, mock, test } from "bun:test"

let getProvidersImpl: (options?: { directory?: string | null }) => Promise<unknown>
let listAgentsStrictImpl: () => Promise<unknown>
let providerCallOptions: Array<{ directory?: string | null } | undefined>

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

describe("useConfigStore startup load status", () => {
  beforeEach(() => {
    console.error = mock(() => {}) as unknown as typeof console.error
    providerCallOptions = []
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
    })
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
