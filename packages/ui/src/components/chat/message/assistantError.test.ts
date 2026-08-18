import { describe, expect, test } from "bun:test"
import { classifyAssistantError, classifySteeredAbortFallback } from "./assistantError"

describe("classifyAssistantError", () => {
  test("classifies transient provider stream failures as retryable with friendly copy", () => {
    expect(classifyAssistantError({
      name: "UnknownError",
      data: { message: '"Streaming response failed"' },
    })).toEqual({
      text: "Your prompt was accepted, but the model provider connection failed before the turn finished. Any completed work was preserved in this session.\n`Streaming response failed`",
      variant: "error",
      retryable: true,
    })
  })

  test("renders compact informational copy for managed transport recovery states", () => {
    const error = {
      name: "UnknownError",
      data: {
        message: '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response."}',
      },
    }
    const cases = [
      [
        "recovering",
        "The model provider connection was interrupted. DevRyan is continuing this subtask from saved progress.",
      ],
      [
        "recovered",
        "Connection recovered. DevRyan continued this subtask from saved progress and completed it.",
      ],
      [
        "failed",
        "The model provider connection was interrupted. DevRyan attempted to continue this subtask from saved progress.",
      ],
    ] as const

    for (const [state, text] of cases) {
      expect(classifyAssistantError(error, {
        managedTransportRecovery: { kind: "connection_failure", state },
      })).toEqual({ text, variant: "info" })
    }
  })

  test("does not let mismatched recovery metadata hide an unrecovered transport error", () => {
    const classification = classifyAssistantError({
      name: "UnknownError",
      data: { message: "Streaming response failed" },
    }, {
      managedTransportRecovery: { kind: "request_timeout", state: "recovered" },
    })

    expect(classification?.variant).toBe("error")
    expect(classification?.text).toContain("Streaming response failed")
  })

  test("renders cause-specific timeout recovery copy", () => {
    const cases = [
      [
        "UnknownError",
        "The operation timed out.",
        "Your prompt was accepted, but the model provider request timed out before the turn finished.",
      ],
      [
        "HeadersTimeoutError",
        "UND_ERR_HEADERS_TIMEOUT",
        "Your prompt was accepted, but the model provider did not begin its response before the response-header liveness timeout.",
      ],
      [
        "BodyTimeoutError",
        "Chunk timeout error",
        "Your prompt was accepted, but the model provider stopped sending response data before the stream liveness timeout.",
      ],
    ] as const
    for (const [name, detail, expectedLead] of cases) {
      expect(classifyAssistantError({
        name,
        data: { message: detail },
      })).toEqual({
        text: `${expectedLead} Any completed work was preserved in this session.\n\`${detail}\``,
        variant: "error",
        retryable: true,
      })
    }
  })

  test("keeps OpenCode retry and provider auth classifications ahead of transient matching", () => {
    expect(classifyAssistantError({
      name: "SessionRetry",
      data: { message: "Error from provider: upstream request failed" },
    })).toEqual({
      text: "The provider rejected the request and OpenCode is retrying automatically. Press Stop to cancel and switch models.\n`Error from provider: upstream request failed`",
      variant: "info",
    })

    expect(classifyAssistantError({
      name: "UnknownError",
      data: { message: "OAuth token refresh failed during stream" },
    })).toEqual({
      text: "Authentication failed for this provider. Please re-authenticate and retry.",
      variant: "error",
    })
  })

  test("classifies provider model-not-found failures with actionable copy", () => {
    expect(classifyAssistantError({
      name: "ProviderModelNotFoundError",
      data: { message: "Model not found: github-copilot/gpt-5.3-codex. Did you mean: gpt-5.3-codex?" },
    })).toEqual({
      text: "This model is not available for the selected provider. Pick another model, or re-authenticate the provider and try again.\n`Model not found: github-copilot/gpt-5.3-codex. Did you mean: gpt-5.3-codex?`",
      variant: "error",
      retryable: true,
    })
  })

  test("classifies certificate verification failures as retryable connection errors", () => {
    expect(classifyAssistantError({
      name: "UnknownError",
      data: { message: "unknown certificate verification error" },
    })).toEqual({
      text: "The secure connection to the model provider could not be verified. Retry after your connection is stable. If this keeps happening, check VPN, proxy, or certificate settings.\n`unknown certificate verification error`",
      variant: "error",
      retryable: true,
    })
  })

  test("removes wrapped JSON quotes from generic fallback details", () => {
    expect(classifyAssistantError({
      name: "UnknownError",
      data: { message: '"A permanent model refusal"' },
    })).toEqual({
      text: "The model provider could not complete this turn:\n`A permanent model refusal`",
      variant: "error",
    })
  })

  test("classifies local manual aborts without renderable stopped copy", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "",
      variant: "plain",
      abortKind: "manual",
    })
  })

  test("classifies direct steering aborts with visible steered copy", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      steeredAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "Steered conversation",
      variant: "info",
      abortKind: "steered",
    })
  })

  test("classifies steered aborts even when the assistant message has no error payload", () => {
    expect(classifySteeredAbortFallback({
      steeredAbortMessageId: "msg-assistant",
      messageId: "msg-assistant",
    })).toEqual({
      text: "Steered conversation",
      variant: "info",
      abortKind: "steered",
    })
  })

  test("treats aborted errors for a different trailing message as unexpected aborts", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-previous-assistant",
      messageId: "msg-next-assistant",
      isLatestMessage: true,
    })).toEqual({
      text: "The turn stopped before completion.",
      variant: "info",
      abortKind: "unexpected",
    })
  })

  test("uses authoritative managed recovery state for an unexpected abort", () => {
    const cases = [
      [
        "continuing",
        "The turn stopped before completion. DevRyan is continuing this subtask from saved progress.",
      ],
      [
        "recovered",
        "The turn stopped before completion. DevRyan continued this subtask from saved progress and completed it.",
      ],
      [
        "manual_recovery",
        "This subtask stopped before completion. Choose a model and thinking level in the parent session’s Model Recovery card, then click Try Again.",
      ],
      ["stopped", "The turn stopped before completion."],
    ] as const

    for (const [state, text] of cases) {
      expect(classifyAssistantError({ message: "aborted" }, {
        isLatestMessage: true,
        managedAbortRecovery: { state },
      })).toEqual({
        text,
        variant: "info",
        abortKind: "unexpected",
      })
    }
  })

  test("names a timeout as one rather than implying the model failed", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      isLatestMessage: true,
      managedAbortRecovery: { state: "manual_recovery", failureKind: "deadline_exceeded" },
    })).toEqual({
      text: "This subtask ran out of time before completing. Choose a model and thinking level in the parent session’s Model Recovery card, then click Try Again to continue it.",
      variant: "info",
      abortKind: "unexpected",
    })
  })

  test("does not surface historical uncorrelated aborted messages", () => {
    expect(classifyAssistantError({ message: "aborted" }, {
      manualAbortMessageId: "msg-previous-assistant",
      messageId: "msg-next-assistant",
      isLatestMessage: false,
    })).toBe(undefined)
  })
})
