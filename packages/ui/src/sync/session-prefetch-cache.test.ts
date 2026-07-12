import { beforeEach, describe, expect, test } from "bun:test"
import {
  captureSessionPrefetchRevision,
  clearSessionPrefetchDirectory,
  getSessionPrefetch,
  getSessionPrefetchCacheSizesForTest,
  isSessionPrefetchCurrent,
  resetSessionPrefetchCacheForTest,
  runSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe("session prefetch directory disposal", () => {
  beforeEach(() => resetSessionPrefetchCacheForTest())

  test("clears cache, in-flight markers, and revisions without stale repopulation", async () => {
    const gate = deferred()
    const pending = runSessionPrefetch({
      directory: "/repo/a",
      sessionID: "session-a",
      task: async (revision) => {
        await gate.promise
        setSessionPrefetch({
          directory: "/repo/a",
          sessionID: "session-a",
          limit: 200,
          complete: true,
          revision,
        })
        return undefined
      },
    })
    setSessionPrefetch({
      directory: "/repo/b",
      sessionID: "session-b",
      limit: 200,
      complete: true,
    })

    expect(getSessionPrefetchCacheSizesForTest()).toEqual({ cache: 1, inflight: 1, revisions: 1 })
    clearSessionPrefetchDirectory("/repo/a")
    expect(getSessionPrefetchCacheSizesForTest()).toEqual({ cache: 1, inflight: 0, revisions: 0 })

    gate.resolve()
    await pending
    expect(getSessionPrefetch("/repo/a", "session-a")).toBe(undefined)
    expect(getSessionPrefetch("/repo/b", "session-b")?.complete).toBe(true)
    expect(getSessionPrefetchCacheSizesForTest()).toEqual({ cache: 1, inflight: 0, revisions: 0 })
  })

  test("removes completed revision bookkeeping", async () => {
    await runSessionPrefetch({
      directory: "/repo/a",
      sessionID: "session-a",
      task: async (revision) => {
        expect(isSessionPrefetchCurrent("/repo/a", "session-a", revision)).toBe(true)
        return undefined
      },
    })

    expect(getSessionPrefetchCacheSizesForTest()).toEqual({ cache: 0, inflight: 0, revisions: 0 })
  })

  test("invalidates a captured revision across directory disposal", () => {
    const revision = captureSessionPrefetchRevision("/repo/a", "session-a")
    expect(isSessionPrefetchCurrent("/repo/a", "session-a", revision)).toBe(true)
    clearSessionPrefetchDirectory("/repo/a")
    expect(isSessionPrefetchCurrent("/repo/a", "session-a", revision)).toBe(false)
  })

  test("returns all retained counts to zero after 100 directory cycles", () => {
    for (let index = 0; index < 100; index += 1) {
      const directory = `/repo/cycle-${index}`
      setSessionPrefetch({ directory, sessionID: `session-${index}`, limit: 200, complete: true })
      clearSessionPrefetchDirectory(directory)
    }

    expect(getSessionPrefetchCacheSizesForTest()).toEqual({ cache: 0, inflight: 0, revisions: 0 })
  })
})
