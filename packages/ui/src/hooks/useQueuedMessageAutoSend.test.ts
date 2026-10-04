import { describe, expect, test } from "bun:test"
import {
  resolveQueuedAutoSendStatusType,
  resolveQueuedSessionStatusType,
  shouldDispatchQueuedSession,
  resolveQueuedSessionScopeIds,
  resolveQueuedSubtreeStatusType,
} from "./queuedMessageAutoSendStatus"

describe("queued message auto-send status resolution", () => {
  test("uses aggregated live status for sessions outside the current directory", () => {
    expect(resolveQueuedSessionStatusType("session-b", {
      "session-a": { type: "busy" },
      "session-b": { type: "idle" },
    })).toBe("idle")
  })

  test("does not default a known busy session to idle when current-directory status is missing", () => {
    expect(resolveQueuedSessionStatusType("session-b", {
      "session-b": { type: "busy" },
    })).toBe("busy")
  })

  test("keeps a queued session unknown until any live status source has observed it", () => {
    expect(resolveQueuedSessionStatusType("session-b", {})).toBe("unknown")
    expect(resolveQueuedAutoSendStatusType("session-b", {}, undefined)).toBe("unknown")
  })

  test("unknown and malformed child statuses never authorize a loaded subtree", () => {
    const sessions = [{ id: 'root' }, { id: 'child', parentID: 'root' }, { id: 'leaf', parentID: 'child' }, { id: 'other' }]
    const scope = resolveQueuedSessionScopeIds('root', sessions)
    expect(scope).toEqual(['child', 'leaf', 'root'])
    expect(resolveQueuedSessionScopeIds('missing', sessions)).toBeNull()
    expect(resolveQueuedSessionScopeIds('child', sessions)).toEqual(['child'])
    const read = () => undefined
    const blockers = () => 0
    const idle = { root: { type: 'idle' }, child: { type: 'idle' }, leaf: { type: 'idle' } }
    expect(resolveQueuedSubtreeStatusType(scope, { ...idle, leaf: undefined }, read, blockers)).toBe('unknown')
    expect(resolveQueuedSubtreeStatusType(scope, { ...idle, leaf: { type: 'unavailable' } }, read, blockers)).toBe('unknown')
    expect(resolveQueuedSubtreeStatusType(scope, idle, () => ({ type: 4 }), blockers)).toBe('unknown')
    expect(resolveQueuedSubtreeStatusType(scope, idle, read, id => id === 'leaf' ? 1 : 0)).toBe('blocked')
    expect(resolveQueuedSubtreeStatusType(scope, { ...idle, other: { type: 'busy' } }, read, blockers)).toBe('idle')
  })

  test("uses any-directory busy status before aggregated idle status", () => {
    expect(resolveQueuedAutoSendStatusType("session-a", {
      "session-a": { type: "idle" },
    }, { type: "busy" })).toBe("busy")
  })

  test("allows dispatch after the queued session transitions from busy to idle", () => {
    expect(resolveQueuedAutoSendStatusType("session-a", {
      "session-a": { type: "idle" },
    }, { type: "idle" })).toBe("idle")
  })

  test("treats pending blocking requests as blocked even when status is idle", () => {
    expect(resolveQueuedAutoSendStatusType("session-a", {
      "session-a": { type: "idle" },
    }, { type: "idle" }, 1)).toBe("blocked")
  })
})

describe("queued message auto-send dispatch edges", () => {
  test("retries one restored idle queue when the connection returns", () => {
    expect(shouldDispatchQueuedSession({
      queueLength: 1,
      currentStatus: "idle",
      previousStatus: "idle",
      isConnected: true,
      previousConnectionState: false,
    })).toBe(true)
  })

  test("does not retry again while the connection remains steadily connected", () => {
    expect(shouldDispatchQueuedSession({
      queueLength: 1,
      currentStatus: "idle",
      previousStatus: "idle",
      isConnected: true,
      previousConnectionState: true,
    })).toBe(false)
  })

  test("never dispatches while disconnected or blocked", () => {
    expect(shouldDispatchQueuedSession({
      queueLength: 1,
      currentStatus: "idle",
      previousStatus: "busy",
      isConnected: false,
      previousConnectionState: true,
    })).toBe(false)
    expect(shouldDispatchQueuedSession({
      queueLength: 1,
      currentStatus: "blocked",
      previousStatus: "blocked",
      isConnected: true,
      previousConnectionState: false,
    })).toBe(false)
  })
})
