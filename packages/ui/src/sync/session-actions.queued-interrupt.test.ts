import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { isAbortGuardActive, resetAbortGuardState } from "./abort-retry-guard"

// Isolated harness (mock.module): only the surface the steered interrupt and
// its transport gate touch. Keep the real opencodeClient prototype so the
// process-wide mock stays a complete module.
const actualOpencodeClientModule = await import("@/lib/opencode/client")
const actualSyncRefsModule = await import("./sync-refs")
const bunTestHooks = (await import("bun:test")) as unknown as {
  afterAll: (callback: () => void) => void
}

const sessionAbortCalls: Array<Record<string, unknown>> = []
let sessionAbortHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let mockSessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }> = new Map()
let mockAbortControllers: Map<string, AbortController> = new Map()
let mockConfigStoreState: Record<string, unknown> = {}
const sessionDirectories: Record<string, string | null> = {
  "session-a": "/test/project",
}

let activeChild = false
let childCancellationError: string | null = null
let childCancellation: () => Promise<void> = async () => { activeChild = false }
mock.module("@/stores/useManagedOrchestrationStore", () => ({
  useManagedOrchestrationStore: {
    getState: () => ({
      taskIdsByRootId: { "session-a": activeChild ? ["child"] : [] },
      tasksById: { child: { taskId: "child", status: "running" } },
      actionErrorByTaskId: { child: childCancellationError },
      cancelTask: () => childCancellation(),
    }),
  },
}))

const mockSdk = {
  session: {
    abort: mock((params: Record<string, unknown>) => {
      sessionAbortCalls.push(params)
      return sessionAbortHandler(params)
    }),
  },
}

mock.module("@/lib/opencode/client", () => ({
  ...actualOpencodeClientModule,
  opencodeClient: Object.assign(
    Object.create(actualOpencodeClientModule.opencodeClient) as typeof actualOpencodeClientModule.opencodeClient,
    { getDirectory: () => "/test/project" },
  ),
}))

mock.module("sonner", () => ({
  toast: Object.assign(() => {}, {
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
    message: () => {},
    dismiss: () => {},
  }),
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: undefined,
      probeConnection: () => Promise.resolve(false),
      ...mockConfigStoreState,
    }),
    setState: (partial: Record<string, unknown>) => {
      mockConfigStoreState = { ...mockConfigStoreState, ...partial }
    },
  },
}))

mock.module("./input-store", () => ({
  getSessionComposerRevision: () => 0,
  markSessionComposerEdited: () => 1,
  useInputStore: {
    getState: () => ({}),
    setState: () => {},
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  beginGlobalSessionMembershipMutation: () => ({ entries: [] }),
  settleGlobalSessionMembershipMutation: () => {},
  queueGlobalSessionsRefreshAfterMutation: () => Promise.resolve(),
  useGlobalSessionsStore: {
    getState: () => ({
      archiveSessions: () => {},
      removeSessions: () => {},
      unarchiveSessions: () => {},
      restoreSessions: () => {},
      archiveSessionSnapshots: () => {},
      upsertSession: () => {},
      activeSessions: [],
      archivedSessions: [],
    }),
  },
}))

type AbortFlags = Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>
const sessionUIStore = {
  getState: () => ({
    currentSessionId: null as string | null,
    sessionAbortFlags: mockSessionAbortFlags,
    abortControllers: mockAbortControllers,
    setCurrentSession: () => {},
    setSessionDirectory: (sessionId: string, directory: string | null) => {
      sessionDirectories[sessionId] = directory
    },
    markSessionAsDevRyanCreated: () => {},
    getDirectoryForSession: (sessionId: string) => sessionDirectories[sessionId] ?? null,
    abortPendingSend: () => false,
    clearSessionTurnCompletion: () => {},
    clearSessionStopping: () => {},
  }),
  setState: (
    partial:
      | { sessionAbortFlags?: AbortFlags; abortControllers?: Map<string, AbortController> }
      | ((state: { sessionAbortFlags: AbortFlags; abortControllers: Map<string, AbortController> }) => {
        sessionAbortFlags?: AbortFlags
        abortControllers?: Map<string, AbortController>
      }),
  ) => {
    const next = typeof partial === "function"
      ? partial({ sessionAbortFlags: mockSessionAbortFlags, abortControllers: mockAbortControllers })
      : partial
    if (next.sessionAbortFlags) mockSessionAbortFlags = next.sessionAbortFlags
    if (next.abortControllers) mockAbortControllers = next.abortControllers
  },
}

actualSyncRefsModule.setSessionUIStoreRef(
  sessionUIStore as unknown as Parameters<typeof actualSyncRefsModule.setSessionUIStoreRef>[0],
)
bunTestHooks.afterAll(() => {
  actualSyncRefsModule.clearSessionUIStoreRef(
    sessionUIStore as unknown as Parameters<typeof actualSyncRefsModule.clearSessionUIStoreRef>[0],
  )
})

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

function makeSession(id: string): Session {
  return { id, title: id, time: { created: 1, updated: 1 } } as unknown as Session
}

function createStore(sessions: Session[]): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    permission: {},
    session: sessions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  const children = new Map(entries)
  return {
    children,
    ensureChild: (dir: string) => {
      const store = children.get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
  } as unknown as import("./child-store").ChildStoreManager
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const userMessage = { id: "msg-user", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
const assistantMessage = { id: "msg-assistant", sessionID: "session-a", role: "assistant", time: { created: 2 } } as unknown as Message

const goIdle = (store: StoreApi<DirectoryStore>) => {
  store.setState({ session_status: { "session-a": { type: "idle" } as SessionStatus } })
}

async function setupBusySession(status: SessionStatus = { type: "busy" } as SessionStatus) {
  const store = createStore([makeSession("session-a")])
  store.setState({
    message: { "session-a": [userMessage, assistantMessage] },
    session_status: { "session-a": status },
  })
  const childStores = createChildStores([["/test/project", store]])
  const actions = await import("./session-actions")
  actions.setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
  // The server acknowledges an abort by going idle, so the post-abort idle wait resolves at once.
  sessionAbortHandler = () => {
    goIdle(store)
    return Promise.resolve({ data: true })
  }
  return { store, actions }
}

const settled = <T,>(promise: Promise<T>, withinMs: number): Promise<"settled" | "pending"> => Promise.race([
  promise.then(() => "settled" as const, () => "settled" as const),
  new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), withinMs)),
])

describe("steered interrupt for queued sends", () => {
  beforeEach(() => {
    activeChild = false
    childCancellationError = null
    childCancellation = async () => { activeChild = false }
    sessionAbortCalls.length = 0
    sessionAbortHandler = () => Promise.resolve({ data: true })
    mockSessionAbortFlags = new Map()
    mockAbortControllers = new Map()
    mockConfigStoreState = {}
    sessionDirectories["session-a"] = "/test/project"
    resetAbortGuardState()
  })

  test("an idle root waits for its active child to confirm termination", async () => {
    const { actions } = await setupBusySession({ type: "idle" } as SessionStatus)
    activeChild = true
    const child = createDeferred<void>()
    childCancellation = async () => { await child.promise; activeChild = false }
    const gate = actions.beginQueuedSendInterrupt("session-a", 500)()
    expect(await settled(gate, 20)).toBe("pending")
    expect(sessionAbortCalls).toEqual([])
    child.resolve()
    await gate
  })

  test("rejects steering when a child remains active after cancellation", async () => {
    const { actions } = await setupBusySession()
    activeChild = true
    childCancellation = async () => { childCancellationError = "still running" }
    await expect(actions.beginQueuedSendInterrupt("session-a", 500)()).rejects.toThrow("Managed subtask cancellation was not confirmed")
    expect(mockSessionAbortFlags.get("session-a")?.reason).toBe("steered")
  })

  test("rejects an unconfirmed parent abort", async () => {
    const { actions } = await setupBusySession()
    sessionAbortHandler = async () => ({ data: false })
    await expect(actions.beginQueuedSendInterrupt("session-a", 500)()).rejects.toThrow("OpenCode did not confirm")
    expect(mockSessionAbortFlags.get("session-a")).toBeUndefined()
  })

  test("bounds the abort with a watchdog that rejects and clears the guard", async () => {
    const { store, actions } = await setupBusySession()
    const neverAcknowledged = createDeferred<unknown>()
    sessionAbortHandler = () => neverAcknowledged.promise

    expect(actions.STEERED_ABORT_TIMEOUT_MS).toBe(4_000)
    let error: unknown
    const startedAt = Date.now()
    try {
      await actions.interruptCurrentOperationForSteeredSend("session-a", 40)
    } catch (caught) {
      error = caught
    }

    expect(error instanceof Error ? error.message : "").toBe("Session abort timed out")
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    // The stop never went through: no steered marker, no guard masking live status.
    expect(isAbortGuardActive("session-a")).toBe(false)
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
    expect(store.getState().session_status["session-a"]?.type).toBe("busy")
    neverAcknowledged.resolve({ data: true })
  })

  test("marks a steered abort when the sdk confirms in time", async () => {
    const { actions } = await setupBusySession()

    await actions.interruptCurrentOperationForSteeredSend("session-a", 500)

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    const abortFlag = mockSessionAbortFlags.get("session-a")
    expect(abortFlag?.reason).toBe("steered")
    expect(abortFlag?.id).toBe("msg-assistant")
    expect(abortFlag?.acknowledged).toBe(false)
  })

  test("beginQueuedSendInterrupt returns a gate that settles only once the abort is confirmed", async () => {
    const { actions, store } = await setupBusySession()
    const acknowledgement = createDeferred<unknown>()
    sessionAbortHandler = () => acknowledgement.promise

    const awaitTransportGate = actions.beginQueuedSendInterrupt("session-a", 500)
    const gate = awaitTransportGate()

    // The abort was requested immediately, but the gate stays open until it settles.
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(await settled(gate, 30)).toBe("pending")
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)

    goIdle(store)
    acknowledgement.resolve({ data: true })
    await gate
    expect(mockSessionAbortFlags.get("session-a")?.reason).toBe("steered")
    // The gate is idempotent: later awaits observe the same settled promise.
    await awaitTransportGate()
  })

  test("beginQueuedSendInterrupt rejects the gate when the watchdog fires", async () => {
    const { store, actions } = await setupBusySession()
    const neverAcknowledged = createDeferred<unknown>()
    sessionAbortHandler = () => neverAcknowledged.promise

    const awaitTransportGate = actions.beginQueuedSendInterrupt("session-a", 40)

    let error: unknown
    try {
      await awaitTransportGate()
    } catch (caught) {
      error = caught
    }
    expect(error instanceof Error ? error.message : "").toBe("Session abort timed out")
    expect(isAbortGuardActive("session-a")).toBe(false)
    expect(store.getState().session_status["session-a"]?.type).toBe("busy")
    neverAcknowledged.resolve({ data: true })
  })

  test("beginQueuedSendInterrupt skips the abort for an idle session", async () => {
    const { actions } = await setupBusySession({ type: "idle" } as SessionStatus)

    await actions.beginQueuedSendInterrupt("session-a", 500)()

    expect(sessionAbortCalls).toEqual([])
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
  })
})
