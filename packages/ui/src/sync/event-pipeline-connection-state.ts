export type EventPipelineConnectionSnapshot = {
  isConnected: boolean
  hasEverConnected: boolean
}

export type EventPipelineConnectionEvent =
  | { type: "reconnected" }
  | { type: "disconnected"; reason: string }
  | { type: "transport-switched" }

export type EventPipelineConnectionUpdate = {
  isConnected: boolean
  hasEverConnected?: boolean
  connectionPhase: "connecting" | "connected" | "reconnecting"
  lastDisconnectReason?: string
}

export function resolveEventPipelineConnectionUpdate(
  state: EventPipelineConnectionSnapshot,
  event: EventPipelineConnectionEvent,
): EventPipelineConnectionUpdate | undefined {
  if (event.type === "transport-switched") {
    return undefined
  }

  if (event.type === "reconnected") {
    return {
      isConnected: true,
      hasEverConnected: true,
      connectionPhase: "connected",
    }
  }

  return {
    isConnected: false,
    connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
    lastDisconnectReason: event.reason,
  }
}
