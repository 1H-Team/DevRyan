import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import {
  getSessionSummaryDiffTotals,
  normalizeChatOwnedDiffSummary,
  parseSessionDiffCount,
  stripUntrustedSessionDiffSummary,
  type SessionSummaryDiffStats,
} from "../lib/sessionDiffStats"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"
import { appendNonOverlappingDelta, appendStreamingTextDelta, normalizeAssistantPartText } from "./part-delta"
import { hasToolCallAssistantFinish, isTerminalAssistantMessage } from "./session-working"
import {
  updateSessionUserActivityFromMessage,
  updateSessionUserActivityFromMessages,
} from "./session-user-activity"
import {
  isCommittedRevertResendInFlight,
  isMessageHiddenByAnyActiveRevert,
  isMessageHiddenByRevert,
  getSessionRevertMessageID,
} from "./revert-transactions"
import { clearAbortGuard, filterSessionStatusThroughAbortGuard } from "./abort-retry-guard"
import { isFinalToolStatus } from "../lib/toolStatus"
import { hasSettledTerminalAssistantTurn } from "./plan-idle-settlement"
import { areSessionRecordsEqual, isStrictlyOlderSession } from "./session-recency"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const DELTA_OVERLAP_FIELDS = ["text", "output"] as const
const CURSOR_PROVIDER_ID = "cursor-acp"

type DedupeMetadata = {
  __dedupeNextDeltaFields?: string[]
}

function advancesCachedUserTurn(messages: readonly Message[], candidate: Message): boolean {
  if (candidate.role !== "user") return false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const previous = messages[index]
    if (previous.role !== "user") continue

    const previousCreatedAt = previous.time?.created
    const candidateCreatedAt = candidate.time?.created
    if (typeof previousCreatedAt === "number" && typeof candidateCreatedAt === "number") {
      return candidateCreatedAt > previousCreatedAt
        || (candidateCreatedAt === previousCreatedAt && candidate.id > previous.id)
    }
    return candidate.id > previous.id
  }

  return false
}

function getUpdatedDeltaFields(previous: Part, next: Part) {
  const dedupeFields: string[] = []
  for (const field of DELTA_OVERLAP_FIELDS) {
    const previousValue = (previous as Record<string, unknown>)[field]
    const nextValue = (next as Record<string, unknown>)[field]
    if (typeof previousValue !== "string" || typeof nextValue !== "string") continue
    if (previousValue.length === 0 || nextValue.length === 0) continue
    if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
      dedupeFields.push(field)
    }
  }
  return dedupeFields
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getToolStatus(part: Part): string | undefined {
  if (part.type !== "tool") {
    return undefined
  }

  const status = (part as { state?: { status?: unknown } }).state?.status
  return typeof status === "string" ? status : undefined
}

function shouldPreserveExistingPart(previous: Part, next: Part): boolean {
  if (previous.type !== "tool" || next.type !== "tool") {
    return false
  }

  const previousStatus = getToolStatus(previous)
  const nextStatus = getToolStatus(next)
  if (previousStatus && isFinalToolStatus(previousStatus) && (!nextStatus || !isFinalToolStatus(nextStatus))) {
    return true
  }

  const previousEnd = getPartEndTime(previous)
  const nextEnd = getPartEndTime(next)
  if (typeof previousEnd === "number" && typeof nextEnd !== "number") {
    return true
  }

  return false
}

// Returning a previous reference avoids re-renders for subscribers whose
// selectors read session_status. We compare by payload-relevant fields and
// switch over the discriminated union so adding a new SessionStatus variant
// forces an explicit decision here at compile time.
function areSessionStatusesEqual(left: SessionStatus | undefined, right: SessionStatus): boolean {
  if (left === right) return true
  if (!left || left.type !== right.type) return false
  switch (right.type) {
    case "idle":
    case "busy":
      return true
    case "retry":
      return left.type === "retry"
        && left.attempt === right.attempt
        && left.message === right.message
        && left.next === right.next
    default: {
      const _exhaustive: never = right
      void _exhaustive
      return false
    }
  }
}

export function isTerminalCursorAssistantMessage(info: Message | undefined): boolean {
  if (!info || info.role !== "assistant") return false
  const providerID = (info as { providerID?: unknown }).providerID
  if (providerID !== CURSOR_PROVIDER_ID) return false

  return isTerminalAssistantMessage(info)
}

const isBlockingRequestPending = (state: State, sessionID: string): boolean => {
  return (state.permission[sessionID]?.length ?? 0) > 0
    || (state.question[sessionID]?.length ?? 0) > 0
}

const getMessageCreatedAt = (message: Message | undefined): number | undefined => {
  const created = (message as { time?: { created?: unknown } } | undefined)?.time?.created
  return typeof created === "number" ? created : undefined
}

const compareMessageOrder = (left: Message, right: Message): number => {
  const leftCreated = getMessageCreatedAt(left)
  const rightCreated = getMessageCreatedAt(right)
  if (typeof leftCreated === "number" && typeof rightCreated === "number" && leftCreated !== rightCreated) {
    return leftCreated - rightCreated
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

const isTrailingConversationalMessage = (state: State, info: Message): boolean => {
  const messages = state.message[info.sessionID] ?? []
  let latest: Message | undefined

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue
    }
    if (!latest || compareMessageOrder(message, latest) > 0) {
      latest = message
    }
  }

  if (!latest) {
    return true
  }
  if (latest.id === info.id) {
    return true
  }
  return compareMessageOrder(latest, info) <= 0
}

export function shouldSettleTerminalAssistantMessageStatus(state: State, info: Message | undefined): info is Message {
  if (!info || !isTerminalAssistantMessage(info)) {
    return false
  }
  // `finish: "tool-calls"` is an intermediate assistant handoff, not the end
  // of the agent turn. Keep busy status intact so live indicators do not flicker
  // off between tool calls while OpenCode is still working.
  if (hasToolCallAssistantFinish(info)) {
    return false
  }
  if (isBlockingRequestPending(state, info.sessionID)) {
    return false
  }
  return isTrailingConversationalMessage(state, info)
}

function settleTerminalAssistantStatus(draft: State, info: Message): boolean {
  if (!shouldSettleTerminalAssistantMessageStatus(draft, info)) {
    return false
  }
  const status = { type: "idle" } as const
  if (areSessionStatusesEqual(draft.session_status[info.sessionID], status)) {
    return false
  }

  draft.session_status[info.sessionID] = status
  return true
}

function areFileDiffsEquivalent(left: FileDiff[] | undefined, right: FileDiff[]): boolean {
  if (left === right) return true
  if (!left || left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftDiff = left[index]
    const rightDiff = right[index]
    if (
      leftDiff.file !== rightDiff.file
      || leftDiff.status !== rightDiff.status
      || parseSessionDiffCount(leftDiff.additions) !== parseSessionDiffCount(rightDiff.additions)
      || parseSessionDiffCount(leftDiff.deletions) !== parseSessionDiffCount(rightDiff.deletions)
    ) {
      return false
    }
  }

  return true
}

function areMessageDiffSummariesEquivalent(left: Message, right: Message): boolean {
  const leftSummary = (left as Message & { summary?: SessionSummaryDiffStats | null }).summary
  const rightSummary = (right as Message & { summary?: SessionSummaryDiffStats | null }).summary
  const leftStats = getSessionSummaryDiffTotals(leftSummary)
  const rightStats = getSessionSummaryDiffTotals(rightSummary)
  return !!leftSummary === !!rightSummary
    && leftStats.additions === rightStats.additions
    && leftStats.deletions === rightStats.deletions
}

function getMessageParentID(message: Message): string | undefined {
  if (!("parentID" in message)) return undefined
  return typeof message.parentID === "string" ? message.parentID : undefined
}

// Memoize normalizeChatOwnedDiffSummary by (messages, session) reference pair.
// The reducer replaces draft.message[sessionID] only on real changes and keeps
// the same Session ref unless it mutates it, so unchanged-state events
// (common during streaming message.updated) hit this cache and skip the O(n)
// user-message scan. Identical inputs always yield the same output reference,
// preserving the downstream areSummaryValuesEqual short-circuit.
const sessionSummaryMemo: WeakMap<readonly Message[], WeakMap<Session, Session>> = new WeakMap()

function memoizedNormalizeChatOwnedDiffSummary(session: Session, messages: readonly Message[]): Session {
  let inner = sessionSummaryMemo.get(messages)
  if (!inner) {
    inner = new WeakMap()
    sessionSummaryMemo.set(messages, inner)
  }
  const cached = inner.get(session)
  if (cached) return cached
  const result = normalizeChatOwnedDiffSummary(
    session as Session & { summary?: SessionSummaryDiffStats | null },
    messages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
  ) as Session
  inner.set(session, result)
  return result
}

function applyMessageSummaryToSession(draft: State, sessionID: string): boolean {
  const messages = draft.message[sessionID]
  if (!messages) return false

  const result = Binary.search(draft.session, sessionID, (session) => session.id)
  if (!result.found) return false

  const session = draft.session[result.index]
  const nextSession = memoizedNormalizeChatOwnedDiffSummary(session, messages)
  if (nextSession === session) {
    return false
  }

  // Message summaries are scoped to their owning session, unlike session.diff
  // payloads which can reflect the shared working tree. Use them only on the
  // non-hot message.updated path to refresh the current session's sidebar stats.
  draft.session = [...draft.session]
  draft.session[result.index] = nextSession
  return true
}

function normalizeIncomingSessionSummary(draft: State, session: Session): Session {
  const revertMessageID = getSessionRevertMessageID(session)
  if (isCommittedRevertResendInFlight(session.id, revertMessageID)) {
    const nextSession = { ...session } as Session & { revert?: unknown }
    delete nextSession.revert
    session = nextSession as Session
  }

  const messages = draft.message[session.id]
  if (messages) {
    return memoizedNormalizeChatOwnedDiffSummary(session, messages)
  }

  return stripUntrustedSessionDiffSummary(
    session as Session & { summary?: SessionSummaryDiffStats | null },
  ) as Session
}

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "project"
  project: Project
} | null

export type DirectoryEventResult = boolean | {
  changed: boolean
  materialization: {
    type: "incomplete-session-snapshot"
    sessionID?: string
    messageID: string
    partID?: string
  }
}

function hasMessage(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  return Binary.search(messages, messageID, (message) => message.id).found
}

function findSessionIdForMessage(draft: State, messageID: string): string | undefined {
  for (const [sessionID, messages] of Object.entries(draft.message)) {
    if (Binary.search(messages, messageID, (message) => message.id).found) {
      return sessionID
    }
  }
  return undefined
}

function findMessage(draft: State, sessionID: string | undefined, messageID: string): Message | undefined {
  if (sessionID) {
    const messages = draft.message[sessionID]
    if (messages) {
      const result = Binary.search(messages, messageID, (message) => message.id)
      if (result.found) {
        return messages[result.index]
      }
    }
  }

  for (const messages of Object.values(draft.message)) {
    const result = Binary.search(messages, messageID, (message) => message.id)
    if (result.found) {
      return messages[result.index]
    }
  }

  return undefined
}

function isAssistantMessage(draft: State, sessionID: string | undefined, messageID: string): boolean {
  return findMessage(draft, sessionID, messageID)?.role === "assistant"
}

function isAssistantMessageActivelyStreaming(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!isAssistantMessage(draft, sessionID, messageID)) {
    return false
  }

  const message = findMessage(draft, sessionID, messageID)
  const completed = (message?.time as { completed?: number } | undefined)?.completed
  if (typeof completed === "number" && Number.isFinite(completed) && completed > 0) {
    return false
  }

  return sessionID !== undefined && draft.session_status?.[sessionID]?.type === "busy"
}

function shouldNormalizeAssistantPartDuringUpdate(
  draft: State,
  sessionID: string | undefined,
  messageID: string,
): boolean {
  return !isAssistantMessageActivelyStreaming(draft, sessionID, messageID)
}

function getPartStartTime(part: Part): number | undefined {
  const stateStart = (part as { state?: { time?: { start?: unknown } } }).state?.time?.start
  if (typeof stateStart === "number") {
    return stateStart
  }

  const timeStart = (part as { time?: { start?: unknown } }).time?.start
  return typeof timeStart === "number" ? timeStart : undefined
}

function shouldCreateProvisionalAssistantMessageForPart(draft: State, part: Part, sessionID: string): boolean {
  if (part.type === "reasoning") {
    return true
  }

  if (part.type !== "text" && part.type !== "tool") {
    return false
  }

  const status = draft.session_status[sessionID]
  return status?.type === "busy" || status?.type === "retry"
}

function insertProvisionalAssistantMessageForLivePart(draft: State, part: Part): boolean {
  const partRecord = part as { messageID?: unknown; sessionID?: unknown }
  const messageID = typeof partRecord.messageID === "string" ? partRecord.messageID : ""
  const sessionID = typeof partRecord.sessionID === "string" ? partRecord.sessionID : ""
  if (!messageID || !sessionID || hasMessage(draft, sessionID, messageID)) {
    return false
  }
  if (!shouldCreateProvisionalAssistantMessageForPart(draft, part, sessionID)) {
    return false
  }

  const created = getPartStartTime(part) ?? Date.now()
  const provisionalMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created },
  } as Message

  const messages = draft.message[sessionID]
  if (!messages) {
    draft.message[sessionID] = [provisionalMessage]
    return true
  }

  const next = [...messages]
  const result = Binary.search(next, messageID, (message) => message.id)
  if (result.found) {
    return false
  }
  next.splice(result.index, 0, provisionalMessage)
  draft.message[sessionID] = next
  return true
}

function normalizeAssistantTextPart(part: Part): Part {
  if (part.type !== "text" && part.type !== "reasoning") {
    return part
  }

  const text = (part as { text?: unknown }).text
  if (typeof text !== "string") {
    return part
  }

  const normalized = normalizeAssistantPartText(text, part.type)
  if (normalized === text) {
    return part
  }

  return { ...part, text: normalized } as Part
}

function normalizeAssistantTextParts(parts: Part[]): Part[] {
  let changed = false
  const normalized = parts.map((part) => {
    const next = normalizeAssistantTextPart(part)
    changed ||= next !== part
    return next
  })
  return changed ? normalized : parts
}

function normalizeAssistantMessagePartsInDraft(draft: State, messageID: string): boolean {
  const parts = draft.part[messageID]
  if (!parts) {
    return false
  }

  const normalized = normalizeAssistantTextParts(parts)
  if (normalized === parts) {
    return false
  }

  draft.part[messageID] = normalized
  return true
}

export function reduceGlobalEvent(event: Event): GlobalEventResult {
  if (event.type === "global.disposed" || event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "project.updated") {
    return { type: "project", project: event.properties as Project }
  }
  return null
}

export function applyGlobalProject(state: GlobalState, project: Project): GlobalState {
  const projects = [...state.projects]
  const result = Binary.search(projects, project.id, (s) => s.id)
  if (result.found) {
    projects[result.index] = { ...projects[result.index], ...project }
  } else {
    projects.splice(result.index, 0, project)
  }
  return { ...state, projects }
}

// ---------------------------------------------------------------------------
// Directory events — mutates draft in place for batching efficiency.
// Caller MUST pass a mutable copy of State (e.g. structuredClone or spread).
// ---------------------------------------------------------------------------

export function applyDirectoryEvent(
  draft: State,
  event: Event,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadLsp?: () => void
    onSetSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
    /**
     * Cheap message → session lookup the caller can provide (e.g. backed by a
     * routing index). The reducer falls back to its own scan only when this is
     * absent or returns undefined. The scan is O(num_sessions) and runs on
     * every streaming delta, so passing a hint keeps the hot path bounded.
     */
    resolveSessionIDForMessage?: (messageID: string) => string | undefined
  },
): DirectoryEventResult {
  switch (event.type) {
    case "server.instance.disposed": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.created": {
      const incoming = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, incoming.id, (s) => s.id)
      if (result.found && isStrictlyOlderSession(incoming, sessions[result.index])) {
        return false
      }
      const info = normalizeIncomingSessionSummary(
        draft,
        incoming,
      )
      if (result.found) {
        if (areSessionRecordsEqual(sessions[result.index], info)) return false
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentID) draft.sessionTotal += 1
      }
      return true
    }

    case "session.updated": {
      const incoming = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, incoming.id, (s) => s.id)
      if (result.found && isStrictlyOlderSession(incoming, sessions[result.index])) {
        return false
      }
      const info = normalizeIncomingSessionSummary(
        draft,
        incoming,
      )

      if (info.time.archived) {
        const hadUserActivity = Object.hasOwn(draft.session_user_activity, info.id)
        const hadRevertTransaction = Object.hasOwn(draft.revert_transaction, info.id)
        if (result.found) sessions.splice(result.index, 1)
        // Decision: archive removes the session from active lists immediately,
        // but heavy chat caches are offloaded by the materializer after the
        // configured TTL so quick archive/unarchive round-trips stay smooth.
        delete draft.session_user_activity[info.id]
        delete draft.revert_transaction[info.id]
        if (result.found && !info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
        return result.found || hadUserActivity || hadRevertTransaction
      }

      if (result.found) {
        if (areSessionRecordsEqual(sessions[result.index], info)) {
          return updateSessionUserActivityFromMessages(draft, info.id)
        }
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
      }
      updateSessionUserActivityFromMessages(draft, info.id)
      return true
    }

    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found) sessions.splice(result.index, 1)
      cleanupSessionCaches(draft, info.id, callbacks?.onSetSessionTodo)
      delete draft.session_user_activity[info.id]
      delete draft.revert_transaction[info.id]
      if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
      return true
    }

    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: FileDiff[] }
      const previousDiff = draft.session_diff[props.sessionID]
      const diffChanged = !areFileDiffsEquivalent(previousDiff, props.diff)
      if (diffChanged) {
        draft.session_diff[props.sessionID] = props.diff
      }
      return diffChanged
    }

    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      draft.todo[props.sessionID] = props.todos
      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)
      return true
    }

    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      // While the user has explicitly stopped this session, OpenCode's retry
      // loop (out of usage / rate limit) keeps emitting `retry` statuses
      // because abort during the backoff sleep is ignored upstream. The guard
      // coerces those to idle for a bounded window and schedules bounded
      // re-aborts so the loop is cancelled when its next attempt fires.
      const filteredStatus = filterSessionStatusThroughAbortGuard(props.sessionID, props.status)
      const filteredStatusType = filteredStatus.type
      const status = (filteredStatusType === "busy" || filteredStatusType === "retry") && hasSettledTerminalAssistantTurn({
        sessionID: props.sessionID,
        state: draft,
      })
        ? { type: "idle" } as const
        : filteredStatus
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.idle": {
      const props = event.properties as { sessionID: string }
      clearAbortGuard(props.sessionID)
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.error": {
      const props = event.properties as { sessionID: string }
      clearAbortGuard(props.sessionID)
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      if (isMessageHiddenByRevert(draft, info.sessionID, info.id)) {
        return removeHiddenMessageFromDraft(draft, info.sessionID, info.id)
      }
      const activityChanged = updateSessionUserActivityFromMessage(draft, info)
      const terminalStatusChanged = settleTerminalAssistantStatus(draft, info)
      const messages = draft.message[info.sessionID]
      if (!messages) {
        draft.message[info.sessionID] = [info]
        if (info.role === "assistant") {
          normalizeAssistantMessagePartsInDraft(draft, info.id)
        }
        applyMessageSummaryToSession(draft, info.sessionID)
        return true
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (!result.found && advancesCachedUserTurn(messages, info)) {
        // A user message that advances the cached user-turn boundary is the
        // authoritative cross-surface edge for new work. Replayed historical
        // messages cannot clear a prior local Stop.
        clearAbortGuard(info.sessionID)
      }
      if (result.found) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[result.index]
        const unchanged = existing.role === info.role
          && (existing as { finish?: unknown }).finish === (info as { finish?: unknown }).finish
          && (existing.time as { completed?: number })?.completed === (info.time as { completed?: number })?.completed
          && getMessageParentID(existing) === getMessageParentID(info)
          && areMessageDiffSummariesEquivalent(existing, info)
        if (unchanged) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, (info as { finish?: unknown }).finish, (info.time as { completed?: number })?.completed)
          const partsChanged = info.role === "assistant"
            ? normalizeAssistantMessagePartsInDraft(draft, info.id)
            : false
          return applyMessageSummaryToSession(draft, info.sessionID) || activityChanged || partsChanged || terminalStatusChanged
        }
        const next = [...messages]
        next[result.index] = info
        draft.message[info.sessionID] = next
      } else {
        const next = [...messages]
        next.splice(result.index, 0, info)
        draft.message[info.sessionID] = next
      }
      if (info.role === "assistant") {
        normalizeAssistantMessagePartsInDraft(draft, info.id)
      }
      applyMessageSummaryToSession(draft, info.sessionID)
      return true
    }

    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      const messages = draft.message[props.sessionID]
      let removedUserMessage = false
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, props.messageID, (m) => m.id)
        if (result.found) {
          removedUserMessage = next[result.index]?.role === "user"
          next.splice(result.index, 1)
          draft.message[props.sessionID] = next
        }
      }
      delete draft.part[props.messageID]
      if (removedUserMessage) {
        updateSessionUserActivityFromMessages(draft, props.sessionID)
      }
      applyMessageSummaryToSession(draft, props.sessionID)
      return true
    }

    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) {
        syncDebug.reducer.partSkipped((part as { messageID: string }).messageID, part.id, part.type)
        return false
      }
      const messageID = (part as { messageID: string }).messageID
      const sessionID = (part as { sessionID?: string }).sessionID
      if (
        isMessageHiddenByRevert(draft, sessionID, messageID)
        || (!sessionID && isMessageHiddenByAnyActiveRevert(draft, messageID))
      ) {
        return false
      }
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const incomingPart = isAssistantMessage(draft, sessionID, messageID)
        && shouldNormalizeAssistantPartDuringUpdate(draft, sessionID, messageID)
        ? normalizeAssistantTextPart(part)
        : part
      if (missingOwningMessage) {
        insertProvisionalAssistantMessageForLivePart(draft, incomingPart)
      }
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, part.type)
        draft.part[messageID] = [incomingPart]
        return missingOwningMessage
          ? {
            changed: true,
            materialization: { type: "incomplete-session-snapshot", sessionID, messageID, partID: part.id },
          }
          : true
      }
      const next = [...parts]
      const result = Binary.search(next, part.id, (p) => p.id)
      if (result.found) {
        const previous = next[result.index]
        if (shouldPreserveExistingPart(previous, incomingPart)) {
          return false
        }
        const dedupeFields = getUpdatedDeltaFields(previous, incomingPart)
        next[result.index] = dedupeFields.length > 0
          ? { ...incomingPart, __dedupeNextDeltaFields: dedupeFields } as unknown as Part
          : incomingPart
      } else {
        // Replace optimistic part (no sessionID) with server part of same type.
        // Gate: only scan if the first part lacks sessionID (optimistic parts are
        // always inserted first). Assistant messages never have optimistic parts,
        // so this check is effectively free during streaming.
        const hasOptimistic = next.length > 0 && !(next[0] as { sessionID?: string }).sessionID
        const optimisticIdx = hasOptimistic && (incomingPart.type === "text" || incomingPart.type === "file")
          ? next.findIndex((p) => p.type === incomingPart.type && !(p as { sessionID?: string }).sessionID)
          : -1
        if (optimisticIdx >= 0) {
          next.splice(optimisticIdx, 1)
        }
        const insertResult = Binary.search(next, incomingPart.id, (p) => p.id)
        next.splice(insertResult.index, 0, incomingPart)
      }
      draft.part[messageID] = next
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", sessionID, messageID, partID: part.id },
        }
        : true
    }

    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = draft.part[props.messageID]
      if (!parts) return false
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        const next = [...parts]
        next.splice(result.index, 1)
        if (next.length === 0) {
          delete draft.part[props.messageID]
        } else {
          draft.part[props.messageID] = next
        }
        return true
      }
      return false
    }

    case "message.part.delta": {
      const props = event.properties as {
        messageID: string
        partID: string
        field: string
        delta: string
      }
      const parts = draft.part[props.messageID]
      const sessionID = callbacks?.resolveSessionIDForMessage?.(props.messageID)
        ?? findSessionIdForMessage(draft, props.messageID)
      if (
        isMessageHiddenByRevert(draft, sessionID, props.messageID)
        || (!sessionID && isMessageHiddenByAnyActiveRevert(draft, props.messageID))
      ) {
        return false
      }
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) {
        syncDebug.reducer.partDeltaNotFound(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      const existing = parts[result.index] as Record<string, unknown>
      const existingValue = existing[props.field] as string | undefined
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(props.field)
      const shouldSanitizeAssistantText = props.field === "text"
        && isAssistantMessage(draft, sessionID, props.messageID)
        && shouldNormalizeAssistantPartDuringUpdate(draft, sessionID, props.messageID)
      // Create new Part object + new array so React detects the change
      const next = [...parts]
      const appendedValue = shouldDedupe
        ? appendNonOverlappingDelta(existingValue, props.delta)
        : DELTA_OVERLAP_FIELDS.includes(props.field as typeof DELTA_OVERLAP_FIELDS[number])
          ? appendStreamingTextDelta(existingValue, props.delta)
          : (existingValue ?? "") + props.delta
      const nextValue = shouldSanitizeAssistantText
        ? normalizeAssistantPartText(appendedValue, typeof existing.type === "string" ? existing.type : undefined)
        : appendedValue

      if (existingValue === nextValue && dedupeFields.length === 0) {
        return false
      }

      next[result.index] = {
        ...existing,
        [props.field]: nextValue,
        __dedupeNextDeltaFields: dedupeFields.filter((field) => field !== props.field),
      } as unknown as Part
      draft.part[props.messageID] = next
      return true
    }

    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (draft.vcs?.branch === props.branch) return false
      draft.vcs = { branch: props.branch }
      return true
    }

    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = draft.permission[permission.sessionID] ?? []
      const next = [...permissions]
      const result = Binary.search(next, permission.id, (p) => p.id)
      if (result.found) {
        next[result.index] = permission
      } else {
        next.splice(result.index, 0, permission)
      }
      draft.permission[permission.sessionID] = next
      return true
    }

    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = draft.permission[props.sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (result.found) {
        const next = [...permissions]
        next.splice(result.index, 1)
        draft.permission[props.sessionID] = next
        return true
      }
      return false
    }

    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = draft.question[question.sessionID] ?? []
      const next = [...questions]
      const result = Binary.search(next, question.id, (q) => q.id)
      if (result.found) {
        next[result.index] = question
      } else {
        next.splice(result.index, 0, question)
      }
      draft.question[question.sessionID] = next
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = draft.question[props.sessionID]
      if (!questions) return false
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (result.found) {
        const next = [...questions]
        next.splice(result.index, 1)
        draft.question[props.sessionID] = next
        return true
      }
      return false
    }

    case "lsp.updated": {
      callbacks?.onLoadLsp?.()
      return false
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSessions(draft: State) {
  if (draft.session.length <= draft.limit) return
  // Keep sessions that have pending permissions, questions, or live activity.
  // Trimming is a soft cap: if the oldest session is protected we stop and
  // leave the limit unenforced rather than evict newer (and unprotected)
  // sessions the user just created. Memory pressure is bounded in practice
  // by the bootstrap-derived limit; protected sessions can only inflate the
  // cap until they go idle.
  const hasPermission = new Set(
    Object.entries(draft.permission ?? {})
      .filter(([, perms]) => perms && perms.length > 0)
      .map(([sessionID]) => sessionID),
  )
  const hasQuestion = new Set(
    Object.entries(draft.question ?? {})
      .filter(([, questions]) => questions && questions.length > 0)
      .map(([sessionID]) => sessionID),
  )
  const isActive = new Set(
    Object.entries(draft.session_status ?? {})
      .filter(([, status]) => status && status.type !== "idle")
      .map(([sessionID]) => sessionID),
  )
  while (draft.session.length > draft.limit) {
    // Remove from the beginning (oldest by sorted ID)
    const candidate = draft.session[0]
    if (hasPermission.has(candidate.id) || hasQuestion.has(candidate.id) || isActive.has(candidate.id)) break
    draft.session.shift()
  }
}

function removeHiddenMessageFromDraft(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID || !messageID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  const result = Binary.search(messages, messageID, (message) => message.id)
  if (!result.found) return false

  const next = [...messages]
  next.splice(result.index, 1)
  draft.message[sessionID] = next
  updateSessionUserActivityFromMessages(draft, sessionID)
  return true
}

function cleanupSessionCaches(
  draft: State,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  dropSessionCaches(draft, [sessionID])
}
