import { describe, expect, test } from "bun:test"
import { classifyAssistantError, classifySteeredAbortFallback } from "./assistantError"

describe("classifyAssistantError", () => {
  test("classifies transient provider stream failures as retryable with friendly copy", () => {
    expect(classifyAssistantError({
      name: "UnknownError",
      data: { message: '"Streaming response failed"' },
    })).toEqual({
      text: "The model provider dropped the connection mid-response. This is a temporary provider-side issue — retry, or switch models if it keeps happening.\n`Streaming response failed`",
      variant: "error",
      retryable: true,
    })
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
      text: "Opencode failed to send message with error:\n`A permanent model refusal`",
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
      text: "The turn stopped before completion. Reconnecting session state…",
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
