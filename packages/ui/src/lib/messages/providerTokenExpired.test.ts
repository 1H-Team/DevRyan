import { describe, expect, test } from "bun:test"
import { isLikelyProviderTokenExpired, PROVIDER_TOKEN_EXPIRED_MESSAGE } from "./providerTokenExpired"
import { isLikelyProviderAuthFailure } from "./providerAuthError"

describe("provider token expiry classification", () => {
  // The exact string OpenAI returns once a ChatGPT OAuth access token lapses.
  test("recognises the OpenAI wording that the generic auth heuristic misses", () => {
    const openAiWording = "Provided authentication token is expired."

    expect(isLikelyProviderTokenExpired(openAiWording)).toBe(true)
    // Guards the ordering requirement in classifyAssistantError: if the generic heuristic ever
    // starts matching this too, the specific branch must still come first.
    expect(isLikelyProviderAuthFailure(openAiWording)).toBe(false)
  })

  test("recognises the other expiry phrasings providers use", () => {
    for (const detail of [
      "Claude OAuth token has expired and could not be refreshed automatically.",
      "OAuth session expired and could not be refreshed",
      "Session expired — please re-authenticate with OpenAI",
      "AI_APICallError: Provided authentication TOKEN IS EXPIRED.",
    ]) {
      expect(isLikelyProviderTokenExpired(detail)).toBe(true)
    }
  })

  test("ignores unrelated failures and non-strings", () => {
    for (const detail of [
      "Our servers are currently overloaded. Please try again later.",
      "model not found",
      "",
      "   ",
    ]) {
      expect(isLikelyProviderTokenExpired(detail)).toBe(false)
    }

    expect(isLikelyProviderTokenExpired(undefined)).toBe(false)
    expect(isLikelyProviderTokenExpired(null)).toBe(false)
    expect(isLikelyProviderTokenExpired({ message: "token is expired" })).toBe(false)
  })

  test("tells the user the one thing that actually fixes it", () => {
    expect(PROVIDER_TOKEN_EXPIRED_MESSAGE).toContain("Reconnect")
  })
})
