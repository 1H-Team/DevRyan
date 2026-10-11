import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { registerManualAbortGuard, resetAbortGuardState, setAbortGuardExecutor } from "./abort-retry-guard"
import { bootstrapDirectory } from "./bootstrap"
import { updateStreamingState, useStreamingStore } from "./streaming"
import { INITIAL_STATE, type State } from "./types"

const createSdk = (sessionStatus: Record<string, SessionStatus> = {}): OpencodeClient => ({
  project: { current: () => Promise.resolve({ data: { id: "project-a" } }) },
  provider: { list: () => Promise.resolve({ data: { all: [], connected: [], default: {} } }) },
  config: { get: () => Promise.resolve({ data: {} }) },
  path: { get: () => Promise.resolve({ data: { state: "", config: "", worktree: "", directory: "/repo", home: "" } }) },
  session: { status: () => Promise.resolve({ data: sessionStatus }) },
  app: { agents: () => Promise.resolve({ data: [] }) },
  command: { list: () => Promise.resolve({ data: [] }) },
  mcp: { status: () => Promise.resolve({ data: {} }) },
  lsp: { status: () => Promise.resolve({ data: [] }) },
  vcs: { get: () => Promise.resolve({ data: undefined }) },
  question: { list: () => Promise.resolve({ data: [] }) },
  permission: { list: () => Promise.resolve({ data: [] }) },
} as unknown as OpencodeClient)

const createState = (): State => ({
  ...INITIAL_STATE,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  session: [],
  session_status: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  message: {},
  part: {},
})

describe("bootstrapDirectory session list readiness", () => {
  beforeEach(() => {
    console.error = mock(() => {}) as unknown as typeof console.error
    resetAbortGuardState()
    setAbortGuardExecutor(null)
    useStreamingStore.setState({
      streamingMessageIds: new Map(),
      messageStreamStates: new Map(),
    })
  })

  test("loads sessions concurrently, waits for required data, then starts optional enrichment", async () => {
    let state = createState()
    const sdk = createSdk()
    let releasePath!: () => void
    const pathReady = new Promise<void>(resolve => { releasePath = resolve })
    const originalPath = sdk.path.get.bind(sdk.path)
    Object.assign(sdk.path, { get: async (...args: Parameters<typeof sdk.path.get>) => {
      await pathReady
      return originalPath(...args)
    } })
    const agents = mock(sdk.app.agents.bind(sdk.app))
    Object.assign(sdk.app, { agents })
    let sessionsStarted = false
    const boot = bootstrapDirectory({
      directory: "/repo", sdk, getState: () => state,
      set: patch => { state = { ...state, ...patch } },
      global: { config: {}, projects: [], providers: { all: [], connected: [], default: {} } },
      loadSessions: async directory => {
        expect(directory).toBe("/repo")
        sessionsStarted = true
      },
    })
    expect(sessionsStarted).toBe(true)
    expect(state.status).toBe("partial")
    expect(agents).toHaveBeenCalledTimes(0)
    releasePath()
    await boot
    expect(state.status).toBe("complete")
    expect(agents).toHaveBeenCalledTimes(1)
  })

  test("exposes critical failure instead of leaving preparing directory without a Retry error", async () => {
    let state = createState()
    const sdk = createSdk()
    Object.assign(sdk.path, { get: () => Promise.resolve({ error: "directory unavailable", response: { status: 400 } }) })
    await bootstrapDirectory({
      directory: "/repo", sdk, getState: () => state,
      set: patch => { state = { ...state, ...patch } },
      global: { config: {}, projects: [], providers: { all: [], connected: [], default: {} } },
      loadSessions: async () => {},
    })
    expect(state.status).toBe("partial")
    expect(state.bootstrapError).toContain("directory unavailable")
  })

  test("late responses from a cancelled directory cannot finish or replace state", async () => {
    let state = createState()
    const sdk = createSdk()
    const owner = new AbortController()
    let releasePath!: () => void
    const waiting = new Promise<void>(resolve => { releasePath = resolve })
    const originalPath = sdk.path.get.bind(sdk.path)
    Object.assign(sdk.path, { get: async (...args: Parameters<typeof sdk.path.get>) => {
      await waiting
      return originalPath(...args)
    } })
    const boot = bootstrapDirectory({
      directory: "/repo", sdk, signal: owner.signal, getState: () => state,
      set: patch => { state = { ...state, ...patch } },
      global: { config: {}, projects: [], providers: { all: [], connected: [], default: {} } },
      loadSessions: async () => {},
    })
    owner.abort()
    await boot
    const stopped = state
    releasePath()
    await Promise.resolve()
    await Promise.resolve()
    expect(state).toBe(stopped)
    expect(state.status).toBe("partial")
    expect(state.bootstrapError).toBeUndefined()
  })

  test("reconciles a large history without overwriting live status received during status loading", async () => {
    let state = createState()
    const sdk = createSdk()
    Object.assign(sdk.session, { status: async (input: { directory: string }) => {
      expect(input.directory).toBe("/repo")
      await Promise.resolve()
      state = { ...state, session_status: { "session-0": { type: "busy" } } }
      return { data: { "session-0": { type: "idle" } } }
    } })
    await bootstrapDirectory({
      directory: "/repo", sdk, getState: () => state,
      set: patch => { state = { ...state, ...patch } },
      global: { config: {}, projects: [], providers: { all: [], connected: [], default: {} } },
      loadSessions: async () => {
        state = { ...state, session: Array.from({ length: 5000 }, (_, index) =>
          ({ id: `session-${index}`, directory: "/repo" }) as State["session"][number]) }
      },
    })
    expect(state.status).toBe("complete")
    expect(state.session_status["session-0"]).toEqual({ type: "busy" })
    expect(state.session_status["session-4999"]).toEqual({ type: "idle" })
  })

  test("marks an empty session list ready after a successful first request", async () => {
    let state = createState()

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        state = { ...state, session: [], sessionTotal: 0, sessionListStatus: "ready" }
      },
    })

    expect(state.status).toBe("complete")
    expect(state.sessionListStatus).toBe("ready")
    expect(state.session).toEqual([])
  })

  test("keeps bootstrap incomplete and exposes the session list error after failure", async () => {
    let state = createState()

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        throw new Error("session.list failed (503): warming up")
      },
    })

    expect(state.status).toBe("partial")
    expect(state.sessionListStatus).toBe("error")
    expect(state.sessionListError).toContain("503")
    expect(state.bootstrapError).toBe(state.sessionListError)
  })

  test("treats listed sessions missing from a successful status snapshot as idle", async () => {
    let state = createState()

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        state = {
          ...state,
          session: [{ id: "session-a", directory: "/repo" } as State["session"][number]],
          sessionTotal: 1,
          sessionListStatus: "ready",
        }
      },
    })

    expect(state.session_status["session-a"]).toEqual({ type: "idle" })
  })

  test("settles a stale incomplete stream when the successful status snapshot omits its session", async () => {
    let state: State = {
      ...createState(),
      message: {
        "session-a": [
          {
            id: "user-a",
            sessionID: "session-a",
            role: "user",
            time: { created: 1 },
          },
          {
            id: "assistant-a",
            sessionID: "session-a",
            role: "assistant",
            time: { created: 2 },
          },
        ] as State["message"][string],
      },
    }
    updateStreamingState(state)
    expect(useStreamingStore.getState().streamingMessageIds.get("session-a")).toBe("assistant-a")

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        state = {
          ...state,
          session: [{ id: "session-a", directory: "/repo" } as State["session"][number]],
          sessionTotal: 1,
          sessionListStatus: "ready",
        }
      },
    })

    expect(state.session_status["session-a"]).toEqual({ type: "idle" })
    expect(useStreamingStore.getState().streamingMessageIds.get("session-a")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("assistant-a")?.phase).toBe("completed")
  })

  test("preserves a newer live status received while the session list loads", async () => {
    let state = createState()

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        state = {
          ...state,
          session: [{ id: "session-a", directory: "/repo" } as State["session"][number]],
          session_status: { "session-a": { type: "busy" } as SessionStatus },
          sessionTotal: 1,
          sessionListStatus: "ready",
        }
      },
    })

    expect(state.session_status["session-a"]).toEqual({ type: "busy" })
  })

  test("does not resurrect a guarded provider retry from the bootstrap status snapshot", async () => {
    let state = createState()
    const retryStatus = {
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: Date.now() + 120_000,
    } as SessionStatus
    registerManualAbortGuard("session-a", "/repo", retryStatus)

    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk({ "session-a": retryStatus }),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: {
        config: {},
        projects: [],
        providers: { all: [], connected: [], default: {} },
      },
      loadSessions: () => {
        state = { ...state, session: [], sessionTotal: 0, sessionListStatus: "ready" }
      },
    })

    expect(state.session_status["session-a"]).toEqual({ type: "idle" })
  })
})
