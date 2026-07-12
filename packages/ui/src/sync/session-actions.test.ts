import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "./event-reducer"
import { useManagedOrchestrationStore } from "@/stores/useManagedOrchestrationStore"

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const sessionCreateCalls: Array<Record<string, unknown>> = []
const sessionUpdateCalls: Array<Record<string, unknown>> = []
const sessionDeleteCalls: Array<Record<string, unknown>> = []
const sessionAbortCalls: Array<Record<string, unknown>> = []
const sessionMessageCalls: Array<Record<string, unknown>> = []
const sessionUnrevertCalls: Array<Record<string, unknown>> = []
const sessionForkCalls: Array<Record<string, unknown>> = []
const scopedRevertCalls: Array<{ sessionId: string; messageId: string; directory?: string }> = []
let sessionCreateHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: makeSession("created-session") })
let sessionUpdateHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionDeleteHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionAbortHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionMessagesHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: [] })
let sessionUnrevertHandler: (params: Record<string, unknown>) => Promise<unknown> = (params) => Promise.resolve({ data: makeSession(String(params.sessionID)) })
let sessionForkHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: makeSession("forked-session") })
let scopedRevertHandler: (sessionId: string, messageId: string, directory?: string) => Promise<Session> = (sessionId, messageId) => Promise.resolve({
  id: sessionId,
  title: sessionId,
  time: { created: 1, updated: 2 },
  revert: { messageID: messageId },
} as unknown as Session)
const restoredAttachmentCalls: Array<{ url: string; mimeType: string; filename: string }> = []

const setCurrentSessionCalls: Array<{ id: string | null; directory?: string | null }> = []
let mockCurrentSessionId: string | null = null
let mockSessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }> = new Map()
let mockAbortControllers: Map<string, AbortController> = new Map()
const clearSessionTurnCompletionCalls: string[] = []
let mockSessionCompletionIndicator: Map<string, { messageId: string; completedAt: number }> = new Map()
let mockPendingCompletionIndicatorSessions: Set<string> = new Set()
const sessionDirectories: Record<string, string | null> = {
  "session-a": "/test/project",
  "session-b": "/other/project",
}
let inputStoreState: Record<string, unknown> = {}

const globalArchiveCalls: Array<{ ids: string[]; archivedAt?: number }> = []
const globalRemoveCalls: Array<{ ids: string[] }> = []
const globalUnarchiveCalls: Array<{ ids: string[] }> = []
const globalRestoreCalls: Array<{ ids: string[] }> = []
const globalArchiveSnapshotCalls: Array<{ ids: string[]; archivedAt: number }> = []
let mockGlobalActiveSessions: Session[] = []
let mockGlobalArchivedSessions: Session[] = []
let mockConfigStoreState: Record<string, unknown> = {}

const mockScopedClient = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      return Promise.resolve({ data: true })
    }),
  },
}

const mockSdk = {
  session: {
    create: mock((params: Record<string, unknown>) => {
      sessionCreateCalls.push(params)
      return sessionCreateHandler(params)
    }),
    update: mock((params: Record<string, unknown>) => {
      sessionUpdateCalls.push(params)
      return sessionUpdateHandler(params)
    }),
    delete: mock((params: Record<string, unknown>) => {
      sessionDeleteCalls.push(params)
      return sessionDeleteHandler(params)
    }),
    abort: mock((params: Record<string, unknown>) => {
      sessionAbortCalls.push(params)
      return sessionAbortHandler(params)
    }),
    messages: mock((params: Record<string, unknown>) => {
      sessionMessageCalls.push(params)
      return sessionMessagesHandler(params)
    }),
    unrevert: mock((params: Record<string, unknown>) => {
      sessionUnrevertCalls.push(params)
      return sessionUnrevertHandler(params)
    }),
    fork: mock((params: Record<string, unknown>) => {
      sessionForkCalls.push(params)
      return sessionForkHandler(params)
    }),
  },
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      return Promise.resolve({ data: true })
    }),
  },
}

// Mock opencodeClient singleton
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getScopedSdkClient: (_: string) => mockScopedClient,
    getDirectory: () => "/test/project",
    revertSessionScoped: (sessionId: string, messageId: string, directory?: string) => {
      scopedRevertCalls.push({ sessionId, messageId, directory })
      return scopedRevertHandler(sessionId, messageId, directory)
    },
  },
}))

// Mock useConfigStore
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

// Mock useSessionUIStore
mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: mockCurrentSessionId,
      sessionAbortFlags: mockSessionAbortFlags,
      abortControllers: mockAbortControllers,
      setCurrentSession: (id: string | null, directory?: string | null) => {
        setCurrentSessionCalls.push({ id, directory })
        mockCurrentSessionId = id
      },
      setSessionDirectory: (sessionId: string, directory: string | null) => {
        sessionDirectories[sessionId] = directory
      },
      markSessionAsOpenChamberCreated: () => {},
      getDirectoryForSession: (sessionId: string) => sessionDirectories[sessionId] ?? null,
      abortPendingSend: (key: string) => {
        const controller = mockAbortControllers.get(key)
        if (!controller) return false
        controller.abort()
        mockAbortControllers.delete(key)
        return true
      },
      clearSessionTurnCompletion: (sessionId: string) => {
        clearSessionTurnCompletionCalls.push(sessionId)
        mockSessionCompletionIndicator.delete(sessionId)
        mockPendingCompletionIndicatorSessions.delete(sessionId)
      },
    }),
    setState: (
      partial:
        | {
          sessionAbortFlags?: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>
          abortControllers?: Map<string, AbortController>
        }
        | ((state: {
          currentSessionId: string | null
          sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>
          abortControllers: Map<string, AbortController>
          getDirectoryForSession: (sessionId: string) => string | null
        }) => {
          sessionAbortFlags?: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>
          abortControllers?: Map<string, AbortController>
        }),
    ) => {
      const baseState = {
        currentSessionId: mockCurrentSessionId,
        sessionAbortFlags: mockSessionAbortFlags,
        abortControllers: mockAbortControllers,
        getDirectoryForSession: (sessionId: string) => sessionDirectories[sessionId] ?? null,
      }
      const next = typeof partial === "function" ? partial(baseState) : partial
      if (next.sessionAbortFlags) {
        mockSessionAbortFlags = next.sessionAbortFlags
      }
      if ("abortControllers" in next && next.abortControllers) {
        mockAbortControllers = next.abortControllers
      }
    },
  },
}))

// Mock useInputStore (imported but not used in permission functions)
mock.module("./input-store", () => ({
  useInputStore: {
    setState: (partial: Record<string, unknown>) => {
      inputStoreState = { ...inputStoreState, ...partial }
    },
    getState: () => ({
      setPendingInputText: (text: string | null, mode = "replace") => {
        inputStoreState = {
          ...inputStoreState,
          pendingInputText: text,
          pendingInputMode: mode,
        }
      },
      clearAttachedFiles: () => {
        inputStoreState = { ...inputStoreState, attachedFiles: [] }
      },
      addRestoredAttachment: (attachment: { url: string; mimeType: string; filename: string }) => {
        restoredAttachmentCalls.push(attachment)
        inputStoreState = {
          ...inputStoreState,
          attachedFiles: [
            ...((inputStoreState.attachedFiles as unknown[] | undefined) ?? []),
            attachment,
          ],
        }
      },
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      archiveSessions: (ids: Iterable<string>, archivedAt?: number) => {
        const idList = Array.from(ids)
        globalArchiveCalls.push({ ids: idList, archivedAt })
      },
      removeSessions: (ids: Iterable<string>) => {
        const idList = Array.from(ids)
        const idSet = new Set(idList)
        globalRemoveCalls.push({ ids: idList })
        mockGlobalActiveSessions = mockGlobalActiveSessions.filter((session) => !idSet.has(session.id))
        mockGlobalArchivedSessions = mockGlobalArchivedSessions.filter((session) => !idSet.has(session.id))
      },
      unarchiveSessions: (ids: Iterable<string>) => {
        globalUnarchiveCalls.push({ ids: Array.from(ids) })
      },
      restoreSessions: (sessions: Session[]) => {
        globalRestoreCalls.push({ ids: sessions.map((session) => session.id) })
        for (const session of sessions) {
          const idSet = new Set([session.id])
          mockGlobalActiveSessions = mockGlobalActiveSessions.filter((candidate) => !idSet.has(candidate.id))
          mockGlobalArchivedSessions = mockGlobalArchivedSessions.filter((candidate) => !idSet.has(candidate.id))
          if (session.time?.archived) {
            mockGlobalArchivedSessions = [session, ...mockGlobalArchivedSessions]
          } else {
            mockGlobalActiveSessions = [session, ...mockGlobalActiveSessions]
          }
        }
      },
      archiveSessionSnapshots: (sessions: Session[], archivedAt: number) => {
        globalArchiveSnapshotCalls.push({ ids: sessions.map((session) => session.id), archivedAt })
        globalArchiveCalls.push({ ids: sessions.map((session) => session.id), archivedAt })
        const idSet = new Set(sessions.map((session) => session.id))
        mockGlobalActiveSessions = mockGlobalActiveSessions.filter((session) => !idSet.has(session.id))
        mockGlobalArchivedSessions = [
          ...sessions.map((session) => ({
            ...session,
            time: { ...session.time, archived: archivedAt },
          })),
          ...mockGlobalArchivedSessions.filter((session) => !idSet.has(session.id)),
        ]
      },
      upsertSession: () => {},
      activeSessions: mockGlobalActiveSessions,
      archivedSessions: mockGlobalArchivedSessions,
    }),
  },
}))

// Mock sync-refs (imported but not used in permission functions)
mock.module("./sync-refs", () => ({
  registerSessionDirectory: () => {},
  setSyncRefs: () => {},
  getSyncChildStores: () => {
    throw new Error("not initialized")
  },
  getSyncDirectory: () => "/test/project",
  getDirectoryState: () => undefined,
  getSyncSessions: () => [],
  getAllSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncSessionMaterializationStatus: () => ({ hasMessages: false, renderable: false, missingPartMessageIDs: [] }),
  getSyncParts: () => [],
  getSyncSessionStatus: () => undefined,
  getAllSyncSessionStatuses: () => ({}),
  getSyncSessionStatusAnyDirectory: () => undefined,
  getSyncBlockingRequestCountAnyDirectory: () => 0,
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

function createStore(permissions: Record<string, PermissionRequest[]>, sessions: Session[] = []): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    permission: permissions,
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

function makeSession(id: string, parentID?: string | null): Session {
  return {
    id,
    parentID,
    title: id,
    time: { created: 1, updated: 1 },
  } as unknown as Session
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

async function withMutedConsoleError<T>(callback: () => Promise<T>): Promise<T> {
  const originalError = console.error
  console.error = () => {}
  try {
    return await callback()
  } finally {
    console.error = originalError
  }
}

describe("waitForConnectionOrThrow", () => {
  beforeEach(() => {
    mockConfigStoreState = {}
  })

  test("allows sends when a health probe recovers stale disconnected state", async () => {
    const { waitForConnectionOrThrow } = await import("./session-actions")
    let probeCalls = 0
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => {
        probeCalls += 1
        mockConfigStoreState = {
          ...mockConfigStoreState,
          isConnected: true,
          hasEverConnected: true,
        }
        return Promise.resolve(true)
      },
    }

    await waitForConnectionOrThrow()

    expect(probeCalls).toBe(1)
  })

  test("includes the disconnect reason when health probes cannot recover", async () => {
    const { waitForConnectionOrThrow } = await import("./session-actions")
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => Promise.resolve(false),
    }

    const startedAt = Date.now()
    let thrown: unknown = null
    try {
      await waitForConnectionOrThrow()
    } catch (error) {
      thrown = error
    }

    expect(Date.now() - startedAt).toBeGreaterThan(1900)
    expect(thrown instanceof Error ? thrown.message : "").toContain("ws_closed_before_ready")
  })
})

describe("createSessionRecord startup readiness", () => {
  beforeEach(() => {
    sessionCreateCalls.length = 0
    mockConfigStoreState = {}
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionCreateHandler = () => Promise.resolve({ data: makeSession("created-session") })
  })

  test("retries a transient OpenCode restart response before failing chat creation", async () => {
    const store = createStore({}, [])
    const childStores = createChildStores([["/test/project", store]])
    let attempts = 0
    sessionCreateHandler = () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.resolve({
          error: new Error("OpenCode is restarting"),
          response: { status: 503 },
        })
      }
      return Promise.resolve({
        data: {
          ...makeSession("session-created-after-restart"),
          directory: "/test/project",
        },
      })
    }

    const { setActionRefs, createSessionRecord, consumeLastCreateSessionError } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const session = await createSessionRecord("Retry startup", "/test/project", null)

    expect(session?.id).toBe("session-created-after-restart")
    expect(sessionCreateCalls).toHaveLength(2)
    expect(sessionCreateCalls[0]).toEqual({
      directory: "/test/project",
      title: "Retry startup",
      parentID: undefined,
    })
    expect(sessionDirectories["session-created-after-restart"]).toBe("/test/project")
    expect(consumeLastCreateSessionError()).toBeNull()
  })

  test("releases imperative SDK refs only for the owning provider", async () => {
    const ownerStore = createStore({}, [])
    const owner = createChildStores([["/test/project", ownerStore]])
    const other = createChildStores([["/other", createStore({}, [])]])
    const { clearActionRefs, createSessionRecord, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, owner, () => "/test/project")

    expect(clearActionRefs(other)).toBe(false)
    expect((await createSessionRecord("Owned", "/test/project"))?.id).toBe("created-session")
    const callsBeforeRelease = sessionCreateCalls.length

    expect(clearActionRefs(owner)).toBe(true)
    const releasedResult = await withMutedConsoleError(() => createSessionRecord("Released", "/test/project"))
    expect(releasedResult).toBeNull()
    expect(sessionCreateCalls).toHaveLength(callsBeforeRelease)
  })
})

describe("archiveSessions batch behavior", () => {
  beforeEach(() => {
    sessionCreateCalls.length = 0
    sessionUpdateCalls.length = 0
    sessionDeleteCalls.length = 0
    sessionAbortCalls.length = 0
    sessionMessageCalls.length = 0
    sessionUnrevertCalls.length = 0
    sessionForkCalls.length = 0
    scopedRevertCalls.length = 0
    setCurrentSessionCalls.length = 0
    globalArchiveCalls.length = 0
    globalRemoveCalls.length = 0
    globalUnarchiveCalls.length = 0
    globalRestoreCalls.length = 0
    globalArchiveSnapshotCalls.length = 0
    mockCurrentSessionId = null
    mockConfigStoreState = {}
    mockSessionAbortFlags = new Map()
    mockGlobalActiveSessions = []
    mockGlobalArchivedSessions = []
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDirectories["session-a"] = "/test/project"
    sessionDirectories["session-b"] = "/other/project"
    sessionUpdateHandler = () => Promise.resolve({ data: true })
    sessionDeleteHandler = () => Promise.resolve({ data: true })
    sessionAbortHandler = () => Promise.resolve({ data: true })
    sessionMessagesHandler = () => Promise.resolve({ data: [] })
    sessionUnrevertHandler = (params) => Promise.resolve({ data: makeSession(String(params.sessionID)) })
    sessionForkHandler = () => Promise.resolve({ data: makeSession("forked-session") })
    sessionCreateHandler = () => Promise.resolve({ data: makeSession("created-session") })
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve({
      id: sessionId,
      title: sessionId,
      time: { created: 1, updated: 2 },
      revert: { messageID: messageId },
    } as unknown as Session)
  })

  test("expands direct and nested descendants for shared session scope helpers", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    const grandchild = makeSession("grandchild", "child")
    const unrelated = makeSession("unrelated")
    const store = createStore({}, [parent, child, grandchild, unrelated])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, getSessionIdsWithDescendants } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(getSessionIdsWithDescendants(["parent"])).toEqual(["parent", "child", "grandchild"])
    expect(getSessionIdsWithDescendants(["child"])).toEqual(["child", "grandchild"])
    expect(getSessionIdsWithDescendants(["parent", "child", "parent"])).toEqual(["parent", "child", "grandchild"])
  })

  test("removes all sessions optimistically and starts SDK updates concurrently", async () => {
    const sessionA = makeSession("session-a")
    const sessionB = makeSession("session-b")
    const storeA = createStore({}, [sessionA])
    const storeB = createStore({}, [sessionB])
    const childStores = createChildStores([
      ["/test/project", storeA],
      ["/other/project", storeB],
    ])
    const deferredA = createDeferred<{ data: boolean }>()
    const deferredB = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["session-a", deferredA],
      ["session-b", deferredB],
    ])
    sessionUpdateHandler = (params) => {
      const deferred = deferredBySession.get(String(params.sessionID))
      if (!deferred) throw new Error(`unexpected session ${String(params.sessionID)}`)
      return deferred.promise
    }

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = archiveSessions(["session-a", "session-b"])
    await Promise.resolve()

    expect(storeA.getState().session).toEqual([])
    expect(storeB.getState().session).toEqual([])
    expect(sessionUpdateCalls.map((params) => params.sessionID).sort()).toEqual(["session-a", "session-b"])

    deferredA.resolve({ data: true })
    deferredB.resolve({ data: true })

    expect(await resultPromise).toEqual({ archivedIds: ["session-a", "session-b"], failedIds: [] })
  })

  test("waits for transient connection recovery before archiving on the first call", async () => {
    const sessionA = makeSession("session-a")
    const store = createStore({}, [sessionA])
    const childStores = createChildStores([["/test/project", store]])
    let probeCalls = 0
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => {
        probeCalls += 1
        mockConfigStoreState = {
          ...mockConfigStoreState,
          isConnected: true,
          hasEverConnected: true,
        }
        return Promise.resolve(true)
      },
    }

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["session-a"])).toEqual({
      archivedIds: ["session-a"],
      failedIds: [],
    })

    expect(probeCalls).toBe(1)
    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["session-a"])
    expect(store.getState().session).toEqual([])
  })

  test("does not optimistically remove sessions when connection grace fails", async () => {
    const sessionA = makeSession("session-a")
    const store = createStore({}, [sessionA])
    const childStores = createChildStores([["/test/project", store]])
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => Promise.resolve(false),
    }

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["session-a"])).toEqual({
      archivedIds: [],
      failedIds: ["session-a"],
    })

    expect(sessionUpdateCalls).toEqual([])
    expect(globalRemoveCalls).toEqual([])
    expect(store.getState().session.map((session) => session.id)).toEqual(["session-a"])
  })

  test("restores only failed archive sessions after optimistic global archive", async () => {
    const sessionA = makeSession("session-a")
    const sessionB = makeSession("session-b")
    const storeA = createStore({}, [sessionA])
    const storeB = createStore({}, [sessionB])
    const childStores = createChildStores([
      ["/test/project", storeA],
      ["/other/project", storeB],
    ])
    sessionUpdateHandler = (params) => {
      if (params.sessionID === "session-b") {
        return Promise.reject(new Error("archive failed"))
      }
      return Promise.resolve({ data: true })
    }

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => archiveSessions(["session-a", "session-b"]))).toEqual({
      archivedIds: ["session-a"],
      failedIds: ["session-b"],
    })

    expect(storeA.getState().session).toEqual([])
    expect(storeB.getState().session.map((session) => session.id)).toEqual(["session-b"])
    expect(globalArchiveCalls).toHaveLength(1)
    expect(globalArchiveCalls[0].ids).toEqual(["session-a", "session-b"])
    expect(typeof globalArchiveCalls[0].archivedAt).toBe("number")
    expect(globalRestoreCalls[0].ids).toEqual(["session-b"])
  })

  test("archives globally known sessions using their snapshot directory instead of current directory", async () => {
    const globalSession = {
      ...makeSession("global-session"),
      directory: "/other/project",
    } as Session
    mockGlobalActiveSessions = [globalSession]
    delete sessionDirectories["global-session"]
    const currentStore = createStore({}, [])
    const targetStore = createStore({}, [globalSession])
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", targetStore],
    ])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["global-session"])).toEqual({
      archivedIds: ["global-session"],
      failedIds: [],
    })

    expect(sessionUpdateCalls).toHaveLength(1)
    expect(sessionUpdateCalls[0].sessionID).toBe("global-session")
    expect(sessionUpdateCalls[0].directory).toBe("/other/project")
    expect(currentStore.getState().session).toEqual([])
    expect(targetStore.getState().session).toEqual([])
    expect(globalArchiveCalls[0].ids).toEqual(["global-session"])
  })

  test("optimistically removes globally known sessions from their snapshot directory first", async () => {
    const globalSession = {
      ...makeSession("global-session"),
      directory: "/other/project",
    } as Session
    mockGlobalActiveSessions = [globalSession]
    delete sessionDirectories["global-session"]
    const currentStore = createStore({}, [])
    const targetStore = createStore({}, [globalSession])
    const children = new Map<string, StoreApi<DirectoryStore>>([
      ["/test/project", currentStore],
      ["/other/project", targetStore],
    ])
    const ensureChildCalls: string[] = []
    const childStores = {
      children,
      ensureChild: (directory: string) => {
        ensureChildCalls.push(directory)
        const store = children.get(directory)
        if (!store) throw new Error(`No store for ${directory}`)
        return store
      },
    } as unknown as import("./child-store").ChildStoreManager

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = archiveSessions(["global-session"])
    await Promise.resolve()

    expect(ensureChildCalls[0]).toBe("/other/project")
    expect(targetStore.getState().session).toEqual([])

    expect(await resultPromise).toEqual({
      archivedIds: ["global-session"],
      failedIds: [],
    })
  })

  test("restores current session selection when archiving it fails", async () => {
    const sessionA = makeSession("session-a")
    const storeA = createStore({}, [sessionA])
    const childStores = createChildStores([["/test/project", storeA]])
    mockCurrentSessionId = "session-a"
    sessionUpdateHandler = () => Promise.reject(new Error("archive failed"))

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => archiveSessions(["session-a"]))).toEqual({ archivedIds: [], failedIds: ["session-a"] })

    expect(storeA.getState().session.map((session) => session.id)).toEqual(["session-a"])
    expect(setCurrentSessionCalls).toEqual([
      { id: null, directory: undefined },
      { id: "session-a", directory: "/test/project" },
    ])
    expect(globalArchiveCalls[0].ids).toEqual(["session-a"])
    expect(globalRestoreCalls[0].ids).toEqual(["session-a"])
  })

  test("archives direct and nested child sessions with the parent", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    const grandchild = makeSession("grandchild", "child")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    sessionDirectories.grandchild = "/test/project"
    const store = createStore({}, [parent, child, grandchild])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["parent"])).toEqual({
      archivedIds: ["parent", "child", "grandchild"],
      failedIds: [],
    })

    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["parent", "child", "grandchild"])
    expect(store.getState().session).toEqual([])
    expect(globalArchiveCalls[0].ids).toEqual(["parent", "child", "grandchild"])
  })

  test("moves parent and descendant sessions to global archived snapshot while archive is pending", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    mockGlobalActiveSessions = [parent, child]
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])
    const deferredParent = createDeferred<{ data: boolean }>()
    const deferredChild = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["parent", deferredParent],
      ["child", deferredChild],
    ])
    sessionUpdateHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = archiveSessions(["parent"])
    await Promise.resolve()

    expect(store.getState().session).toEqual([])
    expect(mockGlobalActiveSessions.map((session) => session.id)).toEqual([])
    expect(mockGlobalArchivedSessions.map((session) => session.id)).toEqual(["parent", "child"])
    expect(globalArchiveSnapshotCalls[0].ids).toEqual(["parent", "child"])

    deferredParent.resolve({ data: true })
    deferredChild.resolve({ data: true })

    expect(await resultPromise).toEqual({ archivedIds: ["parent", "child"], failedIds: [] })
  })

  test("archiving a child does not archive its parent", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["child"])).toEqual({ archivedIds: ["child"], failedIds: [] })

    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["child"])
    expect(store.getState().session.map((session) => session.id)).toEqual(["parent"])
    expect(globalArchiveCalls[0].ids).toEqual(["child"])
  })

  test("deduplicates descendant sessions during bulk archive", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["parent", "child"])).toEqual({ archivedIds: ["parent", "child"], failedIds: [] })

    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["parent", "child"])
    expect(globalArchiveCalls[0].ids).toEqual(["parent", "child"])
  })

  test("restores only failed descendant archive sessions", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    mockGlobalActiveSessions = [parent, child]
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])
    sessionUpdateHandler = (params) => {
      if (params.sessionID === "child") {
        return Promise.reject(new Error("archive failed"))
      }
      return Promise.resolve({ data: true })
    }

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => archiveSessions(["parent"]))).toEqual({ archivedIds: ["parent"], failedIds: ["child"] })

    expect(store.getState().session.map((session) => session.id)).toEqual(["child"])
    expect(globalArchiveCalls[0].ids).toEqual(["parent", "child"])
    expect(globalArchiveSnapshotCalls[0].ids).toEqual(["parent", "child"])
    expect(globalRestoreCalls[0].ids).toEqual(["child"])
  })

  test("aborts working descendants before a working parent, then archives", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    store.setState({
      session_status: {
        parent: { type: "busy" } as SessionStatus,
        child: { type: "busy" } as SessionStatus,
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["parent"])).toEqual({
      archivedIds: ["parent", "child"],
      failedIds: [],
    })

    expect(sessionAbortCalls.map((params) => params.sessionID)).toEqual(["child", "parent"])
    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["parent", "child"])
  })

  test("logs abort failures but still archives when session.update succeeds", async () => {
    const parent = makeSession("parent")
    sessionDirectories.parent = "/test/project"
    const store = createStore({}, [parent])
    store.setState({
      session_status: {
        parent: { type: "busy" } as SessionStatus,
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => archiveSessions(["parent"]))).toEqual({
      archivedIds: ["parent"],
      failedIds: [],
    })

    expect(sessionAbortCalls.map((params) => params.sessionID)).toEqual(["parent"])
    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["parent"])
  })

  test("clears current session when archiving a parent cascades to current descendant", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    mockCurrentSessionId = "child"
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["parent"])).toEqual({ archivedIds: ["parent", "child"], failedIds: [] })

    expect(setCurrentSessionCalls).toEqual([{ id: null, directory: undefined }])
  })
})

describe("unarchiveSessions cascade behavior", () => {
  beforeEach(() => {
    sessionUpdateCalls.length = 0
    globalUnarchiveCalls.length = 0
    globalRemoveCalls.length = 0
    globalRestoreCalls.length = 0
    mockGlobalActiveSessions = []
    mockGlobalArchivedSessions = []
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionUpdateHandler = () => Promise.resolve({ data: true })
  })

  test("unarchives direct and nested child sessions with the parent", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    const grandchild = makeSession("grandchild", "child")
    mockGlobalArchivedSessions = [parent, child, grandchild]
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    sessionDirectories.grandchild = "/test/project"
    const childStores = createChildStores([["/test/project", createStore({})]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await unarchiveSessions(["parent"])).toEqual({
      unarchivedIds: ["parent", "child", "grandchild"],
      failedIds: [],
    })

    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["parent", "child", "grandchild"])
    expect(globalRestoreCalls[0].ids).toEqual(["parent", "child", "grandchild"])
    expect(globalUnarchiveCalls[0].ids).toEqual([])
  })

  test("unarchiving a child does not unarchive its parent", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    mockGlobalArchivedSessions = [parent, child]
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const childStores = createChildStores([["/test/project", createStore({})]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await unarchiveSessions(["child"])).toEqual({ unarchivedIds: ["child"], failedIds: [] })

    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual(["child"])
    expect(globalRestoreCalls[0].ids).toEqual(["child"])
    expect(globalUnarchiveCalls[0].ids).toEqual([])
  })
})

describe("deleteSessions archived behavior", () => {
  beforeEach(() => {
    sessionUpdateCalls.length = 0
    sessionDeleteCalls.length = 0
    sessionAbortCalls.length = 0
    setCurrentSessionCalls.length = 0
    globalRemoveCalls.length = 0
    globalRestoreCalls.length = 0
    globalArchiveSnapshotCalls.length = 0
    mockCurrentSessionId = null
    mockGlobalActiveSessions = []
    mockGlobalArchivedSessions = []
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDeleteHandler = () => Promise.resolve({ data: true })
    sessionAbortHandler = () => Promise.resolve({ data: true })
  })

  test("aborts working descendants before a working parent, then deletes", async () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    sessionDirectories.parent = "/test/project"
    sessionDirectories.child = "/test/project"
    const store = createStore({}, [parent, child])
    store.setState({
      session_status: {
        parent: { type: "busy" } as SessionStatus,
        child: { type: "busy" } as SessionStatus,
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await deleteSessions(["parent"])).toEqual({
      deletedIds: ["parent", "child"],
      failedIds: [],
    })

    expect(sessionAbortCalls.map((params) => params.sessionID)).toEqual(["child", "parent"])
    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual(["child", "parent"])
  })

  test("deletes an archived session using its archived snapshot directory", async () => {
    const archived = {
      ...makeSession("archived-session"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [archived]
    const childStores = createChildStores([])

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await deleteSessions(["archived-session"])).toEqual({
      deletedIds: ["archived-session"],
      failedIds: [],
    })

    expect(sessionDeleteCalls).toEqual([
      { sessionID: "archived-session", directory: "/archived/project" },
    ])
    expect(globalRemoveCalls[0]).toEqual({ ids: ["archived-session"] })
  })

  test("deleting an archived parent cascades to archived descendants", async () => {
    const parent = {
      ...makeSession("archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const child = {
      ...makeSession("archived-child", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const grandchild = {
      ...makeSession("archived-grandchild", "archived-child"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [parent, child, grandchild]
    const childStores = createChildStores([])

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await deleteSessions(["archived-parent"])).toEqual({
      deletedIds: ["archived-parent", "archived-child", "archived-grandchild"],
      failedIds: [],
    })

    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual([
      "archived-grandchild",
      "archived-child",
      "archived-parent",
    ])
    expect(sessionDeleteCalls.every((params) => params.directory === "/archived/project")).toBe(true)
    expect(globalRemoveCalls[0].ids).toEqual(["archived-parent", "archived-child", "archived-grandchild"])
  })

  test("waits for archived descendants to delete before starting ancestor deletes", async () => {
    const parent = {
      ...makeSession("archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const child = {
      ...makeSession("archived-child", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const grandchild = {
      ...makeSession("archived-grandchild", "archived-child"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [parent, child, grandchild]
    const childStores = createChildStores([])
    const deferredParent = createDeferred<{ data: boolean }>()
    const deferredChild = createDeferred<{ data: boolean }>()
    const deferredGrandchild = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["archived-parent", deferredParent],
      ["archived-child", deferredChild],
      ["archived-grandchild", deferredGrandchild],
    ])
    const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0))
    sessionDeleteHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const resultPromise = deleteSessions(["archived-parent"])
    await flushAsyncWork()

    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual(["archived-grandchild"])

    deferredGrandchild.resolve({ data: true })
    await flushAsyncWork()
    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual(["archived-grandchild", "archived-child"])

    deferredChild.resolve({ data: true })
    await flushAsyncWork()
    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual(["archived-grandchild", "archived-child", "archived-parent"])

    deferredParent.resolve({ data: true })
    expect(await resultPromise).toEqual({
      deletedIds: ["archived-parent", "archived-child", "archived-grandchild"],
      failedIds: [],
    })
  })

  test("deduplicates selected archived parent and child sessions before depth-ordered delete", async () => {
    const parent = {
      ...makeSession("archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const child = {
      ...makeSession("archived-child", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const grandchild = {
      ...makeSession("archived-grandchild", "archived-child"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [parent, child, grandchild]
    const childStores = createChildStores([])

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await deleteSessions(["archived-parent", "archived-child", "archived-parent"])).toEqual({
      deletedIds: ["archived-parent", "archived-child", "archived-grandchild"],
      failedIds: [],
    })

    expect(sessionDeleteCalls.map((params) => params.sessionID)).toEqual([
      "archived-grandchild",
      "archived-child",
      "archived-parent",
    ])
  })

  test("deletes same-depth archived siblings before starting their ancestor delete", async () => {
    const parent = {
      ...makeSession("archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const childA = {
      ...makeSession("archived-child-a", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const childB = {
      ...makeSession("archived-child-b", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [parent, childA, childB]
    const childStores = createChildStores([])
    const deferredParent = createDeferred<{ data: boolean }>()
    const deferredChildA = createDeferred<{ data: boolean }>()
    const deferredChildB = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["archived-parent", deferredParent],
      ["archived-child-a", deferredChildA],
      ["archived-child-b", deferredChildB],
    ])
    const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0))
    sessionDeleteHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const resultPromise = deleteSessions(["archived-parent"])
    await flushAsyncWork()

    expect(sessionDeleteCalls.map((params) => params.sessionID).sort()).toEqual(["archived-child-a", "archived-child-b"])

    deferredChildA.resolve({ data: true })
    await flushAsyncWork()
    expect(sessionDeleteCalls.map((params) => params.sessionID).sort()).toEqual(["archived-child-a", "archived-child-b"])

    deferredChildB.resolve({ data: true })
    await flushAsyncWork()
    expect(sessionDeleteCalls.map((params) => params.sessionID)).toContain("archived-parent")

    deferredParent.resolve({ data: true })
    expect(await resultPromise).toEqual({
      deletedIds: ["archived-parent", "archived-child-a", "archived-child-b"],
      failedIds: [],
    })
  })

  test("removes archived parent and descendants from global archived snapshot while delete is pending", async () => {
    const parent = {
      ...makeSession("archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    const child = {
      ...makeSession("archived-child", "archived-parent"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [parent, child]
    const childStores = createChildStores([])
    const deferredParent = createDeferred<{ data: boolean }>()
    const deferredChild = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["archived-parent", deferredParent],
      ["archived-child", deferredChild],
    ])
    sessionDeleteHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const resultPromise = deleteSessions(["archived-parent"])
    await Promise.resolve()

    expect(mockGlobalArchivedSessions.map((session) => session.id)).toEqual([])
    expect(globalRemoveCalls[0].ids).toEqual(["archived-parent", "archived-child"])

    deferredParent.resolve({ data: true })
    deferredChild.resolve({ data: true })

    expect(await resultPromise).toEqual({
      deletedIds: ["archived-parent", "archived-child"],
      failedIds: [],
    })
  })

  test("removes successfully deleted archived sessions again after stale global refresh rehydrates them", async () => {
    const archivedA = {
      ...makeSession("archived-a"),
      directory: "/archived/project",
    } as unknown as Session
    const archivedB = {
      ...makeSession("archived-b"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [archivedA, archivedB]
    const childStores = createChildStores([])
    const deferredA = createDeferred<{ data: boolean }>()
    const deferredB = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      ["archived-a", deferredA],
      ["archived-b", deferredB],
    ])
    sessionDeleteHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const resultPromise = deleteSessions(["archived-a", "archived-b"])
    await Promise.resolve()

    expect(mockGlobalArchivedSessions.map((session) => session.id)).toEqual([])

    mockGlobalArchivedSessions = [archivedA, archivedB]

    deferredA.resolve({ data: true })
    deferredB.resolve({ data: true })

    expect(await resultPromise).toEqual({
      deletedIds: ["archived-a", "archived-b"],
      failedIds: [],
    })
    expect(mockGlobalArchivedSessions.map((session) => session.id)).toEqual([])
    expect(globalRemoveCalls.map((call) => call.ids)).toEqual([
      ["archived-a", "archived-b"],
      ["archived-a", "archived-b"],
    ])
  })

  test("restores an optimistically removed archived session when delete fails", async () => {
    const archived = {
      ...makeSession("archived-session"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [archived]
    const store = createStore({}, [archived])
    const childStores = createChildStores([["/archived/project", store]])
    sessionDeleteHandler = () => Promise.reject(new Error("delete failed"))

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await withMutedConsoleError(() => deleteSessions(["archived-session"]))).toEqual({
      deletedIds: [],
      failedIds: ["archived-session"],
    })

    expect(sessionDeleteCalls).toEqual([
      { sessionID: "archived-session", directory: "/archived/project" },
    ])
    expect(store.getState().session.map((session) => session.id)).toEqual(["archived-session"])
    expect(globalRemoveCalls).toEqual([{ ids: ["archived-session"] }])
    expect(globalRestoreCalls[0].ids).toEqual(["archived-session"])
  })
})

describe("revertToMessage scoped revert", () => {
  beforeEach(() => {
    scopedRevertCalls.length = 0
    restoredAttachmentCalls.length = 0
    inputStoreState = {}
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDirectories["session-a"] = "/test/project"
    sessionDirectories["session-b"] = "/other/project"
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve({
      id: sessionId,
      title: sessionId,
      time: { created: 1, updated: 2 },
      revert: { messageID: messageId },
    } as unknown as Session)
  })

  test("calls the OpenChamber scoped revert endpoint with session, message, and directory", async () => {
    const session = makeSession("session-a")
    const before = { id: "msg_10", sessionID: "session-a", role: "assistant", time: { created: 1 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before, target, after] },
      part: { "msg_10": [], "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project" },
    ])
    expect(store.getState().session[0]?.revert).toEqual({ messageID: "msg_2" })
    expect(store.getState().message["session-a"]).toEqual([before])
  })

  test("restores clicked user message text into input while hiding reverted messages", async () => {
    const session = makeSession("session-a")
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before, target, after] },
      part: {
        "msg_1": [{ type: "text", text: "previous prompt" } as unknown as import("@opencode-ai/sdk/v2/client").Part],
        "msg_2": [
          { type: "text", text: "restore this prompt" } as unknown as import("@opencode-ai/sdk/v2/client").Part,
          { type: "text", text: "server synthetic context", synthetic: true } as unknown as import("@opencode-ai/sdk/v2/client").Part,
        ],
        "msg_3": [],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(store.getState().message["session-a"]).toEqual([before])
    expect(inputStoreState.pendingInputText).toBe("restore this prompt")
    expect(inputStoreState.pendingInputMode).toBe("replace")
    expect(inputStoreState).toEqual({
      pendingInputText: "restore this prompt",
      pendingInputMode: "replace",
      attachedFiles: [],
    })
  })

  test("restores non-synthetic file attachments from reverted user messages", async () => {
    const session = makeSession("session-a")
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before, target] },
      part: {
        "msg_1": [],
        "msg_2": [
          { type: "text", text: "restore this prompt" } as unknown as import("@opencode-ai/sdk/v2/client").Part,
          { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "image.png" } as unknown as import("@opencode-ai/sdk/v2/client").Part,
          { type: "file", mime: "text/plain", url: "file:///tmp/context.txt", filename: "context.txt", synthetic: true } as unknown as import("@opencode-ai/sdk/v2/client").Part,
        ],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(restoredAttachmentCalls).toEqual([
      { url: "data:image/png;base64,aGVsbG8=", mimeType: "image/png", filename: "image.png" },
    ])
    expect(inputStoreState.attachedFiles).toEqual(restoredAttachmentCalls)
  })

  test("uses the clicked session directory instead of the current directory", async () => {
    sessionDirectories["session-a"] = "/other/project"
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const currentStore = createStore({}, [])
    const sessionStore = createStore({}, [session])
    sessionStore.setState({
      message: { "session-a": [target] },
      part: { "msg_2": [] },
    })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/other/project" },
    ])
    expect(sessionStore.getState().session[0]?.revert).toEqual({ messageID: "msg_2" })
    expect(currentStore.getState().session).toEqual([])
  })

  test("allows revert in one session while another session in the same directory is actively editing", async () => {
    sessionDirectories["session-b"] = "/test/project"
    sessionAbortCalls.length = 0
    const session = makeSession("session-a")
    const otherSession = makeSession("session-b")
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const otherMessage = { id: "msg_10", sessionID: "session-b", role: "user", time: { created: 1 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session, otherSession])
    store.setState({
      session_status: { "session-b": { type: "busy" } as SessionStatus },
      message: {
        "session-a": [before, target, after],
        "session-b": [otherMessage],
      },
      part: { "msg_1": [], "msg_2": [], "msg_3": [], "msg_10": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project" },
    ])
    expect(store.getState().message["session-a"]).toEqual([before])
    expect(store.getState().session[0]?.revert).toEqual({ messageID: "msg_2" })
    expect(store.getState().message["session-b"]).toEqual([otherMessage])
    expect(store.getState().session_status["session-b"]).toEqual({ type: "busy" })
    expect(sessionAbortCalls.filter((call) => call.sessionID === "session-b")).toEqual([])
  })

  test("allows revert when active sessions are in other directories", async () => {
    sessionDirectories["session-b"] = "/other/project"
    const session = makeSession("session-a")
    const otherSession = makeSession("session-b")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const currentStore = createStore({}, [session])
    currentStore.setState({
      message: { "session-a": [target] },
      part: { "msg_2": [] },
    })
    const otherStore = createStore({}, [otherSession])
    otherStore.setState({
      session_status: { "session-b": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", otherStore],
    ])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project" },
    ])
  })

  test("rolls back optimistic message removal when scoped revert fails", async () => {
    scopedRevertHandler = () => Promise.reject(new Error("safe revert conflict"))
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target, after] },
      part: { "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("safe revert conflict")
    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project" },
    ])
    expect(store.getState().message["session-a"]).toEqual([target, after])
    expect(store.getState().session[0]?.revert).toBe(undefined)
  })

  test("does not restore reverted input when scoped revert fails", async () => {
    scopedRevertHandler = () => Promise.reject(new Error("safe revert conflict"))
    inputStoreState = {
      pendingInputText: "existing draft",
      pendingInputMode: "replace",
      attachedFiles: [{ filename: "existing.txt" }],
    }
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target, after] },
      part: {
        "msg_2": [
          { type: "text", text: "do not restore on failure" } as unknown as import("@opencode-ai/sdk/v2/client").Part,
          { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "image.png" } as unknown as import("@opencode-ai/sdk/v2/client").Part,
        ],
        "msg_3": [],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("safe revert conflict")
    expect(inputStoreState).toEqual({
      pendingInputText: "existing draft",
      pendingInputMode: "replace",
      attachedFiles: [{ filename: "existing.txt" }],
    })
    expect(restoredAttachmentCalls).toEqual([])
  })

  test("ignores duplicate revert requests while a transaction is pending", async () => {
    const deferred = createDeferred<Session>()
    scopedRevertHandler = (sessionId, messageId) => deferred.promise.then(() => ({
      id: sessionId,
      title: sessionId,
      time: { created: 1, updated: 2 },
      revert: { messageID: messageId },
    } as unknown as Session))
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as import("@opencode-ai/sdk/v2/client").Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target, after] },
      part: { "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const first = revertToMessage("session-a", "msg_2")
    await revertToMessage("session-a", "msg_2")

    expect(scopedRevertCalls).toEqual([
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project" },
    ])
    expect(store.getState().message["session-a"]).toEqual([])

    deferred.resolve(session)
    await first
  })

  test("clears confirmed revert state before optimistic resend so the new message is visible", async () => {
    const session = {
      ...makeSession("session-a"),
      revert: { messageID: "msg_2" },
    } as Session
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before] },
      part: { "msg_1": [] },
      revert_transaction: {
        "session-a": {
          messageID: "msg_2",
          hiddenMessageIDs: ["msg_2", "msg_3"],
          version: 1,
          status: "confirmed",
          startedAt: 1,
          serverAcknowledged: true,
        },
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, setOptimisticRefs, optimisticSend } = await import("./session-actions")
    const { applyOptimisticAdd, applyOptimisticRemove } = await import("./optimistic")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs(
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticAdd(draft, input)
        return draft
      }),
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticRemove(draft, input)
        return draft
      }),
    )

    await optimisticSend({
      sessionId: "session-a",
      content: "edited prompt",
      providerID: "provider",
      modelID: "model",
      directory: "/test/project",
      send: () => Promise.resolve(),
    })

    expect((store.getState().session[0] as Session & { revert?: unknown })?.revert).toBe(undefined)
    expect(store.getState().revert_transaction["session-a"]).toBe(undefined)
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toHaveLength(2)
    expect(store.getState().message["session-a"]?.at(-1)?.role).toBe("user")
    expect(store.getState().message["session-a"]?.at(-1)?.id.startsWith("msg_")).toBe(true)
  })

  test("adds and rolls back a deterministic Cursor assistant placeholder with the optimistic user message", async () => {
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      message: { "session-a": [before] },
      part: { "msg_1": [] },
    })
    const childStores = createChildStores([["/test/project", store]])
    let optimisticMessageId = ""
    let messagesDuringSend: Message[] = []
    let partsDuringSend: Record<string, Part[]> = {}

    const { setActionRefs, setOptimisticRefs, optimisticSend } = await import("./session-actions")
    const { applyOptimisticAdd, applyOptimisticRemove } = await import("./optimistic")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs(
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticAdd(draft, input)
        return draft
      }),
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticRemove(draft, input)
        return draft
      }),
    )

    let thrown: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-a",
        content: "cursor prompt",
        providerID: "cursor-acp",
        modelID: "composer-2.5",
        directory: "/test/project",
        includeAssistantPlaceholder: true,
        send: (messageID) => {
          optimisticMessageId = messageID
          messagesDuringSend = [...(store.getState().message["session-a"] ?? [])]
          partsDuringSend = { ...store.getState().part }
          return Promise.reject(new Error("send failed"))
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("send failed")
    expect(messagesDuringSend.map((message) => message.id)).toEqual([
      "msg_1",
      optimisticMessageId,
      `${optimisticMessageId}_assistant`,
    ])
    expect(messagesDuringSend.at(-1)?.role).toBe("assistant")
    expect(partsDuringSend[`${optimisticMessageId}_assistant`]).toEqual([])
    expect(store.getState().message["session-a"]).toEqual([before])
    expect(store.getState().part[`${optimisticMessageId}_assistant`]).toBe(undefined)
  })

  test("ignores stale reverted session snapshots while optimistic resend is in flight", async () => {
    const session = {
      ...makeSession("session-a"),
      revert: { messageID: "msg_2" },
    } as Session
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const previousTransaction = {
      messageID: "msg_2",
      hiddenMessageIDs: ["msg_2", "msg_3"],
      version: 1,
      status: "confirmed" as const,
      startedAt: 1,
      serverAcknowledged: true,
    }
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before] },
      part: { "msg_1": [] },
      revert_transaction: { "session-a": previousTransaction },
    })
    const childStores = createChildStores([["/test/project", store]])
    let optimisticMessageId: string | undefined

    const { setActionRefs, setOptimisticRefs, optimisticSend } = await import("./session-actions")
    const { applyOptimisticAdd, applyOptimisticRemove } = await import("./optimistic")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs(
      (input) => {
        optimisticMessageId = input.message.id
        store.setState((state) => {
          const draft = { message: { ...state.message }, part: { ...state.part } }
          applyOptimisticAdd(draft, input)
          return draft
        })
      },
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticRemove(draft, input)
        return draft
      }),
    )

    await optimisticSend({
      sessionId: "session-a",
      content: "edited prompt",
      providerID: "provider",
      modelID: "model",
      directory: "/test/project",
      send: () => {
        store.setState((state) => {
          const draft = {
            ...state,
            session: [...state.session],
            message: { ...state.message },
            part: { ...state.part },
            session_user_activity: { ...state.session_user_activity },
          }
          applyDirectoryEvent(draft, {
            type: "session.updated",
            properties: {
              info: {
                ...makeSession("session-a"),
                time: { created: 1, updated: 3 },
                revert: { messageID: "msg_2" },
              },
            },
          } as never)
          return draft
        })
        return Promise.resolve()
      },
    })

    expect((store.getState().session[0] as Session & { revert?: unknown })?.revert).toBe(undefined)
    expect(store.getState().revert_transaction["session-a"]).toBe(undefined)
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual([
      "msg_1",
      optimisticMessageId,
    ])
  })

  test("restores revert state when optimistic resend fails after clearing the boundary", async () => {
    const session = {
      ...makeSession("session-a"),
      revert: { messageID: "msg_2" },
    } as Session
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const previousTransaction = {
      messageID: "msg_2",
      hiddenMessageIDs: ["msg_2", "msg_3"],
      version: 1,
      status: "confirmed" as const,
      startedAt: 1,
      serverAcknowledged: true,
    }
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before] },
      part: { "msg_1": [] },
      revert_transaction: { "session-a": previousTransaction },
    })
    const childStores = createChildStores([["/test/project", store]])
    let revertDuringSend: unknown = null
    let transactionDuringSend: unknown = null

    const { setActionRefs, setOptimisticRefs, optimisticSend } = await import("./session-actions")
    const { applyOptimisticAdd, applyOptimisticRemove } = await import("./optimistic")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    setOptimisticRefs(
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticAdd(draft, input)
        return draft
      }),
      (input) => store.setState((state) => {
        const draft = { message: { ...state.message }, part: { ...state.part } }
        applyOptimisticRemove(draft, input)
        return draft
      }),
    )

    let thrown: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-a",
        content: "edited prompt",
        providerID: "provider",
        modelID: "model",
        directory: "/test/project",
        send: () => {
          revertDuringSend = (store.getState().session[0] as Session & { revert?: unknown })?.revert
          transactionDuringSend = store.getState().revert_transaction["session-a"]
          return Promise.reject(new Error("send failed"))
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("send failed")
    expect(revertDuringSend).toBe(undefined)
    expect(transactionDuringSend).toBe(undefined)
    expect((store.getState().session[0] as Session & { revert?: unknown })?.revert).toEqual({ messageID: "msg_2" })
    expect(store.getState().revert_transaction["session-a"]).toEqual(previousTransaction)
    expect(store.getState().message["session-a"]).toEqual([before])
  })
})

describe("session actions use target session directory", () => {
  beforeEach(() => {
    sessionAbortCalls.length = 0
    sessionMessageCalls.length = 0
    sessionUnrevertCalls.length = 0
    sessionForkCalls.length = 0
    setCurrentSessionCalls.length = 0
    restoredAttachmentCalls.length = 0
    inputStoreState = {}
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDirectories["session-b"] = "/other/project"
    sessionMessagesHandler = () => Promise.resolve({ data: [] })
    sessionUnrevertHandler = (params) => Promise.resolve({ data: makeSession(String(params.sessionID)) })
    sessionForkHandler = () => Promise.resolve({ data: makeSession("forked-session") })
  })

  test("unreverts using the target session directory instead of the current directory", async () => {
    const session = makeSession("session-b")
    const currentStore = createStore({}, [])
    const sessionStore = createStore({}, [session])
    sessionStore.setState({
      session_status: { "session-b": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])

    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await unrevertSession("session-b")

    expect(sessionAbortCalls).toEqual([
      { sessionID: "session-b", directory: "/other/project" },
    ])
    expect(sessionUnrevertCalls).toEqual([
      { sessionID: "session-b", directory: "/other/project" },
    ])
    expect(sessionMessageCalls).toEqual([
      { sessionID: "session-b", directory: "/other/project", limit: 200 },
    ])
    expect(currentStore.getState().session).toEqual([])
  })

  test("forks using the target session directory instead of the current directory", async () => {
    const session = makeSession("session-b")
    const sourceMessage = { id: "msg_1", sessionID: "session-b", role: "user", time: { created: 1 } } as unknown as Message
    const currentStore = createStore({}, [])
    const sessionStore = createStore({}, [session])
    sessionStore.setState({
      message: { "session-b": [sourceMessage] },
      part: { "msg_1": [{ type: "text", text: "source prompt" } as unknown as Part] },
    })
    sessionForkHandler = () => Promise.resolve({ data: makeSession("forked-session") })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])

    const { setActionRefs, forkFromMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await forkFromMessage("session-b", "msg_1")

    expect(sessionForkCalls).toEqual([
      { sessionID: "session-b", directory: "/other/project", messageID: "msg_1" },
    ])
    expect(sessionStore.getState().session.map((item) => item.id).sort()).toEqual(["forked-session", "session-b"])
    expect(currentStore.getState().session).toEqual([])
    expect(inputStoreState.pendingInputText).toBe("source prompt")
  })

  test("restores non-synthetic file attachments from forked user messages", async () => {
    const session = makeSession("session-b")
    const sourceMessage = { id: "msg_1", sessionID: "session-b", role: "user", time: { created: 1 } } as unknown as Message
    const currentStore = createStore({}, [])
    const sessionStore = createStore({}, [session])
    sessionStore.setState({
      message: { "session-b": [sourceMessage] },
      part: {
        "msg_1": [
          { type: "text", text: "source prompt" } as unknown as Part,
          { type: "file", mime: "text/markdown", url: "data:text/markdown;base64,IyBIaQ==", filename: "notes.md" } as unknown as Part,
          { type: "file", mime: "text/plain", url: "file:///tmp/synthetic.txt", filename: "synthetic.txt", synthetic: true } as unknown as Part,
        ],
      },
    })
    sessionForkHandler = () => Promise.resolve({ data: makeSession("forked-session") })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])

    const { setActionRefs, forkFromMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await forkFromMessage("session-b", "msg_1")

    expect(restoredAttachmentCalls).toEqual([
      { url: "data:text/markdown;base64,IyBIaQ==", mimeType: "text/markdown", filename: "notes.md" },
    ])
    expect(inputStoreState.attachedFiles).toEqual(restoredAttachmentCalls)
  })
})

describe("respondToPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    sessionDirectories["session-a"] = "/test/project"
    sessionDirectories["session-b"] = "/other/project"
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("respondToQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory to question.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-1", [["answer1"]])

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory to question.reject", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("revertToMessage recovery behavior", () => {
  beforeEach(() => {
    sessionAbortCalls.length = 0
    sessionMessageCalls.length = 0
    scopedRevertCalls.length = 0
    clearSessionTurnCompletionCalls.length = 0
    mockSessionAbortFlags = new Map()
    mockAbortControllers = new Map()
    mockSessionCompletionIndicator = new Map()
    mockPendingCompletionIndicatorSessions = new Set()
    sessionDirectories["session-a"] = "/test/project"
    sessionAbortHandler = () => Promise.resolve({ data: true })
    sessionMessagesHandler = () => Promise.resolve({ data: [] })
  })

  test("records manual aborts after sdk success and correlates them to the latest assistant message", async () => {
    const userMessage = {
      id: "msg-user",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as unknown as Message
    const assistantMessage = {
      id: "msg-assistant",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 2 },
    } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      message: { "session-a": [userMessage, assistantMessage] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await abortCurrentOperation("session-a")

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    const abortFlag = mockSessionAbortFlags.get("session-a")
    expect(abortFlag?.id).toBe("msg-assistant")
    expect(abortFlag?.reason).toBe("manual")
    expect(abortFlag?.acknowledged).toBe(false)
    expect(typeof abortFlag?.timestamp).toBe("number")
  })

  test("does not record a manual abort flag when sdk abort fails", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await withMutedConsoleError(() => abortCurrentOperation("session-a"))

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
  })

  test("clears existing completion indicators after sdk abort succeeds", async () => {
    mockSessionCompletionIndicator = new Map([
      ["session-a", { messageId: "msg-assistant", completedAt: 123 }],
    ])
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await abortCurrentOperation("session-a")

    expect(clearSessionTurnCompletionCalls).toEqual(["session-a"])
    expect(mockSessionCompletionIndicator.has("session-a")).toBe(false)
  })

  test("cancels pending delayed completion indicators after sdk abort succeeds", async () => {
    mockPendingCompletionIndicatorSessions = new Set(["session-a"])
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await abortCurrentOperation("session-a")

    expect(clearSessionTurnCompletionCalls).toEqual(["session-a"])
    expect(mockPendingCompletionIndicatorSessions.has("session-a")).toBe(false)
  })

  test("does not clear completion indicators when sdk abort fails", async () => {
    mockSessionCompletionIndicator = new Map([
      ["session-a", { messageId: "msg-assistant", completedAt: 123 }],
    ])
    mockPendingCompletionIndicatorSessions = new Set(["session-a"])
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await withMutedConsoleError(() => abortCurrentOperation("session-a"))

    expect(clearSessionTurnCompletionCalls).toEqual([])
    expect(mockSessionCompletionIndicator.has("session-a")).toBe(true)
    expect(mockPendingCompletionIndicatorSessions.has("session-a")).toBe(true)
  })

  test("abortCurrentOperation cancels pending local sends before sdk abort", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const controller = new AbortController()
    mockAbortControllers.set("session-a", controller)

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await abortCurrentOperation("session-a")

    expect(controller.signal.aborted).toBe(true)
    expect(mockAbortControllers.has("session-a")).toBe(false)
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
  })

  test("abortCurrentOperation silently cascades cancellation through active managed subtasks", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const cancelCalls: Array<{ taskId: string; options?: { cascade?: boolean; reason?: string } }> = []
    const orchestrationState = useManagedOrchestrationStore.getState()
    useManagedOrchestrationStore.setState({
      tasksById: {
        "task-root": { taskId: "task-root", rootSessionId: "session-a", parentTaskId: null, status: "running" } as never,
        "task-child": { taskId: "task-child", rootSessionId: "session-a", parentTaskId: "task-root", status: "running" } as never,
        "task-queued": { taskId: "task-queued", rootSessionId: "session-a", parentTaskId: null, status: "queued" } as never,
        "task-done": { taskId: "task-done", rootSessionId: "session-a", parentTaskId: null, status: "completed" } as never,
      },
      taskIdsByRootId: {
        "session-a": ["task-root", "task-child", "task-queued", "task-done"],
      },
      cancelTask: mock(async (taskId, options) => {
        cancelCalls.push({ taskId, options })
      }),
    })

    try {
      const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
      setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

      await abortCurrentOperation("session-a")

      expect(cancelCalls).toEqual([
        { taskId: "task-root", options: { cascade: true, reason: "Parent session stopped" } },
        { taskId: "task-queued", options: { cascade: true, reason: "Parent session stopped" } },
      ])
      expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    } finally {
      useManagedOrchestrationStore.setState(orchestrationState)
    }
  })

  test("abortCurrentOperation clears pending local sends even when sdk abort fails", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const controller = new AbortController()
    mockAbortControllers.set("session-a", controller)
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await withMutedConsoleError(() => abortCurrentOperation("session-a"))

    expect(controller.signal.aborted).toBe(true)
    expect(mockAbortControllers.has("session-a")).toBe(false)
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
  })

  test("queued-send interrupt aborts the target session in its own directory", async () => {
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      session_status: { "session-a": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { interruptCurrentOperationForQueuedSend, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/other/current")

    await interruptCurrentOperationForQueuedSend("session-a")

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
  })

  test("queued-send interrupt records manual aborts after sdk success", async () => {
    const userMessage = {
      id: "msg-user",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as unknown as Message
    const assistantMessage = {
      id: "msg-assistant",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 2 },
    } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      message: { "session-a": [userMessage, assistantMessage] },
      session_status: { "session-a": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { interruptCurrentOperationForQueuedSend, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await interruptCurrentOperationForQueuedSend("session-a")

    const abortFlag = mockSessionAbortFlags.get("session-a")
    expect(abortFlag?.id).toBe("msg-assistant")
    expect(abortFlag?.reason).toBe("manual")
    expect(abortFlag?.acknowledged).toBe(false)
    expect(typeof abortFlag?.timestamp).toBe("number")
  })

  test("steered-send interrupt records steered aborts after sdk success", async () => {
    const userMessage = {
      id: "msg-user",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as unknown as Message
    const assistantMessage = {
      id: "msg-assistant",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 2 },
    } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      message: { "session-a": [userMessage, assistantMessage] },
      session_status: { "session-a": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { interruptCurrentOperationForSteeredSend, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/other/current")

    await interruptCurrentOperationForSteeredSend("session-a")

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    const abortFlag = mockSessionAbortFlags.get("session-a")
    expect(abortFlag?.id).toBe("msg-assistant")
    expect(abortFlag?.reason).toBe("steered")
    expect(abortFlag?.acknowledged).toBe(false)
    expect(typeof abortFlag?.timestamp).toBe("number")
  })

  test("queued-send interrupt rejects when sdk abort fails", async () => {
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      session_status: { "session-a": { type: "busy" } as SessionStatus },
    })
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { interruptCurrentOperationForQueuedSend, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await interruptCurrentOperationForQueuedSend("session-a")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("abort failed")
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
  })

  test("coalesces unexpected abort reconciliation per session while a refetch is in flight", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const refetch = createDeferred<{ data: [] }>()
    sessionMessagesHandler = () => refetch.promise

    const { reconcileUnexpectedAbort, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const first = reconcileUnexpectedAbort("session-a")
    const second = reconcileUnexpectedAbort("session-a")

    expect(sessionMessageCalls).toEqual([{ sessionID: "session-a", directory: "/test/project", limit: 200 }])

    refetch.resolve({ data: [] })
    await Promise.all([first, second])
  })

  test("releases unexpected-abort reconciliation ownership for a disposed directory", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const firstRefetch = createDeferred<{ data: [] }>()
    const secondRefetch = createDeferred<{ data: [] }>()
    sessionMessagesHandler = () => sessionMessageCalls.length === 1
      ? firstRefetch.promise
      : secondRefetch.promise

    const {
      reconcileUnexpectedAbort,
      releaseSessionActionDirectory,
      setActionRefs,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const first = reconcileUnexpectedAbort("session-a")
    releaseSessionActionDirectory("/test/project")
    const second = reconcileUnexpectedAbort("session-a")

    expect(first).not.toBe(second)
    expect(sessionMessageCalls).toHaveLength(2)
    firstRefetch.resolve({ data: [] })
    secondRefetch.resolve({ data: [] })
    await Promise.all([first, second])
  })

  test("rejects missing message ids before calling scoped revert", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("messageID is required")
    expect(scopedRevertCalls).toEqual([])
  })

  test("refetches messages after aborting when scoped revert fails", async () => {
    const userMessage = {
      id: "msg-user",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as unknown as Message
    const assistantMessage = {
      id: "msg-assistant",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 2 },
    } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      session_status: { "session-a": { type: "busy" } as SessionStatus },
      message: { "session-a": [userMessage, assistantMessage] },
      part: {
        "msg-user": [{ id: "part-user", type: "text", text: "hello" } as unknown as Part],
        "msg-assistant": [{ id: "part-assistant", type: "text", text: "working" } as unknown as Part],
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    scopedRevertHandler = () => Promise.reject(new Error("server rejected revert"))
    sessionMessagesHandler = () => Promise.resolve({
      data: [
        {
          info: {
            ...userMessage,
            time: { created: 1, completed: 1 },
          },
          parts: [{ id: "part-user", type: "text", text: "hello" }],
        },
      ],
    })

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "msg-user")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("server rejected revert")

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(store.getState().session_status["session-a"]).toEqual({ type: "idle" })
    expect(sessionMessageCalls).toEqual([{ sessionID: "session-a", directory: "/test/project", limit: 200 }])
  })
})
