import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2/client"
import type {
  ScopedSessionRevertResult,
  ScopedSessionUnrevertResult,
  SessionTreeChanges,
} from "@/lib/opencode/client"
import { applyDirectoryEvent } from "./event-reducer"
import { createLatestUserChoiceSelector } from "./subtask-agent"
import { useManagedOrchestrationStore } from "@/stores/useManagedOrchestrationStore"
import { ABORT_GUARD_TTL_MS, isAbortGuardActive, resetAbortGuardState } from "./abort-retry-guard"

const actualOpencodeClientModule = await import("@/lib/opencode/client")
const actualSyncRefsModule = await import("./sync-refs")
const bunTestHooks = (await import("bun:test")) as unknown as {
  afterAll: (callback: () => void) => void
}

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const sessionCreateCalls: Array<Record<string, unknown>> = []
const sessionUpdateCalls: Array<Record<string, unknown>> = []
const sessionDeleteCalls: Array<Record<string, unknown>> = []
const sessionUpdateOptions: Array<{ throwOnError?: boolean } | undefined> = []
const sessionDeleteOptions: Array<{ throwOnError?: boolean } | undefined> = []
const sessionAbortCalls: Array<Record<string, unknown>> = []
const sessionMessageCalls: Array<Record<string, unknown>> = []
const sessionUnrevertCalls: Array<Record<string, unknown>> = []
const sessionForkCalls: Array<Record<string, unknown>> = []
type ScopedRevertOptions = { scope?: "tree" | "session"; rootSessionId?: string }
const scopedRevertCalls: Array<{ sessionId: string; messageId: string; directory?: string; options?: ScopedRevertOptions }> = []
const scopedUnrevertCalls: Array<{ sessionId: string; directory?: string }> = []
const treeChangesCalls: Array<{ sessionId: string; directory?: string }> = []
const toastCalls: Array<{ kind: string; message: string }> = []
const registeredSessionDirectories: Array<{ sessionId: string; directory: string }> = []
let sessionCreateHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: makeSession("created-session") })
let sessionUpdateHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionDeleteHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionAbortHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: true })
let sessionMessagesHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: [] })
let sessionUnrevertHandler: (params: Record<string, unknown>) => Promise<unknown> = (params) => Promise.resolve({ data: makeSession(String(params.sessionID)) })
let sessionForkHandler: (params: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve({ data: makeSession("forked-session") })
let scopedRevertHandler: (
  sessionId: string,
  messageId: string,
  directory?: string,
  options?: ScopedRevertOptions,
) => Promise<ScopedSessionRevertResult> = (sessionId, messageId) => Promise.resolve(makeScopedRevertResult(sessionId, messageId))
let scopedUnrevertHandler: (sessionId: string, directory?: string) => Promise<ScopedSessionUnrevertResult> = (sessionId) => Promise.resolve({
  session: makeSession(sessionId),
  restored: [],
})
let treeChangesHandler: (sessionId: string, directory?: string) => Promise<SessionTreeChanges> = () => Promise.resolve(makeTreeChanges())
const restoredAttachmentCalls: Array<{ url: string; mimeType: string; filename: string }> = []

const setCurrentSessionCalls: Array<{ id: string | null; directory?: string | null }> = []
let mockCurrentSessionId: string | null = null
let mockSessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }> = new Map()
let mockAbortControllers: Map<string, AbortController> = new Map()
const clearSessionTurnCompletionCalls: string[] = []
const clearSessionStoppingCalls: string[] = []
let mockSessionCompletionIndicator: Map<string, { messageId: string; completedAt: number }> = new Map()
let mockPendingCompletionIndicatorSessions: Set<string> = new Set()
const sessionDirectories: Record<string, string | null> = {
  "session-a": "/test/project",
  "session-b": "/other/project",
}
let inputStoreState: Record<string, unknown> = {}
const mockComposerRevisions = new Map<string, number>()

const globalArchiveCalls: Array<{ ids: string[]; archivedAt?: number }> = []
const globalRemoveCalls: Array<{ ids: string[] }> = []
const globalUnarchiveCalls: Array<{ ids: string[] }> = []
const globalRestoreCalls: Array<{ ids: string[] }> = []
const globalArchiveSnapshotCalls: Array<{ ids: string[]; archivedAt: number }> = []
const globalUpsertCalls: Session[] = []
const membershipBeginCalls: Array<Record<string, unknown>> = []
const membershipSettleCalls: Array<{
  entries: Array<{ sessionID: string; version: number }>
  result: { successfulIds: string[]; failedIds: string[] }
}> = []
let postMutationRefreshCalls = 0
let nextMembershipMutationVersion = 0
let mockGlobalActiveSessions: Session[] = []
let mockGlobalArchivedSessions: Session[] = []
let mockConfigStoreState: Record<string, unknown> = {}

const applyThrowOnErrorOption = async (
  resultPromise: Promise<unknown>,
  options?: { throwOnError?: boolean },
): Promise<unknown> => {
  const result = await resultPromise
  if (
    options?.throwOnError
    && result
    && typeof result === "object"
    && "error" in result
    && (result as { error?: unknown }).error
  ) {
    throw (result as { error: unknown }).error
  }
  return result
}

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
    update: mock((params: Record<string, unknown>, options?: { throwOnError?: boolean }) => {
      sessionUpdateCalls.push(params)
      sessionUpdateOptions.push(options)
      return applyThrowOnErrorOption(sessionUpdateHandler(params), options)
    }),
    delete: mock((params: Record<string, unknown>, options?: { throwOnError?: boolean }) => {
      sessionDeleteCalls.push(params)
      sessionDeleteOptions.push(options)
      return applyThrowOnErrorOption(sessionDeleteHandler(params), options)
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

// Keep the real singleton prototype so this process-wide Bun mock remains a
// complete module when another chat-flow suite imports it later.
const sessionActionsOpencodeClient = Object.assign(
  Object.create(actualOpencodeClientModule.opencodeClient) as typeof actualOpencodeClientModule.opencodeClient,
  {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getScopedSdkClient: (_: string) => mockScopedClient,
    getDirectory: () => "/test/project",
    revertSessionScoped: (sessionId: string, messageId: string, directory?: string, options?: ScopedRevertOptions) => {
      scopedRevertCalls.push({ sessionId, messageId, directory, options })
      return scopedRevertHandler(sessionId, messageId, directory, options)
    },
    unrevertSessionScoped: (sessionId: string, directory?: string) => {
      scopedUnrevertCalls.push({ sessionId, directory })
      return scopedUnrevertHandler(sessionId, directory)
    },
    getSessionTreeChanges: (sessionId: string, directory?: string) => {
      treeChangesCalls.push({ sessionId, directory })
      return treeChangesHandler(sessionId, directory)
    },
  },
)

mock.module("@/lib/opencode/client", () => ({
  ...actualOpencodeClientModule,
  opencodeClient: sessionActionsOpencodeClient,
}))

// Record toasts instead of rendering them; the tree revert announces outcomes here.
const recordToast = (kind: string) => (message: unknown) => {
  toastCalls.push({ kind, message: String(message) })
}
mock.module("sonner", () => ({
  toast: Object.assign(recordToast("default"), {
    success: recordToast("success"),
    error: recordToast("error"),
    info: recordToast("info"),
    warning: recordToast("warning"),
    message: recordToast("message"),
    dismiss: () => {},
  }),
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

// Register the narrow UI-store surface session actions need without replacing
// the complete session-ui-store module for every later suite in this Bun process.
const sessionActionsSessionUIStore = {
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
    clearSessionStopping: (sessionId: string) => {
      clearSessionStoppingCalls.push(sessionId)
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
}

actualSyncRefsModule.setSessionUIStoreRef(
  sessionActionsSessionUIStore as unknown as Parameters<typeof actualSyncRefsModule.setSessionUIStoreRef>[0],
)

bunTestHooks.afterAll(() => {
  actualSyncRefsModule.clearSessionUIStoreRef(
    sessionActionsSessionUIStore as unknown as Parameters<typeof actualSyncRefsModule.clearSessionUIStoreRef>[0],
  )
})

// Mock useInputStore (imported but not used in permission functions)
mock.module("./input-store", () => ({
  getSessionComposerRevision: (sessionId: string) => mockComposerRevisions.get(sessionId) ?? 0,
  markSessionComposerEdited: (sessionId: string) => {
    const revision = (mockComposerRevisions.get(sessionId) ?? 0) + 1
    mockComposerRevisions.set(sessionId, revision)
    return revision
  },
  useInputStore: {
    setState: (partial: Record<string, unknown>) => {
      inputStoreState = { ...inputStoreState, ...partial }
    },
    getState: () => ({
      ...inputStoreState,
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
      removeAttachedFilesTarget: () => {
        inputStoreState = { ...inputStoreState, attachedFiles: [] }
      },
      replaceRestoredAttachmentsForTarget: (
        _targetKey: string,
        attachments: Array<{ url: string; mimeType: string; filename: string }>,
      ) => {
        restoredAttachmentCalls.push(...attachments)
        inputStoreState = { ...inputStoreState, attachedFiles: attachments }
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
      queueRestoredInput: (input: {
        sessionId: string
        text: string
        attachments: Array<{ url: string; mimeType: string; filename: string }>
        expectedComposerRevision: number
      }) => {
        const pendingRestoredInputs = new Map(
          (inputStoreState.pendingRestoredInputs as ReadonlyMap<string, typeof input> | undefined) ?? [],
        )
        pendingRestoredInputs.set(input.sessionId, input)
        inputStoreState = { ...inputStoreState, pendingRestoredInputs }
      },
      consumeRestoredInput: (sessionId: string, composerRevision: number) => {
        const pendingRestoredInputs = new Map(
          (inputStoreState.pendingRestoredInputs as ReadonlyMap<string, {
            sessionId: string
            text: string
            attachments: Array<{ url: string; mimeType: string; filename: string }>
            expectedComposerRevision: number
          }> | undefined) ?? [],
        )
        const pending = pendingRestoredInputs.get(sessionId) ?? null
        if (!pending) return null
        pendingRestoredInputs.delete(sessionId)
        inputStoreState = { ...inputStoreState, pendingRestoredInputs }
        return pending.expectedComposerRevision === composerRevision ? pending : null
      },
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => {
  const removeGlobalSessions = (ids: Iterable<string>) => {
    const idList = Array.from(ids)
    const idSet = new Set(idList)
    globalRemoveCalls.push({ ids: idList })
    mockGlobalActiveSessions = mockGlobalActiveSessions.filter((session) => !idSet.has(session.id))
    mockGlobalArchivedSessions = mockGlobalArchivedSessions.filter((session) => !idSet.has(session.id))
  }
  const restoreGlobalSessions = (sessions: Session[]) => {
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
  }
  const archiveGlobalSnapshots = (sessions: Session[], archivedAt: number) => {
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
  }

  return {
    beginGlobalSessionMembershipMutation: (input: {
      kind: "archive" | "delete" | "unarchive"
      sessionIds: string[]
      snapshots?: Session[]
      archivedAt?: number
    }) => {
      membershipBeginCalls.push(input as unknown as Record<string, unknown>)
      const entries = input.sessionIds.map((sessionID) => ({
        sessionID,
        version: ++nextMembershipMutationVersion,
      }))
      if (input.kind === "archive") {
        archiveGlobalSnapshots(input.snapshots ?? [], input.archivedAt ?? Date.now())
        const snapshotIds = new Set((input.snapshots ?? []).map((session) => session.id))
        removeGlobalSessions(input.sessionIds.filter((sessionID) => !snapshotIds.has(sessionID)))
      } else if (input.kind === "delete") {
        removeGlobalSessions(input.sessionIds)
      } else {
        restoreGlobalSessions((input.snapshots ?? []).map((session) => {
          const time = { ...session.time }
          delete time.archived
          return { ...session, time }
        }))
      }
      return { entries }
    },
    settleGlobalSessionMembershipMutation: (
      handle: { entries: Array<{ sessionID: string; version: number }> },
      result: { successfulIds: string[]; failedIds: string[] },
    ) => {
      membershipSettleCalls.push({ entries: handle.entries, result })
    },
    queueGlobalSessionsRefreshAfterMutation: () => {
      postMutationRefreshCalls += 1
      return Promise.resolve()
    },
    useGlobalSessionsStore: {
    getState: () => ({
      archiveSessions: (ids: Iterable<string>, archivedAt?: number) => {
        const idList = Array.from(ids)
        globalArchiveCalls.push({ ids: idList, archivedAt })
      },
      removeSessions: (ids: Iterable<string>) => {
        removeGlobalSessions(ids)
      },
      unarchiveSessions: (ids: Iterable<string>) => {
        globalUnarchiveCalls.push({ ids: Array.from(ids) })
      },
      restoreSessions: (sessions: Session[]) => {
        restoreGlobalSessions(sessions)
      },
      archiveSessionSnapshots: (sessions: Session[], archivedAt: number) => {
        archiveGlobalSnapshots(sessions, archivedAt)
      },
      upsertSession: (session: Session) => {
        globalUpsertCalls.push(session)
      },
      activeSessions: mockGlobalActiveSessions,
      archivedSessions: mockGlobalArchivedSessions,
    }),
    },
  }
})

// Mock sync-refs (imported but not used in permission functions)
mock.module("./sync-refs", () => ({
  ...actualSyncRefsModule,
  registerSessionDirectory: (sessionId: string, directory: string) => {
    registeredSessionDirectories.push({ sessionId, directory })
  },
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

function makeScopedRevertResult(
  sessionId: string,
  messageId: string,
  overrides: Partial<ScopedSessionRevertResult> = {},
): ScopedSessionRevertResult {
  return {
    session: {
      id: sessionId,
      title: sessionId,
      time: { created: 1, updated: 2 },
      revert: { messageID: messageId },
    } as unknown as Session,
    reverted: { files: [], sessions: [{ id: sessionId, targetMessageID: messageId }] },
    verification: { ok: true },
    redoAvailable: true,
    ...overrides,
  }
}

function makeTreeChanges(overrides: Partial<SessionTreeChanges> = {}): SessionTreeChanges {
  return {
    files: [],
    sessionCount: 1,
    hasUnattributedMutations: false,
    firstUserMessageID: null,
    rootSessionID: null,
    ...overrides,
  }
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
    registeredSessionDirectories.length = 0
    setCurrentSessionCalls.length = 0
    mockConfigStoreState = {}
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionCreateHandler = () => Promise.resolve({ data: makeSession("created-session") })
  })

  test("keeps the requested directory authoritative for UI routing when OpenCode returns an alias", async () => {
    const store = createStore({}, [])
    const childStores = createChildStores([["/tmp/test-project", store]])
    sessionCreateHandler = () => Promise.resolve({
      data: {
        ...makeSession("aliased-session"),
        directory: "/private/tmp/test-project",
      },
    })

    const { createSessionRecord, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/tmp/test-project")

    const session = await createSessionRecord("Alias routing", "/tmp/test-project", null)

    expect(session?.directory).toBe("/private/tmp/test-project")
    expect(registeredSessionDirectories).toEqual([
      { sessionId: "aliased-session", directory: "/tmp/test-project" },
    ])
    expect(sessionDirectories["aliased-session"]).toBe("/tmp/test-project")
  })

  test("selects a newly created session with its requested directory instead of a returned alias", async () => {
    const store = createStore({}, [])
    const childStores = createChildStores([["/tmp/test-project", store]])
    sessionCreateHandler = () => Promise.resolve({
      data: {
        ...makeSession("selected-aliased-session"),
        directory: "/private/tmp/test-project",
      },
    })

    const { createSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/tmp/test-project")

    const session = await createSession("Alias selection", "/tmp/test-project", null)

    expect(session?.directory).toBe("/private/tmp/test-project")
    expect(setCurrentSessionCalls.at(-1)).toEqual({
      id: "selected-aliased-session",
      directory: "/tmp/test-project",
    })
  })

  test("retries a transient OpenCode restart response before failing chat creation", async () => {
    const store = createStore({}, [])
    const childStores = createChildStores([["/test/project", store]])
    let attempts = 0
    sessionCreateHandler = () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.resolve({
          error: Object.assign(new Error("OpenCode is restarting"), { code: 'session_create_restart_rejected', retryable: true }),
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

  test("does not recreate a session after managed ownership retries are exhausted", async () => {
    const store = createStore({}, [])
    const childStores = createChildStores([["/test/project", store]])
    sessionCreateHandler = () => Promise.resolve({
      error: {
        message: "Identity service unavailable",
        code: "identity_unavailable",
        retryable: false,
      },
      response: { status: 503 },
    })

    const { setActionRefs, createSessionRecord, consumeLastCreateSessionError } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const session = await withMutedConsoleError(() => createSessionRecord("Preserve draft", "/test/project", null))
    const error = consumeLastCreateSessionError() as Error & { code?: string; retryable?: boolean }

    expect(session).toBeNull()
    expect(sessionCreateCalls).toHaveLength(1)
    expect(error.message).toContain("Identity service unavailable")
    expect(error.code).toBe("identity_unavailable")
    expect(error.retryable).toBe(false)
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
    sessionUpdateOptions.length = 0
    sessionDeleteOptions.length = 0
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
    membershipBeginCalls.length = 0
    membershipSettleCalls.length = 0
    postMutationRefreshCalls = 0
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
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve(makeScopedRevertResult(sessionId, messageId))
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

  test("treats a resolved SDK archive error as a failed mutation", async () => {
    const sessionA = makeSession("session-a")
    const store = createStore({}, [sessionA])
    const childStores = createChildStores([["/test/project", store]])
    sessionUpdateHandler = () => Promise.resolve({ error: new Error("archive failed") })

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => archiveSessions(["session-a"]))).toEqual({
      archivedIds: [],
      failedIds: ["session-a"],
    })
    expect(sessionUpdateOptions).toEqual([{ throwOnError: true }])
    expect(store.getState().session.map((item) => item.id)).toEqual(["session-a"])
  })

  test("registers and settles archive membership before requesting a fresh global snapshot", async () => {
    const sessionA = makeSession("session-a")
    mockGlobalActiveSessions = [sessionA]
    const store = createStore({}, [sessionA])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, archiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await archiveSessions(["session-a"])).toEqual({ archivedIds: ["session-a"], failedIds: [] })
    expect(membershipBeginCalls.length).toBe(1)
    expect(membershipBeginCalls[0]?.kind).toBe("archive")
    expect(membershipBeginCalls[0]?.sessionIds).toEqual(["session-a"])
    expect(membershipBeginCalls[0]?.snapshots).toEqual([sessionA])
    expect(typeof membershipBeginCalls[0]?.archivedAt).toBe("number")
    expect(membershipSettleCalls[0]?.result).toEqual({
      successfulIds: ["session-a"],
      failedIds: [],
    })
    expect(postMutationRefreshCalls).toBe(1)
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
    sessionUpdateOptions.length = 0
    globalUnarchiveCalls.length = 0
    globalRemoveCalls.length = 0
    globalRestoreCalls.length = 0
    membershipBeginCalls.length = 0
    membershipSettleCalls.length = 0
    postMutationRefreshCalls = 0
    mockGlobalActiveSessions = []
    mockGlobalArchivedSessions = []
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionUpdateHandler = () => Promise.resolve({ data: true })
  })

  test("updates loaded directory membership before the SDK request resolves", async () => {
    const archived = {
      ...makeSession("session-a"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const unrelated = makeSession("session-b")
    mockGlobalArchivedSessions = [archived]
    const store = createStore({}, [archived, unrelated])
    const before = store.getState()
    const deferred = createDeferred<{ data: boolean }>()
    sessionUpdateHandler = () => deferred.promise
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = unarchiveSessions([archived.id])
    await Promise.resolve()

    const during = store.getState()
    expect(during.session).not.toBe(before.session)
    expect(during.session[0]).not.toBe(archived)
    expect(during.session[0].time?.archived).toBe(undefined)
    expect(during.session[1]).toBe(unrelated)
    expect(during.message).toBe(before.message)
    expect(during.part).toBe(before.part)
    expect(mockGlobalActiveSessions.map((session) => session.id)).toEqual([archived.id])
    expect(mockGlobalArchivedSessions).toEqual([])

    const optimistic = during.session[0]
    deferred.resolve({ data: true })

    expect(await resultPromise).toEqual({ unarchivedIds: [archived.id], failedIds: [] })
    expect(store.getState().session[0]).toBe(optimistic)
    expect(store.getState().session[1]).toBe(unrelated)
  })

  test("restores the exact archived record when unarchive fails", async () => {
    const archived = {
      ...makeSession("session-a"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const unrelated = makeSession("session-b")
    mockGlobalArchivedSessions = [archived]
    const store = createStore({}, [archived, unrelated])
    const deferred = createDeferred<{ data: boolean }>()
    sessionUpdateHandler = () => deferred.promise
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = withMutedConsoleError(() => unarchiveSessions([archived.id]))
    await Promise.resolve()
    expect(store.getState().session[0].time?.archived).toBe(undefined)

    deferred.reject(new Error("unarchive failed"))

    expect(await resultPromise).toEqual({ unarchivedIds: [], failedIds: [archived.id] })
    expect(store.getState().session[0]).toBe(archived)
    expect(store.getState().session[1]).toBe(unrelated)
    expect(mockGlobalActiveSessions).toEqual([])
    expect(mockGlobalArchivedSessions).toEqual([archived])
  })

  test("restores only failed descendants after optimistic unarchive", async () => {
    const parent = {
      ...makeSession("parent"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const child = {
      ...makeSession("child", parent.id),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const unrelated = makeSession("unrelated")
    mockGlobalArchivedSessions = [parent, child]
    const store = createStore({}, [parent, child, unrelated])
    const deferredParent = createDeferred<{ data: boolean }>()
    const deferredChild = createDeferred<{ data: boolean }>()
    const deferredBySession = new Map([
      [parent.id, deferredParent],
      [child.id, deferredChild],
    ])
    sessionUpdateHandler = (params) => deferredBySession.get(String(params.sessionID))!.promise
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = withMutedConsoleError(() => unarchiveSessions([parent.id]))
    await Promise.resolve()
    const optimisticParent = store.getState().session[0]
    expect(store.getState().session.map((session) => session.time?.archived)).toEqual([undefined, undefined, undefined])

    deferredParent.resolve({ data: true })
    deferredChild.reject(new Error("child unarchive failed"))

    expect(await resultPromise).toEqual({ unarchivedIds: [parent.id], failedIds: [child.id] })
    expect(store.getState().session[0]).toBe(optimisticParent)
    expect(store.getState().session[1]).toBe(child)
    expect(store.getState().session[2]).toBe(unrelated)
  })

  test("does not roll back over a newer live directory record", async () => {
    const archived = {
      ...makeSession("session-a"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const unrelated = makeSession("session-b")
    mockGlobalArchivedSessions = [archived]
    const store = createStore({}, [archived, unrelated])
    const deferred = createDeferred<{ data: boolean }>()
    sessionUpdateHandler = () => deferred.promise
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const resultPromise = withMutedConsoleError(() => unarchiveSessions([archived.id]))
    await Promise.resolve()
    const newer = {
      ...store.getState().session[0],
      title: "Updated in another renderer",
      time: { created: 1, updated: 2 },
    } as Session
    store.setState({ session: [newer, unrelated] })

    deferred.reject(new Error("stale unarchive failed"))

    expect(await resultPromise).toEqual({ unarchivedIds: [], failedIds: [archived.id] })
    expect(store.getState().session[0]).toBe(newer)
    expect(store.getState().session[1]).toBe(unrelated)
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
    expect(globalUnarchiveCalls).toEqual([])
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
    expect(globalUnarchiveCalls).toEqual([])
  })

  test("deduplicates descendants during bulk unarchive", async () => {
    const parent = {
      ...makeSession("parent"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    const child = {
      ...makeSession("child", parent.id),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    mockGlobalArchivedSessions = [parent, child]
    const store = createStore({}, [parent, child])
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await unarchiveSessions([parent.id, child.id, parent.id])).toEqual({
      unarchivedIds: [parent.id, child.id],
      failedIds: [],
    })
    expect(sessionUpdateCalls.map((params) => params.sessionID)).toEqual([parent.id, child.id])
  })

  test("treats a resolved SDK unarchive error as a failed mutation", async () => {
    const archived = {
      ...makeSession("session-a"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    mockGlobalArchivedSessions = [archived]
    const childStores = createChildStores([])
    sessionUpdateHandler = () => Promise.resolve({ error: new Error("unarchive failed") })

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => unarchiveSessions(["session-a"]))).toEqual({
      unarchivedIds: [],
      failedIds: ["session-a"],
    })
    expect(sessionUpdateOptions).toEqual([{ throwOnError: true }])
  })

  test("registers and settles unarchive membership before requesting a fresh global snapshot", async () => {
    const archived = {
      ...makeSession("session-a"),
      time: { created: 1, updated: 1, archived: 10 },
    } as Session
    mockGlobalArchivedSessions = [archived]
    const childStores = createChildStores([])

    const { setActionRefs, unarchiveSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await unarchiveSessions(["session-a"])).toEqual({ unarchivedIds: ["session-a"], failedIds: [] })
    expect(membershipBeginCalls).toEqual([{
      kind: "unarchive",
      sessionIds: ["session-a"],
      snapshots: [archived],
    }])
    expect(membershipSettleCalls[0]?.result).toEqual({
      successfulIds: ["session-a"],
      failedIds: [],
    })
    expect(postMutationRefreshCalls).toBe(1)
  })
})

describe("deleteSessions archived behavior", () => {
  beforeEach(() => {
    sessionUpdateCalls.length = 0
    sessionDeleteCalls.length = 0
    sessionUpdateOptions.length = 0
    sessionDeleteOptions.length = 0
    sessionAbortCalls.length = 0
    setCurrentSessionCalls.length = 0
    globalRemoveCalls.length = 0
    globalRestoreCalls.length = 0
    globalArchiveSnapshotCalls.length = 0
    membershipBeginCalls.length = 0
    membershipSettleCalls.length = 0
    postMutationRefreshCalls = 0
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
      failures: [],
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
      failures: [],
    })

    expect(sessionDeleteCalls).toEqual([
      { sessionID: "archived-session", directory: "/archived/project" },
    ])
    expect(globalRemoveCalls[0]).toEqual({ ids: ["archived-session"] })
  })

  test("protects a directory-specific delete through the membership mutation lifecycle", async () => {
    const session = {
      ...makeSession("directory-session"),
      directory: "/other/project",
    } as unknown as Session
    mockGlobalActiveSessions = [session]
    const store = createStore({}, [session])
    const childStores = createChildStores([["/other/project", store]])

    const { deleteSessionInDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await deleteSessionInDirectory("directory-session", "/other/project")).toBe(true)

    expect(sessionDeleteOptions).toEqual([{ throwOnError: true }])
    expect(membershipBeginCalls.at(-1)?.kind).toBe("delete")
    expect(membershipBeginCalls.at(-1)?.sessionIds).toEqual(["directory-session"])
    expect(membershipSettleCalls.at(-1)?.result).toEqual({
      successfulIds: ["directory-session"],
      failedIds: [],
    })
    expect(postMutationRefreshCalls).toBe(1)
  })

  test("rolls back a directory-specific delete when the SDK resolves with an error", async () => {
    const session = {
      ...makeSession("directory-session"),
      directory: "/other/project",
    } as unknown as Session
    mockGlobalActiveSessions = [session]
    const store = createStore({}, [session])
    const childStores = createChildStores([["/other/project", store]])
    sessionDeleteHandler = () => Promise.resolve({ error: new Error("delete failed") })

    const { deleteSessionInDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await withMutedConsoleError(
      () => deleteSessionInDirectory("directory-session", "/other/project"),
    )).toBe(false)

    expect(sessionDeleteOptions).toEqual([{ throwOnError: true }])
    expect(store.getState().session.map((item) => item.id)).toEqual(["directory-session"])
    expect(mockGlobalActiveSessions.map((item) => item.id)).toEqual(["directory-session"])
    expect(membershipSettleCalls.at(-1)?.result).toEqual({
      successfulIds: [],
      failedIds: ["directory-session"],
    })
    expect(postMutationRefreshCalls).toBe(0)
  })

  test("preserves a newer live session record when a directory-specific delete rolls back", async () => {
    const session = {
      ...makeSession("directory-session"),
      directory: "/other/project",
    } as unknown as Session
    const updatedSession = {
      ...session,
      title: "Updated while delete was pending",
      time: { ...session.time, updated: 2 },
    } as Session
    mockGlobalActiveSessions = [session]
    const store = createStore({}, [session])
    const childStores = createChildStores([["/other/project", store]])
    const deferredDelete = createDeferred<{ data: boolean }>()
    sessionDeleteHandler = () => deferredDelete.promise

    const { deleteSessionInDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const deletePromise = withMutedConsoleError(
      () => deleteSessionInDirectory("directory-session", "/other/project"),
    )
    await Promise.resolve()

    expect(store.getState().session).toEqual([])
    store.setState({ session: [updatedSession] })
    deferredDelete.reject(new Error("delete failed"))

    expect(await deletePromise).toBe(false)
    expect(store.getState().session).toEqual([updatedSession])
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
      failures: [],
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
      failures: [],
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
      failures: [],
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
      failures: [],
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
      failures: [],
    })
  })

  test("settles successfully deleted archived sessions after optimistic removal", async () => {
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

    deferredA.resolve({ data: true })
    deferredB.resolve({ data: true })

    expect(await resultPromise).toEqual({
      deletedIds: ["archived-a", "archived-b"],
      failedIds: [],
      failures: [],
    })
    expect(mockGlobalArchivedSessions.map((session) => session.id)).toEqual([])
    expect(globalRemoveCalls.map((call) => call.ids)).toEqual([["archived-a", "archived-b"]])
    expect(membershipSettleCalls.at(-1)?.result).toEqual({
      successfulIds: ["archived-a", "archived-b"],
      failedIds: [],
    })
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
      failures: [{ sessionId: "archived-session", message: "delete failed" }],
    })

    expect(sessionDeleteCalls).toEqual([
      { sessionID: "archived-session", directory: "/archived/project" },
    ])
    expect(store.getState().session.map((session) => session.id)).toEqual(["archived-session"])
    expect(globalRemoveCalls).toEqual([{ ids: ["archived-session"] }])
    expect(globalRestoreCalls[0].ids).toEqual(["archived-session"])
  })

  test("treats a resolved SDK delete error as a failed mutation", async () => {
    const archived = {
      ...makeSession("archived-session"),
      directory: "/archived/project",
      time: { created: 1, updated: 1, archived: 10 },
    } as unknown as Session
    mockGlobalArchivedSessions = [archived]
    const store = createStore({}, [archived])
    const childStores = createChildStores([["/archived/project", store]])
    sessionDeleteHandler = () => Promise.resolve({ error: new Error("delete failed") })

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await withMutedConsoleError(() => deleteSessions(["archived-session"]))).toEqual({
      deletedIds: [],
      failedIds: ["archived-session"],
      failures: [{ sessionId: "archived-session", message: "delete failed" }],
    })
    expect(sessionDeleteOptions).toEqual([{ throwOnError: true }])
    expect(store.getState().session.map((item) => item.id)).toEqual(["archived-session"])
  })

  test("keeps successful deletes removed and returns structured details only for real failures", async () => {
    const archivedA = {
      ...makeSession("archived-a"),
      directory: "/archived/project",
    } as unknown as Session
    const archivedB = {
      ...makeSession("archived-b"),
      directory: "/archived/project",
    } as unknown as Session
    mockGlobalArchivedSessions = [archivedA, archivedB]
    const store = createStore({}, [archivedA, archivedB])
    const childStores = createChildStores([["/archived/project", store]])
    sessionDeleteHandler = (params) => {
      if (params.sessionID === "archived-b") {
        return Promise.reject(Object.assign(new Error("OpenCode is restarting"), { status: 503 }))
      }
      return Promise.resolve({ data: true })
    }

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await withMutedConsoleError(() => deleteSessions(["archived-a", "archived-b"]))).toEqual({
      deletedIds: ["archived-a"],
      failedIds: ["archived-b"],
      failures: [{
        sessionId: "archived-b",
        message: "OpenCode is restarting",
        status: 503,
      }],
    })
    expect(store.getState().session.map((session) => session.id)).toEqual(["archived-b"])
    expect(globalRestoreCalls.at(-1)?.ids).toEqual(["archived-b"])
  })

  test("registers and settles delete membership before requesting a fresh global snapshot", async () => {
    const archived = {
      ...makeSession("archived-session"),
      directory: "/archived/project",
      time: { created: 1, updated: 1, archived: 10 },
    } as unknown as Session
    mockGlobalArchivedSessions = [archived]
    const childStores = createChildStores([])

    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    expect(await deleteSessions(["archived-session"])).toEqual({
      deletedIds: ["archived-session"],
      failedIds: [],
      failures: [],
    })
    expect(membershipBeginCalls).toEqual([{
      kind: "delete",
      sessionIds: ["archived-session"],
    }])
    expect(membershipSettleCalls[0]?.result).toEqual({
      successfulIds: ["archived-session"],
      failedIds: [],
    })
    expect(postMutationRefreshCalls).toBe(1)
  })
})

describe("revertToMessage scoped revert", () => {
  beforeEach(() => {
    scopedRevertCalls.length = 0
    sessionMessageCalls.length = 0
    restoredAttachmentCalls.length = 0
    inputStoreState = {}
    mockComposerRevisions.clear()
    mockCurrentSessionId = null
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDirectories["session-a"] = "/test/project"
    sessionDirectories["session-b"] = "/other/project"
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve(makeScopedRevertResult(sessionId, messageId))
    sessionMessagesHandler = () => Promise.resolve({ data: [] })
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project", options: { scope: "tree", rootSessionId: "session-a" } },
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
    expect((inputStoreState.pendingRestoredInputs as Map<string, unknown>).get("session-a")).toEqual({
      sessionId: "session-a",
      text: "restore this prompt",
      attachments: [],
      expectedComposerRevision: 0,
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

    expect((inputStoreState.pendingRestoredInputs as Map<string, {
      attachments: unknown[]
    }>).get("session-a")?.attachments).toEqual([
      { url: "data:image/png;base64,aGVsbG8=", mimeType: "image/png", filename: "image.png" },
    ])
    expect(restoredAttachmentCalls).toEqual([])
  })

  test("keeps an acknowledged revert restoration owned by its session across navigation", async () => {
    const deferred = createDeferred<ScopedSessionRevertResult>()
    scopedRevertHandler = () => deferred.promise
    mockCurrentSessionId = "session-a"
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target] },
      part: {
        "msg_2": [
          { type: "text", text: "restore session a" } as unknown as Part,
          { type: "file", mime: "text/plain", url: "file:///a.txt", filename: "a.txt" } as unknown as Part,
        ],
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    const { useInputStore } = await import("./input-store")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const revert = revertToMessage("session-a", "msg_2")
    await Promise.resolve()
    mockCurrentSessionId = "session-b"
    inputStoreState = {
      pendingInputText: "session b draft",
      attachedFiles: [{ filename: "b.txt" }],
    }
    deferred.resolve({
      ...makeScopedRevertResult("session-a", "msg_2"),
      session: { ...session, revert: { messageID: "msg_2" } } as unknown as Session,
    })
    await revert

    expect(inputStoreState.pendingInputText).toBe("session b draft")
    expect(inputStoreState.attachedFiles).toEqual([{ filename: "b.txt" }])
    expect(useInputStore.getState().consumeRestoredInput("session-b", 0)).toBeNull()
    expect(useInputStore.getState().consumeRestoredInput("session-a", 0)).toEqual({
      sessionId: "session-a",
      text: "restore session a",
      attachments: [{ url: "file:///a.txt", mimeType: "text/plain", filename: "a.txt" }],
      expectedComposerRevision: 0,
    })
  })

  test("does not overwrite composer edits made while a revert is pending", async () => {
    const deferred = createDeferred<ScopedSessionRevertResult>()
    scopedRevertHandler = () => deferred.promise
    mockCurrentSessionId = "session-a"
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target] },
      part: { "msg_2": [{ type: "text", text: "old prompt" } as unknown as Part] },
    })
    const childStores = createChildStores([["/test/project", store]])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    const { markSessionComposerEdited, useInputStore } = await import("./input-store")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const revert = revertToMessage("session-a", "msg_2")
    await Promise.resolve()
    markSessionComposerEdited("session-a")
    inputStoreState = {
      pendingInputText: "new draft typed during revert",
      attachedFiles: [{ filename: "new.txt" }],
    }
    deferred.resolve({
      ...makeScopedRevertResult("session-a", "msg_2"),
      session: { ...session, revert: { messageID: "msg_2" } } as unknown as Session,
    })
    await revert

    expect(useInputStore.getState().consumeRestoredInput("session-a", 1)).toBeNull()
    expect(inputStoreState.pendingInputText).toBe("new draft typed during revert")
    expect(inputStoreState.attachedFiles).toEqual([{ filename: "new.txt" }])
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/other/project", options: { scope: "tree", rootSessionId: "session-a" } },
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project", options: { scope: "tree", rootSessionId: "session-a" } },
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project", options: { scope: "tree", rootSessionId: "session-a" } },
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project", options: { scope: "tree", rootSessionId: "session-a" } },
    ])
    expect(store.getState().message["session-a"]).toEqual([target, after])
    expect(store.getState().session[0]?.revert).toBe(undefined)
  })

  test("recovers a concurrent new turn when an idle scoped revert fails", async () => {
    const deferred = createDeferred<ScopedSessionRevertResult>()
    scopedRevertHandler = () => deferred.promise
    const session = makeSession("session-a")
    const target = {
      id: "msg_2",
      sessionID: "session-a",
      role: "user",
      time: { created: 2 },
    } as unknown as Message
    const after = {
      id: "msg_3",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 3, completed: 4 },
      finish: "stop",
    } as unknown as Message
    const concurrent = {
      id: "msg_4",
      sessionID: "session-a",
      role: "user",
      time: { created: 5 },
    } as unknown as Message
    sessionMessagesHandler = () => Promise.resolve({
      data: [target, after, concurrent].map((info) => ({ info, parts: [] })),
    })
    const store = createStore({}, [session])
    store.setState({
      session_status: { "session-a": { type: "idle" } as SessionStatus },
      message: { "session-a": [target, after] },
      part: { "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const revert = revertToMessage("session-a", "msg_2")
    expect(store.getState().message["session-a"]).toEqual([])

    let concurrentEventChanged = true
    store.setState((state) => {
      const draft = {
        ...state,
        session: [...state.session],
        message: { ...state.message },
        part: { ...state.part },
      }
      concurrentEventChanged = Boolean(applyDirectoryEvent(draft, {
        type: "message.updated",
        properties: { info: concurrent },
      } as never))
      return draft
    })
    expect(concurrentEventChanged).toBe(true)
    expect(store.getState().message["session-a"]).toEqual([concurrent])

    deferred.reject(new Error("safe revert conflict"))
    let thrown: unknown = null
    try {
      await revert
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("safe revert conflict")
    expect(sessionMessageCalls).toEqual([{
      sessionID: "session-a",
      directory: "/test/project",
      limit: 200,
    }])
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual([
      "msg_2",
      "msg_3",
      "msg_4",
    ])
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
    scopedRevertHandler = (sessionId, messageId) => deferred.promise.then(() => makeScopedRevertResult(sessionId, messageId))
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
      { sessionId: "session-a", messageId: "msg_2", directory: "/test/project", options: { scope: "tree", rootSessionId: "session-a" } },
    ])
    expect(store.getState().message["session-a"]).toEqual([])

    deferred.resolve(session)
    await first
  })

  test("restores history and rejects before bounded failure reconciliation settles", async () => {
    const reconciliation = createDeferred<{ data: [] }>()
    scopedRevertHandler = () => Promise.reject(new Error("scoped revert timed out"))
    sessionMessagesHandler = () => reconciliation.promise
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target, after] },
      part: { "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const revert = revertToMessage("session-a", "msg_2")
    try {
      const outcome = await Promise.race([
        revert.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 75)),
      ])
      expect(outcome).toBe("rejected")
      expect(store.getState().message["session-a"]).toEqual([target, after])
      expect(store.getState().part).toEqual({ "msg_2": [], "msg_3": [] })
      expect(store.getState().revert_transaction["session-a"]).toBe(undefined)
    } finally {
      reconciliation.resolve({ data: [] })
      await revert.catch(() => undefined)
    }
  })

  test("ignores late failed-revert reconciliation after a newer transaction starts", async () => {
    const reconciliation = createDeferred<{ data: Array<{ info: Message; parts: Part[] }> }>()
    scopedRevertHandler = () => Promise.reject(new Error("scoped revert timed out"))
    sessionMessagesHandler = () => reconciliation.promise
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as Message
    const after = { id: "msg_3", sessionID: "session-a", role: "assistant", time: { created: 3 } } as unknown as Message
    const newer = { id: "msg_newer", sessionID: "session-a", role: "user", time: { created: 4 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [target, after] },
      part: { "msg_2": [], "msg_3": [] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const rejection = revertToMessage("session-a", "msg_2").catch((error) => error)
    while (sessionMessageCalls.length === 0) {
      await Promise.resolve()
    }
    store.setState((state) => ({
      message: { ...state.message, "session-a": [newer] },
      part: { "msg_newer": [] },
      revert_transaction: {
        ...state.revert_transaction,
        "session-a": {
          messageID: "msg_newer",
          hiddenMessageIDs: new Set(["msg_newer"]),
          version: 10_000,
          status: "pending",
          startedAt: 2,
        },
      },
    }))
    reconciliation.resolve({ data: [{ info: target, parts: [] }, { info: after, parts: [] }] })
    await rejection
    await Promise.resolve()

    expect(store.getState().message["session-a"]).toEqual([newer])
    expect(store.getState().revert_transaction["session-a"]?.version).toBe(10_000)
  })

  test("does not let a disposed directory's late failed-revert reconciliation restore history", async () => {
    const reconciliation = createDeferred<{ data: Array<{ info: Message; parts: Part[] }> }>()
    scopedRevertHandler = () => Promise.reject(new Error("scoped revert timed out"))
    sessionMessagesHandler = () => reconciliation.promise
    const session = makeSession("session-a")
    const target = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({ message: { "session-a": [target] }, part: { "msg_2": [] } })
    const childStores = createChildStores([["/test/project", store]])

    const {
      releaseSessionActionDirectory,
      setActionRefs,
      revertToMessage,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const rejection = revertToMessage("session-a", "msg_2").catch((error) => error)
    while (sessionMessageCalls.length === 0) {
      await Promise.resolve()
    }
    releaseSessionActionDirectory("/test/project")
    store.setState({ session: [], sessionTotal: 0, message: {}, part: {}, revert_transaction: {} })
    reconciliation.resolve({ data: [{ info: target, parts: [] }] })
    await rejection
    await Promise.resolve()

    expect(store.getState().message["session-a"]).toBe(undefined)
  })

  test("rejects same-session sends while revert is pending and allows them after confirmation", async () => {
    const session = makeSession("session-a")
    const before = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before] },
      part: { "msg_1": [] },
      revert_transaction: {
        "session-a": {
          messageID: "msg_2",
          hiddenMessageIDs: new Set(["msg_2"]),
          version: 1,
          status: "pending",
          startedAt: 1,
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
    let sendCalls = 0
    const send = () => {
      sendCalls += 1
      return Promise.resolve()
    }

    let thrown: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-a",
        content: "blocked prompt",
        providerID: "provider",
        modelID: "model",
        directory: "/test/project",
        send,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : "").toBe("Cannot send while this chat is being reverted")
    expect(sendCalls).toBe(0)
    expect(store.getState().message["session-a"]).toEqual([before])

    store.setState((state) => ({
      revert_transaction: {
        ...state.revert_transaction,
        "session-a": {
          ...state.revert_transaction["session-a"]!,
          status: "confirmed",
          serverAcknowledged: true,
        },
      },
    }))
    await optimisticSend({
      sessionId: "session-a",
      content: "allowed prompt",
      providerID: "provider",
      modelID: "model",
      directory: "/test/project",
      send,
    })
    expect(sendCalls).toBe(1)
  })

  test("guards every same-session mutation entrypoint while revert is pending", async () => {
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      revert_transaction: {
        "session-a": {
          messageID: "msg_2",
          hiddenMessageIDs: new Set(["msg_2"]),
          version: 1,
          status: "pending",
          startedAt: 1,
        },
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    const {
      assertSessionRevertMutationAllowed,
      setActionRefs,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(() => assertSessionRevertMutationAllowed("session-a", "/test/project", "send"))
      .toThrow("Cannot send while this chat is being reverted")
    expect(() => assertSessionRevertMutationAllowed("session-a", "/test/project", "undo"))
      .toThrow("Cannot undo while this chat is being reverted")
    expect(() => assertSessionRevertMutationAllowed("session-a", "/test/project", "redo"))
      .toThrow("Cannot redo while this chat is being reverted")

    store.setState((state) => ({
      revert_transaction: {
        ...state.revert_transaction,
        "session-a": {
          ...state.revert_transaction["session-a"]!,
          status: "confirmed",
        },
      },
    }))
    let allowedError: unknown = null
    try {
      assertSessionRevertMutationAllowed("session-a", "/test/project", "send")
    } catch (error) {
      allowedError = error
    }
    expect(allowedError).toBeNull()
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
          hiddenMessageIDs: new Set(["msg_2", "msg_3"]),
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

  test("updates root prompt recency at dispatch and restores it when transport fails", async () => {
    const before = { id: "msg_before", sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      message: { "session-a": [before] },
      part: { msg_before: [] },
      session_user_activity: { "session-a": 1 },
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

    let activityDuringDispatch = 0
    let thrown: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-a",
        content: "implement plan",
        providerID: "provider",
        modelID: "model",
        directory: "/test/project",
        send: () => {
          activityDuringDispatch = store.getState().session_user_activity["session-a"] ?? 0
          return Promise.reject(new Error("send failed"))
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("send failed")
    expect(activityDuringDispatch).toBeGreaterThan(1)
    expect(store.getState().session_user_activity["session-a"]).toBe(1)
  })

  test("adds and rolls back a deterministic Cursor assistant placeholder with the optimistic user message", async () => {
    const beforeMessageId = "msg_00000000100100000000000000"
    const before = { id: beforeMessageId, sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const store = createStore({}, [makeSession("session-a", "session-parent")])
    store.setState({
      message: { "session-a": [before] },
      part: { [beforeMessageId]: [] },
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
      beforeMessageId,
      optimisticMessageId,
      `${optimisticMessageId}_assistant`,
    ])
    expect(messagesDuringSend.at(-1)?.role).toBe("assistant")
    expect(messagesDuringSend.every((message) => (
      !("completed" in ((message.time ?? {}) as Record<string, unknown>))
    ))).toBe(true)
    expect(partsDuringSend[`${optimisticMessageId}_assistant`]).toEqual([])
    expect(registeredSessionDirectories.some((entry) => (
      entry.sessionId === "session-a" && entry.directory === "/test/project"
    ))).toBe(true)
    expect(sessionDirectories["session-a"]).toBe("/test/project")
    expect(store.getState().message["session-a"]).toEqual([before])
    expect(store.getState().part[`${optimisticMessageId}_assistant`]).toBe(undefined)
  })

  test("keeps optimistic image parts visible while message transport is pending", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const transport = createDeferred<void>()
    let optimisticMessageId = ""

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

    const pendingSend = optimisticSend({
      sessionId: "session-a",
      content: "inspect these screenshots",
      providerID: "provider",
      modelID: "model",
      directory: "/test/project",
      files: [
        { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "first.png" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,BBBB", filename: "second.png" },
      ],
      send: (messageID) => {
        optimisticMessageId = messageID
        return transport.promise
      },
    })

    while (!optimisticMessageId) {
      await Promise.resolve()
    }

    expect((store.getState().part[optimisticMessageId] ?? []).map((part) => ({
      type: part.type,
      text: "text" in part ? part.text : undefined,
      mime: "mime" in part ? part.mime : undefined,
      filename: "filename" in part ? part.filename : undefined,
    }))).toEqual([
      { type: "text", text: "inspect these screenshots", mime: undefined, filename: undefined },
      { type: "file", text: undefined, mime: "image/png", filename: "first.png" },
      { type: "file", text: undefined, mime: "image/png", filename: "second.png" },
    ])

    transport.resolve()
    await pendingSend
  })

  for (const selection of [
    { label: "Low", input: { variant: "low" }, nativeVariant: "low", restoredVariant: "low" },
    { label: "High", input: { variant: "high" }, nativeVariant: "high", restoredVariant: "high" },
    { label: "provider default", input: { variant: null }, nativeVariant: "", restoredVariant: null },
    { label: "uncaptured variant", input: {}, nativeVariant: undefined, restoredVariant: undefined },
  ] as const) {
    test(`preserves ${selection.label} in the latest-user choice before a delayed canonical echo`, async () => {
      const store = createStore({}, [makeSession("session-a")])
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
      const transport = createDeferred<void>()
      const transportStarted = createDeferred<string>()
      const pendingSend = optimisticSend({
        sessionId: "session-a",
        content: "keep my thinking choice while this request is pending",
        providerID: "fixture",
        modelID: "fixture-model",
        agent: "Builder",
        directory: "/test/project",
        ...selection.input,
        send: (messageID) => {
          transportStarted.resolve(messageID)
          return transport.promise
        },
      })

      try {
        const messageID = await transportStarted.promise
        const optimistic = store.getState().message["session-a"]?.[0]
        if (optimistic?.role !== "user") throw new Error("Expected the optimistic user before transport settles")
        expect(optimistic.model.variant).toBe(selection.nativeVariant)
        expect(Object.hasOwn(optimistic.model, "variant")).toBe(selection.nativeVariant !== undefined)
        const selectChoice = createLatestUserChoiceSelector("session-a")
        const beforeEcho = selectChoice(store.getState())
        expect(beforeEcho).toEqual({
          id: messageID,
          agent: "Builder",
          providerID: "fixture",
          modelID: "fixture-model",
          variant: selection.restoredVariant,
        })

        const canonical: UserMessage = {
          id: messageID,
          sessionID: "session-a",
          role: "user",
          agent: "Builder",
          time: { created: optimistic.time.created },
          model: {
            providerID: "fixture",
            modelID: "fixture-model",
            ...(selection.nativeVariant !== undefined ? { variant: selection.nativeVariant } : {}),
          },
        }
        store.setState((state) => {
          const draft = { ...state, message: { ...state.message }, part: { ...state.part } }
          applyDirectoryEvent(draft, {
            id: `event_${messageID}`,
            type: "message.updated",
            properties: { sessionID: canonical.sessionID, info: canonical },
          })
          return draft
        })
        expect(store.getState().message["session-a"]).toHaveLength(1)
        expect(selectChoice(store.getState())).toBe(beforeEcho)
      } finally {
        transport.resolve()
        await pendingSend
      }
    })
  }

  test("ignores stale reverted session snapshots while optimistic resend is in flight", async () => {
    const session = {
      ...makeSession("session-a"),
      revert: { messageID: "msg_2" },
    } as Session
    const beforeMessageId = "msg_00000000100100000000000000"
    const before = { id: beforeMessageId, sessionID: "session-a", role: "user", time: { created: 1 } } as unknown as Message
    const previousTransaction = {
      messageID: "msg_2",
      hiddenMessageIDs: new Set(["msg_2", "msg_3"]),
      version: 1,
      status: "confirmed" as const,
      startedAt: 1,
      serverAcknowledged: true,
    }
    const store = createStore({}, [session])
    store.setState({
      message: { "session-a": [before] },
      part: { [beforeMessageId]: [] },
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
      beforeMessageId,
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
      hiddenMessageIDs: new Set(["msg_2", "msg_3"]),
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
    scopedUnrevertCalls.length = 0
    scopedUnrevertHandler = (sessionId) => Promise.resolve({ session: makeSession(sessionId), restored: [] })
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
    globalUpsertCalls.length = 0
  })

  test("mirrors a successful title update into only the target directory store", async () => {
    const original = {
      ...makeSession("session-b"),
      title: "Old title",
      time: { created: 1, updated: 2 },
    } as Session
    const currentStore = createStore({}, [makeSession("session-a")])
    const sessionStore = createStore({}, [original])
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])
    const updated = {
      ...original,
      title: "New title",
      time: { created: 1, updated: 3 },
    } as Session
    sessionUpdateHandler = () => Promise.resolve({ data: updated })

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    await updateSessionTitle("session-b", "New title")

    expect(sessionStore.getState().session[0]).toEqual(updated)
    expect(currentStore.getState().session.map((session) => session.id)).toEqual(["session-a"])
    expect(globalUpsertCalls).toEqual([updated])
  })

  test("does not replace a newer directory record with an older title response", async () => {
    const current = {
      ...makeSession("session-b"),
      title: "Newest title",
      time: { created: 1, updated: 10 },
    } as Session
    const sessionStore = createStore({}, [current])
    const childStores = createChildStores([["/other/project", sessionStore]])
    sessionUpdateHandler = () => Promise.resolve({
      data: {
        ...current,
        title: "Stale title",
        time: { created: 1, updated: 9 },
      } as Session,
    })

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
    const before = sessionStore.getState().session
    await updateSessionTitle("session-b", "Stale title")

    expect(sessionStore.getState().session).toBe(before)
    expect(sessionStore.getState().session[0]).toBe(current)
  })

  test("rejects unrevert while the same session has a pending revert and allows it after rollback", async () => {
    const session = makeSession("session-b")
    const currentStore = createStore({}, [])
    const sessionStore = createStore({}, [session])
    sessionStore.setState({
      revert_transaction: {
        "session-b": {
          messageID: "msg_2",
          hiddenMessageIDs: new Set(["msg_2"]),
          version: 1,
          status: "pending",
          startedAt: 1,
        },
      },
    })
    const childStores = createChildStores([
      ["/test/project", currentStore],
      ["/other/project", sessionStore],
    ])

    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await unrevertSession("session-b")
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : "").toBe("Cannot redo while this chat is being reverted")
    expect(scopedUnrevertCalls).toEqual([])

    sessionStore.setState({ revert_transaction: {} })
    await unrevertSession("session-b")
    expect(scopedUnrevertCalls).toEqual([
      { sessionId: "session-b", directory: "/other/project" },
    ])
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
    expect(scopedUnrevertCalls).toEqual([
      { sessionId: "session-b", directory: "/other/project" },
    ])
    expect(sessionUnrevertCalls).toEqual([])
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
    mockConfigStoreState = {}
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

  test("starts the reply without waiting for the event-stream connection grace", async () => {
    let probeCalls = 0
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => {
        probeCalls += 1
        return Promise.resolve(false)
      },
    }
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-fast", [["answer1"]])

    expect(probeCalls).toBe(0)
    expect(replyCalls.map((call) => call.method)).toEqual(["question.reply"])
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    mockConfigStoreState = {}
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

  test("starts Skip without waiting for the event-stream connection grace", async () => {
    let probeCalls = 0
    mockConfigStoreState = {
      isConnected: false,
      hasEverConnected: true,
      lastDisconnectReason: "ws_closed_before_ready",
      probeConnection: () => {
        probeCalls += 1
        return Promise.resolve(false)
      },
    }
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-fast-skip")

    expect(probeCalls).toBe(0)
    expect(replyCalls.map((call) => call.method)).toEqual(["question.reject"])
  })
})

describe("revertToMessage recovery behavior", () => {
  beforeEach(() => {
    resetAbortGuardState()
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

    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await abortCurrentOperationConfirmed("session-a")).toBe(true)

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    const abortFlag = mockSessionAbortFlags.get("session-a")
    expect(abortFlag?.id).toBe("msg-assistant")
    expect(abortFlag?.reason).toBe("manual")
    expect(abortFlag?.acknowledged).toBe(false)
    expect(typeof abortFlag?.timestamp).toBe("number")
  })

  test("seeds a manual abort guard from the retry status being stopped", async () => {
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      session_status: {
        "session-a": {
          type: "retry",
          attempt: 2,
          message: "rate limited",
          next: ABORT_GUARD_TTL_MS * 2,
        } as SessionStatus,
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { abortCurrentOperation, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await abortCurrentOperation("session-a")

    expect(store.getState().session_status["session-a"]).toEqual({ type: "idle" })
    expect(isAbortGuardActive("session-a", Date.now() + ABORT_GUARD_TTL_MS + 1)).toBe(true)
  })

  test("settles a busy retry attempt raced in before abort acknowledgement", async () => {
    const store = createStore({}, [makeSession("session-a")])
    store.setState({
      session_status: {
        "session-a": { type: "busy" },
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    const retryStatus = {
      type: "retry",
      attempt: 1,
      message: "usage limit",
      next: 10,
    } as SessionStatus

    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await abortCurrentOperationConfirmed("session-a", retryStatus)).toBe(true)
    expect(store.getState().session_status["session-a"]).toEqual({ type: "idle" })
  })

  test("does not record a manual abort flag when sdk abort fails", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))

    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => abortCurrentOperationConfirmed("session-a"))).toBe(false)

    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
  })

  test("does not confirm an abort when the SDK resolves without acknowledgement", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    sessionAbortHandler = () => Promise.resolve({ data: false })

    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    expect(await withMutedConsoleError(() => abortCurrentOperationConfirmed("session-a"))).toBe(false)
    expect(mockSessionAbortFlags.get("session-a")).toBe(undefined)
    expect(store.getState().session_status["session-a"]).toBe(undefined)
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

  test("queued-send interrupt records steered aborts after sdk success", async () => {
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
    expect(abortFlag?.reason).toBe("steered")
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

  test("does not let a disposed directory's late abort reconciliation restore messages", async () => {
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const refetch = createDeferred<{ data: Array<{ info: Message; parts: Part[] }> }>()
    sessionMessagesHandler = () => refetch.promise
    const staleMessage = {
      id: "message-after-directory-release",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1, completed: 2 },
    } as Message

    const {
      reconcileUnexpectedAbort,
      releaseSessionActionDirectory,
      setActionRefs,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const reconciliation = reconcileUnexpectedAbort("session-a")
    releaseSessionActionDirectory("/test/project")
    store.setState({ session: [], sessionTotal: 0, message: {}, part: {} })
    refetch.resolve({ data: [{ info: staleMessage, parts: [] }] })
    await reconciliation

    expect(store.getState().message["session-a"]).toBe(undefined)
  })

  test("releases only one session's unexpected-abort reconciliation ownership", async () => {
    const store = createStore({}, [makeSession("session-a"), makeSession("session-b")])
    const childStores = createChildStores([["/test/project", store]])
    const firstRefetch = createDeferred<{ data: Array<{ info: Message; parts: Part[] }> }>()
    const secondRefetch = createDeferred<{ data: Array<{ info: Message; parts: Part[] }> }>()
    sessionMessagesHandler = (params) => params.sessionID === "session-a"
      ? firstRefetch.promise
      : secondRefetch.promise
    const firstMessage = {
      id: "message-a-after-release",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1, completed: 2 },
    } as Message
    const secondMessage = {
      id: "message-b-after-release",
      sessionID: "session-b",
      role: "assistant",
      time: { created: 1, completed: 2 },
    } as Message

    const {
      reconcileUnexpectedAbort,
      releaseSessionActionSession,
      setActionRefs,
    } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const first = reconcileUnexpectedAbort("session-a", "/test/project")
    const second = reconcileUnexpectedAbort("session-b", "/test/project")
    releaseSessionActionSession("/test/project", "session-a")
    store.setState((state) => ({
      session: state.session.filter((session) => session.id !== "session-a"),
      sessionTotal: 1,
    }))
    firstRefetch.resolve({ data: [{ info: firstMessage, parts: [] }] })
    secondRefetch.resolve({ data: [{ info: secondMessage, parts: [] }] })
    await Promise.all([first, second])

    expect(store.getState().message["session-a"]).toBe(undefined)
    expect(store.getState().message["session-b"]).toEqual([secondMessage])
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
    // The tree revert waits for the aborted session to report idle, as the
    // server does after an abort lands.
    sessionAbortHandler = (params) => {
      store.setState((state) => ({
        session_status: { ...state.session_status, [String(params.sessionID)]: { type: "idle" } as SessionStatus },
      }))
      return Promise.resolve({ data: true })
    }
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

describe("abortCurrentOperationConfirmed stop reliability", () => {
  beforeEach(() => {
    resetAbortGuardState()
    sessionAbortCalls.length = 0
    clearSessionStoppingCalls.length = 0
    clearSessionTurnCompletionCalls.length = 0
    mockSessionAbortFlags = new Map()
    mockAbortControllers = new Map()
    sessionDirectories["session-a"] = "/test/project"
    sessionAbortHandler = () => Promise.resolve({ data: true })
    useManagedOrchestrationStore.setState({ taskIdsByRootId: {}, tasksById: {} })
  })

  test("issues the abort request without waiting for managed subtask cancellation", async () => {
    const cancelDeferred = createDeferred<void>()
    const cancelCalls: string[] = []
    useManagedOrchestrationStore.setState({
      taskIdsByRootId: { "session-a": ["task-1"] },
      tasksById: { "task-1": { taskId: "task-1", status: "running" } as never },
      cancelTask: ((taskId: string) => {
        cancelCalls.push(taskId)
        return cancelDeferred.promise
      }) as never,
    })

    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    // The subtask cancellation never resolves inside this test — the abort
    // must still reach the server and confirm.
    const result = await abortCurrentOperationConfirmed("session-a")

    expect(result).toBe(true)
    expect(cancelCalls).toEqual(["task-1"])
    expect(sessionAbortCalls).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    cancelDeferred.resolve()
  })

  test("returns false when the abort request hangs past the watchdog", async () => {
    sessionAbortHandler = () => new Promise(() => {})
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const result = await withMutedConsoleError(() =>
      abortCurrentOperationConfirmed("session-a", undefined, 20),
    )

    expect(result).toBe(false)
    expect(clearSessionStoppingCalls).toContain("session-a")
    expect(isAbortGuardActive("session-a", Date.now())).toBe(false)
  })

  test("clears the optimistic stopping flag and abort guard when the abort fails", async () => {
    sessionAbortHandler = () => Promise.reject(new Error("abort failed"))
    const store = createStore({}, [makeSession("session-a")])
    const childStores = createChildStores([["/test/project", store]])
    const { abortCurrentOperationConfirmed, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const result = await withMutedConsoleError(() => abortCurrentOperationConfirmed("session-a"))

    expect(result).toBe(false)
    expect(clearSessionStoppingCalls).toContain("session-a")
    expect(isAbortGuardActive("session-a", Date.now())).toBe(false)
  })
})

describe("session tree revert", () => {
  const userMsg = (id: string, sessionID: string, created: number): Message => (
    { id, sessionID, role: "user", time: { created } } as unknown as Message
  )
  const assistantMsg = (id: string, sessionID: string, created: number): Message => (
    { id, sessionID, role: "assistant", time: { created, completed: created } } as unknown as Message
  )
  const flushToasts = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    scopedRevertCalls.length = 0
    scopedUnrevertCalls.length = 0
    treeChangesCalls.length = 0
    sessionAbortCalls.length = 0
    sessionMessageCalls.length = 0
    toastCalls.length = 0
    inputStoreState = {}
    mockComposerRevisions.clear()
    mockCurrentSessionId = null
    mockGlobalActiveSessions = []
    mockGlobalArchivedSessions = []
    for (const key of Object.keys(sessionDirectories)) {
      delete sessionDirectories[key]
    }
    sessionDirectories["session-a"] = "/test/project"
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve(makeScopedRevertResult(sessionId, messageId))
    scopedUnrevertHandler = (sessionId) => Promise.resolve({ session: makeSession(sessionId), restored: [] })
    treeChangesHandler = () => Promise.resolve(makeTreeChanges())
    sessionMessagesHandler = () => Promise.resolve({ data: [] })
    sessionAbortHandler = () => Promise.resolve({ data: true })
  })

  /** Root + child + grandchild in one directory, every message a leaf of the root's chat. */
  const createTreeStore = () => {
    const root = makeSession("session-a")
    const child = makeSession("child-1", "session-a")
    const grandchild = makeSession("child-2", "child-1")
    const store = createStore({}, [root, child, grandchild])
    store.setState({
      message: {
        "session-a": [
          userMsg("msg_1", "session-a", 1),
          assistantMsg("msg_2a", "session-a", 2),
          userMsg("msg_2", "session-a", 3),
          assistantMsg("msg_3", "session-a", 4),
        ],
        "child-1": [userMsg("c1_1", "child-1", 5)],
        "child-2": [userMsg("c2_1", "child-2", 6)],
      },
      part: { msg_1: [], msg_2a: [], msg_2: [], msg_3: [], c1_1: [], c2_1: [] },
    })
    return store
  }

  test("aborts the whole tree deepest-first, waits for idle, then sends tree scope with the root id", async () => {
    const store = createTreeStore()
    store.setState({
      session_status: {
        "session-a": { type: "busy" },
        "child-1": { type: "busy" },
        "child-2": { type: "busy" },
      } as Record<string, SessionStatus>,
    })
    sessionAbortHandler = (params) => {
      store.setState((state) => ({
        session_status: { ...state.session_status, [String(params.sessionID)]: { type: "idle" } as SessionStatus },
      }))
      return Promise.resolve({ data: true })
    }
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    expect(sessionAbortCalls.map((call) => call.sessionID)).toEqual(["child-2", "child-1", "session-a"])
    expect(scopedRevertCalls).toEqual([{
      sessionId: "session-a",
      messageId: "msg_2",
      directory: "/test/project",
      options: { scope: "tree", rootSessionId: "session-a" },
    }])
    expect(store.getState().session_status["child-2"]).toEqual({ type: "idle" })
    expect(store.getState().revert_transaction["session-a"]?.status).toBe("confirmed")
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual(["msg_1", "msg_2a"])
  })

  test("reverting from a child's message sends the child's message and session with the root id", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("child-1", "c1_1")

    expect(scopedRevertCalls).toEqual([{
      sessionId: "child-1",
      messageId: "c1_1",
      directory: "/test/project",
      options: { scope: "tree", rootSessionId: "session-a" },
    }])
    expect(sessionAbortCalls).toEqual([])
  })

  test("applies the markers the server reports for other tree sessions and announces the outcome", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    scopedRevertHandler = (sessionId, messageId) => Promise.resolve(makeScopedRevertResult(sessionId, messageId, {
      reverted: {
        files: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "deleted" }],
        sessions: [
          { id: "session-a", targetMessageID: "msg_2" },
          { id: "child-1", targetMessageID: "c1_1" },
        ],
      },
    }))

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")
    await flushToasts()

    const sessions = store.getState().session as Array<Session & { revert?: { messageID?: string } }>
    expect(sessions.find((session) => session.id === "session-a")?.revert).toEqual({ messageID: "msg_2" })
    expect(sessions.find((session) => session.id === "child-1")?.revert).toEqual({ messageID: "c1_1" })
    expect(toastCalls).toEqual([{ kind: "success", message: "Reverted 2 files across 2 sessions" }])
  })

  test("undoSession reverts the root to the first user message reported by the changes endpoint", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    treeChangesHandler = () => Promise.resolve(makeTreeChanges({ firstUserMessageID: "msg_1", rootSessionID: "session-a" }))

    const { setActionRefs, undoSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await undoSession("child-2")

    // The first call resolves the revert point; the post-revert refresh of the
    // tree-changes store calls the same endpoint again.
    expect(treeChangesCalls[0]).toEqual({ sessionId: "session-a", directory: "/test/project" })
    expect(scopedRevertCalls).toEqual([{
      sessionId: "session-a",
      messageId: "msg_1",
      directory: "/test/project",
      options: { scope: "tree", rootSessionId: "session-a" },
    }])
    expect(store.getState().message["session-a"]).toEqual([])
  })

  test("undoSession falls back to the local first user message when the changes endpoint fails", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    treeChangesHandler = () => Promise.reject(new Error("offline"))

    const { setActionRefs, undoSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await undoSession("session-a")

    expect(scopedRevertCalls.map((call) => call.messageId)).toEqual(["msg_1"])
  })

  test("unrevertSession uses the scoped route and maps redo_unavailable to a toast", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    scopedUnrevertHandler = () => Promise.reject(
      new actualOpencodeClientModule.ScopedRevertError("Failed (409)", { code: "redo_unavailable", status: 409 }),
    )

    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await unrevertSession("session-a")
    await flushToasts()

    expect(scopedUnrevertCalls).toEqual([{ sessionId: "session-a", directory: "/test/project" }])
    expect(sessionUnrevertCalls).toEqual([])
    expect(sessionMessageCalls).toEqual([])
    expect(toastCalls).toEqual([{ kind: "info", message: "Nothing to redo" }])
  })

  test("unrevertSession merges the restored session and refetches messages", async () => {
    const store = createTreeStore()
    store.setState({
      session: store.getState().session.map((session) => (
        session.id === "session-a" ? { ...session, revert: { messageID: "msg_2" } } as Session : session
      )),
    })
    const childStores = createChildStores([["/test/project", store]])
    scopedUnrevertHandler = (sessionId) => Promise.resolve({
      session: makeSession(sessionId),
      restored: [{ path: "src/a.ts", status: "modified" }],
    })

    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await unrevertSession("session-a")
    await flushToasts()

    expect((store.getState().session[0] as Session & { revert?: unknown }).revert).toBe(undefined)
    expect(sessionMessageCalls).toEqual([{ sessionID: "session-a", directory: "/test/project", limit: 200 }])
    expect(toastCalls).toEqual([{ kind: "success", message: "Restored 1 file" }])
  })

  test("slash redo forward step unreverts and then reverts to the target in one transaction", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    const order: string[] = []
    let transactionDuringUnrevert: string | undefined
    scopedUnrevertHandler = (sessionId) => {
      order.push("unrevert")
      transactionDuringUnrevert = store.getState().revert_transaction["session-a"]?.status
      return Promise.resolve({ session: makeSession(sessionId), restored: [] })
    }
    scopedRevertHandler = (sessionId, messageId) => {
      order.push("revert")
      return Promise.resolve(makeScopedRevertResult(sessionId, messageId))
    }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2", { unrevertFirst: true })

    expect(order).toEqual(["unrevert", "revert"])
    expect(transactionDuringUnrevert).toBe("pending")
    expect(scopedUnrevertCalls).toEqual([{ sessionId: "session-a", directory: "/test/project" }])
    expect(scopedRevertCalls.map((call) => call.messageId)).toEqual(["msg_2"])
    expect(store.getState().revert_transaction["session-a"]?.status).toBe("confirmed")
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual(["msg_1", "msg_2a"])
  })

  test("slash redo rolls back when the revert after a successful unrevert fails", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    scopedRevertHandler = () => Promise.reject(
      new actualOpencodeClientModule.ScopedRevertError("Failed (409)", { code: "working_tree_changed", status: 409 }),
    )

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "msg_2", { unrevertFirst: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("Files changed while reverting; nothing was written")
    expect(scopedUnrevertCalls).toHaveLength(1)
    expect(store.getState().revert_transaction["session-a"]).toBe(undefined)
    expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual(["msg_1", "msg_2a", "msg_2", "msg_3"])
  })

  test("maps server error codes to user-facing copy and rolls back the optimistic revert", async () => {
    const cases: Array<{ code: string; files?: Array<{ path: string; status: string }>; expected: string }> = [
      { code: "directory_busy", expected: "Another session is working in this project; wait for it to finish" },
      { code: "session_busy", expected: "This chat is still working; wait for it to finish" },
      { code: "working_tree_changed", expected: "Files changed while reverting; nothing was written" },
      {
        code: "ambiguous_hunk",
        files: [{ path: "src/a.ts", status: "modified" }],
        expected: "Could not revert src/a.ts: the change no longer matches the file",
      },
      {
        code: "binary_diff_unsupported",
        files: [{ path: "assets/logo.png", status: "modified" }],
        expected: "Could not revert assets/logo.png: binary files are not supported",
      },
      { code: "SCOPED_REVERT_TIMEOUT", expected: "Reverting timed out; check the working tree before retrying" },
    ]

    const { setActionRefs, revertToMessage } = await import("./session-actions")

    for (const testCase of cases) {
      const store = createTreeStore()
      const childStores = createChildStores([["/test/project", store]])
      setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")
      scopedRevertHandler = () => Promise.reject(
        new actualOpencodeClientModule.ScopedRevertError("Failed (409)", {
          code: testCase.code,
          status: 409,
          files: testCase.files,
        }),
      )

      let thrown: unknown = null
      try {
        await revertToMessage("session-a", "msg_2")
      } catch (error) {
        thrown = error
      }

      expect(thrown instanceof Error ? thrown.message : "").toBe(testCase.expected)
      expect((thrown as { code?: string }).code).toBe(testCase.code)
      expect(store.getState().message["session-a"]?.map((message) => message.id)).toEqual(["msg_1", "msg_2a", "msg_2", "msg_3"])
      expect((store.getState().session[0] as Session & { revert?: unknown }).revert).toBe(undefined)
    }
  })

  test("leaves unknown failures untouched so callers still see the original message", async () => {
    const store = createTreeStore()
    const childStores = createChildStores([["/test/project", store]])
    scopedRevertHandler = () => Promise.reject(new Error("server rejected revert"))

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown = null
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof Error ? thrown.message : "").toBe("server rejected revert")
  })
})
