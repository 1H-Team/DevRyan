import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { messagesBefore } from "./message-order"

export type RevertTransactionStatus = "pending" | "confirmed" | "failed"

export type RevertTransaction = {
  messageID: string
  hiddenMessageIDs?: ReadonlySet<string>
  version: number
  status: RevertTransactionStatus
  startedAt: number
  serverAcknowledged?: boolean
}

export type RevertAwareState = {
  session?: Session[]
  message?: Record<string, Message[] | undefined>
  revert_transaction?: Record<string, RevertTransaction | undefined>
}

const committedRevertResends = new Set<string>()

const committedRevertResendKey = (sessionID: string, messageID: string): string => `${sessionID}\0${messageID}`

export function beginCommittedRevertResend(sessionID: string, messageID: string | undefined): void {
  if (!sessionID || !messageID) return
  committedRevertResends.add(committedRevertResendKey(sessionID, messageID))
}

export function endCommittedRevertResend(sessionID: string, messageID: string | undefined): void {
  if (!sessionID || !messageID) return
  committedRevertResends.delete(committedRevertResendKey(sessionID, messageID))
}

export function clearCommittedRevertResendsForSessions(sessionIDs: Iterable<string>): void {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const prefix = `${sessionID}\0`
    for (const key of committedRevertResends) {
      if (key.startsWith(prefix)) {
        committedRevertResends.delete(key)
      }
    }
  }
}

export function isCommittedRevertResendInFlight(sessionID: string, messageID: string | undefined): boolean {
  if (!sessionID || !messageID) return false
  return committedRevertResends.has(committedRevertResendKey(sessionID, messageID))
}

export function getSessionRevertMessageID(session: Session | undefined): string | undefined {
  return (session as (Session & { revert?: { messageID?: string } }) | undefined)?.revert?.messageID
}

export function getEffectiveSessionRevertMessageID(
  state: RevertAwareState,
  sessionID: string,
  session?: Session,
): string | undefined {
  const transaction = state.revert_transaction?.[sessionID]
  if (transaction && transaction.status !== "failed") {
    return transaction.messageID
  }

  return getSessionRevertMessageID(
    session ?? state.session?.find((candidate) => candidate.id === sessionID),
  )
}

export function isMessageHiddenByRevert(
  state: RevertAwareState,
  sessionID: string | undefined,
  messageID: string,
): boolean {
  if (!sessionID) return false
  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  if (!revertMessageID) return false
  const transaction = state.revert_transaction?.[sessionID]
  if (transaction?.status !== "failed" && transaction?.hiddenMessageIDs?.has(messageID)) {
    return true
  }
  const messages = state.message?.[sessionID]
  if (!messages) return false
  const visible = messagesBefore(messages, revertMessageID)
  return visible !== messages && !visible.some((message) => message.id === messageID)
}

export function hasActiveRevertTransactions(state: RevertAwareState): boolean {
  const transactions = state.revert_transaction
  if (!transactions) return false
  for (const transaction of Object.values(transactions)) {
    if (transaction && transaction.status !== "failed") return true
  }
  return false
}

export function isMessageHiddenByAnyActiveRevert(
  state: RevertAwareState,
  messageID: string,
): boolean {
  const transactions = state.revert_transaction
  if (!transactions) return false
  for (const [sessionID, transaction] of Object.entries(transactions)) {
    if (!transaction || transaction.status === "failed") continue
    if (transaction.hiddenMessageIDs?.has(messageID)) {
      const session = state.session?.find((candidate) => candidate.id === sessionID)
      if (!session || getEffectiveSessionRevertMessageID(state, sessionID, session) === transaction.messageID) {
        return true
      }
    }
  }
  return false
}

export function filterMessagesForRevert(
  messages: readonly Message[],
  revertMessageID: string | undefined,
): Message[] | readonly Message[] {
  if (!revertMessageID) return messages
  return messagesBefore(messages, revertMessageID)
}
