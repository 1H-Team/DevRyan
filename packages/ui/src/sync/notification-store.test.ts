import { beforeEach, describe, expect, test } from "bun:test"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import { appendNotification, markSessionViewed, markSessionsViewed, reconcileSessionFailureNotifications, useNotificationStore } from "./notification-store"

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

  test("successful completion resolves captured older errors without changing history or read state", () => {
    const completedAt = Date.now()
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", directory: "/repo", time: completedAt - 10, viewed: false })
    const captured = useNotificationStore.getState().list
    store.append({ type: "error", session: "root", directory: "/repo", time: completedAt + 1, viewed: false })
    store.resolveErrors(captured, "msg_success", completedAt)
    const state = useNotificationStore.getState()
    expect(state.list).toHaveLength(2)
    expect(state.list[0]).toMatchObject({ viewed: false, resolvedByMessageId: "msg_success" })
    expect("resolvedByMessageId" in state.list[1]).toBe(false)
    expect(state.sessionUnseenCount("root")).toBe(2)
    expect(state.sessionHasError("root")).toBe(true)
    expect(state.projectHasError("/repo")).toBe(true)

    // A replay with a fresh capture still cannot clear the later error.
    store.resolveErrors(state.list, "msg_success", completedAt)
    expect(useNotificationStore.getState()).toBe(state)
  })

  test("resolved errors stop driving session and project red while remaining unread", () => {
    const completedAt = Date.now()
    useNotificationStore.getState().append({
      type: "error", session: "root", directory: "/repo", time: completedAt - 1, viewed: false,
    })
    const captured = useNotificationStore.getState().list
    useNotificationStore.getState().resolveErrors(captured, "msg_success", completedAt)
    const state = useNotificationStore.getState()
    expect(state.sessionHasError("root")).toBe(false)
    expect(state.projectHasError("/repo")).toBe(false)
    expect(state.sessionUnseenCount("root")).toBe(1)
    expect(state.list[0]?.viewed).toBe(false)
    state.resolveErrors(captured, "msg_success", completedAt)
    expect(useNotificationStore.getState()).toBe(state)
  })

  test("errors arriving during settlement and ambiguous timestamps are preserved", () => {
    const completedAt = Date.now()
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", time: completedAt, viewed: false })
    const captured = useNotificationStore.getState().list
    store.append({ type: "error", session: "root", time: completedAt - 1, viewed: false })
    store.resolveErrors(captured, "msg_success", completedAt)
    expect(useNotificationStore.getState().list.every((n) => n.type === "error" && !n.resolvedByMessageId)).toBe(true)
    for (const invalid of [NaN, Infinity, 0, -1]) {
      store.resolveErrors(useNotificationStore.getState().list, "msg_success", invalid)
      expect(useNotificationStore.getState().sessionHasError("root")).toBe(true)
    }
  })

  test("a later user prompt supersedes only older errors in its own session", () => {
    const createdAt = Date.now()
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", directory: "/repo", time: createdAt - 10, failedUserCreatedAt: createdAt - 10, viewed: false })
    store.append({ type: "error", session: "other", directory: "/repo", time: createdAt - 10, failedUserCreatedAt: createdAt - 10, viewed: false })
    store.append({ type: "error", session: "root", directory: "/repo", time: createdAt + 1, failedUserCreatedAt: createdAt + 1, viewed: false })
    store.supersedeSessionErrors("root", "msg_user", createdAt)
    const state = useNotificationStore.getState()
    expect(state.list[0]).toMatchObject({ resolvedByMessageId: "msg_user", viewed: false })
    expect("resolvedByMessageId" in state.list[1]).toBe(false)
    expect("resolvedByMessageId" in state.list[2]).toBe(false)
    expect(state.sessionHasError("root")).toBe(true)

    store.supersedeSessionErrors("root", "msg_user", createdAt)
    expect(useNotificationStore.getState()).toBe(state)
    store.supersedeSessionErrors("root", "msg_next", createdAt + 5)
    expect(useNotificationStore.getState().sessionHasError("root")).toBe(false)
    expect(useNotificationStore.getState().sessionHasError("other")).toBe(true)
  })

  test("canonical turn identity preserves current failures across renderer/server clock skew", () => {
    const now = Date.now()
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", time: now + 60_000, viewed: false,
      failedUserMessageId: "msg_old", failedUserCreatedAt: 10 })
    store.append({ type: "error", session: "root", time: now - 60_000, viewed: false,
      failedUserMessageId: "msg_retry", failedUserCreatedAt: 20 })
    store.supersedeSessionErrors("root", "msg_retry", 20)
    const state = useNotificationStore.getState()
    expect(state.list[0]).toMatchObject({ resolvedByMessageId: "msg_retry" })
    expect("resolvedByMessageId" in state.list[1]).toBe(false)
    store.supersedeSessionErrors("root", "msg_retry", 20)
    expect(useNotificationStore.getState()).toBe(state)
    expect(useNotificationStore.getState().list).toBe(state.list)
    expect(useNotificationStore.getState().index).toBe(state.index)
  })

  test("canonical Plan history supersedes a restored failure and a delayed correlated old error", () => {
    const now = Date.now()
    const store = useNotificationStore.getState()
    const failure = { type: "error" as const, session: "root", time: now, viewed: false,
      failedUserMessageId: "msg_old", failedUserCreatedAt: 10 }
    store.append(failure)
    const persisted = JSON.parse(getSafeStorage().getItem(COMPLETION_NOTIFICATION_STORAGE_KEY) ?? "[]")
    resetNotificationStore()
    useNotificationStore.getState().append(persisted[0])
    const retry = { id: "msg_retry", sessionID: "root", role: "user" as const, time: { created: 20 } }
    const parts = [{ id: "prt_plan", sessionID: "root", messageID: retry.id, type: "text" as const,
      text: "User has requested to enter plan mode.\nProduce an implementation plan only.", synthetic: true }]
    reconcileSessionFailureNotifications("root", [{ info: retry, parts }])
    expect(useNotificationStore.getState().sessionHasError("root")).toBe(false)
    store.append(failure)
    reconcileSessionFailureNotifications("root", [{ info: retry, parts }])
    expect(useNotificationStore.getState().list.every(n => n.type === "error" && n.resolvedByMessageId === retry.id)).toBe(true)
  })

  test("history resolves a legacy keyed failure but preserves uncorrelated notices", () => {
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", messageId: "msg_failed", time: Date.now(), viewed: false })
    store.append({ type: "error", session: "root", time: Date.now() - 60_000, viewed: false })
    reconcileSessionFailureNotifications("root", [
      { info: { id: "msg_failed", role: "assistant", sessionID: "root", time: { created: 10 } }, parts: [] },
      { info: { id: "msg_retry", role: "user", sessionID: "root", time: { created: 20 } }, parts: [] },
    ])
    expect(useNotificationStore.getState().list[0]).toMatchObject({ resolvedByMessageId: "msg_retry" })
    expect("resolvedByMessageId" in useNotificationStore.getState().list[1]).toBe(false)
  })

  test("canonical assistant parents supersede delayed older failures but preserve the retry's failure", () => {
    const store = useNotificationStore.getState()
    for (const messageId of ["msg_failed_old", "msg_failed_retry"]) {
      store.append({ type: "error", session: "root", messageId, time: Date.now(), viewed: false })
    }
    reconcileSessionFailureNotifications("root", [
      { info: { id: "msg_old", role: "user", sessionID: "root", time: { created: 10 } }, parts: [] },
      { info: { id: "msg_retry", role: "user", sessionID: "root", time: { created: 20 } }, parts: [] },
      { info: { id: "msg_failed_old", role: "assistant", parentID: "msg_old", sessionID: "root", time: { created: 30 } }, parts: [] },
      { info: { id: "msg_failed_retry", role: "assistant", parentID: "msg_retry", sessionID: "root", time: { created: 15 } }, parts: [] },
    ])
    expect(useNotificationStore.getState().list[0]).toMatchObject({ resolvedByMessageId: "msg_retry" })
    expect("resolvedByMessageId" in useNotificationStore.getState().list[1]).toBe(false)
  })

  test("missing parts and synthetic maintenance never supersede failures", () => {
    const now = Date.now()
    const store = useNotificationStore.getState()
    store.append({ type: "error", session: "root", time: now, viewed: false,
      failedUserMessageId: "msg_old", failedUserCreatedAt: 10 })
    const before = useNotificationStore.getState()
    for (const text of ["[devryan-provider-recovery:v1:task]\nContinue", "[devryan-open-todo-continuation:v1]\nContinue", "Synthetic internal prompt"]) {
      const info = { id: "msg_wake", sessionID: "root", role: "user" as const, time: { created: 20 } }
      reconcileSessionFailureNotifications("root", [{ info }])
      reconcileSessionFailureNotifications("root", [{ info, parts: [{ id: "prt_wake", sessionID: "root", messageID: info.id,
        type: "text" as const, text, synthetic: true }] }])
    }
    expect(useNotificationStore.getState()).toBe(before)
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

  test("persists bounded completion and sanitized failure state for reload restoration", () => {
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
    expect(persistedBeforeRead).toHaveLength(2)
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

  test("persists an expired provider sign-in as its stable code without provider text", () => {
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_signin",
      time: Date.now(),
      viewed: false,
      error: { name: "APIError", data: { message: "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate." } },
    })

    const persisted = JSON.parse(
      getSafeStorage().getItem(COMPLETION_NOTIFICATION_STORAGE_KEY) ?? "[]",
    ) as Array<{ error?: { code?: string; message?: string } }>
    expect(persisted[0]?.error?.code).toBe("provider_token_expired")
    expect(JSON.stringify(persisted)).not.toContain("claude login")
  })

  test("removes only a permanently deleted session from notification and persisted completion state", () => {
    const targetCompletion = {
      type: "turn-complete" as const,
      directory: "/repo",
      session: "deleted",
      messageId: "msg_deleted",
      time: Date.now(),
      viewed: false,
    }
    const unrelatedCompletion = {
      type: "turn-complete" as const,
      directory: "/repo",
      session: "retained",
      messageId: "msg_retained",
      time: Date.now() + 1,
      viewed: false,
    }
    appendNotification(targetCompletion)
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "deleted",
      time: Date.now() + 2,
      viewed: false,
      error: { message: "do not retain deleted-session errors" },
    })
    appendNotification(unrelatedCompletion)

    type NotificationStoreWithRemoval = ReturnType<typeof useNotificationStore.getState> & {
      removeSession?: (sessionId: string) => void
    }
    const removeSession = (useNotificationStore.getState() as NotificationStoreWithRemoval).removeSession
    expect(typeof removeSession).toBe("function")
    removeSession?.("deleted")

    const state = useNotificationStore.getState()
    expect(state.list).toEqual([unrelatedCompletion])
    expect(state.list[0]).toBe(unrelatedCompletion)
    expect(state.sessionUnseenCount("deleted")).toBe(0)
    expect(state.sessionHasCompletion("deleted")).toBe(false)
    expect(state.projectUnseenCount("/repo")).toBe(1)

    const persisted = JSON.parse(
      getSafeStorage().getItem(COMPLETION_NOTIFICATION_STORAGE_KEY) ?? "[]",
    ) as Array<Record<string, unknown>>
    expect(persisted.map((notification) => notification.session)).toEqual(["retained"])

    const beforeNoOp = useNotificationStore.getState()
    removeSession?.("missing")
    const afterNoOp = useNotificationStore.getState()
    expect(afterNoOp.list).toBe(beforeNoOp.list)
    expect(afterNoOp.index).toBe(beforeNoOp.index)
  })
})
