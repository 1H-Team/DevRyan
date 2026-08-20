import type { SessionStatus, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { filterSessionStatusThroughAbortGuard } from "./abort-retry-guard"
import { getSessionMaterializationStatus } from "./materialization"
import type { State } from "./types"

export { unwrapSdkResult } from "./sdk-result"

export const ACTIVE_SESSION_STATUS_STALE_MS = 20_000
export const ACTIVE_SESSION_RECOVERY_COOLDOWN_MS = 15_000
export const ACTIVE_SESSION_RECOVERY_MAX_COOLDOWN_MS = 60_000
export const PROVIDER_STALL_SEMANTIC_SILENCE_MS = 5 * 60_000
export const LONG_RUNNING_TOOL_SEMANTIC_SILENCE_MS = 10 * 60_000

export function getActiveSessionRecoveryCooldownMs(failureCount = 0): number {
  const normalizedFailureCount = Number.isFinite(failureCount)
    ? Math.max(0, Math.floor(failureCount))
    : 0
  return Math.min(
    ACTIVE_SESSION_RECOVERY_COOLDOWN_MS * (2 ** normalizedFailureCount),
    ACTIVE_SESSION_RECOVERY_MAX_COOLDOWN_MS,
  )
}

export function getActiveSessionRecoveryActivityAt(input: {
  status: SessionStatus | undefined
  now: number
  lastStatusEventAt?: number
  lastOutputEventAt?: number
}): number {
  if (input.status?.type === "retry") {
    const retryActivity = [input.lastStatusEventAt, input.lastOutputEventAt]
      .filter((value): value is number => typeof value === "number")
    return retryActivity.length > 0 ? Math.max(...retryActivity) : input.now
  }
  return input.lastOutputEventAt ?? input.lastStatusEventAt ?? input.now
}

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, Message[]>
  part?: Record<string, Part[]>
}

type RecoveredSessionStatusState = Pick<
  State,
  "message" | "part" | "permission" | "question" | "session" | "session_status" | "revert_transaction"
>

type PendingToolInputState = Pick<
  State,
  "message" | "part" | "permission" | "question" | "session" | "session_status"
>

export type PendingToolInputStallFingerprint = {
  kind: "tool-input"
  sessionID: string
  assistantMessageID: string
  anchorUserMessageID: string
  partID: string
  callID: string
  tool: string
}

export type ProviderInferenceStallFingerprint = {
  kind: "inference"
  sessionID: string
  assistantMessageID: string
  anchorUserMessageID: string
  stepStartPartID: string
  partID: string
  partType: "reasoning" | "text"
}

export type LongRunningToolFingerprint = {
  kind: "long-running-tool"
  sessionID: string
  assistantMessageID: string
  anchorUserMessageID: string
  partID: string
  callID: string
  tool: string
}

export type ProviderStallFingerprint = (
  PendingToolInputStallFingerprint | ProviderInferenceStallFingerprint
)

const nonEmptyString = (value: unknown): string | null => (
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null
)

const isEmptyPlainObject = (value: unknown): boolean => (
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && Object.keys(value).length === 0
)

type IncompleteRootAssistantSnapshot = {
  assistant: Message
  anchorUserMessageID: string
  parts: Part[]
}

const getIncompleteRootAssistantSnapshot = (input: {
  state: PendingToolInputState
  sessionID: string
}): IncompleteRootAssistantSnapshot | null => {
  if (input.state.session_status[input.sessionID]?.type !== "busy") return null
  const session = input.state.session.find((candidate) => candidate.id === input.sessionID) as (
    Session & { parentID?: string | null }
  ) | undefined
  if (!session || session.parentID) return null
  if ((input.state.permission[input.sessionID]?.length ?? 0) > 0) return null
  if ((input.state.question[input.sessionID]?.length ?? 0) > 0) return null

  const messages = input.state.message[input.sessionID] ?? []
  const assistant = messages.at(-1) as (Message & {
    parentID?: unknown
    error?: unknown
    finish?: unknown
  }) | undefined
  if (!assistant || assistant.role !== "assistant" || assistant.error) return null
  if (typeof assistant.time?.completed === "number") return null
  if (typeof assistant.finish === "string" && assistant.finish.length > 0) return null

  const anchorUserMessageID = nonEmptyString(assistant.parentID)
  if (!anchorUserMessageID) return null

  return {
    assistant,
    anchorUserMessageID,
    parts: input.state.part[assistant.id] ?? [],
  }
}

export function getPendingToolInputStallFingerprint(input: {
  state: PendingToolInputState
  sessionID: string
}): PendingToolInputStallFingerprint | null {
  const snapshot = getIncompleteRootAssistantSnapshot(input)
  if (!snapshot) return null

  const trailingPart = snapshot.parts.at(-1) as (Part & {
    callID?: unknown
    tool?: unknown
    state?: { status?: unknown; input?: unknown; raw?: unknown }
  }) | undefined
  if (!trailingPart || trailingPart.type !== "tool") return null
  if (trailingPart.state?.status !== "pending") return null
  if (!isEmptyPlainObject(trailingPart.state.input)) return null
  if (trailingPart.state.raw !== "") return null

  const partID = nonEmptyString(trailingPart.id)
  const callID = nonEmptyString(trailingPart.callID)
  const tool = nonEmptyString(trailingPart.tool)
  if (!partID || !callID || !tool || tool.toLowerCase() === "devryan_task") return null

  return {
    kind: "tool-input",
    sessionID: input.sessionID,
    assistantMessageID: snapshot.assistant.id,
    anchorUserMessageID: snapshot.anchorUserMessageID,
    partID,
    callID,
    tool,
  }
}

export function getProviderInferenceStallFingerprint(input: {
  state: PendingToolInputState
  sessionID: string
}): ProviderInferenceStallFingerprint | null {
  const snapshot = getIncompleteRootAssistantSnapshot(input)
  if (!snapshot || snapshot.parts.length !== 2) return null

  const [stepStartPart, trailingPart] = snapshot.parts as [Part, Part]
  if (stepStartPart.type !== "step-start") return null
  if (trailingPart.type !== "reasoning" && trailingPart.type !== "text") return null
  const text = (trailingPart as Part & { text?: unknown }).text
  if (typeof text !== "string" || text.trim().length > 0) return null

  const stepStartPartID = nonEmptyString(stepStartPart.id)
  const partID = nonEmptyString(trailingPart.id)
  if (!stepStartPartID || !partID) return null

  return {
    kind: "inference",
    sessionID: input.sessionID,
    assistantMessageID: snapshot.assistant.id,
    anchorUserMessageID: snapshot.anchorUserMessageID,
    stepStartPartID,
    partID,
    partType: trailingPart.type,
  }
}

export function getProviderStallFingerprint(input: {
  state: PendingToolInputState
  sessionID: string
}): ProviderStallFingerprint | null {
  return getPendingToolInputStallFingerprint(input)
    ?? getProviderInferenceStallFingerprint(input)
}

const RECOVERABLE_LONG_RUNNING_TOOL_NAMES = new Set([
  "ctx_execute",
  "mcp__context_mode__ctx_execute",
  "bash",
  "shell",
])

const isRecoverableLongRunningTool = (tool: string): boolean => (
  RECOVERABLE_LONG_RUNNING_TOOL_NAMES.has(tool.trim().toLowerCase().replaceAll("-", "_"))
)

const LONG_RUNNING_TOOL_STATUSES = new Set([
  "running",
  "started",
  "inprogress",
  "processing",
  "executing",
])

const normalizeToolStatus = (status: unknown): string => (
  typeof status === "string"
    ? status.trim().toLowerCase().replace(/[\s_-]+/g, "")
    : ""
)

export function getLongRunningToolFingerprint(input: {
  state: PendingToolInputState
  sessionID: string
}): LongRunningToolFingerprint | null {
  const snapshot = getIncompleteRootAssistantSnapshot(input)
  if (!snapshot) return null

  const trailingPart = snapshot.parts.at(-1) as (Part & {
    callID?: unknown
    tool?: unknown
    state?: { status?: unknown }
  }) | undefined
  if (!trailingPart || trailingPart.type !== "tool") return null

  const status = normalizeToolStatus(trailingPart.state?.status)
  if (!LONG_RUNNING_TOOL_STATUSES.has(status)) return null

  const partID = nonEmptyString(trailingPart.id)
  const callID = nonEmptyString(trailingPart.callID)
  const tool = nonEmptyString(trailingPart.tool)
  if (!partID || !callID || !tool || !isRecoverableLongRunningTool(tool)) return null

  return {
    kind: "long-running-tool",
    sessionID: input.sessionID,
    assistantMessageID: snapshot.assistant.id,
    anchorUserMessageID: snapshot.anchorUserMessageID,
    partID,
    callID,
    tool,
  }
}

export function haveSameLongRunningToolFingerprint(
  left: LongRunningToolFingerprint | null | undefined,
  right: LongRunningToolFingerprint | null | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.sessionID === right.sessionID
    && left.assistantMessageID === right.assistantMessageID
    && left.anchorUserMessageID === right.anchorUserMessageID
    && left.partID === right.partID
    && left.callID === right.callID
    && left.tool === right.tool
}

export function shouldConfirmLongRunningTool(input: {
  managedChildActive: boolean
  silentForMs: number
  thresholdMs?: number
  before: LongRunningToolFingerprint | null | undefined
  after: LongRunningToolFingerprint | null | undefined
}): boolean {
  const thresholdMs = input.thresholdMs ?? LONG_RUNNING_TOOL_SEMANTIC_SILENCE_MS
  return !input.managedChildActive
    && input.silentForMs >= thresholdMs
    && Boolean(input.after)
    && haveSameLongRunningToolFingerprint(input.before, input.after)
}

export function haveSameProviderStallFingerprint(
  left: ProviderStallFingerprint | null | undefined,
  right: ProviderStallFingerprint | null | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind) return false
  if (
    left.sessionID !== right.sessionID
    || left.assistantMessageID !== right.assistantMessageID
    || left.anchorUserMessageID !== right.anchorUserMessageID
    || left.partID !== right.partID
  ) {
    return false
  }
  if (left.kind === "tool-input" && right.kind === "tool-input") {
    return left.callID === right.callID && left.tool === right.tool
  }
  if (left.kind === "inference" && right.kind === "inference") {
    return left.stepStartPartID === right.stepStartPartID && left.partType === right.partType
  }
  return false
}

export function haveSamePendingToolInputStallFingerprint(
  left: PendingToolInputStallFingerprint | null | undefined,
  right: PendingToolInputStallFingerprint | null | undefined,
): boolean {
  return haveSameProviderStallFingerprint(left, right)
}

export type ViewedSessionMaterializationTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionMaterializationTarget | null
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    } else if (!getSessionMaterializationStatus({ message: state.message ?? {}, part: state.part ?? {} }, sessionId).renderable) {
      ids.add(sessionId)
    }
  }

  const parentIds = new Set<string>()
  for (const session of state.session) {
    const parentId = (session as Session & { parentID?: string | null }).parentID
    if (parentId) {
      parentIds.add(parentId)
    }
  }
  for (const pid of parentIds) {
    ids.add(pid)
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}

type RawSessionStatus = {
  type?: unknown
  attempt?: unknown
  message?: unknown
  next?: unknown
}

export type SessionStatusBaseline = ReadonlyMap<string, SessionStatus | undefined>

const cloneSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => (
  status ? { ...status } as SessionStatus : undefined
)

const haveEquivalentSessionStatus = (
  left: SessionStatus | undefined,
  right: SessionStatus | undefined,
): boolean => {
  if (left === right) return true
  if (!left || !right || left.type !== right.type) return false
  if (left.type !== "retry" || right.type !== "retry") return true
  return left.attempt === right.attempt
    && left.message === right.message
    && left.next === right.next
}

export function captureSessionStatusBaseline(
  current: Record<string, SessionStatus>,
  candidateSessionIds: Iterable<string>,
): SessionStatusBaseline {
  const baseline = new Map<string, SessionStatus | undefined>()
  for (const sessionId of candidateSessionIds) {
    baseline.set(sessionId, cloneSessionStatus(current[sessionId]))
  }
  return baseline
}

export function filterUnchangedSessionStatusCandidates(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  baseline: SessionStatusBaseline
}): string[] {
  const eligible = new Set<string>()
  for (const sessionId of input.candidateSessionIds) {
    if (!input.baseline.has(sessionId)) continue
    if (!haveEquivalentSessionStatus(input.current[sessionId], input.baseline.get(sessionId))) continue
    eligible.add(sessionId)
  }
  return [...eligible]
}

export function toAuthoritativeSessionStatus(status: RawSessionStatus | undefined): SessionStatus | undefined {
  if (!status) return undefined
  if (status.type === "idle" || status.type === "busy") {
    return { type: status.type }
  }
  if (
    status.type === "retry"
    && typeof status.attempt === "number"
    && typeof status.message === "string"
    && typeof status.next === "number"
  ) {
    return {
      type: "retry",
      attempt: status.attempt,
      message: status.message,
      next: status.next,
    } as SessionStatus
  }
  return undefined
}

export function mergeAuthoritativeSessionStatuses(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  authoritative: Record<string, RawSessionStatus | undefined>
}): Record<string, SessionStatus> {
  let next: Record<string, SessionStatus> | undefined
  for (const sessionId of input.candidateSessionIds) {
    const rawStatus = toAuthoritativeSessionStatus(input.authoritative[sessionId])
    if (!rawStatus) continue
    // Reconnect snapshots go through the same stop-during-retry guard as live
    // events so a user-stopped retry loop cannot resurrect via resync.
    const status = filterSessionStatusThroughAbortGuard(sessionId, rawStatus)
    const currentStatus = input.current[sessionId]
    if (currentStatus === status || currentStatus?.type === status.type) {
      if (status.type !== "retry" || (
        (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.attempt === status.attempt
        && (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.message === status.message
        && (currentStatus as Extract<SessionStatus, { type: "retry" }> | undefined)?.next === status.next
      )) {
        continue
      }
    }
    next ??= { ...input.current }
    next[sessionId] = status
  }

  return next ?? input.current
}

export function mergeRecoveredSessionStatuses(input: {
  current: Record<string, SessionStatus>
  candidateSessionIds: Iterable<string>
  authoritative: Record<string, RawSessionStatus | undefined>
  state: RecoveredSessionStatusState
}): Record<string, SessionStatus> {
  return mergeAuthoritativeSessionStatuses(input)
}

export function shouldRecoverStaleActiveSession(input: {
  status: SessionStatus | undefined
  now?: number
  lastStatusEventAt?: number
  lastOutputEventAt?: number
  lastRecoveryAt?: number
  staleMs?: number
  cooldownMs?: number
}): boolean {
  const statusType = input.status?.type
  if (statusType !== "busy" && statusType !== "retry") {
    return false
  }

  const now = input.now ?? Date.now()
  const staleMs = input.staleMs ?? ACTIVE_SESSION_STATUS_STALE_MS
  const cooldownMs = input.cooldownMs ?? ACTIVE_SESSION_RECOVERY_COOLDOWN_MS
  const lastObservedEventAt = getActiveSessionRecoveryActivityAt({
    status: input.status,
    now,
    lastStatusEventAt: input.lastStatusEventAt,
    lastOutputEventAt: input.lastOutputEventAt,
  })

  if (now - lastObservedEventAt < staleMs) {
    return false
  }

  if (typeof input.lastRecoveryAt === "number" && now - input.lastRecoveryAt < cooldownMs) {
    return false
  }

  return true
}
