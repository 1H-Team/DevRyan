import { describe, expect, test } from "bun:test"
import {
  beginCommittedRevertResend,
  clearCommittedRevertResendsForSessions,
  endCommittedRevertResend,
  isCommittedRevertResendInFlight,
  isMessageHiddenByAnyActiveRevert,
} from "./revert-transactions"

describe("committed revert resend ownership", () => {
  test("clears only resend markers owned by released sessions", () => {
    beginCommittedRevertResend("session-a", "message-a")
    beginCommittedRevertResend("session-b", "message-b")

    clearCommittedRevertResendsForSessions(["session-a"])

    expect(isCommittedRevertResendInFlight("session-a", "message-a")).toBe(false)
    expect(isCommittedRevertResendInFlight("session-b", "message-b")).toBe(true)
    endCommittedRevertResend("session-b", "message-b")
  })
})

describe("active revert message hiding", () => {
  test("uses ReadonlySet membership for large hidden suffixes", () => {
    const hiddenMessageIDs = new Set(
      Array.from({ length: 50_000 }, (_, index) => `message-${String(index).padStart(5, "0")}`),
    )

    expect(isMessageHiddenByAnyActiveRevert({
      session: [],
      revert_transaction: {
        "session-a": {
          messageID: "message-00000",
          hiddenMessageIDs,
          version: 1,
          status: "pending",
          startedAt: 1,
        },
      },
    }, "message-49999")).toBe(true)
  })
})
