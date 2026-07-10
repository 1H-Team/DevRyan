import { describe, expect, test } from "bun:test"

import {
  isLikelyProviderModelNotFound,
  PROVIDER_MODEL_NOT_FOUND_MESSAGE,
} from "./providerModelNotFound"

describe("isLikelyProviderModelNotFound", () => {
  test("matches ProviderModelNotFoundError and model-not-found copy", () => {
    expect(isLikelyProviderModelNotFound(
      "ProviderModelNotFoundError: Model not found: github-copilot/gpt-5.3-codex. Did you mean: gpt-5.3-codex?",
    )).toBe(true)
    expect(isLikelyProviderModelNotFound("Model not found: openai/gpt-5.5")).toBe(true)
    expect(isLikelyProviderModelNotFound("Something else failed")).toBe(false)
    expect(isLikelyProviderModelNotFound("")).toBe(false)
  })

  test("exports a stable user-facing message", () => {
    expect(PROVIDER_MODEL_NOT_FOUND_MESSAGE).toContain("not available")
  })
})
