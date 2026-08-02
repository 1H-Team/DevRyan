import { beforeEach, describe, expect, test } from "bun:test"

import { useProviderStallStore } from "./useProviderStallStore"

const stall = {
  kind: "tool-input",
  sessionID: "ses_1",
  directory: "/workspace",
  assistantMessageID: "msg_assistant",
  anchorUserMessageID: "msg_user",
  partID: "part_tool",
  callID: "call_tool",
  tool: "todowrite",
  confirmedAt: 1_000,
} as const

beforeEach(() => useProviderStallStore.getState().reset())

describe("provider stall store", () => {
  test("keeps one low-frequency actionable record per session", () => {
    const store = useProviderStallStore.getState()
    store.offerStall(stall)
    store.setActionState(stall.sessionID, true, null)
    store.offerStall({ ...stall, confirmedAt: 2_000 })

    expect(useProviderStallStore.getState().stallsBySessionId[stall.sessionID]).toEqual({
      ...stall,
      pending: true,
      actionError: null,
    })
  })

  test("does not let an old action clear a newer stalled call", () => {
    const store = useProviderStallStore.getState()
    store.offerStall(stall)
    store.offerStall({
      ...stall,
      partID: "part_new",
      callID: "call_new",
      confirmedAt: 2_000,
    })
    store.clearStall(stall.sessionID, stall)

    const current = useProviderStallStore.getState().stallsBySessionId[stall.sessionID]
    expect(current?.kind).toBe("tool-input")
    if (current?.kind !== "tool-input") throw new Error("Expected a tool-input stall")
    expect(current.callID).toBe("call_new")
  })

  test("clears only records owned by a disposed directory", () => {
    const store = useProviderStallStore.getState()
    store.offerStall(stall)
    store.offerStall({ ...stall, sessionID: "ses_2", directory: "/other" })
    store.clearDirectory("/workspace")

    expect(useProviderStallStore.getState().stallsBySessionId.ses_1).toBe(undefined)
    expect(Boolean(useProviderStallStore.getState().stallsBySessionId.ses_2)).toBe(true)
  })
})
