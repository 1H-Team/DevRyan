import { beforeEach, describe, expect, test } from "bun:test"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import { appendNotification, markSessionViewed, markSessionsViewed, useNotificationStore } from "./notification-store"

const COMPLETION_NOTIFICATION_STORAGE_KEY = "openchamber:notification-completions:v1"

function resetNotificationStore() {
  useNotificationStore.setState({
    list: [],
    index: {
      session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
      project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
    },
  })
}

describe("notification-store", () => {
  beforeEach(() => {
    resetNotificationStore()
    getSafeStorage().removeItem(COMPLETION_NOTIFICATION_STORAGE_KEY)
  })

  test("indexes unviewed turn-complete notifications as session completion", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: Date.now(),
      viewed: false,
    })

    const state = useNotificationStore.getState()
    expect(state.sessionUnseenCount("ses_1")).toBe(1)
    expect(state.sessionHasCompletion("ses_1")).toBe(true)
    expect(state.sessionHasError("ses_1")).toBe(false)
  })

  test("does not mark errors as completion", () => {
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_1",
      time: Date.now(),
      viewed: false,
      error: { message: "failed" },
    })

    const state = useNotificationStore.getState()
    expect(state.sessionUnseenCount("ses_1")).toBe(1)
    expect(state.sessionHasCompletion("ses_1")).toBe(false)
    expect(state.sessionHasError("ses_1")).toBe(true)
  })

  test("clears completion state when a session is viewed", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: Date.now(),
      viewed: false,
    })

    markSessionViewed("ses_1")

    const state = useNotificationStore.getState()
    expect(state.sessionUnseenCount("ses_1")).toBe(0)
    expect(state.sessionHasCompletion("ses_1")).toBe(false)
    expect(state.sessionHasError("ses_1")).toBe(false)
  })

  test("clears completion state for multiple viewed sessions", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "parent",
      time: Date.now(),
      viewed: false,
    })
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "child",
      time: Date.now(),
      viewed: false,
    })
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "unrelated",
      time: Date.now(),
      viewed: false,
    })

    markSessionsViewed(["parent", "child", "child"])

    const state = useNotificationStore.getState()
    expect(state.sessionUnseenCount("parent")).toBe(0)
    expect(state.sessionHasCompletion("parent")).toBe(false)
    expect(state.sessionUnseenCount("child")).toBe(0)
    expect(state.sessionHasCompletion("child")).toBe(false)
    expect(state.sessionUnseenCount("unrelated")).toBe(1)
    expect(state.sessionHasCompletion("unrelated")).toBe(true)
  })

  test("deduplicates keyed turn-complete notifications", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      messageId: "msg_assistant",
      time: Date.now(),
      viewed: false,
    })
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      messageId: "msg_assistant",
      time: Date.now() + 1,
      viewed: false,
    })

    const state = useNotificationStore.getState()
    expect(state.list).toHaveLength(1)
    expect(state.sessionUnseenCount("ses_1")).toBe(1)
    expect(state.sessionHasCompletion("ses_1")).toBe(true)
  })

  test("bulk viewed no-ops when listed sessions have no unseen notifications", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "unrelated",
      time: Date.now(),
      viewed: false,
    })

    const before = useNotificationStore.getState()
    markSessionsViewed(["parent", "child"])
    const after = useNotificationStore.getState()

    expect(after.list).toBe(before.list)
    expect(after.index).toBe(before.index)
    expect(after.sessionUnseenCount("unrelated")).toBe(1)
  })

  test("persists only bounded completion read state for reload restoration", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      messageId: "msg_assistant",
      time: Date.now(),
      viewed: false,
    })
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_1",
      messageId: "msg_error",
      time: Date.now(),
      viewed: false,
      error: { message: "provider details must not be persisted here" },
    })

    const persistedBeforeRead = JSON.parse(
      getSafeStorage().getItem(COMPLETION_NOTIFICATION_STORAGE_KEY) ?? "[]",
    ) as Array<Record<string, unknown>>
    expect(persistedBeforeRead).toHaveLength(1)
    expect(persistedBeforeRead[0]?.type).toBe("turn-complete")
    expect(persistedBeforeRead[0]?.directory).toBe("/repo")
    expect(persistedBeforeRead[0]?.session).toBe("ses_1")
    expect(persistedBeforeRead[0]?.messageId).toBe("msg_assistant")
    expect(persistedBeforeRead[0]?.viewed).toBe(false)
    expect(JSON.stringify(persistedBeforeRead)).not.toContain("provider details")

    markSessionViewed("ses_1")

    const persistedAfterRead = JSON.parse(
      getSafeStorage().getItem(COMPLETION_NOTIFICATION_STORAGE_KEY) ?? "[]",
    ) as Array<Record<string, unknown>>
    expect(persistedAfterRead[0]?.viewed).toBe(true)
  })
})
