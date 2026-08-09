import { describe, expect, test } from "bun:test"
import {
  ChildStoreManager,
  getActiveDirectoryStoreKeys,
  getReconnectRecoveryDirectoryStoreKeys,
  shouldBootstrapDirectorySubscription,
} from "./child-store"

describe("ChildStoreManager status subscriptions", () => {
  test("grants bootstrap authority only to current-directory subscriptions", () => {
    expect(shouldBootstrapDirectorySubscription(undefined, "/repo/active")).toBe(true)
    expect(shouldBootstrapDirectorySubscription("/REPO/ACTIVE/", "/repo/active")).toBe(true)
    expect(shouldBootstrapDirectorySubscription("C:\\Work\\Repo", "c:/work/repo/")).toBe(true)
    expect(shouldBootstrapDirectorySubscription("/repo/inactive", "/repo/active")).toBe(false)
    expect(shouldBootstrapDirectorySubscription("/repo/inactive", "")).toBe(false)
  })

  test("selects only the normalized active directory for provider recovery", () => {
    const directories = ["/repo/inactive", "/REPO/ACTIVE/", "/repo/other"]

    expect(getActiveDirectoryStoreKeys(directories, "/repo/active")).toEqual(["/REPO/ACTIVE/"])
    expect(getActiveDirectoryStoreKeys(directories, "")).toEqual([])
  })

  test("recovers initialized background directories only while they still project active work", () => {
    const childStores = new ChildStoreManager()
    const active = childStores.ensureChild("/REPO/ACTIVE/", { bootstrap: false })
    const backgroundBusy = childStores.ensureChild("/repo/background-busy", { bootstrap: false })
    const backgroundRetry = childStores.ensureChild("/repo/background-retry", { bootstrap: false })
    const backgroundIdle = childStores.ensureChild("/repo/background-idle", { bootstrap: false })

    active.setState({ session_status: { active: { type: "idle" } } })
    backgroundBusy.setState({ session_status: { busy: { type: "busy" } } })
    backgroundRetry.setState({
      session_status: {
        retry: { type: "retry", attempt: 1, message: "retrying", next: 1 },
      },
    })
    backgroundIdle.setState({ session_status: { idle: { type: "idle" } } })

    expect(getReconnectRecoveryDirectoryStoreKeys(
      childStores.children.entries(),
      "/repo/active",
    )).toEqual([
      "/REPO/ACTIVE/",
      "/repo/background-busy",
      "/repo/background-retry",
    ])

    expect(getReconnectRecoveryDirectoryStoreKeys(
      childStores.children.entries(),
      "",
    )).toEqual([
      "/repo/background-busy",
      "/repo/background-retry",
    ])
  })

  test("notifies provider recovery for session status changes but not unrelated state", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/test/project", { bootstrap: false })
    let notifications = 0
    const unsubscribe = childStores.subscribeProviderRecoveryInputs(() => {
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

  test("notifies provider recovery for status and message-list changes but not part deltas", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/test/project", { bootstrap: false })
    let notifications = 0
    const unsubscribe = childStores.subscribeProviderRecoveryInputs(() => {
      notifications += 1
    })

    store.setState({ part: { "message-a": [] } })
    expect(notifications).toBe(0)

    store.setState({ message: { "session-a": [] } })
    expect(notifications).toBe(1)

    store.setState({ session_status: { "session-a": { type: "idle" } } })
    expect(notifications).toBe(2)

    unsubscribe()
  })

  test("notifies browser ownership only for session-list or directory-registry changes", () => {
    const childStores = new ChildStoreManager()
    const first = childStores.ensureChild("/test/project", { bootstrap: false })
    let notifications = 0
    const unsubscribe = childStores.subscribeSessionLists(() => {
      notifications += 1
    })

    first.setState({ part: { "message-a": [] } })
    first.setState({ session_status: { "session-a": { type: "busy" } } })
    expect(notifications).toBe(0)

    first.setState({ session: [...first.getState().session] })
    expect(notifications).toBe(1)

    childStores.ensureChild("/test/worktree", { bootstrap: false })
    expect(notifications).toBe(2)

    unsubscribe()
    first.setState({ session: [] })
    expect(notifications).toBe(2)
  })

  test("disposeDirectory runs every registered disposer and passes its snapshot once", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/test/dispose-one", { bootstrap: false })
    store.setState({ sessionTotal: 3 })
    const disposerCalls: string[] = []
    const disposedSnapshots: Array<{ directory: string; sessionTotal: number }> = []
    childStores.configure({
      onDispose: (directory, snapshot) => {
        disposedSnapshots.push({ directory, sessionTotal: snapshot.sessionTotal })
      },
    })
    childStores.registerDisposer("/test/dispose-one", () => disposerCalls.push("first"))
    childStores.registerDisposer("/test/dispose-one", () => disposerCalls.push("second"))

    expect(childStores.disposeDirectory("/test/dispose-one")).toBe(true)
    expect(childStores.disposeDirectory("/test/dispose-one")).toBe(false)
    expect(disposerCalls).toEqual(["first", "second"])
    expect(disposedSnapshots).toEqual([{ directory: "/test/dispose-one", sessionTotal: 3 }])
    expect(childStores.getChild("/test/dispose-one")).toBe(undefined)
  })

  test("disposeAll applies the same ownership callbacks once per directory", () => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/test/dispose-a", { bootstrap: false })
    childStores.ensureChild("/test/dispose-b", { bootstrap: false })
    childStores.pin("/test/dispose-a")
    const disposerCalls: string[] = []
    const disposedDirectories: string[] = []
    childStores.registerDisposer("/test/dispose-a", () => disposerCalls.push("a"))
    childStores.registerDisposer("/test/dispose-b", () => disposerCalls.push("b"))
    childStores.configure({
      onDispose: (directory) => disposedDirectories.push(directory),
    })

    childStores.disposeAll()
    childStores.disposeAll()

    expect(disposerCalls).toEqual(["a", "b"])
    expect(disposedDirectories).toEqual(["/test/dispose-a", "/test/dispose-b"])
    expect(childStores.children.size).toBe(0)
    expect(childStores.pinned("/test/dispose-a")).toBe(false)
  })

  test("explicit disposal preserves pinned, booting, loading, and blocking directories", () => {
    const childStores = new ChildStoreManager()
    const pinned = childStores.ensureChild("/test/pinned", { bootstrap: false })
    childStores.pin("/test/pinned")
    childStores.ensureChild("/test/booting", { bootstrap: false })
    childStores.ensureChild("/test/loading", { bootstrap: false })
    const blocking = childStores.ensureChild("/test/blocking", { bootstrap: false })
    blocking.setState({
      question: {
        session: [{ id: "question", sessionID: "session", questions: [] }],
      },
    })
    childStores.configure({
      isBooting: (directory) => directory === "/test/booting",
      isLoadingSessions: (directory) => directory === "/test/loading",
    })

    expect(childStores.disposeDirectory("/test/pinned")).toBe(false)
    expect(childStores.disposeDirectory("/test/booting")).toBe(false)
    expect(childStores.disposeDirectory("/test/loading")).toBe(false)
    expect(childStores.disposeDirectory("/test/blocking")).toBe(false)
    expect(pinned).toBe(childStores.getChild("/test/pinned"))
  })

  test("restarts bootstrap when an interrupted store remains partial", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/test/partial", { bootstrap: false })
    store.setState({ status: "partial" })
    const bootstrapped: string[] = []
    childStores.configure({
      onBootstrap: (directory) => bootstrapped.push(directory),
    })

    childStores.ensureChild("/test/partial")

    expect(bootstrapped).toEqual(["/test/partial"])
  })
})
