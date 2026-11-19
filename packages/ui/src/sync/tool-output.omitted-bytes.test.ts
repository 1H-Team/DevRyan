import { describe, expect, test } from "bun:test"
import { getOmittedToolOutputBytes, type OmittedToolPart } from "./tool-output"

// `outputBytes` comes from the server; the fixture also carries values of the
// wrong type, which the SDK state type does not allow.
function omittedPart(outputBytes?: unknown): OmittedToolPart {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
      outputOmitted: true,
      ...(outputBytes === undefined ? {} : { outputBytes }),
    },
  } as unknown as OmittedToolPart
}

describe("getOmittedToolOutputBytes", () => {
  test("returns a finite non-negative byte count as it is", () => {
    expect(getOmittedToolOutputBytes(omittedPart(0))).toBe(0)
    expect(getOmittedToolOutputBytes(omittedPart(1))).toBe(1)
    expect(getOmittedToolOutputBytes(omittedPart(87_000_000))).toBe(87_000_000)
    expect(getOmittedToolOutputBytes(omittedPart(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(getOmittedToolOutputBytes(omittedPart(Number.MAX_VALUE))).toBe(Number.MAX_VALUE)
  })

  test("does not round a fractional count", () => {
    expect(getOmittedToolOutputBytes(omittedPart(1.5))).toBe(1.5)
    expect(getOmittedToolOutputBytes(omittedPart(Number.MIN_VALUE))).toBe(Number.MIN_VALUE)
  })

  test("keeps negative zero, which compares as not below zero", () => {
    expect(getOmittedToolOutputBytes(omittedPart(-0))).toBe(-0)
  })

  test("is undefined for a missing, negative, non-finite or non-number count", () => {
    expect(getOmittedToolOutputBytes(omittedPart())).toBeUndefined()
    for (const value of [-1, -Number.MIN_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "12", null, true, {}]) {
      expect(getOmittedToolOutputBytes(omittedPart(value))).toBeUndefined()
    }
  })
})
