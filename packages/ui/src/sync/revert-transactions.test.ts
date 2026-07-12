import { describe, expect, test } from "bun:test"
import {
  beginCommittedRevertResend,
  clearCommittedRevertResendsForSessions,
  endCommittedRevertResend,
  isCommittedRevertResendInFlight,
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
