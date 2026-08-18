import { beforeEach, describe, expect, test } from "bun:test"

import { useLongRunningToolStore } from "./useLongRunningToolStore"

const observation = {
  kind: "long-running-tool",
  sessionID: "ses_1",
  directory: "/workspace",
  assistantMessageID: "msg_assistant",
  anchorUserMessageID: "msg_user",
  partID: "part_tool",
  callID: "call_tool",
  tool: "ctx_execute",
  observedAt: 1_000,
  lastActivityAt: 1_000,
} as const

beforeEach(() => useLongRunningToolStore.getState().reset())

describe("long-running tool store", () => {
  test("preserves first observation and resets confirmation on real progress", () => {
    const store = useLongRunningToolStore.getState()
    store.observeTool(observation)
    expect(store.confirmTool(observation, 301_000)).toBe(true)
    expect(store.confirmTool(observation, 302_000)).toBe(false)

    store.observeTool({ ...observation, observedAt: 2_000, lastActivityAt: 310_000 })

    expect(useLongRunningToolStore.getState().recordsBySessionId.ses_1).toEqual({
      ...observation,
      lastActivityAt: 310_000,
      confirmedAt: null,
      diagnosticMarkedAt: 301_000,
      pending: false,
      actionError: null,
    })

    expect(store.confirmTool({
      ...observation,
      lastActivityAt: 310_000,
    }, 611_000)).toBe(false)
    expect(useLongRunningToolStore.getState().recordsBySessionId.ses_1?.confirmedAt).toBe(611_000)
  })

  test("does not let an old action clear a replacement call", () => {
    const store = useLongRunningToolStore.getState()
    store.observeTool(observation)
    store.observeTool({
      ...observation,
      partID: "part_new",
      callID: "call_new",
      observedAt: 2_000,
      lastActivityAt: 2_000,
    })
    store.clearTool(observation.sessionID, observation)

    expect(useLongRunningToolStore.getState().recordsBySessionId.ses_1?.callID).toBe("call_new")
  })

  test("clears only records owned by a disposed directory", () => {
    const store = useLongRunningToolStore.getState()
    store.observeTool(observation)
    store.observeTool({ ...observation, sessionID: "ses_2", directory: "/other" })
    store.clearDirectory("/workspace")

    expect(useLongRunningToolStore.getState().recordsBySessionId.ses_1).toBe(undefined)
    expect(Boolean(useLongRunningToolStore.getState().recordsBySessionId.ses_2)).toBe(true)
  })
})
