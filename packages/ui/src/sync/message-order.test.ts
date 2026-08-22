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
