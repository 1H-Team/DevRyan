import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import {
  normalizeChatOwnedDiffSummary,
  type SessionSummaryDiffStats,
} from "@/lib/sessionDiffStats"
import { getToolLifecycleState } from "@/lib/toolStatus"
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID, type RevertTransaction } from "./revert-transactions"
import { isAssistantTurnComplete } from "./session-working"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const STREAMING_PART_FIELDS = ["text", "output"] as const

export type MaterializedMessageRecord = {
  info: Message
  parts: Part[]
}

export type MaterializedState = {
  session?: Session[]
  revert_transaction?: Record<string, RevertTransaction | undefined>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

export type MaterializeSessionSnapshotsOptions = {
  skipPartTypes?: ReadonlySet<string>
  mode?: "merge" | "prepend"
  revertMessageID?: string
}

export type MaterializeSessionSnapshotsResult = {
  session?: Session[]
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  sessionsChanged: boolean
  messagesChanged: boolean
  partsChanged: boolean
}

export type SessionMaterializationStatus = {
  hasMessages: boolean
  renderable: boolean
  missingPartMessageIDs: string[]
}

function filterRenderableParts(parts: Part[], skipPartTypes: ReadonlySet<string>) {
  return parts.filter((part) => !!part?.id && !skipPartTypes.has(part.type))
}

function haveEquivalentPartSnapshots(left: Part[] | undefined, right: Part[]): boolean {
  if (!left) return right.length === 0
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (!leftPart || !rightPart) return false
    if (leftPart.id !== rightPart.id) return false
    if (JSON.stringify(leftPart) !== JSON.stringify(rightPart)) return false
  }

  return true
}

function haveEquivalentMessageSnapshots(left: Message, right: Message): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeMaterializedMessage(existing: Message, next: Message): Message {
  if (
    existing.role === "assistant"
    && next.role === "assistant"
    && isAssistantTurnComplete(existing)
    && !isAssistantTurnComplete(next)
  ) {
    return existing
  }

  return next
}

function mergeMaterializedMessages(existing: readonly Message[], nextMessages: readonly Message[]): Message[] {
  if (existing.length === 0) return [...nextMessages]
  if (nextMessages.length === 0) return existing as Message[]

  const merged = new Map(existing.map((item) => [item.id, item] as const))
  let changed = false

  for (const nextMessage of nextMessages) {
    const current = merged.get(nextMessage.id)
    if (!current) {
      merged.set(nextMessage.id, nextMessage)
      changed = true
      continue
    }

    const mergedMessage = mergeMaterializedMessage(current, nextMessage)
    if (mergedMessage === current || haveEquivalentMessageSnapshots(current, mergedMessage)) {
      continue
    }

    merged.set(nextMessage.id, mergedMessage)
    changed = true
  }

  if (!changed) return existing as Message[]
  return [...merged.values()].sort((left, right) => cmp(left.id, right.id))
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getStringField(part: Part, field: "text" | "output"): string | undefined {
  const value = (part as Record<string, unknown>)[field]
  return typeof value === "string" ? value : undefined
}

function hasLiveStreamingField(part: Part): boolean {
  if (getPartEndTime(part) !== undefined) return false
  return STREAMING_PART_FIELDS.some((field) => {
    const value = getStringField(part, field)
    return typeof value === "string" && value.length > 0
  })
}

function mergeMaterializedPart(existing: Part | undefined, next: Part): Part {
  if (!existing || getPartEndTime(next) !== undefined) return next

  if (existing.type === "tool" && next.type === "tool") {
    const existingState = (existing as { state?: { status?: unknown; time?: { start?: unknown; end?: unknown } } }).state
    const nextState = (next as { state?: { status?: unknown; time?: { start?: unknown; end?: unknown } } }).state
    if (getToolLifecycleState(existingState).isFinalized && getToolLifecycleState(nextState).isInFlight) {
      return existing
    }
  }

  let merged: Part = next
  for (const field of STREAMING_PART_FIELDS) {
    const existingValue = getStringField(existing, field)
    if (!existingValue) continue

    const nextValue = getStringField(next, field)
    if (typeof nextValue === "string" && nextValue.length >= existingValue.length) continue
    if (typeof nextValue === "string" && nextValue.length > 0 && !existingValue.startsWith(nextValue)) continue

    if (merged === next) merged = { ...next }
    const mergedRecord = merged as Record<string, unknown>
    mergedRecord[field] = existingValue
  }

  return merged
}

function mergeMaterializedParts(
  existing: Part[] | undefined,
  nextParts: Part[],
  skipPartTypes: ReadonlySet<string>,
  preserveLiveStreamingParts: boolean,
): Part[] {
  if (!existing || existing.length === 0) return nextParts
  if (!preserveLiveStreamingParts) return nextParts

  const existingByID = new Map(existing.map((part) => [part.id, part]))
  let mergedParts = nextParts
  let changed = false

  for (let index = 0; index < nextParts.length; index += 1) {
    const nextPart = nextParts[index]
    const mergedPart = mergeMaterializedPart(existingByID.get(nextPart.id), nextPart)
    if (mergedPart === nextPart) continue
    if (!changed) mergedParts = [...nextParts]
    mergedParts[index] = mergedPart
    changed = true
  }

  const snapshotIDs = new Set(nextParts.map((part) => part.id))
  const missingLiveParts = existing.filter(
    (part) => !!part?.id && !snapshotIDs.has(part.id) && !skipPartTypes.has(part.type) && hasLiveStreamingField(part),
  )
  if (missingLiveParts.length === 0) return mergedParts

  return [...mergedParts, ...missingLiveParts]
}

export function materializeSessionSnapshots(
  state: MaterializedState,
  sessionID: string,
  records: MaterializedMessageRecord[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const revertMessageID = options.revertMessageID ?? getEffectiveSessionRevertMessageID(state, sessionID)
  const snapshots = records
    .filter((record) => !!record?.info?.id)
    .filter((record) => !revertMessageID || record.info.id < revertMessageID)
    .sort((left, right) => cmp(left.info.id, right.info.id))
  const nextMessages = snapshots.map((record) => record.info)
  const rawCurrentMessages = state.message[sessionID] ?? []
  const currentMessages = filterMessagesForRevert(rawCurrentMessages, revertMessageID)
  const messages = mergeMaterializedMessages(currentMessages, nextMessages)
  const messagesChanged = messages !== rawCurrentMessages
  let sessionsChanged = false
  let nextSessions = state.session

  if (state.session) {
    const sessionIndex = state.session.findIndex((session) => session.id === sessionID)
    if (sessionIndex >= 0) {
      const currentSession = state.session[sessionIndex]
      const nextSession = normalizeChatOwnedDiffSummary(
        currentSession as Session & { summary?: SessionSummaryDiffStats | null },
        messages as Array<Message & { summary?: SessionSummaryDiffStats | null }>,
      ) as Session
      if (nextSession !== currentSession) {
        nextSessions = [...state.session]
        nextSessions[sessionIndex] = nextSession
        sessionsChanged = true
      }
    }
  }

  let partsChanged = false
  const nextPartState = { ...state.part }
  const isPrepend = options.mode === "prepend"

  if (revertMessageID) {
    for (const message of rawCurrentMessages) {
      if (message.id < revertMessageID) continue
      if (!Object.prototype.hasOwnProperty.call(nextPartState, message.id)) continue
      delete nextPartState[message.id]
      partsChanged = true
    }
  }

  for (const record of snapshots) {
    const messageID = record.info.id
    if (isPrepend && nextPartState[messageID]) continue

    const existing = nextPartState[messageID]
    const nextParts = mergeMaterializedParts(
      existing,
      filterRenderableParts(record.parts ?? [], skipPartTypes),
      skipPartTypes,
      record.info.role === "assistant",
    )
    if (haveEquivalentPartSnapshots(existing, nextParts)) continue

    if (nextParts.length === 0) {
      delete nextPartState[messageID]
    } else {
      nextPartState[messageID] = nextParts
    }
    partsChanged = true
  }

  return {
    session: sessionsChanged ? nextSessions : state.session,
    message: messagesChanged ? { ...state.message, [sessionID]: messages } : state.message,
    part: partsChanged ? nextPartState : state.part,
    messages,
    sessionsChanged,
    messagesChanged,
    partsChanged,
  }
}

export function getSessionMaterializationStatus(
  state: MaterializedState,
  sessionID: string,
): SessionMaterializationStatus {
  const messages = filterMessagesForRevert(
    state.message[sessionID] ?? [],
    getEffectiveSessionRevertMessageID(state, sessionID),
  )
  if (!Object.prototype.hasOwnProperty.call(state.message, sessionID)) {
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }

  const missingPartMessageIDs: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const parts = state.part[message.id]
    if (!parts || parts.length === 0) {
      missingPartMessageIDs.push(message.id)
    }
  }

  return {
    hasMessages: true,
    renderable: missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}
