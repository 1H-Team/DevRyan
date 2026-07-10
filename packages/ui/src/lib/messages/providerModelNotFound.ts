export const PROVIDER_MODEL_NOT_FOUND_MESSAGE =
  "This model is not available for the selected provider. Pick another model, or re-authenticate the provider and try again."

export function isLikelyProviderModelNotFound(value: unknown): boolean {
  if (typeof value !== "string") {
    return false
  }

  const detail = value.toLowerCase().trim()
  if (!detail) {
    return false
  }

  if (detail.includes("providermodelnotfounderror")) {
    return true
  }

  if (detail.includes("model not found")) {
    return true
  }

  return detail.includes("did you mean:") && detail.includes("/")
}
