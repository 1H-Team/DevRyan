import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"
import {
  getEffectiveSessionRevertMessageID,
  getSessionRevertMessageID,
  isMessageHiddenByRevert,
  filterMessagesForRevert,
} from "./revert-transactions"

export type SessionUserActivity = Record<string, number>

export const toFiniteTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export const isRootSession = (session: Session | undefined): boolean => {
  return !((session as (Session & { parentID?: string | null }) | undefined)?.parentID)
}

export const isMessageVisibleForSession = (
  message: Message,
  session: Session | undefined,
  messages: readonly Message[] = [message],
): boolean => {
  const revertMessageID = getSessionRevertMessageID(session)
  if (!revertMessageID) return true
  return filterMessagesForRevert(messages, revertMessageID).some((candidate) => candidate.id === message.id)
}

const isMessageVisibleForSessionState = (
  state: State,
  message: Message,
): boolean => {
  return !isMessageHiddenByRevert(state, message.sessionID, message.id)
}

export const getMessageCreatedAt = (message: Message): number | undefined => {
  return toFiniteTimestamp(message.time?.created)
}

export const getLastVisibleUserMessageAt = (
  session: Session | undefined,
  messages: readonly Message[] | undefined,
  state?: State,
): number | undefined => {
  if (!isRootSession(session) || !messages) return undefined

  const revertMessageID = state
    ? getEffectiveSessionRevertMessageID(state, session?.id ?? "", session)
    : getSessionRevertMessageID(session)
  const visibleMessages = revertMessageID ? filterMessagesForRevert(messages, revertMessageID) : messages
  let latest: number | undefined
  for (const message of visibleMessages) {
    const visible = state
      ? isMessageVisibleForSessionState(state, message)
      : true
    if (message.role !== "user" || !visible) continue
    const createdAt = getMessageCreatedAt(message)
    if (createdAt === undefined) continue
    latest = latest === undefined ? createdAt : Math.max(latest, createdAt)
  }
  return latest
}

const setActivityValue = (activity: SessionUserActivity, sessionID: string, value: number | undefined): SessionUserActivity => {
  const current = activity[sessionID]
  if (value === undefined) {
    if (current === undefined) return activity
    const next = { ...activity }
    delete next[sessionID]
    return next
  }
  if (current === value) return activity
  return { ...activity, [sessionID]: value }
}

export const updateSessionUserActivityFromMessages = (draft: State, sessionID: string): boolean => {
  const session = draft.session.find((item) => item.id === sessionID)
  const latest = getLastVisibleUserMessageAt(session, draft.message[sessionID], draft)
  const next = setActivityValue(draft.session_user_activity, sessionID, latest)
  if (next === draft.session_user_activity) return false
  draft.session_user_activity = next
  return true
}

export const updateSessionUserActivityFromMessage = (draft: State, message: Message): boolean => {
  if (message.role !== "user") return false

  const session = draft.session.find((item) => item.id === message.sessionID)
  if (!isRootSession(session) || !isMessageVisibleForSessionState(draft, message)) return false

  const createdAt = getMessageCreatedAt(message)
  if (createdAt === undefined) return false

  const current = draft.session_user_activity[message.sessionID]
  if (current !== undefined && current >= createdAt) return false

  draft.session_user_activity = { ...draft.session_user_activity, [message.sessionID]: createdAt }
  return true
}
