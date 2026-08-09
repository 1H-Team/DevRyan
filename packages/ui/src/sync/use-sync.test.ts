import { describe, expect, test } from "bun:test"
import {
  normalizeMessageFetchLimit,
  resolveMessagePagePagination,
  unwrapMessageRecordsResult,
} from "./message-fetch"

describe("message fetch hardening", () => {
  test("clamps message fetch limits to the default page size when metadata is poisoned", () => {
    expect(normalizeMessageFetchLimit(0)).toBe(200)
    expect(normalizeMessageFetchLimit(-10)).toBe(200)
    expect(normalizeMessageFetchLimit(Number.NaN)).toBe(200)
    expect(normalizeMessageFetchLimit(30)).toBe(30)
  })

  test("throws retryable errors for SDK message response errors", () => {
    expect(() => unwrapMessageRecordsResult({
      error: { message: "OpenCode API unavailable" },
      response: { status: 503 },
    })).toThrow("session.messages failed (503): OpenCode API unavailable")

    try {
      unwrapMessageRecordsResult({
        error: "OpenCode API unavailable",
        response: { status: 503 },
      })
    } catch (error) {
      expect((error as Error & { status?: number }).status).toBe(503)
    }
  })

  test("treats an empty initial page as complete even when it includes a cursor", () => {
    expect(resolveMessagePagePagination({
      requestedLimit: 200,
      returnedCount: 0,
      cursor: "msg-first",
    })).toEqual({ cursor: undefined, complete: true })
  })

  test("treats a new one-turn page as complete even when it includes a cursor", () => {
    expect(resolveMessagePagePagination({
      requestedLimit: 200,
      returnedCount: 2,
      cursor: "msg-user",
    })).toEqual({ cursor: undefined, complete: true })
  })

  test("ends pagination after any partial older page", () => {
    expect(resolveMessagePagePagination({
      requestedLimit: 200,
      returnedCount: 17,
      cursor: "msg-oldest",
    })).toEqual({ cursor: undefined, complete: true })
  })

  test("keeps a cursor when a full page may have older messages", () => {
    expect(resolveMessagePagePagination({
      requestedLimit: 200,
      returnedCount: 200,
      cursor: "msg-oldest",
    })).toEqual({ cursor: "msg-oldest", complete: false })
  })

  test("treats a page without a cursor as complete regardless of its size", () => {
    expect(resolveMessagePagePagination({
      requestedLimit: 200,
      returnedCount: 200,
      cursor: undefined,
    })).toEqual({ cursor: undefined, complete: true })
  })
})
