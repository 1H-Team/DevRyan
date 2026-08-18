import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from "@/lib/messages/providerAuthError"
import { isLikelyProviderTokenExpired, PROVIDER_TOKEN_EXPIRED_MESSAGE } from "@/lib/messages/providerTokenExpired"
import {
  isLikelyProviderModelNotFound,
  PROVIDER_MODEL_NOT_FOUND_MESSAGE,
} from "@/lib/messages/providerModelNotFound"
import {
  classifyTransientProviderFailure,
  isLikelyCertificateVerificationFailure,
  stripWrappedJsonQuotes,
} from "@/lib/messages/transientStreamError"
import type {
  ManagedAbortRecoveryPresentation,
  ManagedTransportRecoveryPresentation,
} from "../lib/turns/types"

export type AssistantErrorInfo = {
  data?: { message?: unknown }
  message?: unknown
  name?: unknown
}

export type AssistantErrorClassification = {
  text: string
  variant: "plain" | "info" | "error"
  abortKind?: "manual" | "steered" | "unexpected"
  retryable?: boolean
}

const getManagedRecoveryCopy = (
  state: ManagedTransportRecoveryPresentation["state"],
): string => {
  switch (state) {
    case "recovering":
      return "The model provider connection was interrupted. DevRyan is continuing this subtask from saved progress."
    case "recovered":
      return "Connection recovered. DevRyan continued this subtask from saved progress and completed it."
    case "failed":
      return "The model provider connection was interrupted. DevRyan attempted to continue this subtask from saved progress."
  }
}

const getTransportFailureCopy = (
  kind: NonNullable<ReturnType<typeof classifyTransientProviderFailure>>,
): string => {
  switch (kind) {
    case "request_timeout":
      return "Your prompt was accepted, but the model provider request timed out before the turn finished."
    case "response_header_timeout":
      return "Your prompt was accepted, but the model provider did not begin its response before the response-header liveness timeout."
    case "stream_idle_timeout":
      return "Your prompt was accepted, but the model provider stopped sending response data before the stream liveness timeout."
    case "connection_failure":
      return "Your prompt was accepted, but the model provider connection failed before the turn finished."
  }
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
    managedAbortRecovery?: ManagedAbortRecoveryPresentation
    managedTransportRecovery?: ManagedTransportRecoveryPresentation
  } = {},
): AssistantErrorClassification | undefined {
  if (!errorInfo) {
    return undefined
  }

  const dataMessage = typeof errorInfo.data?.message === "string" ? errorInfo.data.message : undefined
  const errorMessage = typeof errorInfo.message === "string" ? errorInfo.message : undefined
  const errorName = typeof errorInfo.name === "string" ? errorInfo.name : undefined
  const rawDetail = dataMessage || errorMessage || errorName
  if (!rawDetail) {
    return undefined
  }
  const detail = stripWrappedJsonQuotes(rawDetail)

  if (errorName === "SessionRetry") {
    return {
      text: `The provider rejected the request and OpenCode is retrying automatically. Press Stop to cancel and switch models.\n\`${detail}\``,
      variant: "info",
    }
  }

  // Checked before the broader auth-failure heuristic, which would otherwise swallow this into
  // vaguer copy. Keep the provider's own wording — it is the only thing naming which credential died.
  if (isLikelyProviderTokenExpired(detail)) {
    return {
      text: `${PROVIDER_TOKEN_EXPIRED_MESSAGE}\n\`${detail}\``,
      variant: "error",
    }
  }

  if (isLikelyProviderAuthFailure(detail)) {
    return {
      text: PROVIDER_AUTH_FAILURE_MESSAGE,
      variant: "error",
    }
  }

  if (isLikelyProviderModelNotFound(detail) || errorName === "ProviderModelNotFoundError") {
    return {
      text: `${PROVIDER_MODEL_NOT_FOUND_MESSAGE}\n\`${detail}\``,
      variant: "error",
      retryable: true,
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

    const managedAbortCopy = (() => {
      switch (options.managedAbortRecovery?.state) {
        case "continuing":
          return "The turn stopped before completion. DevRyan is continuing this subtask from saved progress."
        case "recovered":
          return "The turn stopped before completion. DevRyan continued this subtask from saved progress and completed it."
        case "manual_recovery":
          return options.managedAbortRecovery?.failureKind === "deadline_exceeded"
            ? "This subtask ran out of time before completing. Choose a model and thinking level in the parent session’s Model Recovery card, then click Try Again to continue it."
            : "This subtask stopped before completion. Choose a model and thinking level in the parent session’s Model Recovery card, then click Try Again."
        case "stopped":
        case undefined:
          return "The turn stopped before completion."
      }
    })()

    return {
      text: managedAbortCopy,
      variant: "info",
      abortKind: "unexpected",
    }
  }

  if (isLikelyCertificateVerificationFailure(detail)) {
    return {
      text: `The secure connection to the model provider could not be verified. Retry after your connection is stable. If this keeps happening, check VPN, proxy, or certificate settings.\n\`${detail}\``,
      variant: "error",
      retryable: true,
    }
  }

  const transportFailureKind = classifyTransientProviderFailure(errorName, detail)
  if (transportFailureKind) {
    if (
      options.managedTransportRecovery
      && options.managedTransportRecovery.kind === transportFailureKind
    ) {
      return {
        text: getManagedRecoveryCopy(options.managedTransportRecovery.state),
        variant: "info",
      }
    }
    return {
      text: `${getTransportFailureCopy(transportFailureKind)} Any completed work was preserved in this session.\n\`${detail}\``,
      variant: "error",
      retryable: true,
    }
  }

  return {
    text: `The model provider could not complete this turn:\n\`${detail}\``,
    variant: "error",
  }
}
