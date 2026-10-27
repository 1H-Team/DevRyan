import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { ARCHIVED_OFFLOAD_TTL_MS, SessionHistory } from "./session-history"
import {
  clearSessionMaterializer,
  markArchived,
  markUnarchived,
  retireSessionHistory,
  setSessionMaterializer,
} from "./session-materializer"

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

const session = (id: string, directory: string): Session => ({
  id,
  directory,
  title: id,
  time: { created: 1, updated: 1 },
} as Session)

const message = (id: string, sessionID: string, role: "user" | "assistant" = "user", created = 1): Message => ({
  id,
  sessionID,
  role,
  time: { created },
} as Message)

const page = (messages: Message[], cursor?: string) => ({
  data: messages.map((info) => ({ info, parts: [] })),
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})

type MessagesRequest = { sessionID: string; limit: number; before?: string }
type Handlers = {
  get?: (input: { sessionID: string }) => Promise<unknown>
  messages?: (input: MessagesRequest) => Promise<unknown>
}

const owners: Array<{ stores: ChildStoreManager; loader: SessionMessageLoader; history: SessionHistory }> = []

function setup(handlers: Handlers = {}) {
  const stores = new ChildStoreManager()
  const loader = new SessionMessageLoader(stores)
  const sdk = {
    session: {
      get: handlers.get ?? (async ({ sessionID }: { sessionID: string }) => ({ data: session(sessionID, "/") })),
      messages: handlers.messages ?? (async ({ sessionID }: MessagesRequest) => page([message(`msg_${sessionID}`, sessionID)])),
    },
  } as unknown as OpencodeClient
  Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: () => sdk })
  const history = new SessionHistory({ childStores: stores, loader, getSdk: () => sdk })
  owners.push({ stores, loader, history })
  return { stores, loader, history }
}

// Captures the owner's timers so a test can fire them after a directory retires.
function captureTimers() {
  const pending = new Map<number, () => void>()
  let next = 0
  globalThis.setTimeout = ((callback: () => void) => {
    next += 1
    pending.set(next, callback)
    return next
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout
  return {
    get size() { return pending.size },
    fireAll() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
}

const settle = () => new Promise<void>((resolve) => originalSetTimeout(resolve, 0))

describe("SessionHistory", () => {
  beforeEach(() => {
    useFeatureFlagsStore.getState().setSessionFastLoadEnabled(true)
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    for (const { stores, loader, history } of owners.splice(0)) {
      history.dispose()
      loader.dispose()
      stores.disposeAll()
    }
    Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: originalGetScopedSdkClient })
  })

  test("uses a 20 minute archived offload TTL", () => {
    expect(ARCHIVED_OFFLOAD_TTL_MS).toBe(20 * 60 * 1000)
  })

  test("materializes a background directory with no mounted consumer", async () => {
    const { stores, history } = setup()
    const target = { directory: "/repo/background", sessionID: "ses_background" }

    await history.ensureFirstPage(target)

    expect(history.getMaterializationState(target).level).toBe("firstPageLoaded")
    expect(stores.getChild(target.directory)?.getState().message[target.sessionID]?.map((entry) => entry.id))
      .toEqual(["msg_ses_background"])
  })

  test("a failed first page is a materialization error, not a loaded page", async () => {
    const { history } = setup({ messages: async () => ({ error: { message: "bad request" }, response: { status: 400 } }) })
    const target = { directory: "/repo/failed", sessionID: "ses_failed" }

    await expect(history.ensureFirstPage(target)).rejects.toThrow("Failed to materialize session ses_failed")
    expect(history.getMaterializationState(target).level).toBe("error")
  })

  test("unarchive with no mounted rows materializes through the provider owner", async () => {
    const { stores, history } = setup()
    const target = { directory: "/repo/unarchive", sessionID: "ses_unarchive" }
    stores.ensureChild(target.directory, { bootstrap: false })
    setSessionMaterializer(history)
    try {
      markArchived(target.sessionID, target.directory)
      expect(history.getMaterializationState(target).archived).toBe(true)
      markUnarchived(target.sessionID, target.directory)
      await settle()
      await settle()
    } finally {
      clearSessionMaterializer(history)
    }

    expect(history.getMaterializationState(target)).toMatchObject({ level: "firstPageLoaded", archived: false })
    expect(history.getRetainedCountsForTest(target.directory).timers).toBe(1) // only the background trim
  })

  test("metadata completing after delete does not republish the session", async () => {
    let resolveGet!: (value: unknown) => void
    const { stores, loader, history } = setup({ get: () => new Promise((resolve) => { resolveGet = resolve }) })
    const target = { directory: "/repo/delete", sessionID: "ses_deleted" }
    const store = stores.ensureChild(target.directory, { bootstrap: false })
    setSessionMaterializer(history)

    const loading = history.ensureRenderable(target)
    // The live delete path: retire history ownership, invalidate the loader, drop membership.
    retireSessionHistory(target.sessionID, target.directory)
    loader.invalidateSession(target)
    store.setState({ session: store.getState().session.filter((entry) => entry.id !== target.sessionID) })
    clearSessionMaterializer(history)
    resolveGet({ data: session(target.sessionID, target.directory) })
    await loading

    expect(store.getState().session.map((entry) => entry.id)).toEqual([])
    expect(history.getRetainedCountsForTest(target.directory).metadata).toBe(0)
  })

  test("offload during paging drops the late older page and keeps the session summary", async () => {
    let resolveOlder!: (value: unknown) => void
    let olderRequested!: () => void
    const olderRequest = new Promise<void>((resolve) => { olderRequested = resolve })
    const target = { directory: "/repo/paging", sessionID: "ses_paging" }
    const firstPage = Array.from({ length: 50 }, (_, index) => message(`msg_${String(index + 100).padStart(4, "0")}`, target.sessionID, "user", index + 100))
    const { stores, history } = setup({
      get: async () => ({ data: session(target.sessionID, target.directory) }),
      messages: ({ before }) => {
        if (!before) return Promise.resolve(page(firstPage, "cursor-older"))
        olderRequested()
        return new Promise((resolve) => { resolveOlder = resolve })
      },
    })
    await history.ensureRenderable(target)
    const store = stores.getChild(target.directory)!
    expect(store.getState().message[target.sessionID]).toHaveLength(50)

    const paging = history.loadMore(target)
    await olderRequest
    history.offloadHistory(target)
    resolveOlder(page([message("msg_0001", target.sessionID, "user", 1)]))
    await paging

    expect(store.getState().message[target.sessionID]).toBeUndefined()
    expect(store.getState().session.map((entry) => entry.id)).toEqual([target.sessionID])
  })

  test("metadata completing after an offload does not overwrite the kept summary", async () => {
    let resolveGet!: (value: unknown) => void
    let requested!: () => void
    const request = new Promise<void>((resolve) => { requested = resolve })
    const target = { directory: "/repo/offload-metadata", sessionID: "ses_offloaded" }
    const { stores, history } = setup({ get: () => new Promise((resolve) => { resolveGet = resolve; requested() }) })
    const store = stores.ensureChild(target.directory, { bootstrap: false })
    const kept = { ...session(target.sessionID, target.directory), title: "Kept summary" }
    store.setState({ session: [kept] })

    const loading = history.ensureRenderable(target, { force: true })
    await request
    history.offloadHistory(target)
    resolveGet({ data: { ...kept, title: "Late metadata" } })
    await loading

    expect(store.getState().session[0]).toBe(kept)
  })

  test("offloading one session leaves unrelated session references unchanged", async () => {
    const { stores, history } = setup()
    const first = { directory: "/repo/references", sessionID: "ses_a" }
    const second = { directory: "/repo/references", sessionID: "ses_b" }
    await history.ensureRenderable(first)
    await history.ensureRenderable(second)
    const store = stores.getChild(first.directory)!
    const before = store.getState()
    const secondMessages = before.message[second.sessionID]
    const secondParts = before.part["msg_ses_b"]
    const secondSession = before.session.find((entry) => entry.id === second.sessionID)

    history.offloadHistory(first)

    const after = store.getState()
    expect(after.message[first.sessionID]).toBeUndefined()
    expect(after.message[second.sessionID]).toBe(secondMessages)
    expect(after.part["msg_ses_b"]).toBe(secondParts)
    expect(after.session.find((entry) => entry.id === second.sessionID)).toBe(secondSession)
  })

  test("archiving never arms state or timers for a retired directory", () => {
    const { stores, history } = setup()
    const target = { directory: "/repo/retired", sessionID: "ses_archived" }
    stores.ensureChild(target.directory, { bootstrap: false })
    history.markArchived(target)
    expect(history.getRetainedCountsForTest(target.directory)).toMatchObject({ states: 1, timers: 1 })

    stores.discardDirectory(target.directory)
    history.releaseDirectory(target.directory)
    history.markArchived(target)
    history.markUnarchived(target)
    history.offloadArchivedSessionNow(target)

    expect(history.getRetainedCountsForTest(target.directory)).toEqual({ seen: 0, metadata: 0, states: 0, timers: 0 })
    expect(stores.getChild(target.directory)).toBeUndefined()
  })

  test("timers firing after their directory retired neither recreate the store nor republish state", async () => {
    const { stores, history } = setup()
    const target = { directory: "/repo/late-timers", sessionID: "ses_late_timer" }
    await history.ensureRenderable(target)
    const timers = captureTimers()
    history.ensureRenderable(target).catch(() => undefined) // re-arms the background trim
    history.markArchived(target)
    expect(timers.size).toBe(2)

    stores.discardDirectory(target.directory)
    timers.fireAll()
    globalThis.setTimeout = originalSetTimeout
    await settle()

    expect(stores.getChild(target.directory)).toBeUndefined()
    expect(history.getMaterializationState(target).level).not.toBe("summaryOnly")
  })

  test("releases state and timers for only the disposed directory", async () => {
    const { stores, history } = setup()
    const first = { directory: "/release/a", sessionID: "ses_a" }
    const second = { directory: "/release/b", sessionID: "ses_b" }
    await history.ensureFirstPage(first)
    await history.ensureFirstPage(second)
    history.markArchived(first)
    history.markArchived(second)

    history.releaseDirectory(first.directory)

    expect(history.getRetainedCountsForTest(first.directory)).toEqual({ seen: 0, metadata: 0, states: 0, timers: 0 })
    expect(history.getRetainedCountsForTest(second.directory)).toMatchObject({ seen: 1, states: 1, timers: 2 })
    expect(stores.getChild(second.directory)).toBeDefined()
  })

  test("a late materialization completion does not recreate released state", async () => {
    let resolveMessages!: (value: unknown) => void
    let requested!: () => void
    const request = new Promise<void>((resolve) => { requested = resolve })
    const target = { directory: "/release/late", sessionID: "ses_late" }
    const { stores, history } = setup({ messages: () => new Promise((resolve) => { resolveMessages = resolve; requested() }) })

    const materializing = history.ensureFirstPage(target)
    await request
    stores.discardDirectory(target.directory)
    history.releaseDirectory(target.directory)
    resolveMessages(page([message("msg_late", target.sessionID)]))
    await materializing.catch(() => undefined)

    expect(history.getRetainedCountsForTest(target.directory)).toMatchObject({ metadata: 0, states: 0 })
    expect(stores.getChild(target.directory)).toBeUndefined()
  })
})
