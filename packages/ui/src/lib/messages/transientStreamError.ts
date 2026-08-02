import {
  classifyProviderTransportFailure,
  type ProviderTransportFailureKind,
} from "@openchamber/orchestration-runtime"

import { isLikelyProviderAuthFailure } from "./providerAuthError"

const TRANSIENT_PROVIDER_AVAILABILITY_PATTERN = /\b(?:our\s+)?servers?\s+(?:are\s+)?(?:currently\s+)?overloaded\b/i

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

export function isLikelyCertificateVerificationFailure(detail: unknown): boolean {
  if (typeof detail !== "string") return false

  const normalizedDetail = stripWrappedJsonQuotes(detail).toLowerCase()
  return normalizedDetail.includes("certificate verification")
    || normalizedDetail.includes("certificate verify failed")
    || normalizedDetail.includes("unable to verify the first certificate")
    || normalizedDetail.includes("unable to get local issuer certificate")
}

export function isLikelyTransientProviderAvailabilityFailure(detail: unknown): boolean {
  if (typeof detail !== "string") return false

  const cleanDetail = stripWrappedJsonQuotes(detail)
  return TRANSIENT_PROVIDER_AVAILABILITY_PATTERN.test(cleanDetail)
}

export function classifyTransientProviderFailure(
  name: unknown,
  detail: unknown,
): ProviderTransportFailureKind | null {
  if (typeof detail !== "string") return null

  const cleanDetail = stripWrappedJsonQuotes(detail)
  if (!cleanDetail || isLikelyProviderAuthFailure(cleanDetail)) return null
  return classifyProviderTransportFailure(name, cleanDetail)
}

export function isLikelyTransientStreamFailure(name: unknown, detail: unknown): boolean {
  return isLikelyCertificateVerificationFailure(detail)
    || isLikelyTransientProviderAvailabilityFailure(detail)
    || classifyTransientProviderFailure(name, detail) !== null
}
