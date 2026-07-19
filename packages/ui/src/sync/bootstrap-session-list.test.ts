import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { registerManualAbortGuard, resetAbortGuardState, setAbortGuardExecutor } from "./abort-retry-guard"
import { bootstrapDirectory } from "./bootstrap"
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
