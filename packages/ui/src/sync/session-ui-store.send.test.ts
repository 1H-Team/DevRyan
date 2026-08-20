import { beforeEach, describe, expect, mock, test } from "bun:test"

const bunTestHooks = (await import("bun:test")) as unknown as {
  afterEach: (callback: () => void) => void
}
const actualSyncRefsModule = await import("./sync-refs")

const optimisticCalls: Array<{
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
}> = []
const sendMessageCalls: Array<Record<string, unknown>> = []
const sendImmediateSubtaskPromptCalls: Array<Record<string, unknown>> = []
const sendCommandCalls: Array<Record<string, unknown>> = []
const shellCalls: Array<Record<string, unknown>> = []
const unarchiveCalls: string[] = []
const refetchSessionMessagesCalls: string[] = []
const updateSessionTitleCalls: Array<{ sessionId: string; title: string }> = []
const createSessionCalls: Array<{
  title?: string
  directory?: string | null
  parentID?: string | null
  options?: Record<string, unknown>
}> = []
const waitForWorktreeBootstrapCalls: string[] = []
const pendingAnimationCalls: string[] = []
const activeSessionCalls: Array<{ directory: string; sessionId: string }> = []
const prewarmCursorSessionCalls: Array<Record<string, unknown>> = []
const globalUpsertCalls: Array<Record<string, unknown>> = []
const savedSessionAgents: Array<{ sessionId: string; agent: string }> = []
const savedSessionModels: Array<{ sessionId: string; providerID: string; modelID: string }> = []
const savedAgentModels: Array<{ sessionId: string; agent: string; providerID: string; modelID: string }> = []
const savedAgentVariants: Array<{
  sessionId: string
  agent: string
  providerID: string
  modelID: string
  variant?: string
}> = []
const savedDraftAgents: Array<{ draftId: string; agent: string }> = []
const savedDraftModels: Array<{ draftId: string; providerID: string; modelID: string }> = []
const savedDraftAgentModels: Array<{ draftId: string; agent: string; providerID: string; modelID: string }> = []
const savedDraftAgentVariants: Array<{
  draftId: string
  agent: string
  providerID: string
  modelID: string
  variant?: string
}> = []
const configSetAgentCalls: Array<{ agentName: string; options?: Record<string, unknown> }> = []
const configSetProviderModelCalls: Array<{ providerId: string; modelId: string; variant?: string }> = []
const configApplyDefaultsCalls: Array<{
  preserveCurrentModel?: boolean
}> = []
const activatedConfigDirectories: Array<string | null | undefined> = []
const managedBranchTargetCalls: Array<{ projectId: string; branchName: string; idempotencyKey: string }> = []
const rejectQuestionCalls: Array<{ sessionId: string; requestId: string }> = []
let sessionAgentSelections = new Map<string, string>()
let builderHandoffClearedSessions = new Set<string>()
let draftAgentSelections = new Map<string, string>()
let draftModelSelections = new Map<string, { providerId: string; modelId: string }>()
let draftAgentModelSelections = new Map<string, Map<string, { providerId: string; modelId: string }>>()
let draftAgentModelVariants = new Map<string, Map<string, Map<string, string>>>()
let selectedPlanMode = false
let viewportMemoryState = new Map<string, Record<string, unknown>>()
let mockCreatedSession: Record<string, unknown> | null = null
let mockConfigState: Record<string, unknown> = {}
let mockDirectoryState: Record<string, unknown> = { command: [] }
let mockAllSyncSessions: Array<Record<string, unknown>> = [
  { id: "session-a", directory: "/repo/a" },
  { id: "session-b", directory: "/repo/b" },
]
let mockSyncMessages: Array<Record<string, unknown>> = []
let mockPartsByMessage = new Map<string, Array<Record<string, unknown>>>()
let mockSourceParts: Array<Record<string, unknown>> = []
let mockChildStoreState: Record<string, unknown> = { message: {}, part: {} }
let mockSessionDirectoryAnyDirectory: string | undefined
let mockQuestionsBySession = new Map<string, Array<Record<string, unknown>>>()
let mockDescendantSessionIds = new Map<string, string[]>()
let mockArchivedSessions: Array<Record<string, unknown>> = []
let rejectNextSendMessage = false
let rejectNextQuestionWith: Error | null = null
let deferNextSendMessage = false
let deferredSendMessage: { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void } | null = null
let deferNextCreateSession = false
let deferredCreateSession: { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void } | null = null
let selectCreatedSessionDuringCreate = false
let deferredActivateDirectoryResolve: (() => void) | null = null
let deferManagedBranchTarget = false
let deferredManagedBranchTarget: {
  promise: Promise<Record<string, unknown>>
  resolve: (value: Record<string, unknown>) => void
  reject: (reason?: unknown) => void
} | null = null
let nextWorktreeBootstrapError: Error | null = null

function createDeferredSend() {
  let resolve!: (value: unknown) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const createMockSessionRecord = (
  title?: string,
  directory?: string | null,
  parentID?: string | null,
  options?: Record<string, unknown>,
): Record<string, unknown> | null => {
  createSessionCalls.push({ title, directory, parentID, options })
  return mockCreatedSession
}

const applyMockChildStoreState = (next: unknown) => {
  const patch = typeof next === "function"
    ? (next as (state: Record<string, unknown>) => Record<string, unknown>)(mockChildStoreState)
    : next
  if (patch && typeof patch === "object") {
    mockChildStoreState = { ...mockChildStoreState, ...(patch as Record<string, unknown>) }
  }
}

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      archivedSessions: mockArchivedSessions,
      upsertSession: (session: Record<string, unknown>) => {
        globalUpsertCalls.push(session)
      },
    }),
  },
}))

mock.module("./session-actions", () => ({
  assertSessionRevertMutationAllowed: mock(() => {}),
  setActionRefs: mock(() => {}),
  setOptimisticRefs: mock(() => {}),
  waitForConnectionOrThrow: mock(() => Promise.resolve()),
  createSession: mock((title?: string, directory?: string | null, parentID?: string | null) => {
    const created = createMockSessionRecord(title, directory, parentID)
    if (selectCreatedSessionDuringCreate && typeof created?.id === "string") {
      useSessionUIStore.getState().setCurrentSession(
        created.id,
        typeof created.directory === "string" ? created.directory : directory ?? null,
      )
    }
    return Promise.resolve(created)
  }),
  createSessionRecord: mock((title?: string, directory?: string | null, parentID?: string | null, options?: Record<string, unknown>) =>
    {
      if (deferNextCreateSession) {
        deferNextCreateSession = false
        createSessionCalls.push({ title, directory, parentID, options })
        deferredCreateSession = createDeferredSend()
        return deferredCreateSession.promise
      }
      return Promise.resolve(createMockSessionRecord(title, directory, parentID, options))
    },
  ),
  consumeLastCreateSessionError: mock(() => null),
  deleteSession: mock(() => Promise.resolve(true)),
  getSessionIdsWithDescendants: mock((sessionIds: string[]) => {
    const result = new Set<string>()
    for (const sessionId of sessionIds) {
      result.add(sessionId)
      for (const childId of mockDescendantSessionIds.get(sessionId) ?? []) {
        result.add(childId)
      }
    }
    return Array.from(result)
  }),
  deleteSessions: mock(() => Promise.resolve({ deletedIds: [], failedIds: [] })),
  deleteSessionInDirectory: mock(() => Promise.resolve(true)),
  archiveSession: mock(() => Promise.resolve(true)),
  archiveSessions: mock(() => Promise.resolve({ archivedIds: [], failedIds: [] })),
  unarchiveSession: mock((id: string) => {
    unarchiveCalls.push(id)
    return Promise.resolve(true)
  }),
  unarchiveSessions: mock(() => Promise.resolve({ unarchivedIds: [], failedIds: [] })),
  updateSessionTitle: mock((sessionId: string, title: string) => {
    updateSessionTitleCalls.push({ sessionId, title })
    return Promise.resolve()
  }),
  shareSession: mock(() => Promise.resolve(null)),
  unshareSession: mock(() => Promise.resolve(null)),
  abortCurrentOperation: mock(() => Promise.resolve()),
  respondToPermission: mock(() => Promise.resolve()),
  dismissPermission: mock(() => Promise.resolve()),
  respondToQuestion: mock(() => Promise.resolve()),
  rejectQuestion: mock((sessionId: string, requestId: string) => {
    rejectQuestionCalls.push({ sessionId, requestId })
    if (rejectNextQuestionWith) {
      const error = rejectNextQuestionWith
      rejectNextQuestionWith = null
      return Promise.reject(error)
    }
    return Promise.resolve()
  }),
  revertToMessage: mock(() => Promise.resolve()),
  refetchSessionMessages: mock((sessionId: string) => {
    refetchSessionMessagesCalls.push(sessionId)
    return Promise.resolve()
  }),
  unrevertSession: mock(() => Promise.resolve()),
  forkFromMessage: mock(() => Promise.resolve()),
  optimisticSend: mock(async (params: {
    sessionId: string
    content: string
    providerID: string
    modelID: string
    agent?: string
    send: (messageID: string) => Promise<void>
    onMessageID?: (messageID: string) => void
    onMessageRollback?: (messageID: string) => void
    messageID?: string
  }) => {
    optimisticCalls.push({
      sessionId: params.sessionId,
      content: params.content,
      providerID: params.providerID,
      modelID: params.modelID,
      agent: params.agent,
    })
    const messageID = params.messageID ?? `message-${optimisticCalls.length}`
    params.onMessageID?.(messageID)
    try {
      await params.send(messageID)
    } catch (error) {
      params.onMessageRollback?.(messageID)
      throw error
    }
  }),
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: undefined,
      currentProviderId: "provider-current",
      currentModelId: "model-current",
      currentVariant: undefined,
      settingsDefaultAgent: undefined,
      agents: [],
      providers: [],
      activateDirectory: mock((directory?: string | null) => {
        activatedConfigDirectories.push(directory)
        return Promise.resolve()
      }),
      applyDefaultsToCurrent: mock((options?: {
        preserveCurrentModel?: boolean
      }) => {
        configApplyDefaultsCalls.push(options ?? {})
      }),
      setAgent: mock((agentName: string, options?: Record<string, unknown>) => {
        configSetAgentCalls.push({ agentName, options })
        mockConfigState = { ...mockConfigState, currentAgentName: agentName }
      }),
      setProviderModel: mock((providerId: string, modelId: string, variant?: string) => {
        configSetProviderModelCalls.push({ providerId, modelId, variant })
        mockConfigState = {
          ...mockConfigState,
          currentProviderId: providerId,
          currentModelId: modelId,
          currentVariant: variant,
        }
      }),
      ...mockConfigState,
    }),
  },
}))

mock.module("@/lib/worktrees/managedBranchTarget", () => ({
  ensureManagedBranchTarget: mock((input: { projectId: string; branchName: string; idempotencyKey: string }) => {
    managedBranchTargetCalls.push(input)
    if (deferManagedBranchTarget) {
      deferManagedBranchTarget = false
      let resolve!: (value: Record<string, unknown>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<Record<string, unknown>>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
      })
      deferredManagedBranchTarget = { promise, resolve, reject }
      return promise
    }
    return Promise.resolve({
      status: "success",
      source: "worktree",
      branchName: input.branchName,
      directory: `/worktrees/${input.branchName}`,
    })
  }),
}))

mock.module("./selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionAgentSelection: (sessionId: string) => sessionAgentSelections.get(sessionId) ?? null,
      markBuilderHandoffCleared: (sessionId: string) => {
        builderHandoffClearedSessions.add(sessionId)
      },
      hasBuilderHandoffClearance: (sessionId: string) => builderHandoffClearedSessions.has(sessionId),
      getDraftAgentSelection: (draftId: string) => draftAgentSelections.get(draftId) ?? null,
      getDraftModelSelection: (draftId: string) => draftModelSelections.get(draftId) ?? null,
      getDraftAgentModelForSelection: (draftId: string, agent: string) =>
        draftAgentModelSelections.get(draftId)?.get(agent) ?? null,
      getDraftAgentModelVariantForSelection: (draftId: string, agent: string, providerID: string, modelID: string) =>
        draftAgentModelVariants.get(draftId)?.get(agent)?.get(`${providerID}/${modelID}`),
      getPlanModeSelection: () => selectedPlanMode,
      saveDraftAgentSelection: (draftId: string, agent: string) => {
        savedDraftAgents.push({ draftId, agent })
        draftAgentSelections.set(draftId, agent)
      },
      saveDraftModelSelection: (draftId: string, providerID: string, modelID: string) => {
        savedDraftModels.push({ draftId, providerID, modelID })
        draftModelSelections.set(draftId, { providerId: providerID, modelId: modelID })
      },
      saveDraftAgentModelForSelection: (draftId: string, agent: string, providerID: string, modelID: string) => {
        savedDraftAgentModels.push({ draftId, agent, providerID, modelID })
        const agentMap = draftAgentModelSelections.get(draftId) ?? new Map()
        agentMap.set(agent, { providerId: providerID, modelId: modelID })
        draftAgentModelSelections.set(draftId, agentMap)
      },
      saveDraftAgentModelVariantForSelection: (
        draftId: string,
        agent: string,
        providerID: string,
        modelID: string,
        variant?: string,
      ) => {
        savedDraftAgentVariants.push({ draftId, agent, providerID, modelID, variant })
        const agentMap = draftAgentModelVariants.get(draftId) ?? new Map()
        const modelMap = agentMap.get(agent) ?? new Map()
        if (variant) {
          modelMap.set(`${providerID}/${modelID}`, variant)
        } else {
          modelMap.delete(`${providerID}/${modelID}`)
        }
        agentMap.set(agent, modelMap)
        draftAgentModelVariants.set(draftId, agentMap)
      },
      clearDraftSelection: (draftId: string) => {
        draftAgentSelections.delete(draftId)
        draftModelSelections.delete(draftId)
        draftAgentModelSelections.delete(draftId)
        draftAgentModelVariants.delete(draftId)
      },
      saveSessionModelSelection: (sessionId: string, providerID: string, modelID: string) => {
        savedSessionModels.push({ sessionId, providerID, modelID })
      },
      saveSessionAgentSelection: (sessionId: string, agent: string) => {
        savedSessionAgents.push({ sessionId, agent })
        sessionAgentSelections.set(sessionId, agent)
      },
      saveAgentModelForSession: (sessionId: string, agent: string, providerID: string, modelID: string) => {
        savedAgentModels.push({ sessionId, agent, providerID, modelID })
      },
      saveAgentModelVariantForSession: (
        sessionId: string,
        agent: string,
        providerID: string,
        modelID: string,
        variant?: string,
      ) => {
        savedAgentVariants.push({ sessionId, agent, providerID, modelID, variant })
      },
      promoteDraftSelectionToSession: (draftId: string, sessionId: string) => {
        const agent = draftAgentSelections.get(draftId)
        if (agent) {
          savedSessionAgents.push({ sessionId, agent })
          sessionAgentSelections.set(sessionId, agent)
        }
        const model = draftModelSelections.get(draftId)
        if (model) {
          savedSessionModels.push({ sessionId, providerID: model.providerId, modelID: model.modelId })
        }
        const agentModels = draftAgentModelSelections.get(draftId)
        if (agentModels) {
          for (const [agentName, selection] of agentModels.entries()) {
            savedAgentModels.push({
              sessionId,
              agent: agentName,
              providerID: selection.providerId,
              modelID: selection.modelId,
            })
          }
        }
        const agentVariants = draftAgentModelVariants.get(draftId)
        if (agentVariants) {
          for (const [agentName, variants] of agentVariants.entries()) {
            for (const [modelKey, variant] of variants.entries()) {
              const [providerID, modelID] = modelKey.split("/")
              savedAgentVariants.push({ sessionId, agent: agentName, providerID, modelID, variant })
            }
          }
        }
        draftAgentSelections.delete(draftId)
        draftModelSelections.delete(draftId)
        draftAgentModelSelections.delete(draftId)
        draftAgentModelVariants.delete(draftId)
      },
      setSessionPlanMode: mock(() => {}),
      clearDraftPlanMode: mock(() => {}),
    }),
  },
}))

mock.module("./viewport-store", () => ({
  useViewportStore: {
    getState: () => ({
      sessionMemoryState: viewportMemoryState,
    }),
    setState: (next: { sessionMemoryState?: Map<string, Record<string, unknown>> }) => {
      if (next.sessionMemoryState) {
        viewportMemoryState = next.sessionMemoryState
      }
    },
  },
}))

const waitForWorktreeBootstrapMock = mock((directory: string) => {
    waitForWorktreeBootstrapCalls.push(directory)
    if (nextWorktreeBootstrapError) {
      const error = nextWorktreeBootstrapError
      nextWorktreeBootstrapError = null
      return Promise.reject(error)
    }
    return Promise.resolve()
})

mock.module("@/lib/worktrees/worktreeBootstrap", () => ({
  waitForWorktreeBootstrap: waitForWorktreeBootstrapMock,
  waitForWorktreeBootstrapForSend: waitForWorktreeBootstrapMock,
}))

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: mock((sessionId: string) => {
    pendingAnimationCalls.push(sessionId)
  }),
}))

mock.module("./sync-refs", () => ({
  ...actualSyncRefsModule,
  setSyncRefs: () => {},
  clearSyncRefs: () => true,
  registerSessionDirectory: () => {},
  getSyncSDK: () => ({}),
  getSyncChildStores: () => ({
    getAllStores: () => [],
    getStoreForDirectory: () => null,
    ensureChild: () => ({
      getState: () => mockChildStoreState,
      setState: applyMockChildStoreState,
    }),
  }),
  getSyncDirectory: () => "/repo",
  getSyncSessions: () => [],
  getAllSyncSessions: () => mockAllSyncSessions,
  getSyncMessages: () => mockSyncMessages,
  getSyncSessionMaterializationStatus: () => "ready",
  getSyncParts: (messageId: string) => mockPartsByMessage.get(messageId) ?? mockSourceParts,
  getSyncSessionStatus: (sessionId: string) => {
    const statuses = mockChildStoreState.session_status as Record<string, { type?: string }> | undefined
    return statuses?.[sessionId]
  },
  getAllSyncSessionStatuses: () => mockChildStoreState.session_status ?? {},
  getSyncSessionStatusAnyDirectory: (sessionId: string) => {
    const statuses = mockChildStoreState.session_status as Record<string, { type?: string }> | undefined
    return statuses?.[sessionId]
  },
  getSyncSessionDirectoryAnyDirectory: () => mockSessionDirectoryAnyDirectory,
  getSyncPermissions: () => [],
  getSyncQuestions: (sessionId: string) => mockQuestionsBySession.get(sessionId) ?? [],
  getSyncBlockingRequestCountAnyDirectory: (sessionId: string) => (
    (mockQuestionsBySession.get(sessionId)?.length ?? 0)
  ),
  getDirectoryState: () => mockDirectoryState,
}))

mock.module("./sync-context", () => ({
  setActiveSession: mock((directory: string, sessionId: string) => {
    activeSessionCalls.push({ directory, sessionId })
  }),
  useSessionStatus: () => undefined,
}))

const { opencodeClient: testOpencodeClient } = await import("@/lib/opencode/client")
const testOpencodeClientRecord = testOpencodeClient as unknown as Record<string, unknown>
const originalOpencodeClientMethods = {
  getDirectory: testOpencodeClient.getDirectory.bind(testOpencodeClient),
  setDirectory: testOpencodeClient.setDirectory.bind(testOpencodeClient),
  getSdkClient: testOpencodeClient.getSdkClient.bind(testOpencodeClient),
  getContextModeAvailable: testOpencodeClient.getContextModeAvailable.bind(testOpencodeClient),
  sendCommand: testOpencodeClient.sendCommand.bind(testOpencodeClient),
  sendMessage: testOpencodeClient.sendMessage.bind(testOpencodeClient),
  sendImmediateSubtaskPrompt: testOpencodeClient.sendImmediateSubtaskPrompt.bind(testOpencodeClient),
  prewarmCursorSession: testOpencodeClient.prewarmCursorSession.bind(testOpencodeClient),
  deleteSession: testOpencodeClient.deleteSession.bind(testOpencodeClient),
}

const installOpencodeClientMock = () => {
  testOpencodeClientRecord.getDirectory = () => "/repo"
  testOpencodeClientRecord.setDirectory = () => {}
  testOpencodeClientRecord.getSdkClient = () => ({
    session: {
      shell: (params: Record<string, unknown>) => {
        shellCalls.push(params)
        return Promise.resolve({ data: true })
      },
    },
  })
  testOpencodeClientRecord.getContextModeAvailable = () => true
  testOpencodeClientRecord.sendCommand = (params: Record<string, unknown>) => {
    sendCommandCalls.push(params)
    return Promise.resolve({ data: true })
  }
  testOpencodeClientRecord.sendMessage = (params: Record<string, unknown>) => {
    sendMessageCalls.push(params)
    const signal = params.signal as AbortSignal | undefined
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"))
    }
    if (rejectNextSendMessage) {
      rejectNextSendMessage = false
      return Promise.reject(new Error("send failed"))
    }
    if (deferNextSendMessage) {
      deferNextSendMessage = false
      deferredSendMessage = createDeferredSend()
      signal?.addEventListener("abort", () => {
        deferredSendMessage?.reject(new DOMException("Aborted", "AbortError"))
      }, { once: true })
      return deferredSendMessage.promise
    }
    return Promise.resolve({ data: true })
  }
  testOpencodeClientRecord.sendImmediateSubtaskPrompt = (params: Record<string, unknown>) => {
    sendImmediateSubtaskPromptCalls.push(params)
    return Promise.resolve({ data: true })
  }
  testOpencodeClientRecord.prewarmCursorSession = (params: Record<string, unknown>) => {
    prewarmCursorSessionCalls.push(params)
    return Promise.resolve({ ok: true, agentID: "agent-prepared", cacheHit: false })
  }
  testOpencodeClientRecord.deleteSession = () => Promise.resolve(true)
}

const restoreOpencodeClientMock = () => {
  Object.assign(testOpencodeClient, originalOpencodeClientMethods)
}

const {
  buildPlanModeSyntheticInstruction,
  useSessionUIStore,
} = await import("./session-ui-store")
const { resolveEffectivePlanIndicatorState } = await import("./plan-indicator")
const {
  CHAT_DRAFTS_STORAGE_KEY,
  LEGACY_NEW_INPUT_DRAFT_KEY,
  getDraftConfirmedMentionsStorageKey,
  getDraftInputStorageKey,
} = await import("./session-draft-storage")
const { useMessageQueueStore } = await import("@/stores/messageQueueStore")
const { useCommandsStore } = await import("@/stores/useCommandsStore")
const { useSkillsStore } = await import("@/stores/useSkillsStore")
const { useInputStore } = await import("./input-store")
const { useNotificationStore } = await import("./notification-store")
const { useProjectsStore } = await import("@/stores/useProjectsStore")
const { getSafeStorage } = await import("@/stores/utils/safeStorage")
const { useSessionWorktreeStore } = await import("./session-worktree-store")
const { useSessionPlanFileStore } = await import("@/stores/useSessionPlanFileStore")
const { setAuthPrincipal } = await import("@/lib/authSession")

const SESSION_COMPLETION_INDICATOR_SETTLE_MS = 250
const CURSOR_DRAFT_PREWARM_STORAGE_KEY = "openchamber.cursorDraftPrewarmSessions.v1"
const PLAN_MESSAGE_STATE_STORAGE_KEY = "openchamber_plan_message_state"

bunTestHooks.afterEach(() => {
  restoreOpencodeClientMock()
})

const waitForCompletionIndicatorSettlement = async () => {
  await new Promise((resolve) => setTimeout(resolve, SESSION_COMPLETION_INDICATOR_SETTLE_MS + 20))
}

const expectPlanModeInstructionContract = (text: string) => {
  expect(text.startsWith("User has requested to enter plan mode.")).toBe(true)
  expect(text).toContain("<!--plan-->")
  expect(text).toContain("Plan output format")
  expect(text).toContain("# <Plan title — short noun phrase, no \"Implementation Plan:\" prefix>")
  expect(text).toContain("## Context")
  expect(text).toContain("## Critical files")
  expect(text).toContain("**Files modified**")
  expect(text).toContain("**Files read (no edit) for behavior reuse**")
  expect(text).toContain("## Implementation")
  expect(text).toContain("### Phase 1: <name>")
  expect(text).toContain("Each phase must contain multiple related tasks")
  expect(text).toContain("Count only actionable implementation tasks as tasks")
  expect(text).toContain("## Verification")
  expect(text).toContain("The plan card provides the implementation action")
  expect(text).not.toContain("End the message with a single approval question")
  expect(text).toContain("Do not wrap it in a code fence")
  expect(text).toContain("same-session planning history")
  expect(text).toContain("Treat the latest visible user prompt as a revision")
  expect(text).toContain("Preserve every prior requirement, decision, constraint, and file reference")
  expect(text).toContain("complete, self-contained replacement plan")
  expect(text).toContain("Never return only a patch, diff, addendum, or abbreviated delta")
  expect(text).toContain("ctx_index followed by batched ctx_search")
  expect(text).toContain("ctx_fetch_and_index followed by batched ctx_search")
  expect(text).toContain("ctx_execute, ctx_execute_file, and ctx_batch_execute are intentionally unavailable")
  expect(text).toContain("do not retry Context Mode")
}

const createPdfAttachment = () => ({
  id: "pdf-1",
  file: new File(["%PDF-1.4"], "document.pdf", { type: "application/pdf" }),
  dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
  mimeType: "application/pdf",
  filename: "document.pdf",
  size: 8,
  source: "local" as const,
})

const setManagedDeveloper = () => setAuthPrincipal({
  id: "developer-1",
  email: "developer@example.test",
  displayName: "Developer",
  role: "developer",
  scope: "managed",
  policy: {
    settingsPages: [],
    files: true,
    terminal: true,
    browser: true,
    createWorktrees: false,
    createBranches: false,
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: false,
    manageGit: true,
    push: true,
    github: true,
  },
  assignments: [{
    projectId: "project-1",
    label: "Project",
    branchName: "Dev",
    publicDirectory: "/repo",
    githubAccountId: "github-1",
    isDefault: true,
  }],
})

describe("session-ui-store send routing", () => {
  beforeEach(() => {
    restoreOpencodeClientMock()
    installOpencodeClientMock()
    optimisticCalls.length = 0
    sendMessageCalls.length = 0
    sendImmediateSubtaskPromptCalls.length = 0
    sendCommandCalls.length = 0
    shellCalls.length = 0
    unarchiveCalls.length = 0
    refetchSessionMessagesCalls.length = 0
    updateSessionTitleCalls.length = 0
    createSessionCalls.length = 0
    waitForWorktreeBootstrapCalls.length = 0
    pendingAnimationCalls.length = 0
    activeSessionCalls.length = 0
    prewarmCursorSessionCalls.length = 0
    globalUpsertCalls.length = 0
    savedSessionAgents.length = 0
    savedSessionModels.length = 0
    savedAgentModels.length = 0
    savedAgentVariants.length = 0
    savedDraftAgents.length = 0
    savedDraftModels.length = 0
    savedDraftAgentModels.length = 0
    savedDraftAgentVariants.length = 0
    configSetAgentCalls.length = 0
    configSetProviderModelCalls.length = 0
    configApplyDefaultsCalls.length = 0
    activatedConfigDirectories.length = 0
    managedBranchTargetCalls.length = 0
    rejectQuestionCalls.length = 0
    sessionAgentSelections = new Map()
    builderHandoffClearedSessions = new Set()
    draftAgentSelections = new Map()
    draftModelSelections = new Map()
    draftAgentModelSelections = new Map()
    draftAgentModelVariants = new Map()
    selectedPlanMode = false
    viewportMemoryState = new Map()
    mockCreatedSession = null
    mockConfigState = {}
    mockDirectoryState = { command: [] }
    mockAllSyncSessions = [
      { id: "session-a", directory: "/repo/a" },
      { id: "session-b", directory: "/repo/b" },
    ]
    mockSyncMessages = []
    mockPartsByMessage = new Map()
    mockSourceParts = []
    mockChildStoreState = { message: {}, part: {} }
    mockSessionDirectoryAnyDirectory = undefined
    mockQuestionsBySession = new Map()
    mockDescendantSessionIds = new Map()
    mockArchivedSessions = []
    rejectNextSendMessage = false
    rejectNextQuestionWith = null
    deferNextSendMessage = false
    deferredSendMessage = null
    deferNextCreateSession = false
    deferredCreateSession = null
    selectCreatedSessionDuringCreate = false
    deferredActivateDirectoryResolve = null
    deferManagedBranchTarget = false
    deferredManagedBranchTarget = null
    nextWorktreeBootstrapError = null
    setAuthPrincipal(null)
    const storage = getSafeStorage()
    storage.removeItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY)
    storage.removeItem(PLAN_MESSAGE_STATE_STORAGE_KEY)
    storage.removeItem(CHAT_DRAFTS_STORAGE_KEY)
    storage.removeItem(LEGACY_NEW_INPUT_DRAFT_KEY)
    storage.removeItem(getDraftInputStorageKey("draft-send"))
    storage.removeItem(getDraftConfirmedMentionsStorageKey("draft-send"))
    storage.removeItem(getDraftInputStorageKey("draft-other"))
    storage.removeItem(getDraftConfirmedMentionsStorageKey("draft-other"))
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: null,
      draftsById: {},
      draftOrder: [],
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
      pendingChangesBarDismissed: new Map(),
      worktreeMetadata: new Map(),
      sessionDirectoryHints: new Map(),
      webUICreatedSessions: new Set(),
      sessionAbortFlags: new Map(),
      starterAssistantMessages: new Map(),
      sessionPlanAvailable: new Map(),
      sessionPlanIndicator: new Map(),
      sessionCompletionIndicator: new Map(),
      implementedPlanRequests: new Set(),
      externallyHandedOffPlanRequests: new Set(),
      planModeUserMessages: new Set(),
      planModeUserMessagesBySession: new Map(),
      abortControllers: new Map(),
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
    })
    useSessionWorktreeStore.setState({ attachments: new Map() })
    useSessionPlanFileStore.setState({ recordsBySession: {} })
    useInputStore.setState({ pendingInputText: null, pendingInputMode: "replace" })
    useMessageQueueStore.setState({ queuedMessages: {}, queueModeEnabled: true })
    useCommandsStore.setState({ commands: [] })
    useSkillsStore.setState({ skills: [] })
    useProjectsStore.setState({ projects: [], activeProjectId: null })
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
        project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
      },
    })
  })

  test("createSessionFromAssistantMessage seeds a local assistant starter without sending", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockDirectoryState = {
      command: [],
      message: {
        "session-source": [{
          id: "msg_source_assistant",
          sessionID: "session-source",
          role: "assistant",
          time: { created: 10, completed: 20 },
          parentID: "msg_source_user",
          modelID: "model-source",
          providerID: "provider-source",
          mode: "build",
          agent: "agent-source",
          path: { cwd: "/repo", root: "/repo" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }],
      },
    }
    mockSourceParts = [{ id: "prt_source", messageID: "msg_source_assistant", type: "text", text: "Use this answer" }]

    await useSessionUIStore.getState().createSessionFromAssistantMessage("msg_source_assistant")

    expect(sendMessageCalls).toHaveLength(0)
    const starter = useSessionUIStore.getState().starterAssistantMessages.get("session-new")
    expect(starter?.sourceMessageId).toBe("msg_source_assistant")
    expect(starter?.text).toBe("Use this answer")
    expect(starter?.pendingContext).toBe(true)
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-new")
    expect(useInputStore.getState().pendingInputText).toBe(null)
    expect((mockChildStoreState.message as Record<string, Array<Record<string, unknown>>>)["session-new"]?.[0]?.role).toBe("assistant")
    expect((mockChildStoreState.part as Record<string, Array<Record<string, unknown>>>)[starter?.messageId ?? ""]?.[0]?.text).toBe("Use this answer")
  })

  test("does not mark recorded plan-mode sessions proposed before a plan card is presented", () => {
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_1_user", true)

    expect(useSessionUIStore.getState().sessionPlanIndicator.has("session-a")).toBe(false)
  })

  test("persists actionable plan proposals and removes them when implementation starts", () => {
    const storage = getSafeStorage()
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_1_user", true)

    useSessionUIStore.getState().markPlanProposed("session-a", "msg_2_assistant")

    const proposedState = JSON.parse(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY) ?? "{}") as {
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    }
    expect(proposedState.proposedPlanIndicatorsBySession).toEqual([["session-a", "msg_2_assistant"]])

    useSessionUIStore.getState().markPlanImplementing(
      "session-a",
      "msg_2_assistant",
      "msg_3_implementation",
    )

    const implementingState = JSON.parse(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY) ?? "{}") as {
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    }
    expect(implementingState.proposedPlanIndicatorsBySession).toBe(undefined)
  })

  test("persists only the newest proposal revision and restores it after implementation rollback", () => {
    const storage = getSafeStorage()
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_2_assistant")
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_4_assistant")

    const revisedState = JSON.parse(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY) ?? "{}") as {
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    }
    expect(revisedState.proposedPlanIndicatorsBySession).toEqual([["session-a", "msg_4_assistant"]])

    const implementationKey = "session-a:msg_4_assistant:plan:0"
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing(
      "session-a",
      "msg_4_assistant",
      "msg_5_implementation",
    )
    useSessionUIStore.getState().rollbackPlanImplementation(
      "session-a",
      "msg_4_assistant",
      implementationKey,
      "msg_5_implementation",
    )

    const rolledBackState = JSON.parse(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY) ?? "{}") as {
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    }
    expect(rolledBackState.proposedPlanIndicatorsBySession).toEqual([["session-a", "msg_4_assistant"]])
  })

  test("hides an older proposal while a newer plan-mode turn is pending", () => {
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_0001_user", true)
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_0002_assistant")
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_0003_user", true)

    const state = useSessionUIStore.getState()
    expect(resolveEffectivePlanIndicatorState(
      state.sessionPlanIndicator.get("session-a"),
      state.planModeUserMessagesBySession.get("session-a"),
    )).toBeNull()

    useSessionUIStore.getState().markPlanProposed("session-a", "msg_0004_assistant")
    const revisedState = useSessionUIStore.getState()
    expect(resolveEffectivePlanIndicatorState(
      revisedState.sessionPlanIndicator.get("session-a"),
      revisedState.planModeUserMessagesBySession.get("session-a"),
    )).toBe("proposed")
  })

  test("normal-mode follow-ups do not hide an actionable proposal", () => {
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_0001_user", true)
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_0002_assistant")
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_0003_user", false)

    const state = useSessionUIStore.getState()
    expect(resolveEffectivePlanIndicatorState(
      state.sessionPlanIndicator.get("session-a"),
      state.planModeUserMessagesBySession.get("session-a"),
    )).toBe("proposed")
  })

  test("failed plan-mode sends restore the previous proposal indicator", async () => {
    const sourceMessageId = "message-0"
    useSessionUIStore.getState().markPlanProposed("session-a", sourceMessageId)
    deferNextSendMessage = true

    const sendPromise = useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "revise the plan",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      true,
    )
    for (let attempt = 0; attempt < 10 && !deferredSendMessage; attempt += 1) {
      await Promise.resolve()
    }
    expect(deferredSendMessage).not.toBeNull()

    const pendingState = useSessionUIStore.getState()
    const pendingPlanMessageId = pendingState.planModeUserMessagesBySession.get("session-a")
    expect(pendingPlanMessageId).toBeTruthy()
    if (!pendingPlanMessageId) throw new Error("expected pending plan-mode message ownership")
    expect(pendingPlanMessageId > sourceMessageId).toBe(true)
    expect(resolveEffectivePlanIndicatorState(
      pendingState.sessionPlanIndicator.get("session-a"),
      pendingState.planModeUserMessagesBySession.get("session-a"),
    )).toBeNull()

    deferredSendMessage?.reject(new Error("send failed"))
    let sendError: unknown
    try {
      await sendPromise
    } catch (error) {
      sendError = error
    }
    expect(sendError).toBeInstanceOf(Error)
    expect((sendError as Error).message).toBe("send failed")

    const rolledBackState = useSessionUIStore.getState()
    expect(resolveEffectivePlanIndicatorState(
      rolledBackState.sessionPlanIndicator.get("session-a"),
      rolledBackState.planModeUserMessagesBySession.get("session-a"),
    )).toBe("proposed")
  })

  test("opening a new draft clears the active session tracker", () => {
    useSessionUIStore.getState().setCurrentSession("session-a", "/repo/a")
    activeSessionCalls.length = 0

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })

    expect(useSessionUIStore.getState().currentSessionId).toBe(null)
    expect(activeSessionCalls).toEqual([{ directory: "", sessionId: "" }])
  })

  test("retargeting an open draft to a worktree preserves its text and send configuration", () => {
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: "project-1",
      directoryOverride: "/repo",
      initialPrompt: "keep this draft",
      sendConfig: { providerID: "provider-a", modelID: "model-a" },
    })

    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: "project-1",
      directoryOverride: "/worktrees/Dev",
    }, { force: true })
    useSessionUIStore.getState().setDraftPreserveDirectoryOverride(true)

    const state = useSessionUIStore.getState()
    const currentDraft = state.currentDraftId ? state.draftsById[state.currentDraftId] : null
    expect(state.newSessionDraft.directoryOverride).toBe("/worktrees/Dev")
    expect(state.newSessionDraft.preserveDirectoryOverride).toBe(true)
    expect(currentDraft?.text).toBe("keep this draft")
    expect(currentDraft?.sendConfig).toEqual({ providerID: "provider-a", modelID: "model-a" })
  })

  test("a managed root draft stays fail-closed until its assigned Dev worktree resolves", async () => {
    setManagedDeveloper()
    useProjectsStore.setState({
      projects: [{
        id: "project-1",
        path: "/repo",
        branches: [{ name: "Dev", directory: "/repo", isDefault: true }],
      }],
      activeProjectId: "project-1",
    })
    deferManagedBranchTarget = true

    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: "project-1",
      directoryOverride: "/repo",
      preserveDirectoryOverride: true,
    })

    const pending = useSessionUIStore.getState().newSessionDraft
    expect(pending.directoryOverride).toBeNull()
    expect(pending.bootstrapPendingDirectory).toBeNull()
    expect(pending.pendingWorktreeRequestId).toBeTruthy()
    expect(pending.targetBranchName).toBe("Dev")
    expect(managedBranchTargetCalls).toHaveLength(1)

    deferredManagedBranchTarget?.resolve({
      status: "success",
      source: "worktree",
      branchName: "Dev",
      directory: "/worktrees/Dev",
    })
    await deferredManagedBranchTarget?.promise
    await Promise.resolve()
    await Promise.resolve()

    const resolved = useSessionUIStore.getState().newSessionDraft
    expect(resolved.pendingWorktreeRequestId).toBeNull()
    expect(resolved.directoryOverride).toBe("/worktrees/Dev")
    expect(resolved.bootstrapPendingDirectory).toBeNull()
  })

  test("selecting a restored managed root draft reconciles it to the assigned branch", async () => {
    setManagedDeveloper()
    useProjectsStore.setState({
      projects: [{
        id: "project-1",
        path: "/repo",
        branches: [{ name: "Dev", directory: "/repo", isDefault: true }],
      }],
      activeProjectId: "project-1",
    })
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: null,
      draftsById: {
        "draft-stale-root": {
          id: "draft-stale-root",
          text: "restored",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: "project-1",
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-stale-root"],
    })

    useSessionUIStore.getState().selectNewSessionDraft("draft-stale-root")

    const pending = useSessionUIStore.getState().newSessionDraft
    expect(pending.directoryOverride).toBeNull()
    expect(pending.targetBranchName).toBe("Dev")
    expect(managedBranchTargetCalls).toHaveLength(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe("/worktrees/Dev")
  })

  test("a send queued during managed preparation creates the session only in Dev", async () => {
    setManagedDeveloper()
    useProjectsStore.setState({
      projects: [{
        id: "project-1",
        path: "/repo",
        branches: [{ name: "Dev", directory: "/repo", isDefault: true }],
      }],
      activeProjectId: "project-1",
    })
    deferManagedBranchTarget = true
    mockCreatedSession = { id: "session-managed", directory: "/worktrees/Dev" }
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: "project-1" })

    const sendPromise = useSessionUIStore.getState().sendMessage(
      "hello",
      "provider-current",
      "model-current",
      "Orchestrator",
    )
    await Promise.resolve()
    expect(createSessionCalls).toHaveLength(0)

    deferredManagedBranchTarget?.resolve({
      status: "pending",
      source: "worktree",
      branchName: "Dev",
      directory: "/worktrees/Dev",
    })
    await sendPromise

    expect(createSessionCalls[0]?.directory).toBe("/worktrees/Dev")
    expect(waitForWorktreeBootstrapCalls).toContain("/worktrees/Dev")
    expect(activatedConfigDirectories).toContain("/worktrees/Dev")
    expect(createSessionCalls.some((call) => call.directory === "/repo")).toBe(false)
  })

  test("a failed managed worktree bootstrap leaves the draft intact and creates no empty session", async () => {
    setManagedDeveloper()
    useProjectsStore.setState({
      projects: [{
        id: "project-1",
        path: "/repo",
        branches: [{ name: "Dev", directory: "/repo", isDefault: true }],
      }],
      activeProjectId: "project-1",
    })
    deferManagedBranchTarget = true
    mockCreatedSession = { id: "session-must-not-exist", directory: "/worktrees/Dev" }
    nextWorktreeBootstrapError = new Error("Git could not finalize the worktree index")
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: "project-1" })

    const sendPromise = useSessionUIStore.getState().sendMessage(
      "hello",
      "provider-current",
      "model-current",
      "Orchestrator",
    )
    await Promise.resolve()
    deferredManagedBranchTarget?.resolve({
      status: "pending",
      source: "worktree",
      branchName: "Dev",
      directory: "/worktrees/Dev",
    })

    let sendError = ""
    try {
      await sendPromise
    } catch (error) {
      sendError = error instanceof Error ? error.message : String(error)
    }
    expect(sendError).toBe("Git could not finalize the worktree index")
    expect(waitForWorktreeBootstrapCalls).toEqual(["/worktrees/Dev"])
    expect(createSessionCalls).toEqual([])
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
  })

  test("opening a fresh draft shows the configured Orchestrator model and High variant before activation settles", async () => {
    const activation = createDeferredSend()
    mockConfigState = {
      currentAgentName: "orchestrator",
      currentProviderId: "openai",
      currentModelId: "gpt-5.6-sol",
      currentVariant: "medium",
      settingsDefaultAgent: "orchestrator",
      agents: [{
        name: "orchestrator",
        mode: "primary",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        variant: "high",
      }],
      providers: [{
        id: "openai",
        models: [{ id: "gpt-5.6-sol", variants: { medium: {}, high: {} } }],
      }],
      activateDirectory: mock((directory?: string | null) => {
        activatedConfigDirectories.push(directory)
        mockConfigState = { ...mockConfigState, currentVariant: "medium" }
        return activation.promise.then(() => undefined)
      }),
      applyDefaultsToCurrent: mock((options?: { preserveCurrentModel?: boolean }) => {
        configApplyDefaultsCalls.push(options ?? {})
        mockConfigState = { ...mockConfigState, currentVariant: "high" }
      }),
    }
    useSessionUIStore.getState().setCurrentSession("session-a", "/repo/a")

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })

    expect(mockConfigState.currentVariant).toBe("high")
    expect(configApplyDefaultsCalls).toEqual([{
      preserveCurrentModel: false,
    }])

    activation.resolve(undefined)
    await activation.promise
    await Promise.resolve()
    await Promise.resolve()

    expect(mockConfigState.currentVariant).toBe("high")
    expect(configApplyDefaultsCalls).toEqual([
      { preserveCurrentModel: false },
      { preserveCurrentModel: false },
    ])
  })

  test("opening an explicitly configured draft preserves its selected model", async () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/repo",
      sendConfig: {
        providerID: "openai",
        modelID: "gpt-5.6",
        variant: "ultra",
        modelProvenance: "explicit",
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(configApplyDefaultsCalls).toEqual([
      { preserveCurrentModel: true },
      { preserveCurrentModel: true },
    ])
  })

  test("late fresh-draft activation cannot overwrite a newer session", async () => {
    const activation = createDeferredSend()
    mockConfigState = {
      activateDirectory: mock(() => activation.promise.then(() => undefined)),
    }

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    useSessionUIStore.getState().setCurrentSession("session-b", "/repo/b")
    activation.resolve(undefined)
    await activation.promise
    await Promise.resolve()

    expect(useSessionUIStore.getState().currentSessionId).toBe("session-b")
    expect(configApplyDefaultsCalls).toEqual([{ preserveCurrentModel: false }])
  })

  test("opening a startup draft preserves reload-compatible config-only drafts", () => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: null,
      draftsById: {
        "draft-reloaded": {
          id: "draft-reloaded",
          text: "",
          createdAt: 1,
          updatedAt: 2,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
          sendConfig: {
            providerID: "cursor-acp",
            modelID: "composer-2.5-fast",
            agent: "builder",
            modelProvenance: "explicit",
          },
        },
      },
      draftOrder: ["draft-reloaded"],
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
    })

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })

    const state = useSessionUIStore.getState()
    expect(state.draftsById["draft-reloaded"]?.sendConfig).toEqual({
      providerID: "cursor-acp",
      modelID: "composer-2.5-fast",
      agent: "builder",
      modelProvenance: "explicit",
    })
    expect(state.draftOrder).toContain("draft-reloaded")
    expect(getSafeStorage().getItem(CHAT_DRAFTS_STORAGE_KEY)).toContain("draft-reloaded")
  })

  test("selecting an existing draft clears the active session tracker", () => {
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    const draftId = useSessionUIStore.getState().currentDraftId
    expect(draftId).toBeTruthy()

    useSessionUIStore.getState().setCurrentSession("session-a", "/repo/a")
    activeSessionCalls.length = 0

    useSessionUIStore.getState().selectNewSessionDraft(draftId ?? "")

    expect(useSessionUIStore.getState().currentSessionId).toBe(null)
    expect(useSessionUIStore.getState().currentDraftId).toBe(draftId)
    expect(activeSessionCalls).toEqual([{ directory: "", sessionId: "" }])
  })

  test("selecting a draft restores live agent/model from authoritative draft selection after activation", async () => {
    mockConfigState = {
      currentAgentName: "stale-agent",
      currentProviderId: "stale-provider",
      currentModelId: "stale-model",
      currentVariant: "stale",
      settingsDefaultAgent: "builder",
      agents: [{
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
      }],
      providers: [{
        id: "anthropic",
        models: [{ id: "claude-sonnet-4-5", variants: { high: {}, medium: {} } }],
      }, {
        id: "openai",
        models: [{ id: "gpt-5.2", variants: { low: {}, medium: {} } }],
      }],
      activateDirectory: mock(() => Promise.resolve()),
    }

    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-restore",
      draftsById: {
        "draft-restore": {
          id: "draft-restore",
          text: "hello",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
          sendConfig: {
            providerID: "openai",
            modelID: "gpt-5.2",
            agent: "builder",
            variant: "low",
            modelProvenance: "explicit",
          },
        },
      },
      draftOrder: ["draft-restore"],
      newSessionDraft: {
        open: true,
        id: "draft-restore",
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "openai",
          modelID: "gpt-5.2",
          agent: "builder",
          variant: "low",
          modelProvenance: "explicit",
        },
      },
    })

    useSessionUIStore.getState().selectNewSessionDraft("draft-restore")
    await Promise.resolve()
    await Promise.resolve()

    expect(configSetAgentCalls).toEqual([{
      agentName: "builder",
      options: { preserveCurrentModel: true, recordSessionSelection: false },
    }])
    expect(configSetProviderModelCalls).toEqual([{
      providerId: "openai",
      modelId: "gpt-5.2",
      variant: "low",
    }])
    expect(savedDraftAgents).toEqual([{ draftId: "draft-restore", agent: "builder" }])
    expect(savedDraftModels).toEqual([{
      draftId: "draft-restore",
      providerID: "openai",
      modelID: "gpt-5.2",
    }])
  })

  test("selecting a draft skips restore when a newer draft becomes current before activation settles", async () => {
    const activation = createDeferredSend()
    mockConfigState = {
      currentAgentName: "stale-agent",
      currentProviderId: "stale-provider",
      currentModelId: "stale-model",
      agents: [{
        name: "builder",
        mode: "primary",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
      }],
      providers: [{
        id: "anthropic",
        models: [{ id: "claude-sonnet-4-5", variants: { high: {} } }],
      }],
      activateDirectory: mock(() => activation.promise.then(() => undefined)),
    }

    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-a",
      draftsById: {
        "draft-a": {
          id: "draft-a",
          text: "a",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
          sendConfig: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
            agent: "builder",
            variant: "high",
            modelProvenance: "explicit",
          },
        },
        "draft-b": {
          id: "draft-b",
          text: "b",
          createdAt: 2,
          updatedAt: 2,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-a", "draft-b"],
      newSessionDraft: {
        open: true,
        id: "draft-a",
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          agent: "builder",
          variant: "high",
          modelProvenance: "explicit",
        },
      },
    })

    useSessionUIStore.getState().selectNewSessionDraft("draft-a")
    useSessionUIStore.setState({
      currentDraftId: "draft-b",
      newSessionDraft: {
        open: true,
        id: "draft-b",
        directoryOverride: "/repo",
        parentID: null,
      },
    })
    activation.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(configSetAgentCalls).toEqual([])
    expect(configSetProviderModelCalls).toEqual([])
  })

  test("clears recorded plan-mode session ownership once implementation starts", () => {
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_1_user", true)

    useSessionUIStore.getState().markPlanImplementing("session-a", "msg_2_assistant")

    expect(useSessionUIStore.getState().planModeUserMessagesBySession.has("session-a")).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "implementing",
      sourceMessageId: "msg_2_assistant",
    })
  })

  test("clears only the matching handed-off plan indicator and persists released ownership", () => {
    const storage = getSafeStorage()
    useSessionUIStore.getState().recordUserMessagePlanMode("session-a", "msg_1_user", true)
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_2_assistant")

    useSessionUIStore.getState().clearHandedOffPlanIndicator("session-a", "msg_2_assistant")

    const state = useSessionUIStore.getState()
    expect(state.sessionPlanIndicator.has("session-a")).toBe(false)
    expect(state.planModeUserMessagesBySession.has("session-a")).toBe(false)
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
    expect(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY)).toContain('"planModeUserMessagesBySession":[]')
    expect(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY)).not.toContain("proposedPlanIndicatorsBySession")
  })

  test("does not clear a newer plan revision during a stale mobile handoff", () => {
    const planIndicator = new Map([["session-a", { state: "proposed" as const, sourceMessageId: "msg_4_assistant" }]])
    const ownership = new Map([["session-a", "msg_3_user"]])
    useSessionUIStore.setState({ sessionPlanIndicator: planIndicator, planModeUserMessagesBySession: ownership })

    useSessionUIStore.getState().clearHandedOffPlanIndicator("session-a", "msg_2_assistant")

    const state = useSessionUIStore.getState()
    expect(state.sessionPlanIndicator).toBe(planIndicator)
    expect(state.planModeUserMessagesBySession).toBe(ownership)
  })

  test("does not clear a completed plan indicator during a handoff", () => {
    const planIndicator = new Map([["session-a", { state: "completed" as const, sourceMessageId: "msg_2_assistant" }]])
    const ownership = new Map([["session-a", "msg_1_user"]])
    useSessionUIStore.setState({ sessionPlanIndicator: planIndicator, planModeUserMessagesBySession: ownership })

    useSessionUIStore.getState().clearHandedOffPlanIndicator("session-a", "msg_2_assistant")

    const state = useSessionUIStore.getState()
    expect(state.sessionPlanIndicator).toBe(planIndicator)
    expect(state.planModeUserMessagesBySession).toBe(ownership)
  })

  test("clears normal completion indicators when a session is read", () => {
    useSessionUIStore.setState({
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-a", completedAt: 123 }],
      ]),
      sessionPlanIndicator: new Map(),
    })

    useSessionUIStore.getState().clearReadCompletionIndicators(["session-a"])

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has("session-a")).toBe(false)
  })

  test("selecting a session clears normal and completed plan indicators but preserves proposed plans", () => {
    mockDescendantSessionIds.set("session-a", ["session-child"])
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([
        ["session-a", true],
        ["session-child", true],
      ]),
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-a", completedAt: 123 }],
        ["session-child", { messageId: "msg-child", completedAt: 456 }],
      ]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "proposed", sourceMessageId: "msg-plan" }],
        ["session-child", { state: "completed", sourceMessageId: "msg-child-plan" }],
      ]),
    })

    useSessionUIStore.getState().setCurrentSession("session-a", "/repo")

    const state = useSessionUIStore.getState()
    expect(state.sessionCompletionIndicator.has("session-a")).toBe(false)
    expect(state.sessionCompletionIndicator.has("session-child")).toBe(false)
    expect(state.sessionPlanIndicator.get("session-a")).toEqual({
      state: "proposed",
      sourceMessageId: "msg-plan",
    })
    expect(state.sessionPlanIndicator.has("session-child")).toBe(false)
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
    expect(state.sessionPlanAvailable.get("session-child")).toBe(true)
  })

  test("selecting a session synchronously marks root and descendant completion notifications read", () => {
    mockDescendantSessionIds.set("session-a", ["session-child"])
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: "/repo",
      session: "session-a",
      messageId: "msg-a",
      time: Date.now(),
      viewed: false,
    })
    useNotificationStore.getState().append({
      type: "turn-complete",
      directory: "/repo",
      session: "session-child",
      messageId: "msg-child",
      time: Date.now(),
      viewed: false,
    })

    useSessionUIStore.getState().setCurrentSession("session-a", "/repo")

    expect(useNotificationStore.getState().sessionHasCompletion("session-a")).toBe(false)
    expect(useNotificationStore.getState().sessionHasCompletion("session-child")).toBe(false)
    expect(useNotificationStore.getState().list.every((notification) => notification.viewed)).toBe(true)
  })

  test("settles normal completion indicators before showing them", async () => {
    useSessionUIStore.setState({
      sessionCompletionIndicator: new Map(),
      sessionPlanIndicator: new Map(),
    })

    useSessionUIStore.getState().markSessionTurnCompleted("session-a", "msg-a", 123)

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has("session-a")).toBe(false)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.get("session-a")).toEqual({
      messageId: "msg-a",
      completedAt: 123,
    })
  })

  test("does not show settled normal completion when live status became busy", async () => {
    mockSessionDirectoryAnyDirectory = "/repo"
    mockChildStoreState = {
      message: {},
      part: {},
      session_status: {
        "session-a": { type: "idle" },
      },
    }
    useSessionUIStore.setState({
      sessionCompletionIndicator: new Map(),
      sessionPlanIndicator: new Map(),
    })

    useSessionUIStore.getState().markSessionTurnCompleted("session-a", "msg-a", 123)
    mockChildStoreState = {
      ...mockChildStoreState,
      session_status: {
        "session-a": { type: "busy" },
      },
    }

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has("session-a")).toBe(false)
  })

  test("does not show completion while live status is busy even when the trailing tool turn is finalized", async () => {
    mockSessionDirectoryAnyDirectory = "/repo"
    const liveState = {
      message: {
        "session-a": [{
          id: "msg-a",
          role: "assistant",
          time: { created: 1, completed: 123 },
        }],
      },
      part: {
        "msg-a": [{
          id: "part-tool-a",
          messageID: "msg-a",
          type: "tool",
          state: {
            status: "completed",
            time: { start: 1, end: 2 },
          },
        }],
      },
      permission: {},
      question: {},
      session_status: {
        "session-a": { type: "busy" },
      },
      session: [],
      revert_transaction: {},
    }
    mockChildStoreState = liveState
    mockDirectoryState = liveState
    useSessionUIStore.setState({
      sessionCompletionIndicator: new Map(),
      sessionPlanIndicator: new Map(),
    })

    useSessionUIStore.getState().markSessionTurnCompleted("session-a", "msg-a", 123)

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionCompletionIndicator.has("session-a")).toBe(false)
  })

  test("clears completed plan indicators when a session is acknowledged without hiding plan availability", () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "completed", sourceMessageId: "msg-plan" }],
      ]),
      sessionCompletionIndicator: new Map(),
    })

    useSessionUIStore.getState().clearReadCompletionIndicators(["session-a"])

    const state = useSessionUIStore.getState()
    expect(state.sessionPlanIndicator.has("session-a")).toBe(false)
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
  })

  test("preserves proposed plan indicators when a session is acknowledged", () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "proposed", sourceMessageId: "msg-plan" }],
      ]),
      sessionCompletionIndicator: new Map(),
    })

    useSessionUIStore.getState().clearReadCompletionIndicators(["session-a"])

    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "proposed",
      sourceMessageId: "msg-plan",
    })
  })

  test("settles completed plan indicators before showing them", async () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", {
          state: "implementing",
          sourceMessageId: "msg-plan",
          implementationMessageId: "msg-implementation-user",
        }],
      ]),
      sessionCompletionIndicator: new Map(),
    })

    useSessionUIStore.getState().markPlanCompleted("session-a", "msg-plan")

    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "implementing",
      sourceMessageId: "msg-plan",
      implementationMessageId: "msg-implementation-user",
    })

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "completed",
      sourceMessageId: "msg-plan",
      implementationMessageId: "msg-implementation-user",
    })
  })

  test("cancels pending completed plan indicators when a session is acknowledged before settlement", async () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", {
          state: "implementing",
          sourceMessageId: "msg-plan",
          implementationMessageId: "msg-implementation-user",
        }],
      ]),
      sessionCompletionIndicator: new Map(),
    })

    useSessionUIStore.getState().markPlanCompleted("session-a", "msg-plan")
    useSessionUIStore.getState().clearReadCompletionIndicators(["session-a"])

    await waitForCompletionIndicatorSettlement()

    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "implementing",
      sourceMessageId: "msg-plan",
      implementationMessageId: "msg-implementation-user",
    })
    expect(useSessionUIStore.getState().sessionPlanAvailable.get("session-a")).toBe(true)
  })

  test("clearSessionTurnCompletion clears completed plan indicators", () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "completed", sourceMessageId: "msg-plan" }],
      ]),
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-complete", completedAt: 123 }],
      ]),
    })

    useSessionUIStore.getState().clearSessionTurnCompletion("session-a")

    const state = useSessionUIStore.getState()
    expect(state.sessionCompletionIndicator.has("session-a")).toBe(false)
    expect(state.sessionPlanIndicator.has("session-a")).toBe(false)
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
  })

  test("clearSessionTurnCompletion preserves proposed plan indicators", () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "proposed", sourceMessageId: "msg-plan" }],
      ]),
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-complete", completedAt: 123 }],
      ]),
    })

    useSessionUIStore.getState().clearSessionTurnCompletion("session-a")

    const state = useSessionUIStore.getState()
    expect(state.sessionCompletionIndicator.has("session-a")).toBe(false)
    expect(state.sessionPlanIndicator.get("session-a")).toEqual({
      state: "proposed",
      sourceMessageId: "msg-plan",
    })
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
  })

  test("clearSessionTurnCompletion preserves implementing plan indicators", () => {
    useSessionUIStore.setState({
      sessionPlanAvailable: new Map([["session-a", true]]),
      sessionPlanIndicator: new Map([
        ["session-a", {
          state: "implementing",
          sourceMessageId: "msg-plan",
          implementationMessageId: "msg-implementation-user",
        }],
      ]),
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-complete", completedAt: 123 }],
      ]),
    })

    useSessionUIStore.getState().clearSessionTurnCompletion("session-a")

    const state = useSessionUIStore.getState()
    expect(state.sessionCompletionIndicator.has("session-a")).toBe(false)
    expect(state.sessionPlanIndicator.get("session-a")).toEqual({
      state: "implementing",
      sourceMessageId: "msg-plan",
      implementationMessageId: "msg-implementation-user",
    })
    expect(state.sessionPlanAvailable.get("session-a")).toBe(true)
  })

  test("retireDeletedSession removes only exact session UI ownership and persisted plan state", () => {
    const targetController = new AbortController()
    const retainedController = new AbortController()
    const targetWorktree = {
      path: "/repo/session-a",
      projectDirectory: "/repo",
      branch: "target",
      label: "Target",
    }
    const retainedWorktree = {
      path: "/repo/session-b",
      projectDirectory: "/repo",
      branch: "retained",
      label: "Retained",
    }
    const retainedStarter = {
      sessionId: "session-b",
      sourceMessageId: "msg-source-b",
      messageId: "msg-starter-b",
      partId: "prt-starter-b",
      text: "Retained starter",
      createdAt: 2,
      pendingContext: true,
    }

    useSessionUIStore.setState({
      abortPromptSessionId: "session-a",
      abortPromptExpiresAt: 123,
      worktreeMetadata: new Map([
        ["session-a", targetWorktree],
        ["session-b", retainedWorktree],
      ]),
      sessionDirectoryHints: new Map([
        ["session-a", "/repo/session-a"],
        ["session-b", "/repo/session-b"],
      ]),
      webUICreatedSessions: new Set(["session-a", "session-b"]),
      sessionAbortFlags: new Map([
        ["session-a", { timestamp: 1, acknowledged: false }],
        ["session-b", { timestamp: 2, acknowledged: true }],
      ]),
      abortControllers: new Map([
        ["session-a", targetController],
        ["session-b", retainedController],
      ]),
      sessionPlanAvailable: new Map([
        ["session-a", true],
        ["session-b", true],
      ]),
      sessionPlanIndicator: new Map([
        ["session-a", { state: "proposed", sourceMessageId: "msg-plan-a" }],
        ["session-b", { state: "proposed", sourceMessageId: "msg-plan-b" }],
      ]),
      sessionCompletionIndicator: new Map([
        ["session-a", { messageId: "msg-complete-a", completedAt: 10 }],
        ["session-b", { messageId: "msg-complete-b", completedAt: 20 }],
      ]),
      planModeUserMessages: new Set(["msg-plan-user-a", "msg-plan-user-b"]),
      planModeUserMessagesBySession: new Map([
        ["session-a", "msg-plan-user-a"],
        ["session-b", "msg-plan-user-b"],
      ]),
      implementedPlanRequests: new Set([
        "session-a:msg-plan-a:plan:0",
        "session-a-other:msg-near-prefix:plan:0",
        "session-b:msg-plan-b:plan:0",
      ]),
      starterAssistantMessages: new Map([
        ["session-a", {
          sessionId: "session-a",
          sourceMessageId: "msg-source-a",
          messageId: "msg-starter-a",
          partId: "prt-starter-a",
          text: "Target starter",
          createdAt: 1,
          pendingContext: true,
        }],
        ["session-b", retainedStarter],
      ]),
      pendingChangesBarDismissed: new Map([
        ["session-a", "sig-a"],
        ["session-b", "sig-b"],
      ]),
    })
    useSessionWorktreeStore.setState({
      attachments: new Map([
        ["session-a", {
          worktreeRoot: "/repo/session-a",
          cwd: "/repo/session-a",
          branch: "target",
          headState: "branch",
          worktreeStatus: "ready",
          worktreeSource: "existing",
          legacy: false,
          degraded: false,
        }],
        ["session-b", {
          worktreeRoot: "/repo/session-b",
          cwd: "/repo/session-b",
          branch: "retained",
          headState: "branch",
          worktreeStatus: "ready",
          worktreeSource: "existing",
          legacy: false,
          degraded: false,
        }],
      ]),
    })
    useSessionPlanFileStore.getState().beginSaving("session-a", "msg-plan-a")
    useSessionPlanFileStore.getState().markSaved("session-a", "msg-plan-a", "/plans/a.md", {
      sessionId: "session-a",
      sourceMessageId: "msg-plan-a",
      directory: "/repo/session-a",
      sessionCreated: 1,
      sessionSlug: "Plan A",
    })
    useSessionPlanFileStore.getState().beginSaving("session-b", "msg-plan-b")
    useSessionPlanFileStore.getState().markSaved("session-b", "msg-plan-b", "/plans/b.md", {
      sessionId: "session-b",
      sourceMessageId: "msg-plan-b",
      directory: "/repo/session-b",
      sessionCreated: 2,
      sessionSlug: "Plan B",
    })
    const storage = getSafeStorage()
    storage.setItem(PLAN_MESSAGE_STATE_STORAGE_KEY, JSON.stringify({
      planModeUserMessages: ["msg-plan-user-a", "msg-plan-user-b"],
      planModeUserMessagesBySession: [
        ["session-a", "msg-plan-user-a"],
        ["session-b", "msg-plan-user-b"],
      ],
      implementedPlanRequests: [
        "session-a:msg-plan-a:plan:0",
        "session-a-other:msg-near-prefix:plan:0",
        "session-b:msg-plan-b:plan:0",
      ],
      proposedPlanIndicatorsBySession: [
        ["session-a", "msg-plan-a"],
        ["session-b", "msg-plan-b"],
      ],
    }))
    storage.setItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY, JSON.stringify([
      { draftId: "draft-a", sessionID: "session-a", directory: "/repo/session-a", createdAt: 1 },
      { draftId: "draft-b", sessionID: "session-b", directory: "/repo/session-b", createdAt: 2 },
    ]))

    type SessionUIStateWithRetirement = ReturnType<typeof useSessionUIStore.getState> & {
      retireDeletedSession?: (sessionId: string) => void
    }
    const retireDeletedSession = (useSessionUIStore.getState() as SessionUIStateWithRetirement).retireDeletedSession
    expect(typeof retireDeletedSession).toBe("function")
    retireDeletedSession?.("session-a")

    const state = useSessionUIStore.getState()
    expect(targetController.signal.aborted).toBe(true)
    expect(retainedController.signal.aborted).toBe(false)
    expect(state.abortPromptSessionId).toBe(null)
    expect(state.abortPromptExpiresAt).toBe(null)
    expect(state.worktreeMetadata.has("session-a")).toBe(false)
    expect(state.worktreeMetadata.get("session-b")).toBe(retainedWorktree)
    expect(state.sessionDirectoryHints).toEqual(new Map([["session-b", "/repo/session-b"]]))
    expect(state.webUICreatedSessions).toEqual(new Set(["session-b"]))
    expect(state.sessionAbortFlags.has("session-a")).toBe(false)
    expect(state.abortControllers.has("session-a")).toBe(false)
    expect(state.sessionPlanAvailable.has("session-a")).toBe(false)
    expect(state.sessionPlanIndicator.has("session-a")).toBe(false)
    expect(state.sessionCompletionIndicator.has("session-a")).toBe(false)
    expect(state.planModeUserMessages).toEqual(new Set(["msg-plan-user-b"]))
    expect(state.planModeUserMessagesBySession).toEqual(new Map([["session-b", "msg-plan-user-b"]]))
    expect(state.implementedPlanRequests).toEqual(new Set([
      "session-a-other:msg-near-prefix:plan:0",
      "session-b:msg-plan-b:plan:0",
    ]))
    expect(state.starterAssistantMessages.has("session-a")).toBe(false)
    expect(state.starterAssistantMessages.get("session-b")).toBe(retainedStarter)
    expect(state.pendingChangesBarDismissed).toEqual(new Map([["session-b", "sig-b"]]))
    expect(useSessionWorktreeStore.getState().attachments.has("session-a")).toBe(false)
    expect(useSessionWorktreeStore.getState().attachments.has("session-b")).toBe(true)
    expect(useSessionPlanFileStore.getState().recordsBySession["session-a"]).toBe(undefined)
    expect(useSessionPlanFileStore.getState().recordsBySession["session-b"]?.path).toBe("/plans/b.md")

    const persistedPlanState = JSON.parse(storage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY) ?? "{}") as {
      planModeUserMessages?: string[]
      planModeUserMessagesBySession?: Array<[string, string]>
      implementedPlanRequests?: string[]
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    }
    expect(persistedPlanState).toEqual({
      planModeUserMessages: ["msg-plan-user-b"],
      planModeUserMessagesBySession: [["session-b", "msg-plan-user-b"]],
      implementedPlanRequests: [
        "session-a-other:msg-near-prefix:plan:0",
        "session-b:msg-plan-b:plan:0",
      ],
      proposedPlanIndicatorsBySession: [["session-b", "msg-plan-b"]],
    })
    expect(JSON.parse(storage.getItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY) ?? "[]")).toEqual([
      { draftId: "draft-b", sessionID: "session-b", directory: "/repo/session-b", createdAt: 2 },
    ])
  })

  test("retireDeletedSession no-ops without replacing unrelated collection references", () => {
    const before = useSessionUIStore.getState()
    const collectionReferences = {
      worktreeMetadata: before.worktreeMetadata,
      sessionDirectoryHints: before.sessionDirectoryHints,
      webUICreatedSessions: before.webUICreatedSessions,
      sessionAbortFlags: before.sessionAbortFlags,
      abortControllers: before.abortControllers,
      sessionPlanAvailable: before.sessionPlanAvailable,
      sessionPlanIndicator: before.sessionPlanIndicator,
      sessionCompletionIndicator: before.sessionCompletionIndicator,
      planModeUserMessages: before.planModeUserMessages,
      planModeUserMessagesBySession: before.planModeUserMessagesBySession,
      implementedPlanRequests: before.implementedPlanRequests,
      starterAssistantMessages: before.starterAssistantMessages,
      pendingChangesBarDismissed: before.pendingChangesBarDismissed,
    }

    type SessionUIStateWithRetirement = ReturnType<typeof useSessionUIStore.getState> & {
      retireDeletedSession?: (sessionId: string) => void
    }
    const retireDeletedSession = (before as SessionUIStateWithRetirement).retireDeletedSession
    expect(typeof retireDeletedSession).toBe("function")
    retireDeletedSession?.("missing-session")

    const after = useSessionUIStore.getState()
    for (const [key, reference] of Object.entries(collectionReferences)) {
      expect(after[key as keyof typeof collectionReferences]).toBe(reference)
    }
  })

  test("sendMessageToSession exposes implementation send message ids", async () => {
    const messageIds: string[] = []

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Implement the approved plan",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      false,
      {
        onMessageID: (messageID: string) => messageIds.push(messageID),
      },
    )

    expect(messageIds).toEqual(["message-1"])
  })

  test("sendMessageToSession preserves queued client identity and directory", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-a" })

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "queued prompt",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      false,
      { messageID: "msg_queued_client_id", directory: "/repo/queued" } as never,
    )

    expect(sendMessageCalls.at(-1)?.messageId).toBe("msg_queued_client_id")
    expect(sendMessageCalls.at(-1)?.directory).toBe("/repo/queued")
  })

  test("sendMessage defensively creates a session when no draft or current session exists", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }

    await useSessionUIStore.getState().sendMessage(
      "start a new chat",
      "provider-a",
      "model-a",
      "builder",
    )

    expect(createSessionCalls).toEqual([{ title: undefined, directory: "/repo", parentID: null, options: undefined }])
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-created")
    expect(optimisticCalls).toEqual([{
      sessionId: "session-created",
      content: "start a new chat",
      providerID: "provider-a",
      modelID: "model-a",
      agent: "builder",
    }])
    expect(sendMessageCalls[0]?.id).toBe("session-created")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-a")
    expect(sendMessageCalls[0]?.modelID).toBe("model-a")
    expect(sendMessageCalls[0]?.text).toBe("start a new chat")
    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.directory).toBe("/repo")
  })

  test("new OpenAI draft sessions leave automatic title generation to the server runtime", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "fix the OpenAI session title regression",
      "openai",
      "gpt-5.6",
    )

    expect(createSessionCalls[0]?.title).toBe(undefined)
  })

  test("new standard-provider draft sessions leave automatic title generation to the server runtime", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "summarize this session with the selected provider",
      "provider-a",
      "model-a",
    )

    expect(createSessionCalls[0]?.title).toBe(undefined)
  })

  test("new OpenAI draft sessions preserve an explicit custom title", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: {
        open: true,
        directoryOverride: "/repo",
        parentID: null,
        title: "Custom session name",
      },
    })

    await useSessionUIStore.getState().sendMessage("fix the title", "openai", "gpt-5.6")

    expect(createSessionCalls[0]?.title).toBe("Custom session name")
  })

  test("Cursor draft model changes remain local until the first send", async () => {
    mockConfigState = {
      currentAgentName: "builder",
      currentProviderId: "provider-a",
      currentModelId: "model-a",
      currentVariant: undefined,
      settingsDefaultAgent: "builder",
      agents: [{ name: "builder", mode: "primary" }],
      providers: [
        { id: "provider-a", models: [{ id: "model-a" }] },
        {
          id: "cursor-acp",
          models: [{ id: "composer-2.5", variants: { low: {}, high: {} } }],
        },
      ],
    }
    mockCreatedSession = { id: "session-should-not-exist", directory: "/repo" }

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    const draftId = useSessionUIStore.getState().currentDraftId
    expect(draftId).toBeTruthy()

    useSessionUIStore.getState().updateNewSessionDraftSendConfig({
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
      variant: "low",
      modelProvenance: "explicit",
    })
    useSessionUIStore.getState().updateNewSessionDraftSendConfig({
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
      variant: "high",
      modelProvenance: "explicit",
    })
    useSessionUIStore.getState().updateNewSessionDraftSendConfig({
      providerID: "provider-a",
      modelID: "model-a",
      agent: "builder",
      variant: undefined,
      modelProvenance: "explicit",
    })
    useSessionUIStore.getState().updateNewSessionDraftSendConfig({
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
      variant: "high",
      modelProvenance: "explicit",
    })

    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }

    expect(createSessionCalls).toEqual([])
    expect(prewarmCursorSessionCalls).toEqual([])
    expect(getSafeStorage().getItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY)).toBe(null)
    expect(useSessionUIStore.getState().newSessionDraft.sendConfig).toEqual({
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
      variant: "high",
      modelProvenance: "explicit",
    })
  })

  test("replacing and discarding Cursor drafts never creates a server session", async () => {
    mockConfigState = {
      currentProviderId: "cursor-acp",
      currentModelId: "composer-2.5",
      currentVariant: undefined,
      providers: [{ id: "cursor-acp", models: [{ id: "composer-2.5" }] }],
    }
    mockCreatedSession = { id: "session-should-not-exist", directory: "/repo" }

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    const firstDraftId = useSessionUIStore.getState().currentDraftId
    expect(firstDraftId).toBeTruthy()

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    const secondDraftId = useSessionUIStore.getState().currentDraftId
    expect(secondDraftId).toBeTruthy()
    expect(secondDraftId).not.toBe(firstDraftId)

    useSessionUIStore.getState().deleteNewSessionDraft(secondDraftId ?? "")
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }

    expect(createSessionCalls).toEqual([])
    expect(prewarmCursorSessionCalls).toEqual([])
  })

  test("Cursor first send creates one normal session with the final draft selection", async () => {
    mockConfigState = {
      currentAgentName: "builder",
      currentProviderId: "provider-a",
      currentModelId: "model-a",
      currentVariant: undefined,
      settingsDefaultAgent: "builder",
      agents: [{ name: "builder", mode: "primary" }],
      providers: [
        { id: "provider-a", models: [{ id: "model-a" }] },
        {
          id: "cursor-acp",
          models: [{ id: "composer-2.5", variants: { low: {}, high: {} } }],
        },
      ],
    }
    mockCreatedSession = { id: "session-created", directory: "/repo" }

    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/repo" })
    const draftId = useSessionUIStore.getState().currentDraftId
    expect(draftId).toBeTruthy()
    draftAgentSelections.set(draftId ?? "", "builder")
    draftModelSelections.set(draftId ?? "", {
      providerId: "cursor-acp",
      modelId: "composer-2.5",
    })
    draftAgentModelSelections.set(draftId ?? "", new Map([
      ["builder", { providerId: "cursor-acp", modelId: "composer-2.5" }],
    ]))
    draftAgentModelVariants.set(draftId ?? "", new Map([
      ["builder", new Map([["cursor-acp/composer-2.5", "high"]])],
    ]))
    useSessionUIStore.getState().updateNewSessionDraftSendConfig({
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
      variant: "high",
      modelProvenance: "explicit",
    })

    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve()
    }

    await useSessionUIStore.getState().sendMessage(
      "start cursor chat",
      "provider-a",
      "model-a",
      "builder",
    )

    expect(createSessionCalls).toEqual([{
      title: undefined,
      directory: "/repo",
      parentID: null,
      options: undefined,
    }])
    expect(prewarmCursorSessionCalls).toEqual([])
    expect(globalUpsertCalls).toEqual([])
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-created")
    expect(optimisticCalls[0]).toEqual({
      sessionId: "session-created",
      content: "start cursor chat",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      agent: "builder",
    })
    expect(sendMessageCalls[0]?.id).toBe("session-created")
    expect(sendMessageCalls[0]?.providerID).toBe("cursor-acp")
    expect(sendMessageCalls[0]?.modelID).toBe("composer-2.5")
    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.variant).toBe("high")
  })

  test("new draft sends expose a pending abort target before prompt acceptance", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    deferNextCreateSession = true
    deferNextSendMessage = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "start a new chat",
          createdAt: 1,
          updatedAt: 1,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: { open: true, id: "draft-send", directoryOverride: "/repo", parentID: null },
    })

    const sendPromise = useSessionUIStore.getState().sendMessage(
      "start a new chat",
      "provider-a",
      "model-a",
      "builder",
    )
    await Promise.resolve()

    expect((useSessionUIStore.getState() as unknown as { hasPendingSendAbort: (key: string) => boolean }).hasPendingSendAbort("draft:draft-send")).toBe(true)
    expect(sendMessageCalls).toHaveLength(0)

    deferredCreateSession?.resolve(mockCreatedSession)
    await Promise.resolve()
    expect((useSessionUIStore.getState() as unknown as { hasPendingSendAbort: (key: string) => boolean }).hasPendingSendAbort("session-created")).toBe(true)
    expect((useSessionUIStore.getState() as unknown as { hasPendingSendAbort: (key: string) => boolean }).hasPendingSendAbort("draft:draft-send")).toBe(false)
    expect(sendMessageCalls[0]?.signal).toBeInstanceOf(AbortSignal)

    deferredSendMessage?.resolve({ data: true })
    await sendPromise
  })

  test("concurrent sends claim one draft once and use its captured text", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    deferNextCreateSession = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "the complete draft prompt",
          createdAt: 1,
          updatedAt: 1,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: { open: true, id: "draft-send", directoryOverride: "/repo", parentID: null },
    })

    const firstSend = useSessionUIStore.getState().sendMessage(
      "the complete draft prompt",
      "provider-a",
      "model-a",
      "builder",
    )
    await Promise.resolve()

    useSessionUIStore.setState((state) => ({
      draftsById: {
        ...state.draftsById,
        "draft-send": {
          ...state.draftsById["draft-send"],
          text: "the truncated draft",
          updatedAt: 2,
        },
      },
    }))
    const duplicateSend = useSessionUIStore.getState().sendMessage(
      "the truncated draft",
      "provider-a",
      "model-a",
      "builder",
    )

    expect(createSessionCalls).toHaveLength(1)
    deferredCreateSession?.resolve(mockCreatedSession)
    await Promise.all([firstSend, duplicateSend])

    expect(createSessionCalls).toHaveLength(1)
    expect(optimisticCalls).toHaveLength(1)
    expect(optimisticCalls[0]?.content).toBe("the complete draft prompt")
    expect(sendMessageCalls).toHaveLength(1)
    expect(savedSessionModels).toHaveLength(1)
    expect(useSessionUIStore.getState().draftsById["draft-send"]).toBe(undefined)
  })

  test("aborting a claimed draft before creation releases it for one explicit retry", async () => {
    mockCreatedSession = { id: "session-aborted", directory: "/repo" }
    deferNextCreateSession = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "retry this draft",
          createdAt: 1,
          updatedAt: 1,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: { open: true, id: "draft-send", directoryOverride: "/repo", parentID: null },
    })

    const abortedSend = useSessionUIStore.getState().sendMessage(
      "retry this draft",
      "provider-a",
      "model-a",
    )
    await Promise.resolve()
    expect(useSessionUIStore.getState().abortPendingSend("draft:draft-send")).toBe(true)
    deferredCreateSession?.resolve(mockCreatedSession)
    let abortedError: unknown = null
    try {
      await abortedSend
    } catch (error) {
      abortedError = error
    }
    expect(abortedError).toBeInstanceOf(Error)

    expect(useSessionUIStore.getState().draftsById["draft-send"]?.text).toBe("retry this draft")
    expect(useSessionUIStore.getState().hasPendingSendAbort("draft:draft-send")).toBe(false)

    mockCreatedSession = { id: "session-retry", directory: "/repo" }
    await useSessionUIStore.getState().sendMessage(
      "retry this draft",
      "provider-a",
      "model-a",
    )
    expect(createSessionCalls).toHaveLength(2)
    expect(sendMessageCalls).toHaveLength(1)
  })

  test("aborting a promoted draft send cancels prompt acceptance and clears pending state", async () => {
    mockCreatedSession = { id: "session-created", directory: "/repo" }
    deferNextSendMessage = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "stop me",
          createdAt: 1,
          updatedAt: 1,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: { open: true, id: "draft-send", directoryOverride: "/repo", parentID: null },
    })

    const sendPromise = useSessionUIStore.getState().sendMessage(
      "stop me",
      "provider-a",
      "model-a",
      "builder",
    )
    await Promise.resolve()
    await Promise.resolve()

    expect((useSessionUIStore.getState() as unknown as { abortPendingSend: (key: string) => boolean }).abortPendingSend("session-created")).toBe(true)

    let thrown: unknown = null
    try {
      await sendPromise
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((sendMessageCalls[0]?.signal as AbortSignal | undefined)?.aborted).toBe(true)
    expect((useSessionUIStore.getState() as unknown as { hasPendingSendAbort: (key: string) => boolean }).hasPendingSendAbort("session-created")).toBe(false)
  })

  test("blocks PDF attachments before optimistic send when model explicitly lacks PDF input", async () => {
    mockConfigState = {
      getModelMetadata: () => ({
        id: "model-a",
        providerId: "provider-a",
        name: "Model A",
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    }

    let error: unknown
    try {
      await useSessionUIStore.getState().sendMessageToSession(
        "session-a",
        "read this",
        "provider-a",
        "model-a",
        undefined,
        [createPdfAttachment()],
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (caught) {
      error = caught
    }

    expect(error instanceof Error ? error.message : "").toContain("does not support PDF input")
    expect(optimisticCalls).toHaveLength(0)
    expect(sendMessageCalls).toHaveLength(0)
  })

  test("sends PDF attachments when model input modalities include PDF", async () => {
    mockConfigState = {
      getModelMetadata: () => ({
        id: "model-a",
        providerId: "provider-a",
        name: "Model A",
        attachment: false,
        modalities: { input: ["text", "pdf"], output: ["text"] },
      }),
    }

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "read this",
      "provider-a",
      "model-a",
      undefined,
      [createPdfAttachment()],
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(optimisticCalls).toHaveLength(1)
    expect(sendMessageCalls[0]?.files).toEqual([
      {
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,JVBERi0xLjQ=",
        filename: "document.pdf",
      },
    ])
  })

  test("failed implementation sends roll back plan implementation state", async () => {
    const implementationKey = "session-a:msg_2_assistant:plan:0"
    useSessionUIStore.getState().markPlanProposed("session-a", "msg_2_assistant")
    useSessionUIStore.getState().markPlanImplementationRequested(implementationKey)
    useSessionUIStore.getState().markPlanImplementing("session-a", "msg_2_assistant")
    rejectNextSendMessage = true
    let thrown: unknown

    try {
      await useSessionUIStore.getState().sendMessageToSession(
        "session-a",
        "Implement the approved plan",
        "provider-a",
        "model-a",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
        false,
        {
          onMessageID: (messageID: string) => {
            useSessionUIStore.getState().markPlanImplementing("session-a", "msg_2_assistant", messageID)
          },
          onMessageRollback: (messageID: string) => {
            useSessionUIStore.getState().rollbackPlanImplementation("session-a", "msg_2_assistant", implementationKey, messageID)
          },
        },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("send failed")
    expect(useSessionUIStore.getState().implementedPlanRequests.has(implementationKey)).toBe(false)
    expect(useSessionUIStore.getState().sessionPlanIndicator.get("session-a")).toEqual({
      state: "proposed",
      sourceMessageId: "msg_2_assistant",
    })
  })

  test("tracks mobile handoffs separately from same-session implementations", () => {
    const implementationKey = "session-a:msg_2_assistant:plan:0"

    useSessionUIStore.getState().markPlanImplementationHandedOff(implementationKey)

    const state = useSessionUIStore.getState()
    expect(state.externallyHandedOffPlanRequests.has(implementationKey)).toBe(true)
    expect(state.implementedPlanRequests.has(implementationKey)).toBe(false)
    expect(state.isPlanSourceImplemented("session-a", "msg_2_assistant")).toBe(true)
  })

  test("starter assistant context is sent once with the first real user prompt", async () => {
    useSessionUIStore.setState({
      currentSessionId: "session-a",
      starterAssistantMessages: new Map([[
        "session-a",
        {
          sessionId: "session-a",
          sourceMessageId: "msg_source_assistant",
          messageId: "local_starter_msg_1",
          partId: "local_starter_prt_1",
          text: "Prior assistant answer",
          createdAt: 1,
          pendingContext: true,
        },
      ]]),
    })

    await useSessionUIStore.getState().sendMessage(
      "my follow-up",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls[0]?.text).toBe("my follow-up")
    const firstAdditionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
    expect(firstAdditionalParts?.[0]?.synthetic).toBe(true)
    expect(String(firstAdditionalParts?.[0]?.text)).toContain("Prior assistant answer")
    expect(useSessionUIStore.getState().starterAssistantMessages.get("session-a")?.pendingContext).toBe(false)

    await useSessionUIStore.getState().sendMessage(
      "second follow-up",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls[1]?.text).toBe("second follow-up")
    expect(sendMessageCalls[1]?.additionalParts).toBe(undefined)
  })

  test("adds synthetic handoff context when switching from Cursor SDK to a non-Cursor provider", async () => {
    mockSyncMessages = [
      {
        id: "msg_1",
        role: "user",
        providerID: "cursor-acp",
        modelID: "composer-2.5",
        time: { created: 1 },
      },
      {
        id: "msg_1_assistant",
        role: "assistant",
        providerID: "cursor-acp",
        modelID: "composer-2.5",
        time: { created: 2 },
      },
    ]
    mockPartsByMessage = new Map([
      ["msg_1", [{ id: "prt_1", messageID: "msg_1", type: "text", text: "What did Cursor do?" }]],
      ["msg_1_assistant", [{ id: "prt_2", messageID: "msg_1_assistant", type: "text", text: "Cursor changed the reviews page." }]],
    ])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue with OpenCode",
      "anthropic",
      "claude-sonnet-4-5",
      "builder",
    )

    const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
    expect(additionalParts?.[0]?.synthetic).toBe(true)
    expect(String(additionalParts?.[0]?.text)).toContain("Conversation context from Cursor SDK turns")
    expect(String(additionalParts?.[0]?.text)).toContain("User: What did Cursor do?")
    expect(String(additionalParts?.[0]?.text)).toContain("Assistant: Cursor changed the reviews page.")
  })

  test("adds synthetic handoff context when switching from OpenCode to Cursor SDK", async () => {
    mockSyncMessages = [{
      id: "msg_open_assistant",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      time: { created: 1 },
    }]
    mockPartsByMessage = new Map([[
      "msg_open_assistant",
      [{ id: "prt_open", messageID: "msg_open_assistant", type: "text", text: "OpenCode retained this detail." }],
    ]])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue in Cursor",
      "cursor-acp",
      "composer-2.5",
      "builder",
    )

    const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
    expect(additionalParts?.[0]?.synthetic).toBe(true)
    expect(String(additionalParts?.[0]?.text)).toContain("Conversation context from OpenCode turns")
    expect(String(additionalParts?.[0]?.text)).toContain("Assistant: OpenCode retained this detail.")
  })

  test("does not add synthetic handoff context between OpenCode providers", async () => {
    mockSyncMessages = [{
      id: "msg_anthropic",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      time: { created: 1 },
    }]
    mockPartsByMessage = new Map([[
      "msg_anthropic",
      [{ id: "prt_anthropic", messageID: "msg_anthropic", type: "text", text: "Native history" }],
    ]])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue with OpenAI",
      "openai",
      "gpt-5.5",
      "builder",
    )

    expect(sendMessageCalls[0]?.additionalParts).toBe(undefined)
  })

  test("does not copy synthetic context into a later runtime handoff", async () => {
    mockSyncMessages = [{
      id: "msg_cursor",
      role: "assistant",
      providerID: "cursor-acp",
      modelID: "composer-2.5",
      time: { created: 1 },
    }]
    mockPartsByMessage = new Map([[
      "msg_cursor",
      [
        { id: "prt_synthetic", messageID: "msg_cursor", type: "text", text: "STALE_SYNTHETIC_CONTEXT", synthetic: true },
        { id: "prt_visible", messageID: "msg_cursor", type: "text", text: "Newest real Cursor reply." },
      ],
    ]])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue with OpenCode",
      "anthropic",
      "claude-sonnet-4-5",
      "builder",
    )

    const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
    const handoff = String(additionalParts?.[0]?.text)
    expect(handoff).toContain("Newest real Cursor reply.")
    expect(handoff).not.toContain("STALE_SYNTHETIC_CONTEXT")
  })

  test("prioritizes newest messages when cross-runtime handoff context exceeds its budget", async () => {
    mockSyncMessages = Array.from({ length: 8 }, (_, index) => ({
      id: `msg_long_${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      time: { created: index + 1 },
    }))
    mockPartsByMessage = new Map(mockSyncMessages.map((message, index) => {
      const marker = index === 0 ? "OLDEST_CONTEXT" : index === 7 ? "NEWEST_CONTEXT" : `CONTEXT_${index + 1}`
      return [
        String(message.id),
        [{ id: `prt_long_${index + 1}`, messageID: message.id, type: "text", text: `${marker}:${"x".repeat(1390)}` }],
      ] as const
    }))

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue with the newest context",
      "cursor-acp",
      "composer-2.5",
      "builder",
    )

    const additionalParts = sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined
    const handoff = String(additionalParts?.[0]?.text)
    expect(handoff).toContain("NEWEST_CONTEXT")
    expect(handoff).not.toContain("OLDEST_CONTEXT")
    expect(handoff).toContain("[older conversation context omitted]")
    expect(handoff.length <= 6000).toBe(true)
    expect(handoff.indexOf("CONTEXT_5")).toBeLessThan(handoff.indexOf("NEWEST_CONTEXT"))
  })

  test("does not add synthetic handoff context for same-backend model switches", async () => {
    mockSyncMessages = [
      {
        id: "msg_1",
        role: "user",
        providerID: "cursor-acp",
        modelID: "composer-2.5",
        time: { created: 1 },
      },
    ]
    mockPartsByMessage = new Map([
      ["msg_1", [{ id: "prt_1", messageID: "msg_1", type: "text", text: "Cursor prompt" }]],
    ])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "Continue in Cursor",
      "cursor-acp",
      "composer-2.5",
      "builder",
    )

    expect(sendMessageCalls[0]?.additionalParts).toBe(undefined)
  })

  test("starter assistant context remains pending for shell sends", async () => {
    useSessionUIStore.setState({
      currentSessionId: "session-a",
      starterAssistantMessages: new Map([[
        "session-a",
        {
          sessionId: "session-a",
          sourceMessageId: "msg_source_assistant",
          messageId: "local_starter_msg_1",
          partId: "local_starter_prt_1",
          text: "Prior assistant answer",
          createdAt: 1,
          pendingContext: true,
        },
      ]]),
    })

    await useSessionUIStore.getState().sendMessage(
      "ls",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "shell",
    )

    expect(sendMessageCalls).toHaveLength(0)
    expect(useSessionUIStore.getState().starterAssistantMessages.get("session-a")?.pendingContext).toBe(true)
  })

  test("sendMessageToSession sends to the queued session even when another session is current", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-b" })
    mockConfigState = {
      providers: [
        {
          id: "provider-a",
          models: [
            {
              id: "model-a",
              variants: {
                "variant-a": {},
              },
            },
          ],
        },
      ],
    }

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "queued for A",
      "provider-a",
      "model-a",
      "agent-a",
      undefined,
      undefined,
      undefined,
      "variant-a",
      "normal",
    )

    expect(optimisticCalls).toHaveLength(1)
    expect(optimisticCalls[0]).toEqual({
      sessionId: "session-a",
      content: "queued for A",
      providerID: "provider-a",
      modelID: "model-a",
      agent: "agent-a",
    })
    expect(sendMessageCalls[0]?.id).toBe("session-a")
    expect(sendMessageCalls[0]?.text).toBe("queued for A")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-a")
    expect(sendMessageCalls[0]?.modelID).toBe("model-a")
    expect(sendMessageCalls[0]?.agent).toBe("agent-a")
    expect(sendMessageCalls[0]?.variant).toBe("variant-a")
    expect(waitForWorktreeBootstrapCalls).toEqual([])
    expect(pendingAnimationCalls).toEqual(["session-a"])
  })

  test("sendMessageToSession queues next turn and dismisses root-session questions", async () => {
    mockConfigState = {
      providers: [
        {
          id: "provider-a",
          models: [{ id: "model-a", variants: { "variant-a": {} } }],
        },
      ],
    }
    mockQuestionsBySession.set("session-a", [{ id: "q-root", sessionID: "session-a" }])
    mockChildStoreState = {
      message: {},
      part: {},
      question: {
        "session-a": [{ id: "q-root", sessionID: "session-a" }],
      },
    }

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "answer later",
      "provider-a",
      "model-a",
      "agent-a",
      undefined,
      undefined,
      undefined,
      "variant-a",
      "normal",
      true,
    )

    expect(sendMessageCalls).toHaveLength(0)
    expect(optimisticCalls).toHaveLength(0)
    expect(rejectQuestionCalls).toEqual([{ sessionId: "session-a", requestId: "q-root" }])
    expect((mockChildStoreState.question as Record<string, unknown[]>)["session-a"]).toEqual([])
    const queuedPrompt = useMessageQueueStore.getState().getQueueForSession("session-a")[0]
    expect(queuedPrompt?.content).toBe("answer later")
    const sendConfig = queuedPrompt?.sendConfig
    if (!sendConfig) {
      throw new Error("expected queued prompt send config")
    }
    expect(sendConfig.providerID).toBe("provider-a")
    expect(sendConfig.modelID).toBe("model-a")
    expect(sendConfig.agent).toBe("agent-a")
    expect(sendConfig.variant).toBe("variant-a")
    expect(sendConfig.planMode).toBe(true)
  })

  test("sendMessageToSession dismisses descendant questions before queueing next turn", async () => {
    mockDescendantSessionIds.set("session-a", ["session-child"])
    mockQuestionsBySession.set("session-child", [{ id: "q-child", sessionID: "session-child" }])
    mockChildStoreState = {
      message: {},
      part: {},
      question: {
        "session-child": [{ id: "q-child", sessionID: "session-child" }],
      },
    }

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "queued after child question",
      "provider-a",
      "model-a",
      "agent-a",
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls).toHaveLength(0)
    expect(rejectQuestionCalls).toEqual([{ sessionId: "session-child", requestId: "q-child" }])
    expect((mockChildStoreState.question as Record<string, unknown[]>)["session-child"]).toEqual([])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")[0]?.content).toBe("queued after child question")
  })

  test("sendMessageToSession ignores already-gone question dismiss errors", async () => {
    mockQuestionsBySession.set("session-a", [{ id: "q-gone", sessionID: "session-a" }])
    rejectNextQuestionWith = new Error("Question not found")

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "queued after gone",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls).toHaveLength(0)
    expect(rejectQuestionCalls).toEqual([{ sessionId: "session-a", requestId: "q-gone" }])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")[0]?.content).toBe("queued after gone")
  })

  test("sendMessageToSession surfaces real question dismiss failures without dropping queued prompt", async () => {
    mockQuestionsBySession.set("session-a", [{ id: "q-fail", sessionID: "session-a" }])
    rejectNextQuestionWith = new Error("network failed")

    let caughtError: unknown = null
    try {
      await useSessionUIStore.getState().sendMessageToSession(
        "session-a",
        "keep queued",
        "provider-a",
        "model-a",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (error) {
      caughtError = error
    }

    expect(caughtError instanceof Error).toBe(true)
    expect((caughtError as Error).message).toBe("network failed")

    expect(sendMessageCalls).toHaveLength(0)
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")[0]?.content).toBe("keep queued")
  })

  test("foreground sendMessage continues to send to the current session", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "current chat",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(optimisticCalls).toHaveLength(1)
    expect(optimisticCalls[0].sessionId).toBe("session-b")
    expect(sendMessageCalls[0]?.id).toBe("session-b")
    expect(sendMessageCalls[0]?.text).toBe("current chat")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-b")
    expect(sendMessageCalls[0]?.modelID).toBe("model-b")
    expect(waitForWorktreeBootstrapCalls).toEqual([])
  })

  test("active OpenCode child sessions send follow-ups through immediate v2 prompt without optimistic prompt_async", async () => {
    mockAllSyncSessions = [
      { id: "session-parent", directory: "/repo/parent" },
      { id: "session-child", directory: "/repo/child", parentID: "session-parent" },
    ]
    mockSessionDirectoryAnyDirectory = "/repo/child"
    mockChildStoreState = {
      message: {},
      part: {},
      session_status: {
        "session-child": { type: "busy" },
      },
    }
    useSessionUIStore.setState({ currentSessionId: "session-child" })

    await useSessionUIStore.getState().sendMessage(
      "continue from here",
      "anthropic",
      "claude-sonnet-4-5",
      "builder",
      [],
      "reviewer",
      undefined,
      undefined,
      "normal",
    )

    expect(optimisticCalls).toHaveLength(0)
    expect(sendMessageCalls).toHaveLength(0)
    expect(typeof sendImmediateSubtaskPromptCalls[0]?.beforeTransport).toBe("function")
    expect(sendImmediateSubtaskPromptCalls).toEqual([{
      id: "session-child",
      text: "continue from here",
      directory: "/repo/child",
      files: undefined,
      agentMentions: [{ name: "reviewer" }],
      additionalParts: undefined,
      signal: undefined,
      beforeTransport: sendImmediateSubtaskPromptCalls[0]?.beforeTransport,
    }])
    expect(refetchSessionMessagesCalls).toEqual(["session-child"])
    expect(pendingAnimationCalls).toEqual(["session-child"])
  })

  test("active Cursor child sessions fail non-destructively instead of falling back to prompt_async", async () => {
    mockAllSyncSessions = [
      { id: "session-parent", directory: "/repo/parent" },
      { id: "session-child", directory: "/repo/child", parentID: "session-parent" },
    ]
    mockSessionDirectoryAnyDirectory = "/repo/child"
    mockChildStoreState = {
      message: {},
      part: {},
      session_status: {
        "session-child": { type: "busy" },
      },
    }
    mockSyncMessages = [
      {
        id: "msg_cursor_user",
        role: "user",
        model: { providerID: "cursor-acp", modelID: "composer-2.5" },
        time: { created: 1 },
      },
    ]
    useSessionUIStore.setState({ currentSessionId: "session-child" })

    let error: unknown = null
    try {
      await useSessionUIStore.getState().sendMessage(
        "continue",
        "anthropic",
        "claude-sonnet-4-5",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (caught) {
      error = caught
    }

    expect(error instanceof Error ? error.message : String(error)).toContain("Cursor SDK cannot accept live messages into a running subtask yet")

    expect(optimisticCalls).toHaveLength(0)
    expect(sendMessageCalls).toHaveLength(0)
    expect(sendImmediateSubtaskPromptCalls).toHaveLength(0)
    expect(refetchSessionMessagesCalls).toEqual([])
  })

  test("idle child sessions keep the normal send path", async () => {
    mockAllSyncSessions = [
      { id: "session-parent", directory: "/repo/parent" },
      { id: "session-child", directory: "/repo/child", parentID: "session-parent" },
    ]
    mockSessionDirectoryAnyDirectory = "/repo/child"
    mockChildStoreState = {
      message: {},
      part: {},
      session_status: {
        "session-child": { type: "idle" },
      },
    }
    mockSyncMessages = [
      {
        id: "msg_original_assignment",
        role: "user",
        agent: "oracle",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        time: { created: 1 },
      },
      {
        id: "msg_bad_continuation",
        role: "user",
        agent: "orchestrator",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        time: { created: 2 },
      },
    ]
    useSessionUIStore.setState({ currentSessionId: "session-child" })

    await useSessionUIStore.getState().sendMessage(
      "new idle turn",
      "anthropic",
      "claude-sonnet-4-5",
      "orchestrator",
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(optimisticCalls).toHaveLength(1)
    expect(sendMessageCalls[0]?.id).toBe("session-child")
    expect(sendMessageCalls[0]?.text).toBe("new idle turn")
    expect(optimisticCalls[0]?.agent).toBe("oracle")
    expect(sendMessageCalls[0]?.agent).toBe("oracle")
    expect(sendImmediateSubtaskPromptCalls).toHaveLength(0)
    expect(refetchSessionMessagesCalls).toEqual([])
  })

  test("shell sends still wait for worktree bootstrap before calling the SDK", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "npm test",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "shell",
    )

    expect(waitForWorktreeBootstrapCalls).toEqual(["/repo/b"])
    expect(shellCalls[0]?.sessionID).toBe("session-b")
  })

  test("successful normal send unarchives an archived current session", async () => {
    mockArchivedSessions = [{ id: "session-b", time: { archived: 10 } }]
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "current chat",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls[0]?.id).toBe("session-b")
    expect(unarchiveCalls).toEqual(["session-b"])
  })

  test("successful normal send does not unarchive a non-archived current session", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "current chat",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls[0]?.id).toBe("session-b")
    expect(unarchiveCalls).toEqual([])
  })

  test("successful Cursor sends do not persist prompt fallbacks over provider-error titles", async () => {
    mockDirectoryState = {
      command: [],
      session: [{
        id: "session-b",
        directory: "/repo/b",
        title: "cursor-acp error: b: Provider Error",
      }],
    }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "find the services page",
      "cursor-acp",
      "claude-opus-4-7",
      undefined,
      undefined,
      undefined,
      undefined,
      "thinking-medium",
      "normal",
    )

    expect(updateSessionTitleCalls).toEqual([])
  })

  test("successful Cursor sends do not persist prompt fallbacks over generated new-session titles", async () => {
    mockDirectoryState = {
      command: [],
      session: [{
        id: "session-b",
        directory: "/repo/b",
        title: "New session - 2026-05-20T13:18:22.865Z",
      }],
    }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "in /dashboard/professional/calendar, remove the button to export pdf",
      "cursor-acp",
      "claude-opus-4-7",
      undefined,
      undefined,
      undefined,
      undefined,
      "thinking-medium",
      "normal",
    )

    expect(updateSessionTitleCalls).toEqual([])
  })

  test("successful first non-Cursor send leaves an authoritative untitled session unchanged", async () => {
    mockDirectoryState = {
      command: [],
      session: [{ id: "session-b", directory: "/repo/b", title: "Untitled Session" }],
      message: { "session-b": [] },
    }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "fix the OpenAI session title regression",
      "openai",
      "gpt-5.6",
    )

    expect(updateSessionTitleCalls).toEqual([])
  })

  test("successful non-Cursor sends preserve an existing generated title", async () => {
    mockDirectoryState = {
      command: [],
      session: [{ id: "session-b", directory: "/repo/b", title: "Generated by OpenCode" }],
      message: { "session-b": [] },
    }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage("fix the title", "openai", "gpt-5.6")

    expect(updateSessionTitleCalls).toEqual([])
  })

  test("failed non-Cursor sends do not persist a prompt-derived title", async () => {
    mockDirectoryState = {
      command: [],
      session: [{ id: "session-b", directory: "/repo/b", title: "Untitled Session" }],
      message: { "session-b": [] },
    }
    rejectNextSendMessage = true
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    let error: unknown
    try {
      await useSessionUIStore.getState().sendMessage(
        "fix the title",
        "openai",
        "gpt-5.6",
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("send failed")
    expect(updateSessionTitleCalls).toEqual([])
  })

  test("non-Cursor sends do not repair provider-error session titles", async () => {
    mockDirectoryState = {
      command: [],
      session: [{
        id: "session-b",
        directory: "/repo/b",
        title: "cursor-acp error: b: Provider Error",
      }],
    }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "find the services page",
      "anthropic",
      "claude-opus-4-7",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(updateSessionTitleCalls).toEqual([])
  })

  test("failed normal send does not unarchive an archived current session", async () => {
    mockArchivedSessions = [{ id: "session-b", time: { archived: 10 } }]
    rejectNextSendMessage = true
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    let error: unknown
    try {
      await useSessionUIStore.getState().sendMessage(
        "current chat",
        "provider-b",
        "model-b",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("send failed")
    expect(unarchiveCalls).toEqual([])
  })

  test("targeted send unarchives the targeted archived session", async () => {
    mockArchivedSessions = [
      { id: "session-a", time: { archived: 10 } },
      { id: "session-b", time: { archived: 20 } },
    ]
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      "queued for A",
      "provider-a",
      "model-a",
      "agent-a",
      undefined,
      undefined,
      undefined,
      "variant-a",
      "normal",
    )

    expect(sendMessageCalls[0]?.id).toBe("session-a")
    expect(unarchiveCalls).toEqual(["session-a"])
  })

  test("successful shell send unarchives an archived current session", async () => {
    mockArchivedSessions = [{ id: "session-b", time: { archived: 10 } }]
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "ls",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "shell",
    )

    expect(shellCalls[0]?.sessionID).toBe("session-b")
    expect(unarchiveCalls).toEqual(["session-b"])
  })

  test("successful slash command send unarchives an archived current session", async () => {
    mockArchivedSessions = [{ id: "session-b", time: { archived: 10 } }]
    mockDirectoryState = { command: [{ name: "help" }] }
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "/help",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendCommandCalls[0]?.id).toBe("session-b")
    expect(unarchiveCalls).toEqual(["session-b"])
  })

  test("routes a known skill through command transport when command snapshots are empty", async () => {
    mockDirectoryState = { command: [] }
    useCommandsStore.setState({ commands: [] })
    useSkillsStore.setState({
      skills: [{
        name: "review-code",
        path: "/repo/.opencode/skills/review-code/SKILL.md",
        scope: "project",
        source: "opencode",
      }],
    })
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "/review-code packages/ui/src",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendCommandCalls).toHaveLength(1)
    expect(sendCommandCalls[0]?.id).toBe("session-b")
    expect(sendCommandCalls[0]?.command).toBe("review-code")
    expect(sendCommandCalls[0]?.arguments).toBe("packages/ui/src")
    expect(sendMessageCalls).toHaveLength(0)
  })

  test("plan mode synthetic instruction follows the plan.md layout contract", () => {
    expectPlanModeInstructionContract(buildPlanModeSyntheticInstruction(true))
  })

  test("plan mode synthetic instruction omits Context Mode routing when unavailable", () => {
    const instruction = buildPlanModeSyntheticInstruction(false)
    expect(instruction).not.toContain("ctx_index")
    expect(instruction).not.toContain("Context Mode storage failure")
    expect(instruction).toContain("Plan output format")
  })

  test("plan mode send injects the structured plan layout instruction", async () => {
    selectedPlanMode = true
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "make a plan",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls[0]?.prefaceTextSynthetic).toBe(true)
    expect(sendMessageCalls[0]?.planMode).toBe(true)
    expectPlanModeInstructionContract(String(sendMessageCalls[0]?.prefaceText ?? ""))
    expect(sendMessageCalls[0]?.additionalParts).toBe(undefined)
  })

  test("explicit planMode false prevents plan-mode synthetic instructions", async () => {
    selectedPlanMode = true
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    await useSessionUIStore.getState().sendMessage(
      "implement plan",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      [{ text: "Implementation instructions", synthetic: true }],
      "variant-b",
      undefined,
      false,
    )

    expect(sendMessageCalls[0]?.additionalParts).toEqual([
      { text: "Implementation instructions", synthetic: true, files: undefined },
    ])
    expect(sendMessageCalls[0]?.planMode).toBe(false)
  })

  test("PlanCard implementation send keeps the saved plan path synthetic without file attachments", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-b" })

    const savedPlanInstructions = [
      "Implement the approved plan.",
      "",
      "Read the authoritative plan file first:",
      "/home/.config/openchamber/projects/project-a/plans/session-msg.md",
    ].join("\n")

    await useSessionUIStore.getState().sendMessage(
      "Implement Plan: Fix auth email carryover",
      "provider-b",
      "model-b",
      undefined,
      undefined,
      undefined,
      [{ text: savedPlanInstructions, synthetic: true }],
      "variant-b",
      undefined,
      false,
    )

    expect(sendMessageCalls[0]?.text).toBe("Implement Plan: Fix auth email carryover")
    expect(sendMessageCalls[0]?.files).toBe(undefined)
    expect(sendMessageCalls[0]?.additionalParts).toEqual([
      { text: savedPlanInstructions, synthetic: true, files: undefined },
    ])
    expect(String((sendMessageCalls[0]?.additionalParts as Array<Record<string, unknown>> | undefined)?.[0]?.text))
      .toContain("/home/.config/openchamber/projects/project-a/plans/session-msg.md")
  })

  test("queue cleanup can remove only the original queued session", () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "A" })
    useMessageQueueStore.getState().addToQueue("session-b", { content: "B" })

    const sessionAQueued = useMessageQueueStore.getState().getQueueForSession("session-a")[0]
    useMessageQueueStore.getState().removeFromQueue("session-a", sessionAQueued.id)

    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
    expect(useMessageQueueStore.getState().getQueueForSession("session-b")).toHaveLength(1)
    expect(useMessageQueueStore.getState().getQueueForSession("session-b")[0].content).toBe("B")
  })

  test("claimQueueForSession atomically drains and restore prepends claimed messages", () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued first" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued second" })

    const claimed = useMessageQueueStore.getState().claimQueueForSession("session-a")

    expect(claimed.map((message) => message.content)).toEqual(["queued first", "queued second"])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
    expect(useMessageQueueStore.getState().claimQueueForSession("session-a")).toEqual([])

    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued after claim" })
    useMessageQueueStore.getState().restoreClaimedQueue("session-a", claimed)

    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "queued first",
      "queued second",
      "queued after claim",
    ])
  })

  test("queue claim prevents manual submit and idle auto-send from both sending queued content", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-a" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued while busy" })

    const manualSubmitClaim = useMessageQueueStore.getState().claimQueueForSession("session-a")
    const idleAutoSendClaim = useMessageQueueStore.getState().claimQueueForSession("session-a")

    expect(manualSubmitClaim.map((message) => message.content)).toEqual(["queued while busy"])
    expect(idleAutoSendClaim).toEqual([])

    await useSessionUIStore.getState().sendMessageToSession(
      "session-a",
      manualSubmitClaim[0].content,
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(sendMessageCalls.filter((call) => call.text === "queued while busy")).toHaveLength(1)
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
  })

  test("draft sends replace an invalid plan agent with the saved default agent model and variant", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentAgentName: "plan",
      currentProviderId: "provider-stale",
      currentModelId: "model-stale",
      currentVariant: undefined,
      settingsDefaultAgent: "builder",
      providers: [
        {
          id: "provider-builder",
          models: [
            {
              id: "model-builder",
              variants: {
                high: {},
              },
            },
          ],
        },
      ],
      agents: [
        { name: "plan", mode: "primary" },
        {
          name: "builder",
          mode: "primary",
          model: { providerID: "provider-builder", modelID: "model-builder" },
          variant: "high",
        },
      ],
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "start from draft",
      "provider-stale",
      "model-stale",
      "plan",
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(savedSessionAgents.some((entry) => entry.sessionId === "session-new" && entry.agent === "builder")).toBe(true)
    expect(builderHandoffClearedSessions.has("session-new")).toBe(true)
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "provider-builder"
      && entry.modelID === "model-builder"
    )).toBe(true)
    expect(savedAgentModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
      && entry.providerID === "provider-builder"
      && entry.modelID === "model-builder"
    )).toBe(true)
    expect(savedAgentVariants.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
      && entry.providerID === "provider-builder"
      && entry.modelID === "model-builder"
      && entry.variant === "high"
    )).toBe(true)
    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-builder")
    expect(sendMessageCalls[0]?.modelID).toBe("model-builder")
    expect(sendMessageCalls[0]?.variant).toBe("high")
  })

  test("draft sends retire the promoted draft state", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.draftsById["draft-send"]).toBe(undefined)
    expect(state.draftOrder).not.toContain("draft-send")
    expect(state.newSessionDraft.open).toBe(false)
  })

  test("draft sends promote and send before directory activation settles", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      activateDirectory: mock(() => new Promise<void>((resolve) => {
        deferredActivateDirectoryResolve = resolve
      })),
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    const sendPromise = useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    await Promise.resolve()
    await Promise.resolve()

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.newSessionDraft.open).toBe(false)
    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0]?.id).toBe("session-new")

    deferredActivateDirectoryResolve?.()
    await sendPromise
  })

  test("background activation failure after draft send does not roll back promoted session", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      activateDirectory: mock(() => Promise.reject(new Error("activation failed"))),
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    const originalWarn = console.warn
    console.warn = mock(() => {}) as unknown as typeof console.warn
    try {
      await useSessionUIStore.getState().sendMessage(
        "message from draft",
        "provider-current",
        "model-current",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } finally {
      console.warn = originalWarn
    }

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.newSessionDraft.open).toBe(false)
    expect(sendMessageCalls).toHaveLength(1)
  })

  test("draft sends retire the promoted draft even if session creation selects the new session first", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    selectCreatedSessionDuringCreate = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.draftsById["draft-send"]).toBe(undefined)
    expect(state.draftOrder).not.toContain("draft-send")
    expect(state.newSessionDraft.open).toBe(false)
  })

  test("draft sends clear canonical, per-draft, and legacy persisted data for the promoted draft", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    const storage = getSafeStorage()
    storage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({
      order: ["draft-send"],
      drafts: [{
        id: "draft-send",
        text: "message from draft",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
      }],
    }))
    storage.setItem(getDraftInputStorageKey("draft-send"), "message from draft")
    storage.setItem(getDraftConfirmedMentionsStorageKey("draft-send"), JSON.stringify(["README.md"]))
    storage.setItem(LEGACY_NEW_INPUT_DRAFT_KEY, "message from draft")
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(storage.getItem(CHAT_DRAFTS_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(getDraftInputStorageKey("draft-send"))).toBeNull()
    expect(storage.getItem(getDraftConfirmedMentionsStorageKey("draft-send"))).toBeNull()
    expect(storage.getItem(LEGACY_NEW_INPUT_DRAFT_KEY)).toBeNull()
  })

  test("draft promotion does not emit an intermediate closed null-target state", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    const observed: Array<{
      currentSessionId: string | null
      currentDraftId: string | null
      draftOpen: boolean
    }> = []
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })
    const unsubscribe = useSessionUIStore.subscribe((state) => {
      observed.push({
        currentSessionId: state.currentSessionId,
        currentDraftId: state.currentDraftId,
        draftOpen: state.newSessionDraft.open,
      })
    })

    try {
      await useSessionUIStore.getState().sendMessage(
        "message from draft",
        "provider-current",
        "model-current",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } finally {
      unsubscribe()
    }

    expect(observed.some((entry) =>
      entry.currentSessionId === null
      && entry.currentDraftId === null
      && entry.draftOpen === false
    )).toBe(false)
  })

  test("sending one draft preserves other unsent drafts", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 2,
          updatedAt: 2,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
        "draft-other": {
          id: "draft-other",
          text: "keep this unsent draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send", "draft-other"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.draftsById["draft-send"]).toBe(undefined)
    expect(state.draftsById["draft-other"]?.text).toBe("keep this unsent draft")
    expect(state.draftOrder).toEqual(["draft-other"])
  })

  test("draft sends prune same-text same-directory stale duplicates only", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    const storage = getSafeStorage()
    storage.setItem(getDraftInputStorageKey("draft-stale"), "message from draft")
    storage.setItem(getDraftConfirmedMentionsStorageKey("draft-stale"), JSON.stringify(["README.md"]))
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 4,
          updatedAt: 4,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
        "draft-stale": {
          id: "draft-stale",
          text: "message from draft",
          createdAt: 3,
          updatedAt: 3,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
        "draft-other-dir": {
          id: "draft-other-dir",
          text: "message from draft",
          createdAt: 2,
          updatedAt: 2,
          selectedProjectId: null,
          directoryOverride: "/other",
          parentID: null,
        },
        "draft-different": {
          id: "draft-different",
          text: "keep this unsent draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send", "draft-stale", "draft-other-dir", "draft-different"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.draftsById["draft-send"]).toBe(undefined)
    expect(state.draftsById["draft-stale"]).toBe(undefined)
    expect(state.draftsById["draft-other-dir"]?.text).toBe("message from draft")
    expect(state.draftsById["draft-different"]?.text).toBe("keep this unsent draft")
    expect(state.draftOrder).toEqual(["draft-other-dir", "draft-different"])
    expect(storage.getItem(getDraftInputStorageKey("draft-stale"))).toBeNull()
    expect(storage.getItem(getDraftConfirmedMentionsStorageKey("draft-stale"))).toBeNull()

    const persisted = JSON.parse(storage.getItem(CHAT_DRAFTS_STORAGE_KEY) ?? "{}") as { order?: string[] }
    expect(persisted.order).toEqual(["draft-other-dir", "draft-different"])
  })

  test("create-session failure preserves the active draft and text", async () => {
    mockCreatedSession = null
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    let thrown: unknown = null
    try {
      await useSessionUIStore.getState().sendMessage(
        "message from draft",
        "provider-current",
        "model-current",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("Failed to create session")

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe(null)
    expect(state.currentDraftId).toBe("draft-send")
    expect(state.draftsById["draft-send"]?.text).toBe("message from draft")
    expect(state.newSessionDraft.open).toBe(true)
    expect(state.hasPendingSendAbort("draft:draft-send")).toBe(false)

    mockCreatedSession = { id: "session-retry", directory: "/repo" }
    await useSessionUIStore.getState().sendMessage(
      "message from draft",
      "provider-current",
      "model-current",
    )
    expect(createSessionCalls).toHaveLength(2)
    expect(sendMessageCalls).toHaveLength(1)
  })

  test("draft send validates provider and model before creating a session", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentProviderId: "",
      currentModelId: "",
      providers: [],
      agents: [],
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    let thrown: unknown = null
    try {
      await useSessionUIStore.getState().sendMessage(
        "message from draft",
        "",
        "",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("Cannot send message: provider or model not selected")
    expect(createSessionCalls).toEqual([])

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe(null)
    expect(state.currentDraftId).toBe("draft-send")
    expect(state.draftsById["draft-send"]?.text).toBe("message from draft")
    expect(state.newSessionDraft.open).toBe(true)
  })

  test("route failure after session creation does not resurrect the sent draft", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    rejectNextSendMessage = true
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-send",
      draftsById: {
        "draft-send": {
          id: "draft-send",
          text: "message from draft",
          createdAt: 1,
          updatedAt: 1,
          selectedProjectId: null,
          directoryOverride: "/repo",
          parentID: null,
        },
      },
      draftOrder: ["draft-send"],
      newSessionDraft: {
        open: true,
        id: "draft-send",
        directoryOverride: "/repo",
        parentID: null,
      },
    })

    let thrown: unknown = null
    try {
      await useSessionUIStore.getState().sendMessage(
        "message from draft",
        "provider-current",
        "model-current",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "normal",
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("send failed")

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe("session-new")
    expect(state.currentDraftId).toBe(null)
    expect(state.draftsById["draft-send"]).toBe(undefined)
    expect(state.draftOrder).not.toContain("draft-send")
  })

  test("draft sends preserve the selected agent and scalar model without inheriting stale thinking", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentAgentName: "builder",
      currentProviderId: "provider-selected",
      currentModelId: "model-selected",
      currentVariant: "fast",
      settingsDefaultAgent: "default",
      providers: [
        { id: "provider-default", models: [{ id: "model-default", variants: { slow: {} } }] },
        { id: "provider-selected", models: [{ id: "model-selected", variants: { fast: {} } }] },
      ],
      agents: [
        {
          name: "default",
          mode: "primary",
          model: { providerID: "provider-default", modelID: "model-default" },
          variant: "slow",
        },
        { name: "builder", mode: "primary" },
      ],
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "start with selected config",
      "provider-selected",
      "model-selected",
      "builder",
      undefined,
      undefined,
      undefined,
      "fast",
      "normal",
    )

    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-selected")
    expect(sendMessageCalls[0]?.modelID).toBe("model-selected")
    expect(sendMessageCalls[0]?.variant).toBe(undefined)
    expect(savedSessionAgents.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
    )).toBe(true)
    expect(builderHandoffClearedSessions.has("session-new")).toBe(true)
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
    )).toBe(true)
    expect(savedAgentModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
    )).toBe(true)
    expect(savedAgentVariants.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
      && entry.variant === undefined
    )).toBe(true)
  })

  test("draft sends preserve captured agent and model when directory activation restores defaults", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentAgentName: "builder",
      currentProviderId: "provider-selected",
      currentModelId: "model-selected",
      currentVariant: "fast",
      settingsDefaultAgent: "default",
      providers: [
        { id: "provider-default", models: [{ id: "model-default", variants: { slow: {} } }] },
        { id: "provider-selected", models: [{ id: "model-selected", variants: { fast: {} } }] },
      ],
      agents: [
        {
          name: "default",
          mode: "primary",
          model: { providerID: "provider-default", modelID: "model-default" },
          variant: "slow",
        },
        { name: "builder", mode: "primary" },
      ],
      activateDirectory: mock(() => {
        mockConfigState = {
          ...mockConfigState,
          currentAgentName: "default",
          currentProviderId: "provider-default",
          currentModelId: "model-default",
          currentVariant: "slow",
        }
        return Promise.resolve()
      }),
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "start after activation",
      "provider-selected",
      "model-selected",
      "builder",
      undefined,
      undefined,
      undefined,
      "fast",
      "normal",
    )

    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-selected")
    expect(sendMessageCalls[0]?.modelID).toBe("model-selected")
    expect(sendMessageCalls[0]?.variant).toBe(undefined)
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
    )).toBe(true)
  })

  test("draft sends use explicit draft selections even when the live config has defaults", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    draftAgentSelections.set("draft-selected", "builder")
    draftModelSelections.set("draft-selected", { providerId: "provider-selected", modelId: "model-selected" })
    draftAgentModelSelections.set("draft-selected", new Map([
      ["builder", { providerId: "provider-selected", modelId: "model-selected" }],
    ]))
    draftAgentModelVariants.set("draft-selected", new Map([
      ["builder", new Map([["provider-selected/model-selected", "fast"]])],
    ]))
    mockConfigState = {
      currentAgentName: "default",
      currentProviderId: "provider-default",
      currentModelId: "model-default",
      currentVariant: "slow",
      settingsDefaultAgent: "default",
      providers: [
        { id: "provider-default", models: [{ id: "model-default", variants: { slow: {} } }] },
        { id: "provider-selected", models: [{ id: "model-selected", variants: { fast: {} } }] },
      ],
      agents: [
        {
          name: "default",
          mode: "primary",
          model: { providerID: "provider-default", modelID: "model-default" },
          variant: "slow",
        },
        { name: "builder", mode: "primary" },
      ],
      activateDirectory: mock(() => {
        mockConfigState = {
          ...mockConfigState,
          currentAgentName: "default",
          currentProviderId: "provider-default",
          currentModelId: "model-default",
          currentVariant: "slow",
        }
        return Promise.resolve()
      }),
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-selected",
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "start with draft selection",
      "provider-default",
      "model-default",
      "default",
      undefined,
      undefined,
      undefined,
      "slow",
      "normal",
    )

    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-selected")
    expect(sendMessageCalls[0]?.modelID).toBe("model-selected")
    expect(sendMessageCalls[0]?.variant).toBe("fast")
    expect(savedSessionAgents.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "builder"
    )).toBe(true)
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
    )).toBe(true)
  })

  test("draft sends use persisted send config before activation-restored defaults", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentAgentName: "default",
      currentProviderId: "provider-default",
      currentModelId: "model-default",
      currentVariant: "slow",
      settingsDefaultAgent: "default",
      providers: [
        { id: "provider-default", models: [{ id: "model-default", variants: { slow: {} } }] },
        { id: "provider-selected", models: [{ id: "model-selected", variants: { fast: {} } }] },
      ],
      agents: [
        {
          name: "default",
          mode: "primary",
          model: { providerID: "provider-default", modelID: "model-default" },
          variant: "slow",
        },
        { name: "builder", mode: "primary" },
      ],
      activateDirectory: mock(() => {
        mockConfigState = {
          ...mockConfigState,
          currentAgentName: "default",
          currentProviderId: "provider-default",
          currentModelId: "model-default",
          currentVariant: "slow",
        }
        return Promise.resolve()
      }),
    }
    const sendConfig = {
      providerID: "provider-selected",
      modelID: "model-selected",
      agent: "builder",
      variant: "fast",
      planMode: true,
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      currentDraftId: "draft-config",
      draftsById: {
        "draft-config": {
          id: "draft-config",
          text: "start with persisted config",
          createdAt: 1,
          updatedAt: 1,
          directoryOverride: "/repo",
          parentID: null,
          sendConfig,
        },
      },
      draftOrder: ["draft-config"],
      newSessionDraft: { open: true, id: "draft-config", directoryOverride: "/repo", parentID: null, sendConfig },
    })

    await useSessionUIStore.getState().sendMessage(
      "start with persisted config",
      "provider-default",
      "model-default",
      "default",
      undefined,
      undefined,
      undefined,
      "slow",
      "normal",
      false,
    )

    expect(sendMessageCalls[0]?.agent).toBe("builder")
    expect(sendMessageCalls[0]?.providerID).toBe("provider-selected")
    expect(sendMessageCalls[0]?.modelID).toBe("model-selected")
    expect(sendMessageCalls[0]?.variant).toBe("fast")
    expect(sendMessageCalls[0]?.planMode).toBe(true)
    expect(sendMessageCalls[0]?.prefaceTextSynthetic).toBe(true)
    expectPlanModeInstructionContract(String(sendMessageCalls[0]?.prefaceText ?? ""))
    expect(sendMessageCalls[0]?.additionalParts).toBe(undefined)
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "provider-selected"
      && entry.modelID === "model-selected"
    )).toBe(true)
  })

  test("first draft send routes to the orchestrator configured model before directory activation replaces retained global state", async () => {
    mockCreatedSession = { id: "session-new", directory: "/repo" }
    mockConfigState = {
      currentAgentName: "orchestrator",
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentVariant: "medium",
      settingsDefaultAgent: "orchestrator",
      providers: [
        {
          id: "openai",
          models: [
            { id: "gpt-5.5", variants: { medium: {}, high: {} } },
            { id: "gpt-5.6", variants: { sol: {}, medium: {} } },
          ],
        },
      ],
      agents: [
        {
          name: "orchestrator",
          mode: "primary",
          model: { providerID: "openai", modelID: "gpt-5.6" },
          variant: "sol",
        },
      ],
      activateDirectory: mock(() => {
        mockConfigState = {
          ...mockConfigState,
          currentProviderId: "openai",
          currentModelId: "gpt-5.6",
          currentVariant: "sol",
        }
        return Promise.resolve()
      }),
    }
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: "/repo", parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "first prompt",
      "openai",
      "gpt-5.5",
      undefined,
      undefined,
      undefined,
      undefined,
      "medium",
      "normal",
    )

    expect(sendMessageCalls[0]?.agent).toBe("orchestrator")
    expect(sendMessageCalls[0]?.providerID).toBe("openai")
    expect(sendMessageCalls[0]?.modelID).toBe("gpt-5.6")
    expect(sendMessageCalls[0]?.variant).toBe("sol")
    expect(savedSessionModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.providerID === "openai"
      && entry.modelID === "gpt-5.6"
    )).toBe(true)
    expect(savedAgentModels.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "orchestrator"
      && entry.providerID === "openai"
      && entry.modelID === "gpt-5.6"
    )).toBe(true)
    expect(savedAgentVariants.some((entry) =>
      entry.sessionId === "session-new"
      && entry.agent === "orchestrator"
      && entry.providerID === "openai"
      && entry.modelID === "gpt-5.6"
      && entry.variant === "sol"
    )).toBe(true)
  })

  test("direct Council chat sends the council agent with the selected scalar model", async () => {
    useSessionUIStore.setState({ currentSessionId: "session-a" })
    mockConfigState = {
      currentAgentName: "council",
      currentProviderId: "openai",
      currentModelId: "gpt-5.5",
      currentVariant: "medium",
      providers: [
        {
          id: "openai",
          models: [
            {
              id: "gpt-5.5",
              variants: {
                medium: {},
              },
            },
          ],
        },
      ],
    }

    await useSessionUIStore.getState().sendMessage(
      "run council",
      "openai",
      "gpt-5.5",
      "council",
      undefined,
      undefined,
      undefined,
      "medium",
      "normal",
    )

    expect(sendMessageCalls[0]?.agent).toBe("council")
    expect(sendMessageCalls[0]?.providerID).toBe("openai")
    expect(sendMessageCalls[0]?.modelID).toBe("gpt-5.5")
    expect(sendMessageCalls[0]?.variant).toBe("medium")
  })

  test("draft sends resolve a missing draft directory from the active project", async () => {
    mockCreatedSession = { id: "session-new", directory: "/project-dir" }
    useProjectsStore.setState({
      projects: [{ id: "project-1", path: "/project-dir" }],
      activeProjectId: "project-1",
    })
    useSessionUIStore.setState({
      currentSessionId: null,
      newSessionDraft: { open: true, directoryOverride: null, parentID: null },
    })

    await useSessionUIStore.getState().sendMessage(
      "hello",
      "provider-current",
      "model-current",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
    )

    expect(createSessionCalls[0]?.directory).toBe("/project-dir")
    expect(waitForWorktreeBootstrapCalls).toEqual([])
  })
})
