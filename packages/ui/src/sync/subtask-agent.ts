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

export type LatestSessionUserChoice = {
  id: string
  agent: string | undefined
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
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
): LatestSessionUserChoice | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue

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
    const variantCandidate = message.model?.variant ?? message.variant

    return {
      id: typeof message.id === "string" ? message.id : "",
      agent: directAgent ?? legacyAgent,
      providerID,
      modelID,
      variant: typeof variantCandidate === "string" && variantCandidate.trim().length > 0
        ? variantCandidate
        : undefined,
    }
  }

  return null
}
