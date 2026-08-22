import { describe, expect, test } from "bun:test"
import {
  classifyTransientProviderFailure,
  isLikelyTransientProviderAvailabilityFailure,
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
    expect(isLikelyTransientStreamFailure("UnknownError", "The operation timed out.")).toBe(true)
    expect(isLikelyTransientStreamFailure("HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT")).toBe(true)
  })

  test("recognizes transient provider overload responses", () => {
    const reason = "Our servers are currently overloaded. Please try again later."

    expect(isLikelyTransientProviderAvailabilityFailure(reason)).toBe(true)
    expect(isLikelyTransientProviderAvailabilityFailure(JSON.stringify(reason))).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", reason)).toBe(true)
  })

  test("recognizes explicit connection-loss wording regardless of wrapper error name", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", "Stream connection lost")).toBe(true)
    expect(isLikelyTransientStreamFailure("APIError", "Stream connection lost")).toBe(true)
  })

  test("rejects auth failures, aborts, and non-transient model errors", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", "OAuth token refresh failed during stream")).toBe(false)
    expect(isLikelyTransientStreamFailure("UnknownError", "aborted")).toBe(false)
    expect(isLikelyTransientStreamFailure("ContentFilterError", "The model refused this request")).toBe(false)
    expect(isLikelyTransientProviderAvailabilityFailure("Rate limit exceeded")).toBe(false)
    expect(isLikelyTransientProviderAvailabilityFailure("Provider warming up")).toBe(false)
  })
})

describe("classifyTransientProviderFailure", () => {
  test("normalizes transport variants to stable failure kinds", () => {
    const cases = [
      ["UnknownError", "The operation timed out.", "request_timeout"],
      ["UnknownError", '"The request timed out"', "request_timeout"],
      ["HeadersTimeoutError", "Response headers timed out", "response_header_timeout"],
      ["BodyTimeoutError", "Chunk timeout error", "stream_idle_timeout"],
      ["UnknownError", "Upstream request failed: ECONNRESET", "connection_failure"],
    ] as const
    for (const [name, detail, expected] of cases) {
      expect(classifyTransientProviderFailure(name, detail)).toBe(expected)
    }
  })

  test("does not override auth, model, certificate, or abort classifications", () => {
    expect(classifyTransientProviderFailure(
      "AuthenticationError",
      "The operation timed out while refreshing an access token",
    )).toBeNull()
    expect(classifyTransientProviderFailure(
      "ProviderModelNotFoundError",
      "Model not found after an upstream request failed",
    )).toBeNull()
    expect(classifyTransientProviderFailure(
      "UnknownError",
      "Unable to verify the first certificate",
    )).toBeNull()
    expect(classifyTransientProviderFailure("AbortError", "The operation timed out while cancelling")).toBeNull()
  })
})

describe("xAI provider-queue failures", () => {
  // Verbatim from opencode.log on 2026-08-21. Before the classifier fix these
  // returned null (the trailing "abort." matched the non-transport pattern),
  // so no auto-retry ran and the UI showed a dead-end error.
  const QUEUE_TIMEOUT = "Request 8f1d57cc-e1b2-9ec5-9dbc-f3ff661ceab0-n0-part0-a0-2 timed out in queue, abort."
  const UNAVAILABLE = "Service temporarily unavailable. The model did not respond to this request."

  test("classifies the queue timeout as a transport failure", () => {
    expect(classifyTransientProviderFailure("UnknownError", QUEUE_TIMEOUT)).toBe("provider_queue_timeout")
  })

  test("classifies the temporarily-unavailable variant", () => {
    expect(classifyTransientProviderFailure("UnknownError", UNAVAILABLE)).toBe("provider_queue_timeout")
  })

  test("marks both as transient so the retry path engages", () => {
    expect(isLikelyTransientStreamFailure("UnknownError", QUEUE_TIMEOUT)).toBe(true)
    expect(isLikelyTransientStreamFailure("UnknownError", UNAVAILABLE)).toBe(true)
  })

  test("still treats a real user abort as non-transient", () => {
    expect(classifyTransientProviderFailure("MessageAbortedError", "Aborted")).toBe(null)
  })
})
