type SessionMessageWithAgent = {
  role?: unknown
  agent?: unknown
  mode?: unknown
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
