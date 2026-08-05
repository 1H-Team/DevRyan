import { describe, expect, test } from "bun:test"
import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { getManagedTaskRecoveryRootForIdleEvent } from "./sync-context"

const sessionStatusEvent = (sessionID: string, status: SessionStatus): Event => ({
  id: `evt_${sessionID}_${status.type}`,
  type: "session.status",
  properties: { sessionID, status },
}) as Event

describe("managed orchestration idle recovery", () => {
  test("refreshes an active root when its authoritative status becomes idle", () => {
    expect(getManagedTaskRecoveryRootForIdleEvent(
      sessionStatusEvent("ses_root", { type: "idle" } as SessionStatus),
      (rootSessionId) => rootSessionId === "ses_root",
    )).toBe("ses_root")
  })

  test("accepts the canonical session.idle event", () => {
    expect(getManagedTaskRecoveryRootForIdleEvent({
      id: "evt_idle",
      type: "session.idle",
      properties: { sessionID: "ses_root" },
    } as Event, () => true)).toBe("ses_root")
  })

  test("does not refresh busy roots or roots without active managed work", () => {
    expect(getManagedTaskRecoveryRootForIdleEvent(
      sessionStatusEvent("ses_root", { type: "busy" } as SessionStatus),
      () => true,
    )).toBeNull()
    expect(getManagedTaskRecoveryRootForIdleEvent(
      sessionStatusEvent("ses_root", { type: "idle" } as SessionStatus),
      () => false,
    )).toBeNull()
  })
})
