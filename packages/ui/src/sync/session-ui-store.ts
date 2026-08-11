/**
 * Session UI Store — ephemeral UI state only.
 *
 * Domain data (sessions, messages, parts, permissions, questions, status)
 * lives in sync child stores. This store owns ONLY transient UI concerns:
 * current selection, draft state, viewport anchors, model/agent preferences,
 * voice state, abort prompts, attached files, worktree metadata.
 *
 * Session↔worktree attachments are the authoritative exception: they live in
 * session-worktree-store (shared sync), and session-ui-store routes through it.
 *
 * SDK-calling actions that need domain data read it from sync-refs.
 */

import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile, SessionContextUsage, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useCommandsStore } from "@/stores/useCommandsStore"
import { useSkillsStore } from "@/stores/useSkillsStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { useProviderRecoveryStore } from "@/stores/useProviderRecoveryStore"
import { useSessionPlanFileStore } from "@/stores/useSessionPlanFileStore"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import {
  attachRelatedSubagentContextUsage,
  getContextUsageFromMessages,
  getSubagentContextUsageForSession,
  type ContextUsageMessage,
} from "@/stores/utils/contextUsageUtils"
import {
  resolveModelContextCapacity,
  UNAVAILABLE_MODEL_CONTEXT_CAPACITY,
  type ResolvedModelContextCapacity,
} from "@/stores/utils/modelContextCapacity"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { flattenAssistantTextParts } from "@/lib/messages/messageText"
import { EXECUTION_FORK_META_TEXT } from "@/lib/messages/executionMeta"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { waitForWorktreeBootstrapForSend } from "@/lib/worktrees/worktreeBootstrap"
import {
  createPendingDraftWorktreeRequest,
  hasPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
  waitForPendingDraftWorktreeRequest,
} from "@/lib/worktrees/pendingDraftWorktree"
import { ensureManagedBranchTarget } from "@/lib/worktrees/managedBranchTarget"
import { getAuthPrincipal } from "@/lib/authSession"
import { normalizeManagedBranchName } from "@/lib/worktrees/managedBranches"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { streamDebugMark } from "@/stores/utils/streamDebug"
import { isUserVisibleSessionRecord } from "@/lib/sessionVisibility"
import { assertPdfAttachmentsSupported } from "@/lib/attachments/attachmentCapabilities"
import {
  hasExplicitDraftModelIntent,
  normalizeSendConfigModelProvenance,
  resolveDraftSendSelection,
  resolveSessionSendConfig,
  type SendConfig,
  type SendConfigAgent,
  type SendConfigProvider,
} from "./send-config"
import {
  getSyncSessions,
  getAllSyncSessions,
  getSyncMessages,
  getSyncParts,
  getSyncQuestions,
  getSyncSessionStatus,
  getDirectoryState,
  getSyncChildStores,
  getSyncSessionDirectoryAnyDirectory,
  setSessionUIStoreRef,
} from "./sync-refs"
import { markSessionsViewed } from "./notification-store"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  createSessionRecord as createSessionRecordAction,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  archiveSession as archiveSessionAction,
  archiveSessions as archiveSessionsAction,
  unarchiveSession as unarchiveSessionAction,
  unarchiveSessions as unarchiveSessionsAction,
  updateSessionTitle as updateSessionTitleAction,
  shareSession as shareSessionAction,
  unshareSession as unshareSessionAction,
  abortCurrentOperation as abortCurrentOperationAction,
  assertSessionRevertMutationAllowed,
  rejectQuestion as rejectQuestionAction,
  optimisticSend,
  refetchSessionMessages,
  getSessionIdsWithDescendants,
  consumeLastCreateSessionError,
} from "./session-actions"
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSelectionStore } from "./selection-store"
import { useViewportStore } from "./viewport-store"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { getAttachedSessionDirectory } from "./session-worktree-contract"
import { resolveSubtaskAgentFromMessages } from "./subtask-agent"
import { nextPlanIndicatorEntry, type PlanIndicatorEntry } from "./plan-indicator"
import { hasSettledTerminalAssistantTurn } from "./plan-idle-settlement"
import {
  clearLegacyNewDraftInput,
  createDraftId,
  persistDrafts,
  readPersistedDrafts,
  removePersistedDraftInput,
} from "./session-draft-storage"

export type { AttachedFile }

const CURSOR_ACP_PROVIDER_ID = "cursor-acp"
const CURSOR_DRAFT_PREWARM_STORAGE_KEY = "openchamber.cursorDraftPrewarmSessions.v1"
const CURSOR_DRAFT_PREWARM_STALE_MS = 24 * 60 * 60 * 1000
const CROSS_RUNTIME_HANDOFF_MAX_MESSAGES = 8
const CROSS_RUNTIME_HANDOFF_MAX_CHARS = 6000
const CROSS_RUNTIME_HANDOFF_MAX_TEXT_CHARS = 1400
const CROSS_RUNTIME_HANDOFF_OMISSION_MARKER = "[older conversation context omitted]"
export const SESSION_COMPLETION_INDICATOR_SETTLE_MS = 250

const pendingSessionCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingPlanCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>()

const clearPendingSessionCompletionTimer = (sessionId: string) => {
  const timer = pendingSessionCompletionTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  pendingSessionCompletionTimers.delete(sessionId)
}

const clearPendingPlanCompletionTimer = (sessionId: string) => {
  const timer = pendingPlanCompletionTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  pendingPlanCompletionTimers.delete(sessionId)
}

const clearPendingCompletionTimers = (sessionId: string) => {
  clearPendingSessionCompletionTimer(sessionId)
  clearPendingPlanCompletionTimer(sessionId)
}

const deleteMapKey = <K, V>(source: Map<K, V>, key: K): Map<K, V> => {
  if (!source.has(key)) return source
  const next = new Map(source)
  next.delete(key)
  return next
}

const deleteSetValue = <T,>(source: Set<T>, value: T | undefined): Set<T> => {
  if (value === undefined || !source.has(value)) return source
  const next = new Set(source)
  next.delete(value)
  return next
}

const deleteSetMatches = <T,>(source: Set<T>, matches: (value: T) => boolean): Set<T> => {
  let next: Set<T> | null = null
  for (const value of source) {
    if (!matches(value)) continue
    next ??= new Set(source)
    next.delete(value)
  }
  return next ?? source
}

const isLiveSessionWorking = (sessionId: string): boolean => {
  const directory = getSyncSessionDirectoryAnyDirectory(sessionId)
  const state = directory ? getDirectoryState(directory) : undefined
  const stateStatus = state?.session_status?.[sessionId]
  const status = stateStatus ?? (directory ? getSyncSessionStatus(sessionId, directory) : undefined)
  if (
    state
    && stateStatus
    && (status?.type === "busy" || status?.type === "retry")
    && hasSettledTerminalAssistantTurn({ sessionID: sessionId, state })
  ) {
    return false
  }
  return status?.type === "busy" || status?.type === "retry"
}

const scheduleSessionCompletionIndicator = (
  sessionId: string,
  entry: SessionCompletionIndicatorEntry,
) => {
  clearPendingSessionCompletionTimer(sessionId)
  const timer = setTimeout(() => {
    pendingSessionCompletionTimers.delete(sessionId)
    if (isLiveSessionWorking(sessionId)) return
    useSessionUIStore.setState((state) => {
      const current = state.sessionCompletionIndicator.get(sessionId)
      if (current?.messageId === entry.messageId && current.completedAt === entry.completedAt) return state

      const next = new Map(state.sessionCompletionIndicator)
      next.set(sessionId, entry)
      return { sessionCompletionIndicator: next }
    })
  }, SESSION_COMPLETION_INDICATOR_SETTLE_MS)
  pendingSessionCompletionTimers.set(sessionId, timer)
}

const schedulePlanCompletionIndicator = (
  sessionId: string,
  entry: PlanIndicatorEntry,
) => {
  clearPendingPlanCompletionTimer(sessionId)
  const timer = setTimeout(() => {
    pendingPlanCompletionTimers.delete(sessionId)
    if (isLiveSessionWorking(sessionId)) return
    useSessionUIStore.setState((state) => {
      const current = state.sessionPlanIndicator.get(sessionId)
      const nextEntry = nextPlanIndicatorEntry(
        current,
        "completed",
        entry.sourceMessageId,
        entry.implementationMessageId,
      )
      if (nextEntry === current && state.sessionPlanAvailable.get(sessionId) === true) return state

      const nextIndicator = new Map(state.sessionPlanIndicator)
      if (nextEntry) nextIndicator.set(sessionId, nextEntry)
      const nextAvailable = new Map(state.sessionPlanAvailable)
      nextAvailable.set(sessionId, true)
      return { sessionPlanIndicator: nextIndicator, sessionPlanAvailable: nextAvailable }
    })
  }, SESSION_COMPLETION_INDICATOR_SETTLE_MS)
  pendingPlanCompletionTimers.set(sessionId, timer)
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError")
  }
  const error = new Error("Aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function isKnownArchivedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false

  const archivedSessions = useGlobalSessionsStore.getState().archivedSessions ?? []
  if (archivedSessions.some((session) => session.id === sessionId)) {
    return true
  }

  return getAllSyncSessions().some((session) => session.id === sessionId && Boolean(session.time?.archived))
}

async function autoUnarchiveAfterSuccessfulSend(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId || !isKnownArchivedSession(sessionId)) return

  try {
    const success = await unarchiveSessionAction(sessionId)
    if (!success) {
      console.warn(`[session-ui-store] Failed to auto-unarchive session after send: ${sessionId}`)
    }
  } catch (error) {
    console.warn(`[session-ui-store] Failed to auto-unarchive session after send: ${sessionId}`, error)
  }
}

// Decision: keep the runtime plan-mode prompt in this shared UI module instead
// of reading plan.md at send time, so web/Electron/VS Code use the same
// synchronous contract even when project agent files are unavailable or stale.
export const buildPlanModeSyntheticInstruction = (): string => [
  "User has requested to enter plan mode.",
  "Produce an implementation plan only; do not edit files, run modifying commands, or make changes yet.",
  "Use the authoritative same-session planning history as context. Treat the latest visible user prompt as a revision of the most recent plan unless the user explicitly asks for a separate, independent plan.",
  "Preserve every prior requirement, decision, constraint, and file reference that the user has not explicitly changed, including useful work from an interrupted or partial planning turn.",
  "For a revision, emit a complete, self-contained replacement plan containing both the preserved context and the requested changes. Never return only a patch, diff, addendum, or abbreviated delta.",
  "Write the plan as ordinary markdown — no code fences, no plan.md wrapper. Use headings, lists, and bold for structure so the chat UI can render it as typeset prose.",
  "Use the actual plan name as the top heading; do not prefix it with 'Implementation Plan:'.",
  "When the final plan is complete, stop after the Verification section. The plan card provides the implementation action; do not ask for approval in prose or through the question tool.",
  "",
  "CHAT UI MARKER (REQUIRED, no exceptions): the chat UI renders the final plan in a dedicated card and needs a sentinel to know where the plan starts. Any reasoning, tool-use commentary, exploration notes, or preamble MUST come BEFORE the final plan. When you are ready to emit the final plan, output the literal HTML comment <!--plan--> on its own line as a sentinel, then on the next line begin the plan body (top heading, sections, etc.). Emit <!--plan--> exactly once per message, immediately before the plan body. Do not wrap it in a code fence. Do not put any other text on the same line as the marker. Do not emit it anywhere else in the message. If you do not emit this marker, the plan card will not render and the user will not be able to click \"Implement Plan\".",
  "",
  "Plan output format — the body that follows <!--plan--> must use exactly this structure, in this order, as ordinary markdown (no code fences around the plan itself):",
  "",
  "# <Plan title — short noun phrase, no \"Implementation Plan:\" prefix>",
  "",
  "## Context",
  "",
  "Explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome. 1–2 short paragraphs.",
  "",
  "## Critical files",
  "",
  "**New files**",
  "- `path/to/new/file.ext` — one-line purpose.",
  "",
  "**Files modified**",
  "- `path/to/existing/file.ext` — what changes and why.",
  "",
  "**Files read (no edit) for behavior reuse**",
  "- `path/to/reference.ext:line` — the function/pattern being reused.",
  "",
  "Omit any of the three Critical files subsections that do not apply, but keep the bold sub-headings on the ones you include.",
  "",
  "## Implementation",
  "",
  "Use sequential third-level headings in the exact form `### Phase 1: <name>`, `### Phase 2: <name>`, and so on. Under each phase, write a numbered list of concrete, actionable implementation tasks. Each phase must contain multiple related tasks; merge a phase that would contain only one task. Include short code or markdown snippets inline only where the exact shape of a change matters (function signature, JSX wiring, schema, etc.). Do not paste whole files. Reference existing functions/utilities by file path with line numbers so the implementer can navigate directly.",
  "Count only actionable implementation tasks as tasks. Keep acceptance criteria, files, risks, and verification separate from task counts.",
  "",
  "## Visual details",
  "",
  "Only when the change is user-visible (UI, output formatting, etc.). Describe spacing, tokens, motion, accessibility (reduced-motion, dark mode). Skip this section entirely for non-visual work.",
  "",
  "## Verification",
  "",
  "Numbered checklist describing how to confirm the change works end-to-end. Include: how to start the relevant server/tool, the exact user actions to take, the observable expected outcomes, and any tests that must still pass (with their file paths). Make each step independently checkable.",
  "",
  "Stop after the Verification section. The plan card provides the implementation action; do not ask for approval in prose or through the question tool.",
].join("\n")

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

async function routeMessage(params: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  variant?: string
  planMode?: boolean
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  directory?: string | null
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  lifecycleCallbacks?: SendLifecycleCallbacks
}): Promise<boolean> {
  throwIfAborted(params.lifecycleCallbacks?.signal)
  const messageDirectory = normalizePath(params.directory ?? useSessionUIStore.getState().getDirectoryForSession(params.sessionId) ?? opencodeClient.getDirectory() ?? null)
  const session = getAllSyncSessions().find((candidate) => candidate.id === params.sessionId)
  const isSubtaskSession = Boolean((session as (Session & { parentID?: string | null }) | undefined)?.parentID)
  const effectiveAgent = isSubtaskSession
    ? resolveSubtaskAgentFromMessages(getSyncMessages(params.sessionId, messageDirectory ?? undefined)) ?? params.agent
    : params.agent
  const assertTransportAllowed = () => {
    assertSessionRevertMutationAllowed(params.sessionId, messageDirectory ?? undefined, "send")
  }
  assertTransportAllowed()
  if (!params.lifecycleCallbacks?.preserveProviderRecovery) {
    useProviderRecoveryStore.getState().clearRecovery(params.sessionId)
  }
  if (params.inputMode === "shell") {
    if (messageDirectory) {
      await waitForWorktreeBootstrapForSend(messageDirectory)
    }
    throwIfAborted(params.lifecycleCallbacks?.signal)
    assertTransportAllowed()
    const sdk = opencodeClient.getSdkClient()
    await sdk.session.shell({
      sessionID: params.sessionId,
      directory: messageDirectory || undefined,
      agent: effectiveAgent,
      model: { providerID: params.providerID, modelID: params.modelID },
      command: params.content,
    })
    await autoUnarchiveAfterSuccessfulSend(params.sessionId)
    return false
  }

  const handoffAdditionalParts = withCrossRuntimeHandoffContext(
    params.additionalParts,
    buildCrossRuntimeHandoffPart({
      sessionId: params.sessionId,
      targetProviderID: params.providerID,
      directory: messageDirectory,
    }),
  )

  const planModePrefaceText = params.planMode === true
    ? buildPlanModeSyntheticInstruction()
    : undefined
  const additionalParts = handoffAdditionalParts

  assertPdfAttachmentsSupported({
    providerID: params.providerID,
    modelID: params.modelID,
    files: [
      ...(params.files ?? []),
      ...((additionalParts ?? []).flatMap((part) => part.files ?? [])),
    ],
  })

  const sessionStatus = getSyncSessionStatus(params.sessionId, messageDirectory ?? undefined)
  const isActiveSubtaskSession = isSubtaskSession && (sessionStatus?.type === "busy" || sessionStatus?.type === "retry")

  if (isActiveSubtaskSession) {
    const lastUserChoice = useSessionUIStore.getState().getLastUserChoice(params.sessionId)
    const activeProviderID = lastUserChoice?.providerID ?? params.providerID
    if (activeProviderID === CURSOR_ACP_PROVIDER_ID) {
      throw new Error("Cursor SDK cannot accept live messages into a running subtask yet. Stop or wait for it to finish, then send.")
    }

    await opencodeClient.sendImmediateSubtaskPrompt({
      id: params.sessionId,
      text: params.content,
      files: params.files && params.files.length > 0 ? params.files : undefined,
      agentMentions: params.agentMentionName ? [{ name: params.agentMentionName }] : undefined,
      additionalParts,
      directory: messageDirectory,
      signal: params.lifecycleCallbacks?.signal,
      beforeTransport: assertTransportAllowed,
    })
    await refetchSessionMessages(params.sessionId)
    await autoUnarchiveAfterSuccessfulSend(params.sessionId)
    return true
  }

  // Slash commands — fire and forget, SSE delivers messages and status
  if (params.content.startsWith("/")) {
    const [head, ...tail] = params.content.split(" ")
    const cmdName = head.slice(1)

    const dirState = getDirectoryState(messageDirectory ?? undefined)
    const syncCommands = dirState?.command ?? []
    const storeCommands = useCommandsStore.getState().commands
    const skills = useSkillsStore.getState().skills

    const isCommand = syncCommands.find((c) => c.name === cmdName)
      || storeCommands.find((c) => c.name === cmdName)
      || skills.find((skill) => skill.name === cmdName)

    if (isCommand) {
      await optimisticSend({
        messageID: params.lifecycleCallbacks?.messageID,
        sessionId: params.sessionId,
        content: params.content,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: effectiveAgent,
        files: params.files,
        directory: messageDirectory,
        planMode: params.planMode,
        includeAssistantPlaceholder: params.providerID === CURSOR_ACP_PROVIDER_ID,
        onMessageID: (messageID) => {
          useSessionUIStore.getState().recordUserMessagePlanMode(params.sessionId, messageID, params.planMode === true)
          params.lifecycleCallbacks?.onMessageID?.(messageID)
        },
        onMessageRollback: (messageID) => {
          useSessionUIStore.getState().recordUserMessagePlanMode(params.sessionId, messageID, false)
          params.lifecycleCallbacks?.onMessageRollback?.(messageID)
        },
        signal: params.lifecycleCallbacks?.signal,
        preserveProviderRecovery: params.lifecycleCallbacks?.preserveProviderRecovery,
        send: (messageID) => opencodeClient.sendCommand({
          id: params.sessionId,
          providerID: params.providerID,
          modelID: params.modelID,
          command: cmdName,
          arguments: tail.join(" "),
          agent: effectiveAgent,
          variant: params.variant,
          files: params.files,
          messageId: messageID,
          directory: messageDirectory,
          signal: params.lifecycleCallbacks?.signal,
          beforeTransport: assertTransportAllowed,
        }).then(() => {}),
      })
      await autoUnarchiveAfterSuccessfulSend(params.sessionId)
      return false
    }
  }

  // Normal prompt — optimistic insert so message appears instantly
  await optimisticSend({
    messageID: params.lifecycleCallbacks?.messageID,
    sessionId: params.sessionId,
    content: params.content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: effectiveAgent,
    files: params.files,
    directory: messageDirectory,
    planMode: params.planMode,
    includeAssistantPlaceholder: params.providerID === CURSOR_ACP_PROVIDER_ID,
    onMessageID: (messageID) => {
      useSessionUIStore.getState().recordUserMessagePlanMode(params.sessionId, messageID, params.planMode === true)
      params.lifecycleCallbacks?.onMessageID?.(messageID)
    },
    onMessageRollback: (messageID) => {
      useSessionUIStore.getState().recordUserMessagePlanMode(params.sessionId, messageID, false)
      params.lifecycleCallbacks?.onMessageRollback?.(messageID)
    },
    signal: params.lifecycleCallbacks?.signal,
    preserveProviderRecovery: params.lifecycleCallbacks?.preserveProviderRecovery,
    send: (messageID) => opencodeClient.sendMessage({
      id: params.sessionId,
      providerID: params.providerID,
      modelID: params.modelID,
      text: params.content,
      prefaceText: planModePrefaceText,
      prefaceTextSynthetic: planModePrefaceText ? true : undefined,
      agent: effectiveAgent,
      variant: params.variant,
      files: params.files,
      additionalParts,
      messageId: messageID,
      directory: messageDirectory,
      signal: params.lifecycleCallbacks?.signal,
      beforeTransport: assertTransportAllowed,
    }).then(() => {}),
  })
  await autoUnarchiveAfterSuccessfulSend(params.sessionId)
  return true
}

function notifyMessageSent(sessionId: string): void {
  fetch(`/api/sessions/${sessionId}/message-sent`, { method: "POST" })
    .catch(() => { /* ignore */ })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SyntheticContextPart } from "./input-store"
export type { SessionMemoryState } from "./viewport-store"
export type { VoiceStatus, VoiceMode } from "./voice-store"

export type NewSessionDraftState = {
  open: boolean
  id?: string | null
  selectedProjectId?: string | null
  directoryOverride: string | null
  pendingWorktreeRequestId?: string | null
  bootstrapPendingDirectory?: string | null
  preserveDirectoryOverride?: boolean
  targetBranchName?: string | null
  targetPreparationError?: string | null
  parentID: string | null
  title?: string
  initialPrompt?: string
  syntheticParts?: SyntheticContextPart[]
  planMode?: boolean
  sendConfig?: SendConfig
  targetFolderId?: string
}

export type ChatDraft = Omit<NewSessionDraftState, "open"> & {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

export type StarterAssistantMessage = {
  sessionId: string
  sourceMessageId: string
  messageId: string
  partId: string
  text: string
  createdAt: number
  pendingContext: boolean
}

type ProviderModelLimit = {
  input?: number
  context?: number
  output?: number
}

type ProviderModelLike = {
  id?: string
  limit?: ProviderModelLimit
  variants?: Record<string, { limit?: ProviderModelLimit }>
}

type ProviderLike = {
  id?: string
  models?: ProviderModelLike[]
}

const getContextMessageInfo = (message: ContextUsageMessage): Message => {
  return "info" in message ? message.info as Message : message as Message
}

const resolveContextCapacityFromMessages = (messages: ContextUsageMessage[]): ResolvedModelContextCapacity => {
  const providers = useConfigStore.getState().providers as ProviderLike[]
  if (!Array.isArray(providers) || providers.length === 0) {
    return UNAVAILABLE_MODEL_CONTEXT_CAPACITY
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = getContextMessageInfo(messages[index]) as Message & { providerID?: unknown; modelID?: unknown }
    if (info.role !== "assistant" || typeof info.providerID !== "string" || typeof info.modelID !== "string") {
      continue
    }

    const provider = providers.find((entry) => entry.id === info.providerID)
    const model = provider?.models?.find((entry) => entry.id === info.modelID)
    const variant = typeof (info as Message & { variant?: unknown }).variant === "string"
      ? (info as Message & { variant: string }).variant
      : undefined
    return resolveModelContextCapacity(model, variant)
  }

  return UNAVAILABLE_MODEL_CONTEXT_CAPACITY
}

export type ViewportAnchor = {
  sessionId: string
  value: number
}

type SendLifecycleCallbacks = {
  messageID?: string
  directory?: string
  onMessageID?: (messageID: string) => void
  onMessageRollback?: (messageID: string) => void
  onSessionReady?: (sessionID: string, directory?: string | null) => void
  signal?: AbortSignal
  preserveProviderRecovery?: boolean
}

type PendingQuestionDismissal = {
  sessionId: string
  requestId: string
}

function getQuestionRequestId(question: unknown): string | null {
  if (!question || typeof question !== "object") return null
  const id = (question as { id?: unknown }).id
  return typeof id === "string" && id.trim().length > 0 ? id : null
}

function collectPendingQuestionDismissals(sessionId: string, directory?: string | null): PendingQuestionDismissal[] {
  const sessionIds = getSessionIdsWithDescendants([sessionId])
  const seen = new Set<string>()
  const dismissals: PendingQuestionDismissal[] = []

  for (const candidateSessionId of sessionIds) {
    const questions = getSyncQuestions(candidateSessionId, directory ?? undefined)
    for (const question of questions) {
      const requestId = getQuestionRequestId(question)
      if (!requestId) continue
      const key = `${candidateSessionId}:${requestId}`
      if (seen.has(key)) continue
      seen.add(key)
      dismissals.push({ sessionId: candidateSessionId, requestId })
    }
  }

  return dismissals
}

function clearPendingQuestionsOptimistically(
  dismissals: PendingQuestionDismissal[],
  directory?: string | null,
): void {
  if (dismissals.length === 0) return

  const requestIdsBySession = new Map<string, Set<string>>()
  for (const dismissal of dismissals) {
    const ids = requestIdsBySession.get(dismissal.sessionId) ?? new Set<string>()
    ids.add(dismissal.requestId)
    requestIdsBySession.set(dismissal.sessionId, ids)
  }

  const stores = getSyncChildStores()
  const candidateStores = new Set<ReturnType<typeof stores.ensureChild>>()
  for (const store of stores.children?.values() ?? []) {
    candidateStores.add(store)
  }
  if (directory) {
    candidateStores.add(stores.ensureChild(directory, { bootstrap: false }))
  }

  for (const store of candidateStores) {
    store.setState((state) => {
      const currentQuestion = state.question ?? {}
      let changed = false
      const nextQuestion = { ...currentQuestion }

      for (const [dismissSessionId, requestIds] of requestIdsBySession) {
        const current = currentQuestion[dismissSessionId] ?? []
        const next = current.filter((question) => {
          const requestId = getQuestionRequestId(question)
          return !requestId || !requestIds.has(requestId)
        })
        if (next.length !== current.length) {
          nextQuestion[dismissSessionId] = next
          changed = true
        }
      }

      return changed ? { question: nextQuestion } : {}
    })
  }
}

function isAlreadyGoneQuestionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /\b(404|not found|gone|missing|already\s+(gone|removed|dismissed|answered|rejected))\b/i.test(message)
}

async function queuePromptAfterPendingQuestions(params: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  attachments?: AttachedFile[]
  variant?: string
  planMode?: boolean
  directory?: string | null
  inputMode?: "normal" | "shell"
}): Promise<boolean> {
  if (params.inputMode === "shell") return false

  const dismissals = collectPendingQuestionDismissals(params.sessionId, params.directory)
  if (dismissals.length === 0) return false

  useMessageQueueStore.getState().addToQueue(params.sessionId, {
    content: params.content,
    directory: params.directory ?? undefined,
    attachments: params.attachments,
    sendConfig: {
      providerID: params.providerID,
      modelID: params.modelID,
      agent: params.agent,
      variant: params.variant,
      planMode: params.planMode,
    },
  })

  clearPendingQuestionsOptimistically(dismissals, params.directory)

  // Each reject is an independent HTTP round-trip; fire them concurrently so N
  // pending questions cost one RTT instead of N before the prompt goes out.
  await Promise.all(dismissals.map(async (dismissal) => {
    try {
      await rejectQuestionAction(dismissal.sessionId, dismissal.requestId)
    } catch (error) {
      if (!isAlreadyGoneQuestionError(error)) {
        throw error
      }
    }
  }))

  return true
}

export type SessionHistoryMeta = {
  limit: number
  hasMore: boolean
  complete: boolean
  isLoading: boolean
  loading?: boolean
  nextCursor?: string
}

export type SessionCompletionIndicatorEntry = {
  messageId: string
  completedAt: number
}

export type SessionUIState = {
  currentSessionId: string | null
  currentDraftId: string | null
  draftsById: Record<string, ChatDraft>
  draftOrder: string[]
  newSessionDraft: NewSessionDraftState
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  worktreeMetadata: Map<string, WorktreeMetadata>
  sessionDirectoryHints: Map<string, string>
  availableWorktrees: WorktreeMetadata[]
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null
  // Plan mode - per-session plan file availability (set when plan_enter tool creates a plan)
  sessionPlanAvailable: Map<string, boolean>
  sessionPlanIndicator: Map<string, PlanIndicatorEntry>
  sessionCompletionIndicator: Map<string, SessionCompletionIndicatorEntry>
  implementedPlanRequests: Set<string>
  externallyHandedOffPlanRequests: Set<string>
  planModeUserMessages: Set<string>
  planModeUserMessagesBySession: Map<string, string>
  starterAssistantMessages: Map<string, StarterAssistantMessage>
  markSessionPlanAvailable: (sessionId: string) => void
  isSessionPlanAvailable: (sessionId: string) => boolean
  recordUserMessagePlanMode: (sessionId: string, messageId: string, enabled: boolean) => void
  isUserMessagePlanMode: (messageId: string) => boolean
  isPlanSourceImplemented: (sessionId: string, sourceMessageId: string) => boolean
  markPlanProposed: (sessionId: string, sourceMessageId?: string) => void
  markPlanImplementing: (sessionId: string, sourceMessageId?: string, implementationMessageId?: string) => void
  markPlanCompleted: (sessionId: string, sourceMessageId?: string) => void
  markPlanImplementationRequested: (planKey: string) => void
  markPlanImplementationHandedOff: (planKey: string) => void
  clearHandedOffPlanIndicator: (sessionId: string, sourceMessageId: string) => void
  retirePlanProposal: (sessionId: string, sourceMessageId: string) => void
  claimPendingSendAbort: (key: string, controller?: AbortController) => AbortController | null
  promotePendingSendAbort: (fromKey: string, toKey: string) => AbortController | null
  abortPendingSend: (key: string) => boolean
  clearPendingSendAbort: (key: string, controller?: AbortController) => void
  hasPendingSendAbort: (key: string) => boolean
  markSessionTurnCompleted: (sessionId: string, messageId: string, completedAt?: number) => void
  clearSessionTurnCompletion: (sessionId: string) => void
  retireDeletedSession: (sessionId: string) => void
  clearViewedPlanCompletion: (sessionId: string) => void
  clearReadCompletionIndicators: (sessionIds: string[]) => void
  rollbackPlanImplementation: (
    sessionId: string,
    sourceMessageId: string | undefined,
    implementationKey: string,
    implementationMessageId?: string,
  ) => void
  getStarterAssistantMessage: (sessionId: string) => StarterAssistantMessage | undefined
  clearStarterAssistantPendingContext: (sessionId: string) => void

  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives
  pendingChangesBarDismissed: Map<string, string>
  dismissPendingChangesBar: (sessionId: string, signature: string | null) => void

  // Actions — UI state management
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState>) => void
  selectNewSessionDraft: (draftId: string) => void
  updateNewSessionDraftText: (draftId: string, text: string) => void
  deleteNewSessionDraft: (draftId: string) => void
  closeNewSessionDraft: () => void
  promoteDraftToSession: (options: {
    draftId?: string | null
    sessionId: string
    directoryHint?: string | null
    submittedText?: string
  }) => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  updateNewSessionDraftSendConfig: (patch: SendConfig) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  clearAbortPrompt: () => void
  armAbortPrompt: (durationMs?: number) => number | null
  clearError: () => void
  markSessionAsOpenChamberCreated: (sessionId: string) => void
  isOpenChamberCreatedSession: (sessionId: string) => boolean
  getContextUsage: (capacity: ResolvedModelContextCapacity) => SessionContextUsage | null
  initializeNewOpenChamberSession: (sessionId: string, agents: unknown[]) => void
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: Record<string, unknown>) => void
  setDraftBootstrapPendingDirectory: (directory: string | null) => void
  setPendingDraftWorktreeRequest: (requestId: string | null) => void
  getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | undefined

  // Actions — SDK-calling operations (read domain data from sync-refs)
  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    planMode?: boolean,
  ) => Promise<void>

  sendMessageToSession: (
    sessionId: string,
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    planMode?: boolean,
    lifecycleCallbacks?: SendLifecycleCallbacks,
  ) => Promise<void>

  createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null) => Promise<Session | null>
  deleteSession: (id: string, options?: Record<string, unknown>) => Promise<boolean>
  deleteSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  unarchiveSession: (id: string) => Promise<boolean>
  unarchiveSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ unarchivedIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  shareSession: (sessionId: string) => Promise<Session | null>
  unshareSession: (sessionId: string) => Promise<Session | null>
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string) => Promise<void>
  createSessionFromAssistantMessage: (sourceMessageId: string) => Promise<void>

  // Data access helpers (read from sync)
  getSessionsByDirectory: (directory: string) => Session[]
  getDirectoryForSession: (sessionId: string) => string | null
  getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null
  getCurrentAgent: (sessionId: string) => string | undefined
  debugSessionMessages: (sessionId: string) => Promise<void>
  pollForTokenUpdates: () => void
  setSessionDirectory: (sessionId: string, directory: string | null) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const replaced = trimmed.replace(/\\/g, "/")
  if (replaced === "/") return "/"
  return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced
}

const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  return normalizePath(sessionRecord.directory ?? null)
    ?? normalizePath(sessionRecord.project?.worktree ?? null)
}

const safeStorage = getSafeStorage()
const DRAFT_TARGET_STORAGE_KEY = "oc.chatInput.lastDraftTarget"
const PLAN_MESSAGE_STATE_STORAGE_KEY = "openchamber_plan_message_state"
const MAX_PERSISTED_PLAN_MESSAGE_IDS = 2000

type PersistedDraftTarget = { projectId: string | null; directory: string | null }

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
    }
  } catch {
    return null
  }
}

const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target))
  } catch { /* ignored */ }
}

type PersistedCursorDraftPrewarmSession = {
  draftId: string
  sessionID: string
  directory: string | null
  createdAt: number
}

const readPersistedCursorDraftPrewarmSessions = (): PersistedCursorDraftPrewarmSession[] => {
  try {
    const raw = safeStorage.getItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const records: PersistedCursorDraftPrewarmSession[] = []
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue
      const sessionID = typeof item.sessionID === "string" ? item.sessionID.trim() : ""
      const draftId = typeof item.draftId === "string" ? item.draftId.trim() : ""
      const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0
      if (!sessionID || !draftId || !createdAt) continue
      records.push({
        draftId,
        sessionID,
        directory: normalizePath(typeof item.directory === "string" ? item.directory : null),
        createdAt,
      })
    }
    return records
  } catch {
    return []
  }
}

const writePersistedCursorDraftPrewarmSessions = (records: PersistedCursorDraftPrewarmSession[]): void => {
  try {
    if (records.length === 0) {
      safeStorage.removeItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY)
      return
    }
    safeStorage.setItem(CURSOR_DRAFT_PREWARM_STORAGE_KEY, JSON.stringify(records))
  } catch { /* ignored */ }
}

const removePersistedCursorDraftPrewarmSession = (sessionID: string | null | undefined): void => {
  const id = typeof sessionID === "string" ? sessionID.trim() : ""
  if (!id) return
  const current = readPersistedCursorDraftPrewarmSessions()
  const retained = current.filter((item) => item.sessionID !== id)
  if (retained.length === current.length) return
  writePersistedCursorDraftPrewarmSessions(retained)
}

const deleteHiddenCursorDraftSession = async (sessionID: string, directory: string | null): Promise<void> => {
  removePersistedCursorDraftPrewarmSession(sessionID)
  try {
    await opencodeClient.withDirectory(directory ?? undefined, () => opencodeClient.deleteSession(sessionID))
  } catch {
    // Stale hidden prewarm sessions are best-effort cleanup.
  }
}

const cleanupStaleCursorDraftPrewarmSessions = (): void => {
  const now = Date.now()
  const retained: PersistedCursorDraftPrewarmSession[] = []
  for (const record of readPersistedCursorDraftPrewarmSessions()) {
    if (now - record.createdAt > CURSOR_DRAFT_PREWARM_STALE_MS) {
      void deleteHiddenCursorDraftSession(record.sessionID, record.directory)
    } else {
      retained.push(record)
    }
  }
  writePersistedCursorDraftPrewarmSessions(retained)
}

cleanupStaleCursorDraftPrewarmSessions()

const createLocalStarterId = (prefix: "msg" | "prt"): string => `local_starter_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`

const buildStarterAssistantContextText = (starter: StarterAssistantMessage): string => [
  EXECUTION_FORK_META_TEXT,
  "",
  "Assistant response shown at the top of this chat:",
  starter.text,
].join("\n")

const withStarterAssistantContext = <T extends { text: string; synthetic?: boolean }>(
  parts: T[] | undefined,
  starter: StarterAssistantMessage | undefined,
): T[] | undefined => {
  if (!starter?.pendingContext) return parts
  const contextPart = { text: buildStarterAssistantContextText(starter), synthetic: true } as T
  return [contextPart, ...(parts ?? [])]
}

const getProviderBackend = (providerId?: string | null): "cursor" | "opencode" | null => {
  const cleaned = typeof providerId === "string" ? providerId.trim() : ""
  if (!cleaned) return null
  return cleaned === CURSOR_ACP_PROVIDER_ID ? "cursor" : "opencode"
}

const getMessageProviderId = (message: Message | Record<string, unknown>): string | undefined => {
  const model = (message as { model?: { providerID?: unknown } }).model
  const modelProvider = typeof model?.providerID === "string" ? model.providerID.trim() : ""
  if (modelProvider) return modelProvider

  const providerID = (message as { providerID?: unknown }).providerID
  return typeof providerID === "string" && providerID.trim().length > 0 ? providerID.trim() : undefined
}

const getVisibleTextFromParts = (parts: Part[]): string => (
  parts
    .filter((part) => part?.type === "text" && !isSyntheticPart(part))
    .map((part) => {
      const textPart = part as Part & { text?: string; content?: string }
      return (textPart.text || textPart.content || "").trim()
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
)

const truncateHandoffText = (text: string): string => {
  if (text.length <= CROSS_RUNTIME_HANDOFF_MAX_TEXT_CHARS) return text
  return `${text.slice(0, CROSS_RUNTIME_HANDOFF_MAX_TEXT_CHARS).trimEnd()}\n[truncated]`
}

const buildCrossRuntimeHandoffPart = (params: {
  sessionId: string
  targetProviderID: string
  directory?: string | null
}): { text: string; synthetic: true } | undefined => {
  const targetBackend = getProviderBackend(params.targetProviderID)
  if (!targetBackend || !params.sessionId) return undefined

  const sourceBackend = targetBackend === "cursor" ? "opencode" : "cursor"
  const messages = getSyncMessages(params.sessionId, params.directory ?? undefined) as Array<Message & Record<string, unknown>>
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  const candidates: Array<{ role: "user" | "assistant"; text: string }> = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const role = message?.role
    if (role !== "user" && role !== "assistant") {
      continue
    }

    const backend = getProviderBackend(getMessageProviderId(message))
    if (backend !== sourceBackend) {
      if (candidates.length > 0) break
      continue
    }

    const text = getVisibleTextFromParts(getSyncParts(message.id, params.directory ?? undefined) as Part[])
    if (!text) continue

    candidates.push({ role, text: truncateHandoffText(text) })
    if (candidates.length > CROSS_RUNTIME_HANDOFF_MAX_MESSAGES) break
  }

  if (candidates.length === 0) return undefined

  const sourceLabel = sourceBackend === "cursor" ? "Cursor SDK" : "OpenCode"
  const targetLabel = targetBackend === "cursor" ? "Cursor SDK" : "OpenCode"
  const header = `Conversation context from ${sourceLabel} turns, supplied because this reply is switching to ${targetLabel}:`
  const formatEntry = (entry: { role: "user" | "assistant"; text: string }): string => (
    `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`
  )
  const boundedCandidates = candidates.slice(0, CROSS_RUNTIME_HANDOFF_MAX_MESSAGES)
  const formatTranscript = (
    entriesNewestFirst: Array<{ role: "user" | "assistant"; text: string }>,
    omitted: boolean,
  ): string => [
    header,
    ...(omitted ? [CROSS_RUNTIME_HANDOFF_OMISSION_MARKER] : []),
    ...[...entriesNewestFirst].reverse().map(formatEntry),
  ].join("\n\n").trim()

  const completeText = formatTranscript(boundedCandidates, false)
  const hasOverflow = candidates.length > CROSS_RUNTIME_HANDOFF_MAX_MESSAGES
    || completeText.length > CROSS_RUNTIME_HANDOFF_MAX_CHARS
  if (!hasOverflow) {
    return { text: completeText, synthetic: true }
  }

  const retained: Array<{ role: "user" | "assistant"; text: string }> = []
  for (const candidate of boundedCandidates) {
    const next = [...retained, candidate]
    if (formatTranscript(next, true).length > CROSS_RUNTIME_HANDOFF_MAX_CHARS) break
    retained.push(candidate)
  }

  return { text: formatTranscript(retained, true), synthetic: true }
}

const withCrossRuntimeHandoffContext = <T extends { text: string; synthetic?: boolean }>(
  parts: T[] | undefined,
  handoff: { text: string; synthetic: true } | undefined,
): T[] | undefined => {
  if (!handoff) return parts
  return [handoff as T, ...(parts ?? [])]
}

const consumeStarterAssistantContext = (
  get: () => SessionUIState,
  set: (partial: Partial<SessionUIState> | ((state: SessionUIState) => Partial<SessionUIState> | SessionUIState)) => void,
  sessionId: string | null | undefined,
): StarterAssistantMessage | undefined => {
  if (!sessionId) return undefined
  const starter = get().starterAssistantMessages.get(sessionId)
  if (!starter?.pendingContext) return undefined
  set((state) => {
    const current = state.starterAssistantMessages.get(sessionId)
    if (!current?.pendingContext) return state
    const starterAssistantMessages = new Map(state.starterAssistantMessages)
    starterAssistantMessages.set(sessionId, { ...current, pendingContext: false })
    return { starterAssistantMessages }
  })
  return starter
}

const restoreStarterAssistantContext = (
  set: (partial: Partial<SessionUIState> | ((state: SessionUIState) => Partial<SessionUIState> | SessionUIState)) => void,
  starter: StarterAssistantMessage | undefined,
): void => {
  if (!starter) return
  set((state) => {
    const current = state.starterAssistantMessages.get(starter.sessionId)
    if (!current || current.pendingContext) return state
    const starterAssistantMessages = new Map(state.starterAssistantMessages)
    starterAssistantMessages.set(starter.sessionId, { ...current, pendingContext: true })
    return { starterAssistantMessages }
  })
}

const injectStarterAssistantMessage = (params: {
  sessionId: string
  directory: string | null
  sourceMessage: Message
  messageId: string
  partId: string
  text: string
  createdAt: number
}): void => {
  const directory = normalizePath(params.directory ?? opencodeClient.getDirectory() ?? null)
  if (!directory) return

  const starterMessage = {
    ...params.sourceMessage,
    id: params.messageId,
    sessionID: params.sessionId,
    parentID: "",
    role: "assistant" as const,
    time: {
      created: params.createdAt,
      completed: params.createdAt,
    },
  } as Message

  const starterPart = {
    id: params.partId,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: "text" as const,
    text: params.text,
  } as Part

  const stores = getSyncChildStores()
  const store = stores.ensureChild(directory, { bootstrap: false })
  store.setState((state) => {
    const existingMessages = state.message[params.sessionId] ?? []
    const hasMessage = existingMessages.some((message) => message.id === params.messageId)
    const nextMessages = hasMessage
      ? existingMessages
      : [...existingMessages, starterMessage].sort((left, right) => left.id.localeCompare(right.id))
    const existingParts = state.part[params.messageId]

    if (nextMessages === existingMessages && existingParts?.length === 1 && existingParts[0]?.id === params.partId) {
      return state
    }

    return {
      message: nextMessages === existingMessages ? state.message : { ...state.message, [params.sessionId]: nextMessages },
      part: existingParts ? state.part : { ...state.part, [params.messageId]: [starterPart] },
    }
  })
}

type PersistedPlanMessageState = {
  planModeUserMessages: Set<string>
  planModeUserMessagesBySession: Map<string, string>
  implementedPlanRequests: Set<string>
  externallyHandedOffPlanRequests: Set<string>
  sessionPlanIndicator: Map<string, PlanIndicatorEntry>
}

const limitStringSet = (values: Set<string>, maxSize: number): Set<string> => {
  if (values.size <= maxSize) return values
  return new Set([...values].slice(values.size - maxSize))
}

const limitStringMap = (values: Map<string, string>, maxSize: number): Map<string, string> => {
  if (values.size <= maxSize) return values
  return new Map([...values].slice(values.size - maxSize))
}

const readPersistedProposedPlanIndicators = (value: unknown): Map<string, PlanIndicatorEntry> => {
  const entries = (Array.isArray(value) ? value : [])
    .filter((entry): entry is [string, string] => Array.isArray(entry)
      && typeof entry[0] === "string"
      && entry[0].length > 0
      && typeof entry[1] === "string"
      && entry[1].length > 0)
    .map(([sessionId, sourceMessageId]): [string, PlanIndicatorEntry] => [
      sessionId,
      { state: "proposed", sourceMessageId },
    ])
  return new Map(entries.slice(-MAX_PERSISTED_PLAN_MESSAGE_IDS))
}

const collectPersistedProposedPlanIndicators = (
  sessionPlanIndicator: Map<string, PlanIndicatorEntry>,
): Map<string, string> => {
  const entries: Array<[string, string]> = []
  for (const [sessionId, entry] of sessionPlanIndicator) {
    if (entry.state !== "proposed" || !entry.sourceMessageId) continue
    entries.push([sessionId, entry.sourceMessageId])
  }
  return limitStringMap(new Map(entries), MAX_PERSISTED_PLAN_MESSAGE_IDS)
}

const readPersistedPlanMessageState = (): PersistedPlanMessageState => {
  try {
    const raw = safeStorage.getItem(PLAN_MESSAGE_STATE_STORAGE_KEY)
    if (!raw) {
      return {
        planModeUserMessages: new Set(),
        planModeUserMessagesBySession: new Map(),
        implementedPlanRequests: new Set(),
        externallyHandedOffPlanRequests: new Set(),
        sessionPlanIndicator: new Map(),
      }
    }
    const parsed = JSON.parse(raw) as {
      planModeUserMessages?: unknown
      planModeUserMessagesBySession?: unknown
      implementedPlanRequests?: unknown
      externallyHandedOffPlanRequests?: unknown
      proposedPlanIndicatorsBySession?: unknown
    }
    const planModeUserMessages = new Set(
      (Array.isArray(parsed.planModeUserMessages) ? parsed.planModeUserMessages : [])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )
    const planModeUserMessagesBySession = new Map(
      (Array.isArray(parsed.planModeUserMessagesBySession) ? parsed.planModeUserMessagesBySession : [])
        .filter((value): value is [string, string] => Array.isArray(value)
          && typeof value[0] === "string"
          && value[0].length > 0
          && typeof value[1] === "string"
          && value[1].length > 0),
    )
    const implementedPlanRequests = new Set(
      (Array.isArray(parsed.implementedPlanRequests) ? parsed.implementedPlanRequests : [])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )
    const externallyHandedOffPlanRequests = new Set(
      (Array.isArray(parsed.externallyHandedOffPlanRequests) ? parsed.externallyHandedOffPlanRequests : [])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )
    return {
      planModeUserMessages: limitStringSet(planModeUserMessages, MAX_PERSISTED_PLAN_MESSAGE_IDS),
      planModeUserMessagesBySession: limitStringMap(planModeUserMessagesBySession, MAX_PERSISTED_PLAN_MESSAGE_IDS),
      implementedPlanRequests: limitStringSet(implementedPlanRequests, MAX_PERSISTED_PLAN_MESSAGE_IDS),
      externallyHandedOffPlanRequests: limitStringSet(externallyHandedOffPlanRequests, MAX_PERSISTED_PLAN_MESSAGE_IDS),
      sessionPlanIndicator: readPersistedProposedPlanIndicators(parsed.proposedPlanIndicatorsBySession),
    }
  } catch {
    return {
      planModeUserMessages: new Set(),
      planModeUserMessagesBySession: new Map(),
      implementedPlanRequests: new Set(),
      externallyHandedOffPlanRequests: new Set(),
      sessionPlanIndicator: new Map(),
    }
  }
}

const persistPlanMessageState = (
  planModeUserMessages: Set<string>,
  implementedPlanRequests: Set<string>,
  externallyHandedOffPlanRequests: Set<string>,
  planModeUserMessagesBySession: Map<string, string>,
  sessionPlanIndicator: Map<string, PlanIndicatorEntry>,
): void => {
  try {
    const proposedPlanIndicatorsBySession = collectPersistedProposedPlanIndicators(sessionPlanIndicator)
    if (
      planModeUserMessages.size === 0
      && implementedPlanRequests.size === 0
      && externallyHandedOffPlanRequests.size === 0
      && planModeUserMessagesBySession.size === 0
      && proposedPlanIndicatorsBySession.size === 0
    ) {
      safeStorage.removeItem(PLAN_MESSAGE_STATE_STORAGE_KEY)
      return
    }
    const persisted: {
      planModeUserMessages: string[]
      planModeUserMessagesBySession: Array<[string, string]>
      implementedPlanRequests: string[]
      externallyHandedOffPlanRequests?: string[]
      proposedPlanIndicatorsBySession?: Array<[string, string]>
    } = {
      planModeUserMessages: [...limitStringSet(planModeUserMessages, MAX_PERSISTED_PLAN_MESSAGE_IDS)],
      planModeUserMessagesBySession: [...limitStringMap(planModeUserMessagesBySession, MAX_PERSISTED_PLAN_MESSAGE_IDS)],
      implementedPlanRequests: [...limitStringSet(implementedPlanRequests, MAX_PERSISTED_PLAN_MESSAGE_IDS)],
    }
    if (externallyHandedOffPlanRequests.size > 0) {
      persisted.externallyHandedOffPlanRequests = [
        ...limitStringSet(externallyHandedOffPlanRequests, MAX_PERSISTED_PLAN_MESSAGE_IDS),
      ]
    }
    if (proposedPlanIndicatorsBySession.size > 0) {
      persisted.proposedPlanIndicatorsBySession = [...proposedPlanIndicatorsBySession]
    }
    safeStorage.setItem(PLAN_MESSAGE_STATE_STORAGE_KEY, JSON.stringify(persisted))
  } catch { /* ignored */ }
}

const toNewSessionDraftState = (draft: ChatDraft | null | undefined): NewSessionDraftState => {
  if (!draft) return { ...DEFAULT_DRAFT }
  return {
    open: true,
    id: draft.id,
    selectedProjectId: draft.selectedProjectId ?? null,
    directoryOverride: draft.directoryOverride ?? null,
    pendingWorktreeRequestId: draft.pendingWorktreeRequestId ?? null,
    bootstrapPendingDirectory: draft.bootstrapPendingDirectory ?? null,
    preserveDirectoryOverride: draft.preserveDirectoryOverride === true,
    targetBranchName: draft.targetBranchName ?? null,
    targetPreparationError: draft.targetPreparationError ?? null,
    parentID: draft.parentID ?? null,
    title: draft.title,
    initialPrompt: draft.initialPrompt,
    syntheticParts: draft.syntheticParts,
    planMode: draft.planMode,
    sendConfig: normalizeDraftSendConfig(draft.sendConfig),
    targetFolderId: draft.targetFolderId,
  }
}

const resolveDraftProjectForDirectory = resolveProjectForSessionDirectory

const resolveManagedDraftAssignment = (
  projectId: string,
  preferredBranch?: string | null,
) => {
  const principal = getAuthPrincipal()
  if (principal.scope !== "managed" || principal.role === "admin") return null

  const assignments = principal.assignments.filter((entry) => entry.projectId === projectId)
  const preferredName = normalizeManagedBranchName(preferredBranch || "")
  if (preferredName) {
    const preferred = assignments.find((entry) => (
      normalizeManagedBranchName(entry.branchName) === preferredName
    ))
    if (preferred) return preferred
  }
  return assignments.find((entry) => entry.isDefault) ?? assignments[0] ?? null
}

const getAttachmentForSession = (sessionId: string | null | undefined): SessionWorktreeAttachment | undefined => {
  if (!sessionId) return undefined
  return useSessionWorktreeStore.getState().getAttachment(sessionId)
}

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
): string | null => {
  if (!sessionId) return null
  const attachmentDirectory = getAttachedSessionDirectory(getAttachmentForSession(sessionId))
  if (attachmentDirectory) return attachmentDirectory
  const metaPath = getWtMeta(sessionId)?.path
  if (typeof metaPath === "string" && metaPath.trim().length > 0) return normalizePath(metaPath)
  const sessions = getAllSyncSessions()
  const target = sessions.find((s) => s.id === sessionId)
  if (!target) return null
  return resolveDirectoryKey(target)
}

const resolveDirectoryForDraftSend = (draft: NewSessionDraftState): string | null => {
  const explicit = normalizePath(draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null)
  if (explicit) return explicit
  if (draft.pendingWorktreeRequestId || draft.targetPreparationError) return null

  const projectsState = useProjectsStore.getState()
  const selectedProject = draft.selectedProjectId
    ? projectsState.projects.find((project) => project.id === draft.selectedProjectId) ?? null
    : null
  const activeProject = selectedProject ?? projectsState.getActiveProject()
  const projectDirectory = normalizePath(activeProject?.path ?? null)
  if (projectDirectory) return projectDirectory

  const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
  if (currentDirectory) return currentDirectory

  return normalizePath(opencodeClient.getDirectory() ?? null)
}

const activateConfigForDirectory = async (directory: string | null | undefined): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory))
}

const activateConfigForDirectoryInBackground = (directory: string | null | undefined): void => {
  void activateConfigForDirectory(directory).catch((error) => {
    console.warn("[session-ui-store] Background directory activation failed after draft send", error)
  })
}

const prepareManagedDraftTarget = (input: {
  projectId: string
  branchName: string
  requestId: string
}): void => {
  void ensureManagedBranchTarget({
    projectId: input.projectId,
    branchName: input.branchName,
    idempotencyKey: input.requestId,
  }).then((result) => {
    resolvePendingDraftWorktreeRequest(input.requestId, result.directory)
    useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(input.requestId, result.directory, {
      projectId: input.projectId,
      bootstrapPendingDirectory: result.status === "pending" ? result.directory : null,
      preserveDirectoryOverride: true,
      targetBranchName: result.branchName,
      targetPreparationError: null,
    })
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to prepare assigned branch"
    rejectPendingDraftWorktreeRequest(input.requestId, new Error(message))
    useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(input.requestId, null, {
      projectId: input.projectId,
      bootstrapPendingDirectory: null,
      preserveDirectoryOverride: true,
      targetBranchName: input.branchName,
      targetPreparationError: message,
    })
  })
}

/**
 * After selecting an existing draft and activating its directory, restore live
 * agent/model/variant (and draft selection maps) from that draft's authoritative
 * resolution so UI, agent switches, prewarm, and first send stay aligned.
 * No-ops if the user has already switched away from `draftId`.
 */
const restoreLiveConfigForSelectedDraft = (draftId: string, getState: () => SessionUIState): void => {
  const state = getState()
  if (state.currentDraftId !== draftId) return

  const draft = state.draftsById[draftId]
  if (!draft) return

  const draftSendConfig = normalizeDraftSendConfig(
    draft.sendConfig ?? (state.currentDraftId === draftId ? state.newSessionDraft.sendConfig : undefined),
  )
  const selectionState = useSelectionStore.getState()
  const configState = useConfigStore.getState()
  const draftAgentSelection = selectionState.getDraftAgentSelection(draftId)
  const draftModelSelection = selectionState.getDraftModelSelection(draftId)
  const draftAgentForModel = draftAgentSelection ?? cleanSendConfigString(draftSendConfig?.agent)
  const draftAgentModelSelection = draftAgentForModel
    ? selectionState.getDraftAgentModelForSelection(draftId, draftAgentForModel)
    : null
  const draftVariantProviderID = draftAgentModelSelection?.providerId ?? draftModelSelection?.providerId ?? draftSendConfig?.providerID
  const draftVariantModelID = draftAgentModelSelection?.modelId ?? draftModelSelection?.modelId ?? draftSendConfig?.modelID
  const draftAgentModelVariant = draftAgentForModel && draftVariantProviderID && draftVariantModelID
    ? selectionState.getDraftAgentModelVariantForSelection(draftId, draftAgentForModel, draftVariantProviderID, draftVariantModelID)
    : undefined

  const draftSelection = resolveDraftSendSelection({
    requestedAgent: undefined,
    currentAgent: configState.currentAgentName,
    settingsDefaultAgent: configState.settingsDefaultAgent,
    agents: (configState.agents ?? []) as SendConfigAgent[],
    providers: (configState.providers ?? []) as SendConfigProvider[],
    inputProviderID: configState.currentProviderId,
    inputModelID: configState.currentModelId,
    inputVariant: configState.currentVariant,
    currentProviderID: configState.currentProviderId,
    currentModelID: configState.currentModelId,
    currentVariant: configState.currentVariant,
    draftAgentSelection,
    draftModelSelection,
    draftAgentModelSelection,
    draftAgentModelVariant,
    draftSendConfig,
  })

  if (!draftSelection.agent && !draftSelection.providerID) {
    useConfigStore.getState().applyDefaultsToCurrent({
      preserveCurrentModel: hasExplicitDraftModelIntent(draftSendConfig),
    })
    return
  }

  // A managed account's draft may carry a model captured from resolution
  // rather than a user's pick. Replaying it would mask the account's own
  // defaults, so only explicit picks are restored for managed non-admins.
  const restorePrincipal = getAuthPrincipal()
  const draftModelAuthoritative = !(restorePrincipal.scope === "managed" && restorePrincipal.role !== "admin")
    || hasExplicitDraftModelIntent(draftSendConfig)

  if (draftSelection.agent) {
    configState.setAgent(draftSelection.agent, {
      preserveCurrentModel: draftModelAuthoritative && Boolean(draftSelection.providerID && draftSelection.modelID),
      recordSessionSelection: false,
    })
    selectionState.saveDraftAgentSelection(draftId, draftSelection.agent)
  }

  if (draftSelection.providerID && draftSelection.modelID && draftModelAuthoritative) {
    configState.setProviderModel(draftSelection.providerID, draftSelection.modelID, draftSelection.variant)
    selectionState.saveDraftModelSelection(draftId, draftSelection.providerID, draftSelection.modelID)
    if (draftSelection.agent) {
      selectionState.saveDraftAgentModelForSelection(
        draftId,
        draftSelection.agent,
        draftSelection.providerID,
        draftSelection.modelID,
      )
      selectionState.saveDraftAgentModelVariantForSelection(
        draftId,
        draftSelection.agent,
        draftSelection.providerID,
        draftSelection.modelID,
        draftSelection.variant,
      )
    }
  }
}

const applyDefaultsForCurrentDraft = (draftId: string, getState: () => SessionUIState): void => {
  const state = getState()
  if (state.currentSessionId || state.currentDraftId !== draftId) return

  const draftSendConfig = state.draftsById[draftId]?.sendConfig
    ?? (state.newSessionDraft.id === draftId ? state.newSessionDraft.sendConfig : undefined)
  useConfigStore.getState().applyDefaultsToCurrent({
    preserveCurrentModel: hasExplicitDraftModelIntent(draftSendConfig),
  })
}

const applyCurrentSessionSideEffects = (
  id: string | null,
  directoryHint: string | null | undefined,
  previousSessionId: string | null,
  get: () => SessionUIState,
): void => {
  const directoryState = useDirectoryStore.getState()
  const sessionDir = resolveSessionDirectory(
    id,
    (sid) => get().worktreeMetadata.get(sid),
  )
  const fallbackDir = opencodeClient.getDirectory() ?? directoryState.currentDirectory ?? null
  const resolvedDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir ?? fallbackDir

  try {
    if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
      directoryState.setDirectory(resolvedDir, { showOverlay: false })
    }
    opencodeClient.setDirectory(resolvedDir ?? undefined)
  } catch (e) {
    console.warn("Failed to set OpenCode directory for session switch:", e)
  }

  // Defer viewport anchor save for previous session — not needed for the
  // skeleton to render and reads messages which can be expensive.
  if (previousSessionId && previousSessionId !== id) {
    const prevId = previousSessionId
    setTimeout(() => {
      const memState = useViewportStore.getState().sessionMemoryState.get(prevId)
      if (!memState?.isStreaming) {
        const prevMessages = getSyncMessages(prevId)
        if (prevMessages.length > 0) {
          useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
        }
      }
    }, 0)
  }

  // Mark the selected session and any loaded descendants viewed; parent rows
  // aggregate subagent completions, so selecting the parent must clear that scope.
  if (id) {
    const viewedSessionIds = getSessionIdsWithDescendants([id])
    markSessionsViewed(viewedSessionIds)
    get().clearReadCompletionIndicators(viewedSessionIds)
    setActiveSession(resolvedDir ?? "", id)
  } else {
    setActiveSession("", "")
  }
}

const DEFAULT_DRAFT: NewSessionDraftState = {
  open: false,
  directoryOverride: null,
  pendingWorktreeRequestId: null,
  bootstrapPendingDirectory: null,
  preserveDirectoryOverride: false,
  targetBranchName: null,
  targetPreparationError: null,
  parentID: null,
}

const cleanSendConfigString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const normalizeDraftSendConfig = (sendConfig: SendConfig | null | undefined): SendConfig | undefined => {
  if (!sendConfig) return undefined
  const next: SendConfig = {}
  const providerID = cleanSendConfigString(sendConfig.providerID)
  const modelID = cleanSendConfigString(sendConfig.modelID)
  const agent = cleanSendConfigString(sendConfig.agent)
  const variant = cleanSendConfigString(sendConfig.variant)
  const modelProvenance = normalizeSendConfigModelProvenance(sendConfig.modelProvenance)
  if (providerID) next.providerID = providerID
  if (modelID) next.modelID = modelID
  if (agent) next.agent = agent
  if (variant) next.variant = variant
  if (typeof sendConfig.planMode === "boolean") next.planMode = sendConfig.planMode
  if (modelProvenance) next.modelProvenance = modelProvenance
  return Object.keys(next).length > 0 ? next : undefined
}

const mergeDraftSendConfig = (current: SendConfig | null | undefined, patch: SendConfig): SendConfig | undefined => {
  const next: SendConfig = { ...(normalizeDraftSendConfig(current) ?? {}) }
  const assignString = (key: "providerID" | "modelID" | "agent" | "variant") => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return
    const value = cleanSendConfigString(patch[key])
    if (value) {
      next[key] = value
    } else {
      delete next[key]
    }
  }

  assignString("providerID")
  assignString("modelID")
  assignString("agent")
  assignString("variant")

  if (Object.prototype.hasOwnProperty.call(patch, "planMode")) {
    if (typeof patch.planMode === "boolean") {
      next.planMode = patch.planMode
    } else {
      delete next.planMode
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "modelProvenance")) {
    const provenance = normalizeSendConfigModelProvenance(patch.modelProvenance)
    if (provenance) {
      next.modelProvenance = provenance
    } else {
      delete next.modelProvenance
    }
  }

  return Object.keys(next).length > 0 ? next : undefined
}

const getDraftPromotionText = (value?: string | null): string => (
  typeof value === "string" ? value.trim() : ""
)

const getDraftPromotionDirectory = (
  draft: Pick<ChatDraft, "bootstrapPendingDirectory" | "directoryOverride"> | null | undefined,
  fallback?: string | null,
): string | null => normalizePath(draft?.bootstrapPendingDirectory ?? draft?.directoryOverride ?? fallback ?? null)

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  currentDraftId: null,
  ...readPersistedDrafts(safeStorage),
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  sessionDirectoryHints: new Map(),
  availableWorktrees: [],
  availableWorktreesByProject: new Map(),
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,
  sessionPlanAvailable: new Map(),
  sessionCompletionIndicator: new Map(),
  starterAssistantMessages: new Map(),
  ...readPersistedPlanMessageState(),
  pendingChangesBarDismissed: new Map(),

  claimPendingSendAbort: (key, controller = new AbortController()) => {
    if (!key) return controller
    if (get().abortControllers.has(key)) return null
    set((state) => {
      if (state.abortControllers.has(key)) return state
      const abortControllers = new Map(state.abortControllers)
      abortControllers.set(key, controller)
      return { abortControllers }
    })
    return get().abortControllers.get(key) === controller ? controller : null
  },

  promotePendingSendAbort: (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) {
      return get().abortControllers.get(fromKey || toKey) ?? null
    }
    const controller = get().abortControllers.get(fromKey)
    if (!controller) return null
    set((state) => {
      const abortControllers = new Map(state.abortControllers)
      abortControllers.delete(fromKey)
      abortControllers.set(toKey, controller)
      return { abortControllers }
    })
    return controller
  },

  abortPendingSend: (key) => {
    if (!key) return false
    const controller = get().abortControllers.get(key)
    if (!controller) return false
    controller.abort()
    set((state) => {
      const abortControllers = new Map(state.abortControllers)
      abortControllers.delete(key)
      return { abortControllers }
    })
    return true
  },

  clearPendingSendAbort: (key, controller) => {
    if (!key) return
    set((state) => {
      const current = state.abortControllers.get(key)
      if (!current || (controller && current !== controller)) return state
      const abortControllers = new Map(state.abortControllers)
      abortControllers.delete(key)
      return { abortControllers }
    })
  },

  hasPendingSendAbort: (key) => Boolean(key && get().abortControllers.has(key)),

  getStarterAssistantMessage: (sessionId) => get().starterAssistantMessages.get(sessionId),

  clearStarterAssistantPendingContext: (sessionId) => {
    set((state) => {
      const current = state.starterAssistantMessages.get(sessionId)
      if (!current?.pendingContext) return state
      const next = new Map(state.starterAssistantMessages)
      next.set(sessionId, { ...current, pendingContext: false })
      return { starterAssistantMessages: next }
    })
  },

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null) => {
    const previousSessionId = get().currentSessionId

    // Set currentSessionId immediately so the skeleton renders without delay.
    set({
      currentSessionId: id,
      currentDraftId: id ? null : get().currentDraftId,
      newSessionDraft: id ? { ...DEFAULT_DRAFT } : get().newSessionDraft,
    })
    applyCurrentSessionSideEffects(id, directoryHint, previousSessionId, get)
  },

  // ---------------------------------------------------------------------------
  // openNewSessionDraft
  // ---------------------------------------------------------------------------
  openNewSessionDraft: (options) => {
    const projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = get().availableWorktreesByProject
    const activeProject = projectsState.getActiveProject()
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    const explicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const explicitProject = options?.selectedProjectId
      ? projects.find((p) => p.id === options.selectedProjectId) ?? null
      : null

    const inferredProjectFromDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, explicitDirectory)
    const fallbackProject = (() => {
      if (activeProject) return activeProject
      if (projectsState.activeProjectId) return projects.find((p) => p.id === projectsState.activeProjectId) ?? null
      return projects[0] ?? null
    })()

    const persistedProjectById = persistedTarget?.projectId
      ? projects.find((p) => p.id === persistedTarget.projectId) ?? null
      : null
    const persistedProjectByDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const currentDirProject = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, currentDirectory)

    const selectedProject = (() => {
      if (explicitProject || explicitDirectory !== null) {
        return explicitProject ?? inferredProjectFromDir ?? fallbackProject
      }
      if (currentDirectory) return currentDirProject ?? fallbackProject
      return persistedProjectByDir ?? persistedProjectById ?? fallbackProject
    })()

    const principal = getAuthPrincipal()
    const defaultAssignment = selectedProject
      ? resolveManagedDraftAssignment(selectedProject.id, options?.targetBranchName)
      : null
    const projectRoot = normalizePath(selectedProject?.path ?? null)
    const shouldPrepareManagedTarget = principal.scope === "managed"
      && principal.role !== "admin"
      && Boolean(defaultAssignment?.branchName)
      && (options?.directoryOverride === undefined || explicitDirectory === projectRoot)
    const managedTargetRequestId = shouldPrepareManagedTarget
      ? (options?.pendingWorktreeRequestId ?? createPendingDraftWorktreeRequest())
      : null

    const directory = (() => {
      if (shouldPrepareManagedTarget) return null
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      if (currentDirectory) return currentDirectory
      if (persistedTarget?.directory) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    persistDraftTarget({ projectId: selectedProject?.id ?? null, directory })

    const now = Date.now()
    const draft: ChatDraft = {
      id: createDraftId(),
      text: options?.initialPrompt ?? "",
      createdAt: now,
      updatedAt: now,
      selectedProjectId: selectedProject?.id ?? null,
      directoryOverride: directory,
      pendingWorktreeRequestId: managedTargetRequestId ?? options?.pendingWorktreeRequestId ?? null,
      bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true,
      targetBranchName: shouldPrepareManagedTarget ? defaultAssignment?.branchName ?? null : options?.targetBranchName ?? null,
      targetPreparationError: options?.targetPreparationError ?? null,
      parentID: options?.parentID ?? null,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
      syntheticParts: options?.syntheticParts,
      planMode: options?.planMode,
      sendConfig: normalizeDraftSendConfig(options?.sendConfig),
      targetFolderId: options?.targetFolderId,
    }

    set((s) => {
      const isPersistableDraft = (existing: ChatDraft): boolean =>
        existing.text.trim().length > 0 || Boolean(normalizeDraftSendConfig(existing.sendConfig))

      // Empty, unconfigured inactive drafts are editor placeholders, not saved draft rows.
      // Drop them when a new draft is created so they cannot accumulate in storage.
      Object.entries(s.draftsById).forEach(([id, existing]) => {
        if (id !== s.currentDraftId && !isPersistableDraft(existing)) {
          removePersistedDraftInput(safeStorage, id)
        }
      })
      const retainedDrafts = Object.fromEntries(
        Object.entries(s.draftsById).filter(([id, existing]) => id === s.currentDraftId || isPersistableDraft(existing)),
      ) as Record<string, ChatDraft>
      const draftsById = { ...retainedDrafts, [draft.id]: draft }
      const draftOrder = [draft.id, ...s.draftOrder.filter((id) => id !== draft.id && Boolean(retainedDrafts[id]))]
      persistDrafts(safeStorage, draftsById, draftOrder)
      return {
        draftsById,
        draftOrder,
        currentDraftId: draft.id,
        newSessionDraft: toNewSessionDraftState(draft),
        currentSessionId: null,
        error: null,
      }
    })

    useInputStore.getState().clearAttachedFiles()
    setActiveSession("", "")

    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    if (shouldPrepareManagedTarget && managedTargetRequestId && selectedProject && defaultAssignment) {
      prepareManagedDraftTarget({
        projectId: selectedProject.id,
        branchName: defaultAssignment.branchName,
        requestId: managedTargetRequestId,
      })
    }

    const activation = activateConfigForDirectory(directory)
    // activateDirectory restores a cached directory snapshot synchronously before
    // its first await. Apply the draft defaults in the same turn so the composer
    // never paints a previous session's model or thinking level.
    applyDefaultsForCurrentDraft(draft.id, get)
    void activation.then(() => {
      // Reapply after provider/agent refresh for cold or changed directories.
      applyDefaultsForCurrentDraft(draft.id, get)
    })
  },

  selectNewSessionDraft: (draftId) => {
    const existingDraft = get().draftsById[draftId]
    if (!existingDraft) return

    const project = existingDraft.selectedProjectId
      ? useProjectsStore.getState().projects.find((entry) => entry.id === existingDraft.selectedProjectId) ?? null
      : null
    const projectRoot = normalizePath(project?.path ?? null)
    const draftDirectory = normalizePath(
      existingDraft.bootstrapPendingDirectory ?? existingDraft.directoryOverride ?? null,
    )
    const assignment = project && (!draftDirectory || draftDirectory === projectRoot)
      ? resolveManagedDraftAssignment(project.id, existingDraft.targetBranchName)
      : null
    const shouldPrepareManagedTarget = Boolean(project && assignment?.branchName)

    let requestId = existingDraft.pendingWorktreeRequestId ?? null
    let shouldLaunchPreparation = false
    if (shouldPrepareManagedTarget && !hasPendingDraftWorktreeRequest(requestId)) {
      requestId = createPendingDraftWorktreeRequest()
      shouldLaunchPreparation = true
    }

    const draft: ChatDraft = shouldPrepareManagedTarget && project && assignment
      ? {
          ...existingDraft,
          directoryOverride: null,
          pendingWorktreeRequestId: requestId,
          bootstrapPendingDirectory: null,
          preserveDirectoryOverride: true,
          targetBranchName: assignment.branchName,
          targetPreparationError: null,
          updatedAt: Date.now(),
        }
      : existingDraft

    persistDraftTarget({ projectId: draft.selectedProjectId ?? null, directory: normalizePath(draft.directoryOverride ?? null) })
    set((state) => {
      const draftsById = draft === existingDraft
        ? state.draftsById
        : { ...state.draftsById, [draftId]: draft }
      if (draftsById !== state.draftsById) persistDrafts(safeStorage, draftsById, state.draftOrder)
      return {
        draftsById,
        currentSessionId: null,
        currentDraftId: draftId,
        newSessionDraft: toNewSessionDraftState(draft),
        error: null,
      }
    })
    setActiveSession("", "")

    if (shouldLaunchPreparation && project && assignment && requestId) {
      prepareManagedDraftTarget({
        projectId: project.id,
        branchName: assignment.branchName,
        requestId,
      })
    }

    if (draft.pendingWorktreeRequestId) return
    void activateConfigForDirectory(draft.directoryOverride ?? null).then(() => {
      if (get().currentDraftId !== draftId) return
      restoreLiveConfigForSelectedDraft(draftId, get)
    })
  },

  updateNewSessionDraftText: (draftId, text) => {
    set((s) => {
      const existing = s.draftsById[draftId]
      if (!existing || existing.text === text) return s
      const nextDraft = { ...existing, text, updatedAt: Date.now() }
      const draftsById = { ...s.draftsById, [draftId]: nextDraft }
      persistDrafts(safeStorage, draftsById, s.draftOrder)
      return { draftsById }
    })
  },

  deleteNewSessionDraft: (draftId) => {
    useSelectionStore.getState().clearDraftSelection(draftId)
    set((s) => {
      if (!s.draftsById[draftId]) return s
      const draftsById = { ...s.draftsById }
      delete draftsById[draftId]
      removePersistedDraftInput(safeStorage, draftId)
      const draftOrder = s.draftOrder.filter((id) => id !== draftId)
      const nextDraftId = s.currentDraftId === draftId ? draftOrder[0] ?? null : s.currentDraftId
      const nextDraft = nextDraftId ? draftsById[nextDraftId] : null
      persistDrafts(safeStorage, draftsById, draftOrder)
      return {
        draftsById,
        draftOrder,
        currentDraftId: nextDraftId,
        currentSessionId: nextDraftId ? null : s.currentSessionId,
        newSessionDraft: nextDraftId ? toNewSessionDraftState(nextDraft) : { ...DEFAULT_DRAFT },
      }
    })
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    const draftId = get().currentDraftId
    if (draftId) {
      get().deleteNewSessionDraft(draftId)
      return
    }
    set({
      currentDraftId: null,
      newSessionDraft: {
        open: false,
        selectedProjectId: null,
        directoryOverride: null,
        pendingWorktreeRequestId: null,
        bootstrapPendingDirectory: null,
        preserveDirectoryOverride: false,
        targetBranchName: null,
        targetPreparationError: null,
        parentID: null,
        title: undefined,
        initialPrompt: undefined,
        syntheticParts: undefined,
        sendConfig: undefined,
        targetFolderId: undefined,
      },
    })
  },

  promoteDraftToSession: ({ draftId, sessionId, directoryHint, submittedText }) => {
    const previousSessionId = get().currentSessionId
    set((s) => {
      let draftsById = s.draftsById
      let draftOrder = s.draftOrder
      const removedDraftIds = new Set<string>()
      const promotedDraft = draftId ? s.draftsById[draftId] : null
      const promotedText = getDraftPromotionText(promotedDraft?.text ?? submittedText ?? null)
      const promotedDirectory = getDraftPromotionDirectory(promotedDraft, directoryHint ?? null)

      if (draftId) {
        removedDraftIds.add(draftId)
      }

      if (promotedText.length > 0) {
        for (const [id, draft] of Object.entries(s.draftsById)) {
          if (id === draftId) continue
          if (getDraftPromotionText(draft.text) !== promotedText) continue
          if (getDraftPromotionDirectory(draft) !== promotedDirectory) continue
          removedDraftIds.add(id)
        }
      }

      if (removedDraftIds.size > 0) {
        draftsById = { ...s.draftsById }
        for (const removedDraftId of removedDraftIds) {
          delete draftsById[removedDraftId]
          removePersistedDraftInput(safeStorage, removedDraftId)
        }
        draftOrder = s.draftOrder.filter((id) => !removedDraftIds.has(id))
      }

      clearLegacyNewDraftInput(safeStorage)
      persistDrafts(safeStorage, draftsById, draftOrder)

      return {
        draftsById,
        draftOrder,
        currentSessionId: sessionId,
        currentDraftId: null,
        newSessionDraft: { ...DEFAULT_DRAFT },
        error: null,
      }
    })
    applyCurrentSessionSideEffects(sessionId, directoryHint, previousSessionId, get)
  },

  setNewSessionDraftTarget: (target) => {
    let nextDirectory: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const updatedDraft = currentDraft
        ? {
            ...currentDraft,
            selectedProjectId: target.projectId ?? target.selectedProjectId ?? currentDraft.selectedProjectId,
            directoryOverride: target.directoryOverride ?? currentDraft.directoryOverride,
            updatedAt: Date.now(),
          }
        : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return {
        draftsById,
        newSessionDraft: {
          ...s.newSessionDraft,
          id: updatedDraft?.id ?? s.newSessionDraft.id,
          selectedProjectId: target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId,
          directoryOverride: target.directoryOverride ?? s.newSessionDraft.directoryOverride,
        },
      }
    })
    void activateConfigForDirectory(nextDirectory)
  },

  updateNewSessionDraftSendConfig: (patch) => {
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const nextSendConfig = mergeDraftSendConfig(currentDraft?.sendConfig ?? s.newSessionDraft.sendConfig, patch)
      const updatedDraft = currentDraft ? { ...currentDraft, sendConfig: nextSendConfig, updatedAt: Date.now() } : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return {
        draftsById,
        newSessionDraft: {
          ...s.newSessionDraft,
          sendConfig: nextSendConfig,
        },
      }
    })
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const updatedDraft = currentDraft ? { ...currentDraft, preserveDirectoryOverride: value, updatedAt: Date.now() } : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return { draftsById, newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  acknowledgeSessionAbort: (sessionId) =>
    set((s) => {
      const flags = new Map(s.sessionAbortFlags)
      const existing = flags.get(sessionId)
      if (existing) flags.set(sessionId, { ...existing, acknowledged: true })
      return { sessionAbortFlags: flags }
    }),

  clearAbortPrompt: () => set({ abortPromptSessionId: null, abortPromptExpiresAt: null }),

  armAbortPrompt: (durationMs = 5000) => {
    const { currentSessionId } = get()
    if (!currentSessionId) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: currentSessionId, abortPromptExpiresAt: expiresAt })
    return expiresAt
  },

  clearError: () => set({ error: null }),

  markSessionAsOpenChamberCreated: (sessionId) =>
    set((s) => {
      const next = new Set(s.webUICreatedSessions)
      next.add(sessionId)
      return { webUICreatedSessions: next }
    }),

  isOpenChamberCreatedSession: (sessionId) => get().webUICreatedSessions.has(sessionId),

  getContextUsage: (capacity: ResolvedModelContextCapacity) => {
    if (get().newSessionDraft?.open) return null
    const sessionId = get().currentSessionId
    if (!sessionId) return null

    const state = getDirectoryState()
    const messages = state?.message[sessionId] ?? getSyncMessages(sessionId)
    if (messages.length === 0) return null
    const usage = getContextUsageFromMessages(messages, capacity)
    if (!usage || !state) return usage

    const relatedSubagents = getSubagentContextUsageForSession(
      sessionId,
      state.session,
      (childSessionId) => state.message[childSessionId] ?? [],
      (_session, childMessages) => resolveContextCapacityFromMessages(childMessages),
    )

    return attachRelatedSubagentContextUsage(usage, relatedSubagents)
  },

  initializeNewOpenChamberSession: () => {
    // Stub — was a no-op in old store
  },

  setWorktreeMetadata: (sessionId, metadata) => {
    // Write to authoritative session-worktree-store
    if (metadata) {
      useSessionWorktreeStore.getState().setAttachment(sessionId, {
        worktreeRoot: metadata.worktreeRoot ?? metadata.path ?? null,
        cwd: metadata.path ?? null,
        branch: metadata.branch ?? null,
        headState: metadata.headState ?? (metadata.branch ? 'branch' : 'detached'),
        worktreeStatus: metadata.worktreeStatus ?? 'ready',
        worktreeSource: metadata.worktreeSource ?? null,
        legacy: false,
        degraded: false,
      })
    } else {
      useSessionWorktreeStore.getState().clearAttachment(sessionId)
    }
    // Also keep local map for backward compatibility
    set((s) => {
      const map = new Map(s.worktreeMetadata)
      if (metadata) map.set(sessionId, metadata)
      else map.delete(sessionId)
      return { worktreeMetadata: map }
    })
  },

  overrideNewSessionDraftTarget: (options) => {
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const draftOptions = options as Partial<ChatDraft>
      const hasDraftOption = (key: keyof ChatDraft): boolean => Object.prototype.hasOwnProperty.call(draftOptions, key)
      const updatedDraft = currentDraft
        ? {
            ...currentDraft,
            ...draftOptions,
            directoryOverride: normalizePath(hasDraftOption("directoryOverride")
              ? draftOptions.directoryOverride
              : currentDraft.directoryOverride),
            bootstrapPendingDirectory: normalizePath(hasDraftOption("bootstrapPendingDirectory")
              ? draftOptions.bootstrapPendingDirectory
              : currentDraft.bootstrapPendingDirectory),
            updatedAt: Date.now(),
          }
        : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return { draftsById, newSessionDraft: nextDraft }
    })
    void activateConfigForDirectory(nextDirectory)
  },

  resolvePendingDraftWorktreeTarget: (requestId, directory, options) => {
    let resolvedCurrentDraftId: string | null = null
    let resolvedProjectId: string | null = null
    const hasOption = (key: string): boolean => Object.prototype.hasOwnProperty.call(options ?? {}, key)

    set((s) => {
      const draftEntry = Object.entries(s.draftsById).find(([, draft]) => (
        draft.pendingWorktreeRequestId === requestId
      ))
      if (!draftEntry) return s

      const [draftId, currentDraft] = draftEntry
      const bootstrapPendingDirectory = hasOption("bootstrapPendingDirectory")
        ? normalizePath(options?.bootstrapPendingDirectory as string | null | undefined)
        : normalizePath(currentDraft.bootstrapPendingDirectory ?? null)
      const updatedDraft: ChatDraft = {
        ...currentDraft,
        selectedProjectId: hasOption("projectId")
          ? (options?.projectId as string | null | undefined) ?? null
          : currentDraft.selectedProjectId ?? null,
        directoryOverride: normalizePath(directory),
        pendingWorktreeRequestId: null,
        bootstrapPendingDirectory,
        preserveDirectoryOverride: hasOption("preserveDirectoryOverride")
          ? options?.preserveDirectoryOverride === true
          : true,
        targetBranchName: hasOption("targetBranchName")
          ? (options?.targetBranchName as string | null | undefined) ?? null
          : currentDraft.targetBranchName ?? null,
        targetPreparationError: hasOption("targetPreparationError")
          ? (options?.targetPreparationError as string | null | undefined) ?? null
          : null,
        updatedAt: Date.now(),
      }
      const draftsById = { ...s.draftsById, [draftId]: updatedDraft }
      persistDrafts(safeStorage, draftsById, s.draftOrder)

      const isCurrentDraft = s.currentDraftId === draftId && s.newSessionDraft?.open
      if (isCurrentDraft) {
        resolvedCurrentDraftId = draftId
        resolvedProjectId = updatedDraft.selectedProjectId ?? null
      }
      return {
        draftsById,
        newSessionDraft: isCurrentDraft ? toNewSessionDraftState(updatedDraft) : s.newSessionDraft,
      }
    })

    if (!resolvedCurrentDraftId) return
    persistDraftTarget({
      projectId: resolvedProjectId,
      directory: normalizePath(directory),
    })
    if (!directory) return
    const draftId = resolvedCurrentDraftId
    void activateConfigForDirectory(directory).then(() => {
      restoreLiveConfigForSelectedDraft(draftId, get)
    }).catch((error) => {
      console.warn("[session-ui-store] Failed to activate prepared managed draft directory", error)
    })
  },

  setDraftBootstrapPendingDirectory: (directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const updatedDraft = currentDraft ? { ...currentDraft, bootstrapPendingDirectory: normalizePath(directory), updatedAt: Date.now() } : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return { draftsById, newSessionDraft: { ...s.newSessionDraft, bootstrapPendingDirectory: normalizePath(directory) } }
    }),

  setPendingDraftWorktreeRequest: (requestId) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const currentDraft = s.currentDraftId ? s.draftsById[s.currentDraftId] : null
      const updatedDraft = currentDraft ? { ...currentDraft, pendingWorktreeRequestId: requestId, updatedAt: Date.now() } : null
      const draftsById = updatedDraft ? { ...s.draftsById, [updatedDraft.id]: updatedDraft } : s.draftsById
      if (updatedDraft) persistDrafts(safeStorage, draftsById, s.draftOrder)
      return { draftsById, newSessionDraft: { ...s.newSessionDraft, pendingWorktreeRequestId: requestId } }
    }),

  getWorktreeMetadata: (sessionId) => get().worktreeMetadata.get(sessionId),

  dismissPendingChangesBar: (sessionId, signature) => {
    const map = new Map(get().pendingChangesBarDismissed);
    if (signature === null) {
      map.delete(sessionId);
    } else {
      map.set(sessionId, signature);
    }
    set({ pendingChangesBarDismissed: map });
  },

  // ---------------------------------------------------------------------------
  // sendMessage — calls SDK, reads domain data from sync
  // ---------------------------------------------------------------------------
  sendMessage: async (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    planMode?: boolean,
  ) => {
    streamDebugMark("first-reply-send-start", {
      hasCurrentSession: Boolean(get().currentSessionId),
      inputMode: inputMode ?? "normal",
    })
    // Clear non-Git changed-files bar on new user message for current session
    const sid = get().currentSessionId;
    if (sid) {
      const map = new Map(get().pendingChangesBarDismissed);
      map.delete(sid);
      set({ pendingChangesBarDismissed: map });
      get().clearSessionTurnCompletion(sid)
    }

    const draft = get().newSessionDraft
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined

    // ---- New session from draft ----
    if (draft?.open) {
      const draftTargetFolderId = draft.targetFolderId
      const capturedDraftId = get().currentDraftId ?? draft.id ?? null
      const draftAbortKey = capturedDraftId ? `draft:${capturedDraftId}` : "draft"
      const draftAbortController = get().claimPendingSendAbort(draftAbortKey)
      if (!draftAbortController) return
      let pendingAbortKey = draftAbortKey
      try {
      if (draft.targetPreparationError) {
        get().clearPendingSendAbort(draftAbortKey, draftAbortController)
        throw new Error(draft.targetPreparationError)
      }
      const capturedDraft = capturedDraftId ? get().draftsById[capturedDraftId] : null
      const draftSendConfig = normalizeDraftSendConfig(capturedDraft?.sendConfig ?? draft.sendConfig)
      const resolvedPlanMode = typeof draftSendConfig?.planMode === "boolean"
        ? draftSendConfig.planMode
        : (planMode ?? draft.planMode ?? useSelectionStore.getState().getPlanModeSelection(null))
      const submittedDraftText = content
      const submittedAttachments = attachments?.map((attachment) => ({ ...attachment }))
      let draftDirectoryOverride = resolveDirectoryForDraftSend(draft)
      let draftBootstrapPendingDirectory = normalizePath(draft.bootstrapPendingDirectory ?? null)
      let draftBootstrapWaitPromise: Promise<unknown> | null = null
      const draftProjectId = draft.selectedProjectId ?? null
      const selectionState = useSelectionStore.getState()
      const draftAgentSelection = capturedDraftId ? selectionState.getDraftAgentSelection(capturedDraftId) : null
      const draftModelSelection = capturedDraftId ? selectionState.getDraftModelSelection(capturedDraftId) : null
      const draftAgentForModel = draftAgentSelection ?? trimmedAgent
      const draftAgentModelSelection = capturedDraftId && draftAgentForModel
        ? selectionState.getDraftAgentModelForSelection(capturedDraftId, draftAgentForModel)
        : null
      const draftVariantProviderID = draftAgentModelSelection?.providerId ?? draftModelSelection?.providerId ?? providerID
      const draftVariantModelID = draftAgentModelSelection?.modelId ?? draftModelSelection?.modelId ?? modelID
      const draftAgentModelVariant = capturedDraftId && draftAgentForModel && draftVariantProviderID && draftVariantModelID
        ? selectionState.getDraftAgentModelVariantForSelection(capturedDraftId, draftAgentForModel, draftVariantProviderID, draftVariantModelID)
        : undefined
      const configState = useConfigStore.getState()

      if (draft.pendingWorktreeRequestId) {
        draftDirectoryOverride = await waitForPendingDraftWorktreeRequest(draft.pendingWorktreeRequestId)
        throwIfAborted(draftAbortController.signal)
        get().resolvePendingDraftWorktreeTarget(draft.pendingWorktreeRequestId, draftDirectoryOverride)
        draftBootstrapPendingDirectory = normalizePath(
          get().newSessionDraft.bootstrapPendingDirectory ?? null,
        )
        // The worktree-bootstrap wait is independent of config activation, so
        // start it now and await it at its usual gate below — serializing the
        // two costs a full round-trip each on the send path. The inline catch
        // only suppresses the unhandled-rejection warning; the awaited promise
        // still rejects at the gate.
        if (draftDirectoryOverride && draftBootstrapPendingDirectory) {
          draftBootstrapWaitPromise = waitForWorktreeBootstrapForSend(draftDirectoryOverride)
          draftBootstrapWaitPromise.catch(() => {})
        }
        await activateConfigForDirectory(draftDirectoryOverride)
        throwIfAborted(draftAbortController.signal)
      }

      const draftSelection = resolveDraftSendSelection({
        requestedAgent: draftAgentSelection ? undefined : trimmedAgent,
        currentAgent: configState.currentAgentName,
        settingsDefaultAgent: configState.settingsDefaultAgent,
        agents: (configState.agents ?? []) as SendConfigAgent[],
        providers: (configState.providers ?? []) as SendConfigProvider[],
        inputProviderID: providerID,
        inputModelID: modelID,
        inputVariant: variant,
        currentProviderID: configState.currentProviderId,
        currentModelID: configState.currentModelId,
        currentVariant: configState.currentVariant,
        draftAgentSelection,
        draftModelSelection,
        draftAgentModelSelection,
        draftAgentModelVariant,
        draftSendConfig,
      })
      const effectiveDraftAgent = draftSelection.agent
      const effectiveProviderID = draftSelection.providerID
      const effectiveModelID = draftSelection.modelID
      const effectiveVariant = draftSelection.variant

      if (!effectiveProviderID || !effectiveModelID) {
        get().clearPendingSendAbort(draftAbortKey, draftAbortController)
        throw new Error("Cannot send message: provider or model not selected")
      }

      if (draftDirectoryOverride && draftBootstrapPendingDirectory) {
        try {
          await (draftBootstrapWaitPromise ?? waitForWorktreeBootstrapForSend(draftDirectoryOverride))
          throwIfAborted(draftAbortController.signal)
        } catch (error) {
          get().clearPendingSendAbort(draftAbortKey, draftAbortController)
          throw error
        }
      }

      const created = await createSessionRecordAction(draft.title, draftDirectoryOverride, draft.parentID ?? null)
      if (!created?.id) {
        get().clearPendingSendAbort(draftAbortKey, draftAbortController)
        const createError = consumeLastCreateSessionError()
        if (createError instanceof Error) {
          throw createError
        }
        throw new Error("Failed to create session")
      }
      const createdDirectory = normalizePath(draftDirectoryOverride ?? created.directory ?? null)
      if (effectiveDraftAgent?.trim().toLowerCase() === "builder") {
        useSelectionStore.getState().markBuilderHandoffCleared(created.id)
      }
      const promotedAbortController = get().promotePendingSendAbort(draftAbortKey, created.id) ?? draftAbortController
      pendingAbortKey = created.id
      if (promotedAbortController.signal.aborted) {
        await abortCurrentOperationAction(created.id)
        get().clearPendingSendAbort(created.id, promotedAbortController)
        throw createAbortError()
      }
      streamDebugMark("first-reply-session-created", {
        sessionId: created.id,
        directory: createdDirectory,
      })

      persistDraftTarget({
        projectId: draftProjectId,
        directory: createdDirectory,
      })

      const draftSyntheticParts = draft.syntheticParts

      activateConfigForDirectoryInBackground(draftDirectoryOverride ?? created.directory ?? null)

      if (capturedDraftId) {
        useSelectionStore.getState().promoteDraftSelectionToSession(capturedDraftId, created.id)
      }

      if (effectiveProviderID && effectiveModelID) {
        useSelectionStore.getState().saveSessionModelSelection(created.id, effectiveProviderID, effectiveModelID)
      }

      if (effectiveDraftAgent) {
        useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
        if (effectiveProviderID && effectiveModelID) {
          useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, effectiveProviderID, effectiveModelID)
          useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, effectiveProviderID, effectiveModelID, effectiveVariant)
        }
      }

      if (resolvedPlanMode) {
        useSelectionStore.getState().setSessionPlanMode(created.id, true)
      }
      useSelectionStore.getState().clearDraftPlanMode()

      get().initializeNewOpenChamberSession(created.id, configState.agents ?? [])

      get().promoteDraftToSession({
        draftId: capturedDraftId,
        sessionId: created.id,
        directoryHint: createdDirectory,
        submittedText: submittedDraftText,
      })

      if (draftTargetFolderId) {
        const scopeKey = draftDirectoryOverride || created.directory || null
        if (scopeKey) {
          useSessionFoldersStore.getState().addSessionToFolder(scopeKey, draftTargetFolderId, created.id)
        }
      }

      const mergedAdditionalParts = draftSyntheticParts?.length
        ? [...(additionalParts || []), ...draftSyntheticParts]
        : additionalParts

      if (createdDirectory) {
        getSyncChildStores().ensureChild(createdDirectory)
      }

      notifyMessageSent(created.id)

      markPendingUserSendAnimation(created.id)

      const files = submittedAttachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

      try {
        await routeMessage({
          sessionId: created.id,
          content: submittedDraftText,
          providerID: effectiveProviderID,
          modelID: effectiveModelID,
          agent: effectiveDraftAgent,
          agentMentionName,
          variant: effectiveVariant,
          inputMode,
          directory: createdDirectory,
          files,
          planMode: resolvedPlanMode,
          additionalParts: mergedAdditionalParts?.map((p) => ({
            text: p.text,
            synthetic: p.synthetic,
            files: p.attachments?.map((a: AttachedFile) => ({
              type: "file" as const,
              mime: a.mimeType,
              url: a.dataUrl,
              filename: a.filename,
            })),
          })),
          lifecycleCallbacks: {
            signal: promotedAbortController.signal,
            onSessionReady: (sessionID, directory) => {
              void sessionID
              void directory
            },
          },
        })
      } finally {
        get().clearPendingSendAbort(created.id, promotedAbortController)
      }
      return
      } finally {
        get().clearPendingSendAbort(pendingAbortKey, draftAbortController)
      }
    }

    // ---- Existing session, or defensive fallback when the UI has no active draft/session ----
    let targetSessionId = get().currentSessionId
    const resolvedPlanMode = planMode ?? useSelectionStore.getState().getPlanModeSelection(targetSessionId)
    const existingSelection = targetSessionId
      ? resolveSessionSendConfig(targetSessionId, {
          providerID,
          modelID,
          agent: trimmedAgent,
          variant,
          planMode: resolvedPlanMode,
        })
      : { providerID, modelID, agent: trimmedAgent, variant, planMode: resolvedPlanMode }
    const effectiveProviderID = existingSelection.providerID ?? providerID
    const effectiveModelID = existingSelection.modelID ?? modelID
    const effectiveAgent = existingSelection.agent
    const effectiveVariant = existingSelection.variant

    if (!effectiveProviderID || !effectiveModelID) {
      throw new Error("Cannot send message: provider or model not selected")
    }

    let targetSessionDirectory = targetSessionId
      ? normalizePath(get().getDirectoryForSession(targetSessionId))
      : null

    if (!targetSessionId) {
      const fallbackDirectory = normalizePath(opencodeClient.getDirectory())
      const created = await createSessionRecordAction(undefined, fallbackDirectory, null)
      if (!created?.id) {
        const createError = consumeLastCreateSessionError()
        if (createError instanceof Error) {
          throw createError
        }
        throw new Error("Failed to create session")
      }

      targetSessionId = created.id
      targetSessionDirectory = normalizePath((created as { directory?: string }).directory ?? fallbackDirectory)
      if (effectiveAgent?.trim().toLowerCase() === "builder") {
        useSelectionStore.getState().markBuilderHandoffCleared(created.id)
      }
      get().setCurrentSession(created.id, targetSessionDirectory)
      get().initializeNewOpenChamberSession(created.id, useConfigStore.getState().agents ?? [])
      if (targetSessionDirectory) {
        getSyncChildStores().ensureChild(targetSessionDirectory)
      }
      if (resolvedPlanMode) {
        useSelectionStore.getState().setSessionPlanMode(created.id, true)
      }
      streamDebugMark("first-reply-session-created", {
        sessionId: created.id,
        directory: targetSessionDirectory,
      })
    }

    if (effectiveProviderID && effectiveModelID) {
      useSelectionStore.getState().saveSessionModelSelection(targetSessionId, effectiveProviderID, effectiveModelID)
    }

    if (effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(targetSessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelVariantForSession(targetSessionId, effectiveAgent, effectiveProviderID, effectiveModelID, effectiveVariant)
    }

    const viewportState = useViewportStore.getState()
    const memState = viewportState.sessionMemoryState.get(targetSessionId)
    if (!memState || !memState.lastUserMessageAt) {
      const newMemState = new Map(viewportState.sessionMemoryState)
      newMemState.set(targetSessionId, {
        viewportAnchor: 0,
        isStreaming: false,
        lastAccessedAt: Date.now(),
        backgroundMessageCount: 0,
        ...memState,
        lastUserMessageAt: Date.now(),
      })
      useViewportStore.setState({ sessionMemoryState: newMemState })
    }

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
    }))

    if (await queuePromptAfterPendingQuestions({
      sessionId: targetSessionId,
      content,
      providerID: effectiveProviderID,
      modelID: effectiveModelID,
      agent: effectiveAgent,
      attachments,
      variant: effectiveVariant,
      planMode: resolvedPlanMode,
      directory: targetSessionDirectory,
      inputMode,
    })) {
      return
    }

    notifyMessageSent(targetSessionId)
    markPendingUserSendAnimation(targetSessionId)

    const starterContext = consumeStarterAssistantContext(get, set, targetSessionId)
    const sendAdditionalParts = withStarterAssistantContext(additionalParts, starterContext)

    try {
      const contextConsumed = await routeMessage({
        sessionId: targetSessionId,
        content,
        providerID: effectiveProviderID,
        modelID: effectiveModelID,
        agent: effectiveAgent,
        agentMentionName,
        variant: effectiveVariant,
        inputMode,
        directory: targetSessionDirectory,
        files,
        planMode: resolvedPlanMode,
        additionalParts: sendAdditionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          files: p.attachments?.map((a) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
          })),
        })),
      })
      if (!contextConsumed) {
        restoreStarterAssistantContext(set, starterContext)
      }
    } catch (error) {
      restoreStarterAssistantContext(set, starterContext)
      throw error
    }
  },

  sendMessageToSession: async (
    sessionId,
    content,
    providerID,
    modelID,
    agent,
    attachments,
    agentMentionName,
    additionalParts,
    variant,
    inputMode,
    planMode,
    lifecycleCallbacks,
  ) => {
    streamDebugMark("first-reply-send-start", {
      sessionId,
      inputMode: inputMode ?? "normal",
    })
    const map = new Map(get().pendingChangesBarDismissed)
    map.delete(sessionId)
    set({ pendingChangesBarDismissed: map })
    get().clearSessionTurnCompletion(sessionId)

    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
    const sendSelection = resolveSessionSendConfig(sessionId, {
      providerID,
      modelID,
      agent: trimmedAgent,
      variant,
      planMode,
    })
    const effectiveProviderID = sendSelection.providerID ?? providerID
    const effectiveModelID = sendSelection.modelID ?? modelID
    const effectiveAgent = sendSelection.agent
    const effectiveVariant = sendSelection.variant

    if (effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(sessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, effectiveAgent, effectiveProviderID, effectiveModelID, effectiveVariant)
    }

    const viewportState = useViewportStore.getState()
    const memState = viewportState.sessionMemoryState.get(sessionId)
    if (!memState || !memState.lastUserMessageAt) {
      const newMemState = new Map(viewportState.sessionMemoryState)
      newMemState.set(sessionId, {
        viewportAnchor: 0,
        isStreaming: false,
        lastAccessedAt: Date.now(),
        backgroundMessageCount: 0,
        ...memState,
        lastUserMessageAt: Date.now(),
      })
      useViewportStore.setState({ sessionMemoryState: newMemState })
    }

    const sessionDirectory = normalizePath(
      lifecycleCallbacks?.directory ?? get().getDirectoryForSession(sessionId),
    )

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
    }))

    if (await queuePromptAfterPendingQuestions({
      sessionId,
      content,
      providerID: effectiveProviderID,
      modelID: effectiveModelID,
      agent: effectiveAgent,
      attachments,
      variant: effectiveVariant,
      planMode: sendSelection.planMode ?? useSelectionStore.getState().getPlanModeSelection(sessionId),
      directory: sessionDirectory,
      inputMode,
    })) {
      return
    }

    notifyMessageSent(sessionId)
    markPendingUserSendAnimation(sessionId)

    const starterContext = consumeStarterAssistantContext(get, set, sessionId)
    const sendAdditionalParts = withStarterAssistantContext(additionalParts, starterContext)

    try {
      const contextConsumed = await routeMessage({
        sessionId,
        content,
        providerID: effectiveProviderID,
        modelID: effectiveModelID,
        agent: effectiveAgent,
        agentMentionName,
        variant: effectiveVariant,
        inputMode,
        directory: sessionDirectory,
        files,
        planMode: sendSelection.planMode ?? useSelectionStore.getState().getPlanModeSelection(sessionId),
        additionalParts: sendAdditionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          files: p.attachments?.map((a) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
          })),
        })),
        lifecycleCallbacks,
      })
      if (!contextConsumed) {
        restoreStarterAssistantContext(set, starterContext)
      }
    } catch (error) {
      restoreStarterAssistantContext(set, starterContext)
      throw error
    }
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: async (title, directoryOverride, parentID) => {
    try {
      const dir = directoryOverride ?? opencodeClient.getDirectory()
      const session = await createSessionAction(title, dir, parentID ?? null)
      if (!session) return null

      return session
    } catch (e) {
      console.error("[session-ui-store] createSession failed", e)
      return null
    }
  },

  // ---------------------------------------------------------------------------
  // deleteSession — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  deleteSession: (id) => deleteSessionAction(id),

  deleteSessions: (ids) => deleteSessionsAction(ids),

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: (ids) => archiveSessionsAction(ids),

  unarchiveSession: (id) => unarchiveSessionAction(id),

  unarchiveSessions: (ids) => unarchiveSessionsAction(ids),

  // ---------------------------------------------------------------------------
  // updateSessionTitle — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  updateSessionTitle: async (sessionId, title) => {
    await updateSessionTitleAction(sessionId, title)
  },

  shareSession: async (sessionId) => {
    return shareSessionAction(sessionId)
  },

  unshareSession: async (sessionId) => {
    return unshareSessionAction(sessionId)
  },

  // ---------------------------------------------------------------------------
  // revertToMessage — delegates to session-actions (single implementation)
  // ---------------------------------------------------------------------------
  revertToMessage: async (sessionId, messageId) => {
    const { revertToMessage: revert } = await import("./session-actions")
    await revert(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // handleSlashUndo — reads from sync
  // ---------------------------------------------------------------------------
  handleSlashUndo: async (sessionId) => {
    assertSessionRevertMutationAllowed(
      sessionId,
      getSyncSessionDirectoryAnyDirectory(sessionId) ?? opencodeClient.getDirectory(),
      "undo",
    )
    const messages = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return

    const revertToId = currentSession?.revert?.messageID
    let targetMessage: typeof messages[number] | undefined
    if (revertToId) {
      targetMessage = [...userMessages].reverse().find((m) => m.id < revertToId)
    } else {
      targetMessage = userMessages[userMessages.length - 1]
    }

    if (!targetMessage) return

    const targetParts = getSyncParts(targetMessage.id)
    const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
    const preview = textPart?.text
      ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
      : "[No text]"

    await get().revertToMessage(sessionId, targetMessage.id)

    const { toast } = await import("sonner")
    toast.success(`Undid to: ${preview}`)
  },

  // ---------------------------------------------------------------------------
  // handleSlashRedo — reads from sync
  // ---------------------------------------------------------------------------
  handleSlashRedo: async (sessionId) => {
    assertSessionRevertMutationAllowed(
      sessionId,
      getSyncSessionDirectoryAnyDirectory(sessionId) ?? opencodeClient.getDirectory(),
      "redo",
    )
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    await refetchSessionMessages(sessionId)

    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const targetMessage = userMessages.find((m) => m.id > revertToId)

    if (targetMessage) {
      const targetParts = getSyncParts(targetMessage.id)
      const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
      const preview = textPart?.text
        ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
        : "[No text]"

      await get().revertToMessage(sessionId, targetMessage.id)

      const { toast } = await import("sonner")
      toast.success(`Redid to: ${preview}`)
    } else {
      // Full unrevert
      const { unrevertSession } = await import("./session-actions")
      await unrevertSession(sessionId)

      const { toast } = await import("sonner")
      toast.success("Restored all messages")
    }
  },

  // ---------------------------------------------------------------------------
  // forkFromMessage — delegates to session-actions (handles text + sidebar)
  // ---------------------------------------------------------------------------
  forkFromMessage: async (sessionId, messageId) => {
    const sessions = getSyncSessions()
    const existingSession = sessions.find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      const { forkFromMessage: fork } = await import("./session-actions")
      await fork(sessionId, messageId)

      const { toast } = await import("sonner")
      toast.success(`Forked from ${existingSession.title}`)
    } catch (error) {
      console.error("Failed to fork session:", error)
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    }
  },

  // ---------------------------------------------------------------------------
  // createSessionFromAssistantMessage — reads from sync
  // ---------------------------------------------------------------------------
  createSessionFromAssistantMessage: async (sourceMessageId) => {
    if (!sourceMessageId) return

    // Find which session this message belongs to by scanning sync state
    const state = getDirectoryState()
    if (!state) return

    let sourceSessionId: string | undefined
    let sourceMessage: Message | undefined

    for (const [sid, msgs] of Object.entries(state.message ?? {})) {
      const found = msgs.find((m) => m.id === sourceMessageId)
      if (found) {
        sourceSessionId = sid
        sourceMessage = found
        break
      }
    }

    if (!sourceMessage || sourceMessage.role !== "assistant") return

    const sourceParts = getSyncParts(sourceMessageId)
    const assistantPlanText = flattenAssistantTextParts(sourceParts)
    if (!assistantPlanText.trim()) return

    const directory = resolveSessionDirectory(
      sourceSessionId ?? null,
      (sid) => get().worktreeMetadata.get(sid),
    )

    const session = await get().createSession(undefined, directory ?? null, null)
    if (!session) return

    const createdAt = Date.now()
    const starter: StarterAssistantMessage = {
      sessionId: session.id,
      sourceMessageId,
      messageId: createLocalStarterId("msg"),
      partId: createLocalStarterId("prt"),
      text: assistantPlanText,
      createdAt,
      pendingContext: true,
    }

    set((state) => {
      const starterAssistantMessages = new Map(state.starterAssistantMessages)
      starterAssistantMessages.set(session.id, starter)
      return { starterAssistantMessages }
    })

    // Decision: OpenCode has no assistant-message seed API. Keep this starter
    // response client-side and send it once later as synthetic context with the
    // user's first real prompt instead of submitting it as a user message now.
    injectStarterAssistantMessage({
      sessionId: session.id,
      directory: directory ?? (session as { directory?: string | null }).directory ?? null,
      sourceMessage,
      messageId: starter.messageId,
      partId: starter.partId,
      text: assistantPlanText,
      createdAt,
    })

    get().setCurrentSession(session.id, directory ?? (session as { directory?: string | null }).directory ?? null)
  },

  // ---------------------------------------------------------------------------
  // Data access helpers — read from sync
  // ---------------------------------------------------------------------------
  getSessionsByDirectory: (directory) => {
    const nd = normalizePath(directory)
    if (!nd) return []
    const sessions = getAllSyncSessions()
    return sessions.filter((s) => resolveDirectoryKey(s) === nd && isUserVisibleSessionRecord(s))
  },

  getDirectoryForSession: (sessionId) => {
    const attachmentDirectory = getAttachedSessionDirectory(getAttachmentForSession(sessionId))
    if (attachmentDirectory) return attachmentDirectory
    const liveDirectory = normalizePath(getSyncSessionDirectoryAnyDirectory(sessionId))
    if (liveDirectory) return liveDirectory
    const sessions = getAllSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    const sessionDirectory = session ? resolveDirectoryKey(session) : null
    if (sessionDirectory) return sessionDirectory
    return get().sessionDirectoryHints.get(sessionId) ?? null
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as Message & {
        model?: { providerID?: string; modelID?: string; variant?: string }
        variant?: string
        mode?: string
      }
      if (message.role !== "user") {
        continue
      }

      const providerID = typeof message.model?.providerID === "string" && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined
      const modelID = typeof message.model?.modelID === "string" && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined
      const agent = typeof message.agent === "string" && message.agent.trim().length > 0
        ? message.agent
        : (typeof message.mode === "string" && message.mode.trim().length > 0 ? message.mode : undefined)
      const variantCandidate = message.model?.variant ?? message.variant
      const variant = typeof variantCandidate === "string" && variantCandidate.trim().length > 0
        ? variantCandidate
        : undefined

      return { agent, providerID, modelID, variant }
    }
    return null
  },

  getCurrentAgent: (sessionId) => {
    return useSelectionStore.getState().sessionAgentSelections.get(sessionId) ?? undefined
  },

  debugSessionMessages: async (sessionId) => {
    const msgs = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    console.log(`Debug session ${sessionId}:`, {
      session,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        tokens: m.role === "assistant" ? m.tokens : undefined,
      })),
    })
  },

  pollForTokenUpdates: () => {
    // Handled by sync system's SSE stream
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    set((state) => {
      const next = new Map(state.sessionDirectoryHints)
      if (normalized) {
        next.set(sessionId, normalized)
      } else {
        next.delete(sessionId)
      }
      return { sessionDirectoryHints: next }
    })
  },

  // ---------------------------------------------------------------------------
  // Plan mode availability tracking
  // ---------------------------------------------------------------------------
  recordUserMessagePlanMode: (sessionId, messageId, enabled) => {
    set((state) => {
      const hasExisting = state.planModeUserMessages.has(messageId)
      const currentSessionMessageId = state.planModeUserMessagesBySession.get(sessionId)
      if (enabled === hasExisting && (!enabled || currentSessionMessageId === messageId)) return state

      const next = new Set(state.planModeUserMessages)
      const nextBySession = new Map(state.planModeUserMessagesBySession)
      if (enabled) next.add(messageId)
      else next.delete(messageId)
      if (enabled) {
        // Decision: keep only the latest plan-mode user message per session.
        // The sidebar indicator is session-scoped, and older pending entries
        // should not revive a completed/implemented plan after a newer turn.
        nextBySession.delete(sessionId)
        nextBySession.set(sessionId, messageId)
      } else if (currentSessionMessageId === messageId) {
        nextBySession.delete(sessionId)
      }
      persistPlanMessageState(
        next,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        nextBySession,
        state.sessionPlanIndicator,
      )
      return { planModeUserMessages: next, planModeUserMessagesBySession: nextBySession }
    })
  },

  isUserMessagePlanMode: (messageId) => {
    return get().planModeUserMessages.has(messageId)
  },

  isPlanSourceImplemented: (sessionId, sourceMessageId) => {
    const prefix = `${sessionId}:${sourceMessageId}:plan:`
    const legacyPrefix = `${sessionId}:${sourceMessageId}-plan-`
    const state = get()
    for (const requests of [state.implementedPlanRequests, state.externallyHandedOffPlanRequests]) {
      for (const key of requests) {
        if (key.startsWith(prefix) || key.startsWith(legacyPrefix)) return true
      }
    }
    return false
  },

  markSessionPlanAvailable: (sessionId) => {
    get().markPlanProposed(sessionId)
  },

  isSessionPlanAvailable: (sessionId) => {
    return get().sessionPlanAvailable.get(sessionId) ?? get().sessionPlanIndicator.has(sessionId)
  },

  markPlanProposed: (sessionId, sourceMessageId) => {
    clearPendingCompletionTimers(sessionId)
    set((state) => {
      const current = state.sessionPlanIndicator.get(sessionId)
      const nextEntry = nextPlanIndicatorEntry(current, "proposed", sourceMessageId)
      const hasCompletion = state.sessionCompletionIndicator.has(sessionId)
      if (nextEntry === current && state.sessionPlanAvailable.get(sessionId) === true && !hasCompletion) return state

      const nextIndicator = new Map(state.sessionPlanIndicator)
      if (nextEntry) nextIndicator.set(sessionId, nextEntry)
      const nextAvailable = new Map(state.sessionPlanAvailable)
      nextAvailable.set(sessionId, true)
      const nextCompletion = hasCompletion ? new Map(state.sessionCompletionIndicator) : state.sessionCompletionIndicator
      if (hasCompletion) nextCompletion.delete(sessionId)
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        state.planModeUserMessagesBySession,
        nextIndicator,
      )
      return {
        sessionPlanIndicator: nextIndicator,
        sessionPlanAvailable: nextAvailable,
        ...(hasCompletion ? { sessionCompletionIndicator: nextCompletion } : {}),
      }
    })
  },

  markPlanImplementing: (sessionId, sourceMessageId, implementationMessageId) => {
    clearPendingCompletionTimers(sessionId)
    set((state) => {
      const current = state.sessionPlanIndicator.get(sessionId)
      const nextEntry = nextPlanIndicatorEntry(current, "implementing", sourceMessageId, implementationMessageId)
      const nextBySession = new Map(state.planModeUserMessagesBySession)
      const removedPendingPlanMessage = nextBySession.delete(sessionId)
      const hasCompletion = state.sessionCompletionIndicator.has(sessionId)
      if (nextEntry === current && state.sessionPlanAvailable.get(sessionId) === true && !removedPendingPlanMessage && !hasCompletion) return state

      const nextIndicator = new Map(state.sessionPlanIndicator)
      if (nextEntry) nextIndicator.set(sessionId, nextEntry)
      const nextAvailable = new Map(state.sessionPlanAvailable)
      nextAvailable.set(sessionId, true)
      const nextCompletion = hasCompletion ? new Map(state.sessionCompletionIndicator) : state.sessionCompletionIndicator
      if (hasCompletion) nextCompletion.delete(sessionId)
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        nextBySession,
        nextIndicator,
      )
      return {
        sessionPlanIndicator: nextIndicator,
        sessionPlanAvailable: nextAvailable,
        planModeUserMessagesBySession: nextBySession,
        ...(hasCompletion ? { sessionCompletionIndicator: nextCompletion } : {}),
      }
    })
  },

  markPlanCompleted: (sessionId, sourceMessageId) => {
    clearPendingSessionCompletionTimer(sessionId)
    set((state) => {
      const current = state.sessionPlanIndicator.get(sessionId)
      const nextEntry = nextPlanIndicatorEntry(current, "completed", sourceMessageId)
      const nextBySession = new Map(state.planModeUserMessagesBySession)
      const removedPendingPlanMessage = nextBySession.delete(sessionId)
      if (nextEntry === current && state.sessionPlanAvailable.get(sessionId) === true && !removedPendingPlanMessage) return state

      if (nextEntry && nextEntry !== current) {
        schedulePlanCompletionIndicator(sessionId, nextEntry)
      }
      const nextAvailable = new Map(state.sessionPlanAvailable)
      nextAvailable.set(sessionId, true)
      const persistedIndicator = new Map(state.sessionPlanIndicator)
      persistedIndicator.delete(sessionId)
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        nextBySession,
        persistedIndicator,
      )
      return { sessionPlanAvailable: nextAvailable, planModeUserMessagesBySession: nextBySession }
    })
  },

  markPlanImplementationRequested: (planKey) => {
    set((state) => {
      if (state.implementedPlanRequests.has(planKey)) return state
      const next = new Set(state.implementedPlanRequests)
      next.add(planKey)
      persistPlanMessageState(
        state.planModeUserMessages,
        next,
        state.externallyHandedOffPlanRequests,
        state.planModeUserMessagesBySession,
        state.sessionPlanIndicator,
      )
      return { implementedPlanRequests: next }
    })
  },

  markPlanImplementationHandedOff: (planKey) => {
    set((state) => {
      if (state.externallyHandedOffPlanRequests.has(planKey)) return state
      const next = new Set(state.externallyHandedOffPlanRequests)
      next.add(planKey)
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        next,
        state.planModeUserMessagesBySession,
        state.sessionPlanIndicator,
      )
      return { externallyHandedOffPlanRequests: next }
    })
  },

  clearHandedOffPlanIndicator: (sessionId, sourceMessageId) => {
    const id = sessionId.trim()
    const sourceId = sourceMessageId.trim()
    if (!id || !sourceId) return

    set((state) => {
      const current = state.sessionPlanIndicator.get(id)
      const pendingPlanMessageId = state.planModeUserMessagesBySession.get(id)
      const isMatchingHandoff = current
        && (current.state === "proposed" || current.state === "implementing")
        && current.sourceMessageId === sourceId
      const hasNewerPendingPlan = pendingPlanMessageId !== undefined && pendingPlanMessageId > sourceId
      if (!isMatchingHandoff || hasNewerPendingPlan) return state

      const sessionPlanIndicator = new Map(state.sessionPlanIndicator)
      sessionPlanIndicator.delete(id)
      if (!pendingPlanMessageId) {
        persistPlanMessageState(
          state.planModeUserMessages,
          state.implementedPlanRequests,
          state.externallyHandedOffPlanRequests,
          state.planModeUserMessagesBySession,
          sessionPlanIndicator,
        )
        return { sessionPlanIndicator }
      }

      const planModeUserMessagesBySession = new Map(state.planModeUserMessagesBySession)
      planModeUserMessagesBySession.delete(id)
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        planModeUserMessagesBySession,
        sessionPlanIndicator,
      )
      return { sessionPlanIndicator, planModeUserMessagesBySession }
    })
  },

  retirePlanProposal: (sessionId, sourceMessageId) => {
    const id = sessionId.trim()
    const sourceId = sourceMessageId.trim()
    if (!id || !sourceId) return

    set((state) => {
      const current = state.sessionPlanIndicator.get(id)
      if (current?.state !== "proposed" || current.sourceMessageId !== sourceId) return state

      const sessionPlanIndicator = new Map(state.sessionPlanIndicator)
      sessionPlanIndicator.delete(id)
      const pendingPlanMessageId = state.planModeUserMessagesBySession.get(id)
      const planModeUserMessagesBySession = new Map(state.planModeUserMessagesBySession)
      if (!pendingPlanMessageId || pendingPlanMessageId <= sourceId) {
        planModeUserMessagesBySession.delete(id)
      }
      persistPlanMessageState(
        state.planModeUserMessages,
        state.implementedPlanRequests,
        state.externallyHandedOffPlanRequests,
        planModeUserMessagesBySession,
        sessionPlanIndicator,
      )
      return { sessionPlanIndicator, planModeUserMessagesBySession }
    })
  },

  markSessionTurnCompleted: (sessionId, messageId, completedAt) => {
    const nextCompletedAt = typeof completedAt === "number" && completedAt > 0 ? completedAt : Date.now()
    const current = get().sessionCompletionIndicator.get(sessionId)
    if (current?.messageId === messageId && current.completedAt === nextCompletedAt) return

    scheduleSessionCompletionIndicator(sessionId, { messageId, completedAt: nextCompletedAt })
  },

  clearSessionTurnCompletion: (sessionId) => {
    clearPendingCompletionTimers(sessionId)
    set((state) => {
      let nextCompletion: Map<string, SessionCompletionIndicatorEntry> | null = null
      let nextPlanIndicator: Map<string, PlanIndicatorEntry> | null = null

      if (state.sessionCompletionIndicator.has(sessionId)) {
        nextCompletion = new Map(state.sessionCompletionIndicator)
        nextCompletion.delete(sessionId)
      }

      const planEntry = state.sessionPlanIndicator.get(sessionId)
      if (planEntry?.state === "completed") {
        nextPlanIndicator = new Map(state.sessionPlanIndicator)
        nextPlanIndicator.delete(sessionId)
      }

      if (!nextCompletion && !nextPlanIndicator) return state

      return {
        ...(nextCompletion ? { sessionCompletionIndicator: nextCompletion } : {}),
        ...(nextPlanIndicator ? { sessionPlanIndicator: nextPlanIndicator } : {}),
      }
    })
  },

  retireDeletedSession: (sessionId) => {
    const id = sessionId.trim()
    if (!id) return

    clearPendingCompletionTimers(id)
    get().abortControllers.get(id)?.abort()
    removePersistedCursorDraftPrewarmSession(id)

    const worktreeStore = useSessionWorktreeStore.getState()
    if (worktreeStore.attachments.has(id)) {
      worktreeStore.clearAttachment(id)
    }
    useSessionPlanFileStore.getState().clearSession(id)

    set((state) => {
      const worktreeMetadata = deleteMapKey(state.worktreeMetadata, id)
      const sessionDirectoryHints = deleteMapKey(state.sessionDirectoryHints, id)
      const webUICreatedSessions = deleteSetValue(state.webUICreatedSessions, id)
      const sessionAbortFlags = deleteMapKey(state.sessionAbortFlags, id)
      const abortControllers = deleteMapKey(state.abortControllers, id)
      const sessionPlanAvailable = deleteMapKey(state.sessionPlanAvailable, id)
      const sessionPlanIndicator = deleteMapKey(state.sessionPlanIndicator, id)
      const sessionCompletionIndicator = deleteMapKey(state.sessionCompletionIndicator, id)
      const ownedPlanMessageId = state.planModeUserMessagesBySession.get(id)
      const planModeUserMessages = deleteSetValue(state.planModeUserMessages, ownedPlanMessageId)
      const planModeUserMessagesBySession = deleteMapKey(state.planModeUserMessagesBySession, id)
      const implementedPlanRequests = deleteSetMatches(
        state.implementedPlanRequests,
        (planKey) => planKey.startsWith(`${id}:`),
      )
      const externallyHandedOffPlanRequests = deleteSetMatches(
        state.externallyHandedOffPlanRequests,
        (planKey) => planKey.startsWith(`${id}:`),
      )
      const starterAssistantMessages = deleteMapKey(state.starterAssistantMessages, id)
      const pendingChangesBarDismissed = deleteMapKey(state.pendingChangesBarDismissed, id)
      const clearsAbortPrompt = state.abortPromptSessionId === id
      const planStateChanged = (
        planModeUserMessages !== state.planModeUserMessages
        || planModeUserMessagesBySession !== state.planModeUserMessagesBySession
        || implementedPlanRequests !== state.implementedPlanRequests
        || externallyHandedOffPlanRequests !== state.externallyHandedOffPlanRequests
        || sessionPlanIndicator !== state.sessionPlanIndicator
      )

      if (planStateChanged) {
        persistPlanMessageState(
          planModeUserMessages,
          implementedPlanRequests,
          externallyHandedOffPlanRequests,
          planModeUserMessagesBySession,
          sessionPlanIndicator,
        )
      }

      const changed = (
        worktreeMetadata !== state.worktreeMetadata
        || sessionDirectoryHints !== state.sessionDirectoryHints
        || webUICreatedSessions !== state.webUICreatedSessions
        || sessionAbortFlags !== state.sessionAbortFlags
        || abortControllers !== state.abortControllers
        || sessionPlanAvailable !== state.sessionPlanAvailable
        || sessionPlanIndicator !== state.sessionPlanIndicator
        || sessionCompletionIndicator !== state.sessionCompletionIndicator
        || planStateChanged
        || starterAssistantMessages !== state.starterAssistantMessages
        || pendingChangesBarDismissed !== state.pendingChangesBarDismissed
        || clearsAbortPrompt
      )
      if (!changed) return state

      return {
        ...(worktreeMetadata !== state.worktreeMetadata ? { worktreeMetadata } : {}),
        ...(sessionDirectoryHints !== state.sessionDirectoryHints ? { sessionDirectoryHints } : {}),
        ...(webUICreatedSessions !== state.webUICreatedSessions ? { webUICreatedSessions } : {}),
        ...(sessionAbortFlags !== state.sessionAbortFlags ? { sessionAbortFlags } : {}),
        ...(abortControllers !== state.abortControllers ? { abortControllers } : {}),
        ...(sessionPlanAvailable !== state.sessionPlanAvailable ? { sessionPlanAvailable } : {}),
        ...(sessionPlanIndicator !== state.sessionPlanIndicator ? { sessionPlanIndicator } : {}),
        ...(sessionCompletionIndicator !== state.sessionCompletionIndicator ? { sessionCompletionIndicator } : {}),
        ...(planModeUserMessages !== state.planModeUserMessages ? { planModeUserMessages } : {}),
        ...(planModeUserMessagesBySession !== state.planModeUserMessagesBySession ? { planModeUserMessagesBySession } : {}),
        ...(implementedPlanRequests !== state.implementedPlanRequests ? { implementedPlanRequests } : {}),
        ...(externallyHandedOffPlanRequests !== state.externallyHandedOffPlanRequests ? { externallyHandedOffPlanRequests } : {}),
        ...(starterAssistantMessages !== state.starterAssistantMessages ? { starterAssistantMessages } : {}),
        ...(pendingChangesBarDismissed !== state.pendingChangesBarDismissed ? { pendingChangesBarDismissed } : {}),
        ...(clearsAbortPrompt ? { abortPromptSessionId: null, abortPromptExpiresAt: null } : {}),
      }
    })
  },

  clearViewedPlanCompletion: (sessionId) => {
    clearPendingPlanCompletionTimer(sessionId)
    set((state) => {
      const planEntry = state.sessionPlanIndicator.get(sessionId)
      if (!planEntry || planEntry.state === "proposed") return state

      const nextPlanIndicator = new Map(state.sessionPlanIndicator)
      nextPlanIndicator.delete(sessionId)
      return { sessionPlanIndicator: nextPlanIndicator }
    })
  },

  clearReadCompletionIndicators: (sessionIds) => {
    set((state) => {
      const ids = Array.from(new Set(sessionIds.filter(Boolean)))
      if (ids.length === 0) return state

      let nextCompletion: Map<string, SessionCompletionIndicatorEntry> | null = null
      let nextPlanIndicator: Map<string, PlanIndicatorEntry> | null = null

      for (const sessionId of ids) {
        clearPendingSessionCompletionTimer(sessionId)
        clearPendingPlanCompletionTimer(sessionId)

        if (state.sessionCompletionIndicator.has(sessionId)) {
          nextCompletion ??= new Map(state.sessionCompletionIndicator)
          nextCompletion.delete(sessionId)
        }

        const planEntry = state.sessionPlanIndicator.get(sessionId)
        if (planEntry?.state === "completed") {
          nextPlanIndicator ??= new Map(state.sessionPlanIndicator)
          nextPlanIndicator.delete(sessionId)
        }
      }

      if (!nextCompletion && !nextPlanIndicator) return state

      return {
        ...(nextCompletion ? { sessionCompletionIndicator: nextCompletion } : {}),
        ...(nextPlanIndicator ? { sessionPlanIndicator: nextPlanIndicator } : {}),
      }
    })
  },

  rollbackPlanImplementation: (sessionId, sourceMessageId, implementationKey, implementationMessageId) => {
    clearPendingPlanCompletionTimer(sessionId)
    set((state) => {
      const current = state.sessionPlanIndicator.get(sessionId)
      const nextRequests = new Set(state.implementedPlanRequests)
      const removedRequest = nextRequests.delete(implementationKey)
      const shouldRestoreProposed = (
        !current
        || (
          current.state === "implementing"
          && (!sourceMessageId || current.sourceMessageId === sourceMessageId)
          && (!implementationMessageId || !current.implementationMessageId || current.implementationMessageId === implementationMessageId)
        )
      )

      if (!removedRequest && !shouldRestoreProposed) return state

      const nextIndicator = new Map(state.sessionPlanIndicator)
      if (shouldRestoreProposed) {
        nextIndicator.set(sessionId, { state: "proposed", sourceMessageId })
      }
      const nextAvailable = new Map(state.sessionPlanAvailable)
      nextAvailable.set(sessionId, true)
      persistPlanMessageState(
        state.planModeUserMessages,
        nextRequests,
        state.externallyHandedOffPlanRequests,
        state.planModeUserMessagesBySession,
        nextIndicator,
      )
      return {
        implementedPlanRequests: nextRequests,
        sessionPlanIndicator: nextIndicator,
        sessionPlanAvailable: nextAvailable,
      }
    })
  },
}))

setSessionUIStoreRef(useSessionUIStore)
