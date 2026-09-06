import type { Part } from "@opencode-ai/sdk/v2"

type SessionMessageWithAgent = {
  id?: unknown
  role?: unknown
  agent?: unknown
  mode?: unknown
  model?: {
    providerID?: unknown
    modelID?: unknown
    variant?: unknown
  }
  variant?: unknown
}

type UserChoicePart = Pick<Part, "type"> & {
  synthetic?: boolean
  metadata?: { compaction_continue?: unknown }
}
type UserChoicePartsReader = (messageID: string) => readonly UserChoicePart[] | undefined
type UserChoiceState = {
  message: Record<string, readonly SessionMessageWithAgent[] | undefined>
  part: Record<string, readonly UserChoicePart[] | undefined>
}

export type LatestSessionUserChoice = {
  id: string
  agent: string | undefined
  providerID: string | undefined
  modelID: string | undefined
  variant: string | null | undefined
}

export function resolveUserMessageVariant(
  message: SessionMessageWithAgent,
): string | null | undefined {
  const variant = message.model?.variant !== undefined ? message.model.variant : message.variant
  if (variant === null || variant === "") return null
  return typeof variant === "string" && variant.trim().length > 0 ? variant : undefined
}

export function resolveSubtaskAgentFromMessages(
  messages: readonly SessionMessageWithAgent[],
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue

    const agent = typeof message.agent === "string" ? message.agent.trim() : ""
    if (agent) return agent

    const legacyMode = typeof message.mode === "string" ? message.mode.trim() : ""
    if (legacyMode) return legacyMode
  }

  return undefined
}

export function resolveLatestUserChoiceFromMessages(
  messages: readonly SessionMessageWithAgent[],
  getParts?: UserChoicePartsReader,
): LatestSessionUserChoice | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue
    // Native compaction requests and their automatic continuation do not
    // replace the human's model, thinking, agent, or plan-mode choice.
    if (typeof message.id === "string" && getParts) {
      const parts = getParts(message.id)
      if (!parts || parts.some(part => part.type === "compaction"
        || (part.type === "text" && part.synthetic === true && part.metadata?.compaction_continue === true))) continue
    }

    const providerID = typeof message.model?.providerID === "string"
      && message.model.providerID.trim().length > 0
      ? message.model.providerID
      : undefined
    const modelID = typeof message.model?.modelID === "string"
      && message.model.modelID.trim().length > 0
      ? message.model.modelID
      : undefined
    const directAgent = typeof message.agent === "string" && message.agent.trim().length > 0
      ? message.agent
      : undefined
    const legacyAgent = typeof message.mode === "string" && message.mode.trim().length > 0
      ? message.mode
      : undefined
    return {
      id: typeof message.id === "string" ? message.id : "",
      agent: directAgent ?? legacyAgent,
      providerID,
      modelID,
      variant: resolveUserMessageVariant(message),
    }
  }

  return null
}

export function createLatestUserChoiceSelector(sessionID: string) {
  let previousMessages: UserChoiceState["message"][string]
  let observedParts: { messageID: string; parts: readonly UserChoicePart[] | undefined }[] = []
  let previousChoice: LatestSessionUserChoice | null = null

  return (state: UserChoiceState): LatestSessionUserChoice | null => {
    const messages = state.message[sessionID]
    // Assistant text deltas do not revisit history or notify model controls.
    // Only the user parts actually inspected for this choice can invalidate it.
    if (messages === previousMessages && observedParts.every(({ messageID, parts }) => state.part[messageID] === parts)) {
      return previousChoice
    }

    const nextObservedParts: typeof observedParts = []
    const choice = messages ? resolveLatestUserChoiceFromMessages(messages, (messageID) => {
      const parts = state.part[messageID]
      nextObservedParts.push({ messageID, parts })
      return parts
    }) : null
    previousMessages = messages
    observedParts = nextObservedParts

    if (choice?.id === previousChoice?.id
      && choice?.agent === previousChoice?.agent
      && choice?.providerID === previousChoice?.providerID
      && choice?.modelID === previousChoice?.modelID
      && choice?.variant === previousChoice?.variant) return previousChoice

    previousChoice = choice
    return choice
  }
}
