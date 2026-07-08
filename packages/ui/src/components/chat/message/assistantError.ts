import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from "@/lib/messages/providerAuthError"

export type AssistantErrorInfo = {
  data?: { message?: unknown }
  message?: unknown
  name?: unknown
}

export type AssistantErrorClassification = {
  text: string
  variant: "plain" | "info" | "error"
  abortKind?: "manual" | "steered" | "unexpected"
}

type SteeredAbortOptions = {
  steeredAbortMessageId?: string | null
  messageId?: string | null
}

export function classifySteeredAbortFallback(
  options: SteeredAbortOptions,
): AssistantErrorClassification | undefined {
  if (options.steeredAbortMessageId && options.messageId && options.steeredAbortMessageId === options.messageId) {
    return {
      text: "Steered conversation",
      variant: "info",
      abortKind: "steered",
    }
  }

  return undefined
}

export function classifyAssistantError(
  errorInfo: AssistantErrorInfo | undefined,
  options: {
    manualAbortMessageId?: string | null
    steeredAbortMessageId?: string | null
    messageId?: string | null
    isLatestMessage?: boolean
  } = {},
): AssistantErrorClassification | undefined {
  if (!errorInfo) {
    return undefined
  }

  const dataMessage = typeof errorInfo.data?.message === "string" ? errorInfo.data.message : undefined
  const errorMessage = typeof errorInfo.message === "string" ? errorInfo.message : undefined
  const errorName = typeof errorInfo.name === "string" ? errorInfo.name : undefined
  const detail = dataMessage || errorMessage || errorName
  if (!detail) {
    return undefined
  }

  if (errorName === "SessionRetry") {
    return {
      text: `The provider rejected the request and OpenCode is retrying automatically. Press Stop to cancel and switch models.\n\`${detail}\``,
      variant: "info",
    }
  }

  if (isLikelyProviderAuthFailure(detail)) {
    return {
      text: PROVIDER_AUTH_FAILURE_MESSAGE,
      variant: "error",
    }
  }

  if (detail.trim().toLowerCase() === "aborted") {
    if (options.manualAbortMessageId && options.messageId && options.manualAbortMessageId === options.messageId) {
      return {
        text: "",
        variant: "plain",
        abortKind: "manual",
      }
    }

    const steeredAbort = classifySteeredAbortFallback(options)
    if (steeredAbort) {
      return steeredAbort
    }

    if (options.isLatestMessage === false) {
      return undefined
    }

    return {
      text: "The turn stopped before completion. Reconnecting session state…",
      variant: "info",
      abortKind: "unexpected",
    }
  }

  return {
    text: `Opencode failed to send message with error:\n\`${detail}\``,
    variant: "error",
  }
}
