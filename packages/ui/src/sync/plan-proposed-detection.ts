import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getPlanBlockId, getPlanImplementationKey, resolveMessagePlanCard, resolvePlanTurnIntent } from "@/lib/messages/actionablePlan"
import { projectPlanRevisions, type PlanRevisionTurnInput } from "@/lib/messages/planRevisions"
import { filterMessagesForRevert, getEffectiveSessionRevertMessageID } from "./revert-transactions"
import type { State } from "./types"

export type PlanProposedCandidate = {
  sessionID: string
  sourceMessageId: string
  originatingUserMessageId: string
  implementationKey: string
  markdown: string
}

type PlanProposedDetectionState = Pick<
  State,
    "message" | "part" | "permission" | "question" | "session" | "revert_transaction" | "session_status"
>

export function detectPlanProposedCandidate({
  sessionID,
  state,
  isRecordedPlanModeUserMessage,
  implementedPlanRequests,
  externallyHandedOffPlanRequests,
}: {
  sessionID: string
  state: PlanProposedDetectionState
  isRecordedPlanModeUserMessage: (messageId: string) => boolean
  implementedPlanRequests: ReadonlySet<string>
  externallyHandedOffPlanRequests?: ReadonlySet<string>
}): PlanProposedCandidate | null {
  const status = state.session_status[sessionID]?.type
  if (status === "busy" || status === "retry") return null
  const pendingQuestions = state.question[sessionID]
  if (pendingQuestions && pendingQuestions.length > 0) return null
  const pendingPermissions = state.permission[sessionID]
  if (pendingPermissions && pendingPermissions.length > 0) return null

  const rawMessages = state.message[sessionID]
  if (!rawMessages || rawMessages.length === 0) return null

  const revertMessageID = getEffectiveSessionRevertMessageID(state, sessionID)
  const messages = filterMessagesForRevert(rawMessages, revertMessageID)

  // The proposal moment is when the session's tail settles on a completed
  // assistant message. The tail assistant itself may be plain epilogue text —
  // the canonical plan is selected from the whole revision below.
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== "assistant") return null
  if (!isAssistantTurnComplete(lastMessage)) return null

  const turnInputs = buildRevisionTurnInputs(messages, state, isRecordedPlanModeUserMessage)
  if (turnInputs.length === 0) return null

  // A settled native tail may contain only the remainder of a failed prefix.
  // This is a validation probe, not an approval: the server requires receipts.
  let lastHumanIndex = -1
  turnInputs.forEach((turn, index) => { if (turn.userParts.some(part => part.type !== 'text' || part.synthetic !== true)) lastHumanIndex = index })
  if (lastHumanIndex >= 0 && lastHumanIndex < turnInputs.length - 1) {
    const root = turnInputs[lastHumanIndex]
    const following = turnInputs.slice(lastHumanIndex + 1)
    const descendants = turnInputs.slice(lastHumanIndex).flatMap(turn => turn.assistants)
    const terminal = descendants.at(-1)
    const rootIntent = resolvePlanTurnIntent(root.userInfo, root.userParts, root.isRecordedPlanMode)
    if (rootIntent !== 'implement' && rootIntent !== 'maintenance'
      && following.every(turn => turn.userParts.length > 0 && turn.userParts.every(part => part.type === 'text' && part.synthetic === true)
        && resolvePlanTurnIntent(turn.userInfo, turn.userParts, false) === 'none')
      && descendants.every(assistant => assistant.completedAt !== null && !hasRunningToolPart(assistant.parts))
      && !following.some(turn => turn.assistants.some(assistant => resolveMessagePlanCard(assistant.parts)?.source === 'sentinel'))
      && terminal && !terminal.hasError && ['stop', 'end_turn', 'complete', 'completed'].includes(terminal.finish ?? '')) {
      const prefix = [...root.assistants].reverse().find(assistant => assistant.hasError
        && resolveMessagePlanCard(assistant.parts, { isPlanModeSource: rootIntent === 'plan' }))
      const markdown = prefix && resolveMessagePlanCard(prefix.parts, { isPlanModeSource: rootIntent === 'plan' })?.planText
      if (prefix && markdown?.trim()) return { sessionID, sourceMessageId: prefix.id, originatingUserMessageId: root.userMessageId,
        implementationKey: getPlanImplementationKey(sessionID, getPlanBlockId(prefix.id, 0)), markdown }
    }
  }
  const revisions = projectPlanRevisions(turnInputs)
  const revision = revisions[revisions.length - 1]
  // A sentinel-backed Plan card is explicit even when local plan-mode
  // ownership was unavailable (for example after reload or from a remote
  // session). Structured markdown still requires plan-mode evidence because
  // resolveMessagePlanCard only recognizes it for plan-mode revisions.
  if (!revision) return null
  const revisionRoot = turnInputs.find(turn => turn.userMessageId === revision.rootUserMessageId)
  if (revisionRoot?.userParts.length && !revisionRoot.isRecordedPlanMode && revisionRoot.userParts.every(part => part.type === 'text' && part.synthetic === true)) return null
  if (!revision.sourceMessageId || !revision.planText || revision.planText.trim().length === 0) return null
  if (revision.sourceMessageId !== lastMessage.id) return null

  // Only propose while the revision is still the live tail of the session.
  const lastTurnId = turnInputs[turnInputs.length - 1]?.turnId
  if (!lastTurnId || !revision.memberTurnIds.includes(lastTurnId)) return null

  // Never save or enable implementation while any sibling assistant in the
  // revision is still generating or running tools.
  if (!revision.isSettled || revision.hasTerminalError) return null
  for (const memberTurnId of revision.memberTurnIds) {
    const memberTurn = turnInputs.find((turn) => turn.turnId === memberTurnId)
    if (!memberTurn) continue
    for (const assistant of memberTurn.assistants) {
      if (hasRunningToolPart(assistant.parts)) return null
    }
  }

  const implementationKey = getPlanImplementationKey(
    sessionID,
    getPlanBlockId(revision.sourceMessageId, 0),
  )
  if (
    implementedPlanRequests.has(implementationKey)
    || externallyHandedOffPlanRequests?.has(implementationKey)
  ) return null

  return {
    sessionID,
    sourceMessageId: revision.sourceMessageId,
    originatingUserMessageId: revision.rootUserMessageId,
    implementationKey,
    markdown: revision.planText,
  }
}

function buildRevisionTurnInputs(
  messages: readonly Message[],
  state: PlanProposedDetectionState,
  isRecordedPlanModeUserMessage: (messageId: string) => boolean,
): PlanRevisionTurnInput[] {
  const inputs: PlanRevisionTurnInput[] = []
  const inputByUserMessageId = new Map<string, PlanRevisionTurnInput>()

  for (const message of messages) {
    if (message.role === "user") {
      const input: PlanRevisionTurnInput = {
        turnId: message.id,
        userMessageId: message.id,
        userInfo: message,
        userParts: state.part[message.id] ?? [],
        isRecordedPlanMode: isRecordedPlanModeUserMessage(message.id),
        assistants: [],
      }
      inputs.push(input)
      inputByUserMessageId.set(message.id, input)
      continue
    }

    if (message.role !== "assistant") continue

    const parentID = (message as { parentID?: unknown }).parentID
    const targetTurn = (typeof parentID === "string" ? inputByUserMessageId.get(parentID) : undefined)
      ?? inputs[inputs.length - 1]
    if (!targetTurn) continue

    targetTurn.assistants.push({
      id: message.id,
      parentMessageId: typeof parentID === "string" && parentID.trim().length > 0 ? parentID : null,
      completedAt: getAssistantCompletedAt(message),
      hasError: message.role === "assistant" && message.error != null,
      finish: message.role === "assistant" ? message.finish : undefined,
      parts: state.part[message.id] ?? [],
    })
  }

  return inputs
}

function getAssistantCompletedAt(message: Message): number | null {
  if (!isAssistantTurnComplete(message)) return null
  const completedAt = (message.time as { completed?: unknown } | undefined)?.completed
  return typeof completedAt === "number" && completedAt > 0 ? completedAt : 1
}

function hasRunningToolPart(parts: readonly Part[]): boolean {
  for (const part of parts) {
    if (part.type !== "tool") continue
    const status = (part as { state?: { status?: unknown } }).state?.status
    if (status === "pending" || status === "running") return true
  }

  return false
}

function isAssistantTurnComplete(message: Message): boolean {
  const candidate = message as Message & { status?: unknown; streaming?: unknown }
  if (candidate.streaming === true) return false

  if (typeof candidate.status === "string") {
    const status = candidate.status.trim().toLowerCase()
    if (status === "running" || status === "pending" || status === "streaming") return false
    if (status === "complete" || status === "completed" || status === "done") return true
  }

  const completedAt = (message.time as { completed?: unknown } | undefined)?.completed
  return typeof completedAt === "number" && completedAt > 0
}
