import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_SESSION_MESSAGE_PAGINATION,
  clearSessionMessagePagination,
  clearSessionMessagePaginationDirectory,
  getSessionMessagePagination,
  getSessionMessagePaginationStoreForTest,
  isSessionMessageLoadCurrent,
  resetSessionMessagePaginationStoreForTest,
  runSessionMessageLoad,
  setSessionMessagePagination,
} from "./message-pagination-store"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe("shared session message pagination", () => {
  beforeEach(() => resetSessionMessagePaginationStoreForTest())

  test("preserves a session leaf for no-op and unrelated updates", () => {
    const first = setSessionMessagePagination("/repo/a/", "session-a", {
      initialized: true,
      cursor: "older-a",
    })
    const noOp = setSessionMessagePagination("/repo/a", "session-a", {
      initialized: true,
      cursor: "older-a",
    })
    setSessionMessagePagination("/repo/a", "session-b", { loading: true })

    expect(noOp).toBe(first)
    expect(getSessionMessagePagination("/repo/a", "session-a")).toBe(first)
  })

  test("coalesces concurrent loads for the same directory and session", async () => {
    const gate = deferred()
    let calls = 0
    const start = () => runSessionMessageLoad({
      directory: "/repo/a",
      sessionID: "session-a",
      task: async (token) => {
        calls += 1
        expect(isSessionMessageLoadCurrent("/repo/a", "session-a", token)).toBe(true)
        await gate.promise
        return true
      },
    })

    const first = start()
    const second = start()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(calls).toBe(1)

    gate.resolve()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  test("session cleanup invalidates a late load without touching siblings", async () => {
    const gate = deferred()
    let capturedToken = 0
    const pending = runSessionMessageLoad({
      directory: "/repo/a",
      sessionID: "session-a",
      task: async (token) => {
        capturedToken = token
        await gate.promise
        return isSessionMessageLoadCurrent("/repo/a", "session-a", token)
      },
    })
    setSessionMessagePagination("/repo/a", "session-a", { loading: true })
    const sibling = setSessionMessagePagination("/repo/a", "session-b", { initialized: true })
    await Promise.resolve()

    clearSessionMessagePagination("/repo/a", ["session-a"])
    expect(isSessionMessageLoadCurrent("/repo/a", "session-a", capturedToken)).toBe(false)
    expect(getSessionMessagePagination("/repo/a", "session-a")).toBe(DEFAULT_SESSION_MESSAGE_PAGINATION)
    expect(getSessionMessagePagination("/repo/a", "session-b")).toBe(sibling)

    gate.resolve()
    expect(await pending).toBe(false)
  })

  test("directory cleanup releases only that directory", () => {
    setSessionMessagePagination("/repo/a", "session-a", { initialized: true })
    const retained = setSessionMessagePagination("/repo/b", "session-b", { initialized: true })

    clearSessionMessagePaginationDirectory("/repo/a/")

    expect(getSessionMessagePagination("/repo/a", "session-a")).toBe(DEFAULT_SESSION_MESSAGE_PAGINATION)
    expect(getSessionMessagePagination("/repo/b", "session-b")).toBe(retained)
    expect(getSessionMessagePaginationStoreForTest().getState().byKey.size).toBe(1)
  })
})
