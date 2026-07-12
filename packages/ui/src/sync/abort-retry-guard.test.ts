import { beforeEach, describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import {
  ABORT_GUARD_MAX_REABORTS,
  ABORT_GUARD_REABORT_DEBOUNCE_MS,
  ABORT_GUARD_TTL_MS,
  clearAbortGuard,
  clearAbortGuards,
  filterSessionStatusThroughAbortGuard,
  isAbortGuardActive,
  registerManualAbortGuard,
  resetAbortGuardState,
  setAbortGuardExecutor,
  waitForAbortGuardSettlement,
} from "./abort-retry-guard"

const retryStatus = { type: "retry", attempt: 2, message: "out of usage", next: 5000 } as SessionStatus
const busyStatus = { type: "busy" } as SessionStatus
const idleStatus = { type: "idle" } as SessionStatus

const flushDeferred = () => new Promise((resolve) => setTimeout(resolve, 1))

beforeEach(() => {
  resetAbortGuardState()
  setAbortGuardExecutor(null)
})

describe("filterSessionStatusThroughAbortGuard", () => {
  test("passes statuses through when no guard is registered", () => {
    expect(filterSessionStatusThroughAbortGuard("ses_1", retryStatus)).toBe(retryStatus)
    expect(filterSessionStatusThroughAbortGuard("ses_1", busyStatus)).toBe(busyStatus)
  })

  test("coerces retry to idle while guard is active", () => {
    registerManualAbortGuard("ses_1", "/dir")

    expect(filterSessionStatusThroughAbortGuard("ses_1", retryStatus)).toEqual({ type: "idle" })
    expect(isAbortGuardActive("ses_1")).toBe(true)
  })

  test("does not affect other sessions", () => {
    registerManualAbortGuard("ses_1")

    expect(filterSessionStatusThroughAbortGuard("ses_2", retryStatus)).toBe(retryStatus)
  })

  test("passes busy through unchanged while guard is active", () => {
    registerManualAbortGuard("ses_1")

    expect(filterSessionStatusThroughAbortGuard("ses_1", busyStatus)).toBe(busyStatus)
  })

  test("schedules a re-abort when retry arrives while guard is active", async () => {
    const calls: Array<{ sessionId: string; directory?: string }> = []
    setAbortGuardExecutor(async (sessionId, directory) => {
      calls.push({ sessionId, directory })
    })
    registerManualAbortGuard("ses_1", "/dir")

    filterSessionStatusThroughAbortGuard("ses_1", retryStatus)
    await flushDeferred()

    expect(calls).toEqual([{ sessionId: "ses_1", directory: "/dir" }])
  })

  test("debounces re-aborts and caps total attempts", async () => {
    let callCount = 0
    setAbortGuardExecutor(async () => {
      callCount += 1
    })
    registerManualAbortGuard("ses_1")

    const base = Date.now()
    // Two events inside the debounce window → one re-abort
    filterSessionStatusThroughAbortGuard("ses_1", retryStatus, base)
    filterSessionStatusThroughAbortGuard("ses_1", retryStatus, base + 1)
    // Spaced events past the debounce window, beyond the cap
    for (let i = 1; i <= ABORT_GUARD_MAX_REABORTS + 2; i += 1) {
      filterSessionStatusThroughAbortGuard("ses_1", retryStatus, base + i * (ABORT_GUARD_REABORT_DEBOUNCE_MS + 1))
    }
    await flushDeferred()

    expect(callCount).toBe(ABORT_GUARD_MAX_REABORTS)
  })

  test("idle clears the guard so later retry statuses are authoritative", () => {
    registerManualAbortGuard("ses_1")

    expect(filterSessionStatusThroughAbortGuard("ses_1", idleStatus)).toBe(idleStatus)
    expect(isAbortGuardActive("ses_1")).toBe(false)
    expect(filterSessionStatusThroughAbortGuard("ses_1", retryStatus)).toBe(retryStatus)
  })

  test("manual recovery waits until the authoritative retry loop settles", async () => {
    registerManualAbortGuard("ses_wait")
    const waiting = waitForAbortGuardSettlement("ses_wait", { timeoutMs: 100, pollMs: 1 })
    setTimeout(() => clearAbortGuard("ses_wait"), 2)

    await waiting
    expect(isAbortGuardActive("ses_wait")).toBe(false)
  })

  test("clearAbortGuard restores authoritative statuses (new local send)", () => {
    registerManualAbortGuard("ses_1")
    clearAbortGuard("ses_1")

    expect(filterSessionStatusThroughAbortGuard("ses_1", retryStatus)).toBe(retryStatus)
  })

  test("clears retained guards for disposed session ownership", () => {
    registerManualAbortGuard("ses_1", "/dir")
    registerManualAbortGuard("ses_2", "/other")

    clearAbortGuards(["ses_1"])

    expect(isAbortGuardActive("ses_1")).toBe(false)
    expect(isAbortGuardActive("ses_2")).toBe(true)
  })

  test("guard expires after TTL so live state wins again", () => {
    registerManualAbortGuard("ses_1")

    const afterTtl = Date.now() + ABORT_GUARD_TTL_MS + 1
    expect(filterSessionStatusThroughAbortGuard("ses_1", retryStatus, afterTtl)).toBe(retryStatus)
    expect(isAbortGuardActive("ses_1")).toBe(false)
  })

  test("skips deferred re-abort when guard cleared before the timer fires", async () => {
    let callCount = 0
    setAbortGuardExecutor(async () => {
      callCount += 1
    })
    registerManualAbortGuard("ses_1")

    filterSessionStatusThroughAbortGuard("ses_1", retryStatus)
    clearAbortGuard("ses_1")
    await flushDeferred()

    expect(callCount).toBe(0)
  })

  test("re-registering after a re-abort resets the budget", async () => {
    let callCount = 0
    setAbortGuardExecutor(async () => {
      callCount += 1
    })

    const base = Date.now()
    registerManualAbortGuard("ses_1")
    for (let i = 0; i <= ABORT_GUARD_MAX_REABORTS; i += 1) {
      filterSessionStatusThroughAbortGuard("ses_1", retryStatus, base + i * (ABORT_GUARD_REABORT_DEBOUNCE_MS + 1))
    }
    await flushDeferred()
    expect(callCount).toBe(ABORT_GUARD_MAX_REABORTS)

    registerManualAbortGuard("ses_1")
    filterSessionStatusThroughAbortGuard("ses_1", retryStatus, base + 10 * (ABORT_GUARD_REABORT_DEBOUNCE_MS + 1))
    await flushDeferred()

    expect(callCount).toBe(ABORT_GUARD_MAX_REABORTS + 1)
  })
})
