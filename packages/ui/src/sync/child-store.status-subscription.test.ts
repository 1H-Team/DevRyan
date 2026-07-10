import { describe, expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"

describe("ChildStoreManager status subscriptions", () => {
  test("notifies for session status changes but not unrelated streaming state", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/test/project", { bootstrap: false })
    let notifications = 0
    const unsubscribe = childStores.subscribeSessionStatuses(() => {
      notifications += 1
    })

    store.setState({ sessionTotal: 1 })
    expect(notifications).toBe(0)

    store.setState({ session_status: { "session-a": { type: "busy" } } })
    expect(notifications).toBe(1)

    unsubscribe()
    store.setState({ session_status: { "session-a": { type: "idle" } } })
    expect(notifications).toBe(1)
  })
})
