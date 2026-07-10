import { isLikelyProviderAuthFailure } from "./providerAuthError"

const STRONG_TRANSIENT_STREAM_PATTERNS = [
  "streaming response failed",
  "upstream request failed",
  "error from provider",
  "premature close",
  "terminated",
  "econnreset",
  "socket hang up",
] as const

export function stripWrappedJsonQuotes(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === "string" ? parsed : trimmed
  } catch {
    return trimmed
  }
}

export function isLikelyTransientStreamFailure(name: unknown, detail: unknown): boolean {
  if (typeof detail !== "string") {
    return false
  }

  const cleanDetail = stripWrappedJsonQuotes(detail)
  const normalizedDetail = cleanDetail.toLowerCase()
  if (!normalizedDetail || normalizedDetail.includes("aborted") || isLikelyProviderAuthFailure(cleanDetail)) {
    return false
  }

  if (STRONG_TRANSIENT_STREAM_PATTERNS.some((pattern) => normalizedDetail.includes(pattern))) {
    return true
  }

  return name === "UnknownError"
    && (normalizedDetail.includes("stream") || normalizedDetail.includes("connection"))
}
