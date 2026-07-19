import { describe, expect, test } from "bun:test"
import { resolveEventPipelineConnectionUpdate } from "./event-pipeline-connection-state"

describe("event pipeline connection state", () => {
  test("stays disconnected during a transport switch until the fallback connects", () => {
    const previouslyConnected = {
      isConnected: true,
      hasEverConnected: true,
    }

    const disconnected = {
      ...previouslyConnected,
      ...resolveEventPipelineConnectionUpdate(previouslyConnected, {
        type: "disconnected",
        reason: "sse_heartbeat_timeout",
      }),
    }

    expect(disconnected).toEqual({
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: "reconnecting",
      lastDisconnectReason: "sse_heartbeat_timeout",
    })
    expect(resolveEventPipelineConnectionUpdate(disconnected, {
      type: "transport-switched",
    })).toBe(undefined)

    expect(resolveEventPipelineConnectionUpdate(disconnected, {
      type: "reconnected",
    })).toEqual({
      isConnected: true,
      hasEverConnected: true,
      connectionPhase: "connected",
    })
  })

  test("uses the initial connecting phase before the first successful connection", () => {
    expect(resolveEventPipelineConnectionUpdate({
      isConnected: false,
      hasEverConnected: false,
    }, {
      type: "disconnected",
      reason: "ws_error:unavailable",
    })).toEqual({
      isConnected: false,
      connectionPhase: "connecting",
      lastDisconnectReason: "ws_error:unavailable",
    })
  })
})
