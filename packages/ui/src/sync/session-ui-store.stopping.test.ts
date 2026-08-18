import { describe, expect, test, beforeEach } from "bun:test"
import { useSessionUIStore } from "./session-ui-store"

describe("optimistic stopping state", () => {
  beforeEach(() => {
    useSessionUIStore.setState({ stoppingSessions: new Map() })
  })

  test("markSessionStopping records the session with a timestamp", () => {
    useSessionUIStore.getState().markSessionStopping("session-a")
    const entry = useSessionUIStore.getState().stoppingSessions.get("session-a")
    expect(typeof entry).toBe("number")
  })

  test("marking an already-stopping session keeps the original timestamp and Map identity", () => {
    useSessionUIStore.getState().markSessionStopping("session-a")
    const before = useSessionUIStore.getState().stoppingSessions
    const timestamp = before.get("session-a")
    useSessionUIStore.getState().markSessionStopping("session-a")
    const after = useSessionUIStore.getState().stoppingSessions
    expect(after).toBe(before)
    expect(after.get("session-a")).toBe(timestamp as number)
  })

  test("clearSessionStopping removes only the target session with a new Map identity", () => {
    useSessionUIStore.getState().markSessionStopping("session-a")
    useSessionUIStore.getState().markSessionStopping("session-b")
    const before = useSessionUIStore.getState().stoppingSessions
    useSessionUIStore.getState().clearSessionStopping("session-a")
    const after = useSessionUIStore.getState().stoppingSessions
    expect(after).not.toBe(before)
    expect(after.has("session-a")).toBe(false)
    expect(after.has("session-b")).toBe(true)
  })

  test("clearing a session that is not stopping is a no-op", () => {
    const before = useSessionUIStore.getState().stoppingSessions
    useSessionUIStore.getState().clearSessionStopping("session-a")
    expect(useSessionUIStore.getState().stoppingSessions).toBe(before)
  })
})
