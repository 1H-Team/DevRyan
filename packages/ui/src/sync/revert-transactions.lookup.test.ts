import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import {
  filterMessagesForRevert,
  getEffectiveSessionRevertMessageID,
  getSessionRevertMessageID,
  isMessageHiddenByRevert,
  type RevertAwareState,
  type RevertTransaction,
  type RevertTransactionStatus,
} from "./revert-transactions"

function session(id: string, revert?: unknown): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    ...(revert === undefined ? {} : { revert }),
  } as unknown as Session
}

function message(id: string, created = 1): Message {
  return { id, sessionID: "ses_1", role: "user", time: { created } } as Message
}

function transaction(
  messageID: string,
  status: RevertTransactionStatus,
  hiddenMessageIDs?: string[],
): RevertTransaction {
  return {
    messageID,
    status,
    version: 1,
    startedAt: 1,
    ...(hiddenMessageIDs ? { hiddenMessageIDs: new Set(hiddenMessageIDs) } : {}),
  }
}

describe("getSessionRevertMessageID", () => {
  test("reads revert.messageID and is undefined without it", () => {
    expect(getSessionRevertMessageID(undefined)).toBeUndefined()
    expect(getSessionRevertMessageID(session("ses_1"))).toBeUndefined()
    expect(getSessionRevertMessageID(session("ses_1", {}))).toBeUndefined()
    expect(getSessionRevertMessageID(session("ses_1", null))).toBeUndefined()
    expect(getSessionRevertMessageID(session("ses_1", { messageID: "msg_3" }))).toBe("msg_3")
  })

  test("returns the stored value as it is, empty strings and non-strings included", () => {
    expect(getSessionRevertMessageID(session("ses_1", { messageID: "" }))).toBe("")
    const raw: unknown = getSessionRevertMessageID(session("ses_1", { messageID: 5 }))
    expect(raw).toBe(5)
  })
})

describe("getEffectiveSessionRevertMessageID", () => {
  test("a pending or confirmed transaction wins over the session record", () => {
    for (const status of ["pending", "confirmed"] as const) {
      const state: RevertAwareState = {
        session: [session("ses_1", { messageID: "msg_session" })],
        revert_transaction: { ses_1: transaction("msg_tx", status) },
      }
      expect(getEffectiveSessionRevertMessageID(state, "ses_1")).toBe("msg_tx")
      expect(getEffectiveSessionRevertMessageID(state, "ses_1", session("ses_1", { messageID: "msg_arg" }))).toBe("msg_tx")
    }
  })

  test("a transaction with an empty message id still wins", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_session" })],
      revert_transaction: { ses_1: transaction("", "pending") },
    }
    expect(getEffectiveSessionRevertMessageID(state, "ses_1")).toBe("")
  })

  test("a failed transaction falls back to the session record", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_session" })],
      revert_transaction: { ses_1: transaction("msg_tx", "failed") },
    }
    expect(getEffectiveSessionRevertMessageID(state, "ses_1")).toBe("msg_session")
  })

  test("an explicit session is used instead of the session list, whatever its id", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_list" })],
    }
    expect(getEffectiveSessionRevertMessageID(state, "ses_1", session("ses_1", { messageID: "msg_arg" }))).toBe("msg_arg")
    expect(getEffectiveSessionRevertMessageID(state, "ses_1", session("ses_other", { messageID: "msg_other" }))).toBe("msg_other")
    expect(getEffectiveSessionRevertMessageID(state, "ses_1", session("ses_1"))).toBeUndefined()
  })

  test("finds the first session with the id in the list", () => {
    const state: RevertAwareState = {
      session: [
        session("ses_0", { messageID: "msg_0" }),
        session("ses_1", { messageID: "msg_first" }),
        session("ses_1", { messageID: "msg_second" }),
      ],
    }
    expect(getEffectiveSessionRevertMessageID(state, "ses_1")).toBe("msg_first")
  })

  test("is undefined without a transaction, list or matching session", () => {
    expect(getEffectiveSessionRevertMessageID({}, "ses_1")).toBeUndefined()
    expect(getEffectiveSessionRevertMessageID({ session: [] }, "ses_1")).toBeUndefined()
    expect(getEffectiveSessionRevertMessageID({ session: [session("ses_2", { messageID: "m" })] }, "ses_1")).toBeUndefined()
    expect(getEffectiveSessionRevertMessageID({ revert_transaction: { ses_1: undefined } }, "ses_1")).toBeUndefined()
  })

  test("looks the transaction up by exact session id", () => {
    const state: RevertAwareState = { revert_transaction: { ses_1: transaction("msg_tx", "pending") } }
    expect(getEffectiveSessionRevertMessageID(state, "SES_1")).toBeUndefined()
    expect(getEffectiveSessionRevertMessageID(state, "ses_1 ")).toBeUndefined()
  })
})

describe("isMessageHiddenByRevert", () => {
  const messages = [message("msg_1", 1), message("msg_2", 2), message("msg_3", 3), message("msg_4", 4)]

  test("is false without a session id", () => {
    const state: RevertAwareState = {
      message: { ses_1: messages },
      revert_transaction: { ses_1: transaction("msg_2", "pending", ["msg_3"]) },
    }
    expect(isMessageHiddenByRevert(state, undefined, "msg_3")).toBe(false)
    expect(isMessageHiddenByRevert(state, "", "msg_3")).toBe(false)
  })

  test("is false when the session has no effective revert", () => {
    expect(isMessageHiddenByRevert({ message: { ses_1: messages } }, "ses_1", "msg_4")).toBe(false)
    expect(isMessageHiddenByRevert({
      message: { ses_1: messages },
      revert_transaction: { ses_1: transaction("msg_2", "failed", ["msg_4"]) },
    }, "ses_1", "msg_4")).toBe(false)
    expect(isMessageHiddenByRevert({
      message: { ses_1: messages },
      revert_transaction: { ses_1: transaction("", "pending", ["msg_4"]) },
    }, "ses_1", "msg_4")).toBe(false)
  })

  test("a live transaction's hidden set hides a message even when no messages are cached", () => {
    const state: RevertAwareState = {
      revert_transaction: { ses_1: transaction("msg_2", "pending", ["msg_9"]) },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_9")).toBe(true)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_8")).toBe(false)
  })

  test("a failed transaction's hidden set is ignored in favour of the session revert and the cache", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_3" })],
      message: { ses_1: messages },
      revert_transaction: { ses_1: transaction("msg_1", "failed", ["msg_2", "msg_9"]) },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_2")).toBe(false)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_3")).toBe(true)
    // msg_9 is not cached, so it is hidden only because it is not among the visible messages.
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_9")).toBe(true)
  })

  test("hides the marker and every message after it, keeps the ones before", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_3" })],
      message: { ses_1: messages },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_1")).toBe(false)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_2")).toBe(false)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_3")).toBe(true)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_4")).toBe(true)
  })

  test("treats a message absent from the cache as hidden when the marker is cached", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_3" })],
      message: { ses_1: messages },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_unknown")).toBe(true)
  })

  test("a marker at the start hides every message", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_1" })],
      message: { ses_1: messages },
    }
    for (const entry of messages) {
      expect(isMessageHiddenByRevert(state, "ses_1", entry.id)).toBe(true)
    }
  })

  test("is false when the marker is not cached or the session has no cache", () => {
    expect(isMessageHiddenByRevert({
      session: [session("ses_1", { messageID: "msg_missing" })],
      message: { ses_1: messages },
    }, "ses_1", "msg_4")).toBe(false)
    expect(isMessageHiddenByRevert({
      session: [session("ses_1", { messageID: "msg_missing" })],
      message: { ses_1: messages },
    }, "ses_1", "msg_unknown")).toBe(false)
    expect(isMessageHiddenByRevert({
      session: [session("ses_1", { messageID: "msg_3" })],
    }, "ses_1", "msg_4")).toBe(false)
    expect(isMessageHiddenByRevert({
      session: [session("ses_1", { messageID: "msg_3" })],
      message: { ses_1: undefined },
    }, "ses_1", "msg_4")).toBe(false)
  })

  test("a live transaction's marker cuts the cache when its hidden set does not name the message", () => {
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_1" })],
      message: { ses_1: messages },
      revert_transaction: { ses_1: transaction("msg_4", "confirmed", ["msg_2"]) },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_2")).toBe(true)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_3")).toBe(false)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_4")).toBe(true)
  })

  test("cuts at the first occurrence of a duplicated marker id", () => {
    const duplicated = [message("msg_1"), message("msg_x"), message("msg_2"), message("msg_x")]
    const state: RevertAwareState = {
      session: [session("ses_1", { messageID: "msg_x" })],
      message: { ses_1: duplicated },
    }
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_1")).toBe(false)
    expect(isMessageHiddenByRevert(state, "ses_1", "msg_2")).toBe(true)
  })
})

describe("filterMessagesForRevert", () => {
  const messages = [message("msg_1"), message("msg_2"), message("msg_3")]

  test("returns the same array without a marker or when the marker is not present", () => {
    expect(filterMessagesForRevert(messages, undefined)).toBe(messages)
    expect(filterMessagesForRevert(messages, "")).toBe(messages)
    expect(filterMessagesForRevert(messages, "msg_missing")).toBe(messages)
    const empty: Message[] = []
    expect(filterMessagesForRevert(empty, "msg_1")).toBe(empty)
  })

  test("an empty marker means no revert even when a message has an empty id", () => {
    const withEmptyID = [message("msg_1"), message("")]
    expect(filterMessagesForRevert(withEmptyID, "")).toBe(withEmptyID)
  })

  test("returns a new array of the messages before the marker, sharing the message objects", () => {
    const result = filterMessagesForRevert(messages, "msg_3")
    expect(result).not.toBe(messages)
    expect(result).toEqual([messages[0], messages[1]])
    expect(result[0]).toBe(messages[0])
    expect(result[1]).toBe(messages[1])
    expect(messages).toHaveLength(3)
  })

  test("a marker at the start gives a new empty array", () => {
    const result = filterMessagesForRevert(messages, "msg_1")
    expect(result).toEqual([])
    expect(result).not.toBe(messages)
  })

  test("cuts at the first occurrence and compares ids exactly", () => {
    const duplicated = [message("a"), message("dup"), message("b"), message("dup")]
    expect(filterMessagesForRevert(duplicated, "dup").map((entry) => entry.id)).toEqual(["a"])
    expect(filterMessagesForRevert(duplicated, "DUP")).toBe(duplicated)
    const unicode = [message("e\u0301"), message("\u00e9")]
    expect(filterMessagesForRevert(unicode, "\u00e9").map((entry) => entry.id)).toEqual(["e\u0301"])
  })

  test("does not reorder by creation time", () => {
    const unordered = [message("late", 9), message("early", 1), message("mid", 5)]
    expect(filterMessagesForRevert(unordered, "mid").map((entry) => entry.id)).toEqual(["late", "early"])
  })
})
