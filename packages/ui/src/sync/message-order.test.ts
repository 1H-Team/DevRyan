import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  compareMessagesChronologically,
  findMessageIndex,
  insertMessageChronologically,
  messagesBefore,
  messagesFrom,
  sortMessagesChronologically,
} from "./message-order"

const message = (id: string, created: unknown): Message => ({
  id,
  sessionID: "session-1",
  role: "user",
  time: { created },
} as Message)

describe("message chronology", () => {
  test("uses creation time before rollover-prone IDs", () => {
    const older = message("msg_fff", 10)
    const newer = message("msg_000", 20)
    expect(compareMessagesChronologically(older, newer)).toBeLessThan(0)
    expect(sortMessagesChronologically([newer, older])).toEqual([older, newer])
  })

  test("uses raw IDs only for equal timestamps", () => {
    const high = message("msg_fff", 10)
    const low = message("msg_000", 10)
    expect(sortMessagesChronologically([high, low])).toEqual([low, high])
  })

  test("treats invalid timestamps as zero and inserts chronologically", () => {
    const invalid = message("msg_invalid", Number.NaN)
    const middle = message("msg_middle", 10)
    const latest = message("msg_latest", 20)
    expect(insertMessageChronologically([invalid, latest], middle)).toEqual([invalid, middle, latest])
  })

  test("finds and splits only by exact marker identity", () => {
    const messages = [message("msg_fff", 10), message("msg_000", 20), message("msg_001", 30)]
    expect(findMessageIndex(messages, "msg_000")).toBe(1)
    expect(messagesBefore(messages, "msg_000")).toEqual([messages[0]])
    expect(messagesFrom(messages, "msg_000")).toEqual([messages[1], messages[2]])
    expect(messagesBefore(messages, "missing")).toBe(messages)
    expect(messagesFrom(messages, "missing")).toEqual([])
  })
})

describe("insertMessageChronologically among equal keys", () => {
  test("inserts after every message with the same time and id", () => {
    const first = message("msg_same", 10)
    const second = message("msg_same", 10)
    const incoming = message("msg_same", 10)
    const before = message("msg_a", 5)
    const after = message("msg_z", 20)
    const messages = [before, first, second, after]

    const result = insertMessageChronologically(messages, incoming)

    expect(result).toHaveLength(5)
    expect(result[0]).toBe(before)
    expect(result[1]).toBe(first)
    expect(result[2]).toBe(second)
    expect(result[3]).toBe(incoming)
    expect(result[4]).toBe(after)
  })

  test("inserts after a single equal message and before the next greater id at the same time", () => {
    const existing = message("msg_m", 10)
    const greater = message("msg_n", 10)
    const incoming = message("msg_m", 10)

    const result = insertMessageChronologically([existing, greater], incoming)

    expect(result[0]).toBe(existing)
    expect(result[1]).toBe(incoming)
    expect(result[2]).toBe(greater)
  })

  test("treats invalid timestamps as an equal time of zero and inserts after them", () => {
    const zero = message("msg_x", 0)
    const invalid = message("msg_x", "late")
    const result = insertMessageChronologically([zero], invalid)

    expect(result[0]).toBe(zero)
    expect(result[1]).toBe(invalid)
    // Infinite and NaN times also read as zero, so they sort before a message at time 1.
    const one = message("msg_a", 1)
    for (const created of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const odd = message("msg_z", created)
      expect(insertMessageChronologically([one], odd)[0]).toBe(odd)
    }
  })

  test("returns a new array and leaves the input unchanged", () => {
    const messages = [message("msg_1", 1)]
    const result = insertMessageChronologically(messages, message("msg_1", 1))

    expect(result).not.toBe(messages)
    expect(messages).toHaveLength(1)
  })
})
