import { afterEach, describe, expect, test } from "bun:test"
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

// The resend markers are one module-level Set: every test below clears the
// sessions it used, so no test depends on another's order.
const RESEND_SESSIONS = ["rs-a", "rs-b", "rs", "rs_1", "rs-c", "rs\0x", "rs-d"]

describe("committed revert resend markers", () => {
  afterEach(() => {
    clearCommittedRevertResendsForSessions(RESEND_SESSIONS)
  })

  test("a begun resend is in flight until it ends, for that session and message only", () => {
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(false)
    beginCommittedRevertResend("rs-a", "m-1")
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(true)
    expect(isCommittedRevertResendInFlight("rs-a", "m-2")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs-b", "m-1")).toBe(false)
    endCommittedRevertResend("rs-a", "m-1")
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(false)
  })

  test("beginning the same resend twice needs only one end", () => {
    beginCommittedRevertResend("rs-a", "m-1")
    beginCommittedRevertResend("rs-a", "m-1")
    endCommittedRevertResend("rs-a", "m-1")
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(false)
  })

  test("ending a resend that was never begun, or another message's, changes nothing", () => {
    beginCommittedRevertResend("rs-a", "m-1")
    endCommittedRevertResend("rs-a", "m-2")
    endCommittedRevertResend("rs-b", "m-1")
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(true)
  })

  // Begin and end have their own empty-id guards, but no export can see a key with an empty
  // id (lookup refuses it first), so those two guards are covered only through the lookup.
  test("never reports a resend with an empty session id or a missing or empty message id as in flight, and an end with such ids leaves a real resend in flight", () => {
    beginCommittedRevertResend("", "m-1")
    beginCommittedRevertResend("rs-a", undefined)
    beginCommittedRevertResend("rs-a", "")
    expect(isCommittedRevertResendInFlight("", "m-1")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs-a", undefined)).toBe(false)
    expect(isCommittedRevertResendInFlight("rs-a", "")).toBe(false)

    beginCommittedRevertResend("rs-a", "m-1")
    endCommittedRevertResend("rs-a", undefined)
    endCommittedRevertResend("rs-a", "")
    endCommittedRevertResend("", "m-1")
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(true)
  })

  test("clearing a session removes all of its resends and none of a session whose id it prefixes", () => {
    beginCommittedRevertResend("rs", "m-1")
    beginCommittedRevertResend("rs", "m-2")
    beginCommittedRevertResend("rs_1", "m-1")
    beginCommittedRevertResend("rs-c", "m-1")

    clearCommittedRevertResendsForSessions(["rs"])

    expect(isCommittedRevertResendInFlight("rs", "m-1")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs", "m-2")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs_1", "m-1")).toBe(true)
    expect(isCommittedRevertResendInFlight("rs-c", "m-1")).toBe(true)
  })

  test("clearing takes any iterable, skips empty ids, and clears several sessions at once", () => {
    beginCommittedRevertResend("rs-a", "m-1")
    beginCommittedRevertResend("rs-b", "m-1")
    beginCommittedRevertResend("rs-c", "m-1")
    function* ids() {
      yield ""
      yield "rs-a"
      yield "rs-b"
    }

    clearCommittedRevertResendsForSessions(ids())

    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs-b", "m-1")).toBe(false)
    expect(isCommittedRevertResendInFlight("rs-c", "m-1")).toBe(true)
    clearCommittedRevertResendsForSessions(new Set(["rs-c"]))
    expect(isCommittedRevertResendInFlight("rs-c", "m-1")).toBe(false)
  })

  test("a message id holding the key separator collides with a session id holding it, so both read as in flight", () => {
    // Key = session + NUL + message: ("rs", "x\0m") and ("rs\0x", "m") share one key.
    beginCommittedRevertResend("rs", "x\0m")
    expect(isCommittedRevertResendInFlight("rs", "x\0m")).toBe(true)
    expect(isCommittedRevertResendInFlight("rs\0x", "m")).toBe(true)
  })

  test("clearing a session whose id holds the key separator also clears another session's resend that shares the prefix", () => {
    beginCommittedRevertResend("rs", "x\0m")
    clearCommittedRevertResendsForSessions(["rs\0x"])
    expect(isCommittedRevertResendInFlight("rs", "x\0m")).toBe(false)
  })

  test("clearing a session leaves another session's resend in flight and does not stop the cleared session from beginning a new one", () => {
    beginCommittedRevertResend("rs-d", "m-1")
    clearCommittedRevertResendsForSessions(["rs-a"])
    beginCommittedRevertResend("rs-a", "m-1")
    expect(isCommittedRevertResendInFlight("rs-d", "m-1")).toBe(true)
    expect(isCommittedRevertResendInFlight("rs-a", "m-1")).toBe(true)
  })
})
