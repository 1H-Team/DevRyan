import { describe, expect, test } from "bun:test"
import {
  isLikelyTransientStreamFailure,
  stripWrappedJsonQuotes,
} from "./transientStreamError"

describe("stripWrappedJsonQuotes", () => {
  test("unwraps JSON-stringified provider details", () => {
    expect(stripWrappedJsonQuotes('"Streaming response failed"')).toBe("Streaming response failed")
  })

  test("preserves unquoted and malformed quoted details", () => {
    expect(stripWrappedJsonQuotes("Upstream request failed")).toBe("Upstream request failed")
    expect(stripWrappedJsonQuotes('"unterminated')).toBe('"unterminated')
  })
})

describe("isLikelyTransientStreamFailure", () => {
  test("recognizes known provider and connection failures", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", '"Streaming response failed"')).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "Error from provider (Console): Upstream request failed")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "premature close")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "ECONNRESET: socket hang up")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "Stream idle timeout")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "SSE read timed out after 120000ms")).toBe(true)
  })

  test("allows weaker stream and connection matches only for UnknownError", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", "Stream connection lost")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "Stream connection lost")).toBe(false)
  })

  test("rejects auth failures, aborts, and non-transient model errors", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", "OAuth token refresh failed during stream")).toBe(false)
    expect(isLikelyTransientStreamFailure("UnknownError", "aborted")).toBe(false)
    expect(isLikelyTransientStreamFailure("ContentFilterError", "The model refused this request")).toBe(false)
  })
})
